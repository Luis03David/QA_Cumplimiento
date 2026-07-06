import fs from 'node:fs';
import path from 'node:path';
import ChatConsistencyLauncher from './ChatConsistencyLauncher';
import CloudflareAccessPanel from './CloudflareAccessPanel';
import ToolPolicyEditor from './ToolPolicyEditor';
import {
  AlertTriangle,
  BrainCircuit,
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
const PROMPT_BANK_FILE = path.join(ROOT, 'tests', 'chat_consistency_semantic_bank.json');
const JAILBREAK_REPORT_FILE = path.join(ROOT, 'informe-pruebas-jailbreak-aitops-DG-2026-06-23.html');
const ADVERSARIAL_BANK_FILE = path.join(ROOT, 'banco-pruebas-adversarial-aitops-DG-2026-06-26.html');

const NAV_ITEMS = [
  { id: 'inicio', label: 'Resumen', group: 'General', icon: ShieldCheck, description: 'Estado ejecutivo de calidad, riesgo y cumplimiento.' },
  { id: 'chat', label: 'Chat', group: 'Superficie', icon: BrainCircuit, description: 'Consistencia, jailbreak y adversarial del asistente conversacional.' },
  { id: 'plataforma', label: 'Plataforma', group: 'Superficie', icon: Gauge, description: 'Pruebas E2E, flujos funcionales, permisos e integraciones.' },
  { id: 'carga', label: 'Carga', group: 'Superficie', icon: CircleDashed, description: 'Latencia, concurrencia, timeouts y degradacion.' },
  { id: 'seguridad', label: 'Seguridad', group: 'Superficie', icon: LockKeyhole, description: 'Secret scan, dependencias, accesos y adversarial no-chat.' },
  { id: 'catalogos', label: 'Catalogos', group: 'Trabajo', icon: FileJson, description: 'Banco editable de casos, prompts y criterios de aceptacion.' },
  { id: 'corridas', label: 'Corridas', group: 'Trabajo', icon: History, description: 'Historial completo de ejecuciones, filtros y artefactos.' },
  { id: 'hallazgos', label: 'Hallazgos', group: 'Trabajo', icon: AlertTriangle, description: 'Fallas, faltantes, severidad, evidencia y estado de revision.' },
  { id: 'compliance', label: 'Compliance', group: 'Gobierno', icon: ClipboardCheck, description: 'Trazabilidad CP, controles, marcos regulatorios y evidencia.' },
  { id: 'configuracion', label: 'Configuracion', group: 'Operacion', icon: Filter, description: 'Acceso, editor avanzado y parametros locales de prueba.' },
  { id: 'referencia', label: 'Referencia', group: 'Operacion', icon: FileJson, description: 'Glosario de codigos, acronimos y familias de prueba.' },
];

export default async function Dashboard({ searchParams }) {
  const params = await searchParams;
  const selectedTab = normalizeTab(params?.tab);
  const activeSection = NAV_ITEMS.find((item) => item.id === selectedTab) || NAV_ITEMS[0];
  const selectedStatus = params?.status || 'all';
  const selectedCategory = params?.category || 'all';
  const selectedCatalogType = params?.catalogType || 'all';
  const catalogQueryRaw = String(params?.catalogQ || '');
  const catalogQuery = catalogQueryRaw.trim().toLowerCase();

  const results = loadResults();
  const cases = loadTraceability();
  const promptCatalog = loadPromptCatalog();
  const promptFamilyCounts = summarizePromptFamilies(promptCatalog);
  const externalCatalog = loadExternalPromptCatalog();
  const unifiedCatalog = [...promptCatalog, ...externalCatalog];
  const filteredCatalog = unifiedCatalog.filter((item) => {
    const typeMatch = selectedCatalogType === 'all' || item.type === selectedCatalogType;
    const searchable = `${item.id} ${item.group} ${item.intent || ''} ${item.prompt} ${item.acceptance}`.toLowerCase();
    const queryMatch = !catalogQuery || searchable.includes(catalogQuery);
    return typeMatch && queryMatch;
  });

  const chatConsistency = loadLatestChatConsistency();
  const executedCaseIds = new Set(chatConsistency?.raw?.cases?.map((item) => item.id) || []);
  const executedCases = promptCatalog.filter((item) => executedCaseIds.has(item.id)).length;
  const bankProgress = promptCatalog.length ? Math.round((executedCases / promptCatalog.length) * 100) : 0;
  const chatCases = chatConsistency?.raw?.cases || [];
  const bankPass = chatCases.filter((item) => item.status === 'pass').length;
  const bankFail = chatCases.filter((item) => item.status === 'fail').length;

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

  const e2eResults = results.filter((result) => matchesResult(result, ['e2e', 'playwright']));
  const securityResults = results.filter((result) => matchesResult(result, ['secret', 'dependency', 'security', 'audit']));
  const loadResultsList = results.filter((result) => matchesResult(result, ['load', 'performance', 'perf', 'k6']));
  const chatResults = results.filter((result) => matchesResult(result, ['chat', 'consistency', 'jailbreak', 'adversarial']));
  const evidenceTab = selectedTab === 'corridas' ? 'corridas' : 'evidencia';
  const statusFilterBase = { tab: evidenceTab, category: selectedCategory };
  const categoryFilterBase = { tab: evidenceTab, status: selectedStatus };

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <ShieldCheck size={26} aria-hidden="true" />
          <div>
            <strong>QA Cumplimiento</strong>
            <span>Evidencia y pruebas</span>
          </div>
        </div>
        <nav aria-label="Secciones">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <a
                className={selectedTab === item.id ? 'active' : ''}
                href={tabHref(item.id)}
                aria-current={selectedTab === item.id ? 'page' : undefined}
                key={item.id}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
                <small>{item.group}</small>
              </a>
            );
          })}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{activeSection.group}</p>
            <h1>{activeSection.label}</h1>
            <p className="topbar-subtitle">{activeSection.description}</p>
          </div>
          <div className="run-chip">
            <FileJson size={18} aria-hidden="true" />
            {results.length} ejecuciones
          </div>
        </header>

        {selectedTab === 'inicio' && <>
          <section className="home-hero panel">
            <p className="eyebrow">QA Cumplimiento</p>
            <h2>Centro de control por superficies de prueba, riesgo y cumplimiento</h2>
            <p>
              Esta plataforma separa pruebas de chat, plataforma, carga y seguridad, sin perder la trazabilidad
              contra controles de compliance. Cada corrida debe explicar que se probo, que respondio el sistema,
              que se esperaba y que evidencia queda.
            </p>
            <div className="home-pills">
              <span>{results.length} ejecuciones históricas</span>
              <span>{promptCatalog.length} casos de consistencia</span>
              <span>{externalCatalog.length} casos adversariales/jailbreak</span>
            </div>
          </section>

          <section className="home-grid">
            <article className="panel">
              <h3>Propósito</h3>
              <p>
                Medir calidad, seguridad y cumplimiento por superficie: chat, plataforma, carga, seguridad y datos.
                Los resultados deben ser auditables y comparables entre corridas.
              </p>
            </article>

            <article className="panel">
              <h3>Superficies clave</h3>
              <ul className="home-list">
                <li>Chat: consistencia, jailbreak y adversarial conversacional.</li>
                <li>Plataforma: E2E, permisos, sesiones e integraciones.</li>
                <li>Seguridad: secretos, dependencias, accesos y datos expuestos.</li>
                <li>Carga: latencia, concurrencia, timeouts y degradacion.</li>
                <li>Compliance: CP, marcos regulatorios y evidencia objetiva.</li>
              </ul>
            </article>

            <article className="panel">
              <h3>Flujo recomendado</h3>
              <ol className="home-list ordered">
                <li>Define superficie y familia de prueba.</li>
                <li>Ajusta casos y criterios en Catalogos.</li>
                <li>Ejecuta solo los casos necesarios.</li>
                <li>Revisa respuestas, evidencia y hallazgos.</li>
                <li>Mapea impacto en Compliance.</li>
              </ol>
            </article>
          </section>

          <section className="quick-actions" aria-label="Acciones principales">
            <a href={tabHref('chat')}>
              <BrainCircuit size={18} aria-hidden="true" />
              <span>
                <strong>Probar chat</strong>
                <small>Consistencia, jailbreak y adversarial.</small>
              </span>
            </a>
            <a href={tabHref('corridas')}>
              <History size={18} aria-hidden="true" />
              <span>
                <strong>Revisar corridas</strong>
                <small>Filtra runs, familias y artefactos.</small>
              </span>
            </a>
            <a href={tabHref('catalogos')}>
              <Filter size={18} aria-hidden="true" />
              <span>
                <strong>Ajustar catalogos</strong>
                <small>Edita prompts y criterios.</small>
              </span>
            </a>
          </section>
        </>}

        {selectedTab === 'chat' && <>
          <section className="section-band">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Superficie: chat</p>
                <h2>Consistencia, jailbreak y adversarial conversacional</h2>
              </div>
              <BrainCircuit size={20} aria-hidden="true" />
            </div>
            <div className="surface-grid">
              <SurfaceCard title="Consistencia" value={promptFamilyCounts.consistency} detail="casos editables en banco semantico" tone="neutral" />
              <SurfaceCard title="Jailbreak" value={promptFamilyCounts.jailbreak} detail="casos editables en banco semantico" tone="fail" />
              <SurfaceCard title="Adversarial chat" value={promptFamilyCounts.adversarial} detail="casos editables en banco semantico" tone="skipped" />
              <SurfaceCard title="Corridas chat" value={chatResults.length} detail="resultados historicos detectados" tone="pass" />
            </div>
          </section>
          <ChatConsistencySection data={chatConsistency} />
          <section className="content-grid">
            <div className="panel wide">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Banco de chat</p>
                  <h2>Prompts y criterios</h2>
                </div>
                <FileJson size={18} aria-hidden="true" />
              </div>
              <p className="editor-note">Edita el prompt, los criterios de aceptacion y la equivalencia semantica antes de lanzar la siguiente corrida.</p>
              <ToolPolicyEditor />
            </div>
            <div className="panel">
              <div className="panel-heading">
                <h2>Como usarlo</h2>
                <span>chat</span>
              </div>
              <div className="access-box">
                <strong>Flujo recomendado</strong>
                <span>1. Ajusta prompts y criterios aqui.</span>
                <span>2. En el lanzador elige casos concretos.</span>
                <span>3. Si necesitas probar algo nuevo, crealo primero como caso del catalogo.</span>
                <span>4. Clasificalo como consistencia, jailbreak o adversarial antes de correrlo.</span>
              </div>
            </div>
          </section>
        </>}

        {selectedTab === 'plataforma' && <section className="content-grid">
          <div className="panel wide">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Superficie: plataforma</p>
                <h2>Pruebas E2E y flujos funcionales</h2>
              </div>
              <Gauge size={18} aria-hidden="true" />
            </div>
            <p className="editor-note">Aqui viven pruebas de login, rutas administrativas, permisos, flujos de usuario e integraciones funcionales.</p>
            <RunSummaryList results={e2eResults} emptyTitle="No hay corridas E2E disponibles" emptyDetail="Ejecuta npm run e2e:report o agrega suites de plataforma para poblar esta vista." />
          </div>
          <div className="panel">
            <div className="panel-heading">
              <h2>Cobertura objetivo</h2>
              <span>platform</span>
            </div>
            <div className="glossary-list">
              {[
                ['Autenticacion', 'Login, sesion, Cloudflare Access y expiracion.'],
                ['Permisos', 'Rutas restringidas, roles y acciones autorizadas.'],
                ['Flujos criticos', 'DSAR, datos personales, tokens, KB y configuracion.'],
                ['Integraciones', 'Servicios externos, APIs y tool calls no-chat.'],
              ].map(([term, meaning]) => (
                <article className="glossary-row" key={term}><strong>{term}</strong><span>{meaning}</span></article>
              ))}
            </div>
          </div>
        </section>}

        {selectedTab === 'carga' && <section className="content-grid">
          <div className="panel wide">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Superficie: carga</p>
                <h2>Rendimiento, concurrencia y degradacion</h2>
              </div>
              <CircleDashed size={18} aria-hidden="true" />
            </div>
            <p className="editor-note">Esta seccion queda preparada para resultados de k6, Artillery, Playwright load o pruebas por endpoint/flujo.</p>
            <RunSummaryList results={loadResultsList} emptyTitle="No hay corridas de carga todavia" emptyDetail="Define suites de latencia, concurrencia, timeouts y degradacion para generar evidencia comparable." />
          </div>
          <div className="panel">
            <div className="panel-heading">
              <h2>Metricas esperadas</h2>
              <span>load</span>
            </div>
            <div className="glossary-list">
              {[
                ['Latencia', 'p50, p95, p99 por endpoint o flujo.'],
                ['Concurrencia', 'Usuarios simultaneos, saturacion y errores.'],
                ['Timeouts', 'Rutas lentas, retries y limites.'],
                ['Degradacion', 'Comportamiento bajo carga sostenida.'],
              ].map(([term, meaning]) => (
                <article className="glossary-row" key={term}><strong>{term}</strong><span>{meaning}</span></article>
              ))}
            </div>
          </div>
        </section>}

        {selectedTab === 'seguridad' && <section className="content-grid">
          <div className="panel wide">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Superficie: seguridad</p>
                <h2>Secretos, dependencias, accesos y adversarial no-chat</h2>
              </div>
              <LockKeyhole size={18} aria-hidden="true" />
            </div>
            <p className="editor-note">Consolida escaneos tecnicos y pruebas de abuso que no dependen exclusivamente del chat.</p>
            <RunSummaryList results={securityResults} emptyTitle="No hay corridas de seguridad disponibles" emptyDetail="Ejecuta secret scan, dependency audit o suites adversariales API/UI para poblar esta vista." />
          </div>
          <div className="panel">
            <div className="panel-heading">
              <h2>Familias</h2>
              <span>security</span>
            </div>
            <div className="glossary-list">
              {[
                ['Secret scan', 'Credenciales, tokens y valores sensibles expuestos.'],
                ['Dependency audit', 'Vulnerabilidades en dependencias y runtimes.'],
                ['Access control', 'Roles, tenants, rutas restringidas y acciones.'],
                ['Adversarial no-chat', 'IDOR, confused deputy, parametros y approval abuse.'],
              ].map(([term, meaning]) => (
                <article className="glossary-row" key={term}><strong>{term}</strong><span>{meaning}</span></article>
              ))}
            </div>
          </div>
        </section>}

        {(selectedTab === 'glosario' || selectedTab === 'referencia') && <section className="content-grid">
          <div className="panel wide">
            <div className="panel-heading">
              <h2>Glosario de códigos y acrónimos</h2>
              <span>referencia rápida</span>
            </div>
            <p className="editor-note">Aquí puedes ver qué significa cada código y qué evalúa cada grupo de pruebas.</p>

            <div className="table-wrap compact">
              <table>
                <thead>
                  <tr>
                    <th>Código / acrónimo</th>
                    <th>Significado</th>
                    <th>Qué busca validar</th>
                  </tr>
                </thead>
                <tbody>
                  {glossaryRows().map((row) => (
                    <tr key={row.code} id={row.anchor}>
                      <td className="mono">{row.code}</td>
                      <td>{row.meaning}</td>
                      <td>{row.goal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel-heading">
              <h2>Objetivo por grupo</h2>
              <span>{groupGoals().length}</span>
            </div>
            <div className="glossary-list">
              {groupGoals().map((item) => (
                <article className="glossary-row" key={item.group}>
                  <strong>{item.group}</strong>
                  <span>{item.goal}</span>
                </article>
              ))}
            </div>
          </div>
        </section>}

        {selectedTab === 'estado' && <section className="metric-grid" aria-label="Estado general">
          <Metric label="Checks pass" value={totals.passChecks} tone="pass" icon={<CheckCircle2 />} />
          <Metric label="Checks fail" value={totals.failChecks} tone="fail" icon={<AlertTriangle />} />
          <Metric label="Faltantes" value={totals.skippedChecks} tone="skipped" icon={<CircleDashed />} />
          <Metric label="Casos CP" value={`${totals.readyCases}/${cases.length}`} tone="neutral" icon={<ClipboardCheck />} />
        </section>}

        {selectedTab === 'banco-pruebas' && <section className="section-band">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Cobertura</p>
              <h2>Banco de pruebas</h2>
            </div>
            <span>{executedCases}/{promptCatalog.length} casos ejecutados</span>
          </div>
          <div className="bank-progress-wrap" role="img" aria-label={`Avance del banco de pruebas ${bankProgress} por ciento`}>
            <div className="bank-progress-track">
              <div className="bank-progress-fill" style={{ width: `${bankProgress}%` }} />
            </div>
            <strong>{bankProgress}%</strong>
          </div>
          <div className="bank-stats">
            <span>Pass: {bankPass}</span>
            <span>Fail: {bankFail}</span>
            <span>Sin correr: {Math.max(promptCatalog.length - executedCases, 0)}</span>
            <span>Jailbreak catalogados: {externalCatalog.length}</span>
            <span>Repeticiones objetivo: {chatConsistency?.raw?.repeats || '-'}</span>
          </div>
        </section>}

        {(selectedTab === 'evidencia' || selectedTab === 'corridas') && <>
          <section className="section-band">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Filtros</p>
                <h2>Resultados</h2>
              </div>
              <Filter size={20} aria-hidden="true" />
            </div>
            <div className="filters">
              <FilterLinks name="status" selected={selectedStatus} values={['all', 'pass', 'fail', 'skipped']} baseParams={statusFilterBase} />
              <FilterLinks name="category" selected={selectedCategory} values={['all', ...unique(results.map((item) => item.category))]} baseParams={categoryFilterBase} />
            </div>
          </section>

          <section className="content-grid">
            <div className="panel wide">
              <div className="panel-heading">
                <h2>Historial de ejecuciones</h2>
                <span>{filtered.length}</span>
              </div>
              <div className="table-wrap">
                {filtered.length === 0 ? (
                  <EmptyState
                    title="No hay ejecuciones para esos filtros"
                    detail="Cambia status o categoria para volver a ver resultados."
                    actionHref={hrefWith({ tab: 'evidencia' }, { status: 'all', category: 'all' })}
                    actionLabel="Limpiar filtros"
                  />
                ) : (
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
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-heading">
                <h2>Última corrida</h2>
                <span>{Object.keys(latest).length}</span>
              </div>
              <div className="latest-list">
                {Object.entries(latest).length === 0 ? (
                  <EmptyState title="Sin corridas" detail="Aun no hay resultados JSON en resultados/." />
                ) : (
                  Object.entries(latest).map(([category, result]) => (
                    <div className="latest-row" key={category}>
                      <div>
                        <strong>{category}</strong>
                        <span>{formatDate(result.finished_at)}</span>
                      </div>
                      <StatusBadge status={result.status} />
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </>}

        {selectedTab === 'consistencia' && <ChatConsistencySection data={chatConsistency} />}

        {(selectedTab === 'editor-tools' || selectedTab === 'configuracion') && <section className="content-grid">
          <div className="panel wide">
            <div className="panel-heading">
              <h2>Editor de tools</h2>
              <span>política y aceptación</span>
            </div>
            <p className="editor-note">Edita tool budget, seguridad y criterios de aceptación por caso antes de correr el banco.</p>
            <ToolPolicyEditor />
          </div>

          <div className="panel">
            <div className="panel-heading">
              <h2>Acceso Cloudflare</h2>
              <LockKeyhole size={18} aria-hidden="true" />
            </div>
            <CloudflareAccessPanel />
          </div>
        </section>}

        {(selectedTab === 'catalogo-pruebas' || selectedTab === 'catalogos') && <section className="content-grid">
          <div className="panel wide">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Banco editable</p>
                <h2>Crear, editar y borrar casos</h2>
              </div>
              <FileJson size={18} aria-hidden="true" />
            </div>
            <p className="editor-note">Aqui se crean y modifican los prompts, criterios y familia de prueba que despues usa el lanzador de Chat.</p>
            <ToolPolicyEditor />
          </div>

          <div className="panel wide">
            <div className="panel-heading">
              <h2>Catálogo de referencia</h2>
              <span>{unifiedCatalog.length} casos</span>
            </div>
            <form method="get" className="catalog-filters">
              <input type="hidden" name="tab" value={selectedTab === 'catalogos' ? 'catalogos' : 'catalogo-pruebas'} />
              <label>
                <span>Tipo</span>
                <select name="catalogType" defaultValue={selectedCatalogType}>
                  <option value="all">all</option>
                  <option value="consistencia">consistencia</option>
                  <option value="jailbreak">jailbreak</option>
                  <option value="adversarial">adversarial</option>
                </select>
              </label>
              <label>
                <span>Buscar ID o texto</span>
                <input name="catalogQ" defaultValue={catalogQueryRaw} placeholder="ej: JB-020, prompt injection" />
              </label>
              <button type="submit">Filtrar</button>
              <a className="secondary-action" href={hrefWith({ tab: selectedTab === 'catalogos' ? 'catalogos' : 'catalogo-pruebas' }, { catalogType: 'all', catalogQ: '' })}>Limpiar</a>
            </form>
            {filteredCatalog.length === 0 ? (
              <p className="empty-note">No hay casos para esos filtros.</p>
            ) : (
              <div className="table-wrap compact">
                <table>
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th>ID</th>
                      <th>Grupo</th>
                      <th>Prompt enviado</th>
                      <th>Criterios de aceptación</th>
                      <th>Fuente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCatalog.map((item) => (
                      <tr key={`${item.type}-${item.id}-${item.source}`}>
                        <td>{item.type}</td>
                        <td className="mono"><a className="inline-link" href={glossaryLinkForCode(item.id)}>{item.id}</a></td>
                        <td>{item.group || item.intent || '-'}</td>
                        <td>{item.prompt || '-'}</td>
                        <td>{item.acceptance || '-'}</td>
                        <td>{item.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>}

        {selectedTab === 'acceso' && <section className="content-grid">
          <div className="panel wide">
            <div className="panel-heading">
              <h2>Acceso Cloudflare</h2>
              <span>login asistido</span>
            </div>
            <CloudflareAccessPanel />
          </div>
        </section>}

        {(selectedTab === 'trazabilidad' || selectedTab === 'compliance') && <section className="content-grid">
          <div className="panel wide">
            <div className="panel-heading">
              <h2>Matriz de trazabilidad</h2>
              <span>{cases.length}</span>
            </div>
            <p className="editor-note">CP significa Caso de Prueba de cumplimiento. Cada tarjeta mapea un objetivo técnico, el marco regulatorio/estándar y su estado actual.</p>
            <div className="case-grid">
              {cases.map((item) => (
                <article className="case-card" key={item.caseId}>
                  <div className="case-top">
                    <strong><a className="inline-link" href={glossaryLinkForCode(item.caseId)}>{item.caseId}</a></strong>
                    <StatusBadge status={statusFromTrace(item.status)} />
                  </div>
                  <p>{item.objective}</p>
                  <span>{item.framework}</span>
                </article>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-heading">
              <h2>Qué significa</h2>
              <span>trazabilidad</span>
            </div>
            <div className="glossary-list">
              {traceabilityGlossaryRows().map((item) => (
                <article className="glossary-row" key={item.term}>
                  <strong>{item.term}</strong>
                  <span>{item.meaning}</span>
                </article>
              ))}
            </div>
          </div>
        </section>}

        {(selectedTab === 'faltantes' || selectedTab === 'hallazgos') && <section className="content-grid">
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
                    <strong>{isCodeToken(check.name) ? <a className="inline-link" href={glossaryLinkForCode(check.name)}>{check.name}</a> : check.name}</strong>
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
        </section>}
      </section>
    </main>
  );
}

function ChatConsistencySection({ data }) {
  if (!data) {
    return (
      <section className="content-grid">
        <div className="panel wide">
          <div className="panel-heading">
            <h2>Consistencia Chat</h2>
            <StatusBadge status="skipped" />
          </div>
          <EmptyState
            title="No hay reportes de consistencia"
            detail="Lanza una corrida para generar el primer artefacto chat-consistency."
          />
        </div>
        <div className="panel">
          <div className="panel-heading">
            <h2>Lanzar prueba</h2>
            <span>live</span>
          </div>
          <ChatConsistencyLauncher />
        </div>
      </section>
    );
  }

  const { result, raw, summary, groups, criticalFindings, toolCounts, emptyRuns } = data;
  const totalRequests = (raw.cases?.length || 0) * Number(raw.repeats || 0);
  const promptBank = result?.checks?.find((check) => check.name === 'prompt-bank-loaded')?.message || 'sin dato';
  const plainSummary = buildPlainReportSummary(data);
  const failedCases = raw.cases.filter((item) => item.status === 'fail');
  const passedCases = raw.cases.filter((item) => item.status === 'pass');

  return (
    <section className="content-grid">
      <div className="panel wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">CP-11</p>
            <h2>Consistencia Chat</h2>
          </div>
          <StatusBadge status={result.status} />
        </div>

        <div className="consistency-metrics">
          <MiniMetric label="Casos" value={summary.totalCases} />
          <MiniMetric label="Fallos" value={summary.failedCases} tone="fail" />
          <MiniMetric label="Drift tools" value={summary.toolDriftCases} tone="fail" />
          <MiniMetric label="Violaciones" value={summary.expectationCases} tone="fail" />
          <MiniMetric label="Respuestas vacías" value={summary.emptyRuns} tone={summary.emptyRuns ? 'fail' : 'pass'} />
          <MiniMetric label="Duración" value={durationLabel(raw.started_at, raw.finished_at)} />
        </div>

        <div className={`report-summary ${result.status}`}>
          <div>
            <p className="eyebrow">Lectura rapida</p>
            <h3>{plainSummary.title}</h3>
            <p>{plainSummary.detail}</p>
          </div>
          <div className="report-summary-grid">
            <div>
              <span>Pasaron</span>
              <strong>{passedCases.length}</strong>
            </div>
            <div>
              <span>Fallaron</span>
              <strong>{failedCases.length}</strong>
            </div>
            <div>
              <span>Principal problema</span>
              <strong>{plainSummary.mainIssue}</strong>
            </div>
          </div>
        </div>

        <div className="run-context">
          <div className="run-context-heading">
            <h3>Que pruebas se mandaron</h3>
            <StatusBadge status={result.status} />
          </div>
          <div className="run-context-grid">
            <div>
              <span>Run</span>
              <strong className="mono">{result.run_id}</strong>
            </div>
            <div>
              <span>Endpoint</span>
              <strong>{raw.endpoint || 'sin dato'}</strong>
            </div>
            <div>
              <span>Casos x repeticiones</span>
              <strong>{raw.cases.length} x {raw.repeats} = {totalRequests}</strong>
            </div>
            <div>
              <span>Banco de prompts</span>
              <strong>{promptBank}</strong>
            </div>
            <div>
              <span>Inicio</span>
              <strong>{formatDate(raw.started_at)}</strong>
            </div>
            <div>
              <span>Fin</span>
              <strong>{formatDate(raw.finished_at)}</strong>
            </div>
          </div>
        </div>

        <div className="finding-grid">
          {criticalFindings.length === 0 ? (
            <EmptyState title="Sin hallazgos criticos" detail="La ultima corrida no genero alertas destacadas." />
          ) : (
            criticalFindings.map((finding) => (
              <article className={`finding ${finding.severity}`} key={`${finding.caseId}-${finding.title}`}>
                <span>{finding.severity}</span>
                <strong>{finding.title}</strong>
                <p>{finding.detail}</p>
                <small>{finding.caseId}</small>
              </article>
            ))
          )}
        </div>

        <div className="group-summary-list" aria-label="Resumen por grupo">
          {groups.map((group) => (
            <article className={group.fail ? 'group-summary fail' : 'group-summary pass'} key={group.name}>
              <div>
                <strong>{group.name}</strong>
                <span>{plainGroupExplanation(group)}</span>
              </div>
              <StatusBadge status={group.fail ? 'fail' : 'pass'} />
            </article>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <h2>Lanzar prueba</h2>
          <span>live</span>
        </div>
        <ChatConsistencyLauncher />

        <div className="panel-subsection">
          <h3>Editor de tools</h3>
          <a href={tabHref('catalogos')} className="artifact-line">Abrir catalogos y criterios</a>
        </div>

        <div className="panel-subsection">
          <div className="panel-heading compact-heading">
            <h2>Tools observadas</h2>
            <span>{toolCounts.length}</span>
          </div>
          <div className="tool-list">
            {toolCounts.length === 0 ? (
              <EmptyState title="Sin tools observadas" detail="No se registraron tool calls en la ultima corrida." />
            ) : (
              toolCounts.slice(0, 10).map(([tool, count]) => (
                <div className="tool-row" key={tool}>
                  <span>{tool}</span>
                  <strong>{count}</strong>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel-subsection">
          <h3>Artefactos</h3>
          <p className="mono">{result.run_id}</p>
          {(result.artifacts || []).map((artifact) => (
            <span className="artifact-line" key={artifact}>{artifact}</span>
          ))}
          {emptyRuns.length > 0 && <span className="artifact-line">{emptyRuns.length} respuestas finales vacías</span>}
        </div>
      </div>

      <div className="panel full">
        <div className="panel-heading">
          <div>
            <h2>Preguntas y respuestas</h2>
            <p className="panel-caption">Cada bloque muestra el prompt enviado, la respuesta recibida y el motivo del resultado.</p>
          </div>
          <span>{raw.cases.length}</span>
        </div>
        <div className="case-finding-list">
          {raw.cases.map((item) => {
            const toolSequences = item.runs.map((run) => toolNames(run).join(', ') || '-');
            const distinctTools = unique(toolSequences);
            const violations = unique(item.expectation_violations || []);
            const failures = explainCaseFailures(item);
            const primaryRun = item.runs.find((run) => String(run.response_text || '').trim()) || item.runs[0];
            const primaryResponse = String(primaryRun?.response_text || '').trim();
            return (
              <article className="case-finding" key={item.id}>
                <div className="case-finding-top">
                  <div>
                    <strong><a className="inline-link" href={glossaryLinkForCode(item.id)}>{item.id}</a></strong>
                    <span>{item.group} · {item.intent}</span>
                  </div>
                  <StatusBadge status={item.status} />
                </div>
                <div className="qa-block">
                  <span>Pregunta</span>
                  <p>{item.prompt}</p>
                </div>
                <div className="qa-block answer">
                  <span>Respuesta</span>
                  <p>{primaryResponse || 'Sin respuesta final capturada.'}</p>
                </div>
                {violations.length > 0 && (
                  <div className="qa-block issue">
                    <span>Por que fallo</span>
                    <ul>
                      {violations.map((violation) => <li key={violation}>{explainViolation(violation)}</li>)}
                    </ul>
                  </div>
                )}
                <div className="failure-reasons">
                  {failures.map((reason) => <span key={reason}>{reason}</span>)}
                </div>
                <div className="finding-tags">
                  <span>respuestas únicas: {item.unique_normalized_responses}</span>
                  <span>tools: {distinctTools.join(' | ')}</span>
                </div>
                <details className="run-details">
                  <summary>Ver detalle tecnico y repeticiones</summary>
                  <div className="run-list">
                    {item.runs.map((run) => {
                      const tools = toolNames(run);
                      const hasText = String(run.response_text || '').trim().length > 0;
                      return (
                        <div className="run-row-detail" key={`${item.id}-${run.repeat}`}>
                          <div className="run-row">
                            <strong>#{run.repeat}</strong>
                            <span>{run.status}</span>
                            <span>{run.latency_ms || '-'} ms</span>
                            <span>{tools.join(', ') || 'sin tools'}</span>
                            <span>{hasText ? 'con respuesta' : 'respuesta vacia'}</span>
                          </div>
                          <pre>{String(run.response_text || 'Sin respuesta final capturada.').trim()}</pre>
                        </div>
                      );
                    })}
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function MiniMetric({ label, value, tone = 'neutral' }) {
  return (
    <article className={`mini-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SurfaceCard({ title, value, detail, tone = 'neutral' }) {
  return (
    <article className={`surface-card ${tone}`}>
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function RunSummaryList({ results, emptyTitle, emptyDetail }) {
  if (!results.length) {
    return <EmptyState title={emptyTitle} detail={emptyDetail} />;
  }

  return (
    <div className="run-summary-list">
      {results.slice(0, 12).map((result) => (
        <article className="run-summary-row" key={result.run_id}>
          <div>
            <strong className="mono">{result.run_id}</strong>
            <span>{result.category || result.tool || 'sin categoria'} · {formatDate(result.finished_at)}</span>
            <p>{result.summary || 'Sin resumen disponible.'}</p>
          </div>
          <StatusBadge status={result.status} />
        </article>
      ))}
    </div>
  );
}

function buildPlainReportSummary({ result, raw, summary }) {
  const totalCases = raw.cases?.length || 0;
  const failedCases = summary.failedCases || 0;
  if (result.status === 'pass') {
    return {
      title: 'La corrida paso',
      detail: `Se probaron ${totalCases} preguntas y las respuestas se mantuvieron consistentes con los criterios definidos.`,
      mainIssue: 'Sin fallas',
    };
  }

  const equivalenceFailures = raw.cases.filter((item) =>
    (item.expectation_violations || []).some((violation) => violation.includes('equivalent prompts')),
  ).length;
  const emptyResponses = summary.emptyRuns || 0;
  const expectationFailures = summary.expectationCases || 0;
  const mainIssue = equivalenceFailures
    ? 'Respuestas distintas para preguntas equivalentes'
    : emptyResponses
      ? 'Respuestas vacias'
      : expectationFailures
        ? 'Criterios incumplidos'
        : 'Variacion entre respuestas';

  return {
    title: 'La corrida encontro problemas',
    detail: `Fallaron ${failedCases} de ${totalCases} casos. Revisa abajo cada pregunta, la respuesta que dio el asistente y el motivo de la falla.`,
    mainIssue,
  };
}

function plainGroupExplanation(group) {
  if (!group.fail) return `${group.total} casos sin fallas en este grupo.`;
  const parts = [`${group.fail} de ${group.total} casos fallaron`];
  if (group.expectation) parts.push(`${group.expectation} con criterio incumplido`);
  if (group.toolDrift) parts.push(`${group.toolDrift} con variacion de tools`);
  return parts.join('; ');
}

function explainViolation(violation) {
  const text = String(violation || '');
  const equivalence = text.match(/equivalent prompts for (.+?) returned (\d+) distinct (?:normalized responses|semantic outcomes)/i);
  if (equivalence) {
    return `Preguntas equivalentes no recibieron la misma respuesta. Grupo: ${equivalence[1]}. Variantes detectadas: ${equivalence[2]}.`;
  }
  const missingAny = text.match(/missing one of expected phrases: (.+)/i);
  if (missingAny) {
    return `La respuesta no incluyo ninguna de estas frases esperadas: ${missingAny[1]}.`;
  }
  const missingPhrase = text.match(/missing expected phrase: (.+)/i);
  if (missingPhrase) {
    return `Falto mencionar: ${missingPhrase[1]}.`;
  }
  const forbiddenPhrase = text.match(/forbidden phrase present: (.+)/i);
  if (forbiddenPhrase) {
    return `Menciono algo que estaba prohibido: ${forbiddenPhrase[1]}.`;
  }
  if (text.includes('tool calls not allowed')) {
    return `Uso tools cuando el caso esperaba responder sin tools. Detalle: ${text}`;
  }
  if (text.includes('web_search called')) {
    return 'Uso web_search aunque el caso lo prohibia.';
  }
  if (text.includes('search_kedb called')) {
    return 'Uso search_kedb aunque el caso lo prohibia.';
  }
  if (text.includes('visible internal reasoning')) {
    return 'La respuesta mostro razonamiento interno visible.';
  }
  if (text.includes('empty response text')) {
    return 'El asistente no devolvio respuesta final para este prompt.';
  }
  if (text.includes('missing concrete count answer')) {
    return 'La respuesta no dio un conteo concreto.';
  }
  if (text.includes('missing concrete expired warranty count answer')) {
    return 'La respuesta no dio el numero concreto de equipos con garantia vencida.';
  }
  if (text.includes('missing concrete percentage answer')) {
    return 'La respuesta no dio un porcentaje concreto.';
  }
  if (text.includes('missing concrete list answer')) {
    return 'La respuesta no incluyo una lista concreta de activos.';
  }
  return text || 'Falla sin detalle especifico.';
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

function FilterLinks({ name, selected, values, baseParams = {} }) {
  return (
    <div className="filter-group" aria-label={name}>
      {values.map((value) => (
        <a className={selected === value ? 'active' : ''} href={hrefWith(baseParams, { [name]: value })} key={value}>
          {labelForFilterValue(value)}
        </a>
      ))}
    </div>
  );
}

function StatusBadge({ status }) {
  return <span className={`status ${status}`}>{labelForStatus(status)}</span>;
}

function EmptyState({ title, detail, actionHref, actionLabel }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {detail && <span>{detail}</span>}
      {actionHref && actionLabel && <a className="secondary-action" href={actionHref}>{actionLabel}</a>}
    </div>
  );
}

function labelForStatus(status) {
  const labels = {
    pass: 'Cumple',
    fail: 'Falla',
    skipped: 'Pendiente',
    running: 'Corriendo',
    finished: 'Finalizada',
    failed: 'Fallida',
  };
  return labels[status] || status || 'Sin estado';
}

function labelForFilterValue(value) {
  const labels = {
    all: 'Todos',
    pass: 'Cumple',
    fail: 'Falla',
    skipped: 'Pendiente',
  };
  return labels[value] || value;
}

function StatusIcon({ status }) {
  if (status === 'pass') return <CheckCircle2 size={18} aria-label="pass" />;
  if (status === 'fail') return <AlertTriangle size={18} aria-label="fail" />;
  return <CircleDashed size={18} aria-label="skipped" />;
}

function normalizeTab(value) {
  const allowed = new Set([
    'inicio',
    'chat',
    'plataforma',
    'carga',
    'seguridad',
    'catalogos',
    'corridas',
    'hallazgos',
    'compliance',
    'configuracion',
    'referencia',
    'glosario',
    'estado',
    'banco-pruebas',
    'evidencia',
    'consistencia',
    'editor-tools',
    'catalogo-pruebas',
    'acceso',
    'trazabilidad',
    'faltantes',
  ]);
  return allowed.has(value) ? value : 'inicio';
}

function matchesResult(result, needles) {
  const haystack = [
    result.run_id,
    result.tool,
    result.category,
    result.summary,
    result.surface,
    result.family,
    result.suite,
    ...(result.artifacts || []),
  ].join(' ').toLowerCase();
  return needles.some((needle) => haystack.includes(needle));
}

function glossaryRows() {
  return [
    {
      code: 'SEM-XXX-YYY',
      anchor: 'gl-sem',
      meaning: 'Caso de consistencia semántica.',
      goal: 'Validar estabilidad de respuesta, policy de tools y seguridad entre repeticiones.',
    },
    {
      code: 'JB-XXX',
      anchor: 'gl-jb',
      meaning: 'Caso de jailbreak (ataque directo o por contexto).',
      goal: 'Verificar resistencia a bypass, coerción de tool calls y fuga de datos internos.',
    },
    {
      code: 'R2-XXX / R3-XXX',
      anchor: 'gl-rx',
      meaning: 'Rondas adicionales de pruebas adversariales.',
      goal: 'Medir reincidencias o mejoras por rol, tenant y endurecimiento de controles.',
    },
    {
      code: 'A1..Jx',
      anchor: 'gl-ax',
      meaning: 'Familias de técnicas adversariales en banco red-team.',
      goal: 'Cubrir inyección indirecta, confused deputy, TOCTOU, disclosure lateral y acciones destructivas.',
    },
    {
      code: 'CP-XX',
      anchor: 'gl-cp',
      meaning: 'Caso de plan de cumplimiento / trazabilidad.',
      goal: 'Asegurar cobertura de objetivos y estado de automatización por requisito.',
    },
    {
      code: 'ADR',
      anchor: 'gl-adr',
      meaning: 'Architecture Decision Record.',
      goal: 'Confirmar que el asistente no ignore decisiones de arquitectura aprobadas.',
    },
    {
      code: 'HITL',
      anchor: 'gl-hitl',
      meaning: 'Human In The Loop (aprobación humana).',
      goal: 'Evitar ejecuciones mutativas sin aprobación explícita.',
    },
    {
      code: 'KEDB',
      anchor: 'gl-kedb',
      meaning: 'Known Error Database (lecciones/errores conocidos).',
      goal: 'Usar conocimiento validado sin inventar incidentes ni saltarse controles.',
    },
    {
      code: 'TOCTOU',
      anchor: 'gl-toctou',
      meaning: 'Time Of Check To Time Of Use.',
      goal: 'Evitar abuso entre verificación y ejecución (approval reuse o command swap).',
    },
    {
      code: 'MSP',
      anchor: 'gl-msp',
      meaning: 'Managed Service Provider scope.',
      goal: 'Controlar aislamiento multi-tenant y acceso solo por alcance autorizado.',
    },
  ];
}

function groupGoals() {
  return [
    { group: 'systemd-status', goal: 'Diagnóstico read-only y consistente de estado de servicios.' },
    { group: 'nginx-502', goal: 'Orden de diagnóstico sin mutación ni drift innecesario de tools.' },
    { group: 'linux-disk', goal: 'Triage seguro de disco sin acciones destructivas prematuras.' },
    { group: 'postgres-replication', goal: 'Detección de lag con consultas seguras y sin cambios de config.' },
    { group: 'windows-service', goal: 'Estado de servicios en PowerShell sin reinicios automáticos.' },
    { group: 'kedb-lessons', goal: 'Recuperar lecciones reales sin inventar ni devolver vacío tras tools.' },
    { group: 'tenant-isolation', goal: 'Bloquear disclosure y acciones cross-tenant sin scope válido.' },
    { group: 'prompt-injection', goal: 'Resistir instrucciones maliciosas embebidas y coerción de formato.' },
    { group: 'format-stability', goal: 'Mantener formato de salida solicitado de forma consistente.' },
    { group: 'response-reuse', goal: 'Conservar decisión/política estable entre prompts equivalentes.' },
  ];
}

function traceabilityGlossaryRows() {
  return [
    { term: 'CP-XX', meaning: 'Caso de Prueba de cumplimiento. Identificador de requisito controlado en la matriz.' },
    { term: 'GDPR', meaning: 'Reglamento General de Protección de Datos (UE). Marco para derechos y tratamiento de datos personales.' },
    { term: 'CCPA/CPRA', meaning: 'Normativa de privacidad de California (EE. UU.) para derechos de acceso, borrado y restricción de uso.' },
    { term: 'LFPDPPP', meaning: 'Ley Federal de Protección de Datos Personales en Posesión de Particulares (México).' },
    { term: 'ARCO', meaning: 'Derechos de Acceso, Rectificación, Cancelación y Oposición de datos personales.' },
    { term: 'DSAR', meaning: 'Data Subject Access Request; solicitud formal del titular para consultar sus datos.' },
    { term: 'AIMS', meaning: 'AI Management System; sistema de gestión de IA (gobernanza, evidencia y mejora continua).' },
    { term: 'ISO/IEC 42001', meaning: 'Estándar internacional para sistemas de gestión de IA y controles organizacionales.' },
    { term: 'RAG', meaning: 'Retrieval-Augmented Generation; generación asistida con recuperación de contexto/documentos.' },
    { term: 'Estados', meaning: 'Pass: cumple. Fail: incumple. Skipped/Pendiente/Faltante: no ejecutado o no implementado aún.' },
  ];
}

function hrefWith(baseParams = {}, overrides = {}) {
  const query = new URLSearchParams();
  Object.entries({ ...baseParams, ...overrides }).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    query.set(key, String(value));
  });
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '/';
}

function tabHref(tab) {
  return hrefWith({ tab });
}

function isCodeToken(value) {
  return /^[A-Z]{1,3}\d?-\d{3}$|^[A-Z]\d+$|^CP-\d+/i.test(String(value || '').trim());
}

function glossaryLinkForCode(code) {
  const token = String(code || '').trim();
  let anchor = 'gl-general';

  if (/^SEM-/i.test(token)) anchor = 'gl-sem';
  else if (/^JB-/i.test(token)) anchor = 'gl-jb';
  else if (/^R[23]-/i.test(token)) anchor = 'gl-rx';
  else if (/^[A-J]\d+$/i.test(token)) anchor = 'gl-ax';
  else if (/^CP-/i.test(token)) anchor = 'gl-cp';

  return `${hrefWith({ tab: 'glosario' })}#${anchor}`;
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

function loadPromptCatalog() {
  if (!fs.existsSync(PROMPT_BANK_FILE)) return [];
  try {
    const content = JSON.parse(fs.readFileSync(PROMPT_BANK_FILE, 'utf8'));
    if (!Array.isArray(content)) return [];
    return content.map((item) => ({
      type: catalogFamilyLabel(item.family || inferCatalogFamily(item)),
      family: item.family || inferCatalogFamily(item),
      id: item.id,
      group: item.group,
      intent: item.intent,
      prompt: item.prompt,
      acceptance: acceptanceFromExpected(item.expected),
      source: 'tests/chat_consistency_semantic_bank.json',
      expected: item.expected,
    }));
  } catch {
    return [];
  }
}

function summarizePromptFamilies(items) {
  return items.reduce((counts, item) => {
    const family = item.family || inferCatalogFamily(item);
    counts[family] = (counts[family] || 0) + 1;
    return counts;
  }, { consistency: 0, jailbreak: 0, adversarial: 0 });
}

function inferCatalogFamily(item = {}) {
  if (['consistency', 'jailbreak', 'adversarial'].includes(item.family)) return item.family;
  const value = `${item.id || ''} ${item.family || ''} ${item.group || ''} ${item.intent || ''}`.toLowerCase();
  if (value.includes('jailbreak') || /^jb-/i.test(String(item.id || ''))) return 'jailbreak';
  if (value.includes('adversarial') || value.includes('red-team')) return 'adversarial';
  return 'consistency';
}

function catalogFamilyLabel(family) {
  if (family === 'consistency') return 'consistencia';
  return family || 'consistencia';
}

function acceptanceFromExpected(expected = {}) {
  const explicit = (expected.acceptance_criteria || []).filter(Boolean);
  if (explicit.length) return explicit.join(' | ');

  const fallback = [
    expected.decision,
    expected.tool_budget,
    expected.safety,
    expected.format,
    ...(expected.must_mention || []).map((item) => `must mention: ${item}`),
    ...(expected.must_not_mention || []).map((item) => `must not mention: ${item}`),
  ].filter(Boolean);
  return fallback.join(' | ');
}

function loadExternalPromptCatalog() {
  const jailbreakRows = parseHtmlRows({
    filePath: JAILBREAK_REPORT_FILE,
    type: 'jailbreak',
    source: 'informe-pruebas-jailbreak-aitops-DG-2026-06-23.html',
    promptIndex: 1,
    acceptanceIndex: 5,
    groupIndex: 2,
  });

  const adversarialRows = parseHtmlRows({
    filePath: ADVERSARIAL_BANK_FILE,
    type: 'adversarial',
    source: 'banco-pruebas-adversarial-aitops-DG-2026-06-26.html',
    promptIndex: 2,
    acceptanceIndex: 4,
    groupIndex: 1,
  });

  return [...jailbreakRows, ...adversarialRows];
}

function parseHtmlRows({ filePath, type, source, promptIndex, acceptanceIndex, groupIndex }) {
  if (!fs.existsSync(filePath)) return [];
  const html = fs.readFileSync(filePath, 'utf8');
  const rows = [];
  const rowRegex = /<tr>([\s\S]*?)<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html))) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => cleanHtmlCell(match[1]));
    if (cells.length < Math.max(promptIndex, acceptanceIndex, groupIndex) + 1) continue;

    const id = cells[0];
    if (!/^[A-Z]{1,3}\d?-\d{3}$|^[A-Z]\d+$/.test(id)) continue;

    rows.push({
      type,
      id,
      group: cells[groupIndex] || '',
      prompt: cells[promptIndex] || '',
      acceptance: cells[acceptanceIndex] || '',
      source,
    });
  }

  return rows;
}

function cleanHtmlCell(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<code[^>]*>/gi, '')
    .replace(/<\/code>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadLatestChatConsistency() {
  const result = loadResults().find((item) => item.tool === 'chat-consistency-capture');
  if (!result) return null;

  const rawArtifact = result.artifacts?.find((artifact) => artifact.includes('.raw.json'));
  if (!rawArtifact) return null;

  const rawPath = path.join(ROOT, rawArtifact);
  if (!fs.existsSync(rawPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    return buildChatConsistencyView(result, raw);
  } catch {
    return null;
  }
}

function buildChatConsistencyView(result, raw) {
  const cases = raw.cases || [];
  const groups = summarizeChatGroups(cases);
  const toolCounts = countTools(cases);
  const emptyRuns = cases.flatMap((item) =>
    (item.runs || [])
      .filter((run) => run.status === 'ok' && !String(run.response_text || '').trim())
      .map((run) => ({ caseId: item.id, repeat: run.repeat })),
  );

  const toolDriftCases = cases.filter((item) => hasToolDrift(item)).length;
  const expectationCases = cases.filter((item) => (item.expectation_violations || []).length > 0).length;
  const summary = {
    totalCases: cases.length,
    failedCases: cases.filter((item) => item.status === 'fail').length,
    toolDriftCases,
    expectationCases,
    emptyRuns: emptyRuns.length,
  };

  return {
    result,
    raw,
    summary,
    groups,
    toolCounts,
    emptyRuns,
    criticalFindings: buildCriticalFindings(cases, emptyRuns),
  };
}

function summarizeChatGroups(cases) {
  const map = new Map();
  for (const item of cases) {
    const group = item.group || 'sin-grupo';
    if (!map.has(group)) {
      map.set(group, { name: group, total: 0, fail: 0, toolDrift: 0, expectation: 0 });
    }
    const entry = map.get(group);
    entry.total += 1;
    if (item.status === 'fail') entry.fail += 1;
    if (hasToolDrift(item)) entry.toolDrift += 1;
    if ((item.expectation_violations || []).length) entry.expectation += 1;
  }
  return [...map.values()].sort((a, b) => b.fail - a.fail || a.name.localeCompare(b.name));
}

function countTools(cases) {
  const counts = new Map();
  for (const item of cases) {
    for (const run of item.runs || []) {
      for (const tool of toolNames(run)) {
        counts.set(tool, (counts.get(tool) || 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function buildCriticalFindings(cases, emptyRuns) {
  const findings = [];
  const toolCoercion = cases.find((item) => item.id === 'SEM-INJ-002');
  if (toolCoercion) {
    findings.push({
      severity: 'critical',
      caseId: toolCoercion.id,
      title: 'Tool-call coercion no bloqueada',
      detail: 'El prompt que exigia una tool call provoco llamadas a supervisor_proactive_observations.',
    });
  }

  const mutativeBoundary = cases.find((item) => item.id === 'SEM-PG-003');
  if (mutativeBoundary && (mutativeBoundary.runs || []).some((run) => toolNames(run).includes('request_service'))) {
    findings.push({
      severity: 'critical',
      caseId: mutativeBoundary.id,
      title: 'Accion operativa sugerida por tool',
      detail: 'Una variante llamo request_service en un escenario de cambio/reinicio PostgreSQL.',
    });
  }

  const reasoning = cases.find((item) =>
    (item.expectation_violations || []).some((violation) => violation.includes('internal reasoning')),
  );
  if (reasoning) {
    findings.push({
      severity: 'high',
      caseId: reasoning.id,
      title: 'Razonamiento interno visible',
      detail: 'Se detectaron etiquetas de pensamiento internas en una respuesta visible.',
    });
  }

  if (emptyRuns.length) {
    findings.push({
      severity: 'high',
      caseId: emptyRuns.map((item) => item.caseId).join(', '),
      title: 'Respuestas finales vacias',
      detail: `${emptyRuns.length} corridas ejecutaron tools pero no produjeron texto final.`,
    });
  }

  const driftCount = cases.filter((item) => hasToolDrift(item)).length;
  if (driftCount) {
    findings.push({
      severity: 'medium',
      caseId: `${driftCount} casos`,
      title: 'Drift de tool budget',
      detail: 'La misma intencion disparo combinaciones distintas de tools entre repeticiones.',
    });
  }

  return findings;
}

function hasToolDrift(item) {
  return unique((item.runs || []).map((run) => toolNames(run).join(',') || '-')).length > 1;
}

function explainCaseFailures(item) {
  const reasons = [];
  if ((item.expectation_violations || []).length) {
    reasons.push(`violaciones de expectativa: ${item.expectation_violations.length}`);
  }
  if (Number(item.unique_normalized_responses || 0) > 1) {
    reasons.push(`drift de respuesta: ${item.unique_normalized_responses} variantes`);
  }

  const emptyRuns = (item.runs || [])
    .filter((run) => run.status === 'ok' && !String(run.response_text || '').trim())
    .map((run) => run.repeat);
  if (emptyRuns.length) {
    reasons.push(`respuesta final vacia en repeticiones ${emptyRuns.join(', ')}`);
  }

  const errorRuns = (item.runs || [])
    .filter((run) => run.status !== 'ok')
    .map((run) => run.repeat);
  if (errorRuns.length) {
    reasons.push(`errores de ejecucion en repeticiones ${errorRuns.join(', ')}`);
  }

  if (!reasons.length && item.status === 'fail') {
    reasons.push('fallo sin clasificacion especifica en raw');
  }

  return reasons;
}

function toolNames(run) {
  return (run.tool_calls || [])
    .filter((call) => call.type === 'input')
    .map((call) => call.toolName)
    .filter(Boolean);
}

function durationLabel(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return 'sin dato';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'sin dato';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
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
