import { useEffect, useId, useMemo, useState } from 'react';
import { Minus, Plus, LocateFixed, RotateCcw } from 'lucide-react';
import { loadRegionMap, loadRegionMapDetail } from '@/lib/region-map';
import type { RegionMapData, RegionMapDetail } from '@/lib/region-map';
import { useMapViewport } from './useMapViewport';
import './geography.css';

export interface MapRegion { id: string; name: string; hasDocument: boolean }
export interface MapRegionWork {
  regionId: string;
  status: 'available' | 'in_progress' | 'completed';
  leaseExpiresAt?: string | null;
}
type MapStatus = MapRegionWork['status'] | 'unavailable' | 'measures-selected' | 'measures-unselected';
const labels: Record<MapStatus, string> = {
  available: 'Свободна', in_progress: 'В работе', completed: 'Отбор завершён', unavailable: 'Нет подготовленного текста',
  'measures-selected': 'Меры отобраны', 'measures-unselected': 'Меры не отобраны',
};
const initialBox = [0, 0, 1200, 620] as const;
const emptyWork: MapRegionWork[] = [];

/** Geometry stays immutable; only teaching statuses and the selection change. */
export function RegionMap({ regions, work = emptyWork, selectedRegionId, onSelect, measureRegionIds,
  allocation = true, compact = false, purpose = 'programmes' }: {
  regions: MapRegion[]; work?: MapRegionWork[]; selectedRegionId: string | null;
  onSelect: (regionId: string) => void; allocation?: boolean; compact?: boolean;
  purpose?: 'programmes' | 'territories'; measureRegionIds?: ReadonlySet<string>;
}) {
  const [data, setData] = useState<RegionMapData | null>(null);
  const [detail, setDetail] = useState<RegionMapDetail | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [keyboardRegionId, setKeyboardRegionId] = useState<string | null>(null);
  const hatch = useId().replaceAll(':', '');
  const isTerritoryPicker = purpose === 'territories';
  const showMeasures = !isTerritoryPicker && measureRegionIds !== undefined;
  const showWork = allocation && !isTerritoryPicker && !showMeasures;
  const { box, scale, svg, zoom, reset, canSelect, canvasEvents } = useMapViewport(initialBox, 8, Boolean(data && !error));
  const detailEnabled = Boolean(data && !error && scale >= 1.8);
  useEffect(() => {
    let active = true;
    setError('');
    void loadRegionMap().then((next) => { if (active) setData(next); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить карту.'); });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => {
    if (!detailEnabled || detail) return;
    let active = true;
    void loadRegionMapDetail().then((next) => { if (active) setDetail(next); })
      .catch(() => { /* Preserve the overview when its supplemental contours are unavailable. */ });
    return () => { active = false; };
  }, [detailEnabled, detail]);
  useEffect(() => {
    if (!showWork) return;
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [showWork]);
  const regionById = useMemo(() => new Map(regions.map((region) => [region.id, region])), [regions]);
  const workById = useMemo(() => new Map(work.map((item) => [item.regionId, item])), [work]);
  const shapes = useMemo(() => detailEnabled && detail
    ? data?.shapes.map(shape => detail.shapes.get(shape.regionId) ?? shape) : data?.shapes, [data, detailEnabled, detail]);
  const selected = showMeasures ? undefined : shapes?.find((shape) => shape.regionId === selectedRegionId);
  const selectable = (regionId: string) => {
    if (showMeasures) return Boolean(regionById.get(regionId)?.hasDocument);
    return !isTerritoryPicker || regionById.has(regionId);
  };
  const focusRegionId = showMeasures ? keyboardRegionId ?? selectedRegionId : selected?.regionId;
  const tabbable = shapes?.find((shape) => shape.regionId === focusRegionId && selectable(shape.regionId))?.regionId
    ?? shapes?.find((shape) => selectable(shape.regionId))?.regionId;
  const statusOf = (regionId: string): MapStatus => {
    if (isTerritoryPicker) return selectable(regionId) ? 'available' : 'unavailable';
    if (showMeasures) return measureRegionIds?.has(regionId) ? 'measures-selected' : 'measures-unselected';
    if (!regionById.get(regionId)?.hasDocument) return 'unavailable';
    const item = workById.get(regionId);
    if (item?.status === 'in_progress' && item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) <= clock) return 'available';
    return item?.status ?? 'available';
  };
  function selectKeyboard(regionId: string, key: string) {
    if (!shapes || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return;
    const current = shapes.find((shape) => shape.regionId === regionId);
    if (!current) return;
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    const sign = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
    const next = shapes.filter((shape) => shape !== current && selectable(shape.regionId)
      && (shape.centroid[horizontal ? 0 : 1] - current.centroid[horizontal ? 0 : 1]) * sign > 0)
      .sort((a, b) => {
        const distance = (shape: typeof current) => {
          const dx = shape.centroid[0] - current.centroid[0], dy = shape.centroid[1] - current.centroid[1];
          return Math.hypot(dx, dy) + Math.abs(horizontal ? dy : dx) * 2;
        };
        return distance(a) - distance(b);
      })[0];
    if (!next) return;
    if (!showMeasures) onSelect(next.regionId);
    requestAnimationFrame(() => svg.current?.querySelector<SVGGElement>(`[data-region-id="${CSS.escape(next.regionId)}"]`)?.focus());
  }
  const legend: MapStatus[] = showMeasures ? ['measures-selected', 'measures-unselected']
    : showWork ? ['available', 'in_progress', 'completed', 'unavailable'] : ['available', 'unavailable'];
  if (error) return <div className="geo-fallback" role="status"><p>{error}</p><button className="button button-secondary" onClick={() => setAttempt((value) => value + 1)}>Повторить загрузку карты</button></div>;
  if (!data) return <div className="geo-fallback" aria-busy="true">{isTerritoryPicker ? 'Загружаем карту России…' : 'Загружаем карту программ…'}</div>;
  return <div className={`region-map${compact ? ' region-map-compact' : ''}`}>
    <div className="geo-toolbar">
      <p className="geo-current">{showMeasures ? 'Региональные программы'
        : selected?.name ?? 'Выберите регион на карте или в списке'}</p>
      <div className="geo-controls" aria-label="Масштаб карты">
        <button type="button" className="icon-button" aria-label="Приблизить карту" onClick={() => zoom(1.5)} disabled={scale >= 8}><Plus size={17} /></button>
        <button type="button" className="icon-button" aria-label="Отдалить карту" onClick={() => zoom(1 / 1.5)} disabled={scale <= 1}><Minus size={17} /></button>
        {!showMeasures ? <button type="button" className="icon-button" aria-label="Приблизить выбранный регион" disabled={!selected} onClick={() => selected && zoom(2.5, undefined, selected.centroid)}><LocateFixed size={17} /></button> : null}
        <button type="button" className="icon-button" aria-label="Показать всю карту" onClick={reset}><RotateCcw size={16} /></button>
      </div>
    </div>
    <svg ref={svg} className="geo-canvas" viewBox={box.join(' ')} aria-label={isTerritoryPicker ? 'Карта России' : 'Карта региональных программ'}
      role="group" tabIndex={0} data-pannable={scale > 1} style={{ touchAction: scale > 1 ? 'none' : 'pan-y' }} {...canvasEvents}>
      <defs><pattern id={hatch} patternUnits="userSpaceOnUse" width="8" height="8"><rect width="8" height="8" fill="#f1f4f8" /><path d="M-2 2L2-2M0 8L8 0M6 10L10 6" stroke="#bec9d8" strokeWidth="1" /></pattern></defs>
      {(shapes ?? data.shapes).map((shape) => {
        const status = statusOf(shape.regionId);
        const chosen = shape.regionId === selected?.regionId;
        const enabled = selectable(shape.regionId);
        const small = (shape.bounds[2] - shape.bounds[0]) * (shape.bounds[3] - shape.bounds[1]) < 90;
        const detailed = detailEnabled && detail?.shapes.has(shape.regionId);
        const label = isTerritoryPicker ? (enabled ? shape.name : `${shape.name} — отсутствует в списке`)
          : `${shape.name}: ${!showWork && status === 'available' ? 'текст доступен' : labels[status]}`;
        return <g key={shape.regionId} data-region-id={shape.regionId} className={`geo-region geo-${status}${chosen ? ' is-selected' : ''}`}
          data-measures={showMeasures ? (status === 'measures-selected' ? 'selected' : 'unselected') : undefined}
          role={enabled ? 'button' : undefined} aria-label={label} aria-pressed={enabled && !showMeasures ? chosen : undefined}
          tabIndex={enabled ? (tabbable === shape.regionId ? 0 : -1) : undefined}
          onFocus={showMeasures ? () => setKeyboardRegionId(shape.regionId) : undefined}
          onClick={enabled ? (event) => { if (canSelect(event.detail)) onSelect(shape.regionId); } : undefined}
          onKeyDown={enabled ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(shape.regionId); }
            if (event.key.startsWith('Arrow')) { event.preventDefault(); selectKeyboard(shape.regionId, event.key); }
          } : undefined}>
          <title>{label}</title>
          <path d={shape.d} fill={status === 'unavailable' ? `url(#${hatch})` : undefined} fillRule="evenodd" vectorEffect="non-scaling-stroke" />
          {small ? <circle className={detailed ? 'geo-region-target' : undefined}
            cx={shape.centroid[0]} cy={shape.centroid[1]} r={chosen ? 5 : 3.5}
            pointerEvents={detailed ? 'all' : undefined} vectorEffect="non-scaling-stroke" /> : null}
        </g>;
      })}
      {selected ? <path className="geo-selected-outline" d={selected.d} fill="none" vectorEffect="non-scaling-stroke" pointerEvents="none" /> : null}
    </svg>
    <div className="geo-legend" aria-label="Условные обозначения">
      {legend.map((status) => <span key={status}><i className={`geo-swatch geo-${status}`} aria-hidden="true" />{isTerritoryPicker
        ? (status === 'available' ? 'Доступно для выбора' : 'Отсутствует в списке')
        : (!showWork && status === 'available' ? 'Текст доступен' : labels[status])}</span>)}
    </div>
  </div>;
}
