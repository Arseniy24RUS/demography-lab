import type { SessionApi } from '../lib/session-api';
import { WorkspaceError } from './errors';
import type { CommitResult, WorkspaceSnapshot, WorkspaceStore } from './types';
import { integer, object, timestamp, validateWorkspaceState } from './validation';

export const PERSONAL_WORKSPACE_ID = 'personal-workspace';

function parseSnapshot(value: unknown): WorkspaceSnapshot {
  const row = object(value, '$.snapshot', ['state', 'revision', 'updatedAt']);
  integer(row.revision, '$.snapshot.revision', 1);
  timestamp(row.updatedAt, '$.snapshot.updatedAt');
  const state = validateWorkspaceState(row.state);
  if (state.id !== PERSONAL_WORKSPACE_ID || state.profile !== null)
    throw new WorkspaceError('INVALID_DATA', 'Сервер вернул некорректную личную рабочую тетрадь.');
  return { state, revision: row.revision as number, updatedAt: row.updatedAt as string };
}

/** The authenticated actor is resolved by the server, never from a caller-supplied user id.
 * This store holds only acknowledged data. An unsuccessful save leaves the editing form open.
 * A scalar revision check avoids repeatedly downloading unchanged quotations and documents.
 */
export function openServerWorkspaceStore(
  api: Pick<SessionApi, 'rpc'>,
  options: { pollInterval?: number } = {},
): WorkspaceStore {
  let closed = false;
  let cached: WorkspaceSnapshot | null | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const listeners = new Set<(notice: { workspaceId: string; revision: number; source: 'local' | 'other-tab' }) => void>();
  const ensureOpen = (id: string) => {
    if (closed) throw new WorkspaceError('STORAGE_CLOSED', 'Профиль изменился. Откройте свою работу заново.');
    if (id !== PERSONAL_WORKSPACE_ID) throw new WorkspaceError('INVALID_DATA', 'Некорректный идентификатор тетради.');
  };
  const remember = (next: WorkspaceSnapshot | null, source: 'local' | 'other-tab') => {
    if (closed) return;
    // A slow response cannot replace a newer acknowledged revision.
    if (cached && (!next || next.revision < cached.revision)) return;
    const changed = cached === undefined || cached?.revision !== next?.revision;
    cached = next;
    if (changed) for (const listener of listeners) listener({
      workspaceId: PERSONAL_WORKSPACE_ID, revision: next?.revision ?? 0, source,
    });
  };
  const store: WorkspaceStore = {
    async read(id) {
      ensureOpen(id);
      const knownRevision = cached?.revision ?? -1;
      const result = await api.rpc('dw_workspace_read', { p_known_revision: knownRevision }, value => {
        if (value && typeof value === 'object' && 'unchanged' in value) {
          const row = object(value, '$', ['unchanged', 'revision']);
          if (row.unchanged !== true || !cached || row.revision !== knownRevision || cached.revision < knownRevision)
            throw new WorkspaceError('INVALID_DATA', 'Не удалось подтвердить редакцию личной работы.');
          return cached;
        }
        const row = object(value, '$', ['snapshot']);
        return row.snapshot === null ? null : parseSnapshot(row.snapshot);
      });
      ensureOpen(id);
      remember(result, 'other-tab');
      return cached ?? null;
    },
    async commit(request) {
      ensureOpen(request.workspaceId);
      integer(request.expectedRevision, '$.expectedRevision', 0, Number.MAX_SAFE_INTEGER - 1);
      const state = validateWorkspaceState(request.state);
      if (state.id !== PERSONAL_WORKSPACE_ID || state.profile !== null ||
        !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(request.operationId))
        throw new WorkspaceError('INVALID_DATA', 'Некорректная команда сохранения личной работы.');
      const result = await api.rpc<CommitResult>('dw_workspace_commit', {
        p_operation_id: request.operationId,
        p_expected_revision: request.expectedRevision,
        p_state: state,
      }, value => {
        if (value && typeof value === 'object' && 'kind' in value && value.kind === 'conflict') {
          const row = object(value, '$', ['kind', 'expectedRevision', 'actualRevision', 'snapshot']);
          integer(row.actualRevision, '$.actualRevision', 0);
          const snapshot = row.snapshot === null ? null : parseSnapshot(row.snapshot);
          if (row.expectedRevision !== request.expectedRevision || row.actualRevision !== (snapshot?.revision ?? 0))
            throw new WorkspaceError('INVALID_DATA', 'Сервер вернул несогласованные редакции тетради.');
          return { kind: 'conflict', expectedRevision: request.expectedRevision,
            actualRevision: row.actualRevision as number, snapshot };
        }
        const row = object(value, '$', ['kind', 'revision', 'replayed', 'snapshot']);
        integer(row.revision, '$.revision', 1);
        const snapshot = parseSnapshot(row.snapshot);
        if (row.kind !== 'committed' || typeof row.replayed !== 'boolean' || (row.revision as number) > snapshot.revision)
          throw new WorkspaceError('INVALID_DATA', 'Сервер не подтвердил сохранение тетради.');
        return { kind: 'committed', revision: row.revision as number, replayed: row.replayed, snapshot };
      });
      ensureOpen(request.workspaceId);
      remember(result.snapshot, 'local');
      return result;
    },
    subscribe(id, listener) {
      ensureOpen(id);
      listeners.add(listener);
      if (!timer) timer = setInterval(() => void poll(), options.pollInterval ?? 5000);
      return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
    },
    close() {
      closed = true;
      clearInterval(timer);
      listeners.clear();
      if (typeof window !== 'undefined') window.removeEventListener('online', resume);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume);
    },
  };
  async function poll() {
    if (closed || polling || !listeners.size || (typeof document !== 'undefined' && document.hidden)) return;
    polling = true;
    try { await store.read(PERSONAL_WORKSPACE_ID); }
    catch { /* A failed background read cannot replace acknowledged content. The next poll retries. */ }
    finally { polling = false; }
  }
  const resume = () => { void poll(); };
  if (typeof window !== 'undefined') window.addEventListener('online', resume);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume);
  return store;
}
