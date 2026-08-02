import { useEffect, useRef } from 'react'

const BAR_COUNT = 36
const BAR_GAP = 3
const BAR_WIDTH = 3

/**
 * Scrolling live input-level bars (A1): visible proof the mic is hearing you.
 * Samples `getLevel()` (0..1 RMS) on rAF and draws right-to-left history.
 */
export function LevelMeter({ getLevel }: { getLevel: () => number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const historyRef = useRef<number[]>([])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const width = BAR_COUNT * (BAR_WIDTH + BAR_GAP)
    const height = 40
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    ctx.scale(dpr, dpr)

    let raf = 0
    let lastSample = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      // ~50ms per bar so the strip covers the last ~2s.
      if (now - lastSample >= 50) {
        lastSample = now
        const history = historyRef.current
        history.push(Math.min(1, getLevel() * 2.5))
        if (history.length > BAR_COUNT) history.shift()
      }
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      const history = historyRef.current
      for (let i = 0; i < history.length; i++) {
        const h = Math.max(3, history[i] * height)
        const x = width - (history.length - i) * (BAR_WIDTH + BAR_GAP)
        ctx.beginPath()
        ctx.roundRect(x, (height - h) / 2, BAR_WIDTH, h, 1.5)
        ctx.fill()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [getLevel])

  return <canvas ref={canvasRef} aria-hidden="true" />
}
