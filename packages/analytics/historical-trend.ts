/** Median pairwise slope is robust to isolated shocks and works with gaps in calendar years. */
export function historicalTrend(points: readonly { year: number; value: number }[]) {
  const sample = points.slice(-10);
  const anchor = sample.at(-1);
  if (!anchor) throw new Error('Отсутствуют наблюдения для продолжения ряда.');
  if (sample.length < 5) return { anchor, sample: [anchor], slope: 0 };
  const slopes = sample.flatMap((left, index) =>
    sample.slice(index + 1).map(right => (right.value - left.value) / (right.year - left.year)),
  ).sort((a, b) => a - b);
  const middle = Math.floor(slopes.length / 2);
  const slope = slopes.length % 2 === 0 ? (slopes[middle - 1]! + slopes[middle]!) / 2 : slopes[middle]!;
  return { anchor, sample, slope };
}

export const TREND_DAMPING = 0.9;

export function continueHistoricalTrend(trend: ReturnType<typeof historicalTrend>, year: number): number {
  return trend.anchor.value + trend.slope *
    (1 - TREND_DAMPING ** (year - trend.anchor.year)) / (1 - TREND_DAMPING);
}
