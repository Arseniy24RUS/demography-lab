import { parseRoadmapVersion } from '../roadmaps/schema';
import type {
  FrozenRoadmapData,
  RoadmapBarrierGround,
  RoadmapBasis,
  RoadmapVersion,
} from '../roadmaps/types';
import {
  activeRoadmapItems,
  assessRoadmapReadiness,
  computeRoadmapBudget,
  computeRoadmapScenarios,
} from '../analytics/readiness';
import { inspectCalendar } from '../analytics/calendar';
import { formatKopecks } from '../analytics/budget';
import type { AnalysisIssue, CalendarResult } from '../analytics/types';
import { verifyTeamStatisticalSeries } from '../statistics/integrity';
import { getStatisticsBindings } from '../statistics/bindings';
import {
  compareSeriesPoints,
  getEffectiveSeries,
  isTeamStatisticalSeries,
} from '../statistics/series';
import { calendarFigures, scenarioFigure } from './figures';
import { ROADMAP_EXPORT_VERSION } from './types';
import type { PreparedRoadmapExport, ReportBlock } from './types';

export const MISSING_VALUE = 'Не указано';
const labels: Record<string, string> = {
  municipality: 'Муниципальный',
  municipal: 'Муниципальные полномочия',
  region: 'Региональный',
  regional: 'Региональные полномочия',
  federal: 'Федеральный',
  organization: 'Организация',
  joint: 'Совместные полномочия',
  unknown: 'Не проверено',
  resource: 'Ресурс',
  output: 'Непосредственный результат',
  family_outcome: 'Результат для семьи',
  demographic_context: 'Демографический контекст',
  stock: 'Численность или состояние',
  flow: 'Поток за период',
  rate: 'Коэффициент',
  share: 'Доля',
  nonnegative: 'Неотрицательные значения',
  signed: 'Допустимы отрицательные значения',
  percent: 'Проценты от 0 до 100',
  ratio: 'Доля от 0 до 1',
  preparation: 'Подготовительный',
  implementation: 'Основной',
  evaluation: 'Итоговый',
  custom: 'Дополнительный этап',
  planned: 'Запланировано',
  in_progress: 'Выполняется',
  completed: 'Завершено',
  requires_decision: 'Требуется решение',
  verified_source: 'Участники указали проверенное основание',
  contradiction: 'Выявлено противоречие',
  confirmed: 'Подтверждено документом',
  estimated: 'Оценка',
  budget_draft: 'Проект бюджета',
  application: 'Заявка',
  assumption: 'Предположение',
  municipal_budget: 'Муниципальный бюджет',
  regional_budget: 'Региональный бюджет',
  federal_budget: 'Федеральный бюджет',
  employer: 'Работодатель',
  grant: 'Грант',
  other: 'Иной источник',
  registry: 'Закреплённый статистический ряд',
  team_statistics: 'Факт из закреплённой рабочей редакции команды',
  team_reported: 'Рабочая редакция, уточнённая участниками',
  participant_supplied: 'Источник указан участниками; независимая проверка не выполнена',
  external_unverified: 'Внешнее значение участника без проверки первоисточника',
  source_reported: 'Значение авторского набора',
  calculated: 'Вычисленный показатель',
  incomplete_primary: 'Неполные первичные метаданные',
  not_verified: 'Сопоставимость границ не подтверждена',
  annual_average: 'В среднем за год',
  calendar_year: 'За календарный год',
  persons: 'человек',
  observation: 'Наблюдение участников',
  hypothesis: 'Гипотеза',
  survey_summary: 'Обобщение опроса',
  life_plans: 'Жизненные планы',
  first_child: 'Первый ребёнок',
  preparation_pregnancy: 'Подготовка и беременность',
  infancy: 'Первый год',
  early_childhood: 'От 1 до 3 лет',
  preschool: 'Дошкольный период',
  school: 'Школьный период',
  next_child: 'Следующий ребёнок',
  potential: 'Возможная связь',
  partial: 'Частичное решение',
  needs_adaptation: 'Требуется адаптация',
  active: 'Включено в работу',
  archived: 'Архивная запись',
  candidate: 'Кандидат',
  verified: 'Проверено участниками',
  rejected: 'Отклонено',
  supports: 'Поддерживает утверждение',
  contradicts: 'Противоречит утверждению',
  title: 'Название',
  mechanism: 'Механизм',
  eligibility: 'Получатели',
  amount: 'Размер',
  conditions: 'Условия',
  last_value: 'Сохранение последнего уровня',
  linear: 'Линейная экстраполяция',
  absolute_end: 'Абсолютная цель последнего года',
  relative_end: 'Изменение относительно базы к последнему году в процентах',
  annual_growth: 'Ежегодное изменение в процентах',
  absolute_delta_end: 'Абсолютное изменение базы к последнему году',
  percentage_points: 'Изменение базы в процентных пунктах',
  source_changed: 'Содержание источника изменилось',
  source_archived: 'Источник отправлен в архив',
  source_missing: 'Источник недоступен',
  source_basis_stale: 'Основание исходного решения устарело',
  passport: 'Паспорт',
  diagnosis: 'Диагноз',
  monitoring: 'Мониторинг',
  activity: 'Мероприятие',
  indicator: 'Показатель',
  scenario: 'Сценарий',
  cost: 'Статья сметы',
  funding: 'Финансирование',
  risk: 'Риск',
  fact: 'Факт',
  mitigation: 'Предупреждение риска',
  owner: 'Ответственный',
  trigger: 'Признак наступления',
  contingency: 'Действия при наступлении',
  historical_source_snapshot: 'Исторический снимок исходной географии',
  corpus_scope: 'Территориальный охват корпуса',
  municipal_district: 'Муниципальный район',
  municipal_okrug: 'Муниципальный округ',
  urban_okrug: 'Городской округ',
  intraurban_municipality: 'Внутригородское муниципальное образование',
  administrative_district: 'Административный район',
};
export function translated(value: string): string {
  return labels[value] ?? value;
}
export function displayValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return MISSING_VALUE;
  return typeof value === 'number' ? formatNumber(value) : value;
}
export function formatNumber(value: number | null, maximumFractionDigits = 4): string {
  return value === null
    ? 'Нет данных'
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits }).format(value);
}
export function formatDate(value: string | null): string {
  if (!value) return MISSING_VALUE;
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value.split('-').reverse().join('.') : value;
}
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error('Проверка контрольной суммы требует HTTPS или localhost с Web Crypto.');
  const data = new Uint8Array(bytes).buffer;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  return [...digest].map((v) => v.toString(16).padStart(2, '0')).join('');
}
export const sha256Text = (text: string) => sha256Bytes(new TextEncoder().encode(text));

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
function unique(values: string[], title: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`Снимок содержит повторяющиеся идентификаторы: ${title}.`);
}
function validateSnapshotRelations(snapshot: FrozenRoadmapData): void {
  unique(
    snapshot.items.map((row) => row.id),
    'записи',
  );
  unique(
    snapshot.basis.map((row) => row.id),
    'основания',
  );
  unique(
    snapshot.series.map((row) => row.id),
    'статистические ряды',
  );
  unique(
    snapshot.evidence.map((row) => row.id),
    'документальные материалы',
  );
  if (snapshot.territory.level !== snapshot.roomLevel)
    throw new Error('Уровень территории не соответствует уровню дорожной карты.');
  for (const kind of ['passport', 'diagnosis', 'monitoring'] as const) {
    if (activeRoadmapItems(snapshot, kind).length !== 1)
      throw new Error(`Нужна одна активная запись раздела ${kind}.`);
  }
  for (const basis of snapshot.basis) {
    if (basis.material.kind !== 'link') continue;
    const source = basis.material.source;
    const evidence = snapshot.evidence.find((row) => row.id === source.evidenceId);
    if (!evidence || evidence.fingerprint !== source.familyFingerprint)
      throw new Error('Снимок не содержит полного документального основания закреплённой связи.');
  }
  for (const item of snapshot.items) {
    if (item.kind !== 'fact' || item.data.sourceKind === 'external_unverified') continue;
    const fact = item.data;
    const series = snapshot.series.find(
      (row) => row.id === fact.seriesId && row.fingerprint === fact.seriesFingerprint,
    );
    const point = series?.points.find((row) => row.year === fact.year);
    if (
      !series ||
      !point ||
      point.value === null ||
      point.value !== fact.value ||
      series.metricId !== fact.metricId ||
      series.unit !== fact.unit ||
      (fact.sourceKind === 'team_statistics') !== (series.sourceKind === 'team_reported') ||
      series.territoryKey !== snapshot.territory.key
    )
      throw new Error(
        'Статистический факт не соответствует закреплённому источнику, единице, году или территории.',
      );
  }
}
function calendarFor(snapshot: FrozenRoadmapData): CalendarResult {
  const passport = activeRoadmapItems(snapshot, 'passport')[0]!.data;
  const activities = activeRoadmapItems(snapshot, 'activity').map((row) => ({
    id: row.id,
    ...row.data,
  }));
  if (passport.startDate && passport.endDate)
    return inspectCalendar(activities, {
      startDate: passport.startDate,
      endDate: passport.endDate,
    });
  const dates = activities
    .flatMap((row) => (row.startDate && row.endDate ? [row.startDate, row.endDate] : []))
    .sort();
  const issue: AnalysisIssue = {
    code: 'EXPORT_MISSING_PROJECT_PERIOD',
    severity: 'warning',
    message:
      'Период в паспорте не указан. Шкала календаря охватывает только сохранённые даты мероприятий.',
  };
  if (dates.length === 0)
    return {
      calendar: 'calendar_days',
      rows: [],
      issues: [issue],
      topologicalOrder: [],
      totalDays: 0,
    };
  const result = inspectCalendar(activities, { startDate: dates[0]!, endDate: dates.at(-1)! });
  result.issues.unshift(issue);
  return result;
}
function budgetEqual(a: unknown, b: unknown): boolean {
  const ordered = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(ordered)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k, value]) => [k, ordered(value)]),
          )
        : v;
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}

export async function prepareRoadmapExport(input: RoadmapVersion): Promise<PreparedRoadmapExport> {
  const version = parseRoadmapVersion(input);
  const actualHash = await sha256Text(version.canonicalJson);
  if (actualHash !== version.sha256)
    throw new Error(
      'Контрольная сумма версии не совпадает. Экспорт отменён; загрузите сохранённую версию повторно.',
    );
  validateSnapshotRelations(version.snapshot);
  const snapshot = version.snapshot;
  await Promise.all(
    snapshot.series.filter(isTeamStatisticalSeries).map(verifyTeamStatisticalSeries),
  );
  const budget = computeRoadmapBudget(snapshot);
  const reproducedBudget = { ...budget.totals, years: budget.years };
  const storedBudget = {
    ...snapshot.budget,
    years: [...snapshot.budget.years].sort((a, b) => a.year - b.year),
  };
  if (!budgetEqual(reproducedBudget, storedBudget))
    throw new Error('Расчёт сметы не совпадает с итогами зафиксированной версии. Экспорт отменён.');
  const readiness = assessRoadmapReadiness(snapshot);
  const scenarios = computeRoadmapScenarios(snapshot);
  const calendar = calendarFor(snapshot);
  // Readiness already carries scenario warnings with their entity IDs.
  // Only the export-specific fallback-calendar note is added here.
  const issues = [...readiness.issues, ...calendar.issues];
  const seen = new Set<string>();
  const deduplicatedIssues = issues.filter((issue) => {
    const key = `${issue.code}:${issue.entityId ?? ''}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const safeKey = snapshot.territory.key.replace(/[^a-z0-9_-]/giu, '-').slice(0, 80) || 'territory';
  const prepared: PreparedRoadmapExport = {
    exportVersion: ROADMAP_EXPORT_VERSION,
    version,
    basename: `roadmap-${safeKey}-v${version.number}-${version.sha256.slice(0, 12)}`,
    title: 'Дорожная карта демографического проекта',
    subtitle: snapshot.territory.name,
    blocks: [],
    figures: [],
    readiness,
    budget,
    calendar,
    scenarios,
    issues: deduplicatedIssues,
  };
  prepared.blocks = buildReportBlocks(prepared);
  prepared.figures = prepared.blocks.flatMap((block) =>
    block.kind === 'figure' ? [block.figure] : [],
  );
  return deepFreeze(prepared);
}

function buildReportBlocks(prepared: PreparedRoadmapExport): ReportBlock[] {
  const { version, readiness, calendar, budget, scenarios, issues } = prepared;
  const snapshot = version.snapshot;
  const blocks: ReportBlock[] = [];
  const h = (text: string, level: 1 | 2 | 3 = 1) => blocks.push({ kind: 'heading', text, level });
  const p = (text: string, label?: string, role?: 'body' | 'meta' | 'quote' | 'warning') =>
    blocks.push({ kind: 'paragraph', text: displayValue(text), label, role });
  const field = (label: string, value: string | number | null | undefined) =>
    p(displayValue(value), label);
  const table = (
    caption: string,
    titles: string[],
    rows: string[][],
    weights?: number[],
    align?: Array<'left' | 'right' | 'center'>,
  ) => {
    if (rows.length === 0) {
      p('Записи отсутствуют.', caption);
      return;
    }
    blocks.push({
      kind: 'table',
      caption,
      columns: titles.map((title, i) => ({
        title,
        weight: weights?.[i] ?? 1,
        align: align?.[i] ?? 'left',
      })),
      rows,
    });
  };
  const passport = activeRoadmapItems(snapshot, 'passport')[0]!.data;
  const diagnosis = activeRoadmapItems(snapshot, 'diagnosis')[0]!.data;
  const monitoring = activeRoadmapItems(snapshot, 'monitoring')[0]!.data;
  const activities = activeRoadmapItems(snapshot, 'activity');
  const indicators = activeRoadmapItems(snapshot, 'indicator');
  const facts = activeRoadmapItems(snapshot, 'fact');
  const costs = activeRoadmapItems(snapshot, 'cost');
  const funding = activeRoadmapItems(snapshot, 'funding');
  const risks = activeRoadmapItems(snapshot, 'risk');
  const statisticsBindings = getStatisticsBindings(snapshot);
  const describeStatisticsBinding = (itemId: string) => {
    const binding = statisticsBindings.find((row) => row.itemId === itemId);
    if (!binding) return;
    p(binding.message, 'Выбор статистической редакции', binding.stale ? 'warning' : 'meta');
    if (binding.stale)
      field(
        'Рабочая редакция на момент фиксации',
        binding.currentSeriesId
          ? `${binding.currentSeriesId}; SHA256 ${binding.currentFingerprint}`
          : 'Исходный ряд отсутствует; ранее закреплённый материал сохранён.',
      );
  };
  const itemTitle = (id: string | null) =>
    id
      ? (snapshot.items.find((row) => row.id === id && 'title' in row.data)?.data as
          { title: string } | undefined)
      : undefined;
  const nameOf = (id: string | null) =>
    id === null ? MISSING_VALUE : itemTitle(id)?.title || `Запись ${id}`;
  const status = version.kind === 'submitted' ? 'Версия для обсуждения' : 'Черновая версия';
  p(
    `${status} ${version.number}. Зафиксирована ${new Date(version.createdAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}. Ревизия ${version.roadmapRevision}.`,
    undefined,
    'meta',
  );
  p(
    'Документ объединяет диагноз территории, основания выбора решений, мероприятия, показатели, календарь и ресурсное обеспечение. Содержательная часть воспроизводит сохранённую версию коллективной работы; её изменение требует новой версии.',
  );
  field('Название занятия', snapshot.session.title);
  field('Авторы', snapshot.teamNames.length ? snapshot.teamNames.join('; ') : MISSING_VALUE);
  field('Период проекта', `${formatDate(passport.startDate)} – ${formatDate(passport.endDate)}`);
  p(
    `Заполнено ${readiness.completedChecks} из ${readiness.totalChecks} проверяемых позиций (${readiness.percentComplete}%). Это комплектность документа, а не оценка научной обоснованности, юридической силы или эффективности.`,
    undefined,
    'meta',
  );
  if (issues.length)
    p(
      `В версии сохранено ${issues.length} предупреждений и замечаний. Полный перечень и незаполненные позиции приведены в приложении проверки комплектности.`,
      undefined,
      'warning',
    );

  h('1 Паспорт проекта');
  field('Наименование проекта', passport.title);
  field('Уровень и территория', `${translated(snapshot.roomLevel)}; ${snapshot.territory.name}`);
  field('Целевая группа', passport.targetGroup);
  field('Партнёры', passport.partners);
  field('Цель', passport.goal);
  table(
    'Задачи проекта',
    ['Код', 'Задача'],
    passport.objectives.map((row, index) => [`З${index + 1}`, displayValue(row.title)]),
    [1, 9],
  );
  field('Планируемый результат', passport.expectedResult);
  field('Дата защиты', formatDate(passport.defenseDate));

  h('2 Исходная ситуация и основания диагноза');
  field('Проблема', diagnosis.problem);
  field('Гипотеза о причинах', diagnosis.causeHypothesis);
  field('Вывод для проектирования', diagnosis.conclusion);
  table(
    'Исходные факты',
    ['Показатель', 'Год', 'Значение', 'Единица'],
    facts.map((row) => [
      displayValue(row.data.title),
      row.data.year === null ? 'Не указано' : String(row.data.year),
      formatNumber(row.data.value),
      translated(row.data.unit),
    ]),
    [4.8, 1.3, 2, 1.9],
    ['left', 'center', 'right', 'left'],
  );
  for (const [index, fact] of facts.entries()) {
    h(`Факт ${index + 1}`, 2);
    field('Название', fact.data.title);
    field('Интерпретация участников', fact.data.interpretation);
    field('Происхождение', translated(fact.data.sourceKind));
    field('Источник', fact.data.sourceReference);
    field('Дата источника', formatDate(fact.data.sourceDate));
    if (fact.data.sourceKind === 'registry' || fact.data.sourceKind === 'team_statistics') {
      field('Закреплённый ряд', fact.data.seriesId);
      field('SHA256 ряда', fact.data.seriesFingerprint);
      describeStatisticsBinding(fact.id);
    }
  }
  h('Основания выбора решений', 2);
  const activeBasis = snapshot.basis.filter((basis) => basis.status === 'active');
  if (!activeBasis.length)
    p('Барьеры, авторские решения и региональные практики пока не закреплены.');
  else
    for (const [index, basis] of activeBasis.entries()) {
      field(
        `Основание ${index + 1}`,
        basis.material.kind === 'link'
          ? `${basis.material.source.barrier.title} → ${basis.material.source.familyTitle}`
          : basis.material.source.title,
      );
      field('Обоснование включения', basis.rationale);
      if (basis.staleReasons.length)
        p(basis.staleReasons.map(translated).join('; '), 'Актуальность основания', 'warning');
    }
  p(
    'Полные зафиксированные барьеры, решения, региональные варианты и точные цитаты находятся в приложении документальных оснований. Связь с практикой является гипотезой применимости, а оценка участниками не удостоверяет её демографический эффект.',
    undefined,
    'meta',
  );

  h('3 Целевые показатели и сценарии');
  table(
    'Система показателей',
    ['Показатель и единица', 'Исходное значение', 'Цели по годам'],
    indicators.map((row) => [
      displayValue(row.data.title) + ` (${displayValue(row.data.unit)})`,
      row.data.baselineYear === null
        ? 'Нет данных'
        : `${row.data.baselineYear}: ${formatNumber(row.data.baselineValue)}`,
      row.data.annualTargets.length
        ? [...row.data.annualTargets]
            .sort((a, b) => a.year - b.year)
            .map((t) => `${t.year}: ${formatNumber(t.value)}`)
            .join('\n')
        : MISSING_VALUE,
    ]),
    [4.5, 2.3, 3.2],
  );
  for (const [index, indicator] of indicators.entries()) {
    const data = indicator.data;
    h(`Показатель ${index + 1}`, 2);
    field('Название', data.title);
    field('Определение', data.definition);
    field(
      'Назначение и семантика',
      `${translated(data.kind)}; ${translated(data.semanticType)}; ${translated(data.valueDomain)}`,
    );
    field('Числитель', data.numeratorDefinition);
    field('Знаменатель', data.denominatorDefinition);
    field('Источник', data.sourceReference);
    field('Периодичность', data.frequency);
    field('Ответственный', data.responsible);
    field('Ограничения интерпретации', data.limitations);
    if (data.scenarioId) field('Связанный сценарий', nameOf(data.scenarioId));
  }
  if (scenarios.length) {
    h('Расчётные траектории', 2);
    p(
      'Базовая траектория продолжает выбранный статистический ряд по сохранённой формуле. Целевая траектория выражает плановое допущение участников. Разность траекторий является плановым разрывом; она не устанавливает число рождений, причинно обусловленных мероприятиями. Вероятностные интервалы здесь не рассчитываются.',
    );
  }
  for (const [index, scenario] of scenarios.entries()) {
    const item = activeRoadmapItems(snapshot, 'scenario').find(
      (row) => row.id === scenario.itemId,
    )!;
    const parameters = item.data.parameters;
    h(`Сценарий ${index + 1}`, 2);
    field('Название', item.data.title);
    field('Предпосылки участников', item.data.assumptions);
    field(
      'Параметры',
      `История ${parameters.historyStartYear}–${parameters.historyEndYear}; горизонт до ${parameters.endYear}; база: ${translated(parameters.baselineMethod)}; цель: ${translated(parameters.targetMode)}; параметр: ${formatNumber(parameters.targetValue)}.`,
    );
    field('Ряд и редакция', `${item.data.seriesId}; SHA256 ${item.data.seriesFingerprint}`);
    describeStatisticsBinding(item.id);
    if (!scenario.result) {
      p(scenario.error ?? 'Сценарий не рассчитан.', 'Ошибка расчёта', 'warning');
      continue;
    }
    const result = scenario.result;
    field(
      'Фактическая опорная точка',
      `${result.baselineYear}: ${formatNumber(result.baselineObservedValue)} ${translated(result.definition.unit)}`,
    );
    field('Годы расчёта базовой траектории', result.trainingYears.join(', '));
    if (result.coefficients)
      field(
        'Коэффициенты линейной базы',
        `x = год − ${result.coefficients.firstYear}; B = ${formatNumber(result.coefficients.intercept, 8)} + (${formatNumber(result.coefficients.slopePerYear, 8)}) × x.`,
      );
    blocks.push({
      kind: 'figure',
      figure: scenarioFigure(
        `scenario-${index + 1}`,
        `${item.data.title}: история и траектории`,
        result,
      ),
    });
    table(
      'Значения по годам',
      ['Год', 'Источник', 'Базовая', 'Целевая', 'Округлённый план', 'Разница'],
      result.years.map((row) => [
        String(row.year),
        formatNumber(row.observedValue),
        formatNumber(row.baselineValue),
        formatNumber(row.targetValue),
        formatNumber(row.plannedTargetValue, 0),
        formatNumber(row.delta),
      ]),
      [1.2, 1.6, 1.8, 1.8, 2, 1.6],
      ['center', 'right', 'right', 'right', 'right', 'right'],
    );
    field(
      'Плановый разрыв последнего года',
      `${formatNumber(result.endGap)} ${translated(result.definition.unit)}`,
    );
    if (result.cumulativeFlowGap !== null)
      field(
        'Сумма плановых разрывов потока',
        `${formatNumber(result.cumulativeFlowGap)} ${translated(result.definition.unit)} за расчётный период`,
      );
    else
      p('Годовые разницы для состояния, коэффициента или доли не суммируются.', undefined, 'meta');
    if (result.backtest)
      field(
        'Проверка на отложенных годах',
        `${result.backtest.heldOutYears.join(', ')}; MAE тренда ${formatNumber(result.backtest.linearMae)}, MAE сохранения уровня ${formatNumber(result.backtest.lastValueMae)}. Проверка по этому ряду не подтверждает внешнюю прогностическую точность.`,
      );
    for (const warning of result.warnings) p(warning.message, 'Ограничение сценария', 'warning');
  }

  h('4 План мероприятий');
  table(
    'Сводный план',
    ['Код и мероприятие', 'Начало и окончание', 'Ответственный'],
    activities.map((row, index) => [
      `М${index + 1} ${displayValue(row.data.title)}`,
      `${formatDate(row.data.startDate)}\n${formatDate(row.data.endDate)}`,
      displayValue(row.data.responsible),
    ]),
    [5, 2.2, 2.8],
  );
  for (const [index, activity] of activities.entries()) {
    const data = activity.data;
    h(`Мероприятие ${index + 1}`, 2);
    field('Название', data.title);
    field('Содержание', data.description);
    field('Решаемая задача', passport.objectives.find((row) => row.id === data.objectiveId)?.title);
    field('Целевая группа', data.targetGroup);
    field('Масштаб', data.scale);
    field('Партнёры', data.partners);
    field('Результат', data.deliverable);
    field('Критерий выполнения', data.completionCriterion);
    field('Связанные показатели', data.indicatorIds.map(nameOf).join('; '));
    field('Этап', data.stage === 'custom' ? data.stageLabel : translated(data.stage));
    field('Статус выполнения', translated(data.progressStatus));
    field('Уровень полномочий', translated(data.authorityLevel));
    field('Правовое основание', data.legalBasis);
    field('Статус проверки полномочий', translated(data.approvalStatus));
    field('Компетентный орган', data.responsibleBody);
    field('Необходимое решение', data.necessaryDecision);
  }

  h('5 Этапы и календарь');
  table(
    'Этапы реализации',
    ['Этап', 'Период', 'Мероприятия и результаты'],
    ['preparation', 'implementation', 'evaluation', 'custom'].flatMap((stage) => {
      const rows = activities.filter((row) => row.data.stage === stage);
      if (!rows.length) return [];
      const starts = rows.flatMap((row) => (row.data.startDate ? [row.data.startDate] : [])).sort();
      const ends = rows.flatMap((row) => (row.data.endDate ? [row.data.endDate] : [])).sort();
      return [
        [
          translated(stage),
          `${formatDate(starts[0] ?? null)} – ${formatDate(ends.at(-1) ?? null)}`,
          rows
            .map((row) => `${displayValue(row.data.title)}: ${displayValue(row.data.deliverable)}`)
            .join('\n'),
        ],
      ];
    }),
    [2.4, 2.3, 5.3],
  );
  for (const figure of calendarFigures(calendar)) blocks.push({ kind: 'figure', figure });
  table(
    'Сроки и зависимости',
    ['Мероприятие', 'Даты', 'Дней', 'Предшественники'],
    activities.map((row, index) => [
      `М${index + 1} ${displayValue(row.data.title)}`,
      `${formatDate(row.data.startDate)} – ${formatDate(row.data.endDate)}`,
      displayValue(calendar.rows.find((r) => r.id === row.id)?.durationDays),
      row.data.dependencies.length
        ? row.data.dependencies
            .map((d) => `${nameOf(d.predecessorId)}; пауза ${d.lagDays} дн.`)
            .join('\n')
        : 'Нет',
    ]),
    [4, 2.4, 0.9, 3.7],
  );
  p(
    'Длительность включает начальный и конечный календарные дни. Связь «после окончания» разрешает начать следующее мероприятие со дня, следующего за окончанием предшественника, с учётом указанной паузы. Изменение одной даты не переносит другие даты автоматически.',
    undefined,
    'meta',
  );

  h('6 Ресурсы и финансовое обеспечение');
  field('Кадровые ресурсы', passport.humanResources);
  field('Материальные ресурсы', passport.materialResources);
  field('Информационные ресурсы', passport.informationResources);
  table(
    'Финансовая потребность и подтверждённое обеспечение в рублях',
    ['Год', 'Денежная потребность', 'Подтверждено', 'Непокрытый разрыв'],
    budget.years
      .map((row) => [
        String(row.year),
        formatKopecks(row.needCashKopecks),
        formatKopecks(row.confirmedKopecks),
        formatKopecks(row.confirmedGapKopecks),
      ])
      .concat([
        [
          'Итого',
          formatKopecks(budget.totals.needCashKopecks),
          formatKopecks(budget.totals.confirmedKopecks),
          formatKopecks(budget.totals.confirmedGapKopecks),
        ],
      ]),
    [1.2, 3, 2.8, 3],
    ['center', 'right', 'right', 'right'],
  );
  table(
    'Предполагаемое обеспечение и неденежный вклад в рублях',
    ['Год', 'Ожидается', 'Разрыв при исполнении ожиданий', 'Неденежный вклад'],
    budget.years
      .map((row) => [
        String(row.year),
        formatKopecks(row.expectedKopecks),
        formatKopecks(row.remainingAfterExpectedKopecks),
        formatKopecks(row.inKindKopecks),
      ])
      .concat([
        [
          'Итого',
          formatKopecks(budget.totals.expectedKopecks),
          formatKopecks(budget.totals.remainingAfterExpectedKopecks),
          formatKopecks(budget.totals.inKindKopecks),
        ],
      ]),
    [1.2, 2.6, 3.6, 2.6],
    ['center', 'right', 'right', 'right'],
  );
  p(
    'Все денежные значения рассчитаны в целых копейках. Для строки используется количество с точностью до 0,001 × цена за единицу × число периодов; половина копейки округляется вверх один раз на итоговой стоимости строки. Ожидаемые средства не уменьшают разрыв относительно подтверждённого финансирования. Оценка неденежного вклада показана отдельно.',
  );
  table(
    'Строки сметы',
    ['Статья и год', 'Количество × периодов', 'Цена в рублях', 'Сумма в рублях'],
    costs.map((row) => [
      displayValue(row.data.title) + `; ${row.data.year}`,
      `${row.data.quantity} ${displayValue(row.data.unit)} × ${row.data.periods}`,
      formatKopecks(row.data.unitPriceKopecks),
      formatKopecks(budget.lines.find((line) => line.id === row.id)!.totalKopecks),
    ]),
    [4, 2.2, 1.9, 1.9],
    ['left', 'left', 'right', 'right'],
  );
  for (const [index, cost] of costs.entries()) {
    field(
      `Статья ${index + 1}`,
      `${displayValue(cost.data.title)}; мероприятие: ${nameOf(cost.data.activityId)}; ${cost.data.cashKind === 'cash' ? 'денежные расходы' : 'неденежный вклад'}; цена: ${translated(cost.data.priceStatus)}.`,
    );
    field('Основание цены', cost.data.priceSource);
    field('Дата основания цены', formatDate(cost.data.priceDate));
  }
  table(
    'Источники покрытия расходов',
    ['Статья', 'Источник и статус', 'Сумма в рублях'],
    funding.map((row) => [
      nameOf(row.data.costLineId),
      `${displayValue(row.data.sourceName)}\n${translated(row.data.sourceKind)}\n${translated(row.data.status)}`,
      formatKopecks(row.data.amountKopecks),
    ]),
    [4, 4, 2],
    ['left', 'left', 'right'],
  );
  for (const [index, source] of funding.entries()) {
    field(
      `Основание финансирования ${index + 1}`,
      `${displayValue(source.data.sourceName)}; ${formatDate(source.data.sourceDate)}; ${displayValue(source.data.sourceReference)}`,
    );
    field('Первоначальное происхождение средств', source.data.originReference);
  }
  p(
    'Указание суммы и статуса участниками не создаёт бюджетных ассигнований и не заменяет проверку полномочий, финансового документа или решения о предоставлении средств. Подтверждение цены, подтверждение финансирования и правовое основание мероприятия проверяются раздельно.',
    undefined,
    'meta',
  );

  h('7 Риски и действия при отклонениях');
  for (const [index, risk] of risks.entries()) {
    h(`Риск ${index + 1}`, 2);
    field('Содержание', risk.data.title);
    field('Предупреждение риска', risk.data.mitigation);
    field('Ответственный', risk.data.owner);
    field('Признак наступления', risk.data.trigger);
    field('Действия при наступлении', risk.data.contingency);
  }
  if (!risks.length) p('Риски не описаны.');

  h('8 Мониторинг и оценка');
  field('Периодичность', monitoring.frequency);
  field('Метод', monitoring.method);
  field('Ответственный', monitoring.responsible);
  field('Промежуточный отчёт', formatDate(monitoring.interimReportDate));
  field('Итоговый отчёт', formatDate(monitoring.finalReportDate));
  field('Качественные результаты', monitoring.qualitativeResults);
  field('Устойчивость результатов', monitoring.sustainability);

  h('Приложение 1 Комплектность и замечания');
  table(
    'Проверки структуры',
    ['Раздел', 'Готово', 'Требует заполнения'],
    readiness.sections.map((row) => [
      row.title,
      `${row.checks.filter((c) => c.complete).length} / ${row.checks.length}`,
      row.checks
        .filter((c) => !c.complete)
        .map((c) => c.label)
        .join('\n') || 'Все структурные позиции заполнены',
    ]),
    [2.7, 1.2, 6.1],
  );
  if (!issues.length)
    p(
      'Автоматические проверки не выявили замечаний. Это не является экспертизой научной обоснованности, полномочий или финансового обеспечения.',
    );
  else
    for (const [index, issue] of issues.entries())
      p(
        `${issue.message}${issue.entityId ? ` Связь: ${nameOf(issue.entityId)}.` : ''}`,
        `${index + 1} ${issue.severity === 'error' ? 'Ошибка' : 'Замечание'} ${issue.code}`,
        'warning',
      );

  h('Приложение 2 Документальные основания');
  p(
    'Ниже сохранены все включённые в версию основания, в том числе архивные. Исторический документ и цитата не подтверждают актуальное право на меру и её причинный эффект. Региональные условия и размеры сохраняются раздельно. Идентификаторы блоков и позиции относятся к канонической текстовой редакции; номера страниц не восстанавливаются предположением.',
  );
  const barrier = (data: RoadmapBarrierGround) => {
    field('Барьер', data.title);
    field('Описание', data.description);
    field('Жизненные этапы', data.stageIds.map(translated).join('; '));
    field('Тип основания', translated(data.evidenceKind));
    field(
      'Редакция и статус барьера',
      `${data.id}; ревизия ${data.contentRevision}; ${translated(data.status)}`,
    );
  };
  const renderBasis = (basis: RoadmapBasis, index: number) => {
    h(`Основание ${index + 1}`, 2);
    field(
      'Статус и реквизиты',
      `${translated(basis.status)}; ${basis.id}; ревизия ${basis.revision}; исходная ревизия ${basis.sourceRevision}`,
    );
    field('Мотивировка включения', basis.rationale);
    if (basis.staleReasons.length)
      p(basis.staleReasons.map(translated).join('; '), 'Замечания актуальности', 'warning');
    field('SHA256 основания', basis.fingerprint);
    if (basis.material.kind === 'barrier') barrier(basis.material.source);
    else if (basis.material.kind === 'solution') {
      const solution = basis.material.source;
      field('Авторское решение', solution.title);
      field('Целевая группа', solution.targetGroup);
      field('Механизм', solution.mechanism);
      field('Первый шаг', solution.firstStep);
      field('Ответственный', solution.responsible);
      field('Ресурсы', solution.resources);
      field('Признак успеха', solution.successIndicator);
      field('Риски', solution.risks);
      field(
        'Ревизия и статус решения',
        `${solution.id}; ${solution.revision}; ${translated(solution.status)}`,
      );
      for (const ground of solution.barriers) barrier(ground);
    } else {
      const link = basis.material.source;
      barrier(link.barrier);
      field('Семейство практик', link.familyTitle);
      field('Тип связи', translated(link.relationship));
      field('Обоснование связи', link.explanation);
      field('Условия переноса', link.prerequisites);
      field('Ревизия и статус связи', `${link.id}; ${link.revision}; ${translated(link.status)}`);
      field('Документальный снимок', link.evidenceId);
      field('SHA256 семейства', link.familyFingerprint);
    }
  };
  snapshot.basis.forEach(renderBasis);
  if (!snapshot.basis.length) p('Документальные основания не закреплены.');
  for (const [familyIndex, evidence] of snapshot.evidence.entries()) {
    h(`Региональное семейство ${familyIndex + 1}`, 2);
    field('Название', evidence.title);
    field('Механизм', evidence.mechanism);
    field('Причина группировки', evidence.rationale);
    field(
      'Реквизиты снимка',
      `${evidence.id}; семейство ${evidence.familyId}; ревизия ${evidence.familyRevision}`,
    );
    field('SHA256 семейства', evidence.fingerprint);
    for (const [variantIndex, variant] of evidence.variants.entries()) {
      const { practice, occurrences, sources, note } = variant.bundle;
      h(`Региональный вариант ${familyIndex + 1} ${variantIndex + 1}`, 3);
      field(
        'Публикация',
        `${variant.submissionId}; ревизия ${variant.submissionRevision}; вариант ${practice.id}; регион ${practice.regionId}`,
      );
      field('Название', practice.title);
      field('Механизм', practice.mechanism);
      field('Получатели', practice.eligibility);
      field('Размер', practice.amount);
      field(
        'Условия',
        practice.conditions?.length
          ? practice.conditions.map((condition, i) => `${i + 1}. ${condition}`).join('\n')
          : undefined,
      );
      field(
        'Статус карточки',
        practice.reviewStatus ? translated(practice.reviewStatus) : MISSING_VALUE,
      );
      field('Комментарий к публикации', note);
      for (const source of sources) {
        field('Документ', source.title);
        field(
          'Редакция',
          `${source.sourceId}; ${source.editionId}; нормализация ${source.normalizationVersion}${source.regionId ? `; регион ${source.regionId}` : ''}`,
        );
        field('Источник документа', source.sourceUrl);
        field('SHA256 исходного файла', source.sha256);
      }
      for (const occurrence of occurrences) {
        field(
          'Фрагмент',
          `${occurrence.id}; документ ${occurrence.documentId}; редакция ${occurrence.versionId}; ${translated(occurrence.reviewStatus)}`,
        );
        field(
          'Якорь',
          `${occurrence.anchor.id}; нормализация ${occurrence.anchor.normalizationVersion}`,
        );
        for (const [spanIndex, span] of occurrence.anchor.spans.entries()) {
          field(
            `Позиция цитаты ${spanIndex + 1}`,
            `Блок ${span.blockId}; символы [${span.start}, ${span.end}) в Unicode code points.`,
          );
          p(span.exact, 'Точная цитата', 'quote');
          if (span.prefix) p(span.prefix, 'Контекст перед цитатой', 'meta');
          if (span.suffix) p(span.suffix, 'Контекст после цитаты', 'meta');
        }
        field('Комментарий к фрагменту', occurrence.note);
      }
      for (const proof of practice.evidence ?? []) {
        const fieldLabel = proof.field ? translated(proof.field) : 'Вся карточка';
        if (proof.kind === 'fragment') {
          field(
            'Проверка поля',
            `${fieldLabel}; фрагмент ${proof.occurrenceId}; ${proof.relation === 'partial' ? 'Частично подтверждает утверждение' : translated(proof.relation)}; ${translated(proof.reviewStatus)}`,
          );
          field('Значение на момент проверки', proof.reviewedValue);
          field('Комментарий проверки', proof.note);
        } else if (proof.kind === 'document')
          field(
            'Ссылка на документ',
            `${fieldLabel}; ${proof.documentId}; ${proof.versionId}; ${displayValue(proof.note)}. Общая ссылка не является проверкой отдельного поля.`,
          );
        else
          field(
            'Публикация о мере',
            `${fieldLabel}; ${displayValue(proof.title)}; ${proof.url}; ${displayValue(proof.note)}. Публикация не заменяет проверку документа.`,
          );
      }
    }
  }

  h('Приложение 3 Источники и воспроизводимость');
  field('Код территории', snapshot.territory.key);
  field('Тип территории', translated(snapshot.territory.sourceType));
  field('Код в исходной географии', snapshot.territory.sourceCode);
  field('Редакция географии', snapshot.territory.sourceEditionId);
  field('Редакция границ', snapshot.territory.boundaryVersion);
  field('Статус географии', translated(snapshot.territory.geographicStatus));
  field('Источник географии', snapshot.territory.sourceUrl);
  p(
    'Статистические значения приведены в редакции, закреплённой при сохранении версии. Неполная первичная документация авторского набора и непроверенная сопоставимость границ сохраняются явно. Среднегодовая численность не является численностью на 1 января. Отсутствие значения не заменено нулём.',
  );
  const effectiveSeries = snapshot.statistics
    ? getEffectiveSeries([], snapshot.series, snapshot.statistics)
    : [];
  if (snapshot.statistics) {
    p(
      'Рабочая редакция показателя и редакция, ранее закреплённая в факте или сценарии, могут различаться. Обе сохранены в этом снимке; экспорт воспроизводит выбор команды и не заменяет исходные данные в расчёте автоматически.',
    );
    table(
      'Рабочие редакции на момент фиксации',
      ['Показатель', 'Выбор источника', 'Ревизия'],
      snapshot.statistics.map((head) => [
        effectiveSeries.find((series) => series.metricId === head.metricId)?.title ?? head.metricId,
        head.mode === 'team'
          ? `Редакция участников: ${head.seriesId}`
          : head.seriesId
            ? `Возвращён исходный ряд: ${head.seriesId}`
            : 'Исходный ряд отсутствует',
        String(head.revision),
      ]),
      [3, 5.5, 1.5],
    );
  }
  for (const [index, series] of snapshot.series.entries()) {
    h(`Статистический ряд ${index + 1}`, 2);
    field('Название', series.title);
    field('Идентификатор', series.id);
    field(
      'Определение измерения',
      `${series.metricId}; ${translated(series.unit)}; ${translated(series.reference)}; ${translated(series.semanticType)}; ${translated(series.valueDomain)}`,
    );
    field(
      'Происхождение и качество',
      `${translated(series.sourceKind)}; ${translated(series.provenanceStatus)}; ${translated(series.geographyComparability)}`,
    );
    field('Примечание о сопоставимости', series.comparabilityNote);
    field('Редакция данных', series.sourceEditionId);
    field('SHA256 ряда', series.fingerprint);
    if (snapshot.statistics)
      field(
        'Назначение в этом снимке',
        effectiveSeries.some(
          (current) => current.id === series.id && current.fingerprint === series.fingerprint,
        )
          ? 'Рабочая редакция показателя на момент фиксации.'
          : 'Исходная либо ранее закреплённая редакция; не является текущим выбором рабочего ряда.',
      );
    if (isTeamStatisticalSeries(series)) {
      field('Ревизия участников', series.revision);
      field('Время сохранения редакции', series.recordedAt);
      field('Источник последнего сохранения', series.sourceReference);
      field('Дата источника последнего сохранения', formatDate(series.sourceDate));
      field('Основание последнего сохранения', series.reason);
      p(
        'Источник последнего сохранения относится к изменённым в нём наблюдениям. Происхождение остальных лет сохраняется отдельно и приведено ниже; исходный авторский набор не перезаписан.',
        undefined,
        'meta',
      );
      field(
        'Территория и география',
        `${series.territoryKey}; география ${series.geographyEditionId}`,
      );
      const base = series.baseSeries;
      if (base) {
        field('Исходный ряд до уточнений', `${base.id}; SHA256 ${base.fingerprint}`);
        field('Источник исходного ряда', base.sourceUrl);
        field('Исходный файл', base.sourcePath);
        field('Исходный коммит', base.sourceCommit);
        field('SHA256 исходного файла', base.sourceSha256);
        field('Исходный территориальный ключ', base.sourceMunicipalityKey);
      } else
        p(
          'Импортированный исходный ряд для этого показателя отсутствовал. Значения добавлены участниками.',
          undefined,
          'meta',
        );
      table(
        'Исходные и используемые значения',
        ['Год', 'В исходном наборе', 'В этой редакции', 'Происхождение'],
        compareSeriesPoints(base, series).map((row) => [
          String(row.year),
          row.before.present ? formatNumber(row.before.value, 8) : 'Год отсутствует',
          row.after.present ? formatNumber(row.after.value, 8) : 'Год отсутствует',
          row.after.origin.kind === 'participant_supplied'
            ? `Участники, ревизия ${row.after.origin.revision}${row.change === 'unchanged' ? '; значение подтверждено без изменения' : ''}`
            : 'Сохранено исходное значение',
        ]),
        [1, 2.5, 2.5, 4],
        ['center', 'right', 'right', 'left'],
      );
      for (const override of series.overrides) {
        h(`Происхождение уточнения за ${override.year} год`, 3);
        field('Используемое значение', formatNumber(override.value, 8));
        field('Источник этого наблюдения', override.sourceReference);
        field('Дата источника этого наблюдения', formatDate(override.sourceDate));
        field('Обоснование уточнения', override.reason);
        field('Редакция и время внесения', `${override.revision}; ${override.updatedAt}`);
      }
    } else {
      field('Источник', series.sourceUrl);
      field('Файл', series.sourcePath);
      field('Коммит', series.sourceCommit);
      field('SHA256 файла', series.sourceSha256);
      field(
        'Территориальное соответствие',
        `${series.territoryKey}; исходный ключ ${series.sourceMunicipalityKey}; география ${series.geographyEditionId}`,
      );
    }
    field(
      'Агрегирование и точность',
      `${series.aggregation}; десятичных знаков ${series.decimals}`,
    );
    if (!isTeamStatisticalSeries(series))
      table(
        'Закреплённые значения ряда',
        ['Год', 'Значение'],
        series.points.map((row) => [String(row.year), formatNumber(row.value, 8)]),
        [2, 8],
        ['center', 'right'],
      );
  }
  field('Идентификатор версии', version.id);
  field('Идентификатор дорожной карты', version.roadmapId);
  field('Идентификатор занятия', version.sessionId);
  field('Название зафиксированной версии', version.title);
  field(
    'Шаблон и алгоритм',
    `${snapshot.templateVersion}; ${snapshot.calculationVersion}; ${ROADMAP_EXPORT_VERSION}`,
  );
  field('SHA256 канонического снимка', version.sha256);
  p(
    'Контрольная сумма вычисляется по точным UTF-8 байтам canonicalJson, а не по заново отформатированному JSON. Она подтверждает совпадение выгруженных данных с полученным снимком и не является электронной подписью либо экспертизой достоверности источников. Обсуждение и рецензия преподавателя хранятся отдельно от канонического снимка.',
  );
  p(
    'Формулы сценариев и правила сметы опубликованы в документации расчётного ядра roadmap-analytics-1. Для проверки сохраните JSON или архив экспорта: он включает исходный canonical.json, параметры, полные значения рядов, документальные цитаты и контрольные суммы файлов.',
  );

  const archived = snapshot.items.filter((row) => row.status === 'archived');
  if (archived.length) {
    h('Приложение 4 Архивные записи');
    p(
      'Эти записи входят в неизменяемый снимок, но не участвуют в действующем плане, финансовых итогах, сценариях и проверке комплектности. Поля сохранены полностью для аудита истории.',
    );
    for (const item of archived) {
      h(`Архивная запись ${translated(item.kind).toLowerCase()}`, 2);
      field('Реквизиты', `${item.id}; ревизия ${item.revision}`);
      const renderValue = (value: unknown, path: string) => {
        if (Array.isArray(value)) {
          if (!value.length) field(path, 'Пустой массив');
          else value.forEach((nested, index) => renderValue(nested, `${path} ${index + 1}`));
        } else if (value !== null && typeof value === 'object')
          Object.entries(value).forEach(([key, nested]) =>
            renderValue(nested, `${path ? path + ' ' : ''}${translated(key)}`),
          );
        else
          field(
            path,
            value === null
              ? 'null'
              : typeof value === 'number'
                ? formatNumber(value, 12)
                : String(value),
          );
      };
      renderValue(item.data, '');
    }
  }
  return blocks;
}

export function roadmapJson(prepared: PreparedRoadmapExport): string {
  const { version } = prepared;
  return (
    JSON.stringify(
      {
        exportVersion: prepared.exportVersion,
        contentHash: {
          algorithm: 'SHA-256',
          encoding: 'UTF-8',
          input: 'canonicalJson exact bytes',
          value: version.sha256,
        },
        version: {
          id: version.id,
          number: version.number,
          kind: version.kind,
          title: version.title,
          createdAt: version.createdAt,
          roadmapRevision: version.roadmapRevision,
          roadmapId: version.roadmapId,
          sessionId: version.sessionId,
        },
        canonicalJson: version.canonicalJson,
        snapshot: version.snapshot,
        calculations: {
          budget: prepared.budget,
          calendar: prepared.calendar,
          scenarios: prepared.scenarios,
          readiness: prepared.readiness,
        },
        warnings: prepared.issues,
      },
      null,
      2,
    ) + '\n'
  );
}
