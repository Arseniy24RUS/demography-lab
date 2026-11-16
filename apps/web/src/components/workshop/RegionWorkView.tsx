import { Activity, useId, useRef, useState } from 'react';
import { BookOpen, Check, ChevronRight, Layers, List, Map, Search } from 'lucide-react';
import type { WorkshopAreaProps } from './workshop-ui';

const searchText = (value: string) => value.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');

export function RegionWorkView({ regions, renderMap, onOpenDocument, measureRegionIds, renderCatalogue }:
  Pick<WorkshopAreaProps, 'regions' | 'renderMap' | 'onOpenDocument' | 'measureRegionIds' | 'renderCatalogue'>) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [catalogueRegion, setCatalogueRegion] = useState<string | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const needle = searchText(query);
  const visible = regions.filter(region => searchText(region.name).includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  function selectRegion(regionId: string) {
    if (renderCatalogue) {
      setCatalogueRegion(regionId);
      setCatalogueOpen(true);
      requestAnimationFrame(() => toolbar.current?.scrollIntoView({ block: 'nearest' }));
    } else {
      onOpenDocument(regionId);
    }
  }

  return <>
    {renderCatalogue ? <div className="programme-catalogue-toolbar" ref={toolbar}>
      <button className="button button-secondary" type="button" onClick={() => {
        if (catalogueOpen) setCatalogueOpen(false);
        else selectRegion('');
      }}>
        {catalogueOpen ? <Map size={16} aria-hidden="true" /> : <List size={16} aria-hidden="true" />}
        {catalogueOpen ? 'К карте и списку программ' : 'Каталог мер'}
      </button>
    </div> : null}
    <Activity mode={catalogueOpen ? 'hidden' : 'visible'}>
    <div className="workshop-map-layout workshop-programmes">
    <section className="workshop-map-panel" aria-label="Карта программ">
      {renderMap({ selectedRegionId: null, onSelect: selectRegion })}
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
            disabled={!renderCatalogue && !region.hasDocument} data-region-id={region.id}
            data-document={region.hasDocument ? 'available' : 'unavailable'}
            data-catalogue={renderCatalogue && region.hasMeasures !== undefined ? (region.hasMeasures ? 'available' : 'unavailable') : undefined}
            data-measures={hasMeasures ? 'selected' : 'unselected'}
            onClick={() => selectRegion(region.id)}>
            {renderCatalogue ? <Layers size={17} aria-hidden="true" /> : <BookOpen size={17} aria-hidden="true" />}
            <span className="workshop-region-row-name">
              {region.name}
              <span className="session-sr-only">{hasMeasures ? ', меры отобраны' : ''}</span>
              {renderCatalogue ? (region.hasMeasures === false ? <small>Нет карточек мер</small> : null)
                : !region.hasDocument ? <small>Текст недоступен</small> : null}
            </span>
            {hasMeasures ? <Check size={17} aria-hidden="true" /> : <ChevronRight size={17} aria-hidden="true" />}
          </button>;
        })}
        {!visible.length ? <p className="workshop-muted workshop-list-empty">Регион не найден.</p> : null}
      </div>
    </section>
    </div>
    </Activity>
    {renderCatalogue && catalogueRegion !== null ? (
      <Activity mode={catalogueOpen ? 'visible' : 'hidden'}>{renderCatalogue(catalogueRegion)}</Activity>
    ) : null}
  </>;
}
