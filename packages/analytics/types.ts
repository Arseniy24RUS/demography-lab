import type { MunicipalMetricDefinition } from '../territories/types';

/** Deterministic analytical kernel. Source observations and legal judgements remain external. */
export const ANALYTICS_VERSION = 'roadmap-analytics-1' as const;
export const MAX_MONEY_KOPECKS = Number.MAX_SAFE_INTEGER;

export interface AnalysisIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  entityId?: string;
  field?: string;
}

export class CalculationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CalculationError';
  }
}

/** Extends the canonical municipal definition only for explicitly entered operational indicators. */
export type ScenarioMetricDefinition = Omit<
  MunicipalMetricDefinition,
  'id' | 'unit' | 'kind' | 'reference' | 'sourceKind'
> & {
  id: string;
  unit: string;
  kind: 'stock' | 'flow' | 'rate' | 'share';
  reference: string;
  sourceKind: MunicipalMetricDefinition['sourceKind'] | 'team_reported';
  scale?: 'number' | 'percent' | 'ratio';
  bounds?: { min: number | null; max: number | null };
  integerTargets?: boolean;
};
export interface ObservationPoint {
  year: number;
  value: number | null;
}
export type TargetMode =
  'absolute_end' | 'relative_end' | 'annual_growth' | 'absolute_delta_end' | 'percentage_points';
export interface ScenarioParameters {
  metricId: string;
  historyStartYear: number;
  historyEndYear: number;
  endYear: number;
  baselineMethod: 'last_value' | 'linear';
  targetMode: TargetMode;
  /** Percent input is expressed in percentage units: 10 means 10%, not 0.1. */
  targetValue: number;
}
export interface ScenarioSourceContext {
  seriesId: string;
  fingerprint: string;
  editionId: string;
  territoryKey: string;
  provenanceStatus: string;
  geographyComparability: 'verified' | 'not_verified';
  note?: string;
}
export interface ScenarioInput {
  definition: ScenarioMetricDefinition;
  series: ObservationPoint[];
  parameters: ScenarioParameters;
  source?: ScenarioSourceContext;
}
export interface ScenarioYear {
  year: number;
  observedValue: number | null;
  baselineValue: number | null;
  targetValue: number | null;
  /** Rounded planning value is separate from the exact calculated target. */
  plannedTargetValue: number | null;
  delta: number | null;
  baselineClipped: boolean;
  targetClipped: boolean;
}
export interface ScenarioResult {
  algorithmVersion: typeof ANALYTICS_VERSION;
  definition: ScenarioMetricDefinition;
  parameters: ScenarioParameters;
  source: ScenarioSourceContext | null;
  history: ObservationPoint[];
  baselineYear: number;
  baselineObservedValue: number;
  horizonYears: number;
  /** Actual years used by the baseline method, distinguished from the selected display window. */
  trainingYears: number[];
  years: ScenarioYear[];
  coefficients: { firstYear: number; intercept: number; slopePerYear: number } | null;
  backtest: { heldOutYears: number[]; linearMae: number; lastValueMae: number } | null;
  endGap: number;
  /** Only flow differences may be accumulated; stock/rate/share receive null. */
  cumulativeFlowGap: number | null;
  warnings: AnalysisIssue[];
  interpretation: 'planning_gap_not_causal_effect';
}

export interface BudgetCostInput {
  id: string;
  activityId: string;
  year: number;
  title: string;
  unit: string;
  /** Decimal quantity, at most three fractional digits; no binary floating-point amount. */
  quantity: string;
  unitPriceKopecks: number;
  periods: number;
  cashKind: 'cash' | 'in_kind';
  priceStatus: 'confirmed' | 'estimated';
  priceSource: string;
  priceDate: string | null;
}

export type FundingStatus = 'confirmed' | 'budget_draft' | 'application' | 'assumption';
export interface FundingInput {
  id: string;
  costLineId: string;
  amountKopecks: number;
  status: FundingStatus;
  sourceName: string;
  sourceReference: string;
  sourceDate: string | null;
}

export interface BudgetAmounts {
  needCashKopecks: number;
  inKindKopecks: number;
  confirmedKopecks: number;
  expectedKopecks: number;
  confirmedGapKopecks: number;
  remainingAfterExpectedKopecks: number;
}
export interface BudgetLineResult extends BudgetAmounts {
  id: string;
  activityId: string;
  year: number;
  totalKopecks: number;
}
export interface BudgetResult {
  algorithmVersion: typeof ANALYTICS_VERSION;
  rounding: 'half_up_per_line';
  lines: BudgetLineResult[];
  years: Array<BudgetAmounts & { year: number }>;
  totals: BudgetAmounts;
  issues: AnalysisIssue[];
}

export interface ActivityDependency {
  predecessorId: string;
  lagDays: number;
}
export interface CalendarActivity {
  id: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  dependencies: ActivityDependency[];
}
export interface ProjectPeriod {
  startDate: string;
  endDate: string;
}
export interface CalendarResult {
  calendar: 'calendar_days';
  issues: AnalysisIssue[];
  /** Includes only dated activities, without inventing dates for incomplete drafts. */
  rows: Array<{
    id: string;
    title: string;
    startDate: string;
    endDate: string;
    durationDays: number;
    offsetDays: number;
  }>;
  topologicalOrder: string[] | null;
  totalDays: number;
}
