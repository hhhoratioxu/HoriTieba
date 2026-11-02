import { chromium } from '@playwright/test';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const fixture = await readFile('tests/fixtures/thread-replies.html', 'utf8');
const files = await mkdtemp(path.join(os.tmpdir(), 'horitieba-single-'));
const results = [];
let ctx;
let blocked = 0;
try {
  ctx = await chromium.launchPersistentContext(files, {
    channel: 'chromium',
    headless: true,
    timezoneId: 'Asia/Taipei',
    viewport: { width: 1040, height: 780 },
    args: [
      `--disable-extensions-except=${path.resolve('dist')}`,
      `--load-extension=${path.resolve('dist')}`,
      '--host-resolver-rules=MAP tieba.baidu.com 127.0.0.1',
    ],
  });
  await ctx.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.protocol === 'chrome-extension:') return r.continue();
    if (u.origin === 'https://tieba.baidu.com' && /^\/p\/(988|989)$/.test(u.pathname))
      return r.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
    blocked++;
    return r.abort();
  });
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker')),
    eid = new URL(worker.url()).host;
  const viewer = await ctx.newPage();
  await viewer.goto('chrome-extension://' + eid + '/dashboard.html');
  // The reader stays on a stable document while the owner tab is automatically paging.
  const reader = await ctx.newPage();
  await reader.goto('https://tieba.baidu.com/p/988');
  const tab = await ctx.newPage();
  const state = () =>
    viewer.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const db = indexedDB.open('HoriTieba-v1');
          db.onerror = () => reject(db.error);
          db.onsuccess = () => {
            const tx = db.result.transaction('meta'),
              q = tx.objectStore('meta').get('thread-reply:run');
            q.onsuccess = () => resolve(q.result?.value);
            tx.oncomplete = () => db.result.close();
          };
        }),
    );
  async function until(test, ms = 25000, allowStopped = false) {
    const end = Date.now() + ms;
    let value;
    while (Date.now() < end) {
      value = await state();
      if (test(value)) return value;
      if (
        !allowStopped &&
        value &&
        !value.running &&
        value.reason &&
        !value.reason.includes('已离开')
      )
        throw Error(value.reason);
      await new Promise((r) => setTimeout(r, 300));
    }
    throw Error('等待超时 ' + JSON.stringify(value));
  }
  async function bar(action) {
    const host = tab.locator('#horitieba-thread-replies');
    await host.waitFor();
    const box = await host.boundingBox();
    // Use real pointer/keyboard events. The installed content script uses a closed shadow root.
    if (action === 'type') {
      await tab.mouse.click(box.x + box.width / 2, box.y + 25);
      await tab.keyboard.insertText('统一答复🙂');
    } else await tab.mouse.click(box.x + box.width - 32, box.y + 25);
  }
  await tab.goto('https://tieba.baidu.com/p/988');
  await bar('type');
  await mkdir('artifacts/screenshots', { recursive: true });
  await tab
    .locator('#horitieba-thread-replies')
    .screenshot({ path: 'artifacts/screenshots/thread-reply-bar.png' });
  await bar('click');
  const first = await until((s) => s?.running && s.sent === 1);
  assert.equal(first.pending, undefined);
  results.push('一次点击后按原楼层发表，刷新后用独立编号核实');
  await until((s) => s?.sent === 4, 140000);
  const ledger = await reader.evaluate(() => JSON.parse(localStorage.getItem('fixture:988')));
  assert.deepEqual(
    ledger.clicks.map((c) => [c.root, c.selected, c.to]),
    [
      ['902', '902', null],
      ['902', '903', 'tb.fixture.other'],
      ['902', '904', 'tb.fixture.other'],
      ['910', '911', 'tb.fixture.other'],
    ],
  );
  assert.ok(ledger.clicks.every((c) => c.body === '统一答复🙂'));
  assert.ok(ledger.clicks.slice(1).every((c, i) => c.at - ledger.clicks[i].at >= 29500));
  results.push('帖子与楼中楼自动翻页，同一人两条原评论分别点击，跳过正文和自己，按发送间隔执行');
  await reader.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('fixture:988'));
    s.rows.push({ id: '999', root: '902', by: 'tb.fixture.new', body: '新到的评论' });
    localStorage.setItem('fixture:988', JSON.stringify(s));
  });
  await until((s) => s?.sent === 5, 80000);
  const after = await reader.evaluate(() => JSON.parse(localStorage.getItem('fixture:988')).clicks);
  assert.equal(after.length, 5);
  assert.equal(after[4].selected, '999');
  results.push('自动发现后来新增的楼中楼，每条只回复一次');
  await tab.waitForURL('**/p/988?pn=2');
  await bar('click');
  const stopped = await until((s) => s && !s.running && !s.pending);
  assert.equal(stopped.sent, 5);
  const freshFirst = tab.waitForURL((url) => url.pathname === '/p/988' && !url.search, {
    waitUntil: 'commit',
  });
  await bar('click');
  await freshFirst;
  const resumed = await until((s) => s?.running && s.id !== stopped.id, 25000, true);
  assert.equal(resumed.sent, 0);
  await tab.waitForURL('**/p/988?pn=2');
  assert.equal(
    await reader.evaluate(() => JSON.parse(localStorage.getItem('fixture:988')).clicks.length),
    5,
  );
  results.push('停止按钮生效，重新开始仍跳过已回复的原评论');
  await tab.close();
  await until((s) => s && !s.running);
  results.push('关闭帖子自动停止');
  const second = await ctx.newPage();
  await second.goto('https://tieba.baidu.com/p/989');
  await second.evaluate(() => localStorage.setItem('fixture:drop', 'yes'));
  const host = second.locator('#horitieba-thread-replies');
  await host.waitFor();
  const b = await host.boundingBox();
  await second.mouse.click(b.x + b.width / 2, b.y + 25);
  await second.keyboard.insertText('结果未知测试');
  await second.mouse.click(b.x + b.width - 32, b.y + 25);
  const unknown = await until((s) => s?.thread === '989' && !s.running && s.pending, 62000);
  assert.equal(unknown.sent, 0);
  assert.equal(
    (await second.evaluate(() => JSON.parse(localStorage.getItem('fixture:989')).clicks)).length,
    1,
  );
  results.push('发送结果不明确时只读刷新一次，暂停并保留去重记录');
  console.log(JSON.stringify({ results, blocked }));
} finally {
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    'artifacts/thread-reply-e2e.json',
    JSON.stringify({ passed: results.length === 6, results, blocked }, null, 2) + '\n',
  );
  await ctx?.close();
  await rm(files, { recursive: true, force: true });
}
