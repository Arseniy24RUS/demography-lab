/** Keep content-addressed bundles needed by tabs opened before a static Pages update. */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = 'asset-retention.json';
const MAX_FILES = 10_000, MAX_FILE_BYTES = 20 * 1024 * 1024, MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assetName = name => typeof name === 'string'
  && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|wasm|woff2?|ttf|svg|png|jpe?g|webp|gif|ico)$/u.test(name);

/** Read Vite's quoted imports, mapDeps entries and worker URLs without executing old code. */
export function referencedAssets(text, fromUrl, assetsUrl) {
  const found = new Set();
  for (const match of text.matchAll(/["'`(]((?:\.\/)?(?:assets\/)?[A-Za-z0-9_./-]+\.(?:js|css|wasm|woff2?|ttf|svg|png|jpe?g|webp|gif|ico))["'`)]/gu)) {
    const url = new URL(match[1], fromUrl);
    if (!url.href.startsWith(assetsUrl.href)) continue;
    const name = url.href.slice(assetsUrl.href.length);
    if (assetName(name)) found.add(name);
  }
  return [...found];
}

export async function retainPagesAssets({ dist = 'dist', siteUrl = process.env.PAGES_SITE_URL,
  fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const base = new URL(siteUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/'))
    throw new Error('Use the HTTPS Pages site root with a trailing slash.');
  const assetsUrl = new URL('assets/', base), downloaded = new Map(), pending = new Set();
  const expected = new Map();
  let totalBytes = 0;
  async function get(path, optional = false) {
    const response = await fetchImpl(new URL(path, base), { method: 'GET', credentials: 'omit',
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`Previous Pages asset GET failed (HTTP ${response.status}): ${path}`);
    const size = Number(response.headers.get('content-length'));
    if (Number.isFinite(size) && size > MAX_FILE_BYTES) throw new Error(`Previous Pages asset is too large: ${path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`Previous Pages asset is too large: ${path}`);
    return bytes;
  }
  const index = await get('index.html'), survey = await get('survey.html');
  const priorManifest = await get(MANIFEST, true);
  if (priorManifest) {
    const parsed = JSON.parse(priorManifest.toString('utf8'));
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.assets) || parsed.assets.length > MAX_FILES)
      throw new Error('Invalid previous Pages asset manifest.');
    for (const entry of parsed.assets) {
      if (!assetName(entry.path) || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !Number.isSafeInteger(entry.bytes)
          || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES || expected.has(entry.path))
        throw new Error('Invalid previous Pages asset manifest entry.');
      expected.set(entry.path, entry);
      pending.add(entry.path);
    }
  }
  for (const [path, bytes] of [['index.html', index], ['survey.html', survey]])
    for (const name of referencedAssets(bytes.toString('utf8'), new URL(path, base), assetsUrl)) pending.add(name);
  if (!pending.size) throw new Error('Previous Pages HTML contains no compiled asset references.');
  while (pending.size) {
    if (downloaded.size + pending.size > MAX_FILES) throw new Error('Previous Pages asset inventory is too large.');
    const names = [...pending].slice(0, 8);
    const results = await Promise.all(names.map(async name => [name, await get(`assets/${name}`)]));
    for (const [name, bytes] of results) {
      pending.delete(name);
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Previous Pages asset inventory exceeds the size limit.');
      const entry = expected.get(name);
      if (entry && (entry.bytes !== bytes.length || entry.sha256 !== hash(bytes)))
        throw new Error(`Previous Pages asset checksum mismatch: ${name}`);
      downloaded.set(name, bytes);
      if (/\.(?:js|css)$/u.test(name))
        for (const child of referencedAssets(bytes.toString('utf8'), new URL(`assets/${name}`, base), assetsUrl))
          if (!downloaded.has(child)) pending.add(child);
    }
  }
  // A different deployment appearing while we crawl must never produce an incomplete retention set.
  if (!(await get('index.html')).equals(index) || !(await get('survey.html')).equals(survey))
    throw new Error('The previous Pages deployment changed during its asset inventory.');
  const root = resolve(dist, 'assets');
  const existing = new Map();
  async function inventory(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await inventory(resolve(dir, entry.name), `${name}/`);
      else {
        if (!entry.isFile() || !assetName(name)) throw new Error(`Unexpected generated asset: ${name}`);
        existing.set(name, await readFile(resolve(root, name)));
      }
    }
  }
  await inventory(root);
  // Validate every collision before writing anything. A hashed URL must keep the same bytes.
  for (const [name, bytes] of downloaded)
    if (existing.has(name) && !existing.get(name).equals(bytes)) throw new Error(`Pages asset name collision: ${name}`);
  for (const [name, bytes] of downloaded) {
    if (existing.has(name)) continue;
    await mkdir(dirname(resolve(root, name)), { recursive: true });
    await writeFile(resolve(root, name), bytes, { flag: 'wx' });
    existing.set(name, bytes);
  }
  const manifest = { schemaVersion: 1, assets: [...existing].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, bytes]) =>
    ({ path, bytes: bytes.length, sha256: hash(bytes) })) };
  await writeFile(resolve(dist, MANIFEST), `${JSON.stringify(manifest)}\n`);
  log(`Retained ${downloaded.size} previous Pages bundles; ${manifest.assets.length} immutable assets available.`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await retainPagesAssets({ dist: process.argv[2] ?? 'dist' }); }
  catch (error) { console.error(`Pages asset retention: ${error.message}`); process.exitCode = 1; }
}
