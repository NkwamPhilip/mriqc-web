import { Link } from 'react-router-dom'
import s from './Footer.module.css'

export default function Footer() {
  return (
    <footer className={s.footer}>
      <div className={`${s.inner} container`}>
        <div className={s.brand}>
          <div className={s.logo}>
            <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="13" stroke="#00C8B4" strokeWidth="1.4"/>
              <ellipse cx="16" cy="16" rx="7.5" ry="6.5" fill="none" stroke="#00C8B4" strokeWidth="1.2"/>
              <circle cx="16" cy="16" r="2.2" fill="#00C8B4" opacity="0.7"/>
            </svg>
            <span className={s.logoText}>Web<span className={s.logoAccent}>MRIQC</span></span>
          </div>
          <p className={s.tagline}>
            Automated MRI quality control for neuroimaging research. Powered by the open-source MRIQC pipeline.
          </p>
          <p className={s.lab}>
            Medical Artificial Intelligence Lab<br />
            <a href="mailto:info@mailab.io" className={s.email}>info@mailab.io</a>
          </p>
        </div>

        <div className={s.cols}>
          <div className={s.col}>
            <h4 className={s.colTitle}>Platform</h4>
            <Link to="/analyze" className={s.colLink}>Launch App</Link>
            <a href="/#how-it-works" className={s.colLink}>How It Works</a>
            <a href="/#iqm-guide" className={s.colLink}>IQM Guide</a>
            <a href="/#references" className={s.colLink}>References</a>
          </div>
          <div className={s.col}>
            <h4 className={s.colTitle}>Resources</h4>
            <a href="https://mriqc.readthedocs.io" target="_blank" rel="noreferrer" className={s.colLink}>MRIQC Docs</a>
            <a href="https://bids.neuroimaging.io" target="_blank" rel="noreferrer" className={s.colLink}>BIDS Standard</a>
            <a href="https://github.com/nipreps/mriqc" target="_blank" rel="noreferrer" className={s.colLink}>GitHub</a>
          </div>
          <div className={s.col}>
            <h4 className={s.colTitle}>Modalities</h4>
            <span className={s.colText}>T1w Anatomical</span>
            <span className={s.colText}>T2w Anatomical</span>
            <span className={s.colText}>BOLD fMRI</span>
            <span className={s.colText}>DWI / ASL</span>
          </div>
        </div>
      </div>
      <div className={s.bar}>
        <div className="container">
          <p>© 2025 Medical Artificial Intelligence Lab. All rights reserved.</p>
          <p>Built on <a href="https://mriqc.readthedocs.io" target="_blank" rel="noreferrer">MRIQC</a> by NiPreps — <a href="https://doi.org/10.1371/journal.pone.0184661" target="_blank" rel="noreferrer">Esteban et al., 2017</a></p>
        </div>
      </div>
    </footer>
  )
}
