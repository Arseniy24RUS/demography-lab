import { describe, expect, it } from 'vitest';
import {
  NORMALIZATION_VERSION,
  anchorText,
  codePointLength,
  codePointToUtf16Offset,
  createAnchor,
  createBlockId,
  createRangeAnchor,
  normalizeCanonicalText,
  reanchorSameVersion,
  sliceCodePoints,
  stableId,
  suggestEditionAnchors,
  utf16ToCodePointOffset,
  validateAnchor,
  validateDocumentVersion,
  type TextAnchor,
} from '../index';
import { makeVersion } from './fixtures';

function changedSpan(anchor: TextAnchor, patch: Partial<TextAnchor['spans'][number]>): TextAnchor {
  return { ...anchor, spans: [{ ...anchor.spans[0]!, ...patch }, ...anchor.spans.slice(1)] };
}

describe('canonical Unicode contract', () => {
  it('normalizes only NFC and line endings, preserving meaningful spaces', () => {
    expect(normalizeCanonicalText(' е\u0308\r\n  текст\r')).toBe(' ё\n  текст\n');
    const text = 'А😀Б';
    expect(codePointLength(text)).toBe(3);
    expect(sliceCodePoints(text, 1, 2)).toBe('😀');
    expect(codePointToUtf16Offset(text, 2)).toBe(3);
    expect(utf16ToCodePointOffset(text, 3)).toBe(2);
    expect(() => utf16ToCodePointOffset(text, 2)).toThrow('surrogate');
    expect(() => sliceCodePoints(text, -1)).toThrow();
    expect(() => codePointToUtf16Offset(text, 1.5)).toThrow();
  });
  it('rejects duplicate identities, noncanonical text and invalid reading order', () => {
    const version = makeVersion();
    expect(validateDocumentVersion(version).valid).toBe(true);
    expect(
      validateDocumentVersion({ ...version, blocks: [version.blocks[0], version.blocks[0]] }).valid,
    ).toBe(false);
    expect(validateDocumentVersion(makeVersion(['е\u0308'])).valid).toBe(false);
    expect(validateDocumentVersion(makeVersion(['x\ud800'])).valid).toBe(false);
    expect(
      validateDocumentVersion({ ...version, normalizationVersion: 'future-unknown' }).valid,
    ).toBe(false);
  });
  it('makes deterministic, edition-specific identities without claiming cryptographic integrity', () => {
    expect(stableId('hit', 'а', 'б')).toBe(stableId('hit', 'а', 'б'));
    expect(stableId('hit', 'ab', 'c')).not.toBe(stableId('hit', 'a', 'bc'));
    expect(createBlockId('v1', 0, 'текст')).not.toBe(createBlockId('v2', 0, 'текст'));
    expect(() => createBlockId('v1', 0, 'е\u0308')).toThrow();
  });
});

describe('source anchors', () => {
  it('survives UTF-16 DOM conversion and selects full emoji code points', () => {
    const version = makeVersion(['Семья 😀 получает 100 000 рублей.']);
    const text = version.blocks[0]!.text;
    const start = utf16ToCodePointOffset(text, text.indexOf('😀'));
    const anchor = createAnchor(version, [{ blockId: 'b0', start, end: start + 1 }]);
    expect(anchor.spans[0]!.exact).toBe('😀');
    expect(validateAnchor(version, anchor).valid).toBe(true);
    expect(anchor).toEqual(createAnchor(version, [{ blockId: 'b0', start, end: start + 1 }]));
  });
  it('anchors a range across a heading, paragraph and table without flattening their IDs', () => {
    const base = makeVersion(['Заголовок', 'Описание выплаты', '100 000 рублей']);
    const version = {
      ...base,
      blocks: base.blocks.map((b, i) => ({
        ...b,
        kind: i === 2 ? ('table-cell' as const) : b.kind,
      })),
    };
    const anchor = createRangeAnchor(
      version,
      { blockId: 'b0', offset: 4 },
      { blockId: 'b2', offset: 7 },
    );
    expect(anchor.spans.map((span) => span.blockId)).toEqual(['b0', 'b1', 'b2']);
    expect(anchorText(anchor)).toBe('ловок\n\nОписание выплаты\n\n100 000');
    expect(validateAnchor(version, anchor).valid).toBe(true);
    expect(validateAnchor(version, { ...anchor, spans: [...anchor.spans].reverse() }).valid).toBe(
      false,
    );
  });
  it('rejects invalid offsets, quote substitutions, altered context, overlaps and cross-edition selectors', () => {
    const version = makeVersion();
    const anchor = createAnchor(version, [{ blockId: 'b0', start: 12, end: 18 }]);
    for (const patch of [
      { start: -1 },
      { end: 999999 },
      { start: NaN },
      { end: 12 },
      { exact: 'ВЫДУМКА' },
      { prefix: 'несуществующий контекст' },
      { suffix: 'ошибка' },
      { blockId: 'absent' },
      { exact: '\ud800' },
    ]) {
      expect(validateAnchor(version, changedSpan(anchor, patch)).valid).toBe(false);
    }
    expect(
      validateAnchor(version, { ...anchor, spans: [anchor.spans[0], anchor.spans[0]] }).valid,
    ).toBe(false);
    expect(validateAnchor(version, { ...anchor, versionId: 'edition-2027' }).valid).toBe(false);
    expect(validateAnchor(version, { ...anchor, normalizationVersion: 'future' }).valid).toBe(
      false,
    );
    expect(() =>
      createRangeAnchor(version, { blockId: 'b1', offset: 1 }, { blockId: 'b0', offset: 2 }),
    ).toThrow();
  });
  it('preserves disjoint ordered spans and rejects accidental reversal', () => {
    const version = makeVersion(['Первая сумма 100 и вторая 200']);
    const anchor = createAnchor(version, [
      { blockId: 'b0', start: 0, end: 6 },
      { blockId: 'b0', start: 13, end: 16 },
    ]);
    expect(validateAnchor(version, anchor).valid).toBe(true);
    expect(() =>
      createAnchor(version, [
        { blockId: 'b0', start: 13, end: 16 },
        { blockId: 'b0', start: 0, end: 6 },
      ]),
    ).toThrow();
  });
});

describe('strict reanchoring and edition proposals', () => {
  it('retains a valid positional anchor even when the quotation repeats', () => {
    const version = makeVersion(['выплата; выплата']);
    const anchor = createAnchor(version, [{ blockId: 'b0', start: 0, end: 7 }], {
      contextLength: 0,
    });
    expect(reanchorSameVersion(version, anchor)).toEqual({ status: 'unchanged', anchor });
  });
  it('repairs stale offsets only after a unique quote+context match, requiring review', () => {
    const version = makeVersion(['Начало: выплата 100. Конец.']);
    const anchor = createAnchor(version, [{ blockId: 'b0', start: 8, end: 15 }]);
    const corrupted = changedSpan(anchor, { start: 9, end: 16 });
    const original = JSON.stringify(corrupted);
    const result = reanchorSameVersion(version, corrupted);
    expect(result.status).toBe('reanchored');
    if (result.status !== 'reanchored') throw new Error('Expected repaired anchor');
    expect(result.requiresReview).toBe(true);
    expect(result.anchor.spans[0]!.start).toBe(8);
    expect(validateAnchor(version, result.anchor).valid).toBe(true);
    expect(JSON.stringify(corrupted)).toBe(original);
  });
  it('does not choose the first of repeated identical quotes', () => {
    const version = makeVersion(['выплата; выплата']);
    const anchor = createAnchor(version, [{ blockId: 'b0', start: 0, end: 7 }], {
      contextLength: 0,
    });
    const result = reanchorSameVersion(version, changedSpan(anchor, { start: 1, end: 8 }));
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') expect(result.candidates).toHaveLength(2);
  });
  it('uses context to distinguish repeated text and reports missing quotes', () => {
    const version = makeVersion(['Первая выплата 100; другая выплата 200.']);
    const start = 7;
    const anchor = createAnchor(version, [{ blockId: 'b0', start, end: start + 7 }]);
    expect(
      reanchorSameVersion(version, changedSpan(anchor, { start: start + 1, end: start + 8 }))
        .status,
    ).toBe('reanchored');
    expect(
      reanchorSameVersion(version, changedSpan(anchor, { exact: 'не существует' })).status,
    ).toBe('not_found');
  });
  it('returns ordered multi-block proposals without losing paragraph boundaries', () => {
    const version = makeVersion(['Первая часть', 'Вторая часть']);
    const anchor = createRangeAnchor(
      version,
      { blockId: 'b0', offset: 0 },
      { blockId: 'b1', offset: 6 },
    );
    const result = reanchorSameVersion(version, changedSpan(anchor, { blockId: 'old-block' }));
    expect(result.status).toBe('reanchored');
    if (result.status === 'reanchored')
      expect(result.anchor.spans.map((s) => s.blockId)).toEqual(['b0', 'b1']);
  });
  it('never silently moves an original citation to a new edition', () => {
    const source = makeVersion(['До выплаты 100 рублей.']);
    const anchor = createAnchor(source, [{ blockId: 'b0', start: 3, end: 10 }]);
    const target = { ...makeVersion(['После выплаты 100 рублей.']), id: 'edition-2027' };
    expect(reanchorSameVersion(target, anchor).status).toBe('rejected');
    const original = JSON.stringify(anchor);
    const result = suggestEditionAnchors(source, anchor, target);
    expect(result.status).toBe('suggestions');
    if (result.status === 'suggestions') {
      expect(result.matches[0]!.match).toBe('exact_quote');
      expect(result.matches[0]!.requiresReview).toBe(true);
      expect(result.matches[0]!.anchor.versionId).toBe('edition-2027');
    }
    expect(JSON.stringify(anchor)).toBe(original);
    expect(
      suggestEditionAnchors(source, anchor, { ...target, documentId: 'unrelated' }).status,
    ).toBe('rejected');
    expect(anchor.normalizationVersion).toBe(NORMALIZATION_VERSION);
  });
  it('reports bounded ambiguity rather than falsely declaring a unique result', () => {
    const version = makeVersion(['x '.repeat(2500)]);
    const anchor = createAnchor(version, [{ blockId: 'b0', start: 0, end: 1 }], {
      contextLength: 0,
    });
    const result = reanchorSameVersion(version, changedSpan(anchor, { start: 1, end: 2 }), {
      limit: 2,
    });
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') expect(result.truncated).toBe(true);
  });
});
