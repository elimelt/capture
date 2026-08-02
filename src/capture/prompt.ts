/**
 * Contextual capture prompt (issue #76): a short chrome line rendered near
 * the idle mic button, chosen deterministically from local context — never
 * `Math.random()`, never a clock read inside this module. Callers own
 * assembling `PromptContext` (typically once per render from `Date.now()`
 * and the day's entries), so the same context always yields the same
 * prompt and the label never flickers across re-renders.
 */

export interface PromptContext {
  /** The moment the prompt is chosen for (hour-of-day bucketing only). */
  now: Date
  /** Count of non-revoked entries captured so far today. */
  todayCount: number
  /** Minutes since the most recent capture today, if any exists. */
  minutesSinceLastCapture?: number
}

/** Below this gap, the user just captured something — offer a quick follow-up. */
const RECENT_MINUTES = 15
/** At or above this gap, nudge them to capture what they may have let slip. */
const LONG_GAP_MINUTES = 180

type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night'

function timeOfDay(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 21) return 'evening'
  return 'night'
}

/** Empty-day prompts, tuned per time of day (morning + empty day is the review's example). */
const EMPTY_DAY_PROMPTS: Record<TimeOfDay, string> = {
  morning: 'What should you remember?',
  afternoon: "What's on your mind?",
  evening: 'Capture what happened today',
  night: 'Hold to remember',
}

/** Default prompts once the day already has at least one entry. */
const ACTIVE_DAY_PROMPTS: Record<TimeOfDay, string> = {
  morning: "What's on your mind?",
  afternoon: "What's on your mind?",
  evening: "What's on your mind?",
  night: 'Hold to remember',
}

/**
 * Pure prompt selection. Priority: a very recent capture wins (offer a
 * follow-up) over a long gap (nudge to capture); absent that signal, an
 * empty day gets a distinct opener from a day already in progress; all
 * buckets are keyed off `now`'s hour, never `Date.now()` read internally.
 */
export function capturePrompt(ctx: PromptContext): string {
  const { minutesSinceLastCapture, todayCount } = ctx
  if (minutesSinceLastCapture !== undefined) {
    if (minutesSinceLastCapture < RECENT_MINUTES) return 'Anything else?'
    if (minutesSinceLastCapture >= LONG_GAP_MINUTES) return 'Capture what just happened'
  }
  const tod = timeOfDay(ctx.now.getHours())
  return todayCount === 0 ? EMPTY_DAY_PROMPTS[tod] : ACTIVE_DAY_PROMPTS[tod]
}
