import { useEffect, useMemo, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import type { RoadmapRoomSummary } from '../../../../../packages/roadmaps/types';
import type { TerritoryDataIndex, TerritoryMapPack, TerritoryRegistry } from '../../../../../packages/territories/types';
import { loadTerritoryMap, territoryKindLabel } from '../../lib/territories';
import { layoutTerritoryLabels } from '../roadmaps/map-labels';
import { useMapViewport } from './useMapViewport';
import './municipal-map.css';

type MapRooms = ReadonlyMap<string, Pick<RoadmapRoomSummary, 'memberCount' | 'latestVersionKind'>>;
type Selection = {
  registry: TerritoryRegistry;
  selectedKey: string | null;
  onSelect?: (key: string) => void;
  selectableKeys?: ReadonlySet<string>;
  rooms?: MapRooms;
};
const emptyRooms: MapRooms = new Map();

export function MunicipalMap({ index, regionId, ...selection }: Selection & {
  index: TerritoryDataIndex;
  regionId: string;
}) {
  return <MunicipalLayer
    key={`${index.editionId}:${regionId}`}
    index={index}
    regionId={regionId}
    {...selection}
  />;
}

function MunicipalLayer({ index, regionId, ...selection }: Selection & {
  index: TerritoryDataIndex;
  regionId: string;
}) {
  const [map, setMap] = useState<TerritoryMapPack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const regionName = index.regions.find((region) => region.regionId === regionId)?.name;

  useEffect(() => {
    let active = true;
    void loadTerritoryMap(index, regionId).then((value) => {
      if (active) setMap(value);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Карта не загрузилась.');
    });
    return () => { active = false; };
  }, [index, regionId, attempt]);

  if (!regionName) return <p className="municipal-map-message">Для этого субъекта РФ карта недоступна. Территорию можно выбрать в списке.</p>;
  if (error) return <div className="municipal-map-message">
    <p role="alert">{error}</p>
    <button type="button" className="button button-secondary" onClick={() => {
      setError(null);
      setAttempt((value) => value + 1);
    }}>Повторить загрузку</button>
    <p>Территорию можно выбрать в списке.</p>
  </div>;
  if (!map) return <p className="municipal-map-message" aria-busy="true">Загружаем геометрию региона…</p>;
  return <MunicipalCanvas {...selection} map={map} regionName={regionName} />;
}

function MunicipalCanvas({ map, regionName, registry, selectedKey, onSelect, selectableKeys, rooms = emptyRooms }:
  Selection & { map: TerritoryMapPack; regionName: string }) {
  const { box, scale, svg, zoom, reset, canSelect, canvasEvents } = useMapViewport(map.viewBox, 6);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const recordsByKey = useMemo(
    () => new Map(registry.records.map((record) => [record.territoryKey, record])),
    [registry],
  );
  const workingKeys = useMemo(() => new Set(rooms.keys()), [rooms]);
  const fit = Math.min(dimensions.width / map.viewBox[2], dimensions.height / map.viewBox[3]);
  const pixelsPerUnit = fit * scale;
  const canPick = (key: string) => Boolean(onSelect) && (!selectableKeys || selectableKeys.has(key));
  const labels = useMemo(() => layoutTerritoryLabels(map, recordsByKey, selectedKey, workingKeys, pixelsPerUnit, dimensions.width),
    [map, recordsByKey, selectedKey, workingKeys, pixelsPerUnit, dimensions.width]);

  useEffect(() => {
    const node = svg.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setDimensions((previous) => previous.width === width && previous.height === height ? previous : { width, height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [svg]);

  return <div className="rm-map-viewport">
    <div className="rm-map-topline">
      <span>{regionName}</span>
      <div className="municipal-map-actions" aria-label="Масштаб карты">
        <button type="button" className="icon-button" aria-label="Уменьшить карту" title="Уменьшить карту"
          disabled={scale <= 1} onClick={() => zoom(1 / 1.5)}><ZoomOut size={17} /></button>
        <button type="button" className="icon-button" aria-label="Увеличить карту" title="Увеличить карту"
          disabled={scale >= 6} onClick={() => zoom(1.5)}><ZoomIn size={17} /></button>
        <button type="button" className="button button-quiet" disabled={scale <= 1} onClick={reset}>Весь слой</button>
      </div>
    </div>
    <svg ref={svg} className="rm-territory-map" role="group" aria-label={`Территории: ${regionName}`}
      viewBox={box.join(' ')} tabIndex={0} data-pannable={scale > 1}
      style={{ touchAction: scale > 1 ? 'none' : 'pan-y' }} {...canvasEvents}>
      <title>{regionName}. Выберите муниципальное образование на карте. Для изменения масштаба используйте кнопки или колесо на карте в фокусе.</title>
      {map.shapes.map((shape) => {
        const record = recordsByKey.get(shape.territoryKey);
        if (!record) return null;
        const territoryRoom = rooms.get(record.territoryKey);
        const chosen = selectedKey === record.territoryKey;
        const selectable = canPick(record.territoryKey);
        return <path
          key={shape.territoryKey}
          d={shape.path}
          fillRule="evenodd"
          className="rm-map-shape"
          data-territory-key={record.territoryKey}
          data-selected={chosen}
          data-room={Boolean(territoryRoom)}
          data-submitted={territoryRoom?.latestVersionKind === 'submitted'}
          data-context={!record.roomEligible || !selectable}
          role={selectable ? 'button' : undefined}
          tabIndex={selectable ? 0 : undefined}
          aria-label={`${record.name}${territoryRoom ? `, команда: ${territoryRoom.memberCount}` : ''}`}
          aria-pressed={selectable ? chosen : undefined}
          onClick={selectable ? (event) => {
            if (canSelect(event.detail)) onSelect?.(record.territoryKey);
          } : undefined}
          onKeyDown={selectable ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect?.(record.territoryKey);
            }
          } : undefined}
        >
          <title>{record.name} · {territoryKindLabel[record.unitKind]}</title>
        </path>;
      })}
      <g aria-hidden="true" className="municipal-map-leaders">
        {labels.map(({ key, leader, x, y }) => leader
          ? <line key={key} x1={leader[0]} y1={leader[1]} x2={x} y2={y} vectorEffect="non-scaling-stroke" />
          : null)}
      </g>
      <g aria-hidden="true">
        {labels.map((label) => {
          // A label inside its shape leaves the polygon clickable. A moved label
          // still selects its own territory from the end of the leader line.
          const selectable = Boolean(label.leader) && canPick(label.key);
          return <text key={label.key} x={label.x} y={label.y}
            style={{ fontSize: label.fontSize, strokeWidth: 2.5 / pixelsPerUnit }}
            textAnchor="middle" dominantBaseline="central" className="rm-map-label"
            data-selected={label.selected} data-selectable={selectable}
            onClick={selectable ? (event) => {
              if (canSelect(event.detail)) onSelect?.(label.key);
            } : undefined}>
            {label.text}
          </text>;
        })}
      </g>
    </svg>
  </div>;
}
