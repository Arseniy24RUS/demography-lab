import { useEffect, useState } from 'react';
import type { TerritoryRecord } from '../../../../../packages/territories/types';
import {
  loadRoadmapDemography,
  type AgeSex, type AnnualMetric, type MigrationDirection, type MigrationSex, type MigrationValues,
  type RoadmapDemography, type Residence,
} from '@/lib/roadmap-demography';
import { ageLabel, formatPeople, PopulationPyramid } from './PopulationPyramid';
import { DataExport } from './DataExport';
import './roadmap-data.css';

export type DemographicView = 'pyramid' | 'migration_age' | 'migration_directions' | 'additional';
export const demographicViewLabels: Record<DemographicView, string> = {
  pyramid: 'Половозрастная структура',
  migration_age: 'Миграция по возрасту',
  migration_directions: 'Направления миграции',
  additional: 'Дополнительные показатели',
};
const residences: Record<Residence, string> = { all: 'Всё население', urban: 'Городское', rural: 'Сельское' };
const directions: Record<MigrationDirection, string> = {
  all: 'Всего', within_region: 'Внутри региона', interregional: 'Между регионами',
  international: 'Международная', within_russia: 'В пределах России',
  outside_region: 'Из-за пределов региона / за его пределы', cis: 'Со странами СНГ',
  other_international: 'С другими странами', urban_destinations: 'Городские поселения',
};
const annualMetrics: Record<AnnualMetric, { label: string; unit: string }> = {
  population_january_all: { label: 'Всё население на 1 января', unit: 'чел.' },
  population_january_urban: { label: 'Городское население на 1 января', unit: 'чел.' },
  population_january_rural: { label: 'Сельское население на 1 января', unit: 'чел.' },
  natural_reported: { label: 'Естественный прирост по БДМО', unit: 'чел.' },
  birth_rate: { label: 'Общий коэффициент рождаемости', unit: '‰' },
  death_rate: { label: 'Общий коэффициент смертности', unit: '‰' },
  natural_rate: { label: 'Коэффициент естественного прироста', unit: '‰' },
};
const recent = <T,>(values: readonly T[]) => [...new Set(values)];
const yearsDescending = (years: number[]) => recent(years).sort((a, b) => b - a);
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const empty = 'Данные для выбранного раздела по этой территории отсутствуют в выпуске БДМО.';

function YearControl({ year, years, onYear }: { year: number; years: number[]; onYear: (value: number) => void }) {
  return <label className="rm-field"><span>Год</span>
    <select value={year} onChange={event => onYear(Number(event.target.value))}>
      {years.map(value => <option key={value} value={value}>{value}</option>)}
    </select>
  </label>;
}

function FlowTable({ rows, label, title }: { rows: Array<[string, MigrationValues]>; label: string; title: string }) {
  const maximum = Math.max(1, ...rows.flatMap(([, values]) => [values[0] ?? 0, values[1] ?? 0]));
  return <div className="rm-exportable rm-exportable-table">
    <DataExport title={title} rows={[[label, 'Прибывшие, чел.', 'Выбывшие, чел.', 'Сальдо, чел.'],
      ...rows.map(([name, values]) => [name, ...values])]} />
    <div className="rm-data-table-scroll">
      <table className="rm-data-table rm-flow-table">
        <thead><tr><th scope="col">{label}</th><th scope="col">Прибывшие</th>
          <th scope="col">Выбывшие</th><th scope="col">Сальдо</th></tr></thead>
        <tbody>{rows.map(([title, [arrivals, departures, balance]]) => <tr key={title}>
          <th scope="row">{title}</th>
          <td>{formatPeople(arrivals)}<i className="rm-flow-in" aria-hidden="true" style={{ width: `${(arrivals ?? 0) / maximum * 100}%` }} /></td>
          <td>{formatPeople(departures)}<i className="rm-flow-out" aria-hidden="true" style={{ width: `${(departures ?? 0) / maximum * 100}%` }} /></td>
          <td>{formatPeople(balance)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

function Structure({ items, territoryName }: { items: RoadmapDemography['population']; territoryName: string }) {
  const [slice, setSlice] = useState<Residence>('all');
  const [chosenYear, setChosenYear] = useState<number | null>(null);
  const available = recent(items.map(item => item[1]));
  const active = available.includes(slice) ? slice : available[0];
  const years = yearsDescending(items.filter(item => item[1] === active).map(item => item[0]));
  const year = chosenYear !== null && years.includes(chosenYear) ? chosenYear : years[0];
  const selected = items.find(item => item[0] === year && item[1] === active);
  if (!selected || year === undefined) return <p className="rm-demography-empty">{empty}</p>;
  const context = `${territoryName}, на 1 января ${year} г. (${residences[active]}), чел.`;
  const values = selected[3].map(([from, to, men, women]) => ({
    from, age: ageLabel(from, to), men, women, total: men === null || women === null ? null : men + women,
  }));
  return <>
    <div className="rm-demography-heading">
      <div><h3>Половозрастная структура</h3><p>Постоянное население на 1 января, человек</p></div>
      <div className="rm-demography-controls">
        <YearControl year={year} years={years} onYear={setChosenYear} />
        {available.length > 1 ? <label className="rm-field"><span>Население</span>
          <select value={active} onChange={event => setSlice(event.target.value as Residence)}>
            {available.map(id => <option key={id} value={id}>{residences[id]}</option>)}
          </select>
        </label> : null}
      </div>
    </div>
    <PopulationPyramid label={`Половозрастная пирамида за ${year} год`} rows={selected[3]}
      exportTitle={`Половозрастная пирамида — ${context}`} />
    {selected[2] ? <p className="rm-demography-summary">Всего мужчин {formatPeople(selected[2][0])} · женщин {formatPeople(selected[2][1])}</p> : null}
    <details className="rm-pyramid-values">
      <summary>Численность по возрастным группам</summary>
      <div className="rm-exportable rm-exportable-table">
        <DataExport title={`Численность по возрастным группам — ${context}`} rows={[
          ['Возраст, лет', 'Мужчины, чел.', 'Женщины, чел.', 'Всего, чел.'],
          ...values.map(({ age, men, women, total }) => [age, men, women, total]),
        ]} />
        <div className="rm-data-table-scroll"><table className="rm-data-table">
          <thead><tr><th scope="col">Возраст, лет</th><th scope="col">Мужчины</th><th scope="col">Женщины</th><th scope="col">Всего</th></tr></thead>
          <tbody>{values.map(({ from, age, men, women, total }) => <tr key={from}>
            <th scope="row">{age}</th><td>{formatPeople(men)}</td><td>{formatPeople(women)}</td>
            <td>{formatPeople(total)}</td>
          </tr>)}</tbody>
        </table></div>
      </div>
    </details>
  </>;
}

function MigrationPyramids({ entry, year, context }: { entry?: MigrationSex; year: number; context: string }) {
  if (!entry) return <p className="rm-demography-summary">Половозрастная разбивка для этого года и направления отсутствует.</p>;
  const [, , arrivals, departures] = entry;
  const rows = [...arrivals, ...departures];
  const maximum = Math.max(1, ...rows.flatMap(row => [row[2] ?? 0, row[3] ?? 0]));
  const band = ([from, to]: AgeSex) => ageLabel(from, to);
  const bands = [...new Map(rows.map(row => [band(row), row])).values()].sort((a, b) => a[0] - b[0]);
  const compatible = bands.every(([from], index) => index === 0 || (bands[index - 1][1] ?? Infinity) < from);
  const align = (profile: AgeSex[]): AgeSex[] => {
    if (!compatible || !profile.length) return profile;
    const observed = new Map(profile.map(row => [band(row), row]));
    return bands.map(row => observed.get(band(row)) ?? [row[0], row[1], null, null]);
  };
  return <div className="rm-migration-pyramids">
    {([{ title: 'Прибывшие', rows: align(arrivals) }, { title: 'Выбывшие', rows: align(departures) }]).map(({ title, rows }) =>
      <section key={title} aria-label={title}>
        <h4>{title}</h4>
        {rows.length > 0
          ? <PopulationPyramid label={`${title} по полу и возрасту за ${year} год`} rows={rows} maximum={maximum}
              exportTitle={`${title} по полу и возрасту — ${context}`} />
          : <p className="rm-demography-summary">Половозрастная разбивка отсутствует.</p>}
      </section>
    )}
  </div>;
}

function Migration({ items, sexItems = [], byAge, territoryName }: {
  items: RoadmapDemography['migration']; sexItems?: readonly MigrationSex[]; byAge: boolean; territoryName: string;
}) {
  const [selectedDirection, setDirection] = useState<MigrationDirection>('all');
  const [selectedYear, setYear] = useState<number | null>(null);
  const relevant = items.filter(item => byAge ? item[3].length > 0 : item[2] !== null);
  const profileSelections = byAge ? [...relevant, ...sexItems] : relevant;
  const available = recent(profileSelections.map(item => item[1]));
  const direction = available.includes(selectedDirection) ? selectedDirection : available[0];
  const years = yearsDescending(profileSelections.filter(item => !byAge || item[1] === direction).map(item => item[0]));
  const year = selectedYear !== null && years.includes(selectedYear) ? selectedYear : years[0];
  if (year === undefined) return <p className="rm-demography-empty">{empty}</p>;
  const context = `${territoryName}, ${year} г.${byAge ? ` (${directions[direction]})` : ''}, чел.`;
  const title = byAge ? 'Миграция по возрасту' : 'Направления миграции';
  const yearEntries = relevant.filter(item => item[0] === year);
  const sexProfile = byAge ? sexItems.find(item => item[0] === year && item[1] === direction) : undefined;
  const ageRows = yearEntries.find(item => item[1] === direction)?.[3] ?? [];
  const rows: Array<[string, MigrationValues]> = byAge
    ? ageRows.map(([from, to, ...values]) => [ageLabel(from, to), values])
    : (Object.keys(directions) as MigrationDirection[]).flatMap(id => {
        const entry = yearEntries.find(item => item[1] === id)?.[2];
        return entry ? [[directions[id], entry]] : [];
      });
  return <>
    <div className="rm-demography-heading">
      <div><h3>{title}</h3><p>За календарный год, человек</p></div>
      <div className="rm-demography-controls">
        <YearControl year={year} years={years} onYear={setYear} />
        {byAge && available.length > 1 ? <label className="rm-field"><span>Направление</span>
          <select value={direction} onChange={event => setDirection(event.target.value as MigrationDirection)}>
            {(Object.keys(directions) as MigrationDirection[]).filter(id => available.includes(id))
              .map(id => <option key={id} value={id}>{directions[id]}</option>)}
          </select>
        </label> : null}
      </div>
    </div>
    {byAge ? <MigrationPyramids entry={sexProfile} year={year} context={context} /> : null}
    {rows.length > 0 ? <FlowTable rows={rows} label={byAge ? 'Возраст' : 'Направление'} title={`${title} — ${context}`} /> : null}
    {!byAge ? <p className="rm-demography-summary">Строки описывают пересекающиеся направления. Их итог приведён в строке «Всего», когда он опубликован.</p> : null}
  </>;
}

function Additional({ data, territoryName }: { data: RoadmapDemography['annual']; territoryName: string }) {
  const ids = (Object.keys(annualMetrics) as AnnualMetric[]).filter(id => Boolean(data[id]?.length));
  const [metric, setMetric] = useState<AnnualMetric>('population_january_all');
  const active = ids.includes(metric) ? metric : ids[0];
  const values = data[active];
  if (!values?.length) return <p className="rm-demography-empty">{empty}</p>;
  const spec = annualMetrics[active];
  const rows = [...values].reverse();
  return <>
    <div className="rm-demography-heading">
      <div><h3>Дополнительные показатели</h3><p>{spec.unit}</p></div>
      <label className="rm-field"><span>Показатель</span>
        <select value={active} onChange={event => setMetric(event.target.value as AnnualMetric)}>
          {ids.map(id => <option key={id} value={id}>{annualMetrics[id].label}</option>)}
        </select>
      </label>
    </div>
    <div className="rm-exportable rm-exportable-table">
      <DataExport title={`${spec.label} — ${territoryName}`} rows={[
        ['Год', `${spec.label}, ${spec.unit}`],
        ...rows.map(([year, value]) => [year, value]),
      ]} />
      <div className="rm-data-table-scroll">
        <table className="rm-data-table">
          <thead><tr><th scope="col">Год</th><th scope="col">{spec.label}</th></tr></thead>
          <tbody>{rows.map(([year, value]) => <tr key={year}>
            <th scope="row">{year}</th><td>{decimal.format(value)} {spec.unit}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>
  </>;
}

export function DemographicDetails({ view, territory, editionId }: {
  view: DemographicView; territory: TerritoryRecord; editionId: string;
}) {
  type Material = Awaited<ReturnType<typeof loadRoadmapDemography>>;
  const [material, setMaterial] = useState<Material | undefined>(undefined);
  const [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let current = true;
    setMaterial(undefined);
    setError('');
    void loadRoadmapDemography(territory.regionId, territory.territoryKey, editionId).then(result => {
      if (current) setMaterial(result);
    }).catch(cause => {
      if (current) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить данные БДМО.');
    });
    return () => { current = false; };
  }, [territory.regionId, territory.territoryKey, editionId, attempt]);
  return <section className="rm-demography-panel" aria-label={demographicViewLabels[view]}>
    {error ? <div role="alert"><p>{error}</p><button className="button button-secondary" onClick={() => retry(value => value + 1)}>Повторить</button></div>
      : material === undefined ? <p role="status">Загружаем данные БДМО…</p>
      : material === null ? <p className="rm-demography-empty">{empty}</p>
      : <>
          {view === 'pyramid' ? <Structure items={material.data.population} territoryName={territory.name} />
            : view === 'additional' ? <Additional data={material.data.annual} territoryName={territory.name} />
            : <Migration key={view} items={material.data.migration} sexItems={material.data.migrationSex}
                byAge={view === 'migration_age'} territoryName={territory.name} />}
          <p className="rm-source-caption">
            <a href={material.sourceUrl} target="_blank" rel="noreferrer">{material.source}</a>
            {' · '}{material.sourceVersion.replace(/^.*v(\d{4})(\d{2})(\d{2})$/u, '$3.$2.$1')}
          </p>
        </>}
  </section>;
}
