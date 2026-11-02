import { it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { harness } from '../helpers';
import { Service } from '../../src/background/message-router/service';
import { uid, type Thread, type Log } from '../../src/domain/models';
it('10,000 帖、2,000 条保留日志、每库 5,000 条内容：分页快照和增量更新', async () => {
  const h = await harness();
  const start = performance.now();
  const libs = await h.repo.libraries('demo');
  await h.repo.saveLibraries(
    'demo',
    libs.map((l) => ({
      ...l,
      items: Array.from({ length: 5000 }, (_, i) => ({
        id: uid(),
        text: `${l.stage} 性能样本 ${i}`,
      })),
    })),
  );
  await h.engine.start('demo');
  const run = (await h.run())!;
  await h.repo.atomic(async (tx) => {
    for (let i = 0; i < 10000; i++) {
      const t: Thread = {
        key: `demo:performance:${i}`,
        id: String(i),
        title: `主题 ${i}`,
        author: `作者 ${i % 50}`,
        mode: 'demo',
        forum: run.config.forum,
        url: '',
        kind: 'thread',
        timeEvidence: 'unavailable',
        source: '性能 fixture',
        firstSeen: Date.now() + i,
        runId: run.id,
        decision: '仅展示',
      };
      await tx.objectStore('threads').put(t);
    }
    for (let i = 0; i < 2500; i++) {
      const l: Log = {
        id: uid(),
        mode: 'demo',
        at: Date.now() + i,
        event: 'performance',
        message: `日志 ${i}`,
        level: 'info',
      };
      await tx.objectStore('logs').put(l);
    }
    await h.repo.trimLogs(tx);
  });
  const seedMs = performance.now() - start;
  const service = new Service(h.repo, h.engine);
  const snapStart = performance.now();
  const state = (await service.handle({
    type: 'STATE',
    requestId: uid(),
    context: 'dashboard',
    mode: 'demo',
    payload: { view: 'threads', page: 3, query: '', author: '', status: '', stage: 'root' },
  })) as any;
  const snapshotMs = performance.now() - snapStart;
  const samples: number[] = [];
  for (let n = 0; n < 20; n++) {
    const t = performance.now();
    await h.repo.db.put('threads', { ...state.threads[0], title: `更新 ${n}` });
    samples.push(performance.now() - t);
  }
  expect(state.threads).toHaveLength(25);
  expect(state.total).toBe(10000);
  expect(state.libraries.every((l: any) => l.items.length === 0)).toBe(true);
  expect(state.run.libraries.every((l: any) => l.items.length === 0)).toBe(true);
  expect(await h.repo.db.count('logs')).toBe(2000);
  const result = {
    environment: {
      platform: os.platform(),
      arch: os.arch(),
      node: process.version,
      cpu: os.cpus()[0]?.model,
    },
    dataset: {
      threads: 10000,
      logsImported: 2500,
      logsRetained: 2000,
      libraries: 5,
      itemsPerLibrary: 5000,
    },
    seedMs,
    snapshotMs,
    snapshotBytes: new TextEncoder().encode(JSON.stringify(state)).length,
    incrementalUpdateMeanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
    note: 'Node + fake-indexeddb 数据层测量；不代表真实浏览器帧率、内存泄漏或长期稳定性',
  };
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/performance.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}, 30000);
