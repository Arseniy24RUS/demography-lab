import { useState } from 'react';
import { ArrowLeft, Maximize2, Pause, Play, RefreshCw } from 'lucide-react';
import { ProjectorView } from './session/ProjectorView';
import { WorkshopProjectionView } from './workshop/WorkshopProjectionView';
import { RegionMap } from './geography/RegionMap';
import { readable } from '@/lib/corpus';
import type { CorpusManifest } from '@/lib/corpus';
import type { useSession } from '@/hooks/useSession';
import type { useWorkshop } from '@/hooks/useWorkshop';
import type { WorkshopProjection } from '../../../../packages/workshop/types';
import type { BarriersProjection } from '../../../../packages/barriers/types';
import type { useBarriers } from '@/hooks/useBarriers';
import { BarrierProjectionView } from './barriers/BarrierProjectionView';
import { RoadmapProjection } from './roadmaps/RoadmapProjection';
import '../workshop.css';
import '../barriers.css';

export function ProjectorContainer({
  session,
  workshop,
  barriers,
  manifest,
  onExit,
}: {
  session: ReturnType<typeof useSession>;
  workshop: ReturnType<typeof useWorkshop>;
  barriers: ReturnType<typeof useBarriers>;
  manifest: CorpusManifest;
  onExit: () => void;
}) {
  const [mode, setMode] = useState<
    'cards' | 'regions' | 'ranking' | 'path' | 'links' | 'solutions' | 'roadmaps'
  >('cards');
  const [held, setHeld] = useState<WorkshopProjection | null>(null);
  const [heldBarriers, setHeldBarriers] = useState<BarriersProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A revoked reader must not retain a previously frozen display as an active projection.
  const shown = workshop.projection
    ? held?.sessionId === workshop.projection.sessionId
      ? held
      : workshop.projection
    : null;
  const shownBarriers = barriers.projection
    ? heldBarriers?.sessionId === barriers.projection.sessionId
      ? heldBarriers
      : barriers.projection
    : null;
  const barrierScene = mode === 'path' || mode === 'links' || mode === 'solutions';
  const frozen = barrierScene
    ? Boolean(heldBarriers && shownBarriers === heldBarriers)
    : Boolean(held && shown === held);
  const pending =
    held && workshop.projection ? Math.max(0, workshop.projection.cursor - held.cursor) : 0;
  const regions = manifest.documents.map((entry) => ({
    id: entry.regionId,
    name: entry.territory,
    hasDocument: readable(entry),
    documentTitle: entry.title,
  }));
  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      await Promise.all([
        session.actions.refresh(),
        workshop.actions.refresh(),
        barriers.refresh(),
      ]);
      setHeld(null);
      setHeldBarriers(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось обновить показ.');
    } finally {
      setBusy(false);
    }
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setError('Браузер не разрешил полноэкранный режим. Продолжайте в обычном окне.');
    }
  }
  return (
    <div className="projection-container">
      <nav className="projection-mode-tabs" aria-label="Сцены проектора">
        {(
          [
            ['cards', 'Карточки'],
            ['regions', 'Карта'],
            ['ranking', 'Рейтинг'],
            ['path', 'Барьеры'],
            ['links', 'Связи'],
            ['solutions', 'Решения'],
            ['roadmaps', 'Дорожные карты'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={mode === key ? 'active' : ''}
            aria-current={mode === key ? 'page' : undefined}
          >
            {label}
          </button>
        ))}
      </nav>
      {mode === 'roadmaps' ? (
        <RoadmapProjection key={`${session.sessionId}:${session.state.auth.userId}`} api={session.api} sessionId={session.sessionId} userId={session.state.auth.userId} regionId={session.state.snapshot?.session.regionId ?? null} onExit={onExit} />
      ) : mode === 'cards' ? (
        <ProjectorView
          projection={session.projection}
          connection={session.state.connection}
          lastSyncedAt={session.state.lastSyncedAt}
          error={session.state.error}
          onRefresh={session.actions.refresh}
          onExit={onExit}
        />
      ) : (
        <main id="main-content" className="workshop-projection-page">
          <header className="workshop-projection-heading">
            <div>
              <h1>
                {(barrierScene ? shownBarriers?.title : shown?.title) ?? 'Коллективная работа'}
              </h1>
              <p>
                {mode === 'regions'
                  ? 'Работа с региональными программами'
                  : mode === 'ranking'
                    ? 'Оценка участников сессии'
                    : 'Барьеры родительства, основания и предложения'}
              </p>
            </div>
            <div className="session-action-row">
              <button className="button button-secondary" onClick={onExit}>
                <ArrowLeft size={17} />К занятию
              </button>
              <button
                className="icon-button"
                onClick={() => void fullscreen()}
                aria-label="Полноэкранный режим"
              >
                <Maximize2 size={19} />
              </button>
            </div>
          </header>
          <div className="projection-display-controls">
            <button
              className="button button-secondary"
              disabled={barrierScene ? !barriers.projection : !workshop.projection}
              onClick={() =>
                barrierScene
                  ? setHeldBarriers(frozen ? null : barriers.projection)
                  : setHeld(frozen ? null : workshop.projection)
              }
            >
              {frozen ? <Play size={16} /> : <Pause size={16} />}
              {frozen
                ? `Показать изменения${!barrierScene && pending ? ` (${pending})` : ''}`
                : 'Зафиксировать показ'}
            </button>
            <button className="button button-quiet" disabled={busy} onClick={() => void refresh()}>
              <RefreshCw size={16} />
              Обновить
            </button>
            {frozen ? <span role="status">Композиция зафиксирована для обсуждения.</span> : null}
          </div>
          {barrierScene ? (
            <>
              {(error ?? barriers.error ?? session.state.error) ? (
                <p className="session-message" data-tone="error" role="alert">
                  {error ?? barriers.error ?? session.state.error}
                </p>
              ) : null}
              {shownBarriers ? (
                <BarrierProjectionView snapshot={shownBarriers} mode={mode} />
              ) : (
                <p aria-busy={barriers.loading}>
                  {barriers.loading
                    ? 'Загружаем коллективную работу…'
                    : 'Проекция пока недоступна.'}
                </p>
              )}
            </>
          ) : (
            <WorkshopProjectionView
              mode={mode}
              projection={shown}
              regions={regions}
              loading={workshop.loading}
              error={error ?? workshop.error ?? session.state.error}
              renderMap={({ selectedRegionId, onSelect }) => (
                <RegionMap
                  regions={regions}
                  work={shown?.regionWork}
                  selectedRegionId={selectedRegionId}
                  onSelect={onSelect}
                  compact
                />
              )}
            />
          )}
        </main>
      )}
    </div>
  );
}
