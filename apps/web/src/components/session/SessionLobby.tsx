import { useId, useState } from 'react';
import { ArrowRight, BookOpen, LogIn, Plus, RefreshCw } from 'lucide-react';
import { Modal } from '@/components/Modal';
import type {
  SessionAreaActions,
  SessionAreaState,
  SessionRegionOption,
  SessionScope,
} from '../../../../../packages/collaboration/types';
import {
  dateLabel,
  messageFromError,
  phaseLabels,
  roleLabels,
  scopeLabels,
  statusLabels,
} from './session-ui';

export function SessionLobby({
  state,
  actions,
  regions,
}: {
  state: SessionAreaState;
  actions: SessionAreaActions;
  regions: SessionRegionOption[];
}) {
  const id = useId();
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState<SessionScope>('municipality');
  const [regionId, setRegionId] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const disabled = working || state.busy !== null;
  const sessions = state.bootstrap?.sessions ?? [];
  const available = (state.availableSessions ?? []).filter((item) => !sessions.some((mine) => mine.id === item.id));
  const regionNames = new Map(regions.map((region) => [region.id, region.name]));

  async function create() {
    setError('');
    setWorking(true);
    try {
      await actions.createSession({
        title: title.trim(),
        scope,
        regionId: scope === 'federal' ? null : regionId,
      });
      setCreateOpen(false);
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <div className="session-lobby">
        <section aria-labelledby={`${id}-sessions`}>
          <div className="session-section-heading">
            <h2 id={`${id}-sessions`}>Ваши занятия</h2>
            <button
              className="button button-quiet"
              disabled={disabled}
              onClick={() => void actions.refresh().catch(() => undefined)}
            >
              <RefreshCw size={16} /> Обновить
            </button>
          </div>
          {sessions.length ? (
            <div className="session-list">
              {sessions.map((session) => (
                <article className="session-list-entry" key={session.id}>
                  <div>
                    <h3>{session.title}</h3>
                    <div className="session-inline-meta">
                      <span>{roleLabels[session.role]}</span>
                      <span>
                        {session.regionId
                          ? (regionNames.get(session.regionId) ?? session.regionId)
                          : 'Российская Федерация'}
                      </span>
                      <span>{statusLabels[session.status]}</span>
                    </div>
                    <p className="session-hint session-list-date">
                      {phaseLabels[session.phase]} · Обновлено {dateLabel(session.updatedAt)}
                    </p>
                  </div>
                  <button
                    className="button button-secondary"
                    disabled={disabled}
                    onClick={() => void actions.openSession(session.id).catch(() => undefined)}
                    aria-label={`Открыть занятие «${session.title}»`}
                  >
                    Открыть <ArrowRight size={16} />
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="session-empty">
              <BookOpen size={35} strokeWidth={1.5} aria-hidden="true" />
              <h3>Здесь появятся ваши занятия</h3>
              <p>
                Выберите открытое занятие или перейдите по ссылке преподавателя. Здесь сохранятся
                ваши материалы и результаты.
              </p>
              <button className="button button-secondary" onClick={actions.openLocalWork}>
                Открыть библиотеку документов <ArrowRight size={16} />
              </button>
            </div>
          )}
        </section>
        <aside className="session-lobby-aside">
          <section className="session-side-form" aria-labelledby={`${id}-join-title`}>
            <h2 id={`${id}-join-title`}>Открытые занятия</h2>
            {available.length ? <div className="session-list">
              {available.map((item) => <div key={item.id} className="session-open-entry">
                <h3>{item.title}</h3>
                <p className="session-hint">{item.regionId ? (regionNames.get(item.regionId) ?? item.regionId) : 'Российская Федерация'}</p>
                <button className="button button-primary block" disabled={disabled}
                  aria-label={`Присоединиться к занятию «${item.title}»`}
                  onClick={() => void actions.joinOpenSession(item.id).catch(() => undefined)}>
                  <LogIn size={17} /> Присоединиться
                </button>
              </div>)}
            </div> : <p>{sessions.length ? 'Вы уже присоединились к доступным занятиям.' :
              'Преподаватель ещё не открыл занятие. Когда оно появится, нажмите «Обновить».'}</p>}
          </section>
          {state.bootstrap?.canCreateSession ? (
            <section className="session-side-form" aria-labelledby={`${id}-host-title`}>
              <h2 id={`${id}-host-title`}>Провести занятие</h2>
              <p>Создайте общую доску, задайте уровень работы и пригласите участников.</p>
              <button
                className="button button-secondary block"
                disabled={disabled}
                onClick={() => {
                  setCreateOpen(true);
                  setError('');
                }}
              >
                <Plus size={17} />
                Создать занятие
              </button>
            </section>
          ) : null}
        </aside>
      </div>
      {createOpen ? (
        <Modal
          title="Новое занятие"
          onClose={() => {
            if (!disabled) setCreateOpen(false);
          }}
        >
          <p className="modal-intro">
            Название и территория будут видны участникам на общей доске.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="session-field">
              <label htmlFor={`${id}-title`}>Название занятия</label>
              <input
                id={`${id}-title`}
                className="session-input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                minLength={3}
                maxLength={160}
                disabled={disabled}
                placeholder="Например, практики поддержки семьи в Мордовии"
              />
            </div>
            <div className="session-field">
              <label htmlFor={`${id}-scope`}>Уровень работы</label>
              <select
                id={`${id}-scope`}
                className="session-input"
                value={scope}
                onChange={(event) => setScope(event.target.value as SessionScope)}
                disabled={disabled}
              >
                {(Object.keys(scopeLabels) as SessionScope[]).map((value) => (
                  <option value={value} key={value}>
                    {scopeLabels[value]}
                  </option>
                ))}
              </select>
            </div>
            {scope !== 'federal' ? (
              <div className="session-field">
                <label htmlFor={`${id}-region`}>Регион</label>
                <select
                  id={`${id}-region`}
                  className="session-input"
                  value={regionId}
                  onChange={(event) => setRegionId(event.target.value)}
                  required
                  disabled={disabled}
                >
                  <option value="">Выберите регион</option>
                  {regions.map((region) => (
                    <option value={region.id} key={region.id}>
                      {region.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {error ? (
              <p className="session-form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="session-action-row">
              <button
                className="button button-primary"
                type="submit"
                disabled={disabled || title.trim().length < 3 || (scope !== 'federal' && !regionId)}
              >
                <Plus size={17} />
                Создать занятие
              </button>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => setCreateOpen(false)}
                disabled={disabled}
              >
                Отмена
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
