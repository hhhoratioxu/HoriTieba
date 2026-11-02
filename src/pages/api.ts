import type { Mode } from '../domain/models';
import type { Response } from '../shared/messages';
export const surface = location.pathname.includes('sidepanel')
  ? 'sidepanel'
  : location.pathname.includes('popup')
    ? 'popup'
    : 'dashboard';
export async function send<T = unknown>(mode: Mode, type: string, payload?: unknown): Promise<T> {
  if (!globalThis.chrome?.runtime?.id)
    throw Error('请在浏览器扩展中打开控制台。成品无需启动开发服务。');
  const requestId = crypto.randomUUID();
  const response: Response<T> = await chrome.runtime.sendMessage({
    requestId,
    context: surface,
    mode,
    type,
    ...(payload === undefined ? {} : { payload }),
  });
  if (!response || response.requestId !== requestId)
    throw Error('后台没有返回有效响应，请重新打开控制台');
  if (!response.ok) throw Error(response.error);
  return response.data;
}
export function download(name: string, value: unknown) {
  const blob = new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], {
    type: typeof value === 'string' ? 'text/plain;charset=utf-8' : 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
