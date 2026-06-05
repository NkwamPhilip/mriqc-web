/**
 * Support.jsx — Floating support widget
 *
 * Two tabs:
 *   AI Help   — Streaming chat powered by Claude (claude-haiku-4-5).
 *               Context is the full WebMRIQC system prompt so it knows
 *               every error code, IQM, and workflow step.
 *   Contact   — Ticket form: name, institution, email, subject, message,
 *               optional file attachment.  Sends to the lab inbox via
 *               POST /support/ticket.
 *
 * Mount once in App.jsx — it renders on every page.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import s from './Support.module.css'

const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

// ── Streaming chat fetch ──────────────────────────────────────────────────────

async function* streamChat(messages) {
  const res = await fetch(`${API}/support/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ messages }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `Server error ${res.status}`)
  }
  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let   buf     = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()               // keep incomplete last line in buffer
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') return
      try {
        const { text, error } = JSON.parse(payload)
        if (error) throw new Error(error)
        if (text) yield text
      } catch { /* skip malformed chunks */ }
    }
  }
}

// ── Markdown-lite renderer (bold + code only — keeps bundle small) ────────────

function Md({ text }) {
  // Split on **bold** and `code` patterns, render inline
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <span>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**'))
          return <strong key={i}>{p.slice(2, -2)}</strong>
        if (p.startsWith('`') && p.endsWith('`'))
          return <code key={i} className={s.inlineCode}>{p.slice(1, -1)}</code>
        // render line-breaks inside a chunk
        return p.split('\n').map((ln, j, arr) => (
          <span key={`${i}-${j}`}>{ln}{j < arr.length - 1 && <br/>}</span>
        ))
      })}
    </span>
  )
}

// ── Chat tab ─────────────────────────────────────────────────────────────────

const WELCOME = {
  role: 'assistant',
  content: "Hi! I'm the WebMRIQC support assistant. I can help you debug errors, interpret IQMs, or troubleshoot BIDS/DICOM issues. What's going on?",
}

function ChatTab() {
  const [messages,  setMessages]  = useState([WELCOME])
  const [input,     setInput]     = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef(null)
  const inputRef  = useRef(null)

  // Auto-scroll on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')

    const userMsg   = { role: 'user', content: text }
    const history   = [...messages, userMsg]
    // Placeholder for the assistant reply
    const assistantMsg = { role: 'assistant', content: '' }
    setMessages([...history, assistantMsg])
    setStreaming(true)

    // Build payload: only user/assistant turns (skip system)
    const payload = history.filter(m => m.role === 'user' || m.role === 'assistant')

    try {
      for await (const chunk of streamChat(payload)) {
        setMessages(prev => {
          const copy = [...prev]
          copy[copy.length - 1] = {
            ...copy[copy.length - 1],
            content: copy[copy.length - 1].content + chunk,
          }
          return copy
        })
      }
    } catch (err) {
      setMessages(prev => {
        const copy = [...prev]
        copy[copy.length - 1] = {
          ...copy[copy.length - 1],
          content: `⚠️ ${err.message}`,
        }
        return copy
      })
    } finally {
      setStreaming(false)
      inputRef.current?.focus()
    }
  }, [input, messages, streaming])

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div className={s.chatPane}>
      <div className={s.chatHistory}>
        {messages.map((msg, i) => (
          <div key={i} className={`${s.bubble} ${msg.role === 'user' ? s.bubbleUser : s.bubbleBot}`}>
            {msg.role === 'assistant' && (
              <div className={s.botAvatar}>AI</div>
            )}
            <div className={s.bubbleText}>
              {msg.content
                ? <Md text={msg.content} />
                : streaming && i === messages.length - 1
                  ? <span className={s.typing}><span/><span/><span/></span>
                  : null
              }
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className={s.chatInput}>
        <textarea
          ref={inputRef}
          className={s.chatTextarea}
          placeholder="Describe your issue…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          disabled={streaming}
        />
        <button
          className={s.chatSend}
          onClick={send}
          disabled={!input.trim() || streaming}
          title="Send (Enter)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

// ── Contact tab ───────────────────────────────────────────────────────────────

function ContactTab() {
  const [form,     setForm]     = useState({ name:'', institution:'', email:'', subject:'', message:'' })
  const [file,     setFile]     = useState(null)
  const [status,   setStatus]   = useState('idle')   // idle | sending | sent | error
  const [errMsg,   setErrMsg]   = useState('')
  const fileRef = useRef(null)

  function change(k, v) { setForm(p => ({ ...p, [k]: v })) }

  async function submit(e) {
    e.preventDefault()
    if (!form.name || !form.email || !form.message) return
    setStatus('sending')
    setErrMsg('')

    const fd = new FormData()
    Object.entries(form).forEach(([k, v]) => fd.append(k, v))
    if (file) fd.append('attachment', file)

    try {
      const res = await fetch(`${API}/support/ticket`, { method: 'POST', body: fd })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || `Server error ${res.status}`)
      }
      setStatus('sent')
    } catch (err) {
      setErrMsg(err.message)
      setStatus('error')
    }
  }

  if (status === 'sent') {
    return (
      <div className={s.sentScreen}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--teal)"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <h3>Ticket sent!</h3>
        <p>We'll reply to <strong>{form.email}</strong> as soon as possible.</p>
        <button className={s.resetBtn} onClick={() => {
          setForm({ name:'', institution:'', email:'', subject:'', message:'' })
          setFile(null); setStatus('idle')
        }}>Send another</button>
      </div>
    )
  }

  return (
    <form className={s.contactForm} onSubmit={submit}>
      <div className={s.fieldRow}>
        <label className={s.fieldLabel}>Name <span className={s.req}>*</span></label>
        <input className={s.fieldInput} value={form.name}
          onChange={e => change('name', e.target.value)} placeholder="Dr. Ada Okafor" required />
      </div>

      <div className={s.fieldRow}>
        <label className={s.fieldLabel}>Institution / Lab</label>
        <input className={s.fieldInput} value={form.institution}
          onChange={e => change('institution', e.target.value)} placeholder="University of Lagos · MAILAB" />
      </div>

      <div className={s.fieldRow}>
        <label className={s.fieldLabel}>Email <span className={s.req}>*</span></label>
        <input className={s.fieldInput} type="email" value={form.email}
          onChange={e => change('email', e.target.value)} placeholder="ada@unilag.edu.ng" required />
      </div>

      <div className={s.fieldRow}>
        <label className={s.fieldLabel}>Subject</label>
        <input className={s.fieldInput} value={form.subject}
          onChange={e => change('subject', e.target.value)} placeholder="Error during MRIQC processing" />
      </div>

      <div className={s.fieldRow}>
        <label className={s.fieldLabel}>Message <span className={s.req}>*</span></label>
        <textarea className={s.fieldTextarea} value={form.message} rows={4}
          onChange={e => change('message', e.target.value)}
          placeholder="Describe the issue, the error message you saw, and the steps to reproduce it." required />
      </div>

      <div className={s.fieldRow}>
        <label className={s.fieldLabel}>Attachment <span className={s.opt}>(optional)</span></label>
        <div className={s.fileWrap}>
          <button type="button" className={s.fileBtn} onClick={() => fileRef.current?.click()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
            {file ? file.name : 'Choose file'}
          </button>
          {file && (
            <button type="button" className={s.fileClear} onClick={() => setFile(null)}>✕</button>
          )}
        </div>
        <input ref={fileRef} type="file" style={{ display:'none' }}
          onChange={e => setFile(e.target.files?.[0] ?? null)} />
      </div>

      {status === 'error' && (
        <p className={s.formError}>⚠️ {errMsg}</p>
      )}

      <button type="submit" className={s.submitBtn} disabled={status === 'sending'}>
        {status === 'sending' ? 'Sending…' : 'Send Ticket'}
        {status !== 'sending' && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/>
            <polyline points="12 5 19 12 12 19"/>
          </svg>
        )}
      </button>
    </form>
  )
}

// ── Root floating widget ──────────────────────────────────────────────────────

export default function Support() {
  const [open, setOpen] = useState(false)
  const [tab,  setTab]  = useState('chat')

  return (
    <>
      {/* Floating trigger button */}
      <button
        className={`${s.fab} ${open ? s.fabOpen : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Support"
        aria-label="Open support"
      >
        {open
          ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        }
      </button>

      {/* Panel */}
      {open && (
        <div className={s.panel}>
          {/* Header */}
          <div className={s.panelHead}>
            <div className={s.panelTitle}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              WebMRIQC Support
            </div>
            <button className={s.closeBtn} onClick={() => setOpen(false)} aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          {/* Tabs */}
          <div className={s.tabs}>
            <button className={`${s.tab} ${tab === 'chat' ? s.tabActive : ''}`} onClick={() => setTab('chat')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              AI Help
            </button>
            <button className={`${s.tab} ${tab === 'contact' ? s.tabActive : ''}`} onClick={() => setTab('contact')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                <polyline points="22,6 12,13 2,6"/>
              </svg>
              Contact Lab
            </button>
          </div>

          {/* Content */}
          <div className={s.panelBody}>
            {tab === 'chat'    ? <ChatTab    /> : <ContactTab />}
          </div>
        </div>
      )}
    </>
  )
}
