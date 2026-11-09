import { describe, expect, it } from 'vitest';
import { validateCloudConfiguration } from '../../apps/web/src/lib/cloud-config';

describe('public Supabase configuration boundary', () => {
  const key = 'sb_publishable_documented_public_fixture';
  it('leaves local work available until a project is configured', () => {
    expect(
      validateCloudConfiguration({ schemaVersion: 1, supabaseUrl: '', supabasePublishableKey: '' }),
    ).toEqual({ config: null, error: null });
  });
  it('permits a secure configured origin and selects bounded reconciliation', () => {
    expect(
      validateCloudConfiguration({
        schemaVersion: 1,
        supabaseUrl: 'https://example.supabase.co',
        supabasePublishableKey: key,
      }).config,
    ).toMatchObject({
      url: 'https://example.supabase.co',
      realtime: true,
      testEnvironment: false,
      pollInterval: 8000,
    });
  });
  it.each([
    'http://example.com',
    'https://user:password@example.com',
    'https://example.com/path',
    'https://example.com/?key=1',
    'https://example.com/#x',
    'javascript:alert(1)',
  ])('rejects unsafe endpoint %s', (url) => {
    expect(
      validateCloudConfiguration({
        schemaVersion: 1,
        supabaseUrl: url,
        supabasePublishableKey: key,
      }).error,
    ).not.toBeNull();
  });
  it('rejects secret and service-role keys before creating a client', () => {
    for (const secret of [
      'sb_secret_abc12345678901234567890',
      `x.${btoa(JSON.stringify({ role: 'service_role' }))}.y`,
    ]) {
      expect(
        validateCloudConfiguration({
          schemaVersion: 1,
          supabaseUrl: 'https://example.com',
          supabasePublishableKey: secret,
        }).config,
      ).toBeNull();
    }
  });
  it('allows loopback HTTP for the explicitly marked local integration test', () => {
    expect(
      validateCloudConfiguration(
        {
          schemaVersion: 1,
          supabaseUrl: 'http://127.0.0.1:54321',
          supabasePublishableKey: key,
          realtime: false,
        },
        true,
      ).config,
    ).toMatchObject({ testEnvironment: true, realtime: false, pollInterval: 1000 });
  });
});
