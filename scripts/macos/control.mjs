#!/usr/bin/env node
/** Local operator controller. Never kills a PID, changes Wi-Fi, or downloads software. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, open, readFile, rename, stat, statfs, writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces, platform } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { networkInventory, networkText, getNetworkInterfaces } from './network.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function localSettings(env = process.env, operatingSystem = platform()) {
  const dataDir = resolve(env.DW_OFFLINE_DATA_DIR ?? (operatingSystem === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'DemographyLab')
    : join(homedir(), '.local', 'share', 'DemographyLab')));
  const port = Number(env.DW_OFFLINE_PORT ?? 8787);
  const surveyPort = Number(env.DW_OFFLINE_SURVEY_PORT ?? 8788);
  networkInventory({}, port, surveyPort);
  if (port === surveyPort) throw new Error('Приложению и анкете нужны разные порты.');
  return { dataDir, port, surveyPort, origin: `http://127.0.0.1:${port}` };
}

async function jsonFile(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function optionalJson(path) {
  try { return await jsonFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function preflight(settings) {
  await mkdir(settings.dataDir, { recursive: true, mode: 0o700 });
  const space = await statfs(settings.dataDir);
  const availableBytes = Number(space.bavail) * Number(space.bsize);
  if (availableBytes < 1024 ** 3) throw new Error('Для базы и резервных копий требуется хотя бы 1 ГиБ свободного места на диске с данными.');
  const probe = join(settings.dataDir, `.write-check-${process.pid}`);
  const handle = await open(probe, 'wx', 0o600);
  await handle.close();
  const { unlink } = await import('node:fs/promises');
  await unlink(probe);
  return { availableBytes };
}
export async function readOperator(settings) {
  const operator = await jsonFile(join(settings.dataDir, 'operator.json'));
  if (operator.schemaVersion !== 1 || typeof operator.instanceId !== 'string'
    || typeof operator.hostKey !== 'string' || operator.hostKey.length < 24) {
    throw new Error('Некорректный локальный профиль преподавателя. Не удаляйте базу; сохраните каталог данных для восстановления.');
  }
  return operator;
}

async function currentSettings(settings) {
  const runtime = await optionalJson(join(settings.dataDir, 'runtime.json'));
  if (!runtime) return settings;
  const operator = await readOperator(settings);
  if (runtime.instanceId !== operator.instanceId) throw new Error('Состояние процесса относится к другой локальной базе.');
  return { ...settings, ...localSettings({ DW_OFFLINE_DATA_DIR: settings.dataDir,
    DW_OFFLINE_PORT: String(runtime.port), DW_OFFLINE_SURVEY_PORT: String(runtime.surveyPort) }) };
}

export async function fetchLocal(settings, pathname, { method = 'GET', hostKey, timeout = 6000 } = {}) {
  if (!/^\/offline\/(?:status|admin\/(?:status|backup|stop))$/.test(pathname)) throw new Error('Недопустимый локальный административный маршрут.');
  const response = await fetch(settings.origin + pathname, {
    method, redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { Accept: 'application/json', ...(hostKey ? { Authorization: `Bearer ${hostKey}` } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  if (!response.ok) throw new Error(`Локальный сервер вернул HTTP ${response.status}.`);
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw new Error('Ответ порта не похож на локальный сервер семинара.');
  return response.json();
}
async function verifiedRunning(settings, operator) {
  const status = await fetchLocal(settings, '/offline/status');
  if (status.mode !== 'offline' || status.ready !== true || status.instanceId !== operator.instanceId) {
    throw new Error('На выбранном порту работает другой экземпляр. Команда ему не отправлена.');
  }
  return status;
}
export async function checkPrepared(settings) {
  await preflight(settings);
  const ready = await optionalJson(join(settings.dataDir, 'ready.json'));
  const operator = await readOperator(settings).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('Локальная база ещё не подготовлена. Откройте Prepare.command до занятия.');
    throw error;
  });
  if (!ready || ready.instanceId !== operator.instanceId || !ready.seed || !Array.isArray(ready.migrations)) {
    throw new Error('Подготовка полной базы не завершена. Откройте Prepare.command; Start не скачивает и не подготавливает недостающие данные.');
  }
  return { ready, operator };
}
async function backup(settings, operator) {
  await verifiedRunning(settings, operator);
  return fetchLocal(settings, '/offline/admin/backup', { method: 'POST', hostKey: operator.hostKey, timeout: 120000 });
}

async function start(settings) {
  const { operator } = await checkPrepared(settings);
  const existingSettings = await currentSettings(settings);
  let alreadyRunning = false;
  try { await verifiedRunning(existingSettings, operator); alreadyRunning = true; }
  catch (error) {
    if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code) && error.name !== 'TimeoutError' && error.name !== 'AbortError') throw error;
  }
  if (alreadyRunning) {
    console.log('Локальный сервер уже работает. Повторный экземпляр не запускается.');
    showReady(existingSettings);
    return;
  }
  const logDir = join(settings.dataDir, 'logs');
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const logPath = join(logDir, 'server.log');
  try { if ((await stat(logPath)).size > 8 * 1024 ** 2) await rename(logPath, `${logPath}.previous`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const log = await open(logPath, 'a', 0o600);
  const child = spawn(process.execPath, [join(root, 'scripts/offline/server.mjs')], {
    cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, DW_OFFLINE_DATA_DIR: settings.dataDir,
      DW_OFFLINE_PORT: String(settings.port), DW_OFFLINE_SURVEY_PORT: String(settings.surveyPort),
      DW_OFFLINE_HOST: process.env.DW_OFFLINE_HOST ?? '0.0.0.0' },
  });
  let exitCode;
  let spawnError;
  child.once('exit', (code) => { exitCode = code ?? 1; });
  child.once('error', (error) => { spawnError = error; });
  await log.close();
  child.unref();
  const startedAt = Date.now();
  console.log('Запуск подготовленного локального сервера…');
  while (Date.now() - startedAt < 90000) {
    if (spawnError || exitCode !== undefined) throw new Error(`Сервер не запустился. Журнал: ${logPath}`);
    try {
      await verifiedRunning(settings, operator);
      if (platform() === 'darwin') {
        const awake = spawn('/usr/bin/caffeinate', ['-d', '-i', '-w', String(child.pid)], { detached: true, stdio: 'ignore' });
        awake.once('error', () => console.error('Не удалось включить предотвращение сна. Подключите питание и проверьте настройки сна Mac.'));
        awake.unref();
      }
      showReady(settings);
      return;
    } catch (error) {
      if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code) && error.name !== 'TimeoutError' && error.name !== 'AbortError') throw error;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Сервер не подтвердил готовность за 90 секунд. Процесс не завершался принудительно. Журнал: ${logPath}`);
}
function showReady(settings) {
  console.log(networkText(networkInventory(getNetworkInterfaces(), settings.port, settings.surveyPort)));
  console.log(`\nДанные занятия: ${settings.dataDir}\nПосле занятия откройте Stop-Seminar.command: создаётся резервная копия, база корректно закрывается.`);
  if (platform() === 'darwin') spawnSync('/usr/bin/open', [`${settings.origin}/#sessions=1`], { stdio: 'ignore' });
}

async function main() {
  let settings = localSettings();
  const command = process.argv[2] ?? 'status';
  if (command === 'preflight') {
    const result = await preflight(settings);
    console.log(`Каталог данных доступен; свободно ${(result.availableBytes / 1024 ** 3).toFixed(1)} ГиБ.`); return;
  }
  if (command === 'check') { await checkPrepared(settings); console.log('Полная локальная база подготовлена.'); return; }
  if (command === 'start') return start(settings);
  if (!['status', 'stop', 'backup'].includes(command)) throw new Error('Команда: preflight, check, start, status, backup или stop.');
  settings = await currentSettings(settings);
  const operator = await readOperator(settings);
  let running = false;
  try { await verifiedRunning(settings, operator); running = true; }
  catch (error) {
    if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code)) throw error;
  }
  if (command === 'status') { console.log(running ? 'Локальный сервер работает.' : 'Локальный сервер остановлен.'); return; }
  if (command === 'backup') {
    if (running) {
      const result = await backup(settings, operator);
      console.log(`Резервная копия создана: ${JSON.stringify(result)}`);
    } else {
      const result = spawnSync(process.execPath, [join(root, 'scripts/offline/server.mjs'), '--backup'], {
        cwd: root, env: { ...process.env, DW_OFFLINE_DATA_DIR: settings.dataDir }, stdio: 'inherit',
      });
      if (result.status !== 0) throw new Error('Резервная копия не была подтверждена.');
    }
    return;
  }
  if (!running) { console.log('Локальный сервер уже остановлен. Данные остаются на диске.'); return; }
  await backup(settings, operator);
  console.log('Резервная копия создана. Закрытие базы…');
  await fetchLocal(settings, '/offline/admin/stop', { method: 'POST', hostKey: operator.hostKey, timeout: 30000 });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((done) => setTimeout(done, 500));
    const runtime = await optionalJson(join(settings.dataDir, 'runtime.json'));
    if (!runtime) { console.log('Семинар остановлен; данные сохранены, резервная копия находится в каталоге данных.'); return; }
  }
  throw new Error('Завершение ещё не подтверждено. Процесс не убивался принудительно; проверьте журнал сервера.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
