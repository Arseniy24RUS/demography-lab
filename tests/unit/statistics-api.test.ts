import { describe, expect, it } from 'vitest';
import { RoadmapsApi } from '../../apps/web/src/lib/roadmaps-api';
import type { SessionApi } from '../../apps/web/src/lib/session-api';
import type { StatisticsHistory, TeamStatisticalSeries } from '../../packages/statistics/types';
import { sha256Text } from '../../packages/export/model';
import { makeTeamStatistics, statisticsOverride } from './statistics.fixture';
import {
  roomA,
  roomB,
  sessionId,
  userId,
  testUuid,
  runtimeSnapshot,
  runtimeProjection,
  stamp,
} from './roadmaps-runtime.fixture';

function api(response: unknown) {
  const invoke = async (_name: string, _args: unknown, parse: (value: unknown) => unknown) =>
    parse(await response);
  return new RoadmapsApi({ rpc: invoke, mutate: invoke } as unknown as SessionApi);
}
async function team(): Promise<TeamStatisticalSeries> {
  const seed = await makeTeamStatistics(null, [statisticsOverride(2025, 120)]);
  const { canonicalJson: _canonical, fingerprint: _fingerprint, ...material } = seed;
  material.territoryKey = runtimeSnapshot().territory.key;
  material.geographyEditionId = runtimeSnapshot().territory.sourceEditionId;
  const canonicalJson = JSON.stringify(material);
  return { ...material, canonicalJson, fingerprint: await sha256Text(canonicalJson) };
}
async function current(tampered = false) {
  const series = await team();
  if (tampered) series.fingerprint = '0'.repeat(64);
  return {
    ...runtimeSnapshot(),
    series: [series],
    statistics: [
      {
        metricId: series.metricId,
        revision: series.revision,
        mode: 'team' as const,
        seriesId: series.id,
        updatedAt: series.recordedAt,
      },
    ],
  };
}
const saveInput = {
  roadmapId: roomA,
  metricId: 'births_total' as const,
  expectedRevision: 0,
  changes: [{ year: 2025, action: 'set' as const, value: 120 }],
  sourceReference: 'Учебная годовая сводка',
  sourceDate: '2026-10-01',
  reason: 'Учебное уточнение для проверки целостности.',
  comparabilityNote: '',
};
const restoreInput = {
  roadmapId: roomA,
  metricId: 'births_total' as const,
  expectedRevision: 1,
  reason: 'Проверка исходного источника.',
};
const history: StatisticsHistory = {
  roadmapId: roomA,
  metricId: 'births_total',
  currentRevision: 1,
  entries: [
    {
      revision: 1,
      action: 'save',
      seriesId: 'test-series',
      createdAt: stamp,
      createdBy: userId,
      createdByName: 'Участник',
      sourceReference: 'Учебная сводка',
      sourceDate: null,
      reason: 'Проверка источника.',
    },
  ],
  nextBeforeRevision: null,
};

describe('Statistics API response identity and immutable material verification', () => {
  it('accepts all four new RPCs when request identities and statistical bytes agree', async () => {
    const response = await current();
    expect(
      (await api(response).saveStatistics(sessionId, saveInput)).statistics?.[0].seriesId,
    ).toBe(response.series[0].id);
    expect(
      (await api(runtimeSnapshot()).restoreStatistics(sessionId, restoreInput)).roadmapId,
    ).toBe(roomA);
    expect(
      (
        await api(history).statisticsHistory(sessionId, {
          roadmapId: roomA,
          metricId: 'births_total',
        })
      ).entries,
    ).toHaveLength(1);
    expect(
      (
        await api({ sessionId, roadmapId: roomA, series: response.series[0] }).statisticsSeries(
          sessionId,
          { roadmapId: roomA, seriesId: response.series[0].id },
        )
      ).series.fingerprint,
    ).toBe(response.series[0].fingerprint);
  });

  it('rejects wrong-room and wrong-session responses from statistical writes', async () => {
    for (const invoke of [
      (client: RoadmapsApi) => client.saveStatistics(sessionId, saveInput),
      (client: RoadmapsApi) => client.restoreStatistics(sessionId, restoreInput),
    ]) {
      await expect(invoke(api(runtimeSnapshot(roomB)))).rejects.toThrow('другой дорожной карте');
      await expect(invoke(api({ ...runtimeSnapshot(), sessionId: testUuid(99) }))).rejects.toThrow(
        'другому занятию',
      );
    }
  });

  it('binds paged history to the requested room, metric and exclusive revision boundary', async () => {
    const input = { roadmapId: roomA, metricId: 'births_total' as const };
    await expect(
      api({ ...history, roadmapId: roomB }).statisticsHistory(sessionId, input),
    ).rejects.toThrow('другой территории или показателю');
    await expect(
      api({ ...history, metricId: 'deaths_total' }).statisticsHistory(sessionId, input),
    ).rejects.toThrow('другой территории или показателю');
    await expect(
      api(history).statisticsHistory(sessionId, { ...input, beforeRevision: 1 }),
    ).rejects.toThrow('другая страница');
    expect(
      (await api(history).statisticsHistory(sessionId, { ...input, beforeRevision: 2 })).entries[0]
        .revision,
    ).toBe(1);
  });

  it('binds a historical series to its requested session, room and immutable series ID', async () => {
    const series = await team();
    const payload = { sessionId, roadmapId: roomA, series };
    const input = { roadmapId: roomA, seriesId: series.id };
    await expect(
      api({ ...payload, sessionId: testUuid(99) }).statisticsSeries(sessionId, input),
    ).rejects.toThrow('другому занятию');
    await expect(
      api({ ...payload, roadmapId: roomB }).statisticsSeries(sessionId, input),
    ).rejects.toThrow('другая статистическая редакция');
    await expect(
      api(payload).statisticsSeries(sessionId, { ...input, seriesId: 'another-edition' }),
    ).rejects.toThrow('другая статистическая редакция');
  });

  it('rejects coherent JSON with a stale content hash on every statistical material entry path', async () => {
    const response = await current(true);
    const projection = runtimeProjection(roomA);
    projection.selected!.series = response.series;
    projection.selected!.statistics = response.statistics;
    await expect(api(response).snapshot(sessionId, roomA)).rejects.toThrow(
      'Контрольная сумма статистической редакции',
    );
    await expect(api(projection).projection(sessionId, roomA)).rejects.toThrow(
      'Контрольная сумма статистической редакции',
    );
    await expect(api(response).saveStatistics(sessionId, saveInput)).rejects.toThrow(
      'Контрольная сумма статистической редакции',
    );
    await expect(api(response).restoreStatistics(sessionId, restoreInput)).rejects.toThrow(
      'Контрольная сумма статистической редакции',
    );
    await expect(
      api({ sessionId, roadmapId: roomA, series: response.series[0] }).statisticsSeries(sessionId, {
        roadmapId: roomA,
        seriesId: response.series[0].id,
      }),
    ).rejects.toThrow('Контрольная сумма статистической редакции');
  });

  it('rejects changed numbers even when an attacker supplies a different canonical text', async () => {
    const series = await team();
    series.points[0].value = 999;
    series.overrides[0].value = 999;
    const { canonicalJson: _canonical, fingerprint: _fingerprint, ...material } = series;
    series.canonicalJson = JSON.stringify(material);
    await expect(
      api({ sessionId, roadmapId: roomA, series }).statisticsSeries(sessionId, {
        roadmapId: roomA,
        seriesId: series.id,
      }),
    ).rejects.toThrow('Контрольная сумма статистической редакции');
  });
});
