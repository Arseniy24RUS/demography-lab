import { useEffect, useMemo, useState } from 'react';
import { MapPin, Search } from 'lucide-react';
import type {
  TerritoryDataIndex,
  TerritoryRegistry,
} from '../../../../../packages/territories/types';
import type { SessionScope } from '../../../../../packages/collaboration/types';
import {
  loadTerritoryIndex,
  loadTerritoryRegistry,
  territoryKindLabel,
} from '../../lib/territories';
import { Note, SectionHeading } from './common';
import { MunicipalMap } from '../geography/MunicipalMap';
import { RegionMap } from '../geography/RegionMap';

export function useTerritoryDataset() {
  const [index, setIndex] = useState<TerritoryDataIndex | null>(null),
    [registry, setRegistry] = useState<TerritoryRegistry | null>(null),
    [error, setError] = useState<string | null>(null),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    void loadTerritoryIndex()
      .then(async (next) => {
        const records = await loadTerritoryRegistry(next);
        if (active) {
          setIndex(next);
          setRegistry(records);
        }
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Не удалось загрузить территории.');
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  return { index, registry, error, retry: () => setAttempt((value) => value + 1) };
}
export function TerritoryPanel({
  index,
  registry,
  scope = 'municipality',
  initialRegionId,
  teamCounts = null,
  selectedKey,
  onSelect,
  canOpen,
  busy = false,
  publicMode = false,
}: {
  index: TerritoryDataIndex;
  registry: TerritoryRegistry;
  scope?: SessionScope;
  initialRegionId?: string | null;
  teamCounts?: ReadonlyMap<string, number> | null;
  selectedKey: string | null;
  onSelect(key: string): void;
  canOpen?: (key: string) => boolean;
  busy?: boolean;
  publicMode?: boolean;
}) {
  const selected = registry.records.find((record) => record.territoryKey === selectedKey);
  const [regionId, setRegionId] = useState(() => {
    const preferred = selected?.regionId ?? initialRegionId ?? 'respublika-mordoviia';
    return index.regions.some((region) => region.regionId === preferred)
      ? preferred
      : index.regions[0]?.regionId ?? '';
  });
  const [query, setQuery] = useState('');
  const records = useMemo(
    () => registry.records.filter((record) => {
      if (publicMode) return record.regionId === regionId && record.level !== 'region';
      return record.roomEligible && record.level === scope &&
        (scope !== 'municipality' || record.regionId === regionId);
    }).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [registry, scope, regionId, publicMode],
  );
  const needle = query.trim().toLocaleLowerCase('ru');
  const filtered = records.filter((record) => record.name.toLocaleLowerCase('ru').includes(needle));
  const selectableKeys = useMemo(
    () => new Set(records.filter((record) => canOpen?.(record.territoryKey) ?? true)
      .map((record) => record.territoryKey)),
    [records, canOpen],
  );
  const current = selected && records.includes(selected) ? selected : null;

  function pick(key: string) {
    if (!busy && selectableKeys.has(key)) onSelect(key);
  }

  function changeRegion(next: string) {
    setRegionId(next);
    setQuery('');
    if (publicMode) {
      const candidate = registry.records.find((record) => record.regionId === next && record.level === 'municipality');
      if (candidate) onSelect(candidate.territoryKey);
    }
  }

  const territoryMap = scope === 'region' ? (
    <RegionMap
      regions={records.flatMap((record) => record.regionId && !busy && selectableKeys.has(record.territoryKey)
        ? [{ id: record.regionId, name: record.name, hasDocument: true }]
        : [])}
      selectedRegionId={current?.regionId ?? null}
      onSelect={(id) => {
        const record = records.find((entry) => entry.regionId === id);
        if (record) pick(record.territoryKey);
      }}
      purpose="territories"
    />
  ) : scope === 'municipality' ? (
    <MunicipalMap
      index={index}
      registry={registry}
      regionId={regionId}
      selectedKey={selectedKey}
      onSelect={busy ? undefined : pick}
      selectableKeys={selectableKeys}
    />
  ) : null;

  const list = (
    <div className={publicMode ? 'rm-territory-list' : 'rm-territory-list rm-territory-list-team'}>
      {publicMode ? <div className="rm-list-caption">
        <h3>Территории региона</h3>
        <span>{filtered.length} из {records.length}</span>
      </div> : null}
      <div className="rm-table-scroll">
        <table>
          <thead>
            <tr><th>Территория</th><th>{publicMode ? 'Данные' : 'Сейчас в команде'}</th></tr>
          </thead>
          <tbody>
            {filtered.map((record) => (
              <tr key={record.territoryKey} data-selected={record.territoryKey === selectedKey}>
                <th>
                  <button type="button" className="rm-table-select" disabled={busy || !selectableKeys.has(record.territoryKey)}
                    aria-pressed={publicMode ? selectedKey === record.territoryKey : undefined}
                    onClick={() => pick(record.territoryKey)}>
                    {record.name}
                    {publicMode ? <small>{territoryKindLabel[record.unitKind]}</small> : null}
                  </button>
                </th>
                {publicMode ? <td>
                  {record.statistics.hasSeries
                    ? 'Ряды доступны'
                    : record.statistics.status === 'ambiguous'
                      ? 'Спорное соответствие'
                      : record.level === 'municipality' ? 'Нет сопоставленного ряда' : 'Отдельный источник'}
                </td> : <td className="rm-live-count">{teamCounts ? teamCounts.get(record.territoryKey) ?? 0 : '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length ? <p className="rm-empty">Территории не найдены.</p> : null}
      </div>
    </div>
  );

  return (
    <section className="rm-territory-panel" aria-label="Выбор территории" aria-busy={busy || undefined}>
      <SectionHeading title={publicMode ? 'Территории и исходные данные' : 'Выберите территорию'}>
        {publicMode ? 'Карты, источники и сценарные расчёты доступны до входа в занятие.' : null}
      </SectionHeading>
      {scope !== 'federal' ? <div className="rm-territory-filters">
        {scope === 'municipality' ? (
          <label>
            <span className="rm-label">Регион</span>
            <select aria-label="Регион территорий" value={regionId} disabled={busy}
              onChange={(event) => changeRegion(event.target.value)}>
              {index.regions.map((item) => <option key={item.regionId} value={item.regionId}>{item.name}</option>)}
            </select>
          </label>
        ) : (
          <div className="rm-scope-label"><MapPin size={20} />Субъекты Российской Федерации</div>
        )}
        <label>
          <span className="rm-label">Поиск территории</span>
          <div className="rm-search">
            <Search size={17} aria-hidden="true" />
            <input type="search" placeholder={scope === 'region' ? 'Название региона' : 'Название муниципалитета'}
              value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
        </label>
      </div> : null}
      {publicMode ? (
        <>
          <div className="rm-territory-layout">
            <div className="rm-map-column">
              {territoryMap}
              <p className="rm-source-caption">
                Геометрия: RUDN, закреплённая редакция 2025–2026. Названия и границы требуют проверки на
                дату проекта. Все названия доступны в списке.
              </p>
            </div>
            <aside className="rm-territory-inspector" aria-live="polite">
              {current ? (
                <>
                  <span className="rm-eyebrow">Территория</span>
                  <h3>{current.name}</h3>
                  <p className="rm-muted">{territoryKindLabel[current.unitKind]}</p>
                  <dl className="rm-details"><div>
                    <dt>Статистика</dt>
                    <dd>{current.statistics.hasSeries ? 'Доступны сопоставленные ряды'
                      : current.statistics.status === 'ambiguous' ? 'Неоднозначное соответствие' : 'Сопоставленного ряда нет'}</dd>
                  </div></dl>
                  <Note warning={!current.statistics.hasSeries}>
                    {current.statistics.note || 'Исходные данные требуют содержательной проверки команды.'}
                  </Note>
                  {!current.roomEligible ? <Note warning>
                    Это контекстная единица исходной карты. Муниципальный статус не подтверждён этим слоем.
                  </Note> : null}
                  {current.statistics.hasSeries ? <p className="rm-muted">
                    Ниже доступны график, сравнение и настройка сценария этой территории.
                  </p> : null}
                </>
              ) : <div className="rm-empty">
                <MapPin size={34} /><h3>Выберите территорию</h3><p>Нажмите на контур карты или название в списке.</p>
              </div>}
            </aside>
          </div>
          {list}
        </>
      ) : territoryMap ? <div className="rm-territory-layout rm-team-picker">
        <div className="rm-map-column">{territoryMap}</div>
        {list}
      </div> : list}
    </section>
  );
}
