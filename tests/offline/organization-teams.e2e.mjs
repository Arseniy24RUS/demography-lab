/** Production offline server/PGlite and independent participants; all writes use the UI. */
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { openRuntime } from '../../scripts/offline/storage.mjs';
import { startServer } from '../../scripts/offline/server.mjs';
import { openStage } from './workshop-nav.mjs';

const host = '192.168.50.13';
const port = Number(process.env.DW_ORGANIZATION_BROWSER_PORT ?? 8931);
const surveyPort = Number(process.env.DW_ORGANIZATION_SURVEY_PORT ?? 8932);
const url = `http://${host}:${port}/`;
const directory = await mkdtemp(join(tmpdir(), 'demography-organization-teams-'));
const evidence = resolve(process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? join(tmpdir(), 'demography-organization-teams-evidence'));
await mkdir(evidence, { recursive: true });
console.log('Preparing the production offline runtime for organization teams');
const runtime = await openRuntime({ dataDir: directory });
const server = await startServer({ runtime, port, surveyPort, publicHost: host, backupIntervalMs: 0 });
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--host-resolver-rules=MAP ${host} 127.0.0.1`],
});
const errors = [], warnings = [], failedResponses = [], externalRequests = [], presence = [], checks = [];
const organizationRequests = [], stages = [], screenshots = [];
const watched = new Set();
const report = {
  version: JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version,
  environment: 'Browser plugin not available; regular Playwright Chromium; compiled app and production offline PGlite. LAN hostname maps to loopback; no physical phone or Wi-Fi certification.',
  browser: browser.version(), url, dataDirectory: directory, stages, screenshots,
};
const organization = 'Детский сад «Семья»';
const projectTitle = 'Гибкий график для родителей сотрудников';
const targetGroup = 'Сотрудники организации с детьми дошкольного возраста';
const problem = 'Рабочий график родителей не совпадает со временем работы детского сада.';
const conclusion = 'Согласовать гибкое начало смены и провести пилот внутри организации.';
const activityTitle = 'Пилот гибкого начала рабочего дня';
const technology = 'Корпоративный календарь согласования семейного графика';
const costTitle = 'Обучение руководителей работе с гибким графиком';
const roadmap = page => page.getByRole('region', { name: 'Дорожные карты', exact: true });
const navigation = page => page.getByRole('navigation', { name: 'Разделы дорожной карты', exact: true });
const organizations = page => page.getByRole('region', { name: 'Команды организаций', exact: true });
const passport = page => page.getByRole('form', { name: 'Паспорт проекта', exact: true });
const rpc = (page, name) => {
  const pending = page.waitForResponse(response =>
    new URL(response.url()).pathname === `/rest/v1/rpc/${name}` && response.request().method() === 'POST');
  // A failed UI action must reach the catch/finally evidence path before its response wait expires.
  void pending.catch(() => {});
  return pending;
};
let lastPage, organizationId;

async function participant(name, mobile = false) {
  const context = await browser.newContext({ locale: 'ru-RU', reducedMotion: 'reduce',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile,
  });
  await context.route('**/*', async route => {
    const requested = new URL(route.request().url());
    if (['http:', 'https:'].includes(requested.protocol) && ![host, '127.0.0.1'].includes(requested.hostname)) {
      externalRequests.push(requested.origin);
      await route.abort('internetdisconnected');
    } else await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push({ participant: name, message: error.message }));
  page.on('console', message => {
    if (message.type() === 'error') errors.push({ participant: name, message: message.text() });
    if (message.type() === 'warning') warnings.push({ participant: name, message: message.text() });
  });
  page.on('request', request => {
    if (watched.has(page)) organizationRequests.push({ participant: name, path: new URL(request.url()).pathname });
  });
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400) failedResponses.push({ participant: name, path, status: response.status() });
    if (path === '/rest/v1/rpc/dw_roadmap_presence' && response.status() === 200) checks.push((async () => {
      const payload = await response.json();
      presence.push(...payload.counts.map(item => ({ ...item, participant: name })));
    })());
  });
  return { page, context };
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
  const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(layout.viewport).toBe(width);
  expect(layout.document).toBeLessThanOrEqual(width + 1);
  expect(layout.body).toBeLessThanOrEqual(width + 1);
}
async function enter(page, email, fullName) {
  await page.goto(url);
  const form = page.locator('.session-access-main form');
  await form.getByLabel('Email', { exact: true }).fill(email);
  await form.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByLabel('Фамилия, имя, отчество', { exact: true }).fill(fullName);
  const entering = rpc(page, 'dw_enter_workspace');
  await form.getByRole('button', { name: 'Продолжить', exact: true }).click();
  const response = await entering;
  expect(response.status(), await response.text()).toBe(200);
  const snapshot = await response.json();
  expect(snapshot.session.role).toBe('participant');
  await expect(page.locator('.header-account .account-name')).toHaveText(fullName);
  await openStage(page, 'Дорожная карта');
  await expect(organizations(page)).toBeVisible();
  return snapshot.session.id;
}
async function orgNavigation(page) {
  await expect(navigation(page).getByRole('button')).toHaveText([
    'Паспорт', 'Мероприятия', 'Календарь и ресурсы', 'Проверка и экспорт',
  ]);
  await expect(navigation(page).getByRole('button', { name: 'Статистика', exact: true })).toHaveCount(0);
  await expect(navigation(page).getByRole('button', { name: 'Прогноз', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Прогноз населения', exact: true })).toHaveCount(0);
}
async function tab(page, name) {
  await navigation(page).getByRole('button', { name, exact: true }).click();
  await expect(navigation(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
}
async function backToTeams(page) {
  await roadmap(page).getByRole('button', { name: 'К командам', exact: true }).click();
  await expect(organizations(page)).toBeVisible();
}
async function saveEditor(page, dialog) {
  const saving = rpc(page, 'dw_save_roadmap_item');
  await dialog.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  const response = await saving;
  expect(response.status(), await response.text()).toBe(200);
  await expect(dialog).toBeHidden();
  return response.json();
}
function pdfText(pdf) {
  const utf8 = new TextDecoder(), utf16 = new TextDecoder('utf-16be');
  const decode = stream => utf8.decode(decodePDFRawStream(stream).decode());
  return pdf.getPages().flatMap(page => {
    const fonts = page.node.Resources().lookup(PDFName.of('Font'), PDFDict);
    const encodings = new Map(fonts.entries().map(([name]) => {
      const font = fonts.lookup(name, PDFDict), charMap = new Map();
      const cmap = decode(font.lookup(PDFName.of('ToUnicode'), PDFRawStream));
      for (const [, mappings] of cmap.matchAll(/beginbfchar\s+([\s\S]*?)endbfchar/gu))
        for (const [, glyph, unicode] of mappings.matchAll(/<([\da-f]{4})>\s*<([\da-f]+)>/giu))
          charMap.set(glyph.toUpperCase(), utf16.decode(Buffer.from(unicode, 'hex')));
      return [String(name).slice(1), charMap];
    }));
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index, PDFRawStream)) : [contents];
    const runs = [];
    let font;
    for (const stream of streams)
      for (const [, name, hex] of decode(stream).matchAll(/\/([^\s]+)\s+[-\d.]+\s+Tf|<([\da-f]+)>\s+Tj/giu)) {
        if (name) font = encodings.get(name);
        else if (font) runs.push((hex.match(/.{4}/gu) ?? []).map(glyph => font.get(glyph.toUpperCase()) ?? '').join(''));
      }
    return runs;
  }).join(' ').replace(/\s+/gu, ' ');
}

const a = await participant('first');
const b = await participant('second', true);
try {
  let sessionId;
  await stage('Two normal participants enter one workshop with no teacher setup', a.page, async () => {
    sessionId = await enter(a.page, 'organization-first@example.test', 'Первый участник команды организации');
    expect(await enter(b.page, 'organization-second@example.test', 'Второй участник команды организации')).toBe(sessionId);
    await health(a.page, 1440);
    await health(b.page, 390);
  });
  await stage('A participant creates a named organization and blank names cannot be submitted', a.page, async () => {
    await organizations(a.page).getByRole('button', { name: 'Создать команду организации', exact: true }).click();
    const dialog = a.page.getByRole('dialog', { name: 'Создать команду организации', exact: true });
    const name = dialog.getByRole('textbox', { name: 'Название организации', exact: true });
    await name.fill('   ');
    await expect(dialog.getByRole('button', { name: 'Создать команду', exact: true })).toBeDisabled();
    await name.fill('  Детский   сад «Семья»  ');
    await screenshot(a.page, 'organization-create-desktop.png');
    const creating = rpc(a.page, 'dw_create_organization_roadmap');
    await dialog.getByRole('button', { name: 'Создать команду', exact: true }).click();
    const response = await creating;
    expect(response.status(), await response.text()).toBe(200);
    const snapshot = await response.json();
    organizationId = snapshot.roadmapId;
    expect(snapshot.territory.level).toBe('organization');
    expect(snapshot.territory.name).toBe(organization);
    expect(snapshot.territory.key).toMatch(/^organization:[\da-f-]{36}$/iu);
    expect(snapshot.series).toEqual([]);
    expect(snapshot.canEdit).toBe(true);
    watched.add(a.page);
    await expect(dialog).toBeHidden();
    await expect(passport(a.page)).toBeVisible();
    await orgNavigation(a.page);
  });
  await stage('The second participant sees the shared organization and joins the same roadmap', b.page, async () => {
    await expect(organizations(b.page).getByRole('button', { name: organization, exact: true })).toBeVisible();
    await organizations(b.page).scrollIntoViewIfNeeded();
    await screenshot(b.page, 'organization-shared-list-mobile.png');
    const joining = rpc(b.page, 'dw_join_roadmap');
    await organizations(b.page).getByRole('button', { name: organization, exact: true }).click();
    const response = await joining;
    expect(response.status(), await response.text()).toBe(200);
    expect((await response.json()).roadmapId).toBe(organizationId);
    watched.add(b.page);
    await expect(passport(b.page)).toBeVisible();
    await orgNavigation(b.page);
    await expect.poll(() => presence.some(item => item.roadmapId === organizationId && item.count === 2), { timeout: 20000 }).toBe(true);
    report.activePeopleTogether = 2;
  });
  await stage('Organization passport, dates, resources and manual diagnosis synchronize and survive reload', a.page, async () => {
    await passport(a.page).getByRole('textbox', { name: 'Название проекта', exact: true }).fill(projectTitle);
    await passport(a.page).getByRole('textbox', { name: 'Целевая группа', exact: true }).fill(targetGroup);
    await passport(a.page).getByRole('textbox', { name: 'Цель проекта', exact: true }).fill('До конца 2027 года согласовать удобный рабочий график с десятью семьями сотрудников.');
    await passport(a.page).getByRole('textbox', { name: 'Партнёры', exact: true }).fill('Кадровая служба, руководители подразделений и родители сотрудников');
    await passport(a.page).getByRole('textbox', { name: 'Ожидаемый результат', exact: true }).fill('Не менее десяти семей используют согласованный гибкий график.');
    await passport(a.page).getByLabel('Начало проекта', { exact: true }).fill('2027-01-01');
    await passport(a.page).getByLabel('Окончание проекта', { exact: true }).fill('2027-12-31');
    await passport(a.page).getByRole('textbox', { name: 'Технологический ресурс', exact: true }).fill(technology);
    // Leaving the passport invokes its real autosave flush guard.
    await tab(a.page, 'Мероприятия');
    await expect(passport(b.page).getByRole('textbox', { name: 'Название проекта', exact: true })).toHaveValue(projectTitle);
    await expect(passport(b.page).getByRole('textbox', { name: 'Технологический ресурс', exact: true })).toHaveValue(technology);
    await tab(a.page, 'Паспорт');
    await a.page.getByRole('button', { name: 'Редактировать обоснование', exact: true }).click();
    const editor = a.page.getByRole('dialog', { name: 'Диагноз и приоритет', exact: true });
    await editor.getByRole('textbox', { name: /^Приоритетная проблема/u }).fill(problem);
    await editor.getByRole('textbox', { name: /^Гипотеза о причинах/u }).fill('Фиксированное начало смены не учитывает время сопровождения ребёнка.');
    await editor.getByRole('textbox', { name: /^Вывод для проекта/u }).fill(conclusion);
    await saveEditor(a.page, editor);
    await expect(b.page.getByRole('region', { name: 'Исходная ситуация организации', exact: true })).toContainText(problem);
    await a.page.reload();
    await openStage(a.page, 'Дорожная карта');
    await expect(organizations(a.page)).toBeVisible();
    await organizations(a.page).getByRole('button', { name: organization, exact: true }).click();
    await expect(passport(a.page).getByRole('textbox', { name: 'Название проекта', exact: true })).toHaveValue(projectTitle);
    await expect(a.page.getByRole('region', { name: 'Исходная ситуация организации', exact: true })).toContainText(conclusion);
    await orgNavigation(a.page);
    await a.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await screenshot(a.page, 'organization-passport-desktop.png');
  });
  await stage('Organization teams retain manual activities, calendar and real resource budgets', a.page, async () => {
    await tab(a.page, 'Мероприятия');
    await a.page.getByRole('button', { name: 'Добавить мероприятие', exact: true }).click();
    const activity = a.page.getByRole('dialog', { name: 'Мероприятие', exact: true });
    await activity.getByLabel('Название мероприятия', { exact: true }).fill(activityTitle);
    await activity.getByLabel('Содержание и механизм действия', { exact: true }).fill('Собрать предложения родителей и согласовать индивидуальное начало смены.');
    await activity.getByLabel('Для кого', { exact: true }).fill(targetGroup);
    await activity.getByLabel('Начало мероприятия', { exact: true }).fill('2027-02-01');
    await activity.getByLabel('Окончание мероприятия', { exact: true }).fill('2027-05-31');
    await activity.getByLabel('Ответственный исполнитель', { exact: true }).fill('Руководитель кадровой службы');
    await activity.getByLabel('Проверяемый результат', { exact: true }).fill('Подписаны соглашения о графике для десяти семей.');
    await activity.getByRole('combobox', { name: /^Уровень полномочий/u }).selectOption('organization');
    await saveEditor(a.page, activity);
    await tab(b.page, 'Мероприятия');
    await expect(b.page.getByRole('heading', { name: activityTitle, exact: true })).toBeVisible();
    await tab(a.page, 'Календарь и ресурсы');
    await expect(a.page.getByRole('heading', { name: 'Календарь проекта', exact: true })).toBeVisible();
    await expect(a.page.locator('.rm-resources')).toContainText(activityTitle);
    await a.page.getByRole('button', { name: 'Добавить затраты', exact: true }).click();
    const cost = a.page.getByRole('dialog', { name: 'Статья затрат', exact: true });
    await cost.getByRole('combobox', { name: /^Мероприятие/u }).selectOption({ label: activityTitle });
    await cost.getByLabel('Статья затрат', { exact: true }).fill(costTitle);
    await cost.getByLabel('Год расходов', { exact: true }).fill('2027');
    await cost.getByLabel('Единица расчёта', { exact: true }).fill('занятие');
    await cost.getByLabel(/^Количество/u).fill('4');
    await cost.getByLabel('Стоимость единицы, ₽', { exact: true }).fill('1000');
    await cost.getByLabel('Число повторений / периодов', { exact: true }).fill('1');
    const saved = await saveEditor(a.page, cost);
    expect(saved.budget.needCashKopecks).toBe(400000);
    await expect(a.page.getByRole('rowheader').filter({ hasText: costTitle })).toBeVisible();
    await a.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await health(a.page, 1440);
    await screenshot(a.page, 'organization-calendar-desktop.png');
  });
  await stage('Organization exports preserve manual project content and omit demographic statistics and forecasts', a.page, async () => {
    await tab(a.page, 'Проверка и экспорт');
    await a.page.locator('summary').filter({ hasText: /^Разделы документа/u }).click();
    const sections = a.page.getByRole('group', { name: 'Разделы для экспорта', exact: true });
    await expect(sections.getByRole('checkbox')).toHaveCount(9);
    await expect(sections.getByRole('checkbox', { name: 'Демографическая статистика', exact: true })).toHaveCount(0);
    await expect(sections.getByRole('checkbox', { name: 'Демографический прогноз', exact: true })).toHaveCount(0);
    await expect(sections.getByRole('checkbox', { name: 'Проблемы и обоснование мер', exact: true })).toBeChecked();
    await expect(a.page.getByRole('button', { name: 'Открыть прогноз', exact: true })).toHaveCount(0);
    await expect(a.page.getByText('Факты с периодом, единицей и источником', { exact: true })).toHaveCount(0);
    const wordDownload = a.page.waitForEvent('download', { timeout: 30000 });
    await a.page.getByRole('button', { name: 'Скачать Word', exact: true }).click();
    const wordFile = await wordDownload;
    expect(await wordFile.failure()).toBeNull();
    const wordBytes = await readFile(await wordFile.path());
    expect(wordBytes.subarray(0, 2).toString()).toBe('PK');
    const parts = unzipSync(wordBytes);
    const word = new TextDecoder().decode(parts['word/document.xml']);
    for (const text of [organization, projectTitle, targetGroup, problem, conclusion, activityTitle, technology, costTitle]) expect(word).toContain(text);
    for (const omitted of ['Демографическая статистика', 'Демографический прогноз', 'Прогноз численности населения']) expect(word).not.toContain(omitted);
    await wordFile.saveAs(join(evidence, 'organization-roadmap.docx'));
    await a.page.locator('summary').filter({ hasText: /^Шрифт PDF/u }).click();
    await a.page.getByRole('combobox', { name: 'Шрифт PDF', exact: true }).selectOption('liberation');
    const pdfDownload = a.page.waitForEvent('download', { timeout: 30000 });
    await a.page.getByRole('button', { name: 'Скачать PDF', exact: true }).click();
    const pdfFile = await pdfDownload;
    expect(await pdfFile.failure()).toBeNull();
    const pdfBytes = await readFile(await pdfFile.path());
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    const pdf = await PDFDocument.load(pdfBytes);
    const printed = pdfText(pdf);
    for (const text of [organization, projectTitle, targetGroup, problem, activityTitle, costTitle]) expect(printed).toContain(text);
    for (const omitted of ['Демографическая статистика', 'Демографический прогноз', 'Прогноз численности населения']) expect(printed).not.toContain(omitted);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    await pdfFile.saveAs(join(evidence, 'organization-roadmap.pdf'));
    report.exports = { docxBytes: wordBytes.length, pdfBytes: pdfBytes.length, pdfPages: pdf.getPageCount() };
    await a.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await screenshot(a.page, 'organization-export-options-desktop.png');
  });
  await stage('Organization project and shared team picker remain usable at 390 and 320 pixels', b.page, async () => {
    await tab(b.page, 'Паспорт');
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }]) {
      await b.page.setViewportSize(viewport);
      await orgNavigation(b.page);
      await b.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await health(b.page, viewport.width);
      await screenshot(b.page, `organization-passport-mobile-${viewport.width}.png`);
      await backToTeams(b.page);
      const row = organizations(b.page).getByRole('row').filter({ has: b.page.getByRole('button', { name: organization, exact: true }) });
      await expect(row.getByRole('cell')).toHaveText('1');
      await organizations(b.page).scrollIntoViewIfNeeded();
      await health(b.page, viewport.width);
      await screenshot(b.page, `organization-team-picker-mobile-${viewport.width}.png`);
      await organizations(b.page).getByRole('button', { name: organization, exact: true }).click();
      await expect(passport(b.page)).toBeVisible();
    }
  });
  await stage('Returning to a municipality preserves its statistics and forecast workflow', a.page, async () => {
    watched.delete(a.page);
    await backToTeams(a.page);
    const territories = a.page.getByRole('region', { name: 'Выбор территории', exact: true });
    await territories.getByPlaceholder('Название муниципалитета', { exact: true }).fill('Саранск');
    const city = territories.getByRole('table').getByRole('button', { name: 'Городской округ Саранск', exact: true });
    await expect(city).toBeEnabled();
    const joining = rpc(a.page, 'dw_join_roadmap');
    await city.click();
    const response = await joining;
    expect(response.status(), await response.text()).toBe(200);
    expect((await response.json()).territory.level).toBe('municipality');
    await expect(navigation(a.page).getByRole('button', { name: 'Статистика', exact: true })).toBeVisible();
    await expect(navigation(a.page).getByRole('button', { name: 'Прогноз', exact: true })).toBeVisible();
    await tab(a.page, 'Статистика');
    await expect(a.page.getByRole('group', { name: 'Показатели', exact: true })).toBeVisible();
    await tab(a.page, 'Прогноз');
    await expect(a.page.getByRole('region', { name: 'Прогноз населения', exact: true })).toBeVisible();
    await health(a.page, 1440);
    await screenshot(a.page, 'municipal-forecast-preserved.png');
  });
  await Promise.all(checks);
  const forbiddenData = organizationRequests.filter(({ path }) => /\/data\/(?:factors|demography|cohort)\/|\/data\/territories\/.*(?:series|statistics)/u.test(path));
  expect(forbiddenData).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(failedResponses).toEqual([]);
  expect(errors).toEqual([]);
  report.organizationId = organizationId;
  report.forbiddenOrganizationDataRequests = forbiddenData;
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.error = error.stack;
  if (lastPage) {
    await lastPage.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(join(evidence, 'failure.txt'), await lastPage.locator('body').innerText().catch(() => ''));
  }
  throw error;
} finally {
  Object.assign(report, { errors, warnings, failedResponses, externalRequests, presence, organizationRequests });
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.stop();
}
