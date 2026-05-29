import { useEffect, useRef } from 'react'

// ── Colour helpers ────────────────────────────────────────────────────────────
const TEAL = [0, 200, 180]
const BLUE = [59, 130, 246]
const PURP = [139, 92, 246]
function rgba([r, g, b], a) { return `rgba(${r},${g},${b},${a.toFixed(3)})` }

// ── 3-D maths ─────────────────────────────────────────────────────────────────
function rotX([x, y, z], a) {
  const c = Math.cos(a), s = Math.sin(a)
  return [x, y * c - z * s, y * s + z * c]
}
function rotY([x, y, z], a) {
  const c = Math.cos(a), s = Math.sin(a)
  return [x * c + z * s, y, -x * s + z * c]
}
function tf(p, rx, ry) { return rotY(rotX(p, rx), ry) }
function proj([x, y, z], cx, cy, S) {
  const fov = 3.6
  const f = fov / (z + fov)
  return [cx + x * S * f, cy - y * S * f, z]
}

// Brain ellipsoid semi-axes: wide × tall × deep
const RA = 1, RB = 0.88, RC = 0.80
function ell(θ, φ, s = 1) {
  return [s * RA * Math.sin(θ) * Math.cos(φ),
          s * RB * Math.cos(θ),
          s * RC * Math.sin(θ) * Math.sin(φ)]
}

// ── Draw a polyline with per-segment depth-opacity (batched) ──────────────────
function drawCurve(ctx, pts3d, rx, ry, cx, cy, S, hiA, loA, col, lw, dash) {
  const screen = pts3d.map(p => proj(tf(p, rx, ry), cx, cy, S))
  if (screen.length < 2) return

  ctx.lineWidth = lw
  if (dash) ctx.setLineDash(dash); else ctx.setLineDash([])

  let curA = null, inPath = false

  for (let i = 1; i < screen.length; i++) {
    const [x1, y1, z1] = screen[i - 1]
    const [x2, y2, z2] = screen[i]
    const midZ = (z1 + z2) / 2
    const t = Math.max(0, Math.min(1, (midZ + 1) / 2))
    const alpha = loA + t * (hiA - loA)

    // batch consecutive segments with similar alpha
    if (curA === null || Math.abs(alpha - curA) > 0.055) {
      if (inPath) { ctx.strokeStyle = rgba(col, curA); ctx.stroke() }
      ctx.beginPath(); ctx.moveTo(x1, y1)
      curA = alpha; inPath = true
    }
    ctx.lineTo(x2, y2)
  }
  if (inPath) { ctx.strokeStyle = rgba(col, curA); ctx.stroke() }
  ctx.setLineDash([])
}

// ── Precompute static geometry arrays ─────────────────────────────────────────
function buildGeometry() {
  const N = 72  // points per ring/meridian

  // Latitude rings (8 rings from pole to pole)
  const latRings = []
  for (let lat = -72; lat <= 72; lat += 18) {
    const θ = (90 - lat) * Math.PI / 180
    latRings.push(Array.from({ length: N + 1 }, (_, i) => ell(θ, (i / N) * 2 * Math.PI)))
  }

  // Longitude meridians (half-circles every 20°)
  const longLines = []
  for (let lon = 0; lon < 360; lon += 20) {
    const φ = lon * Math.PI / 180
    longLines.push(Array.from({ length: 37 }, (_, i) => ell((i / 36) * Math.PI, φ)))
  }

  // Interhemispheric fissure (x = 0 semicircle)
  const fissure = Array.from({ length: 37 }, (_, i) =>
    [0, RB * Math.cos((i / 36) * Math.PI), RC * Math.sin((i / 36) * Math.PI)])

  // Cortical fold lines on ellipsoid surface (gyri)
  const folds = []
  for (const side of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      const φ = side * (0.42 + i * 0.22)
      const t0 = 0.36 + i * 0.04, t1 = 2.28 - i * 0.05
      folds.push(Array.from({ length: 15 }, (_, j) => {
        const θ = t0 + (j / 14) * (t1 - t0)
        return ell(θ, φ, 1.038)
      }))
    }
    // Extra short folds on top and bottom
    for (const lat of [0.22, 2.55]) {
      for (let i = 0; i < 4; i++) {
        const φ = side * (0.6 + i * 0.3)
        folds.push(Array.from({ length: 9 }, (_, j) => {
          const θ = lat + (j / 8) * 0.4 * side
          return ell(Math.abs(θ), φ, 1.038)
        }))
      }
    }
  }

  // Inner white-matter ring
  const wmRing = Array.from({ length: N + 1 }, (_, i) =>
    ell(Math.PI / 2, (i / N) * 2 * Math.PI, 0.58))

  // Basal-ganglia ovals
  const bgL = Array.from({ length: N + 1 }, (_, i) => {
    const a = (i / N) * 2 * Math.PI
    return [-0.27 + 0.21 * Math.cos(a), -0.1 + 0.17 * Math.sin(a), 0.26]
  })
  const bgR = bgL.map(([x, y, z]) => [-x, y, z])

  // Lateral ventricle outline
  const ventricle = Array.from({ length: N + 1 }, (_, i) => {
    const a = (i / N) * 2 * Math.PI
    const rx2 = 0.18 + 0.04 * Math.cos(2 * a)
    const ry2 = 0.15 + 0.03 * Math.sin(2 * a)
    return [rx2 * Math.cos(a), ry2 * Math.sin(a), 0.08]
  })

  // Outer scan rings (static dashed decorations)
  const scanRings = [1.14, 1.30, 1.46].map(r =>
    Array.from({ length: N + 1 }, (_, i) => ell(Math.PI / 2, (i / N) * 2 * Math.PI, r)))

  return { latRings, longLines, fissure, folds, wmRing, bgL, bgR, ventricle, scanRings }
}

const GEO = buildGeometry()

// ── Main component ────────────────────────────────────────────────────────────
export default function BrainGlobe({ className }) {
  const canvasRef = useRef(null)
  const state = useRef({ rx: 0.26, ry: 0, dragging: false, px: 0, py: 0, scan: 0 })
  const raf = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    // High-resolution canvas: 2× the CSS pixel size for retina sharpness
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cssW = canvas.clientWidth || 480
    const cssH = canvas.clientHeight || 480
    canvas.width  = cssW * dpr
    canvas.height = cssH * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    const W = cssW, H = cssH
    const cx = W / 2, cy = H / 2
    const S = Math.min(W, H) * 0.367

    function render() {
      const { rx, ry, scan } = state.current
      ctx.clearRect(0, 0, W, H)

      // ── Latitude rings ───────────────────────────────────
      GEO.latRings.forEach(pts =>
        drawCurve(ctx, pts, rx, ry, cx, cy, S, 0.26, 0.04, TEAL, 0.75, null))

      // ── Longitude meridians ──────────────────────────────
      GEO.longLines.forEach(pts =>
        drawCurve(ctx, pts, rx, ry, cx, cy, S, 0.20, 0.03, TEAL, 0.6, null))

      // ── Cortical fold gyri ───────────────────────────────
      GEO.folds.forEach(pts =>
        drawCurve(ctx, pts, rx, ry, cx, cy, S, 0.42, 0.04, TEAL, 1.05, null))

      // ── Interhemispheric fissure (dashed) ────────────────
      drawCurve(ctx, GEO.fissure, rx, ry, cx, cy, S, 0.68, 0.10, TEAL, 1.5, [5, 4])

      // ── White-matter inner ring ──────────────────────────
      drawCurve(ctx, GEO.wmRing, rx, ry, cx, cy, S, 0.52, 0.05, BLUE, 1.1, null)

      // ── Basal ganglia ────────────────────────────────────
      drawCurve(ctx, GEO.bgL, rx, ry, cx, cy, S, 0.48, 0.05, PURP, 0.9, null)
      drawCurve(ctx, GEO.bgR, rx, ry, cx, cy, S, 0.48, 0.05, PURP, 0.9, null)

      // ── Lateral ventricle ────────────────────────────────
      drawCurve(ctx, GEO.ventricle, rx, ry, cx, cy, S, 0.58, 0.07, TEAL, 1.3, null)

      // ── Animated scan ring (sweeps top → bottom → top) ──
      {
        const yN = Math.cos(scan) * 0.82
        const xr = Math.sqrt(Math.max(0, 1 - (yN / RB) ** 2))
        const pts = Array.from({ length: 73 }, (_, i) => {
          const φ = (i / 72) * 2 * Math.PI
          return [xr * Math.cos(φ), yN, RC * xr * Math.sin(φ)]
        })
        drawCurve(ctx, pts, rx, ry, cx, cy, S, 0.9, 0.18, TEAL, 2.0, null)
      }

      // ── Outer decorative rings ───────────────────────────
      const ringStyles = [[0.30, 0.03, TEAL, 0.55, [3, 7]], [0.22, 0.03, BLUE, 0.45, [2, 9]], [0.16, 0.02, BLUE, 0.35, [2, 11]]]
      GEO.scanRings.forEach((pts, i) =>
        drawCurve(ctx, pts, rx, ry, cx, cy, S, ...ringStyles[i]))

      // ── Crosshair at brain centre ────────────────────────
      {
        const [px, py] = proj(tf([0, 0, 0], rx, ry), cx, cy, S)
        ctx.setLineDash([])
        ctx.strokeStyle = 'rgba(0,200,180,0.85)'
        ctx.lineWidth = 1.7
        ctx.beginPath()
        ctx.moveTo(px, py - 12); ctx.lineTo(px, py + 12)
        ctx.moveTo(px - 12, py); ctx.lineTo(px + 12, py)
        ctx.stroke()
        ctx.beginPath(); ctx.arc(px, py, 3.8, 0, Math.PI * 2); ctx.stroke()
      }

      // ── Floating tissue labels (track brain rotation) ────
      ctx.setLineDash([])
      ctx.font = `${Math.round(W * 0.023)}px "JetBrains Mono", monospace`
      ctx.textBaseline = 'middle'
      const labels = [
        { p: [-0.88, 0, 0],   text: 'GM',  col: TEAL },
        { p: [-0.46, 0.08, 0], text: 'WM', col: BLUE },
        { p: [0.06, 0.05, 0.1], text: 'CSF', col: TEAL },
      ]
      labels.forEach(({ p, text, col }) => {
        const [px, py, pz] = proj(tf(p, rx, ry), cx, cy, S)
        const alpha = Math.max(0, Math.min(0.82, 0.5 + pz * 0.3))
        ctx.fillStyle = rgba(col, alpha)
        ctx.fillText(text, px - 6, py)
      })
    }

    function loop() {
      const st = state.current
      if (!st.dragging) st.ry += 0.0042
      st.scan += 0.011
      render()
      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)

    // ── Pointer / touch events ────────────────────────────
    function onDown(e) {
      state.current.dragging = true
      state.current.px = e.clientX
      state.current.py = e.clientY
      canvas.style.cursor = 'grabbing'
      canvas.setPointerCapture(e.pointerId)
      e.preventDefault()
    }
    function onMove(e) {
      if (!state.current.dragging) return
      const dx = e.clientX - state.current.px
      const dy = e.clientY - state.current.py
      state.current.ry += dx * 0.009
      state.current.rx = Math.max(-0.72, Math.min(0.72, state.current.rx + dy * 0.009))
      state.current.px = e.clientX
      state.current.py = e.clientY
    }
    function onUp() { state.current.dragging = false; canvas.style.cursor = 'grab' }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)

    return () => {
      cancelAnimationFrame(raf.current)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ cursor: 'grab', touchAction: 'none', display: 'block' }}
    />
  )
}
