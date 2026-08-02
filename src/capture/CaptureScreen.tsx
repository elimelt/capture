/** Screen 1 — Capture (SPEC §4.1). Tap to record, tap to stop; never dead-ends. */
import { useEffect, useRef, useState } from 'react'
import type { GeoLocation } from '../contract/types'
import { localDateOf, toLocalIso } from '../contract/time'
import { useAppStore } from '../store/appStore'
import { useRecorder, type RecordingResult } from './useRecorder'
import { snapshotLocation } from './geo'
import { EntryList } from './EntryList'
import { StatusBadge, timeLabel } from './EntryCard'

export default function CaptureScreen() {
  const entries = useAppStore((s) => s.entries)
  const syncStatuses = useAppStore((s) => s.syncStatuses)
  const places = useAppStore((s) => s.places)
  const appSettings = useAppStore((s) => s.appSettings)
  const streamSettings = useAppStore((s) => s.streamSettings)
  const refresh = useAppStore((s) => s.refresh)
  const loadPlaces = useAppStore((s) => s.loadPlaces)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const capture = useAppStore((s) => s.capture)
  const revoke = useAppStore((s) => s.revoke)

  const recorder = useRecorder()
  const [text, setText] = useState('')
  const [toast, setToast] = useState<{ entryId: string } | null>(null)
  const tapStartRef = useRef<Date>(new Date())
  const locationRef = useRef<Promise<GeoLocation | undefined>>(Promise.resolve(undefined))
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    void refresh()
    void loadPlaces()
    void loadSettings()
  }, [refresh, loadPlaces, loadSettings])

  useEffect(() => () => clearTimeout(toastTimerRef.current), [])

  function showUndoToast(entryId: string) {
    clearTimeout(toastTimerRef.current)
    setToast({ entryId })
    toastTimerRef.current = setTimeout(() => setToast(null), 5000)
  }

  async function commit(result: RecordingResult) {
    const location = await locationRef.current
    const event = await capture({
      capturedAt: toLocalIso(tapStartRef.current),
      location,
      attachments: [
        {
          kind: 'audio',
          blob: result.blob,
          mimeType: result.mimeType,
          durationSec: result.durationSec,
        },
      ],
    })
    showUndoToast(event.id)
  }

  async function handleCaptureTap() {
    if (recorder.state === 'recording') {
      const result = await recorder.stop()
      if (result) await commit(result)
    } else {
      tapStartRef.current = new Date()
      locationRef.current = snapshotLocation(places, appSettings.locationEnabled)
      await recorder.start(streamSettings.maxClipSec, (result) => void commit(result))
    }
  }

  async function submitText() {
    const trimmed = text.trim()
    if (!trimmed) return
    const location = await snapshotLocation(places, appSettings.locationEnabled)
    const event = await capture({
      capturedAt: toLocalIso(new Date()),
      location,
      attachments: [
        {
          kind: 'text',
          blob: new Blob([trimmed], { type: 'text/plain' }),
          mimeType: 'text/plain',
        },
      ],
    })
    setText('')
    showUndoToast(event.id)
  }

  async function undo(entryId: string) {
    clearTimeout(toastTimerRef.current)
    setToast(null)
    await revoke([entryId])
  }

  const today = localDateOf(toLocalIso(new Date()))
  const todayEntries = entries
    .filter((e) => !e.revoked && localDateOf(e.capturedAt) === today)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
  const latest = todayEntries[0]
  const recording = recorder.state === 'recording'

  return (
    <div className="flex flex-col gap-4 p-4">
      {latest && (
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900">
          <span className="font-medium text-slate-900 dark:text-slate-100">
            {timeLabel(latest.capturedAt)}
          </span>
          {latest.location?.placeLabel && (
            <span className="truncate text-slate-500 dark:text-slate-400">
              · {latest.location.placeLabel}
            </span>
          )}
          <span className="ml-auto">
            <StatusBadge status={syncStatuses.get(latest.seq)?.status ?? 'queued'} />
          </span>
        </div>
      )}
      <p className="text-center text-xs text-slate-500 dark:text-slate-400">
        {todayEntries.length} {todayEntries.length === 1 ? 'entry' : 'entries'} today
      </p>

      {recorder.state === 'error' ? (
        <div className="flex flex-col gap-2">
          <p className="text-center text-xs text-red-600 dark:text-red-400">
            Microphone unavailable — type your entry instead.
          </p>
          <textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What just happened?"
            className="w-full rounded-lg border border-slate-300 bg-white p-3 text-base text-slate-900 outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <button
            onClick={() => void submitText()}
            disabled={!text.trim()}
            className="min-h-11 rounded-lg bg-sky-600 text-sm font-medium text-white disabled:opacity-50"
          >
            Log entry
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 py-4">
          <button
            onClick={() => void handleCaptureTap()}
            aria-label={recording ? 'Stop recording' : 'Start recording'}
            className={`flex h-28 w-28 items-center justify-center rounded-full text-sm font-semibold text-white shadow-lg transition-colors ${
              recording
                ? 'animate-pulse bg-red-600 active:bg-red-700'
                : 'bg-sky-600 active:bg-sky-700'
            }`}
          >
            {recording ? 'Stop' : 'Record'}
          </button>
          <p className="h-5 text-sm tabular-nums text-slate-500 dark:text-slate-400">
            {recording
              ? `${Math.floor(recorder.elapsedSec / 60)}:${String(recorder.elapsedSec % 60).padStart(2, '0')} / ${streamSettings.maxClipSec}s`
              : 'Tap to record'}
          </p>
        </div>
      )}

      <EntryList entries={todayEntries} syncStatuses={syncStatuses} />

      {toast && (
        <div className="fixed inset-x-4 bottom-24 z-40 mx-auto flex max-w-md items-center justify-between rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-lg dark:bg-slate-700">
          <span>Entry captured</span>
          <button
            onClick={() => void undo(toast.entryId)}
            className="min-h-11 px-3 font-semibold text-sky-300"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  )
}
