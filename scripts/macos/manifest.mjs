#!/usr/bin/env node
/** Complete local payload inventory; a missing map/document/dependency fails preparation. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const REQUIRED_DIRECTORIES = [
  'dist', 'public/data', 'public/fonts', 'scripts/offline', 'scripts/macos',
  'macos', 'supabase/migrations', 'node_modules/@electric-sql/pglite',
  'node_modules/@noble/hashes', 'packages/security',
];
export const REQUIRED_FILES = [
  'package.json', 'scripts/seed-roadmaps.mjs', 'scripts/seed-supabase.mjs',
  'scripts/purge-expired-surveys.mjs',
  'scripts/offline/identify.sql',
  'scripts/cache-originals.mjs', 'packages/territories/series.mjs',
];
const manifestName = 'macos/prepared-build.json';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const safeRelative = (value) => typeof value === 'string' && value.length > 0
  && !value.startsWith('/') && !value.includes('\\')
  && value.split('/').every((part) => part !== '.' && part !== '..' && part !== '');

export async function payloadPaths(root = ROOT) {
  const paths = [];
  async function visit(current) {
    const filename = join(root, current);
    const stat = await lstat(filename);
    if (stat.isSymbolicLink()) throw new Error(`Символическая ссылка не входит в автономный комплект: ${current}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(filename)).sort()) {
        const child = `${current}/${name}`;
        if (child === 'dist/data' || child === manifestName || name === '.DS_Store') continue;
        await visit(child);
      }
    } else if (stat.isFile()) paths.push(current);
  }
  for (const name of REQUIRED_DIRECTORIES) await visit(name);
  for (const name of REQUIRED_FILES) await visit(name);
  for (const runtime of ['runtime/node', 'runtime/darwin-arm64', 'runtime/darwin-x64']) {
    try {
      const directory = await lstat(join(root, runtime));
      if (directory.isSymbolicLink()) throw new Error(`Символическая ссылка не входит в автономный комплект: ${runtime}`);
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // The source distribution may also retain npm's symlinks for the next online
    // Prepare. The teaching runtime only executes node; no npm is used by Start.
    await visit(`${runtime}/bin/node`);
    for (const notice of ['LICENSE', 'README.md']) {
      try { await visit(`${runtime}/${notice}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  for (const essential of [
    'dist/index.html', 'dist/survey.html', 'scripts/offline/server.mjs',
    'public/data/corpus/index.json', 'public/data/territories/index.json',
    'public/data/originals/index.json',
  ]) {
    if (!paths.includes(essential)) throw new Error(`Нет обязательного файла: ${essential}`);
  }
  return [...new Set(paths)].sort();
}

export async function writeManifest(root = ROOT) {
  const files = [];
  for (const path of await payloadPaths(root)) {
    const bytes = await readFile(join(root, path));
    files.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const result = { schemaVersion: 1, application: 'demography-lab-offline',
    version: packageJson.version, generatedAt: new Date().toISOString(),
    fingerprint: sha256(JSON.stringify(files)), files };
  await mkdir(join(root, 'macos'), { recursive: true });
  await writeFile(join(root, manifestName), JSON.stringify(result, null, 2) + '\n', { mode: 0o644 });
  return result;
}

export async function checkManifest(root = ROOT) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, manifestName), 'utf8')); }
  catch { throw new Error('Автономная сборка не подготовлена. Сначала выполните macos/Prepare.command.'); }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0
    || manifest.application !== 'demography-lab-offline'
    || sha256(JSON.stringify(manifest.files)) !== manifest.fingerprint) throw new Error('Повреждён манифест автономной сборки. Повторите подготовку.');
  const expectedPaths = new Set(await payloadPaths(root));
  const manifestPaths = new Set();
  for (const file of manifest.files) {
    if (!safeRelative(file.path) || manifestPaths.has(file.path) || !expectedPaths.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Некорректный состав автономной сборки.');
    }
    manifestPaths.add(file.path);
    const bytes = await readFile(join(root, file.path));
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error(`Изменён файл автономной сборки: ${file.path}. Повторите Prepare.command до занятия.`);
    }
  }
  if (manifestPaths.size !== expectedPaths.size) throw new Error('Состав файлов изменён после подготовки. Повторите Prepare.command.');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const command = process.argv[2] ?? 'check';
    if (!['write', 'check'].includes(command)) throw new Error('Используйте write или check.');
    const result = await (command === 'write' ? writeManifest() : checkManifest());
    console.log(`Автономный комплект ${result.version}: ${result.files.length} файлов, SHA-256 проверены.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
