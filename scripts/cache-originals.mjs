#!/usr/bin/env node
/** Prepare the exact original PDFs referenced by the immutable corpus. Never run during a lesson. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
if (process.argv.slice(2).some((argument) => argument !== '--check'))
  throw new Error('Usage: node scripts/cache-originals.mjs [--check]');
const manifest = JSON.parse(await readFile(join(root, 'public/data/corpus/index.json'), 'utf8'));
const output = join(root, 'public/data/originals');
const documents = manifest.documents.filter((entry) => entry.source.sha256 && entry.source.pdfUrl);
if (documents.length !== manifest.stats.availableSourceFiles) throw new Error('Corpus PDF count mismatch.');
if (!checkOnly) await mkdir(output, { recursive: true });

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function verified(entry) {
  const { source } = entry;
  if (!/^[a-f\d]{64}$/u.test(source.sha256)) throw new Error(`Invalid hash: ${entry.id}`);
  const path = join(output, `${source.sha256}.pdf`);
  try {
    const file = await stat(path);
    if (file.isFile() && file.size === source.sizeBytes && await digest(path) === source.sha256) return path;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (checkOnly) throw new Error(`Missing or changed original: ${entry.id}. Run Prepare while connected to the internet.`);
  const url = new URL(source.pdfUrl);
  const expected = `/${manifest.source.repository}/${manifest.source.commit}/${source.repositoryPath}`;
  if (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com' ||
    decodeURIComponent(url.pathname) !== expected || url.search || url.hash || url.username || url.password)
    throw new Error(`Unpinned original URL: ${entry.id}`);
  if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > 100 * 1024 * 1024)
    throw new Error(`Invalid PDF size: ${entry.id}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = `${path}.partial-${randomUUID()}`;
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      let size = 0;
      const hash = createHash('sha256');
      const limiter = new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > source.sizeBytes) return callback(new Error('PDF exceeds its recorded size.'));
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o644 }));
      if (size !== source.sizeBytes || hash.digest('hex') !== source.sha256)
        throw new Error('Original bytes do not match the corpus SHA-256.');
      await rename(temporary, path);
      return path;
    } catch (error) {
      await rm(temporary, { force: true });
      if (attempt === 2) throw new Error(`${entry.id}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}
let cursor = 0;
const checked = new Map();
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < documents.length) {
    const entry = documents[cursor++];
    await verified(entry);
    checked.set(entry.id, { id: entry.id, sha256: entry.source.sha256, bytes: entry.source.sizeBytes,
      path: `data/originals/${entry.source.sha256}.pdf`, originalUrl: entry.source.pdfUrl });
    if (!checkOnly) console.log(`Originals verified: ${checked.size}/${documents.length}`);
  }
}));
if (checkOnly) {
  await access(join(output, 'index.json'));
  const index = JSON.parse(await readFile(join(output, 'index.json'), 'utf8'));
  if (index.sourceCommit !== manifest.source.commit || index.documents.length !== documents.length ||
    index.documents.some((entry) => JSON.stringify(entry) !== JSON.stringify(checked.get(entry.id))))
    throw new Error('Original index does not match the verified source corpus.');
} else {
  const target = join(output, 'index.json');
  const temporary = `${target}.partial-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, sourceCommit: manifest.source.commit,
    documents: documents.map((entry) => checked.get(entry.id)) }, null, 2) + '\n');
  await rename(temporary, target);
}
console.log(`${documents.length} original PDFs verified; ${documents.reduce((sum, d) => sum + d.source.sizeBytes, 0)} bytes. ${checkOnly ? 'No network requests.' : 'Ready for offline packaging.'}`);
