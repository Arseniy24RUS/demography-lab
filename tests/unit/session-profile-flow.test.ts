// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSession } from '../../apps/web/src/hooks/useSession';

vi.mock('../../apps/web/src/lib/cloud-config', () => ({
  loadCloudConfiguration: async () => ({ error: null, config: {
    url: 'https://profile-flow.example.test', publishableKey: 'sb_publishable_profile_flow_test',
    identification: 'declared-email', realtime: false, testEnvironment: true, pollInterval: 60000,
  } }),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('connects email lookup, saved-name bootstrap, revisioned profile edit and email-only return', async () => {
  localStorage.clear(); history.replaceState(null, '', '/#sessions=1');
  const userId = '11111111-1111-4111-8111-111111111111';
  let profile = { userId, fullName: 'Сохранённое ФИО преподавателя', revision: 1 };
  const requests: Array<{ method: string; args: Record<string, unknown> }> = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
    headers: { 'Content-Type': 'application/json' } });
  const session = () => ({ access_token: 'a'.repeat(64), expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, email: 'omnistat@yandex.ru', user_metadata: { full_name: profile.fullName } } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = new URL(url).pathname.split('/').at(-1)!;
    const args = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ method, args });
    if (method === 'dw_identify') return args.p_email === 'new@example.test'
      ? json({ profileRequired: true, email: args.p_email }) : json({ session: session() });
    if (method === 'dw_entry_session') return json({ session: session() });
    if (method === 'dw_entry_logout') return json({ signedOut: true });
    if (method === 'dw_entry_rpc') {
      if (args.p_method === 'dw_bootstrap') return json({ profile, canCreateSession: true, sessions: [] });
      if (args.p_method === 'dw_available_sessions') return json([]);
      if (args.p_method === 'dw_save_profile') {
        const input = args.p_args as Record<string, unknown>;
        if (input.p_expected_revision !== profile.revision) return json({ message: 'REVISION_CONFLICT' }, 409);
        profile = { ...profile, fullName: String(input.p_full_name), revision: profile.revision + 1 };
        return json(profile);
      }
    }
    throw new Error('Unexpected profile-flow request ' + method);
  }));
  const { result } = renderHook(() => useSession({ onOpenSource: vi.fn(), onOpenLocalWork: vi.fn(), projectorMode: false }));
  await waitFor(() => expect(result.current.state.auth.status).toBe('signed-out'));
  await act(async () => {
    expect(await result.current.actions.identify({ email: 'new@example.test' }))
      .toEqual({ status: 'profile-required', email: 'new@example.test' });
  });
  expect(result.current.state.auth.status).toBe('signed-out');
  expect(result.current.state.bootstrap).toBeNull();
  await act(async () => {
    expect(await result.current.actions.identify({ email: 'omnistat@yandex.ru' })).toEqual({ status: 'signed-in' });
  });
  await waitFor(() => expect(result.current.state.bootstrap?.profile?.fullName).toBe('Сохранённое ФИО преподавателя'));
  expect(requests.filter((r) => r.method === 'dw_identify').map((r) => r.args))
    .toEqual([{ p_email: 'new@example.test' }, { p_email: 'omnistat@yandex.ru' }]);
  expect(requests.some((r) => r.args.p_method === 'dw_save_profile')).toBe(false);

  await act(async () => { await result.current.actions.saveProfile('Уточнённое ФИО преподавателя', 1); });
  expect(result.current.state.bootstrap?.profile).toMatchObject({ fullName: 'Уточнённое ФИО преподавателя', revision: 2 });
  await act(async () => { await result.current.actions.signOut(); });
  expect(result.current.state.bootstrap).toBeNull();
  await act(async () => { await result.current.actions.identify({ email: 'omnistat@yandex.ru' }); });
  await waitFor(() => expect(result.current.state.bootstrap?.profile?.fullName).toBe('Уточнённое ФИО преподавателя'));

  profile = { ...profile, fullName: 'Изменение на другом устройстве', revision: 3 };
  await act(async () => { await expect(result.current.actions.saveProfile('Мой новый вариант', 2)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' }); });
  expect(result.current.state.bootstrap?.profile).toMatchObject({ fullName: 'Изменение на другом устройстве', revision: 3 });
  expect(profile.fullName).toBe('Изменение на другом устройстве');
  await act(async () => { await result.current.actions.signOut(); });
});
