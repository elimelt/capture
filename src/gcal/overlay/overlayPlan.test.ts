import { describe, expect, it } from 'vitest'
import { toLocalIso } from '../../contract/time'
import { draftFromPseudoEntry, overlayPatchFromDraft, toggleHidden } from './overlayPlan'
import type { PseudoEntry } from './pseudoEntry'
import type { OverlayDraft } from './overlayPlan'

const startMs = new Date('2026-08-02T09:00:00').getTime()
const endMs = new Date('2026-08-02T10:00:00').getTime()

function entry(over: Partial<PseudoEntry> = {}): PseudoEntry {
  return {
    id: 'cal:primary@example.com:ev1',
    target: { calendarId: 'primary@example.com', eventId: 'ev1' },
    title: 'Standup',
    startMs,
    endMs,
    allDay: false,
    hidden: false,
    materialized: false,
    orphaned: false,
    dirty: 'clean',
    dirtyFields: [],
    ...over,
  }
}

describe('draftFromPseudoEntry', () => {
  it('copies the rendered fields into an editable draft', () => {
    expect(draftFromPseudoEntry(entry({ note: 'a note' }))).toEqual({
      title: 'Standup',
      note: 'a note',
      startAt: toLocalIso(new Date(startMs)),
      endAt: toLocalIso(new Date(endMs)),
    })
  })

  it('renders an absent note as an empty string', () => {
    expect(draftFromPseudoEntry(entry()).note).toBe('')
  })
})

describe('overlayPatchFromDraft (no-op guard)', () => {
  const original = draftFromPseudoEntry(entry())

  it('returns undefined for an unedited draft — never materializes an empty overlay', () => {
    expect(overlayPatchFromDraft(original, { ...original })).toBeUndefined()
  })

  it('treats whitespace-only text changes as no-ops', () => {
    expect(
      overlayPatchFromDraft(original, { ...original, title: '  Standup  ' }),
    ).toBeUndefined()
  })

  it('emits only the edited fields', () => {
    expect(overlayPatchFromDraft(original, { ...original, title: 'Renamed' })).toEqual({
      title: 'Renamed',
    })
    expect(overlayPatchFromDraft(original, { ...original, note: 'brought donuts' })).toEqual({
      note: 'brought donuts',
    })
  })

  it('maps an emptied title to clearTitle (revert to the calendar title)', () => {
    expect(overlayPatchFromDraft(original, { ...original, title: '' })).toEqual({
      clearTitle: true,
    })
  })

  it('maps an emptied note to clearNote', () => {
    const withNote: OverlayDraft = { ...original, note: 'old note' }
    expect(overlayPatchFromDraft(withNote, { ...withNote, note: '  ' })).toEqual({
      clearNote: true,
    })
  })

  it('emits startAt/endAt only for the edited side', () => {
    const newStart = toLocalIso(new Date('2026-08-02T08:30:00'))
    expect(overlayPatchFromDraft(original, { ...original, startAt: newStart })).toEqual({
      startAt: newStart,
    })
    const newEnd = toLocalIso(new Date('2026-08-02T11:00:00'))
    expect(overlayPatchFromDraft(original, { ...original, endAt: newEnd })).toEqual({
      endAt: newEnd,
    })
  })

  it('combines edits across fields into one patch', () => {
    const newStart = toLocalIso(new Date('2026-08-02T08:30:00'))
    expect(
      overlayPatchFromDraft(original, {
        title: 'Renamed',
        note: 'n',
        startAt: newStart,
        endAt: original.endAt,
      }),
    ).toEqual({ title: 'Renamed', note: 'n', startAt: newStart })
  })
})

describe('toggleHidden', () => {
  it('flips visibility both ways', () => {
    expect(toggleHidden(entry())).toEqual({ hidden: true })
    expect(toggleHidden(entry({ hidden: true }))).toEqual({ hidden: false })
  })
})
