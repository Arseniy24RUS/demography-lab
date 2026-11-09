import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CorpusManifest, RichVariant } from '../../apps/web/src/lib/corpus';
import {
  adaptFamilyCatalog,
  EXTERNAL_CATALOG_FAMILY,
  findPreparedCatalogVariants,
  isFamilyCatalogVariant,
  type FamilyCatalogItem,
  type FamilyCatalogSource,
} from '../../apps/web/src/lib/family-catalog';

const dataRoot = new URL('../../public/data/corpus/', import.meta.url);
const json = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, dataRoot), 'utf8')) as T;
const manifest = json<CorpusManifest>('index.json');
const catalogue = json<{
  schemaVersion: number;
  source: FamilyCatalogSource;
  measures: FamilyCatalogItem[];
}>('family-catalog.json');
const prepared = json<{ variants: RichVariant[] }>('practices.json').variants;
const mordovia = catalogue.measures.find((item) => item.id === 'sovetmam:mord-001')!;
const payload = (items: FamilyCatalogItem[]) => ({ ...catalogue, measures: items });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('complete source catalogue adapter', () => {
  it('keeps all 2,274 source cards, maps all 89 regional names, and separates federal scope', () => {
    const variants = adaptFamilyCatalog(catalogue, manifest);
    expect(variants).toHaveLength(2274);
    expect(new Set(variants.map((item) => item.id)).size).toBe(2274);
    expect(variants.every((item) => item.id.startsWith('catalog-'))).toBe(true);
    expect(variants.filter((item) => item.scope === 'regional')).toHaveLength(2163);
    expect(variants.filter((item) => item.scope === 'federal')).toHaveLength(111);
    expect(variants.filter((item) => item.scope === 'unknown')).toHaveLength(0);
    expect(
      new Set(variants.filter((item) => item.scope === 'regional').map((item) => item.regionId))
        .size,
    ).toBe(89);
    const regions = new Map(manifest.documents.map((entry) => [entry.territory, entry.regionId]));
    for (const [index, variant] of variants.entries()) {
      const item = catalogue.measures[index];
      expect(variant.catalogId).toBe(item.id);
      expect(variant.regionId).toBe(
        item.level === 'federal' ? 'federal' : regions.get(item.region!),
      );
      expect(variant).toMatchObject({
        origin: 'catalog',
        familyId: 'external-catalog',
        groupingStatus: 'temporary-ungrouped',
        reviewStatus: 'candidate',
        evidence: [],
        occurrenceIds: [],
      });
      expect(variant.title).toBe(item.title);
      expect(variant.mechanism).toBe(item.summary);
      expect(variant.amount).toBe(item.benefit);
      expect(variant.eligibility).toBeUndefined();
      expect(variant.conditions).toBeUndefined();
      expect(variant.snapshot).toEqual(item);
      expect(variant.provenance.catalog).toEqual(catalogue.source);
    }
    expect(EXTERNAL_CATALOG_FAMILY.id).toBe('external-catalog');
  });

  it('normalizes typography only, refusing shortened, extended and ambiguous territory names', () => {
    const sample = { ...mordovia, region: '  Ханты‑Мансийский\u00a0автономный округ – Югра  ' };
    expect(adaptFamilyCatalog(payload([sample]), manifest)[0]).toMatchObject({
      regionId: 'khanty-mansiiskii-avtonomnyi-okrug-iugra',
      scope: 'regional',
      territoryResolution: 'manifest-exact',
    });
    for (const region of ['Мордовия', 'Республика Мордовия, Саранск', null]) {
      expect(adaptFamilyCatalog(payload([{ ...mordovia, region }]), manifest)[0]).toMatchObject({
        regionId: 'unknown',
        scope: 'unknown',
        territoryResolution: 'unknown-territory',
      });
    }
    const sourceEntry = manifest.documents.find(
      (entry) => entry.regionId === 'respublika-mordoviia',
    )!;
    const ambiguousManifest = {
      ...manifest,
      documents: [...manifest.documents, { ...sourceEntry, regionId: 'another-region' }],
    };
    expect(adaptFamilyCatalog(payload([mordovia]), ambiguousManifest)[0]).toMatchObject({
      scope: 'unknown',
      territoryResolution: 'ambiguous-territory',
    });
    expect(
      adaptFamilyCatalog(payload([{ ...mordovia, level: 'municipal' }]), manifest)[0],
    ).toMatchObject({
      scope: 'unknown',
      territoryResolution: 'unknown-level',
    });
  });

  it('copies explicit fields and preserves notes without turning them into eligibility or evidence', () => {
    const item = {
      ...mordovia,
      eligibility: 'Получатели прямо названы в исходном поле.',
      conditions: ['Условие из структурированного поля.'],
      detail: {
        notes: ['Примечание каталога, которое не является автоматически проверенным условием.'],
      },
    };
    const variant = adaptFamilyCatalog(payload([item]), manifest)[0];
    expect(variant.eligibility).toBe(item.eligibility);
    expect(variant.conditions).toEqual(item.conditions);
    expect(variant.provenance.fieldPaths).toEqual({
      title: 'title',
      mechanism: 'summary',
      amount: 'benefit',
      eligibility: 'eligibility',
      conditions: 'conditions',
    });
    expect(variant.provenance).toMatchObject({
      kind: 'secondary-catalog',
      programCitationStatus: 'unverified',
      legalCurrency: 'unverified',
    });
    expect(variant.snapshot.detail).toEqual(item.detail);
    expect(variant.evidence).toEqual([]);
    expect(isFamilyCatalogVariant(variant)).toBe(true);
    expect(isFamilyCatalogVariant(prepared[0])).toBe(false);
  });

  it('retains unknown amounts and blocks unsafe clickable URLs while preserving the original snapshot', () => {
    const variant = adaptFamilyCatalog(
      payload([{ ...mordovia, benefit: null, source_url: 'javascript:alert(1)' }]),
      manifest,
    )[0];
    expect(variant.amount).toBeNull();
    expect(variant.sourceUrl).toBeUndefined();
    expect(variant.snapshot.source_url).toBe('javascript:alert(1)');
    const fallback = adaptFamilyCatalog(
      payload([{ ...mordovia, summary: '', benefit: 'Услуга без указанной денежной суммы.' }]),
      manifest,
    )[0];
    expect(fallback.mechanism).toBe('Услуга без указанной денежной суммы.');
    expect(fallback.provenance.fieldPaths.mechanism).toBe('benefit');
  });

  it('links by source catalogId without replacing a programme proposal by a differently worded measure', () => {
    const variants = adaptFamilyCatalog(catalogue, manifest);
    const variant = variants.find((item) => item.catalogId === 'sovetmam:mord-001')!;
    const related = findPreparedCatalogVariants(variant, prepared);
    expect(related.map((item) => item.id)).toEqual(['mordovia-first-child-proposal']);
    expect(variant.amount).toBe('100 000 ₽');
    expect(related[0].amount).toContain('150');
    expect(related[0].id).not.toBe(variant.id);
    expect(variants).toHaveLength(2274);
    expect(prepared).toHaveLength(15);
    expect(findPreparedCatalogVariants({}, prepared)).toEqual([]);
    expect(findPreparedCatalogVariants(variant, [...prepared, variant])).toEqual(related);
    expect(
      variants.filter((item) => findPreparedCatalogVariants(item, prepared).length),
    ).toHaveLength(8);
  });

  it('has deterministic edition-aware IDs and rejects duplicate upstream card IDs', () => {
    const original = adaptFamilyCatalog(catalogue, manifest);
    const reversed = adaptFamilyCatalog(
      { ...catalogue, measures: [...catalogue.measures].reverse() },
      manifest,
    );
    expect(new Map(reversed.map((item) => [item.catalogId, item.id]))).toEqual(
      new Map(original.map((item) => [item.catalogId, item.id])),
    );
    const anotherEdition = adaptFamilyCatalog(
      { ...payload([mordovia]), source: { ...catalogue.source, commit: 'f'.repeat(40) } },
      manifest,
    )[0];
    expect(anotherEdition.id).not.toBe(original.find((item) => item.catalogId === mordovia.id)!.id);
    expect(() => adaptFamilyCatalog(payload([mordovia, mordovia]), manifest)).toThrow(
      'Повторяющийся идентификатор',
    );
  });
});

describe('explicit lazy loading', () => {
  it('fetches only on request, shares an in-flight fetch and rebinds cached data to the supplied manifest', async () => {
    vi.resetModules();
    vi.stubEnv('BASE_URL', '/workshop/');
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { loadFamilyCatalog } = await import('../../apps/web/src/lib/family-catalog');
    expect(fetchMock).not.toHaveBeenCalled();
    const first = loadFamilyCatalog(manifest);
    const second = loadFamilyCatalog(manifest);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/workshop/data/corpus/family-catalog.json');
    resolveResponse(
      new Response(JSON.stringify(payload([mordovia])), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect((await first)[0].regionId).toBe('respublika-mordoviia');
    expect((await second)[0].id).toBe((await first)[0].id);
    const withoutRegions = await loadFamilyCatalog({ ...manifest, documents: [] });
    expect(withoutRegions[0].regionId).toBe('unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('permits retry after an HTTP error or an HTML fallback and never returns partial malformed data', async () => {
    vi.resetModules();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('Service unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response('<html>Fallback</html>', { headers: { 'content-type': 'text/html' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ schemaVersion: 9, measures: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload([mordovia])), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { loadFamilyCatalog } = await import('../../apps/web/src/lib/family-catalog');
    await expect(loadFamilyCatalog(manifest)).rejects.toThrow('503');
    await expect(loadFamilyCatalog(manifest)).rejects.toThrow('страницу вместо каталога');
    await expect(loadFamilyCatalog(manifest)).rejects.toThrow('не поддерживается его версия');
    await expect(loadFamilyCatalog(manifest)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
