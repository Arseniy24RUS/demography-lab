#!/usr/bin/env node
/**
 * Test-only HTTP adapter for the real supabase-js client and the actual migration.
 * This is deliberately NOT GoTrue, PostgREST, SMTP, Realtime, or a deployable backend.
 * It refuses to start without an explicit flag and never listens outside loopback.
 */
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createTestDatabase, rpcArguments, seedAuthUser, seedCanonicalDocument } from '../tests/database/harness.mjs';
import { loadRoadmapDataset, seedRoadmapDataset } from './seed-roadmaps.mjs';

export const FIXTURE_PUBLISHABLE_KEY = 'sb_publishable_workshop_fixture_only';
export const FIXTURE_IDENTITIES = Object.freeze({
  'teacher@workshop.test': { id: '00000000-0000-4000-8000-000000000001', facilitator: true },
  'participant-a@workshop.test': { id: '00000000-0000-4000-8000-000000000002', facilitator: false },
  'participant-b@workshop.test': { id: '00000000-0000-4000-8000-000000000003', facilitator: false },
  'observer@workshop.test': { id: '00000000-0000-4000-8000-000000000004', facilitator: false },
});

const MAX_BODY_BYTES = 512 * 1024;
const TOKEN_LIFETIME_SECONDS = 3600;
const FIXTURE_OTP_LIFETIME_MS = 5 * 60 * 1000;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
// This explicit list excludes private host review/export and every named board mutation.
// It is enabled only by the second, explicitly configured loopback survey origin.
const ANONYMOUS_SURVEY_RPCS = new Set([
  'dw_survey_public_manifest',
  'dw_survey_own_response',
  'dw_survey_save_response',
  'dw_survey_withdraw_response',
]);

// Two source-backed municipalities, one real municipality without joined source
// statistics, and the real region/federal identities cover all team input paths.
// Explicit fixture filtering never substitutes synthetic statistical facts.
let roadmapFixture;

/** Prepared regional variants use these real, unchanged corpus editions. */
async function createGatewayDatabase() {
  const database = await createTestDatabase({ seedCorpus: true });
  try {
    for (const region of ['permskii-krai', 'tambovskaia-oblast', 'sakhalinskaia-oblast']) {
      const document = JSON.parse(await readFile(new URL(
        `../public/data/corpus/documents/regional-${region}.json`, import.meta.url,
      ), 'utf8'));
      await seedCanonicalDocument(database, document);
    }
    roadmapFixture ??= loadRoadmapDataset({
      regionIds: ['respublika-mordoviia', 'stavropolskii-krai'],
      territoryKeys: ['rudn-mun-72196-894', 'rudn-mun-72196-904', 'rudn-mun-108081-1730'],
      fixture: true,
    });
    await seedRoadmapDataset(database, await roadmapFixture, { allowFixture: true });
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

function fixtureError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function jsonBody(request) {
  let length = 0;
  const buffers = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES)
      throw fixtureError(413, 'payload_too_large', 'Fixture request is too large.');
    buffers.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(buffers).toString('utf8') || '{}');
  } catch {
    throw fixtureError(400, 'invalid_json', 'Request must contain a JSON object.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fixtureError(400, 'invalid_json', 'Request must contain a JSON object.');
  }
  return value;
}

function normalizedEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!Object.hasOwn(FIXTURE_IDENTITIES, email)) {
    throw fixtureError(
      400,
      'fixture_identity_only',
      'Only the four reserved workshop.test fixture identities are supported.',
    );
  }
  return email;
}

/** All database operations run in one queue: no concurrent request may reuse claims. */
export async function startFixtureGateway({
  port = Number(process.env.WORKSHOP_TEST_GATEWAY_PORT ?? 54321),
  appOrigin = process.env.WORKSHOP_TEST_APP_ORIGIN ?? 'http://127.0.0.1:4173',
  surveyOrigin = process.env.WORKSHOP_TEST_SURVEY_ORIGIN,
  adminSecret = process.env.WORKSHOP_TEST_ADMIN_SECRET,
} = {}) {
  if (process.env.WORKSHOP_TEST_GATEWAY !== '1') {
    throw new Error(
      'Refusing to start: WORKSHOP_TEST_GATEWAY=1 is required for this test fixture.',
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid fixture port.');
  const allowedOrigins = new Set([appOrigin, ...(surveyOrigin ? [surveyOrigin] : [])]);
  for (const origin of allowedOrigins) {
    const parsedOrigin = new URL(origin);
    if (
      parsedOrigin.protocol !== 'http:' ||
      parsedOrigin.hostname !== '127.0.0.1' ||
      parsedOrigin.origin !== origin
    ) {
      throw new Error('Fixture origins must be exact http://127.0.0.1:<port> origins.');
    }
  }
  if (typeof adminSecret !== 'string' || adminSecret.length < 32) {
    throw new Error('WORKSHOP_TEST_ADMIN_SECRET must contain at least 32 characters.');
  }

  let database = await createGatewayDatabase();
  let queue = Promise.resolve();
  const exclusive = (callback) => {
    const result = queue.then(callback);
    queue = result.catch(() => {});
    return result;
  };
  const users = new Map();
  const pendingCodes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const signingKey = randomBytes(32);
  let rpcFunctions = new Map();

  async function discoverRpcs() {
    const result = await database.query(`
      select p.proname as name, p.proargnames as args,
        array(select pg_catalog.format_type(a.type_oid, null)
          from unnest(p.proargtypes::oid[]) with ordinality a(type_oid, position)
          order by a.position) as argument_types
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and left(p.proname, 3) = 'dw_'
    `);
    rpcFunctions = new Map(
      result.rows
        .filter((row) => Object.hasOwn(rpcArguments, row.name))
        .map((row) => [row.name, new Map((row.args ?? []).map((name, index) => [name, row.argument_types[index]]))]),
    );
    if (!rpcFunctions.has('dw_bootstrap'))
      throw new Error('Stage 2 migration did not expose dw_bootstrap.');
  }
  await discoverRpcs();

  function send(response, status, body) {
    response.statusCode = status;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Workshop-Fixture', 'pglite-no-smtp-no-realtime');
    if (status === 204) return response.end();
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(body));
  }

  function authenticated(request) {
    const authorization = request.headers.authorization;
    const token =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice(7)
        : '';
    // Never accept decoded caller claims. Only a token actually issued by this server can authenticate.
    const record = accessTokens.get(token);
    if (!record || record.expiresAt <= Date.now())
      throw fixtureError(401, 'bad_jwt', 'Fixture access token is absent, invalid, or expired.');
    return record;
  }

  function issueSession(email) {
    const user = users.get(email);
    if (!user)
      throw fixtureError(
        401,
        'email_not_confirmed',
        'Fixture address has not passed OTP verification.',
      );
    const seconds = Math.floor(Date.now() / 1000);
    const sessionId = randomUUID();
    const claims = {
      iss: 'workshop-local-auth-fixture',
      aud: 'authenticated',
      sub: user.id,
      email: user.email,
      role: 'authenticated',
      aal: 'aal1',
      is_anonymous: false,
      session_id: sessionId,
      iat: seconds,
      exp: seconds + TOKEN_LIFETIME_SECONDS,
    };
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const content = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
    const token = `${content}.${createHmac('sha256', signingKey).update(content).digest('base64url')}`;
    const refreshToken = randomBytes(32).toString('base64url');
    accessTokens.set(token, { user, claims, expiresAt: claims.exp * 1000, sessionId });
    refreshTokens.set(refreshToken, { email, sessionId });
    return {
      access_token: token,
      refresh_token: refreshToken,
      token_type: 'bearer',
      expires_in: TOKEN_LIFETIME_SECONDS,
      expires_at: claims.exp,
      user,
    };
  }

  async function confirmFixtureUser(email) {
    const identity = FIXTURE_IDENTITIES[email];
    if (!users.has(email)) {
      await seedAuthUser(database, { id: identity.id, email, confirmed: true, isAnonymous: false });
      if (identity.facilitator) {
        await database.query(
          'insert into private.facilitators (user_id) values ($1) on conflict do nothing',
          [identity.id],
        );
      }
      const timestamp = new Date().toISOString();
      users.set(email, {
        id: identity.id,
        aud: 'authenticated',
        role: 'authenticated',
        email,
        email_confirmed_at: timestamp,
        confirmed_at: timestamp,
        phone: '',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        identities: [],
        is_anonymous: false,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }
    return issueSession(email);
  }

  const server = createServer(async (request, response) => {
    try {
      const requestOrigin = request.headers.origin;
      if (requestOrigin !== undefined && !allowedOrigins.has(requestOrigin)) {
        throw fixtureError(
          403,
          'origin_not_allowed',
          'Only the explicitly configured loopback application origins may call this fixture.',
        );
      }
      if (allowedOrigins.has(requestOrigin)) {
        response.setHeader('Access-Control-Allow-Origin', requestOrigin);
        response.setHeader('Vary', 'Origin');
      }
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.setHeader(
          'Access-Control-Allow-Headers',
          'authorization, apikey, content-type, content-profile, accept-profile, prefer, range, x-client-info, x-supabase-api-version, x-supabase-client-platform, x-supabase-client-platform-version',
        );
        return send(response, 204);
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        return send(response, 200, {
          status: 'ready',
          mode: 'local-auth-fixture',
          database: 'PGlite',
          smtp: false,
          hostedRealtime: false,
        });
      }
      if (url.pathname.startsWith('/__test/')) {
        // The runner channel is deliberately unavailable to a browser, even with the known fixture API key.
        if (
          requestOrigin !== undefined ||
          !equalSecret(request.headers['x-workshop-test-secret'], adminSecret)
        ) {
          throw fixtureError(
            403,
            'fixture_admin_required',
            'The test runner credential is required.',
          );
        }
        if (request.method === 'POST' && url.pathname === '/__test/otp') {
          const email = normalizedEmail((await jsonBody(request)).email);
          const pending = pendingCodes.get(email);
          if (!pending || pending.expiresAt <= Date.now())
            throw fixtureError(
              404,
              'fixture_otp_missing',
              'Request a code through the application first.',
            );
          return send(response, 200, { email, token: pending.code });
        }
        if (request.method === 'POST' && url.pathname === '/__test/reset') {
          await exclusive(async () => {
            await database.close();
            database = await createGatewayDatabase();
            await discoverRpcs();
            users.clear();
            pendingCodes.clear();
            accessTokens.clear();
            refreshTokens.clear();
          });
          return send(response, 200, { reset: true });
        }
        throw fixtureError(404, 'not_found', 'Unknown fixture runner route.');
      }
      if (!equalSecret(request.headers.apikey, FIXTURE_PUBLISHABLE_KEY)) {
        throw fixtureError(401, 'invalid_api_key', 'A valid fixture publishable key is required.');
      }
      if (request.method === 'POST' && url.pathname === '/auth/v1/otp') {
        const email = normalizedEmail((await jsonBody(request)).email);
        pendingCodes.set(email, {
          code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
          expiresAt: Date.now() + FIXTURE_OTP_LIFETIME_MS,
          attempts: 0,
        });
        return send(response, 200, {});
      }
      if (request.method === 'POST' && url.pathname === '/auth/v1/verify') {
        const body = await jsonBody(request);
        const email = normalizedEmail(body.email);
        const pending = pendingCodes.get(email);
        if (
          !pending ||
          pending.expiresAt <= Date.now() ||
          pending.attempts >= 5 ||
          body.type !== 'email' ||
          !equalSecret(body.token, pending.code)
        ) {
          if (pending) pending.attempts++;
          throw fixtureError(403, 'otp_expired', 'Token has expired or is invalid.');
        }
        pendingCodes.delete(email);
        const session = await exclusive(() => confirmFixtureUser(email));
        return send(response, 200, session);
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/auth/v1/token' &&
        url.searchParams.get('grant_type') === 'refresh_token'
      ) {
        const body = await jsonBody(request);
        const refresh = refreshTokens.get(body.refresh_token);
        if (!refresh)
          throw fixtureError(400, 'refresh_token_not_found', 'Invalid fixture refresh token.');
        refreshTokens.delete(body.refresh_token);
        return send(response, 200, issueSession(refresh.email));
      }
      if (request.method === 'GET' && url.pathname === '/auth/v1/user') {
        return send(response, 200, authenticated(request).user);
      }
      if (request.method === 'POST' && url.pathname === '/auth/v1/logout') {
        const { user, sessionId } = authenticated(request);
        const local = url.searchParams.get('scope') === 'local';
        for (const [token, entry] of accessTokens) {
          if (entry.user.id === user.id && (!local || entry.sessionId === sessionId))
            accessTokens.delete(token);
        }
        for (const [token, entry] of refreshTokens) {
          if (entry.email === user.email && (!local || entry.sessionId === sessionId))
            refreshTokens.delete(token);
        }
        return send(response, 204);
      }
      if (request.method === 'POST' && url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.slice('/rest/v1/rpc/'.length);
        const publicSurvey = Boolean(surveyOrigin) && ANONYMOUS_SURVEY_RPCS.has(name);
        // A present bearer is always verified. An invalid bearer must never become anon;
        // a valid named bearer reaches the real SQL role/claim guard for this endpoint.
        const record = publicSurvey && request.headers.authorization === undefined
          ? null
          : authenticated(request);
        const declaredArguments = rpcFunctions.get(name);
        if (!IDENTIFIER.test(name) || !name.startsWith('dw_') || !declaredArguments) {
          throw fixtureError(404, 'PGRST202', 'The requested fixture RPC is not exposed.');
        }
        const body = await jsonBody(request);
        const entries = Object.entries(body);
        if (entries.some(([name]) => !IDENTIFIER.test(name) || !declaredArguments.has(name))) {
          throw fixtureError(400, 'PGRST202', 'Unknown or invalid RPC argument.');
        }
        const namedParameters = entries
          .map(([name], index) => `"${name}" => $${index + 1}`)
          .join(', ');
        const parameters = entries.map(([name, value]) => {
          if (declaredArguments.get(name) === 'uuid[]' && value !== null) {
            if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(entry))) {
              throw fixtureError(400, 'invalid_uuid_array', 'Expected an array of UUIDs.');
            }
            // Kept as one parameter: array contents never become SQL syntax.
            return `{${value.join(',')}}`;
          }
          return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
        });
        const result = await exclusive(() =>
          database.transaction(async (transaction) => {
            await transaction.exec(record ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE anon');
            await transaction.query(
              "select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
              [JSON.stringify(record?.claims ?? { role: 'anon' }), record?.user.id ?? ''],
            );
            return transaction.query(
              `select public."${name}"(${namedParameters}) as result`,
              parameters,
            );
          }),
        );
        return send(response, 200, result.rows[0]?.result ?? null);
      }
      throw fixtureError(
        404,
        'not_found',
        'This local fixture only exposes Auth and the approved workshop RPC routes.',
      );
    } catch (error) {
      const code = typeof error.code === 'string' ? error.code : 'fixture_error';
      const status =
        error.status ?? (code === '42501' ? 403 : code === '40001' || code === '23505' ? 409 : 400);
      send(response, status, { code, message: error.message, details: null, hint: null });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await queue;
      await database.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gateway = await startFixtureGateway();
  process.stdout.write(
    `Workshop local-only fixture ready at ${gateway.url}; no SMTP or hosted Realtime.\n`,
  );
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      gateway.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}
