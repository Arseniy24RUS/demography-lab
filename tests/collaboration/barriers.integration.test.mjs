import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { FIXTURE_IDENTITIES, FIXTURE_PUBLISHABLE_KEY } from '../../scripts/test-collaboration-gateway.mjs';
import { successfulRpc as rpc, rejectedRpc as rejected } from './workshop-test-support.mjs';
import {
  SURVEY_ORIGIN, token, startBarrierHarness, named, barrierSnapshot, sessionSnapshot,
  workshopSnapshot, barrierInput, editBarrier, solutionInput, answerInput,
  saveResponseArgs, groupedClassroom, createSurvey, hostSurvey, researchExport, assertNoKeys,
} from './barriers-test-support.mjs';

let harness;
const anonymousPrivateKeys = new Set(['userId', 'authorId', 'profileId', 'email', 'responseSecret', 'invitationToken', 'responseId', 'rowKey']);
const collectivePrivateKeys = new Set(['answerBarrier', 'answerSupport', 'priorityChange', 'additionalConditions', 'responses', 'rowKey', 'consentResearch', 'consentQuote', 'responseSecret', 'invitationToken', 'invitationDigest']);

function linkedInput(barrier, family, overrides = {}) {
  return {
    linkId: null, expectedRevision: 0, barrierId: barrier.id, expectedBarrierRevision: barrier.revision,
    familyId: family.id, expectedFamilyFingerprint: family.fingerprint,
    relationship: 'needs_adaptation', explanation: 'Компенсация снижает расходы, однако сама по себе не расширяет часы работы.',
    prerequisites: 'Уточнить применимость к семьям со сменным графиком и полномочия муниципалитета.',
    status: 'active', ...overrides,
  };
}

async function changeSession(host, sessionId, patch) {
  const current = await sessionSnapshot(host, sessionId);
  return rpc(host, 'dw_update_session', {
    p_operation_id: randomUUID(), p_session_id: sessionId,
    p_expected_revision: current.session.revision, p_patch: patch,
  });
}

async function manageSurvey(host, sessionId, surveyId, action, extra = {}) {
  const current = await hostSurvey(host, sessionId, surveyId);
  return rpc(host, 'dw_manage_survey', named(sessionId, {
    surveyId, expectedRevision: current.survey.revision, action, ...extra,
  }));
}

describe('Stage 4: real Supabase SDK, credential-free public HTTP and PostgreSQL rules', { concurrency: false }, () => {
  before(async () => { harness = await startBarrierHarness(); });
  beforeEach(async () => { await harness.reset(); });
  after(async () => { await harness?.close(); });

  it('keeps lifecycle edits, role restrictions, idempotency and four discussion vote states distinct', async () => {
    const { host, alice, bob, observer, sessionId } = await harness.classroom({ includeBob: true, includeObserver: true });
    const input = barrierInput();
    const command = named(sessionId, input);
    let state = await rpc(alice, 'dw_save_barrier', command);
    const first = state.barriers[0];
    assert.equal(first.authorId, FIXTURE_IDENTITIES['participant-a@workshop.test'].id);
    assert.deepEqual(new Set(first.stageIds), new Set(['preschool', 'next_child']));
    assert.equal((await rpc(alice, 'dw_save_barrier', command)).barriers[0].revision, first.revision);
    await rejected(bob, 'dw_save_barrier', named(sessionId, editBarrier(first, { title: 'Чужая правка' })), /FORBIDDEN/);
    await rejected(observer, 'dw_save_barrier', named(sessionId, barrierInput()), /FORBIDDEN/);
    await rejected(alice, 'dw_save_barrier', named(sessionId, editBarrier(first, { priority: true })), /FORBIDDEN/);
    await rejected(alice, 'dw_save_barrier', named(sessionId, editBarrier(first, { stageIds: ['infancy'] })), /INVALID|STAGE/);
    state = await rpc(alice, 'dw_save_barrier', named(sessionId, editBarrier(first, {
      primaryStage: 'next_child', stageIds: ['next_child', 'preschool', 'early_childhood'],
    })));
    const moved = state.barriers[0];
    assert.equal(moved.primaryStage, 'next_child');
    assert.ok(moved.contentRevision > first.contentRevision);
    await rejected(alice, 'dw_save_barrier', named(sessionId, editBarrier(first, { title: 'Старая редакция' })), /REVISION_CONFLICT/);
    const vote = (sdk, value, expectedRevision) => rpc(sdk, 'dw_barrier_vote', named(sessionId, {
      barrierId: first.id, value, expectedRevision,
    }));
    state = await vote(alice, 0, 0);
    assert.equal(state.barriers[0].myVote, 0);
    assert.deepEqual(state.barriers[0].totals, { support: 0, oppose: 0, neutral: 1, cast: 1 });
    await vote(bob, -1, 0);
    await vote(host, 1, 0);
    state = await barrierSnapshot(alice, sessionId);
    assert.deepEqual(state.barriers[0].totals, { support: 1, oppose: 1, neutral: 1, cast: 3 });
    const ownRevision = state.barriers[0].myVoteRevision;
    await vote(alice, null, ownRevision);
    state = await barrierSnapshot(alice, sessionId);
    assert.equal(state.barriers[0].myVote, null);
    assert.deepEqual(state.barriers[0].totals, { support: 1, oppose: 1, neutral: 0, cast: 2 });
    await rejected(observer, 'dw_barrier_vote', named(sessionId, { barrierId: first.id, value: 1, expectedRevision: 0 }), /FORBIDDEN|NOT_ELIGIBLE/);
    assert.equal((await barrierSnapshot(observer, sessionId)).barriers[0].myVote, null);
    assertNoKeys(state, new Set(['ballots', 'voters', 'email']));
    assert.ok(state.cursor > first.revision);
  });

  it('freezes exact regional evidence, invalidates changed targets and retains every earlier evidence edition', async () => {
    const { host, alice, sessionId, familyId, mordovia, sakhalin } = await groupedClassroom(harness);
    let state = await rpc(alice, 'dw_save_barrier', named(sessionId, barrierInput()));
    let barrier = state.barriers[0];
    let family = state.families.find((item) => item.id === familyId);
    assert.ok(family);
    const command = named(sessionId, linkedInput(barrier, family));
    state = await rpc(alice, 'dw_save_barrier_link', command);
    let link = state.links[0];
    assert.deepEqual(link.staleReasons, []);
    const evidence = await rpc(alice, 'dw_barrier_evidence', { p_session_id: sessionId, p_evidence_id: link.evidenceId });
    assert.equal(evidence.fingerprint, family.fingerprint);
    assert.equal(evidence.variants.length, 2);
    assert.deepEqual(evidence.variants.find((item) => item.submissionId === mordovia.submission.id).bundle, mordovia.bundle);
    assert.deepEqual(evidence.variants.find((item) => item.submissionId === sakhalin.submission.id).bundle, sakhalin.bundle);
    assert.notEqual(evidence.variants[0].bundle.practice.amount, evidence.variants[1].bundle.practice.amount);
    assertNoKeys(state, new Set(['variants', 'occurrences', 'sources', 'quote', 'anchor']));
    assert.equal((await rpc(alice, 'dw_save_barrier_link', command)).links[0].revision, link.revision);
    state = await rpc(host, 'dw_save_barrier', named(sessionId, editBarrier(barrier, { priority: true })));
    assert.deepEqual(state.links[0].staleReasons, [], 'Prioritization alone must not invalidate source context');
    barrier = state.barriers[0];
    state = await rpc(alice, 'dw_save_barrier', named(sessionId, editBarrier(barrier, { description: `${barrier.description} Особое внимание — семьям с двумя детьми.` })));
    assert.ok(state.links[0].staleReasons.includes('barrier_changed'));
    barrier = state.barriers[0];
    await rejected(alice, 'dw_save_barrier_link', named(sessionId, { ...command.p_input, linkId: link.id, expectedRevision: link.revision }), /REVISION_CONFLICT|SOURCE_CHANGED|STALE|BARRIER/);
    state = await rpc(alice, 'dw_save_barrier_link', named(sessionId, linkedInput(barrier, family, { linkId: link.id, expectedRevision: link.revision })));
    link = state.links[0];
    assert.deepEqual(link.staleReasons, []);
    assert.equal(link.evidenceId, evidence.id, 'Unchanged family edition should reuse one frozen evidence object');
    const sourceState = await sessionSnapshot(alice, sessionId);
    const source = sourceState.submissions.find((item) => item.id === mordovia.submission.id);
    await rpc(alice, 'dw_publish_submission', {
      p_operation_id: randomUUID(), p_session_id: sessionId, p_local_key: source.localKey,
      p_expected_revision: source.revision, p_bundle: { ...mordovia.bundle, note: 'Дополнительное обоснование применимости после обсуждения.' },
    });
    state = await barrierSnapshot(alice, sessionId);
    assert.ok(state.links[0].staleReasons.includes('family_changed'));
    family = state.families.find((item) => item.id === familyId);
    assert.notEqual(family.fingerprint, evidence.fingerprint);
    state = await rpc(alice, 'dw_save_barrier_link', named(sessionId, linkedInput(barrier, family, { linkId: link.id, expectedRevision: link.revision })));
    link = state.links[0];
    assert.deepEqual(link.staleReasons, []);
    assert.notEqual(link.evidenceId, evidence.id);
    const nextEvidence = await rpc(alice, 'dw_barrier_evidence', { p_session_id: sessionId, p_evidence_id: link.evidenceId });
    assert.equal(nextEvidence.variants.find((item) => item.submissionId === mordovia.submission.id).bundle.note, 'Дополнительное обоснование применимости после обсуждения.');
    assert.deepEqual(await rpc(alice, 'dw_barrier_evidence', { p_session_id: sessionId, p_evidence_id: evidence.id }), evidence);
    let workshop = await workshopSnapshot(host, sessionId);
    const currentFamily = workshop.families.find((item) => item.id === familyId);
    await rpc(host, 'dw_save_family', {
      p_operation_id: randomUUID(), p_session_id: sessionId, p_family_id: familyId,
      p_expected_board_revision: workshop.boardRevision, p_title: `${currentFamily.title}: уточнённая группа`,
      p_mechanism: currentFamily.mechanism, p_rationale: currentFamily.rationale,
      p_submission_ids: currentFamily.submissionIds,
    });
    state = await barrierSnapshot(alice, sessionId);
    assert.ok(state.links[0].staleReasons.includes('family_changed'));
    workshop = await workshopSnapshot(host, sessionId);
    await rpc(host, 'dw_delete_family', {
      p_operation_id: randomUUID(), p_session_id: sessionId, p_family_id: familyId,
      p_expected_board_revision: workshop.boardRevision,
    });
    state = await barrierSnapshot(alice, sessionId);
    assert.ok(state.links[0].staleReasons.includes('family_missing'));
    assert.deepEqual(await rpc(alice, 'dw_barrier_evidence', { p_session_id: sessionId, p_evidence_id: evidence.id }), evidence);
  });

  it('bounds author solutions by membership, source session and optimistic revisions', async () => {
    const { host, alice, bob, observer, sessionId } = await harness.classroom({ includeBob: true, includeObserver: true });
    let state = await rpc(alice, 'dw_save_barrier', named(sessionId, barrierInput()));
    const barrier = state.barriers[0];
    const command = named(sessionId, solutionInput([barrier.id]));
    state = await rpc(alice, 'dw_save_solution', command);
    const solution = state.solutions[0];
    assert.equal(solution.authorId, FIXTURE_IDENTITIES['participant-a@workshop.test'].id);
    const edit = { ...command.p_input, solutionId: solution.id, expectedRevision: solution.revision, firstStep: 'Сначала согласовать два тестовых вечера и ответственного координатора.' };
    await rejected(bob, 'dw_save_solution', named(sessionId, edit), /FORBIDDEN/);
    await rejected(observer, 'dw_save_solution', named(sessionId, solutionInput([barrier.id])), /FORBIDDEN/);
    state = await rpc(host, 'dw_save_solution', named(sessionId, edit));
    assert.equal(state.solutions[0].firstStep, edit.firstStep);
    await rejected(alice, 'dw_save_solution', named(sessionId, { ...edit, title: 'Старый авторский черновик' }), /REVISION_CONFLICT/);
    const other = await rpc(host, 'dw_create_session', {
      p_operation_id: randomUUID(), p_title: 'Второе занятие для проверки изоляции', p_scope: 'federal', p_region_id: null,
    });
    await rejected(host, 'dw_save_solution', named(other.session.id, solutionInput([barrier.id])), /NOT_FOUND|INVALID_INPUT|FORBIDDEN/);
    await rejected(alice, 'dw_barriers_snapshot', { p_session_id: other.session.id }, /FORBIDDEN|NOT_FOUND/);
    const roster = await sessionSnapshot(host, sessionId);
    const member = roster.members.find((item) => item.userId === FIXTURE_IDENTITIES['participant-a@workshop.test'].id);
    await rpc(host, 'dw_revoke_member', {
      p_operation_id: randomUUID(), p_session_id: sessionId,
      p_member_id: member.userId, p_expected_revision: member.revision,
    });
    await rejected(alice, 'dw_save_solution', command, /FORBIDDEN|NOT_FOUND/);
    await rejected(alice, 'dw_barriers_cursor', { p_session_id: sessionId }, /FORBIDDEN|NOT_FOUND/);
  });

  it('serves a dedicated host-only projector DTO without named account identifiers or individual ballots', async () => {
    const { host, alice, sessionId } = await harness.classroom();
    let state = await rpc(alice, 'dw_save_barrier', named(sessionId, barrierInput()));
    await rpc(alice, 'dw_barrier_vote', named(sessionId, { barrierId: state.barriers[0].id, value: 1, expectedRevision: 0 }));
    await createSurvey(host, sessionId);
    await rejected(alice, 'dw_barriers_projector_snapshot', { p_session_id: sessionId }, /FORBIDDEN/);
    const projection = await rpc(host, 'dw_barriers_projector_snapshot', { p_session_id: sessionId });
    assert.equal(projection.barriers.length, 1);
    assert.equal(projection.barriers[0].authorName, null);
    assert.deepEqual(projection.barriers[0].totals, { support: 1, oppose: 0, neutral: 0, cast: 1 });
    assertNoKeys(projection, new Set([...collectivePrivateKeys, 'authorId', 'userId', 'email', 'members', 'myVote', 'myVoteRevision']));
    for (const identity of Object.values(FIXTURE_IDENTITIES)) assert.equal(JSON.stringify(projection).includes(identity.id), false);
    await changeSession(host, sessionId, { projectorShowAuthors: true });
    const namedProjection = await rpc(host, 'dw_barriers_projector_snapshot', { p_session_id: sessionId });
    assert.equal(namedProjection.barriers[0].authorName, 'Участница первой команды');
    assertNoKeys(namedProjection, new Set(['authorId', 'userId', 'email', 'myVote', 'myVoteRevision']));
  });

  it('uses a genuine anon SQL role, never downgrades bad bearer tokens and restricts CORS to two exact origins', async () => {
    const { host, sessionId } = await harness.classroom();
    const survey = await createSurvey(host, sessionId);
    const args = { p_survey_id: survey.surveyId, p_invitation_token: survey.invitationToken };
    const manifest = await harness.publicRpc('dw_survey_public_manifest', args);
    assert.equal(manifest.canRespond, true);
    assert.equal(manifest.questionnaireVersion, 'demography-open-1');
    assertNoKeys(manifest, new Set([...anonymousPrivateKeys, ...collectivePrivateKeys]));
    await rejected(host, 'dw_survey_public_manifest', args, /ANON|ANONYMOUS|FORBIDDEN|AUTH/);
    const invalidBearer = await harness.requestPublic('dw_survey_public_manifest', args, { Authorization: 'Bearer not-issued-by-fixture' });
    assert.equal(invalidBearer.response.status, 401);
    assert.equal(invalidBearer.data.code, 'bad_jwt');
    const noKey = await harness.requestPublic('dw_survey_public_manifest', args, { apikey: 'invalid' });
    assert.equal(noKey.response.status, 401);
    const namedWithoutAuth = await harness.requestPublic('dw_barriers_snapshot', { p_session_id: sessionId });
    assert.equal(namedWithoutAuth.response.status, 401);
    await harness.publicRejected('dw_survey_public_manifest', { ...args, p_invitation_token: token() }, /NOT_FOUND|FORBIDDEN|TOKEN|INVITATION/);
    await harness.publicRejected('dw_survey_public_manifest', { ...args, p_invitation_token: 'invalid' }, /INVALID|TOKEN|NOT_FOUND/);
    for (const origin of ['http://127.0.0.1:4175', 'https://attacker.example']) {
      const denied = await harness.requestPublic('dw_survey_public_manifest', args, { Origin: origin });
      assert.equal(denied.response.status, 403);
      assert.equal(denied.response.headers.has('access-control-allow-origin'), false);
    }
    const allowed = await harness.requestPublic('dw_survey_public_manifest', args);
    assert.equal(allowed.response.headers.get('access-control-allow-origin'), SURVEY_ORIGIN);
    const adminFromBrowser = await fetch(`${harness.gateway.url}/__test/otp`, {
      method: 'POST', headers: { apikey: FIXTURE_PUBLISHABLE_KEY, Origin: SURVEY_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'teacher@workshop.test' }),
    });
    assert.equal(adminFromBrowser.status, 403);
  });

  it('validates consent, respondent perspective and conditional questions without inferring missing answers', async () => {
    const { host, sessionId } = await harness.classroom();
    const { surveyId, invitationToken } = await createSurvey(host, sessionId);
    const secret = token();
    const save = (input) => saveResponseArgs(surveyId, invitationToken, secret, input);
    for (const input of [
      answerInput({ adultConfirmed: false }), answerInput({ consentEducational: false }),
      answerInput({ consentResearch: false, consentQuote: true }),
      answerInput({ perspective: 'adult_child_inferred' }),
      answerInput({ perspective: 'decline' }),
      answerInput({ conditionalChange: 'probably_change' }),
      answerInput({ questionVersion: 99 }),
    ]) await harness.publicRejected('dw_survey_save_response', save(input), /INVALID|CONSENT|VERSION|QUESTION|PERSPECTIVE|BRANCH/);
    const incomplete = answerInput();
    delete incomplete.answerSupport;
    await harness.publicRejected('dw_survey_save_response', save(incomplete), /INVALID|REQUIRED/);
    let own = await harness.publicRpc('dw_survey_save_response', save(answerInput({
      perspective: 'adult_child_reported', intention12m: null, intention36m: null,
      answerBarrier: 'Со слов взрослого ребёнка: нет доступного жилья.',
    })));
    assert.equal(own.perspective, 'adult_child_reported');
    assert.equal(own.intention12m, null);
    assert.equal(own.consentResearch, false);
    assertNoKeys(own, anonymousPrivateKeys);
    const conditionId = randomUUID();
    const conditionalInput = answerInput({
      expectedRevision: own.revision, priorityChange: 'Предсказуемый график вечернего присмотра',
      priorityConditionId: conditionId, conditionalChange: 'probably_change', horizon: '13_36m',
    });
    own = await harness.publicRpc('dw_survey_save_response', save(conditionalInput));
    await harness.publicRejected('dw_survey_save_response', save({
      ...conditionalInput, expectedRevision: own.revision, priorityChange: 'Совсем другое условие: улучшение жилищных условий',
    }), /INVALID|CONDITION/);
    own = await harness.publicRpc('dw_survey_save_response', save({
      ...conditionalInput, expectedRevision: own.revision,
      priorityChange: 'Улучшение жилищных условий', priorityConditionId: randomUUID(), conditionalChange: null,
    }));
    assert.equal(own.conditionalChange, null);
    assert.equal(own.priorityChange, 'Улучшение жилищных условий');
    await harness.publicRejected('dw_survey_save_response', save(answerInput()), /REVISION_CONFLICT/);
  });

  it('separates receipt secrets, preserves idempotent edits and makes withdrawal final after survey close', async () => {
    const { host, sessionId } = await harness.classroom();
    const { surveyId, invitationToken } = await createSurvey(host, sessionId);
    const secret = token();
    const original = saveResponseArgs(surveyId, invitationToken, secret, answerInput({ consentResearch: true }));
    let own = await harness.publicRpc('dw_survey_save_response', original);
    assert.equal(own.status, 'submitted');
    assert.equal((await harness.publicRpc('dw_survey_save_response', original)).revision, own.revision);
    const otherReceipt = await harness.publicRpc('dw_survey_own_response', { p_survey_id: surveyId, p_response_secret: token() });
    assert.equal(otherReceipt.status, 'none');
    assert.equal(otherReceipt.answerBarrier, null);
    const revisionInput = answerInput({ expectedRevision: own.revision, answerBarrier: 'Уточнённый ответ без исследовательского согласия.', consentResearch: false });
    own = await harness.publicRpc('dw_survey_save_response', saveResponseArgs(surveyId, invitationToken, secret, revisionInput));
    assert.equal(own.answerBarrier, revisionInput.answerBarrier);
    assert.equal((await researchExport(host, sessionId, surveyId)).records.length, 0);
    await manageSurvey(host, sessionId, surveyId, 'close');
    const closed = await harness.publicRpc('dw_survey_public_manifest', { p_survey_id: surveyId, p_invitation_token: invitationToken });
    assert.equal(closed.canRespond, false);
    assert.equal(closed.status, 'closed');
    await harness.publicRejected('dw_survey_save_response', saveResponseArgs(surveyId, invitationToken, token(), answerInput()), /CLOSED|NOT_OPEN|UNAVAILABLE/);
    const withdrawal = { p_operation_id: randomUUID(), p_survey_id: surveyId, p_response_secret: secret, p_expected_revision: own.revision };
    const withdrawn = await harness.publicRpc('dw_survey_withdraw_response', withdrawal);
    assert.equal(withdrawn.status, 'withdrawn');
    assert.equal(withdrawn.answerBarrier, null);
    assert.equal(withdrawn.answerSupport, null);
    assert.equal(withdrawn.consentResearch, false);
    assert.deepEqual(await harness.publicRpc('dw_survey_withdraw_response', withdrawal), withdrawn);
    const replay = await harness.requestPublic('dw_survey_save_response', original);
    assert.ok(!replay.response.ok || replay.data.status === 'withdrawn' || replay.data?.error,
      'An old successful-save operation must not replay the deleted text');
    const ownAfter = await harness.publicRpc('dw_survey_own_response', { p_survey_id: surveyId, p_response_secret: secret });
    assert.equal(ownAfter.status, 'withdrawn');
    assert.equal(ownAfter.answerBarrier, null);
    const privateState = await hostSurvey(host, sessionId, surveyId);
    assert.equal(privateState.responseCount, 0);
    assert.deepEqual(privateState.responses, []);
  });

  it('suppresses small collective counts, isolates raw host review and exports only current research permissions', async () => {
    const { host, alice, observer, sessionId } = await harness.classroom({ includeObserver: true });
    const { surveyId, invitationToken } = await createSurvey(host, sessionId);
    const invitationState = await rpc(host, 'dw_survey_invitation_state', { p_session_id: sessionId, p_survey_id: surveyId });
    assert.deepEqual(Object.keys(invitationState).sort(), ['invitationDigest', 'surveyId']);
    assert.equal(invitationState.surveyId, surveyId);
    assert.match(invitationState.invitationDigest, /^[0-9a-f]{64}$/);
    assert.notEqual(invitationState.invitationDigest, invitationToken);
    const anonymousInvitation = await harness.requestPublic('dw_survey_invitation_state', { p_session_id: sessionId, p_survey_id: surveyId });
    assert.equal(anonymousInvitation.response.status, 401);
    const submitted = [];
    for (let index = 0; index < 5; index++) {
      const secret = token();
      const input = answerInput({
        answerBarrier: `Отдельный открытый ответ ${index + 1}: условия доступа к помощи.`,
        consentResearch: index < 3, consentQuote: index === 0,
      });
      const own = await harness.publicRpc('dw_survey_save_response', saveResponseArgs(surveyId, invitationToken, secret, input));
      submitted.push({ secret, input, own });
      const collective = await barrierSnapshot(alice, sessionId);
      assert.equal(collective.survey.responseCount, index < 4 ? null : 5);
      assertNoKeys(collective, collectivePrivateKeys);
      assert.equal(collective.barriers.length, 0, 'Private raw survey answers must not be pushed into the named public board');
      assert.equal(JSON.stringify(collective).includes(input.answerBarrier), false);
    }
    const privateState = await hostSurvey(host, sessionId, surveyId);
    assert.equal(privateState.responseCount, 5);
    assert.equal(privateState.researchCount, 3);
    assert.equal(privateState.quoteCount, 1);
    assert.equal(privateState.responses.length, 5);
    assertNoKeys(privateState.responses, new Set(['userId', 'profileId', 'email', 'responseSecret', 'secretHash']));
    for (const sdk of [alice, observer]) {
      await rejected(sdk, 'dw_survey_invitation_state', { p_session_id: sessionId, p_survey_id: surveyId }, /FORBIDDEN/);
      await rejected(sdk, 'dw_survey_host_state', { p_session_id: sessionId, p_survey_id: surveyId }, /FORBIDDEN/);
      await rejected(sdk, 'dw_survey_research_export', { p_session_id: sessionId, p_survey_id: surveyId }, /FORBIDDEN/);
    }
    const exported = await researchExport(host, sessionId, surveyId);
    assert.equal(exported.records.length, 3);
    assert.equal(exported.records.filter((item) => item.consentQuote).length, 1);
    assert.match(exported.samplingNote, /выборк|участник|represent|uniquen|open.link/iu);
    assertNoKeys(exported.records, new Set(['rowKey', 'responseId', 'userId', 'profileId', 'email', 'priorityConditionId', 'responseSecret']));
    assert.equal(exported.records.some((item) => item.answerBarrier.includes('ответ 4')), false);
    const first = submitted[0];
    await harness.publicRpc('dw_survey_save_response', saveResponseArgs(surveyId, invitationToken, first.secret, {
      ...first.input, expectedRevision: first.own.revision, consentResearch: false, consentQuote: false,
    }));
    const afterConsent = await researchExport(host, sessionId, surveyId);
    assert.equal(afterConsent.records.length, 2);
    assert.equal(afterConsent.records.filter((item) => item.consentQuote).length, 0);
    const second = submitted[1];
    await harness.publicRpc('dw_survey_withdraw_response', {
      p_operation_id: randomUUID(), p_survey_id: surveyId, p_response_secret: second.secret, p_expected_revision: second.own.revision,
    });
    assert.equal((await barrierSnapshot(alice, sessionId)).survey.responseCount, null);
    assert.equal((await researchExport(host, sessionId, surveyId)).records.length, 1);
    const projector = await rpc(host, 'dw_barriers_projector_snapshot', { p_session_id: sessionId });
    assertNoKeys(projector, collectivePrivateKeys);
    assert.equal(JSON.stringify(projector).includes('Отдельный открытый ответ'), false);
    const other = await rpc(host, 'dw_create_session', {
      p_operation_id: randomUUID(), p_title: 'Проверка изоляции метаданных приглашения', p_scope: 'federal', p_region_id: null,
    });
    await rejected(host, 'dw_survey_invitation_state', { p_session_id: other.session.id, p_survey_id: surveyId }, /NOT_FOUND|FORBIDDEN/);
  });

  it('rotates the shared invitation independently of respondent receipts and prevents survey reconfiguration after opening', async () => {
    const { host, alice, sessionId } = await harness.classroom();
    const { surveyId, invitationToken } = await createSurvey(host, sessionId);
    const secret = token();
    let own = await harness.publicRpc('dw_survey_save_response', saveResponseArgs(surveyId, invitationToken, secret, answerInput()));
    const replacement = token();
    await manageSurvey(host, sessionId, surveyId, 'rotate', { invitationToken: replacement });
    await harness.publicRejected('dw_survey_public_manifest', { p_survey_id: surveyId, p_invitation_token: invitationToken }, /NOT_FOUND|FORBIDDEN|TOKEN|INVITATION/);
    assert.equal((await harness.publicRpc('dw_survey_public_manifest', { p_survey_id: surveyId, p_invitation_token: replacement })).canRespond, true);
    assert.equal((await harness.publicRpc('dw_survey_own_response', { p_survey_id: surveyId, p_response_secret: secret })).answerBarrier, own.answerBarrier);
    const current = await hostSurvey(host, sessionId, surveyId);
    await rejected(host, 'dw_save_survey', named(sessionId, {
      surveyId, expectedRevision: current.survey.revision, title: 'Подмена цели после ответов', purpose: 'Попытка заменить исходную цель после открытия приёма ответов.',
      organizerContact: current.survey.organizerContact, retentionUntil: current.survey.retentionUntil,
      questionBarrier: 'Уточнённый вопрос о препятствиях', questionSupport: 'Другой вопрос об условиях',
    }), /FROZEN|OPEN|DRAFT|CLOSED|IMMUTABLE/);
    await rejected(alice, 'dw_manage_survey', named(sessionId, { surveyId, expectedRevision: current.survey.revision, action: 'close' }), /FORBIDDEN/);
    own = await harness.publicRpc('dw_survey_withdraw_response', {
      p_operation_id: randomUUID(), p_survey_id: surveyId, p_response_secret: secret, p_expected_revision: own.revision,
    });
    assert.equal(own.status, 'withdrawn');
    assert.equal((await hostSurvey(host, sessionId, surveyId)).responseCount, 0);
  });

  it('purges raw content without resurrecting old save receipts and allows withdrawal after purge', async () => {
    const { host, sessionId } = await harness.classroom();
    const { surveyId, invitationToken } = await createSurvey(host, sessionId);
    const secret = token();
    const original = saveResponseArgs(surveyId, invitationToken, secret, answerInput({ consentResearch: true, consentQuote: true }));
    const saved = await harness.publicRpc('dw_survey_save_response', original);
    await manageSurvey(host, sessionId, surveyId, 'purge');
    const own = await harness.publicRpc('dw_survey_own_response', { p_survey_id: surveyId, p_response_secret: secret });
    assert.equal(own.availability, 'purged');
    assert.equal(own.answerBarrier, null);
    assert.equal(own.answerSupport, null);
    await harness.publicRejected('dw_survey_save_response', saveResponseArgs(surveyId, invitationToken, token(), answerInput()), /PURGED|CLOSED|UNAVAILABLE|NOT_OPEN|NOT_FOUND/);
    const replay = await harness.requestPublic('dw_survey_save_response', original);
    assert.equal(JSON.stringify(replay.data).includes(original.p_input.answerBarrier), false);
    const privateState = await hostSurvey(host, sessionId, surveyId);
    assert.equal(privateState.responseCount, 0);
    assert.deepEqual(privateState.responses, []);
    await rejected(host, 'dw_survey_research_export', { p_session_id: sessionId, p_survey_id: surveyId }, /SURVEY_PURGED/);
    const withdrawn = await harness.publicRpc('dw_survey_withdraw_response', {
      p_operation_id: randomUUID(), p_survey_id: surveyId, p_response_secret: secret, p_expected_revision: own.revision ?? saved.revision,
    });
    assert.equal(withdrawn.status, 'withdrawn');
    assert.equal(withdrawn.answerBarrier, null);
  });

  it('blocks a form when its teaching session is closed while leaving existing receipt withdrawal available', async () => {
    const { host, sessionId } = await harness.classroom();
    const { surveyId, invitationToken } = await createSurvey(host, sessionId);
    const secret = token();
    const own = await harness.publicRpc('dw_survey_save_response', saveResponseArgs(surveyId, invitationToken, secret, answerInput()));
    await changeSession(host, sessionId, { status: 'closed' });
    const manifest = await harness.publicRpc('dw_survey_public_manifest', { p_survey_id: surveyId, p_invitation_token: invitationToken });
    assert.equal(manifest.canRespond, false);
    await harness.publicRejected('dw_survey_save_response', saveResponseArgs(surveyId, invitationToken, token(), answerInput()), /ARCHIVED|CLOSED|UNAVAILABLE|NOT_OPEN/);
    const withdrawn = await harness.publicRpc('dw_survey_withdraw_response', {
      p_operation_id: randomUUID(), p_survey_id: surveyId, p_response_secret: secret, p_expected_revision: own.revision,
    });
    assert.equal(withdrawn.status, 'withdrawn');
    await rejected(host, 'dw_save_barrier', named(sessionId, barrierInput()), /SESSION_NOT_OPEN|ARCHIVED|CLOSED|READ_ONLY/);
  });
});
