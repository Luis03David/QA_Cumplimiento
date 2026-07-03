const { test, expect } = require('@playwright/test');
const { openApplication } = require('./helpers/aitops');

test('SMOKE-01 autenticacion y home cargan para el usuario CDD', async ({ page }) => {
  await openApplication(page);

  await expect(page).toHaveTitle(/AITOps|Mission Control/i);
  await expect(page.locator('body')).toContainText(/Fernando Araiza|Mission Control|Camara de Diputados/i);
  await expect(page.getByText(/Sign out/i).first()).toBeVisible();
});

test('SMOKE-02 rutas administrativas restringidas muestran control de acceso', async ({ page }) => {
  await openApplication(page);
  await page.goto('/admin/users', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  await expect(page.locator('body')).toContainText(/Access denied|do not have permission/i);
});

test('SMOKE-03 dashboard de tokens operativo carga sin acciones destructivas', async ({ page }) => {
  await openApplication(page);
  await page.goto('/tokens', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  await expect(page.locator('body')).toContainText(/Tokens/i);
  await expect(page.getByRole('button', { name: /Export/i }).first()).toBeVisible();
});

test('SMOKE-04 configuracion de knowledge base carga', async ({ page }) => {
  await openApplication(page);
  await page.goto('/knowledge/settings', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  await expect(page.locator('body')).toContainText(/KB Settings|Allowlist|Storage|Quotas/i);
});
