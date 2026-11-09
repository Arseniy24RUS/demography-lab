import { useEffect, useState } from 'react';
import {
  BarChart3,
  CalendarDays,
  CheckSquare,
  MapPin,
  RefreshCw,
  Upload,
  Users,
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
  const controller = useRoadmaps({
    api,
    sessionId: session?.id ?? null,
    userId: state.auth.userId,
    enabled: Boolean(session && state.auth.status === 'signed-in'),
  });
  const data = useTerritoryDataset(),
    task = useRoadmapTask();
  const [tab, setTab] = useState<RoadmapTab>('territory'),
    [selectedKey, setSelectedKey] = useState<string | null>(null),
    [editor, setEditor] = useState<EditorTarget | null>(null);
  const { index, snapshot } = controller,
    editable = Boolean(
      snapshot?.canEdit && session?.status === 'open' && session.role !== 'observer',
    );
  useEffect(() => {
    setEditor(null);
    if (snapshot) setSelectedKey(snapshot.territory.key);
  }, [snapshot?.roadmapId]);
  if (!session) return <p>Выберите учебное занятие.</p>;
  const isHost = session.role === 'host',
    editionMatches =
      !index?.configuration.dataEditionId ||
      index.configuration.dataEditionId === data.index?.editionId;
  const selectedTerritory = data.registry?.records.find(
    (record) => record.territoryKey === snapshot?.territory.key,
  );
  const workspace = snapshot ? { snapshot, controller, editable, onEdit: setEditor } : null;
  const regions = manifest.documents.map((entry) => ({
    id: entry.regionId,
    name: entry.territory,
    hasDocument: readable(entry),
  }));
  return (
    <section className="rm-workspace" aria-label="Дорожные карты">
      <header className="rm-heading">
        <div>
          <h2>Дорожные карты</h2>
          <p>
            {snapshot?.territory.name ??
              (session.regionId
                ? manifest.documents.find((entry) => entry.regionId === session.regionId)?.territory
                : 'Территориальные команды')}
          </p>
        </div>
        <div className="rm-actions">
          <button className="button button-secondary" onClick={() => setTab('territory')}>
            <Users size={17} />
            Все команды{index ? ` · ${index.rooms.length}` : ''}
          </button>
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
      <nav className="rm-tabs" aria-label="Разделы дорожной карты">
        {roadmapTabs.map(([key, label]) => {
          const Icon = tabIcons[key];
          return (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              aria-current={tab === key ? 'page' : undefined}
              disabled={key !== 'territory' && !snapshot}
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
      </nav>
      {snapshot ? (
        <div className="rm-team-strip">
          <span>
            <Users size={15} />
            {snapshot.members.length
              ? snapshot.members.map((member) => member.fullName).join(' · ')
              : 'В команде пока нет участников'}
          </span>
          <span>
            {editable ? 'Общая карта команды' : 'Режим чтения'} · редакция {snapshot.revision}
          </span>
        </div>
      ) : null}
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
                <span>Команды разрабатывают карты для</span>
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
              <p>
                {index.configuration.locked
                  ? 'Уровень и выпуск данных закреплены после создания первой команды.'
                  : 'Уровень можно выбрать до создания первой команды.'}
              </p>
            </div>
          ) : null}
          {data.index && data.registry && index ? (
            <TerritoryPanel
              index={data.index}
              registry={data.registry}
              scope={index.configuration.roomLevel}
              fixedRegionId={session.regionId}
              rooms={index.rooms}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              myRoadmapId={index.myRoadmapId}
              busy={controller.busy || task.working}
              allowJoin={session.role !== 'observer' && session.status === 'open' && editionMatches}
              onJoin={(record) =>
                void task.run(async () => {
                  await controller.actions.join({
                    territoryKey: record.territoryKey,
                    dataEditionId: data.index!.editionId,
                    expectedAssignmentRevision: index.assignmentRevision,
                  });
                  setSelectedKey(record.territoryKey);
                  setTab('diagnosis');
                }, 'Вы присоединились к общей дорожной карте территории.')
              }
              onOpenRoom={(id) => {
                controller.actions.select(id);
                setTab('diagnosis');
              }}
            />
          ) : !data.error ? (
            <p className="rm-empty" aria-busy={true}>
              {controller.error
                ? 'Проверьте подключение занятия и миграцию дорожных карт.'
                : 'Загружаем территории и состав команд…'}
            </p>
          ) : null}
        </>
      ) : !workspace ? (
        <p className="rm-empty" aria-busy={controller.loading}>
          {controller.loading
            ? 'Открываем выбранную дорожную карту…'
            : 'Сначала выберите команду территории.'}
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
