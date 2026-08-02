/**
 * Embedded location preview: a small, non-interactive OSM map inside an
 * entry card that expands to a full-screen interactive map on tap. Lazy
 * chunk (Leaflet JS + CSS) — only loaded when a card actually has a location.
 */
import 'leaflet/dist/leaflet.css'
import { useState } from 'react'
import { Circle, CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet'
import type { GeoLocation } from '../contract/types'
import { cx, motion, shape, tone, type_ } from '../ui'

const SPRUCE = '#3A605B'
const CLAY = '#C46D4D'

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

function LocationLabel({ location }: { location: GeoLocation }) {
  const label = location.placeLabel ?? (location.address ? `near ${location.address}` : undefined)
  if (!label) return null
  return <span className={cx('truncate', type_.caption, tone.textMuted)}>{label}</span>
}

/** Compact preview; tap to expand. */
export default function MiniMap({ location }: { location: GeoLocation }) {
  const [expanded, setExpanded] = useState(false)
  const center: [number, number] = [location.lat, location.lng]

  return (
    <>
      <button
        onClick={() => setExpanded(true)}
        aria-label="Expand location map"
        className={cx('block w-full overflow-hidden border text-left', shape.control, tone.border)}
      >
        <div className="pointer-events-none h-24 w-full">
          <MapContainer
            center={center}
            zoom={15}
            zoomControl={false}
            attributionControl={false}
            dragging={false}
            scrollWheelZoom={false}
            doubleClickZoom={false}
            touchZoom={false}
            keyboard={false}
            className="h-full w-full"
          >
            <TileLayer url={TILE_URL} attribution={TILE_ATTR} maxZoom={19} />
            <CircleMarker
              center={center}
              radius={6}
              pathOptions={{ color: CLAY, weight: 2, fillColor: CLAY, fillOpacity: 0.8 }}
            />
          </MapContainer>
        </div>
      </button>

      {expanded && (
        <div
          className={cx(
            'fixed inset-0 z-50 flex flex-col bg-black/85 p-4 pt-[env(safe-area-inset-top)]',
            motion.fadeIn,
          )}
          role="dialog"
          aria-modal="true"
          aria-label="Location"
        >
          <div className={cx('mb-3 flex items-center justify-between gap-2', type_.ui)}>
            <span className="truncate font-medium text-white">
              {location.placeLabel ?? (location.address ? `near ${location.address}` : 'Location')}
            </span>
            <button
              onClick={() => setExpanded(false)}
              className="rounded-xl bg-white/15 px-4 py-2 font-medium text-white"
            >
              Done
            </button>
          </div>
          <div className={cx('min-h-0 flex-1 overflow-hidden', shape.card, motion.scaleIn)}>
            <MapContainer center={center} zoom={16} scrollWheelZoom className="h-full w-full">
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
                <Popup>
                  {location.placeLabel ??
                    (location.address ? `near ${location.address}` : 'Captured here')}
                </Popup>
              </CircleMarker>
            </MapContainer>
          </div>
        </div>
      )}
    </>
  )
}

export { LocationLabel }
