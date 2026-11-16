/** Use only a fresh, disposable local PostgreSQL database: DW_LOAD_PORT=15454 node tests/collaboration/load-classroom.mjs */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { loadRoadmapDataset, seedRoadmapDataset } from '../../scripts/seed-roadmaps.mjs';

const users = 100;
const port = Number(process.env.DW_LOAD_PORT);
assert(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Set DW_LOAD_PORT to a disposable local PostgreSQL port.');
const pool = new Pool({ host: '127.0.0.1', port, database: 'dw_load_fixture', user: 'postgres', max: 16 });
const metrics = new Map();
const start = performance.now();
const province = 'respublika-mordoviia';
const record = (name, ms) => metrics.set(name, [...(metrics.get(name) ?? []), ms]);
async function request(name, sql, params) {
  const begin = performance.now();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role anon');
    const { rows } = await client.query(sql, params);
    await client.query('commit');
    record(name, performance.now() - begin);
    return rows[0].result;
  } catch (cause) {
    await client.query('rollback');
    throw new Error(`${name}: ${cause.message}`, { cause });
  } finally { client.release(); }
}
const rpc = (actor, method, args = {}) => request(method, 'select public.dw_entry_rpc($1,$2,$3::jsonb) result',
  [actor.access_token, method, JSON.stringify(args)]);

try {
  const setup = await pool.connect();
  let dataset, server;
  try {
    const guard = (await setup.query("select current_database() db, current_setting('server_version') version, to_regnamespace('auth') fresh")).rows[0];
    assert.equal(guard.db, 'dw_load_fixture');
    assert.equal(guard.fresh, null, 'Use a fresh local database.');
    server = guard.version;
    await setup.query(await readFile(new URL('../database/bootstrap.sql', import.meta.url), 'utf8'));
    const migrations = new URL('../../supabase/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort())
      await setup.query(await readFile(new URL(file, migrations), 'utf8'));
    dataset = await loadRoadmapDataset({ fixture: true, regionIds: [province] });
    await seedRoadmapDataset(setup, dataset, { allowFixture: true });
  } finally { setup.release(); }

  const deadline = AbortSignal.timeout(120_000);
  const cohort = await Promise.all(Array.from({ length: users }, async (_, index) => {
    const email = `synthetic-${index}@classroom-load.example.test`;
    const profile = await request('email lookup', 'select public.dw_identify($1) result', [email]);
    assert.equal(profile.profileRequired, true);
    const { session } = await request('first profile', 'select public.dw_identify($1,$2) result', [email, `Участник испытания ${index + 1}`]);
    const workspace = await rpc(session, 'dw_enter_workspace', { p_operation_id: randomUUID() });
    return { actor: session, workspace };
  }));
  deadline.throwIfAborted();
  const p_session_id = cohort[0].workspace.session.id;
  assert(cohort.every(({workspace}) => workspace.session.id === p_session_id));
  assert.equal(new Set(cohort.map(({actor}) => actor.user.id)).size, users);
  const read = (actor, method, extra) => rpc(actor, method, { p_session_id, ...extra });
  const mutate = (actor, method, p_input) => read(actor, method, { p_operation_id: randomUUID(), p_input });
  const municipalities = dataset.territories.filter(({ record }) => record.regionId === province && record.level === 'municipality');
  const assigned = await Promise.all(cohort.map(async ({ actor }, i) => {
    const territoryKey = municipalities[i % 10].record.territoryKey;
    const index = await read(actor, 'dw_roadmaps_index');
    const map = await mutate(actor, 'dw_join_roadmap', { territoryKey, dataEditionId: dataset.id, expectedAssignmentRevision: index.assignmentRevision });
    return { actor, roadmap: map.roadmapId, territoryKey, viewId: randomUUID() };
  }));
  assert.equal(new Set(assigned.map(({roadmap}) => roadmap)).size, 10);

  // Renew all 100 team leases; a subset performs writes during each read burst.
  for (let round = 1; round <= 5; ++round) {
    deadline.throwIfAborted();
    await Promise.all(assigned.map(async ({ actor, roadmap, viewId }, index) => {
      await read(actor, 'dw_roadmap_presence', { p_view_id: viewId, p_roadmap_id: roadmap, p_revision: round });
      await read(actor, 'dw_session_cursor');
      await read(actor, 'dw_roadmaps_cursor');
      if (index % 5 !== round % 5) return;
      await mutate(actor, 'dw_save_roadmap_item', { roadmapId: roadmap, itemId: null,
        expectedRevision: 0, kind: 'risk', status: 'active',
        data: { title: `Учебный риск ${index}`, mitigation: '', owner: '', trigger: '', contingency: '' } });
      await mutate(actor, 'dw_flipchart_add', { kind: 'barrier', text: `Учебная запись ${index}` });
      await mutate(actor, 'dw_save_barrier', { barrierId: null, expectedRevision: 0,
        title: `Учебный барьер ${index}`, description: '', primaryStage: 'work', stageIds: ['work'],
        evidenceKind: 'observation', status: 'active', priority: false });
    }));
    await Promise.all(assigned.map(({ actor, roadmap }, index) => index % 3 === 0
      ? read(actor, 'dw_roadmap_snapshot', { p_roadmap_id: roadmap })
      : index % 3 === 1 ? read(actor, 'dw_barriers_cursor') : read(actor, 'dw_workshop_cursor')));
  }
  const { actor } = cohort[0];
  assert.equal((await read(actor, 'dw_session_snapshot')).members.length, users);
  assert.equal((await read(actor, 'dw_barriers_snapshot')).barriers.length, users);
  assert.equal((await read(actor, 'dw_flipchart_updates', { p_after_cursor: null, p_projector: false, p_board: 'parenthood' })).notes.length, users);
  assert.equal((await read(actor, 'dw_roadmap_snapshot', { p_roadmap_id: assigned[0].roadmap })).items.filter(item => item.kind === 'risk').length, 10);
  const presence = await read(actor, 'dw_roadmap_presence', { p_view_id: null, p_roadmap_id: null, p_revision: 1 });
  assert.equal(presence.counts.reduce((n, room) => n + room.count, 0), users);
  const report = { users, server, poolConnections: 16, durationMs: Math.round(performance.now() - start),
    scope: 'Local native PostgreSQL with the deployed declared-email RPCs and migrations; no hosted gateway or browser latency.',
    totals: Object.fromEntries([...metrics].map(([name, group]) => {
      group.sort((a, b) => a - b);
      return [name, { requests: group.length, p50Ms: +group[Math.ceil(group.length / 2) - 1].toFixed(1),
        p95Ms: +group[Math.ceil(group.length * .95) - 1].toFixed(1), maxMs: +group.at(-1).toFixed(1) }];
    })) };
  const serialized = JSON.stringify(report, null, 2);
  if (process.argv[2]) await writeFile(process.argv[2], serialized + '\n');
  console.log(serialized);
} finally { await pool.end(); }
