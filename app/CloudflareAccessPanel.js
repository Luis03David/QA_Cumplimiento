'use client';

import { useEffect, useState } from 'react';

const DEFAULT_FORM = {
  base_url: 'https://missioncontrol.qa.aitops.ai/',
  access_email: '',
  user_email: '',
  user_password: '',
  access_code: '',
};

export default function CloudflareAccessPanel() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [status, setStatus] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  async function loadConfig() {
    const response = await fetch('/api/cloudflare-access/config', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    setForm((current) => ({
      ...current,
      base_url: payload.config.base_url || current.base_url,
      access_email: payload.config.access_email || '',
      user_email: payload.config.user_email || '',
    }));
  }

  useEffect(() => {
    loadConfig().catch((error) => setStatus(String(error.message || error)));
  }, []);

  async function saveConfig() {
    setStatus('');
    setIsSaving(true);
    try {
      const response = await fetch('/api/cloudflare-access/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setStatus('Configuración guardada.');
      setForm((current) => ({ ...current, access_code: '' }));
    } catch (error) {
      setStatus(String(error.message || error));
    } finally {
      setIsSaving(false);
    }
  }

  async function runLogin() {
    setStatus('');
    setIsRunning(true);
    try {
      const response = await fetch('/api/cloudflare-access/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setStatus(payload.message || 'Login completado y sesión guardada.');
      setForm((current) => ({ ...current, access_code: '' }));
    } catch (error) {
      setStatus(String(error.message || error));
    } finally {
      setIsRunning(false);
    }
  }

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="cloudflare-panel">
      <div className="cloudflare-grid">
        <label className="editor-field">
          <span>Base URL</span>
          <input value={form.base_url} onChange={(event) => update('base_url', event.target.value)} />
        </label>

        <label className="editor-field">
          <span>Cuenta que recibe clave Cloudflare</span>
          <input
            type="email"
            value={form.access_email}
            onChange={(event) => update('access_email', event.target.value)}
            placeholder="correo para code OTP"
          />
        </label>

        <label className="editor-field">
          <span>Cuenta de login de la app</span>
          <input
            type="email"
            value={form.user_email}
            onChange={(event) => update('user_email', event.target.value)}
            placeholder="usuario aplicativo"
          />
        </label>

        <label className="editor-field">
          <span>Password app</span>
          <input
            type="password"
            value={form.user_password}
            onChange={(event) => update('user_password', event.target.value)}
            placeholder="opcional si ya hay sesión"
          />
        </label>

        <label className="editor-field">
          <span>Código Cloudflare (casilla para recibirlo)</span>
          <input
            value={form.access_code}
            onChange={(event) => update('access_code', event.target.value)}
            placeholder="pegar código de correo"
          />
        </label>
      </div>

      <div className="cloudflare-actions">
        <button type="button" disabled={isSaving || isRunning} onClick={saveConfig}>
          {isSaving ? 'Guardando' : 'Guardar cuentas'}
        </button>
        <button type="button" className="secondary-action" disabled={isSaving || isRunning} onClick={runLogin}>
          {isRunning ? 'Iniciando sesión' : 'Ejecutar login Cloudflare'}
        </button>
      </div>

      {status && <p className="editor-status">{status}</p>}
    </div>
  );
}
