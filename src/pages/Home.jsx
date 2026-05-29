import { useState } from 'react'
import { Link } from 'react-router-dom'
import s from './Home.module.css'
import BrainModel from '../components/BrainModel'

// ─── Brain 3D Visualization ────────────────────────────────────────────────
function BrainVisual() {
  return (
    <div className={s.brainWrapper}>
      <div className={s.brainGlow} />

      {/* 3-D rotating brain model */}
      <BrainModel className={s.brainSvg} />

      {/* Static overlay: corner markers + scanner metadata */}
      <svg
        viewBox="0 0 360 360"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      >
        <path d="M28,28 L43,28 M28,28 L28,43" stroke="rgba(0,200,180,0.5)" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M332,28 L317,28 M332,28 L332,43" stroke="rgba(0,200,180,0.5)" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M28,332 L43,332 M28,332 L28,317" stroke="rgba(0,200,180,0.5)" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M332,332 L317,332 M332,332 L332,317" stroke="rgba(0,200,180,0.5)" strokeWidth="1.5" strokeLinecap="round" />
        <text x="33" y="46" fill="rgba(0,200,180,0.55)" fontSize="8" fontFamily="'JetBrains Mono', monospace">3T AXIAL T1w</text>
        <text x="33" y="340" fill="rgba(0,200,180,0.45)" fontSize="7.5" fontFamily="'JetBrains Mono', monospace">TR:2000 TE:2.5ms</text>
        <text x="234" y="340" fill="rgba(0,200,180,0.45)" fontSize="7.5" fontFamily="'JetBrains Mono', monospace">FOV:256 1mm ISO</text>
      </svg>

      {/* Floating metric badges */}
      <div className={`${s.badge} ${s.badge1}`}>
        <span className={s.badgeLabel}>CNR</span>
        <span className={s.badgeVal}>3.42</span>
        <span className={s.badgeOk}>✓ Good</span>
      </div>
      <div className={`${s.badge} ${s.badge2}`}>
        <span className={s.badgeLabel}>tSNR</span>
        <span className={s.badgeVal}>45.2 ms</span>
        <span className={s.badgeOk}>✓ Good</span>
      </div>
      <div className={`${s.badge} ${s.badge3}`}>
        <span className={s.badgeLabel}>FD</span>
        <span className={s.badgeVal}>0.18 mm</span>
        <span className={s.badgeOk}>✓ Good</span>
      </div>
      <div className={`${s.badge} ${s.badge4}`}>
        <span className={s.badgeLabel}>EFC</span>
        <span className={s.badgeVal}>0.52</span>
        <span className={s.badgeMed}>● Moderate</span>
      </div>

      {/* Scan line animation */}
      <div className={s.scanLine} />
    </div>
  )
}

// ─── Hero ───────────────────────────────────────────────────────────────────
function HeroSection() {
  return (
    <section className={s.hero}>
      <div className={s.heroBg} />
      <div className={s.heroGrid} />
      <div className={`${s.heroInner} container`}>
        <div className={s.heroLeft}>
          <div className={s.heroBadge}>
            <span className={s.heroBadgeDot} />
            Powered by MAILAB · BIDS Standard · Open Science
          </div>
          <h1 className={s.heroTitle}>
            Automated Brain Image<br />
            <span className="gradient-text">Quality Control</span>
          </h1>
          <p className={s.heroDesc}>
            Upload your BIDS-formatted neuroimaging datasets and receive comprehensive Image Quality Metrics in minutes — no software installation, no command line, no cluster required.
          </p>
          <div className={s.heroCtas}>
            <Link to="/analyze" className="btn-primary" style={{ fontSize: '1rem', padding: '15px 32px' }}>
              Launch App
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </Link>
            <a href="#iqm-guide" className="btn-outline" style={{ fontSize: '1rem', padding: '14px 30px' }}>
              Explore IQMs
            </a>
          </div>
          <div className={s.heroMeta}>
            <span>T1w · T2w · BOLD · DWI · ASL</span>
            <span className={s.dot}>·</span>
            <span>50+ Quality Metrics</span>
            <span className={s.dot}>·</span>
            <span>BIDS v1.6</span>
          </div>
        </div>
        <div className={s.heroRight}>
          <BrainVisual />
        </div>
      </div>
    </section>
  )
}

// ─── Stats ──────────────────────────────────────────────────────────────────
function StatsBar() {
  const stats = [
    {
      value: '50+', label: 'Image Quality Metrics',
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="18" y="3" width="4" height="18" rx="1" /><rect x="10" y="8" width="4" height="13" rx="1" /><rect x="2" y="13" width="4" height="8" rx="1" />
        </svg>
      ),
    },
    {
      value: '5', label: 'MRI Modalities Supported',
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="2" /><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4" /><path d="M3.1 3.1a13 13 0 0 0 0 17.8M20.9 3.1a13 13 0 0 1 0 17.8" />
        </svg>
      ),
    },
    {
      value: 'BIDS v1.6', label: 'Standard Compliant',
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" />
        </svg>
      ),
    },
    {
      value: '~10 min', label: 'Processing Time',
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
        </svg>
      ),
    },
  ]
  return (
    <div className={s.stats}>
      <div className={`${s.statsInner} container`}>
        {stats.map((st) => (
          <div key={st.label} className={s.stat}>
            <span className={s.statIcon}>{st.icon}</span>
            <span className={s.statVal}>{st.value}</span>
            <span className={s.statLabel}>{st.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Pipeline / How It Works ─────────────────────────────────────────────────
function PipelineSection() {
  const steps = [
    {
      num: '01',
      title: 'Prepare BIDS Data',
      desc: 'Convert your DICOM files to BIDS format using dcm2bids. Zip the dataset folder.',
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      ),
      badge: null,
    },
    {
      num: '02',
      title: 'Upload ZIP',
      desc: 'Drag and drop your BIDS ZIP into WebMRIQC. Enter subject ID and session details.',
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 16 12 12 8 16" />
          <line x1="12" y1="12" x2="12" y2="21" />
          <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
        </svg>
      ),
      badge: null,
    },
    {
      num: '03',
      title: 'Cloud Processing',
      desc: 'Your BIDS data is sent to our MRIQC server. The pipeline computes all IQMs automatically.',
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07M8.46 15.54a5 5 0 0 1 0-7.07" />
        </svg>
      ),
      badge: 'WebMRIQC',
    },
    {
      num: '04',
      title: 'Download Reports',
      desc: 'Get interactive HTML reports, TSV metrics tables, and a full results ZIP — ready to publish.',
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      ),
      badge: null,
    },
  ]

  return (
    <section id="how-it-works" className={s.pipeline}>
      <div className="container">
        <div className={s.sectionHead}>
          <span className={s.sectionTag}>Workflow</span>
          <h2 className={s.sectionTitle}>From DICOM to Quality Report</h2>
          <p className={s.sectionDesc}>
            A streamlined four-step process from raw DICOM acquisition to publication-ready quality metrics.
          </p>
        </div>
        <div className={s.steps}>
          {steps.map((step, i) => (
            <div key={step.num} className={s.step}>
              <div className={`${s.stepIcon} ${step.badge ? s.stepIconActive : ''}`}>
                {step.icon}
                {step.badge && <span className={s.stepBadge}>{step.badge}</span>}
              </div>
              <div className={s.stepNum}>{step.num}</div>
              <h3 className={s.stepTitle}>{step.title}</h3>
              <p className={s.stepDesc}>{step.desc}</p>
              {i < steps.length - 1 && <div className={s.connector} />}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Features ───────────────────────────────────────────────────────────────
function FeaturesSection() {
  const features = [
    {
      color: 'teal',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      ),
      title: 'No Installation Required',
      desc: 'Runs entirely in your browser. No Python, no Docker, no cluster access needed. Just a ZIP file.',
    },
    {
      color: 'blue',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      ),
      title: '50+ Image Quality Metrics',
      desc: 'CNR, SNR, EFC, FBER, FD, tSNR, DVARS and many more — computed by the gold-standard MRIQC engine.',
    },
    {
      color: 'teal',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      ),
      title: '5 MRI Modalities',
      desc: 'Full support for T1w, T2w anatomical, BOLD fMRI, DWI diffusion, and ASL perfusion imaging.',
    },
    {
      color: 'teal',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
      title: 'BIDS Standard Compliant',
      desc: 'Strict adherence to the Brain Imaging Data Structure (BIDS) v1.6 specification for reproducibility.',
    },
    {
      color: 'blue',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      ),
      title: 'Interactive HTML Reports',
      desc: 'Publication-ready visual reports with per-participant metrics, group-level TSV tables, and embedded figures.',
    },
    {
      color: 'white',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      ),
      title: '~10-Minute Turnaround',
      desc: 'Powered by cloud infrastructure with configurable CPU and memory. Results delivered in minutes, not hours.',
    },
  ]

  return (
    <section className={s.features}>
      <div className="container">
        <div className={s.sectionHead}>
          <span className={s.sectionTag}>Capabilities</span>
          <h2 className={s.sectionTitle}>Everything You Need for MRI QC</h2>
          <p className={s.sectionDesc}>Built for neuroscientists, clinical researchers, and radiographers who need fast, reliable quality assessment.</p>
        </div>
        <div className={s.featGrid}>
          {features.map((f) => (
            <div key={f.title} className={`${s.featCard} ${s['feat_' + f.color]}`}>
              <div className={`${s.featIcon} ${s['featIcon_' + f.color]}`}>{f.icon}</div>
              <h3 className={s.featTitle}>{f.title}</h3>
              <p className={s.featDesc}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── IQM Reference ───────────────────────────────────────────────────────────
const anatomicalIQMs = [
  { abbr: 'CNR', name: 'Contrast-to-Noise Ratio', desc: 'Measures how well different tissues (GM/WM) are distinguished. Higher CNR → better tissue contrast.', good: 'Higher is better', range: '> 2.5' },
  { abbr: 'SNR', name: 'Signal-to-Noise Ratio', desc: 'Signal strength relative to background noise. Higher SNR → cleaner, clearer images.', good: 'Higher is better', range: '> 10' },
  { abbr: 'EFC', name: 'Entropy Focus Criterion', desc: 'Quantifies image sharpness via Shannon entropy. Higher EFC → more ghosting/blurring.', good: 'Lower is better', range: '< 0.6' },
  { abbr: 'FBER', name: 'Foreground–Background Energy Ratio', desc: 'Energy inside the brain mask vs. outside. Higher FBER → better tissue delineation.', good: 'Higher is better', range: '> 500' },
  { abbr: 'FWHM', name: 'Full Width at Half Maximum', desc: 'Estimates spatial smoothness. Lower FWHM → sharper images (protocol-dependent).', good: 'Lower is better', range: '< 3 mm' },
  { abbr: 'INU', name: 'Intensity Non-Uniformity', desc: 'Evaluates bias field from scanner imperfections. Higher INU → more uneven signal.', good: 'Lower is better', range: '< 0.1' },
  { abbr: 'Art_QI1', name: 'Quality Index 1', desc: 'Measures artifacts outside the brain. Higher QI1 → more motion or ghosting artifacts.', good: 'Lower is better', range: '< 0.01' },
  { abbr: 'Art_QI2', name: 'Quality Index 2', desc: 'Detects structured noise via chi-squared goodness-of-fit. Higher QI2 → signal inconsistency.', good: 'Lower is better', range: '< 0.01' },
  { abbr: 'WM2MAX', name: 'WM-to-Max Intensity Ratio', desc: 'White matter intensity vs. max signal. Extreme values indicate normalization or acquisition issues.', good: 'Near 0.6–0.8', range: '0.6–0.8' },
]

const functionalIQMs = [
  { abbr: 'FD', name: 'Framewise Displacement', desc: 'Quantifies head movement across volumes. Higher FD → more motion artifacts.', good: 'Lower is better', range: '< 0.2 mm' },
  { abbr: 'DVARS', name: 'D Temporal Variance', desc: 'Signal change between consecutive volumes. Spikes indicate motion or noise events.', good: 'Lower is better', range: '< 1.5 %BOLD' },
  { abbr: 'tSNR', name: 'Temporal SNR', desc: 'Mean/std of the time series per voxel over time. Higher tSNR → more reliable BOLD signal.', good: 'Higher is better', range: '> 40' },
  { abbr: 'GCOR', name: 'Global Correlation', desc: 'Global signal fluctuations across the brain. Elevated GCOR may reflect widespread noise.', good: 'Lower is better', range: '< 0.05' },
  { abbr: 'AOR', name: 'AFNI Outlier Ratio', desc: 'Proportion of voxels flagged as outliers. High AOR → poor scan quality or significant motion.', good: 'Lower is better', range: '< 0.05' },
  { abbr: 'GSR', name: 'Global Signal Regression Impact', desc: 'Effect of global signal removal on BOLD contrast. Large differences can affect downstream connectivity analyses.', good: 'Near zero', range: '~ 0' },
]

function IQMReferenceSection() {
  const [tab, setTab] = useState('anatomical')

  const iqms = tab === 'anatomical' ? anatomicalIQMs : functionalIQMs

  return (
    <section id="iqm-guide" className={s.iqm}>
      <div className="container">
        <div className={s.sectionHead}>
          <span className={s.sectionTag}>Reference</span>
          <h2 className={s.sectionTitle}>Image Quality Metrics Guide</h2>
          <p className={s.sectionDesc}>
            Comprehensive reference for all IQMs computed by MRIQC. For deep technical details, see the{' '}
            <a href="https://mriqc.readthedocs.io/en/latest/iqms/iqms.html" target="_blank" rel="noreferrer" className={s.iqmLink}>
              official MRIQC documentation
            </a>.
          </p>
        </div>

        <div className={s.iqmTabs}>
          <button
            className={`${s.iqmTab} ${tab === 'anatomical' ? s.iqmTabActive : ''}`}
            onClick={() => setTab('anatomical')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="8" r="6" />
              <path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11" />
            </svg>
            Anatomical (T1w / T2w)
          </button>
          <button
            className={`${s.iqmTab} ${tab === 'functional' ? s.iqmTabActive : ''}`}
            onClick={() => setTab('functional')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            Functional (BOLD fMRI)
          </button>
        </div>

        <div className={s.iqmTable}>
          <div className={s.iqmTableHead}>
            <span>Metric</span>
            <span>Full Name</span>
            <span>Description</span>
            <span>Interpretation</span>
          </div>
          {iqms.map((m) => (
            <div key={m.abbr} className={s.iqmRow}>
              <div className={s.iqmAbbr}>{m.abbr}</div>
              <div className={s.iqmName}>{m.name}</div>
              <div className={s.iqmDesc}>{m.desc}</div>
              <div className={s.iqmInterpret}>
                <span className={s.iqmGood}>{m.good}</span>
                <code className={s.iqmRange}>{m.range}</code>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── CTA Banner ──────────────────────────────────────────────────────────────
function CTABanner() {
  return (
    <section className={s.cta}>
      <div className="container">
        <div className={s.ctaCard}>
          <div className={s.ctaGlow} />
          <div className={s.ctaContent}>
            <h2 className={s.ctaTitle}>Ready to assess your MRI data?</h2>
            <p className={s.ctaDesc}>
              Upload your BIDS dataset and get comprehensive quality metrics in minutes.
              No account, no installation, no fee.
            </p>
            <Link to="/analyze" className="btn-primary" style={{ fontSize: '1.05rem', padding: '15px 36px' }}>
              Start Quality Assessment
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── References ──────────────────────────────────────────────────────────────
function ReferencesSection() {
  const refs = [
    {
      num: '1',
      authors: 'Boré A, Guay S, Bedetti C, Meisler S, & GuenTher N.',
      year: '2023',
      title: 'Dcm2Bids',
      version: 'Version 3.1.1',
      doi: 'https://doi.org/10.5281/zenodo.8436509',
      doiLabel: '10.5281/zenodo.8436509',
    },
    {
      num: '2',
      authors: 'Li X, Morgan PS, Ashburner J, Smith J, Rorden C.',
      year: '2016',
      title: 'The first step for neuroimaging data analysis: DICOM to NIfTI conversion',
      journal: 'J Neurosci Methods',
      pages: '264:47–56',
      doi: null,
    },
    {
      num: '3',
      authors: 'Esteban O, Birman D, Schaer M, Koyejo OO, Poldrack RA, Gorgolewski KJ.',
      year: '2017',
      title: 'MRIQC: Advancing the automatic prediction of image quality in MRI from unseen sites',
      journal: 'PLoS ONE',
      pages: '12(9): e0184661',
      doi: 'https://doi.org/10.1371/journal.pone.0184661',
      doiLabel: '10.1371/journal.pone.0184661',
    },
  ]

  return (
    <section id="references" className={s.refs}>
      <div className="container">
        <div className={s.sectionHead}>
          <span className={s.sectionTag}>Citations</span>
          <h2 className={s.sectionTitle}>References</h2>
          <p className={s.sectionDesc}>If WebMRIQC contributes to your research, please cite these foundational works.</p>
        </div>
        <div className={s.refsList}>
          {refs.map((r) => (
            <div key={r.num} className={s.ref}>
              <span className={s.refNum}>[{r.num}]</span>
              <div className={s.refContent}>
                <p className={s.refText}>
                  <span className={s.refAuthors}>{r.authors}</span>
                  {' '}({r.year}). <em>{r.title}</em>
                  {r.version && <span> ({r.version})</span>}
                  {r.journal && <span>. <em>{r.journal}</em>, {r.pages}</span>}.
                </p>
                {r.doi && (
                  <a href={r.doi} target="_blank" rel="noreferrer" className={s.refDoi}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    {r.doiLabel}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function Home() {
  return (
    <main>
      <HeroSection />
      <StatsBar />
      <PipelineSection />
      <FeaturesSection />
      <IQMReferenceSection />
      <CTABanner />
      <ReferencesSection />
    </main>
  )
}
