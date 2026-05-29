import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'

// ── Depth shader: front faces bright, back faces fade out ─────────────────────
const VS = `
  varying float vZ;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vZ = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`
const FS = `
  uniform vec3  uColor;
  uniform float uHi;
  uniform float uLo;
  varying float vZ;
  void main() {
    // vZ is camera-space depth. Brain spans roughly 2..5 units.
    // Invert so front (small vZ) → bright, back (large vZ) → dim.
    float t = 1.0 - clamp((vZ - 2.0) / 3.2, 0.0, 1.0);
    gl_FragColor = vec4(uColor, uLo + t * (uHi - uLo));
  }
`
function depthMat(hex, hi, lo) {
  return new THREE.ShaderMaterial({
    vertexShader: VS, fragmentShader: FS,
    uniforms: {
      uColor: { value: new THREE.Color(hex) },
      uHi:    { value: hi },
      uLo:    { value: lo },
    },
    transparent: true,
    depthWrite:  false,
  })
}

// ── Scan-slice ring (horizontal ellipse at height yN) ─────────────────────────
function makeScanRingGeo(yN, scaleX, scaleZ) {
  const pts = []
  const ry  = Math.max(0, 1 - (yN / scaleZ) ** 2)   // ellipse radius at this height
  const rx  = Math.sqrt(ry) * scaleX
  const rz  = Math.sqrt(ry) * scaleZ
  for (let i = 0; i <= 80; i++) {
    const a = (i / 80) * 2 * Math.PI
    pts.push(new THREE.Vector3(rx * Math.cos(a), yN, rz * Math.sin(a)))
  }
  return new THREE.BufferGeometry().setFromPoints(pts)
}

// ── Main component ────────────────────────────────────────────────────────────
export default function BrainModel({ className }) {
  const mountRef = useRef(null)
  const stRef    = useRef({ ry: 0.30, rx: 0.18, drag: false, px: 0, py: 0 })
  const rafRef   = useRef(null)

  useEffect(() => {
    const el  = mountRef.current
    const W   = el.clientWidth  || 480
    const H   = el.clientHeight || 480
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    // ── Scene ──────────────────────────────────────────────────────────────
    const scene  = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 50)
    camera.position.set(0, 0.05, 3.2)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(W, H)
    renderer.setPixelRatio(dpr)
    renderer.setClearColor(0x000000, 0)
    const canvas = renderer.domElement
    canvas.style.cssText = 'display:block;width:100%;height:100%;'
    el.appendChild(canvas)

    // Loading label (removed once brain is ready)
    const label = document.createElement('div')
    label.style.cssText = `
      position:absolute;inset:0;display:flex;align-items:center;
      justify-content:center;color:rgba(0,200,180,0.55);
      font-family:'JetBrains Mono',monospace;font-size:0.75rem;
      letter-spacing:.08em;pointer-events:none;
    `
    label.textContent = 'LOADING BRAIN MODEL…'
    el.style.position = 'relative'
    el.appendChild(label)

    // Brain group — everything rotates together
    const brain = new THREE.Group()
    scene.add(brain)

    // Scan-ring & crosshair refs (added before OBJ loads so canvas isn't empty)
    const scanMat = depthMat(0x00c8b4, 0.90, 0.14)
    let   scanLine = new THREE.Line(makeScanRingGeo(0, 0.92, 0.92), scanMat)
    brain.add(scanLine)

    // Crosshair (in world space, doesn't rotate)
    const chGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3( 0, -0.14, 0), new THREE.Vector3(0,  0.14, 0),
      new THREE.Vector3(-0.14, 0,  0), new THREE.Vector3(0.14, 0, 0),
    ])
    scene.add(new THREE.LineSegments(chGeo,
      new THREE.LineBasicMaterial({ color: 0x00c8b4, transparent: true, opacity: 0.82 })))

    // Brain scale — set after OBJ loads; used by scan ring
    let brainScaleX = 0.92, brainScaleZ = 0.92

    // ── OBJ Loader ─────────────────────────────────────────────────────────
    const loader = new OBJLoader()
    loader.load(
      '/brain.obj',
      (obj) => {
        // Collect all geometries (some OBJs export multiple groups)
        const geos = []
        obj.traverse(c => { if (c.isMesh) geos.push(c.geometry) })
        if (!geos.length) return

        // Merge into one (usually just one group)
        let geo = geos[0]
        if (geos.length > 1) {
          const { mergeGeometries } = THREE.BufferGeometryUtils
          geo = mergeGeometries(geos)
        }

        // ── Normalise: centre + scale to fit ─────────────────────────────
        geo.computeBoundingBox()
        const box    = geo.boundingBox
        const centre = new THREE.Vector3()
        box.getCenter(centre)
        geo.translate(-centre.x, -centre.y, -centre.z)

        const size   = new THREE.Vector3()
        box.getSize(size)
        const maxDim = Math.max(size.x, size.y, size.z)
        const scale  = 1.80 / maxDim
        geo.scale(scale, scale, scale)
        geo.computeVertexNormals()

        // Update scan-ring scale to match real brain size
        brainScaleX = (size.x * scale) * 0.52
        brainScaleZ = (size.z * scale) * 0.52

        // ── Depth-only solid mesh ─────────────────────────────────────────
        // Writes to the depth buffer but draws nothing — hides back-face wires
        const depthOnlyMat = new THREE.MeshBasicMaterial({
          colorWrite: false,
          depthWrite: true,
          side: THREE.FrontSide,
        })
        brain.add(new THREE.Mesh(geo, depthOnlyMat))

        // ── Wireframe overlay ─────────────────────────────────────────────
        // Full wireframe — depth-occlusion from mesh above means back wires vanish
        const wireGeo = new THREE.WireframeGeometry(geo)
        brain.add(new THREE.LineSegments(wireGeo, depthMat(0x00c8b4, 0.35, 0.02)))

        // Remove loading label
        if (el.contains(label)) el.removeChild(label)
      },
      undefined,
      (err) => {
        label.textContent = 'Could not load brain.obj'
        console.error(err)
      },
    )

    // ── Animation loop ──────────────────────────────────────────────────────
    let scan = 0
    function animate() {
      const s = stRef.current
      if (!s.drag) s.ry += 0.0042
      brain.rotation.y = s.ry
      brain.rotation.x = s.rx

      // Sweep scan ring from top → bottom → top
      scan += 0.010
      const yN = Math.cos(scan) * 0.72
      brain.remove(scanLine)
      scanLine.geometry.dispose()
      scanLine = new THREE.Line(makeScanRingGeo(yN, brainScaleX, brainScaleZ), scanMat)
      brain.add(scanLine)

      renderer.render(scene, camera)
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)

    // ── Pointer events ──────────────────────────────────────────────────────
    canvas.style.cursor     = 'grab'
    canvas.style.touchAction = 'none'

    function onDown(e) {
      stRef.current.drag = true
      stRef.current.px   = e.clientX
      stRef.current.py   = e.clientY
      canvas.style.cursor = 'grabbing'
      canvas.setPointerCapture(e.pointerId)
      e.preventDefault()
    }
    function onMove(e) {
      if (!stRef.current.drag) return
      const dx = e.clientX - stRef.current.px
      const dy = e.clientY - stRef.current.py
      stRef.current.ry += dx * 0.009
      stRef.current.rx  = Math.max(-0.72, Math.min(0.72, stRef.current.rx + dy * 0.009))
      stRef.current.px  = e.clientX
      stRef.current.py  = e.clientY
    }
    function onUp() { stRef.current.drag = false; canvas.style.cursor = 'grab' }

    canvas.addEventListener('pointerdown',   onDown)
    canvas.addEventListener('pointermove',   onMove)
    canvas.addEventListener('pointerup',     onUp)
    canvas.addEventListener('pointercancel', onUp)

    return () => {
      cancelAnimationFrame(rafRef.current)
      canvas.removeEventListener('pointerdown',   onDown)
      canvas.removeEventListener('pointermove',   onMove)
      canvas.removeEventListener('pointerup',     onUp)
      canvas.removeEventListener('pointercancel', onUp)
      renderer.dispose()
      if (el.contains(canvas)) el.removeChild(canvas)
      if (el.contains(label))  el.removeChild(label)
    }
  }, [])

  return <div ref={mountRef} className={className} style={{ overflow: 'hidden' }} />
}
