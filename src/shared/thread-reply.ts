import { z } from './schema';
import { decimalId } from './page-messages';
const account = z.string().regex(/^tb\.[A-Za-z0-9._-]{1,195}$/);
const target = z.object({ rootId: decimalId, id: decimalId, author: account }).strict();
const evidence = z
  .object({
    id: decimalId,
    rootId: decimalId,
    author: account,
    recipient: account.nullable(),
    text: z.string().max(2000),
    createdAt: z.number().finite(),
  })
  .strict();
export type ReplyTarget = z.infer<typeof target>;
export type ReplyEvidence = z.infer<typeof evidence>;
export interface PendingReply {
  id: string;
  target: ReplyTarget;
  before: string[];
  at: number;
  document: string;
  refreshed?: boolean;
}
export interface ThreadReplyRun {
  id: string;
  tab: number;
  thread: string;
  account: string;
  text: string;
  running: boolean;
  sent: number;
  nextAt: number;
  reason: string;
  pending?: PendingReply;
  preparationReload?: string;
}
export const threadRunKey = 'thread-reply:run';
export const replyInterval = 30000;
const base = {
  type: z.literal('HORITIEBA_THREAD_REPLY'),
  thread: decimalId,
  document: z.string().uuid(),
};
const bound = { ...base, run: z.string().uuid() };
export const threadCommand = z.discriminatedUnion('op', [
  z.object({ ...base, op: z.literal('state') }).strict(),
  z
    .object({ ...base, op: z.literal('start'), account, text: z.string().trim().min(1).max(2000) })
    .strict(),
  z.object({ ...bound, op: z.literal('stop') }).strict(),
  z.object({ ...bound, op: z.literal('skip') }).strict(),
  z.object({ ...bound, op: z.literal('turn') }).strict(),
  z.object({ ...bound, op: z.literal('seen'), ids: z.array(decimalId).max(1000) }).strict(),
  z
    .object({
      ...bound,
      op: z.literal('permit'),
      target,
      before: z.array(decimalId).max(100000),
      account,
    })
    .strict(),
  z
    .object({ ...bound, op: z.literal('recover'), page: z.number().int().min(1).max(999999) })
    .strict(),
  z.object({ ...bound, op: z.literal('refresh'), attempt: z.string().uuid() }).strict(),
  z.object({ ...bound, op: z.literal('verified'), attempt: z.string().uuid(), evidence }).strict(),
  z.object({ ...bound, op: z.literal('pause'), reason: z.string().min(1).max(450) }).strict(),
]);
export type ThreadCommand = z.infer<typeof threadCommand>;
export type CommandBody = ThreadCommand extends infer T
  ? T extends ThreadCommand
    ? Omit<T, 'type' | 'document' | 'thread'>
    : never
  : never;
export function matchesReply(run: ThreadReplyRun, e: ReplyEvidence, now: number) {
  const p = run.pending;
  return (
    !!p &&
    !p.before.includes(e.id) &&
    e.id !== e.rootId &&
    e.id !== p.target.id &&
    e.rootId === p.target.rootId &&
    e.author === run.account &&
    e.text === run.text &&
    e.recipient === (p.target.id === p.target.rootId ? null : p.target.author) &&
    e.createdAt + 60000 > p.at - 2000 &&
    e.createdAt <= now + 2000
  );
}
