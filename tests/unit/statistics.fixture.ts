import type { CanonicalMunicipalSeries, MunicipalMetricId } from '../../packages/territories/types';
import type { StatisticsOverride, TeamStatisticalSeries } from '../../packages/statistics/types';
import { STATISTICS_METRIC_LABELS } from '../../packages/statistics/series';
import { sha256Text } from '../../packages/export/model';
import {
  frozenItem,
  makeRoadmapExportFixture,
  resealFixture,
  uuid,
} from './roadmap-export.fixture';

export function statisticsOverride(
  year: number,
  value: number | null,
  revision = 1,
): StatisticsOverride {
  return {
    year,
    value,
    revision,
    sourceReference:
      revision === 1
        ? 'Учебная муниципальная справка А № 17'
        : 'Учебная муниципальная справка Б № 28',
    sourceDate: revision === 1 ? '2026-03-12' : '2026-06-22',
    reason:
      revision === 1
        ? 'Уточнение по полному годовому отчёту. Учебные числа.'
        : 'Добавлена последующая сверка годового отчёта. Учебные числа.',
    updatedAt: revision === 1 ? '2026-03-13T11:00:00.000Z' : '2026-06-23T12:00:00.000Z',
  };
}

export async function makeTeamStatistics(
  baseSeries: CanonicalMunicipalSeries | null,
  overrides: StatisticsOverride[],
  revision = 1,
  metricId: MunicipalMetricId = baseSeries?.metricId ?? 'births_total',
): Promise<TeamStatisticalSeries> {
  const provenance =
    [...overrides].sort((a, b) => b.revision - a.revision)[0] ??
    statisticsOverride(2025, null, revision);
  const points = new Map((baseSeries?.points ?? []).map((point) => [point.year, point.value]));
  overrides.forEach((point) => points.set(point.year, point.value));
  const material: Omit<TeamStatisticalSeries, 'canonicalJson' | 'fingerprint'> = {
    id: `team-statistics:fixture:${metricId}:${revision}`,
    territoryKey: baseSeries?.territoryKey ?? 'example-municipality',
    metricId,
    title: STATISTICS_METRIC_LABELS[metricId],
    unit: 'persons',
    semanticType: metricId === 'pop_mid' ? 'stock' : 'flow',
    valueDomain: ['natural_change', 'mig_net_total'].includes(metricId) ? 'signed' : 'nonnegative',
    aggregation: metricId === 'pop_mid' ? 'none' : 'sum',
    decimals: metricId === 'pop_mid' ? 6 : 0,
    reference: metricId === 'pop_mid' ? 'annual_average' : 'calendar_year',
    sourceEditionId: 'team-statistics-v1',
    sourceKind: 'team_reported',
    provenanceStatus: 'participant_supplied',
    geographyEditionId: baseSeries?.geographyEditionId ?? 'example-geography-v1',
    geographyComparability: 'not_verified',
    comparabilityNote: 'Учебные числа. Сопоставимость территориальных границ требует проверки.',
    baseSeries: structuredClone(baseSeries),
    overrides: structuredClone(overrides).sort((a, b) => a.year - b.year),
    points: [...points].sort(([a], [b]) => a - b).map(([year, value]) => ({ year, value })),
    revision,
    sourceReference: provenance.sourceReference,
    sourceDate: provenance.sourceDate,
    reason: provenance.reason,
    recordedAt: provenance.updatedAt,
  };
  const canonicalJson = JSON.stringify(material);
  return { ...material, canonicalJson, fingerprint: await sha256Text(canonicalJson) };
}

/** A deliberately stale pinned scenario plus two independently attributed manual editions. */
export async function makeStatisticsExportFixture() {
  const version = await makeRoadmapExportFixture();
  const base = version.snapshot.series[0] as CanonicalMunicipalSeries;
  const v1 = await makeTeamStatistics(base, [
    statisticsOverride(2018, 205),
    statisticsOverride(2019, 199),
    statisticsOverride(2023, 0),
    statisticsOverride(2024, null),
    statisticsOverride(2025, 190),
  ]);
  const v2 = await makeTeamStatistics(
    base,
    [...v1.overrides.filter((point) => point.year !== 2025), statisticsOverride(2025, 195, 2)],
    2,
  );
  version.snapshot.schemaVersion = 2;
  version.snapshot.statistics = [
    {
      metricId: 'births_total',
      revision: 2,
      mode: 'team',
      seriesId: v2.id,
      updatedAt: v2.recordedAt,
    },
  ];
  version.snapshot.series.push(v1, v2);
  version.snapshot.items.push(
    frozenItem(110, 'fact', {
      sourceKind: 'team_statistics',
      title: 'Рождения в 2025 году по уточнённым сведениям',
      interpretation: 'Учебный факт закреплён до последующей сверки и требует обсуждения командой.',
      year: 2025,
      value: 190,
      unit: 'persons',
      sourceReference: v1.sourceReference,
      sourceDate: v1.sourceDate,
      seriesId: v1.id,
      seriesFingerprint: v1.fingerprint,
      metricId: v1.metricId,
    }),
    frozenItem(111, 'scenario', {
      title: 'План до 2030 года по редакции участников № 1',
      assumptions: 'Сценарий закреплён до второй сверки исходных данных. Числа учебные.',
      seriesId: v1.id,
      seriesFingerprint: v1.fingerprint,
      parameters: {
        metricId: 'births_total',
        historyStartYear: 2020,
        historyEndYear: 2025,
        endYear: 2030,
        baselineMethod: 'last_value',
        targetMode: 'absolute_end',
        targetValue: 230,
      },
    }),
  );
  await resealFixture(version);
  return { version, base, v1, v2, manualFactId: uuid(110), manualScenarioId: uuid(111) };
}
