import { useEffect, useId, useState } from 'react';
import { Settings2 } from 'lucide-react';
import type { SessionAreaActions, SessionRegionOption, SessionScope, SessionSummary } from '../../../../../packages/collaboration/types';
import { messageFromError, scopeLabels } from './session-ui';

export function HostControls({ session, busy, actions, regions }: {
  session: SessionSummary;
  busy: boolean;
  actions: SessionAreaActions;
  regions: SessionRegionOption[];
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [scope, setScope] = useState<SessionScope>(session.scope);
  const [regionId, setRegionId] = useState(session.regionId ?? 'respublika-mordoviia');
  const [revision, setRevision] = useState(session.revision);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) return;
    setTitle(session.title);
    setScope(session.scope);
    setRegionId(session.regionId ?? 'respublika-mordoviia');
    setRevision(session.revision);
    setError('');
  }, [open, session.id, session.title, session.scope, session.regionId, session.revision]);
  const disabled = busy || working;
  async function save() {
    if (!actions.configureWorkspace) return;
    setWorking(true);
    setError('');
    try {
      await actions.configureWorkspace({ title: title.trim(), scope, regionId: scope === 'federal' ? null : regionId }, revision);
      setOpen(false);
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setWorking(false);
    }
  }
  return <details className="workspace-settings" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Settings2 size={16} aria-hidden="true" />Параметры мастерской</summary>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="workspace-settings-fields">
        <label htmlFor={`${id}-title`}>Название
          <input id={`${id}-title`} className="session-input" value={title} minLength={2} maxLength={160}
            required disabled={disabled} onChange={event => setTitle(event.target.value)} />
        </label>
        <label htmlFor={`${id}-scope`}>Уровень работы
          <select id={`${id}-scope`} className="session-input" value={scope} disabled={disabled}
            onChange={event => setScope(event.target.value as SessionScope)}>
            {(Object.keys(scopeLabels) as SessionScope[]).map(value => <option key={value} value={value}>{scopeLabels[value]}</option>)}
          </select>
        </label>
        {scope !== 'federal' ? <label htmlFor={`${id}-region`}>Регион
          <select id={`${id}-region`} className="session-input" value={regionId} disabled={disabled}
            onChange={event => setRegionId(event.target.value)}>
            {regions.filter(region => region.id !== 'federal' && region.id !== 'unknown').map(region =>
              <option key={region.id} value={region.id}>{region.name}</option>)}
          </select>
        </label> : null}
      </div>
      {error ? <p className="session-form-error" role="alert">{error}</p> : null}
      <div className="session-action-row">
        <button type="submit" className="button button-primary" disabled={disabled || !actions.configureWorkspace || title.trim().length < 2}>Сохранить параметры</button>
        <button type="button" className="button button-quiet" disabled={working} onClick={() => setOpen(false)}>Отмена</button>
        <label className="session-checkbox">
          <input type="checkbox" checked={session.projectorShowAuthors} disabled={disabled}
            onChange={event => void actions.updateSession({ projectorShowAuthors: event.target.checked }, session.revision).catch(cause => setError(messageFromError(cause)))} />
          Авторы на проекторе
        </label>
      </div>
    </form>
  </details>;
}
