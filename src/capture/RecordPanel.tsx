import type { ReactNode } from 'react'
import { Button, captureIcon, cx, motion, tone, type_ } from '../ui'
import type { Recorder } from './useRecorder'
import { LevelMeter } from './LevelMeter'

// The main CTA's icons come from the shared capture-modality mapping so
// entry action rows (EntryCard) render the exact same glyphs.
const MicIcon = captureIcon('audio')
const CameraIcon = captureIcon('photo')
const PencilIcon = captureIcon('text')

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
          <MicIcon size={36} />
        </button>
        <SatelliteButton label="Type an entry" onClick={onText}>
          <PencilIcon />
        </SatelliteButton>
      </div>
      {/* Location context removed — it's redundant with each entry's location
          shown on its card. Satellite buttons are consistently icon-only. */}
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
