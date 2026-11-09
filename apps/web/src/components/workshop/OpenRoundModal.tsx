import { useId, useState } from 'react';
import { Clock3, LockKeyhole } from 'lucide-react';
import { Modal } from '@/components/Modal';
import type { ResultsVisibility } from '../../../../../packages/workshop/types';
import type { ReadyWorkshopProps } from './workshop-ui';
import { regionName } from './workshop-ui';
import { useWorkshopTask } from './useWorkshopTask';

export function OpenRoundModal({
  session,
  snapshot,
  regions,
  busy,
  actions,
  onClose,
}: Pick<ReadyWorkshopProps, 'session' | 'snapshot' | 'regions' | 'busy' | 'actions'> & {
  onClose: () => void;
}) {
  const id = useId();
  const eligible = session.members.filter((member) => member.role !== 'observer').length;
  const activeIds = new Set(
    session.submissions
      .filter((submission) => submission.status === 'shared')
      .map((submission) => submission.id),
  );
  const families = snapshot.families.filter((family) =>
    family.submissionIds.some((submissionId) => activeIds.has(submissionId)),
  );
  const [title, setTitle] = useState(`Раунд ${snapshot.rounds.length + 1}`);
  const [prompt, setPrompt] = useState(
    'Считаете ли Вы эту практику приоритетной для адаптации в выбранном контексте?',
  );
  const [visibility, setVisibility] = useState<ResultsVisibility>('after_close');
  const [coverage, setCoverage] = useState('70');
  const [minVotes, setMinVotes] = useState(String(Math.max(1, Math.min(3, eligible))));
  const [seconds, setSeconds] = useState('30');
  const [revision, setRevision] = useState(snapshot.boardRevision);
  const task = useWorkshopTask();
  const coverageNumber = Number(coverage);
  const minVotesNumber = Number(minVotes);
  const secondsNumber = Number(seconds);
  const valid =
    title.trim().length > 0 &&
    prompt.trim().length > 0 &&
    coverage !== '' &&
    Number.isFinite(coverageNumber) &&
    coverageNumber >= 0 &&
    coverageNumber <= 100 &&
    minVotes !== '' &&
    Number.isInteger(minVotesNumber) &&
    minVotesNumber >= 1 &&
    minVotesNumber <= Math.max(eligible, 1);
  const canOpen =
    session.session.status === 'open' &&
    session.session.phase === 'discussion' &&
    session.session.role === 'host' &&
    snapshot.round?.status !== 'open' &&
    families.length > 0 &&
    eligible > 0;
  const context = `${session.session.scope === 'municipality' ? 'Муниципальный' : session.session.scope === 'region' ? 'Региональный' : 'Федеральный'} уровень${session.session.regionId ? ` · ${regionName(regions, session.session.regionId)}` : ''}`;

  return (
    <Modal
      title="Подготовить раунд оценки"
      wide
      onClose={() => {
        if (!task.working) onClose();
      }}
      actions={
        <>
          <button className="button button-secondary" disabled={task.working} onClick={onClose}>
            Отмена
          </button>
          <button
            className="button button-primary"
            disabled={
              busy || task.working || !valid || !canOpen || revision !== snapshot.boardRevision
            }
            onClick={() =>
              void task.run(
                () =>
                  actions.openRound({
                    title: title.trim(),
                    resultsVisibility: visibility,
                    expectedBoardRevision: revision,
                    settings: {
                      promptText: prompt.trim(),
                      minCoverage: coverageNumber / 100,
                      minSubstantiveVotes: minVotesNumber,
                    },
                  }),
                onClose,
              )
            }
          >
            Открыть оценивание
          </button>
        </>
      }
    >
      <p className="workshop-modal-lead">
        Состав семейств, региональные варианты, вопрос и правила рейтинга фиксируются при открытии.
      </p>
      <div className="workshop-round-preflight">
        <div>
          <strong>{families.length}</strong>
          <span>семейств практик</span>
        </div>
        <div>
          <strong>{eligible}</strong>
          <span>участников в составе раунда</span>
        </div>
        <p>{context}</p>
      </div>
      <div className="session-field">
        <label htmlFor={`${id}-title`}>Название раунда</label>
        <input
          className="session-input"
          id={`${id}-title`}
          maxLength={200}
          value={title}
          disabled={task.working}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="session-field">
        <label htmlFor={`${id}-prompt`}>Вопрос участникам</label>
        <textarea
          className="session-input"
          id={`${id}-prompt`}
          rows={3}
          maxLength={1000}
          value={prompt}
          disabled={task.working}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <p className="workshop-muted">
          Предмет оценки — приоритет адаптации. Оценку доказательств и выполнимости следует
          проводить отдельно.
        </p>
      </div>
      <div className="workshop-round-settings">
        <div className="session-field">
          <label htmlFor={`${id}-coverage`}>Минимальный охват ответов, %</label>
          <input
            className="session-input"
            id={`${id}-coverage`}
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={5}
            value={coverage}
            disabled={task.working}
            onChange={(event) => setCoverage(event.target.value)}
          />
        </div>
        <div className="session-field">
          <label htmlFor={`${id}-votes`}>Минимум содержательных оценок</label>
          <input
            className="session-input"
            id={`${id}-votes`}
            type="number"
            inputMode="numeric"
            min={1}
            max={Math.max(1, eligible)}
            step={1}
            value={minVotes}
            disabled={task.working}
            onChange={(event) => setMinVotes(event.target.value)}
          />
          <p className="workshop-muted">Сумма ответов «Поддерживаю» и «Не поддерживаю».</p>
        </div>
      </div>
      <fieldset className="workshop-visibility-options">
        <legend>Когда раскрыть результаты</legend>
        <label>
          <input
            type="radio"
            name={`${id}-visibility`}
            value="after_close"
            checked={visibility === 'after_close'}
            disabled={task.working}
            onChange={() => setVisibility('after_close')}
          />
          <span>
            <strong>После завершения раунда</strong>
            <small>Участники отвечают независимо от текущего распределения оценок.</small>
          </span>
          <LockKeyhole size={17} aria-hidden="true" />
        </label>
        {snapshot.rounds.length > 0 ? (
          <label>
            <input
              type="radio"
              name={`${id}-visibility`}
              value="live"
              checked={visibility === 'live'}
              disabled={task.working}
              onChange={() => setVisibility('live')}
            />
            <span>
              <strong>Во время оценивания</strong>
              <small>
                Общий результат обновляется после каждого ответа. Режим подходит для повторного
                обсуждения.
              </small>
            </span>
          </label>
        ) : (
          <p className="workshop-muted">
            Первый раунд всегда скрывает текущие итоги до завершения.
          </p>
        )}
      </fieldset>
      <div className="workshop-round-time">
        <Clock3 size={20} aria-hidden="true" />
        <div>
          <label htmlFor={`${id}-seconds`}>Ориентир на одно семейство, секунд</label>
          <div>
            <input
              id={`${id}-seconds`}
              className="session-input"
              type="number"
              min={5}
              max={300}
              step={5}
              value={seconds}
              onChange={(event) => setSeconds(event.target.value)}
            />
            <span>
              {Number.isFinite(secondsNumber) && secondsNumber >= 5 && secondsNumber <= 300
                ? `Около ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format((families.length * secondsNumber) / 60)} мин. на участника`
                : 'Укажите от 5 до 300 секунд'}
            </span>
          </div>
          <p className="workshop-muted">
            Расчёт времени без дискуссии. Каждый участник оценивает весь список; при большом объёме
            сократите число семейств до открытия.
          </p>
        </div>
      </div>
      {revision !== snapshot.boardRevision ? (
        <div className="workshop-inline-warning">
          <p>
            Состав доски изменился. Семейств в текущем списке: {families.length}. Проверьте список
            перед открытием раунда.
          </p>
          <button
            className="button button-secondary"
            disabled={task.working}
            onClick={() => setRevision(snapshot.boardRevision)}
          >
            Принять текущий состав
          </button>
        </div>
      ) : null}
      {!canOpen ? (
        <p className="workshop-inline-warning">
          Для открытия нужны подготовленные семейства и открытое занятие на этапе обсуждения.
        </p>
      ) : null}
      {task.error ? (
        <p className="session-message" data-tone="error" role="alert">
          {task.error}
        </p>
      ) : null}
    </Modal>
  );
}
