import { randomUuid } from '../../../../packages/security/crypto.mjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkshopIdentitySession } from '../lib/declared-identity';
import type {
  ProjectionSession,
  SessionAreaActions,
  SessionAreaState,
  SessionSnapshot,
} from '../../../../packages/collaboration/types';
import type { TextAnchor } from '@domain/index';
import { loadCloudConfiguration } from '../lib/cloud-config';
import { isLoopbackHost } from '../lib/local-network';
import { localHost, offlineRequest, forgetLocalReceipt,
  type LocalServerStatus } from '../lib/offline-api';
import type { SessionApi } from '../lib/session-api';

let sharedApiPromise: Promise<SessionApi> | null = null;
const apiErrorCode = (e: unknown) =>
  e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : null;
const readJoin = () =>
  new URLSearchParams(location.search).get('join') ??
  new URLSearchParams(location.hash.slice(1)).get('join') ??
  '';
const initialState = (): SessionAreaState => ({
  configured: false,
  configurationError: null,
  testEnvironment: false,
  auth: { status: 'loading', email: null, userId: null },
  bootstrap: null,
  snapshot: null,
  invitation: null,
  connection: 'unconfigured',
  busy: null,
  error: null,
  notice: null,
  initialJoinCode: readJoin().slice(0, 40),
  lastSyncedAt: null,
});
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : 'Не удалось выполнить действие.';
const uuidPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;

export function useSession(options: {
  onOpenSource: (anchor: TextAnchor) => void;
  onOpenLocalWork: () => void;
  initialSessionId?: string | null;
  projectorMode: boolean;
}) {
  const [state, setState] = useState<SessionAreaState>(initialState);
  const [api, setApi] = useState<SessionApi | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [identityRevision, setIdentityRevision] = useState(0);
  const identityToken = useRef<string | null>(null);
  const enteredIdentity = useRef<string | null>(null);
  const [projection, setProjection] = useState<ProjectionSession | null>(null);
  const current = useRef(state);
  current.current = state;
  const selected = useRef(sessionId);
  selected.current = sessionId;
  const callbacks = useRef(options);
  callbacks.current = options;
  const refreshing = useRef<() => Promise<void>>(async () => {});
  const runLock = useRef(false);
  const projectionCursor = useRef(-1);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void loadCloudConfiguration()
      .then(async ({ config, error }) => {
        if (!active) return;
        if (!config) {
          setState((s) => ({
            ...s,
            configurationError: error,
            auth: { ...s.auth, status: 'signed-out' },
            connection: 'unconfigured',
          }));
          return;
        }
        const next = await (sharedApiPromise ??= import('../lib/session-api').then(
          ({ SessionApi }) => new SessionApi(config),
        ));
        if (!active) return;
        setApi(next);
        setState((s) => ({
          ...s,
          configured: true,
          testEnvironment: config.testEnvironment,
          ...(config.offline ? { offline: {
            instanceId: config.offlineInstanceId!, url: config.url,
            hostAvailable: isLoopbackHost(location.hostname),
          } } : {}),
          connection: 'connecting',
        }));
        const applyAuth = (session: WorkshopIdentitySession | null) => {
          if (!active) return;
          const id = session?.user.id ?? null;
          if (identityToken.current !== (session?.access_token ?? null)) {
            identityToken.current = session?.access_token ?? null;
            setIdentityRevision((value) => value + 1);
          }
          setState((s) => {
            const changed = s.auth.userId !== id;
            return {
              ...s,
              auth: {
                ...s.auth,
                status: session ? 'signed-in' : 'signed-out',
                email: session?.user.email ?? null,
                userId: id,
              },
              ...(changed
                ? { bootstrap: null, snapshot: null, invitation: null, lastSyncedAt: null }
                : {}),
              ...(!session ? { connection: 'connecting' as const } : {}),
            };
          });
          if (!session) {
            setProjection(null);
            projectionCursor.current = -1;
          }
        };
        unsubscribe = next.onIdentityChange(applyAuth);
        try {
          const parameters = new URLSearchParams(location.hash.slice(1));
          const hostAccess = parameters.get('hostAccess');
          if (hostAccess) {
            parameters.delete('hostAccess');
            parameters.set('sessions', '1');
            history.replaceState(null, '', `${location.pathname}#${parameters}`);
            applyAuth(await next.acceptHostLink(hostAccess));
          } else applyAuth(await next.identitySession());
        } catch (cause) {
          if (active) {
            applyAuth(null);
            setState((s) => ({ ...s, error: errorText(cause) }));
          }
        }
      })
      .catch((e) => {
        if (active)
          setState((s) => ({
            ...s,
            configurationError: errorText(e),
            auth: { ...s.auth, status: 'signed-out' },
            connection: 'error',
          }));
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!api || !state.auth.userId) return;
    let active = true;
    const identity = state.auth.userId;
    void Promise.all([api.bootstrap(), api.availableSessions()])
      .then(async ([bootstrap, availableSessions]) => {
        if (!active) return;
        setState((s) => ({ ...s, bootstrap, availableSessions, error: null }));
        if (!bootstrap.profile || enteredIdentity.current === identity) return;
        enteredIdentity.current = identity;
        const parameters = new URLSearchParams(location.hash.slice(1));
        const requested = parameters.get('session') ?? options.initialSessionId;
        const invitation = readJoin();
        try {
          if (requested && uuidPattern.test(requested)) {
            const snapshot = bootstrap.sessions.some((item) => item.id === requested)
              ? await api.snapshot(requested) : await api.joinOpenSession(requested);
            if (active) enter(snapshot);
          } else if (invitation) {
            const snapshot = await api.joinSession(invitation);
            if (active) enter(snapshot);
          } else if (!bootstrap.canCreateSession && availableSessions.length === 1) {
            const only = availableSessions[0];
            const snapshot = bootstrap.sessions.some((item) => item.id === only.id)
              ? await api.snapshot(only.id) : await api.joinOpenSession(only.id);
            if (active) enter(snapshot);
          }
        } catch (cause) {
          if (active) setState((s) => ({ ...s, error: errorText(cause) }));
        }
      })
      .catch((cause) => {
        if (active) setState((s) => ({ ...s, error: errorText(cause), connection: 'error' }));
      });
    return () => { active = false; };
  }, [api, state.auth.userId, identityRevision]);

  const applySnapshot = useCallback((snapshot: SessionSnapshot, force = false) => {
    if (!force && selected.current !== snapshot.session.id) return;
    setState((s) => {
      if (s.snapshot?.session.id === snapshot.session.id && s.snapshot.cursor > snapshot.cursor)
        return s;
      const sessions = s.bootstrap
        ? [snapshot.session, ...s.bootstrap.sessions.filter((x) => x.id !== snapshot.session.id)]
        : [];
      return {
        ...s,
        snapshot,
        bootstrap: s.bootstrap ? { ...s.bootstrap, sessions } : null,
        lastSyncedAt: new Date().toISOString(),
      };
    });
  }, []);

  useEffect(() => {
    if (!api || !state.auth.userId || !state.bootstrap?.profile || !sessionId) return;
    let active = true;
    let live = false;
    let pending: Promise<void> | null = null;
    let rerun = false;
    let schedule: ReturnType<typeof setTimeout> | undefined;
    let reconcileAt = 0;
    let lastReadError: string | null = null;
    projectionCursor.current = -1;
    const sync = (): Promise<void> => {
      if (!active) return Promise.resolve();
      if (pending) {
        rerun = true;
        return pending;
      }
      if (!api?.config.offline && !navigator.onLine) {
        setState((s) => ({ ...s, connection: 'offline' }));
        return Promise.resolve();
      }
      pending = (async () => {
        try {
          const knownCursor = options.projectorMode
            ? projectionCursor.current
            : current.current.snapshot?.session.id === sessionId
              ? current.current.snapshot.cursor
              : -1;
          const changed = knownCursor < 0 || (await api.cursor(sessionId)) !== knownCursor;
          if (options.projectorMode && changed) {
            const result = await api.projection(sessionId);
            if (active && result.cursor >= projectionCursor.current) {
              projectionCursor.current = result.cursor;
              setProjection(result);
            }
          } else if (!options.projectorMode && changed) {
            const result = await api.snapshot(sessionId);
            if (active) applySnapshot(result);
            if (result.session.role === 'host') {
              const invite = await api.invitation(sessionId);
              if (active) setState((s) => ({ ...s, invitation: invite }));
            } else if (active) setState((s) => ({ ...s, invitation: null }));
          }
          if (active) {
            // A new session may already arrive in a mutation response; its private invitation
            // still needs one fetch. Idle reconciliation then transfers only the cursor.
            if (
              !options.projectorMode &&
              current.current.snapshot?.session.role === 'host' &&
              !current.current.invitation
            ) {
              const invitation = await api.invitation(sessionId);
              if (active) setState((s) => ({ ...s, invitation }));
            }
            if (active)
              setState((s) => ({
                ...s,
                connection: live ? 'live' : 'polling',
                lastSyncedAt: new Date().toISOString(),
                error: lastReadError && s.error === lastReadError ? null : s.error,
              }));
            reconcileAt = Date.now();
            lastReadError = null;
          }
        } catch (e) {
          if (active) {
            lastReadError = errorText(e);
            const revoked = ['FORBIDDEN', 'NOT_FOUND', 'AUTH_REQUIRED'].includes(
              apiErrorCode(e) ?? '',
            );
            if (revoked) {
              setProjection(null);
              setState((s) => ({
                ...s,
                snapshot: null,
                invitation: null,
                error: errorText(e),
                connection: 'error',
              }));
            } else
              setState((s) => ({
                ...s,
                connection: (api?.config.offline || navigator.onLine) ? 'error' : 'offline',
                error: errorText(e),
              }));
          }
        } finally {
          pending = null;
          if (active && rerun) {
            rerun = false;
            void sync();
          }
        }
      })();
      return pending;
    };
    refreshing.current = sync;
    setState((s) => ({ ...s, connection: 'connecting' }));
    const channel = api.config.realtime
      ? api.client
          .channel(`dw-session-${sessionId}-${randomUuid()}`)
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'dw_session_events',
              filter: `session_id=eq.${sessionId}`,
            },
            () => {
              if (!schedule)
                schedule = setTimeout(() => {
                  schedule = undefined;
                  void sync();
                }, 150);
            },
          )
          .subscribe((status) => {
            if (!active) return;
            live = status === 'SUBSCRIBED';
            if (live) {
              setState((s) => ({ ...s, connection: 'live' }));
              void sync();
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
              setState((s) => ({ ...s, connection: (api?.config.offline || navigator.onLine) ? 'polling' : 'offline' }));
          })
      : null;
    void sync();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && (!live || Date.now() - reconcileAt > 30000))
        void sync();
    }, api.config.pollInterval);
    const focus = () => {
      if (document.visibilityState === 'visible') void sync();
    };
    const offline = () => { if (api.config.offline) void sync(); else setState((s) => ({ ...s, connection: 'offline' })); };
    window.addEventListener('online', focus);
    window.addEventListener('offline', offline);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      active = false;
      refreshing.current = async () => {};
      clearInterval(timer);
      if (schedule) clearTimeout(schedule);
      if (channel) void api.client.removeChannel(channel);
      window.removeEventListener('online', focus);
      window.removeEventListener('offline', offline);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [
    api,
    state.auth.userId,
    Boolean(state.bootstrap?.profile),
    sessionId,
    options.projectorMode,
    applySnapshot,
  ]);

  const run = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    if (runLock.current) throw new Error('Дождитесь завершения текущего действия.');
    runLock.current = true;
    setState((s) => ({ ...s, busy: label, error: null, notice: null }));
    try {
      return await work();
    } catch (e) {
      if (apiErrorCode(e) !== 'IDENTITY_CHANGED') setState((s) => ({ ...s, error: errorText(e) }));
      if (apiErrorCode(e) === 'REVISION_CONFLICT') await refreshing.current();
      throw e;
    } finally {
      runLock.current = false;
      setState((s) => ({ ...s, busy: null }));
    }
  };
  const requireApi = () => {
    if (!api) throw new Error('Сервер совместной работы ещё не подключён.');
    return api;
  };
  const requireSession = () => {
    if (!selected.current) throw new Error('Сначала выберите занятие.');
    return selected.current;
  };
  const enter = (snapshot: SessionSnapshot) => {
    selected.current = snapshot.session.id;
    setSessionId(snapshot.session.id);
    applySnapshot(snapshot, true);
    setState((s) => ({ ...s, invitation: null, error: null, notice: 'Занятие открыто.' }));
    history.replaceState(
      null,
      '',
      `${location.pathname}#session=${encodeURIComponent(snapshot.session.id)}${options.projectorMode ? '&projector=1' : ''}`,
    );
  };
  const localHostToken = async () => {
    const a = requireApi();
    if (!a.config.offline || !isLoopbackHost(location.hostname))
      throw new Error('Откройте кабинет преподавателя непосредственно на Mac.');
    const identity = await a.identitySession();
    if (!identity) throw new Error('Сначала войдите как преподаватель.');
    return identity.access_token;
  };
  const actions: SessionAreaActions = {
    identify: (input) => run('Открываем вашу работу', async () => {
      const result = await requireApi().identify(input);
      setState((s) => ({ ...s, notice: null }));
      return result;
    }),
    joinOpenSession: (id) => run('Открываем занятие', async () => {
      if (!uuidPattern.test(id)) throw new Error('Некорректный адрес занятия.');
      enter(await requireApi().joinOpenSession(id));
    }),
    localHost: (fullName) => run('Открываем кабинет преподавателя', async () => {
      const { session } = await localHost(requireApi().config, fullName);
      await requireApi().acceptLocalSession(session);
      if (fullName && fullName.trim().length >= 2 && fullName.trim().length <= 200) {
        const bootstrap = await requireApi().bootstrap();
        if (bootstrap.profile?.fullName !== fullName)
          await requireApi().saveProfile(fullName, bootstrap.profile?.revision ?? 0);
        const updated = await requireApi().bootstrap();
        setState((s) => ({ ...s, bootstrap: updated }));
      }
      setState((s) => ({ ...s, notice: 'Кабинет преподавателя открыт.' }));
    }),
    localServerStatus: async () => {
      const token = await localHostToken();
      return offlineRequest<LocalServerStatus>(requireApi().config, '/offline/admin/status', undefined, token);
    },
    localBackup: () => run('Сохраняем резервную копию', async () => {
      const token = await localHostToken();
      await offlineRequest(requireApi().config, '/offline/admin/backup', {}, token);
      setState((s) => ({ ...s, notice: 'Резервная копия сохранена на Mac.' }));
    }),
    signOut: () =>
      run('Завершаем сеанс', async () => {
        await requireApi().signOut();
        if (api?.config.offlineInstanceId) forgetLocalReceipt(api.config.offlineInstanceId);
        enteredIdentity.current = null;
        selected.current = null;
        setSessionId(null);
        setProjection(null);
        setState((s) => ({
          ...s,
          bootstrap: null,
          snapshot: null,
          invitation: null,
          availableSessions: [],
          auth: { status: 'signed-out', email: null, userId: null },
          notice: 'Вы вышли. Чтобы продолжить работу, введите тот же email.',
        }));
      }),
    saveProfile: (fullName, expectedRevision) =>
      run('Сохраняем ФИО', async () => {
        const name = fullName.trim();
        if (name.length < 2 || name.length > 200)
          throw new Error('Укажите ФИО длиной от 2 до 200 символов.');
        const identity = current.current.auth.userId;
        const token = identityToken.current;
        const stillCurrent = () => current.current.auth.userId === identity && identityToken.current === token;
        const a = requireApi();
        try {
          await a.saveProfile(name, expectedRevision ?? current.current.bootstrap?.profile?.revision ?? 0);
        } catch (cause) {
          if (!stillCurrent()) return;
          if (apiErrorCode(cause) === 'REVISION_CONFLICT') {
            const bootstrap = await a.bootstrap();
            if (!stillCurrent()) return;
            setState((s) => ({ ...s, bootstrap }));
          }
          throw cause;
        }
        if (!stillCurrent()) return;
        const bootstrap = await a.bootstrap();
        if (!stillCurrent()) return;
        setState((s) => ({ ...s, bootstrap, notice: 'Профиль сохранён.' }));
      }),
    createSession: (input) =>
      run('Создаём занятие', async () => {
        enter(await requireApi().createSession(input.title, input.scope, input.regionId));
      }),
    joinSession: (code) =>
      run('Входим в занятие', async () => {
        enter(await requireApi().joinSession(code));
      }),
    openSession: (id) =>
      run('Открываем занятие', async () => {
        if (!uuidPattern.test(id)) throw new Error('Некорректный идентификатор занятия.');
        enter(await requireApi().snapshot(id));
      }),
    closeSessionView: () => {
      selected.current = null;
      setSessionId(null);
      setProjection(null);
      setState((s) => ({ ...s, snapshot: null, invitation: null, error: null }));
      history.replaceState(null, '', location.pathname + '#sessions');
    },
    updateSession: (patch, revision) =>
      run('Сохраняем занятие', async () => {
        applySnapshot(await requireApi().updateSession(requireSession(), revision, patch));
      }),
    rotateInvitation: (revision) =>
      run('Обновляем приглашение', async () => {
        const id = requireSession();
        applySnapshot(await requireApi().rotateInvitation(id, revision));
        const invitation = await requireApi().invitation(id);
        setState((s) => ({ ...s, invitation, notice: 'Ссылка приглашения обновлена.' }));
      }),
    refresh: () =>
      run('Обновляем состояние', async () => {
        if (sessionId) await refreshing.current();
        else {
          const [bootstrap, availableSessions] = await Promise.all([requireApi().bootstrap(), requireApi().availableSessions()]);
          setState((s) => ({ ...s, bootstrap, availableSessions }));
        }
      }),
    publish: (bundle, localKey, revision) =>
      run('Отправляем практику', async () => {
        applySnapshot(await requireApi().publish(requireSession(), localKey, revision, bundle));
        setState((s) => ({ ...s, notice: 'Практика и её цитаты сохранены в занятии.' }));
      }),
    moderateSubmission: (id, revision, status) =>
      run('Обновляем показ', async () => {
        applySnapshot(await requireApi().moderate(requireSession(), id, revision, status));
      }),
    setMemberRole: (userId, revision, role) =>
      run('Меняем роль', async () => {
        applySnapshot(await requireApi().setMemberRole(requireSession(), userId, revision, role));
      }),
    revokeMember: (userId, revision) =>
      run('Закрываем доступ', async () => {
        applySnapshot(await requireApi().revokeMember(requireSession(), userId, revision));
      }),
    openSource: (anchor) => callbacks.current.onOpenSource(anchor),
    openLocalWork: () => callbacks.current.onOpenLocalWork(),
    openProjector: () => {
      const id = requireSession();
      window.open(
        `${location.origin}${location.pathname}#session=${encodeURIComponent(id)}&projector=1`,
        '_blank',
        'noopener,noreferrer',
      );
    },
    clearError: () => setState((s) => ({ ...s, error: null, notice: null })),
  };
  return { state, actions, projection, sessionId, api };
}
