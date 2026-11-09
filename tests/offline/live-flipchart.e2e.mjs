/** Production build + persistent offline server: real participant UI, no mocked data or responses. */
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openRuntime } from '../../scripts/offline/storage.mjs';
import { startServer } from '../../scripts/offline/server.mjs';

const port = Number(process.env.DW_FLIPCHART_BROWSER_PORT ?? 8891);
const surveyPort = Number(process.env.DW_FLIPCHART_SURVEY_PORT ?? 8892);
const host = '192.168.50.12';
const url = `http://${host}:${port}/#sessions=1`;
const directory = await mkdtemp(join(tmpdir(), 'demography-live-flipchart-'));
const evidence = resolve(process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? join(tmpdir(), 'demography-live-flipchart-evidence'));
await mkdir(evidence, { recursive: true });
let runtime, server;
async function start() {
  runtime = await openRuntime({ dataDir: directory });
  server = await startServer({ runtime, port, surveyPort, publicHost: host, backupIntervalMs: 0 });
}
await start();
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--host-resolver-rules=MAP ${host} 127.0.0.1`],
});
const errors = [], externalRequests = [], failedResponses = [], legacySurveyRequests = [], calls = [], participantPayloads = [], projectorPayloads = [], steps = [];
const responseReads = new Set();
const NAME_A = 'Первый участник флипчарта';
const NAME_B = 'Второй участник флипчарта';
const EMAIL_A = 'flipchart-a@example.test', EMAIL_B = 'flipchart-b@example.test';
const TEXT = {
  housing: 'Не хватает жилья рядом с работой',
  income: 'Нестабильный доход',
  rental: 'Доступная аренда на пять лет',
  nursery: 'Нет места в яслях',
  schedule: 'Гибкий график для родителей',
};
const report = {
  version: JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version,
  environment: 'Browser plugin not available; regular Playwright on Linux Chromium. Production offline PGlite; LAN HTTP origin mapped to loopback. No physical Wi-Fi, macOS, Safari or all-browser certification.',
  browser: browser.version(), steps, dataDirectory: directory,
};
const contexts = [];
let lastPage;
const scenes = page => page.getByRole('navigation', { name: 'Этапы коллективной работы', exact: true });
const board = page => page.getByRole('region', { name: 'Общий флипчарт', exact: true });
const projection = page => page.getByRole('region', { name: 'Флипчарт на проекторе', exact: true });
const note = (page, text) => page.getByRole('article', { name: text, exact: true });
const vote = (page, text, value) => note(page, text).getByRole('button', {
  name: `${value === 1 ? 'Поддержать' : 'Не поддержать'}: ${text}`, exact: true,
});
const rpc = (page, name) => page.waitForResponse(response =>
  new URL(response.url()).pathname === `/rest/v1/rpc/${name}` && response.request().method() === 'POST');

function watch(page) {
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/rest/v1/rpc/dw_flipchart_')) calls.push({ path, input: request.postDataJSON() });
    if (path === '/rest/v1/rpc/dw_workshop_survey') legacySurveyRequests.push(path);
  });
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400) failedResponses.push({ path, status: response.status() });
    if (path === '/rest/v1/rpc/dw_flipchart_updates') {
      const target = response.request().postDataJSON()?.p_projector === true ? projectorPayloads : participantPayloads;
      const reading = response.json().then(value => target.push(value)).catch(error => errors.push(`Flipchart JSON: ${String(error)}`));
      responseReads.add(reading);
      void reading.finally(() => responseReads.delete(reading));
    }
  });
}
async function participant(mobile = false, storageState) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    locale: 'ru-RU', reducedMotion: mobile ? 'reduce' : 'no-preference', isMobile: mobile, hasTouch: mobile,
    ...(storageState ? { storageState } : {}),
  });
  contexts.push(context);
  await context.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (['http:', 'https:'].includes(target.protocol) && !['127.0.0.1', host].includes(target.hostname)) {
      externalRequests.push(target.origin); await route.abort('internetdisconnected');
    } else await route.continue();
  });
  context.on('page', watch);
  return { context, page: await context.newPage() };
}
async function stage(name, page, work) {
  lastPage = page;
  const started = Date.now();
  await work();
  steps.push({ name, milliseconds: Date.now() - started });
  console.log(`PASS ${name}`);
}
async function noOverflow(page, width) {
  const measured = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(measured.viewport).toBe(width);
  expect(measured.document).toBeLessThanOrEqual(width + 1);
  expect(measured.body).toBeLessThanOrEqual(width + 1);
}
async function cleanBoard(page) {
  await expect(board(page)).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(board(page).getByRole('checkbox')).toHaveCount(0);
  await expect(board(page).getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Ответить анонимно', exact: true })).toHaveCount(0);
  for (const text of ['С какой позиции вы отвечаете?', 'Мне исполнилось 18 лет.', 'Сохранить ответ', 'Завершить опрос', 'Пропустить вопрос']) {
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  }
}
async function enter(page, email, fullName) {
  await page.goto(url);
  await expect(page).toHaveTitle('Демографическая мастерская — документы и практики');
  const form = page.locator('.session-access-main form');
  await expect(form.locator('input')).toHaveCount(1);
  await page.getByLabel('Email', { exact: true }).fill(email);
  const entering = rpc(page, 'dw_enter_workspace');
  await form.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByLabel('Фамилия, имя, отчество', { exact: true }).fill(fullName);
  await form.getByRole('button', { name: 'Продолжить', exact: true }).click();
  const response = await entering;
  expect(response.status(), await response.text()).toBe(200);
  const snapshot = await response.json();
  expect(snapshot.session.role).toBe('participant');
  await expect(page.locator('.header-account .account-name')).toHaveText(fullName);
  await expect(scenes(page).getByRole('button', { name: 'Флипчарт', exact: true })).toHaveAttribute('aria-current', 'page');
  await cleanBoard(page);
  return snapshot.session.id;
}
async function add(page, kind, text, keyboard = false) {
  await board(page).getByRole('group', { name: 'Тип тезиса', exact: true })
    .getByRole('button', { name: kind === 'barrier' ? 'Что мешает?' : 'Что помогло бы?', exact: true }).click();
  const input = board(page).getByRole('textbox', { name: 'Короткий тезис', exact: true });
  await input.fill(text);
  const adding = rpc(page, 'dw_flipchart_add');
  if (keyboard) await input.press('Enter');
  else await board(page).getByRole('button', { name: 'Добавить', exact: true }).click();
  const response = await adding;
  expect(response.status(), await response.text()).toBe(200);
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(note(page, text)).toBeVisible();
  const result = (await response.json()).note;
  expect(result.kind).toBe(kind); expect(result.text).toBe(text);
  return result;
}
async function screenshot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(evidence, name), fullPage: false, animations: 'disabled' });
}
function privateFree(value, projector = false) {
  const serialized = JSON.stringify(value);
  for (const prohibited of [NAME_A, NAME_B, EMAIL_A, EMAIL_B]) expect(serialized).not.toContain(prohibited);
  for (const item of value.notes ?? []) {
    const forbidden = /^(?:author|actor|user|email|fullName|profile)/iu;
    expect(Object.keys(item).filter(key => forbidden.test(key))).toEqual([]);
    if (projector) for (const key of ['myVote', 'myVoteRevision', 'canWithdraw']) expect(key in item).toBe(false);
  }
}

let a = await participant(), b = await participant(true), projector, sessionId;
try {
  await stage('Two participants enter the same flipchart with no teacher, invitations or survey form', a.page, async () => {
    sessionId = await enter(a.page, EMAIL_A, NAME_A);
    expect(await enter(b.page, EMAIL_B, NAME_B)).toBe(sessionId);
    expect(await b.page.evaluate(() => isSecureContext)).toBe(false);
    await expect(board(a.page).getByText('Пока нет тезисов', { exact: true })).toBeVisible();
    await expect(board(a.page).getByRole('button', { name: 'Добавить', exact: true })).toBeDisabled();
    await noOverflow(a.page, 1440); await noOverflow(b.page, 390);
    expect(legacySurveyRequests).toEqual([]);
    await screenshot(a.page, 'flipchart-empty-desktop.png');
  });
  await stage('Participants add independent short ideas and both see them live', a.page, async () => {
    await add(a.page, 'barrier', TEXT.housing, true);
    await add(a.page, 'barrier', TEXT.income);
    await add(a.page, 'condition', TEXT.rental, true);
    await add(b.page, 'barrier', TEXT.nursery);
    for (const text of [TEXT.housing, TEXT.income, TEXT.rental, TEXT.nursery]) {
      await expect(note(a.page, text)).toBeVisible();
      await expect(note(b.page, text)).toBeVisible();
    }
    await expect(board(a.page).getByRole('article')).toHaveCount(4);
    await expect(board(b.page).getByRole('article')).toHaveCount(4);
    for (const page of [a.page, b.page]) {
      const contents = await board(page).innerText();
      for (const text of [NAME_A, NAME_B, EMAIL_A, EMAIL_B]) expect(contents).not.toContain(text);
    }
    await screenshot(a.page, 'flipchart-four-ideas-desktop.png');
    await noOverflow(b.page, 390);
    await screenshot(b.page, 'flipchart-four-ideas-mobile.png');
  });
  await stage('The projector opens anonymous phrases and animates a new thesis from an independent phone', a.page, async () => {
    const popup = a.page.waitForEvent('popup');
    await a.page.getByRole('button', { name: 'Экран проектора', exact: true }).click();
    projector = await popup; lastPage = projector;
    await projector.setViewportSize({ width: 1920, height: 1080 });
    await expect(projection(projector)).toBeVisible();
    await expect(projection(projector).getByRole('article')).toHaveCount(4);
    await expect(projection(projector).locator('[data-new]')).toHaveCount(0);
    await add(b.page, 'condition', TEXT.schedule);
    await expect(note(projector, TEXT.schedule)).toHaveAttribute('data-new', 'true');
    for (const page of [a.page, b.page]) await expect(board(page).getByRole('article')).toHaveCount(5);
    await expect(projection(projector).getByRole('article')).toHaveCount(5);
    for (const text of Object.values(TEXT)) await expect(note(projector, text)).toBeVisible();
    const contents = await projection(projector).innerText();
    for (const text of [NAME_A, NAME_B, EMAIL_A, EMAIL_B]) expect(contents).not.toContain(text);
    await expect(projection(projector).getByRole('textbox')).toHaveCount(0);
    await expect(projection(projector).getByRole('button', { name: /^Поддержать:/u })).toHaveCount(0);
    await expect.poll(() => projectorPayloads.flatMap(value => value.notes ?? []).length).toBeGreaterThan(0);
    for (const payload of projectorPayloads) privateFree(payload, true);
    await noOverflow(projector, 1920);
    await screenshot(a.page, 'flipchart-five-ideas-desktop.png');
    await screenshot(b.page, 'flipchart-five-ideas-mobile.png');
  });
  await stage('Support, opposition, switching and removing a vote synchronize between independent devices', a.page, async () => {
    await vote(a.page, TEXT.housing, 1).click();
    await expect(vote(a.page, TEXT.housing, 1)).toHaveAttribute('aria-pressed', 'true');
    await expect(vote(b.page, TEXT.housing, 1)).toHaveText('1');
    await vote(b.page, TEXT.housing, -1).click();
    await expect(vote(a.page, TEXT.housing, -1)).toHaveText('1');
    await expect(vote(b.page, TEXT.housing, -1)).toHaveAttribute('aria-pressed', 'true');
    await vote(b.page, TEXT.housing, -1).click();
    await expect(vote(a.page, TEXT.housing, -1)).toHaveText('0');
    await expect(vote(b.page, TEXT.housing, -1)).toHaveAttribute('aria-pressed', 'false');
    await vote(b.page, TEXT.housing, -1).click();
    await expect(vote(b.page, TEXT.housing, -1)).toHaveAttribute('aria-pressed', 'true');
    await vote(b.page, TEXT.housing, 1).click();
    await expect(vote(a.page, TEXT.housing, 1)).toHaveText('2');
    await expect(vote(a.page, TEXT.housing, -1)).toHaveText('0');
    await vote(a.page, TEXT.schedule, -1).click();
    await expect(vote(b.page, TEXT.schedule, -1)).toHaveText('1');
    await expect.poll(() => projectorPayloads.flatMap(value => value.notes ?? [])
      .some(item => item.text === TEXT.housing && item.support === 2 && item.oppose === 0)).toBe(true);
    await screenshot(projector, 'flipchart-projector-cloud-1920.png');
  });
  await stage('Ranking retains both counts and full text; voting never removes unpopular ideas', a.page, async () => {
    await board(a.page).getByRole('button', { name: 'Рейтинг', exact: true }).click();
    await expect(board(a.page).getByRole('article').first()).toHaveAttribute('aria-label', TEXT.housing);
    await expect(board(a.page).getByRole('article').last()).toHaveAttribute('aria-label', TEXT.schedule);
    await expect(board(a.page).getByRole('article')).toHaveCount(5);
    await expect(vote(a.page, TEXT.housing, 1)).toHaveText('2');
    await expect(vote(a.page, TEXT.schedule, -1)).toHaveText('1');
    await screenshot(a.page, 'flipchart-ranking-desktop.png');
    await board(a.page).getByRole('button', { name: 'Облако', exact: true }).click();
    await expect(board(a.page).getByRole('article')).toHaveCount(5);
  });
  await stage('Only the owner sees removal; removal and undo synchronize without a confirmation form', a.page, async () => {
    await expect(note(b.page, TEXT.income).getByRole('button', { name: `Убрать стикер: ${TEXT.income}`, exact: true })).toHaveCount(0);
    await note(a.page, TEXT.income).getByRole('button', { name: `Убрать стикер: ${TEXT.income}`, exact: true }).click();
    await expect(note(a.page, TEXT.income)).toHaveCount(0);
    await expect(note(b.page, TEXT.income)).toHaveCount(0);
    await expect(note(projector, TEXT.income)).toHaveCount(0);
    await expect(a.page.getByRole('dialog')).toHaveCount(0);
    await a.page.getByRole('button', { name: 'Вернуть', exact: true }).click();
    await expect(note(a.page, TEXT.income)).toBeVisible();
    await expect(note(b.page, TEXT.income)).toBeVisible();
    await expect(note(projector, TEXT.income)).toBeVisible();
  });
  await stage('Touch controls remain usable at 390 and 320 pixels; projector also fits the narrow viewport', b.page, async () => {
    for (const width of [390, 320]) {
      await b.page.setViewportSize({ width, height: 844 });
      await noOverflow(b.page, width);
      const bounds = await vote(b.page, TEXT.housing, 1).boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
      await expect(board(b.page).getByRole('article')).toHaveCount(5);
      await screenshot(b.page, `flipchart-cloud-mobile-${width}.png`);
      await board(b.page).getByRole('button', { name: 'Рейтинг', exact: true }).click();
      await noOverflow(b.page, width);
      await expect(board(b.page).getByRole('article').first()).toHaveAttribute('aria-label', TEXT.housing);
      await screenshot(b.page, `flipchart-ranking-mobile-${width}.png`);
      await board(b.page).getByRole('button', { name: 'Облако', exact: true }).click();
    }
    await projector.setViewportSize({ width: 320, height: 844 });
    await noOverflow(projector, 320);
    await expect(projection(projector).getByRole('article')).toHaveCount(5);
    await screenshot(projector, 'flipchart-projector-320.png');
  });
  await stage('Reload restores all notes and individual votes without creating a legacy survey', a.page, async () => {
    await a.page.reload();
    await expect(scenes(a.page).getByRole('button', { name: 'Флипчарт', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(board(a.page).getByRole('article')).toHaveCount(5);
    await expect(vote(a.page, TEXT.housing, 1)).toHaveAttribute('aria-pressed', 'true');
    await expect(vote(a.page, TEXT.housing, 1)).toHaveText('2');
    await expect(vote(a.page, TEXT.schedule, -1)).toHaveAttribute('aria-pressed', 'true');
    expect(legacySurveyRequests).toEqual([]);
    expect((await runtime.db.query('select count(*)::int count from research.responses')).rows[0].count).toBe(0);
    expect((await runtime.db.query('select count(*)::int count from research.surveys')).rows[0].count).toBe(0);
  });
  await stage('Committed notes and votes survive a full persistent server restart', a.page, async () => {
    const stateA = await a.context.storageState(), stateB = await b.context.storageState();
    await Promise.allSettled([...responseReads]);
    await a.context.close(); await b.context.close();
    await server.stop(); server = null; runtime = null;
    await start();
    a = await participant(false, stateA); b = await participant(true, stateB); lastPage = a.page;
    await a.page.goto(url); await b.page.goto(url);
    await expect(a.page.locator('.header-account .account-name')).toHaveText(NAME_A);
    await expect(b.page.locator('.header-account .account-name')).toHaveText(NAME_B);
    for (const page of [a.page, b.page]) {
      await expect(board(page).getByRole('article')).toHaveCount(5);
      await expect(vote(page, TEXT.housing, 1)).toHaveText('2');
      await expect(vote(page, TEXT.housing, 1)).toHaveAttribute('aria-pressed', 'true');
      await expect(vote(page, TEXT.schedule, -1)).toHaveText('1');
      await cleanBoard(page);
    }
    await expect(vote(b.page, TEXT.schedule, -1)).toHaveAttribute('aria-pressed', 'false');
    await screenshot(a.page, 'flipchart-restored-after-restart.png');
  });
  expect(legacySurveyRequests).toEqual([]);
  await Promise.allSettled([...responseReads]);
  expect(errors).toEqual([]); expect(failedResponses).toEqual([]); expect(externalRequests).toEqual([]);
  expect(calls.filter(value => value.path.endsWith('/dw_flipchart_add'))).toHaveLength(5);
  expect(calls.some(value => value.path.endsWith('/dw_flipchart_updates') && Number(value.input.p_after_cursor) > 0)).toBe(true);
  for (const payload of projectorPayloads) privateFree(payload, true);
  for (const payload of participantPayloads) privateFree(payload);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error.stack;
  if (lastPage && !lastPage.isClosed()) {
    await lastPage.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(join(evidence, 'failure.txt'), await lastPage.locator('body').innerText().catch(() => ''));
  }
  throw error;
} finally {
  report.browserErrors = errors; report.externalRequests = externalRequests; report.failedResponses = failedResponses;
  report.legacySurveyRequests = legacySurveyRequests;
  report.rpcCounts = Object.fromEntries([...new Set(calls.map(value => value.path))].map(path => [path, calls.filter(value => value.path === path).length]));
  report.projectorPayloadsChecked = projectorPayloads.length;
  report.participantPayloadsChecked = participantPayloads.length;
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server?.stop(); await runtime?.close();
}
