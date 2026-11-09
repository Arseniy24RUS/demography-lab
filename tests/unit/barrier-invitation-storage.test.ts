// @vitest-environment jsdom
import { createElement } from 'react';
import { webcrypto } from 'node:crypto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedBarriers } from '../../apps/web/src/components/ConnectedBarriers';
import type {
  BarrierAreaProps,
  BarrierActions,
} from '../../apps/web/src/components/barriers/barriers-ui';
import type { useBarriers } from '../../apps/web/src/hooks/useBarriers';
import type { SessionApi } from '../../apps/web/src/lib/session-api';
import { hostInvitationStorageKey, invitationDigest } from '../../apps/web/src/lib/survey-secrets';
import type {
  SessionAreaActions,
  SessionAreaState,
  SessionSummary,
} from '../../packages/collaboration/types';
import type { SurveyConfigInput, SurveySummary } from '../../packages/barriers/types';

const observed = vi.hoisted(() => ({ props: null as BarrierAreaProps | null }));
vi.mock('../../apps/web/src/components/barriers/BarrierArea', () => ({
  BarrierArea: (props: BarrierAreaProps) => {
    observed.props = props;
    return createElement(
      'section',
      null,
      props.surveyInvitationError
        ? createElement('p', { role: 'alert' }, props.surveyInvitationError)
        : null,
      props.surveyInvitationUrl
        ? createElement('a', { href: props.surveyInvitationUrl }, 'Общая ссылка опроса')
        : null,
    );
  },
}));

const userId = '10000000-0000-4000-8000-000000000001';
const sessionId = '10000000-0000-4000-8000-000000000002';
const firstSurvey = '10000000-0000-4000-8000-000000000003';
const nextSurvey = '10000000-0000-4000-8000-000000000004';
const backend = 'https://fixture.supabase.co';
const storageKey = hostInvitationStorageKey(backend, userId, sessionId);
const input: SurveyConfigInput = {
  surveyId: null,
  expectedRevision: 0,
  title: 'Условия родительства',
  purpose: 'Учебное обсуждение препятствий и возможных решений.',
  organizerContact: 'organizer@example.test',
  retentionUntil: '2026-12-01',
  questionBarrier: 'Что препятствует родительству?',
  questionSupport: 'Какое изменение могло бы помочь?',
};
const session: SessionSummary = {
  id: sessionId,
  title: 'Учебное занятие',
  scope: 'municipality',
  regionId: 'respublika-mordoviia',
  status: 'open',
  phase: 'reading',
  role: 'host',
  revision: 1,
  joinOpen: true,
  focusSubmissionId: null,
  projectorShowAuthors: false,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
};
const state: SessionAreaState = {
  configured: true,
  configurationError: null,
  testEnvironment: true,
  auth: { status: 'signed-in', email: 'host@example.test', userId },
  bootstrap: null,
  snapshot: { session, members: [], submissions: [], cursor: 0 },
  invitation: null,
  connection: 'polling',
  busy: null,
  error: null,
  notice: null,
  initialJoinCode: '',
  lastSyncedAt: null,
};
function survey(id: string, status: 'draft' | 'open' = 'draft', revision = 1): SurveySummary {
  return {
    id,
    title: input.title,
    purpose: input.purpose,
    organizerContact: input.organizerContact,
    retentionUntil: input.retentionUntil,
    status,
    expired: false,
    canRespond: status === 'open',
    questionVersion: 1,
    questionnaireVersion: 'demography-open-1',
    procedureVersion: 'classroom-open-link-1',
    revision,
    responseCount: null,
    questions: {
      q00: 'Перспектива',
      q05_12m: 'Намерение на 12 месяцев',
      q05_36m: 'Намерение на 36 месяцев',
      q01: input.questionBarrier,
      q02: input.questionSupport,
      q03: 'Приоритетное условие',
      q04: 'Горизонт',
      q06: 'Условное намерение',
      q07: 'Дополнительные условия',
      q08: 'Согласия',
    },
  };
}
function mount() {
  const digests = new Map<string, string>();
  const save = vi.fn<(input: SurveyConfigInput) => Promise<unknown>>().mockResolvedValue(undefined);
  const manage = vi.fn<BarrierActions['manageSurvey']>().mockResolvedValue(undefined);
  const readPrivate = vi
    .fn<BarrierActions['readSurvey']>()
    .mockRejectedValue(new Error('Private answers must not be fetched during invitation recovery'));
  const metadata = vi.fn(async (surveyId: string) => {
    const digest = digests.get(surveyId);
    if (!digest) throw new Error('No survey metadata fixture');
    return { surveyId, invitationDigest: digest };
  });
  const actions: BarrierActions = {
    saveBarrier: vi.fn(),
    vote: vi.fn(),
    saveLink: vi.fn(),
    saveSolution: vi.fn(),
    readEvidence: vi.fn(),
    saveSurvey: save,
    manageSurvey: manage,
    readSurvey: readPrivate,
    exportResearch: vi.fn(),
  };
  const api = {
    config: {
      url: backend,
      publishableKey: 'sb_publishable_test_public_key',
      realtime: false,
      testEnvironment: true,
      pollInterval: 1000,
      survey: {
        url: 'https://survey.example.test/survey.html',
        classroomOrigin: 'https://class.example.test',
      },
    },
  } as unknown as SessionApi;
  const makeProps = (current: SurveySummary | null) => {
    const barriers: ReturnType<typeof useBarriers> = {
      snapshot: {
        sessionId,
        cursor: current?.revision ?? 0,
        barriers: [],
        families: [],
        links: [],
        solutions: [],
        survey: current,
      },
      projection: null,
      actions,
      busy: false,
      loading: false,
      error: null,
      refresh: vi.fn(async () => {}),
      invitation: metadata,
    };
    return {
      state,
      api,
      legacySurvey: true,
      barriers,
      sessionActions: { openSource: vi.fn() } as unknown as SessionAreaActions,
      manifest: { schemaVersion: 1, generatedAt: '2026-11-08', documents: [] },
    };
  };
  const view = render(createElement(ConnectedBarriers, makeProps(null)));
  return {
    save,
    manage,
    readPrivate,
    metadata,
    async show(current: SurveySummary, secret: string) {
      digests.set(current.id, await invitationDigest(secret));
      view.rerender(createElement(ConnectedBarriers, makeProps(current)));
      await waitFor(() =>
        expect(
          screen.getByRole('link', { name: 'Общая ссылка опроса' }).getAttribute('href'),
        ).toContain(`invite=${secret}`),
      );
    },
    clear() {
      view.rerender(createElement(ConnectedBarriers, makeProps(null)));
    },
  };
}

beforeEach(() => {
  observed.props = null;
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  const originalSetItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    // The short operation label fits, but both pending/current 256-bit capabilities hit quota.
    if (key.endsWith(':attempt')) return originalSetItem.call(this, key, value);
    throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('host invitation recovery when storage accepts only the attempt marker', () => {
  it('shows a warning, reuses a pending secret after a lost reply and retains the link through draft → open in this tab', async () => {
    const fixture = mount();
    fixture.save.mockRejectedValueOnce(new TypeError('Reply lost after server commit'));
    await act(async () => {
      await expect(observed.props!.actions.saveSurvey(input)).rejects.toThrow('Reply lost');
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'Браузер запретил сохранение приглашения',
    );
    expect(localStorage.getItem(storageKey + ':attempt')).toBe('create');
    expect(localStorage.getItem(storageKey + ':pending')).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
    const first = fixture.save.mock.calls[0][0].invitationToken!;
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    await act(async () => {
      await observed.props!.actions.saveSurvey(input);
    });
    expect(fixture.save.mock.calls[1][0].invitationToken).toBe(first);
    await fixture.show(survey(firstSurvey), first);
    expect(screen.getByRole('alert').textContent).toContain(
      'Скопируйте общую ссылку до закрытия вкладки',
    );
    await act(async () => {
      await observed.props!.actions.manageSurvey({
        surveyId: firstSurvey,
        expectedRevision: 1,
        action: 'open',
      });
    });
    await fixture.show(survey(firstSurvey, 'open', 2), first);
    expect(screen.getByRole('alert').textContent).toContain(
      'после перезагрузки потребуется заменить приглашение',
    );
    expect(fixture.metadata).toHaveBeenCalledTimes(2);
    expect(fixture.readPrivate).not.toHaveBeenCalled();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
  it('generates a fresh invitation after purge → new create despite the surviving create marker and old current memory', async () => {
    const fixture = mount();
    await act(async () => {
      await observed.props!.actions.saveSurvey(input);
    });
    const first = fixture.save.mock.calls[0][0].invitationToken!;
    await fixture.show(survey(firstSurvey), first);
    await fixture.show(survey(firstSurvey, 'open', 2), first);
    await act(async () => {
      await observed.props!.actions.manageSurvey({
        surveyId: firstSurvey,
        expectedRevision: 2,
        action: 'purge',
      });
    });
    fixture.clear();
    expect(screen.queryByRole('link')).toBeNull();
    expect(localStorage.getItem(storageKey + ':attempt')).toBe('create');
    await act(async () => {
      await observed.props!.actions.saveSurvey(input);
    });
    const second = fixture.save.mock.calls[1][0].invitationToken!;
    expect(second).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
    await fixture.show(survey(nextSurvey), second);
    expect(screen.getByRole('link').getAttribute('href')).toContain(`survey=${nextSurvey}`);
    expect(screen.getByRole('link').getAttribute('href')).not.toContain(first);
    expect(screen.getByRole('alert').textContent).toContain(
      'Браузер запретил сохранение приглашения',
    );
    expect(fixture.readPrivate).not.toHaveBeenCalled();
  });
});
