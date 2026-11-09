import { z } from 'zod';
import { bundleSchema } from '../collaboration/schema';
import type { VotingRound, WorkshopProjection, WorkshopSnapshot } from './types';

const uuid = z.uuid();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = count.min(1);
const text = (max: number, min = 0) => z.string().min(min).max(max)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const id = text(160, 1).refine((value) => !/\s/u.test(value));
const time = z.string().min(20).max(40).refine((value) => Number.isFinite(Date.parse(value)));
const nullableTime = time.nullable();
const status = z.enum(['available', 'in_progress', 'completed']);
const visibility = z.enum(['live', 'after_close']);
const vote = z.union([z.literal(-1), z.literal(0), z.literal(1), z.null()]);

const region = z.strictObject({
  regionId: id, ownerId: uuid.nullable(), ownerName: text(200).nullable(), status,
  leaseExpiresAt: nullableTime, completionNote: text(4000), revision, updatedAt: time,
}).refine((value) => value.status === 'in_progress'
  ? value.ownerId !== null && value.leaseExpiresAt !== null
  : value.leaseExpiresAt === null);
const family = z.strictObject({
  id: uuid, title: text(300, 1), mechanism: text(4000, 1), rationale: text(4000, 1),
  submissionIds: z.array(uuid).max(5000), revision, createdAt: time, updatedAt: time,
}).refine((value) => new Set(value.submissionIds).size === value.submissionIds.length);

const totals = z.strictObject({
  support: count, oppose: count, neutral: count, unanswered: count, cast: count,
  score: z.number().int().min(-1000).max(1000), substantive: count,
  coverage: z.number().min(0).max(1).nullable(),
  supportRatio: z.number().min(0).max(1).nullable(),
  net: z.number().min(-1).max(1).nullable(), qualifies: z.boolean(),
}).refine((value) => value.cast === value.support + value.oppose + value.neutral
  && value.substantive === value.support + value.oppose
  && value.score === value.support - value.oppose
  && ((value.substantive === 0) === (value.net === null))
  && ((value.substantive === 0) === (value.supportRatio === null)));
const variant = z.strictObject({
  submissionId: uuid, submissionRevision: revision, bundle: bundleSchema,
});
const frozenBase = z.strictObject({
  id: uuid, title: text(300, 1), mechanism: text(4000, 1), rationale: text(4000, 1),
  variants: z.array(variant).min(1).max(5000), totals: totals.nullable(),
});
const frozenPersonal = frozenBase.extend({ myVote: vote, myVoteRevision: count });
const roundSummary = z.strictObject({
  id: uuid, title: text(200, 1), status: z.enum(['open', 'closed']), resultsVisibility: visibility,
  promptText: text(1000, 1), contextScope: z.enum(['municipality', 'region', 'federal']),
  contextRegionId: id.nullable(), evaluationDimension: z.literal('priority_for_adaptation'),
  minCoverage: z.number().min(0).max(1), minSubstantiveVotes: z.number().int().min(1).max(1000),
  revision, eligibleCount: count.max(1000), familyCount: count.max(200),
  openedAt: time, closedAt: nullableTime,
});
const round = roundSummary.extend({
  canVote: z.boolean(), totalsVisible: z.boolean(), participatingCount: count,
  families: z.array(frozenPersonal).max(200),
}).superRefine(checkRound);
const projectedRound = roundSummary.extend({
  totalsVisible: z.boolean(), participatingCount: count,
  families: z.array(frozenBase).max(200),
}).superRefine(checkRound);

function checkRound(value: {
  familyCount: number; eligibleCount: number; participatingCount: number;
  totalsVisible: boolean; status: string; resultsVisibility: string;
  minCoverage: number; minSubstantiveVotes: number;
  closedAt: string | null; canVote?: boolean;
  families: Array<{ id: string; totals: z.infer<typeof totals> | null; variants: z.infer<typeof variant>[] }>;
}, ctx: z.RefinementCtx) {
  const fail = () => ctx.addIssue({ code: 'custom', message: 'Несогласованный снимок голосования.' });
  const variantIds = value.families.flatMap((f) => f.variants.map((v) => v.submissionId));
  if (value.familyCount !== value.families.length
    || new Set(value.families.map((f) => f.id)).size !== value.families.length
    || new Set(variantIds).size !== variantIds.length
    || value.participatingCount > value.eligibleCount
    || value.minSubstantiveVotes > value.eligibleCount
    || (value.status === 'closed') !== (value.closedAt !== null)
    || (value.status === 'closed' && value.canVote === true)
    || value.totalsVisible !== (value.status === 'closed' || value.resultsVisibility === 'live')) fail();
  for (const f of value.families) {
    if (value.totalsVisible !== (f.totals !== null)) { fail(); continue; }
    if (!f.totals) continue;
    const t = f.totals;
    const agrees = (actual: number | null, expected: number | null) => expected === null
      ? actual === null : actual !== null && Math.abs(actual - expected) < 1e-9;
    if (t.cast + t.unanswered !== value.eligibleCount
      || !agrees(t.coverage, value.eligibleCount ? t.cast / value.eligibleCount : null)
      || !agrees(t.supportRatio, t.substantive ? t.support / t.substantive : null)
      || !agrees(t.net, t.substantive ? (t.support - t.oppose) / t.substantive : null)
      || t.qualifies !== (t.coverage !== null && t.coverage >= value.minCoverage
        && t.substantive >= value.minSubstantiveVotes)) fail();
  }
}
const snapshot = z.strictObject({
  sessionId: uuid, cursor: count, boardRevision: count,
  regionWork: z.array(region).max(1000), families: z.array(family).max(200),
  rounds: z.array(roundSummary).max(100), round: round.nullable(),
}).superRefine((value, ctx) => {
  const ids = value.families.flatMap((f) => f.submissionIds);
  if (new Set(ids).size !== ids.length
    || new Set(value.regionWork.map((r) => r.regionId)).size !== value.regionWork.length
    || new Set(value.families.map((f) => f.id)).size !== value.families.length)
    ctx.addIssue({ code: 'custom', message: 'Повторяющееся назначение или семейство.' });
});
const projection = z.strictObject({
  sessionId: uuid, title: text(200, 1), phase: z.enum(['reading', 'review', 'discussion']),
  status: z.enum(['open', 'paused', 'closed']), cursor: count,
  regionWork: z.array(z.strictObject({ regionId: id, status, revision, leaseExpiresAt: nullableTime })).max(1000),
  familyCount: count.max(200), groupedSubmissionCount: count.max(5000), round: projectedRound.nullable(),
});
function parse<T>(schema: z.ZodType, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Сервер вернул несовместимые данные мастерской: ${parsed.error.issues[0]?.path.join('.') || 'ответ'}. Проверьте миграцию этапа 3.`);
  return parsed.data as T;
}
export const parseWorkshopSnapshot = (value: unknown) => parse<WorkshopSnapshot>(snapshot, value);
export const parseWorkshopProjection = (value: unknown) => parse<WorkshopProjection>(projection, value);
export const parseVotingRound = (value: unknown) => parse<VotingRound>(round, value);
