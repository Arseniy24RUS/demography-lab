// @vitest-environment jsdom
import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LivePracticeVoting } from '../../apps/web/src/components/workshop/LivePracticeVoting';
import { useLivePracticeVotes } from '../../apps/web/src/hooks/useLivePracticeVotes';
import type { WorkspaceVoteFamily, WorkspaceVotesSnapshot } from '../../packages/workshop/live-votes';

vi.mock('../../apps/web/src/hooks/useLivePracticeVotes', () => ({ useLivePracticeVotes: vi.fn() }));

const firstId = '10000000-0000-4000-8000-000000000001';
const secondId = '10000000-0000-4000-8000-000000000002';
const firstTitle = 'Компенсация родительской платы за детский сад без потери условий регионального варианта';
const secondTitle = 'Поддержка семей с детьми';
const family = (familyId: string, title: string, support: number, oppose = 0): WorkspaceVoteFamily => ({
  familyId, title, fingerprint: 'a'.repeat(64), support, oppose, unanswered: 5 - support - oppose,
  score: support - oppose, myVote: null, myVoteRevision: 0, needsReview: false,
});
const props = {
  state: {
    auth: { userId: 'participant' },
    snapshot: {
      session: { id: 'workshop' },
      submissions: [{
        id: 'source-1', status: 'shared',
        bundle: { practice: { title: firstTitle, regionId: 'moskva', amount: 'Исходная сумма' } },
      }],
    },
  },
  api: null,
  workshop: { snapshot: { families: [
    { id: firstId, title: firstTitle, mechanism: firstTitle, submissionIds: ['source-1'], createdAt: '2026-11-16T10:00:00Z' },
    { id: secondId, title: secondTitle, mechanism: secondTitle, submissionIds: [], createdAt: '2026-11-16T11:00:00Z' },
  ] } },
  onOpenSource: vi.fn(),
  manifest: { documents: [{ regionId: 'moskva', territory: 'Москва', textUrl: null }] },
} as unknown as ComponentProps<typeof LivePracticeVoting>;
const vote = vi.fn();
const refresh = vi.fn();
let data: WorkspaceVotesSnapshot;
const board = () => screen.getByRole('region', { name: 'Рейтинг практик' });
const titles = () => within(board()).getAllByRole('article').map(article => within(article).getByRole('heading', { level: 3 }).textContent);
const mode = (name: 'Облако' | 'Рейтинг') => within(screen.getByRole('group', { name: 'Вид практик' })).getByRole('button', { name });

beforeEach(() => {
  data = {
    sessionId: 'workshop', cursor: 1, participantCount: 5,
    families: [{ ...family(firstId, firstTitle, 3, 1), myVote: 1 }, family(secondId, secondTitle, 1)],
  };
  vi.mocked(useLivePracticeVotes).mockImplementation(() => ({
    data, error: null, pendingFamilyId: null, loading: false, vote, refresh,
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('practice cloud and ranking', () => {
  it('starts in the cloud, switches to ranked rows and keeps the same voting actions in both views', () => {
    render(createElement(LivePracticeVoting, props));
    expect(mode('Облако').getAttribute('aria-pressed')).toBe('true');
    expect(titles()).toEqual([secondTitle, firstTitle]);
    expect(screen.queryByLabelText('Место 1')).toBeNull();
    expect(screen.getByRole('button', { name: `Поддержать: ${firstTitle}` }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(mode('Рейтинг'));
    expect(mode('Рейтинг').getAttribute('aria-pressed')).toBe('true');
    expect(titles()).toEqual([firstTitle, secondTitle]);
    expect(within(screen.getByLabelText('Место 1').closest('article')!).getByRole('heading', { level: 3 }).textContent).toBe(firstTitle);
    fireEvent.click(screen.getByRole('button', { name: `Поддержать: ${secondTitle}` }));
    expect(vote).toHaveBeenLastCalledWith(data.families[1], 1);
    fireEvent.click(mode('Облако'));
    expect(titles()).toEqual([secondTitle, firstTitle]);
    fireEvent.click(screen.getByRole('button', { name: `Поддержать: ${firstTitle}` }));
    expect(vote).toHaveBeenLastCalledWith(data.families[0], null);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps cloud positions stable when server votes reorder the payload, then refreshes ranking order', () => {
    const mounted = render(createElement(LivePracticeVoting, props));
    data = { ...data, cursor: 2, families: [family(secondId, secondTitle, 5), family(firstId, firstTitle, 0, 2)] };
    mounted.rerender(createElement(LivePracticeVoting, props));
    expect(titles()).toEqual([secondTitle, firstTitle]);
    fireEvent.click(mode('Рейтинг'));
    expect(titles()).toEqual([secondTitle, firstTitle]);
    data = { ...data, cursor: 3, families: [family(firstId, firstTitle, 4), family(secondId, secondTitle, 0)] };
    mounted.rerender(createElement(LivePracticeVoting, props));
    expect(titles()).toEqual([firstTitle, secondTitle]);
    fireEvent.click(mode('Облако'));
    expect(titles()).toEqual([secondTitle, firstTitle]);
  });

  it('preserves search, expanded source variants and original ranking positions across view changes', () => {
    render(createElement(LivePracticeVoting, props));
    const variants = screen.getByText('Варианты мер · 1').closest('details')!;
    variants.open = true;
    fireEvent(variants, new Event('toggle'));
    expect(screen.getByText('Исходная сумма')).toBeTruthy();
    fireEvent.click(mode('Рейтинг'));
    expect(screen.getByText('Исходная сумма')).toBeTruthy();
    const search = screen.getByRole('searchbox', { name: 'Найти меру' });
    fireEvent.change(search, { target: { value: secondTitle } });
    expect(titles()).toEqual([secondTitle]);
    expect(screen.getByLabelText('Место 2')).toBeTruthy();
    fireEvent.click(mode('Облако'));
    expect((search as HTMLInputElement).value).toBe(secondTitle);
    expect(titles()).toEqual([secondTitle]);
    fireEvent.change(search, { target: { value: '' } });
    expect(titles()).toEqual([secondTitle, firstTitle]);
  });
});
