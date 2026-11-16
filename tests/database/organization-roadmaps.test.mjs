import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createTestDatabase } from './harness.mjs';
import { loadRoadmapDataset, seedRoadmapDataset } from '../../scripts/seed-roadmaps.mjs';

let db;
let teacher;
let sessionId;
const id = () => randomUUID();
const reject = (promise, expected) => assert.rejects(promise, error => error.code === 'P0001' && error.message === expected);
async function anonymous(sql, args) {
  return db.transaction(async tx => {
    await tx.exec('set local role anon');
    return (await tx.query(sql, args)).rows[0].result;
  });
}
async function identify(name, email = `${id()}@organization.test`) {
  const result = await anonymous('select public.dw_identify($1,$2) result', [email, name]);
  return result.session.access_token;
}
const rpc = (token, method, args) => anonymous('select public.dw_entry_rpc($1,$2,$3::jsonb) result', [token, method, JSON.stringify(args)]);
const mutate = (token, method, input, operation = id(), session = sessionId) => rpc(token, method, {
  p_operation_id: operation, p_session_id: session, p_input: input,
});
const index = (token) => rpc(token, 'dw_roadmaps_index', { p_session_id: sessionId });
const snapshot = (token, roadmapId) => rpc(token, 'dw_roadmap_snapshot', { p_session_id: sessionId, p_roadmap_id: roadmapId });
const version = (token, roadmapId, versionId = null) => rpc(token, 'dw_roadmap_version', {
  p_session_id: sessionId, p_roadmap_id: roadmapId, p_version_id: versionId,
});
const create = (token, name, expectedAssignmentRevision = 0, operation) => mutate(token, 'dw_create_organization_roadmap', {
  name, expectedAssignmentRevision,
}, operation);
const join = (token, roadmapId, expectedAssignmentRevision = 0, operation) => mutate(token, 'dw_join_roadmap', {
  roadmapId, expectedAssignmentRevision,
}, operation);
const save = (token, room, kind, data, item = null) => mutate(token, 'dw_save_roadmap_item', {
  roadmapId: room.roadmapId, itemId: item?.id ?? null, expectedRevision: item?.revision ?? 0,
  kind, data, status: 'active',
});
const only = (room, kind) => room.items.find(item => item.kind === kind);
async function member(name) {
  const token = await identify(name);
  const entered = await rpc(token, 'dw_enter_workspace', { p_operation_id: id() });
  assert.equal(entered.session.id, sessionId);
  return token;
}
async function setRole(token, role, session = sessionId) {
  const mine = await rpc(token, 'dw_session_snapshot', { p_session_id: session });
  const self = mine.members.find(item => item.fullName === 'Наблюдатель организации');
  return rpc(teacher, 'dw_set_member_role', { p_operation_id: id(), p_session_id: session,
    p_member_id: self.userId, p_expected_revision: self.revision, p_role: role });
}
before(async () => {
  db = await createTestDatabase({ seedCorpus: false });
  teacher = await identify('Преподаватель организаций', 'omnistat@yandex.ru');
  sessionId = (await rpc(teacher, 'dw_enter_workspace', { p_operation_id: id() })).session.id;
});
after(async () => db?.close());

describe('workshop-owned organization roadmap rooms', () => {
  it('normalizes names, reuses the same organization and shares manual project edits, budgets and exports', async () => {
    const alice = await member('Автор команды организации');
    const bob = await member('Коллега команды организации');
    const inputName = '  Детскии\u0306\u00a0  центр\nСемья  ';
    let room = await create(alice, inputName);
    assert.equal(room.roomLevel, 'organization');
    assert.deepEqual(room.territory, {
      key: `organization:${room.roadmapId}`, name: 'Детский центр Семья', level: 'organization', regionId: null,
      sourceEditionId: 'custom-organization-v1', sourceCode: null, sourceType: 'organization',
      geographicStatus: 'not-geographic', sourceUrl: `urn:demography:organization:${room.roadmapId}`, boundaryVersion: null,
    });
    assert.equal(room.canEdit, true);
    assert.deepEqual(room.items.map(item => item.kind).sort(), ['diagnosis', 'monitoring', 'passport']);
    assert.deepEqual(room.series, []);
    assert.deepEqual(room.statistics, []);
    assert.equal(room.cohortSettings, undefined);
    assert.equal((await index(alice)).configuration.dataEditionId, null);
    const same = await create(bob, 'детский центр семья');
    assert.equal(same.roadmapId, room.roadmapId);
    assert.equal(same.territory.name, room.territory.name);
    assert.equal(same.members.length, 2);
    assert.equal((await index(bob)).rooms.find(item => item.id === room.roadmapId).memberCount, 2);

    const passport = only(room, 'passport');
    room = await save(alice, room, 'passport', { ...passport.data, title: 'Семейная поддержка в организации',
      goal: 'Обеспечить поддержку семей сотрудников', startDate: '2027-01-01', endDate: '2027-12-31' }, passport);
    const diagnosis = only(room, 'diagnosis');
    room = await save(bob, room, 'diagnosis', { ...diagnosis.data, problem: 'Семьям нужен присмотр за детьми' }, diagnosis);
    const indicator = { title: 'Семьи, получившие поддержку', definition: 'Число семей из журнала организации', kind: 'output',
      unit: 'семей', semanticType: 'stock', valueDomain: 'nonnegative', numeratorDefinition: '', denominatorDefinition: '',
      baselineValue: 5, baselineYear: 2026, annualTargets: [{ year: 2027, value: 10 }], sourceReference: 'Журнал организации',
      frequency: 'Ежемесячно', responsible: 'Команда', limitations: 'Организационный показатель', scenarioId: null };
    room = await save(alice, room, 'indicator', indicator);
    const activity = { title: 'Открыть группу присмотра', description: 'Подготовить помещение и расписание', objectiveId: null,
      targetGroup: 'Семьи сотрудников', scale: 'Одна организация', startDate: '2027-02-01', endDate: '2027-04-30',
      responsible: 'Руководитель команды', partners: '', deliverable: 'Группа открыта', completionCriterion: 'Первая группа работает',
      authorityLevel: 'organization', legalBasis: '', approvalStatus: 'requires_decision', responsibleBody: 'Директор',
      necessaryDecision: 'Согласовать расписание', indicatorIds: [only(room, 'indicator').id], dependencies: [],
      stage: 'implementation', stageLabel: '', progressStatus: 'planned' };
    room = await save(bob, room, 'activity', activity);
    room = await save(alice, room, 'cost', { activityId: only(room, 'activity').id, year: 2027, title: 'Материалы для группы',
      unit: 'набор', quantity: '2', unitPriceKopecks: 15000, periods: 1, cashKind: 'cash', priceStatus: 'estimated', priceSource: '', priceDate: null });
    room = await save(bob, room, 'funding', { costLineId: only(room, 'cost').id, sourceName: 'Средства организации',
      sourceKind: 'other', amountKopecks: 10000, status: 'confirmed', sourceReference: 'Решение директора', sourceDate: '2026-11-17', originReference: '' });
    assert.equal(room.budget.needCashKopecks, 30000);
    assert.equal(room.budget.confirmedGapKopecks, 20000);
    const otherView = await snapshot(alice, room.roadmapId);
    assert.equal(only(otherView, 'diagnosis').data.problem, 'Семьям нужен присмотр за детьми');
    assert.equal(only(otherView, 'activity').data.startDate, '2027-02-01');
    const current = await version(alice, room.roadmapId);
    assert.equal(current.snapshot.roomLevel, 'organization');
    assert.equal(current.snapshot.territory.name, 'Детский центр Семья');
    assert.equal(current.snapshot.items.find(item => item.kind === 'passport').data.title, 'Семейная поддержка в организации');
    assert.equal(current.snapshot.budget.needCashKopecks, 30000);
    assert.deepEqual(current.snapshot.series, []);
    assert.deepEqual(current.snapshot.statistics, []);
    assert.equal(createHash('sha256').update(current.canonicalJson).digest('hex'), current.sha256);
    room = await mutate(bob, 'dw_freeze_roadmap', { roadmapId: room.roadmapId, expectedRevision: room.revision, title: 'Версия организации', kind: 'draft' });
    const frozen = await version(alice, room.roadmapId, room.versions[0].id);
    assert.equal(frozen.snapshot.roomLevel, 'organization');
    const updatedPassport = only(room, 'passport');
    await save(alice, room, 'passport', { ...updatedPassport.data, title: 'Уточнённый проект организации' }, updatedPassport);
    assert.equal((await version(bob, room.roadmapId, frozen.id)).canonicalJson, frozen.canonicalJson);
    const projection = await rpc(teacher, 'dw_roadmaps_projector_snapshot', { p_session_id: sessionId, p_roadmap_id: room.roadmapId });
    assert.equal(projection.selected.roomLevel, 'organization');
    assert.deepEqual(projection.selected.series, []);
  });

  it('preserves assignment CAS, row conflicts and operation replay without duplicate rooms or overwritten names', async () => {
    const alice = await member('Участник CAS организации');
    const bob = await member('Коллега CAS организации');
    const operation = id();
    const room = await create(alice, 'Организация CAS', 0, operation);
    const before = await index(alice);
    assert.equal((await create(alice, 'Организация CAS', 0, operation)).roadmapId, room.roadmapId);
    assert.deepEqual(await index(alice), before);
    await reject(create(alice, 'Другое имя', 0, operation), 'IDEMPOTENCY_CONFLICT');
    await reject(create(alice, 'Новая организация со старой ревизией', 0), 'REVISION_CONFLICT');
    assert.equal((await index(alice)).rooms.length, before.rooms.length);
    const joinOperation = id();
    await join(bob, room.roadmapId, 0, joinOperation);
    const joined = await index(bob);
    await join(bob, room.roadmapId, 0, joinOperation);
    assert.deepEqual(await index(bob), joined);
    await reject(join(bob, room.roadmapId, 0), 'REVISION_CONFLICT');
    const diagnosis = only(room, 'diagnosis');
    await save(alice, room, 'diagnosis', { ...diagnosis.data, problem: 'Первый ввод' }, diagnosis);
    await reject(save(bob, room, 'diagnosis', { ...diagnosis.data, problem: 'Устаревший ввод' }, diagnosis), 'REVISION_CONFLICT');
    assert.equal(only(await snapshot(bob, room.roadmapId), 'diagnosis').data.problem, 'Первый ввод');
    for (const name of ['', ' \n\t ', 'А'.repeat(201), 'Название\u0001']) await reject(create(bob, name, joined.assignmentRevision), 'INVALID_INPUT');
  });

  it('blocks organization demographic statistics and forecasts while retaining explicit external project facts', async () => {
    const alice = await member('Без муниципальной статистики');
    const room = await create(alice, 'Команда без географии');
    const roadmapId = room.roadmapId;
    const revisionBefore = room.revision;
    await reject(mutate(alice, 'dw_roadmap_statistics_save', { roadmapId, metricId: 'births_total', expectedRevision: 0,
      changes: [{ year: 2025, action: 'set', value: 12 }], sourceReference: 'Документ организации', sourceDate: null,
      reason: 'Проверка запрета статистики', comparabilityNote: '' }), 'ORGANIZATION_STATISTICS_UNAVAILABLE');
    await reject(mutate(alice, 'dw_roadmap_statistics_restore', { roadmapId, metricId: 'births_total', expectedRevision: 0,
      reason: 'Проверка запрета восстановления' }), 'ORGANIZATION_STATISTICS_UNAVAILABLE');
    await reject(mutate(alice, 'dw_capture_roadmap_fact', { roadmapId, itemId: null, expectedRevision: 0,
      seriesId: 'arbitrary-series', expectedSeriesFingerprint: 'a'.repeat(64), year: 2025, interpretation: '' }), 'ORGANIZATION_STATISTICS_UNAVAILABLE');
    await reject(mutate(alice, 'dw_roadmap_cohort_save', { roadmapId, expectedRevision: 0, parameters: {
      endYear: 2030, fertilityMultiplier: 1, mortalityMultiplier: 1, arrivalsMultiplier: 1, departuresMultiplier: 1,
    } }), 'ORGANIZATION_STATISTICS_UNAVAILABLE');
    await reject(save(alice, room, 'scenario', { title: 'Недопустимый прогноз', seriesId: 'arbitrary-series', seriesFingerprint: 'a'.repeat(64),
      assumptions: '', parameters: { metricId: 'births_total', historyStartYear: 2020, historyEndYear: 2025,
        endYear: 2030, baselineMethod: 'last_value', targetMode: 'absolute_end', targetValue: 10 } }), 'ORGANIZATION_STATISTICS_UNAVAILABLE');
    await reject(save(alice, room, 'fact', { sourceKind: 'registry', title: 'Подменённая статистика', interpretation: '', year: 2025,
      value: 12, unit: 'человек', sourceReference: 'Несуществующий реестр', sourceDate: null, seriesId: 'arbitrary-series',
      seriesFingerprint: 'a'.repeat(64), metricId: 'births_total' }), 'ORGANIZATION_STATISTICS_UNAVAILABLE');
    assert.equal((await snapshot(alice, roadmapId)).revision, revisionBefore);
    const changed = await save(alice, room, 'fact', { sourceKind: 'external_unverified', title: 'Опрос сотрудников организации',
      interpretation: 'Внутреннее наблюдение команды', year: null, value: null, unit: '', sourceReference: 'Протокол совещания',
      sourceDate: null, seriesId: null, seriesFingerprint: null, metricId: null });
    assert.equal(only(changed, 'fact').data.sourceKind, 'external_unverified');
    assert.deepEqual(changed.series, []);
  });

  it('checks member roles, revocation and session boundaries before permitting organization writes or replay', async () => {
    const owner = await member('Владелец закрытого доступа');
    const room = await create(owner, 'Проверка доступа к организации');
    const observer = await member('Наблюдатель организации');
    const separate = await rpc(teacher, 'dw_create_session', { p_operation_id: id(), p_title: 'Другая мастерская',
      p_scope: 'municipality', p_region_id: 'respublika-mordoviia' });
    const separateId = separate.session.id;
    const invitation = await rpc(teacher, 'dw_invitation', { p_session_id: separateId });
    for (const token of [observer, owner]) await rpc(token, 'dw_join_session', { p_operation_id: id(), p_code: invitation.code });
    await setRole(observer, 'observer', separateId);
    const separateRoom = await mutate(teacher, 'dw_create_organization_roadmap', { name: 'Историческая команда организации', expectedAssignmentRevision: 0 }, id(), separateId);
    await reject(mutate(observer, 'dw_create_organization_roadmap', { name: 'Наблюдатель не создаёт команды', expectedAssignmentRevision: 0 }, id(), separateId), 'FORBIDDEN');
    await reject(mutate(observer, 'dw_join_roadmap', { roadmapId: separateRoom.roadmapId, expectedAssignmentRevision: 0 }, id(), separateId), 'FORBIDDEN');
    assert.equal((await rpc(observer, 'dw_roadmap_snapshot', { p_session_id: separateId, p_roadmap_id: separateRoom.roadmapId })).canEdit, false);
    const outsider = await identify('Посторонний организации');
    await reject(create(outsider, 'Нет членства'), 'FORBIDDEN');
    await reject(mutate(teacher, 'dw_join_roadmap', { roadmapId: room.roadmapId, expectedAssignmentRevision: 1 }, id(), separateId), 'NOT_FOUND');
    const operation = id();
    const allowed = await mutate(owner, 'dw_create_organization_roadmap', { name: 'Команда перед отзывом', expectedAssignmentRevision: 0 }, operation, separateId);
    const members = await rpc(teacher, 'dw_session_snapshot', { p_session_id: separateId });
    const target = members.members.find(item => item.fullName === 'Владелец закрытого доступа');
    await rpc(teacher, 'dw_revoke_member', { p_operation_id: id(), p_session_id: separateId, p_member_id: target.userId,
      p_expected_revision: target.revision });
    await reject(mutate(owner, 'dw_create_organization_roadmap', { name: 'Команда перед отзывом', expectedAssignmentRevision: 0 }, operation, separateId), 'FORBIDDEN');
    assert.equal((await rpc(teacher, 'dw_roadmap_snapshot', { p_session_id: separateId, p_roadmap_id: allowed.roadmapId })).members.length, 0);
  });

  it('leaves the sealed registry and an existing geographic room intact and supports switching back to it', async () => {
    const dataset = await loadRoadmapDataset({ regionIds: ['respublika-mordoviia'], fixture: true });
    await seedRoadmapDataset(db, dataset, { allowFixture: true });
    const alice = await member('Участник территории и организации');
    const territory = dataset.territories.find(item => item.record.level === 'municipality').record.territoryKey;
    const geographic = await mutate(alice, 'dw_join_roadmap', { territoryKey: territory, dataEditionId: dataset.id, expectedAssignmentRevision: 0 });
    const registryBefore = (await db.query('select dataset_id,territory_key,material from private.dw_roadmap_territories order by dataset_id,territory_key')).rows;
    const datasetBefore = (await db.query('select * from private.dw_roadmap_datasets order by id')).rows;
    const current = await version(alice, geographic.roadmapId);
    const organization = await create(alice, 'Организация рядом с территориальной командой', 1);
    const back = await mutate(alice, 'dw_join_roadmap', { territoryKey: territory, dataEditionId: dataset.id, expectedAssignmentRevision: 2 });
    assert.equal(back.roadmapId, geographic.roadmapId);
    assert.deepEqual(back.territory, geographic.territory);
    assert.equal(back.roomLevel, 'municipality');
    assert.equal((await index(alice)).rooms.some(room => room.id === organization.roadmapId), true);
    assert.deepEqual((await db.query('select dataset_id,territory_key,material from private.dw_roadmap_territories order by dataset_id,territory_key')).rows, registryBefore);
    assert.deepEqual((await db.query('select * from private.dw_roadmap_datasets order by id')).rows, datasetBefore);
    const currentAfter = await version(alice, geographic.roadmapId);
    assert.deepEqual(currentAfter.snapshot.territory, current.snapshot.territory);
    assert.deepEqual(currentAfter.snapshot.items, current.snapshot.items);
    assert.deepEqual(currentAfter.snapshot.series, current.snapshot.series);
    await reject(join(alice, geographic.roadmapId, 3), 'NOT_FOUND');
    await reject(db.query("update private.dw_roadmap_territories set material=material where dataset_id=$1", [dataset.id]), 'DATASET_IMMUTABLE');
  });
});
