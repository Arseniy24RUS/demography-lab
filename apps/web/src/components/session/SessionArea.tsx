import { Info, RefreshCw, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WorkshopView } from '../workshop/workshop-ui';
import type {
  SessionAreaActions,
  SessionAreaState,
  SessionRegionOption,
} from '../../../../../packages/collaboration/types';
import { SessionAuthPanel } from './SessionAuthPanel';
import { SessionConnection } from './SessionConnection';
import { ActiveSession } from './ActiveSession';
import { OfflineSeminarPanel } from './OfflineSeminarPanel';

export function SessionArea({
  state,
  actions,
  regions,
  renderWorkshop,
  renderBarriers,
  renderRoadmaps,
  renderFlipchart,
  renderLiveVotes,
}: {
  state: SessionAreaState;
  actions: SessionAreaActions;
  regions: SessionRegionOption[];
  renderWorkshop?: (view: WorkshopView) => ReactNode;
  renderBarriers?: () => ReactNode;
  renderRoadmaps?: () => ReactNode;
  renderFlipchart?: () => ReactNode;
  renderLiveVotes?: () => ReactNode;
}) {
  const ready = state.auth.status === 'signed-in' && state.bootstrap?.profile;
  return (
    <main id="main-content" className={`session-page${ready && state.snapshot ? ' session-page--shared' : ''}`}>
      <header className="session-heading">
        <div>
          <h1>{ready && state.snapshot ? state.snapshot.session.title : 'Мастерская'}</h1>
        </div>
        <div className="session-heading-actions">
          {ready && state.snapshot ? (
            <SessionConnection connection={state.connection} lastSyncedAt={state.lastSyncedAt} />
          ) : null}
        </div>
      </header>
      {state.offline && ready && state.bootstrap?.canCreateSession ? (
        <details className="workspace-settings"><summary>Локальная сеть</summary>
          <OfflineSeminarPanel state={state} actions={actions} />
        </details>
      ) : null}
      {state.testEnvironment ? (
        <p className="session-message" data-tone="warning">
          Испытательный режим. Учебные аккаунты и данные находятся на локальном проверочном сервере.
        </p>
      ) : null}
      {state.error ? (
        <div className="session-message" data-tone="error" role="alert">
          <Info size={18} aria-hidden="true" />
          <div className="session-message-body">
            <p>{state.error}</p>
            {state.auth.status === 'signed-in' ? (
              <button
                className="button button-secondary"
                disabled={state.busy !== null}
                onClick={() => void actions.refresh().catch(() => undefined)}
              >
                <RefreshCw size={15} />
                Повторить обновление
              </button>
            ) : null}
          </div>
          <button
            className="icon-button"
            onClick={actions.clearError}
            aria-label="Скрыть сообщение об ошибке"
          >
            <X size={16} />
          </button>
        </div>
      ) : null}
      {state.notice ? (
        <div className="session-message" role="status">
          <Info size={18} aria-hidden="true" />
          <p>{state.notice}</p>
          <button
            className="icon-button"
            aria-label="Скрыть уведомление"
            onClick={actions.clearError}
          >
            <X size={16} />
          </button>
        </div>
      ) : null}
      {state.connection === 'offline' && ready ? (
        <p className="session-message" data-tone="warning">
          Связь с занятием прервана. На экране остаются последние полученные материалы. Перед
          публикацией дождитесь восстановления связи.
        </p>
      ) : null}
      {!state.configured || !ready ? (
        <div className={state.configured && !state.offline ? 'session-entry-layout' : undefined}>
          <SessionAuthPanel state={state} actions={actions} />
          {state.configured && !state.offline ? (
            <aside className="session-entry-qr" aria-label="Вход в мастерскую с телефона">
              <a className="session-entry-qr-link"
                href="https://xn----7sbabangicd2azeshy9ajmfct0b3e8kka.xn--p1ai/"
                aria-label="Открыть Демографическую мастерскую на телефоне">
                <img src={`${import.meta.env.BASE_URL}images/portal-qr.svg`}
                  width="400" height="400" alt="QR-код для входа в Демографическую мастерскую" />
              </a>
              <p>Откройте мастерскую на телефоне</p>
            </aside>
          ) : null}
        </div>
      ) : state.snapshot ? (
        <ActiveSession
          key={state.snapshot.session.id}
          state={state}
          snapshot={state.snapshot}
          actions={actions}
          regions={regions}
          renderWorkshop={renderWorkshop}
          renderBarriers={renderBarriers}
          renderRoadmaps={renderRoadmaps}
          renderFlipchart={renderFlipchart}
          renderLiveVotes={renderLiveVotes}
        />
      ) : (
        <div className="session-workspace-loading" role="status" aria-busy={!state.error}>
          {state.error ? 'Мастерская пока недоступна.' : 'Подключаемся к общей мастерской…'}
        </div>
      )}
    </main>
  );
}
