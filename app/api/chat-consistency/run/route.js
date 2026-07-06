import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROOT = process.cwd();
const RESULTS_DIR = path.join(ROOT, 'resultados');
const STATE_PATH = path.join(RESULTS_DIR, '.chat-consistency-run.json');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'run_chat_consistency_capture.js');
const DEFAULT_PROMPTS = path.join(ROOT, 'tests', 'chat_consistency_semantic_bank.json');
const STORAGE_STATE = path.join(ROOT, '.auth', 'aitops.json');

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeState(state) {
  if (!state) return null;
  if (state.status === 'running' && !isProcessRunning(state.pid)) {
    const next = {
      ...state,
      status: 'failed',
      finished_at: utcNow(),
      error: 'El proceso ya no esta activo y no dejo cierre registrado.',
    };
    writeState(next);
    return next;
  }
  return state;
}

function readLog(logPath) {
  if (!logPath || !fs.existsSync(path.join(ROOT, logPath))) return '';
  const value = fs.readFileSync(path.join(ROOT, logPath), 'utf8');
  return value.split('\n').slice(-80).join('\n').trim();
}

function stateResponse(state, status = 200) {
  const normalized = normalizeState(state);
  return NextResponse.json({
    state: normalized,
    log_tail: readLog(normalized?.log_path),
  }, { status });
}

function parseInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function safeCaseId(value) {
  return String(value || '').trim();
}

function selectedPromptFile(body, runId) {
  const requestedIds = Array.isArray(body.selected_case_ids)
    ? body.selected_case_ids.map(safeCaseId).filter(Boolean)
    : null;

  if (requestedIds === null) {
    return DEFAULT_PROMPTS;
  }

  if (!fs.existsSync(DEFAULT_PROMPTS)) {
    throw new Error('No existe tests/chat_consistency_semantic_bank.json.');
  }

  const bank = JSON.parse(fs.readFileSync(DEFAULT_PROMPTS, 'utf8'));
  const selected = requestedIds === null
    ? bank
    : bank.filter((item) => requestedIds.includes(item.id));

  if (requestedIds?.length && selected.length !== requestedIds.length) {
    const found = new Set(selected.map((item) => item.id));
    const missing = requestedIds.filter((id) => !found.has(id));
    throw new Error(`Casos no encontrados en banco: ${missing.join(', ')}`);
  }

  const prompts = [...selected];

  if (!prompts.length) {
    throw new Error('Selecciona al menos un caso del catalogo.');
  }

  const promptPath = path.join(RESULTS_DIR, `${runId}.prompts.json`);
  fs.writeFileSync(promptPath, `${JSON.stringify(prompts, null, 2)}\n`, 'utf8');
  return promptPath;
}

export async function GET() {
  return stateResponse(readJson(STATE_PATH));
}

export async function POST(request) {
  const current = normalizeState(readJson(STATE_PATH));
  if (current?.status === 'running') {
    return stateResponse(current, 409);
  }

  if (!fs.existsSync(SCRIPT_PATH)) {
    return NextResponse.json({ error: 'No existe scripts/run_chat_consistency_capture.js.' }, { status: 500 });
  }
  if (!fs.existsSync(STORAGE_STATE)) {
    return NextResponse.json({ error: 'No existe .auth/aitops.json. Corre primero npm run e2e:auth.' }, { status: 412 });
  }

  const body = await request.json().catch(() => ({}));
  const repeats = parseInteger(body.repeats, 3, 1, 5);
  const timeoutMs = parseInteger(body.timeout_ms, 90000, 10000, 300000);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = `chat-consistency-${timestamp()}`;
  let promptPath;
  try {
    promptPath = path.resolve(selectedPromptFile(body, runId));
  } catch (error) {
    return NextResponse.json({ error: String(error.message || error) }, { status: 400 });
  }
  if (!promptPath.startsWith(ROOT) || !fs.existsSync(promptPath)) {
    return NextResponse.json({ error: 'El banco de prompts solicitado no existe dentro del repo.' }, { status: 400 });
  }

  const logPath = path.join('resultados', `${runId}.log`);
  const promptCount = JSON.parse(fs.readFileSync(promptPath, 'utf8')).length;
  const state = {
    id: runId,
    status: 'running',
    pid: null,
    started_at: utcNow(),
    finished_at: null,
    repeats,
    timeout_ms: timeoutMs,
    prompt_path: path.relative(ROOT, promptPath),
    prompt_count: promptCount,
    log_path: logPath,
    result_path: path.join('resultados', `${runId}.json`),
    raw_path: path.join('resultados', `${runId}.raw.json`),
  };

  const logStream = fs.createWriteStream(path.join(ROOT, logPath), { flags: 'a' });
  logStream.write(`[${state.started_at}] launching ${runId}\n`);
  logStream.write(`prompts=${state.prompt_path} repeats=${repeats} timeout_ms=${timeoutMs}\n`);

  const child = spawn(process.execPath, [SCRIPT_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHAT_CONSISTENCY_PROMPTS: promptPath,
      CHAT_CONSISTENCY_REPEATS: String(repeats),
      CHAT_CONSISTENCY_TIMEOUT_MS: String(timeoutMs),
      CHAT_CONSISTENCY_RUN_ID: runId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.pid = child.pid;
  writeState(state);

  child.stdout.on('data', (chunk) => logStream.write(chunk));
  child.stderr.on('data', (chunk) => logStream.write(chunk));
  child.on('error', (error) => {
    const failed = {
      ...readJson(STATE_PATH),
      status: 'failed',
      finished_at: utcNow(),
      error: String(error.message || error),
    };
    logStream.write(`[${failed.finished_at}] ERROR ${failed.error}\n`);
    writeState(failed);
    logStream.end();
  });
  child.on('close', (code, signal) => {
    const finishedAt = utcNow();
    const current = readJson(STATE_PATH);
    const resultExists = current?.result_path && fs.existsSync(path.join(ROOT, current.result_path));
    const finished = {
      ...current,
      status: resultExists ? 'finished' : 'failed',
      finished_at: finishedAt,
      exit_code: code,
      signal,
    };
    logStream.write(`[${finishedAt}] finished code=${code} signal=${signal || ''}\n`);
    writeState(finished);
    logStream.end();
  });

  return stateResponse(state, 202);
}
