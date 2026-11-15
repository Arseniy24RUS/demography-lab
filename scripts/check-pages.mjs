/** Assert that a publishable build, rather than the source HTML, is served from a subdirectory. */
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const root = resolve(process.argv[2] ?? 'dist');
const html = await readFile(join(root, 'index.html'), 'utf8');
if (html.includes('/apps/web/src/') || !/src="\.\/assets\/[^"\s]+\.js"/u.test(html))
  throw new Error('Publish the compiled dist directory, not repository source files.');
const config = JSON.parse(await readFile(join(root, 'workshop-config.json'), 'utf8'));
if (config.schemaVersion !== 1 || config.offline || !config.supabaseUrl?.startsWith('https://') ||
  !config.supabasePublishableKey?.startsWith('sb_publishable_'))
  throw new Error('Invalid public online configuration.');
for (const file of ['survey.html', 'data/corpus/index.json', 'data/territories/index.json', 'favicon.svg'])
  if (!(await stat(join(root, file))).isFile()) throw new Error(`Missing public asset: ${file}`);
for (const factors of [join(root, 'data/factors'), join(root, 'data/factors/lower')]) {
  const index = JSON.parse(gunzipSync(await readFile(join(factors, 'index.json.gz'))));
  const sample = index.territories.find((territory) => territory.nFactors > 0);
  if (index.schemaVersion !== 1 || !sample || !/^municipalities\/[a-z0-9_-]+\.json\.gz$/u.test(sample.path))
    throw new Error('Invalid municipal correlations index.');
  const shard = await readFile(join(factors, sample.path));
  if (createHash('sha256').update(shard).digest('hex') !== sample.sha256)
    throw new Error('Municipal correlations shard checksum mismatch.');
}
const regional = JSON.parse(gunzipSync(await readFile(join(root, 'data/factors/regions.json.gz'))));
const settlements = JSON.parse(gunzipSync(await readFile(join(root, 'data/factors/settlement-parents.json.gz'))));
if (regional.schemaVersion !== 1 || !regional.regions.some(region => region.rows.length) ||
    settlements.schemaVersion !== 1 || !settlements.parents.some(parent => parent.settlementKeys.length))
  throw new Error('Regional correlations or settlement hierarchy missing.');
console.log('Compiled Pages entry, relative assets, online configuration and datasets verified.');
