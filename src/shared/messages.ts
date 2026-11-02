import { z } from './schema';
import { sameExtensionOrigin } from './extension-origin';
import { modeSchema, stageSchema, configSchema, librarySchema } from './validation';
const base = {
  requestId: z.string().uuid(),
  context: z.enum(['dashboard', 'sidepanel', 'popup']),
  mode: modeSchema,
};
export const requestSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('STATE'),
      payload: z
        .object({
          view: z.enum([
            'overview',
            'threads',
            'libraries',
            'tasks',
            'history',
            'logs',
            'settings',
          ]),
          page: z.number().int().min(0).max(10000),
          query: z.string().max(200),
          author: z.string().max(100),
          status: z.string().max(50),
          stage: stageSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('CONTROL'),
      payload: z
        .object({
          action: z.enum(['start', 'pause', 'resume', 'stop', 'emergency', 'check']),
          expected: z
            .object({
              configVersion: z.number().int().positive(),
              libraryVersions: z.array(z.number().int().positive()).length(5),
              accountId: z.string().min(1).max(200).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('SAVE_CONFIG'), payload: configSchema }).strict(),
  z.object({ ...base, type: z.literal('SAVE_LIBRARY'), payload: librarySchema }).strict(),
  z.object({ ...base, type: z.literal('RESET_CURSOR'), payload: stageSchema }).strict(),
  z.object({ ...base, type: z.literal('IMPORT_JSON'), payload: z.string().max(20000000) }).strict(),
  z
    .object({ ...base, type: z.literal('EXPORT'), payload: z.enum(['config', 'history', 'logs']) })
    .strict(),
  z.object({ ...base, type: z.literal('DETAIL'), payload: z.string().uuid() }).strict(),
  z.object({ ...base, type: z.literal('SKIP'), payload: z.string().max(300) }).strict(),
  z.object({ ...base, type: z.literal('VERIFY'), payload: z.string().uuid() }).strict(),
  z
    .object({
      ...base,
      type: z.literal('RETRY'),
      payload: z.object({ taskId: z.string().uuid(), acknowledged: z.literal(true) }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('CONFIRM_PUBLISHED'),
      payload: z
        .object({
          taskId: z.string().uuid(),
          commentId: z.string().trim().min(1).max(100),
          note: z.string().trim().min(1).max(500),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('SCENARIO'),
      payload: z.enum([
        'success',
        'failure',
        'captcha',
        'unknown',
        'account-change',
        'target-mismatch',
        'tab-closed',
      ]),
    })
    .strict(),
  z.object({ ...base, type: z.literal('CLEAR_HISTORY'), payload: z.literal('confirm') }).strict(),
  z.object({ ...base, type: z.literal('DETECT_FORUM') }).strict(),
  z.object({ ...base, type: z.literal('OPEN_WORK_TAB') }).strict(),
  z.object({ ...base, type: z.literal('PREFLIGHT') }).strict(),
]);
export type Request = z.infer<typeof requestSchema>;
export type Response<T = unknown> =
  { requestId: string; ok: true; data: T } | { requestId: string; ok: false; error: string };
export function trustedUiSender(sender: chrome.runtime.MessageSender, id: string, root: string) {
  if (sender.id !== id || (sender.frameId !== undefined && sender.frameId !== 0) || !sender.url)
    return false;
  try {
    const u = new URL(sender.url);
    return (
      sameExtensionOrigin(sender.url, root) &&
      ['/dashboard.html', '/sidepanel.html', '/popup.html'].includes(u.pathname)
    );
  } catch {
    return false;
  }
}
