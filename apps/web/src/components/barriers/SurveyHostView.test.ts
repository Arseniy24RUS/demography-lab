// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SurveyHostState, SurveySummary } from '../../../../../packages/barriers/types';
import type { BarrierActions, BarrierAreaProps, BarrierBoardContext } from './barriers-ui';
import { BarrierArea } from './BarrierArea';
import { SurveyHostView } from './SurveyHostView';

const oldId = '00000000-0000-4000-8000-000000000101';
const newId = '00000000-0000-4000-8000-000000000102';
function survey(id: string): SurveySummary {
  return {
    id,
    title: id === oldId ? 'Первое учебное обсуждение' : 'Новое учебное обсуждение',
    purpose: 'Добровольное обсуждение препятствий к родительству на занятии.',
    organizerContact: 'Преподаватель, контакт в программе занятия',
    retentionUntil: '2027-01-01',
    status: 'open',
    expired: false,
    canRespond: true,
    questionVersion: 1,
    questionnaireVersion: 'demography-open-1',
    procedureVersion: 'classroom-open-link-1',
    revision: 1,
    responseCount: null,
    questions: {
      q00: 'Перспектива',
      q05_12m: 'Планы на год',
      q05_36m: 'Планы на три года',
      q01: 'Какие обстоятельства затрудняют решение?',
      q02: 'Какие условия могли бы помочь?',
      q03: 'Приоритет',
      q04: 'Горизонт',
      q06: 'Изменение намерения',
      q07: 'Другие условия',
      q08: 'Согласия',
    },
  };
}
function hostState(id: string, text: string): SurveyHostState {
  return {
    survey: survey(id),
    responseCount: 1,
    researchCount: 0,
    quoteCount: 0,
    invitationDigest: 'a'.repeat(64),
    responses: [
      {
        rowKey: '00000000-0000-4000-8000-000000000201',
        questionVersion: 1,
        revision: 1,
        responseDate: '2026-11-09',
        perspective: 'self',
        intention12m: null,
        intention36m: null,
        answerBarrier: text,
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
    ],
  };
}
function context(id: string, readSurvey: BarrierActions['readSurvey']): BarrierBoardContext {
  return {
    session: {
      id: '00000000-0000-4000-8000-000000000301',
      title: 'Учебная сессия',
      scope: 'municipality',
      regionId: 'respublika-mordoviia',
      status: 'open',
      phase: 'reading',
      role: 'host',
      revision: 1,
      joinOpen: true,
      focusSubmissionId: null,
      projectorShowAuthors: false,
      createdAt: '2026-11-09T00:00:00Z',
      updatedAt: '2026-11-09T00:00:00Z',
    },
    snapshot: {
      sessionId: '00000000-0000-4000-8000-000000000301',
      cursor: 1,
      barriers: [],
      families: [],
      links: [],
      solutions: [],
      survey: survey(id),
    },
    userId: '00000000-0000-4000-8000-000000000401',
    regions: [],
    editable: true,
    isHost: true,
    onOpenSource: vi.fn(),
    actions: {
      saveBarrier: vi.fn(),
      vote: vi.fn(),
      saveLink: vi.fn(),
      saveSolution: vi.fn(),
      readEvidence: vi.fn(),
      saveSurvey: vi.fn(),
      manageSurvey: vi.fn(),
      readSurvey,
      exportResearch: vi.fn(),
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(cleanup);

describe('host survey response isolation across survey replacement', () => {
  it('removes explicitly reviewed raw text when the board jumps directly to a newly created survey', async () => {
    const read = vi.fn(async () => hostState(oldId, 'Личный ответ только первого опроса.'));
    const first = context(oldId, read);
    const props: BarrierAreaProps = { ...first, surveyOnly: true };
    const view = render(createElement(BarrierArea, props));
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Просмотреть ответы' }));
    await screen.findByText('Личный ответ только первого опроса.', { exact: true });
    view.rerender(createElement(BarrierArea, { ...context(newId, read), surveyOnly: true }));
    expect(screen.queryByText('Личный ответ только первого опроса.', { exact: true })).toBeNull();
    expect(screen.getByRole('button', { name: 'Просмотреть ответы' })).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('ignores a delayed response from the preceding survey, even without the keyed parent', async () => {
    const pending = deferred<SurveyHostState>();
    const read = vi.fn((id: string) =>
      id === oldId ? pending.promise : Promise.resolve(hostState(newId, 'Ответ нового опроса.')),
    );
    const view = render(createElement(SurveyHostView, { context: context(oldId, read) }));
    fireEvent.click(screen.getByRole('button', { name: 'Просмотреть ответы' }));
    view.rerender(createElement(SurveyHostView, { context: context(newId, read) }));
    await act(async () => pending.resolve(hostState(oldId, 'Запоздавший текст старого опроса.')));
    expect(screen.queryByText('Запоздавший текст старого опроса.', { exact: true })).toBeNull();
    expect(
      screen.queryByRole('region', { name: 'Ответы, доступные только преподавателю' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Просмотреть ответы' }));
    await screen.findByText('Ответ нового опроса.', { exact: true });
  });

  it('does not reopen private responses when an in-flight refresh completes after the host hides them', async () => {
    const pending = deferred<SurveyHostState>();
    const read = vi
      .fn<BarrierActions['readSurvey']>()
      .mockResolvedValueOnce(hostState(oldId, 'Ответ, который преподаватель скроет.'))
      .mockImplementationOnce(() => pending.promise);
    render(createElement(SurveyHostView, { context: context(oldId, read) }));
    fireEvent.click(screen.getByRole('button', { name: 'Просмотреть ответы' }));
    await screen.findByText('Ответ, который преподаватель скроет.', { exact: true });
    fireEvent.click(screen.getByRole('button', { name: 'Обновить ответы' }));
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть ответы' }));
    await act(async () => pending.resolve(hostState(oldId, 'Запоздавший ответ после скрытия.')));
    expect(screen.queryByText('Запоздавший ответ после скрытия.', { exact: true })).toBeNull();
    expect(screen.queryByText('Ответ, который преподаватель скроет.', { exact: true })).toBeNull();
    expect(screen.getByRole('button', { name: 'Просмотреть ответы' })).toBeTruthy();
  });
});
