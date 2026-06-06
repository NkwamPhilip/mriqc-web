import { useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { resetPassword } from '../lib/api'
import s from './Auth.module.css'

function Logo() {
  return (
    <div className={s.logo}>
      <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="13" stroke="#00C8B4" strokeWidth="1.4"/>
        <ellipse cx="16" cy="16" rx="7.5" ry="6.5" fill="none" stroke="#00C8B4" strokeWidth="1.2"/>
        <circle cx="16" cy="16" r="2.2" fill="#00C8B4" opacity="0.7"/>
      </svg>
      <span className={s.logoText}>Web<span className={s.logoAccent}>MRIQC</span></span>
    </div>
  )
}

export default function ResetPassword() {
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail]       = useState(location.state?.email || '')
  const [code, setCode]         = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [busy, setBusy]         = useState(false)
  const [done, setDone]         = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    setBusy(true)
    try {
      await resetPassword({ email, code: code.trim(), password })
      setDone(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className={s.page}>
        <div className={s.card}>
          <Logo />
          <h1 className={s.title}>Password reset ✓</h1>
          <p className={s.subtitle}>Your password has been updated. You can now sign in with it.</p>
          <button className={s.submit} onClick={() => navigate('/login')}>Go to sign in</button>
        </div>
      </div>
    )
  }

  return (
    <div className={s.page}>
      <div className={s.card}>
        <Logo />
        <h1 className={s.title}>Enter reset code</h1>
        <p className={s.subtitle}>Paste the 6-digit code from your email and choose a new password.</p>

        <form className={s.form} onSubmit={submit}>
          {error && <p className={s.error}>⚠️ {error}</p>}

          <div className={s.field}>
            <label className={s.label}>Email</label>
            <input className={s.input} type="email" autoComplete="email" required
              value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@institution.edu" />
          </div>

          <div className={s.field}>
            <label className={s.label}>Reset code</label>
            <input className={s.input} inputMode="numeric" pattern="[0-9]*" maxLength={6} required
              value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="123456"
              style={{ letterSpacing: '0.4em', fontFamily: 'var(--font-mono, monospace)' }} />
          </div>

          <div className={s.field}>
            <label className={s.label}>New password</label>
            <input className={s.input} type="password" autoComplete="new-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters" />
          </div>

          <button className={s.submit} type="submit" disabled={busy}>
            {busy ? 'Resetting…' : 'Reset password'}
          </button>
        </form>

        <p className={s.footer}>
          Need a new code? <Link to="/forgot-password" className={s.footerLink}>Request again</Link>
        </p>
      </div>
    </div>
  )
}
