'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const SCANS = [
  { key: 'secret', label: 'Secret scan', detail: 'Credenciales, tokens y valores sensibles expuestos en el repo.' },
  { key: 'dependency', label: 'Dependency audit', detail: 'Vulnerabilidades conocidas en dependencias (pip/npm).' },
];

const STATUS_LABELS = { running: 'Corriendo', finished: 'Terminada', failed: 'Fallo' };
const STEP_LABELS = { pending: 'en espera', running: 'corriendo', done: 'ok', error: 'error' };

export default function SecurityLauncher() {
  const router = useRouter();
  const [selected, setSelected] = useState(['secret', 'dependency']);
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState(null);
  const [logTail, setLogTail] = useState('');
  const [error, setError] = useState('');
  const [isLaunching, setIsLaunching] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const previousStatus = useRef(null);

  async function refreshStatus() {
    const response = await fetch('/api/security/run', { cache: 'no-store' });
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
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job?.status, router]);

  function toggle(key) {
    setSelected((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  }

  async function launch() {
    setError('');
    setIsLaunching(true);
    try {
      const response = await fetch('/api/security/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scans: selected }),
      });
      const payload = await response.json();
      if (!response.ok && !payload.state) throw new Error(payload.error || `HTTP ${response.status}`);
      setJob(payload.state);
      setProgress(payload.progress || null);
      setLogTail(payload.log_tail || '');
      if (response.status === 409) setError(payload.error || 'Ya hay un escaneo activo.');
      else if (!response.ok) setError(payload.error || `HTTP ${response.status}`);
      else setError('');
    } catch (launchError) {
      setError(String(launchError.message || launchError));
    } finally {
      setIsLaunching(false);
    }
  }

  const isRunning = job?.status === 'running';
  const canLaunch = selected.length > 0;

  return (
    <div className="launcher">
      <div className="launcher-selector">
        <div className="launcher-selector-head">
          <div>
            <strong>Escaneos de seguridad</strong>
            <span>{selected.length} seleccionados · corren en secuencia y dejan evidencia por escaneo</span>
          </div>
        </div>
        <div className="launcher-case-list">
          {SCANS.map((scan) => (
            <label className="launcher-case-row" key={scan.key}>
              <input type="checkbox" checked={selected.includes(scan.key)} disabled={isRunning || isLaunching} onChange={() => toggle(scan.key)} />
              <span>
                <strong>{scan.label}</strong>
                <em>{scan.detail}</em>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="launcher-controls">
        <button type="button" disabled={isRunning || isLaunching || !canLaunch} onClick={launch}>
          {isRunning ? 'Corriendo' : isLaunching ? 'Lanzando' : 'Lanzar escaneos'}
        </button>
        <button type="button" className="secondary-action" disabled={isLaunching} onClick={() => refreshStatus().catch((statusError) => setError(String(statusError.message || statusError)))}>
          Refrescar estado
        </button>
      </div>

      {!canLaunch && <p className="launcher-error">Selecciona al menos un escaneo.</p>}

      {job && (
        <div className={`launcher-state ${job.status}`}>
          <div className="launcher-state-head">
            <strong className="mono">{job.id}</strong>
            <span className={`launcher-pill ${job.status}`}>{STATUS_LABELS[job.status] || job.status}</span>
          </div>
          {progress && progress.total_steps > 0 && (
            <div className="launcher-progress">
              <div className="launcher-progress-bar"><span style={{ width: `${progress.percent}%` }} /></div>
              <div className="launcher-progress-stats">
                <span><strong>{progress.completed_steps}</strong>/{progress.total_steps} escaneos ({progress.percent}%)</span>
                {isRunning && progress.current_step && <span>ejecutando <strong>{progress.current_step}</strong></span>}
              </div>
              <ul className="launcher-recent">
                {progress.steps.map((step) => (
                  <li key={step.key} className={step.status === 'error' ? 'err' : step.status === 'done' ? 'ok' : ''}>
                    <span className="mono">{step.label}</span>
                    <span>{STEP_LABELS[step.status] || step.status}</span>
                    <span>{step.exit_code === undefined || step.exit_code === null ? '' : `code ${step.exit_code}`}</span>
                  </li>
                ))}
              </ul>
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
