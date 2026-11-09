import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkshopProjection, WorkshopSnapshot } from '../../../../packages/workshop/types';
import type { WorkshopActions } from '../components/workshop/workshop-ui';
import type { SessionApi } from '../lib/session-api';
import type { WorkshopApi } from '../lib/workshop-api';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : 'Не удалось обновить коллективную работу.';
const forbidden = (cause: unknown) => cause instanceof Error && 'code' in cause && ['FORBIDDEN', 'NOT_FOUND', 'AUTH_REQUIRED'].includes(String(cause.code));

export function useWorkshop(options: { api: SessionApi | null; sessionId: string | null; userId: string | null; enabled: boolean; projector: boolean }) {
  const { api, sessionId, userId, enabled, projector } = options;
  // Material caches never cross authenticated identities.
  const [ready, setReady] = useState<{ api: SessionApi; userId: string; client: WorkshopApi } | null>(null);
  const client = ready?.api === api && ready?.userId === userId ? ready.client : null;
  const [snapshot, setSnapshot] = useState<WorkshopSnapshot | null>(null);
  const [projection, setProjection] = useState<WorkshopProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    if (!api || !userId) { setReady(null); return; }
    void import('../lib/workshop-api').then(({ WorkshopApi }) => {
      if (active) setReady({ api, userId, client: new WorkshopApi(api) });
    }).catch((cause: unknown) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [api, userId]);
  const known = useRef(-1);
  const identity = `${sessionId ?? ''}:${userId ?? ''}:${projector}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const mutationLock = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const apply = useCallback((result: WorkshopSnapshot, expectedIdentity: string) => {
    if (identityRef.current !== expectedIdentity || result.cursor < known.current) return;
    known.current = result.cursor;
    setSnapshot(result);
  }, []);
  useEffect(() => {
    known.current = -1;
    setSnapshot(null); setProjection(null); setError(null); setBusy(false); mutationLock.current = false;
  }, [identity]);
  useEffect(() => {
    if (!client || !api || !sessionId || !userId || !enabled) {
      refreshRef.current = async () => {};
      setLoading(false);
      return;
    }
    let active = true, live = false, again = false;
    let pending: Promise<void> | null = null;
    let schedule: ReturnType<typeof setTimeout> | undefined;
    let lastSync = 0;
    const capturedIdentity = identity;
    const sync = (): Promise<void> => {
      if (!active) return Promise.resolve();
      if (pending) { again = true; return pending; }
      if (!navigator.onLine) { setError('Связь прервана. На экране последние полученные данные.'); return Promise.resolve(); }
      pending = (async () => {
        try {
          if (known.current < 0 || await client.cursor(sessionId) !== known.current) {
            if (projector) {
              const result = await client.projection(sessionId);
              if (active && identityRef.current === capturedIdentity && result.cursor >= known.current) {
                known.current = result.cursor;
                setProjection(result);
              }
            } else {
              const result = await client.snapshot(sessionId);
              if (active) apply(result, capturedIdentity);
            }
          }
          if (active) { setError(null); lastSync = Date.now(); }
        } catch (cause) {
          if (active) {
            setError(errorText(cause));
            if (forbidden(cause)) { known.current = -1; setSnapshot(null); setProjection(null); }
          }
        } finally {
          pending = null;
          if (active) setLoading(false);
          if (active && again) { again = false; void sync(); }
        }
      })();
      return pending;
    };
    refreshRef.current = sync;
    setLoading(known.current < 0);
    const channel = api.config.realtime ? api.client.channel(`dw-workshop-${sessionId}-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dw_workshop_events', filter: `session_id=eq.${sessionId}` }, () => {
        if (!schedule) schedule = setTimeout(() => { schedule = undefined; void sync(); }, 150);
      }).subscribe((status) => { live = status === 'SUBSCRIBED'; if (live) void sync(); }) : null;
    void sync();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && (!live || Date.now() - lastSync > 30000)) void sync();
    }, api.config.pollInterval);
    const focus = () => { if (document.visibilityState === 'visible') void sync(); };
    window.addEventListener('online', focus); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => {
      active = false; clearInterval(timer); if (schedule) clearTimeout(schedule);
      window.removeEventListener('online', focus); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus);
      if (channel) void api.client.removeChannel(channel);
      refreshRef.current = async () => {};
    };
  }, [api, client, sessionId, userId, enabled, projector, identity, apply]);

  async function mutate(operation: (client: WorkshopApi, id: string) => Promise<WorkshopSnapshot>) {
    if (!client || !sessionId || !userId || projector) throw new Error('Откройте занятие в режиме участника.');
    if (mutationLock.current) throw new Error('Дождитесь сохранения предыдущего действия.');
    if (!navigator.onLine) throw new Error('Связь прервана. Дождитесь подключения перед отправкой.');
    const capturedIdentity = identity;
    mutationLock.current = true; setBusy(true); setError(null);
    try { apply(await operation(client, sessionId), capturedIdentity); }
    catch (cause) {
      if (identityRef.current === capturedIdentity) {
        setError(errorText(cause));
        if (forbidden(cause)) { known.current = -1; setSnapshot(null); setProjection(null); }
      }
      throw cause;
    } finally { if (identityRef.current === capturedIdentity) { mutationLock.current = false; setBusy(false); } }
  }
  const actions: WorkshopActions = {
    regionWork: (input) => mutate((c, id) => c.region(id, input)),
    saveFamily: (input) => mutate((c, id) => c.saveFamily(id, input)),
    deleteFamily: (familyId, revision) => mutate((c, id) => c.deleteFamily(id, familyId, revision)),
    openRound: (input) => mutate((c, id) => c.openRound(id, input)),
    closeRound: (roundId, revision) => mutate((c, id) => c.closeRound(id, roundId, revision)),
    castVote: (input) => mutate((c, id) => c.vote(id, input)),
    loadRound: async (roundId) => {
      if (!client || !sessionId || !userId) throw new Error('Сначала откройте занятие.');
      return client.round(sessionId, roundId);
    },
    refresh: () => refreshRef.current(),
  };
  return { snapshot, projection, actions, busy, loading, error };
}
