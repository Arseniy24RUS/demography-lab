import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { FIXTURE_IDENTITIES } from '../../scripts/test-collaboration-gateway.mjs';
import {
  startWorkshopHarness, successfulRpc as rpc, rejectedRpc as rejected,
  publishPrepared, realPracticeBundle,
} from './workshop-test-support.mjs';

const MORDOVIA = 'respublika-mordoviia';
const SAKHALIN = 'sakhalinskaia-oblast';
let harness;

const snapshot = (sdk, sessionId) => rpc(sdk, 'dw_workshop_snapshot', { p_session_id: sessionId });
const currentSession = (sdk, sessionId) => rpc(sdk, 'dw_session_snapshot', { p_session_id: sessionId });
const currentRound = (sdk, sessionId, roundId) => rpc(sdk, 'dw_workshop_round_snapshot', {
  p_session_id: sessionId, p_round_id: roundId,
});
function regionArgs(sessionId, regionId, action, revision, note = '') {
  return {
    p_operation_id: randomUUID(), p_session_id: sessionId, p_region_id: regionId,
    p_action: action, p_expected_revision: revision, p_note: note,
  };
}
function familyArgs(sessionId, boardRevision, ids, overrides = {}) {
  return {
    p_operation_id: randomUUID(), p_session_id: sessionId, p_family_id: null,
    p_expected_board_revision: boardRevision, p_title: 'Компенсация платы за детский сад',
    p_mechanism: 'Возмещение части родительской платы при сохранении региональных условий.',
    p_rationale: 'Общий механизм компенсации; размеры и получатели рассматриваются отдельно.',
    p_submission_ids: ids, ...overrides,
  };
}
async function phase(host, sessionId, nextPhase, status) {
  const state = await currentSession(host, sessionId);
  return rpc(host, 'dw_update_session', {
    p_operation_id: randomUUID(), p_session_id: sessionId,
    p_expected_revision: state.session.revision,
    p_patch: { ...(nextPhase ? { phase: nextPhase } : {}), ...(status ? { status } : {}) },
  });
}
async function groupedClassroom(options = {}) {
  const classroom = await harness.classroom({ includeBob: true, ...options });
  const { host, alice, bob, sessionId } = classroom;
  const mordovia = await publishPrepared(alice, sessionId, 'mordovia-kindergarten-compensation');
  const sakhalin = await publishPrepared(bob, sessionId, 'sakhalin-kindergarten-compensation');
  let state = await snapshot(host, sessionId);
  assert.equal(state.families.length, 0, 'Publication must not automatically merge by a catalogue family or title');
  state = await rpc(host, 'dw_save_family', familyArgs(sessionId, state.boardRevision,
    [mordovia.submission.id, sakhalin.submission.id]));
  return { ...classroom, mordovia, sakhalin, familyId: state.families[0].id, state };
}
async function openRound(host, sessionId, { visibility = 'after_close', settings, title = 'Приоритеты адаптации' } = {}) {
  await phase(host, sessionId, 'discussion');
  const state = await snapshot(host, sessionId);
  return rpc(host, 'dw_open_voting_round', {
    p_operation_id: randomUUID(), p_session_id: sessionId,
    p_title: title, p_results_visibility: visibility, p_expected_board_revision: state.boardRevision,
    ...(settings ? { p_settings: settings } : {}),
  });
}
/** First-round blinding is mandatory; live-mode cases explicitly start a later round. */
async function openVisibleRound(host, sessionId, options = {}) {
  const initial = await snapshot(host, sessionId);
  if (initial.rounds.length === 0) {
    const first = await openRound(host, sessionId, { visibility: 'after_close', title: 'Первичный закрытый отбор' });
    assert.equal(first.round.resultsVisibility, 'after_close');
    assert.equal(first.round.totalsVisible, false);
    await closeRound(host, sessionId, first.round);
  }
  return openRound(host, sessionId, { ...options, visibility: 'live' });
}
function ballot(sessionId, roundId, familyId, value, expectedRevision, operationId = randomUUID()) {
  return {
    p_operation_id: operationId, p_session_id: sessionId, p_round_id: roundId,
    p_family_id: familyId, p_value: value, p_expected_revision: expectedRevision,
  };
}
async function closeRound(host, sessionId, round) {
  return rpc(host, 'dw_close_voting_round', {
    p_operation_id: randomUUID(), p_session_id: sessionId, p_round_id: round.id,
    p_expected_revision: round.revision,
  });
}
function noPrivateProjectionFields(value) {
  const forbidden = new Set(['ownerId', 'ownerName', 'authorId', 'authorName', 'userId', 'email', 'members', 'myVote', 'myVoteRevision', 'localKey', 'orderSeed']);
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbidden.has(key), `Projector leaked private field ${key}`);
      noPrivateProjectionFields(child);
    }
  }
}

describe('Stage 3: actual Supabase SDK, HTTP gateway and shipped PostgreSQL rules', { concurrency: false }, () => {
  before(async () => { harness = await startWorkshopHarness(); });
  beforeEach(async () => { await harness.reset(); });
  after(async () => { await harness?.close(); });

  it('resolves competing region claims once and requires an explicit completion explanation without findings', async () => {
    const { host, alice, bob, sessionId } = await harness.classroom({ includeBob: true });
    const attempts = [regionArgs(sessionId, MORDOVIA, 'claim', 0), regionArgs(sessionId, MORDOVIA, 'claim', 0)];
    const clients = [alice, bob];
    const results = await Promise.all(clients.map((sdk, index) => sdk.rpc('dw_region_work', attempts[index])));
    const successes = results.map((result, index) => ({ result, index })).filter(({ result }) => !result.error && !result.data?.error);
    assert.equal(successes.length, 1);
    const winnerIndex = successes[0].index;
    const loserIndex = 1 - winnerIndex;
    assert.match(results[loserIndex].error?.message ?? results[loserIndex].data?.error?.code, /REGION_TAKEN|REVISION_CONFLICT/);
    const claimed = successes[0].result.data.regionWork.find((item) => item.regionId === MORDOVIA);
    assert.equal(claimed.status, 'in_progress');
    const replay = await rpc(clients[winnerIndex], 'dw_region_work', attempts[winnerIndex]);
    assert.equal(replay.cursor, successes[0].result.data.cursor);
    assert.equal(replay.regionWork.find((item) => item.regionId === MORDOVIA).revision, claimed.revision);
    await rejected(clients[loserIndex], 'dw_region_work', regionArgs(sessionId, MORDOVIA, 'complete', claimed.revision, 'Другой участник пытается завершить отбор.'), /FORBIDDEN/);
    await rejected(clients[winnerIndex], 'dw_region_work', regionArgs(sessionId, MORDOVIA, 'complete', claimed.revision), /COMPLETION_NOTE_REQUIRED/);
    let state = await rpc(clients[winnerIndex], 'dw_region_work', regionArgs(sessionId, MORDOVIA, 'complete', claimed.revision,
      'В исследованном разделе подходящих практик не выделено.'));
    let work = state.regionWork.find((item) => item.regionId === MORDOVIA);
    assert.equal(work.status, 'completed');
    assert.match(work.completionNote, /не выделено/);
    state = await rpc(host, 'dw_region_work', regionArgs(sessionId, MORDOVIA, 'reopen', work.revision));
    work = state.regionWork.find((item) => item.regionId === MORDOVIA);
    assert.equal(work.status, 'in_progress');
    state = await rpc(host, 'dw_region_work', regionArgs(sessionId, MORDOVIA, 'release', work.revision));
    work = state.regionWork.find((item) => item.regionId === MORDOVIA);
    assert.equal(work.status, 'available');
    assert.equal(work.ownerId, null);
    await rejected(alice, 'dw_region_work', regionArgs(sessionId, 'unavailable-region-fixture', 'claim', 0), /REGION_UNAVAILABLE/);
  });

  it('groups and moves source-backed regional variants without changing their conditions or citations', async () => {
    const { host, alice, bob, observer, sessionId } = await harness.classroom({ includeBob: true, includeObserver: true });
    const mordovia = await publishPrepared(alice, sessionId, 'mordovia-kindergarten-compensation');
    const sakhalin = await publishPrepared(bob, sessionId, 'sakhalin-kindergarten-compensation');
    assert.notEqual(mordovia.bundle.practice.amount, sakhalin.bundle.practice.amount);
    let state = await rpc(alice, 'dw_region_work', regionArgs(sessionId, MORDOVIA, 'claim', 0));
    const allocation = state.regionWork.find((item) => item.regionId === MORDOVIA);
    state = await rpc(alice, 'dw_region_work', regionArgs(sessionId, MORDOVIA, 'complete', allocation.revision));
    assert.equal(state.regionWork.find((item) => item.regionId === MORDOVIA).status, 'completed');
    const before = await currentSession(host, sessionId);
    const firstArgs = familyArgs(sessionId, state.boardRevision, [mordovia.submission.id, sakhalin.submission.id]);
    await rejected(alice, 'dw_save_family', firstArgs, /FORBIDDEN/);
    await rejected(observer, 'dw_region_work', regionArgs(sessionId, SAKHALIN, 'claim', 0), /FORBIDDEN/);
    state = await rpc(host, 'dw_save_family', firstArgs);
    const firstId = state.families[0].id;
    assert.deepEqual(new Set(state.families[0].submissionIds), new Set([mordovia.submission.id, sakhalin.submission.id]));
    assert.deepEqual((await currentSession(host, sessionId)).submissions, before.submissions);
    state = await rpc(host, 'dw_save_family', familyArgs(sessionId, state.boardRevision, [sakhalin.submission.id], {
      p_title: 'Отдельное рассмотрение сахалинского варианта',
      p_rationale: 'Дополнительные условия требуют отдельного обсуждения.',
    }));
    assert.deepEqual(state.families.find((item) => item.id === firstId).submissionIds, [mordovia.submission.id]);
    const second = state.families.find((item) => item.id !== firstId);
    assert.deepEqual(second.submissionIds, [sakhalin.submission.id]);
    assert.equal(new Set(state.families.flatMap((item) => item.submissionIds)).size, 2);
    assert.deepEqual((await currentSession(host, sessionId)).submissions, before.submissions);
    state = await rpc(host, 'dw_delete_family', {
      p_operation_id: randomUUID(), p_session_id: sessionId, p_family_id: second.id,
      p_expected_board_revision: state.boardRevision,
    });
    assert.equal(state.families.length, 1);
    assert.equal((await currentSession(host, sessionId)).submissions.length, 2);
    assert.equal((await snapshot(observer, sessionId)).families.length, 1);
  });

  it('rejects stale curation and cross-session records while workshop-only changes leave the source-board cursor unchanged', async () => {
    const { host, alice, sessionId, familyId, state, mordovia } = await groupedClassroom();
    const stageTwoCursor = await rpc(host, 'dw_session_cursor', { p_session_id: sessionId });
    const args = familyArgs(sessionId, state.boardRevision, [mordovia.submission.id], { p_family_id: familyId, p_title: 'Уточнённое семейство' });
    const next = await rpc(host, 'dw_save_family', args);
    assert.ok(next.cursor > state.cursor);
    assert.equal(await rpc(host, 'dw_session_cursor', { p_session_id: sessionId }), stageTwoCursor);
    await rejected(host, 'dw_save_family', { ...args, p_operation_id: randomUUID(), p_title: 'Устаревший черновик' }, /REVISION_CONFLICT/);
    const other = await rpc(host, 'dw_create_session', {
      p_operation_id: randomUUID(), p_title: 'Изолированное второе занятие', p_scope: 'federal', p_region_id: null,
    });
    const otherState = await snapshot(host, other.session.id);
    await rejected(host, 'dw_save_family', familyArgs(other.session.id, otherState.boardRevision, [mordovia.submission.id]), /NOT_FOUND|INVALID_INPUT|SOURCE_MISMATCH|FORBIDDEN/);
    await rejected(alice, 'dw_workshop_snapshot', { p_session_id: other.session.id }, /FORBIDDEN|NOT_FOUND/);
    await rejected(alice, 'dw_workshop_cursor', { p_session_id: other.session.id }, /FORBIDDEN|NOT_FOUND/);
  });

  it('keeps first-round totals hidden, distinguishes abstention from missing answers, and exposes no individual ballots', async () => {
    const { host, alice, bob, observer, sessionId, familyId } = await groupedClassroom({ includeObserver: true });
    let state = await openRound(host, sessionId);
    const roundId = state.round.id;
    assert.equal(state.round.eligibleCount, 3);
    assert.equal(state.round.totalsVisible, false);
    assert.equal(state.round.families[0].totals, null);
    state = await rpc(alice, 'dw_cast_vote', ballot(sessionId, roundId, familyId, 0, 0));
    assert.equal(state.round.families.find((item) => item.id === familyId).myVote, 0);
    state = await rpc(host, 'dw_cast_vote', ballot(sessionId, roundId, familyId, 1, 0));
    assert.equal(state.round.participatingCount, 2);
    for (const sdk of [host, alice, bob, observer]) {
      const current = await snapshot(sdk, sessionId);
      assert.equal(current.round.families[0].totals, null);
      assert.equal(current.round.totalsVisible, false);
      assert.equal(JSON.stringify(current).includes('teacher@workshop.test'), false);
      const identities = current.round.families.map((family) => family.id);
      assert.deepEqual((await snapshot(sdk, sessionId)).round.families.map((family) => family.id), identities);
    }
    await rejected(observer, 'dw_cast_vote', ballot(sessionId, roundId, familyId, 1, 0), /FORBIDDEN|NOT_ELIGIBLE/);
    await rejected(alice, 'dw_workshop_projector_snapshot', { p_session_id: sessionId }, /FORBIDDEN/);
    const projection = await rpc(host, 'dw_workshop_projector_snapshot', { p_session_id: sessionId });
    noPrivateProjectionFields(projection);
    assert.equal(projection.round.families[0].totals, null);
    const projectionText = JSON.stringify(projection);
    for (const user of Object.values(FIXTURE_IDENTITIES)) assert.equal(projectionText.includes(user.id), false);
    state = await closeRound(host, sessionId, state.round);
    const totals = state.round.families.find((item) => item.id === familyId).totals;
    assert.equal(state.round.totalsVisible, true);
    assert.deepEqual({ support: totals.support, oppose: totals.oppose, neutral: totals.neutral, cast: totals.cast, unanswered: totals.unanswered, score: totals.score },
      { support: 1, oppose: 0, neutral: 1, cast: 2, unanswered: 1, score: 1 });
    const aliceRound = await currentRound(alice, sessionId, roundId);
    const bobRound = await currentRound(bob, sessionId, roundId);
    assert.equal(aliceRound.families.find((item) => item.id === familyId).myVote, 0);
    assert.equal(bobRound.families.find((item) => item.id === familyId).myVote, null);
  });

  it('accepts 100 retries as one ballot and enforces revisioned changes and withdrawal', async () => {
    const { host, alice, sessionId, familyId } = await groupedClassroom();
    const opened = await openVisibleRound(host, sessionId);
    const request = ballot(sessionId, opened.round.id, familyId, 1, 0);
    const first = await rpc(alice, 'dw_cast_vote', request);
    const retried = await Promise.all(Array.from({ length: 100 }, () => rpc(alice, 'dw_cast_vote', request)));
    for (const state of retried) {
      const family = state.round.families.find((item) => item.id === familyId);
      assert.equal(state.cursor, first.cursor);
      assert.equal(family.myVoteRevision, 1);
      assert.equal(family.totals.support, 1);
      assert.equal(family.totals.cast, 1);
    }
    await rejected(alice, 'dw_cast_vote', { ...request, p_value: -1 }, /IDEMPOTENCY_CONFLICT/);
    await rejected(alice, 'dw_cast_vote', { ...request, p_operation_id: randomUUID(), p_value: -1 }, /REVISION_CONFLICT/);
    let state = await rpc(alice, 'dw_cast_vote', ballot(sessionId, opened.round.id, familyId, -1, 1));
    let family = state.round.families.find((item) => item.id === familyId);
    assert.equal(family.totals.support, 0);
    assert.equal(family.totals.oppose, 1);
    assert.equal(family.totals.score, -1);
    state = await rpc(alice, 'dw_cast_vote', ballot(sessionId, opened.round.id, familyId, null, family.myVoteRevision));
    family = state.round.families.find((item) => item.id === familyId);
    assert.equal(family.myVote, null);
    assert.equal(family.myVoteRevision, 3);
    assert.equal(family.totals.cast, 0);
    assert.equal(family.totals.unanswered, 3);
  });

  it('freezes source bundles during voting and retains old results after editing and opening a fresh round', async () => {
    const { host, alice, sessionId, familyId, mordovia, sakhalin } = await groupedClassroom();
    let state = await openVisibleRound(host, sessionId);
    const roundId = state.round.id;
    const frozen = structuredClone(state.round.families.find((item) => item.id === familyId).variants);
    assert.equal(frozen.length, 2);
    assert.deepEqual(frozen.find((item) => item.submissionId === mordovia.submission.id).bundle, mordovia.submission.bundle);
    state = await rpc(alice, 'dw_cast_vote', ballot(sessionId, roundId, familyId, 1, 0));
    await phase(host, sessionId, 'review');
    const changedBundle = await realPracticeBundle('mordovia-kindergarten-compensation', 'Изменённый комментарий после проверки.');
    const publication = {
      p_operation_id: randomUUID(), p_session_id: sessionId, p_local_key: 'prepared-mordovia-kindergarten-compensation',
      p_expected_revision: mordovia.submission.revision, p_bundle: changedBundle,
    };
    await rejected(alice, 'dw_publish_submission', publication, /ROUND_OPEN/);
    await rejected(host, 'dw_moderate_submission', {
      p_operation_id: randomUUID(), p_session_id: sessionId, p_submission_id: mordovia.submission.id,
      p_expected_revision: mordovia.submission.revision, p_status: 'withdrawn',
    }, /ROUND_OPEN/);
    state = await snapshot(host, sessionId);
    await rejected(host, 'dw_save_family', familyArgs(sessionId, state.boardRevision, [mordovia.submission.id], { p_family_id: familyId }), /ROUND_OPEN/);
    await phase(host, sessionId, 'discussion');
    state = await closeRound(host, sessionId, state.round);
    await rejected(alice, 'dw_cast_vote', ballot(sessionId, roundId, familyId, -1, 1), /ROUND_CLOSED/);
    await phase(host, sessionId, 'review');
    await rpc(alice, 'dw_publish_submission', { ...publication, p_operation_id: randomUUID() });
    state = await snapshot(host, sessionId);
    state = await rpc(host, 'dw_save_family', familyArgs(sessionId, state.boardRevision, [mordovia.submission.id, sakhalin.submission.id], {
      p_family_id: familyId, p_title: 'Уточнённая версия общего механизма',
    }));
    const historical = await currentRound(alice, sessionId, roundId);
    assert.deepEqual(historical.families.find((item) => item.id === familyId).variants, frozen);
    assert.equal(historical.families.find((item) => item.id === familyId).myVote, 1);
    state = await openVisibleRound(host, sessionId, { title: 'Повторная оценка уточнённого решения' });
    assert.notEqual(state.round.id, roundId);
    const newRound = await currentRound(alice, sessionId, state.round.id);
    const newFamily = newRound.families.find((item) => item.id === familyId);
    assert.equal(newFamily.title, 'Уточнённая версия общего механизма');
    assert.equal(newFamily.myVote, null);
    assert.equal(newFamily.myVoteRevision, 0);
    assert.equal(newFamily.totals.cast, 0);
    assert.equal(newFamily.variants.find((item) => item.submissionId === mordovia.submission.id).bundle.note, changedBundle.note);
    assert.equal((await currentRound(host, sessionId, roundId)).families[0].totals.support, 1);
  });

  it('guards pauses, late joins and revocation without rewriting the captured roster or earlier ballots', async () => {
    const { host, alice, bob, sessionId, familyId } = await groupedClassroom();
    let state = await openVisibleRound(host, sessionId);
    const roundId = state.round.id;
    const late = await harness.signIn('observer@workshop.test', 'Позднее присоединение');
    const invitation = await rpc(host, 'dw_invitation', { p_session_id: sessionId });
    await rpc(late, 'dw_join_session', { p_operation_id: randomUUID(), p_code: invitation.code });
    assert.equal((await snapshot(late, sessionId)).round.canVote, false);
    await rejected(late, 'dw_cast_vote', ballot(sessionId, roundId, familyId, 1, 0), /NOT_ELIGIBLE/);
    state = await rpc(alice, 'dw_cast_vote', ballot(sessionId, roundId, familyId, 1, 0));
    await phase(host, sessionId, undefined, 'paused');
    await rejected(bob, 'dw_cast_vote', ballot(sessionId, roundId, familyId, -1, 0), /SESSION_NOT_OPEN/);
    await phase(host, sessionId, undefined, 'open');
    state = await rpc(bob, 'dw_cast_vote', ballot(sessionId, roundId, familyId, 0, 0));
    let session = await currentSession(host, sessionId);
    const aliceMember = session.members.find((member) => member.userId === FIXTURE_IDENTITIES['participant-a@workshop.test'].id);
    await rpc(host, 'dw_revoke_member', {
      p_operation_id: randomUUID(), p_session_id: sessionId, p_member_id: aliceMember.userId,
      p_expected_revision: aliceMember.revision,
    });
    await rejected(alice, 'dw_workshop_snapshot', { p_session_id: sessionId }, /FORBIDDEN|NOT_FOUND/);
    await rejected(alice, 'dw_workshop_cursor', { p_session_id: sessionId }, /FORBIDDEN|NOT_FOUND/);
    await rejected(alice, 'dw_workshop_round_snapshot', { p_session_id: sessionId, p_round_id: roundId }, /FORBIDDEN|NOT_FOUND/);
    await rejected(alice, 'dw_cast_vote', ballot(sessionId, roundId, familyId, -1, 1), /FORBIDDEN|NOT_FOUND/);
    session = await currentSession(host, sessionId);
    const bobMember = session.members.find((member) => member.userId === FIXTURE_IDENTITIES['participant-b@workshop.test'].id);
    await rpc(host, 'dw_set_member_role', {
      p_operation_id: randomUUID(), p_session_id: sessionId, p_member_id: bobMember.userId,
      p_expected_revision: bobMember.revision, p_role: 'observer',
    });
    await rejected(bob, 'dw_cast_vote', ballot(sessionId, roundId, familyId, -1, 1), /FORBIDDEN|NOT_ELIGIBLE/);
    state = await snapshot(host, sessionId);
    assert.equal(state.round.eligibleCount, 3);
    assert.equal(state.round.families[0].totals.support, 1);
    assert.equal(state.round.families[0].totals.neutral, 1);
    assert.equal(state.round.families[0].totals.unanswered, 1);
    const projection = await rpc(host, 'dw_workshop_projector_snapshot', { p_session_id: sessionId });
    noPrivateProjectionFields(projection);
  });

  it('captures ranking thresholds and distinguishes balanced substantive votes from all-neutral answers', async () => {
    const { host, alice, bob, sessionId, familyId } = await groupedClassroom();
    const mortgage = await publishPrepared(alice, sessionId, 'mordovia-mortgage-repayment');
    let state = await snapshot(host, sessionId);
    state = await rpc(host, 'dw_save_family', familyArgs(sessionId, state.boardRevision, [mortgage.submission.id], {
      p_title: 'Снижение ипотечной нагрузки при рождении ребёнка',
      p_mechanism: 'Возмещение части ипотечного долга при наступлении условий программы.',
      p_rationale: 'Самостоятельный жилищный механизм с отдельными условиями.',
    }));
    const otherFamilyId = state.families.find((item) => item.id !== familyId).id;
    await phase(host, sessionId, 'discussion');
    const roundArgs = {
      p_operation_id: randomUUID(), p_session_id: sessionId,
      p_title: 'Приоритеты адаптации в Мордовии', p_results_visibility: 'after_close',
      p_expected_board_revision: state.boardRevision,
    };
    await rejected(host, 'dw_open_voting_round', { ...roundArgs, p_results_visibility: 'live' }, /FIRST_ROUND_BLIND/);
    await rejected(host, 'dw_open_voting_round', { ...roundArgs, p_operation_id: randomUUID(), p_settings: { minCoverage: 1.2 } }, /INVALID_INPUT/);
    const prompt = 'Следует ли включить адаптацию этой практики в муниципальную дорожную карту?';
    state = await rpc(host, 'dw_open_voting_round', {
      ...roundArgs, p_operation_id: randomUUID(),
      p_settings: { promptText: prompt, minCoverage: 0.7, minSubstantiveVotes: 2 },
    });
    const round = state.round;
    assert.equal(round.promptText, prompt);
    assert.equal(round.contextScope, 'region');
    assert.equal(round.contextRegionId, MORDOVIA);
    assert.equal(round.evaluationDimension, 'priority_for_adaptation');
    assert.equal(round.minCoverage, 0.7);
    assert.equal(round.minSubstantiveVotes, 2);
    assert.equal(round.familyCount, 2);
    for (const [sdk, value] of [[alice, 1], [bob, -1], [host, 0]]) {
      await rpc(sdk, 'dw_cast_vote', ballot(sessionId, round.id, familyId, value, 0));
      await rpc(sdk, 'dw_cast_vote', ballot(sessionId, round.id, otherFamilyId, 0, 0));
    }
    state = await closeRound(host, sessionId, round);
    const balanced = state.round.families.find((item) => item.id === familyId).totals;
    const neutral = state.round.families.find((item) => item.id === otherFamilyId).totals;
    assert.deepEqual({ support: balanced.support, oppose: balanced.oppose, neutral: balanced.neutral, substantive: balanced.substantive,
      coverage: balanced.coverage, supportRatio: balanced.supportRatio, net: balanced.net, qualifies: balanced.qualifies },
    { support: 1, oppose: 1, neutral: 1, substantive: 2, coverage: 1, supportRatio: 0.5, net: 0, qualifies: true });
    assert.deepEqual({ score: neutral.score, cast: neutral.cast, substantive: neutral.substantive, coverage: neutral.coverage,
      supportRatio: neutral.supportRatio, net: neutral.net, qualifies: neutral.qualifies },
    { score: 0, cast: 3, substantive: 0, coverage: 1, supportRatio: null, net: null, qualifies: false });
    assert.equal(state.rounds.find((item) => item.id === round.id).promptText, prompt);
    noPrivateProjectionFields(await rpc(host, 'dw_workshop_projector_snapshot', { p_session_id: sessionId }));
  });

  it('sends compact ballot updates only for a known frozen round and rehydrates changed or missing caches safely', async () => {
    const { host, alice, sessionId, familyId } = await groupedClassroom();
    const opened = await openRound(host, sessionId);
    const roundId = opened.round.id;
    const full = await rpc(alice, 'dw_workshop_updates', { p_session_id: sessionId, p_known_round_id: null });
    assert.equal(full.round.families[0].variants.length, 2);
    const brief = await rpc(alice, 'dw_workshop_updates', { p_session_id: sessionId, p_known_round_id: roundId });
    assert.equal(brief.round.families[0].variants, null);
    assert.equal(brief.round.families[0].id, familyId);
    assert.equal(brief.round.families[0].myVote, null);
    assert.ok(Buffer.byteLength(JSON.stringify(brief)) < Buffer.byteLength(JSON.stringify(full)) * 0.7,
      'A known immutable round must not retransmit all source bundles');
    const wrongCache = await rpc(alice, 'dw_workshop_updates', { p_session_id: sessionId, p_known_round_id: randomUUID() });
    assert.deepEqual(wrongCache.round.families[0].variants, full.round.families[0].variants);
    const request = { ...ballot(sessionId, roundId, familyId, 0, 0), p_known_round_id: roundId };
    const cast = await rpc(alice, 'dw_cast_vote_updates', request);
    assert.equal(cast.round.families[0].variants, null);
    assert.equal(cast.round.families[0].myVote, 0);
    assert.equal(cast.round.families[0].myVoteRevision, 1);
    const replayWithMissingCache = await rpc(alice, 'dw_cast_vote_updates', { ...request, p_known_round_id: null });
    assert.equal(replayWithMissingCache.cursor, cast.cursor);
    assert.deepEqual(replayWithMissingCache.round.families[0].variants, full.round.families[0].variants);
    assert.equal(replayWithMissingCache.round.families[0].myVoteRevision, 1);
    const projection = await rpc(host, 'dw_workshop_projector_updates', { p_session_id: sessionId, p_known_round_id: roundId });
    assert.equal(projection.round.families[0].variants, null);
    assert.equal(projection.round.families[0].totals, null);
    noPrivateProjectionFields(projection);
    await rejected(alice, 'dw_workshop_projector_updates', { p_session_id: sessionId, p_known_round_id: roundId }, /FORBIDDEN/);
    await closeRound(host, sessionId, opened.round);
    const closed = await rpc(alice, 'dw_workshop_updates', { p_session_id: sessionId, p_known_round_id: roundId });
    assert.equal(closed.round.status, 'closed');
    assert.equal(closed.round.families[0].variants, null);
    assert.equal(closed.round.families[0].totals.neutral, 1);
    const next = await openVisibleRound(host, sessionId);
    const changedRound = await rpc(alice, 'dw_workshop_updates', { p_session_id: sessionId, p_known_round_id: roundId });
    assert.equal(changedRound.round.id, next.round.id);
    assert.notEqual(changedRound.round.id, roundId);
    assert.deepEqual(changedRound.round.families[0].variants, full.round.families[0].variants);
    assert.equal(changedRound.round.families[0].myVote, null);
    assert.equal(changedRound.round.families[0].myVoteRevision, 0);
    const freshProjection = await rpc(host, 'dw_workshop_projector_updates', { p_session_id: sessionId, p_known_round_id: null });
    assert.equal(freshProjection.round.families[0].variants.length, 2);
    noPrivateProjectionFields(freshProjection);
  });
});
