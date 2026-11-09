import { sha256Hex } from '../../../../packages/security/crypto.mjs';
import { WorkspaceError } from './errors';
import type {
  CommitRequest,
  CommitResult,
  SourceReference,
  WorkspaceChangeNotice,
  WorkspaceSnapshot,
  WorkspaceStore,
} from './types';
import { identifier, integer, timestamp, validateWorkspaceState } from './validation';

const DATABASE_VERSION = 1;
const WORKSPACES = 'workspaces';
const OPERATIONS = 'operations';
const EDITIONS = 'source-editions';
const DEFAULT_DATABASE_NAME = 'demography-workshop-local-v1';

type Channel = Pick<BroadcastChannel, 'postMessage' | 'close' | 'onmessage'>;

export interface WorkspaceStoreOptions {
  databaseName?: string;
  /** Useful for deterministic tests; defaults to the browser's IndexedDB. */
  indexedDB?: IDBFactory;
  /** null disables same-browser notifications without disabling persistence. */
  channelFactory?: ((name: string) => Channel) | null;
  clock?: () => string;
}

interface StoredWorkspace extends WorkspaceSnapshot {
  workspaceId: string;
}
interface StoredOperation {
  workspaceId: string;
  operationId: string;
  fingerprint: string;
  revision: number;
}

function storageError(
  cause: unknown,
  message = 'Не удалось сохранить рабочую тетрадь в этом браузере.',
): WorkspaceError {
  if (cause instanceof WorkspaceError) return cause;
  return new WorkspaceError('STORAGE_FAILURE', message, undefined, { cause });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

async function fingerprint(request: CommitRequest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(request));
  return sha256Hex(bytes);
}

function toSnapshot(record: StoredWorkspace): WorkspaceSnapshot {
  integer(record.revision, '$.revision', 1);
  timestamp(record.updatedAt, '$.updatedAt');
  return {
    state: validateWorkspaceState(record.state),
    revision: record.revision,
    updatedAt: record.updatedAt,
  };
}

function checkEdition(existing: SourceReference | undefined, incoming: SourceReference): void {
  if (!existing) return;
  if (
    existing.sourceId !== incoming.sourceId ||
    existing.normalizationVersion !== incoming.normalizationVersion ||
    (existing.sha256 !== undefined && incoming.sha256 !== existing.sha256)
  ) {
    throw new WorkspaceError(
      'SOURCE_EDITION_CONFLICT',
      'Идентификатор редакции уже связан с другим источником или контрольной суммой. Создайте новую редакцию.',
      incoming.editionId,
    );
  }
}

/**
 * All writes and operation receipts share one IndexedDB read/write transaction.
 * IndexedDB serializes competing write transactions, including those in other tabs.
 * BroadcastChannel is a reload hint only; the database remains the source of truth.
 */
export async function openWorkspaceStore(
  options: WorkspaceStoreOptions = {},
): Promise<WorkspaceStore> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory)
    throw new WorkspaceError(
      'STORAGE_UNAVAILABLE',
      'IndexedDB недоступна. Изменения не будут сохранены.',
    );
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let abandoned = false;
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, DATABASE_VERSION);
    } catch (cause) {
      reject(
        new WorkspaceError(
          'STORAGE_UNAVAILABLE',
          'Браузер запретил открытие локального хранилища.',
          undefined,
          { cause },
        ),
      );
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(WORKSPACES))
        database.createObjectStore(WORKSPACES, { keyPath: 'workspaceId' });
      if (!database.objectStoreNames.contains(OPERATIONS))
        database.createObjectStore(OPERATIONS, { keyPath: ['workspaceId', 'operationId'] });
      if (!database.objectStoreNames.contains(EDITIONS))
        database.createObjectStore(EDITIONS, { keyPath: 'editionId' });
    };
    request.onerror = () =>
      reject(
        new WorkspaceError(
          'STORAGE_UNAVAILABLE',
          'Не удалось открыть локальное хранилище.',
          undefined,
          { cause: request.error },
        ),
      );
    request.onblocked = () => {
      abandoned = true;
      reject(
        new WorkspaceError(
          'STORAGE_BLOCKED',
          'Обновление локального хранилища заблокировано другой вкладкой. Закройте старые вкладки приложения.',
        ),
      );
    };
    request.onsuccess = () => {
      if (abandoned) {
        request.result.close();
        return;
      }
      resolve(request.result);
    };
  });
  let closed = false;
  const listeners = new Map<string, Set<(notice: WorkspaceChangeNotice) => void>>();
  const origin = globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random()}`;
  let channel: Channel | null = null;
  try {
    if (options.channelFactory) channel = options.channelFactory(`${databaseName}:changes`);
    else if (options.channelFactory !== null && typeof BroadcastChannel !== 'undefined')
      channel = new BroadcastChannel(`${databaseName}:changes`);
  } catch {
    // Persistence still works when a privacy mode disables BroadcastChannel.
  }
  const emit = (notice: WorkspaceChangeNotice): void => {
    for (const callback of listeners.get(notice.workspaceId) ?? []) {
      try {
        callback({ ...notice });
      } catch {
        /* A UI listener cannot roll back a committed transaction. */
      }
    }
  };
  if (channel)
    channel.onmessage = (event) => {
      const message: unknown = event.data;
      if (!message || typeof message !== 'object') return;
      const data = message as Record<string, unknown>;
      if (
        data.type !== 'workspace-changed' ||
        data.origin === origin ||
        typeof data.workspaceId !== 'string' ||
        typeof data.revision !== 'number' ||
        !Number.isSafeInteger(data.revision) ||
        data.revision < 1
      )
        return;
      emit({ workspaceId: data.workspaceId, revision: data.revision, source: 'other-tab' });
    };
  const ensureOpen = (): void => {
    if (closed)
      throw new WorkspaceError(
        'STORAGE_CLOSED',
        'Локальное хранилище закрыто. Перезагрузите приложение.',
      );
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    db.close();
    channel?.close();
    listeners.clear();
  };
  db.onversionchange = close;

  return {
    async read(workspaceId) {
      ensureOpen();
      identifier(workspaceId, '$.workspaceId');
      return new Promise<WorkspaceSnapshot | null>((resolve, reject) => {
        let result: WorkspaceSnapshot | null = null;
        let failure: unknown;
        let transaction: IDBTransaction;
        try {
          transaction = db.transaction(WORKSPACES, 'readonly');
        } catch (cause) {
          reject(storageError(cause));
          return;
        }
        const request = transaction.objectStore(WORKSPACES).get(workspaceId);
        request.onsuccess = () => {
          try {
            if (request.result) result = toSnapshot(request.result as StoredWorkspace);
          } catch (cause) {
            failure = cause;
            transaction.abort();
          }
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () =>
          reject(
            storageError(
              failure ?? transaction.error,
              'Не удалось прочитать локальную рабочую тетрадь.',
            ),
          );
        transaction.onerror = () => {
          failure ??= transaction.error;
        };
      });
    },
    async commit(input) {
      ensureOpen();
      identifier(input.workspaceId, '$.workspaceId');
      identifier(input.operationId, '$.operationId');
      integer(input.expectedRevision, '$.expectedRevision', 0, Number.MAX_SAFE_INTEGER - 1);
      const state = validateWorkspaceState(input.state);
      if (state.id !== input.workspaceId)
        throw new WorkspaceError(
          'INVALID_DATA',
          'Идентификатор тетради не совпадает с назначением записи.',
        );
      const stableRequest: CommitRequest = {
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
        state,
      };
      const digest = await fingerprint(stableRequest);
      const now = options.clock?.() ?? new Date().toISOString();
      timestamp(now, '$.updatedAt');
      ensureOpen();
      return new Promise<CommitResult>((resolve, reject) => {
        let result: CommitResult | undefined;
        let failure: unknown;
        let transaction: IDBTransaction;
        try {
          transaction = db.transaction([WORKSPACES, OPERATIONS, EDITIONS], 'readwrite');
        } catch (cause) {
          reject(storageError(cause));
          return;
        }
        const workspaces = transaction.objectStore(WORKSPACES);
        const operations = transaction.objectStore(OPERATIONS);
        const editions = transaction.objectStore(EDITIONS);
        const abort = (cause: unknown): void => {
          failure = cause;
          transaction.abort();
        };
        const lookup = operations.get([stableRequest.workspaceId, stableRequest.operationId]);
        lookup.onsuccess = () => {
          const previous = lookup.result as StoredOperation | undefined;
          if (previous && previous.fingerprint !== digest) {
            abort(
              new WorkspaceError(
                'OPERATION_ID_REUSED',
                'Этот идентификатор операции уже использован для другого изменения.',
              ),
            );
            return;
          }
          const currentRequest = workspaces.get(stableRequest.workspaceId);
          currentRequest.onsuccess = () => {
            try {
              const current = currentRequest.result
                ? toSnapshot(currentRequest.result as StoredWorkspace)
                : null;
              if (previous) {
                if (!current)
                  throw new WorkspaceError(
                    'STORAGE_FAILURE',
                    'Запись операции не соответствует состоянию локального хранилища.',
                  );
                result = {
                  kind: 'committed',
                  revision: previous.revision,
                  replayed: true,
                  snapshot: current,
                };
                return;
              }
              const actualRevision = current?.revision ?? 0;
              if (actualRevision !== stableRequest.expectedRevision) {
                result = {
                  kind: 'conflict',
                  expectedRevision: stableRequest.expectedRevision,
                  actualRevision,
                  snapshot: current,
                };
                return;
              }
              const write = (): void => {
                const snapshot: WorkspaceSnapshot = {
                  state,
                  revision: actualRevision + 1,
                  updatedAt: now,
                };
                workspaces.put({ workspaceId: state.id, ...snapshot } satisfies StoredWorkspace);
                operations.put({
                  workspaceId: state.id,
                  operationId: stableRequest.operationId,
                  fingerprint: digest,
                  revision: snapshot.revision,
                } satisfies StoredOperation);
                for (const ref of state.sourceReferences) editions.put(ref);
                result = {
                  kind: 'committed',
                  revision: snapshot.revision,
                  replayed: false,
                  snapshot,
                };
              };
              let remaining = state.sourceReferences.length;
              if (remaining === 0) {
                write();
                return;
              }
              for (const ref of state.sourceReferences) {
                const editionRequest = editions.get(ref.editionId);
                editionRequest.onsuccess = () => {
                  try {
                    checkEdition(editionRequest.result as SourceReference | undefined, ref);
                    if (--remaining === 0) write();
                  } catch (cause) {
                    abort(cause);
                  }
                };
              }
            } catch (cause) {
              abort(cause);
            }
          };
        };
        transaction.oncomplete = () => {
          if (!result) {
            reject(
              new WorkspaceError(
                'STORAGE_FAILURE',
                'Операция завершилась без подтверждённого результата.',
              ),
            );
            return;
          }
          if (result.kind === 'committed' && !result.replayed) {
            const notice: WorkspaceChangeNotice = {
              workspaceId: stableRequest.workspaceId,
              revision: result.revision,
              source: 'local',
            };
            emit(notice);
            try {
              channel?.postMessage({
                type: 'workspace-changed',
                workspaceId: stableRequest.workspaceId,
                revision: result.revision,
                origin,
              });
            } catch {
              /* Commit is already durable. */
            }
          }
          resolve(result);
        };
        transaction.onabort = () => reject(storageError(failure ?? transaction.error));
        transaction.onerror = () => {
          failure ??= transaction.error;
        };
      });
    },
    subscribe(workspaceId, listener) {
      ensureOpen();
      identifier(workspaceId, '$.workspaceId');
      let group = listeners.get(workspaceId);
      if (!group) {
        group = new Set();
        listeners.set(workspaceId, group);
      }
      group.add(listener);
      return () => {
        group?.delete(listener);
        if (group?.size === 0) listeners.delete(workspaceId);
      };
    },
    close,
  };
}
