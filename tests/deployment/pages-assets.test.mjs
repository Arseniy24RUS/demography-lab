import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { retainPagesAssets } from '../../scripts/retain-pages-assets.mjs';

const siteUrl = 'https://example.test/workshop/';
const entry = '<script src="./assets/entry-aaaaaaaa.js"></script><link href="./assets/base-aaaaaaaa.css">';
const survey = '<script src="./assets/survey-aaaaaaaa.js"></script>';
const old = {
  'index.html': entry, 'survey.html': survey,
  'assets/entry-aaaaaaaa.js': 'const map=["./lazy-aaaaaaaa.js","./base-aaaaaaaa.css"];import"./shared-aaaaaaaa.js";',
  'assets/lazy-aaaaaaaa.js': 'new Worker(new URL("./search.worker-aaaaaaaa.js",import.meta.url));',
  'assets/shared-aaaaaaaa.js': 'export const saved="no auth or storage change";',
  'assets/search.worker-aaaaaaaa.js': 'self.onmessage=()=>{};',
  'assets/base-aaaaaaaa.css': '.x{background:url(image-aaaaaaaa.svg)}',
  'assets/image-aaaaaaaa.svg': '<svg/>',
  'assets/survey-aaaaaaaa.js': 'export{};',
};
const digest = text => createHash('sha256').update(text).digest('hex');
async function harness(t, files = old, reply) {
  const dist = await mkdtemp(join(tmpdir(), 'pages-assets-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'assets/new-bbbbbbbb.js'), 'new build');
  await writeFile(join(dist, 'index.html'), 'new HTML');
  await writeFile(join(dist, 'workshop-config.json'), 'unchanged config');
  const calls = [];
  const options = { dist, siteUrl, log: () => {}, fetchImpl: async (url, init) => {
    const path = url.pathname.slice('/workshop/'.length);
    calls.push({ path, init });
    if (reply) { const response = await reply(path, calls); if (response) return response; }
    return path in files ? new Response(files[path]) : new Response('missing', { status: 404 });
  } };
  return { dist, calls, options };
}

it('retains lazy chunks, workers, CSS assets and survey assets with GET only, preserving the new entry/config', async t => {
  const h = await harness(t);
  const manifest = await retainPagesAssets(h.options);
  assert.equal(manifest.assets.length, 8);
  for (const [path, body] of Object.entries(old).filter(([path]) => path.startsWith('assets/')))
    assert.equal(await readFile(join(h.dist, path), 'utf8'), body);
  assert.equal(await readFile(join(h.dist, 'index.html'), 'utf8'), 'new HTML');
  assert.equal(await readFile(join(h.dist, 'workshop-config.json'), 'utf8'), 'unchanged config');
  assert.equal(await readFile(join(h.dist, 'assets/new-bbbbbbbb.js'), 'utf8'), 'new build');
  assert.equal(h.calls.filter(({ path }) => path === 'assets/base-aaaaaaaa.css').length, 1);
  for (const { init } of h.calls) {
    assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.equal(init.body, undefined); assert.equal(init.headers, undefined);
  }
});

it('carries a prior manifest generation even when the current HTML no longer references it', async t => {
  const historic = 'older lazy chunk';
  const h = await harness(t, { ...old, 'assets/older-cccccccc.js': historic,
    'asset-retention.json': JSON.stringify({ schemaVersion: 1, assets: [{ path: 'older-cccccccc.js',
      bytes: Buffer.byteLength(historic), sha256: digest(historic) }] }) });
  const manifest = await retainPagesAssets(h.options);
  assert(manifest.assets.some(({ path, sha256 }) => path === 'older-cccccccc.js' && sha256 === digest(historic)));
});

it('fails before writing anything when an old lazy asset is missing', async t => {
  const files = { ...old }; delete files['assets/lazy-aaaaaaaa.js'];
  const h = await harness(t, files);
  await assert.rejects(retainPagesAssets(h.options), /HTTP 404.*lazy-aaaaaaaa/u);
  assert.deepEqual(await readdir(join(h.dist, 'assets')), ['new-bbbbbbbb.js']);
});

it('fails before writing on checksum drift, unsafe manifest paths, and old/new filename collisions', async t => {
  for (const variant of ['checksum', 'traversal', 'collision']) {
    const files = { ...old };
    const h = await harness(t, files);
    if (variant === 'collision') await writeFile(join(h.dist, 'assets/entry-aaaaaaaa.js'), 'different bytes');
    else files['asset-retention.json'] = JSON.stringify({ schemaVersion: 1, assets: [{
      path: variant === 'traversal' ? '../outside-aaaaaaaa.js' : 'entry-aaaaaaaa.js', bytes: 1, sha256: '0'.repeat(64),
    }] });
    await assert.rejects(retainPagesAssets(h.options), /manifest|checksum|collision/iu);
    assert.deepEqual((await readdir(join(h.dist, 'assets'))).sort(),
      variant === 'collision' ? ['entry-aaaaaaaa.js', 'new-bbbbbbbb.js'] : ['new-bbbbbbbb.js']);
  }
});

it('rejects a deployment changing underneath the read and refuses authenticated or non-HTTPS URLs', async t => {
  const h = await harness(t, old, (path, calls) => path === 'index.html'
    && calls.filter(call => call.path === path).length > 1 ? new Response('other deployment') : null);
  await assert.rejects(retainPagesAssets(h.options), /changed/u);
  assert.deepEqual(await readdir(join(h.dist, 'assets')), ['new-bbbbbbbb.js']);
  for (const siteUrl of ['http://example.test/', 'https://user:pass@example.test/', 'https://example.test/?token=x'])
    await assert.rejects(retainPagesAssets({ ...h.options, siteUrl }), /HTTPS/u);
});
