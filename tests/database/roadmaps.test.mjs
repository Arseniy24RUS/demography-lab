import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  asUser,
  callRpc,
  createTestDatabase,
  projectRoot,
  seedAuthUser,
  seedCanonicalDocument,
  loadMordovia,
  rpcArguments,
} from './harness.mjs';
import { loadRoadmapDataset, seedRoadmapDataset } from '../../scripts/seed-roadmaps.mjs';

let db;
let dataset;
const id = () => randomUUID();
const code = (promise, expected) =>
  assert.rejects(promise, (e) => e.code === 'P0001' && e.message === expected);
const denied = (promise) => assert.rejects(promise, (e) => e.code === '42501');
const rpc = (who, name, args = {}, database = db) => callRpc(database, who, name, args);
const named = (e, name, input, who = e.alice, operation = id(), database = db) =>
  rpc(
    who,
    name,
    { p_operation_id: operation, p_session_id: e.sessionId, p_input: input },
    database,
  );
const index = (e, who = e.alice, database = db) =>
  rpc(who, 'dw_roadmaps_index', { p_session_id: e.sessionId }, database);
const snapshot = (e, roomId = e.roomId, who = e.alice, database = db) =>
  rpc(who, 'dw_roadmap_snapshot', { p_session_id: e.sessionId, p_roadmap_id: roomId }, database);
const municipalities = () => dataset.territories.filter((t) => t.record.level === 'municipality');
const territory = (i = 0) => municipalities()[i].record.territoryKey;
const joinInput = (key = territory(), revision = 0) => ({
  territoryKey: key,
  dataEditionId: dataset.id,
  expectedAssignmentRevision: revision,
});
const risk = (extra = {}) => ({
  title: 'Дефицит кадров',
  mitigation: 'Подготовить резерв',
  owner: 'Команда',
  trigger: 'Вакансия не закрыта',
  contingency: 'Согласовать новый срок',
  ...extra,
});
const activity = (extra = {}) => ({
  title: 'Открыть консультационный маршрут',
  description: '',
  objectiveId: null,
  targetGroup: 'Семьи',
  scale: '',
  startDate: null,
  endDate: null,
  responsible: 'Команда',
  partners: '',
  deliverable: '',
  completionCriterion: '',
  authorityLevel: 'municipal',
  legalBasis: '',
  approvalStatus: 'unknown',
  responsibleBody: '',
  necessaryDecision: '',
  indicatorIds: [],
  dependencies: [],
  stage: 'implementation',
  stageLabel: '',
  progressStatus: 'planned',
  ...extra,
});
const itemInput = (e, kind, data, existing = null, status = 'active') => ({
  roadmapId: e.roomId,
  itemId: existing?.id ?? null,
  expectedRevision: existing?.revision ?? 0,
  kind,
  data,
  status,
});
const save = (e, kind, data, existing, status, who = e.alice, op = id()) =>
  named(e, 'dw_save_roadmap_item', itemInput(e, kind, data, existing, status), who, op);
const only = (s, kind) => s.items.filter((i) => i.kind === kind);
async function user(name, database = db) {
  const userId = id();
  await seedAuthUser(database, { id: userId, email: userId + '@stage5.test' });
  await rpc(
    userId,
    'dw_save_profile',
    { p_operation_id: id(), p_expected_revision: 0, p_full_name: name },
    database,
  );
  return userId;
}
async function setup(
  { level = 'municipality', region = 'respublika-mordoviia', room = true } = {},
  database = db,
) {
  const host = await user('Преподаватель', database);
  const alice = await user('Участник А', database);
  const bob = await user('Участник Б', database);
  await database.query('insert into private.facilitators(user_id) values($1)', [host]);
  const s = await rpc(
    host,
    'dw_create_session',
    {
      p_operation_id: id(),
      p_title: 'Муниципальная лаборатория',
      p_scope: level,
      p_region_id: region,
    },
    database,
  );
  const sessionId = s.session.id;
  const invite = await rpc(host, 'dw_invitation', { p_session_id: sessionId }, database);
  for (const who of [alice, bob])
    await rpc(who, 'dw_join_session', { p_operation_id: id(), p_code: invite.code }, database);
  const e = { host, alice, bob, sessionId };
  if (room)
    e.roomId = (await named(e, 'dw_join_roadmap', joinInput(), alice, id(), database)).roadmapId;
  return e;
}
async function setRole(e, who, name) {
  const s = await rpc(e.host, 'dw_session_snapshot', { p_session_id: e.sessionId });
  const member = s.members.find((m) => m.userId === who);
  return rpc(e.host, 'dw_set_member_role', {
    p_operation_id: id(),
    p_session_id: e.sessionId,
    p_member_id: who,
    p_expected_revision: member.revision,
    p_role: name,
  });
}
async function revoke(e, who) {
  const s = await rpc(e.host, 'dw_session_snapshot', { p_session_id: e.sessionId });
  const member = s.members.find((m) => m.userId === who);
  return rpc(e.host, 'dw_revoke_member', {
    p_operation_id: id(),
    p_session_id: e.sessionId,
    p_member_id: who,
    p_expected_revision: member.revision,
  });
}
before(async () => {
  db = await createTestDatabase();
  dataset = await loadRoadmapDataset({
    regionIds: ['respublika-mordoviia', 'moskva'],
    fixture: true,
  });
  await seedRoadmapDataset(db, dataset, { allowFixture: true });
});
after(async () => db?.close());

describe('Stage 5 private territorial roadmap transactions', () => {
  it('seals real data, preserves native geography types, and rejects later registry mutation', async () => {
    assert.equal((await seedRoadmapDataset(db, dataset, { allowFixture: true })).skipped, true);
    assert.equal(
      dataset.series.every((s) => s.provenanceStatus === 'incomplete_primary'),
      true,
    );
    await code(
      db.query('update private.dw_roadmap_series set fingerprint=fingerprint where dataset_id=$1', [
        dataset.id,
      ]),
      'DATASET_IMMUTABLE',
    );
    await code(
      db.query('delete from private.dw_roadmap_territories where dataset_id=$1', [dataset.id]),
      'DATASET_IMMUTABLE',
    );
    const corrupt = structuredClone(dataset);
    corrupt.series[0].points[0].value = 999;
    await assert.rejects(seedRoadmapDataset(db, corrupt, { allowFixture: true }), /checksum/);
  });

  it('creates exactly one room per territory; joins are repeatable and assigned colleagues collaborate', async () => {
    const e = await setup({ room: false });
    const op = id();
    const a = await named(e, 'dw_join_roadmap', joinInput(), e.alice, op);
    const b = await named(e, 'dw_join_roadmap', joinInput(), e.bob);
    const replay = await named(e, 'dw_join_roadmap', joinInput(), e.alice, op);
    assert.equal(a.roadmapId, b.roadmapId);
    assert.equal(replay.roadmapId, a.roadmapId);
    assert.equal(b.members.length, 2);
    assert.equal(b.items.length, 3);
    const ix = await index(e);
    assert.equal(ix.rooms.length, 1);
    assert.equal(ix.configuration.dataEditionId, dataset.id);
    assert.equal(ix.assignmentRevision, 1);
    assert.equal(ix.configuration.locked, true);
    await code(
      named(
        e,
        'dw_configure_roadmaps',
        { roomLevel: 'region', expectedRevision: ix.configuration.revision },
        e.host,
      ),
      'ROADMAP_CONFIGURATION_LOCKED',
    );
    await code(
      named(e, 'dw_join_roadmap', {
        ...joinInput(territory(1), 1),
        dataEditionId: 'other-edition',
      }),
      'DATASET_MISMATCH',
    );
    await code(named(e, 'dw_join_roadmap', joinInput(territory(1), 0)), 'REVISION_CONFLICT');
  });

  it('has independent record revisions, rejects lost updates and payload substitution on replay', async () => {
    const e = await setup();
    await named(e, 'dw_join_roadmap', joinInput(), e.bob);
    const first = await snapshot(e);
    const pass = only(first, 'passport')[0];
    const diagnosis = only(first, 'diagnosis')[0];
    const operation = id();
    const data = { ...pass.data, title: 'Семейный маршрут' };
    await save(e, 'passport', data, pass, 'active', e.alice, operation);
    const latest = await save(
      e,
      'diagnosis',
      { ...diagnosis.data, problem: 'Нет навигации по поддержке' },
      diagnosis,
      'active',
      e.bob,
    );
    assert.equal(only(latest, 'passport')[0].data.title, 'Семейный маршрут');
    assert.equal(only(latest, 'diagnosis')[0].revision, 2);
    await code(
      save(e, 'passport', { ...data, title: 'Чужая старая правка' }, pass),
      'REVISION_CONFLICT',
    );
    const replay = await save(e, 'passport', data, pass, 'active', e.alice, operation);
    assert.equal(only(replay, 'passport')[0].revision, 2);
    await code(
      save(
        e,
        'passport',
        { ...data, title: 'Изменённый повтор' },
        pass,
        'active',
        e.alice,
        operation,
      ),
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('never authorizes old receipts after moving room, changing role, or revoking membership', async () => {
    const e = await setup();
    const op = id();
    const input = itemInput(e, 'risk', risk());
    await named(e, 'dw_save_roadmap_item', input, e.alice, op);
    const next = await named(e, 'dw_join_roadmap', joinInput(territory(1), 1));
    assert.notEqual(next.roadmapId, e.roomId);
    await code(named(e, 'dw_save_roadmap_item', input, e.alice, op), 'ROADMAP_ROOM_REQUIRED');
    assert.equal(only(await snapshot(e), 'risk').length, 1);
    await setRole(e, e.alice, 'observer');
    await code(named(e, 'dw_join_roadmap', joinInput(territory(), 2)), 'FORBIDDEN');
    assert.equal((await snapshot(e)).canEdit, false);
    await revoke(e, e.alice);
    await code(snapshot(e), 'FORBIDDEN');
    await code(named(e, 'dw_save_roadmap_item', input, e.alice, op), 'FORBIDDEN');
  });

  it('configures regional/federal rooms explicitly and cannot treat administrative districts as municipalities', async () => {
    const regional = await setup({ room: false });
    await named(
      regional,
      'dw_configure_roadmaps',
      { expectedRevision: 1, roomLevel: 'region' },
      regional.host,
    );
    const r = await named(regional, 'dw_join_roadmap', joinInput('region:respublika-mordoviia'));
    assert.equal(r.territory.level, 'region');
    assert.equal(r.roomLevel, 'region');
    assert.deepEqual(r.series, []);
    await code(
      named(regional, 'dw_join_roadmap', joinInput('region:moskva', 1)),
      'TERRITORY_OUT_OF_SCOPE',
    );
    const scoped = await setup({ room: false });
    await code(
      named(scoped, 'dw_join_roadmap', joinInput('region:moskva')),
      'TERRITORY_NOT_ELIGIBLE',
    );
    const district = dataset.territories.find((t) => t.record.level === 'administrative_district');
    await code(
      named(scoped, 'dw_join_roadmap', joinInput(district.record.territoryKey)),
      'TERRITORY_NOT_ELIGIBLE',
    );
    const federal = await setup({ room: false, level: 'federal', region: null });
    const fkey = dataset.territories.find((t) => t.record.level === 'federal').record.territoryKey;
    const f = await named(federal, 'dw_join_roadmap', joinInput(fkey));
    assert.equal(f.roomLevel, 'federal');
    assert.equal(f.territory.regionId, null);
  });

  it('strictly rejects unknown fields, invalid dates, malformed enums, singleton archives and foreign references', async () => {
    const e = await setup();
    const pass = only(await snapshot(e), 'passport')[0];
    await code(
      named(e, 'dw_save_roadmap_item', { ...itemInput(e, 'risk', risk()), authorId: e.bob }),
      'INVALID_INPUT',
    );
    await code(save(e, 'risk', { ...risk(), hiddenField: 'x' }), 'INVALID_INPUT');
    await code(
      save(e, 'activity', activity({ startDate: '2027-02-29', endDate: '2027-03-01' })),
      'INVALID_INPUT',
    );
    await code(save(e, 'activity', activity({ authorityLevel: null })), 'INVALID_INPUT');
    await code(save(e, 'passport', pass.data, pass, 'archived'), 'ROADMAP_SINGLETON');
    await code(
      save(e, 'activity', activity({ dependencies: [{ predecessorId: id(), lagDays: 0 }] })),
      'ROADMAP_REFERENCE',
    );
    assert.equal(only(await snapshot(e), 'activity').length, 0);
    const a = only(await save(e, 'activity', activity()), 'activity')[0];
    const b = only(
      await save(
        e,
        'activity',
        activity({ title: 'Второй шаг', dependencies: [{ predecessorId: a.id, lagDays: 0 }] }),
      ),
      'activity',
    ).find((i) => i.id !== a.id);
    await code(
      save(e, 'activity', { ...a.data, dependencies: [{ predecessorId: b.id, lagDays: 0 }] }, a),
      'ROADMAP_CYCLE',
    );
    await code(save(e, 'activity', a.data, a, 'archived'), 'ROADMAP_REFERENCE');
  });

  it('captures facts from the sealed series and rejects client-authored canonical numbers', async () => {
    const e = await setup();
    const s = dataset.series.find(
      (s) => s.territoryKey === territory() && s.metricId === 'births_total',
    );
    const pt = s.points.findLast((p) => p.value !== null);
    const input = {
      roadmapId: e.roomId,
      itemId: null,
      expectedRevision: 0,
      seriesId: s.id,
      expectedSeriesFingerprint: s.fingerprint,
      year: pt.year,
      interpretation: 'Наблюдаемое значение',
    };
    const result = await named(e, 'dw_capture_roadmap_fact', input);
    const fact = only(result, 'fact')[0];
    assert.equal(fact.data.value, pt.value);
    assert.equal(fact.data.year, pt.year);
    assert.equal(result.series[0].fingerprint, s.fingerprint);
    await code(save(e, 'fact', { ...fact.data, value: pt.value + 1 }, fact), 'SOURCE_MISMATCH');
    await code(save(e, 'fact', fact.data), 'SOURCE_MISMATCH');
    await code(
      named(e, 'dw_capture_roadmap_fact', { ...input, expectedSeriesFingerprint: '0'.repeat(64) }),
      'SOURCE_MISMATCH',
    );
    const foreign = dataset.series.find((s) => s.territoryKey === territory(1));
    await code(
      named(e, 'dw_capture_roadmap_fact', {
        ...input,
        seriesId: foreign.id,
        expectedSeriesFingerprint: foreign.fingerprint,
      }),
      'SOURCE_MISMATCH',
    );
    const edited = await save(
      e,
      'fact',
      { ...fact.data, interpretation: 'Авторская интерпретация отдельно от наблюдения' },
      fact,
    );
    assert.equal(only(edited, 'fact')[0].data.value, pt.value);
  });

  it('bounds dense calendar reachability and still rejects a cycle in a forty-activity graph', async () => {
    const e = await setup();
    const keys = Array.from({ length: 40 }, () => id());
    const rows = keys.map((key, n) => ({
      id: key,
      data: activity({
        title: 'Тестовое мероприятие ' + n,
        dependencies: keys.slice(0, n).map((predecessorId) => ({ predecessorId, lagDays: 0 })),
      }),
    }));
    await db.query(
      "insert into private.dw_roadmap_items(id,session_id,roadmap_id,kind,data,created_by,updated_by) select x.id,$1,$2,'activity',x.data,$3,$3 from jsonb_to_recordset($4::jsonb) as x(id uuid,data jsonb)",
      [e.sessionId, e.roomId, e.alice, JSON.stringify(rows)],
    );
    const current = await snapshot(e);
    const diagnosis = only(current, 'diagnosis')[0];
    const checked = await save(
      e,
      'diagnosis',
      { ...diagnosis.data, conclusion: 'Плотный ациклический граф проверен' },
      diagnosis,
    );
    assert.equal(only(checked, 'activity').length, 40);
    const first = checked.items.find((item) => item.id === keys[0]);
    await code(
      save(
        e,
        'activity',
        { ...first.data, dependencies: [{ predecessorId: keys[39], lagDays: 0 }] },
        first,
      ),
      'ROADMAP_CYCLE',
    );
  });

  it('keeps precise kopecks, confirmed gap, and prevents silent financing invalidation', async () => {
    const e = await setup();
    const a = only(await save(e, 'activity', activity()), 'activity')[0];
    const data = {
      activityId: a.id,
      year: 2027,
      title: 'Часть ставки',
      unit: 'месяц',
      quantity: '0.005',
      unitPriceKopecks: 101,
      periods: 1,
      cashKind: 'cash',
      priceStatus: 'estimated',
      priceSource: 'Расчёт команды',
      priceDate: null,
    };
    const s = await save(e, 'cost', data);
    const c = only(s, 'cost')[0];
    assert.equal(s.budget.needCashKopecks, 1);
    await code(save(e, 'cost', { ...data, priceStatus: 'confirmed' }), 'INVALID_INPUT');
    const f = {
      costLineId: c.id,
      sourceName: 'Проект бюджета',
      sourceKind: 'municipal_budget',
      amountKopecks: 1,
      status: 'budget_draft',
      sourceReference: '',
      sourceDate: null,
      originReference: '',
    };
    const funded = await save(e, 'funding', f);
    assert.equal(funded.budget.confirmedGapKopecks, 1);
    assert.equal(funded.budget.remainingAfterExpectedKopecks, 0);
    await code(save(e, 'funding', { ...f, status: 'confirmed' }), 'INVALID_INPUT');
    await code(save(e, 'funding', { ...f, amountKopecks: 1 }), 'BUDGET_OVERALLOCATED');
    await code(save(e, 'cost', { ...c.data, quantity: '0' }, c), 'BUDGET_OVERALLOCATED');
    await code(save(e, 'cost', c.data, c, 'archived'), 'ROADMAP_REFERENCE');
    assert.equal((await snapshot(e)).budget.needCashKopecks, 1);
  });

  it('freezes exact immutable bytes; review commentary changes no exported evidence or budget', async () => {
    const e = await setup();
    await save(e, 'risk', risk());
    const before = await snapshot(e);
    const frozen = await named(e, 'dw_freeze_roadmap', {
      roadmapId: e.roomId,
      expectedRevision: before.revision,
      title: 'Первая версия',
      kind: 'draft',
    });
    const versionId = frozen.versions[0].id;
    const get = () =>
      rpc(e.alice, 'dw_roadmap_version', {
        p_session_id: e.sessionId,
        p_roadmap_id: e.roomId,
        p_version_id: versionId,
      });
    const v = await get();
    assert.equal(createHash('sha256').update(v.canonicalJson).digest('hex'), v.sha256);
    assert.deepEqual(JSON.parse(v.canonicalJson), v.snapshot);
    assert.equal(v.snapshot.teamNames.length, 1);
    assert.equal(
      v.snapshot.items.some((i) => 'createdBy' in i),
      false,
    );
    await named(
      e,
      'dw_review_roadmap',
      {
        roadmapId: e.roomId,
        versionId,
        expectedRevision: 0,
        decision: 'revise',
        comment: 'Уточнить механизм.',
      },
      e.host,
    );
    await save(e, 'risk', risk({ title: 'Новый риск после версии' }));
    const later = await get();
    assert.equal(later.canonicalJson, v.canonicalJson);
    assert.equal(later.sha256, v.sha256);
    assert.equal(later.review.comment, 'Уточнить механизм.');
    await code(
      db.query('update private.dw_roadmap_versions set title=title where id=$1', [versionId]),
      'ROADMAP_VERSION_IMMUTABLE',
    );
    await code(
      named(e, 'dw_review_roadmap', {
        roadmapId: e.roomId,
        versionId,
        expectedRevision: 1,
        decision: 'discussed',
        comment: 'Сам себя одобрил.',
      }),
      'FORBIDDEN',
    );
  });

  it('isolates private tables and raw helper functions; projector is host-only and has no identity fields', async () => {
    const e = await setup();
    await save(e, 'risk', risk());
    const projection = await rpc(e.host, 'dw_roadmaps_projector_snapshot', {
      p_session_id: e.sessionId,
      p_roadmap_id: e.roomId,
    });
    assert.equal(
      projection.selected.items.some((i) => 'createdBy' in i || 'updatedBy' in i),
      false,
    );
    assert.equal(JSON.stringify(projection).includes(e.alice), false);
    await code(
      rpc(e.alice, 'dw_roadmaps_projector_snapshot', { p_session_id: e.sessionId }),
      'FORBIDDEN',
    );
    const outsider = await user('Посторонний');
    await code(index(e, outsider), 'FORBIDDEN');
    await denied(asUser(db, e.alice, (tx) => tx.query('select * from private.dw_roadmap_items')));
    await denied(
      asUser(db, e.alice, (tx) => tx.query('select private.dw_roadmap_items_json($1)', [e.roomId])),
    );
    const events = await asUser(db, e.alice, (tx) =>
      tx.query('select * from public.dw_roadmap_events where session_id=$1', [e.sessionId]),
    );
    assert.ok(events.rows.length > 0);
    assert.ok(
      Object.keys(events.rows[0]).every((k) =>
        ['id', 'session_id', 'roadmap_id', 'cursor', 'event_type', 'created_at'].includes(k),
      ),
    );
    const none = await asUser(db, outsider, (tx) =>
      tx.query('select * from public.dw_roadmap_events where session_id=$1', [e.sessionId]),
    );
    assert.equal(none.rows.length, 0);
  });
});

async function surveyAnon(database, name, args) {
  const keys = rpcArguments[name];
  return database.transaction(async (tx) => {
    await tx.exec('set local role anon');
    await tx.query(
      "select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims',$1,true)",
      [JSON.stringify({ role: 'anon' })],
    );
    const values = keys.map((key) =>
      args[key] && typeof args[key] === 'object' ? JSON.stringify(args[key]) : (args[key] ?? null),
    );
    return (
      await tx.query(
        'select public.' + name + '(' + keys.map((_, i) => '$' + (i + 1)).join(',') + ') as data',
        values,
      )
    ).rows[0].data;
  });
}
const barrierInput = (extra = {}) => ({
  barrierId: null,
  expectedRevision: 0,
  title: 'Доступность ухода за детьми',
  description: 'Обсуждение команды.',
  primaryStage: 'first_child',
  stageIds: ['first_child'],
  evidenceKind: 'observation',
  status: 'active',
  priority: false,
  ...extra,
});
async function sourceBundle() {
  const doc = await loadMordovia();
  const corpus = JSON.parse(
    await readFile(resolve(projectRoot, 'public/data/corpus/practices.json'), 'utf8'),
  );
  const raw = corpus.variants.find((v) => v.id === 'mordovia-kindergarten-compensation');
  const keys = [
    'id',
    'familyId',
    'regionId',
    'title',
    'mechanism',
    'eligibility',
    'amount',
    'conditions',
    'occurrenceIds',
    'evidence',
    'reviewStatus',
  ];
  const okeys = ['id', 'documentId', 'versionId', 'anchor', 'reviewStatus', 'note'];
  return {
    schemaVersion: 1,
    practice: Object.fromEntries(keys.filter((k) => k in raw).map((k) => [k, raw[k]])),
    occurrences: corpus.occurrences
      .filter((o) => raw.occurrenceIds.includes(o.id))
      .map((o) => Object.fromEntries(okeys.filter((k) => k in o).map((k) => [k, o[k]]))),
    sources: [
      {
        sourceId: doc.meta.id,
        editionId: doc.version.id,
        title: doc.meta.title,
        sha256: doc.version.sourceSha256,
        normalizationVersion: doc.version.normalizationVersion,
        sourceUrl: doc.version.sourceUrl,
        regionId: doc.meta.regionId,
      },
    ],
    note: 'Учебная проверка прямой связи документа с дорожной картой.',
  };
}
async function curated(e, database = db) {
  const bundle = await sourceBundle();
  const published = await rpc(
    e.alice,
    'dw_publish_submission',
    {
      p_operation_id: id(),
      p_session_id: e.sessionId,
      p_local_key: bundle.practice.id,
      p_expected_revision: null,
      p_bundle: bundle,
    },
    database,
  );
  const submission = published.submissions[0];
  const w = await rpc(e.host, 'dw_workshop_snapshot', { p_session_id: e.sessionId }, database);
  const f = await rpc(
    e.host,
    'dw_save_family',
    {
      p_operation_id: id(),
      p_session_id: e.sessionId,
      p_family_id: null,
      p_expected_board_revision: w.boardRevision,
      p_title: 'Доступное дошкольное образование',
      p_mechanism: 'Компенсация расходов',
      p_rationale: 'Сохраняем цитаты из региональной программы',
      p_submission_ids: [submission.id],
    },
    database,
  );
  return { bundle, submission, familyId: f.families[0].id };
}

describe('Stage 5 provenance, resource limits and cumulative compatibility', () => {
  it('freezes complete Stage 4 citations and original solutions; later source changes are visible and old bytes survive', async () => {
    const e = await setup();
    const { bundle, submission, familyId } = await curated(e);
    const b = (await named(e, 'dw_save_barrier', barrierInput())).barriers[0];
    const barrierState = await rpc(e.alice, 'dw_barriers_snapshot', { p_session_id: e.sessionId });
    const family = barrierState.families.find((f) => f.id === familyId);
    const linked = await named(e, 'dw_save_barrier_link', {
      linkId: null,
      expectedRevision: 0,
      barrierId: b.id,
      expectedBarrierRevision: b.revision,
      familyId,
      expectedFamilyFingerprint: family.fingerprint,
      relationship: 'partial',
      explanation: 'Снизить расходы семьи на уход',
      prerequisites: 'Проверить территориальные условия',
      status: 'active',
    });
    const link = linked.links[0];
    const solution = (
      await named(e, 'dw_save_solution', {
        solutionId: null,
        expectedRevision: 0,
        barrierIds: [b.id],
        title: 'Муниципальный маршрут помощи',
        targetGroup: 'Семьи',
        mechanism: 'Единая навигация',
        firstStep: 'Интервью с семьями',
        responsible: 'Команда',
        resources: 'Рабочее время',
        successIndicator: 'Срок получения услуги',
        risks: 'Дефицит кадров',
        status: 'active',
      })
    ).solutions[0];
    const capture = (kind, source) => ({
      roadmapId: e.roomId,
      basisId: null,
      expectedRevision: 0,
      sourceKind: kind,
      sourceId: source.id,
      expectedSourceRevision: source.revision,
      rationale: 'Основание выбора мероприятия',
      status: 'active',
    });
    await named(e, 'dw_capture_roadmap_basis', capture('barrier', b));
    await named(e, 'dw_capture_roadmap_basis', capture('solution', solution));
    let s = await named(e, 'dw_capture_roadmap_basis', capture('link', link));
    const savedLink = s.basis.find((x) => x.sourceKind === 'link');
    assert.equal(s.basis.length, 3);
    assert.ok(s.basis.every((x) => x.staleReasons.length === 0));
    const frozen = await named(e, 'dw_freeze_roadmap', {
      roadmapId: e.roomId,
      expectedRevision: s.revision,
      title: 'Версия с цитатой',
      kind: 'submitted',
    });
    const args = {
      p_session_id: e.sessionId,
      p_roadmap_id: e.roomId,
      p_version_id: frozen.versions[0].id,
    };
    const version = await rpc(e.alice, 'dw_roadmap_version', args);
    assert.equal(version.snapshot.evidence.length, 1);
    assert.deepEqual(version.snapshot.evidence[0].variants[0].bundle, bundle);
    const sourceCursor = (await snapshot(e)).sourceCursor;
    await rpc(e.alice, 'dw_publish_submission', {
      p_operation_id: id(),
      p_session_id: e.sessionId,
      p_local_key: bundle.practice.id,
      p_expected_revision: submission.revision,
      p_bundle: { ...bundle, note: 'Поздняя редакция группового вывода' },
    });
    s = await snapshot(e);
    assert.ok(s.sourceCursor > sourceCursor);
    assert.ok(
      s.basis.find((x) => x.id === savedLink.id).staleReasons.includes('source_basis_stale'),
    );
    await code(named(e, 'dw_capture_roadmap_basis', capture('link', link)), 'SOURCE_STALE');
    const w = await rpc(e.host, 'dw_workshop_snapshot', { p_session_id: e.sessionId });
    await rpc(e.host, 'dw_delete_family', {
      p_operation_id: id(),
      p_session_id: e.sessionId,
      p_family_id: familyId,
      p_expected_board_revision: w.boardRevision,
    });
    const archived = await named(e, 'dw_capture_roadmap_basis', {
      ...capture('link', link),
      basisId: savedLink.id,
      expectedRevision: savedLink.revision,
      expectedSourceRevision: savedLink.sourceRevision,
      status: 'archived',
    });
    assert.equal(archived.basis.find((x) => x.id === savedLink.id).status, 'archived');
    assert.equal(
      (await rpc(e.alice, 'dw_roadmap_version', args)).canonicalJson,
      version.canonicalJson,
    );
  });

  it('validates scenario history against the actual series and retains exact declared parameters', async () => {
    const e = await setup();
    const series = dataset.series.find(
      (s) => s.territoryKey === territory() && s.metricId === 'births_total',
    );
    const last = series.points.findLast((p) => p.value !== null);
    let first = last.year;
    while (series.points.some((p) => p.year === first - 1 && p.value !== null)) first--;
    const parameters = {
      metricId: series.metricId,
      historyStartYear: first,
      historyEndYear: last.year + 2,
      endYear: last.year + 15,
      baselineMethod: 'last_value',
      targetMode: 'annual_growth',
      targetValue: -100,
    };
    const data = {
      title: 'Проверка условной траектории',
      seriesId: series.id,
      seriesFingerprint: series.fingerprint,
      assumptions: 'Не оценка причинного эффекта',
      parameters,
    };
    const s = await save(e, 'scenario', data);
    assert.deepEqual(only(s, 'scenario')[0].data.parameters, parameters);
    const indicator = {
      title: 'Плановый ориентир',
      definition: '',
      kind: 'demographic_context',
      unit: 'человек',
      semanticType: series.semanticType,
      valueDomain: series.valueDomain,
      numeratorDefinition: '',
      denominatorDefinition: '',
      baselineValue: last.value,
      baselineYear: last.year,
      annualTargets: [{ year: parameters.endYear, value: 0 }],
      sourceReference: series.sourceUrl,
      frequency: '',
      responsible: '',
      limitations: '',
      scenarioId: only(s, 'scenario')[0].id,
    };
    await save(e, 'indicator', indicator);
    await code(
      save(e, 'indicator', { ...indicator, semanticType: 'rate' }),
      'SCENARIO_INDICATOR_MISMATCH',
    );
    await code(
      save(e, 'scenario', { ...data, parameters: { ...parameters, endYear: last.year + 31 } }),
      'SCENARIO_HISTORY',
    );
    await code(
      save(e, 'scenario', {
        ...data,
        parameters: { ...parameters, baselineMethod: 'linear', historyStartYear: last.year - 2 },
      }),
      'SCENARIO_HISTORY',
    );
    await code(
      save(e, 'scenario', { ...data, parameters: { ...parameters, metricId: 'deaths_total' } }),
      'SOURCE_MISMATCH',
    );
    await code(save(e, 'scenario', { ...data, computedForecast: [99999] }), 'INVALID_INPUT');
    const signed = dataset.series.find(
      (x) => x.territoryKey === territory() && x.metricId === 'natural_change',
    );
    const signedLast = signed.points.findLast((p) => p.value !== null);
    await code(
      save(e, 'scenario', {
        ...data,
        seriesId: signed.id,
        seriesFingerprint: signed.fingerprint,
        parameters: {
          ...parameters,
          metricId: signed.metricId,
          historyEndYear: signedLast.year,
          historyStartYear: signedLast.year,
          endYear: signedLast.year + 5,
        },
      }),
      'SCENARIO_DOMAIN',
    );
  });

  it('does not move the budget when dates change, and caps malicious repeated item/version creation atomically', async () => {
    const e = await setup();
    const a = only(
      await save(e, 'activity', activity({ startDate: '2027-01-01', endDate: '2027-12-31' })),
      'activity',
    )[0];
    await save(e, 'cost', {
      activityId: a.id,
      year: 2027,
      title: 'Расчёт',
      unit: 'единица',
      quantity: '1',
      unitPriceKopecks: 100,
      periods: 1,
      cashKind: 'cash',
      priceStatus: 'estimated',
      priceSource: '',
      priceDate: null,
    });
    const moved = await save(
      e,
      'activity',
      { ...a.data, startDate: '2028-01-01', endDate: '2028-12-31' },
      a,
    );
    assert.equal(moved.budget.years[0].year, 2027);
    assert.equal(only(moved, 'cost')[0].data.year, 2027);
    for (let n = 0; n < 30; n++) await save(e, 'risk', risk({ title: 'Риск ' + n }));
    const before = await snapshot(e);
    await code(save(e, 'risk', risk()), 'ROADMAP_LIMIT');
    assert.equal((await snapshot(e)).revision, before.revision);
    let s = before;
    for (let n = 0; n < 30; n++)
      s = await named(e, 'dw_freeze_roadmap', {
        roadmapId: e.roomId,
        expectedRevision: s.revision,
        title: 'Версия ' + n,
        kind: 'draft',
      });
    await code(
      named(e, 'dw_freeze_roadmap', {
        roadmapId: e.roomId,
        expectedRevision: s.revision,
        title: 'Лишняя версия',
        kind: 'draft',
      }),
      'ROADMAP_VERSION_LIMIT',
    );
    assert.equal((await snapshot(e)).versions.length, 30);
  });

  it('applies Stage 5 to a populated 0.4 while preserving citations, current survey, responses, consent and old receipts', async () => {
    const prior = new PGlite();
    try {
      await prior.exec(
        await readFile(resolve(projectRoot, 'tests/database/bootstrap.sql'), 'utf8'),
      );
      const dir = resolve(projectRoot, 'supabase/migrations');
      const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
      // A historical upgrade fixture must not apply later migrations before its target.
      for (const file of files.filter((f) => f < files.find((name) => name.includes('stage5'))))
        await prior.exec(await readFile(resolve(dir, file), 'utf8'));
      await seedCanonicalDocument(prior, await loadMordovia());
      const e = await setup({ room: false }, prior);
      await curated(e, prior);
      const operation = id();
      const input = barrierInput();
      const oldBarriers = await named(e, 'dw_save_barrier', input, e.alice, operation, prior);
      const invitation = randomBytes(32).toString('hex');
      const secret = randomBytes(32).toString('hex');
      const config = {
        surveyId: null,
        expectedRevision: 0,
        title: 'Условия родительства',
        purpose: 'Учебное исследование барьеров',
        organizerContact: 'organizer@example.test',
        retentionUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        questionBarrier: 'Что препятствует родительству?',
        questionSupport: 'Что помогло бы семье?',
        invitationToken: invitation,
      };
      let survey = (await named(e, 'dw_save_survey', config, e.host, id(), prior)).survey;
      survey = (
        await named(
          e,
          'dw_manage_survey',
          { surveyId: survey.id, expectedRevision: survey.revision, action: 'open' },
          e.host,
          id(),
          prior,
        )
      ).survey;
      const args = {
        p_operation_id: id(),
        p_survey_id: survey.id,
        p_invitation_token: invitation,
        p_response_secret: secret,
        p_input: {
          expectedRevision: 0,
          questionVersion: survey.questionVersion,
          perspective: 'self',
          intention12m: null,
          intention36m: 'unsure',
          answerBarrier: 'Индивидуальный ответ только в анонимном канале.',
          answerSupport: null,
          priorityChange: null,
          priorityConditionId: null,
          horizon: null,
          conditionalChange: null,
          additionalConditions: null,
          consentEducational: true,
          consentResearch: false,
          consentQuote: false,
          adultConfirmed: true,
        },
      };
      const own = await surveyAnon(prior, 'dw_survey_save_response', args);
      const oldSession = await rpc(
        e.alice,
        'dw_session_snapshot',
        { p_session_id: e.sessionId },
        prior,
      );
      const oldWorkshop = await rpc(
        e.alice,
        'dw_workshop_snapshot',
        { p_session_id: e.sessionId },
        prior,
      );
      const oldStage4 = await rpc(
        e.alice,
        'dw_barriers_snapshot',
        { p_session_id: e.sessionId },
        prior,
      );
      await prior.exec(
        await readFile(
          resolve(
            dir,
            files.find((f) => f.includes('stage5')),
          ),
          'utf8',
        ),
      );
      await seedRoadmapDataset(prior, dataset, { allowFixture: true });
      assert.deepEqual(
        await rpc(e.alice, 'dw_session_snapshot', { p_session_id: e.sessionId }, prior),
        oldSession,
      );
      assert.deepEqual(
        await rpc(e.alice, 'dw_workshop_snapshot', { p_session_id: e.sessionId }, prior),
        oldWorkshop,
      );
      assert.deepEqual(
        await rpc(e.alice, 'dw_barriers_snapshot', { p_session_id: e.sessionId }, prior),
        oldStage4,
      );
      assert.deepEqual(await surveyAnon(prior, 'dw_survey_save_response', args), own);
      const replay = await named(e, 'dw_save_barrier', input, e.alice, operation, prior);
      assert.deepEqual(replay.barriers, oldBarriers.barriers);
      const room = await named(e, 'dw_join_roadmap', joinInput(), e.alice, id(), prior);
      e.roomId = room.roadmapId;
      const beforeCursor = await index(e, e.alice, prior);
      await surveyAnon(prior, 'dw_survey_save_response', {
        ...args,
        p_operation_id: id(),
        p_input: {
          ...args.p_input,
          expectedRevision: own.revision,
          answerBarrier: 'Изменённый анонимный ответ',
        },
      });
      assert.deepEqual(await index(e, e.alice, prior), beforeCursor);
      assert.equal(
        JSON.stringify(await snapshot(e, e.roomId, e.alice, prior)).includes('анонимный'),
        false,
      );
      const frozen = await named(
        e,
        'dw_freeze_roadmap',
        {
          roadmapId: e.roomId,
          expectedRevision: room.revision,
          title: 'После обновления',
          kind: 'draft',
        },
        e.alice,
        id(),
        prior,
      );
      const v = await rpc(
        e.alice,
        'dw_roadmap_version',
        { p_session_id: e.sessionId, p_roadmap_id: e.roomId, p_version_id: frozen.versions[0].id },
        prior,
      );
      assert.equal(v.canonicalJson.includes('анонимный'), false);
      await denied(asUser(prior, e.host, (tx) => tx.query('select * from research.responses')));
    } finally {
      await prior.close();
    }
  });

  it('enforces RLS on every new private table and grants only guarded RPC entry points', async () => {
    const tables = await db.query(
      "select c.relname,c.relrowsecurity,has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') access from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relkind='r' and c.relname like 'dw_roadmap%'",
    );
    assert.equal(tables.rows.length, 13);
    assert.ok(tables.rows.every((r) => r.relrowsecurity && !r.access));
    const newNames = Object.keys(rpcArguments).filter((name) => name.includes('roadmap'));
    const functions = await db.query(
      "select n.nspname,p.proname,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon_exec,has_function_privilege('authenticated',p.oid,'EXECUTE') auth_exec from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and (p.proname like '%roadmap%' or p.proname like 'dw_s5_%')",
    );
    assert.ok(
      functions.rows.every((f) => !f.anon_exec && f.auth_exec === newNames.includes(f.proname)),
    );
    assert.ok(functions.rows.filter((f) => f.nspname === 'public').every((f) => !f.prosecdef));
    assert.ok(functions.rows.every((f) => f.proconfig.includes('search_path=""')));
  });
});
