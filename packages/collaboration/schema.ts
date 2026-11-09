import { z } from 'zod';
import type {
  BootstrapResult,
  ProjectionSession,
  SessionInvitation,
  SessionProfile,
  SessionSnapshot,
  SharedPracticeBundle,
} from './types';

const id = z
  .string()
  .min(1)
  .max(160)
  .refine((v) => !/\s/.test(v) && !['__proto__', 'prototype', 'constructor'].includes(v));
const uuid = z.uuid();
const text = (max = 20000) =>
  z
    .string()
    .max(max)
    .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v));
const timestamp = z
  .string()
  .min(20)
  .max(40)
  .refine((v) => Number.isFinite(Date.parse(v)));
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const review = z.enum(['candidate', 'verified', 'rejected']);
const field = z.enum(['title', 'mechanism', 'eligibility', 'amount', 'conditions']);
const normalization = z.enum([
  'unicode-nfc-lf-v1',
  'poppler-layout-nfc-lf-rstrip-lines-blank-paragraphs-v1',
]);
const safeUrl = z
  .url()
  .max(2000)
  .refine((v) => {
    const u = new URL(v);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
  });
const span = z
  .strictObject({
    blockId: id,
    start: z.number().int().min(0).max(10000000),
    end: z.number().int().min(1).max(10000000),
    exact: text().min(1),
    prefix: text(500),
    suffix: text(500),
  })
  .refine(
    (v) => v.end > v.start && Array.from(v.exact).length === v.end - v.start,
    'Неверный диапазон цитаты.',
  );
const anchor = z.strictObject({
  id,
  documentId: id,
  versionId: id,
  normalizationVersion: normalization,
  spans: z.array(span).min(1).max(256),
});
const evidence = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('fragment'),
    field,
    occurrenceId: id,
    relation: z.enum(['supports', 'partial', 'contradicts']),
    reviewStatus: review,
    reviewedValue: text().optional(),
    note: text().optional(),
  }),
  z.strictObject({
    kind: z.literal('document'),
    field: field.optional(),
    documentId: id,
    versionId: id,
    note: text().optional(),
  }),
  z.strictObject({
    kind: z.literal('article'),
    field: field.optional(),
    url: safeUrl,
    title: text(1000).optional(),
    note: text().optional(),
  }),
]);
const practice = z.strictObject({
  id,
  familyId: id,
  regionId: id,
  title: text(500).min(1),
  mechanism: text().min(1),
  eligibility: text().nullable().optional(),
  amount: text().nullable().optional(),
  conditions: z.array(text(5000)).max(500).optional(),
  occurrenceIds: z.array(id).min(1).max(128),
  evidence: z.array(evidence).max(256).optional(),
  reviewStatus: review.optional(),
});
const occurrence = z.strictObject({
  id,
  documentId: id,
  versionId: id,
  anchor,
  reviewStatus: review,
  note: text().optional(),
});
const source = z.strictObject({
  sourceId: id,
  editionId: id,
  title: text(1000).min(1),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  normalizationVersion: normalization,
  sourceUrl: safeUrl.optional(),
  regionId: id.optional(),
});
export const bundleSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    practice,
    occurrences: z.array(occurrence).min(1).max(128),
    sources: z.array(source).min(1).max(128),
    note: text(4000),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const os = new Map(v.occurrences.map((o) => [o.id, o]));
    const ss = new Map(v.sources.map((s) => [s.editionId, s]));
    if (
      os.size !== v.occurrences.length ||
      ss.size !== v.sources.length ||
      new Set(v.practice.occurrenceIds).size !== v.practice.occurrenceIds.length
    )
      issue('Повторяющиеся идентификаторы.');
    if (
      v.practice.occurrenceIds.some((oid) => !os.has(oid)) ||
      v.occurrences.some((o) => !v.practice.occurrenceIds.includes(o.id))
    )
      issue('Карточка и её фрагменты расходятся.');
    for (const o of v.occurrences) {
      const s = ss.get(o.versionId);
      if (
        o.documentId !== o.anchor.documentId ||
        o.versionId !== o.anchor.versionId ||
        !s ||
        s.sourceId !== o.documentId ||
        s.normalizationVersion !== o.anchor.normalizationVersion
      )
        issue('Несовместимая редакция источника.');
      if (new Set(o.anchor.spans.map((s) => s.blockId)).size !== o.anchor.spans.length)
        issue('Повтор блока в выделении.');
    }
    for (const e of v.practice.evidence ?? []) {
      if (
        e.kind === 'fragment' &&
        (!os.has(e.occurrenceId) ||
          (e.reviewStatus === 'verified' && e.reviewedValue === undefined))
      )
        issue('Нет основания для проверки поля.');
      if (e.kind === 'document' && ss.get(e.versionId)?.sourceId !== e.documentId)
        issue('Нет редакции для ссылки на документ.');
    }
    if (new TextEncoder().encode(JSON.stringify(v)).byteLength > 131072)
      issue('Карточка превышает предел 128 КиБ.');
  });
const session = z.strictObject({
  id: uuid,
  title: text(200).min(1),
  scope: z.enum(['municipality', 'region', 'federal']),
  regionId: id.nullable(),
  status: z.enum(['open', 'paused', 'closed']),
  phase: z.enum(['reading', 'review', 'discussion']),
  role: z.enum(['host', 'participant', 'observer']),
  revision,
  joinOpen: z.boolean(),
  focusSubmissionId: uuid.nullable(),
  projectorShowAuthors: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const member = z.strictObject({
  userId: uuid,
  fullName: text(200).min(1),
  role: z.enum(['host', 'participant', 'observer']),
  joinedAt: timestamp,
  revision,
});
const submission = z.strictObject({
  id: uuid,
  sessionId: uuid,
  authorId: uuid,
  authorName: text(200),
  localKey: id,
  bundle: bundleSchema,
  revision,
  status: z.enum(['shared', 'withdrawn']),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const profile = z.strictObject({ userId: uuid, fullName: text(200).min(1), revision });
const snapshot = z.strictObject({
  session,
  members: z.array(member).max(1000),
  submissions: z.array(submission).max(5000),
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const bootstrap = z.strictObject({
  profile: profile.nullable(),
  canCreateSession: z.boolean(),
  sessions: z.array(session).max(1000),
});
const invitation = z.strictObject({ code: z.string().regex(/^[A-Z0-9-]{6,32}$/u), revision });
const projection = z.strictObject({
  title: text(200),
  phase: z.enum(['reading', 'review', 'discussion']),
  status: z.enum(['open', 'paused', 'closed']),
  focusSubmissionId: uuid.nullable(),
  projectorShowAuthors: z.boolean(),
  participantCount: z.number().int().min(0),
  submissions: z
    .array(
      z.strictObject({
        id: uuid,
        bundle: bundleSchema,
        revision,
        updatedAt: timestamp,
        authorName: text(200).optional(),
      }),
    )
    .max(5000),
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
function parse<T>(schema: z.ZodType, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error(
      `Сервер вернул несовместимые данные: ${result.error.issues[0]?.path.join('.') || 'ответ'}. Обновите приложение и проверьте миграции.`,
    );
  return result.data as T;
}
export const parseBundle = (v: unknown) => parse<SharedPracticeBundle>(bundleSchema, v);
export const parseSnapshot = (v: unknown) => parse<SessionSnapshot>(snapshot, v);
export const parseBootstrap = (v: unknown) => parse<BootstrapResult>(bootstrap, v);
export const parseProfile = (v: unknown) => parse<SessionProfile>(profile, v);
export const parseInvitation = (v: unknown) => parse<SessionInvitation>(invitation, v);
export const parseProjection = (v: unknown) => parse<ProjectionSession>(projection, v);
