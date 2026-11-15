import { useId, useMemo, useState } from 'react';
import type { BarriersSnapshot } from '../../../../../packages/barriers/types';
import type {
  ImportRoadmapWorkshopInput,
  RoadmapWorkshopMeasure,
} from '../../../../../packages/roadmaps/types';
import { Modal } from '../Modal';
import { isLifecycleStage, lifecycleStageLabels } from '../barriers/lifecycle-stages';
import { EmptySection, useRoadmapTask } from './common';

interface MeasureChoice extends RoadmapWorkshopMeasure {
  key: string;
  title: string;
  barrierIds: Set<string>;
}

const measureLabels = {
  family: 'Региональная практика',
  factor: 'Предложение с флипчарта',
  solution: 'Авторское решение',
} as const;

function measureChoices(board: BarriersSnapshot) {
  const choices = new Map<string, MeasureChoice>();
  function add(kind: RoadmapWorkshopMeasure['kind'], id: string, title: string, barrierId: string) {
    const key = `${kind}:${id}`;
    const choice = choices.get(key);
    if (choice) choice.barrierIds.add(barrierId);
    else choices.set(key, { key, kind, id, title, barrierIds: new Set([barrierId]) });
  }
  for (const link of board.links) {
    if (link.status === 'active' && !link.staleReasons.length)
      add('family', link.familyId, link.familyTitle, link.barrierId);
  }
  for (const link of board.greenFactorLinks ?? [])
    add('factor', link.noteId, link.title, link.barrierId);
  for (const solution of board.solutions) {
    if (solution.status === 'active') {
      for (const barrierId of solution.barrierIds)
        add('solution', solution.id, solution.title, barrierId);
    }
  }
  return Array.from(choices.values());
}

export function WorkshopImport({
  board,
  roadmapId,
  busy,
  onClose,
  onImport,
}: {
  board: BarriersSnapshot | null;
  roadmapId: string;
  busy: boolean;
  onClose(): void;
  onImport(input: ImportRoadmapWorkshopInput): Promise<unknown>;
}) {
  const formId = useId();
  const task = useRoadmapTask();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const activeBarriers = board?.barriers.filter(({ status }) => status === 'active') ?? [];
  const barrierIds = activeBarriers.filter(({ id }) => selected.has(id)).map(({ id }) => id);
  const measures = useMemo(() => (board ? measureChoices(board) : []), [board]);
  const related = measures.filter(({ barrierIds: ids }) => barrierIds.some((id) => ids.has(id)));
  const selectedMeasures = related.filter(({ key }) => !excluded.has(key));
  const canSubmit =
    barrierIds.length > 0 && barrierIds.length <= 40 && selectedMeasures.length <= 40;
  const close = () => {
    if (!task.working) onClose();
  };

  function change(set: Set<string>, key: string, value: boolean) {
    const next = new Set(set);
    if (value) next.add(key);
    else next.delete(key);
    return next;
  }

  return (
    <Modal
      title="Перенос барьеров и мер"
      wide
      onClose={close}
      actions={
        <>
          <button className="button button-secondary" onClick={close} disabled={task.working}>
            Отмена
          </button>
          <button
            type="submit"
            form={formId}
            className="button button-primary"
            disabled={!canSubmit || busy || task.working}
          >
            {task.working ? 'Переносим…' : 'Перенести в проект'}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="rm-workshop-import"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || busy || task.working) return;
          void task.run(async () => {
            await onImport({
              roadmapId,
              barrierIds,
              measures: selectedMeasures.map(({ kind, id }) => ({ kind, id })),
            });
            onClose();
          });
        }}
      >
        {task.feedback}
        <fieldset disabled={task.working}>
          <legend>Барьеры</legend>
          {activeBarriers.length ? (
            <ul aria-label="Барьеры мастерской">
              {activeBarriers.map((item) => {
                const stages = item.stageIds
                  .filter(isLifecycleStage)
                  .map((stage) => lifecycleStageLabels[stage]);
                return (
                  <li key={item.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={(event) =>
                          setSelected(change(selected, item.id, event.currentTarget.checked))
                        }
                      />
                      <span>
                        {item.title}
                        {stages.length ? <small>{stages.join(' · ')}</small> : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptySection>В мастерской пока нет барьеров.</EmptySection>
          )}
        </fieldset>
        <fieldset disabled={task.working}>
          <legend>Связанные меры</legend>
          {related.length ? (
            <ul aria-label="Меры выбранных барьеров">
              {related.map((item) => (
                <li key={item.key}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!excluded.has(item.key)}
                      onChange={(event) =>
                        setExcluded(change(excluded, item.key, !event.currentTarget.checked))
                      }
                    />
                    <span>
                      {item.title}
                      <small>{measureLabels[item.kind]}</small>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <EmptySection>
              {barrierIds.length
                ? 'У выбранных барьеров пока нет связанных мер.'
                : 'Выберите барьеры для проекта.'}
            </EmptySection>
          )}
        </fieldset>
        {barrierIds.length > 40 || selectedMeasures.length > 40 ? (
          <p role="alert">За один раз можно выбрать до 40 барьеров и 40 мер.</p>
        ) : null}
      </form>
    </Modal>
  );
}
