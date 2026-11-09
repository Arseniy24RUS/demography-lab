import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import type { RoadmapSnapshot, RoadmapVersion } from '../../packages/roadmaps/types';
import {
  ALICE_NAME,
  HOST_NAME,
  WORKSHOP_TITLE,
  BrowserAudit,
  fixture,
  freshContext,
  login,
  joinSession,
  openSessionAfterReload,
  capture,
  noOverflow,
} from './browser-fixture';

const ARDATOV = 'Ардатовский муниципальный район';
const NO_SOURCE_TERRITORY = 'Георгиевский муниципальный округ';
const SOURCE = 'Годовая сводка муниципалитета, уточнённая по данным отдела статистики';
const REASON = 'Включены уточнённые сведения и новый доступный год.';
let audit: BrowserAudit;

test.beforeEach(async ({ page, request }) => {
  await fixture(request, 'reset');
  audit = new BrowserAudit();
  audit.watch(page, 'desktop-statistics');
});
test.afterEach(async () => {
  await audit.assertHealthy();
});

function observeSnapshot(page: Page) {
  const state: { current: RoadmapSnapshot | null } = { current: null };
  page.on('response', (response) => {
    if (
      response.ok() &&
      /\/(?:dw_roadmap_snapshot|dw_join_roadmap|dw_save_roadmap_item|dw_capture_roadmap_fact|dw_freeze_roadmap|dw_roadmap_statistics_save|dw_roadmap_statistics_restore)$/u.test(
        response.url(),
      )
    ) {
      void response
        .json()
        .then((value: RoadmapSnapshot) => {
          if (value?.roadmapId && Array.isArray(value.items)) state.current = value;
        })
        .catch(() => undefined);
    }
  });
  return state;
}

async function tab(page: Page, name: string) {
  await page
    .getByRole('tab', { name, exact: true })
    .or(page.getByRole('button', { name, exact: true }))
    .first()
    .click();
}
async function createSession(page: Page, region = 'respublika-mordoviia') {
  await page.getByRole('button', { name: 'Создать занятие', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новое занятие', exact: true });
  await dialog.getByRole('textbox', { name: 'Название занятия', exact: true }).fill(WORKSHOP_TITLE);
  await dialog
    .getByRole('combobox', { name: 'Уровень работы', exact: true })
    .selectOption('municipality');
  await dialog.getByRole('combobox', { name: 'Регион', exact: true }).selectOption(region);
  await dialog.getByRole('button', { name: 'Создать занятие', exact: true }).click();
  await expect(dialog).toBeHidden();
  if (!(await page.getByRole('button', { name: 'Код приглашения', exact: true }).isVisible()))
    await page.getByText('Управление занятием', { exact: true }).click();
  await page.getByRole('button', { name: 'Код приглашения', exact: true }).click();
  const invitation = page.getByRole('dialog', { name: 'Пригласить участников', exact: true });
  const link = await invitation
    .getByRole('textbox', { name: 'Ссылка для участников', exact: true })
    .inputValue();
  const code = new URL(link).searchParams.get('join');
  expect(code).toMatch(/^[A-F0-9]{12}$/u);
  await invitation.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  return code!;
}
async function roadmap(page: Page, name = ARDATOV) {
  await tab(page, 'Дорожные карты');
  await tab(page, 'Территория');
  await page.locator('.rm-table-select').filter({ hasText: name }).click();
  await expect(
    page.locator('.rm-territory-inspector').getByRole('heading', { name, exact: true }),
  ).toBeVisible();
  const join = page
    .getByRole('button', { name: 'Создать команду территории', exact: true })
    .or(page.getByRole('button', { name: 'Присоединиться к команде', exact: true }));
  if (await join.count()) await join.click();
  else await page.getByRole('button', { name: 'Открыть дорожную карту', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Диагностика и сценарии', exact: true }),
  ).toBeVisible();
}
async function editor(page: Page, metricId = 'births_total') {
  await page.getByRole('button', { name: 'Уточнить данные', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Уточнение статистики', exact: true });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('combobox', { name: 'Редактируемый показатель', exact: true })
    .selectOption(metricId);
  return dialog;
}
async function addYear(dialog: Locator, year: number, value: string) {
  await dialog.getByLabel('Добавляемый год', { exact: true }).fill(String(year));
  await dialog.getByRole('button', { name: 'Добавить год', exact: true }).click();
  await dialog.getByLabel(`Значение за ${year} год`, { exact: true }).fill(value);
}
async function provenance(dialog: Locator, source = SOURCE, reason = REASON) {
  await dialog.getByLabel('Источник уточнения', { exact: true }).fill(source);
  await dialog.getByLabel('Дата источника', { exact: true }).fill('2026-10-01');
  await dialog.getByLabel('Основание изменения', { exact: true }).fill(reason);
  await dialog
    .getByLabel('Ограничения сопоставимости', { exact: true })
    .fill('Сопоставимость границ и определения показателя проверяет команда.');
}
async function apply(dialog: Locator, close = true) {
  await dialog.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
  await dialog.getByRole('button', { name: 'Применить уточнения', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText(
    'Уточнения сохранены для всей территориальной команды',
  );
  if (close) {
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
}
async function saveScenario(page: Page, title: string, end = 2022, waitForSaved = true) {
  await page.getByLabel('Название', { exact: true }).fill(title);
  await page.getByLabel('Начало истории', { exact: true }).fill('2018');
  await page.getByLabel('Окончание истории', { exact: true }).fill(String(end));
  await page.getByLabel('Горизонт сценария', { exact: true }).fill('2027');
  await page
    .getByRole('combobox', { name: 'Базовая траектория', exact: true })
    .selectOption('last_value');
  await page
    .getByRole('combobox', { name: 'Способ задания цели', exact: true })
    .selectOption('absolute_end');
  await page.getByLabel('Параметр целевого сценария', { exact: true }).fill('175');
  await page
    .getByLabel('Условия и допущения команды', { exact: true })
    .fill('Условный сценарий при проверяемых ограничениях; причинный эффект не установлен.');
  await page.getByRole('button', { name: 'Сохранить сценарий', exact: true }).click();
  if (waitForSaved)
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}
async function freeze(page: Page, title: string) {
  await tab(page, 'Проверка и экспорт');
  await page.getByRole('button', { name: 'Зафиксировать черновик', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Зафиксировать рабочую версию', exact: true });
  await dialog.getByLabel('Название версии', { exact: true }).fill(title);
  await dialog.getByRole('button', { name: 'Зафиксировать версию', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.locator('.rm-version').getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
}
async function download(page: Page, format: 'DOCX' | 'PDF', title?: string) {
  const row = title
    ? page
        .locator('.rm-version')
        .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    : page.locator('.rm-version').first();
  const material = page.waitForResponse(response => response.ok() && (
    response.url().endsWith('/dw_roadmap_version') ||
    (response.url().endsWith('/dw_entry_rpc') && response.request().postDataJSON()?.p_method === 'dw_roadmap_version')
  ));
  await expect(row.getByRole('button', { name: /^(JSON|ZIP)$/u })).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await row.getByRole('button', { name: format, exact: true }).click();
  const file = await pending;
  expect(await file.failure()).toBeNull();
  const path = await file.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  expect(bytes.length).toBeGreaterThan(500);
  const version = await (await material).json() as RoadmapVersion;
  return { bytes, filename: file.suggestedFilename(), version };
}

test('touch corrections are shared, historical scenarios stay pinned and exported versions keep their exact statistics', async ({
  page,
  browser,
  request,
}, info) => {
  const observed = observeSnapshot(page);
  await login(page, 'teacher@workshop.test', HOST_NAME, request);
  const code = await createSession(page);
  await roadmap(page);
  await saveScenario(page, 'Сценарий до уточнения');
  await expect
    .poll(() => observed.current?.items.filter((item) => item.kind === 'scenario').length)
    .toBe(1);
  const originalScenario = structuredClone(
    observed.current!.items.find((item) => item.kind === 'scenario')!,
  );
  await page.getByLabel('Год факта', { exact: true }).selectOption('2014');
  await page
    .getByLabel('Интерпретация для проекта', { exact: true })
    .fill('Исходный факт 253 рождения до актуализации.');
  await page.getByRole('button', { name: 'Закрепить факт', exact: true }).click();
  await expect(
    page.getByText('Факт закреплён с его источником и значением.', { exact: true }),
  ).toBeVisible();
  await freeze(page, 'До актуализации');
  const originalExport = (await download(page, 'DOCX', 'До актуализации')).version;
  await tab(page, 'Диагностика');

  const context = await freshContext(browser, true);
  const phone = await context.newPage();
  audit.watch(phone, 'touch-statistics');
  const mobileObserved = observeSnapshot(phone);
  let projector: Page | undefined;
  try {
    await login(phone, 'participant-a@workshop.test', ALICE_NAME, request);
    await joinSession(phone, code);
    await roadmap(phone);
    const form = await editor(phone);
    await form.getByLabel('Значение за 2014 год', { exact: true }).fill('301');
    await addYear(form, 2024, '155');
    await provenance(form);
    await form.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
    await expect(form).toContainText('253');
    await expect(form).toContainText('301');
    await noOverflow(phone, 390);
    await form.locator('.rm-statistics-preview').scrollIntoViewIfNeeded();
    await capture(phone, info, 'stage6-statistics-preview-touch.png');
    await form.getByRole('button', { name: 'Применить уточнения', exact: true }).click();
    await expect(form.getByRole('status')).toContainText(
      'Уточнения сохранены для всей территориальной команды',
    );
    await form.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(form).toBeHidden();
    await expect
      .poll(
        () =>
          mobileObserved.current?.statistics?.find((entry) => entry.metricId === 'births_total')
            ?.revision,
      )
      .toBe(1);
    const updatedId = mobileObserved.current!.statistics!.find(
      (entry) => entry.metricId === 'births_total',
    )!.seriesId!;
    await expect
      .poll(
        () =>
          observed.current?.statistics?.find((entry) => entry.metricId === 'births_total')
            ?.seriesId,
      )
      .toBe(updatedId);
    expect(observed.current!.items.find((item) => item.id === originalScenario.id)?.data).toEqual(
      originalScenario.data,
    );
    const source = observed.current!.series.find((series) => series.id === updatedId)!;
    expect(source.sourceKind).toBe('team_reported');
    if (source.sourceKind !== 'team_reported') throw new Error('Team correction not returned');
    expect(source.points.find((point) => point.year === 2024)?.value).toBe(155);
    expect(source.baseSeries!.points.find((point) => point.year === 2014)?.value).toBe(253);
    expect(observed.current!.items.find((item) => item.kind === 'fact')?.data.value).toBe(253);

    await page
      .locator('.rm-small-card')
      .filter({ has: page.getByRole('heading', { name: 'Сценарий до уточнения', exact: true }) })
      .getByRole('button', { name: 'Открыть параметры', exact: true })
      .click();
    await expect(page.getByLabel('Окончание истории', { exact: true })).toHaveValue('2022');
    await expect(page.locator('.rm-scenario-results')).toContainText('2022');
    await page
      .getByRole('button', { name: 'Пересчитать по актуальным данным', exact: true })
      .click();
    // Rebasing is a visible local draft until the participant saves the scenario.
    expect(observed.current!.items.find((item) => item.id === originalScenario.id)?.data).toEqual(
      originalScenario.data,
    );
    // A composed series may be revised in 2024 while this scenario still anchors at
    // imported 2022. The indicator must cite that observation's source, not 2024's memo.
    await page.getByRole('button', { name: 'Сохранить редакцию сценария', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Перенести ориентиры в показатель', exact: true }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: 'Перенести ориентиры в показатель', exact: true })
      .click();
    const indicatorEditor = page.getByRole('dialog');
    await expect(indicatorEditor.getByLabel('Год базового значения', { exact: true })).toHaveValue(
      '2022',
    );
    const indicatorSource = await indicatorEditor
      .getByRole('textbox', { name: 'Источник и способ проверки', exact: true })
      .inputValue();
    expect(indicatorSource).toContain(source.baseSeries!.sourceUrl);
    expect(indicatorSource).toContain('Базовое наблюдение 2022');
    expect(indicatorSource).toContain(updatedId);
    expect(indicatorSource).toContain(source.fingerprint);
    expect(indicatorSource).not.toContain(SOURCE);
    await indicatorEditor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    await expect(indicatorEditor).toBeHidden();
    await expect
      .poll(
        () =>
          observed.current?.items.find((item) => item.kind === 'indicator')?.data.sourceReference,
      )
      .toBe(indicatorSource);
    await page.getByLabel('Окончание истории', { exact: true }).fill('2024');
    await expect(page.locator('.rm-scenario-results')).toContainText('2024: 155');
    await page.getByRole('button', { name: 'Сохранить редакцию сценария', exact: true }).click();
    await expect
      .poll(
        () =>
          observed.current?.items
            .filter((item) => item.kind === 'scenario')
            .find((item) => item.id === originalScenario.id)?.data.seriesId,
      )
      .toBe(updatedId);
    await page.getByLabel('Год факта', { exact: true }).selectOption('2024');
    await page
      .getByLabel('Интерпретация для проекта', { exact: true })
      .fill('Уточнённый факт команды за 2024 год.');
    await page.getByRole('button', { name: 'Закрепить факт', exact: true }).click();
    await expect
      .poll(() => observed.current?.items.filter((item) => item.kind === 'fact').length)
      .toBe(2);
    await page.locator('.rm-diagnostic-toolbar').scrollIntoViewIfNeeded();
    await capture(page, info, 'stage6-rebased-diagnostic-desktop.png');
    await noOverflow(page, 1440);

    await freeze(page, 'После актуализации');
    const word = await download(page, 'DOCX', 'После актуализации');
    const json = word.version;
    expect(createHash('sha256').update(json.canonicalJson).digest('hex')).toBe(
      json.sha256,
    );
    expect(JSON.parse(json.canonicalJson)).toEqual(json.snapshot);
    expect(json.snapshot.schemaVersion).toBe(2);
    expect(
      json.snapshot.statistics?.find((entry) => entry.metricId === 'births_total'),
    ).toMatchObject({ seriesId: updatedId });
    expect(
      json.snapshot.series.find((entry) => entry.id === updatedId),
    ).toMatchObject({ sourceReference: SOURCE });
    const xml = strFromU8(unzipSync(new Uint8Array(word.bytes))['word/document.xml']!);
    expect(xml).toContain('Ардатовский');
    expect(xml).toContain(SOURCE);
    expect(xml).toContain('155');
    const pdf = await download(page, 'PDF', 'После актуализации');
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.version.canonicalJson).toBe(json.canonicalJson);
    const repeatedOriginal = (await download(page, 'DOCX', 'До актуализации')).version;
    expect(repeatedOriginal.canonicalJson).toBe(originalExport.canonicalJson);
    expect(repeatedOriginal.sha256).toBe(originalExport.sha256);

    const projectorPayloads: Array<Promise<unknown>> = [];
    page.context().once('page', (opened) => {
      audit.watch(opened, 'statistics-projector');
      opened.on('response', (response) => {
        if (response.ok() && response.url().endsWith('/dw_roadmaps_projector_snapshot'))
          projectorPayloads.push(response.json());
      });
    });
    const opened = page.context().waitForEvent('page');
    await page.getByRole('button', { name: 'Экран проектора', exact: true }).click();
    projector = await opened;
    await projector
      .getByRole('navigation', { name: 'Сцены проектора', exact: true })
      .getByRole('button', { name: 'Дорожные карты', exact: true })
      .click();
    await projector
      .getByRole('combobox', { name: 'Дорожная карта для проектора', exact: true })
      .selectOption({ label: ARDATOV });
    await expect(
      projector.getByRole('img', { name: /Число родившихся: наблюдения/u }),
    ).toBeVisible();
    await expect.poll(() => projectorPayloads.length).toBeGreaterThan(0);
    for (const payload of await Promise.all(projectorPayloads)) {
      expect(JSON.stringify(payload)).not.toMatch(
        /"(?:userId|createdBy|updatedBy|createdByName|updatedByName|members|teamNames|email|responseSecret|answerBarrier|answerSupport)"\s*:/u,
      );
    }
    await capture(projector, info, 'stage6-team-statistics-projector.png');
    await openSessionAfterReload(phone);
    await tab(phone, 'Дорожные карты');
    await tab(phone, 'Диагностика');
    await expect(
      phone.getByLabel('Год факта', { exact: true }).locator('option[value="2024"]'),
    ).toContainText('155');
    await audit.assertHealthy();
  } finally {
    await projector?.close();
    await context.close();
  }
});

test('two concurrent statistical editors preserve the unsaved patch until explicit reconciliation', async ({
  page,
  browser,
  request,
}, info) => {
  await login(page, 'teacher@workshop.test', HOST_NAME, request);
  const code = await createSession(page);
  await roadmap(page);
  const observed = observeSnapshot(page);
  const context = await freshContext(browser);
  const other = await context.newPage();
  audit.watch(other, 'concurrent-statistics');
  try {
    await login(other, 'participant-a@workshop.test', ALICE_NAME, request);
    await joinSession(other, code);
    await roadmap(other);
    const first = await editor(page);
    const second = await editor(other);
    await first.getByLabel('Значение за 2014 год', { exact: true }).fill('305');
    await second.getByLabel('Значение за 2014 год', { exact: true }).fill('321');
    await provenance(first, SOURCE, 'Уточнение первого автора.');
    await provenance(
      second,
      'Сверенная сводка второго участника',
      'Мой несохранённый вариант источника.',
    );
    await apply(first);
    await expect
      .poll(
        () =>
          observed.current?.statistics?.find((entry) => entry.metricId === 'births_total')
            ?.revision,
      )
      .toBe(1);
    await expect(second).toContainText('305');
    await expect(second.getByLabel('Значение за 2014 год', { exact: true })).toHaveValue('321');
    await expect(second.getByLabel('Основание изменения', { exact: true })).toHaveValue(
      'Мой несохранённый вариант источника.',
    );
    await expect(
      second.getByRole('button', {
        name: 'Сохранить мой ввод для повторной проверки',
        exact: true,
      }),
    ).toBeVisible();
    await second.locator('.rm-statistics-conflict').scrollIntoViewIfNeeded();
    await capture(other, info, 'stage6-statistical-revision-conflict.png');
    await second
      .getByRole('button', { name: 'Сохранить мой ввод для повторной проверки', exact: true })
      .click();
    await expect(second.getByLabel('Значение за 2014 год', { exact: true })).toHaveValue('321');
    await apply(second);
    await expect
      .poll(
        () =>
          observed.current?.statistics?.find((entry) => entry.metricId === 'births_total')
            ?.revision,
      )
      .toBe(2);
    const currentId = observed.current!.statistics!.find(
      (entry) => entry.metricId === 'births_total',
    )!.seriesId;
    expect(
      observed
        .current!.series.find((series) => series.id === currentId)
        ?.points.find((point) => point.year === 2014)?.value,
    ).toBe(321);
    await audit.assertHealthy();
  } finally {
    await context.close();
  }
});

test('a real municipality without imported rows can start a manual series on a phone', async ({
  page,
  browser,
  request,
}, info) => {
  await page.goto('/');
  const context = await freshContext(browser, true);
  const phone = await context.newPage();
  audit.watch(phone, 'touch-no-source');
  const observed = observeSnapshot(phone);
  try {
    await login(phone, 'teacher@workshop.test', HOST_NAME, request);
    await createSession(phone, 'stavropolskii-krai');
    await roadmap(phone, NO_SOURCE_TERRITORY);
    await expect(phone.getByRole('button', { name: 'Уточнить данные', exact: true })).toBeVisible();
    const form = await editor(phone);
    await addYear(form, 2024, '6\u00a0100');
    await addYear(form, 2025, '6 120');
    await provenance(form, 'Сводка муниципальной команды без привязки к импортированному ряду');
    await apply(form);
    await expect
      .poll(
        () =>
          observed.current?.statistics?.find((entry) => entry.metricId === 'births_total')
            ?.revision,
      )
      .toBe(1);
    const series = observed.current!.series.find((entry) => entry.sourceKind === 'team_reported')!;
    expect(series.sourceKind).toBe('team_reported');
    if (series.sourceKind !== 'team_reported') throw new Error('Manual series missing');
    expect(series.baseSeries).toBeNull();
    expect(series.points).toEqual([
      { year: 2024, value: 6100 },
      { year: 2025, value: 6120 },
    ]);
    await expect(phone.getByRole('img', { name: /Число родившихся: наблюдения/u })).toBeVisible();
    await expect(phone.locator('.rm-scenario-results')).toContainText('2025');
    await noOverflow(phone, 390);
    await capture(phone, info, 'stage6-no-imported-source-touch.png');
    await phone.getByLabel('Год факта', { exact: true }).selectOption('2025');
    await phone
      .getByLabel('Интерпретация для проекта', { exact: true })
      .fill('Рабочая статистика команды с отдельным происхождением.');
    await phone.getByRole('button', { name: 'Закрепить факт', exact: true }).click();
    await expect
      .poll(() => observed.current?.items.find((item) => item.kind === 'fact')?.data.value)
      .toBe(6120);
    await openSessionAfterReload(phone);
    await tab(phone, 'Дорожные карты');
    await tab(phone, 'Диагностика');
    await expect(
      phone.getByLabel('Год факта', { exact: true }).locator('option[value="2025"]'),
    ).toContainText('6');
    await audit.assertHealthy();
  } finally {
    await context.close();
  }
});

test('decimal input, zero, missing values, single-year reset and full restore retain an inspectable history', async ({
  page,
  request,
}, info) => {
  const observed = observeSnapshot(page);
  await login(page, 'teacher@workshop.test', HOST_NAME, request);
  await createSession(page);
  await roadmap(page);
  const form = await editor(page, 'pop_mid');
  await form.getByLabel('Значение за 2014 год', { exact: true }).fill('-1');
  await provenance(form);
  await form.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
  await expect(form.getByRole('alert')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Применить уточнения', exact: true })).toHaveCount(
    0,
  );
  await form.getByLabel('Значение за 2014 год', { exact: true }).fill('27\u00a0000,125');
  await apply(form, false);
  await expect
    .poll(
      () => observed.current?.statistics?.find((entry) => entry.metricId === 'pop_mid')?.revision,
    )
    .toBe(1);
  const populationId = observed.current!.statistics!.find(
    (entry) => entry.metricId === 'pop_mid',
  )!.seriesId;
  expect(
    observed
      .current!.series.find((series) => series.id === populationId)
      ?.points.find((point) => point.year === 2014)?.value,
  ).toBe(27000.125);

  await form
    .getByRole('combobox', { name: 'Редактируемый показатель', exact: true })
    .selectOption('births_total');
  const source2015 = await form.getByLabel('Значение за 2015 год', { exact: true }).inputValue();
  await form.getByLabel('Значение за 2014 год', { exact: true }).fill('0');
  await form.getByLabel('Значение за 2015 год', { exact: true }).fill('');
  const currentYear = new Date().getUTCFullYear();
  await addYear(form, currentYear, '10');
  await expect(form).toContainText('Текущий календарный год ещё не завершён');
  await form
    .getByRole('button', { name: `Отменить ввод за ${currentYear} год`, exact: true })
    .click();
  await form.getByLabel('Добавляемый год', { exact: true }).fill(String(currentYear + 1));
  await form.getByRole('button', { name: 'Добавить год', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Будущие значения задаются в сценарии');
  await addYear(form, 2024, '');
  await provenance(
    form,
    SOURCE,
    'Нулевое наблюдение отдельно от двух явно отсутствующих значений.',
  );
  await form.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
  const preview = form.getByRole('region', { name: 'Проверка уточнений', exact: true });
  await expect(preview).toContainText('Нет данных');
  await expect(preview).toContainText('0');
  await noOverflow(page, 1440);
  await preview.scrollIntoViewIfNeeded();
  await capture(page, info, 'stage6-zero-null-preview-desktop.png');
  await form.getByRole('button', { name: 'Применить уточнения', exact: true }).click();
  await expect(form.getByRole('status')).toContainText(
    'Уточнения сохранены для всей территориальной команды',
  );
  await expect
    .poll(
      () =>
        observed.current?.statistics?.find((entry) => entry.metricId === 'births_total')?.revision,
    )
    .toBe(1);
  const firstId = observed.current!.statistics!.find(
    (entry) => entry.metricId === 'births_total',
  )!.seriesId;
  const firstSeries = observed.current!.series.find((series) => series.id === firstId)!;
  expect(firstSeries.points.find((point) => point.year === 2014)?.value).toBe(0);
  expect(firstSeries.points.find((point) => point.year === 2015)?.value).toBeNull();
  expect(firstSeries.points.find((point) => point.year === 2024)?.value).toBeNull();
  await form.getByRole('button', { name: 'Вернуть исходное за 2014 год', exact: true }).click();
  await provenance(form, 'Проверка исходного ряда', 'Подтверждено исходное значение 2014 года.');
  await apply(form, false);
  await expect(form.getByLabel('Значение за 2014 год', { exact: true })).toHaveValue('253');
  await expect(form.getByLabel('Значение за 2015 год', { exact: true })).toHaveValue('');

  await form.getByRole('button', { name: 'История уточнений', exact: true }).click();
  await expect(form.locator('.rm-statistics-history')).toContainText(HOST_NAME);
  await form.getByRole('button', { name: 'Показать редакцию 1', exact: true }).click();
  await expect(
    form.getByRole('heading', { name: 'Редакция 1: наблюдения и происхождение', exact: true }),
  ).toBeVisible();
  await form.getByRole('button', { name: 'Вернуть весь исходный ряд', exact: true }).click();
  await form
    .getByLabel('Основание возврата', { exact: true })
    .fill('Все значения этого показателя снова берутся из исходного выпуска.');
  await expect(
    form.getByRole('button', { name: 'Подтвердить возврат', exact: true }),
  ).toBeEnabled();
  // Editing after opening the confirmation must close that destructive-to-draft path.
  await form.getByLabel('Значение за 2014 год', { exact: true }).fill('287');
  await expect(form.getByRole('button', { name: 'Подтвердить возврат', exact: true })).toHaveCount(
    0,
  );
  await expect(form.getByLabel('Значение за 2014 год', { exact: true })).toHaveValue('287');
  await expect(
    form.getByRole('button', { name: 'Вернуть весь исходный ряд', exact: true }),
  ).toBeDisabled();
  expect(
    observed.current!.statistics!.find((entry) => entry.metricId === 'births_total')?.revision,
  ).toBe(2);
  await form.getByRole('button', { name: 'Отменить ввод за 2014 год', exact: true }).click();
  await expect(form.getByLabel('Значение за 2014 год', { exact: true })).toHaveValue('253');
  await form.getByRole('button', { name: 'Вернуть весь исходный ряд', exact: true }).click();
  await form.getByRole('button', { name: 'Подтвердить возврат', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Команда вернулась к исходному ряду');
  await expect
    .poll(
      () =>
        observed.current?.statistics?.find((entry) => entry.metricId === 'births_total')?.revision,
    )
    .toBe(3);
  await expect(form.getByLabel('Значение за 2015 год', { exact: true })).toHaveValue(source2015);
  await expect(form.getByLabel('Значение за 2024 год', { exact: true })).toHaveCount(0);
  expect(
    observed.current!.statistics!.find((entry) => entry.metricId === 'births_total')?.mode,
  ).toBe('imported');
  expect(observed.current!.statistics!.find((entry) => entry.metricId === 'pop_mid')?.mode).toBe(
    'team',
  );
  await expect(form.locator('.rm-statistics-history')).toContainText(
    'Редакция 3 · Возврат к исходному',
  );
  await expect(form.getByRole('button', { name: 'Показать редакцию 3', exact: true })).toHaveCount(
    0,
  );
  await form.getByRole('button', { name: 'Показать редакцию 1', exact: true }).click();
  await expect(
    form.getByRole('heading', { name: 'Редакция 1: наблюдения и происхождение', exact: true }),
  ).toBeVisible();
  await form.locator('.rm-statistics-history').scrollIntoViewIfNeeded();
  await capture(page, info, 'stage6-restored-source-and-history.png');
  await form.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await audit.assertHealthy();
});

test('a delayed scenario save does not attach its record ID to a newly selected metric', async ({
  page,
  request,
}, info) => {
  const observed = observeSnapshot(page);
  await login(page, 'teacher@workshop.test', HOST_NAME, request);
  await createSession(page);
  await roadmap(page);
  let intercepted = false;
  let responseReady = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const path = '**/rest/v1/rpc/dw_save_roadmap_item';
  await page.route(path, async (route) => {
    const input = route.request().postDataJSON() as { p_input?: { kind?: string } };
    if (intercepted || input.p_input?.kind !== 'scenario') {
      await route.continue();
      return;
    }
    intercepted = true;
    // Commit through the real gateway/SQL, then delay only delivery to this browser.
    const response = await route.fetch();
    responseReady = true;
    await held;
    await route.fulfill({ response });
  });
  const originalTitle = 'Сохранение рождений с задержкой ответа';
  const laterTitle = 'Новый самостоятельный сценарий смертности';
  try {
    await saveScenario(page, originalTitle, 2022, false);
    await expect.poll(() => responseReady).toBe(true);
    await page
      .getByRole('combobox', { name: 'Показатель', exact: true })
      .selectOption('deaths_total');
    await page.getByLabel('Название', { exact: true }).fill(laterTitle);
    release();
    await expect(page.getByRole('heading', { name: originalTitle, exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Показатель', exact: true })).toHaveValue(
      'deaths_total',
    );
    await expect(page.getByLabel('Название', { exact: true })).toHaveValue(laterTitle);
    await expect(
      page.getByRole('button', { name: 'Сохранить сценарий', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Сохранить редакцию сценария', exact: true }),
    ).toHaveCount(0);
    const original = structuredClone(
      observed.current!.items.find(
        (item) => item.kind === 'scenario' && item.data.title === originalTitle,
      )!,
    );
    expect(original.kind).toBe('scenario');
    await page.getByRole('button', { name: 'Сохранить сценарий', exact: true }).click();
    await expect(page.getByRole('heading', { name: laterTitle, exact: true })).toBeVisible();
    await expect
      .poll(() => observed.current?.items.filter((item) => item.kind === 'scenario').length)
      .toBe(2);
    const current = observed.current!.items.filter((item) => item.kind === 'scenario');
    expect(current.find((item) => item.id === original.id)).toEqual(original);
    expect(
      current.find((item) => item.data.title === originalTitle)?.data.parameters.metricId,
    ).toBe('births_total');
    expect(current.find((item) => item.data.title === laterTitle)?.data.parameters.metricId).toBe(
      'deaths_total',
    );
    expect(current.find((item) => item.data.title === laterTitle)?.id).not.toBe(original.id);
    await page
      .getByRole('heading', { name: 'Сохранённые сценарии', exact: true })
      .scrollIntoViewIfNeeded();
    await capture(page, info, 'stage6-delayed-save-keeps-distinct-scenarios.png');
    await audit.assertHealthy();
  } finally {
    release();
    await page.unroute(path);
  }
});
