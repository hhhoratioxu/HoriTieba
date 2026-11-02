import type { Candidate, Config, Attempt, Evidence, Prepared, Task, Target } from './models';
export function sameTarget(a: Target, b: Target) {
  return (
    a.threadId === b.threadId &&
    a.rootId === b.rootId &&
    a.commentId === b.commentId &&
    a.authorId === b.authorId &&
    a.relation === b.relation &&
    a.pageUrl === b.pageUrl
  );
}
export function filterThread(t: Candidate, c: Config): string | null {
  if (t.kind !== 'thread') return { pinned: '置顶帖', ad: '广告', recommended: '推荐帖' }[t.kind];
  const title = t.title.toLocaleLowerCase();
  const includes = c.include.map((k) => title.includes(k.toLocaleLowerCase()));
  if (includes.length && !(c.match === 'any' ? includes.some(Boolean) : includes.every(Boolean)))
    return '标题不符合包含规则';
  if (c.exclude.some((k) => title.includes(k.toLocaleLowerCase()))) return '标题命中排除规则';
  if (c.authors.some((a) => a === t.author || a === t.authorId)) return '作者已排除';
  return null;
}
export function assertPrepared(task: Task, stage: string, p: Prepared) {
  if (!p.account.confirmed || !p.account.id || p.account.id !== task.account.id)
    throw Error('账号变化或身份未确认');
  if (p.target.threadId !== task.thread.id) throw Error('帖子目标不一致');
  if (p.target.authorId !== task.account.id) throw Error('回复目标不属于当前账号');
  if (stage === 'root') {
    if (p.target.relation !== 'root' || p.target.commentId || p.target.rootId)
      throw Error('首评编辑器上下文错误');
  } else if (
    p.target.relation !== 'self-root' ||
    !task.root ||
    p.target.rootId !== task.root.rootId ||
    p.target.commentId !== task.root.rootId
  )
    throw Error('无法确认自己的首评楼层，禁止切换回复对象');
}
export function validEvidence(a: Attempt, e: Evidence): boolean {
  return (
    !!e.commentId &&
    !a.beforeIds.includes(e.commentId) &&
    e.authorId === a.accountId &&
    e.threadId === a.target.threadId &&
    e.text === a.text &&
    e.createdAt + (e.timePrecisionMs ?? 1) > a.intendedAt - 2000 &&
    [1, 60000].includes(e.timePrecisionMs ?? 1) &&
    e.createdAt <= e.observedAt + 2000 &&
    (a.stage === 'root'
      ? e.rootId === e.commentId && e.targetId === null
      : e.rootId === a.target.rootId && e.targetId === a.target.commentId)
  );
}
