import { BlockedError, ThreadUnavailableError } from '../platform';
import type { Candidate, Evidence, Attempt, Scan, Account } from '../../domain/models';
import { detectSession, profileId, detectBlockingState, detectCurrentForum } from './read-page';
import { threadId, normalizeForum } from '../../shared/validation';
import { validEvidence } from '../../domain/policies';

// All selectors/attributes below were observed through the site's official “旧版” UI.
// Only DOM attributes are read; never evaluate data-field or inspect page JS/cookies.
export function field(el: Element | null): Record<string, any> | null {
  try {
    const v = JSON.parse(el?.getAttribute('data-field') ?? 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
export function numericId(v: unknown): string | null {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) return null;
  return (typeof v === 'string' || typeof v === 'number') && /^[1-9]\d{0,19}$/.test(String(v))
    ? String(v)
    : null;
}
export function minuteTime(text: string): number | undefined {
  const m = text
    .trim()
    .replace(/\u00a0/g, ' ')
    .match(/^(20\d{2})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})$/);
  if (!m) return;
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}:00+08:00`;
  const n = Date.parse(iso);
  if (!Number.isFinite(n)) return;
  // Reject silently normalized invalid days and hours.
  if (new Date(n + 8 * 3600_000).toISOString().slice(0, 16) !== iso.slice(0, 16)) return;
  return n;
}
export function plainText(el: Element | null): string {
  if (!el) return '';
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'IMG') return node.getAttribute('alt') ?? '\uFFFC';
    if (['SCRIPT', 'STYLE'].includes(node.tagName)) return '';
    const text = Array.from(node.childNodes).map(walk).join('');
    return text + (['P', 'DIV'].includes(node.tagName) ? '\n' : '');
  };
  return Array.from(el.childNodes)
    .map(walk)
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim();
}
export function safePageUrl(href: string, id: string): string | undefined {
  if (threadId(href) !== id) return;
  const u = new URL(href, 'https://tieba.baidu.com');
  const pn = u.searchParams.get('pn');
  if (pn && !/^[1-9]\d{0,5}$/.test(pn)) return;
  return `https://tieba.baidu.com/p/${id}${pn ? '?pn=' + pn : ''}`;
}
export function legacyList(doc: Document, url: string): Scan {
  const candidates: Candidate[] = [];
  const ids = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll('#thread_list .j_thread_list[data-tid]')).slice(
    0,
    100,
  )) {
    const d = field(el);
    const id = numericId(d?.id);
    const link = el.querySelector('.threadlist_title a.j_th_tit');
    const author = el.querySelector('.threadlist_author .frs-author-name');
    if (
      !id ||
      id !== el.getAttribute('data-tid') ||
      threadId(link?.getAttribute('href') ?? '') !== id ||
      ids.has(id)
    )
      continue;
    const title = link?.textContent?.trim().slice(0, 500);
    const authorId = profileId(author?.getAttribute('href') ?? null);
    if (!title || !authorId || authorId !== d?.author_portrait) continue;
    const kind =
      d.is_top || el.classList.contains('thread_top')
        ? 'pinned'
        : d.is_protal || d.is_membertop || d.is_multi_forum
          ? 'recommended'
          : 'thread';
    candidates.push({
      id,
      title,
      author: author?.textContent?.trim().slice(0, 100) ?? '未显示',
      authorId,
      url: `https://tieba.baidu.com/p/${id}`,
      timeLabel: el.querySelector('[title="创建时间"]')?.textContent?.trim(),
      timeEvidence: 'unavailable',
      timeCheckPending: kind === 'thread',
      kind,
      source: '贴吧旧版列表 DOM；创建时间待主题一楼核实',
    });
    ids.add(id);
  }
  return {
    forum: detectCurrentForum(url),
    account: detectSession(doc),
    candidates,
    reliable: true,
    coverage: `当前旧版列表 ${candidates.length} 条；仅经主题一楼完整时间核实的新增主题可入队`,
    blocking:
      detectBlockingState(doc) ?? (candidates.length ? undefined : '旧版列表未就绪或结构已变化'),
  };
}
export interface CommentObservation {
  id: string;
  rootId: string;
  authorId: string;
  text: string;
  createdAt: number;
  timePrecisionMs: 60000;
  floor?: number;
  direct: boolean;
}
export interface ThreadObservation {
  threadId: string;
  forum: string;
  account: Account;
  comments: CommentObservation[];
  publishedAt?: number;
  title: string;
  lastPage?: string;
  pageUrl: string;
  rootEditorReady: boolean;
  blocking?: string;
  invalidComments: number;
}
export function rootElement(doc: Document, id: string): HTMLElement {
  if (!numericId(id)) throw Error('一级评论编号无效');
  const nodes = doc.querySelectorAll<HTMLElement>(`#j_p_postlist > .l_post[data-pid="${id}"]`);
  if (nodes.length !== 1) throw Error('目标首评不在已加载页面或编号重复');
  return nodes[0];
}
export function nestedIds(nested: Element) {
  // The legacy renderer emits single-quoted fields. Read only the fixed numeric prefix;
  // never execute the string or globally replace quotes in user supplied names.
  const raw = nested.getAttribute('data-field') ?? '';
  const pair = raw.match(
    /^\{\s*'pid'\s*:\s*'([1-9]\d{0,19})'\s*,\s*'spid'\s*:\s*'([1-9]\d{0,19})'\s*,/,
  );
  const json = field(nested);
  return { pid: pair?.[1] ?? numericId(json?.pid), spid: pair?.[2] ?? numericId(json?.spid) };
}
export function legacyThread(doc: Document, url: string): ThreadObservation {
  const tid = threadId(url);
  if (!tid) throw Error('主题链接无效');
  const blocked = detectBlockingState(doc);
  if (blocked) throw new BlockedError(blocked);
  if (
    !doc.querySelector('#j_p_postlist') &&
    /^(?:百度)?贴吧\s*404$/.test(doc.title.trim()) &&
    Array.from(doc.querySelectorAll('h1,h2')).some((h) =>
      /(?:该[贴帖]|该主题)(?:子)?已被删除|该[贴帖]子?不存在/.test(h.textContent ?? ''),
    )
  ) {
    throw new ThreadUnavailableError('贴吧已确认该帖被删除或不存在');
  }
  if (!doc.querySelector('#j_p_postlist')) throw Error('主题旧版页面未就绪');
  const forumHref = doc.querySelector('#tab_forumname')?.getAttribute('href');
  if (!forumHref) throw Error('缺少主题所属贴吧');
  const forum = normalizeForum(new URL(forumHref, 'https://tieba.baidu.com').href);
  const comments: CommentObservation[] = [];
  let publishedAt: number | undefined;
  let invalidComments = 0;
  const seen = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll('#j_p_postlist > .l_post[data-pid]')).slice(
    0,
    100,
  )) {
    const f = field(el),
      id = numericId(f?.content?.post_id);
    const authorId = profileId(
      el.querySelector(':scope > .d_author .p_author_name')?.getAttribute('href') ?? null,
    );
    const portrait =
      typeof f?.author?.portrait === 'string' ? f.author.portrait.replace(/\?t=\d+$/, '') : null;
    const tail = Array.from(
      el.querySelectorAll(
        ':scope > .d_post_content_main > .core_reply > .core_reply_tail .tail-info',
      ),
    );
    const times = tail
      .map((e) => minuteTime(e.textContent ?? ''))
      .filter((t): t is number => t !== undefined);
    const floor = f?.content?.post_no;
    const floorText = tail.filter((e) => e.textContent?.trim() === `${floor}楼`);
    const content = id ? el.querySelector(`#post_content_${id}`) : null;
    if (
      !id ||
      seen.has(id) ||
      id !== el.getAttribute('data-pid') ||
      numericId(f?.content?.thread_id) !== tid ||
      !authorId ||
      authorId !== portrait ||
      times.length !== 1 ||
      !Number.isSafeInteger(floor) ||
      floorText.length !== 1 ||
      !content
    ) {
      invalidComments++;
      continue;
    }
    seen.add(id);
    if (floor === 1) publishedAt = times[0];
    comments.push({
      id,
      rootId: id,
      authorId,
      text: plainText(content),
      createdAt: times[0],
      timePrecisionMs: 60000,
      floor,
      direct: true,
    });
    for (const nested of Array.from(el.querySelectorAll('.j_lzl_container .lzl_single_post')).slice(
      0,
      200,
    )) {
      const { pid, spid } = nestedIds(nested);
      const author = profileId(
        nested.querySelector(':scope > .lzl_cnt > a.j_user_card')?.getAttribute('href') ?? null,
      );
      const avatar = profileId(
        nested.querySelector(':scope > a.lzl_p_p')?.getAttribute('href') ?? null,
      );
      const body = nested.querySelector(':scope > .lzl_cnt > .lzl_content_main');
      const createdAt = minuteTime(nested.querySelector('.lzl_time')?.textContent ?? '');
      if (
        pid !== id ||
        !spid ||
        seen.has(spid) ||
        !author ||
        author !== avatar ||
        !body ||
        createdAt === undefined
      ) {
        invalidComments++;
        continue;
      }
      seen.add(spid);
      comments.push({
        id: spid,
        rootId: id,
        authorId: author,
        text: plainText(body),
        createdAt,
        timePrecisionMs: 60000,
        direct: !body.querySelector('a.at[portrait]'),
      });
    }
  }
  const last = Array.from(doc.querySelectorAll('.pb_list_pager a')).find(
    (e) => e.textContent?.trim() === '尾页',
  );
  return {
    threadId: tid,
    forum,
    account: detectSession(doc),
    comments,
    publishedAt,
    title: doc.querySelector('.core_title_txt')?.textContent?.trim().slice(0, 500) ?? '',
    pageUrl: safePageUrl(url, tid)!,
    lastPage: last ? safePageUrl(last.getAttribute('href') ?? '', tid) : undefined,
    rootEditorReady:
      doc.querySelectorAll('#tb_rich_poster #ueditor_replace[contenteditable="true"]').length === 1,
    invalidComments,
  };
}
export function evidenceFromPage(
  a: Attempt,
  page: ThreadObservation,
  now = Date.now(),
): Evidence | undefined {
  if (
    !page.account.confirmed ||
    page.account.id !== a.accountId ||
    page.threadId !== a.target.threadId
  )
    return;
  if (
    a.stage !== 'root' &&
    !page.comments.some(
      (c) => c.id === a.target.rootId && c.rootId === c.id && c.authorId === a.accountId,
    )
  )
    return;
  const candidates = page.comments
    .filter((c) =>
      a.stage === 'root'
        ? c.id === c.rootId && (c.floor ?? 0) > 1
        : c.id !== c.rootId && c.rootId === a.target.rootId && c.direct,
    )
    .map((c) => ({
      commentId: c.id,
      authorId: c.authorId,
      threadId: page.threadId,
      rootId: c.rootId,
      targetId: a.stage === 'root' ? null : c.rootId,
      text: c.text,
      createdAt: c.createdAt,
      timePrecisionMs: 60000,
      observedAt: now,
      source: 'dom' as const,
      pageUrl: page.pageUrl,
      note: '旧版评论 ID、作者主页 ID、父评论 ID 与分钟时间；唯一新增内容匹配',
    }))
    .filter((e) => validEvidence(a, e));
  return candidates.length === 1 ? candidates[0] : undefined;
}
