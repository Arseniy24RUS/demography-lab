import { Info, LogOut, RefreshCw, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WorkshopView } from '../workshop/workshop-ui';
import type {
  SessionAreaActions,
  SessionAreaState,
  SessionRegionOption,
} from '../../../../../packages/collaboration/types';
import { SessionAuthPanel } from './SessionAuthPanel';
import { SessionLobby } from './SessionLobby';
import { SessionConnection } from './SessionConnection';
import { ActiveSession } from './ActiveSession';
import { phaseLabels } from './session-ui';
import { OfflineSeminarPanel } from './OfflineSeminarPanel';

export function SessionArea({
  state,
  actions,
  regions,
  renderWorkshop,
  renderBarriers,
  renderRoadmaps,
}: {
  state: SessionAreaState;
  actions: SessionAreaActions;
  regions: SessionRegionOption[];
  renderWorkshop?: (view: WorkshopView) => ReactNode;
  renderBarriers?: () => ReactNode;
  renderRoadmaps?: () => ReactNode;
}) {
  const ready = state.auth.status === 'signed-in' && state.bootstrap?.profile;
  return (
    <main id="main-content" className="session-page">
      <header className="session-heading">
        <div>
          <h1>{ready && state.snapshot ? state.snapshot.session.title : 'Совместная работа'}</h1>
          <p>
            {ready && state.snapshot
              ? phaseLabels[state.snapshot.session.phase]
              : 'Практики регионов, точные цитаты и общее обсуждение.'}
          </p>
        </div>
        <div className="session-heading-actions">
          {ready && state.snapshot ? (
            <SessionConnection connection={state.connection} lastSyncedAt={state.lastSyncedAt} />
          ) : null}
          {ready ? (
            <div className="session-profile-summary">
              <strong>{state.bootstrap!.profile!.fullName}</strong>
              <button
                className="button button-quiet"
                disabled={state.busy !== null}
                onClick={() => void actions.signOut().catch(() => undefined)}
              >
                <LogOut size={15} />
                Выйти
              </button>
            </div>
          ) : null}
        </div>
      </header>
      {state.offline && ready ? <OfflineSeminarPanel state={state} actions={actions} /> : null}
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
        <SessionAuthPanel state={state} actions={actions} />
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
        />
      ) : (
        <SessionLobby state={state} actions={actions} regions={regions} />
      )}
    </main>
  );
}
