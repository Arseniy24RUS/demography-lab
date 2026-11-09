import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntime } from '../../scripts/offline/storage.mjs';
import { startServer } from '../../scripts/offline/server.mjs';

process.env.NODE_ENV = 'test';
const op = () => randomUUID();

it('production offline HTTP shares anonymous notes/votes across identities and persists notes, cursors, removals and receipts after restart', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dw-flipchart-http-')), dataDir = join(work, 'state');
  let runtime, server, base, survey;
  const request = async (path, input = {}, token, target = base) => {
    const response = await fetch(target + path, { method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: target, ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  const rpc = async (name, args, session) => {
    const response = await request('/rest/v1/rpc/' + name, args, session.access_token);
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const identify = async (email, fullName) => {
    const response = await request('/offline/auth/identify', { email, ...(fullName ? { fullName } : {}) });
    assert.equal(response.status, 200); return response.body.session;
  };
  const start = async () => {
    runtime = await openRuntime({ dataDir, testSeed: async () => ({ fixture: true }) });
    server = await startServer({ runtime, host: '127.0.0.1', port: 0, surveyPort: 0,
      root: join(work, 'site'), backupIntervalMs: 0, logger: { log() {}, error() {} } });
    base = `http://127.0.0.1:${server.port}`; survey = `http://127.0.0.1:${server.surveyPort}`;
  };
  try {
    await mkdir(join(work, 'site/dist'), { recursive: true });
    for (const name of ['index.html', 'survey.html'])
      await writeFile(join(work, 'site/dist', name), '<html><body>Flipchart HTTP test</body></html>');
    await start();
    const a = await identify('flipchart-a@example.test', 'Первый Участник');
    const b = await identify('flipchart-b@example.test', 'Второй Участник');
    const entered = await Promise.all([a, b].map((s) => rpc('dw_enter_workspace', { p_operation_id: op() }, s)));
    const sid = entered[0].session.id;
    assert.equal(entered[1].session.id, sid); assert(entered.every((x) => x.session.role === 'participant'));
    const sharedSurvey = await rpc('dw_workshop_survey', { p_session_id: sid }, a);
    const responseSecret = randomBytes(32).toString('hex');
    const answers = { expectedRevision: 0, questionVersion: 1, perspective: 'self', intention12m: null, intention36m: null,
      answerBarrier: 'Прежний частный ответ', answerSupport: null, priorityChange: null, priorityConditionId: null,
      horizon: null, conditionalChange: null, additionalConditions: null,
      consentEducational: true, consentResearch: false, consentQuote: false, adultConfirmed: true };
    const oldSaved = await request('/rest/v1/rpc/dw_survey_save_response', { p_operation_id: op(),
      p_survey_id: sharedSurvey.survey.id, p_invitation_token: sharedSurvey.invitationToken,
      p_response_secret: responseSecret, p_input: answers }, undefined, survey);
    assert.equal(oldSaved.status, 200);
    const priorPrivateRows = (await runtime.db.query('select to_jsonb(r) row from research.responses r')).rows;
    const input = { p_operation_id: op(), p_session_id: sid, p_input: { kind: 'barrier', text: 'Недоступное жильё' } };
    const post = await rpc('dw_flipchart_add', input, a);
    const condition = await rpc('dw_flipchart_add', { p_operation_id: op(), p_session_id: sid,
      p_input: { kind: 'condition', text: 'Доступная аренда' } }, a);
    await rpc('dw_flipchart_add', { p_operation_id: op(), p_session_id: sid,
      p_input: { kind: 'barrier', text: 'Нет яслей' } }, b);
    const voteInput = { p_operation_id: op(), p_session_id: sid, p_note_id: post.note.id,
      p_expected_revision: 0, p_input: { value: 1 } };
    await rpc('dw_flipchart_vote', voteInput, a);
    await rpc('dw_flipchart_vote', { ...voteInput, p_operation_id: op(), p_input: { value: -1 } }, b);
    const hidden = await rpc('dw_flipchart_status', { p_operation_id: op(), p_session_id: sid,
      p_note_id: condition.note.id, p_expected_revision: 1, p_input: { status: 'withdrawn' } }, a);
    const current = await rpc('dw_flipchart_updates', { p_session_id: sid }, a);
    assert.equal(current.notes.length, 2); assert.equal(current.cursor, 6);
    assert.deepEqual(current.notes.map((n) => [n.text, n.support, n.oppose]), [['Недоступное жильё', 1, 1], ['Нет яслей', 0, 0]]);
    const delta = await rpc('dw_flipchart_updates', { p_session_id: sid, p_after_cursor: condition.cursor }, b);
    assert.deepEqual(delta.removedIds, [condition.note.id]); assert.equal(delta.notes.length, 2);
    const projected = await rpc('dw_flipchart_updates', { p_session_id: sid, p_projector: true }, b);
    assert(projected.notes.every((n) => !('myVote' in n) && !('canWithdraw' in n) && !('myVoteRevision' in n)));
    for (const secret of [a.user.id, b.user.id, 'flipchart-a@example.test', 'Первый Участник', responseSecret, answers.answerBarrier])
      assert(!JSON.stringify(projected).includes(secret));
    assert.equal((await request('/rest/v1/rpc/dw_flipchart_updates', { p_session_id: sid })).status, 401);
    assert.equal((await request('/rest/v1/rpc/dw_flipchart_updates', { p_session_id: sid }, undefined, survey)).status, 404);
    await server.stop(); server = null; runtime = null;
    await start();
    const returned = await identify('flipchart-a@example.test');
    assert.equal(returned.user.id, a.user.id);
    assert.equal((await rpc('dw_enter_workspace', { p_operation_id: op() }, returned)).session.id, sid);
    assert.deepEqual(await rpc('dw_flipchart_updates', { p_session_id: sid }, returned), current);
    assert.deepEqual(await rpc('dw_flipchart_updates', { p_session_id: sid, p_after_cursor: current.cursor }, returned),
      { sessionId: sid, cursor: current.cursor, reset: false, notes: [], removedIds: [] });
    assert.equal((await rpc('dw_flipchart_add', input, returned)).note.id, post.note.id);
    assert.equal((await rpc('dw_flipchart_vote', voteInput, returned)).note.myVoteRevision, 1);
    assert.equal((await rpc('dw_flipchart_updates', { p_session_id: sid }, returned)).cursor, current.cursor);
    const restored = await rpc('dw_flipchart_status', { p_operation_id: op(), p_session_id: sid,
      p_note_id: condition.note.id, p_expected_revision: hidden.note.revision, p_input: { status: 'active' } }, returned);
    const restoredDelta = await rpc('dw_flipchart_updates', { p_session_id: sid, p_after_cursor: current.cursor }, returned);
    assert.equal(restoredDelta.cursor, restored.cursor); assert.deepEqual(restoredDelta.notes, [restored.note]);
    assert.deepEqual(restoredDelta.removedIds, []);
    assert.deepEqual((await runtime.db.query('select to_jsonb(r) row from research.responses r')).rows, priorPrivateRows);
    const legacy = await request('/rest/v1/rpc/dw_survey_own_response', { p_survey_id: sharedSurvey.survey.id,
      p_response_secret: responseSecret }, undefined, survey);
    assert.equal(legacy.status, 200); assert.equal(legacy.body.answerBarrier, answers.answerBarrier);
  } finally {
    await server?.stop(); await runtime?.close(); await rm(work, { recursive: true, force: true });
  }
});
