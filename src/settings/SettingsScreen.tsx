/** Screen 3 — Settings (SPEC §4.3, M1 subset). */
import { useEffect, useState, type ReactNode } from 'react'
import { useAppStore } from '../store/appStore'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-3 text-sm text-slate-700 dark:text-slate-200">
      {label}
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-700'
        }`}
      >
        <span
          className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${
            checked ? 'left-6' : 'left-1'
          }`}
        />
      </button>
    </label>
  )
}

export default function SettingsScreen() {
  const appSettings = useAppStore((s) => s.appSettings)
  const streamSettings = useAppStore((s) => s.streamSettings)
  const places = useAppStore((s) => s.places)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const loadPlaces = useAppStore((s) => s.loadPlaces)
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
    void loadSettings()
    void loadPlaces()
    if (navigator.storage?.estimate) {
      void navigator.storage.estimate().then((est) => {
        if (est.usage !== undefined) {
          setUsage(`${(est.usage / 1_048_576).toFixed(1)} MB used`)
        }
      })
    }
  }, [loadSettings, loadPlaces])

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

  async function wipeData() {
    if (window.confirm('Wipe all local data? Entries not yet synced will be lost.')) {
      await wipe()
      await loadSettings()
    }
  }

  const input =
    'min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'

  return (
    <div className="flex flex-col gap-4 p-4">
      <Section title="Google">
        <p className="text-sm text-slate-500 dark:text-slate-400">Drive sync coming in M2.</p>
        <div className="mt-2 flex gap-3 text-sm">
          <a
            href="https://github.com/elimelt/timebox/issues/1"
            target="_blank"
            rel="noreferrer"
            className="text-sky-600 underline dark:text-sky-400"
          >
            Issue #1
          </a>
          <a
            href="https://github.com/elimelt/timebox/issues/2"
            target="_blank"
            rel="noreferrer"
            className="text-sky-600 underline dark:text-sky-400"
          >
            Issue #2
          </a>
        </div>
      </Section>

      <Section title="Capture">
        <div className="flex flex-col gap-3">
          <label className="flex min-h-11 items-center justify-between gap-3 text-sm text-slate-700 dark:text-slate-200">
            Max clip length (s)
            <input
              type="number"
              min={10}
              max={120}
              value={streamSettings.maxClipSec}
              onChange={(e) => {
                const v = Math.min(120, Math.max(10, Number(e.target.value) || 10))
                void updateStreamSettings({ ...streamSettings, maxClipSec: v })
              }}
              className={`${input} w-24 text-right`}
            />
          </label>
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
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
              Places
            </h3>
            {places.length === 0 && (
              <p className="mb-2 text-sm text-slate-400 dark:text-slate-500">No places yet.</p>
            )}
            <ul className="flex flex-col gap-1">
              {places.map((p) => (
                <li
                  key={p.id}
                  className="flex min-h-11 items-center justify-between gap-2 text-sm text-slate-700 dark:text-slate-200"
                >
                  <span className="truncate">
                    {p.name}
                    <span className="ml-1 text-xs text-slate-400 dark:text-slate-500">
                      {p.radiusM}m
                    </span>
                  </span>
                  <button
                    onClick={() => {
                      if (window.confirm(`Delete place "${p.name}"?`)) void removePlace(p.id)
                    }}
                    className="min-h-11 px-2 text-xs font-medium text-red-600 dark:text-red-400"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
            {pendingPlace ? (
              <div className="mt-2 flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <input
                  autoFocus
                  type="text"
                  value={placeName}
                  onChange={(e) => setPlaceName(e.target.value)}
                  placeholder="Place name"
                  className={input}
                />
                <label className="flex items-center justify-between gap-3 text-sm text-slate-700 dark:text-slate-200">
                  Radius (m)
                  <input
                    type="number"
                    min={10}
                    value={placeRadius}
                    onChange={(e) => setPlaceRadius(Number(e.target.value) || 150)}
                    className={`${input} w-24 text-right`}
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPendingPlace(null)}
                    className="min-h-11 flex-1 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 dark:border-slate-700 dark:text-slate-200"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void savePendingPlace()}
                    disabled={!placeName.trim()}
                    className="min-h-11 flex-1 rounded-lg bg-sky-600 text-sm font-medium text-white disabled:opacity-50"
                  >
                    Save place
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={addCurrentLocation}
                disabled={locating}
                className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 text-sm font-medium text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
              >
                {locating ? 'Locating…' : 'Add current location as place'}
              </button>
            )}
            {locateError && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{locateError}</p>
            )}
          </div>
        </div>
      </Section>

      <Section title="Data">
        {usage && <p className="mb-2 text-sm text-slate-500 dark:text-slate-400">{usage}</p>}
        <button
          onClick={() => void wipeData()}
          className="min-h-11 w-full rounded-lg border border-red-300 text-sm font-medium text-red-600 dark:border-red-900 dark:text-red-400"
        >
          Wipe local data
        </button>
      </Section>
    </div>
  )
}
