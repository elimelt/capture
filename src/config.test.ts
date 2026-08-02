/**
 * Pins the config-drift fix (issue #69): every external host in `ENDPOINTS`
 * must be whitelisted in index.html's CSP `connect-src`, so moving a host
 * here without touching the CSP fails loudly here instead of shipping a
 * build that passes CI and then hits opaque `connect-src` violations in
 * production. Reads index.html via `import.meta.glob(?raw)` (not `node:fs`)
 * for the same reason `layering.test.ts` does — tests run under the app
 * tsconfig, which excludes node types.
 */
import { describe, expect, it } from 'vitest'
import { ENDPOINTS } from './config'

const htmlFiles = import.meta.glob('../index.html', { query: '?raw', import: 'default', eager: true })
const indexHtml = Object.values(htmlFiles)[0] as string

describe('ENDPOINTS / CSP', () => {
  it('found index.html', () => {
    expect(indexHtml).toContain('Content-Security-Policy')
  })

  it('whitelists every ENDPOINTS host in the connect-src CSP directive', () => {
    const cspMatch = indexHtml.match(/connect-src ([^;"]+)/)
    expect(cspMatch, 'no connect-src directive found in index.html CSP').not.toBeNull()
    const connectSrc = cspMatch![1]
    for (const [name, url] of Object.entries(ENDPOINTS)) {
      const origin = new URL(url).origin
      expect(connectSrc, `ENDPOINTS.${name} (${origin}) missing from connect-src`).toContain(
        origin,
      )
    }
  })
})
