import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PRACTICE_FIELDS,
  evaluatePracticeEvidence,
  getPracticeFieldValue,
  validateAnchor,
  validateDocumentVersion,
} from '../../packages/domain/index';
import type {
  DocumentBlock,
  DocumentMeta,
  DocumentPage,
  DocumentVersion,
  PracticeFamily,
  PracticeOccurrence,
  PracticeVariant,
} from '../../packages/domain/index';
import { safeExternalUrl } from '../../apps/web/src/lib/corpus';

interface CorpusSource {
  repository: string;
  commit: string;
  repositoryPath: string;
  sourceUrl: string;
  pdfUrl: string;
  sha256: string;
  quality: 'full' | 'partial';
  legalCurrency: string;
}
interface CorpusEntry {
  id: string;
  regionId: string;
  versionId?: string;
  textUrl: string | null;
  textHash?: string;
  canonicalHash?: string;
  pageCount: number;
  blockCount: number;
  quality: string;
  availability: string;
  status: string;
  source: CorpusSource;
}
interface Manifest {
  schemaVersion: number;
  source: { repository: string; commit: string };
  stats: Record<string, number>;
  documents: CorpusEntry[];
}
type CanonicalBlock = DocumentBlock & { textHash: string };
type CanonicalPage = DocumentPage & { blockIds: string[]; textHash: string; sourceUrl: string };
interface CanonicalVersion extends DocumentVersion {
  blocks: CanonicalBlock[];
  pages: CanonicalPage[];
}
interface CorpusDocument {
  schemaVersion: number;
  meta: DocumentMeta;
  version: CanonicalVersion;
  source: CorpusSource;
  pageCount: number;
  textHash: string;
  canonicalHash: string;
  extraction: {
    canonicalization: string;
    segmentation: string;
    representationVersion: string;
    offsetEncoding: string;
    sourceHashVerified: boolean;
  };
}
interface CuratedVariant extends PracticeVariant {
  documentId: string;
  sourceUrl: string;
  regionName: string;
  legalCurrency: string;
  effectiveness: string;
  implementationStatus: string;
}
interface CuratedOccurrence extends PracticeOccurrence {
  pageStart: number;
  pageEnd: number;
  sourceUrl: string;
  sourceSha256: string;
  humanReviewRequired: boolean;
  sourceQuoteValidation: string;
}
interface CuratedRelease {
  schemaVersion: number;
  status: string;
  sourceCommit: string;
  normalizationVersion: string;
  offsetEncoding: string;
  families: PracticeFamily[];
  variants: CuratedVariant[];
  occurrences: CuratedOccurrence[];
  catalogComparisons: {
    variantId: string;
    catalogId: string;
    relation: string;
    reviewStatus: string;
    notUsedAsProgramEvidence: boolean;
    catalogSnapshot: { id: string; source_url: string; programCitationStatus: string };
    catalogProvenance: { status: string; commit: string };
  }[];
}

const corpusRoot = new URL('../../public/data/corpus/', import.meta.url);
const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(new URL(relativePath, corpusRoot), 'utf8')) as T;
const manifest = readJson<Manifest>('index.json');
const release = readJson<CuratedRelease>('practices.json');
const availableEntries = manifest.documents.filter((entry) => Boolean(entry.textUrl));
const documents = availableEntries.map((entry) => ({
  entry,
  document: readJson<CorpusDocument>(`documents/${entry.id}.json`),
}));
const documentsById = new Map(documents.map(({ document }) => [document.meta.id, document]));
const versionsById = new Map(
  documents.map(({ document }) => [document.version.id, document.version]),
);
const occurrencesById = new Map(
  release.occurrences.map((occurrence) => [occurrence.id, occurrence]),
);
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const contentUrl = (raw: string): string => {
  const url = new URL(raw);
  url.hash = '';
  return url.href;
};

/** Independently serializes the frozen layout-canonical-v2 representation contract. */
function expectedVersionIdentity(document: CorpusDocument): {
  canonicalHash: string;
  versionId: string;
} {
  const canonicalPayload = [
    document.extraction.representationVersion,
    document.extraction.canonicalization,
    document.extraction.segmentation,
    document.version.blocks.map((block) => [
      block.id,
      block.order,
      block.kind,
      block.pageStart,
      block.pageEnd,
      block.text,
    ]),
    document.version.pages.map((page) => [page.number, page.blockIds, page.textHash]),
  ];
  const canonicalHash = sha256(JSON.stringify(canonicalPayload));
  const versionId = `${document.meta.id}@${document.extraction.representationVersion}-${document.version.sourceSha256!.slice(0, 12)}-${canonicalHash.slice(0, 12)}`;
  return { canonicalHash, versionId };
}

describe('complete published corpus and immutable provenance', () => {
  it('publishes all 80 available source texts and preserves all 89 source passports', () => {
    expect(manifest.documents).toHaveLength(89);
    expect(new Set(manifest.documents.map((entry) => entry.id)).size).toBe(
      manifest.documents.length,
    );
    expect(availableEntries).toHaveLength(80);
    const files = readdirSync(fileURLToPath(new URL('documents/', corpusRoot)))
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(files).toEqual(availableEntries.map((entry) => `${entry.id}.json`).sort());
    expect(manifest.documents.filter((entry) => entry.availability === 'missing')).toHaveLength(5);
    expect(manifest.documents.filter((entry) => entry.availability === 'unavailable')).toHaveLength(
      4,
    );
    for (const entry of availableEntries) {
      expect(entry.textUrl, entry.id).toBe(`/data/corpus/documents/${entry.id}.json`);
      expect(['ready', 'review-required'], entry.id).toContain(entry.status);
    }
    for (const entry of manifest.documents.filter((item) => !item.textUrl)) {
      expect(['ready', 'review-required'], entry.id).not.toContain(entry.status);
    }
  });

  it('validates every version and reconciles source identity, region, normalization and coverage with the manifest', () => {
    const problems: string[] = [];
    for (const { entry, document } of documents) {
      const result = validateDocumentVersion(document.version);
      if (!result.valid) problems.push(`${entry.id}: ${JSON.stringify(result.issues)}`);
      expect(document.meta.id, entry.id).toBe(entry.id);
      expect(document.version.documentId, entry.id).toBe(entry.id);
      expect(document.version.id, entry.id).toBe(entry.versionId);
      expect(document.meta.regionId, entry.id).toBe(entry.regionId);
      expect(document.source.sha256, entry.id).toBe(entry.source.sha256);
      expect(document.version.sourceSha256, entry.id).toBe(entry.source.sha256);
      expect(document.version.normalizationVersion, entry.id).toBe(
        document.extraction.canonicalization,
      );
      expect(document.extraction.offsetEncoding, entry.id).toBe('unicode-code-points');
      expect(document.extraction.sourceHashVerified, entry.id).toBe(true);
      expect(document.version.pages, entry.id).toHaveLength(document.pageCount);
      expect(document.pageCount, entry.id).toBe(entry.pageCount);
      expect(document.version.blocks, entry.id).toHaveLength(entry.blockCount);
      expect(document.version.completeness, entry.id).toBe(
        entry.quality === 'partial' ? 'partial' : 'full',
      );
      expect(document.source.commit, entry.id).toBe(manifest.source.commit);
      expect(document.source.repository, entry.id).toBe(manifest.source.repository);
      expect(document.source.legalCurrency, entry.id).toBe('unverified');
      expect(document.version.sourceUrl, entry.id).toBe(document.source.pdfUrl);
      expect(new URL(document.source.pdfUrl).pathname, entry.id).toContain(
        `/${manifest.source.commit}/`,
      );
    }
    expect(problems).toEqual([]);
    expect(versionsById.size).toBe(documents.length);
    expect(documents.reduce((sum, item) => sum + item.document.pageCount, 0)).toBe(
      manifest.stats.pages,
    );
    expect(documents.reduce((sum, item) => sum + item.document.version.blocks.length, 0)).toBe(
      manifest.stats.blocks,
    );
  });

  it('recomputes every block and complete-text digest from the actual saved canonical text', () => {
    const failures: string[] = [];
    for (const { entry, document } of documents) {
      for (const block of document.version.blocks) {
        if (sha256(block.text) !== block.textHash)
          failures.push(`${entry.id}/${block.id}: block digest`);
      }
      const joinedTextHash = sha256(
        document.version.blocks.map((block) => block.text).join('\n\n'),
      );
      if (joinedTextHash !== document.textHash || joinedTextHash !== entry.textHash)
        failures.push(`${entry.id}: complete-text digest`);
    }
    expect(failures).toEqual([]);
  });

  it('binds the edition ID to the agreed layout-canonical-v2 source and representation hashes', () => {
    const failures: string[] = [];
    for (const { entry, document } of documents) {
      const expected = expectedVersionIdentity(document);
      if (document.extraction.representationVersion !== 'layout-canonical-v2')
        failures.push(`${entry.id}: unsupported canonical representation version`);
      if (document.extraction.segmentation !== 'blank-line-paragraphs-v1')
        failures.push(`${entry.id}: unsupported segmentation version`);
      if (document.canonicalHash !== expected.canonicalHash)
        failures.push(`${entry.id}: document canonical representation digest differs`);
      if (entry.canonicalHash !== expected.canonicalHash)
        failures.push(`${entry.id}: manifest canonical representation digest differs`);
      if (document.version.id !== expected.versionId)
        failures.push(
          `${entry.id}: edition ID is not bound to source and canonical representation`,
        );
    }
    expect(
      failures.length,
      `Canonical identity must match the implemented contract in docs/data-contract-note.md. First failures:\n${failures.slice(0, 6).join('\n')}`,
    ).toBe(0);
  });

  it('retains block-to-page mapping and exact PDF page fragments in public links', () => {
    const failures: string[] = [];
    for (const { entry, document } of documents) {
      const byId = new Map(document.version.blocks.map((block) => [block.id, block]));
      const pageMembership = new Set<string>();
      for (const [index, page] of document.version.pages.entries()) {
        if (page.number !== index + 1) failures.push(`${entry.id}: non-contiguous page numbers`);
        if (new Set(page.blockIds).size !== page.blockIds.length)
          failures.push(`${entry.id}/${page.number}: duplicate block membership`);
        for (const id of page.blockIds) {
          const block = byId.get(id);
          if (
            !block ||
            page.number < (block.pageStart ?? 1) ||
            page.number > (block.pageEnd ?? block.pageStart ?? 1)
          )
            failures.push(`${entry.id}/${page.number}/${id}: invalid page membership`);
          pageMembership.add(id);
        }
        const url = new URL(page.sourceUrl);
        if (
          url.hash !== `#page=${page.number}` ||
          contentUrl(url.href) !== contentUrl(document.version.sourceUrl!)
        )
          failures.push(`${entry.id}/${page.number}: source-page URL changed`);
        const sanitized = safeExternalUrl(page.sourceUrl);
        if (!sanitized || new URL(sanitized).hash !== `#page=${page.number}`)
          failures.push(`${entry.id}/${page.number}: URL sanitizer discarded page fragment`);
      }
      if (
        pageMembership.size !== document.version.blocks.length ||
        document.version.blocks.some((block) => !pageMembership.has(block.id))
      )
        failures.push(`${entry.id}: orphaned canonical blocks`);
    }
    expect(failures).toEqual([]);
  });
});

describe('curated practices and field-level source evidence', () => {
  it('keeps every occurrence exact, in its original edition, and linked to its original source page', () => {
    expect(release.occurrences.length).toBeGreaterThan(0);
    expect(occurrencesById.size).toBe(release.occurrences.length);
    const problems: string[] = [];
    for (const occurrence of release.occurrences) {
      const document = documentsById.get(occurrence.documentId);
      expect(document, occurrence.id).toBeDefined();
      const version = document!.version;
      const result = validateAnchor(version, occurrence.anchor);
      if (!result.valid) problems.push(`${occurrence.id}: ${JSON.stringify(result.issues)}`);
      expect(occurrence.versionId, occurrence.id).toBe(version.id);
      expect(occurrence.anchor.documentId, occurrence.id).toBe(occurrence.documentId);
      expect(occurrence.anchor.versionId, occurrence.id).toBe(occurrence.versionId);
      expect(occurrence.anchor.normalizationVersion, occurrence.id).toBe(
        version.normalizationVersion,
      );
      expect(occurrence.sourceSha256, occurrence.id).toBe(version.sourceSha256);
      const byId = new Map(version.blocks.map((block) => [block.id, block]));
      const selectedBlocks = occurrence.anchor.spans.map((span) => byId.get(span.blockId)!);
      expect(occurrence.pageStart, occurrence.id).toBe(
        Math.min(...selectedBlocks.map((block) => block.pageStart!)),
      );
      expect(occurrence.pageEnd, occurrence.id).toBe(
        Math.max(...selectedBlocks.map((block) => block.pageEnd ?? block.pageStart!)),
      );
      expect(contentUrl(occurrence.sourceUrl), occurrence.id).toBe(contentUrl(version.sourceUrl!));
      expect(new URL(occurrence.sourceUrl).hash, occurrence.id).toBe(
        `#page=${occurrence.pageStart}`,
      );
      expect(new URL(safeExternalUrl(occurrence.sourceUrl)!).hash, occurrence.id).toBe(
        `#page=${occurrence.pageStart}`,
      );
      expect(occurrence.sourceQuoteValidation, occurrence.id).toBe('exact-match');
      expect(occurrence.reviewStatus, occurrence.id).toBe('candidate');
      expect(occurrence.humanReviewRequired, occurrence.id).toBe(true);
    }
    expect(problems).toEqual([]);
  });

  it('matches every reviewedValue to its own field and keeps cross-region variants separate', () => {
    const familyIds = new Set(release.families.map((family) => family.id));
    expect(familyIds.size).toBe(release.families.length);
    expect(new Set(release.variants.map((variant) => variant.id)).size).toBe(
      release.variants.length,
    );
    const referencedOccurrences = new Set<string>();
    for (const variant of release.variants) {
      expect(familyIds.has(variant.familyId), variant.id).toBe(true);
      expect(new Set(variant.occurrenceIds).size, variant.id).toBe(variant.occurrenceIds.length);
      expect(variant.occurrenceIds.length, variant.id).toBeGreaterThan(0);
      const document = documentsById.get(variant.documentId);
      expect(document, variant.id).toBeDefined();
      expect(variant.regionId, variant.id).toBe(document!.meta.regionId);
      expect(variant.regionName, variant.id).toBe(document!.meta.regionName);
      expect(variant.sourceUrl, variant.id).toBe(document!.source.sourceUrl);
      for (const occurrenceId of variant.occurrenceIds) {
        const occurrence = occurrencesById.get(occurrenceId);
        expect(occurrence, `${variant.id}/${occurrenceId}`).toBeDefined();
        expect(occurrence!.documentId, `${variant.id}/${occurrenceId}`).toBe(variant.documentId);
        expect(
          documentsById.get(occurrence!.documentId)?.meta.regionId,
          `${variant.id}/${occurrenceId}`,
        ).toBe(variant.regionId);
        referencedOccurrences.add(occurrenceId);
      }
      for (const evidence of variant.evidence ?? []) {
        if (evidence.kind !== 'fragment') continue;
        expect(PRACTICE_FIELDS, variant.id).toContain(evidence.field);
        expect(variant.occurrenceIds, `${variant.id}/${evidence.field}`).toContain(
          evidence.occurrenceId,
        );
        expect(evidence.reviewedValue, `${variant.id}/${evidence.field}`).toBe(
          getPracticeFieldValue(variant, evidence.field),
        );
        expect(typeof evidence.reviewedValue, `${variant.id}/${evidence.field}`).toBe('string');
        expect(evidence.reviewStatus, `${variant.id}/${evidence.field}`).toBe('candidate');
      }
    }
    expect([...referencedOccurrences].sort()).toEqual([...occurrencesById.keys()].sort());
    const kindergarten = release.variants.filter(
      (variant) => variant.familyId === 'kindergarten-fee-compensation',
    );
    const mordovia = kindergarten.find((variant) => variant.regionId === 'respublika-mordoviia');
    const sakhalin = kindergarten.find((variant) => variant.regionId === 'sakhalinskaia-oblast');
    expect(mordovia).toBeDefined();
    expect(sakhalin).toBeDefined();
    expect(mordovia!.id).not.toBe(sakhalin!.id);
    expect(mordovia!.amount).not.toBe(sakhalin!.amount);
    expect(mordovia!.occurrenceIds.some((id) => sakhalin!.occurrenceIds.includes(id))).toBe(false);
  });

  it('does not label source-exact editorial candidates as human-verified fields or established effectiveness', () => {
    expect(release.status).toBe('editorial-candidates-source-exact-human-review-pending');
    expect(release.offsetEncoding).toBe('unicode-code-points');
    expect(release.sourceCommit).toBe(manifest.source.commit);
    const context = { versions: [...versionsById.values()], occurrences: release.occurrences };
    for (const variant of release.variants) {
      expect(variant.reviewStatus, variant.id).toBe('candidate');
      expect(variant.legalCurrency, variant.id).toBe('unverified');
      expect(variant.effectiveness, variant.id).toBe('unverified');
      const assessment = evaluatePracticeEvidence(variant, context);
      for (const field of PRACTICE_FIELDS) {
        expect(['supported', 'contradicted'], `${variant.id}/${field}`).not.toContain(
          assessment[field].status,
        );
        expect(assessment[field].issues, `${variant.id}/${field}`).toEqual([]);
      }
    }
    expect(release.variants.some((variant) => variant.implementationStatus === 'proposed')).toBe(
      true,
    );
    expect(
      release.variants.some((variant) => variant.implementationStatus === 'period-ended-in-source'),
    ).toBe(true);
  });

  it('keeps secondary catalogue comparisons distinct from programme evidence, including disagreement', () => {
    const catalog = readJson<{
      source: { status: string; commit: string };
      measures: { id: string; source_url: string; programCitationStatus: string }[];
    }>('family-catalog.json');
    const catalogById = new Map(catalog.measures.map((measure) => [measure.id, measure]));
    const variantIds = new Set(release.variants.map((variant) => variant.id));
    expect(catalog.source.status).toBe('secondary-catalog-not-verified-program-citation');
    expect(catalog.source.commit).toBe(manifest.source.commit);
    expect(
      catalog.measures.every((measure) => measure.programCitationStatus === 'unverified'),
    ).toBe(true);
    expect(release.catalogComparisons.length).toBeGreaterThan(0);
    for (const comparison of release.catalogComparisons) {
      expect(variantIds.has(comparison.variantId), comparison.variantId).toBe(true);
      const source = catalogById.get(comparison.catalogId);
      expect(source, comparison.catalogId).toBeDefined();
      expect(comparison.catalogSnapshot.id, comparison.catalogId).toBe(source!.id);
      expect(comparison.catalogSnapshot.source_url, comparison.catalogId).toBe(source!.source_url);
      expect(comparison.reviewStatus, comparison.catalogId).toBe('candidate');
      expect(comparison.notUsedAsProgramEvidence, comparison.catalogId).toBe(true);
      expect(comparison.catalogProvenance.status, comparison.catalogId).toBe(catalog.source.status);
    }
    expect(
      release.catalogComparisons.some((item) => item.relation === 'different-calculation-base'),
    ).toBe(true);
    expect(
      release.catalogComparisons.some(
        (item) => item.relation === 'different-conditions-and-amount',
      ),
    ).toBe(true);
  });
});
