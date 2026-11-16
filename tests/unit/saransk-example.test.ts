import { beforeAll, describe, expect, it } from 'vitest';
import cohortPack from '../../public/data/cohort/mordovia.json';
import { canonicalMunicipalSeriesSchema } from '../../packages/territories/schema';
import { frozenRoadmapItemSchema, roadmapFactDataSchema } from '../../packages/roadmaps/schema';
import type { FrozenRoadmapItem, RoadmapTerritory } from '../../packages/roadmaps/types';
import type { CanonicalMunicipalSeries } from '../../packages/territories/types';
import { assessRoadmapReadiness, computeRoadmapBudget, computeRoadmapScenarios } from '../../packages/analytics/readiness';
import { inspectCalendar } from '../../packages/analytics/calendar';
import { projectCohorts } from '../../packages/analytics/cohort';

interface Example {
  templateVersion: string;
  exampleLabel: string;
  territory: RoadmapTerritory;
  items: FrozenRoadmapItem[];
  series: CanonicalMunicipalSeries[];
  factCaptures: Array<{ localId: string; seriesId: string; expectedSeriesFingerprint: string; year: number; interpretation: string }>;
  cohortParameters: { endYear: number; fertilityMultiplier: number; mortalityMultiplier: number; arrivalsMultiplier: number; departuresMultiplier: number };
}
let example: Example;
let facts: FrozenRoadmapItem<'fact'>[];
beforeAll(async () => {
  const module = await import(/* @vite-ignore */ new URL('../../scripts/maintenance/saransk-example.mjs', import.meta.url).href) as {
    buildSaranskExample(): Promise<Example>;
  };
  example = await module.buildSaranskExample();
  facts = example.factCaptures.map(capture => {
    const source = example.series.find(series => series.id === capture.seriesId)!;
    expect(source.fingerprint).toBe(capture.expectedSeriesFingerprint);
    return { id: capture.localId, kind: 'fact', status: 'active', revision: 1,
      data: roadmapFactDataSchema.parse({ sourceKind: 'registry', title: source.title,
        interpretation: capture.interpretation, year: capture.year,
        value: source.points.find(point => point.year === capture.year)?.value,
        unit: source.unit, sourceReference: source.sourceUrl, sourceDate: null,
        seriesId: source.id, seriesFingerprint: source.fingerprint, metricId: source.metricId }) };
  });
});
const roadmap = () => {
  const budget = computeRoadmapBudget({ items: example.items });
  return { territory: example.territory, items: [...example.items, ...facts], basis: [],
    series: example.series, budget: { ...budget.totals, years: budget.years } };
};

describe('Saransk example as an honest, coherent planning document', () => {
  it('retains the canonical geography and source observations without inventing current facts', () => {
    expect(example.exampleLabel).toBe('ПРИМЕР');
    expect(example.territory).toMatchObject({ key: 'rudn-mun-72196-904', name: 'Городской округ Саранск', level: 'municipality' });
    expect(example.series).toHaveLength(7);
    example.series.forEach(series => canonicalMunicipalSeriesSchema.parse(series));
    const value = (metric: string, year: number) => example.series.find(series => series.metricId === metric)?.points.find(point => point.year === year)?.value;
    expect(value('births_total', 2023)).toBe(2335);
    expect(value('deaths_total', 2023)).toBe(3786);
    expect(value('natural_change', 2023)).toBe(-1451);
    expect(value('mig_net_total', 2023)).toBe(11);
    expect(value('pop_mid', 2024)).toBe(338405);
    expect(value('pop_mid', 2011)).toBe(27766);
    expect(value('births_total', 2024)).toBeNull();
    expect(facts).toHaveLength(7);
    expect(facts.every(fact => fact.data.year! <= 2024)).toBe(true);
    expect(example.items.some(item => item.kind === 'fact')).toBe(false);
  });

  it('validates every section, reference and finish-to-start date without future accomplishments', () => {
    const content = roadmap();
    content.items.forEach(item => frozenRoadmapItemSchema.parse(item));
    expect(new Set(content.items.map(item => item.id)).size).toBe(content.items.length);
    const passport = content.items.find(item => item.kind === 'passport')!;
    if (passport.kind !== 'passport') throw new Error('Missing passport');
    const objectives = new Set(passport.data.objectives.map(objective => objective.id));
    const byId = new Map(content.items.map(item => [item.id, item]));
    const activities = content.items.filter(item => item.kind === 'activity');
    expect(activities).toHaveLength(9);
    for (const item of activities) {
      expect(objectives.has(item.data.objectiveId!)).toBe(true);
      expect(item.data.progressStatus).toBe('planned');
      expect(item.data.approvalStatus).toBe('requires_decision');
      expect(item.data.indicatorIds.every(id => byId.get(id)?.kind === 'indicator')).toBe(true);
      expect(item.data.dependencies.every(link => byId.get(link.predecessorId)?.kind === 'activity')).toBe(true);
    }
    for (const item of content.items) {
      if (item.kind === 'cost') expect(byId.get(item.data.activityId)?.kind).toBe('activity');
      if (item.kind === 'funding') expect(byId.get(item.data.costLineId)?.kind).toBe('cost');
      if (item.kind === 'indicator' && item.data.scenarioId) expect(byId.get(item.data.scenarioId)?.kind).toBe('scenario');
    }
    expect(inspectCalendar(activities.map(item => ({ id: item.id, ...item.data })), {
      startDate: passport.data.startDate!, endDate: passport.data.endDate!,
    }).issues).toEqual([]);
    expect(passport.data.smartChecks).toHaveLength(5);
    for (const key of ['normativeResources', 'managementResources', 'researchResources', 'humanResources',
      'economicResources', 'demographicResources', 'materialResources', 'institutionalResources',
      'informationResources', 'technologyResources'] as const) expect(passport.data[key]?.trim().length).toBeGreaterThan(50);
  });

  it('shows the entire unconfirmed cash gap rather than manufacturing a complete funding status', () => {
    const content = roadmap();
    const result = computeRoadmapBudget(content);
    expect(result.totals).toMatchObject({ needCashKopecks: 722800000, inKindKopecks: 43500000,
      confirmedKopecks: 0, expectedKopecks: 722800000, confirmedGapKopecks: 722800000 });
    expect(content.items.filter(item => item.kind === 'funding').every(item => item.data.status === 'assumption')).toBe(true);
    expect(content.items.filter(item => item.kind === 'cost').every(item => item.data.priceStatus === 'estimated')).toBe(true);
    const readiness = assessRoadmapReadiness(content);
    expect(readiness.sections.flatMap(section => section.checks.filter(check => !check.complete).map(check => check.id)))
      .toEqual(['resources-funding']);
    expect(readiness.issues.filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it('reproduces conditional scenarios, keeps planned indicator targets and supports the neutral cohort model', () => {
    const content = roadmap();
    const scenarios = computeRoadmapScenarios(content);
    expect(scenarios).toHaveLength(2);
    expect(scenarios.every(scenario => !scenario.error && scenario.result?.years.at(-1)?.year === 2029)).toBe(true);
    expect(assessRoadmapReadiness(content).issues.some(issue => issue.code === 'TARGETS_DIFFER_FROM_SCENARIO')).toBe(false);
    for (const item of content.items) {
      if (item.kind !== 'indicator' || !item.data.scenarioId) continue;
      const linked = content.items.find(candidate => candidate.id === item.data.scenarioId);
      if (linked?.kind !== 'scenario') throw new Error('Missing linked scenario');
      const source = content.series.find(series => series.id === linked.data.seriesId)!;
      expect(item.data.semanticType).toBe(source.semanticType);
      expect(item.data.valueDomain).toBe(source.valueDomain);
      // The real room guard accepts these canonical person units; temporal meaning belongs in definitions.
      if (source.unit === 'persons') expect(['persons', 'человек', 'чел.']).toContain(item.data.unit.trim().toLowerCase());
    }
    const input = cohortPack.territories.find(territory => territory.territoryKey === example.territory.key)!;
    expect(example.cohortParameters).toEqual({ endYear: 2029, fertilityMultiplier: 1, mortalityMultiplier: 1, arrivalsMultiplier: 1, departuresMultiplier: 1 });
    const forecast = projectCohorts(input, example.cohortParameters);
    expect(forecast.points[0].year).toBe(2024);
    expect(forecast.points.at(-1)?.year).toBe(2029);
    expect(forecast.points.every(point => Number.isFinite(point.population) && point.population > 0)).toBe(true);
  });
});
