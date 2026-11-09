import { sha256Hex } from '../../../../packages/security/crypto.mjs';
import {
  parseRoadmapsIndex,
  parseRoadmapSnapshot,
  parseRoadmapVersion,
  parseRoadmapsProjection,
  configureRoadmapsInputSchema,
  joinRoadmapInputSchema,
  saveRoadmapItemInputSchema,
  captureRoadmapBasisInputSchema,
  captureRoadmapFactInputSchema,
  freezeRoadmapInputSchema,
  reviewRoadmapInputSchema,
} from '../../../../packages/roadmaps/schema';
import type {
  ConfigureRoadmapsInput,
  JoinRoadmapInput,
  SaveRoadmapItemInput,
  CaptureRoadmapBasisInput,
  CaptureRoadmapFactInput,
  FreezeRoadmapInput,
  ReviewRoadmapInput,
  RoadmapSeries,
} from '../../../../packages/roadmaps/types';
import type { SessionApi } from './session-api';
import {
  saveStatisticsInputSchema,
  restoreStatisticsInputSchema,
  getStatisticsHistoryInputSchema,
  getStatisticsSeriesInputSchema,
  parseStatisticsHistory,
  parseStatisticsSeriesPayload,
} from '../../../../packages/statistics/schema';
import type {
  SaveStatisticsInput,
  RestoreStatisticsInput,
  GetStatisticsHistoryInput,
  GetStatisticsSeriesInput,
} from '../../../../packages/statistics/types';
import { verifyTeamStatisticalSeries } from '../../../../packages/statistics/integrity';

/** Account-bound transport. The public questionnaire never imports this module. */
export class RoadmapsApi {
  constructor(readonly transport: SessionApi) {}
  private match<T extends { sessionId: string }>(sessionId: string, value: T): T {
    if (value.sessionId !== sessionId)
      throw new Error('Дорожная карта относится к другому занятию.');
    return value;
  }
  private async verifySeries(series: readonly RoadmapSeries[]) {
    await Promise.all(
      series.map((item) =>
        item.sourceKind === 'team_reported' ? verifyTeamStatisticalSeries(item) : Promise.resolve(),
      ),
    );
  }
  cursor(sessionId: string) {
    return this.transport.rpc('dw_roadmaps_cursor', { p_session_id: sessionId }, (value) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new Error('Некорректная ревизия территориальных команд.');
      return value;
    });
  }
  index(sessionId: string) {
    return this.transport.rpc('dw_roadmaps_index', { p_session_id: sessionId }, (v) =>
      this.match(sessionId, parseRoadmapsIndex(v)),
    );
  }
  async snapshot(sessionId: string, roadmapId: string) {
    const next = await this.transport.rpc(
      'dw_roadmap_snapshot',
      { p_session_id: sessionId, p_roadmap_id: roadmapId },
      (v) => {
        const result = this.match(sessionId, parseRoadmapSnapshot(v));
        if (result.roadmapId !== roadmapId) throw new Error('Получена другая дорожная карта.');
        return result;
      },
    );
    await this.verifySeries(next.series);
    return next;
  }
  async projection(sessionId: string, roadmapId: string | null) {
    const next = await this.transport.rpc(
      'dw_roadmaps_projector_snapshot',
      { p_session_id: sessionId, p_roadmap_id: roadmapId },
      (v) => {
        const result = this.match(sessionId, parseRoadmapsProjection(v));
        if ((result.selected?.roadmapId ?? null) !== roadmapId)
          throw new Error('Проекция относится к другой дорожной карте.');
        return result;
      },
    );
    await this.verifySeries(next.selected?.series ?? []);
    return next;
  }
  configure(sessionId: string, input: ConfigureRoadmapsInput) {
    return this.transport.mutate(
      'dw_configure_roadmaps',
      { p_session_id: sessionId, p_input: configureRoadmapsInputSchema.parse(input) },
      (v) => this.match(sessionId, parseRoadmapsIndex(v)),
    );
  }
  private async mutate(
    sessionId: string,
    name: string,
    input: { roadmapId?: string; territoryKey?: string },
  ) {
    const next = await this.transport.mutate(
      name,
      { p_session_id: sessionId, p_input: input },
      (v) => {
        const result = this.match(sessionId, parseRoadmapSnapshot(v));
        if (input.roadmapId !== undefined && result.roadmapId !== input.roadmapId)
          throw new Error('Результат сохранения относится к другой дорожной карте.');
        if (input.territoryKey !== undefined && result.territory.key !== input.territoryKey)
          throw new Error('Команда создана для другой территории.');
        return result;
      },
    );
    await this.verifySeries(next.series);
    return next;
  }
  join(sessionId: string, input: JoinRoadmapInput) {
    return this.mutate(sessionId, 'dw_join_roadmap', joinRoadmapInputSchema.parse(input));
  }
  saveItem(sessionId: string, input: SaveRoadmapItemInput) {
    return this.mutate(sessionId, 'dw_save_roadmap_item', saveRoadmapItemInputSchema.parse(input));
  }
  captureBasis(sessionId: string, input: CaptureRoadmapBasisInput) {
    return this.mutate(
      sessionId,
      'dw_capture_roadmap_basis',
      captureRoadmapBasisInputSchema.parse(input),
    );
  }
  captureFact(sessionId: string, input: CaptureRoadmapFactInput) {
    return this.mutate(
      sessionId,
      'dw_capture_roadmap_fact',
      captureRoadmapFactInputSchema.parse(input),
    );
  }
  saveStatistics(sessionId: string, input: SaveStatisticsInput) {
    return this.mutate(
      sessionId,
      'dw_roadmap_statistics_save',
      saveStatisticsInputSchema.parse(input),
    );
  }
  restoreStatistics(sessionId: string, input: RestoreStatisticsInput) {
    return this.mutate(
      sessionId,
      'dw_roadmap_statistics_restore',
      restoreStatisticsInputSchema.parse(input),
    );
  }
  statisticsHistory(sessionId: string, input: GetStatisticsHistoryInput) {
    return this.transport.rpc(
      'dw_roadmap_statistics_history',
      {
        p_session_id: sessionId,
        p_input: getStatisticsHistoryInputSchema.parse(input),
      },
      (v) => {
        const result = parseStatisticsHistory(v);
        if (result.roadmapId !== input.roadmapId || result.metricId !== input.metricId)
          throw new Error('История статистики относится к другой территории или показателю.');
        if (
          input.beforeRevision !== undefined &&
          result.entries.some((entry) => entry.revision >= input.beforeRevision!)
        )
          throw new Error('Получена другая страница истории статистики.');
        return result;
      },
    );
  }
  async statisticsSeries(sessionId: string, input: GetStatisticsSeriesInput) {
    const result = await this.transport.rpc(
      'dw_roadmap_statistics_series',
      {
        p_session_id: sessionId,
        p_input: getStatisticsSeriesInputSchema.parse(input),
      },
      (v) => this.match(sessionId, parseStatisticsSeriesPayload(v)),
    );
    if (result.roadmapId !== input.roadmapId || result.series.id !== input.seriesId)
      throw new Error('Получена другая статистическая редакция.');
    await verifyTeamStatisticalSeries(result.series);
    return result;
  }
  freeze(sessionId: string, input: FreezeRoadmapInput) {
    return this.mutate(sessionId, 'dw_freeze_roadmap', freezeRoadmapInputSchema.parse(input));
  }
  review(sessionId: string, input: ReviewRoadmapInput) {
    return this.mutate(sessionId, 'dw_review_roadmap', reviewRoadmapInputSchema.parse(input));
  }
  async version(sessionId: string, roadmapId: string, versionId: string) {
    const result = await this.transport.rpc(
      'dw_roadmap_version',
      { p_session_id: sessionId, p_roadmap_id: roadmapId, p_version_id: versionId },
      (v) => this.match(sessionId, parseRoadmapVersion(v)),
    );
    if (result.roadmapId !== roadmapId || result.id !== versionId)
      throw new Error('Получена другая редакция дорожной карты.');
    const bytes = new TextEncoder().encode(result.canonicalJson);
    const digest = await sha256Hex(bytes);
    if (digest !== result.sha256)
      throw new Error('Контрольная сумма редакции не совпала. Выгрузка остановлена.');
    return result;
  }
}
