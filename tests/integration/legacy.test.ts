// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  legacyThread,
  minuteTime,
  evidenceFromPage,
  legacyList,
} from '../../src/adapters/tieba/legacy';
import { detectSession, profileId, hasDraft } from '../../src/adapters/tieba/read-page';
import { PageDriver } from '../../src/adapters/tieba/page-driver';
import type { Attempt, Target } from '../../src/domain/models';
const html = readFileSync('tests/fixtures/tieba-legacy.html', 'utf8');
const url = 'https://tieba.baidu.com/p/900';
const d = () => new DOMParser().parseFromString(html, 'text/html');
const target: Target = {
  threadId: '900',
  rootId: '902',
  commentId: '902',
  authorId: 'tb.fixture.own',
  relation: 'self-root',
};
const attempt = {
  id: crypto.randomUUID(),
  mode: 'real',
  stage: 'reply1',
  target,
  accountId: 'tb.fixture.own',
  text: '追评原文',
  beforeIds: ['901', '902'],
  intendedAt: Date.parse('2026-11-02T09:02:35+08:00'),
} as Attempt;
afterEach(() => vi.restoreAllMocks());
it('旧版主题一楼的完整时间独立于最后回复时间，并保留分钟精度', () => {
  const p = legacyThread(d(), url);
  expect(p.publishedAt).toBe(Date.parse('2026-11-02T09:00:00+08:00'));
  expect(p.comments.map((c) => [c.id, c.rootId, c.authorId])).toEqual([
    ['901', '901', 'tb.fixture.other'],
    ['902', '902', 'tb.fixture.own'],
    ['903', '902', 'tb.fixture.own'],
  ]);
  expect(p.invalidComments).toBe(0);
});
it('账号同名不作凭据，主页标识必须与侧栏头像完全匹配', () => {
  const doc = d();
  expect(detectSession(doc).confirmed).toBe(true);
  doc
    .querySelector('#user_info img')!
    .setAttribute('src', 'https://himg.bdimg.com/sys/portrait/item/tb.fixture.other');
  expect(detectSession(doc).confirmed).toBe(false);
});
it('头像时间后缀与相对主页路径规范化，外域和非时间后缀被拒绝', () => {
  expect(profileId('/home/main/?id=tb.fixture.own?t=123')).toBe('tb.fixture.own');
  expect(profileId('https://evil.test/home/main?id=tb.fixture.own')).toBeNull();
  expect(profileId('/home/main?id=tb.fixture.own?extra=1')).toBeNull();
});
const emptyHeader = () => {
  const doc = d();
  doc.querySelector('#com_userbar')!.innerHTML = '<li id="j_u_username"></li>';
  return doc;
};
it('旧版主题顶部账号槽未渲染时，侧栏头像与两个主页 ID 一致才确认', () => {
  expect(detectSession(emptyHeader())).toMatchObject({ id: 'tb.fixture.own', confirmed: true });
});
it('空顶部侧栏模式拒绝昵称同名但主页 ID 冲突或外域', () => {
  for (const href of [
    '/home/main?id=tb.fixture.other',
    'https://evil.test/home/main?id=tb.fixture.own',
  ]) {
    const doc = emptyHeader();
    doc.querySelector('#user_info .user_name a')!.setAttribute('href', href);
    expect(detectSession(doc).confirmed).toBe(false);
  }
});
it('侧栏模式不覆盖已出现的顶部身份，也不允许部分顶部或登录入口', () => {
  for (const html of [
    '<a class="u_username_wrap" href="/home/main?id=tb.fixture.other">同名</a>',
    '<li class="u_itieba"></li>',
    '<a>登录</a>',
  ]) {
    const doc = emptyHeader();
    doc.querySelector('#com_userbar')!.insertAdjacentHTML('beforeend', html);
    expect(detectSession(doc).confirmed).toBe(false);
  }
});
it('侧栏模式仅适用于观察到的主题结构，缺失或重复账号链接不能确认', () => {
  for (const mutation of [
    (doc: Document) => doc.querySelector('#j_p_postlist')!.remove(),
    (doc: Document) => doc.querySelector('#j_u_username')!.remove(),
    (doc: Document) => doc.querySelector('#user_info .user_name a')!.remove(),
    (doc: Document) =>
      doc
        .querySelector('#user_info .user_name')!
        .insertAdjacentHTML('beforeend', '<a href="/home/main?id=tb.fixture.own">重复</a>'),
  ]) {
    const doc = emptyHeader();
    mutation(doc);
    expect(detectSession(doc).confirmed).toBe(false);
  }
});
it('不解析相对时间、非法日期或自动补年份', () => {
  for (const s of ['9分钟前', '09:02', '11-02', '2026-02-30 09:02', '2026-11-02 25:00'])
    expect(minuteTime(s)).toBeUndefined();
});
it('真实楼中楼的非补零日期可解析，刚发布但没有 spid 的临时节点不能成为证据', () => {
  expect(minuteTime('2026-11-2\u00a010:02')).toBe(Date.parse('2026-11-02T10:02:00+08:00'));
  const doc = d();
  doc
    .querySelector('.lzl_single_post')!
    .setAttribute('data-field', '{"user_name":"fixture","portrait":"tb.fixture.own"}');
  const p = legacyThread(doc, url);
  expect(p.invalidComments).toBe(1);
  expect(evidenceFromPage(attempt, p, Date.parse('2026-11-02T09:02:50+08:00'))).toBeUndefined();
});
it('楼中楼必须同时具备独立 spid、父 pid 和两个一致的作者 ID', () => {
  const doc = d();
  doc
    .querySelector('.lzl_single_post')!
    .setAttribute('data-field', "{'pid':'999','spid':'903','user_name':'合成'}");
  const p = legacyThread(doc, url);
  expect(p.comments).toHaveLength(2);
  expect(p.invalidComments).toBe(1);
});
it('不执行 data-field 中的代码、不从昵称伪造 ID、不接受重复编号', () => {
  const doc = d();
  doc
    .querySelector('.lzl_single_post')!
    .setAttribute('data-field', "{'user_name':\"'pid':'902','spid':'903'\",'code':alert(1)}");
  expect(legacyThread(doc, url).invalidComments).toBe(1);
  const duplicate = d();
  duplicate
    .querySelector('#j_p_postlist')!
    .append(duplicate.querySelector('.l_post')!.cloneNode(true));
  expect(legacyThread(duplicate, url).invalidComments).toBe(1);
});
it('跨分钟边界仍按分钟区间核实，但旧评论、不同父楼和错误作者不能成功', () => {
  const now = Date.parse('2026-11-02T09:02:50+08:00');
  const p = legacyThread(d(), url);
  expect(evidenceFromPage(attempt, p, now)?.commentId).toBe('903');
  expect(evidenceFromPage({ ...attempt, beforeIds: ['903'] }, p, now)).toBeUndefined();
  expect(evidenceFromPage({ ...attempt, intendedAt: now + 60000 }, p, now + 60000)).toBeUndefined();
  p.comments[1].authorId = 'tb.fixture.other';
  expect(evidenceFromPage(attempt, p, now)).toBeUndefined();
});
it('同文多条新增证据和回复其他楼中楼都保持未知', () => {
  const p = legacyThread(d(), url),
    now = Date.parse('2026-11-02T09:02:50+08:00');
  p.comments.push({ ...p.comments[2], id: '904' });
  expect(evidenceFromPage(attempt, p, now)).toBeUndefined();
  p.comments.pop();
  p.comments[2].direct = false;
  expect(evidenceFromPage(attempt, p, now)).toBeUndefined();
});
it('一级评论时间、主题 ID、直属作者不一致时不能被嵌套内容补足', () => {
  const doc = d();
  doc.querySelector('.l_post[data-pid="902"] > .d_author')!.remove();
  const p = legacyThread(doc, url);
  expect(p.comments).toHaveLength(1);
  expect(p.invalidComments).toBe(1);
});
it('旧版列表只读创建时间标签，不把最后回复时间当创建时间', () => {
  const doc = d();
  doc.body.insertAdjacentHTML(
    'beforeend',
    `<ul id="thread_list"><li class="j_thread_list" data-tid="900" data-field='{"id":900,"author_portrait":"tb.fixture.other"}'><div class="threadlist_title"><a class="j_th_tit" href="/p/900">主题</a></div><div class="threadlist_author"><a class="frs-author-name" href="/home/main?id=tb.fixture.other">作者</a></div><span title="创建时间">10-29</span><span title="最后回复时间">09:59</span></li></ul>`,
  );
  const scan = legacyList(doc, 'https://tieba.baidu.com/f?kw=测试');
  expect(scan.candidates[0]).toMatchObject({
    timeLabel: '10-29',
    timeEvidence: 'unavailable',
    timeCheckPending: true,
  });
  expect(scan.candidates[0].publishedAt).toBeUndefined();
});
function setupDriver(permit: () => Promise<boolean>) {
  document.body.innerHTML = d().body.innerHTML;
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const driver = new PageDriver(document, () => url, permit);
  return driver;
}
it('未推进页面计时器时，分批挂载的楼中楼入口、输入框和按钮仍可通过 DOM 变化依次就绪', async () => {
  vi.useFakeTimers();
  try {
    const driver = setupDriver(async () => true);
    const panel = document.querySelector('.j_lzl_container')!;
    const open = panel.querySelector('.j_lzl_p')!;
    const editorRow = panel.querySelector('.j_lzl_e_c')!;
    const submit = editorRow.querySelector('.j_lzl_p_sb')!;
    open.remove();
    editorRow.remove();
    submit.remove();
    const openClicks = vi.fn(() => panel.append(editorRow));
    open.addEventListener('click', openClicks);
    const ready = driver.prepare(target, '测试');
    await vi.advanceTimersByTimeAsync(0);
    panel.append(open);
    await vi.advanceTimersByTimeAsync(0);
    expect(openClicks).toHaveBeenCalledTimes(1);
    editorRow.append(submit);
    expect((await ready).beforeIds).toEqual(['901', '902', '903']);
  } finally {
    vi.useRealTimers();
  }
});

it('撤销尚未完成的准备后，迟到的入口不会被点击，旧取消消息也不会清掉下一次准备', async () => {
  vi.useFakeTimers();
  try {
    const driver = setupDriver(async () => true);
    const panel = document.querySelector('.j_lzl_container')!;
    const open = panel.querySelector('.j_lzl_p')!;
    const editorRow = panel.querySelector('.j_lzl_e_c')!;
    open.remove();
    editorRow.remove();
    const click = vi.fn(() => panel.append(editorRow));
    open.addEventListener('click', click);
    const old = crypto.randomUUID();
    const cancelled = expect(driver.prepare(target, '测试', old)).rejects.toThrow('取消');
    await vi.advanceTimersByTimeAsync(0);
    driver.cancel(old);
    await cancelled;
    panel.append(open);
    await vi.advanceTimersByTimeAsync(0);
    expect(click).not.toHaveBeenCalled();
    const current = driver.prepare(target, '测试', crypto.randomUUID());
    driver.cancel(old);
    await current;
    expect(click).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('超过准备截止时间的页面变化不能触发迟到点击，已存在的错误父编号立即阻断', async () => {
  vi.useFakeTimers();
  try {
    const driver = setupDriver(async () => true),
      panel = document.querySelector('.j_lzl_container')!;
    const open = panel.querySelector('.j_lzl_p')!;
    open.remove();
    panel.querySelector('.j_lzl_e_c')!.remove();
    const click = vi.fn();
    open.addEventListener('click', click);
    const expired = expect(
      driver.prepare(target, '测试', crypto.randomUUID(), Date.now() + 1200),
    ).rejects.toMatchObject({ name: 'PageNotReadyError' });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 1500);
    panel.append(open);
    await expired;
    expect(click).not.toHaveBeenCalled();
    panel.setAttribute('data-field', '{"pid":999,"total_num":1}');
    await expect(driver.prepare(target, '测试')).rejects.toThrow('不一致');
    expect(click).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it('真实空楼中楼容器有布局矩形但带 hideLzl，必须先单次展开再核对父编号', async () => {
  const driver = setupDriver(async () => true);
  const root = document.querySelector('.l_post[data-pid="902"]')!;
  const panel = root.querySelector('.j_lzl_container')!;
  const content = panel.innerHTML;
  panel.classList.add('hideLzl');
  panel.removeAttribute('data-field');
  panel.replaceChildren();
  const unfold = vi.fn(() => {
    panel.classList.remove('hideLzl');
    panel.setAttribute('data-field', '{"pid":902,"total_num":1}');
    panel.innerHTML = content;
  });
  root.querySelector('.p_reply')!.addEventListener('click', unfold);
  const prepared = await driver.prepare(target, '测试');
  expect(prepared.beforeIds).toEqual(['901', '902', '903']);
  expect(unfold).toHaveBeenCalledTimes(1);
});
it('发送许可等待期间暂停，不点击按钮；原文草稿保留', async () => {
  let release!: (b: boolean) => void;
  const permit = new Promise<boolean>((r) => (release = r));
  const driver = setupDriver(() => permit);
  const prepared = await driver.prepare(target, '测试');
  const click = vi.fn();
  document.querySelector('.j_lzl_p_sb')!.addEventListener('click', click);
  const sending = driver.submit(crypto.randomUUID(), prepared.token, target, '新追评');
  driver.cancel();
  release(true);
  await expect(sending).rejects.toThrow('取消');
  expect(click).not.toHaveBeenCalled();
  expect(document.querySelector('#j_editor_for_container')!.textContent).toBe('新追评');
});
it('同一准备票据最多一次点击；首评按钮不被楼中楼操作误触', async () => {
  const driver = setupDriver(async () => true);
  const prepared = await driver.prepare(target, '测试');
  const root = vi.fn(),
    nested = vi.fn();
  document.querySelector('.j_submit')!.addEventListener('click', root);
  document.querySelector('.j_lzl_p_sb')!.addEventListener('click', nested);
  await driver.submit(crypto.randomUUID(), prepared.token, target, '新追评');
  await expect(
    driver.submit(crypto.randomUUID(), prepared.token, target, '新追评'),
  ).rejects.toThrow('已使用');
  expect(nested).toHaveBeenCalledTimes(1);
  expect(root).not.toHaveBeenCalled();
});
it('草稿保护、他人首评与不完整楼中楼快照均阻断准备', async () => {
  const driver = setupDriver(async () => true);
  document.querySelector('#ueditor_replace')!.textContent = '用户草稿';
  await expect(driver.prepare(target, '测试')).rejects.toThrow('草稿');
  document.querySelector('#ueditor_replace')!.textContent = '';
  await expect(
    driver.prepare({ ...target, rootId: '901', commentId: '901' }, '测试'),
  ).rejects.toThrow('当前账号的首评');
  document
    .querySelector('.j_lzl_container')!
    .setAttribute('data-field', '{"pid":902,"total_num":20}');
  await expect(driver.prepare(target, '测试')).rejects.toThrow('完整');
});
it('仅图片且无 alt 文本的草稿仍阻止覆盖和刷新', async () => {
  const driver = setupDriver(async () => true);
  const img = document.createElement('img');
  img.alt = '';
  document.querySelector('#ueditor_replace')!.replaceChildren(img);
  expect(hasDraft(document)).toBe(true);
  await expect(driver.prepare(target, '测试')).rejects.toThrow('草稿');
  expect(document.querySelector('#ueditor_replace img')).toBe(img);
});
it('发送许可等待期间插入图片，不把额外图片随已确认原文发出', async () => {
  const driver = setupDriver(async () => {
    const img = document.createElement('img');
    img.alt = '';
    document.querySelector('#j_editor_for_container')!.append(img);
    return true;
  });
  const prepared = await driver.prepare(target, '测试'),
    click = vi.fn();
  document.querySelector('.j_lzl_p_sb')!.addEventListener('click', click);
  await expect(
    driver.submit(crypto.randomUUID(), prepared.token, target, '新追评'),
  ).rejects.toThrow('内容或按钮状态变化');
  expect(click).not.toHaveBeenCalled();
});

it('许可响应超时后才返回允许，也不能迟到点击；保留原文与等待环节', async () => {
  vi.useFakeTimers();
  let release!: (value: boolean) => void;
  const driver = setupDriver(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  try {
    const prepared = await driver.prepare(target, '测试');
    const id = crypto.randomUUID(),
      click = vi.fn();
    document.querySelector('.j_lzl_p_sb')!.addEventListener('click', click);
    const result = expect(
      driver.submit(id, prepared.token, target, '等待许可的追评'),
    ).rejects.toThrow('发送许可响应超时');
    await vi.advanceTimersByTimeAsync(5001);
    await result;
    release(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(click).not.toHaveBeenCalled();
    expect(driver.submissionState(id).phase).toBe('awaiting-permit');
    expect(document.querySelector('#j_editor_for_container')!.textContent).toBe('等待许可的追评');
  } finally {
    vi.useRealTimers();
  }
});

it('主线程长时间阻塞导致许可过期时，即使计时器尚未执行也不点击', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const driver = setupDriver(async () => {
    now.mockReturnValue(7000);
    return true;
  });
  const prepared = await driver.prepare(target, '测试');
  const click = vi.fn();
  document.querySelector('.j_lzl_p_sb')!.addEventListener('click', click);
  await expect(
    driver.submit(crypto.randomUUID(), prepared.token, target, '过期许可'),
  ).rejects.toThrow('许可已过期');
  expect(click).not.toHaveBeenCalled();
});

it('仅在带贴吧 404 标题和删除提示的独立页面确认删帖，验证或普通主题不误判', () => {
  const dom = (markup: string) => new DOMParser().parseFromString(markup, 'text/html');
  const heading = '<h1>很抱歉，该贴已被删除 返回首页</h1>';
  expect(() => legacyThread(dom('<title>贴吧404</title>' + heading), url)).toThrowError(
    expect.objectContaining({ name: 'ThreadUnavailableError' }),
  );
  expect(() => legacyThread(dom('<title>贴吧404</title><h1>正在加载</h1>'), url)).toThrow(
    '主题旧版页面未就绪',
  );
  expect(() => legacyThread(dom('<title>百度安全验证</title>' + heading), url)).toThrowError(
    expect.objectContaining({ name: 'BlockedError' }),
  );
  const post = d();
  post.title = '贴吧404';
  post.body.insertAdjacentHTML('afterbegin', heading);
  expect(legacyThread(post, url).threadId).toBe('900');
});
