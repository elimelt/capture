import { describe, expect, it } from 'vitest'
import { canCommitNumericDraft, commitNumericDraft, parseNumericDraft } from './numberDraft'

describe('parseNumericDraft', () => {
  it('parses plain and decimal numbers', () => {
    expect(parseNumericDraft('75')).toBe(75)
    expect(parseNumericDraft('49.6')).toBe(49.6)
    expect(parseNumericDraft(' 42 ')).toBe(42)
  })

  it('keeps partial decimal input parseable while typing', () => {
    expect(parseNumericDraft('1.')).toBe(1)
  })

  it('treats empty and whitespace-only drafts as no value', () => {
    expect(parseNumericDraft('')).toBeUndefined()
    expect(parseNumericDraft('   ')).toBeUndefined()
  })

  it('rejects non-numeric and non-finite drafts', () => {
    expect(parseNumericDraft('abc')).toBeUndefined()
    expect(parseNumericDraft('-')).toBeUndefined()
    expect(parseNumericDraft('Infinity')).toBeUndefined()
  })
})

describe('canCommitNumericDraft', () => {
  it('allows empty as a draft but not as a commit', () => {
    expect(canCommitNumericDraft('')).toBe(false)
  })

  it('rejects invalid drafts and accepts numbers, even out-of-range ones', () => {
    expect(canCommitNumericDraft('abc')).toBe(false)
    expect(canCommitNumericDraft('50')).toBe(true)
    // Out-of-range is still committable — commit clamps, it doesn't reject.
    expect(canCommitNumericDraft('3')).toBe(true)
  })
})

describe('commitNumericDraft', () => {
  it('round-trips an in-range value unchanged', () => {
    expect(commitNumericDraft('75', 10)).toBe(75)
    expect(commitNumericDraft('60', 10, 120)).toBe(60)
  })

  it('rounds decimals to whole numbers', () => {
    expect(commitNumericDraft('49.6', 10)).toBe(50)
  })

  it('clamps below min and above max at commit time', () => {
    expect(commitNumericDraft('3', 10, 120)).toBe(10)
    expect(commitNumericDraft('-20', 10, 120)).toBe(10)
    expect(commitNumericDraft('500', 10, 120)).toBe(120)
  })

  it('leaves large values alone when no max is given', () => {
    expect(commitNumericDraft('5000', 10)).toBe(5000)
  })

  it('returns undefined for empty or invalid drafts instead of a fallback', () => {
    expect(commitNumericDraft('', 10, 120)).toBeUndefined()
    expect(commitNumericDraft('abc', 10, 120)).toBeUndefined()
  })
})
