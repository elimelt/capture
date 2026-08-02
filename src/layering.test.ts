/**
 * Architecture guard for the SPEC §10 layering rule:
 *
 *   "Layering rule: streams/, capture/, contract/, drive/, store/ are
 *    stream-agnostic and must not import from gcal/ or dayview/ (the
 *    timelog-specific modules)."
 *
 * We additionally keep the generic layers free of settings/ (app-level
 * screens). Sources are read via import.meta.glob(?raw) instead of node:fs
 * so this file type-checks under the app tsconfig, which deliberately keeps
 * node types out (cf. contract/time.test.ts). The drive/ pattern is already
 * listed so the guard covers it the moment the directory appears in M2.
 */
import { describe, expect, it } from 'vitest'

// Layers that must stay stream-agnostic. Keys of `sources` are paths
// relative to src/, e.g. './capture/geo.ts'.
const sources = import.meta.glob(
  [
    './streams/**/*.{ts,tsx}',
    './capture/**/*.{ts,tsx}',
    './contract/**/*.{ts,tsx}',
    './store/**/*.{ts,tsx}',
    './places/**/*.{ts,tsx}',
    './drive/**/*.{ts,tsx}',
    './transcribe/**/*.{ts,tsx}',
    './ui/**/*.{ts,tsx}',
  ],
  { query: '?raw', import: 'default', eager: true },
)

// Top-level src/ directories the generic layers must not reach into.
const FORBIDDEN_DIRS = ['gcal', 'dayview', 'settings']

// Layers that exist today; guards against the glob patterns silently rotting.
const LAYERS_EXPECTED_TODAY = ['streams', 'capture', 'contract', 'store', 'places', 'transcribe', 'ui']

/** Static import/export-from specifiers plus bare side-effect imports. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = []
  for (const re of [/\bfrom\s+(['"])([^'"\n]+)\1/g, /^[ \t]*import\s+(['"])([^'"\n]+)\1/gm]) {
    for (const m of source.matchAll(re)) specs.push(m[2])
  }
  return specs
}

/**
 * Resolves a relative specifier against the importing file's directory and
 * returns the top-level src/ path segment it lands in (a directory, or an
 * index-style import like '../settings'). Returns null for bare (package)
 * specifiers or paths escaping src/.
 */
function resolvedTopDir(fileKey: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const segments = fileKey.split('/').slice(1, -1) // dirs under src/
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (segments.pop() === undefined) return null // escaped src/
    } else {
      segments.push(part)
    }
  }
  return segments[0] ?? null
}

describe('layering rule (SPEC §10)', () => {
  it('collects sources from every generic layer that exists', () => {
    const seen = new Set(Object.keys(sources).map((k) => k.split('/')[1]))
    for (const layer of LAYERS_EXPECTED_TODAY) {
      expect(seen.has(layer), `no files matched for src/${layer}/ — glob patterns broken?`).toBe(
        true,
      )
    }
  })

  it('generic layers do not import from gcal/, dayview/ or settings/', () => {
    const violations: string[] = []
    for (const [fileKey, source] of Object.entries(sources)) {
      for (const spec of importSpecifiers(source)) {
        const topDir = resolvedTopDir(fileKey, spec)
        if (topDir !== null && FORBIDDEN_DIRS.includes(topDir)) {
          violations.push(`src/${fileKey.slice(2)} → '${spec}'`)
        }
      }
    }
    expect(
      violations,
      `stream-agnostic layers must not import timelog-specific/app-level modules:\n` +
        violations.map((v) => `  ${v}`).join('\n'),
    ).toEqual([])
  })
})
