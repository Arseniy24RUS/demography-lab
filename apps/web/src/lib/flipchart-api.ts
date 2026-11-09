import {
  addFlipchartInputSchema,
  parseFlipchartMutationResult,
  parseFlipchartProjectionUpdates,
  parseFlipchartUpdates,
  statusFlipchartInputSchema,
  voteFlipchartInputSchema,
} from '../../../../packages/flipchart/schema';
import type {
  AddFlipchartInput,
  FlipchartNote,
  FlipchartStatus,
  FlipchartVote,
} from '../../../../packages/flipchart/types';
import type { SessionApi } from './session-api';

/** Public phrases and aggregate votes only; authors never enter a board DTO. */
export class FlipchartApi {
  constructor(readonly transport: SessionApi) {}

  private match<T extends { sessionId: string }>(sessionId: string, result: T): T {
    if (result.sessionId !== sessionId) throw new Error('Ответ относится к другой мастерской.');
    return result;
  }

  updates(sessionId: string, afterCursor: number | null) {
    return this.transport.rpc('dw_flipchart_updates', {
      p_session_id: sessionId, p_after_cursor: afterCursor, p_projector: false,
    }, value => this.match(sessionId, parseFlipchartUpdates(value)));
  }

  projection(sessionId: string, afterCursor: number | null) {
    return this.transport.rpc('dw_flipchart_updates', {
      p_session_id: sessionId, p_after_cursor: afterCursor, p_projector: true,
    }, value => this.match(sessionId, parseFlipchartProjectionUpdates(value)));
  }

  private mutate(sessionId: string, method: string, args: Record<string, unknown>) {
    return this.transport.mutate(method, { p_session_id: sessionId, ...args },
      value => this.match(sessionId, parseFlipchartMutationResult(value)));
  }

  add(sessionId: string, input: AddFlipchartInput) {
    return this.mutate(sessionId, 'dw_flipchart_add', { p_input: addFlipchartInputSchema.parse(input) });
  }

  vote(sessionId: string, note: FlipchartNote, value: FlipchartVote) {
    return this.mutate(sessionId, 'dw_flipchart_vote', {
      p_note_id: note.id, p_expected_revision: note.myVoteRevision,
      p_input: voteFlipchartInputSchema.parse({ value }),
    });
  }

  status(sessionId: string, note: FlipchartNote, status: FlipchartStatus) {
    return this.mutate(sessionId, 'dw_flipchart_status', {
      p_note_id: note.id, p_expected_revision: note.revision,
      p_input: statusFlipchartInputSchema.parse({ status }),
    });
  }
}
