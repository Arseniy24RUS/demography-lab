import type { SessionScope, SharedPracticeBundle } from '../collaboration/types';

/** Stage 3 API. Work allocation and grouping are separate from source text and practice variants. */
export type RegionWorkStatus = 'available' | 'in_progress' | 'completed';
export type RegionWorkAction = 'claim' | 'release' | 'complete' | 'reopen' | 'renew';
/** Zero is an explicit abstention. Null means no answer / withdrawn ballot. */
export type VoteValue = -1 | 0 | 1 | null;
export type ResultsVisibility = 'live' | 'after_close';

export interface RegionWork {
  regionId: string;
  ownerId: string | null;
  ownerName: string | null;
  status: RegionWorkStatus;
  /** In-progress allocations expire after 30 minutes; renew is an explicit user action. */
  leaseExpiresAt: string | null;
  completionNote: string;
  revision: number;
  updatedAt: string;
}

export interface PracticeFamily {
  id: string;
  title: string;
  mechanism: string;
  rationale: string;
  /** Original submissions remain separate and are never rewritten by grouping. */
  submissionIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface VoteTotals {
  support: number;
  oppose: number;
  neutral: number;
  unanswered: number;
  /** All explicit answers, including neutral. */
  cast: number;
  score: number;
  substantive: number;
  coverage: number | null;
  supportRatio: number | null;
  net: number | null;
  qualifies: boolean;
}

export interface FrozenVariant {
  submissionId: string;
  submissionRevision: number;
  bundle: SharedPracticeBundle;
}

export interface FrozenFamily {
  id: string;
  title: string;
  mechanism: string;
  rationale: string;
  variants: FrozenVariant[];
  /** null means the instructor chose to reveal results only after the round closes. */
  totals: VoteTotals | null;
  /** Null is distinct from an explicit neutral answer (0). */
  myVote: VoteValue;
  myVoteRevision: number;
}

export interface VotingRoundSummary {
  id: string;
  title: string;
  status: 'open' | 'closed';
  resultsVisibility: ResultsVisibility;
  promptText: string;
  contextScope: SessionScope;
  contextRegionId: string | null;
  evaluationDimension: 'priority_for_adaptation';
  minCoverage: number;
  minSubstantiveVotes: number;
  revision: number;
  eligibleCount: number;
  familyCount: number;
  openedAt: string;
  closedAt: string | null;
}

export interface VotingRound extends VotingRoundSummary {
  canVote: boolean;
  totalsVisible: boolean;
  /** Number of the captured eligible roster with at least one explicit answer. */
  participatingCount: number;
  families: FrozenFamily[];
}

export interface WorkshopSnapshot {
  sessionId: string;
  cursor: number;
  /** Captured before a curation operation; independent of individual ballots. */
  boardRevision: number;
  regionWork: RegionWork[];
  families: PracticeFamily[];
  rounds: VotingRoundSummary[];
  /** Latest round; prior rounds are available through dw_workshop_round_snapshot. */
  round: VotingRound | null;
}

/** Transport-only compact form. Hydrate variants from the same immutable round before parsing. */
export interface WorkshopUpdateSnapshot extends Omit<WorkshopSnapshot, 'round'> {
  round: (Omit<VotingRound, 'families'> & {
    families: Array<Omit<FrozenFamily, 'variants'> & { variants: FrozenVariant[] | null }>;
  }) | null;
}

export interface ProjectionFrozenFamily extends Omit<FrozenFamily, 'myVote' | 'myVoteRevision'> {}
export interface ProjectionVotingRound extends VotingRoundSummary {
  totalsVisible: boolean;
  participatingCount: number;
  families: ProjectionFrozenFamily[];
}
export interface WorkshopProjection {
  sessionId: string;
  title: string;
  phase: 'reading' | 'review' | 'discussion';
  status: 'open' | 'paused' | 'closed';
  cursor: number;
  regionWork: Array<Pick<RegionWork, 'regionId' | 'status' | 'revision' | 'leaseExpiresAt'>>;
  familyCount: number;
  groupedSubmissionCount: number;
  round: ProjectionVotingRound | null;
}

export interface RegionWorkInput {
  regionId: string;
  action: RegionWorkAction;
  /** 0 denotes a region with no existing allocation row. */
  expectedRevision: number;
  note: string;
}
export interface SaveFamilyInput {
  /** null creates a new family. */
  familyId: string | null;
  expectedBoardRevision: number;
  title: string;
  mechanism: string;
  rationale: string;
  /** Replaces this family's members; moving from another family is atomic. */
  submissionIds: string[];
}
export interface OpenRoundInput {
  title: string;
  resultsVisibility: ResultsVisibility;
  expectedBoardRevision: number;
  settings?: {
    promptText?: string;
    minCoverage?: number;
    minSubstantiveVotes?: number;
  };
}
export interface CastVoteInput {
  roundId: string;
  familyId: string;
  value: VoteValue;
  expectedRevision: number;
}
