import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { randomSecret, randomUuid, sha256Hex } from '../../packages/security/crypto.mjs';
import { validateCloudConfiguration } from '../../apps/web/src/lib/cloud-config';
import { localShareUrl } from '../../apps/web/src/lib/offline-share';
import { isLocalNetworkHost } from '../../apps/web/src/lib/local-network';

afterEach(() => vi.unstubAllGlobals());
describe('real HTTP LAN browser contracts', () => {
  it('retains SHA-256 identity when secure-context Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    for (const value of ['', 'abc', 'Саранск: 0 ≠ null; рождаемость 👪', 'я'.repeat(150000)]) {
      const expected = createHash('sha256').update(value).digest('hex');
      expect(await sha256Hex(new TextEncoder().encode(value))).toBe(expected);
    }
    const ids = new Set(Array.from({ length: 1000 }, randomUuid));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u);
    expect(randomSecret()).toMatch(/^[a-f\d]{64}$/u);
  });
  it('never falls back to non-cryptographic randomness', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => randomSecret()).toThrow('безопасный генератор');
    expect(() => randomUuid()).toThrow('безопасный генератор');
  });
  const raw = { schemaVersion: 1, supabaseUrl: 'http://192.168.5.10:8787',
    supabasePublishableKey: 'sb_publishable_local_contract_fixture', offline: true,
    offlineInstanceId: 'ec980a6d-941d-444f-a545-71229a2571a0',
    offlineAuthUrl: 'http://192.168.5.10:8787', realtime: true,
    surveyUrl: 'http://192.168.5.10:8788/survey.html', classroomOrigin: 'http://192.168.5.10:8787' };
  it('accepts explicitly local same-origin API and isolated anonymous port', () => {
    const result = validateCloudConfiguration(raw, false, raw.supabaseUrl);
    expect(result.error).toBeNull();
    expect(result.config).toMatchObject({ offline: true, realtime: false, pollInterval: 2000, surveyError: null });
  });
  it('does not relax online HTTPS, cross-origin endpoints or survey separation', () => {
    expect(validateCloudConfiguration({ ...raw, offline: false }, false, raw.supabaseUrl).config).toBeNull();
    expect(validateCloudConfiguration(raw, false, 'http://192.168.5.11:8787').config).toBeNull();
    expect(validateCloudConfiguration({ ...raw, offlineAuthUrl: 'https://attacker.example' }, false, raw.supabaseUrl).config).toBeNull();
    expect(validateCloudConfiguration({ ...raw, surveyUrl: `${raw.supabaseUrl}/survey.html` }, false, raw.supabaseUrl).config?.survey).toBeNull();
    expect(validateCloudConfiguration({ ...raw, surveyUrl: 'http://192.168.5.11:8788/survey.html' }, false, raw.supabaseUrl).config?.survey).toBeNull();
  });
  it('rewrites only invitation delivery while retaining distinct survey port and secret fragment', () => {
    const address = { host: '192.168.5.10', joinCode: 'ABCD1234' };
    expect(localShareUrl('http://127.0.0.1:8788/survey.html#survey=id&invite=secret', address))
      .toBe('http://192.168.5.10:8788/survey.html#survey=id&invite=secret');
    const classroom = new URL(localShareUrl('http://127.0.0.1:8787/?join=SESSION', address, true));
    expect(classroom.searchParams.get('join')).toBe('SESSION');
    expect(new URLSearchParams(classroom.hash.slice(1)).get('network')).toBe('ABCD1234');
    expect(() => localShareUrl('https://external.example/', address)).toThrow();
  });
  it.each(['8.8.8.8', '192.168.999.1', '192.169.1.1', '172.32.1.1', '127.0.0.1.attacker.com'])('rejects nonlocal hostname %s', (host) => {
    expect(isLocalNetworkHost(host)).toBe(false);
  });
});
