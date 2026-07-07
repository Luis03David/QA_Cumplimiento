'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function JudgeReviewButton({ runId, isReviewed }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function runReview() {
    setBusy(true);
    setError('');
    setMessage('Evaluando con el juez… (puede tardar unos segundos por caso)');
    try {
      const response = await fetch('/api/chat-consistency/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(runId ? { run_id: runId } : {}),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || payload.error || `HTTP ${response.status}`);
      setMessage('Revisión lista. Abriendo resultado…');
      if (payload.reviewed_run_id) {
        router.push(`?tab=chat&run=${encodeURIComponent(payload.reviewed_run_id)}`);
        router.refresh();
      } else {
        router.refresh();
      }
    } catch (reviewError) {
      setError(String(reviewError.message || reviewError));
      setMessage('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="judge-review">
      <button type="button" className="secondary-action" disabled={busy} onClick={runReview}>
        {busy ? 'Revisando con el juez…' : 'Revisar con el juez (IA)'}
      </button>
      <p className="editor-note">
        Re-evalúa los casos marcados como falla que sí obtuvieron respuesta: rescata la variación de forma
        aceptable (opciones, pasos cortos o largos con el mismo fin) y mantiene fallas de seguridad,
        contradicciones y respuestas que no pasaron la barrera.
        {isReviewed ? ' Esta corrida ya es una revisión; se re-evaluará la corrida mecánica de origen.' : ''}
      </p>
      {message && <p className="editor-status">{message}</p>}
      {error && <p className="launcher-error">{error}</p>}
    </div>
  );
}
