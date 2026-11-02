import {
  field,
  minuteTime,
  nestedIds,
  numericId,
  plainText,
  rootElement,
  safePageUrl,
} from './legacy';
import {
  checkWait,
  control,
  openReplyPanel,
  whenReady,
  writeReplyText,
  type PageWait,
} from './page-driver';
import {
  detectBlockingState,
  detectSession,
  hasDraft,
  hasEditableContent,
  hasEditorMedia,
  profileId,
} from './read-page';
import { PageNotReadyError } from '../platform';
import { threadId } from '../../shared/validation';
import type { ReplyEvidence, ReplyTarget, ThreadReplyRun } from '../../shared/thread-reply';

const rows = '.lzl_single_post';
const pagerSelector = '.lzl_pager, .j_pager';
const editorSelector = '.j_lzl_e_c [contenteditable="true"]';
const textOf = (node: Node | null) => node?.textContent?.replaceAll('\u00a0', ' ').trim() ?? '';
const waitFor = (signal: AbortSignal): PageWait => ({ signal, deadline: Date.now() + 18000 });

export function assertIdentity(
  doc: Document,
  url: string,
  run: Pick<ThreadReplyRun, 'thread' | 'account'>,
) {
  const blocking = detectBlockingState(doc);
  if (blocking) throw Error(blocking);
  if (
    [
      ...doc.querySelectorAll<HTMLElement>(
        '.tang-pass-pop-dialog,.vcode-dialog,.dialogJ,.dialogJcontent',
      ),
    ].some(
      (el) =>
        el.getClientRects().length &&
        /验证码|安全验证|操作频繁|发布失败|禁止发言|被封禁/.test(el.textContent ?? ''),
    )
  )
    throw Error('贴吧显示验证或发言限制，请查看页面。');
  const identity = detectSession(doc);
  if (threadId(url) !== run.thread || !identity.confirmed || identity.id !== run.account)
    throw Error('登录账号或帖子发生变化，已停止。');
}
export function nextThreadPage(doc: Document, url: string) {
  const tid = threadId(url);
  if (!tid) throw Error('帖子链接无效。');
  const current = Number(new URL(url).searchParams.get('pn') || 1);
  const link = Array.from(doc.querySelectorAll('.pb_list_pager a')).find(
    (a) => textOf(a) === '下一页',
  );
  const totalText = doc.querySelector('.l_reply_num')?.textContent ?? '';
  const total = Number(totalText.match(/共\s*(\d+)\s*页/)?.[1]);
  if (!link) {
    if (total > current) throw Error('还有帖子分页，但下一页入口未就绪。');
    return null;
  }
  const next = safePageUrl(new URL(link.getAttribute('href') ?? '', url).href, tid);
  if (!next || Number(new URL(next).searchParams.get('pn')) !== current + 1)
    throw Error('下一页不属于本帖或页码不连续。');
  return next;
}
function readFloor(el: HTMLElement, thread: string) {
  const post = field(el),
    id = numericId(post?.content?.post_id),
    floor = post?.content?.post_no;
  const authorId = profileId(
    el.querySelector(':scope > .d_author .p_author_name')?.getAttribute('href') ?? null,
  );
  if (
    !id ||
    id !== el.dataset.pid ||
    numericId(post?.content?.thread_id) !== thread ||
    !Number.isSafeInteger(floor) ||
    floor < 1 ||
    !authorId ||
    authorId !== post?.author?.portrait?.replace(/\?t=\d+$/, '')
  )
    return null;
  return { id, floor: floor as number, authorId };
}
export function floorList(doc: Document, url: string) {
  const thread = threadId(url);
  if (!thread) throw Error('帖子链接无效。');
  const nodes = Array.from(doc.querySelectorAll<HTMLElement>('#j_p_postlist > .l_post[data-pid]'));
  const floors = nodes.map((el) => readFloor(el, thread)).filter((f) => f !== null);
  if (!floors.length) throw new PageNotReadyError('尚未找到可以核对编号和作者的楼层。');
  if (new Set(floors.map((f) => f.id)).size !== floors.length)
    throw Error('同一页出现了重复的楼层编号。');
  return { floors, unavailable: nodes.length - floors.length };
}
function replyBody(el: Element) {
  const mention = el.querySelector(':scope > a.at[portrait]');
  if (
    !mention ||
    textOf(mention.previousSibling) !== '回复' ||
    !/^\s*[:：]/.test(mention.nextSibling?.textContent ?? '')
  )
    return { recipient: null, text: plainText(el) };
  const recipient = mention.getAttribute('portrait')?.replace(/\?t=\d+$/, '') ?? '';
  const tail = el.ownerDocument.createElement('div');
  for (let node = mention.nextSibling; node; node = node.nextSibling)
    tail.append(node.cloneNode(true));
  return { recipient, text: plainText(tail).replace(/^\s*[:：]\s*/, '') };
}
function children(panel: HTMLElement, root: string) {
  const result: { id: string; evidence?: ReplyEvidence }[] = [];
  for (const row of panel.querySelectorAll(rows)) {
    const { pid, spid } = nestedIds(row);
    if (pid !== root || !spid) throw new PageNotReadyError('楼中楼的正式编号尚未就绪。');
    const author = profileId(
      row.querySelector('.lzl_cnt > a.j_user_card')?.getAttribute('href') ?? null,
    );
    const avatar = profileId(row.querySelector(':scope > a.lzl_p_p')?.getAttribute('href') ?? null);
    const body = row.querySelector('.lzl_cnt > .lzl_content_main');
    const createdAt = minuteTime(textOf(row.querySelector('.lzl_time')));
    // An anonymous/deleted row still belongs to the before-ID snapshot. Only identified rows can be targets or proof.
    const evidence =
      author && author === avatar && body && createdAt !== undefined
        ? { id: spid, rootId: root, author, createdAt, ...replyBody(body) }
        : undefined;
    result.push({ id: spid, evidence });
  }
  return result;
}
function pageNo(panel: HTMLElement) {
  const current = panel.querySelector(pagerSelector)?.querySelector('.tP,[aria-current="page"]');
  return current ? Number(textOf(current)) : 1;
}
function pageLink(panel: HTMLElement, page: number) {
  const pager = panel.querySelector(pagerSelector);
  return Array.from(pager?.querySelectorAll<HTMLAnchorElement>('a') ?? []).find((a) => {
    const href = a.getAttribute('href') ?? '';
    return href === '#' + page || (textOf(a) === String(page) && /^#/.test(href));
  });
}
async function turn(panel: HTMLElement, page: number, signal: AbortSignal) {
  if (pageNo(panel) === page) return;
  const link = pageLink(panel, page);
  if (!link) throw Error('这层还有分页，但未找到对应的楼中楼页码。');
  const old = panel.querySelector(rows);
  const wait = waitFor(signal);
  checkWait(wait, '楼中楼翻页');
  link.click();
  await whenReady(panel, wait, '楼中楼翻页', () =>
    pageNo(panel) === page &&
    !panel.querySelector('.loading_reply') &&
    (!old || old !== panel.querySelector(rows))
      ? true
      : undefined,
  );
}
export async function inspectFloor(doc: Document, id: string, signal: AbortSignal) {
  const root = rootElement(doc, id);
  const panel = await openReplyPanel(doc, id, waitFor(signal));
  // The native widget sometimes starts as a short preview, before installing its pager.
  const total = Number(field(panel)?.total_num);
  if (!Number.isSafeInteger(total) || total < 0) throw Error('楼中楼总数尚未就绪。');
  if (panel.querySelectorAll(rows).length < total && !panel.querySelector(pagerSelector)) {
    const more = Array.from(panel.querySelectorAll<HTMLElement>('a')).find((el) =>
      /点击查看|查看全部|查看更多|查看剩余/.test(textOf(el)),
    );
    if (more) {
      more.click();
      await whenReady(root, waitFor(signal), '完整的楼中楼列表', () =>
        panel.querySelector(pagerSelector) || panel.querySelectorAll(rows).length >= total
          ? true
          : undefined,
      );
    }
  }
  const pages = new Map<string, number>();
  const replies: ReplyEvidence[] = [];
  let n = 1;
  for (; ; n++) {
    await turn(panel, n, signal);
    checkWait(waitFor(signal), '读取评论');
    for (const c of children(panel, id)) {
      if (pages.has(c.id)) throw new PageNotReadyError('楼中楼翻页时内容变化，需重新读取。');
      pages.set(c.id, n);
      if (c.evidence) replies.push(c.evidence);
    }
    if (!pageLink(panel, n + 1)) break;
  }
  if (pages.size !== Number(field(panel)?.total_num))
    throw new PageNotReadyError('楼中楼数量与翻页结果不一致。');
  return { panel, pages, replies };
}
function findRow(panel: HTMLElement, target: ReplyTarget) {
  const found = Array.from(panel.querySelectorAll<HTMLElement>(rows)).filter((el) => {
    const { pid, spid } = nestedIds(el);
    return pid === target.rootId && spid === target.id;
  });
  if (
    found.length !== 1 ||
    profileId(found[0].querySelector('.lzl_cnt > .j_user_card')?.getAttribute('href') ?? null) !==
      target.author
  )
    throw Error('原评论或作者发生变化。');
  return found[0];
}
function nativePrefix(editor: HTMLElement, author: string) {
  const tag = editor.querySelector(':scope > span.ubb_showname[use="reply"]');
  const children = Array.from(editor.childNodes);
  return (
    children.length >= 3 &&
    tag === children[1] &&
    textOf(children[0]) === '回复' &&
    tag?.getAttribute('portrait')?.replace(/\?t=\d+$/, '') === author &&
    /^\s*[:：]\s*$/.test(children[2].textContent ?? '')
  );
}
export async function prepareReply(
  doc: Document,
  run: ThreadReplyRun,
  target: ReplyTarget,
  signal: AbortSignal,
) {
  const identity = () => assertIdentity(doc, doc.location.href, run);
  const validateRoot = () => {
    identity();
    const root = rootElement(doc, target.rootId);
    const data = readFloor(root, run.thread);
    if (
      !data ||
      target.author === run.account ||
      (target.rootId === target.id && (data.floor <= 1 || data.authorId !== target.author))
    )
      throw Error('原楼层或作者无法核对。');
    return root;
  };
  validateRoot();
  if (hasDraft(doc)) throw Error('帖子里有草稿，请先处理草稿。');
  const { panel, pages } = await inspectFloor(doc, target.rootId, signal);
  const nested = target.id !== target.rootId;
  const page = nested ? pages.get(target.id) : 1;
  if (!page) throw Error('原评论已移除或已换页。');
  // Pager windows can hide distant pages. Page one is always exposed as a native link.
  if (pageNo(panel) !== page) {
    await turn(panel, 1, signal);
    for (let n = 2; n <= page; n++) await turn(panel, n, signal);
  }
  const wait = waitFor(signal);
  const row = nested ? findRow(panel, target) : null;
  const action = row ? control(row, 'a.lzl_s_r') : control(panel, '.j_lzl_p');
  // On Tieba the per-comment "回复" link may only be painted on hover, but still exists on its row.
  const targetButton = row?.querySelectorAll<HTMLElement>('a.lzl_s_r');
  if (row && targetButton?.length !== 1) throw Error('原评论的回复按钮不唯一。');
  if (hasDraft(doc)) throw Error('帖子里有草稿，请先处理草稿。');
  const clicked = action ?? targetButton?.[0];
  if (nested && !clicked) throw Error('没有找到原评论的回复按钮。');
  checkWait(wait, '打开回复框');
  if (nested || !control(panel, editorSelector)) {
    if (!clicked) throw Error('该楼层的回复入口尚未就绪。');
    clicked.click();
  }
  const editor = await whenReady(panel, wait, '回复编辑器', () => {
    const e = control(panel, editorSelector);
    return e && (!nested || nativePrefix(e, target.author)) ? e : undefined;
  });
  const button = await whenReady(panel, wait, '发表按钮', () =>
    control(panel, '.j_lzl_e_c .j_lzl_p_sb'),
  );
  const prefix = plainText(editor);
  if (
    (nested && (editor.childNodes.length !== 3 || !nativePrefix(editor, target.author))) ||
    (!nested && hasEditableContent(editor))
  )
    throw Error('编辑器中存在草稿或回复对象不明确。');
  const guard = (filled: boolean) => {
    const root = validateRoot();
    checkWait(wait, '发表');
    if (
      row &&
      (!row.isConnected ||
        findRow(panel, target) !== row ||
        pageNo(panel) !== page ||
        !nativePrefix(editor, target.author))
    )
      throw Error('楼中楼原评论或收件人已改变。');
    if (
      !panel.isConnected ||
      String(field(panel)?.pid) !== target.rootId ||
      Number(field(panel)?.total_num) !== pages.size ||
      Array.from(panel.querySelectorAll(rows)).some((el) => !pages.has(nestedIds(el).spid ?? '')) ||
      editor.closest('.l_post') !== root ||
      button.closest('.l_post') !== root ||
      control(panel, editorSelector) !== editor ||
      control(panel, '.j_lzl_e_c .j_lzl_p_sb') !== button ||
      button.matches('[disabled], [aria-disabled=true], .disabled') ||
      hasEditorMedia(editor) ||
      Array.from(doc.querySelectorAll('textarea,[contenteditable=true]')).some(
        (el) => el !== editor && hasEditableContent(el),
      ) ||
      plainText(editor) !== (filled ? prefix + run.text : prefix)
    )
      throw Error('账号、编辑器或草稿状态发生变化。');
  };
  return {
    before: Array.from(pages.keys()),
    fill: () => {
      guard(false);
      editor.focus();
      writeReplyText(editor, run.text, nested);
      guard(true);
    },
    submit: () => {
      guard(true);
      button.click();
    },
  };
}
