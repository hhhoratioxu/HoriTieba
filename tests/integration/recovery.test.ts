import { it, expect, vi } from 'vitest';
import { harness } from '../helpers';
import { Engine } from '../../src/background/queue/engine';
it('紧急停止在持久化许可与外部动作之间发生时仍可取消，绝不写入模拟平台', async () => {
  const h = await harness();
  await h.start();
  const original = h.repo.atomic.bind(h.repo);
  let interrupted = false;
  vi.spyOn(h.repo, 'atomic').mockImplementation(async (fn) => {
    const result = await original(fn);
    if (!interrupted && (await h.attempts()).some((a) => a.status === 'submitted')) {
      interrupted = true;
      await h.engine.control('demo', 'emergency');
    }
    return result;
  });
  h.advance();
  await h.engine.tick('demo');
  expect(interrupted).toBe(true);
  expect(await h.repo.db.count('demoLedger')).toBe(0);
  expect((await h.tasks())[0].steps[0].status).toBe('stopped');
  expect(await h.repo.db.count('cursors')).toBe(0);
});
it('干净的后台回收保留原定计划，不因重复唤醒而无限推迟执行', async () => {
  const h = await harness();
  await h.start();
  const before = (await h.run())!;
  const next = new Engine(h.repo, { demo: h.adapter, real: h.real }, h.clock);
  await next.recover();
  const run = (await h.run())!;
  expect(run.id).toBe(before.id);
  expect(run.status).toBe('running');
  expect(run.nextCheckAt).toBe(before.nextCheckAt);
  h.advance();
  await next.recover();
  await next.tick('demo');
  expect((await h.run())?.rootSuccess).toBe(1);
  expect(run.sendCount).toBe(0);
});
it('启动摘要过期时拒绝按新配置悄悄启动', async () => {
  const h = await harness();
  await h.repo.saveConfig({ ...(await h.repo.db.get('configs', 'demo'))!, maxSends: 5 });
  await expect(
    h.engine.start('demo', { configVersion: 1, libraryVersions: [1, 1, 1, 1, 1] }),
  ).rejects.toThrow('摘要已过期');
  expect(await h.run()).toBeUndefined();
});
it('读取失败退避，手动检查不绕过频率限制', async () => {
  const h = await harness();
  vi.spyOn(h.adapter, 'readThreadCandidates').mockRejectedValue(Error('网络中断'));
  await h.engine.start('demo');
  await h.engine.tick('demo');
  expect((await h.run())?.readFailures).toBe(1);
  const until = (await h.run())!.nextCheckAt;
  await h.engine.tick('demo');
  expect((await h.run())?.readFailures).toBe(1);
  expect(until - h.clock()).toBe(120000);
});
it('账号变化同样在监控读结果时暂停，不等待错误账号发出第一条', async () => {
  const h = await harness();
  await h.start();
  const original = h.adapter.readThreadCandidates.bind(h.adapter);
  vi.spyOn(h.adapter, 'readThreadCandidates').mockImplementation(async (run) => ({
    ...(await original(run)),
    account: { id: 'changed', label: '新账号', confirmed: true },
  }));
  h.advance();
  await h.engine.tick('demo');
  expect((await h.run())?.status).toBe('blocked');
  expect(await h.attempts()).toHaveLength(0);
});
it('游标原子提交失败：平台证据保留，恢复后核实只推进一次', async () => {
  const h = await harness();
  await h.start();
  const original = h.adapter.submit.bind(h.adapter);
  vi.spyOn(h.adapter, 'submit').mockImplementation(async (a, r) => {
    await original(a, r);
    vi.spyOn(h.repo, 'atomic').mockRejectedValueOnce(
      new DOMException('存储配额耗尽', 'QuotaExceededError'),
    );
  });
  h.advance();
  await h.engine.tick('demo');
  expect(await h.repo.db.count('demoLedger')).toBe(1);
  expect(await h.repo.db.count('cursors')).toBe(0);
  expect(h.engine.storageFault).toBeTruthy();
  vi.restoreAllMocks();
  const next = new Engine(h.repo, { demo: h.adapter, real: h.real }, h.clock);
  await next.recover();
  const task = (await h.tasks())[0];
  expect(task.status).toBe('unknown');
  await next.verify(task.id);
  expect((await h.repo.db.getAll('cursors'))[0].position).toBe(1);
  expect((await h.run())?.rootSuccess).toBe(1);
});
it('同帖跨新运行仍去重，与是否清理任务历史无关', async () => {
  const h = await harness();
  await h.repo.saveConfig({ ...(await h.repo.db.get('configs', 'demo'))!, selfReply: false });
  const original = h.adapter.readThreadCandidates.bind(h.adapter);
  vi.spyOn(h.adapter, 'readThreadCandidates').mockImplementation(async (r) => {
    const scan = await original(r);
    return {
      ...scan,
      candidates: r.baseline
        ? [{ ...scan.candidates[0], id: 'persisted-id', publishedAt: h.clock() }]
        : [],
    };
  });
  await h.start();
  h.advance();
  await h.engine.tick('demo');
  await h.engine.control('demo', 'stop');
  await h.repo.clearHistory('demo');
  await h.engine.start('demo');
  await h.engine.tick('demo');
  h.advance();
  await h.engine.tick('demo');
  expect(await h.tasks()).toHaveLength(0);
  expect((await h.repo.db.getAll('threads'))[0].decision).toContain('跨批次去重');
});
