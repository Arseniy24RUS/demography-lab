import type { MunicipalMetricId, RegionStatisticsPack } from '../territories/types';
import type { RoadmapSeries } from '../roadmaps/types';
import { provisionalObservationYears } from '../statistics/series';
import { ANALYTICS_VERSION, CalculationError } from './types';
import type {
  ObservationPoint,
  ScenarioInput,
  ScenarioMetricDefinition,
  ScenarioParameters,
  ScenarioResult,
  ScenarioYear,
} from './types';

const MAX_HORIZON_YEARS = 30;

/** Adapter for the same sealed series returned by SQL and stored in a frozen roadmap version. */
export function computeCanonicalScenario(
  series: RoadmapSeries,
  parameters: ScenarioParameters,
): ScenarioResult {
  const result = computeScenario({
    definition: {
      id: series.metricId,
      label: series.title,
      definition: series.title,
      unit: series.unit,
      kind: series.semanticType,
      reference: series.reference,
      signed: series.valueDomain === 'signed',
      sourceField: series.metricId,
      sourceKind: series.sourceKind,
    },
    series: series.points,
    parameters,
    source: {
      seriesId: series.id,
      fingerprint: series.fingerprint,
      editionId: series.sourceEditionId,
      territoryKey: series.territoryKey,
      provenanceStatus: series.provenanceStatus,
      geographyComparability: series.geographyComparability,
      note: series.comparabilityNote,
    },
  });
  const provisional = provisionalObservationYears(series).filter((year) =>
    result.history.some((point) => point.year === year && point.value !== null),
  );
  if (provisional.length)
    result.warnings.push({
      code: 'CURRENT_YEAR_OBSERVATION_REQUIRES_REVIEW',
      severity: 'warning',
      message: `Наблюдения за ${provisional.join(', ')} внесены до завершения соответствующего календарного года. Проверьте полноту периода и предварительный характер сведений; прогноз не должен выдаваться за годовой факт.`,
    });
  return result;
}

function checkYear(value: number): void {
  if (!Number.isInteger(value) || value < 1900 || value > 2200)
    throw new CalculationError('INVALID_YEAR', 'Год должен быть целым в диапазоне 1900–2200.');
}

function validateSeries(points: ObservationPoint[]): ObservationPoint[] {
  const years = new Set<number>();
  for (const point of points) {
    checkYear(point.year);
    if (years.has(point.year))
      throw new CalculationError(
        'DUPLICATE_OBSERVATION_YEAR',
        'Ряд содержит неоднозначные значения одного года.',
      );
    years.add(point.year);
    if (point.value !== null && !Number.isFinite(point.value))
      throw new CalculationError(
        'INVALID_OBSERVATION',
        'Значение ряда должно быть конечным числом или явным пропуском.',
      );
  }
  return [...points].sort((a, b) => a.year - b.year);
}

/** Explicit adapter from the source pack; no unknown matching, coercion or missing-to-zero substitution. */
export function pointsFromStatisticsPack(
  pack: RegionStatisticsPack,
  territoryKey: string,
  metricId: MunicipalMetricId,
): ObservationPoint[] {
  const column = pack.columns.indexOf(metricId);
  if (column < 1)
    throw new CalculationError('UNKNOWN_METRIC', 'Показатель отсутствует в этом выпуске данных.');
  const matches = pack.series.filter((series) => series.territoryKey === territoryKey);
  if (matches.length !== 1)
    throw new CalculationError(
      'MISSING_OR_AMBIGUOUS_TERRITORY_SERIES',
      'Для территории отсутствует однозначно сопоставленный статистический ряд.',
    );
  return validateSeries(
    matches[0]!.rows.map((row) => ({ year: row[0], value: row[column] ?? null })),
  );
}

/** Suggests the latest continuous interval; the UI still displays and can select earlier gaps. */
export function suggestHistoryWindow(
  points: ObservationPoint[],
  maxYears = 10,
): { startYear: number; endYear: number; availableYears: number; linearAvailable: boolean } | null {
  if (!Number.isInteger(maxYears) || maxYears < 1 || maxYears > 50)
    throw new CalculationError(
      'INVALID_HISTORY_WINDOW',
      'Размер окна истории должен быть от 1 до 50 лет.',
    );
  const sorted = validateSeries(points);
  const available = sorted.filter(
    (point): point is ObservationPoint & { value: number } => point.value !== null,
  );
  const last = available.at(-1);
  if (!last) return null;
  const values = new Map(sorted.map((point) => [point.year, point.value]));
  let startYear = last.year;
  while (last.year - startYear + 1 < maxYears && typeof values.get(startYear - 1) === 'number')
    startYear -= 1;
  return {
    startYear,
    endYear: last.year,
    availableYears: last.year - startYear + 1,
    linearAvailable: last.year - startYear + 1 >= 5,
  };
}

function bounds(definition: ScenarioMetricDefinition): { min: number | null; max: number | null } {
  const inferred =
    definition.scale === 'percent'
      ? { min: 0, max: 100 }
      : definition.scale === 'ratio'
        ? { min: 0, max: 1 }
        : { min: definition.signed ? null : 0, max: null };
  const limits = definition.bounds ?? inferred;
  if (
    (limits.min !== null && !Number.isFinite(limits.min)) ||
    (limits.max !== null && !Number.isFinite(limits.max)) ||
    (limits.min !== null && limits.max !== null && limits.min > limits.max)
  )
    throw new CalculationError('INVALID_VALUE_DOMAIN', 'Границы показателя заданы некорректно.');
  if (
    (inferred.min !== null && (limits.min === null || limits.min < inferred.min)) ||
    (inferred.max !== null && (limits.max === null || limits.max > inferred.max))
  )
    throw new CalculationError(
      'INCOMPATIBLE_VALUE_DOMAIN',
      'Заданные границы противоречат шкале показателя.',
    );
  return limits;
}

function fitLinear(points: Array<{ year: number; value: number }>): {
  firstYear: number;
  intercept: number;
  slopePerYear: number;
} {
  const firstYear = points[0]!.year;
  const meanX = points.reduce((sum, point) => sum + point.year - firstYear, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.year - firstYear - meanX) ** 2, 0);
  const slopePerYear =
    points.reduce(
      (sum, point) => sum + (point.year - firstYear - meanX) * (point.value - meanY),
      0,
    ) / denominator;
  const intercept = meanY - slopePerYear * meanX;
  if (![intercept, slopePerYear].every(Number.isFinite))
    throw new CalculationError(
      'NONFINITE_TREND',
      'Масштаб чисел не позволяет получить конечные коэффициенты тренда.',
    );
  return { firstYear, intercept, slopePerYear };
}

export function computeScenario(input: ScenarioInput): ScenarioResult {
  const { definition, parameters: params } = input;
  for (const year of [params.historyStartYear, params.historyEndYear, params.endYear])
    checkYear(year);
  if (params.metricId !== definition.id)
    throw new CalculationError(
      'METRIC_MISMATCH',
      'Определение показателя не соответствует параметрам расчёта.',
    );
  if (
    params.historyStartYear > params.historyEndYear ||
    params.historyEndYear - params.historyStartYear > 100
  )
    throw new CalculationError(
      'INVALID_HISTORY_PERIOD',
      'Укажите упорядоченный период истории продолжительностью не более 101 года.',
    );
  if (!Number.isFinite(params.targetValue))
    throw new CalculationError('INVALID_TARGET_VALUE', 'Цель должна быть конечным числом.');
  if (!['last_value', 'linear'].includes(params.baselineMethod))
    throw new CalculationError('UNKNOWN_BASELINE_METHOD', 'Неизвестный метод базовой траектории.');
  if (
    ![
      'absolute_end',
      'relative_end',
      'annual_growth',
      'absolute_delta_end',
      'percentage_points',
    ].includes(params.targetMode)
  )
    throw new CalculationError('UNKNOWN_TARGET_MODE', 'Неизвестный способ задания цели.');
  const limits = bounds(definition);
  const sorted = validateSeries(input.series);
  const within = sorted.filter(
    (point) => point.year >= params.historyStartYear && point.year <= params.historyEndYear,
  );
  const observed = within.filter(
    (point): point is ObservationPoint & { value: number } => point.value !== null,
  );
  if (!observed.length)
    throw new CalculationError(
      'NO_AVAILABLE_HISTORY',
      'В выбранном периоде отсутствуют доступные значения показателя.',
    );
  for (const point of observed) {
    if (
      (limits.min !== null && point.value < limits.min) ||
      (limits.max !== null && point.value > limits.max)
    )
      throw new CalculationError(
        'OBSERVATION_OUT_OF_DOMAIN',
        'Исходное значение выходит за область допустимых значений показателя. Требуется проверить источник.',
      );
  }
  const first = observed[0]!,
    last = observed.at(-1)!;
  const horizonYears = params.endYear - last.year;
  if (horizonYears < 1 || horizonYears > MAX_HORIZON_YEARS)
    throw new CalculationError(
      'INVALID_SCENARIO_HORIZON',
      'Горизонт должен составлять от 1 до 30 лет после последнего доступного значения.',
    );
  const values = new Map(within.map((point) => [point.year, point.value]));
  const history = Array.from(
    { length: params.historyEndYear - params.historyStartYear + 1 },
    (_, offset) => ({
      year: params.historyStartYear + offset,
      value: values.get(params.historyStartYear + offset) ?? null,
    }),
  );
  if (
    params.baselineMethod === 'linear' &&
    (observed.length < 5 || last.year - first.year + 1 !== observed.length)
  )
    throw new CalculationError(
      'INSUFFICIENT_LINEAR_HISTORY',
      'Линейная экстраполяция требует минимум пяти последовательных лет без пропусков внутри выбранного ряда.',
    );
  const coefficients = params.baselineMethod === 'linear' ? fitLinear(observed) : null;
  const clip = (value: number): number => {
    if (!Number.isFinite(value))
      throw new CalculationError(
        'NONFINITE_SCENARIO',
        'Расчёт вышел за диапазон конечных чисел; измените параметры.',
      );
    return Math.min(limits.max ?? Infinity, Math.max(limits.min ?? -Infinity, value));
  };
  const baseline = (year: number): number =>
    coefficients
      ? coefficients.intercept + coefficients.slopePerYear * (year - coefficients.firstYear)
      : last.value;
  const percentageMode =
    params.targetMode === 'relative_end' || params.targetMode === 'annual_growth';
  if (
    percentageMode &&
    (definition.signed ||
      last.value <= 0 ||
      (params.targetMode === 'relative_end' &&
        Array.from({ length: horizonYears }, (_, i) => clip(baseline(last.year + i + 1))).some(
          (value) => value <= 0,
        )))
  )
    throw new CalculationError(
      'RELATIVE_TARGET_REQUIRES_POSITIVE_BASE',
      'Относительная цель требует положительной базы и показателя без знакопеременной интерпретации. Используйте абсолютное изменение.',
    );
  if (percentageMode && params.targetValue < -100)
    throw new CalculationError(
      'INVALID_RELATIVE_TARGET',
      'Относительное изменение ниже −100% недопустимо.',
    );
  if (params.targetMode === 'percentage_points' && definition.scale !== 'percent')
    throw new CalculationError(
      'PERCENTAGE_POINTS_REQUIRE_PERCENT',
      'Процентные пункты применимы только к показателю со шкалой от 0 до 100 процентов.',
    );
  const target = (year: number, base: number): number => {
    const fraction = (year - last.year) / horizonYears;
    switch (params.targetMode) {
      case 'absolute_end':
        return last.value + (params.targetValue - last.value) * fraction;
      case 'relative_end':
        return base * (1 + (params.targetValue / 100) * fraction);
      case 'annual_growth':
        return last.value * (1 + params.targetValue / 100) ** (year - last.year);
      case 'absolute_delta_end':
      case 'percentage_points':
        return base + params.targetValue * fraction;
    }
  };
  const endTarget = target(params.endYear, clip(baseline(params.endYear)));
  if (!Number.isFinite(endTarget))
    throw new CalculationError(
      'NONFINITE_SCENARIO',
      'Расчёт вышел за диапазон конечных чисел; измените параметры.',
    );
  if (
    (limits.min !== null && endTarget < limits.min) ||
    (limits.max !== null && endTarget > limits.max)
  )
    throw new CalculationError(
      'TARGET_OUT_OF_DOMAIN',
      'Конечная цель выходит за допустимую область показателя.',
    );
  const warnings: ScenarioResult['warnings'] = [];
  if (input.source?.provenanceStatus === 'incomplete_primary')
    warnings.push({
      code: 'INCOMPLETE_PRIMARY_PROVENANCE',
      severity: 'warning',
      message:
        'Расчёт использует авторский набор с неполной первичной документацией; официальная статистическая верификация не заявляется.',
    });
  if (input.source?.provenanceStatus === 'participant_supplied')
    warnings.push({
      code: 'PARTICIPANT_SUPPLIED_STATISTICS',
      severity: 'warning',
      message:
        'Расчёт использует рабочую редакцию статистики, введённую участниками. Источник и обоснование сохранены по изменённым годам; платформа не удостоверяет их официальную достоверность.',
    });
  if (input.source?.geographyComparability === 'not_verified')
    warnings.push({
      code: 'GEOGRAPHY_COMPARABILITY_NOT_VERIFIED',
      severity: 'warning',
      message: 'Сопоставимость территориальных границ по годам не удостоверена источником.',
    });
  if (first.year > params.historyStartYear)
    warnings.push({
      code: 'FIRST_AVAILABLE_YEAR_USED',
      severity: 'warning',
      message: `Первое доступное значение выбранного окна относится к ${first.year} году; более ранние пропуски не заполняются.`,
    });
  if (last.year < params.historyEndYear)
    warnings.push({
      code: 'LAST_AVAILABLE_YEAR_USED',
      severity: 'warning',
      message: `Вместо отсутствующих поздних значений точкой старта служит ${last.year} год.`,
    });
  if (horizonYears > 10)
    warnings.push({
      code: 'LONG_EXTRAPOLATION_HORIZON',
      severity: 'warning',
      message:
        'Горизонт превышает десять лет; простая экстраполяция особенно чувствительна к выбору предпосылок.',
    });
  if (params.baselineMethod === 'last_value' && observed.length < 5)
    warnings.push({
      code: 'SHORT_HISTORY_LEVEL_ONLY',
      severity: 'warning',
      message:
        'Короткий ряд позволяет задать условное сохранение последнего уровня; тренд по нему не оценивается.',
    });
  const years: ScenarioYear[] = [];
  for (
    let year = params.historyStartYear;
    year <= Math.max(params.historyEndYear, params.endYear);
    year += 1
  ) {
    const observedValue = values.get(year) ?? null;
    if (year < last.year || year > params.endYear) {
      years.push({
        year,
        observedValue,
        baselineValue: null,
        targetValue: null,
        plannedTargetValue: null,
        delta: null,
        baselineClipped: false,
        targetClipped: false,
      });
      continue;
    }
    if (year === last.year) {
      years.push({
        year,
        observedValue: last.value,
        baselineValue: last.value,
        targetValue: last.value,
        plannedTargetValue: last.value,
        delta: 0,
        baselineClipped: false,
        targetClipped: false,
      });
      continue;
    }
    const rawBaseline = baseline(year),
      baselineValue = clip(rawBaseline),
      rawTarget = target(year, baselineValue),
      targetValue = clip(rawTarget);
    const integerTargets = definition.integerTargets ?? definition.unit === 'persons';
    const delta = targetValue - baselineValue;
    if (!Number.isFinite(delta))
      throw new CalculationError(
        'NONFINITE_SCENARIO',
        'Разность траекторий выходит за диапазон конечных чисел.',
      );
    years.push({
      year,
      observedValue: null,
      baselineValue,
      targetValue,
      plannedTargetValue: integerTargets ? Math.round(targetValue) : targetValue,
      delta,
      baselineClipped: rawBaseline !== baselineValue,
      targetClipped: rawTarget !== targetValue,
    });
  }
  if (years.some((row) => row.baselineClipped || row.targetClipped))
    warnings.push({
      code: 'DOMAIN_LIMIT_APPLIED',
      severity: 'warning',
      message:
        'Отдельные расчётные значения ограничены допустимыми границами показателя; исходные наблюдения не изменены.',
    });
  let backtest: ScenarioResult['backtest'] = null;
  if (coefficients && observed.length >= 8) {
    const train = observed.slice(0, -2),
      validation = observed.slice(-2),
      fit = fitLinear(train),
      naive = train.at(-1)!.value;
    backtest = {
      heldOutYears: validation.map((point) => point.year),
      linearMae:
        validation.reduce(
          (sum, point) =>
            sum +
            Math.abs(
              point.value - clip(fit.intercept + fit.slopePerYear * (point.year - fit.firstYear)),
            ),
          0,
        ) / validation.length,
      lastValueMae:
        validation.reduce((sum, point) => sum + Math.abs(point.value - naive), 0) /
        validation.length,
    };
  }
  const future = years.filter((year) => year.year > last.year && year.year <= params.endYear);
  const cumulativeFlowGap =
    definition.kind === 'flow' ? future.reduce((sum, year) => sum + year.delta!, 0) : null;
  if (cumulativeFlowGap !== null && !Number.isFinite(cumulativeFlowGap))
    throw new CalculationError(
      'NONFINITE_SCENARIO',
      'Суммарная разность потоков выходит за диапазон конечных чисел.',
    );
  return {
    algorithmVersion: ANALYTICS_VERSION,
    definition: {
      ...definition,
      ...(definition.bounds ? { bounds: { ...definition.bounds } } : {}),
    },
    parameters: { ...params },
    source: input.source ? { ...input.source } : null,
    history,
    baselineYear: last.year,
    baselineObservedValue: last.value,
    horizonYears,
    trainingYears: coefficients ? observed.map((point) => point.year) : [last.year],
    years,
    coefficients,
    backtest,
    endGap: future.at(-1)!.delta!,
    cumulativeFlowGap,
    warnings,
    interpretation: 'planning_gap_not_causal_effect',
  };
}
