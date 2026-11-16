/** Fresh production CLI, real browser UI and downloads. No test seed or database writes. */
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { buildSaranskExample } from '../../scripts/maintenance/saransk-example.mjs';
import { openStage } from './workshop-nav.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const host = '192.168.50.14';
const directory = await mkdtemp(join(tmpdir(), 'demography-example-browser-'));
const evidence = resolve(process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? join(tmpdir(), 'demography-example-browser-evidence'));
await mkdir(evidence, { recursive: true });
const template = await buildSaranskExample();
const expectedItems = template.items.length + template.factCaptures.length;
const title = template.items.find(item => item.kind === 'passport').data.title;
const chronologicalActivities = [
  'Проверить исходные данные и согласовать устройство пилота',
  'Уточнить потребности и спроектировать семейные маршруты',
  'Подготовить каталог, специалистов и проектный учёт',
  'Испытать согласованный формат кратковременных занятий',
  'Провести пилот семейной навигации',
  'Согласовать добровольные маршруты с работодателями',
  'Оценить пилот и принять решение о масштабе',
  'Расширять только проверенные компоненты и вести мониторинг',
  'Подготовить итоговую оценку и передачу результатов',
];
const teacherName = 'Ситковский Арсений Михайлович';
const stages = [], screenshots = [], errors = [], failedResponses = [], externalRequests = [];
const snapshots = new WeakMap(), responseChecks = [];
const report = { environment: 'Browser plugin not available; Playwright Chromium, production offline CLI/PGlite and compiled app. LAN hostname mapped to loopback; no physical phone or Wi-Fi certification.',
  dataDirectory: directory, expectedItems, stages, screenshots };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const roadmap = page => page.getByRole('region', { name: 'Дорожные карты', exact: true });
const navigation = page => page.getByRole('navigation', { name: 'Разделы дорожной карты', exact: true });
const picker = page => page.getByRole('region', { name: 'Пример дорожной карты', exact: true });
const passport = page => page.getByRole('form', { name: 'Паспорт проекта', exact: true });
let server, browser, lastPage, url, sampleId, sessionId;

function rpc(page, method) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/rest/v1/rpc/${method}` && response.request().method() === 'POST');
  void pending.catch(() => {});
  return pending;
}
async function launch() {
  const child = spawn(process.execPath, [join(root, 'scripts/offline/server.mjs')], { cwd: root,
    env: { ...process.env, DW_OFFLINE_DATA_DIR: directory, DW_OFFLINE_PORT: process.env.DW_EXAMPLE_BROWSER_PORT ?? '8959', DW_OFFLINE_SURVEY_PORT: process.env.DW_EXAMPLE_SURVEY_PORT ?? '8960',
      DW_OFFLINE_HOST: '127.0.0.1', DW_OFFLINE_PUBLIC_HOST: host, DW_OFFLINE_OPEN_BROWSER: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-10000); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([exited, sleep(20000).then(() => { throw new Error('Production CLI did not stop.'); })]);
  };
  try {
    for (let attempt = 0; attempt < 1200; attempt++) {
      if (child.exitCode !== null) throw new Error(`Production CLI exited: ${logs}`);
      try {
        const runtime = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
        const loopback = `http://127.0.0.1:${runtime.port}`;
        if ((await fetch(loopback + '/offline/status')).ok) return { child, stop, loopback, url: `http://${host}:${runtime.port}/`, logs: () => logs };
      } catch { /* Canonical preparation precedes listener startup. */ }
      await sleep(100);
    }
    throw new Error(`Production CLI startup timed out: ${logs}`);
  } catch (error) { await stop(); throw error; }
}
async function stage(name, page, action) {
  lastPage = page;
  const started = Date.now();
  await action();
  stages.push({ name, milliseconds: Date.now() - started });
  console.log(`PASS ${name}`);
}
async function screenshot(page, name) {
  const path = join(evidence, name);
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  screenshots.push(path);
}
async function health(page, width) {
  expect(new URL(page.url()).origin).toBe(new URL(url).origin);
  await expect(page).toHaveTitle('Демографическая мастерская — документы и практики');
  expect((await page.locator('body').innerText()).length).toBeGreaterThan(100);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const layout = await page.evaluate(() => ({ viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(layout.viewport).toBe(width);
  expect(layout.html).toBeLessThanOrEqual(width + 1);
  expect(layout.body).toBeLessThanOrEqual(width + 1);
}
async function person(name, mobile = false) {
  const context = await browser.newContext({ locale: 'ru-RU', reducedMotion: 'reduce', acceptDownloads: true,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
  await context.route('**/*', async route => {
    const requested = new URL(route.request().url());
    if (['http:', 'https:'].includes(requested.protocol) && ![host, '127.0.0.1'].includes(requested.hostname)) {
      externalRequests.push(requested.origin); await route.abort('internetdisconnected');
    } else await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push({ person: name, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') errors.push({ person: name, message: message.text() }); });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push({ person: name, path: new URL(response.url()).pathname, status: response.status() }); });
  snapshots.set(page, new Map());
  page.on('response', response => {
    if (response.status() === 200 && new URL(response.url()).pathname === '/rest/v1/rpc/dw_roadmap_snapshot')
      responseChecks.push(response.json().then(value => snapshots.get(page).set(value.roadmapId, value)));
  });
  return { page, context };
}
async function enter(page, email, fullName) {
  await page.goto(url);
  const form = page.locator('.session-access-main form');
  await form.getByLabel('Email', { exact: true }).fill(email);
  let entering = fullName ? null : rpc(page, 'dw_enter_workspace');
  await form.getByRole('button', { name: 'Войти', exact: true }).click();
  if (fullName) {
    await page.getByLabel('Фамилия, имя, отчество', { exact: true }).fill(fullName);
    entering = rpc(page, 'dw_enter_workspace');
    await form.getByRole('button', { name: 'Продолжить', exact: true }).click();
  }
  const response = await entering;
  expect(response.status(), await response.text()).toBe(200);
  const snapshot = await response.json();
  expect(snapshot.submissions).toEqual([]);
  await expect(page.locator('.header-account .account-name')).toHaveText(fullName ?? teacherName);
  await expect(page.getByLabel('Фамилия, имя, отчество', { exact: true })).toHaveCount(0);
  return snapshot;
}
async function openExample(page) {
  await openStage(page, 'Дорожная карта');
  await expect(picker(page)).toBeVisible();
  await picker(page).getByRole('button', { name: /^ПРИМЕР · .*Саранск/u }).click();
  // A teacher is already assigned to the seeded room: selecting it can reuse the
  // snapshot loaded with the picker rather than issue a redundant same-ID read.
  await expect(passport(page)).toBeVisible();
  await expect.poll(() => [...snapshots.get(page).values()].some(value => value.exampleLabel === 'ПРИМЕР')).toBe(true);
  const snapshot = [...snapshots.get(page).values()].find(value => value.exampleLabel === 'ПРИМЕР');
  expect(snapshot.exampleLabel).toBe('ПРИМЕР');
  expect(snapshot.items).toHaveLength(expectedItems);
  expect(snapshot.territory).toEqual(template.territory);
  expect(snapshot.versions).toHaveLength(1);
  await expect(navigation(page).getByRole('button')).toHaveText([
    'Паспорт', 'Статистика', 'Прогноз', 'Мероприятия', 'Календарь и ресурсы', 'Проверка и экспорт',
  ]);
  return snapshot;
}
async function tab(page, label) {
  await navigation(page).getByRole('button', { name: label, exact: true }).click();
  await expect(navigation(page).getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
}
function pdfText(pdf) {
  const utf8 = new TextDecoder(), utf16 = new TextDecoder('utf-16be');
  const decode = stream => utf8.decode(decodePDFRawStream(stream).decode());
  return pdf.getPages().flatMap(page => {
    const fonts = page.node.Resources().lookup(PDFName.of('Font'), PDFDict);
    const encodings = new Map(fonts.entries().map(([name]) => {
      const charMap = new Map(), font = fonts.lookup(name, PDFDict);
      for (const [, mappings] of decode(font.lookup(PDFName.of('ToUnicode'), PDFRawStream)).matchAll(/beginbfchar\s+([\s\S]*?)endbfchar/gu))
        for (const [, glyph, unicode] of mappings.matchAll(/<([\da-f]{4})>\s*<([\da-f]+)>/giu)) charMap.set(glyph.toUpperCase(), utf16.decode(Buffer.from(unicode, 'hex')));
      return [String(name).slice(1), charMap];
    }));
    const contents = page.node.Contents(), runs = [];
    const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index, PDFRawStream)) : [contents];
    let font;
    for (const stream of streams) for (const [, name, hex] of decode(stream).matchAll(/\/([^\s]+)\s+[-\d.]+\s+Tf|<([\da-f]+)>\s+Tj/giu)) {
      if (name) font = encodings.get(name);
      else if (font) runs.push((hex.match(/.{4}/gu) ?? []).map(glyph => font.get(glyph.toUpperCase()) ?? '').join(''));
    }
    return runs;
  }).join(' ').replace(/\s+/gu, ' ');
}

try {
  console.log('Preparing fresh production CLI with the teacher-only Saransk example');
  server = await launch(); url = server.url; report.url = url;
  const operator = JSON.parse(await readFile(join(directory, 'operator.json'), 'utf8'));
  const status = await (await fetch(server.loopback + '/offline/admin/status', { headers: { Authorization: `Bearer ${operator.hostKey}` } })).json();
  expect(status.counts.accounts).toBe(1); expect(status.counts.sessions).toBe(1);
  report.initialCounts = status.counts;
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--host-resolver-rules=MAP ${host} 127.0.0.1`],
  });
  report.browser = browser.version();
  const instructor = await person('teacher');
  const learner = await person('participant', true);
  await stage('Existing teacher enters without a name prompt and classroom boards start empty', instructor.page, async () => {
    const entered = await enter(instructor.page, 'omnistat@yandex.ru');
    sessionId = entered.session.id;
    expect(entered.session.role).toBe('host');
    await expect(instructor.page.getByRole('region', { name: 'Общий флипчарт', exact: true })).toContainText('Пока нет тезисов');
    await openStage(instructor.page, 'Практики');
    await expect(instructor.page.getByRole('heading', { name: 'Практики ещё не отобраны', exact: true })).toBeVisible();
    await health(instructor.page, 1440);
    await screenshot(instructor.page, 'example-empty-classroom-desktop.png');
  });
  await stage('Teacher opens the fully populated example over exact canonical Saransk geography', instructor.page, async () => {
    const snapshot = await openExample(instructor.page);
    sampleId = snapshot.roadmapId;
    expect(snapshot.canEdit).toBe(true);
    const usedSeries = new Set([...template.factCaptures.map(fact => fact.seriesId),
      ...template.items.filter(item => item.kind === 'scenario').map(item => item.data.seriesId)]);
    expect(snapshot.series.map(series => series.id).sort()).toEqual([...usedSeries].sort());
    expect(snapshot.items.filter(item => item.kind === 'fact')).toHaveLength(template.factCaptures.length);
    expect(snapshot.budget.needCashKopecks).toBeGreaterThan(100000000);
    expect(snapshot.budget.confirmedKopecks).toBe(0);
    expect(snapshot.budget.confirmedGapKopecks).toBe(snapshot.budget.needCashKopecks);
    await expect(passport(instructor.page).getByRole('textbox', { name: 'Название проекта', exact: true })).toHaveValue(title);
    await screenshot(instructor.page, 'example-passport-desktop.png');
    report.sample = { roadmapId: sampleId, itemCount: snapshot.items.length, facts: snapshot.items.filter(item => item.kind === 'fact').length, budget: snapshot.budget };
  });
  await stage('Statistics, forecast, activities, calendar, resources and export are populated', instructor.page, async () => {
    await tab(instructor.page, 'Статистика');
    await expect(instructor.page.getByRole('group', { name: 'Показатели', exact: true })).toBeVisible();
    await expect(roadmap(instructor.page).locator('.rm-chart-panel svg').first()).toBeVisible();
    await screenshot(instructor.page, 'example-statistics-desktop.png');
    await tab(instructor.page, 'Прогноз');
    await expect(instructor.page.getByRole('region', { name: 'Прогноз населения', exact: true })).toBeVisible();
    await expect(instructor.page.getByRole('region', { name: 'Прогноз населения', exact: true }).locator('svg').first()).toBeVisible();
    await screenshot(instructor.page, 'example-forecast-desktop.png');
    await tab(instructor.page, 'Мероприятия');
    await expect(roadmap(instructor.page).locator('.rm-activity-list h4')).toHaveText(chronologicalActivities);
    await screenshot(instructor.page, 'example-activities-desktop.png');
    await tab(instructor.page, 'Календарь и ресурсы');
    await expect(roadmap(instructor.page).getByRole('group', { name: 'Календарь мероприятий', exact: true })).toBeVisible();
    await expect(roadmap(instructor.page).locator('.rm-budget-totals')).toContainText('Неподтверждённая потребность');
    await screenshot(instructor.page, 'example-calendar-desktop.png');
    await tab(instructor.page, 'Проверка и экспорт');
    await expect(roadmap(instructor.page).getByRole('heading', { name: 'Проверка дорожной карты', exact: true })).toBeVisible();
    await health(instructor.page, 1440);
    await screenshot(instructor.page, 'example-review-desktop.png');
  });
  await stage('A second participant can read the same example but cannot edit its passport or forecast', learner.page, async () => {
    const entered = await enter(learner.page, 'example-reader@example.test', 'Участник проверки примера');
    expect(entered.session.id).toBe(sessionId); expect(entered.session.role).toBe('participant');
    const snapshot = await openExample(learner.page);
    expect(snapshot.roadmapId).toBe(sampleId); expect(snapshot.canEdit).toBe(false);
    await expect(passport(learner.page).getByRole('textbox', { name: 'Название проекта', exact: true })).toBeDisabled();
    await tab(learner.page, 'Прогноз');
    await expect(learner.page.getByRole('region', { name: 'Прогноз населения', exact: true }).getByLabel('Конечный год', { exact: true })).toBeDisabled();
    await expect(learner.page.getByRole('region', { name: 'Прогноз населения', exact: true }).getByRole('button', { name: 'Рассчитать', exact: true })).toHaveCount(0);
    await tab(learner.page, 'Мероприятия');
    await expect(roadmap(learner.page).getByRole('button', { name: 'Добавить мероприятие', exact: true })).toHaveCount(0);
    await health(learner.page, 390);
    await screenshot(learner.page, 'example-readonly-mobile-390.png');
  });
  await stage('Participant downloads actual immutable Word and PDF with the complete example', learner.page, async () => {
    await tab(learner.page, 'Проверка и экспорт');
    const wordDownload = learner.page.waitForEvent('download', { timeout: 60000 });
    await learner.page.getByRole('button', { name: 'Скачать последнюю версию Word', exact: true }).click();
    const word = await wordDownload; expect(await word.failure()).toBeNull();
    const docxBytes = await readFile(await word.path());
    expect(docxBytes.subarray(0, 2).toString()).toBe('PK');
    const xml = new TextDecoder().decode(unzipSync(docxBytes)['word/document.xml']);
    for (const expected of ['ПРИМЕР', 'Саранск', 'Демографическая статистика', 'Демографический прогноз']) expect(xml).toContain(expected);
    for (const item of template.items.filter(item => ['activity', 'cost', 'risk'].includes(item.kind))) expect(xml).toContain(item.data.title.replaceAll('&', '&amp;'));
    const activityHeadings = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/gu)]
      .map(([paragraph]) => paragraph)
      .filter(paragraph => /<w:pStyle\s+w:val="Heading2"\s*\/>/u.test(paragraph))
      .map(paragraph => [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)].map(([, text]) => text).join(''))
      .filter(text => chronologicalActivities.includes(text));
    expect(activityHeadings).toEqual(chronologicalActivities);
    await word.saveAs(join(evidence, 'saransk-example.docx'));
    await learner.page.locator('summary').filter({ hasText: /^Шрифт PDF/u }).click();
    await learner.page.getByRole('combobox', { name: 'Шрифт PDF', exact: true }).selectOption('liberation');
    const pdfDownload = learner.page.waitForEvent('download', { timeout: 90000 });
    await learner.page.getByRole('button', { name: 'Скачать PDF', exact: true }).click();
    const pdf = await pdfDownload; expect(await pdf.failure()).toBeNull();
    const pdfBytes = await readFile(await pdf.path());
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    const document = await PDFDocument.load(pdfBytes), printed = pdfText(document);
    for (const expected of ['ПРИМЕР', 'Саранск', 'Демографическая статистика', 'Демографический прогноз']) expect(printed).toContain(expected);
    const activityPositions = chronologicalActivities.map(activity => printed.indexOf(activity));
    expect(activityPositions.every(position => position >= 0)).toBe(true);
    expect(activityPositions).toEqual([...activityPositions].sort((a, b) => a - b));
    expect(document.getPageCount()).toBeGreaterThan(10);
    await pdf.saveAs(join(evidence, 'saransk-example.pdf'));
    report.exports = { docxBytes: docxBytes.length, pdfBytes: pdfBytes.length, pdfPages: document.getPageCount() };
    await screenshot(learner.page, 'example-exports-mobile-390.png');
  });
  await stage('Example is readable without page overflow at 390 and 320 pixels', learner.page, async () => {
    for (const width of [390, 320]) {
      await learner.page.setViewportSize({ width, height: width === 320 ? 740 : 844 });
      await tab(learner.page, 'Паспорт');
      await health(learner.page, width);
      await screenshot(learner.page, `example-passport-mobile-${width}.png`);
      await tab(learner.page, 'Календарь и ресурсы');
      await health(learner.page, width);
      await screenshot(learner.page, `example-resources-mobile-${width}.png`);
    }
  });
  await stage('A normal Saransk team is separate and writable, without changing the example', learner.page, async () => {
    await roadmap(learner.page).getByRole('button', { name: 'К территориям', exact: true }).click();
    const territory = learner.page.getByRole('region', { name: 'Выбор территории', exact: true });
    await territory.getByPlaceholder('Название муниципалитета', { exact: true }).fill('Саранск');
    const joining = rpc(learner.page, 'dw_join_roadmap');
    await territory.getByRole('table').getByRole('button', { name: 'Городской округ Саранск', exact: true }).click();
    const response = await joining; expect(response.status(), await response.text()).toBe(200);
    const normal = await response.json();
    expect(normal.roadmapId).not.toBe(sampleId); expect(normal.exampleLabel).toBeUndefined(); expect(normal.canEdit).toBe(true);
    expect(normal.territory).toEqual(template.territory); expect(normal.items).toHaveLength(3);
    const realTitle = 'Самостоятельный проект обычной команды Саранска';
    await expect(passport(learner.page).getByRole('textbox', { name: 'Название проекта', exact: true })).toBeEnabled();
    await passport(learner.page).getByRole('textbox', { name: 'Название проекта', exact: true }).fill(realTitle);
    const saving = rpc(learner.page, 'dw_save_roadmap_item');
    await tab(learner.page, 'Статистика');
    expect((await saving).status()).toBe(200);
    await roadmap(learner.page).getByRole('button', { name: 'К территориям', exact: true }).click();
    const reading = rpc(learner.page, 'dw_roadmap_snapshot');
    await picker(learner.page).getByRole('button', { name: /^ПРИМЕР · .*Саранск/u }).click();
    const example = await (await reading).json();
    expect(example.roadmapId).toBe(sampleId); expect(example.items).toHaveLength(expectedItems);
    expect(example.items.find(item => item.kind === 'passport').data.title).toBe(title);
    expect(example.canEdit).toBe(false);
    await health(learner.page, 320);
    await screenshot(learner.page, 'example-independent-real-saransk-mobile-320.png');
    report.normalRoadmapId = normal.roadmapId;
  });
  await Promise.all(responseChecks);
  expect(externalRequests).toEqual([]); expect(failedResponses).toEqual([]); expect(errors).toEqual([]);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error.stack;
  if (lastPage) {
    await lastPage.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(join(evidence, 'failure.txt'), await lastPage.locator('body').innerText().catch(() => ''));
  }
  throw error;
} finally {
  Object.assign(report, { errors, failedResponses, externalRequests });
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  if (server) await writeFile(join(evidence, 'production-cli.log'), server.logs());
  await browser?.close(); await server?.stop();
}
