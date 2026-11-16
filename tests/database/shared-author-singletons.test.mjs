import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createTestDatabase, projectRoot, loadMordovia, seedCanonicalDocument } from './harness.mjs';
import { realPracticeBundle } from '../collaboration/workshop-test-support.mjs';
import { loadFamilyCatalogMaterial, seedFamilyCatalog } from '../../scripts/seed-family-catalog.mjs';

const migration = '20261117000200_stage23_shared_author_singletons.sql';
const id = () => randomUUID();
const rejected = (promise, code) => assert.rejects(promise, error => error.code === 'P0001' && error.message === code);
async function anon(db, sql, args) {
  return db.transaction(async tx => {
    await tx.exec('set local role anon');
    return (await tx.query(sql, args)).rows[0]?.result;
  });
}
const rpc = (db, actor, name, args = {}) => anon(db, 'select public.dw_entry_rpc($1,$2,$3::jsonb) result', [actor.access_token, name, JSON.stringify(args)]);
async function actor(db, email = `${id()}@singleton.test`) {
  return (await anon(db, 'select public.dw_identify($1,$2) result', [email, 'Проверка авторских карточек'])).session;
}
const enter = (db, who) => rpc(db, who, 'dw_enter_workspace', { p_operation_id: id() });
const board = (db, who, sid) => rpc(db, who, 'dw_workshop_snapshot', { p_session_id: sid });
const votes = (db, who, sid) => rpc(db, who, 'dw_workspace_votes', { p_session_id: sid });
const familyFor = (snapshot, submissionId) => snapshot.families.find(family => family.submissionIds.includes(submissionId));
async function bundle(title = 'Авторская мера поддержки', mechanism = 'Авторское описание меры на основе точной цитаты.') {
  const value = await realPracticeBundle('mordovia-kindergarten-compensation');
  value.practice = { ...value.practice, id: `author-${id()}`, title, mechanism, evidence: [], reviewStatus: 'candidate' };
  return value;
}
const publish = (db, who, sid, material, revision = null, operation = id()) => rpc(db, who, 'dw_publish_submission', {
  p_operation_id: operation, p_session_id: sid, p_local_key: material.practice.id,
  p_expected_revision: revision, p_bundle: material,
});
const moderate = (db, who, sid, submission, status) => rpc(db, who, 'dw_moderate_submission', {
  p_operation_id: id(), p_session_id: sid, p_submission_id: submission.id,
  p_expected_revision: submission.revision, p_status: status,
});
const saveFamily = (db, who, sid, current, target, submissionIds, title = 'Ручная группа') => rpc(db, who, 'dw_save_family', {
  p_operation_id: id(), p_session_id: sid, p_family_id: target,
  p_expected_board_revision: current.boardRevision, p_title: title,
  p_mechanism: 'Общий механизм, выбранный участниками.', p_rationale: 'Ручное решение участников мастерской.',
  p_submission_ids: submissionIds,
});

test('a published author card is immediately assessable; automatic labels follow republishing without duplicating sources or groups', async () => {
  const db = await createTestDatabase();
  try {
    const a = await actor(db), sid = (await enter(db, a)).session.id;
    const material = await bundle();
    const operation = id();
    const published = await publish(db, a, sid, material, null, operation);
    let submission = published.submissions.find(item => item.localKey === material.practice.id);
    let current = await board(db, a, sid);
    const family = familyFor(current, submission.id);
    assert(family);
    assert.deepEqual(family.submissionIds, [submission.id]);
    assert.equal(family.title, material.practice.title);
    assert.equal(family.mechanism, material.practice.mechanism);
    assert.equal((await db.query('select automatic_submission_id from private.dw_practice_families where id=$1', [family.id])).rows[0].automatic_submission_id, submission.id);
    const replayBefore = current;
    await publish(db, a, sid, material, null, operation);
    assert.deepEqual(await board(db, a, sid), replayBefore);
    let result = await votes(db, a, sid);
    let rated = result.families.find(item => item.familyId === family.id);
    assert(rated);
    await rpc(db, a, 'dw_workspace_vote', { p_operation_id: id(), p_session_id: sid, p_family_id: family.id,
      p_value: 1, p_expected_revision: 0, p_expected_fingerprint: rated.fingerprint });
    const edited = structuredClone(material);
    edited.practice.title = 'Уточнённое название авторской меры';
    edited.practice.mechanism = 'Уточнённое автором содержание меры с теми же неизменными цитатами.';
    const saved = await publish(db, a, sid, edited, submission.revision);
    submission = saved.submissions.find(item => item.id === submission.id);
    current = await board(db, a, sid);
    const updated = familyFor(current, submission.id);
    assert.equal(updated.id, family.id);
    assert.equal(updated.title, edited.practice.title);
    assert.equal(updated.mechanism, edited.practice.mechanism);
    assert.equal(current.families.length, 1);
    assert.deepEqual(submission.bundle.practice, edited.practice);
    assert.deepEqual(submission.bundle.occurrences, material.occurrences);
    result = await votes(db, a, sid);
    rated = result.families.find(item => item.familyId === family.id);
    assert.equal(rated.support, 0);
    assert.equal(rated.needsReview, true);
    assert.equal(rated.myVote, null);
    assert.equal(rated.myVoteRevision, 1);
    await rejected(publish(db, a, sid, material, 1), 'REVISION_CONFLICT');
    assert.deepEqual(await board(db, a, sid), current);
    const oversized = await bundle('Название '.repeat(50), 'Описание '.repeat(700));
    const longPublished = await publish(db, a, sid, oversized);
    const longSubmission = longPublished.submissions.find(item => item.localKey === oversized.practice.id);
    const longFamily = familyFor(await board(db, a, sid), longSubmission.id);
    assert.equal(Array.from(longFamily.title).length, 300);
    assert.equal(Array.from(longFamily.mechanism).length, 4000);
    assert(longFamily.title.endsWith('…') && longFamily.mechanism.endsWith('…'));
    assert.equal(longSubmission.bundle.practice.title, oversized.practice.title);
    assert.equal(longSubmission.bundle.practice.mechanism, oversized.practice.mechanism);
    assert.equal((await db.query("select has_function_privilege('authenticated','private.dw_s23_ensure_author_family(uuid,uuid,uuid)','EXECUTE') allowed")).rows[0].allowed, false);
  } finally { await db.close(); }
});

test('manual singleton edits and merged groups remain authoritative; withdraw/restore retains membership and requires vote review', async () => {
  const db = await createTestDatabase();
  try {
    const a = await actor(db), teacher = await actor(db, 'omnistat@yandex.ru');
    const sid = (await enter(db, a)).session.id;
    await enter(db, teacher);
    const first = await bundle('Первая авторская мера');
    const second = await bundle('Вторая авторская мера');
    let published = await publish(db, a, sid, first);
    const firstId = published.submissions.find(item => item.localKey === first.practice.id).id;
    published = await publish(db, a, sid, second);
    const secondId = published.submissions.find(item => item.localKey === second.practice.id).id;
    let current = await board(db, a, sid);
    const autoFamily = familyFor(current, firstId);
    current = await saveFamily(db, a, sid, current, autoFamily.id, [firstId], 'Название, выбранное группой');
    assert.equal((await db.query('select automatic_submission_id from private.dw_practice_families where id=$1', [autoFamily.id])).rows[0].automatic_submission_id, null);
    first.practice.title = 'Новое название только исходной карточки';
    let source = published.submissions.find(item => item.id === firstId);
    published = await publish(db, a, sid, first, source.revision);
    current = await board(db, a, sid);
    assert.equal(familyFor(current, firstId).title, 'Название, выбранное группой');
    const sourceFamily = familyFor(current, secondId);
    const oldVote = (await votes(db, a, sid)).families.find(item => item.familyId === sourceFamily.id);
    await rpc(db, a, 'dw_workspace_vote', { p_operation_id: id(), p_session_id: sid, p_family_id: sourceFamily.id,
      p_value: 1, p_expected_revision: 0, p_expected_fingerprint: oldVote.fingerprint });
    current = await saveFamily(db, a, sid, current, autoFamily.id, [firstId, secondId], 'Объединённая ручная группа');
    assert.equal(current.families.length, 2, 'the empty former group and its vote history remain stored');
    assert.deepEqual(current.families.find(item => item.id === sourceFamily.id).submissionIds, []);
    assert.equal((await db.query('select automatic_submission_id from private.dw_practice_families where id=$1', [sourceFamily.id])).rows[0].automatic_submission_id, null);
    assert.equal((await db.query('select count(*)::int n from private.dw_workspace_votes where family_id=$1', [sourceFamily.id])).rows[0].n, 1);
    second.practice.title = 'Уточнённая вторая карточка';
    source = published.submissions.find(item => item.id === secondId);
    published = await publish(db, a, sid, second, source.revision);
    current = await board(db, a, sid);
    assert.equal(familyFor(current, secondId).title, 'Объединённая ручная группа');
    assert.deepEqual(familyFor(current, secondId).submissionIds.sort(), [firstId, secondId].sort());
    const voting = (await votes(db, a, sid)).families.find(item => item.familyId === autoFamily.id);
    await rpc(db, a, 'dw_workspace_vote', { p_operation_id: id(), p_session_id: sid, p_family_id: autoFamily.id,
      p_value: 1, p_expected_revision: 0, p_expected_fingerprint: voting.fingerprint });
    source = published.submissions.find(item => item.id === secondId);
    const hidden = await moderate(db, teacher, sid, source, 'withdrawn');
    const hiddenSource = hidden.submissions.find(item => item.id === secondId);
    const restored = await moderate(db, teacher, sid, hiddenSource, 'shared');
    assert.equal(restored.submissions.find(item => item.id === secondId).status, 'shared');
    current = await board(db, a, sid);
    assert.equal(familyFor(current, secondId).id, autoFamily.id);
    assert.equal(familyFor(current, secondId).title, 'Объединённая ручная группа');
    assert.equal(current.families.length, 2);
    const afterRestore = (await votes(db, a, sid)).families.find(item => item.familyId === autoFamily.id);
    assert.equal(afterRestore.support, 0);
    assert.equal(afterRestore.needsReview, true);
  } finally { await db.close(); }
});

test('upgrade backfills only current shared ungrouped authors and preserves legacy rounds, manual/catalog groups, votes and original publications', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(`${projectRoot}/tests/database/bootstrap.sql`, 'utf8'));
    for (const file of (await readdir(`${projectRoot}/supabase/migrations`)).filter(name => name.endsWith('.sql') && name < migration).sort())
      await db.exec(await readFile(`${projectRoot}/supabase/migrations/${file}`, 'utf8'));
    await seedCanonicalDocument(db, await loadMordovia());
    const teacher = await actor(db, 'omnistat@yandex.ru'), a = await actor(db);
    const historical = await rpc(db, teacher, 'dw_create_session', { p_operation_id: id(), p_title: 'Архивный раунд', p_scope: 'region', p_region_id: 'respublika-mordoviia' });
    const historicalId = historical.session.id;
    const oldMaterial = await bundle('Историческая карточка');
    const oldPublished = await publish(db, teacher, historicalId, oldMaterial);
    let historicalBoard = await board(db, teacher, historicalId);
    historicalBoard = await saveFamily(db, teacher, historicalId, historicalBoard, null, [oldPublished.submissions[0].id]);
    const historicalState = await rpc(db, teacher, 'dw_session_snapshot', { p_session_id: historicalId });
    await rpc(db, teacher, 'dw_update_session', { p_operation_id: id(), p_session_id: historicalId,
      p_expected_revision: historicalState.session.revision, p_patch: { phase: 'discussion' } });
    await rpc(db, teacher, 'dw_open_voting_round', { p_operation_id: id(), p_session_id: historicalId,
      p_title: 'Зафиксированный исторический раунд', p_results_visibility: 'after_close',
      p_expected_board_revision: historicalBoard.boardRevision, p_settings: {} });
    const sid = (await enter(db, a)).session.id;
    assert.notEqual(sid, historicalId);
    await enter(db, teacher);
    const ungrouped = await bundle('Старая неподгруппированная авторская карточка');
    const withdrawn = await bundle('Старая снятая авторская карточка');
    const manual = await bundle('Ранее вручную сгруппированная карточка');
    await publish(db, a, sid, ungrouped);
    let before = await publish(db, a, sid, withdrawn);
    const withdrawnId = before.submissions.find(item => item.localKey === withdrawn.practice.id).id;
    await moderate(db, teacher, sid, before.submissions.find(item => item.id === withdrawnId), 'withdrawn');
    before = await publish(db, a, sid, manual);
    const manualId = before.submissions.find(item => item.localKey === manual.practice.id).id;
    let current = await board(db, a, sid);
    current = await saveFamily(db, a, sid, current, null, [manualId], 'Сохранённая ручная группа');
    const manualFamily = familyFor(current, manualId);
    const vote = (await votes(db, a, sid)).families.find(item => item.familyId === manualFamily.id);
    await rpc(db, a, 'dw_workspace_vote', { p_operation_id: id(), p_session_id: sid, p_family_id: manualFamily.id,
      p_value: 1, p_expected_revision: 0, p_expected_fingerprint: vote.fingerprint });
    const catalogue = await loadFamilyCatalogMaterial();
    await seedFamilyCatalog(db, catalogue);
    await rpc(db, a, 'dw_select_catalog_practice', { p_operation_id: id(), p_session_id: sid, p_catalog_id: catalogue.cards[0].catalog_id });
    const oldPublications = (await db.query('select * from public.dw_submissions order by id')).rows;
    const oldMemberships = (await db.query('select * from private.dw_family_members order by session_id,submission_id')).rows;
    const oldFamilies = (await db.query('select * from private.dw_practice_families order by id')).rows;
    const oldVotes = (await db.query('select * from private.dw_workspace_votes order by session_id,family_id,actor_id')).rows;
    const oldRounds = (await db.query('select * from private.dw_round_families order by round_id,family_id')).rows;
    await db.exec(await readFile(`${projectRoot}/supabase/migrations/${migration}`, 'utf8'));
    assert.deepEqual((await db.query('select * from public.dw_submissions order by id')).rows, oldPublications);
    assert.deepEqual((await db.query('select * from private.dw_workspace_votes order by session_id,family_id,actor_id')).rows, oldVotes);
    assert.deepEqual((await db.query('select * from private.dw_round_families order by round_id,family_id')).rows, oldRounds);
    for (const family of oldFamilies) {
      const { automatic_submission_id: _automatic, ...after } = (await db.query('select * from private.dw_practice_families where id=$1', [family.id])).rows[0];
      assert.deepEqual(after, family);
    }
    const afterMemberships = (await db.query('select * from private.dw_family_members order by session_id,submission_id')).rows;
    for (const membership of oldMemberships) assert(afterMemberships.some(item => JSON.stringify(item) === JSON.stringify(membership)));
    current = await board(db, a, sid);
    const source = oldPublications.find(item => item.local_key === ungrouped.practice.id);
    assert.equal(familyFor(current, source.id).title, ungrouped.practice.title);
    assert.equal(familyFor(current, withdrawnId), undefined);
    assert.equal(familyFor(current, manualId).id, manualFamily.id);
    assert.equal((await votes(db, a, sid)).families.find(item => item.familyId === manualFamily.id).support, 1);
    assert.deepEqual((await board(db, teacher, historicalId)).families, historicalBoard.families);
    const hidden = oldPublications.find(item => item.id === withdrawnId);
    await moderate(db, teacher, sid, { ...hidden, revision: hidden.revision }, 'shared');
    assert.equal(familyFor(await board(db, a, sid), withdrawnId).title, withdrawn.practice.title);
    assert.equal((await db.query('select count(*)::int n from private.dw_practice_families where session_id=$1', [historicalId])).rows[0].n, 1);
  } finally { await db.close(); }
});
