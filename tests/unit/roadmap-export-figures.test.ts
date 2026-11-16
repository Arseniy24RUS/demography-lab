import { describe, expect, it } from 'vitest';
import { projectCohorts } from '../../packages/analytics/cohort';
import { computeScenario } from '../../packages/analytics/scenario';
import {
  cohortFigure,
  figureSvg,
  scenarioFigure,
  statisticalFigure,
} from '../../packages/export/figures';
import pack from '../../public/data/cohort/mordovia.json';

describe('statistical figures in saved roadmap exports', () => {
  it('keeps an observed zero and breaks the line across missing observations', () => {
    const figure = statisticalFigure('history', 'Миграционное сальдо', 'persons', [
      { year: 2019, value: -3 },
      { year: 2020, value: null },
      { year: 2021, value: 0 },
      { year: 2022, value: 2 },
    ])!;
    const markers = figure.primitives.filter((item) => item.kind === 'circle' && item.y < 350);
    const plottedSegments = figure.primitives.filter(
      (item) =>
        item.kind === 'line' &&
        item.y1 < 350 &&
        item.y2 < 350 &&
        item.x1 !== item.x2 &&
        item.y1 !== item.y2,
    );
    expect(markers).toHaveLength(3);
    expect(plottedSegments).toHaveLength(1);
    expect(figureSvg(figure)).toContain('человек');
    expect(
      statisticalFigure('single', 'Миграционное сальдо', 'persons', [{ year: 2020, value: 0 }]),
    ).toBeNull();
  });

  it('retains readable unique labels for a narrow trend', () => {
    const figure = statisticalFigure('narrow', 'Численность', 'persons', [
      { year: 2020, value: 28501 },
      { year: 2021, value: 28502 },
      { year: 2022, value: 28501.1 },
    ])!;
    const axisLabels = figure.primitives.flatMap((item) =>
      item.kind === 'text' && item.align === 'end' ? [item.text] : [],
    );
    expect(new Set(axisLabels).size).toBe(axisLabels.length);
    expect(axisLabels.length).toBeGreaterThanOrEqual(3);
    expect(axisLabels).not.toContain('0');
  });

  it('plots pinned observations after a scenario cutoff as actual markers distinct from the projections', () => {
    const series = [95, 97, 99, 101, 103, 110, 114].map((value, index) => ({
      year: 2018 + index,
      value,
    }));
    const result = computeScenario({
      definition: {
        id: 'births_total',
        label: 'Родившиеся',
        definition: 'Рождения за год',
        unit: 'persons',
        kind: 'flow',
        reference: 'calendar_year',
        signed: false,
        sourceField: 'births_total',
        sourceKind: 'source_reported',
      },
      series,
      parameters: {
        metricId: 'births_total',
        historyStartYear: 2018,
        historyEndYear: 2022,
        endYear: 2026,
        baselineMethod: 'historical_continuation',
        targetMode: 'absolute_end',
        targetValue: 130,
      },
    });
    const figure = scenarioFigure('scenario', 'Родившиеся', result, series);
    const boundary = figure.primitives.find(
      (item) => item.kind === 'line' && item.x1 === item.x2 && item.dash,
    );
    expect(boundary?.kind).toBe('line');
    if (!boundary || boundary.kind !== 'line') throw new Error('Missing scenario boundary');
    const postCutoffMarkers = figure.primitives.filter(
      (item) => item.kind === 'circle' && item.y < 350 && item.x > boundary.x1,
    );
    expect(postCutoffMarkers).toHaveLength(2);
    expect(figure.altText).toContain('Опорный год 2022');
    expect(figureSvg(figure)).toContain('Базовая траектория');
    expect(figureSvg(figure)).toContain('Целевая траектория');
  });

  it('plots only the supplied cohort scenarios and does not mark the forecast period as observed', () => {
    const input = pack.territories.find((item) => item.territoryKey === 'rudn-mun-72196-904')!;
    expect(input.history.find(({ year }) => year === 2011)?.population).toBeNull();
    const baseline = projectCohorts(input, { endYear: 2100 });
    const modified = projectCohorts(input, { endYear: 2100, arrivalsMultiplier: 1.2 });
    expect(modified.points.at(-1)!.population).toBeGreaterThan(baseline.points.at(-1)!.population);
    const single = cohortFigure(input, baseline);
    const figure = cohortFigure(input, baseline, modified);
    expect(figure.kind).toBe('cohort');
    expect(figureSvg(single)).not.toContain('Сценарий участников');
    const svg = figureSvg(figure);
    expect(svg).toContain('Сценарий участников');
    expect(svg).toContain('человек на 1 января');
    expect(svg).toContain('2100');
    expect(figure.primitives.some((item) => item.kind === 'line' && (item.dashPhase ?? 0) > 0)).toBe(true);
    expect(svg).toContain('stroke-dashoffset="');
    const boundary = figure.primitives.find(
      (item) => item.kind === 'line' && item.x1 === item.x2 && item.dash,
    );
    if (!boundary || boundary.kind !== 'line') throw new Error('Missing cohort boundary');
    expect(
      figure.primitives.some(
        (item) => item.kind === 'circle' && item.y < 350 && item.x > boundary.x1,
      ),
    ).toBe(false);
  });
});
