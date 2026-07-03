#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { chromium } = require('@playwright/test');
require('dotenv').config({ quiet: true });

const ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(ROOT, '.auth');
const STORAGE_STATE = path.join(AUTH_DIR, 'aitops.json');

async function main() {
  const baseUrl = requiredEnv('AITOPS_BASE_URL');
  const accessEmail = process.env.AITOPS_EMAIL || requiredEnv('AITOPS_USER_EMAIL');
  const userEmail = requiredEnv('AITOPS_USER_EMAIL');
  const password = process.env.AITOPS_USER_PASSWORD || '';
  const codeFromEnv = process.env.AITOPS_ACCESS_CODE || '';

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: process.env.HEADFUL !== 'true' });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await completeCloudflareAccess(page, accessEmail, codeFromEnv);
  await signInIfNeeded(page, userEmail, password);
  await assertApplicationReached(page);

  await page.context().storageState({ path: STORAGE_STATE });
  await browser.close();
  console.log(`Sesion guardada en ${path.relative(ROOT, STORAGE_STATE)}`);
}

async function completeCloudflareAccess(page, email, codeFromEnv) {
  if (!page.url().includes('cloudflareaccess.com')) {
    return;
  }

  const emailInput = page.locator('input[type="email"], input[name="email"], #email').first();
  if (await emailInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await emailInput.fill(email);
    await page.getByRole('button', { name: /send login code|enviar|continuar|continue/i }).click();
  }

  const codeInput = page.locator('input[name="code"], #code, input[placeholder="000000"]').first();
  if (await codeInput.isVisible({ timeout: 15_000 }).catch(() => false)) {
    const code = codeFromEnv || await ask('Codigo Cloudflare recibido por correo: ');
    await codeInput.fill(code.trim());
    await page.getByRole('button', { name: /verify|verificar|continuar|continue/i }).click();
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(3000);
}

async function signInIfNeeded(page, email, password) {
  if (page.url().includes('cloudflareaccess.com')) {
    throw new Error('Cloudflare Access no fue completado; falta codigo valido o sesion autorizada.');
  }

  const bodyText = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
  const looksLikeLogin = /log in|login|sign in|iniciar sesion|correo|email|password|contrasena/i.test(bodyText);
  const passwordInput = page.locator('input[type="password"], input[name*="password" i]').first();

  if (!looksLikeLogin && !(await passwordInput.isVisible({ timeout: 3000 }).catch(() => false))) {
    return;
  }

  const emailInput = page.locator('input[type="email"], input[name*="email" i], input[name*="user" i]').first();
  if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    await emailInput.fill(email);
  }
  if (password && await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    await passwordInput.fill(password);
  }

  const submit = page.getByRole('button', { name: /log in|login|sign in|iniciar|entrar|continuar|continue/i }).first();
  if (await submit.isVisible({ timeout: 5000 }).catch(() => false)) {
    await submit.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);
  }
}

async function assertApplicationReached(page) {
  if (page.url().includes('cloudflareaccess.com')) {
    throw new Error('La sesion sigue en Cloudflare Access.');
  }
  const text = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
  if (/enter your code|send login code|cloudflare access/i.test(text)) {
    throw new Error('La pagina aun muestra el flujo de Cloudflare Access.');
  }
}

async function ask(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta variable requerida: ${name}`);
  }
  return value;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
