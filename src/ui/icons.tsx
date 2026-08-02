/**
 * Shared icon set (C15): every capture glyph is drawn once here so the main
 * CTA (RecordPanel) and the entry cards speak the same visual language.
 * `captureIcon` is the single mapping from capture modality → icon
 * (audio → mic, photo → camera, text → text cursor); anything that offers a
 * capture action should render icons through it rather than drawing its own.
 */
import type { ReactElement } from 'react'

export interface IconProps {
  /** Rendered width/height in px; the drawing scales from its viewBox. */
  size?: number
}

/** Voice capture — the main CTA's primary glyph. */
export function MicIcon({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Photo capture. */
export function CameraIcon({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.1l1.15-1.73a1.5 1.5 0 0 1 1.25-.67h4a1.5 1.5 0 0 1 1.25.67L16.4 7h2.1A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

/** Text capture (notes, typed entries) — a classic I-beam text cursor. */
export function TextCursorIcon({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 6.5v11M8.5 3.5c2 0 3.5 1 3.5 3 0-2 1.5-3 3.5-3M8.5 20.5c2 0 3.5-1 3.5-3 0 2 1.5 3 3.5 3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Small plus for "add" affordances (e.g. add location). */
export function PlusIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Small map-pin marking an existing location. */
export function PinIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M11.5 5.8c0 3.4-4.5 6.9-4.5 6.9S2.5 9.2 2.5 5.8a4.5 4.5 0 0 1 9 0Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="5.8" r="1.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/** Small trash for delete actions. */
export function TrashIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M3 4h8M5.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4v7a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Small sliders for "edit/adjust" affordances (e.g. the entry Edit sheet).
 * Distinct from TextCursorIcon, which means *text* capture via `captureIcon`.
 */
export function SlidersIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2 4h6M11 4h1M2 10h1M6 10h6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="9.5" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="10" r="1.6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/** The three capture modalities offered by the main CTA. */
export type CaptureKind = 'audio' | 'photo' | 'text'

/**
 * Capture modality → icon, shared by the main CTA and entry action rows so
 * the same action always carries the same glyph.
 */
export function captureIcon(kind: CaptureKind): (props: IconProps) => ReactElement {
  switch (kind) {
    case 'audio':
      return MicIcon
    case 'photo':
      return CameraIcon
    case 'text':
      return TextCursorIcon
  }
}
