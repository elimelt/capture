/**
 * Pure waveform math (#86): reduces decoded PCM samples to a small number of
 * normalized peak buckets (`peaks`) and turns those buckets into bar
 * geometry for rendering (`drawSpec`) — the same split as
 * `photoViewerMath.ts` (pure geometry, no DOM, no I/O). Named `waveformMath`
 * rather than `waveform` (the issue's suggested name) to avoid colliding
 * with `Waveform.tsx` on case-insensitive filesystems, mirroring the
 * `PhotoViewer.tsx`/`photoViewerMath.ts` pairing this module already follows.
 * `Waveform.tsx` is the only caller that touches the DOM/Web Audio;
 * everything here is plain arrays and numbers so it is unit-testable
 * without jsdom.
 *
 * `peaks` matches `LevelMeter`'s 36-bar visual language (a live antecedent:
 * capture shows the waveform being born via `LevelMeter`, the card keeps it
 * via this module) — `WAVEFORM_BUCKETS` sits in the same N ≈ 28–36 range.
 */

/** Bucket count for a clip's fingerprint (issue #86 requirement 1: N ≈ 28–36). */
export const WAVEFORM_BUCKETS = 32

/** `drawSpec`'s minimum bar height in px — mirrors `LevelMeter`'s 3px floor. */
export const MIN_BAR_HEIGHT = 3

/** A single drawable bar in the caller's width×height box. */
export interface Bar {
  x: number
  y: number
  width: number
  height: number
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * Reduces `samples` (decoded PCM, one channel) to `buckets` normalized peak
 * values in `[0, 1]`. Deterministic: same input always yields the same
 * output, no randomness, no wall-clock.
 *
 * - Each bucket holds the max absolute sample value in its (possibly
 *   fractional-boundary) window; non-finite samples (NaN/Infinity — decoders
 *   can hand back either on malformed input) are treated as 0 rather than
 *   propagating.
 * - The whole result is normalized so the loudest bucket is exactly 1 —
 *   unless every sample is silent (all-zero, or `samples` is empty), in
 *   which case every bucket is 0 rather than dividing by zero.
 * - `samples.length < buckets` (short clips) still yields exactly `buckets`
 *   values: window bounds are computed from fractional positions
 *   (`b/buckets * n`) and widened to at least one sample wide, so no bucket
 *   silently reads an empty range.
 */
export function peaks(samples: Float32Array | readonly number[], buckets: number): number[] {
  if (buckets <= 0) return []
  const n = samples.length
  if (n === 0) return Array.from({ length: buckets }, () => 0)

  const raw: number[] = Array.from({ length: buckets }, () => 0)
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b / buckets) * n)
    const end = Math.min(n, Math.max(start + 1, Math.floor(((b + 1) / buckets) * n)))
    let peak = 0
    for (let i = start; i < end; i++) {
      const v = samples[i]
      const abs = Number.isFinite(v) ? Math.abs(v) : 0
      if (abs > peak) peak = abs
    }
    raw[b] = peak
  }

  const max = raw.reduce((m: number, v: number) => Math.max(m, v), 0)
  if (max <= 0) return raw.map(() => 0)
  return raw.map((v: number) => clamp01(v / max))
}

/**
 * Turns normalized `peaksArr` (as from `peaks`) into bar geometry inside a
 * `width`×`height` box, vertically centered. Pure — no DOM; `Waveform.tsx`
 * draws these bars into an SVG/canvas.
 *
 * Every bar is at least `min(MIN_BAR_HEIGHT, height)` tall (matching
 * `LevelMeter`'s 3px-minimum convention) so a silent clip — or the neutral
 * placeholder rendered while decoding — still shows a hairline strip instead
 * of vanishing. Out-of-range/non-finite peak values are clamped to `[0, 1]`
 * so a decoder's stray NaN never produces a NaN rect. Degenerate boxes
 * (non-positive width/height, or an empty `peaksArr`) yield no bars.
 */
export function drawSpec(peaksArr: readonly number[], width: number, height: number): Bar[] {
  const n = peaksArr.length
  if (n === 0 || width <= 0 || height <= 0) return []
  const slot = width / n
  const barWidth = Math.max(1, slot * 0.6)
  const minHeight = Math.min(MIN_BAR_HEIGHT, height)
  return peaksArr.map((p, i) => {
    const level = clamp01(p)
    const h = Math.max(minHeight, level * height)
    const x = i * slot + (slot - barWidth) / 2
    const y = (height - h) / 2
    return { x, y, width: barWidth, height: h }
  })
}
