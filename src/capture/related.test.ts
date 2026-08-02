import { describe, expect, it } from 'vitest'
import {
  RELATED_MAX_RESULTS,
  RELATED_MIN_SCORE,
  type RelatedCandidate,
  type RelatedTarget,
  firstLine,
  reasonLabel,
  relatedEntries,
  relativeDayLabel,
  tokenizeEntryText,
} from './related'

const AT = '2026-06-01T09:00:00-04:00'

function target(overrides: Partial<RelatedTarget> = {}): RelatedTarget {
  return {
    id: 'target',
    capturedAt: AT,
    tokens: tokenizeEntryText(['the ci pipeline flow was flaky again']),
    ...overrides,
  }
}

function candidate(overrides: Partial<RelatedCandidate> = {}): RelatedCandidate {
  return {
    id: 'cand',
    capturedAt: AT,
    tokens: new Set<string>(),
    ...overrides,
  }
}

describe('tokenizeEntryText', () => {
  it('case-folds and strips punctuation', () => {
    expect(tokenizeEntryText(['Hello, WORLD!! Testing-things.'])).toEqual(
      new Set(['hello', 'world', 'testing', 'things']),
    )
  })

  it('drops stopwords and very short tokens', () => {
    const tokens = tokenizeEntryText(['I am at the CI meeting to fix a bug'])
    // stopwords (i, am, at, the, to, a) and short tokens (bug is 3 chars -> kept)
    expect(tokens.has('the')).toBe(false)
    expect(tokens.has('at')).toBe(false)
    expect(tokens.has('to')).toBe(false)
    expect(tokens.has('a')).toBe(false)
    expect(tokens.has('ci')).toBe(false) // 2 chars, below MIN_TOKEN_LEN
    expect(tokens.has('meeting')).toBe(true)
    expect(tokens.has('fix')).toBe(true)
    expect(tokens.has('bug')).toBe(true)
  })

  it('merges tokens across multiple text blobs', () => {
    const tokens = tokenizeEntryText(['first blob words', 'second blob content'])
    expect(tokens).toEqual(new Set(['first', 'blob', 'words', 'second', 'content']))
  })

  it('returns an empty set for empty input', () => {
    expect(tokenizeEntryText([])).toEqual(new Set())
    expect(tokenizeEntryText([''])).toEqual(new Set())
  })
})

describe('relatedEntries', () => {
  it('scores a shared-place candidate above a lexical-only candidate', () => {
    const t = target({ placeLabel: 'Office' })
    const placeOnly = candidate({ id: 'place-only', placeLabel: 'Office' })
    const wordsOnly = candidate({
      id: 'words-only',
      tokens: tokenizeEntryText(['flaky pipeline flow issue today']),
    })
    const results = relatedEntries(t, [placeOnly, wordsOnly], { minScore: 0 })
    const byId = new Map(results.map((r) => [r.entryId, r]))
    expect(byId.get('place-only')!.score).toBeGreaterThan(byId.get('words-only')!.score)
    expect(byId.get('place-only')!.reasons).toEqual(['place'])
    expect(byId.get('words-only')!.reasons).toEqual(['words'])
  })

  it('scores disjoint entries at 0 and excludes them, even with the gate open', () => {
    const t = target({ placeLabel: 'Office' })
    const disjoint = candidate({ placeLabel: 'Gym', tokens: tokenizeEntryText(['completely unrelated topic']) })
    expect(relatedEntries(t, [disjoint])).toEqual([])
    expect(relatedEntries(t, [disjoint], { minScore: 0 })).toEqual([])
  })

  it('never returns the target itself, even if present in candidates', () => {
    const t = target({ placeLabel: 'Office' })
    const self: RelatedCandidate = { ...t, revoked: false }
    const results = relatedEntries(t, [self], { minScore: 0 })
    expect(results).toEqual([])
  })

  it('never returns a revoked candidate', () => {
    const t = target({ placeLabel: 'Office' })
    const revoked = candidate({ placeLabel: 'Office', revoked: true })
    const results = relatedEntries(t, [revoked], { minScore: 0 })
    expect(results).toEqual([])
  })

  it('respects RELATED_MAX_RESULTS', () => {
    const t = target({ placeLabel: 'Office' })
    const candidates = Array.from({ length: 10 }, (_, i) =>
      candidate({ id: `c${i}`, placeLabel: 'Office' }),
    )
    const results = relatedEntries(t, candidates)
    expect(results.length).toBeLessThanOrEqual(RELATED_MAX_RESULTS)
    expect(results.length).toBe(RELATED_MAX_RESULTS)
  })

  it('is deterministic: identical inputs produce the same ordered output', () => {
    const t = target({ placeLabel: 'Office' })
    const candidates = [
      candidate({ id: 'a', placeLabel: 'Office' }),
      candidate({ id: 'b', tokens: tokenizeEntryText(['flaky pipeline flow']) }),
      candidate({ id: 'c', placeLabel: 'Office', tokens: tokenizeEntryText(['flaky pipeline flow']) }),
    ]
    const r1 = relatedEntries(t, candidates, { minScore: 0, maxResults: 10 })
    const r2 = relatedEntries(t, candidates.slice().reverse(), { minScore: 0, maxResults: 10 })
    expect(r1).toEqual(r2)
  })

  it('reasons and sharedTerms accurately reflect the scoring path', () => {
    const t = target({ placeLabel: 'Office' })
    const both = candidate({
      id: 'both',
      placeLabel: 'Office',
      tokens: tokenizeEntryText(['flaky pipeline flow']),
    })
    const [result] = relatedEntries(t, [both], { minScore: 0 })
    expect(result.reasons.sort()).toEqual(['place', 'words'])
    expect(result.sharedTerms).toBeDefined()
    for (const term of result.sharedTerms!) {
      expect(t.tokens.has(term)).toBe(true)
      expect(both.tokens.has(term)).toBe(true)
    }
  })

  it('omits sharedTerms when there is no lexical overlap', () => {
    const t = target({ placeLabel: 'Office' })
    const placeOnly = candidate({ placeLabel: 'Office' })
    const [result] = relatedEntries(t, [placeOnly], { minScore: 0 })
    expect(result.sharedTerms).toBeUndefined()
  })

  it('never scores a candidate with an empty placeLabel as a place match', () => {
    const t = target({ placeLabel: '' })
    const c = candidate({ placeLabel: '' })
    // both placeLabels are empty (falsy) and there's no lexical overlap, so
    // this must not be treated as a place match — raw score stays 0.
    expect(relatedEntries(t, [c], { minScore: 0 })).toEqual([])
  })

  it('recency damping never zeroes a strong old match (180-day gap clears the threshold)', () => {
    const t = target({ tokens: tokenizeEntryText(['deep dive on the ci pipeline flow architecture']) })
    const oldDate = '2025-12-03T09:00:00-05:00' // ~180 days before AT
    const strongOld = candidate({
      id: 'old',
      capturedAt: oldDate,
      tokens: tokenizeEntryText(['deep dive on the ci pipeline flow architecture']),
    })
    const results = relatedEntries(t, [strongOld])
    expect(results.length).toBe(1)
    expect(results[0].score).toBeGreaterThanOrEqual(RELATED_MIN_SCORE)
  })

  it('damps a distant weak match below a close match of the same raw strength', () => {
    const t = target({ tokens: tokenizeEntryText(['deep dive ci pipeline flow architecture']) })
    const close = candidate({
      id: 'close',
      capturedAt: AT,
      tokens: tokenizeEntryText(['deep dive ci pipeline flow architecture']),
    })
    const far = candidate({
      id: 'far',
      capturedAt: '2020-01-01T09:00:00-05:00',
      tokens: tokenizeEntryText(['deep dive ci pipeline flow architecture']),
    })
    const results = relatedEntries(t, [close, far], { minScore: 0 })
    const byId = new Map(results.map((r) => [r.entryId, r.score]))
    expect(byId.get('close')!).toBeGreaterThan(byId.get('far')!)
  })
})

describe('firstLine', () => {
  it('takes only the first line', () => {
    expect(firstLine('hello\nworld')).toBe('hello')
  })

  it('trims surrounding whitespace', () => {
    expect(firstLine('  hello  \nworld')).toBe('hello')
  })

  it('truncates long lines with an ellipsis', () => {
    const long = 'a'.repeat(100)
    const result = firstLine(long, 10)
    expect(result.length).toBe(10)
    expect(result.endsWith('…')).toBe(true)
  })

  it('does not truncate lines at or under maxLen', () => {
    expect(firstLine('short', 10)).toBe('short')
  })
})

describe('relativeDayLabel', () => {
  it('labels today and yesterday', () => {
    expect(relativeDayLabel('2026-06-01T09:00:00-04:00', '2026-06-01')).toBe('Today')
    expect(relativeDayLabel('2026-05-31T09:00:00-04:00', '2026-06-01')).toBe('Yesterday')
  })

  it('labels days, weeks, and months ago', () => {
    expect(relativeDayLabel('2026-05-28T09:00:00-04:00', '2026-06-01')).toBe('4 days ago')
    expect(relativeDayLabel('2026-05-18T09:00:00-04:00', '2026-06-01')).toBe('2 weeks ago')
    expect(relativeDayLabel('2026-03-01T09:00:00-05:00', '2026-06-01')).toBe('3 months ago')
  })

  it('labels a year-ago match on the same civil day as "today"', () => {
    expect(relativeDayLabel('2025-06-01T09:00:00-04:00', '2026-06-01')).toBe('1 year ago today')
  })

  it('labels a year-ago match on a different civil day without "today"', () => {
    expect(relativeDayLabel('2025-04-01T09:00:00-04:00', '2026-06-01')).toBe('1 year ago')
  })
})

describe('reasonLabel', () => {
  it('describes a place-only match', () => {
    expect(reasonLabel(['place'], { placeLabel: 'Office' })).toBe('Also at Office')
  })

  it('describes a words-only match', () => {
    expect(reasonLabel(['words'], { sharedTerms: ['pipeline', 'flow'] })).toBe(
      'You\'ve mentioned "pipeline" before',
    )
  })

  it('joins both reasons when both fire', () => {
    expect(reasonLabel(['place', 'words'], { placeLabel: 'Office', sharedTerms: ['pipeline'] })).toBe(
      'Also at Office · You\'ve mentioned "pipeline" before',
    )
  })

  it('returns an empty string when neither reason has supporting data', () => {
    expect(reasonLabel([], {})).toBe('')
  })
})
