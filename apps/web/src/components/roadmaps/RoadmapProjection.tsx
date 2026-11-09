import { useEffect, useState } from 'react';
import { ArrowLeft, Maximize2, Pause, Play, RefreshCw } from 'lucide-react';
import type { SessionApi } from '../../lib/session-api';
import type { RoadmapsProjection } from '../../../../../packages/roadmaps/types';
import type { TerritoryMapPack } from '../../../../../packages/territories/types';
import { computeRoadmapScenarios, assessRoadmapReadiness } from '../../../../../packages/analytics';
import { useRoadmaps } from '../../hooks/useRoadmaps';
import { loadTerritoryMap } from '../../lib/territories';
import { useTerritoryDataset } from './TerritoryPanel';
import { ScenarioChart } from './ScenarioChart';
import { dateLabel, money, Note } from './common';
import '../../roadmaps.css';

export function RoadmapProjection({
  api,
  sessionId,
  userId,
  regionId,
  onExit,
}: {
  api: SessionApi | null;
  sessionId: string | null;
  userId: string | null;
  regionId: string | null;
  onExit(): void;
}) {
  const controller = useRoadmaps({ api, sessionId, userId, projector: true });
  const [held, setHeld] = useState<RoadmapsProjection | null>(null),
    [error, setError] = useState<string | null>(null),
    [scenarioId, setScenarioId] = useState('');
  const data = useTerritoryDataset(),
    [map, setMap] = useState<TerritoryMapPack | null>(null);
  const shown = controller.projection
    ? held?.sessionId === controller.projection.sessionId
      ? held
      : controller.projection
    : null;
  const selected = shown?.selected ?? null,
    scenarios = selected ? computeRoadmapScenarios(selected) : [];
  const scenario = scenarios.find((item) => item.itemId === scenarioId) ?? scenarios[0],
    series =
      scenario?.result && selected
        ? selected.series.find((item) => item.id === scenario.result!.source?.seriesId)
        : null;
  const passport = selected?.items.find(
      (item) => item.status === 'active' && item.kind === 'passport',
    ),
    diagnosis = selected?.items.find(
      (item) => item.status === 'active' && item.kind === 'diagnosis',
    );
  const readiness = selected ? assessRoadmapReadiness(selected) : null;
  const sharedRegionIds = [
    ...new Set(
      shown?.rooms
        .map((room) => room.territory.regionId)
        .filter((id): id is string => Boolean(id)) ?? [],
    ),
  ];
  const mapRegionId = regionId ?? (sharedRegionIds.length === 1 ? sharedRegionIds[0]! : null);
  useEffect(() => {
    let active = true;
    setMap(null);
    if (!data.index || !mapRegionId) return;
    void loadTerritoryMap(data.index, mapRegionId)
      .then((next) => {
        if (active) setMap(next);
      })
      .catch(() => {
        if (active) setMap(null);
      });
    return () => {
      active = false;
    };
  }, [data.index, mapRegionId]);
  function select(id: string | null) {
    setHeld(null);
    setScenarioId('');
    controller.actions.select(id);
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setError('Полноэкранный режим недоступен в этом браузере.');
    }
  }
  return (
    <main id="main-content" className="rm-projection">
      <header className="rm-heading">
        <div>
          <h1>{shown?.title ?? 'Дорожные карты команд'}</h1>
          <p>{selected?.territory.name ?? 'Территориальные проекты: общий ход работы'}</p>
        </div>
        <div className="rm-actions">
          <button className="button button-secondary" onClick={onExit}>
            <ArrowLeft size={17} />К занятию
          </button>
          <button
            className="icon-button"
            aria-label="Полноэкранный режим"
            onClick={() => void fullscreen()}
          >
            <Maximize2 size={19} />
          </button>
        </div>
      </header>
      <div className="rm-projection-controls">
        <select
          aria-label="Дорожная карта для проектора"
          value={controller.selectedId ?? ''}
          onChange={(event) => select(event.target.value || null)}
        >
          <option value="">Все территориальные команды</option>
          {shown?.rooms.map((room) => (
            <option key={room.id} value={room.id}>
              {room.territory.name}
            </option>
          ))}
        </select>
        <div className="rm-actions">
          <button
            className="button button-secondary"
            disabled={!controller.projection}
            onClick={() => setHeld(held ? null : controller.projection)}
          >
            {held ? <Play size={16} /> : <Pause size={16} />}{' '}
            {held ? 'Показать изменения' : 'Зафиксировать показ'}
          </button>
          <button
            className="button button-quiet"
            onClick={() => {
              setHeld(null);
              void controller.actions.refresh();
            }}
          >
            <RefreshCw size={16} />
            Обновить
          </button>
        </div>
      </div>
      {held && shown ? (
        <Note>
          Показ зафиксирован для обсуждения. Команды продолжают работу; их изменения появятся после
          снятия фиксации.
        </Note>
      ) : null}
      {controller.error || error ? (
        <p className="session-message" data-tone="error" role="alert">
          {controller.error ?? error}
        </p>
      ) : null}
      {!shown ? (
        <p className="rm-empty" aria-busy={controller.loading}>
          {controller.loading
            ? 'Получаем общий ход работы…'
            : 'Материалы недоступны этой учётной записи.'}
        </p>
      ) : selected ? (
        <>
          <div className="rm-projection-project">
            <section>
              <span className="rm-eyebrow">
                Редакция {selected.revision} · заполнено {readiness?.completedSections} из 8
                разделов
              </span>
              <h2>
                {passport?.kind === 'passport'
                  ? passport.data.title || 'Проект пока без названия'
                  : 'Проект территории'}
              </h2>
              <p>
                {passport?.kind === 'passport'
                  ? passport.data.goal || 'Цель ещё не сформулирована.'
                  : ''}
              </p>
              <h3>Приоритетная проблема</h3>
              <p>
                {diagnosis?.kind === 'diagnosis'
                  ? diagnosis.data.problem || 'Команда продолжает диагностику.'
                  : ''}
              </p>
              <h3>Ожидаемый результат</h3>
              <p>
                {passport?.kind === 'passport'
                  ? passport.data.expectedResult || 'Не сформулирован.'
                  : ''}
              </p>
            </section>
            <section className="rm-chart-panel">
              {scenarios.length ? (
                <>
                  <label className="rm-field">
                    <span>Сценарий команды</span>
                    <select
                      value={scenario?.itemId ?? ''}
                      onChange={(event) => setScenarioId(event.target.value)}
                    >
                      {scenarios.map((item) => (
                        <option key={item.itemId} value={item.itemId}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  {series && scenario?.result ? (
                    <ScenarioChart series={series} result={scenario.result} compact />
                  ) : (
                    <Note warning>{scenario?.error ?? 'Для сценария нет закреплённого ряда.'}</Note>
                  )}
                  <Note>
                    Разрыв между базой и целью — плановый ориентир команды, не оценка причинного
                    эффекта.
                  </Note>
                </>
              ) : (
                <div className="rm-empty">
                  Сохранённый сценарий появится здесь после работы команды с диагностикой.
                </div>
              )}
            </section>
          </div>
          <div className="rm-budget-totals">
            <div>
              <span>Денежная потребность</span>
              <strong>{money(selected.budget.needCashKopecks)}</strong>
            </div>
            <div>
              <span>Подтверждено</span>
              <strong>{money(selected.budget.confirmedKopecks)}</strong>
            </div>
            <div data-gap={selected.budget.confirmedGapKopecks > 0}>
              <span>Неподтверждено</span>
              <strong>{money(selected.budget.confirmedGapKopecks)}</strong>
            </div>
            <div>
              <span>Заявки и ожидания</span>
              <strong>{money(selected.budget.expectedKopecks)}</strong>
            </div>
          </div>
          <h2>Мероприятия проекта</h2>
          {selected.items
            .filter((item) => item.status === 'active' && item.kind === 'activity')
            .map((item, index) =>
              item.kind === 'activity' ? (
                <article className="rm-activity-card" key={item.id}>
                  <div className="rm-activity-number">{String(index + 1).padStart(2, '0')}</div>
                  <div>
                    <h4>{item.data.title || 'Мероприятие без названия'}</h4>
                    <p>
                      {item.data.deliverable || item.data.description || 'Результат уточняется.'}
                    </p>
                    <span className="rm-muted">
                      {dateLabel(item.data.startDate)} — {dateLabel(item.data.endDate)} ·{' '}
                      {item.data.responsible || 'Исполнитель не назначен'}
                    </span>
                  </div>
                </article>
              ) : null,
            )}
        </>
      ) : (
        <>
          {map ? (
            <div className="rm-projection-map">
              <svg
                viewBox={map.viewBox.join(' ')}
                role="group"
                aria-label="Карта территориальных команд"
              >
                {map.shapes.map((shape) => {
                  const room = shown.rooms.find(
                    (item) => item.territory.key === shape.territoryKey,
                  );
                  return (
                    <g key={shape.territoryKey}>
                      <path
                        d={shape.path}
                        fillRule="evenodd"
                        className="rm-map-shape"
                        data-room={Boolean(room)}
                        data-submitted={room?.latestVersionKind === 'submitted'}
                        tabIndex={room ? 0 : -1}
                        role={room ? 'button' : undefined}
                        aria-label={room?.territory.name}
                        onClick={() => {
                          if (room) select(room.id);
                        }}
                        onKeyDown={(event) => {
                          if (room && (event.key === 'Enter' || event.key === ' ')) {
                            event.preventDefault();
                            select(room.id);
                          }
                        }}
                      >
                        <title>
                          {room
                            ? `${room.territory.name}: ${room.memberCount} участн.`
                            : 'Команда не создана'}
                        </title>
                      </path>
                      {room ? (
                        <text
                          x={shape.labelPoint[0]}
                          y={shape.labelPoint[1]}
                          textAnchor="middle"
                          className="rm-map-label"
                        >
                          {room.territory.name
                            .replace(/муниципальный район/iu, '')
                            .replace(/^Городской округ\s+/iu, '')}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
              <div>
                <strong>{shown.rooms.length}</strong>
                <span>территориальных команд</span>
                <strong>
                  {shown.rooms.filter((room) => room.latestVersionKind === 'submitted').length}
                </strong>
                <span>команд с последней версией к обсуждению</span>
                <p>Светлый контур — команда ещё не создана. Синие территории — карты в работе.</p>
              </div>
            </div>
          ) : null}
          <div className="rm-projection-rooms">
            {shown.rooms.map((room) => (
              <button className="rm-projection-room" key={room.id} onClick={() => select(room.id)}>
                <strong>{room.territory.name}</strong>
                <span>
                  {room.memberCount} участн. · {room.activeItemCount} записей
                </span>
                <span>
                  {room.latestVersionKind === 'submitted'
                    ? 'Версия подготовлена к обсуждению'
                    : room.versionCount
                      ? 'Есть рабочая версия'
                      : 'Проект в разработке'}
                </span>
              </button>
            ))}
          </div>
          {!shown.rooms.length ? (
            <div className="rm-empty">
              Команды появятся, когда участники выберут свои территории.
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
