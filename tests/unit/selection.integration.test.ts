// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  NORMALIZATION_VERSION,
  validateAnchor,
  type DocumentVersion,
  type TextAnchor,
} from '@domain/index';
import { anchorForBlocks, anchorFromDomSelection } from '@/lib/selection';

function version(blocks: readonly [string, string][], id = 'edition-1'): DocumentVersion {
  return {
    id,
    documentId: 'document-1',
    normalizationVersion: NORMALIZATION_VERSION,
    blocks: blocks.map(([blockId, text], order) => ({
      id: blockId,
      order,
      text,
      kind: 'paragraph',
      pageStart: 1,
    })),
  };
}

function mount(html: string): HTMLElement {
  const root = document.createElement('section');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function select(start: Node, startOffset: number, end: Node, endOffset: number): Selection {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  selection.addRange(range);
  return selection;
}

/** Both an explicit rejection and an empty result mean no misleading citation can be saved. */
function captureOrReject(
  root: HTMLElement,
  source: DocumentVersion,
  selection: Selection,
): TextAnchor | null {
  try {
    return anchorFromDomSelection(root, source, selection);
  } catch {
    return null;
  }
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe('DOM selection to exact source anchors', () => {
  it('counts Unicode code points across search marks and nested text nodes', () => {
    const source = version([['b1', 'А😀Б семья 👪!']]);
    const root = mount(
      '<p data-source-text data-block-id="b1">А<mark>😀Б</mark><span> семья </span><mark>👪</mark>!</p>',
    );
    const marks = root.querySelectorAll('mark');
    const selection = select(marks[0].firstChild!, 2, marks[1].firstChild!, 2);
    expect(selection.toString()).toBe('Б семья 👪');
    const anchor = anchorFromDomSelection(root, source, selection)!;
    expect(anchor.spans).toMatchObject([
      { blockId: 'b1', start: 2, end: 11, exact: 'Б семья 👪', prefix: 'А😀', suffix: '!' },
    ]);
    expect(validateAnchor(source, anchor).valid).toBe(true);
  });

  it('preserves all selected paragraphs while excluding intervening page labels and controls', () => {
    const source = version([
      ['b1', 'Первый абзац: жильё.'],
      ['b2', 'Второй абзац: ясли👶.'],
      ['b3', 'Третий абзац: работа.'],
    ]);
    const root = mount(
      '<article><p data-source-text data-block-id="b1">Первый абзац: жильё.</p><button>Выбрать фрагмент</button><span>20 знаков</span><p data-source-text data-block-id="b2">Второй абзац: <mark>ясли👶</mark>.</p></article><div>Страница 2</div><article><p data-source-text data-block-id="b3">Третий абзац: работа.</p></article>',
    );
    const first = root.querySelector('[data-block-id="b1"]')!.firstChild!;
    const last = root.querySelector('[data-block-id="b3"]')!.firstChild!;
    const anchor = anchorFromDomSelection(root, source, select(first, 14, last, 6))!;
    expect(anchor.spans).toMatchObject([
      { blockId: 'b1', start: 14, end: 20, exact: 'жильё.' },
      { blockId: 'b2', start: 0, end: 20, exact: 'Второй абзац: ясли👶.' },
      { blockId: 'b3', start: 0, end: 6, exact: 'Третий' },
    ]);
    expect(anchor.spans.map((span) => span.exact).join('\n')).not.toMatch(
      /Выбрать|знаков|Страница/,
    );
    expect(validateAnchor(source, anchor).valid).toBe(true);
  });

  it('does not add a final paragraph when a range stops at its first character boundary', () => {
    const source = version([
      ['b1', 'Первый.'],
      ['b2', 'Второй.'],
    ]);
    const root = mount(
      '<p data-source-text data-block-id="b1">Первый.</p><p data-source-text data-block-id="b2">Второй.</p>',
    );
    const paragraphs = root.querySelectorAll('p');
    const anchor = anchorFromDomSelection(
      root,
      source,
      select(paragraphs[0].firstChild!, 0, paragraphs[1].firstChild!, 0),
    )!;
    expect(anchor.spans.map((span) => span.blockId)).toEqual(['b1']);
    expect(anchor.spans[0].exact).toBe('Первый.');
  });

  it('handles range endpoints on an element rather than only on text nodes', () => {
    const source = version([['b1', 'А😀Б']]);
    const root = mount('<p data-source-text data-block-id="b1">А<mark>😀</mark>Б</p>');
    const p = root.querySelector('p')!;
    const anchor = anchorFromDomSelection(root, source, select(p, 1, p, 2))!;
    expect(anchor.spans).toMatchObject([{ blockId: 'b1', start: 1, end: 2, exact: '😀' }]);
  });

  it('refuses collapsed selections, selections outside the reader and broken surrogate boundaries', () => {
    const source = version([['b1', 'А😀Б']]);
    const root = mount('<p data-source-text data-block-id="b1">А😀Б</p>');
    const text = root.querySelector('p')!.firstChild!;
    expect(anchorFromDomSelection(root, source, select(text, 0, text, 0))).toBeNull();
    const outside = document.createTextNode('Не источник');
    document.body.append(outside);
    expect(anchorFromDomSelection(root, source, select(text, 0, outside, 3))).toBeNull();
    expect(captureOrReject(root, source, select(text, 2, text, 4))).toBeNull();
  });

  it('never silently substitutes canonical text for different selected DOM text', () => {
    const source = version([['b1', 'Выплата 100 рублей.']]);
    const root = mount('<p data-source-text data-block-id="b1">Выплата 900 рублей.</p>');
    const text = root.querySelector('p')!.firstChild!;
    const selection = select(text, 8, text, 11);
    expect(selection.toString()).toBe('900');
    expect(captureOrReject(root, source, selection)).toBeNull();
  });

  it('rejects a continuous range containing a source block absent from the selected edition', () => {
    const source = version([
      ['b1', 'Первый.'],
      ['b3', 'Третий.'],
    ]);
    const root = mount(
      '<p data-source-text data-block-id="b1">Первый.</p><p data-source-text data-block-id="old-edition-block">Условие из другой редакции.</p><p data-source-text data-block-id="b3">Третий.</p>',
    );
    const first = root.querySelector('[data-block-id="b1"]')!.firstChild!;
    const last = root.querySelector('[data-block-id="b3"]')!.firstChild!;
    expect(captureOrReject(root, source, select(first, 0, last, 7))).toBeNull();
  });

  it('creates checkbox selections in source reading order and counts emoji correctly', () => {
    const source = version([
      ['b1', 'А😀Б'],
      ['empty', ''],
      ['b2', 'Второй.'],
    ]);
    const anchor = anchorForBlocks(source, new Set(['b2', 'empty', 'b1']))!;
    expect(anchor.spans).toMatchObject([
      { blockId: 'b1', start: 0, end: 3, exact: 'А😀Б' },
      { blockId: 'b2', start: 0, end: 7, exact: 'Второй.' },
    ]);
    expect(anchorForBlocks(source, new Set())).toBeNull();
  });
});
