import { describe, expect, it, vi } from 'vitest'
import type { Entry } from '../contract/types'
import { formatEntriesPlainText, formatEntryPlainText } from './plainText'

const entry: Entry = {
  id: 'entry-1',
  seq: 12,
  stream: 'timelog',
  loggedAt: '2026-08-02T09:00:00-04:00',
  capturedAt: '2026-08-02T09:04:11-04:00',
  deviceTz: 'America/New_York',
  location: { lat: 40.7128, lng: -74.006, accuracyM: 12, placeLabel: 'Downtown office' },
  attachments: [
    { kind: 'audio', file: 'recording.m4a', mimeType: 'audio/mp4', durationSec: 18.5 },
    { kind: 'photo', file: 'desk.jpg', mimeType: 'image/jpeg' },
    { kind: 'text', file: 'note.txt', mimeType: 'text/plain' },
    { kind: 'text', file: 'transcript.txt', mimeType: 'text/plain', derivedFrom: 'recording.m4a' },
    { kind: 'text', file: 'description.txt', mimeType: 'text/plain', derivedFrom: 'desk.jpg' },
  ],
  attachmentLoggedAt: {
    'recording.m4a': '2026-08-02T09:04:12-04:00',
    'desk.jpg': '2026-08-02T09:04:30-04:00',
    'note.txt': '2026-08-02T09:05:00-04:00',
    'transcript.txt': '2026-08-02T09:05:08-04:00',
    'description.txt': '2026-08-02T09:05:12-04:00',
  },
  lastEventSeq: 12,
  revoked: false,
}

describe('formatEntryPlainText', () => {
  it('labels text by source and includes time-zone, location, and media metadata', async () => {
    const getBlob = vi.fn(async (file: string) => {
      const text: Record<string, string> = {
        'note.txt': 'Plan the afternoon',
        'transcript.txt': 'I reviewed the launch checklist.',
        'description.txt': 'A laptop beside a notebook.',
      }
      return text[file] === undefined ? undefined : new Blob([text[file]], { type: 'text/plain' })
    })

    const result = await formatEntryPlainText(entry, getBlob)

    expect(result).toContain('## 2026-08-02 09:04:11')
    expect(result).toContain('- Time zone: UTC-04:00 · America/New_York')
    expect(result).toContain('- Location: Downtown office — 40.7128, -74.006 (±12 m)')
    expect(result).toContain('- Audio: 1 recording · 18.5s total')
    expect(result).toContain('- Photos: 1')
    expect(result).toContain('  - Recording · 2026-08-02 09:04:12 (UTC-04:00) · 18.5s')
    expect(result).toContain('  - Photo · 2026-08-02 09:04:30 (UTC-04:00)')
    expect(result).toContain('### Note · 2026-08-02 09:05:00 (UTC-04:00)\n    Plan the afternoon')
    expect(result).toContain(
      '### Voice transcript · 2026-08-02 09:05:08 (UTC-04:00)\n    I reviewed the launch checklist.',
    )
    expect(result).toContain(
      '### Image description · 2026-08-02 09:05:12 (UTC-04:00)\n    A laptop beside a notebook.',
    )
    expect(getBlob).toHaveBeenCalledTimes(3)
  })

  it('handles missing text blobs and zero-offset timestamps', async () => {
    const result = await formatEntryPlainText(
      {
        ...entry,
        capturedAt: '2026-08-02T13:04:11Z',
        deviceTz: 'UTC',
        location: undefined,
        attachmentLoggedAt: undefined,
      },
      async () => undefined,
    )

    expect(result).toContain('- Time zone: UTC+00:00 · UTC')
    expect(result).toContain('### Note · 2026-08-02 09:00:00 (UTC-04:00)\n    (text unavailable)')
    expect(result).not.toContain('- Location:')
  })
})

describe('formatEntriesPlainText', () => {
  it('separates entries without reading non-text attachments', async () => {
    const second = { ...entry, id: 'entry-2', attachments: [] }
    const getBlob = vi.fn(async () => new Blob(['hello']))

    const result = await formatEntriesPlainText([entry, second], getBlob)

    expect(result).toContain('entry-1\n')
    expect(result).toContain('\n\n## 2026-08-02 09:04:11')
    expect(getBlob).toHaveBeenCalledTimes(3)
  })
})
