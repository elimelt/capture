import { describe, expect, it } from 'vitest'
import { MIN_BAR_HEIGHT, WAVEFORM_BUCKETS, drawSpec, peaks } from './waveformMath'

/** A deterministic, non-silent sample array: a sine-ish sweep with varying amplitude. */
function tone(n: number, amp: (i: number) => number): Float32Array {
  const arr = new Float32Array(n)
  for (let i = 0; i < n; i++) arr[i] = amp(i) * Math.sin(i)
  return arr
}

describe('peaks', () => {
  it('returns exactly `buckets` values', () => {
    expect(peaks(tone(1000, () => 1), 32)).toHaveLength(32)
    expect(peaks(tone(1000, () => 1), 28)).toHaveLength(28)
    expect(peaks(tone(1000, () => 1), 1)).toHaveLength(1)
  })

  it('returns an empty array for a non-positive bucket count', () => {
    expect(peaks(tone(100, () => 1), 0)).toEqual([])
    expect(peaks(tone(100, () => 1), -1)).toEqual([])
  })

  it('normalizes so the loudest bucket is exactly 1', () => {
    // Front half loud, back half quiet: the front-half buckets should hit 1.
    const samples = tone(3200, (i) => (i < 1600 ? 1 : 0.1))
    const result = peaks(samples, 32)
    expect(Math.max(...result)).toBeCloseTo(1, 5)
    expect(Math.min(...result)).toBeGreaterThanOrEqual(0)
  })

  it('silence maps to all ~0', () => {
    expect(peaks(new Float32Array(1000), 32)).toEqual(Array.from({ length: 32 }, () => 0))
  })

  it('empty input maps to all 0 without dividing by zero', () => {
    expect(peaks(new Float32Array(0), 32)).toEqual(Array.from({ length: 32 }, () => 0))
    expect(peaks([], 16)).toEqual(Array.from({ length: 16 }, () => 0))
  })

  it('is deterministic', () => {
    const samples = tone(500, (i) => 0.3 + 0.7 * Math.abs(Math.sin(i / 7)))
    expect(peaks(samples, 32)).toEqual(peaks(samples, 32))
  })

  it('handles short samples (fewer samples than buckets)', () => {
    const result = peaks([1, 0.5, 0.25], 32)
    expect(result).toHaveLength(32)
    expect(result.every((v) => Number.isFinite(v))).toBe(true)
    // The loudest sample still normalizes to 1 somewhere in the output.
    expect(Math.max(...result)).toBeCloseTo(1, 5)
  })

  it('clamps NaN/Infinity samples to 0 rather than propagating them', () => {
    const samples = [1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5]
    const result = peaks(samples, 5)
    expect(result.every((v) => Number.isFinite(v))).toBe(true)
    expect(result.every((v) => v >= 0 && v <= 1)).toBe(true)
  })

  it('never returns a value outside [0, 1]', () => {
    const samples = tone(4096, (i) => 1 + (i % 7)) // amplitudes well beyond 1
    const result = peaks(samples, WAVEFORM_BUCKETS)
    expect(result.every((v) => v >= 0 && v <= 1)).toBe(true)
  })
})

describe('drawSpec', () => {
  it('returns one bar per peak, all within the width×height box', () => {
    const bars = drawSpec(Array.from({ length: 32 }, () => 0.5), 128, 24)
    expect(bars).toHaveLength(32)
    for (const bar of bars) {
      expect(bar.x).toBeGreaterThanOrEqual(0)
      expect(bar.x + bar.width).toBeLessThanOrEqual(128 + 1e-9)
      expect(bar.y).toBeGreaterThanOrEqual(0)
      expect(bar.y + bar.height).toBeLessThanOrEqual(24 + 1e-9)
    }
  })

  it('gives silence a hairline minimum height, not a vanishing bar', () => {
    const bars = drawSpec(Array.from({ length: 32 }, () => 0), 128, 40)
    for (const bar of bars) {
      expect(bar.height).toBe(MIN_BAR_HEIGHT)
    }
  })

  it('never lets the minimum exceed the box height', () => {
    const bars = drawSpec(Array.from({ length: 4 }, () => 0), 40, 2)
    for (const bar of bars) {
      expect(bar.height).toBeLessThanOrEqual(2)
    }
  })

  it('a full-scale peak reaches the box height', () => {
    const bars = drawSpec([1], 40, 40)
    expect(bars[0].height).toBeCloseTo(40, 5)
  })

  it('clamps out-of-range/non-finite peak values instead of propagating them', () => {
    const bars = drawSpec([Number.NaN, 5, -3, Number.POSITIVE_INFINITY], 80, 30)
    for (const bar of bars) {
      expect(Number.isFinite(bar.height)).toBe(true)
      expect(Number.isFinite(bar.x)).toBe(true)
      expect(bar.height).toBeGreaterThanOrEqual(0)
      expect(bar.height).toBeLessThanOrEqual(30)
    }
  })

  it('returns no bars for a degenerate box or empty peaks', () => {
    expect(drawSpec([], 100, 20)).toEqual([])
    expect(drawSpec([0.5], 0, 20)).toEqual([])
    expect(drawSpec([0.5], 100, 0)).toEqual([])
    expect(drawSpec([0.5], -10, 20)).toEqual([])
  })

  it('bars are laid out left to right in increasing x order', () => {
    const bars = drawSpec(Array.from({ length: 8 }, () => 0.5), 100, 20)
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].x).toBeGreaterThan(bars[i - 1].x)
    }
  })
})
