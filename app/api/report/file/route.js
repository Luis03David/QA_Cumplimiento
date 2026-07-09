import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { ROOT } from '../../_jobRunner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REPORTS_DIR = path.join(ROOT, 'reportes');

// Sirve un informe generado como text/html. Restringido a reportes/ y a
// archivos .html por nombre base (sin rutas relativas) para evitar traversal.
export async function GET(request) {
  const name = new URL(request.url).searchParams.get('name') || '';
  const base = path.basename(name);
  if (base !== name || !base.endsWith('.html')) {
    return NextResponse.json({ error: 'Nombre de informe invalido.' }, { status: 400 });
  }
  const abs = path.join(REPORTS_DIR, base);
  if (!abs.startsWith(REPORTS_DIR + path.sep) || !fs.existsSync(abs)) {
    return NextResponse.json({ error: 'Informe no encontrado.' }, { status: 404 });
  }
  const html = fs.readFileSync(abs, 'utf8');
  return new NextResponse(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
