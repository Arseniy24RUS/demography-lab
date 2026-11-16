import type { SessionScope } from '../collaboration/types';
import type { CanonicalMunicipalSeries } from '../territories/types';
import type { StatisticsHead, TeamStatisticalSeries } from '../statistics/types';
import type { BarrierEvidence } from '../barriers/types';

export const roadmapItemKinds = [
  'passport',
  'diagnosis',
  'monitoring',
  'activity',
  'indicator',
  'scenario',
  'cost',
  'funding',
  'risk',
  'fact',
] as const;
export type RoadmapItemKind = (typeof roadmapItemKinds)[number];
export type RoadmapItemStatus = 'active' | 'archived';
export type RoadmapValueDomain = 'nonnegative' | 'signed' | 'percent' | 'ratio';
export type RoadmapSemanticType = 'stock' | 'flow' | 'rate' | 'share';
export type RoadmapRoomLevel = SessionScope | 'organization';
export const ROADMAP_LIMITS = {
  rooms: 1000,
  activity: 40,
  indicator: 20,
  scenario: 20,
  cost: 100,
  funding: 200,
  risk: 30,
  fact: 20,
  basis: 40,
  objectives: 30,
  versions: 30,
  snapshotBytes: 1048576,
  frozenBytes: 8388608,
  versionStorageBytes: 134217728,
} as const;

/** The selected source geography is versioned; source codes are not certified current OKTMO. */
export interface RoadmapTerritory {
  key: string;
  name: string;
  level: RoadmapRoomLevel;
  regionId: string | null;
  sourceEditionId: string;
  sourceCode: string | null;
  sourceType: string;
  geographicStatus: string;
  sourceUrl: string;
  boundaryVersion: string | null;
}
export type RoadmapSeries = CanonicalMunicipalSeries | TeamStatisticalSeries;
export const roadmapSmartCriteria = ['specific', 'measurable', 'achievable', 'relevant', 'timeBound'] as const;
export type RoadmapSmartCriterion = (typeof roadmapSmartCriteria)[number];
export interface RoadmapPassportData {
  title: string;
  targetGroup: string;
  partners: string;
  goal: string;
  smartChecks?: RoadmapSmartCriterion[];
  objectives: Array<{ id: string; title: string }>;
  startDate: string | null;
  endDate: string | null;
  expectedResult: string;
  /** Retained in stored passports and immutable snapshots for backward compatibility. */
  defenseDate: string | null;
  humanResources: string;
  /** Infrastructure, using the storage key from earlier passports. */
  materialResources: string;
  informationResources: string;
  normativeResources?: string;
  managementResources?: string;
  researchResources?: string;
  economicResources?: string;
  demographicResources?: string;
  institutionalResources?: string;
  technologyResources?: string;
}
export interface RoadmapDiagnosisData {
  problem: string;
  causeHypothesis: string;
  conclusion: string;
}
export interface RoadmapMonitoringData {
  frequency: string;
  method: string;
  responsible: string;
  interimReportDate: string | null;
  finalReportDate: string | null;
  qualitativeResults: string;
  sustainability: string;
}
export interface RoadmapActivityData {
  title: string;
  description: string;
  objectiveId: string | null;
  targetGroup: string;
  scale: string;
  startDate: string | null;
  endDate: string | null;
  responsible: string;
  partners: string;
  deliverable: string;
  completionCriterion: string;
  authorityLevel: 'municipal' | 'regional' | 'federal' | 'organization' | 'joint' | 'unknown';
  legalBasis: string;
  approvalStatus: 'unknown' | 'requires_decision' | 'verified_source' | 'contradiction';
  responsibleBody: string;
  necessaryDecision: string;
  indicatorIds: string[];
  dependencies: Array<{ predecessorId: string; lagDays: number }>;
  stage: 'preparation' | 'implementation' | 'evaluation' | 'custom';
  stageLabel: string;
  progressStatus: 'planned' | 'in_progress' | 'completed';
}
export interface RoadmapIndicatorData {
  title: string;
  definition: string;
  kind: 'resource' | 'output' | 'family_outcome' | 'demographic_context';
  unit: string;
  semanticType: RoadmapSemanticType;
  valueDomain: RoadmapValueDomain;
  numeratorDefinition: string;
  denominatorDefinition: string;
  baselineValue: number | null;
  baselineYear: number | null;
  annualTargets: Array<{ year: number; value: number }>;
  sourceReference: string;
  frequency: string;
  responsible: string;
  limitations: string;
  scenarioId: string | null;
}
export interface RoadmapScenarioParameters {
  metricId: string;
  historyStartYear: number;
  historyEndYear: number;
  endYear: number;
  baselineMethod: 'last_value' | 'linear' | 'historical_continuation';
  targetMode:
    'absolute_end' | 'relative_end' | 'annual_growth' | 'absolute_delta_end' | 'percentage_points';
  /** 10 is ten percent / ten percentage points in the applicable modes. */
  targetValue: number;
}
export interface RoadmapScenarioData {
  title: string;
  seriesId: string;
  seriesFingerprint: string;
  assumptions: string;
  parameters: RoadmapScenarioParameters;
}
export interface RoadmapCostData {
  activityId: string;
  year: number;
  title: string;
  unit: string;
  /** Canonical wire quantity uses a dot and at most three decimal places. */
  quantity: string;
  unitPriceKopecks: number;
  periods: number;
  cashKind: 'cash' | 'in_kind';
  priceStatus: 'confirmed' | 'estimated';
  priceSource: string;
  priceDate: string | null;
}
export interface RoadmapFundingData {
  costLineId: string;
  sourceName: string;
  sourceKind:
    'municipal_budget' | 'regional_budget' | 'federal_budget' | 'employer' | 'grant' | 'other';
  amountKopecks: number;
  status: 'confirmed' | 'budget_draft' | 'application' | 'assumption';
  sourceReference: string;
  sourceDate: string | null;
  originReference: string;
}
export interface RoadmapRiskData {
  title: string;
  mitigation: string;
  owner: string;
  trigger: string;
  contingency: string;
}
export interface RoadmapFactData {
  sourceKind: 'registry' | 'team_statistics' | 'external_unverified';
  title: string;
  interpretation: string;
  year: number | null;
  value: number | null;
  unit: string;
  sourceReference: string;
  sourceDate: string | null;
  seriesId: string | null;
  seriesFingerprint: string | null;
  metricId: string | null;
}
export interface RoadmapDataMap {
  passport: RoadmapPassportData;
  diagnosis: RoadmapDiagnosisData;
  monitoring: RoadmapMonitoringData;
  activity: RoadmapActivityData;
  indicator: RoadmapIndicatorData;
  scenario: RoadmapScenarioData;
  cost: RoadmapCostData;
  funding: RoadmapFundingData;
  risk: RoadmapRiskData;
  fact: RoadmapFactData;
}
export type RoadmapItem<K extends RoadmapItemKind = RoadmapItemKind> = {
  [P in K]: {
    id: string;
    kind: P;
    data: RoadmapDataMap[P];
    status: RoadmapItemStatus;
    revision: number;
    createdBy: string;
    createdByName: string;
    updatedBy: string;
    updatedByName: string;
    createdAt: string;
    updatedAt: string;
  };
}[K];
export type SaveRoadmapItemInput<K extends RoadmapItemKind = RoadmapItemKind> = {
  [P in K]: {
    roadmapId: string;
    itemId: string | null;
    expectedRevision: number;
    kind: P;
    data: RoadmapDataMap[P];
    status: RoadmapItemStatus;
  };
}[K];

export interface RoadmapBarrierGround {
  id: string;
  title: string;
  description: string;
  stageIds: string[];
  evidenceKind: 'observation' | 'hypothesis' | 'survey_summary';
  contentRevision: number;
  status: 'active' | 'archived';
}
export interface RoadmapSolutionGround {
  id: string;
  title: string;
  targetGroup: string;
  mechanism: string;
  firstStep: string;
  responsible: string;
  resources: string;
  successIndicator: string;
  risks: string;
  revision: number;
  status: 'active' | 'archived';
  barriers: RoadmapBarrierGround[];
}
export interface RoadmapLinkGround {
  id: string;
  relationship: 'potential' | 'partial' | 'needs_adaptation';
  explanation: string;
  prerequisites: string;
  revision: number;
  status: 'active' | 'archived';
  barrier: RoadmapBarrierGround;
  evidenceId: string;
  familyTitle: string;
  familyFingerprint: string;
}
export interface RoadmapFactorGround {
  id: string;
  title: string;
  board: 'parenthood' | 'objective';
  revision: number;
  status: RoadmapItemStatus;
  barriers: RoadmapBarrierGround[];
}
export type RoadmapBasisMaterial =
  | { kind: 'barrier'; source: RoadmapBarrierGround }
  | { kind: 'solution'; source: RoadmapSolutionGround }
  | { kind: 'link'; source: RoadmapLinkGround }
  | { kind: 'factor'; source: RoadmapFactorGround };
export interface RoadmapBasis {
  id: string;
  sourceKind: RoadmapBasisMaterial['kind'];
  sourceId: string;
  sourceRevision: number;
  fingerprint: string;
  material: RoadmapBasisMaterial;
  rationale: string;
  status: RoadmapItemStatus;
  revision: number;
  staleReasons: Array<
    'source_changed' | 'source_archived' | 'source_missing' | 'source_basis_stale'
  >;
  createdAt: string;
  updatedAt: string;
}
export interface CaptureRoadmapBasisInput {
  roadmapId: string;
  basisId: string | null;
  expectedRevision: number;
  sourceKind: 'barrier' | 'link' | 'solution';
  sourceId: string;
  expectedSourceRevision: number;
  rationale: string;
  status: RoadmapItemStatus;
}
export type RoadmapWorkshopMeasure = { kind: 'family' | 'factor' | 'solution'; id: string };
export interface ImportRoadmapWorkshopInput {
  roadmapId: string;
  barrierIds: string[];
  measures: RoadmapWorkshopMeasure[];
}
export interface CaptureRoadmapFactInput {
  roadmapId: string;
  itemId: string | null;
  expectedRevision: number;
  seriesId: string;
  expectedSeriesFingerprint: string;
  year: number;
  interpretation: string;
}
export interface RoadmapBudgetYear {
  year: number;
  needCashKopecks: number;
  inKindKopecks: number;
  confirmedKopecks: number;
  expectedKopecks: number;
  confirmedGapKopecks: number;
  remainingAfterExpectedKopecks: number;
}
export interface RoadmapBudgetTotals extends Omit<RoadmapBudgetYear, 'year'> {
  years: RoadmapBudgetYear[];
}
export interface RoadmapConfiguration {
  roomLevel: SessionScope;
  revision: number;
  locked: boolean;
  dataEditionId: string | null;
}
export interface RoadmapRoomSummary {
  id: string;
  /** Administrative demonstration label; source geography remains unchanged. */
  exampleLabel?: string;
  territory: RoadmapTerritory;
  revision: number;
  memberCount: number;
  activeItemCount: number;
  versionCount: number;
  latestVersionKind: 'draft' | 'submitted' | null;
  updatedAt: string;
}
export interface RoadmapsIndex {
  sessionId: string;
  cursor: number;
  sourceCursor: number;
  configuration: RoadmapConfiguration;
  myRoadmapId: string | null;
  assignmentRevision: number;
  rooms: RoadmapRoomSummary[];
}
export interface RoadmapPresence {
  sessionId: string;
  counts: Array<{ roadmapId: string; count: number }>;
}
export interface RoadmapReview {
  decision: 'revise' | 'discussed';
  comment: string;
  revision: number;
  reviewedAt: string;
  reviewerName: string;
}
export interface RoadmapVersionSummary {
  id: string;
  number: number;
  kind: 'draft' | 'submitted';
  title: string;
  roadmapRevision: number;
  sha256: string;
  createdAt: string;
  review: RoadmapReview | null;
}
export interface CohortForecastParameters {
  endYear: number;
  fertilityMultiplier: number;
  mortalityMultiplier: number;
  arrivalsMultiplier: number;
  departuresMultiplier: number;
}
export interface RoadmapCohortSettings {
  revision: number;
  parameters: CohortForecastParameters;
}
export interface SaveRoadmapCohortInput {
  roadmapId: string;
  expectedRevision: number;
  parameters: CohortForecastParameters;
}
export interface RoadmapSnapshot {
  sessionId: string;
  roadmapId: string;
  exampleLabel?: string;
  cursor: number;
  sourceCursor: number;
  revision: number;
  territory: RoadmapTerritory;
  roomLevel: RoadmapRoomLevel;
  canEdit: boolean;
  members: Array<{ userId: string; fullName: string }>;
  items: RoadmapItem[];
  basis: RoadmapBasis[];
  series: RoadmapSeries[];
  statistics?: StatisticsHead[];
  cohortSettings?: RoadmapCohortSettings;
  versions: RoadmapVersionSummary[];
  budget: RoadmapBudgetTotals;
}
export type FrozenRoadmapItem<K extends RoadmapItemKind = RoadmapItemKind> = {
  [P in K]: {
    id: string;
    kind: P;
    data: RoadmapDataMap[P];
    status: RoadmapItemStatus;
    revision: number;
  };
}[K];
export interface FrozenRoadmapData {
  schemaVersion: 1 | 2;
  templateVersion: 'organizers-roadmap-1';
  calculationVersion: 'roadmap-analytics-1';
  exampleLabel?: string;
  territory: RoadmapTerritory;
  roomLevel: RoadmapRoomLevel;
  roadmapRevision: number;
  session: { title: string; scope: SessionScope; regionId: string | null };
  teamNames: string[];
  items: FrozenRoadmapItem[];
  basis: RoadmapBasis[];
  series: RoadmapSeries[];
  /** Required for schemaVersion 2; absent in unchanged stage-5 frozen bytes. */
  statistics?: StatisticsHead[];
  /** Saved cohort parameters, omitted when the team has no settings on record. */
  cohortSettings?: RoadmapCohortSettings;
  /** Complete immutable regional materials, copied by the server at capture time. */
  evidence: BarrierEvidence[];
  budget: RoadmapBudgetTotals;
}
export interface RoadmapVersion extends RoadmapVersionSummary {
  sessionId: string;
  roadmapId: string;
  /** Exact PostgreSQL JSONB text whose UTF-8 SHA-256 is sha256. Parse and validate, then recompute before export. */
  canonicalJson: string;
  snapshot: FrozenRoadmapData;
}
export interface RoadmapsProjection {
  sessionId: string;
  title: string;
  cursor: number;
  sourceCursor: number;
  rooms: RoadmapRoomSummary[];
  selected: {
    roadmapId: string;
    exampleLabel?: string;
    territory: RoadmapTerritory;
    roomLevel: RoadmapRoomLevel;
    revision: number;
    items: FrozenRoadmapItem[];
    basis: RoadmapBasis[];
    series: RoadmapSeries[];
    statistics?: StatisticsHead[];
    budget: RoadmapBudgetTotals;
  } | null;
}
export interface ConfigureRoadmapsInput {
  expectedRevision: number;
  roomLevel: SessionScope;
}
export type JoinRoadmapInput = {
  territoryKey: string;
  dataEditionId: string;
  expectedAssignmentRevision: number;
} | {
  roadmapId: string;
  expectedAssignmentRevision: number;
};
export interface CreateOrganizationRoadmapInput {
  name: string;
  expectedAssignmentRevision: number;
}
export interface FreezeRoadmapInput {
  roadmapId: string;
  expectedRevision: number;
  title: string;
  kind: 'draft' | 'submitted';
}
export interface ReviewRoadmapInput {
  roadmapId: string;
  versionId: string;
  expectedRevision: number;
  decision: 'revise' | 'discussed';
  comment: string;
}
