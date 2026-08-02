/**
 * Compact place card (#81): represents an entry's location without loading
 * Leaflet, fetching map tiles, or making any network request — name/label
 * first, a `PinIcon`, and the full interactive map only one tap away via
 * `onExpand`. Replaces `MiniMap`'s old always-mounted 96px map-tile preview,
 * which is now gone entirely; `MiniMap` keeps only the full-screen dialog.
 * A plain row inside the entry's `Card`, not a new bordered surface (#81
 * req 5) — tokens only.
 */
import type { GeoLocation } from '../contract/types'
import { PinIcon, cx, tone, type_ } from '../ui'
import { placeCardModel } from './placeCardModel'

interface PlaceCardProps {
  location: GeoLocation
  /**
   * Optional trailing "captured HH:MM" label. Omit where the caller already
   * shows the capture time elsewhere (EntryCard's header does) — kept
   * optional so other call sites (e.g. a Settings places list) that don't
   * already show a time can still use this row standalone.
   */
  capturedAtLabel?: string
  onExpand: () => void
}

/** Place name/label leading in serif, address secondary, map on tap. */
export function PlaceCard({ location, capturedAtLabel, onExpand }: PlaceCardProps) {
  const { title, subtitle } = placeCardModel(location)
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="Expand location map"
      className={cx(
        'mt-2 flex w-full items-start gap-2 rounded-md py-1 text-left',
        tone.pressWash,
      )}
    >
      <span className={cx('mt-0.5 shrink-0', tone.textMuted)} aria-hidden="true">
        <PinIcon size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span className={cx('truncate', type_.bodyStrong, tone.textPrimary)}>{title}</span>
          {capturedAtLabel && (
            <span className={cx('shrink-0', type_.caption, tone.textFaint)}>
              captured {capturedAtLabel}
            </span>
          )}
        </span>
        {subtitle && <span className={cx('block truncate', type_.caption, tone.textMuted)}>{subtitle}</span>}
      </span>
    </button>
  )
}
