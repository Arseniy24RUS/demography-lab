import { sha256Hex } from '../security/crypto.mjs';
import { parseRoadmapVersion } from '../roadmaps/schema';
import { passportResources } from '../roadmaps/passport-resources';
import type { FrozenRoadmapData, RoadmapBarrierGround, RoadmapVersion } from '../roadmaps/types';
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
import { parseCanonicalMunicipalSeries } from '../territories/schema';
import { verifyCanonicalSeriesFingerprint } from '../territories/series.mjs';
import type { CanonicalMunicipalSeries } from '../territories/types';
import {
  getEffectiveSeries,
  isTeamStatisticalSeries,
  provisionalObservationYears,
} from '../statistics/series';
import { calendarFigures, scenarioFigure, statisticalFigure } from './figures';
import { roadmapReportSections, availableRoadmapReportSections } from './sections';
import type { RoadmapReportOptions, RoadmapReportSection } from './sections';
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
  education: 'Обучение в ВУЗе/СУЗе',
  work: 'Работа',
  conception: 'Зачатие',
  pregnancy: 'Беременность',
  first_child: 'Первый ребёнок',
  preparation_pregnancy: 'Подготовка и беременность',
  infancy: 'Первый год',
  early_childhood: 'От 1 до 3 лет',
  preschool: 'Дошкольный период',
  school: 'Школьный период',
  next_child: 'Следующий ребёнок',
  second_child: 'Второй ребёнок',
  third_plus_child: 'Третий+ ребёнок',
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
  historical_continuation: 'Продолжение наблюдаемого тренда',
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
  return sha256Hex(bytes);
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

export async function prepareRoadmapExport(
  input: RoadmapVersion,
  options: RoadmapReportOptions = {},
): Promise<PreparedRoadmapExport> {
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
    subtitle: reportText(snapshot.territory.name),
    blocks: [],
    figures: [],
    readiness,
    budget,
    calendar,
    scenarios,
    issues: deduplicatedIssues,
  };
  const published = (snapshot.territory.level === 'organization' || (options.sections && !options.sections.includes('statistics'))
    ? []
    : (options.publishedStatistics ?? []))
    .filter(({ territoryKey }) => territoryKey === snapshot.territory.key)
    .map(parseCanonicalMunicipalSeries);
  if ((await Promise.all(published.map(verifyCanonicalSeriesFingerprint))).includes(false))
    throw new Error(
      'Опубликованный статистический ряд не прошёл проверку. Обновите страницу и повторите экспорт.',
    );
  prepared.blocks = buildReportBlocks(prepared, options, published);
  prepared.figures = prepared.blocks.flatMap((block) =>
    block.kind === 'figure' ? [block.figure] : [],
  );
  return deepFreeze(prepared);
}

function reportText(value: string | number | null | undefined): string {
  if (typeof value === 'number') return formatNumber(value);
  return (value ?? '')
    .split(/\r?\n/u)
    .filter(
      (line) =>
        !/^\s*(?:SHA[\s-]?256|закреплённый ряд|дата источника|идентификатор ряда)(?:\s|[.:]|$)/iu.test(
          line,
        ),
    )
    .map((line) =>
      line
        .replace(/https?:\/\/[^\s<>"»)\]]+/giu, '')
        .replace(/\b(?:territories-v\d+|team-statistics-v\d+)[-\w]*(?::[-\w]+)+\b/giu, '')
        .replace(/\b[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\b|\b[a-f\d]{40,64}\b/giu, '')
        .replace(/\(\s*\)|\[\s*\]|«\s*»/gu, '')
        .replace(/^[\s–:;,]+|[\s–:;,]+$/gu, ''),
    )
    .filter((line) => line && !/^(?:источник|ссылка|url)(?:[.:]|\s+)?$/iu.test(line))
    .join('\n');
}

function statisticalAnomaly(note: string): string | undefined {
  const detail = /В исходном actual (.+?)\. Это резкое несогласованное изменение/u.exec(note)?.[1];
  return (
    detail && `В исходных данных ${detail}. Сопоставимость этого участка ряда требует проверки.`
  );
}

function buildReportBlocks(
  prepared: PreparedRoadmapExport,
  options: RoadmapReportOptions,
  published: CanonicalMunicipalSeries[],
): ReportBlock[] {
  const {
    version: { snapshot },
    calendar,
    budget,
    scenarios,
  } = prepared;
  const blocks: ReportBlock[] = [];
  let content: ReportBlock[] = [];
  const heading = (text: string) => content.push({ kind: 'heading', text, level: 2 });
  const paragraph = (
    value: string | number | null | undefined,
    label?: string,
    role?: 'meta' | 'quote' | 'warning',
  ) => {
    const text = reportText(value);
    if (text)
      content.push({ kind: 'paragraph', text, label: reportText(label) || undefined, role });
  };
  const cell = (value: string | number | null | undefined) => reportText(value) || '—';
  const date = (value: string | null) => (value ? formatDate(value) : '');
  const period = (start: string | null, end: string | null) => {
    if (start && end) return `${date(start)} – ${date(end)}`;
    if (start) return `с ${date(start)}`;
    if (end) return `до ${date(end)}`;
    return '';
  };
  const table = (
    caption: string,
    titles: string[],
    rows: string[][],
    weights: number[],
    numericColumns: number[] = [],
  ) => {
    if (!rows.length) return;
    content.push({
      kind: 'table',
      caption,
      columns: titles.map((title, index) => ({
        title,
        weight: weights[index] ?? 1,
        align: numericColumns.includes(index) ? 'right' : 'left',
      })),
      rows,
    });
  };

  const passport = activeRoadmapItems(snapshot, 'passport')[0]!.data;
  const diagnosis = activeRoadmapItems(snapshot, 'diagnosis')[0]!.data;
  const monitoring = activeRoadmapItems(snapshot, 'monitoring')[0]!.data;
  const activities = activeRoadmapItems(snapshot, 'activity');
  const indicators = activeRoadmapItems(snapshot, 'indicator');
  const activityNames = new Map(activities.map(({ id, data }) => [id, data.title]));
  const indicatorNames = new Map(indicators.map(({ id, data }) => [id, data.title]));
  const objectiveNames = new Map(passport.objectives.map(({ id, title }) => [id, title]));
  const facts = activeRoadmapItems(snapshot, 'fact');
  const scenarioItems = new Map(
    activeRoadmapItems(snapshot, 'scenario').map((item) => [item.id, item]),
  );
  const allowed = new Set(availableRoadmapReportSections(snapshot.territory.level).map(({ id }) => id));
  const selected = new Set((options.sections ?? [...allowed]).filter(section => allowed.has(section)));
  const existingMetrics = new Set(
    snapshot.series.flatMap((series) =>
      !isTeamStatisticalSeries(series) || series.baseSeries ? [series.metricId] : [],
    ),
  );
  const supplements = published.filter(({ metricId }) => !existingMetrics.has(metricId));
  const statistics = snapshot.statistics
    ? getEffectiveSeries(supplements, snapshot.series, snapshot.statistics)
    : [...snapshot.series, ...supplements];
  const shownBarriers = new Set<string>();
  const printBarrier = (data: RoadmapBarrierGround) => {
    if (shownBarriers.has(data.id)) return;
    shownBarriers.add(data.id);
    paragraph(data.title, 'Барьер');
    paragraph(data.description);
    paragraph(
      data.stageIds
        .map((stage) => labels[stage])
        .filter(Boolean)
        .join(', '),
      'Жизненные этапы',
    );
    paragraph(translated(data.evidenceKind), 'Основание');
  };
  const figure = (value: PreparedRoadmapExport['figures'][number] | null | undefined) => {
    if (!value) return;
    content.push({
      kind: 'figure',
      figure: {
        ...value,
        title: reportText(value.title),
        altText: reportText(value.altText),
        primitives: value.primitives.map((primitive) =>
          primitive.kind === 'text'
            ? { ...primitive, text: reportText(primitive.text) }
            : { ...primitive },
        ),
      },
    });
  };
  const limitations = 'Сопоставимость территориальных границ в разные годы не подтверждена.';

  const render: Record<RoadmapReportSection, () => void> = {
    passport: () => {
      paragraph(passport.targetGroup, 'Целевая группа');
      paragraph(passport.partners, 'Партнёры');
      paragraph(passport.goal, 'Цель');
      table(
        'Задачи проекта',
        ['№', 'Задача'],
        passport.objectives
          .filter(({ title }) => reportText(title))
          .map(({ title }, index) => [String(index + 1), cell(title)]),
        [1, 9],
      );
      paragraph(passport.expectedResult, 'Ожидаемый результат');
    },

    diagnosis: () => {
      paragraph(diagnosis.problem, 'Проблема');
      paragraph(diagnosis.causeHypothesis, 'Гипотеза о причинах');
      paragraph(diagnosis.conclusion, 'Выводы для проекта');

      table(
        'Исходные факты',
        ['Показатель', 'Год', 'Значение', 'Единица'],
        facts
          .filter(({ data }) => data.value !== null)
          .map(({ data }) => [
            cell(data.title),
            cell(data.year?.toString()),
            cell(data.value),
            cell(translated(data.unit)),
          ]),
        [5, 1.25, 2, 1.75],
        [2],
      );
      for (const { data } of facts) {
        paragraph(data.interpretation, data.title);
        if (data.sourceKind !== 'registry') {
          paragraph(data.sourceReference, data.title);
        }
      }
      if (facts.some(({ data }) => data.sourceKind === 'external_unverified'))
        paragraph(
          'Внешние сведения приведены по материалам разработчиков проекта.',
          undefined,
          'warning',
        );

      const grounds = snapshot.basis.filter(({ status }) => status === 'active');
      if (grounds.length) heading('Барьеры и предлагаемые решения');
      for (const { material, rationale } of grounds) {
        if (material.kind === 'barrier') {
          printBarrier(material.source);
        } else if (material.kind === 'solution') {
          const solution = material.source;
          paragraph(solution.title, 'Предлагаемое решение');
          paragraph(solution.mechanism);
          paragraph(solution.targetGroup, 'Получатели');
          paragraph(solution.firstStep, 'Первый шаг');
          paragraph(solution.responsible, 'Исполнители');
          paragraph(solution.resources, 'Ресурсы');
          paragraph(solution.successIndicator, 'Признак результата');
          paragraph(solution.risks, 'Риски');
          solution.barriers.forEach(printBarrier);
        } else if (material.kind === 'factor') {
          paragraph(material.source.title, 'Предлагаемая мера');
          material.source.barriers.forEach(printBarrier);
        } else {
          const link = material.source;
          printBarrier(link.barrier);
          paragraph(link.familyTitle, 'Опыт других территорий');
          paragraph(link.explanation, 'Обоснование');
          paragraph(link.prerequisites, 'Условия применения');
        }
        paragraph(rationale, 'Значение для проекта');
      }

      const linkIds = new Set(
        grounds.flatMap(({ material }) =>
          material.kind === 'link' ? [material.source.evidenceId] : [],
        ),
      );
      for (const evidence of snapshot.evidence.filter(({ id }) => linkIds.has(id))) {
        if (reportText(evidence.title)) heading(reportText(evidence.title));
        paragraph(evidence.mechanism);
        for (const { bundle } of evidence.variants) {
          const { practice, sources, occurrences } = bundle;
          paragraph(practice.title, 'Пример меры');
          paragraph(practice.mechanism);
          paragraph(practice.eligibility, 'Получатели');
          paragraph(practice.amount, 'Размер поддержки');
          paragraph(practice.conditions?.join('\n'), 'Условия');
          const documentNames = [
            ...new Set(sources.map(({ title }) => reportText(title)).filter(Boolean)),
          ];
          paragraph(documentNames.join('\n'), 'Документы');
          const excerpts = new Set(
            occurrences.flatMap(({ anchor }) =>
              anchor.spans.map(({ prefix, exact, suffix }) =>
                [prefix, exact, suffix].filter(Boolean).join(' '),
              ),
            ),
          );
          for (const excerpt of excerpts) paragraph(excerpt, undefined, 'quote');
        }
      }
    },

    statistics: () => {
      const shown = statistics.filter((row) => row.points.some(({ value }) => value !== null));
      const publishedFingerprints = new Map(published.map(({ id, fingerprint }) => [id, fingerprint]));
      const publishedShown = shown.filter(({ id, fingerprint }) => publishedFingerprints.get(id) === fingerprint);
      if (publishedShown.length) {
        paragraph(
          publishedShown.some(({ comparabilityNote }) => comparabilityNote.includes('БДМО, выпуск'))
            ? 'Данные Базы данных показателей муниципальных образований Росстата и набора «Муниципальные компоненты».'
            : 'Опубликованный статистический набор «Муниципальные компоненты».',
          'Источник наблюдений',
        );
      }
      if (shown.some(({ geographyComparability }) => geographyComparability === 'not_verified'))
        paragraph(limitations, undefined, 'warning');
      if (shown.some(isTeamStatisticalSeries))
        paragraph(
          'Для отдельных показателей использованы сведения, уточнённые разработчиками проекта.',
        );
      for (const item of shown) {
        const title = reportText(item.title);
        if (!title) continue;
        const chart = statisticalFigure(item.id, title, translated(item.unit), item.points);
        if (chart) figure(chart);
        else {
          const point = item.points.find(({ value }) => value !== null);
          if (point)
            paragraph(
              `${point.year} г. — ${formatNumber(point.value)} ${translated(item.unit)}`,
              title,
            );
        }
        if (isTeamStatisticalSeries(item))
          paragraph(item.sourceReference, 'Сведения для уточнения показателя');
        const provisional = provisionalObservationYears(item);
        if (provisional.length)
          paragraph(
            `${title}. Предварительные сведения за ${provisional.join(', ')} гг.`,
            undefined,
            'warning',
          );
        if (!isTeamStatisticalSeries(item))
          paragraph(statisticalAnomaly(item.comparabilityNote), undefined, 'warning');
      }
    },

    forecast: () => {
      const calculated = scenarios.filter(({ result }) => result !== null);
      if (options.cohort) {
        paragraph(
          reportText(options.cohortDescription) ||
            'Численность населения рассчитана методом передвижки возрастов с учётом допущений о рождаемости, смертности и миграции.',
        );
        figure(options.cohort);
      }
      if (calculated.length) {
        paragraph(
          'Базовый сценарий описывает развитие при заданных предпосылках. Целевая траектория задаёт ориентиры проекта.',
        );
        if (
          calculated.some(({ result }) => result?.source?.geographyComparability === 'not_verified')
        )
          paragraph(limitations, undefined, 'warning');
      }
      for (const [index, { itemId, result }] of calculated.entries()) {
        const item = scenarioItems.get(itemId);
        if (!item || !result) continue;
        const title = reportText(item.data.title) || reportText(result.definition.label);
        if (!title) continue;
        heading(title);
        paragraph(item.data.assumptions, 'Предпосылки');
        paragraph(translated(result.parameters.baselineMethod), 'Метод расчёта базового сценария');
        paragraph(translated(result.definition.unit), 'Единица измерения');
        const pinned = snapshot.series.find(
          ({ id, fingerprint }) =>
            id === item.data.seriesId && fingerprint === item.data.seriesFingerprint,
        );
        if (pinned) {
          const displayed = statistics.filter(({ metricId }) => metricId === pinned.metricId);
          if (selected.has('statistics') && displayed.length && displayed.every(({ id }) => id !== pinned.id))
            paragraph(
              'Для этого прогноза использован другой набор наблюдений по показателю, чем в разделе статистики.',
            );
          if (isTeamStatisticalSeries(pinned))
            paragraph(pinned.sourceReference, 'Сведения для расчёта');
          else paragraph(statisticalAnomaly(pinned.comparabilityNote), undefined, 'warning');
        }
        const provisional = pinned ? provisionalObservationYears(pinned) : [];
        if (provisional.length)
          paragraph(
            `Предварительные наблюдения за ${provisional.join(', ')} гг.`,
            undefined,
            'warning',
          );
        for (const { code, message } of result.warnings) {
          if (
            [
              'LONG_EXTRAPOLATION_HORIZON',
              'SHORT_HISTORY_LEVEL_ONLY',
              'DOMAIN_LIMIT_APPLIED',
            ].includes(code)
          )
            paragraph(message, undefined, 'warning');
        }
        figure(scenarioFigure(`scenario-${index + 1}`, title, result, pinned?.points));
        const observed = new Map(pinned?.points.map(({ year, value }) => [year, value]));
        table(
          'Значения по годам',
          ['Год', 'Наблюдения', 'Базовый сценарий', 'Целевая траектория'],
          result.years.map((year) => [
            String(year.year),
            cell(observed.has(year.year) ? observed.get(year.year) : year.observedValue),
            cell(year.baselineValue),
            cell(year.targetValue),
          ]),
          [1.2, 2.6, 3.1, 3.1],
          [1, 2, 3],
        );
      }
    },

    indicators: () => {
      for (const { data } of indicators) {
        const title = reportText(data.title);
        if (title) heading(title);
        paragraph(data.definition);
        paragraph(translated(data.unit), 'Единица измерения');
        paragraph(data.numeratorDefinition, 'Числитель');
        paragraph(data.denominatorDefinition, 'Знаменатель');
        const baseline =
          data.baselineValue === null
            ? []
            : [[cell(data.baselineYear?.toString()), cell(data.baselineValue), 'Базовое']];
        const targets = [...data.annualTargets]
          .sort((a, b) => a.year - b.year)
          .map(({ year, value }) => [String(year), cell(value), 'Целевое']);
        table(
          'Базовое и целевые значения',
          ['Год', 'Значение', 'Вид значения'],
          [...baseline, ...targets],
          [2.5, 3, 4.5],
          [1],
        );
        paragraph(data.sourceReference, 'Источник сведений');
        paragraph(data.frequency, 'Периодичность');
        paragraph(data.responsible, 'Ответственный');
        paragraph(data.limitations, 'Ограничения');
      }
    },

    activities: () => {
      for (const { data } of activities) {
        const title = reportText(data.title);
        if (title) heading(title);
        paragraph(data.description);
        paragraph(
          data.objectiveId ? objectiveNames.get(data.objectiveId) : undefined,
          'Задача проекта',
        );
        paragraph(data.targetGroup, 'Целевая группа');
        paragraph(data.scale, 'Масштаб');
        paragraph(period(data.startDate, data.endDate), 'Срок');
        paragraph(translated(data.progressStatus), 'Состояние');
        paragraph(data.responsible, 'Ответственный');
        paragraph(data.partners, 'Партнёры');
        paragraph(data.deliverable, 'Результат');
        paragraph(data.completionCriterion, 'Критерий завершения');
        paragraph(
          data.indicatorIds
            .map((id) => indicatorNames.get(id))
            .filter(Boolean)
            .join('\n'),
          'Показатели',
        );
        paragraph(data.legalBasis, 'Правовое основание');
        paragraph(data.responsibleBody, 'Уполномоченный орган');
        paragraph(data.necessaryDecision, 'Необходимое решение');
      }
    },

    calendar: () => {
      table(
        'График реализации мероприятий',
        ['Мероприятие', 'Начало', 'Завершение'],
        calendar.rows.map((row) => [
          cell(row.title),
          cell(date(row.startDate)),
          cell(date(row.endDate)),
        ]),
        [5.7, 2.15, 2.15],
      );
      for (const chart of calendarFigures(calendar)) figure(chart);
    },

    resources: () => {
      const resourceRows = passportResources.flatMap(({ key, label }) =>
        reportText(passport[key]) ? [[label, cell(passport[key])]] : [],
      );
      table('Ресурсы проекта', ['Ресурс', 'Содержание'], resourceRows, [4, 6]);
      if (budget.years.length) {
        const totals = [
          ...budget.years.map(({ year, ...rest }) => ({ ...rest, label: String(year) })),
          { ...budget.totals, label: 'Итого' },
        ];
        table(
          'Потребность в средствах и её покрытие, рублей',
          ['Год', 'Потребность', 'Подтверждено', 'Ожидается', 'Остаток к покрытию'],
          totals.map((row) => [
            row.label,
            formatKopecks(row.needCashKopecks),
            formatKopecks(row.confirmedKopecks),
            formatKopecks(row.expectedKopecks),
            formatKopecks(row.remainingAfterExpectedKopecks),
          ]),
          [1.1, 2.1, 2.1, 2, 2.7],
          [1, 2, 3, 4],
        );
        if (budget.totals.inKindKopecks)
          paragraph(
            `${formatKopecks(budget.totals.inKindKopecks)} руб.`,
            'Стоимость ресурсов в натуральной форме',
          );
      }
      const costLines = new Map(budget.lines.map((line) => [line.id, line]));
      const costs = activeRoadmapItems(snapshot, 'cost');
      table(
        'Смета расходов, рублей',
        ['Статья расходов', 'Мероприятие', 'Год', 'Сумма'],
        costs.flatMap(({ id, data }) => {
          const cost = costLines.get(id);
          return cost
            ? [
                [
                  cell(data.title),
                  cell(activityNames.get(data.activityId)),
                  String(data.year),
                  formatKopecks(cost.totalKopecks),
                ],
              ]
            : [];
        }),
        [3.6, 3.3, 1.1, 2],
        [3],
      );
      const costTitles = new Map(costs.map(({ id, data }) => [id, data.title]));
      table(
        'Источники финансирования, рублей',
        ['Источник', 'Статья расходов', 'Статус', 'Сумма'],
        activeRoadmapItems(snapshot, 'funding').map(({ data }) => [
          cell(data.sourceName),
          cell(costTitles.get(data.costLineId)),
          translated(data.status),
          formatKopecks(data.amountKopecks),
        ]),
        [2.5, 3, 2.6, 1.9],
        [3],
      );
    },

    risks: () => {
      for (const { data } of activeRoadmapItems(snapshot, 'risk')) {
        const title = reportText(data.title);
        if (title) heading(title);
        paragraph(data.mitigation, 'Предупреждение риска');
        paragraph(data.owner, 'Ответственный');
        paragraph(data.trigger, 'Признак наступления');
        paragraph(data.contingency, 'Действия при наступлении');
      }
    },

    monitoring: () => {
      paragraph(monitoring.frequency, 'Периодичность');
      paragraph(monitoring.method, 'Метод');
      paragraph(monitoring.responsible, 'Ответственный');
      paragraph(date(monitoring.interimReportDate), 'Промежуточный отчёт');
      paragraph(date(monitoring.finalReportDate), 'Итоговый отчёт');
      paragraph(monitoring.qualitativeResults, 'Качественные результаты');
      paragraph(monitoring.sustainability, 'Устойчивость результатов');
    },
  };

  if (selected.has('passport')) {
    paragraph(passport.title, 'Проект', 'meta');
    paragraph(snapshot.teamNames.join(', '), 'Разработчики', 'meta');
    paragraph(period(passport.startDate, passport.endDate), 'Период реализации', 'meta');
    blocks.push(...content);
  }
  let section = 0;
  for (const { id, label } of roadmapReportSections) {
    if (!selected.has(id)) continue;
    content = [];
    render[id]();
    if (!content.length && id !== 'passport') continue;
    blocks.push({ kind: 'heading', text: `${++section} ${label}`, level: 1 }, ...content);
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
