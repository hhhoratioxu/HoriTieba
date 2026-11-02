import { expect, it } from 'vitest';
import { harness } from '../helpers';
import { ThreadReplies, threadSender } from '../../src/background/thread-replies';
import {
  replyInterval,
  threadRunKey,
  threadCommand,
  type ThreadReplyRun,
  type CommandBody,
  type ReplyEvidence,
} from '../../src/shared/thread-reply';
const doc = crypto.randomUUID(),
  tid = '900',
  account = 'tb.fixture.own',
  text = '这是我的回复。';
const target = { rootId: '902', id: '903', author: 'tb.fixture.other' };
async function setup() {
  const h = await harness(),
    svc = new ThreadReplies(h.repo, h.clock);
  const call = (body: CommandBody, tab = 1) =>
    svc.handle(
      threadCommand.parse({ type: 'HORITIEBA_THREAD_REPLY', thread: tid, document: doc, ...body }),
      tab,
    );
  const start = () => call({ op: 'start', account, text }) as Promise<ThreadReplyRun>;
  const run = await start();
  const permit = (id = '903', r = run) =>
    call({
      op: 'permit',
      run: r.id,
      target: { ...target, id },
      account,
      before: ['909'],
    }) as Promise<ThreadReplyRun>;
  const proof: ReplyEvidence = {
    id: '910',
    rootId: '902',
    author: account,
    recipient: target.author,
    text,
    createdAt: h.clock(),
  };
  return { ...h, svc, run, call, start, permit, proof };
}
it('同一个帖子仅一个启动标签；点击许可原子写入，楼中楼逐条去重', async () => {
  const h = await setup();
  await expect(h.call({ op: 'start', account, text }, 2)).rejects.toThrow();
  await expect(h.call({ op: 'seen', run: h.run.id, ids: ['903'] }, 2)).rejects.toThrow();
  const permits = await Promise.allSettled([h.permit(), h.permit()]);
  expect(permits.filter((p) => p.status === 'fulfilled')).toHaveLength(1);
  const r = (
    permits.find((p) => p.status === 'fulfilled') as PromiseFulfilledResult<ThreadReplyRun>
  ).value;
  for (const e of [
    { id: '909' },
    { recipient: null },
    { author: target.author },
    { text: '错误' },
    { rootId: '999' },
  ]) {
    await expect(
      h.call({ op: 'verified', run: r.id, attempt: r.pending!.id, evidence: { ...h.proof, ...e } }),
    ).rejects.toThrow();
  }
  const ok = (await h.call({
    op: 'verified',
    run: r.id,
    attempt: r.pending!.id,
    evidence: h.proof,
  })) as ThreadReplyRun;
  expect(ok.sent).toBe(1);
  await expect(h.permit('904')).rejects.toThrow();
  h.advance(replyInterval);
  await expect(h.permit()).rejects.toThrow();
  expect((await h.permit('904')).pending?.target.id).toBe('904');
});
it('关闭或切换标签停止；跳过未知结果后，新批次保留去重和间隔', async () => {
  const h = await setup();
  await h.permit();
  await h.svc.leave(1, 'https://tieba.baidu.com/p/900?pn=2');
  expect(((await h.call({ op: 'state' })) as ThreadReplyRun).running).toBe(true);
  await h.svc.leave(1, 'https://tieba.baidu.com/p/999');
  await expect(h.start()).rejects.toThrow();
  await h.call({ op: 'skip', run: h.run.id });
  const r = await h.start();
  expect(r.nextAt).toBe(h.clock() + replyInterval);
  expect(await h.call({ op: 'seen', run: r.id, ids: ['903', '904'] })).toEqual(['903']);
  h.advance();
  await expect(h.permit('903', r)).rejects.toThrow();
  await expect(
    h.call({
      op: 'permit',
      run: r.id,
      account,
      target: { ...target, author: account },
      before: [],
    }),
  ).rejects.toThrow();
});
it('隔离来源、顶层、帖子链接与扩展标识', () => {
  const sender = {
    id: 'ext',
    frameId: 0,
    tab: { id: 1, url: 'https://tieba.baidu.com/p/900' },
    url: 'https://tieba.baidu.com/p/900?pn=2',
  } as chrome.runtime.MessageSender;
  expect(threadSender(sender, tid, 'ext')).toBe(true);
  for (const delta of [
    { frameId: 1 },
    { id: 'other' },
    { url: 'https://evil.test/p/900' },
    { url: 'https://tieba.baidu.com/p/901' },
    { tab: { id: 1, url: 'https://tieba.baidu.com/f?kw=abc' } },
  ])
    expect(threadSender({ ...sender, ...delta } as chrome.runtime.MessageSender, tid, 'ext')).toBe(
      false,
    );
});
it('已停止的许可不可再发；旧文档最多申请一次核实刷新', async () => {
  const h = await setup(),
    p = await h.permit();
  await h.call({ op: 'refresh', run: p.id, attempt: p.pending!.id });
  await expect(h.call({ op: 'refresh', run: p.id, attempt: p.pending!.id })).rejects.toThrow();
  await h.call({ op: 'stop', run: p.id });
  const r = (await h.call({
    op: 'verified',
    run: p.id,
    attempt: p.pending!.id,
    evidence: h.proof,
  })) as ThreadReplyRun;
  expect([r.running, r.sent, r.pending]).toEqual([false, 1, undefined]);
  expect((await h.repo.db.get('meta', threadRunKey))?.value).toEqual(r);
});

it('发送前的慢页面最多自动刷新一次，已有发送意图不重新准备', async () => {
  const h = await setup();
  expect(await h.call({ op: 'recover', run: h.run.id, page: 2 })).toBe(true);
  expect(await h.call({ op: 'recover', run: h.run.id, page: 2 })).toBe(false);
  await h.permit();
  expect(await h.call({ op: 'recover', run: h.run.id, page: 1 })).toBe(false);
});
