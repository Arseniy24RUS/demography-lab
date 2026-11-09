import { useEffect, useId, useRef, useState } from 'react';
import { Minus, Plus, LocateFixed, RotateCcw } from 'lucide-react';
import { loadRegionMap } from '@/lib/region-map';
import type { RegionMapData } from '@/lib/region-map';
import './geography.css';

export interface MapRegion { id: string; name: string; hasDocument: boolean }
export interface MapRegionWork {
  regionId: string;
  status: 'available' | 'in_progress' | 'completed';
  leaseExpiresAt?: string | null;
}
type MapStatus = MapRegionWork['status'] | 'unavailable';
const labels: Record<MapStatus, string> = { available: 'Свободна', in_progress: 'В работе', completed: 'Отбор завершён', unavailable: 'Нет подготовленного текста' };
const initialBox = { x: 0, y: 0, width: 1200, height: 620 };

/** Geometry stays immutable; only teaching statuses and the selection change. */
export function RegionMap({ regions, work = [], selectedRegionId, onSelect, allocation = true, compact = false }: {
  regions: MapRegion[]; work?: MapRegionWork[]; selectedRegionId: string | null;
  onSelect: (regionId: string) => void; allocation?: boolean; compact?: boolean;
}) {
  const [data, setData] = useState<RegionMapData | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [box, setBox] = useState(initialBox);
  const [clock, setClock] = useState(Date.now());
  const hatch = useId().replaceAll(':', '');
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; box: typeof box; moved: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    setError('');
    void loadRegionMap().then((next) => { if (active) setData(next); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить карту.'); });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const regionById = new Map(regions.map((region) => [region.id, region]));
  const workById = new Map(work.map((item) => [item.regionId, item]));
  const selected = data?.shapes.find((shape) => shape.regionId === selectedRegionId);
  const statusOf = (regionId: string): MapStatus => {
    if (!regionById.get(regionId)?.hasDocument) return 'unavailable';
    const item = workById.get(regionId);
    if (item?.status === 'in_progress' && item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) <= clock) return 'available';
    return item?.status ?? 'available';
  };
  const constrain = (next: typeof box) => ({ ...next,
    x: Math.max(-30, Math.min(1230 - next.width, next.x)),
    y: Math.max(-16, Math.min(636 - next.height, next.y)),
  });
  function zoom(factor: number, focus?: [number, number]) {
    setBox((previous) => {
      const width = Math.max(150, Math.min(1200, previous.width * factor));
      const height = width * 620 / 1200;
      const [cx, cy] = focus ?? [previous.x + previous.width / 2, previous.y + previous.height / 2];
      return constrain({ width, height, x: cx - width / 2, y: cy - height / 2 });
    });
  }
  function selectKeyboard(regionId: string, key: string) {
    if (!data || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return;
    const current = data.shapes.find((shape) => shape.regionId === regionId);
    if (!current) return;
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    const sign = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
    const next = data.shapes.filter((shape) => shape !== current && (shape.centroid[horizontal ? 0 : 1] - current.centroid[horizontal ? 0 : 1]) * sign > 0)
      .sort((a, b) => {
        const distance = (shape: typeof current) => {
          const dx = shape.centroid[0] - current.centroid[0], dy = shape.centroid[1] - current.centroid[1];
          return Math.hypot(dx, dy) + Math.abs(horizontal ? dy : dx) * 2;
        };
        return distance(a) - distance(b);
      })[0];
    if (!next) return;
    onSelect(next.regionId);
    requestAnimationFrame(() => svg.current?.querySelector<SVGGElement>(`[data-region-id="${CSS.escape(next.regionId)}"]`)?.focus());
  }
  if (error) return <div className="geo-fallback" role="status"><p>{error}</p><button className="button button-secondary" onClick={() => setAttempt((value) => value + 1)}>Повторить загрузку карты</button></div>;
  if (!data) return <div className="geo-fallback" aria-busy="true">Загружаем карту программ…</div>;
  return <div className={`region-map${compact ? ' region-map-compact' : ''}`}>
    <div className="geo-toolbar">
      <p className="geo-current">{selected ? selected.name : 'Выберите регион на карте или в списке'}</p>
      <div className="geo-controls" aria-label="Масштаб карты">
        <button className="icon-button" aria-label="Приблизить карту" onClick={() => zoom(.65)} disabled={box.width <= 150}><Plus size={17} /></button>
        <button className="icon-button" aria-label="Отдалить карту" onClick={() => zoom(1.55)} disabled={box.width >= 1200}><Minus size={17} /></button>
        <button className="icon-button" aria-label="Приблизить выбранный регион" disabled={!selected} onClick={() => selected && zoom(.4, selected.centroid)}><LocateFixed size={17} /></button>
        <button className="icon-button" aria-label="Показать всю карту" onClick={() => setBox(initialBox)}><RotateCcw size={16} /></button>
      </div>
    </div>
    <svg ref={svg} className="geo-canvas" viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`} aria-label="Карта региональных программ" role="group" style={{ touchAction: box.width < 1200 ? 'none' : 'pan-y' }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, box, moved: false };
        if (box.width < 1200) event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state || state.pointer !== event.pointerId || state.box.width >= 1200 || !event.buttons) return;
        const dx = event.clientX - state.x, dy = event.clientY - state.y;
        if (Math.hypot(dx, dy) < 6 && !state.moved) return;
        state.moved = true;
        const rect = event.currentTarget.getBoundingClientRect();
        const scale = Math.min(rect.width / state.box.width, rect.height / state.box.height);
        setBox(constrain({ ...state.box, x: state.box.x - dx / scale, y: state.box.y - dy / scale }));
      }}
      onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current = null; }}>
      <defs><pattern id={hatch} patternUnits="userSpaceOnUse" width="8" height="8"><rect width="8" height="8" fill="#f1f4f8" /><path d="M-2 2L2-2M0 8L8 0M6 10L10 6" stroke="#bec9d8" strokeWidth="1" /></pattern></defs>
      {data.shapes.map((shape, index) => {
        const status = statusOf(shape.regionId);
        const chosen = shape.regionId === selectedRegionId;
        const small = (shape.bounds[2] - shape.bounds[0]) * (shape.bounds[3] - shape.bounds[1]) < 90;
        const label = `${shape.name}: ${!allocation && status === 'available' ? 'текст доступен' : labels[status]}`;
        return <g key={shape.regionId} data-region-id={shape.regionId} className={`geo-region geo-${status}${chosen ? ' is-selected' : ''}`}
          role="button" aria-label={label} aria-pressed={chosen} tabIndex={chosen || (!selectedRegionId && index === 0) ? 0 : -1}
          onClick={() => { if (!drag.current?.moved) onSelect(shape.regionId); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(shape.regionId); }
            if (event.key.startsWith('Arrow')) { event.preventDefault(); selectKeyboard(shape.regionId, event.key); }
          }}>
          <title>{label}</title>
          <path d={shape.d} fill={status === 'unavailable' ? `url(#${hatch})` : undefined} fillRule="evenodd" vectorEffect="non-scaling-stroke" />
          {small ? <circle cx={shape.centroid[0]} cy={shape.centroid[1]} r={chosen ? 5 : 3.5} vectorEffect="non-scaling-stroke" /> : null}
        </g>;
      })}
      {selected ? <path className="geo-selected-outline" d={selected.d} fill="none" vectorEffect="non-scaling-stroke" pointerEvents="none" /> : null}
    </svg>
    <div className="geo-legend" aria-label="Условные обозначения">
      {(allocation ? ['available', 'in_progress', 'completed', 'unavailable'] : ['available', 'unavailable']).map((status) => <span key={status}><i className={`geo-swatch geo-${status}`} aria-hidden="true" />{!allocation && status === 'available' ? 'Текст доступен' : labels[status as MapStatus]}</span>)}
    </div>
    <details className="geo-provenance"><summary>Источник и устройство карты</summary><p>Геометрия и состав территорий — авторский корпус family-support. Проекция Альберса, стандартные параллели 50° и 70°. Карта используется для навигации по программам; площадь полигона не отражает объём работы. Названия сопоставлены с 89 паспортами корпуса; официальные территориальные коды не подменяются внутренними идентификаторами.</p><a href={data.source.sourceUrl} target="_blank" rel="noreferrer">Исходная геометрия и зафиксированная версия</a><p>Статус «Отбор завершён» отражает отметку исполнителя о своём задании. Полнота экспертизы всего документа требует отдельной содержательной проверки.</p></details>
  </div>;
}
