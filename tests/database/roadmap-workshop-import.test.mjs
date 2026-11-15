import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { loadFamilyCatalogMaterial, seedFamilyCatalog } from '../../scripts/seed-family-catalog.mjs';
import { loadRoadmapDataset, seedRoadmapDataset } from '../../scripts/seed-roadmaps.mjs';
import { createTestDatabase } from './harness.mjs';

test('a team copies selected lifecycle barriers and measures, then edits the project independently', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    async function anonymous(query, args) {
      return db.transaction(async (transaction) => {
        await transaction.exec('set local role anon');
        return (await transaction.query(query, args)).rows[0].result;
      });
    }
    async function identify(name) {
      const identity = await anonymous('select public.dw_identify($1,$2) result', [
        `${randomUUID()}@example.test`, name,
      ]);
      return identity.session.access_token;
    }
    const member = await identify('Участник команды');
    const other = await identify('Участник без команды');
    const call = (token, method, args) => anonymous(
      'select public.dw_entry_rpc($1,$2,$3::jsonb) result', [token, method, JSON.stringify(args)],
    );
    const { session } = await call(member, 'dw_enter_workspace', { p_operation_id: randomUUID() });
    await call(other, 'dw_enter_workspace', { p_operation_id: randomUUID() });
    const p_session_id = session.id;
    const mutate = (method, p_input, token = member, operation = randomUUID()) =>
      call(token, method, { p_session_id, p_operation_id: operation, p_input });
    const rejectCode = (promise, message) => assert.rejects(promise, err => err.code === 'P0001' && err.message === message);

    const dataset = await loadRoadmapDataset();
    await seedRoadmapDataset(db, dataset);
    const territory = dataset.territories.find(({ record }) => record.level === 'municipality'
      && record.regionId === 'respublika-mordoviia').record.territoryKey;
    const room = await mutate('dw_join_roadmap', {
      territoryKey: territory, dataEditionId: dataset.id, expectedAssignmentRevision: 0,
    });
    const roadmapId = room.roadmapId;
    const snapshot = () => call(member, 'dw_roadmap_snapshot', { p_session_id, p_roadmap_id: roadmapId });
    const save = (item, data) => mutate('dw_save_roadmap_item', {
      roadmapId, itemId: item.id, expectedRevision: item.revision, kind: item.kind, data, status: 'active',
    });
    const diagnosis = (view) => view.items.find(({ kind }) => kind === 'diagnosis');
    const activities = (view) => view.items.filter(({ kind }) => kind === 'activity');
    await save(diagnosis(room), { ...diagnosis(room).data, problem: 'Первоначальный текст команды.' });

    const red = (await mutate('dw_flipchart_add', { kind: 'barrier', text: 'Сложно совмещать работу и уход' })).note;
    const { barriers: [first] } = await mutate('dw_import_flipchart_barrier', {
      noteId: red.id, stageIds: ['work', 'first_child'],
    });
    const next = await mutate('dw_save_barrier', {
      barrierId: null, expectedRevision: 0, title: 'Не хватает мест в группах продлённого дня',
      description: 'Трудность отмечена на обсуждении.', primaryStage: 'school', stageIds: ['school'],
      evidenceKind: 'observation', status: 'active', priority: false,
    });
    const second = next.barriers.find((value) => value.id !== first.id);
    const green = (await mutate('dw_flipchart_add', { kind: 'condition', text: 'Гибкий график для родителей' })).note;
    const unattached = (await mutate('dw_flipchart_add', { kind: 'condition', text: 'Кружок по субботам' })).note;
    for (const barrier of [first, second]) {
      await mutate('dw_set_solution_barrier', { kind: 'factor', measureId: green.id, barrierId: barrier.id, linked: true });
    }
    const { solutions: [solution] } = await mutate('dw_save_solution', {
      solutionId: null, expectedRevision: 0, format: 'brief', barrierIds: [first.id, second.id],
      title: 'Послеурочный присмотр', mechanism: 'Открыть переговоры с родителями.',
      targetGroup: '', firstStep: '', responsible: '', resources: '', successIndicator: '', risks: '', status: 'active',
    });

    const catalogue = await loadFamilyCatalogMaterial();
    await seedFamilyCatalog(db, catalogue);
    await call(member, 'dw_select_catalog_practice', {
      p_session_id, p_operation_id: randomUUID(), p_catalog_id: catalogue.cards[0].catalog_id,
    });
    const { families: [family] } = await call(member, 'dw_barriers_snapshot', { p_session_id });
    for (const barrier of [first, second]) {
      await mutate('dw_save_barrier_link', {
        linkId: null, expectedRevision: 0, barrierId: barrier.id, expectedBarrierRevision: barrier.revision,
        familyId: family.id, expectedFamilyFingerprint: family.fingerprint, relationship: 'potential',
        explanation: '', prerequisites: '', status: 'active',
      });
    }
    const input = {
      roadmapId,
      barrierIds: [first.id, second.id],
      measures: [{ kind: 'family', id: family.id }, { kind: 'factor', id: green.id }, { kind: 'solution', id: solution.id }],
    };
    await rejectCode(mutate('dw_import_roadmap_workshop', input, other), 'ROADMAP_ROOM_REQUIRED');
    await rejectCode(mutate('dw_import_roadmap_workshop', {
      ...input, measures: [...input.measures, { kind: 'factor', id: unattached.id }],
    }), 'SOURCE_STALE');
    const untouched = await snapshot();
    assert.equal(diagnosis(untouched).data.problem, 'Первоначальный текст команды.');
    assert.equal(activities(untouched).length, 0);
    assert.equal(untouched.basis.length, 0);

    const manuallyCaptured = await mutate('dw_capture_roadmap_basis', {
      roadmapId, basisId: null, expectedRevision: 0, sourceKind: 'barrier', sourceId: first.id,
      expectedSourceRevision: first.revision, rationale: 'Ранее закреплённый источник команды.', status: 'active',
    });
    const operation = randomUUID();
    const imported = await mutate('dw_import_roadmap_workshop', input, member, operation);
    assert.equal(diagnosis(imported).data.problem, [
      'Первоначальный текст команды.', first.title, `${second.title}\n${second.description}`,
    ].join('\n\n'));
    assert.deepEqual(activities(imported).map((item) => item.data.title).sort(), [family.title, solution.title, green.text].sort());
    assert.deepEqual(imported.basis.map(({ sourceKind }) => sourceKind).sort(), ['barrier', 'barrier', 'factor', 'link', 'link', 'solution']);
    assert.deepEqual(imported.basis.find(({ sourceId }) => sourceId === first.id).material.source.stageIds, ['work', 'first_child']);
    assert.equal(imported.basis.find(({ sourceId }) => sourceId === first.id).id, manuallyCaptured.basis[0].id);
    assert.equal(imported.basis.find(({ sourceId }) => sourceId === first.id).rationale, 'Ранее закреплённый источник команды.');
    assert.equal(imported.basis.find(({ sourceKind }) => sourceKind === 'factor').material.source.barriers.length, 2);
    assert.equal(imported.revision, (await mutate('dw_import_roadmap_workshop', input, member, operation)).revision);

    const factorActivity = activities(imported).find(({ data }) => data.title === green.text);
    await save(factorActivity, { ...factorActivity.data, title: 'Отредактированная мера команды' });
    await save(diagnosis(imported), { ...diagnosis(imported).data, problem: 'Команда переписала проблему.' });
    await mutate('dw_set_solution_barrier', { kind: 'factor', measureId: green.id, barrierId: first.id, linked: false });
    await mutate('dw_set_solution_barrier', { kind: 'factor', measureId: green.id, barrierId: second.id, linked: false });
    const repeated = await mutate('dw_import_roadmap_workshop', input);
    assert.equal(diagnosis(repeated).data.problem, 'Команда переписала проблему.');
    assert.equal(activities(repeated).length, 3);
    assert.equal(activities(repeated).find(({ id }) => id === factorActivity.id).data.title, 'Отредактированная мера команды');
    assert.equal(repeated.basis.find(({ sourceKind }) => sourceKind === 'factor').material.source.title, green.text);
    assert(repeated.basis.every(({ staleReasons }) => staleReasons.length === 0));

    const frozen = await mutate('dw_freeze_roadmap', {
      roadmapId, expectedRevision: repeated.revision, title: 'Скопированные материалы команды', kind: 'draft',
    });
    const version = await call(member, 'dw_roadmap_version', {
      p_session_id, p_roadmap_id: roadmapId, p_version_id: frozen.versions[0].id,
    });
    assert.equal(version.snapshot.basis.find(({ sourceKind }) => sourceKind === 'factor').material.source.title, green.text);
  } finally {
    await db.close();
  }
});
