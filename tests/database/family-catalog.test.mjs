import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from './harness.mjs';
import { loadFamilyCatalogMaterial, seedFamilyCatalog } from '../../scripts/seed-family-catalog.mjs';

async function asAnonymous(db, sql, parameters) {
  return db.transaction(async tx => {
    await tx.exec('set local role anon');
    return (await tx.query(sql, parameters)).rows[0]?.result;
  });
}
async function identify(db, email = `${randomUUID()}@example.test`) {
  const { session } = await asAnonymous(db, 'select public.dw_identify($1,$2) result', [email, 'Участник испытания']);
  return session.access_token;
}
const call = (db, token, method, args) => asAnonymous(db,
  'select public.dw_entry_rpc($1,$2,$3::jsonb) result', [token, method, JSON.stringify(args)]);
const rejected = (promise, code) => assert.rejects(promise, error => error.code === 'P0001' && error.message === code);

test('the declared-identity workshop selects sealed catalogue cards once and ranks separate regional variants together', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const material = await loadFamilyCatalogMaterial();
    const [first, ...others] = material.cards.filter(card => card.group_key === 'regional-maternal-capital');
    const second = others.find(card => card.bundle.practice.regionId !== first.bundle.practice.regionId);
    const third = others.find(card => card !== second && card.bundle.practice.regionId !== first.bundle.practice.regionId
      && card.bundle.practice.regionId !== second.bundle.practice.regionId);
    const federal = material.cards.find(card => card.bundle.practice.regionId === 'federal');
    assert(first && second && third && federal);

    const a = await identify(db);
    const b = await identify(db);
    const teacher = await identify(db, 'omnistat@yandex.ru');
    const old = await call(db, teacher, 'dw_create_session', {
      p_operation_id: randomUUID(), p_title: 'Архив', p_scope: 'region', p_region_id: 'respublika-mordoviia',
    });
    await call(db, teacher, 'dw_update_session', {
      p_operation_id: randomUUID(), p_session_id: old.session.id, p_expected_revision: old.session.revision,
      p_patch: { status: 'closed' },
    });
    const enter = token => call(db, token, 'dw_enter_workspace', { p_operation_id: randomUUID() });
    const { session } = await enter(a);
    await enter(b);
    await enter(teacher);
    assert.notEqual(session.id, old.session.id);
    const select = (token, id, op = randomUUID(), sessionId = session.id) => call(db, token, 'dw_select_catalog_practice', {
      p_operation_id: op, p_catalog_id: id, p_session_id: sessionId,
    });
    await rejected(select(a, first.catalog_id), 'NOT_FOUND');
    assert.equal(await seedFamilyCatalog(db, material), material.cards.length);
    assert.equal(await seedFamilyCatalog(db, material), material.cards.length);
    const { rows: [registry] } = await db.query(`select count(*)::int as cards,
      bool_and(bundle->'occurrences'='[]'::jsonb) as contains_no_invented_quotes,
      sum(octet_length(bundle::text))::int as bundle_bytes,
      has_table_privilege('authenticated','private.dw_family_catalog','SELECT') as public_access
      from private.dw_family_catalog`);
    assert.equal(registry.cards, material.cards.length);
    assert.equal(registry.contains_no_invented_quotes, true);
    assert.equal(registry.public_access, false);
    assert(registry.bundle_bytes <= 4194304, 'all canonical catalogue cards must fit the session storage limit');
    await rejected(select(teacher, first.catalog_id, randomUUID(), old.session.id), 'FORBIDDEN');
    await rejected(select(a, 'absent-catalogue-id'), 'NOT_FOUND');

    const op = randomUUID();
    const selected = await select(a, first.catalog_id, op);
    const submission = selected.submissions[0];
    assert.deepEqual(submission.bundle, first.bundle);
    await rejected(db.query(`update public.dw_submissions set bundle=jsonb_set(bundle,'{practice,title}','"Подмена"')
      where id=$1`, [submission.id]), 'FORBIDDEN');
    const replay = await select(a, first.catalog_id, op);
    const duplicate = await select(b, first.catalog_id);
    assert.equal(replay.cursor, selected.cursor);
    assert.equal(duplicate.cursor, selected.cursor);
    assert.equal(duplicate.submissions.length, 1);
    await rejected(select(a, second.catalog_id, op), 'IDEMPOTENCY_CONFLICT');

    await select(b, second.catalog_id);
    await select(b, federal.catalog_id);
    const board = await call(db, a, 'dw_workshop_snapshot', { p_session_id: session.id });
    const regionalFamily = board.families.find(family => family.submissionIds.length === 2);
    assert.equal(regionalFamily.title, first.group_title);
    assert.equal(board.families.length, 2);
    const votes = await call(db, a, 'dw_workspace_votes', { p_session_id: session.id });
    assert.equal(votes.families.length, 2);
    const ranked = votes.families.find(family => family.familyId === regionalFamily.id);
    assert.equal(ranked.title, first.group_title);
    const voting = await call(db, a, 'dw_workspace_vote', {
      p_operation_id: randomUUID(), p_session_id: session.id, p_family_id: ranked.familyId,
      p_value: 1, p_expected_revision: 0, p_expected_fingerprint: ranked.fingerprint,
    });
    assert.equal(voting.families.find(family => family.familyId === ranked.familyId).support, 1);

    const published = await call(db, a, 'dw_session_snapshot', { p_session_id: session.id });
    const secondSubmission = published.submissions.find(row => row.bundle.catalogSource.id === second.catalog_id);
    await call(db, a, 'dw_save_family', {
      p_operation_id: randomUUID(), p_session_id: session.id, p_family_id: null,
      p_expected_board_revision: board.boardRevision, p_title: 'Отдельный вариант после обсуждения',
      p_mechanism: 'Сохраняем отдельно', p_rationale: 'Условие отличается', p_submission_ids: [secondSubmission.id],
    });
    await select(a, third.catalog_id);
    const split = await call(db, a, 'dw_workshop_snapshot', { p_session_id: session.id });
    assert.equal(split.families.length, 4);
    assert(split.families.every(family => family.submissionIds.length === 1));
    const withdraw = { p_operation_id: randomUUID(), p_session_id: session.id, p_submission_id: submission.id,
      p_expected_revision: submission.revision, p_status: 'withdrawn' };
    await rejected(call(db, a, 'dw_moderate_submission', withdraw), 'FORBIDDEN');
    await call(db, teacher, 'dw_moderate_submission', { ...withdraw, p_operation_id: randomUUID() });
    await rejected(select(b, first.catalog_id), 'FORBIDDEN');
    await call(db, teacher, 'dw_moderate_submission', {
      ...withdraw, p_operation_id: randomUUID(), p_expected_revision: submission.revision + 1, p_status: 'shared',
    });
    assert((await select(b, first.catalog_id)).submissions.some(row => row.id === submission.id && row.status === 'shared'));
  } finally {
    await db.close();
  }
});
