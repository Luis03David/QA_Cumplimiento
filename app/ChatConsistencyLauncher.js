'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const DEFAULT_STATE = {
  repeats: 3,
  timeout_ms: 90000,
};

function inferCaseFamily(item = {}) {
  if (['consistency', 'jailbreak', 'adversarial'].includes(item.family)) return item.family;
  const value = `${item.id || ''} ${item.family || ''} ${item.group || ''} ${item.intent || ''}`.toLowerCase();
  if (value.includes('jailbreak') || /^jb-/i.test(String(item.id || ''))) return 'jailbreak';
  if (value.includes('adversarial') || value.includes('red-team')) return 'adversarial';
  return 'consistency';
}

function familyLabel(family) {
  const labels = {
    all: 'Todas',
    consistency: 'Consistencia',
    jailbreak: 'Jailbreak',
    adversarial: 'Adversarial',
  };
  return labels[family] || family;
}

export default function ChatConsistencyLauncher() {
  const router = useRouter();
  const [form, setForm] = useState(DEFAULT_STATE);
  const [cases, setCases] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [caseQuery, setCaseQuery] = useState('');
  const [familyFilter, setFamilyFilter] = useState('consistency');
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState(null);
  const [logTail, setLogTail] = useState('');
  const [nowTick, setNowTick] = useState(Date.now());
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState('');
  const [isLaunching, setIsLaunching] = useState(false);
  const previousStatus = useRef(null);

  async function refreshStatus() {
    const response = await fetch('/api/chat-consistency/run', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok && !payload.state) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    setJob(payload.state);
    setProgress(payload.progress || null);
    setLogTail(payload.log_tail || '');
    return payload.state;
  }

  useEffect(() => {
    refreshStatus().catch((statusError) => setError(String(statusError.message || statusError)));
    fetch('/api/chat-consistency/prompts', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        const nextCases = payload.cases || [];
        setCases(nextCases);
        setSelectedIds(nextCases.filter((item) => inferCaseFamily(item) === 'consistency').map((item) => item.id));
      })
      .catch((loadError) => setError(String(loadError.message || loadError)));
  }, []);

  useEffect(() => {
    if (!job?.status) return undefined;
    if (previousStatus.current === 'running' && job.status !== 'running') {
      router.refresh();
    }
    previousStatus.current = job.status;

    if (job.status !== 'running') return undefined;
    const timer = window.setInterval(() => {
      refreshStatus().catch((statusError) => setError(String(statusError.message || statusError)));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job?.status, router]);

  // Reloj en vivo: mantiene el tiempo transcurrido moviendose aunque el
  // sondeo del log tarde, para que la vista nunca se sienta congelada.
  useEffect(() => {
    if (job?.status !== 'running') return undefined;
    const ticker = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(ticker);
  }, [job?.status]);

  async function launchRun() {
    setError('');
    setIsLaunching(true);
    try {
      const response = await fetch('/api/chat-consistency/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repeats: form.repeats,
          timeout_ms: form.timeout_ms,
          selected_case_ids: selectedIds,
        }),
      });
      const payload = await response.json();
      if (!response.ok && !payload.state) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      setJob(payload.state);
      setProgress(payload.progress || null);
      setLogTail(payload.log_tail || '');
      setNowTick(Date.now());
      if (response.status === 409) {
        setError(payload.error || 'Ya hay una corrida activa.');
      } else if (!response.ok) {
        setError(payload.error || `HTTP ${response.status}`);
      } else {
        setError('');
      }
    } catch (launchError) {
      setError(String(launchError.message || launchError));
    } finally {
      setIsLaunching(false);
    }
  }

  const isRunning = job?.status === 'running';
  const normalizedQuery = caseQuery.trim().toLowerCase();
  const families = ['consistency', 'jailbreak', 'adversarial'];
  const familyCounts = families.reduce((acc, family) => {
    acc[family] = cases.filter((item) => inferCaseFamily(item) === family).length;
    return acc;
  }, {});
  const filteredCases = cases.filter((item) => {
    const family = inferCaseFamily(item);
    const familyMatch = familyFilter === 'all' || family === familyFilter;
    const searchable = `${family} ${item.id} ${item.group} ${item.intent} ${item.variant} ${item.prompt}`.toLowerCase();
    const queryMatch = !normalizedQuery || searchable.includes(normalizedQuery);
    return familyMatch && queryMatch;
  });
  const selectedSet = new Set(selectedIds);
  const canLaunch = selectedIds.length > 0;
  const selectedCases = cases.filter((item) => selectedSet.has(item.id));

  const elapsedMs = job?.started_at
    ? (job.status === 'running'
        ? nowTick - new Date(job.started_at).getTime()
        : new Date(job.finished_at || job.started_at).getTime() - new Date(job.started_at).getTime())
    : 0;
  const elapsedLabel = Number.isFinite(elapsedMs) && elapsedMs >= 0
    ? `${Math.floor(elapsedMs / 60000)}m ${Math.floor((elapsedMs % 60000) / 1000)}s`
    : 'sin dato';
  const statusLabels = {
    running: 'Corriendo',
    finished: 'Terminada',
    failed: 'Fallo',
  };

  function toggleCase(id) {
    setSelectedIds((current) => (
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    ));
  }

  function selectFamily(family) {
    setFamilyFilter(family);
    setSelectedIds(cases.filter((item) => inferCaseFamily(item) === family).map((item) => item.id));
  }

  function selectFilteredFamily() {
    setSelectedIds(filteredCases.map((item) => item.id));
  }

  function selectAll() {
    setSelectedIds(cases.map((item) => item.id));
    setFamilyFilter('all');
  }

  function clearAll() {
    setSelectedIds([]);
  }

  return (
    <div className="launcher">
      <div className="launcher-controls">
        <label>
          <span>Reps</span>
          <input
            type="number"
            min="1"
            max="5"
            value={form.repeats}
            disabled={isRunning || isLaunching}
            onChange={(event) => setForm((current) => ({ ...current, repeats: Number(event.target.value) }))}
          />
        </label>
        <label>
          <span>Timeout ms</span>
          <input
            type="number"
            min="10000"
            max="300000"
            step="10000"
            value={form.timeout_ms}
            disabled={isRunning || isLaunching}
            onChange={(event) => setForm((current) => ({ ...current, timeout_ms: Number(event.target.value) }))}
          />
        </label>
        <button type="button" disabled={isRunning || isLaunching || !canLaunch} onClick={launchRun}>
          {isRunning ? 'Corriendo' : isLaunching ? 'Lanzando' : 'Lanzar prueba'}
        </button>
        <button type="button" className="secondary-action" disabled={isLaunching} onClick={() => refreshStatus().catch((statusError) => setError(String(statusError.message || statusError)))}>
          Refrescar estado
        </button>
      </div>

      <div className="launcher-selector">
        <div className="launcher-selector-head">
          <div>
            <strong>Familia de pruebas de chat</strong>
            <span>{selectedIds.length} casos seleccionados · filtro {familyLabel(familyFilter)}</span>
          </div>
          <div className="launcher-selector-actions">
            <button type="button" className={familyFilter === 'consistency' ? 'secondary-action active' : 'secondary-action'} disabled={isRunning || isLaunching} onClick={() => selectFamily('consistency')}>Consistencia ({familyCounts.consistency})</button>
            <button type="button" className={familyFilter === 'jailbreak' ? 'secondary-action active' : 'secondary-action'} disabled={isRunning || isLaunching} onClick={() => selectFamily('jailbreak')}>Jailbreak ({familyCounts.jailbreak})</button>
            <button type="button" className={familyFilter === 'adversarial' ? 'secondary-action active' : 'secondary-action'} disabled={isRunning || isLaunching} onClick={() => selectFamily('adversarial')}>Adversarial ({familyCounts.adversarial})</button>
            <button type="button" className={familyFilter === 'all' ? 'secondary-action active' : 'secondary-action'} disabled={isRunning || isLaunching} onClick={selectAll}>Todas</button>
            <button type="button" className="secondary-action" disabled={isRunning || isLaunching} onClick={clearAll}>Ninguna</button>
          </div>
        </div>

        <div className="launcher-filters">
          <label>
            <span>Buscar dentro de la familia</span>
            <input
              value={caseQuery}
              disabled={isRunning || isLaunching}
              onChange={(event) => setCaseQuery(event.target.value)}
              placeholder="ID, grupo, intención o prompt"
            />
          </label>
          <button type="button" className="secondary-action" disabled={isRunning || isLaunching} onClick={selectFilteredFamily}>Usar resultados filtrados</button>
        </div>

        <div className="launcher-case-list">
          {filteredCases.slice(0, 80).map((item) => (
            <label className="launcher-case-row" key={item.id}>
              <input
                type="checkbox"
                checked={selectedSet.has(item.id)}
                disabled={isRunning || isLaunching}
                onChange={() => toggleCase(item.id)}
              />
              <span>
                <strong>{item.id}</strong>
                <small>{familyLabel(inferCaseFamily(item))} · {item.group} · {item.intent}</small>
                <em>{item.prompt}</em>
              </span>
            </label>
          ))}
          {filteredCases.length > 80 && <p className="editor-note">Mostrando 80 de {filteredCases.length}; usa el buscador para afinar dentro de {familyLabel(familyFilter)}.</p>}
          {filteredCases.length === 0 && <p className="editor-note">No hay casos en esta familia. Crea o cambia la familia del caso desde Catalogos.</p>}
        </div>
      </div>

      <div className="launcher-custom-note">
        <strong>Prompts nuevos</strong>
        <span>Para probar algo nuevo, crea el caso en Catalogos y asigna familia: consistencia, jailbreak o adversarial.</span>
        <a className="secondary-action" href="?tab=catalogos">Abrir catalogos</a>
      </div>

      {!canLaunch && <p className="launcher-error">Selecciona al menos un caso de consistencia, jailbreak o adversarial.</p>}

      <details className="launcher-selected">
        <summary>Qué se va a ejecutar · {selectedCases.length} casos × {form.repeats} reps = {selectedCases.length * form.repeats} solicitudes</summary>
        <ul className="launcher-selected-list">
          {selectedCases.slice(0, 40).map((item) => (
            <li key={item.id}>
              <strong>{item.id}</strong>
              <em>{item.prompt}</em>
            </li>
          ))}
          {selectedCases.length > 40 && <li className="editor-note">…y {selectedCases.length - 40} más.</li>}
          {selectedCases.length === 0 && <li className="editor-note">Aún no hay casos seleccionados.</li>}
        </ul>
      </details>

      {job && (
        <div className={`launcher-state ${job.status}`}>
          <div className="launcher-state-head">
            <strong className="mono">{job.id}</strong>
            <span className={`launcher-pill ${job.status}`}>{statusLabels[job.status] || job.status}</span>
          </div>

          {progress && progress.total_runs > 0 && (
            <div className="launcher-progress">
              <div className="launcher-progress-bar">
                <span style={{ width: `${progress.percent}%` }} />
              </div>
              <div className="launcher-progress-stats">
                <span><strong>{progress.completed_runs}</strong>/{progress.total_runs} solicitudes ({progress.percent}%)</span>
                <span>caso <strong>{progress.completed_cases}</strong>/{progress.total_cases}</span>
                <span>OK {progress.ok_runs} · errores {progress.error_runs}</span>
                <span>⏱ {elapsedLabel}</span>
              </div>
              {isRunning && progress.current_case_id && (
                <p className="launcher-current">Ejecutando ahora: <strong>{progress.current_case_id}</strong></p>
              )}
            </div>
          )}

          {(!progress || progress.total_runs === 0) && (
            <small>{job.prompt_path} · {job.prompt_count || '?'} casos · reps {job.repeats} · ⏱ {elapsedLabel}</small>
          )}

          {progress?.recent?.length > 0 && (
            <ul className="launcher-recent">
              {progress.recent.slice().reverse().map((event, index) => (
                <li key={`${event.caseId}-${event.repeat}-${index}`} className={event.error ? 'err' : event.ok ? 'ok' : ''}>
                  <span className="mono">{event.caseId}</span>
                  <span>#{event.repeat}</span>
                  <span>{event.outcome}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="launcher-error">{error}</p>}

      {logTail && (
        <details className="launcher-log-wrap" open={showLog} onToggle={(event) => setShowLog(event.target.open)}>
          <summary>Ver log crudo</summary>
          <pre className="launcher-log">{logTail}</pre>
        </details>
      )}
    </div>
  );
}
