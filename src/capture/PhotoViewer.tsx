import { useEffect, useRef, useState } from 'react'
import { getBlob } from '../store/events'
import { OverlayPortal, cx, layer, motion, type_, useBodyScrollLock } from '../ui'
import {
  IDENTITY_TRANSFORM,
  dismissBackdropOpacity,
  distance,
  doubleTapTarget,
  fitContain,
  isFitScale,
  midpoint,
  pan,
  pinch,
  shouldDismiss,
  wheelZoom,
  zoomAt,
  type PinchStart,
  type Point,
  type Size,
  type Transform,
} from './photoViewerMath'

/** Movement (px) beyond which a pointer-down stops counting as a tap. */
const TAP_SLOP = 8
/** Two taps within this window and radius toggle double-tap zoom. */
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_SLOP = 32

interface PhotoViewerProps {
  /** Object URL (or any src) of the photo. */
  src: string
  /** Caption attachment file, if any — loaded for alt text / dialog label. */
  captionFile?: string
  onClose: () => void
  /** When provided, renders the "Remove photo" action. */
  onRemove?: () => void
}

/** Single-pointer gesture in flight: a pan (zoomed), swipe-dismiss (fit), or tap. */
interface DragState {
  origin: Point
  /** Transform when the pointer landed; pan applies deltas against it. */
  base: Transform
  moved: boolean
  /** Whether the pointer landed on the photo itself (captured at pointerdown:
   * setPointerCapture retargets later events to the container). */
  onImage: boolean
  lastY: number
  lastTime: number
  /** Vertical velocity, px/ms, from the most recent move. */
  vy: number
}

/**
 * Full-screen photo viewer (B7): edge-to-edge on a black backdrop, image
 * fit-contained. Gestures — pinch-to-zoom around the pinch midpoint,
 * double-tap to toggle fit ↔ 2.5× at the tap point, one-finger pan while
 * zoomed (clamped to the image), wheel/trackpad zoom on desktop. Dismissal —
 * close button (safe-area aware), backdrop tap at fit, swipe-down at fit
 * (image follows the finger, backdrop fades), and Escape. While zoomed,
 * one finger pans instead of dismissing, and the body is scroll-locked.
 *
 * All geometry lives in photoViewerMath.ts (pure, tested); this component
 * only wires pointer events to it. Mounted via OverlayPortal on
 * layer.overlay — see src/ui/tokens.ts for why overlays must portal. The
 * entrance animation stays on a wrapper (fill `both` would pin the img's
 * `transform` and fight the gesture transform).
 */
export function PhotoViewer({ src, captionFile, onClose, onRemove }: PhotoViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  const [containerSize, setContainerSize] = useState<Size | null>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [transform, setTransformState] = useState<Transform>(IDENTITY_TRANSFORM)
  const [dismissY, setDismissYState] = useState(0)
  /** Transition transform/opacity only for programmatic moves (double-tap, snap-back). */
  const [animate, setAnimate] = useState(false)
  const [alt, setAlt] = useState('Photo')

  // Handler-visible mirrors of the geometry/gesture state (the manual wheel
  // listener and multi-event gestures must not read stale closures).
  const transformRef = useRef(transform)
  const dismissRef = useRef(0)
  const geomRef = useRef<{ container: Size; base: Size } | null>(null)
  const pointers = useRef(new Map<number, Point>())
  const pinchRef = useRef<PinchStart | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const lastTap = useRef<{ point: Point; time: number } | null>(null)

  const setTransform = (t: Transform) => {
    transformRef.current = t
    setTransformState(t)
  }
  const setDismissY = (y: number) => {
    dismissRef.current = y
    setDismissYState(y)
  }

  useBodyScrollLock()

  // Track the container size (rotation, browser chrome collapse).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setContainerSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Geometry for the gesture math; re-fit and re-clamp when it changes.
  const base = containerSize && natural ? fitContain(containerSize, natural) : null
  useEffect(() => {
    if (!containerSize || !base || base.width === 0) {
      geomRef.current = null
      return
    }
    geomRef.current = { container: containerSize, base }
    // A rotate/resize changes the bounds: keep the current view but legal.
    setTransform(pan(transformRef.current, { x: 0, y: 0 }, containerSize, base))
    // deps: `base` is derived from exactly these two.
  }, [containerSize, natural])

  // Alt text from the photo's caption attachment, when one exists.
  useEffect(() => {
    if (captionFile === undefined) return
    let stale = false
    void getBlob(captionFile).then(async (blob) => {
      if (!blob || stale) return
      const text = (await blob.text()).trim()
      if (text && !stale) setAlt(text)
    })
    return () => {
      stale = true
    }
  }, [captionFile])

  // Desktop: Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Focus the close button on open; return focus on close.
  useEffect(() => {
    const previous = document.activeElement
    closeRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  // Wheel/trackpad zoom, anchored at the cursor. Attached manually because
  // React registers wheel listeners passively, and zooming must
  // preventDefault to stop page scroll/browser zoom.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const geom = geomRef.current
      if (!geom) return
      const rect = el.getBoundingClientRect()
      const anchor = {
        x: e.clientX - rect.left - rect.width / 2,
        y: e.clientY - rect.top - rect.height / 2,
      }
      setAnimate(false)
      setTransform(wheelZoom(transformRef.current, anchor, e.deltaY, geom.container, geom.base))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // deps: reads only refs and stable setters.
  }, [])

  /** Pointer position relative to the container center (the math's frame). */
  const toAnchor = (e: React.PointerEvent): Point => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: e.clientX - rect.left - rect.width / 2,
      y: e.clientY - rect.top - rect.height / 2,
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    // Buttons handle their own clicks; don't start a gesture under them.
    if (e.target instanceof Element && e.target.closest('button')) return
    containerRef.current?.setPointerCapture(e.pointerId)
    const p = toAnchor(e)
    pointers.current.set(e.pointerId, p)
    setAnimate(false)
    if (pointers.current.size === 2) {
      // Second finger: a pinch takes over from any pan/dismiss in flight.
      dragRef.current = null
      if (dismissRef.current !== 0) setDismissY(0)
      const [a, b] = [...pointers.current.values()]
      pinchRef.current = { transform: transformRef.current, mid: midpoint(a, b), dist: distance(a, b) }
    } else if (pointers.current.size === 1) {
      dragRef.current = {
        origin: p,
        base: transformRef.current,
        moved: false,
        onImage: e.target === imgRef.current,
        lastY: p.y,
        lastTime: e.timeStamp,
        vy: 0,
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    const p = toAnchor(e)
    pointers.current.set(e.pointerId, p)
    const geom = geomRef.current
    if (!geom) return
    if (pinchRef.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      setTransform(pinch(pinchRef.current, midpoint(a, b), distance(a, b), geom.container, geom.base))
      return
    }
    const drag = dragRef.current
    if (!drag) return
    const dx = p.x - drag.origin.x
    const dy = p.y - drag.origin.y
    if (!drag.moved && Math.hypot(dx, dy) > TAP_SLOP) drag.moved = true
    const dt = e.timeStamp - drag.lastTime
    if (dt > 0) {
      drag.vy = (p.y - drag.lastY) / dt
      drag.lastY = p.y
      drag.lastTime = e.timeStamp
    }
    if (!drag.moved) return
    if (isFitScale(drag.base.scale)) {
      // At fit: vertical drag is swipe-to-dismiss feedback (downward only).
      setDismissY(Math.max(0, dy))
    } else {
      // Zoomed: one finger pans, clamped — never dismisses or scrolls behind.
      setTransform(pan(drag.base, { x: dx, y: dy }, geom.container, geom.base))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return
    if (pinchRef.current) {
      pinchRef.current = null
      // Hand off to a pan when one finger stays down.
      const rest = [...pointers.current.values()]
      if (rest.length === 1) {
        dragRef.current = {
          origin: rest[0],
          base: transformRef.current,
          moved: true,
          onImage: false,
          lastY: rest[0].y,
          lastTime: e.timeStamp,
          vy: 0,
        }
      }
      return
    }
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (drag.moved) {
      if (dismissRef.current > 0) {
        if (shouldDismiss(dismissRef.current, drag.vy)) {
          onClose()
        } else {
          setAnimate(true)
          setDismissY(0)
        }
      }
      return
    }
    // An unmoved release is a tap: double-tap toggles zoom at the point…
    const p = toAnchor(e)
    const prev = lastTap.current
    if (
      prev &&
      e.timeStamp - prev.time < DOUBLE_TAP_MS &&
      distance(p, prev.point) < DOUBLE_TAP_SLOP
    ) {
      lastTap.current = null
      const geom = geomRef.current
      if (!geom) return
      const target = doubleTapTarget(transformRef.current.scale)
      setAnimate(true)
      setTransform(
        isFitScale(target)
          ? IDENTITY_TRANSFORM
          : zoomAt(transformRef.current, p, target, geom.container, geom.base),
      )
      return
    }
    lastTap.current = { point: p, time: e.timeStamp }
    // …and a single tap on the backdrop (not the photo) closes at fit zoom.
    if (!drag.onImage && isFitScale(transformRef.current.scale)) onClose()
  }

  const onPointerCancel = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    pinchRef.current = null
    dragRef.current = null
    if (dismissRef.current !== 0) {
      setAnimate(true)
      setDismissY(0)
    }
  }

  // Minimal focus trap: Tab cycles within the dialog's controls.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const root = containerRef.current
    if (!root) return
    const controls = [...root.querySelectorAll<HTMLElement>('button')]
    if (controls.length === 0) return
    const first = controls[0]
    const last = controls[controls.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !(active instanceof Element) || !root.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <OverlayPortal>
      {/* touch-none routes every touch to pointer events (no page pan/zoom). */}
      <div
        ref={containerRef}
        className={cx(
          'fixed inset-0 touch-none select-none overflow-hidden',
          layer.overlay,
          motion.fadeIn,
        )}
        role="dialog"
        aria-modal="true"
        aria-label={alt}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
      >
        <div
          aria-hidden="true"
          className={cx('absolute inset-0 bg-black', animate && 'transition-opacity duration-200')}
          style={{ opacity: dismissBackdropOpacity(dismissY) }}
        />
        {/* Entrance animation lives here, not on the img (see component doc). */}
        <div
          className={cx(
            'absolute inset-0 flex items-center justify-center',
            motion.scaleIn,
          )}
        >
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            draggable={false}
            onLoad={(e) =>
              setNatural({
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              })
            }
            className={cx('max-w-none', animate && 'transition-transform duration-200 ease-out')}
            style={
              base && base.width > 0
                ? {
                    width: base.width,
                    height: base.height,
                    transform: `translate3d(${transform.offsetX}px, ${
                      transform.offsetY + dismissY
                    }px, 0) scale(${transform.scale})`,
                  }
                : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
            }
          />
        </div>
        <button
          ref={closeRef}
          onClick={onClose}
          aria-label="Close photo"
          className="absolute flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm"
          style={{
            top: 'max(env(safe-area-inset-top), 0.75rem)',
            right: 'max(env(safe-area-inset-right), 0.75rem)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M3 3l10 10M13 3L3 13"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {onRemove && (
          <button
            onClick={onRemove}
            className={cx(
              'absolute left-1/2 -translate-x-1/2 rounded-xl bg-white/15 px-5 py-2.5 font-medium text-white backdrop-blur-sm',
              type_.ui,
            )}
            style={{ bottom: 'max(env(safe-area-inset-bottom), 1rem)' }}
          >
            Remove photo
          </button>
        )}
      </div>
    </OverlayPortal>
  )
}
