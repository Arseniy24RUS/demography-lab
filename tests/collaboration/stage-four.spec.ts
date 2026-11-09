import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import {
  ALICE_NAME, HOST_NAME, BASE_URL, GATEWAY_URL, MORDOVIA_TITLE, SAKHALIN_TITLE,
  BrowserAudit, fixture, freshContext, login, createSession, joinSession,
  navigation, reader, preparedPractice, publishPractice, openSessionAfterReload, capture, noOverflow,
} from './browser-fixture';

const FAMILY_TITLE = 'Компенсация расходов на дошкольный уход';
const BARRIER_TITLE = 'Непредсказуемый график ухода за ребёнком';
const SURVEY_ORIGIN = 'http://127.0.0.1:4174';
const SURVEY_TITLE = 'Условия родительства · добровольное обсуждение';
const SURVEY_BARRIER_QUESTION = 'Какие обстоятельства затрудняют рождение ребёнка?';
const SURVEY_SUPPORT_QUESTION = 'Какие изменения могли бы существенно помочь?';
let audit: BrowserAudit;

test.beforeEach(async ({ page, request }) => {
  await fixture(request, 'reset');
  audit = new BrowserAudit();
  audit.watch(page, 'teacher');
});
test.afterEach(async () => { await audit.assertHealthy(); });

async function sessionTab(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).or(page.getByRole('button', { name, exact: true })).first().click();
}
async function barriers(page: Page, inner = 'Путь родительства') {
  await sessionTab(page, 'Барьеры и решения');
  await sessionTab(page, inner);
}
const card = (page: Page, title = BARRIER_TITLE) => page.getByRole('article').filter({
  has: page.getByRole('heading', { name: title, exact: true }),
});

async function createBarrier(page: Page, title = BARRIER_TITLE) {
  await barriers(page);
  await page.getByRole('button', { name: 'Добавить барьер', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Добавить барьер', exact: true });
  await dialog.getByRole('textbox', { name: 'Краткое название', exact: true }).fill(title);
  await dialog.getByRole('textbox', { name: 'Описание и адресат', exact: true }).fill('Работающим родителям трудно согласовать часы присмотра и сменный график работы.');
  await dialog.getByRole('combobox', { name: 'Основной этап', exact: true }).selectOption('life_plans');
  await dialog.getByRole('combobox', { name: 'Основание формулировки', exact: true }).selectOption('hypothesis');
  await dialog.getByRole('checkbox', { name: 'Следующий ребёнок', exact: true }).check();
  await dialog.getByRole('button', { name: 'Сохранить барьер', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, title)).toBeVisible();
}

async function createFamily(page: Page) {
  await sessionTab(page, 'Семейства практик');
  for (const title of [MORDOVIA_TITLE, SAKHALIN_TITLE]) {
    await page.getByRole('checkbox', { name: `Выбрать практику «${title}»`, exact: true }).check();
  }
  await page.getByRole('button', { name: 'Создать семейство', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Создать семейство практик', exact: true });
  await dialog.getByRole('textbox', { name: 'Название семейства', exact: true }).fill(FAMILY_TITLE);
  await dialog.getByRole('textbox', { name: 'Общий механизм', exact: true }).fill('Возмещение родительской платы при сохранении конкретных региональных размеров и условий.');
  await dialog.getByRole('textbox', { name: 'Обоснование объединения', exact: true }).fill('Общий механизм компенсации; не переносим размер поддержки из одного региона в другой.');
  await dialog.getByRole('button', { name: 'Сохранить семейство', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function publishAndGroup(host: Page, participant: Page, mobile = false) {
  await preparedPractice(participant, 'respublika-mordoviia', MORDOVIA_TITLE, mobile);
  await publishPractice(participant, MORDOVIA_TITLE, 'Сохраняем точные условия Мордовии для последующего сопоставления.');
  await preparedPractice(host, 'sakhalinskaia-oblast', SAKHALIN_TITLE);
  await publishPractice(host, SAKHALIN_TITLE, 'Сахалинский вариант рассматривается отдельно, с исходными цитатами.');
  await createFamily(host);
}

async function createOpenSurvey(page: Page) {
  await barriers(page, 'Опрос');
  await page.getByRole('button', { name: 'Создать опрос', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новый опрос', exact: true });
  await editor.getByRole('textbox', { name: 'Название опроса', exact: true }).fill(SURVEY_TITLE);
  await editor.getByRole('textbox', { name: 'Цель и использование ответов', exact: true }).fill('Учебное обсуждение барьеров и условий родительства. Исследовательское использование допускается только по отдельному согласию.');
  await editor.getByRole('textbox', { name: 'Контакт организатора', exact: true }).fill('Организатор учебной мастерской; контакт указан в программе занятия.');
  await editor.getByRole('textbox', { name: 'Вопрос о барьерах', exact: true }).fill(SURVEY_BARRIER_QUESTION);
  await editor.getByRole('textbox', { name: 'Вопрос об условиях', exact: true }).fill(SURVEY_SUPPORT_QUESTION);
  await editor.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: 'Открыть опрос', exact: true }).click();
  const opening = page.getByRole('dialog', { name: 'Открыть опрос?', exact: true });
  await opening.getByRole('button', { name: 'Открыть опрос', exact: true }).click();
  await expect(opening).toBeHidden();
  const url = await page.getByRole('link', { name: 'Открыть отдельную форму', exact: true }).getAttribute('href');
  expect(url).toBeTruthy();
  const parsed = new URL(url!);
  expect(parsed.origin).toBe(SURVEY_ORIGIN);
  expect(parsed.search).toBe('');
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  expect([...fragment.keys()].sort()).toEqual(['invite', 'survey']);
  expect(fragment.get('invite')).toMatch(/^[0-9a-f]{64}$/);
  expect(fragment.get('survey')).toMatch(/^[0-9a-f-]{36}$/);
  return url!;
}

/** Captures requests from the actual standalone entry; it never intercepts them. */
class PublicTransportAudit {
  readonly requests: Request[] = [];
  constructor(page: Page) { page.on('request', (request) => { this.requests.push(request); }); }
  async assertAnonymous() {
    expect(this.requests.some((request) => request.url().includes('/auth/v1/'))).toBe(false);
    expect(this.requests.some((request) => /supabase(?:-js|_supabase-js)/i.test(request.url()))).toBe(false);
    const rpcRequests = this.requests.filter((request) => request.url().includes('/rest/v1/rpc/'));
    expect(rpcRequests.length).toBeGreaterThan(0);
    for (const request of rpcRequests) {
      expect(new URL(request.url()).pathname).toMatch(/\/dw_survey_(?:public_manifest|own_response|save_response|withdraw_response)$/);
      const headers = await request.allHeaders();
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
      expect(headers.apikey).toBe('sb_publishable_workshop_fixture_only');
      expect(headers.referer ?? '').not.toContain('#');
      const body = request.postData() ?? '';
      for (const identity of ['teacher@workshop.test', 'participant-a@workshop.test', HOST_NAME, ALICE_NAME, '00000000-0000-4000-8000-000000000001']) {
        expect(body).not.toContain(identity);
        expect(request.url()).not.toContain(identity);
      }
      expect(body).not.toMatch(/"(?:email|userId|authorId|profileId)"\s*:/);
    }
  }
}

async function fillPublicAnswer(page: Page, answerBarrier: string, research = false, quote = false) {
  await page.getByRole('combobox', { name: 'С какой позиции вы отвечаете?', exact: true }).selectOption('self');
  await page.getByRole('textbox', { name: 'Ответ о барьерах', exact: true }).fill(answerBarrier);
  await page.getByRole('textbox', { name: 'Ответ об условиях', exact: true }).fill('Предсказуемое расписание ухода и доступный присмотр после рабочего дня.');
  await page.getByRole('checkbox', { name: 'Мне исполнилось 18 лет.', exact: true }).check();
  await page.getByRole('checkbox', { name: /^Я добровольно участвую и согласен/ }).check();
  if (research) await page.getByRole('checkbox', { name: /^Дополнительно разрешаю использовать ответ в научном исследовании/ }).check();
  if (quote) await page.getByRole('checkbox', { name: /^Отдельно разрешаю публиковать обезличенные цитаты/ }).check();
}

async function submitPublicAnswer(page: Page) {
  await page.getByRole('button', { name: 'Сохранить ответ', exact: true }).click();
  await expect(page.getByText('Ответ сохранён. Сохраните личный ключ ниже, чтобы управлять им с другого устройства.', { exact: true })).toBeVisible();
}

test('mobile lifecycle work keeps multiple stages and votes, pointer moves require confirmation, and a concurrent edit retains its draft', async ({
  page, browser, request,
}, info) => {
  const context = await freshContext(browser, true);
  try {
    const participant = await context.newPage();
    audit.watch(participant, 'mobile-author');
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    const { code } = await createSession(page);
    await login(participant, 'participant-a@workshop.test', ALICE_NAME, request);
    await joinSession(participant, code);
    await createBarrier(participant);
    await expect(card(participant)).toContainText('Жизненные планы (основной этап)');
    await expect(card(participant)).toContainText('Следующий ребёнок');
    await barriers(page);
    await expect(card(page)).toContainText(ALICE_NAME);
    await card(page).getByRole('button', { name: 'Значим: 0', exact: true }).click();
    await participant.bringToFront();
    await card(participant).getByRole('button', { name: 'Не могу оценить: 0', exact: true }).click();
    await expect(card(participant).getByRole('button', { name: 'Не могу оценить: 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await card(participant).getByRole('button', { name: 'Отменить мою оценку', exact: true }).click();
    await expect(card(participant).getByRole('button', { name: 'Не могу оценить: 0', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await card(participant).getByRole('button', { name: 'Не приоритетен: 0', exact: true }).click();
    await expect(card(participant).getByRole('button', { name: 'Значим: 1', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await card(participant).getByRole('button', { name: `Выбрать этап для «${BARRIER_TITLE}»`, exact: true }).click();
    const move = participant.getByRole('dialog', { name: 'Перенести основной этап', exact: true });
    await move.getByRole('combobox', { name: 'Новый основной этап', exact: true }).selectOption('preschool');
    await expect(move.getByRole('checkbox', { name: 'Оставить прежний этап дополнительным', exact: true })).toBeChecked();
    await move.getByRole('button', { name: 'Подтвердить перенос', exact: true }).click();
    await expect(move).toBeHidden();
    await expect(card(participant)).toContainText('Дошкольный период (основной этап)');
    await noOverflow(participant, 390);
    await capture(participant, info, 'stage4-lifecycle-mobile-390.png');
    await participant.setViewportSize({ width: 320, height: 844 });
    await noOverflow(participant, 320);
    await capture(participant, info, 'stage4-lifecycle-mobile-320.png');
    await participant.setViewportSize({ width: 390, height: 844 });

    await page.bringToFront();
    await expect(card(page)).toContainText('Дошкольный период (основной этап)');
    const handle = card(page).getByRole('button', { name: `Перенести барьер «${BARRIER_TITLE}»`, exact: true });
    const target = page.locator('.barrier-timeline [data-stage-drop="first_child"]');
    await handle.scrollIntoViewIfNeeded();
    const sourceBox = await handle.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    expect(targetBox!.y).toBeGreaterThanOrEqual(0);
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 14 });
    await page.mouse.up();
    const pointerMove = page.getByRole('dialog', { name: 'Перенести основной этап', exact: true });
    await expect(pointerMove.getByRole('combobox', { name: 'Новый основной этап', exact: true })).toHaveValue('first_child');
    await pointerMove.getByRole('button', { name: 'Подтвердить перенос', exact: true }).click();
    await expect(pointerMove).toBeHidden();
    await capture(page, info, 'stage4-lifecycle-desktop-pointer-move.png');

    await participant.bringToFront();
    await expect(card(participant)).toContainText('Первый ребёнок (основной этап)');
    await card(participant).getByRole('button', { name: `Изменить барьер «${BARRIER_TITLE}»`, exact: true }).click();
    const draft = participant.getByRole('dialog', { name: 'Изменить барьер', exact: true });
    const localTitle = `${BARRIER_TITLE} · авторское уточнение`;
    await draft.getByRole('textbox', { name: 'Краткое название', exact: true }).fill(localTitle);
    await page.bringToFront();
    await card(page).getByRole('button', { name: `Изменить барьер «${BARRIER_TITLE}»`, exact: true }).click();
    const teacherEdit = page.getByRole('dialog', { name: 'Изменить барьер', exact: true });
    await teacherEdit.getByRole('textbox', { name: 'Описание и адресат', exact: true }).fill('После обсуждения уточнили адресата: родители детей с разными часами посещения учреждения.');
    await teacherEdit.getByRole('button', { name: 'Сохранить барьер', exact: true }).click();
    await expect(teacherEdit).toBeHidden();
    await participant.bringToFront();
    await expect(draft.getByText('Появилась новая редакция.', { exact: true })).toBeVisible();
    await expect(draft.getByRole('textbox', { name: 'Краткое название', exact: true })).toHaveValue(localTitle);
    await expect(draft.getByRole('button', { name: 'Сохранить барьер', exact: true })).toBeDisabled();
    await noOverflow(participant, 390);
    await capture(participant, info, 'stage4-conflict-preserved-mobile-draft.png');
    await draft.getByRole('button', { name: 'Сохранить мой текст поверх новой редакции', exact: true }).click();
    await draft.getByRole('button', { name: 'Сохранить барьер', exact: true }).click();
    await expect(draft).toBeHidden();
    await expect(card(participant, localTitle)).toBeVisible();
    await openSessionAfterReload(participant);
    await barriers(participant);
    await expect(card(participant, localTitle)).toContainText('Первый ребёнок (основной этап)');
  } finally { await context.close(); }
});

test('a drawn connection retains exact source jumps, becomes stale after family edits and requires explicit renewed evidence', async ({
  page, browser, request,
}, info) => {
  const context = await freshContext(browser, true);
  try {
    const participant = await context.newPage();
    audit.watch(participant, 'source-link-author');
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    const { code } = await createSession(page);
    await login(participant, 'participant-a@workshop.test', ALICE_NAME, request);
    await joinSession(participant, code);
    await publishAndGroup(page, participant, true);
    await createBarrier(participant);
    await participant.setViewportSize({ width: 1440, height: 1000 });
    await barriers(participant, 'Связи с практиками');
    const handle = participant.getByRole('button', { name: `Соединить барьер «${BARRIER_TITLE}»`, exact: true });
    const target = participant.locator('[data-barrier-family-drop]').filter({ hasText: FAMILY_TITLE });
    await handle.scrollIntoViewIfNeeded();
    const sourceBox = await handle.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await participant.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await participant.mouse.down();
    await participant.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 14 });
    await participant.mouse.up();
    const linkEditor = participant.getByRole('dialog', { name: 'Обосновать новую связь', exact: true });
    await expect(linkEditor).toBeVisible();
    await linkEditor.getByRole('combobox', { name: 'Характер связи', exact: true }).selectOption('needs_adaptation');
    await linkEditor.getByRole('textbox', { name: 'Как практика затрагивает барьер', exact: true }).fill('Компенсация уменьшает финансовую нагрузку, но не решает проблему времени работы учреждения.');
    await linkEditor.getByRole('textbox', { name: 'Условия применения', exact: true }).fill('Сопоставить региональные условия, реальные потребности родителей и муниципальные полномочия.');
    await linkEditor.getByRole('button', { name: 'Сохранить связь', exact: true }).click();
    await expect(linkEditor).toBeHidden();
    const edge = participant.getByRole('button', { name: new RegExp(`^Открыть связь: ${BARRIER_TITLE} —`) });
    await edge.focus();
    await participant.keyboard.press('Enter');
    const inspector = participant.getByRole('region', { name: 'Выбранная связь', exact: true });
    await expect(inspector).toContainText('Редакция оснований сохранена');
    await capture(participant, info, 'stage4-source-connection-desktop.png');
    await participant.setViewportSize({ width: 390, height: 844 });
    await noOverflow(participant, 390);
    await inspector.getByRole('button', { name: 'Открыть основания', exact: true }).click();
    let evidence = participant.getByRole('dialog', { name: 'Сохранённые основания связи', exact: true });
    await expect(evidence).toContainText(/региональных вариантов:\s*2\b/u);
    await expect(evidence.locator('.barrier-evidence-variants').getByRole('button')).toHaveCount(2);
    await evidence.getByRole('button', { name: new RegExp(`^${MORDOVIA_TITLE}`) }).click();
    let detail = participant.getByRole('dialog', { name: MORDOVIA_TITLE, exact: true });
    await expect(detail).toContainText('20–29%');
    await detail.getByRole('button', { name: 'Открыть цитату в документе', exact: true }).click();
    await expect(reader(participant).getByRole('textbox', { name: 'Номер страницы', exact: true })).toHaveValue('59');
    await capture(participant, info, 'stage4-frozen-evidence-original-page59.png');
    await navigation(participant).getByRole('button', { name: 'Занятия', exact: true }).click();
    await barriers(participant);
    await expect(card(participant)).toContainText('Есть актуальная связь');

    await page.bringToFront();
    await sessionTab(page, 'Семейства практик');
    await page.getByRole('button', { name: `Редактировать семейство «${FAMILY_TITLE}»`, exact: true }).click();
    const familyEditor = page.getByRole('dialog', { name: 'Редактировать семейство', exact: true });
    const updatedTitle = `${FAMILY_TITLE} · уточнённая редакция`;
    await familyEditor.getByRole('textbox', { name: 'Название семейства', exact: true }).fill(updatedTitle);
    await familyEditor.getByRole('button', { name: 'Сохранить семейство', exact: true }).click();
    await expect(familyEditor).toBeHidden();
    await participant.bringToFront();
    await expect(card(participant)).toContainText('Связи требуют проверки');
    await participant.getByRole('combobox', { name: 'Показать барьеры', exact: true }).selectOption('gap');
    await expect(card(participant)).toBeVisible();
    await participant.getByRole('combobox', { name: 'Показать барьеры', exact: true }).selectOption('linked');
    await expect(card(participant)).toHaveCount(0);
    await barriers(participant, 'Связи с практиками');
    await participant.getByRole('button', { name: 'Список связей', exact: true }).click();
    await participant.getByRole('region', { name: 'Все связи барьеров и практик', exact: true })
      .getByRole('button').filter({ hasText: BARRIER_TITLE }).click();
    await expect(inspector).toContainText('Эта связь не считается актуальным ответом на барьер.');
    await expect(inspector).toContainText('Семейство или публикации изменились');
    await capture(participant, info, 'stage4-stale-link-mobile.png');
    await inspector.getByRole('button', { name: 'Открыть основания', exact: true }).click();
    evidence = participant.getByRole('dialog', { name: 'Сохранённые основания связи', exact: true });
    await expect(evidence.getByRole('heading', { name: FAMILY_TITLE, exact: true })).toBeVisible();
    await expect(evidence.getByRole('heading', { name: updatedTitle, exact: true })).toHaveCount(0);
    await evidence.getByRole('button', { name: new RegExp(`^${SAKHALIN_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click();
    detail = participant.getByRole('dialog', { name: SAKHALIN_TITLE, exact: true });
    await expect(detail).toContainText('20% на первого ребёнка;50% на второго;100% на третьего');
    await detail.getByRole('button', { name: 'Открыть цитату в документе', exact: true }).click();
    await expect(reader(participant).getByRole('textbox', { name: 'Номер страницы', exact: true })).toHaveValue('37');
    await navigation(participant).getByRole('button', { name: 'Занятия', exact: true }).click();
    await barriers(participant, 'Связи с практиками');
    // Buttons provide the same connection workflow on narrow screens, without a drag gesture.
    await participant.getByRole('button', { name: new RegExp(`^${BARRIER_TITLE} Несколько этапов$`) }).click();
    await participant.locator('[data-barrier-family-drop]').filter({ hasText: updatedTitle }).click();
    await participant.getByRole('button', { name: 'Связать', exact: true }).click();
    const renewed = participant.getByRole('dialog', { name: 'Проверить и сохранить связь', exact: true });
    await expect(renewed.getByRole('textbox', { name: 'Как практика затрагивает барьер', exact: true })).toHaveValue(/Компенсация уменьшает/);
    await renewed.getByRole('button', { name: 'Сохранить связь', exact: true }).click();
    await expect(renewed).toBeHidden();
    await barriers(participant);
    await expect(card(participant)).toContainText('Есть актуальная связь');
    await noOverflow(participant, 390);
    await capture(participant, info, 'stage4-reviewed-evidence-mobile.png');
  } finally { await context.close(); }
});

test('author solutions retain explicit fields and conflict drafts while an observer has no editing or voting controls', async ({
  page, browser, request,
}, info) => {
  const authorContext = await freshContext(browser, true);
  const observerContext = await freshContext(browser);
  try {
    const author = await authorContext.newPage();
    const observer = await observerContext.newPage();
    audit.watch(author, 'solution-author');
    audit.watch(observer, 'observer');
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    const { code } = await createSession(page);
    await login(author, 'participant-a@workshop.test', ALICE_NAME, request);
    await joinSession(author, code);
    await login(observer, 'observer@workshop.test', 'Наблюдатель без права редактирования', request);
    await joinSession(observer, code);
    await page.locator('summary').filter({ hasText: 'Участники группы' }).click();
    await page.getByRole('combobox', { name: 'Роль участника Наблюдатель без права редактирования', exact: true }).selectOption('observer');
    await createBarrier(author);
    await barriers(author, 'Авторские решения');
    await author.getByRole('button', { name: 'Добавить решение', exact: true }).click();
    const editor = author.getByRole('dialog', { name: 'Авторская гипотеза решения', exact: true });
    const solutionTitle = 'Пилот вечернего присмотра';
    await editor.getByRole('checkbox', { name: BARRIER_TITLE, exact: true }).check();
    const fields = {
      'Название решения': solutionTitle,
      'Целевая группа': 'Родители детей дошкольного возраста со сменным рабочим графиком.',
      'Механизм изменения': 'Согласовать добровольный пилот вечернего присмотра после измерения реального спроса.',
      'Первый шаг': 'Собрать запросы родителей двух учреждений и оценить доступность персонала.',
      'Ответственный': 'Муниципальный координатор дошкольного образования',
      'Ресурсы': 'Рассчитать оплату дополнительных часов и проверить доступность помещения.',
      'Проверяемый результат': 'Доля удовлетворённых заявок на присмотр к окончанию первого месяца пилота.',
      'Риски и ограничения': 'Нагрузка на персонал; изменение рождаемости не выводится из краткого пилота.',
    };
    for (const [label, value] of Object.entries(fields)) await editor.getByRole('textbox', { name: label, exact: true }).fill(value);
    await editor.getByRole('button', { name: 'Сохранить решение', exact: true }).click();
    await expect(editor).toBeHidden();
    const solution = card(author, solutionTitle);
    await expect(solution).toContainText(BARRIER_TITLE);
    await solution.getByRole('button', { name: 'Паспорт решения', exact: true }).click();
    const passport = author.getByRole('dialog', { name: solutionTitle, exact: true });
    await expect(passport).toContainText(fields['Проверяемый результат']);
    await expect(passport).toContainText(fields['Риски и ограничения']);
    await noOverflow(author, 390);
    await capture(author, info, 'stage4-author-solution-mobile.png');
    await passport.getByRole('button', { name: 'Закрыть окно', exact: true }).click();

    await observer.bringToFront();
    await barriers(observer);
    await expect(card(observer)).toBeVisible();
    await expect(observer.getByRole('button', { name: 'Добавить барьер', exact: true })).toHaveCount(0);
    await expect(card(observer).getByRole('button', { name: /^Значим:/ })).toBeDisabled();
    await expect(card(observer).getByRole('button', { name: /^Изменить барьер/ })).toHaveCount(0);
    await barriers(observer, 'Авторские решения');
    await expect(card(observer, solutionTitle)).toBeVisible();
    await expect(observer.getByRole('button', { name: 'Добавить решение', exact: true })).toHaveCount(0);
    await expect(observer.getByRole('button', { name: /^Изменить решение/ })).toHaveCount(0);

    await author.bringToFront();
    await solution.getByRole('button', { name: `Изменить решение «${solutionTitle}»`, exact: true }).click();
    const authorDraft = author.getByRole('dialog', { name: 'Изменить гипотезу решения', exact: true });
    const changedMechanism = 'Автор сохранил собственное уточнение механизма до появления новой редакции.';
    await authorDraft.getByRole('textbox', { name: 'Механизм изменения', exact: true }).fill(changedMechanism);
    await page.bringToFront();
    await barriers(page, 'Авторские решения');
    await card(page, solutionTitle).getByRole('button', { name: `Изменить решение «${solutionTitle}»`, exact: true }).click();
    const hostEdit = page.getByRole('dialog', { name: 'Изменить гипотезу решения', exact: true });
    await hostEdit.getByRole('textbox', { name: 'Первый шаг', exact: true }).fill('Согласовать назначение координатора и протокол измерения спроса.');
    await hostEdit.getByRole('button', { name: 'Сохранить решение', exact: true }).click();
    await expect(hostEdit).toBeHidden();
    await author.bringToFront();
    await expect(authorDraft.getByText('Появилась новая редакция.', { exact: true })).toBeVisible();
    await expect(authorDraft.getByRole('textbox', { name: 'Механизм изменения', exact: true })).toHaveValue(changedMechanism);
    await expect(authorDraft.getByRole('button', { name: 'Сохранить решение', exact: true })).toBeDisabled();
    await authorDraft.getByRole('button', { name: 'Сохранить мой текст поверх новой редакции', exact: true }).click();
    await authorDraft.getByRole('button', { name: 'Сохранить решение', exact: true }).click();
    await expect(authorDraft).toBeHidden();
    await expect(solution).toContainText(changedMechanism);
    await openSessionAfterReload(author);
    await barriers(author, 'Авторские решения');
    await expect(card(author, solutionTitle)).toContainText(changedMechanism);
  } finally {
    await authorContext.close();
    await observerContext.close();
  }
});

test('the separate survey origin omits named credentials, updates one receipt and restores withdrawal access without an invitation after close', async ({
  page, browser, request,
}, info) => {
  const restoreContext = await freshContext(browser, true);
  let publicPage: Page | undefined;
  try {
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    await createSession(page);
    const url = await createOpenSurvey(page);
    // The same BrowserContext has a real named classroom session; the separate entry must not reuse it.
    publicPage = await page.context().newPage();
    audit.watch(publicPage, 'anonymous-form-with-named-session-on-other-origin');
    const publicAudit = new PublicTransportAudit(publicPage);
    await publicPage.goto(url);
    await expect(publicPage.getByRole('heading', { name: SURVEY_TITLE, exact: true })).toBeVisible();
    await expect(publicPage.getByRole('textbox', { name: /email|ФИО|муниципалитет/i })).toHaveCount(0);
    const originalAnswer = 'Не хватает устойчивого графика присмотра; личный ответ для закрытого анализа.';
    await fillPublicAnswer(publicPage, originalAnswer);
    await expect(publicPage.getByRole('checkbox', { name: /^Дополнительно разрешаю/ })).not.toBeChecked();
    await expect(publicPage.getByRole('checkbox', { name: /^Отдельно разрешаю/ })).toBeDisabled();
    await publicPage.locator('summary').filter({ hasText: 'Необязательно: планы на ближайшие годы' }).click();
    await publicPage.getByRole('combobox', { name: 'Намерения на ближайшие 12 месяцев', exact: true }).selectOption('probably_no');
    await publicPage.getByRole('combobox', { name: 'Намерения на ближайшие 3 года', exact: true }).selectOption('unsure');
    await publicPage.getByRole('button', { name: /^Уточнить условия изменения/ }).click();
    await publicPage.getByRole('textbox', { name: 'Приоритетное изменение', exact: true }).fill('Гарантированное место в вечерней группе');
    await publicPage.getByRole('combobox', { name: 'Изменение собственного намерения', exact: true }).selectOption('probably_change');
    await publicPage.getByRole('textbox', { name: 'Приоритетное изменение', exact: true }).fill('Доступное жильё и предсказуемое рабочее время');
    await expect(publicPage.getByRole('combobox', { name: 'Изменение собственного намерения', exact: true })).toHaveValue('');
    await publicPage.getByRole('combobox', { name: 'Изменение собственного намерения', exact: true }).selectOption('unsure');
    await submitPublicAnswer(publicPage);
    const downloadEvent = publicPage.waitForEvent('download');
    await publicPage.getByRole('button', { name: 'Скачать квитанцию', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('survey-personal-receipt.json');
    const receiptPath = await download.path();
    expect(receiptPath).toBeTruthy();
    const receipt = JSON.parse(await readFile(receiptPath!, 'utf8')) as { responseSecret: string; restoreUrl: string; surveyId: string; format: string };
    expect(receipt.format).toBe('demography-survey-receipt-1');
    expect(receipt.responseSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.restoreUrl).toBe(`${SURVEY_ORIGIN}/survey.html#survey=${receipt.surveyId}`);
    expect(url).not.toContain(receipt.responseSecret);
    await publicPage.reload();
    await expect(publicPage.getByRole('textbox', { name: 'Ответ о барьерах', exact: true })).toHaveValue(originalAnswer);
    const revisedAnswer = `${originalAnswer} После обсуждения уточняю: проблема вечерних часов.`;
    await publicPage.getByRole('textbox', { name: 'Ответ о барьерах', exact: true }).fill(revisedAnswer);
    await publicPage.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    await expect(publicPage.getByText(/^Ответ сохранён\./)).toBeVisible();
    await capture(publicPage, info, 'stage4-separate-public-form-desktop.png');
    await publicAudit.assertAnonymous();

    await page.bringToFront();
    await page.getByRole('button', { name: 'Просмотреть ответы', exact: true }).click();
    const privateAnswers = page.getByRole('region', { name: 'Ответы, доступные только преподавателю', exact: true });
    await expect(privateAnswers).toContainText('Анкет: 1');
    await expect(privateAnswers).toContainText(revisedAnswer);
    await page.getByRole('button', { name: 'Заменить приглашение', exact: true }).click();
    const rotation = page.getByRole('dialog', { name: 'Заменить ссылку приглашения?', exact: true });
    await rotation.getByRole('button', { name: 'Создать новую ссылку', exact: true }).click();
    await expect(rotation).toBeHidden();
    await page.getByRole('button', { name: 'Закрыть опрос', exact: true }).click();
    const closing = page.getByRole('dialog', { name: 'Завершить приём ответов?', exact: true });
    await closing.getByRole('button', { name: 'Закрыть опрос', exact: true }).click();
    await expect(closing).toBeHidden();

    const restored = await restoreContext.newPage();
    audit.watch(restored, 'receipt-only-mobile-restore');
    const restoredAudit = new PublicTransportAudit(restored);
    await restored.goto(receipt.restoreUrl);
    await restored.getByRole('button', { name: 'У меня есть личный ключ ответа', exact: true }).click();
    await restored.getByRole('textbox', { name: 'Личный ключ', exact: true }).fill(receipt.responseSecret);
    await restored.getByRole('button', { name: 'Восстановить доступ к ответу', exact: true }).click();
    await expect(restored.getByRole('textbox', { name: 'Ответ о барьерах', exact: true })).toHaveValue(revisedAnswer);
    await expect(restored.getByRole('textbox', { name: 'Ответ о барьерах', exact: true })).toBeDisabled();
    await expect(restored.getByRole('button', { name: 'Сохранить изменения', exact: true })).toHaveCount(0);
    await noOverflow(restored, 390);
    await capture(restored, info, 'stage4-closed-survey-receipt-restore-mobile.png');
    await restored.setViewportSize({ width: 320, height: 844 });
    await noOverflow(restored, 320);
    await restored.getByRole('button', { name: 'Удалить мой ответ', exact: true }).click();
    const withdrawal = restored.getByRole('dialog', { name: 'Удалить мой ответ?', exact: true });
    await withdrawal.getByRole('button', { name: 'Удалить мой ответ без восстановления', exact: true }).click();
    await expect(withdrawal).toBeHidden();
    await expect(restored.getByText(/^Ваш ответ удалён\./)).toBeVisible();
    await expect(restored.getByRole('textbox', { name: 'Ответ о барьерах', exact: true })).toHaveCount(0);
    await capture(restored, info, 'stage4-withdrawn-mobile-320.png');
    await restored.reload();
    await expect(restored.getByText(/^Ваш ответ удалён\./)).toBeVisible();
    expect(await restored.locator('main').innerText()).not.toContain(revisedAnswer);
    await restoredAudit.assertAnonymous();
    expect(restoredAudit.requests.some((outgoing) => outgoing.url().endsWith('/dw_survey_public_manifest'))).toBe(false);
    await page.bringToFront();
    await page.getByRole('button', { name: 'Просмотреть ответы', exact: true }).click();
    await expect(privateAnswers).toContainText('Анкет: 0');
    expect(await privateAnswers.innerText()).not.toContain(revisedAnswer);
  } finally {
    await publicPage?.close();
    await restoreContext.close();
  }
});

test('private survey review requires a new generalized barrier, projector payload stays restricted and research ZIP excludes nonconsenting answers', async ({
  page, browser, request,
}, info) => {
  const namedContext = await freshContext(browser);
  const consentedContext = await freshContext(browser, true);
  const educationalContext = await freshContext(browser, true);
  const hostSurveyRequests: string[] = [];
  page.on('request', (outgoing) => {
    if (/\/dw_survey_/.test(outgoing.url())) hostSurveyRequests.push(outgoing.url());
  });
  let projector: Page | undefined;
  try {
    const participant = await namedContext.newPage();
    const consented = await consentedContext.newPage();
    const educational = await educationalContext.newPage();
    audit.watch(participant, 'named-board-reader');
    audit.watch(consented, 'research-consented-form');
    audit.watch(educational, 'educational-only-form');
    const consentedAudit = new PublicTransportAudit(consented);
    const educationalAudit = new PublicTransportAudit(educational);
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    const { code, sessionId } = await createSession(page);
    await login(participant, 'participant-a@workshop.test', ALICE_NAME, request);
    await joinSession(participant, code);
    const url = await createOpenSurvey(page);
    const researchAnswer = '=1+1\nОтвет с отдельным исследовательским согласием и разрешением цитирования.';
    const educationalAnswer = 'Только для учебного обсуждения: этот ответ исключён из исследовательской выгрузки.';
    await consented.goto(url);
    await fillPublicAnswer(consented, researchAnswer, true, true);
    await submitPublicAnswer(consented);
    await noOverflow(consented, 390);
    await educational.goto(url);
    await fillPublicAnswer(educational, educationalAnswer);
    await submitPublicAnswer(educational);
    await page.bringToFront();
    expect(hostSurveyRequests.some((request) => request.endsWith('/dw_survey_invitation_state'))).toBe(true);
    expect(hostSurveyRequests.some((request) => request.endsWith('/dw_survey_host_state'))).toBe(false);
    await page.getByRole('button', { name: 'Просмотреть ответы', exact: true }).click();
    const privateView = page.getByRole('region', { name: 'Ответы, доступные только преподавателю', exact: true });
    await expect(privateView).toContainText('Анкет: 2');
    await expect(privateView).toContainText('согласие на исследование: 1');
    await expect(privateView).toContainText('согласие на цитирование: 1');
    await expect(privateView).toContainText(researchAnswer);
    await expect(privateView).toContainText(educationalAnswer);
    await capture(page, info, 'stage4-host-private-review-synthetic-answers.png');
    await participant.bringToFront();
    await barriers(participant);
    await expect(participant.getByRole('heading', { name: 'Здесь начинается обсуждение', exact: true })).toBeVisible();
    expect(await participant.locator('main').innerText()).not.toContain(educationalAnswer);
    await expect(participant.getByRole('button', { name: 'Просмотреть ответы', exact: true })).toHaveCount(0);

    await page.bringToFront();
    await page.getByRole('button', { name: 'Сформулировать обобщение', exact: true }).click();
    const summary = page.getByRole('dialog', { name: 'Добавить барьер', exact: true });
    await expect(summary.getByRole('textbox', { name: 'Краткое название', exact: true })).toHaveValue('');
    await expect(summary.getByRole('textbox', { name: 'Описание и адресат', exact: true })).toHaveValue('');
    await expect(summary.getByRole('combobox', { name: 'Основание формулировки', exact: true })).toHaveValue('survey_summary');
    const generalTitle = 'Доступность присмотра в нестандартные часы';
    await summary.getByRole('textbox', { name: 'Краткое название', exact: true }).fill(generalTitle);
    await summary.getByRole('textbox', { name: 'Описание и адресат', exact: true }).fill('В ходе обсуждения выделена гипотеза о несоответствии расписаний семей и учреждений. Персональные ответы в карточку не переносятся.');
    await summary.getByRole('combobox', { name: 'Основной этап', exact: true }).selectOption('preschool');
    await summary.getByRole('button', { name: 'Сохранить барьер', exact: true }).click();
    await expect(summary).toBeHidden();
    await participant.bringToFront();
    await expect(card(participant, generalTitle)).toBeVisible();
    expect(await participant.locator('main').innerText()).not.toContain(researchAnswer);
    expect(await participant.locator('main').innerText()).not.toContain(educationalAnswer);

    await page.bringToFront();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Выгрузить для исследования', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    const file = await download.path();
    expect(file).toBeTruthy();
    const archive = unzipSync(await readFile(file!));
    expect(Object.keys(archive).sort()).toEqual(['README.md', 'questionnaire.json', 'records.csv', 'records.json']);
    const exported = JSON.parse(strFromU8(archive['records.json']!)) as {
      records: Array<{ answerBarrier: string; consentResearch: boolean; consentQuote: boolean }>;
      samplingNote: string;
    };
    expect(exported.records).toHaveLength(1);
    expect(exported.records[0]!.answerBarrier).toBe(researchAnswer);
    expect(exported.records[0]!.consentResearch).toBe(true);
    expect(exported.records[0]!.consentQuote).toBe(true);
    const csv = strFromU8(archive['records.csv']!);
    expect(csv).toContain('"\'=1+1\n');
    for (const bytes of Object.values(archive)) {
      const text = strFromU8(bytes);
      expect(text).not.toContain(educationalAnswer);
      expect(text).not.toMatch(/"(?:rowKey|responseSecret|userId|profileId)"\s*:/);
    }
    expect(strFromU8(archive['README.md']!)).toContain('не гарантирует число уникальных людей');

    const requests: string[] = [];
    const payloads: Promise<unknown>[] = [];
    page.context().once('page', (opened) => {
      audit.watch(opened, 'restricted-barriers-projector');
      opened.on('request', (outgoing) => {
        if (outgoing.url().includes('/rest/v1/rpc/')) requests.push(outgoing.url());
      });
      opened.on('response', (response) => {
        if (response.url().endsWith('/dw_barriers_projector_snapshot') && response.ok()) payloads.push(response.json());
      });
    });
    const opening = page.context().waitForEvent('page');
    await page.getByRole('button', { name: 'Экран проектора', exact: true }).click();
    projector = await opening;
    await expect(projector).toHaveURL(new RegExp(`session=${sessionId}.*projector=1`));
    await projector.getByRole('button', { name: 'Барьеры', exact: true }).click();
    await expect(projector.getByRole('heading', { name: generalTitle, exact: true })).toBeVisible();
    await expect.poll(() => payloads.length).toBeGreaterThan(0);
    const received = await Promise.all(payloads) as Array<{ survey: Record<string, unknown> | null }>;
    for (const value of received) {
      expect(value.survey).not.toBeNull();
      expect(Object.keys(value.survey!).sort()).toEqual(['responseCount', 'status', 'title']);
      expect(value.survey!.responseCount).toBeNull();
      const json = JSON.stringify(value);
      expect(json).not.toMatch(/"(?:authorId|userId|email|myVote|myVoteRevision|answerBarrier|answerSupport|rowKey|consentResearch|invitationDigest)"\s*:/);
      expect(json).not.toContain(researchAnswer);
      expect(json).not.toContain(educationalAnswer);
    }
    expect(requests.some((url) => url.endsWith('/dw_barriers_projector_snapshot'))).toBe(true);
    expect(requests.some((url) => /\/(?:dw_session_snapshot|dw_barriers_snapshot|dw_survey_host_state|dw_survey_research_export|dw_invitation)$/.test(url))).toBe(false);
    const body = await projector.locator('main').innerText();
    for (const value of [researchAnswer, educationalAnswer, HOST_NAME, ALICE_NAME, 'teacher@workshop.test', 'participant-a@workshop.test', code]) expect(body).not.toContain(value);
    await capture(projector, info, 'stage4-projector-generalized-barriers.png');
    await consentedAudit.assertAnonymous();
    await educationalAudit.assertAnonymous();
  } finally {
    await projector?.close();
    await namedContext.close();
    await consentedContext.close();
    await educationalContext.close();
  }
});

test('bad invitations and the classroom origin expose no form data, wrong receipts expose no answer and purge removes raw content', async ({
  page, browser, request,
}, info) => {
  const ownerContext = await freshContext(browser, true);
  const outsiderContext = await freshContext(browser);
  let wrongOrigin: Page | undefined;
  try {
    const owner = await ownerContext.newPage();
    const outsider = await outsiderContext.newPage();
    audit.watch(owner, 'purged-survey-owner');
    audit.watch(outsider, 'invalid-invitation-and-receipt');
    const ownerAudit = new PublicTransportAudit(owner);
    const outsiderAudit = new PublicTransportAudit(outsider);
    await login(page, 'teacher@workshop.test', HOST_NAME, request);
    await createSession(page);
    const url = await createOpenSurvey(page);
    const invitation = new URL(url);
    const id = new URLSearchParams(invitation.hash.slice(1)).get('survey')!;
    const invalid = `${SURVEY_ORIGIN}/survey.html#survey=${id}&invite=${'0'.repeat(64)}`;
    audit.expectRejection('dw_survey_public_manifest', [400, 403]);
    const refused = outsider.waitForResponse((response) => response.url().endsWith('/dw_survey_public_manifest'));
    await outsider.goto(invalid);
    const refusal = await refused;
    expect([400, 403]).toContain(refusal.status());
    expect((await refusal.json()).message).toMatch(/INVITATION.*INVALID|INVALID_INVITATION|NOT_FOUND/);
    await expect(outsider.getByRole('alert').filter({ hasText: /Приглашение заменено|не найден/ })).toBeVisible();
    await expect(outsider.getByRole('textbox', { name: 'Ответ о барьерах', exact: true })).toHaveCount(0);
    expect(await outsider.locator('main').innerText()).not.toContain(SURVEY_TITLE);

    wrongOrigin = await page.context().newPage();
    audit.watch(wrongOrigin, 'survey-refuses-classroom-origin');
    const wrongRequests: string[] = [];
    wrongOrigin.on('request', (outgoing) => { wrongRequests.push(outgoing.url()); });
    await wrongOrigin.goto(`${BASE_URL}/survey.html${invitation.hash}`);
    await expect(wrongOrigin.getByRole('alert')).toBeVisible();
    await expect(wrongOrigin.getByRole('textbox', { name: 'Ответ о барьерах', exact: true })).toHaveCount(0);
    expect(wrongRequests.some((outgoing) => /\/auth\/v1\/|\/rest\/v1\/rpc\//.test(outgoing))).toBe(false);
    await capture(wrongOrigin, info, 'stage4-survey-refuses-classroom-origin.png');

    await owner.goto(url);
    const answer = 'Ответ для проверки удаления: текст должен исчезнуть после очистки опроса.';
    await fillPublicAnswer(owner, answer, true);
    await submitPublicAnswer(owner);
    await outsider.goto(`${SURVEY_ORIGIN}/survey.html#survey=${id}`);
    await outsider.getByRole('button', { name: 'У меня есть личный ключ ответа', exact: true }).click();
    await outsider.getByRole('textbox', { name: 'Личный ключ', exact: true }).fill('f'.repeat(64));
    await outsider.getByRole('button', { name: 'Восстановить доступ к ответу', exact: true }).click();
    await expect(outsider.getByRole('alert').filter({ hasText: 'По этому ключу отправленный ответ не найден' })).toBeVisible();
    expect(await outsider.locator('main').innerText()).not.toContain(answer);
    await expect(outsider.getByRole('textbox', { name: 'Ответ о барьерах', exact: true })).toHaveCount(0);

    await page.bringToFront();
    await page.getByRole('button', { name: 'Удалить ответы опроса', exact: true }).click();
    const purge = page.getByRole('dialog', { name: 'Удалить все ответы этого опроса?', exact: true });
    await purge.getByRole('button', { name: 'Удалить все ответы', exact: true }).click();
    await expect(purge).toBeHidden();
    await expect(page.getByRole('button', { name: 'Создать опрос', exact: true })).toBeEnabled();
    await expect(page.getByRole('region', { name: 'Ответы, доступные только преподавателю', exact: true })).toHaveCount(0);
    await owner.bringToFront();
    await owner.reload();
    await expect(owner.getByText(/^(?:Организатор удалил ответы\.|Ваш ответ удалён\.)/)).toBeVisible();
    await expect(owner.getByRole('textbox', { name: 'Ответ о барьерах', exact: true })).toHaveCount(0);
    await expect(owner.getByRole('button', { name: 'Сохранить изменения', exact: true })).toHaveCount(0);
    expect(await owner.locator('main').innerText()).not.toContain(answer);
    await noOverflow(owner, 390);
    await capture(owner, info, 'stage4-purged-survey-mobile.png');
    await ownerAudit.assertAnonymous();
    await outsiderAudit.assertAnonymous();
  } finally {
    await wrongOrigin?.close();
    await ownerContext.close();
    await outsiderContext.close();
  }
});
