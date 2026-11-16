import { Activity, lazy, Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  BarChart3,
  CalendarDays,
  ChartLine,
  CheckSquare,
  ClipboardList,
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
import { usePassportAutosave } from '../hooks/usePassportAutosave';
import { TerritoryPanel, useTerritoryDataset } from './roadmaps/TerritoryPanel';
import { DiagnosticWorkbench } from './roadmaps/DiagnosticWorkbench';
import { ActivityWorkbench } from './roadmaps/ActivityWorkbench';
import { PassportWorkbench } from './roadmaps/PassportWorkbench';
import { OrganizationTeams } from './roadmaps/OrganizationTeams';
import { OrganizationDiagnosis } from './roadmaps/OrganizationDiagnosis';
import { CalendarResources } from './roadmaps/CalendarResources';
import { ReviewExport } from './roadmaps/ReviewExport';
import { RoadmapItemEditor } from './roadmaps/RoadmapItemEditor';
import { Note, roadmapTabs, useRoadmapTask } from './roadmaps/common';
import type { EditorTarget, RoadmapTab } from './roadmaps/common';
import '../roadmaps.css';

const tabIcons = {
  territory: MapPin,
  passport: ClipboardList,
  diagnosis: BarChart3,
  forecast: ChartLine,
  activities: CheckSquare,
  resources: CalendarDays,
  review: Upload,
};
const ForecastWorkbench = lazy(() =>
  import('./roadmaps/ForecastWorkbench').then(module => ({ default: module.ForecastWorkbench }))
);
export function ConnectedRoadmaps({
  state,
  sessionActions,
  api,
  barriers,
  manifest,
  leaveGuard,
}: {
  state: SessionAreaState;
  sessionActions: SessionAreaActions;
  api: SessionApi | null;
  barriers: ReturnType<typeof useBarriers>;
  manifest: CorpusManifest;
  leaveGuard?: RefObject<(() => Promise<boolean>) | null>;
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
  const passport = usePassportAutosave(snapshot, controller, editable);
  const root = useRef<HTMLElement | null>(null);
  async function saveBeforeLeaving() {
    const saved = await passport.flush();
    if (!saved) requestAnimationFrame(() => root.current?.querySelector('.rm-passport-form [role="alert"]')
      ?.scrollIntoView({ block: 'center', behavior: 'instant' }));
    return saved;
  }
  const flushPassport = useRef(saveBeforeLeaving);
  flushPassport.current = saveBeforeLeaving;
  useEffect(() => {
    if (!leaveGuard) return;
    const flush = () => flushPassport.current();
    leaveGuard.current = flush;
    return () => { if (leaveGuard.current === flush) leaveGuard.current = null; };
  }, [leaveGuard]);
  useEffect(() => {
    setEditor(null);
    if (snapshot) setSelectedKey(snapshot.territory.key);
  }, [snapshot?.roadmapId]);
  const isOrganization = snapshot?.territory.level === 'organization';
  useEffect(() => {
    if (isOrganization && (tab === 'diagnosis' || tab === 'forecast')) setTab('passport');
  }, [isOrganization, tab]);
  const rooms = useMemo(() => new Map(index?.rooms.filter(room => !room.exampleLabel).map(room => [room.territory.key, room.id])), [index?.rooms]);
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
  const canJoinOrganization = session.role !== 'observer' && session.status === 'open';
  const regions = manifest.documents.map((entry) => ({
    id: entry.regionId,
    name: entry.territory,
    hasDocument: readable(entry),
  }));

  async function openTerritory(key: string) {
    if (!index || !data.index || opening.current || controller.busy || task.working) return;
    if (!await saveBeforeLeaving()) return;
    setEditor(null);
    if (!canJoin) {
      const existing = rooms.get(key);
      if (existing) {
        controller.actions.select(existing);
        setSelectedKey(key);
        setTab('passport');
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
      setTab('passport');
    } catch {
      // The controller reports the rejected selection and keeps the picker open.
    } finally {
      opening.current = false;
    }
  }

  async function openOrganization(roadmapId: string) {
    if (!index || opening.current || controller.busy || task.working || !await saveBeforeLeaving()) return;
    setEditor(null);
    if (!canJoinOrganization) {
      controller.actions.select(roadmapId);
      setTab('passport');
      return;
    }
    opening.current = true;
    try {
      const next = await controller.actions.join({ roadmapId, expectedAssignmentRevision: index.assignmentRevision });
      setSelectedKey(next.territory.key);
      setTab('passport');
    } catch {
      // Keep the team picker visible; the controller reports the rejected join.
    } finally {
      opening.current = false;
    }
  }

  async function createOrganization(name: string) {
    if (!index || opening.current || controller.busy || task.working) throw new Error('Дождитесь завершения текущей операции.');
    if (!await saveBeforeLeaving()) throw new Error('Сначала сохраните изменения паспорта.');
    opening.current = true;
    setEditor(null);
    try {
      const next = await controller.actions.createOrganization({ name, expectedAssignmentRevision: index.assignmentRevision });
      setSelectedKey(next.territory.key);
      setTab('passport');
    } finally {
      opening.current = false;
    }
  }

  async function goToTab(next: RoadmapTab) {
    if (isOrganization && (next === 'diagnosis' || next === 'forecast')) next = 'passport';
    if (next === tab || !await saveBeforeLeaving()) return;
    setEditor(null);
    setTab(next);
  }

  return (
    <section ref={root} className="rm-workspace" aria-label="Дорожные карты">
      <header className="rm-heading">
        <div>
          <h2>Дорожные карты</h2>
          {tab !== 'territory' && snapshot ? <p>{snapshot.exampleLabel ? `${snapshot.exampleLabel} · ` : ''}{snapshot.territory.name}</p> : null}
        </div>
        <div className="rm-actions">
          {tab !== 'territory' ? <button type="button" className="button button-secondary" onClick={() => void goToTab('territory')}>{isOrganization ? 'К командам' : 'К территориям'}</button> : null}
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
        {roadmapTabs.filter(([key]) => key !== 'territory' && (!isOrganization || (key !== 'diagnosis' && key !== 'forecast'))).map(([key, label]) => {
          const Icon = tabIcons[key];
          return (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              aria-current={tab === key ? 'page' : undefined}
              disabled={!snapshot}
              onClick={() => void goToTab(key)}
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
      {tab === 'territory' && index?.rooms.some(room => room.exampleLabel) ? <section className="rm-section" aria-label="Пример дорожной карты">
        <h3>Пример дорожной карты</h3>
        {index.rooms.filter(room => room.exampleLabel).map(room => <div className="rm-actions" key={room.id}>
          <button type="button" className="button button-secondary" disabled={controller.busy} onClick={() => {
            controller.actions.select(room.id);
            setSelectedKey(room.territory.key);
            setTab('passport');
          }}>{room.exampleLabel} · {room.territory.name}</button>
          <span className="rm-muted">Заполненный учебный проект: паспорт, статистика, прогноз, мероприятия, бюджет и готовый документ.</span>
        </div>)}
      </section> : null}
      {tab !== 'territory' && snapshot?.exampleLabel ? <Note>
        Это учебный пример на данных Саранска. Цели, мероприятия и бюджет демонстрируют способ заполнения.
        {!isHost ? ' Пример доступен для просмотра и скачивания; свой проект создайте через выбор территории или команды.' : ''}
      </Note> : null}
      {!editionMatches && (!isOrganization || tab === 'territory') ? (
        <Note warning>
          Занятие закреплено за другим выпуском территориальных данных. Сохранённые материалы
          доступны; для выбора новых территорий и расчётов нужен соответствующий выпуск приложения.
        </Note>
      ) : null}
      {data.error && (!isOrganization || tab === 'territory') ? (
        <div className="rm-note warning">
          <p role="alert">{data.error}</p>
          <button className="button button-secondary" onClick={data.retry}>
            Повторить загрузку справочника
          </button>
        </div>
      ) : null}
      {workspace ? (
        <Activity mode={tab === 'passport' ? 'visible' : 'hidden'}>
          <PassportWorkbench key={workspace.snapshot.roadmapId} {...workspace} autosave={passport} />
          {isOrganization ? <OrganizationDiagnosis {...workspace} /> : null}
        </Activity>
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
          {index ? <OrganizationTeams rooms={index.rooms} presenceCounts={controller.presenceCounts}
            selectedId={snapshot?.roadmapId ?? null} canJoin={canJoinOrganization}
            busy={controller.busy || task.working}
            onCreate={createOrganization} onJoin={openOrganization} /> : null}
        </>
      ) : !workspace ? (
        <p className="rm-empty" aria-busy={controller.loading}>
          {controller.loading
            ? 'Открываем выбранную дорожную карту…'
            : 'Сначала выберите территорию.'}
        </p>
      ) : tab === 'passport' ? null : tab === 'diagnosis' && !isOrganization ? (
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
              Статистика по локальному набору недоступна. Можно продолжить работу с ручными
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
      ) : tab === 'forecast' && !isOrganization ? (
        <>
          <Suspense fallback={<p className="rm-empty" role="status">Загружаем прогноз…</p>}>
              <ForecastWorkbench key={workspace.snapshot.roadmapId} workspace={workspace} />
          </Suspense>
          {data.index && data.registry && selectedTerritory && editionMatches ? (
            <details className="rm-source-details">
              <summary>Сценарии по отдельным показателям</summary>
              <DiagnosticWorkbench key={workspace.snapshot.roadmapId} index={data.index}
                registry={data.registry} territory={selectedTerritory} workspace={workspace} mode="scenarios" />
            </details>
          ) : null}
        </>
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
        <ReviewExport {...workspace} isHost={isHost && session.status === 'open'} onTab={tab => void goToTab(tab)} flushPassport={passport.flush} />
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
