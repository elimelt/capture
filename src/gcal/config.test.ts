import { describe, expect, it } from 'vitest'
import { STREAM_CONFIG_SCHEMA } from '../contract/files'
import { mergeTargetCalendar } from './config'

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
