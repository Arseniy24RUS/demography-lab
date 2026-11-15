// Adapt only the immutable input corpus. Runtime virtualization/search remain
// the exact, hash-pinned RUDN modules in packages/rudn-reader/site/.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { packDescriptor, unpackDescriptor } from '../packages/rudn-reader/site/apps/legal-lab/lib/reader-codec.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value) + '\n';
const normalize = (v) => String(v ?? '').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[«»„“”"'’]/g, '').replace(/[–—−]/g, '-').replace(/\s+/g, ' ').trim();
const publicRoot = resolve(root, 'public');
const vendorRoot = resolve(publicRoot, 'vendor/rudn-reader');
let generatedFiles = 0;

async function save(path, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : json(value));
  const target = resolve(publicRoot, path);
  if (check) assert.ok((await readFile(target)).equals(bytes), `Stale reader asset: ${path}`);
  else {
    let old = null;
    try { old = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!old?.equals(bytes)) { await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
  }
  generatedFiles++;
  return { file: path, sha256: hash(bytes), bytes: bytes.length };
}

const provenance = JSON.parse(await readFile(resolve(root, 'packages/rudn-reader/upstream.json'), 'utf8'));
for (const pin of provenance.files) {
  const bytes = await readFile(resolve(root, 'packages/rudn-reader', pin.path));
  assert.equal(hash(bytes), pin.sha256, `Changed upstream module: ${pin.path}`);
  assert.equal(bytes.length, pin.bytes);
  if (!pin.path.endsWith('/reader-registry.mjs')) await save('vendor/rudn-reader/' + pin.path, bytes);
}

const indexBytes = await readFile(resolve(publicRoot, 'data/corpus/index.json'));
const index = JSON.parse(indexBytes);
const contentVersion = 'demography-reader-v1-' + hash(indexBytes).slice(0, 16);
const registry = { schema: 1, contentVersion, maxUnits: 64, maxBlockBytes: 131072, documents: [] };
const catalog = { schema: 1, contentVersion, documents: [] };
let blockCount = 0, unitCount = 0, maximumBlockBytes = 0;

for (const entry of index.documents.filter((entry) => entry.textUrl)) {
  assert.match(entry.textUrl, /^\/?data\/corpus\/documents\/[-a-zа-яё0-9_]+\.json$/i);
  const sourceBytes = await readFile(resolve(publicRoot, entry.textUrl.replace(/^\//, '')));
  const source = JSON.parse(sourceBytes), version = source.version;
  assert.equal(version.documentId, entry.id);
  assert.equal(version.id, entry.versionId);
  assert.equal(version.sourceSha256, entry.source.sha256);
  assert.equal(source.canonicalHash, entry.canonicalHash);
  assert.ok(version.blocks.length);
  const sourceFileSha256 = hash(sourceBytes), sourceSha256 = source.canonicalHash;
  const sourceIds = new Set(version.blocks.map((block) => block.id));
  assert.equal(sourceIds.size, version.blocks.length);
  const sections = Array.from({ length: entry.pageCount }, (_, n) => ({ id: 'page-' + (n + 1), title: 'Страница ' + (n + 1), unitIds: [] }));
  for (const block of version.blocks) {
    const page = block.pageStart ?? 1;
    assert.ok(sections[page - 1], `Unknown source page: ${block.id}`);
    sections[page - 1].unitIds.push(block.id);
  }
  const { blocks: _blocks, ...canonicalVersion } = version;
  const descriptor = {
    schema: 1, id: entry.id, docId: entry.id, locale: 'ru', contentVersion,
    sourceSha256, sourceFileSha256, title: entry.title,
    revisionLabel: version.editionLabel || entry.source.act || '',
    canonicalVersion, pageCount: entry.pageCount,
    emptyPages: sections.filter((section) => !section.unitIds.length).map((section) => Number(section.id.slice(5))),
    pageUnits: Object.fromEntries(sections.filter((section) => section.unitIds.length).map((section) => [Number(section.id.slice(5)), section.unitIds[0]])),
    sections, units: [], unitToBlock: {}, labels: {}, canonicalUnitMeta: {}, blocks: [],
  };
  const search = { schema: 1, encoding: 'indexed-v1', docId: entry.id, locale: 'ru', contentVersion, sourceSha256, rows: [] };
  let chunk = [], start = 0;
  const payload = (list) => ({ schema: 1, docId: entry.id, locale: 'ru', contentVersion, id: descriptor.blocks.length, start, units: list });
  async function flush() {
    if (!chunk.length) return;
    const value = payload(chunk);
    const pin = await save(`data/reader/${entry.id}/ru/blocks/${String(value.id).padStart(4, '0')}.json`, value);
    assert.ok(pin.bytes <= 131072);
    maximumBlockBytes = Math.max(maximumBlockBytes, pin.bytes);
    descriptor.blocks.push({ ...pin, id: value.id, start, count: chunk.length });
    blockCount++; start += chunk.length; chunk = [];
  }
  for (let position = 0; position < version.blocks.length; position++) {
    const block = version.blocks[position], page = block.pageStart ?? 1;
    if (position) assert.ok(block.order > version.blocks[position - 1].order);
    const sectionId = 'page-' + page, label = 'Страница ' + page + ', фрагмент ' + (block.order + 1);
    const unit = { ...block, sectionId, label, locator: label, heading: block.kind === 'heading' };
    if (chunk.length && (chunk.length === 64 || Buffer.byteLength(json(payload([...chunk, unit]))) > 131072)) await flush();
    assert.ok(Buffer.byteLength(json(payload([unit]))) <= 131072, `Single canonical fragment exceeds limit: ${block.id}`);
    const index = descriptor.blocks.length;
    descriptor.units.push({ id: block.id, sectionId, locator: label, label, heading: unit.heading, index: position, block: index });
    descriptor.unitToBlock[block.id] = index; descriptor.labels[block.id] = label;
    descriptor.canonicalUnitMeta[block.id] = { order: block.order, kind: block.kind, pageStart: block.pageStart, pageEnd: block.pageEnd };
    chunk.push(unit);
    search.rows.push([block.id, sectionId, normalize(block.text + ' ' + label), block.text.slice(0, 500)]);
  }
  await flush();
  assert.equal(start, version.blocks.length);
  descriptor.search = await save(`data/reader/${entry.id}/ru/search.json`, search);
  const packed = packDescriptor(descriptor);
  assert.deepEqual(unpackDescriptor(packed), descriptor);
  const manifest = await save(`data/reader/${entry.id}/ru/manifest.json`, packed);
  registry.documents.push({ id: entry.id, sourceSha256, sourceFileSha256, unitCount: version.blocks.length, locales: { ru: manifest } });
  catalog.documents.push({ id: entry.id, sha256: sourceSha256, fileSha256: sourceFileSha256, unitCount: version.blocks.length, versionId: version.id });
  unitCount += version.blocks.length;
}
const catalogPin = await save('data/reader/source-catalog.json', catalog);
const registryPin = await save('data/reader/catalog.json', registry);
await save('vendor/rudn-reader/site/apps/legal-lab/lib/reader-registry.mjs', `// Generated demographic input; runtime modules remain exact copies of RUDN.\nexport const READER_CATALOG_SHA='${registryPin.sha256}';\nexport const READER_CONTENT_VERSION='${contentVersion}';\nexport const READER_SOURCE_CATALOG_SHA='${catalogPin.sha256}';\n`);
const buildMeta = Buffer.from(JSON.stringify({ contentVersion, registrySha256: registryPin.sha256, sourceCatalogSha256: catalogPin.sha256, upstreamCommit: provenance.commit }, null, 2) + '\n');
const metaPath = resolve(root, 'packages/rudn-reader/build-meta.json');
if (check) assert.ok((await readFile(metaPath)).equals(buildMeta), 'Stale reader build metadata');
else await writeFile(metaPath, buildMeta);
console.log(JSON.stringify({ mode: check ? 'check' : 'build', upstream: provenance.commit, documents: registry.documents.length, units: unitCount, blocks: blockCount, files: generatedFiles, maximumBlockBytes, catalogSha256: registryPin.sha256 }));
