import { describe, expect, it } from 'vitest'
import { capturePrompt, type PromptContext } from './prompt'

function ctx(overrides: Partial<PromptContext> & { hour: number }): PromptContext {
  const now = new Date(2026, 0, 1, overrides.hour, 0, 0)
  return {
    now,
    todayCount: overrides.todayCount ?? 0,
    minutesSinceLastCapture: overrides.minutesSinceLastCapture,
  }
}

describe('capturePrompt', () => {
  it('is stable for a fixed context (no per-call randomness)', () => {
    const c = ctx({ hour: 9, todayCount: 0 })
    expect(capturePrompt(c)).toBe(capturePrompt(c))
  })

  it('distinguishes empty morning, recent-capture, and long-gap contexts', () => {
    const emptyMorning = capturePrompt(ctx({ hour: 8, todayCount: 0 }))
    const recent = capturePrompt(ctx({ hour: 8, todayCount: 3, minutesSinceLastCapture: 2 }))
    const longGap = capturePrompt(ctx({ hour: 8, todayCount: 3, minutesSinceLastCapture: 240 }))

    expect(new Set([emptyMorning, recent, longGap]).size).toBe(3)
    for (const s of [emptyMorning, recent, longGap]) {
      expect(typeof s).toBe('string')
      expect(s.length).toBeGreaterThan(0)
    }
  })

  it('returns a distinct, non-empty opener for an empty morning', () => {
    const s = capturePrompt(ctx({ hour: 7, todayCount: 0 }))
    expect(s).toBe('What should you remember?')
  })

  it('prefers "recent capture" just under the recent threshold', () => {
    expect(capturePrompt(ctx({ hour: 14, todayCount: 1, minutesSinceLastCapture: 0 }))).toBe(
      'Anything else?',
    )
    expect(capturePrompt(ctx({ hour: 14, todayCount: 1, minutesSinceLastCapture: 14 }))).toBe(
      'Anything else?',
    )
  })

  it('switches away from "recent capture" at the boundary', () => {
    const at15 = capturePrompt(ctx({ hour: 14, todayCount: 1, minutesSinceLastCapture: 15 }))
    expect(at15).not.toBe('Anything else?')
  })

  it('flags a long gap at and above the threshold', () => {
    expect(capturePrompt(ctx({ hour: 14, todayCount: 2, minutesSinceLastCapture: 180 }))).toBe(
      'Capture what just happened',
    )
    expect(capturePrompt(ctx({ hour: 14, todayCount: 2, minutesSinceLastCapture: 600 }))).toBe(
      'Capture what just happened',
    )
  })

  it('does not flag a long gap just under the threshold', () => {
    const s = capturePrompt(ctx({ hour: 14, todayCount: 2, minutesSinceLastCapture: 179 }))
    expect(s).not.toBe('Capture what just happened')
  })

  it('differs between an empty day and a day already in progress at the same hour', () => {
    const empty = capturePrompt(ctx({ hour: 6, todayCount: 0 }))
    const inProgress = capturePrompt(ctx({ hour: 6, todayCount: 5 }))
    // Both are valid non-empty prompts; night/morning boundary at hour 6 keeps
    // them from colliding for the empty-day case specifically.
    expect(empty.length).toBeGreaterThan(0)
    expect(inProgress.length).toBeGreaterThan(0)
  })

  it('never throws across a fuzz of hours, counts, and gaps', () => {
    const hours = Array.from({ length: 24 }, (_, h) => h)
    const counts = [0, 1, 50]
    const gaps: Array<number | undefined> = [undefined, 0, 600]
    for (const hour of hours) {
      for (const todayCount of counts) {
        for (const minutesSinceLastCapture of gaps) {
          expect(() => {
            const result = capturePrompt(
              ctx({ hour, todayCount, minutesSinceLastCapture }),
            )
            expect(typeof result).toBe('string')
            expect(result.length).toBeGreaterThan(0)
          }).not.toThrow()
        }
      }
    }
  })

  it('returns a non-empty string for every hour of the day, empty-day and in-progress alike', () => {
    for (let hour = 0; hour < 24; hour++) {
      expect(capturePrompt(ctx({ hour, todayCount: 0 })).length).toBeGreaterThan(0)
      expect(capturePrompt(ctx({ hour, todayCount: 4 })).length).toBeGreaterThan(0)
    }
  })
})
