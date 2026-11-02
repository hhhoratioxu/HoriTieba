const hint = document.querySelector<HTMLElement>('#hint')!;
const openTieba = document.querySelector<HTMLAnchorElement>('#open')!;

async function focusCurrentPage() {
  if (!globalThis.chrome?.runtime?.id) return;
  const old = await chrome.runtime.sendMessage({ type: 'HORITIEBA_LEGACY_STATUS' });
  if (old?.needed) {
    document.querySelector<HTMLAnchorElement>('#legacy')!.hidden = false;
    openTieba.hidden = true;
    hint.textContent = '上个版本有未结束的任务。';
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url || new URL(tab.url).origin !== 'https://tieba.baidu.com')
    return;
  openTieba.hidden = true;
  const requestId = crypto.randomUUID();
  const response = await chrome.tabs.sendMessage(
    tab.id,
    { type: 'HORITIEBA_FOCUS', context: 'background', requestId },
    { frameId: 0 },
  );
  if (response?.requestId === requestId && response.ok && response.data?.focused) {
    window.close();
    return;
  }
  hint.textContent = '打开要操作的贴吧页面，在页面底部输入内容。';
}
void focusCurrentPage().catch(() => {
  hint.textContent = '请刷新贴吧页面，在底部输入内容。';
});
