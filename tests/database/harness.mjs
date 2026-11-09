import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { seedCanonicalDocument } from '../../scripts/seed-supabase.mjs';

export { seedCanonicalDocument };
export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const fixtureIds = {
  host: '00000000-0000-4000-8000-000000000001',
  alice: '00000000-0000-4000-8000-000000000002',
  bob: '00000000-0000-4000-8000-000000000003',
  observer: '00000000-0000-4000-8000-000000000004',
  outsider: '00000000-0000-4000-8000-000000000005',
};

/** Real PostgreSQL (WASM), applying the exact shipped migration, never a SQL mock. */
export async function createTestDatabase({ seedCorpus = true } = {}) {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('./bootstrap.sql', import.meta.url), 'utf8'));
    const dir = resolve(projectRoot, 'supabase/migrations');
    for (const file of (await readdir(dir)).filter((x) => x.endsWith('.sql')).sort()) {
      await db.exec(await readFile(resolve(dir, file), 'utf8'));
    }
    if (seedCorpus) {
      await seedCanonicalDocument(db, await loadMordovia());
    }
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

export async function loadMordovia() {
  return JSON.parse(await readFile(resolve(projectRoot,
    'public/data/corpus/documents/regional-respublika-mordoviia.json'), 'utf8'));
}

export async function seedAuthUser(db, { id, email, confirmed = true, isAnonymous = false, metadata = {} }) {
  await db.query(`insert into auth.users(id,email,email_confirmed_at,is_anonymous,raw_user_meta_data)
    values($1,$2,case when $3 then now() else null end,$4,$5::jsonb)
    on conflict(id) do update set email=excluded.email,email_confirmed_at=excluded.email_confirmed_at,
      is_anonymous=excluded.is_anonymous,raw_user_meta_data=excluded.raw_user_meta_data`,
    [id, email, confirmed, isAnonymous, JSON.stringify(metadata)]);
}

/** Gateway/tests call this serially; PGlite has one physical connection. */
export async function asUser(db, userId, run) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",
      [userId ?? '', JSON.stringify({ sub: userId, role: 'authenticated' })]);
    return run(tx);
  });
}

/** Fixed allowlist/signatures prevent dynamically executing caller-provided SQL. */
export const rpcArguments = Object.freeze({
  dw_enter_workspace: ['p_operation_id'],
  dw_configure_workspace: ['p_operation_id', 'p_session_id', 'p_expected_revision', 'p_input'],
  dw_workspace_votes: ['p_session_id'],
  dw_workspace_votes_projection: ['p_session_id'],
  dw_workspace_vote: ['p_operation_id', 'p_session_id', 'p_family_id', 'p_value', 'p_expected_revision', 'p_expected_fingerprint'],
  dw_roadmaps_index: ['p_session_id'],
  dw_roadmaps_cursor: ['p_session_id'],
  dw_roadmap_snapshot: ['p_session_id', 'p_roadmap_id'],
  dw_roadmap_version: ['p_session_id', 'p_roadmap_id', 'p_version_id'],
  dw_roadmaps_projector_snapshot: ['p_session_id', 'p_roadmap_id'],
  dw_roadmap_statistics_save: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_roadmap_statistics_restore: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_roadmap_statistics_history: ['p_session_id', 'p_input'],
  dw_roadmap_statistics_series: ['p_session_id', 'p_input'],
  dw_configure_roadmaps: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_join_roadmap: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_save_roadmap_item: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_capture_roadmap_fact: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_capture_roadmap_basis: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_freeze_roadmap: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_review_roadmap: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_barriers_snapshot: ['p_session_id'],
  dw_barriers_cursor: ['p_session_id'],
  dw_barriers_projector_snapshot: ['p_session_id'],
  dw_save_barrier: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_barrier_vote: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_save_barrier_link: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_save_solution: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_barrier_evidence: ['p_session_id', 'p_evidence_id'],
  dw_save_survey: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_manage_survey: ['p_operation_id', 'p_session_id', 'p_input'],
  dw_survey_host_state: ['p_session_id', 'p_survey_id'],
  dw_survey_invitation_state: ['p_session_id', 'p_survey_id'],
  dw_survey_research_export: ['p_session_id', 'p_survey_id'],
  dw_survey_public_manifest: ['p_survey_id', 'p_invitation_token'],
  dw_survey_own_response: ['p_survey_id', 'p_response_secret'],
  dw_survey_save_response: ['p_operation_id', 'p_survey_id', 'p_invitation_token', 'p_response_secret', 'p_input'],
  dw_survey_withdraw_response: ['p_operation_id', 'p_survey_id', 'p_response_secret', 'p_expected_revision'],
  dw_bootstrap: [],
  dw_save_profile: ['p_operation_id', 'p_expected_revision', 'p_full_name'],
  dw_create_session: ['p_operation_id', 'p_title', 'p_scope', 'p_region_id'],
  dw_join_session: ['p_operation_id', 'p_code'],
  dw_session_snapshot: ['p_session_id'],
  dw_session_cursor: ['p_session_id'],
  dw_projector_snapshot: ['p_session_id'],
  dw_update_session: ['p_operation_id', 'p_session_id', 'p_expected_revision', 'p_patch'],
  dw_publish_submission: ['p_operation_id', 'p_session_id', 'p_local_key', 'p_expected_revision', 'p_bundle'],
  dw_moderate_submission: ['p_operation_id', 'p_session_id', 'p_submission_id', 'p_expected_revision', 'p_status'],
  dw_invitation: ['p_session_id'],
  dw_rotate_invitation: ['p_operation_id', 'p_session_id', 'p_expected_revision'],
  dw_set_member_role: ['p_operation_id', 'p_session_id', 'p_member_id', 'p_expected_revision', 'p_role'],
  dw_revoke_member: ['p_operation_id', 'p_session_id', 'p_member_id', 'p_expected_revision'],
  dw_workshop_snapshot: ['p_session_id'],
  dw_workshop_cursor: ['p_session_id'],
  dw_workshop_projector_snapshot: ['p_session_id'],
  dw_workshop_round_snapshot: ['p_session_id', 'p_round_id'],
  dw_region_work: ['p_operation_id', 'p_session_id', 'p_region_id', 'p_action', 'p_expected_revision', 'p_note'],
  dw_save_family: ['p_operation_id', 'p_session_id', 'p_family_id', 'p_expected_board_revision', 'p_title', 'p_mechanism', 'p_rationale', 'p_submission_ids'],
  dw_delete_family: ['p_operation_id', 'p_session_id', 'p_family_id', 'p_expected_board_revision'],
  dw_open_voting_round: ['p_operation_id', 'p_session_id', 'p_title', 'p_results_visibility', 'p_expected_board_revision', 'p_settings'],
  dw_close_voting_round: ['p_operation_id', 'p_session_id', 'p_round_id', 'p_expected_revision'],
  dw_cast_vote: ['p_operation_id', 'p_session_id', 'p_round_id', 'p_family_id', 'p_value', 'p_expected_revision'],
  dw_workshop_updates: ['p_session_id', 'p_known_round_id'],
  dw_workshop_projector_updates: ['p_session_id', 'p_known_round_id'],
  dw_cast_vote_updates: ['p_operation_id', 'p_session_id', 'p_round_id', 'p_family_id', 'p_value', 'p_expected_revision', 'p_known_round_id'],
});

export async function callRpc(db, userId, name, args = {}) {
  const keys = rpcArguments[name];
  if (!keys || Object.keys(args).some((key) => !keys.includes(key))) throw new Error('Unknown RPC arguments');
  const values = keys.map((key) => {
    const value = args[key] ?? null;
    if (key === 'p_submission_ids' && Array.isArray(value)) return value;
    return value && typeof value === 'object' ? JSON.stringify(value) : value;
  });
  return asUser(db, userId, async (tx) => {
    const { rows } = await tx.query(`select public.${name}(${keys.map((_, i) => `$${i + 1}`).join(',')}) as data`, values);
    return rows[0].data;
  });
}
