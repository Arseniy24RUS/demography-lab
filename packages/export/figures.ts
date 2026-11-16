import { calendarDay } from '../analytics/calendar';
import type { CohortInput, CohortProjection } from '../analytics/cohort';
import type { CalendarResult, ObservationPoint, ScenarioResult } from '../analytics/types';
import type { FigurePrimitive, RoadmapFigure } from './types';

const ink = '#263545';
const muted = '#627080';
const observed = '#284F83';
const baselineColor = '#576373';
const baselineDash = [11, 7];
const target = '#27766B';
const grid = '#D8DEE4';

function svgEscape(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}
export function figureSvg(figure: RoadmapFigure): string {
  const primitives = figure.primitives
    .map((p) => {
      if (p.kind === 'line')
        return `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${p.color}" stroke-width="${p.width}"${p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : ''}${p.dashPhase ? ` stroke-dashoffset="${p.dashPhase}"` : ''}/>`;
      if (p.kind === 'rect')
        return `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" fill="${p.fill}"${p.stroke ? ` stroke="${p.stroke}"` : ''}/>`;
      if (p.kind === 'circle')
        return `<circle cx="${p.x}" cy="${p.y}" r="${p.radius}" fill="${p.fill}"/>`;
      return `<text x="${p.x}" y="${p.y}" font-size="${p.size}" fill="${p.color}" text-anchor="${p.align ?? 'start'}"${p.bold ? ' font-weight="bold"' : ''}>${svgEscape(p.text)}</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${figure.width}" height="${figure.height}" viewBox="0 0 ${figure.width} ${figure.height}" role="img"><title>${svgEscape(figure.title)}</title><desc>${svgEscape(figure.altText)}</desc><rect width="100%" height="100%" fill="white"/><g font-family="Times New Roman, Liberation Serif, serif">${primitives}</g></svg>`;
}

type ChartSeries = {
  points: readonly ObservationPoint[];
  label: string;
  color: string;
  dash?: number[];
  markers?: boolean;
};

function numberAxis(values: number[]) {
  const first = Math.min(...values);
  const last = Math.max(...values);
  const delta = last - first;
  const pad = delta > 0 ? Math.max(delta * 0.07, 1e-14) : Math.max(Math.abs(first) * 0.07, 1e-14);
  const low = first >= 0 ? Math.max(0, first - pad) : first - pad;
  const high = last < 0 ? Math.min(0, last + pad) : first === 0 && last === 0 ? 1 : last + pad;
  const rawStep = (high - low) / 5;
  const order = 10 ** Math.floor(Math.log10(rawStep));
  const step = ([1, 2, 2.5, 5, 10].find((value) => value * order >= rawStep) ?? 10) * order;
  const start = Math.floor(low / step);
  const end = Math.ceil(high / step);
  const formatter = new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: Math.max(0, Math.min(16, -Math.floor(Math.log10(step)) + 1)),
  });
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const value = (start + index) * step;
    return { value, label: formatter.format(value) };
  });
}

function shorten(value: string, limit: number): string {
  const points = [...value];
  return points.length <= limit ? value : `${points.slice(0, limit - 1).join('')}…`;
}

function timeSeriesFigure(spec: {
  id: string;
  title: string;
  kind: Exclude<RoadmapFigure['kind'], 'calendar'>;
  unit: string;
  firstYear: number;
  lastYear: number;
  cutoff?: number;
  series: readonly ChartSeries[];
  altText: string;
}): RoadmapFigure {
  const { id, title, kind, unit, firstYear, lastYear, cutoff, series, altText } = spec;
  const width = 960;
  const height = 410;
  const right = 926;
  const top = 47;
  const bottom = 321;
  const yTicks = numberAxis(
    series.flatMap((line) =>
      line.points.flatMap((point) => (point.value === null ? [] : [point.value])),
    ),
  );
  const left = Math.max(120, ...yTicks.map((row) => row.label.length * 13 + 18));
  const min = yTicks[0]!.value;
  const max = yTicks.at(-1)!.value;
  const x = (year: number) => left + ((year - firstYear) / (lastYear - firstYear)) * (right - left);
  const y = (value: number) => bottom - ((value - min) / (max - min)) * (bottom - top);
  const primitives: FigurePrimitive[] = [];
  if (cutoff !== undefined)
    primitives.push({
      kind: 'rect',
      x: x(cutoff),
      y: top,
      width: right - x(cutoff),
      height: bottom - top,
      fill: '#F3F6F8',
    });
  for (const tick of yTicks) {
    const py = y(tick.value);
    primitives.push({
      kind: 'line',
      x1: left,
      y1: py,
      x2: right,
      y2: py,
      color: tick.value === 0 ? '#87939F' : grid,
      width: tick.value === 0 ? 1.5 : 1,
    });
    primitives.push({
      kind: 'text',
      x: left - 14,
      y: py + 7,
      text: tick.label,
      size: 20,
      color: ink,
      align: 'end',
    });
  }
  const years = [firstYear, lastYear];
  if (cutoff !== undefined && years.every((year) => Math.abs(x(year) - x(cutoff)) > 58))
    years.push(cutoff);
  const yearStep = Math.max(1, Math.ceil((lastYear - firstYear) / 7));
  for (let year = firstYear + yearStep; year < lastYear; year += yearStep)
    if (years.every((labeled) => Math.abs(x(year) - x(labeled)) > 58)) years.push(year);
  for (const year of years) {
    const px = x(year);
    primitives.push({
      kind: 'line',
      x1: px,
      y1: bottom,
      x2: px,
      y2: bottom + 6,
      color: muted,
      width: 1,
    });
    primitives.push({
      kind: 'text',
      x: px,
      y: bottom + 29,
      text: String(year),
      size: 20,
      color: ink,
      align: 'middle',
    });
  }
  primitives.push({
    kind: 'text',
    x: left,
    y: 27,
    text: unit === 'persons' ? 'человек' : unit,
    size: 20,
    color: ink,
  });
  if (cutoff !== undefined) {
    const boundary = x(cutoff);
    primitives.push({
      kind: 'line',
      x1: boundary,
      y1: top,
      x2: boundary,
      y2: bottom,
      color: muted,
      width: 1.5,
      dash: [5, 6],
    });
    if (right - boundary > 285)
      primitives.push({
        kind: 'text',
        x: right,
        y: 27,
        text: 'Расчётный период',
        size: 19,
        color: ink,
        align: 'end',
      });
  }
  // Draw observations last so a confirmed value remains visible where trajectories coincide.
  for (const line of [...series].reverse()) {
    let previous: ObservationPoint | undefined;
    const dashPeriod = line.dash?.reduce((sum, length) => sum + length, 0) ?? 0;
    let dashPhase = 0;
    for (const point of line.points) {
      if (
        previous &&
        previous.value !== null &&
        point.value !== null &&
        point.year === previous.year + 1
      ) {
        const x1 = x(previous.year),
          y1 = y(previous.value),
          x2 = x(point.year),
          y2 = y(point.value);
        primitives.push({
          kind: 'line',
          x1,
          y1,
          x2,
          y2,
          color: line.color,
          width: 3,
          dash: line.dash,
          ...(dashPeriod ? { dashPhase } : {}),
        });
        // Preserve the dash pattern across adjacent year-to-year segments.
        if (dashPeriod) dashPhase = (dashPhase + Math.hypot(x2 - x1, y2 - y1)) % dashPeriod;
      } else {
        dashPhase = 0;
      }
      if (line.markers && point.value !== null)
        primitives.push({
          kind: 'circle',
          x: x(point.year),
          y: y(point.value),
          radius: 4.5,
          fill: line.color,
        });
      previous = point;
    }
  }
  series.forEach((line, index) => {
    const px = 42 + index * 305;
    primitives.push({
      kind: 'line',
      x1: px,
      y1: 386,
      x2: px + 42,
      y2: 386,
      color: line.color,
      width: 3,
      dash: line.dash,
    });
    if (line.markers)
      primitives.push({ kind: 'circle', x: px + 21, y: 386, radius: 4.5, fill: line.color });
    primitives.push({ kind: 'text', x: px + 56, y: 393, text: line.label, size: 21, color: ink });
  });
  return { id, kind, title, altText, width, height, primitives };
}

export function statisticalFigure(
  id: string,
  title: string,
  unit: string,
  points: readonly ObservationPoint[],
): RoadmapFigure | null {
  const observations = points
    .filter((point) => point.value !== null)
    .sort((a, b) => a.year - b.year);
  const firstYear = observations[0]?.year;
  const lastYear = observations.at(-1)?.year;
  if (firstYear === undefined || lastYear === undefined || firstYear === lastYear) return null;
  return timeSeriesFigure({
    id,
    title,
    kind: 'statistics',
    unit,
    firstYear,
    lastYear,
    series: [{ points: observations, label: 'Наблюдения', color: observed, markers: true }],
    altText: `Наблюдения за ${firstYear}–${lastYear} годы. Пропуски исходного ряда оставлены без линии.`,
  });
}

export function scenarioFigure(
  id: string,
  title: string,
  result: ScenarioResult,
  pinnedPoints?: readonly ObservationPoint[],
): RoadmapFigure {
  const firstYear = result.years[0]!.year;
  const lastYear = result.years.at(-1)!.year;
  const observations = pinnedPoints
    ? pinnedPoints
        .filter((point) => point.year >= firstYear && point.year <= lastYear)
        .sort((a, b) => a.year - b.year)
    : result.years.map((row) => ({ year: row.year, value: row.observedValue }));
  return timeSeriesFigure({
    id,
    title,
    kind: 'scenario',
    unit: result.definition.unit,
    firstYear,
    lastYear,
    cutoff: result.baselineYear,
    series: [
      { points: observations, label: 'Наблюдения', color: observed, markers: true },
      {
        points: result.years.map((row) => ({ year: row.year, value: row.baselineValue })),
        label: 'Базовая траектория',
        color: baselineColor,
        dash: baselineDash,
      },
      {
        points: result.years.map((row) => ({ year: row.year, value: row.targetValue })),
        label: 'Целевая траектория',
        color: target,
      },
    ],
    altText: `Наблюдения и две расчётные траектории. Опорный год ${result.baselineYear}. Базовая и целевая траектории рассчитаны до ${lastYear} года. Пропуски наблюдений оставлены без линии.`,
  });
}

export function cohortFigure(
  input: CohortInput,
  baseline: CohortProjection,
  scenario?: CohortProjection,
): RoadmapFigure {
  const observations = input.history.flatMap(({ year, population }) =>
    year < input.baseYear && population !== undefined && population !== null
      ? [{ year, value: population }]
      : [],
  );
  observations.sort((a, b) => a.year - b.year);
  observations.push({ year: input.baseYear, value: baseline.points[0]!.population });
  const series: ChartSeries[] = [
    { points: observations, label: 'Наблюдения', color: observed, markers: true },
    {
      points: baseline.points.map(({ year, population }) => ({ year, value: population })),
      label: 'Базовый прогноз',
      color: baselineColor,
      dash: baselineDash,
    },
  ];
  if (scenario)
    series.push({
      points: scenario.points.map(({ year, population }) => ({ year, value: population })),
      label: 'Сценарий участников',
      color: target,
    });
  return timeSeriesFigure({
    id: 'cohort-population',
    title: 'Прогноз численности населения',
    kind: 'cohort',
    unit: 'человек на 1 января',
    firstYear: observations[0]!.year,
    lastYear: baseline.endYear,
    cutoff: input.baseYear,
    series,
    altText: `Численность населения на 1 января. Наблюдения заканчиваются в ${input.baseYear} году. Базовый прогноз${scenario ? ' и выбранный сценарий' : ''} рассчитаны методом передвижки возрастов до ${baseline.endYear} года.`,
  });
}

export function calendarFigures(calendar: CalendarResult): RoadmapFigure[] {
  if (calendar.rows.length === 0) return [];
  const start = Math.min(...calendar.rows.map((row) => calendarDay(row.startDate)));
  const end = Math.max(...calendar.rows.map((row) => calendarDay(row.endDate)));
  const span = end - start + 1;
  const width = 960;
  const left = 320;
  const right = 930;
  const x = (day: number) => left + ((day - start) / span) * (right - left);
  const figures: RoadmapFigure[] = [];
  for (let offset = 0; offset < calendar.rows.length; offset += 10) {
    const rows = calendar.rows.slice(offset, offset + 10);
    const height = 105 + rows.length * 44;
    const primitives: FigurePrimitive[] = [];
    const firstDate = new Date(start * 86400000).toISOString().slice(0, 10);
    const lastDate = new Date(end * 86400000).toISOString().slice(0, 10);
    primitives.push({ kind: 'text', x: left, y: 28, text: firstDate, size: 19, color: muted });
    primitives.push({
      kind: 'text',
      x: right,
      y: 28,
      text: lastDate,
      size: 19,
      color: muted,
      align: 'end',
    });
    for (let tick = 0; tick <= 4; tick++) {
      const day = start + (span * tick) / 4;
      primitives.push({
        kind: 'line',
        x1: x(day),
        x2: x(day),
        y1: 40,
        y2: height - 45,
        width: 1,
        color: grid,
      });
    }
    rows.forEach((row, index) => {
      const y = 50 + index * 44;
      primitives.push({
        kind: 'text',
        x: 5,
        y: y + 19,
        text: `${offset + index + 1} ${shorten(row.title, 23)}`,
        size: 18,
        color: ink,
      });
      primitives.push({
        kind: 'rect',
        x: x(calendarDay(row.startDate)),
        y,
        width: Math.max(
          3,
          ((calendarDay(row.endDate) - calendarDay(row.startDate) + 1) / span) * (right - left),
        ),
        height: 26,
        fill: target,
      });
    });
    primitives.push({
      kind: 'text',
      x: left,
      y: height - 14,
      text: 'Календарные дни включая начало и окончание',
      size: 18,
      color: muted,
    });
    figures.push({
      id: `calendar-${offset / 10 + 1}`,
      kind: 'calendar',
      title: `Календарь мероприятий ${offset + 1}–${offset + rows.length}`,
      altText:
        'Полосы соответствуют сохранённым датам мероприятий. Полные названия, сроки и зависимости приведены в таблице календаря. Перенос зависимых мероприятий автоматически не выполняется.',
      width,
      height,
      primitives,
    });
  }
  return figures;
}
