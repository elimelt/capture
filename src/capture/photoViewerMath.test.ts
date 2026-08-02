import { describe, expect, it } from 'vitest'
import {
  DOUBLE_TAP_SCALE,
  FIT_SCALE,
  IDENTITY_TRANSFORM,
  MAX_SCALE,
  clampOffset,
  clampScale,
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
  type Point,
  type Size,
  type Transform,
} from './photoViewerMath'

/** Portrait-phone container used throughout. */
const container: Size = { width: 400, height: 800 }

/** Screen position (from container center) of fitted-image content point q. */
function screenPos(q: Point, t: Transform): Point {
  return { x: q.x * t.scale + t.offsetX, y: q.y * t.scale + t.offsetY }
}

describe('fitContain', () => {
  it('fits a landscape image by width in a portrait container', () => {
    // 4000×2000 in 400×800: width is the limiting axis (ratio 0.1 vs 0.4).
    expect(fitContain(container, { width: 4000, height: 2000 })).toEqual({
      width: 400,
      height: 200,
    })
  })

  it('fits a portrait image by height when height limits', () => {
    // 2000×4000 in 400×800: ratios 0.2 vs 0.2 — exact fill both ways.
    expect(fitContain(container, { width: 2000, height: 4000 })).toEqual({
      width: 400,
      height: 800,
    })
    // 1000×4000: ratios 0.4 vs 0.2 — height limits.
    expect(fitContain(container, { width: 1000, height: 4000 })).toEqual({
      width: 200,
      height: 800,
    })
  })

  it('fits a very tall (screenshot-like) image by height, preserving aspect', () => {
    const fit = fitContain(container, { width: 500, height: 10000 })
    expect(fit.height).toBe(800)
    expect(fit.width).toBeCloseTo(40)
    expect(fit.width / fit.height).toBeCloseTo(500 / 10000)
  })

  it('upscales images smaller than the container (full-screen viewer)', () => {
    expect(fitContain(container, { width: 100, height: 100 })).toEqual({
      width: 400,
      height: 400,
    })
  })

  it('collapses degenerate sizes to 0×0 instead of NaN/Infinity', () => {
    expect(fitContain(container, { width: 0, height: 0 })).toEqual({ width: 0, height: 0 })
    expect(fitContain({ width: 0, height: 0 }, { width: 100, height: 100 })).toEqual({
      width: 0,
      height: 0,
    })
  })
})

describe('clampScale / isFitScale', () => {
  it('clamps into [FIT_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.2)).toBe(FIT_SCALE)
    expect(clampScale(2)).toBe(2)
    expect(clampScale(99)).toBe(MAX_SCALE)
  })

  it('treats scales within epsilon of fit as fit', () => {
    expect(isFitScale(1)).toBe(true)
    expect(isFitScale(1.005)).toBe(true)
    expect(isFitScale(1.05)).toBe(false)
    expect(isFitScale(2.5)).toBe(false)
  })
})

describe('clampOffset', () => {
  // Landscape photo fit to 400×200 in the 400×800 container.
  const base: Size = { width: 400, height: 200 }

  it('centers (offset 0) on axes where the scaled image is smaller', () => {
    // At fit the image matches the container width and is shorter: no travel.
    expect(clampOffset({ x: 50, y: -120 }, 1, container, base)).toEqual({ x: 0, y: 0 })
  })

  it('allows exactly half the overhang per side once zoomed', () => {
    // ×3 → 1200×600: overhang 800 wide (±400), image still shorter (600<800): y pinned.
    expect(clampOffset({ x: 1000, y: 40 }, 3, container, base)).toEqual({ x: 400, y: 0 })
    expect(clampOffset({ x: -1000, y: -40 }, 3, container, base)).toEqual({ x: -400, y: 0 })
  })

  it('passes through offsets already within bounds', () => {
    // ×4 → 1600×800: x travel ±600, y travel 0 (exactly container height).
    expect(clampOffset({ x: -123, y: 0 }, 4, container, base)).toEqual({ x: -123, y: 0 })
  })

  it('clamps both axes independently for a zoomed portrait image', () => {
    const tall: Size = { width: 200, height: 800 } // fit for a 1×4 image
    // ×2 → 400×1600: x pinned (400=400), y travel ±400.
    expect(clampOffset({ x: 60, y: 500 }, 2, container, tall)).toEqual({ x: 0, y: 400 })
  })
})

describe('zoomAt', () => {
  const base: Size = { width: 400, height: 200 }

  it('keeps the content under the anchor fixed while zooming (invariant)', () => {
    // A base with travel room on both axes so clamping stays out of the way.
    const roomy: Size = { width: 400, height: 400 }
    const t: Transform = { scale: 2, offsetX: 30, offsetY: 0 }
    const anchor: Point = { x: 80, y: 40 }
    // Content point currently under the anchor, in fitted-image coords.
    const q: Point = { x: (anchor.x - t.offsetX) / t.scale, y: (anchor.y - t.offsetY) / t.scale }
    const zoomed = zoomAt(t, anchor, 3, container, roomy)
    expect(zoomed.scale).toBe(3)
    const after = screenPos(q, zoomed)
    expect(after.x).toBeCloseTo(anchor.x)
    expect(after.y).toBeCloseTo(anchor.y)
  })

  it('clamps the target scale to MAX_SCALE and FIT_SCALE', () => {
    expect(zoomAt(IDENTITY_TRANSFORM, { x: 0, y: 0 }, 100, container, base).scale).toBe(MAX_SCALE)
    expect(zoomAt(IDENTITY_TRANSFORM, { x: 0, y: 0 }, 0.1, container, base).scale).toBe(FIT_SCALE)
  })

  it('recenters exactly when zooming back out to fit', () => {
    const zoomedIn = zoomAt(IDENTITY_TRANSFORM, { x: 150, y: 0 }, 3, container, base)
    expect(zoomedIn.offsetX).not.toBe(0)
    expect(zoomAt(zoomedIn, { x: -100, y: 60 }, 1, container, base)).toEqual(IDENTITY_TRANSFORM)
  })

  it('clamps the anchored offset at the image edge (anchor invariant yields to bounds)', () => {
    // Zoom around the far right edge: unclamped offset would exceed travel.
    const zoomed = zoomAt(IDENTITY_TRANSFORM, { x: 200, y: 0 }, 4, container, base)
    // ×4 → 1600 wide, travel ±600. Unclamped: 200 − (200−0)·4 = −600 → within.
    expect(zoomed.offsetX).toBe(-600)
    // Anchor beyond the image edge clamps.
    const over = zoomAt(IDENTITY_TRANSFORM, { x: 400, y: 0 }, 4, container, base)
    expect(over.offsetX).toBe(-600)
    // y never gains travel (800 = container height at ×4).
    expect(zoomed.offsetY).toBe(0)
  })
})

describe('pan', () => {
  const base: Size = { width: 400, height: 200 }

  it('does not move at fit zoom (no overhang, both axes pinned)', () => {
    expect(pan(IDENTITY_TRANSFORM, { x: 40, y: -30 }, container, base)).toEqual(
      IDENTITY_TRANSFORM,
    )
  })

  it('translates freely inside bounds and clamps at the edges', () => {
    const t: Transform = { scale: 4, offsetX: 0, offsetY: 0 } // x travel ±600, y 0
    expect(pan(t, { x: -200, y: 10 }, container, base)).toEqual({
      scale: 4,
      offsetX: -200,
      offsetY: 0,
    })
    expect(pan(t, { x: -9999, y: 0 }, container, base).offsetX).toBe(-600)
    expect(pan(t, { x: 9999, y: 0 }, container, base).offsetX).toBe(600)
  })
})

describe('pinch', () => {
  const base: Size = { width: 400, height: 200 }

  it('scales by the ratio of finger distances', () => {
    const start = { transform: IDENTITY_TRANSFORM, mid: { x: 0, y: 0 }, dist: 100 }
    expect(pinch(start, { x: 0, y: 0 }, 250, container, base).scale).toBe(2.5)
  })

  it('keeps the content under the (moving) midpoint — zoom and pan combined', () => {
    // Portrait base filling the container: travel on both axes when zoomed.
    const roomy: Size = { width: 400, height: 800 }
    const t0: Transform = { scale: 2, offsetX: -50, offsetY: 0 }
    const start = { transform: t0, mid: { x: 60, y: 20 }, dist: 120 }
    const q: Point = {
      x: (start.mid.x - t0.offsetX) / t0.scale,
      y: (start.mid.y - t0.offsetY) / t0.scale,
    }
    const mid: Point = { x: 20, y: -10 } // fingers drifted while spreading
    const result = pinch(start, mid, 180, container, roomy)
    expect(result.scale).toBe(3)
    const after = screenPos(q, result)
    expect(after.x).toBeCloseTo(mid.x)
    expect(after.y).toBeCloseTo(mid.y)
  })

  it('clamps scale at both ends and survives a zero start distance', () => {
    const start = { transform: IDENTITY_TRANSFORM, mid: { x: 0, y: 0 }, dist: 100 }
    expect(pinch(start, { x: 0, y: 0 }, 10, container, base).scale).toBe(FIT_SCALE)
    expect(pinch(start, { x: 0, y: 0 }, 100000, container, base).scale).toBe(MAX_SCALE)
    const degenerate = { transform: IDENTITY_TRANSFORM, mid: { x: 0, y: 0 }, dist: 0 }
    expect(pinch(degenerate, { x: 0, y: 0 }, 300, container, base).scale).toBe(FIT_SCALE)
  })

  it('pinching out below fit clamps to fit and recenters', () => {
    const start = { transform: IDENTITY_TRANSFORM, mid: { x: 90, y: 30 }, dist: 200 }
    expect(pinch(start, { x: 90, y: 30 }, 100, container, base)).toEqual(IDENTITY_TRANSFORM)
  })
})

describe('doubleTapTarget', () => {
  it('toggles fit → DOUBLE_TAP_SCALE → fit', () => {
    expect(doubleTapTarget(FIT_SCALE)).toBe(DOUBLE_TAP_SCALE)
    expect(doubleTapTarget(DOUBLE_TAP_SCALE)).toBe(FIT_SCALE)
  })

  it('returns to fit from any intermediate zoom (e.g. after a pinch)', () => {
    expect(doubleTapTarget(1.4)).toBe(FIT_SCALE)
    expect(doubleTapTarget(MAX_SCALE)).toBe(FIT_SCALE)
  })
})

describe('wheelZoom', () => {
  const base: Size = { width: 400, height: 200 }

  it('zooms in on negative deltaY, out on positive, anchored at the cursor', () => {
    const anchor: Point = { x: 100, y: 50 }
    const zoomedIn = wheelZoom(IDENTITY_TRANSFORM, anchor, -300, container, base)
    expect(zoomedIn.scale).toBeGreaterThan(1)
    const q: Point = { x: anchor.x, y: anchor.y } // at fit, content coord = screen coord
    const after = screenPos(q, { ...zoomedIn, offsetY: zoomedIn.offsetY })
    // y travel may clamp for this short image; x anchor holds within travel.
    expect(after.x).toBeCloseTo(anchor.x)
    expect(wheelZoom(zoomedIn, anchor, 300, container, base).scale).toBeCloseTo(1)
  })

  it('steps compose: equal deltas multiply, opposite deltas cancel', () => {
    const a = wheelZoom(IDENTITY_TRANSFORM, { x: 0, y: 0 }, -100, container, base)
    const b = wheelZoom(a, { x: 0, y: 0 }, -100, container, base)
    expect(b.scale).toBeCloseTo(a.scale * a.scale)
    expect(wheelZoom(b, { x: 0, y: 0 }, -200, container, base).scale).toBeCloseTo(
      b.scale * b.scale,
    )
  })

  it('never exceeds the scale bounds', () => {
    expect(wheelZoom(IDENTITY_TRANSFORM, { x: 0, y: 0 }, -100000, container, base).scale).toBe(
      MAX_SCALE,
    )
    expect(wheelZoom(IDENTITY_TRANSFORM, { x: 0, y: 0 }, 100000, container, base)).toEqual(
      IDENTITY_TRANSFORM,
    )
  })
})

describe('shouldDismiss', () => {
  it('dismisses on a long drag regardless of velocity', () => {
    expect(shouldDismiss(101, 0)).toBe(true)
    expect(shouldDismiss(300, -1)).toBe(true)
  })

  it('dismisses on a fast downward flick with more than incidental travel', () => {
    expect(shouldDismiss(40, 0.8)).toBe(true)
    expect(shouldDismiss(10, 5)).toBe(false) // barely moved: likely a tap wobble
  })

  it('holds on short slow drags and upward motion', () => {
    expect(shouldDismiss(60, 0.1)).toBe(false)
    expect(shouldDismiss(60, -2)).toBe(false)
    expect(shouldDismiss(0, 0)).toBe(false)
  })
})

describe('dismissBackdropOpacity', () => {
  it('is fully opaque at rest and fades with travel, floored at 0.5', () => {
    expect(dismissBackdropOpacity(0)).toBe(1)
    expect(dismissBackdropOpacity(100)).toBeCloseTo(0.75)
    expect(dismissBackdropOpacity(400)).toBe(0.5)
    expect(dismissBackdropOpacity(2000)).toBe(0.5)
    expect(dismissBackdropOpacity(-50)).toBe(1) // upward drags never brighten past 1
  })
})

describe('midpoint / distance', () => {
  it('computes the two-finger midpoint and separation', () => {
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 })
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(distance({ x: -3, y: 0 }, { x: 0, y: -4 })).toBe(5)
  })
})
