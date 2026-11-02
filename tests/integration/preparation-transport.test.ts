import { expect, it, vi } from 'vitest';
import { WorkTabs } from '../../src/background/work-tabs';
import type { Attempt, Run, Step, Target } from '../../src/domain/models';

it('准备消息无响应会撤销该次准备并允许有界恢复，迟到回执绝不生成发送许可', async () => {
  vi.useFakeTimers();
  const previous = globalThis.chrome;
  const account = { id: 'tb.fixture.own', label: 'fixture', confirmed: true };
  const target: Target = {
    threadId: '900',
    rootId: '902',
    commentId: '902',
    authorId: account.id,
    relation: 'self-root',
    pageUrl: 'https://tieba.baidu.com/p/900',
  };
  const run = { id: 'r', epoch: 1, config: { forum: '测试' } } as Run;
  const step = { id: 's', stage: 'reply1' } as Step;
  let documentToken = crypto.randomUUID(),
    active = false;
  let late!: () => void;
  const messages: { type: string; requestId: string; operationId?: string }[] = [];
  const ticket = crypto.randomUUID();
  const tabs = new WorkTabs();
  (globalThis as any).chrome = {
    storage: { local: { get: async () => ({ executionTab: 12 }) } },
    tabs: {
      get: async () => ({ id: 12, url: target.pageUrl, active }),
      update: async (_id: number, options: { active: boolean }) => {
        active = options.active;
      },
      reload: async () => {
        documentToken = crypto.randomUUID();
      },
      sendMessage: async (_id: number, req: any) => {
        messages.push(req);
        const reply = (data: unknown) => ({ requestId: req.requestId, ok: true, data });
        if (req.type === 'HORITIEBA_INSPECT')
          return reply({
            draft: false,
            documentToken,
            page: {
              threadId: '900',
              forum: '测试',
              account,
              comments: [],
              title: 'fixture',
              pageUrl: target.pageUrl,
              rootEditorReady: true,
              invalidComments: 0,
            },
          });
        if (req.type === 'HORITIEBA_CANCEL') return reply({ cancelled: true });
        if (req.type !== 'HORITIEBA_PREPARE') throw Error('unexpected ' + req.type);
        expect(req.documentToken).toBe(documentToken);
        if (active) return reply({ account, target, beforeIds: ['902'], token: ticket });
        return new Promise((resolve) => {
          late = () =>
            resolve(reply({ account, target, beforeIds: ['902'], token: crypto.randomUUID() }));
        });
      },
    },
  };
  try {
    const failure = expect(tabs.prepare(target, run, step)).rejects.toMatchObject({
      name: 'PageNotReadyError',
      message: expect.stringContaining('编辑器'),
    });
    await vi.advanceTimersByTimeAsync(20000);
    await failure;
    const pending = messages.find((m) => m.type === 'HORITIEBA_PREPARE')!;
    expect(messages.filter((m) => m.type === 'HORITIEBA_CANCEL').map((m) => m.operationId)).toEqual(
      [pending.requestId],
    );
    late();
    await vi.advanceTimersByTimeAsync(0);
    await expect(tabs.submit({ stepId: step.id, runId: run.id } as Attempt)).rejects.toThrow(
      '准备已丢失',
    );
    const ready = tabs.prepare(target, run, { ...step, preparationRetries: 1 });
    await vi.advanceTimersByTimeAsync(1500);
    expect((await ready).token).toBe(ticket);
    expect(active).toBe(true);
    expect(messages.some((m) => m.type === 'HORITIEBA_SUBMIT')).toBe(false);
  } finally {
    (globalThis as any).chrome = previous;
    vi.useRealTimers();
  }
});
