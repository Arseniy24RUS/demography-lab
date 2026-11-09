import { useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  LockKeyhole,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import { Modal } from '@/components/Modal';
import type {
  FrozenFamily,
  ProjectionFrozenFamily,
  VoteValue,
  VotingRound,
} from '../../../../../packages/workshop/types';
import { OpenRoundModal } from './OpenRoundModal';
import { RankingResults } from './RankingResults';
import { PracticeDetails, VariantComparison } from './PracticeDetails';
import type { VariantView } from './PracticeDetails';
import type { ReadyWorkshopProps } from './workshop-ui';
import { dateTimeLabel, regionName, workshopError } from './workshop-ui';
import { useWorkshopTask } from './useWorkshopTask';

const voteLabels = { '1': 'Поддерживаю', '-1': 'Не поддерживаю', '0': 'Не могу оценить' } as const;

export function VotingView({
  session,
  snapshot,
  regions,
  busy,
  actions,
  onOpenSource,
}: ReadyWorkshopProps) {
  const id = useId();
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState<{ id: string; title: string; revision: number } | null>(
    null,
  );
  const [historyId, setHistoryId] = useState('');
  const [historicalRound, setHistoricalRound] = useState<VotingRound | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [activeFamilyId, setActiveFamilyId] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<VariantView | null>(null);
  const [inspectingFamily, setInspectingFamily] = useState<ProjectionFrozenFamily | null>(null);
  const request = useRef(0);
  const task = useWorkshopTask();
  const round = historyId ? historicalRound : snapshot.round;
  const host = session.session.role === 'host';
  const disabled = busy || task.working;
  const activeFamily =
    round?.families.find((family) => family.id === activeFamilyId) ?? round?.families[0];
  const activeIndex = round?.families.findIndex((family) => family.id === activeFamily?.id) ?? -1;
  const answered = round?.families.filter((family) => family.myVote !== null).length ?? 0;
  const canVote = Boolean(
    round?.canVote &&
    round.status === 'open' &&
    !historyId &&
    session.session.status === 'open' &&
    session.session.phase === 'discussion',
  );
  const liveOpen = snapshot.round?.status === 'open';
  const nonemptyFamilyCount = snapshot.families.filter(
    (family) => family.submissionIds.length > 0,
  ).length;

  useEffect(() => {
    request.current++;
    setHistoryId('');
    setHistoricalRound(null);
    setHistoryLoading(false);
    setHistoryError(null);
  }, [snapshot.round?.id]);
  useEffect(() => {
    setActiveFamilyId(round?.families[0]?.id ?? null);
  }, [round?.id]);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );

  async function chooseRound(selectedId: string) {
    const token = ++request.current;
    task.clearError();
    setHistoryError(null);
    setHistoryId(selectedId);
    setHistoricalRound(null);
    if (!selectedId) {
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    try {
      const value = await actions.loadRound(selectedId);
      if (request.current === token) setHistoricalRound(value);
    } catch (cause) {
      if (request.current === token) setHistoryError(workshopError(cause));
    } finally {
      if (request.current === token) setHistoryLoading(false);
    }
  }

  async function vote(family: FrozenFamily, value: VoteValue) {
    if (!round || !canVote) return;
    await task.run(
      () =>
        actions.castVote({
          roundId: round.id,
          familyId: family.id,
          value,
          expectedRevision: family.myVoteRevision,
        }),
      undefined,
      value === null
        ? 'Оценка снята. Для этого семейства у вас нет ответа.'
        : 'Ваша оценка сохранена. Её можно изменить до завершения раунда.',
    );
  }

  function inspect(variant: VariantView) {
    setInspectingFamily(null);
    setInspecting(variant);
  }

  function frozenVariants(family: ProjectionFrozenFamily): VariantView[] {
    return family.variants.map((variant) => ({
      id: variant.submissionId,
      revision: variant.submissionRevision,
      bundle: variant.bundle,
    }));
  }

  return (
    <div className="workshop-voting-view">
      <div className="workshop-section-heading">
        <div>
          <h2>Оцените приоритет адаптации</h2>
          <p>
            Один ответ на семейство. Региональные варианты и правила зафиксированы для каждого
            раунда.
          </p>
        </div>
        {host ? (
          <div className="workshop-voting-host-actions">
            {liveOpen ? (
              <button
                className="button button-primary"
                disabled={disabled}
                onClick={() => {
                  task.clearError();
                  setClosing({
                    id: snapshot.round!.id,
                    title: snapshot.round!.title,
                    revision: snapshot.round!.revision,
                  });
                }}
              >
                Завершить и раскрыть
              </button>
            ) : (
              <button
                className="button button-primary"
                disabled={
                  disabled || nonemptyFamilyCount === 0 || session.session.status !== 'open'
                }
                onClick={() => setOpening(true)}
              >
                Открыть оценивание
              </button>
            )}
          </div>
        ) : null}
      </div>
      {snapshot.rounds.length > 1 ? (
        <div className="workshop-round-history">
          <label htmlFor={`${id}-history`}>Раунд</label>
          <select
            id={`${id}-history`}
            value={historyId}
            disabled={task.working}
            onChange={(event) => void chooseRound(event.target.value)}
          >
            <option value="">{snapshot.round?.title ?? 'Текущий раунд'} · последний</option>
            {snapshot.rounds
              .filter((entry) => entry.id !== snapshot.round?.id)
              .slice()
              .reverse()
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title} · {dateTimeLabel(entry.openedAt)}
                </option>
              ))}
          </select>
        </div>
      ) : null}
      {task.error && !closing ? (
        <p className="session-message" data-tone="error" role="alert">
          {task.error}
        </p>
      ) : null}
      {task.notice ? (
        <p className="workshop-notice" role="status">
          <Check size={16} />
          {task.notice}
        </p>
      ) : null}
      {historyError ? (
        <div className="session-message" data-tone="error" role="alert">
          <div>
            <p>{historyError}</p>
            <button className="button button-secondary" onClick={() => void chooseRound(historyId)}>
              Повторить загрузку раунда
            </button>
          </div>
        </div>
      ) : null}
      {historyLoading ? (
        <div className="workshop-empty" role="status">
          <h3>Открываем сохранённый раунд</h3>
          <p>Загружаем зафиксированные карточки и результаты.</p>
        </div>
      ) : round ? (
        <>
          <section className="workshop-round-context" aria-label="Условия раунда">
            <div>
              <h3>{round.title}</h3>
              <span>
                {round.status === 'open'
                  ? 'Оценивание открыто'
                  : `Завершён ${round.closedAt ? dateTimeLabel(round.closedAt) : ''}`}
              </span>
            </div>
            <p className="workshop-voting-question">{round.promptText}</p>
            <p className="workshop-muted">
              {round.contextScope === 'municipality'
                ? 'Муниципальный'
                : round.contextScope === 'region'
                  ? 'Региональный'
                  : 'Федеральный'}{' '}
              контекст
              {round.contextRegionId ? ` · ${regionName(regions, round.contextRegionId)}` : ''}.
              Семейств: {round.familyCount}. Участников при открытии: {round.eligibleCount}.
            </p>
          </section>
          {round.status === 'open' ? (
            <>
              <div className="workshop-voting-progress">
                <div>
                  <strong>
                    Ваши ответы: {answered} из {round.familyCount}
                  </strong>
                  <progress
                    max={Math.max(1, round.familyCount)}
                    value={answered}
                    aria-label="Ваш охват оценивания"
                  />
                </div>
                <p>
                  Начали оценивание <strong>{round.participatingCount}</strong> из{' '}
                  {round.eligibleCount}
                </p>
              </div>
              {!round.totalsVisible ? (
                <p className="workshop-blind-note">
                  <LockKeyhole size={17} aria-hidden="true" />
                  Текущие итоги скрыты до завершения раунда. Порядок семейств индивидуален.
                </p>
              ) : (
                <p className="workshop-method-note">
                  Преподаватель открыл текущие итоги для повторного обсуждения.
                </p>
              )}
              {!canVote ? (
                <p className="session-message" data-tone="warning">
                  {session.session.status !== 'open' || session.session.phase !== 'discussion'
                    ? 'Оценивание доступно при открытом занятии на этапе обсуждения. Сохранённые ответы остаются в раунде.'
                    : session.session.role === 'observer'
                      ? 'Наблюдатель может читать варианты и основания. Участие в оценивании определяется ролью при открытии раунда.'
                      : 'Вы не входите в состав участников, зафиксированный при открытии. Можно изучить материалы и присоединиться к следующему раунду.'}
                </p>
              ) : null}
              {activeFamily ? (
                <article className="workshop-ballot" aria-labelledby={`${id}-ballot-title`}>
                  <header className="workshop-ballot-navigation">
                    <span>
                      Семейство {activeIndex + 1} из {round.families.length}
                    </span>
                    <div>
                      <button
                        className="icon-button"
                        aria-label="Предыдущее семейство"
                        disabled={activeIndex <= 0 || task.working}
                        onClick={() => setActiveFamilyId(round.families[activeIndex - 1]!.id)}
                      >
                        <ChevronLeft size={19} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Следующее семейство"
                        disabled={activeIndex >= round.families.length - 1 || task.working}
                        onClick={() => setActiveFamilyId(round.families[activeIndex + 1]!.id)}
                      >
                        <ChevronRight size={19} />
                      </button>
                    </div>
                  </header>
                  <h3 id={`${id}-ballot-title`}>{activeFamily.title}</h3>
                  <p className="workshop-ballot-mechanism">{activeFamily.mechanism}</p>
                  <details className="workshop-family-rationale">
                    <summary>Основание объединения вариантов</summary>
                    <p>{activeFamily.rationale}</p>
                  </details>
                  <VariantComparison
                    variants={frozenVariants(activeFamily)}
                    regions={regions}
                    onInspect={inspect}
                    onOpenSource={onOpenSource}
                  />
                  <div
                    className="workshop-vote-controls"
                    role="group"
                    aria-label={`Оценка семейства «${activeFamily.title}»`}
                  >
                    <button
                      className="workshop-vote-button"
                      data-vote="support"
                      aria-pressed={activeFamily.myVote === 1}
                      disabled={disabled || !canVote}
                      onClick={() => void vote(activeFamily, 1)}
                    >
                      <ThumbsUp size={21} />
                      Поддерживаю
                    </button>
                    <button
                      className="workshop-vote-button"
                      data-vote="oppose"
                      aria-pressed={activeFamily.myVote === -1}
                      disabled={disabled || !canVote}
                      onClick={() => void vote(activeFamily, -1)}
                    >
                      <ThumbsDown size={21} />
                      Не поддерживаю
                    </button>
                    <button
                      className="workshop-vote-button"
                      data-vote="neutral"
                      aria-pressed={activeFamily.myVote === 0}
                      disabled={disabled || !canVote}
                      onClick={() => void vote(activeFamily, 0)}
                    >
                      <CircleHelp size={21} />
                      Не могу оценить
                    </button>
                  </div>
                  <div className="workshop-own-vote">
                    <p>
                      {activeFamily.myVote === null ? (
                        'Вы пока не ответили по этому семейству.'
                      ) : (
                        <>
                          Ваша оценка:{' '}
                          <strong>
                            {voteLabels[String(activeFamily.myVote) as keyof typeof voteLabels]}
                          </strong>
                        </>
                      )}
                    </p>
                    {activeFamily.myVote !== null ? (
                      <button
                        className="button button-quiet"
                        disabled={disabled || !canVote}
                        onClick={() => void vote(activeFamily, null)}
                      >
                        <RotateCcw size={14} />
                        Снять оценку
                      </button>
                    ) : null}
                  </div>
                  <p className="workshop-method-note">
                    «Не могу оценить» сохраняется как отдельный ответ. Отсутствие ответа учитывается
                    отдельно.
                  </p>
                </article>
              ) : (
                <p className="workshop-empty">В раунде нет доступных семейств.</p>
              )}
              {round.families.length > 1 ? (
                <div
                  className="workshop-ballot-index"
                  role="group"
                  aria-label="Перейти к семейству в раунде"
                >
                  {round.families.map((family, index) => (
                    <button
                      key={family.id}
                      aria-label={`Семейство ${index + 1}: ${family.title}${family.myVote !== null ? ', оценка сохранена' : ''}`}
                      aria-pressed={family.id === activeFamily?.id}
                      data-answered={family.myVote !== null}
                      disabled={task.working}
                      onClick={() => setActiveFamilyId(family.id)}
                    >
                      {index + 1}
                      {family.myVote !== null ? <Check size={12} aria-hidden="true" /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          {round.totalsVisible ? (
            <RankingResults key={round.id} round={round} onInspectFamily={setInspectingFamily} />
          ) : null}
        </>
      ) : !historyError ? (
        <div className="workshop-empty workshop-voting-empty">
          <LockKeyhole size={30} aria-hidden="true" />
          <h3>Оценивание ещё не началось</h3>
          <p>
            {host
              ? 'Подготовьте семейства, переключите занятие на обсуждение и откройте первый раунд.'
              : 'Преподаватель откроет раунд после сопоставления региональных практик.'}
          </p>
          <p className="workshop-muted">
            Первый раунд скрывает промежуточные результаты. Каждый участник увидит свои ответы;
            общие итоги раскроются после завершения.
          </p>
        </div>
      ) : null}
      {opening ? (
        <OpenRoundModal
          session={session}
          snapshot={snapshot}
          regions={regions}
          busy={busy}
          actions={actions}
          onClose={() => setOpening(false)}
        />
      ) : null}
      {closing ? (
        <Modal
          title="Завершить оценивание и раскрыть итоги"
          onClose={() => {
            if (!task.working) {
              setClosing(null);
              task.clearError();
            }
          }}
          actions={
            <>
              <button
                className="button button-secondary"
                disabled={task.working}
                onClick={() => {
                  setClosing(null);
                  task.clearError();
                }}
              >
                Продолжить оценивание
              </button>
              <button
                className="button button-primary"
                disabled={disabled}
                onClick={() =>
                  void task.run(
                    () => actions.closeRound(closing.id, closing.revision),
                    () => setClosing(null),
                    'Раунд завершён. Результаты доступны группе и на проекторе.',
                  )
                }
              >
                Завершить и раскрыть
              </button>
            </>
          }
        >
          <p className="workshop-modal-lead">{closing.title}</p>
          <p>
            После завершения ответы этого раунда зафиксируются. Для повторного обсуждения можно
            открыть новый раунд с самостоятельными оценками.
          </p>
          {task.error ? (
            <p className="session-message workshop-modal-field" data-tone="error" role="alert">
              {task.error}
            </p>
          ) : null}
        </Modal>
      ) : null}
      {inspecting ? (
        <PracticeDetails
          key={inspecting.id}
          variant={inspecting}
          regions={regions}
          onOpenSource={onOpenSource}
          onClose={() => setInspecting(null)}
        />
      ) : null}
      {inspectingFamily ? (
        <Modal title={inspectingFamily.title} onClose={() => setInspectingFamily(null)} wide>
          <p className="workshop-modal-lead">{inspectingFamily.mechanism}</p>
          <details className="workshop-family-rationale">
            <summary>Основание объединения</summary>
            <p>{inspectingFamily.rationale}</p>
          </details>
          <VariantComparison
            variants={frozenVariants(inspectingFamily)}
            regions={regions}
            onInspect={inspect}
            onOpenSource={onOpenSource}
          />
        </Modal>
      ) : null}
    </div>
  );
}
