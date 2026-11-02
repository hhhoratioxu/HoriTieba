import { mountActionBar } from './action-bar';
import { detectSession, hasDraft } from '../adapters/tieba/read-page';
import { whenReady } from '../adapters/tieba/page-driver';
import { forumFromUrl, type ForumAction, type ForumState } from '../shared/forum-comments';

export function installForumComments(lifetime: AbortSignal) {
  const forum = forumFromUrl(location.href);
  if (
    !forum ||
    window !== window.top ||
    !document.body ||
    document.getElementById('horitieba-forum-comments')
  )
    return;
  const { input, button, skip, status, focus } = mountActionBar(
    'horitieba-forum-comments',
    '自动评论',
    '给本吧每篇新帖发一条评论',
    lifetime,
  );
  let state: ForumState | null = null,
    loading = true,
    sentRequest = 0,
    activeDocument = true;
  const rpc = async (action: ForumAction) => {
    const res = await chrome.runtime.sendMessage({ type: 'HORITIEBA_FORUM', forum, ...action });
    if (!res?.ok) throw Error(res?.error ?? '扩展已更新，请刷新贴吧。');
    return res.data as ForumState | null;
  };
  function draw(hint = '') {
    const running = state?.status === 'running',
      elsewhere = state?.status === 'elsewhere';
    const paused = state?.status === 'paused' || state?.status === 'blocked';
    input.readOnly = !!(running || paused || elsewhere || state?.unknown);
    button.textContent = state?.unknown ? '核实' : running ? '停止' : paused ? '继续' : '开始';
    button.disabled = loading || !!elsewhere || (!input.readOnly && !input.value.trim());
    skip.textContent = '停止';
    skip.hidden = !paused;
    const detail = hint || state?.reason || (running ? '等待新帖' : '');
    status.textContent =
      state && !elsewhere
        ? '已评论 ' + state.sent + ' 帖' + (detail ? ' · ' + detail : '')
        : detail;
  }
  function apply(next: ForumState | null, initial = false) {
    state = next;
    if (
      next &&
      next.status !== 'elsewhere' &&
      (initial || input.readOnly || !input.value || next.status === 'running')
    )
      input.value = next.text;
    draw();
  }
  async function refresh(initial = false) {
    const seq = ++sentRequest;
    try {
      const next = await rpc({ op: 'state' });
      if (seq !== sentRequest || !activeDocument) return;
      loading = false;
      apply(next, initial);
    } catch (e) {
      if (seq === sentRequest && activeDocument) {
        loading = false;
        draw(e instanceof Error ? e.message : '请刷新贴吧。');
      }
    }
  }
  async function act(stopOnly = false) {
    if (loading) return;
    const seq = ++sentRequest;
    loading = true;
    draw();
    try {
      let action: ForumAction;
      if (state && (stopOnly || state.status === 'running')) action = { op: 'stop', run: state.id };
      else if (state?.unknown) action = { op: 'verify', run: state.id };
      else if (state && (state.status === 'blocked' || state.status === 'paused'))
        action = { op: 'resume', run: state.id };
      else {
        if (hasDraft(document)) throw Error('贴吧页面有草稿，请先处理。');
        draw('正在核对登录账号');
        const account = await whenReady(
          document.documentElement,
          { signal: new AbortController().signal, deadline: Date.now() + 8000 },
          '登录账号',
          () => {
            const a = detectSession(document);
            if (a.label === '未登录') throw Error('请先登录贴吧。');
            return a.confirmed && a.id ? a.id : undefined;
          },
        ).catch(() => {
          throw Error('请先登录贴吧，再刷新这个页面。');
        });
        action = { op: 'start', text: input.value.trim(), account };
      }
      lifetime.throwIfAborted();
      const result = await rpc(action);
      if (seq !== sentRequest || !activeDocument) return;
      loading = false;
      apply(result);
    } catch (e) {
      if (activeDocument) {
        loading = false;
        draw(e instanceof Error ? e.message : '操作失败');
      }
    }
  }
  input.addEventListener('input', () => draw());
  button.addEventListener('click', (e) => {
    if (e.isTrusted) void act();
  });
  skip.addEventListener('click', (e) => {
    if (e.isTrusted) void act(true);
  });
  lifetime.addEventListener(
    'abort',
    () => {
      activeDocument = false;
    },
    { once: true },
  );
  addEventListener(
    'pagehide',
    () => {
      activeDocument = false;
    },
    { signal: lifetime },
  );
  addEventListener(
    'pageshow',
    (e) => {
      if (e.persisted) {
        activeDocument = true;
        void refresh(true);
      }
    },
    { signal: lifetime },
  );
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'visible' && !loading) void refresh();
    },
    { signal: lifetime },
  );
  draw();
  void refresh(true);
  return {
    focus,
    refresh: () => {
      if (!loading) void refresh();
    },
  };
}
