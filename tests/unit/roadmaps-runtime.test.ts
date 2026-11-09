// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoadmaps } from '../../apps/web/src/hooks/useRoadmaps';
import { SessionApiError } from '../../apps/web/src/lib/session-api';
import type { SessionApi } from '../../apps/web/src/lib/session-api';
import {
  deferred,
  sessionId,
  userId,
  roomA,
  roomB,
  versionId,
  runtimeSnapshot,
  runtimeIndex,
  runtimeProjection,
  runtimeVersion,
  testUuid,
} from './roadmaps-runtime.fixture';
import type { RoadmapSnapshot, RoadmapVersion } from '../../packages/roadmaps/types';

type Handler = (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>;
function transport(handler?: Handler) {
  const rpc = vi.fn(
    async (name: string, args: Record<string, unknown>, parse: (v: unknown) => unknown) => {
      const result = handler ? await handler(name, args) : undefined;
      if (result !== undefined) return parse(result);
      if (name === 'dw_roadmaps_index') return parse(runtimeIndex());
      if (name === 'dw_roadmaps_cursor') return parse(1);
      if (name === 'dw_roadmap_snapshot') return parse(runtimeSnapshot(String(args.p_roadmap_id)));
      if (name === 'dw_roadmaps_projector_snapshot')
        return parse(runtimeProjection(args.p_roadmap_id as string | null));
      throw new Error('Unexpected test RPC ' + name);
    },
  );
  return {
    config: { realtime: false, pollInterval: 60000 },
    client: {},
    rpc,
    mutate: rpc,
  } as unknown as SessionApi;
}
const joinB = {
  territoryKey: 'test-territory-b',
  dataEditionId: 'test-edition',
  expectedAssignmentRevision: 1,
};
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Roadmap asynchronous identity and selection boundaries', () => {
  it('ignores a slow former-room response after a new room is selected', async () => {
    const old = deferred<RoadmapSnapshot>();
    const api = transport((name, args) =>
      name === 'dw_roadmap_snapshot' && args.p_roadmap_id === roomA ? old.promise : undefined,
    );
    const { result } = renderHook(() => useRoadmaps({ api, sessionId, userId }));
    await waitFor(() => expect(result.current.selectedId).toBe(roomA));
    act(() => result.current.actions.select(roomB));
    await waitFor(() => expect(result.current.snapshot?.roadmapId).toBe(roomB));
    await act(async () => {
      old.resolve(runtimeSnapshot(roomA, 99));
      await old.promise;
    });
    expect(result.current.snapshot?.roadmapId).toBe(roomB);
    expect(result.current.selectedId).toBe(roomB);
  });
  it('rejects a version response after unmount, before an exporter can consume it', async () => {
    const old = deferred<RoadmapVersion>();
    const api = transport((name) => (name === 'dw_roadmap_version' ? old.promise : undefined));
    const { result, unmount } = renderHook(() => useRoadmaps({ api, sessionId, userId }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const read = result.current.actions.readVersion(roomA, versionId);
    const failure = expect(read).rejects.toThrow('модуль изменились');
    unmount();
    old.resolve(await runtimeVersion());
    await failure;
  });
  it('rejects a pending join after user identity changes and does not select the old response room', async () => {
    const old = deferred<RoadmapSnapshot>();
    const api = transport((name) => (name === 'dw_join_roadmap' ? old.promise : undefined));
    const { result, rerender } = renderHook(
      ({ who }) => useRoadmaps({ api, sessionId, userId: who }),
      { initialProps: { who: userId } },
    );
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    let join!: Promise<RoadmapSnapshot>;
    act(() => {
      join = result.current.actions.join(joinB);
    });
    const failure = expect(join).rejects.toThrow('изменились');
    rerender({ who: testUuid(8) });
    await waitFor(() => expect(result.current.snapshot?.roadmapId).toBe(roomA));
    await act(async () => {
      old.resolve(runtimeSnapshot(roomB, 10));
      await failure;
    });
    expect(result.current.selectedId).toBe(roomA);
    expect(result.current.busy).toBe(false);
  });
  it('rejects a pending write after unmount and prevents detached continuations', async () => {
    const old = deferred<RoadmapSnapshot>();
    const api = transport((name) => (name === 'dw_save_roadmap_item' ? old.promise : undefined));
    const { result, unmount } = renderHook(() => useRoadmaps({ api, sessionId, userId }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    let save!: Promise<RoadmapSnapshot>;
    act(() => {
      save = result.current.actions.saveItem({
        roadmapId: roomA,
        itemId: null,
        expectedRevision: 0,
        kind: 'risk',
        data: { title: 'Риск', mitigation: '', owner: '', trigger: '', contingency: '' },
        status: 'active',
      });
    });
    const failure = expect(save).rejects.toThrow('изменились');
    unmount();
    old.resolve(runtimeSnapshot(roomA, 2));
    await failure;
  });
  it('rejects a pending response when the transport changes despite an identical user/session', async () => {
    const old = deferred<RoadmapVersion>();
    const first = transport((name) => (name === 'dw_roadmap_version' ? old.promise : undefined));
    const second = transport();
    const { result, rerender } = renderHook(({ api }) => useRoadmaps({ api, sessionId, userId }), {
      initialProps: { api: first },
    });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const read = result.current.actions.readVersion(roomA, versionId);
    const failure = expect(read).rejects.toThrow('изменились');
    rerender({ api: second });
    old.resolve(await runtimeVersion());
    await failure;
  });
  it('clears cached content when confirmed email status is revoked', async () => {
    let denied = false;
    const api = transport((name) => {
      if (denied && name === 'dw_roadmaps_index') throw new SessionApiError('EMAIL_NOT_VERIFIED');
    });
    const { result } = renderHook(() => useRoadmaps({ api, sessionId, userId }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    denied = true;
    await act(async () => {
      await result.current.actions.refresh();
    });
    expect(result.current.snapshot).toBeNull();
    expect(result.current.index).toBeNull();
    expect(result.current.error).toContain('Введите email и ФИО');
  });
  it('keeps projector selection when an earlier projection arrives late', async () => {
    const old = deferred<ReturnType<typeof runtimeProjection>>();
    const api = transport((name, args) =>
      name === 'dw_roadmaps_projector_snapshot' && args.p_roadmap_id === null
        ? old.promise
        : undefined,
    );
    const { result } = renderHook(() => useRoadmaps({ api, sessionId, userId, projector: true }));
    act(() => result.current.actions.select(roomB));
    await waitFor(() => expect(result.current.projection?.selected?.roadmapId).toBe(roomB));
    await act(async () => {
      old.resolve(runtimeProjection(null, 50));
      await old.promise;
    });
    expect(result.current.projection?.selected?.roadmapId).toBe(roomB);
    await expect(result.current.actions.join(joinB)).rejects.toThrow('учебной сессии');
  });
  it('does not release a new transport mutation lock when the old transport finally returns', async () => {
    const old = deferred<RoadmapSnapshot>(),
      next = deferred<RoadmapSnapshot>();
    const first = transport((name) => (name === 'dw_join_roadmap' ? old.promise : undefined));
    const second = transport((name) => (name === 'dw_join_roadmap' ? next.promise : undefined));
    const { result, rerender } = renderHook(({ api }) => useRoadmaps({ api, sessionId, userId }), {
      initialProps: { api: first },
    });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    let previous!: Promise<RoadmapSnapshot>;
    act(() => {
      previous = result.current.actions.join(joinB);
    });
    const oldFailure = expect(previous).rejects.toThrow('изменились');
    rerender({ api: second });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    let current!: Promise<RoadmapSnapshot>;
    act(() => {
      current = result.current.actions.join(joinB);
    });
    await act(async () => {
      old.resolve(runtimeSnapshot(roomB, 2));
      await oldFailure;
    });
    expect(result.current.busy).toBe(true);
    await expect(result.current.actions.join(joinB)).rejects.toThrow('Дождитесь сохранения');
    await act(async () => {
      next.resolve(runtimeSnapshot(roomB, 3));
      await current;
    });
    expect(result.current.busy).toBe(false);
  });
});
