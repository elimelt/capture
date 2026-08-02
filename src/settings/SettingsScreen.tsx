/** Screen 3 — Settings (SPEC §4.3, M1 subset). */
import { useEffect, useState } from 'react'
import { modelLabel } from '../assistant/config'
import type { DrainResult } from '../drive/queue'
import { reverseGeocode } from '../places/geocode'
import { useAppStore } from '../store/appStore'
import {
  Button,
  FieldRow,
  ScreenHeader,
  Section,
  TextInput,
  Toggle,
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
  const [placeRadius, setPlaceRadius] = useState(150)
  const [locating, setLocating] = useState(false)
  const [locateError, setLocateError] = useState<string | null>(null)
  const [usage, setUsage] = useState<string | null>(null)

  useEffect(() => {
    if (navigator.storage?.estimate) {
      void navigator.storage.estimate().then((est) => {
        if (est.usage !== undefined) {
          setUsage(`${(est.usage / 1_048_576).toFixed(1)} MB used`)
        }
      })
    }
  }, [])

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
        setPlaceRadius(150)
      },
      () => {
        setLocating(false)
        setLocateError('Could not get your location.')
      },
      { timeout: 8000, maximumAge: 60_000, enableHighAccuracy: false },
    )
  }

  async function savePendingPlace() {
    if (!pendingPlace || !placeName.trim()) return
    // Best-effort reverse geocode for a "near …" label; never blocks the save.
    const address = await reverseGeocode(pendingPlace.lat, pendingPlace.lng)
    await addPlace({
      id: crypto.randomUUID(),
      name: placeName.trim(),
      lat: pendingPlace.lat,
      lng: pendingPlace.lng,
      radiusM: placeRadius,
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
              value={streamSettings.maxClipSec}
              onChange={(e) => {
                const v = Math.min(120, Math.max(10, Number(e.target.value) || 10))
                void updateStreamSettings({ ...streamSettings, maxClipSec: v })
              }}
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
                    'flex min-h-11 items-center justify-between gap-2',
                    type_.body,
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
                    value={placeRadius}
                    onChange={(e) => setPlaceRadius(Number(e.target.value) || 150)}
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
                    disabled={!placeName.trim()}
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

      <Section title="Assistant">
        <div className="flex flex-col gap-3">
          <Toggle
            label="Enable AI assistant"
            checked={appSettings.assistantEnabled}
            onChange={(v) => void updateSettings({ ...appSettings, assistantEnabled: v })}
          />
          {appSettings.assistantEnabled && (
            <>
              <FieldRow label="Model">
                <span className={cx(type_.sub, tone.textMuted)}>
                  {modelLabel(appSettings.assistantModel)}
                </span>
              </FieldRow>
              <p className={cx(type_.sub, tone.textMuted)}>
                Chat runs against llm.elimelt.com and reads your log on demand through read-only
                tools. Nothing is stored server-side.
              </p>
            </>
          )}
        </div>
      </Section>

      <Section title="Data">
        {usage && <p className={cx('mb-2', type_.sub, tone.textMuted)}>{usage}</p>}
        <Button
          variant={wipeArmed ? 'danger' : 'dangerGhost'}
          block
          onClick={() => void wipeData()}
          className={cx(!wipeArmed && 'border border-clay/40 dark:border-clay-dark/40')}
        >
          {wipeArmed ? 'Tap again to wipe everything' : 'Wipe local data'}
        </Button>
        {wipeArmed && (
          <p className={cx('mt-2 text-center', type_.caption, tone.textMuted)}>
            Entries not yet synced will be lost permanently.
          </p>
        )}
      </Section>
    </div>
  )
}

/** Drive connect/disconnect + manual sync (SPEC §4.3, §8.2). */
const CONNECTION_LABEL: Record<string, string> = {
  connected: 'Connected',
  expired: 'Session expired — reconnect to resume syncing',
  disconnected: 'Not connected',
}

/** Human summary of a manual "Sync now" outcome; null when there's nothing
 * to say (the reconnect case is already covered by the connection pill). */
function syncResultLabel(result: DrainResult): string | null {
  switch (result.outcome) {
    case 'drained':
      return result.uploaded === 1 ? 'Synced 1 entry' : `Synced ${result.uploaded} entries`
    case 'idle':
      return 'Already up to date'
    case 'retry-later':
      return 'Sync busy — will retry shortly'
    case 'error':
      return `Sync failed${result.error ? `: ${result.error}` : ''}`
    case 'reconnect':
      return null
  }
}

function GoogleSection() {
  const connection = useAppStore((s) => s.driveConnection)
  const syncing = useAppStore((s) => s.syncing)
  const connectDrive = useAppStore((s) => s.connectDrive)
  const disconnectDrive = useAppStore((s) => s.disconnectDrive)
  const drainSync = useAppStore((s) => s.drainSync)
  const refreshConnection = useAppStore((s) => s.refreshConnection)
  const [syncNote, setSyncNote] = useState<string | null>(null)

  useEffect(() => {
    void refreshConnection()
  }, [refreshConnection])

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
      {connected && syncNote && !syncing && (
        <p className={cx(type_.sub, tone.textFaint)}>{syncNote}</p>
      )}
    </div>
  )
}
