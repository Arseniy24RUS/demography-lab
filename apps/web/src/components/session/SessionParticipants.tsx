import { Users } from 'lucide-react';
import type { SessionMember } from '../../../../../packages/collaboration/types';
import { initials, roleLabels } from './session-ui';

export function SessionParticipants({ members }: { members: SessionMember[] }) {
  return <details className="session-sidebar-section session-participants">
    <summary><Users size={16} aria-hidden="true" />Участники <span>{members.length}</span></summary>
    <div className="session-people">
      {members.map(member => <div className="session-person-entry" key={member.userId}>
        <div className="session-person">
          <span className="session-avatar" aria-hidden="true">{initials(member.fullName)}</span>
          <div><strong>{member.fullName}</strong><small>{roleLabels[member.role]}</small></div>
        </div>
      </div>)}
    </div>
  </details>;
}
