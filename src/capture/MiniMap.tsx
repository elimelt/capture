/**
 * Full-screen interactive location map (#81). The only Leaflet surface left
 * in the entry card — `PlaceCard` represents the location by default (no
 * network, no tiles), and this dialog is one explicit tap away, mounted
 * lazily so its chunk (Leaflet JS + CSS) loads only when opened, not for
 * every located card in view. The old always-mounted 96px compact map
 * preview is gone; callers own the open/close boolean and render this only
 * while it's true.
 */
import 'leaflet/dist/leaflet.css'
import { useEffect } from 'react'
import { Circle, CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet'
import type { GeoLocation } from '../contract/types'
import { OverlayPortal, cx, layer, motion, shape, type_ } from '../ui'
import { locationName } from './placeCardModel'

const SPRUCE = '#3A605B'
const CLAY = '#C46D4D'

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

// MapContainer reads `center`/`zoom` only on mount, so after a location amend
// the map would keep showing the old spot (stale tiles/marker). Re-center
// imperatively whenever the coordinate changes.
function Recenter({ lat, lng, zoom }: { lat: number; lng: number; zoom: number }) {
  const map = useMap()
  useEffect(() => {
    map.setView([lat, lng], zoom)
  }, [map, lat, lng, zoom])
  return null
}

/** Full-screen interactive map dialog; `onClose` collapses it back to the `PlaceCard` row. */
export default function MiniMap({
  location,
  onClose,
}: {
  location: GeoLocation
  onClose: () => void
}) {
  const center: [number, number] = [location.lat, location.lng]

  return (
    // Portaled: rendered inside the entry card (a stacking context via its
    // entrance animation) the fullscreen map would paint under the tab bar.
    <OverlayPortal>
      <div
        className={cx(
          'fixed inset-0 flex flex-col bg-black/85 p-4 pt-[env(safe-area-inset-top)]',
          layer.overlay,
          motion.fadeIn,
        )}
        role="dialog"
        aria-modal="true"
        aria-label="Location"
      >
        <div className={cx('mb-3 flex items-center justify-between gap-2', type_.ui)}>
          <span className="truncate font-medium text-white">{locationName(location) ?? 'Location'}</span>
          <button
            onClick={onClose}
            className="rounded-xl bg-white/15 px-4 py-2 font-medium text-white"
          >
            Done
          </button>
        </div>
        <div className={cx('min-h-0 flex-1 overflow-hidden', shape.card, motion.scaleIn)}>
          <MapContainer center={center} zoom={16} scrollWheelZoom className="h-full w-full">
            <Recenter lat={location.lat} lng={location.lng} zoom={16} />
            <TileLayer url={TILE_URL} attribution={TILE_ATTR} maxZoom={19} />
            {location.placeLabel && (
              <Circle
                center={center}
                radius={Math.max(location.accuracyM, 40)}
                pathOptions={{ color: SPRUCE, weight: 2, fillColor: SPRUCE, fillOpacity: 0.12 }}
              />
            )}
            <CircleMarker
              center={center}
              radius={7}
              pathOptions={{ color: CLAY, weight: 2, fillColor: CLAY, fillOpacity: 0.8 }}
            >
              <Popup>{locationName(location) ?? 'Captured here'}</Popup>
            </CircleMarker>
          </MapContainer>
        </div>
      </div>
    </OverlayPortal>
  )
}
