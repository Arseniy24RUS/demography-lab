import { useState } from 'react';
import { ThumbsDown, ThumbsUp, RotateCcw, ArrowUpDown, FileText } from 'lucide-react';
import type { TextAnchor } from '@domain/index';
import type { SessionAreaState } from '../../../../../packages/collaboration/types';
import type { WorkspaceVoteFamily } from '../../../../../packages/workshop/live-votes';
import type { SessionApi } from '../../lib/session-api';
import type { useWorkshop } from '../../hooks/useWorkshop';
import type { CorpusManifest } from '../../lib/corpus';
import { useLivePracticeVotes } from '../../hooks/useLivePracticeVotes';
import '../../live-votes.css';

export function LivePracticeVoting({ state, api, workshop, onOpenSource, manifest }: {
  state: SessionAreaState; api: SessionApi | null; workshop: ReturnType<typeof useWorkshop>;
  onOpenSource: (anchor: TextAnchor) => void; manifest: CorpusManifest;
}) {
  const votes = useLivePracticeVotes({ api, sessionId: state.snapshot?.session.id ?? null, userId: state.auth.userId });
  const [sort, setSort] = useState<'score' | 'title'>('score');
  const families = [...(votes.data?.families ?? [])].sort((a, b) => sort === 'score'
    ? b.score - a.score || b.support - a.support || a.title.localeCompare(b.title, 'ru')
    : a.title.localeCompare(b.title, 'ru'));
  const names = new Map(manifest.documents.map(entry => [entry.regionId, entry.territory]));
  return <section className="live-votes" aria-label="Рейтинг практик">
    <header className="live-votes-heading">
      <div><h2>Какие практики стоит применить?</h2><p>Оцените предложенные группой решения.</p></div>
      <label><ArrowUpDown size={16} aria-hidden="true" /><span className="session-sr-only">Порядок практик</span>
        <select value={sort} onChange={event => setSort(event.target.value as 'score' | 'title')}>
          <option value="score">По оценке группы</option><option value="title">По названию</option>
        </select>
      </label>
    </header>
    {votes.error ? <div className="session-message" data-tone="error" role="alert"><p>{votes.error}</p>
      <button className="button button-quiet" onClick={() => void votes.refresh()}>Обновить</button></div> : null}
    {!votes.data && votes.loading ? <p role="status">Получаем оценки…</p> : null}
    {votes.data && !families.length ? <div className="workshop-empty"><h3>Практики появятся после группировки</h3>
      <p>В разделе «Группировка» объедините похожие карточки или создайте группу для отдельной практики.</p></div> : null}
    <div className="live-vote-list">
      {families.map((item, index) => {
        const family = item as WorkspaceVoteFamily;
        const content = workshop.snapshot?.families.find(value => value.id === family.familyId);
        const variants = state.snapshot?.submissions.filter(value => value.status === 'shared' && content?.submissionIds.includes(value.id)) ?? [];
        const disabled = votes.pendingFamilyId !== null;
        return <article className="live-vote-card" key={family.familyId} aria-labelledby={`practice-vote-${family.familyId}`}>
          <div className="live-vote-card-main"><span className="live-vote-position" aria-label={`Место ${index + 1}`}>{index + 1}</span>
            <div><h3 id={`practice-vote-${family.familyId}`}>{family.title}</h3>{content?.mechanism ? <p>{content.mechanism}</p> : null}
              <span className="live-vote-variant-count">{variants.length} региональных вариантов</span>
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
          {variants.length ? <details className="live-vote-sources"><summary>Региональные варианты и документы</summary>
            {variants.map(variant => <div className="live-vote-source" key={variant.id}>
              <h4>{names.get(variant.bundle.practice.regionId) ?? variant.bundle.practice.regionId}</h4>
              <p>{variant.bundle.practice.title}</p>
              {variant.bundle.occurrences.map(occurrence => <button className="button button-quiet" key={occurrence.id}
                onClick={() => onOpenSource(occurrence.anchor)}><FileText size={16} />Открыть фрагмент документа</button>)}
            </div>)}
          </details> : null}
        </article>;
      })}
    </div>
    {families.length ? <p className="live-vote-method">Баланс — число «за» минус число «против». Участников мастерской: {votes.data?.participantCount}. Оценка группы отражает предпочтения участников.</p> : null}
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
