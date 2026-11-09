import { createAnchor, utf16ToCodePointOffset, codePointLength } from '@domain/index';
import type { DocumentVersion, TextAnchor, BlockSelection } from '@domain/index';

/** DOM positions count UTF-16; canonical source positions count Unicode code points. */
export function anchorFromDomSelection(
  root: HTMLElement,
  version: DocumentVersion,
  selection: Selection | null,
): TextAnchor | null {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const spans: BlockSelection[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-source-text]')) {
    const blockId = el.dataset.blockId;
    if (!blockId || !range.intersectsNode(el)) continue;
    const block = version.blocks.find((b) => b.id === blockId);
    if (!block || el.textContent !== block.text) return null;
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
    if (!selected) continue;
    const endUtf16 = startUtf16 + selected.length;
    const start = utf16ToCodePointOffset(block.text, startUtf16),
      end = utf16ToCodePointOffset(block.text, endUtf16);
    if (end > start) spans.push({ blockId, start, end });
  }
  if (!spans.length) return null;
  return createAnchor(version, spans);
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
