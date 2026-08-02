import type { ReactNode } from 'react'
import { Button, cx, motion, tone, type_ } from '../ui'
import type { Recorder } from './useRecorder'
import { LevelMeter } from './LevelMeter'

function clock(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

interface RecordPanelProps {
  recorder: Recorder
  maxClipSec: number
  /** Live context line under the button (place / location state, A5). */
  contextLabel?: string
  onTap: () => void
  onDiscard: () => void
  onCamera: () => void
  onText: () => void
}

/**
 * The capture control (A1/A2/A4): a large mic button flanked by camera and
 * text capture when idle — voice is the primary path, the others are one
 * tap away. While recording, a focused panel with live level bars, timer,
 * and discard.
 */
export function RecordPanel({
  recorder,
  maxClipSec,
  contextLabel,
  onTap,
  onDiscard,
  onCamera,
  onText,
}: RecordPanelProps) {
  if (recorder.state === 'error') {
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

  if (recorder.state === 'recording') {
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

  return (
    <div className={cx('flex flex-col items-center gap-3 py-4', motion.fadeIn)}>
      <div className="flex items-center gap-7">
        <SatelliteButton label="Take a photo" onClick={onCamera}>
          <CameraIcon />
        </SatelliteButton>
        <button
          onClick={onTap}
          aria-label="Start recording"
          className="flex h-28 w-28 items-center justify-center rounded-full bg-spruce text-white shadow-lg shadow-spruce/30 transition-transform active:scale-95 active:bg-spruce-deep dark:bg-spruce-dark dark:shadow-spruce-dark/20 dark:active:bg-spruce-deep-dark"
        >
          <MicIcon />
        </button>
        <SatelliteButton label="Type an entry" onClick={onText}>
          <PencilIcon />
        </SatelliteButton>
      </div>
      <div className="flex h-10 flex-col items-center justify-start gap-0.5">
        <p className={cx(type_.sub, tone.textMuted)}>Tap to record</p>
        {contextLabel && (
          <p className={cx(type_.caption, tone.textFaint)}>{contextLabel}</p>
        )}
      </div>
    </div>
  )
}

/** Secondary capture path: first-class but visually subordinate to the mic. */
function SatelliteButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={cx(
        'flex h-14 w-14 items-center justify-center rounded-full border transition-transform active:scale-95',
        tone.surface,
        tone.borderStrong,
        tone.accent,
        tone.pressWash,
      )}
    >
      {children}
    </button>
  )
}

function CameraIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.1l1.15-1.73a1.5 1.5 0 0 1 1.25-.67h4a1.5 1.5 0 0 1 1.25.67L16.4 7h2.1A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14.5 5.7l3.8 3.8L8.6 19.2 4.5 20l.8-4.1 9.2-10.2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M12.8 7.6l3.6 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}
