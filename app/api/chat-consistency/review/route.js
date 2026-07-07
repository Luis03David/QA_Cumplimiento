import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// La revision puede tardar segundos por cada caso evaluado.
export const maxDuration = 300;

const ROOT = process.cwd();
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'run_judge_review.py');

// Prefiere el interprete del .venv (tiene las dependencias del juez); si no,
// cae a python3 del PATH.
function pythonBinary() {
  const venvPython = path.join(ROOT, '.venv', 'bin', 'python');
  return fs.existsSync(venvPython) ? venvPython : 'python3';
}

export async function POST(request) {
  if (!fs.existsSync(SCRIPT_PATH)) {
    return NextResponse.json({ error: 'No existe scripts/run_judge_review.py.' }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const runId = String(body.run_id || '').trim();

  const args = [SCRIPT_PATH];
  // Solo acepta run_ids con el patron esperado para no inyectar flags.
  if (runId && /^[A-Za-z0-9._-]+$/.test(runId)) {
    args.push('--run', runId);
  }

  const child = spawn(pythonBinary(), args, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const exitCode = await new Promise((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code));
  });

  if (exitCode !== 0) {
    return NextResponse.json({
      error: 'La revision del juez fallo.',
      detail: (stderr || stdout).split('\n').slice(-15).join('\n').trim(),
    }, { status: 500 });
  }

  // El script imprime "Escrito: resultados/<run>-reviewed.json"
  const match = stdout.match(/Escrito:\s+(resultados\/\S+-reviewed\.json)/);
  const reviewedResultPath = match ? match[1] : null;
  const reviewedRunId = reviewedResultPath
    ? path.basename(reviewedResultPath, '.json')
    : null;

  return NextResponse.json({
    ok: true,
    reviewed_run_id: reviewedRunId,
    log_tail: stdout.split('\n').slice(-20).join('\n').trim(),
  });
}
