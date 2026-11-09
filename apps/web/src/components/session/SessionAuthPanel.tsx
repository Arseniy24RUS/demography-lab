import { useId, useState } from 'react';
import { ArrowRight, BookOpen, LoaderCircle, LogIn } from 'lucide-react';
import type { SessionAreaActions, SessionAreaState } from '../../../../../packages/collaboration/types';
import { messageFromError } from './session-ui';

/** The same two-field identification form is used online and in a local classroom. */
export function SessionAuthPanel({ state, actions }: {
  state: SessionAreaState;
  actions: SessionAreaActions;
}) {
  const id = useId();
  const [email, setEmail] = useState(state.auth.email ?? '');
  const [fullName, setFullName] = useState(state.bootstrap?.profile?.fullName ?? '');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const disabled = working || state.busy !== null;
  const checking = state.auth.status === 'loading' ||
    (state.auth.status === 'signed-in' && !state.bootstrap && !state.error);

  async function perform(action: () => Promise<void>) {
    setError(''); setWorking(true);
    try { await action(); }
    catch (cause) { setError(messageFromError(cause)); }
    finally { setWorking(false); }
  }

  return (
    <section className="session-access" aria-label="Вход в совместную работу">
      <div className="session-access-main">
        {checking ? (
          <div className="session-loading" role="status">
            <LoaderCircle className="session-spinner" size={22} aria-hidden="true" />
            Открываем вашу работу
          </div>
        ) : !state.configured ? (
          <>
            <h2>Совместные занятия ещё не подключены</h2>
            <p>Документы, карточки и ваша локальная тетрадь доступны уже сейчас.</p>
            {state.configurationError ? <p className="session-form-error" role="alert">{state.configurationError}</p> : null}
            <button className="button button-primary" onClick={actions.openLocalWork}>
              Открыть документы <ArrowRight size={17} />
            </button>
          </>
        ) : (
          <>
            <h2>Войти в занятие</h2>
            <p>Введите email и ФИО, чтобы открыть свои занятия и продолжить сохранённую работу.</p>
            <form onSubmit={(event) => {
              event.preventDefault();
              void perform(() => actions.identify({ email: email.trim(), fullName: fullName.trim() }));
            }}>
              <div className="session-field">
                <label htmlFor={`${id}-email`}>Email</label>
                <input id={`${id}-email`} className="session-input" type="email" inputMode="email"
                  autoComplete="email" autoCapitalize="none" spellCheck={false} required maxLength={254}
                  value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.ru"
                  disabled={disabled} aria-describedby={`${id}-email-hint${error ? ` ${id}-error` : ''}`} />
                <p id={`${id}-email-hint`} className="session-hint">Используйте тот же email, чтобы продолжить свою работу в следующий раз.</p>
              </div>
              <div className="session-field">
                <label htmlFor={`${id}-name`}>Фамилия, имя, отчество</label>
                <input id={`${id}-name`} className="session-input" autoComplete="name" required minLength={2}
                  maxLength={200} value={fullName} onChange={(event) => setFullName(event.target.value)}
                  placeholder="Иванов Иван Иванович" disabled={disabled}
                  aria-describedby={`${id}-name-hint${error ? ` ${id}-error` : ''}`} />
                <p id={`${id}-name-hint`} className="session-hint">Отчество — при наличии. ФИО будет подписывать ваши работы.</p>
              </div>
              {error ? <p id={`${id}-error`} className="session-form-error" role="alert">{error}</p> : null}
              <button className="button button-primary block" type="submit"
                disabled={disabled || !email.trim() || fullName.trim().length < 2}>
                {working ? <LoaderCircle className="session-spinner" size={17} /> : <LogIn size={17} />}
                Войти
              </button>
            </form>
          </>
        )}
      </div>
      <aside className="session-access-context">
        <BookOpen size={38} strokeWidth={1.6} aria-hidden="true" />
        <h3>От документа — к общему решению</h3>
        <p>Находите практики в региональных программах, сохраняйте их точные основания и предлагайте группе для обсуждения. Каждая опубликованная карточка сохраняет связь с цитатами и редакцией источника.</p>
        {state.configured ? <button className="button button-secondary" onClick={actions.openLocalWork}>
          Продолжить локальную работу <ArrowRight size={16} />
        </button> : null}
      </aside>
    </section>
  );
}
