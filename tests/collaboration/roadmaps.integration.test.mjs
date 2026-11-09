import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FIXTURE_IDENTITIES } from '../../scripts/test-collaboration-gateway.mjs';
import { adaptCanonicalSeries, verifyCanonicalSeriesFingerprint } from '../../packages/territories/series.mjs';
import { startWorkshopHarness, successfulRpc as rpc, rejectedRpc } from './workshop-test-support.mjs';
import { assertNoKeys, named, barrierInput, editBarrier, sessionSnapshot } from './barriers-test-support.mjs';

const dataIndex = JSON.parse(await readFile(new URL('../../public/data/territories/index.json', import.meta.url), 'utf8'));
const registry = JSON.parse(await readFile(new URL('../../public/data/territories/registry.json', import.meta.url), 'utf8'));
const statistics = JSON.parse(await readFile(new URL('../../public/data/territories/regions/respublika-mordoviia.statistics.json', import.meta.url), 'utf8'));
const canonicalSeries = await adaptCanonicalSeries(dataIndex, registry, statistics);
const ARDATOV = 'rudn-mun-72196-894';
const SARANSK = 'rudn-mun-72196-904';
let harness;

async function rejected(...args) {
  const error = await rejectedRpc(...args);
  assert.ok(['P0001', '42501'].includes(error.code), `Expected a guarded domain rejection, not a SQL/runtime failure: ${JSON.stringify(error)}`);
  return error;
}
const sourceSeries = (territoryKey, metricId) => {
  const series = canonicalSeries.find((entry) => entry.territoryKey === territoryKey && entry.metricId === metricId);
  assert.ok(series, `Canonical fixture series missing: ${territoryKey}/${metricId}`);
  return series;
};

const index = (sdk, sessionId) => rpc(sdk, 'dw_roadmaps_index', { p_session_id: sessionId });
const snapshot = (sdk, sessionId, roadmapId) => rpc(sdk, 'dw_roadmap_snapshot', { p_session_id: sessionId, p_roadmap_id: roadmapId });
const find = (state, kind) => state.items.find((item) => item.kind === kind && item.status === 'active');
const edit = (state, item, data, status = 'active') => ({ roadmapId: state.roadmapId, itemId: item.id, expectedRevision: item.revision, kind: item.kind, data: { ...item.data, ...data }, status });
const create = (state, kind, data) => ({ roadmapId: state.roadmapId, itemId: null, expectedRevision: 0, kind, data, status: 'active' });
const risk = (title = 'Недостаточный спрос на пилот') => ({ title, mitigation: 'Проверить добровольный спрос до запуска.', owner: 'Координатор команды', trigger: 'Мало заявок семей', contingency: 'Пересмотреть часы работы пилота.' });

function activity(overrides = {}) {
  return {
    title: 'Пилот вечернего присмотра', description: 'Проверить доступность дополнительных часов для семей.',
    objectiveId: null, targetGroup: 'Семьи с дошкольниками', scale: 'Одна добровольная группа',
    startDate: '2027-01-11', endDate: '2027-03-31', responsible: 'Координатор дошкольного образования', partners: 'Учреждение и родители',
    deliverable: 'Согласованный график и отчёт пилота', completionCriterion: 'Опубликован отчёт об использовании часов',
    authorityLevel: 'municipal', legalBasis: '', approvalStatus: 'requires_decision',
    responsibleBody: 'Муниципальный орган управления образованием', necessaryDecision: 'Рассмотреть организацию пилота',
    indicatorIds: [], dependencies: [], stage: 'implementation', stageLabel: '', progressStatus: 'planned', ...overrides,
  };
}

async function classroom(options = {}) {
  const context = await harness.classroom({ includeBob: true, ...options });
  const current = await index(context.host, context.sessionId);
  await rpc(context.host, 'dw_configure_roadmaps', named(context.sessionId, { expectedRevision: current.configuration.revision, roomLevel: 'municipality' }));
  return context;
}

async function join(sdk, sessionId, territoryKey = ARDATOV) {
  const current = await index(sdk, sessionId);
  return rpc(sdk, 'dw_join_roadmap', named(sessionId, { territoryKey, dataEditionId: dataIndex.editionId, expectedAssignmentRevision: current.assignmentRevision }));
}

describe('Stage 5: shared territorial roadmaps through the real Supabase SDK and shipped SQL', { concurrency: false }, () => {
  before(async () => { harness = await startWorkshopHarness(); });
  beforeEach(async () => { await harness.reset(); });
  after(async () => { await harness?.close(); });

  it('joins two accounts to one source-qualified room and binds the sealed data edition', async () => {
    const { host, alice, bob, sessionId } = await classroom();
    const command = named(sessionId, { territoryKey: ARDATOV, dataEditionId: dataIndex.editionId, expectedAssignmentRevision: 0 });
    const first = await rpc(alice, 'dw_join_roadmap', command);
    const replay = await rpc(alice, 'dw_join_roadmap', command);
    assert.equal(replay.roadmapId, first.roadmapId);
    const second = await join(bob, sessionId);
    assert.equal(second.roadmapId, first.roadmapId);
    assert.equal(second.territory.key, ARDATOV);
    assert.equal(second.territory.sourceType, 'municipal_district');
    assert.deepEqual(new Set(second.members.map((member) => member.userId)), new Set([
      FIXTURE_IDENTITIES['participant-a@workshop.test'].id, FIXTURE_IDENTITIES['participant-b@workshop.test'].id,
    ]));
    const board = await index(host, sessionId);
    assert.equal(board.rooms.length, 1);
    assert.equal(board.rooms[0].memberCount, 2);
    assert.equal(board.configuration.locked, true);
    assert.equal(board.configuration.dataEditionId, dataIndex.editionId);
    await rejected(host, 'dw_configure_roadmaps', named(sessionId, { expectedRevision: board.configuration.revision, roomLevel: 'region' }));
    await rejected(alice, 'dw_join_roadmap', named(sessionId, { territoryKey: 'invented-municipality', dataEditionId: dataIndex.editionId, expectedAssignmentRevision: 1 }));
    await rejected(alice, 'dw_join_roadmap', named(sessionId, { territoryKey: SARANSK, dataEditionId: 'forged-source-edition', expectedAssignmentRevision: 1 }));
    assert.equal((await index(host, sessionId)).rooms.length, 1);
    assert.equal(canonicalSeries.filter((series) => series.territoryKey === second.territory.key).length, 7);
    for (const series of second.series) assert.equal(await verifyCanonicalSeriesFingerprint(series), true);
  });

  it('rejects a stale edit of the same row while independent rows commit and persist', async () => {
    const { alice, bob, sessionId } = await classroom();
    const initial = await join(alice, sessionId);
    await join(bob, sessionId);
    const passport = find(initial, 'passport');
    const diagnosis = find(initial, 'diagnosis');
    await rpc(alice, 'dw_save_roadmap_item', named(sessionId, edit(initial, passport, { goal: 'Снизить неудовлетворённый спрос на присмотр.' })));
    await rejected(bob, 'dw_save_roadmap_item', named(sessionId, edit(initial, passport, { goal: 'Старая правка с того же экрана.' })), /REVISION_CONFLICT/);
    const independent = await rpc(bob, 'dw_save_roadmap_item', named(sessionId, edit(initial, diagnosis, { problem: 'Часы присмотра не совпадают с рабочим временем родителей.' })));
    assert.equal(find(independent, 'passport').data.goal, 'Снизить неудовлетворённый спрос на присмотр.');
    assert.equal(find(independent, 'diagnosis').data.problem, 'Часы присмотра не совпадают с рабочим временем родителей.');
    const save = named(sessionId, create(independent, 'risk', risk()));
    const saved = await rpc(bob, 'dw_save_roadmap_item', save);
    const replay = await rpc(bob, 'dw_save_roadmap_item', save);
    assert.equal(replay.items.filter((item) => item.kind === 'risk').length, 1);
    assert.equal(replay.revision, saved.revision);
    const fresh = await harness.signIn('participant-a@workshop.test');
    const reloaded = await snapshot(fresh, sessionId, saved.roadmapId);
    assert.equal(find(reloaded, 'risk').data.title, risk().title);
  });

  it('moves an assignment without losing earlier work and rejects cross-room writes', async () => {
    const { host, alice, bob, sessionId } = await classroom();
    let first = await join(alice, sessionId);
    await join(bob, sessionId);
    first = await rpc(alice, 'dw_save_roadmap_item', named(sessionId, create(first, 'risk', risk('Работа прежней команды сохранена'))));
    const second = await join(bob, sessionId, SARANSK);
    assert.notEqual(second.roadmapId, first.roadmapId);
    const old = await snapshot(bob, sessionId, first.roadmapId);
    assert.equal(old.canEdit, false);
    assert.equal(find(old, 'risk').data.title, 'Работа прежней команды сохранена');
    await rejected(bob, 'dw_save_roadmap_item', named(sessionId, edit(old, find(old, 'risk'), { title: 'Чужая команда' })), /FORBIDDEN|ROOM_REQUIRED/);
    assert.equal((await snapshot(alice, sessionId, first.roadmapId)).canEdit, true);
    assert.equal((await snapshot(host, sessionId, second.roadmapId)).canEdit, true);
    const board = await index(host, sessionId);
    assert.deepEqual(board.rooms.map((room) => room.memberCount).sort(), [1, 1]);
  });

  it('captures a source-reported fact on the server and rejects client values, nulls and foreign series', async () => {
    const { alice, bob, sessionId } = await classroom();
    let state = await join(alice, sessionId);
    const foreign = await join(bob, sessionId, SARANSK);
    const births = sourceSeries(ARDATOV, 'births_total');
    assert.equal(births.sourceMunicipalityKey, '89603000__9ef49d49');
    assert.equal(births.provenanceStatus, 'incomplete_primary');
    const request = { roadmapId: state.roadmapId, itemId: null, expectedRevision: 0, seriesId: births.id, expectedSeriesFingerprint: births.fingerprint, year: 2014, interpretation: 'Исходное число рождений; само по себе не измеряет эффект мер.' };
    await rejected(alice, 'dw_capture_roadmap_fact', named(sessionId, { ...request, value: 999999 }));
    await rejected(alice, 'dw_capture_roadmap_fact', named(sessionId, { ...request, expectedSeriesFingerprint: '0'.repeat(64) }));
    await rejected(alice, 'dw_capture_roadmap_fact', named(sessionId, { ...request, year: 2023 }));
    const foreignBirths = sourceSeries(SARANSK, 'births_total');
    await rejected(alice, 'dw_capture_roadmap_fact', named(sessionId, { ...request, seriesId: foreignBirths.id, expectedSeriesFingerprint: foreignBirths.fingerprint }));
    state = await rpc(alice, 'dw_capture_roadmap_fact', named(sessionId, request));
    const fact = find(state, 'fact');
    assert.equal(fact.data.value, 253);
    assert.equal(fact.data.year, 2014);
    assert.equal(fact.data.metricId, 'births_total');
    assert.equal(fact.data.seriesFingerprint, births.fingerprint);
    assert.equal(await verifyCanonicalSeriesFingerprint(state.series.find((series) => series.id === births.id)), true);
    await rejected(alice, 'dw_save_roadmap_item', named(sessionId, edit(state, fact, { value: 999999 })));
    const updated = await rpc(alice, 'dw_save_roadmap_item', named(sessionId, edit(state, fact, { interpretation: 'Уточнённая интерпретация при сохранении исходного числа.' })));
    assert.equal(find(updated, 'fact').data.value, 253);
    assert.equal(find(updated, 'fact').data.interpretation, 'Уточнённая интерпретация при сохранении исходного числа.');
    const saranskStock = sourceSeries(SARANSK, 'pop_mid');
    assert.equal(saranskStock.points.find((point) => point.year === 2011).value, 27766);
    assert.match(saranskStock.comparabilityNote, /Саранск, pop_mid.*2011/u);
    const sourceWarningCapture = await rpc(bob, 'dw_capture_roadmap_fact', named(sessionId, { ...request, roadmapId: foreign.roadmapId, seriesId: saranskStock.id, expectedSeriesFingerprint: saranskStock.fingerprint, year: 2011 }));
    assert.match(sourceWarningCapture.series[0].comparabilityNote, /Саранск, pop_mid.*2011/u);
  });

  it('stores scenarios against a sealed series and checks gaps, anchor year and target semantics', async () => {
    const { alice, sessionId } = await classroom();
    let state = await join(alice, sessionId);
    const births = sourceSeries(ARDATOV, 'births_total');
    const data = {
      title: 'Условная траектория числа рождений', seriesId: births.id, seriesFingerprint: births.fingerprint,
      assumptions: 'Учебное продолжение тенденции; не причинная оценка мер поддержки.',
      parameters: { metricId: births.metricId, historyStartYear: 2018, historyEndYear: 2022, endYear: 2025, baselineMethod: 'linear', targetMode: 'absolute_end', targetValue: 150 },
    };
    await rejected(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'scenario', { ...data, seriesFingerprint: '0'.repeat(64) })));
    await rejected(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'scenario', { ...data, parameters: { ...data.parameters, historyStartYear: 2010 } })));
    await rejected(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'scenario', { ...data, parameters: { ...data.parameters, historyStartYear: 2020 } })));
    await rejected(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'scenario', { ...data, parameters: { ...data.parameters, targetMode: 'percentage_points' } })));
    state = await rpc(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'scenario', data)));
    assert.deepEqual(find(state, 'scenario').data, data);
    assert.equal(find(state, 'scenario').data.seriesFingerprint, births.fingerprint);
    const edge = { ...data, title: 'Пустой край истории сохранён явно', parameters: { ...data.parameters, historyEndYear: 2023 } };
    state = await rpc(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'scenario', edge)));
    assert.ok(state.items.some((item) => item.kind === 'scenario' && item.data.title === edge.title && item.data.parameters.historyEndYear === 2023));
    const sealed = state.series.find((series) => series.id === births.id);
    assert.equal(sealed.points.find((point) => point.year === 2023).value, null);
    assert.equal(sealed.points.filter((point) => point.value !== null).at(-1).year, 2022);
    const horizon = { ...data, title: 'Длинный условный сценарий', parameters: { ...data.parameters, baselineMethod: 'last_value', endYear: 2052 } };
    state = await rpc(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'scenario', horizon)));
    await rejected(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'scenario', { ...horizon, parameters: { ...horizon.parameters, endYear: 2053 } })));
  });

  it('rounds exact quantities to kopecks and separates confirmed funding from expected funds', async () => {
    const { alice, sessionId } = await classroom();
    let state = await join(alice, sessionId);
    state = await rpc(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'activity', activity())));
    const action = find(state, 'activity');
    const cost = { activityId: action.id, year: 2027, title: 'Точный расчёт пробных часов', unit: 'условный час', quantity: '0.333', unitPriceKopecks: 1001, periods: 3, cashKind: 'cash', priceStatus: 'estimated', priceSource: 'Учебная смета; цена требует подтверждения', priceDate: '2026-11-08' };
    await rejected(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'cost', { ...cost, quantity: '0.0005' })));
    state = await rpc(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'cost', cost)));
    const line = find(state, 'cost');
    assert.equal(state.budget.needCashKopecks, 1000, '0.333 × 1001 × 3 = 999.999 kopecks rounds half-up to 1000');
    const funding = { costLineId: line.id, sourceName: 'Учебное подтверждение', sourceKind: 'municipal_budget', amountKopecks: 400, status: 'confirmed', sourceReference: 'Учебное основание суммы; не реальный бюджетный акт', sourceDate: '2026-11-08', originReference: 'Одна строка учебного источника' };
    await rejected(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'funding', { ...funding, sourceReference: '', sourceDate: null })));
    state = await rpc(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'funding', funding)));
    state = await rpc(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'funding', { ...funding, sourceName: 'Учебная заявка', sourceKind: 'grant', amountKopecks: 300, status: 'application', sourceReference: '', sourceDate: null })));
    assert.deepEqual(state.budget, { needCashKopecks: 1000, inKindKopecks: 0, confirmedKopecks: 400, expectedKopecks: 300, confirmedGapKopecks: 600, remainingAfterExpectedKopecks: 300, years: [{ year: 2027, needCashKopecks: 1000, inKindKopecks: 0, confirmedKopecks: 400, expectedKopecks: 300, confirmedGapKopecks: 600, remainingAfterExpectedKopecks: 300 }] });
    await rejected(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'funding', { ...funding, amountKopecks: 301, status: 'assumption' })));
    await rejected(alice, 'dw_save_roadmap_item', named(sessionId, edit(state, line, { unitPriceKopecks: 100 })));
    await rejected(alice, 'dw_save_roadmap_item', named(sessionId, edit(state, action, {}, 'archived')));
    assert.equal((await snapshot(alice, sessionId, state.roadmapId)).budget.confirmedGapKopecks, 600);
  });

  it('captures a barrier on the server, detects changed source content and preserves earlier material', async () => {
    const { alice, sessionId } = await classroom();
    let state = await join(alice, sessionId);
    let board = await rpc(alice, 'dw_save_barrier', named(sessionId, barrierInput()));
    const barrier = board.barriers[0];
    state = await rpc(alice, 'dw_capture_roadmap_basis', named(sessionId, { roadmapId: state.roadmapId, basisId: null, expectedRevision: 0, sourceKind: 'barrier', sourceId: barrier.id, expectedSourceRevision: barrier.contentRevision, rationale: 'Основание для проверки гипотезы доступности присмотра.', status: 'active' }));
    const captured = state.basis[0];
    assert.equal(captured.material.source.title, barrier.title);
    assert.deepEqual(captured.staleReasons, []);
    board = await rpc(alice, 'dw_save_barrier', named(sessionId, editBarrier(barrier, { description: 'После обсуждения уточнено: проблема выражена у родителей со сменной занятостью.' })));
    const changed = await snapshot(alice, sessionId, state.roadmapId);
    assert.ok(changed.basis[0].staleReasons.includes('source_changed'));
    assert.equal(changed.basis[0].material.source.description, barrier.description);
    assert.equal(changed.basis[0].fingerprint, captured.fingerprint);
    assert.notEqual(board.barriers[0].description, barrier.description);
  });

  it('freezes immutable canonical bytes and keeps later edits and reviews outside the captured version', async () => {
    const { host, alice, sessionId } = await classroom();
    let state = await join(alice, sessionId);
    state = await rpc(alice, 'dw_save_roadmap_item', named(sessionId, create(state, 'risk', risk('Риск до фиксации редакции'))));
    const births = sourceSeries(ARDATOV, 'births_total');
    state = await rpc(alice, 'dw_capture_roadmap_fact', named(sessionId, { roadmapId: state.roadmapId, itemId: null, expectedRevision: 0, seriesId: births.id, expectedSeriesFingerprint: births.fingerprint, year: 2014, interpretation: 'Факт, который войдёт в закреплённую редакцию вместе с источником.' }));
    state = await rpc(alice, 'dw_freeze_roadmap', named(sessionId, { roadmapId: state.roadmapId, expectedRevision: state.revision, title: 'Первая проверяемая редакция', kind: 'draft' }));
    assert.equal(state.versions.length, 1);
    const versionId = state.versions[0].id;
    const request = { p_session_id: sessionId, p_roadmap_id: state.roadmapId, p_version_id: versionId };
    const frozen = await rpc(alice, 'dw_roadmap_version', request);
    assert.equal(createHash('sha256').update(frozen.canonicalJson).digest('hex'), frozen.sha256);
    assert.deepEqual(JSON.parse(frozen.canonicalJson), frozen.snapshot);
    assert.equal(frozen.snapshot.templateVersion, 'organizers-roadmap-1');
    assert.ok(frozen.snapshot.series.some((series) => series.territoryKey === ARDATOV));
    await rpc(alice, 'dw_save_roadmap_item', named(sessionId, edit(state, find(state, 'risk'), { title: 'Последующее изменение текущей карты' })));
    const afterEdit = await rpc(alice, 'dw_roadmap_version', request);
    assert.equal(afterEdit.canonicalJson, frozen.canonicalJson);
    assert.equal(afterEdit.sha256, frozen.sha256);
    await rpc(host, 'dw_review_roadmap', named(sessionId, { roadmapId: state.roadmapId, versionId, expectedRevision: 0, decision: 'revise', comment: 'Уточнить источник финансирования до защиты.' }));
    const reviewed = await rpc(alice, 'dw_roadmap_version', request);
    assert.equal(reviewed.canonicalJson, frozen.canonicalJson);
    assert.equal(reviewed.sha256, frozen.sha256);
    assert.equal(reviewed.review.decision, 'revise');
  });

  it('keeps observers read-only, restricts the projector DTO and rechecks revoked membership before replay', async () => {
    const { host, alice, observer, sessionId } = await classroom({ includeObserver: true });
    let state = await join(alice, sessionId);
    const command = named(sessionId, create(state, 'risk', risk('Учебный риск без персональных данных')));
    state = await rpc(alice, 'dw_save_roadmap_item', command);
    assert.equal((await snapshot(observer, sessionId, state.roadmapId)).canEdit, false);
    await rejected(observer, 'dw_join_roadmap', named(sessionId, { territoryKey: ARDATOV, dataEditionId: dataIndex.editionId, expectedAssignmentRevision: 0 }), /FORBIDDEN/);
    await rejected(observer, 'dw_save_roadmap_item', named(sessionId, create(state, 'risk', risk())), /FORBIDDEN/);
    await rejected(alice, 'dw_roadmaps_projector_snapshot', { p_session_id: sessionId, p_roadmap_id: state.roadmapId }, /FORBIDDEN/);
    const projection = await rpc(host, 'dw_roadmaps_projector_snapshot', { p_session_id: sessionId, p_roadmap_id: state.roadmapId });
    assert.equal(projection.selected.roadmapId, state.roadmapId);
    assertNoKeys(projection, new Set(['userId', 'authorId', 'createdBy', 'updatedBy', 'createdByName', 'updatedByName', 'members', 'teamNames', 'email', 'invitationToken', 'responseSecret', 'answerBarrier', 'answerSupport', 'responses']));
    const session = await sessionSnapshot(host, sessionId);
    const member = session.members.find((item) => item.userId === FIXTURE_IDENTITIES['participant-a@workshop.test'].id);
    await rpc(host, 'dw_revoke_member', { p_operation_id: randomUUID(), p_session_id: sessionId, p_member_id: member.userId, p_expected_revision: member.revision });
    await rejected(alice, 'dw_roadmap_snapshot', { p_session_id: sessionId, p_roadmap_id: state.roadmapId }, /FORBIDDEN/);
    await rejected(alice, 'dw_roadmaps_index', { p_session_id: sessionId }, /FORBIDDEN/);
    await rejected(alice, 'dw_save_roadmap_item', command, /FORBIDDEN/);
    assert.equal((await snapshot(host, sessionId, state.roadmapId)).items.filter((item) => item.kind === 'risk').length, 1);
  });
});
