import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAnchor, searchDocument, toDocumentVersion, validateAnchor } from '../index';

describe('real extracted corpus integration', () => {
  it('validates the pinned Mordovia document and anchors a search result from a late page', () => {
    const raw = JSON.parse(
      readFileSync(
        new URL(
          '../../../public/data/corpus/documents/regional-respublika-mordoviia.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const version = toDocumentVersion(raw);
    expect(version.blocks.length).toBeGreaterThan(100);
    expect(version.pages?.length).toBe(raw.pageCount);
    const block = version.blocks.at(-1)!;
    const query = Array.from(block.text.trim()).slice(0, 80).join('');
    const result = searchDocument(version, query, { limit: 10000 });
    const hit = result.hits.find((found) => found.blockId === block.id);
    expect(hit).toBeDefined();
    const anchor = createAnchor(version, [hit!]);
    expect(validateAnchor(version, anchor).valid).toBe(true);
    expect(anchor.versionId).toBe(raw.version?.id ?? raw.versionId);
    expect(version.sourceSha256).toBe(raw.source.sha256);
  });
});
