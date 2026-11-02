import { z } from './schema';
import { accountSchema, threadId } from './validation';
export const decimalId = z.string().regex(/^[1-9]\d{0,19}$/);
export const documentTokenSchema = z.string().uuid();
const pageUrl = z
  .string()
  .max(1000)
  .refine((u) => threadId(u) !== null);
export const targetSchema = z
  .object({
    threadId: decimalId,
    rootId: z.string().max(20),
    commentId: z.string().max(20),
    authorId: z.string().regex(/^tb\.[A-Za-z0-9._-]+$/),
    relation: z.enum(['root', 'self-root']),
    pageUrl: pageUrl.optional(),
  })
  .strict();
const base = { requestId: z.string().uuid(), context: z.literal('background') };
export const pageRequestSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('HORITIEBA_READ') }).strict(),
  z.object({ ...base, type: z.literal('HORITIEBA_LEGACY') }).strict(),
  z.object({ ...base, type: z.literal('HORITIEBA_INSPECT') }).strict(),
  z
    .object({
      ...base,
      type: z.literal('HORITIEBA_CANCEL'),
      operationId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal('HORITIEBA_SUBMIT_STATE'), attemptId: z.string().uuid() })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('HORITIEBA_PREPARE'),
      documentToken: documentTokenSchema,
      expiresAt: z.number().int().positive(),
      forum: z.string().min(1).max(100),
      target: targetSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('HORITIEBA_EXPAND'),
      rootId: decimalId,
      documentToken: documentTokenSchema,
      expiresAt: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('HORITIEBA_SUBMIT'),
      attemptId: z.string().uuid(),
      token: z.string().uuid(),
      target: targetSchema,
      text: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type PageRequest = z.infer<typeof pageRequestSchema>;
export const permitSchema = z
  .object({
    type: z.literal('HORITIEBA_PERMIT'),
    attemptId: z.string().uuid(),
    token: z.string().uuid(),
  })
  .strict();
export const observationSchema = z
  .object({
    threadId: decimalId,
    forum: z.string().min(1).max(100),
    account: accountSchema,
    comments: z
      .array(
        z
          .object({
            id: decimalId,
            rootId: decimalId,
            authorId: z.string().max(200),
            text: z.string().max(20000),
            createdAt: z.number().finite(),
            timePrecisionMs: z.literal(60000),
            floor: z.number().int().optional(),
            direct: z.boolean(),
          })
          .strict(),
      )
      .max(10000),
    publishedAt: z.number().finite().optional(),
    title: z.string().max(500),
    lastPage: pageUrl.optional(),
    pageUrl,
    rootEditorReady: z.boolean(),
    blocking: z.string().max(1000).optional(),
    invalidComments: z.number().int().min(0),
  })
  .strict();
export const preparedSchema = z
  .object({
    target: targetSchema,
    account: accountSchema,
    beforeIds: z.array(decimalId).max(10000),
    token: z.string().uuid(),
  })
  .strict();
