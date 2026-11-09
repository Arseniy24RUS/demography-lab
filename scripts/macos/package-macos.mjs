#!/usr/bin/env node
/** Produce a ready-to-initialize Mac runtime, without account/database/session secrets. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeManifest, checkManifest } from './manifest.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const checksum = (value) => createHash('sha256').update(value).digest('hex');
const runtimeLock = JSON.parse(await readFile(new URL('./runtime-lock.json', import.meta.url), 'utf8'));

export function nodeArchiveSpec(arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Архитектура: arm64 (Apple Silicon) или x64 (Intel).');
  const filename = `node-${runtimeLock.nodeVersion}-darwin-${arch}.tar.gz`;
  return { filename, version: runtimeLock.nodeVersion, arch,
    sha256: runtimeLock[arch === 'arm64' ? 'darwinArm64Sha256' : 'darwinX64Sha256'],
    url: `https://nodejs.org/dist/${runtimeLock.nodeVersion}/${filename}` };
}

export async function verifiedNodeArchive(spec, filename) {
  const bytes = await readFile(filename);
  if (checksum(bytes) !== spec.sha256) throw new Error(`SHA-256 официального архива Node.js не совпала: ${spec.filename}`);
  return bytes.byteLength;
}

async function downloadArchive(spec, destination) {
  const response = await fetch(spec.url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Не удалось загрузить официальный Node.js: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (checksum(bytes) !== spec.sha256) throw new Error('Загруженный Node.js не соответствует runtime-lock.json.');
  await writeFile(destination, bytes, { mode: 0o600 });
}

async function copyPayload(source, destination) {
  const relativePaths = [
    'dist', 'public/data', 'public/fonts', 'scripts/offline', 'scripts/macos', 'macos',
    'scripts/seed-roadmaps.mjs', 'scripts/seed-supabase.mjs', 'scripts/cache-originals.mjs', 'scripts/purge-expired-surveys.mjs',
    'packages/territories/series.mjs', 'packages/security', 'supabase/migrations',
    'node_modules/@electric-sql/pglite', 'node_modules/@noble/hashes',
    'package.json', 'docs/offline-macos.md', 'docs/stage-07-acceptance.md', 'docs/stage-08-acceptance.md', 'CHANGELOG.md',
    'THIRD_PARTY_NOTICES.md', 'licenses',
  ];
  for (const path of relativePaths) {
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await cp(join(source, path), join(destination, path), {
      recursive: true, preserveTimestamps: true, dereference: false,
      filter: (filename) => {
        const rel = relative(source, filename).replaceAll('\\', '/');
        return rel !== 'dist/data' && rel !== 'macos/prepared-build.json' && rel !== 'macos/bundle.json'
          && basename(filename) !== '.DS_Store';
      },
    });
  }
  // License notices of bundled dependencies stay in their original package folders.
  for (const name of ['LICENSE', 'LICENSE.md', 'NOTICE']) {
    try { await copyFile(join(source, name), join(destination, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of await readdir(join(destination, 'macos'))) {
    if (name.endsWith('.command')) await chmod(join(destination, 'macos', name), 0o755);
  }
}

export async function buildMacBundle({ output, arch = 'universal', nodeArchive, nodeArchives = {}, source = root, keepDirectory = false }) {
  if (!['arm64', 'x64', 'universal'].includes(arch)) throw new Error('Архитектура: universal, arm64 или x64.');
  if (arch === 'universal' && nodeArchive) throw new Error('Для universal используйте --node-archive-arm64 и --node-archive-x64.');
  const target = resolve(output);
  if (!target.endsWith('.zip')) throw new Error('Выходной файл должен иметь расширение .zip.');
  const sourceRelative = relative(source, target);
  if (!sourceRelative.startsWith('..') && !isAbsolute(sourceRelative)) throw new Error('Выходной ZIP должен находиться вне исходного репозитория.');
  try { await lstat(target); throw new Error('Выходной ZIP уже существует. Выберите новое имя: архив не перезаписывается автоматически.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of ['dist/index.html', 'dist/survey.html', 'scripts/offline/server.mjs', 'public/data/originals/index.json']) {
    if (!(await stat(join(source, name))).isFile()) throw new Error(`Не найден ${name}.`);
  }
  const originals = spawnSync(process.execPath, [join(source, 'scripts/cache-originals.mjs'), '--check'], { cwd: source, stdio: 'inherit' });
  if (originals.status !== 0) throw new Error('Оригиналы документов не готовы: полный автономный выпуск не создан.');
  for (const [name, version] of [['@electric-sql/pglite', runtimeLock.pgliteVersion], ['@noble/hashes', runtimeLock.nobleHashesVersion]]) {
    const installed = JSON.parse(await readFile(join(source, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version !== version) throw new Error(`Неподтверждённая версия ${name}: нужна ${version}.`);
  }
  const sourcePackage = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const label = `Demography-Lab-${sourcePackage.version}-Mac-${arch}`;
  const work = await mkdtemp(join(tmpdir(), 'demography-mac-release-'));
  const bundle = join(work, label);
  const specifications = (arch === 'universal' ? ['arm64', 'x64'] : [arch]).map(nodeArchiveSpec);
  try {
    await mkdir(bundle);
    console.log('Копирование приложения, полного корпуса, карт и локальных зависимостей…');
    await copyPayload(source, bundle);
    for (const spec of specifications) {
      const suppliedArchive = nodeArchives[spec.arch] ?? nodeArchive;
      const archivePath = suppliedArchive ? resolve(suppliedArchive) : join(work, spec.filename);
      if (!suppliedArchive) {
        console.log(`Загрузка официального Node.js ${spec.version} (${spec.arch})…`);
        await downloadArchive(spec, archivePath);
      }
      await verifiedNodeArchive(spec, archivePath);
      const nodeDirectory = join(work, `node-extract-${spec.arch}`);
      await mkdir(nodeDirectory);
      const prefix = `node-${spec.version}-darwin-${spec.arch}`;
      const listing = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 });
      if (listing.status !== 0 || listing.stdout.split('\n').filter(Boolean).some((path) => !path.startsWith(prefix + '/') || path.split('/').includes('..'))) {
        throw new Error('Небезопасная структура архива Node.js.');
      }
      // Preserve the current user: release archives carry upstream UID/GID values
      // unavailable in restricted builders. Only the actual runtime and notices are needed.
      const extraction = spawnSync('tar', ['--no-same-owner', '-xzf', archivePath, '-C', nodeDirectory,
        `${prefix}/bin/node`, `${prefix}/LICENSE`, `${prefix}/README.md`], { encoding: 'utf8', maxBuffer: 65536 });
      if (extraction.status !== 0) throw new Error(`Не удалось распаковать проверенный Node.js: ${(extraction.stderr ?? '').slice(0, 1000)}`);
      const nodeOutput = join(bundle, 'runtime', arch === 'universal' ? `darwin-${spec.arch}` : 'node');
      await mkdir(join(nodeOutput, 'bin'), { recursive: true });
      await copyFile(join(nodeDirectory, prefix, 'bin/node'), join(nodeOutput, 'bin/node'));
      await chmod(join(nodeOutput, 'bin/node'), 0o755);
      for (const name of ['LICENSE', 'README.md']) await copyFile(join(nodeDirectory, prefix, name), join(nodeOutput, name));
    }
    await writeFile(join(bundle, 'macos/bundle.json'), JSON.stringify({ schemaVersion: 1,
      application: 'demography-lab-offline', version: sourcePackage.version, arch,
      node: specifications.map((spec) => ({ arch: spec.arch, version: spec.version, source: spec.url, archiveSha256: spec.sha256 })),
      dependencies: { '@electric-sql/pglite': runtimeLock.pgliteVersion, '@noble/hashes': runtimeLock.nobleHashesVersion },
      preparedDatabase: false, userDataIncluded: false, downloadsRequired: false,
    }, null, 2) + '\n');
    const readme = `# Демографическая мастерская ${sourcePackage.version}\n\nПолный автономный комплект для macOS, архитектура ${arch === 'universal' ? 'Apple Silicon (M-серия) и Intel; выбор автоматически' : arch === 'arm64' ? 'Apple Silicon (M-серия)' : 'Intel'}.\n\nРаспакуйте ZIP целиком в постоянную папку. Заранее откройте macos/Prepare.command: подготовка локальной базы из уже включённых данных. Интернет для этого комплекта не нужен. Затем macos/Network.command и macos/Start-Seminar.command. После занятия macos/Stop-Seminar.command создаёт резервную копию и закрывает базу.\n\nПреподаватель и слушатели открывают одну ссылку или QR-код занятия и сначала вводят только email. Сохранённое ФИО загружается автоматически; для нового профиля имя запрашивается вторым шагом. Для роли преподавателя используйте omnistat@yandex.ru; это работает и на Mac, и на другом устройстве учебной сети. ФИО, роль, «Изменить ФИО» и «Выйти» находятся в шапке. Личные заметки и совместная работа сохраняются в базе Mac. Дорожную карту можно скачать в DOCX или PDF.\n\nДанные участников хранятся вне папки программы: ~/Library/Application Support/DemographyLab. Этот комплект не содержит чужих аккаунтов, ключей преподавателя или результатов занятий.\n\nПолная инструкция, включая обновление с 0.7/0.8 на ${sourcePackage.version}: docs/offline-macos.md. Не удаляйте каталог данных при обновлении программы. Если macOS требует подтверждения открытия скачанного .command, используйте разрешение конкретного файла в настройках безопасности после проверки происхождения архива. Не отключайте защиту системы целиком.\n`;
    await writeFile(join(bundle, 'START-HERE.md'), readme, 'utf8');
    const manifest = await writeManifest(bundle);
    await checkManifest(bundle);
    await mkdir(dirname(target), { recursive: true });
    const temporaryZip = join(work, 'release.zip');
    const zipped = spawnSync('zip', ['-q', '-r', '-X', temporaryZip, label], { cwd: work, stdio: 'inherit' });
    if (zipped.status !== 0) throw new Error('Не удалось создать ZIP; установите системную утилиту zip в среде сборки.');
    const zipCheck = spawnSync('unzip', ['-tq', temporaryZip], { encoding: 'utf8' });
    if (zipCheck.status !== 0) throw new Error('Проверка целостности ZIP не пройдена.');
    await copyFile(temporaryZip, target, 1);
    const digest = checksum(await readFile(target));
    await writeFile(target + '.sha256', `${digest}  ${basename(target)}\n`, { flag: 'wx' });
    const result = { output: target, sha256: digest, bytes: (await stat(target)).size,
      payloadFiles: manifest.files.length, manifestFingerprint: manifest.fingerprint,
      arch, node: runtimeLock.nodeVersion, database: 'initialize-on-user-Mac',
      ...(keepDirectory ? { directory: bundle } : {}) };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { if (!keepDirectory) await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (!value('--output')) {
    console.error('node scripts/macos/package-macos.mjs --output /absolute/path/release.zip [--arch universal|arm64|x64] [--node-archive /path/node.tar.gz] [--node-archive-arm64 /path/arm64.tar.gz] [--node-archive-x64 /path/x64.tar.gz] [--keep-directory]');
    process.exitCode = 1;
  } else buildMacBundle({ output: value('--output'), arch: value('--arch') ?? 'universal', nodeArchive: value('--node-archive'), nodeArchives: { arm64: value('--node-archive-arm64'), x64: value('--node-archive-x64') }, keepDirectory: args.includes('--keep-directory') })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
