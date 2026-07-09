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

const store = createJobStore('.report-run.json');
const SCRIPT = path.join('scripts', 'build_report.py');

function pythonBin() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Progreso por fases que el script emite en el log: "phase <nombre>" y al final
// "report-written <ruta>". La UI muestra la ruta del informe generado.
const PHASES = ['collect', 'narrative', 'render'];
const PHASE_LABELS = { collect: 'Reuniendo evidencia', narrative: 'Redactando interpretacion', render: 'Armando informe' };

function buildProgress(state) {
  if (!state) return null;
  const lines = readLogLines(state.log_path);
  let current = null;
  let reportPath = null;
  let narrativeSource = null;
  for (const line of lines) {
    const ph = line.match(/^phase\s+(\S+)/);
    if (ph) current = ph[1];
    const rw = line.match(/^report-written\s+(\S+)/);
    if (rw) reportPath = rw[1];
    const ns = line.match(/^narrative-source\s+(\S+)/);
    if (ns) narrativeSource = ns[1];
  }
  const doneIdx = reportPath ? PHASES.length : Math.max(0, PHASES.indexOf(current));
  const steps = PHASES.map((key, idx) => ({
    key,
    label: PHASE_LABELS[key] || key,
    status: reportPath || idx < doneIdx ? 'done' : (key === current ? 'running' : 'pending'),
  }));
  return {
    total_steps: PHASES.length,
    completed_steps: reportPath ? PHASES.length : doneIdx,
    current_step: state.status === 'running' ? current : null,
    percent: reportPath ? 100 : Math.round((doneIdx / PHASES.length) * 100),
    steps,
    report_path: reportPath || state.report_path || null,
    narrative_source: narrativeSource || state.narrative_source || null,
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

  if (!fs.existsSync(path.join(ROOT, SCRIPT))) {
    return NextResponse.json({ error: `No existe ${SCRIPT}.` }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const args = [SCRIPT];
  if (body.use_llm === false || String(body.use_llm) === 'false') args.push('--no-llm');
  if (body.title) args.push('--title', String(body.title).slice(0, 160));
  if (body.target) args.push('--target', String(body.target).slice(0, 200));
  args.push('--p95-edge', String(clampNumber(body.p95_edge, 1000, 1, 600000)));
  args.push('--p95-app', String(clampNumber(body.p95_app, 1500, 1, 600000)));
  args.push('--max-error-rate', String(clampNumber(body.max_error_rate, 0.02, 0, 1)));
  const sev = ['high', 'medium', 'low', 'informational'].includes(body.blocking_severity)
    ? body.blocking_severity : 'high';
  args.push('--blocking-severity', sev);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = `report-run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
  const logPath = path.join('resultados', `${runId}.log`);
  const logStream = fs.createWriteStream(path.join(ROOT, logPath), { flags: 'a' });

  const state = store.writeState({
    id: runId,
    status: 'running',
    pid: process.pid,
    started_at: utcNow(),
    finished_at: null,
    use_llm: !(body.use_llm === false),
    log_path: logPath,
    report_path: null,
    narrative_source: null,
  });

  logStream.write(`[${state.started_at}] build_report ${args.join(' ')}\n`);

  const child = spawn(pythonBin(), args, {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logStream.write(chunk));
  child.stderr.on('data', (chunk) => logStream.write(chunk));

  child.on('error', (error) => {
    logStream.write(`[${utcNow()}] ERROR ${String(error.message || error)}\n`);
    const latest = store.readState();
    store.writeState({ ...latest, status: 'failed', finished_at: utcNow(), error: String(error.message || error) });
    logStream.end();
  });

  child.on('close', (code) => {
    logStream.write(`[${utcNow()}] exit code=${code}\n`);
    const lines = readLogLines(logPath);
    const reportLine = lines.reverse().find((l) => l.startsWith('report-written '));
    const srcLine = lines.find((l) => l.startsWith('narrative-source '));
    const latest = store.readState();
    store.writeState({
      ...latest,
      status: code === 0 ? 'finished' : 'failed',
      finished_at: utcNow(),
      exit_code: code,
      report_path: reportLine ? reportLine.split(/\s+/)[1] : null,
      narrative_source: srcLine ? srcLine.split(/\s+/)[1] : null,
    });
    logStream.end();
  });

  return stateResponse(state, { store, buildProgress, status: 202 });
}
