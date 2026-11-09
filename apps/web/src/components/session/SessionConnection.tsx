import { CheckCircle2, LoaderCircle, Radio, RefreshCw, WifiOff } from 'lucide-react';
import type { ConnectionStatus } from '../../../../../packages/collaboration/types';
import { connectionLabels, timeLabel } from './session-ui';

export function SessionConnection({
  connection,
  lastSyncedAt,
}: {
  connection: ConnectionStatus;
  lastSyncedAt?: string | null;
}) {
  const Icon =
    connection === 'live'
      ? CheckCircle2
      : connection === 'offline' || connection === 'error'
        ? WifiOff
        : connection === 'connecting'
          ? LoaderCircle
          : connection === 'polling'
            ? RefreshCw
            : Radio;
  return (
    <span
      className="session-connection"
      data-state={connection}
      role="status"
      title={lastSyncedAt ? `Последняя синхронизация: ${timeLabel(lastSyncedAt)}` : undefined}
    >
      <Icon
        size={15}
        className={connection === 'connecting' ? 'session-spinner' : undefined}
        aria-hidden="true"
      />
      <span className="session-connection-text">{connectionLabels[connection]}</span>
    </span>
  );
}
