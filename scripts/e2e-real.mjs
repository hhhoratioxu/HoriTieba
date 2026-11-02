import { chromium } from '@playwright/test';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const fixture = await readFile('tests/fixtures/tieba-legacy.html', 'utf8');
const identity = fixture.slice(
  fixture.indexOf('<div id="com_userbar">'),
  fixture.indexOf('<a id="tab_forumname"'),
);
const threadIdentity = identity.replace(
  /<div id="com_userbar">[\s\S]*?<\/div>/,
  '<div id="com_userbar"><li id="j_u_username"></li></div>',
);
const clock = () =>
  new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
let includeNew = false;
const card = (id) =>
  `<li class="j_thread_list" data-tid="${id}" data-field='{"id":${id},"author_portrait":"tb.fixture.other"}'><div class="threadlist_title"><a class="j_th_tit" href="/p/${id}">流程测试 ${id}</a></div><div class="threadlist_author"><a class="frs-author-name" href="/home/main?id=tb.fixture.other">合成作者</a></div><span title="创建时间">09:00</span></li>`;
const listHTML = () =>
  `<!doctype html><meta charset="utf-8"><title>本地列表 fixture</title>${identity}<ul id="thread_list">${card('800')}${includeNew ? card('900') : ''}</ul>`;
const rootHTML = (id, floor, author, text, time) =>
  `<div class="l_post" data-pid="${id}" data-field='{"author":{"portrait":"${author}"},"content":{"post_id":${id},"thread_id":900,"post_no":${floor}}}'><div class="d_author"><a class="p_author_name" href="/home/main?id=${author}">合成作者</a></div><div class="d_post_content_main"><div id="post_content_${id}" class="d_post_content">${text}</div><div class="core_reply"><div class="core_reply_tail"><span class="tail-info">${floor}楼</span><span class="tail-info">${time}</span><a class="p_reply" href="#">回复</a></div><div class="j_lzl_container hideLzl" style="height:0;overflow:hidden"><a class="j_lzl_p">我也说一句</a><div class="j_lzl_e_c"><div contenteditable="true" class="editor_lzl_container"><p><br></p></div><span class="j_lzl_p_sb">发表</span></div></div></div></div></div>`;
const threadHTML =
  () => `<!doctype html><html><meta charset="utf-8"><title>本地主题 fixture</title><style>[contenteditable]{min-height:40px;width:500px;border:1px solid #999}.j_submit,.p_reply,.j_lzl_p_sb{display:inline-block;padding:12px;cursor:pointer}.l_post{padding:10px}</style><body>${threadIdentity}<a id="tab_forumname" href="/f?kw=测试">看贴</a><h3 class="core_title_txt">流程测试 900</h3><div id="j_p_postlist">${rootHTML('901', 1, 'tb.fixture.other', '主题正文', clock())}</div><div id="tb_rich_poster"><div id="ueditor_replace" contenteditable="true"><p><br></p></div><a class="j_submit">发 表</a></div><script>
const template=${JSON.stringify(rootHTML('902', 2, 'tb.fixture.own', '', clock()))};
const time=()=>new Date(Date.now()+8*3600_000).toISOString().slice(0,16).replace('T',' ');
let clicks=JSON.parse(sessionStorage.getItem('fixture-clicks') || '{"root":0,"reply":0}');
const saved=sessionStorage.getItem('fixture-posts');
if(saved) document.querySelector('#j_p_postlist').innerHTML=saved;
const loads=Number(sessionStorage.getItem('fixture-loads') || 0)+1;
sessionStorage.setItem('fixture-loads',String(loads));
const persist=()=>{sessionStorage.setItem('fixture-clicks',JSON.stringify(clicks));sessionStorage.setItem('fixture-posts',document.querySelector('#j_p_postlist').innerHTML);};
document.querySelector('.j_submit').addEventListener('click',()=>{
 clicks.root++;const editor=document.querySelector('#ueditor_replace'),post=document.createElement('div');post.innerHTML=template;post.querySelector('.d_post_content').textContent=editor.innerText.trim();post.querySelectorAll('.tail-info')[1].textContent=time();document.querySelector('#j_p_postlist').append(post.firstElementChild);editor.innerHTML='<p><br></p>';persist();
});
document.addEventListener('click',e=>{if(e.target.matches('.p_reply')) {e.preventDefault();const root=e.target.closest('.l_post'),panel=root.querySelector('.j_lzl_container');panel.classList.remove('hideLzl');panel.style.cssText='';
 if(root.dataset.pid==='902'&&!sessionStorage.getItem('fixture-preparation-stall')) {
   sessionStorage.setItem('fixture-preparation-stall','1');panel.replaceChildren();panel.removeAttribute('data-field');return;
 }
 panel.setAttribute('data-field',JSON.stringify({pid:Number(root.dataset.pid),total_num:panel.querySelectorAll('.lzl_single_post').length}));}
 if(e.target.matches('.j_lzl_p_sb')) {clicks.reply++;const panel=e.target.closest('.j_lzl_container'),editor=panel.querySelector('[contenteditable]'),li=document.createElement('li');li.className='lzl_single_post';li.setAttribute('data-field',JSON.stringify({pid:'902',spid:String(902+clicks.reply),user_name:'fixture'}));li.innerHTML='<a class="lzl_p_p" href="/home/main?id=tb.fixture.own"></a><div class="lzl_cnt"><a class="j_user_card" href="/home/main?id=tb.fixture.own">合成账号</a><span class="lzl_content_main"></span><span class="lzl_time"></span></div>';li.querySelector('.lzl_content_main').textContent=editor.innerText.trim();li.querySelector('.lzl_time').textContent=time().replace(/-0/g,'-');panel.prepend(li);panel.setAttribute('data-field',JSON.stringify({pid:902,total_num:clicks.reply}));editor.innerHTML='<p><br></p>';persist();li.setAttribute('data-field','{"user_name":"fixture"}');}
});</script></body></html>`;
const profile = await mkdtemp(path.join(os.tmpdir(), 'horitieba-real-fixture-'));
const results = [];
let ctx;
let page;
let external = 0;
try {
  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    timezoneId: 'Asia/Shanghai',
    args: [
      `--disable-extensions-except=${path.resolve('dist')}`,
      `--load-extension=${path.resolve('dist')}`,
      '--host-resolver-rules=MAP tieba.baidu.com 127.0.0.1',
    ],
  });
  await ctx.route('**/*', (r) => {
    if (r.request().url().startsWith('chrome-extension://')) return r.continue();
    external++;
    return r.abort();
  });
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const eid = new URL(worker.url()).host;
  page = await ctx.newPage();
  await page.goto(`chrome-extension://${eid}/dashboard.html`);
  const monitor = await ctx.newPage();
  await monitor.route('https://tieba.baidu.com/**', (r) =>
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: listHTML() }),
  );
  await monitor.goto('https://tieba.baidu.com/f?kw=测试');
  const execution = await ctx.newPage();
  await execution.route('https://tieba.baidu.com/**', (r) =>
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: threadHTML() }),
  );
  await execution.goto('https://tieba.baidu.com/p/900');
  await page.evaluate(async () => {
    const all = await chrome.tabs.query({ url: 'https://tieba.baidu.com/*' });
    await chrome.storage.local.set({
      monitorTab: all.find((t) => t.url.includes('/f?')).id,
      executionTab: all.find((t) => t.url.includes('/p/')).id,
    });
  });
  const rpc = (type, payload) =>
    page.evaluate(
      async ({ type, payload }) => {
        const r = await chrome.runtime.sendMessage({
          type,
          ...(payload === undefined ? {} : { payload }),
          context: 'dashboard',
          mode: 'real',
          requestId: crypto.randomUUID(),
        });
        if (!r.ok) throw Error(r.error);
        return r.data;
      },
      { type, payload },
    );
  const state = () =>
    rpc('STATE', { view: 'tasks', page: 0, query: '', author: '', status: '', stage: 'root' });
  const due = () =>
    page.evaluate(async () => {
      const db = await new Promise((r) => {
        const q = indexedDB.open('HoriTieba-v1');
        q.onsuccess = () => r(q.result);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['meta', 'runs'], 'readwrite'),
          m = tx.objectStore('meta').get('active:real');
        m.onsuccess = () => {
          const q = tx.objectStore('runs').get(m.result.value);
          q.onsuccess = () =>
            tx.objectStore('runs').put({
              ...q.result,
              startedAt: Date.now() - 120000,
              nextCheckAt: Date.now() - 1,
              nextSendAt: Date.now() - 1,
            });
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
  let s = await state();
  await rpc('SAVE_CONFIG', {
    ...s.config,
    forum: '测试',
    realAction: 'auto',
    maxPosts: 1,
    maxSends: 5,
    maxReplies: 4,
  });
  for (const lib of s.libraries)
    await rpc('SAVE_LIBRARY', {
      id: lib.id,
      mode: 'real',
      stage: lib.stage,
      version: lib.version,
      enabled: true,
      loop: false,
      items: [
        {
          id: crypto.randomUUID(),
          text:
            lib.stage === 'root' ? '本地首评验证\n保留第二行🙂' : `本地 ${lib.stage} 追评验证🙂`,
        },
      ],
    });
  s = await state();
  const account = await rpc('PREFLIGHT');
  assert.equal(account.id, 'tb.fixture.own');
  await rpc('CONTROL', {
    action: 'start',
    expected: {
      configVersion: s.config.version,
      libraryVersions: s.libraries.map((l) => l.version),
      accountId: account.id,
    },
  });
  await rpc('CONTROL', { action: 'check' });
  s = await state();
  assert.equal(s.run.taskCount, 0);
  results.push({ name: '真实适配账号预检与历史基线不发送', status: 'passed' });
  includeNew = true;
  await due();
  await rpc('CONTROL', { action: 'check' });
  s = await state();
  assert.equal(s.run.rootSuccess, 1, JSON.stringify(s));
  assert.equal(s.run.sendCount, 1);
  assert.equal(s.tasks[0].root.rootId, '902');
  assert.equal(await execution.evaluate(() => clicks.root), 1);
  results.push({ name: '发现新主题→读取一楼时间→真实适配首评→DOM 独立编号证据', status: 'passed' });
  await due();
  await rpc('CONTROL', { action: 'check' });
  s = await state();
  assert.equal(s.run.status, 'running');
  assert.equal(s.run.sendCount, 1);
  assert.equal(s.tasks[0].steps[1].status, 'waiting');
  assert.equal(s.tasks[0].steps[1].preparationRetries, 1);
  assert.equal(s.tasks[0].steps[1].attemptId, undefined);
  assert.deepEqual(await execution.evaluate(() => clicks), { root: 1, reply: 0 });
  results.push({
    name: '折叠楼层延迟未生成父编号时自动延期准备，未占追评额度、未点击，下一轮自动恢复',
    status: 'passed',
  });
  await due();
  await rpc('CONTROL', { action: 'check' });
  s = await state();
  assert.equal(s.run.replySuccess, 1, JSON.stringify(s));
  assert.equal(s.run.sendCount, 2);
  assert.equal(s.tasks[0].steps[1].evidence.rootId, '902');
  assert.equal(s.tasks[0].steps[1].evidence.commentId, '903');
  assert.deepEqual(await execution.evaluate(() => clicks), { root: 1, reply: 1 });
  results.push({ name: '关联自己的 pid→楼中楼发送→spid 核实→游标恰好推进一次', status: 'passed' });
  assert.ok(await execution.evaluate(() => loads >= 3));
  assert.deepEqual(await execution.evaluate(() => clicks), { root: 1, reply: 1 });
  results.push({
    name: '无编号临时楼中楼不计成功，空草稿刷新后取得正式编号且不重发',
    status: 'passed',
  });
  for (let stage = 2; stage <= 4; stage++) {
    await due();
    await rpc('CONTROL', { action: 'check' });
    s = await state();
    assert.equal(s.run.replySuccess, stage, JSON.stringify(s));
    assert.equal(s.tasks[0].steps[stage].evidence.commentId, String(902 + stage));
    assert.equal(s.tasks[0].steps[stage].evidence.rootId, '902');
    assert.equal(s.tasks[0].steps[stage].evidence.targetId, '902');
  }
  assert.equal(s.tasks[0].status, 'completed');
  assert.deepEqual(
    s.libraries.map((lib) => lib.cursor),
    [1, 1, 1, 1, 1],
  );
  results.push({
    name: '四个追评库依次执行，全部关联同一首评、独立编号及五库游标各推进一次',
    status: 'passed',
  });
  await due();
  await rpc('CONTROL', { action: 'check' });
  assert.deepEqual(await execution.evaluate(() => clicks), { root: 1, reply: 4 });
  assert.equal((await state()).run.status, 'completed');
  results.push({ name: '重复调度与总量限制不追加发送', status: 'passed' });
  await rpc('CONTROL', { action: 'stop' });
  await page.getByRole('button', { name: '真实模式', exact: true }).click();
  await page.getByRole('button', { name: '自动任务', exact: true }).click();
  await mkdir('artifacts/screenshots', { recursive: true });
  await page.screenshot({
    path: 'artifacts/screenshots/real-fixture-completed.png',
    fullPage: true,
  });
  await writeFile(
    'artifacts/real-e2e-results.json',
    JSON.stringify(
      {
        browser: ctx.browser().version(),
        scope: 'Real adapter against isolated local DOM fixtures; NO live Tieba submissions',
        externalRequestsBlocked: external,
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: results.length, results }));
} catch (e) {
  if (page) {
    const debug = await page
      .evaluate(async () => {
        const { executionTab } = await chrome.storage.local.get('executionTab');
        return chrome.tabs.sendMessage(executionTab, {
          type: 'HORITIEBA_INSPECT',
          requestId: crypto.randomUUID(),
          context: 'background',
        });
      })
      .catch(String);
    console.log(JSON.stringify({ debug }));
  }
  await writeFile(
    'artifacts/real-e2e-results.json',
    JSON.stringify({ results, error: String(e) }, null, 2),
  );
  console.error(String(e).slice(0, 500));
  process.exitCode = 1;
} finally {
  await ctx?.close();
}
