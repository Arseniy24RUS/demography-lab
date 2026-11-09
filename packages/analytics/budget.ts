import { ANALYTICS_VERSION, CalculationError, MAX_MONEY_KOPECKS } from './types';
import type {
  AnalysisIssue,
  BudgetAmounts,
  BudgetCostInput,
  BudgetLineResult,
  BudgetResult,
  FundingInput,
} from './types';
import { isCalendarDate } from './calendar';

const MAX_MONEY = BigInt(MAX_MONEY_KOPECKS);

function money(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CalculationError(
      'INVALID_MONEY',
      `${label}: требуется неотрицательное целое число копеек в безопасном диапазоне.`,
    );
  }
  return BigInt(value);
}
function boundedMoney(value: bigint): number {
  if (value < 0n || value > MAX_MONEY) {
    throw new CalculationError(
      'MONEY_OVERFLOW',
      'Расчётная сумма выходит за допустимый диапазон целых копеек.',
    );
  }
  return Number(value);
}

/** Accept Russian or decimal-point input, but reject exponent notation and thousands separators. */
export function parseQuantityMilli(value: string): bigint {
  if (
    typeof value !== 'string' ||
    value.length > 24 ||
    !/^(?:0|[1-9]\d*)(?:[.,]\d{1,3})?$/u.test(value.trim())
  ) {
    throw new CalculationError(
      'INVALID_QUANTITY',
      'Количество задаётся неотрицательным числом с точностью до трёх знаков после запятой.',
    );
  }
  const [whole, fraction = ''] = value.trim().replace(',', '.').split('.');
  const result = BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (result > MAX_MONEY)
    throw new CalculationError('QUANTITY_OVERFLOW', 'Количество превышает допустимый диапазон.');
  return result;
}

/** Converts entered rubles into exact kopecks. No parseFloat or floating multiplication is used. */
export function parseRublesToKopecks(value: string): number {
  if (
    typeof value !== 'string' ||
    value.length > 24 ||
    !/^(?:0|[1-9]\d*)(?:[.,]\d{1,2})?$/u.test(value.trim())
  ) {
    throw new CalculationError(
      'INVALID_RUBLES',
      'Сумма в рублях допускает не более двух знаков после запятой.',
    );
  }
  const [whole, fraction = ''] = value.trim().replace(',', '.').split('.');
  return boundedMoney(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')));
}

export function formatKopecks(value: number): string {
  const amount = money(value, 'Сумма');
  const rubles = amount / 100n;
  const fraction = String(amount % 100n).padStart(2, '0');
  return `${new Intl.NumberFormat('ru-RU').format(rubles)},${fraction}`;
}

/** Ungrouped decimal rubles for form inputs, preserving every kopeck near the safe integer bound. */
export function kopecksToRublesInput(value: number): string {
  const amount = money(value, 'Сумма');
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}

export function normalizeQuantity(value: string): string {
  const milli = parseQuantityMilli(value),
    fraction = String(milli % 1000n)
      .padStart(3, '0')
      .replace(/0+$/u, '');
  return `${milli / 1000n}${fraction ? '.' + fraction : ''}`;
}

/** Half a kopeck rounds upward; all operands remain integer throughout the calculation. */
export function calculateCostKopecks(
  input: Pick<BudgetCostInput, 'quantity' | 'unitPriceKopecks' | 'periods'>,
): number {
  if (!Number.isSafeInteger(input.periods) || input.periods < 1 || input.periods > 10000) {
    throw new CalculationError(
      'INVALID_PERIODS',
      'Число периодов должно быть целым от 1 до 10 000.',
    );
  }
  const numerator =
    parseQuantityMilli(input.quantity) *
    money(input.unitPriceKopecks, 'Цена единицы') *
    BigInt(input.periods);
  return boundedMoney((numerator + 500n) / 1000n);
}

function emptyAmounts(): BudgetAmounts {
  return {
    needCashKopecks: 0,
    inKindKopecks: 0,
    confirmedKopecks: 0,
    expectedKopecks: 0,
    confirmedGapKopecks: 0,
    remainingAfterExpectedKopecks: 0,
  };
}

function aggregate(items: BudgetAmounts[]): BudgetAmounts {
  const result = emptyAmounts();
  for (const key of Object.keys(result) as Array<keyof BudgetAmounts>) {
    result[key] = boundedMoney(items.reduce((sum, item) => sum + BigInt(item[key]), 0n));
  }
  return result;
}

/** Expected financing never reduces the gap in confirmed financing. */
export function computeBudget(costs: BudgetCostInput[], funding: FundingInput[]): BudgetResult {
  const costIds = new Set<string>();
  const fundingIds = new Set<string>();
  const issues: AnalysisIssue[] = [];
  for (const cost of costs) {
    if (!cost.id || costIds.has(cost.id))
      throw new CalculationError(
        'DUPLICATE_COST',
        'Идентификаторы расходных строк должны быть уникальны.',
      );
    costIds.add(cost.id);
    if (!Number.isInteger(cost.year) || cost.year < 1900 || cost.year > 2200)
      throw new CalculationError('INVALID_BUDGET_YEAR', 'Укажите корректный год расхода.');
    if (cost.cashKind !== 'cash' && cost.cashKind !== 'in_kind')
      throw new CalculationError(
        'INVALID_CASH_KIND',
        'Неизвестный вид денежного или неденежного расхода.',
      );
    if (cost.priceStatus !== 'confirmed' && cost.priceStatus !== 'estimated')
      throw new CalculationError('INVALID_PRICE_STATUS', 'Неизвестный статус цены.');
    if (cost.priceDate !== null && !isCalendarDate(cost.priceDate))
      throw new CalculationError(
        'INVALID_PRICE_DATE',
        'Дата основания цены должна быть календарно корректной.',
      );
    if (cost.priceStatus === 'confirmed' && (!cost.priceSource.trim() || !cost.priceDate)) {
      throw new CalculationError(
        'PRICE_EVIDENCE_REQUIRED',
        'Подтверждённая цена требует источника и даты.',
      );
    }
    if (cost.priceStatus === 'estimated')
      issues.push({
        code: 'ESTIMATED_PRICE',
        severity: 'warning',
        entityId: cost.id,
        field: 'priceStatus',
        message: 'Цена является плановым допущением; требуется проверить её основание.',
      });
  }
  const allocated = new Map<string, { confirmed: bigint; expected: bigint }>();
  for (const allocation of funding) {
    if (!allocation.id || fundingIds.has(allocation.id))
      throw new CalculationError(
        'DUPLICATE_ALLOCATION',
        'Идентификаторы распределений финансирования должны быть уникальны.',
      );
    fundingIds.add(allocation.id);
    if (!costIds.has(allocation.costLineId))
      throw new CalculationError(
        'UNKNOWN_COST',
        'Распределение финансирования ссылается на отсутствующий расход.',
      );
    if (!['confirmed', 'budget_draft', 'application', 'assumption'].includes(allocation.status))
      throw new CalculationError('INVALID_FUNDING_STATUS', 'Неизвестный статус финансирования.');
    if (allocation.sourceDate !== null && !isCalendarDate(allocation.sourceDate))
      throw new CalculationError(
        'INVALID_FUNDING_DATE',
        'Дата источника финансирования должна быть календарно корректной.',
      );
    if (
      allocation.status === 'confirmed' &&
      (!allocation.sourceReference.trim() || !allocation.sourceDate)
    ) {
      throw new CalculationError(
        'FUNDING_EVIDENCE_REQUIRED',
        'Подтверждённое финансирование требует ссылки на основание и даты.',
      );
    }
    const entry = allocated.get(allocation.costLineId) ?? { confirmed: 0n, expected: 0n };
    entry[allocation.status === 'confirmed' ? 'confirmed' : 'expected'] += money(
      allocation.amountKopecks,
      'Распределённая сумма',
    );
    allocated.set(allocation.costLineId, entry);
  }
  const lines: BudgetLineResult[] = costs.map((cost) => {
    const totalKopecks = calculateCostKopecks(cost);
    const allocation = allocated.get(cost.id) ?? { confirmed: 0n, expected: 0n };
    if (
      cost.cashKind === 'in_kind' &&
      (allocation.confirmed !== 0n || allocation.expected !== 0n)
    ) {
      throw new CalculationError(
        'IN_KIND_CASH_ALLOCATION',
        'Неденежный вклад отражается отдельно и не покрывается кассовым финансированием.',
      );
    }
    if (allocation.confirmed + allocation.expected > BigInt(totalKopecks))
      throw new CalculationError(
        'OVERALLOCATED_COST',
        'Распределённое финансирование превышает стоимость расходной строки.',
      );
    const needCashKopecks = cost.cashKind === 'cash' ? totalKopecks : 0;
    const confirmedKopecks = boundedMoney(allocation.confirmed);
    const expectedKopecks = boundedMoney(allocation.expected);
    const confirmedGapKopecks = needCashKopecks - confirmedKopecks;
    if (confirmedGapKopecks > 0)
      issues.push({
        code: 'CONFIRMED_FUNDING_GAP',
        severity: 'warning',
        entityId: cost.id,
        message: 'Расход не полностью обеспечен подтверждённым финансированием.',
      });
    return {
      id: cost.id,
      activityId: cost.activityId,
      year: cost.year,
      totalKopecks,
      needCashKopecks,
      inKindKopecks: cost.cashKind === 'in_kind' ? totalKopecks : 0,
      confirmedKopecks,
      expectedKopecks,
      confirmedGapKopecks,
      remainingAfterExpectedKopecks: confirmedGapKopecks - expectedKopecks,
    };
  });
  const years = [...new Set(lines.map((line) => line.year))]
    .sort((a, b) => a - b)
    .map((year) => ({ year, ...aggregate(lines.filter((line) => line.year === year)) }));
  return {
    algorithmVersion: ANALYTICS_VERSION,
    rounding: 'half_up_per_line',
    lines,
    years,
    totals: aggregate(lines),
    issues,
  };
}

export function costPerUniqueFamilyKopecks(
  needCashKopecks: number,
  uniqueFamilies: number | null,
): number | null {
  const cash = money(needCashKopecks, 'Денежная потребность');
  if (uniqueFamilies === null || uniqueFamilies === 0) return null;
  if (!Number.isSafeInteger(uniqueFamilies) || uniqueFamilies < 0)
    throw new CalculationError(
      'INVALID_FAMILY_DENOMINATOR',
      'Число уникальных семей должно быть положительным целым.',
    );
  const denominator = BigInt(uniqueFamilies);
  return boundedMoney((cash * 2n + denominator) / (denominator * 2n));
}
