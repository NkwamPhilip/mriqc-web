// Single API base URL — everything goes to the same server.
// Set VITE_API_URL at build time (or in .env) to override, e.g.:
//   VITE_API_URL=https://webmriqc.mailab.io  npm run build
// When the React app is served FROM the same server (Dockerfile), leave it
// blank — relative paths work automatically.
const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

export async function checkHealth() {
  const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error('Server unreachable')
  return res.json()
}

// ── Job polling ───────────────────────────────────────────────────────────────
// Polls /job/{id} every 2 s until the job is done or errors.
// Works behind Cloudflare and any proxy — each poll completes in milliseconds.
async function pollUntilDone(jobId, maxWaitMs = 7_200_000) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const res = await fetch(`${API}/job/${jobId}`)
    if (!res.ok) throw new Error(`Status check failed (${res.status})`)
    const data = await res.json()
    if (data.status === 'done')  return
    if (data.status === 'error') throw new Error(data.error || 'Processing failed on server')
    // status === 'running' → keep polling
  }
  throw new Error('Job timed out after 2 hours')
}

// Download the result ZIP for a completed job.
// Retries up to 3 times with a 5 s gap — handles the brief server hiccup that
// can occur right after MRIQC releases its large memory footprint.
async function downloadJobResult(jobId) {
  const MAX_TRIES = 3
  let lastErr
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await fetch(`${API}/job/${jobId}/download`)
      if (!res.ok) {
        let msg = `Download failed (${res.status})`
        try { msg = (await res.json()).detail || msg } catch { /* ignore */ }
        throw new Error(msg)
      }
      return await res.blob()
    } catch (err) {
      lastErr = err
      if (attempt < MAX_TRIES) {
        console.warn(`[downloadJobResult] attempt ${attempt} failed (${err.message}), retrying in 5 s…`)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }
  throw lastErr
}

// ── DICOM → BIDS ─────────────────────────────────────────────────────────────
// Flow:
//   1. XHR uploads the file → onUploadProgress fires (0–100 %)
//   2. Server saves the upload and returns {job_id} immediately (<1 s)
//   3. onConversionStart() fires — frontend switches to "Converting" screen
//   4. pollUntilDone polls every 2 s (each request finishes in <100 ms)
//   5. downloadJobResult fetches the BIDS ZIP once the job is done
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
      // Upload finished — server is now processing in a background thread
      if (onConversionStart) onConversionStart()
    }

    xhr.onload = async () => {
      if (xhr.status === 200) {
        try {
          const { job_id } = JSON.parse(xhr.responseText)
          await pollUntilDone(job_id)
          resolve(await downloadJobResult(job_id))
        } catch (e) { reject(e) }
      } else {
        try {
          const body = JSON.parse(xhr.responseText)
          const detail = body.detail
          const msg = Array.isArray(detail)
            ? detail.map((e) => `${(e.loc || []).join(' → ')}: ${e.msg}`).join('; ')
            : (detail || `Server error ${xhr.status}`)
          reject(new Error(msg))
        } catch { reject(new Error(`Server error ${xhr.status}`)) }
      }
    }

    xhr.onerror   = () => reject(new Error('Cannot reach the server. Is it running?'))
    xhr.ontimeout = () => reject(new Error('Upload timed out after 30 minutes'))

    xhr.open('POST', `${API}/convert-dicom`)
    xhr.responseType = 'text'    // expecting JSON {job_id}, not a blob
    xhr.timeout = 1_800_000      // 30 min ceiling for the upload itself
    xhr.send(fd)
  })
}

// ── MRIQC processing ─────────────────────────────────────────────────────────
// Same pattern: upload → job_id → poll → download
export function runMRIQC(file, config, onUploadProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData()
    fd.append('bids_zip', file)
    fd.append('participant_label', config.subjectId || '')
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

    xhr.onload = async () => {
      if (xhr.status === 200) {
        try {
          const { job_id } = JSON.parse(xhr.responseText)
          await pollUntilDone(job_id)
          resolve(await downloadJobResult(job_id))
        } catch (e) { reject(e) }
      } else {
        try {
          const body = JSON.parse(xhr.responseText)
          const detail = body.detail
          // FastAPI 422 detail is an array of validation errors — flatten to a string
          const msg = Array.isArray(detail)
            ? detail.map((e) => `${(e.loc || []).join(' → ')}: ${e.msg}`).join('; ')
            : (detail || `Server error ${xhr.status}`)
          reject(new Error(msg))
        } catch { reject(new Error(`Server error ${xhr.status}`)) }
      }
    }

    xhr.onerror   = () => reject(new Error('Network error — check your connection'))
    xhr.ontimeout = () => reject(new Error('Upload timed out'))

    xhr.open('POST', `${API}/run-mriqc`)
    xhr.responseType = 'text'
    xhr.timeout = 7_200_000      // 2 hr ceiling for the upload
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
  const result = { tsvFiles: [], htmlFiles: [], jsonMetrics: [], allPaths: [] }

  const entries = Object.entries(zip.files).filter(([, e]) => !e.dir)
  result.allPaths = entries.map(([p]) => p).sort()

  await Promise.all(entries.map(async ([path, entry]) => {
    if (path.endsWith('.tsv')) {
      result.tsvFiles.push({ path, content: await entry.async('string') })
    } else if (path.endsWith('.html')) {
      result.htmlFiles.push({ path, content: await entry.async('string') })
    } else if (
      path.endsWith('.json') &&
      path.includes('/') &&           // must be inside a sub-directory
      !path.endsWith('dataset_description.json') &&
      !path.endsWith('participants.json')
    ) {
      // Per-subject IQM JSON: sub-XX/ses-XX/anat/sub-XX_T1w.json
      try {
        const text = await entry.async('string')
        const data = JSON.parse(text)
        // Identify as IQM file by presence of core metric keys
        if ('cnr' in data || 'snr_total' in data || 'tsnr' in data || 'efc' in data) {
          result.jsonMetrics.push({ path, metrics: data })
        }
      } catch { /* skip malformed JSON */ }
    }
  }))

  // Sort HTML reports so they match the subject order
  result.htmlFiles.sort((a, b) => a.path.localeCompare(b.path))
  result.jsonMetrics.sort((a, b) => a.path.localeCompare(b.path))

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
