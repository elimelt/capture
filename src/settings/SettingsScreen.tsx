/** Screen 3 — Settings (SPEC §4.3, M1 subset). */
import { useEffect, useState } from 'react'
import { modelLabel } from '../assistant/config'
import { DEFAULT_PLACE_RADIUS_M } from '../capture/geo'
import type { SyncResult } from '../store/appStore'
import { fetchDriveSpace, type DriveSpace } from '../drive/space'
import { getValidAccessToken } from '../drive/token'
import { CalendarError, listCalendars } from '../gcal/client'
import { getTargetCalendar, resolveTargetSelection, setTargetCalendar } from '../gcal/config'
import type { CalendarSummary } from '../gcal/events'
import { reverseGeocode } from '../places/geocode'
import { lastSyncAttemptSummary, notableStreamLines } from './diagnostics'
import { NotificationsSection } from './NotificationsSection'
import { useAppStore } from '../store/appStore'
import { formatBytes } from '../store/space'
import { formatSyncProgress, syncProgressFraction } from '../store/syncProgress'
import { drainTranscriptions, listSkippedTranscriptions, retryTranscription } from '../transcribe/runner'
import { drainCaptions, listSkippedCaptions, retryCaption } from '../vision/runner'
import {
  Button,
  FieldRow,
  ProgressBar,
  ScreenHeader,
  Section,
  Select,
  TextInput,
  Toggle,
  canCommitNumericDraft,
  commitNumericDraft,
  cx,
  motion,
  tone,
  type_,
} from '../ui'

export default function SettingsScreen() {
  const appSettings = useAppStore((s) => s.appSettings)
  const streamSettings = useAppStore((s) => s.streamSettings)
  const places = useAppStore((s) => s.places)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const updateStreamSettings = useAppStore((s) => s.updateStreamSettings)
  const addPlace = useAppStore((s) => s.addPlace)
  const removePlace = useAppStore((s) => s.removePlace)
  const wipe = useAppStore((s) => s.wipe)

  const [pendingPlace, setPendingPlace] = useState<{ lat: number; lng: number } | null>(null)
  const [placeName, setPlaceName] = useState('')
  // String-backed so the field can be momentarily empty while editing without
  // snapping back to a default; validated and clamped only on save, and Save
  // stays disabled while the draft is empty or invalid.
  const [placeRadius, setPlaceRadius] = useState(String(DEFAULT_PLACE_RADIUS_M))
  const [locating, setLocating] = useState(false)
  const [locateError, setLocateError] = useState<string | null>(null)

  // Draft for the max-clip-length field; null mirrors the saved value. While
  // typing, the raw string (including empty) is shown untouched — valid values
  // commit (clamped 10–120) as they're typed, invalid/empty drafts commit
  // nothing, and blur snaps the field back to the last saved value.
  const [clipDraft, setClipDraft] = useState<string | null>(null)

  function addCurrentLocation() {
    setLocateError(null)
    if (!('geolocation' in navigator)) {
      setLocateError('Geolocation is not available on this device.')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false)
        setPendingPlace({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setPlaceName('')
        setPlaceRadius(String(DEFAULT_PLACE_RADIUS_M))
      },
      () => {
        setLocating(false)
        setLocateError('Could not get your location.')
      },
      { timeout: 8000, maximumAge: 60_000, enableHighAccuracy: false },
    )
  }

  async function savePendingPlace() {
    const radiusM = commitNumericDraft(placeRadius, 10)
    if (!pendingPlace || !placeName.trim() || radiusM === undefined) return
    // Best-effort reverse geocode for a "near …" label; never blocks the save.
    const address = await reverseGeocode(pendingPlace.lat, pendingPlace.lng)
    await addPlace({
      id: crypto.randomUUID(),
      name: placeName.trim(),
      lat: pendingPlace.lat,
      lng: pendingPlace.lng,
      radiusM,
      ...(address ? { address } : {}),
    })
    setPendingPlace(null)
  }

  // Wipe is irreversible, so it uses an inline two-tap confirm (no window.confirm
  // — modal dialogs feel broken in standalone PWAs).
  const [wipeArmed, setWipeArmed] = useState(false)
  useEffect(() => {
    if (!wipeArmed) return
    const t = setTimeout(() => setWipeArmed(false), 4000)
    return () => clearTimeout(t)
  }, [wipeArmed])

  async function wipeData() {
    if (!wipeArmed) {
      setWipeArmed(true)
      return
    }
    setWipeArmed(false)
    await wipe()
    await loadSettings()
  }

  return (
    <div className={cx('flex flex-col gap-4 p-4', motion.fadeIn)}>
      <ScreenHeader title="Settings" />

      <Section title="Google">
        <GoogleSection />
      </Section>

      <Section title="Capture">
        <div className="flex flex-col gap-3">
          <FieldRow label="Max clip length (s)">
            <TextInput
              type="number"
              min={10}
              max={120}
              inputMode="numeric"
              value={clipDraft ?? String(streamSettings.maxClipSec)}
              onChange={(e) => {
                setClipDraft(e.target.value)
                const v = commitNumericDraft(e.target.value, 10, 120)
                if (v !== undefined) {
                  void updateStreamSettings({ ...streamSettings, maxClipSec: v })
                }
              }}
              onBlur={() => setClipDraft(null)}
              className="w-24 text-right"
            />
          </FieldRow>
          <Toggle
            label="Keep audio locally"
            checked={streamSettings.keepAudioLocally}
            onChange={(v) => void updateStreamSettings({ ...streamSettings, keepAudioLocally: v })}
          />
        </div>
      </Section>

      <Section title="Location">
        <div className="flex flex-col gap-3">
          <Toggle
            label="Enable location"
            checked={appSettings.locationEnabled}
            onChange={(v) => void updateSettings({ ...appSettings, locationEnabled: v })}
          />
          <div>
            <h3 className={cx('mb-2', type_.overline, tone.textFaint)}>Places</h3>
            {places.length === 0 && (
              <p className={cx('mb-2', type_.sub, tone.textFaint)}>
                No places yet — add one and entries captured nearby get tagged with it.
              </p>
            )}
            <ul className="flex flex-col gap-1">
              {places.map((p) => (
                <li
                  key={p.id}
                  className={cx(
                    // A settings row, not entry content (#85): sans like the
                    // rest of this screen, not the serif entry-content scale.
                    'flex min-h-11 items-center justify-between gap-2',
                    type_.ui,
                    tone.textSecondary,
                  )}
                >
                  <span className="min-w-0 truncate">
                    {p.name}
                    <span className={cx('ml-1.5', type_.caption, tone.textFaint)}>
                      {p.radiusM}m
                    </span>
                    {p.address && (
                      <span className={cx('block truncate', type_.caption, tone.textFaint)}>
                        near {p.address}
                      </span>
                    )}
                  </span>
                  <Button variant="dangerGhost" size="sm" onClick={() => void removePlace(p.id)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            {pendingPlace ? (
              <div
                className={cx('mt-2 flex flex-col gap-2 rounded-xl border p-3', tone.border)}
              >
                <TextInput
                  autoFocus
                  type="text"
                  value={placeName}
                  onChange={(e) => setPlaceName(e.target.value)}
                  placeholder="Place name"
                />
                <FieldRow label="Radius (m)">
                  <TextInput
                    type="number"
                    min={10}
                    inputMode="numeric"
                    value={placeRadius}
                    onChange={(e) => setPlaceRadius(e.target.value)}
                    className="w-24 text-right"
                  />
                </FieldRow>
                <div className="flex gap-2">
                  <Button variant="secondary" block onClick={() => setPendingPlace(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    block
                    disabled={!placeName.trim() || !canCommitNumericDraft(placeRadius)}
                    onClick={() => void savePendingPlace()}
                  >
                    Save place
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="secondary"
                block
                disabled={locating}
                onClick={addCurrentLocation}
                className="mt-2"
              >
                {locating ? 'Locating…' : 'Add current location as place'}
              </Button>
            )}
            {locateError && (
              <p className={cx('mt-1', type_.caption, tone.danger)}>{locateError}</p>
            )}
          </div>
        </div>
      </Section>

      <Section title="AI & privacy">
        <div className="flex flex-col gap-3">
          <p className={cx(type_.sub, tone.textMuted)}>
            Every AI feature below is off by default. Nothing leaves this device to an AI
            endpoint unless you turn it on here.
          </p>
          <Toggle
            label="Auto-transcribe & caption"
            checked={appSettings.enrichmentEnabled}
            onChange={(v) => void updateSettings({ ...appSettings, enrichmentEnabled: v })}
          />
          <p className={cx(type_.sub, tone.textMuted)}>
            When on, captured audio is sent to transcribe.elimelt.com for a text transcript, and
            captured photos are sent to llm.elimelt.com for a caption. Turning this off never
            deletes transcripts or captions you already have — it only stops new ones from being
            generated.
          </p>
          <EnrichmentStatusLine />
          <Toggle
            label="Enable AI assistant"
            checked={appSettings.assistantEnabled}
            onChange={(v) => void updateSettings({ ...appSettings, assistantEnabled: v })}
          />
          {appSettings.assistantEnabled ? (
            <>
              <FieldRow label="Model">
                <span className={cx(type_.sub, tone.textMuted)}>
                  {modelLabel(appSettings.assistantModel)}
                </span>
              </FieldRow>
              <p className={cx(type_.sub, tone.textMuted)}>
                Ask AI from any entry card. It runs against llm.elimelt.com and reads your
                log on demand through tools. Nothing is stored server-side.
              </p>
            </>
          ) : (
            <p className={cx(type_.sub, tone.textMuted)}>
              When on, chat messages you send are sent to llm.elimelt.com. No request leaves the
              device until you send a message.
            </p>
          )}
        </div>
      </Section>

      <NotificationsSection />

      <Section title="Data">
        <StorageLines />
        <Button
          variant={wipeArmed ? 'danger' : 'dangerGhost'}
          block
          onClick={() => void wipeData()}
          className={cx(!wipeArmed && 'border border-clay/40 dark:border-clay-dark/40')}
        >
          {wipeArmed ? 'Tap again to wipe everything' : 'Wipe local data'}
        </Button>
        {wipeArmed ? (
          <p className={cx('mt-2 text-center', type_.caption, tone.textMuted)}>
            Entries not yet synced will be lost permanently.
          </p>
        ) : (
          <p className={cx('mt-2 text-center', type_.caption, tone.textMuted)}>
            Clears this device's log, caches, and Google connection.
          </p>
        )}
      </Section>

      <Section title="Diagnostics">
        <DiagnosticsSection />
      </Section>
    </div>
  )
}

/**
 * Read-only sync diagnostics (issue #67): the last full cycle's outcome
 * survives a relaunch (persisted via `store/events.ts`), so a pull error —
 * which never writes a sync row and is otherwise gone the moment the 6 s
 * error toast clears — stays inspectable here. Streams that finished clean
 * are omitted from the detail list; nothing to report reads as reassuring,
 * not empty.
 */
function DiagnosticsSection() {
  const lastSyncResult = useAppStore((s) => s.lastSyncResult)
  const driveConnection = useAppStore((s) => s.driveConnection)

  if (!lastSyncResult) {
    return (
      <p className={cx(type_.sub, tone.textFaint)}>
        No sync attempted yet on this device ({CONNECTION_LABEL[driveConnection]}).
      </p>
    )
  }

  const lines = notableStreamLines(lastSyncResult)
  return (
    <div className="flex flex-col gap-1">
      <p className={cx(type_.sub, tone.textMuted)}>{lastSyncAttemptSummary(lastSyncResult)}</p>
      <p className={cx(type_.caption, tone.textFaint)}>
        {lastSyncedLabel(lastSyncResult.at)} · {CONNECTION_LABEL[driveConnection]}
      </p>
      {lines.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {lines.map((line) => (
            <li key={line} className={cx(type_.caption, tone.danger)}>
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Surfaces enrichment items the transcribe/vision runners have permanently
 * given up on (issue #55: previously invisible and unrecoverable — an entry
 * simply never grew a transcript/caption, with no explanation). Counts are
 * loaded on mount/toggle only (Settings entry stays network-free otherwise);
 * "Retry" clears every skip marker and runs both drains once immediately so
 * the user sees the outcome without waiting for the next entries-changed
 * drain trigger.
 */
function EnrichmentStatusLine() {
  const enrichmentEnabled = useAppStore((s) => s.appSettings.enrichmentEnabled)
  const currentStreamId = useAppStore((s) => s.currentStreamId)
  const refresh = useAppStore((s) => s.refresh)
  const [skipped, setSkipped] = useState<number | null>(null)
  const [retrying, setRetrying] = useState(false)

  async function loadSkipped() {
    const [transcripts, captions] = await Promise.all([
      listSkippedTranscriptions(),
      listSkippedCaptions(),
    ])
    setSkipped(transcripts.length + captions.length)
  }

  useEffect(() => {
    if (!enrichmentEnabled) {
      setSkipped(null)
      return
    }
    void loadSkipped()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadSkipped is stable across renders
  }, [enrichmentEnabled])

  async function retryAll() {
    setRetrying(true)
    try {
      const [transcripts, captions] = await Promise.all([
        listSkippedTranscriptions(),
        listSkippedCaptions(),
      ])
      await Promise.all([
        ...transcripts.map((t) => retryTranscription(t.file)),
        ...captions.map((c) => retryCaption(c.file)),
      ])
      await Promise.all([drainTranscriptions(currentStreamId), drainCaptions(currentStreamId)])
      await refresh()
      await loadSkipped()
    } finally {
      setRetrying(false)
    }
  }

  if (!enrichmentEnabled || !skipped) return null

  return (
    <div className="flex items-center justify-between gap-2">
      <p className={cx(type_.sub, tone.textMuted)}>
        {skipped === 1 ? '1 item' : `${skipped} items`} couldn’t be processed automatically.
      </p>
      <Button variant="secondary" size="sm" disabled={retrying} onClick={() => void retryAll()}>
        {retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  )
}

/**
 * Local + Drive storage usage (SPEC §4.3, Data section). Local numbers come
 * from the store — the origin-level `storage.estimate()` plus the app's own
 * IndexedDB breakdown — refreshed on entry and by `wipe()`, so the display
 * never goes stale. Drive numbers are fetched only on demand (a tap), never
 * polled: Settings entry stays network-free like the rest of the screen.
 * Degrades gracefully: no estimate support hides the device line; no Drive
 * connection hides the Drive line entirely.
 */
function StorageLines() {
  const localSpace = useAppStore((s) => s.localSpace)
  const appSpace = useAppStore((s) => s.appSpace)
  const refreshSpace = useAppStore((s) => s.refreshSpace)
  const connection = useAppStore((s) => s.driveConnection)
  const [drive, setDrive] = useState<DriveSpace | null>(null)
  const [driveStatus, setDriveStatus] = useState<'idle' | 'loading' | 'error'>('idle')

  useEffect(() => {
    void refreshSpace()
  }, [refreshSpace])

  async function checkDrive() {
    setDriveStatus('loading')
    setDrive(null)
    try {
      const token = await getValidAccessToken()
      if (token === undefined) {
        setDriveStatus('error')
        return
      }
      setDrive(await fetchDriveSpace(token))
      setDriveStatus('idle')
    } catch {
      setDriveStatus('error')
    }
  }

  return (
    <div className="mb-2 flex flex-col gap-1">
      {localSpace?.usageBytes !== undefined && (
        <p className={cx(type_.sub, tone.textMuted)}>
          On this device: {formatBytes(localSpace.usageBytes)} used
          {localSpace.quotaBytes !== undefined && <> of {formatBytes(localSpace.quotaBytes)}</>}
        </p>
      )}
      {appSpace !== null && appSpace.totalBytes > 0 && (
        <p className={cx(type_.caption, tone.textFaint)}>
          App data {formatBytes(appSpace.totalBytes)} — log {formatBytes(appSpace.eventBytes)} ·
          attachments {formatBytes(appSpace.blobBytes)}
          {appSpace.chatBytes > 0 && <> · chats {formatBytes(appSpace.chatBytes)}</>}
        </p>
      )}
      {connection === 'connected' &&
        (drive !== null ? (
          <p className={cx(type_.sub, tone.textMuted)}>
            Drive: {formatBytes(drive.usageBytes)} used
            {drive.limitBytes !== undefined && <> of {formatBytes(drive.limitBytes)}</>}
            <span className={cx('ml-1', tone.textFaint)}>
              · this app {formatBytes(drive.appBytes)}
            </span>
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <Button
              variant="secondary"
              size="sm"
              disabled={driveStatus === 'loading'}
              onClick={() => void checkDrive()}
              className="self-start"
            >
              {driveStatus === 'loading' ? 'Checking…' : 'Check Drive storage'}
            </Button>
            {driveStatus === 'error' && (
              <p className={cx(type_.caption, tone.danger)}>
                Couldn’t check Drive storage — try again or reconnect.
              </p>
            )}
          </div>
        ))}
    </div>
  )
}

/** Drive connect/disconnect + manual sync (SPEC §4.3, §8.2). */
const CONNECTION_LABEL: Record<string, string> = {
  connected: 'Connected',
  expired: 'Session expired — reconnect to resume syncing',
  disconnected: 'Not connected',
}

/**
 * Human summary of a manual "Sync now" outcome; null when there's nothing to
 * say (the reconnect case is already covered by the connection pill).
 *
 * `'busy'` and `'retry-later'` used to share one label ("A sync is already
 * in progress") even though only `'busy'` means that — `'retry-later'` is a
 * real Drive-side 429/5xx outage after streams *did* run (issue #64), which
 * that message actively misled the owner about (nothing was in progress;
 * double-tapping right after could even no-op silently). They're split here,
 * and `'retry-later'`/`'quota'` both surface the row-level error Drive gave,
 * when the drainer captured one (`src/drive/queue.ts`, `pull.ts`).
 */
function syncResultLabel(result: SyncResult): string | null {
  switch (result.outcome) {
    case 'drained': {
      const parts: string[] = []
      if (result.uploaded > 0) {
        parts.push(result.uploaded === 1 ? 'Synced 1 entry' : `Synced ${result.uploaded} entries`)
      }
      if (result.pulled > 0) {
        parts.push(result.pulled === 1 ? 'pulled 1 entry' : `pulled ${result.pulled} entries`)
      }
      return parts.length > 0 ? parts.join(' · ') : 'Already up to date'
    }
    case 'idle':
      return 'Already up to date'
    case 'busy':
      return 'A sync is already in progress'
    case 'retry-later':
      return `Drive is busy or temporarily unavailable — will retry${result.error ? ` (${result.error})` : ''}`
    case 'quota':
      return `Google Drive storage is full — free up space, then Sync now${result.error ? ` (${result.error})` : ''}`
    case 'error':
      return `Sync failed${result.error ? `: ${result.error}` : ''}`
    case 'reconnect':
      return null
  }
}

/** "Last synced" timestamp, kept short: time only today, date + time otherwise. */
function lastSyncedLabel(iso: string): string {
  const at = new Date(iso)
  const sameDay = at.toDateString() === new Date().toDateString()
  return at.toLocaleString(
    [],
    sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  )
}

/**
 * Local sync-state rollup across *all* registered streams (capture + system):
 * pending/error counts summed over every stream's sync rows, plus the oldest
 * per-stream lastSyncAt. "Out of sync" whenever anything is pending, anything
 * errored, or any stream has never completed a clean cycle. No network
 * involved.
 */
function SyncStatusLine() {
  const { pending, errors, lastError, lastSyncAt } = useAppStore((s) => s.globalSyncSummary)
  const outOfSync = pending > 0 || errors > 0 || !lastSyncAt

  const parts: string[] = [outOfSync ? 'Out of sync' : 'Up to date']
  if (pending > 0) parts.push(pending === 1 ? '1 entry waiting' : `${pending} entries waiting`)
  if (errors > 0) parts.push(errors === 1 ? '1 failed' : `${errors} failed`)

  return (
    <div className="flex flex-col gap-0.5">
      <p className={cx(type_.sub, outOfSync ? tone.danger : tone.textMuted)}>
        {parts.join(' · ')}
      </p>
      {lastError && (
        <p className={cx(type_.caption, tone.danger)}>Last error: {lastError}</p>
      )}
      <p className={cx(type_.caption, tone.textFaint)}>
        {lastSyncAt ? `Last synced ${lastSyncedLabel(lastSyncAt)}` : 'Never synced'}
      </p>
    </div>
  )
}

/**
 * Target-calendar picker (SPEC §4.3): lists the connected account's calendars
 * and persists the choice (local + config.json) via gcal/config. Only rendered
 * when connected. When nothing is stored yet (first load after connecting),
 * the primary calendar is auto-picked *and persisted* — merely displaying it
 * as selected left `getTargetCalendar()` empty, so the Day view showed no
 * events until the user manually switched calendars. A 401/403 here means the
 * calendar scope isn't granted on the current token — prompt a reconnect
 * rather than showing an empty list.
 */
function CalendarPicker() {
  const [calendars, setCalendars] = useState<CalendarSummary[] | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'auth' | 'error'>('loading')
  const [saveNote, setSaveNote] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const token = await getValidAccessToken()
      if (token === undefined) {
        if (live) setStatus('auth')
        return
      }
      try {
        const [cals, target] = await Promise.all([listCalendars(token), getTargetCalendar()])
        if (!live) return
        const { selectedId, autoPick } = resolveTargetSelection(target, cals)
        setCalendars(cals)
        setSelected(selectedId)
        setStatus('ready')
        if (autoPick !== undefined) {
          try {
            await setTargetCalendar(token, autoPick)
            if (live) setSaveNote(`Showing “${autoPick.summary}” on the day view`)
          } catch {
            // Local pick already persisted; only the Drive mirror failed (§5.3).
            if (live) setSaveNote('Saved on this device; will sync to Drive later')
          }
        }
      } catch (err) {
        if (!live) return
        setStatus(err instanceof CalendarError && err.isAuth ? 'auth' : 'error')
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const handlePick = async (id: string) => {
    setSelected(id)
    setSaveNote(null)
    const cal = calendars?.find((c) => c.id === id)
    const token = await getValidAccessToken()
    if (cal === undefined || token === undefined) {
      setSaveNote('Reconnect to save your calendar')
      return
    }
    try {
      await setTargetCalendar(token, { id: cal.id, summary: cal.summary })
      setSaveNote(`Showing “${cal.summary}” on the day view`)
    } catch {
      // Local pick already persisted; only the Drive mirror failed (§5.3).
      setSaveNote('Saved on this device; will sync to Drive later')
    }
  }

  if (status === 'auth')
    return (
      <p className={cx(type_.sub, tone.textFaint)}>
        Reconnect to grant calendar access, then pick a calendar.
      </p>
    )
  if (status === 'error')
    return <p className={cx(type_.sub, tone.textFaint)}>Couldn’t load your calendars.</p>
  if (status === 'loading' || calendars === null)
    return <p className={cx(type_.sub, tone.textFaint)}>Loading calendars…</p>

  return (
    <div className="flex flex-col gap-2">
      <FieldRow label="Day-view calendar">
        <Select value={selected} onChange={(e) => void handlePick(e.target.value)}>
          <option value="" disabled>
            Choose a calendar
          </option>
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.summary}
              {c.primary ? ' (primary)' : ''}
            </option>
          ))}
        </Select>
      </FieldRow>
      {saveNote && <p className={cx(type_.sub, tone.textFaint)}>{saveNote}</p>}
    </div>
  )
}

function GoogleSection() {
  const connection = useAppStore((s) => s.driveConnection)
  const quotaExceeded = useAppStore((s) => s.driveQuotaExceeded)
  const syncing = useAppStore((s) => s.syncing)
  const syncProgress = useAppStore((s) => s.syncProgress)
  const connectDrive = useAppStore((s) => s.connectDrive)
  const disconnectDrive = useAppStore((s) => s.disconnectDrive)
  const drainSync = useAppStore((s) => s.drainSync)
  const refresh = useAppStore((s) => s.refresh)
  const refreshConnection = useAppStore((s) => s.refreshConnection)
  const [syncNote, setSyncNote] = useState<string | null>(null)

  // Re-read local state on entry so the status line is current; neither call
  // touches the network (sync itself is manual-only).
  useEffect(() => {
    void refreshConnection()
    void refresh()
  }, [refreshConnection, refresh])

  const handleSync = async () => {
    setSyncNote(null)
    setSyncNote(syncResultLabel(await drainSync()))
  }

  const connected = connection === 'connected'
  return (
    <div className="flex flex-col gap-3">
      <p className={cx(type_.sub, tone.textMuted)}>
        {CONNECTION_LABEL[connection]}
        {connected && <span className={cx('ml-1', tone.textFaint)}>· Drive file access</span>}
      </p>
      <SyncStatusLine />
      {connected && quotaExceeded && (
        // Persists across remounts (unlike syncNote below, which is local
        // component state) until a cycle that doesn't hit quota runs again —
        // SPEC §8.4.5 requires this to surface explicitly rather than as the
        // reconnect pill, which a full-but-authorized Drive can never clear
        // (issue #88).
        <p className={cx(type_.sub, tone.danger)}>
          Google Drive storage is full — free up space, then Sync now.
        </p>
      )}
      <div className="flex gap-2">
        {connected ? (
          <>
            <Button variant="secondary" block disabled={syncing} onClick={() => void handleSync()}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button variant="dangerGhost" block onClick={() => void disconnectDrive()}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button variant="primary" block disabled={syncing} onClick={() => void connectDrive()}>
            {connection === 'expired' ? 'Reconnect Google' : 'Connect Google'}
          </Button>
        )}
      </div>
      {connected && syncing && syncProgress && (
        <div className={cx('flex flex-col gap-1', motion.fadeIn)}>
          <ProgressBar fraction={syncProgressFraction(syncProgress)} />
          <p className={cx(type_.caption, tone.textFaint)}>{formatSyncProgress(syncProgress)}</p>
        </div>
      )}
      {connected && syncNote && !syncing && (
        <p className={cx(type_.sub, tone.textFaint)}>{syncNote}</p>
      )}
      {connected && <CalendarPicker />}
    </div>
  )
}
