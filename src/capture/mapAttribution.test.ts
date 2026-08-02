/**
 * Guard for #56: every Leaflet map surface in the app must render visible
 * OSM attribution (OSM's tile usage policy requires it). There is no DOM
 * test setup in this repo (vitest runs in the `node` environment — see
 * vite.config.ts — with no jsdom/testing-library), so this checks the
 * source text directly via `import.meta.glob(?raw)`, the same technique
 * `src/layering.test.ts` uses to stay hermetic and type-check under the app
 * tsconfig. It would fail if a future `MapContainer` disables
 * `attributionControl` or a `TileLayer` drops its `attribution` prop.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('OSM tile attribution (#56)', () => {
  it('no MapContainer disables its attribution control', () => {
    const violations: string[] = []
    for (const [file, source] of Object.entries(sources)) {
      if (/attributionControl\s*=\s*\{?\s*false\s*\}?/.test(source)) violations.push(file)
    }
    expect(violations, `attributionControl must not be disabled:\n${violations.join('\n')}`).toEqual(
      [],
    )
  })

  it('every TileLayer carries an OpenStreetMap attribution prop', () => {
    const violations: string[] = []
    for (const [file, source] of Object.entries(sources)) {
      for (const m of source.matchAll(/<TileLayer\b[^/>]*\/?>/g)) {
        if (!/attribution\s*=/.test(m[0])) violations.push(`${file}: ${m[0]}`)
      }
    }
    expect(violations, `every <TileLayer> needs an attribution prop:\n${violations.join('\n')}`).toEqual(
      [],
    )
  })

  it('at least one map surface exists (guards the glob against silently matching nothing)', () => {
    const hasMapContainer = Object.values(sources).some((s) => s.includes('MapContainer'))
    expect(hasMapContainer).toBe(true)
  })
})
