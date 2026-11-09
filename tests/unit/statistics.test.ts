import { describe, expect, it, vi } from 'vitest';
import {
  compareSeriesPoints,
  getEffectiveSeries,
  inspectStatisticalBalances,
  parseObservationInput,
  statisticsPointOrigin,
  suggestDerivedPoints,
} from '../../packages/statistics/series';
import { verifyTeamStatisticalSeries } from '../../packages/statistics/integrity';
import { parseTeamStatisticalSeries } from '../../packages/statistics/schema';
import { getStatisticsBindings } from '../../packages/statistics/bindings';
import {
  assessRoadmapReadiness,
  computeRoadmapScenarios,
} from '../../packages/analytics/readiness';
import { computeCanonicalScenario, suggestHistoryWindow } from '../../packages/analytics/scenario';
import { makeRoadmapExportFixture, uuid } from './roadmap-export.fixture';
import {
  makeStatisticsExportFixture,
  makeTeamStatistics,
  statisticsOverride,
} from './statistics.fixture';

describe('participant statistical editions', () => {
  it('parses Russian numeric input without confusing missing data with observed zero', () => {
    expect(parseObservationInput('', 'births_total')).toBeNull();
    expect(parseObservationInput(' \u00a0 ', 'births_total')).toBeNull();
    expect(parseObservationInput('0', 'births_total')).toBe(0);
    expect(parseObservationInput('12 345', 'births_total')).toBe(12345);
    expect(parseObservationInput('12\u00a0345,5', 'pop_mid')).toBe(12345.5);
    expect(parseObservationInput('12\u202f345.123456', 'pop_mid')).toBe(12345.123456);
    expect(parseObservationInput('−125', 'natural_change')).toBe(-125);
    expect(parseObservationInput('-0', 'mig_net_total')).toBe(0);
    for (const input of [
      'NaN',
      'Infinity',
      '1e6',
      '12 34',
      '1,2,3',
      '1.234,5',
      '1 000 000 000 000 001',
    ])
      expect(() => parseObservationInput(input, 'pop_mid'), input).toThrow();
    expect(() => parseObservationInput('5,5', 'births_total')).toThrow('целым');
    expect(() => parseObservationInput('-1', 'pop_mid')).toThrow('отрицательное');
    expect(() => parseObservationInput('0,1234567', 'pop_mid')).toThrow('шести');
  });

  it('distinguishes absent years, explicit nulls, zero and reaffirmed original values with their own provenance', async () => {
    const { base, v1 } = await makeStatisticsExportFixture();
    const rows = compareSeriesPoints(base, v1);
    expect(rows.find((row) => row.year === 2023)).toMatchObject({
      change: 'changed',
      before: { present: true, value: null },
      after: { present: true, value: 0 },
    });
    expect(rows.find((row) => row.year === 2024)).toMatchObject({
      change: 'added',
      before: { present: false },
      after: { present: true, value: null },
    });
    expect(rows.find((row) => row.year === 2019)).toMatchObject({
      change: 'unchanged',
      provenanceChanged: true,
    });
    expect(compareSeriesPoints(v1, base).find((row) => row.year === 2025)?.change).toBe('removed');
  });

  it('preserves year-level attribution across later edits rather than assigning the latest source to all observations', async () => {
    const { v1, v2, base } = await makeStatisticsExportFixture();
    expect(statisticsPointOrigin(v2, 2018)).toMatchObject({
      sourceReference: v1.sourceReference,
      revision: 1,
    });
    expect(statisticsPointOrigin(v2, 2025)).toMatchObject({
      sourceReference: v2.sourceReference,
      revision: 2,
    });
    expect(statisticsPointOrigin(v2, 2015)).toMatchObject({
      kind: 'imported',
      sourceReference: base.sourceUrl,
    });
    expect(
      compareSeriesPoints(v1, v2)
        .filter((point) => point.provenanceChanged)
        .map((point) => point.year),
    ).toEqual([2025]);
  });

  it('selects only the explicit current head and keeps old revisions available solely for pinned records', async () => {
    const { base, v1, v2, version } = await makeStatisticsExportFixture();
    expect(getEffectiveSeries([base], [v2, v1], version.snapshot.statistics)).toEqual([v2]);
    expect(getEffectiveSeries([base], [v2, v1])).toEqual([base]);
    const restore = [
      {
        metricId: base.metricId,
        revision: 3,
        mode: 'imported' as const,
        seriesId: base.id,
        updatedAt: v2.recordedAt,
      },
    ];
    expect(getEffectiveSeries([], [v1, v2], restore)).toEqual([base]);
    expect(() => getEffectiveSeries([base], [v1], version.snapshot.statistics)).toThrow(
      'отсутствует',
    );
    expect(() =>
      getEffectiveSeries([{ ...base, territoryKey: 'other' }], [v2], version.snapshot.statistics),
    ).toThrow('одной территории');
  });

  it('supports a territory without an imported series and restores actual absence, never a phantom zero series', async () => {
    const added = await makeTeamStatistics(null, [statisticsOverride(2025, 0)]);
    const heads = [
      {
        metricId: added.metricId,
        revision: 1,
        mode: 'team' as const,
        seriesId: added.id,
        updatedAt: added.recordedAt,
      },
    ];
    expect(parseTeamStatisticalSeries(added).baseSeries).toBeNull();
    expect(getEffectiveSeries([], [added], heads)).toEqual([added]);
    expect(
      getEffectiveSeries(
        [],
        [added],
        [{ ...heads[0]!, mode: 'imported', seriesId: null, revision: 2 }],
      ),
    ).toEqual([]);
    expect(compareSeriesPoints(null, added)[0]).toMatchObject({
      before: { present: false },
      after: { value: 0, present: true },
    });
  });

  it('reports inconsistent balances and offers a separate preview without changing any source or filling missing operands', async () => {
    const births = await makeTeamStatistics(null, [
      statisticsOverride(2024, 20),
      statisticsOverride(2025, 0),
    ]);
    const deaths = await makeTeamStatistics(
      null,
      [statisticsOverride(2024, 30), statisticsOverride(2025, null)],
      1,
      'deaths_total',
    );
    const balance = await makeTeamStatistics(
      null,
      [statisticsOverride(2024, -5), statisticsOverride(2025, 10)],
      1,
      'natural_change',
    );
    const material = [births, deaths, balance];
    const before = JSON.stringify(material);
    expect(inspectStatisticalBalances(material)).toMatchObject([
      { year: 2024, actualValue: -5, expectedValue: -10, metricId: 'natural_change' },
    ]);
    expect(suggestDerivedPoints(material, 'natural_change')).toMatchObject([
      { year: 2024, value: -10, applicable: true, differs: true },
      { year: 2025, value: null, applicable: false, differs: false },
    ]);
    expect(JSON.stringify(material)).toBe(before);
    const arrivals = await makeTeamStatistics(
      null,
      [statisticsOverride(2025, 0)],
      1,
      'mig_in_total',
    );
    const departures = await makeTeamStatistics(
      null,
      [statisticsOverride(2025, 0)],
      1,
      'mig_out_total',
    );
    const net = await makeTeamStatistics(null, [statisticsOverride(2025, 1)], 1, 'mig_net_total');
    expect(inspectStatisticalBalances([arrivals, departures, net])[0]).toMatchObject({
      actualValue: 1,
      expectedValue: 0,
      metricId: 'mig_net_total',
    });
  });

  it('reproduces the scenario from the saved 2025 edition while new working values do not silently move its base or 2030 goal', async () => {
    const { version, v1, v2, manualScenarioId, manualFactId } = await makeStatisticsExportFixture();
    const result = computeRoadmapScenarios(version.snapshot).find(
      (row) => row.itemId === manualScenarioId,
    )!.result!;
    expect(result.baselineYear).toBe(2025);
    expect(result.baselineObservedValue).toBe(190);
    expect(result.years.find((point) => point.year === 2030)).toMatchObject({
      baselineValue: 190,
      targetValue: 230,
      delta: 40,
    });
    expect(result.warnings.some((issue) => issue.code === 'PARTICIPANT_SUPPLIED_STATISTICS')).toBe(
      true,
    );
    const current = computeCanonicalScenario(v2, result.parameters);
    expect(current.baselineObservedValue).toBe(195);
    expect(current.endGap).toBe(35);
    const stale = assessRoadmapReadiness(version.snapshot).issues.filter(
      (issue) => issue.code === 'STATISTICS_SOURCE_CHANGED',
    );
    expect(stale.map((issue) => issue.entityId)).toEqual(
      expect.arrayContaining([manualScenarioId, manualFactId, uuid(10)]),
    );
    expect(v1.points.at(-1)?.value).toBe(190);
    expect(suggestHistoryWindow(v2.points)).toMatchObject({ startYear: 2025, endYear: 2025 });
  });

  it('marks manual pins stale on full restore, but a historical snapshot still compares only its own heads', async () => {
    const { version, v1, base, manualFactId } = await makeStatisticsExportFixture();
    const originalFrozen = structuredClone(version.snapshot);
    version.snapshot.statistics = [
      {
        metricId: base.metricId,
        revision: 3,
        mode: 'imported',
        seriesId: base.id,
        updatedAt: v1.recordedAt,
      },
    ];
    expect(
      getStatisticsBindings(version.snapshot).find((row) => row.itemId === manualFactId),
    ).toMatchObject({ stale: true, currentSeriesId: base.id });
    expect(
      getStatisticsBindings(version.snapshot).find((row) => row.itemId === uuid(10))?.stale,
    ).toBe(false);
    expect(
      getStatisticsBindings(originalFrozen).find((row) => row.itemId === manualFactId)
        ?.currentSeriesId,
    ).not.toBe(base.id);
    const old = await makeRoadmapExportFixture();
    expect(getStatisticsBindings(old.snapshot)).toEqual([]);
  });

  it('verifies the exact manual canonical bytes and rejects both hash and material substitutions', async () => {
    const { v2 } = await makeStatisticsExportFixture();
    await expect(verifyTeamStatisticalSeries(v2)).resolves.toBeUndefined();
    await expect(
      verifyTeamStatisticalSeries({ ...v2, canonicalJson: v2.canonicalJson + '\n' }),
    ).rejects.toThrow('Контрольная сумма');
    const changed = structuredClone(v2);
    changed.points.at(-1)!.value = 1000;
    await expect(verifyTeamStatisticalSeries(changed)).rejects.toThrow('каноническому');
    expect(() => parseTeamStatisticalSeries({ ...v2, userId: uuid(1) })).toThrow();
  });

  it('keeps the population stock fractional and non-cumulative, without importing misleading fake source fields', async () => {
    const population = await makeTeamStatistics(
      null,
      [statisticsOverride(2025, 12345.123456)],
      1,
      'pop_mid',
    );
    expect(parseTeamStatisticalSeries(population).decimals).toBe(6);
    const result = computeCanonicalScenario(population, {
      metricId: 'pop_mid',
      historyStartYear: 2025,
      historyEndYear: 2025,
      endYear: 2030,
      baselineMethod: 'last_value',
      targetMode: 'absolute_end',
      targetValue: 13000,
    });
    expect(result.baselineObservedValue).toBe(12345.123456);
    expect(result.cumulativeFlowGap).toBeNull();
    expect(result.definition.sourceKind).toBe('team_reported');
    expect('sourceCommit' in population).toBe(false);
    expect(result.warnings.some((issue) => issue.code === 'INCOMPLETE_PRIMARY_PROVENANCE')).toBe(
      false,
    );
  });

  it('keeps a provisional-year warning tied to the observation timestamp even after calendar time or later revision metadata changes', async () => {
    const observations = [
      statisticsOverride(2014, 180),
      statisticsOverride(2025, 190),
      statisticsOverride(2026, 195),
    ];
    const series = await makeTeamStatistics(null, observations);
    const parameters = {
      metricId: 'births_total',
      historyStartYear: 2014,
      historyEndYear: 2026,
      endYear: 2030,
      baselineMethod: 'last_value' as const,
      targetMode: 'absolute_end' as const,
      targetValue: 230,
    };
    const warnings = computeCanonicalScenario(series, parameters).warnings.filter(
      (issue) => issue.code === 'CURRENT_YEAR_OBSERVATION_REQUIRES_REVIEW',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('2026');
    expect(warnings[0]!.message).not.toContain('2014');
    expect(
      computeCanonicalScenario(series, { ...parameters, historyEndYear: 2025 }).warnings.some(
        (issue) => issue.code === 'CURRENT_YEAR_OBSERVATION_REQUIRES_REVIEW',
      ),
    ).toBe(false);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
      expect(
        computeCanonicalScenario(
          { ...series, recordedAt: '2027-06-01T12:00:00Z' },
          parameters,
        ).warnings.filter((issue) => issue.code === 'CURRENT_YEAR_OBSERVATION_REQUIRES_REVIEW'),
      ).toEqual(warnings);
    } finally {
      vi.useRealTimers();
    }
  });
});
