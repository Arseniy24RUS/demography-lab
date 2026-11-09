import { useEffect, useMemo, useRef, useState } from 'react';
import { FlipchartReplica } from '../../../../packages/flipchart/replica';
import type {
  FlipchartKind, FlipchartMutationResult, FlipchartNote, FlipchartPublicNote, FlipchartVote,
} from '../../../../packages/flipchart/types';
import { FlipchartApi } from '../lib/flipchart-api';
import { SessionApiError, type SessionApi } from '../lib/session-api';

type Options = {
  api: SessionApi | null; sessionId: string | null; userId: string | null;
  projector?: boolean; enabled?: boolean;
};
type Runtime = {
  key: string; active: boolean; replica: FlipchartReplica<FlipchartPublicNote>;
  pending: Set<string>; adding: boolean; refresh(): Promise<void>;
};
type State<T> = {
  notes: readonly T[]; loading: boolean; error: string | null;
  pendingIds: ReadonlySet<string>; submitting: boolean; removed: FlipchartNote | null;
  add(kind: FlipchartKind, text: string): Promise<boolean>;
  vote(note: FlipchartNote, value: FlipchartVote): Promise<void>;
  withdraw(note: FlipchartNote): Promise<void>;
  restore(): Promise<void>; dismissUndo(): void; refresh(): Promise<void>;
};
const noPending: ReadonlySet<string> = new Set();
const failureMessage = (error: unknown) => error instanceof SessionApiError && error.code === 'REVISION_CONFLICT'
  ? 'Оценка уже изменилась в другом окне. Доска обновлена; повторите действие.'
  : error instanceof Error ? error.message : 'Не удалось обновить доску.';

export function useFlipchart(options: Options & { projector: true }): State<FlipchartPublicNote>;
export function useFlipchart(options: Options & { projector?: false }): State<FlipchartNote>;
export function useFlipchart({ api, sessionId, userId, projector = false, enabled = true }: Options): State<FlipchartPublicNote> {
  const client = useMemo(() => api && userId ? new FlipchartApi(api) : null, [api, userId]);
  const key = `${api?.config.url ?? ''}:${api?.config.offlineInstanceId ?? ''}:${sessionId ?? ''}:${userId ?? ''}:${projector}:${enabled}`;
  const current = useRef(key);
  current.current = key;
  const runtimeRef = useRef<Runtime | null>(null);
  const [saved, setSaved] = useState<{ key: string; notes: FlipchartPublicNote[] } | null>(null);
  const [failure, setFailure] = useState<{ key: string; kind: 'read' | 'write'; message: string } | null>(null);
  const [busy, setBusy] = useState<{ key: string; pending: Set<string>; adding: boolean } | null>(null);
  const [undo, setUndo] = useState<{ key: string; note: FlipchartNote } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  useEffect(() => {
    setSaved(null); setFailure(null); setBusy(null); setUndo(null);
    if (!api || !client || !sessionId || !userId || !enabled) { setLoadingKey(null); return; }
    const runtime: Runtime = {
      key, active: true, replica: new FlipchartReplica(), pending: new Set(), adding: false,
      refresh: async () => {},
    };
    runtimeRef.current = runtime;
    let pendingRead: Promise<void> | null = null;
    let repeat = false;
    const valid = () => runtime.active && current.current === key && runtimeRef.current === runtime;
    const read = (): Promise<void> => {
      if (!valid()) return Promise.resolve();
      if (pendingRead) { repeat = true; return pendingRead; }
      pendingRead = (async () => {
        try {
          const requestedCursor = runtime.replica.cursor;
          const result = projector
            ? await client.projection(sessionId, requestedCursor)
            : await client.updates(sessionId, requestedCursor);
          if (!valid()) return;
          // Restoring an older offline backup rebases the server cursor. A
          // reset in response to a higher requested cursor is authoritative;
          // an older initial snapshot racing a new acknowledgement is not.
          if (result.reset && requestedCursor !== null && result.cursor < requestedCursor)
            runtime.replica.reset();
          const initial = runtime.replica.cursor === null;
          runtime.replica.update(result);
          if (initial || result.reset || result.notes.length || result.removedIds.length)
            setSaved({ key, notes: runtime.replica.notes() });
          setFailure(previous => previous?.kind === 'write' ? previous : null);
        } catch (error) {
          if (!valid()) return;
          if (error instanceof SessionApiError && ['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code)) {
            runtime.replica.reset(); setSaved(null); setUndo(null);
          }
          setFailure(previous => previous?.kind === 'write' ? previous : { key, kind: 'read', message: failureMessage(error) });
        } finally {
          pendingRead = null;
          if (valid()) {
            setLoadingKey(null);
            if (repeat) { repeat = false; void read(); }
          }
        }
      })();
      return pendingRead;
    };
    runtime.refresh = read;
    setLoadingKey(key);
    void read();
    // Compact deltas work identically through Supabase and the offline LAN server.
    // No full-board download is needed when no sticker or vote has changed.
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void read(); }, api.config.pollInterval);
    const resume = () => { if (document.visibilityState === 'visible') void read(); };
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      runtime.active = false;
      clearInterval(interval);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [api, client, sessionId, userId, projector, enabled, key]);

  function boundRuntime(): Runtime | null {
    const runtime = runtimeRef.current;
    return runtime?.active && current.current === key && runtime.key === key && !projector ? runtime : null;
  }

  async function mutate(token: string, call: () => Promise<FlipchartMutationResult>): Promise<FlipchartMutationResult | null> {
    const runtime = boundRuntime();
    if (!runtime || !sessionId || !client || runtime.pending.has(token)) return null;
    runtime.pending.add(token);
    if (token === 'add') runtime.adding = true;
    const publishBusy = () => setBusy({ key, pending: new Set(runtime.pending), adding: runtime.adding });
    const valid = () => runtime.active && current.current === key && runtimeRef.current === runtime;
    publishBusy(); setFailure(null);
    try {
      const result = await call();
      if (!valid()) return null;
      runtime.replica.acknowledge(result);
      setSaved({ key, notes: runtime.replica.notes() });
      // The acknowledgement covers one note only; keep the read cursor intact.
      void runtime.refresh();
      return result;
    } catch (error) {
      if (valid()) {
        setFailure({ key, kind: 'write', message: failureMessage(error) });
        void runtime.refresh();
      }
      return null;
    } finally {
      runtime.pending.delete(token);
      if (token === 'add') runtime.adding = false;
      if (valid()) publishBusy();
    }
  }

  async function add(kind: FlipchartKind, text: string) {
    if (!client || !sessionId) return false;
    return Boolean(await mutate('add', () => client.add(sessionId, { kind, text })));
  }
  async function vote(note: FlipchartNote, value: FlipchartVote) {
    if (client && sessionId) await mutate(note.id, () => client.vote(sessionId, note, value));
  }
  async function withdraw(note: FlipchartNote) {
    if (!client || !sessionId) return;
    const result = await mutate(note.id, () => client.status(sessionId, note, 'withdrawn'));
    if (result && current.current === key) setUndo({ key, note: result.note });
  }
  async function restore() {
    const note = undo?.key === key ? undo.note : null;
    if (!client || !sessionId || !note) return;
    const result = await mutate(note.id, () => client.status(sessionId, note, 'active'));
    if (result && current.current === key) setUndo(null);
  }
  return {
    notes: saved?.key === key ? saved.notes : [],
    loading: loadingKey === key,
    error: failure?.key === key ? failure.message : null,
    pendingIds: busy?.key === key ? busy.pending : noPending,
    submitting: busy?.key === key ? busy.adding : false,
    removed: undo?.key === key ? undo.note : null,
    add, vote, withdraw, restore,
    dismissUndo: () => setUndo(null),
    refresh: () => runtimeRef.current?.key === key ? runtimeRef.current.refresh() : Promise.resolve(),
  };
}
