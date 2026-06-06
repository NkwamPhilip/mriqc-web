/**
 * reference.js
 *
 * Normative IQM reference data sourced from 33 T1w scans on OpenNeuro.
 * Used by MetricCard to contextualise each metric with a population
 * percentile and to draw a reference-median tick on the quality bar.
 *
 * All computation is deferred to first call and then cached.
 */

import rawTsv from '../data/reference_t1w.tsv?raw'

// ── TSV parse (once, lazy) ────────────────────────────────────────────────────

let _rows = null

function getRows() {
  if (_rows) return _rows
  const lines = rawTsv.trim().split('\n')
  const headers = lines[0].split('\t')
  _rows = lines.slice(1).map(line => {
    const cells = line.split('\t')
    const obj = {}
    headers.forEach((h, i) => { obj[h] = cells[i] ?? '' })
    return obj
  })
  return _rows
}

// Numeric values for a column, excluding sentinel -1 and NaN.
function refVals(metric) {
  return getRows()
    .map(r => parseFloat(r[metric]))
    .filter(v => isFinite(v) && v > -0.5)
}

// ── Statistics ────────────────────────────────────────────────────────────────

function sorted(vals) { return [...vals].sort((a, b) => a - b) }

function median(vals) {
  const s = sorted(vals)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

// Fraction of reference values ≤ v, as a 0–100 integer.
function pctRank(vals, v) {
  const s = sorted(vals)
  const below = s.filter(x => x <= v).length
  return Math.round((below / s.length) * 100)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compare a user metric value to the reference population.
 *
 * @param {string} metric - column name matching MRIQC JSON key
 * @param {number} value  - user's metric value
 * @param {number} dir    - +1 if higher is better, -1 if lower is better
 * @returns {{ qualityPct: number, refN: number, refMedian: number } | null}
 *
 * qualityPct is always "better than X%" — inverted for lower-is-better
 * metrics so that a high number always means a good result.
 */
export function compareToRef(metric, value, dir) {
  if (value == null || Number(value) === -1) return null
  const vals = refVals(metric)
  if (vals.length === 0) return null
  const rank = pctRank(vals, Number(value))
  return {
    qualityPct: dir === 1 ? rank : 100 - rank,
    refN: vals.length,
    refMedian: median(vals),
  }
}

/**
 * The 33-subject HCP / OpenNeuro T1w reference, packaged as a Compare-page
 * dataset so it can be pinned as an always-present baseline column.
 * `metrics` is the array of 33 per-subject metric objects (string values,
 * matching the shape produced by addMulticenterDataset).
 */
export function getReferenceDataset() {
  return {
    id:        'reference-hcp-openneuro',
    label:     'HCP / OpenNeuro Reference',
    modality:  'T1w',
    subjectId: 'ref',
    sessionId: '',
    isReference: true,
    metrics:   getRows(),          // 33 subject rows
    addedAt:   null,
  }
}

export function referenceSubjectCount() {
  return getRows().length
}
