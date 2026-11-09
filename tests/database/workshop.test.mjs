import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { asUser, callRpc, createTestDatabase, projectRoot, seedAuthUser, seedCanonicalDocument } from './harness.mjs';

let db; const bundles = new Map();
const id = () => randomUUID();
const clone = (value) => structuredClone(value);
const rpc = (user, name, args = {}) => callRpc(db, user, name, args);
const expectCode = (promise, code) => assert.rejects(promise, (e) => e.code === 'P0001' && e.message === code);
const expectPermission = (promise) => assert.rejects(promise, (e) => e.code === '42501');
const MOR = 'respublika-mordoviia';
const SAK = 'sakhalinskaia-oblast';

before(async () => {
  db = await createTestDatabase();
  const corpus = JSON.parse(await readFile(resolve(projectRoot, 'public/data/corpus/practices.json'), 'utf8'));
  for (const region of [MOR, SAK]) {
    const doc = JSON.parse(await readFile(resolve(projectRoot, `public/data/corpus/documents/regional-${region}.json`), 'utf8'));
    await seedCanonicalDocument(db, doc);
    for (const raw of corpus.variants.filter((v) => v.regionId === region)) {
      const keys = ['id','familyId','regionId','title','mechanism','eligibility','amount','conditions','occurrenceIds','evidence','reviewStatus'];
      const okeys = ['id','documentId','versionId','anchor','reviewStatus','note'];
      bundles.set(raw.id, { schemaVersion: 1,
        practice: Object.fromEntries(keys.filter((key) => key in raw).map((key) => [key, raw[key]])),
        occurrences: corpus.occurrences.filter((o) => raw.occurrenceIds.includes(o.id))
          .map((o) => Object.fromEntries(okeys.filter((key) => key in o).map((key) => [key, o[key]]))),
        sources: [{ sourceId: doc.meta.id, editionId: doc.version.id, title: doc.meta.title,
          sha256: doc.version.sourceSha256, normalizationVersion: doc.version.normalizationVersion,
          sourceUrl: doc.version.sourceUrl, regionId: region }],
        note: 'Учебная находка: сохранён исходный механизм и региональные условия; эффект не установлен.' });
    }
  }
});
after(async () => { await db?.close(); });

async function user(name = 'Участник мастерской') {
  const userId = id();
  await seedAuthUser(db, { id: userId, email: `${userId}@workshop.test` });
  await rpc(userId, 'dw_save_profile', { p_operation_id: id(), p_expected_revision: 0, p_full_name: name });
  return userId;
}
async function setup() {
  const host = await user('Ведущий'); const alice = await user('Исследователь А'); const bob = await user('Исследователь Б');
  await db.query('insert into private.facilitators(user_id) values($1)', [host]);
  const created = await rpc(host, 'dw_create_session', { p_operation_id: id(), p_title: 'Мастерская практик', p_scope: 'municipality', p_region_id: MOR });
  const sessionId = created.session.id;
  const invitation = await rpc(host, 'dw_invitation', { p_session_id: sessionId });
  for (const member of [alice, bob]) await rpc(member, 'dw_join_session', { p_operation_id: id(), p_code: invitation.code });
  return { host, alice, bob, sessionId, invitation };
}
const snapshot = (e, who = e.host) => rpc(who, 'dw_workshop_snapshot', { p_session_id: e.sessionId });
const oldSnapshot = (e) => rpc(e.host, 'dw_session_snapshot', { p_session_id: e.sessionId });
async function patch(e, value) {
  const s = await oldSnapshot(e);
  return rpc(e.host, 'dw_update_session', { p_operation_id: id(), p_session_id: e.sessionId, p_expected_revision: s.session.revision, p_patch: value });
}
async function publish(e, member, practiceId, extra = {}) {
  const result = await rpc(member, 'dw_publish_submission', { p_operation_id: id(), p_session_id: e.sessionId,
    p_local_key: practiceId, p_expected_revision: null, p_bundle: clone(bundles.get(practiceId)), ...extra });
  return result.submissions.find((s) => s.authorId === member && s.localKey === practiceId);
}
const regionAction = (e, who, action, revision, note = '', region = MOR, op = id()) => rpc(who, 'dw_region_work', {
  p_operation_id: op, p_session_id: e.sessionId, p_region_id: region, p_action: action, p_expected_revision: revision, p_note: note,
});
async function family(e, members, options = {}) {
  const s = await snapshot(e);
  return rpc(e.host, 'dw_save_family', { p_operation_id: id(), p_session_id: e.sessionId, p_family_id: null,
    p_expected_board_revision: s.boardRevision, p_title: 'Компенсация родительской платы',
    p_mechanism: 'Возмещение части расходов семьи на дошкольное образование',
    p_rationale: 'Сопоставляем общий механизм, сохраняя различия в адресатах и суммах.',
    p_submission_ids: members, ...options });
}
async function curated() {
  const e = await setup();
  const a = await publish(e, e.alice, 'mordovia-kindergarten-compensation');
  const b = await publish(e, e.bob, 'sakhalin-kindergarten-compensation');
  const grouped = await family(e, [a.id, b.id]);
  return { ...e, a, b, familyId: grouped.families[0].id };
}
async function open(e, options = {}) {
  await patch(e, { phase: 'discussion' });
  const s = await snapshot(e);
  const result = await rpc(e.host, 'dw_open_voting_round', { p_operation_id: id(), p_session_id: e.sessionId,
    p_title: 'Приоритеты адаптации', p_results_visibility: 'after_close', p_expected_board_revision: s.boardRevision, p_settings: {}, ...options });
  return result.round;
}
async function close(e, round) {
  return rpc(e.host, 'dw_close_voting_round', { p_operation_id: id(), p_session_id: e.sessionId, p_round_id: round.id, p_expected_revision: round.revision });
}
const vote = (e, who, roundId, familyId, value, revision = 0, op = id()) => rpc(who, 'dw_cast_vote', {
  p_operation_id: op, p_session_id: e.sessionId, p_round_id: roundId, p_family_id: familyId, p_value: value, p_expected_revision: revision,
});
async function role(e, who, value) {
  const s = await oldSnapshot(e); const m = s.members.find((x) => x.userId === who);
  return rpc(e.host, 'dw_set_member_role', { p_operation_id: id(), p_session_id: e.sessionId,
    p_member_id: who, p_expected_revision: m.revision, p_role: value });
}
async function revoke(e, who) {
  const s = await oldSnapshot(e); const m = s.members.find((x) => x.userId === who);
  return rpc(e.host, 'dw_revoke_member', { p_operation_id: id(), p_session_id: e.sessionId,
    p_member_id: who, p_expected_revision: m.revision });
}

describe('Regional assignments and compatibility cursors', { concurrency: false }, () => {
  it('denies all workshop reads to outsiders and revoked members, including cursor and historical endpoints', async () => {
    const e = await setup(); const outsider = await user();
    for (const name of ['dw_workshop_snapshot','dw_workshop_cursor','dw_workshop_projector_snapshot']) {
      await expectCode(rpc(outsider, name, { p_session_id: e.sessionId }), 'FORBIDDEN');
      await expectCode(rpc(null, name, { p_session_id: e.sessionId }), 'AUTH_REQUIRED');
    }
    await revoke(e, e.alice);
    await expectCode(snapshot(e, e.alice), 'FORBIDDEN');
    await expectCode(rpc(e.alice, 'dw_workshop_round_snapshot', { p_session_id: e.sessionId, p_round_id: id() }), 'FORBIDDEN');
  });

  it('atomically admits one competing claim and preserves the original receipt through later release', async () => {
    const e = await setup(); const op = id();
    const results = await Promise.allSettled([
      regionAction(e, e.alice, 'claim', 0, '', MOR, op), regionAction(e, e.bob, 'claim', 0),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.equal(rejected.reason.message, 'REVISION_CONFLICT');
    const claimed = (await snapshot(e)).regionWork[0];
    assert.equal(claimed.ownerId, e.alice); assert.equal(claimed.status, 'in_progress');
    assert.ok(Date.parse(claimed.leaseExpiresAt) - Date.now() > 29 * 60000);
    await expectCode(regionAction(e, e.bob, 'claim', claimed.revision), 'REGION_TAKEN');
    const released = await regionAction(e, e.alice, 'release', claimed.revision);
    assert.equal(released.regionWork[0].ownerId, null);
    const replay = await regionAction(e, e.alice, 'claim', 0, '', MOR, op);
    assert.equal(replay.regionWork[0].status, 'available'); assert.equal(replay.cursor, released.cursor);
  });

  it('checks lease expiry and generation before completion, renews explicitly, and allows safe reclamation', async () => {
    const e = await setup();
    const claimed = await regionAction(e, e.alice, 'claim', 0);
    const renewed = await regionAction(e, e.alice, 'renew', 1);
    assert.equal(renewed.regionWork[0].revision, 2);
    assert.ok(Date.parse(renewed.regionWork[0].leaseExpiresAt) >= Date.parse(claimed.regionWork[0].leaseExpiresAt));
    await db.query("update private.dw_region_work set lease_expires_at=now()-interval '1 second' where session_id=$1", [e.sessionId]);
    await expectCode(regionAction(e, e.alice, 'complete', 2, 'Изучение завершено, мер не отобрано.'), 'LEASE_EXPIRED');
    await expectCode(regionAction(e, e.alice, 'renew', 2), 'LEASE_EXPIRED');
    const taken = await regionAction(e, e.bob, 'claim', 2);
    assert.equal(taken.regionWork[0].ownerId, e.bob); assert.equal(taken.regionWork[0].revision, 3);
    await expectCode(regionAction(e, e.alice, 'complete', 2, 'Старое назначение завершено.'), 'REVISION_CONFLICT');
    await expectCode(regionAction(e, e.alice, 'complete', 3, 'Старое назначение завершено.'), 'FORBIDDEN');
  });

  it('requires a transparent explanation when no practice was selected and preserves reopen/release semantics', async () => {
    const e = await setup();
    await regionAction(e, e.alice, 'claim', 0);
    await expectCode(regionAction(e, e.alice, 'complete', 1), 'COMPLETION_NOTE_REQUIRED');
    await expectCode(regionAction(e, e.alice, 'complete', 1, '  нет  '), 'COMPLETION_NOTE_REQUIRED');
    const done = await regionAction(e, e.alice, 'complete', 1, 'В назначенном материале подходящих практик не отобрано.');
    assert.equal(done.regionWork[0].status, 'completed'); assert.equal(done.regionWork[0].leaseExpiresAt, null);
    assert.ok(done.regionWork[0].completionNote.includes('не отобрано'));
    await expectCode(regionAction(e, e.bob, 'reopen', 2), 'FORBIDDEN');
    const reopened = await regionAction(e, e.host, 'reopen', 2);
    assert.equal(reopened.regionWork[0].ownerId, e.host); assert.equal(reopened.regionWork[0].status, 'in_progress');
    const reset = await regionAction(e, e.host, 'release', 3);
    assert.equal(reset.regionWork[0].status, 'available'); assert.equal(reset.regionWork[0].completionNote, '');
  });

  it('accepts completion grounded in a published regional source and rejects regions without sealed text', async () => {
    const e = await setup(); await publish(e, e.alice, 'mordovia-kindergarten-compensation');
    await regionAction(e, e.alice, 'claim', 0);
    assert.equal((await regionAction(e, e.alice, 'complete', 1)).regionWork[0].status, 'completed');
    await expectCode(regionAction(e, e.alice, 'claim', 0, '', 'unknown-region'), 'REGION_UNAVAILABLE');
  });

  it('enforces observer/phase/status permissions and isolates workshop notifications from the Stage 2 cursor', async () => {
    const e = await setup(); await role(e, e.bob, 'observer');
    await expectCode(regionAction(e, e.bob, 'claim', 0), 'FORBIDDEN');
    const old = await rpc(e.host, 'dw_session_cursor', { p_session_id: e.sessionId });
    const first = await snapshot(e); const again = await snapshot(e);
    assert.equal(first.cursor, again.cursor);
    const updated = await regionAction(e, e.alice, 'claim', 0);
    assert.ok(updated.cursor > first.cursor);
    assert.equal(await rpc(e.host, 'dw_session_cursor', { p_session_id: e.sessionId }), old);
    await patch(e, { status: 'paused' });
    await expectCode(regionAction(e, e.alice, 'renew', 1), 'SESSION_NOT_OPEN');
    await patch(e, { status: 'open', phase: 'discussion' });
    await expectCode(regionAction(e, e.alice, 'renew', 1), 'PHASE_CLOSED');
  });
});

describe('Non-destructive family curation and frozen source material', { concurrency: false }, () => {
  it('preserves two real regional variants and their citations while grouping with an audited revision', async () => {
    const e = await curated(); const s = await snapshot(e);
    assert.deepEqual([...s.families[0].submissionIds].sort(), [e.a.id,e.b.id].sort());
    const after = await oldSnapshot(e);
    assert.deepEqual(after.submissions.find((v) => v.id === e.a.id).bundle, e.a.bundle);
    assert.deepEqual(after.submissions.find((v) => v.id === e.b.id).bundle, e.b.bundle);
    assert.notEqual(e.a.bundle.practice.amount, e.b.bundle.practice.amount);
    assert.notEqual(e.a.bundle.sources[0].editionId, e.b.bundle.sources[0].editionId);
    const history = await db.query('select families from private.dw_family_history where session_id=$1 order by board_revision', [e.sessionId]);
    assert.equal(history.rows.length, 2); assert.deepEqual(history.rows[0].families, []);
    assert.deepEqual(history.rows[1].families[0].submissionIds, s.families[0].submissionIds);
  });

  it('moves variants atomically between families, leaves explicit empty groups and never deletes sources', async () => {
    const e = await curated();
    const moved = await family(e, [e.b.id], { p_title: 'Региональный вариант Сахалина' });
    const source = moved.families.find((f) => f.id === e.familyId);
    const target = moved.families.find((f) => f.id !== e.familyId);
    assert.deepEqual(source.submissionIds, [e.a.id]); assert.deepEqual(target.submissionIds, [e.b.id]);
    const merged = await family(e, [e.a.id,e.b.id], { p_family_id: target.id });
    assert.deepEqual(merged.families.find((f) => f.id === source.id).submissionIds, []);
    const removed = await rpc(e.host, 'dw_delete_family', { p_operation_id: id(), p_session_id: e.sessionId,
      p_family_id: target.id, p_expected_board_revision: merged.boardRevision });
    assert.equal(removed.families.length, 1);
    const originals = await oldSnapshot(e); assert.equal(originals.submissions.length, 2);
    assert.deepEqual(originals.submissions.find((v) => v.id === e.b.id).bundle, e.b.bundle);
  });

  it('rejects stale board revisions, unauthorized edits, duplicate and cross-session submission IDs', async () => {
    const e = await curated(); const initial = await snapshot(e); const other = await curated();
    const base = { p_operation_id: id(), p_session_id: e.sessionId, p_family_id: e.familyId,
      p_expected_board_revision: initial.boardRevision, p_title: 'Семейство', p_mechanism: 'Механизм',
      p_rationale: 'Проверенное основание группировки', p_submission_ids: [e.a.id] };
    await expectCode(rpc(e.alice, 'dw_save_family', base), 'FORBIDDEN');
    await expectCode(rpc(e.host, 'dw_save_family', { ...base, p_submission_ids: [other.a.id] }), 'FORBIDDEN');
    await expectCode(rpc(e.host, 'dw_save_family', { ...base, p_submission_ids: [e.a.id,e.a.id] }), 'INVALID_INPUT');
    const saved = await rpc(e.host, 'dw_save_family', base);
    const replay = await rpc(e.host, 'dw_save_family', base); assert.equal(replay.cursor, saved.cursor);
    await expectCode(rpc(e.host, 'dw_save_family', { ...base, p_operation_id: id(), p_title: 'Старая версия' }), 'REVISION_CONFLICT');
    await expectCode(rpc(e.host, 'dw_save_family', { ...base, p_title: 'Другой payload' }), 'IDEMPOTENCY_CONFLICT');
  });

  it('freezes metadata, sources, roster and individual order; prevents changes and appended candidates', async () => {
    const e = await curated(); const round = await open(e);
    assert.equal(round.contextScope, 'municipality'); assert.equal(round.contextRegionId, MOR);
    assert.equal(round.evaluationDimension, 'priority_for_adaptation');
    assert.equal(round.families[0].variants.length, 2);
    assert.deepEqual(round.families[0].variants.find((v) => v.submissionId === e.b.id).bundle, e.b.bundle);
    await expectCode(db.query('update private.dw_round_variants set bundle=$1 where round_id=$2', [JSON.stringify(e.a.bundle),round.id]), 'ROUND_IMMUTABLE');
    await expectCode(db.query('delete from private.dw_round_roster where round_id=$1', [round.id]), 'ROUND_IMMUTABLE');
    const late = await user();
    await expectCode(db.query('insert into private.dw_round_roster(round_id,user_id) values($1,$2)', [round.id,late]), 'ROUND_IMMUTABLE');
    await expectCode(db.query("update private.dw_voting_rounds set prompt_text='Подмена вопроса' where id=$1", [round.id]), 'ROUND_IMMUTABLE');
    await patch(e, { phase: 'reading' });
    await expectCode(family(e, [e.a.id]), 'ROUND_OPEN');
    const edited = clone(e.a.bundle); edited.note = 'Новая заметка';
    await expectCode(publish(e, e.alice, e.a.localKey, { p_bundle: edited, p_expected_revision: e.a.revision }), 'ROUND_OPEN');
    await expectCode(rpc(e.host, 'dw_moderate_submission', { p_operation_id: id(), p_session_id: e.sessionId,
      p_submission_id: e.a.id, p_expected_revision: e.a.revision, p_status: 'withdrawn' }), 'ROUND_OPEN');
  });

  it('uses persisted, reproducible personal ordering without putting the seed on the projector', async () => {
    const e = await curated();
    const extra = await publish(e, e.alice, 'mordovia-student-childcare');
    await family(e, [extra.id], { p_title: 'Присмотр за детьми студентов' });
    const round = await open(e);
    const mine = await snapshot(e, e.alice); const again = await snapshot(e, e.alice);
    assert.deepEqual(mine.round.families.map((f) => f.id), again.round.families.map((f) => f.id));
    const seed = (await db.query('select order_seed from private.dw_round_roster where round_id=$1 and user_id=$2', [round.id,e.alice])).rows[0].order_seed;
    const expected = mine.round.families.map((f) => f.id).sort((a,b) =>
      createHash('md5').update(seed+':'+a).digest('hex').localeCompare(createHash('md5').update(seed+':'+b).digest('hex')));
    assert.deepEqual(mine.round.families.map((f) => f.id), expected);
    const projected = await rpc(e.host, 'dw_workshop_projector_snapshot', { p_session_id: e.sessionId });
    assert.equal(JSON.stringify(projected).includes(seed), false);
  });
});

describe('Teaching ballots, denominators and round boundaries', { concurrency: false }, () => {
  it('requires the first round to be blind and validates thresholds before freezing the candidates', async () => {
    const e = await curated();
    await expectCode(open(e, { p_results_visibility: 'live' }), 'FIRST_ROUND_BLIND');
    await expectCode(open(e, { p_settings: { minCoverage: 1.1 } }), 'INVALID_INPUT');
    await expectCode(open(e, { p_settings: { minSubstantiveVotes: 4 } }), 'INVALID_INPUT');
    await expectCode(open(e, { p_settings: { minSubstantiveVotes: 1.5 } }), 'INVALID_INPUT');
    await expectCode(open(e, { p_settings: { unknown: true } }), 'INVALID_INPUT');
    const round = await open(e, { p_settings: { minCoverage: 0.5, minSubstantiveVotes: 2, promptText: 'Приоритетна ли адаптация механизма в контексте занятия?' } });
    assert.equal(round.minCoverage, .5); assert.equal(round.minSubstantiveVotes, 2);
    assert.ok(round.promptText.startsWith('Приоритетна')); assert.equal(round.eligibleCount, 3);
    await expectCode(open(e), 'ROUND_OPEN');
  });

  it('distinguishes neutral, no answer and opposing votes and hides totals from every role before closure', async () => {
    const e = await curated(); const round = await open(e);
    const zero = await vote(e, e.alice, round.id, e.familyId, 0);
    assert.equal(zero.round.families[0].myVote, 0); assert.equal(zero.round.families[0].myVoteRevision, 1);
    assert.equal(zero.round.participatingCount, 1); assert.equal(zero.round.families[0].totals, null);
    await vote(e, e.bob, round.id, e.familyId, -1);
    const host = await snapshot(e); assert.equal(host.round.families[0].myVote, null); assert.equal(host.round.families[0].totals, null);
    const projection = await rpc(e.host, 'dw_workshop_projector_snapshot', { p_session_id: e.sessionId });
    assert.equal(projection.round.totalsVisible, false); assert.equal(projection.round.families[0].totals, null);
    assert.equal('myVote' in projection.round.families[0], false);
    const withdrawn = await vote(e, e.alice, round.id, e.familyId, null, 1);
    assert.equal(withdrawn.round.families[0].myVote, null); assert.equal(withdrawn.round.participatingCount, 1);
    const closed = await close(e, round); const totals = closed.round.families[0].totals;
    assert.deepEqual({a:totals.support,d:totals.oppose,z:totals.neutral,c:totals.cast,r:totals.unanswered}, {a:0,d:1,z:0,c:1,r:2});
    assert.equal(totals.net, -1); assert.equal(totals.coverage, 1/3); assert.equal(totals.qualifies, false);
    await expectCode(db.query('update private.dw_ballots set value=1,revision=revision+1 where round_id=$1', [round.id]), 'ROUND_CLOSED');
    await expectCode(db.query('delete from private.dw_ballots where round_id=$1', [round.id]), 'ROUND_IMMUTABLE');
  });

  it('uses explicit denominators, null for undefined net and coverage thresholds rather than raw popularity', async () => {
    const e = await curated(); const round = await open(e, { p_settings: { minCoverage: .5, minSubstantiveVotes: 2 } });
    await vote(e, e.alice, round.id, e.familyId, 1);
    await vote(e, e.bob, round.id, e.familyId, -1);
    const closed = await close(e, round); const t = closed.round.families[0].totals;
    assert.equal(t.support, 1); assert.equal(t.oppose, 1); assert.equal(t.neutral, 0);
    assert.equal(t.score, 0); assert.equal(t.net, 0); assert.equal(t.supportRatio, .5);
    assert.equal(t.substantive, 2); assert.equal(t.coverage, 2/3); assert.equal(t.qualifies, true);
    const second = await open(e, { p_results_visibility: 'live' });
    assert.equal(second.families[0].totals.net, null); assert.equal(second.families[0].totals.supportRatio, null);
    assert.equal(second.families[0].totals.coverage, 0); assert.equal(second.families[0].totals.qualifies, false);
    await vote(e, e.alice, second.id, e.familyId, 0);
    const onlyNeutral = (await close(e, second)).round.families[0].totals;
    assert.equal(onlyNeutral.cast, 1); assert.equal(onlyNeutral.neutral, 1); assert.equal(onlyNeutral.net, null);
    assert.equal(onlyNeutral.substantive, 0); assert.equal(onlyNeutral.qualifies, false);
  });

  it('deduplicates ballot retries, checks captured revisions and keeps another member’s ballot private', async () => {
    const e = await curated(); const round = await open(e); const operation = id();
    const written = await vote(e, e.alice, round.id, e.familyId, 1, 0, operation);
    for (let i=0;i<12;i++) assert.equal((await vote(e, e.alice, round.id, e.familyId, 1, 0, operation)).cursor, written.cursor);
    await expectCode(vote(e, e.alice, round.id, e.familyId, -1, 0), 'REVISION_CONFLICT');
    await expectCode(vote(e, e.alice, round.id, e.familyId, -1, 0, operation), 'IDEMPOTENCY_CONFLICT');
    const other = await snapshot(e, e.bob);
    assert.equal(other.round.families[0].myVote, null); assert.equal(other.round.families[0].myVoteRevision, 0);
    const changed = await vote(e, e.alice, round.id, e.familyId, -1, 1);
    assert.equal(changed.round.families[0].myVoteRevision, 2);
    const result = await close(e, round); assert.equal(result.round.families[0].totals.cast, 1);
  });

  it('checks captured roster and current role; retains earlier opinions without changing the denominator', async () => {
    const e = await curated(); await role(e, e.bob, 'observer');
    const round = await open(e); assert.equal(round.eligibleCount, 2);
    await expectCode(vote(e, e.bob, round.id, e.familyId, 1), 'FORBIDDEN');
    await role(e, e.bob, 'participant');
    await expectCode(vote(e, e.bob, round.id, e.familyId, 1), 'NOT_ELIGIBLE');
    const late = await user(); await rpc(late, 'dw_join_session', { p_operation_id: id(), p_code: e.invitation.code });
    await expectCode(vote(e, late, round.id, e.familyId, 1), 'NOT_ELIGIBLE');
    const operation = id(); await vote(e, e.alice, round.id, e.familyId, 1, 0, operation);
    await revoke(e, e.alice);
    await expectCode(vote(e, e.alice, round.id, e.familyId, 1, 0, operation), 'FORBIDDEN');
    const closed = await close(e, round);
    assert.equal(closed.round.eligibleCount, 2); assert.equal(closed.round.families[0].totals.support, 1);
    assert.equal(closed.round.families[0].totals.unanswered, 1);
  });

  it('rejects voting while paused or after closure and permits the host to close a paused session round', async () => {
    const e = await curated(); const round = await open(e);
    await patch(e, { status: 'paused' });
    await expectCode(vote(e, e.alice, round.id, e.familyId, 1), 'SESSION_NOT_OPEN');
    await close(e, round); await patch(e, { status: 'open' });
    await expectCode(vote(e, e.alice, round.id, e.familyId, 1), 'ROUND_CLOSED');
    await expectCode(close(e, round), 'ROUND_CLOSED');
  });

  it('keeps closed round sources and votes immutable when live work changes and a new round begins', async () => {
    const e = await curated(); const first = await open(e);
    await vote(e, e.alice, first.id, e.familyId, 1); await close(e, first);
    const historical = await rpc(e.host, 'dw_workshop_round_snapshot', { p_session_id: e.sessionId, p_round_id: first.id });
    await patch(e, { phase: 'review' });
    const changed = clone(e.a.bundle); changed.note = 'Уточнение после завершённого обсуждения.';
    await publish(e, e.alice, e.a.localKey, { p_bundle: changed, p_expected_revision: e.a.revision });
    await family(e, [e.a.id], { p_family_id: e.familyId, p_title: 'Уточнённый состав семьи практик' });
    const second = await open(e, { p_results_visibility: 'live' });
    assert.equal(second.families[0].variants.length, 1); assert.equal(second.families[0].totals.cast, 0);
    assert.equal(second.families[0].variants[0].bundle.note, changed.note);
    assert.deepEqual(await rpc(e.host, 'dw_workshop_round_snapshot', { p_session_id: e.sessionId, p_round_id: first.id }), historical);
  });
});

describe('Workshop data and projection isolation', { concurrency: false }, () => {
  it('omits only cached immutable materials in compact updates and retains full fallback and authorization', async () => {
    const e = await curated(); const round = await open(e);
    const full = await rpc(e.alice, 'dw_workshop_updates', { p_session_id: e.sessionId, p_known_round_id: null });
    const short = await rpc(e.alice, 'dw_workshop_updates', { p_session_id: e.sessionId, p_known_round_id: round.id });
    assert.equal(short.round.families[0].variants, null);
    assert.equal(Buffer.byteLength(JSON.stringify(short)) < Buffer.byteLength(JSON.stringify(full)) * .5, true);
    assert.equal(short.round.families[0].myVote, null);
    const operation = id();
    const args = { p_operation_id: operation, p_session_id: e.sessionId, p_round_id: round.id, p_family_id: e.familyId,
      p_value: 0, p_expected_revision: 0, p_known_round_id: round.id };
    const changed = await rpc(e.alice, 'dw_cast_vote_updates', args);
    assert.equal(changed.round.families[0].variants, null); assert.equal(changed.round.families[0].myVote, 0);
    assert.equal(changed.round.families[0].myVoteRevision, 1);
    const recovered = await rpc(e.alice, 'dw_cast_vote_updates', { ...args, p_known_round_id: null });
    assert.equal(recovered.cursor, changed.cursor); assert.deepEqual(recovered.round.families[0].variants, full.round.families[0].variants);
    const wrongCache = await rpc(e.alice, 'dw_workshop_updates', { p_session_id: e.sessionId, p_known_round_id: id() });
    assert.deepEqual(wrongCache.round.families[0].variants, full.round.families[0].variants);
    await expectCode(rpc(e.alice, 'dw_workshop_projector_updates', { p_session_id: e.sessionId, p_known_round_id: round.id }), 'FORBIDDEN');
    const projection = await rpc(e.host, 'dw_workshop_projector_updates', { p_session_id: e.sessionId, p_known_round_id: round.id });
    assert.equal(projection.round.families[0].variants, null); assert.equal('myVote' in projection.round.families[0], false);
  });

  it('grants no raw access to private ballots, roster, group history or elevated internal helpers', async () => {
    const e = await curated(); await open(e);
    for (const name of ['dw_ballots','dw_round_roster','dw_family_history','dw_round_variants','dw_workshop_state']) {
      await expectPermission(asUser(db, e.alice, (tx) => tx.query(`select * from private.${name}`)));
    }
    await expectPermission(asUser(db, e.alice, (tx) => tx.query('select private.dw_family_list($1)', [e.sessionId])));
    await expectPermission(asUser(db, e.alice, (tx) => tx.query("select private.dw_workshop_touch($1,'forged',true)", [e.sessionId])));
    const status = await db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and relname like 'dw_%' and relkind='r'");
    assert.equal(status.rows.length, 32); assert.ok(status.rows.every((r) => r.relrowsecurity));
  });

  it('returns only allowlisted projector fields and minimal session-scoped realtime notifications', async () => {
    const e = await curated(); await regionAction(e, e.alice, 'claim', 0); const round = await open(e);
    await vote(e, e.alice, round.id, e.familyId, 1);
    await expectCode(rpc(e.alice, 'dw_workshop_projector_snapshot', { p_session_id: e.sessionId }), 'FORBIDDEN');
    const p = await rpc(e.host, 'dw_workshop_projector_snapshot', { p_session_id: e.sessionId });
    const encoded = JSON.stringify(p);
    for (const privateValue of [e.host,e.alice,e.bob,e.invitation.code,'Исследователь А','Исследователь Б']) assert.equal(encoded.includes(privateValue), false);
    assert.equal('ownerId' in p.regionWork[0], false); assert.equal('myVote' in p.round.families[0], false);
    assert.equal('canVote' in p.round, false);
    const events = await asUser(db, e.alice, (tx) => tx.query('select * from public.dw_workshop_events where session_id=$1', [e.sessionId]));
    assert.ok(events.rows.length>0);
    for (const event of events.rows) assert.deepEqual(Object.keys(event).sort(), ['created_at','cursor','event_type','id','session_id']);
    const outsider = await user();
    assert.equal((await asUser(db, outsider, (tx) => tx.query('select * from public.dw_workshop_events where session_id=$1', [e.sessionId]))).rows.length, 0);
  });
});

describe('Cumulative migration compatibility', { concurrency: false }, () => {
  it('upgrades populated Stage 2 sessions without changing publications or old cursors, then accepts existing API writes', async () => {
    const prior = new PGlite();
    try {
      await prior.exec(await readFile(new URL('./bootstrap.sql', import.meta.url), 'utf8'));
      await prior.exec(await readFile(resolve(projectRoot, 'supabase/migrations/20261108131424_stage2_collaborative_sessions.sql'), 'utf8'));
      const doc = JSON.parse(await readFile(resolve(projectRoot, `public/data/corpus/documents/regional-${MOR}.json`), 'utf8'));
      await seedCanonicalDocument(prior, doc);
      const host = id(); const member = id();
      const run = (who, name, args = {}) => callRpc(prior, who, name, args);
      for (const who of [host, member]) {
        await seedAuthUser(prior, { id: who, email: `${who}@upgrade.test` });
        await run(who, 'dw_save_profile', { p_operation_id: id(), p_expected_revision: 0, p_full_name: who === host ? 'Ведущий прежней версии' : 'Участник прежней версии' });
      }
      await prior.query('insert into private.facilitators(user_id) values($1)', [host]);
      const sessions = [];
      for (const title of ['Ранее созданное занятие', 'Второе сохранённое занятие']) {
        sessions.push((await run(host, 'dw_create_session', { p_operation_id: id(), p_title: title, p_scope: 'region', p_region_id: MOR })).session.id);
      }
      const invitation = await run(host, 'dw_invitation', { p_session_id: sessions[0] });
      await run(member, 'dw_join_session', { p_operation_id: id(), p_code: invitation.code });
      const bundle = clone(bundles.get('mordovia-kindergarten-compensation'));
      const baseline = await run(member, 'dw_publish_submission', { p_operation_id: id(), p_session_id: sessions[0],
        p_local_key: bundle.practice.id, p_expected_revision: null, p_bundle: bundle });
      const oldCursor = await run(host, 'dw_session_cursor', { p_session_id: sessions[0] });
      await prior.exec(await readFile(resolve(projectRoot, 'supabase/migrations/20261108172311_stage3_regions_families_voting.sql'), 'utf8'));
      assert.deepEqual(await run(member, 'dw_session_snapshot', { p_session_id: sessions[0] }), baseline);
      assert.equal(await run(host, 'dw_session_cursor', { p_session_id: sessions[0] }), oldCursor);
      for (const sessionId of sessions) {
        const fresh = await run(host, 'dw_workshop_snapshot', { p_session_id: sessionId });
        assert.equal(fresh.boardRevision, 0); assert.equal(fresh.cursor, 0);
        assert.deepEqual(fresh.families, []); assert.deepEqual(fresh.regionWork, []); assert.equal(fresh.round, null);
      }
      bundle.note = 'Сохранённое основание уточнено после накопительного обновления.';
      const updated = await run(member, 'dw_publish_submission', { p_operation_id: id(), p_session_id: sessions[0],
        p_local_key: bundle.practice.id, p_expected_revision: 1, p_bundle: bundle });
      assert.equal(updated.submissions[0].revision, 2);
      assert.deepEqual(updated.submissions[0].bundle.occurrences, baseline.submissions[0].bundle.occurrences);
      const fresh = await run(host, 'dw_workshop_snapshot', { p_session_id: sessions[0] });
      assert.equal(fresh.boardRevision, 1); assert.equal(fresh.cursor, 1);
      assert.equal(await run(host, 'dw_session_cursor', { p_session_id: sessions[0] }), oldCursor+1);
    } finally { await prior.close(); }
  });
});
