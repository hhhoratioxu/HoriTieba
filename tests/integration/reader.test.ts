// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  readThreadCandidates,
  detectSession,
  detectBlockingState,
  hasDraft,
} from '../../src/adapters/tieba/read-page';
import { inspectThread } from '../../src/adapters/tieba/inspect-thread';
const fixture = readFileSync(process.cwd() + '/tests/fixtures/tieba-list.html', 'utf8');
function doc(html = fixture) {
  return new DOMParser().parseFromString(html, 'text/html');
}
it('已观察的卡片结构去重、排除外域、区分置顶与回复时间，不捏造时间戳', () => {
  const scan = readThreadCandidates(doc(), 'https://tieba.baidu.com/f?kw=示例');
  expect(scan.candidates).toHaveLength(3);
  expect(scan.reliable).toBe(false);
  expect(scan.candidates[0].kind).toBe('pinned');
  expect(scan.candidates[1].timeEvidence).toBe('relative');
  expect(scan.candidates[1].publishedAt).toBeUndefined();
  expect(scan.candidates[2].timeEvidence).toBe('unavailable');
});
it('未登录与未知身份保持阻断，不能把作者昵称当当前身份', () => {
  expect(detectSession(doc()).confirmed).toBe(false);
  expect(detectSession(doc()).id).toBeNull();
  const d = doc();
  d.querySelector('#top-bar')!.textContent = '示例作者';
  expect(detectSession(d).confirmed).toBe(false);
});
it('验证码、页面结构变化和草稿能被明确识别', () => {
  expect(detectBlockingState(doc('<title>百度安全验证</title>'))).toContain('验证');
  expect(
    readThreadCandidates(doc('<title>新页面</title>'), 'https://tieba.baidu.com/f?kw=示例')
      .blocking,
  ).toContain('未识别');
  expect(hasDraft(doc('<textarea>尚未发布的草稿</textarea>'))).toBe(true);
  expect(hasDraft(doc('<div contenteditable="true">  </div>'))).toBe(false);
});
it('账号通过头部 ID 与“我的”主页 ID 交叉核对，冲突保持身份未知', () => {
  const d = doc(
    '<div id="top-bar"><div class="user-or-login"><img class="user-avatar" src="https://gss0.bdstatic.com/x/sys/portrait/item/tb.fixture.own?t=1"></div></div><a href="https://tieba.baidu.com/home/main?id=tb.fixture.own">我的</a>',
  );
  expect(detectSession(d)).toMatchObject({ id: 'tb.fixture.own', confirmed: true });
  d.querySelector('a')!.setAttribute(
    'href',
    'https://tieba.baidu.com/home/main?id=tb.fixture.other',
  );
  expect(detectSession(d).confirmed).toBe(false);
});
it('首评只读诊断使用直属作者与内容，不能把嵌套作者错当首评作者', () => {
  const d = doc(
    '<div class="pb-comment-item" data-id="123"><div class="head-line"><a class="head-name" href="https://tieba.baidu.com/home/main?id=tb.fixture.root">甲</a></div><div class="comment-content"><div class="pb-rich-text">首评</div><div class="lzl-wrapper"><div class="pb-lzl-item"><a class="head-name" href="https://tieba.baidu.com/home/main?id=tb.fixture.nested">乙</a><div class="comment-content">追评</div></div></div></div></div>',
  );
  const result = inspectThread(d, 'https://tieba.baidu.com/p/1');
  expect(result.roots[0]).toMatchObject({
    id: '123',
    text: '首评',
    authorId: 'tb.fixture.root',
    nestedReplies: 1,
    nestedRepliesWithStableId: 0,
  });
  expect(result.selfReplyVerified).toBe(false);
});
