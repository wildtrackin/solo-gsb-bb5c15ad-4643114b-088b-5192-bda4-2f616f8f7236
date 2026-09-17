import { describe, expect, it } from 'vitest';
import { ipv4ToLong, parseCidr } from './ip';
import {
  formatRange,
  generateDhcpPools,
  mergeRanges,
  rangeSize,
  subtractRanges,
  usableRange,
} from './dhcp';

const parse = (s: string) =>
  s.includes('/') ? parseCidr(s)!.base : ipv4ToLong(s)!;
const R = (a: string, b?: string) =>
  formatRange({ start: parse(a), end: parse(b ?? a) });

describe('usableRange：可用主机地址区间', () => {
  it('/0～/30 自动排除网络地址与广播地址', () => {
    expect(usableRange(parseCidr('10.0.0.0/24')!)).toEqual({
      start: parse('10.0.0.1'),
      end: parse('10.0.0.254'),
    });
    expect(usableRange(parseCidr('10.0.0.0/30')!)).toEqual({
      start: parse('10.0.0.1'),
      end: parse('10.0.0.2'),
    });
    expect(usableRange(parseCidr('10.0.0.0/0')!)).toEqual({
      start: parse('0.0.0.1'),
      end: parse('255.255.255.254'),
    });
  });

  it('/31、/32 沿用现有可用主机规则', () => {
    expect(usableRange(parseCidr('10.0.0.0/31')!)).toEqual({
      start: parse('10.0.0.0'),
      end: parse('10.0.0.1'),
    });
    expect(usableRange(parseCidr('10.0.0.5/32')!)).toEqual({
      start: parse('10.0.0.5'),
      end: parse('10.0.0.5'),
    });
  });
});

describe('mergeRanges：重叠或相邻合并', () => {
  it('重叠区间合并', () => {
    expect(
      mergeRanges([
        { start: parse('10.0.0.10'), end: parse('10.0.0.20') },
        { start: parse('10.0.0.15'), end: parse('10.0.0.30') },
      ]).map((r) => formatRange(r)),
    ).toEqual([R('10.0.0.10', '10.0.0.30')]);
  });

  it('相邻（end+1）区间也合并', () => {
    expect(
      mergeRanges([
        { start: parse('10.0.0.10'), end: parse('10.0.0.20') },
        { start: parse('10.0.0.21'), end: parse('10.0.0.30') },
      ]).map((r) => formatRange(r)),
    ).toEqual([R('10.0.0.10', '10.0.0.30')]);
  });

  it('间隔一个地址不合并', () => {
    expect(
      mergeRanges([
        { start: parse('10.0.0.10'), end: parse('10.0.0.20') },
        { start: parse('10.0.0.22'), end: parse('10.0.0.30') },
      ]),
    ).toHaveLength(2);
  });
});

describe('subtractRanges：区间扣除', () => {
  it('中间扣除产生两段', () => {
    const base = { start: parse('10.0.0.1'), end: parse('10.0.0.254') };
    expect(
      subtractRanges(base, [{ start: parse('10.0.0.100'), end: parse('10.0.0.200') }]).map(
        formatRange,
      ),
    ).toEqual([R('10.0.0.1', '10.0.0.99'), R('10.0.0.201', '10.0.0.254')]);
  });

  it('扣除超出基区间的部分自动裁剪', () => {
    const base = { start: parse('10.0.0.10'), end: parse('10.0.0.20') };
    expect(
      subtractRanges(base, [{ start: parse('10.0.0.1'), end: parse('10.0.0.15') }]).map(
        formatRange,
      ),
    ).toEqual([R('10.0.0.16', '10.0.0.20')]);
  });

  it('全部扣除返回空', () => {
    const base = { start: parse('10.0.0.10'), end: parse('10.0.0.20') };
    expect(
      subtractRanges(base, [{ start: parse('10.0.0.0'), end: parse('10.0.0.255') }]),
    ).toEqual([]);
  });
});

describe('generateDhcpPools：整流程', () => {
  const subnet = parseCidr('10.0.0.0/24')!;

  it('无排除项：输出完整可用范围', () => {
    const r = generateDhcpPools(subnet, []);
    expect(r.errors).toEqual([]);
    expect(r.pools.map(formatRange)).toEqual([R('10.0.0.1', '10.0.0.254')]);
  });

  it('空行被忽略', () => {
    const r = generateDhcpPools(subnet, ['', '   ', '\t']);
    expect(r.errors).toEqual([]);
    expect(r.pools.map(formatRange)).toEqual([R('10.0.0.1', '10.0.0.254')]);
  });

  it('单个 IP 排除', () => {
    const r = generateDhcpPools(subnet, ['10.0.0.100']);
    expect(r.pools.map(formatRange)).toEqual([
      R('10.0.0.1', '10.0.0.99'),
      R('10.0.0.101', '10.0.0.254'),
    ]);
  });

  it('CIDR 排除', () => {
    const r = generateDhcpPools(subnet, ['10.0.0.64/26']);
    expect(r.pools.map(formatRange)).toEqual([
      R('10.0.0.1', '10.0.0.63'),
      R('10.0.0.128', '10.0.0.254'),
    ]);
  });

  it('排除网络地址或广播地址不影响结果', () => {
    const r = generateDhcpPools(subnet, ['10.0.0.0', '10.0.0.255']);
    expect(r.errors).toEqual([]);
    expect(r.pools.map(formatRange)).toEqual([R('10.0.0.1', '10.0.0.254')]);
    expect(r.excluded).toEqual([]);
  });

  it('重叠或相邻排除合并后只产生最少的范围', () => {
    const r = generateDhcpPools(subnet, [
      '10.0.0.100',
      '10.0.0.101',
      '10.0.0.102',
      '10.0.0.96/27', // .96-.127，与上面相邻并重叠
    ]);
    expect(r.errors).toEqual([]);
    expect(r.excluded.map(formatRange)).toEqual([R('10.0.0.96', '10.0.0.127')]);
    expect(r.pools.map(formatRange)).toEqual([
      R('10.0.0.1', '10.0.0.95'),
      R('10.0.0.128', '10.0.0.254'),
    ]);
  });

  it('排除相邻边界使剩余段合并为最少数量', () => {
    // 排除 .10 与 .12，.11 夹在中间成为单地址池（三个范围）
    let r = generateDhcpPools(subnet, ['10.0.0.10', '10.0.0.12']);
    expect(r.pools.map(formatRange)).toEqual([
      R('10.0.0.1', '10.0.0.9'),
      R('10.0.0.11', '10.0.0.11'),
      R('10.0.0.13', '10.0.0.254'),
    ]);
    // 再排除 .11，剩余合并为两段
    r = generateDhcpPools(subnet, ['10.0.0.10', '10.0.0.11', '10.0.0.12']);
    expect(r.pools.map(formatRange)).toEqual([
      R('10.0.0.1', '10.0.0.9'),
      R('10.0.0.13', '10.0.0.254'),
    ]);
  });

  it('全部可用地址被排除：结果为空', () => {
    const r = generateDhcpPools(subnet, ['10.0.0.0/24']);
    expect(r.errors).toEqual([]);
    expect(r.pools).toEqual([]);
  });

  it('/31：排除一个地址剩一个地址', () => {
    const r = generateDhcpPools(parseCidr('10.0.0.0/31')!, ['10.0.0.0']);
    expect(r.pools.map(formatRange)).toEqual([R('10.0.0.1', '10.0.0.1')]);
  });

  it('/32：排除唯一地址则为空', () => {
    const r = generateDhcpPools(parseCidr('10.0.0.7/32')!, ['10.0.0.7']);
    expect(r.pools).toEqual([]);
  });

  it('逐行报告非法与越界错误且不生成结果', () => {
    const r = generateDhcpPools(subnet, [
      '10.0.0.50',
      'not-an-ip',
      '11.0.0.1',
      '10.0.0.0/33',
      '10.0.0.1/24', // 未对齐
      '10.0.1.0/24', // 越界 CIDR
      '10.0.0.99',
    ]);
    expect(r.pools).toEqual([]);
    expect(r.excluded).toEqual([]);
    expect(r.errors).toEqual([
      { line: 2, text: 'not-an-ip', message: expect.stringContaining('非法') },
      { line: 3, text: '11.0.0.1', message: expect.stringContaining('越界') },
      { line: 4, text: '10.0.0.0/33', message: expect.stringContaining('CIDR 非法') },
      { line: 5, text: '10.0.0.1/24', message: expect.stringContaining('未对齐') },
      { line: 6, text: '10.0.1.0/24', message: expect.stringContaining('越界') },
    ]);
  });

  it('CIDR 部分越界（超出子网末尾）报错', () => {
    const r = generateDhcpPools(parseCidr('10.0.0.0/26')!, ['10.0.0.0/25']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].line).toBe(1);
    expect(r.errors[0].message).toContain('越界');
  });

  it('支持大网段：/0 中排除 /8 也不逐地址枚举', () => {
    const r = generateDhcpPools(parseCidr('0.0.0.0/0')!, ['10.0.0.0/8']);
    expect(r.errors).toEqual([]);
    expect(r.pools.map(formatRange)).toEqual([
      R('0.0.0.1', '9.255.255.255'),
      R('11.0.0.0', '255.255.255.254'),
    ]);
    expect(rangeSize(r.pools[0]) + rangeSize(r.pools[1])).toBe(4294967294 - 16777216);
  });
});
