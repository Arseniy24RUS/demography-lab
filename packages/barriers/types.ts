import type { FrozenVariant, VoteValue } from '../workshop/types';
import type { SessionPhase, SessionScope, SessionStatus } from '../collaboration/types';

export const lifeStages = ['life_plans', 'first_child', 'preparation_pregnancy', 'infancy', 'early_childhood', 'preschool', 'school', 'next_child'] as const;
export type LifeStage = (typeof lifeStages)[number];
export type BarrierEvidenceKind = 'observation' | 'hypothesis' | 'survey_summary';
export type BarrierStatus = 'active' | 'archived';
export type BarrierRelationship = 'potential' | 'partial' | 'needs_adaptation';
export type LinkStaleReason = 'barrier_changed' | 'barrier_archived' | 'family_changed' | 'family_missing';

export interface DiscussionTotals { support: number; oppose: number; neutral: number; cast: number }
export interface BarrierCard {
  id: string; authorId: string; authorName: string; title: string; description: string;
  primaryStage: LifeStage; stageIds: LifeStage[]; evidenceKind: BarrierEvidenceKind;
  status: BarrierStatus; priority: boolean; revision: number; contentRevision: number;
  totals: DiscussionTotals; myVote: VoteValue; myVoteRevision: number;
  createdAt: string; updatedAt: string;
}
export interface BarrierFamilyOption {
  id: string; title: string; mechanism: string; revision: number;
  fingerprint: string; variantCount: number; regionNames: string[];
}
/** A separately retrieved immutable family edition. It is reused by all links to that edition. */
export interface BarrierEvidence {
  id: string; sessionId: string; familyId: string; fingerprint: string;
  familyRevision: number; title: string; mechanism: string; rationale: string;
  variants: FrozenVariant[];
}
export interface BarrierPracticeLink {
  id: string; barrierId: string; familyId: string; authorId: string; authorName: string;
  relationship: BarrierRelationship; explanation: string; prerequisites: string;
  status: BarrierStatus; revision: number; barrierContentRevision: number;
  evidenceId: string; familyFingerprint: string; familyTitle: string;
  staleReasons: LinkStaleReason[]; createdAt: string; updatedAt: string;
}
export interface AuthorSolution {
  id: string; authorId: string; authorName: string; barrierIds: string[];
  title: string; targetGroup: string; mechanism: string; firstStep: string;
  responsible: string; resources: string; successIndicator: string; risks: string;
  status: BarrierStatus; revision: number; createdAt: string; updatedAt: string;
}
export interface BarriersSnapshot {
  sessionId: string; cursor: number;
  barriers: BarrierCard[]; families: BarrierFamilyOption[]; links: BarrierPracticeLink[]; solutions: AuthorSolution[];
  /** Configuration only. Raw survey answers are never included in the collaborative board. */
  survey: SurveySummary | null;
}
export type ProjectionBarrier = Omit<BarrierCard, 'authorId' | 'authorName' | 'myVote' | 'myVoteRevision'> & { authorName: string | null };
export type ProjectionBarrierLink = Omit<BarrierPracticeLink, 'authorId' | 'authorName'> & { authorName: string | null };
export type ProjectionSolution = Omit<AuthorSolution, 'authorId' | 'authorName'> & { authorName: string | null };
export interface BarriersProjection {
  sessionId: string; title: string; scope: SessionScope; regionId: string | null;
  phase: SessionPhase; status: SessionStatus; cursor: number;
  barriers: ProjectionBarrier[]; families: BarrierFamilyOption[]; links: ProjectionBarrierLink[]; solutions: ProjectionSolution[];
  survey: ProjectionSurveySummary | null;
}
export interface ProjectionSurveySummary { title: string; status: SurveyStatus; responseCount: number | null }
export interface SaveBarrierInput {
  barrierId: string | null; expectedRevision: number; title: string; description: string;
  primaryStage: LifeStage; stageIds: LifeStage[]; evidenceKind: BarrierEvidenceKind;
  status: BarrierStatus; priority: boolean;
}
export interface BarrierVoteInput { barrierId: string; expectedRevision: number; value: VoteValue }
export interface SaveBarrierLinkInput {
  linkId: string | null; expectedRevision: number; barrierId: string; expectedBarrierRevision: number;
  familyId: string; expectedFamilyFingerprint: string; relationship: BarrierRelationship;
  explanation: string; prerequisites: string; status: BarrierStatus;
}
export interface SaveSolutionInput {
  solutionId: string | null; expectedRevision: number; barrierIds: string[];
  title: string; targetGroup: string; mechanism: string; firstStep: string;
  responsible: string; resources: string; successIndicator: string; risks: string; status: BarrierStatus;
}

export type SurveyStatus = 'draft' | 'open' | 'closed' | 'purged';
export type SurveyPerspective = 'self' | 'adult_child_reported' | 'adult_child_inferred' | 'professional' | 'decline';
export type SurveyIntention = 'definitely_yes' | 'probably_yes' | 'probably_no' | 'definitely_no' | 'unsure' | 'not_applicable' | 'decline';
export type SurveyHorizon = 'within_12m' | '13_36m' | 'after_36m' | 'no_change' | 'unsure' | 'decline';
export type SurveyConditional = 'definitely_change' | 'probably_change' | 'probably_no_change' | 'definitely_no_change' | 'unsure' | 'decline';
export interface SurveyQuestions { q00: string; q05_12m: string; q05_36m: string; q01: string; q02: string; q03: string; q04: string; q06: string; q07: string; q08: string }
export interface SurveyPublicManifest {
  id: string; title: string; purpose: string; organizerContact: string;
  retentionUntil: string; status: SurveyStatus; expired: boolean; canRespond: boolean;
  questionVersion: number; questionnaireVersion: 'demography-open-1'; procedureVersion: 'classroom-open-link-1';
  questions: SurveyQuestions;
}
export interface SurveySummary extends SurveyPublicManifest {
  revision: number;
  /** Null means suppressed: fewer than five current, non-withdrawn responses or no raw data available. */
  responseCount: number | null;
}
/** Shared launch metadata. The invitation token identifies the form, never a respondent. */
export interface WorkshopSurveyEntry {
  sessionId: string;
  survey: SurveySummary;
  invitationToken: string | null;
}
export interface SurveyConfigInput {
  surveyId: string | null; expectedRevision: number; title: string; purpose: string;
  organizerContact: string; retentionUntil: string; questionBarrier: string; questionSupport: string;
  /** Client-generated 32-byte lowercase hex, required only on creation. Server stores its hash only. */
  invitationToken?: string;
}
export interface SurveyActionInput {
  surveyId: string; expectedRevision: number; action: 'open' | 'close' | 'purge' | 'rotate';
  /** Required only for rotate. A replacement secret is generated and kept by the host client. */
  invitationToken?: string;
}
export interface SurveyAnswerFields {
  perspective: SurveyPerspective;
  intention12m: SurveyIntention | null; intention36m: SurveyIntention | null;
  answerBarrier: string | null; answerSupport: string | null;
  priorityChange: string | null; priorityConditionId: string | null;
  horizon: SurveyHorizon | null; conditionalChange: SurveyConditional | null;
  additionalConditions: string | null;
  consentEducational: boolean; consentResearch: boolean; consentQuote: boolean; adultConfirmed: boolean;
}
export interface SurveyResponseInput extends SurveyAnswerFields {
  expectedRevision: number; questionVersion: number;
}
export interface SurveyOwnResponse extends SurveyAnswerFields {
  status: 'none' | 'submitted' | 'withdrawn'; revision: number; questionVersion: number;
  /** Expired/purged responses return a blank field set; withdrawal remains possible. */
  availability: 'open' | 'closed' | 'expired' | 'purged';
}
/** Host-only raw view. rowKey is a response UUID, not a profile or respondent identity. */
export interface SurveyHostResponse extends SurveyAnswerFields {
  rowKey: string; questionVersion: number; revision: number; responseDate: string;
}
export interface SurveyHostState {
  survey: SurveySummary; responseCount: number; researchCount: number; quoteCount: number;
  /** SHA-256 of UTF-8 "dw-survey-invite:" + token; host only, never the token itself. */
  invitationDigest: string;
  responses: SurveyHostResponse[];
}
/** Metadata-only recovery check. Opening the board must not implicitly retrieve private responses. */
export interface SurveyInvitationState { surveyId: string; invitationDigest: string }
export interface SurveyExportRecord extends Omit<SurveyAnswerFields, 'priorityConditionId' | 'consentEducational' | 'adultConfirmed'> {
  questionVersion: number; responseDate: string;
  missingReasons: Record<string, 'skipped' | 'not_asked'>;
}
export interface SurveyResearchExport {
  datasetVersion: 'demography-research-export-1'; procedureVersion: 'classroom-open-link-1';
  exportDate: string; samplingNote: string; questionnaire: SurveyPublicManifest;
  missingCodes: { skipped: 'null'; notAsked: 'not_asked'; notApplicable: 'not_applicable'; declined: 'decline' };
  records: SurveyExportRecord[];
}
