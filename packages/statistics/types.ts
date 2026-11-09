import type { CanonicalMunicipalSeries, MunicipalMetricId } from '../territories/types';

export const STATISTICS_METRIC_IDS = [
  'births_total',
  'deaths_total',
  'pop_mid',
  'mig_in_total',
  'mig_out_total',
  'mig_net_total',
  'natural_change',
] as const satisfies readonly MunicipalMetricId[];

export const STATISTICS_LIMITS = {
  changes: 301,
  points: 301,
  revisions: 500,
  historyPage: 50,
  sourceReference: 2000,
  reason: 4000,
  comparabilityNote: 4000,
  sourceValueAbs: 1e15,
  populationDecimals: 6,
  seriesBytes: 262144,
  historyStorageBytes: 33554432,
} as const;

/** A patch distinguishes missing observations from explicit zero and restoring a source. */
export type StatisticsChange =
  { year: number; action: 'set'; value: number | null } | { year: number; action: 'reset' };

/** Attribution belongs to an observation, never retroactively to the entire historical series. */
export interface StatisticsOverride {
  year: number;
  value: number | null;
  sourceReference: string;
  sourceDate: string | null;
  reason: string;
  revision: number;
  updatedAt: string;
}

export interface TeamStatisticalSeries {
  id: string;
  territoryKey: string;
  metricId: MunicipalMetricId;
  title: string;
  unit: 'persons';
  semanticType: 'stock' | 'flow';
  valueDomain: 'nonnegative' | 'signed';
  aggregation: 'sum' | 'none';
  decimals: number;
  reference: 'annual_average' | 'calendar_year';
  sourceEditionId: 'team-statistics-v1';
  sourceKind: 'team_reported';
  provenanceStatus: 'participant_supplied';
  geographyEditionId: string;
  geographyComparability: 'not_verified';
  comparabilityNote: string;
  baseSeries: CanonicalMunicipalSeries | null;
  points: Array<{ year: number; value: number | null }>;
  overrides: StatisticsOverride[];
  revision: number;
  /** Metadata of this command. Per-year provenance is retained in overrides. */
  sourceReference: string;
  sourceDate: string | null;
  reason: string;
  recordedAt: string;
  /** Exact server JSONB UTF-8 text of this object except canonicalJson and fingerprint. */
  canonicalJson: string;
  fingerprint: string;
}

/** No actor identifiers or names: safe for projector and immutable statistical materials. */
export interface StatisticsHead {
  metricId: MunicipalMetricId;
  revision: number;
  mode: 'team' | 'imported';
  seriesId: string | null;
  updatedAt: string;
}

export interface SaveStatisticsInput {
  roadmapId: string;
  metricId: MunicipalMetricId;
  expectedRevision: number;
  changes: StatisticsChange[];
  sourceReference: string;
  sourceDate: string | null;
  reason: string;
  comparabilityNote: string;
}
export interface RestoreStatisticsInput {
  roadmapId: string;
  metricId: MunicipalMetricId;
  expectedRevision: number;
  reason: string;
}
export interface GetStatisticsHistoryInput {
  roadmapId: string;
  metricId: MunicipalMetricId;
  beforeRevision?: number;
}
export interface StatisticsRevision {
  revision: number;
  action: 'save' | 'restore';
  seriesId: string | null;
  createdAt: string;
  createdBy: string;
  createdByName: string;
  sourceReference: string | null;
  sourceDate: string | null;
  reason: string;
}
export interface StatisticsHistory {
  roadmapId: string;
  metricId: MunicipalMetricId;
  currentRevision: number;
  entries: StatisticsRevision[];
  nextBeforeRevision: number | null;
}
export interface GetStatisticsSeriesInput {
  roadmapId: string;
  seriesId: string;
}
export interface StatisticsSeriesPayload {
  sessionId: string;
  roadmapId: string;
  series: TeamStatisticalSeries;
}
