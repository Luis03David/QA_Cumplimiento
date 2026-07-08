#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { request } = require('@playwright/test');
require('dotenv').config({ quiet: true });

const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'resultados');
const STORAGE_STATE = path.join(ROOT, '.auth', 'aitops.json');

const DEFAULT_PROMPTS = [
  {
    id: 'CHAT-CONS-001',
    prompt: 'How do I check whether a systemd service is active on RHEL 9?',
  },
  {
    id: 'CHAT-CONS-002',
    prompt: 'Como reviso si un servicio systemd esta activo en Red Hat?',
  },
  {
    id: 'CHAT-CONS-003',
    prompt: 'What should I check first when nginx returns 502 Bad Gateway?',
  },
];

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value || '').digest('hex');
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function loadToken() {
  const state = JSON.parse(fs.readFileSync(STORAGE_STATE, 'utf8'));
  const origin = (state.origins || []).find((item) => item.origin === 'https://missioncontrol.qa.aitops.ai')
    || (state.origins || [])[0];
  const token = origin?.localStorage?.find((item) => item.name === 'access_token')?.value;
  if (!token) {
    throw new Error('No access_token found in .auth/aitops.json. Run npm run e2e:auth first.');
  }
  return token;
}

function parseSse(raw) {
  const events = [];
  const toolCalls = [];
  let text = '';

  for (const block of raw.split(/\n\n+/)) {
    const lines = block.split('\n').filter((line) => line.startsWith('data:'));
    if (!lines.length) continue;
    const data = lines.map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      const event = JSON.parse(data);
      events.push(event);
      if (event.type === 'text-delta') text += event.delta || '';
      if (event.type === 'tool-input-available') {
        toolCalls.push({
          type: 'input',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        });
      }
      if (event.type === 'tool-output-available') {
        toolCalls.push({
          type: 'output',
          toolCallId: event.toolCallId,
          output: event.output,
        });
      }
    } catch (_error) {
      events.push({ type: 'unparsed', data });
    }
  }

  return { events, text, toolCalls };
}

function consistencyStatus(runs) {
  const unique = new Set(runs.map((run) => run.normalized_hash));
  if (runs.some((run) => run.status !== 'ok')) return 'fail';
  if (runs.some((run) => run.expectation_violations?.length)) return 'fail';
  return unique.size === 1 ? 'pass' : 'fail';
}

function expectedToolViolations(expected, toolNames) {
  const violations = [];
  const toolBudget = String(expected?.tool_budget || '').toLowerCase();
  const safety = String(expected?.safety || '').toLowerCase();
  const tools = new Set(toolNames);

  if (toolBudget.includes('must not call web_search') && tools.has('web_search')) {
    violations.push('web_search called despite expectation.');
  }
  if (toolBudget.includes('must not call search_kedb') && tools.has('search_kedb')) {
    violations.push('search_kedb called despite expectation.');
  }
  if ((toolBudget.includes('no tool') || safety.includes('no tool call')) && toolNames.length > 0) {
    violations.push(`tool calls not allowed, got: ${toolNames.join(', ')}`);
  }

  return violations;
}

function expectedTextViolations(expected, responseText, item) {
  const text = normalize(responseText);
  const violations = [];

  if (!text) {
    violations.push('empty response text.');
    return violations;
  }

  for (const item of expected?.must_mention || []) {
    if (!text.includes(normalize(item))) {
      violations.push(`missing expected phrase: ${item}`);
    }
  }
  for (const item of expected?.must_not_mention || []) {
    if (text.includes(normalize(item))) {
      violations.push(`forbidden phrase present: ${item}`);
    }
  }
  const mentionAnyGroups = Array.isArray(expected?.must_mention_any)
    ? expected.must_mention_any
    : String(expected?.must_mention_any || '')
      .split('\n')
      .map((line) => line.split('|').map((item) => item.trim()).filter(Boolean))
      .filter((items) => items.length > 0);

  for (const alternatives of mentionAnyGroups) {
    const options = Array.isArray(alternatives) ? alternatives : [alternatives];
    if (!options.some((item) => text.includes(normalize(item)))) {
      violations.push(`missing one of expected phrases: ${options.join(' | ')}`);
    }
  }
  if (expected?.answer_shape === 'count') {
    const hasCount = /\b\d+\b/.test(text) || text.includes('no se encontraron') || text.includes('ningun') || text.includes('ningún');
    const hedged = text.includes('no esta segment') || text.includes('no está segment') || text.includes('necesito buscar') || text.includes('necesito revisar');
    if (!hasCount || hedged) {
      violations.push('missing concrete count answer.');
    }
  }
  if (expected?.answer_shape === 'expired_warranty_count') {
    const hasExpiredWarrantyCount =
      /\b\d+\b[^.\\n]*(fuera de garantia|fuera de garantía|garantia vencida|garantía vencida|garantia expirada|garantía expirada)/.test(text)
      || /(fuera de garantia|fuera de garantía|garantia vencida|garantía vencida|garantia expirada|garantía expirada)[^.\\n]*\b\d+\b/.test(text)
      || text.includes('no se encontraron')
      || text.includes('ningun')
      || text.includes('ningún');
    const onlyReport = text.includes('reporte') && (text.includes('generado') || text.includes('generando') || text.includes('disponible'));
    if (!hasExpiredWarrantyCount || onlyReport) {
      violations.push('missing concrete expired warranty count answer.');
    }
  }
  if (expected?.answer_shape === 'percentage') {
    const hasPercent = /\b\d+([.,]\d+)?\s*%/.test(text) || /\b\d+([.,]\d+)?\s*por ciento\b/.test(text);
    if (!hasPercent) {
      violations.push('missing concrete percentage answer.');
    }
  }
  if (expected?.answer_shape === 'list') {
    const hasListItem = /\b[A-Z]{2,}-[A-Z0-9-]{2,}\b/i.test(responseText) || text.includes('no se encontraron') || text.includes('ningun') || text.includes('ningún');
    const onlyReport = text.includes('reporte') && (text.includes('generando') || text.includes('generado') || text.includes('disponible'));
    if (!hasListItem || onlyReport) {
      violations.push('missing concrete list answer.');
    }
  }
  // Regla dura de abstencion / anti-alucinacion: para activos ausentes o
  // preguntas no contestables con las tools (ground-truth 2026-07-08), la
  // respuesta DEBE declarar no-data/no-disponible y NO puede comprometer un
  // valor concreto (numero, dueno, spec). Fabricar = fallo duro (no rescatable
  // por variacion de forma).
  if (expected?.answer_shape === 'must_abstain') {
    const abstains = hasAbstentionStatement(text);
    const committed = Boolean(item) && hasRequestedConcreteValue(item, text);
    if (!abstains && committed) {
      violations.push('hallucinated a concrete value where inventory data is unavailable.');
    } else if (!abstains) {
      violations.push('expected explicit no-data/unavailable statement but none found.');
    }
  }
  // Higiene de formato: la respuesta final no debe filtrar razonamiento interno,
  // sintaxis cruda de tool-calls ni narracion de proceso. Evidencia 2026-07-08:
  // respuestas con "<tool_call> function=...>" y "Dejame buscar/Voy a intentar".
  if (text.includes('<pensamiento>') || text.includes('</pensamiento>')) {
    violations.push('visible internal reasoning tag found.');
  }
  if (/<\/?tool_call>|<\/?function|function=|<\|/.test(text)) {
    violations.push('leaked tool-call syntax in final answer.');
  }
  const narration = [
    'dejame buscar', 'déjame buscar', 'dejame intentar', 'déjame intentar',
    'dejame consultar', 'déjame consultar', 'voy a buscar', 'voy a intentar',
    'intentare con', 'intentaré con', 'necesito buscar', 'necesito consultar',
  ];
  if (narration.some((phrase) => text.includes(phrase))) {
    violations.push('process narration leaked in final answer.');
  }

  return violations;
}

function expectationViolations(item, parsed, responseText) {
  const expected = item.expected || {};
  const toolNames = parsed.toolCalls
    .filter((call) => call.type === 'input')
    .map((call) => call.toolName);

  return [
    ...expectedToolViolations(expected, toolNames),
    ...expectedTextViolations(expected, responseText, item),
  ];
}

function hasNoDataStatement(text) {
  return [
    'no encontre',
    'no encontré',
    'no aparece',
    'no existe',
    'no registrado',
    'no esta registrado',
    'no está registrado',
    'no esta en el inventario',
    'no está en el inventario',
    'no esta en la cmdb',
    'no está en la cmdb',
  ].some((phrase) => text.includes(phrase));
}

// Abstencion valida: no-data explicito O limite de capacidad declarado
// ("no disponible", "no puedo", "no tengo una herramienta"). Es mas amplio que
// hasNoDataStatement porque una abstencion correcta ante datos no disponibles
// no siempre dice "no encontre" sino "no esta disponible / no puedo desglosar".
function hasAbstentionStatement(text) {
  if (hasNoDataStatement(text)) return true;
  return [
    'no disponible',
    'no esta disponible',
    'no está disponible',
    'no puedo',
    'no tengo',
    'no cuento con',
    'no dispongo',
    'no es posible',
    'no se puede',
    'no hay informacion',
    'no hay información',
    'sin datos',
    'fuera de tu alcance',
    'fuera de tu scope',
    'no tengo acceso',
    'no tengo visibilidad',
    'no tengo una herramienta',
    'no tengo herramienta',
  ].some((phrase) => text.includes(phrase));
}

function hasRequestedConcreteValue(item, text) {
  if (item.group === 'inventory-aggregates') {
    return /\b\d+\b/.test(text) && /(laptop|laptops|portatil|portatiles|portátil|portátiles)/.test(text);
  }
  if (item.group === 'inventory-technical-attributes') {
    return /\b\d+\s*(gb|gib|mb|mib)\b/.test(text);
  }
  if (item.group === 'inventory-lifecycle') {
    return /(activo|operativo|reparacion|reparación|baja|dado de baja|retirado)/.test(text);
  }
  if (item.group === 'inventory-asset-owner' || item.group === 'inventory-distractors') {
    return /(asignad|responsable|pertenece|usuario|dueñ|duen)/.test(text) && !hasNoDataStatement(text);
  }
  return false;
}

function procedureSignature(text) {
  const concepts = [
    ['identificar', 'localizar', 'confirmar'],
    ['dependencia', 'casos abiertos', 'incidentes', 'alertas'],
    ['aprobacion', 'aprobación', 'validacion manual', 'validación manual'],
    ['document', 'auditor'],
    ['cmdb', 'inventario', 'netbox'],
    ['datos', 'respaldo', 'borrado', 'sanitizacion', 'sanitización'],
  ];
  return concepts
    .map((options, index) => (options.some((option) => text.includes(option)) ? String(index) : 'x'))
    .join('-');
}

function equivalenceSignature(item, run) {
  if (run.status !== 'ok') return `run-status:${run.status}`;
  const text = normalize(run.response_text);
  if (!text) return 'empty-response';

  if (hasNoDataStatement(text)) {
    return 'no-data';
  }

  if (item.group === 'inventory-procedures') {
    return `procedure:${procedureSignature(text)}`;
  }

  if (hasRequestedConcreteValue(item, text)) {
    return `answered:${text}`;
  }

  return `other:${text}`;
}

// Oraculo de acuerdo numerico: para respuestas con answer_shape numerico
// (count, expired_warranty_count, percentage) extrae SOLO el numero de la
// respuesta y exige que todas las variantes y repeticiones del mismo
// equivalence_key devuelvan el MISMO valor. Caza fabricacion de numeros
// (p.ej. la misma pregunta contesta 72 y 683) con una violacion concreta y
// deterministica, sin depender del juez.
const NUMERIC_SHAPES = new Set(['count', 'expired_warranty_count', 'percentage']);

function extractAnswerNumber(item, rawText) {
  const text = normalize(rawText);
  if (!text) return null;
  const shape = item.expected?.answer_shape || '';
  if (shape === 'percentage') {
    const match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:%|por ciento)/);
    return match ? match[1].replace(',', '.') : null;
  }
  // count / expired_warranty_count: numero ligado a un sustantivo contable
  // Y a un cue de totalizacion, para no confundir marcadores de lista ("1.",
  // "3."), ids (LAP-...-0042), anios ni menciones sueltas ("devolvio 5 hosts").
  const noun = '(?:laptops?|port[aá]tiles?|equipos?|activos?|dispositivos?|servidores?|hosts?)';
  const cueBefore = '(?:hay|son|existen|total(?:es)?(?:\\s+de)?|cuenta con|un total de)';
  const cueAfter = '(?:[uú]nicos|en total|registrad[oa]s?|en el inventario|en inventario)';
  // "total ... : N" (cue fuerte, el numero puede ir despues del sustantivo)
  let match = text.match(/total[^.\d]{0,30}?(\d{1,6})\b/);
  if (match) return match[1];
  // "<cue> ... N <noun>"  (p.ej. "hay 72 hosts", "un total de 683 equipos")
  match = text.match(new RegExp(cueBefore + '[^.\\d]{0,15}?(\\d{1,6})\\s*' + noun));
  if (match) return match[1];
  // "N <noun> <cue>"  (p.ej. "72 hosts unicos", "683 dispositivos registrados")
  match = text.match(new RegExp('\\b(\\d{1,6})\\s*' + noun + '[^.\\d]{0,12}?' + cueAfter));
  if (match) return match[1];
  return null;
}

function applyNumericAgreementOracle(cases) {
  const groups = new Map();
  for (const item of cases) {
    const shape = item.expected?.answer_shape || '';
    if (!NUMERIC_SHAPES.has(shape)) continue;
    const key = item.expected?.equivalence_key || `${item.group}:${shape}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const [key, items] of groups.entries()) {
    const numbers = new Set();
    let noData = 0;
    for (const item of items) {
      for (const run of item.runs || []) {
        if (run.status !== 'ok') continue;
        const raw = String(run.response_text || '').trim();
        if (!raw) continue;
        if (hasNoDataStatement(normalize(raw))) { noData += 1; continue; }
        const value = extractAnswerNumber(item, raw);
        if (value !== null) numbers.add(value);
      }
    }
    const distinct = [...numbers];
    let violation = null;
    if (distinct.length > 1) {
      violation = `numeric answers disagree for ${key}: ${distinct.join(', ')} (deben coincidir en un unico valor).`;
    } else if (distinct.length === 1 && noData > 0) {
      violation = `numeric answer unstable for ${key}: a veces ${distinct[0]}, a veces sin dato (${noData} respuestas no-data).`;
    }
    if (!violation) continue;
    for (const item of items) {
      item.expectation_violations = [...new Set([...(item.expectation_violations || []), violation])];
      item.status = 'fail';
      for (const run of item.runs || []) {
        if (run.status !== 'ok') continue;
        run.expectation_violations = [...new Set([...(run.expectation_violations || []), violation])];
      }
    }
  }
}

function applyEquivalenceChecks(cases) {
  const groups = new Map();
  for (const item of cases) {
    const key = item.expected?.equivalence_key;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const [key, items] of groups.entries()) {
    const signatures = items.flatMap((item) =>
      (item.runs || [])
        .filter((run) => run.status === 'ok')
        .filter((run) => String(run.response_text || '').trim())
        .map((run) => equivalenceSignature(item, run)),
    );
    const uniqueSignatures = new Set(signatures.filter(Boolean));
    if (uniqueSignatures.size <= 1) continue;

    const violation = `equivalent prompts for ${key} returned ${uniqueSignatures.size} distinct semantic outcomes.`;
    for (const item of items) {
      item.expectation_violations = [...new Set([...(item.expectation_violations || []), violation])];
      item.status = 'fail';
      for (const run of item.runs || []) {
        if (run.status !== 'ok') continue;
        run.expectation_violations = [...new Set([...(run.expectation_violations || []), violation])];
      }
    }
  }
}

async function main() {
  const baseURL = process.env.AITOPS_BASE_URL || 'https://missioncontrol.qa.aitops.ai/';
  const repeats = Number(process.env.CHAT_CONSISTENCY_REPEATS || '3');
  const timeout = Number(process.env.CHAT_CONSISTENCY_TIMEOUT_MS || '90000');
  const promptPath = process.env.CHAT_CONSISTENCY_PROMPTS || '';
  const prompts = promptPath
    ? JSON.parse(fs.readFileSync(path.resolve(promptPath), 'utf8'))
    : DEFAULT_PROMPTS;

  fs.mkdirSync(RESULTS, { recursive: true });
  const runId = process.env.CHAT_CONSISTENCY_RUN_ID || `chat-consistency-${timestamp()}`;
  const rawPath = path.join(RESULTS, `${runId}.raw.json`);
  const resultPath = path.join(RESULTS, `${runId}.json`);
  const startedAt = utcNow();

  const token = loadToken();
  const context = await request.newContext({
    baseURL,
    storageState: STORAGE_STATE,
    extraHTTPHeaders: {
      authorization: `Bearer ${token}`,
    },
  });

  const cases = [];
  try {
    for (const item of prompts) {
      const runs = [];
      for (let index = 1; index <= repeats; index += 1) {
        const runStarted = Date.now();
        try {
          const messages = item.messages || [{ role: 'user', content: item.prompt }];
          const response = await context.post('/api/chat/v3/stream', {
            data: {
              messages,
            },
            timeout,
          });
          const raw = await response.text();
          const parsed = parseSse(raw);
          const responseText = parsed.text;
          const expectation_violations = expectationViolations(item, parsed, responseText);
          runs.push({
            repeat: index,
            status: response.ok() ? 'ok' : 'http_error',
            http_status: response.status(),
            latency_ms: Date.now() - runStarted,
            response_text: responseText,
            response_hash: sha256(responseText),
            normalized_hash: sha256(normalize(responseText)),
            tool_calls: parsed.toolCalls,
            expectation_violations,
            raw_stream: raw,
          });
          console.log(`${item.id} run ${index}/${repeats}: ${response.status()} ${Date.now() - runStarted}ms`);
        } catch (error) {
          runs.push({
            repeat: index,
            status: 'error',
            latency_ms: Date.now() - runStarted,
            error: String(error.message || error),
          });
          console.log(`${item.id} run ${index}/${repeats}: ERROR`);
        }
      }
      cases.push({
        id: item.id,
        group: item.group,
        intent: item.intent,
        variant: item.variant,
        prompt: item.prompt,
        messages: item.messages,
        expected: item.expected,
        status: consistencyStatus(runs),
        unique_normalized_responses: new Set(runs.map((run) => run.normalized_hash).filter(Boolean)).size,
        expectation_violations: runs.flatMap((run) => run.expectation_violations || []),
        runs,
      });
    }
    applyEquivalenceChecks(cases);
    applyNumericAgreementOracle(cases);
  } finally {
    await context.dispose();
  }

  const rawReport = {
    run_id: runId,
    started_at: startedAt,
    finished_at: utcNow(),
    repeats,
    endpoint: '/api/chat/v3/stream',
    cases,
  };
  fs.writeFileSync(rawPath, `${JSON.stringify(rawReport, null, 2)}\n`, 'utf8');

  const checks = cases.map((item) => ({
    name: item.id,
    status: item.status,
    message: item.status === 'pass'
      ? 'Respuestas normalizadas identicas en todas las repeticiones.'
      : `Se capturaron ${item.unique_normalized_responses} respuestas normalizadas distintas o errores.`,
    details: {
      prompt: item.prompt,
      group: item.group,
      intent: item.intent,
      variant: item.variant,
      expected: item.expected,
      repeats,
      unique_normalized_responses: item.unique_normalized_responses,
      response_hashes: item.runs.map((run) => run.response_hash).filter(Boolean),
      normalized_hashes: item.runs.map((run) => run.normalized_hash).filter(Boolean),
      latencies_ms: item.runs.map((run) => run.latency_ms),
      tool_call_names: item.runs.map((run) => run.tool_calls?.filter((call) => call.type === 'input').map((call) => call.toolName) || []),
      expectation_violations: item.expectation_violations,
    },
  }));

  const status = checks.some((check) => check.status === 'fail') ? 'fail' : 'pass';
  const result = {
    schema_version: '1.0',
    run_id: runId,
    tool: 'chat-consistency-capture',
    category: 'compliance',
    status,
    started_at: rawReport.started_at,
    finished_at: rawReport.finished_at,
    summary: status === 'pass'
      ? 'Captura de consistencia de chat completada sin variacion normalizada.'
      : 'Captura de consistencia de chat encontro variacion o errores; revisar raw report.',
    checks,
    artifacts: [
      path.relative(ROOT, rawPath),
    ],
  };

  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(path.relative(ROOT, resultPath));
  process.exit(status === 'fail' ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
