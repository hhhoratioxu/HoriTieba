import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const profile = await mkdtemp(path.join(os.tmpdir(), 'horitieba-e2e-'));
await mkdir('artifacts/screenshots', { recursive: true });
const fixture = await readFile('tests/fixtures/tieba-list.html', 'utf8');
const results = [];
let ctx;
let page;
let extensionId;
const errors = [];
const launch = async () => {
  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'Asia/Taipei',
    args: [
      `--disable-extensions-except=${path.resolve('dist')}`,
      `--load-extension=${path.resolve('dist')}`,
    ],
  });
  await ctx.route('https://tieba.baidu.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }),
  );
  let worker = ctx.serviceWorkers()[0];
  if (!worker) worker = await ctx.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await page.getByRole('heading', { name: '把节奏，留给自己。' }).waitFor();
};
const rpc = (type, payload, mode = 'demo', target = page) =>
  target.evaluate(
    async ({ type, payload, mode }) => {
      const res = await chrome.runtime.sendMessage({
        type,
        payload,
        mode,
        context: 'dashboard',
        requestId: crypto.randomUUID(),
      });
      if (!res.ok) throw Error(res.error);
      return res.data;
    },
    { type, payload, mode },
  );
const snapshot = () =>
  rpc('STATE', { view: 'tasks', page: 0, query: '', author: '', status: '', stage: 'root' });
// Test-only clock acceleration is performed by the harness in the isolated browser profile.
// There is no corresponding production message or UI bypass.
const due = () =>
  page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const q = indexedDB.open('HoriTieba-v1');
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'runs'], 'readwrite');
      const q = tx.objectStore('meta').get('active:demo');
      q.onsuccess = () => {
        const r = tx.objectStore('runs').get(q.result.value);
        r.onsuccess = () => {
          tx.objectStore('runs').put({
            ...r.result,
            nextCheckAt: Date.now() - 1,
            nextSendAt: Date.now() - 1,
          });
        };
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
async function check(name, fn) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, status: 'passed', ms: Date.now() - start });
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push({ name, status: 'failed', error: e.message });
    throw e;
  }
}
try {
  await launch();
  await check('扩展真实加载，无本地服务器，控制台与 CSP 正常', async () => {
    assert.match(page.url(), /^chrome-extension:/);
    await page.screenshot({ path: 'artifacts/screenshots/dashboard-light.png', fullPage: true });
  });
  await check('内容库编辑保存；恶意 HTML 仅作为文本显示', async () => {
    await page.getByRole('button', { name: '内容库', exact: true }).click();
    await page.getByRole('button', { name: '新增内容', exact: true }).click();
    await page
      .getByPlaceholder('输入一条内容，保留标点、表情和有意义的换行…')
      .fill('<img src=x onerror="window.__attack=1">\n多段文字🙂');
    await page.getByRole('button', { name: '应用到编辑版本' }).click();
    await page.getByRole('button', { name: '保存内容库' }).click();
    await page.getByText('内容库已保存，新的版本从下次运行生效；当前运行快照不变。').waitFor();
    assert.equal(await page.evaluate(() => window.__attack), undefined);
    await page.screenshot({ path: 'artifacts/screenshots/libraries.png', fullPage: true });
  });
  await check('启动摘要、初始基线、自动首评及追评 1/3', async () => {
    await page.getByRole('button', { name: '总览', exact: true }).click();
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await page.getByRole('button', { name: '确认范围并启动' }).click();
    await page.getByText('监控运行中', { exact: false }).waitFor();
    let s = await snapshot();
    assert.equal(s.run.taskCount, 0);
    await due();
    await rpc('CONTROL', { action: 'check' });
    s = await snapshot();
    assert.equal(s.run.rootSuccess, 1);
    await due();
    await rpc('CONTROL', { action: 'check' });
    await due();
    await rpc('CONTROL', { action: 'check' });
    s = await snapshot();
    assert.equal(s.run.replySuccess, 2);
    assert(s.tasks.some((t) => t.status === 'completed'));
    await page.screenshot({ path: 'artifacts/screenshots/dashboard-running.png', fullPage: true });
  });
  await check('侧边栏关闭与多个管理页面共享唯一队列', async () => {
    const side = await ctx.newPage();
    await side.setViewportSize({ width: 390, height: 900 });
    await side.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await side.getByRole('button', { name: '打开完整控制台' }).waitFor();
    await side.screenshot({ path: 'artifacts/screenshots/sidepanel.png' });
    await side.close();
    const extra = await ctx.newPage();
    await extra.goto(`chrome-extension://${extensionId}/dashboard.html`);
    const before = (await snapshot()).run.sendCount;
    await Promise.all([
      rpc('CONTROL', { action: 'check' }),
      rpc('CONTROL', { action: 'check' }, 'demo', extra),
    ]);
    assert.equal((await snapshot()).run.sendCount, before);
    await extra.close();
  });
  await check('未知结果阻断；扩展浏览器重启后保留证据并先核实', async () => {
    await rpc('SCENARIO', 'unknown');
    await due();
    await rpc('CONTROL', { action: 'check' });
    let s = await snapshot();
    assert.equal(s.run.unknownCount, 1);
    const before = s.run.sendCount;
    await ctx.close();
    await launch();
    s = await snapshot();
    assert.equal(s.run.unknownCount, 1);
    assert.equal(s.run.sendCount, before);
    await rpc('CONTROL', { action: 'check' });
    assert.equal((await snapshot()).run.sendCount, before);
    const unknown = s.tasks.find((t) => t.status === 'unknown');
    await rpc('VERIFY', unknown.id);
    s = await snapshot();
    assert.equal(s.run.unknownCount, 0);
    assert.equal(s.run.sendCount, before);
  });
  await check('暂停/停止保留历史；真实模式不能隐式返回模拟任务', async () => {
    await rpc('CONTROL', { action: 'stop' });
    await page.getByRole('button', { name: '真实模式', exact: true }).click();
    await page.getByText('真实模式 · 只读观察', { exact: true }).waitFor();
    const state = await rpc(
      'STATE',
      { view: 'tasks', page: 0, query: '', author: '', status: '', stage: 'root' },
      'real',
    );
    assert.equal(state.tasks.length, 0);
    assert.equal(
      state.libraries.reduce((n, l) => n + l.count, 0),
      0,
    );
    await page.screenshot({ path: 'artifacts/screenshots/real-mode-blocked.png', fullPage: true });
  });
  await check('真实模式通过内容脚本读取本地贴吧 fixture，并复用已登记的工作标签页', async () => {
    const fixturePage = await ctx.newPage();
    await fixturePage.route('https://tieba.baidu.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }),
    );
    await fixturePage.goto('https://tieba.baidu.com/f?kw=%E8%B4%B4%E5%90%A7');
    assert.equal(await fixturePage.title(), '示例吧-百度贴吧');
    await page.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://tieba.baidu.com/f*' });
      await chrome.storage.local.set({ monitorTab: tabs[0].id });
    });
    const st = await rpc(
      'STATE',
      { view: 'threads', page: 0, query: '', author: '', status: '', stage: 'root' },
      'real',
    );
    await rpc(
      'CONTROL',
      {
        action: 'start',
        expected: {
          configVersion: st.config.version,
          libraryVersions: st.libraries.map((l) => l.version),
        },
      },
      'real',
    );
    await rpc('CONTROL', { action: 'check' }, 'real');
    const after = await rpc(
      'STATE',
      { view: 'threads', page: 0, query: '', author: '', status: '', stage: 'root' },
      'real',
    );
    assert.equal(after.threads.length, 3, after.run.reason);
    assert.equal(after.run.taskCount, 0);
    assert.equal(after.run.sendCount, 0);
    assert.equal(
      ctx.pages().filter((p) => p.url().startsWith('https://tieba.baidu.com/f')).length,
      1,
    );
    await rpc('CONTROL', { action: 'check' }, 'real');
    assert.equal(
      ctx.pages().filter((p) => p.url().startsWith('https://tieba.baidu.com/f')).length,
      1,
    );
    await rpc('CONTROL', { action: 'stop' }, 'real');
  });
  await check('深色主题与日志/历史/设置路由可访问', async () => {
    await page.getByRole('button', { name: '演示模式', exact: true }).click();
    await page.getByRole('button', { name: '切换主题' }).click();
    for (const name of ['自动任务', '历史记录', '运行日志', '设置']) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.locator('main h1').waitFor();
    }
    await page.getByRole('button', { name: '总览', exact: true }).click();
    await page.screenshot({ path: 'artifacts/screenshots/dashboard-dark.png', fullPage: true });
    assert.equal(errors.length, 0, errors.join('\n'));
  });
  await check('关闭全部控制台后，真实浏览器 alarm 自动唤醒并完成下一条演示首评', async () => {
    let s = await snapshot();
    await rpc('SAVE_CONFIG', { ...s.config, checkSeconds: 30, sendSeconds: 30 });
    s = await snapshot();
    await rpc('CONTROL', {
      action: 'start',
      expected: {
        configVersion: s.config.version,
        libraryVersions: s.libraries.map((l) => l.version),
      },
    });
    await rpc('CONTROL', { action: 'check' });
    for (const p of ctx.pages()) await p.close();
    await new Promise((resolve) => setTimeout(resolve, 34000));
    page = await ctx.newPage();
    await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
    s = await snapshot();
    assert.equal(s.run.rootSuccess, 1);
    await rpc('CONTROL', { action: 'stop' });
  });
  await writeFile(
    'artifacts/e2e-results.json',
    JSON.stringify(
      {
        browser: ctx.browser()?.version(),
        engine: 'Playwright bundled Chromium; not branded Chrome or Edge',
        profile: 'temporary isolated test profile',
        results,
        consoleErrors: errors,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(e);
  if (page)
    await page
      .screenshot({ path: 'artifacts/screenshots/failure.png', fullPage: true })
      .catch(() => {});
  await writeFile(
    'artifacts/e2e-results.json',
    JSON.stringify({ results, consoleErrors: errors, error: String(e) }, null, 2),
  );
  process.exitCode = 1;
} finally {
  await ctx?.close();
}
