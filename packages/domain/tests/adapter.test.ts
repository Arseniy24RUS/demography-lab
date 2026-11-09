import { describe, expect, it } from 'vitest';
import {
  NORMALIZATION_VERSION,
  POPPLER_NORMALIZATION_VERSION,
  createAnchor,
  toDocumentVersion,
} from '../index';

describe('ingestion boundary adapter', () => {
  it('preserves hashed corpus text and normalization while converting block metadata', () => {
    const data = {
      id: 'doc',
      versionId: 'edition',
      extraction: {
        canonicalization: POPPLER_NORMALIZATION_VERSION,
        offsetEncoding: 'unicode-code-points',
      },
      source: { sha256: 'a'.repeat(64), quality: 'full' },
      pages: [{ pageNumber: 1 }, { pageNumber: 2 }],
      blocks: [
        { id: 'p1b1', ordinal: 1, type: 'paragraph', page: 1, text: '😀 Первая страница' },
        { id: 'p2b1', ordinal: 1, type: 'paragraph', page: 2, text: 'Вторая страница' },
      ],
    };
    const version = toDocumentVersion(data);
    expect(version.normalizationVersion).toBe(POPPLER_NORMALIZATION_VERSION);
    expect(version.blocks.map((b) => b.order)).toEqual([0, 1]);
    expect(version.blocks[0]!.text).toBe(data.blocks[0]!.text);
    expect(version.pages?.[1]!.number).toBe(2);
    expect(createAnchor(version, [{ blockId: 'p1b1', start: 0, end: 1 }]).spans[0]!.exact).toBe(
      '😀',
    );
  });
  it('does not invent normalization or silently normalize damaged canonical text', () => {
    const document = { id: 'd', versionId: 'v', blocks: [{ id: 'b', text: 'е\u0308' }] };
    expect(() => toDocumentVersion(document)).toThrow();
    expect(() =>
      toDocumentVersion({ ...document, normalizationVersion: NORMALIZATION_VERSION }),
    ).toThrow();
  });
  it('accepts metadata/content envelopes and rejects cross-edition block IDs', () => {
    const document = {
      metadata: { id: 'd', versionId: 'v', normalizationVersion: NORMALIZATION_VERSION },
      content: {
        blocks: [{ id: 'b', order: 0, kind: 'paragraph', text: 'Текст', documentVersionId: 'v' }],
      },
    };
    expect(toDocumentVersion(document).id).toBe('v');
    expect(() =>
      toDocumentVersion({
        ...document,
        content: { blocks: [{ ...document.content.blocks[0], documentVersionId: 'another' }] },
      }),
    ).toThrow();
  });
});
