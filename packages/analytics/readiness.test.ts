import { describe, expect, it } from 'vitest';
import type {
  FrozenRoadmapItem,
  RoadmapBasis,
  RoadmapDataMap,
  RoadmapItemKind,
} from '../roadmaps/types';
import type { CanonicalMunicipalSeries } from '../territories/types';
import {
  activeRoadmapItems,
  assessRoadmapReadiness,
  computeRoadmapBudget,
  computeRoadmapScenarios,
} from './readiness';
import type { RoadmapForAnalysis } from './readiness';

function item<K extends RoadmapItemKind>(
  id: string,
  kind: K,
  data: RoadmapDataMap[K],
): FrozenRoadmapItem<K> {
  return { id, kind, data, status: 'active', revision: 1 } as FrozenRoadmapItem<K>;
}
function empty(): RoadmapForAnalysis {
  return {
    territory: {
      key: 'test-territory',
      name: 'Учебный муниципалитет',
      level: 'municipality',
      regionId: '13',
      sourceEditionId: 'geo',
      sourceCode: null,
      sourceType: 'source',
      geographicStatus: 'historical_source_snapshot',
      sourceUrl: 'https://example.test/source',
      boundaryVersion: 'geo-1',
    },
    items: [],
    basis: [],
    series: [],
    budget: {
      needCashKopecks: 0,
      inKindKopecks: 0,
      confirmedKopecks: 0,
      expectedKopecks: 0,
      confirmedGapKopecks: 0,
      remainingAfterExpectedKopecks: 0,
      years: [],
    },
  };
}
function complete(): RoadmapForAnalysis {
  const roadmap = empty();
  roadmap.items = [
    item('passport', 'passport', {
      title: 'Присмотр за детьми в удобное время',
      targetGroup: 'Семьи с детьми до трёх лет',
      partners: 'Учреждение социальной сферы',
      goal: 'Открыть доступ к дополнительным часам присмотра',
      objectives: [{ id: 'objective', title: 'Организовать услугу' }],
      startDate: '2027-01-01',
      endDate: '2027-12-31',
      expectedResult: 'Сокращение неудовлетворённых запросов',
      defenseDate: null,
      humanResources: 'Два специалиста',
      materialResources: 'Помещение учреждения',
      informationResources: 'Сайт и обращения семей',
    }),
    item('diagnosis', 'diagnosis', {
      problem: 'Недостаток часов присмотра',
      causeHypothesis: 'Предполагаемое несоответствие расписания потребностям',
      conclusion: 'Проверить потребность и подготовить доступный график',
    }),
    item('fact', 'fact', {
      sourceKind: 'external_unverified',
      title: 'Исходный учёт услуги',
      interpretation: 'Услуга ещё не оказывалась',
      year: 2026,
      value: 0,
      unit: 'часов',
      sourceReference: 'Учебный реестр',
      sourceDate: '2026-11-09',
      seriesId: null,
      seriesFingerprint: null,
      metricId: null,
    }),
    item('indicator', 'indicator', {
      title: 'Предоставленные часы',
      definition: 'Сумма фактически оказанных часов услуги',
      kind: 'output',
      unit: 'часов',
      semanticType: 'flow',
      valueDomain: 'nonnegative',
      numeratorDefinition: '',
      denominatorDefinition: '',
      baselineValue: 0,
      baselineYear: 2026,
      annualTargets: [{ year: 2027, value: 1 }],
      sourceReference: 'Журнал услуги',
      frequency: 'Ежемесячно',
      responsible: 'Координатор',
      limitations: 'Показатель не измеряет эффект на рождаемость',
      scenarioId: null,
    }),
    item('activity', 'activity', {
      title: 'Открытие дополнительного времени услуги',
      description: 'Согласовать график и обеспечить часы присмотра',
      objectiveId: 'objective',
      targetGroup: 'Семьи с детьми',
      scale: 'Один час в учебном примере',
      startDate: '2027-03-01',
      endDate: '2027-10-31',
      responsible: 'Координатор услуги',
      partners: 'Учреждение',
      deliverable: 'Предоставленные часы',
      completionCriterion: 'Запись в журнале оказания услуги',
      authorityLevel: 'municipal',
      legalBasis: 'Проверочное основание',
      approvalStatus: 'verified_source',
      responsibleBody: 'Профильное подразделение',
      necessaryDecision: '',
      indicatorIds: ['indicator'],
      dependencies: [],
      stage: 'implementation',
      stageLabel: '',
      progressStatus: 'planned',
    }),
    item('cost', 'cost', {
      activityId: 'activity',
      year: 2027,
      title: 'Час присмотра',
      unit: 'час',
      quantity: '1',
      unitPriceKopecks: 100,
      periods: 1,
      cashKind: 'cash',
      priceStatus: 'estimated',
      priceSource: 'Учебная цена',
      priceDate: null,
    }),
    item('funding', 'funding', {
      costLineId: 'cost',
      sourceName: 'Учебный источник',
      sourceKind: 'municipal_budget',
      amountKopecks: 100,
      status: 'confirmed',
      sourceReference: 'Учебный финансовый документ',
      sourceDate: '2026-11-09',
      originReference: '',
    }),
    item('risk', 'risk', {
      title: 'Недостаток специалиста',
      mitigation: 'Подготовить замену',
      owner: 'Координатор',
      trigger: 'Отсутствие специалиста в графике',
      contingency: 'Перенести услугу по согласованию с семьями',
    }),
    item('monitoring', 'monitoring', {
      frequency: 'Ежемесячно',
      method: 'Журнал предоставленных услуг',
      responsible: 'Координатор',
      interimReportDate: '2027-06-30',
      finalReportDate: '2027-12-31',
      qualitativeResults: 'Удобство времени услуги для семей',
      sustainability: 'Включить услугу в постоянное расписание',
    }),
  ];
  return roadmap;
}

describe('roadmap completeness and frozen analytical adapters', () => {
  it('reports zero completeness for an empty draft and names all eight template sections', () => {
    const result = assessRoadmapReadiness(empty());
    expect(result.percentComplete).toBe(0);
    expect(result.completedChecks).toBe(0);
    expect(result.sections.map((section) => section.id)).toEqual([
      'passport',
      'diagnosis',
      'indicators',
      'activities',
      'calendar',
      'resources',
      'risks',
      'monitoring',
    ]);
  });

  it('accepts a zero baseline and exposes remaining provenance warnings even at complete template coverage', () => {
    const result = assessRoadmapReadiness(complete());
    expect(result.percentComplete).toBe(100);
    expect(result.completedSections).toBe(8);
    expect(result.totalChecks).toBe(31);
    expect(result.interpretation).toBe('document_completeness_not_scientific_quality');
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['EXTERNAL_FACT_NOT_VERIFIED', 'ESTIMATED_PRICE']),
    );
  });

  it('excludes archived content and detects lost objective or indicator links', () => {
    const roadmap = complete();
    activeRoadmapItems(roadmap, 'indicator')[0]!.status = 'archived';
    activeRoadmapItems(roadmap, 'activity')[0]!.data.objectiveId = 'missing-objective';
    const result = assessRoadmapReadiness(roadmap);
    expect(result.sections.find((section) => section.id === 'indicators')?.complete).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('ACTIVITY_INDICATOR_LINK_MISSING');
    expect(
      result.sections
        .find((section) => section.id === 'activities')
        ?.checks.find((check) => check.id === 'activity-objectives')?.complete,
    ).toBe(false);
  });

  it('keeps legal approval, confirmed financing and unknown denominators visible', () => {
    const roadmap = complete();
    activeRoadmapItems(roadmap, 'activity')[0]!.data.approvalStatus = 'requires_decision';
    activeRoadmapItems(roadmap, 'funding')[0]!.data.status = 'application';
    activeRoadmapItems(roadmap, 'indicator')[0]!.data.semanticType = 'share';
    const result = assessRoadmapReadiness(roadmap);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['AUTHORITY_REQUIRES_REVIEW', 'CONFIRMED_FUNDING_GAP']),
    );
    expect(result.sections.find((section) => section.id === 'resources')?.complete).toBe(false);
    expect(
      result.sections
        .find((section) => section.id === 'indicators')
        ?.checks.find((check) => check.id === 'indicator-denominator')?.complete,
    ).toBe(false);
    expect(computeRoadmapBudget(roadmap).totals.confirmedGapKopecks).toBe(100);
  });

  it('flags stale evidence and cross-year budget inconsistencies without destroying a draft', () => {
    const roadmap = complete();
    const basis: RoadmapBasis = {
      id: 'basis',
      sourceKind: 'barrier',
      sourceId: 'source',
      sourceRevision: 1,
      fingerprint: 'abc',
      material: {
        kind: 'barrier',
        source: {
          id: 'source',
          title: 'Барьер',
          description: 'Описание',
          stageIds: ['infancy'],
          evidenceKind: 'hypothesis',
          contentRevision: 1,
          status: 'active',
        },
      },
      rationale: 'Проверочная связь',
      status: 'active',
      revision: 1,
      staleReasons: ['source_changed'],
      createdAt: '2026-11-09',
      updatedAt: '2026-11-09',
    };
    roadmap.basis = [basis];
    activeRoadmapItems(roadmap, 'cost')[0]!.data.year = 2028;
    activeRoadmapItems(roadmap, 'monitoring')[0]!.data.interimReportDate = '2028-01-01';
    const result = assessRoadmapReadiness(roadmap);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['STALE_ROADMAP_BASIS', 'COST_YEAR_OUTSIDE_SCHEDULE']),
    );
    expect(result.sections.find((section) => section.id === 'monitoring')?.complete).toBe(false);
    expect(roadmap.basis[0]?.material).toEqual(basis.material);
  });

  it('recalculates only from the matching frozen canonical series and retains source limitations', () => {
    const roadmap = empty();
    const series: CanonicalMunicipalSeries = {
      id: 'canonical',
      territoryKey: roadmap.territory.key,
      metricId: 'births_total',
      title: 'Родившиеся',
      unit: 'persons',
      semanticType: 'flow',
      valueDomain: 'nonnegative',
      aggregation: 'sum',
      decimals: 0,
      reference: 'calendar_year',
      sourceEditionId: 'source-edition',
      sourceUrl: 'https://example.test/file',
      sourcePath: 'actual.parquet',
      sourceSha256: 'a'.repeat(64),
      sourceCommit: 'b'.repeat(40),
      sourceKind: 'source_reported',
      provenanceStatus: 'incomplete_primary',
      sourceMunicipalityKey: 'source-key',
      geographyEditionId: 'geo',
      geographyComparability: 'not_verified',
      comparabilityNote: 'Исходная гармонизация требует проверки',
      fingerprint: 'c'.repeat(64),
      points: [
        { year: 2022, value: 80 },
        { year: 2023, value: null },
      ],
    };
    roadmap.series = [series];
    roadmap.items = [
      item('scenario', 'scenario', {
        title: 'Учебная цель',
        seriesId: series.id,
        seriesFingerprint: series.fingerprint,
        assumptions: 'Условное сохранение уровня',
        parameters: {
          metricId: 'births_total',
          historyStartYear: 2022,
          historyEndYear: 2023,
          endYear: 2026,
          baselineMethod: 'last_value',
          targetMode: 'relative_end',
          targetValue: 10,
        },
      }),
    ];
    const result = computeRoadmapScenarios(roadmap)[0]!;
    expect(result.error).toBeNull();
    expect(result.result?.years.at(-1)?.targetValue).toBe(88);
    expect(result.result?.source?.editionId).toBe('source-edition');
    expect(result.result?.warnings.map((issue) => issue.code)).toContain(
      'GEOGRAPHY_COMPARABILITY_NOT_VERIFIED',
    );
    const indicator = activeRoadmapItems(complete(), 'indicator')[0]!;
    indicator.data.unit = 'persons';
    indicator.data.baselineYear = 2022;
    indicator.data.baselineValue = 80;
    indicator.data.annualTargets = [{ year: 2026, value: 88 }];
    indicator.data.scenarioId = 'scenario';
    roadmap.items.push(indicator);
    expect(assessRoadmapReadiness(roadmap).issues.map((issue) => issue.code)).not.toContain(
      'TARGETS_DIFFER_FROM_SCENARIO',
    );
    activeRoadmapItems(roadmap, 'scenario')[0]!.data.parameters.targetValue = 20;
    expect(assessRoadmapReadiness(roadmap).issues.map((issue) => issue.code)).toContain(
      'TARGETS_DIFFER_FROM_SCENARIO',
    );
    expect(indicator.data.annualTargets).toEqual([{ year: 2026, value: 88 }]);
    roadmap.series[0]!.fingerprint = 'd'.repeat(64);
    expect(computeRoadmapScenarios(roadmap)[0]?.result).toBeNull();
    expect(assessRoadmapReadiness(roadmap).issues.map((issue) => issue.code)).toContain(
      'SCENARIO_NOT_REPRODUCIBLE',
    );
    expect(result.result?.source?.fingerprint).toBe('c'.repeat(64));
  });
});
