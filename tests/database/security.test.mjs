import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestDatabase, seedAuthUser, seedCanonicalDocument, loadMordovia, callRpc, asUser, projectRoot } from './harness.mjs';

let db; let document; let originalBundle;
const uuid = () => randomUUID();
const copy = (v) => structuredClone(v);
const rpc = (user, name, args) => callRpc(db, user, name, args);
const expectCode = (promise, code) => assert.rejects(promise, (e) => e.code === 'P0001' && e.message === code);
const expectPermission = (promise) => assert.rejects(promise, (e) => e.code === '42501');

before(async () => {
  db = await createTestDatabase();
  document = await loadMordovia();
  const corpus = JSON.parse(await readFile(resolve(projectRoot, 'public/data/corpus/practices.json'), 'utf8'));
  const raw = corpus.variants.find((x) => x.id === 'mordovia-kindergarten-compensation');
  const practiceKeys = ['id','familyId','regionId','title','mechanism','eligibility','amount','conditions','occurrenceIds','evidence','reviewStatus'];
  const practice = Object.fromEntries(practiceKeys.filter((k) => k in raw).map((k) => [k, raw[k]]));
  const occurrenceKeys = ['id','documentId','versionId','anchor','reviewStatus','note'];
  const occurrences = corpus.occurrences.filter((o) => raw.occurrenceIds.includes(o.id))
    .map((o) => Object.fromEntries(occurrenceKeys.filter((k) => k in o).map((k) => [k, o[k]])));
  originalBundle = { schemaVersion: 1, practice, occurrences, sources: [{ sourceId: document.meta.id,
    editionId: document.version.id, title: document.meta.title, sha256: document.version.sourceSha256,
    normalizationVersion: document.version.normalizationVersion, sourceUrl: document.version.sourceUrl,
    regionId: document.meta.regionId }], note: 'Учебный разбор сохранённой редакции; не заключение об эффективности.' };
});
after(async () => { await db?.close(); });

async function user(options = {}) {
  const id = uuid();
  await seedAuthUser(db, { id, email: `${id}@example.invalid`, ...options });
  return id;
}
async function profile(id, name = 'Участник тестовой сессии') {
  return rpc(id, 'dw_save_profile', { p_operation_id: uuid(), p_expected_revision: 0, p_full_name: name });
}
async function setup({ join = true, scope = 'municipality' } = {}) {
  const host = await user(); const alice = await user(); const bob = await user();
  await profile(host, 'Преподаватель'); await profile(alice, 'Участник А'); await profile(bob, 'Участник Б');
  await db.query('insert into private.facilitators(user_id) values($1)', [host]);
  const snapshot = await rpc(host, 'dw_create_session', { p_operation_id: uuid(), p_title: 'Методическая мастерская',
    p_scope: scope, p_region_id: scope === 'federal' ? null : 'respublika-mordoviia' });
  const sessionId = snapshot.session.id;
  const invitation = await rpc(host, 'dw_invitation', { p_session_id: sessionId });
  if (join) {
    await rpc(alice, 'dw_join_session', { p_operation_id: uuid(), p_code: invitation.code });
    await rpc(bob, 'dw_join_session', { p_operation_id: uuid(), p_code: invitation.code });
  }
  return { host, alice, bob, sessionId, invitation, snapshot };
}
const publish = (who, sid, bundle = copy(originalBundle), options = {}) => rpc(who, 'dw_publish_submission', {
  p_operation_id: uuid(), p_session_id: sid, p_local_key: bundle.practice.id, p_expected_revision: null,
  p_bundle: bundle, ...options,
});
const patch = async (env, value) => {
  const snapshot = await rpc(env.host, 'dw_session_snapshot', { p_session_id: env.sessionId });
  return rpc(env.host, 'dw_update_session', { p_operation_id: uuid(), p_session_id: env.sessionId,
    p_expected_revision: snapshot.session.revision, p_patch: value });
};

describe('Actual PostgreSQL authentication and authorization', { concurrency: false }, () => {
  it('requires a current verified non-anonymous auth.users record, not user_metadata', async () => {
    await expectCode(rpc(null, 'dw_bootstrap', {}), 'AUTH_REQUIRED');
    const unconfirmed = await user({ confirmed: false, metadata: { role: 'host', email_verified: true } });
    await expectCode(rpc(unconfirmed, 'dw_bootstrap', {}), 'EMAIL_NOT_VERIFIED');
    const anonymous = await user({ isAnonymous: true });
    await expectCode(rpc(anonymous, 'dw_bootstrap', {}), 'EMAIL_NOT_VERIFIED');
    await expectCode(rpc(uuid(), 'dw_bootstrap', {}), 'EMAIL_NOT_VERIFIED');
    const impostor = await user({ metadata: { role: 'host', canCreateSession: true } });
    await profile(impostor);
    await expectCode(rpc(impostor, 'dw_create_session', { p_operation_id: uuid(), p_title: 'Захват роли', p_scope: 'federal', p_region_id: null }), 'FORBIDDEN');
    assert.equal((await rpc(impostor, 'dw_bootstrap', {})).canCreateSession, false);
  });

  it('bootstraps a first login before a profile exists; profile writes use revision and idempotency', async () => {
    const id = await user();
    assert.deepEqual(await rpc(id, 'dw_bootstrap', {}), { profile: null, canCreateSession: false, sessions: [] });
    const op = uuid();
    const args = { p_operation_id: op, p_expected_revision: 0, p_full_name: '  Имя Фамилия  ' };
    const saved = await rpc(id, 'dw_save_profile', args);
    assert.deepEqual(saved, { userId: id, fullName: 'Имя Фамилия', revision: 1 });
    assert.deepEqual(await rpc(id, 'dw_save_profile', args), saved);
    await expectCode(rpc(id, 'dw_save_profile', { ...args, p_full_name: 'Другое имя' }), 'IDEMPOTENCY_CONFLICT');
    await expectCode(profile(id), 'REVISION_CONFLICT');
    const updated = await rpc(id, 'dw_save_profile', { p_operation_id: uuid(), p_expected_revision: 1, p_full_name: 'Новое имя' });
    assert.equal(updated.revision, 2);
    await expectCode(rpc(id, 'dw_save_profile', { p_operation_id: uuid(), p_expected_revision: 2, p_full_name: '\u0001' }), 'INVALID_INPUT');
    await expectCode(rpc(id, 'dw_save_profile', { p_operation_id: uuid(), p_expected_revision: null, p_full_name: 'Имя' }), 'INVALID_INPUT');
  });

  it('creates all three scopes only for an explicitly whitelisted facilitator with a profile', async () => {
    const noProfile = await user();
    await db.query('insert into private.facilitators(user_id) values($1)', [noProfile]);
    await expectCode(rpc(noProfile, 'dw_create_session', { p_operation_id: uuid(), p_title: 'Сессия', p_scope: 'region', p_region_id: 'respublika-mordoviia' }), 'PROFILE_REQUIRED');
    await profile(noProfile);
    for (const scope of ['municipality', 'region', 'federal']) {
      const args = { p_operation_id: uuid(), p_title: 'Территориальная сессия', p_scope: scope, p_region_id: scope === 'federal' ? null : 'respublika-mordoviia' };
      const created = await rpc(noProfile, 'dw_create_session', args);
      const replay = await rpc(noProfile, 'dw_create_session', args);
      assert.equal(replay.session.id, created.session.id);
      assert.equal(created.members.length, 1);
      assert.equal(created.members[0].role, 'host');
      assert.equal(created.members[0].revision, 1);
    }
    await expectCode(rpc(noProfile, 'dw_create_session', { p_operation_id: uuid(), p_title: 'Сессия', p_scope: 'municipality', p_region_id: null }), 'INVALID_INPUT');
  });

  it('enforces session RLS, profile privacy and no direct client writes to protected tables', async () => {
    const e = await setup(); const outsider = await user(); await profile(outsider);
    const theirs = await asUser(db, outsider, (tx) => tx.query('select * from public.dw_sessions'));
    assert.equal(theirs.rows.length, 0);
    assert.equal((await asUser(db, outsider, (tx) => tx.query('select * from public.dw_memberships'))).rows.length, 0);
    assert.equal((await asUser(db, outsider, (tx) => tx.query('select * from public.dw_profiles'))).rows.length, 1);
    await expectCode(rpc(outsider, 'dw_session_snapshot', { p_session_id: e.sessionId }), 'FORBIDDEN');
    await expectPermission(asUser(db, e.alice, (tx) => tx.query('select * from private.invitations')));
    await expectPermission(asUser(db, e.alice, (tx) => tx.query('select * from private.source_blocks')));
    await expectPermission(asUser(db, e.alice, (tx) => tx.query("update public.dw_memberships set role='host' where user_id=$1", [e.alice])));
    await expectPermission(asUser(db, e.alice, (tx) => tx.query("insert into private.facilitators(user_id) values($1)", [e.alice])));
    await expectPermission(asUser(db, e.alice, (tx) => tx.query("delete from public.dw_sessions where id=$1", [e.sessionId])));
    const snapshot = await rpc(e.alice, 'dw_session_snapshot', { p_session_id: e.sessionId });
    assert.equal(snapshot.session.role, 'participant');
    assert.equal(snapshot.members.length, 3);
    assert.ok(!JSON.stringify(snapshot).includes('@example.invalid'));
    assert.ok(!JSON.stringify(snapshot).includes(e.invitation.code));
    await expectCode(rpc(e.alice, 'dw_invitation', { p_session_id: e.sessionId }), 'FORBIDDEN');
  });

  it('commits failed invitation attempts, replays failures once and blocks brute-force per verified account', async () => {
    const id = await user(); await profile(id);
    const args = { p_operation_id: uuid(), p_code: '000000000000' };
    assert.equal((await rpc(id, 'dw_join_session', args)).error.code, 'INVALID_INVITATION');
    assert.equal((await rpc(id, 'dw_join_session', args)).error.code, 'INVALID_INVITATION');
    await expectCode(rpc(id, 'dw_join_session', { ...args, p_code: '111111111111' }), 'IDEMPOTENCY_CONFLICT');
    for (let n = 0; n < 7; n++) {
      assert.equal((await rpc(id, 'dw_join_session', { p_operation_id: uuid(), p_code: 'AAAAAAAAAAAA' })).error.code, 'INVALID_INVITATION');
    }
    const limit = await rpc(id, 'dw_join_session', { p_operation_id: uuid(), p_code: 'BBBBBBBBBBBB' });
    assert.equal(limit.error.code, 'RATE_LIMITED');
    assert.ok(limit.error.retryAfterSeconds > 0 && limit.error.retryAfterSeconds <= 600);
    assert.equal((await db.query('select attempts from private.join_attempts where user_id=$1', [id])).rows[0].attempts, 8);
    await db.query("update private.join_attempts set window_started=now()-interval '11 minutes' where user_id=$1", [id]);
    assert.equal((await rpc(id, 'dw_join_session', { p_operation_id: uuid(), p_code: 'BBBBBBBBBBBB' })).error.code, 'INVALID_INVITATION');
  });

  it('honors invitation rotation, join gate and stale control revisions', async () => {
    const e = await setup({ join: false });
    assert.match(e.invitation.code, /^[A-F0-9]{12}$/);
    const rotated = await rpc(e.host, 'dw_rotate_invitation', { p_operation_id: uuid(), p_session_id: e.sessionId, p_expected_revision: e.invitation.revision });
    const code = await rpc(e.host, 'dw_invitation', { p_session_id: e.sessionId });
    assert.notEqual(code.code, e.invitation.code);
    assert.equal((await rpc(e.alice, 'dw_join_session', { p_operation_id: uuid(), p_code: e.invitation.code })).error.code, 'INVALID_INVITATION');
    const joined = await rpc(e.alice, 'dw_join_session', { p_operation_id: uuid(), p_code: code.code.toLowerCase().slice(0, 6) + '-' + code.code.slice(6) });
    assert.equal(joined.session.role, 'participant');
    await expectCode(rpc(e.host, 'dw_update_session', { p_operation_id: uuid(), p_session_id: e.sessionId, p_expected_revision: rotated.session.revision - 1, p_patch: { phase: 'review' } }), 'REVISION_CONFLICT');
    await patch(e, { joinOpen: false });
    assert.equal((await rpc(e.bob, 'dw_join_session', { p_operation_id: uuid(), p_code: code.code })).error.code, 'JOIN_CLOSED');
    await patch(e, { joinOpen: true, status: 'paused' });
    assert.equal((await rpc(e.bob, 'dw_join_session', { p_operation_id: uuid(), p_code: code.code })).session.status, 'paused');
  });
});

describe('Canonical quotations, authorship and conflict handling', { concurrency: false }, () => {
  it('publishes actual Mordovia fragments, supplies author identity, and replaces untrusted bibliographic metadata', async () => {
    const e = await setup(); const bundle = copy(originalBundle);
    bundle.sources[0].title = 'Попытка подменить библиографическое описание';
    bundle.sources[0].sourceUrl = 'https://example.invalid/untrusted';
    const result = await publish(e.alice, e.sessionId, bundle);
    assert.equal(result.submissions.length, 1);
    const s = result.submissions[0];
    assert.equal(s.authorId, e.alice); assert.equal(s.authorName, 'Участник А');
    assert.equal(s.bundle.sources[0].title, document.meta.title);
    assert.equal(s.bundle.sources[0].sourceUrl, document.version.sourceUrl);
    assert.equal(s.bundle.occurrences[0].reviewStatus, 'candidate');
    assert.deepEqual(s.bundle.occurrences[0].anchor, originalBundle.occurrences[0].anchor);
    assert.equal((await rpc(e.bob, 'dw_session_snapshot', { p_session_id: e.sessionId })).submissions[0].id, s.id);
  });

  it('rejects same-length quote substitution, forged context, offsets, source hashes and editions', async () => {
    const e = await setup();
    const mutations = [
      [(b) => { const s = b.occurrences[0].anchor.spans[0]; s.exact = '9' + s.exact.slice(1); }, 'SOURCE_MISMATCH'],
      [(b) => { b.occurrences[0].anchor.spans[0].prefix = 'xxxxxx'; }, 'SOURCE_MISMATCH'],
      [(b) => { const s = b.occurrences[0].anchor.spans[0]; s.start++; s.end++; }, 'SOURCE_MISMATCH'],
      [(b) => { b.sources[0].sha256 = '0'.repeat(64); }, 'SOURCE_MISMATCH'],
      [(b) => { delete b.sources[0].sha256; }, 'SOURCE_MISMATCH'],
      [(b) => { b.sources[0].editionId += '-missing'; }, 'CORPUS_NOT_READY'],
      [(b) => { b.practice.regionId = 'another-region'; }, 'SOURCE_MISMATCH'],
      [(b) => { b.occurrences[0].anchor.normalizationVersion = 'poppler-layout-nfc-lf-rstrip-lines-blank-paragraphs-v1'; }, 'SOURCE_MISMATCH'],
      [(b) => { b.occurrences[0].anchor.spans[0].blockId = document.version.blocks[0].id; }, 'SOURCE_MISMATCH'],
    ];
    for (const [mutate, code] of mutations) {
      const b = copy(originalBundle); mutate(b); await expectCode(publish(e.alice, e.sessionId, b), code);
    }
    assert.equal((await rpc(e.host, 'dw_session_snapshot', { p_session_id: e.sessionId })).submissions.length, 0);
  });

  it('rejects duplicate/out-of-order spans and broken occurrence/evidence references', async () => {
    const e = await setup();
    let b = copy(originalBundle);
    b.occurrences[0].anchor.spans.push(copy(b.occurrences[0].anchor.spans[0]));
    await expectCode(publish(e.alice, e.sessionId, b), 'SOURCE_MISMATCH');
    b = copy(originalBundle); b.practice.occurrenceIds.push('missing-occurrence');
    await expectCode(publish(e.alice, e.sessionId, b), 'INVALID_INPUT');
    b = copy(originalBundle); b.practice.evidence[0].occurrenceId = 'missing-occurrence';
    await expectCode(publish(e.alice, e.sessionId, b), 'INVALID_INPUT');
    b = copy(originalBundle); b.occurrences.push(copy(b.occurrences[0]));
    await expectCode(publish(e.alice, e.sessionId, b), 'INVALID_INPUT');
  });

  it('refuses unversioned field confirmations after the reviewed value changed', async () => {
    const e = await setup(); const b = copy(originalBundle);
    b.practice.evidence[0].reviewStatus = 'verified';
    const valid = copy(b); b.practice.title += ' — изменено';
    await expectCode(publish(e.alice, e.sessionId, b), 'INVALID_INPUT');
    const result = await publish(e.alice, e.sessionId, valid);
    assert.equal(result.submissions[0].bundle.practice.evidence[0].reviewStatus, 'verified');
    assert.equal(result.submissions[0].bundle.practice.evidence[0].reviewedValue, valid.practice.title);
  });

  it('rejects unexpected object fields and malformed arrays with stable validation errors', async () => {
    const e = await setup();
    const malformed = [null, [], {}, { ...copy(originalBundle), authorId: e.host }, { ...copy(originalBundle), practice: [] },
      { ...copy(originalBundle), occurrences: [null] }, { ...copy(originalBundle), sources: [42] },
      { ...copy(originalBundle), note: '\u0001private' }];
    for (const value of malformed) {
      await expectCode(rpc(e.alice, 'dw_publish_submission', { p_operation_id: uuid(), p_session_id: e.sessionId,
        p_local_key: 'invalid', p_expected_revision: null, p_bundle: value }), 'INVALID_INPUT');
    }
  });

  it('applies an operation only once while its replay returns the current monotonically newer snapshot', async () => {
    const e = await setup(); const op = uuid();
    const first = await publish(e.alice, e.sessionId, copy(originalBundle), { p_operation_id: op });
    const other = await publish(e.bob, e.sessionId);
    const replay = await publish(e.alice, e.sessionId, copy(originalBundle), { p_operation_id: op });
    assert.equal(replay.submissions.length, 2);
    assert.equal(replay.cursor, other.cursor);
    assert.equal(replay.submissions.find((s) => s.authorId === e.alice).revision, 1);
    assert.ok(replay.cursor > first.cursor);
    const changed = copy(originalBundle); changed.note = 'Другой запрос';
    await expectCode(publish(e.alice, e.sessionId, changed, { p_operation_id: op }), 'IDEMPOTENCY_CONFLICT');
    assert.equal((await db.query('select count(*)::int n from private.audit_events where operation_id=$1', [op])).rows[0].n, 1);
    assert.equal((await db.query('select count(*)::int n from private.command_receipts where operation_id=$1', [op])).rows[0].n, 1);
  });

  it('detects stale concurrent revisions without overwriting another confirmed edit', async () => {
    const e = await setup(); await publish(e.alice, e.sessionId);
    const a = copy(originalBundle); a.note = 'Редакция с устройства А';
    const b = copy(originalBundle); b.note = 'Редакция с устройства Б';
    const updated = await publish(e.alice, e.sessionId, a, { p_expected_revision: 1 });
    assert.equal(updated.submissions[0].revision, 2);
    await expectCode(publish(e.alice, e.sessionId, b, { p_expected_revision: 1 }), 'REVISION_CONFLICT');
    await expectCode(publish(e.bob, e.sessionId, b, { p_expected_revision: 2 }), 'REVISION_CONFLICT');
    assert.equal((await rpc(e.host, 'dw_session_snapshot', { p_session_id: e.sessionId })).submissions[0].bundle.note, a.note);
  });

  it('checks pause, discussion and closure on the server; successful replay after closure is read-only', async () => {
    const e = await setup(); const op = uuid();
    await publish(e.alice, e.sessionId, copy(originalBundle), { p_operation_id: op });
    await patch(e, { status: 'paused' });
    await expectCode(publish(e.bob, e.sessionId), 'SESSION_NOT_OPEN');
    await patch(e, { status: 'open', phase: 'discussion' });
    await expectCode(publish(e.bob, e.sessionId), 'PHASE_CLOSED');
    await patch(e, { status: 'closed' });
    await expectCode(publish(e.bob, e.sessionId), 'SESSION_NOT_OPEN');
    const replay = await publish(e.alice, e.sessionId, copy(originalBundle), { p_operation_id: op });
    assert.equal(replay.session.status, 'closed');
    assert.equal(replay.submissions[0].revision, 1);
  });
});

describe('Moderation, roles, source integrity and projector isolation', { concurrency: false }, () => {
  it('enforces observer read-only and immediately revokes membership despite a still-valid token', async () => {
    const e = await setup();
    await rpc(e.host, 'dw_set_member_role', { p_operation_id: uuid(), p_session_id: e.sessionId, p_member_id: e.alice, p_expected_revision: 1, p_role: 'observer' });
    assert.equal((await rpc(e.alice, 'dw_session_snapshot', { p_session_id: e.sessionId })).session.role, 'observer');
    await expectCode(publish(e.alice, e.sessionId), 'FORBIDDEN');
    await expectCode(rpc(e.alice, 'dw_update_session', { p_operation_id: uuid(), p_session_id: e.sessionId, p_expected_revision: 1, p_patch: { status: 'closed' } }), 'FORBIDDEN');
    await expectCode(rpc(e.host, 'dw_set_member_role', { p_operation_id: uuid(), p_session_id: e.sessionId, p_member_id: e.alice, p_expected_revision: 2, p_role: 'host' }), 'INVALID_INPUT');
    await expectCode(rpc(e.host, 'dw_revoke_member', { p_operation_id: uuid(), p_session_id: e.sessionId, p_member_id: e.host, p_expected_revision: 1 }), 'FORBIDDEN');
    await rpc(e.host, 'dw_revoke_member', { p_operation_id: uuid(), p_session_id: e.sessionId, p_member_id: e.alice, p_expected_revision: 2 });
    await expectCode(rpc(e.alice, 'dw_session_snapshot', { p_session_id: e.sessionId }), 'FORBIDDEN');
    assert.equal((await asUser(db, e.alice, (tx) => tx.query('select * from public.dw_sessions where id=$1', [e.sessionId]))).rows.length, 0);
    assert.equal((await rpc(e.alice, 'dw_join_session', { p_operation_id: uuid(), p_code: e.invitation.code })).error.code, 'FORBIDDEN');
  });

  it('keeps withdrawn evidence for its author/host while hiding it from colleagues and projector', async () => {
    const e = await setup(); const first = await publish(e.alice, e.sessionId); const s = first.submissions[0];
    await patch(e, { focusSubmissionId: s.id });
    const args = { p_operation_id: uuid(), p_session_id: e.sessionId, p_submission_id: s.id, p_expected_revision: 1, p_status: 'withdrawn' };
    await expectCode(rpc(e.bob, 'dw_moderate_submission', args), 'FORBIDDEN');
    const withdrawn = await rpc(e.host, 'dw_moderate_submission', args);
    assert.equal(withdrawn.submissions[0].status, 'withdrawn');
    assert.equal(withdrawn.session.focusSubmissionId, null);
    assert.equal((await rpc(e.alice, 'dw_session_snapshot', { p_session_id: e.sessionId })).submissions.length, 1);
    assert.equal((await rpc(e.bob, 'dw_session_snapshot', { p_session_id: e.sessionId })).submissions.length, 0);
    assert.equal((await asUser(db, e.bob, (tx) => tx.query('select * from public.dw_submissions where session_id=$1', [e.sessionId]))).rows.length, 0);
    assert.equal((await rpc(e.host, 'dw_projector_snapshot', { p_session_id: e.sessionId })).submissions.length, 0);
    await expectCode(publish(e.alice, e.sessionId, copy(originalBundle), { p_expected_revision: 2 }), 'FORBIDDEN');
    await expectCode(publish(e.alice, e.sessionId, copy(originalBundle), { p_local_key: 'new-key' }), 'INVALID_INPUT');
    await expectCode(rpc(e.alice, 'dw_moderate_submission', { ...args, p_operation_id: uuid(), p_expected_revision: 2, p_status: 'shared' }), 'FORBIDDEN');
    const restored = await rpc(e.host, 'dw_moderate_submission', { ...args, p_operation_id: uuid(), p_expected_revision: 2, p_status: 'shared' });
    assert.equal(restored.submissions[0].revision, 3);
  });

  it('allows author withdrawal but reserves restoration and role changes for the host', async () => {
    const e = await setup(); const first = await publish(e.alice, e.sessionId); const s = first.submissions[0];
    const out = await rpc(e.alice, 'dw_moderate_submission', { p_operation_id: uuid(), p_session_id: e.sessionId,
      p_submission_id: s.id, p_expected_revision: 1, p_status: 'withdrawn' });
    assert.equal(out.submissions[0].status, 'withdrawn');
    await expectCode(rpc(e.alice, 'dw_set_member_role', { p_operation_id: uuid(), p_session_id: e.sessionId,
      p_member_id: e.bob, p_expected_revision: 1, p_role: 'observer' }), 'FORBIDDEN');
  });

  it('projects only allowlisted fields and prevents focus or moderation across sessions', async () => {
    const e = await setup(); const other = await setup(); const s = (await publish(e.alice, e.sessionId)).submissions[0];
    const p = await rpc(e.host, 'dw_projector_snapshot', { p_session_id: e.sessionId });
    assert.equal(p.participantCount, 2);
    await expectCode(rpc(e.alice, 'dw_projector_snapshot', { p_session_id: e.sessionId }), 'FORBIDDEN');
    assert.deepEqual(Object.keys(p.submissions[0]).sort(), ['bundle','id','revision','updatedAt']);
    const serialized = JSON.stringify(p);
    assert.ok(!serialized.includes(e.alice)); assert.ok(!serialized.includes(e.host));
    assert.ok(!serialized.includes('Участник А')); assert.ok(!serialized.includes('@example.invalid'));
    await patch(e, { projectorShowAuthors: true, focusSubmissionId: s.id });
    assert.equal((await rpc(e.host, 'dw_projector_snapshot', { p_session_id: e.sessionId })).submissions[0].authorName, 'Участник А');
    await expectCode(patch(other, { focusSubmissionId: s.id }), 'FORBIDDEN');
    await expectCode(rpc(other.host, 'dw_moderate_submission', { p_operation_id: uuid(), p_session_id: other.sessionId,
      p_submission_id: s.id, p_expected_revision: 1, p_status: 'withdrawn' }), 'FORBIDDEN');
    await expectCode(rpc(other.host, 'dw_projector_snapshot', { p_session_id: e.sessionId }), 'FORBIDDEN');
  });

  it('keeps the durable notification/audit and revision changes atomic and contains no bundle or secret in events', async () => {
    const e = await setup(); const result = await publish(e.alice, e.sessionId);
    const events = await asUser(db, e.bob, (tx) => tx.query('select * from public.dw_session_events where session_id=$1 order by cursor', [e.sessionId]));
    assert.equal(Number(events.rows.at(-1).cursor), result.cursor);
    assert.equal(events.rows.at(-1).event_type, 'submission.published');
    assert.deepEqual(Object.keys(events.rows[0]).sort(), ['created_at','cursor','entity_id','entity_revision','event_type','id','session_id']);
    assert.ok(!JSON.stringify(events.rows).includes(e.invitation.code));
    assert.ok(!JSON.stringify(events.rows).includes(originalBundle.practice.title));
    await expectPermission(asUser(db, e.alice, (tx) => tx.query('select * from private.audit_events')));
    const beforeCursor = result.cursor;
    const bad = copy(originalBundle); bad.occurrences[0].anchor.spans[0].exact = 'Подделка';
    await expectCode(publish(e.bob, e.sessionId, bad), 'SOURCE_MISMATCH');
    assert.equal((await rpc(e.host, 'dw_session_snapshot', { p_session_id: e.sessionId })).cursor, beforeCursor);
  });

  it('provides an authorized scalar cursor for cheap idle polling and increments it on profile changes', async () => {
    const e = await setup();
    const first = await rpc(e.alice, 'dw_session_cursor', { p_session_id: e.sessionId });
    assert.equal(typeof first, 'number');
    assert.equal(first, (await rpc(e.alice, 'dw_session_snapshot', { p_session_id: e.sessionId })).cursor);
    assert.equal(await rpc(e.alice, 'dw_session_cursor', { p_session_id: e.sessionId }), first);
    await rpc(e.alice, 'dw_save_profile', { p_operation_id: uuid(), p_expected_revision: 1, p_full_name: 'Новое публичное имя' });
    assert.ok(await rpc(e.alice, 'dw_session_cursor', { p_session_id: e.sessionId }) > first);
    const outsider = await user();
    await expectCode(rpc(outsider, 'dw_session_cursor', { p_session_id: e.sessionId }), 'FORBIDDEN');
    await rpc(e.host, 'dw_revoke_member', { p_operation_id: uuid(), p_session_id: e.sessionId,
      p_member_id: e.alice, p_expected_revision: 1 });
    await expectCode(rpc(e.alice, 'dw_session_cursor', { p_session_id: e.sessionId }), 'FORBIDDEN');
    await expectCode(rpc(null, 'dw_session_cursor', { p_session_id: e.sessionId }), 'AUTH_REQUIRED');
  });

  it('seals canonical editions against edits, deletions or appended blocks even through the owner connection', async () => {
    const v = document.version.id; const b = document.version.blocks[0].id;
    await expectCode(db.query("update private.source_blocks set canonical_text='changed' where version_id=$1 and block_id=$2", [v, b]), 'SOURCE_IMMUTABLE');
    await expectCode(db.query('delete from private.source_blocks where version_id=$1 and block_id=$2', [v, b]), 'SOURCE_IMMUTABLE');
    await expectCode(db.query("insert into private.source_blocks(version_id,block_id,block_order,kind,page_start,page_end,canonical_text) values($1,'new-block',99999,'paragraph',1,1,'extra')", [v]), 'SOURCE_IMMUTABLE');
    await expectCode(db.query("update private.source_versions set title='changed' where version_id=$1", [v]), 'SOURCE_IMMUTABLE');
    assert.equal((await seedCanonicalDocument(db, document)).skipped, true);
  });

  it('validates emoji, supplementary planes and combining sequences by Unicode code points, not UTF-16 length', async () => {
    // Deliberately synthetic technical fixture, never labelled a regional programme or shipped in the corpus.
    const hash = (s) => createHash('sha256').update(s).digest('hex');
    const text = 'До 👨‍👩‍👧‍👦, q́ — 𐐷中 после'.normalize('NFC');
    const sourceHash = hash('Synthetic Unicode fixture only');
    const block = { id: 'unicode-test-block', order: 0, kind: 'paragraph', pageStart: 1, pageEnd: 1, text, textHash: hash(text) };
    const page = { number: 1, blockIds: [block.id], textHash: hash(text) };
    const extraction = { representationVersion: 'layout-canonical-v2', canonicalization: 'unicode-nfc-lf-v1', segmentation: 'blank-line-paragraphs-v1' };
    const canonicalHash = hash(JSON.stringify([extraction.representationVersion, extraction.canonicalization,
      extraction.segmentation, [[block.id,0,'paragraph',1,1,text]], [[1,page.blockIds,page.textHash]]]));
    const docId = 'synthetic-unicode-test';
    const versionId = `${docId}@layout-canonical-v2-${sourceHash.slice(0,12)}-${canonicalHash.slice(0,12)}`;
    const doc = { schemaVersion: 1, meta: { id: docId, title: 'Синтетическая техническая фикстура Unicode', regionId: 'test-only' },
      source: { sha256: sourceHash }, pageCount: 1, canonicalHash, extraction,
      version: { id: versionId, documentId: docId, normalizationVersion: 'unicode-nfc-lf-v1', sourceSha256: sourceHash,
        sourceUrl: 'https://example.invalid/synthetic-unicode', blocks: [block], pages: [page] } };
    await seedCanonicalDocument(db, doc);
    const chars = Array.from(text); const start = 3; const end = chars.length - 6;
    const span = { blockId: block.id, start, end, exact: chars.slice(start,end).join(''), prefix: chars.slice(0,start).join(''), suffix: chars.slice(end).join('') };
    assert.notEqual(span.exact.length, end-start);
    const e = await setup();
    const bundle = { schemaVersion: 1, practice: { id: 'unicode-practice', familyId: 'test-family', regionId: 'test-only', title: 'Техническая проверка',
      mechanism: 'Не мера поддержки; тест кодовых точек', occurrenceIds: ['unicode-occurrence'] },
      occurrences: [{ id: 'unicode-occurrence', documentId: docId, versionId, reviewStatus: 'candidate',
        anchor: { id: 'unicode-anchor', documentId: docId, versionId, normalizationVersion: 'unicode-nfc-lf-v1', spans: [span] } }],
      sources: [{ sourceId: docId, editionId: versionId, title: doc.meta.title, sha256: sourceHash, normalizationVersion: 'unicode-nfc-lf-v1', regionId: 'test-only' }], note: '' };
    assert.equal((await publish(e.alice, e.sessionId, bundle)).submissions[0].bundle.occurrences[0].anchor.spans[0].exact, span.exact);
    const wrong = copy(bundle); wrong.occurrences[0].anchor.spans[0].end = start + span.exact.length;
    await expectCode(publish(e.bob, e.sessionId, wrong), 'SOURCE_MISMATCH');
  });

  it('has RLS on every exposed table, pinned search_path, no public SECURITY DEFINER, and explicit grants', async () => {
    const relations = await db.query("select relname,relrowsecurity from pg_class join pg_namespace on pg_namespace.oid=relnamespace where nspname='public' and relname like 'dw_%' and relkind='r'");
    assert.deepEqual(relations.rows.map((r) => r.relname).sort(),
      ['dw_barrier_events','dw_memberships','dw_profiles','dw_roadmap_events','dw_session_events','dw_sessions','dw_submissions','dw_workshop_events']);
    assert.ok(relations.rows.every((r) => r.relrowsecurity));
    const functions = await db.query("select n.nspname,p.proname,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon_exec from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname like 'dw_%' and n.nspname in ('public','private')");
    // The separate survey channel and the opaque-session entry channel are the only
    // anonymous functions. Their capabilities stay independent; neither exposes helpers.
    const guardedAnon = new Set(['dw_survey_public_manifest','dw_survey_own_response','dw_survey_save_response','dw_survey_withdraw_response',
      'dw_identify','dw_entry_session','dw_entry_logout','dw_entry_rpc']);
    assert.ok(functions.rows.filter((r) => r.nspname === 'public').every((r) => !r.prosecdef && r.anon_exec === guardedAnon.has(r.proname)));
    assert.ok(functions.rows.filter((r) => r.prosecdef).every((r) => r.nspname === 'private' && r.proconfig.includes('search_path=""') && r.anon_exec === guardedAnon.has(r.proname)));
    assert.deepEqual(functions.rows.filter((r) => r.anon_exec).map((r) => `${r.nspname}.${r.proname}`).sort(),
      [...guardedAnon].flatMap((name) => [`private.${name}`, `public.${name}`]).sort());
    assert.equal((await db.query("select has_function_privilege('authenticated','private.dw_validate_bundle(jsonb)','EXECUTE') allowed")).rows[0].allowed, false);
    assert.equal((await db.query("select has_table_privilege('authenticated','public.dw_submissions','INSERT,UPDATE,DELETE') allowed")).rows[0].allowed, false);
  });
});
