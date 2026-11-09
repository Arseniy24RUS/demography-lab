import type { AnalysisIssue } from '../analytics/types';
import type { RoadmapSeries } from '../roadmaps/types';
import type { CanonicalMunicipalSeries, MunicipalMetricId } from '../territories/types';
import type { StatisticsHead, TeamStatisticalSeries } from './types';
import { STATISTICS_LIMITS, STATISTICS_METRIC_IDS } from './types';

const metricOrder: readonly MunicipalMetricId[] = STATISTICS_METRIC_IDS;

export const STATISTICS_METRIC_LABELS: Record<MunicipalMetricId, string> = {
  births_total: 'Число родившихся',
  deaths_total: 'Число умерших',
  pop_mid: 'Среднегодовая численность населения',
  mig_in_total: 'Число прибывших',
  mig_out_total: 'Число выбывших',
  mig_net_total: 'Миграционный прирост (убыль)',
  natural_change: 'Естественный прирост (убыль)',
};

export function isTeamStatisticalSeries(series: RoadmapSeries): series is TeamStatisticalSeries {
  return series.sourceKind === 'team_reported';
}

/** Stable within a frozen edition: uses the observation's own timestamp, not today's date. */
export function provisionalObservationYears(series: RoadmapSeries): number[] {
  if (!isTeamStatisticalSeries(series)) return [];
  return series.overrides
    .filter(
      (point) => point.value !== null && point.year >= new Date(point.updatedAt).getUTCFullYear(),
    )
    .map((point) => point.year);
}

/** Blank input is an explicit missing value. It is never converted to zero. */
export function parseObservationInput(raw: string, metricId: MunicipalMetricId): number | null {
  const input = raw.trim().replace(/^−/u, '-');
  if (!input) return null;
  const signless = input.replace(/^[+-]/u, '');
  const ungrouped = /^\d+(?:[.,]\d+)?$/u;
  const grouped = /^\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?$/u;
  if (!ungrouped.test(signless) && !grouped.test(signless))
    throw new Error(
      'Введите число: например, 12 345 или 12 345,5. Пустое поле означает отсутствие данных.',
    );
  const normalized = input.replace(/[ \u00a0\u202f]/gu, '').replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value) || Math.abs(value) > STATISTICS_LIMITS.sourceValueAbs)
    throw new Error(
      'Значение должно быть конечным числом по модулю не более 1 000 000 000 000 000.',
    );
  if (!metricOrder.includes(metricId)) throw new Error('Неизвестный исходный показатель.');
  if (value < 0 && metricId !== 'natural_change' && metricId !== 'mig_net_total')
    throw new Error('Для этого показателя отрицательное значение недопустимо.');
  if (metricId !== 'pop_mid' && !Number.isInteger(value))
    throw new Error('Число событий или перемещений должно быть целым.');
  if (
    metricId === 'pop_mid' &&
    (normalized.split('.')[1]?.length ?? 0) > STATISTICS_LIMITS.populationDecimals
  )
    throw new Error('Среднегодовая численность допускает не более шести знаков после запятой.');
  if (metricId === 'pop_mid' && normalized.includes('.')) {
    const decimal = (text: string) =>
      text
        .replace(/^[+]/u, '')
        .replace(/^(-?)0+(?=\d)/u, '$1')
        .replace(/0+$/u, '')
        .replace(/\.$/u, '');
    if (decimal(value.toFixed(6)) !== decimal(normalized) && value !== 0)
      throw new Error(
        'Точность этого числа превышает возможности числового формата. Уменьшите число значащих знаков.',
      );
  }
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Only current heads select a team edition. Referenced historical editions must never
 * become current merely because they appear later in a snapshot. Inputs belong to one room.
 */
export function getEffectiveSeries(
  imported: readonly CanonicalMunicipalSeries[],
  material: readonly RoadmapSeries[],
  heads: readonly StatisticsHead[] = [],
): RoadmapSeries[] {
  const all = [...imported, ...material];
  const territories = new Set(all.map((series) => series.territoryKey));
  if (territories.size > 1)
    throw new Error('Рабочие статистические ряды должны относиться к одной территории.');
  const originals = new Map<MunicipalMetricId, CanonicalMunicipalSeries>();
  const addOriginal = (series: CanonicalMunicipalSeries) => {
    const prior = originals.get(series.metricId);
    if (prior && (prior.id !== series.id || prior.fingerprint !== series.fingerprint))
      throw new Error(
        'Для показателя найдены разные исходные редакции. Уточните редакцию территории.',
      );
    originals.set(series.metricId, series);
  };
  for (const series of all)
    if (isTeamStatisticalSeries(series)) {
      if (series.baseSeries) addOriginal(series.baseSeries);
    } else addOriginal(series);
  const effective = new Map<MunicipalMetricId, RoadmapSeries>(originals);
  const seen = new Set<MunicipalMetricId>();
  for (const head of heads) {
    if (seen.has(head.metricId))
      throw new Error('Повторяется указатель рабочей редакции показателя.');
    seen.add(head.metricId);
    if (head.mode === 'imported') {
      const original = originals.get(head.metricId);
      if (head.seriesId !== null && head.seriesId !== original?.id)
        throw new Error(
          'Указатель восстановленных исходных данных не соответствует редакции территории.',
        );
      if (original) effective.set(head.metricId, original);
      else effective.delete(head.metricId);
      continue;
    }
    const selected = material.find((series) => series.id === head.seriesId);
    if (
      !selected ||
      !isTeamStatisticalSeries(selected) ||
      selected.metricId !== head.metricId ||
      selected.revision !== head.revision
    )
      throw new Error(
        'Материал текущей редакции статистики отсутствует или не соответствует указателю. Обновите комнату.',
      );
    effective.set(head.metricId, selected);
  }
  return metricOrder.flatMap((metricId) => {
    const series = effective.get(metricId);
    return series ? [series] : [];
  });
}

export interface StatisticsPointOrigin {
  kind: 'imported' | 'participant_supplied' | 'missing';
  sourceReference: string | null;
  sourceDate: string | null;
  reason: string | null;
  revision: number | null;
  updatedAt: string | null;
  /** Identifies an imported edition; manual origins are identified by their own revision. */
  sourceSeriesId: string | null;
}

export function statisticsPointOrigin(
  series: RoadmapSeries | null,
  year: number,
): StatisticsPointOrigin {
  const absent: StatisticsPointOrigin = {
    kind: 'missing',
    sourceReference: null,
    sourceDate: null,
    reason: null,
    revision: null,
    updatedAt: null,
    sourceSeriesId: null,
  };
  if (!series?.points.some((point) => point.year === year)) return absent;
  if (isTeamStatisticalSeries(series)) {
    const override = series.overrides.find((point) => point.year === year);
    if (override)
      return {
        kind: 'participant_supplied',
        sourceReference: override.sourceReference,
        sourceDate: override.sourceDate,
        reason: override.reason,
        revision: override.revision,
        updatedAt: override.updatedAt,
        sourceSeriesId: null,
      };
    return statisticsPointOrigin(series.baseSeries, year);
  }
  return {
    ...absent,
    kind: 'imported',
    sourceReference: series.sourceUrl,
    sourceSeriesId: series.id,
  };
}

export interface StatisticsPointState {
  present: boolean;
  value: number | null;
  origin: StatisticsPointOrigin;
}
export interface StatisticsPointDifference {
  year: number;
  before: StatisticsPointState;
  after: StatisticsPointState;
  change: 'added' | 'removed' | 'changed' | 'unchanged';
  provenanceChanged: boolean;
}

/** A missing year, an existing null and an observed zero remain three separate states. */
export function compareSeriesPoints(
  before: RoadmapSeries | null,
  after: RoadmapSeries | null,
): StatisticsPointDifference[] {
  const state = (series: RoadmapSeries | null, year: number): StatisticsPointState => {
    const point = series?.points.find((row) => row.year === year);
    return {
      present: point !== undefined,
      value: point?.value ?? null,
      origin: statisticsPointOrigin(series, year),
    };
  };
  const years = [
    ...new Set([...(before?.points ?? []), ...(after?.points ?? [])].map((row) => row.year)),
  ].sort((a, b) => a - b);
  return years.map((year) => {
    const previous = state(before, year),
      current = state(after, year);
    const change = !previous.present
      ? 'added'
      : !current.present
        ? 'removed'
        : previous.value !== current.value
          ? 'changed'
          : 'unchanged';
    return {
      year,
      before: previous,
      after: current,
      change,
      provenanceChanged: JSON.stringify(previous.origin) !== JSON.stringify(current.origin),
    };
  });
}

type BalanceMetric = 'natural_change' | 'mig_net_total';
const balances: Record<BalanceMetric, readonly [MunicipalMetricId, MunicipalMetricId]> = {
  natural_change: ['births_total', 'deaths_total'],
  mig_net_total: ['mig_in_total', 'mig_out_total'],
};
const formulas: Record<BalanceMetric, string> = {
  natural_change: 'родившиеся минус умершие',
  mig_net_total: 'прибывшие минус выбывшие',
};
export interface StatisticsBalanceIssue extends AnalysisIssue {
  year: number;
  metricId: BalanceMetric;
  actualValue: number;
  expectedValue: number;
}
export interface DerivedPointSuggestion {
  year: number;
  value: number | null;
  currentValue: number | null;
  currentPresent: boolean;
  applicable: boolean;
  differs: boolean;
  formula: string;
  operands: Array<{
    metricId: MunicipalMetricId;
    seriesId: string | null;
    fingerprint: string | null;
    value: number | null;
  }>;
}

/** Preview only. Applying a proposal requires an explicit ordinary, sourced team edit. */
export function suggestDerivedPoints(
  series: readonly RoadmapSeries[],
  metricId: BalanceMetric,
): DerivedPointSuggestion[] {
  if (new Set(series.map((row) => row.territoryKey)).size > 1)
    throw new Error('Нельзя сопоставлять компоненты разных территорий.');
  if (new Set(series.map((row) => row.metricId)).size !== series.length)
    throw new Error('Перед проверкой балансов выберите одну рабочую редакцию каждого показателя.');
  const [leftId, rightId] = balances[metricId];
  const left = series.find((row) => row.metricId === leftId),
    right = series.find((row) => row.metricId === rightId);
  const target = series.find((row) => row.metricId === metricId);
  const years = [
    ...new Set(
      [...(left?.points ?? []), ...(right?.points ?? []), ...(target?.points ?? [])].map(
        (row) => row.year,
      ),
    ),
  ].sort((a, b) => a - b);
  return years.map((year) => {
    const a = left?.points.find((point) => point.year === year)?.value ?? null;
    const b = right?.points.find((point) => point.year === year)?.value ?? null;
    const current = target?.points.find((point) => point.year === year);
    const computed = a === null || b === null ? null : a - b;
    const applicable =
      computed !== null &&
      Number.isSafeInteger(computed) &&
      Math.abs(computed) <= STATISTICS_LIMITS.sourceValueAbs;
    return {
      year,
      value: applicable ? computed : null,
      currentValue: current?.value ?? null,
      currentPresent: current !== undefined,
      applicable,
      differs: applicable && (!current || current.value !== computed),
      formula: formulas[metricId],
      operands: [
        {
          metricId: leftId,
          seriesId: left?.id ?? null,
          fingerprint: left?.fingerprint ?? null,
          value: a,
        },
        {
          metricId: rightId,
          seriesId: right?.id ?? null,
          fingerprint: right?.fingerprint ?? null,
          value: b,
        },
      ],
    };
  });
}

export function inspectStatisticalBalances(
  series: readonly RoadmapSeries[],
): StatisticsBalanceIssue[] {
  return (Object.keys(balances) as BalanceMetric[]).flatMap((metricId) =>
    suggestDerivedPoints(series, metricId).flatMap((point): StatisticsBalanceIssue[] =>
      point.applicable && point.currentValue !== null && point.value !== point.currentValue
        ? [
            {
              code: 'STATISTICS_BALANCE_MISMATCH',
              severity: 'warning',
              field: metricId,
              metricId,
              year: point.year,
              actualValue: point.currentValue,
              expectedValue: point.value!,
              message: `${point.year}: «${STATISTICS_METRIC_LABELS[metricId]}» (${point.currentValue}) не совпадает с разностью «${point.formula}» (${point.value}). Проверьте определения, периоды, границы и источники; значения автоматически не изменены.`,
            },
          ]
        : [],
    ),
  );
}
