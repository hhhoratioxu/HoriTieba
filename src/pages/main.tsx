import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LayoutDashboard,
  ListFilter,
  LibraryBig,
  Workflow,
  History,
  ScrollText,
  Settings,
  Play,
  Pause,
  Square,
  OctagonX,
  PanelRight,
  ArrowUpRight,
  RefreshCw,
  Search,
  CheckCheck,
  MessageCircle,
  Clock3,
  ShieldCheck,
  Activity,
  Sun,
  Moon,
  Download,
  X,
  ChevronRight,
  Radio,
  AlertTriangle,
} from 'lucide-react';
import type { Snapshot } from '../background/message-router/service';
import {
  stageNames,
  stages,
  statusNames,
  enabledStages,
  type Mode,
  type Stage,
  type Task,
  type Attempt,
  type Status,
  type Run,
} from '../domain/models';
import { surface, send, download } from './api';
import { Badge, Empty, External, Modal, Pager, time } from '../components/common';
import { LibraryPage } from './LibraryPage';
import { SettingsPage } from './SettingsPage';
import '../styles/app.css';
type View = 'overview' | 'threads' | 'libraries' | 'tasks' | 'history' | 'logs' | 'settings';
const navigation = [
  { id: 'overview', name: '总览', icon: LayoutDashboard },
  { id: 'threads', name: '最新帖子', icon: ListFilter },
  { id: 'libraries', name: '内容库', icon: LibraryBig },
  { id: 'tasks', name: '自动任务', icon: Workflow },
  { id: 'history', name: '历史记录', icon: History },
  { id: 'logs', name: '运行日志', icon: ScrollText },
  { id: 'settings', name: '设置', icon: Settings },
] as const;
function App() {
  const [mode, setMode] = useState<Mode>('demo');
  const [view, setView] = useState<View>('overview');
  const [stage, setStage] = useState<Stage>('root');
  const [state, setState] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const [author, setAuthor] = useState('');
  const [status, setStatus] = useState('');
  const [summary, setSummary] = useState<Snapshot | null>(null);
  const [detail, setDetail] = useState<{ task: Task; attempts: Attempt[] } | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [theme, setTheme] = useState('system');
  const mainRef = useRef<HTMLElement>(null);
  const stateRef = useRef<Snapshot | null>(null);
  const requestSeq = useRef(0);
  const frozenThreads = useRef(false);
  const compact = surface !== 'dashboard';
  useEffect(() => {
    if (chrome?.storage?.local)
      void chrome.storage.local.get(['uiMode', 'theme']).then((s) => {
        if (s.uiMode === 'real') setMode('real');
        if (s.theme) setTheme(s.theme);
      });
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (chrome?.storage?.local) void chrome.storage.local.set({ theme });
  }, [theme]);
  const refresh = useCallback(
    async (force = false) => {
      const seq = ++requestSeq.current;
      try {
        const next = await send<Snapshot>(mode, 'STATE', {
          view,
          page,
          query,
          author,
          status,
          stage,
        });
        if (seq !== requestSeq.current) return;
        const old = stateRef.current;
        const added =
          old?.run?.id === next.run?.id
            ? Math.max(0, (next.run?.discovered ?? 0) - (old?.run?.discovered ?? 0))
            : 0;
        if (force) frozenThreads.current = false;
        if (!force && view === 'threads' && old) {
          if (((mainRef.current?.scrollTop ?? 0) > 140 || page > 0) && added > 0) {
            frozenThreads.current = true;
            setNewCount((n) => n + added);
          }
          if (frozenThreads.current) next.threads = old.threads;
        }
        stateRef.current = next;
        setState(next);
        setError('');
      } catch (e) {
        if (seq === requestSeq.current) setError(e instanceof Error ? e.message : String(e));
      }
    },
    [mode, view, page, query, author, status, stage],
  );
  useEffect(() => {
    setNewCount(0);
    void refresh(true);
  }, [refresh]);
  useEffect(() => {
    if (!chrome?.runtime) return;
    const listener = (msg: { type?: string }, sender: chrome.runtime.MessageSender) => {
      if (sender.id === chrome.runtime.id && msg.type === 'STATE_CHANGED') void refresh();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [refresh]);
  const changeView = (v: View) => {
    setView(v);
    setPage(0);
    setQuery('');
    setAuthor('');
    setStatus('');
    mainRef.current?.scrollTo({ top: 0 });
  };
  const report = (s: string) => setNotice(s);
  const command = async (type: string, payload?: unknown) => {
    setBusy(true);
    try {
      await send(mode, type, payload);
      await refresh(true);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const showDetail = async (id: string) => {
    try {
      setDetail(await send(mode, 'DETAIL', id));
    } catch (e) {
      report(String(e));
    }
  };
  const switchMode = (m: Mode) => {
    setMode(m);
    setPage(0);
    setDetail(null);
    setSummary(null);
    if (chrome?.storage?.local) void chrome.storage.local.set({ uiMode: m });
  };
  const run = state?.run;
  const active = !!run && ['running', 'paused', 'blocked'].includes(run.status);
  const unresolved = (run?.unknownCount ?? 0) > 0;
  const blockedStart = active || unresolved || busy || !!state?.fault;
  const controls = (
    <div className="run-controls">
      <button
        className="primary"
        disabled={blockedStart}
        onClick={async () => {
          if (!state) return;
          if (mode === 'demo' || state.config.realAction !== 'auto') {
            setSummary(state);
            return;
          }
          setBusy(true);
          try {
            const account = await send<import('../domain/models').Account>(mode, 'PREFLIGHT');
            setSummary({ ...state, preflightAccount: account });
          } catch (e) {
            report(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Play size={15} />
        {mode === 'real' && state?.config.realAction !== 'auto' ? '开始只读监控' : '开始'}
      </button>
      <button
        disabled={run?.status !== 'running' || busy}
        onClick={() => command('CONTROL', { action: 'pause' })}
      >
        <Pause size={15} />
        暂停
      </button>
      <button
        disabled={
          !run ||
          !['paused', 'blocked'].includes(run.status) ||
          unresolved ||
          state?.currentTask?.steps.some((s) => s.status === 'failed') ||
          busy ||
          !!state?.fault
        }
        onClick={() => command('CONTROL', { action: 'resume' })}
      >
        <Play size={15} />
        继续
      </button>
      <button disabled={!active || busy} onClick={() => command('CONTROL', { action: 'stop' })}>
        <Square size={14} />
        停止
      </button>
      <button
        className="emergency"
        disabled={!active}
        onClick={() => {
          void send(mode, 'CONTROL', { action: 'emergency' })
            .then(() => refresh(true))
            .catch((e) => report(String(e)));
        }}
      >
        <OctagonX size={16} />
        紧急停止
      </button>
    </div>
  );
  const openConsole = () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  const openPanel = async () => {
    try {
      const window = await chrome.windows.getCurrent();
      if (chrome.sidePanel?.open && window.id !== undefined)
        await chrome.sidePanel.open({ windowId: window.id });
      else await openConsole();
    } catch {
      await openConsole();
    }
  };
  const task = state?.currentTask;
  return (
    <div className={`app ${compact ? 'compact' : ''} ${surface === 'popup' ? 'popup' : ''}`}>
      {!compact && (
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">H</span>
            <div>
              HoriTieba<small>贴吧追评助手</small>
            </div>
          </div>
          <div className="workspace-label">你的本地工作空间</div>
          <nav>
            {navigation.map((n) => (
              <button
                key={n.id}
                className={view === n.id ? 'active' : ''}
                onClick={() => changeView(n.id)}
              >
                <n.icon size={18} />
                {n.name}
                {n.id === 'tasks' && !!state?.pending && (
                  <span className="nav-count">{state.pending}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="privacy">
              <ShieldCheck size={17} />
              <span>
                仅存于此浏览器<small>没有服务器 · 没有遥测</small>
              </span>
            </div>
            <button onClick={openPanel}>
              <PanelRight size={17} />
              打开轻量侧边栏
            </button>
            <div className="version">
              <span>
                v{globalThis.chrome?.runtime?.getManifest?.()?.version ?? '开发'} · 本地运行
              </span>
              <button
                aria-label="切换主题"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            </div>
          </div>
        </aside>
      )}
      <div className="workspace">
        <header className="topbar">
          <div className="topline">
            <div className="breadcrumbs">
              {compact ? (
                <strong>HoriTieba</strong>
              ) : (
                <span>
                  工作空间 <ChevronRight size={14} /> {navigation.find((n) => n.id === view)?.name}
                </span>
              )}
            </div>
            <div className="mode-switch" aria-label="运行模式">
              <button
                className={mode === 'demo' ? 'active' : ''}
                onClick={() => switchMode('demo')}
              >
                演示模式
              </button>
              <button
                className={mode === 'real' ? 'active' : ''}
                onClick={() => switchMode('real')}
              >
                真实模式
              </button>
            </div>
          </div>
          <div className="global-status">
            <div className="status-ident">
              <span className={`status-dot ${run?.status === 'running' ? 'live' : ''}`} />
              <div>
                <strong>
                  {run?.config.forum ?? state?.config.forum ?? '准备工作空间'}
                  <small>
                    {run?.account.label ?? (mode === 'demo' ? '演示账号 · Hori' : '身份未确认')} ·{' '}
                    {run
                      ? run.status === 'running'
                        ? '监控运行中'
                        : run.status === 'paused'
                          ? '已暂停'
                          : run.status === 'blocked'
                            ? '需要处理'
                            : run.status === 'completed'
                              ? '本次运行已结束'
                              : '已停止'
                      : '尚未启动'}
                  </small>
                </strong>
              </div>
            </div>
            {!compact && controls}
          </div>
          <div className="time-strip">
            <span>
              最近成功检查 <b>{time(run?.lastCheckAt)}</b>
            </span>
            <span>
              下次计划检查 <b>{run?.status === 'running' ? time(run.nextCheckAt) : '—'}</b>
            </span>
            {!compact && (
              <span>
                最后活动 <b>{time(run?.lastActivity)}</b>
              </span>
            )}
          </div>
        </header>
        <main ref={mainRef}>
          {error && (
            <div className="alert error">
              <AlertTriangle size={18} />
              <div>
                {error}
                <button onClick={() => refresh(true)}>重新连接</button>
              </div>
            </div>
          )}
          {notice && (
            <div role="status" className="toast">
              <span>{notice}</span>
              <button className="icon-button" onClick={() => setNotice('')} aria-label="关闭提示">
                <X size={16} />
              </button>
            </div>
          )}
          {mode === 'demo' ? (
            <div className="mode-notice">
              <span className="badge demo">演示模式</span>
              <span>全部帖子、账号与发送证据均来自本地模拟，绝不会发布到贴吧。</span>
            </div>
          ) : (
            <div className="alert warning">
              <ShieldCheck size={20} />
              <div>
                <strong>
                  {state?.config.realAction === 'auto'
                    ? '真实自动模式 · 使用贴吧官方旧版'
                    : '真实模式 · 只读观察'}
                </strong>
                <p>
                  主题一楼时间决定是否为新帖；追评只关联自己的首评。账号变化、草稿、验证或结果未知会停止发送。真实发布验收状态见帮助说明。
                </p>
                <button onClick={() => command('OPEN_WORK_TAB')}>打开工作标签页</button>
              </div>
            </div>
          )}
          {state?.fault && <div className="alert error">{state.fault}</div>}
          {run?.reason && (
            <div className="alert warning">
              <AlertTriangle size={18} />
              <div>{run.reason}</div>
            </div>
          )}
          {compact ? (
            <>
              <section className="panel compact-task">
                <h2>当前任务</h2>
                {task ? (
                  <>
                    <p>{task.thread.title}</p>
                    <Badge status={task.status} />
                    <StageFlow task={task} />
                    <p className="muted">
                      下一步：
                      {task.steps.find((s) => !['completed', 'disabled'].includes(s.status))?.stage
                        ? stageNames[
                            task.steps.find((s) => !['completed', 'disabled'].includes(s.status))!
                              .stage
                          ]
                        : '已完成'}
                    </p>
                  </>
                ) : (
                  <Empty title="暂无执行中的任务">
                    启动后先建立历史基线，再处理符合条件的新主题。
                  </Empty>
                )}
                {controls}
              </section>
              <section className="panel">
                <h2>最近日志</h2>
                {state?.logs.map((l) => (
                  <div className="mini-log" key={l.id}>
                    <small>{time(l.at)}</small>
                    <p>{l.message}</p>
                  </div>
                ))}
                {!state?.logs.length && <p className="muted">尚无运行日志</p>}
              </section>
              <div className="compact-links">
                <button className="primary" onClick={openConsole}>
                  <ArrowUpRight size={16} />
                  打开完整控制台
                </button>
                {surface === 'popup' && (
                  <button onClick={openPanel}>
                    <PanelRight size={16} />
                    打开侧边栏
                  </button>
                )}
                <button
                  onClick={async () => {
                    try {
                      const forum = await send<string>(mode, 'DETECT_FORUM');
                      if (state) {
                        await send(mode, 'SAVE_CONFIG', { ...state.config, forum });
                        await refresh(true);
                        report(`已识别：${forum}。下次启动生效。`);
                      }
                    } catch (e) {
                      report(String(e));
                    }
                  }}
                >
                  识别当前贴吧
                </button>
              </div>
            </>
          ) : (
            state && (
              <>
                {view === 'overview' && (
                  <>
                    <div className="section-heading welcome">
                      <div>
                        <div className="eyebrow">有序互动，清晰可见</div>
                        <h1>把节奏，留给自己。</h1>
                        <p>发现新主题，逐步执行，每条回复都留下可核实的记录。</p>
                      </div>
                      <button
                        onClick={() => command('CONTROL', { action: 'check' })}
                        disabled={run?.status !== 'running' || busy}
                      >
                        <RefreshCw size={16} />
                        检查一次
                      </button>
                    </div>
                    <div className="stats-grid">
                      {[
                        { name: '本次发现', value: run?.discovered ?? 0, icon: Radio },
                        { name: '符合规则并入队', value: run?.matched ?? 0, icon: ListFilter },
                        { name: '待处理任务', value: state.pending, icon: Clock3 },
                        { name: '首评确认成功', value: run?.rootSuccess ?? 0, icon: MessageCircle },
                        { name: '追评确认成功', value: run?.replySuccess ?? 0, icon: CheckCheck },
                        { name: '结果未知', value: run?.unknownCount ?? 0, icon: AlertTriangle },
                        { name: '明确失败', value: run?.failedCount ?? 0, icon: OctagonX },
                      ].map((s) => (
                        <div className="stat" key={s.name}>
                          <s.icon size={18} />
                          <strong>{s.value}</strong>
                          <span>{s.name}</span>
                        </div>
                      ))}
                    </div>
                    <div className="overview-grid">
                      <section className="panel current-flow">
                        <div className="section-heading">
                          <h2>正在进行</h2>
                          <span className="badge">串行队列</span>
                        </div>
                        {task ? (
                          <>
                            <div className="current-title">
                              <h3>{task.thread.title}</h3>
                              <Badge status={task.status} />
                            </div>
                            <StageFlow task={task} />
                            <p className="muted">下一次允许发送：{time(run?.nextSendAt)}</p>
                            <button onClick={() => showDetail(task.id)}>
                              查看任务与核实证据 <ArrowUpRight size={14} />
                            </button>
                          </>
                        ) : (
                          <Empty title={run ? '等待符合条件的新主题' : '准备好，再出发'}>
                            先配置贴吧与五个内容库，启动时会展示运行摘要。初始历史帖子不会批量入队。
                          </Empty>
                        )}
                        <div className="run-budget">
                          <span>
                            已占用评论额度{' '}
                            <b>
                              {run?.sendCount ?? 0} /{' '}
                              {run?.config.maxSends ?? state.config.maxSends}
                            </b>
                          </span>
                          <progress
                            value={run?.sendCount ?? 0}
                            max={run?.config.maxSends ?? state.config.maxSends}
                          />
                        </div>
                      </section>
                      <section className="panel">
                        <div className="section-heading">
                          <h2>内容准备</h2>
                          <button className="quiet" onClick={() => changeView('libraries')}>
                            管理 <ChevronRight size={14} />
                          </button>
                        </div>
                        {state.libraries.map((l) => (
                          <div className="library-summary" key={l.stage}>
                            <span className="small-icon">
                              {l.stage === 'root' ? '首' : l.stage.slice(-1)}
                            </span>
                            <div>
                              <strong>{stageNames[l.stage]}库</strong>
                              <small>
                                {l.count} 条 · 游标 {l.cursor} · {l.loop ? '循环' : '不循环'}
                              </small>
                            </div>
                            <span className={`badge ${l.enabled ? 'completed' : 'disabled'}`}>
                              {l.enabled ? '已启用' : '未启用'}
                            </span>
                          </div>
                        ))}
                      </section>
                      <section className="panel">
                        <div className="section-heading">
                          <h2>近期活动</h2>
                          <button className="quiet" onClick={() => changeView('logs')}>
                            全部日志 <ChevronRight size={14} />
                          </button>
                        </div>
                        {state.logs.length ? (
                          state.logs.map((l) => (
                            <div className="activity-row" key={l.id}>
                              <Activity size={16} />
                              <div>
                                <p>{l.message}</p>
                                <small>{time(l.at)}</small>
                              </div>
                            </div>
                          ))
                        ) : (
                          <Empty title="还没有活动记录">
                            统计来自当前运行的持久化数据，不以点击发送次数计算成功。
                          </Empty>
                        )}
                      </section>
                      <section className="panel">
                        <h2>运行范围</h2>
                        <dl className="key-values">
                          <dt>当前配置</dt>
                          <dd>v{run?.config.version ?? state.config.version}</dd>
                          <dt>回复对象</dt>
                          <dd>自己的首评楼层</dd>
                          <dt>新帖判定</dt>
                          <dd>可核实的创建时间 + 启动基线</dd>
                          <dt>覆盖范围</dt>
                          <dd>{run?.coverage ?? '启动后显示实际覆盖范围'}</dd>
                          <dt>调度</dt>
                          <dd>浏览器事件唤醒，可能延迟；不补发错过的计划</dd>
                        </dl>
                        {mode === 'demo' && (
                          <label className="field">
                            模拟下一次发送场景
                            <select
                              disabled={!run || !active}
                              value={run?.scenario ?? 'success'}
                              onChange={(e) => command('SCENARIO', e.target.value)}
                            >
                              <option value="success">成功并核实</option>
                              <option value="failure">平台明确拒绝</option>
                              <option value="captcha">验证码阻断</option>
                              <option value="unknown">发送后连接中断（结果未知）</option>
                              <option value="account-change">账号切换</option>
                              <option value="target-mismatch">追评目标作者不符</option>
                              <option value="tab-closed">工作标签页关闭</option>
                            </select>
                          </label>
                        )}
                      </section>
                    </div>
                  </>
                )}
                {view === 'libraries' && state.view === 'libraries' && state.stage === stage && (
                  <LibraryPage
                    key={`${mode}:${stage}`}
                    mode={mode}
                    libraries={state.libraries}
                    stage={stage}
                    onStage={setStage}
                    onChanged={() => refresh(true)}
                    report={report}
                  />
                )}
                {view === 'settings' && (
                  <SettingsPage
                    mode={mode}
                    config={state.config}
                    onChanged={() => refresh(true)}
                    report={report}
                  />
                )}
                {['threads', 'tasks', 'history', 'logs'].includes(view) && (
                  <>
                    <div className="section-heading">
                      <div>
                        <h1>
                          {view === 'threads'
                            ? '不错过看见的每个新主题。'
                            : view === 'tasks'
                              ? '每一步，都有来处。'
                              : view === 'history'
                                ? '留下记录，也留下依据。'
                                : '让状态如实可见。'}
                        </h1>
                        <p>
                          {view === 'threads'
                            ? '发布时间与首次发现时间分别记录，无法核实的新旧判定不会自动入队。'
                            : view === 'logs'
                              ? '最多保留 2000 条日志。内容、账号凭据与会话令牌不会写入日志。'
                              : '内容快照、发送尝试、回复目标和核实证据都保存在本地。'}
                        </p>
                      </div>
                      <div className="actions">
                        {view === 'threads' ? (
                          <button
                            disabled={!active || busy}
                            onClick={() => command('CONTROL', { action: 'check' })}
                          >
                            <RefreshCw size={16} />
                            检查一次
                          </button>
                        ) : (
                          view !== 'tasks' && (
                            <button
                              onClick={async () =>
                                download(
                                  `HoriTieba-${view}.json`,
                                  await send(mode, 'EXPORT', view === 'logs' ? 'logs' : 'history'),
                                )
                              }
                            >
                              <Download size={16} />
                              导出
                            </button>
                          )
                        )}
                        {view === 'history' && (
                          <button
                            className="danger"
                            onClick={() => {
                              if (
                                confirm(
                                  '清理历史任务、帖子与证据？请先导出备份。去重标记仍会保留。',
                                )
                              )
                                void command('CLEAR_HISTORY', 'confirm');
                            }}
                          >
                            清理历史
                          </button>
                        )}
                      </div>
                    </div>
                    <section className="panel list-panel">
                      <div className="toolbar">
                        <label className="search">
                          <Search size={16} />
                          <input
                            value={query}
                            placeholder={view === 'logs' ? '搜索日志' : '搜索标题'}
                            onChange={(e) => {
                              setQuery(e.target.value);
                              setPage(0);
                            }}
                          />
                        </label>
                        {view === 'threads' && (
                          <input
                            aria-label="筛选作者"
                            placeholder="筛选作者"
                            value={author}
                            onChange={(e) => {
                              setAuthor(e.target.value);
                              setPage(0);
                            }}
                          />
                        )}
                        <select
                          aria-label="筛选状态"
                          value={status}
                          onChange={(e) => {
                            setStatus(e.target.value);
                            setPage(0);
                          }}
                        >
                          <option value="">全部状态</option>
                          {(view === 'threads'
                            ? [
                                ['queued', '已入队'],
                                ['display', '仅展示'],
                                ['skipped', '已跳过'],
                              ]
                            : view === 'logs'
                              ? [
                                  ['info', '信息'],
                                  ['warn', '警告'],
                                  ['error', '错误'],
                                ]
                              : Object.entries(statusNames).filter(([k]) => k !== 'disabled')
                          ).map(([v, n]) => (
                            <option key={v} value={v}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </div>
                      {newCount > 0 && view === 'threads' && (
                        <button
                          className="new-threads"
                          onClick={() => {
                            setPage(0);
                            setNewCount(0);
                            void refresh(true);
                          }}
                        >
                          发现 {newCount} 条新帖 · 点击更新，保留阅读位置
                        </button>
                      )}
                      {view === 'threads' ? (
                        state.threads.length ? (
                          <div className="table-scroll">
                            <table>
                              <thead>
                                <tr>
                                  <th>主题与作者</th>
                                  <th>发布时间 / 首次发现</th>
                                  <th>筛选与任务</th>
                                  <th>操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                {state.threads.map((t) => (
                                  <tr key={t.key}>
                                    <td>
                                      <strong>{t.title}</strong>
                                      <small>
                                        {t.author} · {t.kind === 'pinned' ? '置顶' : '主题'}
                                      </small>
                                    </td>
                                    <td>
                                      {t.timePrecisionMs
                                        ? t.timeLabel
                                        : t.publishedAt
                                          ? time(t.publishedAt)
                                          : (t.timeLabel ?? '发布时间未核实')}
                                      <small>首次发现：{time(t.firstSeen)}</small>
                                    </td>
                                    <td>
                                      <span>{t.decision}</span>
                                      <small>
                                        {t.taskId ? '已有任务，可查看实时状态' : '仅展示'}
                                      </small>
                                    </td>
                                    <td>
                                      <div className="row-actions">
                                        <External url={t.url} />
                                        {t.taskId && (
                                          <button
                                            className="quiet"
                                            onClick={() => showDetail(t.taskId!)}
                                          >
                                            详情
                                          </button>
                                        )}
                                        <button
                                          className="quiet"
                                          disabled={t.skipped}
                                          onClick={() => command('SKIP', t.key)}
                                        >
                                          跳过
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <Empty title="尚无可展示的帖子">
                            启动后先建立基线，随后增量更新。不刷新你正在阅读的页面。
                          </Empty>
                        )
                      ) : view === 'logs' ? (
                        state.logs.length ? (
                          <div className="logs">
                            {state.logs.map((l) => (
                              <div className="log-row" key={l.id}>
                                <time>{time(l.at)}</time>
                                <span
                                  className={`badge ${l.level === 'warn' ? 'unknown' : l.level === 'error' ? 'failed' : 'completed'}`}
                                >
                                  {l.level === 'warn'
                                    ? '警告'
                                    : l.level === 'error'
                                      ? '错误'
                                      : '信息'}
                                </span>
                                <code>{l.event}</code>
                                <p>{l.message}</p>
                                {l.taskId && (
                                  <button className="quiet" onClick={() => showDetail(l.taskId!)}>
                                    任务
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <Empty title="没有匹配的日志" />
                        )
                      ) : state.tasks.length ? (
                        <div className="task-list">
                          {state.tasks.map((t) => (
                            <button
                              className="task-card"
                              key={t.id}
                              onClick={() => showDetail(t.id)}
                            >
                              <div className="section-heading">
                                <strong>{t.thread.title}</strong>
                                <Badge status={t.status} />
                              </div>
                              <StageFlow task={t} />
                              <small>
                                {time(t.createdAt)} · 配置 v{t.configVersion} ·{' '}
                                {t.reason ?? '查看内容快照与证据'}
                              </small>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <Empty title="暂时没有任务">
                          只有通过基线、创建时间、规则、身份和去重校验的主题才会进入队列。
                        </Empty>
                      )}
                      <Pager page={page} total={state.total} onPage={setPage} />
                    </section>
                  </>
                )}
              </>
            )
          )}
        </main>
        {!compact && (
          <footer>
            <span>
              <ShieldCheck size={13} />
              本地运行 · {mode === 'demo' ? '演示数据独立存储' : '按已确认范围执行'}
            </span>
            <span>计划时间不代表浏览器精确执行时间</span>
          </footer>
        )}
      </div>
      {summary && (
        <Modal
          title={
            mode === 'demo'
              ? '确认启动自动演示'
              : summary.config.realAction === 'auto'
                ? '确认真实自动发送范围'
                : '确认启动真实只读监控'
          }
          onClose={() => setSummary(null)}
        >
          <p>
            {mode === 'demo'
              ? '确认后会在下列范围内自动运行，不逐条询问。所有发送仅发生在本地演示账本。'
              : summary.config.realAction === 'auto'
                ? '确认后，将使用当前账号在符合规则的新主题中自动发布，不逐条询问。会使用贴吧官方旧版页面并核实每次结果。隐藏页的回复框超时后，扩展会自动显示执行标签页，再核对楼层并准备。'
                : '本批次仅观察列表，不发送评论。'}
          </p>
          <dl className="key-values">
            <dt>目标贴吧</dt>
            <dd>{summary.config.forum}</dd>
            <dt>绑定账号</dt>
            <dd>
              {mode === 'demo'
                ? '演示账号 · Hori'
                : summary.preflightAccount?.confirmed
                  ? `${summary.preflightAccount.label} · ${summary.preflightAccount.id}`
                  : '身份未确认（仅允许只读）'}
            </dd>
            <dt>标题规则</dt>
            <dd>
              {summary.config.include.length
                ? `${summary.config.match === 'any' ? '任意' : '全部'}包含 ${summary.config.include.join('、')}`
                : '不限包含关键词'}
              ；排除 {summary.config.exclude.join('、') || '无'}
            </dd>
            <dt>作者排除</dt>
            <dd>{summary.config.authors.join('、') || '无'}</dd>
            <dt>追评阶段</dt>
            <dd>
              {enabledStages(summary.config, summary.libraries)
                .map((s) => stageNames[s])
                .join(' → ')}
            </dd>
            <dt>回复对象</dt>
            <dd>自己的首评，保持在同一楼层</dd>
            <dt>数量上限</dt>
            <dd>
              {summary.config.maxPosts} 帖 / {summary.config.maxSends} 次发送 / 每帖{' '}
              {summary.config.maxReplies} 次追评
            </dd>
            <dt>执行节奏</dt>
            <dd>
              每 {summary.config.checkSeconds} 秒检查 / 发送至少间隔 {summary.config.sendSeconds} 秒
            </dd>
          </dl>
          <div className="summary-libraries">
            {summary.libraries.map((l) => (
              <span key={l.stage}>
                {stageNames[l.stage]}：{l.count} 条 · {l.enabled ? '启用' : '停用'} ·{' '}
                {l.loop ? '循环' : '不循环'}
                {l.enabled && l.nextText && <small>下一条：{l.nextText}</small>}
              </span>
            ))}
          </div>
          <p className="muted">
            初始历史帖子只展示。运行期间修改配置、内容库从下一批次生效。关闭控制台不会停止后台队列。
          </p>
          <button
            className="primary"
            disabled={
              busy ||
              (mode === 'real' &&
                summary.config.realAction === 'auto' &&
                !summary.preflightAccount?.confirmed)
            }
            onClick={async () => {
              setSummary(null);
              await command('CONTROL', {
                action: 'start',
                expected: {
                  configVersion: summary.config.version,
                  libraryVersions: summary.libraries.map((l) => l.version),
                  ...(summary.preflightAccount?.id
                    ? { accountId: summary.preflightAccount.id }
                    : {}),
                },
              });
              await command('CONTROL', { action: 'check' });
            }}
          >
            确认范围并启动
          </button>
        </Modal>
      )}
      {detail && (
        <div
          className="drawer-backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && setDetail(null)}
        >
          <aside className="drawer" role="dialog" aria-label="任务详情">
            <div className="section-heading">
              <h2>任务详情</h2>
              <button
                className="icon-button"
                aria-label="关闭任务详情"
                onClick={() => setDetail(null)}
              >
                <X size={20} />
              </button>
            </div>
            <h3>{detail.task.thread.title}</h3>
            <External url={detail.task.thread.url} />
            <Badge status={detail.task.status} />
            <dl className="key-values">
              <dt>任务 ID</dt>
              <dd className="mono">{detail.task.id}</dd>
              <dt>绑定账号</dt>
              <dd>
                {detail.task.account.label} · {detail.task.account.id}
              </dd>
              <dt>配置版本</dt>
              <dd>v{detail.task.configVersion}</dd>
              <dt>计划执行</dt>
              <dd>{time(detail.task.plannedAt)}</dd>
              <dt>最近更新</dt>
              <dd>{time(detail.task.updatedAt)}</dd>
              <dt>首评关联</dt>
              <dd>{detail.task.root?.rootId ?? '未取得已核实的首评标识'}</dd>
            </dl>
            {detail.task.steps.map((s) => (
              <section className="step-detail" key={s.id}>
                <div className="section-heading">
                  <h3>{stageNames[s.stage]}</h3>
                  <Badge status={s.status} />
                </div>
                <p className="snapshot-text">
                  {s.text ?? (s.status === 'disabled' ? '此阶段未启用' : '执行前冻结内容快照')}
                </p>
                <small>
                  库 v{s.libraryVersion} · 游标 {s.cursor ?? '—'} · 条目 {s.itemId ?? '尚未选择'}
                </small>
                <p className="muted">
                  开始：{time(s.startedAt)}
                  <br />
                  结束：{time(s.endedAt)}
                </p>
                {s.reason && <p className="error-text">{s.reason}</p>}
                {s.evidence && (
                  <div className="evidence">
                    <strong>
                      {s.evidence.source === 'manual'
                        ? '用户手动确认'
                        : s.evidence.source === 'demo-ledger'
                          ? '本地演示证据'
                          : '真实页面证据'}
                    </strong>
                    <p>
                      评论 {s.evidence.commentId}
                      <br />
                      根楼层 {s.evidence.rootId}
                      <br />
                      回复目标 {s.evidence.targetId ?? '一级评论'}
                      <br />
                      作者 {s.evidence.authorId}
                    </p>
                    {s.evidence.note && <p>{s.evidence.note}</p>}
                  </div>
                )}
                {detail.attempts
                  .filter((a) => a.stepId === s.id)
                  .map((a) => (
                    <details key={a.id}>
                      <summary>
                        发送尝试 · {a.status} · {time(a.intendedAt)}
                      </summary>
                      <pre>{JSON.stringify(a, null, 2)}</pre>
                    </details>
                  ))}
              </section>
            ))}
            <div className="drawer-actions">
              <button onClick={() => showDetail(detail.task.id)}>
                <RefreshCw size={15} />
                刷新证据
              </button>
              {detail.task.steps.some((s) => s.status === 'unknown') && (
                <>
                  <button
                    className="primary"
                    onClick={async () => {
                      await command('VERIFY', detail.task.id);
                      await showDetail(detail.task.id);
                    }}
                  >
                    重新读取核实
                  </button>
                  <button
                    onClick={async () => {
                      const commentId = prompt(
                        '请填写已在原帖确认的评论 ID。此操作会标记为“用户手动确认”。',
                      );
                      if (!commentId) return;
                      const note = prompt('请填写确认依据（楼层、作者、时间与内容关系）。');
                      if (!note || !confirm('确认此步骤已经发布？确认后游标会推进一次。')) return;
                      await command('CONFIRM_PUBLISHED', {
                        taskId: detail.task.id,
                        commentId,
                        note,
                      });
                      await showDetail(detail.task.id);
                    }}
                  >
                    手动标记已发布
                  </button>
                </>
              )}
              {detail.task.steps.some((s) => ['unknown', 'failed'].includes(s.status)) && (
                <button
                  className="danger"
                  onClick={async () => {
                    if (
                      !confirm(
                        '请先核对原帖。未知结果重试可能重复发布，之前占用的额度不会退还。确认仍要重试？',
                      )
                    )
                      return;
                    await command('RETRY', { taskId: detail.task.id, acknowledged: true });
                    await showDetail(detail.task.id);
                  }}
                >
                  明确重新尝试
                </button>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
function StageFlow({ task }: { task: Task }) {
  return (
    <div className="stage-flow">
      {task.steps.map((s, i) => (
        <React.Fragment key={s.id}>
          {i > 0 && <span className="flow-connector" />}
          <div className={`stage-node ${s.status}`}>
            <span>{s.status === 'completed' ? <CheckCheck size={14} /> : i === 0 ? '首' : i}</span>
            <strong>{stageNames[s.stage]}</strong>
            <small>{statusNames[s.status]}</small>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
