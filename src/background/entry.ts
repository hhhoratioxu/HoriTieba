import { configureToolbar, registerToolbar } from './toolbar';
import { ForumComments, forumSender } from './forum-comments';
import { forumCommand } from '../shared/forum-comments';
import { ThreadReplies, threadSender } from './thread-replies';
import { threadCommand } from '../shared/thread-reply';
import { Repository } from '../storage/database';
import { DemoAdapter } from '../adapters/demo/adapter';
import { TiebaAdapter } from '../adapters/tieba/adapter';
import { WorkTabs } from './work-tabs';
import { Engine } from './queue/engine';
import { Service } from './message-router/service';
import { requestSchema, trustedUiSender, type Response } from '../shared/messages';
import { schedule, alarmName } from './scheduler/alarms';
import { permitSchema } from '../shared/page-messages';
import { respondToMessage } from '../shared/message-response';
const tabs = new WorkTabs();
const ready = Repository.open().then(async (repo) => {
  const engine = new Engine(repo, {
    demo: new DemoAdapter(repo),
    real: new TiebaAdapter(tabs, repo),
  });
  await engine.recover();
  return {
    repo,
    engine,
    threadReplies: new ThreadReplies(repo),
    forumComments: new ForumComments(repo, engine, tabs),
    service: new Service(repo, engine, tabs),
  };
});
const legacyNeeded = async () => {
  const { repo } = await ready;
  const r = await repo.current('real');
  return (
    !!r &&
    r.forumTabId === undefined &&
    (!['completed', 'stopped'].includes(r.status) || r.unknownCount > 0)
  );
};
registerToolbar(legacyNeeded);
const broadcast = () => chrome.runtime.sendMessage({ type: 'STATE_CHANGED' }).catch(() => {});
const pending = new Map<string, Promise<Response>>();
chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (raw?.type === 'HORITIEBA_LEGACY_STATUS') {
    if (
      !trustedUiSender(sender, chrome.runtime.id, chrome.runtime.getURL('')) ||
      new URL(sender.url!).pathname !== '/popup.html'
    )
      return false;
    return respondToMessage(
      legacyNeeded()
        .then((needed) => ({ needed }))
        .catch(() => ({ needed: false })),
      sendResponse,
    );
  }
  if (raw?.type === 'HORITIEBA_FORUM') {
    const parsed = forumCommand.safeParse(raw);
    if (!parsed.success || !forumSender(sender, parsed.data.forum, chrome.runtime.id)) return false;
    const result = ready
      .then(async ({ forumComments, engine, repo }) => {
        const cmd = parsed.data;
        const data = await forumComments.handle(cmd, sender.tab!.id!);
        if (cmd.op !== 'state') {
          await schedule(repo);
          if (cmd.op === 'start' && data?.status === 'running')
            void engine
              .tick('real')
              .finally(async () => {
                await schedule(repo);
                await forumComments.notify();
              })
              .catch(() => {});
        }
        return { ok: true, data };
      })
      .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : '贴吧操作失败' }));
    return respondToMessage(result, sendResponse);
  }
  if (raw?.type === 'HORITIEBA_THREAD_REPLY') {
    const parsed = threadCommand.safeParse(raw);
    if (!parsed.success || !threadSender(sender, parsed.data.thread, chrome.runtime.id))
      return false;
    const result = ready
      .then(async ({ threadReplies }) =>
        threadReplies.handle(
          parsed.data,
          sender.tab!.id!,
          parsed.data.op === 'start'
            ? (await chrome.storage.local.get('executionTab')).executionTab
            : undefined,
        ),
      )
      .then(
        (data) => ({ ok: true, data }),
        (e) => ({ ok: false, error: e instanceof Error ? e.message : '本帖操作失败' }),
      );
    return respondToMessage(result, sendResponse);
  }
  if (raw?.type === 'HORITIEBA_PERMIT') {
    const request = permitSchema.safeParse(raw);
    if (!request.success || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab)
      return false;
    const result = ready
      .then(async ({ repo }) => ({
        allowed: await tabs.permit(repo, sender, request.data.attemptId, request.data.token),
      }))
      .catch(() => ({ allowed: false }));
    return respondToMessage(result, sendResponse);
  }
  if (!trustedUiSender(sender, chrome.runtime.id, chrome.runtime.getURL(''))) return false;
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    sendResponse({ requestId: raw?.requestId ?? '', ok: false, error: '消息格式不合法' });
    return false;
  }
  const req = parsed.data;
  if (new URL(sender.url!).pathname !== `/${req.context}.html`) {
    sendResponse({ requestId: req.requestId, ok: false, error: '发送上下文不匹配' });
    return false;
  }
  let operation = pending.get(req.requestId);
  if (!operation) {
    operation = (async () => {
      try {
        const { service, repo } = await ready;
        const data = await service.handle(req);
        if (req.type !== 'STATE' && req.type !== 'DETAIL' && req.type !== 'EXPORT') {
          await schedule(repo);
          broadcast();
        }
        return { requestId: req.requestId, ok: true as const, data };
      } catch (e) {
        return {
          requestId: req.requestId,
          ok: false as const,
          error: e instanceof Error ? e.message : '操作失败',
        };
      }
    })();
    pending.set(req.requestId, operation);
    operation.finally(() => pending.delete(req.requestId));
  }
  return respondToMessage(operation, sendResponse);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === alarmName)
    void ready
      .then(async ({ engine, repo, forumComments }) => {
        await engine.tick('demo');
        await engine.tick('real');
        await schedule(repo);
        await forumComments.notify();
        broadcast();
      })
      .catch(() => broadcast());
});
const leavePage = (tab?: number, url?: string) =>
  ready
    .then(async ({ forumComments, threadReplies, repo }) => {
      const [, stopped] = await Promise.all([
        threadReplies.leave(tab, url),
        forumComments.leave(tab, url),
      ]);
      if (tab === undefined || stopped) await schedule(repo);
    })
    .catch(() => {});
chrome.tabs.onRemoved.addListener((tab) => {
  void leavePage(tab);
});
chrome.tabs.onUpdated.addListener((tab, change) => {
  if (!change.url) return;
  void configureToolbar(tab, change.url);
  void leavePage(tab, change.url);
  if (change.url.startsWith('https://tieba.baidu.com/'))
    void chrome.tabs
      .sendMessage(
        tab,
        {
          type: 'HORITIEBA_LOCATION_CHANGED',
          context: 'background',
          requestId: crypto.randomUUID(),
        },
        { frameId: 0 },
      )
      .catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  void leavePage();
});
chrome.runtime.onInstalled.addListener(() => {
  void ready.then(async ({ repo }) => {
    await schedule(repo);
  });
});
void ready.then(({ repo }) => schedule(repo));
