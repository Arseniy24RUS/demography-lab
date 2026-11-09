import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { RoadmapVersion } from '../../packages/roadmaps/types';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import {
  ALICE_NAME, HOST_NAME, WORKSHOP_TITLE, BrowserAudit, fixture, freshContext, login, joinSession,
  navigation, openSessionAfterReload, capture, noOverflow,
} from './browser-fixture';

const ARDATOV = 'Ардатовский муниципальный район';
const SARANSK = 'Городской округ Саранск';
let audit: BrowserAudit;

test.beforeEach(async ({ page, request }) => {
  await fixture(request, 'reset');
  audit = new BrowserAudit();
  audit.watch(page, 'desktop');
});
test.afterEach(async () => { await audit.assertHealthy(); });

async function tab(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).or(page.getByRole('button', { name, exact: true })).first().click();
}

async function createMunicipalSession(page: Page) {
  await page.getByRole('button', { name: 'Создать занятие', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новое занятие', exact: true });
  await dialog.getByRole('textbox', { name: 'Название занятия', exact: true }).fill(WORKSHOP_TITLE);
  await dialog.getByRole('combobox', { name: 'Уровень работы', exact: true }).selectOption('municipality');
  await dialog.getByRole('combobox', { name: 'Регион', exact: true }).selectOption('respublika-mordoviia');
  await dialog.getByRole('button', { name: 'Создать занятие', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Код приглашения', exact: true }).click();
  const invitation = page.getByRole('dialog', { name: 'Пригласить участников', exact: true });
  const link = await invitation.getByRole('textbox', { name: 'Ссылка для участников', exact: true }).inputValue();
  const code = new URL(link).searchParams.get('join');
  expect(code).toMatch(/^[A-F0-9]{12}$/u);
  await invitation.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  return code!;
}

async function territory(page: Page, name: string) {
  const button = page.locator('.rm-table-select').filter({ hasText: name });
  await expect(button).toHaveCount(1);
  await button.click();
  await expect(page.locator('.rm-territory-inspector').getByRole('heading', { name, exact: true })).toBeVisible();
}

async function roadmap(page: Page, name = ARDATOV) {
  await tab(page, 'Дорожные карты');
  await tab(page, 'Территория');
  await territory(page, name);
  const join = page.getByRole('button', { name: 'Создать команду территории', exact: true }).or(page.getByRole('button', { name: 'Присоединиться к команде', exact: true }));
  if (await join.count()) {
    await join.click();
    await expect(page.getByRole('heading', { name: 'Диагностика и сценарии', exact: true })).toBeVisible();
  } else {
    await page.getByRole('button', { name: 'Открыть дорожную карту', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Диагностика и сценарии', exact: true })).toBeVisible();
  }
}

async function saveDialog(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function downloadVersion(page: Page, format: 'DOCX' | 'PDF') {
  const material = page.waitForResponse(response => response.ok() && (
    response.url().endsWith('/dw_roadmap_version') ||
    (response.url().endsWith('/dw_entry_rpc') && response.request().postDataJSON()?.p_method === 'dw_roadmap_version')
  ));
  await expect(page.locator('.rm-version').first().getByRole('button', { name: /^(JSON|ZIP)$/u })).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.locator('.rm-version').first().getByRole('button', { name: format, exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  expect(bytes.length).toBeGreaterThan(500);
  const version = await (await material).json() as RoadmapVersion;
  return { bytes, filename: download.suggestedFilename(), version };
}

test('public source maps preserve missing values and known anomalies on desktop and touch width', async ({ page, browser }, info) => {
  await page.goto('/');
  await navigation(page).getByRole('button', { name: 'Территории', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Территории и исходные данные', exact: true })).toBeVisible();
  await expect(page.locator('.rm-territory-map .rm-map-shape')).toHaveCount(23);
  await territory(page, ARDATOV);
  await page.locator('.rm-map-topline').scrollIntoViewIfNeeded();
  await capture(page, info, 'stage5-mordovia-map-desktop.png');
  await expect(page.getByRole('img', { name: /Число родившихся: наблюдения/u })).toBeVisible();
  await page.getByLabel('Начало истории', { exact: true }).fill('2010');
  await page.getByLabel('Окончание истории', { exact: true }).fill('2023');
  await page.getByText('Точные значения и пропуски', { exact: true }).click();
  const values = page.locator('.rm-data-table table');
  await expect(values.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '2014', exact: true }) })).toContainText('253');
  await expect(values.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '2023', exact: true }) }).getByRole('cell').first()).toHaveText('Нет данных');
  await territory(page, SARANSK);
  await page.getByRole('combobox', { name: 'Показатель', exact: true }).selectOption('pop_mid');
  await expect(page.getByText(/изменение численности более чем на 50%/u)).toBeVisible();
  await page.getByText('Источник, определение и ограничения', { exact: true }).click();
  await expect(page.locator('.rm-source-details')).toContainText('Саранск, pop_mid');
  await expect(page.locator('.rm-source-details')).toContainText('27 766');
  await noOverflow(page, 1440);
  await capture(page, info, 'stage5-source-quality-desktop.png');

  const context = await freshContext(browser, true);
  const phone = await context.newPage(); audit.watch(phone, 'touch-source-map');
  try {
    await phone.goto('/');
    await navigation(phone).getByRole('button', { name: 'Территории', exact: true }).click();
    await expect(phone.locator('.rm-territory-map .rm-map-shape')).toHaveCount(23);
    await territory(phone, ARDATOV);
    await expect(phone.getByRole('img', { name: /Число родившихся: наблюдения/u })).toBeVisible();
    await noOverflow(phone, 390);
    await phone.locator('.rm-map-topline').scrollIntoViewIfNeeded();
    await capture(phone, info, 'stage5-source-map-touch.png');
    await audit.assertHealthy();
  } finally { await context.close(); }
});

test('desktop and touch accounts share one map, capture a fact, plan an activity and export an immutable version', async ({ page, browser, request }, info) => {
  await login(page, 'teacher@workshop.test', HOST_NAME, request);
  const code = await createMunicipalSession(page);
  await roadmap(page);
  const context = await freshContext(browser, true);
  const phone = await context.newPage(); audit.watch(phone, 'touch-team-member');
  let projector: Page | undefined;
  try {
    await login(phone, 'participant-a@workshop.test', ALICE_NAME, request);
    await joinSession(phone, code);
    await roadmap(phone);
    await tab(phone, 'Диагностика');
    await phone.getByLabel('Год факта', { exact: true }).selectOption('2014');
    await phone.getByLabel('Интерпретация для проекта', { exact: true }).fill('253 рождения в исходном ряду; это контекст проекта, а не оценка эффективности меры.');
    await phone.getByRole('button', { name: 'Закрепить факт', exact: true }).click();
    await expect(phone.getByText('Факт закреплён с его источником и значением.', { exact: true })).toBeVisible();
    await phone.locator('.rm-scenario-chart').scrollIntoViewIfNeeded();
    await noOverflow(phone, 390);
    await capture(phone, info, 'stage5-diagnostic-chart-touch.png');
    await tab(page, 'Диагностика');
    await expect(page.locator('.rm-small-card').filter({ hasText: '253 рождения в исходном ряду' })).toBeVisible();
    await page.getByLabel('Название', { exact: true }).fill('Учебный ориентир числа рождений');
    await page.getByLabel('Начало истории', { exact: true }).fill('2018');
    await page.getByLabel('Окончание истории', { exact: true }).fill('2022');
    await page.getByLabel('Горизонт сценария', { exact: true }).fill('2027');
    await page.getByRole('combobox', { name: 'Базовая траектория', exact: true }).selectOption('last_value');
    await page.getByRole('combobox', { name: 'Способ задания цели', exact: true }).selectOption('absolute_end');
    await page.getByLabel('Параметр целевого сценария', { exact: true }).fill('150');
    await page.getByLabel('Условия и допущения команды', { exact: true }).fill('Условный ориентир; проверка ресурсов и исходных данных продолжается.');
    await page.getByRole('button', { name: 'Сохранить сценарий', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Учебный ориентир числа рождений', exact: true })).toBeVisible();
    await page.locator('.rm-diagnostic-toolbar').scrollIntoViewIfNeeded();
    await capture(page, info, 'stage5-diagnostic-scenario-desktop.png');
    await page.getByRole('button', { name: 'Перенести ориентиры в показатель', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await saveDialog(page);
    await tab(page, 'Мероприятия');
    await page.getByRole('button', { name: 'Заполнить паспорт', exact: true }).click();
    const passport = page.getByRole('dialog');
    await passport.getByRole('textbox', { name: 'Название проекта', exact: true }).fill('Доступный вечерний присмотр');
    await passport.getByRole('textbox', { name: 'Целевая группа', exact: true }).fill('Работающие родители дошкольников со сменным графиком');
    await passport.getByRole('textbox', { name: 'Заинтересованные стороны и партнёры', exact: true }).fill('Родители, дошкольное учреждение и муниципальный координатор');
    await passport.getByRole('textbox', { name: 'Цель проекта', exact: true }).fill('Сократить неудовлетворённый спрос семей на присмотр за ребёнком после рабочего дня.');
    await passport.getByLabel('Начало проекта', { exact: true }).fill('2027-01-01');
    await passport.getByLabel('Окончание проекта', { exact: true }).fill('2027-12-31');
    await passport.getByRole('textbox', { name: 'Ожидаемый результат', exact: true }).fill('Проверенный спрос, согласованный график пилота и обратная связь семей.');
    await passport.getByRole('button', { name: 'Добавить задачу', exact: true }).click();
    await passport.getByLabel('Задача 1', { exact: true }).fill('Проверить потребность и организовать небольшой добровольный пилот.');
    await saveDialog(page);
    await page.getByRole('button', { name: 'Добавить мероприятие', exact: true }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Название мероприятия', { exact: true }).fill('Пилот вечернего присмотра');
    await editor.getByLabel('Содержание и механизм действия', { exact: true }).fill('Проверить спрос на дополнительные часы присмотра за детьми.');
    await editor.getByLabel('Начало мероприятия', { exact: true }).fill('2027-01-11');
    await editor.getByLabel('Окончание мероприятия', { exact: true }).fill('2027-03-31');
    await editor.getByLabel('Ответственный исполнитель', { exact: true }).fill('Координатор дошкольного образования');
    await editor.getByLabel('Проверяемый результат', { exact: true }).fill('График и отчёт пилота');
    await editor.getByLabel('Критерий завершения', { exact: true }).fill('Обсуждён отчёт с обратной связью родителей');
    await saveDialog(page);
    await tab(phone, 'Мероприятия');
    await expect(phone.getByRole('heading', { name: 'Пилот вечернего присмотра', exact: true })).toBeVisible();
    await noOverflow(phone, 390);
    await phone.locator('.rm-activity-card').scrollIntoViewIfNeeded();
    await capture(phone, info, 'stage5-shared-activity-touch.png');
    await openSessionAfterReload(phone);
    await tab(phone, 'Дорожные карты');
    await tab(phone, 'Мероприятия');
    await expect(phone.getByRole('heading', { name: 'Пилот вечернего присмотра', exact: true })).toBeVisible();
    await tab(page, 'Календарь и ресурсы');
    const bar = page.locator('.rm-gantt-bar');
    await bar.focus();
    await bar.press('Shift+ArrowRight');
    const move = page.getByRole('dialog', { name: 'Перенос сроков мероприятия', exact: true });
    await expect(move.getByLabel('Сдвиг в календарных днях', { exact: true })).toHaveValue('7');
    await move.getByRole('button', { name: 'Сохранить перенос', exact: true }).click();
    await expect(move).toBeHidden();
    await page.getByRole('button', { name: 'Добавить затраты', exact: true }).click();
    const costs = page.getByRole('dialog');
    await costs.getByLabel('Статья затрат', { exact: true }).fill('Пробные часы');
    await costs.getByLabel('Год расходов', { exact: true }).fill('2027');
    await costs.getByLabel('Единица расчёта', { exact: true }).fill('час');
    await costs.getByLabel('Количество', { exact: false }).fill('0,333');
    await costs.getByLabel('Стоимость единицы, ₽', { exact: true }).fill('10,01');
    await costs.getByLabel('Число повторений / периодов', { exact: true }).fill('3');
    await costs.getByLabel('Источник цены', { exact: true }).fill('Учебная оценка для проверки точности расчёта');
    await saveDialog(page);
    await expect(page.locator('.rm-budget-totals').locator('div').filter({ hasText: 'Денежная потребность' })).toContainText('10');
    await page.getByRole('button', { name: 'Добавить финансирование', exact: true }).click();
    const funding = page.getByRole('dialog');
    await funding.getByLabel('Источник средств', { exact: true }).fill('Учебное подтверждение');
    await funding.getByLabel('Сумма, ₽', { exact: true }).fill('4,00');
    await funding.getByRole('combobox', { name: 'Статус финансирования', exact: true }).selectOption('confirmed');
    await funding.getByLabel('Подтверждающий документ', { exact: false }).fill('Учебный документ, не реальный бюджетный акт');
    await funding.getByLabel('Дата документа', { exact: true }).fill('2026-11-08');
    await saveDialog(page);
    await noOverflow(page, 1440);
    await capture(page, info, 'stage5-calendar-budget-desktop.png');
    await page.locator('.rm-gantt-scroll').scrollIntoViewIfNeeded();
    await capture(page, info, 'stage5-calendar-gantt-desktop.png');
    await tab(page, 'Проверка и экспорт');
    await page.locator('.rm-readiness-overview').scrollIntoViewIfNeeded();
    await capture(page, info, 'stage5-readiness-desktop.png');
    await page.getByRole('button', { name: 'Зафиксировать черновик', exact: true }).click();
    const freeze = page.getByRole('dialog', { name: 'Зафиксировать рабочую версию', exact: true });
    await freeze.getByLabel('Название версии', { exact: true }).fill('Первая командная версия');
    await freeze.getByRole('button', { name: 'Зафиксировать версию', exact: true }).click();
    await expect(freeze).toBeHidden();
    await expect(page.locator('.rm-version').getByRole('heading', { name: 'Первая командная версия', exact: true })).toBeVisible();
    const word = await downloadVersion(page, 'DOCX');
    const json = word.version;
    expect(createHash('sha256').update(json.canonicalJson).digest('hex')).toBe(json.sha256);
    expect(JSON.parse(json.canonicalJson)).toEqual(json.snapshot);
    expect(json.snapshot.territory.key).toBe('rudn-mun-72196-894');
    expect(json.snapshot.teamNames).toEqual(expect.arrayContaining([HOST_NAME, ALICE_NAME]));
    expect(json.snapshot.items.find((item) => item.kind === 'fact')).toMatchObject({ data: { value: 253 } });
    expect(json.snapshot.items.find((item) => item.kind === 'activity')).toMatchObject({ data: { startDate: '2027-01-18' } });
    expect(json.snapshot.items.find((item) => item.kind === 'cost')).toMatchObject({ data: { quantity: '0.333' } });
    expect(json.snapshot.budget.needCashKopecks).toBe(1000);
    expect(json.snapshot.budget.confirmedKopecks).toBe(400);
    expect(json.snapshot.budget.confirmedGapKopecks).toBe(600);
    expect(json.snapshot.series[0].provenanceStatus).toBe('incomplete_primary');
    expect(word.filename).toMatch(/\.docx$/u);
    const zip = unzipSync(new Uint8Array(word.bytes));
    expect(strFromU8(zip['word/document.xml']!)).toContain('Ардатовский');
    const pdf = await downloadVersion(page, 'PDF');
    expect(pdf.filename).toMatch(/\.pdf$/u);
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.version.canonicalJson).toBe(json.canonicalJson);
    await capture(page, info, 'stage5-immutable-version-desktop.png');
    await tab(page, 'Мероприятия');
    await page.locator('.rm-activity-card').getByRole('button', { name: 'Изменить', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Название мероприятия', { exact: true }).fill('Изменение после фиксации версии');
    await saveDialog(page);
    await tab(page, 'Проверка и экспорт');
    const repeated = (await downloadVersion(page, 'DOCX')).version;
    expect(repeated.canonicalJson).toBe(json.canonicalJson);
    expect(repeated.sha256).toBe(json.sha256);
    const projectorRequests: string[] = [];
    const projectorPayloads: Array<Promise<unknown>> = [];
    page.context().once('page', opened => {
      audit.watch(opened, 'roadmaps-projector');
      opened.on('request', outgoing => { if (outgoing.url().includes('/rest/v1/rpc/')) projectorRequests.push(outgoing.url()); });
      opened.on('response', response => { if (response.url().endsWith('/dw_roadmaps_projector_snapshot') && response.ok()) projectorPayloads.push(response.json()); });
    });
    const opened = page.context().waitForEvent('page');
    await page.getByRole('button', { name: 'Экран проектора', exact: true }).click();
    projector = await opened;
    await projector.getByRole('navigation', { name: 'Сцены проектора', exact: true }).getByRole('button', { name: 'Дорожные карты', exact: true }).click();
    await expect(projector.getByRole('combobox', { name: 'Дорожная карта для проектора', exact: true })).toBeVisible();
    await projector.getByRole('combobox', { name: 'Дорожная карта для проектора', exact: true }).selectOption({ label: ARDATOV });
    await expect(projector.getByRole('heading', { name: 'Изменение после фиксации версии', exact: true })).toBeVisible();
    await expect(projector.getByRole('img', { name: /Число родившихся: наблюдения/u })).toBeVisible();
    await expect.poll(() => projectorPayloads.length).toBeGreaterThan(0);
    for (const payload of await Promise.all(projectorPayloads)) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toMatch(/"(?:userId|createdBy|updatedBy|createdByName|updatedByName|members|teamNames|email|responseSecret|answerBarrier|answerSupport)"\s*:/u);
    }
    expect(projectorRequests.some(url => /\/(?:dw_session_snapshot|dw_roadmap_snapshot|dw_roadmaps_index|dw_barriers_snapshot|dw_invitation)$/u.test(url))).toBe(false);
    const shown = await projector.locator('main').innerText();
    for (const privateText of [HOST_NAME, ALICE_NAME, 'teacher@workshop.test', 'participant-a@workshop.test', code]) expect(shown).not.toContain(privateText);
    await capture(projector, info, 'stage5-projector-source-scenario.png');
    await audit.assertHealthy();
  } finally { await projector?.close(); await context.close(); }
});

test('conflicting edits preserve the unsaved draft and require an explicit reconciliation', async ({ page, browser, request }, info) => {
  await login(page, 'teacher@workshop.test', HOST_NAME, request);
  const code = await createMunicipalSession(page);
  await roadmap(page);
  const context = await freshContext(browser);
  const other = await context.newPage(); audit.watch(other, 'concurrent-author');
  try {
    await login(other, 'participant-a@workshop.test', ALICE_NAME, request);
    await joinSession(other, code);
    await roadmap(other);
    for (const editorPage of [page, other]) {
      await tab(editorPage, 'Мероприятия');
      await editorPage.getByRole('button', { name: 'Заполнить паспорт', exact: true }).click();
    }
    await other.getByRole('dialog').getByRole('textbox', { name: 'Цель проекта', exact: true }).fill('Мой несохранённый вариант цели');
    await page.getByRole('dialog').getByRole('textbox', { name: 'Цель проекта', exact: true }).fill('Уточнённая цель преподавателя');
    await saveDialog(page);
    const dialog = other.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Эту запись изменил другой участник', exact: true })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Цель проекта', exact: true })).toHaveValue('Мой несохранённый вариант цели');
    await expect(dialog.getByRole('button', { name: 'Сохранить изменения', exact: true })).toBeDisabled();
    await expect(dialog.locator('.rm-conflict')).toContainText('Уточнённая цель преподавателя');
    await capture(other, info, 'stage5-revision-conflict.png');
    await dialog.getByRole('button', { name: 'Загрузить значения команды', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Цель проекта', exact: true })).toHaveValue('Уточнённая цель преподавателя');
    await dialog.getByRole('textbox', { name: 'Цель проекта', exact: true }).fill('Совместно согласованная цель после сравнения');
    await saveDialog(other);
    await expect(page.locator('.rm-passport')).toContainText('Совместно согласованная цель после сравнения');
    await audit.assertHealthy();
  } finally { await context.close(); }
});
