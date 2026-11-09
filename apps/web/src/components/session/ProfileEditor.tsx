import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, Save } from 'lucide-react';
import type { SessionAreaActions, SessionProfile } from '../../../../../packages/collaboration/types';
import { Modal } from '../Modal';
import { messageFromError } from './session-ui';

export function ProfileEditor({ profile, email, role, busy, saveProfile, onClose }: {
  profile: SessionProfile;
  email: string | null;
  role: string;
  busy: boolean;
  saveProfile: SessionAreaActions['saveProfile'];
  onClose(): void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const [fullName, setFullName] = useState(profile.fullName);
  const [revision, setRevision] = useState(profile.revision);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const conflict = revision !== profile.revision;
  const disabled = busy || working;
  useEffect(() => () => { request.current += 1; }, []);
  // A disabled submit button can release focus to the document during a failed save.
  // Return to the retained draft once controls become usable again.
  useEffect(() => { if (!disabled) input.current?.focus(); }, [disabled]);

  async function save() {
    const current = ++request.current;
    setWorking(true); setError('');
    try {
      // In the conflict state the primary button explicitly offers to save this variant.
      await saveProfile(fullName.trim(), conflict ? profile.revision : revision);
      if (request.current === current) onClose();
    } catch (cause) {
      if (request.current === current) setError(messageFromError(cause));
    } finally {
      if (request.current === current) setWorking(false);
    }
  }

  return <Modal title="Профиль" onClose={() => { if (!disabled) onClose(); }} actions={<>
    <button className="button button-secondary" type="button" disabled={disabled} onClick={onClose}>Отмена</button>
    <button className="button button-primary" type="submit" form={`${id}-form`}
      disabled={disabled || fullName.trim().length < 2 || fullName.trim() === profile.fullName}>
      {working ? <LoaderCircle className="session-spinner" size={16} aria-hidden="true" />
        : <Save size={16} aria-hidden="true" />}
      {working ? 'Сохраняем…' : conflict ? 'Сохранить мой вариант' : 'Сохранить'}
    </button>
  </>}>
    <div className="profile-editor-meta">
      <span>{role}</span>
      {email ? <strong>{email}</strong> : null}
    </div>
    <form id={`${id}-form`} className="profile-editor-form" onSubmit={(event) => { event.preventDefault(); if (!disabled) void save(); }}>
      <div className="session-field">
        <label htmlFor={`${id}-name`}>Фамилия, имя, отчество</label>
        <input ref={input} id={`${id}-name`} className="session-input" autoComplete="name" required
          minLength={2} maxLength={200} value={fullName} disabled={disabled}
          onChange={(event) => setFullName(event.target.value)}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} />
        <p id={`${id}-hint`} className="session-hint">Сохранённое ФИО используется в вашем профиле и совместной работе.</p>
      </div>
      {conflict ? <div className="profile-editor-conflict" role="status">
        <p>Профиль уже изменён в другом окне. Сейчас сохранено: <strong>{profile.fullName}</strong>.</p>
        <p>Ваш вариант остался в поле. Сравните имена перед сохранением.</p>
        <button className="button button-quiet" type="button" disabled={disabled} onClick={() => {
          setFullName(profile.fullName); setRevision(profile.revision); setError('');
        }}>Использовать сохранённое ФИО</button>
      </div> : null}
      {error ? <p id={`${id}-error`} className="session-form-error" role="alert">{error}</p> : null}
    </form>
  </Modal>;
}
