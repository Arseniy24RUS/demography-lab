import { useEffect, useId, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, LoaderCircle, Mail, ShieldCheck } from 'lucide-react';
import type {
  SessionAreaActions,
  SessionAreaState,
} from '../../../../../packages/collaboration/types';
import { messageFromError } from './session-ui';
import { OfflineAuthPanel } from './OfflineAuthPanel';

export function SessionAuthPanel({
  state,
  actions,
}: {
  state: SessionAreaState;
  actions: SessionAreaActions;
}) {
  const id = useId();
  const [email, setEmail] = useState(state.auth.email ?? '');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now());

  useEffect(() => {
    if (!state.auth.resendAvailableAt) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.auth.resendAvailableAt]);

  const resendSeconds = Math.max(0, Math.ceil((state.auth.resendAvailableAt - clock) / 1000));
  const disabled = working || state.busy !== null;
  const checking =
    state.auth.status === 'loading' || (state.auth.status === 'signed-in' && !state.bootstrap);

  async function perform(action: () => Promise<void>) {
    setError('');
    setWorking(true);
    try {
      await action();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setWorking(false);
    }
  }

  const errorNode = error ? (
    <p id={`${id}-error`} className="session-form-error" role="alert">
      {error}
    </p>
  ) : null;

  if (state.offline && !checking && state.auth.status !== 'signed-in')
    return <OfflineAuthPanel state={state} actions={actions} />;

  return (
    <section className="session-access" aria-label="Вход в совместную работу">
      <div className="session-access-main">
        {checking ? (
          <div className="session-loading" role="status">
            <LoaderCircle className="session-spinner" size={22} aria-hidden="true" />
            Проверяем доступ
          </div>
        ) : !state.configured ? (
          <>
            <h2>Совместные занятия ещё не подключены</h2>
            <p>
              Для входа по email и общей доски требуется подключение учебной платформы. Документы,
              карточки и ваша локальная тетрадь доступны уже сейчас.
            </p>
            {state.configurationError ? (
              <p className="session-form-error" role="alert">
                {state.configurationError}
              </p>
            ) : null}
            <button className="button button-primary" onClick={actions.openLocalWork}>
              Открыть документы <ArrowRight size={17} />
            </button>
          </>
        ) : state.auth.status === 'signed-in' ? (
          <>
            <h2>Представьтесь участникам</h2>
            <p>
              {state.offline ? 'Укажите имя, которым будут подписаны ваши публикации на общей доске.' :
                'Адрес подтверждён. Укажите имя, которым будут подписаны ваши публикации на общей доске.'}
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform(() => actions.saveProfile(name.trim()));
              }}
            >
              <div className="session-field">
                <label htmlFor={`${id}-name`}>Фамилия, имя, отчество</label>
                <input
                  id={`${id}-name`}
                  className="session-input"
                  autoComplete="name"
                  autoFocus
                  required
                  minLength={3}
                  maxLength={160}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={disabled}
                  aria-describedby={`${id}-name-hint${error ? ` ${id}-error` : ''}`}
                />
                <p id={`${id}-name-hint`} className="session-hint">
                  Отчество — при наличии.
                </p>
              </div>
              {errorNode}
              <button
                className="button button-primary block"
                type="submit"
                disabled={disabled || name.trim().length < 3}
              >
                {working ? (
                  <LoaderCircle className="session-spinner" size={17} />
                ) : (
                  <ShieldCheck size={17} />
                )}
                Сохранить профиль
              </button>
              {state.auth.email ? (
                <p className="session-hint session-form-footer">
                  Email {state.auth.email} виден только вам.
                </p>
              ) : null}
              <button
                type="button"
                className="button button-quiet"
                disabled={disabled}
                onClick={() => void perform(actions.signOut)}
              >
                Войти с другим адресом
              </button>
            </form>
          </>
        ) : state.auth.status === 'awaiting-code' ? (
          <>
            <h2>Проверьте почту</h2>
            <p>Введите одноразовый код из письма на {state.auth.email}.</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform(() => actions.verifyCode(code.trim()));
              }}
            >
              <div className="session-field">
                <label htmlFor={`${id}-code`}>Код из письма</label>
                <input
                  id={`${id}-code`}
                  className="session-input session-input-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  pattern="[0-9]{6,8}"
                  minLength={6}
                  maxLength={8}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  disabled={disabled}
                  aria-describedby={error ? `${id}-error` : undefined}
                />
              </div>
              {errorNode}
              <button
                className="button button-primary block"
                type="submit"
                disabled={disabled || code.length < 6}
              >
                {working ? <LoaderCircle className="session-spinner" size={17} /> : null}Подтвердить
                адрес
              </button>
              <div className="session-action-row session-form-footer">
                <button
                  className="button button-quiet"
                  type="button"
                  disabled={disabled || resendSeconds > 0 || !state.auth.email}
                  onClick={() => void perform(() => actions.sendCode(state.auth.email ?? email))}
                >
                  {resendSeconds > 0 ? `Повторить через ${resendSeconds} с` : 'Запросить новый код'}
                </button>
                <button
                  className="button button-quiet"
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    actions.changeEmail();
                    setError('');
                    setCode('');
                  }}
                >
                  <ArrowLeft size={16} /> Другой адрес
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <h2>Войти в занятие</h2>
            <p>
              Укажите email, чтобы сохранить авторство работ и продолжить на другом устройстве. На
              почту придёт одноразовый код.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform(() => actions.sendCode(email.trim()));
              }}
            >
              <div className="session-field">
                <label htmlFor={`${id}-email`}>Email</label>
                <input
                  id={`${id}-email`}
                  className="session-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={254}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@example.ru"
                  disabled={disabled}
                  aria-describedby={`${id}-email-hint${error ? ` ${id}-error` : ''}`}
                />
                <p id={`${id}-email-hint`} className="session-hint">
                  Другие участники и экран проектора не показывают ваш email.
                </p>
              </div>
              {errorNode}
              <button
                className="button button-primary block"
                type="submit"
                disabled={disabled || !email.trim()}
              >
                {working ? (
                  <LoaderCircle className="session-spinner" size={17} />
                ) : (
                  <Mail size={17} />
                )}
                Получить код
              </button>
            </form>
          </>
        )}
      </div>
      <aside className="session-access-context">
        <BookOpen size={38} strokeWidth={1.6} aria-hidden="true" />
        <h3>От документа — к общему решению</h3>
        <p>
          Находите практики в региональных программах, сохраняйте их точные основания и предлагайте
          группе для обсуждения. Каждая опубликованная карточка сохраняет связь с цитатами и
          редакцией источника.
        </p>
        {state.configured ? (
          <button className="button button-secondary" onClick={actions.openLocalWork}>
            Продолжить локальную работу <ArrowRight size={16} />
          </button>
        ) : null}
      </aside>
    </section>
  );
}
