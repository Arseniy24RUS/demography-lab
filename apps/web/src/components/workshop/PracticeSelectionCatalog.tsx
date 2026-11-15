import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, BookOpen, Search } from 'lucide-react';
import type { CorpusManifest } from '@/lib/corpus';
import { readable } from '@/lib/corpus';
import { FAMILY_SUPPORT_NAME, FAMILY_SUPPORT_URL, isFamilyCatalogVariant, loadFamilyCatalog } from '@/lib/family-catalog';
import type { FamilyCatalogVariant } from '@/lib/family-catalog';
import { useCatalogSelection } from '@/hooks/useCatalogSelection';
import { CatalogSelectButton } from '../CatalogSelectButton';
import type { SessionSnapshot } from '../../../../../packages/collaboration/types';

const pageSize = 48;
const regional = 'all-regions';
const federal = 'federal';
const searchText = (text: string) => text.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');

function territoryKey(card: FamilyCatalogVariant) {
  return card.regionId === 'unknown' && card.regionName ? `region-name:${card.regionName}` : card.regionId;
}

type Catalogue = { status: 'loading' | 'error' } | { status: 'ready'; cards: FamilyCatalogVariant[] };

export default function PracticeSelectionCatalog({ manifest, session, initialRegionId = '', onSelect, onOpenProgramme }: {
  manifest: CorpusManifest;
  session: SessionSnapshot;
  initialRegionId?: string;
  onSelect: (catalogId: string) => Promise<void>;
  onOpenProgramme?: (regionId: string) => void;
}) {
  const [catalogue, setCatalogue] = useState<Catalogue>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [territory, setTerritory] = useState(initialRegionId);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const selection = useCatalogSelection(session, onSelect);
  const needle = useDeferredValue(searchText(query));
  const programme = onOpenProgramme && manifest.documents.find(entry => entry.regionId === territory && readable(entry));

  useEffect(() => {
    let active = true;
    void loadFamilyCatalog(manifest).then(items => {
      if (active) setCatalogue({ status: 'ready', cards: items.filter(isFamilyCatalogVariant) });
    }).catch(() => {
      if (active) setCatalogue({ status: 'error' });
    });
    return () => { active = false; };
  }, [manifest, attempt]);

  const cards = catalogue.status === 'ready' ? catalogue.cards : null;
  const territories = useMemo(() => {
    const values = new Map<string, string>();
    const initial = manifest.documents.find(entry => entry.regionId === initialRegionId);
    if (initial) values.set(initial.regionId, initial.territory);
    for (const card of cards ?? []) {
      if (card.snapshot.level === 'regional') {
        values.set(territoryKey(card), card.regionName ?? 'Территория не определена');
      }
    }
    return [...values].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  }, [cards, initialRegionId, manifest]);
  const searchable = useMemo(() => (cards ?? []).map(card => ({
    card,
    key: territoryKey(card),
    text: searchText(`${card.title} ${card.mechanism} ${card.amount ?? ''} ${card.eligibility ?? ''} ${card.regionName ?? ''}`),
  })), [cards]);
  const matches = useMemo(() => searchable.filter(({ card, key, text }) => {
    const inTerritory = territory === regional ? card.snapshot.level === 'regional' : !territory || key === territory;
    return inTerritory && text.includes(needle);
  }), [searchable, needle, territory]);
  const lastPage = Math.max(1, Math.ceil(matches.length / pageSize));
  const current = Math.min(lastPage, page);
  const visible = matches.slice((current - 1) * pageSize, current * pageSize);

  return <section className="programme-catalogue" aria-label="Каталог мер">
    {catalogue.status === 'loading' ? <p role="status" aria-busy="true">Загружаем каталог мер…</p> : null}
    {catalogue.status === 'error' ? <div className="session-message" data-tone="error" role="alert">
      <p>Не удалось загрузить каталог мер.</p>
      <button className="button button-secondary" onClick={() => {
        setCatalogue({ status: 'loading' });
        setAttempt(value => value + 1);
      }}>Повторить</button>
    </div> : null}
    {catalogue.status === 'ready' ? <>
      <div className="content-toolbar">
        <div className="search-field">
          <Search size={16} aria-hidden="true" />
          <input className="input" type="search" aria-label="Поиск мер" placeholder="Найти меру"
            value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
        </div>
        <select className="input" aria-label="Территория меры" value={territory}
          onChange={event => { setTerritory(event.target.value); setPage(1); }}>
          <option value="">Все территории</option>
          <option value={federal}>Федеральные меры</option>
          <option value={regional}>Все регионы</option>
          <optgroup label="Регионы">
            {territories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </optgroup>
        </select>
        {programme && onOpenProgramme ? (
          <button className="button button-secondary" type="button" onClick={() => onOpenProgramme(programme.regionId)}>
            <BookOpen size={16} aria-hidden="true" /> Текст программы
          </button>
        ) : null}
      </div>
      {selection.error ? <p className="session-message" data-tone="error" role="alert">{selection.error}</p> : null}
      <p className="catalog-count" role="status">Найдено мер: {matches.length.toLocaleString('ru')}</p>
      {visible.length ? <div className="practice-grid">
        {visible.map(({ card }) => {
          const selected = selection.chosen.has(card.catalogId);
          return <article key={card.catalogId} className="practice-tile programme-catalogue-card"
            data-selected={selected || undefined}>
            <p className="tile-region">{card.regionName}</p>
            <h2>{card.title}</h2>
            <p className="tile-summary">{card.mechanism}</p>
            {card.amount && card.amount !== card.mechanism ? <p className="tile-summary">{card.amount}</p> : null}
            <div className="tile-footer">
              <a className="button button-quiet small" href={FAMILY_SUPPORT_URL}
                target="_blank" rel="noopener noreferrer" title={FAMILY_SUPPORT_NAME}>
                Источник <ArrowUpRight size={14} aria-hidden="true" />
              </a>
              <CatalogSelectButton id={card.catalogId} selection={selection} />
            </div>
          </article>;
        })}
      </div> : <p className="workshop-muted">Меры по этому запросу не найдены.</p>}
      {lastPage > 1 ? <nav className="catalog-pagination" aria-label="Страницы каталога мер">
        <button className="button button-secondary" disabled={current === 1}
          onClick={() => setPage(current - 1)}>Предыдущие</button>
        <span>{current} / {lastPage}</span>
        <button className="button button-secondary" disabled={current === lastPage}
          onClick={() => setPage(current + 1)}>Следующие</button>
      </nav> : null}
    </> : null}
  </section>;
}
