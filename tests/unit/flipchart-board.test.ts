// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlipchartBoard, FlipchartProjector } from '../../apps/web/src/components/flipchart/FlipchartBoard';
import type { FlipchartNote } from '../../packages/flipchart/types';

afterEach(cleanup);
const note = (changes: Partial<FlipchartNote> = {}): FlipchartNote => ({
  id: '11111111-1111-4111-8111-111111111111', kind: 'barrier', text: 'Не хватает мест в яслях',
  status: 'active', createdAt: '2026-11-09T12:00:00.000Z', revision: 1,
  support: 0, oppose: 0, score: 0, myVote: null, myVoteRevision: 0, canWithdraw: true,
  ...changes,
});
const props = (notes: FlipchartNote[] = []) => ({
  notes, onAdd: vi.fn(async () => true), onVote: vi.fn(async () => {}), onWithdraw: vi.fn(async () => {}),
});

describe('live flipchart board', () => {
  it('adds consecutive short theses without a questionnaire or a completion gate', async () => {
    const actions = props();
    render(createElement(FlipchartBoard, actions));
    const input = screen.getByRole('textbox', { name: 'Короткий тезис' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '  Не хватает\nмест в яслях  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(actions.onAdd).toHaveBeenCalledWith('barrier', 'Не хватает мест в яслях'));
    await waitFor(() => expect(input.value).toBe(''));
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByRole('button', { name: 'Что помогло бы?' }));
    fireEvent.change(input, { target: { value: 'Ясли рядом с домом' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(actions.onAdd).toHaveBeenLastCalledWith('condition', 'Ясли рядом с домом'));
    expect(actions.onAdd).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/С какой позиции|согласие|Пропустить|Завершить/)).toBeNull();
  });

  it('preserves an unsent thesis on failure and new typing during a slow acknowledgement', async () => {
    let resolve!: (value: boolean) => void;
    const actions = { ...props(), onAdd: vi.fn(() => new Promise<boolean>(done => { resolve = done; })) };
    render(createElement(FlipchartBoard, actions));
    const input = screen.getByRole('textbox', { name: 'Короткий тезис' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Первый тезис' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions.onAdd).toHaveBeenCalledTimes(1);
    await act(async () => resolve(false));
    expect(input.value).toBe('Первый тезис');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'Второй тезис уже набирается' } });
    await act(async () => resolve(true));
    expect(input.value).toBe('Второй тезис уже набирается');
  });

  it('counts Unicode code points, keeps oversized input intact and ignores an IME Enter', async () => {
    const actions = props();
    render(createElement(FlipchartBoard, actions));
    const input = screen.getByRole('textbox', { name: 'Короткий тезис' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '👶'.repeat(181) } });
    expect(input.value).toBe('👶'.repeat(181));
    expect(screen.getByRole('button', { name: 'Добавить' }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions.onAdd).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '👶'.repeat(180) } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(actions.onAdd).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(actions.onAdd).toHaveBeenCalledWith('barrier', '👶'.repeat(180)));
  });

  it('toggles support off, switches to opposition and preserves complete negative phrases', async () => {
    const current = note({ support: 1, score: 1, myVote: 1, myVoteRevision: 1 });
    const actions = props([current]);
    render(createElement(FlipchartBoard, actions));
    const card = screen.getByRole('article', { name: current.text });
    expect(within(card).getByText(current.text)).toBeTruthy();
    const support = within(card).getByRole('button', { name: `Поддержать: ${current.text}` });
    expect(support.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(support);
    await waitFor(() => expect(actions.onVote).toHaveBeenCalledWith(current, null));
    await waitFor(() => expect(support.hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(card).getByRole('button', { name: `Не поддержать: ${current.text}` }));
    await waitFor(() => expect(actions.onVote).toHaveBeenLastCalledWith(current, -1));
    expect(within(card).queryByText(/ФИО|Автор/)).toBeNull();
  });

  it('keeps cloud order stable on votes and sorts the separate ranking by the balance', () => {
    const first = note();
    const second = note({ id: '22222222-2222-4222-8222-222222222222', text: 'Работа рядом с домом', kind: 'condition', createdAt: '2026-11-09T12:01:00.000Z' });
    const actions = props([first, second]);
    const mounted = render(createElement(FlipchartBoard, actions));
    expect(screen.getAllByRole('article').map(article => article.getAttribute('aria-label'))).toEqual([second.text, first.text]);
    mounted.rerender(createElement(FlipchartBoard, { ...actions, notes: [{ ...first, support: 5, oppose: 1, score: 4 }, second] }));
    expect(screen.getAllByRole('article').map(article => article.getAttribute('aria-label'))).toEqual([second.text, first.text]);
    const modes = screen.getByRole('group', { name: 'Вид флипчарта' });
    fireEvent.click(within(modes).getByRole('button', { name: 'Рейтинг' }));
    expect(screen.getAllByRole('article').map(article => article.getAttribute('aria-label'))).toEqual([first.text, second.text]);
    expect(screen.getByLabelText('Баланс: +4')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Тезисы по теме' })).getByRole('button', { name: /Помогло бы/ }));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('article', { name: second.text })).toBeTruthy();
  });

  it('animates only new arrivals and never exposes private controls in projector mode', async () => {
    const first = note();
    const mounted = render(createElement(FlipchartProjector, { notes: [first] }));
    expect(screen.getByRole('article', { name: first.text }).hasAttribute('data-new')).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Убрать стикер|Поддержать:|Не поддержать:/ })).toBeNull();
    const second = note({ id: '22222222-2222-4222-8222-222222222222', text: 'Доступное жильё' });
    mounted.rerender(createElement(FlipchartProjector, { notes: [first, second] }));
    await waitFor(() => expect(screen.getByRole('article', { name: second.text }).getAttribute('data-new')).toBe('true'));
    expect(screen.getByRole('article', { name: first.text }).hasAttribute('data-new')).toBe(false);
  });

  it('shows withdrawal only where allowed and excludes withdrawn notes from the board', async () => {
    const own = note();
    const other = note({ id: '22222222-2222-4222-8222-222222222222', text: 'Длинный путь до поликлиники', canWithdraw: false });
    const withdrawn = note({ id: '33333333-3333-4333-8333-333333333333', text: 'Снятый тезис', status: 'withdrawn' });
    const actions = props([own, other, withdrawn]);
    render(createElement(FlipchartBoard, actions));
    expect(screen.queryByRole('article', { name: withdrawn.text })).toBeNull();
    expect(screen.queryByRole('button', { name: `Убрать стикер: ${other.text}` })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Убрать стикер: ${own.text}` }));
    await waitFor(() => expect(actions.onWithdraw).toHaveBeenCalledWith(own));
  });
});
