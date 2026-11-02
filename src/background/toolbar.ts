import { forumFromUrl } from '../shared/forum-comments';
import { forumUrl, threadId } from '../shared/validation';
import { safePageUrl } from '../adapters/tieba/legacy';

function actionPage(url?: string) {
  if (!url) return null;
  const forum = forumFromUrl(url);
  if (forum) return forumUrl(forum);
  const thread = threadId(url);
  return thread ? safePageUrl(url, thread) : null;
}
export function configureToolbar(tabId: number, url: string) {
  if (typeof chrome.action?.setPopup !== 'function') return Promise.resolve();
  // A browser popup retains keyboard focus while open. On supported pages use the action directly.
  return chrome.action
    .setPopup({ tabId, popup: actionPage(url) ? '' : 'popup.html' })
    .catch(() => {});
}
export function registerToolbar(legacyNeeded: () => Promise<boolean>) {
  if (!chrome.action?.onClicked) return;
  chrome.action.onClicked.addListener((tab) => {
    void (async () => {
      if (await legacyNeeded()) {
        await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
        return;
      }
      const safe = actionPage(tab.url);
      if (tab.id === undefined || !safe) {
        await chrome.tabs.create({ url: 'https://tieba.baidu.com/' });
        return;
      }
      await chrome.tabs.update(tab.id, { active: true });
      const requestId = crypto.randomUUID();
      const res = await chrome.tabs
        .sendMessage(
          tab.id,
          { type: 'HORITIEBA_FOCUS', context: 'background', requestId },
          { frameId: 0 },
        )
        .catch(() => null);
      // A tab left open across an extension update may still contain the previous script.
      if (res?.requestId !== requestId || !res.ok || !res.data?.focused)
        await chrome.tabs.create({ url: safe });
    })().catch(() => {});
  });
  void chrome.tabs
    .query({ url: 'https://tieba.baidu.com/*' })
    .then((tabs) =>
      Promise.all(
        tabs.filter((t) => t.id !== undefined && t.url).map((t) => configureToolbar(t.id!, t.url!)),
      ),
    )
    .catch(() => {});
}
