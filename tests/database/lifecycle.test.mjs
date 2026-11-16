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

    const current = unused.barriers.find(value => value.id === card.id);
    const edit = {
      barrierId: current.id, expectedRevision: current.revision, title: 'Неопределённость при планировании семьи',
      description: 'Пояснение после обсуждения', primaryStage: current.primaryStage, stageIds: current.stageIds,
      evidenceKind: current.evidenceKind, status: current.status, priority: current.priority,
    };
    await assert.rejects(mutate(first, 'dw_save_barrier', edit), error => error.message === 'FORBIDDEN');
    const renamed = await mutate(second, 'dw_save_barrier', edit);
    const revised = renamed.barriers.find(value => value.id === card.id);
    assert.equal(revised.title, edit.title);
    assert.equal(revised.description, edit.description);
    assert.equal(revised.sourceNoteId, red.id);
    assert.deepEqual(revised.stageIds, current.stageIds);
    assert.deepEqual(renamed.links[0].staleReasons, ['barrier_changed']);
    const { rows: [original] } = await db.query('select text from private.dw_flipchart_notes where id=$1', [red.id]);
    assert.equal(original.text, red.text);
    await assert.rejects(mutate(second, 'dw_save_barrier', edit), error => error.message === 'REVISION_CONFLICT');

    await set(second, 'author', brief.id, card.id, true);
    await set(second, 'author', brief.id, secondBarrier.id, true);
    const replacement = (await mutate(first, 'dw_flipchart_add', { kind: 'condition', text: 'Услуги присмотра' })).note;
    await set(first, 'factor', replacement.id, card.id, true);
    await set(first, 'factor', replacement.id, secondBarrier.id, true);
    const remove = { ...edit, expectedRevision: revised.revision, status: 'archived' };
    await assert.rejects(mutate(first, 'dw_save_barrier', remove), error => error.message === 'FORBIDDEN');
    const removed = await mutate(second, 'dw_save_barrier', remove);
    assert.equal(removed.barriers.find(value => value.id === card.id).status, 'archived');
    assert.deepEqual(removed.greenFactorLinks.map(link => link.barrierId), [secondBarrier.id]);
    assert.deepEqual(removed.solutions[0].barrierIds, [secondBarrier.id]);
    assert(removed.links[0].staleReasons.includes('barrier_archived'));
  } finally {
    await db.close();
  }
});

test('the live lifecycle accepts a class-sized board while preserving its archived entries', async (testContext) => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const actor = await identify(db, 'Участник проверки вместимости');
    const call = (method, params) => anonymous(db, 'select public.dw_entry_rpc($1,$2,$3::jsonb) result',
      [actor.access_token, method, JSON.stringify(params)]);
    const operation = () => ({ p_operation_id: randomUUID() });
    const { session: { id: sid } } = await call('dw_enter_workspace', operation());
    const scoped = { p_session_id: sid };
    const save = (method, p_input) => call(method, { ...scoped, ...operation(), p_input });
    const limited = (result) => assert.rejects(result,
      (error) => error.code === 'P0001' && error.message === 'BOARD_LIMIT');
    const actorScope = [sid, actor.user.id];
    const barrierDraft = {
      barrierId: null, expectedRevision: 0, title: 'Недоступность услуг присмотра',
      description: 'Родителям трудно подобрать учреждение с подходящим графиком.',
      primaryStage: 'preschool', stageIds: ['preschool'], evidenceKind: 'hypothesis', status: 'active', priority: false,
    };
    await db.query(`insert into private.dw_barriers
      (session_id,author_id,title,description,primary_stage,stage_ids,evidence_kind,status)
      select $1,$2,'Наблюдение семей '||i,'Родителям трудно найти свободное место в детском саду.',
        'preschool',array['preschool'],'hypothesis',case when i<=498 then 'active' else 'archived' end
      from generate_series(1,520) i`, actorScope);
    const written = await save('dw_save_barrier', barrierDraft);
    assert.equal(written.barriers.filter(({ status }) => status === 'active').length, 499);
    const candidate = written.barriers.find(({ title }) => title === barrierDraft.title);
    const { note } = await save('dw_flipchart_add', { kind: 'barrier', text: 'Высокая стоимость присмотра' });
    const imported = await save('dw_import_flipchart_barrier', { noteId: note.id, stageIds: ['preschool'] });
    assert.equal(imported.barriers.filter(({ status }) => status === 'active').length, 500);
    assert.equal(imported.barriers.filter(({ status }) => status === 'archived').length, 22);
    await limited(save('dw_save_barrier', barrierDraft));
    const retired = await save('dw_save_barrier', {
      ...barrierDraft, barrierId: candidate.id, expectedRevision: candidate.revision, status: 'archived',
    });
    const archived = retired.barriers.find(({ id }) => id === candidate.id);
    const replaced = await save('dw_save_barrier', { ...barrierDraft, title: 'Несовместимый график детского сада' });
    assert.equal(replaced.barriers.filter(({ status }) => status === 'archived').length, 23);
    await limited(save('dw_save_barrier', { ...barrierDraft, barrierId: archived.id, expectedRevision: archived.revision }));

    await db.query(`insert into private.dw_solutions(
      session_id,author_id,barrier_ids,title,target_group,mechanism,first_step,responsible,resources,success_indicator,risks,status,brief)
      select $1,$2,'{}','Ясельная группа '||i,'Семьи с детьми','Продление часов работы ясельной группы',
        'Уточнить спрос','Управление образования','Помещения и сотрудники','Число мест в яслях','',
        case when i<=499 then 'active' else 'archived' end,true from generate_series(1,518) i`, actorScope);
    const authorDraft = { solutionId: null, expectedRevision: 0, format: 'brief', barrierIds: [],
      title: 'Дополнительная группа присмотра', mechanism: '', targetGroup: '', firstStep: '',
      responsible: '', resources: '', successIndicator: '', risks: '', status: 'active' };
    const authorResult = await save('dw_save_solution', authorDraft);
    assert.equal(authorResult.solutions.filter(({ status }) => status === 'active').length, 500);
    assert.equal(authorResult.solutions.filter(({ status }) => status === 'archived').length, 19);
    await limited(save('dw_save_solution', authorDraft));

    const catalog = await loadFamilyCatalogMaterial();
    await seedFamilyCatalog(db, catalog);
    const examples = Array.from(new Map(catalog.cards.map(card => [card.group_key, card])).values()).slice(0, 3);
    for (const card of examples) {
      await call('dw_select_catalog_practice', { ...scoped, ...operation(), p_catalog_id: card.catalog_id });
    }
    const { families, barriers } = await call('dw_barriers_snapshot', scoped);
    const active = barriers.find(({ status }) => status === 'active');
    const linkInput = (b, f) => ({
      linkId: null, expectedRevision: 0, barrierId: b.id, expectedBarrierRevision: b.revision,
      familyId: f.id, expectedFamilyFingerprint: f.fingerprint,
      relationship: 'potential', explanation: '', prerequisites: '', status: 'active',
    });
    for (const family of families) await save('dw_save_barrier_link', linkInput(active, family));
    await db.query(`insert into private.dw_barrier_links
      (session_id,barrier_id,family_id,author_id,relationship,explanation,prerequisites,status,barrier_content_revision,evidence_id)
      select $1,b.id,e.family_id,$2,'potential','','',
        b.status,b.content_revision,e.id
      from private.dw_barriers b join private.dw_barrier_evidence e on e.session_id=b.session_id
      where b.session_id=$1 and not exists (select 1 from private.dw_barrier_links l where l.barrier_id=b.id and l.family_id=e.family_id)
      order by b.status desc,b.id,e.id limit 1565`, actorScope);
    const nearCapacity = await call('dw_barriers_snapshot', scoped);
    const archivedLinks = nearCapacity.links.filter(({ status }) => status === 'archived').length;
    assert.equal(archivedLinks, 69);
    assert.equal(nearCapacity.links.filter(({ status }) => status === 'active').length, 1499);
    const pair = nearCapacity.barriers.filter(({ status }) => status === 'active').flatMap(barrier =>
      families.map(family => [barrier, family])).find(([b, f]) =>
      !nearCapacity.links.some(link => link.barrierId === b.id && link.familyId === f.id));
    const full = await save('dw_save_barrier_link', linkInput(...pair));
    assert.equal(full.links.filter(({ status }) => status === 'active').length, 1500);
    assert.equal(full.links.filter(({ status }) => status === 'archived').length, archivedLinks);
    const savedLink = full.links.find(link => link.barrierId === pair[0].id && link.familyId === pair[1].id);
    assert.equal((await save('dw_save_barrier_link', linkInput(...pair))).cursor, full.cursor);
    await limited(save('dw_save_barrier_link', { ...linkInput(...pair), explanation: 'Мера может помочь расширить график работы.' }));
    const updated = await save('dw_save_barrier_link', { ...linkInput(...pair),
      linkId: savedLink.id, expectedRevision: savedLink.revision, status: 'archived' });
    assert.equal(updated.links.find(link => link.id === savedLink.id).status, 'archived');
    assert.equal(updated.links.filter(({ status }) => status === 'active').length, 1499);
    const snapshotBytes = Buffer.byteLength(JSON.stringify(full));
    assert(snapshotBytes < 2 * 1024 * 1024);
    testContext.diagnostic(`Full classroom board JSON size: ${snapshotBytes} bytes`);
  } finally {
    await db.close();
  }
});
