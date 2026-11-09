import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { WorkshopView } from '../workshop/workshop-ui';
import { ArrowLeft, BookOpen, FileText, Monitor, RefreshCw } from 'lucide-react';
import { Modal } from '@/components/Modal';
import type {
  SessionAreaActions,
  SessionAreaState,
  SessionRegionOption,
  SessionSnapshot,
  SharedSubmission,
} from '../../../../../packages/collaboration/types';
import { HostControls } from './HostControls';
import { SessionParticipants } from './SessionParticipants';
import { SharedPracticeCard } from './SharedPracticeCard';
import { SharedPracticeEditModal } from './SharedPracticeEditModal';
import { useResponsiveDisclosure } from './useResponsiveDisclosure';
import {
  dateLabel,
  messageFromError,
  roleLabels,
  scopeLabels,
  timeLabel,
} from './session-ui';

export function ActiveSession({
  state,
  snapshot,
  actions,
  regions,
  renderWorkshop,
  renderBarriers,
  renderRoadmaps,
  renderFlipchart,
  renderLiveVotes,
}: {
  state: SessionAreaState;
  snapshot: SessionSnapshot;
  actions: SessionAreaActions;
  regions: SessionRegionOption[];
  renderWorkshop?: (view: WorkshopView) => ReactNode;
  renderBarriers?: () => ReactNode;
  renderRoadmaps?: () => ReactNode;
  renderFlipchart?: () => ReactNode;
  renderLiveVotes?: () => ReactNode;
}) {
  const id = useId();
  const { session, submissions, members } = snapshot;
  const [filter, setFilter] = useState<'all' | 'mine' | 'withdrawn'>('all');
  const [moderating, setModerating] = useState<SharedSubmission | null>(null);
  const [editing, setEditing] = useState<SharedSubmission | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [contextOpen, setContextOpen] = useResponsiveDisclosure();
  const [workspaceView, setWorkspaceView] = useState<'flipchart' | 'board' | 'barriers' | 'roadmaps' | WorkshopView>(renderFlipchart ? 'flipchart' : 'board');
  const sceneNavigation = useRef<HTMLElement>(null);
  function selectWorkspace(next: typeof workspaceView) {
    setWorkspaceView(next);
    if (state.notice && !state.error) actions.clearError();
    if (next === 'barriers' || next === 'roadmaps')
      requestAnimationFrame(() => sceneNavigation.current?.scrollIntoView({ block: 'start' }));
  }
  const disabled = state.busy !== null || working;
  const isHost = session.role === 'host';
  const canContribute =
    session.role !== 'observer';
  const regionNames = new Map([
    ...regions.map((region) => [region.id, region.name] as const),
    ['federal', 'Федеральный уровень'],
    ['unknown', 'Территория не определена'],
  ]);
  const publicSubmissions = submissions.filter((item) => item.status === 'shared');
  const visible = submissions
    .filter((item) =>
      filter === 'mine'
        ? item.authorId === state.auth.userId
        : filter === 'withdrawn'
          ? item.status === 'withdrawn'
          : item.status === 'shared',
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const latest = [...submissions]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 3);
  const quoteCount = publicSubmissions.reduce(
    (sum, item) => sum + item.bundle.occurrences.length,
    0,
  );
  const currentEditing = editing
    ? (submissions.find((item) => item.id === editing.id) ?? editing)
    : null;

  async function perform(action: () => Promise<void>, success?: () => void) {
    setError('');
    setWorking(true);
    try {
      await action();
      success?.();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <div className="session-workspace-toolbar">
        <p className="workspace-territory">
          {session.regionId ? regionNames.get(session.regionId) ?? session.regionId : 'Российская Федерация'}
          <span> · {scopeLabels[session.scope]} уровень</span>
        </p>
        <div className="session-action-row">
          <button className="button button-secondary" onClick={actions.openLocalWork} aria-label="Работать с документами">
            <BookOpen size={16} />
            <span className="workspace-action-full" aria-hidden="true">Работать с документами</span>
            <span className="workspace-action-short" aria-hidden="true">Документы</span>
          </button>
          <button className="button button-primary" onClick={actions.openProjector} aria-label="Экран проектора">
            <Monitor size={17} />
            <span className="workspace-action-full" aria-hidden="true">Экран проектора</span>
            <span className="workspace-action-short" aria-hidden="true">Проектор</span>
          </button>
        </div>
      </div>
      {isHost ? (
        <HostControls
          session={session}
          busy={disabled}
          actions={actions}
          regions={regions}
        />
      ) : null}
      {session.role === 'observer' ? (
        <p className="session-message">
          Вы участвуете как наблюдатель. Можно читать общую доску и открывать документальные
          основания практик.
        </p>
      ) : null}
      {error && !moderating ? (
        <p className="session-message" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
      {renderWorkshop ? (
        <nav
          className="workshop-scene-tabs"
          ref={sceneNavigation}
          aria-label="Этапы коллективной работы"
        >
          {(
            [
              ...(renderFlipchart ? ([['flipchart', 'Флипчарт']] as const) : []),
              ...(renderBarriers ? ([['barriers', 'Барьеры']] as const) : []),
              ['regions', 'Программы'],
              ['board', 'Практики'],
              ['families', 'Группировка'],
              ['voting', 'Рейтинг'],
              ...(renderRoadmaps ? ([['roadmaps', 'Дорожные карты']] as const) : []),
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={workspaceView === key ? 'active' : ''}
              aria-current={workspaceView === key ? 'page' : undefined}
              onClick={() => selectWorkspace(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      ) : null}
      {workspaceView === 'flipchart'
        ? renderFlipchart?.()
        : workspaceView === 'roadmaps'
        ? renderRoadmaps?.()
        : workspaceView === 'barriers'
        ? renderBarriers?.()
        : workspaceView === 'voting' && renderLiveVotes
          ? renderLiveVotes()
          : renderWorkshop && workspaceView !== 'board'
          ? renderWorkshop(workspaceView)
          : null}
      <div
        className="session-workspace"
        hidden={workspaceView !== 'board'}
      >
        <aside className="session-sidebar" aria-label="Контекст занятия">
          <details
            className="session-context-disclosure"
            open={contextOpen}
            onToggle={(event) => setContextOpen(event.currentTarget.open)}
          >
            <summary>Контекст и участники</summary>
            <div>
              <section className="session-sidebar-section">
                <h2>Контекст</h2>
                <p>
                  {scopeLabels[session.scope]} уровень
                  {session.regionId
                    ? ` · ${regionNames.get(session.regionId) ?? session.regionId}`
                    : ' · Российская Федерация'}
                </p>
                <p className="session-form-footer">
                  Ваша роль: {roleLabels[session.role].toLocaleLowerCase('ru')}.
                </p>
              </section>
              <SessionParticipants
                members={members}
              />
              <section className="session-sidebar-section">
                <h2>Материалы обсуждения</h2>
                <p>
                  Опубликовано практик: <strong>{publicSubmissions.length}</strong>. Документальных
                  фрагментов: <strong>{quoteCount}</strong>.
                </p>
                {state.lastSyncedAt ? (
                  <p className="session-hint session-form-footer">
                    Обновлено в {timeLabel(state.lastSyncedAt)}
                  </p>
                ) : null}
              </section>
              {latest.length ? (
                <details className="session-sidebar-section">
                  <summary>Последние изменения</summary>
                  <div className="session-event-log">
                    {latest.map((item) => (
                      <div key={item.id}>
                        <p>
                          {item.status === 'withdrawn'
                            ? 'Снята с доски'
                            : item.revision === 1
                              ? 'Опубликована'
                              : 'Обновлена'}{' '}
                          карточка «{item.bundle.practice.title}».
                        </p>
                        <time dateTime={item.updatedAt}>{dateLabel(item.updatedAt)}</time>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          </details>
        </aside>
        <section className="session-board" aria-labelledby={`${id}-board`}>
          <div className="session-board-toolbar">
            <div>
              <h2 id={`${id}-board`}>Общая доска практик</h2>
              <p>Содержание меры, документальные основания и сопоставление автора.</p>
            </div>
            <button
              className="button button-quiet"
              disabled={disabled}
              onClick={() => void perform(actions.refresh)}
            >
              <RefreshCw size={16} />
              Обновить
            </button>
          </div>
          <div className="session-board-filter-row">
            <div className="session-board-filters" role="group" aria-label="Отбор публикаций">
              <button
                className="session-board-filter"
                aria-pressed={filter === 'all'}
                onClick={() => setFilter('all')}
              >
                Все публикации
              </button>
              <button
                className="session-board-filter"
                aria-pressed={filter === 'mine'}
                onClick={() => setFilter('mine')}
              >
                Мои
              </button>
              {isHost ? (
                <button
                  className="session-board-filter"
                  aria-pressed={filter === 'withdrawn'}
                  onClick={() => setFilter('withdrawn')}
                >
                  Снятые
                </button>
              ) : null}
            </div>
            <span className="session-hint" role="status">
              Показано: {visible.length}
            </span>
          </div>
          {visible.map((submission) => {
            const own = submission.authorId === state.auth.userId;
            const shared = submission.status === 'shared';
            return (
              <SharedPracticeCard
                key={submission.id}
                submission={submission}
                regionName={
                  regionNames.get(submission.bundle.practice.regionId) ??
                  submission.bundle.practice.regionId
                }
                busy={disabled}
                focused={session.focusSubmissionId === submission.id}
                onOpenSource={actions.openSource}
                onFocus={
                  isHost && shared
                    ? () =>
                        void perform(() =>
                          actions.updateSession(
                            {
                              focusSubmissionId:
                                session.focusSubmissionId === submission.id ? null : submission.id,
                            },
                            session.revision,
                          ),
                        )
                    : undefined
                }
                onWithdraw={
                  shared && (isHost || (own && canContribute))
                    ? () => {
                        setModerating(submission);
                        setError('');
                      }
                    : undefined
                }
                onRestore={
                  !shared && isHost
                    ? () =>
                        void perform(() =>
                          actions.moderateSubmission(submission.id, submission.revision, 'shared'),
                        )
                    : undefined
                }
                onEdit={own && canContribute && shared ? () => setEditing(submission) : undefined}
              />
            );
          })}
          {!visible.length ? (
            <div className="session-empty">
              <FileText size={35} strokeWidth={1.5} aria-hidden="true" />
              <h3>
                {filter === 'withdrawn'
                  ? 'Снятых публикаций нет'
                  : filter === 'mine'
                    ? 'Ваши публикации появятся здесь'
                    : 'Найдём первые практики'}
              </h3>
              <p>
                {filter === 'withdrawn'
                  ? 'Здесь преподаватель может восстановить материалы, снятые с общей доски.'
                  : 'Откройте региональную программу, найдите фрагмент и сопоставьте его с карточкой. Затем отправьте практику в это занятие.'}
              </p>
              {filter !== 'withdrawn' ? (
                <button className="button button-secondary" onClick={actions.openLocalWork}>
                  Открыть документы <ArrowLeft size={16} className="session-arrow-forward" />
                </button>
              ) : null}
            </div>
          ) : null}
          <p className="session-board-footnote">
            Сопоставление автора относится к тексту конкретной редакции. Для оценки актуальности
            меры и её результатов необходимо отдельное обсуждение.
          </p>
        </section>
      </div>
      {moderating ? (
        <Modal
          title="Снять практику с общей доски?"
          onClose={() => {
            if (!disabled) setModerating(null);
          }}
        >
          <p className="modal-intro">
            «{moderating.bundle.practice.title}» перестанет показываться на общей доске и проекторе.
            Преподаватель сможет вернуть публикацию.
          </p>
          {error ? (
            <p className="session-form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="session-action-row">
            <button
              className="button button-primary"
              disabled={disabled}
              onClick={() =>
                void perform(
                  () => actions.moderateSubmission(moderating.id, moderating.revision, 'withdrawn'),
                  () => setModerating(null),
                )
              }
            >
              Снять с доски
            </button>
            <button
              className="button button-secondary"
              disabled={disabled}
              onClick={() => setModerating(null)}
            >
              Оставить
            </button>
          </div>
        </Modal>
      ) : null}
      {currentEditing ? (
        <SharedPracticeEditModal
          key={currentEditing.id}
          submission={currentEditing}
          canEdit={
            canContribute &&
            currentEditing.status === 'shared' &&
            currentEditing.authorId === state.auth.userId
          }
          busy={disabled}
          actions={actions}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
