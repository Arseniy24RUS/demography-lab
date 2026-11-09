#!/usr/bin/env node
/** Export only the independently audited questionnaire graph to a static HTTPS origin. */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const [destination, surveyOrigin, classroomOrigin] = process.argv.slice(2);
if (!destination || !surveyOrigin || !classroomOrigin) throw new Error('Usage: package-survey-site.mjs DESTINATION SURVEY_ORIGIN CLASSROOM_ORIGIN');
const survey = new URL(surveyOrigin), classroom = new URL(classroomOrigin);
if ([survey, classroom].some(url => url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
  || survey.origin === classroom.origin) throw new Error('Two distinct HTTPS origins required.');
const source = resolve(root, 'dist'), target = resolve(destination, 'dist');
const manifest = JSON.parse(await readFile(resolve(destination, '.openai/hosting.json'), 'utf8'));
if (!manifest.project_id || manifest.static?.directory !== 'dist') throw new Error('Existing Site identity and static dist configuration required.');
await mkdir(target, { recursive: true });
const visited = new Set();
async function copyAsset(path) {
  const file = resolve(source, path), name = relative(source, file);
  if (name.startsWith('..') || visited.has(name)) return;
  if (!/^(?:assets\/[a-zA-Z0-9_./-]+|favicon\.svg)$/u.test(name)) throw new Error('Unexpected public asset.');
  const code = await readFile(file, 'utf8');
  if (/\.js$/u.test(name)) {
    if (/SupabaseAuthClient|detectSessionInUrl|dw-auth-|\/auth\/v1/u.test(code)) throw new Error('Account dependency in anonymous graph.');
    for (const match of code.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.\.?\/[^"']+\.js)["']/gu))
      await copyAsset(relative(source, resolve(dirname(file), match[1])));
  }
  visited.add(name);
  await mkdir(dirname(resolve(target, name)), { recursive: true });
  await copyFile(file, resolve(target, name));
}
const html = await readFile(resolve(source, 'survey.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/gu)) await copyAsset(match[1]);
await writeFile(resolve(target, 'survey.html'), html);
await writeFile(resolve(target, 'index.html'), '<!doctype html><html lang="ru"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>Демографическая мастерская — опрос</title><body style="font:18px system-ui;color:#123c73;max-width:700px;margin:15vh auto;padding:24px"><h1>Добровольный опрос</h1><p>Откройте ссылку приглашения, которую показал преподаватель. Учебная учётная запись для заполнения анкеты не используется.</p><p><a href="./survey.html">Открыть форму или восстановить доступ к своему ответу</a></p></body></html>');
const config = JSON.parse(await readFile(resolve(root, 'public/workshop-config.json'), 'utf8'));
config.surveyUrl = `${survey.origin}/survey.html`; config.classroomOrigin = classroom.origin;
await writeFile(resolve(target, 'workshop-config.json'), JSON.stringify(config, null, 2) + '\n');
await copyFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(target, 'THIRD_PARTY_NOTICES.md'));
await mkdir(resolve(target, 'licenses'), { recursive: true });
await copyFile(resolve(root, 'licenses/noble-hashes-MIT.txt'), resolve(target, 'licenses/noble-hashes-MIT.txt'));
console.log(JSON.stringify({ destination: target, anonymousAssets: visited.size, surveyUrl: config.surveyUrl, accountSDK: false }));
