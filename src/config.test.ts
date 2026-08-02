/**
 * Pins the config-drift fix (issue #69): every external host across the
 * app's two build-time endpoint modules — `ENDPOINTS` here (currently just
 * the assistant) and `src/enrich/config.ts`'s `TRANSCRIBE_BASE_URL`/
 * `VISION_CHAT_URL` (issue #62, the transcription/vision fork/self-host
 * seam) — must be whitelisted in index.html's CSP `connect-src`, so moving a
 * host in either place without touching the CSP fails loudly here instead of
 * shipping a build that passes CI and then hits opaque `connect-src`
 * violations in production. Reads index.html via `import.meta.glob(?raw)`
 * (not `node:fs`) for the same reason `layering.test.ts` does — tests run
 * under the app tsconfig, which excludes node types.
 */
import { describe, expect, it } from 'vitest'
import { ENDPOINTS } from './config'
import { TRANSCRIBE_BASE_URL, VISION_CHAT_URL } from './enrich/config'

const htmlFiles = import.meta.glob('../index.html', { query: '?raw', import: 'default', eager: true })
const indexHtml = Object.values(htmlFiles)[0] as string

const ALL_ENDPOINTS: Record<string, string> = {
  ...ENDPOINTS,
  'enrich.transcribe': TRANSCRIBE_BASE_URL,
  'enrich.vision': VISION_CHAT_URL,
}

describe('ENDPOINTS / CSP', () => {
  it('found index.html', () => {
    expect(indexHtml).toContain('Content-Security-Policy')
  })

  it('whitelists every known endpoint host in the connect-src CSP directive', () => {
    const cspMatch = indexHtml.match(/connect-src ([^;"]+)/)
    expect(cspMatch, 'no connect-src directive found in index.html CSP').not.toBeNull()
    const connectSrc = cspMatch![1]
    for (const [name, url] of Object.entries(ALL_ENDPOINTS)) {
      const origin = new URL(url).origin
      expect(connectSrc, `${name} (${origin}) missing from connect-src`).toContain(origin)
    }
  })
})
