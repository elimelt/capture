/**
 * Pure geometry for the full-screen photo viewer (PhotoViewer.tsx): fit
 * calculation, zoom-around-a-point, offset clamping, pinch/pan/double-tap
 * transforms, and swipe-down-dismiss thresholds. No DOM — everything is
 * testable with plain numbers (photoViewerMath.test.ts).
 *
 * Coordinate system: `scale` is relative to the *fitted* image (1 = the
 * image exactly fit-contained in the container). `offsetX`/`offsetY` are
 * screen pixels translating the image center away from the container
 * center, applied after scaling (CSS `translate(…) scale(…)` — CSS applies
 * right-to-left, so scale first, then translate). Anchor points (taps,
 * pinch midpoints, cursor positions) are measured from the container
 * center in the same screen pixels.
 *
 * The invariant every zoom operation preserves: the image content under
 * the anchor point stays under the anchor point. A content point at
 * fitted-image coordinate q (from the image center) renders on screen at
 * `q·scale + offset`, so holding anchor A fixed across scale s→s′ means
 * `offset′ = A − (A − offset)·s′/s`.
 */

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface Transform {
  /** Zoom relative to the fitted image; 1 = fit. */
  scale: number
  /** Screen-px translation of the image center from the container center. */
  offsetX: number
  offsetY: number
}

/** Two-pointer gesture baseline captured when the second finger lands. */
export interface PinchStart {
  transform: Transform
  mid: Point
  dist: number
}

/** Fit-contained (minimum) zoom. */
export const FIT_SCALE = 1
/** Maximum zoom, relative to fit. */
export const MAX_SCALE = 4
/** Double-tap zooms to ~2.5× fit. */
export const DOUBLE_TAP_SCALE = 2.5

/** `scale` values within this of FIT_SCALE count as "at fit". */
const FIT_EPSILON = 0.01

export const IDENTITY_TRANSFORM: Transform = { scale: FIT_SCALE, offsetX: 0, offsetY: 0 }

/**
 * Size of the image fit-contained in the container (preserving aspect
 * ratio, touching the container on the limiting axis). Small images are
 * scaled *up* to fill — this is a full-screen viewer. Degenerate sizes
 * collapse to 0×0 rather than NaN.
 */
export function fitContain(container: Size, image: Size): Size {
  if (container.width <= 0 || container.height <= 0 || image.width <= 0 || image.height <= 0) {
    return { width: 0, height: 0 }
  }
  const ratio = Math.min(container.width / image.width, container.height / image.height)
  return { width: image.width * ratio, height: image.height * ratio }
}

export function clampScale(scale: number): number {
  return Math.min(Math.max(scale, FIT_SCALE), MAX_SCALE)
}

/** Whether the viewer is (effectively) at fit zoom. */
export function isFitScale(scale: number): boolean {
  return scale <= FIT_SCALE + FIT_EPSILON
}

/**
 * Clamp an offset so the scaled image never pulls an edge inside the
 * container: on any axis where the scaled image is larger than the
 * container the offset may range ±(overhang/2); where it is smaller the
 * image stays centered (offset 0).
 */
export function clampOffset(offset: Point, scale: number, container: Size, base: Size): Point {
  const maxX = Math.max(0, (base.width * scale - container.width) / 2)
  const maxY = Math.max(0, (base.height * scale - container.height) / 2)
  // `+ 0` normalizes -0 (from clamping against -max) to +0.
  return {
    x: Math.min(Math.max(offset.x, -maxX), maxX) + 0,
    y: Math.min(Math.max(offset.y, -maxY), maxY) + 0,
  }
}

/**
 * Rescale toward `targetScale` keeping the content under `anchor` fixed
 * (see module invariant), then clamp scale to [FIT_SCALE, MAX_SCALE] and
 * the offset to the image bounds. Zooming all the way out therefore lands
 * exactly on the centered fit transform.
 */
export function zoomAt(
  t: Transform,
  anchor: Point,
  targetScale: number,
  container: Size,
  base: Size,
): Transform {
  const scale = clampScale(targetScale)
  const ratio = scale / t.scale
  const offset = clampOffset(
    {
      x: anchor.x - (anchor.x - t.offsetX) * ratio,
      y: anchor.y - (anchor.y - t.offsetY) * ratio,
    },
    scale,
    container,
    base,
  )
  return { scale, offsetX: offset.x, offsetY: offset.y }
}

/** Translate by a drag delta, clamped to the image bounds. */
export function pan(t: Transform, delta: Point, container: Size, base: Size): Transform {
  const offset = clampOffset(
    { x: t.offsetX + delta.x, y: t.offsetY + delta.y },
    t.scale,
    container,
    base,
  )
  return { scale: t.scale, offsetX: offset.x, offsetY: offset.y }
}

/**
 * Two-pointer pinch: scale by the ratio of finger distances and keep the
 * content that was under the start midpoint under the current midpoint —
 * so a pinch simultaneously zooms around the fingers and pans with them.
 */
export function pinch(
  start: PinchStart,
  mid: Point,
  dist: number,
  container: Size,
  base: Size,
): Transform {
  const t0 = start.transform
  const scale = clampScale(start.dist > 0 ? t0.scale * (dist / start.dist) : t0.scale)
  const ratio = scale / t0.scale
  const offset = clampOffset(
    {
      x: mid.x - (start.mid.x - t0.offsetX) * ratio,
      y: mid.y - (start.mid.y - t0.offsetY) * ratio,
    },
    scale,
    container,
    base,
  )
  return { scale, offsetX: offset.x, offsetY: offset.y }
}

/**
 * Double-tap toggle: any zoomed-in state returns to fit; at fit, zoom to
 * DOUBLE_TAP_SCALE (the caller anchors it at the tap point via zoomAt).
 */
export function doubleTapTarget(scale: number): number {
  return isFitScale(scale) ? DOUBLE_TAP_SCALE : FIT_SCALE
}

/** Wheel/trackpad zoom: exponential in deltaY so steps compose smoothly. */
export function wheelZoom(
  t: Transform,
  anchor: Point,
  deltaY: number,
  container: Size,
  base: Size,
): Transform {
  return zoomAt(t, anchor, t.scale * Math.exp(-deltaY * 0.002), container, base)
}

/**
 * Whether releasing a swipe-down (at fit zoom) dismisses the viewer:
 * either the photo was dragged far enough, or flicked — a fast downward
 * velocity (px/ms) with more than incidental travel.
 */
export function shouldDismiss(dy: number, velocityY: number): boolean {
  return dy > 100 || (dy > 24 && velocityY > 0.5)
}

/** Backdrop opacity while swipe-dismissing: fades with travel, floored. */
export function dismissBackdropOpacity(dy: number): number {
  return Math.max(0.5, 1 - Math.max(0, dy) / 400)
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}
