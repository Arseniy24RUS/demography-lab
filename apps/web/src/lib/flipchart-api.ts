import {
  addFlipchartInputSchema,
  objectiveCommentSelectionSchema,
  parseFlipchartFactorMutationResult,
  parseFlipchartMutationResult,
  parseFlipchartProjectionUpdates,
  parseFlipchartUpdates,
  parseObjectiveComments,
  saveObjectiveCommentSchema,
  selectFlipchartFactorInputSchema,
  statusFlipchartInputSchema,
  voteFlipchartInputSchema,
} from '../../../../packages/flipchart/schema';
import type {
  AddFlipchartInput,
  FlipchartBoardScope,
  FlipchartFactorSelection,
  FlipchartKind,
  FlipchartMutationResult,
  FlipchartNote,
  FlipchartPublicNote,
  FlipchartStatus,
  FlipchartVote,
} from '../../../../packages/flipchart/types';
import type { SessionApi } from './session-api';

/** Public phrases and aggregate votes only; authors never enter a board DTO. */
export class FlipchartApi {
  constructor(readonly transport: SessionApi, readonly board?: FlipchartBoardScope) {}

  private match<T extends { sessionId: string }>(sessionId: string, result: T): T {
    if (result.sessionId !== sessionId) throw new Error('Ответ относится к другой мастерской.');
    return result;
  }

  private matchBoard(notes: readonly FlipchartPublicNote[]) {
    if (notes.some(note => (note.factorKey !== undefined) !== (this.board === 'objective')))
      throw new Error('Ответ относится к другой доске.');
  }

  private matchDiscussion(sessionId: string, selection: FlipchartFactorSelection, value: unknown) {
    const result = this.match(sessionId, parseObjectiveComments(value));
    if (result.factorKey !== selection.factorKey || result.territoryKey !== selection.territoryKey)
      throw new Error('Ответ относится к другой карточке.');
    return result;
  }

  comments(sessionId: string, selection: FlipchartFactorSelection) {
    const { factorKey, territoryKey } = objectiveCommentSelectionSchema.parse(selection);
    return this.transport.rpc('dw_objective_factor_comments', {
      p_session_id: sessionId, p_factor_key: factorKey, p_territory_key: territoryKey,
    }, value => this.matchDiscussion(sessionId, selection, value));
  }

  saveComment(sessionId: string, selection: FlipchartFactorSelection, expectedRevision: number, text: string | null) {
    const input = saveObjectiveCommentSchema.parse({ ...selection, expectedRevision, text });
    return this.transport.mutate('dw_save_objective_factor_comment', {
      p_session_id: sessionId, p_factor_key: input.factorKey, p_territory_key: input.territoryKey,
      p_expected_revision: input.expectedRevision, p_text: input.text,
    }, value => this.matchDiscussion(sessionId, selection, value));
  }

  private read<T extends { sessionId: string; notes: FlipchartPublicNote[] }>(
    sessionId: string, afterCursor: number | null, projector: boolean, parse: (value: unknown) => T,
  ) {
    return this.transport.rpc('dw_flipchart_updates', {
      p_session_id: sessionId, p_after_cursor: afterCursor, p_projector: projector,
      ...(this.board === 'objective' ? { p_board: 'objective-v2' } : {}),
    }, value => {
      const result = this.match(sessionId, parse(value));
      this.matchBoard(result.notes);
      return result;
    });
  }

  updates(sessionId: string, afterCursor: number | null) {
    return this.read(sessionId, afterCursor, false, parseFlipchartUpdates);
  }

  projection(sessionId: string, afterCursor: number | null) {
    return this.read(sessionId, afterCursor, true, parseFlipchartProjectionUpdates);
  }

  private mutate<TNote extends FlipchartNote | null>(
    sessionId: string, method: string, args: Record<string, unknown>, parse: (value: unknown) => FlipchartMutationResult<TNote>,
  ) {
    return this.transport.mutate(method, { p_session_id: sessionId, ...args }, value => {
      const result = this.match(sessionId, parse(value));
      if (result.note) this.matchBoard([result.note]);
      return result;
    });
  }

  add(sessionId: string, input: AddFlipchartInput) {
    if (input.board !== this.board) throw new Error('Выбран фактор другой доски.');
    return this.mutate(sessionId, 'dw_flipchart_add', { p_input: addFlipchartInputSchema.parse(input) }, parseFlipchartMutationResult);
  }

  selectFactor(sessionId: string, kind: FlipchartKind, text: string, selection: FlipchartFactorSelection, selected: boolean) {
    if (!this.board) throw new Error('Выбран фактор другой доски.');
    const input = selectFlipchartFactorInputSchema.parse({ board: this.board, kind, text, ...selection, territorySelected: selected });
    return this.mutate(sessionId, 'dw_flipchart_add', { p_input: input }, parseFlipchartFactorMutationResult);
  }

  vote(sessionId: string, note: FlipchartNote, value: FlipchartVote) {
    this.matchBoard([note]);
    return this.mutate(sessionId, 'dw_flipchart_vote', {
      p_note_id: note.id, p_expected_revision: note.myVoteRevision,
      p_input: voteFlipchartInputSchema.parse({ value }),
    }, parseFlipchartMutationResult);
  }

  status(sessionId: string, note: FlipchartNote, status: FlipchartStatus) {
    this.matchBoard([note]);
    return this.mutate(sessionId, 'dw_flipchart_status', {
      p_note_id: note.id, p_expected_revision: note.revision,
      p_input: statusFlipchartInputSchema.parse({ status }),
    }, parseFlipchartMutationResult);
  }
}
