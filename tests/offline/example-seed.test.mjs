import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../scripts/offline/storage.mjs';
import { identify } from '../../scripts/offline/auth.mjs';
import { EXAMPLE_SEED_SETTING, seedOfflineExample } from '../../scripts/offline/example.mjs';
import { buildSaranskExample } from '../../scripts/maintenance/saransk-example.mjs';

process.env.NODE_ENV = 'test';
const root = fileURLToPath(new URL('../../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const seed = async () => ({ fixture: true });

async function launch(dataDir) {
  const child = spawn(process.execPath, [join(root, 'scripts/offline/server.mjs')], {
    cwd: root, env: { ...process.env, DW_OFFLINE_DATA_DIR: dataDir, DW_OFFLINE_PORT: '0',
      DW_OFFLINE_SURVEY_PORT: '0', DW_OFFLINE_HOST: '127.0.0.1', DW_OFFLINE_OPEN_BROWSER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-5000); });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture server did not stop gracefully.')), 20000);
      exited.then(code => { clearTimeout(timer); resolve(code); });
    });
  };
  try {
    for (let attempt = 0; attempt < 900; attempt++) {
      if (child.exitCode !== null) throw new Error(`Fixture server exited: ${logs}`);
      try {
        const runtime = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8'));
        const origin = `http://127.0.0.1:${runtime.port}`;
        const response = await fetch(origin + '/offline/status');
        if (response.ok && (await response.json()).ready) return { child, stop, origin };
      } catch { /* Fresh canonical initialization has not begun listening yet. */ }
      await sleep(100);
    }
    throw new Error(`Fixture server startup timed out: ${logs}`);
  } catch (error) { await stop(); throw error; }
}

test('the normal production CLI creates only the teacher and complete example, then preserves new work on a second start', { timeout: 120000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dw-example-production-'));
  const template = await buildSaranskExample();
  let server;
  try {
    server = await launch(dataDir);
    const operatorBytes = await readFile(join(dataDir, 'operator.json'));
    const operator = JSON.parse(operatorBytes);
    const status = await (await fetch(server.origin + '/offline/admin/status', {
      headers: { Authorization: `Bearer ${operator.hostKey}` },
    })).json();
    assert.equal(status.counts.accounts, 1);
    assert.equal(status.counts.sessions, 1);
    const send = async (path, body, token) => {
      const response = await fetch(server.origin + path, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, 200, `${path}: ${result.code ?? response.status}`);
      return result;
    };
    const rpc = (token, name, args) => send('/rest/v1/rpc/' + name, args, token);
    const teacher = (await send('/offline/auth/identify', { email: 'omnistat@yandex.ru' })).session;
    assert.equal(teacher.user.user_metadata.full_name, 'Ситковский Арсений Михайлович');
    const workspace = await rpc(teacher.access_token, 'dw_enter_workspace', { p_operation_id: randomUUID() });
    const sid = workspace.session.id;
    const index = await rpc(teacher.access_token, 'dw_roadmaps_index', { p_session_id: sid });
    assert.equal(index.rooms.length, 1);
    assert.equal(index.rooms[0].exampleLabel, 'ПРИМЕР');
    const roomId = index.rooms[0].id;
    const snapshot = await rpc(teacher.access_token, 'dw_roadmap_snapshot', { p_session_id: sid, p_roadmap_id: roomId });
    assert.equal(snapshot.territory.key, template.territory.key);
    assert.equal(snapshot.items.length, template.items.length + template.factCaptures.length);
    assert.ok(snapshot.versions.length >= 1);
    assert.ok(snapshot.items.some(item => item.kind === 'fact'));
    assert.ok(snapshot.items.some(item => item.kind === 'funding'));
    const firstItems = snapshot.items.map(({ id, kind, revision, data }) => ({ id, kind, revision, data }));
    const participant = (await send('/offline/auth/identify', { email: 'new-work@example.test', fullName: 'Новая работа после подготовки' })).session;
    const state = { schemaVersion: 1, id: 'personal-workspace', title: 'Сохранено после подготовки', profile: null,
      sourceReferences: [], annotations: [], practiceProposals: [], linkDecisions: [], customCards: [], readingTasks: [],
      preferences: { selectedRegionId: null, selectedSourceEditionId: null, selectedPracticeId: null, activePanel: 'my-work', readerFontScale: 1 } };
    const saved = await rpc(participant.access_token, 'dw_workspace_commit', { p_operation_id: randomUUID(), p_expected_revision: 0, p_state: state });
    assert.equal(saved.kind, 'committed');
    await server.stop(); server = null;
    server = await launch(dataDir);
    assert.equal(sha(await readFile(join(dataDir, 'operator.json'))), sha(operatorBytes));
    const returned = (await send('/offline/auth/identify', { email: 'new-work@example.test' })).session;
    assert.equal(returned.user.id, participant.user.id);
    assert.deepEqual((await rpc(returned.access_token, 'dw_workspace_read', {})).snapshot.state, state);
    const instructor = (await send('/offline/auth/identify', { email: 'omnistat@yandex.ru' })).session;
    assert.equal(instructor.user.id, teacher.user.id);
    const current = await rpc(instructor.access_token, 'dw_roadmaps_index', { p_session_id: sid });
    assert.equal(current.rooms.length, 1);
    const restored = await rpc(instructor.access_token, 'dw_roadmap_snapshot', { p_session_id: sid, p_roadmap_id: roomId });
    assert.deepEqual(restored.items.map(({ id, kind, revision, data }) => ({ id, kind, revision, data })), firstItems);
    const after = await (await fetch(server.origin + '/offline/admin/status', { headers: { Authorization: `Bearer ${operator.hostKey}` } })).json();
    assert.equal(after.counts.accounts, 2);
  } finally { await server?.stop(); await rm(dataDir, { recursive: true, force: true }); }
});

test('an existing participant installation is left intact and is never seeded on ordinary upgrades', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dw-example-nonempty-'));
  let runtime;
  try {
    runtime = await openRuntime({ dataDir, testSeed: seed });
    const person = await identify(runtime, { email: 'existing@example.test', fullName: 'Существующий участник' });
    const before = (await runtime.db.query('select to_jsonb(u) as value from auth.users u')).rows;
    assert.deepEqual(await seedOfflineExample(runtime), { status: 'skipped-nonempty' });
    assert.deepEqual((await runtime.db.query('select to_jsonb(u) as value from auth.users u')).rows, before);
    assert.equal((await runtime.db.query('select count(*)::int n from public.dw_profiles')).rows[0].n, 1);
    assert.equal((await runtime.db.query('select count(*)::int n from private.dw_roadmaps')).rows[0].n, 0);
    assert.equal((await runtime.db.query('select user_id from offline.accounts')).rows[0].user_id, person.session.user.id);
    assert.equal((await seedOfflineExample(runtime)).status, 'already-prepared');
  } finally { await runtime?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('failed example initialization rolls back the teacher identity and marker in the same transaction', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dw-example-rollback-'));
  let runtime;
  try {
    runtime = await openRuntime({ dataDir, testSeed: seed });
    const failed = { ...runtime, db: { transaction: callback => runtime.db.transaction(tx => callback({
      ...tx, exec: async () => { throw new Error('example transaction failed'); },
    })) } };
    await assert.rejects(seedOfflineExample(failed), /example transaction failed/);
    for (const table of ['auth.users', 'private.dw_actors', 'public.dw_profiles', 'private.facilitators', 'offline.accounts', 'offline.sessions'])
      assert.equal((await runtime.db.query(`select count(*)::int n from ${table}`)).rows[0].n, 0, table);
    assert.equal((await runtime.db.query('select count(*)::int n from offline.settings where key=$1', [EXAMPLE_SEED_SETTING])).rows[0].n, 0);
  } finally { await runtime?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
