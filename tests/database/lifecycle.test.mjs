import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from './harness.mjs';
import { loadFamilyCatalogMaterial, seedFamilyCatalog } from '../../scripts/seed-family-catalog.mjs';

async function anonymous(db, sql, params) {
  return db.transaction(async tx => {
    await tx.exec('set local role anon');
    return (await tx.query(sql, params)).rows[0].result;
  });
}
async function identify(db, name, email = `${randomUUID()}@example.test`) {
  const { session } = await anonymous(db, 'select public.dw_identify($1,$2) result', [email, name]);
  return session;
}

test('members classify earlier anonymous notes and link any measure to multiple barriers', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const first = await identify(db, 'Автор исходной мысли');
    const second = await identify(db, 'Участник классификации');
    const call = (actor, method, params) => anonymous(db, 'select public.dw_entry_rpc($1,$2,$3::jsonb) result',
      [actor.access_token, method, JSON.stringify(params)]);
    const { session } = await call(first, 'dw_enter_workspace', { p_operation_id: randomUUID() });
    const p_session_id = session.id;
    const enter = actor => call(actor, 'dw_enter_workspace', { p_operation_id: randomUUID() });
    await enter(second);
    const mutate = (actor, method, p_input) => call(actor, method, { p_operation_id: randomUUID(), p_session_id, p_input });
    const read = (actor, method) => call(actor, method, { p_session_id });
    const red = (await mutate(first, 'dw_flipchart_add', { kind: 'barrier', text: 'СВО' })).note;
    const green = (await mutate(first, 'dw_flipchart_add', { kind: 'condition', text: 'Присмотр за детьми' })).note;
    const imported = await mutate(second, 'dw_import_flipchart_barrier', { noteId: red.id, stageIds: ['work', 'first_child'] });
    assert.equal(imported.barriers.length, 1);
    const card = imported.barriers[0];
    assert.equal(card.title, red.text);
    assert.equal(card.authorId, second.user.id);
    assert.equal(card.sourceNoteId, red.id);
    assert.equal(card.sourceBoard, 'parenthood');
    assert.notEqual(card.authorId, first.user.id);
    const duplicate = await mutate(first, 'dw_import_flipchart_barrier', { noteId: red.id, stageIds: ['work'] });
    assert.equal(duplicate.cursor, imported.cursor);

    const source = await loadFamilyCatalogMaterial();
    await seedFamilyCatalog(db, source);
    await call(first, 'dw_select_catalog_practice', {
      p_session_id, p_operation_id: randomUUID(), p_catalog_id: source.cards[0].catalog_id,
    });
    const { families: [family] } = await read(first, 'dw_barriers_snapshot');
    const quick = { linkId: null, expectedRevision: 0, barrierId: card.id, expectedBarrierRevision: card.revision,
      familyId: family.id, expectedFamilyFingerprint: family.fingerprint, relationship: 'potential', explanation: '',
      prerequisites: '', status: 'active' };
    const connected = await mutate(first, 'dw_save_barrier_link', quick);
    assert.equal(connected.links.length, 1);
    const deduped = await mutate(second, 'dw_save_barrier_link', quick);
    assert.equal(deduped.links.length, 1);
    assert.equal(deduped.cursor, connected.cursor);

    const extended = await mutate(first, 'dw_import_flipchart_barrier', { noteId: red.id, stageIds: ['school', 'second_child'] });
    assert.equal(extended.barriers.length, 1);
    assert.deepEqual(extended.barriers[0].stageIds, ['work', 'first_child', 'school', 'second_child']);
    assert.equal(extended.barriers[0].contentRevision, card.contentRevision);
    assert.deepEqual(extended.links[0].staleReasons, []);
    const edited = await mutate(first, 'dw_save_barrier', {
      barrierId: card.id, expectedRevision: extended.barriers[0].revision, title: card.title, description: card.description,
      primaryStage: 'pregnancy', stageIds: ['pregnancy'], evidenceKind: card.evidenceKind, status: card.status, priority: card.priority,
    });
    assert.deepEqual(edited.barriers[0].stageIds, ['pregnancy']);
    assert.deepEqual(edited.links[0].staleReasons, []);

    const manual = await mutate(second, 'dw_save_barrier', {
      barrierId: null, expectedRevision: 0, title: 'Сложности с занятостью', description: '',
      primaryStage: 'work', stageIds: ['work'], evidenceKind: 'observation', status: 'active', priority: false,
    });
    const secondBarrier = manual.barriers.find(value => value.id !== card.id);
    const set = (actor, kind, measureId, barrierId, linked) => mutate(actor, 'dw_set_solution_barrier', { kind, measureId, barrierId, linked });
    await set(first, 'factor', green.id, card.id, true);
    const greenLinks = await set(second, 'factor', green.id, secondBarrier.id, true);
    assert.equal(greenLinks.greenFactorLinks.length, 2);
    const projected = await read(second, 'dw_barriers_projector_snapshot');
    assert.deepEqual(projected.greenFactorLinks, greenLinks.greenFactorLinks);
    assert.equal(projected.greenFactorLinks[0].title, green.text);
    const redLink = set(first, 'factor', red.id, card.id, true);
    await assert.rejects(redLink, error => error.code === 'P0001' && error.message === 'NOT_FOUND');
    await call(first, 'dw_flipchart_status', { p_session_id, p_operation_id: randomUUID(), p_note_id: green.id,
      p_expected_revision: green.revision, p_input: { status: 'withdrawn' } });
    const hidden = await read(second, 'dw_barriers_snapshot');
    assert(hidden.cursor > greenLinks.cursor);
    assert.deepEqual(hidden.greenFactorLinks, []);

    const { solutions: [brief] } = await mutate(first, 'dw_save_solution', {
      solutionId: null, expectedRevision: 0, format: 'brief', barrierIds: [card.id, secondBarrier.id], title: 'ЭКО',
      mechanism: '', targetGroup: '', firstStep: '', responsible: '', resources: '', successIndicator: '', risks: '', status: 'active',
    });
    assert.equal(brief.title, 'ЭКО');
    assert.equal(brief.format, 'brief');
    assert.equal(brief.barrierIds.length, 2);
    await set(second, 'author', brief.id, card.id, false);
    const unused = await set(second, 'author', brief.id, secondBarrier.id, false);
    assert.deepEqual(unused.solutions[0].barrierIds, []);
    const { rows: [ground] } = await db.query("select private.dw_roadmap_ground($1,'solution',$2) result", [p_session_id, brief.id]);
    assert.deepEqual(ground.result.source.barriers, []);
  } finally {
    await db.close();
  }
});
