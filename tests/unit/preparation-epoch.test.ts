import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { CloudConfig } from '../../apps/web/src/lib/cloud-config';
import { PREPARATION_EPOCH, preparationEpochKey, prepareBrowserForClass } from '../../apps/web/src/lib/preparation-epoch';

const legacy = 'demography-workshop-local-v1';
const instance = 'c4658531-02ca-405e-bf34-2c6e8f55e83f';
const other = '267e7c18-e293-48db-84ca-21708b8b884a';
const online: CloudConfig = { url: 'https://projectone.supabase.co', publishableKey: 'sb_publishable_fixture', realtime: false, testEnvironment: false, pollInterval: 2000 };
const offline: CloudConfig = { ...online, url: 'http://192.168.5.10:8787', offline: true, offlineInstanceId: instance };
class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
async function database(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      for (const store of ['workspaces', 'operations', 'source-editions', 'unrelated-cache']) request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function write(factory: IDBFactory, name = legacy, value = 'test draft') {
  const db = await database(factory, name);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['workspaces', 'operations', 'source-editions', 'unrelated-cache'], 'readwrite');
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      for (const store of ['workspaces', 'operations', 'source-editions', 'unrelated-cache']) tx.objectStore(store).put(value, 'record');
    });
  } finally { db.close(); }
}
async function read(factory: IDBFactory, name = legacy) {
  const db = await database(factory, name);
  try {
    const values: Record<string, unknown> = {};
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['workspaces', 'operations', 'source-editions', 'unrelated-cache']);
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      for (const store of ['workspaces', 'operations', 'source-editions', 'unrelated-cache']) {
        const request = tx.objectStore(store).get('record');
        request.onsuccess = () => { values[store] = request.result; };
      }
    });
    return values;
  } finally { db.close(); }
}

describe('explicit preparation epoch before authentication and notebook loading', () => {
  it('removes guest test work and only current app keys while retaining immutable caches and other project data', async () => {
    const indexedDB = new IDBFactory(), storage = new MemoryStorage();
    await write(indexedDB);
    const cleared = ['dw-entry-v1:projectone.supabase.co', 'dw-auth-projectone.supabase.co', 'sb-projectone-auth-token', 'sb-projectone-auth-token-code-verifier', 'dw:cohort-options:1:old-map'];
    const retained = ['theme', 'another-app-draft', 'dw-auth-projecttwo.supabase.co', 'sb-projecttwo-auth-token', `dw-local-share-v1:${other}`];
    for (const key of [...cleared, ...retained]) storage.setItem(key, 'retained value');
    expect(await prepareBrowserForClass(online, { indexedDB, storage })).toBe(true);
    expect(await read(indexedDB)).toEqual({ workspaces: undefined, operations: undefined, 'source-editions': 'test draft', 'unrelated-cache': 'test draft' });
    for (const key of cleared) expect(storage.getItem(key)).toBeNull();
    for (const key of retained) expect(storage.getItem(key)).toBe('retained value');
    expect(storage.getItem(preparationEpochKey(online))).toBe(PREPARATION_EPOCH);
  });

  it('cleans the legacy and current installation notebooks but preserves another installation and its auth/share data', async () => {
    const indexedDB = new IDBFactory(), storage = new MemoryStorage();
    const own = `demography-workshop-offline-${instance}-v1`, unrelated = `demography-workshop-offline-${other}-v1`;
    for (const name of [legacy, own, unrelated]) await write(indexedDB, name);
    const cleared = [`dw-auth-offline-${instance}-192.168.5.10:8787`, 'dw-auth-192.168.5.10:8787', `dw-local-access-v1:${instance}`, `dw-local-access-pending-v1:${instance}:attempt`, `dw-local-access-pending-current-v1:${instance}`, `dw-local-share-v1:${instance}`];
    const retained = [`dw-auth-offline-${other}-192.168.5.10:8787`, `dw-local-access-v1:${other}`, `dw-local-share-v1:${other}`];
    for (const key of [...cleared, ...retained]) storage.setItem(key, 'value');
    await prepareBrowserForClass(offline, { indexedDB, storage });
    for (const name of [legacy, own]) expect((await read(indexedDB, name)).workspaces).toBeUndefined();
    expect((await read(indexedDB, unrelated)).workspaces).toBe('test draft');
    for (const key of cleared) expect(storage.getItem(key)).toBeNull();
    for (const key of retained) expect(storage.getItem(key)).toBe('value');
    expect(preparationEpochKey(offline)).not.toBe(preparationEpochKey({ ...offline, offlineInstanceId: other }));
  });

  it('preserves new work and sessions on later launches, including recovery of the local marker', async () => {
    const indexedDB = new IDBFactory(), storage = new MemoryStorage();
    await write(indexedDB);
    await prepareBrowserForClass(online, { indexedDB, storage });
    await write(indexedDB, legacy, 'real class work');
    storage.setItem('dw-auth-projectone.supabase.co', 'new session');
    storage.setItem('dw:cohort-options:1:new-map', 'new scenario');
    expect(await prepareBrowserForClass(online, { indexedDB, storage })).toBe(false);
    storage.removeItem(preparationEpochKey(online));
    expect(await prepareBrowserForClass(online, { indexedDB, storage })).toBe(false);
    expect((await read(indexedDB)).workspaces).toBe('real class work');
    expect(storage.getItem('dw-auth-projectone.supabase.co')).toBe('new session');
    expect(storage.getItem('dw:cohort-options:1:new-map')).toBe('new scenario');
  });

  it('serializes simultaneous first loads without clearing a new draft twice', async () => {
    const indexedDB = new IDBFactory(), storage = new MemoryStorage();
    await write(indexedDB);
    const first = prepareBrowserForClass(online, { indexedDB, storage });
    const second = prepareBrowserForClass(online, { indexedDB, storage });
    await first;
    await write(indexedDB, legacy, 'new work after preparation');
    expect(await second).toBe(false);
    expect((await read(indexedDB)).workspaces).toBe('new work after preparation');
  });

  it('repeats only when an explicitly different preparation epoch is supplied', async () => {
    const indexedDB = new IDBFactory(), storage = new MemoryStorage();
    await write(indexedDB);
    await prepareBrowserForClass(online, { indexedDB, storage });
    await write(indexedDB, legacy, 'a new deliberate preparation');
    expect(await prepareBrowserForClass(online, { indexedDB, storage, epoch: 'explicit-next-preparation' })).toBe(true);
    expect((await read(indexedDB)).workspaces).toBeUndefined();
  });

  it('does not mark an incomplete cleanup successful and permits a safe retry', async () => {
    const indexedDB = new IDBFactory(), storage = new MemoryStorage();
    await write(indexedDB);
    storage.setItem('dw-auth-projectone.supabase.co', 'old session');
    const remove = storage.removeItem.bind(storage);
    storage.removeItem = () => { throw new Error('storage denied'); };
    await expect(prepareBrowserForClass(online, { indexedDB, storage })).rejects.toThrow('storage denied');
    expect(storage.getItem(preparationEpochKey(online))).toBeNull();
    storage.removeItem = remove;
    expect(await prepareBrowserForClass(online, { indexedDB, storage })).toBe(true);
    expect(storage.getItem('dw-auth-projectone.supabase.co')).toBeNull();
  });

  it('does not create a guest notebook when no legacy guest data exists', async () => {
    const indexedDB = new IDBFactory(), storage = new MemoryStorage();
    await prepareBrowserForClass(online, { indexedDB, storage });
    expect((await indexedDB.databases()).map(db => db.name)).toEqual(['demography-workshop-preparation-v1']);
  });
});
