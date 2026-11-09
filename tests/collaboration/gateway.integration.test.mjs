import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import {
  FIXTURE_IDENTITIES,
  FIXTURE_PUBLISHABLE_KEY,
  startFixtureGateway,
} from '../../scripts/test-collaboration-gateway.mjs';

const APP_ORIGIN = 'http://127.0.0.1:4173';
const adminSecret = randomBytes(32).toString('hex');
let gateway;

async function admin(path, body = {}) {
  const response = await fetch(`${gateway.url}/__test/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workshop-Test-Secret': adminSecret },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

function client() {
  return createClient(gateway.url, FIXTURE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `fixture-${randomUUID()}`,
    },
    global: { headers: { Origin: APP_ORIGIN } },
  });
}

async function signIn(email) {
  const sdk = client();
  const requested = await sdk.auth.signInWithOtp({ email });
  assert.equal(requested.error, null);
  assert.equal(requested.data.user, null);
  assert.equal(requested.data.session, null);
  const { token } = await admin('otp', { email });
  const verified = await sdk.auth.verifyOtp({ email, token, type: 'email' });
  assert.equal(verified.error, null);
  assert.equal(verified.data.user.id, FIXTURE_IDENTITIES[email].id);
  assert.ok(verified.data.session.access_token);
  return sdk;
}

async function rpc(sdk, name, args = {}) {
  const result = await sdk.rpc(name, args);
  assert.equal(result.error, null, `${name}: ${JSON.stringify(result.error)}`);
  assert.equal(result.data?.error, undefined, `${name}: ${JSON.stringify(result.data?.error)}`);
  return result.data;
}

async function rejected(sdk, name, args, pattern) {
  const result = await sdk.rpc(name, args);
  const error = result.error ?? result.data?.error;
  assert.ok(error, `${name} unexpectedly accepted an unauthorized/invalid request`);
  if (pattern) assert.match(`${error.code ?? ''} ${error.message ?? ''}`, pattern);
  return error;
}

async function profile(sdk, fullName) {
  return rpc(sdk, 'dw_save_profile', {
    p_operation_id: randomUUID(),
    p_expected_revision: 0,
    p_full_name: fullName,
  });
}

async function classroom() {
  const host = await signIn('teacher@workshop.test');
  const alice = await signIn('participant-a@workshop.test');
  await profile(host, 'Преподаватель испытания');
  await profile(alice, 'Участница испытания');
  const snapshot = await rpc(host, 'dw_create_session', {
    p_operation_id: randomUUID(),
    p_title: 'Проверка совместной работы',
    p_scope: 'municipality',
    p_region_id: 'respublika-mordoviia',
  });
  const invitation = await rpc(host, 'dw_invitation', { p_session_id: snapshot.session.id });
  await rpc(alice, 'dw_join_session', { p_operation_id: randomUUID(), p_code: invitation.code });
  return { host, alice, sessionId: snapshot.session.id, invitation };
}

async function realBundle(note = 'Учебная проверка канонической цитаты.') {
  const data = JSON.parse(
    await readFile(new URL('../../public/data/corpus/practices.json', import.meta.url), 'utf8'),
  );
  const document = JSON.parse(
    await readFile(
      new URL(
        '../../public/data/corpus/documents/regional-respublika-mordoviia.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const prepared = data.variants.find(
    (variant) => variant.id === 'mordovia-kindergarten-compensation',
  );
  const {
    id,
    familyId,
    regionId,
    title,
    mechanism,
    eligibility,
    amount,
    conditions,
    occurrenceIds,
    evidence,
    reviewStatus,
  } = prepared;
  const practice = {
    id,
    familyId,
    regionId,
    title,
    mechanism,
    eligibility,
    amount,
    conditions,
    occurrenceIds,
    evidence,
    reviewStatus,
  };
  const occurrences = data.occurrences
    .filter((occurrence) => occurrenceIds.includes(occurrence.id))
    .map(({ id, documentId, versionId, anchor, reviewStatus, note }) => ({
      id,
      documentId,
      versionId,
      anchor,
      reviewStatus,
      note,
    }));
  return {
    schemaVersion: 1,
    practice,
    occurrences,
    note,
    sources: [
      {
        sourceId: document.meta.id,
        editionId: document.version.id,
        title: document.meta.title,
        sha256: document.source.sha256,
        normalizationVersion: document.version.normalizationVersion,
        sourceUrl: document.version.sourceUrl,
        regionId: document.meta.regionId,
      },
    ],
  };
}

function publication(sessionId, bundle, extra = {}) {
  return {
    p_operation_id: randomUUID(),
    p_session_id: sessionId,
    p_local_key: 'local-recipient-review',
    p_expected_revision: null,
    p_bundle: bundle,
    ...extra,
  };
}

describe(
  'Real supabase-js HTTP contract against the shipped migration in PGlite',
  { concurrency: false },
  () => {
    before(async () => {
      process.env.WORKSHOP_TEST_GATEWAY = '1';
      gateway = await startFixtureGateway({ port: 0, appOrigin: APP_ORIGIN, adminSecret });
    });
    beforeEach(async () => {
      await admin('reset');
    });
    after(async () => {
      await gateway?.close();
    });

    it('verifies one-time email codes, refreshes identity, and refuses replay/forged bearer tokens', async () => {
      const sdk = client();
      const email = 'participant-a@workshop.test';
      assert.equal(
        (await sdk.auth.signInWithOtp({ email, options: { data: { role: 'host' } } })).error,
        null,
      );
      const { token } = await admin('otp', { email });
      const wrong = token === '000000' ? '111111' : '000000';
      assert.ok((await sdk.auth.verifyOtp({ email, token: wrong, type: 'email' })).error);
      const verified = await sdk.auth.verifyOtp({ email, token, type: 'email' });
      assert.equal(verified.error, null);
      assert.equal((await sdk.auth.getUser()).data.user.id, FIXTURE_IDENTITIES[email].id);
      assert.equal((await rpc(sdk, 'dw_bootstrap')).canCreateSession, false);
      assert.ok(
        (await client().auth.verifyOtp({ email, token, type: 'email' })).error,
        'An already consumed OTP must not be replayable',
      );
      const originalSession = verified.data.session;
      const refreshed = await sdk.auth.refreshSession();
      assert.equal(refreshed.error, null);
      assert.notEqual(refreshed.data.session.refresh_token, originalSession.refresh_token);
      assert.equal(refreshed.data.user.id, originalSession.user.id);

      const forgedParts = refreshed.data.session.access_token.split('.');
      const payload = JSON.parse(Buffer.from(forgedParts[1], 'base64url').toString());
      payload.sub = FIXTURE_IDENTITIES['teacher@workshop.test'].id;
      forgedParts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const forged = await fetch(`${gateway.url}/rest/v1/rpc/dw_bootstrap`, {
        method: 'POST',
        headers: {
          apikey: FIXTURE_PUBLISHABLE_KEY,
          authorization: `Bearer ${forgedParts.join('.')}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(forged.status, 401);
      const activeToken = refreshed.data.session.access_token;
      assert.equal((await sdk.auth.signOut()).error, null);
      const signedOut = await fetch(`${gateway.url}/auth/v1/user`, {
        headers: { apikey: FIXTURE_PUBLISHABLE_KEY, authorization: `Bearer ${activeToken}` },
      });
      assert.equal(signedOut.status, 401);
    });

    it('creates and joins a room, publishes exact real evidence, and persists it for another SDK client', async () => {
      const { host, alice, sessionId } = await classroom();
      assert.equal((await rpc(host, 'dw_bootstrap')).canCreateSession, true);
      await rejected(
        alice,
        'dw_create_session',
        {
          p_operation_id: randomUUID(),
          p_title: 'Чужое право',
          p_scope: 'region',
          p_region_id: 'respublika-mordoviia',
        },
        /FORBIDDEN/,
      );
      const bundle = await realBundle();
      const published = await rpc(alice, 'dw_publish_submission', publication(sessionId, bundle));
      assert.equal(published.submissions.length, 1);
      assert.equal(
        published.submissions[0].authorId,
        FIXTURE_IDENTITIES['participant-a@workshop.test'].id,
      );
      assert.equal(published.submissions[0].authorName, 'Участница испытания');
      const seen = await rpc(host, 'dw_session_snapshot', { p_session_id: sessionId });
      assert.deepEqual(seen.submissions[0].bundle, bundle);
      assert.equal(seen.members.length, 2);
      const cursor = await rpc(host, 'dw_session_cursor', { p_session_id: sessionId });
      assert.equal(typeof cursor, 'number');
      assert.equal(cursor, seen.cursor);
      assert.equal(JSON.stringify(seen).includes('@workshop.test'), false);
      const newClient = await signIn('participant-a@workshop.test');
      const reloaded = await rpc(newClient, 'dw_session_snapshot', { p_session_id: sessionId });
      assert.deepEqual(reloaded.submissions[0], seen.submissions[0]);
      assert.equal((await rpc(newClient, 'dw_bootstrap')).profile.fullName, 'Участница испытания');
    });

    it('enforces session isolation and author ownership even when a caller knows foreign IDs', async () => {
      const { host, alice, sessionId } = await classroom();
      const published = await rpc(
        alice,
        'dw_publish_submission',
        publication(sessionId, await realBundle()),
      );
      const first = published.submissions[0];
      const bob = await signIn('participant-b@workshop.test');
      await profile(bob, 'Другой участник');
      const second = await rpc(host, 'dw_create_session', {
        p_operation_id: randomUUID(),
        p_title: 'Другая сессия',
        p_scope: 'region',
        p_region_id: 'respublika-mordoviia',
      });
      const invitation = await rpc(host, 'dw_invitation', { p_session_id: second.session.id });
      await rpc(bob, 'dw_join_session', { p_operation_id: randomUUID(), p_code: invitation.code });
      await rejected(
        bob,
        'dw_session_snapshot',
        { p_session_id: sessionId },
        /FORBIDDEN|NOT_FOUND/,
      );
      await rejected(
        alice,
        'dw_session_snapshot',
        { p_session_id: second.session.id },
        /FORBIDDEN|NOT_FOUND/,
      );
      await rejected(
        bob,
        'dw_publish_submission',
        publication(sessionId, await realBundle('Попытка изменения')),
        /FORBIDDEN|NOT_FOUND/,
      );
      const firstInvite = await rpc(host, 'dw_invitation', { p_session_id: sessionId });
      await rpc(bob, 'dw_join_session', { p_operation_id: randomUUID(), p_code: firstInvite.code });
      await rejected(
        bob,
        'dw_moderate_submission',
        {
          p_operation_id: randomUUID(),
          p_session_id: sessionId,
          p_submission_id: first.id,
          p_expected_revision: first.revision,
          p_status: 'withdrawn',
        },
        /FORBIDDEN/,
      );
      await rejected(bob, 'dw_invitation', { p_session_id: sessionId }, /FORBIDDEN/);
      const unchanged = await rpc(host, 'dw_session_snapshot', { p_session_id: sessionId });
      assert.deepEqual(unchanged.submissions[0], first);
    });

    it('makes a repeated operation idempotent and rejects stale or contradictory revisions', async () => {
      const { host, alice, sessionId } = await classroom();
      const request = publication(sessionId, await realBundle());
      const initial = await rpc(alice, 'dw_publish_submission', request);
      const replay = await rpc(alice, 'dw_publish_submission', request);
      assert.deepEqual(replay, initial);
      await rejected(
        alice,
        'dw_publish_submission',
        { ...request, p_bundle: await realBundle('Иное содержание того же operation id') },
        /IDEMPOTENCY_CONFLICT/,
      );
      const revised = await rpc(
        alice,
        'dw_publish_submission',
        publication(sessionId, await realBundle('Редакция 2'), { p_expected_revision: 1 }),
      );
      assert.equal(revised.submissions[0].revision, 2);
      await rejected(
        alice,
        'dw_publish_submission',
        publication(sessionId, await realBundle('Устаревшая вкладка'), { p_expected_revision: 1 }),
        /REVISION_CONFLICT/,
      );
      const current = await rpc(host, 'dw_session_snapshot', { p_session_id: sessionId });
      assert.equal(current.submissions.length, 1);
      assert.equal(current.submissions[0].bundle.note, 'Редакция 2');
    });

    it('enforces the teacher pause, resume, and moderation on the SQL boundary', async () => {
      const { host, alice, sessionId } = await classroom();
      const current = await rpc(host, 'dw_session_snapshot', { p_session_id: sessionId });
      await rejected(
        alice,
        'dw_update_session',
        {
          p_operation_id: randomUUID(),
          p_session_id: sessionId,
          p_expected_revision: current.session.revision,
          p_patch: { status: 'paused' },
        },
        /FORBIDDEN/,
      );
      const paused = await rpc(host, 'dw_update_session', {
        p_operation_id: randomUUID(),
        p_session_id: sessionId,
        p_expected_revision: current.session.revision,
        p_patch: { status: 'paused' },
      });
      await rejected(
        alice,
        'dw_publish_submission',
        publication(sessionId, await realBundle()),
        /SESSION_NOT_OPEN/,
      );
      await rpc(host, 'dw_update_session', {
        p_operation_id: randomUUID(),
        p_session_id: sessionId,
        p_expected_revision: paused.session.revision,
        p_patch: { status: 'open' },
      });
      const published = await rpc(
        alice,
        'dw_publish_submission',
        publication(sessionId, await realBundle()),
      );
      const record = published.submissions[0];
      await rpc(host, 'dw_moderate_submission', {
        p_operation_id: randomUUID(),
        p_session_id: sessionId,
        p_submission_id: record.id,
        p_expected_revision: record.revision,
        p_status: 'withdrawn',
      });
      const final = await rpc(host, 'dw_session_snapshot', { p_session_id: sessionId });
      assert.equal(final.submissions[0].status, 'withdrawn');
    });

    it('rejects a changed quotation and an unregistered edition without storing a partial submission', async () => {
      const { host, alice, sessionId } = await classroom();
      const changed = await realBundle();
      const span = changed.occurrences[0].anchor.spans[0];
      span.exact = 'Х' + [...span.exact].slice(1).join('');
      await rejected(
        alice,
        'dw_publish_submission',
        publication(sessionId, changed),
        /SOURCE_MISMATCH/,
      );
      const unknown = await realBundle();
      unknown.sources[0].editionId += '-foreign';
      for (const occurrence of unknown.occurrences) {
        occurrence.versionId = unknown.sources[0].editionId;
        occurrence.anchor.versionId = unknown.sources[0].editionId;
      }
      await rejected(
        alice,
        'dw_publish_submission',
        publication(sessionId, unknown),
        /CORPUS_NOT_READY|SOURCE_MISMATCH/,
      );
      assert.equal(
        (await rpc(host, 'dw_session_snapshot', { p_session_id: sessionId })).submissions.length,
        0,
      );
    });

    it('keeps observer access read-only, revokes membership, and rotates admission codes', async () => {
      const { host, alice, sessionId, invitation } = await classroom();
      let snapshot = await rpc(host, 'dw_session_snapshot', { p_session_id: sessionId });
      const member = snapshot.members.find(
        (member) => member.userId === FIXTURE_IDENTITIES['participant-a@workshop.test'].id,
      );
      snapshot = await rpc(host, 'dw_set_member_role', {
        p_operation_id: randomUUID(),
        p_session_id: sessionId,
        p_member_id: member.userId,
        p_expected_revision: member.revision,
        p_role: 'observer',
      });
      assert.equal(
        (await rpc(alice, 'dw_session_snapshot', { p_session_id: sessionId })).session.role,
        'observer',
      );
      await rejected(
        alice,
        'dw_publish_submission',
        publication(sessionId, await realBundle()),
        /FORBIDDEN/,
      );
      const updated = snapshot.members.find((item) => item.userId === member.userId);
      await rpc(host, 'dw_revoke_member', {
        p_operation_id: randomUUID(),
        p_session_id: sessionId,
        p_member_id: member.userId,
        p_expected_revision: updated.revision,
      });
      await rejected(
        alice,
        'dw_session_snapshot',
        { p_session_id: sessionId },
        /FORBIDDEN|NOT_FOUND/,
      );
      await rpc(host, 'dw_rotate_invitation', {
        p_operation_id: randomUUID(),
        p_session_id: sessionId,
        p_expected_revision: invitation.revision,
      });
      const fresh = await rpc(host, 'dw_invitation', { p_session_id: sessionId });
      assert.notEqual(fresh.code, invitation.code);
      const bob = await signIn('participant-b@workshop.test');
      await profile(bob, 'Новый участник');
      await rejected(
        bob,
        'dw_join_session',
        { p_operation_id: randomUUID(), p_code: invitation.code },
        /INVALID_INVITATION/,
      );
      assert.equal(
        (await rpc(bob, 'dw_join_session', { p_operation_id: randomUUID(), p_code: fresh.code }))
          .session.id,
        sessionId,
      );
    });

    it('returns a dedicated projector DTO without email, membership IDs, or invitation secrets', async () => {
      const { host, alice, sessionId, invitation } = await classroom();
      await rpc(alice, 'dw_publish_submission', publication(sessionId, await realBundle()));
      const projection = await rpc(host, 'dw_projector_snapshot', { p_session_id: sessionId });
      // Host is intentionally excluded from the projected participant count.
      assert.equal(projection.participantCount, 1);
      assert.equal(projection.submissions.length, 1);
      assert.equal(projection.submissions[0].authorName, undefined);
      const serialized = JSON.stringify(projection);
      for (const secret of [
        '@workshop.test',
        invitation.code,
        FIXTURE_IDENTITIES['teacher@workshop.test'].id,
        FIXTURE_IDENTITIES['participant-a@workshop.test'].id,
      ]) {
        assert.equal(serialized.includes(secret), false, `Projection disclosed ${secret}`);
      }
      assert.equal(Object.hasOwn(projection, 'members'), false);
      await rejected(alice, 'dw_projector_snapshot', { p_session_id: sessionId }, /FORBIDDEN/);
    });

    it('limits CORS to the local app and keeps the OTP runner channel inaccessible to browser origins', async () => {
      const blocked = await fetch(`${gateway.url}/auth/v1/otp`, {
        method: 'POST',
        headers: {
          Origin: 'https://unrelated.example',
          apikey: FIXTURE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'teacher@workshop.test' }),
      });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.headers.has('access-control-allow-origin'), false);
      const preflight = await fetch(`${gateway.url}/auth/v1/otp`, {
        method: 'OPTIONS',
        headers: {
          Origin: APP_ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers':
            'apikey,authorization,content-profile,content-type,x-client-info',
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), APP_ORIGIN);
      const allowedHeaders = preflight.headers
        .get('access-control-allow-headers')
        .split(',')
        .map((value) => value.trim().toLowerCase());
      for (const required of [
        'apikey',
        'authorization',
        'content-profile',
        'content-type',
        'x-client-info',
      ])
        assert.ok(allowedHeaders.includes(required));
      const browserAdmin = await fetch(`${gateway.url}/__test/otp`, {
        method: 'POST',
        headers: {
          Origin: APP_ORIGIN,
          'X-Workshop-Test-Secret': adminSecret,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'teacher@workshop.test' }),
      });
      assert.equal(browserAdmin.status, 403);
      const sdk = client();
      assert.ok((await sdk.auth.signInWithOtp({ email: 'real-person@example.com' })).error);
      const rawTable = await fetch(`${gateway.url}/rest/v1/sessions`, {
        headers: { apikey: FIXTURE_PUBLISHABLE_KEY },
      });
      assert.equal(rawTable.status, 404);
    });
  },
);
