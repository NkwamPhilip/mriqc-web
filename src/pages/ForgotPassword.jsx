import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { forgotPassword } from '../lib/api'
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

export default function ForgotPassword() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy]   = useState(false)
  const [sent, setSent]   = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError(''); setBusy(true)
    try {
      await forgotPassword({ email })
      setSent(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={s.page}>
      <div className={s.card}>
        <Logo />
        <h1 className={s.title}>Reset your password</h1>

        {sent ? (
          <>
            <p className={s.subtitle}>
              If an account exists for <strong>{email}</strong>, we've emailed a
              6-digit reset code. It expires in 15 minutes.
            </p>
            <button
              className={s.submit}
              onClick={() => navigate('/reset-password', { state: { email } })}
            >
              Enter reset code
            </button>
            <p className={s.footer}>
              Didn't get it? <button className={s.footerLink} style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setSent(false)}>Try again</button>
            </p>
          </>
        ) : (
          <>
            <p className={s.subtitle}>Enter your email and we'll send you a reset code.</p>
            <form className={s.form} onSubmit={submit}>
              {error && <p className={s.error}>⚠️ {error}</p>}
              <div className={s.field}>
                <label className={s.label}>Email</label>
                <input className={s.input} type="email" autoComplete="email" required
                  value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@institution.edu" />
              </div>
              <button className={s.submit} type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Send reset code'}
              </button>
            </form>
            <p className={s.footer}>
              Remembered it? <Link to="/login" className={s.footerLink}>Back to sign in</Link>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
