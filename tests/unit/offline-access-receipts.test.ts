import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class TestStorage implements Storage {
  values = new Map<string, string>();
  unavailable = false;
  get length() { if (this.unavailable) throw new Error('Storage disabled'); return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { if (this.unavailable) throw new Error('Storage disabled'); return this.values.get(key) ?? null; }
  key(index: number) { if (this.unavailable) throw new Error('Storage disabled'); return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { if (this.unavailable) throw new Error('Storage disabled'); this.values.delete(key); }
  setItem(key: string, value: string) { if (this.unavailable) throw new Error('Storage disabled'); this.values.set(key, value); }
}
const instanceId = 'edea2d3f-49ec-4154-9397-265981acbb53';
const url = 'http://192.168.1.10:8787';
const config = { url, publishableKey: 'sb_publishable_test_fixture', realtime: false,
  testEnvironment: true, pollInterval: 2000, offline: true, offlineInstanceId: instanceId };
const identity = { email: 'participant@example.org', fullName: 'Участник семинара' };
const importApi = () => import('../../apps/web/src/lib/offline-api');
const accepted = () => new Response(JSON.stringify({ session: {
  access_token: 'accepted-access-token', refresh_token: 'accepted-refresh-token',
} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
let storage: TestStorage;
beforeEach(() => {
  vi.resetModules(); storage = new TestStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('location', { origin: url });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('durable local access without overwriting a working identity', () => {
  it('keeps the existing key on rejected classroom code and reuses the pending key after reload/correction', async () => {
    let api = await importApi();
    const existing = api.newLocalReceipt(instanceId, url);
    api.keepLocalReceipt(existing);
    const first = api.beginLocalRegistration(instanceId, url, identity);
    expect(first.persisted).toBe(true);
    expect(api.readLocalReceipt(instanceId)).toEqual(existing);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'INVALID_CLASSROOM_CODE' }), { status: 403 })));
    await expect(api.localLogin(config, { ...identity, joinCode: 'WRONG', recoverySecret: first.pending.receipt.recoverySecret })).rejects.toThrow();
    expect(api.readLocalReceipt(instanceId)).toEqual(existing);

    vi.resetModules(); api = await importApi();
    expect(api.readPendingRegistration(instanceId)?.identity).toEqual(identity);
    const retry = api.beginLocalRegistration(instanceId, url, identity);
    expect(retry.pending.receipt.recoverySecret).toBe(first.pending.receipt.recoverySecret);
    const fetch = vi.fn().mockResolvedValue(accepted()); vi.stubGlobal('fetch', fetch);
    await api.localLogin(config, { ...identity, joinCode: 'CORRECT', recoverySecret: retry.pending.receipt.recoverySecret });
    expect(JSON.parse(fetch.mock.calls[0][1].body).recoverySecret).toBe(first.pending.receipt.recoverySecret);
    expect(api.readLocalReceipt(instanceId)?.recoverySecret).toBe(first.pending.receipt.recoverySecret);
    expect(api.readPendingRegistration(instanceId)).toBeNull();
  });

  it('retains the exact retry secret across a lost response and reload, while independent attempts remain separate', async () => {
    let api = await importApi();
    const first = api.beginLocalRegistration(instanceId, url, identity);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Connection lost after commit')));
    await expect(api.localLogin(config, { ...identity, joinCode: 'CLASSROOM', recoverySecret: first.pending.receipt.recoverySecret })).rejects.toThrow();
    const second = api.beginLocalRegistration(instanceId, url, { email: 'second@example.org', fullName: 'Другой участник' });
    expect(second.pending.receipt.recoverySecret).not.toBe(first.pending.receipt.recoverySecret);
    vi.resetModules(); api = await importApi();
    expect(api.beginLocalRegistration(instanceId, url, identity).pending.receipt.recoverySecret).toBe(first.pending.receipt.recoverySecret);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(accepted()));
    await api.localLogin(config, { ...identity, joinCode: 'CLASSROOM', recoverySecret: first.pending.receipt.recoverySecret });
    expect(api.readPendingRegistration(instanceId, second.pending.fingerprint)?.receipt.recoverySecret).toBe(second.pending.receipt.recoverySecret);
  });

  it('keeps the confirmed key downloadable in memory when browser storage is blocked', async () => {
    storage.unavailable = true;
    const api = await importApi();
    const existing = api.newLocalReceipt(instanceId, url);
    expect(api.keepLocalReceipt(existing)).toBe(false);
    const pending = api.beginLocalRegistration(instanceId, url, identity);
    expect(pending.persisted).toBe(false);
    expect(api.readLocalReceipt(instanceId)).toEqual(existing);
    expect(api.beginLocalRegistration(instanceId, url, identity).pending.receipt).toEqual(pending.pending.receipt);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(accepted()));
    await api.localLogin(config, { ...identity, joinCode: 'CLASSROOM', recoverySecret: pending.pending.receipt.recoverySecret });
    // The form may now unmount: the signed-in panel can still offer a deliberate download.
    expect(api.readLocalReceipt(instanceId)).toEqual(pending.pending.receipt);
    api.forgetLocalReceipt(instanceId);
    expect(api.readLocalReceipt(instanceId)).toBeNull();
    expect(api.readPendingRegistration(instanceId)).toBeNull();
  });

  it('never replaces a working key with a rejected recovery key', async () => {
    const api = await importApi();
    const existing = api.newLocalReceipt(instanceId, url); api.keepLocalReceipt(existing);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'RECOVERY_NOT_FOUND' }), { status: 403 })));
    await expect(api.localRecovery(config, 'a'.repeat(64))).rejects.toThrow();
    expect(api.readLocalReceipt(instanceId)).toEqual(existing);
  });

  it('explicit forgetting removes active and pending keys of this instance only', async () => {
    let api = await importApi();
    const otherInstance = '7c073ca0-d3dd-4a08-86fd-09f340df0c35';
    api.keepLocalReceipt(api.newLocalReceipt(instanceId, url));
    api.beginLocalRegistration(instanceId, url, identity);
    const other = api.beginLocalRegistration(otherInstance, url, identity);
    api.forgetLocalReceipt(instanceId);
    vi.resetModules(); api = await importApi();
    expect(api.readLocalReceipt(instanceId)).toBeNull();
    expect(api.readPendingRegistration(instanceId)).toBeNull();
    expect(api.readPendingRegistration(otherInstance)?.receipt).toEqual(other.pending.receipt);
  });
});
