import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROOT = process.cwd();
const BANK_PATH = path.join(ROOT, 'tests', 'chat_consistency_semantic_bank.json');

function readBank() {
  return JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));
}

function writeBank(cases) {
  const backupPath = `${BANK_PATH}.${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}.bak`;
  fs.copyFileSync(BANK_PATH, backupPath);
  const tmpPath = `${BANK_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(cases, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, BANK_PATH);
  return path.relative(ROOT, backupPath);
}

function serializeCase(item) {
  return {
    id: item.id,
    family: item.family || inferFamily(item),
    group: item.group,
    intent: item.intent,
    variant: item.variant,
    prompt: item.prompt,
    messages: item.messages || undefined,
    expected: {
      decision: item.expected?.decision || '',
      tool_budget: item.expected?.tool_budget || '',
      safety: item.expected?.safety || '',
      acceptance_criteria: item.expected?.acceptance_criteria || [],
      must_mention: item.expected?.must_mention || [],
      must_mention_any: item.expected?.must_mention_any || [],
      must_not_mention: item.expected?.must_not_mention || [],
      format: item.expected?.format || '',
      equivalence_key: item.expected?.equivalence_key || '',
      answer_shape: item.expected?.answer_shape || '',
    },
  };
}

function inferFamily(item) {
  if (['consistency', 'jailbreak', 'adversarial'].includes(item.family)) return item.family;
  const value = `${item.id || ''} ${item.family || ''} ${item.group || ''} ${item.intent || ''}`.toLowerCase();
  if (value.includes('jailbreak') || /^jb-/i.test(String(item.id || ''))) return 'jailbreak';
  if (value.includes('adversarial') || value.includes('red-team')) return 'adversarial';
  return 'consistency';
}

function listValues(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function listOfLists(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (Array.isArray(item) ? item : String(item || '').split('|')))
      .map((items) => items.map((entry) => String(entry).trim()).filter(Boolean))
      .filter((items) => items.length > 0);
  }
  return String(value || '')
    .split('\n')
    .map((line) => line.split('|').map((item) => item.trim()).filter(Boolean))
    .filter((items) => items.length > 0);
}

function expectedFromBody(expected = {}, current = {}) {
  return {
    ...current,
    decision: String(expected.decision ?? current.decision ?? '').trim(),
    tool_budget: String(expected.tool_budget ?? current.tool_budget ?? '').trim(),
    safety: String(expected.safety ?? current.safety ?? '').trim(),
    format: String(expected.format ?? current.format ?? '').trim(),
    equivalence_key: String(expected.equivalence_key ?? current.equivalence_key ?? '').trim(),
    answer_shape: String(expected.answer_shape ?? current.answer_shape ?? '').trim(),
    acceptance_criteria: listValues(expected.acceptance_criteria ?? current.acceptance_criteria),
    must_mention: listValues(expected.must_mention ?? current.must_mention),
    must_mention_any: listOfLists(expected.must_mention_any ?? current.must_mention_any),
    must_not_mention: listValues(expected.must_not_mention ?? current.must_not_mention),
  };
}

export async function GET() {
  if (!fs.existsSync(BANK_PATH)) {
    return NextResponse.json({ error: 'No existe tests/chat_consistency_semantic_bank.json.' }, { status: 404 });
  }
  const cases = readBank();
  return NextResponse.json({
    path: path.relative(ROOT, BANK_PATH),
    cases: cases.map(serializeCase),
  });
}

export async function PATCH(request) {
  if (!fs.existsSync(BANK_PATH)) {
    return NextResponse.json({ error: 'No existe tests/chat_consistency_semantic_bank.json.' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '').trim();
  if (!id) {
    return NextResponse.json({ error: 'Falta id de caso.' }, { status: 400 });
  }

  const cases = readBank();
  const index = cases.findIndex((item) => item.id === id);
  if (index < 0) {
    return NextResponse.json({ error: `No existe el caso ${id}.` }, { status: 404 });
  }

  cases[index] = {
    ...cases[index],
    family: String(body.family ?? cases[index].family ?? inferFamily(cases[index])).trim(),
    group: String(body.group ?? cases[index].group ?? '').trim(),
    intent: String(body.intent ?? cases[index].intent ?? '').trim(),
    variant: String(body.variant ?? cases[index].variant ?? '').trim(),
    prompt: String(body.prompt ?? cases[index].prompt ?? '').trim(),
    expected: expectedFromBody(body.expected || {}, cases[index].expected || {}),
  };
  const backup = writeBank(cases);

  return NextResponse.json({
    saved: true,
    backup,
    case: serializeCase(cases[index]),
  });
}

export async function POST(request) {
  if (!fs.existsSync(BANK_PATH)) {
    return NextResponse.json({ error: 'No existe tests/chat_consistency_semantic_bank.json.' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '').trim();
  const prompt = String(body.prompt || '').trim();
  const group = String(body.group || '').trim();
  const intent = String(body.intent || '').trim();
  const variant = String(body.variant || '').trim();
  const family = String(body.family || 'consistency').trim();

  if (!id) return NextResponse.json({ error: 'Falta id de caso.' }, { status: 400 });
  if (!prompt) return NextResponse.json({ error: 'Falta prompt.' }, { status: 400 });

  const cases = readBank();
  if (cases.some((item) => item.id === id)) {
    return NextResponse.json({ error: `Ya existe el caso ${id}.` }, { status: 409 });
  }

  const expected = body.expected || {};
  const nextCase = {
    id,
    family,
    group,
    intent,
    variant,
    prompt,
    expected: expectedFromBody(expected),
  };

  cases.push(nextCase);
  const backup = writeBank(cases);

  return NextResponse.json({
    created: true,
    backup,
    case: serializeCase(nextCase),
  }, { status: 201 });
}

export async function DELETE(request) {
  if (!fs.existsSync(BANK_PATH)) {
    return NextResponse.json({ error: 'No existe tests/chat_consistency_semantic_bank.json.' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '').trim();
  if (!id) {
    return NextResponse.json({ error: 'Falta id de caso.' }, { status: 400 });
  }

  const cases = readBank();
  const index = cases.findIndex((item) => item.id === id);
  if (index < 0) {
    return NextResponse.json({ error: `No existe el caso ${id}.` }, { status: 404 });
  }

  const [removed] = cases.splice(index, 1);
  const backup = writeBank(cases);

  return NextResponse.json({
    deleted: true,
    backup,
    case: serializeCase(removed),
  });
}
