import type { ReactNode } from 'react';
import { X, ArrowUpRight, Inbox } from 'lucide-react';
import { statusNames, type Status } from '../domain/models';
export const time = (n?: number) =>
  n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '尚无记录';
export function Badge({ status }: { status: Status | string }) {
  return <span className={`badge ${status}`}>{statusNames[status as Status] ?? status}</span>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Inbox size={28} />
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="section-heading">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function External({ url, children }: { url: string; children?: ReactNode }) {
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {children ?? '打开原帖'} <ArrowUpRight size={13} />
    </a>
  ) : (
    <span className="muted">本地演示帖</span>
  );
}
export function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (b: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="toggle-label">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" />
    </label>
  );
}
export function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (n: number) => void;
}) {
  return (
    <div className="pager">
      <span>共 {total} 条 · 每页 25 条</span>
      <div>
        <button disabled={page === 0} onClick={() => onPage(page - 1)}>
          上一页
        </button>
        <span>
          {page + 1} / {Math.max(1, Math.ceil(total / 25))}
        </span>
        <button disabled={(page + 1) * 25 >= total} onClick={() => onPage(page + 1)}>
          下一页
        </button>
      </div>
    </div>
  );
}
