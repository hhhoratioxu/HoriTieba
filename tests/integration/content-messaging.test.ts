import { beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

let code: string;
beforeAll(async () => {
  const result = await build({
    entryPoints: ['src/content/entry.ts'],
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    write: false,
  });
  code = result.outputFiles[0].text;
});

const request = {
  requestId: '00000000-0000-4000-8000-000000000001',
  context: 'background',
  type: 'HORITIEBA_READ',
};

function harness(scheme = 'safari-web-extension') {
  const dom = new JSDOM(readFileSync('tests/fixtures/tieba-list.html', 'utf8'), {
    url: 'https://tieba.baidu.com/f?kw=示例',
    runScripts: 'outside-only',
  });
  let generatedCode = 0;
  Object.defineProperty(dom.window, 'Function', {
    value: function () {
      generatedCode++;
      throw Error('Content Security Policy blocks dynamic code');
    },
  });
  let listener: (
    raw: unknown,
    sender: unknown,
    respond: (response: any) => void,
  ) => boolean | Promise<unknown>;
  Object.defineProperty(dom.window, 'chrome', {
    value: {
      runtime: {
        id: 'local.test',
        getURL: (path: string) => `${scheme}://TEST-ORIGIN/${path}`,
        onMessage: { addListener: (value: typeof listener) => (listener = value) },
      },
    },
  });
  new Script(code).runInContext(dom.getInternalVMContext());
  return {
    showDeleted: () => {
      dom.reconfigure({ url: 'https://tieba.baidu.com/p/900' });
      dom.window.document.title = '贴吧404';
      dom.window.document.body.innerHTML = '<h1>很抱歉，该贴已被删除</h1>';
    },
    pagehide: () => dom.window.dispatchEvent(new dom.window.Event('pagehide')),
    pageshow: () => dom.window.dispatchEvent(new dom.window.Event('pageshow')),
    dispatch: () =>
      listener(
        request,
        { id: 'local.test', url: `${scheme}://TEST-ORIGIN/background.js` },
        () => {},
      ),
    async send(
      raw: typeof request & { expectedThread?: string; previousDocument?: string } = request,
      url = `${scheme}://TEST-ORIGIN/background.js`,
    ) {
      return new Promise<any>((resolve) => {
        const result = listener(raw, { id: 'local.test', url }, resolve);
        if (typeof result === 'object' && typeof result.then === 'function') result.then(resolve);
      });
    },
    generatedCode: () => generatedCode,
    close: () => dom.window.close(),
  };
}

it('生产内容脚本在禁止动态代码的隔离上下文中完成消息校验和只读响应', async () => {
  const h = harness();
  try {
    const response = await h.send();
    expect(response.requestId).toBe(request.requestId);
    expect(response.ok).toBe(true);
    expect(response.data.scan.candidates).toHaveLength(3);
    expect(h.generatedCode()).toBe(0);
  } finally {
    h.close();
  }
});

it('Chrome 120 的回调响应通道仍能正常读取页面', async () => {
  const h = harness('chrome-extension');
  try {
    const response = await h.send();
    expect(response.ok).toBe(true);
    expect(response.data.scan.candidates).toHaveLength(3);
  } finally {
    h.close();
  }
});

it('Safari 后台小写来源与 getURL 的大写主机仍绑定同一扩展', async () => {
  const h = harness();
  try {
    const response = await h.send(request, 'safari-web-extension://test-origin/background.js');
    expect(response.ok).toBe(true);
    expect(response.data.scan.candidates).toHaveLength(3);
    for (const url of [
      'safari-web-extension://test-origin.evil/background.js',
      'safari-web-extension://evil@TEST-ORIGIN/background.js',
      'safari-web-extension://TEST-ORIGIN:123/background.js',
      'https://TEST-ORIGIN/background.js',
    ]) {
      expect((await h.send(request, url)).ok).toBe(false);
    }
  } finally {
    h.close();
  }
});

it('内容脚本明确拒绝异常消息和非扩展来源，不启动页面操作', async () => {
  const h = harness();
  try {
    const invalid = await h.send({ ...request, requestId: 'invalid' });
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain('消息格式不合法');
    const foreign = await h.send(request, 'https://tieba.baidu.com/f?kw=示例');
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toContain('来源地址与扩展不一致');
    expect(h.generatedCode()).toBe(0);
  } finally {
    h.close();
  }
});

it('离开页面后旧文档不再响应，恢复显示后才重新提供只读结果', async () => {
  const h = harness();
  try {
    h.pagehide();
    expect(h.dispatch()).toBe(false);
    h.pageshow();
    expect((await h.send()).ok).toBe(true);
  } finally {
    h.close();
  }
});

it('旧删帖文档只能确认自己的帖号，导航途中收到旧页响应不可据此跳过新帖', async () => {
  const h = harness('chrome-extension');
  try {
    h.showDeleted();
    const inspect = { ...request, type: 'HORITIEBA_INSPECT', expectedThread: '900' };
    expect(await h.send(inspect)).toMatchObject({ ok: false, code: 'thread-unavailable' });
    expect(await h.send({ ...inspect, expectedThread: '901' })).toMatchObject({
      ok: false,
      code: 'page-not-ready',
    });
    const context = await h.send({ ...request, type: 'HORITIEBA_PAGE_CONTEXT' });
    expect(context).toMatchObject({ ok: true, data: { draft: false } });
    expect(
      await h.send({ ...inspect, previousDocument: context.data.documentToken }),
    ).toMatchObject({ ok: false, code: 'page-not-ready' });
  } finally {
    h.close();
  }
});
