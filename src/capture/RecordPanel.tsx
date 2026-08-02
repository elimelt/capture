import { Button, cx, tone, type_ } from '../ui'
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
}

/**
 * The capture control (A1/A2/A4): a large mic button when idle; while
 * recording, a focused panel with live level bars, timer, and discard.
 */
export function RecordPanel({
  recorder,
  maxClipSec,
  contextLabel,
  onTap,
  onDiscard,
}: RecordPanelProps) {
  if (recorder.state === 'error') {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <p className={cx(type_.body, 'font-medium', tone.textPrimary)}>
          Microphone unavailable
        </p>
        <p className={cx(type_.sub, tone.textMuted, 'max-w-64')}>
          {recorder.errorKind === 'denied'
            ? 'Mic access is blocked. Enable it in iOS Settings → Apps → Timebox, or type your entry below.'
            : 'Something went wrong starting the mic. Try again, or type your entry below.'}
        </p>
        {recorder.errorKind !== 'denied' && (
          <Button variant="secondary" onClick={recorder.resetError}>
            Try again
          </Button>
        )}
      </div>
    )
  }

  if (recorder.state === 'recording') {
    const remaining = maxClipSec - recorder.elapsedSec
    return (
      <div className="flex flex-col items-center gap-4 rounded-3xl bg-red-600 px-6 py-6 shadow-lg shadow-red-600/25">
        <LevelMeter getLevel={recorder.getLevel} />
        <p className={cx('tabular-nums text-white', type_.title)}>
          {clock(recorder.elapsedSec)}
          {remaining <= 10 && (
            <span className={cx('ml-2 text-red-100', type_.sub)}>{remaining}s left</span>
          )}
        </p>
        <div className="flex w-full gap-2">
          <button
            onClick={onDiscard}
            className={cx(
              'min-h-12 flex-1 rounded-xl bg-red-700/60 font-medium text-red-100 active:bg-red-800/60',
              type_.body,
            )}
          >
            Discard
          </button>
          <button
            onClick={onTap}
            className={cx(
              'min-h-12 flex-[2] rounded-xl bg-white font-semibold text-red-700 active:bg-red-50',
              type_.body,
            )}
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <button
        onClick={onTap}
        aria-label="Start recording"
        className="flex h-28 w-28 items-center justify-center rounded-full bg-sky-600 text-white shadow-lg shadow-sky-600/30 transition-transform active:scale-95 active:bg-sky-700"
      >
        <MicIcon />
      </button>
      <div className="flex h-10 flex-col items-center justify-start gap-0.5">
        <p className={cx(type_.sub, tone.textMuted)}>Tap to record</p>
        {contextLabel && (
          <p className={cx(type_.caption, tone.textFaint)}>{contextLabel}</p>
        )}
      </div>
    </div>
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
