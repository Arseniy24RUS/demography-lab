import { describe, expect, it } from 'vitest';
import pack from '../../public/data/cohort/mordovia.json';
import { projectCohorts } from './cohort';
import type { CohortInput } from './cohort';
import { continueHistoricalTrend, historicalTrend } from './historical-trend';

const mordovia = pack.territories.find(item => item.territoryKey === 'region:respublika-mordoviia')!;
const flowNames = ['births', 'deaths', 'arrivals', 'departures'] as const;

describe('age-cohort projections', () => {
  it('advances single ages and keeps survivors in the open oldest group', () => {
    const male = Array<number>(81).fill(0);
    male[0] = 100;
    male[79] = 7;
    male[80] = 10;
    const input: CohortInput = { ...mordovia, base: { male, female: Array<number>(81).fill(0) } };
    const projection = projectCohorts(input, {
      endYear: 2025, fertilityMultiplier: 0, mortalityMultiplier: 0, arrivalsMultiplier: 0, departuresMultiplier: 0,
    });
    const first = projection.points[1]!;
    expect(first.componentYear).toBe(2024);
    expect(first.male[0]).toBe(0);
    expect(first.male[1]).toBe(100);
    expect(first.male[80]).toBe(17);
    expect(first.population).toBe(117);
  });

  it('anchors the first scenario year to the latest observations of each component', () => {
    for (const item of pack.territories) {
      const first = projectCohorts(item, { endYear: 2025 }).points[1]!;
      for (const name of flowNames) {
        const observations = item.history.flatMap(({ year, [name]: value }) =>
          value === null ? [] : [{ year, value }]);
        expect(first[name]).toBeCloseTo(continueHistoricalTrend(historicalTrend(observations), 2024), 6);
      }
    }
  });

  it('reconciles observed base and every intervention year through 2100 for each covered territory', () => {
    expect(pack.territories).toHaveLength(24);
    expect(new Set(pack.territories.map(item => item.territoryKey)).size).toBe(24);
    const municipalStocks = pack.territories.filter(item => item !== mordovia)
      .map(item => projectCohorts(item, { endYear: 2025 }).points[0]!.population);
    expect(projectCohorts(mordovia, { endYear: 2025 }).points[0]?.population).toBe(765891);
    expect(municipalStocks.reduce((total, count) => total + count, 0)).toBe(765891);
    for (const item of pack.territories) {
      const { points } = projectCohorts(item, { endYear: 2100 });
      expect(points).toHaveLength(77);
      expect(points.at(-1)?.year).toBe(2100);
      for (const [index, point] of points.slice(1).entries()) {
        expect(point.population).toBeCloseTo(
          points[index]!.population + point.births! - point.deaths! + point.arrivals! - point.departures!, 6,
        );
        expect([...point.male, ...point.female].every(value => Number.isFinite(value) && value >= 0)).toBe(true);
        expect(point.births).toBeGreaterThan(0);
      }
    }
  });

  it('limits extreme outflow to the available cohort stock', () => {
    const input = { ...mordovia, history: mordovia.history.map(row => ({ ...row, departures: 1e9 })) };
    const first = projectCohorts(input, { endYear: 2025, departuresMultiplier: 3 }).points[1]!;
    expect(first.unrealizedDepartures).toBeGreaterThan(1e9);
    expect([...first.male, ...first.female].every(value => value >= 0)).toBe(true);
  });
});
