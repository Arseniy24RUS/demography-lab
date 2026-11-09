import { describe, expect, it } from 'vitest';
import {
  calculateCostKopecks,
  computeBudget,
  costPerUniqueFamilyKopecks,
  formatKopecks,
  kopecksToRublesInput,
  normalizeQuantity,
  parseQuantityMilli,
  parseRublesToKopecks,
} from './budget';
import type { BudgetCostInput, FundingInput } from './types';

function cost(overrides: Partial<BudgetCostInput> = {}): BudgetCostInput {
  return {
    id: 'cost1',
    activityId: 'activity1',
    year: 2027,
    title: 'Часы присмотра',
    unit: 'час',
    quantity: '240',
    unitPriceKopecks: 50000,
    periods: 6,
    cashKind: 'cash',
    priceStatus: 'estimated',
    priceSource: 'Учебное допущение',
    priceDate: null,
    ...overrides,
  };
}
function allocation(overrides: Partial<FundingInput> = {}): FundingInput {
  return {
    id: 'fund1',
    costLineId: 'cost1',
    amountKopecks: 50000000,
    status: 'confirmed',
    sourceName: 'Учебный местный бюджет',
    sourceReference: 'Проверочный документ №1',
    sourceDate: '2026-11-09',
    ...overrides,
  };
}

describe('exact money and resource estimates', () => {
  it('keeps grant applications separate from a confirmed financing gap', () => {
    const result = computeBudget(
      [cost()],
      [
        allocation(),
        allocation({
          id: 'grant',
          amountKopecks: 22000000,
          status: 'application',
          sourceName: 'Предполагаемый грант',
          sourceReference: '',
          sourceDate: null,
        }),
      ],
    );
    expect(result.totals).toEqual({
      needCashKopecks: 72000000,
      inKindKopecks: 0,
      confirmedKopecks: 50000000,
      expectedKopecks: 22000000,
      confirmedGapKopecks: 22000000,
      remainingAfterExpectedKopecks: 0,
    });
    expect(result.issues.map((item) => item.code)).toContain('CONFIRMED_FUNDING_GAP');
  });

  it('converts Russian ruble input to integer kopecks without losing cents at the safe limit', () => {
    expect(parseRublesToKopecks('720000,01')).toBe(72000001);
    expect(parseRublesToKopecks('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
    expect(formatKopecks(Number.MAX_SAFE_INTEGER).replace(/\s/gu, '')).toBe('90071992547409,91');
    expect(kopecksToRublesInput(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
    expect(normalizeQuantity('12,125')).toBe('12.125');
    expect(normalizeQuantity('12.000')).toBe('12');
    expect(() => parseRublesToKopecks('90071992547409.92')).toThrow(/диапазон/u);
  });

  it('uses explicit half-up rounding once for each completed cost line', () => {
    const vectors: Array<[string, number, number, number]> = [
      ['0.125', 1, 1, 0],
      ['0.5', 1, 1, 1],
      ['0.499', 1, 1, 0],
      ['0.125', 1, 4, 1],
      ['1.005', 100, 1, 101],
      ['2.375', 12345, 12, 351833],
    ];
    for (const [quantity, unitPriceKopecks, periods, expected] of vectors)
      expect(calculateCostKopecks({ quantity, unitPriceKopecks, periods })).toBe(expected);
    const result = computeBudget(
      [
        cost({ id: 'a', quantity: '0.5', unitPriceKopecks: 1, periods: 1 }),
        cost({ id: 'b', quantity: '0.5', unitPriceKopecks: 1, periods: 1 }),
      ],
      [],
    );
    expect(result.totals.needCashKopecks).toBe(2);
  });

  it('rejects negative amounts, scientific notation, excessive precision and unsafe intermediate results', () => {
    for (const input of ['-1', '1e3', '.5', '1.0001', '1 000', 'NaN', 'Infinity'])
      expect(() => parseQuantityMilli(input)).toThrow();
    for (const input of ['-1', '1.001', '1e5', 'Infinity'])
      expect(() => parseRublesToKopecks(input)).toThrow();
    expect(parseQuantityMilli('12,125')).toBe(12125n);
    expect(() =>
      calculateCostKopecks({
        quantity: '2',
        unitPriceKopecks: Number.MAX_SAFE_INTEGER,
        periods: 1,
      }),
    ).toThrow(/диапазон/u);
    expect(() =>
      calculateCostKopecks({ quantity: '1', unitPriceKopecks: 0.5, periods: 1 }),
    ).toThrow(/целое/u);
    expect(() => calculateCostKopecks({ quantity: '1', unitPriceKopecks: 1, periods: 0 })).toThrow(
      /периодов/u,
    );
  });

  it('keeps in-kind resources separate from cash expenses and financing', () => {
    const result = computeBudget(
      [
        cost({ quantity: '10', unitPriceKopecks: 10000, periods: 1 }),
        cost({
          id: 'room',
          cashKind: 'in_kind',
          quantity: '12',
          unitPriceKopecks: 250000,
          periods: 1,
        }),
      ],
      [],
    );
    expect(result.totals.needCashKopecks).toBe(100000);
    expect(result.totals.inKindKopecks).toBe(3000000);
    expect(result.totals.confirmedGapKopecks).toBe(100000);
    expect(() => computeBudget([cost({ cashKind: 'in_kind' })], [allocation()])).toThrow(
      /Неденежный/u,
    );
  });

  it('rejects duplicated funding or cost identifiers and allocations to a different document', () => {
    expect(() => computeBudget([cost(), cost()], [])).toThrow(/уникальны/u);
    expect(() => computeBudget([cost()], [allocation(), allocation()])).toThrow(/уникальны/u);
    expect(() => computeBudget([cost()], [allocation({ costLineId: 'another-roadmap' })])).toThrow(
      /отсутствующий/u,
    );
  });

  it('requires documented dates for confirmed prices and funds', () => {
    expect(() => computeBudget([cost({ priceStatus: 'confirmed' })], [])).toThrow(
      /источника и даты/u,
    );
    expect(() =>
      computeBudget(
        [cost({ priceStatus: 'confirmed', priceSource: 'Договор', priceDate: '2027-02-29' })],
        [],
      ),
    ).toThrow(/календарно/u);
    expect(() => computeBudget([cost()], [allocation({ sourceReference: '' })])).toThrow(
      /основание и даты/u,
    );
    expect(() => computeBudget([cost()], [allocation({ sourceDate: '2027-13-01' })])).toThrow(
      /календарно/u,
    );
  });

  it('rejects over-allocation rather than summing a transfer with the expense funded by it', () => {
    expect(() =>
      computeBudget(
        [cost()],
        [
          allocation({ amountKopecks: 72000000 }),
          allocation({ id: 'same-transfer-again', amountKopecks: 72000000 }),
        ],
      ),
    ).toThrow(/превышает/u);
    expect(() =>
      computeBudget(
        [cost()],
        [
          allocation({ amountKopecks: 72000000 }),
          allocation({ id: 'alternative-grant', status: 'application', amountKopecks: 1 }),
        ],
      ),
    ).toThrow(/превышает/u);
  });

  it('aggregates calendar years and catches overflow in the total rather than only individual rows', () => {
    const result = computeBudget([cost({ year: 2028 }), cost({ id: 'other', year: 2027 })], []);
    expect(result.years.map((item) => item.year)).toEqual([2027, 2028]);
    expect(result.totals.needCashKopecks).toBe(144000000);
    expect(() =>
      computeBudget(
        [
          cost({ quantity: '1', periods: 1, unitPriceKopecks: Number.MAX_SAFE_INTEGER }),
          cost({ id: 'one-more', quantity: '1', periods: 1, unitPriceKopecks: 1 }),
        ],
        [],
      ),
    ).toThrow(/диапазон/u);
  });

  it('does not invent a per-family price with an absent or zero denominator', () => {
    expect(costPerUniqueFamilyKopecks(72000000, null)).toBeNull();
    expect(costPerUniqueFamilyKopecks(72000000, 0)).toBeNull();
    expect(costPerUniqueFamilyKopecks(72000000, 40)).toBe(1800000);
    expect(costPerUniqueFamilyKopecks(1, 2)).toBe(1);
    expect(costPerUniqueFamilyKopecks(1, 3)).toBe(0);
    expect(() => costPerUniqueFamilyKopecks(100, -3)).toThrow(/положительным/u);
  });
});
