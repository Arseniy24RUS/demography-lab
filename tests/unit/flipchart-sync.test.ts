// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFlipchart } from '../../apps/web/src/hooks/useFlipchart';
import type { SessionApi } from '../../apps/web/src/lib/session-api';
import type { FlipchartBoardScope, FlipchartNote, FlipchartUpdates } from '../../packages/flipchart/types';

afterEach(cleanup);
const sessionId = '11111111-1111-4111-8111-111111111111';
const a = '22222222-2222-4222-8222-222222222222';
const b = '33333333-3333-4333-8333-333333333333';
const note = (id: string, text: string): FlipchartNote => ({
  id, text, kind: 'barrier', status: 'active', createdAt: '2026-11-09T12:00:00Z',
  revision: 1, support: 0, oppose: 0, score: 0, myVote: null, myVoteRevision: 0, canWithdraw: true,
});
const frame = (cursor: number, notes: FlipchartNote[], reset = false): FlipchartUpdates => ({
  sessionId, cursor, notes, reset, removedIds: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function transport(read: (args: Record<string, unknown>) => Promise<unknown>, write: () => Promise<unknown>) {
  return {
    config: { url: 'https://flipchart.example.test', offline: false, realtime: false, pollInterval: 60000 },
    rpc: vi.fn(async (_method, args, parse) => parse(await read(args))),
    mutate: vi.fn(async (_method, _args, parse) => parse(await write())),
  } as unknown as SessionApi;
}

it('reads the missing delta after an acknowledgement, even when an older poll is already in flight', async () => {
  const oldPoll = deferred<FlipchartUpdates>();
  const cursors: unknown[] = [];
  const voted = { ...note(a, 'Нет своего жилья'), support: 1, score: 1, myVote: 1 as const, myVoteRevision: 1 };
  let calls = 0;
  const api = transport(async args => {
    cursors.push(args.p_after_cursor);
    calls += 1;
    if (calls === 1) return frame(1, [note(a, 'Нет своего жилья')], true);
    if (calls === 2) return oldPoll.promise;
    return frame(3, [voted, note(b, 'Нет детского сада')]);
  }, async () => ({ sessionId, cursor: 3, note: voted }));
  const view = renderHook(() => useFlipchart({ api, sessionId, userId: 'one' }));
  await waitFor(() => expect(view.result.current.notes).toHaveLength(1));
  act(() => { void view.result.current.refresh(); });
  await act(async () => { await view.result.current.vote(view.result.current.notes[0], 1); });
  expect(view.result.current.notes[0].myVote).toBe(1);
  await act(async () => { oldPoll.resolve(frame(2, [note(a, 'Нет своего жилья'), note(b, 'Нет детского сада')])); });
  await waitFor(() => expect(cursors).toEqual([null, 1, 2]));
  expect(view.result.current.notes).toHaveLength(2);
  expect(view.result.current.notes.find(item => item.id === a)?.myVote).toBe(1);
});

it('discards the previous account’s late response and unfinished action after an identity switch', async () => {
  const oldRead = deferred<FlipchartUpdates>();
  const oldWrite = deferred<unknown>();
  let calls = 0;
  const api = transport(async () => ++calls === 1 ? oldRead.promise : frame(8, [], true), () => oldWrite.promise);
  const view = renderHook(({ userId }) => useFlipchart({ api, sessionId, userId }), { initialProps: { userId: 'old' } });
  let action!: Promise<boolean>;
  act(() => { action = view.result.current.add('barrier', 'Старый черновик'); });
  view.rerender({ userId: 'new' });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  await act(async () => {
    oldRead.resolve(frame(7, [note(a, 'Старый ответ')], true));
    oldWrite.resolve({ sessionId, cursor: 8, note: note(b, 'Старый черновик') });
  });
  expect(await action).toBe(false);
  expect(view.result.current.notes).toEqual([]);
  expect(view.result.current.removed).toBeNull();
  expect(view.result.current.error).toBeNull();
});

it('rebases to a restored server backup when a delta request explicitly returns a lower reset cursor', async () => {
  let calls = 0;
  const cursors: unknown[] = [];
  const api = transport(async args => {
    cursors.push(args.p_after_cursor);
    return ++calls === 1 ? frame(12, [note(a, 'Более поздний стикер')], true)
      : calls === 2 ? frame(4, [note(b, 'Стикер из резервной копии')], true)
        : frame(4, []);
  }, async () => ({}));
  const view = renderHook(() => useFlipchart({ api, sessionId, userId: 'one' }));
  await waitFor(() => expect(view.result.current.notes[0]?.id).toBe(a));
  await act(async () => { await view.result.current.refresh(); });
  expect(view.result.current.notes.map(item => item.id)).toEqual([b]);
  await act(async () => { await view.result.current.refresh(); });
  expect(cursors).toEqual([null, 12, 4]);
});

it('sends a catalogue key only to the objective board and ignores the previous board’s late response', async () => {
  const legacyRead = deferred<FlipchartUpdates>();
  const factor = { ...note(b, 'Дефицит мест в яслях'), factorKey: 'childcare_capacity' };
  const api = transport(
    async args => args.p_board === 'objective-v2' ? frame(4, [factor], true) : legacyRead.promise,
    async () => ({ sessionId, cursor: 4, note: factor }),
  );
  const view = renderHook(({ board }: { board?: FlipchartBoardScope }) => useFlipchart({ api, sessionId, userId: 'one', board }),
    { initialProps: {} });
  expect(api.rpc).toHaveBeenCalledWith('dw_flipchart_updates', { p_session_id: sessionId, p_after_cursor: null, p_projector: false }, expect.any(Function));
  view.rerender({ board: 'objective' });
  await waitFor(() => expect(view.result.current.notes).toEqual([factor]));
  expect(api.rpc).toHaveBeenLastCalledWith('dw_flipchart_updates', { p_session_id: sessionId, p_after_cursor: null, p_projector: false, p_board: 'objective-v2' }, expect.any(Function));
  await act(async () => legacyRead.resolve(frame(12, [note(a, 'Старый ответ')], true)));
  expect(view.result.current.notes).toEqual([factor]);
  await act(async () => expect(await view.result.current.add('condition', factor.text)).toBe(false));
  expect(api.mutate).not.toHaveBeenCalled();
  await act(async () => expect(await view.result.current.add('condition', factor.text, factor.factorKey)).toBe(true));
  expect(api.mutate).toHaveBeenCalledWith('dw_flipchart_add', {
    p_session_id: sessionId,
    p_input: { board: 'objective', factorKey: factor.factorKey, kind: 'condition', text: factor.text },
  }, expect.any(Function));
});

it('applies explicit territory removal responses without moving the read cursor or retaining stale territory keys', async () => {
  const selection = { factorKey: 'housing-p', territoryKey: 'town-one' };
  const shared = { ...note(a, 'Жильё'), kind: 'condition' as const, factorKey: selection.factorKey,
    territoryKeys: ['region-one', 'town-one'], territoryCount: 2 };
  const active = { ...shared, territoryKeys: ['region-one'], territoryCount: 1 };
  const responses = [active, null, { ...active, territoryKeys: [], territoryCount: 0, status: 'withdrawn' as const }];
  let reads = 0;
  const api = transport(async () => ++reads === 1 ? frame(2, [shared], true) : frame(reads + 1, []),
    async () => ({ sessionId, cursor: reads + 2, note: responses.shift() }));
  const view = renderHook(() => useFlipchart({ api, sessionId, userId: 'one', board: 'objective' }));
  await waitFor(() => expect(view.result.current.notes).toEqual([shared]));
  await act(async () => expect(await view.result.current.selectFactor('condition', active.text, selection, false)).toBe(true));
  expect(api.mutate).toHaveBeenLastCalledWith('dw_flipchart_add', { p_session_id: sessionId,
    p_input: { board: 'objective', kind: 'condition', text: active.text, ...selection, territorySelected: false },
  }, expect.any(Function));
  expect(api.rpc).toHaveBeenLastCalledWith('dw_flipchart_updates',
    { p_session_id: sessionId, p_after_cursor: 2, p_projector: false, p_board: 'objective-v2' }, expect.any(Function));
  expect(view.result.current.notes).toEqual([active]);
  await act(async () => expect(await view.result.current.selectFactor('condition', active.text, selection, false)).toBe(true));
  expect(view.result.current.notes).toEqual([active]);
  await act(async () => expect(await view.result.current.selectFactor('condition', active.text, { ...selection, territoryKey: 'region-one' }, false)).toBe(true));
  expect(view.result.current.notes).toEqual([]);
});
