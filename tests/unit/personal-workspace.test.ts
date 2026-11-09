// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { createAnchor, NORMALIZATION_VERSION, type DocumentVersion } from '@domain/index';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openServerWorkspaceStore, PERSONAL_WORKSPACE_ID } from '../../apps/web/src/storage/server';
import { createEmptyWorkspace, openWorkspaceStore, type WorkspaceSnapshot } from '../../apps/web/src/storage';
import { useWorkspace } from '../../apps/web/src/hooks/useWorkspace';
import type { SessionApi } from '../../apps/web/src/lib/session-api';

const id = PERSONAL_WORKSPACE_ID;
const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const saved = (revision = 1, title = 'Сохранённые заметки'): WorkspaceSnapshot => ({
  state: createEmptyWorkspace(id, title), revision, updatedAt: '2026-11-09T15:00:00.000Z',
});
function transport(respond: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>, parse: (value: unknown) => unknown) =>
    parse(await respond(name, args)));
  return { rpc, config: { url: 'https://notebook.example.test', identification: 'declared-email', offline: false } } as unknown as SessionApi & { rpc: typeof rpc };
}
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('BroadcastChannel', undefined); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('uses a scalar poll and cannot replace a confirmed newer revision with a slow read', async () => {
  let release!: (value: unknown) => void;
  const api = transport((name, args) => {
    if (name === 'dw_workspace_commit') return { kind: 'committed', revision: 2, replayed: false, snapshot: saved(2, 'Новая редакция') };
    if (args.p_known_revision === -1) return { snapshot: saved() };
    return new Promise(resolve => { release = resolve; });
  });
  const store = openServerWorkspaceStore(api);
  expect(await store.read(id)).toEqual(saved());
  const pending = store.read(id);
  await store.commit({ workspaceId: id, operationId, expectedRevision: 1, state: saved(2, 'Новая редакция').state });
  release({ unchanged: true, revision: 1 });
  expect((await pending)?.revision).toBe(2);
  expect(api.rpc.mock.calls[1][1]).toEqual({ p_known_revision: 1 });
  expect(api.rpc.mock.calls[2][1]).toEqual({ p_operation_id: operationId, p_expected_revision: 1, p_state: saved(2, 'Новая редакция').state });
  store.close();
});

it('retains acknowledged content on a rejected save and returns the current revision on conflict', async () => {
  let reject = true;
  const api = transport((name) => {
    if (name === 'dw_workspace_read') return { snapshot: saved() };
    if (reject) throw new Error('Соединение прервано');
    return { kind: 'conflict', expectedRevision: 1, actualRevision: 3, snapshot: saved(3, 'Правка с другого устройства') };
  });
  const store = openServerWorkspaceStore(api);
  await store.read(id);
  const request = { workspaceId: id, operationId, expectedRevision: 1, state: saved(1, 'Несохранённая правка').state };
  await expect(store.commit(request)).rejects.toThrow('Соединение прервано');
  expect((await store.read(id))?.state.title).toBe('Сохранённые заметки');
  reject = false;
  expect(await store.commit(request)).toMatchObject({ kind: 'conflict', actualRevision: 3, snapshot: { state: { title: 'Правка с другого устройства' } } });
  store.close();
});

it('rejects a corrupted response or a notebook with copied account details before reporting success', async () => {
  const state = saved().state;
  const bad = { ...saved(), state: { ...state, profile: { displayName: 'Лишнее имя' } } };
  const api = transport(() => ({ snapshot: bad }));
  const store = openServerWorkspaceStore(api);
  await expect(store.read(id)).rejects.toThrow('некорректную');
  await expect(store.commit({ workspaceId: id, operationId, expectedRevision: 0, state: bad.state })).rejects.toThrow('Некорректная команда');
  expect(api.rpc).toHaveBeenCalledOnce();
  store.close();
});

it('a failed personal load leaves class/account controls available but cannot overwrite unseen work', async () => {
  let available = false;
  const api = transport(() => { if (!available) throw new Error('Временно нет соединения'); return { snapshot: saved() }; });
  const { result } = renderHook(() => useWorkspace({ api, userId: 'actor-a' }));
  await waitFor(() => expect(result.current.error).toBe('Временно нет соединения'));
  expect(result.current.snapshot?.revision).toBe(0);
  await act(async () => { await expect(result.current.mutate(draft => { draft.title = 'Нельзя затереть'; })).rejects.toThrow('ещё не загружена'); });
  expect(api.rpc.mock.calls.every(call => call[0] === 'dw_workspace_read')).toBe(true);
  available = true;
  await act(async () => { await result.current.reload(); });
  expect(result.current.error).toBeNull();
  expect(result.current.snapshot?.state.title).toBe('Сохранённые заметки');
});

it('does not expose the previous participant notebook after a switch or a late save', async () => {
  let complete!: (value: unknown) => void;
  const apiA = transport((name) => name === 'dw_workspace_read' ? { snapshot: saved(1, 'Записи первого участника') }
    : new Promise(resolve => { complete = resolve; }));
  const apiB = transport(() => ({ snapshot: saved(1, 'Записи второго участника') }));
  const { result, rerender } = renderHook(({ api, userId }) => useWorkspace({ api, userId }),
    { initialProps: { api: apiA, userId: 'actor-a' } });
  await waitFor(() => expect(result.current.snapshot?.state.title).toBe('Записи первого участника'));
  let pending!: Promise<unknown>;
  await act(async () => { pending = result.current.mutate(draft => { draft.title = 'Правка первого участника'; }).catch(error => error); });
  rerender({ api: apiB, userId: 'actor-b' });
  expect(result.current.snapshot?.state.title).not.toBe('Записи первого участника');
  await waitFor(() => expect(result.current.snapshot?.state.title).toBe('Записи второго участника'));
  await act(async () => { complete({ kind: 'committed', revision: 2, replayed: false, snapshot: saved(2, 'Правка первого участника') }); await pending; });
  expect(result.current.snapshot?.state.title).toBe('Записи второго участника');
  expect(result.current.error).toBeNull();
  expect(apiB.rpc.mock.calls.some(call => call[0] === 'dw_workspace_commit')).toBe(false);
});

it('keeps a failed-save warning and the last confirmed content until a successful explicit retry', async () => {
  let current = saved();
  let fail = true;
  const api = transport((name, args) => {
    if (name === 'dw_workspace_read') return { snapshot: current };
    if (fail) throw new Error('Запись не подтверждена сервером');
    current = { ...current, revision: 2, state: args.p_state as typeof current.state };
    return { kind: 'committed', revision: 2, replayed: false, snapshot: current };
  });
  const { result } = renderHook(() => useWorkspace({ api, userId: 'actor-a' }));
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));
  await act(async () => { await expect(result.current.mutate(draft => { draft.title = 'Новая заметка'; })).rejects.toThrow('не подтверждена'); });
  await act(async () => { await result.current.reload(); });
  expect(result.current.error).toContain('не подтверждена');
  expect(result.current.snapshot?.state.title).toBe('Сохранённые заметки');
  fail = false;
  await act(async () => { await result.current.mutate(draft => { draft.title = 'Новая заметка'; }); });
  expect(result.current.snapshot?.state.title).toBe('Новая заметка');
  expect(result.current.error).toBeNull();
});

it('moves legacy notes only after an explicit choice, preserving the original and its exact quote', async () => {
  const source: DocumentVersion = { id: 'edition-old', documentId: 'document-old', normalizationVersion: NORMALIZATION_VERSION,
    sourceSha256: 'a'.repeat(64), blocks: [{ id: 'b-1', order: 0, kind: 'paragraph', text: 'Выплата составляет 100 000 рублей.' }] };
  const now = '2026-11-09T15:00:00.000Z';
  const old = createEmptyWorkspace('local-workspace');
  old.profile = { displayName: 'Имя из старого браузера', email: 'old@example.test' };
  old.sourceReferences = [{ sourceId: source.documentId, editionId: source.id, title: 'Программа',
    normalizationVersion: source.normalizationVersion, sha256: source.sourceSha256 }];
  const anchor = createAnchor(source, [{ blockId: 'b-1', start: 0, end: Array.from(source.blocks[0].text).length }]);
  old.annotations = [{ id: 'quote-old', anchor, note: 'Прежняя заметка', createdAt: now, updatedAt: now }];
  old.customCards = [{ id: 'card-old', familyId: 'family-old', regionId: 'ru-13', title: 'Выплата', mechanism: 'Денежная выплата',
    amount: '100 000 рублей', conditions: ['Проживание в регионе'], occurrenceIds: ['quote-old'], reviewStatus: 'verified', createdAt: now, updatedAt: now }];
  const local = await openWorkspaceStore();
  await local.commit({ workspaceId: old.id, operationId, expectedRevision: 0, state: old });
  let current: WorkspaceSnapshot | null = null;
  const api = transport((name, args) => {
    if (name === 'dw_workspace_read') return { snapshot: current };
    current = { state: args.p_state as typeof old, revision: 1, updatedAt: now };
    return { kind: 'committed', revision: 1, replayed: false, snapshot: current };
  });
  const { result } = renderHook(() => useWorkspace({ api, userId: 'actor-new' }));
  await waitFor(() => expect(result.current.legacyCount).toBe(2));
  expect(result.current.snapshot?.state.annotations).toHaveLength(0);
  expect(api.rpc.mock.calls.some(call => call[0] === 'dw_workspace_commit')).toBe(false);
  await act(async () => { await result.current.adoptLegacy(); });
  expect(result.current.snapshot?.state.profile).toBeNull();
  expect(result.current.snapshot?.state.annotations[0].anchor).toEqual(anchor);
  expect(result.current.snapshot?.state.customCards[0].reviewStatus).toBe('candidate');
  expect(result.current.legacyCount).toBe(0);
  expect((await local.read(old.id))?.state).toEqual(old);
  local.close();
});
