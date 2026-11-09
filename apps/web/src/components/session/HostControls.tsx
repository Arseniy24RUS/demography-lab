import { useEffect, useId, useState } from 'react';
import { Copy, Link2, Pause, Play, Square } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Modal } from '@/components/Modal';
import type {
  SessionAreaActions,
  SessionInvitation,
  SessionPhase,
  SessionSummary,
} from '../../../../../packages/collaboration/types';
import { messageFromError, phaseLabels } from './session-ui';
import { useResponsiveDisclosure } from './useResponsiveDisclosure';
import { useOfflineShareUrl } from '../../hooks/useOfflineShareUrl';

export function HostControls({
  session,
  busy,
  actions,
  compact = false,
}: {
  session: SessionSummary;
  invitation: SessionInvitation | null;
  busy: boolean;
  actions: SessionAreaActions;
  compact?: boolean;
}) {
  const id = useId();
  const [invitationOpen, setInvitationOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [error, setError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [controlsOpen, setControlsOpen] = useResponsiveDisclosure();
  useEffect(() => {
    if (compact) setControlsOpen(false);
  }, [compact, setControlsOpen]);
  const disabled = busy || working;
  const originalInviteUrl = (() => {
    const url = new URL(window.location.pathname, window.location.origin);
    url.hash = new URLSearchParams({ session: session.id }).toString();
    return url.toString();
  })();
  const inviteUrl = useOfflineShareUrl(originalInviteUrl) ?? '';

  async function perform(action: () => Promise<void>, onSuccess?: () => void) {
    setWorking(true);
    setError('');
    try {
      await action();
      onSuccess?.();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setWorking(false);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage('Скопировано. Можно отправить участникам.');
    } catch {
      setCopyMessage('Выделите ссылку в поле ниже и скопируйте её вручную.');
    }
  }

  return (
    <section className="session-host-controls" aria-labelledby={`${id}-title`}>
      <details
        className="session-host-disclosure"
        open={controlsOpen}
        onToggle={(event) => setControlsOpen(event.currentTarget.open)}
      >
        <summary>
          <h2 id={`${id}-title`}>Управление занятием</h2>
        </summary>
        <div>
          <div className="session-host-fields">
            <div className="session-field">
              <label htmlFor={`${id}-phase`}>Текущий этап</label>
              <select
                id={`${id}-phase`}
                className="session-input"
                value={session.phase}
                disabled={disabled || session.status === 'closed'}
                onChange={(event) =>
                  void perform(() =>
                    actions.updateSession(
                      { phase: event.target.value as SessionPhase },
                      session.revision,
                    ),
                  )
                }
              >
                {(Object.keys(phaseLabels) as SessionPhase[]).map((phase) => (
                  <option value={phase} key={phase}>
                    {phaseLabels[phase]}
                  </option>
                ))}
              </select>
            </div>
            {session.status === 'open' ? (
              <button
                className="button button-secondary"
                disabled={disabled}
                onClick={() =>
                  void perform(() => actions.updateSession({ status: 'paused' }, session.revision))
                }
              >
                <Pause size={16} />
                Приостановить сбор
              </button>
            ) : (
              <button
                className="button button-primary"
                disabled={disabled}
                onClick={() =>
                  void perform(() => actions.updateSession({ status: 'open' }, session.revision))
                }
              >
                <Play size={16} />
                {session.status === 'closed' ? 'Открыть занятие снова' : 'Возобновить сбор'}
              </button>
            )}
            {session.status !== 'closed' ? (
              <button
                className="button button-secondary"
                disabled={disabled}
                onClick={() => {
                  setConfirmClose(true);
                  setError('');
                }}
              >
                <Square size={15} />
                Завершить занятие
              </button>
            ) : null}
          </div>
          <div className="session-invitation">
            <div className="session-action-row">
              <button
                className="button button-secondary"
                disabled={disabled || !inviteUrl}
                onClick={() => {
                  setInvitationOpen(true);
                  setCopyMessage('');
                  setError('');
                }}
              >
                <Link2 size={16} />
                Пригласить участников
              </button>
              <label className="session-checkbox">
                <input
                  type="checkbox"
                  checked={session.joinOpen}
                  disabled={disabled || session.status === 'closed'}
                  onChange={(event) =>
                    void perform(() =>
                      actions.updateSession({ joinOpen: event.target.checked }, session.revision),
                    )
                  }
                />
                Разрешить присоединение
              </label>
            </div>
            <label className="session-checkbox">
              <input
                type="checkbox"
                checked={session.projectorShowAuthors}
                disabled={disabled}
                onChange={(event) =>
                  void perform(() =>
                    actions.updateSession(
                      { projectorShowAuthors: event.target.checked },
                      session.revision,
                    ),
                  )
                }
              />
              Показывать авторов на проекторе
            </label>
          </div>
          {error && !invitationOpen && !confirmClose ? (
            <p className="session-form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </details>
      {invitationOpen ? (
        <Modal
          title="Пригласить участников"
          onClose={() => {
            if (!disabled) setInvitationOpen(false);
          }}
        >
          <div className="session-invite-display">
            <QRCodeSVG
              value={inviteUrl}
              size={160}
              level="M"
              marginSize={1}
              title="QR-код для входа в занятие"
            />
            <div>
              <p className="session-invitation-label">{session.title}</p>
              <p className="session-hint">
                Участники откроют ссылку, введут email и ФИО и сразу присоединятся к занятию.
              </p>
            </div>
          </div>
          {!session.joinOpen || session.status === 'closed' ? (
            <p className="session-message" data-tone="warning">
              Присоединение закрыто. Включите его в управлении занятием, чтобы пригласить новых
              участников.
            </p>
          ) : null}
          <div className="session-field">
            <label htmlFor={`${id}-invitation-url`}>Ссылка для участников</label>
            <input
              id={`${id}-invitation-url`}
              className="session-input"
              readOnly
              value={inviteUrl}
              onFocus={(event) => event.target.select()}
            />
          </div>
          <div className="session-action-row">
            <button className="button button-primary" onClick={() => void copy(inviteUrl)}>
              <Copy size={16} />
              Скопировать ссылку
            </button>

          </div>
          {copyMessage ? (
            <p className="session-hint session-form-footer" role="status">
              {copyMessage}
            </p>
          ) : null}
          {error ? (
            <p className="session-form-error" role="alert">
              {error}
            </p>
          ) : null}
        </Modal>
      ) : null}
      {confirmClose ? (
        <Modal
          title="Завершить занятие?"
          onClose={() => {
            if (!disabled) setConfirmClose(false);
          }}
        >
          <p className="modal-intro">
            Участники смогут читать опубликованные работы. Добавление и изменение материалов будет
            остановлено. Вы сможете открыть занятие снова.
          </p>
          {error ? (
            <p className="session-form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="session-action-row">
            <button
              className="button button-primary"
              disabled={disabled}
              onClick={() =>
                void perform(
                  () =>
                    actions.updateSession({ status: 'closed', joinOpen: false }, session.revision),
                  () => setConfirmClose(false),
                )
              }
            >
              Завершить занятие
            </button>
            <button
              className="button button-secondary"
              disabled={disabled}
              onClick={() => setConfirmClose(false)}
            >
              Продолжить работу
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
