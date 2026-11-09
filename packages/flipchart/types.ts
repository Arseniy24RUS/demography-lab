/** Public classroom flipchart. The old private research questionnaire is separate. */
export const FLIPCHART_MAX_TEXT_LENGTH = 180;
export const FLIPCHART_MAX_NOTES = 20_000;
export const flipchartKinds = ['barrier', 'condition'] as const;
export type FlipchartKind = (typeof flipchartKinds)[number];
export type FlipchartVote = -1 | 1 | null;
export type FlipchartStatus = 'active' | 'withdrawn';

/** NFC and whitespace normalization agrees with PostgreSQL, including U+0085. */
export function normalizeFlipchartText(value: string): string {
  return value.normalize('NFC').replace(/[\s\u0085]+/gu, ' ').trim();
}

/** Safe for a projector: never includes actor IDs, names or a viewer's actions. */
export interface FlipchartPublicNote {
  id: string;
  kind: FlipchartKind;
  text: string;
  status: FlipchartStatus;
  createdAt: string;
  /** Status revision only. Voting does not invalidate a status command. */
  revision: number;
  support: number;
  oppose: number;
  score: number;
}

/** Identity is used privately for ownership and one current vote per person. */
export interface FlipchartNote extends FlipchartPublicNote {
  myVote: FlipchartVote;
  /** Zero before the first actual vote; retained after removing a vote. */
  myVoteRevision: number;
  canWithdraw: boolean;
}

interface UpdatesBase<TNote> {
  sessionId: string;
  cursor: number;
  reset: boolean;
  /** Active notes only. A reset replaces the entire local board. */
  notes: TNote[];
  /** Withdrawn notes changed since the cursor; empty on reset. */
  removedIds: string[];
}
export type FlipchartUpdates = UpdatesBase<FlipchartNote>;
export type FlipchartProjectionUpdates = UpdatesBase<FlipchartPublicNote>;

export interface FlipchartMutationResult {
  sessionId: string;
  /** Informational: never advance the read cursor from a mutation response. */
  cursor: number;
  note: FlipchartNote;
}

export interface AddFlipchartInput { kind: FlipchartKind; text: string }
export interface VoteFlipchartInput { value: FlipchartVote }
export interface StatusFlipchartInput { status: FlipchartStatus }
