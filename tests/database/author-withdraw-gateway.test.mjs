import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createTestDatabase, projectRoot, loadMordovia, seedCanonicalDocument } from './harness.mjs';
import { realPracticeBundle } from '../collaboration/workshop-test-support.mjs';
import { loadFamilyCatalogMaterial, seedFamilyCatalog } from '../../scripts/seed-family-catalog.mjs';

const migration = '20261117000300_stage24_author_withdraw_gateway.sql';
const id = () => randomUUID();
const rejected = (promise, code) => assert.rejects(promise, error => error.code === 'P0001' && error.message === code);
async function anon(db, sql, args = []) {
  return db.transaction(async tx => {
    await tx.exec('set local role anon');
    await tx.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{\"role\":\"anon\"}',true)");
    return (await tx.query(sql, args)).rows[0]?.result;
  });
}
const rpc = (db, actor, name, args = {}) => anon(db, 'select public.dw_entry_rpc($1,$2,$3::jsonb) result', [actor.access_token, name, JSON.stringify(args)]);
async function actor(db, email = `${id()}@withdraw.test`) {
  return (await anon(db, 'select public.dw_identify($1,$2) result', [email, 'Проверка снятия авторской карточки'])).session;
}
const enter = (db, who) => rpc(db, who, 'dw_enter_workspace', { p_operation_id: id() });
async function publish(db, who, sid) {
  const material = await realPracticeBundle('mordovia-kindergarten-compensation');
  material.practice = { ...material.practice, id: `author-${id()}`, evidence: [], reviewStatus: 'candidate' };
  const result = await rpc(db, who, 'dw_publish_submission', { p_operation_id: id(), p_session_id: sid,
    p_local_key: material.practice.id, p_expected_revision: null, p_bundle: material });
  return result.submissions.find(item => item.localKey === material.practice.id);
}
const moderateArgs = (sid, source, status = 'withdrawn', operation = id()) => ({ p_operation_id: operation,
  p_session_id: sid, p_submission_id: source.id, p_expected_revision: source.revision, p_status: status });
const moderate = (db, who, args) => rpc(db, who, 'dw_moderate_submission', args);
const row = async (db, source) => (await db.query('select * from public.dw_submissions where id=$1', [source.id])).rows[0];

test('an ordinary author withdraws their shared source through the actual gateway without moderator powers; retries preserve exact receipt and CAS rules', async () => {
  const db = await createTestDatabase();
  try {
    const a = await actor(db), b = await actor(db), teacher = await actor(db, 'omnistat@yandex.ru');
    assert.deepEqual((await db.query('select operator from private.dw_entry_sessions where actor_id=any($1::uuid[])', [[a.user.id, b.user.id]])).rows.map(item => item.operator), [false, false]);
    const sid = (await enter(db, a)).session.id;
    await enter(db, b); await enter(db, teacher);
    const own = await publish(db, a, sid), foreign = await publish(db, b, sid);
    const before = await row(db, own);
    const membership = (await db.query('select * from private.dw_family_members where submission_id=$1', [own.id])).rows;
    await rejected(moderate(db, a, moderateArgs(sid, foreign)), 'FORBIDDEN');
    await rejected(moderate(db, a, { ...moderateArgs(sid, own), p_expected_revision: own.revision + 1 }), 'REVISION_CONFLICT');
    assert.deepEqual(await row(db, own), before);
    const args = moderateArgs(sid, own);
    const hidden = await moderate(db, a, args);
    const withdrawn = hidden.submissions.find(item => item.id === own.id);
    assert.equal(withdrawn.status, 'withdrawn');
    assert.equal(withdrawn.revision, own.revision + 1);
    assert.deepEqual(withdrawn.bundle, own.bundle);
    assert.deepEqual((await db.query('select * from private.dw_family_members where submission_id=$1', [own.id])).rows, membership);
    const after = await row(db, own);
    const receipts = (await db.query('select * from private.command_receipts where actor_id=$1 and operation_id=$2', [a.user.id, args.p_operation_id])).rows;
    await moderate(db, a, args); // Lost successful response: retry after the source is already withdrawn.
    assert.deepEqual(await row(db, own), after);
    assert.deepEqual((await db.query('select * from private.command_receipts where actor_id=$1 and operation_id=$2', [a.user.id, args.p_operation_id])).rows, receipts);
    await rejected(moderate(db, a, { ...args, p_expected_revision: withdrawn.revision }), 'IDEMPOTENCY_CONFLICT');
    await rejected(moderate(db, b, args), 'FORBIDDEN');
    await rejected(moderate(db, a, moderateArgs(sid, withdrawn)), 'FORBIDDEN');
    await rejected(moderate(db, a, { ...args, p_status: 'shared' }), 'FORBIDDEN');
    await rejected(moderate(db, a, moderateArgs(sid, withdrawn, 'shared')), 'FORBIDDEN');
    assert.deepEqual(await row(db, own), after);
    const restored = await moderate(db, teacher, moderateArgs(sid, withdrawn, 'shared'));
    assert.equal(restored.submissions.find(item => item.id === own.id).status, 'shared');
    const catalogue = await loadFamilyCatalogMaterial();
    await seedFamilyCatalog(db, catalogue);
    const selected = await rpc(db, a, 'dw_select_catalog_practice', { p_operation_id: id(), p_session_id: sid, p_catalog_id: catalogue.cards[0].catalog_id });
    const catalogSource = selected.submissions.find(item => item.bundle.catalogSource);
    assert.equal(catalogSource.authorId, a.user.id, 'catalogue selection is owned but is not an author-created card');
    await rejected(moderate(db, a, moderateArgs(sid, catalogSource)), 'FORBIDDEN');
    assert.equal((await row(db, catalogSource)).status, 'shared');
    assert.equal((await rpc(db, a, 'dw_bootstrap')).canCreateSession, false);
    assert.equal((await enter(db, a)).session.role, 'participant');
    assert.equal((await db.query('select count(*)::int n from private.facilitators where user_id=$1', [a.user.id])).rows[0].n, 0);
  } finally { await db.close(); }
});

test('upgrade changes only the gateway while preserving source data, workspace role invariants and historical isolation', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(`${projectRoot}/tests/database/bootstrap.sql`, 'utf8'));
    for (const file of (await readdir(`${projectRoot}/supabase/migrations`)).filter(name => name.endsWith('.sql') && name < migration).sort())
      await db.exec(await readFile(`${projectRoot}/supabase/migrations/${file}`, 'utf8'));
    await seedCanonicalDocument(db, await loadMordovia());
    const a = await actor(db), teacher = await actor(db, 'omnistat@yandex.ru');
    const sid = (await enter(db, a)).session.id;
    await enter(db, teacher);
    const source = await publish(db, a, sid);
    const before = await row(db, source);
    await rejected(moderate(db, a, moderateArgs(sid, source)), 'FORBIDDEN');
    const handlers = (await db.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) definition,proacl::text acl from pg_proc where oid in ('private.dw_moderate_submission(uuid,uuid,uuid,bigint,text)'::regprocedure,'public.dw_moderate_submission(uuid,uuid,uuid,bigint,text)'::regprocedure,'public.dw_entry_rpc(text,text,jsonb)'::regprocedure) order by 1")).rows;
    await db.exec(await readFile(`${projectRoot}/supabase/migrations/${migration}`, 'utf8'));
    assert.deepEqual(await row(db, source), before);
    assert.deepEqual((await db.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) definition,proacl::text acl from pg_proc where oid in ('private.dw_moderate_submission(uuid,uuid,uuid,bigint,text)'::regprocedure,'public.dw_moderate_submission(uuid,uuid,uuid,bigint,text)'::regprocedure,'public.dw_entry_rpc(text,text,jsonb)'::regprocedure) order by 1")).rows, handlers);
    const current = await rpc(db, teacher, 'dw_session_snapshot', { p_session_id: sid });
    const member = current.members.find(item => item.userId === a.user.id);
    await rejected(rpc(db, teacher, 'dw_set_member_role', { p_operation_id: id(), p_session_id: sid,
      p_member_id: a.user.id, p_expected_revision: member.revision, p_role: 'observer' }), 'FORBIDDEN');
    const stillOpen = await rpc(db, teacher, 'dw_update_session', { p_operation_id: id(), p_session_id: sid,
      p_expected_revision: current.session.revision, p_patch: { status: 'closed' } });
    assert.equal(stillOpen.session.status, 'open');
    assert.equal(stillOpen.members.find(item => item.userId === a.user.id).role, 'participant');
    const historical = await rpc(db, teacher, 'dw_create_session', { p_operation_id: id(), p_title: 'Отдельная историческая сессия', p_scope: 'region', p_region_id: 'respublika-mordoviia' });
    await db.query('update private.dw_current_workspace set session_id=$1', [historical.session.id]);
    await rejected(moderate(db, a, moderateArgs(sid, source)), 'FORBIDDEN');
    assert.deepEqual(await row(db, source), before);
  } finally { await db.close(); }
});
