import { useRef, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

interface DragState {
  id: string;
  title: string;
  x: number;
  y: number;
  over: string | null;
}

/** The handle alone owns touch movement. All transfers also have an ordinary button flow. */
export function usePracticeDrag(
  onDrop: (submissionId: string, familyId: string) => void,
  onChoose: (submissionId: string) => void,
) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const active = useRef<{ id: string; title: string; x: number; y: number; moved: boolean } | null>(
    null,
  );
  const ignoreClickUntil = useRef(0);

  function start(event: PointerEvent<HTMLButtonElement>, id: string, title: string) {
    if (event.button !== 0) return;
    active.current = { id, title, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = active.current;
    if (!current) return;
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 8)
      return;
    current.moved = true;
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-family-drop]');
    setDrag({
      id: current.id,
      title: current.title,
      x: event.clientX,
      y: event.clientY,
      over: target?.dataset.familyDrop ?? null,
    });
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    const current = active.current;
    if (!current) return;
    active.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.moved) {
      ignoreClickUntil.current = Date.now() + 300;
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-family-drop]');
      const familyId = target?.dataset.familyDrop;
      if (familyId) {
        onDrop(current.id, familyId);
        setAnnouncement(
          'Открыто подтверждение переноса. Проверьте общий механизм и региональные условия.',
        );
      } else setAnnouncement('Перенос отменён. Карточка осталась в прежнем месте.');
    }
    setDrag(null);
  }
  function cancel() {
    active.current = null;
    setDrag(null);
    setAnnouncement('Перенос отменён.');
  }
  function click(event: MouseEvent<HTMLButtonElement>, id: string) {
    if (Date.now() < ignoreClickUntil.current) {
      event.preventDefault();
      return;
    }
    onChoose(id);
  }
  return { drag, announcement, start, move, finish, cancel, click };
}
