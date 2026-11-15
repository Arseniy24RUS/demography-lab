import { useMemo, useState } from 'react';
import {
  ArrowUpDown, Banknote, BriefcaseBusiness, FileText, HeartPulse, House, Lightbulb, MapPin,
  RotateCcw, School, Search, ThumbsDown, ThumbsUp, UsersRound,
} from 'lucide-react';
import type { TextAnchor } from '@domain/index';
import type { SessionAreaState, SharedSubmission } from '../../../../../packages/collaboration/types';
import type { WorkspaceVotesSnapshot } from '../../../../../packages/workshop/live-votes';
import type { SessionApi } from '../../lib/session-api';
import type { useWorkshop } from '../../hooks/useWorkshop';
import type { CorpusManifest } from '../../lib/corpus';
import { useLivePracticeVotes } from '../../hooks/useLivePracticeVotes';
import { noteTone } from '../../lib/workshop-note';
import { PracticeDetails } from './PracticeDetails';
import { regionName, type WorkshopRegionOption } from './workshop-ui';
import '../../live-votes.css';
import '../../workshop-notes.css';

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

function RankedVariants({ variants, regions, onInspect }: {
  variants: SharedSubmission[];
  regions: WorkshopRegionOption[];
  onInspect: (variant: SharedSubmission) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <details className="live-vote-sources" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Варианты мер · {variants.length}</summary>
      {open ? variants.map((variant) => (
        <div className="live-vote-source" key={variant.id}>
          <h4>{regionName(regions, variant.bundle.practice.regionId)}</h4>
          <p>{variant.bundle.practice.title}</p>
          {variant.bundle.practice.amount ? <p>{variant.bundle.practice.amount}</p> : null}
          <button className="button button-quiet" onClick={() => onInspect(variant)}>
            <FileText size={16} aria-hidden="true" /> Подробности варианта
          </button>
        </div>
      )) : null}
    </details>
  );
}

export function LivePracticeVoting({ state, api, workshop, onOpenSource, manifest }: {
  state: SessionAreaState; api: SessionApi | null; workshop: ReturnType<typeof useWorkshop>;
  onOpenSource: (anchor: TextAnchor) => void; manifest: CorpusManifest;
}) {
  const votes = useLivePracticeVotes({ api, sessionId: state.snapshot?.session.id ?? null, userId: state.auth.userId });
  const [sort, setSort] = useState<'score' | 'title'>('score');
  const [query, setQuery] = useState('');
  const [inspecting, setInspecting] = useState<SharedSubmission | null>(null);
  const votedFamilies = (votes.data as WorkspaceVotesSnapshot | null)?.families;
  const families = useMemo(() => [...(votedFamilies ?? [])].sort((a, b) => sort === 'score'
    ? b.score - a.score || b.support - a.support || a.title.localeCompare(b.title, 'ru')
    : a.title.localeCompare(b.title, 'ru')), [sort, votedFamilies]);
  const regions = useMemo(() => manifest.documents.map(entry => ({
    id: entry.regionId, name: entry.territory, hasDocument: Boolean(entry.textUrl),
  })), [manifest]);
  const entries = state.snapshot?.submissions;
  const submissions = useMemo(() => new Map(
    entries?.filter(entry => entry.status === 'shared').map(entry => [entry.id, entry])
  ), [entries]);
  const groupedFamilies = workshop.snapshot?.families;
  const groups = useMemo(() => new Map(groupedFamilies?.map(family => [family.id, family])), [groupedFamilies]);
  const needle = query.trim().toLocaleLowerCase('ru');
  const visible = needle ? families.filter(family => {
    const content = groups.get(family.familyId);
    return [family.title, content?.mechanism, ...(content?.submissionIds.map(id => submissions.get(id)?.bundle.practice.title) ?? [])]
      .some(text => text?.toLocaleLowerCase('ru').includes(needle));
  }) : families;

  return <section className="live-votes" aria-label="Рейтинг практик">
    <header className="live-votes-heading">
      <div><h2>Практики</h2><p>Выберите меры, которые стоит обсуждать.</p></div>
      <div className="live-votes-tools">
        <label className="live-votes-order"><ArrowUpDown size={16} aria-hidden="true" />
          <span className="session-sr-only">Порядок практик</span>
          <select value={sort} onChange={event => setSort(event.target.value as 'score' | 'title')}>
            <option value="score">По оценке группы</option><option value="title">По названию</option>
          </select>
        </label>
        <label className="workshop-note-search"><Search size={16} aria-hidden="true" />
          <input type="search" aria-label="Найти меру" placeholder="Найти меру" value={query}
            onChange={event => setQuery(event.target.value)} />
        </label>
      </div>
    </header>
    {votes.error ? <div className="session-message" data-tone="error" role="alert"><p>{votes.error}</p>
      <button className="button button-quiet" onClick={() => void votes.refresh()}>Обновить</button></div> : null}
    {!votes.data && votes.loading ? <p role="status">Получаем оценки…</p> : null}
    {votes.data && !families.length ? <div className="workshop-empty"><h3>Практики ещё не отобраны</h3>
      <p>Выберите меры во вкладке «Программы» или добавьте свою публикацию через «Опубликованные карточки».</p></div> : null}
    {families.length && !visible.length ? <p className="live-vote-query-empty">По этому запросу мер нет.</p> : null}
    <div className="live-vote-list">
      {visible.map(family => {
        const content = groups.get(family.familyId);
        const variants = content?.submissionIds.map(id => submissions.get(id))
          .filter((value): value is SharedSubmission => value !== undefined) ?? [];
        const disabled = votes.pendingFamilyId !== null;
        const Icon = practiceIcon(family.title);
        const localVariants = variants.filter(item => item.bundle.practice.regionId !== 'federal');
        const covered = new Set(localVariants.map(item => item.bundle.practice.regionId)).size;
        return <article className="workshop-note live-vote-card" key={family.familyId}
          aria-labelledby={`practice-vote-${family.familyId}`} data-note-tone={noteTone(family.familyId)}>
          <header className="live-vote-card-main"><Icon size={25} aria-hidden="true" />
            <h3 id={`practice-vote-${family.familyId}`}>{family.title}</h3>
          </header>
          {covered || variants.length ? <span className="live-vote-territories"><MapPin size={13} aria-hidden="true" />
            {covered ? territoryCount(covered) : 'Федеральная мера'}
          </span> : null}
          {content?.mechanism && content.mechanism !== family.title ? <p className="live-vote-mechanism">{content.mechanism}</p> : null}
          <div className="live-vote-controls" role="group" aria-label={`Оценить: ${family.title}`}>
            <button className="live-vote-button positive" aria-pressed={family.myVote === 1} disabled={disabled}
              onClick={() => void votes.vote(family, family.myVote === 1 ? null : 1)} aria-label={`Поддержать: ${family.title}`}>
              <ThumbsUp size={17} aria-hidden="true" /><span>{family.support}</span>
            </button>
            <button className="live-vote-button negative" aria-pressed={family.myVote === -1} disabled={disabled}
              onClick={() => void votes.vote(family, family.myVote === -1 ? null : -1)} aria-label={`Не поддержать: ${family.title}`}>
              <ThumbsDown size={17} aria-hidden="true" /><span>{family.oppose}</span>
            </button>
            <span className="live-vote-score" aria-label={`Баланс голосов: ${family.score}`}>{family.score > 0 ? '+' : ''}{family.score}</span>
            {family.myVote !== null ? <button className="icon-button" disabled={disabled} aria-label={`Снять оценку: ${family.title}`} onClick={() => void votes.vote(family, null)}><RotateCcw size={16} /></button> : null}
          </div>
          {family.needsReview ? <p className="live-vote-review" role="status">Содержание изменилось. Оцените обновлённую практику.</p> : null}
          {variants.length ? <RankedVariants variants={variants} regions={regions} onInspect={setInspecting} /> : null}
        </article>;
      })}
    </div>
    {inspecting ? (
      <PracticeDetails variant={inspecting} regions={regions} onClose={() => setInspecting(null)}
        onOpenSource={(anchor) => {
          setInspecting(null);
          onOpenSource(anchor);
        }} />
    ) : null}
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
