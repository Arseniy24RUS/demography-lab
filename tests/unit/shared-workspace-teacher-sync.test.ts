// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSession } from '../../apps/web/src/hooks/useSession';

vi.mock('../../apps/web/src/lib/cloud-config', () => ({
  loadCloudConfiguration: async () => ({ error: null, config: {
    url: 'https://shared-teacher-sync.example.test', publishableKey: 'sb_publishable_shared_teacher_test',
    identification: 'declared-email', realtime: false, testEnvironment: true, pollInterval: 60000,
  } }),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('keeps a teacher connected to the shared workspace without any legacy invitation, including changed cursors and return visits', async () => {
  localStorage.clear();
  history.replaceState(null, '', '/#sessions=1');
  const userId = '11111111-1111-4111-8111-111111111111';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const timestamp = '2026-11-09T19:00:00.000Z';
  const profile = { userId, fullName: 'Преподаватель общей мастерской', revision: 1 };
  const identity = { access_token: 'b'.repeat(64), expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, email: 'omnistat@yandex.ru', user_metadata: { full_name: profile.fullName } } };
  let snapshot = {
    session: { id: sessionId, title: 'Демографическая мастерская', scope: 'municipality',
      regionId: 'respublika-mordoviia', status: 'open', phase: 'reading', role: 'host', revision: 1,
      joinOpen: true, focusSubmissionId: null, projectorShowAuthors: false, createdAt: timestamp, updatedAt: timestamp },
    members: [{ userId, fullName: profile.fullName, role: 'host', joinedAt: timestamp, revision: 1 }],
    submissions: [], cursor: 1,
  };
  const methods: string[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = new URL(url).pathname.split('/').at(-1)!;
    const args = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (method === 'dw_identify' || method === 'dw_entry_session') return json({ session: identity });
    if (method === 'dw_entry_rpc') {
      methods.push(String(args.p_method));
      switch (args.p_method) {
        case 'dw_bootstrap': return json({ profile, canCreateSession: true, sessions: [] });
        case 'dw_enter_workspace':
        case 'dw_session_snapshot': return json(snapshot);
        case 'dw_session_cursor': return json(snapshot.cursor);
        // New shared workspaces have no row in private.invitations. This is the
        // real legacy RPC response, not a valid invitation or a transport error.
        case 'dw_invitation': return json(null);
      }
    }
    throw new Error('Unexpected shared-workspace request ' + method);
  }));
  const options = { onOpenSource: vi.fn(), onOpenLocalWork: vi.fn(), projectorMode: false };
  const first = renderHook(() => useSession(options));
  await waitFor(() => expect(first.result.current.state.auth.status).toBe('signed-out'));
  await act(async () => { await first.result.current.actions.identify({ email: 'omnistat@yandex.ru' }); });
  await waitFor(() => expect(first.result.current.state.snapshot?.session.role).toBe('host'));
  await waitFor(() => expect(first.result.current.state.connection).toBe('polling'));
  expect(first.result.current.state.error).toBeNull();
  expect(first.result.current.state.invitation).toBeNull();
  expect(methods).not.toContain('dw_invitation');

  const snapshotsBefore = methods.filter(method => method === 'dw_session_snapshot').length;
  await act(async () => { await first.result.current.actions.refresh(); });
  expect(methods.filter(method => method === 'dw_session_snapshot')).toHaveLength(snapshotsBefore);
  expect(first.result.current.state.connection).toBe('polling');
  expect(first.result.current.state.error).toBeNull();

  snapshot = { ...snapshot, cursor: 2, session: { ...snapshot.session, title: 'Обновлённая общая мастерская', revision: 2 } };
  await act(async () => { await first.result.current.actions.refresh(); });
  await waitFor(() => expect(first.result.current.state.snapshot?.session.title).toBe('Обновлённая общая мастерская'));
  expect(methods.filter(method => method === 'dw_session_snapshot')).toHaveLength(snapshotsBefore + 1);
  expect(first.result.current.state.connection).toBe('polling');
  expect(first.result.current.state.error).toBeNull();
  expect(methods).not.toContain('dw_invitation');

  first.unmount();
  const returned = renderHook(() => useSession(options));
  await waitFor(() => expect(returned.result.current.state.snapshot?.session.id).toBe(sessionId));
  await waitFor(() => expect(returned.result.current.state.connection).toBe('polling'));
  expect(returned.result.current.state.auth.email).toBe('omnistat@yandex.ru');
  expect(returned.result.current.state.error).toBeNull();
  expect(methods).not.toContain('dw_invitation');
});
