// Utilidades compartidas para lanzar corridas de prueba desde la UX.
// Reutiliza el mismo patron que /api/chat-consistency/run: un archivo de estado
// en resultados/, seguimiento por PID y un log crudo que la UI sondea.
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const ROOT = process.cwd();
export const RESULTS_DIR = path.join(ROOT, 'resultados');

export function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Lee las lineas del log crudo (relativo al repo) sin espacios vacios.
export function readLogLines(logPath) {
  if (!logPath) return [];
  const abs = path.join(ROOT, logPath);
  if (!fs.existsSync(abs)) return [];
  return fs.readFileSync(abs, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

export function readLogTail(logPath, tail = 80) {
  return readLogLines(logPath).slice(-tail).join('\n');
}

// Crea un almacen de estado para una corrida concreta. `stateFile` es el nombre
// del JSON de estado dentro de resultados/ (por ejemplo `.security-run.json`).
export function createJobStore(stateFile) {
  const STATE_PATH = path.join(RESULTS_DIR, stateFile);

  function writeState(state) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return state;
  }

  function readState() {
    return readJson(STATE_PATH);
  }

  // Si el estado dice `running` pero el proceso ya no existe, lo marca como fallido
  // para que la UI no quede esperando por siempre.
  function normalizeState(state) {
    if (!state) return null;
    if (state.status === 'running' && !isProcessRunning(state.pid)) {
      return writeState({
        ...state,
        status: 'failed',
        finished_at: utcNow(),
        error: 'El proceso ya no esta activo y no dejo cierre registrado.',
      });
    }
    return state;
  }

  return { STATE_PATH, writeState, readState, normalizeState };
}

// Respuesta JSON estandar con estado + cola del log + progreso opcional.
export function stateResponse(state, { store, buildProgress, status = 200 } = {}) {
  const normalized = store ? store.normalizeState(state) : state;
  return NextResponse.json(
    {
      state: normalized,
      log_tail: readLogTail(normalized?.log_path),
      progress: buildProgress ? buildProgress(normalized) : null,
    },
    { status },
  );
}

export function parseInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

// Devuelve true si el resultado (relativo al repo) existe en disco.
export function resultExists(relativePath) {
  return Boolean(relativePath) && fs.existsSync(path.join(ROOT, relativePath));
}
