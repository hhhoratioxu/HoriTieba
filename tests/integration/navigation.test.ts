import { expect, it, vi } from 'vitest';
import { WorkTabs } from '../../src/background/work-tabs';
import type { Attempt } from '../../src/domain/models';

function delayedNavigation(freshAfter: number, missingToken = false, noReceiver = false) {
  const previous = globalThis.chrome;
  let reloads = 0;
  let readsAfterReload = 0;
  const page = {
    threadId: '900',
    forum: '测试',
    account: { id: 'tb.fixture.own', label: 'fixture', confirmed: true },
    comments: [],
    title: '刷新前',
    pageUrl: 'https://tieba.baidu.com/p/900',
    rootEditorReady: true,
    invalidComments: 0,
  };
  const messages: string[] = [];
  const a = { stage: 'root', target: { threadId: '900' }, accountId: 'tb.fixture.own' } as Attempt;
  (globalThis as any).chrome = {
    storage: { local: { get: async () => ({ executionTab: 10 }) } },
    tabs: {
      get: async () => ({ id: 10, url: page.pageUrl }),
      reload: async () => {
        reloads++;
      },
      sendMessage: async (_id: number, request: any) => {
        messages.push(request.type);
        const fresh = reloads > 0 && ++readsAfterReload > freshAfter;
        if (reloads > 0 && noReceiver && !fresh)
          throw Error('Could not establish connection. Receiving end does not exist.');
        return {
          requestId: request.requestId,
          ok: true,
          data: {
            draft: false,
            documentToken: missingToken
              ? undefined
              : fresh
                ? '00000000-0000-4000-8000-000000000002'
                : '00000000-0000-4000-8000-000000000001',
            page: { ...page, title: fresh ? '刷新后' : page.title },
          },
        };
      },
    },
  };
  return {
    read: () => new WorkTabs().observation(a, true),
    messages,
    reloads: () => reloads,
    restore: () => {
      (globalThis as any).chrome = previous;
    },
  };
}

it('浏览器已接受 reload 但旧文档仍可响应时，等待新文档后才使用快照', async () => {
  vi.useFakeTimers();
  const h = delayedNavigation(2);
  try {
    const result = h.read();
    await vi.advanceTimersByTimeAsync(1600);
    expect((await result).title).toBe('刷新后');
    expect(h.messages.every((type) => type === 'HORITIEBA_INSPECT')).toBe(true);
  } finally {
    h.restore();
    vi.useRealTimers();
  }
});

it('后台更新而工作页仍为旧脚本时明确提示，不刷新潜在草稿或继续发送', async () => {
  const h = delayedNavigation(0, true);
  try {
    await expect(h.read()).rejects.toThrow('旧版扩展脚本');
    expect(h.reloads()).toBe(0);
    expect(h.messages).toEqual(['HORITIEBA_INSPECT']);
  } finally {
    h.restore();
  }
});

it('真实页面主体出现后内容脚本延迟六秒才注入，等待新接收者且不重复刷新或切换', async () => {
  vi.useFakeTimers();
  const h = delayedNavigation(12, false, true);
  try {
    const result = h.read();
    await vi.advanceTimersByTimeAsync(6600);
    expect((await result).title).toBe('刷新后');
    expect(h.reloads()).toBe(1);
    expect(h.messages.every((type) => type === 'HORITIEBA_INSPECT')).toBe(true);
  } finally {
    h.restore();
    vi.useRealTimers();
  }
});

it('导航始终停在旧文档时有界停止，不把旧快照当作刷新成功或发送任何内容', async () => {
  vi.useFakeTimers();
  const h = delayedNavigation(Infinity);
  try {
    const rejected = expect(h.read()).rejects.toThrow('仍是旧页面');
    await vi.advanceTimersByTimeAsync(20500);
    await rejected;
    expect(h.messages.every((type) => type === 'HORITIEBA_INSPECT')).toBe(true);
  } finally {
    h.restore();
    vi.useRealTimers();
  }
});
