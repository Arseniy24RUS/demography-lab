import { parseWorkshopSnapshot, parseWorkshopProjection, parseVotingRound } from '../../../../packages/workshop/schema';
import type { CastVoteInput, FrozenVariant, OpenRoundInput, RegionWorkInput, SaveFamilyInput, VotingRound, WorkshopProjection, WorkshopSnapshot } from '../../../../packages/workshop/types';
import type { SessionApi } from './session-api';
import { parseWorkspaceVotes, parseWorkspaceVotesProjection, type WorkspaceVoteInput, type WorkspaceVotesProjection } from '../../../../packages/workshop/live-votes';

/** Reuses the authenticated Stage 2 client; never creates a second Auth session. */
export class WorkshopApi {
  private materials = new Map<string, Map<string, FrozenVariant[]>>();
  private knownRound = new Map<string, string>();
  constructor(readonly transport: SessionApi) {}
  private parseLive<T extends WorkspaceVotesProjection>(id: string, value: unknown, parse: (value: unknown) => T): T {
    const result = parse(value);
    if (result.sessionId !== id) throw new Error('Ответ голосования относится к другой мастерской.');
    return result;
  }
  liveVotes(id: string) {
    return this.transport.rpc('dw_workspace_votes', { p_session_id: id }, (value) => this.parseLive(id, value, parseWorkspaceVotes));
  }
  liveVotesProjection(id: string) {
    return this.transport.rpc('dw_workspace_votes_projection', { p_session_id: id }, (value) => this.parseLive(id, value, parseWorkspaceVotesProjection));
  }
  voteLive(id: string, input: WorkspaceVoteInput) {
    return this.transport.mutate('dw_workspace_vote', {
      p_session_id: id, p_family_id: input.familyId, p_value: input.value,
      p_expected_revision: input.expectedRevision, p_expected_fingerprint: input.expectedFingerprint,
    }, (value) => this.parseLive(id, value, parseWorkspaceVotes));
  }
  private hint(id: string) {
    const roundId = this.knownRound.get(id);
    return roundId && this.materials.has(roundId) ? roundId : null;
  }
  private remember(round: Pick<VotingRound, 'id' | 'families'> | WorkshopProjection['round']) {
    if (!round) return;
    this.materials.delete(round.id);
    this.materials.set(round.id, new Map(round.families.map((family) => [family.id, family.variants])));
    while (this.materials.size > 3) this.materials.delete(this.materials.keys().next().value!);
  }
  private parseUpdate<T extends WorkshopSnapshot | WorkshopProjection>(sessionId: string, value: unknown, parse: (v: unknown) => T): T {
    let hydrated = value;
    if (value && typeof value === 'object' && 'round' in value && value.round && typeof value.round === 'object' && 'id' in value.round && 'families' in value.round && Array.isArray(value.round.families)) {
      const round = value.round;
      const saved = typeof round.id === 'string' ? this.materials.get(round.id) : undefined;
      const families = value.round.families.map((family: unknown) => {
        if (!family || typeof family !== 'object' || !('variants' in family) || family.variants !== null) return family;
        const variants = 'id' in family && typeof family.id === 'string' ? saved?.get(family.id) : undefined;
        if (!variants) {
          this.knownRound.delete(sessionId);
          throw new Error('Материалы раунда требуют повторной загрузки. Нажмите «Обновить».');
        }
        return { ...family, variants };
      });
      hydrated = { ...value, round: { ...round, families } };
    }
    const result = parse(hydrated);
    if (result.sessionId !== sessionId) throw new Error('Ответ относится к другому занятию.');
    if (result.round) { this.remember(result.round); this.knownRound.set(sessionId, result.round.id); }
    else this.knownRound.delete(sessionId);
    return result;
  }
  snapshot(id: string) { return this.transport.rpc('dw_workshop_updates', { p_session_id: id, p_known_round_id: this.hint(id) }, (value) => this.parseUpdate(id, value, parseWorkshopSnapshot)); }
  projection(id: string) { return this.transport.rpc('dw_workshop_projector_updates', { p_session_id: id, p_known_round_id: this.hint(id) }, (value) => this.parseUpdate(id, value, parseWorkshopProjection)); }
  async round(id: string, roundId: string) {
    const round = await this.transport.rpc('dw_workshop_round_snapshot', { p_session_id: id, p_round_id: roundId }, parseVotingRound);
    if (round.id !== roundId) throw new Error('Сервер вернул другой раунд.');
    this.remember(round); return round;
  }
  cursor(id: string) {
    return this.transport.rpc('dw_workshop_cursor', { p_session_id: id }, (value) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Некорректная ревизия коллективной работы.');
      return value;
    });
  }
  region(id: string, input: RegionWorkInput) {
    return this.transport.mutate('dw_region_work', { p_session_id: id, p_region_id: input.regionId, p_action: input.action, p_expected_revision: input.expectedRevision, p_note: input.note }, parseWorkshopSnapshot);
  }
  saveFamily(id: string, input: SaveFamilyInput) {
    return this.transport.mutate('dw_save_family', { p_session_id: id, p_family_id: input.familyId, p_expected_board_revision: input.expectedBoardRevision, p_title: input.title, p_mechanism: input.mechanism, p_rationale: input.rationale, p_submission_ids: input.submissionIds }, parseWorkshopSnapshot);
  }
  deleteFamily(id: string, familyId: string, revision: number) {
    return this.transport.mutate('dw_delete_family', { p_session_id: id, p_family_id: familyId, p_expected_board_revision: revision }, parseWorkshopSnapshot);
  }
  openRound(id: string, input: OpenRoundInput) {
    return this.transport.mutate('dw_open_voting_round', { p_session_id: id, p_title: input.title, p_results_visibility: input.resultsVisibility, p_expected_board_revision: input.expectedBoardRevision, p_settings: input.settings ?? {} }, (value) => this.parseUpdate(id, value, parseWorkshopSnapshot));
  }
  closeRound(id: string, roundId: string, revision: number) {
    return this.transport.mutate('dw_close_voting_round', { p_session_id: id, p_round_id: roundId, p_expected_revision: revision }, parseWorkshopSnapshot);
  }
  vote(id: string, input: CastVoteInput) {
    return this.transport.mutate('dw_cast_vote_updates', { p_session_id: id, p_round_id: input.roundId, p_family_id: input.familyId, p_value: input.value, p_expected_revision: input.expectedRevision, p_known_round_id: this.hint(id) }, (value) => this.parseUpdate(id, value, parseWorkshopSnapshot));
  }
}
