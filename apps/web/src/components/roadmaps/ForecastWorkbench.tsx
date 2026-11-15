import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Baby, HeartPulse, MoveHorizontal, RotateCcw, SlidersHorizontal, UsersRound } from 'lucide-react';
import { loadCohortInput } from '@/lib/cohort-data';
import type { AgeSex } from '@/lib/roadmap-demography';
import {
  projectCohorts, type CohortInput, type CohortOptions, type CohortProjection, type CohortYear,
} from '../../../../../packages/analytics/cohort';
import { formatPeople, PopulationPyramid } from './PopulationPyramid';
import './roadmap-data.css';

const metrics = [
  ['population', 'Численность', UsersRound], ['births', 'Рождения', Baby],
  ['deaths', 'Смерти', HeartPulse], ['arrivals', 'Прибытия', ArrowDownToLine],
  ['departures', 'Выбытия', ArrowUpFromLine], ['netMigration', 'Сальдо', MoveHorizontal],
] as const;
type Metric = (typeof metrics)[number][0];
type Observation = [year: number, value: number | null];
type Line = { label: string; color: string; points: Observation[]; dashed?: boolean };
const fields = [
  ['fertilityMultiplier', 'Рождаемость'], ['mortalityMultiplier', 'Смертность'],
  ['arrivalsMultiplier', 'Прибытия'], ['departuresMultiplier', 'Выбытия'],
] as const;
type PercentField = (typeof fields)[number][0];
const defaultPercentages: Record<PercentField, string> = {
  fertilityMultiplier: '100', mortalityMultiplier: '100', arrivalsMultiplier: '100', departuresMultiplier: '100',
};
const sum = (items: readonly number[]) => items.reduce((total, value) => total + value, 0);
const shortNumber = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });

function observations(input: CohortInput, metric: Metric): Observation[] {
  if (metric === 'population') {
    const actuals = input.history.map(history => [
      history.year, history.population ?? null,
    ] satisfies Observation).filter(item => item[1] !== null);
    return [...actuals.filter(([year]) => year < input.baseYear),
      [input.baseYear, sum(input.base.male) + sum(input.base.female)]];
  }
  return input.history.map(row => [row.year, metric === 'netMigration'
    ? row.arrivals !== null && row.departures !== null ? row.arrivals - row.departures : null
    : row[metric]]);
}

function future(projection: CohortProjection, observed: Observation[], metric: Metric): Observation[] {
  const anchor = observed.filter(([, value]) => value !== null).at(-1);
  const points = metric === 'population' ? projection.points.filter(row => row.year > projection.baseYear)
    : projection.points.filter(row => row.componentYear !== null);
  const values: Observation[] = points.map(row => [
    metric === 'population' ? row.year : row.componentYear!, row[metric],
  ]);
  return anchor ? [anchor, ...values] : values;
}

function ForecastChart({ label, lines, start }: { label: string; lines: Line[]; start: number }) {
  const id = useId();
  const figure = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(720);
  useLayoutEffect(() => {
    const element = figure.current;
    if (!element) return;
    const resize = () => setWidth(Math.max(248, Math.round(element.clientWidth)));
    resize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const values = lines.flatMap(line => line.points.filter((item): item is [number, number] => item[1] !== null));
  if (!values.length) return <p className="rm-demography-empty">Нет значений для выбранного показателя.</p>;
  const firstYear = Math.min(...values.map(([year]) => year));
  const lastYear = Math.max(...values.map(([year]) => year));
  const lower = Math.min(...values.map(([, value]) => value));
  const upper = Math.max(...values.map(([, value]) => value));
  const padding = (upper - lower) * .08 || Math.max(1, Math.abs(upper) * .04);
  const low = lower >= 0 ? Math.max(0, lower - padding) : lower - padding;
  const high = upper + padding;
  const height = width > 510 ? 306 : 228;
  const left = 51, right = 21, top = 16, bottom = 31;
  const x = (year: number) => left + (year - firstYear) * (width - left - right) / Math.max(1, lastYear - firstYear);
  const y = (value: number) => top + (high - value) * (height - top - bottom) / (high - low);
  const tickCount = width > 510 ? 6 : 4;
  const marks = [...new Set(Array.from({ length: tickCount }, (_, i) =>
    Math.round(firstYear + i * (lastYear - firstYear) / (tickCount - 1))))];
  function path(points: Observation[]) {
    let previous: number | null = null;
    return points.map(([year, value]) => {
      if (value === null) { previous = null; return ''; }
      const command = previous !== null && previous + 1 === year ? 'L' : 'M';
      previous = year;
      return `${command}${x(year).toFixed(1)},${y(value).toFixed(1)}`;
    }).join(' ');
  }
  return <figure className="rm-forecast-chart" ref={figure}>
    <figcaption id={id}>{label} <span>человек</span></figcaption>
    <svg role="img" aria-labelledby={id} viewBox={`0 0 ${width} ${height}`}>
      <rect x={x(start)} y={top} width={Math.max(0, x(lastYear) - x(start))} height={height - top - bottom} fill="#f0f5fc" />
      {Array.from({ length: 5 }, (_, i) => low + (high - low) * i / 4).map(value => (
        <g key={value}>
          <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#e0e8f2" strokeDasharray="3 3" />
          <text x={left - 7} y={y(value) + 4} textAnchor="end">{shortNumber.format(value)}</text>
        </g>
      ))}
      {marks.map(year => <text key={year} x={x(year)} y={height - 10} textAnchor="middle">{year}</text>)}
      {lines.map(line => (
        <g key={line.label}>
          <path d={path(line.points)} stroke={line.color} fill="none" strokeWidth="2.6" strokeLinejoin="round"
            strokeDasharray={line.dashed ? '6 5' : undefined} />
          {line.points.filter((item): item is [number, number] => item[1] !== null).slice(-1).map(([year, value]) =>
            <circle key={year} cx={x(year)} cy={y(value)} r={3.5} fill={line.color}>
              <title>{`${line.label}, ${year}: ${formatPeople(value)}`}</title>
            </circle>
          )}
        </g>
      ))}
    </svg>
    <div className="rm-forecast-legend">{lines.map(line => <span key={line.label}>
      <i aria-hidden="true" style={{ background: line.color }} />{line.label}
    </span>)}</div>
  </figure>;
}

function pyramid(point: CohortYear): AgeSex[] {
  return Array.from({ length: 17 }, (_, index) => {
    const from = index * 5;
    return [from, index === 16 ? null : from + 4,
      sum(point.male.slice(from, from + 5)), sum(point.female.slice(from, from + 5))];
  });
}

function readOptions(key: string, baseYear: number): CohortOptions {
  try {
    const item = JSON.parse(localStorage.getItem(key) ?? 'null') as CohortOptions | null;
    if (item && Number.isInteger(item.endYear) && item.endYear > baseYear && item.endYear <= 2100 &&
        fields.every(([id]) => item[id] === undefined || (Number.isFinite(item[id]) && item[id]! >= 0 && item[id]! <= 3))) return item;
  } catch { /* The calculator also works without browser storage. */ }
  return { endYear: Math.min(2050, baseYear + 30) };
}

function CohortEditor({ input, roadmapId }: { input: CohortInput; roadmapId: string }) {
  const storageKey = `dw:cohort-options:1:${roadmapId}`;
  const [options, setOptions] = useState<CohortOptions>(() => readOptions(storageKey, input.baseYear));
  const [draftYear, setDraftYear] = useState(() => String(options.endYear));
  const [percent, setPercent] = useState(() => Object.fromEntries(fields.map(([id]) =>
    [id, String(Number(((options[id] ?? 1) * 100).toFixed(8)))],
  )) as Record<PercentField, string>);
  function applyOptions(next: CohortOptions) {
    setOptions(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Storage can be unavailable. */ }
  }
  const [metric, setMetric] = useState<Metric>('population');
  const [pyramidYear, setPyramidYear] = useState<number | null>(null);
  const year = Number(draftYear);
  const valid = Number.isInteger(year) && year > input.baseYear && year <= 2100 &&
    fields.every(([id]) => percent[id].trim() !== '' && Number.isFinite(Number(percent[id])) &&
      Number(percent[id]) >= 0 && Number(percent[id]) <= 300);
  const modified = fields.some(([id]) => (options[id] ?? 1) !== 1);
  const result = useMemo(() => {
    try {
      const baseline = projectCohorts(input, { endYear: options.endYear });
      return { baseline, scenario: modified ? projectCohorts(input, options) : baseline, error: '' };
    } catch (cause) {
      return { baseline: null, scenario: null,
        error: cause instanceof Error ? cause.message : 'Не удалось построить прогноз.' };
    }
  }, [input, options, modified]);
  const actuals = observations(input, metric);
  const label = metrics.find(item => item[0] === metric)![1];
  const lines: Line[] = result.baseline && result.scenario ? [
    { label: 'Наблюдения', color: '#437fbd', points: actuals },
    { label: 'Базовый прогноз', color: '#182f60', points: future(result.baseline, actuals, metric), dashed: modified },
    ...(modified ? [{ label: 'Ваш сценарий', color: '#137f77', points: future(result.scenario, actuals, metric) }] : []),
  ] : [];
  const last = result.scenario?.points.at(-1);
  const chosenPyramid = result.scenario?.points.find(row => row.year === pyramidYear) ?? last;
  return <>
    <div className="rm-forecast-layout">
      <div className="rm-demography-panel rm-forecast-output">
        <div className="rm-metric-nav rm-forecast-metrics" role="group" aria-label="Показатели прогноза">
          {metrics.map(([key, name, Icon]) => <button className="rm-metric-button" type="button" key={key}
            aria-pressed={metric === key} onClick={() => setMetric(key)}>
            <Icon size={17} aria-hidden="true" /><span>{name}{last ? <strong>{formatPeople(last[key])}</strong> : null}</span>
          </button>)}
        </div>
        {lines.length ? <ForecastChart label={label} lines={lines} start={input.baseYear} /> : <p role="alert">{result.error}</p>}
        {last ? <div className="rm-forecast-kpi"><span>Население на 1 января {last.year} года</span><strong>{formatPeople(last.population)}</strong>
          {modified ? <small>Базовый прогноз {formatPeople(result.baseline!.points.at(-1)!.population)}</small> : null}</div> : null}
      </div>
      <form className="rm-demography-panel rm-forecast-controls" onSubmit={event => {
        event.preventDefault();
        if (valid) {
          const revised: CohortOptions = { endYear: year };
          for (const [id] of fields) revised[id] = Number(percent[id]) / 100;
          applyOptions(revised);
        }
      }}>
        <h3><SlidersHorizontal size={18} aria-hidden="true" />Параметры прогноза</h3>
        <label className="rm-field"><span>Конечный год</span>
          <input type="number" required min={input.baseYear + 1} max={2100} value={draftYear}
            onChange={event => setDraftYear(event.target.value)} />
        </label>
        <p>100% соответствует базовому прогнозу.</p>
        {fields.map(([id, name]) => <label className="rm-field rm-forecast-percent" key={id}>
          <span>{name}, %</span><input type="number" required min={0} max={300} step="any" value={percent[id]}
            onChange={event => setPercent(values => ({ ...values, [id]: event.target.value }))} />
        </label>)}
        <button type="submit" className="button button-primary" disabled={!valid}>Рассчитать</button>
        <button type="button" className="button button-quiet" onClick={() => {
          setPercent(defaultPercentages); setDraftYear(String(options.endYear)); applyOptions({ endYear: options.endYear });
        }}><RotateCcw size={15} aria-hidden="true" />Вернуть базовые значения</button>
      </form>
    </div>
    {result.scenario && chosenPyramid ? <>
      <details className="rm-demography-panel rm-forecast-expand">
        <summary>Половозрастная пирамида прогноза</summary>
        <label className="rm-field"><span>Возрастная структура на 1 января</span>
          <select value={chosenPyramid.year} onChange={event => setPyramidYear(Number(event.target.value))}>
            {result.scenario.points.map(point => <option key={point.year} value={point.year}>{point.year}</option>)}
          </select>
        </label>
        <PopulationPyramid label={`Половозрастная пирамида прогноза на ${chosenPyramid.year} год`} rows={pyramid(chosenPyramid)} />
      </details>
      <details className="rm-demography-panel rm-forecast-expand">
        <summary>Таблица прогноза по годам</summary>
        <div className="rm-data-table-scroll"><table className="rm-data-table">
          <thead><tr><th scope="col">Год событий</th><th scope="col">Численность на конец года</th>
            {metrics.slice(1).map(([id, label]) => <th scope="col" key={id}>{label}</th>)}</tr></thead>
          <tbody>{result.scenario.points.filter(point => point.componentYear !== null).map(point => <tr key={point.year}>
            <th scope="row">{point.componentYear}</th><td>{formatPeople(point.population)}</td>
            {metrics.slice(1).map(([id]) => <td key={id}>{formatPeople(point[id])}</td>)}
          </tr>)}</tbody>
        </table></div>
      </details>
    </> : null}
    <details className="rm-source-details">
      <summary>Исходные данные и метод</summary>
      <p>{input.source.summary}</p>
      <p>Возрастная структура на 1 января {input.baseYear} года. Рождения, смерти и миграция относятся к календарному году.</p>
      {input.source.notes.map(note => <p key={note}>{note}</p>)}
      <ul>{input.source.citations.map(citation => <li key={citation.url}>
        <a href={citation.url} target="_blank" rel="noreferrer">{citation.label}</a>
      </li>)}</ul>
    </details>
  </>;
}

export function ForecastWorkbench({ territoryKey, roadmapId }: { territoryKey: string; roadmapId: string }) {
  const [input, setInput] = useState<CohortInput | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    setInput(undefined);
    setError('');
    void loadCohortInput(territoryKey, request.signal).then(result => {
      if (!request.signal.aborted) setInput(result);
    }).catch(cause => {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить исходные данные.');
    });
    return () => request.abort();
  }, [territoryKey, attempt]);
  return <section className="rm-forecast" aria-label="Прогноз населения">
    <div className="rm-demography-heading"><div><h2>Прогноз населения</h2>
      {input ? <p>{input.name} · передвижка возрастов</p> : null}</div></div>
    {error ? <p role="alert">{error} <button className="button button-secondary" onClick={() => retry(value => value + 1)}>Повторить</button></p>
      : input === undefined ? <p role="status">Загружаем исходные данные…</p>
      : input === null ? <p className="rm-demography-empty">Для этой территории пока нет комплекта исходных данных для передвижки возрастов.</p>
      : <CohortEditor key={roadmapId} input={input} roadmapId={roadmapId} />}
  </section>;
}
