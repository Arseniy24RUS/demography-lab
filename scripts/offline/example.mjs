/** Initialize the public teaching example only in an otherwise empty installation. */
import { identify } from './auth.mjs';
import { buildSaranskExample, SARANSK_EXAMPLE_VERSION, SARANSK_EXAMPLE_LABEL } from '../maintenance/saransk-example.mjs';
import { buildSeedExampleSql, EXAMPLE_TEACHER_NAME } from '../maintenance/seed-example.mjs';
import { sha256 } from './storage.mjs';

export const EXAMPLE_SEED_SETTING = `example-seed:${SARANSK_EXAMPLE_VERSION}`;
const teacher = { email: 'omnistat@yandex.ru', fullName: EXAMPLE_TEACHER_NAME };

export async function seedOfflineExample(runtime) {
  return runtime.db.transaction(async tx => {
    const saved = (await tx.query('select value from offline.settings where key=$1', [EXAMPLE_SEED_SETTING])).rows[0];
    if (saved) return { status: 'already-prepared', previousStatus: saved.value.status };
    const nonempty = (await tx.query(`select
      exists(select 1 from auth.users) or exists(select 1 from private.dw_actors)
      or exists(select 1 from public.dw_sessions) or exists(select 1 from private.dw_workspaces)
      or exists(select 1 from private.dw_roadmaps) or exists(select 1 from research.surveys)
      or exists(select 1 from research.responses) as present`)).rows[0].present;
    if (nonempty) {
      await tx.query('insert into offline.settings(key,value) values($1,$2::jsonb)',
        [EXAMPLE_SEED_SETTING, JSON.stringify({ status: 'skipped-nonempty', version: SARANSK_EXAMPLE_VERSION })]);
      return { status: 'skipped-nonempty' };
    }
    const template = await buildSaranskExample();
    // Keep the ordinary identity validation, profile and teacher eligibility path
    // inside this same transaction: a failed seed cannot leave a partial account.
    const account = await identify({ ...runtime, db: { transaction: callback => callback(tx) } }, teacher);
    await tx.exec(buildSeedExampleSql(template, { mode: 'offline', teacherId: account.session.user.id }));
    const complete = (await tx.query(`select count(*)::int as count from private.dw_roadmaps r
      where r.example_label=$1 and exists(select 1 from private.dw_roadmap_versions v where v.roadmap_id=r.id)`,
    [SARANSK_EXAMPLE_LABEL])).rows[0].count;
    if (complete !== 1) throw new Error('OFFLINE_EXAMPLE_INCOMPLETE');
    // The seed has no browser and needs no retained bearer or refresh token.
    await tx.query('delete from offline.sessions where access_hash=$1', [sha256(account.session.access_token)]);
    await tx.query('insert into offline.settings(key,value) values($1,$2::jsonb)',
      [EXAMPLE_SEED_SETTING, JSON.stringify({ status: 'completed', version: SARANSK_EXAMPLE_VERSION, label: SARANSK_EXAMPLE_LABEL })]);
    return { status: 'created', label: SARANSK_EXAMPLE_LABEL };
  });
}
