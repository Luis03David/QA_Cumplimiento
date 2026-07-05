import fs from 'node:fs';
import path from 'node:path';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ClipboardCheck,
  FileJson,
  Filter,
  Gauge,
  History,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';

const ROOT = process.cwd();
const RESULTS_DIR = path.join(ROOT, 'resultados');
const TRACEABILITY_FILE = path.join(ROOT, 'docs', 'traceability.md');

export default async function Dashboard({ searchParams }) {
  const params = await searchParams;
  const selectedStatus = params?.status || 'all';
  const selectedCategory = params?.category || 'all';
  const results = loadResults();
  const cases = loadTraceability();
  const filtered = results.filter((result) => {
    const statusMatch = selectedStatus === 'all' || result.status === selectedStatus;
    const categoryMatch = selectedCategory === 'all' || result.category === selectedCategory;
    return statusMatch && categoryMatch;
  });

  const latest = latestByCategory(results);
  const totals = summarize(results, cases);
  const recentChecks = results.flatMap((result) =>
    (result.checks || []).map((check) => ({
      ...check,
      run_id: result.run_id,
      category: result.category,
      finished_at: result.finished_at,
      artifact: result.artifacts?.[0],
    })),
  ).sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)));

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <ShieldCheck size={26} aria-hidden="true" />
          <div>
            <strong>QA Cumplimiento</strong>
            <span>Mission Control Evidence</span>
          </div>
        </div>
        <nav aria-label="Secciones">
          <a href="#estado"><Gauge size={18} aria-hidden="true" /> Estado</a>
          <a href="#evidencia"><History size={18} aria-hidden="true" /> Evidencia</a>
          <a href="#trazabilidad"><ClipboardCheck size={18} aria-hidden="true" /> Trazabilidad</a>
          <a href="#faltantes"><AlertTriangle size={18} aria-hidden="true" /> Faltantes</a>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Evidencia objetiva</p>
            <h1>Dashboard de calidad y cumplimiento</h1>
          </div>
          <div className="run-chip">
            <FileJson size={18} aria-hidden="true" />
            {results.length} ejecuciones
          </div>
        </header>

        <section id="estado" className="metric-grid" aria-label="Estado general">
          <Metric label="Checks pass" value={totals.passChecks} tone="pass" icon={<CheckCircle2 />} />
          <Metric label="Checks fail" value={totals.failChecks} tone="fail" icon={<AlertTriangle />} />
          <Metric label="Faltantes" value={totals.skippedChecks} tone="skipped" icon={<CircleDashed />} />
          <Metric label="Casos CP" value={`${totals.readyCases}/${cases.length}`} tone="neutral" icon={<ClipboardCheck />} />
        </section>

        <section className="section-band">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Filtros</p>
              <h2>Resultados</h2>
            </div>
            <Filter size={20} aria-hidden="true" />
          </div>
          <div className="filters">
            <FilterLinks name="status" selected={selectedStatus} values={['all', 'pass', 'fail', 'skipped']} />
            <FilterLinks name="category" selected={selectedCategory} values={['all', ...unique(results.map((item) => item.category))]} />
          </div>
        </section>

        <section id="evidencia" className="content-grid">
          <div className="panel wide">
            <div className="panel-heading">
              <h2>Historial de ejecuciones</h2>
              <span>{filtered.length}</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Categoría</th>
                    <th>Estado</th>
                    <th>Finalizó</th>
                    <th>Resumen</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((result) => (
                    <tr key={result.run_id}>
                      <td className="mono">{result.run_id}</td>
                      <td>{result.category}</td>
                      <td><StatusBadge status={result.status} /></td>
                      <td>{formatDate(result.finished_at)}</td>
                      <td>{result.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel-heading">
              <h2>Última corrida</h2>
              <span>{Object.keys(latest).length}</span>
            </div>
            <div className="latest-list">
              {Object.entries(latest).map(([category, result]) => (
                <div className="latest-row" key={category}>
                  <div>
                    <strong>{category}</strong>
                    <span>{formatDate(result.finished_at)}</span>
                  </div>
                  <StatusBadge status={result.status} />
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="trazabilidad" className="content-grid">
          <div className="panel wide">
            <div className="panel-heading">
              <h2>Matriz de trazabilidad</h2>
              <span>{cases.length}</span>
            </div>
            <div className="case-grid">
              {cases.map((item) => (
                <article className="case-card" key={item.caseId}>
                  <div className="case-top">
                    <strong>{item.caseId}</strong>
                    <StatusBadge status={statusFromTrace(item.status)} />
                  </div>
                  <p>{item.objective}</p>
                  <span>{item.framework}</span>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="faltantes" className="content-grid">
          <div className="panel wide">
            <div className="panel-heading">
              <h2>Checks y faltantes recientes</h2>
              <span>{recentChecks.length}</span>
            </div>
            <div className="check-list">
              {recentChecks.slice(0, 14).map((check, index) => (
                <article className="check-row" key={`${check.run_id}-${check.name}-${index}`}>
                  <div className="check-status"><StatusIcon status={check.status} /></div>
                  <div>
                    <strong>{check.name}</strong>
                    <p>{check.message}</p>
                    <span>{check.category} · {check.run_id}</span>
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-heading">
              <h2>Acceso</h2>
              <LockKeyhole size={18} aria-hidden="true" />
            </div>
            <div className="access-box">
              <strong>Ambiente QA</strong>
              <span>Cloudflare Access activo</span>
              <span>Sesión local: .auth/aitops.json</span>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

function Metric({ label, value, tone, icon }) {
  return (
    <article className={`metric ${tone}`}>
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function FilterLinks({ name, selected, values }) {
  return (
    <div className="filter-group" aria-label={name}>
      {values.map((value) => (
        <a className={selected === value ? 'active' : ''} href={`?${name}=${value}`} key={value}>
          {value}
        </a>
      ))}
    </div>
  );
}

function StatusBadge({ status }) {
  return <span className={`status ${status}`}>{status}</span>;
}

function StatusIcon({ status }) {
  if (status === 'pass') return <CheckCircle2 size={18} aria-label="pass" />;
  if (status === 'fail') return <AlertTriangle size={18} aria-label="fail" />;
  return <CircleDashed size={18} aria-label="skipped" />;
}

function loadResults() {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs.readdirSync(RESULTS_DIR)
    .filter((file) => file.endsWith('.json') && !file.includes('.raw') && !file.includes('fallback-findings'))
    .map((file) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)));
}

function loadTraceability() {
  if (!fs.existsSync(TRACEABILITY_FILE)) return [];
  const lines = fs.readFileSync(TRACEABILITY_FILE, 'utf8').split('\n');
  return lines
    .filter((line) => line.startsWith('| CP-'))
    .map((line) => line.split('|').map((part) => part.trim()).filter(Boolean))
    .map(([caseId, objective, framework, status]) => ({ caseId, objective, framework, status }));
}

function summarize(results, cases) {
  const checks = results.flatMap((result) => result.checks || []);
  return {
    passChecks: checks.filter((check) => check.status === 'pass').length,
    failChecks: checks.filter((check) => check.status === 'fail').length,
    skippedChecks: checks.filter((check) => check.status === 'skipped').length,
    readyCases: cases.filter((item) => /automatizado|pass|completo/i.test(item.status)).length,
  };
}

function latestByCategory(results) {
  return results.reduce((acc, result) => {
    if (!acc[result.category]) acc[result.category] = result;
    return acc;
  }, {});
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function statusFromTrace(value) {
  if (/faltante|pendiente|skipped/i.test(value)) return 'skipped';
  if (/fail|fall/i.test(value)) return 'fail';
  return 'pass';
}

function formatDate(value) {
  if (!value) return 'sin fecha';
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Mexico_City',
  }).format(new Date(value));
}
