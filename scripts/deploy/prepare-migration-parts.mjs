#!/usr/bin/env node
/** Connector transport helper. Does not connect or mutate; preserves shipped SQL bytes. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function splitStatements(sql) {
  const statements = [];
  let start = 0, i = 0, state = 'normal', tag = '', depth = 0;
  while (i < sql.length) {
    const a = sql[i], b = sql[i + 1];
    if (state === 'line') { if (a === '\n') state = 'normal'; i++; continue; }
    if (state === 'block') {
      if (a === '/' && b === '*') { depth++; i += 2; }
      else if (a === '*' && b === '/') { depth--; i += 2; if (!depth) state = 'normal'; }
      else i++;
      continue;
    }
    if (state === 'dollar') {
      if (sql.startsWith(tag, i)) { i += tag.length; state = 'normal'; } else i++;
      continue;
    }
    if (state === 'single' || state === 'escaped') {
      if (state === 'escaped' && a === '\\') { i += 2; continue; }
      if (a === "'") { if (b === "'") i += 2; else { state = 'normal'; i++; } } else i++;
      continue;
    }
    if (state === 'double') {
      if (a === '"') { if (b === '"') i += 2; else { state = 'normal'; i++; } } else i++;
      continue;
    }
    if (a === '-' && b === '-') { state = 'line'; i += 2; continue; }
    if (a === '/' && b === '*') { state = 'block'; depth = 1; i += 2; continue; }
    if (a === "'") { state = /[eE]/.test(sql[i - 1] ?? '') && !/[a-zA-Z0-9_]/.test(sql[i - 2] ?? '') ? 'escaped' : 'single'; i++; continue; }
    if (a === '"') { state = 'double'; i++; continue; }
    if (a === '$') {
      const match = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/);
      if (match) { tag = match[0]; state = 'dollar'; i += tag.length; continue; }
    }
    i++;
    if (a === ';') { statements.push(sql.slice(start, i)); start = i; }
  }
  if (!['normal', 'line'].includes(state)) throw new Error('Unterminated SQL token');
  if (start < sql.length) statements.push(sql.slice(start));
  if (statements.join('') !== sql) throw new Error('SQL bytes changed');
  return statements;
}

async function main() {
  const [file, directory, startText = '1'] = process.argv.slice(2);
  if (!file || !directory) throw new Error('Usage: prepare-migration-parts.mjs FILE OUTPUT_DIR [START_PART]');
  const sql = await readFile(resolve(file), 'utf8');
  const statements = splitStatements(sql);
  const groups = [];
  let group = '';
  for (const statement of statements) {
    if (group.length && group.length + statement.length > 7800) { groups.push(group); group = ''; }
    group += statement;
  }
  if (group.trim()) groups.push(group);
  else if (group.length) groups[groups.length - 1] += group;
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  const metadata = { file, sourceSha256: hash(sql), characters: sql.length, parts: [] };
  await mkdir(directory, { recursive: true });
  for (let i = 0; i < groups.length; i++) {
    const name = String(i + Number(startText)).padStart(2, '0') + '.sql';
    await writeFile(resolve(directory, name), groups[i]);
    metadata.parts.push({ file: name, characters: groups[i].length, sha256: hash(groups[i]) });
  }
  if (groups.join('') !== sql) throw new Error('Parts do not reproduce source');
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n');
  process.stdout.write(JSON.stringify(metadata) + '\n');
}
if (process.argv[1]?.endsWith('prepare-migration-parts.mjs')) await main();
