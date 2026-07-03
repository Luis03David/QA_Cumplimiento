const { expect } = require('@playwright/test');
require('dotenv').config({ quiet: true });

const config = {
  baseUrl: process.env.AITOPS_BASE_URL || 'https://missioncontrol.qa.aitops.ai/',
  accessEmail: process.env.AITOPS_EMAIL || process.env.AITOPS_USER_EMAIL || '',
  email: process.env.AITOPS_USER_EMAIL || '',
  password: process.env.AITOPS_USER_PASSWORD || '',
  accessCode: process.env.AITOPS_ACCESS_CODE || '',
  destructiveEnabled: process.env.ENABLE_DESTRUCTIVE_TESTS === 'true',
};

async function openApplication(page) {
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
  await completeCloudflareAccessIfPossible(page);
  await signInIfNeeded(page);
  await expect(page.locator('body')).not.toContainText(/send login code|enter your code/i);
  expect(page.url(), 'Cloudflare Access debe estar resuelto antes de probar la app').not.toContain('cloudflareaccess.com');
}

async function completeCloudflareAccessIfPossible(page) {
  if (!page.url().includes('cloudflareaccess.com')) {
    return;
  }

  const emailInput = page.locator('input[type="email"], input[name="email"], #email').first();
  if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    if (!config.accessEmail) {
      throw new Error('Falta AITOPS_EMAIL o AITOPS_USER_EMAIL para completar Cloudflare Access.');
    }
    await emailInput.fill(config.accessEmail);
    await page.getByRole('button', { name: /send login code|enviar|continuar|continue/i }).click();
  }

  const codeInput = page.locator('input[name="code"], #code, input[placeholder="000000"]').first();
  if (await codeInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
    if (!config.accessCode) {
      throw new Error('Cloudflare Access requiere OTP. Ejecuta npm run e2e:auth y captura el codigo, o define AITOPS_ACCESS_CODE para esta corrida.');
    }
    await codeInput.fill(config.accessCode);
    await page.getByRole('button', { name: /verify|verificar|continuar|continue/i }).click();
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(3000);
}

async function signInIfNeeded(page) {
  if (page.url().includes('cloudflareaccess.com')) {
    return;
  }

  const bodyText = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
  const passwordInput = page.locator('input[type="password"], input[name*="password" i]').first();
  const hasPassword = await passwordInput.isVisible({ timeout: 3000 }).catch(() => false);
  const looksLikeLogin = /log in|login|sign in|iniciar sesion|password|contrasena/i.test(bodyText);

  if (!hasPassword && !looksLikeLogin) {
    return;
  }

  const emailInput = page.locator('input[type="email"], input[name*="email" i], input[name*="user" i]').first();
  if (config.email && await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    await emailInput.fill(config.email);
  }
  if (config.password && hasPassword) {
    await passwordInput.fill(config.password);
  }

  const submit = page.getByRole('button', { name: /log in|login|sign in|iniciar|entrar|continuar|continue/i }).first();
  if (await submit.isVisible({ timeout: 5000 }).catch(() => false)) {
    await submit.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);
  }
}

async function expectAnyVisible(page, patterns, description) {
  const candidates = page.locator('a, button, [role="button"], input[type="submit"], input[type="button"]')
    .filter({ hasText: new RegExp(patterns.join('|'), 'i') });
  const count = await candidates.count();
  if (count > 0) {
    await expect(candidates.first(), description).toBeVisible();
    return candidates.first();
  }

  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  throw new Error(`${description} no encontrado. Texto visible inicial: ${body.replace(/\s+/g, ' ').slice(0, 700)}`);
}

module.exports = {
  config,
  openApplication,
  expectAnyVisible,
};
