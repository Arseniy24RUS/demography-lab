/** Compiled app + production offline server/PGlite. All participant changes use the rendered UI. */
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openRuntime } from '../../scripts/offline/storage.mjs';
import { startServer } from '../../scripts/offline/server.mjs';

const port = Number(process.env.DW_SHARED_BROWSER_PORT ?? 8895);
const surveyPort = Number(process.env.DW_SHARED_SURVEY_PORT ?? 8896);
const host = '192.168.50.11';
const url = `http://${host}:${port}/`;
const directory = await mkdtemp(join(tmpdir(), 'demography-shared-browser-'));
const evidence = resolve(process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? join(tmpdir(), 'demography-shared-workspace-evidence'));
await mkdir(evidence, { recursive: true });
console.log('Preparing the production offline runtime with the shipped corpus');
const runtime = await openRuntime({ dataDir: directory });
const server = await startServer({ runtime, port, surveyPort, publicHost: host, backupIntervalMs: 0 });
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--host-resolver-rules=MAP ${host} 127.0.0.1`],
});
const errors = [], externalRequests = [], failedResponses = [], steps = [];
const report = {
  version: JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version,
  environment: 'Linux Chromium; compiled application and production offline PGlite; LAN host mapped to loopback; no physical Wi-Fi or macOS claim',
  browser: browser.version(), steps, dataDirectory: directory,
};
let lastPage;
const NAME_A = 'Первый участник мастерской';
const NAME_B = 'Второй участник мастерской';
const PRACTICE = 'Компенсация родительской платы за детский сад';
const FAMILY = 'Доступный уход за детьми';
const navigation = page => page.getByRole('navigation', { name: 'Основная навигация' });
const scenes = page => page.getByRole('navigation', { name: 'Этапы коллективной работы' });
const inspector = page => page.getByRole('complementary', { name: 'Связь цитаты и практики' });
const rpc = (page, name) => page.waitForResponse(response =>
  new URL(response.url()).pathname === `/rest/v1/rpc/${name}` && response.request().method() === 'POST');

function watch(page) {
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
}
async function participant(mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    locale: 'ru-RU', reducedMotion: 'reduce', isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
  await context.route('**/*', async route => {
    const requested = new URL(route.request().url());
    if (['http:', 'https:'].includes(requested.protocol) && !['127.0.0.1', host].includes(requested.hostname)) {
      externalRequests.push(requested.origin); await route.abort('internetdisconnected');
    } else await route.continue();
  });
  const page = await context.newPage(); watch(page);
  return { context, page };
}
async function stage(name, page, work) {
  lastPage = page;
  const start = Date.now();
  await work();
  steps.push({ name, milliseconds: Date.now() - start });
  console.log(`PASS ${name}`);
}
async function screenshot(page, name) {
  await page.screenshot({ path: join(evidence, name), fullPage: false, animations: 'disabled' });
}
async function noOverflow(page, width) {
  const value = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(value.width).toBe(width);
  expect(value.document).toBeLessThanOrEqual(width + 1);
  expect(value.body).toBeLessThanOrEqual(width + 1);
}
async function cleanInterface(page) {
  for (const text of [
    'Изменить ФИО', 'Вы вышли. Чтобы продолжить работу, введите тот же email.',
    'Введите свой email, чтобы открыть занятия и продолжить сохранённую работу.',
    'Используйте тот же email, чтобы продолжить свою работу в следующий раз.',
    'От документа — к общему решению', 'Занятие открыто.', 'Источники и основания',
  ]) await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Пригласить участников|Разрешить присоединение|Закрыть присоединение|Создать занятие|Приостановить занятие|Завершить занятие)$/u })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Ваши занятия', exact: true })).toHaveCount(0);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}
async function enter(page, email, name, fresh = true) {
  await page.goto(url);
  await expect(page).toHaveTitle('Демографическая мастерская — документы и практики');
  const form = page.locator('.session-access-main form');
  await expect(form.locator('input')).toHaveCount(1);
  await cleanInterface(page);
  await page.getByLabel('Email', { exact: true }).fill(email);
  const entering = rpc(page, 'dw_enter_workspace');
  await form.getByRole('button', { name: 'Войти', exact: true }).click();
  if (fresh) {
    await expect(page.getByRole('heading', { name: 'Как к вам обращаться?', exact: true })).toBeVisible();
    await page.getByLabel('Фамилия, имя, отчество', { exact: true }).fill(name);
    await form.getByRole('button', { name: 'Продолжить', exact: true }).click();
  }
  const response = await entering;
  expect(response.status(), await response.text()).toBe(200);
  const snapshot = await response.json();
  expect(snapshot.session.role).toBe('participant');
  await expect(page.locator('.header-account .account-name')).toHaveText(name);
  await expect(scenes(page).getByRole('button', { name: 'Опрос', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Что мешает родительству?', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ответить анонимно', exact: true })).toBeVisible();
  await cleanInterface(page);
  return snapshot.session.id;
}
async function workspace(page) {
  await navigation(page).getByRole('button', { name: 'Мастерская', exact: true }).click();
  await expect(scenes(page)).toBeVisible();
}
async function scene(page, name) {
  await scenes(page).getByRole('button', { name, exact: true }).click();
}
async function barrier(page, title, description) {
  await workspace(page);
  await scene(page, 'Барьеры');
  await page.getByRole('button', { name: 'Добавить барьер', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Добавить барьер', exact: true });
  await editor.getByLabel('Краткое название', { exact: true }).fill(title);
  await editor.getByLabel('Описание и адресат', { exact: true }).fill(description);
  const saving = rpc(page, 'dw_save_barrier');
  await editor.getByRole('button', { name: 'Сохранить барьер', exact: true }).click();
  const response = await saving;
  expect(response.status(), await response.text()).toBe(200);
  await expect(editor).toBeHidden();
  await expect(page.locator('.barrier-card').filter({ hasText: title })).toBeVisible();
}

const a = await participant();
const b = await participant(true);
let sessionId, projector;
try {
  await stage('First participant enters the shared workshop without any teacher, invitation or opening action', a.page, async () => {
    sessionId = await enter(a.page, 'shared-a@example.test', NAME_A);
    await noOverflow(a.page, 1440);
    await screenshot(a.page, 'shared-survey-first-desktop.png');
  });
  await stage('Independent phone participant enters the same workshop and sees the opening survey', b.page, async () => {
    expect(await enter(b.page, 'shared-b@example.test', NAME_B)).toBe(sessionId);
    expect(await b.page.evaluate(() => isSecureContext)).toBe(false);
    await noOverflow(b.page, 390);
    await screenshot(b.page, 'shared-survey-first-mobile.png');
  });
  await stage('FIO itself opens profile editing; explicit save survives reload without extra header text', a.page, async () => {
    await a.page.locator('.header-account .account-name').click();
    const profile = a.page.getByRole('dialog', { name: 'Профиль', exact: true });
    await profile.getByLabel('Фамилия, имя, отчество', { exact: true }).fill(`${NAME_A} — проверено`);
    await profile.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(profile).toBeHidden();
    await a.page.reload();
    await expect(a.page.locator('.header-account .account-name')).toHaveText(`${NAME_A} — проверено`);
    await expect(scenes(a.page)).toBeVisible();
    await cleanInterface(a.page);
  });
  await stage('Regional map allocation by a participant updates independently on the phone', a.page, async () => {
    await scene(a.page, 'Программы');
    await scene(b.page, 'Программы');
    const map = a.page.getByRole('group', { name: 'Карта региональных программ', exact: true });
    await expect(map.getByRole('button')).toHaveCount(89);
    await map.getByRole('button', { name: /^Республика Мордовия:/u }).click();
    const detail = a.page.getByRole('complementary', { name: 'Выбранная программа', exact: true });
    await detail.getByRole('button', { name: 'Взять программу', exact: true }).click();
    await expect(detail).toContainText('В работе');
    await expect(b.page.getByRole('complementary', { name: 'Выбранная программа', exact: true })).toContainText(`${NAME_A} — проверено`);
    await noOverflow(b.page, 390);
    await detail.getByRole('button', { name: 'Открыть документ', exact: true }).click();
  });
  await stage('Full source search and exact quotation lead to the prepared card and a real shared publication', a.page, async () => {
    const reader = a.page.getByRole('region', { name: 'Полный текст программы', exact: true });
    await reader.getByRole('textbox', { name: 'Поиск в полном тексте', exact: true }).fill('компенсация платы');
    await reader.getByRole('button', { name: /^Страница 59\b/u }).first().click();
    await reader.getByRole('button', { name: 'Выбрать фрагмент 604', exact: true }).click();
    await reader.getByRole('button', { name: 'Связать', exact: true }).click();
    await inspector(a.page).getByRole('button', { name: /^Компенсация родительской платы за детский сад.*Есть фрагмент в этой редакции/u }).click();
    await expect(inspector(a.page).getByRole('heading', { name: PRACTICE, exact: true })).toBeVisible();
    await inspector(a.page).getByRole('button', { name: 'Отправить в занятие', exact: true }).click();
    const publication = a.page.getByRole('dialog', { name: 'Отправить практику в занятие', exact: true });
    await publication.getByLabel('Комментарий для обсуждения', { exact: true }).fill('Точная цитата из программы Мордовии; предложение участника общей мастерской.');
    const publishing = rpc(a.page, 'dw_publish_submission');
    await publication.getByRole('button', { name: 'Опубликовать в занятии', exact: true }).click();
    const response = await publishing;
    expect(response.status(), await response.text()).toBe(200);
    const published = await response.json();
    const entry = published.submissions.find(value => value.bundle.practice.title === PRACTICE);
    expect(entry.bundle.occurrences.length).toBeGreaterThan(0);
    expect(entry.bundle.occurrences.some(value => value.anchor.spans.some(span => span.exact.includes('компенсация платы')))).toBe(true);
    await expect(publication).toBeHidden();
    await scene(a.page, 'Практики');
    await scene(b.page, 'Практики');
    await expect(b.page.getByRole('article', { name: PRACTICE, exact: true })).toBeVisible();
  });
  await stage('An ordinary participant creates a family retaining the published source variant', a.page, async () => {
    await scene(a.page, 'Группировка');
    await a.page.getByRole('checkbox', { name: `Выбрать практику «${PRACTICE}»`, exact: true }).check();
    await a.page.getByRole('button', { name: 'Создать семейство', exact: true }).click();
    const editor = a.page.getByRole('dialog', { name: 'Создать семейство практик', exact: true });
    await editor.getByLabel('Название семейства', { exact: true }).fill(FAMILY);
    await editor.getByLabel('Общий механизм', { exact: true }).fill('Возмещение части платы за уход и присмотр в дошкольной организации.');
    await editor.getByLabel('Обоснование объединения', { exact: true }).fill('Сохранены точные условия и цитата региональной программы.');
    const saving = rpc(a.page, 'dw_save_family');
    await editor.getByRole('button', { name: 'Сохранить семейство', exact: true }).click();
    const response = await saving;
    expect(response.status(), await response.text()).toBe(200);
    await expect(editor).toBeHidden();
    await expect(a.page.getByRole('article', { name: FAMILY, exact: true })).toContainText('Региональных вариантов: 1');
    await screenshot(a.page, 'shared-family-participant-desktop.png');
  });
  await stage('Likes, dislikes and withdrawal update on the independent phone without opening a voting round', a.page, async () => {
    await scene(a.page, 'Рейтинг'); await scene(b.page, 'Рейтинг');
    const positiveA = a.page.getByRole('button', { name: `Поддержать: ${FAMILY}`, exact: true });
    const positiveB = b.page.getByRole('button', { name: `Поддержать: ${FAMILY}`, exact: true });
    const negativeA = a.page.getByRole('button', { name: `Не поддержать: ${FAMILY}`, exact: true });
    const negativeB = b.page.getByRole('button', { name: `Не поддержать: ${FAMILY}`, exact: true });
    await positiveA.click();
    await expect(positiveA).toHaveAttribute('aria-pressed', 'true');
    await expect(positiveB).toHaveText('1');
    await negativeB.click();
    await expect(negativeA).toHaveText('1');
    await expect(a.page.getByLabel('Баланс голосов: 0', { exact: true })).toBeVisible();
    await b.page.getByRole('button', { name: `Снять оценку: ${FAMILY}`, exact: true }).click();
    await expect(negativeA).toHaveText('0');
    await expect(a.page.getByLabel('Баланс голосов: 1', { exact: true })).toBeVisible();
    await noOverflow(b.page, 390);
    await screenshot(b.page, 'shared-live-votes-mobile.png');
    await b.page.setViewportSize({ width: 320, height: 800 });
    await noOverflow(b.page, 320);
    await screenshot(b.page, 'shared-live-votes-320.png');
    await b.page.setViewportSize({ width: 390, height: 844 });
  });
  await stage('Public barrier words appear on the projector and update from the second participant', a.page, async () => {
    await barrier(a.page, 'Дорогая аренда жилья', 'Жильё съёмное. Жильё требует больших расходов; трудно планировать семейный бюджет.');
    const popup = a.page.waitForEvent('popup');
    await a.page.getByRole('button', { name: 'Экран проектора', exact: true }).click();
    projector = await popup; watch(projector); lastPage = projector;
    await expect(projector.getByRole('heading', { name: 'Темы общей доски', exact: true })).toBeVisible();
    await expect(projector.getByRole('button', { name: 'жилье: 1 карточка', exact: true })).toBeVisible();
    await barrier(b.page, 'Жильё далеко от работы', 'Долгая дорога затрудняет уход за ребёнком.');
    await expect(projector.getByRole('button', { name: 'жилье: 2 карточки', exact: true })).toBeVisible();
    await projector.getByRole('button', { name: 'жилье: 2 карточки', exact: true }).click();
    await expect(projector.locator('.topic-cloud-cards article')).toHaveCount(2);
    await expect(projector.locator('.topic-cloud-cards')).toContainText('Дорогая аренда жилья');
    await expect(projector.locator('.topic-cloud-cards')).toContainText('Жильё далеко от работы');
    await noOverflow(projector, 1440);
    await screenshot(projector, 'shared-projector-topics-desktop.png');
    await projector.setViewportSize({ width: 390, height: 844 });
    await noOverflow(projector, 390);
    await screenshot(projector, 'shared-projector-topics-mobile.png');
    await projector.setViewportSize({ width: 320, height: 800 });
    await noOverflow(projector, 320);
    await screenshot(projector, 'shared-projector-topics-320.png');
  });
  await stage('Logout is quiet; returning email restores the same current workshop', b.page, async () => {
    await b.page.locator('.header-account').getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(b.page.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
    await cleanInterface(b.page);
    expect(await enter(b.page, 'shared-b@example.test', NAME_B, false)).toBe(sessionId);
    await b.page.setViewportSize({ width: 320, height: 800 });
    await noOverflow(b.page, 320);
    await cleanInterface(b.page);
    await screenshot(b.page, 'shared-survey-first-320.png');
  });
  expect(externalRequests).toEqual([]);
  expect(failedResponses).toEqual([]);
  expect(errors).toEqual([]);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error.stack;
  if (lastPage) {
    await lastPage.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    const body = await lastPage.locator('body').innerText().catch(() => '');
    await writeFile(join(evidence, 'failure.txt'), body);
    console.error(body.slice(0, 9000));
  }
  throw error;
} finally {
  report.externalRequests = externalRequests; report.browserErrors = errors; report.failedResponses = failedResponses;
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.stop();
}
