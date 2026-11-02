import type { Repository } from '../../storage/database';
import { Engine } from '../queue/engine';
import { parseBundle, normalizeForum } from '../../shared/validation';
import {
  cursorId,
  libraryId,
  type Library,
  type Config,
  type Run,
  type Thread,
  type Task,
  type Log,
  type Stage,
  type Account,
} from '../../domain/models';
import { realCapability } from '../../adapters/tieba/adapter';
import type { Request } from '../../shared/messages';
import type { WorkTabs } from '../work-tabs';
export interface LibraryView extends Library {
  count: number;
  cursor: number;
  nextText?: string;
}
export interface Snapshot {
  view: string;
  stage: Stage;
  config: Config;
  run?: Run;
  libraries: LibraryView[];
  threads: Thread[];
  tasks: Task[];
  logs: Log[];
  total: number;
  page: number;
  pending: number;
  currentTask?: Task;
  fault: string | null;
  capabilities: typeof realCapability;
  lastActivity?: number;
  preflightAccount?: Account;
}
export class Service {
  constructor(
    public repo: Repository,
    public engine: Engine,
    private tabs?: WorkTabs,
  ) {}
  async handle(r: Request): Promise<unknown> {
    switch (r.type) {
      case 'STATE':
        return this.snapshot(r);
      case 'CONTROL':
        if (r.payload.action === 'start') {
          if (!r.payload.expected) throw Error('缺少已确认的启动摘要版本');
          return this.engine.start(r.mode, r.payload.expected);
        } else if (r.payload.action === 'check') {
          await this.engine.tick(r.mode);
          return { note: '已按互斥与频率限制检查；未到允许时间时不会提前执行' };
        } else return this.engine.control(r.mode, r.payload.action);
      case 'SAVE_CONFIG':
        if (r.payload.id !== r.mode) throw Error('模式不一致');
        return this.repo.saveConfig({ ...r.payload, forum: normalizeForum(r.payload.forum) });
      case 'SAVE_LIBRARY':
        if (r.payload.mode !== r.mode) throw Error('模式不一致');
        return this.repo.saveLibraries(r.mode, [r.payload]);
      case 'RESET_CURSOR':
        return this.repo.atomic(async (tx) => {
          const run = await this.engine.currentTx(tx, r.mode);
          if (run && !['stopped', 'completed'].includes(run.status))
            throw Error('重置游标前请停止当前运行');
          const tasks = await tx.objectStore('tasks').index('mode').getAll(r.mode);
          if (
            tasks.some((t) =>
              t.steps.some((s) => ['unknown', 'running', 'verifying'].includes(s.status)),
            )
          )
            throw Error('请先处理未知结果');
          const lib = await tx.objectStore('libraries').get(libraryId(r.mode, r.payload));
          if (lib) await tx.objectStore('cursors').put({ id: cursorId(lib), position: 0 });
        });
      case 'IMPORT_JSON': {
        const bundle = parseBundle(r.payload, r.mode);
        const current = await this.repo.libraries(r.mode);
        return this.repo.saveLibraries(
          r.mode,
          bundle.libraries.map((l) => ({
            ...l,
            version: current.find((c) => c.stage === l.stage)!.version,
          })),
          bundle.config,
        );
      }
      case 'EXPORT':
        if (r.payload === 'config')
          return {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            libraries: await this.repo.libraries(r.mode),
            config: await this.repo.db.get('configs', r.mode),
          };
        else
          return {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            mode: r.mode,
            data: await this.repo.db.getAllFromIndex(
              r.payload === 'history' ? 'tasks' : 'logs',
              'mode',
              r.mode,
            ),
          };
      case 'DETAIL': {
        const task = await this.repo.db.get('tasks', r.payload);
        if (task?.mode !== r.mode) throw Error('任务不属于当前模式');
        return {
          task,
          attempts: await this.repo.db.getAllFromIndex('attempts', 'taskId', r.payload),
        };
      }
      case 'SKIP':
        return this.engine.skip(r.mode, r.payload);
      case 'VERIFY':
        await this.owns(r.payload, r.mode);
        return this.engine.verify(r.payload);
      case 'RETRY':
        await this.owns(r.payload.taskId, r.mode);
        return this.engine.retry(r.payload.taskId, r.payload.acknowledged);
      case 'CONFIRM_PUBLISHED':
        await this.owns(r.payload.taskId, r.mode);
        return this.engine.confirmPublished(r.payload.taskId, r.payload.commentId, r.payload.note);
      case 'SCENARIO':
        if (r.mode !== 'demo') throw Error('真实模式禁止模拟场景');
        return this.engine.scenario(r.payload);
      case 'CLEAR_HISTORY':
        return this.repo.clearHistory(r.mode);
      case 'DETECT_FORUM':
        if (!this.tabs) throw Error('仅扩展可识别标签页');
        return this.tabs.detectActiveForum();
      case 'OPEN_WORK_TAB':
        return this.tabs?.focus();
      case 'PREFLIGHT':
        return this.engine.preflight(r.mode);
    }
  }
  private async owns(id: string, mode: string) {
    if ((await this.repo.db.get('tasks', id))?.mode !== mode) throw Error('跨模式任务操作被拒绝');
  }
  async snapshot(r: Extract<Request, { type: 'STATE' }>): Promise<Snapshot> {
    const { view, page, query, author, status, stage } = r.payload;
    const run = await this.repo.current(r.mode);
    const libraries = await this.repo.libraries(r.mode);
    const libraryViews = await Promise.all(
      libraries.map(async (l) => {
        const cursor = (await this.repo.db.get('cursors', cursorId(l)))?.position ?? 0;
        return {
          ...l,
          count: l.items.length,
          items: view === 'libraries' && l.stage === stage ? l.items : [],
          cursor,
          nextText: l.items[l.loop ? cursor % l.items.length : cursor]?.text,
        };
      }),
    );
    const currentTasks = run
      ? (await this.repo.db.getAllFromIndex('tasks', 'runId', run.id)).sort(
          (a, b) => a.createdAt - b.createdAt,
        )
      : [];
    const pending = currentTasks.filter(
      (t) => !['completed', 'stopped', 'skipped'].includes(t.status),
    ).length;
    const currentTask = currentTasks.find(
      (t) => !['completed', 'stopped', 'skipped'].includes(t.status),
    );
    let threads: Thread[] = [];
    let tasks: Task[] = [];
    let logs: Log[] = [];
    let total = 0;
    const size = 25;
    if (view === 'threads') {
      const all = (await this.repo.db.getAllFromIndex('threads', 'mode', r.mode))
        .filter(
          (t) =>
            t.forum === (run?.config.forum ?? r.mode) &&
            t.title.toLowerCase().includes(query.toLowerCase()) &&
            (!author || t.author.includes(author)) &&
            (!status ||
              (status === 'queued' ? !!t.taskId : status === 'skipped' ? t.skipped : !t.taskId)),
        )
        .sort((a, b) => b.firstSeen - a.firstSeen);
      total = all.length;
      threads = all.slice(page * size, (page + 1) * size);
    }
    if (view === 'tasks' || view === 'history') {
      const all = (
        view === 'tasks'
          ? currentTasks
          : await this.repo.db.getAllFromIndex('tasks', 'mode', r.mode)
      )
        .filter(
          (t) =>
            (!status || t.status === status) &&
            t.thread.title.toLowerCase().includes(query.toLowerCase()),
        )
        .sort((a, b) => b.createdAt - a.createdAt);
      total = all.length;
      tasks = all.slice(page * size, (page + 1) * size);
    }
    const recent = (await this.repo.db.getAllFromIndex('logs', 'mode', r.mode)).sort(
      (a, b) => b.at - a.at,
    );
    if (view === 'logs') {
      const all = recent.filter(
        (l) => (!status || l.level === status) && l.message.includes(query),
      );
      total = all.length;
      logs = all.slice(page * size, (page + 1) * size);
    } else logs = recent.slice(0, 5);
    return {
      view,
      stage,
      config: (await this.repo.db.get('configs', r.mode))!,
      run: run ? { ...run, libraries: run.libraries.map((l) => ({ ...l, items: [] })) } : undefined,
      libraries: libraryViews,
      threads,
      tasks,
      logs,
      total,
      page,
      pending,
      currentTask,
      fault: this.engine.storageFault,
      capabilities: realCapability,
      lastActivity: run?.lastActivity,
    };
  }
}
