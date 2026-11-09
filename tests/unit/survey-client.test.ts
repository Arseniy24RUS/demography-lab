import { describe, expect, it, vi } from 'vitest';
import {
  assertSurveyOrigin,
  readSurveyInvitation,
  surveyLink,
  validateSurveyDeployment,
} from '../../apps/web/src/lib/survey-deployment';
import { SurveyApi } from '../../apps/web/src/lib/survey-api';
import {
  createSurveyReceipt,
  invitationDigest,
  keepSecret,
  newSurveySecret,
  readSecret,
} from '../../apps/web/src/lib/survey-secrets';
import { researchArchive, researchCsv, safeCsvCell } from '../../apps/web/src/lib/survey-export';
import { validateCloudConfiguration } from '../../apps/web/src/lib/cloud-config';
import type {
  SurveyOwnResponse,
  SurveyResearchExport,
  SurveyResponseInput,
} from '../../packages/barriers/types';
import { unzipSync, strFromU8 } from 'fflate';

const id = '11111111-1111-4111-8111-111111111111',
  secret = 'a'.repeat(64),
  invite = 'b'.repeat(64);
const deployment = {
  url: 'https://survey.example.org/workshop/survey.html',
  classroomOrigin: 'https://class.example.org',
};
const input: SurveyResponseInput = {
  perspective: 'self',
  intention12m: 'unsure',
  intention36m: null,
  answerBarrier: 'Рабочий график меняется каждую неделю',
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
  expectedRevision: 0,
  questionVersion: 1,
};
const { expectedRevision: _expected, ...fields } = input;
const own: SurveyOwnResponse = {
  ...fields,
  status: 'submitted',
  revision: 1,
  availability: 'open',
};

describe('independent survey origin and capability boundaries', () => {
  it('preserves a subdirectory deployment and keeps the common invitation out of query parameters', () => {
    expect(validateSurveyDeployment(deployment.url, deployment.classroomOrigin)).toEqual({
      deployment,
      error: null,
    });
    const link = new URL(surveyLink(deployment, id, invite));
    expect(link.search).toBe('');
    expect(link.pathname).toBe('/workshop/survey.html');
    expect(readSurveyInvitation(link.hash)).toEqual({ surveyId: id, invitationToken: invite });
    expect(readSurveyInvitation(`#survey=${id}`)).toEqual({ surveyId: id, invitationToken: null });
    expect(() => assertSurveyOrigin(deployment, link.href)).not.toThrow();
    expect(() => assertSurveyOrigin(deployment, 'https://class.example.org/survey.html')).toThrow();
    expect(() =>
      assertSurveyOrigin(deployment, 'https://survey.example.org/survey.html'),
    ).toThrow();
  });
  it.each([
    ['https://class.example.org/survey.html', 'https://class.example.org'],
    ['http://survey.example.org/survey.html', deployment.classroomOrigin],
    ['https://user:password@survey.example.org/survey.html', deployment.classroomOrigin],
    ['https://survey.example.org/survey.html?invite=secret', deployment.classroomOrigin],
    ['https://survey.example.org/survey.html', 'https://class.example.org/path'],
    ['javascript:alert(1)', deployment.classroomOrigin],
  ])('rejects unsafe or shared-origin configuration %s', (url, classroom) =>
    expect(validateSurveyDeployment(url, classroom).deployment).toBeNull(),
  );
  it('does not disable document collaboration when only survey deployment is invalid', () => {
    const config = validateCloudConfiguration({
      schemaVersion: 1,
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'sb_publishable_test_public_key',
      surveyUrl: 'https://class.example.org/survey.html',
      classroomOrigin: 'https://class.example.org',
    });
    expect(config.error).toBeNull();
    expect(config.config?.url).toBe('https://example.supabase.co');
    expect(config.config?.survey).toBeNull();
    expect(config.config?.surveyError).toBeTruthy();
  });
  it('generates independent 256-bit capabilities and stores no answers with the receipt', async () => {
    const a = newSurveySecret(),
      b = newSurveySecret();
    expect(a).toMatch(/^[a-f0-9]{64}$/u);
    expect(a).not.toBe(b);
    expect(await invitationDigest(a)).toMatch(/^[a-f0-9]{64}$/u);
    expect(await invitationDigest(a)).not.toBe(a);
    const receipt = createSurveyReceipt(id, a, `${deployment.url}#invite=${invite}`);
    expect(receipt.surveyUrl).toBe(deployment.url);
    expect(Object.keys(receipt).sort()).toEqual([
      'format',
      'responseSecret',
      'surveyId',
      'surveyUrl',
    ]);
    expect(readSecret({ getItem: () => 'broken' }, 'key')).toBeNull();
    expect(
      keepSecret(
        {
          setItem: () => {
            throw new Error('storage denied');
          },
        },
        'key',
        a,
      ),
    ).toBe(false);
  });
});

describe('public questionnaire transport', () => {
  it('sends only the publishable key, omits account credentials and retains a retry identity after a lost response', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValue(new Response(JSON.stringify(own), { status: 200 }));
    const api = new SurveyApi(
      { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test_public_key' },
      send,
    );
    await expect(api.save(id, invite, secret, input)).rejects.toThrow('Нет подтверждения');
    await expect(api.save(id, invite, secret, input)).resolves.toMatchObject({
      status: 'submitted',
      revision: 1,
    });
    const requestA = send.mock.calls[0][1]!,
      requestB = send.mock.calls[1][1]!;
    expect(requestA.credentials).toBe('omit');
    expect(requestA.referrerPolicy).toBe('no-referrer');
    expect(requestA.headers).toEqual({
      apikey: 'sb_publishable_test_public_key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(requestA.body)).p_operation_id).toBe(
      JSON.parse(String(requestB.body)).p_operation_id,
    );
    expect(String(send.mock.calls[0][0])).not.toContain(secret);
  });
  it('retrieves and withdraws by the independent secret with no invitation dependency', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(own), { status: 200 }));
    const api = new SurveyApi(
      { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test_public_key' },
      send,
    );
    await api.own(id, secret);
    await api.withdraw(id, secret, 1);
    for (const [, request] of send.mock.calls) {
      expect(JSON.parse(String(request!.body))).not.toHaveProperty('p_invitation_token');
      expect(String(request!.body)).not.toContain(invite);
    }
  });
  it('blocks a proxy branch carrying personal intentions before sending it', async () => {
    const send = vi.fn<typeof fetch>();
    const api = new SurveyApi(
      { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test_public_key' },
      send,
    );
    expect(() =>
      api.save(id, invite, secret, { ...input, perspective: 'adult_child_inferred' }),
    ).toThrow('Проверьте');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('research export preserves content and neutralizes spreadsheet formulas', () => {
  it.each(['=1+1', '+SUM(A1:A2)', '-2+3', '@SUM(1)', ' \t=1', '\tanswer'])(
    'protects CSV value %s',
    (value) => expect(safeCsvCell(value).startsWith('"\'')).toBe(true),
  );
  it('retains source strings in JSON, separate citation consent and missingness in a readable archive', () => {
    const record = {
      perspective: 'professional',
      intention12m: null,
      intention36m: null,
      answerBarrier: '=HYPERLINK("example")',
      answerSupport: 'Жильё; занятость\nи уход',
      priorityChange: null,
      horizon: null,
      conditionalChange: null,
      additionalConditions: null,
      consentResearch: true,
      consentQuote: false,
      questionVersion: 1,
      responseDate: '2026-11-09',
      missingReasons: {
        intention12m: 'not_asked',
        intention36m: 'not_asked',
        priorityChange: 'skipped',
      },
    };
    const data: SurveyResearchExport = {
      datasetVersion: 'demography-research-export-1',
      procedureVersion: 'classroom-open-link-1',
      exportDate: '2026-11-09',
      samplingNote: 'Самоотбор по открытой ссылке.',
      questionnaire: {
        id,
        title: 'Учебный опрос',
        purpose: 'Обсуждение опыта участников занятия.',
        organizerContact: 'Преподаватель',
        retentionUntil: '2026-12-01',
        status: 'closed',
        expired: false,
        canRespond: false,
        questionVersion: 1,
        questionnaireVersion: 'demography-open-1',
        procedureVersion: 'classroom-open-link-1',
        questions: {
          q00: 'Перспектива',
          q05_12m: 'Намерение 12м',
          q05_36m: 'Намерение 36м',
          q01: 'Открытый вопрос о барьерах',
          q02: 'Открытый вопрос об условиях',
          q03: 'Приоритет',
          q04: 'Горизонт',
          q06: 'Условие',
          q07: 'Дополнения',
          q08: 'Согласия',
        },
      },
      missingCodes: {
        skipped: 'null',
        notAsked: 'not_asked',
        notApplicable: 'not_applicable',
        declined: 'decline',
      },
      records: [record as SurveyResearchExport['records'][number]],
    };
    const archive = unzipSync(researchArchive(data));
    expect(Object.keys(archive)).toEqual([
      'records.json',
      'records.csv',
      'questionnaire.json',
      'README.md',
    ]);
    const json = JSON.parse(strFromU8(archive['records.json']));
    expect(json.records[0].answerBarrier).toBe(record.answerBarrier);
    expect(json.records[0].consentQuote).toBe(false);
    expect(researchCsv(data)).toContain("'=HYPERLINK");
    expect(strFromU8(archive['README.md'])).toContain('не является оценкой причинного эффекта');
  });
});
