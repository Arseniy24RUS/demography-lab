import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import {
  FIXTURE_IDENTITIES,
  FIXTURE_PUBLISHABLE_KEY,
  startFixtureGateway,
} from '../../scripts/test-collaboration-gateway.mjs';

export const APP_ORIGIN = 'http://127.0.0.1:4173';

export async function successfulRpc(sdk, name, args = {}) {
  const result = await sdk.rpc(name, args);
  assert.equal(result.error, null, `${name}: ${JSON.stringify(result.error)}`);
  assert.equal(result.data?.error, undefined, `${name}: ${JSON.stringify(result.data?.error)}`);
  return result.data;
}

export async function rejectedRpc(sdk, name, args = {}, pattern) {
  const result = await sdk.rpc(name, args);
  const error = result.error ?? result.data?.error;
  assert.ok(error, `${name} unexpectedly accepted the request`);
  if (pattern) assert.match(`${error.code ?? ''} ${error.message ?? ''}`, pattern);
  return error;
}

export async function startWorkshopHarness() {
  process.env.WORKSHOP_TEST_GATEWAY = '1';
  const secret = randomBytes(32).toString('hex');
  const gateway = await startFixtureGateway({ port: 0, appOrigin: APP_ORIGIN, adminSecret: secret });

  async function admin(path, body = {}) {
    const response = await fetch(`${gateway.url}/__test/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workshop-Test-Secret': secret },
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
        storageKey: `stage-three-fixture-${randomUUID()}`,
      },
      global: { headers: { Origin: APP_ORIGIN } },
    });
  }

  async function signIn(email, fullName) {
    const sdk = client();
    assert.equal((await sdk.auth.signInWithOtp({ email })).error, null);
    const { token } = await admin('otp', { email });
    const verified = await sdk.auth.verifyOtp({ email, token, type: 'email' });
    assert.equal(verified.error, null);
    assert.equal(verified.data.user.id, FIXTURE_IDENTITIES[email].id);
    if (fullName) await successfulRpc(sdk, 'dw_save_profile', {
      p_operation_id: randomUUID(), p_expected_revision: 0, p_full_name: fullName,
    });
    return sdk;
  }

  async function classroom({ includeBob = false, includeObserver = false } = {}) {
    const host = await signIn('teacher@workshop.test', 'Преподаватель испытательного занятия');
    const alice = await signIn('participant-a@workshop.test', 'Участница первой команды');
    const session = await successfulRpc(host, 'dw_create_session', {
      p_operation_id: randomUUID(), p_title: 'Региональные практики · проверка этапа 3',
      p_scope: 'region', p_region_id: 'respublika-mordoviia',
    });
    const sessionId = session.session.id;
    const invitation = await successfulRpc(host, 'dw_invitation', { p_session_id: sessionId });
    const join = (sdk) => successfulRpc(sdk, 'dw_join_session', {
      p_operation_id: randomUUID(), p_code: invitation.code,
    });
    await join(alice);
    const result = { host, alice, sessionId, invitation };
    if (includeBob) {
      result.bob = await signIn('participant-b@workshop.test', 'Участник второй команды');
      await join(result.bob);
    }
    if (includeObserver) {
      result.observer = await signIn('observer@workshop.test', 'Наблюдатель испытания');
      const joined = await join(result.observer);
      const member = joined.members.find((entry) => entry.userId === FIXTURE_IDENTITIES['observer@workshop.test'].id);
      await successfulRpc(host, 'dw_set_member_role', {
        p_operation_id: randomUUID(), p_session_id: sessionId, p_member_id: member.userId,
        p_expected_revision: member.revision, p_role: 'observer',
      });
    }
    return result;
  }

  return { gateway, admin, client, signIn, classroom, reset: () => admin('reset'), close: () => gateway.close() };
}

/** Exact prepared source data, with catalogue-only metadata deliberately omitted. */
export async function realPracticeBundle(practiceId, note = 'Практика для проверки семейства и оценивания.') {
  const prepared = JSON.parse(await readFile(new URL('../../public/data/corpus/practices.json', import.meta.url), 'utf8'));
  const variant = prepared.variants.find((entry) => entry.id === practiceId);
  assert.ok(variant, `Prepared practice ${practiceId} does not exist`);
  const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  const practice = pick(variant, ['id', 'familyId', 'regionId', 'title', 'mechanism', 'eligibility', 'amount', 'conditions', 'occurrenceIds', 'evidence', 'reviewStatus']);
  const occurrences = prepared.occurrences.filter((entry) => variant.occurrenceIds.includes(entry.id))
    .map((entry) => pick(entry, ['id', 'documentId', 'versionId', 'anchor', 'reviewStatus', 'note']));
  const documents = await Promise.all([...new Set(occurrences.map((entry) => entry.documentId))].map(async (id) =>
    JSON.parse(await readFile(new URL(`../../public/data/corpus/documents/${id}.json`, import.meta.url), 'utf8'))));
  return {
    schemaVersion: 1, practice, occurrences, note,
    sources: documents.map((document) => ({
      sourceId: document.meta.id, editionId: document.version.id, title: document.meta.title,
      sha256: document.source.sha256, normalizationVersion: document.version.normalizationVersion,
      sourceUrl: document.version.sourceUrl, regionId: document.meta.regionId,
    })),
  };
}

export async function publishPrepared(sdk, sessionId, practiceId, overrides = {}) {
  const bundle = await realPracticeBundle(practiceId);
  const snapshot = await successfulRpc(sdk, 'dw_publish_submission', {
    p_operation_id: randomUUID(), p_session_id: sessionId, p_local_key: `prepared-${practiceId}`,
    p_expected_revision: null, p_bundle: bundle, ...overrides,
  });
  const submission = snapshot.submissions.find((item) => item.bundle.practice.id === practiceId && item.status === 'shared');
  assert.ok(submission, 'The published variant was not returned');
  return { snapshot, submission, bundle };
}
