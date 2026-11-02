import { useEffect, useState, useMemo } from 'react';
import {
  Plus,
  Search,
  Upload,
  Download,
  ArrowUp,
  ArrowDown,
  Trash2,
  RotateCcw,
  Save,
  Pencil,
  Check,
} from 'lucide-react';
import {
  stages,
  stageNames,
  uid,
  type Stage,
  type Mode,
  type Library,
  type Item,
} from '../domain/models';
import { parseTxt, parseBundle, type TxtPreview } from '../shared/validation';
import type { LibraryView } from '../background/message-router/service';
import { Toggle, Modal, Empty } from '../components/common';
import { send, download } from './api';
export function LibraryPage({
  mode,
  libraries,
  stage,
  onStage,
  onChanged,
  report,
}: {
  mode: Mode;
  libraries: LibraryView[];
  stage: Stage;
  onStage: (s: Stage) => void;
  onChanged: () => void;
  report: (s: string) => void;
}) {
  const selected = libraries.find((l) => l.stage === stage)!;
  const [draft, setDraft] = useState<Library>(selected);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [editor, setEditor] = useState<{ id?: string; text: string } | null>(null);
  const [preview, setPreview] = useState<TxtPreview | null>(null);
  const [replace, setReplace] = useState(false);
  const [dedupe, setDedupe] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [bundle, setBundle] = useState<string | null>(null);
  useEffect(() => {
    setDraft({
      id: selected.id,
      mode: selected.mode,
      stage: selected.stage,
      version: selected.version,
      enabled: selected.enabled,
      loop: selected.loop,
      items: selected.items,
    });
    setPage(0);
    setQuery('');
  }, [selected.id, selected.version]);
  const visible = useMemo(
    () => draft.items.filter((i) => i.text.toLowerCase().includes(query.toLowerCase())),
    [draft.items, query],
  );
  const save = async () => {
    try {
      await send(mode, 'SAVE_LIBRARY', draft);
      report('内容库已保存，新的版本从下次运行生效；当前运行快照不变。');
      onChanged();
    } catch (e) {
      report(String(e));
    }
  };
  const file = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      if (f.size > 20_000_000) throw Error('文件超过 20 MB');
      const bytes = await f.arrayBuffer();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (f.name.endsWith('.json')) {
        parseBundle(text, mode);
        setBundle(text);
      } else {
        setProgress(0);
        setPreview(await parseTxt(text, setProgress));
      }
    } catch (e) {
      report(String(e));
    } finally {
      setProgress(null);
      e.target.value = '';
    }
  };
  const move = (id: string, direction: number) =>
    setDraft((d) => {
      const items = [...d.items];
      const i = items.findIndex((x) => x.id === id);
      if (i + direction < 0 || i + direction >= items.length) return d;
      [items[i], items[i + direction]] = [items[i + direction], items[i]];
      return { ...d, items };
    });
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>让每一次回复，都有准备。</h1>
          <p>五个独立内容库，按顺序取用。只在确认成功后推进游标。</p>
        </div>
        <button
          onClick={async () => {
            try {
              download('HoriTieba-内容与配置.json', await send(mode, 'EXPORT', 'config'));
            } catch (e) {
              report(String(e));
            }
          }}
        >
          <Download size={16} />
          全部导出
        </button>
      </div>
      <div className="library-tabs">
        {stages.map((s) => {
          const l = libraries.find((l) => l.stage === s)!;
          return (
            <button className={stage === s ? 'selected' : ''} key={s} onClick={() => onStage(s)}>
              <span className="library-number">{s === 'root' ? '首' : s.slice(-1)}</span>
              <span>
                {stageNames[s]}库
                <small>
                  {l.count} 条内容 · {l.enabled ? '已启用' : '未启用'}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      <div className="panel library-panel">
        <div className="section-heading">
          <div>
            <h2>
              {stageNames[stage]}库 <span className="muted">v{draft.version}</span>
            </h2>
            <p>编辑后保存为新版本，新版本游标从第 1 条开始。当前运行使用启动时快照。</p>
          </div>
          <button className="primary" onClick={save}>
            <Save size={16} />
            保存内容库
          </button>
        </div>
        <div className="library-controls">
          <Toggle
            label="启用此阶段"
            checked={stage === 'root' || draft.enabled}
            disabled={stage === 'root'}
            onChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
          />
          <Toggle
            label="用尽后循环"
            checked={draft.loop}
            onChange={(loop) => setDraft((d) => ({ ...d, loop }))}
          />
          <span className="muted">
            当前游标 {selected.cursor} · 下一条{' '}
            {selected.count
              ? selected.loop
                ? (selected.cursor % selected.count) + 1
                : Math.min(selected.cursor + 1, selected.count + 1)
              : '—'}
          </span>
          <button
            className="quiet"
            onClick={async () => {
              if (confirm('重置此库游标？仅停止运行且没有未知结果时可执行。'))
                try {
                  await send(mode, 'RESET_CURSOR', stage);
                  onChanged();
                } catch (e) {
                  report(String(e));
                }
            }}
          >
            <RotateCcw size={14} />
            重置游标
          </button>
        </div>
        <div className="next-content">
          <span>下一条 · 已保存版本</span>
          <p>{selected.nextText ?? '暂无可取用内容；用尽后将暂停。'}</p>
        </div>
        <div className="toolbar">
          <label className="search">
            <Search size={16} />
            <input
              placeholder="搜索内容"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <button onClick={() => setEditor({ text: '' })}>
            <Plus size={16} />
            新增内容
          </button>
          <label className="button">
            <Upload size={16} />
            导入 TXT / JSON
            <input type="file" accept=".txt,.json,text/plain,application/json" onChange={file} />
          </label>
          <button
            onClick={() =>
              download(
                `HoriTieba-${stageNames[stage]}库.txt`,
                draft.items.map((i) => i.text).join('\n'),
              )
            }
          >
            <Download size={16} />
            导出 TXT
          </button>
          <button
            className="danger quiet"
            onClick={() => {
              if (confirm('清空当前编辑版本的全部内容？保存后生效，原运行快照仍保留。'))
                setDraft((d) => ({ ...d, items: [] }));
            }}
          >
            <Trash2 size={16} />
            清空
          </button>
        </div>
        {progress !== null && <progress value={progress} max={100} aria-label="导入进度" />}
        <p className="muted">
          TXT 一行一条；多段内容请在单条编辑器中编辑。含内部换行的内容请用全部 JSON
          导出以保持条目边界。
        </p>
        {visible.length ? (
          <div className="content-items">
            {visible.slice(page * 25, (page + 1) * 25).map((i) => (
              <div className="content-item" key={i.id}>
                <span className="item-order">{draft.items.indexOf(i) + 1}</span>
                <p>{i.text}</p>
                <div className="item-actions">
                  <button aria-label="上移" onClick={() => move(i.id, -1)}>
                    <ArrowUp size={15} />
                  </button>
                  <button aria-label="下移" onClick={() => move(i.id, 1)}>
                    <ArrowDown size={15} />
                  </button>
                  <button aria-label="编辑" onClick={() => setEditor(i)}>
                    <Pencil size={15} />
                  </button>
                  <button
                    aria-label="删除"
                    onClick={() =>
                      setDraft((d) => ({ ...d, items: d.items.filter((x) => x.id !== i.id) }))
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="给这个库添加第一条内容">
            导入 UTF-8 文本，或手动编辑一条支持多段文字的回复。
          </Empty>
        )}
        <div className="pager">
          <span>
            共 {draft.items.length} 条 · 筛选 {visible.length} 条
          </span>
          <div>
            <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
              上一页
            </button>
            <button
              disabled={(page + 1) * 25 >= visible.length}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      </div>
      {editor && (
        <Modal title={editor.id ? '编辑内容' : '新增内容'} onClose={() => setEditor(null)}>
          <textarea
            autoFocus
            className="large-textarea"
            value={editor.text}
            maxLength={2000}
            placeholder="输入一条内容，保留标点、表情和有意义的换行…"
            onChange={(e) => setEditor({ ...editor, text: e.target.value })}
          />
          <p>{editor.text.length} / 2000 字符 · 本地产品限制，非平台官方阈值</p>
          <button
            className="primary"
            disabled={!editor.text.trim() || (draft.items.length >= 5000 && !editor.id)}
            onClick={() => {
              setDraft((d) => ({
                ...d,
                items: editor.id
                  ? d.items.map((i) =>
                      i.id === editor.id ? { ...i, text: editor.text.trim() } : i,
                    )
                  : [...d.items, { id: uid(), text: editor.text.trim() }],
              }));
              setEditor(null);
            }}
          >
            <Check size={16} />
            应用到编辑版本
          </button>
        </Modal>
      )}
      {preview && (
        <Modal title="TXT 导入预览" onClose={() => setPreview(null)}>
          <div className="import-stats">
            <span>有效 {preview.items.length}</span>
            <span>空行 {preview.blank}</span>
            <span>重复 {preview.duplicates}</span>
            <span>超长已排除 {preview.tooLong}</span>
          </div>
          <p>重复内容默认保留并提示。不会添加随机字符或修改内容。</p>
          <label>
            <input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} />{' '}
            忽略与库内或导入文件重复的条目
          </label>
          <label>
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
            />{' '}
            替换当前编辑版本（默认追加）
          </label>
          <div className="preview-list">
            {preview.items.slice(0, 20).map((x, i) => (
              <p key={i}>
                {i + 1}. {x}
              </p>
            ))}
          </div>
          <button
            className="primary"
            onClick={() => {
              if (replace && !confirm('确认替换当前编辑版本的全部条目？')) return;
              let items: Item[] = replace ? [] : [...draft.items];
              const seen = new Set(items.map((i) => i.text));
              for (const text of preview.items) {
                if (dedupe && seen.has(text)) continue;
                seen.add(text);
                items.push({ id: uid(), text });
              }
              if (items.length > 5000) {
                report('合并后超过每库 5000 条上限');
                return;
              }
              setDraft((d) => ({ ...d, items }));
              setPreview(null);
            }}
          >
            导入编辑版本，等待保存
          </button>
        </Modal>
      )}
      {bundle && (
        <Modal title="配置与五个库导入预览" onClose={() => setBundle(null)}>
          <p>
            结构和版本校验已通过。将替换当前模式的配置与五个库，创建新的库版本；当前运行快照保持不变。
          </p>
          {parseBundle(bundle, mode).libraries.map((l) => (
            <p key={l.stage}>
              {stageNames[l.stage]}：{l.items.length} 条，{l.enabled ? '启用' : '停用'}，
              {l.loop ? '循环' : '不循环'}
            </p>
          ))}
          <button
            className="danger"
            onClick={async () => {
              if (!confirm('确认替换此模式的全部配置及五个库？建议先导出备份。')) return;
              try {
                await send(mode, 'IMPORT_JSON', bundle);
                setBundle(null);
                onChanged();
                report('导入成功，新配置将在下次启动生效。');
              } catch (e) {
                report(String(e));
              }
            }}
          >
            确认替换
          </button>
        </Modal>
      )}
    </>
  );
}
