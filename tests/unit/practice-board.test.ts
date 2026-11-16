// @vitest-environment jsdom
import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedSubmission } from '../../packages/collaboration/types';
import type { PracticeFamily } from '../../packages/workshop/types';
import type { WorkspaceVoteFamily } from '../../packages/workshop/live-votes';
import { buildPracticeBoardCards, LivePracticeVoting } from '../../apps/web/src/components/workshop/LivePracticeVoting';
import { useLivePracticeVotes } from '../../apps/web/src/hooks/useLivePracticeVotes';

vi.mock('../../apps/web/src/hooks/useLivePracticeVotes', () => ({ useLivePracticeVotes: vi.fn() }));
const familyId = '10000000-0000-4000-8000-000000000001';
const date = '2026-11-17T00:00:00Z';
function publication(id: string, title: string, status: 'shared' | 'withdrawn' = 'shared'): SharedSubmission {
  return { id, sessionId: 'session', authorId: 'author', authorName: 'Автор карточки', localKey: id,
    revision: 1, status, createdAt: date, updatedAt: date,
    bundle: { schemaVersion: 1, practice: { id, familyId: 'author-proposals', regionId: 'moskva', title,
      mechanism: `Исходное содержание: ${title}`, occurrenceIds: [] }, occurrences: [], sources: [], note: '' } };
}
function family(submissionIds: string[], id = familyId): PracticeFamily {
  return { id, title: 'Компенсация платы', mechanism: 'Общий механизм компенсации', rationale: 'Решение участников',
    submissionIds, revision: 1, createdAt: date, updatedAt: date };
}
function vote(id = familyId): WorkspaceVoteFamily {
  return { familyId: id, title: 'Компенсация платы', fingerprint: 'a'.repeat(64), support: 1, oppose: 0,
    unanswered: 1, score: 1, myVote: null, myVoteRevision: 0, needsReview: false };
}
const first = publication('regional-one', 'Первая региональная мера');
const second = publication('regional-two', 'Вторая региональная мера');
const author = publication('author-one', 'Авторское решение');
const withdrawn = publication('withdrawn-one', 'Снятая карточка', 'withdrawn');
const refresh = vi.fn(async () => {});
const saveFamily = vi.fn(async () => {});
function props(groups: PracticeFamily[], entries = [first, second, author], boardRevision = 7) {
  return {
    state: { busy: null, auth: { userId: 'author' }, snapshot: {
      session: { id: 'session', status: 'open', role: 'participant' }, submissions: entries,
    } },
    api: null, workshop: { snapshot: { families: groups, boardRevision, round: null }, busy: false, loading: false,
      error: null, actions: { saveFamily, refresh } },
    manifest: { documents: [{ regionId: 'moskva', territory: 'Москва', textUrl: 'source.json' }] }, onOpenSource: vi.fn(),
  } as unknown as ComponentProps<typeof LivePracticeVoting>;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLivePracticeVotes).mockReturnValue({ data: { families: [vote()] }, loading: false,
    error: null, pendingFamilyId: null, refresh, vote: vi.fn() } as unknown as ReturnType<typeof useLivePracticeVotes>);
});
afterEach(cleanup);

describe('one Practices board', () => {
  it('shows every shared source once while retaining original variants and ungrouped author cards', () => {
    const retired = family([], 'empty-retired-family');
    const group = family([first.id, second.id]);
    const cards = buildPracticeBoardCards([group, retired], [first, second, author, withdrawn], [vote(), vote(retired.id)]);
    expect(cards).toHaveLength(2);
    expect(cards.flatMap(card => card.variants.map(entry => entry.id)).sort()).toEqual([first.id, second.id, author.id].sort());
    expect(cards.find(card => card.family)?.variants).toEqual([first, second]);
    expect(cards.find(card => !card.family)?.title).toBe(author.bundle.practice.title);
    expect(cards.find(card => !card.family)?.vote).toBeNull();
    expect(cards.some(card => card.family?.id === retired.id)).toBe(false);
  });

  it('keeps hidden membership intact and blocks a rename that would otherwise drop a withdrawn source', () => {
    const group = family([first.id, withdrawn.id]);
    const cards = buildPracticeBoardCards([group], [first, withdrawn], [vote()]);
    expect(cards[0].variants).toEqual([first]);
    expect(cards[0].family?.submissionIds).toEqual([first.id, withdrawn.id]);
    render(createElement(LivePracticeVoting, props([group], [first, withdrawn])));
    const variants = screen.getByText('Варианты мер · 1').closest('details')!;
    variants.open = true;
    fireEvent(variants, new Event('toggle'));
    fireEvent.click(screen.getByRole('button', { name: 'Изменить группу' }));
    const dialog = screen.getByRole('dialog', { name: 'Изменить группу' });
    expect((within(dialog).getByRole('button', { name: 'Сохранить группу' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByRole('alert').textContent).toContain('сняты с доски');
    expect(saveFamily).not.toHaveBeenCalled();
  });

  it('preserves a merge draft across board changes and atomically includes all selected source variants', async () => {
    const group = family([first.id, second.id]);
    const mounted = render(createElement(LivePracticeVoting, props([group])));
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать' }));
    fireEvent.click(screen.getByRole('checkbox', { name: `Выбрать: ${group.title}` }));
    fireEvent.click(screen.getByRole('checkbox', { name: `Выбрать: ${author.bundle.practice.title}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Группировать' }));
    const dialog = screen.getByRole('dialog', { name: 'Группировать карточки' });
    const title = within(dialog).getByRole('textbox', { name: 'Название группы' }) as HTMLInputElement;
    const mechanism = within(dialog).getByRole('textbox', { name: 'Общий механизм' }) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: 'Поддержка ухода за детьми' } });
    fireEvent.change(mechanism, { target: { value: 'Участники объединяют меры по снижению расходов на уход.' } });
    mounted.rerender(createElement(LivePracticeVoting, props([group], [first, second, author], 8)));
    expect(title.value).toBe('Поддержка ухода за детьми');
    expect(mechanism.value).toBe('Участники объединяют меры по снижению расходов на уход.');
    expect((within(dialog).getByRole('button', { name: 'Сохранить группу' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Выбрано: 2')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Обновить состав' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить группу' }));
    await waitFor(() => expect(saveFamily).toHaveBeenCalledOnce());
    expect(saveFamily).toHaveBeenCalledWith({ familyId: null, expectedBoardRevision: 8,
      title: 'Поддержка ухода за детьми', mechanism: mechanism.value, rationale: mechanism.value,
      submissionIds: [first.id, second.id, author.id] });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
