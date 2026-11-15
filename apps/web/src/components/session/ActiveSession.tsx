import { useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { WorkshopActions, WorkshopView } from '../workshop/workshop-ui';
import { ArrowLeft, FileText, RefreshCw } from 'lucide-react';
import { Modal } from '@/components/Modal';
import type {
  SessionAreaActions,
  SessionAreaState,
  SessionRegionOption,
  SessionSnapshot,
  SharedSubmission,
} from '../../../../../packages/collaboration/types';
import type { WorkshopSnapshot } from '../../../../../packages/workshop/types';
import { SessionParticipants } from './SessionParticipants';
import { SharedPracticeCard } from './SharedPracticeCard';
import { SharedPracticeEditModal } from './SharedPracticeEditModal';
import { useResponsiveDisclosure } from './useResponsiveDisclosure';
import {
  dateLabel,
  messageFromError,
  roleLabels,
  timeLabel,
} from './session-ui';

export interface PracticeGrouping {
  snapshot: Pick<WorkshopSnapshot, 'families' | 'boardRevision' | 'round'>;
  saveFamily: WorkshopActions['saveFamily'];
}

type SessionView = 'flipchart' | 'objective' | 'regions' | 'board' | 'barriers' | 'solutions' | 'roadmaps';
type PracticeView = 'voting' | 'publications' | 'families';

export function ActiveSession({
  state,
  snapshot,
  actions,
  regions,
  renderWorkshop,
  renderBarriers,
  renderSolutions,
  renderRoadmaps,
  renderFlipchart,
  renderObjectiveFactors,
  renderLiveVotes,
  practiceGrouping,
}: {
  state: SessionAreaState;
  snapshot: SessionSnapshot;
  actions: SessionAreaActions;
  regions: SessionRegionOption[];
  renderWorkshop?: (view: WorkshopView) => ReactNode;
  renderBarriers?: () => ReactNode;
  renderSolutions?: () => ReactNode;
  renderRoadmaps?: () => ReactNode;
  renderFlipchart?: () => ReactNode;
  renderObjectiveFactors?: () => ReactNode;
  renderLiveVotes?: () => ReactNode;
  practiceGrouping?: PracticeGrouping;
}) {
  const id = useId();
  const { session, submissions, members } = snapshot;
  const [filter, setFilter] = useState<'all' | 'mine' | 'withdrawn'>('all');
  const [moderating, setModerating] = useState<SharedSubmission | null>(null);
  const [editing, setEditing] = useState<SharedSubmission | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [contextOpen, setContextOpen] = useResponsiveDisclosure();
  const [workspaceView, setWorkspaceView] = useState<SessionView>(renderFlipchart ? 'flipchart' : 'board');
  const defaultPracticeView = renderLiveVotes ? 'voting' : 'publications';
  const [practiceView, setPracticeView] = useState<PracticeView>(defaultPracticeView);
  const showPublications = workspaceView === 'board' && practiceView === 'publications';
  const workshopView = workspaceView === 'regions'
    ? 'regions'
    : workspaceView === 'board' && practiceView !== 'publications' ? practiceView : null;
  const sceneNavigation = useRef<HTMLElement>(null);
  function selectWorkspace(next: SessionView) {
    setWorkspaceView(next);
    if (next === 'board') setPracticeView(defaultPracticeView);
    if (state.notice && !state.error) actions.clearError();
    if (next === 'objective' || next === 'barriers' || next === 'solutions' || next === 'roadmaps')
      requestAnimationFrame(() => sceneNavigation.current?.scrollIntoView({ block: 'start' }));
  }
  const disabled = state.busy !== null || working;
  const isHost = session.role === 'host';
  const canContribute =
    session.role !== 'observer';
  const families = practiceGrouping?.snapshot.families;
  const grouped = useMemo(() => new Set(families?.flatMap((family) => family.submissionIds)), [families]);
  const canAddToRating = canContribute && session.status === 'open' &&
    practiceGrouping !== undefined && practiceGrouping.snapshot.round?.status !== 'open';
  const practiceViews: ReadonlyArray<readonly [PracticeView, string]> = [
    ['voting', 'Оценка практик'],
    ['publications', 'Опубликованные карточки'],
    ...(canContribute ? [['families', 'Настроить группы'] as const] : []),
  ];
  const regionNames = new Map([
    ...regions.map((region) => [region.id, region.name] as const),
    ['federal', 'Федеральный уровень'],
    ['unknown', 'Территория не определена'],
  ]);
  const publicSubmissions = submissions.filter((item) => item.status === 'shared');
  const visible = showPublications ? submissions
    .filter((item) =>
      filter === 'mine'
        ? item.authorId === state.auth.userId
        : filter === 'withdrawn'
          ? item.status === 'withdrawn'
          : item.status === 'shared',
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)) : [];
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

  function addToRating(submission: SharedSubmission) {
    if (!practiceGrouping || !canAddToRating || grouped.has(submission.id) || disabled) return;
    const title = submission.bundle.practice.title.trim();
    const mechanism = submission.bundle.practice.mechanism.trim();
    if (!title || !mechanism || Array.from(title).length > 300 || Array.from(mechanism).length > 4000) {
      setPracticeView('families');
      return;
    }
    void perform(() => practiceGrouping.saveFamily({
      familyId: null,
      expectedBoardRevision: practiceGrouping.snapshot.boardRevision,
      title,
      mechanism,
      rationale: 'Отдельная опубликованная карточка.',
      submissionIds: [submission.id],
    }));
  }

  return (
    <>
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
              ...(renderFlipchart ? ([['flipchart', 'Субъективные факторы']] as const) : []),
              ...(renderObjectiveFactors ? ([['objective', 'Объективные факторы']] as const) : []),
              ...(renderBarriers ? ([['barriers', 'Барьеры']] as const) : []),
              ['regions', 'Программы'],
              ['board', 'Практики'],
              ...(renderSolutions ? ([['solutions', 'Решения']] as const) : []),
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
      {workspaceView === 'board' && renderWorkshop ? (
        <div className="practice-board-controls" role="group" aria-label="Виды практик">
          {practiceViews.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="session-board-filter"
              aria-pressed={practiceView === key}
              onClick={() => setPracticeView(key)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {workspaceView === 'flipchart'
        ? renderFlipchart?.()
        : workspaceView === 'objective'
        ? renderObjectiveFactors?.()
        : workspaceView === 'roadmaps'
        ? renderRoadmaps?.()
        : workspaceView === 'barriers'
        ? renderBarriers?.()
        : workspaceView === 'solutions'
        ? renderSolutions?.()
        : workshopView === 'voting' && renderLiveVotes
          ? renderLiveVotes()
          : workshopView ? renderWorkshop?.(workshopView) : null}
      <div
        className="session-workspace"
        hidden={!showPublications}
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
            const fromCatalog = Boolean(submission.bundle.catalogSource);
            const inRating = shared && grouped.has(submission.id);
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
                  shared && (isHost || (own && canContribute && !fromCatalog))
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
                onEdit={own && canContribute && shared && !fromCatalog ? () => setEditing(submission) : undefined}
                inRating={inRating}
                onAddToRating={
                  shared && !fromCatalog && canAddToRating && !inRating
                    ? () => addToRating(submission)
                    : undefined
                }
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
                  : 'Выберите готовую меру в каталоге или добавьте свою карточку с цитатой из программы.'}
              </p>
              {filter !== 'withdrawn' ? (
                <button className="button button-secondary" onClick={
                  renderWorkshop ? () => selectWorkspace('regions') : actions.openLocalWork
                }>
                  {renderWorkshop ? 'Перейти к программам' : 'Открыть документы'}
                  <ArrowLeft size={16} className="session-arrow-forward" />
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
