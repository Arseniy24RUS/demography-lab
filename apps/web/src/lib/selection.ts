import {
  createAnchor,
  createRangeAnchor,
  utf16ToCodePointOffset,
  codePointLength,
} from '@domain/index';
import type { DocumentVersion, TextAnchor, BlockSelection, TextPoint } from '@domain/index';

export interface DomSelectionBlock {
  readonly blockId: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Plain source data that remains usable after an asynchronous load or virtual DOM change. */
export interface DomSelectionSnapshot {
  readonly blocks: readonly DomSelectionBlock[];
  readonly from: TextPoint | null;
  readonly to: TextPoint | null;
}

/** Capture synchronously: a live browser Range changes when virtualized nodes disappear. */
export function captureDomSelection(
  root: HTMLElement,
  selection: Selection | null,
): DomSelectionSnapshot | null {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const blocks: DomSelectionBlock[] = [];
  const seen = new Set<string>();
  let from: TextPoint | null = null;
  let to: TextPoint | null = null;
  for (const el of root.querySelectorAll<HTMLElement>('[data-source-text]')) {
    if (!range.intersectsNode(el)) continue;
    const blockId = el.dataset.blockId;
    if (!blockId || seen.has(blockId)) return null;
    seen.add(blockId);
    const text = el.textContent ?? '';
    const full = document.createRange();
    full.selectNodeContents(el);
    const intersection = full.cloneRange();
    if (el.contains(range.startContainer))
      intersection.setStart(range.startContainer, range.startOffset);
    if (el.contains(range.endContainer)) intersection.setEnd(range.endContainer, range.endOffset);
    const prefix = document.createRange();
    prefix.selectNodeContents(el);
    prefix.setEnd(intersection.startContainer, intersection.startOffset);
    const startUtf16 = prefix.toString().length;
    const selected = intersection.toString();
    const endUtf16 = startUtf16 + selected.length;
    const start = utf16ToCodePointOffset(text, startUtf16),
      end = utf16ToCodePointOffset(text, endUtf16);
    if (el.contains(range.startContainer)) from = { blockId, offset: start };
    if (el.contains(range.endContainer)) to = { blockId, offset: end };
    blocks.push({ blockId, text, start, end });
  }
  return blocks.some((block) => block.end > block.start) ? { blocks, from, to } : null;
}

/** Validate captured DOM text against the complete immutable edition before quoting it. */
export function anchorFromSelectionSnapshot(
  version: DocumentVersion,
  snapshot: DomSelectionSnapshot | null,
): TextAnchor | null {
  if (!snapshot?.blocks.length) return null;
  const blocks = new Map(version.blocks.map((block, index) => [block.id, { block, index }]));
  const spans: BlockSelection[] = [];
  let previousIndex = -1;
  for (const captured of snapshot.blocks) {
    const source = blocks.get(captured.blockId);
    if (
      !source ||
      source.block.text !== captured.text ||
      source.index <= previousIndex ||
      !Number.isSafeInteger(captured.start) ||
      !Number.isSafeInteger(captured.end) ||
      captured.start < 0 ||
      captured.end < captured.start ||
      captured.end > codePointLength(source.block.text)
    )
      return null;
    previousIndex = source.index;
    if (captured.end > captured.start)
      spans.push({ blockId: captured.blockId, start: captured.start, end: captured.end });
  }
  if (!spans.length) return null;
  // A virtual reader may unmount blocks between the two verified source endpoints.
  // Restore that continuous range from the immutable edition, never from labels or controls.
  if (snapshot.from && snapshot.to) {
    const from = snapshot.blocks.find((block) => block.blockId === snapshot.from!.blockId);
    const to = snapshot.blocks.find((block) => block.blockId === snapshot.to!.blockId);
    if (!from || !to || from.start !== snapshot.from.offset || to.end !== snapshot.to.offset)
      return null;
    return createRangeAnchor(version, snapshot.from, snapshot.to);
  }
  const first = blocks.get(spans[0].blockId)!.index;
  const last = blocks.get(spans[spans.length - 1].blockId)!.index;
  const selectedIds = new Set(spans.map((span) => span.blockId));
  if (
    version.blocks
      .slice(first, last + 1)
      .some((block) => block.text.length > 0 && !selectedIds.has(block.id))
  )
    return null;
  return createAnchor(version, spans);
}

/** DOM positions count UTF-16; canonical source positions count Unicode code points. */
export function anchorFromDomSelection(
  root: HTMLElement,
  version: DocumentVersion,
  selection: Selection | null,
): TextAnchor | null {
  return anchorFromSelectionSnapshot(version, captureDomSelection(root, selection));
}

export function anchorForBlocks(
  version: DocumentVersion,
  ids: ReadonlySet<string>,
): TextAnchor | null {
  const selections = version.blocks
    .filter((b) => ids.has(b.id) && b.text.length > 0)
    .map((b) => ({ blockId: b.id, start: 0, end: codePointLength(b.text) }));
  return selections.length ? createAnchor(version, selections) : null;
}
