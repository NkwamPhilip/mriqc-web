import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { fetchMySubmissions, getToken } from '../lib/api'
import s from './MySubmissions.module.css'

const STATUS_META = {
  queued:   { label: 'Queued',     cls: 'queued'  },
  running:  { label: 'Processing', cls: 'running' },
  done:     { label: 'Complete',   cls: 'done'    },
  error:    { label: 'Failed',     cls: 'error'   },
  expired:  { label: 'Expired',    cls: 'expired' },
  unknown:  { label: 'Unknown',    cls: 'expired' },
}

function fmtDate(iso) {
  try {
    return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString([], {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

export default function MySubmissions() {
  const { user, loading: authLoading } = useAuth()
  const navigate = useNavigate()

  const [subs, setSubs]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  // Redirect guests to login
  useEffect(() => {
    if (!authLoading && !user) navigate('/login', { state: { from: '/submissions' } })
  }, [authLoading, user, navigate])

  const load = useCallback(async () => {
    try {
      const data = await fetchMySubmissions(getToken())
      setSubs(data.submissions || [])
      setError('')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!user) return
    load()
    // Auto-refresh while anything is still queued/processing
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [user, load])

  const anyActive = subs.some((x) => x.status === 'queued' || x.status === 'running')

  if (authLoading || !user) return null

  return (
    <div className={s.page}>
      <div className="container">
        {/* Header */}
        <div className={s.header}>
          <div>
            <h1 className={s.title}>My Submissions</h1>
            <p className={s.sub}>
              Signed in as <strong>{user.name || user.email}</strong>
              {user.institution ? ` · ${user.institution}` : ''}
            </p>
          </div>
          <div className={s.headerActions}>
            {anyActive && <span className={s.liveDot}>● live</span>}
            <button className={s.refreshBtn} onClick={load} title="Refresh">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
              Refresh
            </button>
            <Link to="/analyze" className={s.newBtn}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              New Analysis
            </Link>
          </div>
        </div>

        {error && <p className={s.error}>⚠️ {error}</p>}

        {/* List */}
        {loading ? (
          <p className={s.muted}>Loading your submissions…</p>
        ) : subs.length === 0 ? (
          <div className={s.empty}>
            <h3>No submissions yet</h3>
            <p>Runs you submit while signed in will appear here with live status.</p>
            <Link to="/analyze" className={s.newBtn}>Run your first analysis →</Link>
          </div>
        ) : (
          <div className={s.list}>
            {subs.map((sub) => {
              const meta = STATUS_META[sub.status] || STATUS_META.unknown
              return (
                <div key={sub.job_id} className={s.row}>
                  <div className={s.rowMain}>
                    <span className={s.rowLabel}>{sub.label || sub.job_id}</span>
                    <span className={s.rowMeta}>
                      <span className={s.kindBadge}>{sub.kind === 'dicom' ? 'DICOM→BIDS' : 'MRIQC'}</span>
                      job {sub.job_id} · {fmtDate(sub.created_at)}
                    </span>
                  </div>
                  <div className={`${s.status} ${s[meta.cls]}`}>
                    <span className={s.statusDot} />
                    {meta.label}
                    {sub.status === 'queued' && sub.queue_position != null && (
                      <span className={s.queuePos}>#{sub.queue_position}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <p className={s.note}>
          Results are downloaded when a run completes and are kept on the server only briefly.
          For long-term storage, download the results ZIP from the analysis page.
        </p>
      </div>
    </div>
  )
}
