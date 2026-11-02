import { it, expect, vi } from 'vitest';
import { respondToMessage } from '../../src/shared/message-response';
it('Safari 后台许可返回 Promise，Chrome 120 使用回调且保留异步通道', async () => {
  const prior = globalThis.chrome;
  try {
    for (const scheme of ['safari-web-extension', 'chrome-extension']) {
      (globalThis as any).chrome = { runtime: { getURL: () => `${scheme}://fixture/` } };
      const callback = vi.fn();
      const response = Promise.resolve({ allowed: false });
      const result = respondToMessage(response, callback);
      if (scheme === 'safari-web-extension') {
        expect(await result).toEqual({ allowed: false });
        expect(callback).not.toHaveBeenCalled();
      } else {
        expect(result).toBe(true);
        await response;
        expect(callback).toHaveBeenCalledExactlyOnceWith({ allowed: false });
      }
    }
  } finally {
    (globalThis as any).chrome = prior;
  }
});
