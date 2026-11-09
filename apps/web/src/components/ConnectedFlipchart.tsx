import { RotateCcw, X } from 'lucide-react';
import type { SessionApi } from '../lib/session-api';
import { useFlipchart } from '../hooks/useFlipchart';
import { FlipchartBoard, FlipchartProjector } from './flipchart/FlipchartBoard';

type Props = { api: SessionApi | null; sessionId: string | null; userId: string | null };

export function ConnectedFlipchart(props: Props) {
  const board = useFlipchart(props);
  return <>
    <FlipchartBoard notes={board.notes} onAdd={board.add} onVote={board.vote}
      onWithdraw={board.withdraw} pendingIds={board.pendingIds} submitting={board.submitting}
      loading={board.loading} error={board.error} />
    {board.removed ? <div className="flipchart-undo" role="status">
      <span>Стикер убран</span>
      <button type="button" className="button button-quiet" disabled={board.pendingIds.has(board.removed.id)} onClick={() => void board.restore()}>
        <RotateCcw size={16} />Вернуть
      </button>
      <button type="button" className="icon-button" aria-label="Скрыть уведомление" onClick={board.dismissUndo}><X size={16} /></button>
    </div> : null}
  </>;
}

export function ConnectedFlipchartProjector(props: Props) {
  const board = useFlipchart({ ...props, projector: true });
  return <FlipchartProjector notes={board.notes} loading={board.loading} error={board.error} />;
}
