import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ipv4Kind, networkInventory, networkText } from '../../scripts/macos/network.mjs';
import { localSettings, fetchLocal } from '../../scripts/macos/control.mjs';
import { REQUIRED_DIRECTORIES, REQUIRED_FILES, writeManifest, checkManifest } from '../../scripts/macos/manifest.mjs';
import { nodeArchiveSpec, verifiedNodeArchive } from '../../scripts/macos/package-macos.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'demography-mac-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function fixture(t) {
  const directory = await temporary(t);
  for (const name of REQUIRED_DIRECTORIES) await mkdir(join(directory, name), { recursive: true });
  for (const name of [...REQUIRED_FILES, 'dist/index.html', 'dist/survey.html',
    'scripts/offline/server.mjs', 'public/data/corpus/index.json',
    'public/data/corpus/documents/region.json', 'public/data/territories/index.json',
    'public/data/originals/index.json', 'public/data/originals/123.pdf']) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), name === 'package.json' ? '{"version":"1.0.0"}' : `fixture: ${name}`);
  }
  return directory;
}
async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}
const respond = (response, data, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data));
};

test('network inventory keeps same-origin app/survey separate and does not suggest loopback to participants', () => {
  const addresses = networkInventory({
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en0: [{ family: 'IPv4', address: '192.168.50.2', internal: false }, { family: 'IPv6', address: 'fe80::a', internal: false }],
    utun0: [{ family: 'IPv4', address: '10.4.5.6', internal: false }],
    en1: [{ family: 'IPv4', address: '169.254.1.2', internal: false }],
  });
  assert.equal(addresses.candidates.length, 3);
  assert.equal(addresses.candidates[0].classroomUrl, 'http://192.168.50.2:8787/');
  assert.equal(addresses.candidates[0].surveyOrigin, 'http://192.168.50.2:8788');
  assert.ok(addresses.candidates.find((c) => c.name === 'utun0').likelyVirtual);
  assert.equal(addresses.automaticHotspot, false);
  assert.equal(addresses.automaticCaptivePortal, false);
  assert.match(networkText(addresses), /только на самом Mac/);
  assert.match(networkText(networkInventory({})), /пока не обнаружен/);
  assert.equal(ipv4Kind('192.168.300.1'), null);
  assert.equal(ipv4Kind('172.32.0.1'), 'public');
  assert.equal(ipv4Kind('172.31.0.1'), 'private');
});

test('ports cannot collapse the survey origin or become privileged/invalid', () => {
  assert.throws(() => localSettings({ DW_OFFLINE_PORT: '8787', DW_OFFLINE_SURVEY_PORT: '8787' }), /разные порты/);
  for (const value of ['80', 'NaN', '65536', '8787.5']) {
    assert.throws(() => localSettings({ DW_OFFLINE_PORT: value }), /1024/);
  }
});

test('prepared manifest rejects corruption, missing source PDF, and newly changed payload', async (t) => {
  const directory = await fixture(t);
  await writeManifest(directory);
  await checkManifest(directory);
  const pdf = join(directory, 'public/data/originals/123.pdf');
  await writeFile(pdf, 'modified');
  await assert.rejects(checkManifest(directory), /Изменён файл/);
  await writeManifest(directory);
  await rm(pdf);
  await assert.rejects(checkManifest(directory), /состав/);
  await writeManifest(directory);
  await writeFile(join(directory, 'public/data/corpus/documents/new.json'), 'new material');
  await assert.rejects(checkManifest(directory), /Состав файлов изменён/);
});

test('manifest cannot add traversal or symlinks out of payload', async (t) => {
  const directory = await fixture(t);
  const manifest = await writeManifest(directory);
  manifest.files[0].path = '../operator.json';
  manifest.fingerprint = sha(JSON.stringify(manifest.files));
  await writeFile(join(directory, 'macos/prepared-build.json'), JSON.stringify(manifest));
  await assert.rejects(checkManifest(directory), /Некорректный состав/);
  await symlink('/etc/hosts', join(directory, 'public/data/external'));
  await assert.rejects(writeManifest(directory), /Символическая ссылка/);
});

test('universal payload checks both native runtimes and official archive SHA-256', async (t) => {
  const directory = await fixture(t);
  for (const arch of ['arm64', 'x64']) {
    const binary = join(directory, `runtime/darwin-${arch}/bin/node`);
    await mkdir(dirname(binary), { recursive: true }); await writeFile(binary, `runtime:${arch}`);
  }
  const manifest = await writeManifest(directory);
  assert.equal(manifest.files.filter((f) => /^runtime\/darwin-.+\/bin\/node$/.test(f.path)).length, 2);
  const fakeArchive = join(directory, 'unverified.tar.gz');
  await writeFile(fakeArchive, 'invalid official archive');
  await assert.rejects(verifiedNodeArchive(nodeArchiveSpec('arm64'), fakeArchive), /SHA-256/);
  assert.equal(nodeArchiveSpec('x64').filename, 'node-v24.22.2-darwin-x64.tar.gz');
  assert.throws(() => nodeArchiveSpec('../../bad'), /Архитектура/);
});

test('local admin transport rejects redirects and non-JSON services', async (t) => {
  let redirect = true;
  const port = await listen(t, (request, response) => {
    if (redirect) { response.writeHead(302, { location: 'https://example.invalid/' }); response.end(); }
    else { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html>other service</html>'); }
  });
  const settings = localSettings({ DW_OFFLINE_PORT: String(port) });
  await assert.rejects(fetchLocal(settings, '/offline/status'));
  redirect = false;
  await assert.rejects(fetchLocal(settings, '/offline/status'), /не похож/);
  await assert.rejects(fetchLocal(settings, '/offline/admin/delete-everything'), /Недопустимый/);
});

test('Stop refuses an unrelated instance before submitting host credentials', async (t) => {
  const dataDir = await temporary(t);
  const instanceId = 'instructor-instance';
  const hostKey = 'secret-host-key-test-1234567890';
  await writeFile(join(dataDir, 'operator.json'), JSON.stringify({ schemaVersion: 1, instanceId, hostKey }));
  let submittedSecret = false;
  const port = await listen(t, (request, response) => {
    submittedSecret ||= request.headers.authorization !== undefined;
    respond(response, { mode: 'offline', ready: true, instanceId: 'unrelated-server' });
  });
  await assert.rejects(run(process.execPath, ['scripts/macos/control.mjs', 'stop'], {
    cwd: root, env: { ...process.env, DW_OFFLINE_DATA_DIR: dataDir, DW_OFFLINE_PORT: String(port), DW_OFFLINE_SURVEY_PORT: '18888' },
  }), (error) => /другой экземпляр/.test(error.stderr) && !error.stderr.includes(hostKey));
  assert.equal(submittedSecret, false);
});

test('Stop requires successful backup and asks the authenticated server to close; does not kill a PID', async (t) => {
  const dataDir = await temporary(t);
  const instanceId = 'owned-local-instance';
  const hostKey = 'secret-host-key-test-1234567890';
  await writeFile(join(dataDir, 'operator.json'), JSON.stringify({ schemaVersion: 1, instanceId, hostKey }));
  const commands = [];
  const port = await listen(t, async (request, response) => {
    if (request.url === '/offline/status') return respond(response, { mode: 'offline', ready: true, instanceId });
    assert.equal(request.headers.authorization, `Bearer ${hostKey}`);
    commands.push(request.url);
    if (request.url.endsWith('/stop')) await rm(join(dataDir, 'runtime.json'));
    respond(response, request.url.endsWith('/backup') ? { manifestPath: '/local/backup.json' } : { stopping: true });
  });
  await writeFile(join(dataDir, 'runtime.json'), JSON.stringify({ instanceId, pid: process.pid, port, surveyPort: 18888 }));
  const result = await run(process.execPath, ['scripts/macos/control.mjs', 'stop'], {
    cwd: root, env: { ...process.env, DW_OFFLINE_DATA_DIR: dataDir },
  });
  assert.deepEqual(commands, ['/offline/admin/backup', '/offline/admin/stop']);
  assert.match(result.stdout, /данные сохранены/);
  assert.ok(!result.stdout.includes(hostKey));
});

test('Start does not initialize an unprepared database on the teaching day', async (t) => {
  const dataDir = await temporary(t);
  await assert.rejects(run(process.execPath, ['scripts/macos/control.mjs', 'start'], {
    cwd: root, env: { ...process.env, DW_OFFLINE_DATA_DIR: dataDir },
  }), (error) => /ещё не подготовлена/.test(error.stderr));
  await assert.rejects(readFile(join(dataDir, 'operator.json')), { code: 'ENOENT' });
});

test('failed backup leaves the live server running and never submits stop', async (t) => {
  const dataDir = await temporary(t);
  const instanceId = 'owned-local-instance';
  const hostKey = 'secret-host-key-test-1234567890';
  await writeFile(join(dataDir, 'operator.json'), JSON.stringify({ schemaVersion: 1, instanceId, hostKey }));
  const commands = [];
  const port = await listen(t, (request, response) => {
    if (request.url === '/offline/status') return respond(response, { mode: 'offline', ready: true, instanceId });
    commands.push(request.url);
    respond(response, { error: 'disk unavailable' }, 507);
  });
  await writeFile(join(dataDir, 'runtime.json'), JSON.stringify({ instanceId, pid: process.pid, port, surveyPort: 18888 }));
  await assert.rejects(run(process.execPath, ['scripts/macos/control.mjs', 'stop'], {
    cwd: root, env: { ...process.env, DW_OFFLINE_DATA_DIR: dataDir },
  }), (error) => /HTTP 507/.test(error.stderr));
  assert.deepEqual(commands, ['/offline/admin/backup']);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')).instanceId, instanceId);
});

test('Mac command scripts preserve valid system Bash syntax', async () => {
  for (const file of ['scripts/macos/common.sh', 'macos/Prepare.command', 'macos/Start-Seminar.command',
    'macos/Stop-Seminar.command', 'macos/Backup.command', 'macos/Network.command']) {
    await run('bash', ['-n', join(root, file)]);
  }
});
