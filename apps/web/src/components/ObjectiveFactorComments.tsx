import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { FormEvent, Ref } from 'react';
import { MAX_OBJECTIVE_COMMENT_LENGTH } from '../../../../packages/flipchart/schema';
import type { ObjectiveComments } from '../../../../packages/flipchart/schema';
import type { FlipchartApi } from '../lib/flipchart-api';
import { SessionApiError } from '../lib/session-api';

export type ObjectiveCommentEditor = { saveDraft(): Promise<boolean> };

export function ObjectiveFactorComments({ client, sessionId, territoryKey, factorKey, editable, ref }: {
  client: FlipchartApi;
  sessionId: string;
  territoryKey: string;
  factorKey: string;
  editable: boolean;
  ref?: Ref<ObjectiveCommentEditor>;
}) {
  const [discussion, setDiscussion] = useState<ObjectiveComments | null>(null);
  const [draft, setDraft] = useState<{ text: string; revision: number } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const write = useRef({ mounted: false, pending: false, generation: 0 });
  const pendingSave = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    const state = write.current;
    let current = true;
    let reading = false;
    state.mounted = true;
    async function refresh() {
      if (reading || state.pending) return;
      reading = true;
      const generation = state.generation;
      try {
        const result = await client.comments(sessionId, { territoryKey, factorKey });
        if (current && state.generation === generation) {
          setDiscussion(result);
          setReadError(null);
        }
      } catch (cause) {
        if (current && state.generation === generation) {
          if (cause instanceof SessionApiError && ['AUTH_REQUIRED', 'FORBIDDEN'].includes(cause.code))
            setDiscussion(null);
          setReadError(cause instanceof Error ? cause.message : 'Не удалось загрузить комментарии.');
        }
      } finally {
        reading = false;
      }
    }
    const resume = () => { if (document.visibilityState === 'visible') void refresh(); };
    const interval = window.setInterval(resume, client.transport.config.pollInterval);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    void refresh();
    return () => {
      current = false;
      state.mounted = false;
      window.clearInterval(interval);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [client, sessionId, territoryKey, factorKey]);

  const mine = discussion?.comments.find(comment => comment.mine);
  const text = draft?.text ?? mine?.text ?? '';

  function save(value: string | null): Promise<boolean> {
    if (pendingSave.current) return pendingSave.current;
    const state = write.current;
    if (!discussion || !editable) return Promise.resolve(false);
    const selection = { territoryKey, factorKey };
    state.pending = true;
    const generation = ++state.generation;
    const current = () => state.mounted && state.generation === generation;
    setSaving(true);
    setError(null);
    const operation = (async () => {
      try {
        const result = await client.saveComment(sessionId, selection, draft?.revision ?? discussion.myRevision, value);
        if (current()) {
          setDiscussion(result);
          setDraft(null);
        }
        return true;
      } catch (cause) {
        if (!current()) return false;
        if (cause instanceof SessionApiError && cause.code === 'REVISION_CONFLICT') {
          setError('Ваш комментарий изменился в другой вкладке. Сверьте текст и повторите действие.');
          const latest = await client.comments(sessionId, selection).catch(() => null);
          if (latest && current()) {
            setDiscussion(latest);
            setDraft(previous => previous && { ...previous, revision: latest.myRevision });
          }
        } else {
          setError(cause instanceof Error ? cause.message : 'Не удалось сохранить комментарий.');
        }
        return false;
      } finally {
        state.pending = false;
        if (current()) setSaving(false);
      }
    })();
    pendingSave.current = operation;
    void operation.finally(() => { if (pendingSave.current === operation) pendingSave.current = null; });
    return operation;
  }

  useImperativeHandle(ref, () => ({
    saveDraft() {
      if (pendingSave.current) return pendingSave.current;
      const value = draft?.text.trim().normalize('NFC');
      return value && value !== mine?.text ? save(value) : Promise.resolve(true);
    },
  }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim().normalize('NFC');
    if (value && value !== mine?.text) void save(value);
  }

  return <section className="objective-discussion" aria-label="Обсуждение связи">
    {error || readError ? <p role="alert">{error ?? readError}</p> : null}
    {!discussion && !readError ? <p role="status">Загружаем комментарии…</p> : null}
    {discussion?.comments.length ? <ul className="objective-comments">
      {discussion.comments.map(comment => <li key={comment.id}>
        {comment.mine ? <small>Ваш комментарий</small> : null}
        <p>{comment.text}</p>
      </li>)}
    </ul> : null}
    {editable && discussion ? <form className="objective-comment-form" onSubmit={submit}>
      <label>
        Как вы объясняете эту связь?
        <textarea rows={3} value={text} maxLength={MAX_OBJECTIVE_COMMENT_LENGTH} disabled={saving}
          onChange={event => setDraft({ text: event.target.value, revision: draft?.revision ?? discussion.myRevision })} />
      </label>
      <div className="objective-actions">
        <button className="button button-secondary" type="submit"
          disabled={saving || !text.trim() || text.trim().normalize('NFC') === mine?.text}>Сохранить комментарий</button>
        {mine ? <button className="button button-secondary" type="button" disabled={saving}
          onClick={() => void save(null)}>Удалить комментарий</button> : null}
      </div>
    </form> : null}
  </section>;
}
