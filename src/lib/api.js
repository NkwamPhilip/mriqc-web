// Single API base URL — everything goes to the same server.
// Set VITE_API_URL at build time (or in .env) to override, e.g.:
//   VITE_API_URL=https://mriqc.haske.online  npm run build
// When the React app is served FROM the same server (Dockerfile), leave it
// blank — relative paths work automatically.
const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

export async function checkHealth() {
  const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error('Server unreachable')
  return res.json()
}

// ── DICOM → BIDS ─────────────────────────────────────────────────────────────
// onUploadProgress(pct: 0-100) fires during upload.
// onConversionStart() fires when the file is received and dcm2bids begins.
export function convertDicomLocally(file, config, onUploadProgress, onConversionStart) {
  return new Promise((resolve, reject) => {
    const fd = new FormData()
    fd.append('dicom_zip', file)
    fd.append('participant_label', config.subjectId)
    fd.append('session_id', config.sessionId || '')

    const xhr = new XMLHttpRequest()

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onUploadProgress) {
        onUploadProgress(Math.round((e.loaded / e.total) * 100))
      }
    }

    xhr.upload.onloadend = () => {
      if (onConversionStart) onConversionStart()
    }

    xhr.onload = () => {
      if (xhr.status === 200) resolve(xhr.response)
      else {
        try { reject(new Error(JSON.parse(xhr.responseText).detail || `Server error ${xhr.status}`)) }
        catch { reject(new Error(`Server error ${xhr.status}`)) }
      }
    }
    xhr.onerror = () => reject(new Error('Cannot reach the server. Is it running?'))
    xhr.ontimeout = () => reject(new Error('Conversion timed out after 30 minutes'))

    xhr.open('POST', `${API}/convert-dicom`)
    xhr.responseType = 'blob'
    xhr.timeout = 1_800_000   // 30 min ceiling
    xhr.send(fd)
  })
}

// ── MRIQC processing ─────────────────────────────────────────────────────────
export function runMRIQC(file, config, onUploadProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData()
    fd.append('bids_zip', file)
    fd.append('participant_label', config.subjectId)
    fd.append('modalities', config.modalities.join(' '))
    fd.append('session_id', config.sessionId || '')
    fd.append('n_procs', String(config.nProcs))
    fd.append('mem_gb', String(config.memGb))

    const xhr = new XMLHttpRequest()
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onUploadProgress) {
        onUploadProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status === 200) resolve(xhr.response)
      else {
        try { reject(new Error(JSON.parse(xhr.responseText).detail || `Error ${xhr.status}`)) }
        catch { reject(new Error(`Server error ${xhr.status}`)) }
      }
    }
    xhr.onerror = () => reject(new Error('Network error — check your connection'))
    xhr.ontimeout = () => reject(new Error('Request timed out after 2 hours'))

    xhr.open('POST', `${API}/run-mriqc`)
    xhr.responseType = 'blob'
    xhr.timeout = 7_200_000
    xhr.send(fd)
  })
}

// ── ZIP parsing utilities ────────────────────────────────────────────────────
export async function parseBidsZip(blob) {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(blob)
  const result = { allPaths: [], log: '', niftiCount: 0 }

  const entries = Object.entries(zip.files).filter(([, e]) => !e.dir)
  result.allPaths = entries.map(([p]) => p).sort()

  await Promise.all(entries.map(async ([path, entry]) => {
    if (path === 'conversion_log.txt' || path.endsWith('/conversion_log.txt')) {
      result.log = await entry.async('string')
    }
    if (path.endsWith('.nii.gz') || path.endsWith('.nii')) {
      result.niftiCount++
    }
  }))

  return result
}

export async function parseResultsZip(blob) {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(blob)
  const result = { tsvFiles: [], htmlFiles: [], allPaths: [] }

  const entries = Object.entries(zip.files).filter(([, e]) => !e.dir)
  result.allPaths = entries.map(([p]) => p).sort()

  await Promise.all(entries.map(async ([path, entry]) => {
    if (path.endsWith('.tsv')) {
      result.tsvFiles.push({ path, content: await entry.async('string') })
    } else if (path.endsWith('.html')) {
      result.htmlFiles.push({ path, content: await entry.async('string') })
    }
  }))

  return result
}

export function parseTSV(content) {
  const lines = content.trim().split('\n')
  if (lines.length < 2) return { headers: [], rows: [] }
  return {
    headers: lines[0].split('\t'),
    rows: lines.slice(1).map((l) => l.split('\t')),
  }
}

// ── CSV download ─────────────────────────────────────────────────────────────
export function downloadCSV(tsvContent, filename) {
  const csv = tsvContent.trim().split('\n')
    .map((line) => line.split('\t')
      .map((cell) => {
        const c = cell.trim()
        return (c.includes(',') || c.includes('"') || c.includes('\n'))
          ? `"${c.replace(/"/g, '""')}"` : c
      })
      .join(','))
    .join('\n')

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Multicenter localStorage helpers ─────────────────────────────────────────
export function getMulticenterDatasets() {
  try { return JSON.parse(localStorage.getItem('mriqc_mc_datasets') || '[]') }
  catch { return [] }
}

export function addMulticenterDataset(label, subjectId, sessionId, modality, tsvFiles) {
  const datasets = getMulticenterDatasets()
  const id = Date.now().toString()

  const allMetrics = []
  for (const { content } of tsvFiles) {
    const { headers, rows } = parseTSV(content)
    for (const row of rows) {
      const m = {}
      headers.forEach((h, i) => { m[h] = row[i] ?? '' })
      allMetrics.push(m)
    }
  }

  const entry = {
    id, label, subjectId, sessionId, modality,
    metrics: allMetrics,
    addedAt: new Date().toISOString(),
  }
  datasets.push(entry)
  localStorage.setItem('mriqc_mc_datasets', JSON.stringify(datasets))
  return entry
}

export function removeMulticenterDataset(id) {
  const datasets = getMulticenterDatasets().filter((d) => d.id !== id)
  localStorage.setItem('mriqc_mc_datasets', JSON.stringify(datasets))
  return datasets
}
