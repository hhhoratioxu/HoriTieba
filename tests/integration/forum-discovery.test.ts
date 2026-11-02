import { expect, it, vi, afterEach } from 'vitest';
import { harness } from '../helpers';
import type { Candidate, Scan } from '../../src/domain/models';
import { TiebaAdapter } from '../../src/adapters/tieba/adapter';
import { listCreationWindow } from '../../src/adapters/tieba/creation-hint';
import {
  BlockedError,
  PageNotReadyError,
  ThreadUnavailableError,
} from '../../src/adapters/platform';
import type { WorkTabs } from '../../src/background/work-tabs';
const ts = (s: string) => Date.parse('2026-11-02T' + s + '+08:00');
const who = { id: 'tb.fixture.own', label: 'fixture', confirmed: true };
const card = (id: string, label?: string): Candidate => ({
  id,
  title: '合成主题',
  url: 'https://tieba.baidu.com/p/' + id,
  kind: 'thread',
  author: '合成作者',
  timeLabel: label,
  timeEvidence: 'unavailable',
  timeCheckPending: true,
  source: 'fixture',
});
afterEach(() => vi.restoreAllMocks());
async function fixture(inspect: (id: string) => Promise<number | undefined>) {
  const h = await harness();
  vi.spyOn(Date, 'now').mockReturnValue(ts('22:20:33'));
  const initial = await h.engine.start('real', undefined, {
    forum: '测试',
    tabId: 12,
    text: '本地台账',
    account: who,
  });
  const run = { ...initial, startedAt: ts('22:12:49') };
  await h.repo.db.put('runs', run);
  let visible: Candidate[] = [];
  const scan = async (): Promise<Scan> => ({
    candidates: structuredClone(visible),
    forum: '测试',
    account: who,
    reliable: true,
    coverage: 'fixture',
  });
  const thread = vi.fn(async (url: string) => {
    const id = new URL(url).pathname.split('/').pop()!;
    return {
      draft: false,
      page: { threadId: id, forum: '测试', account: who, publishedAt: await inspect(id) },
    };
  });
  const adapter = new TiebaAdapter({ scan, thread } as unknown as WorkTabs, h.repo);
  await h.engine.scan(run, await scan());
  return {
    ...h,
    thread,
    run,
    apply: async (items: Candidate[]) => {
      visible = items;
      const result = await adapter.readThreadCandidates({ ...run, baseline: true });
      h.advance();
      await h.engine.scan({ ...run, baseline: true }, result);
      return result;
    },
  };
}
it('被顶旧帖排在前面时仍先检查新帖，前一篇已删除也能在同一轮给后一篇入队', async () => {
  const h = await fixture(async (id) => {
    if (id === '701') throw new ThreadUnavailableError();
    return ts('22:18:00');
  });
  const older = Array.from({ length: 19 }, (_, i) =>
    card(String(400 + i), i % 2 ? '18:43' : '11-1'),
  );
  await h.apply([...older, card('701', '22:20'), card('702', '22:18')]);
  expect(h.thread.mock.calls).toEqual([
    ['https://tieba.baidu.com/p/701', true],
    ['https://tieba.baidu.com/p/702', true],
  ]);
  expect((await h.tasks()).map((t) => t.thread.id)).toEqual(['702']);
  const db = h.repo.db;
  expect(await db.get('threads', 'real:测试:400')).toMatchObject({
    creationCheck: { kind: 'old' },
    timeCheckPending: false,
  });
  expect(await db.get('threads', 'real:测试:701')).toMatchObject({
    creationCheck: { kind: 'removed' },
    timeCheckPending: false,
  });
  expect(await h.repo.current('real')).toMatchObject({
    status: 'running',
    readFailures: 0,
    pendingTimeCount: 0,
  });
  await h.apply([card('701', '22:20'), card('702', '22:18')]);
  expect(h.thread).toHaveBeenCalledTimes(2);
});
it('主题加载失败和缺少楼主时间分别退避，重载列表不提前重试，滑出列表也不会遗失', async () => {
  const calls = new Map<string, number>();
  const h = await fixture(async (id) => {
    const n = (calls.get(id) ?? 0) + 1;
    calls.set(id, n);
    if (id === '701' && n < 3) throw new PageNotReadyError();
    if (id === '702' && n === 1) return;
    return ts('22:18:00');
  });
  await h.apply([card('701', '22:16'), card('702', '22:18')]);
  expect(await h.repo.current('real')).toMatchObject({
    status: 'running',
    pendingTimeCount: 2,
    readFailures: 0,
  });
  await h.apply([card('701', '22:16'), card('703', '22:19')]);
  expect(calls.get('701')).toBe(1);
  expect((await h.tasks()).map((x) => x.thread.id)).toEqual(['703']);
  vi.mocked(Date.now).mockReturnValue(ts('22:21:05'));
  await h.apply([]);
  expect(await h.repo.db.get('threads', 'real:测试:701')).toMatchObject({
    creationCheck: { kind: 'later', attempts: 2, after: ts('22:22:05') },
  });
  expect((await h.tasks()).map((x) => x.thread.id).sort()).toEqual(['702', '703']);
  vi.mocked(Date.now).mockReturnValue(ts('22:22:06'));
  await h.apply([]);
  expect(await h.repo.current('real')).toMatchObject({ pendingTimeCount: 0, matched: 3 });
});
it('列表时间只作初筛，实际一楼早于启动或与启动分钟重叠都不建任务', async () => {
  const h = await fixture(async (id) => (id === '701' ? ts('22:12:00') : ts('20:02:00')));
  await h.apply([card('701', '22:18'), card('702', '22:19')]);
  expect(await h.tasks()).toHaveLength(0);
  expect((await h.repo.db.get('threads', 'real:测试:701'))?.decision).toContain('重叠');
  expect((await h.repo.db.get('threads', 'real:测试:702'))?.decision).toContain('历史');
});
it('安全验证仍阻断整轮，不继续查下一篇或发送', async () => {
  const h = await fixture(async () => {
    throw new BlockedError('页面安全验证');
  });
  await h.apply([card('701', '22:18'), card('702', '22:19')]);
  expect(h.thread).toHaveBeenCalledTimes(1);
  expect(await h.repo.current('real')).toMatchObject({
    status: 'blocked',
    sendCount: 0,
    reason: '页面安全验证',
  });
});
it('只解释观测时北京时间的创建标签，日历、跨午夜、未来和相对时间保守处理', () => {
  const at = ts('22:20:33');
  expect(listCreationWindow('22:18', at)).toEqual({ start: ts('22:18:00'), end: ts('22:19:00') });
  expect(listCreationWindow('11-1', at)?.end).toBe(ts('00:00:00'));
  expect(listCreationWindow('2024-02-29', at)?.start).toBe(Date.parse('2024-02-29T00:00:00+08:00'));
  for (const label of [
    '昨天',
    '刚刚',
    '24:00',
    '22:60',
    '11-31',
    '13-1',
    '2025-02-29',
    '22:23',
    '12-31',
  ])
    expect(listCreationWindow(label, at)).toBeUndefined();
  expect(listCreationWindow('23:59', ts('00:00:02'))).toBeUndefined();
});
