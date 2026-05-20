import { useCallback, useState } from 'react'
import { RefreshCw, Play, FlaskConical, X } from 'lucide-react'
import { usePollingWhenVisible } from '../lib/usePollingWhenVisible'

const STATUS_COLORS = {
  success: 'var(--success)',
  running: 'var(--warning)',
  failed: 'var(--danger)',
  failed_critical: 'var(--danger)',
}

function fmtDuration(start, end) {
  if (!start) return '—'
  const a = new Date(start).getTime()
  const b = end ? new Date(end).getTime() : Date.now()
  const sec = Math.max(0, Math.floor((b - a) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR')
}

export default function KommoEventsRuns() {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [running, setRunning] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const fetchRuns = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/kommo-events/status')
      const data = await r.json()
      if (!r.ok) throw new Error(data?.error || 'falha ao carregar runs')
      setRuns(Array.isArray(data?.runs) ? data.runs : [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const triggerRun = useCallback(async () => {
    setRunning(true)
    try {
      const r = await fetch('/api/kommo-events/run-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const data = await r.json()
      if (!r.ok) throw new Error(data?.error || 'falha ao iniciar')
      setTimeout(fetchRuns, 1500)
    } catch (e) {
      alert('Falha ao iniciar: ' + e.message)
    } finally {
      setRunning(false)
    }
  }, [fetchRuns])

  const runTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await fetch('/api/kommo-events/test-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const data = await r.json()
      setTestResult({ httpStatus: r.status, ...data })
    } catch (e) {
      setTestResult({ ok: false, error: e.message })
    } finally {
      setTesting(false)
    }
  }, [])

  usePollingWhenVisible(fetchRuns, 60_000, true)

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1>Execuções Kommo</h1>
          <p className="muted">Auditoria diária de eventos do Kommo (D-1)</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={fetchRuns} disabled={loading}>
            <RefreshCw size={14} /> Atualizar
          </button>
          <button className="btn btn-secondary" onClick={runTest} disabled={testing}>
            <FlaskConical size={14} /> {testing ? 'Testando...' : 'Testar (1 página)'}
          </button>
          <button className="btn btn-primary" onClick={triggerRun} disabled={running}>
            <Play size={14} /> Executar agora (ontem)
          </button>
        </div>
      </div>

      {testResult && (
        <div className="card" style={{ marginBottom: 12, borderLeft: `3px solid ${testResult.ok ? 'var(--success)' : 'var(--danger)'}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>
                Resultado do teste {testResult.ok ? '✓' : '✗'}
              </div>
              {testResult.reference_date && (
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                  referência: {testResult.reference_date}
                </div>
              )}
            </div>
            <button
              className="btn-icon"
              onClick={() => setTestResult(null)}
              style={{ width: 28, height: 28 }}
              title="Fechar"
            >
              <X size={14} />
            </button>
          </div>

          {testResult.error && (
            <div style={{ color: 'var(--danger)', marginBottom: 8 }}>Erro: {testResult.error}</div>
          )}

          {testResult.kommo && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, marginBottom: 10 }}>
              <Metric label="Status HTTP Kommo" value={testResult.kommo.status ?? '—'} />
              <Metric label="Eventos retornados" value={testResult.kommo.total_events ?? 0} />
              <Metric label="Tempo (ms)" value={testResult.kommo.elapsed_ms ?? '—'} />
              <Metric label="Consultores no grupo" value={testResult.group?.size ?? 0} />
            </div>
          )}

          {testResult.kommo?.error && (
            <div style={{ padding: 10, background: 'rgba(255,80,80,0.1)', borderRadius: 8, color: 'var(--danger)', fontSize: 13, marginBottom: 10 }}>
              Erro Kommo: {testResult.kommo.error}
            </div>
          )}

          {testResult.group?.consultores && (
            <details style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
                Ver consultores testados ({testResult.group.consultores.length})
              </summary>
              <div style={{ marginTop: 6, fontSize: 12, fontFamily: 'monospace' }}>
                {testResult.group.consultores.map((c) => (
                  <div key={c.id}>{c.id} — {c.nome}</div>
                ))}
              </div>
            </details>
          )}

          {testResult.kommo?.events_sample?.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
                Ver amostra de eventos (até 5)
              </summary>
              <pre style={{
                marginTop: 6, padding: 10, background: 'var(--bg)', borderRadius: 8,
                fontSize: 11, maxHeight: 300, overflow: 'auto',
              }}>
{JSON.stringify(testResult.kommo.events_sample, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}

      {error && <div className="state-msg" style={{ color: 'var(--danger)' }}>Erro: {error}</div>}

      {runs.length === 0 && !loading && (
        <div className="card"><p className="muted">Nenhuma execução ainda.</p></div>
      )}

      {runs.map((run) => (
        <div className="card" key={run.id} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>
                #{run.id} — referência {run.reference_date}
              </div>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                {fmtDateTime(run.started_at)} → {fmtDateTime(run.finished_at)} ({fmtDuration(run.started_at, run.finished_at)})
              </div>
            </div>
            <span
              style={{
                background: STATUS_COLORS[run.status] || 'var(--muted)',
                color: '#fff', padding: '4px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
              }}
            >
              {run.status}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginTop: 12 }}>
            <Metric label="Grupos" value={run.total_groups} />
            <Metric label="Páginas" value={run.total_pages} />
            <Metric label="Recebidos" value={run.total_events_received} />
            <Metric label="Inseridos" value={run.total_events_inserted} />
          </div>

          {run.error_message && (
            <div style={{ marginTop: 10, padding: 10, background: 'rgba(255,80,80,0.1)', borderRadius: 8, color: 'var(--danger)', fontSize: 13 }}>
              {run.error_message}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function Metric({ label, value }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value ?? 0}</div>
    </div>
  )
}
