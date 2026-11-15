import { useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Link2, Plus, X } from 'lucide-react';
import { Modal } from '../Modal';
import { useFlipchart } from '../../hooks/useFlipchart';
import { useLivePracticeVotes } from '../../hooks/useLivePracticeVotes';
import type { useBarriers } from '../../hooks/useBarriers';
import type { SessionApi } from '../../lib/session-api';
import type {
  AuthorSolution,
  BarrierCard,
  BarrierFamilyOption,
  BarrierPracticeLink,
  BarriersSnapshot,
  SaveBarrierLinkInput,
} from '../../../../../packages/barriers/types';
import type { FlipchartPublicNote } from '../../../../../packages/flipchart/types';
import type { WorkspaceVoteTotals } from '../../../../../packages/workshop/live-votes';
import { LifecycleStageTrack } from './LifecycleStageTrack';
import {
  isLifecycleStage, lifecycleStageLabels, lifecycleStages, mainLifecycleStages,
  type LifecycleStage,
} from './lifecycle-stages';
import { Busy, TaskMessage, useBarrierTask } from './common';
import './lifecycle-stage.css';
import './lifecycle-solutions.css';

const legacyStage = 'unassigned';
const pageSize = 20;
type Stage = LifecycleStage | typeof legacyStage;
type FactorBoard = 'parenthood' | 'objective';
type FamilyReference = Pick<BarrierFamilyOption, 'id' | 'fingerprint'>;
type Measure =
  | { kind: 'factor'; id: string; title: string; board: FactorBoard }
  | { kind: 'family'; id: string; title: string; family: FamilyReference; rank?: number }
  | { kind: 'author'; id: string; title: string; solution: AuthorSolution };
type Association = { measure: Measure; link?: BarrierPracticeLink; stale?: boolean };
type Dialog =
  | { kind: 'measures'; barrierId: string }
  | { kind: 'barriers'; measure: Measure }
  | { kind: 'new'; barrierId?: string };

const keyFor = (measure: Pick<Measure, 'kind' | 'id'>) => `${measure.kind}:${measure.id}`;
const compareTitles = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title, 'ru');
const matchText = (text: string) => text.normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё', 'е');

function measureSource(measure: Measure): string {
  if (measure.kind === 'author') return 'Предложение участника';
  if (measure.kind === 'factor')
    return measure.board === 'objective' ? 'Объективные факторы' : 'Субъективные факторы';
  return measure.rank === undefined ? 'Практики' : `Практики · место ${measure.rank} в рейтинге`;
}

function measureDescription(measure: Measure) {
  return measure.kind === 'author' ? measure.solution.mechanism : undefined;
}

function barrierStages(barrier: BarrierCard): string {
  const labels = barrier.stageIds.filter(isLifecycleStage).map(stage => lifecycleStageLabels[stage]);
  return labels.length ? labels.join(' · ') : 'Уточнить этап';
}

function buildBoard(
  snapshot: BarriersSnapshot | null,
  subjective: readonly FlipchartPublicNote[],
  objective: readonly FlipchartPublicNote[],
  votes: readonly WorkspaceVoteTotals[] | undefined,
) {
  const barriers = (snapshot?.barriers ?? []).filter(barrier => barrier.status === 'active').sort(compareTitles);
  const barrierById = new Map(barriers.map(barrier => [barrier.id, barrier]));
  const byStage = new Map<Stage, BarrierCard[]>();
  for (const barrier of barriers) {
    const known = barrier.stageIds.filter(isLifecycleStage);
    const stages: Stage[] = known.length ? known : [legacyStage];
    for (const stage of stages) {
      const entries = byStage.get(stage);
      if (entries) entries.push(barrier);
      else byStage.set(stage, [barrier]);
    }
  }

  const ranked = [...(votes ?? [])].sort((a, b) => b.score - a.score || b.support - a.support || compareTitles(a, b));
  const ranks = new Map(ranked.map((vote, index) => [vote.familyId, index + 1]));
  const familyMeasures: Measure[] = [...(snapshot?.families ?? [])]
    .sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) || compareTitles(a, b))
    .map(family => ({ kind: 'family', id: family.id, title: family.title, family, rank: ranks.get(family.id) }));
  const authorMeasures: Measure[] = (snapshot?.solutions ?? []).filter(solution => solution.status === 'active')
    .sort(compareTitles).map(solution => ({ kind: 'author', id: solution.id, title: solution.title, solution }));
  const factorMeasures: Measure[] = ([
    ['parenthood', subjective], ['objective', objective],
  ] as const).flatMap(([board, notes]) => notes
    .filter(note => note.kind === 'condition' && note.status === 'active')
    .map(note => ({ kind: 'factor', id: note.id, title: note.text, board })));
  const measures = [...familyMeasures, ...factorMeasures, ...authorMeasures];
  const measureByKey = new Map(measures.map(measure => [keyFor(measure), measure]));
  const associations = new Map<string, Map<string, Association>>();
  const covered = new Set<string>();
  const used = new Set<string>();

  function associate(barrierId: string, association: Association) {
    if (!barrierById.has(barrierId)) return;
    const key = keyFor(association.measure);
    let entries = associations.get(barrierId);
    if (!entries) {
      entries = new Map();
      associations.set(barrierId, entries);
    }
    const previous = entries.get(key);
    if (!previous || previous.stale && !association.stale) entries.set(key, association);
    if (!association.stale) {
      covered.add(barrierId);
      used.add(key);
    }
  }

  for (const link of snapshot?.links ?? []) {
    if (link.status !== 'active') continue;
    const measure = measureByKey.get(keyFor({ kind: 'family', id: link.familyId }));
    associate(link.barrierId, {
      measure: measure ?? {
        kind: 'family', id: link.familyId, title: link.familyTitle,
        family: { id: link.familyId, fingerprint: link.familyFingerprint },
      },
      link, stale: !measure || Boolean(link.staleReasons.length),
    });
  }
  for (const link of snapshot?.greenFactorLinks ?? []) {
    const measure = measureByKey.get(keyFor({ kind: 'factor', id: link.noteId })) ?? {
      kind: 'factor', id: link.noteId, title: link.title, board: link.sourceBoard,
    };
    associate(link.barrierId, { measure });
  }
  for (const measure of authorMeasures) {
    if (measure.kind !== 'author') continue;
    for (const barrierId of measure.solution.barrierIds) associate(barrierId, { measure });
  }
  return {
    barriers, barrierById, byStage, measures, associations,
    uncovered: barriers.filter(barrier => !covered.has(barrier.id)),
    unused: measures.filter(measure => !used.has(keyFor(measure))),
  };
}

function relationInput(barrier: BarrierCard, family: FamilyReference, previous?: BarrierPracticeLink): SaveBarrierLinkInput {
  return {
    linkId: previous?.id ?? null,
    expectedRevision: previous?.revision ?? 0,
    barrierId: barrier.id,
    expectedBarrierRevision: barrier.revision,
    familyId: family.id,
    expectedFamilyFingerprint: family.fingerprint,
    relationship: previous?.relationship ?? 'potential',
    explanation: previous?.explanation ?? '',
    prerequisites: previous?.prerequisites ?? '',
    status: 'active',
  };
}

function useListWindow(total: number, resetKey = '', container?: RefObject<HTMLDivElement | null>) {
  const [visible, setVisible] = useState({ resetKey, count: pageSize });
  const cursor = useRef<HTMLLIElement>(null);
  const count = visible.resetKey === resetKey ? visible.count : pageSize;
  const hasMore = count < total;

  useEffect(() => {
    if (!hasMore || !cursor.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible({ resetKey, count: total });
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        setVisible({ resetKey, count: Math.min(count + pageSize, total) });
      }
    }, { root: container?.current, rootMargin: '0px 0px 170px' });
    observer.observe(cursor.current);
    return () => observer.disconnect();
  }, [container, count, hasMore, resetKey, total]);

  return { count, hasMore, cursor };
}

function ListCursor({ window }: { window: ReturnType<typeof useListWindow> }) {
  return window.hasMore ? <li aria-hidden="true" className="solutions-list-cursor" ref={window.cursor} /> : null;
}

type PickItem = { key: string; title: string; detail: string; description?: string; onPick(): void };
function LinkPicker({ label, items, busy }: { label: string; items: PickItem[]; busy: boolean }) {
  const [search, setSearch] = useState('');
  const query = useDeferredValue(matchText(search.trim()));
  const container = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => items.filter(item => !query
    || matchText(`${item.title} ${item.detail} ${item.description ?? ''}`).includes(query)), [items, query]);
  const window = useListWindow(hits.length, query, container);

  return <div className="solutions-picker">
    <input type="search" className="input" aria-label={label} placeholder={label}
      value={search} onChange={event => setSearch(event.target.value)} />
    <div className="solutions-picker-list" ref={container}>
      {hits.length ? (
        <ul className="solutions-list">
          {hits.slice(0, window.count).map(item => <li key={item.key} className="solutions-choice">
            <span>{item.title}<small>{item.detail}</small>
              {item.description ? <small className="solutions-measure-description">{item.description}</small> : null}
            </span>
            <button type="button" className="button button-secondary" disabled={busy}
              aria-label={`Связать: ${item.title}`} onClick={item.onPick}>Связать</button>
          </li>)}
          <ListCursor window={window} />
        </ul>
      ) : <p className="solutions-empty">{query ? 'Совпадений нет.' : 'Нет доступных карточек.'}</p>}
    </div>
  </div>;
}

export function LifecycleSolutions({
  barriers, api, sessionId, userId, editable, isHost = false,
}: {
  barriers: ReturnType<typeof useBarriers>;
  api: SessionApi | null;
  sessionId: string | null;
  userId: string | null;
  editable: boolean;
  isHost?: boolean;
}) {
  const subjective = useFlipchart({ api, sessionId, userId });
  const objective = useFlipchart({ api, sessionId, userId, board: 'objective' });
  const ranking = useLivePracticeVotes({ api, sessionId, userId });
  const task = useBarrierTask();
  const board = useMemo(
    () => buildBoard(barriers.snapshot, subjective.notes, objective.notes, ranking.data?.families),
    [barriers.snapshot, subjective.notes, objective.notes, ranking.data?.families],
  );
  const [stage, setStage] = useState<Stage | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const barrierWindow = useListWindow(board.uncovered.length);
  const measureWindow = useListWindow(board.unused.length);
  const activeStage = stage ?? lifecycleStages.find(key => board.byStage.has(key))
    ?? (board.byStage.has(legacyStage) ? legacyStage : mainLifecycleStages[0]);
  const placedBarriers = board.byStage.get(activeStage) ?? [];
  const counts = useMemo(() => new Map(lifecycleStages.map(key => [key, board.byStage.get(key)?.length ?? 0])), [board.byStage]);
  const busy = barriers.busy || task.working;
  const loadError = subjective.error ?? objective.error ?? ranking.error;
  const loading = subjective.loading || objective.loading || ranking.loading;

  function canManageLink(link: BarrierPracticeLink) {
    return isHost || link.authorId === userId
      || (link.relationship === 'potential' && !link.explanation && !link.prerequisites);
  }

  function showDialog(value: Dialog) {
    task.clear();
    if (value.kind === 'new') {
      setTitle('');
      setDescription('');
    }
    setDialog(value);
  }

  function saveRelation(barrier: BarrierCard, measure: Measure) {
    const already = board.associations.get(barrier.id)?.get(keyFor(measure));
    if (already && !already.stale) return;
    void task.run(async () => {
      if (measure.kind === 'family') {
        const previous = barriers.snapshot?.links.find(link => link.barrierId === barrier.id
          && link.familyId === measure.id && canManageLink(link));
        await barriers.actions.saveLink(relationInput(barrier, measure.family, previous));
      } else {
        await barriers.actions.setSolutionBarrier({
          kind: measure.kind, measureId: measure.id, barrierId: barrier.id, linked: true,
        });
      }
    }, () => setDialog(null));
  }

  function removeRelation(barrier: BarrierCard, association: Association) {
    void task.run(async () => {
      if (association.measure.kind === 'family') {
        if (!association.link) return;
        await barriers.actions.saveLink({ ...relationInput(barrier, association.measure.family, association.link), status: 'archived' });
      } else {
        await barriers.actions.setSolutionBarrier({
          kind: association.measure.kind, measureId: association.measure.id, barrierId: barrier.id, linked: false,
        });
      }
    });
  }

  const dialogBarrier = dialog && dialog.kind !== 'barriers' && dialog.barrierId
    ? board.barrierById.get(dialog.barrierId) : undefined;
  const measureChoices = dialog?.kind === 'measures' && dialogBarrier
    ? board.measures.filter(measure => {
      const link = board.associations.get(dialogBarrier.id)?.get(keyFor(measure));
      return !link || link.stale;
    }).map(measure => ({
      key: keyFor(measure), title: measure.title, detail: measureSource(measure),
      description: measureDescription(measure),
      onPick: () => saveRelation(dialogBarrier, measure),
    }))
    : [];
  const barrierChoices = dialog?.kind === 'barriers'
    ? board.barriers.filter(barrier => {
      const link = board.associations.get(barrier.id)?.get(keyFor(dialog.measure));
      return !link || link.stale;
    }).map(barrier => ({
      key: barrier.id, title: barrier.title, detail: barrierStages(barrier),
      onPick: () => saveRelation(barrier, dialog.measure),
    }))
    : [];

  return <section className="lifecycle-solutions" aria-label="Решения">
    <TaskMessage error={dialog ? null : task.error ?? barriers.error ?? loadError} />
    {!barriers.snapshot && barriers.loading ? <Busy>Загружаем решения…</Busy> : null}
    {barriers.snapshot ? <>
      <LifecycleStageTrack counts={counts} selected={activeStage === legacyStage ? null : activeStage} onSelect={setStage} />
      {board.byStage.has(legacyStage) ? (
        <button type="button" className="button button-secondary solutions-legacy"
          aria-pressed={activeStage === legacyStage} onClick={() => setStage(legacyStage)}>Уточнить этап</button>
      ) : null}
      <section className="solutions-stage" aria-label={activeStage === legacyStage ? 'Уточнить этап' : lifecycleStageLabels[activeStage]}>
        <h2>{activeStage === legacyStage ? 'Уточнить этап' : lifecycleStageLabels[activeStage]}</h2>
        {placedBarriers.length ? <ul>
          {placedBarriers.map(barrier => (
            <li key={barrier.id} className="solutions-barrier">
              <div className="solutions-heading">
                <h3>{barrier.title}</h3>
                {editable ? <button type="button" className="button button-secondary" disabled={busy}
                  onClick={() => showDialog({ kind: 'measures', barrierId: barrier.id })}>
                  <Link2 size={16} aria-hidden="true" />Связать с мерой
                </button> : null}
              </div>
              {barrier.description ? <p className="solutions-description">{barrier.description}</p> : null}
              {board.associations.get(barrier.id)?.size ? <ul aria-label="Связанные меры">
                {[...board.associations.get(barrier.id)!.values()].map(association => {
                  const { measure, link, stale } = association;
                  const canRemove = editable && (measure.kind !== 'family' || Boolean(link && canManageLink(link)));
                  return <li key={keyFor(measure)} className="solutions-relation" data-stale={stale || undefined}>
                    <span>{measure.title}<small>{stale ? 'Проверьте связь' : measureSource(measure)}</small>
                      {measureDescription(measure) ? <small className="solutions-measure-description">{measureDescription(measure)}</small> : null}
                    </span>
                    {canRemove ? <button type="button" className="icon-button" disabled={busy}
                      aria-label={`Убрать связь: ${measure.title}`} onClick={() => removeRelation(barrier, association)}>
                      <X size={16} aria-hidden="true" />
                    </button> : null}
                  </li>;
                })}
              </ul> : null}
            </li>
          ))}
        </ul> : <p className="solutions-empty">На этом этапе пока нет барьеров.</p>}
      </section>

      <div className="solutions-summary">
        <section aria-label="Барьеры без решений">
          <h2>Барьеры без решений · {board.uncovered.length}</h2>
          {board.uncovered.length ? <>
            <ul className="solutions-list">
              {board.uncovered.slice(0, barrierWindow.count).map(barrier => (
                <li key={barrier.id} className="solutions-result">
                  <span>{barrier.title}<small>{barrierStages(barrier)}</small></span>
                  {editable ? <button type="button" className="button button-secondary" disabled={busy}
                    aria-label={`Подобрать меру: ${barrier.title}`}
                    onClick={() => showDialog({ kind: 'measures', barrierId: barrier.id })}>Связать</button> : null}
                </li>
              ))}
              <ListCursor window={barrierWindow} />
            </ul>
          </> : <p className="solutions-empty">{board.barriers.length ? 'У каждого барьера есть решение.' : 'Пока нет барьеров.'}</p>}
        </section>
        <section aria-label="Меры без связей">
          <div className="solutions-heading">
            <h2>Меры без связей · {board.unused.length}</h2>
            {editable ? <button type="button" className="button button-secondary" disabled={busy}
              onClick={() => showDialog({ kind: 'new' })}><Plus size={16} aria-hidden="true" />Предложить меру</button> : null}
          </div>
          {board.unused.length ? <>
            <ul className="solutions-list">
              {board.unused.slice(0, measureWindow.count).map(measure => (
                <li key={keyFor(measure)} className="solutions-result">
                  <span>{measure.title}<small>{measureSource(measure)}</small>
                    {measureDescription(measure) ? <small className="solutions-measure-description">{measureDescription(measure)}</small> : null}
                  </span>
                  {editable && board.barriers.length ? <button type="button" className="button button-secondary" disabled={busy}
                    aria-label={`Подобрать барьер: ${measure.title}`}
                    onClick={() => showDialog({ kind: 'barriers', measure })}>Связать</button> : null}
                </li>
              ))}
              <ListCursor window={measureWindow} />
            </ul>
          </> : <p className="solutions-empty">{loading ? 'Загружаем меры…' : board.measures.length ? 'У всех мер есть связи.' : 'Пока нет мер.'}</p>}
        </section>
      </div>
    </> : null}

    {dialog ? <Modal title={dialog.kind === 'new' ? 'Предложить меру'
      : dialog.kind === 'barriers' ? 'Связать с барьером' : 'Связать с мерой'}
      onClose={() => { if (!busy) setDialog(null); }}>
      <TaskMessage error={task.error ?? barriers.error ?? loadError} />
      {dialog.kind === 'new' ? <form className="solutions-form" onSubmit={event => {
        event.preventDefault();
        if (!editable || busy || !title.trim() || dialog.barrierId && !dialogBarrier) return;
        void task.run(() => barriers.actions.saveSolution({
          solutionId: null, expectedRevision: 0, format: 'brief',
          title: title.trim(), mechanism: description.trim(),
          barrierIds: dialogBarrier ? [dialogBarrier.id] : [],
          targetGroup: '', firstStep: '', responsible: '', resources: '', successIndicator: '', risks: '',
          status: 'active',
        }), () => setDialog(null));
      }}>
        {dialogBarrier ? <p>{dialogBarrier.title}</p> : null}
        <label>Название меры<input className="input" value={title} required maxLength={240}
          onChange={event => setTitle(event.target.value)} /></label>
        <label>Описание<textarea className="input" value={description} rows={3} maxLength={4000}
          onChange={event => setDescription(event.target.value)} /></label>
        <button type="submit" className="button button-primary" disabled={!editable || busy || !title.trim()}>
          Сохранить меру
        </button>
      </form> : <>
        <p>{dialog.kind === 'barriers' ? dialog.measure.title : dialogBarrier?.title}</p>
        <LinkPicker key={dialog.kind} label={dialog.kind === 'barriers' ? 'Найти барьер' : 'Найти меру'}
          items={dialog.kind === 'barriers' ? barrierChoices : measureChoices} busy={busy || !editable} />
        {dialog.kind === 'measures' && dialogBarrier ? <button type="button" className="button button-secondary"
          disabled={busy || !editable} onClick={() => showDialog({ kind: 'new', barrierId: dialogBarrier.id })}>
          <Plus size={16} aria-hidden="true" />Предложить меру
        </button> : null}
      </>}
    </Modal> : null}
  </section>;
}
