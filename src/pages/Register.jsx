import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
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

export default function Register() {
  const { register } = useAuth()
  const navigate     = useNavigate()

  const [form, setForm] = useState({ name: '', institution: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy]   = useState(false)

  const change = (k, v) => setForm((p) => ({ ...p, [k]: v }))

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    setBusy(true)
    try {
      await register(form)
      navigate('/submissions')
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
        <h1 className={s.title}>Create your account</h1>
        <p className={s.subtitle}>Track every submission and revisit your results.</p>

        <form className={s.form} onSubmit={submit}>
          {error && <p className={s.error}>⚠️ {error}</p>}

          <div className={s.field}>
            <label className={s.label}>Full name</label>
            <input className={s.input} required value={form.name}
              onChange={(e) => change('name', e.target.value)} placeholder="Dr. Ada Okafor" />
          </div>

          <div className={s.field}>
            <label className={s.label}>Institution / Lab <span style={{ textTransform: 'none', color: 'var(--text-3)' }}>(optional)</span></label>
            <input className={s.input} value={form.institution}
              onChange={(e) => change('institution', e.target.value)} placeholder="University of Lagos · MAILAB" />
          </div>

          <div className={s.field}>
            <label className={s.label}>Email</label>
            <input className={s.input} type="email" autoComplete="email" required value={form.email}
              onChange={(e) => change('email', e.target.value)} placeholder="you@institution.edu" />
          </div>

          <div className={s.field}>
            <label className={s.label}>Password</label>
            <input className={s.input} type="password" autoComplete="new-password" required value={form.password}
              onChange={(e) => change('password', e.target.value)} placeholder="At least 8 characters" />
          </div>

          <button className={s.submit} type="submit" disabled={busy}>
            {busy ? 'Creating account…' : 'Create Account'}
          </button>
        </form>

        <p className={s.footer}>
          Already have an account? <Link to="/login" className={s.footerLink}>Sign in</Link>
        </p>
      </div>
    </div>
  )
}
