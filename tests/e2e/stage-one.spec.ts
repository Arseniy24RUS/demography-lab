import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';

const MORDOVIA = 'Республика Мордовия';
const PRACTICE_TITLE = 'Компенсация родительской платы за детский сад';
const QUERY = 'компенсация платы, взимаемой';
const PROFILE_NAME = 'Учебный участник E2E';
const PROFILE_EMAIL = 'e2e@example.invalid';

const reader = (page: Page): Locator => page.getByRole('region', { name: 'Полный текст программы' });
const inspector = (page: Page): Locator => page.getByRole('complementary', { name: 'Связь цитаты и практики' });
const navigation = (page: Page): Locator => page.getByRole('navigation', { name: 'Основная навигация' });

let runtimeErrors: string[];
let consoleErrors: string[];
let consoleWarnings: string[];

function attachDiagnostics(page: Page): void {
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
    if (message.type() === 'warning') consoleWarnings.push(message.text());
  });
}

test.beforeEach(async ({ page }) => {
  runtimeErrors = [];
  consoleErrors = [];
  consoleWarnings = [];
  attachDiagnostics(page);
  await page.goto('/');
  await expect(page).toHaveTitle('Демографическая мастерская — документы и практики');
  await expect(page.getByRole('heading', { level: 1, name: 'Документы и практики' })).toBeVisible();
  await expect(reader(page).getByRole('textbox', { name: 'Поиск в полном тексте' })).toBeEnabled();
  await expect(reader(page).getByRole('textbox', { name: 'Номер страницы' })).toHaveValue('1');
});

test.afterEach(async ({ page }, testInfo) => {
  if (consoleWarnings.length) {
    await testInfo.attach('browser-console-warnings', { body: JSON.stringify(consoleWarnings, null, 2), contentType: 'application/json' });
  }
  expect(runtimeErrors, 'Uncaught browser runtime errors').toEqual([]);
  expect(consoleErrors, 'Browser console errors').toEqual([]);
  // A framework overlay has no application role; this diagnostic selector is intentional.
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

async function saveScreenshot(page: Page, testInfo: TestInfo, name: string, fullPage = false): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function searchAndOpenPage59(page: Page): Promise<void> {
  const source = reader(page);
  await source.getByRole('textbox', { name: 'Поиск в полном тексте' }).fill(QUERY);
  await expect(source.getByText('Найдено 1', { exact: true })).toBeVisible();
  const hit = source.getByRole('button', { name: /^Страница 59\b/ });
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText('взимаемой с родителей');
  await hit.click();
  await expect(source.getByRole('textbox', { name: 'Номер страницы' })).toHaveValue('59');
  await expect(source.getByRole('article', { name: 'Страница 59', exact: true })).toBeVisible();
  await expect(source.getByRole('article', { name: 'Страница 1', exact: true })).toHaveCount(0);
  await expect(source.getByRole('link', { name: 'Оригинал', exact: true })).toHaveAttribute('href', /regional-respublika-mordoviia\.pdf#page=59$/);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const expectedWidth = page.viewportSize()!.width;
  const widths = await page.evaluate((width) => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    overflowing: Array.from(document.querySelectorAll('body *')).filter((el) => el.getBoundingClientRect().right > width + 1).slice(-8).map((el) => ({ class: el.getAttribute('class'), text: el.textContent?.slice(0, 80), right: el.getBoundingClientRect().right })),
  }), expectedWidth);
  expect(widths.viewport, JSON.stringify(widths.overflowing)).toBe(expectedWidth);
  expect(widths.document, `Document width ${widths.document} exceeds viewport ${widths.viewport}`).toBeLessThanOrEqual(widths.viewport + 1);
  expect(widths.body, `Body width ${widths.body} exceeds viewport ${widths.viewport}`).toBeLessThanOrEqual(widths.viewport + 1);
}

async function createVerifiedRecipientLink(page: Page): Promise<void> {
  await navigation(page).getByRole('button', { name: 'Практики', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Региональные практики' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Регион практики' }).selectOption('respublika-mordoviia');
  await page.getByRole('textbox', { name: 'Поиск практик' }).fill(PRACTICE_TITLE);
  const tile = page.getByRole('article').filter({ has: page.getByRole('heading', { name: PRACTICE_TITLE, exact: true }) });
  await expect(tile).toHaveCount(1);
  await tile.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(inspector(page).getByRole('heading', { name: PRACTICE_TITLE, exact: true })).toBeVisible();
  await inspector(page).getByRole('button', { name: 'Открыть точную цитату', exact: true }).first().click();
  await expect(page).toHaveURL(/#document=regional-respublika-mordoviia$/);
  await expect(reader(page).getByRole('textbox', { name: 'Номер страницы' })).toHaveValue('59');
  await expect(reader(page).getByRole('article', { name: 'Страница 59', exact: true })).toContainText('компенсация платы, взимаемой с родителей');

  // This accessible label identifies the real paragraph on p. 59 of the pinned edition.
  // No DOM range, annotation, IndexedDB record or source response is fabricated.
  await reader(page).getByRole('button', { name: 'Выбрать фрагмент 604', exact: true }).click();
  await expect(reader(page).getByRole('button', { name: 'Убрать фрагмент 604', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(reader(page).getByText('Выбрано фрагментов: 1', { exact: true })).toBeVisible();
  const save = inspector(page).getByRole('button', { name: 'Подтвердить связь', exact: true });
  await expect(save).toBeDisabled();
  await inspector(page).getByRole('combobox', { name: 'Проверка поля Получатели', exact: true }).selectOption('supports');
  await inspector(page).getByRole('textbox', { name: 'Обоснование связи' }).fill('Фрагмент называет родителей детей в государственных и муниципальных дошкольных организациях.');
  await expect(save).toBeDisabled();
  await inspector(page).getByRole('checkbox', { name: 'Сопоставил выбранные поля с цитатой и её контекстом' }).check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Связь и проверка выбранных полей сохранены.' })).toBeVisible();
  await expect(inspector(page).getByText('Проверено по цитате', { exact: true })).toHaveCount(1);

}

async function saveUnlinkedQuotation(page: Page, fragmentNumber: number, comment: string): Promise<void> {
  await reader(page).getByRole('button', { name: `Выбрать фрагмент ${fragmentNumber}`, exact: true }).click();
  await reader(page).getByRole('button', { name: 'Сохранить цитату без карточки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Сохранить цитату', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Комментарий к фрагменту', exact: true }).fill(comment);
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Цитата сохранена в разделе «Моя работа».' })).toBeVisible();
}

async function downloadArchive(page: Page, testInfo: TestInfo, name: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Сохранить архив работы', exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  const path = testInfo.outputPath(name);
  await download.saveAs(path);
  const archive = unzipSync(new Uint8Array(readFileSync(path)));
  expect(archive['workspace.json']).toBeDefined();
  const json = strFromU8(archive['workspace.json']!);
  return { path, json, exported: JSON.parse(json) };
}

test('Mordovia loads and full-document search reaches a page that was not rendered', async ({ page }, testInfo) => {
  const library = page.getByRole('complementary', { name: 'Библиотека программ' });
  await expect(library.getByRole('button', { name: /^Республика Мордовия/ })).toHaveAttribute('aria-current', 'true');
  await expect(library.getByRole('button', { name: 'С текстом · 80', exact: true })).toBeVisible();
  await expect(reader(page).getByText(MORDOVIA, { exact: true })).toBeVisible();
  await expect(reader(page).getByText('из 137', { exact: true })).toBeVisible();
  await saveScreenshot(page, testInfo, 'desktop-initial-mordovia.png');
  await searchAndOpenPage59(page);
  await expect(inspector(page).getByText('Текст и позиции совпадают с выбранной редакцией')).toBeVisible();
  await saveScreenshot(page, testInfo, 'desktop-full-document-search.png');
});

test('practice → citation → selected block → field review survives a real reload', async ({ page }, testInfo) => {
  await createVerifiedRecipientLink(page);

  await navigation(page).getByRole('button', { name: 'Моя работа', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Сохранённые цитаты 1', exact: true })).toBeVisible();
  await expect(page.getByText('Поля проверены', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Документы и практики' })).toBeVisible();
  await navigation(page).getByRole('button', { name: 'Моя работа', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Сохранённые цитаты 1', exact: true })).toBeVisible();
  await expect(page.getByText('Поля проверены', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: PRACTICE_TITLE, exact: true }).click();
  await expect(inspector(page).getByRole('heading', { name: PRACTICE_TITLE, exact: true })).toBeVisible();
  await expect(inspector(page).getByText('Проверено по цитате', { exact: true })).toHaveCount(1);
  await expect(reader(page).getByRole('textbox', { name: 'Номер страницы' })).toHaveValue('59');
  await saveScreenshot(page, testInfo, 'desktop-review-after-reload.png');
});

test('the real ZIP download contains the saved quotation and excludes the entered local profile', async ({ page }, testInfo) => {
  await reader(page).getByRole('button', { name: 'Выбрать фрагмент 1', exact: true }).click();
  await reader(page).getByRole('button', { name: 'Сохранить цитату без карточки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Сохранить цитату', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Комментарий к фрагменту', exact: true }).fill('Контрольная цитата для переноса рабочей тетради.');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toBeHidden();
  await navigation(page).getByRole('button', { name: 'Моя работа', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Сохранённые цитаты 1', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'ФИО', exact: true }).fill(PROFILE_NAME);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(PROFILE_EMAIL);
  await page.getByRole('button', { name: 'Сохранить сведения', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Сведения сохранены на этом устройстве.' })).toBeVisible();

  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Сохранить архив работы', exact: true }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toMatch(/^demography-workspace-\d{4}-\d{2}-\d{2}\.zip$/);
  expect(await download.failure()).toBeNull();
  const archivePath = testInfo.outputPath('downloaded-workspace.zip');
  await download.saveAs(archivePath);
  const archive = unzipSync(new Uint8Array(readFileSync(archivePath)));
  expect(Object.keys(archive).sort()).toEqual(['README.txt', 'workspace.json']);
  const json = strFromU8(archive['workspace.json']!);
  const exported = JSON.parse(json);
  expect(exported.format).toBe('demography-workshop.workspace');
  expect(exported.schemaVersion).toBe(1);
  expect(exported.workspace.annotations).toHaveLength(1);
  expect(exported.workspace.annotations[0].note).toBe('Контрольная цитата для переноса рабочей тетради.');
  expect(exported.workspace.annotations[0].anchor.documentId).toBe('regional-respublika-mordoviia');
  expect(exported.workspace.annotations[0].anchor.versionId).toMatch(/^regional-respublika-mordoviia@layout-canonical-v2-/);
  expect(exported.workspace.annotations[0].anchor.spans[0].exact).toContain('Постановление Правительства Республики Мордовия');
  expect(exported.workspace.sourceReferences).toHaveLength(1);
  expect(exported.workspace.sourceReferences[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(exported.workspace.profile).toBeNull();
  expect(json).not.toContain(PROFILE_NAME);
  expect(json).not.toContain(PROFILE_EMAIL);
  await testInfo.attach('downloaded-workspace.zip', { path: archivePath, contentType: 'application/zip' });
});

test('a downloaded archive imports in a clean context and downgrades verification while preserving citations', async ({ page, browser }, testInfo) => {
  await createVerifiedRecipientLink(page);
  const original = await downloadArchive(page, testInfo, 'original-verified-workspace.zip');
  expect(original.exported.workspace.linkDecisions).toHaveLength(1);
  expect(original.exported.workspace.linkDecisions[0].status).toBe('verified');
  expect(original.exported.workspace.linkDecisions[0].fieldEvidence[0].reviewStatus).toBe('verified');

  const receiver = await browser.newContext({ baseURL: new URL('/', page.url()).origin, viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', acceptDownloads: true, reducedMotion: 'reduce' });
  try {
    const second = await receiver.newPage();
    attachDiagnostics(second);
    await second.goto('/');
    await expect(second.getByRole('heading', { level: 1, name: 'Документы и практики' })).toBeVisible();
    await navigation(second).getByRole('button', { name: 'Моя работа', exact: true }).click();
    await expect(second.getByRole('heading', { name: 'Сохранённые цитаты 0', exact: true })).toBeVisible();

    const pendingChooser = second.waitForEvent('filechooser');
    await second.getByRole('button', { name: 'Импортировать работу', exact: true }).click();
    const chooser = await pendingChooser;
    await chooser.setFiles(original.path);
    const dialog = second.getByRole('dialog', { name: 'Добавить работу из архива', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('row', { name: 'Цитаты 1', exact: true })).toBeVisible();
    await expect(dialog.getByRole('row', { name: 'Решения по связям 1', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Добавить к моей работе', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(second.getByRole('heading', { name: 'Сохранённые цитаты 1', exact: true })).toBeVisible();
    await expect(second.getByText('Импорт · проверить', { exact: true })).toBeVisible();
    await expect(second.getByText('Поля проверены', { exact: true })).toHaveCount(0);
    await second.getByRole('button', { name: PRACTICE_TITLE, exact: true }).click();
    await expect(reader(second).getByRole('textbox', { name: 'Номер страницы' })).toHaveValue('59');
    await expect(inspector(second).getByText('Проверено по цитате', { exact: true })).toHaveCount(0);
    await expect(reader(second).getByRole('link', { name: 'Оригинал', exact: true })).toHaveAttribute('href', /regional-respublika-mordoviia\.pdf#page=59$/);

    const imported = await downloadArchive(second, testInfo, 'received-candidate-workspace.zip');
    expect(imported.exported.workspace.annotations[0].anchor).toEqual(original.exported.workspace.annotations[0].anchor);
    expect(imported.exported.workspace.sourceReferences).toEqual(original.exported.workspace.sourceReferences);
    expect(imported.exported.workspace.linkDecisions[0].status).toBe('candidate');
    expect(imported.exported.workspace.linkDecisions[0].origin).toBe('imported');
    expect(imported.exported.workspace.linkDecisions[0].fieldEvidence[0].reviewStatus).toBe('candidate');
    expect(imported.exported.workspace.linkDecisions[0].fieldEvidence[0].reviewedValue).toBe(original.exported.workspace.linkDecisions[0].fieldEvidence[0].reviewedValue);
    await expect(second.locator('vite-error-overlay')).toHaveCount(0);
    await saveScreenshot(second, testInfo, 'archive-import-review-required.png');
  } finally {
    await receiver.close();
  }
});

test('two real tabs receive each other’s saved quotations without reloading and retain both in IndexedDB', async ({ page, context }) => {
  const other = await context.newPage();
  attachDiagnostics(other);
  try {
    await other.goto('/');
    await expect(other.getByRole('heading', { level: 1, name: 'Документы и практики' })).toBeVisible();
    await expect(reader(other).getByRole('textbox', { name: 'Поиск в полном тексте' })).toBeEnabled();
    await navigation(other).getByRole('button', { name: 'Моя работа', exact: true }).click();
    await expect(other.getByRole('heading', { name: 'Сохранённые цитаты 0', exact: true })).toBeVisible();
    let otherNavigations = 0;
    const onOtherNavigation = (frame: import('@playwright/test').Frame) => { if (frame === other.mainFrame()) otherNavigations += 1; };
    other.on('framenavigated', onOtherNavigation);

    await saveUnlinkedQuotation(page, 1, 'Цитата сохранена в первой вкладке.');
    await expect(other.getByRole('heading', { name: 'Сохранённые цитаты 1', exact: true })).toBeVisible();
    await expect(other.getByText('Цитата сохранена в первой вкладке.', { exact: true })).toBeVisible();
    expect(otherNavigations, 'Second tab must update without reload or navigation').toBe(0);
    other.off('framenavigated', onOtherNavigation);

    await navigation(page).getByRole('button', { name: 'Моя работа', exact: true }).click();
    await navigation(other).getByRole('button', { name: 'Документы', exact: true }).click();
    let firstNavigations = 0;
    const onFirstNavigation = (frame: import('@playwright/test').Frame) => { if (frame === page.mainFrame()) firstNavigations += 1; };
    page.on('framenavigated', onFirstNavigation);
    await saveUnlinkedQuotation(other, 2, 'Цитата сохранена во второй вкладке.');
    await expect(page.getByRole('heading', { name: 'Сохранённые цитаты 2', exact: true })).toBeVisible();
    await expect(page.getByText('Цитата сохранена в первой вкладке.', { exact: true })).toBeVisible();
    await expect(page.getByText('Цитата сохранена во второй вкладке.', { exact: true })).toBeVisible();
    expect(firstNavigations, 'First tab must receive the reverse notification without reload').toBe(0);
    page.off('framenavigated', onFirstNavigation);

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Документы и практики' })).toBeVisible();
    await navigation(page).getByRole('button', { name: 'Моя работа', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Сохранённые цитаты 2', exact: true })).toBeVisible();
    await expect(page.getByText('Цитата сохранена в первой вкладке.', { exact: true })).toBeVisible();
    await expect(page.getByText('Цитата сохранена во второй вкладке.', { exact: true })).toBeVisible();
    await expect(other.locator('vite-error-overlay')).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('the card modal traps keyboard focus, updates the tab order and returns focus on Escape', async ({ page }) => {
  const originalOverflow = await page.evaluate(() => document.body.style.overflow);
  const opener = inspector(page).getByRole('button', { name: 'Создать карточку', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Новая карточка практики', exact: true });
  const close = dialog.getByRole('button', { name: 'Закрыть окно', exact: true });
  const cancel = dialog.getByRole('button', { name: 'Отмена', exact: true });
  const save = dialog.getByRole('button', { name: 'Сохранить карточку', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(close).toBeFocused();
  await expect(save).toBeDisabled();
  await page.keyboard.press('Shift+Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('textbox', { name: 'Название практики', exact: true })).toBeFocused();
  await page.keyboard.type('Учебная проверка клавиатуры');
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('textbox', { name: 'Механизм поддержки', exact: true })).toBeFocused();
  await page.keyboard.type('Проверка доступного ввода и сохранения фокуса в окне.');
  await expect(save).toBeEnabled();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(save).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe(originalOverflow);
});

test.describe('mobile Chromium viewport 390 × 844', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });

  test('reader, evidence and the local atlas remain usable at 390 and 320 px without horizontal overflow', async ({ page }, testInfo) => {
    const panels = page.getByRole('navigation', { name: 'Панели рабочей области' });
    await expect(panels.getByRole('button', { name: 'Документ', exact: true })).toHaveAttribute('aria-current', 'true');
    await expect(reader(page)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await saveScreenshot(page, testInfo, 'mobile-initial-390.png');

    await panels.getByRole('button', { name: 'Библиотека', exact: true }).tap();
    const library = page.getByRole('complementary', { name: 'Библиотека программ' });
    await expect(library).toBeVisible();
    await library.getByRole('textbox', { name: 'Найти программу', exact: true }).fill('Мордовия');
    await expectNoHorizontalOverflow(page);
    await library.getByRole('button', { name: /^Республика Мордовия/ }).tap();
    await expect(reader(page)).toBeVisible();
    await searchAndOpenPage59(page);
    await reader(page).getByRole('button', { name: 'Выбрать фрагмент 604', exact: true }).tap();
    await reader(page).getByRole('button', { name: 'Связать', exact: true }).tap();
    await expect(inspector(page)).toBeVisible();
    const candidate = inspector(page).getByRole('button', { name: /^Компенсация родительской платы за детский сад.*Есть фрагмент в этой редакции/ });
    await expect(candidate).toHaveCount(1);
    await candidate.tap();
    await expect(inspector(page).getByRole('heading', { name: PRACTICE_TITLE, exact: true })).toBeVisible();
    await expect(inspector(page).getByRole('combobox', { name: 'Проверка поля Получатели', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await saveScreenshot(page, testInfo, 'mobile-evidence-390.png', true);
    await page.setViewportSize({ width: 320, height: 750 });
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Карта программ', exact: true }).tap();
    const atlas = page.getByRole('dialog', { name: 'Карта региональных программ', exact: true });
    await expect(atlas).toBeVisible();
    await expect(atlas.locator('.geo-region')).toHaveCount(89);
    await expectNoHorizontalOverflow(page);
    await saveScreenshot(page, testInfo, 'mobile-local-atlas-320.png', true);
    await atlas.getByRole('button', { name: 'Открыть программу', exact: true }).tap();
    await expect(atlas).toBeHidden();
    await expect(reader(page)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test('a controlled IndexedDB quota failure leaves an honest error state and never persists the entered profile', async ({ page }, testInfo) => {
  await navigation(page).getByRole('button', { name: 'Моя работа', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'ФИО', exact: true });
  const email = page.getByRole('textbox', { name: 'Email', exact: true });
  const footer = page.getByRole('contentinfo');
  const save = page.getByRole('button', { name: 'Сохранить сведения', exact: true });
  const unsavedName = 'Профиль после отказа хранилища';
  const unsavedEmail = 'unsaved-profile@example.invalid';
  await expect(name).toHaveValue('');
  await expect(email).toHaveValue('');
  await expect(footer.getByText('Работа сохраняется на этом устройстве', { exact: true })).toBeVisible();
  await name.fill(unsavedName);
  await email.fill(unsavedEmail);
  await expect(save).toBeEnabled();

  // Deliberate negative-path fault injection into a PUBLIC browser API, only after
  // normal bootstrap has durably created the workspace. No state or response is faked.
  // Keeping the original property descriptor also restores native method attributes.
  const fault = await page.evaluateHandle(() => {
    const prototype = IDBObjectStore.prototype;
    const original = Object.getOwnPropertyDescriptor(prototype, 'put');
    if (!original || typeof original.value !== 'function') throw new Error('Native IndexedDB put is unavailable.');
    let attempts = 0;
    Object.defineProperty(prototype, 'put', {
      ...original,
      value: function controlledQuotaFailure() {
        attempts += 1;
        throw new DOMException('Intentional E2E quota failure after bootstrap.', 'QuotaExceededError');
      },
    });
    return {
      attempts: () => attempts,
      restore: () => { Object.defineProperty(prototype, 'put', original); },
    };
  });

  try {
    await save.click();
    await expect.poll(() => fault.evaluate(state => state.attempts()), { message: 'Saving must actually reach the failing IndexedDB API.' }).toBeGreaterThan(0);
    await expect(page.getByRole('alert').filter({ hasText: 'Не удалось сохранить рабочую тетрадь в этом браузере.' }).first()).toBeVisible();
    await expect(footer.getByText('Изменения не сохранены — проверьте сообщение', { exact: true })).toBeVisible();
    await expect(footer.getByText('Работа сохраняется на этом устройстве', { exact: true })).toHaveCount(0);

    // The indicator is decorative, so its concrete styling is a diagnostic selector.
    const indicator = footer.locator('.save-dot');
    const errorColor = await page.evaluate(() => {
      const token = getComputedStyle(document.documentElement).getPropertyValue('--red').trim();
      const channels = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(token);
      if (!channels) throw new Error('The current --red design token must be a six-digit color.');
      return `rgb(${channels.slice(1).map(channel => parseInt(channel, 16)).join(', ')})`;
    });
    await expect(indicator).toHaveClass(/\berror\b/);
    await expect(indicator).toHaveCSS('background-color', errorColor);
    await expect(name).toHaveValue(unsavedName);
    await expect(email).toHaveValue(unsavedEmail);
    await expect(save).toBeEnabled();
    await expect(page.getByRole('status').filter({ hasText: 'Сведения сохранены на этом устройстве.' })).toHaveCount(0);
    await saveScreenshot(page, testInfo, 'indexeddb-quota-failure-visible.png');
  } finally {
    await fault.evaluate(state => state.restore());
    await fault.dispose();
  }

  // A fresh document now uses the restored native API and the previously committed DB.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Документы и практики' })).toBeVisible();
  await navigation(page).getByRole('button', { name: 'Моя работа', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'ФИО', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toHaveValue('');
  await expect(page.getByRole('contentinfo').getByText('Работа сохраняется на этом устройстве', { exact: true })).toBeVisible();
  await expect(page.getByRole('contentinfo').getByText('Изменения не сохранены — проверьте сообщение', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Сведения сохранены на этом устройстве.' })).toHaveCount(0);
});
