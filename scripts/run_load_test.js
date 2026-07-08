#!/usr/bin/env node
// Runner de carga en Node puro (sin k6/artillery). Dispara peticiones concurrentes
// contra un endpoint del target durante una ventana de tiempo y mide latencia
// (p50/p95/p99), throughput y tasa de error. Escribe evidencia en el formato
// estandar de resultados (category=load) para que el dashboard la compare.
//
// Configuracion por variables de entorno (las inyecta /api/load/run):
//   LOAD_RUN_ID        id de corrida (obligatorio en UX; se genera si falta)
//   LOAD_TARGET_URL    URL completa a golpear (default: AITOPS_BASE_URL + LOAD_PATH)
//   LOAD_PATH          ruta relativa si no se da URL completa (default "/")
//   LOAD_METHOD        metodo HTTP (default GET)
//   LOAD_CONCURRENCY   workers concurrentes (default 10)
//   LOAD_DURATION_MS   duracion de la ventana de carga (default 20000)
//   LOAD_TIMEOUT_MS    timeout por peticion (default 15000)
//   LOAD_MAX_ERROR_RATE umbral de fallo (default 0.05 = 5%)
//   LOAD_P95_SLO_MS    SLO opcional de latencia p95; 0 = sin gate (default 0)
//   LOAD_USE_AUTH      "true" para adjuntar cookies de .auth/aitops.json
const fs = require('node:fs');
const path = require('node:path');
try { require('dotenv').config({ quiet: true }); } catch { /* dotenv opcional */ }

const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'resultados');
const STORAGE_STATE = path.join(ROOT, '.auth', 'aitops.json');

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function envFloat(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function resolveTargetUrl() {
  const explicit = String(process.env.LOAD_TARGET_URL || '').trim();
  if (explicit) return explicit;
  const base = String(process.env.AITOPS_BASE_URL || '').trim();
  if (!base) return '';
  const relPath = String(process.env.LOAD_PATH || '/').trim() || '/';
  try {
    return new URL(relPath, base).toString();
  } catch {
    return '';
  }
}

// Construye una cabecera Cookie a partir del storageState de Playwright,
// filtrando por el dominio del target para no mandar cookies ajenas.
function buildCookieHeader(targetUrl) {
  if (String(process.env.LOAD_USE_AUTH || '').toLowerCase() !== 'true') return '';
  if (!fs.existsSync(STORAGE_STATE)) return '';
  let host;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return '';
  }
  try {
    const storage = JSON.parse(fs.readFileSync(STORAGE_STATE, 'utf8'));
    const cookies = Array.isArray(storage.cookies) ? storage.cookies : [];
    const matching = cookies.filter((cookie) => {
      const domain = String(cookie.domain || '').replace(/^\./, '');
      return domain && (host === domain || host.endsWith(`.${domain}`));
    });
    return matching.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  } catch {
    return '';
  }
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(fraction * sortedValues.length) - 1));
  return sortedValues[index];
}

function round(value, digits = 2) {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });

  const runId = String(process.env.LOAD_RUN_ID || `load-${timestamp()}`).trim();
  const targetUrl = resolveTargetUrl();
  const method = String(process.env.LOAD_METHOD || 'GET').trim().toUpperCase() || 'GET';
  const concurrency = Math.max(1, Math.min(200, envInt('LOAD_CONCURRENCY', 10)));
  const durationMs = Math.max(1000, Math.min(300000, envInt('LOAD_DURATION_MS', 20000)));
  const timeoutMs = Math.max(1000, Math.min(120000, envInt('LOAD_TIMEOUT_MS', 15000)));
  const maxErrorRate = Math.max(0, Math.min(1, envFloat('LOAD_MAX_ERROR_RATE', 0.05)));
  const p95SloMs = Math.max(0, envInt('LOAD_P95_SLO_MS', 0));

  const startedAt = utcNow();
  const resultPath = path.join(RESULTS, `${runId}.json`);
  const rawPath = path.join(RESULTS, `${runId}.raw.json`);

  console.log(`load run ${runId}`);
  console.log(`target=${targetUrl || '(sin target)'} method=${method} concurrency=${concurrency} duration_ms=${durationMs} timeout_ms=${timeoutMs}`);

  // Sin target no hay nada que medir: dejamos evidencia como skipped.
  if (!targetUrl) {
    const skipped = buildResult({
      runId, startedAt, targetUrl, method, concurrency, durationMs, timeoutMs,
      maxErrorRate, p95SloMs, latencies: [], statusCounts: {}, errors: [], forcedStatus: 'skipped',
      skipReason: 'No hay target: define LOAD_TARGET_URL o AITOPS_BASE_URL en .env.',
    });
    fs.writeFileSync(resultPath, `${JSON.stringify(skipped, null, 2)}\n`, 'utf8');
    console.log('done status=skipped (sin target)');
    return;
  }

  const cookieHeader = buildCookieHeader(targetUrl);
  if (cookieHeader) console.log('auth cookies adjuntadas desde .auth/aitops.json');

  const latencies = [];
  const statusCounts = {};
  const errors = [];
  let completed = 0;
  let okCount = 0;
  let errorCount = 0;
  const deadline = Date.now() + durationMs;
  const headers = { 'user-agent': 'qa-cumplimiento-load/1.0' };
  if (cookieHeader) headers.cookie = cookieHeader;

  // Reporta progreso periodicamente: la ruta /api/load/run parsea estas lineas.
  const ticker = setInterval(() => {
    const elapsed = durationMs - Math.max(0, deadline - Date.now());
    const sorted = [...latencies].sort((a, b) => a - b);
    const p95 = percentile(sorted, 0.95);
    console.log(`tick elapsed_ms=${Math.min(elapsed, durationMs)} reqs=${completed} ok=${okCount} err=${errorCount} p95_ms=${round(p95) ?? '-'}`);
  }, 1000);

  async function worker() {
    while (Date.now() < deadline) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(targetUrl, { method, headers, redirect: 'manual', signal: controller.signal });
        // Drena el cuerpo para liberar el socket sin acumular memoria.
        await response.arrayBuffer().catch(() => {});
        const elapsed = Date.now() - started;
        latencies.push(elapsed);
        const bucket = `${Math.floor(response.status / 100)}xx`;
        statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;
        completed += 1;
        // 2xx y 3xx cuentan como exito de transporte; 4xx/5xx como error.
        if (bucket === '4xx' || bucket === '5xx') {
          errorCount += 1;
        } else {
          okCount += 1;
        }
      } catch (error) {
        const elapsed = Date.now() - started;
        latencies.push(elapsed);
        completed += 1;
        errorCount += 1;
        const reason = error?.name === 'AbortError' ? 'timeout' : String(error?.message || error);
        errors.push(reason);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  clearInterval(ticker);

  const result = buildResult({
    runId, startedAt, targetUrl, method, concurrency, durationMs, timeoutMs,
    maxErrorRate, p95SloMs, latencies, statusCounts, errors,
  });

  fs.writeFileSync(rawPath, `${JSON.stringify({ latencies, statusCounts, errors: errors.slice(0, 200) }, null, 2)}\n`, 'utf8');
  result.artifacts = [path.relative(ROOT, rawPath)];
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`done status=${result.status} reqs=${completed} error_rate=${round((errorCount / Math.max(completed, 1)))}`);
}

function buildResult({
  runId, startedAt, targetUrl, method, concurrency, durationMs, timeoutMs,
  maxErrorRate, p95SloMs, latencies, statusCounts, errors, forcedStatus, skipReason,
}) {
  const total = latencies.length;
  const sorted = [...latencies].sort((a, b) => a - b);
  const errorCount = Object.entries(statusCounts).reduce((acc, [code, count]) => {
    const bucket = Math.floor(Number(code) / 100);
    return acc + (bucket === 4 || bucket === 5 ? count : 0);
  }, 0) + errors.length;
  const okCount = Math.max(0, total - errorCount);
  const errorRate = total ? errorCount / total : 0;
  const durationSeconds = durationMs / 1000;
  const throughput = durationSeconds ? total / durationSeconds : 0;
  const avgLatency = total ? sorted.reduce((a, b) => a + b, 0) / total : null;
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);

  const details = {
    target: targetUrl,
    method,
    concurrency,
    duration_ms: durationMs,
    timeout_ms: timeoutMs,
    requests_total: total,
    requests_ok: okCount,
    requests_error: errorCount,
    error_rate: round(errorRate, 4),
    throughput_rps: round(throughput),
    latency_ms: {
      min: sorted[0] ?? null,
      p50: round(p50),
      p95: round(p95),
      p99: round(p99),
      max: sorted[sorted.length - 1] ?? null,
      avg: round(avgLatency),
    },
    status_counts: statusCounts,
    error_samples: errors.slice(0, 10),
  };

  const checks = [];

  if (forcedStatus === 'skipped') {
    checks.push({ name: 'load-target', status: 'skipped', message: skipReason || 'Sin target.', details });
  } else {
    checks.push({
      name: 'requests-completadas',
      status: total > 0 ? 'pass' : 'fail',
      message: total > 0
        ? `${total} peticiones completadas (${round(throughput)} req/s).`
        : 'No se completo ninguna peticion.',
      details: { requests_total: total, throughput_rps: round(throughput) },
    });
    checks.push({
      name: 'tasa-de-error',
      status: errorRate <= maxErrorRate ? 'pass' : 'fail',
      message: `Tasa de error ${round(errorRate * 100)}% (umbral ${round(maxErrorRate * 100)}%).`,
      details: { error_rate: round(errorRate, 4), max_error_rate: maxErrorRate, requests_error: errorCount },
    });
    checks.push({
      name: 'latencia-p95',
      status: p95SloMs > 0 ? (p95 !== null && p95 <= p95SloMs ? 'pass' : 'fail') : 'pass',
      message: p95SloMs > 0
        ? `p95 ${round(p95)}ms contra SLO ${p95SloMs}ms.`
        : `p95 ${round(p95)}ms (sin SLO configurado).`,
      details: { p95_ms: round(p95), p95_slo_ms: p95SloMs || null },
    });
  }

  const status = forcedStatus
    || (checks.some((check) => check.status === 'fail')
      ? 'fail'
      : checks.every((check) => check.status === 'skipped') ? 'skipped' : 'pass');

  return {
    schema_version: '1.0',
    run_id: runId,
    tool: 'load-node',
    category: 'load',
    status,
    started_at: startedAt,
    finished_at: utcNow(),
    summary: {
      pass: `Carga OK contra ${targetUrl}: ${total} peticiones, ${round(errorRate * 100)}% error, p95 ${round(p95)}ms.`,
      fail: `Carga con problemas contra ${targetUrl}: ${round(errorRate * 100)}% error, p95 ${round(p95)}ms.`,
      skipped: skipReason || 'Prueba de carga omitida por falta de precondiciones.',
    }[status],
    checks,
    metrics_summary: {
      load: {
        metric: 'requests',
        total,
        pass: okCount,
        fail: errorCount,
        skipped: 0,
        pass_rate: total ? round(okCount / total, 4) : 0,
        avg_latency_ms: round(avgLatency),
      },
    },
  };
}

main().catch((error) => {
  console.error(`ERROR ${String(error?.stack || error)}`);
  process.exitCode = 1;
});
