import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Worker as NodeWorker } from 'node:worker_threads';
import { ReaderData, ReaderSearch, boundedReaderOperation } from '../../packages/rudn-reader/site/apps/legal-lab/lib/reader-data.mjs';
import { unpackDescriptor } from '../../packages/rudn-reader/site/apps/legal-lab/lib/reader-codec.mjs';

const root = new URL('../../', import.meta.url), base = new URL('public/', root);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = async (path) => JSON.parse(await readFile(new URL(path, base)));
const sourceIndex = await read('data/corpus/index.json');
const meta = JSON.parse(await readFile(new URL('packages/rudn-reader/build-meta.json', root)));
const sourceCatalog = await read('data/reader/source-catalog.json');
const registry = await read('data/reader/catalog.json');

function fixture() {
  const controller = new AbortController();
  const corpus = {
    base, signal: controller.signal, catalog: sourceCatalog,
    assertActive() { if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError'); },
    async json(path, expectedSha, { signal } = {}) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      assert.ok(!path.startsWith('data/corpus/documents/'), 'The scrolling reader never requests a full source file');
      const bytes = await readFile(new URL(path, base));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (expectedSha) assert.equal(hash(bytes), expectedSha);
      return JSON.parse(bytes);
    },
  };
  const data = new ReaderData(corpus, { path: 'data/reader/catalog.json', sha256: meta.registrySha256, contentVersion: meta.contentVersion });
  return { controller, corpus, data };
}

test('runtime modules remain byte-for-byte copies of the pinned RUDN release', async () => {
  const provenance = JSON.parse(await readFile(new URL('packages/rudn-reader/upstream.json', root)));
  assert.equal(provenance.commit, '43193d2d741497a66d5cca5f0388e43084b1e88a');
  for (const pin of provenance.files) {
    const source = await readFile(new URL('packages/rudn-reader/' + pin.path, root));
    assert.equal(hash(source), pin.sha256, pin.path);
    if (!pin.path.endsWith('/reader-registry.mjs')) {
      assert.deepEqual(await readFile(new URL('vendor/rudn-reader/' + pin.path, base)), source);
    }
  }
});

test('all 80 documents reconstruct the exact canonical blocks, editions, pages and blank-page warnings', async () => {
  const { data } = fixture();
  assert.equal(registry.documents.length, 80);
  assert.equal(hash(await readFile(new URL('data/reader/catalog.json', base))), meta.registrySha256);
  assert.equal(hash(await readFile(new URL('data/reader/source-catalog.json', base))), meta.sourceCatalogSha256);
  let total = 0;
  try {
    for (const entry of sourceIndex.documents.filter((entry) => entry.textUrl)) {
      const original = await read(entry.textUrl.replace(/^\//, ''));
      const descriptor = await data.document(entry.id, 'ru');
      const { blocks: sourceBlocks, ...sourceVersion } = original.version;
      assert.deepEqual(descriptor.canonicalVersion, sourceVersion, entry.id);
      const reconstructed = [];
      for (const pin of descriptor.blocks) {
        assert.ok(pin.count <= 64);
        assert.ok(pin.bytes <= 131072);
        const value = await data.block(entry.id, 'ru', pin.id);
        for (const unit of value.units) {
          const { sectionId, label, locator, heading, ...block } = unit;
          assert.equal(sectionId, 'page-' + (block.pageStart ?? 1));
          assert.equal(heading, block.kind === 'heading');
          assert.ok(label && locator);
          reconstructed.push(block);
        }
        assert.ok(data.stats().blocks <= 12);
        assert.ok(data.stats().blockBytes <= 2097152);
      }
      assert.deepEqual(reconstructed, sourceBlocks, entry.id);
      const emptyPages = descriptor.sections.filter((section) => !section.unitIds.length).map((section) => Number(section.id.slice(5)));
      assert.deepEqual(descriptor.emptyPages, emptyPages);
      assert.equal(new Set(descriptor.units.map((unit) => unit.id)).size, sourceBlocks.length);
      assert.equal(descriptor.sections.reduce((sum, section) => sum + section.unitIds.length, 0), sourceBlocks.length);
      total += reconstructed.length;
      data.release();
    }
    assert.equal(total, 52390);
    assert.equal(data.stats().blocks, 0);
    assert.equal(data.stats().readerDocuments, 0);
  } finally { data.release(); }
});

class Worker {
  constructor(url) {
    this.inner = new NodeWorker(`const {parentPort}=require('node:worker_threads');globalThis.self=globalThis;globalThis.postMessage=data=>parentPort.postMessage(data);import(${JSON.stringify(url.href)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`, { eval: true });
    this.inner.on('message', (data) => this.onmessage?.({ data }));
    this.inner.on('error', (error) => this.onerror?.(error));
  }
  postMessage(data, transfer) { this.inner.postMessage(data, transfer); }
  terminate() { void this.inner.terminate(); }
}

test('the original search worker finds remote fragments without a full document on the main thread', async () => {
  const search = new ReaderSearch(base, { WorkerClass: Worker, fetch: async (url) => new Response(await readFile(url)) });
  const entries = [...sourceIndex.documents.filter((entry) => entry.textUrl)].sort((a, b) => b.blockCount - a.blockCount).slice(0, 3);
  try {
    for (const entry of entries) {
      const pin = registry.documents.find((item) => item.id === entry.id).locales.ru;
      const descriptor = unpackDescriptor(await read(pin.file));
      const index = await read(descriptor.search.file);
      const last = index.rows.at(-1), query = last[2].slice(0, 45);
      const expected = index.rows.filter((row) => query.split(' ').filter(Boolean).every((word) => row[2].includes(word)));
      const found = await search.search(descriptor, query, { pageSize: 20 });
      assert.equal(found.total, expected.length);
      assert.deepEqual(found.hits.map((hit) => hit.id), expected.slice(0, 20).map((row) => row[0]));
      assert.equal(search.stats().searchIndexes, 1);
      const old = search.worker;
      search.destroy();
      assert.equal(search.stats().searchIndexes, 0);
      assert.notEqual(old, search.worker);
    }
  } finally { search.destroy(); }
});

test('release cancels a pending block and cannot repopulate its cache with a late response', async () => {
  const { data, corpus } = fixture();
  const entry = sourceCatalog.documents[0];
  await data.document(entry.id, 'ru');
  const original = corpus.json.bind(corpus);
  let started, finish;
  const begun = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { finish = resolve; });
  corpus.json = async (path, sha, options) => {
    if (path.includes('/blocks/')) { started(); await gate; }
    return original(path, sha, options);
  };
  const pending = data.block(entry.id, 'ru', 0);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await begun;
  data.release();
  await rejected;
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(data.stats().blocks, 0);
  assert.equal(data.stats().pendingBlocks, 0);
});

test('an expired integrity/decode budget is rejected even when the operation resolves late', async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const work = boundedReaderOperation(async () => { await gate; return 'obsolete'; }, { timeoutMs: 10 });
  await assert.rejects(work, { code: 'reader/timeout' });
  finish();
});
