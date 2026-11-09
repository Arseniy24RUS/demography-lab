import { expect } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page, TestInfo } from '@playwright/test';

export const BASE_URL = 'http://127.0.0.1:4173';
export const GATEWAY_URL = 'http://127.0.0.1:54321';
export const WORKSHOP_TITLE = 'Мордовия · региональная мастерская';
export const HOST_NAME = 'Преподаватель региональной мастерской';
export const ALICE_NAME = 'Участница муниципальной команды';
export const BOB_NAME = 'Участник второй муниципальной команды';
export const MORDOVIA_TITLE = 'Компенсация родительской платы за детский сад';
export const SAKHALIN_TITLE = 'Компенсация родительской платы:20/50/100%';

export const navigation = (page: Page) => page.getByRole('navigation', { name: 'Основная навигация' });
export const reader = (page: Page) => page.getByRole('region', { name: 'Полный текст программы' });
export const inspector = (page: Page) => page.getByRole('complementary', { name: 'Связь цитаты и практики' });

export class BrowserAudit {
  private pages: Page[] = [];
  private runtime: string[] = [];
  private console: Array<{ url: string; text: string }> = [];
  private responses: Array<{ url: string; status: number }> = [];
  private expected = new Map<string, number[]>();

  watch(page: Page, label: string) {
    this.pages.push(page);
    page.on('pageerror', (error) => this.runtime.push(`${label}: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') this.console.push({ url: message.location().url, text: `${label}: ${message.text()}` });
    });
    page.on('response', (response) => {
      if (response.status() >= 400) this.responses.push({ url: response.url(), status: response.status() });
    });
  }

  /** Call only around a tested, asserted real SQL rejection, never to hide unrelated failures. */
  expectRejection(rpcName: string, statuses = [400, 403, 409]) {
    this.expected.set(`${GATEWAY_URL}/rest/v1/rpc/${rpcName}`, statuses);
  }

  async assertHealthy() {
    expect(this.runtime, 'Uncaught application errors').toEqual([]);
    expect(this.responses.filter((entry) => !this.expected.get(entry.url)?.includes(entry.status)), 'Unexpected HTTP errors').toEqual([]);
    expect(this.console.filter((entry) => !this.expected.has(entry.url)), 'Unexpected console errors').toEqual([]);
    for (const page of this.pages) if (!page.isClosed()) {
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await expect(page.locator('main')).not.toBeEmpty();
    }
  }
}

export async function fixture(request: APIRequestContext, path: string, data = {}) {
  const secret = process.env.WORKSHOP_TEST_ADMIN_SECRET;
  if (!secret || secret.length < 32) throw new Error('Fixture runner credential is missing.');
  const response = await request.post(`${GATEWAY_URL}/__test/${path}`, {
    headers: { 'X-Workshop-Test-Secret': secret }, data,
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

export async function freshContext(browser: Browser, mobile = false): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: BASE_URL,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    locale: 'ru-RU', timezoneId: 'Europe/Moscow', reducedMotion: 'reduce',
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
}

export async function login(page: Page, email: string, name: string | null, request: APIRequestContext) {
  await page.goto('/');
  await expect(page).toHaveTitle('Демографическая мастерская — документы и практики');
  await navigation(page).getByRole('button', { name: 'Занятия', exact: true }).click();
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
  await expect(page.getByRole('heading', { level: 2, name: 'Ваши занятия', exact: true })).toBeVisible();
}

export async function createSession(page: Page) {
  await page.getByRole('button', { name: 'Создать занятие', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новое занятие', exact: true });
  await dialog.getByRole('textbox', { name: 'Название занятия', exact: true }).fill(WORKSHOP_TITLE);
  await dialog.getByRole('combobox', { name: 'Уровень работы', exact: true }).selectOption('region');
  await dialog.getByRole('combobox', { name: 'Регион', exact: true }).selectOption('respublika-mordoviia');
  await dialog.getByRole('button', { name: 'Создать занятие', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Общая доска практик', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Код приглашения', exact: true }).click();
  const invitation = page.getByRole('dialog', { name: 'Пригласить участников', exact: true });
  const link = await invitation.getByRole('textbox', { name: 'Ссылка для участников', exact: true }).inputValue();
  const code = new URL(link).searchParams.get('join');
  expect(code).toMatch(/^[A-F0-9]{12}$/);
  await invitation.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  return { code: code!, sessionId: new URLSearchParams(new URL(page.url()).hash.slice(1)).get('session')! };
}

export async function joinSession(page: Page, code: string) {
  await page.getByRole('textbox', { name: 'Код занятия', exact: true }).fill(code);
  await page.getByRole('button', { name: 'Присоединиться', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Общая доска практик', exact: true })).toBeVisible();
}

export async function preparedPractice(page: Page, regionId: string, title: string, mobile = false) {
  await navigation(page).getByRole('button', { name: 'Практики', exact: true }).click();
  await page.getByRole('combobox', { name: 'Регион практики', exact: true }).selectOption(regionId);
  await page.getByRole('textbox', { name: 'Поиск практик', exact: true }).fill(title);
  const tile = page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await tile.getByRole('button', { name: 'Проверить', exact: true }).click();
  if (mobile) await page.getByRole('navigation', { name: 'Панели рабочей области' }).getByRole('button', { name: /^Связь(?:\s*\d+)?$/ }).click();
  await expect(inspector(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
}

export async function publishPractice(page: Page, title: string, note: string) {
  await inspector(page).getByRole('button', { name: 'Отправить в занятие', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Отправить практику в занятие', exact: true });
  await dialog.getByRole('textbox', { name: 'Комментарий для обсуждения', exact: true }).fill(note);
  await dialog.getByRole('button', { name: 'Опубликовать в занятии', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('article', { name: title, exact: true })).toContainText(note);
}

export async function openSessionAfterReload(page: Page) {
  await page.reload();
  await navigation(page).getByRole('button', { name: 'Занятия', exact: true }).click();
  const open = page.getByRole('button', { name: `Открыть занятие «${WORKSHOP_TITLE}»`, exact: true });
  await expect(page.getByRole('heading', { name: 'Общая доска практик', exact: true }).or(open)).toBeVisible();
  if (await open.isVisible()) await open.click();
}

export async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name);
  await page.screenshot({ path, animations: 'disabled', fullPage: false });
  await info.attach(name, { path, contentType: 'image/png' });
}

export async function noOverflow(page: Page, expectedWidth: number) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(dimensions.width).toBe(expectedWidth);
  expect(dimensions.document).toBeLessThanOrEqual(expectedWidth + 1);
  expect(dimensions.body).toBeLessThanOrEqual(expectedWidth + 1);
}

/** A narrow table cell can be unreadable without overflowing the viewport. */
export async function readableVariantColumns(page: Page) {
  const geometry = await page.locator('.workshop-comparison tbody tr').evaluateAll((rows) => rows
    .filter((row) => row.getBoundingClientRect().width > 0)
    .map((row) => ({
      row: row.getBoundingClientRect().width,
      heading: row.querySelector('th')?.getBoundingClientRect().width ?? 0,
    })));
  expect(geometry.length, 'Visible comparison rows').toBeGreaterThan(0);
  for (const size of geometry) expect(size.heading / size.row, 'Portrait variant heading must use the full row width').toBeGreaterThan(0.9);
}
