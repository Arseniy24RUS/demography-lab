import { useId, useState } from 'react';
import { Modal } from '@/components/Modal';
import type {
  BarrierCard,
  BarrierEvidenceKind,
  LifeStage,
  SaveBarrierInput,
} from '../../../../../packages/barriers/types';
import type { BarrierBoardContext } from './barriers-ui';
import { barrierInput } from './barriers-ui';
import {
  evidenceLabels,
  lifeStages,
  RevisionNotice,
  stageLabels,
  TaskMessage,
  useBarrierTask,
} from './common';

export function BarrierEditor({
  context,
  card,
  onClose,
  initialStage = 'life_plans',
  initialDescription = '',
  surveySummary = false,
}: {
  context: BarrierBoardContext;
  card?: BarrierCard;
  onClose: () => void;
  initialStage?: LifeStage;
  initialDescription?: string;
  surveySummary?: boolean;
}) {
  const [draft, setDraft] = useState<SaveBarrierInput>(() =>
    card
      ? barrierInput(card)
      : {
          barrierId: null,
          expectedRevision: 0,
          title: '',
          description: initialDescription,
          primaryStage: initialStage,
          stageIds: [initialStage],
          evidenceKind: surveySummary ? 'survey_summary' : 'observation',
          status: 'active',
          priority: false,
        },
  );
  const id = useId();
  const task = useBarrierTask();
  const latest = card ? context.snapshot.barriers.find((item) => item.id === card.id) : undefined;
  const changed = !!latest && latest.revision !== draft.expectedRevision;
  const update = <K extends keyof SaveBarrierInput>(field: K, value: SaveBarrierInput[K]) =>
    setDraft((old) => ({ ...old, [field]: value }));
  function primary(stage: LifeStage) {
    setDraft((old) => ({
      ...old,
      primaryStage: stage,
      stageIds: old.stageIds.length === 1 ? [stage] : Array.from(new Set([...old.stageIds, stage])),
    }));
  }
  return (
    <Modal
      title={card ? 'Изменить барьер' : 'Добавить барьер'}
      onClose={onClose}
      wide
      actions={
        <>
          <button className="button button-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            className="button button-primary"
            type="submit"
            form={id}
            disabled={task.working || changed || !context.editable}
          >
            {task.working ? 'Сохраняем…' : 'Сохранить барьер'}
          </button>
        </>
      }
    >
      <form
        id={id}
        className="barrier-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed || !context.editable) return;
          void task.run(() => context.actions.saveBarrier(draft), onClose);
        }}
      >
        <p className="barrier-muted">
          Опишите препятствие и его адресата. Карточка будет видна группе с именем автора.
        </p>
        <label>
          Краткое название
          <input
            autoComplete="off"
            required
            minLength={5}
            maxLength={240}
            value={draft.title}
            onChange={(event) => update('title', event.target.value)}
          />
        </label>
        <label>
          Описание и адресат
          <textarea
            maxLength={4000}
            rows={4}
            value={draft.description}
            onChange={(event) => update('description', event.target.value)}
            placeholder="Кому и при каких условиях мешает этот барьер? Что именно вы наблюдаете?"
          />
        </label>
        <div className="barrier-form-columns">
          <label>
            Основной этап
            <select
              aria-label="Основной этап"
              value={draft.primaryStage}
              onChange={(event) => primary(event.target.value as LifeStage)}
            >
              {lifeStages.map((stage) => (
                <option key={stage} value={stage}>
                  {stageLabels[stage]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Основание формулировки
            <select
              aria-label="Основание формулировки"
              value={draft.evidenceKind}
              onChange={(event) =>
                update('evidenceKind', event.target.value as BarrierEvidenceKind)
              }
            >
              {Object.entries(evidenceLabels)
                .filter(
                  ([kind]) =>
                    kind !== 'survey_summary' ||
                    context.isHost ||
                    draft.evidenceKind === 'survey_summary',
                )
                .map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <fieldset>
          <legend>Дополнительные этапы</legend>
          <p className="barrier-muted">
            Основной этап включён всегда. Отметьте другие этапы, на которых проявляется тот же
            барьер.
          </p>
          <div className="barrier-check-grid">
            {lifeStages.map((stage) => (
              <label className="barrier-checkbox" key={stage}>
                <input
                  type="checkbox"
                  checked={draft.stageIds.includes(stage)}
                  disabled={stage === draft.primaryStage}
                  onChange={(event) =>
                    update(
                      'stageIds',
                      event.target.checked
                        ? [...draft.stageIds, stage]
                        : draft.stageIds.filter((item) => item !== stage),
                    )
                  }
                />
                <span>{stageLabels[stage]}</span>
              </label>
            ))}
          </div>
          <button
            className="button button-quiet"
            type="button"
            onClick={() => update('stageIds', [...lifeStages])}
          >
            Отметить все этапы
          </button>
        </fieldset>
        {draft.evidenceKind === 'survey_summary' ? (
          <p className="barrier-note">
            Запишите собственное обобщение преподавателя без персональных подробностей и дословных
            ответов. Связь с отдельной анкетой не сохраняется.
          </p>
        ) : null}
        {context.isHost ? (
          <label className="barrier-checkbox">
            <input
              type="checkbox"
              checked={draft.priority}
              onChange={(event) => update('priority', event.target.checked)}
            />
            <span>Выделить для общего обсуждения</span>
          </label>
        ) : null}
        <RevisionNotice
          changed={changed}
          onAccept={() =>
            latest &&
            setDraft((old) => ({
              ...old,
              expectedRevision: latest.revision,
              priority: context.isHost ? old.priority : latest.priority,
              status: latest.status,
            }))
          }
        >
          <details>
            <summary>Актуальная формулировка</summary>
            <h4>{latest?.title}</h4>
            <p>{latest?.description}</p>
          </details>
        </RevisionNotice>
        <TaskMessage error={task.error} />
      </form>
    </Modal>
  );
}
