import { z } from 'zod';
import {
  FLIPCHART_MAX_NOTES, FLIPCHART_MAX_TEXT_LENGTH, flipchartKinds, normalizeFlipchartText,
} from './types';
import type {
  FlipchartMutationResult, FlipchartNote, FlipchartProjectionUpdates, FlipchartUpdates,
} from './types';

const uuid = z.uuid();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = count.min(1);
const timestamp = z.string().min(20).max(40).refine((v) => Number.isFinite(Date.parse(v)));
const kind = z.enum(flipchartKinds);
const factorKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/u);
const status = z.enum(['active', 'withdrawn']);
const vote = z.union([z.literal(-1), z.literal(1), z.null()]);
const validText = (v: string) => [...v].length >= 1 && [...v].length <= FLIPCHART_MAX_TEXT_LENGTH
  && !/[\u0000-\u0008\u000e-\u001f\u007f]/u.test(v);
const canonicalText = z.string().refine((v) => validText(v) && v === normalizeFlipchartText(v));
const publicFields = {
  id: uuid, kind, text: canonicalText, status, createdAt: timestamp, revision, factorKey: factorKey.optional(),
  territoryCount: count.optional(),
  support: count, oppose: count, score: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
};
const publicNote = z.strictObject(publicFields).refine((v) => v.score === v.support - v.oppose
  && (v.territoryCount === undefined || v.factorKey !== undefined));
const note = z.strictObject({ ...publicFields, territoryKeys: z.array(factorKey).optional(),
  myVote: vote, myVoteRevision: count, canWithdraw: z.boolean() })
  .refine((v) => v.score === v.support - v.oppose
    && (v.territoryCount === undefined || v.factorKey !== undefined)
    && (v.territoryKeys === undefined || (v.territoryCount === v.territoryKeys.length &&
      new Set(v.territoryKeys).size === v.territoryKeys.length))
    && (v.myVote === null || v.myVoteRevision > 0)
    && (v.myVote !== 1 || v.support > 0) && (v.myVote !== -1 || v.oppose > 0));
function updates<T extends z.ZodType<{ id: string; status: string }>>(noteSchema: T) {
  return z.strictObject({
    sessionId: uuid, cursor: count, reset: z.boolean(),
    notes: z.array(noteSchema).max(FLIPCHART_MAX_NOTES), removedIds: z.array(uuid).max(FLIPCHART_MAX_NOTES),
  }).refine((v) => (!v.reset || v.removedIds.length === 0)
    && v.notes.every((n) => n.status === 'active')
    && new Set(v.notes.map((n) => n.id)).size === v.notes.length
    && new Set(v.removedIds).size === v.removedIds.length
    && v.notes.every((n) => !v.removedIds.includes(n.id)));
}
export const flipchartUpdatesSchema = updates(note);
export const flipchartProjectionUpdatesSchema = updates(publicNote);
export const flipchartMutationResultSchema = z.strictObject({ sessionId: uuid, cursor: count, note });
const flipchartFactorMutationResultSchema = flipchartMutationResultSchema.extend({ note: note.nullable() });

const addFields = {
  kind,
  text: z.string().max(4096).transform(normalizeFlipchartText).refine(validText),
};
export const addFlipchartInputSchema = z.union([
  z.strictObject(addFields),
  z.strictObject({ ...addFields, board: z.literal('objective'), factorKey, territoryKey: factorKey.optional() }),
]);
export const selectFlipchartFactorInputSchema = z.strictObject({
  ...addFields, board: z.literal('objective'), factorKey, territoryKey: factorKey, territorySelected: z.boolean(),
});
export const voteFlipchartInputSchema = z.strictObject({ value: vote });
export const statusFlipchartInputSchema = z.strictObject({ status });

export const MAX_OBJECTIVE_COMMENT_LENGTH = 1000;
const objectiveCommentSelection = { factorKey, territoryKey: factorKey };
const objectiveCommentText = z.string().refine((value) => {
  const length = [...value].length;
  return length > 0 && length <= MAX_OBJECTIVE_COMMENT_LENGTH
    && !/[\u0000-\u0008\u000e-\u001f\u007f]/u.test(value);
});
export const objectiveCommentSelectionSchema = z.strictObject(objectiveCommentSelection);
export const saveObjectiveCommentSchema = z.strictObject({
  ...objectiveCommentSelection,
  expectedRevision: count,
  text: objectiveCommentText.nullable(),
});
const objectiveCommentsSchema = z.strictObject({
  sessionId: uuid,
  ...objectiveCommentSelection,
  myRevision: count,
  comments: z.array(z.strictObject({ id: uuid, text: objectiveCommentText, mine: z.boolean() })),
}).refine(({ comments, myRevision }) =>
  new Set(comments.map(({ id }) => id)).size === comments.length
  && comments.filter(({ mine }) => mine).length <= (myRevision > 0 ? 1 : 0));

export type ObjectiveComments = z.infer<typeof objectiveCommentsSchema>;
export const parseObjectiveComments = (value: unknown): ObjectiveComments => parse(objectiveCommentsSchema, value);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Несовместимые данные флипчарта: ${result.error.issues[0]?.path.join('.') || 'ответ'}.`);
  return result.data;
}
export const parseFlipchartUpdates = (value: unknown): FlipchartUpdates => parse(flipchartUpdatesSchema, value);
export const parseFlipchartProjectionUpdates = (value: unknown): FlipchartProjectionUpdates => parse(flipchartProjectionUpdatesSchema, value);
export const parseFlipchartMutationResult = (value: unknown): FlipchartMutationResult => parse(flipchartMutationResultSchema, value);
export const parseFlipchartFactorMutationResult = (value: unknown): FlipchartMutationResult<FlipchartNote | null> =>
  parse(flipchartFactorMutationResultSchema, value);
