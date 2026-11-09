import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createTestDatabase, projectRoot, loadMordovia, seedCanonicalDocument } from './harness.mjs';
import { realPracticeBundle } from '../collaboration/workshop-test-support.mjs';

const MIGRATION = '20261109181242_stage10_live_flipchart.sql';
const op = () => randomUUID();
const failure = (promise, code) => assert.rejects(promise, (e) => e.code === 'P0001' && e.message === code);
async function anon(db, sql, args = []) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role anon');
    await tx.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{\"role\":\"anon\"}',true)");
    return (await tx.query(sql, args)).rows[0]?.result;
  });
}
const identify = (db, email = op() + '@example.test', name = 'Участник проверки') =>
  anon(db, 'select public.dw_identify($1,$2) result', [email, name]).then((x) => x.session);
const rpc = (db, user, method, args = {}) => anon(db, 'select public.dw_entry_rpc($1,$2,$3::jsonb) result',
  [user.access_token, method, JSON.stringify(args)]);
const enter = (db, user) => rpc(db, user, 'dw_enter_workspace', { p_operation_id: op() }).then((x) => x.session.id);
const updates = (db, user, sid, cursor = null, projector = false) => rpc(db, user, 'dw_flipchart_updates', {
  p_session_id: sid, p_after_cursor: cursor, p_projector: projector,
});
const add = (db, user, sid, text = 'Недоступное жильё', kind = 'barrier', operation = op()) => rpc(db, user, 'dw_flipchart_add', {
  p_operation_id: operation, p_session_id: sid, p_input: { kind, text },
});
const vote = (db, user, sid, id, value, revision, operation = op()) => rpc(db, user, 'dw_flipchart_vote', {
  p_operation_id: operation, p_session_id: sid, p_note_id: id, p_expected_revision: revision, p_input: { value },
});
const status = (db, user, sid, id, value, revision, operation = op()) => rpc(db, user, 'dw_flipchart_status', {
  p_operation_id: operation, p_session_id: sid, p_note_id: id, p_expected_revision: revision, p_input: { status: value },
});
const commonKeys = ['createdAt', 'id', 'kind', 'oppose', 'revision', 'score', 'status', 'support', 'text'].sort();
const participantKeys = [...commonKeys, 'canWithdraw', 'myVote', 'myVoteRevision'].sort();
function noIdentities(result, people) {
  const json = JSON.stringify(result);
  assert(!/"(?:authorId|authorName|actorId|actor_id|userId|email|fullName)":/.test(json));
  for (const person of people) assert(!json.includes(person.user.id));
}

it('first and second ordinary participants share unrestricted multiple short posts, complete/reset/delta snapshots and empty polling', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const a = await identify(db), b = await identify(db), sid = await enter(db, a);
    assert.equal(await enter(db, b), sid);
    assert.deepEqual(await updates(db, a, sid), { sessionId: sid, cursor: 0, reset: true, notes: [], removedIds: [] });
    assert.equal((await db.query('select count(*) n from private.facilitators')).rows[0].n, 0);
    const first = await add(db, a, sid), second = await add(db, a, sid, 'Доступная аренда', 'condition');
    const third = await add(db, b, sid, 'Нет ясельной группы');
    assert.notEqual(first.note.id, second.note.id);
    assert.equal(first.note.myVote, null); assert.equal(first.note.myVoteRevision, 0);
    assert.equal(first.note.status, 'active'); assert.equal(first.note.canWithdraw, true);
    const full = await updates(db, a, sid);
    assert.equal(full.notes.length, 3); assert.equal(full.cursor, 3); assert.equal(full.reset, true);
    assert.deepEqual(full.notes.map((n) => n.id), [first.note.id, second.note.id, third.note.id]);
    assert.equal(full.notes[2].canWithdraw, false);
    const delta = await updates(db, b, sid, first.cursor);
    assert.equal(delta.reset, false); assert.equal(delta.cursor, 3);
    assert.deepEqual(delta.notes.map((n) => n.id), [second.note.id, third.note.id]);
    assert.deepEqual(await updates(db, b, sid, 3), { sessionId: sid, cursor: 3, reset: false, notes: [], removedIds: [] });
    assert.deepEqual(await updates(db, a, sid, 999), full);
    await failure(updates(db, a, sid, -1), 'INVALID_INPUT');
    await failure(updates(db, a, sid, 0, null), 'INVALID_INPUT');
    noIdentities(full, [a, b]);
    for (const note of full.notes) assert.deepEqual(Object.keys(note).sort(), participantKeys);
  } finally { await db.close(); }
});

it('normalizes NFC/Unicode whitespace, accepts 180 Unicode characters and literal markup, rejects invalid or mutable input', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const a = await identify(db), sid = await enter(db, a);
    assert.equal((await add(db, a, sid, ' \t е\u0308лка\u0085\u00a0 и\nдом \u2003')).note.text, 'ёлка и дом');
    assert.equal((await add(db, a, sid, '🙂'.repeat(180))).note.text, '🙂'.repeat(180));
    const literal = '<img src=x onerror=alert(1)> **не** нужно';
    assert.equal((await add(db, a, sid, literal)).note.text, literal);
    for (const text of ['', ' \n\t\u00a0', '🙂'.repeat(181), 'Б'.repeat(181), 'Запрещён\u0001символ'])
      await failure(add(db, a, sid, text), 'INVALID_INPUT');
    for (const input of [null, [], {}, { kind: 'barrier', text: null }, { kind: 'other', text: 'Тезис' },
      { kind: 'barrier', text: 'Тезис', authorId: a.user.id }, { kind: 'barrier', text: 42 }])
      await failure(rpc(db, a, 'dw_flipchart_add', { p_operation_id: op(), p_session_id: sid, p_input: input }), 'INVALID_INPUT');
    const post = await add(db, a, sid);
    await failure(rpc(db, a, 'dw_flipchart_status', { p_operation_id: op(), p_session_id: sid,
      p_note_id: post.note.id, p_expected_revision: 1, p_input: { status: 'active', text: 'Переписано' } }), 'INVALID_INPUT');
    const repeated = await add(db, a, sid);
    assert.notEqual(repeated.note.id, post.note.id, 'equal text remains two explicitly submitted notes');
  } finally { await db.close(); }
});

it('votes toggle/change/remove with independent CAS, no-op polling stability and idempotent receipts', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const a = await identify(db), b = await identify(db), sid = await enter(db, a); await enter(db, b);
    const original = await add(db, a, sid), id = original.note.id;
    const empty = await vote(db, a, sid, id, null, 0);
    assert.equal(empty.cursor, original.cursor); assert.equal(empty.note.myVoteRevision, 0);
    const operation = op(), positive = await vote(db, a, sid, id, 1, 0, operation);
    assert.equal(positive.note.support, 1); assert.equal(positive.note.myVoteRevision, 1);
    assert.equal(positive.note.revision, 1); assert.equal(positive.cursor, original.cursor + 1);
    assert.deepEqual(await vote(db, a, sid, id, 1, 0, operation), positive);
    await failure(vote(db, a, sid, id, -1, 0, operation), 'IDEMPOTENCY_CONFLICT');
    await failure(vote(db, a, sid, id, -1, 0), 'REVISION_CONFLICT');
    const same = await vote(db, a, sid, id, 1, 1);
    assert.deepEqual(same, positive, 'new operation with unchanged value preserves cursor and revision');
    const negative = await vote(db, b, sid, id, -1, 0);
    assert.equal(negative.note.support, 1); assert.equal(negative.note.oppose, 1); assert.equal(negative.note.score, 0);
    const changed = await vote(db, a, sid, id, -1, 1);
    assert.equal(changed.note.support, 0); assert.equal(changed.note.oppose, 2);
    assert.equal(changed.note.myVoteRevision, 2); assert.equal(changed.note.revision, 1);
    const removed = await vote(db, a, sid, id, null, 2);
    assert.equal(removed.note.support, 0); assert.equal(removed.note.oppose, 1);
    assert.equal(removed.note.myVote, null); assert.equal(removed.note.myVoteRevision, 3);
    const replay = await vote(db, a, sid, id, 1, 0, operation);
    assert.deepEqual(replay, removed, 'replaying an old command never revives an old vote');
    const delta = await updates(db, a, sid, positive.cursor);
    assert.deepEqual(delta.notes, [removed.note]); assert.equal(delta.cursor, removed.cursor);
    const projected = await updates(db, b, sid, null, true);
    assert.equal(projected.notes[0].oppose, 1);
    assert.deepEqual(Object.keys(projected.notes[0]).sort(), commonKeys);
    noIdentities(projected, [a, b]);
    for (const invalid of [0, '1', false, {}, []]) await failure(vote(db, a, sid, id, invalid, 3), 'INVALID_INPUT');
    await failure(vote(db, a, sid, id, 1, null), 'INVALID_INPUT');
    assert.equal((await db.query('select count(*) n from private.dw_flipchart_votes')).rows[0].n, 2);
  } finally { await db.close(); }
});

it('withdrawal and restoration enforce ownership, retain votes, emit removals and never revive notes through stale retries', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const a = await identify(db), b = await identify(db), host = await identify(db, 'omnistat@yandex.ru', 'Преподаватель');
    const sid = await enter(db, a); await enter(db, b); await enter(db, host);
    const addOperation = op(), post = await add(db, a, sid, 'Нет времени', 'barrier', addOperation), id = post.note.id;
    const voteOperation = op(); await vote(db, b, sid, id, 1, 0, voteOperation);
    const before = await updates(db, a, sid);
    await failure(status(db, b, sid, id, 'withdrawn', 1), 'FORBIDDEN');
    const withdrawalOperation = op(), hidden = await status(db, a, sid, id, 'withdrawn', 1, withdrawalOperation);
    assert.equal(hidden.note.status, 'withdrawn'); assert.equal(hidden.note.revision, 2);
    assert.equal(hidden.note.support, 1); assert.equal(hidden.note.canWithdraw, true);
    const delta = await updates(db, b, sid, before.cursor);
    assert.deepEqual(delta.notes, []); assert.deepEqual(delta.removedIds, [id]); assert.equal(delta.cursor, hidden.cursor);
    assert.equal((await updates(db, b, sid, null, true)).notes.length, 0);
    assert.equal((await add(db, a, sid, 'Нет времени', 'barrier', addOperation)).note.status, 'withdrawn');
    assert.equal((await vote(db, b, sid, id, 1, 0, voteOperation)).note.status, 'withdrawn');
    await failure(vote(db, b, sid, id, -1, 1), 'NOTE_WITHDRAWN');
    await failure(status(db, a, sid, id, 'active', 1), 'REVISION_CONFLICT');
    const restored = await status(db, host, sid, id, 'active', 2);
    assert.equal(restored.note.revision, 3); assert.equal(restored.note.support, 1); assert.equal(restored.note.canWithdraw, true);
    const returnDelta = await updates(db, b, sid, hidden.cursor);
    assert.deepEqual(returnDelta.removedIds, []); assert.equal(returnDelta.notes[0].myVote, 1);
    assert.equal((await status(db, a, sid, id, 'withdrawn', 1, withdrawalOperation)).note.status, 'active');
    const same = await status(db, a, sid, id, 'active', 3);
    assert.equal(same.cursor, restored.cursor); assert.equal(same.note.revision, 3);
    const hostHidden = await status(db, host, sid, id, 'withdrawn', 3);
    assert.equal(hostHidden.note.status, 'withdrawn');
    await failure(status(db, b, sid, id, 'active', 4), 'FORBIDDEN');
    assert.equal((await status(db, a, sid, id, 'active', 4)).note.revision, 5);
  } finally { await db.close(); }
});

it('denies nonmembers, unrelated sessions and raw table access; receipts recheck membership and projector has no individual metadata', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const a = await identify(db), outsider = await identify(db), host = await identify(db, 'omnistat@yandex.ru', 'Преподаватель');
    const sid = await enter(db, a); await enter(db, host);
    const operation = op(), post = await add(db, a, sid, 'Тезис', 'barrier', operation);
    for (const projector of [true, false]) await failure(updates(db, outsider, sid, null, projector), 'FORBIDDEN');
    await failure(add(db, outsider, sid), 'FORBIDDEN');
    await failure(vote(db, outsider, sid, post.note.id, 1, 0), 'FORBIDDEN');
    await failure(status(db, outsider, sid, post.note.id, 'withdrawn', 1), 'FORBIDDEN');
    const other = await rpc(db, host, 'dw_create_session', { p_operation_id: op(), p_title: 'Историческое занятие', p_scope: 'federal', p_region_id: null });
    await failure(updates(db, host, other.session.id), 'FORBIDDEN');
    await failure(add(db, host, other.session.id), 'FORBIDDEN');
    await assert.rejects(anon(db, 'select public.dw_flipchart_updates($1) result', [sid]), (e) => e.code === '42501');
    const tables = (await db.query(`select c.relname,c.relrowsecurity,
      has_table_privilege('anon',c.oid,'SELECT') anon,has_table_privilege('authenticated',c.oid,'SELECT') authenticated
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='private' and c.relname in ('dw_flipchart_state','dw_flipchart_notes','dw_flipchart_votes')`)).rows;
    assert.equal(tables.length, 3); assert(tables.every((x) => x.relrowsecurity && !x.anon && !x.authenticated));
    const events = JSON.stringify((await db.query('select event_type,entity_id from public.dw_session_events')).rows);
    assert(!events.includes(post.note.id), 'public actor/event ledgers do not expose a note author');
    await db.query('delete from public.dw_memberships where session_id=$1 and user_id=$2', [sid, a.user.id]);
    await failure(add(db, a, sid, 'Тезис', 'barrier', operation), 'FORBIDDEN');
  } finally { await db.close(); }
});

it('upgrades populated 0.9 without rewriting sources, publications, memberships, legacy survey answers or their private receipts', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(resolve(projectRoot, 'tests/database/bootstrap.sql'), 'utf8'));
    const dir = resolve(projectRoot, 'supabase/migrations');
    for (const file of (await readdir(dir)).filter((x) => x.endsWith('.sql') && x < MIGRATION).sort())
      await db.exec(await readFile(resolve(dir, file), 'utf8'));
    await seedCanonicalDocument(db, await loadMordovia());
    const a = await identify(db), sid = await enter(db, a);
    const survey = await rpc(db, a, 'dw_workshop_survey', { p_session_id: sid });
    const answers = { expectedRevision: 0, questionVersion: 1, perspective: 'self', intention12m: null, intention36m: null,
      answerBarrier: 'Исторический закрытый ответ', answerSupport: 'Сохранить частный ответ', priorityChange: null,
      priorityConditionId: null, horizon: null, conditionalChange: null, additionalConditions: null,
      consentEducational: true, consentResearch: false, consentQuote: false, adultConfirmed: true };
    await anon(db, 'select public.dw_survey_save_response($1,$2,$3,$4,$5::jsonb) result',
      [op(), survey.survey.id, survey.invitationToken, randomBytes(32).toString('hex'), JSON.stringify(answers)]);
    const bundle = await realPracticeBundle('mordovia-kindergarten-compensation');
    await rpc(db, a, 'dw_publish_submission', { p_operation_id: op(), p_session_id: sid, p_local_key: bundle.practice.id,
      p_expected_revision: null, p_bundle: bundle });
    const tables = ['research.surveys', 'research.responses', 'research.response_receipts', 'public.dw_sessions',
      'public.dw_memberships', 'public.dw_profiles', 'public.dw_submissions', 'public.dw_session_events',
      'private.source_versions', 'private.source_blocks'];
    const snapshot = async () => Promise.all(tables.map((table) => db.query(`select to_jsonb(t) row from ${table} t order by to_jsonb(t)::text`)));
    const before = await snapshot();
    await db.exec(await readFile(resolve(dir, MIGRATION), 'utf8'));
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await updates(db, a, sid)).notes, []);
    await add(db, a, sid, 'Новый публичный тезис');
    assert.deepEqual(await snapshot(), before, 'flipchart writes do not mutate old module state');
    assert(!JSON.stringify(await updates(db, a, sid)).includes(answers.answerBarrier));
    assert(!JSON.stringify(await updates(db, a, sid, null, true)).includes(answers.answerSupport));
  } finally { await db.close(); }
});

it('enforces only a generous board-level safety bound, including withdrawn records, without limiting one person to one response', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const a = await identify(db), sid = await enter(db, a), post = await add(db, a, sid);
    await db.query(`insert into private.dw_flipchart_notes(session_id,author_id,kind,text,status,updated_cursor)
      select $1,$2,'barrier','Техническая граница','withdrawn',1 from generate_series(1,19999)`, [sid, a.user.id]);
    await failure(add(db, a, sid, 'За пределом общей базы'), 'LIMIT_EXCEEDED');
    assert.equal((await updates(db, a, sid)).notes.length, 1);
    assert.equal((await vote(db, a, sid, post.note.id, 1, 0)).note.support, 1, 'existing notes remain usable at the safety bound');
  } finally { await db.close(); }
});
