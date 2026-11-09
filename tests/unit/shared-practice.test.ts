import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBundle } from '../../packages/collaboration/schema';

const catalog = JSON.parse(
  readFileSync(new URL('../../public/data/corpus/practices.json', import.meta.url), 'utf8'),
);
const sources = JSON.parse(
  readFileSync(new URL('../../public/data/corpus/index.json', import.meta.url), 'utf8'),
);
function bundle() {
  const v = catalog.variants.find(
    (v: { id: string }) => v.id === 'mordovia-kindergarten-compensation',
  );
  const {
    id,
    familyId,
    regionId,
    title,
    mechanism,
    eligibility,
    amount,
    conditions,
    occurrenceIds,
    evidence,
    reviewStatus,
  } = v;
  const os = catalog.occurrences
    .filter((o: { id: string }) => occurrenceIds.includes(o.id))
    .map(
      (o: {
        id: string;
        documentId: string;
        versionId: string;
        anchor: unknown;
        reviewStatus: string;
        note?: string;
      }) => ({
        id: o.id,
        documentId: o.documentId,
        versionId: o.versionId,
        anchor: o.anchor,
        reviewStatus: o.reviewStatus,
        note: o.note,
      }),
    );
  const m = sources.documents.find((d: { regionId: string }) => d.regionId === v.regionId);
  const d = JSON.parse(readFileSync(new URL(`../../public/${m.textUrl}`, import.meta.url), 'utf8'));
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      practice: {
        id,
        familyId,
        regionId,
        title,
        mechanism,
        eligibility,
        amount,
        conditions,
        occurrenceIds,
        evidence,
        reviewStatus,
      },
      occurrences: os,
      sources: [
        {
          sourceId: d.meta.id,
          editionId: d.version.id,
          title: d.meta.title,
          normalizationVersion: d.version.normalizationVersion,
          regionId: d.meta.regionId,
          sha256: d.source.sha256,
        },
      ],
      note: '',
    }),
  );
}
describe('shared card wire contract preserves evidence boundaries', () => {
  it('accepts the existing prepared card and exact references', () =>
    expect(parseBundle(bundle()).occurrences.length).toBeGreaterThan(0));
  it('does not accept local identity or extra metadata in a publication', () => {
    expect(() => parseBundle({ ...bundle(), email: 'private@example.test' })).toThrow();
    const b = bundle();
    b.practice.createdAt = new Date().toISOString();
    expect(() => parseBundle(b)).toThrow();
  });
  it('requires all referenced occurrences and source editions', () => {
    const b = bundle();
    b.occurrences = [];
    expect(() => parseBundle(b)).toThrow();
    const c = bundle();
    c.sources[0].editionId = 'wrong';
    expect(() => parseBundle(c)).toThrow();
  });
  it('rejects mismatched Unicode offsets and repeated fragment identifiers', () => {
    const b = bundle();
    b.occurrences[0].anchor.spans[0].end++;
    expect(() => parseBundle(b)).toThrow();
    const c = bundle();
    c.occurrences.push(c.occurrences[0]);
    expect(() => parseBundle(c)).toThrow();
  });
  it('requires a captured value for a field marked reviewed', () => {
    const b = bundle();
    b.practice.evidence = [
      {
        kind: 'fragment',
        field: 'title',
        occurrenceId: b.occurrences[0].id,
        relation: 'supports',
        reviewStatus: 'verified',
      },
    ];
    expect(() => parseBundle(b)).toThrow();
  });
});
