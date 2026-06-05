import { useState, useRef, useEffect, useLayoutEffect, createContext, useContext, useMemo } from 'react'
import '@fontsource-variable/nunito'
import { ChevronRight, ChevronLeft, RotateCcw, X as LucideX, Circle as LucideCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from '@/components/ui/pagination'
import { cn } from '@/lib/utils'

const YELLOW = '#FDD302'
const RED    = '#F63664'
const BLUE   = '#5CCBF8'
const DOT_SIZE = 80

type Player = 'X' | 'O' | 'Y'

// Fixed horizontal positions for color baskets — same across all collection pages
const BASKET_LEFT: Record<string, string> = { [YELLOW]: '50%', [BLUE]: '25%', [RED]: '75%' }
// Fixed vertical positions in portrait mode — same across all collection pages so baskets don't jump
const BASKET_TOP:  Record<string, string> = { [YELLOW]: '25%', [BLUE]: '50%', [RED]: '75%' }

const COL_X = [25, 50, 75]
const ROW_Y = [84, 67, 50, 33, 16]

// ─── Physics ────────────────────────────────────────────────────────────────
type PhysDot = { id: string; color: string; x: number; y: number; vx: number; vy: number; friction: number }

// RX/RY based on 960 wide canvas at min-width
const RX = (DOT_SIZE / 2 / 960) * 100   // ≈ 4.17 %
const RY = (DOT_SIZE / 2 / 520) * 100   // ≈ 7.69 %
const BASE_DAMPING = 0.96
const BOUNCE = 0.82

// ─── Dot positions ───────────────────────────────────────────────────────────
type DotSpec = { id: string; color: string; x: number; y: number; onClick: () => void; interactive?: boolean }

const SCATTERED: { x: number; y: number }[] = [
  { x: 72, y: 12 }, { x: 18, y: 45 }, { x: 55, y: 72 }, { x: 82, y: 52 }, { x: 35, y: 85 },
  { x: 48, y: 22 }, { x: 85, y: 35 }, { x: 22, y: 65 }, { x: 65, y: 80 }, { x: 12, y: 28 },
  { x: 62, y: 10 }, { x: 28, y: 50 }, { x: 78, y: 30 }, { x: 42, y: 90 }, { x: 90, y: 68 },
]

const PILE_Y = [12, 45, 72, 52, 85, 22, 35, 65, 80, 28, 10, 50, 30, 90, 68]
const PILED_LEFT:  { x: number; y: number }[] = PILE_Y.map(y => ({ x: RX,       y }))
const PILED_RIGHT: { x: number; y: number }[] = PILE_Y.map(y => ({ x: 100 - RX, y }))

// ─── Contexts ────────────────────────────────────────────────────────────────
const CaptionCtx    = createContext<(n: React.ReactNode) => void>(() => {})
const DoneCtx       = createContext<(done: boolean) => void>(() => {})
const PageActiveCtx = createContext<boolean>(true)

type Ch2DotState = { x: number; y: number; vx: number; vy: number; color: string }
type Ch2StaticDot = { id: string; color: string; x: number; y: number; vx?: number; vy?: number }
type Handoff = {
  page4Dots:     { x: number; y: number }[] | null
  page5Dots:     { x: number; y: number }[] | null
  page6Dots:     { x: number; y: number }[] | null
  ch2p2Dots:     Ch2DotState[]  | null
  ch2LatestDots: Ch2StaticDot[] | null   // written by each Ch2 dot-page; read by the next
}
const HandoffCtx = createContext<React.MutableRefObject<Handoff>>(
  { current: { page4Dots: null, page5Dots: null, page6Dots: null, ch2p2Dots: null, ch2LatestDots: null } }
)
const DotSizeCtx = createContext(DOT_SIZE)
type ShapeDef = { vertices: [number,number][]; open: boolean; emoji: string; label: string }
const Ch2ShapesCtx = createContext<ShapeDef[]>([])

// ─── Sound effects (Web Audio API — no files needed) ─────────────────────────
function playPageComplete() {
  try {
    const ctx  = new AudioContext()
    // Quick ascending chime: C5 → E5 → G5
    const notes: [number, number][] = [[523.25, 0], [659.25, 0.13], [783.99, 0.26]]
    notes.forEach(([freq, delay]) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain()
      osc.type = 'triangle'; osc.frequency.value = freq
      osc.connect(gain); gain.connect(ctx.destination)
      const t = ctx.currentTime + delay
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.35, t + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.40)
      osc.start(t); osc.stop(t + 0.42)
    })
  } catch { /* blocked */ }
}

function playChapterComplete() {
  try {
    const ctx = new AudioContext()
    // Triumphant fanfare: G4 → C5 → E5 → G5 → C6 (held)
    const notes: [number, number, number][] = [
      [392.00, 0.00, 0.15],
      [523.25, 0.15, 0.15],
      [659.25, 0.30, 0.15],
      [783.99, 0.45, 0.18],
      [1046.5, 0.62, 0.80],
    ]
    notes.forEach(([freq, delay, dur]) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain()
      osc.type = 'triangle'; osc.frequency.value = freq
      osc.connect(gain); gain.connect(ctx.destination)
      const t = ctx.currentTime + delay
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.32, t + 0.018)
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur)
      osc.start(t); osc.stop(t + dur + 0.05)
    })
  } catch { /* blocked */ }
}

// ─── Context consumers ────────────────────────────────────────────────────────
function IntroText({ children }: { children: React.ReactNode }) {
  const active     = useContext(PageActiveCtx)
  const setCaption = useContext(CaptionCtx)
  useLayoutEffect(() => { if (active) setCaption(children) })
  return null
}

function SetDone({ done, celebrate = true }: { done: boolean; celebrate?: boolean }) {
  const active     = useContext(PageActiveCtx)
  const setDone    = useContext(DoneCtx)
  const prevRef    = useRef(false)
  useLayoutEffect(() => { if (active) setDone(done) })
  useEffect(() => {
    if (active && done && !prevRef.current) playPageComplete()
    prevRef.current = done
  }, [active, done])
  return (active && done && celebrate) ? <ClapCelebration /> : null
}

// ─── Dot component (no entrance animation) ───────────────────────────────────
function DotMount({ color, x, y, onClick, interactive = true }: {
  color: string; x: number; y: number; onClick: () => void; interactive?: boolean
}) {
  const ds = useContext(DotSizeCtx)
  return (
    <div
      onClick={onClick}
      style={{ ...dotStyle(color, interactive, ds), left: `${x}%`, top: `${y}%`, transform: 'translate(-50%,-50%)' }}
    />
  )
}

// ─── Shared canvas ────────────────────────────────────────────────────────────
function PageCanvas({ dots, intro, done }: { dots: DotSpec[]; intro: string; done: boolean }) {
  return (
    <>
      <div style={canvasStyle}>
        {dots.map(s => (
          <DotMount key={s.id} color={s.color} x={s.x} y={s.y} onClick={s.onClick} interactive={s.interactive ?? true} />
        ))}
      </div>
      <IntroText>{intro}</IntroText>
      <SetDone done={done} />
    </>
  )
}

// ─── Page 1 & 2 shared: RYB shimmer animation ────────────────────────────────
const GRAY = '#87898B'

// Injected once; both pages share the same keyframe name
function useRYBKeyframe() {
  useLayoutEffect(() => {
    const s = document.createElement('style')
    s.textContent = `@keyframes rybShimmer{
      0%  {background:${RED}}
      33% {background:${YELLOW}}
      67% {background:${BLUE}}
      100%{background:${RED}}
    }`
    document.head.appendChild(s)
    return () => { document.head.removeChild(s) }
  }, [])
}

function RainbowDot({ i, onClick, disabled }: { i: number; onClick: () => void; disabled?: boolean }) {
  const ds = useContext(DotSizeCtx)
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        position: 'absolute',
        left: `${COL_X[i]}%`, top: `${ROW_Y[0]}%`,
        transform: 'translate(-50%,-50%)',
        width: ds, height: ds,
        borderRadius: '50%',
        cursor: disabled ? 'default' : 'pointer',
        WebkitTapHighlightColor: 'transparent',
        animation: 'rybShimmer 3s linear infinite',
        animationDelay: `${-i * 1}s`,
      }}
    />
  )
}

// ─── Page 1 ──────────────────────────────────────────────────────────────────
function Page1() {
  const [count, setCount] = useState(1)
  const done = count === 3
  const bump = () => setCount(c => Math.min(c + 1, 3))
  useRYBKeyframe()

  return (
    <>
      <div style={canvasStyle}>
        {Array.from({ length: count }, (_, i) => (
          <RainbowDot key={`p1-${i}`} i={i} onClick={bump} disabled={done} />
        ))}
      </div>
      <IntroText>Press the dot!</IntroText>
      <SetDone done={done} />
    </>
  )
}

// ─── Page 2+3 — reveal colors then grow columns ───────────────────────────────
function Page23() {
  const ds          = useContext(DotSizeCtx)
  const [counts, setCounts] = useState([0, 0, 0])
  const done        = counts.every(c => c === 5)
  const allRevealed = counts.every(c => c >= 1)
  const COLORS = [RED, YELLOW, BLUE]
  useRYBKeyframe()

  const bump = (i: number) =>
    setCounts(prev => prev.map((v, j) => j === i ? Math.min(v + 1, 5) : v))

  return (
    <>
      <div style={canvasStyle}>
        {COLORS.map((color, i) => {
          const count     = counts[i]
          const revealed  = count >= 1
          const clickable = count < 5
          return (
            <div key={i}>
              {/* Bottom dot: shimmer until first click reveals color */}
              <div
                onClick={clickable ? () => bump(i) : undefined}
                style={{
                  position: 'absolute',
                  left: `${COL_X[i]}%`, top: `${ROW_Y[0]}%`,
                  transform: 'translate(-50%,-50%)',
                  width: ds, height: ds,
                  borderRadius: '50%',
                  cursor: clickable ? 'pointer' : 'default',
                  WebkitTapHighlightColor: 'transparent',
                  animation: 'rybShimmer 3s linear infinite',
                  animationDelay: `${-i * 1}s`,
                }}
              >
                {/* Solid color overlay fades in on reveal */}
                <div style={{
                  position: 'absolute', inset: 0, borderRadius: '50%',
                  background: color,
                  opacity: revealed ? 1 : 0,
                  transition: 'opacity 0.55s ease',
                  pointerEvents: 'none',
                }} />
              </div>
              {/* Additional column dots grow upward after reveal */}
              {Array.from({ length: count - 1 }, (_, row) => (
                <DotMount
                  key={row}
                  color={color}
                  x={COL_X[i]}
                  y={ROW_Y[row + 1]}
                  onClick={() => bump(i)}
                  interactive={clickable}
                />
              ))}
            </div>
          )
        })}
      </div>
      <IntroText>Press the dots!</IntroText>
      <SetDone done={done} />
    </>
  )
}

// ─── Dot-dot collision resolution (elastic, equal mass) ─────────────────────
function resolveCollisions(dots: PhysDot[], cw: number, ch: number, dotSize = DOT_SIZE): PhysDot[] {
  const result = dots.map(d => ({ ...d }))
  const n = result.length
  const minDist = dotSize  // collision when centers are closer than 1 diameter

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = (result[i].x - result[j].x) * cw / 100  // px
      const dy = (result[i].y - result[j].y) * ch / 100  // px
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist >= minDist || dist < 0.001) continue

      // Unit normal pointing from j → i
      const nx = dx / dist
      const ny = dy / dist

      // Velocities in px/frame
      const v1x = result[i].vx * cw / 100,  v1y = result[i].vy * ch / 100
      const v2x = result[j].vx * cw / 100,  v2y = result[j].vy * ch / 100

      // Scalar normal components
      const v1n = v1x * nx + v1y * ny
      const v2n = v2x * nx + v2y * ny

      if (v1n - v2n > 0) continue  // already separating

      // Elastic equal-mass collision: swap normal components
      result[i].vx = (v1x - v1n * nx + v2n * nx) / cw * 100
      result[i].vy = (v1y - v1n * ny + v2n * ny) / ch * 100
      result[j].vx = (v2x - v2n * nx + v1n * nx) / cw * 100
      result[j].vy = (v2y - v2n * ny + v1n * ny) / ch * 100

      // Push apart so they no longer overlap
      const push = (minDist - dist) / 2
      result[i].x += nx * push / cw * 100
      result[i].y += ny * push / ch * 100
      result[j].x -= nx * push / cw * 100
      result[j].y -= ny * push / ch * 100
    }
  }
  return result
}

// ─── Page 4 ──────────────────────────────────────────────────────────────────
function initPhysDots(): PhysDot[] {
  return [RED, YELLOW, BLUE].flatMap((color, ci) =>
    Array.from({ length: 5 }, (_, row) => ({
      id: `p4-${ci}-${row}`, color, x: COL_X[ci], y: ROW_Y[row], vx: 0, vy: 0, friction: BASE_DAMPING,
    }))
  )
}

function Page4() {
  const dotsRef    = useRef<PhysDot[]>(initPhysDots())
  const rafRef     = useRef<number | null>(null)
  const running    = useRef(false)
  const canvasRef  = useRef<HTMLDivElement>(null)
  const [, tick]   = useState(0)
  const [clicks, setClicks] = useState(0)
  const done    = clicks >= 5
  const handoff = useContext(HandoffCtx)

  function startLoop() {
    if (running.current) return
    running.current = true
    const step = () => {
      const cw = canvasRef.current?.offsetWidth  ?? 960
      const ch = canvasRef.current?.offsetHeight ?? 520
      const rxA = DOT_SIZE / 2 / cw * 100
      const ryA = DOT_SIZE / 2 / ch * 100
      let anyMoving = false
      dotsRef.current = dotsRef.current.map(({ x, y, vx, vy, friction, ...rest }) => {
        x += vx; y += vy
        if (x < rxA)        { x = rxA;        vx =  Math.abs(vx) * BOUNCE }
        if (x > 100 - rxA)  { x = 100 - rxA;  vx = -Math.abs(vx) * BOUNCE }
        if (y < ryA)        { y = ryA;        vy =  Math.abs(vy) * BOUNCE }
        if (y > 100 - ryA)  { y = 100 - ryA;  vy = -Math.abs(vy) * BOUNCE }
        vx *= friction; vy *= friction
        if (Math.abs(vx) > 0.05 || Math.abs(vy) > 0.05) anyMoving = true
        return { ...rest, x, y, vx, vy, friction }
      })
      dotsRef.current = resolveCollisions(dotsRef.current, cw, ch)
      handoff.current.page4Dots = dotsRef.current.map(({ x, y }) => ({ x, y }))
      tick(n => n + 1)
      if (anyMoving) { rafRef.current = requestAnimationFrame(step) }
      else { running.current = false }
    }
    rafRef.current = requestAnimationFrame(step)
  }

  function handleClick() {
    const strength = Math.min(8 + clicks * 2.5, 28)
    dotsRef.current = dotsRef.current.map(dot => ({
      ...dot,
      vx: dot.vx + (Math.random() - 0.5) * strength,
      vy: dot.vy + (Math.random() - 0.5) * strength,
    }))
    setClicks(c => c + 1)
    startLoop()
  }

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }, [])

  const intro = 'Tap anywhere to shake!'

  return (
    <>
      <div ref={canvasRef} onClick={done ? undefined : handleClick} style={{ ...canvasStyle, cursor: done ? 'default' : 'pointer', userSelect: 'none' }}>
        {dotsRef.current.map(dot => (
          <div key={dot.id} style={{ ...dotStyle(dot.color, false), left: `${dot.x}%`, top: `${dot.y}%`, transform: 'translate(-50%,-50%)', transition: 'none', pointerEvents: 'none' }} />
        ))}
      </div>
      <IntroText>{intro}</IntroText>
      <SetDone done={done} />
    </>
  )
}

// ─── Pages 5+6 (merged) — 4-direction gravity ────────────────────────────────
function mkTiltDots(positions: { x: number; y: number }[]): PhysDot[] {
  return [RED, YELLOW, BLUE].flatMap((color, ci) =>
    Array.from({ length: 5 }, (_, i) => ({
      id: `tilt-${ci}-${i}`,
      color,
      x: positions[ci * 5 + i].x,
      y: positions[ci * 5 + i].y,
      vx: 0, vy: 0,
      friction: 0.93 + Math.random() * 0.05,
    }))
  )
}

type GravDir = 'left' | 'right' | 'up' | 'down'

function Page56() {
  const active    = useContext(PageActiveCtx)
  const handoff   = useContext(HandoffCtx)
  const dotsRef   = useRef<PhysDot[]>(mkTiltDots(SCATTERED))
  const rafRef    = useRef<number | null>(null)
  const gravRef   = useRef({ gx: 0, gy: 0 })
  const modeRef   = useRef<'brownian' | 'gravity'>('brownian')
  const initedRef = useRef(false)
  const tapsRef   = useRef(0)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [, tick]  = useState(0)
  const [usedDirs, setUsedDirs] = useState<Set<GravDir>>(new Set())
  const done = usedDirs.size === 4

  // Load dot positions from previous page
  useEffect(() => {
    if (!active || initedRef.current) return
    const src = handoff.current.page4Dots
    if (src && src.length === 15) {
      initedRef.current = true
      dotsRef.current = mkTiltDots(src)
      tick(n => n + 1)
    }
  }, [active])   // eslint-disable-line react-hooks/exhaustive-deps

  // Always-running RAF: Brownian motion between gravity tilts
  useEffect(() => {
    if (!active) return
    let alive = true
    const step = () => {
      if (!alive) return
      const cw  = canvasRef.current?.clientWidth  ?? 960
      const ch  = canvasRef.current?.clientHeight ?? 520
      const rxA = DOT_SIZE / 2 / cw * 100
      const ryA = DOT_SIZE / 2 / ch * 100
      const { gx, gy } = gravRef.current
      const mode = modeRef.current
      let settling = true

      dotsRef.current = dotsRef.current.map(({ x, y, vx, vy, friction, ...rest }) => {
        if (mode === 'brownian') {
          // Gentle random walk between layouts
          vx += (Math.random() - 0.5) * 0.10
          vy += (Math.random() - 0.5) * 0.10
          const spd = Math.sqrt(vx * vx + vy * vy)
          if (spd > 0.45) { vx = vx / spd * 0.45; vy = vy / spd * 0.45 }
          settling = false   // brownian never "settles" — loop keeps running
        } else {
          // Gravity tilt
          vx += gx; vy += gy
          if (Math.abs(vx) > 0.05 || Math.abs(vy) > 0.05) settling = false
        }
        vx *= friction; vy *= friction
        x += vx; y += vy
        if (x < rxA)       { x = rxA;       vx =  Math.abs(vx) * BOUNCE }
        if (x > 100 - rxA) { x = 100 - rxA; vx = -Math.abs(vx) * BOUNCE }
        if (y < ryA)       { y = ryA;       vy =  Math.abs(vy) * BOUNCE }
        if (y > 100 - ryA) { y = 100 - ryA; vy = -Math.abs(vy) * BOUNCE }
        return { ...rest, x, y, vx, vy, friction }
      })

      dotsRef.current = resolveCollisions(dotsRef.current, cw, ch)

      // Gravity settled → switch back to Brownian
      if (mode === 'gravity' && settling) {
        modeRef.current = 'brownian'
        gravRef.current = { gx: 0, gy: 0 }
      }

      handoff.current.page6Dots = dotsRef.current.map(({ x, y }) => ({ x, y }))
      tick(n => n + 1)
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      alive = false
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    }
  }, [active])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }, [])

  function applyDir(dir: GravDir) {
    const strength = Math.min(0.08 + tapsRef.current * 0.07, 0.45)
    const g = { left: { gx: -strength, gy: 0 }, right: { gx: strength, gy: 0 }, up: { gx: 0, gy: -strength }, down: { gx: 0, gy: strength } }
    gravRef.current = g[dir]
    modeRef.current = 'gravity'
    dotsRef.current = dotsRef.current.map(dot => ({
      ...dot,
      vx: dot.vx + (Math.random() - 0.5) * 3.5,
      vy: dot.vy + (Math.random() - 0.5) * 3.5,
    }))
    tapsRef.current += 1
    setUsedDirs(prev => { const next = new Set(prev); next.add(dir); return next })
  }

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, GravDir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
      const dir = map[e.key]
      if (!dir) return
      e.preventDefault()
      applyDir(dir)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])   // eslint-disable-line react-hooks/exhaustive-deps

  const intro = 'Use the arrows (or keyboard) to tilt in all 4 directions!'

  const arrowBtn = (dir: GravDir, label: string, style: React.CSSProperties) => (
    <div
      onClick={() => applyDir(dir)}
      style={{
        position: 'absolute', ...style,
        width: 44, height: 44, borderRadius: '50%',
        background: 'rgba(0,0,0,0.07)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 22, cursor: 'pointer', userSelect: 'none',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.15)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.07)')}
    >{label}</div>
  )

  return (
    <>
      <div ref={canvasRef} style={{ ...canvasStyle, userSelect: 'none' }}>
        {dotsRef.current.map(dot => (
          <div key={dot.id} style={{ ...dotStyle(dot.color, false), left: `${dot.x}%`, top: `${dot.y}%`, transform: 'translate(-50%,-50%)', transition: 'none', pointerEvents: 'none' }} />
        ))}
        {arrowBtn('left',  '←', { left: 10,       top: '50%',  transform: 'translateY(-50%)' })}
        {arrowBtn('right', '→', { right: 10,      top: '50%',  transform: 'translateY(-50%)' })}
        {arrowBtn('up',    '↑', { top: 10,        left: '50%', transform: 'translateX(-50%)' })}
        {arrowBtn('down',  '↓', { bottom: 10,     left: '50%', transform: 'translateX(-50%)' })}
      </div>
      <IntroText>{intro}</IntroText>
      <SetDone done={done} />
    </>
  )
}

// ─── Page 7 — lineup ──────────────────────────────────────────────────────────
const COLOR_ROW  = Array.from({ length: 15 }, (_, i) => [RED, YELLOW, BLUE][i % 3])
const ROW_MARGIN    = (DOT_SIZE / 2 / 960) * 100
const LINEUP_MARGIN = 8   // % horizontal padding for pages 7 & 8

// Two-row lineup: 8 dots on top, 7 on bottom
const LINEUP_TOP_N = 8
const LINEUP_BOT_N = COLOR_ROW.length - LINEUP_TOP_N  // 7
const LINEUP_Y     = [37, 63]
const LINEUP_TOP_X = Array.from({ length: LINEUP_TOP_N }, (_, i) => LINEUP_MARGIN + i * ((100 - 2 * LINEUP_MARGIN) / (LINEUP_TOP_N - 1)))
const LINEUP_BOT_X = Array.from({ length: LINEUP_BOT_N }, (_, i) => LINEUP_MARGIN + i * ((100 - 2 * LINEUP_MARGIN) / (LINEUP_BOT_N - 1)))
function lineupPos(i: number): { x: number; y: number } {
  return i < LINEUP_TOP_N
    ? { x: LINEUP_TOP_X[i],               y: LINEUP_Y[0] }
    : { x: LINEUP_BOT_X[i - LINEUP_TOP_N], y: LINEUP_Y[1] }
}

// ─── Four lineup shapes for Page 7 ───────────────────────────────────────────
const SHAPE_NAMES = ['2 lines', '3 lines', 'circle', 'arch'] as const
const TOTAL_SHAPES = SHAPE_NAMES.length

function shapePos(shape: number, i: number, cw: number, ch: number): { x: number; y: number } {
  switch (shape) {
    case 0:
      // 2 lines: 8 top, 7 bottom
      return lineupPos(i)
    case 1: {
      // 3 lines: 5+5+5, tight within-line (10% ≈ 96px gap) vs large between-line (32%)
      const row = Math.floor(i / 5), col = i % 5
      return { x: 30 + col * 10, y: [18, 50, 82][row] }
    }
    case 2: {
      // Circle scaled to canvas; R ≤ 38% of each axis leaves ~12% edge padding for dot centres
      const R = Math.min(250, cw * 0.38, ch * 0.38)
      const θ = (2 * Math.PI * i / 15) - Math.PI / 2
      return { x: 50 + (R / cw * 100) * Math.cos(θ), y: 50 + (R / ch * 100) * Math.sin(θ) }
    }
    case 3: {
      if (ch > cw) {
        // Portrait: rotate arch 90° → vertical C-shape, centred; 38%/78% limits give ~12% edge padding
        const R = Math.min(420, cw * 0.78, ch * 0.38)
        const rx = R / cw * 100
        const ry = R / ch * 100
        const cx = 50 - rx / 2
        const θ = -Math.PI / 2 + (i / 14) * Math.PI
        return { x: cx + rx * Math.cos(θ), y: 50 + ry * Math.sin(θ) }
      }
      // Landscape: horizontal arch over top; 40%/78% limits give ~10% edge padding
      const R = Math.min(420, cw * 0.40, ch * 0.78)
      const ry = R / ch * 100
      const cy = 50 + ry / 2
      const θ = Math.PI + (i / 14) * Math.PI
      return { x: 50 + (R / cw * 100) * Math.cos(θ), y: cy + ry * Math.sin(θ) }
    }
    default:
      return lineupPos(i)
  }
}

function Page7() {
  const ds        = useContext(DotSizeCtx)
  const active    = useContext(PageActiveCtx)
  const handoff   = useContext(HandoffCtx)
  const [shapeIdx, setShapeIdx] = useState(-1)  // -1 = not yet clicked
  const [, tick]  = useState(0)
  const [dims, setDims] = useState({ cw: 960, ch: 640 })
  const startRef  = useRef<{ x: number; y: number }[]>(PILED_RIGHT)
  const initedRef = useRef(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const done = shapeIdx === TOTAL_SHAPES - 1

  useLayoutEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const { width: cw, height: ch } = entries[0].contentRect
      if (cw > 0 && ch > 0) setDims({ cw, ch })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    if (!active || initedRef.current) return
    initedRef.current = true
    const src = handoff.current.page6Dots
    if (src && src.length === 15) { startRef.current = src; tick(n => n + 1) }
  }, [active])   // eslint-disable-line react-hooks/exhaustive-deps

  function handleClick() {
    if (done) return
    setShapeIdx(s => s + 1)
  }

  const intro = 'Tap to cycle through different formations!'

  return (
    <>
      <div ref={canvasRef} onClick={handleClick} style={{ ...canvasStyle, cursor: done ? 'default' : 'pointer' }}>
        {COLOR_ROW.map((color, i) => {
          const pos = shapeIdx < 0
            ? (startRef.current[i] ?? PILED_RIGHT[i])
            : shapePos(shapeIdx, i, dims.cw, dims.ch)
          return (
            <div key={i} style={{
              position: 'absolute',
              left: `${pos.x}%`, top: `${pos.y}%`,
              transform: 'translate(-50%,-50%)',
              width: ds, height: ds, borderRadius: '50%',
              background: color,
              transition: shapeIdx >= 0
                ? `left ${0.45 + i * 0.035}s cubic-bezier(0.34,1.1,0.64,1), top ${0.45 + i * 0.035}s cubic-bezier(0.34,1.1,0.64,1)`
                : 'none',
              pointerEvents: 'none',
            }} />
          )
        })}
      </div>
      <IntroText>{intro}</IntroText>
      <SetDone done={done} />
    </>
  )
}

// ─── Page 8 — lights out ──────────────────────────────────────────────────────
function Page8() {
  const ds                        = useContext(DotSizeCtx)
  const [dark, setDark]           = useState(false)
  const [toggleCount, setToggleCount] = useState(0)
  const done8 = toggleCount >= 2   // off once + back on once
  const canvasRef = useRef<HTMLDivElement>(null)
  const dimsRef   = useRef({ cw: 960, ch: 640 })
  // Persistent dot positions (% coords); driven by RAF during swap
  const posRef   = useRef(COLOR_ROW.map((_, i) => shapePos(3, i, 960, 640)))
  const animRef  = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const swapping = useRef(false)
  const [, tick] = useState(0)

  useLayoutEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const { width: cw, height: ch } = entries[0].contentRect
      if (cw > 0 && ch > 0) {
        dimsRef.current = { cw, ch }
        posRef.current = COLOR_ROW.map((_, i) => shapePos(3, i, cw, ch))
        tick(n => n + 1)
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  function doSwap() {
    if (swapping.current) return
    swapping.current = true

    const reds  = COLOR_ROW.flatMap((c, i) => c === RED  ? [i] : [])
    const blues = COLOR_ROW.flatMap((c, i) => c === BLUE ? [i] : [])
    const ri = reds[Math.floor(Math.random() * reds.length)]
    const bi = blues[Math.floor(Math.random() * blues.length)]

    const p0 = { ...posRef.current[ri] }   // red start → will move to p1
    const p1 = { ...posRef.current[bi] }   // blue start → will move to p0

    // Red travels via high route (above both lineup rows at y≈37% and y≈63%)
    // Blue travels via low route (below both rows)
    // This guarantees neither path crosses any static dot
    const wx = () => (Math.random() - 0.5) * 10   // ±5% organic x wobble
    const hiY = 3 + Math.random() * 3              // 3–6% (above arch top at ~8%)
    const loY = 69 + Math.random() * 7             // 69–76% (below arch endpoints at ~65%)

    // Cubic bezier: go up/across/down for red, down/across/up for blue
    const cpR1 = { x: p0.x + wx(), y: hiY }
    const cpR2 = { x: p1.x + wx(), y: hiY }
    const cpB1 = { x: p1.x + wx(), y: loY }
    const cpB2 = { x: p0.x + wx(), y: loY }

    const DURATION = 1100
    const t0 = performance.now()

    function cubic(t: number, a: number, b: number, c: number, d: number) {
      const u = 1 - t
      return u*u*u*a + 3*u*u*t*b + 3*u*t*t*c + t*t*t*d
    }

    function step(now: number) {
      const raw = Math.min((now - t0) / DURATION, 1)
      const t   = raw < 0.5 ? 2 * raw * raw : -1 + (4 - 2 * raw) * raw

      posRef.current = posRef.current.map((pos, i) => {
        if (i === ri) return {
          x: cubic(t, p0.x, cpR1.x, cpR2.x, p1.x),
          y: cubic(t, p0.y, cpR1.y, cpR2.y, p1.y),
        }
        if (i === bi) return {
          x: cubic(t, p1.x, cpB1.x, cpB2.x, p0.x),
          y: cubic(t, p1.y, cpB1.y, cpB2.y, p0.y),
        }
        return pos
      })
      tick(n => n + 1)

      if (raw < 1) { animRef.current = requestAnimationFrame(step) }
      else { swapping.current = false; scheduleSwap() }
    }

    animRef.current = requestAnimationFrame(step)
  }

  function scheduleSwap() {
    const delay = 4000 + Math.random() * 4000   // 4–8 s
    timerRef.current = setTimeout(doSwap, delay)
  }

  useEffect(() => {
    if (!dark) return
    const { cw, ch } = dimsRef.current
    posRef.current = COLOR_ROW.map((_, i) => shapePos(3, i, cw, ch))
    scheduleSwap()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (animRef.current)  cancelAnimationFrame(animRef.current)
      swapping.current = false
    }
  }, [dark])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div ref={canvasRef} style={{ ...canvasStyle, background: dark ? '#111' : '#fff', border: `3px solid ${dark ? '#333' : '#f0e8d8'}`, transition: 'background 1.3s ease, border-color 1.3s ease' }}>
        {COLOR_ROW.map((color, i) => {
          const isYellow = color === YELLOW
          const dimmed   = dark && !isYellow
          const pos      = posRef.current[i]
          return (
            <div
              key={i}
              onClick={isYellow ? () => { setDark(d => !d); setToggleCount(c => c + 1) } : undefined}
              style={{
                position: 'absolute',
                left: `${pos.x}%`, top: `${pos.y}%`,
                transform: 'translate(-50%,-50%)',
                width: ds, height: ds, borderRadius: '50%',
                background: color,
                cursor: isYellow ? 'pointer' : 'default',
                opacity: dimmed ? 0.10 : 1,
                transition: 'opacity 1.3s ease',
              }}
            />
          )
        })}
      </div>
      <IntroText>Press a yellow dot to toggle the lights!</IntroText>
      <SetDone done={done8} />
    </>
  )
}

// ─── Clap celebration ─────────────────────────────────────────────────────────
function ClapCelebration() {
  useLayoutEffect(() => {
    const s = document.createElement('style')
    s.textContent = '@keyframes clapPop{0%{opacity:0;transform:translate(-50%,-50%) scale(0.3)}25%{opacity:1;transform:translate(-50%,-50%) scale(1.4)}65%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(0.8)}}'
    document.head.appendChild(s)
    return () => { document.head.removeChild(s) }
  }, [])
  return (
    <div style={{
      position: 'absolute', left: '50%', top: '50%',
      fontSize: 90, lineHeight: 1,
      animation: 'clapPop 1.4s ease forwards',
      pointerEvents: 'none', zIndex: 30,
    }}>👏</div>
  )
}

// ─── Page 9 — collect yellow dots ────────────────────────────────────────────
const YELLOW_IDXS = COLOR_ROW.flatMap((c, i) => c === YELLOW ? [i] : [])
type CollectPhase = 'arch' | 'flying' | 'gone'

function Page9() {
  const ds            = useContext(DotSizeCtx)
  const vw            = useWindowWidth()
  const isLandscape   = useIsLandscape()
  const canvasRef     = useRef<HTMLDivElement>(null)
  const basketBodyRef = useRef<HTMLDivElement>(null)
  const [dims,   setDims]   = useState({ cw: 960, ch: 640 })
  const [target, setTarget] = useState({ x: 50, y: 90 })
  const [phases, setPhases] = useState<CollectPhase[]>(() => COLOR_ROW.map(() => 'arch'))

  const collected = phases.filter((p, i) => COLOR_ROW[i] === YELLOW && p !== 'arch').length
  const done      = phases.every((p, i) => COLOR_ROW[i] !== YELLOW || p === 'gone')

  useLayoutEffect(() => {
    const canvasEl = canvasRef.current
    const bodyEl   = basketBodyRef.current
    if (!canvasEl || !bodyEl) return
    const update = () => {
      const cr = canvasEl.getBoundingClientRect()
      const br = bodyEl.getBoundingClientRect()
      if (cr.width > 0 && cr.height > 0) {
        setDims({ cw: cr.width, ch: cr.height })
        setTarget({
          x: ((br.left + br.width  / 2) - cr.left) / cr.width  * 100,
          y: ((br.top  + br.height / 2) - cr.top)  / cr.height * 100,
        })
      }
    }
    const obs = new ResizeObserver(update)
    obs.observe(canvasEl)
    return () => obs.disconnect()
  }, [])

  // flying → gone after position animation completes
  useEffect(() => {
    const flyingIdxs = phases.flatMap((p, i) => p === 'flying' ? [i] : [])
    if (flyingIdxs.length === 0) return
    const t = setTimeout(() => {
      setPhases(prev => prev.map((p, i) => flyingIdxs.includes(i) && p === 'flying' ? 'gone' : p))
    }, 550)
    return () => clearTimeout(t)
  }, [phases])

  function collect(i: number) {
    setPhases(prev => prev.map((p, idx) => idx === i && p === 'arch' ? 'flying' : p))
  }

  const intro = 'Click the yellow dots to collect them into the basket!'

  return (
    <>
      <div ref={canvasRef} style={{ ...canvasStyle }}>
        {COLOR_ROW.map((color, i) => {
          const phase    = phases[i]
          const isYellow = color === YELLOW
          const pos      = shapePos(3, i, dims.cw, dims.ch)
          const atTarget = phase !== 'arch'
          return (
            <div
              key={i}
              onClick={isYellow && phase === 'arch' ? () => collect(i) : undefined}
              style={{
                position: 'absolute',
                left:  `${atTarget ? target.x : pos.x}%`,
                top:   `${atTarget ? target.y : pos.y}%`,
                transform: 'translate(-50%,-50%)',
                width: ds + 40, height: ds + 40,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                opacity: phase === 'gone' ? 0 : 1,
                cursor: isYellow && phase === 'arch' ? 'pointer' : 'default',
                transition: phase === 'arch'
                  ? 'none'
                  : phase === 'flying'
                  ? 'left 0.5s ease-in, top 0.5s ease-in'
                  : 'opacity 0.2s ease',
                zIndex: phase !== 'arch' ? 10 : 1,
                pointerEvents: isYellow && phase === 'arch' ? 'auto' : 'none',
              }}
            >
              <div style={{ width: ds, height: ds, borderRadius: '50%', background: color, pointerEvents: 'none' }} />
            </div>
          )
        })}

        {/* Basket */}
        {(() => {
          const bw   = Math.min(110, Math.max(60, Math.round(vw * 0.17)))
          const bh   = Math.round(bw * 72 / 110)
          const hw   = Math.round(bw * 70 / 110)
          const hh   = Math.round(bw * 28 / 110)
          const bpos = isLandscape
            ? { left: BASKET_LEFT[YELLOW], bottom: '5%', top: 'auto', transform: 'translateX(-50%)' }
            : { left: '15%', top: BASKET_TOP[YELLOW], bottom: 'auto', transform: 'translate(-50%,-50%)' }
          return (
            <div style={{ position: 'absolute', ...bpos, pointerEvents: 'none', zIndex: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ margin: '0 auto', width: hw, height: hh, border: `5px solid ${YELLOW}`, borderBottom: 'none', borderRadius: '40px 40px 0 0' }} />
              <div ref={basketBodyRef} style={{ width: bw, height: bh, border: `5px solid ${YELLOW}`, borderRadius: '0 0 18px 18px', background: YELLOW + '20', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.max(13, Math.round(bw * 0.2)), fontWeight: 700, color: YELLOW }}>
                {`${collected}/${YELLOW_IDXS.length}`}
              </div>
            </div>
          )
        })()}

      </div>
      <IntroText>{intro}</IntroText>
      <SetDone done={done} />
    </>
  )
}

// ─── Brownian catch pages ─────────────────────────────────────────────────────
type BrownDot = { id: string; x: number; y: number; vx: number; vy: number; phase: CollectPhase }

function makeBrownDots(targetColor: string, cw: number, ch: number): BrownDot[] {
  return COLOR_ROW.flatMap((c, i) => {
    if (c !== targetColor) return []
    const pos = shapePos(3, i, cw, ch)
    return [{ id: `brown-${i}`, x: pos.x, y: pos.y, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4, phase: 'arch' as CollectPhase }]
  })
}

function stepBrown(dots: BrownDot[], maxSpd: number, cw: number, ch: number, dotSize = DOT_SIZE): BrownDot[] {
  const rxPct = dotSize / 2 / cw * 100
  const ryPct = dotSize / 2 / ch * 100
  return dots.map(dot => {
    if (dot.phase !== 'arch') return dot
    let vx = dot.vx + (Math.random() - 0.5) * 0.12
    let vy = dot.vy + (Math.random() - 0.5) * 0.12
    const spd = Math.sqrt(vx * vx + vy * vy)
    if (spd > maxSpd) { vx = vx / spd * maxSpd; vy = vy / spd * maxSpd }
    let x = dot.x + vx
    let y = dot.y + vy
    if (x < rxPct)       { x = rxPct;       vx =  Math.abs(vx) }
    if (x > 100 - rxPct) { x = 100 - rxPct; vx = -Math.abs(vx) }
    if (y < ryPct)       { y = ryPct;       vy =  Math.abs(vy) }
    if (y > 100 - ryPct) { y = 100 - ryPct; vy = -Math.abs(vy) }
    return { ...dot, x, y, vx, vy }
  })
}

function BrownCatch({ targetColor, maxSpd, prevColors, previewColor }: {
  targetColor: string; maxSpd: number; prevColors: string[]; previewColor?: string
}) {
  const ds            = useContext(DotSizeCtx)
  const vw            = useWindowWidth()
  const isLandscape   = useIsLandscape()
  const active        = useContext(PageActiveCtx)
  const canvasRef     = useRef<HTMLDivElement>(null)
  const basketBodyRef = useRef<HTMLDivElement>(null)
  const dotsRef       = useRef<BrownDot[]>([])
  const previewRef    = useRef<BrownDot[]>([])
  const rafRef        = useRef<number | null>(null)
  const dimsRef       = useRef({ cw: 960, ch: 640 })
  const [, tick]      = useState(0)
  const [phases, setPhases]       = useState<CollectPhase[]>([])
  const [targetPct, setTargetPct] = useState({ x: 50, y: 90 })

  const allColors    = [...prevColors, targetColor]
  const totalPerColor = (c: string) => COLOR_ROW.filter(r => r === c).length
  const targetTotal  = totalPerColor(targetColor)
  const collected    = phases.filter(p => p !== 'arch').length
  const done         = phases.length > 0 && phases.every(p => p === 'gone')

  useLayoutEffect(() => {
    const canvasEl = canvasRef.current
    const bodyEl   = basketBodyRef.current
    if (!canvasEl || !bodyEl) return
    const update = () => {
      const cr = canvasEl.getBoundingClientRect()
      const br = bodyEl.getBoundingClientRect()
      if (cr.width > 0 && cr.height > 0) {
        const { width: cw, height: ch } = cr
        dimsRef.current = { cw, ch }
        setTargetPct({
          x: ((br.left + br.width  / 2) - cr.left) / cw * 100,
          y: ((br.top  + br.height / 2) - cr.top)  / ch * 100,
        })
        if (dotsRef.current.length === 0) {
          const newDots = makeBrownDots(targetColor, cw, ch)
          dotsRef.current = newDots
          setPhases(newDots.map(() => 'arch'))
        }
        if (previewColor && previewRef.current.length === 0) {
          previewRef.current = makeBrownDots(previewColor, cw, ch)
        }
      }
    }
    const obs = new ResizeObserver(update)
    obs.observe(canvasEl)
    return () => obs.disconnect()
  }, [targetColor])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
      return
    }
    let alive = true
    const step = () => {
      if (!alive) return
      dotsRef.current  = stepBrown(dotsRef.current,  maxSpd,        dimsRef.current.cw, dimsRef.current.ch, ds)
      previewRef.current = stepBrown(previewRef.current, maxSpd * 2, dimsRef.current.cw, dimsRef.current.ch, ds)
      tick(n => n + 1)
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      alive = false
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    }
  }, [active, maxSpd])

  useEffect(() => {
    const flyingIdxs = phases.flatMap((p, i) => p === 'flying' ? [i] : [])
    if (flyingIdxs.length === 0) return
    const t = setTimeout(() => {
      dotsRef.current = dotsRef.current.map((d, i) =>
        flyingIdxs.includes(i) ? { ...d, phase: 'gone' } : d
      )
      setPhases(prev => prev.map((p, i) => flyingIdxs.includes(i) && p === 'flying' ? 'gone' : p))
    }, 550)
    return () => clearTimeout(t)
  }, [phases])

  function collect(dotIdx: number) {
    dotsRef.current = dotsRef.current.map((d, i) =>
      i === dotIdx && d.phase === 'arch' ? { ...d, phase: 'flying' } : d
    )
    setPhases(prev => prev.map((p, i) => i === dotIdx && p === 'arch' ? 'flying' : p))
  }

  const intro = targetColor === BLUE
    ? 'Catch all the moving blue dots!'
    : 'The red dots are even faster — catch them all!'

  return (
    <>
      <div ref={canvasRef} style={{ ...canvasStyle }}>
        {dotsRef.current.map((dot, i) => {
          const phase    = phases[i] ?? 'arch'
          const atTarget = phase !== 'arch'
          return (
            <div
              key={dot.id}
              onClick={phase === 'arch' ? () => collect(i) : undefined}
              style={{
                position: 'absolute',
                left: `${atTarget ? targetPct.x : dot.x}%`,
                top:  `${atTarget ? targetPct.y : dot.y}%`,
                transform: 'translate(-50%,-50%)',
                width: ds + 40, height: ds + 40,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                opacity: phase === 'gone' ? 0 : 1,
                cursor: phase === 'arch' ? 'pointer' : 'default',
                transition: phase === 'arch'
                  ? 'none'
                  : phase === 'flying'
                  ? 'left 0.5s ease-in, top 0.5s ease-in'
                  : 'opacity 0.2s ease',
                zIndex: phase !== 'arch' ? 10 : 1,
                pointerEvents: phase === 'arch' ? 'auto' : 'none',
              }}
            >
              <div style={{ width: ds, height: ds, borderRadius: '50%', background: targetColor, pointerEvents: 'none' }} />
            </div>
          )
        })}

        {/* Preview dots — non-interactive, foreshadow next page */}
        {previewColor && previewRef.current.map(dot => (
          <div key={dot.id} style={{
            position: 'absolute',
            left: `${dot.x}%`, top: `${dot.y}%`,
            transform: 'translate(-50%,-50%)',
            width: ds, height: ds, borderRadius: '50%',
            background: previewColor,
            pointerEvents: 'none', zIndex: 1,
          }} />
        ))}

        {/* Baskets — fixed positions by color so they don't shift between pages */}
        {(() => {
          const bw  = Math.min(110, Math.max(60, Math.round(vw * 0.17)))
          const bh  = Math.round(bw * 72 / 110)
          const hw  = Math.round(bw * 70 / 110)
          const hh  = Math.round(bw * 28 / 110)
          return allColors.map((color, bi) => {
            const isTarget = bi === allColors.length - 1
            const count    = isTarget ? collected : totalPerColor(color)
            const total    = totalPerColor(color)
            const bpos     = isLandscape
              ? { left: BASKET_LEFT[color], bottom: '5%', top: 'auto', transform: 'translateX(-50%)' }
              : { left: '15%', top: BASKET_TOP[color], bottom: 'auto', transform: 'translate(-50%,-50%)' }
            return (
              <div key={color} style={{ position: 'absolute', ...bpos, display: 'flex', flexDirection: 'column', alignItems: 'center', pointerEvents: 'none', zIndex: 0 }}>
                <div style={{ margin: '0 auto', width: hw, height: hh, border: `5px solid ${color}`, borderBottom: 'none', borderRadius: '40px 40px 0 0' }} />
                <div ref={isTarget ? basketBodyRef : undefined} style={{ width: bw, height: bh, border: `5px solid ${color}`, borderRadius: '0 0 18px 18px', background: color + '20', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.max(13, Math.round(bw * 0.2)), fontWeight: 700, color }}>
                  {`${count}/${total}`}
                </div>
              </div>
            )
          })
        })()}

      </div>
      <IntroText>{intro}</IntroText>
      <SetDone done={done} />
    </>
  )
}

function Page10() { return <BrownCatch targetColor={BLUE} maxSpd={0.35} prevColors={[YELLOW]} previewColor={RED} /> }
function Page11() { return <BrownCatch targetColor={RED}  maxSpd={0.7}  prevColors={[YELLOW, BLUE]} /> }

// ─── Shared styles ────────────────────────────────────────────────────────────
const canvasStyle: React.CSSProperties = {
  flex: 1, minHeight: 0,
  width: '100%',
  background: '#fff', borderRadius: 18,
  border: '2px solid #ede8df',
  position: 'relative', overflow: 'hidden',
}

const dotStyle = (color: string, interactive = true, ds = DOT_SIZE): React.CSSProperties => ({
  position: 'absolute',
  width: ds, height: ds,
  borderRadius: '50%', background: color,
  cursor: interactive ? 'pointer' : 'default',
  WebkitTapHighlightColor: 'transparent',
})

// ─── Chapter 2 shared constants ───────────────────────────────────────────────
const BURST_COLORS = [
  '#ff2200','#ff6600','#ffaa00','#ffdd00','#aadd00',
  '#33bb33','#00bbaa','#00aaff','#4466ff','#8833ff',
  '#cc22ee','#ff22aa','#ff5588','#ff8833',
]
const BURST_COUNT = 70    // 5 per color × 14 colors
const MINI_PX     = 26   // dot diameter in px (ch2)
const RAINBOW_BG  = 'linear-gradient(90deg,#ff0000,#ff9900,#ffff00,#33dd33,#3399ff,#cc33ff,#ff0000)'

// ─── Chapter 2 Page 1 — merge + rainbow burst ────────────────────────────────
type Ch2P1Phase = 'idle' | 'merging' | 'merged' | 'shining' | 'lit' | 'rainbow' | 'bursting' | 'roaming'

function Chapter2Page1() {
  const active    = useContext(PageActiveCtx)
  const handoff   = useContext(HandoffCtx)
  const vw        = useWindowWidth()
  const [phase, setPhase] = useState<Ch2P1Phase>('idle')
  const phaseRef  = useRef<Ch2P1Phase>('idle')
  const dotsRef   = useRef<PhysDot[]>([])
  const rafRef    = useRef<number | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dimsRef   = useRef({ cw: 960, ch: 520 })
  const frameRef  = useRef(0)
  const [, tick]  = useState(0)

  useLayoutEffect(() => {
    const s = document.createElement('style')
    s.textContent = [
      '@keyframes beamReveal{0%{transform:scaleY(0);opacity:0}15%{opacity:1}65%{transform:scaleY(1);opacity:0.72}100%{transform:scaleY(1);opacity:0}}',
      `@keyframes rybShimmer{0%{background:${RED}}33%{background:${YELLOW}}67%{background:${BLUE}}100%{background:${RED}}}`,
      '@keyframes fadeIn{0%{opacity:0}100%{opacity:1}}',
    ].join('')
    document.head.appendChild(s)
    return () => { document.head.removeChild(s) }
  }, [])

  useLayoutEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const { width: cw, height: ch } = entries[0].contentRect
      if (cw > 0 && ch > 0) dimsRef.current = { cw, ch }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // ── Merge sequence (auto-triggered on activation) ─────────────────────────
  const mergeTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  function cancelMergeTimers() {
    mergeTimersRef.current.forEach(clearTimeout)
    mergeTimersRef.current = []
  }

  // Cancel timers on unmount
  useEffect(() => () => cancelMergeTimers(), []) // eslint-disable-line react-hooks/exhaustive-deps

  function startMerge() {
    if (phaseRef.current !== 'idle') return
    phaseRef.current = 'merging'; setPhase('merging')
    const t1 = setTimeout(() => {
      phaseRef.current = 'merged'; setPhase('merged')
      const t2 = setTimeout(() => {
        phaseRef.current = 'shining'; setPhase('shining')
        // basket turns rainbow exactly when beam animation ends (1900ms)
        const t3 = setTimeout(() => {
          phaseRef.current = 'lit'; setPhase('lit')
          const t4 = setTimeout(() => {
            phaseRef.current = 'rainbow'; setPhase('rainbow')
          }, 350)   // brief pause then clickable
          mergeTimersRef.current.push(t4)
        }, 1900)   // beam animation duration
        mergeTimersRef.current.push(t3)
      }, 680)      // wait for basketPop
      mergeTimersRef.current.push(t2)
    }, 700)        // wait for slide
    mergeTimersRef.current.push(t1)
  }

  // Auto-trigger merge when page becomes active; cancel if it goes inactive
  useEffect(() => {
    if (!active) { cancelMergeTimers(); return }
    const t = setTimeout(startMerge, 400)   // small delay so page is visible first
    return () => clearTimeout(t)
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Firework burst ────────────────────────────────────────────────────────
  function handleRainbowBasketClick() {
    if (phaseRef.current !== 'rainbow') return
    const { ch } = dimsRef.current
    const bx = 50
    const by = 100 - 5 - (172 / ch * 100 / 2)
    frameRef.current = 0
    dotsRef.current = Array.from({ length: BURST_COUNT }, (_, i) => {
      // Fan upward: angles span from -140° to +140° around 12 o'clock
      const angle = -Math.PI / 2 + ((i / (BURST_COUNT - 1)) - 0.5) * (Math.PI * 1.55) + (Math.random() - 0.5) * 0.25
      const speed = 2.8 + Math.random() * 2.6
      return {
        id:       `rdot-${i}`,
        color:    BURST_COLORS[i % BURST_COLORS.length],
        x:        bx + (Math.random() - 0.5) * 4,
        y:        by + (Math.random() - 0.5) * 4,
        vx:       Math.cos(angle) * speed,
        vy:       Math.sin(angle) * speed,   // negative = upward
        friction: 0.94 + Math.random() * 0.04,
      }
    })
    phaseRef.current = 'bursting'; setPhase('bursting')
  }

  // ── RAF loop (bursting → roaming) ─────────────────────────────────────────
  useEffect(() => {
    if (!active || (phaseRef.current !== 'bursting' && phaseRef.current !== 'roaming')) return
    let alive = true
    const step = () => {
      if (!alive) return
      const { cw, ch } = dimsRef.current
      const rx = MINI_PX / 2 / cw * 100
      const ry = MINI_PX / 2 / ch * 100
      const settling = frameRef.current < 55

      dotsRef.current = dotsRef.current.map(dot => {
        let { x, y, vx, vy, friction } = dot
        if (settling) {
          vy -= 0.03   // gentle upward lift — keeps dots in upper sky
        } else {
          vx += (Math.random() - 0.5) * 0.13
          vy += (Math.random() - 0.5) * 0.13
        }
        vx *= friction; vy *= friction
        const spd = Math.sqrt(vx * vx + vy * vy)
        const cap = settling ? 5.0 : 0.75
        if (spd > cap) { vx = vx / spd * cap; vy = vy / spd * cap }
        x += vx; y += vy
        if (x < rx)       { x = rx;       vx =  Math.abs(vx) * BOUNCE }
        if (x > 100 - rx) { x = 100 - rx; vx = -Math.abs(vx) * BOUNCE }
        if (y < ry)       { y = ry;       vy =  Math.abs(vy) * BOUNCE }
        if (y > 100 - ry) { y = 100 - ry; vy = -Math.abs(vy) * BOUNCE }
        return { ...dot, x, y, vx, vy }
      })

      dotsRef.current = resolveCollisions(dotsRef.current, cw, ch, MINI_PX)
      frameRef.current++

      if (frameRef.current === 55) {
        phaseRef.current = 'roaming'; setPhase('roaming')
      }
      if (frameRef.current >= 55) {
        handoff.current.ch2p2Dots = dotsRef.current.map(d => ({ x: d.x, y: d.y, vx: d.vx, vy: d.vy, color: d.color }))
      }

      tick(n => n + 1)
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => { alive = false; if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null } }
  }, [active, phase])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }, [])

  // ── Derived display values ─────────────────────────────────────────────────
  const colors = [BLUE, YELLOW, RED]
  const bigBasketShown = phase === 'merged' || phase === 'shining' || phase === 'lit' || phase === 'rainbow'
  const isRainbow      = phase === 'lit' || phase === 'rainbow'
  const showBeam       = phase === 'shining' || phase === 'lit'
  // Small baskets only shown before the merge completes
  const showSmallBaskets = phase === 'idle' || phase === 'merging'


  return (
    <>
      <div ref={canvasRef} style={canvasStyle}>

        {/* ── 3 small baskets (idle + merging only) ── */}
        {showSmallBaskets && (() => {
          const bw = Math.min(110, Math.max(60, Math.round(vw * 0.17)))
          const bh = Math.round(bw * 72 / 110)
          const hw = Math.round(bw * 70 / 110)
          const hh = Math.round(bw * 28 / 110)
          return colors.map(color => (
            <div key={color} style={{ position: 'absolute', left: phase === 'idle' ? BASKET_LEFT[color] : '50%', bottom: '5%', transform: 'translateX(-50%)', transition: 'left 0.6s cubic-bezier(0.34,1.1,0.64,1)', display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'default', pointerEvents: 'none', zIndex: 2 }}>
              <div style={{ margin: '0 auto', width: hw, height: hh, border: `5px solid ${color}`, borderBottom: 'none', borderRadius: '40px 40px 0 0' }} />
              <div style={{ width: bw, height: bh, border: `5px solid ${color}`, borderRadius: '0 0 18px 18px', background: color + '20', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.max(13, Math.round(bw * 0.2)), fontWeight: 700, color }}>✓</div>
            </div>
          ))
        })()}

        {/* ── Rainbow beam ── */}
        {showBeam && (
          <div style={{
            position: 'absolute',
            left: '50%', marginLeft: -110,
            top: 0, bottom: '16%', width: 220,
            background: 'linear-gradient(to bottom,rgba(255,0,0,0.5) 0%,rgba(255,165,0,0.45) 16%,rgba(255,255,0,0.4) 32%,rgba(0,200,0,0.35) 48%,rgba(0,100,255,0.35) 64%,rgba(148,0,211,0.3) 82%,rgba(255,50,180,0.18) 100%)',
            clipPath: 'polygon(38% 0%,62% 0%,95% 100%,5% 100%)',
            transformOrigin: 'top center',
            animation: 'beamReveal 1.9s ease-out forwards',
            pointerEvents: 'none', zIndex: 10,
          }} />
        )}

        {/* ── Big merged basket ── */}
        {bigBasketShown && (() => {
          const bw  = Math.min(110, Math.max(60, Math.round(vw * 0.17)))
          const bbw = Math.round(bw * 190 / 110)
          const bbh = Math.round(bw * 120 / 110)
          const bhw = Math.round(bw * 120 / 110)
          const bhh = Math.round(bw *  46 / 110)
          return (
            <div onClick={handleRainbowBasketClick} style={{ position: 'absolute', left: '50%', bottom: '5%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', animation: phase === 'merged' ? 'fadeIn 0.45s ease forwards' : 'none', cursor: phase === 'rainbow' ? 'pointer' : 'default', pointerEvents: phase === 'rainbow' ? 'auto' : 'none', zIndex: 11 }}>
              <div style={{ margin: '0 auto', width: bhw, height: bhh, border: `6px solid ${isRainbow ? '#ffdd00' : '#888'}`, borderBottom: 'none', borderRadius: '60px 60px 0 0', animation: isRainbow ? 'rybShimmer 2s linear infinite' : 'none', animationDelay: isRainbow ? '-0.5s' : '0s', boxShadow: isRainbow ? '0 0 22px rgba(255,200,0,0.75)' : 'none', transition: 'box-shadow 0.4s ease' }} />
              <div style={{ width: bbw, height: bbh, border: `6px solid ${isRainbow ? '#ffdd00' : '#888'}`, borderRadius: '0 0 28px 28px', background: isRainbow ? undefined : '#88888818', animation: isRainbow ? 'rybShimmer 2s linear infinite' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, boxShadow: isRainbow ? '0 0 32px 8px rgba(255,200,0,0.7),inset 0 0 18px rgba(255,255,255,0.25)' : 'none', transition: 'box-shadow 0.4s ease' }}>
                {!isRainbow && [YELLOW, BLUE, RED].map(c => (
                  <div key={c} style={{ width: Math.round(bw * 30 / 110), height: Math.round(bw * 30 / 110), borderRadius: '50%', background: c }} />
                ))}
                {isRainbow && <span style={{ fontSize: Math.max(24, Math.round(bw * 44 / 110)), lineHeight: 1 }}>🌈</span>}
              </div>
            </div>
          )
        })()}

        {/* ── Dots (burst + roam) ── */}
        {(phase === 'bursting' || phase === 'roaming') && dotsRef.current.map(dot => (
          <div key={dot.id} style={{
            position: 'absolute',
            left: `${dot.x}%`, top: `${dot.y}%`,
            transform: 'translate(-50%,-50%)',
            width: MINI_PX, height: MINI_PX, borderRadius: '50%',
            background: dot.color, pointerEvents: 'none',
          }} />
        ))}

      </div>
      <IntroText>Watch the magic happen! 🌈</IntroText>
      <SetDone done={phase === 'roaming'} />
    </>
  )
}

// ─── Great Job screen (Ch2 / Ch3 completion) ─────────────────────────────────
function GreatJob({ onReset, onNextChapter }: { onReset: () => void; onNextChapter?: () => void }) {
  useLayoutEffect(() => {
    const s = document.createElement('style')
    s.textContent = '@keyframes shineText2{0%{background-position:200% center}100%{background-position:0% center}}'
    document.head.appendChild(s)
    return () => { document.head.removeChild(s) }
  }, [])
  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 'clamp(20px, 4vw, 36px)',
      background: '#fff',
      fontFamily: '"Nunito Variable", Nunito, sans-serif',
      userSelect: 'none',
    }}>
      <img
        src={import.meta.env.BASE_URL + 'completion-ch2.gif'}
        alt="Great job!"
        style={{ width: 'clamp(180px, 50vw, 320px)', height: 'clamp(180px, 50vw, 320px)', borderRadius: 28, objectFit: 'cover' }}
      />
      <div style={{
        fontSize: 'clamp(56px,8vw,96px)', fontWeight: 900, letterSpacing: -2,
        background: 'linear-gradient(90deg, #FDD302 0%, #F63664 30%, #5CCBF8 60%, #FDD302 100%)',
        backgroundSize: '300% auto',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        animation: 'shineText2 2.8s linear infinite',
      }}>
        Great job!
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <button
          onClick={onReset}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '12px 30px', borderRadius: 40,
            background: 'transparent', border: '2px solid #ccc',
            fontSize: 17, fontWeight: 700, color: '#888',
            fontFamily: 'inherit', cursor: 'pointer',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#aaa'; e.currentTarget.style.color = '#555' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#ccc'; e.currentTarget.style.color = '#888' }}
          onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.96)')}
          onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
        >
          <RotateCcw size={16} /> Play again
        </button>
        {onNextChapter && (
          <button
            onClick={onNextChapter}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '12px 30px', borderRadius: 40,
              background: '#FDD302', border: 'none',
              fontSize: 17, fontWeight: 800, color: '#333',
              fontFamily: 'inherit', cursor: 'pointer',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#ffc700')}
            onMouseLeave={e => (e.currentTarget.style.background = '#FDD302')}
            onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.96)')}
            onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
          >
            Next Chapter <ChevronRight size={18} strokeWidth={3} />
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Woohoo screen (ch3) ─────────────────────────────────────────────────────
function WoohooScreen({ onReset, onNextChapter }: { onReset: () => void; onNextChapter?: () => void }) {
  useLayoutEffect(() => {
    const s = document.createElement('style')
    s.textContent = '@keyframes shineText3{0%{background-position:200% center}100%{background-position:0% center}}'
    document.head.appendChild(s)
    return () => { document.head.removeChild(s) }
  }, [])
  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 'clamp(20px, 4vw, 36px)',
      background: '#fff',
      fontFamily: '"Nunito Variable", Nunito, sans-serif',
      userSelect: 'none',
    }}>
      <img
        src={import.meta.env.BASE_URL + 'completion-ch3.gif'}
        alt="Woohoo!"
        style={{ width: 'clamp(180px, 50vw, 320px)', height: 'clamp(180px, 50vw, 320px)', borderRadius: 28, objectFit: 'cover' }}
      />
      <div style={{
        fontSize: 'clamp(56px,8vw,96px)', fontWeight: 900, letterSpacing: -2,
        background: 'linear-gradient(90deg, #5CCBF8 0%, #FDD302 30%, #F63664 60%, #5CCBF8 100%)',
        backgroundSize: '300% auto',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        animation: 'shineText3 2.8s linear infinite',
      }}>
        Woohoo!!!
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <button
          onClick={onReset}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '12px 30px', borderRadius: 40,
            background: 'transparent', border: '2px solid #ccc',
            fontSize: 17, fontWeight: 700, color: '#888',
            fontFamily: 'inherit', cursor: 'pointer',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#aaa'; e.currentTarget.style.color = '#555' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#ccc'; e.currentTarget.style.color = '#888' }}
          onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.96)')}
          onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
        >
          <RotateCcw size={16} /> Play again
        </button>
        {onNextChapter && (
          <button
            onClick={onNextChapter}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '12px 30px', borderRadius: 40,
              background: '#FDD302', border: 'none',
              fontSize: 17, fontWeight: 800, color: '#333',
              fontFamily: 'inherit', cursor: 'pointer',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#ffc700')}
            onMouseLeave={e => (e.currentTarget.style.background = '#FDD302')}
            onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.96)')}
            onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
          >
            Next Chapter <ChevronRight size={18} strokeWidth={3} />
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Amazing screen (ch4) ─────────────────────────────────────────────────────
function AmazingScreen({ onReset }: { onReset: () => void }) {
  useLayoutEffect(() => {
    const s = document.createElement('style')
    s.textContent = '@keyframes shineText4{0%{background-position:200% center}100%{background-position:0% center}} @keyframes popIn{0%{transform:scale(0) rotate(-20deg);opacity:0}60%{transform:scale(1.2) rotate(5deg);opacity:1}100%{transform:scale(1) rotate(0deg);opacity:1}}'
    document.head.appendChild(s)
    return () => { document.head.removeChild(s) }
  }, [])
  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 'clamp(20px, 4vw, 36px)',
      background: '#fff',
      fontFamily: '"Nunito Variable", Nunito, sans-serif',
      userSelect: 'none',
    }}>
      <div style={{ fontSize: 'clamp(80px, 18vw, 140px)', lineHeight: 1, animation: 'popIn 0.7s cubic-bezier(0.34,1.56,0.64,1) forwards' }}>
        🏆
      </div>
      <div style={{
        fontSize: 'clamp(56px,8vw,96px)', fontWeight: 900, letterSpacing: -2,
        background: 'linear-gradient(90deg, #FDD302 0%, #F63664 30%, #5CCBF8 60%, #FDD302 100%)',
        backgroundSize: '300% auto',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        animation: 'shineText4 2.8s linear infinite',
      }}>
        Amazing!
      </div>
      <div style={{ fontSize: 18, color: '#888', fontWeight: 600 }}>
        You beat me at Tic Tac Toe!
      </div>
      <button
        onClick={onReset}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 30px', borderRadius: 40,
          background: 'transparent', border: '2px solid #ccc',
          fontSize: 17, fontWeight: 700, color: '#888',
          fontFamily: 'inherit', cursor: 'pointer',
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = '#aaa'; e.currentTarget.style.color = '#555' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = '#ccc'; e.currentTarget.style.color = '#888' }}
        onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.96)')}
        onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
      >
        <RotateCcw size={16} /> Play again
      </button>
    </div>
  )
}

// ─── Well Done screen ─────────────────────────────────────────────────────────
function WellDone({ onReset, onNextChapter }: { onReset: () => void; onNextChapter: () => void }) {
  useLayoutEffect(() => {
    const s = document.createElement('style')
    s.textContent = '@keyframes shineText{0%{background-position:200% center}100%{background-position:0% center}}'
    document.head.appendChild(s)
    return () => { document.head.removeChild(s) }
  }, [])
  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 'clamp(20px, 4vw, 36px)',
      background: '#fff',
      fontFamily: '"Nunito Variable", Nunito, sans-serif',
      userSelect: 'none',
    }}>
      <img
        src={import.meta.env.BASE_URL + 'completion-ch1.gif'}
        alt="Well done!"
        style={{ maxWidth: 380, maxHeight: 340, width: '100%', borderRadius: 28, objectFit: 'contain', display: 'block' }}
      />
      <div style={{
        fontSize: 'clamp(56px,8vw,96px)', fontWeight: 900, letterSpacing: -2,
        background: 'linear-gradient(90deg, #FDD302 0%, #F63664 30%, #5CCBF8 60%, #FDD302 100%)',
        backgroundSize: '300% auto',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        animation: 'shineText 2.8s linear infinite',
      }}>
        Well done!
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <button
          onClick={onReset}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 28px', borderRadius: 40,
            background: 'transparent', border: '2px solid #ccc',
            fontSize: 16, fontWeight: 700, color: '#888',
            fontFamily: 'inherit', cursor: 'pointer',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#aaa'; e.currentTarget.style.color = '#555' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#ccc'; e.currentTarget.style.color = '#888' }}
        >
          <RotateCcw size={16} /> Play again
        </button>
        <button
          onClick={onNextChapter}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '14px 36px', borderRadius: 40,
            background: '#FDD302', border: 'none',
            fontSize: 20, fontWeight: 800, color: '#333',
            fontFamily: 'inherit', cursor: 'pointer',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = '#ffc700')}
          onMouseLeave={e => (e.currentTarget.style.background = '#FDD302')}
          onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.96)')}
          onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
        >
          Next Chapter <ChevronRight size={22} strokeWidth={3} />
        </button>
      </div>
    </div>
  )
}

// ─── Chapter 2 Page 2 — circle ───────────────────────────────────────────────
type CirclePhase = 'roaming' | 'forming' | 'exploding'

const MAX_CIRCLE_R = 180   // px starting radius
const MIN_CIRCLE_R = 28    // px minimum after long hold
const SHRINK_MS    = 3000  // ms to shrink from max to min

function Chapter2Page3() {
  const active     = useContext(PageActiveCtx)
  const handoff    = useContext(HandoffCtx)
  const [phase, setPhase] = useState<CirclePhase>('roaming')
  const dotsRef    = useRef<PhysDot[]>([])
  const rafRef     = useRef<number | null>(null)
  const canvasRef  = useRef<HTMLDivElement>(null)
  const dimsRef    = useRef({ cw: 960, ch: 520 })
  const phaseRef   = useRef<CirclePhase>('roaming')
  const initedRef  = useRef(false)
  const [, tick]   = useState(0)

  const centerRef       = useRef({ x: 50, y: 50 })  // % coords of circle center
  const radiusPxRef     = useRef(MAX_CIRCLE_R)
  const pressTimeRef    = useRef(0)
  const explodeFrameRef = useRef(0)
  const hasCompletedRef = useRef(false)  // true once first explosion finishes

  useLayoutEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const { width: cw, height: ch } = entries[0].contentRect
      if (cw > 0 && ch > 0) dimsRef.current = { cw, ch }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    if (!active || initedRef.current) return
    initedRef.current = true
    const src = handoff.current.ch2p2Dots
    if (src && src.length === BURST_COUNT) {
      dotsRef.current = src.map((d, i) => ({
        id: `c3-${i}`,
        color: d.color,
        x: d.x, y: d.y,
        vx: d.vx, vy: d.vy,
        friction: 0.92 + Math.random() * 0.06,
      }))
    } else {
      dotsRef.current = Array.from({ length: BURST_COUNT }, (_, i) => ({
        id: `c3-${i}`,
        color: BURST_COLORS[i % BURST_COLORS.length],
        x: 8 + Math.random() * 84,
        y: 8 + Math.random() * 84,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        friction: 0.92 + Math.random() * 0.06,
      }))
    }
    tick(n => n + 1)
  }, [active])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
      return
    }
    let alive = true
    const step = () => {
      if (!alive) return
      const { cw, ch } = dimsRef.current
      const rx = MINI_PX / 2 / cw * 100
      const ry = MINI_PX / 2 / ch * 100
      const ph = phaseRef.current

      if (ph === 'roaming') {
        dotsRef.current = dotsRef.current.map(dot => {
          let { x, y, vx, vy, friction } = dot
          vx += (Math.random() - 0.5) * 0.13
          vy += (Math.random() - 0.5) * 0.13
          vx *= friction; vy *= friction
          const spd = Math.sqrt(vx * vx + vy * vy)
          if (spd > 0.75) { vx = vx / spd * 0.75; vy = vy / spd * 0.75 }
          x += vx; y += vy
          if (x < rx)       { x = rx;       vx =  Math.abs(vx) * BOUNCE }
          if (x > 100 - rx) { x = 100 - rx; vx = -Math.abs(vx) * BOUNCE }
          if (y < ry)       { y = ry;       vy =  Math.abs(vy) * BOUNCE }
          if (y > 100 - ry) { y = 100 - ry; vy = -Math.abs(vy) * BOUNCE }
          return { ...dot, x, y, vx, vy }
        })
        dotsRef.current = resolveCollisions(dotsRef.current, cw, ch, MINI_PX)

      } else if (ph === 'forming') {
        // Shrink radius the longer the user holds
        const elapsed = Date.now() - pressTimeRef.current
        const t = Math.min(1, elapsed / SHRINK_MS)
        radiusPxRef.current = MAX_CIRCLE_R - t * (MAX_CIRCLE_R - MIN_CIRCLE_R)
        const cx = centerRef.current.x / 100 * cw
        const cy = centerRef.current.y / 100 * ch
        const baseR = radiusPxRef.current
        const noise = 0.10

        // Multi-ring donut: 3 concentric rings proportional to radius
        // Ring counts sum to BURST_COUNT=70; ratios scale with baseR
        const RINGS = [
          { count: 12, ratio: 0.33 },
          { count: 23, ratio: 0.65 },
          { count: 35, ratio: 1.00 },
        ]
        let ringOffset = 0
        const ringForDot: { angle: number; r: number }[] = []
        RINGS.forEach(({ count, ratio }) => {
          for (let j = 0; j < count; j++) {
            ringForDot.push({ angle: (j / count) * Math.PI * 2, r: baseR * ratio })
          }
          ringOffset += count
        })
        void ringOffset

        dotsRef.current = dotsRef.current.map((dot, i) => {
          const { angle, r } = ringForDot[i] ?? { angle: 0, r: baseR }
          const tx = (cx + Math.cos(angle) * r) / cw * 100
          const ty = (cy + Math.sin(angle) * r) / ch * 100
          let { x, y, vx, vy } = dot
          vx += (tx - x) * 0.06 + (Math.random() - 0.5) * noise
          vy += (ty - y) * 0.06 + (Math.random() - 0.5) * noise
          vx *= 0.82; vy *= 0.82
          x += vx; y += vy
          x = Math.max(rx, Math.min(100 - rx, x))
          y = Math.max(ry, Math.min(100 - ry, y))
          return { ...dot, x, y, vx, vy }
        })
        dotsRef.current = resolveCollisions(dotsRef.current, cw, ch, MINI_PX)

      } else if (ph === 'exploding') {
        explodeFrameRef.current++
        dotsRef.current = dotsRef.current.map(dot => {
          let { x, y, vx, vy, friction } = dot
          vx *= friction; vy *= friction
          const spd = Math.sqrt(vx * vx + vy * vy)
          if (spd > 10) { vx = vx / spd * 10; vy = vy / spd * 10 }
          x += vx; y += vy
          if (x < rx)       { x = rx;       vx =  Math.abs(vx) * BOUNCE }
          if (x > 100 - rx) { x = 100 - rx; vx = -Math.abs(vx) * BOUNCE }
          if (y < ry)       { y = ry;       vy =  Math.abs(vy) * BOUNCE }
          if (y > 100 - ry) { y = 100 - ry; vy = -Math.abs(vy) * BOUNCE }
          return { ...dot, x, y, vx, vy }
        })
        dotsRef.current = resolveCollisions(dotsRef.current, cw, ch, MINI_PX)
        if (explodeFrameRef.current >= 60) {
          // Snapshot final positions for static page 3
          handoff.current.ch2LatestDots = dotsRef.current.map(d => ({ id: d.id, color: d.color, x: d.x, y: d.y, vx: d.vx, vy: d.vy }))
          explodeFrameRef.current = 0
          hasCompletedRef.current = true
          phaseRef.current = 'roaming'
          setPhase('roaming')
        }
      }

      tick(n => n + 1)
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      alive = false
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    }
  }, [active])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }, [])

  function getPct(e: React.PointerEvent) {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { x: (e.clientX - rect.left) / rect.width * 100, y: (e.clientY - rect.top) / rect.height * 100 }
  }

  function handlePointerDown(e: React.PointerEvent) {
    const pos = getPct(e)
    if (!pos) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (phaseRef.current !== 'roaming') return
    centerRef.current    = pos
    radiusPxRef.current  = MAX_CIRCLE_R
    pressTimeRef.current = Date.now()
    phaseRef.current     = 'forming'
    setPhase('forming')
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (phaseRef.current !== 'forming') return
    const pos = getPct(e)
    if (pos) centerRef.current = pos
  }

  function handlePointerUp() {
    if (phaseRef.current !== 'forming') return
    // Longer hold = more dramatic explosion
    const holdMs   = Date.now() - pressTimeRef.current
    const holdRatio = Math.min(1, holdMs / SHRINK_MS)  // 0 → 1
    const { cw, ch } = dimsRef.current
    const cx = centerRef.current.x / 100 * cw
    const cy = centerRef.current.y / 100 * ch
    dotsRef.current = dotsRef.current.map(dot => {
      const dx = dot.x / 100 * cw - cx
      const dy = dot.y / 100 * ch - cy
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      // Short hold: 6–14 px/frame  |  Long hold: 38–58 px/frame
      const base  = 6  + holdRatio * 32
      const extra = 8  + holdRatio * 20
      const speed = base + Math.random() * extra
      return {
        ...dot,
        vx: (dx / len) * speed / cw * 100,
        vy: (dy / len) * speed / ch * 100,
      }
    })
    explodeFrameRef.current = 0
    phaseRef.current = 'exploding'
    setPhase('exploding')
  }

  return (
    <>
      <div
        ref={canvasRef}
        style={{ ...canvasStyle, cursor: 'crosshair', touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {dotsRef.current.map(dot => (
          <div key={dot.id} style={{
            position: 'absolute',
            left: `${dot.x}%`, top: `${dot.y}%`,
            width: MINI_PX, height: MINI_PX,
            borderRadius: '50%',
            backgroundColor: dot.color,
            transform: 'translate(-50%,-50%)',
            pointerEvents: 'none',
          }} />
        ))}
      </div>
      <IntroText>Press and hold to make a circle!</IntroText>
      <SetDone done={phase === 'roaming' && hasCompletedRef.current} />
    </>
  )
}

// ─── Ch2 shared: shape builders + generic dot-connection page ────────────────

// Scale/translate unit-space points [-1,1]² to canvas %-coords
// ── Scale SVG vertices (from a 720×720 viewBox) to canvas % coords ────────────
function svgToCanvas(
  pts: [number, number][], cw: number, ch: number, padFrac = 0.12
): { x: number; y: number }[] {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const sw = maxX - minX, sh = maxY - minY
  const pad = Math.min(cw, ch) * padFrac
  const scale = Math.min((cw - pad * 2) / sw, (ch - pad * 2) / sh)
  const ox = (cw - sw * scale) / 2 - minX * scale
  const oy = (ch - sh * scale) / 2 - minY * scale
  return pts.map(([px, py]) => ({ x: (px * scale + ox) / cw * 100, y: (py * scale + oy) / ch * 100 }))
}

// Closed polygon: N edges including wrap-around (N-1)→0
function buildEdges(n: number) {
  return Array.from({ length: n }, (_, i) => [i, (i + 1) % n] as [number, number])
}
// Open polyline: N-1 edges, no wrap-around
function buildEdgesOpen(n: number) {
  return Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number])
}
function isNeighbor(a: number, b: number, n: number, open = false) {
  if (open) return Math.abs(a - b) === 1
  return Math.abs(a - b) === 1 || (Math.min(a, b) === 0 && Math.max(a, b) === n - 1)
}
function edgeKey(a: number, b: number) { return `${Math.min(a, b)}-${Math.max(a, b)}` }

// ── All available shapes (720×720 space) — pool for Ch2 dot-connection pages ──
// Load shape SVGs from src/shapes/*.svg at build time (edit those files to add/change shapes)
const _rawShapeSVGs = import.meta.glob('../shapes/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

function _parseSVGShape(raw: string): ShapeDef {
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml')
  const svg = doc.documentElement
  const poly = svg.querySelector('polyline')!
  const vertices = poly.getAttribute('points')!.trim().split(/\s+/).map(p => {
    const [x, y] = p.split(',').map(Number)
    return [x, y] as [number, number]
  })
  return {
    vertices,
    open:  svg.getAttribute('data-open') === 'true',
    emoji: svg.getAttribute('data-emoji') ?? '',
    label: svg.getAttribute('data-label') ?? '',
  }
}

const SHAPE_DEFS: ShapeDef[] = Object.keys(_rawShapeSVGs).sort().map(k => _parseSVGShape(_rawShapeSVGs[k]))

// Tracks which SHAPE_DEFS indices have been used this browser session
const _usedShapeIndices = new Set<number>()

function pickRandomShapes(n: number): ShapeDef[] {
  // Build pool excluding already-used shapes; reset if not enough remain
  let pool = SHAPE_DEFS.map((s, i) => ({ s, i })).filter(({ i }) => !_usedShapeIndices.has(i))
  if (pool.length < n) {
    _usedShapeIndices.clear()
    pool = SHAPE_DEFS.map((s, i) => ({ s, i }))
  }
  const result: ShapeDef[] = []
  for (let k = 0; k < n; k++) {
    const idx = Math.floor(Math.random() * pool.length)
    const { s, i } = pool.splice(idx, 1)[0]
    result.push(s)
    _usedShapeIndices.add(i)
  }
  return result
}

// ── Shape color palette matching SVG stroke colors ────────────────────────────
const SHAPE_COLORS = {
  red:    '#FF383C',
  orange: '#FF8D28',
  yellow: '#FFCC00',
  green:  '#34C759',
  blue:   '#0088FF',
  indigo: '#6155F5',
  purple: '#CB30E0',
} as const

// Progress palette (rainbow order, one per dot-connection page)
const COLOR_PALETTE: string[] = [
  SHAPE_COLORS.red, SHAPE_COLORS.orange, SHAPE_COLORS.yellow, SHAPE_COLORS.green,
  SHAPE_COLORS.blue, SHAPE_COLORS.indigo, SHAPE_COLORS.purple,
]

// ─── Generic Chapter 2 dot-connection page ───────────────────────────────────
// Compatible with PhysDot so resolveCollisions works directly
type P4Dot = { id: string; color: string; x: number; y: number; vx: number; vy: number; friction: number; vertexIdx?: number; targetX?: number; targetY?: number }
type P4Phase = 'roaming' | 'forming' | 'interactive'
const P4_FRICTION = 0.985, P4_BOUNCE = 0.7, P4_LERP = 0.18, P4_CLOSE_DIST = 0.6

interface DotPageProps {
  shapeColor:    string
  buildVertices: (cw: number, ch: number) => { x: number; y: number }[]
  emoji:         string
  connectLabel:  string
  open?:         boolean   // true for paths that don't close back to vertex 0
}

function Chapter2DotPage({ shapeColor, buildVertices, emoji, connectLabel, open = false }: DotPageProps) {
  const active    = useContext(PageActiveCtx)
  const handoff   = useContext(HandoffCtx)
  const canvasRef = useRef<HTMLDivElement>(null)
  const initedRef = useRef(false)
  const dotsRef   = useRef<P4Dot[]>([])
  const phaseRef  = useRef<P4Phase>('roaming')
  const roamTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [dots,       setDots]       = useState<P4Dot[]>([])
  const [phase,      setPhase]      = useState<P4Phase>('roaming')
  const [pathHead,   setPathHead]   = useState<string | null>(null)
  const [drawnEdges, setDrawnEdges] = useState<Set<string>>(() => new Set())
  const [complete,   setComplete]   = useState(false)
  const drawnEdgesRef = useRef<Set<string>>(new Set())

  // Edges for this shape — stable since buildVertices is a module-level function
  const nVerts     = useMemo(() => buildVertices(100, 100).length, [buildVertices]) // eslint-disable-line
  const shapeEdges = useMemo(() => open ? buildEdgesOpen(nVerts) : buildEdges(nVerts), [nVerts, open]) // eslint-disable-line
  const nEdges     = shapeEdges.length

  // Persist dot positions so the next page picks up from here
  useEffect(() => {
    if (!complete) return
    handoff.current.ch2LatestDots = dotsRef.current.map(d => ({
      id: d.id, color: d.color, x: d.x, y: d.y, vx: d.vx, vy: d.vy,
    }))
  }, [complete]) // eslint-disable-line

  useEffect(() => {
    if (!active || initedRef.current) return
    initedRef.current = true

    const src = handoff.current.ch2LatestDots
    const seed: P4Dot[] = src && src.length === BURST_COUNT
      ? src.map(d => ({
          id: d.id, color: d.color, x: d.x, y: d.y,
          vx: (d.vx ?? 0) * 0.6,
          vy: (d.vy ?? 0) * 0.6,
          friction: P4_FRICTION,
        }))
      : Array.from({ length: BURST_COUNT }, (_, i) => ({
          id: `dp-${i}`, color: BURST_COLORS[i % BURST_COLORS.length],
          x: 10 + Math.random() * 80, y: 10 + Math.random() * 80,
          vx: (Math.random() - 0.5) * 1.2, vy: (Math.random() - 0.5) * 1.2,
          friction: P4_FRICTION,
        }))
    dotsRef.current = seed
    setDots([...seed])

    roamTimer.current = setTimeout(() => {  // short roam before forming
      const rect = canvasRef.current?.getBoundingClientRect()
      const cw = rect?.width  ?? 960
      const ch = rect?.height ?? 520
      const vertices = buildVertices(cw, ch)

      const taken    = new Array(vertices.length).fill(false)
      const isTarget = new Array(BURST_COUNT).fill(false)
      const target: Record<number, number> = {}

      // Pass 1: existing target-color dots → nearest vertex
      dotsRef.current.forEach((d, di) => {
        if (d.color !== shapeColor) return
        let best = -1, bestD = Infinity
        vertices.forEach((v, vi) => {
          if (taken[vi]) return
          const d2 = (d.x - v.x) ** 2 + (d.y - v.y) ** 2
          if (d2 < bestD) { bestD = d2; best = vi }
        })
        if (best >= 0) { taken[best] = true; target[di] = best; isTarget[di] = true }
      })

      // Pass 2: remaining vertices → nearest non-target dot (recolored to shapeColor)
      vertices.forEach((v, vi) => {
        if (taken[vi]) return
        let best = -1, bestD = Infinity
        dotsRef.current.forEach((d, di) => {
          if (isTarget[di]) return
          const d2 = (d.x - v.x) ** 2 + (d.y - v.y) ** 2
          if (d2 < bestD) { bestD = d2; best = di }
        })
        if (best >= 0) { taken[vi] = true; target[best] = vi; isTarget[best] = true }
      })

      // Non-shape dots use palette indicator colors — every color except the current shapeColor
      const nonShapePalette = COLOR_PALETTE.filter(c => c !== shapeColor)
      dotsRef.current = dotsRef.current.map((d, di) => {
        if (target[di] !== undefined) {
          const v = vertices[target[di]]
          return { ...d, color: shapeColor, vertexIdx: target[di], targetX: v.x, targetY: v.y }
        }
        // Assign a stable random rainbow color (excluding the shape color)
        const randColor = nonShapePalette[Math.floor(Math.random() * nonShapePalette.length)]
        const spd = Math.sqrt(d.vx * d.vx + d.vy * d.vy)
        if (spd < 0.25) {
          const ang = Math.random() * Math.PI * 2
          return { ...d, color: randColor, vx: Math.cos(ang) * 0.5, vy: Math.sin(ang) * 0.5 }
        }
        return { ...d, color: randColor }
      })

      phaseRef.current = 'forming'
      setPhase('forming')
    }, 300)

    let alive = true, rafId = 0
    function tick() {
      if (!alive) return
      const canvas = canvasRef.current
      const cw = canvas?.clientWidth  ?? 960
      const ch = canvas?.clientHeight ?? 520
      const rx = MINI_PX / 2 / cw * 100
      const ry = MINI_PX / 2 / ch * 100
      const ph = phaseRef.current

      if (ph === 'roaming' || ph === 'forming') {
        dotsRef.current = dotsRef.current.map(d => {
          const isShape = d.vertexIdx !== undefined
          let { x, y, vx, vy, friction } = d

          if (ph === 'forming' && isShape && d.targetX !== undefined && d.targetY !== undefined) {
            vx += (d.targetX - x) * P4_LERP
            vy += (d.targetY - y) * P4_LERP
          }
          if (ph === 'forming' && !isShape) {
            vx += (Math.random() - 0.5) * 0.12
            vy += (Math.random() - 0.5) * 0.12
            const spd = Math.sqrt(vx * vx + vy * vy)
            if (spd > 0.9) { vx = vx / spd * 0.9; vy = vy / spd * 0.9 }
          }

          vx *= friction; vy *= friction; x += vx; y += vy
          if (x < rx)        { x = rx;        vx =  Math.abs(vx) * P4_BOUNCE }
          if (x > 100 - rx)  { x = 100 - rx;  vx = -Math.abs(vx) * P4_BOUNCE }
          if (y < ry)        { y = ry;         vy =  Math.abs(vy) * P4_BOUNCE }
          if (y > 100 - ry)  { y = 100 - ry;  vy = -Math.abs(vy) * P4_BOUNCE }
          return { ...d, x, y, vx, vy }
        })

        dotsRef.current = resolveCollisions(dotsRef.current as PhysDot[], cw, ch, MINI_PX) as P4Dot[]

        if (ph === 'forming') {
          const allClose = dotsRef.current.every(d => {
            if (d.vertexIdx === undefined || d.targetX === undefined || d.targetY === undefined) return true
            const dx = d.x - d.targetX, dy = d.y - d.targetY
            return Math.sqrt(dx * dx + dy * dy) < P4_CLOSE_DIST
          })
          if (allClose) {
            dotsRef.current = dotsRef.current.map(d =>
              d.targetX !== undefined ? { ...d, x: d.targetX, y: d.targetY!, vx: 0, vy: 0 } : d
            )
            phaseRef.current = 'interactive'
            setPhase('interactive')
          }
        }
        setDots([...dotsRef.current])

      } else if (ph === 'interactive') {
        dotsRef.current = dotsRef.current.map(d => {
          if (d.vertexIdx !== undefined) return { ...d, vx: 0, vy: 0 }
          let { x, y, vx, vy, friction } = d
          vx *= friction; vy *= friction; x += vx; y += vy
          if (x < rx)        { x = rx;        vx =  Math.abs(vx) * P4_BOUNCE }
          if (x > 100 - rx)  { x = 100 - rx;  vx = -Math.abs(vx) * P4_BOUNCE }
          if (y < ry)        { y = ry;         vy =  Math.abs(vy) * P4_BOUNCE }
          if (y > 100 - ry)  { y = 100 - ry;  vy = -Math.abs(vy) * P4_BOUNCE }
          return { ...d, x, y, vx, vy }
        })
        const nonShape  = dotsRef.current.filter(d => d.vertexIdx === undefined) as PhysDot[]
        const resolved  = resolveCollisions(nonShape, cw, ch, MINI_PX)
        const resolvedMap = new Map(resolved.map(d => [d.id, d]))
        dotsRef.current = dotsRef.current.map(d =>
          d.vertexIdx === undefined ? { ...d, ...(resolvedMap.get(d.id) ?? {}) } as P4Dot : d
        )
        setDots([...dotsRef.current])
      }

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      alive = false
      cancelAnimationFrame(rafId)
      if (roamTimer.current) clearTimeout(roamTimer.current)
      initedRef.current = false
      phaseRef.current  = 'roaming'
      dotsRef.current   = []
      drawnEdgesRef.current = new Set()
      setDots([]); setPhase('roaming'); setPathHead(null)
      setDrawnEdges(new Set()); setComplete(false)
    }
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select the start vertex when the page becomes interactive
  useEffect(() => {
    if (phase !== 'interactive') return
    const startDot = dotsRef.current.find(d => d.vertexIdx === 0)
    if (startDot) setPathHead(startDot.id)
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleDotClick(dot: P4Dot) {
    if (phase !== 'interactive' || complete || dot.vertexIdx === undefined) return
    const dotVtx = dot.vertexIdx

    if (pathHead === null)     { setPathHead(dot.id); return }
    if (pathHead === dot.id)   { return }  // clicking current dot does nothing

    const headDot = dotsRef.current.find(d => d.id === pathHead)
    if (!headDot || headDot.vertexIdx === undefined) { setPathHead(dot.id); return }

    const a = headDot.vertexIdx, b = dotVtx
    const key = edgeKey(a, b)
    if (isNeighbor(a, b, nVerts, open) && !drawnEdges.has(key)) {
      const next = new Set(drawnEdges)
      next.add(key)
      drawnEdgesRef.current = next
      setDrawnEdges(next)
      setPathHead(dot.id)
      if (next.size === nEdges) setComplete(true)
    }
  }

  const paletteIdx  = COLOR_PALETTE.indexOf(shapeColor)
  const headDot     = pathHead ? (dots.find(d => d.id === pathHead) ?? null) : null
  const headVtx     = headDot?.vertexIdx
  let connArr: number[] = headVtx !== undefined
    ? shapeEdges
        .filter(([a, b]: [number,number]) =>
          (a === headVtx || b === headVtx) &&
          !drawnEdges.has(edgeKey(a, b)) &&
          isNeighbor(a, b, nVerts, open)
        )
        .map(([a, b]: [number,number]) => a === headVtx ? b : a)
    : []
  // Enforce single forward direction: if both directions are open (only at start of closed shape),
  // keep only the forward vertex (headVtx+1) % nVerts
  if (connArr.length > 1 && headVtx !== undefined) {
    const forward = (headVtx + 1) % nVerts
    const fwd = connArr.filter(v => v === forward)
    if (fwd.length > 0) connArr = fwd
  }
  const connectable = new Set(connArr)

  return (
    <>
      <div ref={canvasRef} style={canvasStyle}>

        {/* ── Rainbow color progress indicator ── */}
        <div style={{
          position: 'absolute', top: 12, right: 12,
          display: 'flex', gap: 7, alignItems: 'center',
          zIndex: 20, pointerEvents: 'none',
          background: 'rgba(30,30,40,0.82)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          borderRadius: 28,
          padding: '7px 12px',
          boxShadow: '0 2px 10px rgba(0,0,0,0.28)',
        }}>
          {COLOR_PALETTE.map((c, i) => {
            const isCurrent = i === paletteIdx
            const isPast    = i < paletteIdx
            return (
              <div key={c} style={{
                width:  isCurrent ? 22 : 13,
                height: isCurrent ? 22 : 13,
                borderRadius: '50%',
                background: c,
                opacity: isPast ? 0.55 : isCurrent ? 1 : 0.30,
                boxShadow: isCurrent ? `0 0 0 2px #fff, 0 0 0 4px ${c}` : 'none',
                transition: 'all 0.3s ease',
                flexShrink: 0,
              }} />
            )
          })}
        </div>

        <svg
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 5 }}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {shapeEdges.filter(([a, b]: [number,number]) => drawnEdges.has(edgeKey(a, b))).map(([a, b]: [number,number]) => {
            const da = dots.find(d => d.vertexIdx === a)
            const db = dots.find(d => d.vertexIdx === b)
            if (!da || !db) return null
            return (
              <line
                key={edgeKey(a, b)}
                x1={da.x} y1={da.y} x2={db.x} y2={db.y}
                stroke={shapeColor}
                strokeWidth={complete ? '1.6' : '0.55'}
                strokeLinecap="round"
                style={{ transition: 'stroke-width 0.4s ease' }}
              />
            )
          })}
        </svg>

        {dots.map(dot => {
          const isShape   = dot.vertexIdx !== undefined
          const isHead    = dot.id === pathHead
          const isConn    = isShape && !isHead && connectable.has(dot.vertexIdx!)
          const opacity   = complete && !isShape ? 0.08 : 1
          const clickable = isShape && phase === 'interactive' && !complete
          return (
            <div
              key={dot.id}
              onClick={() => handleDotClick(dot)}
              style={{
                position: 'absolute',
                left: `${dot.x}%`, top: `${dot.y}%`,
                transform: 'translate(-50%,-50%)',
                width: MINI_PX, height: MINI_PX, borderRadius: '50%',
                background: dot.color,
                opacity,
                zIndex: isShape ? 10 : 1,
                cursor: clickable ? 'pointer' : 'default',
                pointerEvents: clickable ? 'auto' : 'none',
                boxShadow: isHead
                  ? `0 0 0 4px #fff, 0 0 0 6px ${shapeColor}`
                  : isConn
                  ? `0 0 0 3px #fff, 0 0 10px 4px ${shapeColor}cc`
                  : complete && isShape
                  ? `0 0 8px 2px ${shapeColor}88`
                  : 'none',
                transition: 'opacity 0.6s ease, box-shadow 0.25s ease',
              }}
            />
          )
        })}

      </div>
      <IntroText>{connectLabel}</IntroText>
      <SetDone done={complete} />
    </>
  )
}

// ── Per-slot wrapper components: read shape from context by slot index ────────
// Must be module-level (stable identity) so React doesn't unmount/remount on re-render.
function makeCh2DotPage(slotIdx: number): React.FC {
  return function Ch2DotSlot() {
    const shapes = useContext(Ch2ShapesCtx)
    const shape  = shapes[slotIdx]
    if (!shape) return null
    return (
      <Chapter2DotPage
        shapeColor={COLOR_PALETTE[slotIdx]}
        buildVertices={(cw, ch) => svgToCanvas(shape.vertices, cw, ch)}
        emoji={shape.emoji}
        connectLabel={shape.label}
        open={shape.open}
      />
    )
  }
}
const Ch2DotSlots = Array.from({ length: 7 }, (_, i) => makeCh2DotPage(i))

// ─── Shared Ch3 replay button ────────────────────────────────────────────────
function Ch3ReplayBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick() }}
      title="Restart"
      style={{
        position: 'absolute', top: 12, left: 12, zIndex: 4,
        width: 34, height: 34, borderRadius: '50%',
        border: '1.5px solid #d0ccc5', background: '#fff',
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
      }}
    >
      <RotateCcw size={15} strokeWidth={2.2} color="#888" />
    </button>
  )
}

// ─── Chapter 3 Page 1 — Dot Runner ───────────────────────────────────────────

/** Squared distance from point (px,py) to segment (ax,ay)→(bx,by). */
function ptSegSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return (px - ax) ** 2 + (py - ay) ** 2
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2
}

type RunObs = { id: number; xPct: number; wPx: number; hPx: number; passed?: boolean }

const CH3_DOT_PX   = 44
const CH3_GROUND   = 78      // % from top of canvas
const CH3_JUMP_V   = 2.2     // %/frame initial upward velocity — arc ~28% of canvas height
const CH3_GRAV     = 0.085   // %/frame² gravity (gentle)
const CH3_SPD0     = 0.40    // %/frame initial obstacle speed
const CH3_ACCEL    = 0.00005
const CH3_MAX_SPD  = 0.90
const CH3_WIN      = 1       // mountains to jump — level 1
const CH3_WIN2     = 10      // mountains to jump — level 2
const CH3_WIN3     = 15      // mountains to jump — level 3 (hard)
const CH3_PX       = 50      // player x position (% from left — horizontal centre)
const CH3_OBS_W    = 60      // all obstacles same width px
const CH3_OBS_H    = 80      // all obstacles same height px

function Ch3Page1({ winTarget = CH3_WIN, variant = 'normal' }: { winTarget?: number; variant?: 'normal' | 'hard' } = {}) {
  const active     = useContext(PageActiveCtx)
  const outerRef   = useRef<HTMLDivElement>(null)
  const [outerDims, setOuterDims] = useState({ w: 0, h: 0 })
  const canvasRef  = useRef<HTMLDivElement>(null)
  const dimsRef    = useRef({ cw: 960, ch: 520 })
  const rafRef     = useRef<number | null>(null)
  const lastTRef   = useRef(0)               // timestamp of previous RAF frame
  const [, tick]   = useState(0)

  const yRef        = useRef(CH3_GROUND)   // player BOTTOM edge y in % (starts on ground)
  const vyRef       = useRef(0)            // velocity %/frame (positive = down)
  const obsRef      = useRef<RunObs[]>([])
  const spdRef      = useRef(CH3_SPD0)
  const distRef     = useRef(0)
  const runRef      = useRef(false)
  const deadRef     = useRef(false)
  const wonRef      = useRef(false)
  const nextSpRef   = useRef(150)          // dist units until first spawn
  const obsIdRef    = useRef(0)
  const jumpedRef   = useRef(0)            // mountains confirmed landed-after (on ground)
  const pendingRef  = useRef(0)            // mountains passed mid-air, not yet confirmed

  useLayoutEffect(() => {
    // Sun spin keyframe
    const s = document.createElement('style')
    s.textContent = '@keyframes ch3SunSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}'
    document.head.appendChild(s)
    return () => { document.head.removeChild(s) }
  }, [])

  useLayoutEffect(() => {
    const el = outerRef.current; if (!el) return
    const ro = new ResizeObserver(entries => {
      const { width: w, height: h } = entries[0].contentRect
      if (w > 0 && h > 0) setOuterDims({ w, h })
    })
    ro.observe(el); return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const el = canvasRef.current; if (!el) return
    const ro = new ResizeObserver(entries => {
      const { width: cw, height: ch } = entries[0].contentRect
      if (cw > 0 && ch > 0) dimsRef.current = { cw, ch }
    })
    ro.observe(el); return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!active) {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
      return
    }
    lastTRef.current = performance.now()
    let alive = true
    const step = (now: number) => {
      if (!alive) return
      // Delta-time: normalise to 60 fps so physics is frame-rate independent
      const dt     = Math.min(now - lastTRef.current, 50)   // cap at 50 ms (tab focus-loss)
      lastTRef.current = now
      const frames = dt * 60 / 1000                         // 1.0 at 60 fps, 0.5 at 120 fps

      if (runRef.current && !wonRef.current && !deadRef.current) {
        const { cw, ch } = dimsRef.current
        const gndPx = CH3_GROUND / 100 * ch

        // Gravity
        vyRef.current = Math.min(vyRef.current + CH3_GRAV * frames, 5)
        yRef.current += vyRef.current * frames
        if (yRef.current >= CH3_GROUND) {
          yRef.current = CH3_GROUND; vyRef.current = 0
          // Flush mountains passed mid-air as confirmed jumps on landing
          if (pendingRef.current > 0) {
            jumpedRef.current += pendingRef.current
            pendingRef.current = 0
          }
        }

        // Accelerate + distance (hard mode: gently faster accel)
        spdRef.current  = Math.min(spdRef.current + (variant === 'hard' ? CH3_ACCEL * 1.4 : CH3_ACCEL) * frames, CH3_MAX_SPD)
        distRef.current += spdRef.current * frames

        // Move obstacles; o.xPct is the CENTRE x (SVG uses translate(-50%,-100%))
        for (const o of obsRef.current) {
          o.xPct -= spdRef.current * frames
          // Mountain passed dot centre — stage it as pending until dot lands
          if (!o.passed && o.xPct < CH3_PX) {
            o.passed = true
            pendingRef.current++
          }
        }
        // Despawn when visual right edge (centre + halfW) scrolls off the left
        obsRef.current = obsRef.current.filter(o => o.xPct + o.wPx / cw * 50 > -2)

        // Spawn (hard mode: gap shrinks as more mountains are jumped)
        if (distRef.current >= nextSpRef.current) {
          // Scale obstacle to canvas so mountains are always jumpable (jump arc ≈ 28% of ch)
          const obsH = Math.round(ch * 0.13)
          const obsW = Math.round(obsH * (CH3_OBS_W / CH3_OBS_H))
          obsRef.current.push({
            id: ++obsIdRef.current, xPct: 102, wPx: obsW, hPx: obsH,
          })
          if (variant === 'hard') {
            // Base gap shrinks as mountains are cleared; ±30 random jitter stays constant
            const baseGap = Math.max(50, 110 - jumpedRef.current * 6)
            nextSpRef.current = distRef.current + baseGap + Math.random() * 30
          } else {
            nextSpRef.current = distRef.current + 110 + Math.random() * 160
          }
        }

        // Circle vs. mountain-sides collision (accurate triangle hitbox)
        // o.xPct is the centre x of the mountain (matches the SVG translate(-50%,-100%))
        const dotX = CH3_PX / 100 * cw
        const dotY = yRef.current / 100 * ch - CH3_DOT_PX / 2  // dot centre Y in px
        const r2   = (CH3_DOT_PX / 2 - 1) ** 2                 // tight circle radius²
        for (const o of obsRef.current) {
          const cx    = o.xPct / 100 * cw   // mountain centre X in px
          const halfW = o.wPx / 2
          const peakY = gndPx - o.hPx
          // Left slope:  (cx-halfW, gndPx) → (cx, peakY)
          // Right slope: (cx, peakY)        → (cx+halfW, gndPx)
          if (
            ptSegSq(dotX, dotY, cx - halfW, gndPx, cx,         peakY) < r2 ||
            ptSegSq(dotX, dotY, cx,         peakY, cx + halfW, gndPx) < r2
          ) {
            deadRef.current = true; runRef.current = false; break
          }
        }

        if (jumpedRef.current >= winTarget) {
          wonRef.current = true; runRef.current = false
        }
      }

      tick(n => n + 1)
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => { alive = false; if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null } }
  }, [active])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); handleAction() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])  // eslint-disable-line react-hooks/exhaustive-deps

  function handleAction() {
    if (wonRef.current) return
    if (deadRef.current) { handleRestart(); return }
    runRef.current = true
    if (yRef.current >= CH3_GROUND - 0.3) vyRef.current = -CH3_JUMP_V
  }

  function handleRestart() {
    yRef.current = CH3_GROUND; vyRef.current = 0
    obsRef.current = []; spdRef.current = variant === 'hard' ? CH3_SPD0 * 1.05 : CH3_SPD0
    distRef.current = 0; nextSpRef.current = 150; jumpedRef.current = 0; pendingRef.current = 0
    deadRef.current = false; wonRef.current = false; runRef.current = false
    tick(n => n + 1)
  }

  const won  = wonRef.current
  const dead = deadRef.current
  const run  = runRef.current

  const portrait = outerDims.h > outerDims.w && outerDims.w > 0

  return (
    <>
      <div
        ref={outerRef}
        style={{ ...canvasStyle, position: 'relative', overflow: 'hidden' }}
      >
      <div
        ref={canvasRef}
        onClick={won ? undefined : handleAction}
        style={{
          position: 'absolute',
          ...(portrait ? {
            width: outerDims.h, height: outerDims.w,
            left: (outerDims.w - outerDims.h) / 2,
            top: (outerDims.h - outerDims.w) / 2,
            transform: 'rotate(90deg)', transformOrigin: 'center',
          } : { inset: 0 }),
          background: '#fff', overflow: 'hidden',
          cursor: won ? 'default' : 'pointer',
        }}
      >

        {/* Sun — fixed in sky, slowly spinning */}
        <img
          src={import.meta.env.BASE_URL + 'sun.svg'}
          draggable={false}
          style={{
            position: 'absolute', right: '11%', top: '8%',
            width: 86, height: 86, pointerEvents: 'none',
            animation: run ? 'ch3SunSpin 20s linear infinite' : 'none',
          }}
        />

        {/* Ground line */}
        <div style={{
          position: 'absolute', top: `${CH3_GROUND}%`,
          left: 0, right: 0, height: 1.5, background: '#1a1a1a', pointerEvents: 'none',
        }} />

        {/* Player dot — bottom edge sits on ground (transform -100% aligns bottom to top%) */}
        <div style={{
          position: 'absolute',
          left: `${CH3_PX}%`, top: `${yRef.current}%`,
          width: CH3_DOT_PX, height: CH3_DOT_PX, borderRadius: '50%',
          background: RED, transform: 'translate(-50%, -100%)',
          pointerEvents: 'none',
        }} />

        {/* Obstacles — pointed mountain; white rect breaks the ground line beneath */}
        {obsRef.current.map(o => (
          <svg
            key={o.id}
            style={{
              position: 'absolute',
              left: `${o.xPct}%`, top: `${CH3_GROUND}%`,
              transform: 'translate(-50%, -100%)',
              overflow: 'visible', pointerEvents: 'none',
            }}
            width={o.wPx} height={o.hPx}
            viewBox={`0 0 ${o.wPx} ${o.hPx}`}
          >
            {/* Erase ground line under mountain base */}
            <rect x={0} y={o.hPx - 1} width={o.wPx} height={3} fill="white" />
            <polyline
              points={`0,${o.hPx} ${o.wPx / 2},0 ${o.wPx},${o.hPx}`}
              fill="none" stroke="#1a1a1a" strokeWidth="2" strokeLinejoin="miter"
            />
          </svg>
        ))}

        {/* Progress */}
        {(run || won) && (
          <div style={{
            position: 'absolute', top: 14, right: 18,
            fontSize: 14, fontWeight: 800, color: '#bbb',
            fontFamily: 'inherit', letterSpacing: 0.5,
          }}>
            {jumpedRef.current} / {winTarget}
          </div>
        )}

        {/* Start hint */}
        {!run && !dead && !won && (
          <div style={{
            position: 'absolute', left: '50%', top: '38%',
            transform: 'translate(-50%, -50%)',
            fontSize: 17, fontWeight: 700, color: RED,
            fontFamily: 'inherit', pointerEvents: 'none',
          }}>
            Press or tap to start!
          </div>
        )}

        {/* Dead overlay */}
        {dead && (
          <div style={{
            position: 'absolute', left: '50%', top: '38%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center', pointerEvents: 'none',
          }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: RED, fontFamily: 'inherit' }}>Oops! 😵</div>
            <div style={{ fontSize: 14, color: RED, opacity: 0.7, marginTop: 8, fontFamily: 'inherit' }}>Tap to try again</div>
          </div>
        )}

        {/* Win overlay */}
        {won && (
          <div style={{
            position: 'absolute', left: '50%', top: '38%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center', pointerEvents: 'none',
          }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: RED, fontFamily: 'inherit' }}>You made it! 🎉</div>
            <button
              onClick={e => { e.stopPropagation(); handleRestart() }}
              style={{
                pointerEvents: 'auto', marginTop: 12, fontSize: 14, cursor: 'pointer',
                background: 'none', border: `1.5px solid ${RED}55`, color: RED,
                fontFamily: 'inherit', padding: '4px 18px', borderRadius: 20,
              }}
            >↺ Play again</button>
          </div>
        )}
      </div>
      </div>
      <IntroText>Jump over the obstacles!</IntroText>
      <SetDone done={wonRef.current} />
    </>
  )
}

// ─── Chapter 3 Page 2: Dot Descent ───────────────────────────────────────────
type C3P2Cloud = { x: number; w: number; ppSpeed?: number; ppMin?: number; ppMax?: number; ppDir?: number }
type C3P2Floor = { id: number; worldY: number; clouds: C3P2Cloud[] }

const C3P2_R          = 22       // player radius px
const C3P2_GRAV       = 0.40     // gravity px/frame²
const C3P2_MAX_VY     = 14       // max fall speed
const C3P2_SPD        = 6.0      // horizontal speed px/frame
const C3P2_FLOOR_H    = 10       // platform height px (thin pill)
const C3P2_SPACING    = 150      // world px between floor rows
const C3P2_WIN        = 5        // levels to descend — level 1
const C3P2_WIN2       = 20       // levels to descend — level 2
const C3P2_WIN3       = 30       // levels to descend — level 3 (hard)
const C3P2_CTR_SHIFT  = 140      // max platform-centre shift between consecutive rows
const C3P2_SCROLL     = 0.60     // world px/frame the camera drifts upward (uniform)
const C3P2_GAP_W      = 90       // gap between clouds when 2 per row (px)
const C3P2_PP_SPEED   = 0.7      // uniform ping-pong speed for all moving clouds
let _c3p2Fid = 0

/** Generate a row of 1–2 platforms whose centre tracks prevGroupCx. */
function makeC3P2Floor(worldY: number, cw: number, prevGroupCx?: number, hard = false, ch = 0): C3P2Floor {
  const numClouds  = Math.random() < 0.45 ? 1 : 2
  // On narrow portrait canvases (cw < ch) make clouds wider so the game stays playable
  const narrow     = ch > 0 && cw < ch
  const minCW      = Math.floor(cw * (narrow ? 0.28 : 0.16))
  const maxCW      = Math.floor(cw * (narrow ? 0.50 : 0.34))
  const widths     = Array.from({ length: numClouds }, () =>
    minCW + Math.floor(Math.random() * (maxCW - minCW))
  )
  const gapBetween = numClouds > 1 ? ((narrow ? 30 : C3P2_GAP_W) + Math.random() * (narrow ? 20 : 60)) : 0
  const groupW     = widths.reduce((s, w) => s + w, 0) + gapBetween * (numClouds - 1)

  // Constrain group centre so consecutive rows stay reachable
  const minGroupCx = groupW / 2 + 12
  const maxGroupCx = cw - groupW / 2 - 12
  let groupCx: number
  if (prevGroupCx !== undefined) {
    const shift = (Math.random() - 0.5) * 2 * C3P2_CTR_SHIFT
    groupCx = Math.max(minGroupCx, Math.min(maxGroupCx, prevGroupCx + shift))
  } else {
    groupCx = minGroupCx + Math.random() * (maxGroupCx - minGroupCx)
  }

  const clouds: C3P2Cloud[] = []
  // In hard mode: at most ONE cloud per row oscillates, chosen randomly
  const ppIdx = (hard && Math.random() < 0.4) ? Math.floor(Math.random() * numClouds) : -1
  let x = groupCx - groupW / 2
  for (let i = 0; i < numClouds; i++) {
    const cloud: C3P2Cloud = { x, w: widths[i] }
    if (i === ppIdx) {
      // Ping-pong: uniform speed, random amplitude and direction
      const amp     = 30 + Math.random() * 50
      cloud.ppSpeed = C3P2_PP_SPEED
      cloud.ppMin   = Math.max(0, x - amp)
      cloud.ppMax   = Math.min(cw - widths[i], x + amp)
      cloud.ppDir   = Math.random() < 0.5 ? 1 : -1
    }
    clouds.push(cloud)
    x += widths[i] + gapBetween
  }
  return { id: ++_c3p2Fid, worldY, clouds }
}

/** Centre X of a floor's cloud group (used to constrain the next floor). */
function floorGroupCx(floor: C3P2Floor): number {
  const left  = floor.clouds[0].x
  const last  = floor.clouds[floor.clouds.length - 1]
  return (left + last.x + last.w) / 2
}

/** True if player centre X sits on any cloud in this floor. */
function onAnyCloud(px: number, floor: C3P2Floor): boolean {
  return floor.clouds.some(c => px >= c.x && px <= c.x + c.w)
}

function Ch3Page2({ winTarget = C3P2_WIN, variant = 'normal' }: { winTarget?: number; variant?: 'normal' | 'hard' } = {}) {
  const active    = useContext(PageActiveCtx)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dimsRef   = useRef({ cw: 960, ch: 520 })
  const rafRef    = useRef<number | null>(null)
  const lastTRef  = useRef(0)
  const [, tick]  = useState(0)

  // Player (world coords)
  const pxRef         = useRef(480)
  const pyRef         = useRef(0)
  const vyRef         = useRef(0)
  // Floors
  const floorsRef     = useRef<C3P2Floor[]>([])
  const onFloorRef    = useRef(-1)    // index of floor player stands on, -1 = airborne
  const collStartRef  = useRef(0)     // first floor index to check for landing
  const clearIdxRef   = useRef(0)     // next floor index to advance for clearing count
  const clearedRef    = useRef(0)
  // Camera (world Y of top of screen; increases → things rise on screen)
  const camYRef       = useRef(0)
  // State
  const deadRef       = useRef(false)
  const wonRef        = useRef(false)
  const leftRef       = useRef(false)
  const rightRef      = useRef(false)
  const startedRef    = useRef(false)      // true once player has tapped to start
  const lastLandedRef = useRef(-1)         // highest floor index landed on so far

  function initGame(cw: number, ch: number) {
    // Ball starts at screen centre, falling down onto first platform
    // Camera: world 0 maps to screen centre → camY = -(ch/2)
    camYRef.current       = -(ch * 0.5)
    pxRef.current         = cw / 2
    pyRef.current         = 0          // world Y 0 → screen Y ch/2 (centre)
    vyRef.current         = 0
    onFloorRef.current    = -1         // falling from centre
    collStartRef.current  = 0
    clearIdxRef.current   = 0
    clearedRef.current    = 0
    deadRef.current       = false
    wonRef.current        = false
    leftRef.current       = false
    rightRef.current      = false
    startedRef.current    = false
    lastLandedRef.current = -1
    floorsRef.current     = []
    // First platform: worldY = ch*0.18 → screen Y = ch*0.18 + ch*0.5 = 68% (below centre)
    const firstWY = ch * 0.18
    const cloudW0 = Math.floor(cw * 0.48)
    floorsRef.current.push({
      id: ++_c3p2Fid, worldY: firstWY,
      clouds: [{ x: Math.floor(cw / 2 - cloudW0 / 2), w: cloudW0 }],
    })
    let prevGroupCx = cw / 2
    for (let i = 1; i < 35; i++) {
      const f    = makeC3P2Floor(firstWY + i * C3P2_SPACING, cw, prevGroupCx, variant === 'hard', ch)
      prevGroupCx = floorGroupCx(f)
      floorsRef.current.push(f)
    }
  }

  useLayoutEffect(() => {
    const el = canvasRef.current; if (!el) return
    const ro = new ResizeObserver(entries => {
      const { width: cw, height: ch } = entries[0].contentRect
      if (cw > 0 && ch > 0) {
        dimsRef.current = { cw, ch }
        // Re-init platforms with correct canvas size if game hasn't started yet
        if (!startedRef.current && !wonRef.current) {
          initGame(cw, ch)
          tick(n => n + 1)
        }
      }
    })
    ro.observe(el); return () => ro.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
      leftRef.current = false; rightRef.current = false
      return
    }
    const { cw, ch } = dimsRef.current
    initGame(cw, ch)
    lastTRef.current = performance.now()
    let alive = true
    const step = (now: number) => {
      if (!alive) return
      const { cw, ch } = dimsRef.current
      // Delta-time normalised to 60 fps
      const dt     = Math.min(now - lastTRef.current, 50)
      lastTRef.current = now
      const frames = dt * 60 / 1000

      if (!wonRef.current && !deadRef.current && startedRef.current) {
        // ── 0. Ping-pong cloud update (hard mode) ────────────────────────────
        // Each moving cloud has its own direction; it reverses on wall hit OR
        // when it touches a neighbouring static cloud (which acts as a second wall).
        if (variant === 'hard') {
          for (const floor of floorsRef.current) {
            const isStandingHere = onFloorRef.current >= 0 && floorsRef.current[onFloorRef.current] === floor
            for (let ci = 0; ci < floor.clouds.length; ci++) {
              const c = floor.clouds[ci]
              if (c.ppSpeed === undefined) continue

              const prevX = c.x
              c.x += c.ppSpeed * c.ppDir! * frames

              // Wall bounce
              if (c.x <= c.ppMin!) { c.x = c.ppMin!; c.ppDir = 1 }
              if (c.x >= c.ppMax!) { c.x = c.ppMax!; c.ppDir = -1 }

              // Bounce off a static left-neighbour
              if (ci > 0) {
                const nb = floor.clouds[ci - 1]
                if (nb.ppSpeed === undefined && c.x < nb.x + nb.w) {
                  c.x = nb.x + nb.w; c.ppDir = 1
                }
              }
              // Bounce off a static right-neighbour
              if (ci < floor.clouds.length - 1) {
                const nb = floor.clouds[ci + 1]
                if (nb.ppSpeed === undefined && c.x + c.w > nb.x) {
                  c.x = nb.x - c.w; c.ppDir = -1
                }
              }

              const cloudDx = c.x - prevX
              if (isStandingHere && pxRef.current >= prevX && pxRef.current <= prevX + c.w) {
                pxRef.current = Math.max(C3P2_R, Math.min(cw - C3P2_R, pxRef.current + cloudDx))
              }
            }
          }
        }

        // ── 1. Horizontal movement ───────────────────────────────────────────
        const dx = (leftRef.current ? -1 : 0) + (rightRef.current ? 1 : 0)
        pxRef.current = Math.max(C3P2_R, Math.min(cw - C3P2_R, pxRef.current + dx * C3P2_SPD * frames))

        // ── 2. On-floor: did player walk off every cloud? ───────────────────
        if (onFloorRef.current >= 0) {
          const floor = floorsRef.current[onFloorRef.current]
          if (!floor || !onAnyCloud(pxRef.current, floor)) {
            onFloorRef.current = -1   // become airborne
          }
        }

        // ── 3. Airborne: gravity + floor landing ─────────────────────────────
        if (onFloorRef.current < 0) {
          vyRef.current = Math.min(vyRef.current + C3P2_GRAV * frames, C3P2_MAX_VY)
          const prevY      = pyRef.current
          pyRef.current   += vyRef.current * frames

          if (vyRef.current > 0) {
            const prevBottom = prevY + C3P2_R
            const newBottom  = pyRef.current + C3P2_R
            for (let i = collStartRef.current; i < floorsRef.current.length; i++) {
              const floor = floorsRef.current[i]
              if (floor.worldY > newBottom) break
              if (prevBottom <= floor.worldY && onAnyCloud(pxRef.current, floor)) {
                pyRef.current         = floor.worldY - C3P2_R
                vyRef.current         = 0
                onFloorRef.current    = i
                collStartRef.current  = i + 1
                // Count each new (lower) floor landing as one level cleared
                if (i > lastLandedRef.current) {
                  lastLandedRef.current = i
                  clearedRef.current++
                  if (clearedRef.current >= winTarget) wonRef.current = true
                }
                break
              }
            }
          }
        }

        // ── 5. Scroll camera upward (hard mode: speed increases with progress) ─
        const scrollSpd = variant === 'hard' ? Math.min(C3P2_SCROLL + clearedRef.current * 0.015, 1.4) : C3P2_SCROLL
        camYRef.current += scrollSpd * frames

        // ── 6. Death: ball fell below bottom of screen ───────────────────────
        if (pyRef.current - C3P2_R > camYRef.current + ch) {
          deadRef.current = true
        }
        // Death: ball pushed above top of screen
        if (pyRef.current + C3P2_R < camYRef.current) {
          deadRef.current = true
        }

        // ── 7. Extend floor pool ahead of camera ─────────────────────────────
        const last = floorsRef.current[floorsRef.current.length - 1]
        if (last && last.worldY < camYRef.current + ch * 2.2) {
          floorsRef.current.push(makeC3P2Floor(last.worldY + C3P2_SPACING, cw, floorGroupCx(last), variant === 'hard', ch))
        }
      }

      tick(n => n + 1)
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => { alive = false; if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null } }
  }, [active])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return
    const onDown = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft')  { e.preventDefault(); startedRef.current = true; leftRef.current  = true }
      if (e.code === 'ArrowRight') { e.preventDefault(); startedRef.current = true; rightRef.current = true }
      if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); startedRef.current = true }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft')  leftRef.current  = false
      if (e.code === 'ArrowRight') rightRef.current = false
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup',   onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
  }, [active])  // eslint-disable-line react-hooks/exhaustive-deps

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (deadRef.current) { const { cw, ch } = dimsRef.current; initGame(cw, ch); tick(n => n + 1); return }
    if (wonRef.current)  return
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
    const goLeft = e.clientX - rect.left < rect.width / 2
    startedRef.current = true
    if (goLeft) leftRef.current  = true
    else        rightRef.current = true
  }
  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
    if (e.clientX - rect.left < rect.width / 2) leftRef.current  = false
    else                                         rightRef.current = false
  }
  function handlePointerLeave() { leftRef.current = false; rightRef.current = false }

  const { cw, ch } = dimsRef.current
  const camY       = camYRef.current
  const dead       = deadRef.current
  const won        = wonRef.current
  const cleared    = clearedRef.current
  const started    = startedRef.current

  const visibleFloors = floorsRef.current.filter(f => {
    const sy = f.worldY - camY
    return sy > -C3P2_FLOOR_H - 4 && sy < ch + 20
  })

  return (
    <>
      <div
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        style={{ ...canvasStyle, cursor: won ? 'default' : 'pointer', overflow: 'hidden', touchAction: 'none' }}
      >
        {/* Thin pill platforms — worldY is the top edge */}
        {visibleFloors.flatMap(floor => {
          const screenY = floor.worldY - camY
          return floor.clouds.map((cloud, ci) => (
            <div key={`${floor.id}-${ci}`} style={{
              position: 'absolute',
              top: screenY,
              left: cloud.x,
              width: cloud.w,
              height: C3P2_FLOOR_H,
              borderRadius: C3P2_FLOOR_H / 2,
              background: '#fff',
              border: '2px solid #1a1a1a',
              pointerEvents: 'none',
            }} />
          ))
        })}

        {/* Player dot — YELLOW */}
        <div style={{
          position: 'absolute',
          left: pxRef.current,
          top: pyRef.current - camY,
          width: C3P2_R * 2, height: C3P2_R * 2,
          borderRadius: '50%', background: YELLOW,
          transform: 'translate(-50%, -50%)',
          boxShadow: dead ? `0 0 0 8px ${YELLOW}55` : 'none',
          pointerEvents: 'none',
          zIndex: 2,
        }} />

        {/* Score: levels descended */}
        {started && !dead && !won && (
          <div style={{
            position: 'absolute', top: 18, right: 18,
            fontSize: 14, fontWeight: 800, color: '#bbb', fontFamily: 'inherit',
          }}>
            {cleared} / {winTarget}
          </div>
        )}

        {/* Left/right tap zone hints — always visible until started */}
        {!started && !dead && !won && (
          <>
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0, width: '50%',
              display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
              paddingBottom: 20, pointerEvents: 'none',
            }}>
              <span style={{ fontSize: 28, opacity: 0.18 }}>←</span>
            </div>
            <div style={{
              position: 'absolute', right: 0, top: 0, bottom: 0, width: '50%',
              display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
              paddingBottom: 20, pointerEvents: 'none',
            }}>
              <span style={{ fontSize: 28, opacity: 0.18 }}>→</span>
            </div>
          </>
        )}

        {/* Start hint */}
        {!started && !dead && !won && (
          <div style={{
            position: 'absolute', left: '50%', top: '42%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center', pointerEvents: 'none',
          }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: YELLOW, fontFamily: 'inherit' }}>
              Tap to start!
            </div>
            <div style={{ fontSize: 12, color: '#aaa', marginTop: 6, fontFamily: 'inherit' }}>
              tap left / right to move
            </div>
          </div>
        )}

        {/* Dead overlay */}
        {dead && (
          <div style={{
            position: 'absolute', left: '50%', top: '42%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center', pointerEvents: 'none',
          }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: YELLOW, fontFamily: 'inherit' }}>Oops! 😵</div>
            <div style={{ fontSize: 14, color: YELLOW, opacity: 0.7, marginTop: 8, fontFamily: 'inherit' }}>Tap to try again</div>
          </div>
        )}

        {/* Win overlay */}
        {won && (
          <div style={{
            position: 'absolute', left: '50%', top: '42%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center', pointerEvents: 'none',
          }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: YELLOW, fontFamily: 'inherit' }}>You made it! 🎉</div>
            <button
              onClick={e => { e.stopPropagation(); const { cw, ch } = dimsRef.current; initGame(cw, ch); tick(n => n + 1) }}
              style={{
                pointerEvents: 'auto', marginTop: 12, fontSize: 14, cursor: 'pointer',
                background: 'none', border: `1.5px solid ${YELLOW}88`, color: YELLOW,
                fontFamily: 'inherit', padding: '4px 18px', borderRadius: 20,
              }}
            >↺ Play again</button>
          </div>
        )}
      </div>
      <IntroText>Tap left or right to dodge past the platforms!</IntroText>
      <SetDone done={wonRef.current} />
    </>
  )
}

// ─── Chapter 3 Page 3: Tunnel Dot ────────────────────────────────────────────
// Terrain is a continuous winding cave drawn on <canvas>.
// Ceiling and floor are solid black polygons; the passage is the white gap.
type C3P3Seg = { x: number; topY: number; botY: number }

const C3P3_R         = 22      // dot radius px
const C3P3_GRAV      = 0.045   // very gentle gravity px/frame²
const C3P3_FLAP_V    = -1.8    // upward impulse on tap
const C3P3_MAX_VY    = 2.2     // max fall speed
const C3P3_SPD       = 1.5     // terrain scroll speed px/frame
const C3P3_SEG_SP    = 72      // px between terrain sample points
const C3P3_DRIFT     = 16      // max Y shift between consecutive segments
const C3P3_MIN_GAP   = 185     // minimum tunnel opening height px
const C3P3_DOT_X_F   = 0.18   // dot fixed X fraction
const C3P3_WIN_DIST  = 10 * 60  // frames survived — level 1  (10 s)
const C3P3_WIN_DIST2 = 25 * 60  // frames survived — level 2  (25 s)
const C3P3_WIN_DIST3 = 45 * 60  // frames survived — level 3  (45 s, hard)

/** Simple LCG seeded RNG — use a fixed seed in initGame so terrain is identical every run. */
function makeLCG(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}

function driftTunnel(topY: number, botY: number, ch: number, rng: () => number = Math.random, minGap = C3P3_MIN_GAP, drift = C3P3_DRIFT): { topY: number; botY: number } {
  // Gentle pull: nudge the gap centre back toward screen centre each step
  const gapCentre   = (topY + botY) / 2
  const pullToCenter = (ch / 2 - gapCentre) * 0.18
  let t = topY + (rng() - 0.5) * 2 * drift + pullToCenter
  let b = botY + (rng() - 0.5) * 2 * drift + pullToCenter
  t = Math.max(14, Math.min(ch - minGap - 14, t))
  b = Math.max(t + minGap, Math.min(ch - 14, b))
  return { topY: t, botY: b }
}

function tunnelAt(segs: C3P3Seg[], x: number, ch: number): { topY: number; botY: number } {
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].x <= x && segs[i + 1].x > x) {
      const t = (x - segs[i].x) / (segs[i + 1].x - segs[i].x)
      return {
        topY: segs[i].topY + t * (segs[i + 1].topY - segs[i].topY),
        botY: segs[i].botY + t * (segs[i + 1].botY - segs[i].botY),
      }
    }
  }
  const last = segs[segs.length - 1]
  return last ? { topY: last.topY, botY: last.botY } : { topY: 0, botY: ch }
}

function Ch3Page3({ winTarget = C3P3_WIN_DIST, variant = 'normal' }: { winTarget?: number; variant?: 'normal' | 'hard' } = {}) {
  const active   = useContext(PageActiveCtx)
  const outerRef = useRef<HTMLDivElement>(null)
  const cvRef    = useRef<HTMLCanvasElement>(null)
  const dimsRef  = useRef({ cw: 960, ch: 520 })
  const rafRef   = useRef<number | null>(null)
  const lastTRef = useRef(0)
  const [, tick] = useState(0)

  const pyRef       = useRef(260)
  const vyRef       = useRef(0)
  const segsRef     = useRef<C3P3Seg[]>([])
  const framesRef   = useRef(0)   // frames survived (for time tracking)
  const runRef      = useRef(false)
  const deadRef     = useRef(false)
  const wonRef      = useRef(false)

  function initGame(cw: number, ch: number) {
    pyRef.current    = ch / 2
    vyRef.current    = 0
    framesRef.current = 0
    runRef.current   = false
    deadRef.current = false
    wonRef.current  = false
    segsRef.current = []
    // Random seed each session → fresh terrain every run
    const rng  = makeLCG((Math.random() * 0xFFFFFFFF) >>> 0)
    let topY   = ch * 0.22
    let botY   = ch * 0.78
    for (let x = -C3P3_SEG_SP; x <= cw + C3P3_SEG_SP * 6; x += C3P3_SEG_SP) {
      segsRef.current.push({ x, topY, botY })
      const d = driftTunnel(topY, botY, ch, rng)
      topY = d.topY; botY = d.botY
    }
  }

  // Keep canvas pixel dims in sync with its CSS size
  useLayoutEffect(() => {
    const el = outerRef.current; if (!el) return
    const ro = new ResizeObserver(entries => {
      const { width: cw, height: ch } = entries[0].contentRect
      if (cw > 0 && ch > 0) {
        dimsRef.current = { cw, ch }
        if (cvRef.current) { cvRef.current.width = Math.round(cw); cvRef.current.height = Math.round(ch) }
      }
    })
    ro.observe(el); return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!active) {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
      return
    }
    const { cw, ch } = dimsRef.current
    initGame(cw, ch)
    if (cvRef.current) { cvRef.current.width = Math.round(cw); cvRef.current.height = Math.round(ch) }

    lastTRef.current = performance.now()
    let alive = true
    const step = (now: number) => {
      if (!alive) return
      const { cw, ch } = dimsRef.current
      const dotX = cw * C3P3_DOT_X_F
      // Delta-time normalised to 60 fps
      const dt     = Math.min(now - lastTRef.current, 50)
      lastTRef.current = now
      const frames = dt * 60 / 1000

      // ── Physics ─────────────────────────────────────────────────────────────
      if (runRef.current && !wonRef.current && !deadRef.current) {
        vyRef.current = Math.min(vyRef.current + C3P3_GRAV * frames, C3P3_MAX_VY)
        pyRef.current += vyRef.current * frames
        framesRef.current += frames   // time in 60-fps-equivalent units

        // Hard mode: speed, gap, and jaggedness all increase over time
        const dynSpd    = variant === 'hard' ? Math.min(C3P3_SPD * 2.5, C3P3_SPD + framesRef.current * 0.001) : C3P3_SPD
        const dynMinGap = variant === 'hard' ? Math.max(C3P3_MIN_GAP * 0.40, C3P3_MIN_GAP - framesRef.current * 0.04) : C3P3_MIN_GAP
        const dynDrift  = variant === 'hard' ? Math.min(C3P3_DRIFT * 5, C3P3_DRIFT + framesRef.current * 0.018) : C3P3_DRIFT

        // Scroll terrain left
        for (const s of segsRef.current) s.x -= dynSpd * frames
        segsRef.current = segsRef.current.filter(s => s.x > -C3P3_SEG_SP * 2)

        // Generate new segments at the right edge
        while (segsRef.current[segsRef.current.length - 1].x < cw + C3P3_SEG_SP) {
          const last = segsRef.current[segsRef.current.length - 1]
          const d    = driftTunnel(last.topY, last.botY, ch, Math.random, dynMinGap, dynDrift)
          segsRef.current.push({ x: last.x + C3P3_SEG_SP, ...d })
        }

        // Collision: dot vs tunnel walls (slightly forgiving hitbox)
        const { topY, botY } = tunnelAt(segsRef.current, dotX, ch)
        const r = C3P3_R - 3
        if (pyRef.current - r < topY || pyRef.current + r > botY) {
          deadRef.current = true
        }

        if (framesRef.current >= winTarget) wonRef.current = true
      }

      // ── Draw ─────────────────────────────────────────────────────────────────
      const cv = cvRef.current
      if (cv) {
        const ctx = cv.getContext('2d')!
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, cw, ch)

        const segs = segsRef.current
        if (segs.length >= 2) {
          ctx.fillStyle = '#1a1a1a'

          // Ceiling polygon: top-left → ceiling line → top-right → close
          ctx.beginPath()
          ctx.moveTo(-10, -10)
          for (const s of segs) ctx.lineTo(s.x, s.topY)
          ctx.lineTo(cw + 10, -10)
          ctx.closePath()
          ctx.fill()

          // Floor polygon: bottom-left → floor line → bottom-right → close
          ctx.beginPath()
          ctx.moveTo(-10, ch + 10)
          for (const s of segs) ctx.lineTo(s.x, s.botY)
          ctx.lineTo(cw + 10, ch + 10)
          ctx.closePath()
          ctx.fill()
        }

        // Blue dot
        ctx.beginPath()
        ctx.arc(dotX, pyRef.current, C3P3_R, 0, Math.PI * 2)
        ctx.fillStyle = BLUE
        ctx.fill()

        // Countdown timer (top-right): "MM:SS" counting down to 00:00
        if (runRef.current && !wonRef.current && !deadRef.current) {
          const remainSec = Math.max(0, Math.ceil((winTarget - framesRef.current) / 60))
          const mm = Math.floor(remainSec / 60)
          const ss = remainSec % 60
          ctx.fillStyle = '#bbbbbb'
          ctx.font = '700 13px system-ui, sans-serif'
          ctx.textAlign = 'right'
          ctx.textBaseline = 'top'
          ctx.fillText(`${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`, cw - 18, 16)
        }
      }

      tick(n => n + 1)
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => { alive = false; if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null } }
  }, [active])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); flap() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])  // eslint-disable-line react-hooks/exhaustive-deps

  function flap() {
    if (wonRef.current) return
    if (deadRef.current) { const { cw, ch } = dimsRef.current; initGame(cw, ch); return }
    runRef.current = true
    vyRef.current  = C3P3_FLAP_V
  }

  const run  = runRef.current
  const dead = deadRef.current
  const won  = wonRef.current

  return (
    <>
      {/* Outer div carries the canvasStyle border/radius; canvas fills it absolutely */}
      <div
        ref={outerRef}
        onClick={flap}
        style={{ ...canvasStyle, cursor: won ? 'default' : 'pointer', padding: 0, background: '#fff' }}
      >
        <canvas
          ref={cvRef}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
        />

        {/* Start hint */}
        {!run && !dead && !won && (
          <div style={{
            position: 'absolute', left: '50%', top: '42%',
            transform: 'translate(-50%, -50%)',
            fontSize: 17, fontWeight: 700, color: BLUE,
            fontFamily: 'inherit', pointerEvents: 'none', zIndex: 1,
          }}>
            Press or tap to start!
          </div>
        )}

        {/* Dead */}
        {dead && (
          <div style={{
            position: 'absolute', left: '50%', top: '38%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center', pointerEvents: 'none', zIndex: 1,
          }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: BLUE, fontFamily: 'inherit' }}>Oops! 😵</div>
            <div style={{ fontSize: 14, color: BLUE, opacity: 0.7, marginTop: 8, fontFamily: 'inherit' }}>Tap to try again</div>
          </div>
        )}

        {/* Won */}
        {won && (
          <div style={{
            position: 'absolute', left: '50%', top: '38%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center', pointerEvents: 'none', zIndex: 1,
          }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: BLUE, fontFamily: 'inherit' }}>You made it! 🎉</div>
            <button
              onClick={e => { e.stopPropagation(); const { cw, ch } = dimsRef.current; initGame(cw, ch) }}
              style={{
                pointerEvents: 'auto', marginTop: 12, fontSize: 14, cursor: 'pointer',
                background: 'none', border: `1.5px solid ${BLUE}88`, color: BLUE,
                fontFamily: 'inherit', padding: '4px 18px', borderRadius: 20,
              }}
            >↺ Play again</button>
          </div>
        )}
      </div>
      <IntroText>Tap to float through the tunnel!</IntroText>
      <SetDone done={wonRef.current} />
    </>
  )
}

// ─── Ch4 sound effects (Web Audio API — no external files) ───────────────────

let _sfxCtx: AudioContext | null = null
function getSfxCtx(): AudioContext | null {
  try {
    if (!_sfxCtx || _sfxCtx.state === 'closed') {
      _sfxCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
    }
    return _sfxCtx
  } catch { return null }
}
/** Call from any pointer/click handler to unlock AudioContext on iOS */
function sfxUnlock() {
  const ctx = getSfxCtx()
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
}
function playSound(type: 'turn' | 'score' | 'win' | 'lose' | 'tie') {
  const ctx = getSfxCtx(); if (!ctx) return
  if (ctx.state === 'suspended') { ctx.resume().then(() => playSound(type)).catch(() => {}); return }
  try {
    const now = ctx.currentTime
    const tone = (freq: number, t: number, dur: number, vol = 0.25, shape: OscillatorType = 'sine') => {
      const osc = ctx.createOscillator()
      const g   = ctx.createGain()
      osc.type = shape; osc.frequency.value = freq
      g.gain.setValueAtTime(vol, now + t)
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + dur)
      osc.connect(g); g.connect(ctx.destination)
      osc.start(now + t); osc.stop(now + t + dur + 0.05)
    }
    if (type === 'turn')  { tone(660, 0, 0.07, 0.15) }
    if (type === 'score') { tone(523, 0, 0.10, 0.3); tone(784, 0.09, 0.16, 0.3) }
    if (type === 'win')   { tone(523, 0, 0.15, 0.35); tone(659, 0.14, 0.15, 0.35); tone(784, 0.28, 0.15, 0.35); tone(1047, 0.42, 0.55, 0.35) }
    if (type === 'lose')  { tone(392, 0, 0.20, 0.25); tone(330, 0.18, 0.20, 0.25); tone(262, 0.36, 0.45, 0.22) }
    if (type === 'tie')   { tone(440, 0, 0.12, 0.2); tone(440, 0.15, 0.12, 0.18); tone(330, 0.31, 0.28, 0.14) }
  } catch {}
}

// ─── Ch4 shared layout utilities ─────────────────────────────────────────────

const ch4CanvasStyle: React.CSSProperties = { ...canvasStyle, minWidth: 0 }

function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const h = () => setW(window.innerWidth)
    window.addEventListener('resize', h)
    return () => window.removeEventListener('resize', h)
  }, [])
  return w
}

function useIsLandscape(): boolean {
  const [ls, setLs] = useState(() => window.innerWidth > window.innerHeight)
  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape)')
    const h  = (e: MediaQueryListEvent) => setLs(e.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [])
  return ls
}

// ─── Ch4 shared components ────────────────────────────────────────────────────

function TurnIndicator({ current, gameOver, mode, P_COLOR, isLandscape, scores, icons, labels, players = ['X', 'O'] }: {
  current: Player; gameOver: boolean; mode: TTTMode
  P_COLOR: Partial<Record<Player, string>>
  isLandscape: boolean
  players?: Player[]
  scores?: Partial<Record<Player, number>>
  icons?: Partial<Record<Player, React.ReactNode>>
  labels?: Partial<Record<Player, string>>
}) {
  const DEFAULT_NAMES: Record<Player, string> = { X: 'Blue', O: 'Red', Y: 'Yellow' }
  return (
    <div style={{
      display: 'flex',
      flexDirection: isLandscape ? 'column' : 'row',
      gap: isLandscape ? 10 : 20,
      alignItems: isLandscape ? 'flex-start' : 'center',
    }}>
      {players.map(p => {
        const active = current === p && !gameOver
        const label = labels != null && labels[p] != null
          ? labels[p]!
          : scores != null
            ? String(scores[p] ?? 0)
            : mode === 'computer' ? (p === 'X' ? 'You' : p === 'O' ? 'Me' : DEFAULT_NAMES[p]) : DEFAULT_NAMES[p]
        const color = P_COLOR[p] ?? '#888'
        return (
          <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: color, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {icons?.[p] && <span style={{ lineHeight: 0, color: '#fff', userSelect: 'none' }}>{icons[p]}</span>}
            </div>
            <span style={{
              fontSize: scores != null ? 22 : 16,
              fontWeight: 700,
              color,
              fontFamily: 'inherit',
              lineHeight: 1,
            }}>{label}{active ? <span style={{ fontSize: '1.5em', marginLeft: 4 }}>👈</span> : ''}</span>
          </div>
        )
      })}
    </div>
  )
}

function ModeSelector({ mode, onReset }: { mode: TTTMode; onReset: (m: TTTMode) => void }) {
  return (
    <div style={{ display: 'flex', border: '1.5px solid #e8e8e8', borderRadius: 30, overflow: 'hidden' }}>
      {(['computer', 'two-player'] as const).map(m => (
        <button key={m} onClick={() => onReset(m)} style={{
          padding: '5px 16px',
          background: mode === m ? '#ddd' : 'transparent',
          color: mode === m ? '#555' : '#bbb',
          border: 'none', fontSize: 12, fontWeight: mode === m ? 700 : 400,
          cursor: mode === m ? 'default' : 'pointer',
          fontFamily: 'inherit',
          transition: 'background 0.15s, color 0.15s',
        }}>
          {m === 'computer' ? 'vs Computer' : 'Multi Players'}
        </button>
      ))}
    </div>
  )
}


function PlayerCountControl({ count, onChange, isLandscape }: { count: number; onChange: (n: 2 | 3) => void; isLandscape: boolean }) {
  const is3 = count >= 3
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: isLandscape ? 0 : 0 }}>
      <button
        onClick={() => onChange(is3 ? 2 : 3)}
        style={{
          width: 32, height: 32, borderRadius: '50%',
          border: '2px solid #ccc',
          background: 'transparent', color: '#bbb',
          fontSize: 22, fontWeight: 300,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'inherit', lineHeight: 1, padding: 0, flexShrink: 0,
          transition: 'border-color 0.15s, color 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = '#aaa'; e.currentTarget.style.color = '#888' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = '#ccc'; e.currentTarget.style.color = '#bbb' }}
      >{is3 ? '−' : '+'}</button>
    </div>
  )
}

function nextTurn(cur: Player, numPlayers: 2 | 3): Player {
  if (numPlayers === 2) return cur === 'X' ? 'O' : 'X'
  return cur === 'X' ? 'O' : cur === 'O' ? 'Y' : 'X'
}

// ─── Ch4 shared SVG grid constants (same scale across all pages) ──────────────
const CH4_DOT_R    = 4.5  // dot radius (viewBox units, same scale as DB)
const CH4_DOT_SEL  = 6.75 // selected dot radius
const DB_HIT_R     = 28   // invisible touch-target radius for DotsAndBoxes dots (~35% of cell)
const DT_HIT_R     = 18   // invisible touch-target radius for DotTriangles dots
const CH4_LW_E     = 2    // empty grid line stroke-width
const CH4_VB_PAD   = 40   // viewBox padding
const CH4_VB_CELL  = 80   // cell size in viewBox units

// ─── Chapter 4 Page 1 — Tic Tac Toe ─────────────────────────────────────────
type TTTCell = null | 'X' | 'O'
type TTTStatus = 'playing' | 'x-wins' | 'o-wins' | 'draw'

const TTT_LINES: [number, number, number][] = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6],
]

function tttWinner(board: TTTCell[]): TTTStatus {
  for (const [a,b,c] of TTT_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c])
      return board[a] === 'X' ? 'x-wins' : 'o-wins'
  }
  return board.every(c => c !== null) ? 'draw' : 'playing'
}

function tttWinLine(board: TTTCell[]): number[] | null {
  for (const [a,b,c] of TTT_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return [a,b,c]
  }
  return null
}

function tttAIMove(board: TTTCell[]): number {
  const empty = board.flatMap((c, i) => c === null ? [i] : [])
  for (const i of empty) {  // win if possible
    const b = [...board]; b[i] = 'O'
    if (tttWinner(b) === 'o-wins') return i
  }
  for (const i of empty) {  // block player
    const b = [...board]; b[i] = 'X'
    if (tttWinner(b) === 'x-wins') return i
  }
  if (board[4] === null) return 4
  const corners = [0, 2, 6, 8].filter(i => board[i] === null)
  if (corners.length) return corners[Math.floor(Math.random() * corners.length)]
  return empty[Math.floor(Math.random() * empty.length)]
}

type TTTMode = 'computer' | 'two-player'

function Ch4RulesModal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.38)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, boxSizing: 'border-box',
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 20, padding: '28px 30px',
          maxWidth: 400, width: '100%', boxShadow: '0 12px 60px #0004',
          fontFamily: 'inherit', maxHeight: '88vh', overflowY: 'auto',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 800, color: '#222', marginBottom: 14, fontFamily: 'inherit' }}>
          {title}
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.8, color: '#555', fontFamily: 'inherit' }}>
          {children}
        </div>
        <button onClick={onClose} style={{
          marginTop: 22, padding: '8px 24px', borderRadius: 30,
          background: '#222', border: 'none', color: '#fff',
          fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
        }}>Got it!</button>
      </div>
    </div>
  )
}

function ShowRulesButton({ onClick }: { onClick: () => void }) {
  const [hov, setHov] = useState(false)
  return (
    <span role="button" onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ color: hov ? '#2d6fad' : '#5b9bd5', cursor: 'pointer', fontWeight: 600 }}>
      Show rules
    </span>
  )
}

function ch4Caption(name: string, desc: string, onShowRules: () => void): React.ReactNode {
  const punctuated = /[.!?]$/.test(desc) ? desc : desc + '.'
  return (
    <><span style={{ fontWeight: 700 }}>{name}:</span> {punctuated}{' '}<ShowRulesButton onClick={onShowRules} /></>
  )
}

// ── Step-by-step diagram helpers for rules modals ───────────────────────────

function RuleSteps({ steps }: { steps: { svg: React.ReactNode; label: string }[] }) {
  return (
    <div style={{ display: 'flex', gap: 7, margin: '12px 0 14px' }}>
      {steps.map((step, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
          <div style={{
            width: '100%', aspectRatio: '1 / 1', border: '1.5px solid #eee',
            borderRadius: 10, background: '#fafafa', overflow: 'hidden',
          }}>
            {step.svg}
          </div>
          <div style={{ fontSize: 10.5, color: '#888', textAlign: 'center', lineHeight: 1.35, fontFamily: 'inherit' }}>
            {step.label}
          </div>
        </div>
      ))}
    </div>
  )
}

// TicTacToe board snapshot
function TttDiagram({ pieces, winCells = [] }: {
  pieces: Array<{ c: number; r: number; type: 'X' | 'O' }>
  winCells?: Array<[number, number]>
}) {
  return (
    <svg viewBox="0 0 90 90" style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width={90} height={90} fill="#fcfaf6"/>
      {winCells.map(([c, r]) => (
        <rect key={`w${c}${r}`} x={7 + c * 28} y={7 + r * 28} width={28} height={28} fill="#fff3b0"/>
      ))}
      <line x1={35} y1={7} x2={35} y2={83} stroke="#ddd" strokeWidth={1.5}/>
      <line x1={63} y1={7} x2={63} y2={83} stroke="#ddd" strokeWidth={1.5}/>
      <line x1={7} y1={35} x2={83} y2={35} stroke="#ddd" strokeWidth={1.5}/>
      <line x1={7} y1={63} x2={83} y2={63} stroke="#ddd" strokeWidth={1.5}/>
      {pieces.map(({ c, r, type }) => {
        const cx = 21 + c * 28, cy = 21 + r * 28
        return type === 'X'
          ? <g key={`${c}${r}`}>
              <line x1={cx - 9} y1={cy - 9} x2={cx + 9} y2={cy + 9} stroke="#5b9bd5" strokeWidth={2.5} strokeLinecap="round"/>
              <line x1={cx + 9} y1={cy - 9} x2={cx - 9} y2={cy + 9} stroke="#5b9bd5" strokeWidth={2.5} strokeLinecap="round"/>
            </g>
          : <circle key={`${c}${r}`} cx={cx} cy={cy} r={9} fill="none" stroke="#e05252" strokeWidth={2.5}/>
      })}
    </svg>
  )
}

// DotsAndBoxes snapshot — 2×2 boxes (3×3 dots)
// hLines = [[col, row, player]] → horizontal edge between dot(c,r) and dot(c+1,r)
// vLines = [[col, row, player]] → vertical edge between dot(c,r) and dot(c,r+1)
// boxes  = [[col, row, player]] → completed filled box
function DbDiagram({ hLines = [], vLines = [], boxes = [] }: {
  hLines?: Array<[number, number, 'X' | 'O' | 'hint']>
  vLines?: Array<[number, number, 'X' | 'O' | 'hint']>
  boxes?: Array<[number, number, 'X' | 'O']>
}) {
  const dx = (c: number) => 15 + c * 30
  const dy = (r: number) => 15 + r * 30
  const lc = (p: 'X' | 'O' | 'hint') => p === 'X' ? '#5b9bd5' : p === 'O' ? '#e05252' : '#a8cff0'
  return (
    <svg viewBox="0 0 90 90" style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width={90} height={90} fill="#fafaf8"/>
      {boxes.map(([c, r, p]) => (
        <rect key={`b${c}${r}`} x={dx(c) + 2} y={dy(r) + 2} width={26} height={26}
          fill={p === 'X' ? '#5b9bd530' : '#e0525230'} rx={3}/>
      ))}
      {hLines.map(([c, r, p]) => (
        <line key={`h${c}${r}`} x1={dx(c) + 5} y1={dy(r)} x2={dx(c + 1) - 5} y2={dy(r)}
          stroke={lc(p)} strokeWidth={p === 'hint' ? 1.8 : 2.5} strokeLinecap="round"
          strokeDasharray={p === 'hint' ? '5 3' : 'none'}/>
      ))}
      {vLines.map(([c, r, p]) => (
        <line key={`v${c}${r}`} x1={dx(c)} y1={dy(r) + 5} x2={dx(c)} y2={dy(r + 1) - 5}
          stroke={lc(p)} strokeWidth={p === 'hint' ? 1.8 : 2.5} strokeLinecap="round"
          strokeDasharray={p === 'hint' ? '5 3' : 'none'}/>
      ))}
      {[0, 1, 2].flatMap(r => [0, 1, 2].map(c => (
        <circle key={`d${c}${r}`} cx={dx(c)} cy={dy(r)} r={4} fill="#999"/>
      )))}
    </svg>
  )
}

// DotTriangles snapshot — 5 fixed demo dots
const _DT_DEMO_DOTS = [
  { x: 14, y: 14 }, // 0 top-left
  { x: 76, y: 14 }, // 1 top-right
  { x: 76, y: 76 }, // 2 bottom-right
  { x: 14, y: 76 }, // 3 bottom-left
  { x: 45, y: 45 }, // 4 center
]
function DtDiagram({ edges = [], tris = [] }: {
  edges?: Array<[number, number, 'X' | 'O']>
  tris?: Array<[number, number, number, 'X' | 'O']>
}) {
  return (
    <svg viewBox="0 0 90 90" style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width={90} height={90} fill="#fafaf8"/>
      {tris.map(([a, b, c, p], i) => {
        const da = _DT_DEMO_DOTS[a], db = _DT_DEMO_DOTS[b], dc = _DT_DEMO_DOTS[c]
        return <polygon key={i}
          points={`${da.x},${da.y} ${db.x},${db.y} ${dc.x},${dc.y}`}
          fill={p === 'X' ? '#5b9bd535' : '#e0525235'}/>
      })}
      {edges.map(([a, b, p], i) => {
        const da = _DT_DEMO_DOTS[a], db = _DT_DEMO_DOTS[b]
        return <line key={i} x1={da.x} y1={da.y} x2={db.x} y2={db.y}
          stroke={p === 'X' ? '#5b9bd5' : '#e05252'} strokeWidth={2.5} strokeLinecap="round"/>
      })}
      {_DT_DEMO_DOTS.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={5} fill="#aaa"/>
      ))}
    </svg>
  )
}

// RectangleGame snapshot — 3×3 dot grid
// rects = [[r1, c1, r2, c2, player]] → placed rectangles
// draftRect = [r1, c1, r2, c2] → in-progress drag preview
function RgDiagram({ rects = [], draftRect }: {
  rects?: Array<[number, number, number, number, 'X' | 'O']>
  draftRect?: [number, number, number, number]
}) {
  const dx = (c: number) => 15 + c * 30
  const dy = (r: number) => 15 + r * 30
  return (
    <svg viewBox="0 0 90 90" style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width={90} height={90} fill="#fafaf8"/>
      {rects.map(([r1, c1, r2, c2, p], i) => {
        const x = Math.min(dx(c1), dx(c2)), y = Math.min(dy(r1), dy(r2))
        const w = Math.abs(dx(c2) - dx(c1)), h = Math.abs(dy(r2) - dy(r1))
        return <rect key={i} x={x} y={y} width={w} height={h}
          fill={p === 'X' ? '#5b9bd520' : '#e0525220'}
          stroke={p === 'X' ? '#5b9bd5' : '#e05252'} strokeWidth={2} rx={2}/>
      })}
      {draftRect && (() => {
        const [r1, c1, r2, c2] = draftRect
        const x = Math.min(dx(c1), dx(c2)), y = Math.min(dy(r1), dy(r2))
        const w = Math.abs(dx(c2) - dx(c1)), h = Math.abs(dy(r2) - dy(r1))
        return <rect x={x} y={y} width={w} height={h}
          fill="none" stroke="#5b9bd5aa" strokeWidth={1.8} strokeDasharray="5 3" rx={2}/>
      })()}
      {[0, 1, 2].flatMap(r => [0, 1, 2].map(c => (
        <circle key={`d${c}${r}`} cx={dx(c)} cy={dy(r)} r={3.5} fill="#bbb"/>
      )))}
    </svg>
  )
}

// CatMouse snapshot — pentagon + center graph
const _CM_DEMO_NODES = [
  { x: 45, y: 10 }, // 0 top
  { x: 74, y: 31 }, // 1 upper-right
  { x: 63, y: 65 }, // 2 lower-right
  { x: 27, y: 65 }, // 3 lower-left
  { x: 16, y: 31 }, // 4 upper-left
  { x: 45, y: 44 }, // 5 center
]
const _CM_DEMO_EDGES: [number, number][] = [[0,1],[1,2],[2,3],[3,4],[4,0],[5,0],[5,2],[5,3]]
function CmDiagram({ virus, cell, simple = false }: { virus: number; cell: number; simple?: boolean }) {
  const caught = virus === cell
  return (
    <svg viewBox="0 0 90 90" style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width={90} height={90} fill="#fafaf8"/>
      {_CM_DEMO_EDGES.map(([a, b], i) => {
        const na = _CM_DEMO_NODES[a], nb = _CM_DEMO_NODES[b]
        return <line key={i} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y} stroke="#ddd" strokeWidth={2}/>
      })}
      {_CM_DEMO_NODES.map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r={6} fill="#f0f0f0" stroke="#ccc" strokeWidth={1.5}/>
      ))}
      {!caught && (() => {
        const vn = _CM_DEMO_NODES[virus]
        return simple
          ? <circle cx={vn.x} cy={vn.y} r={9} fill="#e05252"/>
          : <>
              <circle cx={vn.x} cy={vn.y} r={9} fill="#e05252"/>
              <line x1={vn.x - 5} y1={vn.y - 5} x2={vn.x + 5} y2={vn.y + 5} stroke="white" strokeWidth={2} strokeLinecap="round"/>
              <line x1={vn.x + 5} y1={vn.y - 5} x2={vn.x - 5} y2={vn.y + 5} stroke="white" strokeWidth={2} strokeLinecap="round"/>
            </>
      })()}
      {!caught && (
        simple
          ? <circle cx={_CM_DEMO_NODES[cell].x} cy={_CM_DEMO_NODES[cell].y} r={9} fill="#5b9bd5"/>
          : <circle cx={_CM_DEMO_NODES[cell].x} cy={_CM_DEMO_NODES[cell].y}
              r={9} fill="none" stroke="#5b9bd5" strokeWidth={2.5}/>
      )}
      {caught && (() => {
        const n = _CM_DEMO_NODES[virus]
        return <>
          <circle cx={n.x} cy={n.y} r={11} fill="#5b9bd5" stroke="#e05252" strokeWidth={2}/>
          <line x1={n.x - 5} y1={n.y - 5} x2={n.x + 5} y2={n.y + 5} stroke="white" strokeWidth={2} strokeLinecap="round"/>
          <line x1={n.x + 5} y1={n.y - 5} x2={n.x - 5} y2={n.y + 5} stroke="white" strokeWidth={2} strokeLinecap="round"/>
        </>
      })()}
    </svg>
  )
}

/** Inline banner — sits in the bottom strip, never covers the board */
function Ch4GameOverBanner({ winnerLabel, winnerColor }: {
  winnerLabel: string; winnerColor: string
}) {
  return (
    <span style={{
      fontSize: 20, fontWeight: 800, color: winnerColor,
      fontFamily: 'inherit', letterSpacing: '-0.3px',
    }}>{winnerLabel}</span>
  )
}

/** Icon-only "Play again" button — positioned absolute in canvas top-right corner */
function Ch4PlayAgainBtn({ show, onClick }: { show: boolean; onClick: () => void }) {
  if (!show) return null
  return (
    <button
      onClick={onClick}
      title="Play again"
      style={{
        position: 'absolute', top: 8, right: 8, zIndex: 10,
        width: 30, height: 30, borderRadius: 20, padding: 0,
        background: 'transparent', border: '1.5px solid #ddd',
        color: '#bbb', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <RotateCcw size={13} strokeWidth={2.5} />
    </button>
  )
}

function TicTacToePage() {
  const [mode, setMode]         = useState<TTTMode>('computer')
  const [board, setBoard]       = useState<TTTCell[]>(Array(9).fill(null))
  const [current, setCurrent]   = useState<'X' | 'O'>('X')   // X = Blue, O = Red
  const [status, setStatus]     = useState<TTTStatus>('playing')
  const [winLine, setWinLine]   = useState<number[] | null>(null)
  const [hasWon, setHasWon]     = useState(false)
  const [hovered, setHovered]   = useState<number | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const aiPendingRef            = useRef(false)
  const aiTimerRef              = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isLandscape             = useIsLandscape()

  const P_COLOR: Record<'X'|'O', string> = { X: BLUE, O: RED }
  const gameOver = status !== 'playing'

  // Cancel pending AI timer on unmount
  useEffect(() => () => { if (aiTimerRef.current) clearTimeout(aiTimerRef.current) }, [])

  function resetGame(nextMode = mode) {
    if (aiTimerRef.current) { clearTimeout(aiTimerRef.current); aiTimerRef.current = null }
    setBoard(Array(9).fill(null))
    setCurrent('X')
    setStatus('playing')
    setWinLine(null)
    aiPendingRef.current = false
    setMode(nextMode)
  }

  function handleCellClick(i: number) {
    if (board[i] !== null || status !== 'playing' || aiPendingRef.current) return
    if (mode === 'computer' && current === 'O') return
    sfxUnlock()

    const nb = [...board] as TTTCell[]
    nb[i] = current
    const st = tttWinner(nb)
    setBoard(nb)

    if (st !== 'playing') {
      setStatus(st); setWinLine(tttWinLine(nb))
      if (st === 'x-wins') { setHasWon(true); playSound(mode === 'computer' ? 'win' : 'win') }
      else if (st === 'o-wins') playSound(mode === 'computer' ? 'lose' : 'win')
      else playSound('tie')
      return
    }

    const next: 'X'|'O' = current === 'X' ? 'O' : 'X'
    setCurrent(next)
    playSound('turn')

    if (mode === 'computer' && next === 'O') {
      aiPendingRef.current = true
      aiTimerRef.current = setTimeout(() => {
        aiTimerRef.current = null
        const ai = tttAIMove(nb)
        const ab = [...nb] as TTTCell[]
        ab[ai] = 'O'
        const ast = tttWinner(ab)
        setBoard(ab); setStatus(ast)
        if (ast !== 'playing') {
          setWinLine(tttWinLine(ab))
          if (ast === 'o-wins') playSound('lose')
          else playSound('tie')
        } else {
          playSound('turn')
        }
        setCurrent('X')
        aiPendingRef.current = false
      }, 480)
    }
  }

  const canClick = (i: number) =>
    board[i] === null && status === 'playing' && !aiPendingRef.current &&
    (mode === 'two-player' || current === 'X')

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tttCaption = useMemo(() => ch4Caption('Tic-tac-toe', 'Take turns placing pieces — get three in a row to win!', () => setRulesOpen(true)), [])

  const TTT_N  = 3
  const TTT_VB = 2 * CH4_VB_PAD + TTT_N * CH4_VB_CELL   // 320
  const tttDp  = (r: number, c: number) => ({ x: CH4_VB_PAD + c * CH4_VB_CELL, y: CH4_VB_PAD + r * CH4_VB_CELL })
  const PIECE_R = CH4_VB_CELL * 0.28

  const boardGrid = (
    <svg viewBox={`0 0 ${TTT_VB} ${TTT_VB}`} preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', aspectRatio: '1 / 1', maxHeight: '100%', display: 'block', overflow: 'visible' }}>

      {/* Grid lines */}
      {Array.from({ length: TTT_N + 1 }, (_, r) => {
        const { x: x0, y } = tttDp(r, 0), { x: x1 } = tttDp(r, TTT_N)
        return <line key={`h${r}`} x1={x0} y1={y} x2={x1} y2={y} stroke="#ddd" strokeWidth={CH4_LW_E} strokeLinecap="round" />
      })}
      {Array.from({ length: TTT_N + 1 }, (_, c) => {
        const { x, y: y0 } = tttDp(0, c), { y: y1 } = tttDp(TTT_N, c)
        return <line key={`v${c}`} x1={x} y1={y0} x2={x} y2={y1} stroke="#ddd" strokeWidth={CH4_LW_E} strokeLinecap="round" />
      })}

      {/* Cell win highlight + click areas */}
      {board.map((cell, i) => {
        const row = Math.floor(i / 3), col = i % 3
        const { x, y } = tttDp(row, col)
        const win = winLine?.includes(i)
        return (
          <rect key={i} x={x} y={y} width={CH4_VB_CELL} height={CH4_VB_CELL}
            fill={win ? P_COLOR[cell as 'X'|'O'] + '22' : 'transparent'}
            style={{ cursor: canClick(i) ? 'pointer' : 'default' }}
            onClick={() => handleCellClick(i)}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          />
        )
      })}

      {/* Win line */}
      {winLine && (() => {
        const a = winLine[0], c = winLine[2]
        const p1 = { x: CH4_VB_PAD + (a % 3 + 0.5) * CH4_VB_CELL, y: CH4_VB_PAD + (Math.floor(a / 3) + 0.5) * CH4_VB_CELL }
        const p2 = { x: CH4_VB_PAD + (c % 3 + 0.5) * CH4_VB_CELL, y: CH4_VB_PAD + (Math.floor(c / 3) + 0.5) * CH4_VB_CELL }
        return <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
          stroke={P_COLOR[board[a] as 'X'|'O']} strokeWidth={4} strokeLinecap="round" opacity={0.5} />
      })()}

      {/* Pieces */}
      {board.map((cell, i) => {
        if (!cell) return null
        const row = Math.floor(i / 3), col = i % 3
        const cx = CH4_VB_PAD + (col + 0.5) * CH4_VB_CELL
        const cy = CH4_VB_PAD + (row + 0.5) * CH4_VB_CELL
        return <circle key={i} cx={cx} cy={cy} r={PIECE_R} fill={P_COLOR[cell as 'X'|'O']} style={{ pointerEvents: 'none' }} />
      })}

      {/* Hover preview */}
      {hovered !== null && canClick(hovered) && (() => {
        const row = Math.floor(hovered / 3), col = hovered % 3
        return <circle cx={CH4_VB_PAD + (col + 0.5) * CH4_VB_CELL} cy={CH4_VB_PAD + (row + 0.5) * CH4_VB_CELL}
          r={PIECE_R} fill={P_COLOR[current] + '38'} style={{ pointerEvents: 'none' }} />
      })()}

    </svg>
  )

  const tttWinnerLabel =
    status === 'x-wins' ? (mode === 'computer' ? 'You win! 🎉' : 'Blue wins! 🎉')
    : status === 'o-wins' ? (mode === 'computer' ? 'I win! 😄' : 'Red wins!')
    : "It's a draw! 🤝"
  const tttWinnerColor =
    status === 'x-wins' ? BLUE : status === 'o-wins' ? RED : '#888'
  const gameOverBanner = !gameOver ? null : (
    <Ch4GameOverBanner
      winnerLabel={tttWinnerLabel}
      winnerColor={tttWinnerColor}
    />
  )

  const tttRules = (
    <>
      <RuleSteps steps={[
        {
          svg: <TttDiagram
            pieces={[{c:0,r:0,type:'X'},{c:1,r:1,type:'X'},{c:2,r:2,type:'X'},{c:2,r:0,type:'O'},{c:0,r:2,type:'O'}]}
            winCells={[[0,0],[1,1],[2,2]]}/>,
          label: '3 in a row wins!',
        },
      ]}/>
      <p style={{ margin: '0 0 10px' }}>Players alternate placing their piece on the 3×3 grid. Blue goes first.</p>
      <p style={{ margin: '0 0 10px' }}>First player to get <b>three pieces in a row</b> — horizontally, vertically, or diagonally — wins.</p>
      <p style={{ margin: 0 }}>If the board fills up with no winner, it's a <b>draw</b>.</p>
    </>
  )

  if (isLandscape) {
    return (
      <>
        <div style={{ ...ch4CanvasStyle, flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
          <Ch4PlayAgainBtn show={gameOver} onClick={resetGame} />
          {/* Left column: turn + mode / banner */}
          <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'space-between', padding: '24px 20px' }}>
            {gameOver ? gameOverBanner : <TurnIndicator current={current} gameOver={gameOver} mode={mode} P_COLOR={P_COLOR} isLandscape={true} />}
            <ModeSelector mode={mode} onReset={resetGame} />
          </div>
          {/* Board — no overlay */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box' }}>
            {boardGrid}
          </div>
        </div>
        <IntroText>{tttCaption}</IntroText>
        <SetDone celebrate={false} done={gameOver} />
        {rulesOpen && <Ch4RulesModal title="How to play Tic-tac-toe" onClose={() => setRulesOpen(false)}>{tttRules}</Ch4RulesModal>}
      </>
    )
  }

  return (
    <>
      <div style={{ ...ch4CanvasStyle, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', justifyContent: 'center' }}>
          <Ch4PlayAgainBtn show={gameOver} onClick={resetGame} />
        {/* Top: banner when over, turn indicator otherwise */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', height: 60, flexShrink: 0 }}>
          {gameOver ? gameOverBanner : <TurnIndicator current={current} gameOver={gameOver} mode={mode} P_COLOR={P_COLOR} isLandscape={false} />}
        </div>
        {/* Middle: board — no overlay */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, boxSizing: 'border-box' }}>
          {boardGrid}
        </div>
        {/* Bottom: always mode selector */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', height: 48, flexShrink: 0 }}>
          <ModeSelector mode={mode} onReset={resetGame} />
        </div>
      </div>
      <IntroText>{tttCaption}</IntroText>
      <SetDone celebrate={false} done={gameOver} />
      {rulesOpen && <Ch4RulesModal title="How to play Tic-tac-toe" onClose={() => setRulesOpen(false)}>{tttRules}</Ch4RulesModal>}
    </>
  )
}

// ─── Chapter 4 / Page 2: Dots and Boxes ──────────────────────────────────────
const DB_N       = 4                           // 4×4 = 16 boxes
const DB_VB_PAD  = CH4_VB_PAD                  // = 40
const DB_VB_CELL = CH4_VB_CELL                 // = 80
const DB_VB      = 2 * DB_VB_PAD + DB_N * DB_VB_CELL  // = 480
const DB_DOT_R   = CH4_DOT_R                   // = 6
const DB_DOT_SEL = CH4_DOT_SEL                 // = 9
const DB_LW      = 5                           // drawn line stroke-width
const DB_LW_E    = CH4_LW_E                    // = 2

// ViewBox position of dot (row, col)
const dbDp = (r: number, c: number) => ({
  x: DB_VB_PAD + c * DB_VB_CELL,
  y: DB_VB_PAD + r * DB_VB_CELL,
})

type DBOwner = null | Player

function dbMkH(): DBOwner[] { return Array<DBOwner>((DB_N + 1) * DB_N).fill(null) }
function dbMkV(): DBOwner[] { return Array<DBOwner>(DB_N * (DB_N + 1)).fill(null) }
function dbMkB(): DBOwner[] { return Array<DBOwner>(DB_N * DB_N).fill(null) }

function dbBoxSides(h: DBOwner[], v: DBOwner[], row: number, col: number): DBOwner[] {
  return [
    h[row * DB_N + col],              // top
    h[(row + 1) * DB_N + col],        // bottom
    v[row * (DB_N + 1) + col],        // left
    v[row * (DB_N + 1) + col + 1],    // right
  ]
}

function dbBoxComplete(h: DBOwner[], v: DBOwner[], row: number, col: number): boolean {
  return dbBoxSides(h, v, row, col).every(s => s !== null)
}

function dbCountSides(h: DBOwner[], v: DBOwner[], row: number, col: number): number {
  return dbBoxSides(h, v, row, col).filter(s => s !== null).length
}

function dbApply(
  h: DBOwner[], v: DBOwner[], boxes: DBOwner[],
  isH: boolean, idx: number, player: Player,
): { h: DBOwner[]; v: DBOwner[]; boxes: DBOwner[]; extra: boolean } {
  const nh = [...h], nv = [...v]
  if (isH) nh[idx] = player; else nv[idx] = player
  const nb = [...boxes]
  let extra = false
  for (let r = 0; r < DB_N; r++) {
    for (let c = 0; c < DB_N; c++) {
      if (nb[r * DB_N + c] === null && dbBoxComplete(nh, nv, r, c)) {
        nb[r * DB_N + c] = player
        extra = true
      }
    }
  }
  return { h: nh, v: nv, boxes: nb, extra }
}

function dbAI(h: DBOwner[], v: DBOwner[], boxes: DBOwner[]): { isH: boolean; idx: number } | null {
  const moves: { isH: boolean; idx: number }[] = []
  h.forEach((s, i) => { if (!s) moves.push({ isH: true,  idx: i }) })
  v.forEach((s, i) => { if (!s) moves.push({ isH: false, idx: i }) })
  if (!moves.length) return null

  function wouldComplete(isH: boolean, idx: number): boolean {
    const nh = [...h], nv = [...v]
    if (isH) nh[idx] = 'O'; else nv[idx] = 'O'
    for (let r = 0; r < DB_N; r++)
      for (let c = 0; c < DB_N; c++)
        if (boxes[r * DB_N + c] === null && dbBoxComplete(nh, nv, r, c)) return true
    return false
  }

  function wouldGive3(isH: boolean, idx: number): boolean {
    const nh = [...h], nv = [...v]
    if (isH) nh[idx] = 'O'; else nv[idx] = 'O'
    for (let r = 0; r < DB_N; r++)
      for (let c = 0; c < DB_N; c++)
        if (boxes[r * DB_N + c] === null && dbCountSides(nh, nv, r, c) === 3) return true
    return false
  }

  const wins = moves.filter(m => wouldComplete(m.isH, m.idx))
  if (wins.length) return wins[Math.floor(Math.random() * wins.length)]

  const safe = moves.filter(m => !wouldGive3(m.isH, m.idx))
  if (safe.length) return safe[Math.floor(Math.random() * safe.length)]

  return moves[Math.floor(Math.random() * moves.length)]
}

function DotsAndBoxesPage() {
  const [mode, setMode]       = useState<TTTMode>('computer')
  const [hLines, setHLines]   = useState<DBOwner[]>(dbMkH)
  const [vLines, setVLines]   = useState<DBOwner[]>(dbMkV)
  const [bBoxes, setBBoxes]   = useState<DBOwner[]>(dbMkB)
  const [current, setCurrent] = useState<Player>('X')
  const [numPlayers, setNumPlayers] = useState<2 | 3>(2)
  const [hasWon, setHasWon]   = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [selDot, setSelDot]   = useState<{ r: number; c: number } | null>(null)
  const [dragPt, setDragPt]   = useState<{ x: number; y: number } | null>(null)
  const dbSvgRef = useRef<SVGSVGElement>(null)
  const aiPendingRef = useRef(false)
  const aiCancelRef  = useRef(false)
  // Ref mirrors drag state for pointer handlers — avoids stale-closure race on touch
  const selDotRef    = useRef<{r:number;c:number}|null>(null)
  const isLandscape  = useIsLandscape()

  // Cancel any in-flight AI chain on unmount
  useEffect(() => () => { aiCancelRef.current = true }, [])

  function toDBSVGPt(e: React.PointerEvent) {
    const svg = dbSvgRef.current; if (!svg) return null
    const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY
    return p.matrixTransform(svg.getScreenCTM()!.inverse())
  }
  function nearestDBDot(pt: { x: number; y: number }, thresh: number) {
    let best: { r: number; c: number } | null = null, bestD = thresh
    for (let r = 0; r <= DB_N; r++)
      for (let c = 0; c <= DB_N; c++) {
        const dp = dbDp(r, c)
        const d = Math.hypot(dp.x - pt.x, dp.y - pt.y)
        if (d < bestD) { bestD = d; best = { r, c } }
      }
    return best
  }

  const P_COLOR: Record<Player, string> = { X: BLUE, O: RED, Y: YELLOW }
  const players = (numPlayers === 3 ? ['X', 'O', 'Y'] : ['X', 'O']) as Player[]
  const scoreX   = bBoxes.filter(b => b === 'X').length
  const scoreO   = bBoxes.filter(b => b === 'O').length
  const scoreY   = bBoxes.filter(b => b === 'Y').length
  const gameOver = bBoxes.every(b => b !== null)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dbCaption = useMemo(() => ch4Caption('Dots & Boxes', 'Draw lines to close boxes and outscore your opponent!', () => setRulesOpen(true)), [])

  useEffect(() => {
    if (gameOver && scoreX > scoreO && scoreX > scoreY && !hasWon) setHasWon(true)
  }, [gameOver, scoreX, scoreO, scoreY, hasWon])

  // Return line info for the segment between two adjacent dots, or null if already drawn / not adjacent
  function adjacentLine(r1: number, c1: number, r2: number, c2: number): { isH: boolean; idx: number } | null {
    const dr = r2 - r1, dc = c2 - c1
    if (Math.abs(dr) + Math.abs(dc) !== 1) return null
    if (dr === 0) {
      const col = Math.min(c1, c2)
      if (col < 0 || col >= DB_N || r1 < 0 || r1 > DB_N) return null
      const idx = r1 * DB_N + col
      return hLines[idx] === null ? { isH: true, idx } : null
    } else {
      const row = Math.min(r1, r2)
      if (row < 0 || row >= DB_N || c1 < 0 || c1 > DB_N) return null
      const idx = row * (DB_N + 1) + c1
      return vLines[idx] === null ? { isH: false, idx } : null
    }
  }

  // True if dot (r,c) has at least one empty adjacent line
  function hasEmptyAdj(r: number, c: number): boolean {
    const candidates: { isH: boolean; idx: number }[] = []
    if (r > 0)    candidates.push({ isH: false, idx: (r - 1) * (DB_N + 1) + c })
    if (r < DB_N) candidates.push({ isH: false, idx:  r      * (DB_N + 1) + c })
    if (c > 0)    candidates.push({ isH: true,  idx:  r      * DB_N + (c - 1) })
    if (c < DB_N) candidates.push({ isH: true,  idx:  r      * DB_N +  c      })
    return candidates.some(l => (l.isH ? hLines[l.idx] : vLines[l.idx]) === null)
  }

  function resetGame(newMode?: TTTMode, newNumPlayers?: 2 | 3) {
    aiCancelRef.current = true   // stop any in-flight AI chain
    aiPendingRef.current = false
    const np = newNumPlayers ?? numPlayers
    const nm = newMode ?? (np === 3 ? 'two-player' : mode)
    setMode(nm); setNumPlayers(np)
    setHLines(dbMkH()); setVLines(dbMkV()); setBBoxes(dbMkB())
    setCurrent('X'); setHasWon(false)
    selDotRef.current = null
    setSelDot(null); setDragPt(null)
  }

  function changePlayerCount(n: 2 | 3) { resetGame(n === 3 ? 'two-player' : mode, n) }

  // Commit a line as the current player, then chain AI if needed
  function commitLine(isH: boolean, idx: number) {
    sfxUnlock()
    const res  = dbApply(hLines, vLines, bBoxes, isH, idx, current)
    const next = res.extra ? current : nextTurn(current, numPlayers)
    const isGameOver = res.boxes.every(b => b !== null)
    setHLines(res.h); setVLines(res.v); setBBoxes(res.boxes); setCurrent(next)
    selDotRef.current = null
    setSelDot(null); setDragPt(null)

    if (isGameOver) {
      // Determine winner for sound — compare scores after this move
      const sX = res.boxes.filter(b => b === 'X').length
      const sO = res.boxes.filter(b => b === 'O').length
      const sY = res.boxes.filter(b => b === 'Y').length
      const maxS = Math.max(sX, sO, numPlayers === 3 ? sY : 0)
      const winners = (['X','O'] as Player[]).concat(numPlayers===3?['Y' as Player]:[]).filter(p => res.boxes.filter(b=>b===p).length===maxS)
      if (winners.length > 1) playSound('tie')
      else if (winners[0] === 'X') playSound(mode === 'computer' ? 'win' : 'win')
      else playSound(mode === 'computer' ? 'lose' : 'win')
    } else if (res.extra) {
      playSound('score')
    } else {
      playSound('turn')
    }

    if (mode === 'computer' && numPlayers === 2 && next === 'O') {
      aiPendingRef.current = true
      aiCancelRef.current = false   // fresh chain
      function runAI(ch: DBOwner[], cv: DBOwner[], cb: DBOwner[]) {
        if (aiCancelRef.current) { aiPendingRef.current = false; return }
        const move = dbAI(ch, cv, cb)
        if (!move) { aiPendingRef.current = false; setCurrent('X'); return }
        const r2   = dbApply(ch, cv, cb, move.isH, move.idx, 'O')
        const np: Player = r2.extra ? 'O' : 'X'
        setHLines(r2.h); setVLines(r2.v); setBBoxes(r2.boxes); setCurrent(np)
        const aiGameOver = r2.boxes.every(b => b !== null)
        if (aiGameOver) {
          const sX2 = r2.boxes.filter(b=>b==='X').length, sO2 = r2.boxes.filter(b=>b==='O').length
          if (sX2 > sO2) playSound('win')
          else if (sO2 > sX2) playSound('lose')
          else playSound('tie')
          aiPendingRef.current = false
        } else if (r2.extra) {
          playSound('score')
          setTimeout(() => runAI(r2.h, r2.v, r2.boxes), 420)
        } else {
          playSound('turn')
          aiPendingRef.current = false
        }
      }
      setTimeout(() => runAI(res.h, res.v, res.boxes), 500)
    }
  }

  const isHumanTurn = !gameOver && !aiPendingRef.current && (mode === 'two-player' || numPlayers === 3 || current === 'X')

  // Drag snap: nearest dot within 40% of cell width to the drag pointer
  const snapTarget = selDot && dragPt ? nearestDBDot(dragPt, DB_VB_CELL * 0.5) : null
  const snapIsValid = snapTarget && selDot && snapTarget !== selDot &&
    adjacentLine(selDot.r, selDot.c, snapTarget.r, snapTarget.c) !== null

  const boardSvg = (
    <svg
      ref={dbSvgRef}
      viewBox={`0 0 ${DB_VB} ${DB_VB}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', aspectRatio: '1 / 1', maxHeight: '100%', display: 'block', overflow: 'visible', touchAction: 'none' }}
      onPointerMove={e => {
        if (!selDotRef.current) return
        const pt = toDBSVGPt(e); if (pt) setDragPt({ x: pt.x, y: pt.y })
      }}
      onPointerUp={e => {
        const sd = selDotRef.current
        if (!sd) return
        const pt = toDBSVGPt(e)
        if (pt) {
          const dot = nearestDBDot(pt, DB_VB_CELL * 0.55)
          if (dot && !(dot.r === sd.r && dot.c === sd.c)) {
            const line = adjacentLine(sd.r, sd.c, dot.r, dot.c)
            if (line) { commitLine(line.isH, line.idx); return }
          }
        }
        selDotRef.current = null
        setSelDot(null); setDragPt(null)
      }}
      onPointerCancel={() => { selDotRef.current = null; setSelDot(null); setDragPt(null) }}
    >
      {bBoxes.map((owner, i) => {
        if (!owner) return null
        const r = Math.floor(i / DB_N), c = i % DB_N
        const { x, y } = dbDp(r, c)
        return <rect key={i} x={x} y={y} width={DB_VB_CELL} height={DB_VB_CELL} fill={P_COLOR[owner] + '2e'} />
      })}
      {hLines.map((owner, i) => {
        const row = Math.floor(i / DB_N), col = i % DB_N
        const p1 = dbDp(row, col), p2 = dbDp(row, col + 1)
        return <line key={`h${i}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={owner ? P_COLOR[owner] : '#ddd'} strokeWidth={owner ? DB_LW : DB_LW_E} strokeLinecap="round" />
      })}
      {vLines.map((owner, i) => {
        const row = Math.floor(i / (DB_N + 1)), col = i % (DB_N + 1)
        const p1 = dbDp(row, col), p2 = dbDp(row + 1, col)
        return <line key={`v${i}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={owner ? P_COLOR[owner] : '#ddd'} strokeWidth={owner ? DB_LW : DB_LW_E} strokeLinecap="round" />
      })}
      {/* Drag line from selDot to pointer (snapping to valid neighbor) */}
      {selDot && dragPt && (() => {
        const p1 = dbDp(selDot.r, selDot.c)
        const p2 = snapIsValid ? dbDp(snapTarget!.r, snapTarget!.c) : dragPt
        return (
          <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
            stroke={P_COLOR[current] + (snapIsValid ? 'cc' : '55')}
            strokeWidth={snapIsValid ? DB_LW : DB_LW_E * 1.5}
            strokeLinecap="round" strokeDasharray={snapIsValid ? 'none' : '8 4'} />
        )
      })()}
      {Array.from({ length: DB_N + 1 }, (_, r) =>
        Array.from({ length: DB_N + 1 }, (_, c) => {
          const { x, y } = dbDp(r, c)
          const isSel  = selDot?.r === r && selDot?.c === c
          const isSnap = snapIsValid && snapTarget?.r === r && snapTarget?.c === c
          const canDrag = isHumanTurn && hasEmptyAdj(r, c)
          const rr   = isSel || isSnap ? DB_DOT_SEL : DB_DOT_R
          const fill = isSel ? P_COLOR[current] : isSnap ? P_COLOR[current] + 'cc' : '#ccc'
          return (
            <g key={`d${r}-${c}`}>
              {/* Visual dot */}
              <circle cx={x} cy={y} r={rr} fill={fill}
                style={{ transition: 'r 0.1s, fill 0.1s', pointerEvents: 'none' }} />
              {/* Large invisible touch target */}
              <circle cx={x} cy={y} r={DB_HIT_R} fill="transparent"
                style={{ cursor: canDrag ? 'grab' : 'default' }}
                onPointerDown={e => {
                  if (!canDrag) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  selDotRef.current = { r, c }
                  setSelDot({ r, c })
                  const pt = toDBSVGPt(e); if (pt) setDragPt({ x: pt.x, y: pt.y })
                }}
              />
            </g>
          )
        })
      )}
    </svg>
  )

  const PLAYER_NAMES: Record<Player, string> = { X: mode === 'computer' ? 'You' : 'Blue', O: mode === 'computer' ? 'Me' : 'Red', Y: 'Yellow' }
  const scores3 = { X: scoreX, O: scoreO, Y: scoreY }
  const dbWinnerLabel = (() => {
    const maxScore = Math.max(...players.map(p => scores3[p]))
    const winners = players.filter(p => scores3[p] === maxScore)
    if (winners.length > 1) return "It's a draw! 🤝"
    return `${PLAYER_NAMES[winners[0]]} wins! 🎉`
  })()
  const dbWinnerColor = (() => {
    const maxScore = Math.max(...players.map(p => scores3[p]))
    const winners = players.filter(p => scores3[p] === maxScore)
    return winners.length > 1 ? '#888' : P_COLOR[winners[0]]
  })()
  const gameOverBanner = gameOver ? (
    <Ch4GameOverBanner
      winnerLabel={dbWinnerLabel}
      winnerColor={dbWinnerColor}
    />
  ) : null

  const controlBorder = '1.5px solid #ede8df'

  const dbRules = (
    <>
      <RuleSteps steps={[
        {
          svg: <DbDiagram
            hLines={[[0,0,'X'],[1,0,'X'],[0,1,'X']]}
            vLines={[[0,0,'X'],[1,0,'X'],[2,0,'O']]}
            boxes={[[0,0,'X']]}/>,
          label: 'Close 4 sides to score!',
        },
      ]}/>
      <p style={{ margin: '0 0 10px' }}>Players take turns drawing one line between two adjacent dots.</p>
      <p style={{ margin: '0 0 10px' }}>When you complete the <b>fourth side of a box</b>, you claim it and get another turn!</p>
      <p style={{ margin: 0 }}>The player with the <b>most boxes</b> when all lines are drawn wins. Blue goes first.</p>
    </>
  )

  const dbScores = numPlayers === 3 ? { X: scoreX, O: scoreO, Y: scoreY } : { X: scoreX, O: scoreO }

  if (isLandscape) {
    return (
      <>
        <div style={{ ...ch4CanvasStyle, flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
          <Ch4PlayAgainBtn show={gameOver} onClick={resetGame} />
          {/* Left column: turn + score + add/remove player */}
          <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'space-between', padding: '24px 20px' }}>
            {gameOver ? gameOverBanner : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <TurnIndicator current={current} gameOver={gameOver} mode={mode} P_COLOR={P_COLOR} isLandscape={true} scores={dbScores} players={players} />
              <PlayerCountControl count={numPlayers} onChange={changePlayerCount} isLandscape={true} />
            </div>}
            <ModeSelector mode={mode} onReset={resetGame} />
          </div>
          {/* Board — no overlay */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' }}>
            {boardSvg}
          </div>
        </div>
        <IntroText>{dbCaption}</IntroText>
        <SetDone celebrate={false} done={gameOver} />
        {rulesOpen && <Ch4RulesModal title="How to play Dots & Boxes" onClose={() => setRulesOpen(false)}>{dbRules}</Ch4RulesModal>}
      </>
    )
  }

  return (
    <>
      <div style={{ ...ch4CanvasStyle, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', justifyContent: 'center' }}>
          <Ch4PlayAgainBtn show={gameOver} onClick={resetGame} />
        {/* Top: banner when over, turn indicator + score otherwise */}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20, padding: '0 16px', height: 60, flexShrink: 0 }}>
          {gameOver ? gameOverBanner : <>
            <TurnIndicator current={current} gameOver={gameOver} mode={mode} P_COLOR={P_COLOR} isLandscape={false} scores={dbScores} players={players} />
            <PlayerCountControl count={numPlayers} onChange={changePlayerCount} isLandscape={false} />
          </>}
        </div>
        {/* Middle: board — no overlay */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' }}>
          {boardSvg}
        </div>
        {/* Bottom: always mode selector */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', height: 48, flexShrink: 0 }}>
          <ModeSelector mode={mode} onReset={resetGame} />
        </div>
      </div>
      <IntroText>{dbCaption}</IntroText>
      <SetDone celebrate={false} done={gameOver} />
      {rulesOpen && <Ch4RulesModal title="How to play Dots & Boxes" onClose={() => setRulesOpen(false)}>{dbRules}</Ch4RulesModal>}
    </>
  )
}

// ─── Shell ────────────────────────────────────────────────────────────────────
const CHAPTER1_PAGES = [Page1, Page23, Page4, Page56, Page7, Page8, Page9, Page10, Page11]
const CHAPTER2_PAGES = [Chapter2Page1, Chapter2Page3, ...Ch2DotSlots]
function Ch3Page1L2() { return <Ch3Page1 winTarget={CH3_WIN2} /> }
function Ch3Page2L2() { return <Ch3Page2 winTarget={C3P2_WIN2} /> }
function Ch3Page3L2() { return <Ch3Page3 winTarget={C3P3_WIN_DIST2} /> }
function Ch3Page1L3() { return <Ch3Page1 winTarget={CH3_WIN3} variant="hard" /> }
function Ch3Page2L3() { return <Ch3Page2 winTarget={C3P2_WIN3} variant="hard" /> }
function Ch3Page3L3() { return <Ch3Page3 winTarget={C3P3_WIN_DIST3} variant="hard" /> }

const CHAPTER3_PAGES = [Ch3Page1, Ch3Page1L2, Ch3Page1L3, Ch3Page2, Ch3Page2L2, Ch3Page2L3, Ch3Page3, Ch3Page3L2, Ch3Page3L3]
// ─── Chapter 4 / Page 3: Dot Triangles ────────────────────────────────────────

const DT_VB   = 300   // SVG viewBox size
const DT_PAD  = 20    // padding inside viewBox
const DT_N    = 13    // number of random dots

function dtEdgeKey(a: number, b: number) { return a < b ? `${a},${b}` : `${b},${a}` }

function dtSegCross(ax:number,ay:number,bx:number,by:number,cx:number,cy:number,dx:number,dy:number): boolean {
  const cr = (ox:number,oy:number,p1x:number,p1y:number,p2x:number,p2y:number) =>
    (p1x-ox)*(p2y-oy)-(p1y-oy)*(p2x-ox)
  const d1=cr(cx,cy,dx,dy,ax,ay), d2=cr(cx,cy,dx,dy,bx,by)
  const d3=cr(ax,ay,bx,by,cx,cy), d4=cr(ax,ay,bx,by,dx,dy)
  return ((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0))
}

/** Returns true if candidate point (px,py) is nearly collinear with any existing pair.
 *  "Nearly collinear" = triangle height < 18 viewBox units (prevents very slim triangles). */
function dtNearlyCollinear(px: number, py: number, existing: {x:number;y:number}[]): boolean {
  const N = existing.length
  for (let i = 0; i < N; i++) {
    for (let j = i+1; j < N; j++) {
      const ax = existing[j].x - existing[i].x
      const ay = existing[j].y - existing[i].y
      const base = Math.hypot(ax, ay)
      if (base < 1) continue
      // height = 2 * area / base
      const area = Math.abs(ax*(py - existing[i].y) - ay*(px - existing[i].x))
      if (area / base < 18) return true
    }
  }
  return false
}

function dtGenerateDots(): {x:number;y:number}[] {
  const avail = DT_VB - 2*DT_PAD
  const minD  = avail/Math.sqrt(DT_N)*0.72
  const dots: {x:number;y:number}[] = []
  let tries = 0
  while (dots.length < DT_N && tries < 6000) {
    tries++
    const x = DT_PAD + Math.random()*avail
    const y = DT_PAD + Math.random()*avail
    if (dots.every(d => Math.hypot(d.x-x,d.y-y) > minD) && !dtNearlyCollinear(x, y, dots))
      dots.push({x,y})
  }
  // Fallback 1: relax spacing to 55% of minD but keep anti-collinearity
  tries = 0
  const minDRelaxed = minD * 0.55
  while (dots.length < DT_N && tries < 8000) {
    tries++
    const x = DT_PAD + Math.random()*avail
    const y = DT_PAD + Math.random()*avail
    if (dots.every(d => Math.hypot(d.x-x,d.y-y) > minDRelaxed) && !dtNearlyCollinear(x, y, dots))
      dots.push({x,y})
  }
  // Fallback 2: anti-collinearity only (no spacing constraint)
  tries = 0
  while (dots.length < DT_N && tries < 8000) {
    tries++
    const x = DT_PAD + Math.random()*avail
    const y = DT_PAD + Math.random()*avail
    if (!dtNearlyCollinear(x, y, dots)) dots.push({x,y})
  }
  // Fallback 3: minimal spacing (40% of minD) — no collinearity check
  // With 13 dots in 260×260, this succeeds on the first try ~75%+ of the time
  const minMinD = minD * 0.4
  tries = 0
  while (dots.length < DT_N && tries < 10000) {
    tries++
    const x = DT_PAD + Math.random()*avail
    const y = DT_PAD + Math.random()*avail
    if (dots.every(d => Math.hypot(d.x-x,d.y-y) > minMinD)) dots.push({x,y})
  }
  // Fallback 4: truly unconstrained — absolute last resort (avoids infinite loop)
  while (dots.length < DT_N) {
    dots.push({ x: DT_PAD + Math.random()*avail, y: DT_PAD + Math.random()*avail })
  }
  return dots
}

/** Returns true if point (px,py) is strictly inside triangle (ax,ay)-(bx,by)-(cx,cy). */
function dtPtInTri(px:number,py:number, ax:number,ay:number, bx:number,by:number, cx:number,cy:number): boolean {
  const d1 = (px-bx)*(ay-by)-(ax-bx)*(py-by)
  const d2 = (px-cx)*(by-cy)-(bx-cx)*(py-cy)
  const d3 = (px-ax)*(cy-ay)-(cx-ax)*(py-ay)
  if (d1===0||d2===0||d3===0) return false  // on boundary → not strictly inside
  return (d1>0&&d2>0&&d3>0)||(d1<0&&d2<0&&d3<0)
}

/** Returns true if triangle indices t1 and t2 have overlapping interiors.
 *  Since edges cannot cross in this game, the only overlap case is one triangle
 *  strictly containing a vertex of the other. */
function dtTrianglesOverlap(
  t1: [number,number,number], t2: [number,number,number],
  dots: {x:number;y:number}[]
): boolean {
  const [a1,b1,c1] = t1.map(i=>dots[i])
  const [a2,b2,c2] = t2.map(i=>dots[i])
  for (const p of [a2,b2,c2])
    if (dtPtInTri(p.x,p.y, a1.x,a1.y, b1.x,b1.y, c1.x,c1.y)) return true
  for (const p of [a1,b1,c1])
    if (dtPtInTri(p.x,p.y, a2.x,a2.y, b2.x,b2.y, c2.x,c2.y)) return true
  return false
}

/** Returns true if any dot (other than the 3 vertices) lies strictly inside the triangle. */
function dtTriHasInteriorDot(
  tri: [number,number,number],
  dots: {x:number;y:number}[]
): boolean {
  const [ai,bi,ci] = tri
  const {x:ax,y:ay} = dots[ai], {x:bx,y:by} = dots[bi], {x:cx,y:cy} = dots[ci]
  for (let i = 0; i < dots.length; i++) {
    if (i === ai || i === bi || i === ci) continue
    if (dtPtInTri(dots[i].x, dots[i].y, ax, ay, bx, by, cx, cy)) return true
  }
  return false
}

/** Returns true if proposed edge (ai,bi) crosses any edge in drawnPairs (sharing an endpoint is OK). */
function dtEdgeCrossesDrawn(
  ai: number, bi: number,
  dots: {x:number;y:number}[],
  drawnPairs: [number,number][]
): boolean {
  return drawnPairs.some(([a,b]) =>
    a!==ai && a!==bi && b!==ai && b!==bi &&
    dtSegCross(dots[ai].x,dots[ai].y,dots[bi].x,dots[bi].y,
               dots[a].x, dots[a].y, dots[b].x, dots[b].y)
  )
}

function DotTrianglesPage() {
  const isLandscape = useIsLandscape()
  const [mode,    setMode]    = useState<TTTMode>('computer')
  const [numPlayers, setNumPlayers] = useState<2 | 3>(2)
  const [gameId,  setGameId]  = useState(0)
  const [usedEdges, setUsedEdges] = useState<Set<string>>(new Set())
  const [edgeOwner, setEdgeOwner] = useState<Record<string, Player>>({})
  const [claimed,   setClaimed]   = useState<Array<{tri:[number,number,number];player:Player}>>([])
  const [scoreX,  setScoreX]  = useState(0)
  const [scoreO,  setScoreO]  = useState(0)
  const [scoreY,  setScoreY]  = useState(0)
  const [current, setCurrent] = useState<Player>('X')
  const [gameOver,setGameOver]= useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [selDot,  setSelDot]  = useState<number|null>(null)
  const [dragPt,  setDragPt]  = useState<{x:number;y:number}|null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  // Ref mirrors selDot for pointer handlers — avoids stale-closure race on touch
  const selDotRef = useRef<number|null>(null)

  const dots = useMemo(() => dtGenerateDots(), [gameId])

  // Drawn edges as [a,b] pairs for crossing checks
  const drawnPairs = useMemo(
    () => Array.from(usedEdges).map(k => k.split(',').map(Number) as [number,number]),
    [usedEdges])

  // All edges that can still be legally drawn (not yet drawn, doesn't cross any drawn edge)
  const availEdges = useMemo(() => {
    const N = dots.length
    const avail: [number,number][] = []
    for (let i=0; i<N; i++) for (let j=i+1; j<N; j++) {
      if (usedEdges.has(dtEdgeKey(i,j))) continue
      if (!dtEdgeCrossesDrawn(i, j, dots, drawnPairs)) avail.push([i,j])
    }
    return avail
  }, [dots, usedEdges, drawnPairs])

  // Dots that can be dragged (have at least one available edge)
  const draggableDots = useMemo(() => {
    const s = new Set<number>()
    for (const [a,b] of availEdges) { s.add(a); s.add(b) }
    return s
  }, [availEdges])

  const P_COLOR: Record<Player, string> = { X: BLUE, O: RED, Y: YELLOW }
  const players = (numPlayers === 3 ? ['X', 'O', 'Y'] : ['X', 'O']) as Player[]

  function resetGame(m: TTTMode = mode, np: 2 | 3 = numPlayers) {
    const nm = np === 3 ? 'two-player' : m
    setMode(nm); setNumPlayers(np); setGameId(id => id+1)
    setUsedEdges(new Set()); setEdgeOwner({}); setClaimed([])
    setScoreX(0); setScoreO(0); setScoreY(0); setCurrent('X')
    setGameOver(false)
    selDotRef.current = null
    setSelDot(null); setDragPt(null)
  }

  function changePlayerCount(n: 2 | 3) { resetGame(n === 3 ? 'two-player' : mode, n) }

  function commitEdge(a: number, b: number, who: Player = current) {
    const key = dtEdgeKey(a,b)
    if (usedEdges.has(key)) return
    if (who === 'X') sfxUnlock()
    const newUsed = new Set([...usedEdges, key])
    const newOwner = { ...edgeOwner, [key]: who }
    // Triangles newly completed: find all c where (a,c) and (b,c) were already drawn
    // and the resulting triangle doesn't overlap any already-claimed triangle.
    const newTris: [number,number,number][] = []
    for (let c=0; c<dots.length; c++) {
      if (c===a || c===b) continue
      if (usedEdges.has(dtEdgeKey(a,c)) && usedEdges.has(dtEdgeKey(b,c))) {
        const tri = [a,b,c].sort((x,y)=>x-y) as [number,number,number]
        if (!claimed.some(cl => dtTrianglesOverlap(tri, cl.tri, dots)) &&
            !dtTriHasInteriorDot(tri, dots)) {
          newTris.push(tri)
        }
      }
    }
    const newClaimed = [...claimed, ...newTris.map(tri => ({ tri, player: who }))]
    const nx = scoreX + (who==='X' ? newTris.length : 0)
    const no = scoreO + (who==='O' ? newTris.length : 0)
    const ny = scoreY + (who==='Y' ? newTris.length : 0)
    setUsedEdges(newUsed); setEdgeOwner(newOwner); setClaimed(newClaimed)
    setScoreX(nx); setScoreO(no); setScoreY(ny)
    selDotRef.current = null
    setSelDot(null); setDragPt(null)
    // Recompute available edges after this addition to check game over
    const newDrawnPairs = [...drawnPairs, [a,b] as [number,number]]
    // Check if any edges can still be drawn after this move
    let hasAny = false
    const N = dots.length
    outer: for (let i=0; i<N && !hasAny; i++) for (let j=i+1; j<N && !hasAny; j++) {
      if (newUsed.has(dtEdgeKey(i,j))) continue
      if (!dtEdgeCrossesDrawn(i,j,dots,newDrawnPairs)) { hasAny=true; break outer }
    }
    if (!hasAny) {
      setGameOver(true)
      // Game over sound — compare final scores
      const maxS = Math.max(nx, no, numPlayers===3 ? ny : 0)
      const winPlayers = (['X','O'] as Player[]).concat(numPlayers===3?['Y' as Player]:[]).filter(p => (p==='X'?nx:p==='O'?no:ny)===maxS)
      if (winPlayers.length > 1) playSound('tie')
      else if (winPlayers[0]==='X') playSound(mode==='computer' ? 'win' : 'win')
      else playSound(mode==='computer' ? 'lose' : 'win')
    } else if (newTris.length > 0) {
      playSound('score')
      // same player goes again (scored a triangle)
    } else {
      playSound('turn')
      setCurrent(nextTurn(who, numPlayers))
    }
  }

  // Computer move — prefers edges that complete the most triangles
  useEffect(() => {
    if (mode !== 'computer' || numPlayers !== 2 || current !== 'O' || gameOver) return
    if (availEdges.length === 0) return
    const t = setTimeout(() => {
      let best = availEdges[0], bestN = -1
      for (const [a,b] of availEdges) {
        let n = 0
        for (let c=0; c<dots.length; c++) {
          if (c===a||c===b) continue
          if (usedEdges.has(dtEdgeKey(a,c)) && usedEdges.has(dtEdgeKey(b,c))) {
            const tri = [a,b,c].sort((x,y)=>x-y) as [number,number,number]
            if (!claimed.some(cl => dtTrianglesOverlap(tri, cl.tri, dots)) &&
                !dtTriHasInteriorDot(tri, dots)) n++
          }
        }
        if (n > bestN) { bestN = n; best = [a,b] }
      }
      commitEdge(best[0], best[1], 'O')
    }, 550)
    return () => clearTimeout(t)
  }, [mode, current, gameOver, usedEdges, availEdges])  // eslint-disable-line react-hooks/exhaustive-deps

  function toSVGPt(e: React.PointerEvent) {
    const svg = svgRef.current; if (!svg) return null
    const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY
    return p.matrixTransform(svg.getScreenCTM()!.inverse())
  }

  function nearestAvailDot(pt:{x:number;y:number}, from:number, thresh:number) {
    let best: number|null = null, bestD = thresh
    for (let i=0; i<dots.length; i++) {
      if (i===from) continue
      const k = dtEdgeKey(from,i)
      if (usedEdges.has(k)) continue
      if (dtEdgeCrossesDrawn(from, i, dots, drawnPairs)) continue
      const d = Math.hypot(dots[i].x-pt.x, dots[i].y-pt.y)
      if (d<bestD) { bestD=d; best=i }
    }
    return best
  }

  const isHumanTurn = !gameOver && (mode==='two-player' || numPlayers === 3 || current==='X')
  const snapDot = selDot!==null && dragPt ? nearestAvailDot(dragPt, selDot, 22) : null

  const svgBoard = (
    <svg ref={svgRef} viewBox={`0 0 ${DT_VB} ${DT_VB}`}
      style={{ width:'100%', aspectRatio:'1 / 1', maxHeight:'100%', display:'block', overflow:'visible', touchAction:'none' }}
      onPointerMove={e => {
        if (selDotRef.current === null) return
        const pt = toSVGPt(e); if (pt) setDragPt({x:pt.x,y:pt.y})
      }}
      onPointerUp={e => {
        const sd = selDotRef.current
        if (sd === null) return
        const pt = toSVGPt(e)
        if (pt && isHumanTurn) {
          const n = nearestAvailDot(pt, sd, 26)
          if (n!==null) { commitEdge(sd,n); return }
        }
        selDotRef.current = null
        setSelDot(null); setDragPt(null)
      }}
      onPointerCancel={() => { selDotRef.current = null; setSelDot(null); setDragPt(null) }}
    >
      {/* Claimed triangles */}
      {claimed.map(({tri:[a,b,c],player},i) => (
        <polygon key={i}
          points={`${dots[a].x},${dots[a].y} ${dots[b].x},${dots[b].y} ${dots[c].x},${dots[c].y}`}
          fill={P_COLOR[player]+'2e'} />
      ))}

      {/* Drawn edges */}
      {Object.entries(edgeOwner).map(([k, own]) => {
        const [a,b] = k.split(',').map(Number)
        return <line key={k} x1={dots[a].x} y1={dots[a].y} x2={dots[b].x} y2={dots[b].y}
          stroke={P_COLOR[own]} strokeWidth={3} strokeLinecap="round" />
      })}

      {/* Drag preview line */}
      {selDot!==null && dragPt && (() => {
        const p2 = snapDot!==null ? dots[snapDot] : dragPt
        const valid = snapDot!==null
        return <line x1={dots[selDot].x} y1={dots[selDot].y} x2={p2.x} y2={p2.y}
          stroke={P_COLOR[current]+(valid?'cc':'55')}
          strokeWidth={valid ? 3 : 1.8}
          strokeLinecap="round" strokeDasharray={valid?'none':'8 4'} />
      })()}

      {/* Dots */}
      {dots.map((d,i) => {
        const isSel  = selDot===i
        const isSnap = snapDot===i
        const canDrag = isHumanTurn && draggableDots.has(i)
        return (
          <g key={i}>
            {/* Visual dot */}
            <circle cx={d.x} cy={d.y}
              r={isSel||isSnap ? CH4_DOT_SEL : CH4_DOT_R}
              fill={isSel ? P_COLOR[current] : isSnap ? P_COLOR[current]+'cc' : '#ccc'}
              style={{ transition:'r 0.1s, fill 0.1s', pointerEvents: 'none' }} />
            {/* Large invisible touch target */}
            <circle cx={d.x} cy={d.y} r={DT_HIT_R} fill="transparent"
              style={{ cursor: canDrag?'grab':'default' }}
              onPointerDown={e => {
                if (!canDrag) return
                e.currentTarget.setPointerCapture(e.pointerId)
                selDotRef.current = i
                setSelDot(i)
                const pt = toSVGPt(e); if (pt) setDragPt({x:pt.x,y:pt.y})
              }}
            />
          </g>
        )
      })}
    </svg>
  )

  const dtScores = numPlayers === 3 ? { X: scoreX, O: scoreO, Y: scoreY } : { X: scoreX, O: scoreO }
  const DT_PLAYER_NAMES: Record<Player, string> = { X: mode === 'computer' ? 'You' : 'Blue', O: mode === 'computer' ? 'Me' : 'Red', Y: 'Yellow' }
  const dtWinnerLabel = (() => {
    const maxScore = Math.max(...players.map(p => dtScores[p as keyof typeof dtScores] ?? 0))
    const winners = players.filter(p => (dtScores[p as keyof typeof dtScores] ?? 0) === maxScore)
    if (winners.length > 1) return "It's a draw! 🤝"
    return `${DT_PLAYER_NAMES[winners[0]]} wins! 🎉`
  })()
  const dtWinnerColor = (() => {
    const maxScore = Math.max(...players.map(p => dtScores[p as keyof typeof dtScores] ?? 0))
    const winners = players.filter(p => (dtScores[p as keyof typeof dtScores] ?? 0) === maxScore)
    return winners.length > 1 ? '#888' : P_COLOR[winners[0]]
  })()
  const gameOverBanner = gameOver ? (
    <Ch4GameOverBanner
      winnerLabel={dtWinnerLabel}
      winnerColor={dtWinnerColor}
    />
  ) : null

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dtCaption = useMemo(() => ch4Caption('Dot Triangles', 'Connect dots to form triangles — lines can\'t cross!', () => setRulesOpen(true)), [])
  const dtRules = (
    <>
      <RuleSteps steps={[
        {
          svg: <DtDiagram
            edges={[[0,1,'X'],[0,4,'X'],[1,4,'O']]}
            tris={[[0,1,4,'X']]}/>,
          label: 'Close a triangle to score!',
        },
      ]}/>
      <p style={{ margin: '0 0 10px' }}>Players take turns drawing a line between any two dots. Lines <b>cannot cross</b> each other.</p>
      <p style={{ margin: '0 0 10px' }}>When your line <b>completes a triangle</b> (closes the third side), you score it and take another turn!</p>
      <p style={{ margin: 0 }}>Play ends when no valid lines remain. The player with the most triangles wins. Blue goes first.</p>
    </>
  )

  if (isLandscape) {
    return (
      <>
        <div style={{ ...ch4CanvasStyle, flex:1, display:'flex', flexDirection:'row', overflow:'hidden' }}>
          <Ch4PlayAgainBtn show={gameOver} onClick={resetGame} />
          <div style={{ flexShrink:0, display:'flex', flexDirection:'column', alignItems:'flex-start', justifyContent:'space-between', padding:'24px 20px' }}>
            {gameOver ? gameOverBanner : <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              <TurnIndicator current={current} gameOver={gameOver} mode={mode} P_COLOR={P_COLOR} isLandscape={true} scores={dtScores} players={players} />
              <PlayerCountControl count={numPlayers} onChange={changePlayerCount} isLandscape={true} />
            </div>}
            <ModeSelector mode={mode} onReset={resetGame} />
          </div>
          <div style={{ flex:1, minHeight:0, display:'flex', alignItems:'center', justifyContent:'center', padding:24, boxSizing:'border-box' }}>
            {svgBoard}
          </div>
        </div>
        <IntroText>{dtCaption}</IntroText>
        <SetDone celebrate={false} done={gameOver} />
        {rulesOpen && <Ch4RulesModal title="How to play Dot Triangles" onClose={() => setRulesOpen(false)}>{dtRules}</Ch4RulesModal>}
      </>
    )
  }

  return (
    <>
      <div style={{ ...ch4CanvasStyle, flex:1, display:'flex', flexDirection:'column', overflow:'hidden', justifyContent:'center' }}>
          <Ch4PlayAgainBtn show={gameOver} onClick={resetGame} />
        <div style={{ display:'flex', flexDirection:'row', alignItems:'center', justifyContent:'center', gap:20, padding:'0 16px', height:60, flexShrink:0 }}>
          {gameOver ? gameOverBanner : <>
            <TurnIndicator current={current} gameOver={gameOver} mode={mode} P_COLOR={P_COLOR} isLandscape={false} scores={dtScores} players={players} />
            <PlayerCountControl count={numPlayers} onChange={changePlayerCount} isLandscape={false} />
          </>}
        </div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:20, boxSizing:'border-box' }}>
          {svgBoard}
        </div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:'0 16px', height:48, flexShrink:0 }}>
          <ModeSelector mode={mode} onReset={resetGame} />
        </div>
      </div>
      <IntroText>{dtCaption}</IntroText>
      <SetDone celebrate={false} done={gameOver} />
      {rulesOpen && <Ch4RulesModal title="How to play Dot Triangles" onClose={() => setRulesOpen(false)}>{dtRules}</Ch4RulesModal>}
    </>
  )
}

// ─── Chapter 4 / Page 4: Rectangle Game ──────────────────────────────────────

const RG_N   = 5                          // NxN cells, (N+1)x(N+1) dots
const RG_PAD = 10                         // SVG viewBox padding
const RG_CELL = (100 - 2 * RG_PAD) / RG_N

function rgPos(r: number, c: number) {
  return { x: RG_PAD + c * RG_CELL, y: RG_PAD + r * RG_CELL }
}

function rgNearestDot(pt: { x: number; y: number }) {
  const c = Math.round((pt.x - RG_PAD) / RG_CELL)
  const r = Math.round((pt.y - RG_PAD) / RG_CELL)
  return { r: Math.max(0, Math.min(RG_N, r)), c: Math.max(0, Math.min(RG_N, c)) }
}

function rgRectSegs(r1: number, c1: number, r2: number, c2: number) {
  const h: string[] = [], v: string[] = []
  for (let c = c1; c < c2; c++) { h.push(`${r1},${c}`); h.push(`${r2},${c}`) }
  for (let r = r1; r < r2; r++) { v.push(`${r},${c1}`); v.push(`${r},${c2}`) }
  return { h, v }
}

function rgIsValid(r1: number, c1: number, r2: number, c2: number, hUsed: Set<string>, vUsed: Set<string>) {
  if (r1 >= r2 || c1 >= c2) return false
  const { h, v } = rgRectSegs(r1, c1, r2, c2)
  return h.every(s => !hUsed.has(s)) && v.every(s => !vUsed.has(s))
}

function rgAllValid(hUsed: Set<string>, vUsed: Set<string>): Array<[number, number, number, number]> {
  const moves: Array<[number, number, number, number]> = []
  for (let r1 = 0; r1 <= RG_N; r1++)
    for (let c1 = 0; c1 <= RG_N; c1++)
      for (let r2 = r1 + 1; r2 <= RG_N; r2++)
        for (let c2 = c1 + 1; c2 <= RG_N; c2++)
          if (rgIsValid(r1, c1, r2, c2, hUsed, vUsed))
            moves.push([r1, c1, r2, c2])
  return moves
}

function RectangleGamePage() {
  const isLandscape = useIsLandscape()
  const [mode,    setMode]    = useState<TTTMode>('computer')
  const [hUsed,   setHUsed]   = useState<Set<string>>(new Set())
  const [vUsed,   setVUsed]   = useState<Set<string>>(new Set())
  const [rects,   setRects]   = useState<Array<{ r1: number; c1: number; r2: number; c2: number; player: 'X' | 'O' }>>([])
  const [current, setCurrent] = useState<'X' | 'O'>('X')
  const [gameOver, setGameOver] = useState(false)
  const [winner,  setWinner]  = useState<'X' | 'O' | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [dragStart, setDragStart] = useState<{ r: number; c: number } | null>(null)
  const [dragCur,   setDragCur]   = useState<{ r: number; c: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const P_COLOR: Record<'X' | 'O', string> = { X: BLUE, O: RED }

  function commitRect(r1: number, c1: number, r2: number, c2: number, who: 'X' | 'O' = current) {
    if (!rgIsValid(r1, c1, r2, c2, hUsed, vUsed)) return
    if (who === 'X') sfxUnlock()
    const { h, v } = rgRectSegs(r1, c1, r2, c2)
    const newH = new Set(hUsed); h.forEach(s => newH.add(s))
    const newV = new Set(vUsed); v.forEach(s => newV.add(s))
    const newRects = [...rects, { r1, c1, r2, c2, player: who }]
    setHUsed(newH); setVUsed(newV); setRects(newRects)
    setDragStart(null); setDragCur(null)
    const next: 'X' | 'O' = who === 'X' ? 'O' : 'X'
    if (rgAllValid(newH, newV).length === 0) {
      setGameOver(true); setWinner(who)   // next player can't move → current wins
      playSound(who === 'X' ? (mode === 'computer' ? 'win' : 'win') : (mode === 'computer' ? 'lose' : 'win'))
    } else {
      setCurrent(next)
      playSound('turn')
    }
  }

  function resetGame(m: TTTMode = mode) {
    setMode(m); setHUsed(new Set()); setVUsed(new Set()); setRects([])
    setCurrent('X'); setGameOver(false); setWinner(null)
    setDragStart(null); setDragCur(null)
  }

  // Computer (O) move
  useEffect(() => {
    if (mode !== 'computer' || current !== 'O' || gameOver) return
    const moves = rgAllValid(hUsed, vUsed)
    if (moves.length === 0) { setGameOver(true); setWinner('X'); return }
    const t = setTimeout(() => {
      const pick = moves[Math.floor(Math.random() * moves.length)]
      commitRect(pick[0], pick[1], pick[2], pick[3], 'O')
    }, 550)
    return () => clearTimeout(t)
  }, [mode, current, gameOver, hUsed, vUsed])

  function toSVGPt(e: React.PointerEvent) {
    const svg = svgRef.current; if (!svg) return null
    const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY
    return p.matrixTransform(svg.getScreenCTM()!.inverse())
  }

  const isHumanTurn = !gameOver && (mode === 'two-player' || current === 'X')

  // Normalised preview rectangle
  const previewRect = dragStart && dragCur && !(dragStart.r === dragCur.r && dragStart.c === dragCur.c)
    ? { r1: Math.min(dragStart.r, dragCur.r), c1: Math.min(dragStart.c, dragCur.c),
        r2: Math.max(dragStart.r, dragCur.r), c2: Math.max(dragStart.c, dragCur.c) }
    : null
  const previewValid = previewRect
    ? rgIsValid(previewRect.r1, previewRect.c1, previewRect.r2, previewRect.c2, hUsed, vUsed)
    : false

  const svgBoard = (
    <svg ref={svgRef} viewBox="0 0 100 100"
      style={{ width: '100%', aspectRatio: '1 / 1', maxHeight: '100%', touchAction: 'none', overflow: 'visible' }}
      onPointerMove={e => {
        if (!dragStart) return
        const pt = toSVGPt(e); if (pt) setDragCur(rgNearestDot(pt))
      }}
      onPointerUp={e => {
        if (!dragStart || !isHumanTurn) { setDragStart(null); setDragCur(null); return }
        const pt = toSVGPt(e)
        if (pt) {
          const end = rgNearestDot(pt)
          if (end.r !== dragStart.r && end.c !== dragStart.c) {
            const r1 = Math.min(dragStart.r, end.r), c1 = Math.min(dragStart.c, end.c)
            const r2 = Math.max(dragStart.r, end.r), c2 = Math.max(dragStart.c, end.c)
            commitRect(r1, c1, r2, c2)
            return
          }
        }
        setDragStart(null); setDragCur(null)
      }}
      onPointerLeave={() => { setDragStart(null); setDragCur(null) }}
    >
      {/* Grid background lines */}
      {Array.from({ length: RG_N + 1 }, (_, r) =>
        Array.from({ length: RG_N }, (_, c) => {
          const p1 = rgPos(r, c), p2 = rgPos(r, c + 1)
          return <line key={`h${r},${c}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
            stroke="#ddd" strokeWidth={0.5} />
        })
      )}
      {Array.from({ length: RG_N }, (_, r) =>
        Array.from({ length: RG_N + 1 }, (_, c) => {
          const p1 = rgPos(r, c), p2 = rgPos(r + 1, c)
          return <line key={`v${r},${c}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
            stroke="#ddd" strokeWidth={0.5} />
        })
      )}

      {/* Drawn rectangles */}
      {rects.map((rect, i) => {
        const tl = rgPos(rect.r1, rect.c1), br = rgPos(rect.r2, rect.c2)
        return <rect key={i} x={tl.x} y={tl.y} width={br.x - tl.x} height={br.y - tl.y}
          fill="none" stroke={P_COLOR[rect.player]} strokeWidth={1} strokeLinejoin="round" />
      })}

      {/* Preview rectangle */}
      {previewRect && (() => {
        const tl = rgPos(previewRect.r1, previewRect.c1), br = rgPos(previewRect.r2, previewRect.c2)
        return <rect x={tl.x} y={tl.y} width={br.x - tl.x} height={br.y - tl.y}
          fill={previewValid ? P_COLOR[current] + '14' : 'none'}
          stroke={P_COLOR[current] + (previewValid ? 'cc' : '44')}
          strokeWidth={previewValid ? 1 : 0.5}
          strokeDasharray={previewValid ? undefined : '4 3'}
          strokeLinejoin="round" />
      })()}

      {/* Invisible hit-area dots for drag start */}
      {Array.from({ length: RG_N + 1 }, (_, r) =>
        Array.from({ length: RG_N + 1 }, (_, c) => {
          const { x, y } = rgPos(r, c)
          return <circle key={`d${r},${c}`} cx={x} cy={y}
            r={5} fill="transparent"
            style={{ cursor: isHumanTurn ? 'crosshair' : 'default' }}
            onPointerDown={e => {
              if (!isHumanTurn) return
              e.currentTarget.setPointerCapture(e.pointerId)
              setDragStart({ r, c }); setDragCur({ r, c })
            }}
          />
        })
      )}
    </svg>
  )

  const rgWinnerLabel = winner
    ? (mode === 'computer' ? (winner === 'X' ? 'You win! 🎉' : 'I win! 😄') : (winner === 'X' ? 'Blue wins! 🎉' : 'Red wins!'))
    : ''
  const gameOverBanner = gameOver && winner ? (
    <Ch4GameOverBanner
      winnerLabel={rgWinnerLabel}
      winnerColor={P_COLOR[winner]}
    />
  ) : null

  const modeSelector = <ModeSelector mode={mode} onReset={resetGame} />
  const turnIndicator = <TurnIndicator current={current} gameOver={gameOver} mode={mode} P_COLOR={P_COLOR} isLandscape={isLandscape} />
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rgCaption = useMemo(() => ch4Caption('Rectangle Game', 'Drag to draw a rectangle — the last player to place one wins!', () => setRulesOpen(true)), [])
  const rgRules = (
    <>
      <RuleSteps steps={[
        {
          svg: <RgDiagram />,
          label: 'Dot grid — drag between dots',
        },
        {
          svg: <RgDiagram draftRect={[0,0,1,2]}/>,
          label: 'Any two diagonal dots',
        },
        {
          svg: <RgDiagram
            rects={[[0,0,1,2,'X'],[1,0,2,1,'O']]}/>,
          label: 'Last valid move wins!',
        },
      ]}/>
      <p style={{ margin: '0 0 10px' }}>Players take turns drawing a rectangle by dragging from one dot to another (diagonal).</p>
      <p style={{ margin: '0 0 10px' }}>A rectangle is valid only if its edges <b>don't overlap</b> any previously drawn edges.</p>
      <p style={{ margin: 0 }}>The player who makes the <b>last valid move</b> wins. Blue goes first.</p>
    </>
  )

  if (isLandscape) {
    return (
      <>
        <div style={{ ...ch4CanvasStyle, flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
          <Ch4PlayAgainBtn show={gameOver} onClick={resetGame} />
          <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'space-between', padding: '24px 20px' }}>
            {gameOver ? gameOverBanner : turnIndicator}
            {modeSelector}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box' }}>
            {svgBoard}
          </div>
        </div>
        <IntroText>{rgCaption}</IntroText>
        <SetDone celebrate={false} done={gameOver} />
        {rulesOpen && <Ch4RulesModal title="How to play Rectangle Game" onClose={() => setRulesOpen(false)}>{rgRules}</Ch4RulesModal>}
      </>
    )
  }

  return (
    <>
      <div style={{ ...ch4CanvasStyle, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', justifyContent: 'center' }}>
          <Ch4PlayAgainBtn show={gameOver} onClick={resetGame} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', height: 60, flexShrink: 0 }}>
          {gameOver ? gameOverBanner : turnIndicator}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, boxSizing: 'border-box' }}>
          {svgBoard}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', height: 48, flexShrink: 0 }}>
          {modeSelector}
        </div>
      </div>
      <IntroText>{rgCaption}</IntroText>
      <SetDone celebrate={false} done={gameOver} />
      {rulesOpen && <Ch4RulesModal title="How to play Rectangle Game" onClose={() => setRulesOpen(false)}>{rgRules}</Ch4RulesModal>}
    </>
  )
}

// ─── Chapter 4 / Page 5: 鸡毛蒜皮 ────────────────────────────────────────────
const JMSP_ROWS  = 4
const JMSP_COLS  = 4
const JMSP_STEPS = 3
const JMSP_VB_PAD = 30
const JMSP_CELL   = 70
const JMSP_VB_W   = 2 * JMSP_VB_PAD + (JMSP_COLS - 1) * JMSP_CELL  // 270
const JMSP_VB_H   = 2 * JMSP_VB_PAD + (JMSP_ROWS - 1) * JMSP_CELL  // 270
const JMSP_PR     = 15  // piece radius

// Cross-shaped board: the 5 cells from the reference SVG form a plus sign.
// Valid nodes are the corners/intersections of those cells.
const JMSP_VALID = new Set<string>([
  '0,1','0,2',
  '1,0','1,1','1,2','1,3',
  '2,0','2,1','2,2','2,3',
  '3,1','3,2',
])
function jmspIsValid(r: number, c: number): boolean {
  return JMSP_VALID.has(`${r},${c}`)
}

// The 5 cells as (topLeftRow, topLeftCol) — each cell spans one JMSP_CELL square
const JMSP_CELLS = [
  {r:0, c:1},  // top
  {r:1, c:0},  // left
  {r:1, c:1},  // center
  {r:1, c:2},  // right
  {r:2, c:1},  // bottom
]

type JMSPPiece = { id: string; player: 'X' | 'O'; row: number; col: number }

const JMSP_INIT: JMSPPiece[] = [
  { id: 'x0', player: 'X', row: 1, col: 0 },
  { id: 'x1', player: 'X', row: 1, col: 1 },
  { id: 'x2', player: 'X', row: 2, col: 0 },
  { id: 'x3', player: 'X', row: 2, col: 1 },
  { id: 'o0', player: 'O', row: 1, col: 2 },
  { id: 'o1', player: 'O', row: 1, col: 3 },
  { id: 'o2', player: 'O', row: 2, col: 2 },
  { id: 'o3', player: 'O', row: 2, col: 3 },
]

function jmspAt(pieces: JMSPPiece[], r: number, c: number): JMSPPiece | null {
  return pieces.find(p => p.row === r && p.col === c) ?? null
}

// DFS: find all squares reachable in exactly JMSP_STEPS orthogonal steps.
// May pass through own pieces on intermediate steps; last step may be empty or enemy (not own).
function jmspDests(from: JMSPPiece, pieces: JMSPPiece[]): { row: number; col: number }[] {
  const out = new Set<string>()
  const vis = new Set([`${from.row},${from.col}`])
  const dirs = [[-1,0],[1,0],[0,-1],[0,1]] as const
  function dfs(r: number, c: number, left: number) {
    if (left === 0) { out.add(`${r},${c}`); return }
    for (const [dr, dc] of dirs) {
      const nr = r + dr, nc = c + dc
      if (!jmspIsValid(nr, nc)) continue
      const key = `${nr},${nc}`
      if (vis.has(key)) continue
      const occ = jmspAt(pieces, nr, nc)
      // Intermediate: any piece blocks passage (can only eat on the final step)
      if (left > 1 && occ) continue
      // Last step: can capture enemy, can't land on own piece
      if (left === 1 && occ && occ.player === from.player) continue
      vis.add(key); dfs(nr, nc, left - 1); vis.delete(key)
    }
  }
  dfs(from.row, from.col, JMSP_STEPS)
  return Array.from(out).map(k => { const [r,c] = k.split(',').map(Number); return {row:r,col:c} })
}

// Find one valid path from `from` to `to` in exactly JMSP_STEPS steps.
function jmspPath(from: JMSPPiece, to: {row:number;col:number}, pieces: JMSPPiece[]): {row:number;col:number}[] | null {
  let found: {row:number;col:number}[] | null = null
  const vis = new Set([`${from.row},${from.col}`])
  const dirs = [[-1,0],[1,0],[0,-1],[0,1]] as const
  function dfs(r: number, c: number, left: number, path: {row:number;col:number}[]) {
    if (found) return
    if (left === 0) { if (r === to.row && c === to.col) found = path.slice(); return }
    for (const [dr, dc] of dirs) {
      const nr = r + dr, nc = c + dc
      if (!jmspIsValid(nr, nc)) continue
      const key = `${nr},${nc}`
      if (vis.has(key)) continue
      const occ = jmspAt(pieces, nr, nc)
      if (left > 1 && occ) continue
      if (left === 1 && occ && occ.player === from.player) continue
      vis.add(key); dfs(nr, nc, left - 1, [...path, {row:nr,col:nc}]); vis.delete(key)
    }
  }
  dfs(from.row, from.col, JMSP_STEPS, [{row:from.row,col:from.col}])
  return found
}

function jmspAI(pieces: JMSPPiece[]): { id: string; to: {row:number;col:number} } | null {
  const mine = pieces.filter(p => p.player === 'O')
  const all: { id:string; to:{row:number;col:number}; isCapture:boolean }[] = []
  for (const p of mine) {
    for (const d of jmspDests(p, pieces))
      all.push({ id: p.id, to: d, isCapture: !!jmspAt(pieces, d.row, d.col) })
  }
  if (!all.length) return null
  const caps = all.filter(m => m.isCapture)
  const pool = caps.length ? caps : all
  return pool[Math.floor(Math.random() * pool.length)]
}

function JmspPage() {
  const isLandscape = useIsLandscape()
  const [mode, setMode]         = useState<TTTMode>('computer')
  const [pieces, setPieces]     = useState<JMSPPiece[]>(() => JMSP_INIT.map(p => ({...p})))
  const [current, setCurrent]   = useState<'X'|'O'>('X')
  const [selId, setSelId]       = useState<string|null>(null)
  // dragPath: cells visited so far including the starting cell [start, ...steps]
  const [dragPath, setDragPath] = useState<{row:number;col:number}[]>([])
  // animState: piece sliding along committed path
  const [animState, setAnimState] = useState<{pieceId:string; path:{row:number;col:number}[]; step:number}|null>(null)
  const [gameOver, setGameOver] = useState(false)
  const [winner, setWinner]     = useState<'X'|'O'|null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const svgRef    = useRef<SVGSVGElement>(null)
  const aiCancel  = useRef(false)
  // Refs mirror drag state for pointer handlers — avoids stale-closure race on touch
  const selIdRef    = useRef<string|null>(null)
  const selPieceRef = useRef<JMSPPiece|null>(null)
  const dragPathRef = useRef<{row:number;col:number}[]>([])
  useEffect(() => () => { aiCancel.current = true }, [])

  const P_COLOR: Record<Player, string> = { X: BLUE, O: RED, Y: YELLOW }

  function dotXY(r: number, c: number) {
    return { x: JMSP_VB_PAD + c * JMSP_CELL, y: JMSP_VB_PAD + r * JMSP_CELL }
  }
  function toSVGPt(e: React.PointerEvent): {x:number;y:number}|null {
    const svg = svgRef.current; if (!svg) return null
    const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY
    return p.matrixTransform(svg.getScreenCTM()!.inverse())
  }

  /** Nearest valid board node within snap radius. */
  function nearestCell(pt: {x:number;y:number}): {row:number;col:number}|null {
    let best: {row:number;col:number}|null = null
    let bestD = JMSP_CELL * 0.50
    for (const key of JMSP_VALID) {
      const [r, c] = key.split(',').map(Number)
      const {x,y} = dotXY(r,c)
      const d = Math.hypot(x - pt.x, y - pt.y)
      if (d < bestD) { bestD = d; best = {row:r, col:c} }
    }
    return best
  }

  /**
   * Update dragPath given the current pointer position.
   * - If pointer enters a cell already in the path → backtrack to that cell.
   * - If pointer enters an adjacent unvisited cell → extend by one step (if valid).
   * - Once path reaches JMSP_STEPS+1 cells, stop extending.
   */
  function updatePath(prev: {row:number;col:number}[], pt: {x:number;y:number}, piece: JMSPPiece): {row:number;col:number}[] {
    const cell = nearestCell(pt)
    if (!cell) return prev
    const {row:br, col:bc} = cell

    // Backtrack: pointer re-entered an earlier cell
    const existingIdx = prev.findIndex(p => p.row === br && p.col === bc)
    if (existingIdx >= 0) return prev.slice(0, existingIdx + 1)

    // Already at max steps
    if (prev.length >= JMSP_STEPS + 1) return prev

    // Must be adjacent to last cell
    const last = prev[prev.length - 1]
    if (Math.abs(br - last.row) + Math.abs(bc - last.col) !== 1) return prev

    // Occupancy: any piece blocks intermediate steps (only the final step can capture an enemy).
    const isLastStep = prev.length === JMSP_STEPS
    const occ = jmspAt(pieces, br, bc)
    if (!isLastStep && occ) return prev                                 // any piece blocks intermediate
    if (isLastStep && occ && occ.player === piece.player) return prev  // can't land on own

    return [...prev, {row:br, col:bc}]
  }

  /** Commit a move: update pieces, switch turn, check win. Does NOT clear selection. */
  function commitMove(pieceId: string, to: {row:number;col:number}) {
    const captured = pieces.some(p => p.row === to.row && p.col === to.col)
    const newPieces = pieces
      .filter(p => !(p.row === to.row && p.col === to.col))
      .map(p => p.id === pieceId ? {...p, row: to.row, col: to.col} : p)
    const next: 'X'|'O' = current === 'X' ? 'O' : 'X'
    const opCount = newPieces.filter(p => p.player === next).length
    setPieces(newPieces)
    if (opCount === 0) {
      setGameOver(true); setWinner(current)
      playSound(current === 'X' ? (mode === 'computer' ? 'win' : 'win') : (mode === 'computer' ? 'lose' : 'win'))
    } else {
      if (captured) playSound('score')
      else playSound('turn')
      setCurrent(next)
    }
  }

  function doMove(pieceId: string, to: {row:number;col:number}) {
    commitMove(pieceId, to)
    selIdRef.current = null; selPieceRef.current = null; dragPathRef.current = []
    setSelId(null); setDragPath([])
  }

  /** Start the slide animation for a completed drag path. */
  function startAnim(pieceId: string, path: {row:number;col:number}[]) {
    selIdRef.current = null; selPieceRef.current = null; dragPathRef.current = []
    setSelId(null); setDragPath([])
    setAnimState({ pieceId, path, step: 0 })
  }

  function cancelSel() {
    selIdRef.current = null; selPieceRef.current = null; dragPathRef.current = []
    setSelId(null); setDragPath([])
  }

  function resetGame(m: TTTMode = mode) {
    aiCancel.current = true
    selIdRef.current = null; selPieceRef.current = null; dragPathRef.current = []
    setMode(m); setPieces(JMSP_INIT.map(p => ({...p})))
    setCurrent('X'); setSelId(null); setDragPath([])
    setAnimState(null); setGameOver(false); setWinner(null)
  }

  // Advance animation one step at a time, commit on final step
  useEffect(() => {
    if (!animState) return
    if (animState.step >= animState.path.length - 1) {
      const dest = animState.path[animState.path.length - 1]
      commitMove(animState.pieceId, dest)
      setAnimState(null)
      return
    }
    const t = setTimeout(() => {
      setAnimState(prev => prev ? {...prev, step: prev.step + 1} : null)
    }, 200)
    return () => clearTimeout(t)
  }, [animState]) // eslint-disable-line react-hooks/exhaustive-deps

  // Computer (O) move — uses jmspPath to animate along the path
  useEffect(() => {
    if (mode !== 'computer' || current !== 'O' || gameOver || animState) return
    aiCancel.current = false
    const t = setTimeout(() => {
      if (aiCancel.current) return
      const mv = jmspAI(pieces)
      if (!mv) return
      const piece = pieces.find(p => p.id === mv.id)!
      const path = jmspPath(piece, mv.to, pieces)
      if (path) startAnim(mv.id, path)
      else doMove(mv.id, mv.to)
    }, 600)
    return () => clearTimeout(t)
  }, [mode, current, gameOver, animState, pieces]) // eslint-disable-line react-hooks/exhaustive-deps

  const isHumanTurn = !gameOver && !animState && (mode === 'two-player' || current === 'X')
  const selPiece    = selId ? (pieces.find(p => p.id === selId) ?? null) : null
  // Path is "complete" when exactly JMSP_STEPS steps have been drawn
  const pathComplete = dragPath.length === JMSP_STEPS + 1

  const svgBoard = (
    <svg ref={svgRef} viewBox={`0 0 ${JMSP_VB_W} ${JMSP_VB_H}`}
      style={{ width:'100%', aspectRatio:'1 / 1', maxHeight:'100%', display:'block', touchAction:'none', overflow:'visible' }}
      onPointerMove={e => {
        if (!selIdRef.current || !selPieceRef.current) return
        const pt = toSVGPt(e); if (!pt) return
        const newPath = updatePath(dragPathRef.current, pt, selPieceRef.current)
        dragPathRef.current = newPath
        setDragPath(newPath)
      }}
      onPointerUp={() => {
        const id = selIdRef.current; const path = dragPathRef.current
        if (!id) return
        if (path.length === JMSP_STEPS + 1) {
          startAnim(id, path)
        } else {
          cancelSel()
        }
      }}
      onPointerCancel={cancelSel}
    >
      {/* Cross-shaped grid: five square cells matching the reference SVG */}
      {JMSP_CELLS.map(({r, c}) => {
        const {x, y} = dotXY(r, c)
        return <rect key={`cell${r}${c}`} x={x} y={y} width={JMSP_CELL} height={JMSP_CELL}
          fill="none" stroke="#ddd" strokeWidth={1.5} />
      })}

      {/* Drawn path so far */}
      {dragPath.length > 1 && dragPath.slice(0,-1).map(({row:r,col:c},i) => {
        const nxt = dragPath[i+1]
        const {x:x1,y:y1}=dotXY(r,c), {x:x2,y:y2}=dotXY(nxt.row,nxt.col)
        return <line key={`dp${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
          stroke={pathComplete ? P_COLOR[current] : P_COLOR[current]+'aa'}
          strokeWidth={pathComplete ? 5 : 3.5} strokeLinecap="round" />
      })}

      {/* Empty node dots (valid cross nodes only) */}
      {Array.from(JMSP_VALID).map(key => {
        const [r, c] = key.split(',').map(Number)
        if (jmspAt(pieces,r,c)) return null
        const {x,y} = dotXY(r,c)
        return <circle key={`dot${r}${c}`} cx={x} cy={y} r={4} fill="#ccc" style={{pointerEvents:'none'}} />
      })}

      {/* Pieces */}
      {pieces.map(p => {
        const isAnimThis = animState?.pieceId === p.id
        const dispPos = isAnimThis
          ? dotXY(animState!.path[animState!.step].row, animState!.path[animState!.step].col)
          : dotXY(p.row, p.col)
        const {x, y} = dispPos
        const isSel  = p.id===selId
        const canSel = isHumanTurn && p.player===current && !selId
        return (
          <circle key={p.id} cx={x} cy={y} r={isSel ? JMSP_PR+3 : JMSP_PR}
            fill={P_COLOR[p.player]}
            stroke={isSel ? '#fff' : 'none'} strokeWidth={isSel ? 2.5 : 0}
            style={{
              cursor: canSel ? 'grab' : 'default',
              transition: isAnimThis ? 'cx 0.18s ease, cy 0.18s ease' : 'r 0.1s',
            }}
            onPointerDown={e => {
              if (!canSel) return
              e.currentTarget.setPointerCapture(e.pointerId)
              sfxUnlock()
              const initPath = [{row:p.row, col:p.col}]
              selIdRef.current = p.id
              selPieceRef.current = p
              dragPathRef.current = initPath
              setSelId(p.id)
              setDragPath(initPath)
            }}
          />
        )
      })}

    </svg>
  )

  const winnerLabel = winner
    ? (mode==='computer' ? (winner==='X'?'You win! 🎉':'I win! 😄') : (winner==='X'?'Blue wins! 🎉':'Red wins!'))
    : ''
  const gameOverBanner = (gameOver && winner) ? (
    <Ch4GameOverBanner
      winnerLabel={winnerLabel}
      winnerColor={winner === 'X' ? '#3b82f6' : '#ef4444'}
    />
  ) : null

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const jmspCaption = useMemo(() => ch4Caption('鸡毛蒜皮', 'Move 3 steps — capture all the enemy pieces to win!', () => setRulesOpen(true)), [])
  const jmspRules = (
    <>
      <p style={{margin:'0 0 10px'}}>Each player starts with <b>4 pieces</b>. Blue goes first.</p>
      <p style={{margin:'0 0 10px'}}>On your turn, select a piece and drag to draw a path of exactly <b>3 steps</b> along the grid. You may pass through your own pieces. You may not revisit a square in the same move.</p>
      <p style={{margin:'0 0 10px'}}>You may only land on an occupied square on the <b>last step</b> — this <b>captures</b> that enemy piece!</p>
      <p style={{margin:0}}>Eat all of your opponent's pieces to <b>win</b>.</p>
    </>
  )

  if (isLandscape) {
    return (
      <>
        <div style={{...ch4CanvasStyle, flex:1, display:'flex', flexDirection:'row', overflow:'hidden'}}>
          <Ch4PlayAgainBtn show={gameOver} onClick={resetGame} />
          <div style={{flexShrink:0, display:'flex', flexDirection:'column', alignItems:'flex-start', justifyContent:'space-between', padding:'24px 20px'}}>
            {gameOver ? gameOverBanner : <TurnIndicator current={current} gameOver={gameOver} mode={mode} P_COLOR={P_COLOR} isLandscape={true} />}
            <ModeSelector mode={mode} onReset={resetGame} />
          </div>
          <div style={{flex:1, minHeight:0, display:'flex', alignItems:'center', justifyContent:'center', padding:24, boxSizing:'border-box'}}>
            {svgBoard}
          </div>
        </div>
        <IntroText>{jmspCaption}</IntroText>
        <SetDone celebrate={false} done={gameOver} />
        {rulesOpen && <Ch4RulesModal title="How to play 鸡毛蒜皮" onClose={() => setRulesOpen(false)}>{jmspRules}</Ch4RulesModal>}
      </>
    )
  }
  return (
    <>
      <div style={{...ch4CanvasStyle, flex:1, display:'flex', flexDirection:'column', overflow:'hidden', justifyContent:'center'}}>
          <Ch4PlayAgainBtn show={gameOver} onClick={resetGame} />
        <div style={{display:'flex', alignItems:'center', justifyContent:'center', padding:'0 16px', height:60, flexShrink:0}}>
          {gameOver ? gameOverBanner : <TurnIndicator current={current} gameOver={gameOver} mode={mode} P_COLOR={P_COLOR} isLandscape={false} />}
        </div>
        <div style={{display:'flex', alignItems:'center', justifyContent:'center', padding:20, boxSizing:'border-box'}}>
          {svgBoard}
        </div>
        <div style={{display:'flex', alignItems:'center', justifyContent:'center', padding:'0 16px', height:48, flexShrink:0}}>
          <ModeSelector mode={mode} onReset={resetGame} />
        </div>
      </div>
      <IntroText>{jmspCaption}</IntroText>
      <SetDone celebrate={false} done={gameOver} />
      {rulesOpen && <Ch4RulesModal title="How to play 鸡毛蒜皮" onClose={() => setRulesOpen(false)}>{jmspRules}</Ch4RulesModal>}
    </>
  )
}

// ─── Chapter 4 / Page 4: Cat and Mouse ────────────────────────────────────────

// Pentagon + center graph (6 nodes)
const CM_NODES = [
  { x: 50, y: 18 },  // 0 top          → 🐱 cat starts
  { x: 78, y: 38 },  // 1 upper-right
  { x: 67, y: 69 },  // 2 lower-right
  { x: 33, y: 69 },  // 3 lower-left
  { x: 22, y: 38 },  // 4 upper-left
  { x: 50, y: 49 },  // 5 center       → 🐭 mouse starts
]

const CM_EDGES: [number, number][] = [
  [0,1],[1,2],[2,3],[3,4],[4,0],  // pentagon
  [5,0],[5,2],[5,3],              // inner connections from center
]

const CM_ADJ: number[][] = Array.from({ length: CM_NODES.length }, (_, i) =>
  CM_EDGES.flatMap(([a,b]) => a===i ? [b] : b===i ? [a] : [])
)

function cmDist(from: number, to: number): number {
  if (from === to) return 0
  const q = [from], vis = new Set([from]), d = new Map([[from, 0]])
  while (q.length) {
    const cur = q.shift()!; const dc = d.get(cur)!
    for (const nxt of CM_ADJ[cur]) {
      if (nxt === to) return dc + 1
      if (!vis.has(nxt)) { vis.add(nxt); d.set(nxt, dc + 1); q.push(nxt) }
    }
  }
  return 99
}

// Minimax: returns estimated turns-to-catch (cat minimises, mouse maximises)
function cmMinimax(cat: number, mouse: number, catTurn: boolean, depth: number, memo: Map<string,number>): number {
  if (cat === mouse) return 0
  if (depth <= 0) return cmDist(cat, mouse)
  const key = `${cat},${mouse},${catTurn?1:0},${depth}`
  const cached = memo.get(key); if (cached !== undefined) return cached
  let result: number
  if (catTurn) {
    result = Infinity
    for (const nxt of CM_ADJ[cat]) {
      const v = nxt === mouse ? 0 : 1 + cmMinimax(nxt, mouse, false, depth - 1, memo)
      if (v < result) result = v
    }
  } else {
    result = 0; let hasMoves = false
    for (const nxt of CM_ADJ[mouse]) {
      if (nxt === cat) continue
      hasMoves = true
      const v = 1 + cmMinimax(cat, nxt, true, depth - 1, memo)
      if (v > result) result = v
    }
    if (!hasMoves) result = 0
  }
  memo.set(key, result); return result
}

function cmBestCatMove(cat: number, mouse: number): number {
  if (CM_ADJ[cat].includes(mouse)) return mouse
  const memo = new Map<string,number>()
  let bestMove = CM_ADJ[cat][0], bestVal = Infinity
  for (const nxt of CM_ADJ[cat]) {
    if (nxt === mouse) return nxt
    const val = cmMinimax(nxt, mouse, false, 14, memo)
    if (val < bestVal) { bestVal = val; bestMove = nxt }
  }
  return bestMove
}

function cmBestMouseMove(cat: number, mouse: number): number {
  const valid = CM_ADJ[mouse].filter(n => n !== cat)
  if (valid.length === 0) return CM_ADJ[mouse][0]
  const memo = new Map<string,number>()
  let bestMove = valid[0], bestVal = -Infinity
  for (const nxt of valid) {
    const val = cmMinimax(cat, nxt, true, 14, memo)
    if (val > bestVal) { bestVal = val; bestMove = nxt }
  }
  return bestMove
}

function CatMousePage() {
  const isLandscape = useIsLandscape()
  const [mode,          setMode]          = useState<TTTMode>('computer')
  const [computerIsCat, setComputerIsCat] = useState(true)
  const [catPos,        setCatPos]        = useState(0)
  const [mousePos,      setMousePos]      = useState(5)
  const [turn,          setTurn]          = useState<'mouse'|'cat'>('mouse')
  const [gameOver,      setGameOver]      = useState(false)
  const [rulesOpen,     setRulesOpen]     = useState(false)
  const [dragFrom,      setDragFrom]      = useState<number|null>(null)
  const [dragPt,        setDragPt]        = useState<{x:number;y:number}|null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  // Ref mirrors dragFrom for pointer handlers — avoids stale-closure race on touch
  const dragFromRef = useRef<number|null>(null)

  const CAT_COLOR   = RED
  const MOUSE_COLOR = BLUE

  function resetGame(m: TTTMode = mode) {
    const newComputerIsCat = Math.random() < 0.5
    setMode(m); setComputerIsCat(newComputerIsCat)
    setCatPos(0); setMousePos(5)
    setTurn('mouse'); setGameOver(false)
    dragFromRef.current = null
    setDragFrom(null); setDragPt(null)
  }

  // Computer makes its move
  useEffect(() => {
    if (mode !== 'computer' || gameOver) return
    const isComputerTurn = (computerIsCat && turn === 'cat') || (!computerIsCat && turn === 'mouse')
    if (!isComputerTurn) return
    const t = setTimeout(() => {
      if (computerIsCat) {
        const next = cmBestCatMove(catPos, mousePos)
        setCatPos(next)
        if (next === mousePos) { setGameOver(true); playSound('lose') }
        else { playSound('turn'); setTurn('mouse') }
      } else {
        const next = cmBestMouseMove(catPos, mousePos)
        setMousePos(next)
        if (next === catPos) { setGameOver(true); playSound('lose'); return }
        playSound('turn'); setTurn('cat')
      }
    }, 500)
    return () => clearTimeout(t)
  }, [mode, turn, gameOver, catPos, mousePos, computerIsCat])

  function doMove(to: number) {
    if (gameOver) return
    sfxUnlock()
    const myPos = turn === 'mouse' ? mousePos : catPos
    if (!CM_ADJ[myPos].includes(to)) return
    if (turn === 'mouse') {
      setMousePos(to)
      if (to === catPos) {
        setGameOver(true)
        // Mouse ran into cat — cat wins
        const catWins = true
        playSound(mode === 'computer' ? (computerIsCat ? 'lose' : 'win') : 'win')
        return
      }
      playSound('turn')
      setTurn('cat')
    } else {
      setCatPos(to)
      if (to === mousePos) {
        setGameOver(true)
        // Cat caught mouse — cat wins
        playSound(mode === 'computer' ? (computerIsCat ? 'lose' : 'win') : 'win')
        return
      }
      playSound('turn')
      setTurn('mouse')
    }
  }

  function toSVGPt(e: React.PointerEvent) {
    const svg = svgRef.current; if (!svg) return null
    const p = svg.createSVGPoint()
    p.x = e.clientX; p.y = e.clientY
    return p.matrixTransform(svg.getScreenCTM()!.inverse())
  }

  function nearestValid(pt: {x:number;y:number}, candidates: number[], thresh = 16) {
    let best: number|null = null, bestD = thresh
    for (const i of candidates) {
      const d = Math.hypot(CM_NODES[i].x - pt.x, CM_NODES[i].y - pt.y)
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }

  // Which piece the human controls this turn
  const activePiece: 'mouse'|'cat' = mode === 'two-player' ? turn : (computerIsCat ? 'mouse' : 'cat')
  const isHumanTurn = !gameOver && (mode === 'two-player' || turn === activePiece)
  const humanPos    = activePiece === 'mouse' ? mousePos : catPos
  const validMoves  = isHumanTurn ? CM_ADJ[humanPos] : []
  const NR = 5 // node radius in SVG viewBox units (smaller)

  // ── SVG board ──────────────────────────────────────────────────────────────
  const svgBoard = (
    <svg
      ref={svgRef}
      viewBox="0 0 100 100"
      style={{ width: '100%', aspectRatio: '1 / 1', maxHeight: '100%', touchAction: 'none', overflow: 'visible' }}
      onPointerMove={e => {
        if (dragFromRef.current === null) return
        const pt = toSVGPt(e); if (pt) setDragPt({ x: pt.x, y: pt.y })
      }}
      onPointerUp={e => {
        if (dragFromRef.current === null) return
        const pt = toSVGPt(e)
        if (pt && isHumanTurn) {
          const target = nearestValid(pt, validMoves)
          if (target !== null) doMove(target)
        }
        dragFromRef.current = null
        setDragFrom(null); setDragPt(null)
      }}
      onPointerCancel={() => { dragFromRef.current = null; setDragFrom(null); setDragPt(null) }}
    >
      {/* Edges */}
      {CM_EDGES.map(([a, b], i) => (
        <line key={i}
          x1={CM_NODES[a].x} y1={CM_NODES[a].y}
          x2={CM_NODES[b].x} y2={CM_NODES[b].y}
          stroke="#ddd" strokeWidth={0.5} strokeLinecap="round"
        />
      ))}

      {/* Empty nodes — plain, no valid-move highlighting */}
      {CM_NODES.map((n, i) => {
        if (i === catPos || i === mousePos) return null
        const isTarget = validMoves.includes(i)
        return (
          <circle key={i} cx={n.x} cy={n.y} r={2}
            fill="#ccc"
            style={{ cursor: isTarget ? 'pointer' : 'default' }}
            onClick={() => { if (isTarget && isHumanTurn && dragFrom === null) doMove(i) }}
          />
        )
      })}

      {/* Drag line */}
      {dragFrom !== null && dragPt && (
        <line
          x1={CM_NODES[dragFrom].x} y1={CM_NODES[dragFrom].y}
          x2={dragPt.x} y2={dragPt.y}
          stroke={turn === 'mouse' ? MOUSE_COLOR : CAT_COLOR} strokeWidth={1} strokeLinecap="round" opacity={0.75}
        />
      )}

      {/* Pieces: mouse first so cat renders on top */}
      {[
        { id: 'mouse', pos: mousePos, color: MOUSE_COLOR },
        { id: 'cat',   pos: catPos,   color: CAT_COLOR   },
      ].map(({ id, pos, color }) => {
        const isDragging = dragFrom === pos
        const n = isDragging && dragPt ? dragPt : CM_NODES[pos]
        const canDrag = isHumanTurn && id === activePiece
        return (
          <g key={id} transform={`translate(${n.x},${n.y})`}
             style={{ cursor: canDrag ? 'grab' : 'default' }}
             onPointerDown={e => {
               if (!canDrag) return
               e.currentTarget.setPointerCapture(e.pointerId)
               dragFromRef.current = pos
               setDragFrom(pos)
               const pt = toSVGPt(e); if (pt) setDragPt({ x: pt.x, y: pt.y })
             }}>
            <circle r={NR + 1} fill={color} />
          </g>
        )
      })}
    </svg>
  )

  // ── Game-over banner ──────────────────────────────────────────────────────
  const cmWinnerLabel = mode === 'computer'
    ? (computerIsCat ? 'I win! 😄' : 'You win! 🎉')
    : 'Cop wins! 🎉'
  const gameOverBanner = gameOver ? (
    <Ch4GameOverBanner
      winnerLabel={cmWinnerLabel}
      winnerColor={CAT_COLOR}
    />
  ) : null

  const CM_P_COLOR: Record<'X'|'O', string> = { X: MOUSE_COLOR, O: CAT_COLOR }
  const CM_ICONS: Record<'X'|'O', React.ReactNode> = {
    X: <LucideX size={14} strokeWidth={2.5} color="#fff" />,
    O: <LucideCircle size={13} strokeWidth={2.5} color="#fff" />,
  }
  const CM_LABELS: Record<'X'|'O', string> = { X: 'Robber', O: 'Cop' }
  const modeSelector = <ModeSelector mode={mode} onReset={resetGame} />
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cmCaption = useMemo(() => ch4Caption('Cops vs Robbers', 'The cop chases the robber — catch it to win!', () => setRulesOpen(true)), [])
  const cmRules = (
    <>
      <RuleSteps steps={[
        {
          svg: <CmDiagram virus={1} cell={5} simple/>,
          label: 'Move one step per turn',
        },
      ]}/>
      <p style={{ margin: '0 0 10px' }}>The <b>robber</b> (×) moves first, then the <b>cop</b> (○) moves — alternating each turn.</p>
      <p style={{ margin: '0 0 10px' }}>Each turn, drag your piece one step along a connected edge.</p>
      <p style={{ margin: '0 0 10px' }}>The cop wins by landing on the <b>same node</b> as the robber.</p>
      <p style={{ margin: 0 }}>In computer mode you're randomly assigned to play the robber or the cop.</p>
    </>
  )

  if (isLandscape) {
    return (
      <>
        <div style={{ ...ch4CanvasStyle, flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
          <Ch4PlayAgainBtn show={gameOver} onClick={resetGame} />
          <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'space-between', padding: '24px 20px' }}>
            {gameOver ? gameOverBanner : <TurnIndicator current={turn === 'mouse' ? 'X' : 'O'} gameOver={gameOver} mode={mode} P_COLOR={CM_P_COLOR} isLandscape={true} icons={CM_ICONS} labels={CM_LABELS} />}
            {modeSelector}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box' }}>
            {svgBoard}
          </div>
        </div>
        <IntroText>{cmCaption}</IntroText>
        <SetDone celebrate={false} done={gameOver} />
        {rulesOpen && <Ch4RulesModal title="How to play Cops vs Robbers" onClose={() => setRulesOpen(false)}>{cmRules}</Ch4RulesModal>}
      </>
    )
  }

  return (
    <>
      <div style={{ ...ch4CanvasStyle, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', justifyContent: 'center' }}>
          <Ch4PlayAgainBtn show={gameOver} onClick={resetGame} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', height: 60, flexShrink: 0 }}>
          {gameOver ? gameOverBanner : <TurnIndicator current={turn === 'mouse' ? 'X' : 'O'} gameOver={gameOver} mode={mode} P_COLOR={CM_P_COLOR} isLandscape={false} icons={CM_ICONS} labels={CM_LABELS} />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, boxSizing: 'border-box' }}>
          {svgBoard}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', height: 48, flexShrink: 0 }}>
          {modeSelector}
        </div>
      </div>
      <IntroText>{cmCaption}</IntroText>
      <SetDone celebrate={false} done={gameOver} />
      {rulesOpen && <Ch4RulesModal title="How to play Cops vs Robbers" onClose={() => setRulesOpen(false)}>{cmRules}</Ch4RulesModal>}
    </>
  )
}

const CHAPTER4_PAGES: React.ComponentType[] = [TicTacToePage, DotsAndBoxesPage, DotTrianglesPage, CatMousePage, JmspPage]

// ─── Chapter 5 ───────────────────────────────────────────────────────────────

// Shared layout constants
const CS_CELL  = 48   // SVG units per cell
const CS_PAD   = 20   // viewBox padding
const CS_DOT_R = 15   // dot radius in p3 (6×6) viewBox units
const CS_VB6   = 2 * CS_PAD + 6 * CS_CELL  // p3 viewBox size (328) — dot-size reference

// Color palettes
const CS4_COLORS = [BLUE, RED, YELLOW, '#50C878']                            // 4 colors (pages 1 & 2)
const CS6_COLORS = [BLUE, RED, YELLOW, '#50C878', '#AF7AC5', '#FF8C42']      // 6 colors (page 3)

// ── Page 1: Two independent 2×2 boxes, each missing 1 dot ────────────────────
// Colors: CS4_COLORS = [BLUE(0), RED(1), YELLOW(2), GREEN(3)]
// Box A: blue(0,0), [empty→RED](0,1), YELLOW(1,0), GREEN(1,1)
// Box B: blue(0,0), RED(0,1), [empty→YELLOW](1,0), GREEN(1,1)
const CS1_GIVEN_A: (number | null)[][] = [[0, null], [2, 3]]
const CS1_GIVEN_B: (number | null)[][] = [[0, 1],    [null, 3]]
const CS1_BOX_GAP = 16                                      // gap between the two 2×2 boxes (SVG units)
const CS1_BOX_VB  = 2 * CS_CELL + 2 * CS_PAD               // compact viewBox per box: 136 SVG units

// ── Page 2: 4×4 board, 4 colors ───────────────────────────────────────────────
// Solution: every row, col, and 2×2 box has each of 0-3 exactly once.
const CS4_SOL: number[][] = [
  [0, 1, 2, 3],
  [2, 3, 0, 1],
  [1, 0, 3, 2],
  [3, 2, 1, 0],
]
const CS4_PUZZLE: (number | null)[][] = [
  [0,    null, 2,    null],
  [null, 3,    null, 1   ],
  [1,    null, 3,    null],
  [null, 2,    null, 0   ],
]

// ── Page 3: 6×6 board, 6 colors ───────────────────────────────────────────────
// Solution: every row, col, and 2×3 box has each of 0-5 exactly once.
const CS6_SOL: number[][] = [
  [0, 1, 2, 3, 4, 5],
  [3, 4, 5, 0, 1, 2],
  [1, 0, 3, 2, 5, 4],
  [2, 5, 4, 1, 0, 3],
  [4, 2, 0, 5, 3, 1],
  [5, 3, 1, 4, 2, 0],
]
const CS6_PUZZLE: (number | null)[][] = [
  [0,    null, 2,    null, null, 5   ],
  [null, 4,    5,    0,    null, null],
  [1,    null, 3,    null, null, 4   ],
  [null, 5,    null, null, 0,    3   ],
  [4,    null, null, 5,    null, 1   ],
  [5,    3,    null, null, 2,    0   ],
]

interface CSCfg {
  size: number
  colors: string[]
  boxH: number          // rows per box region
  boxW: number          // cols per box region
  solution: number[][]
  puzzle: (number | null)[][]
  caption: React.ReactNode
  trayOrder?: number[]  // display order indices for tray; defaults to [0,1,...,n-1]
}

/** True if board[r][c] duplicates a peer in its row, column, or box. */
function csConflict(board: (number | null)[][], r: number, c: number,
                    size: number, boxH: number, boxW: number): boolean {
  const v = board[r][c]
  if (v === null) return false
  for (let i = 0; i < size; i++) {
    if (i !== c && board[r][i] === v) return true
    if (i !== r && board[i][c] === v) return true
  }
  const br = Math.floor(r / boxH) * boxH
  const bc = Math.floor(c / boxW) * boxW
  for (let dr = 0; dr < boxH; dr++)
    for (let dc = 0; dc < boxW; dc++) {
      const rr = br + dr, cc = bc + dc
      if ((rr !== r || cc !== c) && board[rr][cc] === v) return true
    }
  return false
}

function ColorSudokuPage({ cfg }: { cfg: CSCfg }) {
  const isLandscape = useIsLandscape()

  const { size, colors, boxH, boxW, solution, puzzle, caption, trayOrder } = cfg
  // All pages use the same CS_VB6 viewBox so grid cells are identical in physical size to p3
  const vb = CS_VB6
  const gridPad = Math.round((CS_VB6 - size * CS_CELL) / 2)   // centers the grid inside the fixed viewBox
  const dotR = CS_DOT_R   // constant — same physical dot size on all pages

  const [board, setBoard] = useState<(number | null)[][]>(() => puzzle.map(row => [...row]))
  const resetBoard = () => setBoard(puzzle.map(row => [...row]))

  // Drag-from-palette state
  const [dragColorIdx, setDragColorIdx] = useState<number | null>(null)
  const [dragPt,       setDragPt]       = useState<{ x: number; y: number } | null>(null)
  const [hoverCell,    setHoverCell]    = useState<{ r: number; c: number } | null>(null)
  // errorFlash: position + unique id so re-dropping always re-triggers the animation
  const [errorFlash,   setErrorFlash]   = useState<{ x: number; y: number; id: number } | null>(null)
  // flyDot: dot flying from palette to board cell on valid drop
  const [flyDot, setFlyDot] = useState<{
    colorIdx: number; id: number;
    fromX: number; fromY: number; toX: number; toY: number;
    cell: { r: number; c: number };
  } | null>(null)
  // lastPlaced: the most recently user-placed cell (gets the ✕ when conflicting)
  const [lastPlaced, setLastPlaced] = useState<{ r: number; c: number } | null>(null)
  const svgRef     = useRef<SVGSVGElement>(null)
  // boardSqRef: the square <div> that wraps the SVG — used to measure rendered px size
  const boardSqRef = useRef<HTMLDivElement>(null)
  const [boardPx, setBoardPx] = useState(0)

  useEffect(() => {
    const el = boardSqRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setBoardPx(Math.min(width, height))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Caption is set via IntroText (rendered in JSX) so it respects PageActiveCtx.

  const isFixed = (r: number, c: number) => puzzle[r][c] !== null

  // misplacedConflict: true when the last-placed dot is still in conflict
  const misplacedConflict = lastPlaced !== null &&
    board[lastPlaced.r]?.[lastPlaced.c] !== null &&
    csConflict(board, lastPlaced.r, lastPlaced.c, size, boxH, boxW)

  // Screen position of the misplaced cell for the HTML X overlay
  const misplacedScreenPos: { x: number; y: number } | null = (() => {
    if (!misplacedConflict || !boardSqRef.current || boardPx === 0) return null
    const rect = boardSqRef.current.getBoundingClientRect()
    const scale = boardPx / CS_VB6
    return {
      x: rect.left + (gridPad + lastPlaced!.c * CS_CELL + CS_CELL / 2) * scale,
      y: rect.top  + (gridPad + lastPlaced!.r * CS_CELL + CS_CELL / 2) * scale,
    }
  })()
  const dotR_px = boardPx > 0 ? CS_DOT_R * boardPx / CS_VB6 : 20

  // Remaining count: how many of each color still need to be placed.
  // In an N×N sudoku with N colors each appears N times; for a 2×2 single-box
  // with 4 colors each appears once.  Formula: size²/colors.length per color.
  const totalPerColor = Math.round((size * size) / colors.length)
  const remaining = colors.map((_, i) => totalPerColor - board.flat().filter(v => v === i).length)

  // Convert client coords → SVG viewBox coords
  function toSvgCoords(cx: number, cy: number): { x: number; y: number } | null {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: (cx - rect.left) * (vb / rect.width),
      y: (cy - rect.top)  * (vb / rect.height),
    }
  }

  function cellAt(svgX: number, svgY: number): { r: number; c: number } | null {
    const c = Math.floor((svgX - gridPad) / CS_CELL)
    const r = Math.floor((svgY - gridPad) / CS_CELL)
    return (r >= 0 && r < size && c >= 0 && c < size) ? { r, c } : null
  }

  // Global pointer tracking while a palette dot is being dragged
  useEffect(() => {
    if (dragColorIdx === null) return
    const onMove = (e: PointerEvent) => {
      setDragPt({ x: e.clientX, y: e.clientY })
      const sc = toSvgCoords(e.clientX, e.clientY)
      setHoverCell(sc ? cellAt(sc.x, sc.y) : null)
    }
    const onUp = (e: PointerEvent) => {
      const sc = toSvgCoords(e.clientX, e.clientY)
      const cell = sc ? cellAt(sc.x, sc.y) : null
      const valid = cell !== null && !isFixed(cell.r, cell.c) && board[cell.r][cell.c] === null
      if (valid) {
        const next = board.map(row => [...row])
        next[cell!.r][cell!.c] = dragColorIdx
        setBoard(next)
        setLastPlaced({ r: cell!.r, c: cell!.c })
        // Compute cell center in screen coords for fly animation
        const boardEl = boardSqRef.current
        if (boardEl) {
          const boardRect = boardEl.getBoundingClientRect()
          const cellCx = gridPad + cell!.c * CS_CELL + CS_CELL / 2
          const cellCy = gridPad + cell!.r * CS_CELL + CS_CELL / 2
          const toX = boardRect.left + cellCx * (boardRect.width  / vb)
          const toY = boardRect.top  + cellCy * (boardRect.height / vb)
          setFlyDot(prev => ({
            colorIdx: dragColorIdx!, id: (prev?.id ?? 0) + 1,
            fromX: e.clientX, fromY: e.clientY,
            toX, toY, cell: cell!,
          }))
        }
      } else {
        setErrorFlash(prev => ({ x: e.clientX, y: e.clientY, id: (prev?.id ?? 0) + 1 }))
      }
      setDragColorIdx(null)
      setDragPt(null)
      setHoverCell(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragColorIdx, board]) // eslint-disable-line react-hooks/exhaustive-deps

  const svgBoard = (
    <svg ref={svgRef} viewBox={`0 0 ${vb} ${vb}`}
      style={{ width: '100%', aspectRatio: '1 / 1', maxHeight: '100%', display: 'block', touchAction: 'none' }}
    >
      {/* Box-border lines (thicker) and inner cell lines (thinner) */}
      {Array.from({ length: size + 1 }, (_, i) => (
        <line key={`h${i}`}
          x1={gridPad} y1={gridPad + i * CS_CELL}
          x2={gridPad + size * CS_CELL} y2={gridPad + i * CS_CELL}
          stroke={i % boxH === 0 ? '#ccc' : '#e8e8e8'}
          strokeWidth={i % boxH === 0 ? 1.5 : 1} />
      ))}
      {Array.from({ length: size + 1 }, (_, i) => (
        <line key={`v${i}`}
          x1={gridPad + i * CS_CELL} y1={gridPad}
          x2={gridPad + i * CS_CELL} y2={gridPad + size * CS_CELL}
          stroke={i % boxW === 0 ? '#ccc' : '#e8e8e8'}
          strokeWidth={i % boxW === 0 ? 1.5 : 1} />
      ))}

      {/* Cells */}
      {Array.from({ length: size }, (_, r) =>
        Array.from({ length: size }, (_, c) => {
          const cx       = gridPad + c * CS_CELL + CS_CELL / 2
          const cy       = gridPad + r * CS_CELL + CS_CELL / 2
          const val      = board[r][c]
          const fixed    = isFixed(r, c)
          const isMisplacedHere = misplacedConflict && lastPlaced?.r === r && lastPlaced?.c === c
          const isHover  = hoverCell?.r === r && hoverCell?.c === c && !fixed && val === null
          // Hide board dot while it's flying in
          const isFlying = flyDot?.cell.r === r && flyDot?.cell.c === c
          return (
            <g key={`${r}${c}`} style={{ cursor: fixed ? 'default' : 'crosshair' }}>
              {isHover && (
                <rect x={gridPad + c * CS_CELL + 2} y={gridPad + r * CS_CELL + 2}
                  width={CS_CELL - 4} height={CS_CELL - 4}
                  fill={`${colors[dragColorIdx!]}30`} rx={5} />
              )}
              {val !== null && !isFlying ? (
                <circle cx={cx} cy={cy} r={dotR} fill={colors[val]}
                  style={{ filter: isMisplacedHere ? 'drop-shadow(0 0 6px rgba(255,80,130,0.95))' : 'none' }} />
              ) : isHover ? (
                <circle cx={cx} cy={cy} r={dotR} fill={colors[dragColorIdx!]} opacity={0.45} />
              ) : null}
            </g>
          )
        })
      )}
    </svg>
  )

  // PD: drag-visual diameter (ghost, fly, error flash) — board-matched scale
  const PD = boardPx > 0 ? Math.max(20, Math.round(2 * CS_DOT_R * boardPx / CS_VB6)) : 44

  // Tray sizing constants
  const trayPad = 14
  const trayGap = 12
  const trayMargin = 10
  const TRAY_PD = PD  // matches board dot diameter exactly
  const trayFontSize = Math.round(TRAY_PD * 0.40)

  // Ghost dot that follows the pointer while dragging
  const ghostDot = dragColorIdx !== null && dragPt && (
    <div style={{
      position: 'fixed',
      left: dragPt.x - TRAY_PD / 2,
      top:  dragPt.y - TRAY_PD / 2,
      width: TRAY_PD, height: TRAY_PD, borderRadius: '50%',
      background: colors[dragColorIdx],
      pointerEvents: 'none',
      opacity: 0.85,
      border: '2px solid rgba(255,255,255,0.75)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.22)',
      zIndex: 9999,
    }} />
  )

  // Error flash: a red dot that pops and fades at the invalid drop location
  const errorFlashEl = errorFlash && (
    <div key={errorFlash.id} style={{
      position: 'fixed',
      left: errorFlash.x - TRAY_PD / 2,
      top:  errorFlash.y - TRAY_PD / 2,
      width: TRAY_PD, height: TRAY_PD, borderRadius: '50%',
      pointerEvents: 'none',
      zIndex: 9999,
      background: '#e53935',
      border: '2px solid rgba(255,255,255,0.75)',
      animation: 'csErrorPop 0.45s ease-out forwards',
    }} />
  )

  // Fly dot: animates from palette drop point to board cell center on valid placement
  const flyDeltaX = flyDot ? flyDot.toX - flyDot.fromX : 0
  const flyDeltaY = flyDot ? flyDot.toY - flyDot.fromY : 0
  const flyDotEl = flyDot && (
    <>
      <style>{`@keyframes csFly_${flyDot.id} {
        0%   { transform: translate(0,0); }
        100% { transform: translate(${flyDeltaX}px,${flyDeltaY}px); }
      }`}</style>
      <div key={flyDot.id} style={{
        position: 'fixed',
        left: flyDot.fromX - TRAY_PD / 2, top: flyDot.fromY - TRAY_PD / 2,
        width: TRAY_PD, height: TRAY_PD, borderRadius: '50%',
        background: colors[flyDot.colorIdx],
        border: '2px solid rgba(255,255,255,0.75)',
        animation: `csFly_${flyDot.id} 0.28s ease-out forwards`,
        pointerEvents: 'none', zIndex: 9998,
      }} onAnimationEnd={() => setFlyDot(null)} />
    </>
  )

  // Tray panel: fixed slots for every color (filled circle if remaining > 0, solid outline if 0)
  const trayDot = (color: string, colorIdx: number) => {
    const count = remaining[colorIdx]
    const isEmpty = count <= 0
    return (
      <div key={colorIdx}
        style={{
          position: 'relative', flexShrink: 0,
          touchAction: 'none',
          cursor: isEmpty ? 'default' : 'grab',
          width: TRAY_PD, height: TRAY_PD, borderRadius: '50%',
          background: isEmpty ? 'transparent' : color,
          border: isEmpty ? `2px solid ${color}` : 'none',
          opacity: dragColorIdx === colorIdx ? 0.35 : 1,
          transition: 'opacity 0.12s',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: isEmpty ? 'none' : undefined,
        }}
        onPointerDown={isEmpty ? undefined : e => {
          e.preventDefault()
          setDragColorIdx(colorIdx)
          setDragPt({ x: e.clientX, y: e.clientY })
        }}
      >
        {!isEmpty && (
          <span style={{
            fontSize: trayFontSize, fontWeight: 900, color: '#fff',
            lineHeight: 1, pointerEvents: 'none', userSelect: 'none',
            textShadow: '0 1px 2px rgba(0,0,0,0.2)',
          }}>{count}</span>
        )}
      </div>
    )
  }

  const palettePanel = (axis: 'column' | 'row') => {
    const isCol = axis === 'column'
    const trayStyle: React.CSSProperties = {
      background: '#fef9f0', flexShrink: 0, padding: trayPad,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      margin: trayMargin, borderRadius: 16,
      ...(isCol ? { alignSelf: 'stretch' } : {}),
    }
    const order = trayOrder ?? colors.map((_, i) => i)
    return (
      <div style={{ ...trayStyle, flexDirection: axis, gap: trayGap }}>
        {order.map(colorIdx => trayDot(colors[colorIdx], colorIdx))}
      </div>
    )
  }

  // LucideX overlay: tappable X on the misplaced dot, rendered as fixed HTML so it's pixel-perfect
  const misplacedXOverlay = misplacedConflict && misplacedScreenPos && !flyDot && (
    <div
      style={{
        position: 'fixed',
        left: misplacedScreenPos.x - dotR_px,
        top:  misplacedScreenPos.y - dotR_px,
        width: dotR_px * 2, height: dotR_px * 2,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'auto', cursor: 'pointer',
        zIndex: 9990,
      }}
      onClick={() => {
        const next = board.map(row => [...row])
        next[lastPlaced!.r][lastPlaced!.c] = null
        setBoard(next)
        setLastPlaced(null)
      }}
    >
      <LucideX size={Math.round(dotR_px * 1.1)} strokeWidth={2.5} color="rgba(255,255,255,0.85)" />
    </div>
  )

  const fixedOverlays = (
    <>
      <style>{`@keyframes csErrorPop {
        0%   { opacity: .9; transform: scale(1.1); }
        60%  { opacity: .7; transform: scale(0.85); }
        100% { opacity: 0;  transform: scale(0.5); }
      }`}</style>
      {ghostDot}
      {errorFlashEl}
      {flyDotEl}
      {misplacedXOverlay}
    </>
  )

  // Win detection (SetDone renders null but sets the app-level done flag)
  const isSolved = board.every((row, r) => row.every((v, c) => v === solution[r][c]))

  if (isLandscape) {
    return (
      <>
        <div style={{ ...ch4CanvasStyle, flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
          <Ch4PlayAgainBtn show={true} onClick={resetBoard} />
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div ref={boardSqRef} style={{ height: '100%', aspectRatio: '1 / 1', maxWidth: '100%' }}>
              {svgBoard}
            </div>
          </div>
          {palettePanel('column')}
        </div>
        <IntroText>{caption}</IntroText>
        {fixedOverlays}
        <SetDone done={isSolved} />
      </>
    )
  }

  return (
    <>
      <div style={{ ...ch4CanvasStyle, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', justifyContent: 'center' }}>
        <Ch4PlayAgainBtn show={true} onClick={resetBoard} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div ref={boardSqRef} style={{ width: '100%', aspectRatio: '1 / 1' }}>
            {svgBoard}
          </div>
        </div>
        {palettePanel('row')}
      </div>
      <IntroText>{caption}</IntroText>
      {fixedOverlays}
      <SetDone done={isSolved} />
    </>
  )
}

// ── Per-difficulty wrappers ───────────────────────────────────────────────────

const CS4_CFG: CSCfg = {
  size: 4, colors: CS4_COLORS, boxH: 2, boxW: 2,
  solution: CS4_SOL, puzzle: CS4_PUZZLE,
  trayOrder: [1, 2, 3, 0],   // RED, YELLOW, GREEN, BLUE
  caption: <><b>Color Sudoku:</b> Fill the 4×4 grid so each row, column &amp; 2×2 box has all 4 colors!</>,
}
const CS6_CFG: CSCfg = {
  size: 6, colors: CS6_COLORS, boxH: 2, boxW: 3,
  solution: CS6_SOL, puzzle: CS6_PUZZLE,
  trayOrder: [1, 2, 3, 0, 4, 5],   // RED, YELLOW, GREEN, BLUE, PURPLE, ORANGE
  caption: <><b>Color Sudoku:</b> Fill the 6×6 grid so each row, column &amp; 2×3 box has all 6 colors!</>,
}

// ── CS1Page: two independent 2×2 boxes, drag-to-fill with shared tray ─────────
function CS1Page() {
  const isLandscape = useIsLandscape()
  const colors = CS4_COLORS
  // Display tray in order: RED(1), YELLOW(2), GREEN(3), BLUE(0)
  const trayOrder = [1, 2, 3, 0]

  const [boardA, setBoardA] = useState<(number | null)[][]>(() => CS1_GIVEN_A.map(r => [...r]))
  const [boardB, setBoardB] = useState<(number | null)[][]>(() => CS1_GIVEN_B.map(r => [...r]))

  const resetBoards = () => {
    setBoardA(CS1_GIVEN_A.map(r => [...r]))
    setBoardB(CS1_GIVEN_B.map(r => [...r]))
  }

  // Drag-from-palette state
  const [dragColorIdx, setDragColorIdx] = useState<number | null>(null)
  const [dragPt,       setDragPt]       = useState<{ x: number; y: number } | null>(null)
  const [hoverCell,    setHoverCell]    = useState<{ box: 'A' | 'B'; r: number; c: number } | null>(null)
  const [errorFlash,   setErrorFlash]   = useState<{ x: number; y: number; id: number } | null>(null)
  const [flyDot,       setFlyDot]       = useState<{
    colorIdx: number; id: number;
    fromX: number; fromY: number; toX: number; toY: number;
    box: 'A' | 'B'; r: number; c: number;
  } | null>(null)

  const svgRef      = useRef<SVGSVGElement>(null)
  const boardDivRef = useRef<HTMLDivElement>(null)
  const [boardDivW, setBoardDivW] = useState(0)
  const [boardDivH, setBoardDivH] = useState(0)

  useEffect(() => {
    const el = boardDivRef.current; if (!el) return
    const ro = new ResizeObserver(([e]) => {
      setBoardDivW(e.contentRect.width)
      setBoardDivH(e.contentRect.height)
    })
    ro.observe(el); return () => ro.disconnect()
  }, [])

  // SVG viewBox dimensions depend on orientation
  // Portrait:  CS1_BOX_VB wide × (2*CS1_BOX_VB + CS1_BOX_GAP) tall — boxes stacked vertically
  // Landscape: (2*CS1_BOX_VB + CS1_BOX_GAP) wide × CS1_BOX_VB tall — boxes side by side
  const VW = isLandscape ? (2 * CS1_BOX_VB + CS1_BOX_GAP) : CS1_BOX_VB
  const VH = isLandscape ? CS1_BOX_VB : (2 * CS1_BOX_VB + CS1_BOX_GAP)

  // Box B offset in SVG coords
  const B_OX = isLandscape ? CS1_BOX_VB + CS1_BOX_GAP : 0
  const B_OY = isLandscape ? 0 : CS1_BOX_VB + CS1_BOX_GAP

  // dotR_px: scale using CS1_BOX_VB as the reference dimension
  // Portrait: boardDivW maps to CS1_BOX_VB; landscape: boardDivH maps to CS1_BOX_VB
  const boardPx = isLandscape ? boardDivH : boardDivW
  const dotR_px = boardPx > 0 ? CS_DOT_R * boardPx / CS1_BOX_VB : 20
  const TRAY_PD = Math.max(20, Math.round(2 * dotR_px))
  const trayPad = 14; const trayGap = 12; const trayMargin = 10
  const trayFontSize = Math.round(TRAY_PD * 0.40)

  // Each color appears once per box × 2 boxes = 2 total needed
  const remaining = colors.map((_, i) =>
    2 - boardA.flat().filter(v => v === i).length - boardB.flat().filter(v => v === i).length
  )
  const bothSolved = boardA.flat().every(v => v !== null) && boardB.flat().every(v => v !== null)

  // Convert client coords → SVG viewBox coords
  function toSvgXY(cx: number, cy: number) {
    const svg = svgRef.current; if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return { x: (cx - rect.left) * (VW / rect.width), y: (cy - rect.top) * (VH / rect.height) }
  }

  function hitCell(svgX: number, svgY: number): { box: 'A' | 'B'; r: number; c: number; empty: boolean } | null {
    const boxes: ['A' | 'B', number, number][] = [['A', 0, 0], ['B', B_OX, B_OY]]
    for (const [box, ox, oy] of boxes) {
      const lx = svgX - ox - CS_PAD
      const ly = svgY - oy - CS_PAD
      const c = Math.floor(lx / CS_CELL)
      const r = Math.floor(ly / CS_CELL)
      if (r >= 0 && r < 2 && c >= 0 && c < 2) {
        const board = box === 'A' ? boardA : boardB
        const given = box === 'A' ? CS1_GIVEN_A : CS1_GIVEN_B
        return { box, r, c, empty: board[r][c] === null && given[r][c] === null }
      }
    }
    return null
  }

  useEffect(() => {
    if (dragColorIdx === null) return
    const onMove = (e: PointerEvent) => {
      setDragPt({ x: e.clientX, y: e.clientY })
      const sc = toSvgXY(e.clientX, e.clientY)
      const hit = sc ? hitCell(sc.x, sc.y) : null
      setHoverCell(hit?.empty ? { box: hit.box, r: hit.r, c: hit.c } : null)
    }
    const onUp = (e: PointerEvent) => {
      const sc = toSvgXY(e.clientX, e.clientY)
      const hit = sc ? hitCell(sc.x, sc.y) : null
      if (hit?.empty) {
        if (hit.box === 'A') setBoardA(prev => { const n = prev.map(r => [...r]); n[hit.r][hit.c] = dragColorIdx; return n })
        else                  setBoardB(prev => { const n = prev.map(r => [...r]); n[hit.r][hit.c] = dragColorIdx; return n })
        const el = boardDivRef.current
        if (el) {
          const rect = el.getBoundingClientRect()
          const ox = hit.box === 'A' ? 0 : B_OX
          const oy = hit.box === 'A' ? 0 : B_OY
          const cellCxSvg = ox + CS_PAD + hit.c * CS_CELL + CS_CELL / 2
          const cellCySvg = oy + CS_PAD + hit.r * CS_CELL + CS_CELL / 2
          const toX = rect.left + cellCxSvg * (rect.width  / VW)
          const toY = rect.top  + cellCySvg * (rect.height / VH)
          setFlyDot(prev => ({
            colorIdx: dragColorIdx!, id: (prev?.id ?? 0) + 1,
            fromX: e.clientX, fromY: e.clientY, toX, toY,
            box: hit.box, r: hit.r, c: hit.c,
          }))
        }
      } else {
        setErrorFlash(prev => ({ x: e.clientX, y: e.clientY, id: (prev?.id ?? 0) + 1 }))
      }
      setDragColorIdx(null); setDragPt(null); setHoverCell(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
  }, [dragColorIdx, boardA, boardB, isLandscape]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── SVG: two 2×2 boxes (portrait = stacked, landscape = side by side) ──────
  const svgBoard = (
    <svg ref={svgRef} viewBox={`0 0 ${VW} ${VH}`}
      style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
    >
      {(['A', 'B'] as const).map(box => {
        const ox = box === 'A' ? 0 : B_OX
        const oy = box === 'A' ? 0 : B_OY
        const board = box === 'A' ? boardA : boardB
        const given = box === 'A' ? CS1_GIVEN_A : CS1_GIVEN_B
        const gx = ox + CS_PAD   // grid origin x
        const gy = oy + CS_PAD   // grid origin y
        const sz = 2 * CS_CELL
        return (
          <g key={box}>
            {/* Grid lines */}
            {[0, 1, 2].map(i => (
              <line key={`h${i}`} x1={gx} y1={gy + i * CS_CELL}
                x2={gx + sz} y2={gy + i * CS_CELL}
                stroke="#ccc" strokeWidth={1.5} />
            ))}
            {[0, 1, 2].map(i => (
              <line key={`v${i}`} x1={gx + i * CS_CELL} y1={gy}
                x2={gx + i * CS_CELL} y2={gy + sz}
                stroke="#ccc" strokeWidth={1.5} />
            ))}
            {/* Dots */}
            {Array.from({ length: 2 }, (_, r) =>
              Array.from({ length: 2 }, (_, c) => {
                const cx = gx + c * CS_CELL + CS_CELL / 2
                const cy = gy + r * CS_CELL + CS_CELL / 2
                const val = board[r][c]
                const isHover  = hoverCell?.box === box && hoverCell?.r === r && hoverCell?.c === c
                const isFlying = flyDot?.box === box && flyDot?.r === r && flyDot?.c === c
                return (
                  <g key={`${r}${c}`}>
                    {isHover && (
                      <rect x={gx + c * CS_CELL + 2} y={gy + r * CS_CELL + 2}
                        width={CS_CELL - 4} height={CS_CELL - 4}
                        fill={`${colors[dragColorIdx!]}30`} rx={5} />
                    )}
                    {val !== null && !isFlying ? (
                      <circle cx={cx} cy={cy} r={CS_DOT_R} fill={colors[val]} />
                    ) : isHover ? (
                      <circle cx={cx} cy={cy} r={CS_DOT_R} fill={colors[dragColorIdx!]} opacity={0.45} />
                    ) : given[r][c] === null && val === null ? (
                      // Empty slot: no ghost dot — leave blank
                      null
                    ) : null}
                  </g>
                )
              })
            )}
          </g>
        )
      })}
    </svg>
  )

  // ── Ghost / error-flash / fly-dot visuals ───────────────────────────────────
  const ghostDot = dragColorIdx !== null && dragPt && (
    <div style={{
      position: 'fixed', left: dragPt.x - TRAY_PD/2, top: dragPt.y - TRAY_PD/2,
      width: TRAY_PD, height: TRAY_PD, borderRadius: '50%',
      background: colors[dragColorIdx], pointerEvents: 'none', opacity: 0.85,
      border: '2px solid rgba(255,255,255,0.75)', zIndex: 9999,
    }} />
  )
  const errorFlashEl = errorFlash && (
    <div key={errorFlash.id} style={{
      position: 'fixed', left: errorFlash.x - TRAY_PD/2, top: errorFlash.y - TRAY_PD/2,
      width: TRAY_PD, height: TRAY_PD, borderRadius: '50%',
      pointerEvents: 'none', zIndex: 9999,
      background: '#e53935', border: '2px solid rgba(255,255,255,0.75)',
      animation: 'csErrorPop 0.45s ease-out forwards',
    }} />
  )
  const flyDeltaX = flyDot ? flyDot.toX - flyDot.fromX : 0
  const flyDeltaY = flyDot ? flyDot.toY - flyDot.fromY : 0
  const flyDotEl = flyDot && (
    <>
      <style>{`@keyframes cs1Fly_${flyDot.id} {
        0%   { transform: translate(0,0); }
        100% { transform: translate(${flyDeltaX}px,${flyDeltaY}px); }
      }`}</style>
      <div key={flyDot.id} style={{
        position: 'fixed', left: flyDot.fromX - TRAY_PD/2, top: flyDot.fromY - TRAY_PD/2,
        width: TRAY_PD, height: TRAY_PD, borderRadius: '50%',
        background: colors[flyDot.colorIdx], border: '2px solid rgba(255,255,255,0.75)',
        animation: `cs1Fly_${flyDot.id} 0.28s ease-out forwards`,
        pointerEvents: 'none', zIndex: 9998,
      }} onAnimationEnd={() => setFlyDot(null)} />
    </>
  )

  // ── Tray panel ──────────────────────────────────────────────────────────────
  const trayDot = (colorIdx: number) => {
    const color = colors[colorIdx]
    const count = remaining[colorIdx]
    const isEmpty = count <= 0
    return (
      <div key={colorIdx}
        style={{
          position: 'relative', flexShrink: 0, touchAction: 'none',
          cursor: isEmpty ? 'default' : 'grab',
          width: TRAY_PD, height: TRAY_PD, borderRadius: '50%',
          background: isEmpty ? 'transparent' : color,
          border: isEmpty ? `2px solid ${color}` : 'none',
          opacity: dragColorIdx === colorIdx ? 0.35 : 1,
          transition: 'opacity 0.12s',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: isEmpty ? 'none' : undefined,
        }}
        onPointerDown={isEmpty ? undefined : e => {
          e.preventDefault(); setDragColorIdx(colorIdx); setDragPt({ x: e.clientX, y: e.clientY })
        }}
      >
        {!isEmpty && (
          <span style={{
            fontSize: trayFontSize, fontWeight: 900, color: '#fff',
            lineHeight: 1, pointerEvents: 'none', userSelect: 'none',
            textShadow: '0 1px 2px rgba(0,0,0,0.2)',
          }}>{count}</span>
        )}
      </div>
    )
  }
  const palettePanel = (axis: 'column' | 'row') => {
    const isCol = axis === 'column'
    const trayStyle: React.CSSProperties = {
      background: '#fef9f0', flexShrink: 0, padding: trayPad,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      margin: trayMargin, borderRadius: 16,
      ...(isCol ? { alignSelf: 'stretch' } : {}),
    }
    return (
      <div style={{ ...trayStyle, flexDirection: axis, gap: trayGap }}>
        {trayOrder.map(colorIdx => trayDot(colorIdx))}
      </div>
    )
  }

  const fixedOverlays = (
    <>
      <style>{`@keyframes csErrorPop {
        0%   { opacity: .9; transform: scale(1.1); }
        60%  { opacity: .7; transform: scale(0.85); }
        100% { opacity: 0;  transform: scale(0.5); }
      }`}</style>
      {ghostDot}{errorFlashEl}{flyDotEl}
    </>
  )

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const caption = useMemo(() => <><b>Each box needs all 4 colors</b> — drag the missing dot into place!</>, [])

  if (isLandscape) {
    return (
      <>
        <div style={{ ...ch4CanvasStyle, flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
          <Ch4PlayAgainBtn show={true} onClick={resetBoards} />
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div ref={boardDivRef}
              style={{ height: '100%', aspectRatio: `${VW} / ${VH}`, maxWidth: '100%' }}>
              {svgBoard}
            </div>
          </div>
          {palettePanel('column')}
        </div>
        <IntroText>{caption}</IntroText>
        {fixedOverlays}
        <SetDone done={bothSolved} />
      </>
    )
  }

  return (
    <>
      <div style={{ ...ch4CanvasStyle, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', justifyContent: 'center' }}>
        <Ch4PlayAgainBtn show={true} onClick={resetBoards} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div ref={boardDivRef}
            style={{ height: '100%', aspectRatio: `${VW} / ${VH}`, maxWidth: '100%' }}>
            {svgBoard}
          </div>
        </div>
        {palettePanel('row')}
      </div>
      <IntroText>{caption}</IntroText>
      {fixedOverlays}
      <SetDone done={bothSolved} />
    </>
  )
}

function CS4Page() { return <ColorSudokuPage cfg={CS4_CFG} /> }
function CS6Page() { return <ColorSudokuPage cfg={CS6_CFG} /> }

const CHAPTER5_PAGES: React.ComponentType[] = [CS1Page, CS4Page, CS6Page]

export default function PressHere() {
  const [page,       setPage]      = useState(0)
  const [caption,    setCaption]   = useState<React.ReactNode>('')
  const [done,       setDone]      = useState(false)
  const [globalKey,  setGlobalKey] = useState(0)
  // Lazy mounting: only pages that have been visited are mounted in the DOM.
  // Always pre-mount page 0 and 1 so the first navigation is instant.
  const [mountedPages, setMountedPages] = useState<Set<number>>(() => new Set([0, 1]))
  const [wellDone,   setWellDone]  = useState(false)
  const [chapter,    setChapter]   = useState(() => {
    const m = window.location.pathname.match(/\/ch(\d+)/)
    const ch = m ? Math.max(1, Math.min(5, parseInt(m[1], 10))) : 1
    // Immediately redirect /press-here → /press-here/ch1 (or whichever chapter)
    window.history.replaceState(null, '', `/press-here/ch${ch}`)
    return ch
  })
  const [ch2Shapes,  setCh2Shapes] = useState<ShapeDef[]>(() => pickRandomShapes(7))
  const handoffRef     = useRef<Handoff>({ page4Dots: null, page5Dots: null, page6Dots: null, ch2p2Dots: null, ch2LatestDots: null })
  const canvasAreaRef  = useRef<HTMLDivElement>(null)
  const firstRenderRef = useRef(true)

  // Sync chapter to URL without causing a navigation/reload
  useEffect(() => {
    window.history.replaceState(null, '', `/press-here/ch${chapter}`)
  }, [chapter])

  // Reset mounted-page set whenever the chapter restarts (globalKey bumped)
  useEffect(() => {
    setMountedPages(new Set([0, 1]))
  }, [globalKey])  // eslint-disable-line react-hooks/exhaustive-deps

  const vw = useWindowWidth()
  const isMobile = vw < 480
  const dotSize  = Math.max(36, Math.min(80, Math.floor(vw * 0.12)))

  const activePages = chapter === 1 ? CHAPTER1_PAGES : chapter === 2 ? CHAPTER2_PAGES : chapter === 3 ? CHAPTER3_PAGES : chapter === 4 ? CHAPTER4_PAGES : CHAPTER5_PAGES
  const TOTAL = activePages.length
  const isFirst = page === 0
  const isLast  = page === TOTAL - 1

  function nav(next: number) {
    setPage(next)
    setDone(false)
    // Pre-mount the navigated page and the one after it
    setMountedPages(prev => {
      const s = new Set(prev)
      s.add(next)
      if (next + 1 < activePages.length) s.add(next + 1)
      return s
    })
  }

  function reset() {
    setGlobalKey(k => k + 1)
    setPage(0)
    setDone(false)
    setWellDone(false)
    setChapter(1)
    handoffRef.current = { page4Dots: null, page5Dots: null, page6Dots: null, ch2p2Dots: null, ch2LatestDots: null }
  }

  function startChapter2() {
    setCh2Shapes(pickRandomShapes(7))
    setGlobalKey(k => k + 1)
    setPage(0)
    setDone(false)
    setWellDone(false)
    setChapter(2)
    handoffRef.current = { page4Dots: null, page5Dots: null, page6Dots: null, ch2p2Dots: null, ch2LatestDots: null }
  }

  function startChapter3() {
    setGlobalKey(k => k + 1)
    setPage(0)
    setDone(false)
    setWellDone(false)
    setChapter(3)
    handoffRef.current = { page4Dots: null, page5Dots: null, page6Dots: null, ch2p2Dots: null, ch2LatestDots: null }
  }

  function startChapter4() {
    setGlobalKey(k => k + 1)
    setPage(0)
    setDone(false)
    setWellDone(false)
    setChapter(4)
    handoffRef.current = { page4Dots: null, page5Dots: null, page6Dots: null, ch2p2Dots: null, ch2LatestDots: null }
  }

  function startChapter5() {
    setGlobalKey(k => k + 1)
    setPage(0)
    setDone(false)
    setWellDone(false)
    setChapter(5)
    handoffRef.current = { page4Dots: null, page5Dots: null, page6Dots: null, ch2p2Dots: null, ch2LatestDots: null }
  }

  function replayChapter() {
    if (chapter === 2) startChapter2()
    else if (chapter === 3) startChapter3()
    else if (chapter === 4) startChapter4()
    else if (chapter === 5) startChapter5()
    else reset()
  }

  // Page-change shadow lift animation
  useLayoutEffect(() => {
    if (firstRenderRef.current) { firstRenderRef.current = false; return }
    const el = canvasAreaRef.current
    if (!el) return
    el.animate(
      [{ opacity: '1' }, { opacity: '0.7' }, { opacity: '1' }],
      { duration: 280, easing: 'ease-out' }
    )
  }, [page])

  // Chapter completion sound
  useEffect(() => { if (wellDone) playChapterComplete() }, [wellDone])

  // Spacebar → Next / Done when available
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== 'Space' || !done) return
      e.preventDefault()
      if (isLast) setWellDone(true)
      else nav(page + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [done, isLast, page])   // eslint-disable-line react-hooks/exhaustive-deps

  // Secret shortcut: X finishes the current page
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'x' || e.key === 'X') setDone(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // Prevent page scrolling
  useLayoutEffect(() => {
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
  }, [])

  if (wellDone && chapter === 5) return <AmazingScreen onReset={startChapter5} />
  if (wellDone && chapter === 4) return <AmazingScreen onReset={startChapter4} />
  if (wellDone && chapter === 3) return <WoohooScreen onReset={startChapter3} onNextChapter={startChapter4} />
  if (wellDone && chapter === 2) return <GreatJob onReset={startChapter2} onNextChapter={startChapter3} />
  if (wellDone) return <WellDone onReset={reset} onNextChapter={startChapter2} />

  return (
    <Ch2ShapesCtx.Provider value={ch2Shapes}>
    <CaptionCtx.Provider value={setCaption}>
      <DoneCtx.Provider value={setDone}>
        <HandoffCtx.Provider value={handoffRef}>
          <div style={{
            height: '100dvh',
            background: '#fef9f0',
            display: 'flex',
            justifyContent: 'center',
            overflow: 'hidden',
            fontFamily: '"Nunito Variable", Nunito, sans-serif',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
            touchAction: 'manipulation',
          }}>
          <DotSizeCtx.Provider value={dotSize}>
          <div style={{
            width: '100%', maxWidth: 1280,
            display: 'flex', flexDirection: 'column',
            padding: 'clamp(8px,1.5vw,12px) clamp(12px,3vw,32px) clamp(6px,1.5vw,16px)',
            boxSizing: 'border-box',
          }}>

            {/* ── Header: title + chapter / replay pills ── */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isMobile ? 6 : 10 }}>
              {/* Title with coloured dots */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'clamp(15px,3vw,22px)', fontWeight: 700, color: '#222', letterSpacing: -0.3, fontFamily: 'inherit' }}>
                <span style={{ width: 'clamp(7px,1.2vw,10px)', height: 'clamp(7px,1.2vw,10px)', borderRadius: '50%', background: RED,    flexShrink: 0, display: 'inline-block' }} />
                Press
                <span style={{ width: 'clamp(7px,1.2vw,10px)', height: 'clamp(7px,1.2vw,10px)', borderRadius: '50%', background: YELLOW, flexShrink: 0, display: 'inline-block' }} />
                here
                <span style={{ width: 'clamp(7px,1.2vw,10px)', height: 'clamp(7px,1.2vw,10px)', borderRadius: '50%', background: BLUE,   flexShrink: 0, display: 'inline-block' }} />
              </div>
              {/* Chapter pills + Replay */}
              <div style={{ display: 'flex', gap: isMobile ? 4 : 6, alignItems: 'center' }}>
                {([1, 2, 3, 4, 5] as const).map(ch => (
                  <button
                    key={ch}
                    onClick={() => ch === 1 ? reset() : ch === 2 ? startChapter2() : ch === 3 ? startChapter3() : ch === 4 ? startChapter4() : startChapter5()}
                    style={{
                      padding: isMobile ? '3px 8px' : '4px 14px', borderRadius: 20,
                      background: chapter === ch ? '#333' : 'transparent',
                      border: `1.5px solid ${chapter === ch ? '#333' : '#ddd'}`,
                      fontSize: isMobile ? 11 : 12, fontWeight: 700, letterSpacing: '0.02em',
                      color: chapter === ch ? '#fff' : '#bbb',
                      fontFamily: 'inherit',
                      cursor: chapter === ch ? 'default' : 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={e => { if (chapter !== ch) { e.currentTarget.style.borderColor = '#aaa'; e.currentTarget.style.color = '#666' } }}
                    onMouseLeave={e => { if (chapter !== ch) { e.currentTarget.style.borderColor = '#ddd'; e.currentTarget.style.color = '#bbb' } }}
                  >
                    {isMobile ? ch : `Ch ${ch}`}
                  </button>
                ))}
              </div>
            </div>

            {/* Canvas area — pages are lazily mounted on first visit to reduce startup cost */}
            <div ref={canvasAreaRef} key={globalKey} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              {activePages.map((P, i) => {
                if (!mountedPages.has(i)) return <div key={i} style={{ display: 'none' }} />
                return (
                  <PageActiveCtx.Provider key={i} value={i === page}>
                    <div style={{
                      position: 'absolute', inset: 0, display: i === page ? 'flex' : 'none', flexDirection: 'column',
                    }}>
                      <P />
                    </div>
                  </PageActiveCtx.Provider>
                )
              })}
            </div>

            {/* Caption row — caption left-aligned, Next button pinned to the right */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-start', marginTop: isMobile ? 8 : 14, minHeight: isMobile ? 38 : 46 }}>
              <div style={{ fontSize: 'clamp(13px,2vw,18px)', fontWeight: 600, color: '#444', lineHeight: 1.4, maxWidth: chapter >= 4 ? 'calc(100% - 90px)' : 'calc(100% - 190px)' }}>
                {caption}
              </div>
              {chapter >= 4 ? (
                <div style={{ position: 'absolute', right: 0, display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => nav(page - 1)}
                    disabled={page === 0}
                    title="Previous"
                    style={{
                      width: isMobile ? 32 : 36, height: isMobile ? 32 : 36, borderRadius: 20, padding: 0,
                      background: 'transparent', border: `1.5px solid ${page === 0 ? '#eee' : '#ddd'}`,
                      color: page === 0 ? '#ddd' : '#bbb', cursor: page === 0 ? 'default' : 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}
                  >
                    <ChevronLeft size={isMobile ? 15 : 17} strokeWidth={2.5} />
                  </button>
                  <button
                    onClick={isLast ? () => setWellDone(true) : () => nav(page + 1)}
                    disabled={!done}
                    title={isLast ? 'Done' : 'Next'}
                    style={{
                      width: isMobile ? 32 : 36, height: isMobile ? 32 : 36, borderRadius: 20, padding: 0,
                      background: 'transparent', border: `1.5px solid ${done ? '#ddd' : '#eee'}`,
                      color: done ? '#bbb' : '#ddd', cursor: done ? 'pointer' : 'default',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}
                  >
                    <ChevronRight size={isMobile ? 15 : 17} strokeWidth={2.5} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={isLast ? () => setWellDone(true) : () => nav(page + 1)}
                  style={{
                    position: 'absolute', right: 0,
                    display: 'flex', alignItems: 'center', gap: isMobile ? 4 : 8,
                    padding: isMobile ? '7px 16px' : '10px 28px', borderRadius: 40,
                    background: '#FDD302', border: 'none',
                    fontSize: isMobile ? 16 : 20, fontWeight: 800, color: '#333',
                    fontFamily: 'inherit', cursor: 'pointer',
                    flexShrink: 0,
                    visibility: done ? 'visible' : 'hidden',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#ffc700')}
                  onMouseLeave={e => (e.currentTarget.style.background = '#FDD302')}
                  onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.96)')}
                  onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
                >
                  {isLast ? 'Done' : <>Next <ChevronRight size={isMobile ? 17 : 22} strokeWidth={3} /></>}
                </button>
              )}
            </div>

            {/* Footer — dot pagination */}
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginTop: isMobile ? 6 : 10, gap: 7 }}>
              {Array.from({ length: TOTAL }, (_, i) => (
                <button
                  key={i}
                  onClick={() => nav(i)}
                  style={{
                    width:  i === page ? 13 : 8,
                    height: i === page ? 13 : 8,
                    borderRadius: '50%',
                    background: i === page ? YELLOW : '#ddd',
                    border: 'none', padding: 0, cursor: 'pointer',
                    flexShrink: 0,
                    transition: 'width 0.2s ease, height 0.2s ease, background 0.2s ease',
                  }}
                />
              ))}
            </div>

          </div>
          </DotSizeCtx.Provider>
          </div>
        </HandoffCtx.Provider>
      </DoneCtx.Provider>
    </CaptionCtx.Provider>
    </Ch2ShapesCtx.Provider>
  )
}
