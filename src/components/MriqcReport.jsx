/**
 * MriqcReport — custom in-browser quality dashboard
 *
 * Renders a rich visual summary from the per-subject JSON metrics that MRIQC
 * writes to  sub-XX/ses-XX/anat/sub-XX_T1w.json  (and BOLD equivalents).
 * Also renders the MRIQC HTML visual reports in a proper iframe using a
 * blob URL so Bootstrap / jQuery load correctly from CDN.
 */

import { useState, useEffect } from 'react'
import s from './MriqcReport.module.css'

// ── Metric definitions ────────────────────────────────────────────────────────
// dir: +1 = higher is better,  -1 = lower is better
// thresholds: [good, moderate]  (value at which quality transitions)
// range: [min, max] used for the visual bar only

const ANAT_DEFS = [
  { key: 'cnr',       label: 'CNR',    desc: 'Contrast-to-Noise Ratio',       dir: +1, th: [2.5, 1.5],   range: [0, 6],   unit: '',   tip: 'GM–WM contrast relative to noise. >2.5 good.' },
  { key: 'snr_total', label: 'SNR',    desc: 'Signal-to-Noise Ratio',          dir: +1, th: [15,  8],     range: [0, 30],  unit: '',   tip: 'Overall signal vs background noise. >15 good.' },
  { key: 'cjv',       label: 'CJV',    desc: 'Coefficient of Joint Variation', dir: -1, th: [0.5, 0.7],   range: [0, 1.5], unit: '',   tip: 'Intensity variance in GM+WM. <0.5 good.' },
  { key: 'efc',       label: 'EFC',    desc: 'Entropy Focus Criterion',        dir: -1, th: [0.5, 0.7],   range: [0, 1],   unit: '',   tip: 'Shannon entropy proxy for ghosting. <0.5 good.' },
  { key: 'fber',      label: 'FBER',   desc: 'Foreground/Background Energy',   dir: +1, th: [100, 30],    range: [0, 300], unit: '',   tip: 'Brain-to-background energy ratio. >100 good. -1 = N/A.' },
  { key: 'inu_med',   label: 'INU',    desc: 'Intensity Non-Uniformity',       dir: -1, th: [0.05, 0.15], range: [0, 0.4], unit: '',   tip: 'Bias-field median. <0.05 good.' },
  { key: 'fwhm_avg',  label: 'FWHM',   desc: 'Spatial Blurring (avg)',         dir: -1, th: [2.5, 4.0],   range: [0, 8],   unit: 'mm', tip: 'Average full-width at half-maximum. <2.5 mm good.' },
  { key: 'wm2max',    label: 'WM2Max', desc: 'White Matter / Max Ratio',       dir: -1, th: [0.4, 0.6],   range: [0, 1],   unit: '',   tip: 'WM mean vs global max. <0.4 good.' },
]

const BOLD_DEFS = [
  { key: 'tsnr',     label: 'tSNR',  desc: 'Temporal SNR',                 dir: +1, th: [40, 20],    range: [0, 100], unit: '',   tip: 'Temporal signal-to-noise. >40 good for fMRI.' },
  { key: 'snr',      label: 'SNR',   desc: 'Signal-to-Noise Ratio',        dir: +1, th: [10, 5],     range: [0, 25],  unit: '',   tip: 'Overall signal-to-noise. >10 good.' },
  { key: 'efc',      label: 'EFC',   desc: 'Entropy Focus Criterion',      dir: -1, th: [0.5, 0.7],  range: [0, 1],   unit: '',   tip: 'Shannon entropy proxy for ghosting. <0.5 good.' },
  { key: 'fd_mean',  label: 'FD',    desc: 'Mean Framewise Displacement',  dir: -1, th: [0.2, 0.5],  range: [0, 2],   unit: 'mm', tip: 'Mean head motion. <0.2 mm good.' },
  { key: 'fwhm_avg', label: 'FWHM',  desc: 'Spatial Blurring (avg)',       dir: -1, th: [2.5, 4.0],  range: [0, 8],   unit: 'mm', tip: 'Average FWHM. <2.5 mm good.' },
  { key: 'aor',      label: 'AOR',   desc: 'AFNI Outlier Ratio',           dir: -1, th: [0.05, 0.1], range: [0, 0.3], unit: '',   tip: 'Fraction of timepoints with outlier signal. <0.05 good.' },
  { key: 'dvars_std',label: 'DVARS', desc: 'Std DVARS',                    dir: -1, th: [1.0, 1.5],  range: [0, 3],   unit: '',   tip: 'Std DVARS — signal intensity changes. <1 good.' },
  { key: 'gsr_x',    label: 'GSR-x', desc: 'Ghost-to-Signal Ratio x',     dir: -1, th: [0.01, 0.05],range: [0, 0.2], unit: '',   tip: 'Ghosting in x direction. <0.01 good.' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function isNA(v) { return v == null || v === -1 || isNaN(Number(v)) }

function qualityLevel(val, def) {
  if (isNA(val)) return 'na'
  const v = Number(val)
  const [good, mod] = def.th
  return def.dir === 1
    ? (v >= good ? 'good' : v >= mod ? 'moderate' : 'poor')
    : (v <= good ? 'good' : v <= mod ? 'moderate' : 'poor')
}

// Returns 0-100% for the visual fill bar (always: full = best quality)
function barPct(val, def) {
  if (isNA(val)) return 0
  const v = Number(val)
  const [rMin, rMax] = def.range
  const frac = Math.min(1, Math.max(0, (v - rMin) / (rMax - rMin)))
  return def.dir === 1 ? frac * 100 : (1 - frac) * 100
}

const Q_COLOR  = { good: 'var(--green)', moderate: 'var(--amber)', poor: 'var(--red)', na: 'var(--text-3)' }
const Q_LABEL  = { good: 'Good', moderate: 'Fair', poor: 'Poor', na: 'N/A' }

// ── MetricCard ────────────────────────────────────────────────────────────────

function MetricCard({ def, value }) {
  const q    = qualityLevel(value, def)
  const pct  = barPct(value, def)
  const na   = isNA(value)
  const disp = na ? '—'
    : `${Number(value).toFixed(2)}${def.unit ? ' ' + def.unit : ''}`

  return (
    <div className={s.metricCard} title={def.tip}>
      <div className={s.mcTop}>
        <span className={s.mcLabel}>{def.label}</span>
        <span className={s.mcVal} style={{ color: Q_COLOR[q] }}>{disp}</span>
      </div>
      <div className={s.mcTrack}>
        <div className={s.mcFill} style={{ width: `${pct}%`, background: Q_COLOR[q] }} />
      </div>
      <div className={s.mcDesc}>{def.desc}</div>
      <div className={s.mcQ} style={{ color: Q_COLOR[q] }}>
        <span className={s.mcDot} style={{ background: Q_COLOR[q] }} />
        {Q_LABEL[q]}
      </div>
    </div>
  )
}

// ── HBar (horizontal bar row used in charts) ──────────────────────────────────

function HBar({ label, value, pct, color, decimals = 1, unit = '' }) {
  return (
    <div className={s.hBar}>
      <span className={s.hBarLabel}>{label}</span>
      <div className={s.hBarTrack}>
        <div className={s.hBarFill} style={{ width: `${Math.min(100, pct)}%`, background: color }} />
      </div>
      <span className={s.hBarVal}>
        {typeof value === 'number' ? value.toFixed(decimals) : value}{unit}
      </span>
    </div>
  )
}

// ── SectionTitle ──────────────────────────────────────────────────────────────

function SectionTitle({ icon, children }) {
  return (
    <div className={s.sectionTitle}>
      {icon}
      {children}
    </div>
  )
}

// ── HTML report iframe using blob URL so Bootstrap/jQuery load from CDN ───────

function HtmlFrame({ content, title }) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    const blob = new Blob([content], { type: 'text/html;charset=utf-8' })
    const u    = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [content])

  return (
    <iframe
      className={s.htmlFrame}
      src={url ?? 'about:blank'}
      title={title}
      // allow-popups lets Bootstrap dropdowns & tooltips work
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    />
  )
}

// ── Main exported component ───────────────────────────────────────────────────

export default function MriqcReport({ jsonMetrics, htmlFiles }) {
  const [subjectIdx, setSubjectIdx]   = useState(0)
  const [openHtml,   setOpenHtml]     = useState(null)

  // Auto-open first HTML report
  useEffect(() => {
    if (htmlFiles?.length > 0) setOpenHtml(htmlFiles[0].path)
  }, [htmlFiles])

  const subject  = jsonMetrics?.[subjectIdx]
  const m        = subject?.metrics ?? {}
  const meta     = m.bids_meta ?? {}

  // Detect modality from available keys
  const isBold   = m.tsnr !== undefined
  const defs     = isBold ? BOLD_DEFS : ANAT_DEFS
  const modLabel = meta.modality ?? (isBold ? 'BOLD' : 'T1w')

  // Field strength in Tesla (stored as 10000× in some DICOM exports)
  const rawField  = Number(meta.MagneticFieldStrength)
  const fieldT    = !isNaN(rawField) && rawField > 0
    ? (rawField > 100 ? rawField / 10000 : rawField).toFixed(1) + ' T'
    : null

  // Scanner label
  const scanner = [meta.Manufacturer, meta.ManufacturersModelName].filter(Boolean).join(' ')

  // Subject / session
  const subId = meta.subject_id ?? subject?.path?.split('/')[0]?.replace('sub-', '') ?? '?'
  const sesId = meta.session_id ?? ''

  // Warnings from provenance
  const warnings = Object.entries(m.provenance?.warnings ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))

  // Tissue fractions (anat)
  const tissues = [
    { label: 'CSF', key: 'icvs_csf', color: 'var(--blue)' },
    { label: 'GM',  key: 'icvs_gm',  color: 'var(--purple)' },
    { label: 'WM',  key: 'icvs_wm',  color: 'var(--teal)' },
  ]
  const maxTissue = Math.max(...tissues.map(t => m[t.key] ?? 0), 0.01)

  // SNR by tissue (anat)
  const snrTissues = [
    { label: 'CSF', key: 'snr_csf', color: 'var(--blue)' },
    { label: 'GM',  key: 'snr_gm',  color: 'var(--purple)' },
    { label: 'WM',  key: 'snr_wm',  color: 'var(--teal)' },
  ]
  const maxSnr = Math.max(...snrTissues.map(t => m[t.key] ?? 0), 0.01)

  // Acquisition parameter rows
  const acqRows = [
    { label: 'Matrix',          value: m.size_x && m.size_y ? `${m.size_x} × ${m.size_y}` : null },
    { label: 'Slices',          value: m.size_z ?? null },
    { label: 'Voxel (x/y)',     value: m.spacing_x && m.spacing_y ? `${m.spacing_x.toFixed(3)} × ${m.spacing_y.toFixed(3)} mm` : null },
    { label: 'Slice thickness', value: meta.SliceThickness != null ? `${meta.SliceThickness} mm` : null },
    { label: 'Slice gap',       value: meta.SpacingBetweenSlices != null ? `${meta.SpacingBetweenSlices} mm` : null },
    { label: 'TR',              value: meta.RepetitionTime != null ? `${(meta.RepetitionTime * 1000).toFixed(0)} ms` : null },
    { label: 'TE',              value: meta.EchoTime != null ? `${(meta.EchoTime * 1000).toFixed(1)} ms` : null },
    { label: 'Flip angle',      value: meta.FlipAngle != null ? `${meta.FlipAngle}°` : null },
    { label: 'Field strength',  value: fieldT },
    { label: 'Sequence',        value: meta.ScanningSequence ?? null },
    { label: 'Protocol',        value: meta.ProtocolName ?? meta.SeriesDescription ?? null },
    { label: 'SAR',             value: meta.SAR != null ? meta.SAR.toFixed(2) : null },
  ].filter(r => r.value != null)

  if (!subject && (!htmlFiles || htmlFiles.length === 0)) return null

  return (
    <div className={s.dash}>

      {/* ── Subject selector (when > 1 subject) ─────────────────────────── */}
      {jsonMetrics && jsonMetrics.length > 1 && (
        <div className={s.subjectPicker}>
          {jsonMetrics.map((j, i) => {
            const name = j.path.split('/').pop().replace('.json', '')
            return (
              <button key={i}
                className={`${s.subBtn} ${i === subjectIdx ? s.subBtnActive : ''}`}
                onClick={() => setSubjectIdx(i)}>
                {name}
              </button>
            )
          })}
        </div>
      )}

      {subject && (
        <>
          {/* ── Header ─────────────────────────────────────────────────── */}
          <div className={s.dashHead}>
            <div className={s.dashLeft}>
              <span className={s.subjectLabel}>sub-{subId}</span>
              {sesId && <span className={s.badge}>{sesId}</span>}
              <span className={s.badge} style={{ color: 'var(--teal)', background: 'var(--teal-dim)' }}>{modLabel}</span>
            </div>
            <div className={s.dashRight}>
              {scanner && <span className={s.scannerName}>{scanner}</span>}
              {fieldT  && <span className={s.fieldBadge}>{fieldT}</span>}
              {m.provenance?.version && (
                <span className={s.mriqcVersion}>MRIQC v{m.provenance.version}</span>
              )}
            </div>
          </div>

          {/* ── Warnings ───────────────────────────────────────────────── */}
          {warnings.length > 0 && (
            <div className={s.warnRow}>
              {warnings.map((w, i) => (
                <div key={i} className={s.warnChip}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                  {w}
                </div>
              ))}
            </div>
          )}

          {/* ── IQM metric cards ────────────────────────────────────────── */}
          <SectionTitle icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
          }>
            Image Quality Metrics
          </SectionTitle>
          <div className={s.metricsGrid}>
            {defs.map(def => (
              <MetricCard key={def.key} def={def} value={m[def.key]} />
            ))}
          </div>

          {/* ── Tissue composition + SNR charts (anat only) ─────────────── */}
          {!isBold && (m.icvs_gm != null || m.snr_gm != null) && (
            <>
              <SectionTitle icon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                </svg>
              }>
                Tissue Analysis
              </SectionTitle>
              <div className={s.chartsRow}>
                {m.icvs_gm != null && (
                  <div className={s.chartBox}>
                    <div className={s.chartTitle}>Volume Fractions (% ICV)</div>
                    {tissues.map(t => m[t.key] != null && (
                      <HBar key={t.key}
                        label={t.label}
                        value={(m[t.key]) * 100}
                        pct={(m[t.key] / maxTissue) * 100}
                        color={t.color}
                        decimals={1} unit="%" />
                    ))}
                    <div className={s.chartNote}>CSF / Grey Matter / White Matter as % of ICV</div>
                  </div>
                )}
                {m.snr_gm != null && (
                  <div className={s.chartBox}>
                    <div className={s.chartTitle}>SNR by Tissue</div>
                    {snrTissues.map(t => m[t.key] != null && (
                      <HBar key={t.key}
                        label={t.label}
                        value={m[t.key]}
                        pct={(m[t.key] / maxSnr) * 100}
                        color={t.color}
                        decimals={1} />
                    ))}
                    <div className={s.chartNote}>Signal-to-noise per tissue class</div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Acquisition parameters ──────────────────────────────────── */}
          {acqRows.length > 0 && (
            <>
              <SectionTitle icon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
                </svg>
              }>
                Acquisition Parameters
              </SectionTitle>
              <div className={s.acqGrid}>
                {acqRows.map(({ label, value }) => (
                  <div key={label} className={s.acqCell}>
                    <span className={s.acqLabel}>{label}</span>
                    <span className={s.acqValue}>{value}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* ── MRIQC HTML visual reports ────────────────────────────────────── */}
      {htmlFiles && htmlFiles.length > 0 && (
        <>
          <SectionTitle icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
            </svg>
          }>
            MRIQC Visual Reports
          </SectionTitle>
          <p className={s.htmlNote}>
            Full MRIQC report with brain slice mosaics, IQM plots, and the QC rating widget.
          </p>
          <div className={s.htmlList}>
            {htmlFiles.map(({ path, content }) => {
              const name  = path.split('/').pop()
              const open  = openHtml === path
              return (
                <div key={path} className={s.htmlItem}>
                  <button
                    className={`${s.htmlToggle} ${open ? s.htmlToggleOpen : ''}`}
                    onClick={() => setOpenHtml(open ? null : path)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                    </svg>
                    {name}
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      style={{ marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'none', transition: '0.2s' }}>
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>
                  {open && <HtmlFrame content={content} title={name} />}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
