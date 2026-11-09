import { z } from 'zod';
import {
  FLIPCHART_MAX_NOTES, FLIPCHART_MAX_TEXT_LENGTH, flipchartKinds, normalizeFlipchartText,
} from './types';
import type {
  FlipchartMutationResult, FlipchartProjectionUpdates, FlipchartUpdates,
} from './types';

const uuid = z.uuid();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = count.min(1);
const timestamp = z.string().min(20).max(40).refine((v) => Number.isFinite(Date.parse(v)));
const kind = z.enum(flipchartKinds);
const status = z.enum(['active', 'withdrawn']);
const vote = z.union([z.literal(-1), z.literal(1), z.null()]);
const validText = (v: string) => [...v].length >= 1 && [...v].length <= FLIPCHART_MAX_TEXT_LENGTH
  && !/[\u0000-\u0008\u000e-\u001f\u007f]/u.test(v);
const canonicalText = z.string().refine((v) => validText(v) && v === normalizeFlipchartText(v));
const publicFields = {
  id: uuid, kind, text: canonicalText, status, createdAt: timestamp, revision,
  support: count, oppose: count, score: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
};
const publicNote = z.strictObject(publicFields).refine((v) => v.score === v.support - v.oppose);
const note = z.strictObject({ ...publicFields, myVote: vote, myVoteRevision: count, canWithdraw: z.boolean() })
  .refine((v) => v.score === v.support - v.oppose
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

export const addFlipchartInputSchema = z.strictObject({
  kind,
  text: z.string().max(4096).transform(normalizeFlipchartText).refine(validText),
});
export const voteFlipchartInputSchema = z.strictObject({ value: vote });
export const statusFlipchartInputSchema = z.strictObject({ status });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Несовместимые данные флипчарта: ${result.error.issues[0]?.path.join('.') || 'ответ'}.`);
  return result.data;
}
export const parseFlipchartUpdates = (value: unknown): FlipchartUpdates => parse(flipchartUpdatesSchema, value);
export const parseFlipchartProjectionUpdates = (value: unknown): FlipchartProjectionUpdates => parse(flipchartProjectionUpdatesSchema, value);
export const parseFlipchartMutationResult = (value: unknown): FlipchartMutationResult => parse(flipchartMutationResultSchema, value);
