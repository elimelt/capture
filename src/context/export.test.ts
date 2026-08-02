import { describe, expect, it } from 'vitest'
import { formatContext, type ContextItem } from './export'

describe('formatContext', () => {
  it('formats a readable markdown log grouped by local day', () => {
    const items: ContextItem[] = [
      {
        capturedAt: '2026-08-01T09:30:00-04:00',
        place: 'Office',
        texts: ['standup', 'planning\nnext steps'],
        audioCount: 1,
        photoCount: 0,
      },
      { capturedAt: '2026-08-02T08:05:00-04:00', texts: [], audioCount: 0, photoCount: 2 },
    ]
    expect(formatContext(items, '2026-08-01', '2026-08-02')).toContain(
      '**09:30** — @ Office · 1 audio recording',
    )
    expect(formatContext(items, '2026-08-01', '2026-08-02')).toContain('  - planning\n    next steps')
    expect(formatContext(items, '2026-08-01', '2026-08-02')).toContain('2 photos')
  })

  it('has an explicit empty state', () => {
    expect(formatContext([], '2026-08-01', '2026-08-02')).toContain('No entries in this period.')
  })
})
