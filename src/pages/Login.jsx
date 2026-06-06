import { useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
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

export default function Login() {
  const { login } = useAuth()
  const navigate  = useNavigate()
  const location  = useLocation()
  const dest      = location.state?.from || '/submissions'

  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [busy, setBusy]         = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError(''); setBusy(true)
    try {
      await login({ email, password })
      navigate(dest)
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
        <h1 className={s.title}>Welcome back</h1>
        <p className={s.subtitle}>Sign in to track your submissions and results.</p>

        <form className={s.form} onSubmit={submit}>
          {error && <p className={s.error}>⚠️ {error}</p>}

          <div className={s.field}>
            <label className={s.label}>Email</label>
            <input className={s.input} type="email" autoComplete="email" required
              value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@institution.edu" />
          </div>

          <div className={s.field}>
            <label className={s.label}>Password</label>
            <input className={s.input} type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••" />
          </div>

          <button className={s.submit} type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p className={s.footer}>
          No account? <Link to="/register" className={s.footerLink}>Create one</Link>
        </p>
        <p className={s.guestNote}>
          You can also <Link to="/analyze" className={s.guestLink}>continue as a guest</Link> — no account needed to run MRIQC.
        </p>
      </div>
    </div>
  )
}
