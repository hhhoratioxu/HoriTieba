import { installThreadReplies } from './thread-replies';
import { readThreadCandidates, hasDraft, useLegacyPage } from '../adapters/tieba/read-page';
import { legacyList, legacyThread } from '../adapters/tieba/legacy';
import { PageNotReadyError } from '../adapters/platform';
import { PageDriver } from '../adapters/tieba/page-driver';
import { pageRequestSchema } from '../shared/page-messages';
import { sameExtensionOrigin } from '../shared/extension-origin';
import { respondToMessage } from '../shared/message-response';
// Changes only with this isolated script's document, not with DOM updates.
const documentToken = crypto.randomUUID();
const driver = new PageDriver(
  document,
  () => location.href,
  async (attemptId, token) => {
    const result = await chrome.runtime.sendMessage({ type: 'HORITIEBA_PERMIT', attemptId, token });
    return result?.allowed === true;
  },
);
let activeDocument = true;
addEventListener('pagehide', () => {
  activeDocument = false;
  driver.cancel();
});
addEventListener('pageshow', () => {
  activeDocument = true;
});
// Isolated script: no page postMessage bridge, cookies or page globals.
chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  if (!activeDocument) return false;
  const promiseResponse = chrome.runtime.getURL('').startsWith('safari-web-extension://');
  const reply = (value: unknown) => {
    if (promiseResponse) return Promise.resolve(value);
    respond(value);
    return false;
  };
  const parsed = pageRequestSchema.safeParse(raw);
  if (
    sender.id !== chrome.runtime.id ||
    window.top !== window ||
    !sameExtensionOrigin(sender.url, chrome.runtime.getURL(''))
  ) {
    if (parsed.success)
      return reply({
        requestId: parsed.data.requestId,
        ok: false,
        error: `页面拒绝后台来源：${sender.id !== chrome.runtime.id ? '扩展标识不一致' : window.top !== window ? '非顶层页面' : !sender.url ? '浏览器未提供来源地址' : '来源地址与扩展不一致'}；来源标识${sender.origin ? '存在' : '缺失'}`,
      });
    return false;
  }
  if (!parsed.success) {
    return reply({
      requestId: typeof raw?.requestId === 'string' ? raw.requestId : '',
      ok: false,
      error: `页面消息格式不合法：${parsed.error.issues.map((issue) => `${issue.path.join('.')}:${issue.code}`).join('；')}`,
    });
  }
  const r = parsed.data;
  const operation = async () => {
    if ('documentToken' in r && r.documentToken !== documentToken)
      throw new PageNotReadyError('执行页已换成新文档');
    switch (r.type) {
      case 'HORITIEBA_CANCEL':
        driver.cancel(r.operationId);
        return { cancelled: true };
      case 'HORITIEBA_SUBMIT_STATE':
        return driver.submissionState(r.attemptId);
      case 'HORITIEBA_READ':
        return {
          documentToken,
          draft: hasDraft(document),
          scan: document.querySelector('#thread_list')
            ? legacyList(document, location.href)
            : readThreadCandidates(document, location.href),
        };
      case 'HORITIEBA_LEGACY': {
        return useLegacyPage(document);
      }
      case 'HORITIEBA_INSPECT':
        return {
          documentToken,
          draft: hasDraft(document),
          page: legacyThread(document, location.href),
        };
      case 'HORITIEBA_EXPAND':
        await driver.expand(r.rootId, r.requestId, r.expiresAt);
        return { draft: hasDraft(document), page: legacyThread(document, location.href) };
      case 'HORITIEBA_PREPARE':
        return driver.prepare(r.target, r.forum, r.requestId, r.expiresAt);
      case 'HORITIEBA_SUBMIT':
        return driver.submit(r.attemptId, r.token, r.target, r.text);
    }
  };
  const result = operation().then(
    (data) => ({ requestId: r.requestId, ok: true, data }),
    (e) => ({
      requestId: r.requestId,
      ok: false,
      error: e instanceof Error ? e.message : '页面操作失败',
      ...(e instanceof PageNotReadyError ? { code: 'page-not-ready' } : {}),
    }),
  );
  return respondToMessage(result, respond);
});

installThreadReplies(documentToken);
