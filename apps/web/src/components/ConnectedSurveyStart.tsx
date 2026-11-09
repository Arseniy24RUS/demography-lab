import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, ExternalLink, MessageSquareText, RefreshCw } from 'lucide-react';
import type { WorkshopSurveyEntry } from '../../../../packages/barriers/types';
import type { SessionSummary } from '../../../../packages/collaboration/types';
import type { SessionApi } from '../lib/session-api';
import { BarriersApi } from '../lib/barriers-api';
import { surveyLink } from '../lib/survey-deployment';
import '../barriers.css';

/** Only shared launch metadata is read here. Answers use the independent anonymous page. */
export function ConnectedSurveyStart({ api, session, userId, onContinue, children }: {
  api: SessionApi | null;
  session: SessionSummary;
  userId: string;
  onContinue(): void;
  children?: ReactNode;
}) {
  const [entry, setEntry] = useState<WorkshopSurveyEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true, pending = false;
    setEntry(null);
    setError(null);
    if (!api) return;
    const client = new BarriersApi(api);
    async function refresh() {
      if (!active || pending || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const result = await client.workshopSurvey(session.id);
        if (active) { setEntry(result); setError(null); }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить опрос.');
      } finally { pending = false; }
    }
    void refresh();
    // Survey submissions have no identity events or precise per-answer activity feed.
    const timer = setInterval(() => void refresh(), 30000);
    const focus = () => void refresh();
    window.addEventListener('online', focus);
    document.addEventListener('visibilitychange', focus);
    return () => { active = false; clearInterval(timer); window.removeEventListener('online', focus); document.removeEventListener('visibilitychange', focus); };
  }, [api, session.id, userId, attempt]);
  const survey = entry?.survey;
  const url = api?.config.survey && entry?.invitationToken && survey?.canRespond
    ? surveyLink(api.config.survey, survey.id, entry.invitationToken) : null;
  const configurationError = !api?.config.survey
    ? api?.config.surveyError ?? 'Не удалось подключить форму опроса.' : null;
  return (
    <section className="workshop-survey-start" aria-labelledby="workshop-survey-title">
      <header className="workshop-survey-heading">
        <span className="workshop-survey-symbol" aria-hidden="true"><MessageSquareText size={30} /></span>
        <div><span className="barrier-eyebrow">Начнём с опыта участников</span>
          <h2 id="workshop-survey-title">Что мешает родительству?</h2>
          <p>Два открытых вопроса перед общим обсуждением.</p>
        </div>
      </header>
      <div className="workshop-survey-prompts">
        <article><span aria-hidden="true">01</span><h3>Что мешает?</h3>
          <p>{survey?.questions.q01 ?? 'Что сейчас мешает Вам или Вашим совершеннолетним детям решиться на рождение ещё одного ребёнка в ближайшие 12 месяцев?'}</p></article>
        <article><span aria-hidden="true">02</span><h3>Что помогло бы?</h3>
          <p>{survey?.questions.q02 ?? 'Что должно измениться прямо сейчас, чтобы вероятность рождения ребёнка в ближайшие 12 месяцев стала выше?'}</p></article>
      </div>
      <p className="workshop-survey-caption">Ответы не подписываются ФИО. Можно описать профессиональный опыт или пропустить опрос.</p>
      {survey && !survey.canRespond ? <p className="workshop-survey-caption" role="status">
        Приём ответов завершён. {survey.expired ? 'Срок хранения закончился' : 'Ответы хранятся до'}{' '}
        <time dateTime={survey.retentionUntil}>{survey.retentionUntil.split('-').reverse().join('.')}</time>.
      </p> : null}
      {(error || configurationError) ? <div className="barrier-feedback error" role="alert">
        <p>{error || configurationError}</p>
        <button className="button button-secondary" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} />Повторить</button>
      </div> : null}
      <div className="workshop-survey-actions">
        {url ? <a className="button button-primary" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
          <ExternalLink size={18} />Ответить анонимно
        </a> : !error && !configurationError && !entry ? <span role="status">Подготовка опроса…</span> : null}
        <button className="button button-secondary" onClick={onContinue}>К барьерам<ArrowRight size={18} /></button>
        {survey?.responseCount != null ? <span className="workshop-survey-count" role="status">Ответов: {survey.responseCount}</span> : null}
      </div>
      {session.role === 'host' && children ? <details className="workshop-survey-analysis"><summary>Ответы и обобщения</summary>{children}</details> : null}
    </section>
  );
}
