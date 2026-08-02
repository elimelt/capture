import { describe, expect, it } from 'vitest'
import { STREAM_CONFIG_SCHEMA } from '../contract/files'
import { mergeTargetCalendar, resolveTargetSelection } from './config'
import type { CalendarSummary } from './events'

const target = { id: 'team@group', summary: 'Team' }

function parse(text: string) {
  return JSON.parse(text) as {
    schema: string
    stream: string
    skillConfig?: Record<string, unknown>
    userNotes?: string
  }
}

describe('mergeTargetCalendar', () => {
  it('writes targetCalendar into skillConfig, preserving other fields', () => {
    const current = `${JSON.stringify({
      schema: STREAM_CONFIG_SCHEMA,
      stream: 'timelog',
      skillConfig: { consumer: 'skill-x', foo: 1 },
      userNotes: 'keep me',
    })}\n`

    const out = parse(mergeTargetCalendar('timelog', current, target))
    expect(out.schema).toBe(STREAM_CONFIG_SCHEMA)
    expect(out.stream).toBe('timelog')
    expect(out.skillConfig).toEqual({
      consumer: 'skill-x',
      foo: 1,
      targetCalendar: { id: 'team@group', summary: 'Team' },
    })
    expect(out.userNotes).toBe('keep me')
  })

  it('overwrites a prior targetCalendar without touching siblings', () => {
    const current = JSON.stringify({
      schema: STREAM_CONFIG_SCHEMA,
      stream: 'timelog',
      skillConfig: { targetCalendar: { id: 'old', summary: 'Old' }, keep: true },
    })
    const out = parse(mergeTargetCalendar('timelog', current, target))
    expect(out.skillConfig).toEqual({
      keep: true,
      targetCalendar: { id: 'team@group', summary: 'Team' },
    })
  })

  it('falls back to a fresh stub when the body is missing or corrupt', () => {
    for (const bad of [undefined, 'not json', '{"schema":"other.v1"}']) {
      const out = parse(mergeTargetCalendar('timelog', bad, target))
      expect(out.schema).toBe(STREAM_CONFIG_SCHEMA)
      expect(out.stream).toBe('timelog')
      expect(out.skillConfig).toEqual({ targetCalendar: { id: 'team@group', summary: 'Team' } })
      expect('userNotes' in out).toBe(false)
    }
  })

  it('emits fixed-key JSON with a trailing newline (contract convention)', () => {
    const text = mergeTargetCalendar('timelog', undefined, target)
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.indexOf('"schema"')).toBeLessThan(text.indexOf('"stream"'))
  })
})

describe('resolveTargetSelection', () => {
  const primary: CalendarSummary = { id: 'me@gmail.com', summary: 'Me', primary: true }
  const other: CalendarSummary = { id: 'team@group', summary: 'Team', primary: false }

  it('auto-picks the primary calendar when nothing is stored (initial connect)', () => {
    // The regression: displaying primary as selected without persisting it left
    // the Day view on `no-calendar` until the user manually switched calendars.
    const { selectedId, autoPick } = resolveTargetSelection(undefined, [other, primary])
    expect(selectedId).toBe('me@gmail.com')
    expect(autoPick).toEqual({ id: 'me@gmail.com', summary: 'Me' })
  })

  it('keeps a stored target and never re-persists it (no write loop)', () => {
    const stored = { id: 'team@group', summary: 'Team' }
    const { selectedId, autoPick } = resolveTargetSelection(stored, [other, primary])
    expect(selectedId).toBe('team@group')
    expect(autoPick).toBeUndefined()
  })

  it('a stored primary is selected but not re-persisted on later loads', () => {
    const stored = { id: 'me@gmail.com', summary: 'Me' }
    const { autoPick } = resolveTargetSelection(stored, [other, primary])
    expect(autoPick).toBeUndefined()
  })

  it('keeps a stored target even when it is absent from the fetched list', () => {
    const stored = { id: 'gone@group', summary: 'Gone' }
    const { selectedId, autoPick } = resolveTargetSelection(stored, [primary])
    expect(selectedId).toBe('gone@group')
    expect(autoPick).toBeUndefined()
  })

  it('with nothing stored and no primary, keeps the placeholder and persists nothing', () => {
    const { selectedId, autoPick } = resolveTargetSelection(undefined, [other])
    expect(selectedId).toBe('')
    expect(autoPick).toBeUndefined()
  })

  it('handles an empty calendar list', () => {
    expect(resolveTargetSelection(undefined, [])).toEqual({
      selectedId: '',
      autoPick: undefined,
    })
  })
})
