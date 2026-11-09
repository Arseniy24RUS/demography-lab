#!/usr/bin/env node
/** Owner-side retention task. It never uses an Auth account or exposes response contents. */
import { pathToFileURL } from 'node:url';

/** Both node-postgres and PGlite implement this query interface. No network writes occur unless apply is true. */
export async function purgeExpiredSurveys(client, { apply = false } = {}) {
  await client.query(apply ? 'begin' : 'begin read only');
  try {
    // Retention is inclusive through the chosen UTC calendar date.
    const { rows: surveys } = await client.query(`select s.id,s.session_id,s.retention_until::text,
        (select count(*)::int from research.responses r where r.survey_id=s.id and r.status='submitted') as submitted_count
      from research.surveys s where s.status<>'purged' and s.retention_until<(now() at time zone 'UTC')::date
      order by s.id${apply ? ' for update of s' : ''}`);
    let removedResponses = 0;
    if (apply) {
      for (const survey of surveys) {
        const result = await client.query(`update research.responses set answers=null,status='withdrawn',revision=revision+1
          where survey_id=$1 and status='submitted' returning id`, [survey.id]);
        removedResponses += result.rows.length;
        await client.query("update research.surveys set status='purged',revision=revision+1 where id=$1", [survey.id]);
        await client.query("select private.dw_barrier_touch($1,'survey.retention_purged')", [survey.session_id]);
      }
    }
    await client.query('commit');
    return { mode: apply ? 'apply' : 'dry-run', surveyCount: surveys.length,
      responseCount: apply ? removedResponses : surveys.reduce((sum, s) => sum + s.submitted_count, 0),
      surveys: surveys.map((s) => ({ surveyId: s.id, sessionId: s.session_id, retentionUntil: s.retention_until, responseCount: s.submitted_count })) };
  } catch (error) {
    await client.query('rollback'); throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Usage: node scripts/purge-expired-surveys.mjs [--apply]\n'
      + 'Default: read-only dry run with counts and survey IDs, never response contents.\n'
      + 'SUPABASE_DB_URL: owner-side PostgreSQL connection. Keep it outside web/config/archives.\n'
      + '--apply: atomically clear expired answers, retain withdrawal tombstones and mark surveys purged.\n');
    return;
  }
  if (args.some((arg) => arg !== '--apply') || args.filter((arg) => arg === '--apply').length > 1) throw new Error('INVALID_ARGUMENTS');
  if (!process.env.SUPABASE_DB_URL) throw new Error('DATABASE_URL_REQUIRED');
  const { Client } = await import('pg');
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL,
    application_name: 'demography-workshop-survey-retention', statement_timeout: 120000, lock_timeout: 15000 });
  try {
    await client.connect();
    process.stdout.write(`${JSON.stringify(await purgeExpiredSurveys(client, { apply: args.includes('--apply') }), null, 2)}\n`);
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Avoid echoing connection strings, statement parameters or survey text in task logs.
    const known = ['INVALID_ARGUMENTS', 'DATABASE_URL_REQUIRED'].includes(error.message) ? error.message : 'DATABASE_OPERATION_FAILED';
    process.stderr.write(`Survey retention task failed: ${known}${error.code && /^[A-Z0-9]{5}$/u.test(error.code) ? ` (${error.code})` : ''}.\n`);
    process.exitCode = 1;
  });
}
