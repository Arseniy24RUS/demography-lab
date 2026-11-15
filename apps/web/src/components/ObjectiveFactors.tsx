import { useEffect, useMemo, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CircleCheck, Plus } from 'lucide-react';
import { useFlipchart } from '../hooks/useFlipchart';
import type { SessionApi } from '../lib/session-api';
import {
  loadFactorIndex, loadMunicipalFactors, loadRegionalFactors, loadSettlementParents, observationYears,
  type FactorIndex, type FactorRow, type RegionalFactors,
} from '../lib/municipal-factors';
import { FlipchartBoard } from './flipchart/FlipchartBoard';
import { ObjectiveTerritories, type ObjectiveSelection } from './ObjectiveTerritories';
import './objective-factors.css';

const batchSize = 48;
const format = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 3, signDisplay: 'exceptZero' });
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'ru');
const utf8 = new TextEncoder();
const digest = (text: string) => bytesToHex(sha256(utf8.encode(text)));
const upstream = 'https://github.com/Arseniy24RUS/Bayes-correlations-of-Russia';
const loadUpperIndex = () => loadFactorIndex('upper');
const loadLowerIndex = () => loadFactorIndex('lower');

type Card = {
  factorKey: string;
  title: string;
  value: number;
  info: string[];
  section?: string;
  interval?: readonly [number, number];
  years: number[];
};

function short(text: string, max: number) {
  const chars = Array.from(text.replace(/\s+/gu, ' ').trim());
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

function direction(value: number) {
  return value > 0 ? 'p' : value < 0 ? 'n' : 'z';
}

function municipalCards(index: FactorIndex, rows: FactorRow[]): Card[] {
  return rows.map(([id, , mask, pearson, median, low, high]) => {
    const { code, title, unit, period, dimensions, sectionName } = index.metrics[id];
    const ordered = [...dimensions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const metric = JSON.stringify([code, unit, period, ordered]);
    return {
      factorKey: `m-${digest(metric)}-${direction(median || pearson)}`,
      title, info: [...dimensions.map(([, value]) => value ?? ''), unit, period].filter(Boolean),
      section: sectionName, value: median, interval: [low, high], years: observationYears(index, mask),
    };
  });
}

function regionalCards(region?: RegionalFactors['regions'][number]): Card[] {
  return (region?.rows ?? []).map(row => ({
    factorKey: `${row.relationshipKey ?? row.key}-${direction(row.coefficient)}`,
    title: row.title, info: row.unit ? [row.unit] : [], value: row.coefficient, years: row.years,
  })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.title.localeCompare(b.title, 'ru'));
}

function useCatalog<T>(load: () => Promise<T>, enabled: boolean, retry: number) {
  const [value, setValue] = useState<T>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setFailed(false);
    void load().then(next => { if (active) setValue(next); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [enabled, load, retry]);
  return { value, failed: enabled && failed };
}

export function ObjectiveFactors({ api, sessionId, userId, regionId, editable }: {
  api: SessionApi | null; sessionId: string | null; userId: string | null; regionId: string | null; editable: boolean;
}) {
  const board = useFlipchart({ api, sessionId, userId, board: 'objective' });
  const [selection, setSelection] = useState<ObjectiveSelection>({
    level: 'region', region: regionId ?? '', municipality: '', settlement: '',
  });
  const [pack, setPack] = useState<{ key: string; rows: FactorRow[] }>();
  const [packFailed, setPackFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(batchSize);
  const [view, setView] = useState<'cards' | 'board'>('cards');
  const cursor = useRef<HTMLDivElement>(null);
  const { level, region, municipality, settlement } = selection;

  const regional = useCatalog(loadRegionalFactors, true, retry);
  const upper = useCatalog(loadUpperIndex, level === 'upper', retry);
  const lower = useCatalog(loadLowerIndex, level === 'lower', retry);
  const hierarchy = useCatalog(loadSettlementParents, level === 'lower', retry);
  const index = level === 'upper' ? upper.value : level === 'lower' ? lower.value : undefined;
  const regionalTerritory = level === 'region' ? regional.value?.regions.find(row => row.regionId === region) : undefined;
  const regions = useMemo(() => {
    const found = new Map(regional.value?.regions.map(row => [row.regionId, row.name]) ?? []);
    for (const item of index?.territories ?? []) {
      if (!found.has(item.regionId)) found.set(item.regionId, item.regionName);
    }
    return [...found].map(([id, name]) => ({ id, name })).sort(byName);
  }, [regional.value, index]);
  const parents = useMemo(() => {
    const records = level === 'lower' ? hierarchy.value?.parents : upper.value?.territories;
    return (records ?? []).filter(item => item.regionId === region).sort(byName);
  }, [level, region, hierarchy.value, upper.value]);
  const parent = level === 'lower' ? hierarchy.value?.parents.find(row => row.key === municipality && row.regionId === region) : undefined;
  const settlements = useMemo(() => {
    if (!parent || !lower.value) return [];
    const children = new Set(parent.settlementKeys);
    return lower.value.territories.filter(item => children.has(item.key)).sort(byName);
  }, [parent, lower.value]);
  const selectedMunicipality = level === 'upper' ? upper.value?.territories.find(row => row.key === municipality && row.regionId === region)
    : level === 'lower' ? settlements.find(row => row.key === settlement) : undefined;
  const selectedKey = regionalTerritory ? `region-${regionalTerritory.regionId}` : selectedMunicipality?.key;
  const activeNotes = useMemo(() => board.notes.filter(note => note.status === 'active'), [board.notes]);
  const chosen = useMemo(() => new Set(activeNotes.filter(note => selectedKey && note.territoryKeys?.includes(selectedKey))
    .map(note => note.factorKey)), [activeNotes, selectedKey]);

  useEffect(() => {
    if (!index || !selectedMunicipality) return;
    let active = true;
    setPackFailed(false);
    void loadMunicipalFactors(index, selectedMunicipality)
      .then(rows => { if (active) setPack({ key: selectedMunicipality.key, rows }); })
      .catch(() => { if (active) setPackFailed(true); });
    return () => { active = false; };
  }, [index, selectedMunicipality, retry]);

  const rows = useMemo(() => {
    if (level === 'region') return regionalCards(regionalTerritory);
    if (!index || !selectedKey || pack?.key !== selectedKey) return [];
    return municipalCards(index, pack.rows);
  }, [level, regionalTerritory, index, selectedKey, pack]);
  const search = query.toLocaleLowerCase('ru').trim();
  const visible = useMemo(() => rows.map((card, i) => ({ card, rank: i + 1 })).filter(({ card }) =>
    !search || [card.title, card.section ?? '', ...card.info].some(value => value.toLocaleLowerCase('ru').includes(search))),
  [rows, search]);

  useEffect(() => {
    if (view !== 'cards' || visible.length <= limit || !cursor.current) return;
    if (typeof IntersectionObserver === 'undefined') { setLimit(visible.length); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        setLimit(value => Math.min(value + batchSize, visible.length));
      }
    }, { rootMargin: '0px 0px 1250px 0px' });
    observer.observe(cursor.current);
    return () => observer.disconnect();
  }, [view, visible.length, limit, selectedKey, search]);

  function select(next: ObjectiveSelection) {
    setSelection(next);
    setPackFailed(false);
    setQuery('');
    setLimit(batchSize);
  }

  async function selectCard(card: Card, selected: boolean) {
    if (!selectedKey) return;
    const kind = card.factorKey.endsWith('-n') ? 'barrier' : 'condition';
    const details = card.info.filter(value => value !== 'Значение показателя за год').join(' · ');
    const text = short(card.title, 110) + (details ? ` · ${short(details, 66)}` : '');
    await board.selectFactor(kind, text, { factorKey: card.factorKey, territoryKey: selectedKey }, selected);
  }

  const failed = regional.failed || upper.failed || lower.failed || hierarchy.failed || packFailed;
  const loading = !regional.value || (level === 'upper' && !upper.value) ||
    (level === 'lower' && (!lower.value || !hierarchy.value)) ||
    (selectedMunicipality && pack?.key !== selectedKey);
  const outcome = level === 'region' ? regional.value?.source.outcome : index?.outcome;
  const source = level === 'region'
    ? { url: `${upstream}/tree/${regional.value?.source.revision}`, title: regional.value?.source.title }
    : { url: 'https://doi.org/10.48612/tochno/bdmo', title: 'БДМО · Росстат, обработка «Если быть точным»' };

  return <section className="objective-factors" aria-label="Объективные факторы рождаемости">
    <header className="objective-heading">
      <h2>Объективные факторы рождаемости</h2>
      <p>Посмотрите на рассчитанные связи и выберите карточки для обсуждения.</p>
      <div className="flipchart-view-switch" role="group" aria-label="Раздел объективных факторов">
        <button type="button" aria-pressed={view === 'cards'} onClick={() => setView('cards')}>Корреляции</button>
        <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>Флипчарт факторов · {activeNotes.length}</button>
      </div>
    </header>
    {view === 'board' ? <FlipchartBoard objective notes={board.notes} onVote={board.vote} onWithdraw={board.withdraw}
      pendingIds={board.pendingIds} loading={board.loading} error={board.error} /> : <>
      <ObjectiveTerritories selection={selection} change={select} regions={regions} municipalities={parents} settlements={settlements} />
      {rows.length ? <label className="objective-search">Показатель<input type="search" placeholder="Поиск по названию"
        value={query} onChange={event => { setQuery(event.target.value); setLimit(batchSize); }} /></label> : null}
      {failed ? <div className="objective-message"><p role="alert">Не удалось загрузить корреляции.</p>
        <button type="button" className="button button-secondary" onClick={() => setRetry(n => n + 1)}>Повторить</button></div>
        : loading ? <p role="status">Загружаем корреляции…</p>
        : selectedKey && !visible.length ? <p>{search ? 'Показатели по запросу не найдены.' : 'Для этой территории нет рассчитанных корреляций.'}</p>
        : level !== 'region' && region && !parents.length ? <p>В наборе нет территорий этого уровня для выбранного субъекта.</p> : null}
      {board.error ? <p role="alert">{board.error}</p> : null}
      {outcome && selectedKey && visible.length ? <>
        <div className="objective-summary">
          <p className="objective-count">{outcome.title}{outcome.unit ? `, ${outcome.unit}` : ''}. Найдено связей: {visible.length.toLocaleString('ru-RU')}.</p>
          <p className="objective-source"><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></p>
        </div>
        <ol className="objective-cards">
          {visible.slice(0, limit).map(({ card, rank }) => {
            const added = chosen.has(card.factorKey);
            const years = card.years;
            return <li key={rank} className="objective-card" data-direction={card.factorKey.slice(-1)} data-added={added || undefined}>
              <span className="objective-section">{rank}{card.section ? `. ${card.section}` : ''}</span>
              <h3>{card.title}</h3>
              {card.info.length ? <p>{card.info.join(' · ')}</p> : null}
              <dl><div><dt>{level === 'region' ? 'Корреляция из исследования' : 'Байесовская корреляция'}</dt><dd>{format.format(card.value)}</dd></div>
                {card.interval ? <div><dt>95% интервал</dt><dd>{format.format(card.interval[0])} … {format.format(card.interval[1])}</dd></div> : null}
                <div><dt>Годы наблюдений</dt><dd title={years.join(', ')}>{years.length ? `${years[0]}–${years.at(-1)} · ${years.length}` : 'Не указаны'}</dd></div></dl>
              <button type="button" className="button button-secondary" disabled={!editable || board.submitting || board.loading}
                aria-pressed={added} title={added ? 'Убрать с флипчарта для этой территории' : undefined}
                onClick={() => void selectCard(card, !added)}>
                {added ? <><CircleCheck size={19} aria-hidden />На флипчарте</> : <><Plus size={16} aria-hidden />На флипчарт</>}
              </button>
            </li>;
          })}
        </ol>
        {visible.length > limit ? <div className="objective-scroll-cursor" ref={cursor} aria-hidden="true" /> : null}
      </> : null}
    </>}
  </section>;
}
