import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROOT = process.cwd();
const ENV_FILE = path.join(ROOT, '.env.local');

function parseEnv(content) {
  const env = {};
  for (const line of String(content || '').split('\n')) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
}

function serializeEnv(env) {
  return `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function readLocalEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
}

function updateEnv(patch) {
  const env = readLocalEnv();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '') {
      delete env[key];
    } else {
      env[key] = String(value);
    }
  }
  fs.writeFileSync(ENV_FILE, serializeEnv(env), 'utf8');
}

export async function GET() {
  const env = readLocalEnv();
  return NextResponse.json({
    config: {
      base_url: env.AITOPS_BASE_URL || '',
      access_email: env.AITOPS_EMAIL || env.AITOPS_USER_EMAIL || '',
      user_email: env.AITOPS_USER_EMAIL || '',
    },
  });
}

export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  const baseUrl = String(body.base_url || '').trim();
  const accessEmail = String(body.access_email || '').trim();
  const userEmail = String(body.user_email || '').trim();
  const userPassword = String(body.user_password || '').trim();

  if (!baseUrl) return NextResponse.json({ error: 'Falta base_url.' }, { status: 400 });
  if (!accessEmail) return NextResponse.json({ error: 'Falta access_email.' }, { status: 400 });
  if (!userEmail) return NextResponse.json({ error: 'Falta user_email.' }, { status: 400 });

  updateEnv({
    AITOPS_BASE_URL: baseUrl,
    AITOPS_EMAIL: accessEmail,
    AITOPS_USER_EMAIL: userEmail,
    AITOPS_USER_PASSWORD: userPassword,
  });

  return NextResponse.json({ saved: true });
}
