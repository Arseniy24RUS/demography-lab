import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  CalendarDays,
  CheckSquare,
  MapPin,
  RefreshCw,
  Upload,
} from 'lucide-react';
import type {
  SessionAreaActions,
  SessionAreaState,
  SessionScope,
} from '../../../../packages/collaboration/types';
import type { CorpusManifest } from '../lib/corpus';
import { readable } from '../lib/corpus';
import type { SessionApi } from '../lib/session-api';
import type { useBarriers } from '../hooks/useBarriers';
import { useRoadmaps } from '../hooks/useRoadmaps';
import { TerritoryPanel, useTerritoryDataset } from './roadmaps/TerritoryPanel';
import { DiagnosticWorkbench } from './roadmaps/DiagnosticWorkbench';
import { ActivityWorkbench } from './roadmaps/ActivityWorkbench';
import { CalendarResources } from './roadmaps/CalendarResources';
import { ReviewExport } from './roadmaps/ReviewExport';
import { RoadmapItemEditor } from './roadmaps/RoadmapItemEditor';
import { Note, roadmapTabs, useRoadmapTask } from './roadmaps/common';
import type { EditorTarget, RoadmapTab } from './roadmaps/common';
import '../roadmaps.css';

const tabIcons = {
  territory: MapPin,
  diagnosis: BarChart3,
  activities: CheckSquare,
  resources: CalendarDays,
  review: Upload,
};
export function ConnectedRoadmaps({
  state,
  sessionActions,
  api,
  barriers,
  manifest,
}: {
  state: SessionAreaState;
  sessionActions: SessionAreaActions;
  api: SessionApi | null;
  barriers: ReturnType<typeof useBarriers>;
  manifest: CorpusManifest;
}) {
  const session = state.snapshot?.session ?? null;
  const [tab, setTab] = useState<RoadmapTab>('territory'),
    [selectedKey, setSelectedKey] = useState<string | null>(null),
    [editor, setEditor] = useState<EditorTarget | null>(null);
  const opening = useRef(false);
  const controller = useRoadmaps({
    api,
    sessionId: session?.id ?? null,
    userId: state.auth.userId,
    enabled: Boolean(session && state.auth.status === 'signed-in'),
    presenceActive: tab !== 'territory',
  });
  const data = useTerritoryDataset(),
    task = useRoadmapTask();
  const { index, snapshot } = controller,
    editable = Boolean(
      snapshot?.canEdit && session?.status === 'open' && session.role !== 'observer',
    );
  useEffect(() => {
    setEditor(null);
    if (snapshot) setSelectedKey(snapshot.territory.key);
  }, [snapshot?.roadmapId]);
  const rooms = useMemo(() => new Map(index?.rooms.map(room => [room.territory.key, room.id])), [index?.rooms]);
  const teamCounts = useMemo(() => controller.presenceCounts
    ? new Map([...rooms].map(([key, id]) => [key, controller.presenceCounts?.get(id) ?? 0]))
    : null, [rooms, controller.presenceCounts]);
  if (!session) return <p>Выберите учебное занятие.</p>;
  const isHost = session.role === 'host',
    editionMatches =
      !index?.configuration.dataEditionId ||
      index.configuration.dataEditionId === data.index?.editionId;
  const selectedTerritory = data.registry?.records.find(
    (record) => record.territoryKey === snapshot?.territory.key,
  );
  const workspace = snapshot ? { snapshot, controller, editable, onEdit: setEditor } : null;
  const canJoin = session.role !== 'observer' && session.status === 'open' && editionMatches;
  const regions = manifest.documents.map((entry) => ({
    id: entry.regionId,
    name: entry.territory,
    hasDocument: readable(entry),
  }));

  async function openTerritory(key: string) {
    if (!index || !data.index || opening.current || controller.busy || task.working) return;
    setEditor(null);
    if (!canJoin) {
      const existing = rooms.get(key);
      if (existing) {
        controller.actions.select(existing);
        setSelectedKey(key);
        setTab('diagnosis');
      }
      return;
    }
    opening.current = true;
    try {
      await controller.actions.join({
        territoryKey: key,
        dataEditionId: data.index.editionId,
        expectedAssignmentRevision: index.assignmentRevision,
      });
      setSelectedKey(key);
      setTab('diagnosis');
    } catch {
      // The controller reports the rejected selection and keeps the picker open.
    } finally {
      opening.current = false;
    }
  }

  return (
    <section className="rm-workspace" aria-label="Дорожные карты">
      <header className="rm-heading">
        <div>
          <h2>Дорожные карты</h2>
          {tab !== 'territory' && snapshot ? <p>{snapshot.territory.name}</p> : null}
        </div>
        <div className="rm-actions">
          {tab !== 'territory' ? <button type="button" className="button button-secondary" onClick={() => {
            setEditor(null);
            setTab('territory');
          }}>К территориям</button> : null}
          <button
            className="icon-button"
            aria-label="Обновить дорожные карты"
            disabled={controller.busy}
            onClick={() => void controller.actions.refresh()}
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </header>
      {tab !== 'territory' ? <nav className="rm-tabs" aria-label="Разделы дорожной карты">
        {roadmapTabs.filter(([key]) => key !== 'territory').map(([key, label]) => {
          const Icon = tabIcons[key];
          return (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              aria-current={tab === key ? 'page' : undefined}
              disabled={!snapshot}
              onClick={() => {
                setTab(key);
                setEditor(null);
              }}
            >
              <Icon size={18} />
              {label}
            </button>
          );
        })}
      </nav> : null}
      {controller.error ? (
        <p className="session-message" data-tone="error" role="alert">
          {controller.error}
        </p>
      ) : null}
      {task.feedback}
      {!editionMatches ? (
        <Note warning>
          Занятие закреплено за другим выпуском территориальных данных. Сохранённые материалы
          доступны; для выбора новых территорий и расчётов нужен соответствующий выпуск приложения.
        </Note>
      ) : null}
      {data.error ? (
        <div className="rm-note warning">
          <p role="alert">{data.error}</p>
          <button className="button button-secondary" onClick={data.retry}>
            Повторить загрузку справочника
          </button>
        </div>
      ) : null}
      {tab === 'territory' ? (
        <>
          {isHost && index ? (
            <div className="rm-room-settings">
              <label>
                <span>Уровень команд</span>
                <select
                  aria-label="Уровень территориальных команд"
                  disabled={
                    index.configuration.locked || controller.busy || session.status !== 'open'
                  }
                  value={index.configuration.roomLevel}
                  onChange={(event) =>
                    void task.run(() =>
                      controller.actions.configure({
                        roomLevel: event.target.value as SessionScope,
                        expectedRevision: index.configuration.revision,
                      }),
                    )
                  }
                >
                  <option value="municipality">Муниципалитетов</option>
                  <option value="region">Регионов</option>
                  <option value="federal">Российской Федерации</option>
                </select>
              </label>
            </div>
          ) : null}
          {data.index && data.registry && index ? (
            <TerritoryPanel
              index={data.index}
              registry={data.registry}
              scope={index.configuration.roomLevel}
              initialRegionId={session.regionId}
              teamCounts={teamCounts}
              selectedKey={selectedKey}
              onSelect={key => void openTerritory(key)}
              canOpen={key => canJoin || rooms.has(key)}
              busy={controller.busy || task.working}
            />
          ) : !data.error ? (
            <p className="rm-empty" aria-busy={true}>
              {controller.error
                ? 'Проверьте подключение занятия и миграцию дорожных карт.'
                : 'Загружаем территории…'}
            </p>
          ) : null}
        </>
      ) : !workspace ? (
        <p className="rm-empty" aria-busy={controller.loading}>
          {controller.loading
            ? 'Открываем выбранную дорожную карту…'
            : 'Сначала выберите территорию.'}
        </p>
      ) : tab === 'diagnosis' ? (
        data.index && data.registry && selectedTerritory && editionMatches ? (
          <DiagnosticWorkbench
            key={snapshot!.roadmapId}
            index={data.index}
            registry={data.registry}
            territory={selectedTerritory}
            workspace={workspace}
          />
        ) : (
          <>
            <Note>
              Диагностика по локальному набору недоступна. Можно продолжить работу с ручными
              источниками и сохранёнными разделами.
            </Note>
            <div className="rm-actions">
              <button
                className="button button-secondary"
                disabled={!editable}
                onClick={() => setEditor({ kind: 'fact' })}
              >
                Добавить ручной факт
              </button>
              <button
                className="button button-secondary"
                disabled={!editable}
                onClick={() =>
                  setEditor({
                    kind: 'diagnosis',
                    id: snapshot!.items.find((item) => item.kind === 'diagnosis')!.id,
                  })
                }
              >
                Сформулировать диагноз
              </button>
            </div>
          </>
        )
      ) : tab === 'activities' ? (
        <ActivityWorkbench
          {...workspace}
          barriers={barriers.snapshot}
          readEvidence={barriers.actions.readEvidence}
          onOpenSource={sessionActions.openSource}
          regions={regions}
        />
      ) : tab === 'resources' ? (
        <CalendarResources {...workspace} />
      ) : (
        <ReviewExport {...workspace} isHost={isHost && session.status === 'open'} onTab={setTab} />
      )}
      {editor && workspace ? (
        <RoadmapItemEditor
          key={`${workspace.snapshot.roadmapId}:${editor.kind}:${editor.id ?? 'new'}`}
          {...workspace}
          target={editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </section>
  );
}
