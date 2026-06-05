import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  checkHealth,
  convertDicomLocally,
  runMRIQC,
  parseBidsZip,
  parseResultsZip,
  parseTSV,
  downloadCSV,
  addMulticenterDataset,
} from '../lib/api'
import MriqcReport from '../components/MriqcReport'
import BrainModel  from '../components/BrainModel'
import s from './Analyze.module.css'

const STEPS_DICOM = ['Setup', 'Convert', 'BIDS', 'MRIQC', 'Results']
const STEPS_BIDS  = ['Setup', 'MRIQC', 'Results']
const STEP_IDX_DICOM = { setup: 0, converting: 1, bids_ready: 2, processing: 3, results: 4 }
const STEP_IDX_BIDS  = { setup: 0, processing: 1, results: 2 }
const MODALITIES = [
  { id: 'T1w',  label: 'T1w',  desc: 'Anatomical' },
  { id: 'T2w',  label: 'T2w',  desc: 'Anatomical' },
  { id: 'bold', label: 'BOLD', desc: 'fMRI' },
  { id: 'dwi',  label: 'DWI',  desc: 'Diffusion' },
  { id: 'asl',  label: 'ASL',  desc: 'Perfusion' },
]
const CONV_MESSAGES = [
  'Extracting DICOM files…', 'Generating dcm2bids config…', 'Running dcm2niix…',
  'Classifying NIfTI files…', 'Organising BIDS structure…', 'Creating BIDS metadata…',
  'Validating output…', 'Packaging BIDS dataset…',
]
const MRIQC_MESSAGES = [
  'Uploading BIDS dataset...', 'Extracting BIDS structure...', 'Pulling MRIQC Docker image...',
  'Initialising MRIQC pipeline...', 'Running anatomical workflow...', 'Computing image quality metrics...',
  'Generating visual reports...', 'Packaging TSV outputs...', 'Compressing results...',
]

// ── Shared helpers ───────────────────────────────────────────────────────────
function fmtSize(b) {
  return b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`
}

function useInterval(cb, delay) {
  const ref = useRef(cb)
  useEffect(() => { ref.current = cb }, [cb])
  useEffect(() => {
    if (delay == null) return
    const id = setInterval(() => ref.current(), delay)
    return () => clearInterval(id)
  }, [delay])
}

// ── Server status banner ──────────────────────────────────────────────────────
// 'checking' | 'ok' | 'no-mriqc' | 'offline'
function ServerBanner({ status }) {
  if (status === 'checking' || status === 'ok') return null

  if (status === 'offline') return (
    <div className={s.serverBanner} data-kind="offline">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
      <div>
        <strong>Backend server not reachable.</strong>
        {' '}The analysis pipeline (DICOM→BIDS and MRIQC) runs on a Python/Docker server — it cannot run inside Vercel or any static hosting platform.{' '}
        <a href="/DEPLOY.md" target="_blank" rel="noopener noreferrer">See the deployment guide →</a>
      </div>
    </div>
  )

  if (status === 'no-mriqc') return (
    <div className={s.serverBanner} data-kind="warn">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <div>
        <strong>MRIQC is not installed on this server.</strong>
        {' '}DICOM → BIDS conversion will work, but the MRIQC analysis step will fail.
        {' '}MRIQC requires the <strong>Docker deployment</strong> on a machine with 16+ GB RAM.{' '}
        <a href="https://github.com/nipreps/mriqc" target="_blank" rel="noopener noreferrer">Learn more →</a>
      </div>
    </div>
  )

  return null
}

// ── Step indicator ───────────────────────────────────────────────────────────
function StepBar({ current, steps, stepIdx }) {
  const idx = stepIdx[current] ?? 0
  return (
    <div className={s.stepBar}>
      {steps.map((step, i) => (
        <div key={step} className={s.stepBarItem}>
          <div className={`${s.stepCircle} ${i < idx ? s.done : ''} ${i === idx ? s.active : ''}`}>
            {i < idx
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              : <span>{i + 1}</span>}
          </div>
          <span className={`${s.stepLabel} ${i === idx ? s.stepLabelActive : ''}`}>{step}</span>
          {i < steps.length - 1 && <div className={`${s.stepLine} ${i < idx ? s.stepLineDone : ''}`} />}
        </div>
      ))}
    </div>
  )
}

// ── Error banner ─────────────────────────────────────────────────────────────
function ErrorBanner({ message, onDismiss }) {
  return (
    <div className={s.errorBanner}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
      <span>{message}</span>
      <button className={s.errorClose} onClick={onDismiss}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  )
}

// ── STEP 1: Setup ─────────────────────────────────────────────────────────────
function SetupStep({ file, onFile, config, onChange, onNext, mode, onModeChange }) {
  const [drag, setDrag] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const inputRef = useRef()
  const isBids = mode === 'bids'

  function handleDrop(e) {
    e.preventDefault(); setDrag(false)
    const f = e.dataTransfer.files[0]
    if (f && f.name.endsWith('.zip')) onFile(f)
  }

  function handleModeSwitch(newMode) {
    onFile(null)   // clear the file when switching modes
    onModeChange(newMode)
  }

  return (
    <div className={s.stepContent}>
      {/* Mode toggle */}
      <div className={s.modeToggle}>
        <button
          className={`${s.modeBtn} ${!isBids ? s.modeBtnActive : ''}`}
          onClick={() => handleModeSwitch('dicom')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          DICOM Files
        </button>
        <button
          className={`${s.modeBtn} ${isBids ? s.modeBtnActive : ''}`}
          onClick={() => handleModeSwitch('bids')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          BIDS Dataset
        </button>
      </div>

      <div className={s.stepHeading}>
        <h2>Upload & Configure</h2>
        {isBids
          ? <p>Upload a ZIP of your BIDS-compliant dataset. It will be sent directly to MRIQC — no conversion needed.</p>
          : <p>Upload a ZIP of your DICOM folder. The server will run <code>dcm2bids</code> to convert to BIDS format, then send to MRIQC for quality assessment.</p>
        }
      </div>

      {/* Upload zone */}
      <div
        className={`${s.dropzone} ${drag ? s.dropzoneActive : ''} ${file ? s.dropzoneFilled : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={handleDrop}
        onClick={() => !file && inputRef.current.click()}
        role="button" tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && !file && inputRef.current.click()}
      >
        <input ref={inputRef} type="file" accept=".zip" onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} hidden />

        {file ? (
          <div className={s.filePreview}>
            <div className={s.fileIcon}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <div className={s.fileMeta}>
              <span className={s.fileName}>{file.name}</span>
              <span className={s.fileSize}>{fmtSize(file.size)} · {isBids ? 'BIDS ZIP' : 'DICOM ZIP'}</span>
            </div>
            <button className={s.fileRemove} onClick={(e) => { e.stopPropagation(); onFile(null) }} title="Remove">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        ) : (
          <div className={s.dropzoneEmpty}>
            <div className={s.dropzoneIconWrap}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
                <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
              </svg>
            </div>
            <p className={s.dropzoneText}>
              <strong>{isBids ? 'Drop your BIDS ZIP here' : 'Drop your DICOM ZIP here'}</strong>
              <br />or click to browse
            </p>
            <span className={s.dropzoneHint}>.zip files only</span>
          </div>
        )}
      </div>

      {/* Subject / Session */}
      <div className={s.configRow}>
        <div className={s.field}>
          <label className={s.label}>
            Subject ID {isBids ? <span className={s.optional}>(optional)</span> : <span className={s.required}>*</span>}
          </label>
          <input className={s.input} placeholder="e.g. 01"
            value={config.subjectId}
            onChange={(e) => onChange('subjectId', e.target.value.replace(/[^a-zA-Z0-9]/g, ''))} />
          <span className={s.hint}>
            {isBids
              ? 'Leave blank to process all subjects, or enter one to target a specific subject'
              : <>Alphanumeric only — must match folder <code>sub-{config.subjectId || 'XX'}</code></>
            }
          </span>
        </div>
        <div className={s.field}>
          <label className={s.label}>Session ID <span className={s.optional}>(optional)</span></label>
          <input className={s.input} placeholder="e.g. baseline"
            value={config.sessionId}
            onChange={(e) => onChange('sessionId', e.target.value)} />
          <span className={s.hint}>Leave blank if no session structure</span>
        </div>
      </div>

      {/* Modalities */}
      <div className={s.modalitySection}>
        <label className={s.label}>Select Modalities for MRIQC <span className={s.required}>*</span></label>
        <div className={s.modalityGrid}>
          {MODALITIES.map((m) => (
            <label key={m.id} className={`${s.modality} ${config.modalities.includes(m.id) ? s.modalityActive : ''}`}>
              <input type="checkbox" hidden
                checked={config.modalities.includes(m.id)}
                onChange={(e) => onChange('modalities', e.target.checked
                  ? [...config.modalities, m.id]
                  : config.modalities.filter((x) => x !== m.id))} />
              <span className={s.modalityName}>{m.label}</span>
              <span className={s.modalityDesc}>{m.desc}</span>
            </label>
          ))}
        </div>
        {config.modalities.length === 0 && <p className={s.warnText}>⚠ Select at least one modality</p>}
      </div>

      {/* Advanced */}
      <button className={s.advancedToggle} onClick={() => setAdvanced((v) => !v)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: advanced ? 'rotate(180deg)' : 'none', transition: '0.2s' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
        Advanced Options (CPU / Memory)
      </button>
      {advanced && (
        <div className={s.configRow}>
          <div className={s.field}>
            <label className={s.label}>CPU Cores</label>
            <div className={s.selectWrap}>
              <select className={s.select} value={config.nProcs} onChange={(e) => onChange('nProcs', Number(e.target.value))}>
                {[16, 24, 36, 48].map((n) => <option key={n} value={n}>{n} cores</option>)}
              </select>
            </div>
          </div>
          <div className={s.field}>
            <label className={s.label}>Memory (GB)</label>
            <div className={s.selectWrap}>
              <select className={s.select} value={config.memGb} onChange={(e) => onChange('memGb', Number(e.target.value))}>
                {[64, 96, 128, 160].map((n) => <option key={n} value={n}>{n} GB</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      <div className={s.navButtons}>
        <Link to="/" className="btn-outline">← Home</Link>
        <button className="btn-primary"
          disabled={!file || (!isBids && !config.subjectId) || config.modalities.length === 0}
          onClick={onNext}>
          {isBids ? 'Run MRIQC' : 'Run DICOM → BIDS Conversion'}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
      </div>
    </div>
  )
}

// ── STEP 2: Animated converting ───────────────────────────────────────────────
function ConvertingStep({ convPhase, progress, statusMsg, elapsed }) {
  const uploading = convPhase === 'uploading'
  return (
    <div className={s.stepContent}>
      <div className={s.centerPanel}>

        <div className={`${s.convPhaseBadge} ${uploading ? s.convPhaseUpload : s.convPhaseConvert}`}>
          {uploading ? '⬆ Uploading' : '⚙ Converting locally'}
        </div>

        <div className={s.convPipeline}>
          <div className={`${s.convBox} ${uploading ? s.convBoxActive : ''}`}>
            <div className={s.convBoxIcon}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <span>DICOM</span>
          </div>
          <div className={s.convArrow}>
            <div className={s.convDot} />
            <svg width="80" height="20" viewBox="0 0 80 20" fill="none">
              <line x1="0" y1="10" x2="72" y2="10" stroke="#00C8B4" strokeWidth="1.5" strokeDasharray="4,3"/>
              <polyline points="68,4 76,10 68,16" stroke="#00C8B4" strokeWidth="1.5" fill="none" strokeLinejoin="round" strokeLinecap="round"/>
            </svg>
          </div>
          <div className={`${s.convBox} ${!uploading ? s.convBoxActive : ''}`}>
            <div className={s.convBoxIcon}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
            </div>
            <span>BIDS</span>
          </div>
        </div>

        <div className={s.convLabel}>
          {uploading ? 'Sending data to local converter…' : 'Running dcm2bids on your machine…'}
        </div>

        <div className={s.processingInfo}>
          <div className={s.processingStatus}>{statusMsg}</div>
          <div className={s.progressBar}>
            <div className={s.progressFill} style={{ width: `${progress}%` }} />
          </div>
          <div className={s.progressMeta}>
            <span className={s.progressPct}>{Math.round(progress)}%</span>
            <span className={s.elapsed}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              {elapsed}
            </span>
          </div>
        </div>

        <p className={s.convNote}>
          {uploading
            ? 'Data is sent to your local Python server — nothing leaves your machine.'
            : <>Running <strong>dcm2niix</strong> + <strong>dcm2bids</strong> locally. Typically 1–5 minutes per dataset.</>}
        </p>
      </div>
    </div>
  )
}

// ── STEP 3: BIDS Ready ────────────────────────────────────────────────────────
function BidsReadyStep({ bidsBlob, bidsFiles, config, onDownload, onContinue, onBack }) {
  const logLines = (bidsFiles.log || '').split('\n').filter(Boolean)

  function classifyFile(p) {
    if (p.endsWith('.nii.gz') || p.endsWith('.nii')) return 'nifti'
    if (p.endsWith('.json')) return 'json'
    if (p.endsWith('.tsv')) return 'tsv'
    if (p.endsWith('.txt')) return 'log'
    return 'other'
  }

  function fileIcon(type) {
    if (type === 'nifti') return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#00C8B4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><path d="M8 12a4 4 0 0 0 8 0"/>
      </svg>
    )
    if (type === 'json') return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
      </svg>
    )
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#7A9BBE" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      </svg>
    )
  }

  function logLineClass(line) {
    const l = line.toLowerCase()
    if (l.startsWith('error') || l.includes('error:')) return s.logError
    if (l.startsWith('warning') || l.includes('warning')) return s.logWarning
    if (l.startsWith('moved') || l.startsWith('created') || l.startsWith('success') || l.includes('complete')) return s.logSuccess
    if (l.startsWith('cmd:') || l.startsWith('command:')) return s.logCmd
    return s.logInfo
  }

  return (
    <div className={s.stepContent}>
      <div className={s.bidsHeader}>
        <div className={s.bidsSuccess}>
          <div className={s.successIcon}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div>
            <h3>BIDS Conversion Complete</h3>
            <p>{bidsFiles.niftiCount} NIfTI file(s) produced for subject <code>sub-{config.subjectId}</code></p>
          </div>
        </div>
        <button className={s.downloadBids} onClick={onDownload}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Download BIDS Dataset
        </button>
      </div>

      <div className={s.bidsPanel}>
        {/* File tree */}
        <div className={s.bidsTree}>
          <div className={s.panelTitle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            BIDS File Structure ({bidsFiles.allPaths.length} files)
          </div>
          <div className={s.treeScroll}>
            {bidsFiles.allPaths.map((p) => {
              const depth = (p.match(/\//g) || []).length
              const type = classifyFile(p)
              return (
                <div key={p} className={`${s.treeLine} ${type === 'nifti' ? s.treeNifti : ''}`}
                  style={{ paddingLeft: `${12 + depth * 14}px` }}>
                  {fileIcon(type)}
                  <span>{p.split('/').pop()}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Conversion log */}
        <div className={s.bidsLog}>
          <div className={s.panelTitle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            Conversion Log
          </div>
          <div className={s.logScroll}>
            {logLines.length === 0
              ? <span className={s.logInfo}>No log output available.</span>
              : logLines.map((line, i) => (
                <div key={i} className={`${s.logLine} ${logLineClass(line)}`}>{line}</div>
              ))}
          </div>
        </div>
      </div>

      <div className={s.navButtons}>
        <button className="btn-outline" onClick={onBack}>← Back</button>
        <button className="btn-primary" onClick={() => onContinue()}>
          Send to MRIQC
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
      </div>
    </div>
  )
}

// ── STEP 4: MRIQC Processing ──────────────────────────────────────────────────
function ProcessingStep({ progress, statusMsg, elapsed, queueInfo, onCancel }) {
  const isQueued = !!queueInfo && queueInfo.status === 'queued'

  return (
    <div className={s.stepContent}>
      <div className={s.centerPanel}>
        <div className={s.scanWrapper}>
          {/* Live 3-D rotating brain — same component as the home page hero */}
          <BrainModel className={s.scanBrain} />

          {/* Corner-bracket overlay (pointer-events:none so drag still works) */}
          <svg viewBox="0 0 280 280" fill="none"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            <path d="M18,18 L30,18 M18,18 L18,30" stroke="rgba(0,200,180,0.5)" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M262,18 L250,18 M262,18 L262,30" stroke="rgba(0,200,180,0.5)" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M18,262 L30,262 M18,262 L18,250" stroke="rgba(0,200,180,0.5)" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M262,262 L250,262 M262,262 L262,250" stroke="rgba(0,200,180,0.5)" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>

          {/* Horizontal scan-line sweep */}
          <div className={s.scanLineProc} />
        </div>

        <div className={s.convLabel}>
          {isQueued ? 'Waiting for a Compute Slot' : 'MRIQC Processing on Server'}
        </div>

        {/* ── Queue ticket card ─────────────────────────────────── */}
        {isQueued && (
          <div className={s.queueCard}>
            <div className={s.queueTop}>
              {/* Ticket badge */}
              <div className={s.queueBadge}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v2z"/>
                </svg>
                Queue Ticket
              </div>
              <div className={s.queuePos}>#{queueInfo.queue_position}</div>
            </div>

            {/* Queue position bar */}
            <div className={s.queueTrack}>
              <div className={s.queueFill}
                style={{ width: `${Math.max(4, (1 / Math.max(queueInfo.total_queued + 1, 1)) * 100)}%` }}
              />
            </div>

            <div className={s.queueMeta}>
              <span>
                <strong>{queueInfo.queue_position - 1}</strong>
                {queueInfo.queue_position - 1 === 1 ? ' job' : ' jobs'} ahead
              </span>
              <span className={s.queueEst}>
                ~{queueInfo.estimated_wait_min} min estimated wait
              </span>
            </div>

            <p className={s.queueNote}>
              Your job is reserved. The server will start it automatically — keep this tab open.
            </p>
          </div>
        )}

        {/* ── Regular progress (shown while running or while queued in background) */}
        <div className={s.processingInfo}>
          <div className={s.processingStatus}>
            {isQueued ? `Server busy — ${queueInfo.active_jobs} job${queueInfo.active_jobs !== 1 ? 's' : ''} currently running` : statusMsg}
          </div>
          <div className={s.progressBar}>
            <div className={s.progressFill} style={{ width: isQueued ? '0%' : `${progress}%` }} />
          </div>
          <div className={s.progressMeta}>
            <span className={s.progressPct}>{isQueued ? 'In queue' : `${Math.round(progress)}%`}</span>
            <span className={s.elapsed}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              {elapsed}
            </span>
          </div>
        </div>

        <div className={s.tipBox}>
          <span className={s.tipLabel}>{isQueued ? 'While you wait' : 'About MRIQC'}</span>
          <p>{isQueued
            ? 'WebMRIQC serves researchers across Africa and beyond. A fair compute queue ensures every submission is processed in order — your place is reserved.'
            : 'MRIQC uses ANTs, FSL, and Nipype under the hood. It computes over 50 image quality metrics and generates publication-ready visual reports. Processing typically takes 5–15 minutes per participant.'
          }</p>
        </div>
        <button className={s.cancelBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

// ── STEP 5: Results ───────────────────────────────────────────────────────────
function ResultsStep({ results, config, onReset }) {
  const hasDashboard = results.files.jsonMetrics?.length > 0 || results.files.htmlFiles?.length > 0
  const [activeTab, setActiveTab] = useState(hasDashboard ? 'dashboard' : 'metrics')
  const [addedToCompare, setAddedToCompare] = useState(false)
  const { blob, files } = results
  const downloadUrl = URL.createObjectURL(blob)

  function handleDownloadZip() {
    const a = document.createElement('a')
    a.href = downloadUrl
    a.download = `mriqc_results_${config.subjectId}.zip`
    a.click()
  }

  function handleDownloadCSV() {
    for (const { content, path } of files.tsvFiles) {
      const baseName = path.split('/').pop().replace('.tsv', '.csv')
      downloadCSV(content, `mriqc_${config.subjectId}_${baseName}`)
    }
  }

  function handleAddToCompare() {
    const label = `sub-${config.subjectId}${config.sessionId ? `_${config.sessionId}` : ''}`
    addMulticenterDataset(label, config.subjectId, config.sessionId, config.modalities.join('+'), files.tsvFiles)
    setAddedToCompare(true)
  }

  // Color-code TSV cells for key metrics
  const KEY_RANGES = {
    cnr: { good: [2.5, Infinity], mod: [1.5, 2.5] },
    snr: { good: [10, Infinity], mod: [5, 10] },
    efc: { good: [0, 0.5], mod: [0.5, 0.7] },
    fd_mean: { good: [0, 0.2], mod: [0.2, 0.5] },
    tsnr: { good: [40, Infinity], mod: [20, 40] },
    aor: { good: [0, 0.05], mod: [0.05, 0.1] },
  }

  function cellColor(header, val) {
    const key = header.toLowerCase().replace(/[^a-z_]/g, '')
    const range = KEY_RANGES[key]
    if (!range) return ''
    const n = parseFloat(val)
    if (isNaN(n)) return ''
    const [gMin, gMax] = range.good
    const [mMin, mMax] = range.mod
    if (n >= gMin && n <= gMax) return s.cellGood
    if (n >= mMin && n <= mMax) return s.cellMod
    return s.cellBad
  }

  return (
    <div className={s.stepContent}>
      {/* Header */}
      <div className={s.resultsHeader}>
        <div className={s.resultsSuccess}>
          <div className={s.successIcon}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div>
            <h2>Analysis Complete</h2>
            <p>MRIQC processed <code>sub-{config.subjectId}</code> — {files.allPaths.length} output files generated.</p>
          </div>
        </div>
        <div className={s.resultActions}>
          <button className={s.btnSecondary} onClick={handleDownloadCSV}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Export CSV
          </button>
          <button className="btn-primary" onClick={handleDownloadZip}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download ZIP
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className={s.resultsTabs}>
        {[
          hasDashboard && { id: 'dashboard', label: 'Dashboard' },
          { id: 'metrics', label: `Metrics${files.tsvFiles.length > 0 ? ` (${files.tsvFiles.length})` : ''}` },
          { id: 'files',   label: `All Files (${files.allPaths.length})` },
        ].filter(Boolean).map((t) => (
          <button key={t.id} className={`${s.resTab} ${activeTab === t.id ? s.resTabActive : ''}`} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Dashboard — custom visual report */}
      {activeTab === 'dashboard' && (
        <div className={s.metricsPanel}>
          <MriqcReport
            jsonMetrics={files.jsonMetrics}
            htmlFiles={files.htmlFiles}
            svgFigures={files.svgFigures}
          />
        </div>
      )}

      {/* Metrics — TSV tables (kept for backward compat; MRIQC ≥23 may produce them) */}
      {activeTab === 'metrics' && (
        <div className={s.metricsPanel}>
          {files.tsvFiles.length === 0 && (
            <p className={s.noContent}>
              No TSV metrics files found.
              {files.jsonMetrics?.length > 0 && ' Switch to the Dashboard tab to view the JSON-based IQM report.'}
            </p>
          )}
          {files.tsvFiles.map(({ path, content }) => {
            const { headers, rows } = parseTSV(content)
            return (
              <div key={path} className={s.tsvBlock}>
                <div className={s.tsvMeta}>
                  <span className={s.tsvTitle}>{path.split('/').pop()}</span>
                  <button className={s.csvBtn} onClick={() => downloadCSV(content, path.split('/').pop().replace('.tsv', '.csv'))}>
                    Export as CSV
                  </button>
                </div>
                <div className={s.tableScroll}>
                  <table className={s.metricsTable}>
                    <thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={i}>
                          {row.map((cell, j) => (
                            <td key={j} className={cellColor(headers[j], cell)}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Files */}
      {activeTab === 'files' && (
        <pre className={s.fileTree}>{files.allPaths.map((p) => `├─ ${p}`).join('\n')}</pre>
      )}

      {/* Multicenter CTA */}
      <div className={s.compareCta}>
        {addedToCompare ? (
          <div className={s.compareAdded}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Added to multicenter comparison!
            <Link to="/compare" className={s.compareLink}>View Comparison →</Link>
          </div>
        ) : (
          <>
            <p>Want to compare these results across sites or scanners?</p>
            <button className={s.compareBtn} onClick={handleAddToCompare}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
                <line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
              Add to Multicenter Comparison
            </button>
          </>
        )}
      </div>

      <div className={s.navButtons}>
        <button className="btn-outline" onClick={onReset}>← Analyze Another Dataset</button>
        <Link to="/compare" className={s.btnSecondary}>View Multicenter →</Link>
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Analyze() {
  const [step, setStep] = useState('setup')
  const [mode, setMode] = useState('dicom')   // 'dicom' | 'bids'
  const [dicomFile, setDicomFile] = useState(null)
  const [config, setConfig] = useState({ subjectId: '01', sessionId: 'baseline', modalities: ['T1w'], nProcs: 36, memGb: 128 })
  const [bidsBlob, setBidsBlob] = useState(null)
  const [bidsFiles, setBidsFiles] = useState(null)
  const [convPhase, setConvPhase] = useState('uploading')
  const [convProgress, setConvProgress] = useState(0)
  const [convStatus, setConvStatus] = useState('')
  const [convElapsed, setConvElapsed] = useState('0:00')
  const [mriqcProgress, setMriqcProgress] = useState(0)
  const [mriqcStatus, setMriqcStatus] = useState('')
  const [mriqcElapsed, setMriqcElapsed] = useState('0:00')
  const [queueInfo, setQueueInfo] = useState(null)   // null = not queued
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)
  const [serverStatus, setServerStatus] = useState('checking')

  const timerRef = useRef(null)
  const fakeRef = useRef(null)
  const startRef = useRef(null)
  const msgRef = useRef(0)

  function cfgChange(k, v) { setConfig((p) => ({ ...p, [k]: v })) }

  function startTimer(setElapsed) {
    startRef.current = Date.now()
    timerRef.current = setInterval(() => {
      const secs = Math.floor((Date.now() - startRef.current) / 1000)
      setElapsed(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`)
    }, 1000)
  }

  function startFakeProgress(setProgress, setStatus, messages, targetPct = 85) {
    msgRef.current = 0
    setStatus(messages[0])
    fakeRef.current = setInterval(() => {
      setProgress((p) => (p >= targetPct ? targetPct : p + (targetPct - p) * 0.018))
      msgRef.current = (msgRef.current + 1) % messages.length
      setStatus(messages[msgRef.current])
    }, 3000)
  }

  function stopTimers() {
    clearInterval(timerRef.current)
    clearInterval(fakeRef.current)
  }

  async function handleConvert() {
    setError(null)
    setStep('converting')
    setConvProgress(2)
    setConvPhase('uploading')
    setConvStatus('Sending DICOM data to local converter…')
    startTimer(setConvElapsed)
    try {
      const blob = await convertDicomLocally(
        dicomFile,
        config,
        (pct) => {
          // Upload to localhost is fast; maps 0–100% → 2–10% overall
          setConvProgress(2 + pct * 0.08)
          setConvStatus(`Uploading… ${pct}%`)
        },
        () => {
          // Upload done — dcm2bids is now running locally
          setConvPhase('converting')
          setConvProgress(12)
          startFakeProgress(setConvProgress, setConvStatus, CONV_MESSAGES, 88)
        },
      )
      stopTimers()
      setConvProgress(94)
      setConvStatus('Parsing BIDS structure…')
      const parsed = await parseBidsZip(blob)
      setConvProgress(100)
      setConvStatus('Done!')
      setBidsBlob(blob)
      setBidsFiles(parsed)
      setStep('bids_ready')
    } catch (err) {
      stopTimers()
      setError(err.message)
      setStep('setup')
    }
  }

  function handleDownloadBids() {
    const url = URL.createObjectURL(bidsBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bids_sub-${config.subjectId}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleMRIQC(blobOverride) {
    // Guard: only use blobOverride if it's an actual Blob/File, not a click event
    const inputBlob = (blobOverride instanceof Blob) ? blobOverride : bidsBlob
    setError(null)
    setQueueInfo(null)
    setStep('processing')
    setMriqcProgress(5)
    startTimer(setMriqcElapsed)
    startFakeProgress(setMriqcProgress, setMriqcStatus, MRIQC_MESSAGES, 85)

    // Called by pollUntilDone every time the server-side job status changes.
    function onStatusUpdate(info) {
      if (!info || info.status === 'running') {
        setQueueInfo(null)   // clear ticket — job is now actually running
      } else if (info.status === 'queued') {
        setQueueInfo(info)   // show ticket card with position
      }
    }

    try {
      const blob = await runMRIQC(inputBlob, config, (pct) => {
        setMriqcProgress(5 + pct * 0.1)
      }, onStatusUpdate)
      stopTimers()
      setMriqcProgress(92)
      setMriqcStatus('Parsing results...')

      const files = await parseResultsZip(blob)
      setMriqcProgress(100)
      setMriqcStatus('Complete!')
      setResults({ blob, files })
      setStep('results')
    } catch (err) {
      stopTimers()
      setError(err.message)
      // BIDS mode: go back to setup; DICOM mode: go back to bids_ready (conversion output)
      setStep(mode === 'bids' ? 'setup' : 'bids_ready')
    }
  }

  async function handleBidsDirect() {
    // BIDS direct path: use the uploaded ZIP as the BIDS blob, skip convert + bids_ready
    setBidsBlob(dicomFile)
    await handleMRIQC(dicomFile)
  }

  function handleReset() {
    setDicomFile(null); setBidsBlob(null); setBidsFiles(null)
    setResults(null); setError(null); setQueueInfo(null)
    setConvProgress(0); setConvElapsed('0:00'); setConvPhase('uploading'); setConvStatus('')
    setMriqcProgress(0); setMriqcElapsed('0:00'); setMriqcStatus('')
    setStep('setup')
    // keep `mode` so user doesn't have to re-select after analyzing another dataset
  }

  useEffect(() => () => stopTimers(), [])

  // Check on mount what the connected server is capable of
  useEffect(() => {
    checkHealth()
      .then((data) => {
        if (data.mriqc) setServerStatus('ok')
        else            setServerStatus('no-mriqc')
      })
      .catch(() => setServerStatus('offline'))
  }, [])

  const steps    = mode === 'bids' ? STEPS_BIDS    : STEPS_DICOM
  const stepIdx  = mode === 'bids' ? STEP_IDX_BIDS : STEP_IDX_DICOM

  return (
    <div className={s.page}>
      <div className={s.pageHeader}>
        <div className="container">
          <h1 className={s.pageTitle}>
            {mode === 'bids'
              ? <>BIDS → <span className="gradient-text">MRIQC</span></>
              : <>DICOM → BIDS → <span className="gradient-text">MRIQC</span></>
            }
          </h1>
          <p className={s.pageDesc}>
            {mode === 'bids'
              ? 'Upload a BIDS-compliant dataset ZIP and run MRIQC quality assessment directly.'
              : 'Upload DICOM data, convert to BIDS, run quality control, and download your metrics.'
            }
          </p>
        </div>
      </div>

      <div className={`${s.pageBody} container`}>
        <ServerBanner status={serverStatus} />
        <StepBar current={step} steps={steps} stepIdx={stepIdx} />
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        <div className={s.card}>
          {step === 'setup' && (
            <SetupStep
              file={dicomFile} onFile={setDicomFile}
              config={config} onChange={cfgChange}
              mode={mode} onModeChange={(m) => { setMode(m); setStep('setup') }}
              onNext={mode === 'bids' ? handleBidsDirect : handleConvert}
            />
          )}
          {step === 'converting' && (
            <ConvertingStep
              convPhase={convPhase}
              progress={convProgress}
              statusMsg={convStatus}
              elapsed={convElapsed}
            />
          )}
          {step === 'bids_ready' && bidsFiles && (
            <BidsReadyStep bidsBlob={bidsBlob} bidsFiles={bidsFiles} config={config}
              onDownload={handleDownloadBids}
              onContinue={handleMRIQC}
              onBack={() => setStep('setup')} />
          )}
          {step === 'processing' && (
            <ProcessingStep progress={mriqcProgress} statusMsg={mriqcStatus} elapsed={mriqcElapsed}
              queueInfo={queueInfo}
              onCancel={() => { stopTimers(); setQueueInfo(null); setStep(mode === 'bids' ? 'setup' : 'bids_ready') }} />
          )}
          {step === 'results' && results && (
            <ResultsStep results={results} config={config} onReset={handleReset} />
          )}
        </div>
      </div>
    </div>
  )
}
