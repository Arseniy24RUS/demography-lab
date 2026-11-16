import type { CloudConfig } from './cloud-config';

export const PREPARATION_EPOCH = '2026-11-17-preclass-1';
const PREPARATION_DATABASE = 'demography-workshop-preparation-v1';
const PREPARATION_STORE = 'epochs';
const LEGACY_GUEST_DATABASE = 'demography-workshop-local-v1';

interface PreparationOptions {
  indexedDB?: IDBFactory;
  storage?: Storage;
  epoch?: string;
}

export function preparationEpochKey(config: CloudConfig | null): string {
  const authority = config?.offline
    ? `offline:${config.offlineInstanceId}`
    : `online:${config ? new URL(config.url).host : 'local'}`;
  return `dw-preparation-epoch-v1:${authority}`;
}

/** No database version change and no deletion of the immutable source-editions cache. */
async function clearGuestNotebook(factory: IDBFactory, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(name);
    let missing = false;
    let cancelled = false;
    request.onupgradeneeded = (event) => {
      // Opening a missing database must not create a new guest notebook.
      if (event.oldVersion === 0) { missing = true; request.transaction!.abort(); }
    };
    request.onerror = () => missing ? resolve() : reject(request.error);
    request.onblocked = () => {
      cancelled = true;
      reject(new Error('Закройте другие вкладки мастерской и перезагрузите страницу.'));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (cancelled) { database.close(); return; }
      const stores = ['workspaces', 'operations'].filter(store => database.objectStoreNames.contains(store));
      if (!stores.length) { database.close(); resolve(); return; }
      const transaction = database.transaction(stores, 'readwrite');
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
      for (const store of stores) transaction.objectStore(store).clear();
    };
  });
}

function clearAppStorage(storage: Storage, config: CloudConfig | null): void {
  const exact = new Set<string>();
  const prefixes = ['dw:cohort-options:1:'];
  if (config) {
    const url = new URL(config.url);
    exact.add(`dw-entry-v1:${url.host}`);
    exact.add(`dw-auth-${url.host}`);
    if (config.offline && config.offlineInstanceId) {
      const instance = config.offlineInstanceId;
      exact.add(`dw-auth-offline-${instance}-${url.host}`);
      exact.add(`dw-local-access-v1:${instance}`);
      exact.add(`dw-local-access-pending-current-v1:${instance}`);
      exact.add(`dw-local-share-v1:${instance}`);
      prefixes.push(`dw-local-access-pending-v1:${instance}:`);
    }
    // Older clients used Supabase's default key before the app supplied its own.
    if (/^[a-z0-9]+\.supabase\.co$/u.test(url.hostname))
      exact.add(`sb-${url.hostname.split('.')[0]}-auth-token`);
  }
  for (const key of [...exact]) exact.add(`${key}-code-verifier`);
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
  for (const key of keys)
    if (key && (exact.has(key) || prefixes.some(prefix => key.startsWith(prefix)))) storage.removeItem(key);
}

function openPreparationDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(PREPARATION_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PREPARATION_STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** This explicitly named preparation runs before auth and notebooks can open.
 * A separate IndexedDB transaction serializes first loads across tabs, including
 * plain HTTP classrooms where Web Locks are unavailable. Ordinary upgrades do
 * not change the epoch or erase subsequent work.
 */
export async function prepareBrowserForClass(
  config: CloudConfig | null,
  options: PreparationOptions = {},
): Promise<boolean> {
  const storage = options.storage ?? globalThis.localStorage;
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const epoch = options.epoch ?? PREPARATION_EPOCH;
  const key = preparationEpochKey(config);
  if (storage.getItem(key) === epoch) return false;
  if (!factory) throw new Error('Браузер не разрешил подготовить локальное хранилище мастерской.');
  const database = await openPreparationDatabase(factory);
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(PREPARATION_STORE, 'readwrite');
      const epochs = transaction.objectStore(PREPARATION_STORE);
      let changed = false;
      let failed = false;
      let failure: unknown;
      transaction.onabort = () => reject(failure ?? transaction.error);
      transaction.oncomplete = () => {
        try { storage.setItem(key, epoch); resolve(changed); }
        catch (cause) { reject(cause); }
      };
      const lookup = epochs.get(key);
      lookup.onsuccess = () => {
        if (lookup.result?.epoch === epoch) return;
        // Keep this exclusive claim alive while the separate guest databases
        // finish their transactions. A closed/crashed tab releases it by abort.
        let completed = false;
        const keepAlive = () => {
          const request = epochs.get(key);
          request.onsuccess = () => {
            if (!completed) keepAlive();
            else if (failed) transaction.abort();
            else { epochs.put({ id: key, epoch }); changed = true; }
          };
        };
        keepAlive();
        void (async () => {
          await clearGuestNotebook(factory, LEGACY_GUEST_DATABASE);
          if (config?.offline && config.offlineInstanceId)
            await clearGuestNotebook(factory, `demography-workshop-offline-${config.offlineInstanceId}-v1`);
          clearAppStorage(storage, config);
          completed = true;
        })().catch(cause => {
          failed = true;
          failure = cause;
          completed = true;
        });
      };
    });
  } finally { database.close(); }
}
