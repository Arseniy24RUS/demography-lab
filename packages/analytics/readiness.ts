import type { FrozenRoadmapData, FrozenRoadmapItem, RoadmapItemKind } from '../roadmaps/types';
import { computeBudget } from './budget';
import { inspectCalendar, isCalendarDate } from './calendar';
import { computeCanonicalScenario } from './scenario';
import type { AnalysisIssue, BudgetResult, CalendarResult, ScenarioResult } from './types';
import type { StatisticsHead } from '../statistics/types';
import { inspectStatisticsBindings } from '../statistics/bindings';
import {
  getEffectiveSeries,
  inspectStatisticalBalances,
  provisionalObservationYears,
} from '../statistics/series';

export type RoadmapForAnalysis = Pick<
  FrozenRoadmapData,
  'territory' | 'items' | 'basis' | 'series' | 'budget'
> & { statistics?: StatisticsHead[] };
export interface ReadinessCheck {
  id: string;
  label: string;
  complete: boolean;
}
export interface ReadinessSection {
  id:
    | 'passport'
    | 'diagnosis'
    | 'indicators'
    | 'activities'
    | 'calendar'
    | 'resources'
    | 'risks'
    | 'monitoring';
  title: string;
  complete: boolean;
  checks: ReadinessCheck[];
}
export interface RoadmapReadiness {
  sections: ReadinessSection[];
  completedChecks: number;
  totalChecks: number;
  percentComplete: number;
  completedSections: number;
  issues: AnalysisIssue[];
  interpretation: 'document_completeness_not_scientific_quality';
}
export interface RoadmapScenarioResult {
  itemId: string;
  title: string;
  result: ScenarioResult | null;
  error: string | null;
}

export function activeRoadmapItems<K extends RoadmapItemKind>(
  roadmap: Pick<RoadmapForAnalysis, 'items'>,
  kind: K,
): FrozenRoadmapItem<K>[] {
  return roadmap.items.filter(
    (item) => item.status === 'active' && item.kind === kind,
  ) as FrozenRoadmapItem<K>[];
}

export function computeRoadmapBudget(roadmap: Pick<RoadmapForAnalysis, 'items'>): BudgetResult {
  return computeBudget(
    activeRoadmapItems(roadmap, 'cost').map((item) => ({ id: item.id, ...item.data })),
    activeRoadmapItems(roadmap, 'funding').map((item) => ({ id: item.id, ...item.data })),
  );
}

export function computeRoadmapScenarios(
  roadmap: Pick<RoadmapForAnalysis, 'items' | 'series'>,
): RoadmapScenarioResult[] {
  return activeRoadmapItems(roadmap, 'scenario').map((item) => {
    const series = roadmap.series.find((series) => series.id === item.data.seriesId);
    if (!series || series.fingerprint !== item.data.seriesFingerprint)
      return {
        itemId: item.id,
        title: item.data.title,
        result: null,
        error:
          'Отсутствует закреплённая редакция статистического ряда или не совпадает её отпечаток.',
      };
    try {
      return {
        itemId: item.id,
        title: item.data.title,
        result: computeCanonicalScenario(series, item.data.parameters),
        error: null,
      };
    } catch (error) {
      return {
        itemId: item.id,
        title: item.data.title,
        result: null,
        error: error instanceof Error ? error.message : 'Расчёт не выполнен.',
      };
    }
  });
}

function filled(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
function section(
  id: ReadinessSection['id'],
  title: string,
  checks: ReadinessCheck[],
): ReadinessSection {
  return { id, title, checks, complete: checks.every((check) => check.complete) };
}
function check(id: string, label: string, complete: boolean): ReadinessCheck {
  return { id, label, complete };
}

/** Concrete template coverage only. A 100% result is never a scientific or legal approval. */
export function assessRoadmapReadiness(roadmap: RoadmapForAnalysis): RoadmapReadiness {
  const passport = activeRoadmapItems(roadmap, 'passport')[0]?.data;
  const diagnosis = activeRoadmapItems(roadmap, 'diagnosis')[0]?.data;
  const monitoring = activeRoadmapItems(roadmap, 'monitoring')[0]?.data;
  const activities = activeRoadmapItems(roadmap, 'activity');
  const indicators = activeRoadmapItems(roadmap, 'indicator');
  const risks = activeRoadmapItems(roadmap, 'risk');
  const facts = activeRoadmapItems(roadmap, 'fact');
  const costs = activeRoadmapItems(roadmap, 'cost');
  const bases = roadmap.basis.filter((item) => item.status === 'active');
  const objectiveIds = new Set(
    passport?.objectives
      .filter((objective) => filled(objective.title))
      .map((objective) => objective.id) ?? [],
  );
  const indicatorIds = new Set(indicators.map((item) => item.id));
  const issues: AnalysisIssue[] = [];
  const periodKnown =
    !!passport?.startDate &&
    !!passport.endDate &&
    isCalendarDate(passport.startDate) &&
    isCalendarDate(passport.endDate) &&
    passport.startDate <= passport.endDate;
  let calendar: CalendarResult | null = null;
  if (periodKnown && passport?.startDate && passport.endDate) {
    try {
      calendar = inspectCalendar(
        activities.map((item) => ({ id: item.id, ...item.data })),
        { startDate: passport.startDate, endDate: passport.endDate },
      );
      issues.push(...calendar.issues);
    } catch (error) {
      issues.push({
        code: 'INVALID_CALENDAR',
        severity: 'error',
        message: error instanceof Error ? error.message : 'Календарь не рассчитан.',
      });
    }
  }
  let budget: BudgetResult | null = null;
  try {
    budget = computeRoadmapBudget(roadmap);
    issues.push(...budget.issues);
  } catch (error) {
    issues.push({
      code: 'INVALID_BUDGET',
      severity: 'error',
      message: error instanceof Error ? error.message : 'Смета не рассчитана.',
    });
  }
  for (const basis of bases)
    if (basis.staleReasons.length)
      issues.push({
        code: 'STALE_ROADMAP_BASIS',
        severity: 'warning',
        entityId: basis.id,
        message:
          'Заимствованное основание требует повторного подтверждения после изменения оригинала.',
      });
  for (const fact of facts)
    if (fact.data.sourceKind === 'external_unverified')
      issues.push({
        code: 'EXTERNAL_FACT_NOT_VERIFIED',
        severity: 'warning',
        entityId: fact.id,
        message:
          'Внешний факт введён командой; автоматическая проверка первоисточника отсутствует.',
      });
  issues.push(...inspectStatisticsBindings(roadmap));
  if (roadmap.statistics) {
    const working = getEffectiveSeries([], roadmap.series, roadmap.statistics);
    issues.push(...inspectStatisticalBalances(working));
    for (const series of working) {
      if (series.sourceKind !== 'team_reported') continue;
      if (provisionalObservationYears(series).length)
        issues.push({
          code: 'CURRENT_YEAR_OBSERVATION_REQUIRES_REVIEW',
          severity: 'warning',
          field: series.metricId,
          message: `В рабочем ряду «${series.title}» есть значение за год внесения редакции. Проверьте, что это итог полного календарного года, а не неполный период или прогноз.`,
        });
    }
  }
  for (const activity of activities) {
    if (activity.data.approvalStatus !== 'verified_source')
      issues.push({
        code: 'AUTHORITY_REQUIRES_REVIEW',
        severity: 'warning',
        entityId: activity.id,
        message: 'Уточните полномочия, правовое основание или необходимое решение для мероприятия.',
      });
    if (
      !activity.data.indicatorIds.length ||
      activity.data.indicatorIds.some((id) => !indicatorIds.has(id))
    )
      issues.push({
        code: 'ACTIVITY_INDICATOR_LINK_MISSING',
        severity: 'warning',
        entityId: activity.id,
        message: 'Свяжите мероприятие с действующим показателем результата.',
      });
    if (!filled(activity.data.targetGroup))
      issues.push({
        code: 'ACTIVITY_TARGET_GROUP_MISSING',
        severity: 'warning',
        entityId: activity.id,
        message: 'Уточните адресата мероприятия.',
      });
  }
  if (periodKnown && passport?.startDate && passport.endDate) {
    const startYear = Number(passport.startDate.slice(0, 4)),
      endYear = Number(passport.endDate.slice(0, 4));
    for (const cost of costs) {
      const activity = activities.find((item) => item.id === cost.data.activityId);
      const outsideProject = cost.data.year < startYear || cost.data.year > endYear;
      const outsideActivity =
        !!activity?.data.startDate &&
        !!activity.data.endDate &&
        (cost.data.year < Number(activity.data.startDate.slice(0, 4)) ||
          cost.data.year > Number(activity.data.endDate.slice(0, 4)));
      if (outsideProject || outsideActivity)
        issues.push({
          code: 'COST_YEAR_OUTSIDE_SCHEDULE',
          severity: 'warning',
          entityId: cost.id,
          message:
            'Год расхода выходит за период проекта или связанного мероприятия; проверьте распределение бюджета.',
        });
    }
    for (const indicator of indicators)
      if (
        indicator.data.annualTargets.some(
          (target) => target.year < startYear || target.year > endYear,
        )
      )
        issues.push({
          code: 'TARGET_YEAR_OUTSIDE_PROJECT',
          severity: 'warning',
          entityId: indicator.id,
          message: 'Год целевого значения выходит за период проекта.',
        });
  }
  const calculatedScenarios = computeRoadmapScenarios(roadmap);
  for (const scenario of calculatedScenarios) {
    if (scenario.error)
      issues.push({
        code: 'SCENARIO_NOT_REPRODUCIBLE',
        severity: 'error',
        entityId: scenario.itemId,
        message: scenario.error,
      });
    else if (scenario.result)
      issues.push(
        ...scenario.result.warnings.map((issue) => ({ ...issue, entityId: scenario.itemId })),
      );
  }
  for (const indicator of indicators) {
    if (!indicator.data.scenarioId) continue;
    const scenario = calculatedScenarios.find(
      (row) => row.itemId === indicator.data.scenarioId,
    )?.result;
    if (!scenario) {
      issues.push({
        code: 'INDICATOR_SCENARIO_UNAVAILABLE',
        severity: 'warning',
        entityId: indicator.id,
        message:
          'Связанный сценарий недоступен или не воспроизводится. Сохранённые целевые значения не изменены.',
      });
      continue;
    }
    const baselineDiffers =
      indicator.data.baselineYear !== scenario.baselineYear ||
      indicator.data.baselineValue !== scenario.baselineObservedValue;
    const targetsDiffer = indicator.data.annualTargets.some((target) => {
      const point = scenario.years.find((row) => row.year === target.year);
      return (
        point?.plannedTargetValue === null ||
        point?.plannedTargetValue === undefined ||
        Math.abs(point.plannedTargetValue - target.value) >
          1e-9 * Math.max(1, Math.abs(target.value))
      );
    });
    if (baselineDiffers || targetsDiffer)
      issues.push({
        code: 'TARGETS_DIFFER_FROM_SCENARIO',
        severity: 'warning',
        entityId: indicator.id,
        message:
          'Исходная точка или годовые цели показателя отличаются от связанного сценария. Плановые значения сохранены; обновление требует явного решения команды.',
      });
  }
  const sections: ReadinessSection[] = [
    section('passport', 'Паспорт проекта', [
      check(
        'passport-title',
        'Название и адресат',
        filled(passport?.title) && filled(passport?.targetGroup),
      ),
      check(
        'passport-goal',
        'Конкретная цель и ожидаемый результат',
        filled(passport?.goal) && filled(passport?.expectedResult),
      ),
      check('passport-objectives', 'Сформулированные задачи', objectiveIds.size > 0),
      check('passport-period', 'Период реализации', periodKnown),
      check('passport-partners', 'Партнёры и их участие', filled(passport?.partners)),
    ]),
    section('diagnosis', 'Исходная ситуация и проблема', [
      check(
        'diagnosis-problem',
        'Проблема и вывод',
        filled(diagnosis?.problem) && filled(diagnosis?.conclusion),
      ),
      check('diagnosis-hypothesis', 'Предполагаемая причина', filled(diagnosis?.causeHypothesis)),
      check(
        'diagnosis-facts',
        'Факты с периодом, единицей и источником',
        facts.length > 0 &&
          facts.every(
            (item) =>
              item.data.year !== null &&
              item.data.value !== null &&
              filled(item.data.unit) &&
              filled(item.data.sourceReference) &&
              filled(item.data.interpretation),
          ),
      ),
      check(
        'diagnosis-basis',
        'Актуальность выбранных оснований',
        (facts.length > 0 || bases.length > 0) &&
          bases.every((item) => item.staleReasons.length === 0) &&
          !issues.some(
            (issue) => issue.code === 'STATISTICS_SOURCE_CHANGED' && issue.field === 'fact',
          ),
      ),
    ]),
    section('indicators', 'Целевые показатели', [
      check(
        'indicator-definitions',
        'Определения и единицы',
        indicators.length > 0 &&
          indicators.every(
            (item) =>
              filled(item.data.title) && filled(item.data.definition) && filled(item.data.unit),
          ),
      ),
      check(
        'indicator-baseline',
        'Исходные значения и годы',
        indicators.length > 0 &&
          indicators.every(
            (item) => item.data.baselineValue !== null && item.data.baselineYear !== null,
          ),
      ),
      check(
        'indicator-targets',
        'Годовые ориентиры',
        indicators.length > 0 &&
          indicators.every((item) => item.data.annualTargets.length > 0) &&
          !issues.some((issue) => issue.code === 'TARGET_YEAR_OUTSIDE_PROJECT'),
      ),
      check(
        'indicator-method',
        'Источник, частота и ответственный',
        indicators.length > 0 &&
          indicators.every(
            (item) =>
              filled(item.data.sourceReference) &&
              filled(item.data.frequency) &&
              filled(item.data.responsible),
          ),
      ),
      check(
        'indicator-denominator',
        'Знаменатели долей и коэффициентов',
        indicators.length > 0 &&
          indicators.every(
            (item) =>
              !['share', 'rate'].includes(item.data.semanticType) ||
              (filled(item.data.numeratorDefinition) && filled(item.data.denominatorDefinition)),
          ),
      ),
    ]),
    section('activities', 'План мероприятий', [
      check(
        'activity-substance',
        'Содержание и адресат действий',
        activities.length > 0 &&
          activities.every(
            (item) =>
              filled(item.data.title) &&
              filled(item.data.description) &&
              filled(item.data.targetGroup),
          ),
      ),
      check(
        'activity-objectives',
        'Связи с задачами',
        activities.length > 0 &&
          activities.every(
            (item) => item.data.objectiveId !== null && objectiveIds.has(item.data.objectiveId),
          ),
      ),
      check(
        'activity-responsibility',
        'Исполнители и продукты',
        activities.length > 0 &&
          activities.every(
            (item) =>
              filled(item.data.responsible) &&
              filled(item.data.deliverable) &&
              filled(item.data.completionCriterion),
          ),
      ),
      check(
        'activity-indicators',
        'Связи с показателями',
        activities.length > 0 &&
          !issues.some((issue) => issue.code === 'ACTIVITY_INDICATOR_LINK_MISSING'),
      ),
      check(
        'activity-authority',
        'Полномочия либо путь необходимого согласования',
        activities.length > 0 &&
          activities.every(
            (item) =>
              item.data.authorityLevel !== 'unknown' &&
              ((item.data.approvalStatus === 'verified_source' && filled(item.data.legalBasis)) ||
                (item.data.approvalStatus === 'requires_decision' &&
                  filled(item.data.necessaryDecision) &&
                  filled(item.data.responsibleBody))),
          ),
      ),
    ]),
    section('calendar', 'Этапы и календарь', [
      check(
        'calendar-dates',
        'Даты и этапы мероприятий',
        activities.length > 0 &&
          calendar !== null &&
          calendar.rows.length === activities.length &&
          activities.every((item) => item.data.stage !== 'custom' || filled(item.data.stageLabel)),
      ),
      check(
        'calendar-consistency',
        'Согласованная последовательность и период',
        calendar !== null && calendar.issues.length === 0,
      ),
      check(
        'calendar-costs',
        'Годы расходов согласованы со сроками',
        activities.length > 0 &&
          costs.length > 0 &&
          !issues.some((issue) => issue.code === 'COST_YEAR_OUTSIDE_SCHEDULE'),
      ),
    ]),
    section('resources', 'Ресурсы и финансирование', [
      check(
        'resources-description',
        'Кадровые, материальные и информационные ресурсы',
        filled(passport?.humanResources) &&
          filled(passport?.materialResources) &&
          filled(passport?.informationResources),
      ),
      check('resources-estimate', 'Смета по мероприятиям', costs.length > 0 && budget !== null),
      check(
        'resources-price',
        'Основания цен',
        costs.length > 0 && costs.every((item) => filled(item.data.priceSource)),
      ),
      check(
        'resources-funding',
        'Подтверждённое обеспечение денежных расходов',
        budget !== null && costs.length > 0 && budget.totals.confirmedGapKopecks === 0,
      ),
    ]),
    section('risks', 'Риски и резервные действия', [
      check(
        'risks-definition',
        'Риски и способы снижения',
        risks.length > 0 &&
          risks.every((item) => filled(item.data.title) && filled(item.data.mitigation)),
      ),
      check(
        'risks-owner',
        'Ответственные и условия реагирования',
        risks.length > 0 &&
          risks.every(
            (item) =>
              filled(item.data.owner) && filled(item.data.trigger) && filled(item.data.contingency),
          ),
      ),
    ]),
    section('monitoring', 'Мониторинг и результаты', [
      check(
        'monitoring-method',
        'Метод, частота и ответственный',
        filled(monitoring?.method) &&
          filled(monitoring?.frequency) &&
          filled(monitoring?.responsible),
      ),
      check(
        'monitoring-reports',
        'Сроки промежуточного и итогового отчётов',
        isCalendarDate(monitoring?.interimReportDate) &&
          isCalendarDate(monitoring?.finalReportDate) &&
          monitoring!.interimReportDate! <= monitoring!.finalReportDate!,
      ),
      check(
        'monitoring-results',
        'Качественные результаты и устойчивость',
        filled(monitoring?.qualitativeResults) && filled(monitoring?.sustainability),
      ),
    ]),
  ];
  for (const area of sections)
    for (const criterion of area.checks)
      if (!criterion.complete)
        issues.push({
          code: 'INCOMPLETE_' + criterion.id.toUpperCase().replaceAll('-', '_'),
          severity: 'warning',
          field: area.id,
          message: criterion.label,
        });
  const checks = sections.flatMap((area) => area.checks);
  const completedChecks = checks.filter((criterion) => criterion.complete).length;
  return {
    sections,
    completedChecks,
    totalChecks: checks.length,
    percentComplete: Math.round((completedChecks / checks.length) * 100),
    completedSections: sections.filter((area) => area.complete).length,
    issues,
    interpretation: 'document_completeness_not_scientific_quality',
  };
}
