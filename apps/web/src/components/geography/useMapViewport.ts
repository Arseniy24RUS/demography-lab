import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

type Point = readonly [number, number];
export type ViewBox = readonly [x: number, y: number, width: number, height: number];
type Drag = {
  id: number;
  x: number;
  y: number;
  unitsPerPixel: number;
  box: ViewBox;
  moved: boolean;
};

export function useMapViewport(base: ViewBox, maxZoom: number, ready = true) {
  const [box, setBox] = useState(base);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const scale = base[2] / box[2];

  function constrain([x, y, width, height]: ViewBox): ViewBox {
    return [
      Math.max(base[0], Math.min(base[0] + base[2] - width, x)),
      Math.max(base[1], Math.min(base[1] + base[3] - height, y)),
      width,
      height,
    ];
  }

  function zoom(multiplier: number, anchor?: Point, center?: Point) {
    setBox((previous) => {
      const [x, y, width, height] = previous;
      const nextWidth = Math.min(base[2], Math.max(base[2] / maxZoom, width / multiplier));
      if (!center && nextWidth === width) return previous;
      const ratio = nextWidth / width;
      const [cx, cy] = anchor ?? [x + width / 2, y + height / 2];
      const nextHeight = base[3] * (nextWidth / base[2]);
      return constrain([
        center ? center[0] - nextWidth / 2 : cx - (cx - x) * ratio,
        center ? center[1] - nextHeight / 2 : cy - (cy - y) * ratio,
        nextWidth,
        nextHeight,
      ]);
    });
  }

  useEffect(() => {
    const node = svg.current;
    if (!node || !ready) return;
    function wheel(event: WheelEvent) {
      if (!node || !event.deltaY) return;
      const modified = event.ctrlKey || event.metaKey;
      if (!modified && !node.contains(node.ownerDocument.activeElement)) return;
      const width = node.viewBox.baseVal.width;
      if (!modified && (event.deltaY > 0 ? width >= base[2] : width <= base[2] / maxZoom)) return;
      const matrix = node.getScreenCTM();
      if (!matrix) return;
      event.preventDefault();
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      zoom(Math.exp(Math.max(-220, Math.min(220, -pixels)) * .003), [point.x, point.y]);
    }
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [base, maxZoom, ready]);

  function onPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick.current = false;
    const matrix = event.currentTarget.getScreenCTM();
    const pixelsPerUnit = matrix ? Math.hypot(matrix.a, matrix.b) : 0;
    if (scale <= 1 || !pixelsPerUnit) return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      unitsPerPixel: 1 / pixelsPerUnit,
      box,
      moved: false,
    };
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    const state = drag.current;
    if (state?.id !== event.pointerId || !(event.buttons & 1)) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.moved && Math.hypot(dx, dy) < 5) return;
    if (!state.moved) event.currentTarget.setPointerCapture(event.pointerId);
    state.moved = true;
    suppressClick.current = true;
    const [x, y, width, height] = state.box;
    setBox(constrain([x - dx * state.unitsPerPixel, y - dy * state.unitsPerPixel, width, height]));
  }

  function finishPointer(event: PointerEvent<SVGSVGElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onPointerLeave(event: PointerEvent<SVGSVGElement>) {
    if (!drag.current?.moved) finishPointer(event);
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') zoom(1.5);
    else if (event.key === '-') zoom(1 / 1.5);
    else if (event.key === '0') setBox(base);
    else {
      const moves: Record<string, Point> = {
        ArrowUp: [0, -.16], ArrowDown: [0, .16], ArrowLeft: [-.16, 0], ArrowRight: [.16, 0],
      };
      const move = moves[event.key];
      if (!move || scale <= 1) return;
      setBox(([x, y, width, height]) => constrain([x + move[0] * width, y + move[1] * height, width, height]));
    }
    event.preventDefault();
  }

  return {
    box,
    scale,
    svg,
    zoom,
    reset: () => setBox(base),
    canSelect: (clickDetail: number) => clickDetail === 0 || !suppressClick.current,
    canvasEvents: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finishPointer,
      onPointerCancel: finishPointer,
      onPointerLeave,
      onKeyDown,
    },
  };
}
