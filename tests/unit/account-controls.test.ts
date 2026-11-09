// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountControls } from '../../apps/web/src/components/session/AccountControls';
import type { SessionAreaState } from '../../packages/collaboration/types';

const base: SessionAreaState = {
  configured: true, configurationError: null, testEnvironment: false,
  auth: { status: 'signed-out', email: null, userId: null },
  bootstrap: null, snapshot: null, invitation: null, connection: 'polling', busy: null,
  error: null, notice: null, initialJoinCode: '', lastSyncedAt: null,
};
function signedIn(fullName: string, teacher = false): SessionAreaState {
  return {
    ...base,
    auth: { status: 'signed-in', email: 'example@example.test', userId: fullName },
    bootstrap: { profile: { userId: fullName, fullName, revision: 1 }, canCreateSession: teacher, sessions: [] },
  };
}
function props(state = base) {
  return { state, actions: { signOut: vi.fn().mockResolvedValue(undefined), saveProfile: vi.fn().mockResolvedValue(undefined) },
    onOpenEntry: vi.fn(), onSignedOut: vi.fn(), onError: vi.fn() };
}
afterEach(cleanup);

describe('shared workspace account controls', () => {
  it('opens the common entry screen from a signed-out header', () => {
    const p = props();
    render(createElement(AccountControls, p));
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(p.onOpenEntry).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Выйти' })).toBeNull();
  });

  it('uses actual server profile and role and replaces them on account switch', () => {
    const p = props(signedIn('Ситковский Арсений Михайлович', true));
    const view = render(createElement(AccountControls, p));
    expect(screen.getByText('Ситковский Арсений Михайлович')).toBeTruthy();
    expect(screen.getByText('Преподаватель')).toBeTruthy();
    view.rerender(createElement(AccountControls, { ...p, state: signedIn('Иванова Анна Петровна') }));
    expect(screen.queryByText('Ситковский Арсений Михайлович')).toBeNull();
    expect(screen.queryByText('Преподаватель')).toBeNull();
    expect(screen.getByText('Иванова Анна Петровна')).toBeTruthy();
    expect(screen.getByText('Участник')).toBeTruthy();
  });

  it('waits for logout to complete before returning to the common entry screen', async () => {
    let complete!: () => void;
    const p = props(signedIn('Иванов Иван Иванович'));
    p.actions.signOut.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    render(createElement(AccountControls, p));
    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(p.actions.signOut).toHaveBeenCalledOnce();
    expect(p.onSignedOut).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Выходим…' }) as HTMLButtonElement).disabled).toBe(true);
    complete();
    await waitFor(() => expect(p.onSignedOut).toHaveBeenCalledOnce());
  });

  it('keeps identity visible and reports a failed logout instead of claiming success', async () => {
    const p = props(signedIn('Иванов Иван Иванович'));
    const cause = new Error('Сервер недоступен');
    p.actions.signOut.mockRejectedValue(cause);
    render(createElement(AccountControls, p));
    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    await waitFor(() => expect(p.onError).toHaveBeenCalledWith(cause));
    expect(p.onSignedOut).not.toHaveBeenCalled();
    expect(screen.getByText('Иванов Иван Иванович')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Выйти' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers logout during profile recovery and hides old identity after sign-out', () => {
    const p = props({ ...base, auth: { status: 'signed-in', email: 'returning@example.test', userId: 'id' } });
    const view = render(createElement(AccountControls, p));
    expect(screen.getByText('returning@example.test')).toBeTruthy();
    expect(screen.getByText('Загружаем профиль…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeTruthy();
    view.rerender(createElement(AccountControls, { ...p, state: base }));
    expect(screen.queryByText('returning@example.test')).toBeNull();
    expect(screen.getByRole('button', { name: 'Войти' })).toBeTruthy();
  });

  it('opens the saved name for editing, cancels unchanged, and saves an explicit revision', async () => {
    const p = props(signedIn('Иванов Иван Иванович', true));
    render(createElement(AccountControls, p));
    fireEvent.click(screen.getByRole('button', { name: 'Изменить ФИО' }));
    const input = screen.getByLabelText('Фамилия, имя, отчество') as HTMLInputElement;
    expect(input.value).toBe('Иванов Иван Иванович');
    fireEvent.change(input, { target: { value: 'Черновик имени' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(p.actions.saveProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Изменить ФИО' }));
    expect((screen.getByLabelText('Фамилия, имя, отчество') as HTMLInputElement).value).toBe('Иванов Иван Иванович');
    fireEvent.change(screen.getByLabelText('Фамилия, имя, отчество'), { target: { value: 'Иванов Пётр Иванович' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(p.actions.saveProfile).toHaveBeenCalledWith('Иванов Пётр Иванович', 1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('retains a failed edit and compares a changed server profile before an explicit retry', async () => {
    const p = props(signedIn('Иванов Иван Иванович'));
    p.actions.saveProfile.mockRejectedValueOnce(new Error('Профиль изменён в другом окне.'));
    const view = render(createElement(AccountControls, p));
    fireEvent.click(screen.getByRole('button', { name: 'Изменить ФИО' }));
    fireEvent.change(screen.getByLabelText('Фамилия, имя, отчество'), { target: { value: 'Мой вариант ФИО' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('другом окне'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Фамилия, имя, отчество')));
    const updated = { ...p.state, bootstrap: { ...p.state.bootstrap!,
      profile: { ...p.state.bootstrap!.profile!, fullName: 'Изменение в другом окне', revision: 2 } } };
    view.rerender(createElement(AccountControls, { ...p, state: updated }));
    expect((screen.getByLabelText('Фамилия, имя, отчество') as HTMLInputElement).value).toBe('Мой вариант ФИО');
    expect(screen.getByRole('status').textContent).toContain('Изменение в другом окне');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить мой вариант' }));
    await waitFor(() => expect(p.actions.saveProfile).toHaveBeenLastCalledWith('Мой вариант ФИО', 2));
  });

  it('closes a profile editor immediately on logout or a different identity', () => {
    const p = props(signedIn('Первый участник'));
    const view = render(createElement(AccountControls, p));
    fireEvent.click(screen.getByRole('button', { name: 'Изменить ФИО' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    view.rerender(createElement(AccountControls, { ...p, state: signedIn('Другой участник') }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Первый участник')).toBeNull();
  });
});
