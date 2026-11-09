import { useState } from 'react';
import { LoaderCircle, LogIn, LogOut } from 'lucide-react';
import type { SessionAreaActions, SessionAreaState } from '../../../../../packages/collaboration/types';

/** One account indicator for the entire workspace, using the current server-backed identity. */
export function AccountControls({ state, actions, onOpenEntry, onSignedOut, onError }: {
  state: SessionAreaState;
  actions: Pick<SessionAreaActions, 'signOut'>;
  onOpenEntry(): void;
  onSignedOut(): void;
  onError(error: unknown): void;
}) {
  const [leaving, setLeaving] = useState(false);
  const signedIn = state.auth.status === 'signed-in';
  const loading = state.auth.status === 'loading';
  const name = state.bootstrap?.profile?.fullName ?? state.auth.email ?? 'Ваш профиль';
  const role = state.bootstrap?.canCreateSession || state.snapshot?.session.role === 'host'
    ? 'Преподаватель'
    : state.snapshot?.session.role === 'observer' ? 'Наблюдатель' : 'Участник';
  const initials = name.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase('ru');

  async function signOut() {
    setLeaving(true);
    try {
      await actions.signOut();
      onSignedOut();
    } catch (cause) {
      onError(cause);
    } finally {
      setLeaving(false);
    }
  }

  return (
    <div className="header-account" aria-label="Ваш профиль">
      {signedIn ? (
        <>
          <span className="account-avatar" aria-hidden="true">{initials}</span>
          <div className="account-details">
            <strong className="account-name">{name}</strong>
            <span className="account-role">{state.bootstrap ? role : 'Загружаем профиль…'}</span>
          </div>
          <button className="button button-secondary account-sign-out" type="button"
            disabled={leaving || state.busy !== null} onClick={() => void signOut()}>
            {leaving ? <LoaderCircle className="session-spinner" size={16} aria-hidden="true" />
              : <LogOut size={16} aria-hidden="true" />}
            <span>{leaving ? 'Выходим…' : 'Выйти'}</span>
          </button>
        </>
      ) : (
        <button className="button button-secondary account-sign-in" type="button"
          disabled={loading || state.busy !== null} onClick={onOpenEntry}>
          {loading ? <LoaderCircle className="session-spinner" size={17} aria-hidden="true" />
            : <LogIn size={17} aria-hidden="true" />}
          {loading ? 'Проверяем вход…' : 'Войти'}
        </button>
      )}
    </div>
  );
}
