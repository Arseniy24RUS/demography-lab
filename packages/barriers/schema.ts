import { z } from 'zod';
import { bundleSchema } from '../collaboration/schema';
import { lifeStages } from './types';
import type {
  BarrierEvidence, BarriersProjection, BarriersSnapshot, SurveyHostState,
  SurveyOwnResponse, SurveyPublicManifest, SurveyResearchExport, SurveyInvitationState,
} from './types';

const uuid = z.uuid();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = count.min(1);
const text = (max: number, min = 0) => z.string().min(min).max(max)
  .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v));
const nonempty = (max: number, min: number) => text(max, min).refine((v) => v.trim().length >= min);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().min(20).max(40).refine((v) => Number.isFinite(Date.parse(v)));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((v) => Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v);
const stage = z.enum(lifeStages);
const state = z.enum(['active', 'archived']);
const vote = z.union([z.literal(-1), z.literal(0), z.literal(1), z.null()]);
const stageIds = z.array(stage).min(1).max(8).refine((v) => new Set(v).size === v.length);
const barrierIds = z.array(uuid).min(1).max(20).refine((v) => new Set(v).size === v.length);
const totals = z.strictObject({ support: count, oppose: count, neutral: count, cast: count })
  .refine((v) => v.cast === v.support + v.oppose + v.neutral);
const barrierBase = z.strictObject({
  id: uuid, title: nonempty(240, 5), description: text(4000), primaryStage: stage, stageIds,
  evidenceKind: z.enum(['observation', 'hypothesis', 'survey_summary']), status: state,
  priority: z.boolean(), revision, contentRevision: revision, totals,
  createdAt: timestamp, updatedAt: timestamp,
});
const barrier = barrierBase.extend({ authorId: uuid, authorName: text(200, 1), myVote: vote, myVoteRevision: count })
  .refine((v) => v.stageIds.includes(v.primaryStage) && v.contentRevision <= v.revision);
const projectedBarrier = barrierBase.extend({ authorName: text(200, 1).nullable() })
  .refine((v) => v.stageIds.includes(v.primaryStage) && v.contentRevision <= v.revision);
const family = z.strictObject({
  id: uuid, title: text(300, 1), mechanism: text(4000, 1), revision, fingerprint,
  variantCount: count.min(1).max(5000), regionNames: z.array(text(300, 1)).min(1).max(1000),
});
const linkBase = z.strictObject({
  id: uuid, barrierId: uuid, familyId: uuid, relationship: z.enum(['potential', 'partial', 'needs_adaptation']),
  explanation: nonempty(4000, 10), prerequisites: text(4000), status: state, revision,
  barrierContentRevision: revision, evidenceId: uuid, familyFingerprint: fingerprint, familyTitle: text(300, 1),
  staleReasons: z.array(z.enum(['barrier_changed', 'barrier_archived', 'family_changed', 'family_missing'])).max(4)
    .refine((v) => new Set(v).size === v.length), createdAt: timestamp, updatedAt: timestamp,
});
const link = linkBase.extend({ authorId: uuid, authorName: text(200, 1) });
const projectedLink = linkBase.extend({ authorName: text(200, 1).nullable() });
const solutionFields = {
  title: nonempty(240, 5), targetGroup: nonempty(1000, 3), mechanism: nonempty(4000, 10),
  firstStep: nonempty(2000, 3), responsible: nonempty(2000, 3), resources: nonempty(2000, 3),
  successIndicator: nonempty(2000, 3), risks: text(2000),
};
const solutionBase = z.strictObject({ id: uuid, barrierIds, ...solutionFields, status: state, revision, createdAt: timestamp, updatedAt: timestamp });
const solution = solutionBase.extend({ authorId: uuid, authorName: text(200, 1) });
const projectedSolution = solutionBase.extend({ authorName: text(200, 1).nullable() });
const questions = z.strictObject({
  q00: text(1000, 1), q05_12m: text(1000, 1), q05_36m: text(1000, 1), q01: nonempty(1000, 10),
  q02: nonempty(1000, 10), q03: text(1000, 1), q04: text(1000, 1), q06: text(1000, 1), q07: text(1000, 1), q08: text(1000, 1),
});
const manifestBase = z.strictObject({
  id: uuid, title: nonempty(240, 5), purpose: nonempty(4000, 20), organizerContact: nonempty(1000, 5),
  retentionUntil: date, status: z.enum(['draft', 'open', 'closed', 'purged']), expired: z.boolean(),
  canRespond: z.boolean(), questionVersion: revision, questionnaireVersion: z.literal('demography-open-1'),
  procedureVersion: z.literal('classroom-open-link-1'), questions,
});
const manifest = manifestBase.refine((v) => !v.canRespond || (v.status === 'open' && !v.expired));
const summary = manifestBase.extend({ revision, responseCount: count.min(5).max(250).nullable() })
  .refine((v) => (!v.canRespond || (v.status === 'open' && !v.expired))
    && (!(v.expired || v.status === 'purged') || v.responseCount === null));
const snapshot = z.strictObject({
  sessionId: uuid, cursor: count, barriers: z.array(barrier).max(200), families: z.array(family).max(200),
  links: z.array(link).max(600), solutions: z.array(solution).max(200), survey: summary.nullable(),
}).superRefine(checkBoard);
const projection = z.strictObject({
  sessionId: uuid, title: text(200, 1), scope: z.enum(['municipality', 'region', 'federal']), regionId: text(160, 1).nullable(),
  phase: z.enum(['reading', 'review', 'discussion']), status: z.enum(['open', 'paused', 'closed']), cursor: count,
  barriers: z.array(projectedBarrier).max(200), families: z.array(family).max(200),
  links: z.array(projectedLink).max(600), solutions: z.array(projectedSolution).max(200),
  survey: z.strictObject({ title: nonempty(240, 5), status: z.enum(['draft', 'open', 'closed', 'purged']), responseCount: count.min(5).max(250).nullable() }).nullable(),
}).superRefine(checkBoard);
function checkBoard(value: {
  barriers: Array<{ id: string; contentRevision: number; status: string }>; families: Array<{ id: string; fingerprint: string }>;
  links: Array<{ id: string; barrierId: string; familyId: string; barrierContentRevision: number; familyFingerprint: string; staleReasons: string[] }>;
  solutions: Array<{ id: string; barrierIds: string[] }>;
}, ctx: z.RefinementCtx) {
  const barrierSet = new Set(value.barriers.map((v) => v.id));
  if ([value.barriers, value.families, value.links, value.solutions].some((items) => new Set(items.map((v) => v.id)).size !== items.length)
    || value.links.some((l) => !barrierSet.has(l.barrierId))
    || value.solutions.some((s) => s.barrierIds.some((id) => !barrierSet.has(id)))) {
    ctx.addIssue({ code: 'custom', message: 'Нарушена целостность связей доски.' });
  }
  for (const link of value.links) {
    const b = value.barriers.find((x) => x.id === link.barrierId);
    const f = value.families.find((x) => x.id === link.familyId);
    if (!b) continue;
    const expected = [b.contentRevision !== link.barrierContentRevision ? 'barrier_changed' : null,
      b.status === 'archived' ? 'barrier_archived' : null,
      !f ? 'family_missing' : f.fingerprint !== link.familyFingerprint ? 'family_changed' : null].filter((x) => x !== null);
    if (expected.length !== link.staleReasons.length || expected.some((reason) => !link.staleReasons.includes(reason)))
      ctx.addIssue({ code: 'custom', message: 'Состояние доказательной связи не соответствует текущим карточкам.' });
  }
}
const evidence = z.strictObject({
  id: uuid, sessionId: uuid, familyId: uuid, fingerprint, familyRevision: revision,
  title: text(300, 1), mechanism: text(4000, 1), rationale: text(4000, 1),
  variants: z.array(z.strictObject({ submissionId: uuid, submissionRevision: revision, bundle: bundleSchema })).min(1).max(5000),
}).refine((v) => new Set(v.variants.map((x) => x.submissionId)).size === v.variants.length);

const perspective = z.enum(['self', 'adult_child_reported', 'adult_child_inferred', 'professional', 'decline']);
const intention = z.enum(['definitely_yes', 'probably_yes', 'probably_no', 'definitely_no', 'unsure', 'not_applicable', 'decline']).nullable();
const nullableAnswer = nonempty(4000, 1).nullable();
const answerShape = {
  perspective, intention12m: intention, intention36m: intention,
  answerBarrier: nullableAnswer, answerSupport: nullableAnswer, priorityChange: nullableAnswer, priorityConditionId: uuid.nullable(),
  horizon: z.enum(['within_12m', '13_36m', 'after_36m', 'no_change', 'unsure', 'decline']).nullable(),
  conditionalChange: z.enum(['definitely_change', 'probably_change', 'probably_no_change', 'definitely_no_change', 'unsure', 'decline']).nullable(),
  additionalConditions: nullableAnswer, consentEducational: z.boolean(), consentResearch: z.boolean(), consentQuote: z.boolean(), adultConfirmed: z.boolean(),
};
const answers = z.strictObject(answerShape);
function checkAnswers(v: z.infer<typeof answers>, ctx: z.RefinementCtx) {
  if ((v.consentQuote && !v.consentResearch)
    || (v.perspective !== 'decline' && v.answerBarrier === null && v.answerSupport === null)
    || (v.perspective !== 'self' && (v.intention12m !== null || v.intention36m !== null || v.conditionalChange !== null))
    || ((v.priorityChange === null) !== (v.priorityConditionId === null))
    || (v.conditionalChange !== null && v.priorityChange === null)
    || (v.perspective === 'decline' && [v.answerBarrier, v.answerSupport, v.priorityChange, v.horizon, v.additionalConditions].some((x) => x !== null))) {
    ctx.addIssue({ code: 'custom', message: 'Ответы не соответствуют ветке анкеты или согласию.' });
  }
}
const ownResponse = z.strictObject({ ...answerShape, status: z.enum(['none', 'submitted', 'withdrawn']), revision: count,
  questionVersion: revision, availability: z.enum(['open', 'closed', 'expired', 'purged']) }).superRefine(checkAnswers)
  .refine((v) => (v.status === 'none') === (v.revision === 0))
  .refine((v) => v.status === 'submitted' && !['expired', 'purged'].includes(v.availability)
    ? v.adultConfirmed && v.consentEducational
    : v.perspective === 'decline' && !v.adultConfirmed && !v.consentEducational && !v.consentResearch && !v.consentQuote
      && [v.intention12m, v.intention36m, v.answerBarrier, v.answerSupport, v.priorityChange, v.priorityConditionId, v.horizon, v.conditionalChange, v.additionalConditions].every((x) => x === null));
const hostResponse = z.strictObject({ ...answerShape, rowKey: uuid, questionVersion: revision, revision, responseDate: date }).superRefine(checkAnswers)
  .refine((v) => v.adultConfirmed && v.consentEducational);
const hostState = z.strictObject({
  survey: summary, responseCount: count.max(250), researchCount: count.max(250), quoteCount: count.max(250),
  invitationDigest: fingerprint, responses: z.array(hostResponse).max(250),
}).refine((v) => (!(v.survey.expired || v.survey.status === 'purged') || v.responses.length === 0)
  && v.responseCount === v.responses.length && v.researchCount === v.responses.filter((r) => r.consentResearch).length
  && v.quoteCount === v.responses.filter((r) => r.consentQuote).length);
const invitationState = z.strictObject({ surveyId: uuid, invitationDigest: fingerprint });
const exportShape = { ...answerShape };
const { priorityConditionId: _condition, consentEducational: _education, adultConfirmed: _adult, ...exportFields } = exportShape;
const researchExport = z.strictObject({
  datasetVersion: z.literal('demography-research-export-1'), procedureVersion: z.literal('classroom-open-link-1'),
  exportDate: date, samplingNote: text(4000, 1), questionnaire: manifest,
  missingCodes: z.strictObject({ skipped: z.literal('null'), notAsked: z.literal('not_asked'), notApplicable: z.literal('not_applicable'), declined: z.literal('decline') }),
  records: z.array(z.strictObject({ ...exportFields, questionVersion: revision, responseDate: date,
    missingReasons: z.partialRecord(z.enum(['intention12m', 'intention36m', 'answerBarrier', 'answerSupport', 'priorityChange', 'horizon', 'conditionalChange', 'additionalConditions']), z.enum(['skipped', 'not_asked'])) })
    .refine((v) => v.consentResearch && (!v.consentQuote || v.consentResearch))).max(250),
});

export const saveBarrierInputSchema = z.strictObject({
  barrierId: uuid.nullable(), expectedRevision: count, title: nonempty(240, 5), description: text(4000),
  primaryStage: stage, stageIds, evidenceKind: z.enum(['observation', 'hypothesis', 'survey_summary']), status: state, priority: z.boolean(),
}).refine((v) => v.stageIds.includes(v.primaryStage) && ((v.barrierId === null) === (v.expectedRevision === 0)));
export const barrierVoteInputSchema = z.strictObject({ barrierId: uuid, expectedRevision: count, value: vote });
export const saveBarrierLinkInputSchema = z.strictObject({
  linkId: uuid.nullable(), expectedRevision: count, barrierId: uuid, expectedBarrierRevision: revision,
  familyId: uuid, expectedFamilyFingerprint: fingerprint, relationship: z.enum(['potential', 'partial', 'needs_adaptation']),
  explanation: nonempty(4000, 10), prerequisites: text(4000), status: state,
}).refine((v) => (v.linkId === null) === (v.expectedRevision === 0));
export const saveSolutionInputSchema = z.strictObject({ solutionId: uuid.nullable(), expectedRevision: count, barrierIds,
  ...solutionFields, status: state }).refine((v) => (v.solutionId === null) === (v.expectedRevision === 0));
export const surveyConfigInputSchema = z.strictObject({
  surveyId: uuid.nullable(), expectedRevision: count, title: nonempty(240, 5), purpose: nonempty(4000, 20),
  organizerContact: nonempty(1000, 5), retentionUntil: date, questionBarrier: nonempty(1000, 10), questionSupport: nonempty(1000, 10), invitationToken: fingerprint.optional(),
}).refine((v) => (v.surveyId === null) === (v.expectedRevision === 0)
  && (v.surveyId === null ? v.invitationToken !== undefined : v.invitationToken === undefined));
export const surveyActionInputSchema = z.strictObject({
  surveyId: uuid, expectedRevision: revision, action: z.enum(['open', 'close', 'purge', 'rotate']), invitationToken: fingerprint.optional(),
}).refine((v) => (v.action === 'rotate') === (v.invitationToken !== undefined));
export const surveyResponseInputSchema = z.strictObject({ ...answerShape, expectedRevision: count, questionVersion: revision })
  .superRefine(checkAnswers).refine((v) => v.consentEducational && v.adultConfirmed);

function parse<T>(schema: z.ZodType, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Несовместимые данные этапа 4: ${parsed.error.issues[0]?.path.join('.') || 'ответ'}. Проверьте миграцию барьеров и опроса.`);
  return parsed.data as T;
}
export const parseBarriersSnapshot = (v: unknown) => parse<BarriersSnapshot>(snapshot, v);
export const parseBarriersProjection = (v: unknown) => parse<BarriersProjection>(projection, v);
export const parseBarrierEvidence = (v: unknown) => parse<BarrierEvidence>(evidence, v);
export const parseSurveyPublicManifest = (v: unknown) => parse<SurveyPublicManifest>(manifest, v);
export const parseSurveyOwnResponse = (v: unknown) => parse<SurveyOwnResponse>(ownResponse, v);
export const parseSurveyHostState = (v: unknown) => parse<SurveyHostState>(hostState, v);
export const parseSurveyInvitationState = (v: unknown) => parse<SurveyInvitationState>(invitationState, v);
export const parseSurveyResearchExport = (v: unknown) => parse<SurveyResearchExport>(researchExport, v);
