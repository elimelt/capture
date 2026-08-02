/**
 * Pure place-card label derivation (#81) — no I/O, no React. Extracted so
 * `PlaceCard.tsx` and `MiniMap.tsx`'s expanded-dialog labelling share one
 * source of truth for "what do we call this location" instead of each
 * re-deriving the placeLabel/address fallback independently. Never returns
 * raw coordinates: a location with neither a place label nor a
 * reverse-geocoded address falls back to a generic, human title.
 */
import type { GeoLocation } from '../contract/types'

/**
 * Single-line label: `placeLabel` wins, else `"near <address>"`, else
 * `undefined`. Shared by `MiniMap`'s full-screen dialog (header + pin
 * popup), which has no separate title/subtitle slots.
 */
export function locationName(location: GeoLocation): string | undefined {
  if (location.placeLabel) return location.placeLabel
  if (location.address) return `near ${location.address}`
  return undefined
}

export interface PlaceCardModel {
  /** Leading title — a place name, a "near <address>" phrase, or a generic fallback. */
  title: string
  /** Secondary line — only set when a place label *and* an address both exist. */
  subtitle?: string
}

/** Fallback title for a bare coordinate (no place label, no reverse-geocoded address). */
const GENERIC_TITLE = 'Location captured'

/**
 * Title/subtitle pair for the collapsed place card (#81 req 1/2/4): a place
 * label leads as the title with its address as a secondary subtitle; an
 * address alone becomes the "near <address>" title with no subtitle; a bare
 * coordinate falls back to a generic title. No raw lat/lng ever appears in
 * either field.
 */
export function placeCardModel(location: GeoLocation): PlaceCardModel {
  if (location.placeLabel) {
    return {
      title: location.placeLabel,
      subtitle: location.address ? `near ${location.address}` : undefined,
    }
  }
  return { title: locationName(location) ?? GENERIC_TITLE }
}
