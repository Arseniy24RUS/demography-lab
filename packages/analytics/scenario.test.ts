import { describe, expect, it } from 'vitest';
import { computeScenario, pointsFromStatisticsPack, suggestHistoryWindow } from './scenario';
import type { RegionStatisticsPack } from '../territories/types';
import type { ScenarioInput, ScenarioMetricDefinition, ScenarioParameters } from './types';

const births: ScenarioMetricDefinition = {
  id: 'births_total',
  label: 'Родившиеся',
  definition: 'Число рождений за календарный год',
  unit: 'persons',
  kind: 'flow',
  reference: 'calendar_year',
  signed: false,
  sourceField: 'births_total',
  sourceKind: 'source_reported',
};
function params(overrides: Partial<ScenarioParameters> = {}): ScenarioParameters {
  return {
    metricId: births.id,
    historyStartYear: 2018,
    historyEndYear: 2022,
    endYear: 2026,
    baselineMethod: 'last_value',
    targetMode: 'relative_end',
    targetValue: 10,
    ...overrides,
  };
}
function input(overrides: Partial<ScenarioInput> = {}): ScenarioInput {
  return {
    definition: births,
    series: [2018, 2019, 2020, 2021, 2022].map((year) => ({ year, value: 80 })),
    parameters: params(),
    ...overrides,
  };
}

describe('transparent baseline and target trajectories', () => {
  it('distinguishes a final 10 percent difference from annual 10 percent growth', () => {
    const relative = computeScenario(input());
    const annual = computeScenario(input({ parameters: params({ targetMode: 'annual_growth' }) }));
    expect(relative.years.at(-1)?.targetValue).toBeCloseTo(88, 10);
    expect(annual.years.at(-1)?.targetValue).toBeCloseTo(117.128, 10);
    expect(annual.years.at(-1)?.plannedTargetValue).toBe(117);
    expect(relative.interpretation).toBe('planning_gap_not_causal_effect');
  });

  it('uses the observed starting level for annual growth while a final relative target uses the declining baseline', () => {
    const series = [120, 115, 110, 105, 100].map((value, i) => ({ year: 2018 + i, value }));
    const relative = computeScenario(
      input({ series, parameters: params({ baselineMethod: 'linear' }) }),
    );
    const annual = computeScenario(
      input({
        series,
        parameters: params({ baselineMethod: 'linear', targetMode: 'annual_growth' }),
      }),
    );
    expect(relative.years.at(-1)?.baselineValue).toBe(80);
    expect(relative.years.at(-1)?.targetValue).toBe(88);
    expect(annual.years.at(-1)?.targetValue).toBeCloseTo(146.41, 10);
  });

  it('uses the last available year for this metric without replacing missing values by zero', () => {
    const result = computeScenario(
      input({
        series: [...input().series, { year: 2023, value: null }],
        parameters: params({ historyEndYear: 2023 }),
      }),
    );
    expect(result.baselineYear).toBe(2022);
    expect(result.history.at(-1)).toEqual({ year: 2023, value: null });
    expect(result.years.find((year) => year.year === 2023)?.observedValue).toBeNull();
    expect(result.warnings.map((warning) => warning.code)).toContain('LAST_AVAILABLE_YEAR_USED');
    expect(result.horizonYears).toBe(4);
  });

  it('preserves a genuine zero observation and refuses an undefined relative target', () => {
    const zero = [{ year: 2022, value: 0 }];
    expect(
      computeScenario(
        input({
          series: zero,
          parameters: params({ targetMode: 'absolute_end', targetValue: 10 }),
        }),
      ).baselineObservedValue,
    ).toBe(0);
    expect(() => computeScenario(input({ series: zero }))).toThrow(/положительной базы/u);
    expect(() => computeScenario(input({ series: [{ year: 2022, value: null }] }))).toThrow(
      /отсутствуют/u,
    );
  });

  it('requires five continuous years for a trend and provides an explicit last-level fallback', () => {
    const sparse = [
      { year: 2010, value: 100 },
      ...[2013, 2014, 2015, 2016].map((year) => ({ year, value: 80 })),
    ];
    expect(() =>
      computeScenario(
        input({
          series: sparse,
          parameters: params({
            historyStartYear: 2010,
            historyEndYear: 2016,
            endYear: 2020,
            baselineMethod: 'linear',
          }),
        }),
      ),
    ).toThrow(/пяти последовательных/u);
    expect(
      computeScenario(
        input({
          series: sparse,
          parameters: params({ historyStartYear: 2010, historyEndYear: 2016, endYear: 2020 }),
        }),
      ).baselineYear,
    ).toBe(2016);
    expect(() =>
      computeScenario(
        input({
          series: input().series.slice(1),
          parameters: params({ baselineMethod: 'linear' }),
        }),
      ),
    ).toThrow(/пяти последовательных/u);
  });

  it('suggests a continuous suffix and keeps the earlier gap available in original data', () => {
    const source = [
      { year: 2010, value: 100 },
      { year: 2011, value: null },
      { year: 2012, value: null },
      ...Array.from({ length: 10 }, (_, i) => ({ year: 2013 + i, value: 90 - i })),
      { year: 2023, value: null },
    ];
    expect(suggestHistoryWindow(source)).toEqual({
      startYear: 2013,
      endYear: 2022,
      availableYears: 10,
      linearAvailable: true,
    });
    expect(source[1]?.value).toBeNull();
    expect(suggestHistoryWindow([{ year: 2023, value: null }])).toBeNull();
  });

  it('uses absolute changes for signed migration and does not invert an improvement', () => {
    const migration = { ...births, id: 'mig_net_total', signed: true };
    const series = [{ year: 2022, value: -80 }];
    const result = computeScenario({
      definition: migration,
      series,
      parameters: params({
        metricId: migration.id,
        targetMode: 'absolute_delta_end',
        targetValue: 8,
      }),
    });
    expect(result.years.at(-1)?.targetValue).toBe(-72);
    expect(() =>
      computeScenario({
        definition: migration,
        series,
        parameters: params({ metricId: migration.id }),
      }),
    ).toThrow(/абсолютное изменение/u);
  });

  it('sums gaps for flows only; population stocks are described by the final-date gap', () => {
    const flow = computeScenario(input());
    const stock = computeScenario(
      input({
        definition: { ...births, id: 'pop_mid', kind: 'stock', reference: 'annual_average' },
        parameters: params({ metricId: 'pop_mid' }),
      }),
    );
    expect(flow.cumulativeFlowGap).toBeCloseTo(20, 10);
    expect(stock.cumulativeFlowGap).toBeNull();
    expect(stock.endGap).toBe(8);
  });

  it('distinguishes percentage points from relative percent and enforces percentage bounds', () => {
    const share: ScenarioMetricDefinition = {
      ...births,
      id: 'coverage',
      kind: 'share',
      unit: '%',
      scale: 'percent',
      integerTargets: false,
    };
    const series = [{ year: 2022, value: 50 }];
    const pp = computeScenario({
      definition: share,
      series,
      parameters: params({ metricId: share.id, targetMode: 'percentage_points' }),
    });
    const relative = computeScenario({
      definition: share,
      series,
      parameters: params({ metricId: share.id }),
    });
    expect(pp.years.at(-1)?.targetValue).toBe(60);
    expect(relative.years.at(-1)?.targetValue).toBeCloseTo(55, 10);
    expect(pp.cumulativeFlowGap).toBeNull();
    expect(() =>
      computeScenario(input({ parameters: params({ targetMode: 'percentage_points' }) })),
    ).toThrow(/только к показателю/u);
    expect(() =>
      computeScenario({
        definition: share,
        series,
        parameters: params({ metricId: share.id, targetMode: 'absolute_end', targetValue: 101 }),
      }),
    ).toThrow(/допустимую область/u);
  });

  it('limits extrapolated counts at zero with an explicit flag while preserving observed values', () => {
    const series = [20, 15, 10, 5, 0].map((value, i) => ({ year: 2018 + i, value }));
    const result = computeScenario(
      input({
        series,
        parameters: params({
          baselineMethod: 'linear',
          targetMode: 'absolute_end',
          targetValue: 0,
        }),
      }),
    );
    expect(result.years.at(-1)?.baselineValue).toBe(0);
    expect(result.years.at(-1)?.baselineClipped).toBe(true);
    expect(result.history.map((point) => point.value)).toEqual([20, 15, 10, 5, 0]);
    expect(result.warnings.map((warning) => warning.code)).toContain('DOMAIN_LIMIT_APPLIED');
  });

  it('evaluates held-out years from a model trained without those years', () => {
    const series = [10, 12, 14, 16, 18, 20, 100, 100].map((value, i) => ({
      year: 2015 + i,
      value,
    }));
    const result = computeScenario(
      input({ series, parameters: params({ historyStartYear: 2015, baselineMethod: 'linear' }) }),
    );
    expect(result.backtest).toEqual({
      heldOutYears: [2021, 2022],
      linearMae: 77,
      lastValueMae: 80,
    });
  });

  it('retains provenance and geographic limitations in the analytical result', () => {
    const result = computeScenario(
      input({
        source: {
          seriesId: 'series',
          fingerprint: 'abc',
          editionId: 'release',
          territoryKey: 'municipality',
          provenanceStatus: 'incomplete_primary',
          geographyComparability: 'not_verified',
        },
      }),
    );
    expect(result.source?.editionId).toBe('release');
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        'INCOMPLETE_PRIMARY_PROVENANCE',
        'GEOGRAPHY_COMPARABILITY_NOT_VERIFIED',
      ]),
    );
  });

  it('rejects contradictory inputs, negative counts, duplicate years, nonfinite values and excessive horizons', () => {
    expect(() => computeScenario(input({ parameters: params({ metricId: 'tfr' }) }))).toThrow(
      /не соответствует/u,
    );
    expect(() => computeScenario(input({ series: [{ year: 2022, value: -1 }] }))).toThrow(
      /Исходное значение/u,
    );
    expect(() =>
      computeScenario(
        input({
          series: [
            { year: 2022, value: 1 },
            { year: 2022, value: 2 },
          ],
        }),
      ),
    ).toThrow(/неоднозначные/u);
    expect(() => computeScenario(input({ series: [{ year: 2022, value: Infinity }] }))).toThrow(
      /конечным/u,
    );
    expect(() => computeScenario(input({ parameters: params({ endYear: 2100 }) }))).toThrow(
      /от 1 до 30/u,
    );
    expect(() =>
      computeScenario(
        input({ parameters: params({ targetMode: 'annual_growth', targetValue: -101 }) }),
      ),
    ).toThrow(/−100%/u);
  });

  it('adapts the exact named metric column and refuses absent or ambiguous municipality matches', () => {
    const pack: RegionStatisticsPack = {
      schemaVersion: 1,
      editionId: 'edition',
      statisticsEditionId: 'statistics',
      geographyEditionId: 'geo',
      regionId: '13',
      sourceId: 'source',
      provenanceStatus: 'incomplete_primary',
      geographyComparability: 'not_verified',
      columns: [
        'year',
        'births_total',
        'deaths_total',
        'pop_mid',
        'mig_in_total',
        'mig_out_total',
        'mig_net_total',
        'natural_change',
      ],
      series: [
        {
          territoryKey: 'mun',
          sourceMunicipalityKey: 'source-mun',
          rows: [
            [2021, 0, 12, 1000, null, null, null, -12],
            [2022, null, null, null, null, null, null, null],
          ],
        },
      ],
    };
    expect(pointsFromStatisticsPack(pack, 'mun', 'births_total')).toEqual([
      { year: 2021, value: 0 },
      { year: 2022, value: null },
    ]);
    expect(pointsFromStatisticsPack(pack, 'mun', 'pop_mid')[0]?.value).toBe(1000);
    expect(() => pointsFromStatisticsPack(pack, 'unknown', 'births_total')).toThrow(/однозначно/u);
    expect(() =>
      pointsFromStatisticsPack(
        { ...pack, series: [...pack.series, ...pack.series] },
        'mun',
        'births_total',
      ),
    ).toThrow(/однозначно/u);
  });
});
