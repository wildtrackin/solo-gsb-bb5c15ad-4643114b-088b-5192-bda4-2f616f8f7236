import { useMemo, useState } from 'react';
import { Allocation } from '../lib/model';
import { broadcastOf, cidrToString, longToIpv4, parseCidr } from '../lib/ip';
import {
  DhcpPoolResult,
  formatRange,
  generateDhcpPools,
  rangeSize,
} from '../lib/dhcp';

interface Props {
  alloc: Allocation;
  onClose: () => void;
  onCopied: (msg: string) => void;
}

const PLACEHOLDER = '10.0.0.1\n10.0.0.128/26';

export default function DhcpPoolModal({ alloc, onClose, onCopied }: Props) {
  const [text, setText] = useState('');
  const [copyError, setCopyError] = useState<string | null>(null);

  const subnet = useMemo(() => parseCidr(alloc.cidr)!, [alloc.cidr]);

  const result: DhcpPoolResult = useMemo(
    () => generateDhcpPools(subnet, text.split('\n')),
    [subnet, text],
  );

  const hasInput = text.split('\n').some((l) => l.trim());
  const ok = result.errors.length === 0;
  const poolText = result.pools.map(formatRange).join('\n');
  const totalAddresses = result.pools.reduce((sum, r) => sum + rangeSize(r), 0);

  const copy = async () => {
    setCopyError(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(poolText);
      } else {
        const ta = document.createElement('textarea');
        ta.value = poolText;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const done = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!done) throw new Error('execCommand 返回 false');
      }
      onCopied(`已复制 ${result.pools.length} 个地址池范围`);
    } catch (e) {
      setCopyError(`复制失败：${(e as Error).message}，请手动选择文本复制`);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>生成 DHCP 地址池：{alloc.name}</h3>
        <p className="muted">
          子网 <code>{cidrToString(subnet)}</code>（网络地址{' '}
          <code>{longToIpv4(subnet.base)}</code>，广播地址{' '}
          <code>{longToIpv4(broadcastOf(subnet))}</code>）。
          {subnet.prefix <= 30
            ? '该前缀已自动排除网络地址与广播地址。'
            : '/31、/32 沿用可用主机规则（RFC 3021 / 主机路由），不排除网络与广播地址。'}
          <br />
          逐行输入需要排除的单个 IPv4 地址或对齐 CIDR；任一行非法或越界将不生成结果。
          该操作只做计算，不会修改规划或历史。
        </p>

        <textarea
          className="dhcp-input"
          rows={7}
          value={text}
          autoFocus
          spellCheck={false}
          placeholder={PLACEHOLDER}
          onChange={(e) => setText(e.target.value)}
        />

        {!ok && (
          <ul className="errors dhcp-errors">
            {result.errors.map((er) => (
              <li key={er.line}>
                第 {er.line} 行 <code>{er.text}</code>：{er.message}
              </li>
            ))}
          </ul>
        )}

        {ok && hasInput && result.excluded.length > 0 && (
          <p className="hint dhcp-summary">
            排除项合并后共 {result.excluded.length} 个区间：
            {result.excluded.map((r) => ` ${formatRange(r)}`).join('；')}
          </p>
        )}

        {ok && (
          <div className="dhcp-result">
            {result.pools.length === 0 ? (
              <p className="muted">可用地址已全部排除，没有可输出的地址池范围。</p>
            ) : (
              <>
                <p className="hint dhcp-summary">
                  剩余 {totalAddresses.toLocaleString()} 个地址，合并为{' '}
                  {result.pools.length} 个连续范围（已取最少数量）：
                </p>
                <pre className="dhcp-pools">{poolText}</pre>
              </>
            )}
          </div>
        )}

        {copyError && <ul className="errors"><li>{copyError}</li></ul>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button
            className="btn primary"
            disabled={!ok || result.pools.length === 0}
            onClick={copy}
          >
            一键复制{result.pools.length > 0 ? `（${result.pools.length} 段）` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
