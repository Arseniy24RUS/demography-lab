import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { RoadmapSeries } from '../../../../../packages/roadmaps/types';
import type { ScenarioResult } from '../../../../../packages/analytics';
import { numeric } from './common';

export function ScenarioChart({
  series,
  result = null,
  comparisons = [],
  title,
  compact = false,
}: {
  series: RoadmapSeries;
  result?: ScenarioResult | null;
  comparisons?: Array<{ name: string; series: RoadmapSeries }>;
  title?: string;
  compact?: boolean;
}) {
  const id = useId(),
    [hover, setHover] = useState<number | null>(null);
  const container = useRef<HTMLElement>(null),
    [measuredWidth, setMeasuredWidth] = useState(880);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const next = element.getBoundingClientRect().width;
      if (next > 0) setMeasuredWidth(Math.max(240, Math.round(next)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const colors = ['#496ca5', '#7d5ea2', '#47776d'];
  const history = result?.history ?? series.points;
  const minYear = Math.min(...history.map((row) => row.year)),
    maxYear = Math.max(...history.map((row) => row.year), result?.parameters.endYear ?? 0);
  if (!Number.isFinite(minYear) || !Number.isFinite(maxYear)) return <p>Наблюдения отсутствуют.</p>;
  const actual = new Map(history.map((row) => [row.year, row.value]));
  const baseline = new Map(result?.years.map((row) => [row.year, row.baselineValue]) ?? []),
    target = new Map(result?.years.map((row) => [row.year, row.targetValue]) ?? []);
  if (result) {
    baseline.set(result.baselineYear, result.baselineObservedValue);
    target.set(result.baselineYear, result.baselineObservedValue);
  }
  const comparisonMaps = comparisons.map(
    (row) =>
      new Map(
        row.series.points
          .filter((point) => point.year >= minYear && point.year <= maxYear)
          .map((point) => [point.year, point.value]),
      ),
  );
  const values = [
    ...actual.values(),
    ...baseline.values(),
    ...target.values(),
    ...comparisonMaps.flatMap((map) => [...map.values()]),
  ].filter((value): value is number => value !== null && Number.isFinite(value));
  const min = Math.min(0, ...values),
    max = Math.max(1, ...values),
    span = max - min,
    pad = span * 0.08;
  const bottom = min < 0 ? min - pad : 0,
    top = max + pad;
  const ticks = Array.from({ length: 5 }, (_, i) => bottom + ((top - bottom) * i) / 4);
  const tickSize = compact ? 18 : 13;
  const width = measuredWidth,
    height = compact ? 290 : width < 500 ? 280 : 370;
  const left = Math.max(
      58,
      Math.max(...ticks.map((value) => numeric(value, 0).length)) * tickSize * 0.65 + 16,
    ),
    right = 24,
    head = 30,
    foot = 42,
    w = Math.max(60, width - left - right),
    h = height - head - foot;
  const x = (year: number) => left + ((year - minYear) / Math.max(1, maxYear - minYear)) * w,
    y = (value: number) => head + ((top - value) / (top - bottom)) * h;
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i);
  function path(map: Map<number, number | null>) {
    let drawing = false;
    return years
      .map((year) => {
        const value = map.get(year);
        if (value === null || value === undefined) {
          drawing = false;
          return '';
        }
        const command = drawing ? 'L' : 'M';
        drawing = true;
        return `${command}${x(year).toFixed(2)},${y(value).toFixed(2)}`;
      })
      .join(' ');
  }
  const yearSpacing = compact ? 75 : 58;
  const yearTicks = years.filter(
    (_, i) =>
      i % Math.max(1, Math.ceil(years.length / Math.max(2, Math.floor(w / yearSpacing)))) === 0,
  );
  if (yearTicks.at(-1) !== maxYear) {
    if (yearTicks.length > 1 && x(maxYear) - x(yearTicks.at(-1)!) < yearSpacing * 0.8)
      yearTicks.pop();
    yearTicks.push(maxYear);
  }
  const tooltipYear = hover ?? result?.parameters.endYear ?? history.at(-1)?.year ?? maxYear;
  return (
    <figure ref={container} className="rm-scenario-chart" data-compact={compact}>
      <figcaption>
        {title ?? series.title}
        <span>
          человек ·{' '}
          {series.reference === 'annual_average'
            ? 'среднегодовая численность'
            : 'за календарный год'}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${id}-title ${id}-desc`}
        onPointerLeave={() => setHover(null)}
      >
        <title id={`${id}-title`}>
          {series.title}: наблюдения{result ? ', базовая и целевая траектории' : ''}
        </title>
        <desc id={`${id}-desc`}>
          Пропуски наблюдений разрывают линию. Целевая траектория задаётся командой и не является
          оценкой причинного эффекта. Точные значения приведены в таблице под графиком.
        </desc>
        {result ? (
          <rect
            x={x(result.baselineYear)}
            y={head}
            width={Math.max(0, x(maxYear) - x(result.baselineYear))}
            height={h}
            fill="#f4f7fc"
          />
        ) : null}
        {ticks.map((value, i) => (
          <g key={i}>
            <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#e0e7ef" />
            <text x={left - 12} y={y(value) + 4} textAnchor="end" className="rm-chart-tick">
              {numeric(value, 0)}
            </text>
          </g>
        ))}
        {yearTicks.map((year) => (
          <text
            key={year}
            x={x(year)}
            y={height - 16}
            textAnchor="middle"
            className="rm-chart-tick"
          >
            {year}
          </text>
        ))}
        {comparisonMaps.map((map, index) => (
          <path
            key={comparisons[index]!.series.id}
            d={path(map)}
            stroke={colors[index]}
            strokeWidth={2}
            fill="none"
            strokeDasharray={index === 1 ? '2 5' : index === 2 ? '8 3 2 3' : undefined}
          />
        ))}
        <path d={path(actual)} stroke="#2464b1" strokeWidth={3.5} fill="none" />
        {history
          .filter((row): row is { year: number; value: number } => row.value !== null)
          .map((row) => (
            <circle key={row.year} cx={x(row.year)} cy={y(row.value)} r={3.2} fill="#2464b1" />
          ))}
        {result ? (
          <>
            <line
              x1={x(result.baselineYear)}
              x2={x(result.baselineYear)}
              y1={head}
              y2={height - foot}
              stroke="#9cabc0"
              strokeDasharray="3 5"
            />
            <text
              x={Math.min(width - right - 86, x(result.baselineYear) + 8)}
              y={head + 20}
              className="rm-chart-tick"
            >
              Сценарии
            </text>
            <path
              d={path(baseline)}
              stroke="#577091"
              strokeWidth={2.5}
              strokeDasharray="8 6"
              fill="none"
            />
            <path
              d={path(target)}
              stroke="#cf554e"
              strokeWidth={3}
              strokeDasharray="3 4"
              fill="none"
            />
          </>
        ) : null}
        {hover !== null ? (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={head}
            y2={height - foot}
            stroke="#879ab1"
            strokeWidth={1}
          />
        ) : null}
        {years.map((year) => (
          <rect
            key={`hit-${year}`}
            x={x(year) - w / Math.max(1, years.length - 1) / 2}
            y={head}
            width={w / Math.max(1, years.length - 1)}
            height={h}
            fill="transparent"
            onPointerEnter={() => setHover(year)}
            onPointerDown={() => setHover(year)}
          />
        ))}
      </svg>
      <div className="rm-chart-legend">
        <span>
          <i className="observed" />
          Наблюдения
        </span>
        {result ? (
          <>
            <span>
              <i className="baseline" />
              Базовый сценарий
            </span>
            <span>
              <i className="target" />
              Целевой сценарий
            </span>
          </>
        ) : null}
        {comparisons.map((row, index) => (
          <span key={row.series.id}>
            <i style={{ borderColor: colors[index], borderStyle: index ? 'dashed' : 'solid' }} />
            {row.name}
          </span>
        ))}
      </div>
      <div className="rm-chart-readout" aria-live="polite">
        <strong>{tooltipYear}</strong>
        <span>Наблюдение: {numeric(actual.get(tooltipYear), series.decimals)}</span>
        {result ? (
          <>
            <span>База: {numeric(baseline.get(tooltipYear), Math.max(3, series.decimals))}</span>
            <span>Цель: {numeric(target.get(tooltipYear), Math.max(3, series.decimals))}</span>
          </>
        ) : null}
      </div>
      <details className="rm-data-table">
        <summary>Точные значения и пропуски</summary>
        <div className="rm-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Год</th>
                <th>Наблюдение</th>
                {comparisons.map((row) => (
                  <th key={row.series.id}>{row.name}</th>
                ))}
                {result ? (
                  <>
                    <th>Базовый</th>
                    <th>Целевой</th>
                    <th>Плановый ориентир</th>
                    <th>Разрыв</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {years.map((year) => {
                const calculated = result?.years.find((row) => row.year === year);
                return (
                  <tr key={year}>
                    <th>{year}</th>
                    <td>{numeric(actual.get(year), series.decimals)}</td>
                    {comparisonMaps.map((map, index) => (
                      <td key={index}>{numeric(map.get(year), Math.max(3, series.decimals))}</td>
                    ))}
                    {result ? (
                      <>
                        <td>{numeric(baseline.get(year), Math.max(3, series.decimals))}</td>
                        <td>{numeric(target.get(year), Math.max(3, series.decimals))}</td>
                        <td>
                          {numeric(calculated?.plannedTargetValue, Math.max(3, series.decimals))}
                        </td>
                        <td>{numeric(calculated?.delta, Math.max(3, series.decimals))}</td>
                      </>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
