// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeclaredIdentity } from '../../apps/web/src/lib/declared-identity';
import type { CloudConfig } from '../../apps/web/src/lib/cloud-config';

const config: CloudConfig = { url: 'https://identity.example.test', publishableKey: 'sb_publishable_test_identity',
  identification: 'declared-email', realtime: false, testEnvironment: true, pollInterval: 1000 };
const session = (key = 'a') => ({ access_token: key.repeat(64), expires_at: Math.floor(Date.now() / 1000) + 86400,
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'listener@example.test', user_metadata: { full_name: 'Иванов Иван Иванович' } } });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { 'Content-Type': 'application/json' } });

describe('declared classroom identity', () => {
  beforeEach(() => { localStorage.clear(); });
  it('sends the name only when completing a first profile and creates no email, OTP or registration request', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(response({ session: session() }));
    const api = new DeclaredIdentity(config, send);
    const changes: unknown[] = [];
    api.onChange((value) => changes.push(value));
    await api.identify({ email: ' Listener@Example.TEST ', fullName: ' Иванов  Иван  Иванович ' });
    expect(send).toHaveBeenCalledTimes(1);
    const [url, request] = send.mock.calls[0];
    expect(url).toBe('https://identity.example.test/rest/v1/rpc/dw_identify');
    expect(JSON.parse(String(request?.body))).toEqual({ p_email: 'listener@example.test', p_full_name: 'Иванов Иван Иванович' });
    expect(request?.credentials).toBe('omit');
    expect(request?.referrerPolicy).toBe('no-referrer');
    expect(request?.headers).not.toHaveProperty('Authorization');
    expect(changes).toHaveLength(1);
  });
  it('restores an automatic session in a new client and sends the actor token only to the gateway body', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ session: session() }))
      .mockResolvedValueOnce(response({ session: session() }))
      .mockResolvedValueOnce(response({ profile: { fullName: 'Иванов Иван Иванович' } }));
    await new DeclaredIdentity(config, send).identify({ email: 'listener@example.test', fullName: 'Иванов Иван Иванович' });
    const restored = new DeclaredIdentity(config, send);
    expect((await restored.getSession())?.user.id).toBe(session().user.id);
    await restored.rpc('dw_bootstrap', {});
    const [url, request] = send.mock.calls[2];
    expect(String(url)).not.toContain('a'.repeat(64));
    expect(JSON.parse(String(request?.body))).toEqual({ p_token: 'a'.repeat(64), p_method: 'dw_bootstrap', p_args: {} });
  });
  it('does not resurrect a signed-out identity after a delayed restore', async () => {
    let resolveRestore!: (value: Response) => void;
    const delayed = new Promise<Response>((resolve) => { resolveRestore = resolve; });
    const send = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/dw_entry_session')) return delayed;
      if (String(url).endsWith('/dw_entry_logout')) return response({ signedOut: true });
      return response({ session: session() });
    });
    const api = new DeclaredIdentity(config, send);
    await api.identify({ email: 'listener@example.test', fullName: 'Иванов Иван Иванович' });
    const restoring = api.getSession();
    await api.signOut();
    resolveRestore(response({ session: session() }));
    expect(await restoring).toBeNull();
    expect((await api.rpc('dw_bootstrap', {})).error?.message).toBe('AUTH_REQUIRED');
    expect(localStorage.getItem('dw-entry-v1:identity.example.test')).toBeNull();
  });
  it('does not clear a newer identity when an old restore is denied late', async () => {
    let resolveRestore!: (value: Response) => void;
    const delayed = new Promise<Response>((resolve) => { resolveRestore = resolve; });
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ session: session() }))
      .mockImplementationOnce(() => delayed)
      .mockResolvedValueOnce(response({ session: session('b') }));
    const api = new DeclaredIdentity(config, send);
    await api.identify({ email: 'listener@example.test', fullName: 'Иванов Иван Иванович' });
    const restoring = api.getSession();
    await api.identify({ email: 'listener@example.test', fullName: 'Иванов Иван Иванович' });
    resolveRestore(response({ message: 'AUTH_REQUIRED', code: '42501' }, 401));
    expect((await restoring)?.access_token).toBe('b'.repeat(64));
    expect(JSON.parse(localStorage.getItem('dw-entry-v1:identity.example.test')!).session.access_token).toBe('b'.repeat(64));
  });
  it('does not replace the existing identity if the server refuses a new entry', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ session: session() }))
      .mockResolvedValueOnce(response({ message: 'INVALID_INPUT', code: '22023' }, 400))
      .mockResolvedValueOnce(response({ ok: true }));
    const api = new DeclaredIdentity(config, send);
    await api.identify({ email: 'listener@example.test', fullName: 'Иванов Иван Иванович' });
    await expect(api.identify({ email: 'bad', fullName: 'X' })).rejects.toThrow('INVALID_INPUT');
    await api.rpc('dw_bootstrap', {});
    expect(JSON.parse(String(send.mock.calls[2][1]?.body)).p_token).toBe('a'.repeat(64));
  });
  it('invalidates a revoked session and allows a fresh email-only entry', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ session: session() }))
      .mockResolvedValueOnce(response({ message: 'AUTH_REQUIRED', code: '42501' }, 401))
      .mockResolvedValueOnce(response({ session: session('b') }));
    const api = new DeclaredIdentity(config, send);
    await api.identify({ email: 'listener@example.test', fullName: 'Иванов Иван Иванович' });
    expect((await api.rpc('dw_bootstrap', {})).error?.message).toBe('AUTH_REQUIRED');
    expect(localStorage.getItem('dw-entry-v1:identity.example.test')).toBeNull();
    const fresh = await api.identify({ email: 'listener@example.test' });
    expect('user' in fresh && fresh.user.id).toBe(session().user.id);
  });

  it('returns an unknown-email name step without storing a session or notifying login listeners', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(response({ profileRequired: true, email: 'new@example.test' }));
    const api = new DeclaredIdentity(config, send);
    const changed = vi.fn(); api.onChange(changed);
    expect(await api.identify({ email: ' New@Example.TEST ' })).toEqual({ profileRequired: true, email: 'new@example.test' });
    expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toEqual({ p_email: 'new@example.test' });
    expect(changed).not.toHaveBeenCalled();
    expect(localStorage.getItem('dw-entry-v1:identity.example.test')).toBeNull();
  });

  it('restores the saved name with an email-only request', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(response({ session: session() }));
    const api = new DeclaredIdentity(config, send);
    const result = await api.identify({ email: 'listener@example.test' });
    expect('user' in result && result.user.user_metadata?.full_name).toBe('Иванов Иван Иванович');
    expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toEqual({ p_email: 'listener@example.test' });
  });

  it('rejects a mismatched first-visit email rather than assigning a different profile', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(response({ profileRequired: true, email: 'different@example.test' }));
    await expect(new DeclaredIdentity(config, send).identify({ email: 'new@example.test' })).rejects.toThrow('некорректные сведения');
    expect(localStorage.getItem('dw-entry-v1:identity.example.test')).toBeNull();
  });

  it('does not restore a late login after logout', async () => {
    let complete!: (response: Response) => void;
    const send = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const api = new DeclaredIdentity(config, send);
    const pending = api.identify({ email: 'listener@example.test' });
    const rejected = expect(pending).rejects.toThrow('IDENTITY_CHANGED');
    await api.signOut();
    complete(response({ session: session() }));
    await rejected;
    expect(localStorage.getItem('dw-entry-v1:identity.example.test')).toBeNull();
  });
});
