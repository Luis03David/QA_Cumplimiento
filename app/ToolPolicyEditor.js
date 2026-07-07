'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function lines(value) {
  return Array.isArray(value) ? value.join('\n') : String(value || '');
}

function optionLines(value) {
  if (!Array.isArray(value)) return String(value || '');
  return value
    .map((item) => (Array.isArray(item) ? item.join(' | ') : String(item || '')))
    .join('\n');
}

function inferCaseFamily(item = {}) {
  if (['consistency', 'jailbreak', 'adversarial'].includes(item.family)) return item.family;
  const value = `${item.id || ''} ${item.family || ''} ${item.group || ''} ${item.intent || ''}`.toLowerCase();
  if (value.includes('jailbreak') || /^jb-/i.test(String(item.id || ''))) return 'jailbreak';
  if (value.includes('adversarial') || value.includes('red-team')) return 'adversarial';
  return 'consistency';
}

function familyLabel(family) {
  const labels = {
    consistency: 'consistencia',
    jailbreak: 'jailbreak',
    adversarial: 'adversarial',
  };
  return labels[family] || family;
}

export default function ToolPolicyEditor() {
  const searchParams = useSearchParams();
  const requestedCaseId = searchParams.get('caseId') || '';
  const [cases, setCases] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState(null);
  const [status, setStatus] = useState('');
  const [loadError, setLoadError] = useState('');
  const [caseQuery, setCaseQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newCase, setNewCase] = useState({
    id: '',
    family: 'consistency',
    group: '',
    intent: '',
    variant: '',
    prompt: '',
  });

  const selected = useMemo(
    () => cases.find((item) => item.id === selectedId),
    [cases, selectedId],
  );
  const groups = useMemo(
    () => ['all', ...Array.from(new Set(cases.map((item) => item.group).filter(Boolean))).sort()],
    [cases],
  );
  const families = ['all', 'consistency', 'jailbreak', 'adversarial'];
  const [familyFilter, setFamilyFilter] = useState('all');
  const filteredCases = useMemo(() => {
    const query = caseQuery.trim().toLowerCase();
    return cases.filter((item) => {
      const family = item.family || inferCaseFamily(item);
      const familyMatch = familyFilter === 'all' || family === familyFilter;
      const groupMatch = groupFilter === 'all' || item.group === groupFilter;
      const searchable = `${family} ${item.id} ${item.group} ${item.intent} ${item.variant} ${item.prompt}`.toLowerCase();
      return familyMatch && groupMatch && (!query || searchable.includes(query));
    });
  }, [cases, caseQuery, familyFilter, groupFilter]);
  const selectableCases = selected && !filteredCases.some((item) => item.id === selected.id)
    ? [selected, ...filteredCases]
    : filteredCases;

  useEffect(() => {
    if (filteredCases.length === 1 && filteredCases[0].id !== selectedId) {
      setSelectedId(filteredCases[0].id);
    }
  }, [filteredCases, selectedId]);

  async function loadCases() {
    setIsLoading(true);
    setLoadError('');
    try {
      const response = await fetch('/api/chat-consistency/prompts', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const nextCases = payload.cases || [];
      setCases(nextCases);
      const requested = nextCases.find((item) => item.id === requestedCaseId);
      const nextId = selectedId || requested?.id || nextCases[0]?.id || '';
      setSelectedId(nextId);
      if (requested?.id) {
        setCaseQuery(requested.id);
        setFamilyFilter('all');
        setGroupFilter('all');
      }
    } catch (error) {
      setLoadError(String(error.message || error));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadCases();
  }, []);

  useEffect(() => {
    if (!requestedCaseId || cases.length === 0) return;
    const requested = cases.find((item) => item.id === requestedCaseId);
    if (!requested) {
      setStatus(`El caso ${requestedCaseId} no esta en el banco editable.`);
      return;
    }
    setSelectedId(requested.id);
    setCaseQuery(requested.id);
    setFamilyFilter('all');
    setGroupFilter('all');
  }, [requestedCaseId, cases]);

  useEffect(() => {
    if (!selected) {
      setDraft(null);
      return;
    }
    setDraft({
      family: selected.family || inferCaseFamily(selected),
      group: selected.group || '',
      intent: selected.intent || '',
      variant: selected.variant || '',
      prompt: selected.prompt || '',
      decision: selected.expected?.decision || '',
      tool_budget: selected.expected?.tool_budget || '',
      safety: selected.expected?.safety || '',
      format: selected.expected?.format || '',
      equivalence_key: selected.expected?.equivalence_key || '',
      answer_shape: selected.expected?.answer_shape || '',
      acceptance_criteria: lines(selected.expected?.acceptance_criteria),
      must_mention: lines(selected.expected?.must_mention),
      must_mention_any: optionLines(selected.expected?.must_mention_any),
      must_not_mention: lines(selected.expected?.must_not_mention),
    });
  }, [selected]);

  async function saveDraft() {
    if (!selectedId || !draft) return;
    setStatus('');
    setIsSaving(true);
    try {
      const response = await fetch('/api/chat-consistency/prompts', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: selectedId,
          family: draft.family,
          group: draft.group,
          intent: draft.intent,
          variant: draft.variant,
          prompt: draft.prompt,
          expected: {
            decision: draft.decision,
            tool_budget: draft.tool_budget,
            safety: draft.safety,
            format: draft.format,
            equivalence_key: draft.equivalence_key,
            answer_shape: draft.answer_shape,
            acceptance_criteria: draft.acceptance_criteria,
            must_mention: draft.must_mention,
            must_mention_any: draft.must_mention_any,
            must_not_mention: draft.must_not_mention,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setCases((current) => current.map((item) => (item.id === selectedId ? payload.case : item)));
      setStatus(`Guardado. Backup: ${payload.backup}`);
    } catch (error) {
      setStatus(String(error.message || error));
    } finally {
      setIsSaving(false);
    }
  }

  async function createCase() {
    if (!newCase.id.trim() || !newCase.prompt.trim()) {
      setStatus('Nuevo caso requiere id y prompt.');
      return;
    }
    setStatus('');
    setIsCreating(true);
    try {
      const response = await fetch('/api/chat-consistency/prompts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...newCase,
          expected: {
            decision: '',
            tool_budget: '',
            safety: '',
            format: '',
            equivalence_key: '',
            answer_shape: '',
            acceptance_criteria: [],
            must_mention: [],
            must_mention_any: [],
            must_not_mention: [],
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setCases((current) => [...current, payload.case]);
      setSelectedId(payload.case.id);
      setCaseQuery('');
      setFamilyFilter('all');
      setGroupFilter('all');
      setNewCase({ id: '', family: 'consistency', group: '', intent: '', variant: '', prompt: '' });
      setStatus(`Caso creado. Backup: ${payload.backup}`);
    } catch (error) {
      setStatus(String(error.message || error));
    } finally {
      setIsCreating(false);
    }
  }

  async function duplicateCase() {
    if (!selected || !draft) {
      setStatus('Selecciona un caso para duplicar.');
      return;
    }

    const proposedId = `${selected.id}-COPY`;
    const duplicateId = window.prompt('ID para el duplicado:', proposedId);
    if (!duplicateId) return;

    setStatus('');
    setIsCreating(true);
    try {
      const response = await fetch('/api/chat-consistency/prompts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: duplicateId,
          family: draft.family || selected.family || inferCaseFamily(selected),
          group: selected.group,
          intent: selected.intent,
          variant: selected.variant,
          prompt: selected.prompt,
          expected: {
            decision: draft.decision,
            tool_budget: draft.tool_budget,
            safety: draft.safety,
            format: draft.format,
            equivalence_key: draft.equivalence_key,
            answer_shape: draft.answer_shape,
            acceptance_criteria: draft.acceptance_criteria,
            must_mention: draft.must_mention,
            must_mention_any: draft.must_mention_any,
            must_not_mention: draft.must_not_mention,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setCases((current) => [...current, payload.case]);
      setSelectedId(payload.case.id);
      setStatus(`Caso duplicado. Backup: ${payload.backup}`);
    } catch (error) {
      setStatus(String(error.message || error));
    } finally {
      setIsCreating(false);
    }
  }

  async function deleteCase() {
    if (!selectedId) return;
    const confirmed = window.confirm(`Eliminar caso ${selectedId}?`);
    if (!confirmed) return;

    setStatus('');
    setIsSaving(true);
    try {
      const response = await fetch('/api/chat-consistency/prompts', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selectedId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

      setCases((current) => {
        const next = current.filter((item) => item.id !== selectedId);
        const nextId = next[0]?.id || '';
        setSelectedId(nextId);
        return next;
      });
      setStatus(`Caso eliminado. Backup: ${payload.backup}`);
    } catch (error) {
      setStatus(String(error.message || error));
    } finally {
      setIsSaving(false);
    }
  }

  if (!draft) {
    if (isLoading) {
      return <p className="editor-note">Cargando editor de tools...</p>;
    }

    return (
      <div className="tool-policy-editor">
        <p className="editor-status">{loadError || 'No hay casos disponibles para editar.'}</p>
        <button type="button" className="secondary-action" onClick={loadCases}>
          Reintentar carga
        </button>

        <details className="panel-subsection" open>
          <summary>Agregar caso al catálogo de chat</summary>
          <div className="editor-create-grid">
            <label className="editor-field">
              <span>ID</span>
              <input value={newCase.id} onChange={(event) => setNewCase((current) => ({ ...current, id: event.target.value }))} placeholder="SEM-NEW-001" />
            </label>
            <label className="editor-field">
              <span>Familia</span>
              <select value={newCase.family} onChange={(event) => setNewCase((current) => ({ ...current, family: event.target.value }))}>
                <option value="consistency">consistencia</option>
                <option value="jailbreak">jailbreak</option>
                <option value="adversarial">adversarial</option>
              </select>
            </label>
            <label className="editor-field">
              <span>Grupo</span>
              <input value={newCase.group} onChange={(event) => setNewCase((current) => ({ ...current, group: event.target.value }))} placeholder="ej: prompt-injection" />
            </label>
            <label className="editor-field">
              <span>Intent</span>
              <input value={newCase.intent} onChange={(event) => setNewCase((current) => ({ ...current, intent: event.target.value }))} placeholder="ej: tool_coercion" />
            </label>
            <label className="editor-field">
              <span>Variante</span>
              <input value={newCase.variant} onChange={(event) => setNewCase((current) => ({ ...current, variant: event.target.value }))} placeholder="ej: spanish" />
            </label>
          </div>
          <label className="editor-field">
            <span>Prompt</span>
            <textarea
              rows="3"
              value={newCase.prompt}
              onChange={(event) => setNewCase((current) => ({ ...current, prompt: event.target.value }))}
              placeholder="Texto del prompt a evaluar"
            />
          </label>
          <button type="button" className="secondary-action" disabled={isCreating} onClick={createCase}>
            {isCreating ? 'Creando' : 'Agregar al catálogo'}
          </button>
        </details>
      </div>
    );
  }

  return (
    <div className="tool-policy-editor">
      <label className="editor-field">
        <span>Caso</span>
        <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
          {selectableCases.map((item) => (
            <option value={item.id} key={item.id}>
              {item.id} · {item.group}
            </option>
          ))}
        </select>
      </label>

      <div className="editor-create-grid">
        <label className="editor-field">
          <span>Filtrar familia</span>
          <select value={familyFilter} onChange={(event) => setFamilyFilter(event.target.value)}>
            {families.map((family) => <option value={family} key={family}>{family === 'all' ? 'Todas' : familyLabel(family)}</option>)}
          </select>
        </label>
        <label className="editor-field">
          <span>Filtrar grupo</span>
          <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
            {groups.map((group) => <option value={group} key={group}>{group === 'all' ? 'Todos' : group}</option>)}
          </select>
        </label>
        <label className="editor-field">
          <span>Buscar caso</span>
          <input
            value={caseQuery}
            onChange={(event) => setCaseQuery(event.target.value)}
            placeholder="ID, grupo, intención o prompt"
          />
        </label>
      </div>

      {filteredCases.length === 0 && <p className="editor-status">No hay casos para esos filtros.</p>}

      <p className="editor-note">Edita el caso, el prompt y los criterios que usa la corrida para decidir si pasa o falla.</p>

      <div className="editor-create-grid">
        <label className="editor-field">
          <span>Familia</span>
          <select
            value={draft.family}
            onChange={(event) => setDraft((current) => ({ ...current, family: event.target.value }))}
          >
            <option value="consistency">consistencia</option>
            <option value="jailbreak">jailbreak</option>
            <option value="adversarial">adversarial</option>
          </select>
        </label>
        <label className="editor-field">
          <span>Grupo</span>
          <input
            value={draft.group}
            onChange={(event) => setDraft((current) => ({ ...current, group: event.target.value }))}
            placeholder="inventory-asset-owner"
          />
        </label>
        <label className="editor-field">
          <span>Intención</span>
          <input
            value={draft.intent}
            onChange={(event) => setDraft((current) => ({ ...current, intent: event.target.value }))}
            placeholder="specific_asset_owner"
          />
        </label>
        <label className="editor-field">
          <span>Variante</span>
          <input
            value={draft.variant}
            onChange={(event) => setDraft((current) => ({ ...current, variant: event.target.value }))}
            placeholder="canonical"
          />
        </label>
        <label className="editor-field">
          <span>Forma de respuesta</span>
          <select
            value={draft.answer_shape}
            onChange={(event) => setDraft((current) => ({ ...current, answer_shape: event.target.value }))}
          >
            <option value="">sin regla</option>
            <option value="count">conteo concreto</option>
            <option value="expired_warranty_count">conteo garantia vencida</option>
            <option value="percentage">porcentaje concreto</option>
            <option value="list">lista concreta</option>
          </select>
        </label>
      </div>

      <label className="editor-field">
        <span>Prompt enviado</span>
        <textarea
          rows="4"
          value={draft.prompt}
          onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
          placeholder="Pregunta exacta que se enviara al asistente"
        />
      </label>

      <div className="panel-subsection">
        <h3>Criterios de aceptación editables</h3>
      </div>

      <label className="editor-field">
        <span>Decisión esperada</span>
        <input
          value={draft.decision}
          onChange={(event) => setDraft((current) => ({ ...current, decision: event.target.value }))}
          placeholder="Ej: answer | refuse | warn_or_refuse"
        />
      </label>

      <label className="editor-field">
        <span>Regla de tools</span>
        <textarea
          rows="3"
          value={draft.tool_budget}
          onChange={(event) => setDraft((current) => ({ ...current, tool_budget: event.target.value }))}
          placeholder="Ej: must not call web_search; no tool preferred; search_kedb acceptable"
        />
      </label>

      <label className="editor-field">
        <span>Seguridad</span>
        <textarea
          rows="2"
          value={draft.safety}
          onChange={(event) => setDraft((current) => ({ ...current, safety: event.target.value }))}
        />
      </label>

      <label className="editor-field">
        <span>Criterios de aceptación</span>
        <textarea
          rows="3"
          value={draft.acceptance_criteria}
          onChange={(event) => setDraft((current) => ({ ...current, acceptance_criteria: event.target.value }))}
          placeholder="Un criterio por línea"
        />
      </label>

      <label className="editor-field">
        <span>Clave de equivalencia</span>
        <input
          value={draft.equivalence_key}
          onChange={(event) => setDraft((current) => ({ ...current, equivalence_key: event.target.value }))}
          placeholder="inventory-owner-lap-mkt-0042"
        />
      </label>

      <label className="editor-field">
        <span>Debe mencionar</span>
        <textarea
          rows="3"
          value={draft.must_mention}
          onChange={(event) => setDraft((current) => ({ ...current, must_mention: event.target.value }))}
          placeholder="Una frase por línea"
        />
      </label>

      <label className="editor-field">
        <span>Debe mencionar una opción</span>
        <textarea
          rows="3"
          value={draft.must_mention_any}
          onChange={(event) => setDraft((current) => ({ ...current, must_mention_any: event.target.value }))}
          placeholder="Una línea por grupo de alternativas. Usa | para separar opciones: no existe | no registrado | no encontrado"
        />
      </label>

      <label className="editor-field">
        <span>No debe mencionar</span>
        <textarea
          rows="2"
          value={draft.must_not_mention}
          onChange={(event) => setDraft((current) => ({ ...current, must_not_mention: event.target.value }))}
          placeholder="Una frase por línea"
        />
      </label>

      <label className="editor-field">
        <span>Formato esperado</span>
        <input
          value={draft.format}
          onChange={(event) => setDraft((current) => ({ ...current, format: event.target.value }))}
          placeholder="Ej: concise | json-only | table"
        />
      </label>

      <button type="button" className="secondary-action" disabled={isSaving} onClick={saveDraft}>
        {isSaving ? 'Guardando' : 'Guardar política'}
      </button>

      <div className="editor-actions">
        <button type="button" className="secondary-action" disabled={isCreating || isSaving} onClick={duplicateCase}>
          {isCreating ? 'Duplicando' : 'Duplicar caso'}
        </button>
        <button type="button" className="danger-action" disabled={isCreating || isSaving || !selectedId} onClick={deleteCase}>
          Eliminar caso
        </button>
      </div>

      <details className="panel-subsection" open>
        <summary>Agregar caso al catálogo de chat</summary>
        <div className="editor-create-grid">
          <label className="editor-field">
            <span>ID</span>
            <input value={newCase.id} onChange={(event) => setNewCase((current) => ({ ...current, id: event.target.value }))} placeholder="SEM-NEW-001" />
          </label>
          <label className="editor-field">
            <span>Familia</span>
            <select value={newCase.family} onChange={(event) => setNewCase((current) => ({ ...current, family: event.target.value }))}>
              <option value="consistency">consistencia</option>
              <option value="jailbreak">jailbreak</option>
              <option value="adversarial">adversarial</option>
            </select>
          </label>
          <label className="editor-field">
            <span>Grupo</span>
            <input value={newCase.group} onChange={(event) => setNewCase((current) => ({ ...current, group: event.target.value }))} placeholder="ej: prompt-injection" />
          </label>
          <label className="editor-field">
            <span>Intent</span>
            <input value={newCase.intent} onChange={(event) => setNewCase((current) => ({ ...current, intent: event.target.value }))} placeholder="ej: tool_coercion" />
          </label>
          <label className="editor-field">
            <span>Variante</span>
            <input value={newCase.variant} onChange={(event) => setNewCase((current) => ({ ...current, variant: event.target.value }))} placeholder="ej: spanish" />
          </label>
        </div>
        <label className="editor-field">
          <span>Prompt</span>
          <textarea
            rows="3"
            value={newCase.prompt}
            onChange={(event) => setNewCase((current) => ({ ...current, prompt: event.target.value }))}
            placeholder="Texto del prompt a evaluar"
          />
        </label>
        <button type="button" className="secondary-action" disabled={isCreating} onClick={createCase}>
          {isCreating ? 'Creando' : 'Agregar al catálogo'}
        </button>
      </details>

      {status && <p className="editor-status">{status}</p>}
    </div>
  );
}
