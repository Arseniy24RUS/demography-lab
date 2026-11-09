#!/usr/bin/env node
/** Audit the emitted anonymous dependency graph, including literal dynamic imports. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const html = await readFile(resolve(root, 'survey.html'), 'utf8');
const entry = html.match(/<script\s+type="module"[^>]+src="([^"]+)"/u)?.[1];
assert(entry, 'Independent built survey entry is missing.');
assert.match(html, /name="referrer" content="no-referrer"/u);
const visited = new Set();
async function inspect(path) {
  if (visited.has(path)) return;
  assert(path.startsWith(root + '/'), 'A survey dependency escaped the build.');
  assert(
    !/(?:session-api|classroom|ConnectedWorkshop|ConnectedBarriers|ProjectorContainer)-/u.test(
      path,
    ),
    'Anonymous entry imports an account module.',
  );
  visited.add(path);
  const code = await readFile(path, 'utf8');
  assert.doesNotMatch(
    code,
    /SupabaseAuthClient|detectSessionInUrl|dw-auth-|\/auth\/v1/u,
    'Anonymous dependency contains account auth code.',
  );
  for (const match of code.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.\.?\/[^"']+\.js)["']/gu))
    await inspect(resolve(dirname(path), match[1]));
}
await inspect(resolve(root, entry));
console.log(
  JSON.stringify({
    result: 'passed',
    anonymousEntry: entry,
    inspectedModules: visited.size,
    accountSdk: false,
    referrer: 'no-referrer',
  }),
);
