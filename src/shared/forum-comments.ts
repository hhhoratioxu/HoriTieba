import { z } from './schema';
import { normalizeForum } from './validation';

export function forumFromUrl(url: string | undefined): string | null {
  if (!url || !url.startsWith('https://tieba.baidu.com/')) return null;
  try {
    return normalizeForum(url);
  } catch {
    return null;
  }
}
const base = { type: z.literal('HORITIEBA_FORUM'), forum: z.string().min(1).max(100) };
const bound = { ...base, run: z.string().uuid() };
export const forumCommand = z.discriminatedUnion('op', [
  z.object({ ...base, op: z.literal('state') }).strict(),
  z
    .object({
      ...base,
      op: z.literal('start'),
      text: z.string().trim().min(1).max(2000),
      account: z.string().regex(/^tb\.[A-Za-z0-9._-]{1,195}$/),
    })
    .strict(),
  z.object({ ...bound, op: z.literal('stop') }).strict(),
  z.object({ ...bound, op: z.literal('resume') }).strict(),
  z.object({ ...bound, op: z.literal('verify') }).strict(),
]);
export type ForumCommand = z.infer<typeof forumCommand>;
export type ForumAction = ForumCommand extends infer T
  ? T extends ForumCommand
    ? Omit<T, 'type' | 'forum'>
    : never
  : never;
export interface ForumState {
  id: string;
  status: 'running' | 'stopped' | 'paused' | 'blocked' | 'completed' | 'elsewhere';
  reason: string;
  sent: number;
  text: string;
  unknown: boolean;
}
