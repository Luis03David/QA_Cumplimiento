import { spawn } from 'node:child_process';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROOT = process.cwd();
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'cloudflare_access_login.js');

function runLogin(envPatch) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...envPatch,
        HEADFUL: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const baseUrl = String(body.base_url || '').trim();
  const accessEmail = String(body.access_email || '').trim();
  const userEmail = String(body.user_email || '').trim();
  const userPassword = String(body.user_password || '').trim();
  const accessCode = String(body.access_code || '').trim();

  if (!baseUrl) return NextResponse.json({ error: 'Falta base_url.' }, { status: 400 });
  if (!accessEmail) return NextResponse.json({ error: 'Falta access_email.' }, { status: 400 });
  if (!userEmail) return NextResponse.json({ error: 'Falta user_email.' }, { status: 400 });

  const result = await runLogin({
    AITOPS_BASE_URL: baseUrl,
    AITOPS_EMAIL: accessEmail,
    AITOPS_USER_EMAIL: userEmail,
    AITOPS_USER_PASSWORD: userPassword,
    AITOPS_ACCESS_CODE: accessCode,
  });

  if (result.code !== 0) {
    return NextResponse.json({
      error: (result.stderr || result.stdout || 'Falló login Cloudflare.').trim(),
      logs: `${result.stdout}\n${result.stderr}`.trim(),
    }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    message: 'Login completado. Sesión guardada en .auth/aitops.json',
    logs: result.stdout.trim(),
  });
}
