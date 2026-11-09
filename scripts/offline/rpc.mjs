/** Production RPC boundary. No caller-selected table, schema, SQL or function exists. */
export const SURVEY_RPCS = new Set([
  'dw_survey_public_manifest', 'dw_survey_own_response',
  'dw_survey_save_response', 'dw_survey_withdraw_response',
]);
const NAMES = [
  'dw_bootstrap', 'dw_save_profile', 'dw_create_session', 'dw_join_session',
  'dw_available_sessions', 'dw_join_open_session',
  'dw_session_snapshot', 'dw_session_cursor', 'dw_projector_snapshot', 'dw_update_session',
  'dw_publish_submission', 'dw_moderate_submission', 'dw_invitation', 'dw_rotate_invitation',
  'dw_set_member_role', 'dw_revoke_member',
  'dw_workshop_snapshot', 'dw_workshop_cursor', 'dw_workshop_projector_snapshot',
  'dw_workshop_round_snapshot', 'dw_region_work', 'dw_save_family', 'dw_delete_family',
  'dw_open_voting_round', 'dw_close_voting_round', 'dw_cast_vote', 'dw_workshop_updates',
  'dw_workshop_projector_updates', 'dw_cast_vote_updates',
  'dw_barriers_snapshot', 'dw_barriers_cursor', 'dw_barriers_projector_snapshot',
  'dw_save_barrier', 'dw_barrier_vote', 'dw_save_barrier_link', 'dw_save_solution',
  'dw_barrier_evidence', 'dw_save_survey', 'dw_manage_survey', 'dw_survey_host_state',
  'dw_survey_invitation_state', 'dw_survey_research_export', ...SURVEY_RPCS,
  'dw_roadmaps_index', 'dw_roadmaps_cursor', 'dw_roadmap_snapshot', 'dw_roadmap_version',
  'dw_roadmaps_projector_snapshot', 'dw_configure_roadmaps', 'dw_join_roadmap',
  'dw_save_roadmap_item', 'dw_capture_roadmap_fact', 'dw_capture_roadmap_basis',
  'dw_freeze_roadmap', 'dw_review_roadmap', 'dw_roadmap_statistics_save',
  'dw_roadmap_statistics_restore', 'dw_roadmap_statistics_history', 'dw_roadmap_statistics_series',
];
export const RPC_NAMES = Object.freeze(NAMES);
const TYPES = new Set(['uuid', 'text', 'jsonb', 'integer', 'bigint', 'boolean', 'uuid[]', 'text[]']);

export class HttpError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Inspect only functions explicitly shipped as this application's public contract. */
export async function discoverRpc(db) {
  const { rows } = await db.query(`select p.proname,p.proargnames,p.pronargdefaults,
    array(select format_type(t,null) from unnest(p.proargtypes) t) as types,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
    has_function_privilege('anon',p.oid,'EXECUTE') as anon
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any($1::text[])`, [NAMES]);
  const catalogue = new Map();
  for (const row of rows) {
    if (catalogue.has(row.proname)) throw new Error('Overloaded offline RPC is unsupported');
    const keys = row.proargnames ?? [];
    if (keys.length !== row.types.length || keys.some(k => !/^p_[a-z0-9_]+$/.test(k))
        || row.types.some(t => !TYPES.has(t)) || !row.authenticated
        || row.anon !== SURVEY_RPCS.has(row.proname)) throw new Error('Offline RPC grant/signature mismatch: ' + row.proname);
    catalogue.set(row.proname, { keys, types: row.types, optional: row.pronargdefaults });
  }
  if (catalogue.size !== NAMES.length) throw new Error('Incomplete offline RPC schema');
  return catalogue;
}

/** Caller holds the runtime queue; role/claims are transaction-local and rollback on any error. */
export async function invokeRpc(db, catalogue, name, args, identity, survey) {
  const definition = catalogue.get(name);
  if (!definition || SURVEY_RPCS.has(name) !== survey) throw new HttpError(404, 'RPC_NOT_FOUND');
  if (!object(args) || Object.keys(args).some(k => !definition.keys.includes(k)))
    throw new HttpError(400, 'INVALID_ARGUMENTS');
  if (!survey && !identity) throw new HttpError(401, 'AUTH_REQUIRED');
  const required = definition.keys.slice(0, definition.keys.length - definition.optional);
  if (required.some(k => !Object.hasOwn(args, k))) throw new HttpError(400, 'MISSING_ARGUMENT');
  const keys = definition.keys.filter(k => Object.hasOwn(args, k));
  const values = keys.map(k => {
    const value = args[k]; const type = definition.types[definition.keys.indexOf(k)];
    if (type === 'jsonb') return JSON.stringify(value);
    if (type.endsWith('[]')) {
      if (value !== null && (!Array.isArray(value) || value.some(x => typeof x !== 'string')))
        throw new HttpError(400, 'INVALID_ARGUMENT_TYPE');
      return value;
    }
    if (object(value) || Array.isArray(value)) throw new HttpError(400, 'INVALID_ARGUMENT_TYPE');
    return value;
  });
  return db.transaction(async tx => {
    await tx.exec(`set local role ${survey ? 'anon' : 'authenticated'}; set local statement_timeout='15000ms'`);
    const claims = survey ? { role: 'anon' } : {
      sub: identity.user.id, role: 'authenticated', is_anonymous: false,
      app_metadata: { offline: true, provider: 'offline' }, session_id: identity.id,
    };
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [survey ? '' : identity.user.id, JSON.stringify(claims)]);
    const argumentsSql = keys.map((k,i) => `${k}=>$${i+1}::${definition.types[definition.keys.indexOf(k)]}`).join(',');
    const result = await tx.query(`select public.${name}(${argumentsSql}) as result`, values);
    return result.rows[0].result;
  });
}
