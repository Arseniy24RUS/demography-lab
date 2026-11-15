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
const errors = [], externalRequests = [], failedResponses = [], invitationRequests = [], steps = [];
const report = {
  version: JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version,
  environment: 'Linux Chromium; compiled application and production offline PGlite; LAN host mapped to loopback; no physical Wi-Fi or macOS claim',
  browser: browser.version(), steps, dataDirectory: directory,
};
let lastPage;
const NAME_A = 'Первый участник мастерской';
const NAME_B = 'Второй участник мастерской';
const NAME_TEACHER = 'Преподаватель общей мастерской';
const PRACTICE = 'Компенсация родительской платы за детский сад';
const FAMILY = 'Доступный уход за детьми';
const RENT_BARRIER = 'Дорогая аренда жилья. Съёмное жильё недоступно многим семьям.';
const ARDATOV = 'Ардатовский муниципальный район';
const LINKED_BARRIER = 'Нестабильный график работы';
const LINKED_MEASURE = 'Гибкий график для родителей';
const RANKED_FAMILY = 'Региональный материнский (семейный) капитал';
const navigation = page => page.getByRole('navigation', { name: 'Основная навигация' });
const scenes = page => page.getByRole('navigation', { name: 'Этапы коллективной работы' });
const roadmapNav = page => page.getByRole('navigation', { name: 'Разделы дорожной карты', exact: true });
const inspector = page => page.getByRole('complementary', { name: 'Связь цитаты и практики' });
const rpc = (page, name) => page.waitForResponse(response =>
  new URL(response.url()).pathname === `/rest/v1/rpc/${name}` && response.request().method() === 'POST');

function watch(page) {
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/rest/v1/rpc/dw_invitation') invitationRequests.push(request.url());
  });
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
    'Обновляется автоматически', 'Республика Мордовия · Муниципальный уровень',
  ]) await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('heading', { name: 'Демографическая мастерская', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Работать с документами', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Экран проектора', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Пригласить участников|Разрешить присоединение|Закрыть присоединение|Создать занятие|Приостановить занятие|Завершить занятие)$/u })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Ваши занятия', exact: true })).toHaveCount(0);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}
async function enter(page, email, name, fresh = true, role = 'participant') {
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
  expect(snapshot.session.role).toBe(role);
  await expect(page.locator('.header-account .account-name')).toHaveText(name);
  await expect(scenes(page).getByRole('button', { name: 'Субъективные факторы', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: 'Общий флипчарт', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ответить анонимно', exact: true })).toHaveCount(0);
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
async function joinRoadmap(page) {
  await scene(page, 'Дорожные карты');
  const territories = page.getByRole('region', { name: 'Выбор территории', exact: true });
  await territories.getByRole('table').getByRole('button', { name: ARDATOV, exact: true }).click();
  await expect(roadmapNav(page).getByRole('button', { name: 'Паспорт', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('form', { name: 'Паспорт проекта', exact: true })).toBeVisible();
}
async function roadmapTab(page, name) {
  await roadmapNav(page).getByRole('button', { name, exact: true }).click();
}
async function barrier(page, title) {
  await workspace(page);
  await scene(page, 'Барьеры');
  await page.getByRole('button', { name: 'Добавить барьер', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Добавить барьер', exact: true });
  await editor.getByLabel('Текст барьера', { exact: true }).fill(title);
  await editor.getByRole('checkbox', { name: 'Работа', exact: true }).check();
  const saving = rpc(page, 'dw_save_barrier');
  await editor.getByRole('button', { name: 'Сохранить барьер', exact: true }).click();
  const response = await saving;
  expect(response.status(), await response.text()).toBe(200);
  await expect(editor).toBeHidden();
  await expect(page.getByRole('article', { name: title, exact: true })).toBeVisible();
}

const a = await participant();
const b = await participant(true);
let sessionId, projector;
try {
  await stage('First participant enters the shared workshop without any teacher, invitation or opening action', a.page, async () => {
    sessionId = await enter(a.page, 'shared-a@example.test', NAME_A);
    await noOverflow(a.page, 1440);
    await screenshot(a.page, 'shared-flipchart-first-desktop.png');
  });
  await stage('Independent phone participant enters the same workshop and sees the opening flipchart', b.page, async () => {
    expect(await enter(b.page, 'shared-b@example.test', NAME_B)).toBe(sessionId);
    expect(await b.page.evaluate(() => isSecureContext)).toBe(false);
    await noOverflow(b.page, 390);
    await screenshot(b.page, 'shared-flipchart-first-mobile.png');
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
  await stage('Map and list open regional cards first and mark missing programme texts', a.page, async () => {
    await scene(a.page, 'Программы');
    await scene(b.page, 'Программы');
    const map = a.page.getByRole('group', { name: 'Карта региональных программ', exact: true });
    await expect(map.locator('[data-region-id]')).toHaveCount(89);
    const layer = a.page.getByRole('region', { name: 'Карта программ', exact: true });
    const lengths = () => map.locator('[data-region-id="moskva"] path, [data-region-id="respublika-ingushetiia"] path')
      .evaluateAll(paths => paths.map(path => path.getAttribute('d').length));
    const overviewLengths = await lengths();
    expect(overviewLengths).toHaveLength(2);
    const detailed = a.page.waitForResponse(response => new URL(response.url()).pathname === '/data/regions.detail.map.json');
    const zoom = layer.getByRole('button', { name: 'Приблизить карту', exact: true });
    await zoom.click();
    await zoom.click();
    expect((await detailed).status()).toBe(200);
    await expect.poll(async () => (await lengths()).every((length, i) => length > overviewLengths[i] * 3)).toBe(true);
    await layer.getByRole('button', { name: 'Показать всю карту', exact: true }).click();
    await expect.poll(lengths).toEqual(overviewLengths);
    const catalogue = page => page.getByRole('region', { name: 'Каталог мер', exact: true });
    const moscow = map.locator('[data-region-id="moskva"]');
    await expect(moscow).toHaveAttribute('data-document', 'unavailable');
    await expect(moscow.locator('path').first()).toHaveAttribute('fill', /^url\(#.+\)$/u);
    const moscowRow = a.page.getByRole('group', { name: 'Выбрать программу по названию' }).locator('[data-region-id="moskva"]');
    await expect(moscowRow).toHaveAttribute('data-document', 'unavailable');
    await expect(moscowRow).toHaveCSS('background-image', /^repeating-linear-gradient/u);
    await moscow.press('Enter');
    await expect(catalogue(a.page).getByRole('combobox', { name: 'Территория меры' })).toHaveValue('moskva');
    await expect(catalogue(a.page).getByRole('button', { name: 'Текст программы' })).toHaveCount(0);
    const selecting = rpc(a.page, 'dw_select_catalog_practice');
    await catalogue(a.page).getByRole('button', { name: 'Отобрать меру' }).first().click();
    expect((await selecting).status()).toBe(200);
    await a.page.getByRole('button', { name: 'К карте и списку программ' }).click();
    await expect(moscow).toHaveAttribute('data-measures', 'selected');
    await expect(moscow.locator('path').first()).toHaveAttribute('fill', /-selected\)$/u);
    await expect(moscowRow).toHaveCSS('background-image', /^repeating-linear-gradient/u);

    await map.getByRole('button', { name: /^Республика Мордовия:/u }).click();
    const reader = page => page.getByRole('region', { name: 'Полный текст программы', exact: true });
    await expect(catalogue(a.page).getByRole('combobox', { name: 'Территория меры' })).toHaveValue('respublika-mordoviia');
    await expect(reader(a.page)).toHaveCount(0);
    await catalogue(a.page).getByRole('button', { name: 'Текст программы' }).click();
    await expect(reader(a.page)).toBeVisible();
    const search = b.page.getByRole('searchbox', { name: 'Найти регион' });
    await search.fill('Мордовия');
    const list = b.page.getByRole('group', { name: 'Выбрать программу по названию' });
    await list.getByRole('button', { name: 'Республика Мордовия', exact: true }).click();
    await expect(catalogue(b.page).getByRole('combobox', { name: 'Территория меры' })).toHaveValue('respublika-mordoviia');
    await expect(reader(b.page)).toHaveCount(0);
    await catalogue(b.page).getByRole('button', { name: 'Текст программы' }).click();
    await expect(reader(b.page)).toBeVisible();
    await b.page.getByRole('button', { name: 'К карточкам', exact: true }).click();
    await expect(catalogue(b.page).getByRole('combobox', { name: 'Территория меры' })).toHaveValue('respublika-mordoviia');
    await b.page.getByRole('button', { name: 'К карте и списку программ' }).click();
    await expect(search).toHaveValue('Мордовия');
    await expect(list.getByRole('button', { name: 'Республика Мордовия', exact: true })).toHaveAttribute('data-measures', 'unselected');
    await noOverflow(b.page, 390);
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
    await expect(reader).toBeVisible();
    const list = b.page.getByRole('group', { name: 'Выбрать программу по названию' });
    await expect(list.getByRole('button', { name: /Республика Мордовия.*меры отобраны/u })).toHaveAttribute('data-measures', 'selected');
    await expect(b.page.getByRole('group', { name: 'Карта региональных программ', exact: true })
      .locator('[data-region-id="respublika-mordoviia"]')).toHaveAttribute('data-measures', 'selected');
    await a.page.getByRole('button', { name: 'К карточкам', exact: true }).click();
    await expect(scenes(a.page).getByRole('button', { name: 'Программы', exact: true })).toHaveAttribute('aria-current', 'page');
    await scene(a.page, 'Практики');
    await scene(b.page, 'Практики');
    await expect(a.page.getByRole('region', { name: 'Рейтинг практик', exact: true })).toBeVisible();
    await expect(scenes(a.page).getByRole('button', { name: 'Рейтинг', exact: true })).toHaveCount(0);
    await expect(scenes(a.page).getByRole('button', { name: 'Группировка', exact: true })).toHaveCount(0);
    for (const page of [a.page, b.page]) await page.getByRole('button', { name: 'Опубликованные карточки', exact: true }).click();
    await expect(b.page.getByRole('article', { name: PRACTICE, exact: true })).toBeVisible();
  });
  await stage('An ordinary participant sends a publication to the rating and edits its group when needed', a.page, async () => {
    const publication = a.page.getByRole('article', { name: PRACTICE, exact: true });
    const adding = rpc(a.page, 'dw_save_family');
    await publication.getByRole('button', { name: 'В рейтинг', exact: true }).click();
    const added = await adding;
    expect(added.status(), await added.text()).toBe(200);
    await expect(publication.getByText('В рейтинге', { exact: true })).toBeVisible();
    await expect(b.page.getByRole('article', { name: PRACTICE, exact: true }).getByText('В рейтинге', { exact: true })).toBeVisible();
    await a.page.getByRole('button', { name: 'Настроить группы', exact: true }).click();
    await expect(scenes(a.page).getByRole('button', { name: 'Практики', exact: true })).toHaveAttribute('aria-current', 'page');
    const family = a.page.getByRole('article', { name: PRACTICE, exact: true });
    const expand = family.getByRole('button', { name: /Региональных вариантов: 1/u });
    if ((await expand.getAttribute('aria-expanded')) === 'false') await expand.click();
    await family.getByRole('button', { name: `Редактировать семейство «${PRACTICE}»`, exact: true }).click();
    const editor = a.page.getByRole('dialog', { name: 'Редактировать семейство', exact: true });
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
    await scene(a.page, 'Практики'); await scene(b.page, 'Практики');
    const positiveA = a.page.getByRole('button', { name: `Поддержать: ${FAMILY}`, exact: true });
    const positiveB = b.page.getByRole('button', { name: `Поддержать: ${FAMILY}`, exact: true });
    const negativeA = a.page.getByRole('button', { name: `Не поддержать: ${FAMILY}`, exact: true });
    const negativeB = b.page.getByRole('button', { name: `Не поддержать: ${FAMILY}`, exact: true });
    await positiveA.click();
    await expect(positiveA).toHaveAttribute('aria-pressed', 'true');
    await expect(positiveB).toHaveText('1');
    await negativeB.click();
    await expect(negativeA).toHaveText('1');
    await expect(a.page.getByRole('article', { name: FAMILY, exact: true })
      .getByLabel('Баланс голосов: 0', { exact: true })).toBeVisible();
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
    await barrier(a.page, RENT_BARRIER);
    projector = await a.page.context().newPage(); watch(projector); lastPage = projector;
    await projector.goto(`${url}#sessions=1&projector=1`);
    await expect(projector.getByRole('region', { name: 'Флипчарт на проекторе', exact: true })).toBeVisible();
    await projector.getByRole('button', { name: 'Темы', exact: true }).click();
    await expect(projector.getByRole('heading', { name: 'Темы общей доски', exact: true })).toBeVisible();
    await expect(projector.getByRole('button', { name: 'жилье: 1 карточка', exact: true })).toBeVisible();
    await barrier(b.page, 'Жильё далеко от работы');
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
    await screenshot(b.page, 'shared-flipchart-first-320.png');
  });
  const teacher = await participant();
  await stage('Teacher enters the existing common board and synchronizes without obsolete invitations', teacher.page, async () => {
    expect(await enter(teacher.page, 'omnistat@yandex.ru', NAME_TEACHER, true, 'host')).toBe(sessionId);
    await expect(teacher.page.locator('.header-account').getByText('Преподаватель', { exact: true })).toBeVisible();
    const settings = teacher.page.getByRole('banner').getByRole('button', { name: 'Параметры мастерской', exact: true });
    await settings.click();
    const settingsDialog = teacher.page.getByRole('dialog', { name: 'Параметры мастерской', exact: true });
    await expect(settingsDialog.getByRole('button', { name: 'Сохранить параметры', exact: true })).toBeEnabled();
    await settingsDialog.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(settingsDialog).toBeHidden();
    await expect(settings).toBeFocused();
    await teacher.page.setViewportSize({ width: 390, height: 844 });
    await expect(settings).toBeVisible();
    await noOverflow(teacher.page, 390);
    await teacher.page.setViewportSize({ width: 1440, height: 1000 });
    // Observe two normal reconciliation polls so the unchanged-cursor host path runs as well.
    for (let poll = 0; poll < 2; poll += 1) {
      const response = await rpc(teacher.page, 'dw_session_cursor');
      expect(response.status(), await response.text()).toBe(200);
    }
    await expect(teacher.page.getByRole('alert')).toHaveCount(0);
    await expect(teacher.page.locator('[data-tone="error"]')).toHaveCount(0);
    expect(invitationRequests).toEqual([]);
    await screenshot(teacher.page, 'shared-teacher-first-flipchart.png');
    await scene(teacher.page, 'Практики');
    await teacher.page.getByRole('button', { name: 'Опубликованные карточки', exact: true }).click();
    const publication = teacher.page.getByRole('article', { name: PRACTICE, exact: true });
    await expect(publication).toBeVisible();
    // A profile edit emits a session change and exercises the changed-cursor host path.
    const updatedAuthor = `${NAME_A} — обновлено преподавателю`;
    await a.page.locator('.header-account .account-name').click();
    const profile = a.page.getByRole('dialog', { name: 'Профиль', exact: true });
    await profile.getByLabel('Фамилия, имя, отчество', { exact: true }).fill(updatedAuthor);
    await profile.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(profile).toBeHidden();
    await expect(publication).toContainText(updatedAuthor);
    await expect(teacher.page.getByRole('alert')).toHaveCount(0);
    await expect(teacher.page.locator('[data-tone="error"]')).toHaveCount(0);
    expect(invitationRequests).toEqual([]);
    await cleanInterface(teacher.page);
    await noOverflow(teacher.page, 1440);
    await screenshot(teacher.page, 'shared-teacher-live-board.png');
  });
  await stage('Regional and federal catalogue selections reach one shared rating with intact variants', a.page, async () => {
    const catalogue = page => page.getByRole('region', { name: 'Каталог мер', exact: true });
    const ranking = page => page.getByRole('region', { name: 'Рейтинг практик', exact: true });
    const familyName = RANKED_FAMILY;
    const amur = 'Региональный материнский капитал при рождении второго ребёнка (Амурская область)';
    const arkhangelsk = 'Региональный материнский (семейный) капитал (Архангельская область)';
    const federal = 'Декретные выплаты для ИП и самозанятых';
    const measures = JSON.parse(await readFile(new URL('../../public/data/corpus/family-catalog.json', import.meta.url), 'utf8')).measures;
    const total = new RegExp(measures.length.toLocaleString('ru').replace(/\s+/gu, '\\s*'), 'u');

    await navigation(a.page).getByRole('button', { name: 'Практики', exact: true }).click();
    await expect(a.page.getByText(new RegExp(`${total.source} карточки каталога`, 'u'))).toBeVisible();
    for (const page of [a.page, b.page]) {
      await workspace(page);
      await scene(page, 'Программы');
      await page.getByRole('button', { name: 'Каталог мер', exact: true }).click();
      await expect(catalogue(page).getByRole('status')).toContainText(total);
    }

    async function findCard(page, territory, title) {
      await catalogue(page).getByRole('combobox', { name: 'Территория меры' }).selectOption({ label: territory });
      await catalogue(page).getByRole('searchbox', { name: 'Поиск мер' }).fill(title);
      return catalogue(page).getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    }
    async function select(page, card) {
      const pending = rpc(page, 'dw_select_catalog_practice');
      await card.getByRole('button', { name: 'Отобрать меру' }).click();
      const response = await pending;
      expect(response.status(), await response.text()).toBe(200);
      await expect(card.getByRole('button', { name: 'Мера отобрана' })).toHaveAttribute('aria-pressed', 'true');
    }

    await select(a.page, await findCard(a.page, 'Амурская область', amur));
    const sharedCard = await findCard(b.page, 'Амурская область', amur);
    await expect(sharedCard.getByRole('button', { name: 'Мера отобрана' })).toBeVisible();
    await select(b.page, await findCard(b.page, 'Архангельская область', arkhangelsk));
    await select(a.page, await findCard(a.page, 'Федеральные меры', federal));
    for (const page of [a.page, b.page]) await scene(page, 'Практики');

    const group = ranking(a.page).getByRole('article', { name: familyName, exact: true });
    await expect(group).toHaveCount(1);
    await expect(ranking(a.page).getByRole('article', { name: federal, exact: true })).toBeVisible();
    await group.getByText('Варианты мер · 2', { exact: true }).click();
    await expect(group).toContainText(amur);
    await expect(group).toContainText('30 % от федерального материнского капитала');
    await expect(group).toContainText(arkhangelsk);
    await expect(group).toContainText('124 608,81 ₽ (индексируется ежегодно)');
    await group.getByRole('button', { name: 'Подробности варианта' }).first().click();
    const details = a.page.getByRole('dialog');
    await expect(details.getByRole('region', { name: 'Источник карточки' })).toBeVisible();
    await details.getByRole('button', { name: 'Закрыть окно', exact: true }).click();

    await group.getByRole('button', { name: `Поддержать: ${familyName}`, exact: true }).click();
    const otherGroup = ranking(b.page).getByRole('article', { name: familyName, exact: true });
    await expect(otherGroup.getByRole('button', { name: `Поддержать: ${familyName}`, exact: true })).toHaveText('1');
    await noOverflow(b.page, 320);
    await b.page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(b.page, 390);
    await screenshot(a.page, 'family-catalog-shared-ranking.png');
  });
  await stage('One barrier spans several life stages and keeps reusable links and both gap lists', a.page, async () => {
    const red = LINKED_BARRIER;
    const green = LINKED_MEASURE;
    const unusedGreen = 'Прокат семейных велосипедов';
    const authored = 'Дежурная группа для детей сотрудников';
    const oldBarrier = RENT_BARRIER;
    const rankedFamily = RANKED_FAMILY;
    const lifecycle = page => page.getByRole('region', { name: 'Барьеры по этапам жизни', exact: true });
    const solutions = page => page.getByRole('region', { name: 'Решения', exact: true });

    async function sticker(page, type, text) {
      await scene(page, 'Субъективные факторы');
      const form = page.getByRole('form', { name: 'Новый тезис', exact: true });
      await form.getByRole('button', { name: type, exact: true }).click();
      await form.getByRole('textbox', { name: 'Короткий тезис', exact: true }).fill(text);
      const pending = rpc(page, 'dw_flipchart_add');
      await form.getByRole('button', { name: 'Добавить', exact: true }).click();
      expect((await pending).status()).toBe(200);
    }
    async function importBarrier(page, stages) {
      await scene(page, 'Барьеры');
      await expect(lifecycle(page).getByRole('tablist')).toHaveCount(0);
      await lifecycle(page).getByRole('button', { name: 'Добавить барьер', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Добавить барьер', exact: true });
      await dialog.getByLabel('Источник барьера').selectOption('subjective');
      await dialog.getByRole('radio', { name: red, exact: true }).check();
      for (const stage of stages) await dialog.getByRole('checkbox', { name: stage, exact: true }).check();
      const pending = rpc(page, 'dw_import_flipchart_barrier');
      await dialog.getByRole('button', { name: 'Сохранить барьер', exact: true }).click();
      expect((await pending).status()).toBe(200);
      await expect(dialog).toBeHidden();
    }
    async function connect(page, barrierTitle, measure, method) {
      const row = solutions(page).locator('.solutions-barrier')
        .filter({ has: page.getByRole('heading', { name: barrierTitle, exact: true }) });
      await row.getByRole('button', { name: 'Связать с мерой', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Связать с мерой', exact: true });
      await dialog.getByRole('searchbox', { name: 'Найти меру', exact: true }).fill(measure);
      const pending = rpc(page, method);
      await dialog.getByRole('button', { name: `Связать: ${measure}`, exact: true }).click();
      expect((await pending).status()).toBe(200);
      await expect(dialog).toBeHidden();
      await expect(row.getByRole('list', { name: 'Связанные меры', exact: true })).toContainText(measure);
    }

    await sticker(a.page, 'Что мешает?', red);
    await sticker(b.page, 'Что помогло бы?', green);
    await sticker(b.page, 'Что помогло бы?', unusedGreen);
    await importBarrier(a.page, ['Работа', 'Первый ребёнок']);
    await importBarrier(b.page, ['Второй ребёнок']);
    const imported = lifecycle(a.page).getByRole('article', { name: red, exact: true });
    await expect(imported).toHaveCount(1);
    await expect(imported).toContainText('Второй ребёнок');
    await expect(lifecycle(a.page).getByRole('list', { name: 'Этапы, связанные с первым ребёнком' })).toContainText('Зачатие');
    const search = lifecycle(a.page).getByRole('searchbox', { name: 'Поиск по барьерам' });
    await search.fill(red);
    await expect(lifecycle(a.page).getByRole('article')).toHaveCount(1);
    const barrierVote = rpc(a.page, 'dw_barrier_vote');
    await imported.getByRole('button', { name: 'Значимый барьер: 0', exact: true }).click();
    expect((await barrierVote).status()).toBe(200);
    await expect(lifecycle(b.page).getByRole('article', { name: red, exact: true })
      .getByRole('button', { name: 'Значимый барьер: 1', exact: true })).toBeVisible();
    await search.clear();
    await noOverflow(b.page, 390);
    await screenshot(a.page, 'barriers-stickers-desktop.png');
    await screenshot(b.page, 'barriers-stickers-mobile.png');

    const steps = await scenes(a.page).getByRole('button').allTextContents();
    expect(steps.map(name => name.trim()).slice(-3)).toEqual(['Практики', 'Решения', 'Дорожные карты']);
    await scene(a.page, 'Решения');
    await expect(solutions(a.page).getByRole('region', { name: 'Барьеры без решений' })).toContainText(red);
    await expect(solutions(a.page).getByRole('region', { name: 'Меры без связей' })).toContainText(green);
    await connect(a.page, red, rankedFamily, 'dw_save_barrier_link');
    await connect(a.page, red, green, 'dw_set_solution_barrier');
    await connect(a.page, oldBarrier, green, 'dw_set_solution_barrier');
    await expect(solutions(a.page).getByRole('region', { name: 'Барьеры без решений' })).not.toContainText(red);
    await expect(solutions(a.page).getByRole('region', { name: 'Меры без связей' })).toContainText(unusedGreen);

    await scene(b.page, 'Решения');
    await solutions(b.page).getByRole('button', { name: 'Второй ребёнок', exact: true }).click();
    await expect(solutions(b.page).getByRole('region', { name: 'Второй ребёнок', exact: true })).toContainText(green);
    await expect(solutions(b.page).getByRole('region', { name: 'Второй ребёнок', exact: true })).toContainText(rankedFamily);
    const unused = solutions(b.page).getByRole('region', { name: 'Меры без связей' });
    await unused.getByRole('button', { name: 'Предложить меру', exact: true }).click();
    const authorForm = b.page.getByRole('dialog', { name: 'Предложить меру', exact: true });
    await authorForm.getByLabel('Название меры', { exact: true }).fill(authored);
    const saved = rpc(b.page, 'dw_save_solution');
    await authorForm.getByRole('button', { name: 'Сохранить меру', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(unused).toContainText(authored);
    await noOverflow(b.page, 390);
    await screenshot(a.page, 'shared-lifecycle-solutions.png');
  });
  await stage('Joining a territory opens its passport and SMART self-checks reach another team member', a.page, async () => {
    await joinRoadmap(a.page);
    await joinRoadmap(b.page);
    const passport = page => page.getByRole('form', { name: 'Паспорт проекта', exact: true });
    const title = 'Время для семьи в Ардатовском районе';
    const goal = 'К 2030 году увеличить долю родителей с гибким графиком с 20 до 35 процентов.';
    const checklist = page => passport(page).getByRole('group', { name: 'Самопроверка цели по SMART', exact: true });
    await expect(checklist(a.page).getByRole('checkbox')).toHaveCount(5);
    await passport(a.page).getByRole('textbox', { name: 'Название проекта', exact: true }).fill(title);
    await passport(a.page).getByRole('textbox', { name: 'Цель проекта', exact: true }).fill(goal);
    await checklist(a.page).getByRole('checkbox', { name: /^Конкретная/u }).check();
    await checklist(a.page).getByRole('checkbox', { name: /^Измеримая/u }).check();
    await checklist(a.page).getByRole('checkbox', { name: /^Ограничена сроком/u }).check();
    await roadmapTab(a.page, 'Статистика');
    await roadmapTab(a.page, 'Паспорт');
    await expect(passport(a.page).getByRole('textbox', { name: 'Цель проекта', exact: true })).toHaveValue(goal);
    await passport(a.page).getByRole('button', { name: 'Сохранить паспорт', exact: true }).click();
    await expect(passport(a.page).getByText('Паспорт сохранён.', { exact: true })).toBeVisible();
    await b.page.getByRole('button', { name: 'Обновить дорожные карты', exact: true }).click();
    await expect(passport(b.page).getByRole('textbox', { name: 'Название проекта', exact: true })).toHaveValue(title);
    await expect(passport(b.page).getByRole('textbox', { name: 'Цель проекта', exact: true })).toHaveValue(goal);
    await expect(checklist(b.page).getByRole('checkbox', { checked: true })).toHaveCount(3);
    await expect(checklist(b.page).getByRole('checkbox', { name: /^Измеримая/u })).toBeChecked();
    await noOverflow(b.page, 390);
    await checklist(a.page).scrollIntoViewIfNeeded();
    await screenshot(a.page, 'roadmap-passport-desktop.png');
  });
  await stage('Statistics displays measured age structure and migration for the selected municipality', b.page, async () => {
    await roadmapTab(b.page, 'Статистика');
    const metrics = b.page.getByRole('group', { name: 'Показатели', exact: true });
    await metrics.getByRole('button', { name: 'Половозрастная структура', exact: true }).click();
    const structure = b.page.getByRole('region', { name: 'Половозрастная структура', exact: true });
    await structure.getByRole('combobox', { name: /^Год/u }).selectOption('2024');
    const pyramid = structure.getByRole('figure', { name: 'Половозрастная пирамида за 2024 год', exact: true });
    await expect(pyramid).toBeVisible();
    await expect(pyramid).toContainText('Мужчины');
    await expect(pyramid).toContainText('Женщины');
    await expect(pyramid).toContainText('0–4');
    await expect(pyramid).toContainText('288');
    await screenshot(b.page, 'roadmap-statistics-pyramid-mobile.png');

    await metrics.getByRole('button', { name: 'Миграция по возрасту', exact: true }).click();
    const age = b.page.getByRole('region', { name: 'Миграция по возрасту', exact: true });
    await age.getByRole('combobox', { name: /^Год/u }).selectOption('2023');
    const arrivals = age.getByRole('figure', { name: 'Прибывшие по полу и возрасту за 2023 год', exact: true });
    const departures = age.getByRole('figure', { name: 'Выбывшие по полу и возрасту за 2023 год', exact: true });
    const children = chart => chart.locator('.rm-pyramid-row').filter({
      has: b.page.getByText('0–4', { exact: true }),
    });
    await expect(children(arrivals).locator('.rm-pyramid-men > span')).toHaveText('13');
    await expect(children(arrivals).locator('.rm-pyramid-women > span')).toHaveText('14');
    await expect(children(departures).locator('.rm-pyramid-men > span')).toHaveText('15');
    await expect(children(departures).locator('.rm-pyramid-women > span')).toHaveText('10');
    const young = age.getByRole('row').filter({ has: b.page.getByRole('rowheader', { name: '0–4', exact: true }) });
    await expect(young.getByRole('cell')).toHaveText(['27', '25', '2']);
    await age.getByRole('combobox', { name: /^Направление/u }).selectOption('interregional');
    await expect(children(arrivals).locator('.rm-pyramid-men > span')).toHaveText('8');
    await expect(children(arrivals).locator('.rm-pyramid-women > span')).toHaveText('7');
    await expect(children(departures).locator('.rm-pyramid-men > span')).toHaveText('7');
    await expect(children(departures).locator('.rm-pyramid-women > span')).toHaveText('3');
    await noOverflow(b.page, 390);
    await screenshot(b.page, 'roadmap-migration-pyramids-mobile.png');

    await metrics.getByRole('button', { name: 'Направления миграции', exact: true }).click();
    const migration = b.page.getByRole('region', { name: 'Направления миграции', exact: true });
    await migration.getByRole('combobox', { name: /^Год/u }).selectOption('2023');
    const interregional = migration.getByRole('row').filter({
      has: b.page.getByRole('rowheader', { name: 'Между регионами', exact: true }),
    });
    await expect(interregional.getByRole('cell')).toHaveText(['392', '278', '114']);
    await expect(migration.getByRole('rowheader', { name: 'Международная', exact: true })).toBeVisible();
    await noOverflow(b.page, 390);
  });
  await stage('The cohort forecast compares a changed scenario with the baseline through 2100', a.page, async () => {
    await roadmapTab(a.page, 'Прогноз');
    const forecast = a.page.getByRole('region', { name: 'Прогноз населения', exact: true });
    await expect(forecast.getByRole('heading', { name: 'Параметры прогноза', exact: true })).toBeVisible();
    await expect(forecast.getByText('Базовый прогноз', { exact: true })).toBeVisible();
    await forecast.getByRole('spinbutton', { name: 'Конечный год', exact: true }).fill('2100');
    await forecast.getByRole('spinbutton', { name: 'Рождаемость, %', exact: true }).fill('120');
    await forecast.getByRole('button', { name: 'Рассчитать', exact: true }).click();
    await expect(forecast.getByText('Ваш сценарий', { exact: true })).toBeVisible();
    const population = forecast.locator('.rm-forecast-kpi');
    await expect(population).toContainText('Население на 1 января 2100 года');
    const people = value => Number(value.replace(/[^\d]/gu, ''));
    const scenario = people(await population.locator('strong').innerText());
    const baseline = people(await population.locator('small').innerText());
    expect(baseline).toBeGreaterThan(0);
    expect(scenario).toBeGreaterThan(baseline);
    await forecast.getByText('Половозрастная пирамида прогноза', { exact: true }).click();
    await expect(forecast.getByRole('figure', { name: 'Половозрастная пирамида прогноза на 2100 год', exact: true })).toBeVisible();
    await forecast.getByText('Таблица прогноза по годам', { exact: true }).click();
    const finalYear = forecast.getByRole('row').filter({
      has: a.page.getByRole('rowheader', { name: '2099', exact: true }),
    });
    await expect(finalYear).toBeVisible();
    expect(people(await finalYear.getByRole('cell').nth(1).innerText())).toBeGreaterThan(0);
    await noOverflow(a.page, 1440);
    await forecast.getByRole('heading', { name: 'Параметры прогноза', exact: true }).scrollIntoViewIfNeeded();
    await screenshot(a.page, 'roadmap-cohort-2100-desktop.png');
  });
  await stage('A team selects linked measures and edits the imported activity in its roadmap', a.page, async () => {
    await roadmapTab(a.page, 'Мероприятия');
    await a.page.getByRole('button', { name: 'Перенести барьеры и меры', exact: true }).click();
    const dialog = a.page.getByRole('dialog', { name: 'Перенос барьеров и мер', exact: true });
    await dialog.getByRole('checkbox', { name: LINKED_BARRIER }).check();
    await expect(dialog.getByRole('checkbox', { name: LINKED_MEASURE })).toBeChecked();
    await dialog.getByRole('checkbox', { name: RANKED_FAMILY }).uncheck();
    await dialog.getByRole('button', { name: 'Перенести в проект', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(a.page.getByRole('heading', { name: LINKED_BARRIER, exact: true })).toBeVisible();
    const activity = (page, name) => page.locator('.rm-activity-card')
      .filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(activity(a.page, LINKED_MEASURE)).toHaveCount(1);
    await expect(activity(a.page, RANKED_FAMILY)).toHaveCount(0);
    await activity(a.page, LINKED_MEASURE).getByRole('button', { name: 'Изменить', exact: true }).click();
    const editor = a.page.getByRole('dialog', { name: 'Мероприятие', exact: true });
    const renamed = 'Внедрить гибкий график для родителей в трёх организациях района';
    await editor.getByRole('textbox', { name: 'Название мероприятия', exact: true }).fill(renamed);
    await editor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(activity(a.page, renamed)).toBeVisible();
    await roadmapTab(b.page, 'Мероприятия');
    await b.page.getByRole('button', { name: 'Обновить дорожные карты', exact: true }).click();
    await expect(activity(b.page, renamed)).toBeVisible();
    await expect(b.page.getByRole('heading', { name: LINKED_MEASURE, exact: true })).toBeVisible();
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
  report.externalRequests = externalRequests; report.browserErrors = errors; report.failedResponses = failedResponses; report.invitationRequests = invitationRequests;
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.stop();
}
