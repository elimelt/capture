/** Screen 3 — Settings (SPEC §4.3, M1 subset). */
import { useEffect, useState } from 'react'
import { ASSISTANT_MODELS } from '../assistant/config'
import { useAppStore } from '../store/appStore'
import {
  Button,
  FieldRow,
  ScreenHeader,
  Section,
  Select,
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
    await addPlace({
      id: crypto.randomUUID(),
      name: placeName.trim(),
      lat: pendingPlace.lat,
      lng: pendingPlace.lng,
      radiusM: placeRadius,
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
        <p className={cx(type_.sub, tone.textMuted)}>Drive sync coming in M2.</p>
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
                  <span className="truncate">
                    {p.name}
                    <span className={cx('ml-1.5', type_.caption, tone.textFaint)}>
                      {p.radiusM}m
                    </span>
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
                <Select
                  value={appSettings.assistantModel}
                  onChange={(e) =>
                    void updateSettings({ ...appSettings, assistantModel: e.target.value })
                  }
                >
                  {ASSISTANT_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </FieldRow>
              <p className={cx(type_.sub, tone.textMuted)}>
                Chat runs against llm.elimelt.com and sends a digest of your last seven days of
                entries as context. Nothing is stored server-side.
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
