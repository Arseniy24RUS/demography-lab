import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  ALICE_NAME, BOB_NAME, HOST_NAME, BASE_URL, GATEWAY_URL, MORDOVIA_TITLE, SAKHALIN_TITLE,
  BrowserAudit, fixture, freshContext, login, createSession, joinSession,
  navigation, reader, preparedPractice, publishPractice, openSessionAfterReload, capture, noOverflow, readableVariantColumns,
} from './browser-fixture';

const FAMILY_TITLE = 'Доступность дошкольного ухода';
let audit: BrowserAudit;

test.beforeEach(async ({ page, request }) => {
  await fixture(request, 'reset');
  audit = new BrowserAudit();
  audit.watch(page, 'teacher');
});
test.afterEach(async () => { await audit.assertHealthy(); });

async function workshopTab(page: Page, name: 'Карта программ' | 'Семейства практик' | 'Оценивание' | 'Доска карточек') {
  const tab = page.getByRole('tab', { name, exact: true });
  const button = page.getByRole('button', { name, exact: true });
  await tab.or(button).first().click();
}
const detail = (page: Page) => page.getByRole('complementary', { name: 'Выбранная программа', exact: true });
const map = (page: Page) => page.getByRole('group', { name: 'Карта региональных программ', exact: true });

async function selectOnMap(page: Page, region: string) {
  const target = map(page).getByRole('button', { name: new RegExp(`^${region}:`) });
  await target.focus();
  await page.keyboard.press('Enter');
  await expect(detail(page).getByRole('heading', { name: region, exact: true })).toBeVisible();
}

async function selectFromList(page: Page, region: string) {
  await page.getByRole('searchbox', { name: 'Найти регион', exact: true }).fill(region);
  await page.getByRole('group', { name: 'Выбрать программу по названию', exact: true })
    .getByRole('button', { name: new RegExp(region) }).click();
  await expect(detail(page).getByRole('heading', { name: region, exact: true })).toBeVisible();
}

async function createFamily(page: Page, titles = [MORDOVIA_TITLE, SAKHALIN_TITLE], name = FAMILY_TITLE) {
  await workshopTab(page, 'Семейства практик');
  for (const title of titles) await page.getByRole('checkbox', { name: `Выбрать практику «${title}»`, exact: true }).check();
  await page.getByRole('button', { name: 'Создать семейство', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Создать семейство практик', exact: true });
  await dialog.getByRole('textbox', { name: 'Название семейства', exact: true }).fill(name);
  await dialog.getByRole('textbox', { name: 'Общий механизм', exact: true }).fill('Компенсация части платы за уход и присмотр за ребёнком в дошкольной организации.');
  await dialog.getByRole('textbox', { name: 'Обоснование объединения', exact: true }).fill('Общий механизм возмещения расходов; суммы, получатели и ограничения каждого региона сохраняются для сравнения.');
  await dialog.getByRole('button', { name: 'Сохранить семейство', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('article', { name, exact: true })).toBeVisible();
}

async function publishRegionalVariants(host: Page, participant: Page, mobile = false) {
  await preparedPractice(participant, 'respublika-mordoviia', MORDOVIA_TITLE, mobile);
  await publishPractice(participant, MORDOVIA_TITLE, 'Мордовский вариант: сохранены региональные размеры и точные основания.');
  await preparedPractice(host, 'sakhalinskaia-oblast', SAKHALIN_TITLE);
  await publishPractice(host, SAKHALIN_TITLE, 'Сахалинский вариант: сравниваем условия без сведения сумм к единому значению.');
}

test('independent participants contend for one actual map region and a completed review survives reload', async ({
  page, browser, request,
}, info) => {
  const firstContext = await freshContext(browser);
  const secondContext = await freshContext(browser);
  try {
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    audit.watch(first, 'participant-a');
    audit.watch(second, 'participant-b');
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    const { code } = await createSession(page);
    await login(first, 'participant-a@workshop.test', ALICE_NAME, request);
    await joinSession(first, code);
    await login(second, 'participant-b@workshop.test', BOB_NAME, request);
    await joinSession(second, code);
    for (const current of [page, first, second]) {
      await workshopTab(current, 'Карта программ');
      await selectOnMap(current, 'Сахалинская область');
      await selectOnMap(current, 'Республика Мордовия');
    }
    await expect(map(page).getByRole('button')).toHaveCount(89);
    await expect(detail(first).getByRole('button', { name: 'Взять программу', exact: true })).toBeEnabled();
    await expect(detail(second).getByRole('button', { name: 'Взять программу', exact: true })).toBeEnabled();
    audit.expectRejection('dw_region_work', [400, 409]);
    const responseForClaim = (current: Page) => current.waitForResponse((response) =>
      response.url() === `${GATEWAY_URL}/rest/v1/rpc/dw_region_work` && response.request().postDataJSON()?.p_action === 'claim');
    const responses = [responseForClaim(first), responseForClaim(second)];
    await Promise.all([first, second].map((current) => detail(current).getByRole('button', { name: 'Взять программу', exact: true }).click()));
    const outcomes = await Promise.all(responses);
    expect(outcomes.filter((response) => response.status() === 200)).toHaveLength(1);
    const winningIndex = outcomes[0]!.status() === 200 ? 0 : 1;
    const winner = [first, second][winningIndex]!;
    const loser = [first, second][1 - winningIndex]!;
    expect((await outcomes[1 - winningIndex]!.json()).message).toMatch(/REVISION_CONFLICT|REGION_TAKEN/);
    const name = winningIndex === 0 ? ALICE_NAME : BOB_NAME;
    await loser.bringToFront();
    await expect(detail(loser)).toContainText(name);
    await expect(detail(loser).getByRole('button', { name: 'Взять программу', exact: true })).toHaveCount(0);
    await expect(detail(loser).getByRole('button', { name: 'Освободить программу', exact: true })).toHaveCount(0);
    await winner.bringToFront();
    await detail(winner).getByRole('button', { name: 'Завершить отбор', exact: true }).click();
    const completion = winner.getByRole('dialog', { name: 'Завершить отбор практик', exact: true });
    const confirm = completion.getByRole('button', { name: 'Подтвердить завершение', exact: true });
    await expect(confirm).toBeDisabled();
    const note = 'Просмотрены разделы программы; отдельную практику для общего обсуждения пока не выделили.';
    await completion.getByRole('textbox', { name: /^Результат отбора/ }).fill(note);
    await confirm.click();
    await expect(completion).toBeHidden();
    await expect(detail(winner)).toContainText('Отбор завершён');
    await page.bringToFront();
    await expect(detail(page)).toContainText(note);
    await expect(map(page).getByRole('button', { name: /^Республика Мордовия:/ })).toHaveAccessibleName(/завершён/);
    await capture(page, info, 'stage3-region-completed-desktop.png');
    await openSessionAfterReload(winner);
    await workshopTab(winner, 'Карта программ');
    await expect(detail(winner)).toContainText(note);
    await expect(detail(winner).getByRole('button', { name: 'Вернуть в работу', exact: true })).toBeEnabled();
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test('desktop curation retains different regional conditions and both source jumps work in a mobile browser', async ({
  page, browser, request,
}, info) => {
  const context = await freshContext(browser, true);
  try {
    const mobile = await context.newPage();
    audit.watch(mobile, 'mobile-participant');
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    const { code } = await createSession(page);
    await login(mobile, 'participant-a@workshop.test', ALICE_NAME, request);
    await joinSession(mobile, code);
    await workshopTab(mobile, 'Карта программ');
    await selectFromList(mobile, 'Республика Мордовия');
    await detail(mobile).getByRole('button', { name: 'Взять программу', exact: true }).click();
    await expect(detail(mobile)).toContainText(ALICE_NAME);
    await noOverflow(mobile, 390);
    await capture(mobile, info, 'stage3-mobile-map-allocation.png');
    await detail(mobile).getByRole('button', { name: 'Открыть документ', exact: true }).click();
    await expect(reader(mobile)).toBeVisible();
    await expect(reader(mobile).getByRole('textbox', { name: 'Номер страницы', exact: true })).toHaveValue('1');
    await publishRegionalVariants(page, mobile, true);
    await workshopTab(mobile, 'Карта программ');
    await detail(mobile).getByRole('button', { name: 'Завершить отбор', exact: true }).click();
    const complete = mobile.getByRole('dialog', { name: 'Завершить отбор практик', exact: true });
    await expect(complete.getByRole('button', { name: 'Подтвердить завершение', exact: true })).toBeEnabled();
    await complete.getByRole('button', { name: 'Подтвердить завершение', exact: true }).click();
    await expect(complete).toBeHidden();
    await expect(detail(mobile)).toContainText('Отбор завершён');

    await workshopTab(page, 'Семейства практик');
    for (const title of [MORDOVIA_TITLE, SAKHALIN_TITLE]) await page.getByRole('checkbox', { name: `Выбрать практику «${title}»`, exact: true }).check();
    await page.getByRole('button', { name: 'Сопоставить выбранные', exact: true }).click();
    const comparison = page.getByRole('dialog', { name: 'Сопоставление выбранных практик', exact: true });
    await expect(comparison).toContainText('20–29%');
    await expect(comparison).toContainText('20% на первого ребёнка;50% на второго;100% на третьего');
    await comparison.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
    await createFamily(page);
    const family = page.getByRole('article', { name: FAMILY_TITLE, exact: true });
    await expect(family).toContainText('Региональных вариантов: 2');
    await expect(family).toContainText('Республика Мордовия');
    await expect(family).toContainText('Сахалинская область');
    await expect(family).toContainText('20–29%');
    await expect(family).toContainText('20% на первого ребёнка;50% на второго;100% на третьего');
    await capture(page, info, 'stage3-family-different-conditions-desktop.png');

    await mobile.bringToFront();
    await workshopTab(mobile, 'Семейства практик');
    const mobileFamily = mobile.getByRole('article', { name: FAMILY_TITLE, exact: true });
    await expect(mobileFamily).toContainText('Региональных вариантов: 2');
    await expect(mobile.getByRole('button', { name: 'Создать семейство', exact: true })).toHaveCount(0);
    await noOverflow(mobile, 390);
    await readableVariantColumns(mobile);
    await capture(mobile, info, 'stage3-family-mobile.png');
    await mobile.setViewportSize({ width: 320, height: 844 });
    await noOverflow(mobile, 320);
    await readableVariantColumns(mobile);
    await capture(mobile, info, 'stage3-family-small-320.png');
    await mobile.setViewportSize({ width: 390, height: 844 });
    const sakhalin = mobileFamily.getByRole('row').filter({ hasText: 'Сахалинская область' });
    await sakhalin.getByRole('button', { name: 'Содержание и цитаты', exact: true }).click();
    const sourceDetail = mobile.getByRole('dialog', { name: SAKHALIN_TITLE, exact: true });
    await expect(sourceDetail).toContainText('20% на первого ребёнка;50% на второго;100% на третьего');
    await sourceDetail.getByRole('button', { name: 'Открыть цитату в документе', exact: true }).click();
    await expect(reader(mobile).getByRole('textbox', { name: 'Номер страницы', exact: true })).toHaveValue('37');
    await noOverflow(mobile, 390);
    await capture(mobile, info, 'stage3-mobile-sakhalin-original-page37.png');
    await navigation(mobile).getByRole('button', { name: 'Занятия', exact: true }).click();
    await workshopTab(mobile, 'Семейства практик');
    await mobile.getByRole('article', { name: FAMILY_TITLE, exact: true }).getByRole('row')
      .filter({ hasText: 'Республика Мордовия' }).getByRole('button', { name: 'Открыть цитату', exact: true }).click();
    await expect(reader(mobile).getByRole('textbox', { name: 'Номер страницы', exact: true })).toHaveValue('59');
    await noOverflow(mobile, 390);
    await openSessionAfterReload(page);
    await workshopTab(page, 'Семейства практик');
    await expect(page.getByRole('article', { name: FAMILY_TITLE, exact: true })).toContainText('Региональных вариантов: 2');
  } finally {
    await context.close();
  }
});

test('a blinded round preserves neutral and withdrawn answers, reveals a denominator-aware result, and starts a fresh round', async ({
  page, browser, request,
}, info) => {
  const context = await freshContext(browser, true);
  let projector: Page | undefined;
  try {
    const participant = await context.newPage();
    audit.watch(participant, 'mobile-voter');
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    const { code, sessionId } = await createSession(page);
    await login(participant, 'participant-a@workshop.test', ALICE_NAME, request);
    await joinSession(participant, code);
    await publishRegionalVariants(page, participant, true);
    await createFamily(page);
    await page.getByRole('combobox', { name: 'Текущий этап', exact: true }).selectOption('discussion');
    await expect(page.getByRole('combobox', { name: 'Текущий этап', exact: true })).toHaveValue('discussion');
    await workshopTab(page, 'Оценивание');
    await page.getByRole('button', { name: 'Открыть оценивание', exact: true }).click();
    const preflight = page.getByRole('dialog', { name: 'Подготовить раунд оценки', exact: true });
    await expect(preflight.getByRole('radio', { name: /^Во время оценивания/ })).toHaveCount(0);
    await preflight.getByRole('textbox', { name: 'Название раунда', exact: true }).fill('Первичная экспертиза практик');
    await expect(preflight.getByRole('spinbutton', { name: 'Минимум содержательных оценок', exact: true })).toHaveValue('2');
    await capture(page, info, 'stage3-round-preflight.png');
    await preflight.getByRole('button', { name: 'Открыть оценивание', exact: true }).click();
    await expect(preflight).toBeHidden();
    await expect(page.getByText('Текущие итоги скрыты до завершения раунда.', { exact: false })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Результаты оценивания семейств', exact: true })).toHaveCount(0);
    await participant.bringToFront();
    await workshopTab(participant, 'Оценивание');
    const voteGroup = participant.getByRole('group', { name: `Оценка семейства «${FAMILY_TITLE}»`, exact: true });
    await voteGroup.getByRole('button', { name: 'Не могу оценить', exact: true }).click();
    await expect(voteGroup.getByRole('button', { name: 'Не могу оценить', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(participant.getByText('Ваши ответы: 1 из 1', { exact: true })).toBeVisible();
    await noOverflow(participant, 390);
    await readableVariantColumns(participant);
    await capture(participant, info, 'stage3-neutral-vote-mobile.png');
    await openSessionAfterReload(participant);
    await workshopTab(participant, 'Оценивание');
    await expect(participant.getByRole('group', { name: `Оценка семейства «${FAMILY_TITLE}»`, exact: true })
      .getByRole('button', { name: 'Не могу оценить', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await participant.getByRole('button', { name: 'Снять оценку', exact: true }).click();
    await expect(participant.getByText('Ваши ответы: 0 из 1', { exact: true })).toBeVisible();
    await participant.getByRole('group', { name: `Оценка семейства «${FAMILY_TITLE}»`, exact: true })
      .getByRole('button', { name: 'Поддерживаю', exact: true }).click();
    await expect(participant.getByRole('group', { name: `Оценка семейства «${FAMILY_TITLE}»`, exact: true })
      .getByRole('button', { name: 'Поддерживаю', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.bringToFront();
    await page.getByRole('group', { name: `Оценка семейства «${FAMILY_TITLE}»`, exact: true })
      .getByRole('button', { name: 'Не поддерживаю', exact: true }).click();
    const projectorRequests: string[] = [];
    page.context().once('page', (opened) => {
      audit.watch(opened, 'projector');
      opened.on('request', (outgoing) => {
        if (outgoing.url().includes('/rest/v1/rpc/')) projectorRequests.push(outgoing.url());
      });
    });
    const opened = page.context().waitForEvent('page');
    await page.getByRole('button', { name: 'Экран проектора', exact: true }).click();
    projector = await opened;
    await expect(projector).toHaveURL(new RegExp(`session=${sessionId}.*projector=1`));
    await projector.getByRole('button', { name: 'Рейтинг', exact: true }).click();
    await expect(projector.getByRole('heading', { name: 'Участники формируют свои оценки', exact: true })).toBeVisible();
    await expect(projector.getByRole('progressbar', { name: 'Участники, начавшие оценивание', exact: true })).toHaveAttribute('value', '2');
    await expect(projector.getByRole('region', { name: 'Результаты оценивания семейств', exact: true })).toHaveCount(0);
    const body = await projector.locator('body').innerText();
    for (const privateValue of [code, HOST_NAME, ALICE_NAME, 'teacher@workshop.test', 'participant-a@workshop.test']) expect(body).not.toContain(privateValue);
    expect(projectorRequests.some((url) => /\/dw_workshop_projector_(?:snapshot|updates)$/.test(url))).toBe(true);
    expect(projectorRequests.some((url) => /\/(?:dw_session_snapshot|dw_workshop_snapshot|dw_workshop_updates|dw_invitation)$/.test(url))).toBe(false);
    await capture(projector, info, 'stage3-projector-blind-participation.png');
    await page.bringToFront();
    await page.getByRole('button', { name: 'Завершить и раскрыть', exact: true }).click();
    const closing = page.getByRole('dialog', { name: 'Завершить оценивание и раскрыть итоги', exact: true });
    await closing.getByRole('button', { name: 'Завершить и раскрыть', exact: true }).click();
    await expect(closing).toBeHidden();
    const ranking = page.getByRole('region', { name: 'Результаты оценивания семейств', exact: true });
    await expect(ranking.getByRole('heading', { name: 'Оценка участников сессии', exact: true })).toBeVisible();
    await expect(ranking.getByText('Ответили', { exact: true }).locator('..').getByRole('definition')).toHaveText('2/2');
    await expect(ranking.getByText('Поддержали', { exact: true }).locator('..').getByRole('definition')).toHaveText('1');
    await expect(ranking.getByText('Не поддержали', { exact: true }).locator('..').getByRole('definition')).toHaveText('1');
    await expect(ranking.locator('.workshop-net-value')).toHaveText(/0\s*%/);
    await expect(page.getByRole('button', { name: 'Поддерживаю', exact: true })).toHaveCount(0);
    await capture(page, info, 'stage3-ranking-desktop.png');
    await projector.bringToFront();
    await expect(projector.getByRole('heading', { name: 'Оценка участников сессии', exact: true })).toBeVisible();
    await expect(projector.locator('.workshop-net-value')).toHaveText(/0\s*%/);
    await capture(projector, info, 'stage3-projector-revealed-ranking.png');
    await projector.getByRole('button', { name: 'Карта', exact: true }).click();
    await expect(projector.getByRole('heading', { name: 'Работа с региональными программами', exact: true })).toBeVisible();
    await expect(map(projector).getByRole('button')).toHaveCount(89);
    await capture(projector, info, 'stage3-projector-coverage-map.png');
    await participant.bringToFront();
    await expect(participant.getByRole('heading', { name: 'Оценка участников сессии', exact: true })).toBeVisible();
    await noOverflow(participant, 390);
    await capture(participant, info, 'stage3-ranking-mobile.png');
    await page.bringToFront();
    await page.getByRole('button', { name: 'Открыть оценивание', exact: true }).click();
    const repeat = page.getByRole('dialog', { name: 'Подготовить раунд оценки', exact: true });
    await repeat.getByRole('textbox', { name: 'Название раунда', exact: true }).fill('Повторное обсуждение');
    await repeat.getByRole('radio', { name: /^Во время оценивания/ }).check();
    await repeat.getByRole('button', { name: 'Открыть оценивание', exact: true }).click();
    await expect(repeat).toBeHidden();
    await participant.bringToFront();
    await expect(participant.getByRole('heading', { name: 'Повторное обсуждение', exact: true })).toBeVisible();
    await expect(participant.getByText('Ваши ответы: 0 из 1', { exact: true })).toBeVisible();
    const freshVotes = participant.getByRole('group', { name: `Оценка семейства «${FAMILY_TITLE}»`, exact: true });
    for (const answer of ['Поддерживаю', 'Не поддерживаю', 'Не могу оценить']) await expect(freshVotes.getByRole('button', { name: answer, exact: true })).toHaveAttribute('aria-pressed', 'false');
    const history = participant.getByRole('combobox', { name: 'Раунд', exact: true });
    const firstRoundId = await history.getByRole('option', { name: /^Первичная экспертиза практик/ }).getAttribute('value');
    expect(firstRoundId).toBeTruthy();
    await history.selectOption(firstRoundId!);
    await expect(participant.getByRole('heading', { name: 'Первичная экспертиза практик', exact: true })).toBeVisible();
    await expect(participant.getByRole('region', { name: 'Результаты оценивания семейств', exact: true })
      .getByText('Ответили', { exact: true }).locator('..').getByRole('definition')).toHaveText('2/2');
    await expect(participant.getByRole('button', { name: 'Поддерживаю', exact: true })).toHaveCount(0);
    await noOverflow(participant, 390);
  } finally {
    await projector?.close();
    await context.close();
  }
});

test('pointer and keyboard transfers require confirmation and a concurrent family edit preserves the draft', async ({
  page, browser, request,
}, info) => {
  const participantContext = await freshContext(browser);
  const secondHostContext = await freshContext(browser);
  try {
    const participant = await participantContext.newPage();
    const secondHost = await secondHostContext.newPage();
    audit.watch(participant, 'participant');
    audit.watch(secondHost, 'second-host');
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    const { code } = await createSession(page);
    await login(participant, 'participant-a@workshop.test', ALICE_NAME, request);
    await joinSession(participant, code);
    await publishRegionalVariants(page, participant);
    await createFamily(page, [MORDOVIA_TITLE]);
    let family = page.getByRole('article', { name: FAMILY_TITLE, exact: true });
    await expect(family).toContainText('Региональных вариантов: 1');
    const handle = page.getByRole('button', { name: `Перенести практику «${SAKHALIN_TITLE}»`, exact: true });
    const target = family.locator('.workshop-family-heading');
    await target.scrollIntoViewIfNeeded();
    await handle.scrollIntoViewIfNeeded();
    const sourceBox = await handle.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    expect(sourceBox!.y).toBeGreaterThanOrEqual(0);
    expect(targetBox!.y).toBeGreaterThanOrEqual(0);
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox!.x + Math.min(90, targetBox!.width / 2), targetBox!.y + targetBox!.height / 2, { steps: 14 });
    await page.mouse.up();
    let transfer = page.getByRole('dialog', { name: 'Добавить практики в семейство', exact: true });
    await expect(transfer).toBeVisible();
    const targetId = await transfer.getByRole('combobox', { name: 'Семейство назначения', exact: true })
      .getByRole('option', { name: FAMILY_TITLE, exact: true }).getAttribute('value');
    expect(targetId).toBeTruthy();
    await expect(transfer.getByRole('combobox', { name: 'Семейство назначения', exact: true })).toHaveValue(targetId!);
    await expect(transfer).toContainText('Сахалинская область');
    await capture(page, info, 'stage3-pointer-transfer-confirmation.png');
    await transfer.getByRole('button', { name: 'Подтвердить перенос', exact: true }).click();
    await expect(transfer).toBeHidden();
    family = page.getByRole('article', { name: FAMILY_TITLE, exact: true });
    await expect(family).toContainText('Региональных вариантов: 2');
    await family.getByRole('button', { name: `Исключить из семейства практику «${SAKHALIN_TITLE}»`, exact: true }).click();
    const removal = page.getByRole('dialog', { name: 'Исключить вариант из семейства', exact: true });
    await removal.getByRole('button', { name: 'Исключить из семейства', exact: true }).click();
    await expect(removal).toBeHidden();
    await expect(family).toContainText('Региональных вариантов: 1');
    await page.getByRole('button', { name: `Перенести практику «${SAKHALIN_TITLE}»`, exact: true }).focus();
    await page.keyboard.press('Enter');
    transfer = page.getByRole('dialog', { name: 'Добавить практики в семейство', exact: true });
    await expect(transfer).toBeVisible();
    await transfer.getByRole('combobox', { name: 'Семейство назначения', exact: true }).selectOption({ label: FAMILY_TITLE });
    await transfer.getByRole('button', { name: 'Подтвердить перенос', exact: true }).click();
    await expect(transfer).toBeHidden();
    await expect(family).toContainText('Региональных вариантов: 2');
    await login(secondHost, 'teacher@workshop.test', null, request);
    await secondHost.getByRole('button', { name: 'Открыть занятие «Мордовия · региональная мастерская»', exact: true }).click();
    await workshopTab(secondHost, 'Семейства практик');
    await expect(secondHost.getByRole('article', { name: FAMILY_TITLE, exact: true })).toBeVisible();
    for (const current of [page, secondHost]) await current.getByRole('button', { name: `Редактировать семейство «${FAMILY_TITLE}»`, exact: true }).click();
    const firstEditor = page.getByRole('dialog', { name: 'Редактировать семейство', exact: true });
    const secondEditor = secondHost.getByRole('dialog', { name: 'Редактировать семейство', exact: true });
    const updatedTitle = `${FAMILY_TITLE} · новая редакция`;
    const unsavedRationale = 'Мой несохранённый вывод: отдельно обсудить получателей и предел компенсации в двух регионах.';
    await firstEditor.getByRole('textbox', { name: 'Название семейства', exact: true }).fill(updatedTitle);
    await secondEditor.getByRole('textbox', { name: 'Обоснование объединения', exact: true }).fill(unsavedRationale);
    await firstEditor.getByRole('button', { name: 'Сохранить семейство', exact: true }).click();
    await expect(firstEditor).toBeHidden();
    audit.expectRejection('dw_save_family', [400, 409]);
    const failedSave = secondHost.waitForResponse((response) => response.url() === `${GATEWAY_URL}/rest/v1/rpc/dw_save_family`);
    await secondEditor.getByRole('button', { name: 'Сохранить семейство', exact: true }).click();
    const rejection = await failedSave;
    expect([400, 409]).toContain(rejection.status());
    expect((await rejection.json()).message).toMatch(/^REVISION_CONFLICT/);
    await expect(secondEditor.getByRole('textbox', { name: 'Обоснование объединения', exact: true })).toHaveValue(unsavedRationale);
    await expect(secondEditor.getByRole('textbox', { name: 'Название семейства', exact: true })).toHaveValue(FAMILY_TITLE);
    await expect(secondEditor.getByRole('alert')).toBeVisible();
    await capture(secondHost, info, 'stage3-family-conflict-preserved-draft.png');
    await page.bringToFront();
    await expect(page.getByRole('article', { name: updatedTitle, exact: true })).toContainText('Региональных вариантов: 2');
    await expect(page.getByRole('article', { name: updatedTitle, exact: true })).not.toContainText(unsavedRationale);
  } finally {
    await participantContext.close();
    await secondHostContext.close();
  }
});
