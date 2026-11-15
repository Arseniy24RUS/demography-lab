import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { MapPinned } from 'lucide-react';
import { loadTerritoryIndex, loadTerritoryRegistry } from '../lib/territories';

const RegionMap = lazy(() => import('./geography/RegionMap').then(m => ({ default: m.RegionMap })));
const MunicipalMap = lazy(() => import('./geography/MunicipalMap').then(m => ({ default: m.MunicipalMap })));
const levels = {
  region: 'Субъекты РФ',
  upper: 'Муниципальные образования',
  lower: 'Городские и сельские поселения',
} as const;
export type ObjectiveLevel = keyof typeof levels;
export type ObjectiveSelection = { level: ObjectiveLevel; region: string; municipality: string; settlement: string };
export type TerritoryChoice = { key: string; name: string; territoryKey?: string; oktmo?: string };
export type RegionChoice = { id: string; name: string };

async function loadMapDataset() {
  const index = await loadTerritoryIndex();
  return { index, registry: await loadTerritoryRegistry(index) };
}

function MunicipalMapPicker({ regionId, options, value, onChange }: {
  regionId: string; options: TerritoryChoice[]; value: string; onChange: (key: string) => void;
}) {
  const [dataset, setDataset] = useState<Awaited<ReturnType<typeof loadMapDataset>>>();
  const [fail, setFail] = useState(false);
  const [attempt, retry] = useState(0);
  const choices = useMemo(() => new Map(options.flatMap(option =>
    option.territoryKey ? [[option.territoryKey, option.key] as const] : [])), [options]);
  const selectableKeys = useMemo(() => new Set(choices.keys()), [choices]);

  useEffect(() => {
    let active = true;
    void loadMapDataset().then(value => { if (active) setDataset(value); })
      .catch(() => { if (active) setFail(true); });
    return () => { active = false; };
  }, [attempt]);

  if (fail) return <div role="alert">Карта не загрузилась. <button type="button" className="button button-quiet"
    onClick={() => { setFail(false); retry(n => n + 1); }}>Повторить</button></div>;
  if (!dataset) return <p role="status">Загружаем карту…</p>;
  if (!dataset.index.regions.some(region => region.regionId === regionId) || !choices.size)
    return <p>Муниципальные образования этого региона можно выбрать из списка.</p>;
  return <MunicipalMap {...dataset} regionId={regionId}
    selectedKey={options.find(item => item.key === value)?.territoryKey ?? null}
    selectableKeys={selectableKeys} onSelect={(key: string) => {
      const match = choices.get(key);
      if (match) onChange(match);
    }} />;
}

function TerritorySelect({ label, value, options, disabled, onChange }: {
  label: string; value: string; options: TerritoryChoice[]; disabled: boolean; onChange: (key: string) => void;
}) {
  const names = new Map<string, number>();
  for (const { name } of options) names.set(name, (names.get(name) ?? 0) + 1);
  return <label>{label}<select value={options.some(option => option.key === value) ? value : ''}
    disabled={disabled} onChange={event => onChange(event.target.value)}>
    <option value="">Выберите из списка</option>
    {options.map(option => <option key={option.key} value={option.key}>
      {option.oktmo && (names.get(option.name) ?? 0) > 1 ? `${option.name} · ${option.oktmo}` : option.name}
    </option>)}
  </select></label>;
}

export function ObjectiveTerritories({ selection, change, regions, municipalities, settlements }: {
  selection: ObjectiveSelection; change: (value: ObjectiveSelection) => void;
  regions: RegionChoice[]; municipalities: TerritoryChoice[]; settlements: TerritoryChoice[];
}) {
  const { level, region, municipality, settlement } = selection;
  const [map, setMap] = useState<'regions' | 'municipalities'>();
  const selectRegion = (value: string) => change({ ...selection, region: value, municipality: '', settlement: '' });
  const selectMunicipality = (value: string) => change({ ...selection, municipality: value, settlement: '' });
  const showMunicipalMap = map === 'municipalities' && Boolean(region) && level !== 'region';

  return <>
    <div className="objective-controls">
      <label>Уровень территории<select value={level} onChange={event => {
        const next = event.target.value as ObjectiveLevel;
        change({ ...selection, level: next, settlement: '' });
        if (next === 'region' && map === 'municipalities') setMap(undefined);
      }}>
        {Object.entries(levels).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
      </select></label>
      <label>Субъект РФ<select value={region} onChange={event => selectRegion(event.target.value)}>
        <option value="">Выберите субъект РФ</option>
        {regions.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      {level !== 'region' ? <TerritorySelect label="Муниципальное образование" value={municipality}
        options={municipalities} disabled={!region || !municipalities.length} onChange={selectMunicipality} /> : null}
      {level === 'lower' ? <TerritorySelect label="Городское или сельское поселение" value={settlement}
        options={settlements} disabled={!municipality || !settlements.length}
        onChange={value => change({ ...selection, settlement: value })} /> : null}
    </div>
    <div className="objective-map-controls">
      <button type="button" className="button button-secondary" aria-expanded={map === 'regions'}
        onClick={() => setMap(map === 'regions' ? undefined : 'regions')}>
        <MapPinned size={17} aria-hidden />Карта России
      </button>
      {level !== 'region' ? <button type="button" className="button button-secondary" aria-expanded={showMunicipalMap}
        disabled={!region} onClick={() => setMap(showMunicipalMap ? undefined : 'municipalities')}>
        <MapPinned size={17} aria-hidden />Карта муниципалитетов
      </button> : null}
    </div>
    {map ? <Suspense fallback={<p role="status">Загружаем карту…</p>}>
      {map === 'regions' ? <RegionMap regions={regions.map(value => ({ ...value, hasDocument: true }))}
        selectedRegionId={region || null} onSelect={selectRegion} allocation={false} purpose="territories" compact /> : null}
      {showMunicipalMap ? <MunicipalMapPicker regionId={region} options={municipalities}
        value={municipality} onChange={selectMunicipality} /> : null}
    </Suspense> : null}
  </>;
}
