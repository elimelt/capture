import { describe, expect, it } from 'vitest'
import type { PersistedSyncResult } from '../store/events'
import { lastSyncAttemptSummary, notableStreamLines } from './diagnostics'

function result(overrides: Partial<PersistedSyncResult> = {}): PersistedSyncResult {
  return {
    at: '2026-08-02T09:00:00-07:00',
    outcome: 'drained',
    uploaded: 0,
    pulled: 0,
    perStream: [],
    ...overrides,
  }
}

describe('notableStreamLines', () => {
  it('omits streams that finished clean', () => {
    const r = result({
      perStream: [{ stream: 'timelog', outcome: 'drained', uploaded: 1, pulled: 0 }],
    })
    expect(notableStreamLines(r)).toEqual([])
  })

  it('surfaces a pull error even though no sync row would ever record it', () => {
    const r = result({
      outcome: 'error',
      perStream: [
        {
          stream: 'timelog',
          outcome: 'error',
          uploaded: 0,
          pulled: 2,
          error: 'malformed record rejected by parseEvent',
        },
      ],
    })
    expect(notableStreamLines(r)).toEqual([
      'timelog: error — malformed record rejected by parseEvent',
    ])
  })

  it('surfaces reconnect-skipped streams even without an error message', () => {
    const r = result({
      outcome: 'reconnect',
      perStream: [
        { stream: 'settings', outcome: 'reconnect', uploaded: 0, pulled: 0 },
        { stream: 'timelog', outcome: 'reconnect', uploaded: 0, pulled: 3 },
      ],
    })
    expect(notableStreamLines(r)).toEqual(['settings: reconnect', 'timelog: reconnect'])
  })
})

describe('lastSyncAttemptSummary', () => {
  it('reports the outcome alone when nothing moved', () => {
    expect(lastSyncAttemptSummary(result({ outcome: 'idle' }))).toBe('Last attempt: idle')
  })

  it('includes uploaded and pulled counts when non-zero', () => {
    expect(lastSyncAttemptSummary(result({ outcome: 'drained', uploaded: 2, pulled: 5 }))).toBe(
      'Last attempt: drained · 2 uploaded · 5 pulled',
    )
  })
})
