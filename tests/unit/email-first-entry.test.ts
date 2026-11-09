// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionAuthPanel } from '../../apps/web/src/components/session/SessionAuthPanel';
import type { SessionAreaActions, SessionAreaState } from '../../packages/collaboration/types';

const state: SessionAreaState = {
  configured: true, configurationError: null, testEnvironment: false,
  auth: { status: 'signed-out', email: null, userId: null },
  bootstrap: null, snapshot: null, invitation: null, connection: 'polling', busy: null,
  error: null, notice: null, initialJoinCode: '', lastSyncedAt: null,
};
function entry(identify = vi.fn<SessionAreaActions['identify']>()) {
  const actions = { identify, openLocalWork: vi.fn() } as unknown as SessionAreaActions;
  return { ...render(createElement(SessionAuthPanel, { state, actions })), identify };
}
afterEach(cleanup);

describe('email-first entry', () => {
  it('shows only email and lets a returning visitor enter without a name prompt', async () => {
    const identify = vi.fn<SessionAreaActions['identify']>().mockResolvedValue({ status: 'signed-in' });
    const view = entry(identify);
    expect(view.container.querySelectorAll('input')).toHaveLength(1);
    expect(screen.queryByLabelText('Фамилия, имя, отчество')).toBeNull();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'returning@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await waitFor(() => expect(identify).toHaveBeenCalledWith({ email: 'returning@example.test' }));
    expect(screen.queryByLabelText('Фамилия, имя, отчество')).toBeNull();
  });

  it('asks for a name only after an unknown email and completes the same normalized email', async () => {
    const identify = vi.fn<SessionAreaActions['identify']>()
      .mockResolvedValueOnce({ status: 'profile-required', email: 'new@example.test' })
      .mockResolvedValueOnce({ status: 'signed-in' });
    const view = entry(identify);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'New@Example.TEST' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('heading', { name: 'Как к вам обращаться?' });
    expect(view.container.querySelectorAll('input')).toHaveLength(1);
    expect(screen.queryByLabelText('Email')).toBeNull();
    const name = screen.getByLabelText('Фамилия, имя, отчество');
    await waitFor(() => expect(document.activeElement).toBe(name));
    fireEvent.change(name, { target: { value: 'Иванова Анна Петровна' } });
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
    await waitFor(() => expect(identify).toHaveBeenLastCalledWith({ email: 'new@example.test', fullName: 'Иванова Анна Петровна' }));
  });

  it('lets a new visitor correct email and removes the unsaved name from that attempt', async () => {
    const identify = vi.fn<SessionAreaActions['identify']>().mockResolvedValue({ status: 'profile-required', email: 'mistake@example.test' });
    entry(identify);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'mistake@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    const name = await screen.findByLabelText('Фамилия, имя, отчество');
    fireEvent.change(name, { target: { value: 'Несохранённое ФИО' } });
    fireEvent.click(screen.getByRole('button', { name: 'Изменить email' }));
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('mistake@example.test');
    expect(document.activeElement).toBe(screen.getByLabelText('Email'));
    expect(screen.queryByLabelText('Фамилия, имя, отчество')).toBeNull();
    expect(identify).toHaveBeenCalledTimes(1);
  });

  it('keeps the name step and draft after a failed first-profile save', async () => {
    const identify = vi.fn<SessionAreaActions['identify']>()
      .mockResolvedValueOnce({ status: 'profile-required', email: 'new@example.test' })
      .mockRejectedValueOnce(new Error('Не удалось сохранить профиль'));
    entry(identify);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    fireEvent.change(await screen.findByLabelText('Фамилия, имя, отчество'), { target: { value: 'Иванов Иван Иванович' } });
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Фамилия, имя, отчество') as HTMLInputElement).value).toBe('Иванов Иван Иванович');
    expect(screen.getByText('new@example.test')).toBeTruthy();
  });
});
