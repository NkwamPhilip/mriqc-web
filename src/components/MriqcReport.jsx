/**
 * MriqcReport — custom in-browser quality dashboard
 *
 * Renders a rich visual summary from the per-subject JSON metrics that MRIQC
 * writes to  sub-XX/ses-XX/anat/sub-XX_T1w.json  (and BOLD equivalents).
 *
 * Brain figures: the SVG files inside sub-XX/figures/ are extracted from the
 * result ZIP and displayed as an inline image gallery.  The same blob URLs are
 * injected into the MRIQC HTML report iframe so Bootstrap / jQuery CDN scripts
 * load correctly AND the brain slice mosaics actually appear.
 */

import { useState, useEffect, useMemo } from 'react'
import s from './MriqcReport.module.css'
import { compareToRef } from '../lib/reference.js'

// ── Figure catalogue ──────────────────────────────────────────────────────────
// Defines the display order, human label, and one-line caption for each
// desc-* figure that MRIQC writes.  Unknown descriptors fall through and are
// shown at the end with a generic label.

const FIG_DEFS = [
  { desc: 'background',   label: 'Background View',          caption: 'Enhances the air around the head — artifacts show up here first.' },
  { desc: 'zoomed',       label: 'Brain Mosaic (Zoomed)',    caption: 'Full brain mosaic — best for checking motion, noise, and signal leakage.' },
  { desc: 'brainmask',    label: 'Brain Extraction',         caption: 'Brain mask computed by MRIQC. Defects indicate image quality issues.' },
  { desc: 'segmentation', label: 'Tissue Segmentation',      caption: 'GM / WM / CSF tissue labels — noisy labels flag quality problems.' },
  { desc: 'norm',         label: 'MNI Registration',         caption: 'Quick nonlinear warp into MNI152NLin2009cAsym space.' },
  { desc: 'airmask',      label: '"Hat" Mask',               caption: 'Air mask used by MRIQC for noise estimation (excludes eye area).' },
  { desc: 'noisefit',     label: 'Noise Distribution',       caption: 'Background noise histogram — Rician χ² fit used for QI₁.' },
  { desc: 'artifacts',    label: 'Background Artifacts',     caption: 'Artifactual intensities detected within the hat mask.' },
  { desc: 'head',         label: 'Head Mask',                caption: 'Head outline mask computed internally.' },
]
const FIG_ORDER = Object.fromEntries(FIG_DEFS.map((d, i) => [d.desc, i]))

// ── Metric definitions ────────────────────────────────────────────────────────
// dir: +1 = higher is better,  -1 = lower is better
// th:  [good_threshold, moderate_threshold]
// papers: peer-reviewed references that establish the threshold / metric

const ANAT_DEFS = [
  {
    key: 'cnr', label: 'CNR', desc: 'Contrast-to-Noise Ratio',
    dir: +1, th: [2.5, 1.5], range: [0, 6], unit: '',
    tip: 'GM–WM contrast relative to noise. >2.5 good.',
    longDesc: 'Measures the difference in mean signal intensity between grey matter (GM) and white matter (WM), normalised by the standard deviation of background noise. A higher CNR means tissue types are more easily distinguished, which is critical for accurate segmentation and reliable downstream analyses. Values below 1.5 often indicate a noisy acquisition or significant bias field.',
    papers: [
      { authors: 'Esteban O, et al.', year: '2017', title: 'MRIQC: Advancing the automatic prediction of image quality in MRI from unseen sites', journal: 'PLOS ONE', doi: 'https://doi.org/10.1371/journal.pone.0184661' },
      { authors: 'Magnota VA & Friedman L', year: '2006', title: 'Measurement of signal-to-noise and contrast-to-noise in the fBIRN multicenter imaging study', journal: 'J Digit Imaging', doi: 'https://doi.org/10.1007/s10278-006-0264-x' },
    ],
  },
  {
    key: 'snr_total', label: 'SNR', desc: 'Signal-to-Noise Ratio',
    dir: +1, th: [15, 8], range: [0, 30], unit: '',
    tip: 'Overall signal vs background noise. >15 good.',
    longDesc: 'The ratio of mean brain signal intensity to the standard deviation of background (air) noise. Higher SNR reflects a cleaner image with less thermal or electronic noise contamination. Values are strongly scanner- and field-strength-dependent — a 1.5T clinical scanner will naturally produce lower SNR than a 3T research system.',
    papers: [
      { authors: 'Edelstein WA, et al.', year: '1986', title: 'The intrinsic signal-to-noise ratio in NMR imaging', journal: 'Magn Reson Med', doi: 'https://doi.org/10.1002/mrm.1910030113' },
      { authors: 'Magnota VA & Friedman L', year: '2006', title: 'Measurement of signal-to-noise and contrast-to-noise in the fBIRN multicenter imaging study', journal: 'J Digit Imaging', doi: 'https://doi.org/10.1007/s10278-006-0264-x' },
    ],
  },
  {
    key: 'cjv', label: 'CJV', desc: 'Coefficient of Joint Variation',
    dir: -1, th: [0.5, 0.7], range: [0, 1.5], unit: '',
    tip: 'Intensity variance in GM+WM. <0.5 good.',
    longDesc: 'Quantifies the combined spread of intensity values within grey matter and white matter regions. A high CJV indicates poor tissue contrast, significant intensity non-uniformity (bias field), or overlap between the two tissue distributions. It is particularly sensitive to B1 field inhomogeneity and can flag acquisitions that will be difficult to segment reliably.',
    papers: [
      { authors: 'Ganzetti M, et al.', year: '2016', title: 'Quantitative evaluation of intensity inhomogeneity correction methods for structural MR brain images', journal: 'Neuroinformatics', doi: 'https://doi.org/10.1007/s12021-015-9277-2' },
      { authors: 'Esteban O, et al.', year: '2017', title: 'MRIQC: Advancing the automatic prediction of image quality in MRI from unseen sites', journal: 'PLOS ONE', doi: 'https://doi.org/10.1371/journal.pone.0184661' },
    ],
  },
  {
    key: 'efc', label: 'EFC', desc: 'Entropy Focus Criterion',
    dir: -1, th: [0.5, 0.7], range: [0, 1], unit: '',
    tip: 'Shannon entropy proxy for ghosting. <0.5 good.',
    longDesc: 'Uses the Shannon entropy of the voxel intensity distribution as a proxy for ghosting and blurring. When signal energy leaks into the background — due to head motion, RF ghosting, or poor shimming — the entropy of the image increases. Lower EFC means energy is concentrated within the brain, as expected for a sharp, well-acquired image.',
    papers: [
      { authors: 'Atkinson D, et al.', year: '1997', title: 'Automatic correction of motion artifacts in magnetic resonance images using an entropy focus criterion', journal: 'IEEE Trans Med Imaging', doi: 'https://doi.org/10.1109/42.650886' },
      { authors: 'Esteban O, et al.', year: '2017', title: 'MRIQC: Advancing the automatic prediction of image quality in MRI from unseen sites', journal: 'PLOS ONE', doi: 'https://doi.org/10.1371/journal.pone.0184661' },
    ],
  },
  {
    key: 'fber', label: 'FBER', desc: 'Foreground/Background Energy Ratio',
    dir: +1, th: [100, 30], range: [0, 300], unit: '',
    tip: 'Brain-to-background energy ratio. >100 good. -1 = N/A.',
    longDesc: 'Compares the sum of squared intensities (energy) inside the brain mask with the energy in the air background. A high ratio indicates that signal is concentrated within the brain, as expected. Low FBER may indicate poor brain masking, a noisy background, or RF leakage. A value of −1 means the metric could not be computed for this scan.',
    papers: [
      { authors: 'Shehzad Z, et al.', year: '2015', title: 'The Preprocessed Connectomes Project Quality Assessment Protocol — a resource for measuring the quality of MRI data', journal: 'Front Neurosci', doi: 'https://doi.org/10.3389/conf.fnins.2015.91.00047' },
    ],
  },
  {
    key: 'inu_med', label: 'INU', desc: 'Intensity Non-Uniformity',
    dir: -1, th: [0.05, 0.15], range: [0, 0.4], unit: '',
    tip: 'Bias-field median. <0.05 good.',
    longDesc: 'Quantifies the smooth, spatially-varying intensity bias introduced by B1 field inhomogeneity in the MRI scanner. Estimated using the N4ITK bias correction algorithm. The median of the estimated bias field is reported — values near zero indicate a uniform field. High INU can cause the same tissue type to appear with different intensities in different parts of the image, degrading segmentation accuracy.',
    papers: [
      { authors: 'Tustison NJ, et al.', year: '2010', title: 'N4ITK: Improved N3 Bias Correction', journal: 'IEEE Trans Med Imaging', doi: 'https://doi.org/10.1109/TMI.2010.2046908' },
      { authors: 'Sled JG, et al.', year: '1998', title: 'A nonparametric method for automatic correction of intensity nonuniformity in MRI data', journal: 'IEEE Trans Med Imaging', doi: 'https://doi.org/10.1109/42.668698' },
    ],
  },
  {
    key: 'fwhm_avg', label: 'FWHM', desc: 'Spatial Blurring (avg)',
    dir: -1, th: [2.5, 4.0], range: [0, 8], unit: 'mm',
    tip: 'Average full-width at half-maximum. <2.5 mm good.',
    longDesc: 'Estimates the spatial smoothness of the image by measuring the full width at half maximum of the point-spread function. Lower FWHM means a sharper image. The expected value depends strongly on acquisition parameters — a 1 mm isotropic acquisition should show FWHM near 1–2 mm. Higher values suggest blurring from motion, poor shimming, or aggressive reconstruction smoothing.',
    papers: [
      { authors: 'Forman SD, et al.', year: '1995', title: 'Improved assessment of significant activation in functional magnetic resonance imaging', journal: 'Magn Reson Med', doi: 'https://doi.org/10.1002/mrm.1910330508' },
      { authors: 'Jenkinson M', year: '1999', title: 'Measuring transformation error by RMS deviation', journal: 'FMRIB Technical Report', doi: 'https://www.fmrib.ox.ac.uk/datasets/techrep/tr99mj1/tr99mj1.pdf' },
    ],
  },
  {
    key: 'wm2max', label: 'WM2Max', desc: 'White Matter / Max Ratio',
    dir: -1, th: [0.4, 0.6], range: [0, 1], unit: '',
    tip: 'WM mean vs global max. <0.4 good.',
    longDesc: 'The ratio of the mean white matter signal intensity to the 95th percentile of all brain intensities. Values far outside the typical range can indicate normalisation issues, incorrect scaling, acquisition problems, or the presence of extreme outlier voxels. This metric is used as a sanity check on the dynamic range of the image.',
    papers: [
      { authors: 'Esteban O, et al.', year: '2017', title: 'MRIQC: Advancing the automatic prediction of image quality in MRI from unseen sites', journal: 'PLOS ONE', doi: 'https://doi.org/10.1371/journal.pone.0184661' },
    ],
  },
]

const BOLD_DEFS = [
  {
    key: 'tsnr', label: 'tSNR', desc: 'Temporal SNR',
    dir: +1, th: [40, 20], range: [0, 100], unit: '',
    tip: 'Temporal signal-to-noise. >40 good for fMRI.',
    longDesc: 'Computed as the mean of the fMRI time series divided by its standard deviation, per voxel, then averaged across the brain. tSNR directly reflects the sensitivity of the scanner to detect BOLD-related signal changes. Values below 20 make it very difficult to detect typical 1–3% BOLD signal changes reliably. Higher field strength (3T vs 1.5T) substantially increases tSNR.',
    papers: [
      { authors: 'Parrish TB, et al.', year: '2000', title: 'Impact of signal-to-noise on functional MRI', journal: 'Magn Reson Med', doi: 'https://doi.org/10.1002/1522-2594(200007)44:1<925::AID-MRM2>3.0.CO;2-V' },
      { authors: 'Triantafyllou C, et al.', year: '2005', title: 'Comparison of physiological noise at 1.5T, 3T and 7T and optimization of fMRI acquisition parameters', journal: 'NeuroImage', doi: 'https://doi.org/10.1016/j.neuroimage.2004.12.011' },
    ],
  },
  {
    key: 'snr', label: 'SNR', desc: 'Signal-to-Noise Ratio',
    dir: +1, th: [10, 5], range: [0, 25], unit: '',
    tip: 'Overall signal-to-noise. >10 good.',
    longDesc: 'The ratio of mean brain signal to background noise standard deviation across the whole fMRI acquisition (computed from the mean volume). Low SNR makes it harder to distinguish BOLD signal changes from noise. Both scanner hardware (coil design, field strength) and acquisition parameters (voxel size, TR) strongly influence SNR.',
    papers: [
      { authors: 'Edelstein WA, et al.', year: '1986', title: 'The intrinsic signal-to-noise ratio in NMR imaging', journal: 'Magn Reson Med', doi: 'https://doi.org/10.1002/mrm.1910030113' },
    ],
  },
  {
    key: 'efc', label: 'EFC', desc: 'Entropy Focus Criterion',
    dir: -1, th: [0.5, 0.7], range: [0, 1], unit: '',
    tip: 'Shannon entropy proxy for ghosting. <0.5 good.',
    longDesc: 'Uses the Shannon entropy of the voxel intensity distribution as a proxy for ghosting and blurring. When signal energy leaks into the background — due to head motion, RF ghosting, or poor shimming — the entropy of the image increases. Computed on the mean fMRI volume.',
    papers: [
      { authors: 'Atkinson D, et al.', year: '1997', title: 'Automatic correction of motion artifacts in magnetic resonance images using an entropy focus criterion', journal: 'IEEE Trans Med Imaging', doi: 'https://doi.org/10.1109/42.650886' },
    ],
  },
  {
    key: 'fd_mean', label: 'FD', desc: 'Mean Framewise Displacement',
    dir: -1, th: [0.2, 0.5], range: [0, 2], unit: 'mm',
    tip: 'Mean head motion. <0.2 mm good.',
    longDesc: 'The average translational head displacement between consecutive fMRI volumes, computed from the 6 rigid-body motion parameters. Even sub-millimetre motion can introduce spin-history and susceptibility artefacts. The 0.2 mm threshold is widely used in connectivity research to define "low-motion" scans; studies consistently show that FD > 0.5 mm significantly distorts functional connectivity estimates.',
    papers: [
      { authors: 'Power JD, et al.', year: '2012', title: 'Spurious but systematic correlations in functional connectivity MRI networks arise from subject motion', journal: 'NeuroImage', doi: 'https://doi.org/10.1016/j.neuroimage.2011.10.018' },
      { authors: 'Jenkinson M, et al.', year: '2002', title: 'Improved optimization for the robust and accurate linear registration and motion correction of brain images', journal: 'NeuroImage', doi: 'https://doi.org/10.1016/S1053-8119(02)91132-8' },
    ],
  },
  {
    key: 'fwhm_avg', label: 'FWHM', desc: 'Spatial Blurring (avg)',
    dir: -1, th: [2.5, 4.0], range: [0, 8], unit: 'mm',
    tip: 'Average FWHM. <2.5 mm good.',
    longDesc: 'Estimates spatial smoothness of the mean fMRI volume. Excessive blurring reduces the spatial specificity of BOLD activations. Typical fMRI acquisitions (3 mm isotropic) should show FWHM around 3–5 mm after any additional smoothing. Very high values indicate heavy acquisition-level smoothing or motion-induced blurring.',
    papers: [
      { authors: 'Forman SD, et al.', year: '1995', title: 'Improved assessment of significant activation in functional magnetic resonance imaging', journal: 'Magn Reson Med', doi: 'https://doi.org/10.1002/mrm.1910330508' },
    ],
  },
  {
    key: 'aor', label: 'AOR', desc: 'AFNI Outlier Ratio',
    dir: -1, th: [0.05, 0.1], range: [0, 0.3], unit: '',
    tip: 'Fraction of timepoints with outlier signal. <0.05 good.',
    longDesc: 'The mean fraction of voxels per brain volume that AFNI\'s 3dToutcount identifies as outliers (beyond 3.27 standard deviations from the median). High AOR flags temporal instabilities in the scanner or sudden head-motion events, and is a sensitive indicator of poor scan quality even when FD appears acceptable.',
    papers: [
      { authors: 'Lemieux L, et al.', year: '2007', title: 'Modelling large motion events in fMRI studies of patients with epilepsy', journal: 'Magn Reson Imaging', doi: 'https://doi.org/10.1016/j.mri.2007.03.009' },
    ],
  },
  {
    key: 'dvars_std', label: 'DVARS', desc: 'Standardised DVARS',
    dir: -1, th: [1.0, 1.5], range: [0, 3], unit: '',
    tip: 'Std DVARS — signal intensity changes. <1 good.',
    longDesc: 'DVARS (D-temporal variance) measures the rate of change of fMRI signal across the brain from one volume to the next. The standardised version divides by the expected temporal standard deviation so the threshold is scan-independent. Spikes in DVARS identify volumes corrupted by head motion, RF interference, or scanner instabilities, and these volumes are typically excluded (scrubbed) before connectivity analyses.',
    papers: [
      { authors: 'Power JD, et al.', year: '2012', title: 'Spurious but systematic correlations in functional connectivity MRI networks arise from subject motion', journal: 'NeuroImage', doi: 'https://doi.org/10.1016/j.neuroimage.2011.10.018' },
      { authors: 'Nichols TE', year: '2017', title: 'Notes on creating a standardized version of DVARS', journal: 'arXiv', doi: 'https://arxiv.org/abs/1704.01469' },
    ],
  },
  {
    key: 'gsr_x', label: 'GSR-x', desc: 'Ghost-to-Signal Ratio (x)',
    dir: -1, th: [0.01, 0.05], range: [0, 0.2], unit: '',
    tip: 'Ghosting in x direction. <0.01 good.',
    longDesc: 'Measures the fraction of signal energy appearing as Nyquist ghosting along the phase-encoding (x) direction, relative to the total brain signal. Ghosting arises from eddy currents, motion, or imperfect timing between odd and even EPI echoes. High GSR indicates significant ghost artefacts that can corrupt functional signal in affected regions.',
    papers: [
      { authors: 'Giannelli M, et al.', year: '2010', title: 'Characterization of Nyquist ghost in EPI-fMRI acquisition sequences implemented on two clinical 1.5T MR scanner systems', journal: 'Phys Med', doi: 'https://doi.org/10.1016/j.ejmp.2009.10.003' },
    ],
  },
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

// Extract the desc-* part from an MRIQC figure filename.
// e.g.  sub-01/figures/sub-01_ses-baseline_desc-brainmask_T1w.svg  → 'brainmask'
function descOf(path) {
  const m = path.match(/desc-([^_]+)_/)
  return m ? m[1] : null
}

// ── CSV export ────────────────────────────────────────────────────────────────
// Flatten every subject's scalar IQMs into one wide CSV table.
// One row per subject; columns are the union of all scalar metric keys.
// Nested objects (bids_meta, provenance) are skipped to keep it tabular —
// the full JSON is always available in the downloaded results ZIP.
function buildMetricsCsv(jsonMetrics) {
  if (!jsonMetrics?.length) return ''
  const keySet = new Set()
  jsonMetrics.forEach(({ metrics }) => {
    Object.entries(metrics).forEach(([k, v]) => {
      if (v !== null && typeof v !== 'object') keySet.add(k)
    })
  })
  const keys   = [...keySet].sort()
  const header = ['bids_name', ...keys]
  const rows   = jsonMetrics.map(({ path, metrics }) => {
    const name = path.split('/').pop().replace('.json', '')
    return [name, ...keys.map(k => (metrics[k] == null ? '' : String(metrics[k])))]
  })
  const esc = c => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c
  return [header, ...rows].map(r => r.map(esc).join(',')).join('\n')
}

function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── MetricModal — detailed popup when a metric card is clicked ────────────────

function ThresholdScale({ def }) {
  const [rMin, rMax] = def.range
  const [good, mod]  = def.th
  const span = rMax - rMin

  // Convert a value in the metric's range to a % position on the scale bar
  const pct = v => Math.min(100, Math.max(0, ((v - rMin) / span) * 100))

  // For dir=+1: Good is on the right. For dir=-1: Good is on the left.
  const goodLeft = def.dir === 1 ? pct(good)  : 0
  const goodW    = def.dir === 1 ? 100 - pct(good)  : pct(good)
  const modLeft  = def.dir === 1 ? pct(mod)   : pct(good)
  const modW     = def.dir === 1 ? pct(good) - pct(mod) : pct(mod) - pct(good)
  const poorLeft = def.dir === 1 ? 0 : pct(mod)
  const poorW    = def.dir === 1 ? pct(mod) : 100 - pct(mod)

  const fmtV = v => def.unit ? `${v} ${def.unit}` : String(v)

  return (
    <div className={s.thScale}>
      <div className={s.thBar}>
        <div className={s.thSegPoor} style={{ left: `${poorLeft}%`, width: `${poorW}%` }} />
        <div className={s.thSegMod}  style={{ left: `${modLeft}%`,  width: `${modW}%`  }} />
        <div className={s.thSegGood} style={{ left: `${goodLeft}%`, width: `${goodW}%` }} />
        {/* Threshold markers */}
        <div className={s.thMarker}  style={{ left: `${pct(mod)}%`  }}>
          <div className={s.thMarkerLine} />
          <span className={s.thMarkerVal}>{fmtV(mod)}</span>
        </div>
        <div className={s.thMarker}  style={{ left: `${pct(good)}%` }}>
          <div className={s.thMarkerLine} />
          <span className={s.thMarkerVal}>{fmtV(good)}</span>
        </div>
      </div>
      <div className={s.thLabels}>
        {def.dir === 1
          ? <><span style={{color:'var(--red)'}}>● Poor</span><span style={{color:'var(--amber)'}}>● Fair</span><span style={{color:'var(--green)'}}>● Good</span></>
          : <><span style={{color:'var(--green)'}}>● Good</span><span style={{color:'var(--amber)'}}>● Fair</span><span style={{color:'var(--red)'}}>● Poor</span></>
        }
      </div>
      <div className={s.thHint}>
        {def.dir === 1
          ? `Higher is better — Good ≥ ${fmtV(good)}, Fair ${fmtV(mod)}–${fmtV(good)}, Poor < ${fmtV(mod)}`
          : `Lower is better — Good ≤ ${fmtV(good)}, Fair ${fmtV(good)}–${fmtV(mod)}, Poor > ${fmtV(mod)}`
        }
      </div>
    </div>
  )
}

function MetricModal({ def, value, onClose }) {
  const q    = qualityLevel(value, def)
  const na   = isNA(value)
  const disp = na ? '—' : `${Number(value).toFixed(4)}${def.unit ? ' ' + def.unit : ''}`
  const ref  = !na ? compareToRef(def.key, value, def.dir) : null

  // Close on overlay click or Escape
  const onKey = e => { if (e.key === 'Escape') onClose() }

  return (
    <div className={s.modalOverlay} onClick={onClose} onKeyDown={onKey} tabIndex={-1}>
      <div className={s.modal} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">

        {/* Header */}
        <div className={s.modalHead}>
          <div>
            <span className={s.modalLabel}>{def.label}</span>
            <span className={s.modalFullName}>{def.desc}</span>
          </div>
          <button className={s.modalClose} onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Your value */}
        <div className={s.modalValue}>
          <span className={s.modalValNum} style={{ color: Q_COLOR[q] }}>{disp}</span>
          <span className={s.modalBadge} style={{ background: Q_COLOR[q] + '22', color: Q_COLOR[q] }}>
            <span className={s.mcDot} style={{ background: Q_COLOR[q] }} />
            {Q_LABEL[q]}
          </span>
          {ref && (
            <span className={s.modalRef}>
              Better than {ref.qualityPct}% of {ref.refN} reference scans
            </span>
          )}
        </div>

        {/* What it measures */}
        <div className={s.modalSection}>
          <div className={s.modalSectionTitle}>What it measures</div>
          <p className={s.modalBody}>{def.longDesc}</p>
        </div>

        {/* Threshold scale */}
        <div className={s.modalSection}>
          <div className={s.modalSectionTitle}>Quality thresholds</div>
          <ThresholdScale def={def} />
        </div>

        {/* Papers */}
        {def.papers?.length > 0 && (
          <div className={s.modalSection}>
            <div className={s.modalSectionTitle}>Key references</div>
            <ul className={s.paperList}>
              {def.papers.map((p, i) => (
                <li key={i} className={s.paperItem}>
                  <div className={s.paperMeta}>
                    <span className={s.paperAuthors}>{p.authors}</span>
                    <span className={s.paperYear}>({p.year})</span>
                  </div>
                  <div className={s.paperTitle}>{p.title}</div>
                  <div className={s.paperJournal}>
                    <em>{p.journal}</em>
                    {p.doi && (
                      <a href={p.doi} target="_blank" rel="noreferrer" className={s.paperDoi}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                          <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                        </svg>
                        View paper
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

// ── MetricCard ────────────────────────────────────────────────────────────────

function MetricCard({ def, value }) {
  const [showModal, setShowModal] = useState(false)

  const q    = qualityLevel(value, def)
  const pct  = barPct(value, def)
  const na   = isNA(value)
  const disp = na ? '—'
    : `${Number(value).toFixed(2)}${def.unit ? ' ' + def.unit : ''}`

  // Reference population comparison
  const ref        = !na ? compareToRef(def.key, value, def.dir) : null
  const refBarPct  = ref ? barPct(ref.refMedian, def) : null

  return (
    <>
      <div className={`${s.metricCard} ${s.metricCardClickable}`}
        onClick={() => setShowModal(true)}
        role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setShowModal(true) }}
        title="Click for details and references"
      >
        <div className={s.mcTop}>
          <span className={s.mcLabel}>{def.label}</span>
          <span className={s.mcVal} style={{ color: Q_COLOR[q] }}>{disp}</span>
        </div>

        {/* Bar + reference-median tick */}
        <div className={s.mcTrack}>
          <div className={s.mcFill} style={{ width: `${pct}%`, background: Q_COLOR[q] }} />
          {refBarPct !== null && (
            <div className={s.mcRefTick} style={{ left: `${refBarPct}%` }} title="Reference median" />
          )}
        </div>

        <div className={s.mcDesc}>{def.desc}</div>

        <div className={s.mcBottom}>
          <div className={s.mcQ} style={{ color: Q_COLOR[q] }}>
            <span className={s.mcDot} style={{ background: Q_COLOR[q] }} />
            {Q_LABEL[q]}
          </div>
          {ref && (
            <span className={s.mcRef} title={`vs. ${ref.refN} OpenNeuro T1w reference scans`}>
              ↑ {ref.qualityPct}%
            </span>
          )}
        </div>

        {/* "Click for details" hint */}
        <div className={s.mcHint}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Details &amp; references
        </div>
      </div>

      {showModal && (
        <MetricModal def={def} value={value} onClose={() => setShowModal(false)} />
      )}
    </>
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

// ── FigureCard — one brain visualisation panel ────────────────────────────────

function FigureCard({ label, caption, blobUrl }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={`${s.figCard} ${expanded ? s.figCardExpanded : ''}`}>
      <button className={s.figHeader} onClick={() => setExpanded(e => !e)}>
        <span className={s.figLabel}>{label}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, transform: expanded ? 'rotate(180deg)' : 'none', transition: '0.2s' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {expanded && (
        <div className={s.figBody}>
          <img src={blobUrl} alt={label} className={s.figImg} />
          {caption && <p className={s.figCaption}>{caption}</p>}
        </div>
      )}
    </div>
  )
}

// ── HTML report iframe ────────────────────────────────────────────────────────
// Uses a blob URL so Bootstrap / jQuery load from CDN.
// svgBlobMap: { 'sub-01/figures/...svg': blobUrl, … } — rewritten into the
// HTML so the brain slice images actually render inside the iframe.

function HtmlFrame({ content, svgBlobMap, title }) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    // Rewrite every relative ./path/to/file.svg reference in the HTML with
    // its blob URL so the browser resolves it from the in-memory ZIP entry.
    let html = content
    Object.entries(svgBlobMap).forEach(([path, blobUrl]) => {
      // MRIQC uses both  src="./sub-01/…"  (img) and  data="./sub-01/…"  (object)
      html = html.replaceAll(`"./${path}"`, `"${blobUrl}"`)
      html = html.replaceAll(`'./${path}'`, `'${blobUrl}'`)
    })
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const u    = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [content, svgBlobMap])

  return (
    <iframe
      className={s.htmlFrame}
      src={url ?? 'about:blank'}
      title={title}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    />
  )
}

// ── Main exported component ───────────────────────────────────────────────────

export default function MriqcReport({ jsonMetrics, htmlFiles, svgFigures }) {
  const [subjectIdx, setSubjectIdx] = useState(0)
  const [openHtml,   setOpenHtml]   = useState(null)

  // Auto-open first HTML report
  useEffect(() => {
    if (htmlFiles?.length > 0) setOpenHtml(htmlFiles[0].path)
  }, [htmlFiles])

  const subject  = jsonMetrics?.[subjectIdx]
  const m        = subject?.metrics ?? {}
  const meta     = m.bids_meta ?? {}

  const isBold   = m.tsnr !== undefined
  const defs     = isBold ? BOLD_DEFS : ANAT_DEFS
  const modLabel = meta.modality ?? (isBold ? 'BOLD' : 'T1w')

  const rawField = Number(meta.MagneticFieldStrength)
  const fieldT   = !isNaN(rawField) && rawField > 0
    ? (rawField > 100 ? rawField / 10000 : rawField).toFixed(1) + ' T'
    : null

  const scanner = [meta.Manufacturer, meta.ManufacturersModelName].filter(Boolean).join(' ')

  const subId = meta.subject_id ?? subject?.path?.split('/')[0]?.replace('sub-', '') ?? '?'
  const sesId = meta.session_id ?? ''

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

  const snrTissues = [
    { label: 'CSF', key: 'snr_csf', color: 'var(--blue)' },
    { label: 'GM',  key: 'snr_gm',  color: 'var(--purple)' },
    { label: 'WM',  key: 'snr_wm',  color: 'var(--teal)' },
  ]
  const maxSnr = Math.max(...snrTissues.map(t => m[t.key] ?? 0), 0.01)

  const acqRows = [
    { label: 'Matrix',          value: m.size_x && m.size_y ? `${m.size_x} × ${m.size_y}` : null },
    { label: 'Slices',          value: m.size_z ?? null },
    { label: 'Voxel (x/y)',     value: m.spacing_x && m.spacing_y ? `${m.spacing_x.toFixed(3)} × ${m.spacing_y.toFixed(3)} mm` : null },
    { label: 'Slice thickness', value: meta.SliceThickness != null ? `${meta.SliceThickness} mm` : null },
    { label: 'Slice gap',       value: meta.SpacingBetweenSlices != null ? `${meta.SpacingBetweenSlices} mm` : null },
    { label: 'TR',              value: meta.RepetitionTime != null ? `${(meta.RepetitionTime * 1000).toFixed(0)} ms` : null },
    { label: 'TE',              value: meta.EchoTime != null ? `${(meta.EchoTime * 1000).toFixed(1)} ms` : null },
    { label: 'Flip angle',      value: meta.FlipAngle != null ? `${meta.FlipAngle}°` : null },
    { label: 'Field strength',  value: fieldT },
    { label: 'Sequence',        value: meta.ScanningSequence ?? null },
    { label: 'Protocol',        value: meta.ProtocolName ?? meta.SeriesDescription ?? null },
    { label: 'SAR',             value: meta.SAR != null ? meta.SAR.toFixed(2) : null },
  ].filter(r => r.value != null)

  // ── SVG blob URL map ────────────────────────────────────────────────────────
  // Create one blob URL per SVG figure and clean them up on unmount / update.
  // The map is also passed to HtmlFrame so the iframe can resolve the images.
  const [svgBlobMap, setSvgBlobMap] = useState({})

  useEffect(() => {
    if (!svgFigures?.length) return
    const map = {}
    svgFigures.forEach(({ path, content }) => {
      const blob = new Blob([content], { type: 'image/svg+xml' })
      map[path] = URL.createObjectURL(blob)
    })
    setSvgBlobMap(map)
    return () => Object.values(map).forEach(u => URL.revokeObjectURL(u))
  }, [svgFigures])

  // ── Figures for the selected subject ───────────────────────────────────────
  // Filter to this subject's SVGs, then sort by canonical FIG_ORDER.
  const subjectFigs = useMemo(() => {
    if (!svgFigures?.length || !subId || subId === '?') return []
    const prefix = `sub-${subId}/`
    return svgFigures
      .filter(f => f.path.startsWith(prefix))
      // If a session is selected, only show that session's figures
      .filter(f => !sesId || f.path.includes(`_ses-${sesId}_`) || f.path.includes(`ses-${sesId}/`))
      .map(f => {
        const desc = descOf(f.path)
        const def  = FIG_DEFS.find(d => d.desc === desc) ?? { label: desc ?? f.path.split('/').pop(), caption: '' }
        return { ...f, desc, label: def.label, caption: def.caption, order: FIG_ORDER[desc] ?? 99 }
      })
      .sort((a, b) => a.order - b.order)
  }, [svgFigures, subId, sesId])

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
          <div className={s.sectionRow}>
            <SectionTitle icon={
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
              </svg>
            }>
              Image Quality Metrics
            </SectionTitle>
            <button
              className={s.exportBtn}
              onClick={() => {
                const csv  = buildMetricsCsv(jsonMetrics)
                const name = jsonMetrics.length > 1
                  ? `mriqc_iqms_${jsonMetrics.length}subjects.csv`
                  : `mriqc_iqms_sub-${subId}.csv`
                downloadCsv(csv, name)
              }}
              title="Download every computed IQM for all subjects as a CSV spreadsheet"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Export CSV
            </button>
          </div>
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

          {/* ── Brain figures (inline SVG gallery) ──────────────────────── */}
          {subjectFigs.length > 0 && (
            <>
              <SectionTitle icon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
              }>
                Brain Figures
              </SectionTitle>
              <p className={s.htmlNote}>
                Click any panel to expand the brain visualisation. These are the same images shown in the full MRIQC report below.
              </p>
              <div className={s.figGrid}>
                {subjectFigs.map(fig => (
                  <FigureCard
                    key={fig.path}
                    label={fig.label}
                    caption={fig.caption}
                    blobUrl={svgBlobMap[fig.path]}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* ── MRIQC HTML visual reports (full iframe) ──────────────────────── */}
      {htmlFiles && htmlFiles.length > 0 && (
        <>
          <SectionTitle icon={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
            </svg>
          }>
            Full MRIQC Report
          </SectionTitle>
          <p className={s.htmlNote}>
            Complete MRIQC HTML report with all brain slice mosaics, IQM plots, and the QC rating widget.
          </p>
          <div className={s.htmlList}>
            {htmlFiles.map(({ path, content }) => {
              const name = path.split('/').pop()
              const open = openHtml === path
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
                  {open && (
                    <HtmlFrame
                      content={content}
                      svgBlobMap={svgBlobMap}
                      title={name}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
