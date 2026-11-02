import { it, expect, vi } from 'vitest';
import { harness } from '../helpers';
import { forumSender } from '../../src/background/forum-comments';
import { forumCommand, forumFromUrl } from '../../src/shared/forum-comments';
import { consumeSlot, reserveSlot, releaseSlot } from '../../src/background/send-slot';
import { ThreadReplies } from '../../src/background/thread-replies';
import { TiebaAdapter } from '../../src/adapters/tieba/adapter';
import type { WorkTabs } from '../../src/background/work-tabs';
import type { Account, Candidate } from '../../src/domain/models';
const account: Account = { id: 'tb.fixture.owner', label: '合成账号', confirmed: true };
const entry = (id: string, created: number): Candidate => ({
  id,
  title: '主题' + id,
  author: '合成作者',
  url: 'https://tieba.baidu.com/p/' + id,
  publishedAt: created,
  timeEvidence: 'verified',
  kind: 'thread',
  source: 'fixture',
});
it('只能从指定贴吧的顶层内容脚本启动，网页不能添加额外发送配置', () => {
  const url = 'https://tieba.baidu.com/f?kw=' + encodeURIComponent('测试');
  const sender = {
    id: 'ours',
    frameId: 0,
    url,
    tab: { id: 12, url },
  } as chrome.runtime.MessageSender;
  expect(forumSender(sender, '测试', 'ours')).toBe(true);
  expect(forumFromUrl('https://tieba.baidu.com/p/900')).toBeNull();
  for (const change of [
    { id: 'else' },
    { frameId: 2 },
    { url: 'https://other.test/f?kw=测试' },
    { tab: { id: 12, url: 'https://tieba.baidu.com/f?kw=其他' } },
  ])
    expect(
      forumSender({ ...sender, ...change } as chrome.runtime.MessageSender, '测试', 'ours'),
    ).toBe(false);
  const request = {
    type: 'HORITIEBA_FORUM',
    op: 'start',
    forum: '测试',
    account: account.id,
    text: '测试',
  };
  expect(forumCommand.safeParse(request).success).toBe(true);
  expect(forumCommand.safeParse({ ...request, text: '   ' }).success).toBe(false);
  expect(forumCommand.safeParse({ ...request, selfReply: true }).success).toBe(false);
});
it('页面运行使用独立固定文字，不继承旧筛选和库，跨过旧三帖上限也只创建首评', async () => {
  const h = await harness();
  const saved = (await h.repo.db.get('configs', 'real'))!,
    old = await h.repo.libraries('real');
  await h.repo.saveConfig({ ...saved, include: ['旧筛选'] });
  const r = await h.engine.start('real', undefined, {
    tabId: 12,
    forum: '测试',
    text: '固定文字',
    account,
  });
  const batch = (items: Candidate[]) => ({
    forum: '测试',
    account,
    reliable: true,
    coverage: 'fixture',
    candidates: items,
  });
  await h.engine.scan(r, batch([entry('10', h.clock() - 500000)]));
  h.advance(65000);
  const sample = [
    entry('10', h.clock()),
    entry('11', r.startedAt - 10000),
    ...['21', '22', '23', '24', '25'].map((id) => entry(id, h.clock() - 1000)),
  ];
  await h.engine.scan(r, batch(sample));
  h.advance(65000);
  await h.engine.scan(r, batch(sample));
  const tasks = await h.repo.db.getAllFromIndex('tasks', 'runId', r.id);
  expect(tasks).toHaveLength(5);
  expect(
    tasks.every(
      (t) =>
        t.steps
          .filter((s) => s.status === 'queued')
          .map((s) => s.stage)
          .join() === 'root',
    ),
  ).toBe(true);
  expect(r.libraries.find((l) => l.enabled)).toMatchObject({
    loop: true,
    items: [{ text: '固定文字' }],
  });
  expect(await h.repo.libraries('real')).toEqual(old);
  expect((await h.repo.db.get('configs', 'real'))?.include).toEqual(['旧筛选']);
  await expect(h.engine.control('real', 'stop', crypto.randomUUID())).rejects.toThrow('任务已切换');
  expect((await h.repo.current('real'))?.status).toBe('running');
});
it('同一账号的评论与回复共享发送间隔和有界预留，不同账号互不抢占', async () => {
  const h = await harness(),
    who = account.id!;
  const act = <T>(fn: (tx: import('../../src/storage/database').Transaction) => Promise<T>) =>
    h.repo.atomic(fn);
  expect(await act((tx) => reserveSlot(tx, who, 'reply', h.clock()))).toBe(0);
  expect(await act((tx) => consumeSlot(tx, who, 'forum', h.clock()))).toBe(false);
  expect(await act((tx) => consumeSlot(tx, 'tb.fixture.second', 'forum', h.clock()))).toBe(true);
  await act((tx) => releaseSlot(tx, who, 'reply'));
  expect(await act((tx) => consumeSlot(tx, who, 'forum', h.clock()))).toBe(true);
  h.advance(29999);
  expect(await act((tx) => consumeSlot(tx, who, 'reply', h.clock()))).toBe(false);
  h.advance(1);
  expect(await act((tx) => consumeSlot(tx, who, 'reply', h.clock()))).toBe(true);
});
it('已滑出列表的新主题继续核实，初始基线与其他批次的候选不回填', async () => {
  const h = await harness(),
    r = await h.engine.start('real', undefined, {
      forum: '测试',
      tabId: 22,
      text: '本地',
      account,
    });
  const candidate = {
    ...entry('88', h.clock()),
    timeCheckPending: true,
    runId: r.id,
    mode: 'real' as const,
    forum: '测试',
    firstSeen: h.clock(),
    decision: '待核实',
    key: 'real:测试:88',
  };
  await h.repo.db.put('threads', candidate);
  await h.repo.db.put('threads', { ...candidate, id: '77', key: 'real:测试:77', runId: 'other' });
  const thread = vi.fn(async () => ({
    page: { forum: '测试', threadId: '88', account, publishedAt: h.clock() },
  }));
  const scan = vi.fn(async () => ({
    forum: '测试',
    account,
    candidates: [],
    reliable: true,
    coverage: 'fixture',
  }));
  const adapter = new TiebaAdapter({ scan, thread } as unknown as WorkTabs, h.repo);
  const result = await adapter.readThreadCandidates({ ...r, baseline: true });
  expect(result.candidates.map((c) => c.id)).toEqual(['88']);
  expect(result.candidates[0].timeEvidence).toBe('verified');
  expect(thread).toHaveBeenCalledTimes(1);
  expect(scan).toHaveBeenCalledWith('测试', true, true, 22);
});
it('正常帖子可以和贴吧监控并行，专用执行标签页拒绝再启动回复', async () => {
  const h = await harness();
  await h.engine.start('real', undefined, { tabId: 21, forum: '测试', text: '独立评论', account });
  const service = new ThreadReplies(h.repo, h.clock);
  const start = {
    type: 'HORITIEBA_THREAD_REPLY',
    op: 'start',
    document: crypto.randomUUID(),
    thread: '800',
    account: account.id!,
    text: '独立回复',
  } as const;
  await expect(service.handle(start, 9, 9)).rejects.toThrow('工作页');
  const own = await service.handle(start, 10, 9);
  expect(own).toMatchObject({ running: true, tab: 10 });
});
