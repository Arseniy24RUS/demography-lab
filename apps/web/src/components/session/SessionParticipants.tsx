import { useId, useState } from 'react';
import { UserMinus, Users } from 'lucide-react';
import { Modal } from '@/components/Modal';
import type {
  SessionAreaActions,
  SessionMember,
} from '../../../../../packages/collaboration/types';
import { initials, messageFromError, roleLabels } from './session-ui';

export function SessionParticipants({
  members,
  host,
  busy,
  actions,
}: {
  members: SessionMember[];
  host: boolean;
  busy: boolean;
  actions: SessionAreaActions;
}) {
  const id = useId();
  const [removing, setRemoving] = useState<SessionMember | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const disabled = busy || working;

  async function perform(action: () => Promise<void>, success?: () => void) {
    setError('');
    setWorking(true);
    try {
      await action();
      success?.();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <details className="session-sidebar-section session-participants">
        <summary>
          <Users size={16} aria-hidden="true" />
          Участники группы <span>{members.length}</span>
        </summary>
        <div className="session-people">
          {members.map((member) => (
            <div className="session-person-entry" key={member.userId}>
              <div className="session-person">
                <span className="session-avatar" aria-hidden="true">
                  {initials(member.fullName)}
                </span>
                <div>
                  <strong>{member.fullName}</strong>
                  <small>{roleLabels[member.role]}</small>
                </div>
              </div>
              {host && member.role !== 'host' ? (
                <div className="session-member-actions">
                  <label className="session-sr-only" htmlFor={`${id}-${member.userId}`}>
                    Роль участника {member.fullName}
                  </label>
                  <select
                    id={`${id}-${member.userId}`}
                    className="session-input"
                    value={member.role}
                    disabled={disabled}
                    onChange={(event) =>
                      void perform(() =>
                        actions.setMemberRole(
                          member.userId,
                          member.revision,
                          event.target.value as 'participant' | 'observer',
                        ),
                      )
                    }
                  >
                    <option value="participant">Участник</option>
                    <option value="observer">Наблюдатель</option>
                  </select>
                  <button
                    className="icon-button"
                    aria-label={`Закрыть доступ: ${member.fullName}`}
                    disabled={disabled}
                    onClick={() => {
                      setRemoving(member);
                      setError('');
                    }}
                  >
                    <UserMinus size={16} />
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {error && !removing ? (
          <p className="session-form-error" role="alert">
            {error}
          </p>
        ) : null}
      </details>
      {removing ? (
        <Modal
          title="Закрыть доступ к занятию?"
          onClose={() => {
            if (!disabled) setRemoving(null);
          }}
        >
          <p className="modal-intro">
            {removing.fullName} больше не сможет просматривать и изменять материалы этого занятия.
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
                  () => actions.revokeMember(removing.userId, removing.revision),
                  () => setRemoving(null),
                )
              }
            >
              Закрыть доступ
            </button>
            <button
              className="button button-secondary"
              disabled={disabled}
              onClick={() => setRemoving(null)}
            >
              Отмена
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
