import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import {
  ROOT,
  RESULTS_DIR,
  utcNow,
  timestamp,
  readJson,
  createJobStore,
  readLogLines,
  stateResponse,
  parseInteger,
  resultExists,
} from '../../_jobRunner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const store = createJobStore('.load-run.json');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'run_load_test.js');

// Progreso en vivo: toma el ultimo "tick" que emite el runner cada segundo.
function buildProgress(state) {
  if (!state) return null;
  const lines = readLogLines(state.log_path);
  let last = null;
  for (const line of lines) {
    const match = line.match(/^tick\s+elapsed_ms=(\d+)\s+reqs=(\d+)\s+ok=(\d+)\s+err=(\d+)\s+p95_ms=(\S+)/);
    if (match) {
      last = {
        elapsed_ms: Number(match[1]),
        requests: Number(match[2]),
        ok: Number(match[3]),
        errors: Number(match[4]),
        p95_ms: match[5] === '-' ? null : Number(match[5]),
      };
    }
  }
  const durationMs = Number(state.duration_ms || 0) || 0;
  const percent = last && durationMs ? Math.min(100, Math.round((last.elapsed_ms / durationMs) * 100)) : 0;
  return {
    duration_ms: durationMs,
    percent: state.status === 'running' ? percent : 100,
    ...(last || { elapsed_ms: 0, requests: 0, ok: 0, errors: 0, p95_ms: null }),
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
  if (!fs.existsSync(SCRIPT_PATH)) {
    return NextResponse.json({ error: 'No existe scripts/run_load_test.js.' }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const targetUrl = String(body.target_url || '').trim();
  const relPath = String(body.path || '/').trim() || '/';
  const method = String(body.method || 'GET').trim().toUpperCase();
  const concurrency = parseInteger(body.concurrency, 10, 1, 200);
  const durationMs = parseInteger(body.duration_ms, 20000, 1000, 300000);
  const timeoutMs = parseInteger(body.timeout_ms, 15000, 1000, 120000);
  const maxErrorRate = Math.max(0, Math.min(1, Number(body.max_error_rate) || 0.05));
  const p95SloMs = parseInteger(body.p95_slo_ms, 0, 0, 300000);
  const useAuth = body.use_auth === true || String(body.use_auth) === 'true';

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = `load-${timestamp()}`;
  const logPath = path.join('resultados', `${runId}.log`);
  const resultPathRel = path.join('resultados', `${runId}.json`);

  const state = store.writeState({
    id: runId,
    status: 'running',
    pid: null,
    started_at: utcNow(),
    finished_at: null,
    target_url: targetUrl || null,
    path: relPath,
    method,
    concurrency,
    duration_ms: durationMs,
    timeout_ms: timeoutMs,
    max_error_rate: maxErrorRate,
    p95_slo_ms: p95SloMs,
    use_auth: useAuth,
    log_path: logPath,
    result_path: resultPathRel,
  });

  const logStream = fs.createWriteStream(path.join(ROOT, logPath), { flags: 'a' });
  logStream.write(`[${state.started_at}] launching load ${runId}\n`);
  logStream.write(`target=${targetUrl || '(env)'} concurrency=${concurrency} duration_ms=${durationMs}\n`);

  const child = spawn(process.execPath, [SCRIPT_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      LOAD_RUN_ID: runId,
      LOAD_TARGET_URL: targetUrl,
      LOAD_PATH: relPath,
      LOAD_METHOD: method,
      LOAD_CONCURRENCY: String(concurrency),
      LOAD_DURATION_MS: String(durationMs),
      LOAD_TIMEOUT_MS: String(timeoutMs),
      LOAD_MAX_ERROR_RATE: String(maxErrorRate),
      LOAD_P95_SLO_MS: String(p95SloMs),
      LOAD_USE_AUTH: String(useAuth),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const started = store.readState();
  store.writeState({ ...started, pid: child.pid });

  child.stdout.on('data', (chunk) => logStream.write(chunk));
  child.stderr.on('data', (chunk) => logStream.write(chunk));
  child.on('error', (error) => {
    const latest = readJson(store.STATE_PATH);
    store.writeState({ ...latest, status: 'failed', finished_at: utcNow(), error: String(error.message || error) });
    logStream.write(`[${utcNow()}] ERROR ${String(error.message || error)}\n`);
    logStream.end();
  });
  child.on('close', (code, signal) => {
    const finishedAt = utcNow();
    const latest = readJson(store.STATE_PATH);
    const ok = resultExists(latest?.result_path);
    store.writeState({ ...latest, status: ok ? 'finished' : 'failed', finished_at: finishedAt, exit_code: code, signal });
    logStream.write(`[${finishedAt}] finished code=${code} signal=${signal || ''}\n`);
    logStream.end();
  });

  return stateResponse(store.readState(), { store, buildProgress, status: 202 });
}
