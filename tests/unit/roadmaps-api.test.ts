import { describe, expect, it, vi } from 'vitest';
import { RoadmapsApi } from '../../apps/web/src/lib/roadmaps-api';
import { SessionApi } from '../../apps/web/src/lib/session-api';
import {
  roomA,
  roomB,
  sessionId,
  runtimeSnapshot,
  runtimeProjection,
  runtimeVersion,
  deferred,
  versionId,
} from './roadmaps-runtime.fixture';

function api(response: unknown) {
  const invoke = async (_name: string, _args: unknown, parse: (value: unknown) => unknown) =>
    parse(await response);
  return new RoadmapsApi({ rpc: invoke, mutate: invoke } as unknown as SessionApi);
}
const risk = { title: 'Риск', mitigation: '', owner: '', trigger: '', contingency: '' };
describe('Roadmaps response binding', () => {
  it('rejects a valid but wrong-room response to a write', async () => {
    const pending = deferred<unknown>();
    const result = api(pending.promise).saveItem(sessionId, {
      roadmapId: roomA,
      itemId: null,
      expectedRevision: 0,
      kind: 'risk',
      data: risk,
      status: 'active',
    });
    const rejection = expect(result).rejects.toThrow('другой дорожной карте');
    pending.resolve(runtimeSnapshot(roomB));
    await rejection;
  });
  it('rejects a join response for another territory even inside the same session', async () => {
    await expect(
      api(runtimeSnapshot(roomB)).join(sessionId, {
        territoryKey: 'test-territory-a',
        dataEditionId: 'test-edition',
        expectedAssignmentRevision: 0,
      }),
    ).rejects.toThrow('другой территории');
  });
  it('rejects missing, unexpected or different selected-room projection', async () => {
    await expect(api(runtimeProjection(null)).projection(sessionId, roomA)).rejects.toThrow(
      'другой дорожной карте',
    );
    await expect(api(runtimeProjection(roomA)).projection(sessionId, null)).rejects.toThrow(
      'другой дорожной карте',
    );
    await expect(api(runtimeProjection(roomB)).projection(sessionId, roomA)).rejects.toThrow(
      'другой дорожной карте',
    );
    expect((await api(runtimeProjection(null)).projection(sessionId, null)).selected).toBeNull();
  });
  it('hashes immutable bytes and rejects a structurally valid tampered version', async () => {
    const version = await runtimeVersion();
    expect((await api(version).version(sessionId, roomA, versionId)).sha256).toBe(version.sha256);
    const tampered = structuredClone(version);
    tampered.snapshot.teamNames = ['Иное имя'];
    tampered.canonicalJson = JSON.stringify(tampered.snapshot);
    await expect(api(tampered).version(sessionId, roomA, versionId)).rejects.toThrow(
      'Контрольная сумма',
    );
  });
  it('retains the lost-response operation ID across another successful creation in the same room', async () => {
    const calls: Array<{ p_operation_id: string }> = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1)
        return new Response(
          JSON.stringify({ code: 'NETWORK', message: 'fetch failed after response loss' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      return new Response(JSON.stringify(runtimeSnapshot(roomA, 3)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const transport = new SessionApi({
      url: 'https://receipts.example.test',
      publishableKey: 'sb_publishable_test_abcdefghijklmnopqrst',
      realtime: false,
      testEnvironment: true,
      pollInterval: 60000,
    });
    const client = new RoadmapsApi(transport);
    const first = {
      roadmapId: roomA,
      itemId: null,
      expectedRevision: 0,
      kind: 'risk' as const,
      data: risk,
      status: 'active' as const,
    };
    const second = { ...first, data: { ...risk, title: 'Другая новая запись' } };
    try {
      await expect(client.saveItem(sessionId, first)).rejects.toMatchObject({ code: 'NETWORK' });
      await client.saveItem(sessionId, second);
      await client.saveItem(sessionId, first);
      expect(calls[2].p_operation_id).toBe(calls[0].p_operation_id);
      expect(calls[1].p_operation_id).not.toBe(calls[0].p_operation_id);
      await client.saveItem(sessionId, second);
      expect(calls[3].p_operation_id).not.toBe(calls[1].p_operation_id);
    } finally {
      fetch.mockRestore();
      await transport.client.auth.stopAutoRefresh();
    }
  });
});
