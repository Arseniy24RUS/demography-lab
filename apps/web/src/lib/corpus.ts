import { toDocumentVersion, validateDocumentVersion } from '@domain/index';
import type {
  DocumentVersion,
  DocumentBlock,
  PracticeFamily,
  PracticeVariant,
  PracticeOccurrence,
} from '@domain/index';

export interface SourceMetadata {
  sourceUrl?: string;
  pdfUrl?: string;
  officialUrl?: string | null;
  sha256?: string;
  act?: string;
  edition?: string;
  originalFilename?: string;
  qualityNote?: string;
  period?: { label?: string; start_year?: number; end_year?: number };
  legalCurrencyNote?: string;
}
export interface CorpusEntry {
  id: string;
  regionId: string;
  title: string;
  territory: string;
  status: string;
  pageCount: number;
  blockCount?: number;
  textUrl?: string;
  versionId?: string;
  quality?: string;
  availability?: string;
  source: SourceMetadata;
  extractionWarnings?: string[];
  emptyPages?: number[];
}
export interface CorpusManifest {
  schemaVersion: number;
  generatedAt: string;
  documents: CorpusEntry[];
  stats?: Record<string, number>;
  scopeNote?: string;
}
export interface CorpusDocument {
  entry: CorpusEntry;
  version: DocumentVersion;
  extraction?: { note?: string; warnings?: string[] };
}
export interface RichVariant extends PracticeVariant {
  catalogId?: string;
  sourceUrl?: string;
  regionName?: string;
  category?: string;
  description?: string;
  implementationStatus?: string;
}
export interface CatalogComparison {
  variantId: string;
  catalogId: string;
  relation: string;
  note: string;
  catalogSnapshot: {
    title: string;
    summary?: string;
    benefit?: string;
    fetched_at?: string;
    source_url?: string;
  };
  catalogProvenance?: { url?: string; commit?: string };
  notUsedAsProgramEvidence: boolean;
}
export interface PracticeCatalog {
  families: PracticeFamily[];
  variants: RichVariant[];
  occurrences: PracticeOccurrence[];
  catalogComparisons: CatalogComparison[];
}
const cache = new Map<string, CorpusDocument>();
const inflight = new Map<string, Promise<CorpusDocument>>();

export function assetUrl(path: string) {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
}
export function safeExternalUrl(raw: string | undefined | null) {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}
async function jsonFile(path: string, signal?: AbortSignal): Promise<unknown> {
  const r = await fetch(assetUrl(path), { signal });
  if (!r.ok) throw new Error(`Не удалось загрузить материал (${r.status}).`);
  const contentType = r.headers.get('content-type') ?? '';
  if (contentType.includes('text/html'))
    throw new Error('Сервер вернул страницу вместо файла данных. Проверьте путь запуска.');
  return r.json();
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export async function loadManifest(signal?: AbortSignal): Promise<CorpusManifest> {
  const raw = await jsonFile('data/corpus/index.json', signal);
  if (!record(raw) || !Array.isArray(raw.documents))
    throw new Error('Повреждён каталог документов.');
  const documents = raw.documents.map((x: unknown) => {
    if (
      !record(x) ||
      typeof x.id !== 'string' ||
      !/^[-a-zа-яё0-9_]+$/i.test(x.id) ||
      typeof x.title !== 'string'
    )
      throw new Error('Некорректный паспорт источника.');
    return {
      ...x,
      id: x.id,
      title: x.title,
      regionId: String(x.regionId ?? x.id),
      territory: String(x.territory ?? x.region ?? x.title),
      source: record(x.source) ? x.source : {},
      pageCount: Number(x.pageCount ?? 0),
      status: String(x.status ?? 'unavailable'),
    } as CorpusEntry;
  });
  return {
    schemaVersion: Number(raw.schemaVersion ?? 1),
    generatedAt: String(raw.generatedAt ?? ''),
    documents,
    stats: record(raw.stats) ? (raw.stats as Record<string, number>) : undefined,
    scopeNote: typeof raw.scopeNote === 'string' ? raw.scopeNote : undefined,
  };
}
export async function loadCatalog(signal?: AbortSignal): Promise<PracticeCatalog> {
  const raw = await jsonFile('data/corpus/practices.json', signal);
  if (!record(raw)) throw new Error('Некорректный каталог практик.');
  const variants = raw.variants ?? raw.practices;
  if (!Array.isArray(variants) || !Array.isArray(raw.occurrences) || !Array.isArray(raw.families))
    throw new Error('В каталоге отсутствуют варианты, семейства или цитаты.');
  for (const item of variants) {
    if (
      !record(item) ||
      typeof item.id !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.mechanism !== 'string' ||
      !Array.isArray(item.occurrenceIds)
    )
      throw new Error('Некорректная карточка практики.');
  }
  return {
    variants: variants as RichVariant[],
    occurrences: raw.occurrences as PracticeOccurrence[],
    families: raw.families as PracticeFamily[],
    catalogComparisons: Array.isArray(raw.catalogComparisons)
      ? (raw.catalogComparisons as CatalogComparison[])
      : [],
  };
}
export async function loadDocument(entry: CorpusEntry): Promise<CorpusDocument> {
  const key = entry.versionId ?? entry.id;
  if (cache.has(key)) {
    const value = cache.get(key)!;
    cache.delete(key);
    cache.set(key, value);
    return value;
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = (async () => {
    if (
      !entry.textUrl ||
      !/^\/?data\/corpus\/documents\/[-a-zа-яё0-9_]+\.json$/i.test(entry.textUrl)
    )
      throw new Error('Полный текст пока не подготовлен. Доступен паспорт источника.');
    const raw = await jsonFile(entry.textUrl);
    if (!record(raw)) throw new Error('Некорректный текст документа.');
    const version = toDocumentVersion(raw);
    const checked = validateDocumentVersion(version);
    if (!checked.valid)
      throw new Error(
        `Текст не прошёл проверку целостности: ${checked.issues[0]?.message ?? 'ошибка структуры'}`,
      );
    if (version.documentId !== entry.id || (entry.versionId && version.id !== entry.versionId))
      throw new Error('Версия текста не соответствует каталогу.');
    if (entry.source.sha256 && version.sourceSha256 !== entry.source.sha256)
      throw new Error('Контрольная сумма источника не соответствует каталогу.');
    const result = {
      entry,
      version,
      extraction: record(raw.extraction)
        ? (raw.extraction as CorpusDocument['extraction'])
        : undefined,
    };
    cache.set(key, result);
    while (cache.size > 4) cache.delete(cache.keys().next().value!);
    return result;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}
export function regionLabel(entry: CorpusEntry) {
  return entry.territory;
}
export function readable(entry: CorpusEntry) {
  return Boolean(entry.textUrl) && entry.pageCount > 0;
}
export function formatSourcePage(page: number | undefined) {
  return page ? `Страница ${page}` : 'Фрагмент источника';
}
