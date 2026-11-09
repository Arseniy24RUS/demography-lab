import { calendarDay } from '../analytics/calendar';
import type { CalendarResult, ScenarioResult } from '../analytics/types';
import type { FigurePrimitive, RoadmapFigure } from './types';

const ink = '#263545';
const muted = '#627080';
const observed = '#284F83';
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
        return `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${p.color}" stroke-width="${p.width}"${p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : ''}/>`;
      if (p.kind === 'rect')
        return `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" fill="${p.fill}"${p.stroke ? ` stroke="${p.stroke}"` : ''}/>`;
      if (p.kind === 'circle')
        return `<circle cx="${p.x}" cy="${p.y}" r="${p.radius}" fill="${p.fill}"/>`;
      return `<text x="${p.x}" y="${p.y}" font-size="${p.size}" fill="${p.color}" text-anchor="${p.align ?? 'start'}"${p.bold ? ' font-weight="bold"' : ''}>${svgEscape(p.text)}</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${figure.width}" height="${figure.height}" viewBox="0 0 ${figure.width} ${figure.height}" role="img"><title>${svgEscape(figure.title)}</title><desc>${svgEscape(figure.altText)}</desc><rect width="100%" height="100%" fill="white"/><g font-family="DejaVu Sans, Arial, sans-serif">${primitives}</g></svg>`;
}

function shortNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e7 || (abs > 0 && abs < 0.01)) return value.toExponential(1).replace('e+', 'e');
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: abs < 10 ? 2 : 0 }).format(value);
}
function shorten(value: string, limit: number): string {
  const points = [...value];
  return points.length <= limit ? value : `${points.slice(0, limit - 1).join('')}…`;
}

export function scenarioFigure(id: string, title: string, result: ScenarioResult): RoadmapFigure {
  const width = 960;
  const height = 440;
  const left = 125;
  const right = width - 25;
  const top = 45;
  const bottom = 340;
  const primitives: FigurePrimitive[] = [];
  const values = result.years
    .flatMap((row) => [row.observedValue, row.baselineValue, row.targetValue])
    .filter((v): v is number => v !== null);
  let minimum = Math.min(0, ...values);
  let maximum = Math.max(0, ...values);
  if (maximum === minimum) maximum = minimum + 1;
  const pad = (maximum - minimum) * 0.06;
  if (minimum < 0) minimum -= pad;
  maximum += pad;
  const firstYear = result.years[0]!.year;
  const lastYear = result.years.at(-1)!.year;
  const px = (year: number) =>
    left + ((year - firstYear) / Math.max(1, lastYear - firstYear)) * (right - left);
  const py = (value: number) => bottom - ((value - minimum) / (maximum - minimum)) * (bottom - top);
  const boundary = px(result.baselineYear);
  primitives.push({
    kind: 'rect',
    x: boundary,
    y: top,
    width: right - boundary,
    height: bottom - top,
    fill: '#F3F7F7',
  });
  for (let tick = 0; tick <= 4; tick++) {
    const value = minimum + ((maximum - minimum) * tick) / 4;
    const y = py(value);
    primitives.push({ kind: 'line', x1: left, x2: right, y1: y, y2: y, color: grid, width: 1 });
    primitives.push({
      kind: 'text',
      x: left - 14,
      y: y + 7,
      text: shortNumber(value),
      size: 20,
      color: muted,
      align: 'end',
    });
  }
  const yearStep = Math.max(1, Math.ceil((lastYear - firstYear) / 7));
  const tickYears = new Set([firstYear, lastYear]);
  for (let year = firstYear + yearStep; year < lastYear - yearStep / 2; year += yearStep)
    tickYears.add(year);
  for (const year of [...tickYears].sort((a, b) => a - b)) {
    primitives.push({
      kind: 'line',
      x1: px(year),
      x2: px(year),
      y1: bottom,
      y2: bottom + 6,
      color: muted,
      width: 1,
    });
    primitives.push({
      kind: 'text',
      x: px(year),
      y: bottom + 30,
      text: String(year),
      size: 20,
      color: muted,
      align: 'middle',
    });
  }
  primitives.push({
    kind: 'text',
    x: left,
    y: 25,
    text: result.definition.unit === 'persons' ? 'Человек' : result.definition.unit,
    size: 20,
    color: ink,
  });
  if (right - boundary > 230)
    primitives.push({
      kind: 'text',
      x: right - 10,
      // Keep the planning-region label outside the data area: an upward target
      // can otherwise cross the text after users update their observed series.
      y: 25,
      text: 'Расчётные траектории',
      size: 18,
      color: muted,
      align: 'end',
    });
  primitives.push({
    kind: 'line',
    x1: boundary,
    x2: boundary,
    y1: top,
    y2: bottom,
    color: muted,
    width: 1.5,
    dash: [6, 6],
  });
  const series = [
    { key: 'observedValue', color: observed, dash: undefined },
    { key: 'baselineValue', color: '#697381', dash: [10, 7] },
    { key: 'targetValue', color: target, dash: undefined },
  ] as const;
  for (const line of series) {
    let previous: { year: number; value: number } | null = null;
    for (const row of result.years) {
      const value = row[line.key];
      if (value === null) {
        previous = null;
        continue;
      }
      if (previous !== null && row.year === previous.year + 1)
        primitives.push({
          kind: 'line',
          x1: px(previous.year),
          x2: px(row.year),
          y1: py(previous.value),
          y2: py(value),
          color: line.color,
          width: 3.4,
          dash: line.dash ? [...line.dash] : undefined,
        });
      if (line.key === 'observedValue')
        primitives.push({
          kind: 'circle',
          x: px(row.year),
          y: py(value),
          radius: 4.5,
          fill: line.color,
        });
      previous = { year: row.year, value };
    }
  }
  const legend = [
    { x: 125, text: 'Источник', color: observed, dash: undefined },
    { x: 380, text: 'Базовая', color: '#697381', dash: [10, 7] },
    { x: 635, text: 'Целевая', color: target, dash: undefined },
  ];
  for (const row of legend) {
    primitives.push({
      kind: 'line',
      x1: row.x,
      x2: row.x + 38,
      y1: 410,
      y2: 410,
      color: row.color,
      width: 3.5,
      dash: row.dash,
    });
    primitives.push({ kind: 'text', x: row.x + 50, y: 417, text: row.text, size: 21, color: ink });
  }
  return {
    id,
    kind: 'scenario',
    title,
    width,
    height,
    primitives,
    altText: `Исходный ряд ${firstYear}–${result.baselineYear}, базовая и целевая траектории до ${lastYear} года. Пропуски исходных значений не соединены. Значения по годам приведены в следующей таблице.`,
  };
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
