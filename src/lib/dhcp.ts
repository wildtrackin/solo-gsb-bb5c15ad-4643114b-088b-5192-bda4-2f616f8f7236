/**
 * DHCP 地址池生成。
 *
 * 在子网「可用主机」地址范围内扣除用户逐行输入的排除项（单个 IPv4 或对齐 CIDR），
 * 全程只在闭区间 [start, end]（uint32）上做合并/扣除运算，不逐地址枚举，
 * 输出数量最少的“起始 IP - 结束 IP”连续范围。
 */
import {
  Cidr,
  cidrToString,
  ipv4ToLong,
  isAlignedCidr,
  lastAddr,
  longToIpv4,
  parseCidr,
} from './ip';

/** 闭区间地址范围，端点均为 uint32 */
export interface AddrRange {
  start: number;
  end: number;
}

/** 一行排除项的校验错误（line 为从 1 起的原始行号） */
export interface ExclusionError {
  line: number;
  text: string;
  message: string;
}

export interface DhcpPoolResult {
  /** 剩余地址池：最少数量的连续区间，按地址升序 */
  pools: AddrRange[];
  /** 排除项合并后、裁剪到可用范围内的区间，按地址升序 */
  excluded: AddrRange[];
  /** 逐行错误；非空时 pools 必为空（不生成结果） */
  errors: ExclusionError[];
}

export function rangeSize(r: AddrRange): number {
  return r.end - r.start + 1;
}

/** 输出为“起始 IP - 结束 IP” */
export function formatRange(r: AddrRange): string {
  return `${longToIpv4(r.start)} - ${longToIpv4(r.end)}`;
}

/**
 * 子网可用主机地址区间：
 *  - /0～/30：自动排除网络地址与广播地址；
 *  - /31：按 RFC 3021 点对点链路，两个地址均可用；
 *  - /32：主机路由，单个地址可用。
 */
export function usableRange(c: Cidr): AddrRange {
  if (c.prefix <= 30) {
    return { start: (c.base + 1) >>> 0, end: (lastAddr(c) - 1) >>> 0 };
  }
  if (c.prefix === 31) {
    return { start: c.base, end: (c.base + 1) >>> 0 };
  }
  return { start: c.base, end: c.base };
}

/** 合并相互重叠或首尾相邻（end + 1 === next.start）的区间，输入可为任意顺序。 */
export function mergeRanges(ranges: AddrRange[]): AddrRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: AddrRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) {
      if (r.end > last.end) last.end = r.end;
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

/** 从 base 中扣除 cuts（自动合并、裁剪到 base 内），返回剩余连续区间。 */
export function subtractRanges(base: AddrRange, cuts: AddrRange[]): AddrRange[] {
  const merged = mergeRanges(cuts)
    .filter((r) => r.end >= base.start && r.start <= base.end)
    .map((r) => ({
      start: Math.max(r.start, base.start),
      end: Math.min(r.end, base.end),
    }));
  const out: AddrRange[] = [];
  let cursor = base.start; // cut.end + 1 可能达到 2^32，保留 double 精度即可
  for (const cut of merged) {
    if (cut.start > cursor) out.push({ start: cursor, end: cut.start - 1 });
    if (cut.end >= cursor) cursor = cut.end + 1;
  }
  if (cursor <= base.end) out.push({ start: cursor, end: base.end });
  return out;
}

/**
 * 解析并校验一行排除项。
 * 接受单个 IPv4（如 10.0.0.10）或已对齐网络地址的 CIDR（如 10.0.0.0/30），
 * 且必须完整位于 subnet 内。失败返回中文错误信息。
 */
function parseExclusionLine(
  text: string,
  subnet: Cidr,
): { range?: AddrRange; error?: string } {
  const raw = text.trim();
  const subnetEnd = lastAddr(subnet);
  const subnetText = cidrToString(subnet);

  if (!raw.includes('/')) {
    const ip = ipv4ToLong(raw);
    if (ip === null) return { error: `IPv4 地址非法：${raw}` };
    if (ip < subnet.base || ip > subnetEnd) {
      return { error: `${raw} 越界：不在子网 ${subnetText} 内` };
    }
    return { range: { start: ip, end: ip } };
  }

  const c = parseCidr(raw);
  if (!c) return { error: `CIDR 非法：${raw}` };
  if (!isAlignedCidr(raw)) {
    return { error: `CIDR 未对齐网络地址：${raw}，应为 ${cidrToString(c)}` };
  }
  const end = lastAddr(c);
  if (c.base < subnet.base || end > subnetEnd) {
    return {
      error: `${cidrToString(c)} 越界：未完整位于子网 ${subnetText} 内`,
    };
  }
  return { range: { start: c.base, end } };
}

/**
 * 依据逐行排除文本生成 DHCP 地址池（纯函数）。
 * 空行忽略；任一行非法或越界时返回全部逐行错误且不生成任何结果。
 */
export function generateDhcpPools(subnet: Cidr, lines: string[]): DhcpPoolResult {
  const errors: ExclusionError[] = [];
  const cuts: AddrRange[] = [];
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    const res = parseExclusionLine(line, subnet);
    if (res.error) {
      errors.push({ line: idx + 1, text: line.trim(), message: res.error });
    } else if (res.range) {
      cuts.push(res.range);
    }
  });
  if (errors.length > 0) return { pools: [], excluded: [], errors };

  const usable = usableRange(subnet);
  const excluded = mergeRanges(cuts)
    .filter((r) => r.end >= usable.start && r.start <= usable.end)
    .map((r) => ({
      start: Math.max(r.start, usable.start),
      end: Math.min(r.end, usable.end),
    }));
  return { pools: subtractRanges(usable, cuts), excluded, errors };
}
