import type { Run } from '../domain/models';
import type { Repository } from '../storage/database';
import type { WorkTabs } from './work-tabs';
import type { Engine } from './queue/engine';
import { forumFromUrl, type ForumCommand, type ForumState } from '../shared/forum-comments';
import { threadRunKey, type ThreadReplyRun } from '../shared/thread-reply';

export function forumSender(
  sender: chrome.runtime.MessageSender,
  forum: string,
  extensionId: string,
) {
  return (
    sender.id === extensionId &&
    sender.frameId === 0 &&
    typeof sender.tab?.id === 'number' &&
    forumFromUrl(sender.url) === forum &&
    (!sender.tab.url || forumFromUrl(sender.tab.url) === forum)
  );
}
function view(r: Run | undefined, tab: number, forum: string): ForumState | null {
  if (!r || r.forumTabId === undefined || r.config.forum !== forum) return null;
  const own = r.forumTabId === tab,
    terminal = r.status === 'stopped' || r.status === 'completed';
  if (!own && terminal && !r.unknownCount) return null;
  const elsewhere = !own && !terminal;
  return {
    id: r.id,
    status: elsewhere ? 'elsewhere' : r.status,
    sent: r.rootSuccess,
    unknown: r.unknownCount > 0,
    text: elsewhere ? '' : (r.libraries.find((l) => l.stage === 'root')?.items[0]?.text ?? ''),
    reason: elsewhere ? '已在另一个标签页运行' : (r.reason ?? ''),
  };
}
export class ForumComments {
  constructor(
    private repo: Repository,
    private engine: Engine,
    private tabs: WorkTabs,
  ) {}
  async leave(tab?: number, url?: string) {
    const r = await this.repo.current('real');
    if (
      !r ||
      r.forumTabId === undefined ||
      ['stopped', 'completed'].includes(r.status) ||
      (tab !== undefined && r.forumTabId !== tab) ||
      (url && forumFromUrl(url) === r.config.forum)
    )
      return;
    await this.engine.control('real', 'stop', r.id);
    return true;
  }
  async handle(cmd: ForumCommand, tab: number) {
    const prior = await this.repo.current('real');
    if (cmd.op === 'state') return view(prior, tab, cmd.forum);
    if (cmd.op === 'start') {
      if (prior && !['stopped', 'completed'].includes(prior.status))
        throw Error(
          prior.forumTabId === undefined
            ? '旧版控制台有未结束的任务，可从工具栏图标管理。'
            : '请先在原贴吧列表页停止自动评论。',
        );
      const { scan, draft } = await this.tabs.forumPage(tab, cmd.forum);
      if (draft) throw Error('贴吧页面有草稿，请先处理。');
      if (scan.blocking?.includes('安全验证')) throw Error(scan.blocking);
      if (!scan.account.confirmed || scan.account.id !== cmd.account)
        throw Error('登录账号已改变，请刷新贴吧。');
      const run = await this.engine.start('real', undefined, {
        tabId: tab,
        forum: cmd.forum,
        text: cmd.text,
        account: scan.account,
      });
      const owner = await chrome.tabs.get(tab).catch(() => null);
      if (forumFromUrl(owner?.url) !== cmd.forum) {
        await this.engine.control('real', 'stop', run.id);
        throw Error('已离开这个贴吧，自动评论已停止。');
      }
      const { executionTab } = await chrome.storage.local.get('executionTab');
      if (typeof executionTab === 'number') {
        const execution = await chrome.tabs.get(executionTab).catch(() => null);
        const thread = (await this.repo.db.get('meta', threadRunKey))?.value as
          ThreadReplyRun | undefined;
        if (
          !execution?.url?.startsWith('https://tieba.baidu.com/p/') ||
          ((thread?.running || thread?.pending) && thread.tab === executionTab)
        )
          await chrome.storage.local.remove('executionTab');
      }
      const params = new URL(owner!.url!).searchParams;
      if (
        scan.reliable &&
        !scan.blocking &&
        Number(params.get('pn') || 0) === 0 &&
        !['tab', 'cid', 'good', 'see_lz'].some((k) => params.has(k))
      )
        await this.engine.scan(run, scan);
    } else {
      if (
        prior?.id !== cmd.run ||
        prior.forumTabId === undefined ||
        prior.config.forum !== cmd.forum
      )
        throw Error('这个任务已经结束。');
      const terminal = prior.status === 'stopped' || prior.status === 'completed';
      if (prior.forumTabId !== tab && !(cmd.op === 'verify' && terminal))
        throw Error('请在启动任务的标签页操作。');
      if (cmd.op === 'verify') {
        const tasks = await this.repo.db.getAllFromIndex('tasks', 'runId', prior.id);
        const unknown = tasks.find((t) => t.steps.some((s) => s.status === 'unknown'));
        if (!unknown) throw Error('没有待核实的评论。');
        await this.engine.verify(unknown.id);
      } else await this.engine.control('real', cmd.op === 'resume' ? 'resume' : 'stop', prior.id);
    }
    return view(await this.repo.current('real'), tab, cmd.forum);
  }
  async notify() {
    const r = await this.repo.current('real');
    if (r?.forumTabId === undefined) return;
    await chrome.tabs
      .sendMessage(
        r.forumTabId,
        { type: 'HORITIEBA_FORUM_CHANGED', context: 'background', requestId: crypto.randomUUID() },
        { frameId: 0 },
      )
      .catch(() => {});
  }
}
