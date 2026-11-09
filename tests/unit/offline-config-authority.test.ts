import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
describe('runtime authority for a portable build', () => {
  const local = { schemaVersion: 1, offline: true,
    offlineInstanceId: 'ec980a6d-941d-444f-a545-71229a2571a0',
    supabaseUrl: 'http://192.168.5.10:8787',
    supabasePublishableKey: 'sb_publishable_local_contract_fixture' };
  function prepare(runtime: unknown) {
    vi.resetModules();
    vi.stubGlobal('location', { origin: local.supabaseUrl, hostname: '192.168.5.10' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(runtime))));
    vi.stubEnv('VITE_SUPABASE_URL', 'https://configured-cloud.example');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_cloud_contract_fixture');
  }
  it('keeps all classroom requests local despite cloud settings embedded at build time', async () => {
    prepare(local);
    const { loadCloudConfiguration } = await import('../../apps/web/src/lib/cloud-config');
    expect((await loadCloudConfiguration()).config).toMatchObject({ offline: true, url: local.supabaseUrl });
  });
  it('does not silently switch to the cloud after an invalid local instance is received', async () => {
    prepare({ ...local, supabaseUrl: 'http://192.168.5.11:8787' });
    const { loadCloudConfiguration } = await import('../../apps/web/src/lib/cloud-config');
    const result = await loadCloudConfiguration();
    expect(result.config).toBeNull();
    expect(result.error).toContain('Локальный сервер');
  });
  it('retains the documented environment override for an ordinary online deployment', async () => {
    prepare({ ...local, offline: false, supabaseUrl: 'https://runtime-cloud.example' });
    const { loadCloudConfiguration } = await import('../../apps/web/src/lib/cloud-config');
    expect((await loadCloudConfiguration()).config?.url).toBe('https://configured-cloud.example');
  });
});
