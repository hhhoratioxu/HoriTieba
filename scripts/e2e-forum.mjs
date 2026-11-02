import { createServer } from 'node:https';
import { X509Certificate, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const url = 'https://tieba.baidu.com';
const fixture = await readFile('tests/fixtures/tieba-legacy.html', 'utf8');
const identity = fixture.slice(
  fixture.indexOf('<div id="com_userbar">'),
  fixture.indexOf('<a id="tab_forumname"'),
);
const account = 'tb.fixture.own',
  other = 'tb.fixture.other',
  phrase = '感谢分享这篇新帖。';
const stamp = (t) => new Date(t + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
const published = new Map();
const started = Date.now();
const created = (id) => stamp(id <= 711 ? started - 86400000 : started);
const creationLabel = (id) => (id <= 711 ? created(id).slice(5, 10) : created(id).slice(11));
let visible = [710];
const card = (id) =>
  `<li class="j_thread_list" data-tid="${id}" data-field='{"id":${id},"author_portrait":"${other}"}'><div class="threadlist_title"><a class="j_th_tit" href="/p/${id}">本地主题 ${id}</a></div><div class="threadlist_author"><a class="frs-author-name" href="/home/main?id=${other}">合成作者</a></div><span title="创建时间">${creationLabel(id)}</span><span title="最后回复时间">${stamp(Date.now()).slice(11)}</span></li>`;
const list = () =>
  `<!doctype html><meta charset="utf-8"><title>本地列表</title>${identity}<ul id="thread_list">${visible.map(card).join('')}</ul>`;
const root = (tid, pid, floor, by, when, text) =>
  `<article class="l_post" data-pid="${pid}" data-field='{"author":{"portrait":"${by}"},"content":{"post_id":${pid},"thread_id":${tid},"post_no":${floor},"comment_num":0}}'><div class="d_author"><a class="p_author_name" href="/home/main?id=${by}">合成账号</a></div><div class="d_post_content_main"><div id="post_content_${pid}">${text}</div><div class="core_reply"><div class="core_reply_tail"><span class="tail-info">${floor}楼</span><span class="tail-info">${when}</span></div></div></div></article>`;
const topic = (id) =>
  `<!doctype html><meta charset="utf-8"><title>本地主题</title><style>[contenteditable]{min-height:30px}.j_submit{padding:5px}</style>${identity}<a id="tab_forumname" href="/f?kw=测试">测试</a><h3 class="core_title_txt">合成帖子</h3><div id="j_p_postlist">${root(id, id * 100, 1, other, created(id), '正文')}${(published.get(id) ?? []).map((c, i) => root(id, id * 100 + i + 1, i + 2, account, c.when, c.text)).join('')}</div><div id="tb_rich_poster"><div id="ueditor_replace" contenteditable="true"><p><br></p></div><button class="j_submit">发表</button></div><script>document.querySelector('.j_submit').onclick=async()=>{const e=document.querySelector('#ueditor_replace'),text=e.innerText.trim();const r=await fetch('/__fixture_post__',{method:'POST',body:JSON.stringify({id:${id},text})});if(!r.ok)throw Error('本地台账拒绝');e.replaceChildren();document.querySelector('#j_p_postlist').insertAdjacentHTML('beforeend',await r.text());};</script>`;
const dir = await mkdtemp(path.join(os.tmpdir(), 'horitieba-forum-'));
let ctx;
const routes = [],
  errors = [],
  results = [],
  events = [];
const keyPath = path.join(dir, 'fixture.key'),
  certPath = path.join(dir, 'fixture.pem');
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=tieba.baidu.com',
    '-keyout',
    keyPath,
    '-out',
    certPath,
  ],
  { stdio: 'ignore' },
);
const cert = await readFile(certPath),
  key = await readFile(keyPath);
const pin = createHash('sha256')
  .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');
// Extension-created tabs can start their request before Playwright attaches. Serve the whole
// origin on loopback; only this throwaway certificate is pinned by this disposable browser.
const server = createServer({ key, cert }, async (req, res) => {
  try {
    const u = new URL(req.url, url);
    routes.push(u.pathname);
    if (req.headers.host !== 'tieba.baidu.com') {
      res.writeHead(421).end();
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (u.pathname === '/__fixture_post__' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { id, text } = JSON.parse(Buffer.concat(chunks));
      assert.ok([711, 712, 713, 714, 715].includes(id));
      assert.equal(text, phrase);
      const entries = published.get(id) ?? [],
        when = stamp(Date.now());
      const markup = root(
        id,
        id * 100 + entries.length + 1,
        entries.length + 2,
        account,
        when,
        text,
      );
      entries.push({ when, text });
      published.set(id, entries);
      events.push({ id, at: Date.now() });
      res.end(markup);
      return;
    }
    if (u.pathname === '/f') {
      res.end(list());
      return;
    }
    if (u.pathname === '/p/716') {
      res
        .writeHead(404)
        .end(
          '<!doctype html><meta charset="utf-8"><title>贴吧404</title><h1>很抱歉，该贴已被删除 <a href="/">返回首页</a></h1>',
        );
      return;
    }
    if (/^\/p\/71[0-5]$/.test(u.pathname)) {
      res.end(topic(Number(u.pathname.slice(3))));
      return;
    }
    res.writeHead(404).end();
  } catch (e) {
    errors.push(e.message);
    res.writeHead(500).end();
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
async function barClick(tab, host, text) {
  const el = tab.locator('#' + host);
  await el.waitFor();
  const b = await el.boundingBox();
  if (text !== undefined) {
    await tab.mouse.click(b.x + b.width / 2, b.y + 22);
    await tab.keyboard.insertText(text);
  }
  await tab.mouse.click(b.x + b.width - 34, b.y + 22);
}
try {
  ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    timezoneId: 'Asia/Taipei',
    viewport: { width: 1100, height: 760 },
    args: [
      `--disable-extensions-except=${path.resolve('dist')}`,
      `--load-extension=${path.resolve('dist')}`,
      '--no-proxy-server',
      '--ignore-certificate-errors-spki-list=' + pin,
      '--host-resolver-rules=MAP tieba.baidu.com 127.0.0.1:' +
        server.address().port +
        ', MAP * ~NOTFOUND, EXCLUDE localhost',
    ],
  });
  ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  await ctx.route('**/*', (r) => {
    const u = new URL(r.request().url());
    return u.protocol === 'chrome-extension:' || u.origin === url ? r.continue() : r.abort();
  });
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker')),
    eid = new URL(worker.url()).host;
  const viewer = await ctx.newPage();
  await viewer.goto('chrome-extension://' + eid + '/dashboard.html');
  const read = () =>
    viewer.evaluate(async () => {
      const db = await new Promise((r) => {
        const q = indexedDB.open('HoriTieba-v1');
        q.onsuccess = () => r(q.result);
      });
      const get = (s, k) =>
        new Promise((r) => {
          const q = db.transaction(s).objectStore(s).get(k);
          q.onsuccess = () => r(q.result);
        });
      try {
        const id = (await get('meta', 'active:real'))?.value;
        return {
          run: id ? await get('runs', id) : null,
          thread: (await get('meta', 'thread-reply:run'))?.value,
          config: await get('configs', 'real'),
          library: await get('libraries', 'real:root'),
        };
      } finally {
        db.close();
      }
    });
  async function until(check, ms = 180000) {
    const end = Date.now() + ms;
    let s;
    while (Date.now() < end) {
      s = await read();
      if (check(s)) return s;
      await new Promise((r) => setTimeout(r, 350));
    }
    throw Error(
      '状态超时 ' +
        JSON.stringify({
          status: s?.run?.status,
          reason: s?.run?.reason,
          qty: s?.run?.rootSuccess,
          checks: s?.run?.checks,
          events,
          routes: routes.slice(-20),
          errors,
          pages: await Promise.all(
            ctx.pages().map(async (p) => [
              p.url(),
              await p.title().catch(() => null),
              await p
                .locator('#j_p_postlist')
                .count()
                .catch(() => null),
            ]),
          ),
        }),
    );
  }
  const owner = await ctx.newPage();
  await owner.goto(url + '/f?kw=测试');
  const host = 'horitieba-forum-comments';
  await owner.locator('#' + host).waitFor();
  const launch = await viewer.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://tieba.baidu.com/f?*' });
    const requestId = crypto.randomUUID();
    const response = await chrome.tabs.sendMessage(
      tab.id,
      { type: 'HORITIEBA_FOCUS', context: 'background', requestId },
      { frameId: 0 },
    );
    return {
      popup: await chrome.action.getPopup({ tabId: tab.id }),
      focused: response?.data?.focused,
    };
  });
  assert.deepEqual(launch, { popup: '', focused: true });
  assert.equal(await owner.evaluate(() => document.activeElement?.id), host);

  await mkdir('artifacts/screenshots', { recursive: true });
  await owner
    .locator('#' + host)
    .screenshot({ path: 'artifacts/screenshots/forum-comment-bar.png' });
  await owner.evaluate(() => history.pushState(null, '', '/p/710'));
  await owner.locator('#horitieba-thread-replies').waitFor();
  assert.equal(await owner.locator('#' + host).count(), 0);
  await owner.evaluate(() => history.back());
  await owner.locator('#' + host).waitFor();
  assert.equal(await owner.locator('#horitieba-thread-replies').count(), 0);
  results.push('同页导航按贴吧列表或主题显示唯一的一行操作栏，未产生发送');
  const before = await read();
  await barClick(owner, host, phrase);
  const started = await until((s) => s.run?.baseline && s.run.status === 'running', 30000);
  assert.equal(started.run.taskCount, 0);
  assert.deepEqual(started.config, before.config);
  assert.deepEqual(started.library, before.library);
  assert.equal(started.run.libraries.filter((l) => l.enabled).length, 1);
  assert.equal(started.run.config.maxReplies, 0);
  results.push('直接从列表启动，既有主题仅作基线，旧内容库与配置未改写');
  const same = await ctx.newPage();
  await same.goto(url + '/p/710');
  await barClick(same, 'horitieba-thread-replies', '仅供无目标测试');
  await until((s) => s.thread?.running && s.run.status === 'running', 20000);
  await same.close();
  await until((s) => s.thread && !s.thread.running && s.run.status === 'running', 15000);
  results.push('两个页面可同时运行，关闭帖子仅停止该帖自动回复');
  // Close an actual idle helper with its persisted reference still present, before any send.
  const closedId = await viewer.evaluate(async () => {
    const tab = await chrome.tabs.create({ url: 'https://tieba.baidu.com/p/710', active: false });
    await chrome.storage.local.set({ executionTab: tab.id });
    await chrome.tabs.remove(tab.id);
    return tab.id;
  });
  const oldRouteCount = routes.filter((path) => path === '/p/711').length;
  visible = [711, 716, 712, 713, 714, 710];
  // Only the isolated test profile's start time is moved across Tieba's one-minute timestamp precision.
  await viewer.evaluate(async () => {
    const db = await new Promise((r) => {
      const q = indexedDB.open('HoriTieba-v1');
      q.onsuccess = () => r(q.result);
    });
    await new Promise((r) => {
      const t = db.transaction(['meta', 'runs'], 'readwrite'),
        m = t.objectStore('meta').get('active:real');
      m.onsuccess = () => {
        const q = t.objectStore('runs').get(m.result.value);
        q.onsuccess = () =>
          t
            .objectStore('runs')
            .put({ ...q.result, startedAt: Date.now() - 120000, nextCheckAt: Date.now() - 1 });
      };
      t.oncomplete = r;
    });
    db.close();
    const r = await chrome.runtime.sendMessage({
      type: 'CONTROL',
      mode: 'real',
      context: 'dashboard',
      requestId: crypto.randomUUID(),
      payload: { action: 'check' },
    });
    if (!r?.ok) throw Error(r?.error);
  });
  await until((s) => s.run?.rootSuccess === 1, 35000);
  const discovery = await viewer.evaluate(async () => {
    const id = (await chrome.storage.local.get('executionTab')).executionTab;
    const db = await new Promise((r) => {
      const q = indexedDB.open('HoriTieba-v1');
      q.onsuccess = () => r(q.result);
    });
    const row = await new Promise((r) => {
      const q = db.transaction('threads').objectStore('threads').get('real:测试:716');
      q.onsuccess = () => r(q.result);
    });
    db.close();
    return { id, removed: row?.creationCheck?.kind, pending: row?.timeCheckPending };
  });
  assert.notEqual(discovery.id, closedId);
  assert.equal(discovery.removed, 'removed');
  assert.equal(discovery.pending, false);
  assert.ok(routes.includes('/p/716'));
  assert.equal(routes.filter((path) => path === '/p/711').length, oldRouteCount);
  results.push('关闭空闲工作页后当轮自动重建，列表创建时间排除被顶旧帖');
  results.push('同轮读到贴吧删帖页后继续处理下一篇，删帖没有阻断或产生评论');
  visible = [712, 710]; // 713 and 714 must still be checked after leaving the list.
  await until((s) => s.run?.rootSuccess === 3);
  visible = [715, 712, 710];
  const four = await until((s) => s.run?.rootSuccess === 4);
  assert.equal(four.run.status, 'running');
  assert.equal(four.run.replySuccess, 0);
  // Two posts first seen in the same scan can have the same millisecond timestamp.
  assert.deepEqual(
    events.map((e) => e.id).sort((a, b) => a - b),
    [712, 713, 714, 715],
  );
  assert.equal(events[0].id, 712);
  assert.equal(events.at(-1).id, 715);
  assert.ok(events.slice(1).every((e, i) => e.at - events[i].at >= 29500));
  results.push('真实后台定时连续处理四篇新帖，旧帖顶起不发，各帖只有一条一级评论，间隔至少 30 秒');
  results.push('已见新帖滑出列表后仍完成时间核实；重复扫描不重复发');
  await barClick(owner, host);
  await until((s) => s.run?.status === 'stopped');
  const old = four.run.id;
  await barClick(owner, host);
  await until((s) => s.run?.id !== old && s.run?.baseline);
  await owner.close();
  await until((s) => s.run?.id !== old && s.run?.status === 'stopped', 20000);
  assert.equal(events.length, 4);
  results.push('停止按钮和关闭列表页都终止监控，重新开始不补发旧帖');
  console.log(JSON.stringify({ passed: true, results }));
} finally {
  await mkdir('artifacts', { recursive: true });
  await writeFile(
    'artifacts/forum-e2e.json',
    JSON.stringify(
      {
        passed: results.length === 8,
        results,
        fixtureSubmissions: events.length,
        externalPublications: 0,
      },
      null,
      2,
    ) + '\n',
  );
  await ctx?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
