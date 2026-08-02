import { useEffect, useState } from 'react'
import { getBlob, getWaveform, putWaveform } from '../store/events'
import { cx, tone } from '../ui'
import { WAVEFORM_BUCKETS, drawSpec, peaks as computePeaks } from './waveformMath'

/** All-silent bucket set: `drawSpec`'s own hairline-minimum convention turns
 *  this into a quiet placeholder strip while a clip's peaks are still
 *  loading, with no placeholder-specific drawing code needed. */
const PLACEHOLDER_PEAKS: number[] = Array.from({ length: WAVEFORM_BUCKETS }, () => 0)

type Status = 'loading' | 'ready' | 'failed'

interface WaveformProps {
  /** The audio attachment's contract filename (blob store key). */
  file: string
  /** 0..1 through the clip (`useAudioPlayback.progress`); sweeps a fill
   *  across the fingerprint so the signature doubles as the progress
   *  indicator (#86 req. 4). Omitted/0 when not playing. */
  progress?: number
  /** Strip height in px; width always fills the parent. */
  height?: number
  className?: string
}

/**
 * The signature visual primitive (#86): a small, static per-clip amplitude
 * glyph that is the entry's visual identity wherever its audio appears, and
 * doubles as the playback progress indicator.
 *
 * Decode is lazy (starts on first mount, never at capture) and defensive:
 * cached peaks (`getWaveform`/`putWaveform`, IndexedDB, keyed like `blobs`)
 * are used when present so a clip is ever decoded at most once; otherwise
 * the blob is decoded via `AudioContext.decodeAudioData` off the main
 * thread's critical path. While that's in flight the component renders a
 * neutral all-silent placeholder (via `drawSpec`'s own hairline-minimum
 * convention) so the card never waits on this to lay out. If decoding fails
 * for any reason (unsupported container, corrupt blob, no AudioContext —
 * iOS `audio/mp4` is expected to work, but this is a silent best-effort
 * fallback matching `useRecorder`'s `LevelMeter` precedent) the component
 * renders nothing, leaving the surrounding playback target available — never
 * a crash, never a blocked render.
 */
export function Waveform({ file, progress = 0, height = 24, className }: WaveformProps) {
  const [status, setStatus] = useState<Status>('loading')
  const [data, setData] = useState<number[]>(PLACEHOLDER_PEAKS)

  useEffect(() => {
    let stale = false
    setStatus('loading')
    setData(PLACEHOLDER_PEAKS)

    void (async () => {
      try {
        const cached = await getWaveform(file)
        if (cached) {
          if (!stale) {
            setData(cached)
            setStatus('ready')
          }
          return
        }

        const blob = await getBlob(file)
        if (!blob) throw new Error('waveform: no blob for file')

        const AudioCtx: typeof AudioContext | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
        if (!AudioCtx) throw new Error('waveform: no AudioContext')

        const buffer = await blob.arrayBuffer()
        const ctx = new AudioCtx()
        try {
          const decoded = await ctx.decodeAudioData(buffer)
          const computed = computePeaks(decoded.getChannelData(0), WAVEFORM_BUCKETS)
          if (!stale) {
            setData(computed)
            setStatus('ready')
          }
          // Cache regardless of whether this mount is stale — a later mount
          // of the same file (or a re-mount of this one) should still hit
          // the cache instead of decoding twice.
          await putWaveform(file, computed)
        } finally {
          void ctx.close()
        }
      } catch {
        // Decode failure (or a missing blob/AudioContext) is a silent
        // best-effort fallback (#86 req. 2): render nothing, leaving the
        // playback target this component sits inside.
        if (!stale) setStatus('failed')
      }
    })()

    return () => {
      stale = true
    }
  }, [file])

  if (status === 'failed') return null

  const width = 100
  const bars = drawSpec(data, width, height)
  const played = Math.min(1, Math.max(0, progress))

  return (
    <span
      aria-hidden="true"
      className={cx('relative block overflow-hidden', className)}
      style={{ height }}
    >
      {/* Base fingerprint, quiet accent tint. */}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block h-full w-full"
      >
        {bars.map((bar, i) => (
          <rect
            key={i}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            rx={0.5}
            className={cx(tone.accent, 'fill-current opacity-30')}
          />
        ))}
      </svg>
      {/* Played-portion overlay (B10-style progress fill): the same
          fingerprint, full-strength accent, clipped to the played fraction.
          The clip-path transition is covered by index.css's global
          prefers-reduced-motion rule (transition-duration → ~0), so no
          extra reduced-motion handling is needed here. */}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="absolute inset-0 block h-full w-full transition-[clip-path] duration-150 ease-linear"
        style={{ clipPath: `inset(0 ${(1 - played) * 100}% 0 0)` }}
      >
        {bars.map((bar, i) => (
          <rect
            key={i}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            rx={0.5}
            className={cx(tone.accent, 'fill-current')}
          />
        ))}
      </svg>
    </span>
  )
}
