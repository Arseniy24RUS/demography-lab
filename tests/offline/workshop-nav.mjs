export const stageLinks = page => page.getByRole('navigation', { name: 'Этапы коллективной работы', exact: true });
export const factorLinks = page => page.getByRole('navigation', { name: 'Виды факторов', exact: true });
export const headerMenu = page => page.getByRole('banner').getByRole('button', { name: 'Меню', exact: true });

export async function revealHeader(page) {
  await page.getByRole('banner').first().waitFor({ state: 'visible' });
  const toggle = headerMenu(page);
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

export async function openStage(page, name) {
  const factor = name === 'Субъективные факторы' || name === 'Объективные факторы';
  await revealHeader(page);
  await stageLinks(page).getByRole('button', { name: factor ? 'Факторы' : name, exact: true }).click();
  if (factor) await factorLinks(page).getByRole('button', { name, exact: true }).click();
}

export async function openReference(page, name) {
  await revealHeader(page);
  const materials = page.getByRole('banner').getByRole('button', { name: 'Материалы', exact: true });
  if (await materials.getAttribute('aria-expanded') !== 'true') await materials.click();
  await page.getByRole('navigation', { name: 'Основная навигация', exact: true })
    .getByRole('button', { name, exact: true }).click();
}
