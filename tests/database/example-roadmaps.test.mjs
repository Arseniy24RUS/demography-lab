import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from './harness.mjs';
import { loadRoadmapDataset, seedRoadmapDataset } from '../../scripts/seed-roadmaps.mjs';

const id = () => randomUUID();
const rejected = (promise, message) => assert.rejects(promise, error => error.code === 'P0001' && error.message === message);
async function anon(db, sql, args) {
  return db.transaction(async tx => {
    await tx.exec('set local role anon');
    return (await tx.query(sql, args)).rows[0].result;
  });
}
const rpc = (db, token, method, args) => anon(db, 'select public.dw_entry_rpc($1,$2,$3::jsonb) result', [token, method, JSON.stringify(args)]);
const mutation = (db, token, sid, method, input) => rpc(db, token, method, { p_operation_id: id(), p_session_id: sid, p_input: input });
async function identify(db, email) {
  return (await anon(db, 'select public.dw_identify($1,$2) result', [email, 'Проверка демонстрационного проекта'])).session.access_token;
}
test('a named example preserves exact Saransk geography while a normal city team stays independent and writable', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const material = await loadRoadmapDataset({ fixture: true, regionIds: ['respublika-mordoviia'], territoryKeys: ['rudn-mun-72196-904'] });
    await seedRoadmapDataset(db, material, { allowFixture: true });
    const teacher = await identify(db, 'omnistat@yandex.ru');
    const sid = (await rpc(db, teacher, 'dw_enter_workspace', { p_operation_id: id() })).session.id;
    const input = { territoryKey: 'rudn-mun-72196-904', dataEditionId: material.id, expectedAssignmentRevision: 0 };
    let sample = await mutation(db, teacher, sid, 'dw_join_roadmap', input);
    await db.query("update private.dw_roadmaps set example_label='ПРИМЕР' where id=$1", [sample.roadmapId]);
    sample = await rpc(db, teacher, 'dw_roadmap_snapshot', { p_session_id: sid, p_roadmap_id: sample.roadmapId });
    assert.equal(sample.exampleLabel, 'ПРИМЕР');
    assert.equal(sample.canEdit, true);
    const participant = await identify(db, `${id()}@example.test`);
    await rpc(db, participant, 'dw_enter_workspace', { p_operation_id: id() });
    const seen = await rpc(db, participant, 'dw_roadmap_snapshot', { p_session_id: sid, p_roadmap_id: sample.roadmapId });
    assert.equal(seen.canEdit, false);
    assert.deepEqual(seen.territory, sample.territory);
    const passport = sample.items.find(item => item.kind === 'passport');
    const saveInput = { roadmapId: sample.roadmapId, itemId: passport.id, expectedRevision: passport.revision,
      kind: 'passport', data: { ...passport.data, title: 'Не разрешённая правка' }, status: 'active' };
    await rejected(mutation(db, participant, sid, 'dw_save_roadmap_item', saveInput), 'FORBIDDEN');
    const normal = await mutation(db, participant, sid, 'dw_join_roadmap', input);
    assert.notEqual(normal.roadmapId, sample.roadmapId);
    assert.equal(normal.exampleLabel, undefined);
    assert.equal(normal.canEdit, true);
    assert.deepEqual(normal.territory, sample.territory);
    const current = await rpc(db, participant, 'dw_roadmaps_index', { p_session_id: sid });
    assert.equal(current.rooms.length, 2);
    assert.equal(current.rooms.filter(room => room.exampleLabel).length, 1);
    assert.equal(current.myRoadmapId, normal.roadmapId);
    const saved = await mutation(db, teacher, sid, 'dw_save_roadmap_item', { ...saveInput,
      data: { ...passport.data, title: 'ПРИМЕР — демонстрационный проект Саранска' } });
    const frozen = await mutation(db, teacher, sid, 'dw_freeze_roadmap', { roadmapId: sample.roadmapId,
      expectedRevision: saved.revision, title: 'ПРИМЕР', kind: 'submitted' });
    const version = await rpc(db, participant, 'dw_roadmap_version', { p_session_id: sid,
      p_roadmap_id: sample.roadmapId, p_version_id: frozen.versions[0].id });
    assert.equal(version.snapshot.exampleLabel, 'ПРИМЕР');
    assert.deepEqual(version.snapshot.territory, material.territories.find(item => item.material.key === input.territoryKey).material);
    const projector = await rpc(db, teacher, 'dw_roadmaps_projector_snapshot', { p_session_id: sid, p_roadmap_id: sample.roadmapId });
    assert.equal(projector.selected.exampleLabel, 'ПРИМЕР');
    await rejected(mutation(db, participant, sid, 'dw_join_roadmap', { ...input, exampleLabel: 'Подмена', expectedAssignmentRevision: current.assignmentRevision }), 'INVALID_INPUT');
    assert.equal((await db.query('select material from private.dw_roadmap_territories where dataset_id=$1 and territory_key=$2', [material.id, input.territoryKey])).rows[0].material.name, sample.territory.name);
  } finally { await db.close(); }
});
