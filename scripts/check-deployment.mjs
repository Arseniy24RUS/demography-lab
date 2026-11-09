#!/usr/bin/env node
/**
 * Read-only checks of the deployed Auth/Data API. No account, email, session,
 * answer, or grant is created. Public RPC requests below call read functions only.
 * No database password, user JWT, or administrative key is accepted.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const help = `Usage: node scripts/check-deployment.mjs [--config PATH] [--timeout-ms 45000]

Uses public/workshop-config.json by default. Requires the five deployed migrations.
Checks public configuration, Auth settings, anonymous access gates and a closed
survey invitation. Does not send an email or sign in. SMTP delivery, authenticated
Realtime, teacher permissions and browser/device behaviour require a rehearsal.
An HTTP transport failure is an unverified check, not proof of a database defect.
`;

function argumentsFrom(argv) {
  const options = {
    config: fileURLToPath(new URL('../public/workshop-config.json', import.meta.url)),
    timeout: 45000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--config' && argv[i + 1]) options.config = resolve(argv[++i]);
    else if (arg === '--timeout-ms' && argv[i + 1]) {
      const timeout = Number(argv[++i]);
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000)
        throw new Error('Timeout must be an integer between 1000 and 60000 ms.');
      options.timeout = timeout;
    } else throw new Error('Unknown or incomplete option. Use --help.');
  }
  return options;
}

function validatePublicConfig(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.supabaseUrl !== 'string')
    throw new Error('Expected schemaVersion 1 and a public Supabase URL.');
  const url = new URL(value.supabaseUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('The deployment URL must be an HTTPS origin without credentials.');
  const key = value.supabasePublishableKey;
  if (typeof key !== 'string' || key.length < 20 || key.length > 4000)
    throw new Error('A public Supabase key is required.');
  if (!key.startsWith('sb_publishable_')) {
    let claims;
    try {
      claims = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8'));
    } catch {
      throw new Error('Only publishable or legacy anon keys are accepted.');
    }
    if (claims?.role !== 'anon')
      throw new Error('User JWTs and administrative keys are forbidden.');
  }
  let survey = 'disabled';
  if (value.surveyUrl || value.classroomOrigin) {
    const surveyUrl = new URL(value.surveyUrl),
      classroom = new URL(value.classroomOrigin);
    const safeUrl = (candidate) =>
      candidate.protocol === 'https:' &&
      !candidate.username &&
      !candidate.password &&
      !candidate.search &&
      !candidate.hash;
    if (
      !safeUrl(surveyUrl) ||
      !safeUrl(classroom) ||
      classroom.pathname !== '/' ||
      !surveyUrl.pathname.endsWith('/survey.html') ||
      surveyUrl.origin === classroom.origin
    )
      throw new Error('Survey requires separate HTTPS origins and a /survey.html path.');
    survey = 'configured-separate-origin';
  }
  return { origin: url.origin, key, survey };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (!options) {
    console.log(help);
    return;
  }
  const config = validatePublicConfig(JSON.parse(await readFile(options.config, 'utf8')));
  const results = [];
  const check = async (name, task) => {
    try {
      results.push({ name, status: 'pass', ...(await task()) });
    } catch (error) {
      // Only locally constructed messages/codes are reported; raw API bodies can
      // contain personal data if an endpoint is accidentally misconfigured.
      results.push({
        name,
        status: 'fail',
        reason: error instanceof Error ? error.message : 'Unexpected error.',
      });
    }
  };
  const request = async (path, { body, headers = {} } = {}) => {
    let response;
    try {
      response = await fetch(config.origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          apikey: config.key,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeout),
      });
    } catch {
      throw new Error('HTTP transport failed or timed out; deployment status remains unverified.');
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Expected JSON, received HTTP ${response.status}.`);
    }
    return { status: response.status, data };
  };
  const requireResult = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  results.push({
    name: 'public-configuration',
    status: 'pass',
    projectOrigin: config.origin,
    survey: config.survey,
  });

  await check('auth-public-settings', async () => {
    const { status, data } = await request('/auth/v1/settings');
    requireResult(status === 200, `Auth settings returned HTTP ${status}.`);
    requireResult(data.external?.email === true, 'Email provider is disabled.');
    requireResult(data.mailer_autoconfirm === false, 'Email confirmation is not enabled.');
    requireResult(
      data.external?.anonymous_users === false,
      'Anonymous Auth sign-ins must remain disabled.',
    );
    requireResult(
      data.disable_signup === false,
      'New participants cannot create their verified account.',
    );
    return { email: true, emailConfirmation: true, anonymousAuth: false, signup: true };
  });

  const sentinel = '00000000-0000-4000-8000-000000000000';
  const guardedReaders = [
    ['dw_bootstrap', {}],
    ['dw_workshop_cursor', { p_session_id: sentinel }],
    ['dw_barriers_cursor', { p_session_id: sentinel }],
    ['dw_roadmaps_index', { p_session_id: sentinel }],
    ['dw_roadmap_statistics_history', { p_session_id: sentinel, p_input: {} }],
  ];
  for (const [rpc, body] of guardedReaders) {
    await check(`anonymous-gate:${rpc}`, async () => {
      const { status, data } = await request(`/rest/v1/rpc/${rpc}`, { body });
      requireResult(
        [401, 403].includes(status) && data.code === '42501',
        `Expected PostgreSQL permission denial; HTTP ${status}, code ${typeof data.code === 'string' ? data.code.slice(0, 32) : 'absent'}.`,
      );
      return { httpStatus: status, code: data.code };
    });
  }

  for (const schema of ['private', 'research']) {
    await check(`closed-schema:${schema}`, async () => {
      // OpenAPI can require a secret key before PostgREST checks the schema.
      // Probe a concrete read RPC with a publishable key instead.
      const { status, data } = await request('/rest/v1/rpc/dw_bootstrap', {
        body: {}, headers: { 'Content-Profile': schema },
      });
      requireResult(
        status === 406 && data.code === 'PGRST106',
        `Schema exposure was not rejected as expected; HTTP ${status}.`,
      );
      return { httpStatus: status, code: data.code };
    });
  }

  await check('survey-invalid-invitation', async () => {
    const { status, data } = await request('/rest/v1/rpc/dw_survey_public_manifest', {
      body: { p_survey_id: sentinel, p_invitation_token: '0'.repeat(64) },
    });
    requireResult(
      status === 400 && data.code === 'P0001' && data.message === 'SURVEY_INVITATION_INVALID',
      `Expected closed invitation, received HTTP ${status}.`,
    );
    return { httpStatus: status, code: 'SURVEY_INVITATION_INVALID' };
  });

  const passed = results.filter((item) => item.status === 'pass').length;
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        mode: 'read-only-public-api',
        passed,
        total: results.length,
        results,
        notVerified: [
          'SMTP delivery and rate limits',
          'hosted OTP templates and Auth URL settings',
          'teacher assignment after verified login',
          'authenticated multi-device Realtime',
          'browser access to classroom and separate survey origin',
        ],
      },
      null,
      2,
    ),
  );
  if (passed !== results.length) process.exitCode = 1;
}

main().catch(() => {
  // Never echo config contents, keys, arbitrary server payloads or credential URLs.
  console.error(
    'Deployment check could not start. Validate the public config and command options; see --help.',
  );
  process.exitCode = 1;
});
