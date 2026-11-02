import { z } from './schema';
import { stages, type Config, type Library, type Mode } from '../domain/models';
export const modeSchema = z.enum(['demo', 'real']);
export const stageSchema = z.enum(stages);
export const accountSchema = z
  .object({
    id: z.string().max(200).nullable(),
    label: z.string().max(200),
    confirmed: z.boolean(),
    reason: z.string().max(1000).optional(),
  })
  .strict();
export const scanSchema = z
  .object({
    forum: z.string().min(1).max(100),
    account: accountSchema,
    reliable: z.boolean(),
    coverage: z.string().max(1000),
    blocking: z.string().max(1000).optional(),
    candidates: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            title: z.string().min(1).max(500),
            author: z.string().max(100),
            authorId: z.string().max(200).optional(),
            url: z
              .string()
              .max(1000)
              .refine((u) => threadId(u) !== null),
            publishedAt: z.number().finite().positive().optional(),
            timePrecisionMs: z.number().int().min(1).max(60000).optional(),
            timeCheckPending: z.boolean().optional(),
            timeLabel: z.string().max(200).optional(),
            timeEvidence: z.enum(['verified', 'relative', 'unavailable']),
            kind: z.enum(['thread', 'pinned', 'recommended', 'ad']),
            source: z.string().max(200),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export const itemSchema = z
  .object({ id: z.string().min(1).max(100), text: z.string().trim().min(1).max(2000) })
  .strict();
export const librarySchema = z
  .object({
    id: z.string().max(100),
    mode: modeSchema,
    stage: stageSchema,
    version: z.number().int().min(1),
    enabled: z.boolean(),
    loop: z.boolean(),
    items: z.array(itemSchema).max(5000),
  })
  .strict()
  .superRefine((lib, c) => {
    if (lib.stage === 'root' && !lib.enabled)
      c.addIssue({ code: 'custom', message: '首评库必须启用' });
    if (new Set(lib.items.map((i) => i.id)).size !== lib.items.length)
      c.addIssue({ code: 'custom', message: '条目 ID 重复' });
  });
export const configSchema = z
  .object({
    id: modeSchema,
    version: z.number().int().positive(),
    forum: z.string().min(1).max(100),
    include: z.array(z.string().trim().min(1).max(100)).max(100),
    exclude: z.array(z.string().trim().min(1).max(100)).max(100),
    authors: z.array(z.string().trim().min(1).max(100)).max(100),
    match: z.enum(['any', 'all']),
    selfReply: z.boolean(),
    replyMode: z.literal('root'),
    maxPosts: z.number().int().min(1).max(100),
    maxSends: z.number().int().min(1).max(500),
    maxReplies: z.number().int().min(0).max(4),
    checkSeconds: z.number().int().min(30).max(3600),
    sendSeconds: z.number().int().min(30).max(3600),
    realAction: z.enum(['read', 'auto']).optional(),
  })
  .strict();
export function normalizeForum(input: string): string {
  let name = input.trim();
  if (/^https?:\/\//i.test(name)) {
    const u = new URL(name);
    if (
      u.protocol !== 'https:' ||
      u.hostname !== 'tieba.baidu.com' ||
      u.port ||
      u.username ||
      u.password ||
      !['/f', '/f/'].includes(u.pathname)
    )
      throw Error('只接受 https://tieba.baidu.com/f?kw=贴吧名');
    name = u.searchParams.get('kw')?.trim() || '';
  } else if (/[/:?&#\\]/.test(name) || name.includes('.com'))
    throw Error('请输入贴吧名称或支持的贴吧链接');
  if (!name || name.length > 100 || /[<>\u0000-\u001f]/.test(name)) throw Error('贴吧名称无效');
  return name.normalize('NFC');
}
export const forumUrl = (forum: string) =>
  `https://tieba.baidu.com/f?kw=${encodeURIComponent(normalizeForum(forum))}`;
export function threadId(input: string): string | null {
  try {
    const u = new URL(input, 'https://tieba.baidu.com');
    return u.protocol === 'https:' &&
      u.hostname === 'tieba.baidu.com' &&
      !u.port &&
      !u.username &&
      !u.password
      ? (u.pathname.match(/^\/p\/(\d+)$/)?.[1] ?? null)
      : null;
  } catch {
    return null;
  }
}
const bundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    exportedAt: z.iso.datetime(),
    libraries: z.array(librarySchema).length(5),
    config: configSchema,
  })
  .strict();
export function parseBundle(text: string, mode: Mode): { config: Config; libraries: Library[] } {
  if (new TextEncoder().encode(text).length > 20_000_000) throw Error('文件超过 20 MB');
  const parsed = bundleSchema.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
  if (new Set(parsed.libraries.map((l) => l.stage)).size !== 5)
    throw Error('需要五个互不重复的内容库');
  const config = { ...parsed.config, id: mode, forum: normalizeForum(parsed.config.forum) };
  const libraries = stages.map((stage) => {
    const l = parsed.libraries.find((l) => l.stage === stage)!;
    return { ...l, id: `${mode}:${stage}`, mode };
  });
  return { config, libraries };
}
export interface TxtPreview {
  items: string[];
  blank: number;
  duplicates: number;
  tooLong: number;
  lines: number;
}
export async function parseTxt(
  text: string,
  onProgress?: (n: number) => void,
): Promise<TxtPreview> {
  if (new TextEncoder().encode(text).length > 20_000_000) throw Error('文件超过 20 MB');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const out: TxtPreview = { items: [], blank: 0, duplicates: 0, tooLong: 0, lines: lines.length };
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) out.blank++;
    else if (s.length > 2000) out.tooLong++;
    else {
      if (seen.has(s)) out.duplicates++;
      seen.add(s);
      out.items.push(s);
    }
    if (out.items.length > 5000) throw Error('每库最多 5000 条');
    if (i % 500 === 0) {
      onProgress?.(Math.round((i / lines.length) * 100));
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(100);
  return out;
}
