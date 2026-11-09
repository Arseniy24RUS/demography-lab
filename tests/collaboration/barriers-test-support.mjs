import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { FIXTURE_PUBLISHABLE_KEY } from '../../scripts/test-collaboration-gateway.mjs';
import {
  startWorkshopHarness, successfulRpc as rpc, publishPrepared,
} from './workshop-test-support.mjs';

export const SURVEY_ORIGIN = 'http://127.0.0.1:4174';
export const token = () => randomBytes(32).toString('hex');
export const barrierSnapshot = (sdk, sessionId) => rpc(sdk, 'dw_barriers_snapshot', { p_session_id: sessionId });
export const sessionSnapshot = (sdk, sessionId) => rpc(sdk, 'dw_session_snapshot', { p_session_id: sessionId });
export const workshopSnapshot = (sdk, sessionId) => rpc(sdk, 'dw_workshop_snapshot', { p_session_id: sessionId });
export const named = (sessionId, input, operationId = randomUUID()) => ({
  p_operation_id: operationId, p_session_id: sessionId, p_input: input,
});

export function barrierInput(overrides = {}) {
  return {
    barrierId: null, expectedRevision: 0, title: 'Нестабильный график присмотра за ребёнком',
    description: 'Работающие родители не могут совместить сменную работу и часы работы детского сада.',
    primaryStage: 'preschool', stageIds: ['preschool', 'next_child'],
    evidenceKind: 'hypothesis', status: 'active', priority: false, ...overrides,
  };
}

export function editBarrier(card, overrides = {}) {
  return barrierInput({
    barrierId: card.id, expectedRevision: card.revision, title: card.title,
    description: card.description, primaryStage: card.primaryStage, stageIds: card.stageIds,
    evidenceKind: card.evidenceKind, status: card.status, priority: card.priority, ...overrides,
  });
}

export function solutionInput(barrierIds, overrides = {}) {
  return {
    solutionId: null, expectedRevision: 0, barrierIds,
    title: 'Пилот гибкой группы вечернего присмотра', targetGroup: 'Родители детей дошкольного возраста со сменным графиком.',
    mechanism: 'Проверить добровольный спрос и согласовать пробные часы присмотра.',
    firstStep: 'Обсудить реальные часы спроса с родителями двух дошкольных учреждений.',
    responsible: 'Муниципальный координатор дошкольного образования', resources: 'Оценить оплату дополнительных часов и доступность помещений.',
    successIndicator: 'Доля заявок на вечерний присмотр, удовлетворённых в пилоте.',
    risks: 'Недостаточный спрос и нагрузка на персонал; вывод о рождаемости из пилота не следует.',
    status: 'active', ...overrides,
  };
}

export function answerInput(overrides = {}) {
  return {
    expectedRevision: 0, questionVersion: 1, perspective: 'self',
    intention12m: 'unsure', intention36m: 'probably_yes',
    answerBarrier: 'Нужна возможность сочетать уход за ребёнком и рабочее время.',
    answerSupport: 'Доступный вечерний присмотр и понятный график работы учреждения.',
    priorityChange: null, priorityConditionId: null, horizon: null, conditionalChange: null,
    additionalConditions: null, consentEducational: true, consentResearch: false,
    consentQuote: false, adultConfirmed: true, ...overrides,
  };
}

export function saveResponseArgs(surveyId, invitationToken, responseSecret, input, operationId = randomUUID()) {
  return {
    p_operation_id: operationId, p_survey_id: surveyId,
    p_invitation_token: invitationToken, p_response_secret: responseSecret, p_input: input,
  };
}

export async function startBarrierHarness() {
  // Explicit second-origin configuration enables only the four public survey RPCs.
  const previous = process.env.WORKSHOP_TEST_SURVEY_ORIGIN;
  process.env.WORKSHOP_TEST_SURVEY_ORIGIN = SURVEY_ORIGIN;
  let harness;
  try { harness = await startWorkshopHarness(); }
  finally {
    if (previous === undefined) delete process.env.WORKSHOP_TEST_SURVEY_ORIGIN;
    else process.env.WORKSHOP_TEST_SURVEY_ORIGIN = previous;
  }
  async function requestPublic(name, args, headers = {}) {
    const response = await fetch(`${harness.gateway.url}/rest/v1/rpc/${name}`, {
      method: 'POST', credentials: 'omit', redirect: 'error',
      headers: { apikey: FIXTURE_PUBLISHABLE_KEY, 'Content-Type': 'application/json', Origin: SURVEY_ORIGIN, ...headers },
      body: JSON.stringify(args),
    });
    const data = await response.json();
    return { response, data };
  }
  async function publicRpc(name, args) {
    const { response, data } = await requestPublic(name, args);
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(data)}`);
    assert.equal(data?.error, undefined, `${name}: ${JSON.stringify(data?.error)}`);
    return data;
  }
  async function publicRejected(name, args, pattern) {
    const { response, data } = await requestPublic(name, args);
    const error = data?.error ?? (response.ok ? null : data);
    assert.ok(error, `${name} unexpectedly accepted the public request`);
    if (pattern) assert.match(`${error.code ?? ''} ${error.message ?? ''}`, pattern);
    return { response, error };
  }
  return { ...harness, requestPublic, publicRpc, publicRejected };
}

export async function groupedClassroom(harness, options = {}) {
  const classroom = await harness.classroom({ includeBob: true, ...options });
  const { host, alice, bob, sessionId } = classroom;
  const mordovia = await publishPrepared(alice, sessionId, 'mordovia-kindergarten-compensation');
  const sakhalin = await publishPrepared(bob, sessionId, 'sakhalin-kindergarten-compensation');
  const workshop = await workshopSnapshot(host, sessionId);
  const state = await rpc(host, 'dw_save_family', {
    p_operation_id: randomUUID(), p_session_id: sessionId, p_family_id: null,
    p_expected_board_revision: workshop.boardRevision,
    p_title: 'Компенсация платы за детский сад',
    p_mechanism: 'Частичное возмещение родительской платы с разными региональными условиями.',
    p_rationale: 'Сравниваем механизм, сохраняя размеры и условия каждого регионального варианта.',
    p_submission_ids: [mordovia.submission.id, sakhalin.submission.id],
  });
  return { ...classroom, mordovia, sakhalin, familyId: state.families[0].id };
}

export async function createSurvey(host, sessionId, { open = true, ...overrides } = {}) {
  const invitationToken = token();
  let state = await rpc(host, 'dw_save_survey', named(sessionId, {
    surveyId: null, expectedRevision: 0, title: 'Барьеры и условия родительства · учебное обсуждение',
    purpose: 'Добровольное учебное обсуждение барьеров; отдельное согласие требуется для исследования.',
    organizerContact: 'Преподаватель: teacher@workshop.test',
    retentionUntil: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    questionBarrier: 'Что затрудняет решение о рождении ребёнка?',
    questionSupport: 'Какие изменения могли бы изменить это решение?',
    invitationToken, ...overrides,
  }));
  if (open) state = await rpc(host, 'dw_manage_survey', named(sessionId, {
    surveyId: state.survey.id, expectedRevision: state.survey.revision, action: 'open',
  }));
  return { surveyId: state.survey.id, invitationToken, state };
}

export const hostSurvey = (sdk, sessionId, surveyId) => rpc(sdk, 'dw_survey_host_state', {
  p_session_id: sessionId, p_survey_id: surveyId,
});
export const researchExport = (sdk, sessionId, surveyId) => rpc(sdk, 'dw_survey_research_export', {
  p_session_id: sessionId, p_survey_id: surveyId,
});

export function assertNoKeys(value, forbidden) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!forbidden.has(key), `Restricted DTO leaked ${key}`);
    assertNoKeys(child, forbidden);
  }
}
