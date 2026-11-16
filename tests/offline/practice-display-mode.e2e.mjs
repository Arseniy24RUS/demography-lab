/** Real compiled app and production offline PostgreSQL; all participant writes use the UI. */
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { openRuntime } from '../../scripts/offline/storage.mjs';
import { startServer } from '../../scripts/offline/server.mjs';
import { openStage } from './workshop-nav.mjs';

const port = Number(process.env.DW_PRACTICE_BROWSER_PORT ?? 8933);
const surveyPort = Number(process.env.DW_PRACTICE_SURVEY_PORT ?? 8934);
const host = '192.168.50.21';
const url = `http://${host}:${port}/`;
const evidence = resolve(process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? join(tmpdir(), 'demography-practice-display-mode'));
const directory = await mkdtemp(join(tmpdir(), 'demography-practice-browser-'));
await mkdir(evidence, { recursive: true });
const errors = [], warnings = [], failedResponses = [], externalRequests = [], steps = [];
const report = {
  version: JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version,
  environment: `${platform()} ${arch()}; compiled app and production offline PGlite; LAN host mapped to loopback`,
  browserPath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? 'Playwright Chromium',
  browserAvailability: 'Browser plugin not available; regular Playwright',
  url, viewports: [1440, 390, 320], steps,
};
const familyName = 'Региональный материнский (семейный) капитал';
const regionalTitle = 'Региональный материнский капитал при рождении второго ребёнка (Амурская область)';
const federalTitle = 'Декретные выплаты для ИП и самозанятых';
const board = page => page.getByRole('region', { name: 'Рейтинг практик', exact: true });
const card = (page, name) => board(page).getByRole('article', { name, exact: true });
const mode = (page, name) => board(page).getByRole('group', { name: 'Вид практик', exact: true })
  .getByRole('button', { name, exact: true });
const rpc = (page, name) => page.waitForResponse(response => response.request().method() === 'POST'
  && new URL(response.url()).pathname === `/rest/v1/rpc/${name}`);
const titles = page => board(page).locator('article h3').allTextContents();
let runtime, server, browser, lastPage;

async function step(name, page, work) {
  lastPage = page;
  const started = Date.now();
  await work();
  steps.push({ name, milliseconds: Date.now() - started });
  console.log(`PASS ${name}`);
}
async function participant() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU', reducedMotion: 'reduce', hasTouch: true });
  await context.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (['http:', 'https:'].includes(target.protocol) && ![host, '127.0.0.1'].includes(target.hostname)) {
      externalRequests.push(target.origin);
      await route.abort('internetdisconnected');
    } else await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.type() === 'warning') warnings.push(message.text());
  });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  return page;
}
async function enter(page, email, name) {
  await page.goto(url);
  await expect(page).toHaveTitle('Демографическая мастерская — документы и практики');
  const form = page.locator('.session-access-main form');
  await page.getByLabel('Email', { exact: true }).fill(email);
  const entering = rpc(page, 'dw_enter_workspace');
  await form.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Как к вам обращаться?', exact: true })).toBeVisible();
  await page.getByLabel('Фамилия, имя, отчество', { exact: true }).fill(name);
  await form.getByRole('button', { name: 'Продолжить', exact: true }).click();
  expect((await entering).status()).toBe(200);
  await expect(page.locator('.header-account .account-name')).toHaveText(name);
}
async function selectMeasure(page, territory, title) {
  const catalogue = page.getByRole('region', { name: 'Каталог мер', exact: true });
  await catalogue.getByRole('combobox', { name: 'Территория меры' }).selectOption({ label: territory });
  await catalogue.getByRole('searchbox', { name: 'Поиск мер' }).fill(title);
  const measure = catalogue.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  const selecting = rpc(page, 'dw_select_catalog_practice');
  await measure.getByRole('button', { name: 'Отобрать меру', exact: true }).click();
  expect((await selecting).status()).toBe(200);
  await expect(measure.getByRole('button', { name: 'Мера отобрана', exact: true })).toHaveAttribute('aria-pressed', 'true');
}
async function vote(page, title, direction) {
  const saving = rpc(page, 'dw_workspace_vote');
  await card(page, title).getByRole('button', { name: `${direction}: ${title}`, exact: true }).click();
  expect((await saving).status()).toBe(200);
}
async function noOverflow(page, width) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth,
    document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(dimensions.width).toBe(width);
  expect(dimensions.document).toBeLessThanOrEqual(width + 1);
  expect(dimensions.body).toBeLessThanOrEqual(width + 1);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}
async function screenshot(page, name) {
  await page.screenshot({ path: join(evidence, name), fullPage: false, animations: 'disabled' });
}

try {
  console.log('Preparing an isolated production offline runtime');
  runtime = await openRuntime({ dataDir: directory });
  server = await startServer({ runtime, port, surveyPort, publicHost: host, backupIntervalMs: 0 });
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--host-resolver-rules=MAP ${host} 127.0.0.1`],
  });
  report.browser = browser.version();
  const a = await participant();
  const b = await participant();
  let cloudOrder;

  await step('Two independent participants enter without a teacher and select two measures through Programs', a, async () => {
    await enter(a, 'practice-display-a@example.test', 'Первый участник проверки практик');
    await enter(b, 'practice-display-b@example.test', 'Второй участник проверки практик');
    await openStage(a, 'Программы');
    await a.getByRole('button', { name: 'Каталог мер', exact: true }).click();
    await selectMeasure(a, 'Амурская область', regionalTitle);
    await selectMeasure(a, 'Федеральные меры', federalTitle);
    for (const page of [a, b]) {
      await openStage(page, 'Практики');
      await expect(board(page).getByRole('article')).toHaveCount(2);
      await expect(card(page, familyName).getByText('Варианты мер · 1', { exact: true })).toBeVisible();
      await expect(card(page, federalTitle).getByText('Варианты мер · 1', { exact: true })).toBeVisible();
      await expect(mode(page, 'Облако')).toHaveAttribute('aria-pressed', 'true');
      await expect(board(page)).toHaveAttribute('data-view', 'cloud');
    }
    cloudOrder = await titles(a);
    expect(cloudOrder).toEqual([federalTitle, familyName]);
    expect(await titles(b)).toEqual(cloudOrder);
    await noOverflow(a, 1440);
    await screenshot(a, 'practice-cloud-desktop.png');
  });

  await step('View changes retain expanded original variants and voting remains live in both contexts', a, async () => {
    const regional = card(a, familyName);
    await regional.getByText('Варианты мер · 1', { exact: true }).click();
    await expect(regional).toContainText(regionalTitle);
    await expect(regional).toContainText('30 % от федерального материнского капитала');
    await mode(a, 'Рейтинг').click();
    await expect(board(a)).toHaveAttribute('data-view', 'ranking');
    await expect(regional).toContainText(regionalTitle);
    await vote(a, familyName, 'Поддержать');
    await expect(card(b, familyName).getByRole('button', { name: `Поддержать: ${familyName}`, exact: true })).toHaveText('1');
    expect(await titles(b)).toEqual(cloudOrder);
    await vote(b, familyName, 'Поддержать');
    await expect(regional.getByRole('button', { name: `Поддержать: ${familyName}`, exact: true })).toHaveText('2');
    await vote(b, federalTitle, 'Не поддержать');
    await expect(card(a, federalTitle).getByRole('button', { name: `Не поддержать: ${federalTitle}`, exact: true })).toHaveText('1');
    expect(await titles(b)).toEqual(cloudOrder);
    await expect(regional.getByRole('button', { name: `Поддержать: ${familyName}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  await step('Ranking follows shared scores while the cloud keeps its original positions', a, async () => {
    for (const page of [a, b]) {
      await mode(page, 'Рейтинг').click();
      expect(await titles(page)).toEqual([familyName, federalTitle]);
      await expect(card(page, familyName).getByLabel('Место 1', { exact: true })).toBeVisible();
      await expect(card(page, federalTitle).getByLabel('Место 2', { exact: true })).toBeVisible();
    }
    await expect(card(b, federalTitle).getByRole('button', { name: `Не поддержать: ${federalTitle}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await noOverflow(a, 1440);
    await screenshot(a, 'practice-ranking-desktop.png');
    await mode(a, 'Облако').click();
    expect(await titles(a)).toEqual(cloudOrder);
    await expect(card(a, familyName)).toContainText(regionalTitle);
    await card(a, familyName).getByRole('button', { name: 'Подробности варианта', exact: true }).click();
    const details = a.getByRole('dialog');
    await expect(details.getByRole('region', { name: 'Источник карточки' })).toBeVisible();
    await details.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  });

  await step('Search survives mode changes and filtered results retain their full-ranking position', a, async () => {
    const search = board(a).getByRole('searchbox', { name: 'Найти меру', exact: true });
    await search.fill(federalTitle);
    await expect(board(a).getByRole('article')).toHaveCount(1);
    await mode(a, 'Рейтинг').click();
    await expect(search).toHaveValue(federalTitle);
    await expect(card(a, federalTitle).getByLabel('Место 2', { exact: true })).toBeVisible();
    await mode(a, 'Облако').click();
    await expect(search).toHaveValue(federalTitle);
    await search.fill('');
    expect(await titles(a)).toEqual(cloudOrder);
    await vote(a, familyName, 'Поддержать');
    await expect(card(a, familyName).getByRole('button', { name: `Поддержать: ${familyName}`, exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(card(b, familyName).getByRole('button', { name: `Поддержать: ${familyName}`, exact: true })).toHaveText('1');
    expect(await titles(a)).toEqual(cloudOrder);
  });

  for (const width of [390, 320]) await step(`Both display modes remain usable at ${width}px`, b, async () => {
    await b.setViewportSize({ width, height: width === 390 ? 844 : 740 });
    for (const [label, view] of [['Облако', 'cloud'], ['Рейтинг', 'ranking']]) {
      await mode(b, label).click();
      await expect(board(b)).toHaveAttribute('data-view', view);
      await noOverflow(b, width);
      await mode(b, label).scrollIntoViewIfNeeded();
      await screenshot(b, `practice-${view}-mobile-${width}.png`);
    }
  });
  expect(externalRequests).toEqual([]);
  expect(failedResponses).toEqual([]);
  expect(errors).toEqual([]);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.error = error.stack;
  if (lastPage) await lastPage.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  report.browserErrors = errors;
  report.browserWarnings = warnings;
  report.failedResponses = failedResponses;
  report.externalRequests = externalRequests;
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await server?.stop();
  if (!server) await runtime?.close();
  await rm(directory, { recursive: true, force: true });
}
