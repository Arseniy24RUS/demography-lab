import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, MapPin, Search, Users } from 'lucide-react';
import type {
  TerritoryDataIndex,
  TerritoryRecord,
  TerritoryRegistry,
} from '../../../../../packages/territories/types';
import type { RoadmapRoomSummary } from '../../../../../packages/roadmaps/types';
import type { SessionScope } from '../../../../../packages/collaboration/types';
import {
  loadTerritoryIndex,
  loadTerritoryRegistry,
  territoryKindLabel,
} from '../../lib/territories';
import { Note, SectionHeading } from './common';
import { MunicipalMap } from '../geography/MunicipalMap';

const emptyRooms: RoadmapRoomSummary[] = [];

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
  fixedRegionId = null,
  rooms = emptyRooms,
  selectedKey,
  onSelect,
  onJoin,
  onOpenRoom,
  busy = false,
  myRoadmapId = null,
  allowJoin = true,
  publicMode = false,
}: {
  index: TerritoryDataIndex;
  registry: TerritoryRegistry;
  scope?: SessionScope;
  fixedRegionId?: string | null;
  rooms?: RoadmapRoomSummary[];
  selectedKey: string | null;
  onSelect(key: string): void;
  onJoin?: (record: TerritoryRecord) => void;
  onOpenRoom?: (id: string) => void;
  busy?: boolean;
  myRoadmapId?: string | null;
  allowJoin?: boolean;
  publicMode?: boolean;
}) {
  const selected = registry.records.find((record) => record.territoryKey === selectedKey);
  const [regionId, setRegionId] = useState(
    fixedRegionId ?? selected?.regionId ?? 'respublika-mordoviia',
  );
  const [query, setQuery] = useState('');
  const effectiveRegion = fixedRegionId ?? regionId;
  const records = useMemo(
    () =>
      registry.records
        .filter((record) =>
          scope === 'federal'
            ? record.level === 'federal'
            : scope === 'region'
              ? record.level === 'region' && (!fixedRegionId || record.regionId === fixedRegionId)
              : record.regionId === effectiveRegion && record.level !== 'region',
        )
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [registry, scope, fixedRegionId, effectiveRegion],
  );
  const filtered = records.filter((record) =>
    record.name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')),
  );
  const roomByTerritory = useMemo(() => new Map(rooms.map((room) => [room.territory.key, room])), [rooms]);
  const current =
    selected && records.some((record) => record.territoryKey === selected.territoryKey)
      ? selected
      : null;
  const room = current ? roomByTerritory.get(current.territoryKey) : undefined;
  function pick(record: TerritoryRecord) {
    onSelect(record.territoryKey);
    if (record.regionId && scope === 'region') setRegionId(record.regionId);
  }
  function changeRegion(next: string) {
    setRegionId(next);
    setQuery('');
    const candidate = registry.records.find(
      (record) =>
        record.regionId === next &&
        record.level === (scope === 'region' ? 'region' : 'municipality'),
    );
    if (candidate) onSelect(candidate.territoryKey);
  }
  return (
    <section className="rm-territory-panel" aria-label="Выбор территории">
      <SectionHeading
        title={publicMode ? 'Территории и исходные данные' : 'Выберите территорию команды'}
      >
        {publicMode
          ? 'Карты, источники и сценарные расчёты доступны до входа в занятие.'
          : 'Для каждой территории в занятии создаётся одна общая дорожная карта.'}
      </SectionHeading>
      <div className="rm-territory-filters">
        {scope === 'municipality' ? (
          <label>
            <span className="rm-label">Регион</span>
            <select
              aria-label="Регион территорий"
              value={effectiveRegion}
              disabled={Boolean(fixedRegionId)}
              onChange={(event) => changeRegion(event.target.value)}
            >
              {index.regions.map((item) => (
                <option key={item.regionId} value={item.regionId}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="rm-scope-label">
            <MapPin size={20} />
            {scope === 'federal' ? 'Российская Федерация' : 'Региональные команды'}
          </div>
        )}
        <label>
          <span className="rm-label">Поиск территории</span>
          <div className="rm-search">
            <Search size={17} />
            <input
              type="search"
              placeholder={scope === 'region' ? 'Название региона' : 'Название муниципалитета'}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </label>
      </div>
      <div className="rm-territory-layout">
        <div className="rm-map-column">
          {scope === 'federal' ? (
            <div className="rm-federal-card">
              <MapPin size={48} strokeWidth={1.2} />
              <h3>Федеральная дорожная карта</h3>
              <p>
                Одна межведомственная команда и общие приоритеты. Муниципальные ряды не суммируются
                автоматически в федеральные показатели.
              </p>
              {records[0] ? (
                <button className="button button-secondary" onClick={() => pick(records[0]!)}>
                  Выбрать Российскую Федерацию
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <MunicipalMap
                index={index}
                registry={registry}
                regionId={effectiveRegion}
                selectedKey={selectedKey}
                onSelect={scope === 'municipality' ? onSelect : undefined}
                rooms={roomByTerritory}
              />
              <div className="rm-map-legend">
                <span>
                  <i />
                  Без команды
                </span>
                <span>
                  <i className="working" />
                  Команда работает
                </span>
                <span>
                  <i className="submitted" />
                  Версия к обсуждению
                </span>
                <span>
                  <i className="selected" />
                  Выбрано
                </span>
              </div>
            </>
          )}
          <p className="rm-source-caption">
            Геометрия: RUDN, закреплённая редакция 2025–2026. Названия и границы требуют проверки на
            дату проекта. Все названия доступны в списке.
          </p>
        </div>
        <aside className="rm-territory-inspector" aria-live="polite">
          {current ? (
            <>
              <span className="rm-eyebrow">
                {scope === 'municipality' ? 'Территория команды' : 'Уровень проекта'}
              </span>
              <h3>{current.name}</h3>
              <p className="rm-muted">{territoryKindLabel[current.unitKind]}</p>
              <dl className="rm-details">
                <div>
                  <dt>Команда</dt>
                  <dd>
                    {room
                      ? `${room.memberCount} участн. · ${room.id === myRoadmapId ? 'вы в команде' : 'карта создана'}`
                      : 'Пока не сформирована'}
                  </dd>
                </div>
                <div>
                  <dt>Статистика</dt>
                  <dd>
                    {current.statistics.hasSeries
                      ? 'Доступны сопоставленные ряды'
                      : current.statistics.status === 'ambiguous'
                        ? 'Неоднозначное соответствие'
                        : current.level === 'region' || current.level === 'federal'
                          ? 'Требует отдельного источника'
                          : 'Сопоставленного ряда нет'}
                  </dd>
                </div>
              </dl>
              <Note warning={!current.statistics.hasSeries}>
                {current.statistics.note ||
                  'Исходные данные требуют содержательной проверки команды.'}
              </Note>
              {!current.roomEligible ? (
                <Note warning>
                  Это контекстная единица исходной карты. Муниципальная команда для неё не
                  создаётся: муниципальный статус не подтверждён этим слоем.
                </Note>
              ) : null}
              <div className="rm-inspector-actions">
                {onJoin && allowJoin && current.roomEligible && room?.id !== myRoadmapId ? (
                  <button
                    className="button button-primary"
                    disabled={busy}
                    onClick={() => onJoin(current)}
                  >
                    <Users size={17} />
                    {room ? 'Присоединиться к команде' : 'Создать команду территории'}
                  </button>
                ) : null}
                {room && onOpenRoom ? (
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => onOpenRoom(room.id)}
                  >
                    Открыть дорожную карту
                    <ArrowRight size={17} />
                  </button>
                ) : null}
                {publicMode && current.statistics.hasSeries ? (
                  <p className="rm-muted">
                    Ниже доступны график, сравнение и настройка сценария этой территории.
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="rm-empty">
              <MapPin size={34} />
              <h3>Выберите территорию</h3>
              <p>Нажмите на контур карты или название в списке.</p>
            </div>
          )}
        </aside>
      </div>
      <div className="rm-territory-list">
        <div className="rm-list-caption">
          <h3>Территории {scope === 'municipality' ? 'региона' : ''}</h3>
          <span>
            {filtered.length} из {records.length}
          </span>
        </div>
        <div className="rm-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Территория</th>
                <th>Данные</th>
                <th>Работа команды</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((record) => {
                const linked = roomByTerritory.get(record.territoryKey);
                return (
                  <tr key={record.territoryKey} data-selected={selectedKey === record.territoryKey}>
                    <th>
                      <button
                        className="rm-table-select"
                        aria-pressed={selectedKey === record.territoryKey}
                        onClick={() => pick(record)}
                      >
                        {record.name}
                        <small>{territoryKindLabel[record.unitKind]}</small>
                      </button>
                    </th>
                    <td>
                      {record.statistics.hasSeries
                        ? 'Ряды доступны'
                        : record.statistics.status === 'ambiguous'
                          ? 'Спорное соответствие'
                          : record.level === 'municipality'
                            ? 'Нет сопоставленного ряда'
                            : 'Отдельный источник'}
                    </td>
                    <td>
                      {linked ? (
                        <button
                          className="button button-quiet"
                          onClick={() => onOpenRoom?.(linked.id)}
                          disabled={!onOpenRoom}
                        >
                          <Users size={15} />
                          {linked.memberCount} ·{' '}
                          {linked.latestVersionKind === 'submitted' ? 'К обсуждению' : 'В работе'}
                        </button>
                      ) : (
                        'Нет команды'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
