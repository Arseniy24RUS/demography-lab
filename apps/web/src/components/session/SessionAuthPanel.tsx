import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, LoaderCircle, LogIn } from 'lucide-react';
import type { SessionAreaActions, SessionAreaState } from '../../../../../packages/collaboration/types';
import { messageFromError } from './session-ui';

/** Email is sufficient for returning visitors; only a first visit asks for the name. */
export function SessionAuthPanel({ state, actions }: {
  state: SessionAreaState;
  actions: SessionAreaActions;
}) {
  const id = useId();
  const [email, setEmail] = useState(state.auth.email ?? '');
  const [profileEmail, setProfileEmail] = useState<string | null>(null);
  const [fullName, setFullName] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const emailInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const attempt = useRef(0);
  const pending = useRef(false);
  const disabled = working || state.busy !== null;
  const checking = state.auth.status === 'loading' ||
    (state.auth.status === 'signed-in' && !state.bootstrap && !state.error);
  useEffect(() => () => { attempt.current += 1; }, []);
  useEffect(() => {
    if (!checking && !disabled && state.configured) (profileEmail ? nameInput : emailInput).current?.focus();
  }, [checking, disabled, profileEmail, state.configured]);

  async function identify() {
    if (pending.current) return;
    pending.current = true;
    const request = ++attempt.current;
    setError(''); setWorking(true);
    try {
      const result = await actions.identify(profileEmail
        ? { email: profileEmail, fullName: fullName.trim() }
        : { email: email.trim() });
      if (attempt.current !== request) return;
      if (result.status === 'profile-required') {
        setEmail(result.email);
        setProfileEmail(result.email);
        setFullName('');
      }
    } catch (cause) {
      if (attempt.current === request) setError(messageFromError(cause));
    } finally {
      if (attempt.current === request) { pending.current = false; setWorking(false); }
    }
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
            <h2>{profileEmail ? 'Как к вам обращаться?' : 'Войти в занятие'}</h2>
            <p>{profileEmail
              ? 'Укажите ФИО для своих работ. При следующих входах достаточно будет email.'
              : 'Введите свой email, чтобы открыть занятия и продолжить сохранённую работу.'}</p>
            <form onSubmit={(event) => {
              event.preventDefault();
              if (!disabled) void identify();
            }}>
              {!profileEmail ? <div className="session-field">
                <label htmlFor={`${id}-email`}>Email</label>
                <input ref={emailInput} id={`${id}-email`} className="session-input" type="email" inputMode="email"
                  autoComplete="email" autoCapitalize="none" spellCheck={false} required maxLength={254}
                  value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.ru"
                  disabled={disabled} aria-describedby={`${id}-email-hint${error ? ` ${id}-error` : ''}`} />
                <p id={`${id}-email-hint`} className="session-hint">Используйте тот же email, чтобы продолжить свою работу в следующий раз.</p>
              </div> : <>
              <div className="session-entry-email">
                <strong>{profileEmail}</strong>
                <button type="button" className="button button-quiet" disabled={disabled} onClick={() => {
                  attempt.current += 1;
                  setProfileEmail(null); setFullName(''); setError('');
                }}><ArrowLeft size={15} aria-hidden="true" /> Изменить email</button>
              </div>
              <div className="session-field">
                <label htmlFor={`${id}-name`}>Фамилия, имя, отчество</label>
                <input ref={nameInput} id={`${id}-name`} className="session-input" autoComplete="name" required minLength={2}
                  maxLength={200} value={fullName} onChange={(event) => setFullName(event.target.value)}
                  placeholder="Иванов Иван Иванович" disabled={disabled}
                  aria-describedby={`${id}-name-hint${error ? ` ${id}-error` : ''}`} />
                <p id={`${id}-name-hint`} className="session-hint">Отчество — при наличии. ФИО будет подписывать ваши работы.</p>
              </div>
              </>}
              {error ? <p id={`${id}-error`} className="session-form-error" role="alert">{error}</p> : null}
              <button className="button button-primary block" type="submit"
                disabled={disabled || !email.trim() || (profileEmail !== null && fullName.trim().length < 2)}>
                {working ? <LoaderCircle className="session-spinner" size={17} /> : <LogIn size={17} />}
                {profileEmail ? 'Продолжить' : 'Войти'}
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
