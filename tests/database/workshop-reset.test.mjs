import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from './harness.mjs';
import { realPracticeBundle } from '../collaboration/workshop-test-support.mjs';
import { createResetSql, inventorySql, teacherDigestSql, materialTables } from '../../scripts/maintenance/workshop-reset.mjs';

const id = () => randomUUID();
async function anon(db, sql, args) {
  return db.transaction(async tx => {
    await tx.exec('set local role anon');
    return (await tx.query(sql, args)).rows[0]?.result;
  });
}
const actor = async (db, email, name) => (await anon(db, 'select public.dw_identify($1,$2) result', [email, name])).session;
const rpc = (db, actor, method, args = {}) => anon(db, 'select public.dw_entry_rpc($1,$2,$3::jsonb) result', [actor.access_token, method, JSON.stringify(args)]);
async function snapshot(db, teacher) {
  return {
    teacherActorId: teacher.user.id, teacherName: 'Сохранённый преподаватель',
    teacherSha256: (await db.query(teacherDigestSql(teacher.user.id))).rows[0].sha256,
    manifest: (await db.exec(inventorySql()))[1].rows[0].manifest,
    backupReceiptSha256: 'a'.repeat(64), acknowledgement: 'DELETE_ALL_WORKSHOP_TEST_DATA_KEEP_TEACHER',
  };
}

test('authorized maintenance removes workshop tests and old tokens while preserving exact teacher identity and sealed sources', async () => {
  const db = await createTestDatabase();
  try {
    const teacher = await actor(db, 'omnistat@yandex.ru', 'Сохранённый преподаватель');
    const participant = await actor(db, `${id()}@reset.test`, 'Тестовый участник');
    const current = await rpc(db, teacher, 'dw_enter_workspace', { p_operation_id: id() });
    await rpc(db, participant, 'dw_enter_workspace', { p_operation_id: id() });
    await rpc(db, participant, 'dw_publish_submission', { p_operation_id: id(), p_session_id: current.session.id,
      p_local_key: 'test-publication', p_expected_revision: null, p_bundle: await realPracticeBundle('mordovia-kindergarten-compensation') });
    // A historical frozen round exercises immutable row guards: maintenance leaves the guards installed.
    const old = await rpc(db, teacher, 'dw_create_session', { p_operation_id: id(), p_title: 'Тестовый архив', p_scope: 'region', p_region_id: 'respublika-mordoviia' });
    const published = await rpc(db, teacher, 'dw_publish_submission', { p_operation_id: id(), p_session_id: old.session.id,
      p_local_key: 'archived-publication', p_expected_revision: null, p_bundle: await realPracticeBundle('mordovia-kindergarten-compensation') });
    let board = await rpc(db, teacher, 'dw_workshop_snapshot', { p_session_id: old.session.id });
    board = await rpc(db, teacher, 'dw_save_family', { p_operation_id: id(), p_session_id: old.session.id, p_family_id: null,
      p_expected_board_revision: board.boardRevision, p_title: 'Архивная группа', p_mechanism: 'Архивный механизм',
      p_rationale: 'Сохранённое тестовое основание', p_submission_ids: [published.submissions[0].id] });
    await rpc(db, teacher, 'dw_update_session', { p_operation_id: id(), p_session_id: old.session.id,
      p_expected_revision: old.session.revision, p_patch: { phase: 'discussion' } });
    await rpc(db, teacher, 'dw_open_voting_round', { p_operation_id: id(), p_session_id: old.session.id,
      p_title: 'Архивный тестовый раунд', p_results_visibility: 'after_close', p_expected_board_revision: board.boardRevision, p_settings: {} });
    const triggers = (await db.query("select oid::text,tgenabled,pg_get_triggerdef(oid) definition from pg_trigger where not tgisinternal order by oid")).rows;
    const config = await snapshot(db, teacher);
    await db.exec(createResetSql(config));
    assert.equal((await db.query(teacherDigestSql(teacher.user.id))).rows[0].sha256, config.teacherSha256);
    assert.deepEqual((await db.query("select oid::text,tgenabled,pg_get_triggerdef(oid) definition from pg_trigger where not tgisinternal order by oid")).rows, triggers);
    for (const table of materialTables) assert.equal((await db.query(`select count(*)::int n from ${table}`)).rows[0].n, 0, table);
    assert.equal((await db.query('select count(*)::int n from private.dw_actors')).rows[0].n, 1);
    assert.equal((await db.query('select count(*)::int n from public.dw_profiles')).rows[0].n, 1);
    await assert.rejects(rpc(db, participant, 'dw_enter_workspace', { p_operation_id: id() }));
    await assert.rejects(rpc(db, teacher, 'dw_enter_workspace', { p_operation_id: id() }));
    const reentered = await actor(db, 'omnistat@yandex.ru', 'Не подменять сохранённое имя');
    assert.equal(reentered.user.id, teacher.user.id);
    assert.equal((await db.query('select full_name from public.dw_profiles where user_id=$1', [teacher.user.id])).rows[0].full_name, 'Сохранённый преподаватель');
    assert.equal((await rpc(db, reentered, 'dw_enter_workspace', { p_operation_id: id() })).session.role, 'host');
  } finally { await db.close(); }
});

test('reset aborts atomically on a stale backup or an unclassified application table', async () => {
  const db = await createTestDatabase();
  try {
    const teacher = await actor(db, 'omnistat@yandex.ru', 'Сохранённый преподаватель');
    const current = await rpc(db, teacher, 'dw_enter_workspace', { p_operation_id: id() });
    const config = await snapshot(db, teacher);
    await actor(db, `${id()}@after-backup.test`, 'Поздний тестовый участник');
    await assert.rejects(db.exec(createResetSql(config)), error => error.message.startsWith('RESET_BACKUP_STALE'));
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int n from public.dw_profiles')).rows[0].n, 2);
    assert.equal((await db.query('select id from public.dw_sessions')).rows[0].id, current.session.id);
    const refreshed = await snapshot(db, teacher);
    await assert.rejects(db.exec(`begin;\n${createResetSql(refreshed, { transaction: false })}\ndo $$begin raise exception 'EXAMPLE_SEED_FAILED'; end $$;\ncommit;`), error => error.message === 'EXAMPLE_SEED_FAILED');
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int n from public.dw_profiles')).rows[0].n, 2);
    assert.equal((await db.query('select id from public.dw_sessions')).rows[0].id, current.session.id);
    await db.exec('create table public.unclassified_test_material(id integer)');
    await assert.rejects(db.exec(createResetSql(refreshed)), error => error.message === 'RESET_SCHEMA_DRIFT');
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int n from public.dw_profiles')).rows[0].n, 2);
    assert.equal((await db.query('select id from public.dw_sessions')).rows[0].id, current.session.id);
  } finally { await db.close(); }
});
