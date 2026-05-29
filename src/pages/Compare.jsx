import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  getMulticenterDatasets,
  removeMulticenterDataset,
  addMulticenterDataset,
  parseTSV,
  downloadCSV,
} from '../lib/api'
import s from './Compare.module.css'

// Metrics with display names and quality direction (higher/lower = better)
const METRIC_META = {
  cnr:      { label: 'CNR',      unit: '',    dir: 'high',  good: [2.5, Infinity], mod: [1.5, 2.5]  },
  snr:      { label: 'SNR',      unit: '',    dir: 'high',  good: [10,  Infinity], mod: [5,   10]   },
  snr_total:{ label: 'SNR Total',unit: '',    dir: 'high',  good: [10,  Infinity], mod: [5,   10]   },
  efc:      { label: 'EFC',      unit: '',    dir: 'low',   good: [0,   0.5],      mod: [0.5, 0.7]  },
  fber:     { label: 'FBER',     unit: '',    dir: 'high',  good: [100, Infinity], mod: [50,  100]  },
  wm2max:   { label: 'WM2MAX',   unit: '',    dir: 'low',   good: [0,   0.6],      mod: [0.6, 0.8]  },
  qi1:      { label: 'QI1',      unit: '',    dir: 'low',   good: [0,   0.002],    mod: [0.002,0.05]},
  fd_mean:  { label: 'FD Mean',  unit: 'mm',  dir: 'low',   good: [0,   0.2],      mod: [0.2, 0.5]  },
  tsnr:     { label: 'tSNR',     unit: '',    dir: 'high',  good: [40,  Infinity], mod: [20,  40]   },
  dvars_std:{ label: 'DVARS',    unit: '',    dir: 'low',   good: [0,   25],       mod: [25,  35]   },
  aor:      { label: 'AOR',      unit: '',    dir: 'low',   good: [0,   0.05],     mod: [0.05,0.1]  },
  aqi:      { label: 'AQI',      unit: '',    dir: 'low',   good: [0,   0.1],      mod: [0.1, 0.2]  },
}

function cellRating(key, val) {
  const meta = METRIC_META[key.toLowerCase().replace(/[^a-z_]/g, '')]
  if (!meta) return ''
  const n = parseFloat(val)
  if (isNaN(n)) return ''
  const [gMin, gMax] = meta.good
  const [mMin, mMax] = meta.mod
  if (n >= gMin && n <= gMax) return 'good'
  if (n >= mMin && n <= mMax) return 'mod'
  return 'bad'
}

function fmt(v) {
  const n = parseFloat(v)
  return isNaN(n) ? v : n.toFixed(4)
}

function computeStats(values) {
  const nums = values.map(parseFloat).filter((n) => !isNaN(n))
  if (!nums.length) return null
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  return {
    mean: mean.toFixed(4),
    min:  Math.min(...nums).toFixed(4),
    max:  Math.max(...nums).toFixed(4),
    sd:   nums.length > 1
      ? Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1)).toFixed(4)
      : '—',
  }
}

// ── Empty state ───────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <div className={s.empty}>
      <div className={s.emptyIcon}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
          <line x1="6" y1="20" x2="6" y2="14"/><path d="M2 20h20"/>
        </svg>
      </div>
      <h3>No datasets yet</h3>
      <p>Run MRIQC on a dataset and click <strong>Add to Multicenter Comparison</strong> on the results page to build your comparison library.</p>
      <Link to="/analyze" className="btn-primary" style={{ marginTop: '16px' }}>
        Analyze a Dataset
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </Link>
    </div>
  )
}

// ── Dataset card ──────────────────────────────────────────────────────────────
function DatasetCard({ ds, onRemove }) {
  const date = new Date(ds.addedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return (
    <div className={s.dsCard}>
      <div className={s.dsCardBadge}>{ds.modality}</div>
      <div className={s.dsCardInfo}>
        <span className={s.dsLabel}>{ds.label}</span>
        <span className={s.dsMeta}>
          sub-{ds.subjectId}{ds.sessionId ? ` · ses-${ds.sessionId}` : ''} · {ds.metrics.length} scans · {date}
        </span>
      </div>
      <button className={s.dsRemove} onClick={() => onRemove(ds.id)} title="Remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  )
}

// ── Upload panel ──────────────────────────────────────────────────────────────
function UploadPanel({ onAdd }) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [modality, setModality] = useState('T1w')
  const [files, setFiles] = useState([])
  const [error, setError] = useState('')

  function handleFiles(e) {
    const chosen = Array.from(e.target.files).filter((f) => f.name.endsWith('.tsv'))
    setFiles(chosen)
    if (chosen.length === 0) setError('Please select .tsv files')
    else setError('')
  }

  async function handleAdd() {
    if (!label.trim() || !subjectId.trim() || files.length === 0) {
      setError('Label, Subject ID, and at least one TSV file are required.')
      return
    }
    const tsvFiles = await Promise.all(files.map(async (f) => ({
      path: f.name,
      content: await f.text(),
    })))
    onAdd(label.trim(), subjectId.trim(), sessionId.trim(), modality, tsvFiles)
    setLabel(''); setSubjectId(''); setSessionId(''); setFiles([]); setError(''); setOpen(false)
  }

  return (
    <div className={s.uploadPanel}>
      <button className={s.uploadToggle} onClick={() => setOpen((v) => !v)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          {open ? <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></> : <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>}
        </svg>
        {open ? 'Cancel' : 'Add Dataset Manually'}
      </button>

      {open && (
        <div className={s.uploadForm}>
          {error && <p className={s.uploadError}>{error}</p>}
          <div className={s.uploadRow}>
            <div className={s.uploadField}>
              <label>Dataset Label *</label>
              <input placeholder="e.g. Site A — Scanner 1" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className={s.uploadField}>
              <label>Subject ID *</label>
              <input placeholder="e.g. 01" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} />
            </div>
          </div>
          <div className={s.uploadRow}>
            <div className={s.uploadField}>
              <label>Session ID</label>
              <input placeholder="optional" value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
            </div>
            <div className={s.uploadField}>
              <label>Modality</label>
              <select value={modality} onChange={(e) => setModality(e.target.value)}>
                {['T1w','T2w','bold','dwi','asl'].map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div className={s.uploadField}>
            <label>TSV Metrics File(s) *</label>
            <input type="file" accept=".tsv" multiple onChange={handleFiles} />
            {files.length > 0 && <span className={s.uploadFileHint}>{files.length} file(s) selected</span>}
          </div>
          <button className="btn-primary" style={{ marginTop: '4px', alignSelf: 'flex-start' }} onClick={handleAdd}>
            Add to Comparison
          </button>
        </div>
      )}
    </div>
  )
}

// ── Comparison table ──────────────────────────────────────────────────────────
function ComparisonTable({ datasets, filterModality }) {
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState('asc')
  const [showStats, setShowStats] = useState(true)

  const filtered = filterModality === 'all'
    ? datasets
    : datasets.filter((d) => d.modality === filterModality)

  // Gather all metric keys present across all datasets
  const allKeys = useMemo(() => {
    const keys = new Set()
    for (const ds of filtered) {
      for (const row of ds.metrics) {
        Object.keys(row).forEach((k) => keys.add(k))
      }
    }
    // Priority order: known metrics first
    const priority = Object.keys(METRIC_META)
    const rest = [...keys].filter((k) => !priority.includes(k.toLowerCase()))
    return [...priority.filter((k) => keys.has(k)), ...rest]
  }, [filtered])

  function getVal(ds, key) {
    if (!ds.metrics.length) return '—'
    return ds.metrics[0][key] ?? '—'
  }

  function handleSort(key) {
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function handleDownloadCSV() {
    const headers = ['Metric', ...filtered.map((d) => d.label)]
    const rows = allKeys.map((k) => [k, ...filtered.map((d) => getVal(d, k))])
    if (showStats) {
      rows.push(
        ['— MEAN —', ...allKeys.map(() => '').slice(0, 0), ''],
        ...allKeys.map((k) => {
          const stats = computeStats(filtered.map((d) => getVal(d, k)))
          return [`${k} (mean)`, ...(filtered.map((d) => getVal(d, k))), stats ? stats.mean : '—']
        }).slice(0, 0)
      )
    }
    const csv = [headers, ...rows].map((r) => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'mriqc_multicenter_comparison.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  if (filtered.length === 0) {
    return (
      <div className={s.noData}>
        {filterModality !== 'all'
          ? `No datasets for modality "${filterModality}". Try a different filter.`
          : 'No datasets to compare.'}
      </div>
    )
  }

  return (
    <div className={s.compTableWrap}>
      <div className={s.tableToolbar}>
        <span className={s.tableInfo}>{allKeys.length} metrics · {filtered.length} site{filtered.length !== 1 ? 's' : ''}</span>
        <div className={s.tableActions}>
          <label className={s.statsToggle}>
            <input type="checkbox" checked={showStats} onChange={(e) => setShowStats(e.target.checked)} />
            Show statistics
          </label>
          <button className={s.csvExport} onClick={handleDownloadCSV}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Export CSV
          </button>
        </div>
      </div>

      <div className={s.tableScroll}>
        <table className={s.compTable}>
          <thead>
            <tr>
              <th className={s.metricCol}>
                <button onClick={() => handleSort('_key')}>
                  Metric {sortKey === '_key' && (sortDir === 'asc' ? '↑' : '↓')}
                </button>
              </th>
              {filtered.map((ds) => (
                <th key={ds.id}>
                  <div className={s.colHeader}>
                    <span className={s.colLabel}>{ds.label}</span>
                    <span className={s.colBadge}>{ds.modality}</span>
                  </div>
                </th>
              ))}
              {showStats && (
                <>
                  <th className={s.statCol}>Mean</th>
                  <th className={s.statCol}>SD</th>
                  <th className={s.statCol}>Min</th>
                  <th className={s.statCol}>Max</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {allKeys.map((key) => {
              const values = filtered.map((d) => getVal(d, key))
              const stats = showStats ? computeStats(values) : null
              const meta = METRIC_META[key.toLowerCase()]
              return (
                <tr key={key}>
                  <td className={s.metricName}>
                    <div>
                      <span className={s.metricKey}>{meta ? meta.label : key}</span>
                      {meta && <span className={s.metricUnit}>{meta.unit ? ` (${meta.unit})` : ''}</span>}
                    </div>
                    {meta && (
                      <span className={`${s.dirBadge} ${meta.dir === 'high' ? s.dirHigh : s.dirLow}`}>
                        {meta.dir === 'high' ? 'higher ↑' : 'lower ↓'}
                      </span>
                    )}
                  </td>
                  {filtered.map((ds, i) => {
                    const v = values[i]
                    const rating = cellRating(key, v)
                    return (
                      <td key={ds.id} className={`${s.valCell} ${rating ? s[`cell_${rating}`] : ''}`}>
                        {fmt(v)}
                      </td>
                    )
                  })}
                  {showStats && stats && (
                    <>
                      <td className={s.statCell}>{stats.mean}</td>
                      <td className={s.statCell}>{stats.sd}</td>
                      <td className={s.statCell}>{stats.min}</td>
                      <td className={s.statCell}>{stats.max}</td>
                    </>
                  )}
                  {showStats && !stats && (
                    <td className={s.statCell} colSpan={4}>—</td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className={s.legend}>
        <span className={`${s.legendDot} ${s.legendGood}`} /> Good quality
        <span className={`${s.legendDot} ${s.legendMod}`} />  Moderate
        <span className={`${s.legendDot} ${s.legendBad}`} />  Poor quality
        <span className={s.legendNote}>Thresholds are literature-based estimates.</span>
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Compare() {
  const [datasets, setDatasets] = useState(() => getMulticenterDatasets())
  const [filterModality, setFilterModality] = useState('all')

  function handleRemove(id) {
    const updated = removeMulticenterDataset(id)
    setDatasets(updated)
  }

  function handleAdd(label, subjectId, sessionId, modality, tsvFiles) {
    const entry = addMulticenterDataset(label, subjectId, sessionId, modality, tsvFiles)
    setDatasets((prev) => [...prev, entry])
  }

  const modalities = ['all', ...new Set(datasets.map((d) => d.modality))]

  return (
    <div className={s.page}>
      {/* Header */}
      <div className={s.pageHeader}>
        <div className="container">
          <div className={s.headerBadge}>Multicenter Analysis</div>
          <h1 className={s.pageTitle}>
            Cross-Site <span className="gradient-text">IQM Comparison</span>
          </h1>
          <p className={s.pageDesc}>
            Compare image quality metrics across scanners, sites, and acquisition protocols.
            Datasets are stored locally in your browser.
          </p>
        </div>
      </div>

      <div className={`${s.pageBody} container`}>
        {datasets.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {/* Dataset management */}
            <section className={s.section}>
              <div className={s.sectionHeader}>
                <h2 className={s.sectionTitle}>
                  Datasets
                  <span className={s.count}>{datasets.length}</span>
                </h2>
                <UploadPanel onAdd={handleAdd} />
              </div>
              <div className={s.datasetList}>
                {datasets.map((ds) => (
                  <DatasetCard key={ds.id} ds={ds} onRemove={handleRemove} />
                ))}
              </div>
            </section>

            {/* Comparison */}
            <section className={s.section}>
              <div className={s.sectionHeader}>
                <h2 className={s.sectionTitle}>Comparison Table</h2>
                {modalities.length > 2 && (
                  <div className={s.modalityFilter}>
                    {modalities.map((m) => (
                      <button
                        key={m}
                        className={`${s.filterBtn} ${filterModality === m ? s.filterActive : ''}`}
                        onClick={() => setFilterModality(m)}
                      >
                        {m === 'all' ? 'All Modalities' : m}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <ComparisonTable datasets={datasets} filterModality={filterModality} />
            </section>
          </>
        )}

        {datasets.length > 0 && (
          <div className={s.bottomRow}>
            <UploadPanel onAdd={handleAdd} />
            <Link to="/analyze" className={s.analyzeLink}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              Analyze another dataset
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
