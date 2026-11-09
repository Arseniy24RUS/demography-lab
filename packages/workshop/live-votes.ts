import { z } from 'zod';

export type WorkspaceVoteValue = -1 | 1 | null;
export interface WorkspaceVoteTotals {
  familyId: string;
  title: string;
  fingerprint: string;
  support: number;
  oppose: number;
  unanswered: number;
  score: number;
}
export interface WorkspaceVoteFamily extends WorkspaceVoteTotals {
  myVote: WorkspaceVoteValue;
  myVoteRevision: number;
  /** The family changed since this participant last assessed it. */
  needsReview: boolean;
}
export interface WorkspaceVotesProjection {
  sessionId: string;
  cursor: number;
  /** Joined participants; this is not a count of currently connected devices. */
  participantCount: number;
  families: WorkspaceVoteTotals[];
}
export interface WorkspaceVotesSnapshot extends Omit<WorkspaceVotesProjection, 'families'> {
  families: WorkspaceVoteFamily[];
}
export interface WorkspaceVoteInput {
  familyId: string;
  value: WorkspaceVoteValue;
  expectedRevision: number;
  expectedFingerprint: string;
}

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fields = {
  familyId: z.uuid(), title: z.string().min(1).max(300), fingerprint: z.string().regex(/^[a-f\d]{64}$/u),
  support: count, oppose: count, unanswered: count,
  score: z.number().int().min(-1000).max(1000),
};
const total = z.strictObject(fields);
const own = z.strictObject({
  ...fields, myVote: z.union([z.literal(-1), z.literal(1), z.null()]),
  myVoteRevision: count, needsReview: z.boolean(),
}).refine((value) => !value.needsReview || value.myVote === null);
const projection = z.strictObject({
  sessionId: z.uuid(), cursor: count, participantCount: count.max(1000),
  families: z.array(total).max(200),
});
const snapshot = projection.extend({ families: z.array(own).max(200) });
function valid<T extends WorkspaceVotesProjection>(value: T): T {
  if (new Set(value.families.map((family) => family.familyId)).size !== value.families.length
    || value.families.some((family) => family.support + family.oppose + family.unanswered !== value.participantCount
      || family.score !== family.support - family.oppose))
    throw new Error('Сервер вернул несогласованные результаты голосования.');
  return value;
}
export const parseWorkspaceVotes = (value: unknown): WorkspaceVotesSnapshot => valid(snapshot.parse(value));
export const parseWorkspaceVotesProjection = (value: unknown): WorkspaceVotesProjection => valid(projection.parse(value));
