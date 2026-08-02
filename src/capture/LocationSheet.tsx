/**
 * Location editor (an "input" like note/photo/audio): drag the pin or tap the
 * map to set a coordinate, use the device location, or clear it. On save it
 * re-matches places and lazily reverse-geocodes a "near …" address. Lazy
 * chunk — pulls in Leaflet only when opened.
 */
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { useMemo, useRef, useState } from 'react'
import { MapContainer, Marker, TileLayer, useMapEvents } from 'react-leaflet'
import type { GeoLocation } from '../contract/types'
import { matchPlace } from '../places/match'
import { reverseGeocode } from '../places/geocode'
import { snapshotLocation } from './geo'
import { useAppStore } from '../store/appStore'
import { Button, Sheet, cx, tone, type_ } from '../ui'

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

// Vector divIcon avoids Leaflet's default marker PNGs (which break under
// bundlers without extra asset config); a clay dot matches capture markers.
const PIN = L.divIcon({
  className: '',
  html: '<span style="display:block;width:16px;height:16px;border-radius:9999px;background:#C46D4D;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)"></span>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
})

const DEFAULT_CENTER: [number, number] = [37.7749, -122.4194]

function ClickToPlace({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) })
  return null
}

interface LocationSheetProps {
  initial?: GeoLocation
  onSave: (location: GeoLocation) => void
  onClear: () => void
  onClose: () => void
}

export function LocationSheet({ initial, onSave, onClear, onClose }: LocationSheetProps) {
  const places = useAppStore((s) => s.places)
  const locationEnabled = useAppStore((s) => s.appSettings.locationEnabled)
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(
    initial ? { lat: initial.lat, lng: initial.lng } : null,
  )
  const [locating, setLocating] = useState(false)
  const [saving, setSaving] = useState(false)
  const markerRef = useRef<L.Marker>(null)

  const center = pos ? ([pos.lat, pos.lng] as [number, number]) : DEFAULT_CENTER
  const dragHandlers = useMemo(
    () => ({
      dragend: () => {
        const m = markerRef.current
        if (m) {
          const { lat, lng } = m.getLatLng()
          setPos({ lat, lng })
        }
      },
    }),
    [],
  )

  async function useCurrent() {
    setLocating(true)
    const loc = await snapshotLocation(places, locationEnabled)
    setLocating(false)
    if (loc) setPos({ lat: loc.lat, lng: loc.lng })
  }

  async function save() {
    if (!pos) return
    setSaving(true)
    const place = matchPlace(places, pos.lat, pos.lng)
    const address = await reverseGeocode(pos.lat, pos.lng)
    setSaving(false)
    onSave({
      lat: pos.lat,
      lng: pos.lng,
      accuracyM: initial?.accuracyM ?? 0,
      ...(place ? { placeLabel: place.name } : {}),
      ...(address ? { address } : {}),
    })
    onClose()
  }

  return (
    <Sheet title={initial ? 'Edit location' : 'Add location'} onClose={onClose}>
      <div className={cx('h-56 overflow-hidden rounded-xl border', tone.border)}>
        <MapContainer center={center} zoom={pos ? 16 : 12} scrollWheelZoom className="h-full w-full">
          <TileLayer url={TILE_URL} attribution={TILE_ATTR} maxZoom={19} />
          <ClickToPlace onPick={(lat, lng) => setPos({ lat, lng })} />
          {pos && (
            <Marker
              draggable
              position={[pos.lat, pos.lng]}
              icon={PIN}
              ref={markerRef}
              eventHandlers={dragHandlers}
            />
          )}
        </MapContainer>
      </div>
      <p className={cx('mt-2', type_.caption, tone.textFaint)}>
        {pos ? 'Drag the pin or tap the map to adjust.' : 'Tap the map or use your current location.'}
      </p>

      <div className="mt-3 flex gap-2">
        <Button variant="secondary" block disabled={locating} onClick={() => void useCurrent()}>
          {locating ? 'Locating…' : 'Use current location'}
        </Button>
        {initial && (
          <Button
            variant="dangerGhost"
            onClick={() => {
              onClear()
              onClose()
            }}
          >
            Clear
          </Button>
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" block onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" block disabled={!pos || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save location'}
        </Button>
      </div>
    </Sheet>
  )
}
