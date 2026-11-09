import { randomUuid } from '../../../../packages/security/crypto.mjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionApi } from '../lib/session-api';
import { RoadmapsApi } from '../lib/roadmaps-api';
import type {
  SaveStatisticsInput,
  RestoreStatisticsInput,
  GetStatisticsHistoryInput,
  GetStatisticsSeriesInput,
} from '../../../../packages/statistics/types';
import type {
  RoadmapSnapshot,
  RoadmapsIndex,
  RoadmapsProjection,
  ConfigureRoadmapsInput,
  JoinRoadmapInput,
  SaveRoadmapItemInput,
  CaptureRoadmapBasisInput,
  CaptureRoadmapFactInput,
  FreezeRoadmapInput,
  ReviewRoadmapInput,
} from '../../../../packages/roadmaps/types';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Не удалось обновить дорожную карту.';
const forbidden = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  ['FORBIDDEN', 'NOT_FOUND', 'AUTH_REQUIRED', 'EMAIL_NOT_VERIFIED'].includes(String(error.code));

/** Fetch the small index first, then only the selected room whose own revision changed. */
export function useRoadmaps({
  api,
  sessionId,
  userId,
  enabled = true,
  projector = false,
}: {
  api: SessionApi | null;
  sessionId: string | null;
  userId: string | null;
  enabled?: boolean;
  projector?: boolean;
}) {
  const [index, setIndex] = useState<RoadmapsIndex | null>(null);
  const [snapshot, setSnapshot] = useState<RoadmapSnapshot | null>(null);
  const [projection, setProjection] = useState<RoadmapsProjection | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useRef<{
    identity: string;
    index: RoadmapsIndex | null;
    snapshot: RoadmapSnapshot | null;
    cursor: number;
    selected: string | null;
  }>({ identity: '', index: null, snapshot: null, cursor: -1, selected: null });
  const identity = `${sessionId ?? ''}:${userId ?? ''}:${projector}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const mounted = useRef(false);
  const mutation = useRef<symbol | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const clientRef = useRef<{ transport: SessionApi; user: string; client: RoadmapsApi } | null>(
    null,
  );
  if (api && userId && (clientRef.current?.transport !== api || clientRef.current.user !== userId))
    clientRef.current = { transport: api, user: userId, client: new RoadmapsApi(api) };
  if (!api || !userId) clientRef.current = null;
  const client = clientRef.current?.client ?? null;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutation.current = null;
    };
  }, []);
  function isCurrent(token: string, expectedClient = client) {
    return (
      mounted.current &&
      currentIdentity.current === token &&
      clientRef.current?.client === expectedClient
    );
  }
  const apply = useCallback((value: RoadmapSnapshot, token: string) => {
    if (
      !mounted.current ||
      currentIdentity.current !== token ||
      value.roadmapId !== state.current.selected
    )
      return;
    if (
      state.current.snapshot?.roadmapId === value.roadmapId &&
      value.cursor < state.current.snapshot.cursor
    )
      return;
    state.current.snapshot = value;
    setSnapshot(value);
  }, []);
  useEffect(() => {
    state.current = { identity, index: null, snapshot: null, cursor: -1, selected: null };
    mutation.current = null;
    setIndex(null);
    setSnapshot(null);
    setProjection(null);
    setSelectedId(null);
    setError(null);
    setBusy(false);
  }, [identity, client]);
  const select = useCallback((id: string | null) => {
    if (state.current.selected === id) return;
    state.current.selected = id;
    state.current.snapshot = null;
    setSelectedId(id);
    setSnapshot(null);
    setProjection(null);
  }, []);
  useEffect(() => {
    if (!client || !api || !sessionId || !userId || !enabled) {
      setLoading(false);
      refreshRef.current = async () => {};
      return;
    }
    let active = true,
      live = false,
      pending: Promise<void> | null = null,
      repeat = false,
      force = true;
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSync = 0;
    const token = identity;
    function alive() {
      return active && currentIdentity.current === token;
    }
    function clearUnauthorized() {
      state.current.index = null;
      state.current.snapshot = null;
      state.current.cursor = -1;
      setIndex(null);
      setSnapshot(null);
      setProjection(null);
    }
    const sync = (): Promise<void> => {
      if (!alive()) return Promise.resolve();
      if (pending) {
        repeat = true;
        return pending;
      }
      if (!api?.config.offline && !navigator.onLine) {
        setError('Связь прервана. Показана последняя полученная редакция.');
        return Promise.resolve();
      }
      pending = (async () => {
        try {
          const cursor = state.current.cursor < 0 || force ? -1 : await client.cursor(sessionId);
          if (!alive()) return;
          if (
            force ||
            cursor !== state.current.cursor ||
            state.current.cursor < 0 ||
            (!projector && !state.current.snapshot && state.current.selected)
          ) {
            const forceDetail = force;
            force = false;
            if (projector) {
              const selected = state.current.selected;
              const next = await client.projection(sessionId, selected);
              if (
                alive() &&
                selected === state.current.selected &&
                next.cursor >= state.current.cursor
              ) {
                state.current.cursor = next.cursor;
                setProjection(next);
              }
            } else {
              const next = await client.index(sessionId);
              if (!alive() || next.cursor < state.current.cursor) return;
              state.current.index = next;
              state.current.cursor = next.cursor;
              setIndex(next);
              if (!state.current.selected && next.myRoadmapId) {
                state.current.selected = next.myRoadmapId;
                setSelectedId(next.myRoadmapId);
              }
              const selected = state.current.selected;
              const summary = next.rooms.find((room) => room.id === selected);
              if (selected && summary) {
                const previous = state.current.snapshot;
                if (
                  forceDetail ||
                  !previous ||
                  previous.roadmapId !== selected ||
                  previous.revision !== summary.revision ||
                  previous.sourceCursor !== next.sourceCursor
                ) {
                  const detail = await client.snapshot(sessionId, selected);
                  if (alive() && state.current.selected === selected) apply(detail, token);
                }
              } else if (selected) {
                state.current.snapshot = null;
                setSnapshot(null);
              }
            }
          }
          if (alive()) {
            setError(null);
            lastSync = Date.now();
          }
        } catch (cause) {
          force = true;
          if (alive()) {
            setError(message(cause));
            if (forbidden(cause)) clearUnauthorized();
          }
        } finally {
          pending = null;
          if (alive()) setLoading(false);
          if (alive() && repeat) {
            repeat = false;
            void sync();
          }
        }
      })();
      return pending;
    };
    refreshRef.current = () => {
      force = true;
      return sync();
    };
    setLoading((!state.current.index && !projector) || (projector && state.current.cursor < 0));
    const channel = api.config.realtime
      ? api.client
          .channel(`dw-roadmaps-${sessionId}-${randomUuid()}`)
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'dw_roadmap_events',
              filter: `session_id=eq.${sessionId}`,
            },
            () => {
              if (!eventTimer)
                eventTimer = setTimeout(() => {
                  eventTimer = undefined;
                  void sync();
                }, 150);
            },
          )
          .subscribe((status) => {
            live = status === 'SUBSCRIBED';
            if (live) void sync();
          })
      : null;
    void sync();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && (!live || Date.now() - lastSync > 30000))
        void sync();
    }, api.config.pollInterval);
    const onFocus = () => {
      if (document.visibilityState === 'visible') void sync();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      active = false;
      clearInterval(timer);
      if (eventTimer) clearTimeout(eventTimer);
      if (channel) void api.client.removeChannel(channel);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      refreshRef.current = async () => {};
    };
  }, [api, client, sessionId, userId, identity, enabled, projector, selectedId, apply]);
  async function run<T>(
    operation: (client: RoadmapsApi, sessionId: string) => Promise<T>,
  ): Promise<T> {
    if (!client || !sessionId || !userId || projector || !isCurrent(identity, client))
      throw new Error('Откройте дорожную карту в учебной сессии.');
    if (mutation.current) throw new Error('Дождитесь сохранения предыдущего действия.');
    if (!api?.config.offline && !navigator.onLine)
      throw new Error('Дождитесь восстановления связи. Ваш текст остаётся в форме.');
    const token = identity;
    const command = Symbol('roadmap-mutation');
    mutation.current = command;
    setBusy(true);
    setError(null);
    try {
      const result = await operation(client, sessionId);
      if (!isCurrent(token, client))
        throw new Error('Учётная запись, занятие или открытый модуль изменились.');
      return result;
    } catch (cause) {
      if (isCurrent(token, client)) {
        setError(message(cause));
        if (forbidden(cause)) {
          state.current.snapshot = null;
          state.current.index = null;
          setSnapshot(null);
          setIndex(null);
          setProjection(null);
        }
      }
      throw cause;
    } finally {
      if (mutation.current === command) {
        mutation.current = null;
        if (isCurrent(token, client)) setBusy(false);
      }
    }
  }
  async function write(
    operation: (client: RoadmapsApi, sessionId: string) => Promise<RoadmapSnapshot>,
  ) {
    const next = await run(operation);
    if (!isCurrent(identity, client))
      throw new Error('Учётная запись, занятие или открытый модуль изменились.');
    apply(next, identity);
    await refreshRef.current();
    if (!isCurrent(identity, client))
      throw new Error('Учётная запись, занятие или открытый модуль изменились.');
    return next;
  }
  const actions = {
    select,
    refresh: () => refreshRef.current(),
    clearError: () => setError(null),
    configure: async (input: ConfigureRoadmapsInput) => {
      const next = await run((c, id) => c.configure(id, input));
      if (!isCurrent(identity, client)) throw new Error('Открытый модуль изменился.');
      state.current.index = next;
      setIndex(next);
      await refreshRef.current();
    },
    join: async (input: JoinRoadmapInput) => {
      const next = await run((c, id) => c.join(id, input));
      if (!isCurrent(identity, client)) throw new Error('Открытый модуль изменился.');
      state.current.selected = next.roadmapId;
      setSelectedId(next.roadmapId);
      apply(next, identity);
      await refreshRef.current();
      return next;
    },
    saveItem: (input: SaveRoadmapItemInput) => write((c, id) => c.saveItem(id, input)),
    captureBasis: (input: CaptureRoadmapBasisInput) => write((c, id) => c.captureBasis(id, input)),
    captureFact: (input: CaptureRoadmapFactInput) => write((c, id) => c.captureFact(id, input)),
    saveStatistics: (input: SaveStatisticsInput) => write((c, id) => c.saveStatistics(id, input)),
    restoreStatistics: (input: RestoreStatisticsInput) =>
      write((c, id) => c.restoreStatistics(id, input)),
    statisticsHistory: async (input: GetStatisticsHistoryInput) => {
      if (
        !client ||
        !sessionId ||
        !userId ||
        projector ||
        !isCurrent(identity, client) ||
        state.current.selected !== input.roadmapId
      )
        throw new Error('Сначала откройте командную дорожную карту.');
      const token = identity;
      const next = await client.statisticsHistory(sessionId, input);
      if (!isCurrent(token, client) || state.current.selected !== input.roadmapId)
        throw new Error('Учётная запись, занятие или территория изменились.');
      return next;
    },
    statisticsSeries: async (input: GetStatisticsSeriesInput) => {
      if (
        !client ||
        !sessionId ||
        !userId ||
        projector ||
        !isCurrent(identity, client) ||
        state.current.selected !== input.roadmapId
      )
        throw new Error('Сначала откройте командную дорожную карту.');
      const token = identity;
      const next = await client.statisticsSeries(sessionId, input);
      if (!isCurrent(token, client) || state.current.selected !== input.roadmapId)
        throw new Error('Учётная запись, занятие или территория изменились.');
      return next;
    },
    freeze: (input: FreezeRoadmapInput) => write((c, id) => c.freeze(id, input)),
    review: (input: ReviewRoadmapInput) => write((c, id) => c.review(id, input)),
    readVersion: async (roadmapId: string, versionId: string) => {
      if (!client || !sessionId || !userId || !isCurrent(identity, client))
        throw new Error('Сначала откройте занятие.');
      const token = identity;
      const next = await client.version(sessionId, roadmapId, versionId);
      if (!isCurrent(token, client))
        throw new Error('Учётная запись, занятие или открытый модуль изменились.');
      return next;
    },
  };
  return { index, snapshot, projection, selectedId, loading, busy, error, actions };
}
export type RoadmapsController = ReturnType<typeof useRoadmaps>;
