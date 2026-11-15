/** Real production offline app: unchanged RUDN reader, real corpus, native scrolling and saving. */
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { openRuntime } from '../../scripts/offline/storage.mjs';
import { startServer } from '../../scripts/offline/server.mjs';
import { openReference } from './workshop-nav.mjs';

const port = Number(process.env.DW_READER_BROWSER_PORT ?? 8897);
const surveyPort = Number(process.env.DW_READER_SURVEY_PORT ?? 8898);
const host = '192.168.50.13';
const url = `http://${host}:${port}/#sessions=1`;
const directory = await mkdtemp(join(tmpdir(), 'demography-continuous-reader-'));
const evidence = resolve(
  process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? join(tmpdir(), 'demography-continuous-reader-evidence'),
);
await mkdir(evidence, { recursive: true });
const manifest = JSON.parse(
  await readFile(new URL('../../public/data/corpus/index.json', import.meta.url), 'utf8'),
);
async function source(id) {
  const raw = JSON.parse(
    await readFile(
      new URL(`../../public/data/corpus/documents/${id}.json`, import.meta.url),
      'utf8',
    ),
  );
  return { entry: manifest.documents.find((entry) => entry.id === id), version: raw.version };
}
const chuvashia = await source('regional-chuvashskaia-respublika-chuvashiia');
const leningrad = await source('regional-leningradskaia-oblast');
const moscow = await source('regional-moskovskaia-oblast');
const runtime = await openRuntime({ dataDir: directory });
const server = await startServer({
  runtime,
  port,
  surveyPort,
  publicHost: host,
  backupIntervalMs: 0,
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    `--host-resolver-rules=MAP ${host} 127.0.0.1`,
  ],
});
const errors = [],
  externalRequests = [],
  failedResponses = [],
  steps = [],
  requests = [],
  workers = [];
const contexts = [];
const report = {
  version: JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    .version,
  environment: `${platform()} ${arch()}; isolated headless browser; compiled app + production offline PGlite; LAN HTTP alias mapped to loopback. No physical phone or Wi-Fi certification.`,
  browser: browser.version(),
  executable: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? 'Playwright default Chromium',
  steps,
  dataDirectory: directory,
};
const reader = (page) => page.getByRole('region', { name: 'Полный текст программы', exact: true });
const paper = (page) => reader(page).locator('.ll-paper');
const panels = (page) =>
  page.getByRole('navigation', { name: 'Панели рабочей области', exact: true });
const canonicalRequests = (page) =>
  requests.filter(
    (request) =>
      request.page === page && /\/data\/corpus\/documents\/[^/]+\.json$/u.test(request.path),
  );
const rpc = (page, name) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/rest/v1/rpc/${name}` &&
      response.request().method() === 'POST',
  );
let lastPage;

async function participant(mobile = false) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    locale: 'ru-RU',
    reducedMotion: 'reduce',
    isMobile: mobile,
    hasTouch: mobile,
  });
  contexts.push(context);
  await context.route('**/*', async (route) => {
    const requested = new URL(route.request().url());
    if (
      ['http:', 'https:'].includes(requested.protocol) &&
      !['127.0.0.1', host].includes(requested.hostname)
    ) {
      externalRequests.push(requested.origin);
      await route.abort('internetdisconnected');
    } else await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => requests.push({ page, path: new URL(request.url()).pathname }));
  page.on('worker', (worker) => workers.push({ page, url: worker.url() }));
  page.on('response', (response) => {
    if (response.status() >= 400)
      failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  await page.goto(url);
  await expect(page).toHaveTitle('Демографическая мастерская — документы и практики');
  const form = page.locator('.session-access-main form');
  await form
    .getByLabel('Email', { exact: true })
    .fill(mobile ? 'reader-phone@example.test' : 'reader-desktop@example.test');
  await form.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Как к вам обращаться?', exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Фамилия, имя, отчество', { exact: true })
    .fill(mobile ? 'Проверка чтения на телефоне' : 'Проверка непрерывного чтения');
  await form.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Общий флипчарт', exact: true })).toBeVisible();
  await openReference(page, 'Документы');
  return page;
}
async function stage(name, page, work) {
  lastPage = page;
  const started = Date.now();
  await work();
  steps.push({ name, milliseconds: Date.now() - started });
  console.log(`PASS ${name}`);
}
async function openSource(page, document) {
  const library = page.getByRole('complementary', { name: 'Библиотека программ', exact: true });
  if (!(await library.isVisible()))
    await panels(page).getByRole('button', { name: 'Библиотека', exact: true }).click();
  await library
    .getByRole('textbox', { name: 'Найти программу', exact: true })
    .fill(document.entry.territory);
  await library.getByRole('button').filter({ hasText: document.entry.territory }).click();
  await expect(reader(page)).toBeVisible();
  await expect(reader(page).locator('.reader-region')).toContainText(document.entry.territory);
  await expect(
    reader(page).getByRole('textbox', { name: 'Поиск в полном тексте', exact: true }),
  ).toBeEnabled();
  await expect(paper(page).locator('[data-source-text]').first()).toBeVisible();
}
async function noOverflow(page, width) {
  const measured = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(measured.width).toBe(width);
  expect(measured.document).toBeLessThanOrEqual(width + 1);
  expect(measured.body).toBeLessThanOrEqual(width + 1);
}
async function mounted(page, document) {
  const rendered = await paper(page)
    .locator('[data-source-text]')
    .evaluateAll((elements) =>
      elements.map((element) => ({ id: element.dataset.blockId, text: element.textContent })),
    );
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.length).toBeLessThanOrEqual(192);
  expect(new Set(rendered.map((block) => block.id)).size).toBe(rendered.length);
  const byId = new Map(document.version.blocks.map((block) => [block.id, block]));
  for (const block of rendered) {
    expect(byId.has(block.id), `Unexpected mounted source block ${block.id}`).toBe(true);
    expect(block.text, `Canonical source text ${block.id}`).toBe(byId.get(block.id).text);
  }
  expect(
    await paper(page).locator('.ll-reader-block[data-reader-block]').count(),
  ).toBeLessThanOrEqual(3);
  return rendered.map((block) => byId.get(block.id).order);
}
async function continuousEnd(page, document) {
  const initial = await mounted(page, document);
  await expect(
    reader(page).getByRole('button', {
      name: /Показать следующую страницу|^Следующая страница$|^Предыдущая страница$/u,
    }),
  ).toHaveCount(0);
  await paper(page).focus();
  for (let count = 0; count < 5; count += 1) await paper(page).press('PageDown');
  const last = document.version.blocks.at(-1);
  // Estimated spacer heights settle as the newly visible chunks are measured.
  // Keep using native scrolling until the actual document end is visible.
  await expect(async () => {
    await paper(page).press('End');
    await expect(paper(page).locator(`[data-unit="${last.id}"]`)).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 15000, intervals: [200, 400, 700] });
  const final = await mounted(page, document);
  expect(Math.max(...final)).toBeGreaterThan(Math.max(...initial));
  expect(final).toContain(last.order);
  expect(canonicalRequests(page)).toEqual([]);
}
function remoteQuery(document) {
  const normalize = (text) => text.toLocaleLowerCase('ru').replace(/ё/gu, 'е');
  for (const block of document.version.blocks.slice(
    Math.floor(document.version.blocks.length * 0.55),
  )) {
    if (
      block.kind !== 'paragraph' ||
      block.text.length < 80 ||
      block.text.length > 700 ||
      (block.text.match(/[а-яё]/giu)?.length ?? 0) < 100 ||
      /[a-z]/iu.test(block.text)
    )
      continue;
    const words = normalize(block.text)
      .match(/[\p{L}\p{N}]{4,}/gu)
      ?.slice(0, 7);
    if (!words || words.length < 5 || words.some((word) => /^\d+$/u.test(word))) continue;
    const matches = document.version.blocks.filter((value) =>
      words.every((word) => normalize(value.text).includes(word)),
    );
    if (matches.length === 1) return { block, query: words.join(' ') };
  }
  throw new Error(`No unique remote search fixture in ${document.entry.id}`);
}
const target = remoteQuery(leningrad);
let desktop, phone;
const note = 'Непрерывный просмотр: точная цитата после поиска в длинном документе.';
try {
  desktop = await participant();
  await stage(
    'Chuvashia: real 2579-block document opens without eager canonical JSON',
    desktop,
    async () => {
      await openSource(desktop, chuvashia);
      expect(chuvashia.version.blocks).toHaveLength(2579);
      await mounted(desktop, chuvashia);
      expect(canonicalRequests(desktop)).toEqual([]);
      expect(
        requests.some(
          (request) => request.page === desktop && request.path.startsWith('/data/reader/'),
        ),
      ).toBe(true);
      await noOverflow(desktop, 1440);
    },
  );
  await stage(
    'Native scrolling reaches the end automatically while DOM remains bounded',
    desktop,
    async () => {
      await continuousEnd(desktop, chuvashia);
      await desktop.screenshot({
        path: join(evidence, 'desktop-chuvashia-end.png'),
        fullPage: false,
      });
    },
  );
  await stage(
    'Leningrad: worker search mounts a remote exact source and keeps original page linkage',
    desktop,
    async () => {
      await openSource(desktop, leningrad);
      expect(leningrad.version.blocks).toHaveLength(1113);
      await reader(desktop)
        .getByRole('textbox', { name: 'Поиск в полном тексте', exact: true })
        .fill(target.query);
      const hit = reader(desktop).getByRole('button', {
        name: new RegExp(`^Страница ${target.block.pageStart}\\b`, 'u'),
      });
      await expect(hit).toHaveCount(1);
      await hit.click();
      await expect(paper(desktop).locator(`[data-unit="${target.block.id}"]`)).toBeVisible();
      await expect(
        reader(desktop).getByRole('link', { name: 'Оригинал', exact: true }),
      ).toHaveAttribute('href', new RegExp(`#page=${target.block.pageStart}$`, 'u'));
      await mounted(desktop, leningrad);
      expect(canonicalRequests(desktop)).toEqual([]);
      expect(workers.some((worker) => worker.page === desktop)).toBe(true);
      await desktop.screenshot({
        path: join(evidence, 'desktop-leningrad-search.png'),
        fullPage: false,
      });
    },
  );
  await stage(
    'Choosing a source fragment lazily validates canonical material and saves an exact server quotation',
    desktop,
    async () => {
      await reader(desktop)
        .getByRole('button', { name: `Выбрать фрагмент ${target.block.order + 1}`, exact: true })
        .click();
      await expect(
        reader(desktop).getByText('Выбрано фрагментов: 1', { exact: true }),
      ).toBeVisible();
      expect(
        canonicalRequests(desktop).some((request) =>
          request.path.endsWith(`/${leningrad.entry.id}.json`),
        ),
      ).toBe(true);
      await reader(desktop)
        .getByRole('button', { name: 'Сохранить цитату без карточки', exact: true })
        .click();
      const dialog = desktop.getByRole('dialog', { name: 'Сохранить цитату', exact: true });
      await dialog
        .getByRole('textbox', { name: 'Комментарий к фрагменту', exact: true })
        .fill(note);
      const saving = rpc(desktop, 'dw_workspace_commit');
      await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
      const response = await saving;
      expect(response.status(), await response.text()).toBe(200);
      const saved = await response.json();
      expect(saved.kind).toBe('committed');
      const annotation = saved.snapshot.state.annotations.find((value) => value.note === note);
      expect(annotation.anchor.versionId).toBe(leningrad.version.id);
      expect(annotation.anchor.spans).toMatchObject([
        {
          blockId: target.block.id,
          start: 0,
          end: Array.from(target.block.text).length,
          exact: target.block.text,
        },
      ]);
      await expect(dialog).toBeHidden();
      await desktop.reload();
      await openReference(desktop, 'Моя работа');
      const quotation = desktop.getByRole('article').filter({ hasText: note });
      await expect(quotation).toHaveCount(1);
      expect(await quotation.locator('blockquote').textContent()).toBe(target.block.text);
      await quotation.getByRole('button', { name: 'К источнику', exact: true }).click();
      await expect(paper(desktop).locator(`[data-unit="${target.block.id}"]`)).toBeVisible();
      await mounted(desktop, leningrad);
      await desktop.screenshot({
        path: join(evidence, 'desktop-saved-quotation-return.png'),
        fullPage: false,
      });
    },
  );
  phone = await participant(true);
  await stage(
    'Fresh touch viewport390 reads the entire large document without loading canonical JSON',
    phone,
    async () => {
      await openSource(phone, chuvashia);
      await continuousEnd(phone, chuvashia);
      await noOverflow(phone, 390);
      await phone.screenshot({
        path: join(evidence, 'phone-chuvashia-end-390.png'),
        fullPage: false,
      });
    },
  );
  await stage(
    'Reader survives width320, desktop resize and rapid document switches without stale text',
    phone,
    async () => {
      await phone.setViewportSize({ width: 320, height: 800 });
      await mounted(phone, chuvashia);
      await noOverflow(phone, 320);
      await openSource(phone, leningrad);
      await noOverflow(phone, 320);
      await mounted(phone, leningrad);
      await phone.screenshot({ path: join(evidence, 'phone-leningrad-320.png'), fullPage: false });
      await phone.setViewportSize({ width: 1440, height: 1000 });
      const library = phone.getByRole('complementary', {
        name: 'Библиотека программ',
        exact: true,
      });
      await library.getByRole('textbox', { name: 'Найти программу', exact: true }).fill('');
      await library.getByRole('button').filter({ hasText: chuvashia.entry.territory }).click();
      await library.getByRole('button').filter({ hasText: leningrad.entry.territory }).click();
      await expect(
        reader(phone).getByText(leningrad.entry.territory, { exact: true }),
      ).toBeVisible();
      await expect(
        reader(phone).getByRole('textbox', { name: 'Поиск в полном тексте', exact: true }),
      ).toBeEnabled();
      await mounted(phone, leningrad);
      expect(canonicalRequests(phone)).toEqual([]);
      await noOverflow(phone, 1440);
    },
  );
  await stage(
    'Blank extracted source pages retain an explicit original-PDF warning',
    phone,
    async () => {
      await openSource(phone, moscow);
      await reader(phone).getByRole('textbox', { name: 'Номер страницы', exact: true }).fill('57');
      await reader(phone)
        .getByRole('textbox', { name: 'Номер страницы', exact: true })
        .press('Enter');
      await expect(
        reader(phone).getByText(/На странице 57 нет извлечённого текста/u),
      ).toBeVisible();
      await expect(
        reader(phone).getByRole('link', { name: 'Оригинал', exact: true }),
      ).toHaveAttribute('href', /#page=57$/u);
      expect(canonicalRequests(phone)).toEqual([]);
      await noOverflow(phone, 1440);
    },
  );
  expect(externalRequests).toEqual([]);
  expect(failedResponses).toEqual([]);
  expect(errors).toEqual([]);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.error = error.stack;
  if (lastPage) {
    await lastPage
      .screenshot({ path: join(evidence, 'failure.png'), fullPage: false })
      .catch(() => {});
    await writeFile(
      join(evidence, 'failure.txt'),
      await lastPage
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  }
  throw error;
} finally {
  report.externalRequests = externalRequests;
  report.browserErrors = errors;
  report.failedResponses = failedResponses;
  report.requests = requests.map(({ page, path }) => ({
    viewport: page === desktop ? 'desktop' : 'phone',
    path,
  }));
  report.workers = workers.map(({ page, url }) => ({
    viewport: page === desktop ? 'desktop' : 'phone',
    url,
  }));
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  for (const context of contexts) await context.close();
  await browser.close();
  await server.stop();
}
