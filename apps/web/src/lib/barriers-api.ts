import {
  parseBarrierEvidence,
  parseBarriersProjection,
  parseBarriersSnapshot,
  parseSurveyHostState,
  parseSurveyInvitationState,
  parseWorkshopSurveyEntry,
  parseSurveyResearchExport,
  saveBarrierInputSchema,
  barrierVoteInputSchema,
  saveBarrierLinkInputSchema,
  saveSolutionInputSchema,
  surveyActionInputSchema,
  surveyConfigInputSchema,
} from '../../../../packages/barriers/schema';
import type {
  BarrierEvidence,
  BarrierVoteInput,
  SaveBarrierInput,
  SaveBarrierLinkInput,
  SaveSolutionInput,
  SurveyActionInput,
  SurveyConfigInput,
} from '../../../../packages/barriers/types';
import type { SessionApi } from './session-api';

export class BarriersApi {
  private evidenceCache = new Map<string, BarrierEvidence>();
  constructor(readonly transport: SessionApi) {}
  snapshot(id: string) {
    return this.transport.rpc('dw_barriers_snapshot', { p_session_id: id }, (v) =>
      this.match(id, parseBarriersSnapshot(v)),
    );
  }
  projection(id: string) {
    return this.transport.rpc('dw_barriers_projector_snapshot', { p_session_id: id }, (v) =>
      this.match(id, parseBarriersProjection(v)),
    );
  }
  private match<T extends { sessionId: string }>(id: string, result: T): T {
    if (result.sessionId !== id) throw new Error('Ответ относится к другому занятию.');
    return result;
  }
  cursor(id: string) {
    return this.transport.rpc('dw_barriers_cursor', { p_session_id: id }, (v) => {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
        throw new Error('Некорректная ревизия доски барьеров.');
      return v;
    });
  }
  private mutate(id: string, name: string, input: unknown) {
    return this.transport.mutate(name, { p_session_id: id, p_input: input }, (v) =>
      this.match(id, parseBarriersSnapshot(v)),
    );
  }
  saveBarrier(id: string, input: SaveBarrierInput) {
    return this.mutate(id, 'dw_save_barrier', saveBarrierInputSchema.parse(input));
  }
  vote(id: string, input: BarrierVoteInput) {
    return this.mutate(id, 'dw_barrier_vote', barrierVoteInputSchema.parse(input));
  }
  saveLink(id: string, input: SaveBarrierLinkInput) {
    return this.mutate(id, 'dw_save_barrier_link', saveBarrierLinkInputSchema.parse(input));
  }
  saveSolution(id: string, input: SaveSolutionInput) {
    return this.mutate(id, 'dw_save_solution', saveSolutionInputSchema.parse(input));
  }
  saveSurvey(id: string, input: SurveyConfigInput) {
    return this.mutate(id, 'dw_save_survey', surveyConfigInputSchema.parse(input));
  }
  manageSurvey(id: string, input: SurveyActionInput) {
    return this.mutate(id, 'dw_manage_survey', surveyActionInputSchema.parse(input));
  }
  async readEvidence(id: string, evidenceId: string) {
    // Recheck membership even for immutable cached evidence. Revocation must take effect before reuse.
    await this.cursor(id);
    const key = `${id}:${evidenceId}`,
      cached = this.evidenceCache.get(key);
    if (cached) {
      this.evidenceCache.delete(key);
      this.evidenceCache.set(key, cached);
      return cached;
    }
    const result = await this.transport.rpc(
      'dw_barrier_evidence',
      { p_session_id: id, p_evidence_id: evidenceId },
      parseBarrierEvidence,
    );
    if (result.id !== evidenceId || result.sessionId !== id)
      throw new Error('Основание относится к другой связи или сессии.');
    this.evidenceCache.set(key, result);
    while (this.evidenceCache.size > 8)
      this.evidenceCache.delete(this.evidenceCache.keys().next().value!);
    return result;
  }
  workshopSurvey(id: string) {
    return this.transport.rpc('dw_workshop_survey', { p_session_id: id }, (value) =>
      this.match(id, parseWorkshopSurveyEntry(value)),
    );
  }
  readSurvey(id: string, surveyId: string) {
    return this.transport.rpc(
      'dw_survey_host_state',
      { p_session_id: id, p_survey_id: surveyId },
      (v) => {
        const result = parseSurveyHostState(v);
        if (result.survey.id !== surveyId) throw new Error('Сервер вернул другой опрос.');
        return result;
      },
    );
  }
  invitation(id: string, surveyId: string) {
    return this.transport.rpc(
      'dw_survey_invitation_state',
      { p_session_id: id, p_survey_id: surveyId },
      (v) => {
        const result = parseSurveyInvitationState(v);
        if (result.surveyId !== surveyId)
          throw new Error('Приглашение относится к другому опросу.');
        return result;
      },
    );
  }
  researchExport(id: string, surveyId: string) {
    return this.transport.rpc(
      'dw_survey_research_export',
      { p_session_id: id, p_survey_id: surveyId },
      (v) => {
        const result = parseSurveyResearchExport(v);
        if (result.questionnaire.id !== surveyId)
          throw new Error('Выгрузка относится к другому опросу.');
        return result;
      },
    );
  }
}
