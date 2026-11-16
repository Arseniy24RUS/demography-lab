import { useMemo, useState } from 'react';
import {
  Banknote, BarChart3, BriefcaseBusiness, CheckSquare, Cloud, FileText, HeartPulse, House, Layers3,
  Lightbulb, MapPin, Monitor, Pencil, RotateCcw, School, Search, ThumbsDown, ThumbsUp, UsersRound, X,
} from 'lucide-react';
import type { TextAnchor } from '@domain/index';
import type { SessionAreaState, SharedSubmission } from '../../../../../packages/collaboration/types';
import type { PracticeFamily } from '../../../../../packages/workshop/types';
import type { WorkspaceVoteFamily, WorkspaceVotesSnapshot } from '../../../../../packages/workshop/live-votes';
import type { SessionApi } from '../../lib/session-api';
import type { useWorkshop } from '../../hooks/useWorkshop';
import type { CorpusManifest } from '../../lib/corpus';
import { useLivePracticeVotes } from '../../hooks/useLivePracticeVotes';
import { noteTone } from '../../lib/workshop-note';
import { PracticeDetails } from './PracticeDetails';
import { PracticeGroupDialog } from './PracticeGroupDialog';
import type { PracticeGroupDraft } from './PracticeGroupDialog';
import { useWorkshopTask } from './useWorkshopTask';
import { regionName, type WorkshopRegionOption } from './workshop-ui';
import '../../live-votes.css';
import '../../workshop-notes.css';

export interface PracticeVariantControls {
  busy?: boolean;
  focused?: boolean;
  onEdit?: () => void;
  onWithdraw?: () => void;
  onRestore?: () => void;
  onFocus?: () => void;
}
export type PracticeVariantActions = (submission: SharedSubmission) => PracticeVariantControls;

export interface PracticeBoardCard {
  key: string;
  family: PracticeFamily | null;
  title: string;
  mechanism: string;
  createdAt: string;
  variants: SharedSubmission[];
  vote: WorkspaceVoteFamily | null;
}

/** Every shared publication remains visible, including a temporary gap between independent polls. */
export function buildPracticeBoardCards(families: readonly PracticeFamily[], entries: readonly SharedSubmission[], totals: readonly WorkspaceVoteFamily[]): PracticeBoardCard[] {
  const shared = new Map(entries.filter(entry => entry.status === 'shared').map(entry => [entry.id, entry]));
  const votes = new Map(totals.map(value => [value.familyId, value]));
  const grouped = new Set<string>();
  const cards: PracticeBoardCard[] = [];
  for (const family of families) {
    const variants = family.submissionIds.map(id => shared.get(id)).filter((entry): entry is SharedSubmission => Boolean(entry));
    if (!variants.length) continue;
    for (const variant of variants) grouped.add(variant.id);
    cards.push({ key: `family:${family.id}`, family, title: family.title, mechanism: family.mechanism,
      createdAt: family.createdAt, variants, vote: votes.get(family.id) ?? null });
  }
  for (const entry of shared.values()) {
    if (grouped.has(entry.id)) continue;
    cards.push({ key: `submission:${entry.id}`, family: null, title: entry.bundle.practice.title,
      mechanism: entry.bundle.practice.mechanism, createdAt: entry.createdAt, variants: [entry], vote: null });
  }
  return cards;
}

function practiceIcon(title: string) {
  const name = title.toLocaleLowerCase('ru');
  if (/ипотек|жиль|квартир/u.test(name)) return House;
  if (/капитал|выплат|пособи|компенсац/u.test(name)) return Banknote;
  if (/работ|занятост|отпуск/u.test(name)) return BriefcaseBusiness;
  if (/детск.+сад|дошкол|школ/u.test(name)) return School;
  if (/здоров|медицин|эко(?:\s|$)/u.test(name)) return HeartPulse;
  if (/семейн|семь[яеи]/u.test(name)) return UsersRound;
  return Lightbulb;
}
function territoryCount(total: number) {
  const plural = new Intl.PluralRules('ru').select(total);
  return `${total} ${plural === 'one' ? 'регион' : plural === 'few' ? 'региона' : 'регионов'}`;
}

function VariantActions({ controls, busy }: { controls?: PracticeVariantControls; busy: boolean }) {
  if (!controls) return null;
  const disabled = busy || controls.busy;
  return <>
    {controls.onEdit ? <button type="button" className="button button-quiet" disabled={disabled} onClick={controls.onEdit}>
      <Pencil size={15} aria-hidden="true" />Изменить карточку
    </button> : null}
    {controls.onWithdraw ? <button type="button" className="button button-quiet" disabled={disabled} onClick={controls.onWithdraw}>
      <X size={15} aria-hidden="true" />Снять карточку
    </button> : null}
    {controls.onRestore ? <button type="button" className="button button-quiet" disabled={disabled} onClick={controls.onRestore}>
      <RotateCcw size={15} aria-hidden="true" />Вернуть карточку
    </button> : null}
    {controls.onFocus ? <button type="button" className="button button-quiet" disabled={disabled} onClick={controls.onFocus} aria-pressed={controls.focused}>
      <Monitor size={15} aria-hidden="true" />{controls.focused ? 'Убрать с проектора' : 'На проектор'}
    </button> : null}
  </>;
}

function RankedVariants({ variants, regions, onInspect, variantActions, busy, onEditGroup, onSeparate }: {
  variants: SharedSubmission[];
  regions: WorkshopRegionOption[];
  onInspect: (variant: SharedSubmission) => void;
  variantActions?: PracticeVariantActions;
  busy: boolean;
  onEditGroup?: () => void;
  onSeparate?: (variant: SharedSubmission) => void;
}) {
  const [open, setOpen] = useState(false);
  return <details className="live-vote-sources" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Варианты мер · {variants.length}</summary>
    {open ? <>
      {variants.map(variant => <div className="live-vote-source" key={variant.id} data-submission-id={variant.id}>
        <h4>{regionName(regions, variant.bundle.practice.regionId)}</h4>
        <p>{variant.bundle.practice.title}</p>
        {!variant.bundle.catalogSource ? <p className="live-vote-author">{variant.authorName}</p> : null}
        {variant.bundle.practice.amount ? <p>{variant.bundle.practice.amount}</p> : null}
        <div className="live-vote-source-actions">
          <button type="button" className="button button-quiet" onClick={() => onInspect(variant)}>
            <FileText size={16} aria-hidden="true" />Подробности варианта
          </button>
          <VariantActions controls={variantActions?.(variant)} busy={busy} />
          {onSeparate ? <button type="button" className="button button-quiet" disabled={busy} onClick={() => onSeparate(variant)}>
            Отдельной карточкой
          </button> : null}
        </div>
      </div>)}
      {onEditGroup ? <button type="button" className="button button-quiet live-vote-edit-group" disabled={busy} onClick={onEditGroup}>
        <Pencil size={15} aria-hidden="true" />Изменить группу
      </button> : null}
    </> : null}
  </details>;
}

const noEntries: SharedSubmission[] = [];
const noFamilies: PracticeFamily[] = [];
const noVotes: WorkspaceVoteFamily[] = [];

export function LivePracticeVoting({ state, api, workshop, onOpenSource, manifest, variantActions }: {
  state: SessionAreaState; api: SessionApi | null; workshop: ReturnType<typeof useWorkshop>;
  onOpenSource: (anchor: TextAnchor) => void; manifest: CorpusManifest; variantActions?: PracticeVariantActions;
}) {
  const votes = useLivePracticeVotes({ api, sessionId: state.snapshot?.session.id ?? null, userId: state.auth.userId });
  const [view, setView] = useState<'cloud' | 'ranking'>('cloud');
  const [query, setQuery] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<PracticeGroupDraft | null>(null);
  const [inspecting, setInspecting] = useState<SharedSubmission | null>(null);
  const groupTask = useWorkshopTask();
  const groupedFamilies = workshop.snapshot?.families ?? noFamilies;
  const entries = state.snapshot?.submissions ?? noEntries;
  const votedFamilies = (votes.data as WorkspaceVotesSnapshot | null)?.families ?? noVotes;
  const regions = useMemo(() => manifest.documents.map(entry => ({
    id: entry.regionId, name: entry.territory, hasDocument: Boolean(entry.textUrl),
  })), [manifest]);
  const board = useMemo(() => buildPracticeBoardCards(groupedFamilies, entries, votedFamilies), [groupedFamilies, entries, votedFamilies]);
  const cards = useMemo(() => [...board].sort((a, b) => view === 'ranking'
    ? Number(Boolean(b.vote)) - Number(Boolean(a.vote)) || (b.vote?.score ?? 0) - (a.vote?.score ?? 0)
      || (b.vote?.support ?? 0) - (a.vote?.support ?? 0) || a.title.localeCompare(b.title, 'ru') || a.key.localeCompare(b.key)
    : b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key)), [board, view]);
  const positions = useMemo(() => new Map(cards.filter(card => card.vote).map((card, index) => [card.key, index + 1])), [cards]);
  const cardsByKey = useMemo(() => new Map(board.map(card => [card.key, card])), [board]);
  const sharedById = useMemo(() => new Map(entries.filter(entry => entry.status === 'shared').map(entry => [entry.id, entry])), [entries]);
  const selectedCards = board.filter(card => selected.has(card.key));
  const needle = query.trim().toLocaleLowerCase('ru');
  const visible = needle ? cards.filter(card => [card.title, card.mechanism,
    ...card.variants.map(variant => variant.bundle.practice.title)].some(text => text.toLocaleLowerCase('ru').includes(needle))) : cards;
  const session = state.snapshot?.session;
  const canContribute = Boolean(session?.status === 'open' && session.role !== 'observer');
  const canGroup = Boolean(canContribute && workshop.snapshot && workshop.snapshot.round?.status !== 'open');
  const busy = workshop.busy || state.busy !== null || groupTask.working;
  const withdrawn = variantActions ? entries.filter(entry => entry.status === 'withdrawn' && variantActions(entry).onRestore) : [];
  const stale = Boolean(draft && workshop.snapshot?.boardRevision !== draft.expectedBoardRevision);
  const unavailable = Boolean(draft && (draft.submissionIds.some(id => !sharedById.has(id))
    || (draft.mode !== 'split' && draft.cardKeys.some(key => !cardsByKey.has(key)))));

  function choose(key: string) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function openGroup(cardsToGroup: PracticeBoardCard[], mode: 'merge' | 'edit', family?: PracticeFamily) {
    if (!workshop.snapshot || !canGroup || busy) return;
    const ids = [...new Set(cardsToGroup.flatMap(card => card.family?.submissionIds ?? card.variants.map(variant => variant.id)))];
    if (!ids.length || (mode === 'merge' && cardsToGroup.length < 2)) return;
    groupTask.clearError();
    setDraft({ mode, familyId: family?.id ?? null, expectedBoardRevision: workshop.snapshot.boardRevision,
      title: family?.title ?? '', mechanism: family?.mechanism ?? '', rationale: family?.rationale ?? '',
      originalMechanism: family?.mechanism ?? '', submissionIds: ids, cardKeys: cardsToGroup.map(card => card.key),
      labels: cardsToGroup.map(card => card.title) });
  }
  function separate(variant: SharedSubmission) {
    if (!workshop.snapshot || !canGroup || busy) return;
    groupTask.clearError();
    setDraft({ mode: 'split', familyId: null, expectedBoardRevision: workshop.snapshot.boardRevision,
      title: variant.bundle.practice.title, mechanism: variant.bundle.practice.mechanism,
      rationale: variant.bundle.practice.mechanism, originalMechanism: variant.bundle.practice.mechanism,
      submissionIds: [variant.id], cardKeys: [], labels: [variant.bundle.practice.title] });
  }
  function refreshDraft() {
    if (!draft || !workshop.snapshot || unavailable || busy) return;
    const currentCards = draft.cardKeys.map(key => cardsByKey.get(key)!);
    const ids = draft.mode === 'split' ? draft.submissionIds
      : [...new Set(currentCards.flatMap(card => card.family?.submissionIds ?? card.variants.map(variant => variant.id)))];
    groupTask.clearError();
    setDraft({ ...draft, expectedBoardRevision: workshop.snapshot.boardRevision, submissionIds: ids,
      labels: draft.mode === 'split' ? draft.labels : currentCards.map(card => card.title) });
  }
  async function saveGroup() {
    if (!draft || !canGroup || busy || stale || unavailable || !draft.title.trim() || !draft.mechanism.trim()) return;
    const savedDraft = draft;
    await groupTask.run(async () => {
      try {
        await workshop.actions.saveFamily({ familyId: savedDraft.familyId, expectedBoardRevision: savedDraft.expectedBoardRevision,
          title: savedDraft.title.trim(), mechanism: savedDraft.mechanism.trim(),
          rationale: savedDraft.mode === 'edit' && savedDraft.mechanism === savedDraft.originalMechanism
            ? savedDraft.rationale : savedDraft.mechanism.trim(), submissionIds: savedDraft.submissionIds });
      } catch (error) {
        await workshop.actions.refresh().catch(() => {});
        throw error;
      }
      await votes.refresh();
    }, () => { setDraft(null); setSelected(new Set()); setSelecting(false); }, 'Группа сохранена.');
  }

  return <section className="live-votes" aria-label="Рейтинг практик" data-view={view}>
    <header className="live-votes-heading">
      <div><h2>Практики</h2><p>Выберите меры, которые стоит обсуждать.</p></div>
      <div className="live-votes-tools">
        <div className="live-votes-view-switch" role="group" aria-label="Вид практик">
          <button type="button" aria-pressed={view === 'cloud'} onClick={() => setView('cloud')}><Cloud size={18} aria-hidden="true" />Облако</button>
          <button type="button" aria-pressed={view === 'ranking'} onClick={() => setView('ranking')}><BarChart3 size={18} aria-hidden="true" />Рейтинг</button>
        </div>
        <label className="workshop-note-search"><Search size={16} aria-hidden="true" />
          <input type="search" aria-label="Найти меру" placeholder="Найти меру" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        {canGroup ? <button type="button" className="button button-secondary" aria-pressed={selecting} disabled={busy}
          onClick={() => { setSelecting(previous => !previous); setSelected(new Set()); }}>
          <CheckSquare size={17} aria-hidden="true" />{selecting ? 'Отменить выбор' : 'Выбрать'}
        </button> : null}
        {selecting && canGroup ? <>
          <span className="live-vote-selected-count">Выбрано: {selectedCards.length}</span>
          <button type="button" className="button button-primary" disabled={busy || selectedCards.length < 2} onClick={() => openGroup(selectedCards, 'merge')}>
            <Layers3 size={17} aria-hidden="true" />Группировать
          </button>
        </> : null}
      </div>
    </header>
    {votes.error ? <div className="session-message" data-tone="error" role="alert"><p>{votes.error}</p>
      <button className="button button-quiet" onClick={() => void votes.refresh()}>Обновить</button></div> : null}
    {!draft && (groupTask.error || workshop.error) ? <p className="session-message" data-tone="error" role="alert">{groupTask.error ?? workshop.error}</p> : null}
    {groupTask.notice ? <p className="workshop-notice" role="status">{groupTask.notice}</p> : null}
    {!workshop.snapshot && workshop.loading ? <p role="status">Получаем карточки…</p> : null}
    {!votes.data && votes.loading ? <p role="status">Получаем оценки…</p> : null}
    {state.snapshot && !cards.length && !workshop.loading ? <div className="workshop-empty"><h3>Практики ещё не отобраны</h3>
      <p>Выберите меры во вкладке «Программы» или опубликуйте свою карточку по документу.</p></div> : null}
    {cards.length && !visible.length ? <p className="live-vote-query-empty">По этому запросу мер нет.</p> : null}
    <div className="live-vote-list" data-view={view}>
      {visible.map(card => {
        const familyVote = card.vote;
        const disabled = busy || selecting || !canContribute || votes.pendingFamilyId !== null;
        const Icon = practiceIcon(card.title);
        const local = card.variants.filter(variant => variant.bundle.practice.regionId !== 'federal');
        const covered = new Set(local.map(variant => variant.bundle.practice.regionId)).size;
        const titleId = `practice-vote-${card.family?.id ?? card.variants[0].id}`;
        return <article className="workshop-note live-vote-card" key={card.key} data-view={view}
          aria-labelledby={titleId} data-note-tone={noteTone(card.family?.id ?? card.variants[0].id)} data-card-key={card.key} data-selected={selecting && selected.has(card.key) || undefined}>
          {view === 'ranking' && positions.has(card.key) ? <span className="live-vote-position" aria-label={`Место ${positions.get(card.key)}`}>{positions.get(card.key)}</span> : null}
          {selecting && canGroup ? <label className="live-vote-select">
            <input type="checkbox" aria-label={`Выбрать: ${card.title}`} checked={selected.has(card.key)} disabled={busy} onChange={() => choose(card.key)} />
          </label> : null}
          <header className="live-vote-card-main"><Icon size={25} aria-hidden="true" /><h3 id={titleId}>{card.title}</h3></header>
          <span className="live-vote-territories"><MapPin size={13} aria-hidden="true" />{covered ? territoryCount(covered) : 'Федеральная мера'}</span>
          {card.mechanism && card.mechanism !== card.title ? <p className="live-vote-mechanism">{card.mechanism}</p> : null}
          {familyVote ? <div className="live-vote-controls" role="group" aria-label={`Оценить: ${card.title}`}>
            <button className="live-vote-button positive" aria-pressed={familyVote.myVote === 1} disabled={disabled}
              onClick={() => void votes.vote(familyVote, familyVote.myVote === 1 ? null : 1)} aria-label={`Поддержать: ${card.title}`}><ThumbsUp size={17} aria-hidden="true" /><span>{familyVote.support}</span></button>
            <button className="live-vote-button negative" aria-pressed={familyVote.myVote === -1} disabled={disabled}
              onClick={() => void votes.vote(familyVote, familyVote.myVote === -1 ? null : -1)} aria-label={`Не поддержать: ${card.title}`}><ThumbsDown size={17} aria-hidden="true" /><span>{familyVote.oppose}</span></button>
            <span className="live-vote-score" aria-label={`Баланс голосов: ${familyVote.score}`}>{familyVote.score > 0 ? '+' : ''}{familyVote.score}</span>
            {familyVote.myVote !== null ? <button type="button" className="icon-button" disabled={disabled} aria-label={`Снять оценку: ${card.title}`} onClick={() => void votes.vote(familyVote, null)}><RotateCcw size={16} /></button> : null}
          </div> : null}
          {familyVote?.needsReview ? <p className="live-vote-review" role="status">Содержание изменилось. Оцените обновлённую практику.</p> : null}
          <RankedVariants variants={card.variants} regions={regions} onInspect={setInspecting} variantActions={variantActions} busy={busy}
            onEditGroup={canGroup && card.family ? () => openGroup([card], 'edit', card.family!) : undefined}
            onSeparate={canGroup && card.family && card.family.submissionIds.length > 1 ? separate : undefined} />
        </article>;
      })}
    </div>
    {withdrawn.length ? <details className="live-vote-withdrawn"><summary>Снятые карточки · {withdrawn.length}</summary>
      {withdrawn.map(variant => <article key={variant.id} className="live-vote-withdrawn-card">
        <h3>{variant.bundle.practice.title}</h3><p>{regionName(regions, variant.bundle.practice.regionId)}</p>
        <p>{variant.bundle.practice.mechanism}</p>
        <div className="live-vote-source-actions"><button type="button" className="button button-quiet" onClick={() => setInspecting(variant)}>Подробности варианта</button>
          <VariantActions controls={variantActions?.(variant)} busy={busy} />
        </div>
      </article>)}
    </details> : null}
    {draft ? <PracticeGroupDialog draft={draft} busy={busy} stale={stale} unavailable={unavailable || !canGroup} error={groupTask.error}
      onChange={patch => setDraft(current => current ? { ...current, ...patch } : null)}
      onClose={() => { setDraft(null); groupTask.clearError(); }} onSave={() => void saveGroup()} onRefresh={refreshDraft} /> : null}
    {inspecting ? <PracticeDetails variant={inspecting} regions={regions} onClose={() => setInspecting(null)}
      onOpenSource={anchor => { setInspecting(null); onOpenSource(anchor); }} /> : null}
  </section>;
}

export function LivePracticeRanking({ api, sessionId, userId }: {
  api: SessionApi | null; sessionId: string | null; userId: string | null;
}) {
  const votes = useLivePracticeVotes({ api, sessionId, userId, projector: true });
  const families = [...(votes.data?.families ?? [])].sort((a, b) => b.score - a.score || b.support - a.support || a.title.localeCompare(b.title, 'ru'));
  const maximum = Math.max(1, ...families.map(family => family.support + family.oppose));
  return <section className="live-ranking" aria-label="Рейтинг общей мастерской">
    {votes.error ? <p role="alert">{votes.error}</p> : null}
    {!families.length ? <div className="workshop-empty"><h2>Выбираем практики для своих территорий</h2><p>{votes.loading ? 'Получаем оценки…' : 'Группы практик и оценки участников появятся здесь.'}</p></div> : <>
      <div className="live-ranking-legend"><span><ThumbsUp size={18} />За</span><span><ThumbsDown size={18} />Против</span></div>
      {families.map((family, index) => <article className="live-ranking-row" key={family.familyId}>
        <span className="live-ranking-position">{index + 1}</span><div><h2>{family.title}</h2>
          <div className="live-ranking-bars" role="img" aria-label={`За: ${family.support}, против: ${family.oppose}, без оценки: ${family.unanswered}`}>
            <span className="positive" style={{ width: `${family.support / maximum * 100}%` }} />
            <span className="negative" style={{ width: `${family.oppose / maximum * 100}%` }} />
          </div><p>{family.support} за · {family.oppose} против · {family.unanswered} без оценки</p>
        </div><strong className="live-ranking-score">{family.score > 0 ? '+' : ''}{family.score}</strong>
      </article>)}
    </>}
  </section>;
}
