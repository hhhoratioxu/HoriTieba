import { detectSession, profileId, hasDraft } from './read-page';
import { threadId } from '../../shared/validation';
export interface RootObservation {
  id: string;
  authorId: string | null;
  text: string;
  nestedReplies: number;
  nestedRepliesWithStableId: number;
}
/** Read-only, observed 2026-11-02. This diagnostic never fills or clicks an editor. */
export function inspectThread(doc: Document, url: string) {
  const id = threadId(url);
  if (!id) throw Error('不是支持的主题页');
  const account = detectSession(doc);
  const roots: RootObservation[] = [];
  for (const el of Array.from(doc.querySelectorAll('.pb-comment-item[data-id]')).slice(0, 100)) {
    const commentId = el.getAttribute('data-id');
    if (!commentId || !/^\d+$/.test(commentId)) continue;
    const author = el.querySelector(':scope > .head-line .head-name');
    const content = el.querySelector(':scope > .comment-content > .pb-rich-text');
    const nested = el.querySelectorAll(':scope > .comment-content > .lzl-wrapper > .pb-lzl-item');
    roots.push({
      id: commentId,
      authorId: profileId(author?.getAttribute('href') ?? null),
      text: content?.textContent?.trim() ?? '',
      nestedReplies: nested.length,
      nestedRepliesWithStableId: Array.from(nested).filter((n) =>
        /^\d+$/.test(n.getAttribute('data-id') ?? ''),
      ).length,
    });
  }
  const editors = doc.querySelectorAll(
    '#tb-editor-pb-content > .ql-editor[contenteditable="true"]',
  );
  return {
    threadId: id,
    account,
    roots,
    ownRoots: account.confirmed ? roots.filter((r) => r.authorId === account.id) : [],
    rootEditorCount: editors.length,
    hasDraft: hasDraft(doc),
    selfReplyVerified: false as const,
    reason:
      '新版结构仅供只读诊断；当前新版楼中楼缺少可靠独立 ID，自动模式需使用已验证的官方旧版结构',
  };
}
