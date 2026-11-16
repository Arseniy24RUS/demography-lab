/** HTTPS load exercise of a dedicated, invitation-only synthetic classroom. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Agent, request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { loadRoadmapDataset } from '../../scripts/seed-roadmaps.mjs';

const titlePrefix = 'Нагрузочный тест DW ';
const actorPrefix = 'Нагрузочный тест DW ';
const emailDomain = 'classroom-load.example.test';
const regionId = 'respublika-mordoviia';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const tokenPattern = /^[0-9a-f]{64}$/;
const codePattern = /^[A-Z0-9_]{2,48}$/;
const intervalMs = 2_000;
const slowThresholdMs = 2_000;
const stopAtSlowResponses = 5;
const teamCount = 10;
const ramp = [1, 10, 25, 50, 100];

function check(condition, reason) {
  if (!condition) throw new Error(reason);
}

function statistics(samples) {
  if (!samples.length) return { count: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => Math.round(sorted[Math.ceil(p * sorted.length) - 1]);
  return { count: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1) };
}

// Keep the generator's TLS pool bounded across the virtual clients. The
// measured client latency includes time spent waiting for a socket.
export function hostedTransport(agent) {
  return (url, { method, headers, body, signal }) => new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, agent, signal }, res => {
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { req.destroy(new Error('Response too large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject);
    req.end(body);
  });
}

export async function runHostedClassroom({ config, runId, operatorToken, reportFile, count = 100, holdSeconds = 45,
  sessionId, transport, transportName, stages = ramp, writeMode = 'paced' }) {
  check(/^[0-9a-f]{12}$/.test(runId ?? ''), 'Set DW_HOSTED_QA_RUN_ID to a fresh 12-character hexadecimal identifier.');
  check(Number.isInteger(count) && count >= 1 && count <= 100, 'The test supports 1–100 participants.');
  check(Number.isInteger(holdSeconds) && holdSeconds >= 4 && holdSeconds <= 180, 'The full stage must run 4–180 seconds.');
  check(writeMode === 'paced' || writeMode === 'burst', 'Use paced or burst writes.');
  check(typeof reportFile === 'string' && reportFile.endsWith('.json'), 'Pass the report path as the first argument.');
  check(tokenPattern.test(operatorToken ?? ''), 'Set DW_HOSTED_QA_OPERATOR_TOKEN to the test organizer token.');
  if (sessionId) check(uuid.test(sessionId), 'Set DW_HOSTED_QA_SESSION_ID to the test classroom ID.');
  const service = new URL(config.supabaseUrl);
  check(service.protocol === 'https:' && /^[a-z0-9]{20}\.supabase\.co$/.test(service.hostname) &&
    service.href === `${service.origin}/` && config.supabasePublishableKey?.startsWith('sb_publishable_'), 'Expected a hosted Supabase project and its public key.');
  const dataset = await loadRoadmapDataset({ fixture: true, regionIds: [regionId] });
  const teams = dataset.territories.filter(({ record }) => record.regionId === regionId && record.level === 'municipality' && record.roomEligible).slice(0, teamCount);
  check(teams.length === teamCount, 'The release is missing the ten eligible territories required by this test.');
  const httpsAgent = transport ? null : new Agent({ keepAlive: true, maxSockets: 48, maxFreeSockets: 12 });
  const send = transport ?? hostedTransport(httpsAgent);

  const title = `${titlePrefix}${runId}`;
  const report = { runId, sessionId: sessionId ?? null, sessionTitle: title, project: service.hostname, participantsRequested: count,
    startedAt: new Date().toISOString(), holdSeconds, pollingIntervalMs: intervalMs, transport: transportName ?? 'HTTPS',
    writeMode, result: 'running', stages: [], checks: {}, errors: [], recoveredTransport: [] };
  const writeReport = () => writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  const actors = [];
  const operator = { token: operatorToken };
  const started = performance.now();
  const totals = new Map();
  let phase = null;
  let inFlight = 0;
  let peakInFlight = 0;
  let successfulRequests = 0;
  let stopping = false;
  let createdHere = false;
  let invitationCode;
  let completedFullPolls = 0;
  const track = (endpoint, elapsed) => {
    if (!totals.has(endpoint)) totals.set(endpoint, []);
    totals.get(endpoint).push(elapsed);
  };

  async function request(endpoint, body, name = endpoint) {
    const active = phase;
    const start = performance.now();
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    if (active) active.peakInFlight = Math.max(active.peakInFlight, inFlight);
    let status = 0;
    let code = 'NETWORK';
    try {
      const retryable = endpoint === 'dw_entry_rpc' || endpoint === 'dw_identify' && !body.p_full_name;
      const sendOnce = async () => {
        const signal = AbortSignal.timeout(4_500);
        try {
          return await send(`${service.origin}/rest/v1/rpc/${endpoint}`, {
            method: 'POST', headers: { apikey: config.supabasePublishableKey, 'Content-Type': 'application/json',
              'User-Agent': `DW-hosted-capacity/${runId}` },
            body: JSON.stringify(body), signal, redirect: 'error',
          });
        } catch (cause) { if (signal.aborted) throw signal.reason; throw cause; }
      };
      let response;
      try { response = await sendOnce(); }
      catch (first) {
        if (!retryable || stopping) throw first;
        // Mutations retain the same operation ID in body on replay.
        await sleep(60);
        response = await sendOnce();
        report.recoveredTransport.push({ stage: active?.name ?? null, endpoint: name,
          issue: first?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK' });
      }
      status = response.status;
      code = 'INVALID_JSON';
      const value = await response.json();
      if (!response.ok || value?.error) {
        const candidates = [value?.error?.code, value?.message, value?.code];
        code = candidates.find(candidate => typeof candidate === 'string' && codePattern.test(candidate)) ?? 'HTTP_ERROR';
        throw new Error('RPC error');
      }
      const elapsed = performance.now() - start;
      successfulRequests++;
      track(name, elapsed);
      active?.latencies.push(elapsed);
      if (active?.name.startsWith('active-') && elapsed >= slowThresholdMs && ++active.slowResponses >= stopAtSlowResponses)
        stopping = true;
      return value;
    } catch (cause) {
      const socketCode = cause?.code ?? cause?.cause?.code;
      if (!status && cause?.name === 'TimeoutError') code = 'TIMEOUT';
      else if (!status && typeof socketCode === 'string' && codePattern.test(socketCode)) code = socketCode;
      if (report.errors.length < 30) report.errors.push({ stage: active?.name ?? null, endpoint: name, status, code });
      if (active) active.errors++;
      throw new Error(`${name}: ${status || 'no response'} ${code}`);
    } finally { inFlight--; }
  }

  const rpc = (actor, method, args = {}) => request('dw_entry_rpc', { p_token: actor.token, p_method: method, p_args: args }, method);
  const read = (actor, method, extra = {}) => rpc(actor, method, { p_session_id: report.sessionId, ...extra });
  const mutate = (actor, method, input) => read(actor, method, { p_operation_id: randomUUID(), p_input: input });

  async function batch(name, participants, action) {
    const current = { name, participants, peakInFlight: 0, errors: 0, slowResponses: 0, latencies: [] };
    phase = current;
    const start = performance.now();
    try { await action(); }
    finally {
      phase = null;
      const { latencies, ...stage } = current;
      report.stages.push({ ...stage, ...statistics(latencies), durationMs: Math.round(performance.now() - start) });
      await writeReport();
      process.stdout.write(JSON.stringify(report.stages.at(-1)) + '\n');
    }
  }

  async function parallel(entries, operation) {
    const results = await Promise.allSettled(entries.map(operation));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return results.map(result => result.value);
  }

  async function join(index) {
    const email = `dw-cloud-load-${runId}-${index}@${emailDomain}`;
    const profile = await request('dw_identify', { p_email: email }, 'dw_identify_lookup');
    check(profile?.profileRequired === true && profile.email === email, 'The generated actor already exists or the login contract changed.');
    const { session } = await request('dw_identify', { p_email: email, p_full_name: `${actorPrefix}${runId} ${index + 1}` }, 'dw_identify_profile');
    check(uuid.test(session?.user?.id ?? '') && tokenPattern.test(session?.access_token ?? ''), 'Missing structured actor credentials.');
    const actor = { index, id: session.user.id, token: session.access_token, viewId: randomUUID() };
    actors.push(actor);
    const entered = await rpc(actor, 'dw_join_session', { p_operation_id: randomUUID(), p_code: invitationCode });
    check(entered?.session?.id === report.sessionId && entered.session.title === title && entered.session.role === 'participant',
      'The invitation did not return the dedicated classroom.');
    actor.sessionCursor = entered.cursor;
    const boards = await read(actor, 'dw_roadmaps_index');
    const { record } = teams[index % teamCount];
    const roadmap = await mutate(actor, 'dw_join_roadmap', { territoryKey: record.territoryKey, dataEditionId: dataset.id,
      expectedAssignmentRevision: boards.assignmentRevision });
    check(uuid.test(roadmap?.roadmapId ?? '') && roadmap.sessionId === report.sessionId && roadmap.territory?.key === record.territoryKey,
      'The roadmap does not belong to the dedicated classroom and territory.');
    actor.roadmapId = roadmap.roadmapId;
    actor.screen = ['roadmaps', 'roadmaps', 'roadmaps', 'barriers', 'workshop'][index % 5];
    actor.roadmapCursor = roadmap.cursor;
    actor.leaseRevision = 0;
    actor.lastPresence = 0;
  }

  async function poll(actor) {
    const sessionCursor = await read(actor, 'dw_session_cursor');
    if (sessionCursor !== actor.sessionCursor) actor.sessionCursor = (await read(actor, 'dw_session_snapshot')).cursor;
    if (actor.screen === 'roadmaps') {
      const sourceCursor = await read(actor, 'dw_barriers_cursor');
      if (sourceCursor !== actor.barrierSourceCursor)
        actor.barrierSourceCursor = (await read(actor, 'dw_barriers_snapshot')).cursor;
      const cursor = await read(actor, 'dw_roadmaps_cursor');
      if (cursor !== actor.roadmapCursor) {
        await read(actor, 'dw_roadmaps_index');
        actor.roadmapCursor = (await read(actor, 'dw_roadmap_snapshot', { p_roadmap_id: actor.roadmapId })).cursor;
      }
      if (performance.now() - actor.lastPresence >= 8_000 || !actor.leaseRevision) {
        await read(actor, 'dw_roadmap_presence', { p_view_id: actor.viewId, p_roadmap_id: actor.roadmapId, p_revision: ++actor.leaseRevision });
        actor.lastPresence = performance.now();
      }
    } else {
      const cursor = await read(actor, `dw_${actor.screen}_cursor`);
      if (cursor !== actor.screenCursor) actor.screenCursor = (await read(actor, `dw_${actor.screen}_snapshot`)).cursor;
    }
  }

  async function save(actor) {
    await mutate(actor, 'dw_save_barrier', { barrierId: null, expectedRevision: 0, title: `Учебный барьер ${actor.index + 1}`,
      description: 'Проверка сохранения в нагрузочном тесте.', primaryStage: 'life_plans', stageIds: ['life_plans'],
      evidenceKind: 'observation', status: 'active', priority: false });
    await mutate(actor, 'dw_save_roadmap_item', { roadmapId: actor.roadmapId, itemId: null, expectedRevision: 0, kind: 'risk', status: 'active',
      data: { title: `Учебный риск ${actor.index + 1}`, mitigation: '', owner: '', trigger: '', contingency: '' } });
    if (actor.index < teamCount) {
      await mutate(actor, 'dw_roadmap_cohort_save', { roadmapId: actor.roadmapId, expectedRevision: 0,
        parameters: { endYear: 2080, fertilityMultiplier: 1.1, mortalityMultiplier: 1, arrivalsMultiplier: 1, departuresMultiplier: 1 } });
    }
  }

  async function exercise(participants) {
    await parallel(actors, async actor => { actor.sessionCursor = await read(actor, 'dw_session_cursor'); });
    check(!stopping, `Stopped at ${participants} participants: successive requests exceeded the latency safeguard.`);
    const full = participants === count;
    const windowStart = performance.now();
    const deadline = windowStart + (full ? holdSeconds * 1_000 : 4_000);
    const jobs = actors.map(async actor => {
      try {
        await sleep((actor.index * 149) % intervalMs);
        const writeAt = writeMode === 'burst' ? windowStart : windowStart + 1_500 + actor.index / count * Math.max(0, holdSeconds * 1_000 - 6_000);
        let saved = false;
        while (!stopping && performance.now() < deadline) {
          const start = performance.now();
          if (full && !saved && start >= writeAt) {
            await save(actor);
            saved = true;
          }
          await poll(actor);
          if (full) completedFullPolls++;
          const next = Math.min(deadline - performance.now(), intervalMs - (performance.now() - start));
          if (next > 0) await sleep(next);
        }
        if (full && !stopping) check(saved, 'A participant did not complete its scheduled writes.');
      } catch (cause) { stopping = true; throw cause; }
    });
    const results = await Promise.allSettled(jobs);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    check(!stopping, `Stopped at ${participants} participants: multiple requests exceeded two seconds.`);
  }

  let resultError;
  try {
    await writeReport();
    if (!sessionId) {
      const profile = await rpc(operator, 'dw_bootstrap');
      check(profile?.canCreateSession && profile.profile?.fullName === `${actorPrefix}${runId} Организатор` && profile.sessions?.length === 0,
        'The organizer must be dedicated to this run and have no existing classroom memberships.');
      const created = await rpc(operator, 'dw_create_session', { p_operation_id: randomUUID(), p_title: title,
        p_scope: 'municipality', p_region_id: regionId });
      check(uuid.test(created?.session?.id ?? '') && created.session.title === title && created.session.role === 'host', 'Failed to create the dedicated classroom.');
      report.sessionId = created.session.id;
      createdHere = true;
      await writeReport();
    } else {
      const prepared = await read(operator, 'dw_session_snapshot');
      check(prepared?.session?.id === sessionId && prepared.session.title === title && prepared.session.role === 'host' &&
        prepared.session.status === 'open' && prepared.session.joinOpen === true && prepared.members?.length === 1,
        'The supplied classroom is not an empty test session with the expected designation.');
    }
    invitationCode = (await read(operator, 'dw_invitation')).code;
    check(/^[0-9A-F]{12}$/.test(invitationCode), 'Missing invitation for the dedicated classroom.');
    const levels = [...new Set([...stages.filter(level => level < count), count])];
    for (const level of levels) {
      const missing = Array.from({ length: level - actors.length }, (_, i) => actors.length + i);
      await batch(`join-${level}`, missing.length, async () => {
        for (let offset = 0; offset < missing.length; offset += 10) await parallel(missing.slice(offset, offset + 10), join);
      });
      await batch(`active-${level}`, level, () => exercise(level));
    }
    check(new Set(actors.map(actor => actor.id)).size === count, 'The declared identities must be distinct.');
    const representative = actors[0];
    const room = await read(representative, 'dw_session_snapshot');
    const participantIds = new Set(room.members.filter(member => member.role === 'participant').map(member => member.userId));
    check(participantIds.size === count && actors.every(actor => participantIds.has(actor.id)), 'Participant count or identity mismatch.');
    const barriers = await read(representative, 'dw_barriers_snapshot');
    check(barriers.barriers.length === count, 'The persisted barrier count does not match the workload.');
    const rooms = Map.groupBy(actors, actor => actor.roadmapId);
    check(rooms.size === Math.min(count, teamCount), 'An incorrect number of teams was created.');
    await parallel([...rooms], async ([id, members]) => {
      const actor = members.at(-1);
      const params = { p_roadmap_id: id };
      const snapshot = await read(actor, 'dw_roadmap_snapshot', params);
      check(snapshot.members.length === members.length && snapshot.items.filter(item => item.kind === 'risk').length === members.length &&
        snapshot.cohortSettings?.parameters?.endYear === 2080, 'Missing persisted roadmap writes or shared forecast.');
      const draft = await read(actor, 'dw_roadmap_version', { ...params, p_version_id: null });
      check(draft.roadmapId === id && draft.roadmapRevision === snapshot.revision &&
        typeof draft.canonicalJson === 'string' && createHash('sha256').update(draft.canonicalJson).digest('hex') === draft.sha256,
        'The export did not return the latest hashed roadmap draft.');
    });
    report.checks = { participants: count, teams: rooms.size, savedBarriers: count, savedRisks: count, forecasts: rooms.size,
      validatedExportDrafts: rooms.size, completedFullPolls };
    report.result = 'passed';
  } catch (cause) {
    resultError = cause;
    report.result = 'failed';
    report.failure = cause instanceof Error ? cause.message : 'Unknown test failure';
  } finally {
    report.peakInFlight = peakInFlight;
    report.durationMs = Math.round(performance.now() - started);
    report.httpRequestsSucceeded = successfulRequests;
    report.endpoints = Object.fromEntries([...totals].map(([name, samples]) => [name, statistics(samples)]));
    if (createdHere) {
      try {
        const snapshot = await read(operator, 'dw_session_snapshot');
        const closed = await read(operator, 'dw_update_session', { p_operation_id: randomUUID(), p_expected_revision: snapshot.session.revision,
          p_patch: { status: 'closed', joinOpen: false } });
        report.closed = closed.session.status === 'closed' && closed.session.joinOpen === false;
      } catch { report.closed = false; }
    }
    const tokens = [...actors.map(actor => actor.token), ...(createdHere ? [operator.token] : [])];
    let loggedOut = 0;
    for (let offset = 0; offset < tokens.length; offset += 10) {
      const done = await Promise.allSettled(tokens.slice(offset, offset + 10).map(token => request('dw_entry_logout', { p_token: token })));
      loggedOut += done.filter(outcome => outcome.status === 'fulfilled').length;
    }
    report.sessionsLoggedOut = loggedOut;
    report.sessionsMintedOrSupplied = tokens.length;
    report.finishedAt = new Date().toISOString();
    httpsAgent?.destroy();
    await writeReport();
  }
  if (resultError) throw resultError;
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes('--help')) {
    console.log('node tests/collaboration/load-hosted-classroom.mjs ABSOLUTE_REPORT.json');
    console.log('Provision a dedicated synthetic organizer. Set DW_HOSTED_QA_OPERATOR_TOKEN and a fresh 12-hex DW_HOSTED_QA_RUN_ID.');
    console.log('Alternatively supply a matching empty classroom you already created in DW_HOSTED_QA_SESSION_ID with its organizer token.');
    console.log('Optional DW_HOSTED_QA_ACTORS (1–100) and DW_HOSTED_QA_HOLD_SECONDS (4–180). Default: 100 participants and 45 seconds.');
  } else {
    const config = JSON.parse(await readFile(new URL('../../public/workshop-config.json', import.meta.url), 'utf8'));
    try {
      await runHostedClassroom({ config, runId: process.env.DW_HOSTED_QA_RUN_ID, operatorToken: process.env.DW_HOSTED_QA_OPERATOR_TOKEN,
        sessionId: process.env.DW_HOSTED_QA_SESSION_ID,
        reportFile: process.argv[2], count: Number(process.env.DW_HOSTED_QA_ACTORS ?? 100), holdSeconds: Number(process.env.DW_HOSTED_QA_HOLD_SECONDS ?? 45),
        writeMode: process.env.DW_HOSTED_QA_WRITE_MODE ?? 'paced' });
    } catch (cause) {
      console.error(cause instanceof Error ? cause.message : 'Unknown test failure');
      process.exitCode = 1;
    }
  }
}
