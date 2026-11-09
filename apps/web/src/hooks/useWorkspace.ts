import { randomUuid } from '../../../../packages/security/crypto.mjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createEmptyWorkspace, openWorkspaceStore } from '@/storage';
import type { WorkspaceSnapshot, WorkspaceState, WorkspaceStore } from '@/storage';

const WORKSPACE_ID = 'local-workspace';
export function newId(prefix: string) {
  return `${prefix}-${randomUuid()}`;
}
export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = useRef<WorkspaceSnapshot | null>(null);
  const store = useRef<WorkspaceStore | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const apply = useCallback((s: WorkspaceSnapshot) => {
    if (!current.current || s.revision >= current.current.revision) {
      current.current = s;
      setSnapshot(s);
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    let close: (() => void) | undefined;
    (async () => {
      const db = await openWorkspaceStore();
      if (cancelled) {
        db.close();
        return;
      }
      store.current = db;
      let saved = await db.read(WORKSPACE_ID);
      if (!saved) {
        const init = await db.commit({
          workspaceId: WORKSPACE_ID,
          operationId: newId('initialize'),
          expectedRevision: 0,
          state: createEmptyWorkspace(WORKSPACE_ID),
        });
        saved = init.snapshot;
      }
      if (!saved) throw new Error('Не удалось создать локальную рабочую тетрадь.');
      if (cancelled) {
        db.close();
        return;
      }
      apply(saved);
      const unsubscribe = db.subscribe(WORKSPACE_ID, () => {
        db.read(WORKSPACE_ID)
          .then((s) => {
            if (s && !cancelled) apply(s);
          })
          .catch((e) => {
            if (!cancelled) setError(String(e));
          });
      });
      close = () => {
        unsubscribe();
        db.close();
      };
    })().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : 'Локальное хранилище недоступно.');
    });
    return () => {
      cancelled = true;
      close?.();
      store.current = null;
    };
  }, [apply]);
  const mutate = useCallback(
    (update: (draft: WorkspaceState) => void) => {
      const operationId = newId('operation');
      const promise = queue.current
        .catch(() => undefined)
        .then(async () => {
          if (!store.current || !current.current)
            throw new Error('Рабочая тетрадь ещё загружается.');
          setSaving(true);
          setError(null);
          try {
            const base = current.current;
            const state = structuredClone(base.state);
            update(state);
            const result = await store.current.commit({
              workspaceId: WORKSPACE_ID,
              operationId,
              expectedRevision: base.revision,
              state,
            });
            if (result.kind === 'conflict') {
              if (result.snapshot) apply(result.snapshot);
              throw new Error(
                'Работа изменилась в другой вкладке. Обновлённая версия загружена; повторите действие после проверки.',
              );
            }
            apply(result.snapshot);
            return result.snapshot;
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Изменения не удалось сохранить.');
            throw cause;
          } finally {
            setSaving(false);
          }
        });
      queue.current = promise;
      return promise;
    },
    [apply],
  );
  return { snapshot, mutate, saving, error, clearError: () => setError(null) };
}
