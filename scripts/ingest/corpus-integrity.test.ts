import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateAnchor, validateDocumentVersion } from '../../packages/domain/src/index';
import type { DocumentMeta, DocumentVersion, PracticeOccurrence, PracticeVariant } from '../../packages/domain/src/index';

const root = resolve(process.cwd(), 'public/data/corpus');
const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const index = read('index.json');
const curated = read('practices.json') as { variants: PracticeVariant[]; occurrences: PracticeOccurrence[]; catalogComparisons: { relation: string; notUsedAsProgramEvidence: boolean }[] };
const versions = new Map<string, DocumentVersion>();

// These are source-integrity checks, not claims that legal norms are current.
describe('real pinned corpus integrity', () => {
  it('imports every available source, keeping unavailable regional passports', () => {
    expect(index.documents).toHaveLength(89);
    expect(index.documents.filter((d: { textUrl: string | null }) => d.textUrl)).toHaveLength(80);
    expect(index.stats.pages).toBe(6340);
    expect(index.documents.filter((d: { availability: string }) => d.availability === 'missing')).toHaveLength(5);
    expect(index.documents.filter((d: { availability: string }) => d.availability === 'unavailable')).toHaveLength(4);
  });

  it('validates every canonical version and the hash of every block', () => {
    let blockCount = 0;
    for (const record of index.documents) {
      if (!record.textUrl) continue;
      const doc = read(`documents/${record.id}.json`) as { meta: DocumentMeta; version: DocumentVersion; textHash: string; canonicalHash: string; extraction: { representationVersion: string; canonicalization: string; segmentation: string } };
      const result = validateDocumentVersion(doc.version);
      expect(result.valid, record.id + ': ' + JSON.stringify(result.issues)).toBe(true);
      expect(doc.version.documentId).toBe(record.id);
      expect(doc.version.sourceSha256).toBe(record.source.sha256);
      expect(doc.version.pages).toHaveLength(record.pageCount);
      const canonicalIdentity = [doc.extraction.representationVersion, doc.extraction.canonicalization, doc.extraction.segmentation,
        doc.version.blocks.map(b => [b.id, b.order, b.kind, b.pageStart, b.pageEnd, b.text]),
        (doc.version.pages as { number: number; blockIds: string[]; textHash: string }[]).map(p => [p.number, p.blockIds, p.textHash])];
      const canonicalHash = createHash('sha256').update(JSON.stringify(canonicalIdentity), 'utf8').digest('hex');
      expect(canonicalHash).toBe(doc.canonicalHash);
      expect(createHash('sha256').update(doc.version.blocks.map(b => b.text).join('\n\n'), 'utf8').digest('hex')).toBe(doc.textHash);
      expect(doc.version.id).toBe(`${record.id}@${doc.extraction.representationVersion}-${doc.version.sourceSha256?.slice(0, 12)}-${canonicalHash.slice(0, 12)}`);
      expect(record.versionId).toBe(doc.version.id);
      expect(record.canonicalHash).toBe(canonicalHash);
      for (const b of doc.version.blocks as (DocumentVersion['blocks'][number] & { textHash: string })[]) {
        expect(createHash('sha256').update(b.text, 'utf8').digest('hex'), b.id).toBe(b.textHash);
      }
      blockCount += doc.version.blocks.length;
      versions.set(record.id, doc.version);
    }
    expect(blockCount).toBe(index.stats.blocks);
  });

  it('keeps every curated field quote exact and tied to its immutable edition', () => {
    expect(curated.variants).toHaveLength(15);
    expect(curated.occurrences).toHaveLength(56);
    for (const occurrence of curated.occurrences) {
      const version = versions.get(occurrence.documentId) ?? read(`documents/${occurrence.documentId}.json`).version;
      const result = validateAnchor(version, occurrence.anchor);
      expect(result.valid, occurrence.id + ': ' + JSON.stringify(result.issues)).toBe(true);
      expect(occurrence.reviewStatus).toBe('candidate');
    }
    const ids = new Set(curated.occurrences.map(o => o.id));
    for (const variant of curated.variants) {
      for (const evidence of variant.evidence ?? []) {
        if (evidence.kind !== 'fragment') continue;
        expect(ids.has(evidence.occurrenceId)).toBe(true);
        expect(evidence.reviewedValue).toBe(variant[evidence.field]);
        expect(evidence.reviewStatus).toBe('candidate');
      }
    }
  });

  it('does not promote catalogue similarity to programme evidence', () => {
    expect(curated.catalogComparisons).toHaveLength(8);
    expect(curated.catalogComparisons.every(x => x.notUsedAsProgramEvidence)).toBe(true);
    expect(curated.catalogComparisons.some(x => x.relation === 'different-calculation-base')).toBe(true);
    expect(curated.catalogComparisons.some(x => x.relation === 'different-conditions-and-amount')).toBe(true);
  });
});
