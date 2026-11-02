import { useEffect, useState } from 'react';
import { Save, Monitor, ShieldCheck } from 'lucide-react';
import { type Config, type Mode } from '../domain/models';
import { Toggle } from '../components/common';
import { send } from './api';
export function SettingsPage({
  config,
  mode,
  onChanged,
  report,
}: {
  config: Config;
  mode: Mode;
  onChanged: () => void;
  report: (s: string) => void;
}) {
  const [form, setForm] = useState(config);
  useEffect(() => setForm(config), [config.version, mode]);
  const [include, setInclude] = useState(config.include.join('\n'));
  const [exclude, setExclude] = useState(config.exclude.join('\n'));
  const [authors, setAuthors] = useState(config.authors.join('\n'));
  useEffect(() => {
    setInclude(config.include.join('\n'));
    setExclude(config.exclude.join('\n'));
    setAuthors(config.authors.join('\n'));
  }, [config.version, mode]);
  const words = (v: string) =>
    v
      .split(/\r?\n/)
      .map((w) => w.trim())
      .filter(Boolean);
  const save = async () => {
    try {
      await send(mode, 'SAVE_CONFIG', {
        ...form,
        include: words(include),
        exclude: words(exclude),
        authors: words(authors),
      });
      onChanged();
      report('设置已保存，下次启动生效。当前运行遵循确认时的配置快照。');
    } catch (e) {
      report(String(e));
    }
  };
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>规则清楚，运行有边界。</h1>
          <p>设置仅从下次启动生效，当前批次不会悄悄扩大范围。</p>
        </div>
        <button className="primary" onClick={save}>
          <Save size={16} />
          保存设置
        </button>
      </div>
      <div className="settings-grid">
        <section className="panel">
          <h2>目标与筛选</h2>
          {mode === 'real' && (
            <label className="field">
              真实模式运行方式
              <select
                value={form.realAction ?? 'read'}
                onChange={(e) =>
                  setForm({ ...form, realAction: e.target.value as 'read' | 'auto' })
                }
              >
                <option value="read">只读观察</option>
                <option value="auto">自动首评与追评</option>
              </select>
              <span className="muted">
                自动模式使用贴吧官方旧版页面；开始前会核对账号并展示运行范围。
              </span>
            </label>
          )}
          <label className="field">
            贴吧名称或链接
            <input
              value={form.forum}
              onChange={(e) => setForm({ ...form, forum: e.target.value })}
              placeholder="例如：摄影，或 https://tieba.baidu.com/f?kw=摄影"
            />
          </label>
          <button
            onClick={async () => {
              try {
                const forum = await send<string>(mode, 'DETECT_FORUM');
                setForm({ ...form, forum });
              } catch (e) {
                report(String(e));
              }
            }}
          >
            <Monitor size={16} />
            识别当前打开的贴吧
          </button>
          <p className="muted">
            从贴吧页上的扩展弹窗识别。最多创建一个监控标签页和一个执行标签页；有草稿时停止导航。
          </p>
          <label className="field">
            标题包含关键词（每行一个）
            <textarea value={include} onChange={(e) => setInclude(e.target.value)} />
          </label>
          <label className="field">
            匹配方式
            <select
              value={form.match}
              onChange={(e) => setForm({ ...form, match: e.target.value as 'any' | 'all' })}
            >
              <option value="any">任意包含：至少命中一个</option>
              <option value="all">全部包含：必须命中每一个</option>
            </select>
          </label>
          <label className="field">
            标题排除关键词（任意命中即排除）
            <textarea value={exclude} onChange={(e) => setExclude(e.target.value)} />
          </label>
          <label className="field">
            排除作者（昵称或已识别的作者 ID，每行一个）
            <textarea value={authors} onChange={(e) => setAuthors(e.target.value)} />
          </label>
          <p className="muted">
            关键词不区分大小写。作者精确匹配。始终仅允许本次启动后可核实创建的新主题，初始基线只展示。
          </p>
        </section>
        <div>
          <section className="panel">
            <h2>追评方式</h2>
            <Toggle
              label="回复自己"
              checked={form.selfReply}
              onChange={(selfReply) => setForm({ ...form, selfReply })}
            />
            <div className="option-card">
              <strong>回复自己的首评</strong>
              <p>所有追评都在自己的同一个一级楼层内，以自己的首评为回复目标。</p>
            </div>
            <div className="option-card disabled">
              <strong>回复自己的上一条追评 · 未开放</strong>
              <p>需要另行验证评论标识与平台目标语义，不会自动切换。</p>
            </div>
            <p className="muted">
              启用的阶段按 1 → 4
              执行。关闭总开关后只执行首评。追评始终回复已核实的自己的首评，结果未知时停止。
            </p>
          </section>
          <section className="panel">
            <h2>数量与节奏</h2>
            <div className="form-grid">
              {(
                [
                  { key: 'maxPosts', label: '每次最多处理帖子', min: 1, max: 100 },
                  { key: 'maxSends', label: '每次最多发送评论', min: 1, max: 500 },
                  { key: 'maxReplies', label: '每帖最多追评', min: 0, max: 4 },
                  { key: 'checkSeconds', label: '检查间隔（秒）', min: 30, max: 3600 },
                  { key: 'sendSeconds', label: '发送间隔（秒）', min: 30, max: 3600 },
                ] as const
              ).map((f) => (
                <label className="field" key={f.key}>
                  {f.label}
                  <input
                    type="number"
                    min={f.min}
                    max={f.max}
                    value={form[f.key]}
                    onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}
                  />
                </label>
              ))}
            </div>
            <p className="muted">
              首评、每次追评和未知尝试都占用总额度。达到上限后停止，不自动重置。默认值是本产品的保守选择，不是贴吧官方认可的阈值。
            </p>
          </section>
          <section className="panel">
            <ShieldCheck size={22} />
            <h2>数据留在这台浏览器</h2>
            <p>
              不读取
              Cookie，不收集密码，不启用遥测。浏览器关闭或电脑关机时不能继续运行；唤醒时间可能延后。
            </p>
            <p className="muted">
              日志最多保留 2000
              条。历史可导出与清理，跨运行去重标记继续保留。卸载扩展会清除本地数据，请先备份。
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
