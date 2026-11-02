import type { Account, Candidate, Scan } from '../../domain/models';
import { normalizeForum, threadId } from '../../shared/validation';
// These selectors were inspected on the public desktop page on 2026-11-02.
// They are deliberately limited to reading. See docs/verification.md.
export const observedSelectors = {
  card: 'a.thread-content-link',
  pinned: 'a.top-thread-card-item',
  title: '.thread-title',
  author: '.head-name',
  time: '.desc-info',
  header: '#top-bar',
};
export function detectSession(doc: Document): Account {
  if (doc.querySelector('#com_userbar')) {
    const header = profileId(
      doc.querySelector('#com_userbar .u_username_wrap')?.getAttribute('href') ?? null,
    );
    const mine = profileId(
      doc.querySelector('#com_userbar .u_itieba a')?.getAttribute('href') ?? null,
    );
    const sidebar = profileId(
      doc.querySelector('#user_info > a.media_left')?.getAttribute('href') ?? null,
    );
    const avatar = portraitId(
      doc.querySelector('#user_info > a.media_left > img')?.getAttribute('src') ?? null,
    );
    if (header && header === mine && header === sidebar && header === avatar)
      return {
        id: header,
        label: '当前贴吧账号（身份已核对）',
        confirmed: true,
        reason: '旧版顶部个人中心、我的贴吧与侧栏头像/主页 ID 一致',
      };
    // Some legacy thread pages leave the top account slot empty indefinitely.
    // Only that observed structure may use the signed-in sidebar's three IDs.
    // Existing or partially rendered top identity links must never be ignored.
    const slot = doc.querySelector('#com_userbar #j_u_username');
    const nameLinks = Array.from(doc.querySelectorAll('#user_info .user_name a[href]')).filter(
      (a) => a.getAttribute('href')?.includes('/home/main'),
    );
    const sidebarName =
      nameLinks.length === 1 ? profileId(nameLinks[0].getAttribute('href')) : null;
    if (
      doc.querySelector('#j_p_postlist') &&
      slot &&
      slot.children.length === 0 &&
      !slot.textContent?.trim() &&
      !doc.querySelector('#com_userbar .u_username_wrap, #com_userbar .u_itieba') &&
      !/登录/.test(doc.querySelector('#com_userbar')?.textContent ?? '') &&
      sidebar &&
      sidebar === avatar &&
      sidebar === sidebarName
    )
      return {
        id: sidebar,
        label: '当前贴吧账号（身份已核对）',
        confirmed: true,
        reason: '旧版主题顶部账号槽为空；我在贴吧侧栏的头像、头像主页与昵称主页 ID 一致',
      };
    return {
      id: null,
      label: '身份未确认',
      confirmed: false,
      reason: '旧版账号交叉标识未就绪或不一致',
    };
  }
  const text = doc.querySelector(observedSelectors.header)?.textContent ?? '';
  if (text.includes('登录'))
    return { id: null, label: '未登录', confirmed: false, reason: '页面显示登录入口' };
  const profiles = new Set(
    Array.from(doc.querySelectorAll('a[href]'))
      .filter((a) => a.textContent?.trim() === '我的')
      .map((a) => profileId(a.getAttribute('href')))
      .filter(Boolean),
  );
  const avatars = Array.from(doc.querySelectorAll('#top-bar .user-or-login img.user-avatar')).map(
    (e) => {
      try {
        const u = new URL(e.getAttribute('src') ?? '');
        if (!['gss0.bdstatic.com', 'himg.bdimg.com'].includes(u.hostname)) return null;
        return u.pathname.match(/\/sys\/portrait\/item\/(tb\.[A-Za-z0-9._-]+)$/)?.[1] ?? null;
      } catch {
        return null;
      }
    },
  );
  if (profiles.size === 1 && avatars.length === 1 && avatars[0] && profiles.has(avatars[0]))
    return {
      id: avatars[0],
      label: '当前贴吧账号（身份已核对）',
      confirmed: true,
      reason: '头部用户标识与“我的”个人主页 ID 完全一致；不依据头像外观或昵称',
    };
  return {
    id: null,
    label: '身份未确认',
    confirmed: false,
    reason: '头部用户标识与“我的”主页链接缺失、冲突或结构不受支持',
  };
}
export function profileId(href: string | null): string | null {
  try {
    if (!href) return null;
    const u = new URL(href.trim(), 'https://tieba.baidu.com');
    const id = u.searchParams.get('id')?.replace(/\?t=\d+$/, '');
    return u.protocol === 'https:' &&
      u.hostname === 'tieba.baidu.com' &&
      !u.port &&
      !u.username &&
      !u.password &&
      ['/home/main', '/home/main/'].includes(u.pathname) &&
      id &&
      /^tb\.[A-Za-z0-9._-]+$/.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}
export function portraitId(src: string | null): string | null {
  try {
    const u = new URL(src ?? '', 'https://tieba.baidu.com');
    return u.protocol === 'https:' && ['gss0.bdstatic.com', 'himg.bdimg.com'].includes(u.hostname)
      ? (u.pathname.match(/\/sys\/portrait\/item\/(tb\.[A-Za-z0-9._-]+)$/)?.[1] ?? null)
      : null;
  } catch {
    return null;
  }
}
export function detectCurrentForum(url: string) {
  const u = new URL(url);
  if (u.hostname !== 'tieba.baidu.com' || !['/f', '/f/'].includes(u.pathname))
    throw Error('当前不是支持的贴吧列表页');
  return normalizeForum(url);
}
export function detectBlockingState(doc: Document): string | undefined {
  if (/安全验证|验证码/.test(doc.title)) return '贴吧安全验证：请在工作标签页中人工处理';
  if (/访问受限|访问被拒绝|出错/.test(doc.title)) return '页面访问受限，请人工检查';
  return undefined;
}
export function hasEditorMedia(el: Element) {
  return !!el.querySelector('img,video,audio,canvas,iframe,object,embed,svg');
}
export function hasEditableContent(el: Element) {
  return el instanceof HTMLTextAreaElement
    ? el.value.trim().length > 0
    : (el.textContent ?? '').trim().length > 0 || hasEditorMedia(el);
}
export function hasDraft(doc: Document) {
  return Array.from(doc.querySelectorAll('textarea,[contenteditable="true"]')).some(
    hasEditableContent,
  );
}
export function readThreadCandidates(doc: Document, url: string): Scan {
  const forum = detectCurrentForum(url);
  const account = detectSession(doc);
  const blocking = detectBlockingState(doc);
  const candidates: Candidate[] = [];
  const ids = new Set<string>();
  for (const el of Array.from(
    doc.querySelectorAll(`${observedSelectors.card},${observedSelectors.pinned}`),
  ).slice(0, 200)) {
    const id = threadId(el.getAttribute('href') ?? '');
    const titles = el.querySelectorAll(observedSelectors.title);
    if (!id || ids.has(id) || titles.length !== 1) continue;
    const author = el.querySelector(observedSelectors.author);
    const href = author?.getAttribute('href');
    let authorId: string | undefined;
    if (href) {
      try {
        const u = new URL(href);
        if (u.hostname === 'tieba.baidu.com' && u.pathname === '/home/main')
          authorId = u.searchParams.get('id') ?? undefined;
      } catch {}
    }
    const title = titles[0].textContent?.trim().slice(0, 500);
    if (!title) continue;
    const timeLabel = el.querySelector(observedSelectors.time)?.textContent?.trim().slice(0, 200);
    const kind = el.matches(observedSelectors.pinned)
      ? 'pinned'
      : el.querySelector('.thread-tag')?.textContent?.includes('广告')
        ? 'ad'
        : 'thread';
    candidates.push({
      id,
      title,
      author: author?.textContent?.trim().slice(0, 100) || '未显示',
      authorId,
      url: `https://tieba.baidu.com/p/${id}`,
      timeEvidence: timeLabel?.includes('发布于') ? 'relative' : 'unavailable',
      timeLabel,
      kind,
      source: '贴吧公开页面 DOM（2026-11-02 结构）',
    });
    ids.add(id);
  }
  return {
    forum,
    account,
    candidates,
    reliable: false,
    coverage: `仅当前已加载的 ${candidates.length} 条；相对时间或回复时间不足以核实主题创建时间，自动建任务已阻断`,
    blocking:
      blocking ??
      (candidates.length
        ? undefined
        : '未识别到已验证的帖子卡片；页面可能未加载、结构变化或访问受限'),
  };
}

export function useLegacyPage(doc: Document) {
  if (doc.querySelector('#thread_list,#j_p_postlist')) return { legacy: true };
  if (hasDraft(doc)) throw Error('页面有草稿，不能切换版本');
  const buttons = Array.from(doc.querySelectorAll<HTMLElement>('#top-bar .menu-item')).filter(
    (e) => e.querySelector('use')?.getAttribute('xlink:href') === '#back_old',
  );
  if (buttons.length !== 1) throw Error('未找到已验证的官方旧版入口，请在工作页人工切换');
  buttons[0].click();
  return { legacy: false, navigating: true };
}
