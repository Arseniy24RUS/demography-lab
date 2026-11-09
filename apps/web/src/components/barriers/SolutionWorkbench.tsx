import { useId, useState } from 'react';
import { Archive, ArrowRight, Lightbulb, Pencil, Plus, Search } from 'lucide-react';
import { Modal } from '@/components/Modal';
import type { AuthorSolution, SaveSolutionInput } from '../../../../../packages/barriers/types';
import type { BarrierBoardContext } from './barriers-ui';
import { solutionInput } from './barriers-ui';
import { canEditCard, Empty, RevisionNotice, TaskMessage, useBarrierTask } from './common';

export const solutionFieldLabels = {
  targetGroup: 'Целевая группа',
  mechanism: 'Механизм изменения',
  firstStep: 'Первый шаг',
  responsible: 'Ответственный',
  resources: 'Ресурсы',
  successIndicator: 'Проверяемый результат',
  risks: 'Риски и ограничения',
} as const;
export function SolutionWorkbench({ context }: { context: BarrierBoardContext }) {
  const [editor, setEditor] = useState<AuthorSolution | 'new' | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [archive, setArchive] = useState<AuthorSolution | null>(null);
  const task = useBarrierTask();
  const solutions = context.snapshot.solutions.filter(
    (card) =>
      (showArchive ? card.status === 'archived' : card.status === 'active') &&
      `${card.title} ${card.mechanism} ${card.authorName}`
        .toLocaleLowerCase('ru')
        .includes(query.toLocaleLowerCase('ru')),
  );
  const selected = context.snapshot.solutions.find((card) => card.id === detail);
  return (
    <section>
      <header className="barrier-section-heading">
        <div>
          <h2>Авторские решения</h2>
          <p>Сформулируйте гипотезу и первый проверяемый шаг для выбранных барьеров.</p>
        </div>
        {context.editable ? (
          <button
            className="button button-primary"
            disabled={!context.snapshot.barriers.some((card) => card.status === 'active')}
            onClick={() => setEditor('new')}
          >
            <Plus size={18} />
            Добавить решение
          </button>
        ) : null}
      </header>
      <div className="barrier-toolbar">
        <label className="barrier-search">
          <Search size={17} />
          <input
            aria-label="Поиск авторского решения"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Найти решение или автора"
          />
        </label>
        <button
          className="button button-secondary"
          aria-pressed={showArchive}
          onClick={() => setShowArchive(!showArchive)}
        >
          <Archive size={17} />
          {showArchive ? 'Действующие решения' : 'Архив решений'}
        </button>
      </div>
      {!solutions.length ? (
        <Empty
          title={
            showArchive ? 'В архиве решений пока пусто' : 'От барьера — к собственной гипотезе'
          }
        >
          {context.snapshot.barriers.some((card) => card.status === 'active')
            ? 'Решение может развивать региональную практику или отвечать на барьер, для которого подходящей практики ещё нет.'
            : 'Сначала добавьте хотя бы один барьер на вкладке «Путь родительства».'}
        </Empty>
      ) : (
        <div className="barrier-solution-grid">
          {solutions.map((card) => (
            <article className="barrier-solution-card" key={card.id}>
              <div className="barrier-card-overline">
                <span>
                  <Lightbulb size={15} />
                  Гипотеза
                </span>
                <span>{card.authorName}</span>
              </div>
              <h3>{card.title}</h3>
              <p>{card.mechanism}</p>
              <div className="barrier-chips">
                {card.barrierIds.map((id) => (
                  <span className="barrier-chip" key={id}>
                    {context.snapshot.barriers.find((barrier) => barrier.id === id)?.title ??
                      'Барьер недоступен'}
                  </span>
                ))}
              </div>
              <div className="barrier-solution-first">
                <span>Первый шаг</span>
                <p>{card.firstStep}</p>
              </div>
              <footer>
                <button className="button button-secondary" onClick={() => setDetail(card.id)}>
                  Паспорт решения
                  <ArrowRight size={16} />
                </button>
                {canEditCard(card, context.userId, context.isHost, context.editable) ? (
                  <div className="barrier-card-actions">
                    <button
                      className="icon-button"
                      aria-label={`Изменить решение «${card.title}»`}
                      onClick={() => setEditor(card)}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={
                        card.status === 'active'
                          ? `Архивировать решение «${card.title}»`
                          : `Восстановить решение «${card.title}»`
                      }
                      onClick={() => setArchive(card)}
                    >
                      <Archive size={16} />
                    </button>
                  </div>
                ) : null}
              </footer>
            </article>
          ))}
        </div>
      )}
      <p className="barrier-footnote">
        Паспорт фиксирует проверяемую гипотезу. Показатель реализации мероприятия и изменение
        рождаемости — разные результаты; причинный эффект требует отдельной оценки.
      </p>
      <TaskMessage error={task.error} />
      {editor ? (
        <SolutionEditor
          context={context}
          card={editor === 'new' ? undefined : editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {selected ? (
        <Modal title={selected.title} onClose={() => setDetail(null)} wide>
          <div className="barrier-solution-detail">
            <p className="barrier-note">Авторская гипотеза · {selected.authorName}</p>
            <h3>Связанные барьеры</h3>
            {selected.barrierIds.map((id) => {
              const barrier = context.snapshot.barriers.find((card) => card.id === id);
              return (
                <p key={id}>
                  {barrier?.title ?? 'Барьер недоступен'}
                  {barrier?.status === 'archived' ? ' · в архиве' : ''}
                </p>
              );
            })}
            <dl>
              {Object.entries(solutionFieldLabels).map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{selected[key as keyof typeof solutionFieldLabels] || 'Не указано'}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Modal>
      ) : null}
      {archive ? (
        <Modal
          title={archive.status === 'active' ? 'Архивировать решение?' : 'Восстановить решение?'}
          onClose={() => setArchive(null)}
          actions={
            <>
              <button className="button button-secondary" onClick={() => setArchive(null)}>
                Отмена
              </button>
              <button
                className="button button-primary"
                disabled={task.working}
                onClick={() =>
                  void task.run(
                    () =>
                      context.actions.saveSolution({
                        ...solutionInput(archive),
                        status: archive.status === 'active' ? 'archived' : 'active',
                      }),
                    () => setArchive(null),
                  )
                }
              >
                {archive.status === 'active' ? 'Архивировать' : 'Восстановить'}
              </button>
            </>
          }
        >
          <p>{archive.title}</p>
          <TaskMessage error={task.error} />
        </Modal>
      ) : null}
    </section>
  );
}
function SolutionEditor({
  context,
  card,
  onClose,
}: {
  context: BarrierBoardContext;
  card?: AuthorSolution;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SaveSolutionInput>(() =>
    card
      ? solutionInput(card)
      : {
          solutionId: null,
          expectedRevision: 0,
          barrierIds: [],
          title: '',
          targetGroup: '',
          mechanism: '',
          firstStep: '',
          responsible: '',
          resources: '',
          successIndicator: '',
          risks: '',
          status: 'active',
        },
  );
  const id = useId();
  const task = useBarrierTask();
  const latest = card ? context.snapshot.solutions.find((item) => item.id === card.id) : undefined;
  const changed = !!latest && latest.revision !== draft.expectedRevision;
  const update = <K extends keyof SaveSolutionInput>(field: K, value: SaveSolutionInput[K]) =>
    setDraft((old) => ({ ...old, [field]: value }));
  return (
    <Modal
      title={card ? 'Изменить гипотезу решения' : 'Авторская гипотеза решения'}
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
            disabled={task.working || changed || !draft.barrierIds.length || !context.editable}
          >
            {task.working ? 'Сохраняем…' : 'Сохранить решение'}
          </button>
        </>
      }
    >
      <form
        id={id}
        className="barrier-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.barrierIds.length || changed) return;
          void task.run(() => context.actions.saveSolution(draft), onClose);
        }}
      >
        <fieldset>
          <legend>Для каких барьеров разрабатывается решение?</legend>
          <div className="barrier-check-stack">
            {context.snapshot.barriers
              .filter(
                (barrier) => barrier.status === 'active' || draft.barrierIds.includes(barrier.id),
              )
              .map((barrier) => (
                <label className="barrier-checkbox" key={barrier.id}>
                  <input
                    type="checkbox"
                    checked={draft.barrierIds.includes(barrier.id)}
                    onChange={(event) =>
                      update(
                        'barrierIds',
                        event.target.checked
                          ? [...draft.barrierIds, barrier.id]
                          : draft.barrierIds.filter((item) => item !== barrier.id),
                      )
                    }
                  />
                  <span>
                    {barrier.title}
                    {barrier.status === 'archived' ? ' (в архиве)' : ''}
                  </span>
                </label>
              ))}
          </div>
        </fieldset>
        <label>
          Название решения
          <input
            required
            minLength={5}
            maxLength={240}
            value={draft.title}
            onChange={(event) => update('title', event.target.value)}
          />
        </label>
        <label>
          Целевая группа
          <textarea
            required
            minLength={3}
            maxLength={1000}
            rows={2}
            value={draft.targetGroup}
            onChange={(event) => update('targetGroup', event.target.value)}
            placeholder="Для кого, при каких условиях и на какой территории?"
          />
        </label>
        <label>
          Механизм изменения
          <textarea
            required
            minLength={10}
            maxLength={4000}
            rows={4}
            value={draft.mechanism}
            onChange={(event) => update('mechanism', event.target.value)}
            placeholder="Каким действием и через какой механизм изменится ситуация?"
          />
        </label>
        <div className="barrier-form-columns">
          {(['firstStep', 'responsible', 'resources', 'successIndicator'] as const).map((field) => (
            <label key={field}>
              {solutionFieldLabels[field]}
              <textarea
                required
                minLength={3}
                maxLength={2000}
                rows={3}
                value={draft[field]}
                onChange={(event) => update(field, event.target.value)}
                placeholder={
                  field === 'successIndicator'
                    ? 'Что измерим, у кого, к какому сроку и из какого источника?'
                    : undefined
                }
              />
            </label>
          ))}
        </div>
        <label>
          Риски и ограничения
          <textarea
            maxLength={2000}
            rows={3}
            value={draft.risks}
            onChange={(event) => update('risks', event.target.value)}
            placeholder="Что может помешать? Какие предпосылки требуют проверки?"
          />
        </label>
        <RevisionNotice
          changed={changed}
          onAccept={() =>
            latest &&
            setDraft((old) => ({
              ...old,
              expectedRevision: latest.revision,
              status: latest.status,
            }))
          }
        >
          <details>
            <summary>Актуальная гипотеза</summary>
            <h4>{latest?.title}</h4>
            <p>{latest?.mechanism}</p>
            <p>{latest?.firstStep}</p>
          </details>
        </RevisionNotice>
        <TaskMessage error={task.error} />
      </form>
    </Modal>
  );
}
