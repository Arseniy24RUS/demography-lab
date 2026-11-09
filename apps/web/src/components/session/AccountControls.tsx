import { useEffect, useState } from 'react';
import { LoaderCircle, LogIn, LogOut, Pencil } from 'lucide-react';
import type { SessionAreaActions, SessionAreaState } from '../../../../../packages/collaboration/types';
import { ProfileEditor } from './ProfileEditor';

/** One account indicator for the entire workspace, using the current server-backed identity. */
export function AccountControls({ state, actions, onOpenEntry, onSignedOut, onError }: {
  state: SessionAreaState;
  actions: Pick<SessionAreaActions, 'signOut' | 'saveProfile'>;
  onOpenEntry(): void;
  onSignedOut(): void;
  onError(error: unknown): void;
}) {
  const [leaving, setLeaving] = useState(false);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const signedIn = state.auth.status === 'signed-in';
  const loading = state.auth.status === 'loading';
  const profile = state.bootstrap?.profile?.userId === state.auth.userId ? state.bootstrap?.profile : null;
  const name = profile?.fullName ?? state.auth.email ?? 'Ваш профиль';
  const role = profile && (state.bootstrap?.canCreateSession || state.snapshot?.session.role === 'host')
    ? 'Преподаватель'
    : state.snapshot?.session.role === 'observer' ? 'Наблюдатель' : 'Участник';
  const initials = name.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase('ru');
  useEffect(() => { setEditingUser(null); }, [state.auth.userId, state.auth.status]);

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
          <button type="button" className="account-profile" aria-label="Изменить ФИО"
            disabled={!profile || state.busy !== null || leaving}
            onClick={() => setEditingUser(state.auth.userId)}>
            <span className="account-avatar" aria-hidden="true">{initials}</span>
            <span className="account-details">
              <strong className="account-name">{name}</strong>
              <span className="account-meta">
                <span className="account-role">{profile ? role : 'Загружаем профиль…'}</span>
                {profile ? <span className="account-edit"><Pencil size={12} aria-hidden="true" /> Изменить ФИО</span> : null}
              </span>
            </span>
          </button>
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
      {signedIn && editingUser === state.auth.userId && profile ? (
        <ProfileEditor key={state.auth.userId} profile={profile} email={state.auth.email}
          role={role} busy={state.busy !== null} saveProfile={actions.saveProfile}
          onClose={() => setEditingUser(null)} />
      ) : null}
    </div>
  );
}
