import { Activity, useId, useState } from 'react';
import { BookOpen, Check, ChevronRight, List, Search } from 'lucide-react';
import type { WorkshopAreaProps } from './workshop-ui';

const searchText = (value: string) => value.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');

export function RegionWorkView({ regions, renderMap, onOpenDocument, measureRegionIds, catalogue }:
  Pick<WorkshopAreaProps, 'regions' | 'renderMap' | 'onOpenDocument' | 'measureRegionIds' | 'catalogue'>) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [catalogueVisited, setCatalogueVisited] = useState(false);
  const needle = searchText(query);
  const visible = regions.filter(region => searchText(region.name).includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  return <>
    {catalogue ? <div className="programme-catalogue-toolbar">
      <button className="button button-secondary" type="button" onClick={() => {
        setCatalogueVisited(true);
        setCatalogueOpen(value => !value);
      }}>
        {catalogueOpen ? <BookOpen size={16} aria-hidden="true" /> : <List size={16} aria-hidden="true" />}
        {catalogueOpen ? 'К карте и списку программ' : 'Каталог мер'}
      </button>
    </div> : null}
    <Activity mode={catalogueOpen ? 'hidden' : 'visible'}>
    <div className="workshop-map-layout workshop-programmes">
    <section className="workshop-map-panel" aria-label="Карта программ">
      {renderMap({ selectedRegionId: null, onSelect: onOpenDocument })}
    </section>
    <section className="workshop-map-panel" aria-label="Список программ">
      <div className="workshop-search-row">
        <div className="workshop-search">
          <Search size={17} aria-hidden="true" />
          <label htmlFor={searchId} className="session-sr-only">Найти регион</label>
          <input id={searchId} type="search" placeholder="Найти регион" value={query}
            onChange={event => setQuery(event.target.value)} />
        </div>
      </div>
      <div className="workshop-region-list" role="group" aria-label="Выбрать программу по названию">
        {visible.map(region => {
          const hasMeasures = measureRegionIds.has(region.id);
          return <button key={region.id} type="button" className="workshop-region-row"
            disabled={!region.hasDocument} data-region-id={region.id} data-measures={hasMeasures ? 'selected' : 'unselected'}
            onClick={() => onOpenDocument(region.id)}>
            <BookOpen size={17} aria-hidden="true" />
            <span className="workshop-region-row-name">
              {region.name}
              <span className="session-sr-only">{hasMeasures ? ', меры отобраны' : ''}</span>
              {!region.hasDocument ? <small>Текст недоступен</small> : null}
            </span>
            {hasMeasures ? <Check size={17} aria-hidden="true" /> : <ChevronRight size={17} aria-hidden="true" />}
          </button>;
        })}
        {!visible.length ? <p className="workshop-muted workshop-list-empty">Регион не найден.</p> : null}
      </div>
    </section>
    </div>
    </Activity>
    {catalogueVisited ? <Activity mode={catalogueOpen ? 'visible' : 'hidden'}>{catalogue}</Activity> : null}
  </>;
}
