// Maintenance SQL generator only. It never connects to or mutates a database.
import { readFile, open, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const canonicalTables = [
  'private.source_versions', 'private.source_blocks', 'private.dw_family_catalog_releases',
  'private.dw_family_catalog', 'private.dw_roadmap_datasets', 'private.dw_roadmap_territories', 'private.dw_roadmap_series',
];
export const identityTables = ['private.dw_actors', 'private.dw_declared_identities', 'private.facilitators', 'public.dw_profiles'];
export const materialTables = [
  'private.audit_events', 'private.command_receipts', 'private.dw_ballots', 'private.dw_barrier_evidence',
  'private.dw_barrier_links', 'private.dw_barrier_state', 'private.dw_barrier_votes', 'private.dw_barriers',
  'private.dw_current_workspace', 'private.dw_entry_sessions', 'private.dw_family_history', 'private.dw_family_members',
  'private.dw_flipchart_factor_territories', 'private.dw_flipchart_notes', 'private.dw_flipchart_state',
  'private.dw_flipchart_votes', 'private.dw_green_factor_links', 'private.dw_objective_factor_comments',
  'private.dw_practice_families', 'private.dw_region_work', 'private.dw_roadmap_assignments', 'private.dw_roadmap_bases',
  'private.dw_roadmap_basis_materials', 'private.dw_roadmap_items', 'private.dw_roadmap_reviews',
  'private.dw_roadmap_state', 'private.dw_roadmap_statistical_revisions', 'private.dw_roadmap_statistics_heads',
  'private.dw_roadmap_versions', 'private.dw_roadmap_view_presence', 'private.dw_roadmap_workshop_imports',
  'private.dw_roadmaps', 'private.dw_round_families', 'private.dw_round_roster', 'private.dw_round_variants',
  'private.dw_solutions', 'private.dw_voting_rounds', 'private.dw_workshop_state', 'private.dw_workshop_survey_access',
  'private.dw_workspace_receipts', 'private.dw_workspace_votes', 'private.dw_workspaces', 'private.invitations',
  'private.join_attempts', 'public.dw_barrier_events', 'public.dw_memberships', 'public.dw_roadmap_events',
  'public.dw_session_events', 'public.dw_sessions', 'public.dw_submissions', 'public.dw_workshop_events',
  'research.response_receipts', 'research.responses', 'research.surveys',
];
const offlineTables = ['auth.users', 'offline.accounts', 'offline.email_identities', 'offline.sessions',
  'offline.refresh_receipts', 'offline.settings', 'offline.migrations'];
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const relation = name => name.split('.').map(part => `"${part}"`).join('.');
const hash = expression => `encode(sha256(convert_to(${expression},'UTF8')),'hex')`;
const tableDigest = table => `select count(*)::bigint as rows,${hash("coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by to_jsonb(t)::text collate \"C\"),'')")} as sha256 from ${relation(table)} t`;
export function resetTables(mode = 'cloud') {
  if (!['cloud', 'offline'].includes(mode)) throw new Error('RESET_MODE_INVALID');
  return [...canonicalTables, ...identityTables, ...materialTables, ...(mode === 'offline' ? offlineTables : [])].sort();
}
export function inventorySql(mode = 'cloud') {
  return `set time zone 'UTC';\nselect jsonb_agg(to_jsonb(inventory) order by table_name) as manifest from (\n${resetTables(mode).map(table =>
    `select ${literal(table)} table_name,summary.* from (${tableDigest(table)}) summary`).join('\nunion all\n')}\n) inventory;`;
}
/** Returned row strings join with LF (no trailing LF) to the corresponding manifest SHA. */
export function backupPageSql(table, { mode = 'cloud', limit = 100, offset = 0 } = {}) {
  if (!resetTables(mode).includes(table) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || !Number.isSafeInteger(offset) || offset < 0) throw new Error('BACKUP_PAGE_INVALID');
  return `set time zone 'UTC';\nselect to_jsonb(t)::text as row from ${relation(table)} t order by to_jsonb(t)::text collate "C" limit ${limit} offset ${offset};`;
}
export function teacherDigestSql(teacherActorId, mode = 'cloud') {
  if (!/^[a-f0-9-]{36}$/i.test(teacherActorId)) throw new Error('TEACHER_ID_INVALID');
  resetTables(mode);
  const id = `${literal(teacherActorId)}::uuid`;
  const fields = [
    `'actor',(select to_jsonb(t) from private.dw_actors t where id=${id})`,
    `'profile',(select to_jsonb(t) from public.dw_profiles t where user_id=${id})`,
    `'facilitator',(select to_jsonb(t) from private.facilitators t where user_id=${id})`,
    `'declared',(select coalesce(jsonb_agg(to_jsonb(t) order by email),'[]'::jsonb) from private.dw_declared_identities t where actor_id=${id})`,
  ];
  if (mode === 'offline') fields.push(
    `'auth',(select to_jsonb(t) from auth.users t where id=${id})`,
    `'account',(select to_jsonb(t) from offline.accounts t where user_id=${id})`,
    `'email',(select to_jsonb(t) from offline.email_identities t where user_id=${id})`,
  );
  return `select ${hash(`jsonb_build_object(${fields.join(',')})::text`)} as sha256`;
}

export function createResetSql(config, { transaction = true } = {}) {
  const { mode = 'cloud', teacherActorId, teacherName, teacherSha256, manifest, backupReceiptSha256, acknowledgement } = config;
  const tables = resetTables(mode);
  if (acknowledgement !== 'DELETE_ALL_WORKSHOP_TEST_DATA_KEEP_TEACHER') throw new Error('RESET_ACKNOWLEDGEMENT_REQUIRED');
  if (![teacherSha256, backupReceiptSha256].every(value => /^[a-f0-9]{64}$/.test(value ?? '')) || !teacherName?.trim())
    throw new Error('BACKUP_AND_TEACHER_RECEIPTS_REQUIRED');
  if (!Array.isArray(manifest) || manifest.length !== tables.length
    || new Set(manifest.map(item => item.table_name)).size !== tables.length
    || manifest.some(item => !tables.includes(item.table_name) || !Number.isSafeInteger(item.rows) || item.rows < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)))
    throw new Error('EXACT_BACKUP_MANIFEST_REQUIRED');
  const teacherDigest = teacherDigestSql(teacherActorId, mode);
  const id = `${literal(teacherActorId)}::uuid`;
  const truncate = [...materialTables, ...(mode === 'offline' ? ['offline.sessions', 'offline.refresh_receipts'] : [])];
  const preserved = [...canonicalTables, ...(mode === 'offline' ? ['offline.settings', 'offline.migrations'] : [])];
  return `-- Destructive, explicitly authorized test-data reset. Generated from a verified private backup.
-- Backup receipt SHA-256: ${backupReceiptSha256}
-- Apply only after the backup files and hashes have been durably saved outside Git/release archives.
${transaction ? 'begin;' : '-- Caller owns the surrounding transaction and must commit only after the complete seed validates.'}
set local time zone 'UTC';
set local lock_timeout='5s';
set local statement_timeout='120s';
lock table ${[...tables, ...(mode === 'cloud' ? ['auth.users'] : [])].map(relation).join(',')} in access exclusive mode;
do $reset$
declare expected jsonb:=${literal(JSON.stringify(manifest))}::jsonb; item jsonb; actual_rows bigint; actual_sha text; teacher_sha text;
begin
  -- Fail closed on schema drift: a new application table must be explicitly classified.
  if (select array_agg(table_schema||'.'||table_name order by (table_schema||'.'||table_name) collate "C")
      from information_schema.tables where table_type='BASE TABLE' and table_schema in ('public','private','research'))
    is distinct from array[${resetTables('cloud').map(literal).join(',')}]::text[] then raise exception 'RESET_SCHEMA_DRIFT'; end if;
  if not exists(select 1 from private.dw_actors a join public.dw_profiles p on p.user_id=a.id
      join private.facilitators f on f.user_id=a.id and f.revoked_at is null
      where a.id=${id} and a.disabled_at is null and p.full_name=${literal(teacherName)}) then raise exception 'RESET_TEACHER_MISMATCH'; end if;
  if not exists(select 1 from ${mode === 'cloud' ? 'private.dw_declared_identities' : 'offline.email_identities'}
      where ${mode === 'cloud' ? 'actor_id' : 'user_id'}=${id} and ${mode === 'cloud' ? 'email' : 'normalized_email'}='omnistat@yandex.ru') then raise exception 'RESET_TEACHER_EMAIL_MISMATCH'; end if;
  ${mode === 'cloud' ? "if exists(select 1 from auth.users) then raise exception 'RESET_UNEXPECTED_MANAGED_AUTH_USERS'; end if;" : ''}
  ${teacherDigest} into teacher_sha;
  if teacher_sha<>${literal(teacherSha256)} then raise exception 'RESET_TEACHER_CHANGED'; end if;
  for item in select value from jsonb_array_elements(expected) loop
    execute format('select count(*)::bigint,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' order by to_jsonb(t)::text collate "C"),''''),''UTF8'')),''hex'') from %I.%I t',split_part(item->>'table_name','.',1),split_part(item->>'table_name','.',2)) into actual_rows,actual_sha;
    if actual_rows<>(item->>'rows')::bigint or actual_sha<>item->>'sha256' then raise exception 'RESET_BACKUP_STALE: %',item->>'table_name'; end if;
  end loop;
  -- Explicit complete material set avoids CASCADE and leaves all guards/RLS intact.
  truncate table ${truncate.map(relation).join(',')};
  ${mode === 'offline' ? `delete from offline.email_identities where user_id<>${id};\n  delete from offline.accounts where user_id<>${id};` : ''}
  delete from private.dw_declared_identities where actor_id<>${id};
  delete from private.facilitators where user_id<>${id};
  delete from public.dw_profiles where user_id<>${id};
  delete from private.dw_actors where id<>${id};
  ${mode === 'offline' ? `delete from auth.users where id<>${id};` : ''}
  ${teacherDigest} into teacher_sha;
  if teacher_sha<>${literal(teacherSha256)} then raise exception 'RESET_TEACHER_REWRITTEN'; end if;
  for item in select value from jsonb_array_elements(expected) where value->>'table_name'=any(array[${preserved.map(literal).join(',')}]) loop
    execute format('select count(*)::bigint,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' order by to_jsonb(t)::text collate "C"),''''),''UTF8'')),''hex'') from %I.%I t',split_part(item->>'table_name','.',1),split_part(item->>'table_name','.',2)) into actual_rows,actual_sha;
    if actual_rows<>(item->>'rows')::bigint or actual_sha<>item->>'sha256' then raise exception 'RESET_CANONICAL_CHANGED: %',item->>'table_name'; end if;
  end loop;
  if (select count(*) from private.dw_actors)<>1 or (select count(*) from public.dw_profiles)<>1
    or (select count(*) from private.facilitators)<>1 then raise exception 'RESET_IDENTITIES_REMAIN'; end if;
end
$reset$;
${transaction ? `commit;\nselect true as reset_completed,${literal(teacherActorId)} as preserved_teacher,${literal(backupReceiptSha256)} as backup_receipt_sha256;` : ''}
`;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--inventory' && args.length === 1) process.stdout.write(inventorySql(args[0]) + '\n');
  else if (command === '--generate' && args.length === 2) {
    const output = resolve(args[1]);
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const rel = relative(root, output);
    if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('RESET_OUTPUT_MUST_BE_PRIVATE_OUTSIDE_PROJECT');
    const sql = createResetSql(JSON.parse(await readFile(resolve(args[0]), 'utf8')));
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const file = await open(output, 'wx', 0o600);
    try { await file.writeFile(sql); await file.sync(); } finally { await file.close(); }
    process.stdout.write('Reset SQL generated; nothing executed.\n');
  } else throw new Error('Usage: workshop-reset.mjs --inventory cloud|offline OR --generate private-config.json private-reset.sql');
}
