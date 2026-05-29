import { useState, useRef, useEffect, useLayoutEffect, createContext, useContext, useMemo } from 'react'
import '@fontsource-variable/nunito'
import { ChevronRight, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from '@/components/ui/pagination'
import { cn } from '@/lib/utils'

const YELLOW = '#FDD302'
const RED    = '#F63664'
const BLUE   = '#5CCBF8'
const DOT_SIZE = 80

// Fixed horizontal positions for color baskets — same across all collection pages
const BASKET_LEFT: Record<string, string> = { [YELLOW]: '50%', [BLUE]: '25%', [RED]: '75%' }

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

function SetDone({ done }: { done: boolean }) {
  const active     = useContext(PageActiveCtx)
  const setDone    = useContext(DoneCtx)
  const prevRef    = useRef(false)
  useLayoutEffect(() => { if (active) setDone(done) })
  useEffect(() => {
    if (active && done && !prevRef.current) playPageComplete()
    prevRef.current = done
  }, [active, done])
  return (active && done) ? <ClapCelebration /> : null
}

// ─── Dot component (no entrance animation) ───────────────────────────────────
function DotMount({ color, x, y, onClick, interactive = true }: {
  color: string; x: number; y: number; onClick: () => void; interactive?: boolean
}) {
  return (
    <div
      onClick={onClick}
      style={{ ...dotStyle(color, interactive), left: `${x}%`, top: `${y}%`, transform: 'translate(-50%,-50%)' }}
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
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        position: 'absolute',
        left: `${COL_X[i]}%`, top: `${ROW_Y[0]}%`,
        transform: 'translate(-50%,-50%)',
        width: DOT_SIZE, height: DOT_SIZE,
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
                  width: DOT_SIZE, height: DOT_SIZE,
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
      let anyMoving = false
      dotsRef.current = dotsRef.current.map(({ x, y, vx, vy, friction, ...rest }) => {
        x += vx; y += vy
        if (x < RX)        { x = RX;        vx =  Math.abs(vx) * BOUNCE }
        if (x > 100 - RX)  { x = 100 - RX;  vx = -Math.abs(vx) * BOUNCE }
        if (y < RY)        { y = RY;        vy =  Math.abs(vy) * BOUNCE }
        if (y > 100 - RY)  { y = 100 - RY;  vy = -Math.abs(vy) * BOUNCE }
        vx *= friction; vy *= friction
        if (Math.abs(vx) > 0.05 || Math.abs(vy) > 0.05) anyMoving = true
        return { ...rest, x, y, vx, vy, friction }
      })
      const cw = canvasRef.current?.offsetWidth  ?? 960
      const ch = canvasRef.current?.offsetHeight ?? 520
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
        if (x < RX)       { x = RX;       vx =  Math.abs(vx) * BOUNCE }
        if (x > 100 - RX) { x = 100 - RX; vx = -Math.abs(vx) * BOUNCE }
        if (y < RY)       { y = RY;       vy =  Math.abs(vy) * BOUNCE }
        if (y > 100 - RY) { y = 100 - RY; vy = -Math.abs(vy) * BOUNCE }
        return { ...rest, x, y, vx, vy, friction }
      })

      dotsRef.current = resolveCollisions(dotsRef.current, cw, ch, DOT_SIZE)

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
      // Real circle: R=250px, chord≈104px gives ~24px gap between dots
      const R = 250
      const θ = (2 * Math.PI * i / 15) - Math.PI / 2
      return { x: 50 + (R / cw * 100) * Math.cos(θ), y: 50 + (R / ch * 100) * Math.sin(θ) }
    }
    case 3: {
      // Real half-circle arch: R=420px, chord≈94px gives ~14px gap; cy=50+ry/2 centers vertically
      const R = 420
      const ry = R / ch * 100
      const cy = 50 + ry / 2   // midpoint of (cy-ry .. cy) sits at 50%
      const θ = Math.PI + (i / 14) * Math.PI   // π → 2π sweeps through top
      return { x: 50 + (R / cw * 100) * Math.cos(θ), y: cy + ry * Math.sin(θ) }
    }
    default:
      return lineupPos(i)
  }
}

function Page7() {
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
              width: DOT_SIZE, height: DOT_SIZE, borderRadius: '50%',
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
                width: DOT_SIZE, height: DOT_SIZE, borderRadius: '50%',
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
                width: DOT_SIZE + 40, height: DOT_SIZE + 40,
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
              <div style={{ width: DOT_SIZE, height: DOT_SIZE, borderRadius: '50%', background: color, pointerEvents: 'none' }} />
            </div>
          )
        })}

        {/* Basket */}
        <div style={{
          position: 'absolute', left: BASKET_LEFT[YELLOW], bottom: '5%',
          transform: 'translateX(-50%)',
          pointerEvents: 'none', zIndex: 0,
        }}>
          <div style={{
            margin: '0 auto', width: 70, height: 28,
            border: `5px solid ${YELLOW}`, borderBottom: 'none',
            borderRadius: '40px 40px 0 0',
          }} />
          <div ref={basketBodyRef} style={{
            width: 110, height: 72,
            border: `5px solid ${YELLOW}`,
            borderRadius: '0 0 18px 18px',
            background: YELLOW + '20',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, fontWeight: 700, color: YELLOW,
          }}>
            {`${collected}/${YELLOW_IDXS.length}`}
          </div>
        </div>

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

function stepBrown(dots: BrownDot[], maxSpd: number, cw: number, ch: number): BrownDot[] {
  const rxPct = DOT_SIZE / 2 / cw * 100
  const ryPct = DOT_SIZE / 2 / ch * 100
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
      dotsRef.current  = stepBrown(dotsRef.current,  maxSpd,        dimsRef.current.cw, dimsRef.current.ch)
      previewRef.current = stepBrown(previewRef.current, maxSpd * 2, dimsRef.current.cw, dimsRef.current.ch)
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
                width: DOT_SIZE + 40, height: DOT_SIZE + 40,
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
              <div style={{ width: DOT_SIZE, height: DOT_SIZE, borderRadius: '50%', background: targetColor, pointerEvents: 'none' }} />
            </div>
          )
        })}

        {/* Preview dots — non-interactive, foreshadow next page */}
        {previewColor && previewRef.current.map(dot => (
          <div key={dot.id} style={{
            position: 'absolute',
            left: `${dot.x}%`, top: `${dot.y}%`,
            transform: 'translate(-50%,-50%)',
            width: DOT_SIZE, height: DOT_SIZE, borderRadius: '50%',
            background: previewColor,
            pointerEvents: 'none', zIndex: 1,
          }} />
        ))}

        {/* Baskets — fixed positions by color so they don't shift between pages */}
        {allColors.map((color, bi) => {
          const isTarget = bi === allColors.length - 1
          const count    = isTarget ? collected : totalPerColor(color)
          const total    = totalPerColor(color)
          return (
            <div key={color} style={{
              position: 'absolute', left: BASKET_LEFT[color], bottom: '5%',
              transform: 'translateX(-50%)',
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              pointerEvents: 'none', zIndex: 0,
            }}>
              <div style={{
                margin: '0 auto', width: 70, height: 28,
                border: `5px solid ${color}`, borderBottom: 'none',
                borderRadius: '40px 40px 0 0',
              }} />
              <div ref={isTarget ? basketBodyRef : undefined} style={{
                width: 110, height: 72,
                border: `5px solid ${color}`,
                borderRadius: '0 0 18px 18px',
                background: color + '20',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 22, fontWeight: 700, color,
              }}>
                {`${count}/${total}`}
              </div>
            </div>
          )
        })}

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
  width: '100%', minWidth: 960,
  background: '#fff', borderRadius: 18,
  border: '2px solid #ede8df',
  position: 'relative', overflow: 'hidden',
}

const dotStyle = (color: string, interactive = true): React.CSSProperties => ({
  position: 'absolute',
  width: DOT_SIZE, height: DOT_SIZE,
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
  function startMerge() {
    if (phaseRef.current !== 'idle') return
    phaseRef.current = 'merging'; setPhase('merging')
    setTimeout(() => {
      phaseRef.current = 'merged'; setPhase('merged')
      setTimeout(() => {
        phaseRef.current = 'shining'; setPhase('shining')
        // basket turns rainbow exactly when beam animation ends (1900ms)
        setTimeout(() => {
          phaseRef.current = 'lit'; setPhase('lit')
          setTimeout(() => {
            phaseRef.current = 'rainbow'; setPhase('rainbow')
          }, 350)   // brief pause then clickable
        }, 1900)   // beam animation duration
      }, 680)      // wait for basketPop
    }, 700)        // wait for slide
  }

  // Auto-trigger merge when page becomes active
  useEffect(() => {
    if (!active) return
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
        {showSmallBaskets && colors.map(color => (
          <div
            key={color}
            style={{
              position: 'absolute',
              left: phase === 'idle' ? BASKET_LEFT[color] : '50%',
              bottom: '5%',
              transform: 'translateX(-50%)',
              transition: 'left 0.6s cubic-bezier(0.34,1.1,0.64,1)',
              display: 'flex',
              flexDirection: 'column', alignItems: 'center',
              cursor: 'default',
              pointerEvents: 'none',
              zIndex: 2,
            }}
          >
            <div style={{
              margin: '0 auto', width: 70, height: 28,
              border: `5px solid ${color}`, borderBottom: 'none',
              borderRadius: '40px 40px 0 0',
            }} />
            <div style={{
              width: 110, height: 72,
              border: `5px solid ${color}`,
              borderRadius: '0 0 18px 18px',
              background: color + '20',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, fontWeight: 700, color,
            }}>✓</div>
          </div>
        ))}

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
        {bigBasketShown && (
          <div
            onClick={handleRainbowBasketClick}
            style={{
              position: 'absolute', left: '50%', bottom: '5%',
              transform: 'translateX(-50%)',
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              animation: phase === 'merged' ? 'fadeIn 0.45s ease forwards' : 'none',
              cursor: phase === 'rainbow' ? 'pointer' : 'default',
              pointerEvents: phase === 'rainbow' ? 'auto' : 'none',
              zIndex: 11,
            }}
          >
            <div style={{
              margin: '0 auto', width: 120, height: 46,
              border: `6px solid ${isRainbow ? '#ffdd00' : '#888'}`,
              borderBottom: 'none', borderRadius: '60px 60px 0 0',
              animation:  isRainbow ? 'rybShimmer 2s linear infinite' : 'none',
              animationDelay: isRainbow ? '-0.5s' : '0s',
              boxShadow:  isRainbow ? '0 0 22px rgba(255,200,0,0.75)' : 'none',
              transition: 'box-shadow 0.4s ease',
            }} />
            <div style={{
              width: 190, height: 120,
              border: `6px solid ${isRainbow ? '#ffdd00' : '#888'}`,
              borderRadius: '0 0 28px 28px',
              background:  isRainbow ? undefined : '#88888818',
              animation:   isRainbow ? 'rybShimmer 2s linear infinite' : 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              boxShadow: isRainbow ? '0 0 32px 8px rgba(255,200,0,0.7),inset 0 0 18px rgba(255,255,255,0.25)' : 'none',
              transition: 'box-shadow 0.4s ease',
            }}>
              {!isRainbow && [YELLOW, BLUE, RED].map(c => (
                <div key={c} style={{ width: 30, height: 30, borderRadius: '50%', background: c }} />
              ))}
              {isRainbow && <span style={{ fontSize: 44, lineHeight: 1 }}>🌈</span>}
            </div>
          </div>
        )}

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
      alignItems: 'center', justifyContent: 'center', gap: 36,
      background: '#fff',
      fontFamily: '"Nunito Variable", Nunito, sans-serif',
      userSelect: 'none',
    }}>
      <img
        src="/src/games/press-here/completion-ch2.gif"
        alt="Great job!"
        style={{ width: 320, height: 320, borderRadius: 28, objectFit: 'cover' }}
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
      alignItems: 'center', justifyContent: 'center', gap: 36,
      background: '#fff',
      fontFamily: '"Nunito Variable", Nunito, sans-serif',
      userSelect: 'none',
    }}>
      <img
        src="/src/games/press-here/completion-ch3.gif"
        alt="Woohoo!"
        style={{ width: 320, height: 320, borderRadius: 28, objectFit: 'cover' }}
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
      alignItems: 'center', justifyContent: 'center', gap: 36,
      background: '#fff',
      fontFamily: '"Nunito Variable", Nunito, sans-serif',
      userSelect: 'none',
    }}>
      <div style={{ fontSize: 140, lineHeight: 1, animation: 'popIn 0.7s cubic-bezier(0.34,1.56,0.64,1) forwards' }}>
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
      alignItems: 'center', justifyContent: 'center', gap: 36,
      background: '#fff',
      fontFamily: '"Nunito Variable", Nunito, sans-serif',
      userSelect: 'none',
    }}>
      <img
        src="/src/games/press-here/completion-ch1.gif"
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
const SHAPE_DEFS: ShapeDef[] = [
  // 01 — umbrella (handle hook → up → cap arc, open, 9 verts; start at tip of handle)
  { vertices: [[280.938,580.237],[280.938,631],[360.285,631],[360.285,312.77],[80,312.77],[194.169,172.459],[360.285,112],[527.543,172.459],[640,312.77]],
    open:true, emoji:'☂️', label:'Connect the umbrella!' },
  // 02 — irregular shield (closed, 7 verts)
  { vertices: [[387.264,430.841],[387.264,122],[603,122],[603,628],[98.576,628],[78,571.223],[135.987,470.772]],
    open:false, emoji:'🔷', label:'Connect it!' },
  // 03 — twisted loop (closed, 10 verts)
  { vertices: [[563.163,354.904],[593,416.786],[494.483,557.429],[494.483,630],[258.042,630],[250.724,554.616],[128,276.707],[290.694,122],[494.483,181.632],[465.209,455.604]],
    open:false, emoji:'💫', label:'Connect it!' },
  // 04 — double arrow (closed, 11 verts)
  { vertices: [[143.695,291.855],[361.487,58],[577.791,291.855],[433.588,291.855],[638,520.496],[406.413,520.496],[406.413,662],[317.304,662],[317.304,520.496],[82,520.496],[290.128,291.855]],
    open:false, emoji:'⬆️', label:'Connect it!' },
  // 05 — trident (closed, 7 verts)
  { vertices: [[257.155,398.23],[359.729,190],[460.679,398.23],[625,222.536],[625,530],[95,530],[95,222.536]],
    open:false, emoji:'🔱', label:'Connect it!' },
  // 06 — house (closed, 11 verts)
  { vertices: [[213.192,371.258],[213.192,597],[298.436,597],[298.436,443.688],[421.564,443.688],[421.564,597],[507.4,597],[507.4,371.258],[640,371.258],[360.592,123],[80,371.258]],
    open:false, emoji:'🏠', label:'Connect the house!' },
  // 07 — frame (closed, 11 verts)
  { vertices: [[188.868,153],[59,304.901],[90.7048,359.195],[59,414.709],[188.868,566],[401.046,566],[516.28,414.709],[662,503.775],[662,214.004],[516.28,304.901],[401.046,153]],
    open:false, emoji:'🎮', label:'Connect it!' },
  // 08 — bolt (closed, 11 verts)
  { vertices: [[569.495,129],[673,182.767],[615.276,218.612],[615.276,342.078],[527.695,429.698],[258.981,487.448],[83.819,591],[298.79,342.078],[46,129],[258.981,129],[434.143,218.612]],
    open:false, emoji:'⚡', label:'Connect it!' },
  // 09 — zigzag scissors (closed, 13 verts)
  { vertices: [[489.119,138.37],[573.863,125.784],[560.858,210.109],[289.721,466.982],[371.049,548.309],[307.389,574.212],[244.94,511.763],[182.444,588.523],[110.705,516.784],[188.724,455.546],[124.177,391],[151.338,328.599],[233.505,410.765]],
    open:false, emoji:'✂️', label:'Connect it!' },
  // 10 — trophy / goblet  (closed, 11 verts)
  { vertices: [[254.664,182.986],[360.684,71],[467.388,182.986],[467.388,362.573],[531,435.637],[531,648],[477.648,584.496],[254.664,584.496],[189,648],[189,435.637],[254.664,362.573]],
    open:false, emoji:'🏆', label:'Connect the arch!' },
  // 11 — spiral  (OPEN, 12 verts)
  { vertices: [[405.504,326.324],[351.837,372.934],[413.663,441.184],[493.285,385.923],[413.592,263.654],[278.33,334.955],[307.05,490.673],[505.733,527.341],[617.202,301.83],[463.275,121.986],[146.546,195.544],[82.644,543.242]],
    open:true, emoji:'🌊', label:'Connect the wave!' },
  // 12 — staircase  (OPEN, 10 verts)
  { vertices: [[64,596],[181.383,596],[181.383,478.846],[300.461,478.846],[300.461,360],[418.691,360],[418.691,240.731],[536.922,240.731],[536.922,124],[656,124]],
    open:true, emoji:'📶', label:'Connect the stairs!' },
  // 13 — tree / Y  (closed, 11 verts)
  { vertices: [[344.09,474.299],[344.09,612],[378.238,612],[378.238,474.299],[569.153,377.053],[639,160],[444.981,251.022],[360.388,429.955],[273.467,251.022],[81,160],[149.295,377.053]],
    open:false, emoji:'🌿', label:'Connect the tree!' },
  // 14 — comet  (closed, 11 verts)
  { vertices: [[410.929,325.658],[501.745,196.832],[538.546,106],[576.535,106],[553.386,169.523],[589,245.513],[501.745,451.516],[309.428,575],[72,526.319],[72,496.042],[259.568,451.516]],
    open:false, emoji:'☄️', label:'Connect the comet!' },
  // 15 — gem / shield  (closed, 8 verts)
  { vertices: [[502.093,130],[359.273,234.949],[215.777,130],[80,205.187],[80,393.678],[359.273,590],[639,393.678],[639,205.187]],
    open:false, emoji:'💎', label:'Connect the gem!' },
  // 16 — star  (closed, 10 verts)
  { vertices: [[293.5,298.5],[360,91],[428,298.5],[642.5,298.5],[468.5,424.5],[533.5,629.5],[360,502.5],[186,629.5],[252,424.5],[78,298.5]],
    open:false, emoji:'⭐', label:'Connect the star!' },
]

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
const CH3_JUMP_V   = 1.8     // %/frame initial upward velocity (soft arc)
const CH3_GRAV     = 0.09    // %/frame² gravity (gentle)
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
  const active    = useContext(PageActiveCtx)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dimsRef   = useRef({ cw: 960, ch: 520 })
  const rafRef    = useRef<number | null>(null)
  const [, tick]  = useState(0)

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
    let alive = true
    const step = () => {
      if (!alive) return

      if (runRef.current && !wonRef.current && !deadRef.current) {
        const { cw, ch } = dimsRef.current
        const gndPx = CH3_GROUND / 100 * ch

        // Gravity
        vyRef.current = Math.min(vyRef.current + CH3_GRAV, 5)
        yRef.current += vyRef.current
        if (yRef.current >= CH3_GROUND) {
          yRef.current = CH3_GROUND; vyRef.current = 0
          // Flush mountains passed mid-air as confirmed jumps on landing
          if (pendingRef.current > 0) {
            jumpedRef.current += pendingRef.current
            pendingRef.current = 0
          }
        }

        // Accelerate + distance (hard mode: gently faster accel)
        spdRef.current  = Math.min(spdRef.current + (variant === 'hard' ? CH3_ACCEL * 1.4 : CH3_ACCEL), CH3_MAX_SPD)
        distRef.current += spdRef.current

        // Move obstacles; o.xPct is the CENTRE x (SVG uses translate(-50%,-100%))
        for (const o of obsRef.current) {
          o.xPct -= spdRef.current
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
          obsRef.current.push({
            id: ++obsIdRef.current, xPct: 102, wPx: CH3_OBS_W, hPx: CH3_OBS_H,
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

  return (
    <>
      <div
        ref={canvasRef}
        onClick={won ? undefined : handleAction}
        style={{ ...canvasStyle, cursor: won ? 'default' : 'pointer', overflow: 'hidden' }}
      >
        {/* Sun — fixed in sky, slowly spinning */}
        <img
          src="/src/games/press-here/sun.svg"
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
function makeC3P2Floor(worldY: number, cw: number, prevGroupCx?: number, hard = false): C3P2Floor {
  const numClouds  = Math.random() < 0.45 ? 1 : 2
  // Each platform: 16–34% of canvas width (slightly narrower than before)
  const minCW      = Math.floor(cw * 0.16)
  const maxCW      = Math.floor(cw * 0.34)
  const widths     = Array.from({ length: numClouds }, () =>
    minCW + Math.floor(Math.random() * (maxCW - minCW))
  )
  const gapBetween = numClouds > 1 ? (C3P2_GAP_W + Math.random() * 60) : 0
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
      const f    = makeC3P2Floor(firstWY + i * C3P2_SPACING, cw, prevGroupCx, variant === 'hard')
      prevGroupCx = floorGroupCx(f)
      floorsRef.current.push(f)
    }
  }

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
      leftRef.current = false; rightRef.current = false
      return
    }
    const { cw, ch } = dimsRef.current
    initGame(cw, ch)
    let alive = true
    const step = () => {
      if (!alive) return
      const { cw, ch } = dimsRef.current

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
              c.x += c.ppSpeed * c.ppDir!

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
        pxRef.current = Math.max(C3P2_R, Math.min(cw - C3P2_R, pxRef.current + dx * C3P2_SPD))

        // ── 2. On-floor: did player walk off every cloud? ───────────────────
        if (onFloorRef.current >= 0) {
          const floor = floorsRef.current[onFloorRef.current]
          if (!floor || !onAnyCloud(pxRef.current, floor)) {
            onFloorRef.current = -1   // become airborne
          }
        }

        // ── 3. Airborne: gravity + floor landing ─────────────────────────────
        if (onFloorRef.current < 0) {
          vyRef.current = Math.min(vyRef.current + C3P2_GRAV, C3P2_MAX_VY)
          const prevY      = pyRef.current
          pyRef.current   += vyRef.current

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
        camYRef.current += scrollSpd

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
          floorsRef.current.push(makeC3P2Floor(last.worldY + C3P2_SPACING, cw, floorGroupCx(last), variant === 'hard'))
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

        {/* Start hint */}
        {!started && !dead && !won && (
          <div style={{
            position: 'absolute', left: '50%', top: '42%',
            transform: 'translate(-50%, -50%)',
            fontSize: 17, fontWeight: 700, color: YELLOW,
            fontFamily: 'inherit', pointerEvents: 'none',
          }}>
            Press or tap to start!
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

    let alive = true
    const step = () => {
      if (!alive) return
      const { cw, ch } = dimsRef.current
      const dotX = cw * C3P3_DOT_X_F

      // ── Physics ─────────────────────────────────────────────────────────────
      if (runRef.current && !wonRef.current && !deadRef.current) {
        vyRef.current = Math.min(vyRef.current + C3P3_GRAV, C3P3_MAX_VY)
        pyRef.current += vyRef.current
        framesRef.current++

        // Hard mode: speed, gap, and jaggedness all increase over time
        const dynSpd    = variant === 'hard' ? Math.min(C3P3_SPD * 2.5, C3P3_SPD + framesRef.current * 0.001) : C3P3_SPD
        const dynMinGap = variant === 'hard' ? Math.max(C3P3_MIN_GAP * 0.40, C3P3_MIN_GAP - framesRef.current * 0.04) : C3P3_MIN_GAP
        const dynDrift  = variant === 'hard' ? Math.min(C3P3_DRIFT * 5, C3P3_DRIFT + framesRef.current * 0.018) : C3P3_DRIFT

        // Scroll terrain left
        for (const s of segsRef.current) s.x -= dynSpd
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

function TicTacToePage() {
  const [mode, setMode]         = useState<TTTMode>('computer')
  const [board, setBoard]       = useState<TTTCell[]>(Array(9).fill(null))
  const [current, setCurrent]   = useState<'X' | 'O'>('X')   // X = Blue, O = Red
  const [status, setStatus]     = useState<TTTStatus>('playing')
  const [winLine, setWinLine]   = useState<number[] | null>(null)
  const [hasWon, setHasWon]     = useState(false)
  const [hovered, setHovered]   = useState<number | null>(null)
  const aiPendingRef            = useRef(false)

  const P_COLOR: Record<'X'|'O', string> = { X: BLUE, O: RED }

  function resetGame(nextMode = mode) {
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

    const nb = [...board] as TTTCell[]
    nb[i] = current
    const st = tttWinner(nb)
    setBoard(nb)

    if (st !== 'playing') {
      setStatus(st); setWinLine(tttWinLine(nb))
      if (st === 'x-wins') setHasWon(true)
      return
    }

    const next: 'X'|'O' = current === 'X' ? 'O' : 'X'
    setCurrent(next)

    if (mode === 'computer' && next === 'O') {
      aiPendingRef.current = true
      setTimeout(() => {
        const ai = tttAIMove(nb)
        const ab = [...nb] as TTTCell[]
        ab[ai] = 'O'
        const ast = tttWinner(ab)
        setBoard(ab); setStatus(ast)
        if (ast !== 'playing') setWinLine(tttWinLine(ab))
        setCurrent('X')
        aiPendingRef.current = false
      }, 480)
    }
  }

  const CELL = 130
  const LINE = '2px solid #1a1a1a'
  const isWin = (i: number) => winLine?.includes(i) ?? false

  function cellBorders(i: number): React.CSSProperties {
    const col = i % 3, row = Math.floor(i / 3)
    return { borderRight: col < 2 ? LINE : 'none', borderBottom: row < 2 ? LINE : 'none', borderTop: 'none', borderLeft: 'none' }
  }

  const canClick = (i: number) =>
    board[i] === null && status === 'playing' && !aiPendingRef.current &&
    (mode === 'two-player' || current === 'X')

  const intro: React.ReactNode =
    status === 'x-wins' ? (mode === 'computer' ? 'You win! 🎉' : 'Blue wins! 🎉')
    : status === 'o-wins' ? (mode === 'computer' ? 'I win! Try again?' : 'Red wins! Try again?')
    : status === 'draw'   ? "It's a draw! Try again?"
    : mode === 'computer' ? (current === 'X' ? 'Your turn!' : 'Thinking…')
    : (current === 'X' ? "Blue's turn!" : "Red's turn!")

  return (
    <>
      <div style={canvasStyle}>

        {/* Turn indicator — pinned to top center */}
        <div style={{ position: 'absolute', top: 20, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 48, alignItems: 'center', fontFamily: 'inherit' }}>
          {(['X', 'O'] as const).map(p => {
            const active = current === p && status === 'playing'
            const label  = mode === 'computer' ? (p === 'X' ? 'You' : 'Me') : (p === 'X' ? 'Blue' : 'Red')
            return (
              <div key={p} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: 52 }}>
                <div style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: '50%',
                    background: P_COLOR[p],
                    transform: active ? 'scale(1)' : 'scale(0.55)',
                    opacity:   active ? 1 : 0.3,
                    transition: 'transform 0.2s, opacity 0.2s',
                  }} />
                </div>
                <span style={{ fontSize: 15, lineHeight: '18px', fontWeight: active ? 900 : 500, color: active ? '#111' : '#bbb', fontFamily: 'inherit', transition: 'font-weight 0.15s, color 0.2s' }}>
                  {label}
                </span>
                <div style={{ height: 3, width: 28, borderRadius: 2, background: P_COLOR[p], opacity: active ? 1 : 0, transition: 'opacity 0.2s' }} />
              </div>
            )
          })}
        </div>

        {/* Board + play-again — vertically centered in canvas */}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 28 }}>

          {/* Board */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(3, ${CELL}px)`,
            gridTemplateRows: `repeat(3, ${CELL}px)`,
          }}>
            {board.map((cell, i) => {
              const win      = isWin(i)
              const hovering = hovered === i && canClick(i)
              return (
                <div key={i}
                  onClick={() => handleCellClick(i)}
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}
                  style={{
                    width: CELL, height: CELL,
                    background: win ? P_COLOR[cell as 'X'|'O'] + '22' : 'transparent',
                    ...cellBorders(i),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: canClick(i) ? 'pointer' : 'default',
                    transition: 'background 0.15s',
                    boxSizing: 'border-box',
                  }}
                >
                  {cell === 'X' && <div style={{ width: CELL * 0.56, height: CELL * 0.56, borderRadius: '50%', background: BLUE }} />}
                  {cell === 'O' && <div style={{ width: CELL * 0.56, height: CELL * 0.56, borderRadius: '50%', background: RED  }} />}
                  {hovering    && <div style={{ width: CELL * 0.56, height: CELL * 0.56, borderRadius: '50%', background: P_COLOR[current] + '38' }} />}
                </div>
              )
            })}
          </div>

          {/* Play again */}
          {status !== 'playing' && (
            <div onClick={() => resetGame()} style={{
              padding: '9px 26px', borderRadius: 30,
              background: status === 'x-wins' ? BLUE : status === 'o-wins' ? RED : '#222',
              color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer',
              fontFamily: 'inherit',
            }}
              onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.95)')}
              onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
            >
              {status === 'x-wins' ? '🎉 Play again!' : 'Try again!'}
            </div>
          )}

        </div>

        {/* Mode switcher — pinned to bottom, pill style */}
        <div style={{
          position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', border: '1.5px solid #e8e8e8', borderRadius: 30, overflow: 'hidden',
        }}>
          {(['computer', 'two-player'] as const).map(m => (
            <button key={m} onClick={() => resetGame(m)} style={{
              padding: '5px 16px',
              background: mode === m ? '#ddd' : 'transparent',
              color: mode === m ? '#555' : '#bbb',
              border: 'none', fontSize: 11, fontWeight: mode === m ? 700 : 400,
              cursor: mode === m ? 'default' : 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.15s, color 0.15s',
            }}>
              {m === 'computer' ? 'vs Computer' : '2 Players'}
            </button>
          ))}
        </div>

      </div>
      <IntroText>{intro}</IntroText>
      <SetDone done={hasWon} />
    </>
  )
}

// ─── Chapter 4 / Page 2: Dots and Boxes ──────────────────────────────────────
const DB_N       = 4                      // 4×4 = 16 boxes
const DB_VB_PAD  = 40                     // padding inside the SVG viewBox
const DB_VB_CELL = 80                     // viewBox units per cell
const DB_VB      = 2 * DB_VB_PAD + DB_N * DB_VB_CELL  // = 480  (total viewBox side)
const DB_DOT_R   = 6                      // normal dot radius (viewBox units)
const DB_DOT_SEL = 9                      // selected dot radius
const DB_LW      = 5                      // drawn line stroke-width
const DB_LW_E    = 2                      // empty line stroke-width

// ViewBox position of dot (row, col)
const dbDp = (r: number, c: number) => ({
  x: DB_VB_PAD + c * DB_VB_CELL,
  y: DB_VB_PAD + r * DB_VB_CELL,
})

type DBOwner = null | 'X' | 'O'

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
  isH: boolean, idx: number, player: 'X' | 'O',
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
  const [current, setCurrent] = useState<'X' | 'O'>('X')
  const [hasWon, setHasWon]   = useState(false)
  const [selDot, setSelDot]   = useState<{ r: number; c: number } | null>(null)
  const [hovDot, setHovDot]   = useState<{ r: number; c: number } | null>(null)
  const aiPendingRef = useRef(false)

  const P_COLOR: Record<'X' | 'O', string> = { X: BLUE, O: RED }
  const scoreX   = bBoxes.filter(b => b === 'X').length
  const scoreO   = bBoxes.filter(b => b === 'O').length
  const gameOver = bBoxes.every(b => b !== null)

  const intro: React.ReactNode =
    !gameOver ? 'Click a dot, then click an adjacent dot to draw a line!'
    : scoreX > scoreO ? (mode === 'computer' ? 'You win! 🎉' : 'Blue wins! 🎉')
    : scoreX < scoreO ? (mode === 'computer' ? 'I win! Try again?' : 'Red wins! Try again?')
    : "It's a draw!"

  useEffect(() => {
    if (gameOver && scoreX > scoreO && !hasWon) setHasWon(true)
  }, [gameOver, scoreX, scoreO, hasWon])

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

  function resetGame(newMode?: TTTMode) {
    setMode(newMode ?? mode)
    setHLines(dbMkH()); setVLines(dbMkV()); setBBoxes(dbMkB())
    setCurrent('X'); setHasWon(false); setSelDot(null); setHovDot(null)
    aiPendingRef.current = false
  }

  // Commit a line as the current player, then chain AI if needed
  function commitLine(isH: boolean, idx: number) {
    const res  = dbApply(hLines, vLines, bBoxes, isH, idx, current)
    const next: 'X' | 'O' = res.extra ? current : (current === 'X' ? 'O' : 'X')
    setHLines(res.h); setVLines(res.v); setBBoxes(res.boxes); setCurrent(next)
    setSelDot(null)

    if (mode === 'computer' && next === 'O') {
      aiPendingRef.current = true
      function runAI(ch: DBOwner[], cv: DBOwner[], cb: DBOwner[]) {
        const move = dbAI(ch, cv, cb)
        if (!move) { aiPendingRef.current = false; setCurrent('X'); return }
        const r2   = dbApply(ch, cv, cb, move.isH, move.idx, 'O')
        const np: 'X' | 'O' = r2.extra ? 'O' : 'X'
        setHLines(r2.h); setVLines(r2.v); setBBoxes(r2.boxes); setCurrent(np)
        if (r2.extra) setTimeout(() => runAI(r2.h, r2.v, r2.boxes), 420)
        else aiPendingRef.current = false
      }
      setTimeout(() => runAI(res.h, res.v, res.boxes), 500)
    }
  }

  const isHumanTurn = !gameOver && !aiPendingRef.current && (mode === 'two-player' || current === 'X')

  function handleDotClick(r: number, c: number) {
    if (!isHumanTurn) return
    if (!selDot) {
      if (hasEmptyAdj(r, c)) setSelDot({ r, c })
      return
    }
    if (selDot.r === r && selDot.c === c) { setSelDot(null); return }
    const line = adjacentLine(selDot.r, selDot.c, r, c)
    if (line) { commitLine(line.isH, line.idx); return }
    if (hasEmptyAdj(r, c)) setSelDot({ r, c })
    else setSelDot(null)
  }

  // Ghost lines radiating from the selected dot to all valid empty neighbors
  const ghostLines: { isH: boolean; idx: number; r2: number; c2: number }[] = selDot
    ? (() => {
        const { r, c } = selDot
        return [{ r: r-1, c }, { r: r+1, c }, { r, c: c-1 }, { r, c: c+1 }].flatMap(nb => {
          if (nb.r < 0 || nb.r > DB_N || nb.c < 0 || nb.c > DB_N) return []
          const line = adjacentLine(r, c, nb.r, nb.c)
          return line ? [{ ...line, r2: nb.r, c2: nb.c }] : []
        })
      })()
    : []

  return (
    <>
      {/*
        Layout: flex column so the indicator, board, and mode-switcher divide the
        canvas naturally. The SVG board sits in a flex:1 area and uses viewBox +
        preserveAspectRatio="xMidYMid meet" to fill all available space while
        staying square — zero JS measurement needed.
      */}
      <div style={{ ...canvasStyle, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

        {/* ── Turn / score indicator ── */}
        <div style={{ flexShrink: 0, width: '100%', paddingTop: 18, paddingBottom: 12, display: 'flex', gap: 48, alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit' }}>
          {(['X', 'O'] as const).map(p => {
            const active = current === p && !gameOver
            const label  = mode === 'computer' ? (p === 'X' ? 'You' : 'Me') : (p === 'X' ? 'Blue' : 'Red')
            const score  = p === 'X' ? scoreX : scoreO
            return (
              <div key={p} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: 52 }}>
                <div style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: '50%', background: P_COLOR[p],
                    transform: active ? 'scale(1)' : 'scale(0.55)',
                    opacity: active ? 1 : 0.3,
                    transition: 'transform 0.2s, opacity 0.2s',
                  }} />
                </div>
                <span style={{ fontSize: 15, lineHeight: '18px', fontWeight: active ? 900 : 500, color: active ? '#111' : '#bbb', fontFamily: 'inherit', transition: 'color 0.2s' }}>
                  {label}
                </span>
                <span style={{ fontSize: 22, lineHeight: '26px', fontWeight: 700, color: P_COLOR[p], fontFamily: 'inherit' }}>
                  {score}
                </span>
                <div style={{ height: 3, width: 28, borderRadius: 2, background: P_COLOR[p], opacity: active ? 1 : 0, transition: 'opacity 0.2s' }} />
              </div>
            )
          })}
        </div>

        {/* ── Board — takes all remaining height ── */}
        <div style={{ flex: 1, minHeight: 0, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 32px', boxSizing: 'border-box' }}>
          <svg
            viewBox={`0 0 ${DB_VB} ${DB_VB}`}
            preserveAspectRatio="xMidYMid meet"
            style={{ width: '100%', height: '100%', display: 'block', overflow: 'visible' }}
          >
            {/* Box fills */}
            {bBoxes.map((owner, i) => {
              if (!owner) return null
              const r = Math.floor(i / DB_N), c = i % DB_N
              const { x, y } = dbDp(r, c)
              return <rect key={i} x={x} y={y} width={DB_VB_CELL} height={DB_VB_CELL} fill={P_COLOR[owner] + '2e'} />
            })}

            {/* Horizontal lines */}
            {hLines.map((owner, i) => {
              const row = Math.floor(i / DB_N), col = i % DB_N
              const p1 = dbDp(row, col), p2 = dbDp(row, col + 1)
              return (
                <line key={`h${i}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                  stroke={owner ? P_COLOR[owner] : '#ddd'}
                  strokeWidth={owner ? DB_LW : DB_LW_E} strokeLinecap="round" />
              )
            })}

            {/* Vertical lines */}
            {vLines.map((owner, i) => {
              const row = Math.floor(i / (DB_N + 1)), col = i % (DB_N + 1)
              const p1 = dbDp(row, col), p2 = dbDp(row + 1, col)
              return (
                <line key={`v${i}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                  stroke={owner ? P_COLOR[owner] : '#ddd'}
                  strokeWidth={owner ? DB_LW : DB_LW_E} strokeLinecap="round" />
              )
            })}

            {/* Ghost lines from the selected dot */}
            {ghostLines.map(gl => {
              const p1 = dbDp(selDot!.r, selDot!.c), p2 = dbDp(gl.r2, gl.c2)
              const isTarget = hovDot?.r === gl.r2 && hovDot?.c === gl.c2
              return (
                <line key={`g${gl.isH ? 'h' : 'v'}${gl.idx}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                  stroke={P_COLOR[current] + (isTarget ? 'cc' : '55')}
                  strokeWidth={isTarget ? DB_LW : DB_LW_E * 1.5}
                  strokeLinecap="round" />
              )
            })}

            {/* Dots — rendered last so they sit above lines */}
            {Array.from({ length: DB_N + 1 }, (_, r) =>
              Array.from({ length: DB_N + 1 }, (_, c) => {
                const { x, y } = dbDp(r, c)
                const isSel    = selDot?.r === r && selDot?.c === c
                const isHov    = hovDot?.r === r && hovDot?.c === c
                const canClick = isHumanTurn && hasEmptyAdj(r, c)
                const rr       = isSel ? DB_DOT_SEL : isHov && canClick ? DB_DOT_R * 1.35 : DB_DOT_R
                const fill     = isSel
                  ? P_COLOR[current]
                  : isHov && canClick
                    ? (selDot ? P_COLOR[current] + 'cc' : '#aaa')
                    : '#ccc'
                return (
                  <circle key={`d${r}-${c}`} cx={x} cy={y} r={rr}
                    fill={fill}
                    style={{ cursor: canClick ? 'pointer' : 'default', transition: 'r 0.12s, fill 0.12s' }}
                    onClick={() => handleDotClick(r, c)}
                    onMouseEnter={() => setHovDot({ r, c })}
                    onMouseLeave={() => setHovDot(null)}
                  />
                )
              })
            )}

          </svg>
        </div>

        {/* ── Mode switcher ── */}
        <div style={{ flexShrink: 0, paddingTop: 8, paddingBottom: 16 }}>
          <div style={{ display: 'flex', border: '1.5px solid #e8e8e8', borderRadius: 30, overflow: 'hidden' }}>
            {(['computer', 'two-player'] as const).map(m => (
              <button key={m} onClick={() => resetGame(m)} style={{
                padding: '5px 16px',
                background: mode === m ? '#ddd' : 'transparent',
                color: mode === m ? '#555' : '#bbb',
                border: 'none', fontSize: 11, fontWeight: mode === m ? 700 : 400,
                cursor: mode === m ? 'default' : 'pointer',
                fontFamily: 'inherit',
                transition: 'background 0.15s, color 0.15s',
              }}>
                {m === 'computer' ? 'vs Computer' : '2 Players'}
              </button>
            ))}
          </div>
        </div>

      </div>

      {/* Game-over overlay — shown on top of everything */}
      {gameOver && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 10, pointerEvents: 'auto' }}>
          <div onClick={() => resetGame()} style={{
            padding: '9px 26px', borderRadius: 30,
            background: scoreX > scoreO ? BLUE : scoreX < scoreO ? RED : '#222',
            color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
            boxShadow: '0 4px 20px #0003',
          }}
            onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.95)')}
            onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
          >
            {scoreX > scoreO ? '🎉 Play again!' : scoreX < scoreO ? 'Try again!' : '🤝 Play again!'}
          </div>
        </div>
      )}

      <IntroText>{intro}</IntroText>
      <SetDone done={hasWon} />
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
const CHAPTER4_PAGES: React.ComponentType[] = [TicTacToePage, DotsAndBoxesPage]

export default function PressHere() {
  const [page,       setPage]      = useState(0)
  const [caption,    setCaption]   = useState<React.ReactNode>('')
  const [done,       setDone]      = useState(false)
  const [globalKey,  setGlobalKey] = useState(0)
  const [wellDone,   setWellDone]  = useState(false)
  const [chapter,    setChapter]   = useState(1)
  const [ch2Shapes,  setCh2Shapes] = useState<ShapeDef[]>(() => pickRandomShapes(7))
  const handoffRef     = useRef<Handoff>({ page4Dots: null, page5Dots: null, page6Dots: null, ch2p2Dots: null, ch2LatestDots: null })
  const canvasAreaRef  = useRef<HTMLDivElement>(null)
  const firstRenderRef = useRef(true)

  const activePages = chapter === 1 ? CHAPTER1_PAGES : chapter === 2 ? CHAPTER2_PAGES : chapter === 3 ? CHAPTER3_PAGES : CHAPTER4_PAGES
  const TOTAL = activePages.length
  const isFirst = page === 0
  const isLast  = page === TOTAL - 1

  function nav(next: number) {
    setPage(next)
    setDone(false)
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

  function replayChapter() {
    if (chapter === 2) startChapter2()
    else if (chapter === 3) startChapter3()
    else if (chapter === 4) startChapter4()
    else reset()
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

  // Page-change shadow lift animation
  useLayoutEffect(() => {
    if (firstRenderRef.current) { firstRenderRef.current = false; return }
    const el = canvasAreaRef.current
    if (!el) return
    el.animate(
      [{ boxShadow: 'none' }, { boxShadow: '0 20px 56px rgba(0,0,0,0.18)' }, { boxShadow: 'none' }],
      { duration: 360, easing: 'ease-out' }
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
            height: '100dvh', display: 'flex', flexDirection: 'column',
            background: '#fef9f0', padding: '12px 32px 16px', boxSizing: 'border-box',
            fontFamily: '"Nunito Variable", Nunito, sans-serif', overflow: 'hidden',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
            touchAction: 'manipulation',
          }}>

            {/* ── Header: title + chapter / replay pills ── */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minWidth: 960, marginBottom: 10 }}>
              {/* Title with coloured dots */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 22, fontWeight: 700, color: '#222', letterSpacing: -0.3, fontFamily: 'inherit' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: RED,    flexShrink: 0, display: 'inline-block' }} />
                Press
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: YELLOW, flexShrink: 0, display: 'inline-block' }} />
                here
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: BLUE,   flexShrink: 0, display: 'inline-block' }} />
              </div>
              {/* Chapter pills + Replay */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {([1, 2, 3, 4] as const).map(ch => (
                  <button
                    key={ch}
                    onClick={() => ch === 1 ? reset() : ch === 2 ? startChapter2() : ch === 3 ? startChapter3() : startChapter4()}
                    style={{
                      padding: '4px 14px', borderRadius: 20,
                      background: chapter === ch ? '#333' : 'transparent',
                      border: `1.5px solid ${chapter === ch ? '#333' : '#ddd'}`,
                      fontSize: 12, fontWeight: 700, letterSpacing: '0.02em',
                      color: chapter === ch ? '#fff' : '#bbb',
                      fontFamily: 'inherit',
                      cursor: chapter === ch ? 'default' : 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={e => { if (chapter !== ch) { e.currentTarget.style.borderColor = '#aaa'; e.currentTarget.style.color = '#666' } }}
                    onMouseLeave={e => { if (chapter !== ch) { e.currentTarget.style.borderColor = '#ddd'; e.currentTarget.style.color = '#bbb' } }}
                  >
                    Ch {ch}
                  </button>
                ))}
                <button
                  onClick={replayChapter}
                  title="Replay this chapter"
                  style={{
                    width: 30, height: 30, borderRadius: 20, padding: 0,
                    background: 'transparent', border: '1.5px solid #ddd',
                    color: '#bbb', fontFamily: 'inherit', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'all 0.15s ease', flexShrink: 0,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#aaa'; e.currentTarget.style.color = '#666' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#ddd'; e.currentTarget.style.color = '#bbb' }}
                >
                  <RotateCcw size={13} strokeWidth={2.5} />
                </button>
              </div>
            </div>

            {/* Canvas area — all pages mounted; opacity+pointer-events for transition */}
            <div ref={canvasAreaRef} key={globalKey} style={{ flex: 1, minHeight: 0, position: 'relative', minWidth: 960 }}>
              {activePages.map((P, i) => (
                <PageActiveCtx.Provider key={i} value={i === page}>
                  <div style={{
                    position: 'absolute', inset: 0, display: i === page ? 'flex' : 'none', flexDirection: 'column',
                  }}>
                    <P />
                  </div>
                </PageActiveCtx.Provider>
              ))}
            </div>

            {/* Caption row — caption left-aligned, Next button pinned to the right */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-start', minWidth: 960, marginTop: 14, minHeight: 46 }}>
              <div style={{ fontSize: 'clamp(14px,2vw,18px)', fontWeight: 600, color: '#444', lineHeight: 1.4, maxWidth: 'calc(100% - 260px)' }}>
                {caption}
              </div>
              <button
                onClick={isLast ? () => setWellDone(true) : () => nav(page + 1)}
                style={{
                  position: 'absolute', right: 0,
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 28px', borderRadius: 40,
                  background: '#FDD302', border: 'none',
                  fontSize: 20, fontWeight: 800, color: '#333',
                  fontFamily: 'inherit', cursor: 'pointer',
                  flexShrink: 0,
                  visibility: done ? 'visible' : 'hidden',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#ffc700')}
                onMouseLeave={e => (e.currentTarget.style.background = '#FDD302')}
                onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.96)')}
                onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
              >
                {isLast ? 'Done' : <>Next <ChevronRight size={22} strokeWidth={3} /></>}
              </button>
            </div>

            {/* Footer — dot pagination */}
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minWidth: 960, marginTop: 10, gap: 7 }}>
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
        </HandoffCtx.Provider>
      </DoneCtx.Provider>
    </CaptionCtx.Provider>
    </Ch2ShapesCtx.Provider>
  )
}
