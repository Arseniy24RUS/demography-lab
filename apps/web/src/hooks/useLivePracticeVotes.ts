import { useEffect, useMemo, useRef, useState } from 'react';
import { randomUuid } from '../../../../packages/security/crypto.mjs';
import type { WorkspaceVoteFamily, WorkspaceVotesProjection, WorkspaceVotesSnapshot, WorkspaceVoteValue } from '../../../../packages/workshop/live-votes';
import type { SessionApi } from '../lib/session-api';
import { WorkshopApi } from '../lib/workshop-api';

type Votes = WorkspaceVotesSnapshot | WorkspaceVotesProjection;
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Не удалось обновить оценки.';

export function useLivePracticeVotes({ api, sessionId, userId, projector = false, enabled = true }: {
  api: SessionApi | null; sessionId: string | null; userId: string | null; projector?: boolean; enabled?: boolean;
}) {
  const client = useMemo(() => api && userId ? new WorkshopApi(api) : null, [api, userId]);
  const key = `${api?.config.url ?? ''}:${api?.config.offlineInstanceId ?? ''}:${sessionId ?? ''}:${userId ?? ''}:${projector}`;
  const current = useRef(key);
  current.current = key;
  const [saved, setSaved] = useState<{ key: string; value: Votes } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [pending, setPending] = useState<{ key: string; familyId: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const revision = useRef(-1);
  const mutation = useRef<string | null>(null);

  useEffect(() => {
    revision.current = -1;
    mutation.current = null;
    setPending(null);
    setSaved(null);
    setFailure(null);
    if (!api || !client || !sessionId || !userId || !enabled) { setLoading(false); return; }
    let active = true;
    let pendingRead: Promise<void> | null = null;
    let repeat = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = (value: Votes) => {
      if (!active || current.current !== key || value.sessionId !== sessionId || value.cursor < revision.current) return;
      revision.current = value.cursor;
      setSaved({ key, value });
    };
    const read = (): Promise<void> => {
      if (!active) return Promise.resolve();
      if (pendingRead) { repeat = true; return pendingRead; }
      pendingRead = (async () => {
        try {
          if (!api.config.offline && !navigator.onLine) throw new Error('Связь прервана. Оценки появятся после подключения.');
          if (revision.current < 0 || await client.cursor(sessionId) !== revision.current) {
            apply(projector ? await client.liveVotesProjection(sessionId) : await client.liveVotes(sessionId));
          }
          if (active && current.current === key) setFailure(null);
        } catch (cause) {
          if (active && current.current === key) setFailure({ key, message: message(cause) });
        } finally {
          pendingRead = null;
          if (active && current.current === key) setLoading(false);
          if (active && repeat) { repeat = false; void read(); }
        }
      })();
      return pendingRead;
    };
    refreshRef.current = read;
    setLoading(true);
    void read();
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void read(); }, api.config.pollInterval);
    const channel = api.config.realtime ? api.client.channel(`dw-live-votes-${sessionId}-${randomUuid()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dw_workshop_events', filter: `session_id=eq.${sessionId}` }, () => {
        if (!timer) timer = setTimeout(() => { timer = undefined; void read(); }, 120);
      }).subscribe() : null;
    const resume = () => { if (document.visibilityState === 'visible') void read(); };
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      active = false;
      clearInterval(interval);
      if (timer) clearTimeout(timer);
      if (channel) void api.client.removeChannel(channel);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
      refreshRef.current = async () => {};
    };
  }, [api, client, sessionId, userId, projector, enabled, key]);

  async function vote(family: WorkspaceVoteFamily, value: WorkspaceVoteValue) {
    if (!client || !sessionId || !userId || projector || mutation.current) return;
    const binding = key;
    mutation.current = binding;
    setPending({ key: binding, familyId: family.familyId });
    setFailure(null);
    try {
      const result = await client.voteLive(sessionId, { familyId: family.familyId, value,
        expectedRevision: family.myVoteRevision, expectedFingerprint: family.fingerprint });
      if (current.current !== binding) return;
      if (result.sessionId !== sessionId) throw new Error('Оценка относится к другой мастерской.');
      if (result.cursor >= revision.current) {
        revision.current = result.cursor;
        setSaved({ key: binding, value: result });
      }
    } catch (cause) {
      if (current.current === binding) {
        revision.current = -1;
        await refreshRef.current();
        if (current.current === binding) setFailure({ key: binding, message: message(cause) });
      }
    } finally {
      if (current.current === binding) { mutation.current = null; setPending(null); }
    }
  }
  return { data: saved?.key === key ? saved.value : null,
    error: failure?.key === key ? failure.message : null,
    pendingFamilyId: pending?.key === key ? pending.familyId : null,
    loading, vote, refresh: () => refreshRef.current() };
}
