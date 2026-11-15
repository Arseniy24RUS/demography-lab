import { useMemo, useState } from 'react';
import { ThumbsDown, ThumbsUp, RotateCcw, ArrowUpDown, FileText } from 'lucide-react';
import type { TextAnchor } from '@domain/index';
import type { SessionAreaState, SharedSubmission } from '../../../../../packages/collaboration/types';
import type { WorkspaceVotesSnapshot } from '../../../../../packages/workshop/live-votes';
import type { SessionApi } from '../../lib/session-api';
import type { useWorkshop } from '../../hooks/useWorkshop';
import type { CorpusManifest } from '../../lib/corpus';
import { useLivePracticeVotes } from '../../hooks/useLivePracticeVotes';
import { PracticeDetails } from './PracticeDetails';
import { regionName, type WorkshopRegionOption } from './workshop-ui';
import '../../live-votes.css';

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

  return <section className="live-votes" aria-label="Рейтинг практик">
    <header className="live-votes-heading">
      <div><h2>Какие практики стоит применить?</h2><p>Оцените меру целиком и при необходимости сравните её варианты.</p></div>
      <label><ArrowUpDown size={16} aria-hidden="true" /><span className="session-sr-only">Порядок практик</span>
        <select value={sort} onChange={event => setSort(event.target.value as 'score' | 'title')}>
          <option value="score">По оценке группы</option><option value="title">По названию</option>
        </select>
      </label>
    </header>
    {votes.error ? <div className="session-message" data-tone="error" role="alert"><p>{votes.error}</p>
      <button className="button button-quiet" onClick={() => void votes.refresh()}>Обновить</button></div> : null}
    {!votes.data && votes.loading ? <p role="status">Получаем оценки…</p> : null}
    {votes.data && !families.length ? <div className="workshop-empty"><h3>Практики ещё не отобраны</h3>
      <p>Выберите меры в каталоге. Свою карточку можно добавить в рейтинг через «Группировку».</p></div> : null}
    <div className="live-vote-list">
      {families.map((family, index) => {
        const content = groups.get(family.familyId);
        const variants = content?.submissionIds.map(id => submissions.get(id))
          .filter((value): value is SharedSubmission => value !== undefined) ?? [];
        const disabled = votes.pendingFamilyId !== null;
        return <article className="live-vote-card" key={family.familyId} aria-labelledby={`practice-vote-${family.familyId}`}>
          <div className="live-vote-card-main"><span className="live-vote-position" aria-label={`Место ${index + 1}`}>{index + 1}</span>
            <div><h3 id={`practice-vote-${family.familyId}`}>{family.title}</h3>
              {content?.mechanism && content.mechanism !== family.title ? <p>{content.mechanism}</p> : null}
            </div>
          </div>
          <div className="live-vote-controls" role="group" aria-label={`Оценить: ${family.title}`}>
            <button className="live-vote-button positive" aria-pressed={family.myVote === 1} disabled={disabled}
              onClick={() => void votes.vote(family, family.myVote === 1 ? null : 1)} aria-label={`Поддержать: ${family.title}`}>
              <ThumbsUp size={20} aria-hidden="true" /><span>{family.support}</span>
            </button>
            <button className="live-vote-button negative" aria-pressed={family.myVote === -1} disabled={disabled}
              onClick={() => void votes.vote(family, family.myVote === -1 ? null : -1)} aria-label={`Не поддержать: ${family.title}`}>
              <ThumbsDown size={20} aria-hidden="true" /><span>{family.oppose}</span>
            </button>
            <span className="live-vote-score" aria-label={`Баланс голосов: ${family.score}`}>{family.score > 0 ? '+' : ''}{family.score}</span>
            {family.myVote !== null ? <button className="icon-button" disabled={disabled} aria-label={`Снять оценку: ${family.title}`} onClick={() => void votes.vote(family, null)}><RotateCcw size={16} /></button> : null}
          </div>
          {family.needsReview ? <p className="live-vote-review" role="status">Содержание изменилось. Оцените обновлённую практику.</p> : null}
          {variants.length ? <RankedVariants variants={variants} regions={regions} onInspect={setInspecting} /> : null}
        </article>;
      })}
    </div>
    {families.length ? <p className="live-vote-method">Баланс — число «за» минус число «против». Участников мастерской: {votes.data?.participantCount}. Оценка группы отражает предпочтения участников.</p> : null}
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
