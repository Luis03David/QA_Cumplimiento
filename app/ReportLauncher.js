'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const DEFAULT_FORM = {
  title: 'Pruebas de carga y seguridad de la plataforma AITOps',
  target: '',
  p95_edge: 1000,
  p95_app: 1500,
  max_error_rate: 0.02,
  blocking_severity: 'high',
  use_llm: true,
};

const STATUS_LABELS = { running: 'Generando', finished: 'Listo', failed: 'Fallo' };
const SOURCE_LABELS = {
  llm: 'Interpretacion del modelo (temp 0)',
  'llm+fallback': 'Modelo + respaldo determinista',
  determinista: 'Determinista (sin modelo)',
};

export default function ReportLauncher() {
  const router = useRouter();
  const [form, setForm] = useState(DEFAULT_FORM);
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState(null);
  const [logTail, setLogTail] = useState('');
  const [error, setError] = useState('');
  const [isLaunching, setIsLaunching] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const previousStatus = useRef(null);

  async function refreshStatus() {
    const response = await fetch('/api/report/run', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok && !payload.state) throw new Error(payload.error || `HTTP ${response.status}`);
    setJob(payload.state);
    setProgress(payload.progress || null);
    setLogTail(payload.log_tail || '');
    return payload.state;
  }

  useEffect(() => {
    refreshStatus().catch((statusError) => setError(String(statusError.message || statusError)));
  }, []);

  useEffect(() => {
    if (!job?.status) return undefined;
    if (previousStatus.current === 'running' && job.status !== 'running') router.refresh();
    previousStatus.current = job.status;
    if (job.status !== 'running') return undefined;
    const timer = window.setInterval(() => {
      refreshStatus().catch((statusError) => setError(String(statusError.message || statusError)));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [job?.status, router]);

  function setField(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function launch() {
    setError('');
    setIsLaunching(true);
    try {
      const response = await fetch('/api/report/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok && !payload.state) throw new Error(payload.error || `HTTP ${response.status}`);
      setJob(payload.state);
      setProgress(payload.progress || null);
      setLogTail(payload.log_tail || '');
      if (response.status === 409) setError(payload.error || 'Ya hay un informe generandose.');
      else if (!response.ok) setError(payload.error || `HTTP ${response.status}`);
      else setError('');
    } catch (launchError) {
      setError(String(launchError.message || launchError));
    } finally {
      setIsLaunching(false);
    }
  }

  const isRunning = job?.status === 'running';
  const reportPath = progress?.report_path || job?.report_path || null;
  const reportName = reportPath ? reportPath.split('/').pop() : null;
  const source = progress?.narrative_source || job?.narrative_source || null;

  return (
    <div className="launcher">
      <div className="launcher-selector">
        <div className="launcher-selector-head">
          <div>
            <strong>Generar informe de carga y seguridad</strong>
            <span>Agrega la evidencia mas reciente (carga, SAST, DAST, chat) en un informe HTML.</span>
          </div>
        </div>
        <div className="launcher-filters" style={{ flexWrap: 'wrap' }}>
          <label className="grow">
            <span>Titulo</span>
            <input value={form.title} disabled={isRunning || isLaunching} onChange={(event) => setField('title', event.target.value)} />
          </label>
          <label className="grow">
            <span>Objetivo (opcional)</span>
            <input value={form.target} disabled={isRunning || isLaunching} placeholder="missioncontrol.qa.aitops.ai" onChange={(event) => setField('target', event.target.value)} />
          </label>
        </div>
        <div className="launcher-controls" style={{ flexWrap: 'wrap' }}>
          <label>
            <span>SLO p95 borde (ms)</span>
            <input type="number" min="1" max="600000" step="50" value={form.p95_edge} disabled={isRunning || isLaunching} onChange={(event) => setField('p95_edge', Number(event.target.value))} />
          </label>
          <label>
            <span>SLO p95 app (ms)</span>
            <input type="number" min="1" max="600000" step="50" value={form.p95_app} disabled={isRunning || isLaunching} onChange={(event) => setField('p95_app', Number(event.target.value))} />
          </label>
          <label>
            <span>Error maximo</span>
            <input type="number" min="0" max="1" step="0.01" value={form.max_error_rate} disabled={isRunning || isLaunching} onChange={(event) => setField('max_error_rate', Number(event.target.value))} />
          </label>
          <label>
            <span>Severidad bloqueante</span>
            <select value={form.blocking_severity} disabled={isRunning || isLaunching} onChange={(event) => setField('blocking_severity', event.target.value)}>
              <option value="high">Alta</option>
              <option value="medium">Media</option>
              <option value="low">Baja</option>
            </select>
          </label>
          <label className="launcher-case-row" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={form.use_llm} disabled={isRunning || isLaunching} onChange={(event) => setField('use_llm', event.target.checked)} />
            <span><strong>Redactar con el modelo</strong> (temp 0; si no responde, usa respaldo determinista)</span>
          </label>
        </div>
      </div>

      <div className="launcher-controls">
        <button type="button" disabled={isRunning || isLaunching} onClick={launch}>
          {isRunning ? 'Generando' : isLaunching ? 'Lanzando' : 'Generar informe'}
        </button>
        <button type="button" className="secondary-action" disabled={isLaunching} onClick={() => refreshStatus().catch((statusError) => setError(String(statusError.message || statusError)))}>
          Refrescar estado
        </button>
      </div>

      {job && (
        <div className={`launcher-state ${job.status}`}>
          <div className="launcher-state-head">
            <strong className="mono">{job.id}</strong>
            <span className={`launcher-pill ${job.status}`}>{STATUS_LABELS[job.status] || job.status}</span>
          </div>
          {progress && (
            <div className="launcher-progress">
              <div className="launcher-progress-bar"><span style={{ width: `${progress.percent}%` }} /></div>
              <div className="launcher-progress-stats">
                {progress.steps.map((step) => (
                  <span key={step.key}>{step.label}: {step.status === 'done' ? 'ok' : step.status === 'running' ? '…' : '·'}</span>
                ))}
              </div>
            </div>
          )}
          {job.status === 'finished' && reportName && (
            <p style={{ marginTop: 10 }}>
              <a href={`/api/report/file?name=${encodeURIComponent(reportName)}`} target="_blank" rel="noreferrer">
                Abrir informe generado
              </a>
              {source && <small> · Narrativa: {SOURCE_LABELS[source] || source}</small>}
              <br />
              <small className="mono">{reportPath}</small>
            </p>
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
