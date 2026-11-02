import type { Repository } from '../storage/database';
import {
  matchesReply,
  replyInterval,
  threadRunKey,
  type ThreadCommand,
  type ThreadReplyRun,
} from '../shared/thread-reply';
import { threadId } from '../shared/validation';
import { uid } from '../domain/models';

export function threadSender(
  sender: chrome.runtime.MessageSender,
  thread: string,
  extensionId: string,
) {
  return (
    sender.id === extensionId &&
    sender.frameId === 0 &&
    typeof sender.tab?.id === 'number' &&
    !!sender.url &&
    threadId(sender.url) === thread &&
    (!sender.tab.url || threadId(sender.tab.url) === thread)
  );
}
export class ThreadReplies {
  constructor(
    private repo: Repository,
    private now = () => Date.now(),
  ) {}
  async leave(tab?: number, url?: string) {
    return this.repo.atomic(async (tx) => {
      const meta = tx.objectStore('meta');
      const r = (await meta.get(threadRunKey))?.value as ThreadReplyRun | undefined;
      if (!r || (tab !== undefined && r.tab !== tab) || (url && threadId(url) === r.thread)) return;
      r.running = false;
      r.reason = r.pending
        ? '已停止，有一次发送待核实，原评论不会重发。'
        : '已离开帖子，自动回复已停止。';
      await meta.put({ id: threadRunKey, value: r });
    });
  }
  async handle(cmd: ThreadCommand, tab: number) {
    return this.repo.atomic(async (tx) => {
      const meta = tx.objectStore('meta');
      let r = (await meta.get(threadRunKey))?.value as ThreadReplyRun | undefined;
      const here = r?.tab === tab && r?.thread === cmd.thread;
      const save = async (run: ThreadReplyRun) => {
        await meta.put({ id: threadRunKey, value: run });
        return run;
      };
      const now = this.now();
      if (cmd.op === 'state') return here ? r : null;
      if (cmd.op === 'start') {
        if (r?.running || (here && r?.pending))
          throw Error('请先停止正在运行的任务，或核实刚才的回复。');
        const oldId = (await meta.get('active:real'))?.value as string | undefined;
        const advanced = oldId ? await tx.objectStore('runs').get(oldId) : undefined;
        if (
          advanced?.config.realAction === 'auto' &&
          !['completed', 'stopped'].includes(advanced.status)
        )
          throw Error('请先在控制台停止原来的自动追评任务。');
        const last = Number((await meta.get('thread-reply:last:' + cmd.account))?.value ?? 0);
        return save({
          id: uid(),
          tab,
          thread: cmd.thread,
          account: cmd.account,
          text: cmd.text,
          running: true,
          sent: 0,
          nextAt: last + replyInterval,
          reason: '',
        });
      }
      if (!r || !here || r.id !== cmd.run) throw Error('本次任务已结束或不属于这个标签页。');
      const key = (id: string) =>
        'thread-reply:comment:' + r!.account + ':' + cmd.thread + ':' + id;
      if (cmd.op === 'stop' || cmd.op === 'pause') {
        r.running = false;
        r.reason =
          cmd.op === 'pause' ? cmd.reason : r.pending ? '已停止，刚才的回复仍需核实。' : '已停止';
        return save(r);
      }
      if (cmd.op === 'skip') {
        if (r.running || !r.pending) throw Error('没有可跳过的未核实回复。');
        delete r.pending;
        r.reason = '已跳过未核实的一条，原评论不会重发。';
        return save(r);
      }
      if (cmd.op === 'verified') {
        if (r.pending?.id !== cmd.attempt || !matchesReply(r, cmd.evidence, now))
          throw Error('回复的独立编号、账号、目标或原文不一致。');
        await meta.put({
          id: key(r.pending.target.id),
          value: {
            attempt: cmd.attempt,
            root: r.pending.target.rootId,
            selected: r.pending.target.id,
            reply: cmd.evidence.id,
            at: now,
          },
        });
        r.sent++;
        delete r.pending;
        if (!r.running) r.reason = '已停止，上一次回复已核实。';
        return save(r);
      }
      if (!r.running) throw Error('任务已停止。');
      if (cmd.op === 'recover') {
        const scope = cmd.page + ':' + r.sent;
        if (r.pending || r.preparationReload === scope) return false;
        r.preparationReload = scope;
        await save(r);
        return true;
      }
      if (cmd.op === 'refresh') {
        if (r.pending?.id !== cmd.attempt || r.pending.refreshed)
          throw Error('本次只读刷新已使用。');
        r.pending.refreshed = true;
        return save(r);
      }
      if (cmd.op === 'seen') {
        const records = await Promise.all(cmd.ids.map((id) => meta.getKey(key(id))));
        return cmd.ids.filter((_, i) => records[i] !== undefined);
      }
      if (
        r.pending ||
        r.nextAt > now ||
        cmd.account !== r.account ||
        cmd.target.author === r.account
      )
        throw Error('发送间隔、账号或任务状态已改变。');
      const stamp = key(cmd.target.id);
      if (await meta.getKey(stamp)) throw Error('这条评论已经处理过。');
      const id = uid();
      r.pending = { id, target: cmd.target, before: cmd.before, at: now, document: cmd.document };
      r.nextAt = now + replyInterval;
      await meta.add({ id: stamp, value: { attempt: id, at: now, status: 'pending' } });
      await meta.put({ id: 'thread-reply:last:' + r.account, value: now });
      return save(r);
    });
  }
}
