import { sha256 } from '@noble/hashes/sha2.js';
import type { DocumentBlock, DocumentVersion } from '@domain/index';
import type { CorpusEntry } from './corpus';
import buildMeta from '../../../../packages/rudn-reader/build-meta.json';

export interface ReaderUnit extends DocumentBlock {
  sectionId: string;
  locator: string;
  label: string;
  heading: boolean;
}
export interface ReaderUnitMeta {
  id: string;
  sectionId: string;
  block: number;
  heading: boolean;
  label: string;
  locator: string;
  index: number;
  order: number;
  kind: DocumentBlock['kind'];
  pageStart?: number;
  pageEnd?: number;
}
export interface ReaderDescriptor {
  schema: number;
  docId: string;
  locale: string;
  contentVersion: string;
  title: string;
  revisionLabel: string;
  canonicalVersion: Omit<DocumentVersion, 'blocks'>;
  pageCount: number;
  emptyPages: number[];
  pageUnits: Record<number, string>;
  units: ReaderUnitMeta[];
  sections: { id: string; title: string; unitIds: string[] }[];
  labels: Record<string, string>;
  unitToBlock: Record<string, number>;
  canonicalUnitMeta: Record<
    string,
    Pick<ReaderUnitMeta, 'order' | 'kind' | 'pageStart' | 'pageEnd'>
  >;
  blocks: {
    id: number;
    start: number;
    count: number;
    bytes: number;
    file: string;
    sha256: string;
  }[];
}
export interface ReaderChunk {
  id: number;
  docId: string;
  locale: string;
  start: number;
  units: ReaderUnit[];
}
export interface ReaderSearchResult {
  hits: { id: string; sectionId: string; text: string; label: string; locator: string }[];
  total: number;
  page: number;
  pages: number;
  query?: string;
}
export interface ReaderPosition {
  docId: string;
  locale?: string;
  top: number;
  anchor?: { id: string; offset: number } | null;
}
export interface ReaderSpec {
  descriptor: ReaderDescriptor;
  selected: string[];
  correctIds: string[];
  review: boolean;
  readonly: boolean;
  renderBlock(block: ReaderChunk): string;
  afterRender?(): void;
}
export interface ReaderControllerInstance {
  descriptor: ReaderDescriptor;
  paper: HTMLElement;
  nodes: Map<number, HTMLElement>;
  closed: boolean;
  searchPending: boolean;
  searchResult?: ReaderSearchResult;
  initialize(position?: ReaderPosition | null): Promise<void>;
  capture(): ReaderPosition;
  restore(position?: ReaderPosition | null): void;
  navigate(id: string, options?: { teacher?: boolean; focus?: boolean }): Promise<boolean>;
  update(spec: ReaderSpec): void;
  search(query: string, page?: number): Promise<ReaderSearchResult | null>;
  cancelSearch(): void;
  scheduleScroll(): void;
  measure(): void;
  suspend(): void;
  resume(): void;
  destroy(): void;
  stats(): { mountedUnits: number; blocks: number; searchPending: boolean; jumpPending: boolean };
}
export interface ReaderApp {
  state: { reader: Record<string, Record<string, unknown>> };
  corpus: ReaderCorpus;
  isLocked(): boolean;
  fail(error: unknown): void;
  opt?: { diagnostics?: { record(event: string, fields: Record<string, unknown>): void } };
}
export type ReaderControllerConstructor = new (
  app: ReaderApp,
  reader: HTMLElement,
  spec: ReaderSpec,
) => ReaderControllerInstance;
type LoadOptions = { signal?: AbortSignal };
type SearchOptions = LoadOptions & { page?: number; pageSize?: number };
type ReaderStats = {
  blocks: number;
  blockBytes: number;
  maxBlocks: number;
  maxBlockBytes: number;
  searchIndexes: number;
  pendingSearches: number;
  searchReady: boolean;
  readerDocuments: number;
  pendingBlocks: number;
  activeBlockLoads: number;
  queuedBlockLoads: number;
  maxActiveBlockLoads: number;
};
interface ReaderDataInstance {
  search: { WorkerClass: typeof Worker; cancel(): void };
  document(id: string, locale: string, options?: LoadOptions): Promise<ReaderDescriptor>;
  block(id: string, locale: string, index: number, options?: LoadOptions): Promise<ReaderChunk>;
  units(
    id: string,
    locale: string,
    ids: Iterable<string>,
    options?: LoadOptions,
  ): Promise<Map<string, ReaderUnit>>;
  loadedUnits(id: string, locale: string): Map<string, ReaderUnit>;
  searchDocument(
    id: string,
    locale: string,
    query: string,
    options?: SearchOptions,
  ): Promise<ReaderSearchResult>;
  release(): void;
  stats(): ReaderStats;
}
interface UpstreamDataModule {
  ReaderData: new (
    corpus: unknown,
    options: { path: string; sha256: string; contentVersion: string },
  ) => ReaderDataInstance;
  boundedReaderOperation<T>(
    task: (signal: AbortSignal, check: () => void) => Promise<T>,
    options: { signals: (AbortSignal | undefined)[]; timeoutMs: number; assertActive: () => void },
  ): Promise<T>;
  readerResponseBytes(response: Response, path: string): Promise<ArrayBuffer>;
}
const baseURL = () => new URL(import.meta.env.BASE_URL, document.baseURI);
const vendorURL = (path: string) =>
  new URL('vendor/rudn-reader/site/apps/legal-lab/lib/' + path, baseURL());
let modules:
  Promise<{ data: UpstreamDataModule; controllerClass: ReaderControllerConstructor }> | undefined;
function loadModules() {
  modules ??= Promise.all([
    import(/* @vite-ignore */ vendorURL('reader-data.mjs').href) as Promise<UpstreamDataModule>,
    import(/* @vite-ignore */ vendorURL('reader-controller.mjs').href) as Promise<{
      ReaderController: ReaderControllerConstructor;
    }>,
  ])
    .then(([data, controller]) => ({ data, controllerClass: controller.ReaderController }))
    .catch((error: unknown) => {
      modules = undefined;
      throw error;
    });
  return modules;
}

// Keep the exact upstream worker and supply the existing SHA-256 implementation
// on the classroom's ordinary HTTP LAN origin, where WebCrypto is unavailable.
const ClassroomReaderWorker = function (upstreamURL: string | URL, options?: WorkerOptions) {
  // Keep the literal Worker constructor: Vite bundles this compatibility entry.
  const worker = new Worker(new URL('./rudnSearch.worker.ts', import.meta.url), { type: 'module' });
  worker.postMessage({ type: 'rudn-bootstrap', url: String(upstreamURL) });
  return worker;
} as unknown as typeof Worker;

export class ReaderCorpus {
  readonly base = baseURL();
  readonly signal: AbortSignal;
  readonly descriptor: ReaderDescriptor;
  private readonly controller: AbortController;
  private readonly data: ReaderDataInstance;
  private constructor(
    data: ReaderDataInstance,
    descriptor: ReaderDescriptor,
    controller: AbortController,
  ) {
    this.data = data;
    this.descriptor = descriptor;
    this.controller = controller;
    this.signal = controller.signal;
  }
  static async open(entry: CorpusEntry, options: LoadOptions = {}) {
    if (!entry.textUrl) throw new Error('Полный текст пока не подготовлен.');
    const { data: upstream, controllerClass } = await loadModules();
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', stop, { once: true });
    controller.signal.addEventListener(
      'abort',
      () => options.signal?.removeEventListener('abort', stop),
      { once: true },
    );
    const signal = controller.signal,
      base = baseURL();
    const assertActive = () => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    };
    const json = (path: string, expectedSha?: string, request: LoadOptions = {}) =>
      upstream.boundedReaderOperation(
        async (activeSignal, check) => {
          const response = await fetch(new URL(path, base), {
            signal: activeSignal,
            credentials: 'same-origin',
            cache: 'no-cache',
          });
          check();
          if (!response.ok) throw new Error(`Не удалось загрузить документ (${response.status}).`);
          if (response.headers.get('content-type')?.includes('text/html'))
            throw new Error('Сервер вернул страницу вместо текста документа.');
          const bytes = await upstream.readerResponseBytes(response, path);
          check();
          if (expectedSha) {
            const digest = sha256(new Uint8Array(bytes));
            check();
            const actual = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join(
              '',
            );
            if (actual !== expectedSha)
              throw new Error('Контрольная сумма документа не совпадает. Обновите материалы.');
          }
          check();
          return JSON.parse(new TextDecoder().decode(bytes));
        },
        { signals: [signal, request.signal], timeoutMs: 10000, assertActive },
      );
    let readerData: ReaderDataInstance | undefined;
    try {
      const catalog = await json('data/reader/source-catalog.json', buildMeta.sourceCatalogSha256);
      assertActive();
      const pinned = catalog.documents.find((item: { id: string }) => item.id === entry.id);
      if (!pinned || (entry.versionId && entry.versionId !== pinned.versionId))
        throw new Error('Редакция текста не соответствует каталогу.');
      readerData = new upstream.ReaderData(
        { base, signal, catalog, json, assertActive },
        {
          path: 'data/reader/catalog.json',
          sha256: buildMeta.registrySha256,
          contentVersion: buildMeta.contentVersion,
        },
      );
      readerData.search.WorkerClass = ClassroomReaderWorker;
      const descriptor = await readerData.document(entry.id, 'ru', { signal });
      assertActive();
      if (
        descriptor.canonicalVersion.id !== entry.versionId ||
        descriptor.canonicalVersion.sourceSha256 !== entry.source.sha256
      )
        throw new Error('Контрольные данные исходного документа не совпадают.');
      descriptor.units = descriptor.units.map((unit) => ({
        ...unit,
        ...descriptor.canonicalUnitMeta[unit.id],
      }));
      return {
        corpus: new ReaderCorpus(readerData, descriptor, controller),
        descriptor,
        controllerClass,
      };
    } catch (error) {
      controller.abort();
      readerData?.release();
      throw error;
    }
  }
  private active(id = this.descriptor.docId, locale = this.descriptor.locale) {
    if (this.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (id !== this.descriptor.docId || locale !== this.descriptor.locale)
      throw new Error('Запрос относится к другому документу.');
  }
  loadBlock(id: string, locale: string, index: number, options: LoadOptions = {}) {
    this.active(id, locale);
    return this.data.block(id, locale, index, options);
  }
  searchDocument(id: string, locale: string, query: string, options: SearchOptions = {}) {
    this.active(id, locale);
    return this.data.searchDocument(id, locale, query, options);
  }
  cancelSearch() {
    this.data.search.cancel();
  }
  loadUnits(ids: Iterable<string>, options: LoadOptions = {}) {
    this.active();
    return this.data.units(this.descriptor.docId, this.descriptor.locale, ids, options);
  }
  loadedUnits() {
    return this.data.loadedUnits(this.descriptor.docId, this.descriptor.locale);
  }
  versionForUnits(units: Iterable<ReaderUnit>): DocumentVersion {
    const blocks = [...units]
      .map(
        ({
          sectionId: _sectionId,
          label: _label,
          locator: _locator,
          heading: _heading,
          ...block
        }) => block,
      )
      .sort((a, b) => a.order - b.order);
    return { ...this.descriptor.canonicalVersion, blocks };
  }
  release() {
    this.controller.abort();
    this.data.release();
  }
  stats() {
    return this.data.stats();
  }
}

export const openReader = (entry: CorpusEntry, options?: LoadOptions) =>
  ReaderCorpus.open(entry, options);
