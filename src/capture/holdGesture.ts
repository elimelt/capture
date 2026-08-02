/**
 * Pure gesture state machine for the mic-button tap/hold/drag accelerator
 * (#77): pointer/time events in, a new state and an optional command out.
 * No DOM, no timers, no `Date.now()` inside — the caller (`RecordPanel`)
 * owns `PointerEvent`s and a single `setTimeout(HOLD_MS)`, and feeds this
 * module timestamps and coordinates it already has. This keeps every
 * transition (including the timing/threshold boundaries) testable without
 * jsdom.
 *
 * This is an ACCELERATOR only: every command it can produce also has a
 * plain-button path elsewhere (the mic tap, the Discard button, the
 * "+ photo"/"+ note" actions on the entry card) — see RecordPanel.tsx and
 * CaptureScreen.tsx for the wiring. The state machine never becomes the
 * only way to reach an outcome.
 */

export type GesturePhase = 'idle' | 'pressed' | 'holding' | 'dragging'

/** Satellite drop zones a drag can resolve to while holding. */
export type GestureTarget = 'photo' | 'text' | 'cancel'

export interface GestureState {
  phase: GesturePhase
  target?: GestureTarget
  /** Internal bookkeeping: the `press()` timestamp, used by `tick`/`release`
   *  to evaluate `HOLD_MS`. Absent only for the initial idle state. */
  pressedAt?: number
}

export type GestureCommand =
  | 'tap'
  | 'commit'
  | 'commitThen:photo'
  | 'commitThen:text'
  | 'discard'

export interface ReleaseResult {
  state: GestureState
  command?: GestureCommand
}

/** A press must be held at least this long to engage record-while-pressed. */
export const HOLD_MS = 400

/** Cumulative drag distance (px) that resolves a direction to a drop zone. */
export const DRAG_PX = 40

export const IDLE_STATE: GestureState = { phase: 'idle' }

/** Pointerdown on the mic button: arms a hold candidate. */
export function press(_state: GestureState, t: number): GestureState {
  return { phase: 'pressed', pressedAt: t }
}

/**
 * The caller's single `setTimeout(HOLD_MS)` fired while still pressed with
 * no cancelling move in between. No-op once past `pressed` (already holding
 * or dragging) or once the candidacy was cancelled (phase reset to idle by
 * `move`) or released.
 */
export function tick(state: GestureState, t: number): GestureState {
  if (state.phase !== 'pressed' || state.pressedAt === undefined) return state
  if (t - state.pressedAt < HOLD_MS) return state
  return { phase: 'holding', pressedAt: state.pressedAt }
}

/** Which zone (if any) a cumulative offset from the press point resolves to. */
function targetFor(dx: number, dy: number): GestureTarget | undefined {
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  if (adx < DRAG_PX && ady < DRAG_PX) return undefined
  // Larger axis wins; horizontal splits left/right, vertical-up is cancel
  // (the universal "slide up to cancel" convention). Vertical-down is
  // deliberately unassigned (#77 non-goal: no location drop zone in v1) and
  // just keeps the hold engaged rather than resolving to a zone.
  if (adx >= ady) return dx < 0 ? 'photo' : 'text'
  return dy < 0 ? 'cancel' : undefined
}

/**
 * Pointermove with the cumulative offset from the press point (not deltas).
 * Before the hold engages, any move past `DRAG_PX` reads as scroll intent —
 * the whole candidacy is abandoned (resets to idle) so the page can scroll
 * and neither a tap nor a hold ever fires for this pointer sequence.
 */
export function move(state: GestureState, dx: number, dy: number): GestureState {
  if (state.phase === 'idle') return state
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  if (state.phase === 'pressed') {
    if (adx >= DRAG_PX || ady >= DRAG_PX) return { phase: 'idle' }
    return state
  }
  // holding or dragging: target is recomputed live from the current offset.
  const target = targetFor(dx, dy)
  return target
    ? { phase: 'dragging', target, pressedAt: state.pressedAt }
    : { phase: 'holding', pressedAt: state.pressedAt }
}

/**
 * Pointerup: resolves the gesture to a command and always returns to idle
 * (a fresh `press()` is required before another command can fire — this is
 * the invariant that rules out two commit-class commands from one press).
 */
export function release(state: GestureState, t: number): ReleaseResult {
  if (state.phase === 'idle') return { state: IDLE_STATE }
  if (state.phase === 'pressed') {
    const held = state.pressedAt !== undefined && t - state.pressedAt >= HOLD_MS
    return { state: IDLE_STATE, command: held ? 'commit' : 'tap' }
  }
  if (state.phase === 'holding') return { state: IDLE_STATE, command: 'commit' }
  // dragging
  switch (state.target) {
    case 'photo':
      return { state: IDLE_STATE, command: 'commitThen:photo' }
    case 'text':
      return { state: IDLE_STATE, command: 'commitThen:text' }
    case 'cancel':
      return { state: IDLE_STATE, command: 'discard' }
    default:
      return { state: IDLE_STATE, command: 'commit' }
  }
}

/**
 * Pointercancel/pointerleave: an unconditional reset to idle, no command.
 * The caller decides whether that requires discarding an in-flight
 * recording (it does whenever the gesture had reached `holding`/`dragging`
 * — see RecordPanel) — same effect as the existing Discard button, just
 * triggered by a different signal than the `discard` command.
 */
export function cancel(_state: GestureState): GestureState {
  return IDLE_STATE
}
