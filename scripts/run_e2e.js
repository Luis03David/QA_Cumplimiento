#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
require('dotenv').config({ quiet: true });

const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'resultados');

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function main() {
  fs.mkdirSync(RESULTS, { recursive: true });

  const startedAt = utcNow();
  const runId = `e2e-playwright-${timestamp()}`;
  const rawPath = path.join(RESULTS, `${runId}-playwright.raw.json`);

  const completed = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['playwright', 'test', '--reporter=json'],
    {
      cwd: ROOT,
      env: { ...process.env, CI: process.env.CI || '1' },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    },
  );

  fs.writeFileSync(rawPath, completed.stdout || completed.stderr || '', 'utf8');
  const report = parseReport(completed.stdout);
  const checks = checksFromReport(report, completed);
  const status = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.every((check) => check.status === 'skipped')
      ? 'skipped'
      : 'pass';

  const result = {
    schema_version: '1.0',
    run_id: runId,
    tool: 'playwright',
    category: 'e2e',
    status,
    started_at: startedAt,
    finished_at: utcNow(),
    summary: {
      pass: 'Pruebas E2E completadas sin fallas bloqueantes.',
      fail: 'Pruebas E2E encontraron fallas o precondiciones no cumplidas.',
      skipped: 'Pruebas E2E omitidas por precondiciones faltantes.',
    }[status],
    checks,
    artifacts: [
      path.relative(ROOT, rawPath),
      'test-results',
    ],
  };

  const resultPath = path.join(RESULTS, `${runId}.json`);
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(path.relative(ROOT, resultPath));
  return status === 'fail' ? 1 : 0;
}

function parseReport(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (_error) {
    return null;
  }
}

function checksFromReport(report, completed) {
  if (!report) {
    return [{
      name: 'playwright-json-report',
      status: 'fail',
      message: 'Playwright no produjo JSON parseable.',
      details: {
        exit_code: completed.status,
        stderr: (completed.stderr || '').slice(0, 2000),
      },
    }];
  }

  const specs = [];
  collectSpecs(report.suites || [], specs);
  if (!specs.length) {
    return [{
      name: 'playwright-test-discovery',
      status: completed.status === 0 ? 'skipped' : 'fail',
      message: 'No se encontraron specs ejecutados en el reporte.',
      details: { exit_code: completed.status },
    }];
  }

  return specs.map((spec) => {
    const skipped = spec.tests.every((test) => test.status === 'skipped');
    const ok = !skipped && spec.tests.every((test) => test.status === 'expected');
    const errors = spec.tests.flatMap((test) => test.errors || []);
    return {
      name: spec.title,
      status: skipped ? 'skipped' : ok ? 'pass' : 'fail',
      message: skipped
        ? skippedMessage(spec)
        : ok ? 'Spec completado correctamente.' : 'Spec fallo o una precondicion no se cumplio.',
      details: {
        file: spec.file,
        tests: spec.tests.map((test) => ({
          title: test.title,
          status: test.status,
          outcome: test.outcome,
          annotations: test.annotations,
        })),
        errors: errors.map((error) => String(error.message || error).slice(0, 1000)),
      },
    };
  });
}

function collectSpecs(suites, specs) {
  for (const suite of suites) {
    for (const spec of suite.specs || []) {
      specs.push({
        title: spec.title,
        file: suite.file,
        tests: (spec.tests || []).map((test) => ({
          title: test.title,
          status: test.status,
          outcome: test.outcome,
          annotations: [
            ...(spec.annotations || []),
            ...(test.annotations || []),
          ],
          errors: test.results?.flatMap((result) => result.errors || []) || [],
        })),
      });
    }
    collectSpecs(suite.suites || [], specs);
  }
}

function skippedMessage(spec) {
  const annotation = spec.tests
    .flatMap((test) => test.annotations || [])
    .find((item) => item.type === 'skip' && item.description);
  return annotation?.description || 'Spec omitido por precondicion documentada.';
}

process.exit(main());
