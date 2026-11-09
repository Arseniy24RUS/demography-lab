import { describe, expect, it } from 'vitest';
import { createAnchor, searchDocument, validateAnchor } from '../index';
import { makeVersion } from './fixtures';

describe('full-corpus code-point search', () => {
  it('finds later blocks regardless of reader pagination and returns source-valid anchors', () => {
    const version = makeVersion(
      Array.from({ length: 100 }, (_, i) =>
        i === 99 ? '😀 Компенсация найма жилья' : 'Текст программы',
      ),
    );
    const result = searchDocument(version, 'КОМПЕНСАЦИЯ');
    expect(result.totalMatches).toBe(1);
    const hit = result.hits[0]!;
    expect(hit.blockId).toBe('b99');
    expect(hit.start).toBe(2);
    expect(hit.pageStart).toBe(100);
    expect(hit.exact).toBe('Компенсация');
    expect(validateAnchor(version, createAnchor(version, [hit])).valid).toBe(true);
    expect(searchDocument(version, 'компенсация').hits[0]!.id).toBe(hit.id);
  });
  it('folds ё independently of case and preserves the original text', () => {
    const version = makeVersion(['😀 Ёлка ёлка елка']);
    expect(searchDocument(version, 'елка').totalMatches).toBe(3);
    expect(searchDocument(version, 'ёлка', { foldYo: false }).totalMatches).toBe(2);
    expect(
      searchDocument(version, 'Ёлка', { caseSensitive: true, foldYo: false }).totalMatches,
    ).toBe(1);
    expect(searchDocument(version, 'е\u0308лка', { foldYo: false }).hits[0]!.exact).toBe('Ёлка');
  });
  it('keeps offsets correct for lowercase expansions and rejects half-character matches', () => {
    const version = makeVersion(['😀 İ test']);
    expect(searchDocument(version, 'i').totalMatches).toBe(0);
    const hit = searchDocument(version, 'i\u0307').hits[0]!;
    expect(hit.exact).toBe('İ');
    expect(hit.start).toBe(2);
    expect(hit.end).toBe(3);
  });
  it('counts overlapping occurrences and reports pagination without hiding the denominator', () => {
    const version = makeVersion(['аааа']);
    const result = searchDocument(version, 'аа', { limit: 1, offset: 1 });
    expect(result.totalMatches).toBe(3);
    expect(result.hits[0]!.start).toBe(1);
    expect(result.truncated).toBe(true);
  });
  it('supports word boundaries, empty-query handling and rejects unsafe bounds', () => {
    const version = makeVersion(['Семья, семьям.']);
    expect(searchDocument(version, 'семья').totalMatches).toBe(2);
    expect(searchDocument(version, 'семья', { wholeWords: true }).totalMatches).toBe(1);
    expect(searchDocument(version, '  ').hits).toEqual([]);
    expect(() => searchDocument(version, 'семья', { offset: -1 })).toThrow();
    expect(() => searchDocument(version, 'семья', { limit: 0 })).toThrow();
  });
});
