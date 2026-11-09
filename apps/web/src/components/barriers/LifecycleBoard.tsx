import { useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  Check,
  GripVertical,
  HelpCircle,
  Layers,
  Link2,
  Pencil,
  Plus,
  Search,
  Star,
  ThumbsDown,
  ThumbsUp,
  Undo2,
} from 'lucide-react';
import { Modal } from '@/components/Modal';
import type { BarrierCard, LifeStage } from '../../../../../packages/barriers/types';
import type { VoteValue } from '../../../../../packages/workshop/types';
import type { BarrierBoardContext } from './barriers-ui';
import { barrierInput } from './barriers-ui';
import { BarrierEditor } from './BarrierEditor';
import {
  canEditCard,
  coverageLabel,
  currentLinks,
  Empty,
  evidenceLabels,
  lifeStages,
  stageDescriptions,
  stageLabels,
  StageChips,
  TaskMessage,
  useBarrierDrag,
  useBarrierTask,
} from './common';

type Filter = 'all' | 'gap' | 'review' | 'linked' | 'priority';
export function LifecycleBoard({
  context,
  onConnections,
}: {
  context: BarrierBoardContext;
  onConnections: (barrierId: string) => void;
}) {
  const [selected, setSelected] = useState<LifeStage | 'all'>('all');
  const [cross, setCross] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [editor, setEditor] = useState<BarrierCard | 'new' | null>(null);
  const [move, setMove] = useState<{ card: BarrierCard; stage: LifeStage } | null>(null);
  const [archive, setArchive] = useState<BarrierCard | null>(null);
  const task = useBarrierTask();
  const track = useRef<HTMLDivElement>(null);
  const active = context.snapshot.barriers.filter((card) =>
    showArchive ? card.status === 'archived' : card.status === 'active',
  );
  const visible = active.filter(
    (card) =>
      (selected === 'all' || card.stageIds.includes(selected)) &&
      (!cross || card.stageIds.length > 1) &&
      `${card.title} ${card.description} ${card.authorName}`
        .toLocaleLowerCase('ru')
        .includes(query.toLocaleLowerCase('ru')) &&
      (filter === 'all' ||
        (filter === 'priority' && card.priority) ||
        (filter === 'linked' && currentLinks(context.snapshot.links, card.id).length > 0) ||
        (filter === 'gap' && !currentLinks(context.snapshot.links, card.id).length) ||
        (filter === 'review' &&
          context.snapshot.links.some(
            (link) =>
              link.barrierId === card.id &&
              link.status === 'active' &&
              link.staleReasons.length > 0,
          ))),
  );
  const drag = useBarrierDrag(
    '[data-stage-drop]',
    'data-stage-drop',
    (id, stage) => {
      const card = context.snapshot.barriers.find((item) => item.id === id);
      if (card && lifeStages.includes(stage as LifeStage) && stage !== card.primaryStage)
        setMove({ card, stage: stage as LifeStage });
    },
    (id) => {
      const card = context.snapshot.barriers.find((item) => item.id === id);
      if (card) setMove({ card, stage: card.primaryStage });
    },
  );
  function vote(card: BarrierCard, value: VoteValue) {
    void task.run(() =>
      context.actions.vote({ barrierId: card.id, expectedRevision: card.myVoteRevision, value }),
    );
  }
  function renderCard(card: BarrierCard) {
    const mayEdit = canEditCard(card, context.userId, context.isHost, context.editable);
    return (
      <article
        className={`barrier-card${card.priority ? ' is-priority' : ''}`}
        key={card.id}
        data-barrier-id={card.id}
      >
        <div className="barrier-card-heading">
          {mayEdit && card.status === 'active' ? (
            <button
              className="icon-button barrier-drag-handle"
              aria-label={`Перенести барьер «${card.title}»`}
              onPointerDown={(event) => drag.start(event, card.id, card.title)}
              onPointerMove={drag.move}
              onPointerUp={drag.finish}
              onPointerCancel={drag.cancel}
              onClick={(event) => drag.click(event, card.id)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') drag.cancel();
              }}
            >
              <GripVertical size={18} />
            </button>
          ) : null}
          <div>
            <div className="barrier-card-overline">
              {card.priority ? (
                <span>
                  <Star size={13} />
                  Для обсуждения
                </span>
              ) : null}
              <span>{evidenceLabels[card.evidenceKind]}</span>
            </div>
            <h3>{card.title}</h3>
          </div>
        </div>
        <p className="barrier-card-description">
          {card.description || 'Описание пока не добавлено.'}
        </p>
        <p className="barrier-byline">{card.authorName}</p>
        <StageChips stageIds={card.stageIds} primaryStage={card.primaryStage} />
        <button
          className={`barrier-coverage${currentLinks(context.snapshot.links, card.id).length ? ' has-links' : ''}`}
          onClick={() => onConnections(card.id)}
        >
          <Link2 size={15} />
          {coverageLabel(context.snapshot.links, card.id)}
          <ArrowRight size={14} />
        </button>
        <div className="barrier-card-footer">
          <div
            className="barrier-votes"
            role="group"
            aria-label={`Оценить значимость барьера «${card.title}»`}
          >
            <button
              aria-label={`Значим: ${card.totals.support}`}
              title="Значим для обсуждения"
              aria-pressed={card.myVote === 1}
              disabled={!context.editable || card.status !== 'active' || task.working}
              onClick={() => vote(card, card.myVote === 1 ? null : 1)}
            >
              <ThumbsUp size={16} />
              <span>{card.totals.support}</span>
            </button>
            <button
              aria-label={`Не приоритетен: ${card.totals.oppose}`}
              title="Не приоритетен для обсуждения"
              aria-pressed={card.myVote === -1}
              disabled={!context.editable || card.status !== 'active' || task.working}
              onClick={() => vote(card, card.myVote === -1 ? null : -1)}
            >
              <ThumbsDown size={16} />
              <span>{card.totals.oppose}</span>
            </button>
            <button
              aria-label={`Не могу оценить: ${card.totals.neutral}`}
              title="Не могу оценить"
              aria-pressed={card.myVote === 0}
              disabled={!context.editable || card.status !== 'active' || task.working}
              onClick={() => vote(card, card.myVote === 0 ? null : 0)}
            >
              <HelpCircle size={16} />
              <span>{card.totals.neutral}</span>
            </button>
            {card.myVote !== null && context.editable ? (
              <button
                aria-label="Отменить мою оценку"
                title="Отменить мою оценку"
                disabled={task.working}
                onClick={() => vote(card, null)}
              >
                <Undo2 size={15} />
              </button>
            ) : null}
          </div>
          {mayEdit ? (
            <div className="barrier-card-actions">
              <button
                className="icon-button"
                title="Изменить барьер"
                aria-label={`Изменить барьер «${card.title}»`}
                onClick={() => setEditor(card)}
              >
                <Pencil size={16} />
              </button>
              {card.status === 'active' ? (
                <button
                  className="icon-button"
                  title="Перенести на другой этап"
                  aria-label={`Выбрать этап для «${card.title}»`}
                  onClick={() => setMove({ card, stage: card.primaryStage })}
                >
                  <ArrowRightLeft size={16} />
                </button>
              ) : null}
              {context.isHost ? (
                <button
                  className="icon-button"
                  title={card.priority ? 'Снять выделение' : 'Выделить для обсуждения'}
                  aria-label={card.priority ? 'Снять выделение' : 'Выделить для обсуждения'}
                  aria-pressed={card.priority}
                  disabled={task.working}
                  onClick={() =>
                    void task.run(() =>
                      context.actions.saveBarrier({
                        ...barrierInput(card),
                        priority: !card.priority,
                      }),
                    )
                  }
                >
                  <Star size={16} />
                </button>
              ) : null}
              <button
                className="icon-button"
                title={card.status === 'active' ? 'В архив' : 'Восстановить'}
                aria-label={
                  card.status === 'active'
                    ? `Архивировать барьер «${card.title}»`
                    : `Восстановить барьер «${card.title}»`
                }
                onClick={() => setArchive(card)}
              >
                <Archive size={16} />
              </button>
            </div>
          ) : null}
        </div>
      </article>
    );
  }
  return (
    <section className="barrier-lifecycle">
      <header className="barrier-section-heading">
        <div>
          <h2>Путь родительства</h2>
          <p>Сформулируйте барьеры и отметьте этапы, на которых они проявляются.</p>
        </div>
        {context.editable ? (
          <button className="button button-primary" onClick={() => setEditor('new')}>
            <Plus size={18} />
            Добавить барьер
          </button>
        ) : null}
      </header>
      <div className="barrier-timeline-shell">
        <div className="barrier-timeline" ref={track} aria-label="Этапы родительства">
          {lifeStages.map((stage, index) => (
            <button
              key={stage}
              className={`barrier-stage${selected === stage ? ' selected' : ''}${drag.drag?.over === stage ? ' drag-over' : ''}`}
              data-stage-drop={stage}
              aria-pressed={selected === stage}
              onClick={() => setSelected(selected === stage ? 'all' : stage)}
            >
              <span className="barrier-stage-node">{index + 1}</span>
              <span className="barrier-stage-label">{stageLabels[stage]}</span>
              <span className="barrier-stage-count">
                Барьеров: {active.filter((card) => card.stageIds.includes(stage)).length}
              </span>
            </button>
          ))}
        </div>
        <div className="barrier-timeline-controls">
          <button
            className="icon-button"
            aria-label="Предыдущие этапы"
            onClick={() =>
              track.current?.scrollBy({
                left: -280,
                behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
                  ? 'instant'
                  : 'smooth',
              })
            }
          >
            <ArrowLeft size={17} />
          </button>
          <span>Листайте этапы; карточка может относиться к нескольким.</span>
          <button
            className="icon-button"
            aria-label="Следующие этапы"
            onClick={() =>
              track.current?.scrollBy({
                left: 280,
                behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
                  ? 'instant'
                  : 'smooth',
              })
            }
          >
            <ArrowRight size={17} />
          </button>
        </div>
      </div>
      <div className="barrier-toolbar">
        <button
          className="button button-secondary"
          aria-pressed={selected === 'all'}
          onClick={() => setSelected('all')}
        >
          Все этапы
        </button>
        <button
          className="button button-secondary"
          aria-pressed={cross}
          onClick={() => setCross(!cross)}
        >
          <Layers size={16} />
          Сквозные барьеры
        </button>
        <label className="barrier-search">
          <Search size={17} />
          <input
            aria-label="Поиск барьера"
            placeholder="Найти барьер или автора"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="barrier-filter">
          <span className="barrier-sr-only">Показать барьеры</span>
          <select
            aria-label="Показать барьеры"
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
          >
            <option value="all">Все барьеры</option>
            <option value="gap">Без актуальных связей</option>
            <option value="review">Требуют проверки</option>
            <option value="linked">Есть актуальные связи</option>
            <option value="priority">Для обсуждения</option>
          </select>
        </label>
        <button
          className="icon-button"
          title={showArchive ? 'Показать действующие' : 'Показать архив'}
          aria-label={showArchive ? 'Показать действующие барьеры' : 'Показать архив барьеров'}
          aria-pressed={showArchive}
          onClick={() => setShowArchive(!showArchive)}
        >
          <Archive size={17} />
        </button>
      </div>
      <TaskMessage error={task.error} />
      {showArchive ? (
        <p className="barrier-note">
          Архивные барьеры сохранены вместе со связями. Они не входят в текущую картину обсуждения.
        </p>
      ) : null}
      {selected !== 'all' ? (
        <div className="barrier-stage-intro">
          <h3>{stageLabels[selected]}</h3>
          <p>{stageDescriptions[selected]}</p>
        </div>
      ) : null}
      {!visible.length ? (
        <Empty
          title={
            query || cross || filter !== 'all'
              ? 'Барьеры не найдены'
              : showArchive
                ? 'В архиве пока пусто'
                : 'Здесь начинается обсуждение'
          }
        >
          {query || cross || filter !== 'all'
            ? 'Измените поиск или фильтры.'
            : 'Добавьте одно наблюдаемое препятствие и объясните, для кого оно возникает.'}
        </Empty>
      ) : selected === 'all' ? (
        <div className="barrier-stage-groups">
          {lifeStages.map((stage) => {
            const cards = visible.filter((card) => card.primaryStage === stage);
            return cards.length ? (
              <section className="barrier-stage-group" key={stage} data-stage-drop={stage}>
                <h3 className="barrier-group-title">
                  <span>{stageLabels[stage]}</span>
                  <span>{cards.length}</span>
                </h3>
                <div className="barrier-card-stack">{cards.map(renderCard)}</div>
              </section>
            ) : null;
          })}
        </div>
      ) : (
        <div className="barrier-card-grid">{visible.map(renderCard)}</div>
      )}
      <p className="barrier-footnote">
        Этапы служат схемой обсуждения; последовательность жизненных решений может отличаться.
        Оценки показывают значимость для участников и не устанавливают истинность личного опыта.
      </p>
      {editor ? (
        <BarrierEditor
          context={context}
          card={editor === 'new' ? undefined : editor}
          initialStage={selected === 'all' ? 'life_plans' : selected}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {move ? (
        <MoveDialog
          context={context}
          card={move.card}
          initialStage={move.stage}
          onClose={() => setMove(null)}
        />
      ) : null}
      {archive ? (
        <Modal
          title={archive.status === 'active' ? 'Архивировать барьер?' : 'Восстановить барьер?'}
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
                      context.actions.saveBarrier({
                        ...barrierInput(archive),
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
          <p className="barrier-muted">
            Основания существующих связей сохранятся. После изменения проверьте их актуальность.
          </p>
          <TaskMessage error={task.error} />
        </Modal>
      ) : null}
      {drag.drag ? (
        <div
          className="barrier-drag-ghost"
          style={{
            left: Math.min(drag.drag.x + 12, window.innerWidth - 250),
            top: drag.drag.y + 12,
          }}
        >
          {drag.drag.title}
        </div>
      ) : null}
      <span className="barrier-sr-only" role="status">
        {drag.announcement}
      </span>
    </section>
  );
}
function MoveDialog({
  context,
  card,
  initialStage,
  onClose,
}: {
  context: BarrierBoardContext;
  card: BarrierCard;
  initialStage: LifeStage;
  onClose: () => void;
}) {
  const [stage, setStage] = useState(initialStage);
  const [keep, setKeep] = useState(true);
  const [expected, setExpected] = useState(card.revision);
  const task = useBarrierTask();
  const latest = context.snapshot.barriers.find((item) => item.id === card.id) ?? card;
  const changed = latest.revision !== expected;
  return (
    <Modal
      title="Перенести основной этап"
      onClose={onClose}
      actions={
        <>
          <button className="button button-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            className="button button-primary"
            disabled={stage === latest.primaryStage || task.working || changed || !context.editable}
            onClick={() => {
              const stageIds = Array.from(
                new Set([
                  ...(keep
                    ? latest.stageIds
                    : latest.stageIds.filter((item) => item !== latest.primaryStage)),
                  stage,
                ]),
              );
              void task.run(
                () =>
                  context.actions.saveBarrier({
                    ...barrierInput(latest),
                    expectedRevision: expected,
                    primaryStage: stage,
                    stageIds,
                  }),
                onClose,
              );
            }}
          >
            <Check size={16} />
            Подтвердить перенос
          </button>
        </>
      }
    >
      <div className="barrier-form">
        <h3>{latest.title}</h3>
        <p className="barrier-muted">Основной этап сейчас: {stageLabels[latest.primaryStage]}.</p>
        <label>
          Новый основной этап
          <select
            aria-label="Новый основной этап"
            value={stage}
            onChange={(event) => setStage(event.target.value as LifeStage)}
          >
            {lifeStages.map((item) => (
              <option key={item} value={item}>
                {stageLabels[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="barrier-checkbox">
          <input
            type="checkbox"
            checked={keep}
            onChange={(event) => setKeep(event.target.checked)}
          />
          <span>Оставить прежний этап дополнительным</span>
        </label>
        {changed ? (
          <div className="barrier-conflict">
            <p>Барьер изменился. Проверьте новую формулировку перед переносом.</p>
            <button
              className="button button-secondary"
              onClick={() => setExpected(latest.revision)}
            >
              Использовать актуальную редакцию
            </button>
          </div>
        ) : null}
        <TaskMessage error={task.error} />
      </div>
    </Modal>
  );
}
