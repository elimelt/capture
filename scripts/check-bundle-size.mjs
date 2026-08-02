// Post-build guard for the lazy-chunk strategy the app relies on (issue #71):
// the assistant's AI SDK + markdown renderer must stay in ChatScreen's own
// lazy chunk (excluded from the SW precache in vite.config.ts) so a user who
// never enables the assistant never downloads it. Nothing else in CI (npm
// test, tsc, lint, vite build) asserts this — a stray eager import of
// anything under src/assistant/ from App.tsx's reachable graph would fold
// the AI SDK into the main bundle and every check above would still pass.
// Run after `npm run build`: `node scripts/check-bundle-size.mjs`.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIST_ASSETS = 'dist/assets'
// Generous headroom over the current ~310 KB entry chunk: enough to not
// nag on ordinary growth, tight enough that accidentally bundling the AI SDK
// (which roughly doubles it) still trips this.
const ENTRY_BUDGET_BYTES = 450_000
// A stable, distinctive symbol from the `ai` package's error classes
// (AI_APICallError, AI_InvalidToolInputError, ...) — present in every build
// that includes the SDK, absent otherwise; far more robust than matching on
// a package name string, which minification erases.
const AI_SDK_MARKER = 'AI_APICallError'

function fail(message) {
  console.error(`bundle-size check failed: ${message}`)
  process.exitCode = 1
}

const files = readdirSync(DIST_ASSETS)
const entry = files.find((f) => /^index-.*\.js$/.test(f))
const chatChunk = files.find((f) => /^ChatScreen-.*\.js$/.test(f))

if (!entry) {
  fail(`no entry chunk (index-*.js) found in ${DIST_ASSETS} — did the build output change?`)
} else {
  const entrySource = readFileSync(join(DIST_ASSETS, entry), 'utf8')
  const size = Buffer.byteLength(entrySource)
  console.log(`entry chunk: ${entry} (${size.toLocaleString()} bytes)`)
  if (size > ENTRY_BUDGET_BYTES) {
    fail(
      `entry chunk ${entry} is ${size} bytes, over the ${ENTRY_BUDGET_BYTES}-byte budget — ` +
        `something eager likely pulled in a chunk meant to stay lazy`,
    )
  }
  if (entrySource.includes(AI_SDK_MARKER)) {
    fail(
      `entry chunk ${entry} contains '${AI_SDK_MARKER}' — the AI SDK has leaked into the ` +
        `eagerly-loaded bundle (see docs/ARCHITECTURE.md's lazy-chunk promise); check for a ` +
        `top-level import of src/assistant/ from App.tsx's reachable graph`,
    )
  }
}

if (!chatChunk) {
  fail(
    `no ChatScreen-*.js chunk found in ${DIST_ASSETS} — the assistant's lazy chunk (excluded ` +
      `from the SW precache in vite.config.ts) is missing; did ChatScreen stop being lazy()-loaded?`,
  )
} else {
  console.log(`assistant lazy chunk present: ${chatChunk}`)
}

if (process.exitCode !== 1) console.log('bundle-size check passed')
