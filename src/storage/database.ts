import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import {
  stages,
  defaultConfig,
  libraryId,
  type Config,
  type Library,
  type Cursor,
  type Run,
  type Task,
  type Attempt,
  type Thread,
  type Log,
  type Lease,
  type Mode,
  uid,
} from '../domain/models';
export interface Schema extends DBSchema {
  meta: { key: string; value: { id: string; value: unknown } };
  configs: { key: string; value: Config };
  libraries: { key: string; value: Library };
  cursors: { key: string; value: Cursor };
  runs: { key: string; value: Run; indexes: { mode: Mode } };
  tasks: {
    key: string;
    value: Task;
    indexes: { mode: Mode; runId: string; dedupeKey: string; status: string };
  };
  attempts: {
    key: string;
    value: Attempt;
    indexes: { taskId: string; status: string; mode: Mode };
  };
  threads: {
    key: string;
    value: Thread;
    indexes: { mode: Mode; runId: string; firstSeen: number };
  };
  dedupe: { key: string; value: { id: string; taskId: string } };
  leases: { key: string; value: Lease };
  logs: { key: string; value: Log; indexes: { mode: Mode; at: number } };
  demoLedger: {
    key: string;
    value: { id: string; attemptId: string; evidence: import('../domain/models').Evidence };
    indexes: { attemptId: string };
  };
}
export const stores = [
  'meta',
  'configs',
  'libraries',
  'cursors',
  'runs',
  'tasks',
  'attempts',
  'threads',
  'dedupe',
  'leases',
  'logs',
  'demoLedger',
] as const;
export type Transaction = IDBPTransaction<Schema, typeof stores, 'readwrite'>;
export class Repository {
  constructor(public db: IDBPDatabase<Schema>) {}
  static async open(name = 'HoriTieba-v1') {
    const db = await openDB<Schema>(name, 1, {
      upgrade(db) {
        db.createObjectStore('meta', { keyPath: 'id' });
        db.createObjectStore('configs', { keyPath: 'id' });
        db.createObjectStore('libraries', { keyPath: 'id' });
        db.createObjectStore('cursors', { keyPath: 'id' });
        const r = db.createObjectStore('runs', { keyPath: 'id' });
        r.createIndex('mode', 'mode');
        const t = db.createObjectStore('tasks', { keyPath: 'id' });
        t.createIndex('mode', 'mode');
        t.createIndex('runId', 'runId');
        t.createIndex('status', 'status');
        t.createIndex('dedupeKey', 'dedupeKey', { unique: true });
        const a = db.createObjectStore('attempts', { keyPath: 'id' });
        a.createIndex('taskId', 'taskId');
        a.createIndex('status', 'status');
        a.createIndex('mode', 'mode');
        const th = db.createObjectStore('threads', { keyPath: 'key' });
        th.createIndex('mode', 'mode');
        th.createIndex('runId', 'runId');
        th.createIndex('firstSeen', 'firstSeen');
        db.createObjectStore('dedupe', { keyPath: 'id' });
        db.createObjectStore('leases', { keyPath: 'id' });
        const logs = db.createObjectStore('logs', { keyPath: 'id' });
        logs.createIndex('mode', 'mode');
        logs.createIndex('at', 'at');
        db.createObjectStore('demoLedger', { keyPath: 'id' }).createIndex('attemptId', 'attemptId');
      },
      blocked() {
        throw Error('数据库升级被旧控制台占用，请关闭旧页面再试。数据未删除。');
      },
    });
    db.addEventListener('versionchange', () => db.close());
    const repo = new Repository(db);
    await repo.seed();
    return repo;
  }
  async atomic<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = this.db.transaction(stores, 'readwrite', { durability: 'strict' });
    try {
      const result = await fn(tx);
      await tx.done;
      return result;
    } catch (e) {
      try {
        tx.abort();
      } catch {}
      await tx.done.catch(() => {});
      throw e;
    }
  }
  async seed() {
    await this.atomic(async (tx) => {
      for (const mode of ['demo', 'real'] as const) {
        if (await tx.objectStore('configs').get(mode)) continue;
        await tx.objectStore('configs').put(defaultConfig(mode));
        for (const stage of stages) {
          const lib: Library = {
            id: libraryId(mode, stage),
            mode,
            stage,
            version: 1,
            enabled: stage === 'root' || stage === 'reply1' || stage === 'reply3',
            loop: false,
            items:
              mode === 'demo'
                ? Array.from({ length: 5 }, (_, i) => ({
                    id: uid(),
                    text:
                      stage === 'root'
                        ? `这是一条本地演示首评 ${i + 1}，不会发送到贴吧。`
                        : `本地演示${stage.replace('reply', '回复 ')}，内容 ${i + 1}。`,
                  }))
                : [],
          };
          await tx.objectStore('libraries').put(lib);
        }
      }
    });
  }
  async current(mode: Mode): Promise<Run | undefined> {
    const id = (await this.db.get('meta', `active:${mode}`))?.value as string | undefined;
    return id ? this.db.get('runs', id) : undefined;
  }
  async libraries(mode: Mode) {
    return Promise.all(
      stages.map((s) => this.db.get('libraries', libraryId(mode, s)) as Promise<Library>),
    );
  }
  async log(
    mode: Mode,
    event: string,
    message: string,
    level: Log['level'] = 'info',
    taskId?: string,
    runId?: string,
  ) {
    await this.atomic(async (tx) => {
      await tx.objectStore('logs').add({
        id: uid(),
        mode,
        at: Date.now(),
        level,
        event,
        message: message.slice(0, 1000),
        taskId,
        runId,
      });
      await this.trimLogs(tx);
    });
  }
  async trimLogs(tx: Transaction) {
    const s = tx.objectStore('logs');
    const excess = (await s.count()) - 2000;
    if (excess > 0) {
      let c = await s.index('at').openCursor();
      for (let i = 0; c && i < excess; i++) {
        await c.delete();
        c = await c.continue();
      }
    }
  }
  async saveConfig(config: Config) {
    await this.atomic(async (tx) => {
      const prev = await tx.objectStore('configs').get(config.id);
      if (prev && prev.version !== config.version)
        throw Error('设置已被另一个页面修改，请刷新后重试');
      await tx.objectStore('configs').put({ ...config, version: (prev?.version ?? 0) + 1 });
    });
  }
  async saveLibraries(mode: Mode, libraries: Library[], config?: Config) {
    await this.atomic(async (tx) => {
      for (const lib of libraries) {
        const prev = await tx.objectStore('libraries').get(libraryId(mode, lib.stage));
        if (lib.version !== prev?.version) throw Error('内容库已被另一个页面修改，请刷新后重试');
        await tx
          .objectStore('libraries')
          .put({ ...lib, id: libraryId(mode, lib.stage), mode, version: lib.version + 1 });
      }
      if (config) {
        const old = await tx.objectStore('configs').get(mode);
        await tx
          .objectStore('configs')
          .put({ ...config, id: mode, version: (old?.version ?? 0) + 1 });
      }
    });
  }
  async lease(id: string, owner: string, now: number, duration = 25000) {
    return this.atomic(async (tx) => {
      const old = await tx.objectStore('leases').get(id);
      if (old && old.expiresAt > now && old.owner !== owner) return false;
      await tx.objectStore('leases').put({ id, owner, expiresAt: now + duration });
      return true;
    });
  }
  async release(id: string, owner: string) {
    await this.atomic(async (tx) => {
      if ((await tx.objectStore('leases').get(id))?.owner === owner)
        await tx.objectStore('leases').delete(id);
    });
  }
  async clearHistory(mode: Mode) {
    await this.atomic(async (tx) => {
      const active = await tx.objectStore('meta').get(`active:${mode}`);
      const run = active ? await tx.objectStore('runs').get(active.value as string) : undefined;
      if (run && ['running', 'paused', 'blocked'].includes(run.status))
        throw Error('请先停止当前运行，再清理历史');
      const tasks = await tx.objectStore('tasks').index('mode').getAll(mode);
      if (
        tasks.some((t) =>
          t.steps.some((s) => ['unknown', 'verifying', 'running'].includes(s.status)),
        )
      )
        throw Error('还有结果未确认的发送，请先核实');
      for (const t of tasks) {
        for (const a of await tx.objectStore('attempts').index('taskId').getAll(t.id)) {
          for (const e of await tx.objectStore('demoLedger').index('attemptId').getAll(a.id))
            await tx.objectStore('demoLedger').delete(e.id);
          await tx.objectStore('attempts').delete(a.id);
        }
        await tx.objectStore('tasks').delete(t.id);
      }
      for (const t of await tx.objectStore('threads').index('mode').getAll(mode))
        await tx.objectStore('threads').delete(t.key);
      for (const r of await tx.objectStore('runs').index('mode').getAll(mode))
        await tx.objectStore('runs').delete(r.id);
      await tx.objectStore('meta').delete(`active:${mode}`);
    });
  }
}
