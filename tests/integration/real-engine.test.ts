import { it, expect, vi } from 'vitest';
import { harness } from '../helpers';
import { Engine } from '../../src/background/queue/engine';
import { PageNotReadyError } from '../../src/adapters/platform';
import { WorkTabs } from '../../src/background/work-tabs';
import type { Candidate, Attempt } from '../../src/domain/models';
async function setup() {
  const h = await harness();
  let candidates: Candidate[] = [];
  const account = { id: 'tb.fixture.own', label: 'fixture', confirmed: true };
  const adapter = {
    canSend: true,
    detectSession: async () => account,
    readThreadCandidates: async () => ({
      forum: '测试',
      account,
      candidates,
      reliable: true,
      coverage: 'fixture',
    }),
    prepare: async () => {
      throw Error('test stops before sending');
    },
    submit: async () => {},
    verifySubmission: async () => ({ kind: 'unknown' as const, reason: 'fixture' }),
    cancel() {},
  };
  const engine = new Engine(h.repo, { demo: h.adapter, real: adapter }, h.clock);
  const config = (await h.repo.db.get('configs', 'real'))!;
  await h.repo.saveConfig({ ...config, forum: '测试', realAction: 'auto' });
  await h.repo.saveLibraries(
    'real',
    (await h.repo.libraries('real')).map((l) => ({ ...l, items: [{ id: 'test', text: 'test' }] })),
  );
  const start = async () => {
    const c = (await h.repo.db.get('configs', 'real'))!;
    const libs = await h.repo.libraries('real');
    return engine.start('real', {
      configVersion: c.version,
      libraryVersions: libs.map((l) => l.version),
      accountId: account.id,
    });
  };
  const candidate = (id: string, at?: number): Candidate => ({
    id,
    title: '主题',
    author: '合成',
    url: `https://tieba.baidu.com/p/${id}`,
    kind: 'thread',
    timeEvidence: at === undefined ? 'unavailable' : 'verified',
    timeCheckPending: at === undefined,
    publishedAt: at,
    timePrecisionMs: 60000,
    source: 'fixture',
  });
  return {
    ...h,
    realAdapter: adapter,
    engine,
    start,
    candidate,
    set: (v: Candidate[]) => (candidates = v),
    run: () => h.repo.current('real'),
  };
}
it('真实自动启动必须绑定预检摘要账号，不能接受切换后的账号', async () => {
  const h = await setup();
  await expect(h.engine.start('real')).rejects.toThrow('摘要账号');
  await h.start();
  expect((await h.run())?.account.id).toBe('tb.fixture.own');
});

it('真实提交响应丢失后自动只读核实，成功只推进一次且原批次保持暂停', async () => {
  const h = await setup();
  const account = { id: 'tb.fixture.own', label: 'fixture', confirmed: true };
  const target = {
    threadId: '900',
    rootId: '',
    commentId: '',
    authorId: account.id,
    relation: 'root' as const,
  };
  h.realAdapter.prepare = (async () => ({ target, account, beforeIds: [] })) as never;
  const submit = vi.spyOn(h.realAdapter, 'submit').mockRejectedValue(Error('工作页面响应超时'));
  const cancel = vi.spyOn(h.realAdapter, 'cancel');
  const verify = vi
    .spyOn(h.realAdapter, 'verifySubmission')
    .mockImplementation(async (...args: unknown[]) => {
      const a = args[0] as Attempt;
      return {
        kind: 'success',
        evidence: {
          threadId: '900',
          commentId: '902',
          rootId: '902',
          targetId: null,
          authorId: account.id,
          text: a.text,
          createdAt: h.clock(),
          observedAt: h.clock(),
          source: 'dom',
        },
      } as never;
    });
  await h.start();
  await h.engine.tick('real');
  h.advance(120000);
  h.set([h.candidate('900', h.clock())]);
  await h.engine.tick('real');
  expect(submit).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledTimes(1);
  const run = await h.run();
  expect(run).toMatchObject({ status: 'paused', sendCount: 1, rootSuccess: 1, unknownCount: 0 });
  const step = (await h.tasks())[0].steps[0];
  expect((await h.repo.db.get('cursors', step.cursorKey!))?.position).toBe(1);
  h.advance();
  await h.engine.tick('real');
  expect(submit).toHaveBeenCalledTimes(1);
});
it('新帖判定独立排除历史上浮、启动分钟重叠和未来时间', async () => {
  const h = await setup();
  const run = await h.start();
  await h.engine.tick('real');
  h.advance();
  h.set([
    h.candidate('1', run.startedAt - 120000),
    h.candidate('2', run.startedAt - 10000),
    h.candidate('3', h.clock() + 60000),
  ]);
  await h.engine.tick('real');
  expect(await h.tasks()).toHaveLength(0);
  const rows = await h.repo.db.getAll('threads');
  expect(rows.map((t) => t.decision)).toEqual([
    '历史主题上浮，不自动处理',
    '创建时间与启动分钟重叠，保守跳过',
    '创建时间晚于当前时间，禁止入队',
  ]);
});
it('延后核实时间的新增主题可入队一次，基线未知时间主题永远不会被补发', async () => {
  const h = await setup();
  const run = await h.start();
  h.set([h.candidate('1')]);
  await h.engine.tick('real');
  h.advance();
  h.set([h.candidate('1', run.startedAt + 30000), h.candidate('2')]);
  await h.engine.tick('real');
  expect(await h.tasks()).toHaveLength(0);
  h.advance();
  h.set([h.candidate('1', run.startedAt + 30000), h.candidate('2', run.startedAt + 60000)]);
  await h.engine.tick('real');
  expect(await h.tasks()).toHaveLength(1);
  expect((await h.tasks())[0].thread.id).toBe('2');
  expect((await h.repo.db.get('threads', 'real:测试:1'))?.decision).toBe('启动前基线，仅展示');
});
it('后台真实点击许可绑定当前标签、运行 epoch、步骤与持久化单次记录', async () => {
  const h = await setup();
  const run = await h.start();
  const target = {
    threadId: '900',
    rootId: '',
    commentId: '',
    authorId: 'tb.fixture.own',
    relation: 'root' as const,
  };
  const a = {
    id: crypto.randomUUID(),
    mode: 'real',
    runId: run.id,
    taskId: crypto.randomUUID(),
    stepId: crypto.randomUUID(),
    stage: 'root',
    accountId: 'tb.fixture.own',
    target,
    text: '测试',
    intendedAt: h.clock(),
    status: 'submitted',
    beforeIds: [],
  } as Attempt;
  await h.repo.db.put('attempts', a);
  await h.repo.db.put('tasks', {
    id: a.taskId,
    mode: 'real',
    runId: run.id,
    thread: h.candidate('900', h.clock()),
    account: run.account,
    configVersion: run.config.version,
    dedupeKey: 'real:test',
    status: 'verifying',
    createdAt: h.clock(),
    updatedAt: h.clock(),
    plannedAt: h.clock(),
    steps: [
      {
        id: a.stepId,
        stage: 'root',
        status: 'verifying',
        libraryVersion: 2,
        attemptId: a.id,
        text: a.text,
      },
    ],
  });
  const previous = globalThis.chrome;
  (globalThis as any).chrome = { runtime: { id: 'fixture-extension' } };
  try {
    const tabs = new WorkTabs(),
      token = crypto.randomUUID();
    const set = () => {
      (tabs as any).ticket = {
        token,
        tabId: 10,
        runId: run.id,
        stepId: a.stepId,
        epoch: run.epoch,
        target,
        used: false,
      };
    };
    const sender = {
      id: 'fixture-extension',
      frameId: 0,
      tab: { id: 10 },
      url: 'https://tieba.baidu.com/p/900',
      documentId: 'fixture-document',
    } as chrome.runtime.MessageSender;
    set();
    expect(await tabs.permit(h.repo, { ...sender, tab: { id: 99 } } as never, a.id, token)).toBe(
      false,
    );
    set();
    await h.repo.db.put('runs', { ...run, epoch: run.epoch + 1 });
    expect(await tabs.permit(h.repo, sender, a.id, token)).toBe(false);
    await h.repo.db.put('runs', run);
    set();
    expect(await tabs.permit(h.repo, sender, a.id, token)).toBe(true);
    expect(await tabs.permit(h.repo, sender, a.id, token)).toBe(false);
    set();
    expect(await tabs.permit(h.repo, sender, a.id, token)).toBe(false);
  } finally {
    (globalThis as any).chrome = previous;
  }
});
it('执行页关闭先报未知，后续只读核实可创建新页，任何草稿都会阻止核实刷新', async () => {
  const previous = globalThis.chrome;
  let stored: number | undefined = 10;
  let created = 0,
    reloaded = 0,
    draft = false;
  const page = {
    threadId: '900',
    forum: '测试',
    account: { id: 'tb.fixture.own', label: 'fixture', confirmed: true },
    comments: [],
    title: 'fixture',
    pageUrl: 'https://tieba.baidu.com/p/900',
    rootEditorReady: true,
    invalidComments: 0,
  };
  const a = { stage: 'root', target: { threadId: '900' }, accountId: 'tb.fixture.own' } as Attempt;
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async () => ({ executionTab: stored }),
        remove: async () => {
          stored = undefined;
        },
        set: async (v: any) => {
          stored = v.executionTab;
        },
      },
    },
    tabs: {
      get: async (id: number) => {
        if (id === 10) throw Error('closed');
        return { id, url: page.pageUrl };
      },
      create: async () => {
        created++;
        return { id: 11 };
      },
      sendMessage: async (_id: number, r: any) => ({
        requestId: r.requestId,
        ok: true,
        data: { draft, page, documentToken: '00000000-0000-4000-8000-000000000001' },
      }),
      reload: async () => {
        reloaded++;
      },
    },
  };
  try {
    const tabs = new WorkTabs();
    await expect(tabs.observation(a)).rejects.toThrow('结果未知');
    expect(created).toBe(0);
    expect(stored).toBeUndefined();
    expect((await tabs.observation(a)).threadId).toBe('900');
    expect(created).toBe(1);
    draft = true;
    await expect(tabs.observation(a, true)).rejects.toThrow('草稿');
    expect(reloaded).toBe(0);
  } finally {
    (globalThis as any).chrome = previous;
  }
});

it('发送前页面短暂未就绪可延期准备，不占额度或游标，后续只提交一次', async () => {
  const h = await setup();
  const account = { id: 'tb.fixture.own', label: 'fixture', confirmed: true };
  const target = {
    threadId: '900',
    rootId: '',
    commentId: '',
    authorId: account.id,
    relation: 'root' as const,
  };
  const prepare = vi
    .spyOn(h.realAdapter, 'prepare')
    .mockRejectedValueOnce(new PageNotReadyError('加载中'))
    .mockResolvedValue({ target, account, beforeIds: [] } as never);
  const submit = vi.spyOn(h.realAdapter, 'submit');
  await h.start();
  await h.engine.tick('real');
  h.advance(120000);
  h.set([h.candidate('900', h.clock())]);
  await h.engine.tick('real');
  expect(await h.run()).toMatchObject({ status: 'running', sendCount: 0, unknownCount: 0 });
  expect((await h.tasks())[0].steps[0]).toMatchObject({ status: 'waiting', preparationRetries: 1 });
  expect(await h.repo.db.getAll('attempts')).toHaveLength(0);
  expect(submit).not.toHaveBeenCalled();
  h.advance(120000);
  await h.engine.tick('real');
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(await h.run()).toMatchObject({ status: 'paused', sendCount: 1, unknownCount: 1 });
  h.advance(120000);
  await h.engine.tick('real');
  expect(submit).toHaveBeenCalledTimes(1);
});
it('页面准备最多自动重试两次，仍未就绪则阻断，始终没有发送尝试', async () => {
  const h = await setup();
  const prepare = vi
    .spyOn(h.realAdapter, 'prepare')
    .mockRejectedValue(new PageNotReadyError('加载中'));
  await h.start();
  await h.engine.tick('real');
  h.advance(120000);
  h.set([h.candidate('900', h.clock())]);
  for (let i = 0; i < 4; i++) {
    await h.engine.tick('real');
    h.advance(120000);
  }
  expect(prepare).toHaveBeenCalledTimes(3);
  expect(await h.run()).toMatchObject({ status: 'blocked', sendCount: 0, unknownCount: 0 });
  expect(await h.repo.db.getAll('attempts')).toHaveLength(0);
});
it('准备期间暂停优先于自动等待恢复，不自行恢复运行', async () => {
  const h = await setup();
  h.realAdapter.prepare = async () => {
    await h.engine.control('real', 'pause');
    throw new PageNotReadyError('加载中');
  };
  const submit = vi.spyOn(h.realAdapter, 'submit');
  await h.start();
  await h.engine.tick('real');
  h.advance(120000);
  h.set([h.candidate('900', h.clock())]);
  await h.engine.tick('real');
  h.advance(120000);
  await h.engine.tick('real');
  expect(await h.run()).toMatchObject({ status: 'paused', sendCount: 0 });
  expect(submit).not.toHaveBeenCalled();
});
