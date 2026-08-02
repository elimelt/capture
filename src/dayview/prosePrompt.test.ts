import { describe, expect, it } from 'vitest'
import { buildDaySummaryPrompt } from './prosePrompt'

describe('buildDaySummaryPrompt', () => {
  it('is byte-stable for a fixed digest (cache-key sanity)', () => {
    const a = buildDaySummaryPrompt('Sunday, August 2', '- 09:00 @ Home — Woke up')
    const b = buildDaySummaryPrompt('Sunday, August 2', '- 09:00 @ Home — Woke up')
    expect(a).toEqual(b)
  })

  it('includes only the date label and digest text, verbatim', () => {
    const prompt = buildDaySummaryPrompt('Today', 'DIGEST_MARKER_TEXT')
    expect(prompt.user).toContain('DIGEST_MARKER_TEXT')
    expect(prompt.user).toContain('Today')
  })

  it('never embeds blob/binary-shaped fields — the digest text is the only variable content', () => {
    const prompt = buildDaySummaryPrompt('Today', '(no entries in this period)')
    expect(prompt.system).not.toMatch(/blob|base64|data:/i)
    expect(prompt.user).not.toMatch(/blob|base64|data:/i)
  })

  it('varies only with its inputs — different digests produce different prompts', () => {
    const a = buildDaySummaryPrompt('Today', 'one thing happened')
    const b = buildDaySummaryPrompt('Today', 'a different thing happened')
    expect(a.user).not.toBe(b.user)
    expect(a.system).toBe(b.system)
  })
})
