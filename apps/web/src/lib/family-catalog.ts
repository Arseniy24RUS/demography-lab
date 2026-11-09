import { stableId } from '@domain/index';
import type { PracticeFamily, PracticeField } from '@domain/index';
import { assetUrl, safeExternalUrl } from './corpus';
import type { CorpusManifest, RichVariant } from './corpus';

/** A holding group, not a claim that its cards share the same policy mechanism. */
export const EXTERNAL_CATALOG_FAMILY: PracticeFamily = {
  id: 'external-catalog',
  title: 'Исходный каталог мер',
  mechanism: 'Временная группа несопоставленных карточек внешнего каталога.',
  description:
    'Категория источника не определяет семейство практик. Условия разных карточек не объединяются автоматически.',
};

export interface FamilyCatalogSource {
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly originalSource: string;
  readonly fetchedAt: string;
  readonly status: string;
  readonly [key: string]: unknown;
}

export interface FamilyCatalogItem {
  readonly id: string;
  readonly title: string;
  readonly level: string;
  readonly region: string | null;
  readonly category: string;
  readonly summary: string;
  readonly benefit: string | null;
  readonly source: string;
  readonly source_name: string;
  readonly source_url: string;
  readonly fetched_at: string;
  readonly content_hash: string;
  readonly eligibility?: string | null;
  readonly conditions?: readonly string[];
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly [key: string]: unknown;
}

export type CatalogTerritoryResolution =
  | 'manifest-exact'
  | 'explicit-federal'
  | 'unknown-territory'
  | 'ambiguous-territory'
  | 'unknown-level';

export interface FamilyCatalogVariant extends RichVariant {
  readonly origin: 'catalog';
  readonly scope: 'regional' | 'federal' | 'unknown';
  readonly familyId: 'external-catalog';
  readonly groupingStatus: 'temporary-ungrouped';
  readonly catalogId: string;
  readonly territoryResolution: CatalogTerritoryResolution;
  readonly provenance: {
    readonly kind: 'secondary-catalog';
    readonly catalog: FamilyCatalogSource;
    readonly catalogId: string;
    readonly sourceName: string;
    readonly fetchedAt: string;
    /** Copied upstream metadata, not a client-side verification of the snapshot. */
    readonly declaredContentHash: string;
    readonly programCitationStatus: 'unverified';
    readonly legalCurrency: 'unverified';
    readonly fieldPaths: Readonly<Partial<Record<PracticeField, string>>>;
    readonly territoryNormalization: 'nfc-case-space-dash-v1';
  };
  /** Exact source fields, including notes, steps and documents; never inferred eligibility. */
  readonly snapshot: FamilyCatalogItem;
}

interface FamilyCatalogPayload {
  schemaVersion: 1;
  source: FamilyCatalogSource;
  measures: FamilyCatalogItem[];
}
interface RegionBinding {
  regionId: string;
  regionName: string;
}
type TerritoryDictionary = Map<string, RegionBinding | null>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requiredString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Повреждён каталог мер: отсутствует ${path}.`);
}

/** Only typographic normalization: no aliases, transliteration or partial matches. */
function territoryKey(value: string): string {
  return value
    .normalize('NFC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[‐‑‒–—−]/gu, '-')
    .replace(/\s*-\s*/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
}
function territoryDictionary(manifest: CorpusManifest): TerritoryDictionary {
  const dictionary: TerritoryDictionary = new Map();
  for (const entry of manifest.documents) {
    const key = territoryKey(entry.territory);
    if (!key || !entry.regionId.trim()) continue;
    if (!dictionary.has(key))
      dictionary.set(key, { regionId: entry.regionId, regionName: entry.territory });
    else if (dictionary.get(key)?.regionId !== entry.regionId) dictionary.set(key, null);
  }
  return dictionary;
}
function resolveTerritory(
  item: FamilyCatalogItem,
  dictionary: TerritoryDictionary,
): Pick<FamilyCatalogVariant, 'scope' | 'regionId' | 'regionName' | 'territoryResolution'> {
  if (item.level === 'federal')
    return {
      scope: 'federal',
      regionId: 'federal',
      regionName: 'Федеральный уровень',
      territoryResolution: 'explicit-federal',
    };
  const unknown = {
    scope: 'unknown' as const,
    regionId: 'unknown',
    regionName: item.region || 'Территория не определена',
  };
  if (item.level !== 'regional') return { ...unknown, territoryResolution: 'unknown-level' };
  const binding = item.region ? dictionary.get(territoryKey(item.region)) : undefined;
  if (binding) return { ...binding, scope: 'regional', territoryResolution: 'manifest-exact' };
  return {
    ...unknown,
    territoryResolution: binding === null ? 'ambiguous-territory' : 'unknown-territory',
  };
}

function parsePayload(raw: unknown): FamilyCatalogPayload {
  if (
    !record(raw) ||
    raw.schemaVersion !== 1 ||
    !record(raw.source) ||
    !Array.isArray(raw.measures)
  ) {
    throw new Error('Повреждён каталог мер или не поддерживается его версия.');
  }
  for (const field of [
    'repository',
    'commit',
    'path',
    'url',
    'sha256',
    'originalSource',
    'fetchedAt',
    'status',
  ]) {
    requiredString(raw.source[field], `source.${field}`);
  }
  const ids = new Set<string>();
  for (const [index, item] of raw.measures.entries()) {
    const path = `measures[${index}]`;
    if (!record(item)) throw new Error(`Повреждена карточка ${path}.`);
    for (const field of [
      'id',
      'title',
      'level',
      'category',
      'source',
      'source_name',
      'source_url',
      'fetched_at',
      'content_hash',
    ]) {
      requiredString(item[field], `${path}.${field}`);
    }
    if (
      typeof item.summary !== 'string' ||
      (item.benefit !== null && typeof item.benefit !== 'string') ||
      (item.region !== null && typeof item.region !== 'string') ||
      (item.detail !== null && !record(item.detail))
    ) {
      throw new Error(`Некорректные поля карточки ${path}.`);
    }
    if (!item.summary.trim() && !(typeof item.benefit === 'string' && item.benefit.trim())) {
      throw new Error(`В карточке ${path} отсутствует описание меры.`);
    }
    if (
      Object.hasOwn(item, 'eligibility') &&
      item.eligibility !== null &&
      typeof item.eligibility !== 'string'
    ) {
      throw new Error(`Некорректные получатели в карточке ${path}.`);
    }
    if (
      Object.hasOwn(item, 'conditions') &&
      (!Array.isArray(item.conditions) || item.conditions.some((x) => typeof x !== 'string'))
    ) {
      throw new Error(`Некорректные условия в карточке ${path}.`);
    }
    const id = item.id as string;
    if (ids.has(id)) throw new Error(`Повторяющийся идентификатор карточки ${id}.`);
    ids.add(id);
  }
  return raw as unknown as FamilyCatalogPayload;
}

function adaptPayload(
  payload: FamilyCatalogPayload,
  manifest: CorpusManifest,
): FamilyCatalogVariant[] {
  const dictionary = territoryDictionary(manifest);
  return payload.measures.map((item) => {
    const mechanismPath = item.summary.trim() ? 'summary' : 'benefit';
    const fieldPaths: Partial<Record<PracticeField, string>> = {
      title: 'title',
      mechanism: mechanismPath,
      amount: 'benefit',
    };
    if (Object.hasOwn(item, 'eligibility')) fieldPaths.eligibility = 'eligibility';
    if (Object.hasOwn(item, 'conditions')) fieldPaths.conditions = 'conditions';
    return {
      // The pinned snapshot participates in identity; changed editions cannot reuse old links.
      id: stableId(
        'catalog',
        payload.source.repository,
        payload.source.commit,
        item.id,
        item.content_hash,
      ).replace(/^catalog_/, 'catalog-'),
      familyId: 'external-catalog',
      groupingStatus: 'temporary-ungrouped',
      origin: 'catalog',
      ...resolveTerritory(item, dictionary),
      title: item.title,
      mechanism: mechanismPath === 'summary' ? item.summary : item.benefit!,
      amount: item.benefit,
      ...(Object.hasOwn(item, 'eligibility') ? { eligibility: item.eligibility } : {}),
      ...(Object.hasOwn(item, 'conditions') ? { conditions: item.conditions } : {}),
      category: item.category,
      description: item.summary,
      catalogId: item.id,
      sourceUrl: safeExternalUrl(item.source_url),
      evidence: [],
      occurrenceIds: [],
      reviewStatus: 'candidate',
      provenance: {
        kind: 'secondary-catalog',
        catalog: payload.source,
        catalogId: item.id,
        sourceName: item.source_name,
        fetchedAt: item.fetched_at,
        declaredContentHash: item.content_hash,
        programCitationStatus: 'unverified',
        legalCurrency: 'unverified',
        fieldPaths,
        territoryNormalization: 'nfc-case-space-dash-v1',
      },
      snapshot: item,
    };
  });
}

/** Pure adapter; it retains every distinct source card without merging its conditions. */
export function adaptFamilyCatalog(raw: unknown, manifest: CorpusManifest): FamilyCatalogVariant[] {
  return adaptPayload(parsePayload(raw), manifest);
}

let payloadRequest: Promise<FamilyCatalogPayload> | undefined;

/** Called by an explicit UI action. Importing this module never fetches the catalogue. */
export async function loadFamilyCatalog(manifest: CorpusManifest): Promise<RichVariant[]> {
  if (!payloadRequest) {
    payloadRequest = (async () => {
      const response = await fetch(assetUrl('data/corpus/family-catalog.json'));
      if (!response.ok) throw new Error(`Не удалось загрузить каталог мер (${response.status}).`);
      if (response.headers.get('content-type')?.includes('text/html')) {
        throw new Error('Сервер вернул страницу вместо каталога мер. Проверьте путь запуска.');
      }
      return parsePayload(await response.json());
    })();
    // Concurrent calls share a request; a failed fetch can be retried by the same button.
    const pending = payloadRequest;
    void pending.catch(() => {
      if (payloadRequest === pending) payloadRequest = undefined;
    });
  }
  // Bind after retrieval: the same cached source must not retain an earlier session's regions.
  return adaptPayload(await payloadRequest, manifest);
}

export function isFamilyCatalogVariant(variant: RichVariant): variant is FamilyCatalogVariant {
  return (
    'origin' in variant &&
    variant.origin === 'catalog' &&
    'snapshot' in variant &&
    record(variant.snapshot)
  );
}

/** Identity link only. The caller must keep both variants and compare their distinct fields. */
export function findPreparedCatalogVariants(
  variant: Pick<RichVariant, 'catalogId'>,
  prepared: readonly RichVariant[],
): RichVariant[] {
  return variant.catalogId
    ? prepared.filter(
        (item) => item.catalogId === variant.catalogId && !isFamilyCatalogVariant(item),
      )
    : [];
}
