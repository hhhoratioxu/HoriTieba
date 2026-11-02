import { mountActionBar } from './action-bar';
import {
  assertIdentity,
  floorList,
  inspectFloor,
  nextThreadPage,
  prepareReply,
} from '../adapters/tieba/thread-replies';
import { detectSession, hasDraft, useLegacyPage } from '../adapters/tieba/read-page';
import { field, rootElement } from '../adapters/tieba/legacy';
import { whenReady } from '../adapters/tieba/page-driver';
import { PageNotReadyError } from '../adapters/platform';
import { threadId } from '../shared/validation';
import {
  matchesReply,
  replyInterval,
  type CommandBody,
  type ReplyTarget,
  type ThreadReplyRun,
} from '../shared/thread-reply';

function wait(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(Error('已停止'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export function installThreadReplies(documentToken: string, lifetime: AbortSignal) {
  const thread = threadId(location.href);
  if (
    !thread ||
    window !== window.top ||
    !document.body ||
    document.getElementById('horitieba-thread-replies')
  )
    return;
  const base = 'https://tieba.baidu.com/p/' + thread;
  const { input, button, skip, status, focus } = mountActionBar(
    'horitieba-thread-replies',
    '自动回复',
    '回复本帖的评论和楼中楼',
    lifetime,
  );
  let run: ThreadReplyRun | null = null,
    controller: AbortController | undefined,
    busy = true;
  const rpc = async <T>(body: CommandBody): Promise<T> => {
    const result = await chrome.runtime.sendMessage({
      ...body,
      thread,
      document: documentToken,
      type: 'HORITIEBA_THREAD_REPLY',
    });
    if (!result?.ok) throw Error(result?.error ?? '扩展连接已更新，请刷新此帖。');
    return result.data as T;
  };
  function show(message = '') {
    const active = !!run?.running,
      unknown = !!run?.pending && !active;
    input.readOnly = active || unknown;
    button.textContent = active ? '停止' : unknown ? '核实' : '开始';
    button.disabled = busy || (!active && !unknown && !input.value.trim());
    skip.hidden = !unknown;
    if (active || unknown) input.value = run!.text;
    status.textContent =
      (run ? '已回复 ' + run.sent + ' 条 · ' : '') +
      (message || run?.reason || (active ? '运行中' : ''));
  }
  const reloadOrGo = (to: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (threadId(location.href) !== thread || threadId(to) !== thread || hasDraft(document))
      throw Error('帖子已切换或页面里有草稿，已停止翻页。');
    if (location.href === to) location.reload();
    else location.replace(to);
  };
  async function verify(r: ThreadReplyRun, signal: AbortSignal) {
    const pending = r.pending!;
    const end = Date.now() + (pending.document === documentToken ? 2500 : 5000);
    let problem = '未找到唯一的新回复编号';
    for (;;) {
      signal.throwIfAborted();
      assertIdentity(document, location.href, r);
      try {
        const floor = await inspectFloor(document, pending.target.rootId, signal);
        const found = floor.replies.filter((e) => matchesReply(r, e, Date.now()));
        if (found.length === 1) {
          run = await rpc<ThreadReplyRun>({
            op: 'verified',
            run: r.id,
            attempt: pending.id,
            evidence: found[0],
          });
          show();
          return true;
        }
        if (found.length > 1) {
          problem = '出现多条相同的新回复';
          break;
        }
      } catch (e) {
        if (!(e instanceof PageNotReadyError)) throw e;
        problem = e.message;
      }
      if (Date.now() >= end) break;
      await wait(450, signal);
    }
    if (
      r.running &&
      pending.document === documentToken &&
      !pending.refreshed &&
      !hasDraft(document)
    ) {
      await rpc({ op: 'refresh', run: r.id, attempt: pending.id });
      reloadOrGo(location.href, signal);
      return false;
    }
    throw Error(problem + '。已停止，原评论不会重发。');
  }
  async function process(r: ThreadReplyRun, signal: AbortSignal) {
    if (!document.querySelector('#j_p_postlist')) {
      if (r.pending) throw Error('请切回旧版主题页核实上次回复。');
      assertIdentity(document, location.href, r);
      useLegacyPage(document);
      return;
    }
    await whenReady(
      document.documentElement,
      { signal, deadline: Date.now() + 20000 },
      '登录账号',
      () => (detectSession(document).confirmed ? true : undefined),
    );
    assertIdentity(document, location.href, r);
    if (r.pending) {
      show('正在核实上次回复');
      if (!(await verify(r, signal)) || !run?.running) return;
      r = run;
    }
    if (!r.running) return;
    const query = new URL(location.href).searchParams;
    if ([...query.keys()].some((k) => k !== 'pn')) {
      reloadOrGo(base, signal);
      return;
    }
    if (hasDraft(document)) throw Error('帖子里有草稿，请先处理草稿。');
    const page = floorList(document, location.href);
    let unavailable = page.unavailable;
    for (const floor of page.floors) {
      signal.throwIfAborted();
      assertIdentity(document, location.href, r);
      const level = rootElement(document, floor.id);
      const known = field(level)?.content?.comment_num;
      const hinted = field(level.querySelector('.j_lzl_container'))?.total_num;
      const candidates: ReplyTarget[] = [];
      if ((floor.floor ?? 0) > 1 && floor.authorId !== r.account)
        candidates.push({ rootId: floor.id, id: floor.id, author: floor.authorId });
      if (known !== 0 || Number(hinted) > 0 || level.querySelector('.lzl_single_post')) {
        show('正在读取第 ' + floor.floor + ' 楼的评论');
        const observed = await inspectFloor(document, floor.id, signal);
        unavailable += observed.pages.size - observed.replies.length;
        for (const c of observed.replies)
          if (c.author !== r.account)
            candidates.push({ rootId: floor.id, id: c.id, author: c.author });
      }
      for (let i = 0; i < candidates.length; i += 300) {
        const batch = candidates.slice(i, i + 300);
        const done = new Set(
          await rpc<string[]>({ op: 'seen', run: r.id, ids: batch.map((c) => c.id) }),
        );
        for (const target of batch) {
          if (done.has(target.id)) continue;
          if (r.nextAt > Date.now()) {
            show('等待下一条回复');
            await wait(r.nextAt - Date.now(), signal);
          }
          signal.throwIfAborted();
          show(
            '正在回复第 ' + floor.floor + ' 楼' + (target.id !== target.rootId ? '内的评论' : ''),
          );
          for (;;) {
            signal.throwIfAborted();
            const due = await rpc<number>({ op: 'turn', run: r.id });
            if (!due) break;
            show('等待发送间隔');
            await wait(Math.min(5000, Math.max(100, due - Date.now())), signal);
          }
          const editor = await prepareReply(document, r, target, signal);
          editor.fill();
          const t = Date.now();
          const permitted = await rpc<ThreadReplyRun>({
            op: 'permit',
            run: r.id,
            account: r.account,
            target,
            before: editor.before,
          });
          run = r = permitted;
          signal.throwIfAborted();
          if (Date.now() - t >= 5000) throw Error('发送许可已经过期，草稿已保留。');
          editor.submit();
          show('正在核实已提交的回复');
          if (!(await verify(r, signal)) || !run?.running) return;
          r = run;
        }
      }
    }
    const next = nextThreadPage(document, location.href);
    if (next) {
      show('正在读取下一页');
      reloadOrGo(next, signal);
      return;
    }
    show(
      '已有评论已检查，正在等新评论' +
        (unavailable ? '（本页有 ' + unavailable + ' 条身份无法核对）' : ''),
    );
    await wait(replyInterval, signal);
    reloadOrGo(base, signal);
  }
  function launch() {
    controller?.abort();
    if (!run || (!run.running && !run.pending)) return;
    const c = new AbortController();
    controller = c;
    const id = run.id;
    const runPage = async () => {
      for (let retry = 0; run && run.id === id; retry++) {
        try {
          await process(run, c.signal);
          return;
        } catch (error) {
          if (
            !(error instanceof PageNotReadyError) ||
            retry >= 2 ||
            c.signal.aborted ||
            run.pending ||
            hasDraft(document)
          )
            throw error;
          if (
            retry === 1 &&
            (await rpc<boolean>({
              op: 'recover',
              run: id,
              page: Number(new URL(location.href).searchParams.get('pn') || 1),
            }))
          ) {
            show('正在重新加载本页的评论区');
            reloadOrGo(location.href, c.signal);
            return;
          }
          show('评论区还在加载，正在自动重试');
          await wait(3000 * (retry + 1), c.signal);
        }
      }
    };
    void runPage().catch(async (e) => {
      if (c.signal.aborted || run?.id !== id) return;
      const reason = e instanceof Error ? e.message : '读取评论失败。';
      try {
        run = await rpc<ThreadReplyRun>({ op: 'pause', run: id, reason: reason.slice(0, 450) });
      } catch {}
      show(reason);
    });
  }
  async function restore() {
    try {
      const restored = await rpc<ThreadReplyRun | null>({ op: 'state' });
      if (lifetime.aborted) return;
      run = restored;
      busy = false;
      if (run) input.value = run.text;
      show();
      if (run?.running) launch();
    } catch (e) {
      busy = false;
      show(e instanceof Error ? e.message : '请刷新本帖。');
    }
  }
  input.addEventListener('input', () => show());
  button.addEventListener('click', async (event) => {
    if (!event.isTrusted || busy) return;
    busy = true;
    show();
    try {
      if (run?.running) {
        controller?.abort();
        run = await rpc<ThreadReplyRun>({ op: 'stop', run: run.id });
      } else if (run?.pending) {
        launch();
      } else {
        show('正在核对当前贴吧账号');
        const account = await whenReady(
          document.documentElement,
          { signal: new AbortController().signal, deadline: Date.now() + 8000 },
          '登录账号',
          () => {
            const value = detectSession(document);
            if (value.label === '未登录') throw Error('请先登录贴吧，登录后刷新本帖。');
            return value.confirmed && value.id ? value.id : undefined;
          },
        ).catch(() => {
          throw Error('请确认已在这个 Chrome 标签页登录贴吧，然后刷新本帖。');
        });
        if (hasDraft(document)) throw Error('帖子里有草稿，请先处理草稿。');
        lifetime.throwIfAborted();
        run = await rpc<ThreadReplyRun>({
          op: 'start',
          account,
          text: input.value.trim(),
        });
        if (location.href !== base) reloadOrGo(base, new AbortController().signal);
        else launch();
      }
      busy = false;
      show();
    } catch (e) {
      busy = false;
      show(e instanceof Error ? e.message : '启动失败');
    }
  });
  skip.addEventListener('click', async (e) => {
    if (!e.isTrusted || !run?.pending || busy) return;
    controller?.abort();
    busy = true;
    try {
      run = await rpc<ThreadReplyRun>({ op: 'skip', run: run.id });
      busy = false;
      show();
    } catch (e) {
      busy = false;
      show(String(e));
    }
  });
  document.addEventListener(
    'click',
    (e) => {
      if (
        !e.isTrusted ||
        !run?.running ||
        !(e.target instanceof Element) ||
        !e.target.closest('.lzl_s_r,.j_lzl_p,.p_reply,.lzl_pager a,.j_lzl_p_sb,.j_submit')
      )
        return;
      controller?.abort();
      void rpc<ThreadReplyRun>({
        op: 'pause',
        run: run.id,
        reason: '你正在使用原生回复控件，自动回复已暂停。',
      })
        .then((r) => {
          run = r;
          show();
        })
        .catch(() => {});
    },
    { capture: true, signal: lifetime },
  );
  lifetime.addEventListener('abort', () => controller?.abort(), { once: true });
  addEventListener('pagehide', () => controller?.abort(), { signal: lifetime });
  addEventListener(
    'pageshow',
    (e) => {
      if (e.persisted) void restore();
    },
    { signal: lifetime },
  );
  show();
  void restore();
  return focus;
}
