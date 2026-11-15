import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useFlipchart } from '../hooks/useFlipchart';
import type { SessionApi } from '../lib/session-api';
import {
  loadFactorIndex, loadMunicipalFactors, observationYears,
  type FactorIndex, type FactorMunicipality, type FactorRow, type MunicipalityLevel,
} from '../lib/municipal-factors';
import { FlipchartBoard } from './flipchart/FlipchartBoard';
import './objective-factors.css';

const pageSize = 24;
const format = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 3, signDisplay: 'exceptZero' });
const formatYearCount = new Intl.NumberFormat('ru-RU', { style: 'unit', unit: 'year', unitDisplay: 'long' });
const short = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/gu, ' ').trim());
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
};
const factorId = (release: string, municipality: string, metric: number) =>
  `${release.toLowerCase().replace(/^112_v/u, 'b-')}-${municipality}-${metric}`;

export function ObjectiveFactors({ api, sessionId, userId, regionId, editable }: {
  api: SessionApi | null; sessionId: string | null; userId: string | null;
  regionId: string | null; editable: boolean;
}) {
  const board = useFlipchart({ api, sessionId, userId, board: 'objective' });
  const [level, setLevel] = useState<MunicipalityLevel>('upper');
  const [loadedIndex, setIndex] = useState<FactorIndex | null>(null);
  const [selectedRegion, setRegion] = useState(regionId ?? '');
  const [selectedKey, setSelectedKey] = useState('');
  const [pack, setPack] = useState<{ key: string; rows: FactorRow[] } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(pageSize);
  const [view, setView] = useState<'cards' | 'board'>('cards');
  const index = loadedIndex?.level === level ? loadedIndex : null;
  const selected = index?.territories.find((t) => t.key === selectedKey);
  const regionChoices = useMemo(() => [...new Map(index?.territories.map((t) => [t.regionId, t.regionName]) ?? [])]
    .sort((a, b) => a[1].localeCompare(b[1], 'ru')), [index]);
  const effectiveRegion = regionChoices.some(([id]) => id === selectedRegion) ? selectedRegion : '';
  const local = useMemo(() => (index?.territories.filter((t) => t.regionId === effectiveRegion) ?? [])
    .sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.oktmo.localeCompare(b.oktmo)), [index, effectiveRegion]);
  const chosen = useMemo(() => new Set(board.notes.filter((n) => n.status === 'active').map((n) => n.factorKey)), [board.notes]);

  useEffect(() => {
    let active = true;
    if (!index) void loadFactorIndex(level).then((value) => {
      if (active) setIndex(value);
    }).catch(() => { if (active) setError('Не удалось загрузить каталог муниципалитетов.'); });
    return () => { active = false; };
  }, [index, level, attempt]);

  useEffect(() => {
    let active = true;
    if (index && selected) void loadMunicipalFactors(index, selected).then((rows) => {
      if (active) setPack({ key: selected.key, rows });
    }).catch(() => { if (active) setError('Не удалось загрузить корреляции выбранного муниципалитета.'); });
    return () => { active = false; };
  }, [index, selected, attempt]);

  const rows = selected && pack?.key === selected.key ? pack.rows : null;
  const search = query.toLocaleLowerCase('ru').trim();
  const visible = useMemo(() => (rows ?? []).map((row, i) => ({ row, rank: i + 1 })).filter(({ row }) => {
    if (!search || !index) return true;
    const metric = index.metrics[row[0]];
    return [metric.title, metric.sectionName, ...metric.dimensions.map(([, v]) => v)]
      .some((v) => v?.toLocaleLowerCase('ru').includes(search));
  }), [rows, search, index]);

  function openLocation(key: string) {
    setSelectedKey(key); setPack(null); setError(''); setQuery(''); setLimit(pageSize);
  }

  async function addCard(location: FactorMunicipality, row: FactorRow) {
    if (!index) return;
    const metric = index.metrics[row[0]];
    const dimensions = metric.dimensions.map(([, value]) => value).filter(Boolean).join(', ');
    const place = short(location.name, 38);
    const details = dimensions ? ` (${short(dimensions, 39)})` : '';
    const text = `${short(metric.title, 76)}${details}. ${place}. ρ ${format.format(row[4])} · ${formatYearCount.format(row[1])}`;
    await board.add('condition', text, factorId(index.sourceRelease, location.key, row[0]));
  }

  return <section className="objective-factors" aria-label="Объективные факторы рождаемости">
    <header className="objective-heading">
      <h2>Объективные факторы рождаемости</h2>
      <p>Посмотрите на рассчитанные связи и выберите карточки для обсуждения.</p>
      <div className="flipchart-view-switch" role="group" aria-label="Раздел объективных факторов">
        <button type="button" aria-pressed={view === 'cards'} onClick={() => setView('cards')}>Корреляции</button>
        <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>Флипчарт факторов · {chosen.size}</button>
      </div>
    </header>
    {view === 'board' ? <FlipchartBoard objective notes={board.notes} onVote={board.vote} onWithdraw={board.withdraw}
      pendingIds={board.pendingIds} loading={board.loading} error={board.error} /> : <>
      <div className="objective-controls">
        <label>Тип территории<select value={level} onChange={(event) => {
          setLevel(event.target.value === 'lower' ? 'lower' : 'upper');
          openLocation('');
        }}>
          <option value="upper">Округа и районы</option>
          <option value="lower">Поселения и другие территории</option>
        </select></label>
        <label>Регион<select value={effectiveRegion}
          onChange={(event) => { setRegion(event.target.value); openLocation(''); }}>
          <option value="">Выберите регион</option>
          {regionChoices.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label>Муниципалитет<select value={selectedKey} disabled={!effectiveRegion}
          onChange={(event) => openLocation(event.target.value)}>
          <option value="">Выберите муниципалитет</option>
          {local.map((item) => <option key={item.key} value={item.key}>
            {[item.name, item.munDistrict, item.oktmo].filter(Boolean).join(' · ')}
          </option>)}
        </select></label>
        {rows?.length ? <label>Показатель<input type="search" placeholder="Поиск по названию"
          value={query} onChange={(event) => { setQuery(event.target.value); setLimit(pageSize); }} /></label> : null}
      </div>
      {error ? <div className="objective-message"><p role="alert">{error}</p>
        <button type="button" className="button button-secondary" onClick={() => { setError(''); setAttempt(n => n + 1); }}>Повторить</button></div>
        : !index || (selected && !rows) ? <p role="status">Загружаем корреляции…</p>
        : selected && !visible.length ? <p>{search ? 'Показатели по запросу не найдены.' : 'Для этого муниципалитета нет рассчитанных корреляций.'}</p> : null}
      {board.error ? <p role="alert">{board.error}</p> : null}
      {index && selected && visible.length ? <>
        <p className="objective-count">{index.outcome.title}, {index.outcome.unit}. Найдено связей: {visible.length.toLocaleString('ru-RU')}.</p>
        <ol className="objective-cards">
          {visible.slice(0, limit).map(({ row, rank }) => {
            const [id, n, mask, , median, low, high] = row;
            const metric = index.metrics[id];
            const cardKey = factorId(index.sourceRelease, selected.key, id);
            const years = observationYears(index, mask);
            const added = chosen.has(cardKey);
            return <li key={id} className="objective-card">
              <span className="objective-section">{rank}. {metric.sectionName}</span>
              <h3>{metric.title}</h3>
              <p>{[...metric.dimensions.map(([, value]) => value), metric.unit, metric.period].filter(Boolean).join(' · ')}</p>
              <dl><div><dt>Байесовская корреляция</dt><dd>{format.format(median)}</dd></div>
                <div><dt>95% интервал</dt><dd>{format.format(low)} … {format.format(high)}</dd></div>
                <div><dt>Годы наблюдений</dt><dd title={years.join(', ')}>{years[0]}–{years.at(-1)} · {n}</dd></div></dl>
              <button type="button" className="button button-secondary" disabled={!added && (!editable || board.submitting || board.loading)}
                onClick={() => added ? setView('board') : void addCard(selected, row)}>{added ? 'На флипчарте' : <><Plus size={16} />На флипчарт</>}</button>
            </li>;
          })}
        </ol>
        {visible.length > limit ? <button type="button" className="button button-secondary" onClick={() => setLimit(n => n + pageSize)}>Показать ещё</button> : null}
        <p className="objective-source"><a href="https://doi.org/10.48612/tochno/bdmo" target="_blank" rel="noreferrer">БДМО · Росстат, обработка «Если быть точным»</a></p>
      </> : null}
    </>}
  </section>;
}
