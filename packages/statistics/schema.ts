import { z } from 'zod';
import { canonicalMunicipalSeriesSchema } from '../territories/schema';
import {
  STATISTICS_LIMITS,
  STATISTICS_METRIC_IDS,
  type StatisticsHistory,
  type StatisticsSeriesPayload,
  type TeamStatisticalSeries,
} from './types';

const text = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(s));
const requiredText = (max: number) => text(max, 1).refine((s) => s.trim().length > 0);
const id = text(500, 1).refine((s) => !/\s/u.test(s));
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = integer.min(1).max(STATISTICS_LIMITS.revisions);
const year = z.number().int().min(1900).max(2200);
const value = z
  .number()
  .finite()
  .min(-STATISTICS_LIMITS.sourceValueAbs)
  .max(STATISTICS_LIMITS.sourceValueAbs)
  .nullable();
const metricId = z.enum(STATISTICS_METRIC_IDS);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return (
      Number.isFinite(d.getTime()) &&
      d.toISOString().slice(0, 10) === s &&
      s >= '1900-01-01' &&
      s <= '2200-12-31'
    );
  });
const timestamp = z
  .string()
  .min(20)
  .max(40)
  .refine((s) => Number.isFinite(Date.parse(s)));
const provenance = {
  sourceReference: requiredText(STATISTICS_LIMITS.sourceReference),
  sourceDate: date.nullable(),
  reason: requiredText(STATISTICS_LIMITS.reason),
};
const isSigned = (metric: string) => metric === 'mig_net_total' || metric === 'natural_change';
const acceptableValue = (metric: string, n: number | null) =>
  n === null ||
  ((isSigned(metric) || n >= 0) &&
    (metric === 'pop_mid'
      ? Math.abs(n * 1e6 - Math.round(n * 1e6)) <=
        Math.max(1e-7, Math.abs(n * 1e6) * Number.EPSILON)
      : Number.isInteger(n)));
const strictlySorted = (points: Array<{ year: number }>) =>
  points.every((point, i) => i === 0 || points[i - 1]!.year < point.year);
const normalizedJson = (input: unknown): string => {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(normalizedJson).join(',')}]`;
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${normalizedJson(record[k])}`)
    .join(',')}}`;
};

export const statisticsChangeSchema = z.discriminatedUnion('action', [
  z.strictObject({ year, action: z.literal('set'), value }),
  z.strictObject({ year, action: z.literal('reset') }),
]);
export const statisticsOverrideSchema = z.strictObject({
  year,
  value,
  ...provenance,
  revision,
  updatedAt: timestamp,
});
export const teamStatisticalSeriesSchema = z
  .strictObject({
    id,
    territoryKey: id,
    metricId,
    title: requiredText(200),
    unit: z.literal('persons'),
    semanticType: z.enum(['stock', 'flow']),
    valueDomain: z.enum(['nonnegative', 'signed']),
    aggregation: z.enum(['sum', 'none']),
    decimals: z.number().int().min(0).max(6),
    reference: z.enum(['annual_average', 'calendar_year']),
    sourceEditionId: z.literal('team-statistics-v1'),
    sourceKind: z.literal('team_reported'),
    provenanceStatus: z.literal('participant_supplied'),
    geographyEditionId: id,
    geographyComparability: z.literal('not_verified'),
    comparabilityNote: text(STATISTICS_LIMITS.comparabilityNote),
    baseSeries: canonicalMunicipalSeriesSchema.nullable(),
    points: z.array(z.strictObject({ year, value })).max(STATISTICS_LIMITS.points),
    overrides: z.array(statisticsOverrideSchema).max(STATISTICS_LIMITS.points),
    revision,
    ...provenance,
    recordedAt: timestamp,
    canonicalJson: z.string().max(STATISTICS_LIMITS.seriesBytes),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .superRefine((s, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const stock = s.metricId === 'pop_mid';
    if (
      s.semanticType !== (stock ? 'stock' : 'flow') ||
      s.valueDomain !== (isSigned(s.metricId) ? 'signed' : 'nonnegative') ||
      s.aggregation !== (stock ? 'none' : 'sum') ||
      s.decimals !== (stock ? 6 : 0) ||
      s.reference !== (stock ? 'annual_average' : 'calendar_year')
    )
      issue('Определение показателя не соответствует справочнику.');
    if (
      s.baseSeries &&
      (s.baseSeries.territoryKey !== s.territoryKey ||
        s.baseSeries.metricId !== s.metricId ||
        s.baseSeries.geographyEditionId !== s.geographyEditionId)
    )
      issue('Исходный ряд относится к другой территории, метрике или редакции границ.');
    if (
      !strictlySorted(s.points) ||
      !strictlySorted(s.overrides) ||
      s.points.some((p) => !acceptableValue(s.metricId, p.value)) ||
      s.overrides.some((p) => !acceptableValue(s.metricId, p.value) || p.revision > s.revision)
    )
      issue('Повреждены значения или порядок статистических наблюдений.');
    const effective = new Map((s.baseSeries?.points ?? []).map((p) => [p.year, p.value]));
    for (const point of s.overrides) effective.set(point.year, point.value);
    const expected = [...effective]
      .sort(([a], [b]) => a - b)
      .map(([y, n]) => ({ year: y, value: n }));
    if (normalizedJson(expected) !== normalizedJson(s.points))
      issue('Рабочие значения не воспроизводятся из исходного ряда и погодовых уточнений.');
    try {
      const { canonicalJson, fingerprint: _fingerprint, ...material } = s;
      if (normalizedJson(JSON.parse(canonicalJson)) !== normalizedJson(material))
        issue('Канонический текст статистической редакции не соответствует материалу.');
    } catch {
      issue('Повреждён канонический текст статистической редакции.');
    }
  });

export const statisticsHeadSchema = z
  .strictObject({
    metricId,
    revision,
    mode: z.enum(['team', 'imported']),
    seriesId: id.nullable(),
    updatedAt: timestamp,
  })
  .refine((s) => s.mode !== 'team' || s.seriesId !== null);
export const statisticsHeadsSchema = z
  .array(statisticsHeadSchema)
  .max(7)
  .refine((heads) => new Set(heads.map((h) => h.metricId)).size === heads.length);
export const saveStatisticsInputSchema = z
  .strictObject({
    roadmapId: z.uuid(),
    metricId,
    expectedRevision: integer.max(STATISTICS_LIMITS.revisions),
    changes: z.array(statisticsChangeSchema).min(1).max(STATISTICS_LIMITS.changes),
    ...provenance,
    comparabilityNote: text(STATISTICS_LIMITS.comparabilityNote),
  })
  .superRefine((input, ctx) => {
    if (new Set(input.changes.map((c) => c.year)).size !== input.changes.length)
      ctx.addIssue({
        code: 'custom',
        message: 'В одном сохранении год может встречаться только один раз.',
      });
    if (input.changes.some((c) => c.year > new Date().getUTCFullYear()))
      ctx.addIssue({
        code: 'custom',
        message: 'Будущие годы относятся к сценариям, а не к фактическим наблюдениям.',
      });
    if (input.changes.some((c) => c.action === 'set' && !acceptableValue(input.metricId, c.value)))
      ctx.addIssue({
        code: 'custom',
        message: 'Значение не соответствует определению показателя.',
      });
  });
export const restoreStatisticsInputSchema = z.strictObject({
  roadmapId: z.uuid(),
  metricId,
  expectedRevision: integer.max(STATISTICS_LIMITS.revisions),
  reason: requiredText(STATISTICS_LIMITS.reason),
});
export const getStatisticsHistoryInputSchema = z.strictObject({
  roadmapId: z.uuid(),
  metricId,
  beforeRevision: revision.optional(),
});
export const getStatisticsSeriesInputSchema = z.strictObject({ roadmapId: z.uuid(), seriesId: id });
export const statisticsHistorySchema = z
  .strictObject({
    roadmapId: z.uuid(),
    metricId,
    currentRevision: integer.max(STATISTICS_LIMITS.revisions),
    entries: z
      .array(
        z.strictObject({
          revision,
          action: z.enum(['save', 'restore']),
          seriesId: id.nullable(),
          createdAt: timestamp,
          createdBy: z.uuid(),
          createdByName: requiredText(200),
          sourceReference: requiredText(STATISTICS_LIMITS.sourceReference).nullable(),
          sourceDate: date.nullable(),
          reason: requiredText(STATISTICS_LIMITS.reason),
        }),
      )
      .max(STATISTICS_LIMITS.historyPage),
    nextBeforeRevision: revision.nullable(),
  })
  .refine((h) =>
    h.entries.every(
      (entry, i) =>
        entry.revision <= h.currentRevision &&
        (i === 0 || h.entries[i - 1]!.revision > entry.revision),
    ),
  );
export const statisticsSeriesPayloadSchema = z.strictObject({
  sessionId: z.uuid(),
  roadmapId: z.uuid(),
  series: teamStatisticalSeriesSchema,
});
export const parseTeamStatisticalSeries = (input: unknown): TeamStatisticalSeries =>
  teamStatisticalSeriesSchema.parse(input);
export const parseStatisticsHistory = (input: unknown): StatisticsHistory =>
  statisticsHistorySchema.parse(input);
export const parseStatisticsSeriesPayload = (input: unknown): StatisticsSeriesPayload =>
  statisticsSeriesPayloadSchema.parse(input);
