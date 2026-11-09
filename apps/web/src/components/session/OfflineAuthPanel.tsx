import { useId, useRef, useState } from 'react';
import { ArrowRight, Download, HardDrive, KeyRound, Laptop, LoaderCircle, Upload } from 'lucide-react';
import type { SessionAreaActions, SessionAreaState } from '../../../../../packages/collaboration/types';
import { beginLocalRegistration, downloadLocalReceipt, keepLocalReceipt, readLocalReceipt, readPendingRegistration,
  type LocalAccessReceipt, type PendingLocalRegistration } from '../../lib/offline-api';
import { messageFromError } from './session-ui';

export function OfflineAuthPanel({ state, actions }: { state: SessionAreaState; actions: SessionAreaActions }) {
  const id = useId();
  const local = state.offline!;
  const [resume] = useState(() => ({ receipt: readLocalReceipt(local.instanceId), pending: readPendingRegistration(local.instanceId) }));
  const [email, setEmail] = useState(resume.pending?.identity.email ?? '');
  const [name, setName] = useState(resume.pending?.identity.fullName ?? '');
  const [code, setCode] = useState(() => new URLSearchParams(location.hash.slice(1)).get('network') ?? '');
  const [recovery, setRecovery] = useState('');
  const [mode, setMode] = useState<'register' | 'recover'>(resume.receipt && !resume.pending ? 'recover' : 'register');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<LocalAccessReceipt | null>(resume.receipt);
  const [pending, setPending] = useState<PendingLocalRegistration | null>(resume.pending);
  const fileInput = useRef<HTMLInputElement>(null);
  const disabled = busy || Boolean(state.busy);
  async function perform(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); } catch (cause) { setError(messageFromError(cause)); }
    finally { setBusy(false); }
  }
  async function register() {
    const input = { email: email.trim().toLowerCase(), fullName: name.trim(), joinCode: code.trim() };
    const next = beginLocalRegistration(local.instanceId, local.url, input);
    setPending(next.pending);
    // A durable pending receipt does not overwrite an existing account. Repeating
    // this identity after a lost response or a corrected code uses the same secret.
    if (!next.persisted) downloadLocalReceipt(next.pending.receipt);
    await actions.localRegister!({ ...input, recoverySecret: next.pending.receipt.recoverySecret });
    setReceipt(next.pending.receipt); setPending(null);
  }
  async function recover(secret = recovery.trim()) {
    if (!/^[a-f\d]{64}$/u.test(secret)) throw new Error('Личный ключ должен содержать 64 символа. Загрузите файл квитанции или скопируйте ключ целиком.');
    await actions.localRecover!(secret);
    const next: LocalAccessReceipt = { format: 'demography-local-access-1', instanceId: local.instanceId,
      serverUrl: local.url, recoverySecret: secret };
    setReceipt(next);
    if (!keepLocalReceipt(next)) downloadLocalReceipt(next);
  }
  return (
    <section className="session-access offline-access" aria-label="Вход в локальный семинар">
      <div className="session-access-main">
        <span className="offline-eyebrow"><HardDrive size={16} /> Локальная мастерская</span>
        <h2>{mode === 'register' ? 'Подключиться к семинару' : 'Вернуться к своей работе'}</h2>
        <p>{mode === 'register'
          ? 'Подключитесь к Wi-Fi аудитории и представьтесь. Все участники работают с общей базой на Mac преподавателя.'
          : 'Загрузите личную квитанцию или введите ключ доступа. Ваши публикации и участие в команде сохранятся.'}</p>
        <div className="offline-mode-switch" role="group" aria-label="Способ входа">
          <button className="button" aria-pressed={mode === 'register'} onClick={() => { setMode('register'); setError(''); }} disabled={disabled}>Первый вход</button>
          <button className="button" aria-pressed={mode === 'recover'} onClick={() => { setMode('recover'); setError(''); }} disabled={disabled}>Восстановить доступ</button>
        </div>
        {mode === 'register' ? (
          <form onSubmit={(event) => { event.preventDefault(); void perform(register); }}>
            <div className="session-field"><label htmlFor={`${id}-name`}>Фамилия, имя, отчество</label>
              <input id={`${id}-name`} className="session-input" autoComplete="name" minLength={3} maxLength={160} required
                value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} /></div>
            <div className="session-field"><label htmlFor={`${id}-email`}>Email</label>
              <input id={`${id}-email`} className="session-input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" maxLength={254} required
                value={email} onChange={(e) => setEmail(e.target.value)} disabled={disabled} aria-describedby={`${id}-email-hint`} />
              <p id={`${id}-email-hint`} className="session-hint">Адрес записывается с ваших слов. Письмо не отправляется; email не является ключом доступа.</p></div>
            <div className="session-field"><label htmlFor={`${id}-network`}>Код локальной сети семинара</label>
              <input id={`${id}-network`} className="session-input session-input-code" autoComplete="off" maxLength={80} required value={code}
                onChange={(e) => setCode(e.target.value)} disabled={disabled} aria-describedby={`${id}-code-hint`} />
              <p id={`${id}-code-hint`} className="session-hint">Код показывает преподаватель. При входе по QR он заполняется автоматически.</p></div>
            <button className="button button-primary block" disabled={disabled} type="submit">
              {disabled ? <LoaderCircle className="session-spinner" size={17} /> : <ArrowRight size={17} />} Войти в локальный семинар
            </button>
          </form>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void perform(() => recover()); }}>
            <input type="file" accept=".json,application/json" ref={fileInput} hidden onChange={(event) => {
              const file = event.target.files?.[0]; event.target.value = '';
              if (!file) return;
              void perform(async () => {
                if (file.size > 16384) throw new Error('Это не файл личного ключа доступа.');
                const value = JSON.parse(await file.text()) as LocalAccessReceipt;
                if (value.format !== 'demography-local-access-1' || value.instanceId !== local.instanceId)
                  throw new Error('Квитанция относится к другому локальному семинару.');
                setRecovery(value.recoverySecret); await recover(value.recoverySecret);
              });
            }} />
            <button className="button button-secondary block" type="button" disabled={disabled} onClick={() => fileInput.current?.click()}><Upload size={17} /> Загрузить квитанцию</button>
            <div className="session-field"><label htmlFor={`${id}-recovery`}>Личный ключ доступа</label>
              <input id={`${id}-recovery`} className="session-input" type="password" autoComplete="off" minLength={64} maxLength={64}
                value={recovery} onChange={(e) => setRecovery(e.target.value.trim().toLowerCase())} disabled={disabled} /></div>
            <button className="button button-primary block" disabled={disabled || recovery.length !== 64} type="submit"><KeyRound size={17} /> Восстановить доступ</button>
            {receipt ? <button className="button button-quiet" type="button" disabled={disabled}
              onClick={() => void perform(() => recover(receipt.recoverySecret))}>Продолжить с сохранённым ключом этого браузера</button> : null}
          </form>
        )}
        {error ? <p className="session-form-error" role="alert">{error}</p> : null}
        {pending ? <p className="session-hint">Предыдущая попытка подключения сохранена. Повторный вход с теми же ФИО и email использует тот же личный ключ, даже если ответ Mac потерялся.</p> : null}
        {pending ? <button className="button button-quiet" onClick={() => downloadLocalReceipt(pending.receipt)}><Download size={16} /> Скачать ключ попытки подключения</button> : null}
        {receipt ? <button className="button button-quiet" onClick={() => downloadLocalReceipt(receipt)}><Download size={16} /> Скачать личный ключ доступа</button> : null}
      </div>
      <aside className="session-access-context">
        <HardDrive size={38} strokeWidth={1.6} aria-hidden="true" />
        <h3>Одна аудитория — общая работа</h3>
        <p>Документы, коллективные доски, голосования и дорожные карты доступны без интернета. Сохраняйте личный ключ, чтобы продолжить с другого устройства.</p>
        <p className="session-hint">Не передавайте свою квитанцию другим участникам. При восстановлении доступа прежний вход закрывается.</p>
        {local.hostAvailable ? <button className="button button-primary" disabled={disabled}
          onClick={() => void perform(actions.localHost!)}><Laptop size={18} /> Открыть кабинет преподавателя</button> : null}
        {local.hostAvailable ? <p className="session-hint">Кнопка доступна непосредственно на Mac, где запущен сервер.</p> : null}
        <button className="button button-secondary" onClick={actions.openLocalWork}>Открыть документы <ArrowRight size={16} /></button>
      </aside>
    </section>
  );
}
