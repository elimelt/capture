/** Screen 1 — Capture (SPEC §4.1). Tap to record, tap to stop; never dead-ends. */
import { useEffect, useRef, useState } from 'react'
import type { GeoLocation } from '../contract/types'
import { localDateOf, toLocalIso } from '../contract/time'
import { useAppStore } from '../store/appStore'
import { EmptyState, ScreenHeader, Toast, cx, motion } from '../ui'
import { useRecorder, type RecordingResult } from './useRecorder'
import { snapshotLocation } from './geo'
import { usePendingDelete } from './usePendingDelete'
import { EntryList } from './EntryList'
import { RecordPanel } from './RecordPanel'
import { TextSheet } from './TextSheet'

type ToastState = { kind: 'captured'; entryId: string } | { kind: 'discarded' }

export default function CaptureScreen() {
  const entries = useAppStore((s) => s.entries)
  const places = useAppStore((s) => s.places)
  const appSettings = useAppStore((s) => s.appSettings)
  const streamSettings = useAppStore((s) => s.streamSettings)
  const capture = useAppStore((s) => s.capture)
  const revoke = useAppStore((s) => s.revoke)

  const recorder = useRecorder()
  const del = usePendingDelete(revoke)
  const [textOpen, setTextOpen] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [here, setHere] = useState<GeoLocation | null>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const tapStartRef = useRef<Date>(new Date())
  const locationRef = useRef<Promise<GeoLocation | undefined>>(Promise.resolve(undefined))
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(toastTimerRef.current), [])

  // A5: passive location context under the button ("at Office"), refreshed
  // when the app comes to the foreground.
  useEffect(() => {
    let stale = false
    const probe = () => {
      void snapshotLocation(places, appSettings.locationEnabled).then((loc) => {
        if (!stale) setHere(loc ?? null)
      })
    }
    probe()
    const onVisible = () => {
      if (document.visibilityState === 'visible') probe()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stale = true
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [places, appSettings.locationEnabled])

  function showToast(next: ToastState) {
    clearTimeout(toastTimerRef.current)
    setToast(next)
    toastTimerRef.current = setTimeout(() => setToast(null), 5000)
  }

  const commitRef = useRef<(result: RecordingResult) => Promise<void>>(async () => {})
  commitRef.current = async (result: RecordingResult) => {
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
    showToast({ kind: 'captured', entryId: event.id })
  }

  // A6: iOS suspends backgrounded PWAs aggressively — commit the in-flight
  // recording instead of losing it.
  const recordingRef = useRef(false)
  recordingRef.current = recorder.state === 'recording'
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden' && recordingRef.current) {
        void recorder.stop().then((result) => {
          if (result) void commitRef.current(result)
        })
      }
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [recorder])

  async function handleRecordTap() {
    if (recorder.state === 'recording') {
      const result = await recorder.stop()
      if (result) await commitRef.current(result)
    } else {
      tapStartRef.current = new Date()
      locationRef.current = snapshotLocation(places, appSettings.locationEnabled)
      await recorder.start(streamSettings.maxClipSec, (result) => void commitRef.current(result))
    }
  }

  function handleDiscard() {
    recorder.cancel()
    showToast({ kind: 'discarded' })
  }

  async function submitText(text: string) {
    const location = await snapshotLocation(places, appSettings.locationEnabled)
    const event = await capture({
      capturedAt: toLocalIso(new Date()),
      location,
      attachments: [
        {
          kind: 'text',
          blob: new Blob([text], { type: 'text/plain' }),
          mimeType: 'text/plain',
        },
      ],
    })
    showToast({ kind: 'captured', entryId: event.id })
  }

  async function submitPhoto(file: File) {
    const location = await snapshotLocation(places, appSettings.locationEnabled)
    const event = await capture({
      capturedAt: toLocalIso(new Date()),
      location,
      attachments: [{ kind: 'photo', blob: file, mimeType: file.type || 'image/jpeg' }],
    })
    showToast({ kind: 'captured', entryId: event.id })
  }

  async function undoCapture(entryId: string) {
    clearTimeout(toastTimerRef.current)
    setToast(null)
    await revoke([entryId])
  }

  // B9 lives in usePendingDelete; requesting a delete replaces any capture
  // toast so only one toast shows at a time.
  function handleDelete(entryId: string) {
    clearTimeout(toastTimerRef.current)
    setToast(null)
    del.request(entryId)
  }

  const today = localDateOf(toLocalIso(new Date()))
  const todayEntries = entries
    .filter((e) => !e.revoked && e.id !== del.pendingId && localDateOf(e.capturedAt) === today)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))

  // C14: before the very first entry, in-browser visitors get nudged toward
  // the installed experience (standalone is where capture is one tap away).
  const firstLaunch = entries.length === 0
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true

  const contextLabel = !appSettings.locationEnabled
    ? undefined
    : here?.placeLabel
      ? `at ${here.placeLabel}`
      : here
        ? 'location on'
        : undefined

  return (
    <div className={cx('flex flex-col gap-4 p-4', motion.fadeIn)}>
      <ScreenHeader
        title="Capture"
        subtitle={`${todayEntries.length} ${todayEntries.length === 1 ? 'entry' : 'entries'} today`}
      />

      <RecordPanel
        recorder={recorder}
        maxClipSec={streamSettings.maxClipSec}
        contextLabel={contextLabel}
        onTap={() => void handleRecordTap()}
        onDiscard={handleDiscard}
        onCamera={() => photoInputRef.current?.click()}
        onText={() => setTextOpen(true)}
      />

      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void submitPhoto(file)
          e.target.value = ''
        }}
      />

      {todayEntries.length === 0 ? (
        <EmptyState title="Nothing logged yet today">
          Tap the mic and say what you're doing — one sentence is plenty.
          {firstLaunch && !standalone && (
            <>
              <br />
              For quickest capture, add this to your Home Screen (Share → Add to Home Screen).
            </>
          )}
        </EmptyState>
      ) : (
        <EntryList entries={todayEntries} onDelete={handleDelete} />
      )}

      {textOpen && (
        <TextSheet
          title="Log an entry"
          placeholder="What just happened?"
          cta="Log entry"
          onSave={(text) => void submitText(text)}
          onClose={() => setTextOpen(false)}
        />
      )}

      {toast?.kind === 'captured' && (
        <Toast actionLabel="Undo" onAction={() => void undoCapture(toast.entryId)}>
          Entry captured
        </Toast>
      )}
      {!toast && del.toastOpen && (
        <Toast actionLabel="Undo" onAction={del.undo}>
          Entry deleted
        </Toast>
      )}
      {toast?.kind === 'discarded' && <Toast>Recording discarded</Toast>}
    </div>
  )
}
