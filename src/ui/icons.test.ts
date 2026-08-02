import { describe, expect, it } from 'vitest'
import {
  CameraIcon,
  MicIcon,
  TextCursorIcon,
  captureIcon,
  type CaptureKind,
  type IconProps,
} from './icons'

describe('captureIcon', () => {
  it('maps each capture modality to the main-CTA glyph', () => {
    // The entry action row relies on this mapping to stay visually in
    // lockstep with RecordPanel's mic / camera / text-cursor buttons.
    expect(captureIcon('audio')).toBe(MicIcon)
    expect(captureIcon('photo')).toBe(CameraIcon)
    expect(captureIcon('text')).toBe(TextCursorIcon)
  })

  it('renders a decorative svg that scales via the size prop', () => {
    const kinds: CaptureKind[] = ['audio', 'photo', 'text']
    for (const kind of kinds) {
      const el = captureIcon(kind)({ size: 14 })
      const props = el.props as IconProps & Record<string, unknown>
      expect(el.type).toBe('svg')
      expect(props.width).toBe(14)
      expect(props.height).toBe(14)
      // Icons are always paired with a text label or aria-label.
      expect(props['aria-hidden']).toBe('true')
    }
  })
})
