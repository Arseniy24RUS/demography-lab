// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFlipchart } from '../../apps/web/src/hooks/useFlipchart';
import type { SessionApi } from '../../apps/web/src/lib/session-api';
import type { FlipchartNote, FlipchartUpdates } from '../../packages/flipchart/types';

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
