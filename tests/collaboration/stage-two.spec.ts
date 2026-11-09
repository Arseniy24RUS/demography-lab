import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page, TestInfo } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:4173';
const GATEWAY_URL = 'http://127.0.0.1:54321';
const SESSION_TITLE = 'Мордовия · совместная экспертиза';
const PRACTICE_TITLE = 'Компенсация родительской платы за детский сад';
const HOST_NAME = 'Преподаватель учебного занятия';
const PARTICIPANT_NAME = 'Участница муниципальной команды';

const navigation = (page: Page) => page.getByRole('navigation', { name: 'Основная навигация' });
const reader = (page: Page) => page.getByRole('region', { name: 'Полный текст программы' });
const inspector = (page: Page) =>
  page.getByRole('complementary', { name: 'Связь цитаты и практики' });
const sharedCard = (page: Page) => page.getByRole('article', { name: PRACTICE_TITLE, exact: true });

let errors: Array<{ label: string; text: string; url: string }>;
let runtimeErrors: string[];
let warnings: string[];
let failedResponses: Array<{ label: string; url: string; status: number }>;
let allowedConflictResponse = false;
let watchedPages: Page[];

function watch(page: Page, label: string) {
  watchedPages.push(page);
  page.on('pageerror', (error) => runtimeErrors.push(`${label}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push({ label, text: message.text(), url: message.location().url });
    if (message.type() === 'warning') warnings.push(`${label}: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      failedResponses.push({ label, url: response.url(), status: response.status() });
  });
}

async function fixture(request: APIRequestContext, path: string, data = {}) {
  const secret = process.env.WORKSHOP_TEST_ADMIN_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('The isolated fixture runner credential is missing.');
  const response = await request.post(`${GATEWAY_URL}/__test/${path}`, {
    headers: { 'X-Workshop-Test-Secret': secret },
    data,
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

test.beforeEach(async ({ page, request }) => {
  errors = [];
  runtimeErrors = [];
  warnings = [];
  failedResponses = [];
  watchedPages = [];
  allowedConflictResponse = false;
  await fixture(request, 'reset');
  watch(page, 'teacher');
});

test.afterEach(async ({}, testInfo) => {
  if (warnings.length)
    await testInfo.attach('console-warnings', {
      body: JSON.stringify(warnings, null, 2),
      contentType: 'application/json',
    });
  expect(runtimeErrors, 'Uncaught application errors').toEqual([]);
  const expectedResponse = (response: { url: string; status: number }) =>
    allowedConflictResponse &&
    response.status === 400 &&
    response.url === `${GATEWAY_URL}/rest/v1/rpc/dw_publish_submission`;
  expect(
    failedResponses.filter((response) => !expectedResponse(response)),
    'Unexpected failed HTTP responses',
  ).toEqual([]);
  const unexpectedErrors = errors.filter(
    (error) =>
      !(
        allowedConflictResponse &&
        error.url === `${GATEWAY_URL}/rest/v1/rpc/dw_publish_submission` &&
        /400/.test(error.text)
      ),
  );
  expect(unexpectedErrors, 'Unexpected browser console errors').toEqual([]);
  for (const page of watchedPages) {
    if (!page.isClosed()) await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  }
});

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name);
  await page.screenshot({ path, animations: 'disabled', fullPage: false });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function freshContext(browser: Browser, mobile = false): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: BASE_URL,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    locale: 'ru-RU',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
}

async function login(page: Page, email: string, name: string | null, request: APIRequestContext) {
  await page.goto('/');
  await expect(page).toHaveTitle('Демографическая мастерская — документы и практики');
  await navigation(page).getByRole('button', { name: 'Занятия', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Совместная работа', exact: true }),
  ).toBeVisible();
  const access = page.getByRole('region', { name: 'Вход в совместную работу' });
  await access.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await access.getByRole('button', { name: 'Получить код', exact: true }).click();
  await expect(access.getByRole('textbox', { name: 'Код из письма', exact: true })).toBeVisible();
  const { token } = await fixture(request, 'otp', { email });
  await access.getByRole('textbox', { name: 'Код из письма', exact: true }).fill(token);
  await access.getByRole('button', { name: 'Подтвердить адрес', exact: true }).click();
  if (name !== null) {
    await access.getByRole('textbox', { name: 'Фамилия, имя, отчество', exact: true }).fill(name);
    await access.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  }
  await expect(
    page.getByRole('heading', { level: 2, name: 'Ваши занятия', exact: true }),
  ).toBeVisible();
}

async function createSession(page: Page) {
  await page.getByRole('button', { name: 'Создать занятие', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новое занятие', exact: true });
  await dialog.getByRole('textbox', { name: 'Название занятия', exact: true }).fill(SESSION_TITLE);
  await dialog
    .getByRole('combobox', { name: 'Уровень работы', exact: true })
    .selectOption('municipality');
  await dialog
    .getByRole('combobox', { name: 'Регион', exact: true })
    .selectOption('respublika-mordoviia');
  await dialog.getByRole('button', { name: 'Создать занятие', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Общая доска практик', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Код приглашения', exact: true }).click();
  const invitation = page.getByRole('dialog', { name: 'Пригласить участников', exact: true });
  const link = await invitation
    .getByRole('textbox', { name: 'Ссылка для участников', exact: true })
    .inputValue();
  const code = new URL(link).searchParams.get('join');
  expect(code).toMatch(/^[A-F0-9]{12}$/);
  await invitation.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  return {
    code: code!,
    sessionId: new URLSearchParams(new URL(page.url()).hash.slice(1)).get('session')!,
  };
}

async function joinSession(page: Page, code: string) {
  await expect(page.getByRole('button', { name: 'Создать занятие', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Код занятия', exact: true }).fill(code);
  await page.getByRole('button', { name: 'Присоединиться', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Общая доска практик', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Приостановить сбор', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Код приглашения', exact: true })).toHaveCount(0);
}

async function openPreparedPractice(page: Page, mobile = false) {
  await navigation(page).getByRole('button', { name: 'Практики', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Регион практики', exact: true })
    .selectOption('respublika-mordoviia');
  await page.getByRole('textbox', { name: 'Поиск практик', exact: true }).fill(PRACTICE_TITLE);
  const tile = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: PRACTICE_TITLE, exact: true }) });
  await tile.getByRole('button', { name: 'Проверить', exact: true }).click();
  if (mobile)
    await page
      .getByRole('navigation', { name: 'Панели рабочей области' })
      .getByRole('button', { name: /^Связь(?:\s*\d+)?$/ })
      .click();
  await expect(
    inspector(page).getByRole('heading', { name: PRACTICE_TITLE, exact: true }),
  ).toBeVisible();
}

async function verifyRecipientField(page: Page) {
  await openPreparedPractice(page);
  await inspector(page)
    .getByRole('button', { name: 'Открыть точную цитату', exact: true })
    .first()
    .click();
  await expect(
    reader(page).getByRole('textbox', { name: 'Номер страницы', exact: true }),
  ).toHaveValue('59');
  await reader(page).getByRole('button', { name: 'Выбрать фрагмент 604', exact: true }).click();
  await inspector(page)
    .getByRole('combobox', { name: 'Проверка поля Получатели', exact: true })
    .selectOption('supports');
  await inspector(page)
    .getByRole('textbox', { name: 'Обоснование связи', exact: true })
    .fill('Получатели названы в точном фрагменте программы на странице 59.');
  await inspector(page)
    .getByRole('checkbox', { name: 'Сопоставил выбранные поля с цитатой и её контекстом' })
    .check();
  await inspector(page).getByRole('button', { name: 'Подтвердить связь', exact: true }).click();
  await expect(inspector(page).getByText('Проверено по цитате', { exact: true })).toHaveCount(1);
}

async function publish(page: Page, note: string) {
  await inspector(page).getByRole('button', { name: 'Отправить в занятие', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Отправить практику в занятие', exact: true });
  await dialog.getByRole('textbox', { name: 'Комментарий для обсуждения', exact: true }).fill(note);
  await dialog.getByRole('button', { name: 'Опубликовать в занятии', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(sharedCard(page)).toBeVisible();
  await expect(sharedCard(page)).toContainText(note);
}

async function reopenSession(page: Page) {
  await page.reload();
  await navigation(page).getByRole('button', { name: 'Занятия', exact: true }).click();
  const open = page.getByRole('button', {
    name: `Открыть занятие «${SESSION_TITLE}»`,
    exact: true,
  });
  await expect(
    page.getByRole('heading', { level: 2, name: 'Общая доска практик', exact: true }).or(open),
  ).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(sharedCard(page)).toBeVisible();
}

async function noMobileOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.width).toBe(390);
  expect(dimensions.root).toBeLessThanOrEqual(391);
  expect(dimensions.body).toBeLessThanOrEqual(391);
}

test('independent browsers publish a reviewed source, synchronize, reload, and obey a teacher pause', async ({
  page,
  browser,
  request,
}, info) => {
  const context = await freshContext(browser);
  try {
    const participant = await context.newPage();
    watch(participant, 'participant');
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    const { code } = await createSession(page);
    await login(participant, 'participant-a@workshop.test', PARTICIPANT_NAME, request);
    await joinSession(participant, code);
    await verifyRecipientField(participant);
    const note =
      'Сопоставили получателей с первичным текстом; предлагаем обсудить переносимость условий.';
    await publish(participant, note);
    await page.bringToFront();
    await expect(sharedCard(page)).toBeVisible();
    await expect(sharedCard(page)).toContainText(note);
    await sharedCard(page)
      .getByRole('group', { name: 'Выбрать документальное основание' })
      .getByRole('button', { name: /^\d+\. Получатели$/ })
      .last()
      .click();
    await expect(sharedCard(page)).toContainText('получатели — подтверждает');
    await expect(
      sharedCard(page).getByRole('button', { name: 'Редактировать', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText('participant-a@workshop.test', { exact: false })).toHaveCount(0);
    await expect(participant.getByText('teacher@workshop.test', { exact: false })).toHaveCount(0);
    await screenshot(page, info, 'desktop-shared-board.png');
    const idleReads: string[] = [];
    const observeIdleRead = (request: { url(): string }) => {
      if (request.url().includes('/rest/v1/rpc/')) idleReads.push(request.url());
    };
    page.on('request', observeIdleRead);
    try {
      // Synchronize on actual completed cursor polls, without a fixed sleep or mocked responses.
      for (let index = 0; index < 2; index++) {
        await page.waitForResponse(
          (response) =>
            response.url() === `${GATEWAY_URL}/rest/v1/rpc/dw_session_cursor` &&
            response.status() === 200,
        );
      }
    } finally {
      page.off('request', observeIdleRead);
    }
    expect(idleReads.some((url) => url.endsWith('/dw_session_cursor'))).toBe(true);
    expect(idleReads.some((url) => url.endsWith('/dw_session_snapshot'))).toBe(false);
    await reopenSession(participant);
    await expect(sharedCard(participant)).toContainText(note);
    await reopenSession(page);
    await expect(sharedCard(page)).toContainText(note);

    await page.getByRole('button', { name: 'Приостановить сбор', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Возобновить сбор', exact: true })).toBeVisible();
    await participant.bringToFront();
    await expect(
      participant.getByText('Преподаватель приостановил публикацию и изменение работ.', {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      sharedCard(participant).getByRole('button', { name: 'Редактировать', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Возобновить сбор', exact: true }).click();
    await participant.bringToFront();
    await expect(
      sharedCard(participant).getByRole('button', { name: 'Редактировать', exact: true }),
    ).toBeVisible();
    await sharedCard(participant)
      .getByRole('button', { name: 'Открыть цитату', exact: true })
      .first()
      .click();
    await expect(
      reader(participant).getByRole('textbox', { name: 'Номер страницы', exact: true }),
    ).toHaveValue('59');
    await screenshot(participant, info, 'shared-source-return-page59.png');
  } finally {
    await context.close();
  }
});

test('the host projector uses the restricted projection response and updates focus without exposing admission data', async ({
  page,
  browser,
  request,
}, info) => {
  const context = await freshContext(browser);
  let projector: Page | undefined;
  try {
    const participant = await context.newPage();
    watch(participant, 'participant');
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    const { code, sessionId } = await createSession(page);
    await login(participant, 'participant-a@workshop.test', PARTICIPANT_NAME, request);
    await joinSession(participant, code);
    await openPreparedPractice(participant);
    await publish(participant, 'Практика для коллективного обсуждения.');
    await page.bringToFront();
    await expect(sharedCard(page)).toBeVisible();
    const projectionRequests: string[] = [];
    page.context().once('page', (opened) => {
      watch(opened, 'projector');
      opened.on('request', (req) => {
        if (req.url().includes('/rest/v1/rpc/')) projectionRequests.push(req.url());
      });
    });
    const popup = page.context().waitForEvent('page');
    await page.getByRole('button', { name: 'Экран проектора', exact: true }).click();
    projector = await popup;
    await expect(projector).toHaveURL(`${BASE_URL}/#session=${sessionId}&projector=1`);
    await expect(
      projector
        .getByRole('main', { name: 'Экран проектора' })
        .getByText(SESSION_TITLE, { exact: true }),
    ).toBeVisible();
    await expect(
      projector.getByRole('heading', { name: PRACTICE_TITLE, exact: true }),
    ).toBeVisible();
    const visible = await projector.locator('body').innerText();
    for (const privateText of [
      code,
      'teacher@workshop.test',
      'participant-a@workshop.test',
      HOST_NAME,
      PARTICIPANT_NAME,
    ])
      expect(visible).not.toContain(privateText);
    expect(projectionRequests.some((url) => url.endsWith('/dw_projector_snapshot'))).toBe(true);
    expect(
      projectionRequests.some(
        (url) => url.endsWith('/dw_session_snapshot') || url.endsWith('/dw_invitation'),
      ),
    ).toBe(false);
    await screenshot(projector, info, 'projector-private-by-default.png');

    await sharedCard(page)
      .getByRole('button', { name: 'Показать на проекторе', exact: true })
      .click();
    await expect(
      sharedCard(page).getByRole('button', { name: 'Убрать с проектора', exact: true }),
    ).toBeVisible();
    const authorToggle = page.getByRole('checkbox', {
      name: 'Показывать авторов на проекторе',
      exact: true,
    });
    // This server-controlled checkbox becomes checked only after the committed RPC response.
    await authorToggle.click();
    await expect(authorToggle).toBeChecked();
    await projector.bringToFront();
    await expect(projector.getByText(PARTICIPANT_NAME, { exact: false })).toBeVisible();
    await expect(projector.getByText('teacher@workshop.test', { exact: false })).toHaveCount(0);
    await expect(projector.getByText('participant-a@workshop.test', { exact: false })).toHaveCount(
      0,
    );
    await expect(projector.getByText(code, { exact: false })).toHaveCount(0);
    await screenshot(projector, info, 'projector-focused-practice.png');
  } finally {
    await projector?.close();
    await context.close();
  }
});

test('mobile touch-size view signs in, joins, publishes, and reopens the original quotation without horizontal overflow', async ({
  page,
  browser,
  request,
}, info) => {
  const context = await freshContext(browser, true);
  try {
    const mobile = await context.newPage();
    watch(mobile, 'mobile');
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    const { code } = await createSession(page);
    await login(mobile, 'participant-a@workshop.test', PARTICIPANT_NAME, request);
    await noMobileOverflow(mobile);
    await joinSession(mobile, code);
    await noMobileOverflow(mobile);
    await openPreparedPractice(mobile, true);
    await noMobileOverflow(mobile);
    await publish(mobile, 'Участие с телефона: предложение сохранено в общей сессии.');
    await noMobileOverflow(mobile);
    await screenshot(mobile, info, 'mobile-shared-board.png');
    await sharedCard(mobile)
      .getByRole('button', { name: 'Открыть цитату', exact: true })
      .first()
      .click();
    await expect(
      reader(mobile).getByRole('textbox', { name: 'Номер страницы', exact: true }),
    ).toHaveValue('59');
    await noMobileOverflow(mobile);
    await screenshot(mobile, info, 'mobile-shared-source.png');
    await page.bringToFront();
    await expect(sharedCard(page)).toContainText(
      'Участие с телефона: предложение сохранено в общей сессии.',
    );
  } finally {
    await context.close();
  }
});

test('two independently authenticated windows expose a real revision conflict and retain the unsaved draft', async ({
  page,
  browser,
  request,
}, info) => {
  const firstContext = await freshContext(browser);
  const secondContext = await freshContext(browser);
  try {
    const first = await firstContext.newPage();
    watch(first, 'author-first');
    const second = await secondContext.newPage();
    watch(second, 'author-second');
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    const { code } = await createSession(page);
    await login(first, 'participant-a@workshop.test', PARTICIPANT_NAME, request);
    await joinSession(first, code);
    await openPreparedPractice(first);
    await publish(first, 'Исходный комментарий.');
    await login(second, 'participant-a@workshop.test', null, request);
    await second
      .getByRole('button', { name: `Открыть занятие «${SESSION_TITLE}»`, exact: true })
      .click();
    await expect(sharedCard(second)).toBeVisible();
    await sharedCard(first).getByRole('button', { name: 'Редактировать', exact: true }).click();
    await sharedCard(second).getByRole('button', { name: 'Редактировать', exact: true }).click();
    const firstEditor = first.getByRole('dialog', {
      name: 'Редактировать публикацию',
      exact: true,
    });
    const secondEditor = second.getByRole('dialog', {
      name: 'Редактировать публикацию',
      exact: true,
    });
    await firstEditor
      .getByRole('textbox', { name: 'Комментарий автора', exact: true })
      .fill('Сохранённая новая редакция.');
    const draft = 'Мой несохранённый текст из другого браузера.';
    await secondEditor
      .getByRole('textbox', { name: 'Комментарий автора', exact: true })
      .fill(draft);
    await firstEditor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    await expect(firstEditor).toBeHidden();
    await second.bringToFront();
    await expect(
      secondEditor.getByText('На доске уже есть более новая версия.', { exact: false }),
    ).toBeVisible();
    allowedConflictResponse = true;
    const rejectedSave = second.waitForResponse(
      (response) =>
        response.url() === `${GATEWAY_URL}/rest/v1/rpc/dw_publish_submission` &&
        response.request().method() === 'POST',
    );
    await secondEditor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    const rejection = await rejectedSave;
    expect(rejection.status()).toBe(400);
    expect((await rejection.json()).message).toMatch(/^REVISION_CONFLICT/);
    await expect(
      secondEditor.getByRole('textbox', { name: 'Комментарий автора', exact: true }),
    ).toHaveValue(draft);
    await expect(secondEditor.getByRole('alert')).toContainText(
      'Запись уже изменена в другом окне.',
    );
    await screenshot(second, info, 'revision-conflict-preserved-draft.png');
    await page.bringToFront();
    await expect(sharedCard(page)).toContainText('Сохранённая новая редакция.');
    await expect(sharedCard(page)).not.toContainText(draft);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});
