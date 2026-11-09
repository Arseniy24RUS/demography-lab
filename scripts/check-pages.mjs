/** Assert that a publishable build, rather than the source HTML, is served from a subdirectory. */
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
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
console.log('Compiled Pages entry, relative assets, online configuration and datasets verified.');
