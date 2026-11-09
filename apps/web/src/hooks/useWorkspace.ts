import { randomUuid } from '../../../../packages/security/crypto.mjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createEmptyWorkspace, openWorkspaceStore, exportWorkspace, validateWorkspaceImport } from '@/storage';
import type { WorkspaceSnapshot, WorkspaceState, WorkspaceStore } from '@/storage';
import { openServerWorkspaceStore, PERSONAL_WORKSPACE_ID } from '@/storage/server';
import { mergeImportedWorkspace } from '@/lib/archive';
import type { SessionApi } from '@/lib/session-api';

const LOCAL_WORKSPACE_ID = 'local-workspace';
export function newId(prefix: string) {
  return `${prefix}-${randomUuid()}`;
}
interface Binding {
  key: string;
  id: string;
  store: WorkspaceStore;
  snapshot: WorkspaceSnapshot | null;
  ready: boolean;
  active: boolean;
  queue: Promise<unknown>;
}
const rows = (state: WorkspaceState) => [
  ...state.annotations, ...state.customCards, ...state.practiceProposals,
  ...state.linkDecisions, ...state.readingTasks,
];
export function useWorkspace(options: { api?: SessionApi | null; userId?: string | null } = {}) {
  const api = options.api ?? null;
  const userId = options.userId ?? null;
  const remote = Boolean(api && userId);
  const key = remote ? `${api!.config.url}:${api!.config.offlineInstanceId ?? ''}:${userId}` : 'guest';
  const id = remote ? PERSONAL_WORKSPACE_ID : LOCAL_WORKSPACE_ID;
  const [view, setView] = useState<{ key: string; snapshot: WorkspaceSnapshot | null }>({ key: '', snapshot: null });
  const [failure, setFailure] = useState<{ key: string; message: string; kind: 'read' | 'write' } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [legacy, setLegacy] = useState<{ key: string; snapshot: WorkspaceSnapshot } | null>(null);
  const binding = useRef<Binding | null>(null);
  const apply = useCallback((target: Binding, value: WorkspaceSnapshot) => {
    if (!target.active || binding.current !== target) return;
    if (!target.snapshot || value.revision >= target.snapshot.revision) {
      target.snapshot = value;
      setView({ key: target.key, snapshot: value });
    }
  }, []);
  const read = useCallback(async (target: Binding) => {
    try {
      const saved = await target.store.read(target.id);
      if (!target.active || binding.current !== target) return;
      apply(target, saved ?? { state: createEmptyWorkspace(target.id), revision: 0, updatedAt: new Date().toISOString() });
      target.ready = true;
      setFailure(current => current?.key === target.key && current.kind === 'read' ? null : current);
    } catch (cause) {
      if (target.active && binding.current === target)
        setFailure({ key: target.key, kind: 'read', message: cause instanceof Error ? cause.message : 'Не удалось загрузить сохранённую работу.' });
    }
  }, [apply]);
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    setFailure(null);
    setBusyKey(null);
    setLegacy(null);
    (async () => {
      const store = remote ? openServerWorkspaceStore(api!) : await openWorkspaceStore();
      if (cancelled) { store.close(); return; }
      const target: Binding = { key, id, store, snapshot: null, ready: false, active: true, queue: Promise.resolve() };
      binding.current = target;
      // A failed personal-notebook read must not hide account controls or the collaborative class.
      if (remote) apply(target, { state: createEmptyWorkspace(id), revision: 0, updatedAt: new Date().toISOString() });
      const unsubscribe = store.subscribe(id, () => { void read(target); });
      cleanup = () => { target.active = false; unsubscribe(); store.close(); };
      await read(target);
      if (remote && target.active) {
        const local = await openWorkspaceStore();
        try {
          const old = await local.read(LOCAL_WORKSPACE_ID);
          if (old && !cancelled && binding.current === target) setLegacy({ key, snapshot: old });
        } finally { local.close(); }
      }
    })().catch(cause => {
      if (!cancelled) setFailure({ key, kind: 'read', message: cause instanceof Error ? cause.message : 'Хранилище недоступно.' });
    });
    return () => {
      cancelled = true;
      cleanup?.();
      if (binding.current?.key === key) binding.current = null;
    };
  }, [api, remote, key, id, apply, read]);
  const mutate = useCallback((update: (draft: WorkspaceState) => void) => {
    const target = binding.current;
    if (!target || target.key !== key || !target.ready)
      return Promise.reject(new Error('Рабочая тетрадь ещё не загружена. Дождитесь соединения и повторите действие.'));
    const operationId = randomUuid();
    const promise = target.queue.catch(() => undefined).then(async () => {
      if (!target.active || binding.current !== target)
        throw new Error('Профиль изменился. Откройте свою работу заново.');
      setBusyKey(target.key);
      setFailure(null);
      try {
        const base = target.snapshot!;
        const state = structuredClone(base.state);
        update(state);
        if (remote) state.profile = null;
        const result = await target.store.commit({ workspaceId: id, operationId, expectedRevision: base.revision, state });
        if (!target.active || binding.current !== target)
          throw new Error('Профиль изменился. Сохранение относится к прежнему участнику.');
        if (result.kind === 'conflict') {
          if (result.snapshot) apply(target, result.snapshot);
          throw new Error('Работа уже изменена в другом окне или на другом устройстве. Текущая версия загружена; ваш ввод остался в форме. Сравните изменения и повторите сохранение.');
        }
        apply(target, result.snapshot);
        return result.snapshot;
      } catch (cause) {
        if (target.active && binding.current === target)
          setFailure({ key: target.key, kind: 'write', message: cause instanceof Error ? cause.message : 'Изменения не удалось сохранить.' });
        throw cause;
      } finally {
        if (target.active && binding.current === target) setBusyKey(null);
      }
    });
    target.queue = promise;
    return promise;
  }, [key, id, remote, apply]);
  const snapshot = view.key === key ? view.snapshot : null;
  const legacySnapshot = legacy?.key === key ? legacy.snapshot : null;
  const existing = new Set(snapshot ? rows(snapshot.state).map(row => row.id) : []);
  const legacyCount = legacySnapshot ? rows(legacySnapshot.state).filter(row => !existing.has(row.id)).length : 0;
  const adoptLegacy = useCallback(async () => {
    if (!legacySnapshot || !remote) return;
    // Reuse the established transfer boundary without downloading or asking for a file.
    // The unattributed browser workbook cannot silently confer verified authorship.
    const incoming = validateWorkspaceImport(exportWorkspace(legacySnapshot)).workspace;
    await mutate(draft => { mergeImportedWorkspace(draft, incoming); draft.profile = null; });
  }, [legacySnapshot, remote, mutate]);
  const reload = useCallback(async () => {
    if (binding.current?.key === key) await read(binding.current);
  }, [key, read]);
  return {
    snapshot, mutate, saving: busyKey === key,
    error: failure?.key === key ? failure.message : null,
    clearError: () => setFailure(null), reload, legacyCount, adoptLegacy,
    workspaceTarget: remote ? api!.config.offline ? 'offline' as const : 'cloud' as const : 'device' as const,
  };
}
