import { describe, it, expect, vi } from 'vitest';
import { harness } from '../helpers';
import { Engine } from '../../src/background/queue/engine';
import { cursorId, stages } from '../../src/domain/models';
describe('五库、快照与串行队列', () => {
  it('五个库独立导入编辑排序且版本相互独立', async () => {
    const h = await harness();
    const libs = await h.repo.libraries('demo');
    for (const l of libs)
      await h.repo.saveLibraries('demo', [
        {
          ...l,
          items: [
            { id: 'b', text: l.stage + ' B' },
            { id: 'a', text: l.stage + ' A' },
          ],
        },
      ]);
    const saved = await h.repo.libraries('demo');
    expect(saved.map((l) => l.items.map((i) => i.id))).toEqual(Array(5).fill(['b', 'a']));
    expect(saved.map((l) => l.version)).toEqual([2, 2, 2, 2, 2]);
  });
  it('只启用回复 1 和 3，按首评→1→3核实，其他显示未启用', async () => {
    const h = await harness();
    await h.start();
    expect((await h.tasks()).length).toBe(0);
    h.advance();
    await h.engine.tick('demo');
    h.advance(30001);
    await h.engine.tick('demo');
    h.advance(30001);
    await h.engine.tick('demo');
    const t = (await h.tasks()).sort((a, b) => a.createdAt - b.createdAt)[0];
    expect(t.steps.map((s) => s.status)).toEqual([
      'completed',
      'completed',
      'disabled',
      'completed',
      'disabled',
    ]);
    expect(
      (await h.attempts())
        .filter((a) => a.taskId === t.id)
        .map((a) => a.stage)
        .sort(),
    ).toEqual(['reply1', 'reply3', 'root']);
    for (const s of t.steps.filter((s) => s.committed))
      expect((await h.repo.db.get('cursors', s.cursorKey!))?.position).toBe(1);
    const replies = (await h.attempts()).filter((a) => a.stage !== 'root');
    expect(
      replies.every(
        (a) => a.target.rootId === t.root?.rootId && a.target.commentId === t.root?.rootId,
      ),
    ).toBe(true);
  });
  it('关闭回复自己只执行首评', async () => {
    const h = await harness();
    await h.repo.saveConfig({ ...(await h.repo.db.get('configs', 'demo'))!, selfReply: false });
    await h.start();
    h.advance();
    await h.engine.tick('demo');
    const t = (await h.tasks())[0];
    expect(t.status).toBe('completed');
    expect(t.steps.filter((s) => s.status === 'disabled')).toHaveLength(4);
  });
  it('内容耗尽不发送空文本、不提前推进游标；循环开启返回首条', async () => {
    for (const loop of [false, true]) {
      const h = await harness();
      await h.repo.saveConfig({ ...(await h.repo.db.get('configs', 'demo'))!, selfReply: false });
      const l = (await h.repo.libraries('demo'))[0];
      await h.repo.saveLibraries('demo', [{ ...l, loop, items: [l.items[0]] }]);
      await h.start();
      h.advance();
      await h.engine.tick('demo');
      h.advance();
      await h.engine.tick('demo');
      expect((await h.attempts()).length).toBe(loop ? 2 : 1);
      expect((await h.run())?.status).toBe(loop ? 'running' : 'blocked');
    }
  });
  it('运行期间修改库不能改变当前内容，旧版本游标仍可正确提交', async () => {
    const h = await harness();
    await h.start();
    const old = (await h.repo.libraries('demo'))[0];
    await h.repo.saveLibraries('demo', [{ ...old, items: [{ id: 'new', text: '新配置内容' }] }]);
    h.advance();
    await h.engine.tick('demo');
    const t = (await h.tasks())[0];
    expect(t.steps[0].text).toBe(old.items[0].text);
    expect((await h.repo.db.get('cursors', cursorId(old)))?.position).toBe(1);
    expect(await h.repo.db.get('cursors', cursorId({ ...old, version: 2 }))).toBeUndefined();
  });
  it('暂停不启动下一次发送，继续保留发送间隔', async () => {
    const h = await harness();
    await h.start();
    h.advance();
    await h.engine.tick('demo');
    await h.engine.control('demo', 'pause');
    h.advance();
    await h.engine.tick('demo');
    expect(await h.attempts()).toHaveLength(1);
    await h.engine.control('demo', 'resume');
    await h.engine.tick('demo');
    expect(await h.attempts()).toHaveLength(1);
    h.advance(30001);
    await h.engine.tick('demo');
    expect(await h.attempts()).toHaveLength(2);
  });
  it('紧急停止与准备动作竞态：停止后完成准备也不能提交', async () => {
    const h = await harness();
    await h.start();
    const prepare = h.adapter.prepare.bind(h.adapter);
    vi.spyOn(h.adapter, 'prepare').mockImplementation(async (...args) => {
      const p = await prepare(...args);
      await h.engine.control('demo', 'emergency');
      return p;
    });
    h.advance();
    await h.engine.tick('demo');
    expect(await h.attempts()).toHaveLength(0);
    expect(await h.repo.db.count('demoLedger')).toBe(0);
    expect((await h.run())?.status).toBe('stopped');
    expect((await h.tasks())[0].steps[0].status).toBe('stopped');
  });
  it('两个调度器和重复检查只能产生单队列、单次发送', async () => {
    const h = await harness();
    await h.start();
    const second = new Engine(h.repo, { demo: h.adapter, real: h.real }, h.clock);
    h.advance();
    await Promise.all([h.engine.tick('demo'), second.tick('demo'), h.engine.tick('demo')]);
    expect(await h.attempts()).toHaveLength(1);
    await second.tick('demo');
    expect(await h.attempts()).toHaveLength(1);
  });
});
describe('新主题、增量和持久化去重', () => {
  it('基线不会补发历史主题；旧帖上浮与重复列表不会入队', async () => {
    const h = await harness();
    const original = h.adapter.readThreadCandidates.bind(h.adapter);
    vi.spyOn(h.adapter, 'readThreadCandidates').mockImplementation(async (r) => {
      const scan = await original(r);
      return {
        ...scan,
        candidates: [
          scan.candidates.at(-1)!,
          scan.candidates.at(-1)!,
          { ...scan.candidates.at(-1)!, id: 'old-unseen', publishedAt: r.startedAt - 10000 },
        ],
      };
    });
    await h.start();
    h.advance();
    await h.engine.tick('demo');
    expect(await h.tasks()).toHaveLength(0);
  });
  it('不可靠时间只能只读展示，不能把发现时间当发布时间', async () => {
    const h = await harness();
    await h.start();
    const original = h.adapter.readThreadCandidates.bind(h.adapter);
    vi.spyOn(h.adapter, 'readThreadCandidates').mockImplementation(async (r) => {
      const scan = await original(r);
      return {
        ...scan,
        reliable: false,
        candidates: scan.candidates.map((c) => ({
          ...c,
          publishedAt: undefined,
          timeEvidence: 'relative' as const,
        })),
      };
    });
    h.advance();
    await h.engine.tick('demo');
    expect(await h.tasks()).toHaveLength(0);
    const threads = await h.repo.db.getAll('threads');
    expect(threads.some((t) => t.timeEvidence === 'relative' && !t.publishedAt)).toBe(true);
  });
  it('同一帖子重复发现不建重复任务，重启后去重仍存在', async () => {
    const h = await harness();
    await h.start();
    const original = h.adapter.readThreadCandidates.bind(h.adapter);
    vi.spyOn(h.adapter, 'readThreadCandidates').mockImplementation(async (r) => {
      const s = await original(r);
      return {
        ...s,
        candidates: [{ ...s.candidates[0], id: 'stable-thread', publishedAt: h.clock() }],
      };
    });
    h.advance();
    await h.engine.tick('demo');
    h.advance();
    await h.engine.tick('demo');
    const second = new Engine(h.repo, { demo: h.adapter, real: h.real }, h.clock);
    await second.recover();
    expect(
      (await h.repo.db.getAll('dedupe')).filter((d) => d.id.endsWith(':stable-thread')),
    ).toHaveLength(1);
    await second.tick('demo');
    expect((await h.tasks()).filter((t) => t.thread.id === 'stable-thread')).toHaveLength(1);
  });
  it('清理历史保留去重 tombstone', async () => {
    const h = await harness();
    await h.start();
    h.advance();
    await h.engine.tick('demo');
    await h.engine.control('demo', 'stop');
    await h.repo.clearHistory('demo');
    expect(await h.tasks()).toHaveLength(0);
    expect(await h.repo.db.count('dedupe')).toBe(1);
  });
  it('手动跳过会禁止后续阶段且保留去重', async () => {
    const h = await harness();
    await h.start();
    h.advance();
    await h.engine.tick('demo');
    const thread = (await h.repo.db.getAll('threads')).find((t) => t.taskId)!;
    await h.engine.skip('demo', thread.key);
    h.advance(30001);
    await h.engine.tick('demo');
    expect((await h.tasks())[0].status).toBe('skipped');
    expect(await h.attempts()).toHaveLength(1);
  });
});
describe('结果核实、异常、恢复和配额', () => {
  it('明确失败不推进游标、不自动重发', async () => {
    const h = await harness();
    await h.start();
    await h.engine.scenario('failure');
    h.advance();
    await h.engine.tick('demo');
    expect((await h.tasks())[0].steps[0].status).toBe('failed');
    expect(await h.repo.db.count('cursors')).toBe(0);
    h.advance();
    await h.engine.tick('demo');
    expect(await h.attempts()).toHaveLength(1);
  });
  it('发送后超时进入未知、占用额度，恢复核实成功不会重复推进', async () => {
    const h = await harness();
    await h.start();
    await h.engine.scenario('unknown');
    h.advance();
    await h.engine.tick('demo');
    const t = (await h.tasks())[0];
    expect(t.status).toBe('unknown');
    expect((await h.run())?.sendCount).toBe(1);
    expect(await h.repo.db.count('cursors')).toBe(0);
    h.advance();
    await h.engine.tick('demo');
    expect(await h.attempts()).toHaveLength(1);
    await expect(h.engine.control('demo', 'resume')).rejects.toThrow('核实');
    await h.engine.verify(t.id);
    const a = (await h.attempts())[0];
    await h.engine.settle(a, { kind: 'success', evidence: a.evidence! });
    expect((await h.repo.db.getAll('cursors'))[0].position).toBe(1);
    expect((await h.run())?.rootSuccess).toBe(1);
    expect((await h.run())?.unknownCount).toBe(0);
  });
  it('后台被回收后未完成发送变为未知，禁止因过期锁重发', async () => {
    const h = await harness();
    await h.start();
    await h.engine.scenario('unknown');
    h.advance();
    await h.engine.tick('demo');
    const t = (await h.tasks())[0];
    const a = (await h.attempts())[0];
    t.steps[0].status = 'verifying';
    t.status = 'verifying';
    a.status = 'submitted';
    await h.repo.db.put('tasks', t);
    await h.repo.db.put('attempts', a);
    const second = new Engine(h.repo, { demo: h.adapter, real: h.real }, h.clock);
    await second.recover();
    expect((await h.repo.db.get('tasks', t.id))?.status).toBe('unknown');
    h.advance();
    await second.tick('demo');
    expect(await h.attempts()).toHaveLength(1);
  });
  it.each(['captcha', 'account-change', 'tab-closed'] as const)(
    '%s 在发送之前阻断并保留进度',
    async (scenario) => {
      const h = await harness();
      await h.start();
      await h.engine.scenario(scenario);
      h.advance();
      await h.engine.tick('demo');
      expect((await h.run())?.status).toBe('blocked');
      expect(await h.attempts()).toHaveLength(0);
    },
  );
  it('追评目标作者不属于自己则暂停，不降级到一级评论', async () => {
    const h = await harness();
    await h.start();
    h.advance();
    await h.engine.tick('demo');
    await h.engine.scenario('target-mismatch');
    h.advance(30001);
    await h.engine.tick('demo');
    expect((await h.run())?.status).toBe('blocked');
    expect(await h.attempts()).toHaveLength(1);
  });
  it('本地存储失败先锁死发送，不能执行外部动作', async () => {
    const h = await harness();
    await h.start();
    h.advance();
    vi.spyOn(h.repo, 'atomic').mockRejectedValueOnce(
      new DOMException('QuotaExceeded', 'QuotaExceededError'),
    );
    await h.engine.tick('demo');
    expect(h.engine.storageFault).toContain('禁止新发送');
    expect(await h.repo.db.count('demoLedger')).toBe(0);
    await h.engine.tick('demo');
    expect(await h.attempts()).toHaveLength(0);
  });
  it('达到发送总上限包含追评，且不会自动重置', async () => {
    const h = await harness();
    await h.repo.saveConfig({ ...(await h.repo.db.get('configs', 'demo'))!, maxSends: 2 });
    await h.start();
    h.advance();
    await h.engine.tick('demo');
    h.advance(30001);
    await h.engine.tick('demo');
    h.advance(30001);
    await h.engine.tick('demo');
    expect(await h.attempts()).toHaveLength(2);
    expect((await h.run())?.status).toBe('completed');
    expect((await h.tasks())[0].steps[3].status).toBe('stopped');
  });
  it('停止后仍允许核实已提交内容，不声称撤回', async () => {
    const h = await harness();
    await h.start();
    await h.engine.scenario('unknown');
    h.advance();
    await h.engine.tick('demo');
    await h.engine.control('demo', 'emergency');
    const t = (await h.tasks())[0];
    await h.engine.verify(t.id);
    expect((await h.run())?.status).toBe('stopped');
    expect((await h.repo.db.get('tasks', t.id))?.steps[0].status).toBe('completed');
    expect((await h.repo.db.get('tasks', t.id))?.steps[1].status).toBe('stopped');
  });
  it('未知结果不会通过新运行绕过去重或额度，明确重试才可重新准备', async () => {
    const h = await harness();
    await h.start();
    await h.engine.scenario('unknown');
    h.advance();
    await h.engine.tick('demo');
    const t = (await h.tasks())[0];
    await expect(h.engine.retry(t.id, false)).rejects.toThrow();
    await h.engine.retry(t.id, true);
    expect((await h.run())?.sendCount).toBe(1);
    expect((await h.repo.db.get('tasks', t.id))?.steps[0].status).toBe('queued');
  });
  it('睡眠后单次唤醒不会集中补发；系统时钟回退阻断', async () => {
    const h = await harness();
    await h.start();
    h.advance(12 * 3600000);
    await h.engine.tick('demo');
    expect(await h.attempts()).toHaveLength(1);
    h.advance(-13 * 3600000);
    await h.engine.tick('demo');
    expect((await h.run())?.status).toBe('blocked');
    expect(await h.attempts()).toHaveLength(1);
  });
  it('真实适配拒绝跨模式发送，演示游标不污染真实库', async () => {
    const h = await harness();
    expect(h.real.canSend).toBe(true);
    await expect(
      h.real.submit({ mode: 'demo' } as any, { config: { realAction: 'read' } } as any),
    ).rejects.toThrow('真实发送范围不符');
    await h.start();
    h.advance();
    await h.engine.tick('demo');
    expect((await h.repo.db.getAll('cursors')).every((c) => c.id.startsWith('demo:'))).toBe(true);
    expect((await h.repo.libraries('real')).every((l) => !l.items.length)).toBe(true);
  });
});
