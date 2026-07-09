import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import {
  ROOT,
  RESULTS_DIR,
  utcNow,
  createJobStore,
  readLogLines,
  stateResponse,
} from '../../_jobRunner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const store = createJobStore('.security-run.json');

// Catalogo de escaneos disponibles. Cada uno es un runner existente que ya
// escribe su propia evidencia en resultados/ con el formato estandar.
const SCANNERS = {
  secret: {
    label: 'Secret scan',
    script: path.join('scripts', 'run_secret_scan.py'),
    category: 'secret',
  },
  dependency: {
    label: 'Dependency audit',
    script: path.join('scripts', 'run_dependency_audit.py'),
    category: 'dependency',
  },
  sast: {
    label: 'SAST (Bandit)',
    script: path.join('scripts', 'run_bandit_sast.py'),
    category: 'sast',
  },
  dast: {
    label: 'DAST (OWASP ZAP)',
    script: path.join('scripts', 'run_dast_zap.py'),
    category: 'dast',
  },
};

function pythonBin() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

// Convierte el log en progreso por paso. La ruta escribe marcadores
// "step-start <key>" y "step-done <key> code=<n>".
function buildProgress(state) {
  if (!state) return null;
  const requested = Array.isArray(state.scans) ? state.scans : [];
  const lines = readLogLines(state.log_path);
  const done = {};
  let current = null;
  for (const line of lines) {
    const start = line.match(/^step-start\s+(\S+)/);
    if (start) { current = start[1]; continue; }
    const end = line.match(/^step-done\s+(\S+)\s+code=(-?\d+)/);
    if (end) {
      done[end[1]] = Number(end[2]);
      current = null;
    }
  }
  const steps = requested.map((key) => ({
    key,
    label: SCANNERS[key]?.label || key,
    status: done[key] === undefined
      ? (current === key ? 'running' : 'pending')
      : (done[key] === 0 ? 'done' : 'error'),
    exit_code: done[key],
  }));
  const completed = steps.filter((step) => step.status === 'done' || step.status === 'error').length;
  return {
    total_steps: requested.length,
    completed_steps: completed,
    current_step: state.status === 'running' ? current : null,
    percent: requested.length ? Math.min(100, Math.round((completed / requested.length) * 100)) : 0,
    steps,
  };
}

export async function GET() {
  return stateResponse(store.readState(), { store, buildProgress });
}

export async function POST(request) {
  const current = store.normalizeState(store.readState());
  if (current?.status === 'running') {
    return stateResponse(current, { store, buildProgress, status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  const requested = Array.isArray(body.scans) ? body.scans : ['secret', 'dependency'];
  const scans = requested.filter((key) => Object.prototype.hasOwnProperty.call(SCANNERS, key));
  if (scans.length === 0) {
    return NextResponse.json({ error: 'Selecciona al menos un escaneo valido (secret, dependency, sast, dast).' }, { status: 400 });
  }

  // Opciones especificas de DAST (se pasan como env SOLO al script de ZAP).
  const dastOpts = body.dast || {};
  const dastEnv = {};
  if (dastOpts.use_auth === true || String(dastOpts.use_auth) === 'true') dastEnv.DAST_USE_AUTH = 'true';
  if (dastOpts.pull === true || String(dastOpts.pull) === 'true') dastEnv.DAST_PULL = '1';
  const minutes = Number(dastOpts.minutes);
  if (Number.isFinite(minutes) && minutes >= 1) dastEnv.DAST_MINUTES = String(Math.min(5, Math.trunc(minutes)));

  for (const key of scans) {
    if (!fs.existsSync(path.join(ROOT, SCANNERS[key].script))) {
      return NextResponse.json({ error: `No existe ${SCANNERS[key].script}.` }, { status: 500 });
    }
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = `security-suite-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
  const logPath = path.join('resultados', `${runId}.log`);
  const logStream = fs.createWriteStream(path.join(ROOT, logPath), { flags: 'a' });

  const state = store.writeState({
    id: runId,
    status: 'running',
    pid: process.pid,
    started_at: utcNow(),
    finished_at: null,
    scans,
    dast_auth: Boolean(dastEnv.DAST_USE_AUTH),
    log_path: logPath,
    exit_codes: {},
  });

  logStream.write(`[${state.started_at}] launching security suite ${runId}\n`);
  logStream.write(`scans=${scans.join(',')}${scans.includes('dast') ? ` dast_auth=${Boolean(dastEnv.DAST_USE_AUTH)}` : ''}\n`);

  // Ejecuta los escaneos en secuencia; cada uno deja su propio resultado.
  runSequential(scans, 0, logStream, runId, dastEnv);

  return stateResponse(state, { store, buildProgress, status: 202 });
}

function runSequential(scans, index, logStream, runId, dastEnv = {}) {
  if (index >= scans.length) {
    const finishedAt = utcNow();
    const latest = store.readState();
    const codes = latest?.exit_codes || {};
    const anyFailed = Object.values(codes).some((code) => code !== 0);
    store.writeState({
      ...latest,
      status: anyFailed ? 'failed' : 'finished',
      finished_at: finishedAt,
    });
    logStream.write(`[${finishedAt}] suite finished exit_codes=${JSON.stringify(codes)}\n`);
    logStream.end();
    return;
  }

  const key = scans[index];
  const scanner = SCANNERS[key];
  logStream.write(`step-start ${key}\n`);

  // Las opciones DAST_* se inyectan solo al escaneo dinamico (ZAP).
  const extraEnv = key === 'dast' ? dastEnv : {};
  const child = spawn(pythonBin(), [scanner.script], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => logStream.write(chunk));
  child.stderr.on('data', (chunk) => logStream.write(chunk));

  child.on('error', (error) => {
    logStream.write(`step-done ${key} code=-1\n`);
    logStream.write(`[${utcNow()}] ERROR ${String(error.message || error)}\n`);
    const latest = store.readState();
    store.writeState({ ...latest, exit_codes: { ...(latest?.exit_codes || {}), [key]: -1 } });
    runSequential(scans, index + 1, logStream, runId, dastEnv);
  });

  child.on('close', (code) => {
    logStream.write(`step-done ${key} code=${code}\n`);
    const latest = store.readState();
    store.writeState({ ...latest, exit_codes: { ...(latest?.exit_codes || {}), [key]: code } });
    runSequential(scans, index + 1, logStream, runId, dastEnv);
  });
}
