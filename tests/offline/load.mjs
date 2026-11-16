/** Production corpus, durable PGlite and real HTTP. Run in Linux: node tests/offline/load.mjs [report.json]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openRuntime, atomicJson } from '../../scripts/offline/storage.mjs';
import { startServer } from '../../scripts/offline/server.mjs';

const participantCount = 100;
const teamCount = 10;
const rounds = 5;
const directory = await mkdtemp(join(tmpdir(), 'dw-offline-load-'));
const agent = new Agent({ keepAlive: true });
const metrics = new Map();
let runtime, app;
let queueHighWater = 0;
let activeRequests = 0;
let requestHighWater = 0;

try {
  const started = performance.now();
  const root = join(directory, 'site');
  await mkdir(join(root, 'dist'), { recursive: true });
  for (const file of ['index.html', 'survey.html'])
    await writeFile(join(root, 'dist', file), '<html><body>HTTP load fixture only</body></html>');
  runtime = await openRuntime({ dataDir: join(directory, 'database') });
  const enqueue = runtime.enqueue.bind(runtime);
  runtime.enqueue = task => {
    const pending = enqueue(task);
    queueHighWater = Math.max(queueHighWater, runtime.pending);
    return pending;
  };
  app = await startServer({ runtime, host: '127.0.0.1', port: 0, surveyPort: 0, root, backupIntervalMs: 0 });
  const base = `http://127.0.0.1:${app.port}`;
  const corpusPreparationMs = performance.now() - started;
  console.error(`Canonical workspace data prepared in ${(corpusPreparationMs / 1000).toFixed(1)} s`);

  // Distinct Linux loopback source addresses model each participant's LAN address,
  // including independent rate limits, without bypassing the real HTTP authentication.
  async function send(source, path, input, category, headers = {}) {
    const begin = performance.now();
    const body = JSON.stringify(input);
    activeRequests++;
    requestHighWater = Math.max(requestHighWater, activeRequests);
    const value = await new Promise((complete, fail) => {
      const req = request(base + path, {
        method: 'POST', agent, localAddress: source.address, signal: AbortSignal.timeout(120_000),
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Origin: base,
          ...(source.token ? { Authorization: `Bearer ${source.token}` } : {}), ...headers,
        },
      }, async response => {
        try {
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          assert.equal(response.statusCode, 200, `${path}: ${json.code ?? response.statusCode}`);
          complete(json);
        } catch (cause) { fail(cause); }
      });
      req.on('error', fail);
      req.end(body);
    }).finally(() => { activeRequests--; });
    if (!metrics.has(category)) metrics.set(category, []);
    metrics.get(category).push(performance.now() - begin);
    return value;
  }

  const rpc = (actor, method, input = {}) => send(actor, '/rest/v1/rpc/' + method, input, method);
  const host = { address: '127.0.0.1' };
  host.token = (await send(host, '/offline/auth/host-bootstrap', {}, 'host-auth',
    { 'X-Offline-Host-Bootstrap': '1' })).session.access_token;
  const signIn = performance.now();
  const participants = await Promise.all(Array.from({ length: participantCount }, async (_, index) => {
    const actor = { address: `127.0.0.${index + 2}` };
    const email = `synthetic-${index}@load.example.test`;
    const profile = await send(actor, '/offline/auth/identify', { email }, 'email lookup');
    assert.equal(profile.profileRequired, true);
    const { session } = await send(actor, '/offline/auth/identify',
      { email, fullName: `Участник испытания ${index + 1}` }, 'first profile');
    actor.token = session.access_token;
    const workspace = await rpc(actor, 'dw_enter_workspace', { p_operation_id: randomUUID() });
    return { ...actor, userId: session.user.id, sessionId: workspace.session.id };
  }));
  const sharedEntryMs = performance.now() - signIn;
  const p_session_id = participants[0].sessionId;
  const uniqueAccounts = new Set(participants.map(actor => actor.userId)).size;
  assert.equal(uniqueAccounts, participantCount);
  assert(participants.every(actor => actor.sessionId === p_session_id));
  const read = (actor, method, args = {}) => rpc(actor, method, { p_session_id, ...args });
  const mutate = (actor, method, p_input) => read(actor, method, { p_operation_id: randomUUID(), p_input });

  // Pick real territories from the same sealed dataset used by the workspace.
  const { datasetId } = runtime.ready.seed;
  const { rows: territories } = await runtime.db.query(`select territory_key
    from private.dw_roadmap_territories where dataset_id=$1 and region_id=$2 and level='municipality' and room_eligible
    order by territory_key limit $3`, [datasetId, 'respublika-mordoviia', teamCount]);
  assert.equal(territories.length, teamCount);
  const joinStarted = performance.now();
  const assigned = await Promise.all(participants.map(async (actor, index) => {
    const teamIndex = await read(actor, 'dw_roadmaps_index');
    const joined = await mutate(actor, 'dw_join_roadmap', {
      territoryKey: territories[index % teamCount].territory_key, dataEditionId: datasetId,
      expectedAssignmentRevision: teamIndex.assignmentRevision,
    });
    return { actor, roadmapId: joined.roadmapId, viewId: randomUUID() };
  }));
  const teamJoinMs = performance.now() - joinStarted;
  assert.equal(new Set(assigned.map(member => member.roadmapId)).size, teamCount);

  // At most one outstanding request per participant, with 100 real concurrent
  // connections during each burst. Each participant writes once during the exercise.
  const concurrentStart = performance.now();
  const requestsBefore = [...metrics.values()].reduce((sum, samples) => sum + samples.length, 0);
  for (let round = 1; round <= rounds; round++) {
    await Promise.all(assigned.map(async ({ actor, roadmapId, viewId }, index) => {
      await read(actor, 'dw_roadmap_presence', { p_view_id: viewId, p_roadmap_id: roadmapId, p_revision: round });
      await read(actor, 'dw_session_cursor');
      await read(actor, 'dw_roadmaps_cursor');
      if (index % rounds !== round % rounds) return;
      await mutate(actor, 'dw_save_roadmap_item', { roadmapId, itemId: null,
        expectedRevision: 0, kind: 'risk', status: 'active',
        data: { title: `Учебный риск ${index}`, mitigation: '', owner: '', trigger: '', contingency: '' } });
      await mutate(actor, 'dw_flipchart_add', { kind: 'barrier', text: `Учебная запись ${index}` });
      await mutate(actor, 'dw_save_barrier', { barrierId: null, expectedRevision: 0,
        title: `Учебный барьер ${index}`, description: '', primaryStage: 'work', stageIds: ['work'],
        evidenceKind: 'observation', status: 'active', priority: false });
    }));
    await Promise.all(assigned.map(({ actor, roadmapId }, index) => index % 3 === 0
      ? read(actor, 'dw_roadmap_snapshot', { p_roadmap_id: roadmapId })
      : index % 3 === 1 ? read(actor, 'dw_barriers_cursor') : read(actor, 'dw_workshop_cursor')));
  }
  const concurrentMs = performance.now() - concurrentStart;
  const concurrentRequests = [...metrics.values()].reduce((sum, samples) => sum + samples.length, 0) - requestsBefore;
  const { actor, roadmapId } = assigned[0];
  const sessionMembers = (await read(actor, 'dw_session_snapshot')).members.length;
  const barriers = (await read(actor, 'dw_barriers_snapshot')).barriers.length;
  const flipchartNotes = (await read(actor, 'dw_flipchart_updates', {
    p_after_cursor: null, p_projector: false, p_board: 'parenthood',
  })).notes.length;
  const presence = (await read(actor, 'dw_roadmap_presence', {
    p_view_id: null, p_roadmap_id: null, p_revision: 1,
  })).counts.reduce((sum, team) => sum + team.count, 0);
  const risks = (await read(actor, 'dw_roadmap_snapshot', { p_roadmap_id: roadmapId })).items
    .filter(item => item.kind === 'risk').length;
  for (const total of [sessionMembers, barriers, flipchartNotes, presence]) assert.equal(total, participantCount);
  assert.equal(risks, participantCount / teamCount);
  assert.equal(requestHighWater, participantCount);
  assert(queueHighWater > 0 && queueHighWater <= participantCount);

  const backups = await send(host, '/offline/admin/backup', {}, 'backup');
  const groups = {};
  const rounded = value => Number(value.toFixed(2));
  for (const [name, values] of metrics) {
    values.sort((a, b) => a - b);
    const at = q => rounded(values[Math.ceil(q * values.length) - 1]);
    groups[name] = { requests: values.length, p50Ms: at(.5), p95Ms: at(.95), maxMs: at(1) };
  }
  const report = {
    schemaVersion: 2, createdAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    node: process.version, pglite: '0.5.15', participants: participantCount, teams: teamCount,
    identification: 'email-and-full-name', joining: 'shared-workspace', canonical: runtime.ready.seed,
    corpusPreparationMs: rounded(corpusPreparationMs), sharedEntryMs: rounded(sharedEntryMs), teamJoinMs: rounded(teamJoinMs),
    concurrentBatchMs: rounded(concurrentMs), concurrentRequests,
    concurrentRequestsPerSecond: rounded(concurrentRequests / concurrentMs * 1000),
    observedMaxHttpRequests: requestHighWater, observedMaxQueueDepth: queueHighWater,
    groups, backupBytes: backups.backup.bytes,
    verified: { uniqueAccounts, sessionMembers, barriers, flipchartNotes, presence, risks, allRequestsSucceeded: true },
    scope: 'Linux container with loopback HTTP, distinct simulated LAN addresses, production PGlite and complete corpus.',
  };
  if (process.argv[2]) await atomicJson(resolve(process.argv[2]), report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  agent.destroy();
  if (app) await app.stop();
  else if (runtime) await runtime.close();
  await rm(directory, { recursive: true, force: true });
}
