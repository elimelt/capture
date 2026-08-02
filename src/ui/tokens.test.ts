import { describe, expect, it } from 'vitest'
import { layer } from './tokens'

/** Extract the numeric z value from a Tailwind `z-<n>` utility class. */
function zOf(token: string): number {
  const m = /^z-(\d+)$/.exec(token)
  if (!m) throw new Error(`layer token is not a plain z-<n> class: ${token}`)
  return Number(m[1])
}

describe('layer z scale', () => {
  it('keeps the stacking contract: nav < raised < overlay', () => {
    // The whole point of the scale is the ordering — the tab bar must never
    // reach or exceed the overlay stratum (sheets, scrims, viewers), and
    // toasts/composers sit between them. See the `layer` doc in tokens.ts.
    expect(zOf(layer.nav)).toBeLessThan(zOf(layer.raised))
    expect(zOf(layer.raised)).toBeLessThan(zOf(layer.overlay))
  })

  it('stays below the boot splash (z 100 in index.html)', () => {
    expect(zOf(layer.overlay)).toBeLessThan(100)
  })
})
