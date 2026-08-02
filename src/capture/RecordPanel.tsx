import { useRef, useState, type ReactNode } from 'react'
import { Button, captureIcon, cx, motion, tap, tone, type_ } from '../ui'
import type { Recorder } from './useRecorder'
import { LevelMeter } from './LevelMeter'
import {
  HOLD_MS,
  IDLE_STATE,
  cancel as cancelGesture,
  move as moveGesture,
  press as pressGesture,
  release as releaseGesture,
  tick as tickGesture,
  type GestureState,
} from './holdGesture'

// The main CTA's icons come from the shared capture-modality mapping so
// entry action rows (EntryCard) render the exact same glyphs.
const MicIcon = captureIcon('audio')
const CameraIcon = captureIcon('photo')
const TextIcon = captureIcon('text')

function clock(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

interface RecordPanelProps {
  recorder: Recorder
  maxClipSec: number
  onTap: () => void
  onDiscard: () => void
  onCamera: () => void
  onText: () => void
  /**
   * Hold-and-drag accelerator (#77): commit the in-flight recording and
   * immediately open the matching add-on (photo input / text sheet) for the
   * just-created entry. An accelerator only — "+ photo"/"+ note" on the
   * entry card reach the exact same outcome via a plain button.
   */
  onCommitThen: (kind: 'photo' | 'text') => void
  /** Contextual idle-state prompt (`capturePrompt`, computed by the caller). */
  prompt: string
  /** Count of today's entries, for the compact day-summary line. */
  todayCount: number
}

/**
 * The capture control (A1/A2/A4): a large, dominant mic button when idle,
 * with camera and text capture as smaller, subordinate affordances offset
 * below it — voice is the primary path, the others are one tap away. A
 * contextual prompt line and a compact day-summary line fill the space that
 * used to sit empty above/below the button. While recording, a focused
 * panel with live level bars, timer, and discard.
 *
 * Tap/hold/drag accelerator (#77): the mic button also drives a pure
 * gesture state machine (`holdGesture.ts`). A plain tap is unchanged —
 * `onTap` still owns the idle/recording toggle. Holding past `HOLD_MS`
 * starts recording the same way a tap-start would (via `onTap`, since
 * `onTap` is itself state-aware); dragging left/right while holding targets
 * the photo/text satellite and releasing there commits-then-opens that
 * add-on (`onCommitThen`); dragging up targets a cancel zone that discards
 * on release, matching the plain Discard button. Every one of those
 * outcomes stays reachable without ever touching this gesture (plain tap,
 * Discard, and the entry card's "+ photo"/"+ note") — this is an
 * accelerator, never the only path (a11y non-negotiable).
 */
export function RecordPanel({
  recorder,
  maxClipSec,
  onTap,
  onDiscard,
  onCamera,
  onText,
  onCommitThen,
  prompt,
  todayCount,
}: RecordPanelProps) {
  // Gesture bookkeeping lives in refs (authoritative, synchronous) plus one
  // small piece of render state (phase/target) purely to drive the visual
  // affordance (#77 req. 6) — the machine itself is pure and knows nothing
  // about React or the DOM.
  const gestureRef = useRef<GestureState>(IDLE_STATE)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [gesture, setGesture] = useState<GestureState>(IDLE_STATE)

  function clearHoldTimer() {
    clearTimeout(holdTimerRef.current)
    holdTimerRef.current = undefined
  }

  function setGestureState(next: GestureState) {
    gestureRef.current = next
    setGesture(next)
  }

  function armHoldTimer() {
    clearHoldTimer()
    holdTimerRef.current = setTimeout(() => {
      const next = tickGesture(gestureRef.current, performance.now())
      setGestureState(next)
      // The moment the hold engages, start recording exactly like a
      // tap-start (onTap is state-aware: idle → start). This is the only
      // place recording starts from the gesture layer — release always
      // stops/commits/discards an already-started recording.
      if (next.phase === 'holding') onTap()
    }, HOLD_MS)
  }

  function onGesturePointerDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    originRef.current = { x: e.clientX, y: e.clientY }
    setGestureState(pressGesture(gestureRef.current, e.timeStamp))
    armHoldTimer()
  }

  function onGesturePointerMove(e: React.PointerEvent) {
    if (gestureRef.current.phase === 'idle') return
    const origin = originRef.current
    if (!origin) return
    const dx = e.clientX - origin.x
    const dy = e.clientY - origin.y
    const next = moveGesture(gestureRef.current, dx, dy)
    if (next.phase === 'idle') clearHoldTimer() // scroll intent: candidacy cancelled
    setGestureState(next)
  }

  // A tap/hold/drag pointer sequence ends in a browser-synthesized `click`
  // right after pointerup (needed so keyboard/AT activation — which never
  // sees pointer events at all — still reaches `onTap` via the button's
  // plain onClick). Marking the next click suppressed here, and clearing it
  // on a macrotask, lets both paths coexist without double-dispatching a
  // pointer-driven tap.
  const suppressClickRef = useRef(false)
  function suppressNextClick() {
    suppressClickRef.current = true
    setTimeout(() => {
      suppressClickRef.current = false
    }, 0)
  }

  function onGesturePointerUp(e: React.PointerEvent) {
    clearHoldTimer()
    suppressNextClick()
    const { state, command } = releaseGesture(gestureRef.current, e.timeStamp)
    setGestureState(state)
    // Hold-class commands only take effect while a hold-started recording is
    // actually in progress — this is the no-op guard for #77 req. 8: a
    // pointerup racing the iOS background-commit handler or maxClipSec
    // auto-stop (both already claimed the recorder, flipping it out of
    // 'recording') must do nothing, never double-commit.
    const recording = recorder.state === 'recording'
    if (command === 'tap') onTap()
    else if (command === 'commit' && recording) onTap()
    else if (command === 'commitThen:photo' && recording) onCommitThen('photo')
    else if (command === 'commitThen:text' && recording) onCommitThen('text')
    else if (command === 'discard' && recording) onDiscard()
  }

  function onGesturePointerCancel() {
    clearHoldTimer()
    suppressNextClick()
    const wasActive = gestureRef.current.phase !== 'idle'
    setGestureState(cancelGesture(gestureRef.current))
    if (wasActive && recorder.state === 'recording') onDiscard()
  }

  function onMicClick() {
    // Keyboard/AT activation (Enter/Space on the focused button) never fires
    // a pointer event, so it always reaches here with the flag clear —
    // Requirement 7's "reachable via keyboard" holds for every gesture
    // outcome the mic button itself can produce (start/stop the tap way).
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    onTap()
  }

  // Bound to a generously-sized wrapper (not the small mic button itself):
  // pointerleave on the button would fire the instant a drag toward a
  // satellite physically crosses the button's bounds — boundary events are
  // not retargeted by pointer capture — which would kill the drag feature
  // outright. The wrapper's bounds comfortably clear DRAG_PX in every
  // direction, so this only fires for a genuinely abandoned gesture.
  function onGestureWrapperPointerLeave() {
    onGesturePointerCancel()
  }

  const gestureActive = gesture.phase !== 'idle'

  if (recorder.state === 'error' && !gestureActive) {
    return (
      <div className={cx('flex flex-col items-center gap-3 py-6 text-center', motion.fadeIn)}>
        <p className={cx(type_.body, 'font-medium', tone.textPrimary)}>
          Microphone unavailable
        </p>
        <p className={cx(type_.sub, tone.textMuted, 'max-w-64')}>
          {recorder.errorKind === 'denied'
            ? 'Mic access is blocked. Enable it in iOS Settings → Apps → Timebox, or type your entry instead.'
            : 'Something went wrong starting the mic. Try again, or type your entry instead.'}
        </p>
        <div className="flex gap-2">
          {recorder.errorKind !== 'denied' && (
            <Button variant="secondary" onClick={recorder.resetError}>
              Try again
            </Button>
          )}
          <Button variant="secondary" onClick={onText}>
            Type an entry
          </Button>
        </div>
      </div>
    )
  }

  // The full recording panel (LevelMeter + Discard/Done) only replaces the
  // mic/satellite layout once the gesture has released back to idle — while
  // an active hold/drag is in flight, the mic/satellite layout stays
  // mounted throughout (satellite highlighting, req. 6) even though
  // `recorder.state` is already 'recording' underneath. This also keeps the
  // gesture-owning button element from ever unmounting mid-interaction,
  // which would drop its pointer capture.
  if (recorder.state === 'recording' && !gestureActive) {
    const remaining = maxClipSec - recorder.elapsedSec
    return (
      <div
        className={cx(
          'flex flex-col items-center gap-4 rounded-3xl bg-clay px-6 py-6 shadow-lg shadow-clay/25 dark:bg-clay-dark',
          motion.scaleIn,
        )}
      >
        <LevelMeter getLevel={recorder.getLevel} />
        <p className={cx('tabular-nums text-white', type_.title)}>
          {clock(recorder.elapsedSec)}
          {remaining <= 10 && (
            <span className={cx('ml-2 text-white/70', type_.sub)}>{remaining}s left</span>
          )}
        </p>
        <div className="flex w-full gap-2">
          <button
            onClick={onDiscard}
            className={cx(
              'min-h-12 flex-1 rounded-xl bg-clay-deep/60 font-medium text-white/85 active:bg-clay-deep/80 dark:bg-clay-deep-dark/60 dark:active:bg-clay-deep-dark/80',
              type_.ui,
            )}
          >
            Discard
          </button>
          <button
            onClick={onTap}
            className={cx(
              'min-h-12 flex-[2] rounded-xl bg-white font-semibold text-clay-deep active:bg-clay-wash',
              type_.ui,
            )}
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  const recordingViaHold = gestureActive && recorder.state === 'recording'
  const holdingStill = gesture.phase === 'holding' || gesture.phase === 'dragging'

  return (
    // touch-action is scoped to the mic button alone (below), never here or
    // higher — page scroll outside the capture panel must stay unaffected
    // (#77 req. 7).
    <div
      className={cx('flex flex-col items-center gap-2 py-4', motion.fadeIn)}
      onPointerLeave={onGestureWrapperPointerLeave}
    >
      <button
        onClick={onMicClick}
        onPointerDown={onGesturePointerDown}
        onPointerMove={onGesturePointerMove}
        onPointerUp={onGesturePointerUp}
        onPointerCancel={onGesturePointerCancel}
        aria-label={recordingViaHold ? 'Recording — release to save' : 'Start recording'}
        className={cx(
          'flex h-28 w-28 touch-none items-center justify-center rounded-full text-white shadow-lg transition-transform active:scale-95',
          holdingStill
            ? 'scale-105 bg-spruce-deep shadow-spruce/40 dark:bg-spruce-deep-dark dark:shadow-spruce-deep-dark/30'
            : 'bg-spruce shadow-spruce/30 active:bg-spruce-deep dark:bg-spruce-dark dark:shadow-spruce-dark/20 dark:active:bg-spruce-deep-dark',
        )}
      >
        <MicIcon size={36} />
      </button>
      {recordingViaHold && holdingStill ? (
        <p
          className={cx(
            type_.sub,
            'text-center tabular-nums',
            gesture.target === 'cancel' ? tone.danger : tone.textSecondary,
          )}
        >
          {gesture.target === 'cancel' ? 'Release to cancel' : `${clock(recorder.elapsedSec)} · hold`}
        </p>
      ) : (
        <p className={cx(type_.sub, tone.textSecondary, 'text-center')}>{prompt}</p>
      )}
      {!gestureActive && todayCount > 0 && (
        <p className={cx(type_.caption, tone.textFaint)}>
          {todayCount} {todayCount === 1 ? 'moment' : 'moments'} today
        </p>
      )}
      <div className="flex items-center gap-6 pt-1">
        <SatelliteButton label="Take a photo" onClick={onCamera} highlighted={gesture.target === 'photo'}>
          <CameraIcon />
        </SatelliteButton>
        <SatelliteButton label="Type an entry" onClick={onText} highlighted={gesture.target === 'text'}>
          <TextIcon />
        </SatelliteButton>
      </div>
    </div>
  )
}

/**
 * Secondary capture path: first-class but visually subordinate to the mic.
 * `highlighted` is driven only by the gesture accelerator's live drag
 * target (#77 req. 6) — the button remains a plain, individually tappable
 * `<button>` regardless, so it works identically with or without the
 * gesture ever engaging.
 */
function SatelliteButton({
  label,
  onClick,
  highlighted,
  children,
}: {
  label: string
  onClick: () => void
  highlighted?: boolean
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={cx(
        tap,
        'flex h-11 w-11 items-center justify-center rounded-full border transition-transform active:scale-95',
        highlighted
          ? cx(tone.accentWash, tone.accent, 'border-transparent', motion.scaleIn)
          : cx(tone.surface, tone.border, tone.textMuted, tone.pressWash),
      )}
    >
      {children}
    </button>
  )
}
