import { describe, expect, it } from 'vitest'
import { type_ } from './tokens'

/**
 * Pins the functional typography contract (#85): serif is reserved for
 * content the user reads as theirs (entry text, day titles, meaningful
 * summaries — see `type_` doc comments), sans is reserved for chrome (time,
 * duration, state, controls, metadata). A regression here silently breaks
 * the whole discipline, since every screen composes these tokens rather than
 * hardcoding font-family classes.
 */

/** Tokens that render the user's/app's content voice — serif. */
const SERIF_TOKENS = ['title', 'heading', 'body', 'bodyStrong', 'bodySmall'] as const

/** Tokens that render chrome: labels, controls, metadata — sans. */
const SANS_TOKENS = ['sub', 'caption', 'overline', 'ui'] as const

describe('type_ functional contract (serif = content, sans = chrome)', () => {
  it.each(SERIF_TOKENS)('type_.%s is a serif token', (key) => {
    expect(type_[key]).toContain('font-serif')
    expect(type_[key]).not.toContain('font-sans')
  })

  it.each(SANS_TOKENS)('type_.%s is a sans token', (key) => {
    expect(type_[key]).toContain('font-sans')
    expect(type_[key]).not.toContain('font-serif')
  })

  it('pins caption and sub specifically as sans — the two chrome sizes most', () => {
    // often mistaken for body text (timestamps, subtitles, badges).
    expect(type_.caption).toMatch(/\bfont-sans\b/)
    expect(type_.sub).toMatch(/\bfont-sans\b/)
  })

  it('covers every type_ key with exactly one classification', () => {
    const allKeys = Object.keys(type_)
    const classified = new Set([...SERIF_TOKENS, ...SANS_TOKENS])
    expect(new Set(allKeys)).toEqual(classified)
  })
})
