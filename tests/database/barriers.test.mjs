import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { asUser, callRpc, createTestDatabase, projectRoot, seedAuthUser, seedCanonicalDocument, loadMordovia, rpcArguments } from './harness.mjs';
import { purgeExpiredSurveys } from '../../scripts/purge-expired-surveys.mjs';

let db; let bundle; let doc;
const id = () => randomUUID(); const token = () => randomBytes(32).toString('hex');
const code = (promise, expected) => assert.rejects(promise, (e) => e.code === 'P0001' && e.message === expected);
const permission = (promise) => assert.rejects(promise, (e) => e.code === '42501');
const rpc = (who, name, args = {}, database = db) => callRpc(database, who, name, args);
const snapshot = (e, who = e.host) => rpc(who, 'dw_barriers_snapshot', { p_session_id: e.sessionId });
const named = (e, name, input, who = e.host, operation = id()) => rpc(who, name, { p_operation_id: operation, p_session_id: e.sessionId, p_input: input });
const oldSnapshot = (e, database = db) => rpc(e.host, 'dw_session_snapshot', { p_session_id: e.sessionId }, database);
async function anon(name, args, database = db) {
  const keys = rpcArguments[name];
  return database.transaction(async (tx) => {
    await tx.exec('set local role anon');
    await tx.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: 'anon' })]);
    const values = keys.map((key) => args[key] && typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key] ?? null);
    return (await tx.query(`select public.${name}(${keys.map((_, i) => `$${i + 1}`).join(',')}) as data`, values)).rows[0].data;
  });
}
before(async () => {
  db = await createTestDatabase(); doc = await loadMordovia();
  const corpus = JSON.parse(await readFile(resolve(projectRoot, 'public/data/corpus/practices.json'), 'utf8'));
  const raw = corpus.variants.find((v) => v.id === 'mordovia-kindergarten-compensation');
  const keys = ['id','familyId','regionId','title','mechanism','eligibility','amount','conditions','occurrenceIds','evidence','reviewStatus'];
  const okeys = ['id','documentId','versionId','anchor','reviewStatus','note'];
  bundle = { schemaVersion: 1,
    practice: Object.fromEntries(keys.filter((k) => k in raw).map((k) => [k, raw[k]])),
    occurrences: corpus.occurrences.filter((o) => raw.occurrenceIds.includes(o.id)).map((o) => Object.fromEntries(okeys.filter((k) => k in o).map((k) => [k, o[k]]))),
    sources: [{ sourceId: doc.meta.id, editionId: doc.version.id, title: doc.meta.title, sha256: doc.version.sourceSha256,
      normalizationVersion: doc.version.normalizationVersion, sourceUrl: doc.version.sourceUrl, regionId: doc.meta.regionId }],
    note: 'Учебный источник: условия и исходные цитаты сохранены без утверждения об эффективности.' };
});
after(async () => db?.close());
async function user(name, database = db) {
  const who = id(); await seedAuthUser(database, { id: who, email: `${who}@stage4.test` });
  await rpc(who, 'dw_save_profile', { p_operation_id: id(), p_expected_revision: 0, p_full_name: name }, database); return who;
}
async function setup(database = db) {
  const host = await user('Ведущий', database); const alice = await user('Участник А', database); const bob = await user('Участник Б', database);
  await database.query('insert into private.facilitators(user_id) values($1)', [host]);
  const s = await rpc(host, 'dw_create_session', { p_operation_id: id(), p_title: 'Путь семьи и решения', p_scope: 'municipality', p_region_id: 'respublika-mordoviia' }, database);
  const sessionId = s.session.id; const invitation = await rpc(host, 'dw_invitation', { p_session_id: sessionId }, database);
  for (const who of [alice, bob]) await rpc(who, 'dw_join_session', { p_operation_id: id(), p_code: invitation.code }, database);
  return { host, alice, bob, sessionId };
}
async function patchSession(e, patch, database = db) {
  const s = await oldSnapshot(e, database);
  return rpc(e.host, 'dw_update_session', { p_operation_id: id(), p_session_id: e.sessionId, p_expected_revision: s.session.revision, p_patch: patch }, database);
}
async function role(e, who, roleName) {
  const s = await oldSnapshot(e); const m = s.members.find((x) => x.userId === who);
  return rpc(e.host, 'dw_set_member_role', { p_operation_id: id(), p_session_id: e.sessionId, p_member_id: who, p_expected_revision: m.revision, p_role: roleName });
}
async function revoke(e, who) {
  const s = await oldSnapshot(e); const m = s.members.find((x) => x.userId === who);
  return rpc(e.host, 'dw_revoke_member', { p_operation_id: id(), p_session_id: e.sessionId, p_member_id: who, p_expected_revision: m.revision });
}
const barrierInput = (extra = {}) => ({ barrierId: null, expectedRevision: 0, title: 'Не хватает доступного жилья', description: 'Наблюдение в муниципальной практике.',
  primaryStage: 'first_child', stageIds: ['first_child', 'next_child'], evidenceKind: 'observation', status: 'active', priority: false, ...extra });
const barrierEdit = (b, extra = {}) => barrierInput({ barrierId: b.id, expectedRevision: b.revision, title: b.title, description: b.description,
  primaryStage: b.primaryStage, stageIds: b.stageIds, evidenceKind: b.evidenceKind, status: b.status, priority: b.priority, ...extra });
async function addBarrier(e, who = e.alice) { return (await named(e, 'dw_save_barrier', barrierInput(), who)).barriers.at(-1); }
async function curated(e) {
  const published = await rpc(e.alice, 'dw_publish_submission', { p_operation_id: id(), p_session_id: e.sessionId, p_local_key: bundle.practice.id,
    p_expected_revision: null, p_bundle: structuredClone(bundle) });
  const submission = published.submissions.find((v) => v.authorId === e.alice);
  const w = await rpc(e.host, 'dw_workshop_snapshot', { p_session_id: e.sessionId });
  const result = await rpc(e.host, 'dw_save_family', { p_operation_id: id(), p_session_id: e.sessionId, p_family_id: null, p_expected_board_revision: w.boardRevision,
    p_title: 'Доступное дошкольное образование', p_mechanism: 'Частичная компенсация расходов семьи', p_rationale: 'Сохраняем исходные условия регионального варианта.', p_submission_ids: [submission.id] });
  return { submission, familyId: result.families.at(-1).id };
}
const linkInput = (b, f, extra = {}) => ({ linkId: null, expectedRevision: 0, barrierId: b.id, expectedBarrierRevision: b.revision,
  familyId: f.id, expectedFamilyFingerprint: f.fingerprint, relationship: 'partial', explanation: 'Мера может уменьшить часть расходов семьи, но не устраняет все ограничения.', prerequisites: 'Нужно проверить местные условия.', status: 'active', ...extra });
const solutionInput = (b, extra = {}) => ({ solutionId: null, expectedRevision: 0, barrierIds: [b.id], title: 'Маршрут поддержки семьи', targetGroup: 'Семьи с маленькими детьми',
  mechanism: 'Совместная навигация учреждений по доступным услугам.', firstStep: 'Провести интервью с семьями', responsible: 'Муниципальная команда',
  resources: 'Рабочее время специалистов', successIndicator: 'Время получения услуги', risks: 'Ограниченный кадровый ресурс', status: 'active', ...extra });
const config = (invitation, extra = {}) => ({ surveyId: null, expectedRevision: 0, title: 'Условия родительства', purpose: 'Учебное обсуждение препятствий и возможных решений в муниципалитете.',
  organizerContact: 'organizer@example.test', retentionUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  questionBarrier: 'Что, по Вашему мнению, препятствует рождению ребёнка?', questionSupport: 'Какое изменение условий могло бы помочь?', invitationToken: invitation, ...extra });
async function openSurvey(e) {
  const invitation = token(); let survey = (await named(e, 'dw_save_survey', config(invitation))).survey;
  survey = (await named(e, 'dw_manage_survey', { surveyId: survey.id, expectedRevision: survey.revision, action: 'open' })).survey;
  return { ...e, survey, invitation };
}
const answers = (extra = {}) => ({ expectedRevision: 0, questionVersion: 1, perspective: 'self', intention12m: null, intention36m: 'unsure',
  answerBarrier: 'Недостаточно доступных услуг ухода за детьми.', answerSupport: null, priorityChange: null, priorityConditionId: null,
  horizon: null, conditionalChange: null, additionalConditions: null, consentEducational: true, consentResearch: false, consentQuote: false, adultConfirmed: true, ...extra });
const responseArgs = (e, secret, extra = {}) => ({ p_operation_id: id(), p_survey_id: e.survey.id, p_invitation_token: e.invitation, p_response_secret: secret,
  p_input: answers({ questionVersion: e.survey.questionVersion, ...extra }) });
const own = (e, secret) => anon('dw_survey_own_response', { p_survey_id: e.survey.id, p_response_secret: secret });
const hostState = (e) => rpc(e.host, 'dw_survey_host_state', { p_session_id: e.sessionId, p_survey_id: e.survey.id });
const exportSurvey = (e, who = e.host) => rpc(who, 'dw_survey_research_export', { p_session_id: e.sessionId, p_survey_id: e.survey.id });

describe('Named barriers, current deliberation, immutable evidence', { concurrency: false }, () => {
  it('enforces ownership, host priority, observer/read boundaries, current membership and complete bounded inputs', async () => {
    const e = await setup(); const b = await addBarrier(e); const outsider = await user('Посторонний');
    await code(named(e, 'dw_save_barrier', barrierEdit(b, { title: 'Чужая правка карточки' }), e.bob), 'FORBIDDEN');
    await code(named(e, 'dw_save_barrier', barrierEdit(b, { priority: true }), e.alice), 'FORBIDDEN');
    await code(snapshot(e, outsider), 'FORBIDDEN');
    await role(e, e.bob, 'observer'); assert.equal((await snapshot(e, e.bob)).barriers.length, 1);
    await code(named(e, 'dw_save_barrier', barrierInput(), e.bob), 'FORBIDDEN');
    for (const extra of [{ stageIds: ['first_child', 'first_child'] }, { stageIds: ['unknown'] }, { stageIds: [] }, { primaryStage: 'pregnancy' },
      { expectedRevision: -1 }, { expectedRevision: 0.2 }, { expectedRevision: '0' }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { title: 'x'.repeat(241) }, { authorId: e.host }, { description: null }]) {
      await code(named(e, 'dw_save_barrier', barrierInput(extra), e.alice), 'INVALID_INPUT');
    }
    await revoke(e, e.alice); await code(snapshot(e, e.alice), 'FORBIDDEN');
    await permission(asUser(db, e.host, (tx) => tx.query('select * from private.dw_barriers')));
  });
  it('serializes revisions/idempotency and keeps neutral, absent and revoked votes distinct without fake percentages', async () => {
    const e = await setup(); const op = id(); const input = barrierInput();
    const first = await named(e, 'dw_save_barrier', input, e.alice, op); const b = first.barriers[0];
    assert.equal((await named(e, 'dw_save_barrier', input, e.alice, op)).barriers.length, 1);
    await code(named(e, 'dw_save_barrier', { ...input, title: 'Изменённая повторная команда' }, e.alice, op), 'IDEMPOTENCY_CONFLICT');
    await named(e, 'dw_barrier_vote', { barrierId: b.id, expectedRevision: 0, value: 1 }, e.alice);
    let s = await named(e, 'dw_barrier_vote', { barrierId: b.id, expectedRevision: 0, value: 0 }, e.bob);
    assert.deepEqual(s.barriers[0].totals, { support: 1, oppose: 0, neutral: 1, cast: 2 });
    s = await named(e, 'dw_barrier_vote', { barrierId: b.id, expectedRevision: 1, value: null }, e.bob);
    assert.equal(s.barriers[0].totals.cast, 1); assert.equal(s.barriers[0].myVoteRevision, 2);
    await code(named(e, 'dw_barrier_vote', { barrierId: b.id, expectedRevision: 0, value: -1 }, e.bob), 'REVISION_CONFLICT');
    await revoke(e, e.alice); assert.equal((await snapshot(e)).barriers[0].totals.cast, 0);
    await named(e, 'dw_save_barrier', barrierEdit(b, { priority: true }));
    await code(named(e, 'dw_save_barrier', barrierEdit(b)), 'REVISION_CONFLICT');
  });
  it('freezes shared source bundles once, marks changed targets, preserves prior citations and allows orphan archival', async () => {
    const e = await setup(); const { submission, familyId } = await curated(e); const b = await addBarrier(e);
    let s = await snapshot(e); const f = s.families.find((v) => v.id === familyId);
    s = await named(e, 'dw_save_barrier_link', linkInput(b, f), e.alice); const link = s.links[0];
    await named(e, 'dw_save_barrier_link', linkInput(b, f), e.bob);
    s = await snapshot(e); assert.equal(s.links[0].evidenceId, s.links[1].evidenceId);
    const evidence = await rpc(e.alice, 'dw_barrier_evidence', { p_session_id: e.sessionId, p_evidence_id: link.evidenceId });
    assert.deepEqual(evidence.variants[0].bundle, bundle); assert.equal('variants' in s.links[0], false);
    await named(e, 'dw_save_barrier', barrierEdit(b, { priority: true }));
    assert.deepEqual((await snapshot(e)).links[0].staleReasons, []);
    let current = (await snapshot(e)).barriers[0];
    await named(e, 'dw_save_barrier', barrierEdit(current, { description: 'Проверено обсуждением: меняется контекст проблемы.' }));
    assert.ok((await snapshot(e)).links[0].staleReasons.includes('barrier_changed'));
    const revisedBundle = structuredClone(bundle); revisedBundle.note += ' Новая редакция заметки.';
    await rpc(e.alice, 'dw_publish_submission', { p_operation_id: id(), p_session_id: e.sessionId, p_local_key: bundle.practice.id,
      p_expected_revision: submission.revision, p_bundle: revisedBundle });
    s = await snapshot(e); assert.ok(s.links[0].staleReasons.includes('family_changed'));
    await code(named(e, 'dw_save_barrier_link', linkInput(s.barriers[0], f), e.alice), 'FAMILY_CHANGED');
    const w = await rpc(e.host, 'dw_workshop_snapshot', { p_session_id: e.sessionId });
    await rpc(e.host, 'dw_delete_family', { p_operation_id: id(), p_session_id: e.sessionId, p_family_id: familyId, p_expected_board_revision: w.boardRevision });
    assert.ok((await snapshot(e)).links[0].staleReasons.includes('family_missing'));
    const archived = await named(e, 'dw_save_barrier_link', linkInput(b, f, { linkId: link.id, expectedRevision: link.revision, status: 'archived' }), e.alice);
    assert.equal(archived.links[0].status, 'archived');
    assert.deepEqual(await rpc(e.alice, 'dw_barrier_evidence', { p_session_id: e.sessionId, p_evidence_id: link.evidenceId }), evidence);
    await code(db.query('update private.dw_barrier_evidence set material=$1 where id=$2', [JSON.stringify({ forged: true }), link.evidenceId]), 'EVIDENCE_IMMUTABLE');
  });
  it('rejects cross-session targets and read attempts while solutions retain several precise barrier links', async () => {
    const e = await setup(); const other = await setup(); const b = await addBarrier(e); const b2 = await addBarrier(e, e.bob); const foreign = await addBarrier(other);
    let s = await named(e, 'dw_save_solution', solutionInput(b, { barrierIds: [b.id, b2.id] }), e.alice);
    assert.deepEqual(s.solutions[0].barrierIds, [b.id, b2.id]); const solution = s.solutions[0];
    await code(named(e, 'dw_save_solution', solutionInput(b, { barrierIds: [foreign.id] }), e.alice), 'INVALID_INPUT');
    await code(named(e, 'dw_save_solution', solutionInput(b, { barrierIds: [b.id, b.id] }), e.alice), 'INVALID_INPUT');
    await code(named(e, 'dw_save_solution', solutionInput(b, { solutionId: solution.id, expectedRevision: solution.revision }), e.bob), 'FORBIDDEN');
    await code(named(e, 'dw_barrier_vote', { barrierId: foreign.id, expectedRevision: 0, value: 1 }, e.alice), 'NOT_FOUND');
    await code(rpc(e.host, 'dw_barrier_evidence', { p_session_id: e.sessionId, p_evidence_id: id() }), 'NOT_FOUND');
    const projection = await rpc(e.host, 'dw_barriers_projector_snapshot', { p_session_id: e.sessionId });
    assert.equal(projection.barriers[0].authorName, null); assert.equal('myVote' in projection.barriers[0], false); assert.equal('authorId' in projection.solutions[0], false);
    await patchSession(e, { projectorShowAuthors: true });
    assert.equal((await rpc(e.host, 'dw_barriers_projector_snapshot', { p_session_id: e.sessionId })).barriers[0].authorName, 'Участник А');
    await code(rpc(e.alice, 'dw_barriers_projector_snapshot', { p_session_id: e.sessionId }), 'FORBIDDEN');
    await curated(other); const otherFamily = (await snapshot(other)).families[0];
    const linked = await named(other, 'dw_save_barrier_link', linkInput(foreign, otherFamily), other.alice);
    await code(named(e, 'dw_save_barrier_link', linkInput(b, otherFamily), e.alice), 'FAMILY_MISSING');
    await code(rpc(e.host, 'dw_barrier_evidence', { p_session_id: e.sessionId, p_evidence_id: linked.links[0].evidenceId }), 'NOT_FOUND');
  });
  it('works before reading and in discussion, isolates prior cursors and ignores Stage 3 ballots', async () => {
    const e = await setup(); await curated(e); const beforeOld = await oldSnapshot(e); const beforeW = await rpc(e.host, 'dw_workshop_snapshot', { p_session_id: e.sessionId });
    await addBarrier(e); assert.equal((await oldSnapshot(e)).cursor, beforeOld.cursor);
    assert.equal((await rpc(e.host, 'dw_workshop_snapshot', { p_session_id: e.sessionId })).cursor, beforeW.cursor);
    await patchSession(e, { phase: 'discussion' }); await addBarrier(e, e.bob);
    const w = await rpc(e.host, 'dw_workshop_snapshot', { p_session_id: e.sessionId });
    const round = (await rpc(e.host, 'dw_open_voting_round', { p_operation_id: id(), p_session_id: e.sessionId, p_title: 'Первое обсуждение',
      p_results_visibility: 'after_close', p_expected_board_revision: w.boardRevision, p_settings: {} })).round;
    const before = (await snapshot(e)).cursor;
    await rpc(e.alice, 'dw_cast_vote', { p_operation_id: id(), p_session_id: e.sessionId, p_round_id: round.id, p_family_id: round.families[0].id, p_value: 1, p_expected_revision: 0 });
    assert.equal((await snapshot(e)).cursor, before);
    assert.equal((await rpc(e.host, 'dw_workshop_round_snapshot', { p_session_id: e.sessionId, p_round_id: round.id })).families[0].totals, null);
    await patchSession(e, { status: 'paused' }); await code(addBarrier(e), 'SESSION_NOT_OPEN');
  });
});

describe('Anonymous survey capability, consent, withdrawal and retention', { concurrency: false }, () => {
  it('accepts only direct anon, never stores secrets or precise answer timestamps, and emits no response events', async () => {
    const e = await openSurvey(await setup()); const secret = token(); const args = responseArgs(e, secret);
    await code(rpc(e.alice, 'dw_survey_save_response', args), 'SURVEY_ANON_ONLY');
    await code(rpc(null, 'dw_survey_public_manifest', { p_survey_id: e.survey.id, p_invitation_token: e.invitation }), 'SURVEY_ANON_ONLY');
    const before = await db.query('select (select count(*) from private.command_receipts) as receipts,(select count(*) from private.audit_events) as audit,(select count(*) from public.dw_barrier_events) as events');
    const result = await anon('dw_survey_save_response', args); assert.equal(result.revision, 1);
    const afterCounts = await db.query('select (select count(*) from private.command_receipts) as receipts,(select count(*) from private.audit_events) as audit,(select count(*) from public.dw_barrier_events) as events');
    assert.deepEqual(afterCounts.rows, before.rows);
    const stored = (await db.query('select row_to_json(r) as data from research.responses r where survey_id=$1', [e.survey.id])).rows[0].data;
    assert.equal(JSON.stringify(stored).includes(secret), false); assert.equal(JSON.stringify(stored).includes(e.alice), false);
    assert.equal('created_at' in stored, false); assert.equal('updated_at' in stored, false); assert.match(stored.response_date, /^\d{4}-\d{2}-\d{2}$/u);
    const host = await hostState(e); assert.equal(host.invitationDigest, createHash('sha256').update(`dw-survey-invite:${e.invitation}`).digest('hex'));
    assert.equal(JSON.stringify(host).includes(e.invitation), false);
    await permission(asUser(db, e.host, (tx) => tx.query('select * from research.responses')));
    await code(exportSurvey(e, e.alice), 'FORBIDDEN');
  });
  it('reconciles invitations through metadata alone and restricts that entry point to the current host/session', async () => {
    const e = await openSurvey(await setup()); const other = await openSurvey(await setup());
    await anon('dw_survey_save_response', responseArgs(e, token()));
    const args = { p_session_id: e.sessionId, p_survey_id: e.survey.id };
    const metadata = await rpc(e.host, 'dw_survey_invitation_state', args);
    assert.deepEqual(metadata, { surveyId: e.survey.id, invitationDigest: createHash('sha256').update(`dw-survey-invite:${e.invitation}`).digest('hex') });
    await code(rpc(e.alice, 'dw_survey_invitation_state', args), 'FORBIDDEN');
    await permission(anon('dw_survey_invitation_state', args));
    await code(rpc(e.host, 'dw_survey_invitation_state', { ...args, p_survey_id: other.survey.id }), 'NOT_FOUND');
    await code(rpc(other.host, 'dw_survey_invitation_state', args), 'FORBIDDEN');
  });
  it('requires consent, freezes questions, separates self and proxy branches and resets changed conditions', async () => {
    const e = await openSurvey(await setup());
    for (const extra of [{ consentEducational: false }, { adultConfirmed: false }, { consentQuote: true, consentResearch: false }])
      await code(anon('dw_survey_save_response', responseArgs(e, token(), extra)), 'SURVEY_CONSENT_REQUIRED');
    for (const extra of [{ perspective: 'professional', intention12m: 'probably_yes' }, { conditionalChange: 'probably_change' }, { priorityChange: 'Жильё без долга' }, { answerBarrier: null, answerSupport: null }])
      await code(anon('dw_survey_save_response', responseArgs(e, token(), extra)), 'SURVEY_BRANCH_INVALID');
    await code(anon('dw_survey_save_response', responseArgs(e, token(), { answerBarrier: 'a'.repeat(4001) })), 'INVALID_INPUT');
    await code(anon('dw_survey_save_response', responseArgs(e, token(), { expectedRevision: '0' })), 'INVALID_INPUT');
    const invalid = responseArgs(e, token()); delete invalid.p_input.intention12m;
    await code(anon('dw_survey_save_response', invalid), 'INVALID_INPUT');
    const secret = token(); const condition = id();
    let r = await anon('dw_survey_save_response', responseArgs(e, secret, { priorityChange: 'Жильё без долга', priorityConditionId: condition, conditionalChange: 'probably_change' }));
    await code(anon('dw_survey_save_response', responseArgs(e, secret, { expectedRevision: r.revision, priorityChange: 'Доступная группа ухода', priorityConditionId: condition, conditionalChange: 'probably_change' })), 'SURVEY_CONDITION_CHANGED');
    r = await anon('dw_survey_save_response', responseArgs(e, secret, { expectedRevision: r.revision, perspective: 'adult_child_reported', intention36m: null }));
    assert.equal(r.conditionalChange, null); assert.equal(r.priorityConditionId, null);
    await code(named(e, 'dw_save_survey', { ...config(e.invitation), invitationToken: undefined, surveyId: e.survey.id, expectedRevision: e.survey.revision }), 'SURVEY_FROZEN');
    const declined = await anon('dw_survey_save_response', responseArgs(e, token(), { perspective: 'decline', intention36m: null, answerBarrier: null }));
    assert.equal(declined.status, 'submitted');
  });
  it('suppresses collective counts below five, keeps projector minimal and exports only current research consent', async () => {
    const e = await openSurvey(await setup()); const secrets = Array.from({ length: 5 }, token);
    for (let i = 0; i < 5; i++) {
      await anon('dw_survey_save_response', responseArgs(e, secrets[i], { consentResearch: i < 3, consentQuote: i === 0 }));
      assert.equal((await snapshot(e)).survey.responseCount, i < 4 ? null : 5);
    }
    let exported = await exportSurvey(e); assert.equal(exported.records.length, 3); assert.equal(exported.records.filter((r) => r.consentQuote).length, 1);
    for (const r of exported.records) {
      for (const key of ['id','rowKey','secret_digest','user_id','priorityConditionId','createdAt','consentEducational','adultConfirmed']) assert.equal(key in r, false);
    }
    assert.equal(exported.records[0].missingReasons.conditionalChange, 'not_asked');
    const projected = await rpc(e.host, 'dw_barriers_projector_snapshot', { p_session_id: e.sessionId });
    assert.deepEqual(Object.keys(projected.survey).sort(), ['responseCount','status','title']);
    assert.equal(JSON.stringify(projected).includes(answers().answerBarrier), false);
    assert.equal(JSON.stringify(await snapshot(e)).includes(answers().answerBarrier), false);
    let r = await own(e, secrets[0]); await anon('dw_survey_save_response', responseArgs(e, secrets[0], { expectedRevision: r.revision, consentResearch: false, consentQuote: false }));
    exported = await exportSurvey(e); assert.equal(exported.records.length, 2);
    r = await own(e, secrets[1]); await anon('dw_survey_withdraw_response', { p_operation_id: id(), p_survey_id: e.survey.id, p_response_secret: secrets[1], p_expected_revision: r.revision });
    assert.equal((await snapshot(e)).survey.responseCount, null); assert.equal((await exportSurvey(e)).records.length, 1);
  });
  it('retains capability after invitation rotation and close, and never resurrects withdrawn content through replay', async () => {
    const e = await openSurvey(await setup()); const secret = token(); const args = responseArgs(e, secret, { consentResearch: true });
    let r = await anon('dw_survey_save_response', args); assert.deepEqual(await anon('dw_survey_save_response', args), r);
    await code(anon('dw_survey_save_response', { ...args, p_input: { ...args.p_input, answerSupport: 'Изменённый ответ в старой операции' } }), 'IDEMPOTENCY_CONFLICT');
    let survey = (await named(e, 'dw_manage_survey', { surveyId: e.survey.id, expectedRevision: e.survey.revision, action: 'rotate', invitationToken: token() })).survey;
    await code(anon('dw_survey_public_manifest', { p_survey_id: e.survey.id, p_invitation_token: e.invitation }), 'SURVEY_INVITATION_INVALID');
    assert.equal((await own(e, secret)).answerBarrier, args.p_input.answerBarrier);
    await named(e, 'dw_manage_survey', { surveyId: survey.id, expectedRevision: survey.revision, action: 'close' });
    assert.equal((await own(e, secret)).availability, 'closed');
    const withdraw = { p_operation_id: id(), p_survey_id: e.survey.id, p_response_secret: secret, p_expected_revision: r.revision };
    r = await anon('dw_survey_withdraw_response', withdraw); assert.equal(r.status, 'withdrawn'); assert.equal(r.answerBarrier, null);
    assert.deepEqual(await anon('dw_survey_withdraw_response', withdraw), r);
    await code(anon('dw_survey_save_response', args), 'SURVEY_INVITATION_INVALID');
    assert.equal((await hostState(e)).responses.length, 0);
    assert.equal((await db.query('select answers from research.responses where survey_id=$1', [e.survey.id])).rows[0].answers, null);
  });
  it('expiry hides raw answers, retains withdrawal and purge, and prevents exports even for hosts', async () => {
    const e = await openSurvey(await setup()); const secret = token(); await anon('dw_survey_save_response', responseArgs(e, secret, { consentResearch: true }));
    await db.query("update research.surveys set retention_until=(now() at time zone 'UTC')::date-1 where id=$1", [e.survey.id]);
    const r = await own(e, secret); assert.equal(r.availability, 'expired'); assert.equal(r.answerBarrier, null);
    assert.equal((await hostState(e)).responses.length, 0); await code(exportSurvey(e), 'SURVEY_EXPIRED');
    await code(anon('dw_survey_save_response', responseArgs(e, token())), 'SURVEY_EXPIRED');
    assert.equal((await snapshot(e)).survey.responseCount, null);
    const w = await anon('dw_survey_withdraw_response', { p_operation_id: id(), p_survey_id: e.survey.id, p_response_secret: secret, p_expected_revision: r.revision });
    assert.equal(w.status, 'withdrawn');
    await patchSession(e, { status: 'closed' });
    await named(e, 'dw_manage_survey', { surveyId: e.survey.id, expectedRevision: e.survey.revision, action: 'purge' });
    assert.equal((await own(e, secret)).availability, 'purged');
  });
  it('purge scrubs answer payloads while old successful-save receipts return only blank tombstones', async () => {
    const e = await openSurvey(await setup()); const secret = token(); const args = responseArgs(e, secret, { consentResearch: true });
    await anon('dw_survey_save_response', args);
    await named(e, 'dw_manage_survey', { surveyId: e.survey.id, expectedRevision: e.survey.revision, action: 'purge' });
    assert.equal((await snapshot(e)).survey, null);
    const replay = await anon('dw_survey_save_response', args); assert.equal(replay.status, 'withdrawn'); assert.equal(replay.answerBarrier, null); assert.equal(replay.availability, 'purged');
    await code(exportSurvey(e), 'SURVEY_PURGED');
    const state = await hostState(e); assert.equal(state.responses.length, 0);
    await anon('dw_survey_withdraw_response', { p_operation_id: id(), p_survey_id: e.survey.id, p_response_secret: secret, p_expected_revision: replay.revision });
    const next = await named(e, 'dw_save_survey', config(token())); assert.notEqual(next.survey.id, e.survey.id);
  });
  it('validates retention bounds and rejects stale config/open commands and foreign survey IDs', async () => {
    const e = await setup(); const other = await openSurvey(await setup());
    for (const value of ['2026-02-30', '9999-01-01', new Date().toISOString().slice(0, 10), new Date(Date.now() + 366 * 86400000).toISOString().slice(0, 10)])
      await code(named(e, 'dw_save_survey', config(token(), { retentionUntil: value })), 'INVALID_INPUT');
    const created = (await named(e, 'dw_save_survey', config(token()))).survey;
    await code(named(e, 'dw_manage_survey', { surveyId: created.id, expectedRevision: 0, action: 'open' }), 'INVALID_INPUT');
    await code(rpc(e.host, 'dw_survey_host_state', { p_session_id: e.sessionId, p_survey_id: other.survey.id }), 'NOT_FOUND');
    await code(rpc(e.host, 'dw_survey_research_export', { p_session_id: e.sessionId, p_survey_id: other.survey.id }), 'NOT_FOUND');
    await code(anon('dw_survey_public_manifest', { p_survey_id: created.id, p_invitation_token: other.invitation }), 'SURVEY_INVITATION_INVALID');
  });
  it('dry-runs the operator retention task and atomically purges only expired surveys with retained capabilities', async () => {
    const expired = await openSurvey(await setup()); const current = await openSurvey(await setup()); const secret = token();
    const original = responseArgs(expired, secret); await anon('dw_survey_save_response', original);
    await anon('dw_survey_save_response', responseArgs(current, token()));
    await db.query("update research.surveys set retention_until=(now() at time zone 'UTC')::date-1 where id=$1", [expired.survey.id]);
    const dry = await purgeExpiredSurveys(db); assert.equal(dry.mode, 'dry-run'); assert.equal(dry.surveyCount, 1); assert.equal(dry.responseCount, 1);
    assert.equal(JSON.stringify(dry).includes(original.p_input.answerBarrier), false);
    assert.notEqual((await db.query('select answers from research.responses where survey_id=$1', [expired.survey.id])).rows[0].answers, null);
    const applied = await purgeExpiredSurveys(db, { apply: true }); assert.equal(applied.responseCount, 1);
    const receipt = await anon('dw_survey_save_response', original); assert.equal(receipt.availability, 'purged'); assert.equal(receipt.answerBarrier, null);
    assert.equal((await hostState(current)).responseCount, 1); assert.equal((await purgeExpiredSurveys(db, { apply: true })).surveyCount, 0);
  });
  it('rolls back operator purge if the administrative invalidation cannot be committed', async () => {
    const e = await openSurvey(await setup()); const secret = token(); await anon('dw_survey_save_response', responseArgs(e, secret));
    await db.query("update research.surveys set retention_until=(now() at time zone 'UTC')::date-1 where id=$1", [e.survey.id]);
    const interrupted = { query: async (sql, params) => {
      if (sql.includes('private.dw_barrier_touch')) throw new Error('Injected administrative failure');
      return db.query(sql, params);
    } };
    await assert.rejects(purgeExpiredSurveys(interrupted, { apply: true }), /Injected/u);
    assert.equal((await db.query('select status from research.surveys where id=$1', [e.survey.id])).rows[0].status, 'open');
    assert.equal((await db.query('select status from research.responses where survey_id=$1', [e.survey.id])).rows[0].status, 'submitted');
    await purgeExpiredSurveys(db, { apply: true });
  });
  it('rejects direct helper execution and checks all private/research tables use RLS with invoker public wrappers', async () => {
    const e = await setup();
    await permission(asUser(db, e.alice, (tx) => tx.query('select private.dw_barriers_json($1)', [e.sessionId])));
    await permission(asUser(db, e.alice, (tx) => tx.query('select private.dw_survey_own_json($1,$2)', [id(), token()])));
    const { rows } = await db.query(`select n.nspname,c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind='r' and (n.nspname='research' or (n.nspname='private' and c.relname in ('dw_barrier_state','dw_barriers','dw_barrier_votes','dw_barrier_evidence','dw_barrier_links','dw_solutions')))`);
    assert.equal(rows.length, 9); assert.ok(rows.every((r) => r.relrowsecurity));
    const f = await db.query(`select p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (p.proname like 'dw_barrier%' or p.proname like 'dw_survey%' or p.proname in ('dw_save_barrier','dw_save_barrier_link','dw_save_solution','dw_save_survey','dw_manage_survey'))`);
    assert.equal(f.rows.length, 17); assert.ok(f.rows.every((r) => !r.prosecdef && r.proconfig.some((c) => c.startsWith('search_path='))));
  });
});

describe('Cumulative migration from populated 0.3', () => {
  it('preserves profiles, sessions, grouped citations, open blinded rounds, ballots and old cursors', async () => {
    const prior = new PGlite();
    try {
      await prior.exec(await readFile(resolve(projectRoot, 'tests/database/bootstrap.sql'), 'utf8'));
      for (const migration of ['20261108131424_stage2_collaborative_sessions.sql','20261108172311_stage3_regions_families_voting.sql'])
        await prior.exec(await readFile(resolve(projectRoot, 'supabase/migrations', migration), 'utf8'));
      await seedCanonicalDocument(prior, doc); const e = await setup(prior);
      const publication = await rpc(e.alice, 'dw_publish_submission', { p_operation_id: id(), p_session_id: e.sessionId, p_local_key: bundle.practice.id, p_expected_revision: null, p_bundle: bundle }, prior);
      const submission = publication.submissions[0]; let w = await rpc(e.host, 'dw_workshop_snapshot', { p_session_id: e.sessionId }, prior);
      w = await rpc(e.host, 'dw_save_family', { p_operation_id: id(), p_session_id: e.sessionId, p_family_id: null, p_expected_board_revision: w.boardRevision,
        p_title: 'Доступность услуг для семьи', p_mechanism: 'Компенсация расходов семьи', p_rationale: 'Проверяем условия в исходном документе', p_submission_ids: [submission.id] }, prior);
      await patchSession(e, { phase: 'discussion' }, prior);
      const round = (await rpc(e.host, 'dw_open_voting_round', { p_operation_id: id(), p_session_id: e.sessionId, p_title: 'Замороженный первый раунд',
        p_results_visibility: 'after_close', p_expected_board_revision: w.boardRevision, p_settings: {} }, prior)).round;
      await rpc(e.alice, 'dw_cast_vote', { p_operation_id: id(), p_session_id: e.sessionId, p_round_id: round.id, p_family_id: round.families[0].id, p_value: 0, p_expected_revision: 0 }, prior);
      const old = await oldSnapshot(e, prior); const workshop = await rpc(e.alice, 'dw_workshop_snapshot', { p_session_id: e.sessionId }, prior);
      await prior.exec(await readFile(resolve(projectRoot, 'supabase/migrations/20261108220024_stage4_barriers_evidence_surveys.sql'), 'utf8'));
      assert.deepEqual(await oldSnapshot(e, prior), old);
      assert.deepEqual(await rpc(e.alice, 'dw_workshop_snapshot', { p_session_id: e.sessionId }, prior), workshop);
      const s = await rpc(e.alice, 'dw_barriers_snapshot', { p_session_id: e.sessionId }, prior);
      assert.equal(s.cursor, 0); assert.equal(s.families.length, 1); assert.equal(s.survey, null);
      await rpc(e.alice, 'dw_save_barrier', { p_operation_id: id(), p_session_id: e.sessionId, p_input: barrierInput() }, prior);
      assert.equal((await rpc(e.alice, 'dw_workshop_snapshot', { p_session_id: e.sessionId }, prior)).round.families[0].myVote, 0);
    } finally { await prior.close(); }
  });
});
