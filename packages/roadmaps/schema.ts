import { z } from 'zod';
import { canonicalMunicipalSeriesSchema } from '../territories/schema';
import { statisticsHeadsSchema, teamStatisticalSeriesSchema } from '../statistics/schema';
import { parseBarrierEvidence } from '../barriers/schema';
import type {
  FrozenRoadmapData,
  RoadmapSnapshot,
  RoadmapsIndex,
  RoadmapsProjection,
  RoadmapVersion,
  RoadmapSeries,
} from './types';
import type { StatisticsHead } from '../statistics/types';
import { ROADMAP_LIMITS } from './types';

const uuid = z.uuid();
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = integer.min(1);
const year = z.number().int().min(1900).max(2200);
const finite = z.number().finite().min(-1e15).max(1e15);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const text = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(s));
const id = text(500, 1).refine(
  (s) => !/\s/u.test(s) && !['__proto__', 'constructor', 'prototype'].includes(s),
);
const timestamp = z
  .string()
  .min(20)
  .max(40)
  .refine((s) => Number.isFinite(Date.parse(s)));
export const roadmapDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((s) => {
    const date = new Date(`${s}T00:00:00Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === s &&
      s >= '1900-01-01' &&
      s <= '2200-12-31'
    );
  });
const nullableDate = roadmapDateSchema.nullable();
const scope = z.enum(['municipality', 'region', 'federal']);
const itemStatus = z.enum(['active', 'archived']);
const domain = z.enum(['nonnegative', 'signed', 'percent', 'ratio']);
const semantic = z.enum(['stock', 'flow', 'rate', 'share']);
const uniqueIds = (max: number) =>
  z
    .array(uuid)
    .max(max)
    .refine((xs) => new Set(xs).size === xs.length);
const within = (value: number, d: string) =>
  d === 'signed' ||
  (value >= 0 && (d !== 'percent' || value <= 100) && (d !== 'ratio' || value <= 1));
const datePair = (v: { startDate: string | null; endDate: string | null }) =>
  (v.startDate === null && v.endDate === null) ||
  (v.startDate !== null && v.endDate !== null && v.startDate <= v.endDate);

export const roadmapPassportDataSchema = z
  .strictObject({
    title: text(240),
    targetGroup: text(4000),
    partners: text(4000),
    goal: text(4000),
    objectives: z
      .array(z.strictObject({ id: uuid, title: text(1000) }))
      .max(30)
      .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length),
    startDate: nullableDate,
    endDate: nullableDate,
    expectedResult: text(4000),
    defenseDate: nullableDate,
    humanResources: text(4000),
    materialResources: text(4000),
    informationResources: text(4000),
  })
  .refine(datePair);
export const roadmapDiagnosisDataSchema = z.strictObject({
  problem: text(4000),
  causeHypothesis: text(4000),
  conclusion: text(4000),
});
export const roadmapMonitoringDataSchema = z.strictObject({
  frequency: text(1000),
  method: text(4000),
  responsible: text(1000),
  interimReportDate: nullableDate,
  finalReportDate: nullableDate,
  qualitativeResults: text(4000),
  sustainability: text(4000),
});
export const roadmapActivityDataSchema = z
  .strictObject({
    title: text(240),
    description: text(4000),
    objectiveId: uuid.nullable(),
    targetGroup: text(4000),
    scale: text(1000),
    startDate: nullableDate,
    endDate: nullableDate,
    responsible: text(1000),
    partners: text(4000),
    deliverable: text(4000),
    completionCriterion: text(4000),
    authorityLevel: z.enum([
      'municipal',
      'regional',
      'federal',
      'organization',
      'joint',
      'unknown',
    ]),
    legalBasis: text(4000),
    approvalStatus: z.enum(['unknown', 'requires_decision', 'verified_source', 'contradiction']),
    responsibleBody: text(1000),
    necessaryDecision: text(4000),
    indicatorIds: uniqueIds(20),
    dependencies: z
      .array(z.strictObject({ predecessorId: uuid, lagDays: integer.max(3650) }))
      .max(40)
      .refine((xs) => new Set(xs.map((x) => x.predecessorId)).size === xs.length),
    stage: z.enum(['preparation', 'implementation', 'evaluation', 'custom']),
    stageLabel: text(240),
    progressStatus: z.enum(['planned', 'in_progress', 'completed']),
  })
  .refine(datePair);
export const roadmapIndicatorDataSchema = z
  .strictObject({
    title: text(240),
    definition: text(4000),
    kind: z.enum(['resource', 'output', 'family_outcome', 'demographic_context']),
    unit: text(120),
    semanticType: semantic,
    valueDomain: domain,
    numeratorDefinition: text(4000),
    denominatorDefinition: text(4000),
    baselineValue: finite.nullable(),
    baselineYear: year.nullable(),
    annualTargets: z
      .array(z.strictObject({ year, value: finite }))
      .max(31)
      .refine((xs) => new Set(xs.map((x) => x.year)).size === xs.length),
    sourceReference: text(4000),
    frequency: text(1000),
    responsible: text(1000),
    limitations: text(4000),
    scenarioId: uuid.nullable(),
  })
  .refine(
    (v) =>
      (v.baselineValue === null) === (v.baselineYear === null) &&
      (v.baselineValue === null || within(v.baselineValue, v.valueDomain)) &&
      v.annualTargets.every((t) => within(t.value, v.valueDomain)),
  );
export const roadmapScenarioParametersSchema = z
  .strictObject({
    metricId: id,
    historyStartYear: year,
    historyEndYear: year,
    endYear: year,
    baselineMethod: z.enum(['last_value', 'linear']),
    targetMode: z.enum([
      'absolute_end',
      'relative_end',
      'annual_growth',
      'absolute_delta_end',
      'percentage_points',
    ]),
    targetValue: finite,
  })
  .refine(
    (v) =>
      v.historyStartYear <= v.historyEndYear &&
      v.endYear > v.historyEndYear &&
      v.endYear <= v.historyEndYear + 30 &&
      v.historyEndYear - v.historyStartYear <= 100 &&
      (v.targetMode !== 'annual_growth' || v.targetValue >= -100),
  );
export const roadmapScenarioDataSchema = z.strictObject({
  title: text(240),
  seriesId: id,
  seriesFingerprint: sha256,
  assumptions: text(4000),
  parameters: roadmapScenarioParametersSchema,
});
export const roadmapCostDataSchema = z
  .strictObject({
    activityId: uuid,
    year,
    title: text(240),
    unit: text(120),
    quantity: z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,3})?$/u),
    unitPriceKopecks: integer,
    periods: integer.min(1).max(10000),
    cashKind: z.enum(['cash', 'in_kind']),
    priceStatus: z.enum(['confirmed', 'estimated']),
    priceSource: text(4000),
    priceDate: nullableDate,
  })
  .refine((v) => {
    const [whole, part = ''] = v.quantity.split('.');
    const milli = BigInt(whole) * 1000n + BigInt(part.padEnd(3, '0'));
    return (
      (milli * BigInt(v.unitPriceKopecks) * BigInt(v.periods) + 500n) / 1000n <=
        BigInt(Number.MAX_SAFE_INTEGER) &&
      (v.priceStatus !== 'confirmed' || (v.priceSource.trim().length > 0 && v.priceDate !== null))
    );
  });
export const roadmapFundingDataSchema = z
  .strictObject({
    costLineId: uuid,
    sourceName: text(240),
    sourceKind: z.enum([
      'municipal_budget',
      'regional_budget',
      'federal_budget',
      'employer',
      'grant',
      'other',
    ]),
    amountKopecks: integer,
    status: z.enum(['confirmed', 'budget_draft', 'application', 'assumption']),
    sourceReference: text(4000),
    sourceDate: nullableDate,
    originReference: text(4000),
  })
  .refine(
    (v) =>
      v.status !== 'confirmed' || (v.sourceReference.trim().length >= 3 && v.sourceDate !== null),
  );
export const roadmapRiskDataSchema = z.strictObject({
  title: text(240),
  mitigation: text(4000),
  owner: text(1000),
  trigger: text(4000),
  contingency: text(4000),
});
export const roadmapFactDataSchema = z
  .strictObject({
    sourceKind: z.enum(['registry', 'team_statistics', 'external_unverified']),
    title: text(240),
    interpretation: text(4000),
    year: year.nullable(),
    value: finite.nullable(),
    unit: text(120),
    sourceReference: text(4000),
    sourceDate: nullableDate,
    seriesId: id.nullable(),
    seriesFingerprint: sha256.nullable(),
    metricId: id.nullable(),
  })
  .refine((v) =>
    v.sourceKind === 'registry' || v.sourceKind === 'team_statistics'
      ? v.year !== null &&
        v.value !== null &&
        v.seriesId !== null &&
        v.seriesFingerprint !== null &&
        v.metricId !== null
      : v.seriesId === null && v.seriesFingerprint === null && v.metricId === null,
  );

export const roadmapDataSchemas = {
  passport: roadmapPassportDataSchema,
  diagnosis: roadmapDiagnosisDataSchema,
  monitoring: roadmapMonitoringDataSchema,
  activity: roadmapActivityDataSchema,
  indicator: roadmapIndicatorDataSchema,
  scenario: roadmapScenarioDataSchema,
  cost: roadmapCostDataSchema,
  funding: roadmapFundingDataSchema,
  risk: roadmapRiskDataSchema,
  fact: roadmapFactDataSchema,
};
const itemFields = {
  id: uuid,
  revision,
  status: itemStatus,
  createdBy: uuid,
  createdByName: text(200, 1),
  updatedBy: uuid,
  updatedByName: text(200, 1),
  createdAt: timestamp,
  updatedAt: timestamp,
};
const frozenItemFields = { id: uuid, revision, status: itemStatus };
const saveFields = {
  roadmapId: uuid,
  itemId: uuid.nullable(),
  expectedRevision: integer,
  status: itemStatus,
};
function unionWith<T extends z.ZodRawShape>(fields: T) {
  return z.discriminatedUnion('kind', [
    z.strictObject({ ...fields, kind: z.literal('passport'), data: roadmapPassportDataSchema }),
    z.strictObject({ ...fields, kind: z.literal('diagnosis'), data: roadmapDiagnosisDataSchema }),
    z.strictObject({ ...fields, kind: z.literal('monitoring'), data: roadmapMonitoringDataSchema }),
    z.strictObject({ ...fields, kind: z.literal('activity'), data: roadmapActivityDataSchema }),
    z.strictObject({ ...fields, kind: z.literal('indicator'), data: roadmapIndicatorDataSchema }),
    z.strictObject({ ...fields, kind: z.literal('scenario'), data: roadmapScenarioDataSchema }),
    z.strictObject({ ...fields, kind: z.literal('cost'), data: roadmapCostDataSchema }),
    z.strictObject({ ...fields, kind: z.literal('funding'), data: roadmapFundingDataSchema }),
    z.strictObject({ ...fields, kind: z.literal('risk'), data: roadmapRiskDataSchema }),
    z.strictObject({ ...fields, kind: z.literal('fact'), data: roadmapFactDataSchema }),
  ]);
}
export const saveRoadmapItemInputSchema = unionWith(saveFields).refine(
  (v) => (v.itemId === null) === (v.expectedRevision === 0),
);
export const roadmapItemSchema = unionWith(itemFields);
export const frozenRoadmapItemSchema = unionWith(frozenItemFields);
export const roadmapTerritorySchema = z.strictObject({
  key: id,
  name: text(500, 1),
  level: scope,
  regionId: id.nullable(),
  sourceEditionId: id,
  sourceCode: text(160, 1).nullable(),
  sourceType: text(100, 1),
  geographicStatus: text(100, 1),
  sourceUrl: text(2000, 1),
  boundaryVersion: id.nullable(),
});
const barrierGround = z.strictObject({
  id: uuid,
  title: text(240, 5),
  description: text(4000),
  stageIds: z
    .array(
      z.enum([
        'life_plans',
        'first_child',
        'preparation_pregnancy',
        'infancy',
        'early_childhood',
        'preschool',
        'school',
        'next_child',
      ]),
    )
    .min(1)
    .max(8),
  evidenceKind: z.enum(['observation', 'hypothesis', 'survey_summary']),
  contentRevision: revision,
  status: itemStatus,
});
const solutionGround = z.strictObject({
  id: uuid,
  title: text(240, 5),
  targetGroup: text(1000, 3),
  mechanism: text(4000, 10),
  firstStep: text(2000, 3),
  responsible: text(2000, 3),
  resources: text(2000, 3),
  successIndicator: text(2000, 3),
  risks: text(2000),
  revision,
  status: itemStatus,
  barriers: z.array(barrierGround).min(1).max(20),
});
const linkGround = z.strictObject({
  id: uuid,
  relationship: z.enum(['potential', 'partial', 'needs_adaptation']),
  explanation: text(4000, 10),
  prerequisites: text(4000),
  revision,
  status: itemStatus,
  barrier: barrierGround,
  evidenceId: uuid,
  familyTitle: text(300, 1),
  familyFingerprint: sha256,
});
const basisMaterial = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('barrier'), source: barrierGround }),
  z.strictObject({ kind: z.literal('solution'), source: solutionGround }),
  z.strictObject({ kind: z.literal('link'), source: linkGround }),
]);
export const roadmapBasisSchema = z
  .strictObject({
    id: uuid,
    sourceKind: z.enum(['barrier', 'link', 'solution']),
    sourceId: uuid,
    sourceRevision: revision,
    fingerprint: sha256,
    material: basisMaterial,
    rationale: text(4000),
    status: itemStatus,
    revision,
    staleReasons: z
      .array(z.enum(['source_changed', 'source_archived', 'source_missing', 'source_basis_stale']))
      .max(4)
      .refine((xs) => new Set(xs).size === xs.length),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .refine((v) => v.sourceKind === v.material.kind && v.sourceId === v.material.source.id);
export const captureRoadmapBasisInputSchema = z
  .strictObject({
    roadmapId: uuid,
    basisId: uuid.nullable(),
    expectedRevision: integer,
    sourceKind: z.enum(['barrier', 'link', 'solution']),
    sourceId: uuid,
    expectedSourceRevision: revision,
    rationale: text(4000),
    status: itemStatus,
  })
  .refine((v) => (v.basisId === null) === (v.expectedRevision === 0));
export const captureRoadmapFactInputSchema = z
  .strictObject({
    roadmapId: uuid,
    itemId: uuid.nullable(),
    expectedRevision: integer,
    seriesId: id,
    expectedSeriesFingerprint: sha256,
    year,
    interpretation: text(4000),
  })
  .refine((v) => (v.itemId === null) === (v.expectedRevision === 0));
const budgetFields = {
  needCashKopecks: integer,
  inKindKopecks: integer,
  confirmedKopecks: integer,
  expectedKopecks: integer,
  confirmedGapKopecks: integer,
  remainingAfterExpectedKopecks: integer,
};
const validBudget = (v: {
  needCashKopecks: number;
  confirmedKopecks: number;
  expectedKopecks: number;
  confirmedGapKopecks: number;
  remainingAfterExpectedKopecks: number;
}) =>
  v.needCashKopecks - v.confirmedKopecks === v.confirmedGapKopecks &&
  v.confirmedGapKopecks - v.expectedKopecks === v.remainingAfterExpectedKopecks;
const budgetYear = z.strictObject({ year, ...budgetFields }).refine(validBudget);
export const roadmapBudgetSchema = z
  .strictObject({ ...budgetFields, years: z.array(budgetYear).max(301) })
  .refine(validBudget)
  .refine(
    (v) =>
      new Set(v.years.map((x) => x.year)).size === v.years.length &&
      Object.keys(budgetFields).every(
        (k) =>
          v.years.reduce((sum, row) => sum + BigInt(row[k as keyof typeof budgetFields]), 0n) ===
          BigInt(v[k as keyof typeof budgetFields]),
      ),
  );
const configuration = z.strictObject({
  roomLevel: scope,
  revision,
  locked: z.boolean(),
  dataEditionId: id.nullable(),
});
const roomSummary = z.strictObject({
  id: uuid,
  territory: roadmapTerritorySchema,
  revision,
  memberCount: integer.max(1000),
  activeItemCount: integer.max(600),
  versionCount: integer.max(30),
  latestVersionKind: z.enum(['draft', 'submitted']).nullable(),
  updatedAt: timestamp,
});
const review = z.strictObject({
  decision: z.enum(['revise', 'discussed']),
  comment: text(4000, 1),
  revision,
  reviewedAt: timestamp,
  reviewerName: text(200, 1),
});
const versionSummary = z.strictObject({
  id: uuid,
  number: revision.max(30),
  kind: z.enum(['draft', 'submitted']),
  title: text(240, 1),
  roadmapRevision: revision,
  sha256,
  createdAt: timestamp,
  review: review.nullable(),
});
export const roadmapsIndexSchema = z
  .strictObject({
    sessionId: uuid,
    cursor: integer,
    sourceCursor: integer,
    configuration,
    myRoadmapId: uuid.nullable(),
    assignmentRevision: integer,
    rooms: z.array(roomSummary).max(ROADMAP_LIMITS.rooms),
  })
  .refine(
    (v) =>
      new Set(v.rooms.map((x) => x.id)).size === v.rooms.length &&
      new Set(v.rooms.map((x) => x.territory.key)).size === v.rooms.length &&
      (v.myRoadmapId === null || v.rooms.some((x) => x.id === v.myRoadmapId)) &&
      v.configuration.locked === v.rooms.length > 0,
  );
const sharedData = {
  territory: roadmapTerritorySchema,
  roomLevel: scope,
  basis: z.array(roadmapBasisSchema).max(40),
  series: z.array(z.union([canonicalMunicipalSeriesSchema, teamStatisticalSeriesSchema])).max(54),
  statistics: statisticsHeadsSchema.optional(),
  budget: roadmapBudgetSchema,
};
const coherentStatistics = (v: {
  territory: { key: string };
  series: RoadmapSeries[];
  statistics?: StatisticsHead[];
}) =>
  v.series.every((s) => s.territoryKey === v.territory.key) &&
  (v.statistics ?? []).every((head) => {
    const series = v.series.find((s) => s.id === head.seriesId);
    if (head.mode === 'team')
      return (
        series?.sourceKind === 'team_reported' &&
        series.metricId === head.metricId &&
        series.revision === head.revision
      );
    if (head.seriesId === null)
      return !v.series.some(
        (s) => s.sourceKind !== 'team_reported' && s.metricId === head.metricId,
      );
    return (
      series !== undefined &&
      series.sourceKind !== 'team_reported' &&
      series.metricId === head.metricId
    );
  });
export const roadmapSnapshotSchema = z
  .strictObject({
    sessionId: uuid,
    roadmapId: uuid,
    cursor: integer,
    sourceCursor: integer,
    revision,
    ...sharedData,
    canEdit: z.boolean(),
    members: z.array(z.strictObject({ userId: uuid, fullName: text(200, 1) })).max(1000),
    items: z.array(roadmapItemSchema).max(600),
    versions: z.array(versionSummary).max(30),
  })
  .refine(
    (v) =>
      v.territory.level === v.roomLevel &&
      new Set(v.items.map((x) => x.id)).size === v.items.length &&
      ['passport', 'diagnosis', 'monitoring'].every(
        (k) => v.items.filter((x) => x.kind === k && x.status === 'active').length === 1,
      ) &&
      new Set(v.basis.map((x) => x.id)).size === v.basis.length &&
      new Set(v.series.map((x) => x.id)).size === v.series.length &&
      coherentStatistics(v),
  );
export const frozenRoadmapDataSchema = z
  .strictObject({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    templateVersion: z.literal('organizers-roadmap-1'),
    calculationVersion: z.literal('roadmap-analytics-1'),
    ...sharedData,
    roadmapRevision: revision,
    session: z.strictObject({ title: text(200, 1), scope, regionId: id.nullable() }),
    teamNames: z.array(text(200, 1)).max(1000),
    items: z.array(frozenRoadmapItemSchema).max(600),
    evidence: z
      .array(
        z.unknown().transform((v, ctx) => {
          try {
            return parseBarrierEvidence(v);
          } catch {
            ctx.addIssue({
              code: 'custom',
              message: 'Повреждены документальные основания версии.',
            });
            return z.NEVER;
          }
        }),
      )
      .max(40),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.schemaVersion === 2 && v.statistics === undefined)
      issue('В новой версии отсутствует состояние рабочих статистических рядов.');
    if (
      v.schemaVersion === 1 &&
      (v.statistics !== undefined || v.series.some((s) => s.sourceKind === 'team_reported'))
    )
      issue('Старая версия не должна содержать структуру нового формата.');
    if (!coherentStatistics(v))
      issue('Состояние статистических показателей не соответствует сохранённым редакциям.');
    if (
      v.territory.level !== v.roomLevel ||
      new Set(v.items.map((x) => x.id)).size !== v.items.length ||
      !['passport', 'diagnosis', 'monitoring'].every(
        (kind) => v.items.filter((x) => x.kind === kind && x.status === 'active').length === 1,
      ) ||
      new Set(v.basis.map((x) => x.id)).size !== v.basis.length ||
      new Set(v.series.map((x) => x.id)).size !== v.series.length ||
      new Set(v.evidence.map((x) => x.id)).size !== v.evidence.length
    )
      issue('Неоднозначная структура замороженной версии.');
    if (v.series.some((s) => s.territoryKey !== v.territory.key))
      issue('Статистический ряд относится к другой территории.');
    for (const basis of v.basis) {
      if (basis.material.kind !== 'link') continue;
      const ground = basis.material.source;
      const evidence = v.evidence.find((e) => e.id === ground.evidenceId);
      if (!evidence || evidence.fingerprint !== ground.familyFingerprint)
        issue('В версии отсутствует точное документальное основание.');
    }
  });
const version = versionSummary.extend({
  sessionId: uuid,
  roadmapId: uuid,
  canonicalJson: z.string().max(ROADMAP_LIMITS.frozenBytes),
  snapshot: frozenRoadmapDataSchema,
});
export const roadmapsProjectionSchema = z
  .strictObject({
    sessionId: uuid,
    title: text(200, 1),
    cursor: integer,
    sourceCursor: integer,
    rooms: z.array(roomSummary).max(1000),
    selected: z
      .strictObject({
        roadmapId: uuid,
        revision,
        ...sharedData,
        items: z.array(frozenRoadmapItemSchema).max(600),
      })
      .nullable(),
  })
  .refine((v) => v.selected === null || coherentStatistics(v.selected));
export const configureRoadmapsInputSchema = z.strictObject({
  expectedRevision: revision,
  roomLevel: scope,
});
export const joinRoadmapInputSchema = z.strictObject({
  territoryKey: id,
  dataEditionId: id,
  expectedAssignmentRevision: integer,
});
export const freezeRoadmapInputSchema = z.strictObject({
  roadmapId: uuid,
  expectedRevision: revision,
  title: text(240, 1),
  kind: z.enum(['draft', 'submitted']),
});
export const reviewRoadmapInputSchema = z.strictObject({
  roadmapId: uuid,
  versionId: uuid,
  expectedRevision: integer,
  decision: z.enum(['revise', 'discussed']),
  comment: text(4000, 1),
});

function parse<T>(schema: z.ZodType, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error(
      `Несовместимые данные дорожной карты: ${result.error.issues[0]?.path.join('.') || 'ответ'}. Проверьте миграцию и редакцию данных.`,
    );
  return result.data as T;
}
export const parseRoadmapsIndex = (v: unknown) => parse<RoadmapsIndex>(roadmapsIndexSchema, v);
export const parseRoadmapSnapshot = (v: unknown) =>
  parse<RoadmapSnapshot>(roadmapSnapshotSchema, v);
export const parseRoadmapsProjection = (v: unknown) =>
  parse<RoadmapsProjection>(roadmapsProjectionSchema, v);
export const parseFrozenRoadmapData = (v: unknown) =>
  parse<FrozenRoadmapData>(frozenRoadmapDataSchema, v);
export function parseRoadmapVersion(v: unknown): RoadmapVersion {
  const result = parse<RoadmapVersion>(version, v);
  let canonical: FrozenRoadmapData;
  try {
    canonical = parseFrozenRoadmapData(JSON.parse(result.canonicalJson));
  } catch {
    throw new Error('Повреждён канонический снимок версии дорожной карты.');
  }
  if (
    JSON.stringify(canonical) !== JSON.stringify(result.snapshot) ||
    result.snapshot.roadmapRevision !== result.roadmapRevision
  )
    throw new Error('Версия дорожной карты не соответствует каноническому снимку.');
  return result;
}
