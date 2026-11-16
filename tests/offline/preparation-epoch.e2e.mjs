/** Real bootstrap, normal production CLI, and origin-scoped browser storage. */
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openReference } from './workshop-nav.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'dw-preparation-browser-'));
const evidence = resolve(process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? join(tmpdir(), 'dw-preparation-browser-evidence'));
await mkdir(evidence, { recursive: true });
const port = Number(process.env.DW_PREPARATION_BROWSER_PORT ?? 8957);
const surveyPort = Number(process.env.DW_PREPARATION_SURVEY_PORT ?? 8958);
const url = `http://127.0.0.1:${port}/`;
const otherOrigin = `http://localhost:${port}/`;
const otherInstance = '267e7c18-e293-48db-84ca-21708b8b884a';
const errors = [], warnings = [], failedResponses = [], externalRequests = [], steps = [];
let leakedOldAuth = 0, logs = '', browser, page;
const child = spawn(process.execPath, [join(root, 'scripts/offline/server.mjs')], {
  cwd: root, env: { ...process.env, DW_OFFLINE_DATA_DIR: directory, DW_OFFLINE_PORT: String(port),
    DW_OFFLINE_SURVEY_PORT: String(surveyPort), DW_OFFLINE_HOST: '127.0.0.1', DW_OFFLINE_OPEN_BROWSER: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-10000); });
const exited = new Promise(resolve => child.once('exit', resolve));
const report = { version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
  environment: 'Browser plugin unavailable; regular Playwright Chromium, normal production CLI/PGlite, isolated browser context',
  url, steps };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rpc = name => page.waitForResponse(response => response.request().method() === 'POST'
  && new URL(response.url()).pathname === `/rest/v1/rpc/${name}`);
async function step(name, action) {
  const started = Date.now(); await action();
  steps.push({ name, milliseconds: Date.now() - started }); console.log(`PASS ${name}`);
}
async function putGuest(target, names, title) {
  const doc = JSON.parse(await readFile(join(root, 'public/data/corpus/documents/regional-respublika-mordoviia.json'), 'utf8'));
  const block = doc.version.blocks.find(block => Array.from(block.text).length > 80);
  const points = Array.from(block.text), now = new Date().toISOString();
  const reference = { sourceId: doc.meta.id, editionId: doc.version.id, title: doc.meta.title,
    normalizationVersion: doc.version.normalizationVersion, sha256: doc.version.sourceSha256,
    sourceUrl: doc.version.sourceUrl, regionId: doc.meta.regionId };
  const state = { schemaVersion: 1, id: 'local-workspace', title: 'Моя рабочая тетрадь', profile: null,
    sourceReferences: [reference], annotations: [{ id: 'guest-annotation', note: 'Личная заметка', createdAt: now, updatedAt: now,
      anchor: { id: 'guest-anchor', documentId: doc.meta.id, versionId: doc.version.id, normalizationVersion: doc.version.normalizationVersion,
        spans: [{ blockId: block.id, start: 0, end: 64, exact: points.slice(0, 64).join(''), prefix: '', suffix: points.slice(64, 84).join('') }] } }],
    customCards: [{ id: 'guest-card', familyId: 'guest-family', regionId: doc.meta.regionId, title,
      mechanism: 'Предложение из гостевой рабочей тетради', occurrenceIds: ['guest-annotation'], reviewStatus: 'candidate', createdAt: now, updatedAt: now }],
    practiceProposals: [], linkDecisions: [], readingTasks: [], preferences: { selectedRegionId: doc.meta.regionId,
      selectedSourceEditionId: doc.version.id, selectedPracticeId: null, activePanel: 'my-work', readerFontScale: 1 } };
  await target.evaluate(async ({ names, state, reference, now }) => {
    for (const name of names) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('workspaces', { keyPath: 'workspaceId' });
          request.result.createObjectStore('operations', { keyPath: ['workspaceId', 'operationId'] });
          request.result.createObjectStore('source-editions', { keyPath: 'editionId' });
        };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['workspaces', 'operations', 'source-editions'], 'readwrite');
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
        tx.objectStore('workspaces').put({ workspaceId: 'local-workspace', state, revision: 1, updatedAt: now });
        tx.objectStore('operations').put({ workspaceId: 'local-workspace', operationId: 'old-operation', fingerprint: 'a'.repeat(64), revision: 1 });
        tx.objectStore('source-editions').put(reference);
      });
      db.close();
    }
  }, { names, state, reference, now });
}
async function countGuest(target, name) {
  return target.evaluate(async name => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const result = {};
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['workspaces', 'operations', 'source-editions']);
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      for (const name of ['workspaces', 'operations', 'source-editions']) {
        const request = tx.objectStore(name).count(); request.onsuccess = () => { result[name] = request.result; };
      }
    });
    db.close(); return result;
  }, name);
}

try {
  for (let i = 0; i < 900; i++) {
    if (child.exitCode !== null) throw new Error(`CLI exited before readiness: ${logs}`);
    try { const response = await fetch(url + 'offline/status'); if (response.ok && (await response.json()).ready) break; } catch { /* preparing */ }
    if (i === 899) throw new Error(`CLI readiness timeout: ${logs}`);
    await sleep(100);
  }
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (['http:', 'https:'].includes(target.protocol) && !['127.0.0.1', 'localhost'].includes(target.hostname)) {
      externalRequests.push(target.origin); await route.abort('internetdisconnected');
    } else await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.type() === 'warning') warnings.push(message.text());
  });
  page.on('request', request => { if (request.headers().authorization?.includes('old-fixture-auth')) leakedOldAuth++; });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  await page.goto(url + 'workshop-config.json');
  const config = await page.evaluate(() => JSON.parse(document.body.innerText));
  const own = `demography-workshop-offline-${config.offlineInstanceId}-v1`;
  const unrelated = `demography-workshop-offline-${otherInstance}-v1`;
  const legacy = 'demography-workshop-local-v1';
  const host = new URL(config.supabaseUrl).host;
  const clearedKeys = [`dw-auth-${host}`, `dw-auth-offline-${config.offlineInstanceId}-${host}`, `dw-entry-v1:${host}`,
    `dw-local-access-v1:${config.offlineInstanceId}`, `dw-local-share-v1:${config.offlineInstanceId}`,
    `dw-local-access-pending-v1:${config.offlineInstanceId}:old`, `dw-local-access-pending-current-v1:${config.offlineInstanceId}`, 'dw:cohort-options:1:old-map'];
  const retainedKeys = ['another-app-data', 'theme', 'sb-otherproject-auth-token', `dw-local-share-v1:${otherInstance}`, `dw-local-access-v1:${otherInstance}`];
  const elsewhere = await context.newPage();
  await elsewhere.goto(otherOrigin + 'workshop-config.json');
  await putGuest(elsewhere, [legacy], 'Данные другого origin');
  await step('Old guest cards, operation receipts and app auth exist before the application bootstrap', async () => {
    await putGuest(page, [legacy, own, unrelated], 'Старая гостевая тестовая карточка');
    await page.evaluate(({ clearedKeys, retainedKeys }) => {
      for (const key of clearedKeys) localStorage.setItem(key, JSON.stringify({ access_token: 'old-fixture-auth', refresh_token: 'old-fixture-refresh' }));
      for (const key of retainedKeys) localStorage.setItem(key, 'unrelated value');
    }, { clearedKeys, retainedKeys });
    expect((await countGuest(page, legacy)).workspaces).toBe(1);
    expect((await countGuest(page, own)).operations).toBe(1);
  });
  await step('First app load clears only current guest work and auth before login while retaining source caches', async () => {
    await page.goto(url);
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    for (const name of [legacy, own]) expect(await countGuest(page, name)).toEqual({ workspaces: 0, operations: 0, 'source-editions': 1 });
    const values = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), [...clearedKeys, ...retainedKeys]);
    for (const key of clearedKeys) expect(values[key]).toBeNull();
    for (const key of retainedKeys) expect(values[key]).toBe('unrelated value');
    expect(leakedOldAuth).toBe(0);
    await page.screenshot({ path: join(evidence, 'prepared-login-desktop.png'), animations: 'disabled' });
  });
  await step('Other installation namespaces and another browser origin are preserved', async () => {
    expect(await countGuest(page, unrelated)).toEqual({ workspaces: 1, operations: 1, 'source-editions': 1 });
    expect(await countGuest(elsewhere, legacy)).toEqual({ workspaces: 1, operations: 1, 'source-editions': 1 });
  });
  await step('The seeded teacher enters without a legacy guest-card import offer', async () => {
    const entering = rpc('dw_enter_workspace');
    await page.getByLabel('Email', { exact: true }).fill('omnistat@yandex.ru');
    await page.locator('.session-access-main form').getByRole('button', { name: 'Войти', exact: true }).click();
    expect((await entering).status()).toBe(200);
    await expect(page.locator('.header-account .account-name')).toHaveText('Ситковский Арсений Михайлович');
    await openReference(page, 'Моя работа');
    await expect(page.getByRole('button', { name: 'Добавить прежние заметки', exact: true })).toHaveCount(0);
    await expect(page.getByText('Старая гостевая тестовая карточка', { exact: true })).toHaveCount(0);
    await page.getByRole('banner').getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  });
  await step('A later reload preserves new guest cards and operation receipts after the one-time preparation', async () => {
    await page.goto(url + 'workshop-config.json');
    await putGuest(page, [legacy, own], 'Новая гостевая карточка после подготовки');
    await page.evaluate(() => localStorage.setItem('dw:cohort-options:1:new-map', 'new class scenario'));
    await page.goto(url);
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    for (const name of [legacy, own]) expect(await countGuest(page, name)).toEqual({ workspaces: 1, operations: 1, 'source-editions': 1 });
    expect(await page.evaluate(() => localStorage.getItem('dw:cohort-options:1:new-map'))).toBe('new class scenario');
    await openReference(page, 'Моя работа');
    await expect(page.getByText('Новая гостевая карточка после подготовки', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(evidence, 'new-guest-work-preserved-desktop.png'), animations: 'disabled' });
  });
  expect(errors).toEqual([]); expect(warnings).toEqual([]); expect(failedResponses).toEqual([]); expect(externalRequests).toEqual([]);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error.stack;
  await page?.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  Object.assign(report, { browserErrors: errors, browserWarnings: warnings, failedResponses, externalRequests, leakedOldAuth });
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated CLI failed to stop gracefully.')), 20000);
    exited.then(() => { clearTimeout(timer); resolve(); });
  });
  await rm(directory, { recursive: true, force: true });
}
