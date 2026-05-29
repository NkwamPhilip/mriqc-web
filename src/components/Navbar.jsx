import { Link, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import s from './Navbar.module.css'

export default function Navbar() {
  const { pathname } = useLocation()
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [])

  useEffect(() => { setMenuOpen(false) }, [pathname])

  return (
    <header className={`${s.header} ${scrolled ? s.scrolled : ''}`}>
      <nav className={`${s.nav} container`}>
        <Link to="/" className={s.logo}>
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="16" cy="16" r="13" stroke="#00C8B4" strokeWidth="1.4"/>
            <ellipse cx="16" cy="16" rx="7.5" ry="6.5" fill="none" stroke="#00C8B4" strokeWidth="1.2"/>
            <line x1="16" y1="11" x2="16" y2="21" stroke="#3B82F6" strokeWidth="0.9" strokeDasharray="2,2"/>
            <line x1="11" y1="16" x2="21" y2="16" stroke="#3B82F6" strokeWidth="0.9" strokeDasharray="2,2"/>
            <circle cx="16" cy="16" r="2.2" fill="#00C8B4" opacity="0.7"/>
          </svg>
          <span className={s.logoText}>
            Web<span className={s.logoAccent}>MRIQC</span>
          </span>
        </Link>

        <div className={`${s.links} ${menuOpen ? s.open : ''}`}>
          <a href="/#how-it-works" className={s.link} onClick={() => setMenuOpen(false)}>How It Works</a>
          <a href="/#iqm-guide" className={s.link} onClick={() => setMenuOpen(false)}>IQM Guide</a>
          <a href="/#references" className={s.link} onClick={() => setMenuOpen(false)}>References</a>
          <Link to="/compare" className={s.link} onClick={() => setMenuOpen(false)}>Multicenter</Link>
          <Link to="/analyze" className="btn-primary" style={{ padding: '10px 22px', fontSize: '0.88rem' }}>
            Launch App
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </Link>
        </div>

        <button
          className={`${s.burger} ${menuOpen ? s.burgerOpen : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Toggle menu"
        >
          <span /><span /><span />
        </button>
      </nav>
    </header>
  )
}
