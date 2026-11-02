import { describe, it, expect } from 'vitest';
import {
  normalizeForum,
  threadId,
  parseTxt,
  parseBundle,
  configSchema,
} from '../../src/shared/validation';
import { defaultConfig, stages, uid } from '../../src/domain/models';
import { filterThread, validEvidence, assertPrepared } from '../../src/domain/policies';
import { trustedUiSender, requestSchema } from '../../src/shared/messages';
describe('导入与输入边界', () => {
  it('规范化贴吧名与链接，并拒绝外域、凭据和不支持链接', () => {
    expect(normalizeForum(' 摄影 ')).toBe('摄影');
    expect(normalizeForum('https://tieba.baidu.com/f?kw=%E6%91%84%E5%BD%B1&tab=503')).toBe('摄影');
    for (const x of [
      'https://evil.com/f?kw=摄影',
      'https://tieba.baidu.com.evil.com/f?kw=x',
      'https://a:pass@tieba.baidu.com/f?kw=x',
      'https://tieba.baidu.com/p/123',
      'javascript:alert(1)',
      'http://tieba.baidu.com/f?kw=x',
      '',
    ])
      expect(() => normalizeForum(x)).toThrow();
  });
  it('只接受真实域名的数字主题链接', () => {
    expect(threadId('/p/123?fr=frs')).toBe('123');
    expect(threadId('https://evil.com/p/123')).toBeNull();
    expect(threadId('https://tieba.baidu.com/p/x')).toBeNull();
  });
  it('TXT 处理 BOM、换行、空行、边界空格，保留重复和表情', async () => {
    const x = await parseTxt('\uFEFF  你好！🙂 \r\n\r\n重复\n重复\r第二条');
    expect(x.items).toEqual(['你好！🙂', '重复', '重复', '第二条']);
    expect(x.duplicates).toBe(1);
    expect(x.blank).toBe(1);
  });
  it('TXT 报告超长条目并分批进度', async () => {
    const progress: number[] = [];
    const x = await parseTxt('x'.repeat(2001) + '\n正常', (n) => progress.push(n));
    expect(x.tooLong).toBe(1);
    expect(x.items).toEqual(['正常']);
    expect(progress.at(-1)).toBe(100);
  });
  it('JSON 校验版本、数量、类型和未知字段；不会执行 HTML', () => {
    const bundle = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      config: defaultConfig('demo'),
      libraries: stages.map((stage) => ({
        id: stage,
        mode: 'demo',
        stage,
        enabled: true,
        loop: false,
        version: 1,
        items: [{ id: uid(), text: '<img src=x onerror=alert(1)>\n保留换行' }],
      })),
    };
    const result = parseBundle(JSON.stringify(bundle), 'real');
    expect(result.libraries[0].items[0].text).toContain('\n');
    expect(result.libraries.every((l) => l.mode === 'real')).toBe(true);
    expect(() => parseBundle(JSON.stringify({ ...bundle, schemaVersion: 2 }), 'demo')).toThrow();
    expect(() =>
      parseBundle(
        JSON.stringify({ ...bundle, config: { ...bundle.config, unsafe: '<script>' } }),
        'demo',
      ),
    ).toThrow();
    expect(() =>
      parseBundle(JSON.stringify({ ...bundle, libraries: bundle.libraries.slice(1) }), 'demo'),
    ).toThrow();
    expect(() =>
      parseBundle(
        JSON.stringify({ ...bundle, libraries: Array(5).fill(bundle.libraries[0]) }),
        'demo',
      ),
    ).toThrow();
  });
  it('配置限制所有数量和节奏；不能开放上一条回复模式', () => {
    expect(() => configSchema.parse({ ...defaultConfig('demo'), sendSeconds: 0 })).toThrow();
    expect(() => configSchema.parse({ ...defaultConfig('demo'), replyMode: 'previous' })).toThrow();
  });
});
describe('业务校验与通信', () => {
  const candidate = {
    id: '1',
    title: '摄影 入门',
    author: '甲',
    url: '',
    publishedAt: 1,
    timeEvidence: 'verified' as const,
    kind: 'thread' as const,
    source: 'fixture',
  };
  it('任意与全部包含规则和作者排除符合界面语义', () => {
    const c = { ...defaultConfig('demo'), include: ['摄影', '旅行'] };
    expect(filterThread(candidate, c)).toBeNull();
    expect(filterThread(candidate, { ...c, match: 'all' })).toBeTruthy();
    expect(filterThread(candidate, { ...c, exclude: ['入门'] })).toBeTruthy();
    expect(filterThread(candidate, { ...c, authors: ['甲'] })).toBeTruthy();
    expect(filterThread({ ...candidate, kind: 'pinned' }, c)).toBeTruthy();
  });
  it('消息限制扩展来源、页面路径、顶层 frame 和运行时类型', () => {
    const root = 'chrome-extension://abc/';
    expect(
      trustedUiSender({ id: 'abc', url: root + 'dashboard.html', frameId: 0 }, 'abc', root),
    ).toBe(true);
    expect(
      trustedUiSender({ id: 'abc', url: 'https://tieba.baidu.com/', frameId: 0 }, 'abc', root),
    ).toBe(false);
    expect(
      trustedUiSender({ id: 'abc', url: root + 'dashboard.html', frameId: 2 }, 'abc', root),
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        type: 'CONTROL',
        mode: 'demo',
        context: 'page',
        requestId: uid(),
        payload: { action: 'start' },
      }).success,
    ).toBe(false);
  });
  it('Safari 来源主机大小写不影响身份校验，伪装主机和非界面路径仍被拒绝', () => {
    const root = 'safari-web-extension://A0B1C2D3-0000-4000-8000-000000000001/';
    const sender = { id: 'safari.test', url: root.toLowerCase() + 'dashboard.html', frameId: 0 };
    expect(trustedUiSender(sender, 'safari.test', root)).toBe(true);
    for (const patch of [
      { id: 'another.extension' },
      { frameId: 1 },
      { url: root + 'background.js' },
      { url: root.replace(/\/$/, '.evil/') + 'dashboard.html' },
      { url: root.replace('://', '://credential@') + 'dashboard.html' },
    ])
      expect(trustedUiSender({ ...sender, ...patch }, 'safari.test', root)).toBe(false);
  });
  it('相同文字、旧 ID、错误目标、错误作者、时间异常不能作为成功证据', () => {
    const a = {
      accountId: 'own',
      text: '内容',
      intendedAt: 10000,
      beforeIds: ['old'],
      stage: 'reply1',
      target: { threadId: '1', rootId: 'r', commentId: 'r' },
    } as any;
    const e = {
      commentId: 'new',
      authorId: 'own',
      threadId: '1',
      rootId: 'r',
      targetId: 'r',
      text: '内容',
      createdAt: 11000,
      observedAt: 12000,
    };
    expect(validEvidence(a, e as any)).toBe(true);
    for (const patch of [
      { commentId: 'old' },
      { authorId: 'other' },
      { targetId: 'other' },
      { rootId: 'x' },
      { createdAt: 1 },
      { text: '不同' },
    ])
      expect(validEvidence(a, { ...e, ...patch } as any)).toBe(false);
  });
  it('首评和追评编辑器必须保持语义差异', () => {
    const task = { account: { id: 'own' }, thread: { id: '1' }, root: { rootId: 'r' } } as any;
    const prepared = {
      account: { id: 'own', confirmed: true },
      target: {
        threadId: '1',
        authorId: 'own',
        rootId: 'r',
        commentId: 'r',
        relation: 'self-root',
      },
      beforeIds: [],
    } as any;
    expect(() => assertPrepared(task, 'reply1', prepared)).not.toThrow();
    expect(() => assertPrepared(task, 'root', prepared)).toThrow();
    expect(() =>
      assertPrepared(task, 'reply1', {
        ...prepared,
        target: { ...prepared.target, authorId: 'other' },
      }),
    ).toThrow();
  });
});
