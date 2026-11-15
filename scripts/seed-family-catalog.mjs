import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readableText = (value, max) => typeof value === 'string' && value.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const nonempty = (value, max) => readableText(value, max) && value.trim().length > 0;
const identifier = value => nonempty(value, 160) && /^[a-z0-9:_-]+$/u.test(value);
const parse = async name => JSON.parse(await readFile(resolve(root, 'public/data/corpus', name), 'utf8'));

function territoryKey(value) {
  return value.normalize('NFC').toLocaleLowerCase('ru-RU')
    .replace(/[‐‑‒–—−]/gu, '-').replace(/\s*-\s*/gu, '-').replace(/\s+/gu, ' ').trim();
}

function url(value) {
  if (typeof value !== 'string' || value.length > 2000 || !URL.canParse(value)) return false;
  const parsed = new URL(value);
  return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
}

function detailsFor(item) {
  if (!item.detail) return undefined;
  const { steps, documents, notes, official_links } = item.detail;
  for (const values of [steps, documents, notes]) {
    if (!Array.isArray(values) || values.length > 128 || values.some(value => !readableText(value, 5000)))
      throw new Error(`Invalid card details for ${item.id}`);
  }
  if (!Array.isArray(official_links) || official_links.length > 128 || official_links.some(link =>
    !link || !nonempty(link.title, 1000) || !nonempty(link.service, 500) || !url(link.url)))
    throw new Error(`Invalid official links for ${item.id}`);
  return { steps, documents, notes, officialLinks: official_links.map(({ title, url, service }) => ({ title, url, service })) };
}

export async function loadFamilyCatalogMaterial() {
  const [manifest, catalogue, groupFile] = await Promise.all([
    parse('index.json'), parse('family-catalog.json'), parse('family-catalog-groups.json'),
  ]);
  const commit = catalogue.source?.commit;
  if (catalogue.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(commit ?? '') || !Array.isArray(catalogue.measures)
    || groupFile.schemaVersion !== 1 || groupFile.catalogCommit !== commit
    || groupFile.cardCount !== catalogue.measures.length || !Array.isArray(groupFile.groups))
    throw new Error('Catalogue and grouping metadata do not describe the same pinned release');

  const territories = new Map();
  for (const { territory, regionId } of manifest.documents) {
    const key = territoryKey(territory);
    if (territories.has(key) && territories.get(key) !== regionId)
      throw new Error(`Ambiguous catalogue region ${territory}`);
    territories.set(key, regionId);
  }
  const groups = new Map();
  const groupIds = new Set();
  for (const group of groupFile.groups) {
    if (!identifier(group.id) || groupIds.has(group.id) || !nonempty(group.title, 300)
      || !['mechanism', 'same-title'].includes(group.kind)
      || !Array.isArray(group.catalogIds) || group.catalogIds.length < 2)
      throw new Error(`Invalid catalogue grouping ${group.id}`);
    groupIds.add(group.id);
    for (const id of group.catalogIds) {
      if (groups.has(id)) throw new Error(`Catalogue card ${id} occurs in multiple groups`);
      groups.set(id, group);
    }
  }

  const ids = new Set();
  const groupScopes = new Map();
  const cards = catalogue.measures.map(item => {
    if (!identifier(item.id) || ids.has(item.id) || !nonempty(item.title, 300)
      || !readableText(item.summary, 4000) || !nonempty(item.source_name, 1000) || !url(item.source_url)
      || !nonempty(item.category, 300) || !/^[a-f0-9]{64}$/u.test(item.content_hash ?? '')
      || (item.benefit !== null && !readableText(item.benefit, 20000)))
      throw new Error(`Invalid or repeated source card ${item.id}`);
    ids.add(item.id);
    const regionId = item.level === 'federal' ? 'federal' : item.level === 'regional' && typeof item.region === 'string'
      ? territories.get(territoryKey(item.region)) : null;
    const mechanism = item.summary.trim() ? item.summary : item.benefit;
    if (!identifier(regionId) || !nonempty(mechanism, 4000)
      || (item.eligibility != null && !readableText(item.eligibility, 20000))
      || (item.conditions != null && (!Array.isArray(item.conditions) || item.conditions.length > 500
        || item.conditions.some(value => !readableText(value, 5000)))))
      throw new Error(`Catalogue source or eligible territory not identified for ${item.id}`);
    const group = groups.get(item.id);
    if (group && groupScopes.has(group.id) && groupScopes.get(group.id) !== item.level)
      throw new Error(`Group ${group.id} mixes federal and regional cards`);
    if (group) groupScopes.set(group.id, item.level);
    const details = detailsFor(item);
    return {
      catalog_id: item.id,
      group_key: group?.id ?? item.id,
      group_title: group?.title ?? item.title,
      group_kind: group?.kind ?? null,
      bundle: {
        schemaVersion: 1,
        practice: {
          id: `catalog-${sha256(JSON.stringify([catalogue.source.repository, commit, item.id, item.content_hash])).slice(0, 32)}`,
          familyId: 'external-catalog', regionId, title: item.title, mechanism, amount: item.benefit,
          ...(item.eligibility != null ? { eligibility: item.eligibility } : {}),
          ...(item.conditions != null ? { conditions: item.conditions } : {}),
          occurrenceIds: [], reviewStatus: 'candidate',
        },
        occurrences: [], sources: [], note: '',
        catalogSource: {
          id: item.id, sourceName: item.source_name, sourceUrl: item.source_url,
          category: item.category, commit, ...(details ? { details } : {}),
        },
      },
    };
  });
  if (cards.length === 0 || cards.length > 5000 || [...groups.keys()].some(id => !ids.has(id)))
    throw new Error('Incomplete catalogue or unknown grouped cards');
  return { commit, materialSha: sha256(JSON.stringify(cards)), cards };
}

function literal(value) {
  const delimiter = '$family_catalog_seed$';
  if (value.includes(delimiter)) throw new Error('Unexpected SQL delimiter in catalogue material');
  return `${delimiter}${value}${delimiter}`;
}

export function familyCatalogSeedSql({ commit, materialSha, cards }) {
  const edition = literal(commit);
  const digest = literal(materialSha);
  const count = cards.length;
  const start = `do $verify$ begin
  insert into private.dw_family_catalog_releases(commit_sha,material_sha,card_count)
    values(${edition},${digest},${count}) on conflict(commit_sha) do nothing;
  if not exists(select 1 from private.dw_family_catalog_releases
    where commit_sha=${edition} and material_sha=${digest} and card_count=${count})
    then raise exception 'FAMILY_CATALOG_RELEASE_MISMATCH'; end if;
end $verify$;`;
  const finish = `do $seal$ begin
  if (select count(*) from private.dw_family_catalog where commit_sha=${edition})<>${count}
    then raise exception 'FAMILY_CATALOG_INCOMPLETE'; end if;
  update private.dw_family_catalog_releases set sealed=true
    where commit_sha=${edition} and material_sha=${digest} and card_count=${count} and not sealed;
  if not exists(select 1 from private.dw_family_catalog_releases
    where commit_sha=${edition} and material_sha=${digest} and card_count=${count} and sealed)
    then raise exception 'FAMILY_CATALOG_RELEASE_MISMATCH'; end if;
end $seal$;`;
  const batches = [];
  for (let index = 0; index < cards.length; index += 75) {
    batches.push(`select private.dw_import_family_catalog_batch(${edition},${literal(JSON.stringify(cards.slice(index, index + 75)))}::jsonb);`);
  }
  return [start, ...batches, finish];
}

export async function seedFamilyCatalog(db, material) {
  const release = material ?? await loadFamilyCatalogMaterial();
  const prior = (await db.query(`select material_sha,card_count,sealed,
    (select count(*)::int from private.dw_family_catalog where commit_sha=$1) as imported
    from private.dw_family_catalog_releases where commit_sha=$1`, [release.commit])).rows[0];
  if (prior?.sealed) {
    if (prior.material_sha !== release.materialSha || prior.card_count !== release.cards.length || prior.imported !== prior.card_count)
      throw new Error('FAMILY_CATALOG_RELEASE_MISMATCH');
    return prior.card_count;
  }
  await db.query('begin');
  try {
    for (const sql of familyCatalogSeedSql(release)) await db.query(sql);
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
  return release.cards.length;
}

async function main() {
  const [command, directory] = process.argv.slice(2);
  const release = await loadFamilyCatalogMaterial();
  if (command === '--check') {
    console.log(`Validated ${release.cards.length} family-support cards for ${release.commit}.`);
  } else if (command === '--sql' && directory) {
    await mkdir(directory, { recursive: true });
    for (const [index, sql] of familyCatalogSeedSql(release).entries()) {
      await writeFile(resolve(directory, `${String(index + 1).padStart(3, '0')}-family-catalog.sql`), `${sql}\n`, { flag: 'wx' });
    }
    console.log(`Prepared SQL batches for ${release.cards.length} cards.`);
  } else {
    if (command !== undefined || !process.env.SUPABASE_DB_URL)
      throw new Error('Usage: --check, --sql DIRECTORY, or configure SUPABASE_DB_URL for database import');
    const { Client } = await import('pg');
    const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: 'demography-family-catalog' });
    await db.connect();
    try { console.log(`Registered ${await seedFamilyCatalog(db, release)} family-support cards.`); }
    finally { await db.end(); }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`${String(error.message).replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted connection]')}\n`);
    process.exitCode = 1;
  });
}
