import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  FileText,
  Link2,
  List,
  Network,
  Pencil,
  Plus,
  Search,
} from 'lucide-react';
import { Modal } from '@/components/Modal';
import type {
  BarrierCard,
  BarrierFamilyOption,
  BarrierPracticeLink,
  BarrierRelationship,
  SaveBarrierLinkInput,
} from '../../../../../packages/barriers/types';
import type { BarrierBoardContext } from './barriers-ui';
import {
  canEditCard,
  currentLinks,
  Empty,
  relationshipLabels,
  RevisionNotice,
  staleLabels,
  StageChips,
  TaskMessage,
  useBarrierDrag,
  useBarrierTask,
} from './common';
import { EvidenceDialog } from './EvidenceDialog';

export function ConnectionWorkbench({
  context,
  initialBarrierId,
}: {
  context: BarrierBoardContext;
  initialBarrierId?: string | null;
}) {
  const [barrierId, setBarrierId] = useState(initialBarrierId ?? '');
  const [familyId, setFamilyId] = useState('');
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [familyQuery, setFamilyQuery] = useState('');
  const [gap, setGap] = useState(false);
  const [focusLinks, setFocusLinks] = useState(false);
  const [list, setList] = useState(false);
  const [page, setPage] = useState(0);
  const [familyPage, setFamilyPage] = useState(0);
  const [editor, setEditor] = useState<{
    barrierId: string;
    familyId: string;
    link?: BarrierPracticeLink;
  } | null>(null);
  const [evidence, setEvidence] = useState<string | null>(null);
  const [archive, setArchive] = useState<BarrierPracticeLink | null>(null);
  const task = useBarrierTask();
  useEffect(() => {
    if (initialBarrierId) {
      setBarrierId(initialBarrierId);
      const index = context.snapshot.barriers
        .filter((card) => card.status === 'active')
        .findIndex((card) => card.id === initialBarrierId);
      setPage(Math.max(0, Math.floor(index / 6)));
    }
  }, [initialBarrierId]);
  const barriers = context.snapshot.barriers.filter(
    (card) =>
      card.status === 'active' &&
      (!gap || !currentLinks(context.snapshot.links, card.id).length) &&
      `${card.title} ${card.description}`
        .toLocaleLowerCase('ru')
        .includes(query.toLocaleLowerCase('ru')),
  );
  // Barycentric ordering reduces crossings while keeping the barrier lane stable.
  // Equal positions preserve the server's existing order; polling never randomizes it.
  const barrierOrder = new Map(barriers.map((card, index) => [card.id, index]));
  const familyPositions = new Map<string, { sum: number; count: number }>();
  for (const link of context.snapshot.links) {
    const position = barrierOrder.get(link.barrierId);
    if (link.status !== 'active' || position === undefined) continue;
    const old = familyPositions.get(link.familyId) ?? { sum: 0, count: 0 };
    familyPositions.set(link.familyId, { sum: old.sum + position, count: old.count + 1 });
  }
  const positionOf = (familyId: string) => {
    const value = familyPositions.get(familyId);
    return value ? value.sum / value.count : Number.MAX_SAFE_INTEGER;
  };
  const families = context.snapshot.families
    .filter((card) =>
      `${card.title} ${card.mechanism} ${card.regionNames.join(' ')}`
        .toLocaleLowerCase('ru')
        .includes(familyQuery.toLocaleLowerCase('ru')),
    )
    .sort((a, b) => positionOf(a.id) - positionOf(b.id));
  const selectedBarrier = context.snapshot.barriers.find((card) => card.id === barrierId);
  const selectedFamily = context.snapshot.families.find((card) => card.id === familyId);
  const selected = context.snapshot.links.find(
    (link) => link.id === selectedLink && link.status === 'active',
  );
  const pageSafe = Math.min(page, Math.max(0, Math.ceil(barriers.length / 6) - 1));
  const familyPageSafe = Math.min(familyPage, Math.max(0, Math.ceil(families.length / 6) - 1));
  const visibleBarriers = barriers.slice(pageSafe * 6, pageSafe * 6 + 6);
  const visibleFamilies = families.slice(familyPageSafe * 6, familyPageSafe * 6 + 6);
  const links = context.snapshot.links.filter(
    (link) =>
      link.status === 'active' &&
      barriers.some((card) => card.id === link.barrierId) &&
      (!familyQuery || families.some((card) => card.id === link.familyId)),
  );
  function chooseLink(link: BarrierPracticeLink) {
    setSelectedLink(link.id);
    setBarrierId(link.barrierId);
    setFamilyId(link.familyId);
    const bi = barriers.findIndex((card) => card.id === link.barrierId);
    const fi = families.findIndex((card) => card.id === link.familyId);
    if (bi >= 0) setPage(Math.floor(bi / 6));
    if (fi >= 0) setFamilyPage(Math.floor(fi / 6));
  }
  function connect(bid: string, fid: string) {
    const existing = context.snapshot.links.find(
      (link) => link.barrierId === bid && link.familyId === fid && link.status === 'active',
    );
    if (existing) {
      chooseLink(existing);
      if (canEditCard(existing, context.userId, context.isHost, context.editable))
        setEditor({ barrierId: bid, familyId: fid, link: existing });
    } else setEditor({ barrierId: bid, familyId: fid });
  }
  const drag = useBarrierDrag(
    '[data-barrier-family-drop]',
    'data-barrier-family-drop',
    (bid, fid) => connect(bid, fid),
    (id) => setBarrierId(id),
  );
  return (
    <section className="barrier-connections">
      <header className="barrier-section-heading">
        <div>
          <h2>Свяжите барьеры с практиками</h2>
          <p>Объясните механизм и сохраните документальные основания.</p>
        </div>
        <button
          className="button button-secondary"
          aria-pressed={list}
          onClick={() => setList(!list)}
        >
          {list ? <Network size={18} /> : <List size={18} />}{' '}
          {list ? 'Схема связей' : 'Список связей'}
        </button>
      </header>
      <div className="barrier-toolbar">
        <label className="barrier-search">
          <Search size={17} />
          <input
            aria-label="Поиск барьера для связи"
            placeholder="Найти барьер"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </label>
        <label className="barrier-search">
          <Search size={17} />
          <input
            aria-label="Поиск семейства для связи"
            placeholder="Найти семейство или регион"
            value={familyQuery}
            onChange={(event) => {
              setFamilyQuery(event.target.value);
              setFamilyPage(0);
            }}
          />
        </label>
        <label className="barrier-checkbox">
          <input
            type="checkbox"
            checked={gap}
            onChange={(event) => {
              setGap(event.target.checked);
              setPage(0);
            }}
          />
          <span>Только без актуальных связей</span>
        </label>
        {!list ? (
          <label className="barrier-checkbox">
            <input
              type="checkbox"
              checked={focusLinks}
              disabled={!selectedBarrier}
              onChange={(event) => setFocusLinks(event.target.checked)}
            />
            <span>Только связи выбранного барьера</span>
          </label>
        ) : null}
      </div>
      {!list ? (
        <>
          <ConnectionDiagram
            barriers={visibleBarriers}
            families={visibleFamilies}
            links={focusLinks ? links.filter((link) => link.barrierId === barrierId) : links}
            barrierId={barrierId}
            familyId={familyId}
            selectedLinkId={selectedLink}
            onBarrier={setBarrierId}
            onFamily={setFamilyId}
            onLink={chooseLink}
            editable={context.editable}
            drag={drag}
          />
          <div className="barrier-graph-pagination">
            <Pager page={pageSafe} count={barriers.length} onPage={setPage} noun="Барьеры" />
            <Pager
              page={familyPageSafe}
              count={families.length}
              onPage={setFamilyPage}
              noun="Семейства"
            />
          </div>
          {context.editable ? (
            <div className="barrier-selection-rail">
              <div>
                <span>Барьер</span>
                <strong>{selectedBarrier?.title ?? 'Выберите карточку слева'}</strong>
              </div>
              <Link2 size={22} />
              <div>
                <span>Семейство практик</span>
                <strong>{selectedFamily?.title ?? 'Выберите карточку справа'}</strong>
              </div>
              <button
                className="button button-primary"
                disabled={
                  !selectedBarrier || selectedBarrier.status !== 'active' || !selectedFamily
                }
                onClick={() => connect(barrierId, familyId)}
              >
                <Plus size={17} />
                Связать
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <section className="barrier-link-list" aria-label="Все связи барьеров и практик">
          {!links.length ? (
            <Empty title="Связей пока нет">
              Выберите барьер и семейство на схеме, затем объясните механизм.
            </Empty>
          ) : (
            links.map((link) => (
              <button
                className={`barrier-link-row${selectedLink === link.id ? ' selected' : ''}`}
                key={link.id}
                onClick={() => chooseLink(link)}
              >
                <span>
                  <strong>
                    {context.snapshot.barriers.find((card) => card.id === link.barrierId)?.title ??
                      'Барьер недоступен'}
                  </strong>
                  <span className="barrier-muted">{link.explanation}</span>
                </span>
                <Link2 size={18} />
                <span>
                  <strong>{link.familyTitle}</strong>
                  <span
                    className={`barrier-link-status${link.staleReasons.length ? ' stale' : ''}`}
                  >
                    {link.staleReasons.length
                      ? 'Требуется проверка'
                      : relationshipLabels[link.relationship]}
                  </span>
                </span>
              </button>
            ))
          )}
        </section>
      )}
      {selected ? (
        <section className="barrier-link-inspector" aria-label="Выбранная связь">
          <div className="barrier-inspector-heading">
            <h3>{relationshipLabels[selected.relationship]}</h3>
            <span className={`barrier-link-status${selected.staleReasons.length ? ' stale' : ''}`}>
              {selected.staleReasons.length ? 'Требуется проверка' : 'Редакция оснований сохранена'}
            </span>
          </div>
          <p className="barrier-muted">
            {context.snapshot.barriers.find((card) => card.id === selected.barrierId)?.title ??
              'Барьер недоступен'}{' '}
            → {selected.familyTitle}
          </p>
          {selected.staleReasons.length ? (
            <div className="barrier-conflict">
              <strong>Эта связь не считается актуальным ответом на барьер.</strong>
              <p>
                {selected.staleReasons.map((reason) => staleLabels[reason]).join('. ')}. Проверьте
                механизм и подтвердите новую редакцию.
              </p>
            </div>
          ) : null}
          <div className="barrier-inspector-body">
            <div>
              <h4>Механизм связи</h4>
              <p>{selected.explanation}</p>
              <h4>Условия применения</h4>
              <p>{selected.prerequisites || 'Условия пока не сформулированы.'}</p>
              <p className="barrier-byline">{selected.authorName}</p>
            </div>
            <div className="barrier-inspector-actions">
              <button
                className="button button-primary"
                onClick={() => setEvidence(selected.evidenceId)}
              >
                <FileText size={17} />
                Открыть основания
              </button>
              {canEditCard(selected, context.userId, context.isHost, context.editable) ? (
                <>
                  <button
                    className="button button-secondary"
                    disabled={
                      !context.snapshot.families.some(
                        (family) => family.id === selected.familyId,
                      ) ||
                      context.snapshot.barriers.find((card) => card.id === selected.barrierId)
                        ?.status !== 'active'
                    }
                    onClick={() =>
                      setEditor({
                        barrierId: selected.barrierId,
                        familyId: selected.familyId,
                        link: selected,
                      })
                    }
                  >
                    <Pencil size={17} />
                    {selected.staleReasons.length ? 'Проверить связь' : 'Изменить связь'}
                  </button>
                  <button className="button button-quiet" onClick={() => setArchive(selected)}>
                    <Archive size={16} />
                    Архивировать связь
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </section>
      ) : (
        <p className="barrier-note">
          Выберите линию или запись в списке, чтобы прочитать механизм, условия и источники.
        </p>
      )}
      <p className="barrier-footnote">
        Связь — рабочая гипотеза о механизме действия. Наличие связи не доказывает устранение
        барьера или демографический эффект.
      </p>
      <TaskMessage error={task.error} />
      {editor ? <LinkEditor context={context} {...editor} onClose={() => setEditor(null)} /> : null}
      {evidence ? (
        <EvidenceDialog context={context} evidenceId={evidence} onClose={() => setEvidence(null)} />
      ) : null}
      {archive ? (
        <Modal
          title="Архивировать связь?"
          onClose={() => setArchive(null)}
          actions={
            <>
              <button className="button button-secondary" onClick={() => setArchive(null)}>
                Отмена
              </button>
              <button
                className="button button-primary"
                disabled={task.working}
                onClick={() => {
                  const barrier = context.snapshot.barriers.find(
                    (card) => card.id === archive.barrierId,
                  );
                  const family = context.snapshot.families.find(
                    (card) => card.id === archive.familyId,
                  );
                  void task.run(
                    () =>
                      context.actions.saveLink({
                        linkId: archive.id,
                        expectedRevision: archive.revision,
                        barrierId: archive.barrierId,
                        expectedBarrierRevision:
                          barrier?.revision ?? archive.barrierContentRevision,
                        familyId: archive.familyId,
                        expectedFamilyFingerprint: family?.fingerprint ?? archive.familyFingerprint,
                        relationship: archive.relationship,
                        explanation: archive.explanation,
                        prerequisites: archive.prerequisites,
                        status: 'archived',
                      }),
                    () => {
                      setArchive(null);
                      setSelectedLink(null);
                    },
                  );
                }}
              >
                Архивировать связь
              </button>
            </>
          }
        >
          <p>
            Сохранённые основания останутся доступными; связь перестанет участвовать в текущем
            сопоставлении.
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
function Pager({
  page,
  count,
  onPage,
  noun,
}: {
  page: number;
  count: number;
  onPage: (page: number) => void;
  noun: string;
}) {
  return (
    <div className="barrier-pager">
      <button
        className="icon-button"
        aria-label={`${noun}: предыдущая страница`}
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      >
        <ArrowLeft size={16} />
      </button>
      <span>
        {noun}: {count ? `${page * 6 + 1}–${Math.min(count, (page + 1) * 6)} из ${count}` : 'нет'}
      </span>
      <button
        className="icon-button"
        aria-label={`${noun}: следующая страница`}
        disabled={(page + 1) * 6 >= count}
        onClick={() => onPage(page + 1)}
      >
        <ArrowRight size={16} />
      </button>
    </div>
  );
}
function ConnectionDiagram({
  barriers,
  families,
  links,
  barrierId,
  familyId,
  selectedLinkId,
  onBarrier,
  onFamily,
  onLink,
  editable,
  drag,
}: {
  barriers: BarrierCard[];
  families: BarrierFamilyOption[];
  links: BarrierPracticeLink[];
  barrierId: string;
  familyId: string;
  selectedLinkId: string | null;
  onBarrier: (id: string) => void;
  onFamily: (id: string) => void;
  onLink: (link: BarrierPracticeLink) => void;
  editable: boolean;
  drag: ReturnType<typeof useBarrierDrag>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<
    { link: BarrierPracticeLink; path: string; midX: number; midY: number }[]
  >([]);
  const geometryKey = [
    ...barriers.map((card) => card.id + card.title),
    ...families.map((card) => card.id + card.title),
    ...links.map((link) => link.id),
  ].join('|');
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    function measure() {
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const result = links.flatMap((link) => {
        const left = element.querySelector<HTMLElement>(
          `[data-connect-barrier="${link.barrierId}"]`,
        );
        const right = element.querySelector<HTMLElement>(
          `[data-connect-family="${link.familyId}"]`,
        );
        if (!left || !right) return [];
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        const x1 = a.right - bounds.left,
          y1 = a.top + a.height / 2 - bounds.top,
          x2 = b.left - bounds.left,
          y2 = b.top + b.height / 2 - bounds.top;
        const dx = Math.max(24, (x2 - x1) * 0.48);
        return [
          {
            link,
            midX: (x1 + x2) / 2,
            midY: (y1 + y2) / 2,
            path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
          },
        ];
      });
      setPaths(result);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [geometryKey, links]);
  return (
    <div className="barrier-graph" ref={ref}>
      <div className="barrier-graph-column">
        <h3>Барьеры</h3>
        {barriers.length ? (
          barriers.map((card) => (
            <div
              className={`barrier-graph-node${card.id === barrierId ? ' selected' : ''}`}
              data-connect-barrier={card.id}
              key={card.id}
            >
              <button
                className="barrier-graph-node-choice"
                aria-pressed={card.id === barrierId}
                onClick={() => onBarrier(card.id)}
              >
                <strong>{card.title}</strong>
                <span>{card.stageIds.length > 1 ? 'Несколько этапов' : 'Один этап'}</span>
              </button>
              {editable ? (
                <button
                  className="barrier-connector barrier-drag-handle"
                  aria-label={`Соединить барьер «${card.title}»`}
                  title="Перетащите к семейству или выберите кнопками"
                  onPointerDown={(event) => drag.start(event, card.id, card.title)}
                  onPointerMove={drag.move}
                  onPointerUp={drag.finish}
                  onPointerCancel={drag.cancel}
                  onClick={(event) => drag.click(event, card.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') drag.cancel();
                  }}
                >
                  <Circle size={17} />
                </button>
              ) : null}
            </div>
          ))
        ) : (
          <Empty title="Нет подходящих барьеров">Добавьте барьер или измените фильтр.</Empty>
        )}
      </div>
      <div className="barrier-graph-column">
        <h3>Семейства практик</h3>
        {families.length ? (
          families.map((card) => (
            <button
              key={card.id}
              className={`barrier-graph-node family${card.id === familyId ? ' selected' : ''}${drag.drag?.over === card.id ? ' drag-over' : ''}`}
              data-connect-family={card.id}
              data-barrier-family-drop={card.id}
              aria-pressed={card.id === familyId}
              onClick={() => onFamily(card.id)}
            >
              <span className="barrier-family-port">
                <Circle size={17} />
              </span>
              <strong>{card.title}</strong>
              <span>
                Вариантов: {card.variantCount} · {card.regionNames.slice(0, 2).join(', ')}
                {card.regionNames.length > 2 ? ' и другие' : ''}
              </span>
            </button>
          ))
        ) : (
          <Empty title="Семейства ещё не собраны">
            Объедините отобранные карточки на вкладке практик.
          </Empty>
        )}
      </div>
      <svg className="barrier-graph-lines" aria-label="Связи видимых карточек" role="group">
        {paths.map(({ link, path, midX, midY }) => (
          <g
            key={link.id}
            className={`barrier-graph-edge${link.id === selectedLinkId ? ' selected' : ''}${link.staleReasons.length ? ' stale' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`Открыть связь: ${barriers.find((card) => card.id === link.barrierId)?.title} — ${link.familyTitle}${link.staleReasons.length ? ', требует проверки' : ''}`}
            onClick={() => onLink(link)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onLink(link);
              }
            }}
          >
            <path d={path} className="barrier-edge-visible" />
            <path d={path} className="barrier-edge-hit" />
            <circle cx={midX} cy={midY} r={12} fill="transparent" pointerEvents="none" />
          </g>
        ))}
      </svg>
    </div>
  );
}
function LinkEditor({
  context,
  barrierId,
  familyId,
  link,
  onClose,
}: {
  context: BarrierBoardContext;
  barrierId: string;
  familyId: string;
  link?: BarrierPracticeLink;
  onClose: () => void;
}) {
  const barrier = context.snapshot.barriers.find((card) => card.id === barrierId);
  const family = context.snapshot.families.find((card) => card.id === familyId);
  const [draft, setDraft] = useState<SaveBarrierLinkInput>(() => ({
    linkId: link?.id ?? null,
    expectedRevision: link?.revision ?? 0,
    barrierId,
    expectedBarrierRevision: barrier?.revision ?? 0,
    familyId,
    expectedFamilyFingerprint: family?.fingerprint ?? '',
    relationship: link?.relationship ?? 'potential',
    explanation: link?.explanation ?? '',
    prerequisites: link?.prerequisites ?? '',
    status: 'active',
  }));
  const latestLink = link ? context.snapshot.links.find((item) => item.id === link.id) : undefined;
  const changed =
    (!!barrier && barrier.revision !== draft.expectedBarrierRevision) ||
    (!!family && family.fingerprint !== draft.expectedFamilyFingerprint) ||
    (!!latestLink && latestLink.revision !== draft.expectedRevision);
  const task = useBarrierTask();
  const id = useId();
  const missing = !barrier || barrier.status !== 'active' || !family;
  return (
    <Modal
      title={link ? 'Проверить и сохранить связь' : 'Обосновать новую связь'}
      onClose={onClose}
      wide
      actions={
        <>
          <button className="button button-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            type="submit"
            form={id}
            className="button button-primary"
            disabled={task.working || changed || missing || !context.editable}
          >
            <Check size={16} />
            {task.working ? 'Сохраняем…' : 'Сохранить связь'}
          </button>
        </>
      }
    >
      <form
        id={id}
        className="barrier-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (missing || changed) return;
          void task.run(() => context.actions.saveLink(draft), onClose);
        }}
      >
        <div className="barrier-link-summary">
          <h3>{barrier?.title ?? 'Барьер недоступен'}</h3>
          <Link2 size={20} />
          <h3>{family?.title ?? link?.familyTitle ?? 'Семейство недоступно'}</h3>
        </div>
        {barrier ? (
          <StageChips stageIds={barrier.stageIds} primaryStage={barrier.primaryStage} />
        ) : null}
        <p className="barrier-note">
          После сохранения связь получит неизменяемую редакцию региональных вариантов, точных цитат
          и условий. Это позволяет вернуться к исходным основаниям.
        </p>
        <label>
          Характер связи
          <select
            aria-label="Характер связи"
            value={draft.relationship}
            onChange={(event) =>
              setDraft((old) => ({
                ...old,
                relationship: event.target.value as BarrierRelationship,
              }))
            }
          >
            {Object.entries(relationshipLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Как практика затрагивает барьер
          <textarea
            required
            minLength={10}
            maxLength={4000}
            rows={4}
            value={draft.explanation}
            onChange={(event) => setDraft((old) => ({ ...old, explanation: event.target.value }))}
            placeholder="Какой механизм изменяет ситуацию и для какой группы? Что остаётся нерешённым?"
          />
        </label>
        <label>
          Условия применения
          <textarea
            maxLength={4000}
            rows={3}
            value={draft.prerequisites}
            onChange={(event) => setDraft((old) => ({ ...old, prerequisites: event.target.value }))}
            placeholder="Какие полномочия, ресурсы и местные условия нужны?"
          />
        </label>
        <RevisionNotice
          changed={changed}
          onAccept={() => {
            if (barrier && family)
              setDraft((old) => ({
                ...old,
                expectedRevision: latestLink?.revision ?? old.expectedRevision,
                expectedBarrierRevision: barrier.revision,
                expectedFamilyFingerprint: family.fingerprint,
              }));
          }}
        >
          <p>Актуальный барьер: {barrier?.description}</p>
          <p>Механизм семейства: {family?.mechanism}</p>
          {latestLink ? <p>Актуальный текст связи: {latestLink.explanation}</p> : null}
        </RevisionNotice>
        {missing ? (
          <p className="barrier-feedback error" role="alert">
            Один из объектов больше не доступен для новой связи. Ваш текст сохранён в форме.
          </p>
        ) : null}
        <TaskMessage error={task.error} />
      </form>
    </Modal>
  );
}
