/** Real compiled client + production persistent server. No mocked API or seeded user state. */
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openRuntime } from '../../scripts/offline/storage.mjs';
import { startServer } from '../../scripts/offline/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'demography-offline-browser-'));
const evidence = resolve(process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? join(tmpdir(), 'demography-offline-browser-stage-08-evidence'));
await mkdir(evidence, { recursive: true });
let runtime = await openRuntime({ dataDir: directory });
let server = await startServer({ runtime, port: 8787, surveyPort: 8788, publicHost: '192.168.50.10', backupIntervalMs: 0 });
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--host-resolver-rules=MAP 192.168.50.10 127.0.0.1'],
});
const failures = [], outsideRequests = [], steps = [];
const report = { version: JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version,
  browser: browser.version(), environment: 'Linux; HTTP LAN origin mapped to loopback; no Wi-Fi hardware certification', steps, dataDirectory: directory };
let lastPage;
async function context(mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile, locale: 'ru-RU', reducedMotion: 'reduce', acceptDownloads: true });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', '192.168.50.10'].includes(url.hostname)) {
      outsideRequests.push(url.origin); await route.abort('internetdisconnected');
    } else await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
  page.setDefaultTimeout(15000);
  return { context, page };
}
async function step(name, page, work) {
  lastPage = page;
  const start = Date.now();
  await work();
  steps.push({ name, milliseconds: Date.now() - start });
  console.log(`PASS ${name}`);
}
async function tab(page, name) {
  await page.getByRole('tab', { name, exact: true }).or(page.getByRole('button', { name, exact: true })).first().click();
}
async function roadmap(page) {
  await tab(page, 'Дорожные карты');
  await tab(page, 'Территория');
  await page.locator('.rm-table-select').filter({ hasText: 'Ардатовский муниципальный район' }).click();
  const join = page.getByRole('button', { name: 'Создать команду территории', exact: true })
    .or(page.getByRole('button', { name: 'Присоединиться к команде', exact: true }));
  if (await join.count()) await join.click();
  else await page.getByRole('button', { name: 'Открыть дорожную карту', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Диагностика и сценарии', exact: true })).toBeVisible();
}
async function snapshot(page) {
  await page.screenshot({ path: join(evidence, `offline-${steps.length}.png`), fullPage: true });
}
async function identify(page, email, fullName, expectNewProfile = false) {
  const form = page.locator('.session-access-main form');
  await expect(form).toBeVisible();
  await expect(form.locator('input')).toHaveCount(1);
  await expect(form.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel('Фамилия, имя, отчество', { exact: true })).toHaveCount(0);
  await page.getByLabel('Email', { exact: true }).fill(email);
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/offline/auth/identify'
    && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Войти', exact: true }).click();
  let response = await pending;
  expect(response.status()).toBe(200);
  expect(Object.keys(response.request().postDataJSON())).toEqual(['email']);
  let result = await response.json();
  expect(result.profileRequired === true).toBe(expectNewProfile);
  if (result.profileRequired) {
    expect(Object.keys(result).sort()).toEqual(['email', 'profileRequired']);
    await expect(page.getByRole('heading', { name: 'Как к вам обращаться?', exact: true })).toBeVisible();
    await expect(form.locator('input')).toHaveCount(1);
    await page.getByLabel('Фамилия, имя, отчество', { exact: true }).fill(fullName);
    const completing = page.waitForResponse(response => new URL(response.url()).pathname === '/offline/auth/identify'
      && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Продолжить', exact: true }).click();
    response = await completing;
    expect(response.status()).toBe(200);
    expect(Object.keys(response.request().postDataJSON()).sort()).toEqual(['email', 'fullName']);
    result = await response.json();
  }
  expect(Object.keys(result)).toEqual(['session']);
  expect(result.session.user.email_confirmed_at).toBeNull();
  await expect(page.locator('.header-account .account-name')).toHaveText(fullName);
  await expect(page.getByRole('button', { name: 'Сохранить ключ доступа', exact: true })).toHaveCount(0);
  return result.session.user.id;
}
async function statisticsEditor(page) {
  await roadmap(page);
  await page.getByRole('button', { name: 'Уточнить данные', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Уточнение статистики', exact: true });
  await editor.getByLabel('Редактируемый показатель', { exact: true }).selectOption('births_total');
  return editor;
}
async function statisticsHistory(page, editor) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/rest/v1/rpc/dw_roadmap_statistics_history'
    && response.request().method() === 'POST');
  await editor.getByRole('button', { name: 'История уточнений', exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(200);
  const history = await response.json();
  await expect(editor.locator('.rm-statistics-history article')).toHaveCount(history.entries.length);
  return history;
}
const teacher = await context();
const student = await context(true);
const studentName = 'Слушатель автономной репетиции';
let teacherName = 'Преподаватель локальной репетиции';
const notebookComment = 'Автосохранённая цитата автономного занятия';
const notebookCardTitle = 'Автономная авторская карточка';
let invitation, studentId, teacherId, sessionUrl, sessionId, returning, savedNotebookQuote;
try {
  await step('Common teacher entry works on LAN, header survives reload and document navigation, and logout works globally', teacher.page, async () => {
    await teacher.page.goto('http://192.168.50.10:8787/#sessions');
    await expect(teacher.page.locator('.topbar').getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
    await expect(teacher.page.locator('.institute-logo')).toBeVisible();
    teacherId = await identify(teacher.page, 'omnistat@yandex.ru', teacherName, true);
    await expect(teacher.page.locator('.header-account .account-role')).toHaveText('Преподаватель');
    await teacher.page.getByRole('button', { name: 'Изменить ФИО', exact: true }).click();
    const profile = teacher.page.getByRole('dialog', { name: 'Профиль', exact: true });
    teacherName = 'Преподаватель автономной мастерской';
    await profile.getByLabel('Фамилия, имя, отчество', { exact: true }).fill(teacherName);
    const savingProfile = teacher.page.waitForResponse(response => new URL(response.url()).pathname === '/rest/v1/rpc/dw_save_profile'
      && response.request().method() === 'POST');
    await profile.getByRole('button', { name: 'Сохранить', exact: true }).click();
    expect((await savingProfile).status()).toBe(200);
    await expect(profile).toBeHidden();
    await teacher.page.reload();
    await expect(teacher.page.locator('.header-account .account-name')).toHaveText(teacherName);
    await expect(teacher.page.locator('.header-account .account-role')).toHaveText('Преподаватель');
    await teacher.page.getByRole('button', { name: 'Документы', exact: true }).click();
    await expect(teacher.page.locator('.header-account .account-name')).toHaveText(teacherName);
    await snapshot(teacher.page);
    await teacher.page.locator('.header-account').getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(teacher.page.getByRole('heading', { name: 'Войти в занятие', exact: true })).toBeVisible();
    await expect(teacher.page.locator('.header-account .account-name')).toHaveCount(0);
    await expect(teacher.page.locator('.topbar').getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
    // The same common form on the Mac returns exactly the same teacher identity.
    // Only machine administration (backup/network display) requires the local Mac origin.
    await teacher.page.goto('http://127.0.0.1:8787/#sessions');
    expect(await identify(teacher.page, 'OMNISTAT@YANDEX.RU', teacherName)).toBe(teacherId);
    await expect(teacher.page.getByRole('button', { name: 'Кабинет преподавателя на этом Mac', exact: true })).toHaveCount(0);
    await expect(teacher.page.getByText('80 документов · 2 471 территорий', { exact: false })).toBeVisible();
    await snapshot(teacher.page);
  });
  await step('Create seminar and show reachable LAN invitation', teacher.page, async () => {
    await teacher.page.getByRole('button', { name: 'Создать занятие', exact: true }).click();
    const dialog = teacher.page.getByRole('dialog', { name: 'Новое занятие', exact: true });
    await dialog.getByLabel('Название занятия', { exact: true }).fill('Автономная репетиция Мордовия');
    await dialog.getByLabel('Регион', { exact: true }).selectOption('respublika-mordoviia');
    await dialog.getByRole('button', { name: 'Создать занятие', exact: true }).click();
    await expect(dialog).toBeHidden();
    sessionUrl = teacher.page.url();
    sessionId = new URLSearchParams(new URL(sessionUrl).hash.slice(1)).get('session');
    expect(sessionId).toBeTruthy();
    await teacher.page.getByText('Подключение аудитории и резервная копия', { exact: true }).click();
    await teacher.page.getByRole('button', { name: 'Показать подключение на экране', exact: true }).click();
    const connect = teacher.page.getByRole('dialog', { name: 'Подключение к мастерской', exact: true });
    await connect.getByLabel('Адрес Mac в сети', { exact: true }).selectOption('192.168.50.10');
    invitation = await connect.getByRole('link').getAttribute('href');
    expect(new URL(invitation).hostname).toBe('192.168.50.10');
    const parameters = new URLSearchParams(new URL(invitation).hash.slice(1));
    expect(parameters.get('session')).toBe(sessionId);
    expect([...parameters.keys()]).toEqual(['session']);
    await snapshot(teacher.page);
    await connect.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  });
  await step('Email-first touch entry asks for a new name once and joins the linked seminar over HTTP LAN', student.page, async () => {
    await student.page.goto(invitation);
    expect(await student.page.evaluate(() => window.isSecureContext)).toBe(false);
    expect(await student.page.evaluate(() => typeof crypto.subtle)).toBe('undefined');
    await expect(student.page.getByRole('button', { name: 'Кабинет преподавателя на этом Mac', exact: true })).toHaveCount(0);
    studentId = await identify(student.page, 'local-student@example.test', studentName, true);
    await expect(student.page.locator('.header-account .account-role')).toHaveText('Участник');
    await expect(student.page.locator('.header-account').getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
    await expect(student.page.getByRole('heading', { name: 'Автономная репетиция Мордовия', exact: true })).toBeVisible();
    expect(new URLSearchParams(new URL(student.page.url()).hash.slice(1)).get('session')).toBe(sessionId);
    expect(await student.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await snapshot(student.page);
  });
  await step('Quoted source and authored card save automatically to the local server and appear on a fresh device without an archive', teacher.page, async () => {
    await teacher.page.getByRole('button', { name: 'Документы', exact: true }).click();
    const library = teacher.page.getByRole('complementary', { name: 'Библиотека программ', exact: true });
    await library.getByRole('button', { name: /^Республика Мордовия(?:\s|$)/u }).click();
    const reader = teacher.page.getByRole('region', { name: 'Полный текст программы', exact: true });
    await reader.getByRole('button', { name: /^Выбрать фрагмент \d+$/u }).first().click();
    await reader.getByRole('button', { name: 'Сохранить цитату без карточки', exact: true }).click();
    const quotation = teacher.page.getByRole('dialog', { name: 'Сохранить цитату', exact: true });
    await quotation.getByRole('textbox', { name: 'Комментарий к фрагменту', exact: true }).fill(notebookComment);
    const savedQuote = teacher.page.waitForResponse(response => new URL(response.url()).pathname === '/rest/v1/rpc/dw_workspace_commit'
      && response.request().postDataJSON()?.p_state?.annotations?.some(annotation => annotation.note === notebookComment));
    await quotation.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const quoteResponse = await savedQuote;
    expect(quoteResponse.status()).toBe(200);
    const quoteCommit = await quoteResponse.json();
    expect(quoteCommit.kind).toBe('committed');
    const annotation = quoteCommit.snapshot.state.annotations.find(annotation => annotation.note === notebookComment);
    savedNotebookQuote = annotation.anchor.spans.map(span => span.exact).join('\n');
    expect(savedNotebookQuote.length).toBeGreaterThan(5);
    await expect(quotation).toBeHidden();
    const inspector = teacher.page.getByRole('complementary', { name: 'Связь цитаты и практики', exact: true });
    await inspector.getByRole('button', { name: 'Создать карточку', exact: true }).click();
    const card = teacher.page.getByRole('dialog', { name: 'Новая карточка практики', exact: true });
    await card.getByRole('textbox', { name: 'Название практики', exact: true }).fill(notebookCardTitle);
    await card.getByRole('textbox', { name: 'Механизм поддержки', exact: true }).fill('Учебный механизм с сохранением точного основания из программы.');
    const savedCard = teacher.page.waitForResponse(response => new URL(response.url()).pathname === '/rest/v1/rpc/dw_workspace_commit'
      && response.request().postDataJSON()?.p_state?.customCards?.some(card => card.title === notebookCardTitle));
    await card.getByRole('button', { name: 'Сохранить карточку', exact: true }).click();
    const cardResponse = await savedCard;
    expect(cardResponse.status()).toBe(200);
    const cardCommit = await cardResponse.json();
    expect(cardCommit.kind).toBe('committed');
    expect(cardCommit.snapshot.state.customCards.find(card => card.title === notebookCardTitle).occurrenceIds).toContain(annotation.id);
    await expect(card).toBeHidden();
    await teacher.page.getByRole('button', { name: 'Моя работа', exact: true }).click();
    await expect(teacher.page.getByText(notebookComment, { exact: true })).toBeVisible();
    await expect(teacher.page.getByText(notebookCardTitle, { exact: true })).toBeVisible();
    await expect(teacher.page.getByRole('button', { name: 'Сохранить архив работы', exact: true })).toHaveCount(0);
    await snapshot(teacher.page);
    const fresh = await context();
    try {
      await fresh.page.goto('http://192.168.50.10:8787/#sessions');
      expect(await identify(fresh.page, 'omnistat@yandex.ru', teacherName)).toBe(teacherId);
      await fresh.page.getByRole('button', { name: 'Моя работа', exact: true }).click();
      await expect(fresh.page.getByText(notebookComment, { exact: true })).toBeVisible();
      await expect(fresh.page.getByText(notebookCardTitle, { exact: true })).toBeVisible();
      await expect(fresh.page.locator('.work-item').filter({ hasText: notebookComment })).toContainText(savedNotebookQuote);
      await snapshot(fresh.page);
    } finally {await fresh.context.close();}
    await teacher.page.getByRole('button', { name: 'Занятия', exact: true }).click();
    await expect(teacher.page.getByRole('heading', { name: 'Автономная репетиция Мордовия', exact: true })).toBeVisible();
  });
  await step('Shared territory, HTTP SHA checks and manual statistics correction', student.page, async () => {
    await roadmap(teacher.page);
    await roadmap(student.page);
    await student.page.getByRole('button', { name: 'Уточнить данные', exact: true }).click();
    const editor = student.page.getByRole('dialog', { name: 'Уточнение статистики', exact: true });
    await editor.getByLabel('Редактируемый показатель', { exact: true }).selectOption('births_total');
    await editor.getByLabel('Значение за 2014 год', { exact: true }).fill('301');
    await editor.getByLabel('Источник уточнения', { exact: true }).fill('Учебная локальная сводка муниципалитета');
    await editor.getByLabel('Дата источника', { exact: true }).fill('2026-10-01');
    await editor.getByLabel('Основание изменения', { exact: true }).fill('Проверка совместного уточнения при отсутствии внешней сети.');
    await editor.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
    await editor.getByRole('button', { name: 'Применить уточнения', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('Уточнения сохранены для всей территориальной команды');
    await snapshot(student.page);
    await editor.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await teacher.page.bringToFront();
    await expect(teacher.page.getByLabel('Редакция данных', { exact: true })).toContainText('Уточнение команды · редакция 1', { timeout: 15000 });
    await teacher.page.getByRole('button', { name: 'Уточнить данные', exact: true }).click();
    const teacherEditor = teacher.page.getByRole('dialog', { name: 'Уточнение статистики', exact: true });
    await teacherEditor.getByLabel('Редактируемый показатель', { exact: true }).selectOption('births_total');
    await expect(teacherEditor.getByLabel('Значение за 2014 год', { exact: true })).toHaveValue('301');
    await teacherEditor.getByRole('button', { name: 'Закрыть', exact: true }).click();
  });
  await step('Frozen DOCX/PDF export with fonts entirely from local server', student.page, async () => {
    await tab(student.page, 'Проверка и экспорт');
    await student.page.getByRole('button', { name: 'Зафиксировать черновик', exact: true }).click();
    const freeze = student.page.getByRole('dialog', { name: 'Зафиксировать рабочую версию', exact: true });
    await freeze.getByLabel('Название версии', { exact: true }).fill('Автономная версия для проверки');
    await freeze.getByRole('button', { name: 'Зафиксировать версию', exact: true }).click();
    await expect(freeze).toBeHidden();
    const version = student.page.locator('.rm-version').first();
    await expect(version.getByRole('button', { name: 'JSON', exact: true })).toHaveCount(0);
    for (const format of ['DOCX', 'PDF']) {
      const pending = student.page.waitForEvent('download', { timeout: 60000 });
      await version.getByRole('button', { name: format, exact: true }).click();
      const download = await pending;
      expect(await download.failure()).toBeNull();
      const bytes = await readFile(await download.path());
      expect(bytes.length).toBeGreaterThan(500);
      if (format === 'PDF') expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      if (format === 'DOCX') expect(bytes.subarray(0, 2).toString()).toBe('PK');
      await download.saveAs(join(evidence, `offline-export.${format.toLowerCase()}`));
    }
  });
  await step('Local PDF source preserves its edition and serves bytes without an external host', student.page, async () => {
    await student.page.getByRole('button', { name: 'Документы', exact: true }).click();
    const original = student.page.getByRole('link', { name: 'Оригинал', exact: true });
    await expect(original).toHaveAttribute('href', /\/data\/originals\/[a-f\d]{64}\.pdf#page=/u);
    const href = await original.getAttribute('href');
    const result = await student.page.evaluate(async (url) => {
      const response = await fetch(url, { headers: { Range: 'bytes=0-4' } });
      return { status: response.status, text: await response.text() };
    }, href);
    expect(result).toEqual({ status: 206, text: '%PDF-' });
  });
  await step('Independent anonymous LAN form uses native fetch without account credentials', teacher.page, async () => {
    await teacher.page.bringToFront();
    await tab(teacher.page, 'Барьеры и решения');
    await tab(teacher.page, 'Опрос');
    await teacher.page.getByRole('button', { name: 'Создать опрос', exact: true }).click();
    const editor = teacher.page.getByRole('dialog', { name: 'Новый опрос', exact: true });
    await editor.getByRole('textbox', { name: 'Название опроса', exact: true }).fill('Условия родительства без внешней сети');
    await editor.getByRole('textbox', { name: 'Цель и использование ответов', exact: true }).fill('Добровольная учебная репетиция локального анонимного опроса.');
    await editor.getByRole('textbox', { name: 'Контакт организатора', exact: true }).fill('Преподаватель учебной репетиции');
    await editor.getByRole('textbox', { name: 'Вопрос о барьерах', exact: true }).fill('Какие обстоятельства затрудняют родительство?');
    await editor.getByRole('textbox', { name: 'Вопрос об условиях', exact: true }).fill('Какие изменения могли бы помочь?');
    await editor.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
    await expect(editor).toBeHidden();
    await teacher.page.getByRole('button', { name: 'Открыть опрос', exact: true }).click();
    const opening = teacher.page.getByRole('dialog', { name: 'Открыть опрос?', exact: true });
    await opening.getByRole('button', { name: 'Открыть опрос', exact: true }).click();
    await expect(opening).toBeHidden();
    const href = await teacher.page.getByRole('link', { name: 'Открыть отдельную форму', exact: true }).getAttribute('href');
    expect(new URL(href).origin).toBe('http://192.168.50.10:8788');
    const anonymous = await student.context.newPage();
    const requests = [];
    anonymous.on('request', (request) => requests.push(request));
    anonymous.on('pageerror', (error) => failures.push(error.message));
    await anonymous.goto(href);
    expect(await anonymous.evaluate(() => isSecureContext)).toBe(false);
    await anonymous.getByLabel('С какой позиции вы отвечаете?', { exact: true }).selectOption('self');
    await anonymous.getByLabel('Ответ о барьерах', { exact: true }).fill('Учебный ответ: непредсказуемый график присмотра.');
    await anonymous.getByLabel('Ответ об условиях', { exact: true }).fill('Учебное условие: доступная вечерняя группа.');
    await anonymous.getByRole('checkbox', { name: 'Мне исполнилось 18 лет.', exact: true }).check();
    await anonymous.getByRole('checkbox', { name: /^Я добровольно участвую и согласен/ }).check();
    await anonymous.getByRole('button', { name: 'Сохранить ответ', exact: true }).click();
    await expect(anonymous.getByText(/^Ответ сохранён\./)).toBeVisible();
    await anonymous.reload();
    await expect(anonymous.getByLabel('Ответ о барьерах', { exact: true })).toHaveValue('Учебный ответ: непредсказуемый график присмотра.');
    await snapshot(anonymous);
    expect(requests.some(request => /\/auth\/v1\//u.test(request.url()))).toBe(false);
    for (const request of requests.filter(request => request.url().includes('/rest/v1/rpc/'))) {
      const headers = await request.allHeaders();
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
      expect(headers.referer).toBeUndefined();
      expect(request.postData()).not.toContain('local-student@example.test');
    }
    await anonymous.getByRole('button', { name: 'Удалить мой ответ', exact: true }).click();
    await anonymous.getByRole('dialog', { name: 'Удалить мой ответ?', exact: true })
      .getByRole('button', { name: 'Удалить мой ответ без восстановления', exact: true }).click();
    await expect(anonymous.getByText(/^Ваш ответ удалён\./)).toBeVisible();
    await anonymous.close();
  });
  await step('Consistent backup, real server restart and restored account', teacher.page, async () => {
    if (!await teacher.page.getByRole('button', { name: 'Создать резервную копию', exact: true }).isVisible())
      await teacher.page.getByText('Подключение аудитории и резервная копия', { exact: true }).click();
    await teacher.page.getByRole('button', { name: 'Создать резервную копию', exact: true }).click();
    await expect(teacher.page.getByText('Резервная копия сохранена на Mac.', { exact: true })).toBeVisible();
    // Close live polling while the operator deliberately takes the server down;
    // keep each real browser origin's persisted login for the restart check.
    await teacher.page.goto('about:blank');
    await student.page.goto('about:blank');
    await server.stop();
    runtime = await openRuntime({ dataDir: directory });
    server = await startServer({ runtime, port: 8787, surveyPort: 8788, publicHost: '192.168.50.10', backupIntervalMs: 0 });
    await teacher.page.goto(sessionUrl);
    await expect(teacher.page.getByRole('heading', { name: 'Автономная репетиция Мордовия', exact: true })).toBeVisible();
    await expect(teacher.page.locator('.header-account .account-name')).toHaveText(teacherName);
    await teacher.page.getByRole('button', { name: 'Моя работа', exact: true }).click();
    await expect(teacher.page.getByText(notebookComment, { exact: true })).toBeVisible();
    await expect(teacher.page.getByText(notebookCardTitle, { exact: true })).toBeVisible();
    await teacher.page.getByRole('button', { name: 'Занятия', exact: true }).click();
    await roadmap(teacher.page);
    await teacher.page.getByRole('button', { name: 'Уточнить данные', exact: true }).click();
    const editor = teacher.page.getByRole('dialog', { name: 'Уточнение статистики', exact: true });
    await editor.getByLabel('Редактируемый показатель', { exact: true }).selectOption('births_total');
    await expect(editor.getByLabel('Значение за 2014 год', { exact: true })).toHaveValue('301');
    await editor.getByRole('button', { name: 'Закрыть', exact: true }).click();
  });
  await step('Logout and the same email on a fresh device resume the sole open seminar and preserved authorship', student.page, async () => {
    await student.page.goto(invitation);
    await expect(student.page.locator('.header-account .account-name')).toHaveText(studentName);
    await student.page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(student.page.getByRole('heading', { name: 'Войти в занятие', exact: true })).toBeVisible();
    // A new browser has neither previous tokens nor a session ID in its address.
    // It must find the same participant and enter the only open seminar itself.
    returning = await context();
    lastPage = returning.page;
    await returning.page.goto('http://192.168.50.10:8787/#sessions');
    expect(await identify(returning.page, 'LOCAL-STUDENT@EXAMPLE.TEST', studentName)).toBe(studentId);
    await expect(returning.page.getByRole('heading', { name: 'Автономная репетиция Мордовия', exact: true })).toBeVisible();
    expect(new URLSearchParams(new URL(returning.page.url()).hash.slice(1)).get('session')).toBe(sessionId);
    const editor = await statisticsEditor(returning.page);
    await expect(editor.getByLabel('Значение за 2014 год', { exact: true })).toHaveValue('301');
    const history = await statisticsHistory(returning.page, editor);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({ revision: 1, createdBy: studentId, createdByName: studentName });
    await expect(editor.locator('.rm-statistics-history article').first()).toContainText(studentName);
    await snapshot(returning.page);
    await editor.getByRole('button', { name: 'Закрыть', exact: true }).click();
  });
  await step('A different email in the same browser receives a separate identity and never rewrites prior authorship', returning.page, async () => {
    const page = returning.page;
    const otherName = 'Другой слушатель автономной репетиции';
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Войти в занятие', exact: true })).toBeVisible();
    const otherId = await identify(page, 'other-local-student@example.test', otherName, true);
    expect(otherId).not.toBe(studentId);
    await expect(page.getByRole('heading', { name: 'Автономная репетиция Мордовия', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Создать занятие', exact: true })).toHaveCount(0);
    const editor = await statisticsEditor(page);
    await expect(editor.getByLabel('Значение за 2014 год', { exact: true })).toHaveValue('301');
    await editor.getByLabel('Значение за 2015 год', { exact: true }).fill('302');
    await editor.getByLabel('Источник уточнения', { exact: true }).fill('Учебная сводка второго участника');
    await editor.getByLabel('Дата источника', { exact: true }).fill('2026-10-02');
    await editor.getByLabel('Основание изменения', { exact: true }).fill('Проверка независимого авторства после смены email в том же браузере.');
    await editor.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
    await editor.getByRole('button', { name: 'Применить уточнения', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('Уточнения сохранены для всей территориальной команды');
    const history = await statisticsHistory(page, editor);
    expect(history.entries).toHaveLength(2);
    expect(history.entries.find(entry => entry.revision === 1)).toMatchObject({ createdBy: studentId, createdByName: studentName });
    expect(history.entries.find(entry => entry.revision === 2)).toMatchObject({ createdBy: otherId, createdByName: otherName });
    await expect(editor.locator('.rm-statistics-history')).toContainText(studentName);
    await expect(editor.locator('.rm-statistics-history')).toContainText(otherName);
    await snapshot(page);
    await editor.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await returning.context.close();
  });
  expect(outsideRequests).toEqual([]);
  expect(failures).toEqual([]);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error.stack;
  if (lastPage) {
    await lastPage.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    const text = await lastPage.locator('body').innerText().catch(() => '');
    await writeFile(join(evidence, 'failure.txt'), text);
    console.error(text.slice(0, 7000));
  }
  throw error;
} finally {
  report.externalRequests = outsideRequests;
  report.browserErrors = failures;
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.stop();
}
