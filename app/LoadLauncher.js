'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const DEFAULT_FORM = {
  target_url: '',
  path: '/',
  method: 'GET',
  concurrency: 10,
  duration_ms: 20000,
  timeout_ms: 15000,
  max_error_rate: 0.05,
  p95_slo_ms: 0,
  use_auth: true,
};

const STATUS_LABELS = { running: 'Corriendo', finished: 'Terminada', failed: 'Fallo' };

export default function LoadLauncher() {
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
    const response = await fetch('/api/load/run', { cache: 'no-store' });
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
      const response = await fetch('/api/load/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok && !payload.state) throw new Error(payload.error || `HTTP ${response.status}`);
      setJob(payload.state);
      setProgress(payload.progress || null);
      setLogTail(payload.log_tail || '');
      if (response.status === 409) setError(payload.error || 'Ya hay una corrida de carga activa.');
      else if (!response.ok) setError(payload.error || `HTTP ${response.status}`);
      else setError('');
    } catch (launchError) {
      setError(String(launchError.message || launchError));
    } finally {
      setIsLaunching(false);
    }
  }

  const isRunning = job?.status === 'running';

  return (
    <div className="launcher">
      <div className="launcher-selector">
        <div className="launcher-selector-head">
          <div>
            <strong>Parametros de carga</strong>
            <span>Deja el target vacio para usar AITOPS_BASE_URL del .env</span>
          </div>
        </div>
        <div className="launcher-filters" style={{ flexWrap: 'wrap' }}>
          <label className="grow">
            <span>Target URL (opcional)</span>
            <input value={form.target_url} disabled={isRunning || isLaunching} placeholder="https://missioncontrol.qa.aitops.ai/" onChange={(event) => setField('target_url', event.target.value)} />
          </label>
          <label>
            <span>Ruta</span>
            <input value={form.path} disabled={isRunning || isLaunching} onChange={(event) => setField('path', event.target.value)} />
          </label>
          <label>
            <span>Metodo</span>
            <select value={form.method} disabled={isRunning || isLaunching} onChange={(event) => setField('method', event.target.value)}>
              <option value="GET">GET</option>
              <option value="HEAD">HEAD</option>
            </select>
          </label>
        </div>
        <div className="launcher-controls" style={{ flexWrap: 'wrap' }}>
          <label>
            <span>Concurrencia</span>
            <input type="number" min="1" max="200" value={form.concurrency} disabled={isRunning || isLaunching} onChange={(event) => setField('concurrency', Number(event.target.value))} />
          </label>
          <label>
            <span>Duracion ms</span>
            <input type="number" min="1000" max="300000" step="1000" value={form.duration_ms} disabled={isRunning || isLaunching} onChange={(event) => setField('duration_ms', Number(event.target.value))} />
          </label>
          <label>
            <span>Timeout ms</span>
            <input type="number" min="1000" max="120000" step="1000" value={form.timeout_ms} disabled={isRunning || isLaunching} onChange={(event) => setField('timeout_ms', Number(event.target.value))} />
          </label>
          <label>
            <span>Error max</span>
            <input type="number" min="0" max="1" step="0.01" value={form.max_error_rate} disabled={isRunning || isLaunching} onChange={(event) => setField('max_error_rate', Number(event.target.value))} />
          </label>
          <label>
            <span>SLO p95 ms (0=off)</span>
            <input type="number" min="0" max="300000" step="100" value={form.p95_slo_ms} disabled={isRunning || isLaunching} onChange={(event) => setField('p95_slo_ms', Number(event.target.value))} />
          </label>
          <label className="launcher-case-row" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={form.use_auth} disabled={isRunning || isLaunching} onChange={(event) => setField('use_auth', event.target.checked)} />
            <span><strong>Usar sesion (.auth)</strong></span>
          </label>
        </div>
      </div>

      <div className="launcher-controls">
        <button type="button" disabled={isRunning || isLaunching} onClick={launch}>
          {isRunning ? 'Corriendo' : isLaunching ? 'Lanzando' : 'Lanzar carga'}
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
          <small>{job.target_url || 'target del .env'} · {job.method} · {job.concurrency} workers · {Math.round((job.duration_ms || 0) / 1000)}s</small>
          {progress && (
            <div className="launcher-progress">
              <div className="launcher-progress-bar"><span style={{ width: `${progress.percent}%` }} /></div>
              <div className="launcher-progress-stats">
                <span><strong>{progress.requests}</strong> peticiones ({progress.percent}%)</span>
                <span>OK {progress.ok} · errores {progress.errors}</span>
                <span>p95 {progress.p95_ms === null ? '—' : `${progress.p95_ms}ms`}</span>
              </div>
            </div>
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
