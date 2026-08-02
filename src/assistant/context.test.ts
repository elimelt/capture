import { beforeEach, describe, expect, it } from 'vitest'
import { deviceTz, toLocalIso } from '../contract/time'
import { getDb, resetDbCache } from '../store/db'
import { getSettings } from '../store/settings'
import { ASSISTANT_MODELS, DEFAULT_ASSISTANT_MODEL } from './config'
import { buildInstructions, formatDigest, type DigestItem } from './context'

const NOW = new Date('2026-08-02T12:00:00-04:00')

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

beforeEach(async () => {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
})

describe('config', () => {
  it('default model is on the curated list and matches the settings default', async () => {
    expect(ASSISTANT_MODELS.some((m) => m.id === DEFAULT_ASSISTANT_MODEL)).toBe(true)
    expect((await getSettings()).assistantModel).toBe(DEFAULT_ASSISTANT_MODEL)
  })
})

describe('formatDigest', () => {
  it('handles the empty log', () => {
    expect(formatDigest([])).toBe('(no entries in this period)')
  })

  it('groups by day and renders time, place, texts and media counts', () => {
    const items: DigestItem[] = [
      {
        capturedAt: '2026-08-01T09:30:00-04:00',
        place: 'Office',
        texts: ['standup', 'planning'],
        audioCount: 1,
        photoCount: 0,
      },
      { capturedAt: '2026-08-02T08:05:00-04:00', texts: [], audioCount: 0, photoCount: 2 },
    ]
    expect(formatDigest(items)).toBe(
      [
        '2026-08-01:',
        '- 09:30 @ Office — standup | planning [1 audio]',
        '',
        '2026-08-02:',
        '- 08:05 — [2 photos]',
      ].join('\n'),
    )
  })

  it('marks entries with no text and no media as empty', () => {
    const items: DigestItem[] = [
      { capturedAt: '2026-08-02T10:00:00-04:00', texts: [], audioCount: 0, photoCount: 0 },
    ]
    expect(formatDigest(items)).toContain('- 10:00 — (empty entry)')
  })

  it('renders the entry id as a trailing suffix so update_entry/delete_entry can target it', () => {
    const items: DigestItem[] = [
      {
        capturedAt: '2026-08-02T10:00:00-04:00',
        id: 'e1abc',
        texts: ['walked the dog'],
        audioCount: 0,
        photoCount: 0,
      },
    ]
    expect(formatDigest(items)).toContain('- 10:00 — walked the dog (id e1abc)')
  })
})

describe('buildInstructions', () => {
  it('states the role, points at each tool, and carries the current local time', () => {
    const prompt = buildInstructions(NOW)
    expect(prompt).toContain('Timebox')
    expect(prompt).toContain('list_entries')
    expect(prompt).toContain('search_entries')
    expect(prompt).toContain('get_places')
    expect(prompt).toContain('create_entry')
    expect(prompt).toContain('update_entry')
    expect(prompt).toContain('delete_entry')
    // Writes are opt-in per user turn, never assistant-initiated.
    expect(prompt).toContain('only when the user explicitly asks')
    // Ids are tool plumbing, not conversation content.
    expect(prompt).toContain('Never show raw entry ids to the user in prose')
    const hour = `${toLocalIso(NOW).slice(0, 13)}:00`
    expect(prompt).toContain(`Current local time: ${hour} (${deviceTz()}).`)
  })

  it('affirms the write capability so the model does not act read-only', () => {
    // Regression: with only "write, but only when the user explicitly asks",
    // small models refused writes / claimed to be read-only. The prompt must
    // state the capability and the affirmative triggers for each write tool.
    const prompt = buildInstructions(NOW)
    expect(prompt).toContain('you are not read-only')
    expect(prompt).toContain('add, create, log, note, or record')
    expect(prompt).toContain('call create_entry')
    expect(prompt).toContain('call update_entry')
    expect(prompt).toContain('call delete_entry')
    expect(prompt).toContain('Do not claim you cannot modify the log')
  })

  it('tells the model delete is soft (recoverable), and forbids create_entry as a failed-edit/delete fallback', () => {
    // Regression: a product report described update_entry as "duplicating
    // entries". The write path itself does not duplicate (see
    // tools.realstore.test.ts — an amend never becomes a second entry
    // through the real store/fold), but the prompt gave the model no
    // guidance against recovering from a failed update_entry/delete_entry
    // call (e.g. a mistargeted id) by calling create_entry instead — which
    // *would* look like "the edit duplicated the entry" to the user. The
    // prompt must rule that out explicitly.
    const prompt = buildInstructions(NOW)
    expect(prompt).toContain('soft delete')
    expect(prompt).toContain('recoverable in the log')
    expect(prompt).toContain('do not call create_entry to recover from a failed edit or delete')
    expect(prompt).toContain('create_entry always adds a brand-new entry')
  })

  it('truncates the time to the hour so the prompt is prefix-cache-stable', () => {
    const a = buildInstructions(new Date('2026-08-02T12:07:31-04:00'))
    const b = buildInstructions(new Date('2026-08-02T12:54:09-04:00'))
    expect(a).toBe(b)
  })

  it('no longer embeds a log digest', () => {
    expect(buildInstructions(NOW)).not.toContain('Log entries from the last')
  })
})
