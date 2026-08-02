/** Map — plots saved places and located captures on OpenStreetMap tiles. */
import 'leaflet/dist/leaflet.css'
import { useEffect, useMemo } from 'react'
import { Circle, CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet'
import { timeLabel } from '../capture/EntryCard'
import { useAppStore } from '../store/appStore'
import { EmptyState, ScreenHeader, cx, motion, shape, tone, type_ } from '../ui'

// Leaflet vector styling takes raw colours, not Tailwind classes; mirror the
// spruce/clay tokens from src/index.css @theme (places = spruce, captures = clay).
const SPRUCE = '#3A605B'
const CLAY = '#C46D4D'

/** Frames all points on mount/update; keeps a sane zoom for a lone marker. */
function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (points.length === 0) return
    let minLat = points[0][0]
    let maxLat = points[0][0]
    let minLng = points[0][1]
    let maxLng = points[0][1]
    for (const [lat, lng] of points) {
      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
      minLng = Math.min(minLng, lng)
      maxLng = Math.max(maxLng, lng)
    }
    map.fitBounds(
      [
        [minLat, minLng],
        [maxLat, maxLng],
      ],
      { padding: [28, 28], maxZoom: 16 },
    )
  }, [map, points])
  return null
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function MapScreen() {
  const places = useAppStore((s) => s.places)
  const entries = useAppStore((s) => s.entries)

  const located = useMemo(
    () => entries.filter((e) => !e.revoked && e.location),
    [entries],
  )

  const points = useMemo<[number, number][]>(
    () => [
      ...places.map((p) => [p.lat, p.lng] as [number, number]),
      ...located.map((e) => [e.location!.lat, e.location!.lng] as [number, number]),
    ],
    [places, located],
  )

  const subtitle = `${places.length} ${places.length === 1 ? 'place' : 'places'} · ${
    located.length
  } located`

  return (
    <div className={cx('flex flex-col gap-4 p-4', motion.fadeIn)}>
      <ScreenHeader title="Map" subtitle={subtitle} />

      {points.length === 0 ? (
        <EmptyState title="Nothing to map yet">
          Add a place in Settings, or capture an entry with location enabled, and it appears here.
        </EmptyState>
      ) : (
        <>
          <div className={cx('h-[62vh] overflow-hidden border', shape.card, tone.border)}>
            <MapContainer
              center={points[0]}
              zoom={14}
              scrollWheelZoom
              className="h-full w-full"
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                maxZoom={19}
              />
              <FitBounds points={points} />

              {places.map((p) => (
                <Circle
                  key={p.id}
                  center={[p.lat, p.lng]}
                  radius={p.radiusM}
                  pathOptions={{ color: SPRUCE, weight: 2, fillColor: SPRUCE, fillOpacity: 0.12 }}
                >
                  <Popup>
                    <span className="font-semibold">{p.name}</span> · {p.radiusM}m
                  </Popup>
                </Circle>
              ))}

              {located.map((e) => (
                <CircleMarker
                  key={e.id}
                  center={[e.location!.lat, e.location!.lng]}
                  radius={5}
                  pathOptions={{ color: CLAY, weight: 2, fillColor: CLAY, fillOpacity: 0.7 }}
                >
                  <Popup>
                    <span className="font-semibold">{timeLabel(e.capturedAt)}</span>{' '}
                    {dateLabel(e.capturedAt)}
                    {e.location!.placeLabel && <> · {e.location!.placeLabel}</>}
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>

          <div className={cx('flex items-center gap-4', type_.caption, tone.textFaint)}>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: SPRUCE }}
              />
              Places
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: CLAY }}
              />
              Captures
            </span>
          </div>
        </>
      )}
    </div>
  )
}
