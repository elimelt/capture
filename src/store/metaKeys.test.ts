/**
 * Two guards for the `meta`-store key registry (issue #57):
 *
 *  1. Golden literals — every builder/constant in `metaKeys.ts` must keep
 *     producing the exact bytes existing devices already have on disk. This
 *     module is a pure refactor (centralizing key construction, not changing
 *     it), so these are pinned exactly, the same way `contract/serialize.test.ts`
 *     pins the wire format.
 *  2. A grep-based architecture guard, in the spirit of `layering.test.ts`:
 *     no *source* file outside this module may call the `meta` object store
 *     with a raw string/template literal key. Every real key must go through
 *     a builder here, so the registry cannot silently rot back into per-module
 *     ad-hoc keys. Sources are read via `import.meta.glob(?raw)` (not
 *     `node:fs`) for the same reason `layering.test.ts` does — this file must
 *     type-check under the app tsconfig, which excludes node types. Test
 *     files are exempt: asserting an exact persisted key by literal is a
 *     legitimate, common test pattern (e.g. simulating a pre-migration
 *     on-disk row) and carries none of the "silently forks the convention"
 *     risk raw literals have in production code.
 */
import { describe, expect, it } from 'vitest'
import {
  CHATS_MIGRATION_MARKER,
  driveChangesKey,
  DRIVE_ACCOUNT_KEY,
  DRIVE_CHANGES_PREFIX,
  DRIVE_TOKEN_KEY,
  DRIVE_TREE_KEY,
  GCAL_TARGET_CALENDAR_KEY,
  LAST_SYNC_RESULT_KEY,
  lastSyncAtKey,
  LEGACY_ASSISTANT_CHAT_KEY,
  LEGACY_SETTINGS_APP_KEY,
  legacySettingsStreamKey,
  seqKey,
  SETTINGS_MIGRATION_MARKER,
  skipKeyPrefix,
} from './metaKeys'

describe('metaKeys golden literals (byte-stable — issue #57)', () => {
  it('reproduces every existing on-disk key exactly', () => {
    expect(seqKey('timelog')).toBe('nextSeq:timelog')
    expect(seqKey('calendar-overlay')).toBe('nextSeq:calendar-overlay')
    expect(seqKey('settings')).toBe('nextSeq:settings')
    expect(seqKey('assistant-chats')).toBe('nextSeq:assistant-chats')
    expect(lastSyncAtKey('timelog')).toBe('lastSyncAt:timelog')
    expect(LAST_SYNC_RESULT_KEY).toBe('lastSyncResult')
    expect(DRIVE_TOKEN_KEY).toBe('drive:token')
    expect(DRIVE_TREE_KEY).toBe('drive:tree')
    expect(DRIVE_CHANGES_PREFIX).toBe('drive:changes:')
    expect(driveChangesKey('timelog')).toBe('drive:changes:timelog')
    expect(DRIVE_ACCOUNT_KEY).toBe('drive:account')
    expect(GCAL_TARGET_CALENDAR_KEY).toBe('gcal:targetCalendar')
    expect(skipKeyPrefix('transcribe')).toBe('transcribe:skip:')
    expect(skipKeyPrefix('caption')).toBe('caption:skip:')
    expect(SETTINGS_MIGRATION_MARKER).toBe('migrated:settings-stream-v1')
    expect(CHATS_MIGRATION_MARKER).toBe('migrated:chats:v1')
    expect(LEGACY_SETTINGS_APP_KEY).toBe('settings:app')
    expect(legacySettingsStreamKey('timelog')).toBe('settings:stream:timelog')
    expect(LEGACY_ASSISTANT_CHAT_KEY).toBe('assistant:chat')
  })
})

// Every non-test source file under src/ (metaKeys.ts itself is exempt: it is
// the registry, so it necessarily contains the literals).
const sources = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Call shapes that read/write the `meta` store directly with a literal key
 * (as opposed to an identifier/call resolving to a `metaKeys.ts` builder). */
const DIRECT_LITERAL_PATTERNS = [
  /\bdb\.get\(\s*'meta'\s*,\s*(?=['"`])/,
  /\bdb\.delete\(\s*'meta'\s*,\s*(?=['"`])/,
  /\bdb\.put\(\s*'meta'\s*,\s*[^,()]+,\s*(?=['"`])/,
  /\.objectStore\(\s*'meta'\s*\)\.get\(\s*(?=['"`])/,
  /\.objectStore\(\s*'meta'\s*\)\.delete\(\s*(?=['"`])/,
  /\.objectStore\(\s*'meta'\s*\)\.put\(\s*[^,()]+,\s*(?=['"`])/,
]

/** Finds raw string/template-literal keys passed to the `meta` object store,
 * including through a local alias (`const meta = tx.objectStore('meta')`).
 * Exported so the detector itself is unit-tested against fixtures below —
 * cheap insurance that this doesn't silently stop catching anything. */
export function findRawMetaKeyLiterals(source: string): string[] {
  const hits: string[] = []
  for (const re of DIRECT_LITERAL_PATTERNS) {
    if (re.test(source)) hits.push(re.source)
  }
  // Aliased form: `const <name> = tx.objectStore('meta')` (or `await
  // db.transaction(...).objectStore('meta')`), then `<name>.get('literal')`.
  const aliasRe = /\b(\w+)\s*=\s*(?:await\s+)?[\w.]*\.objectStore\(\s*'meta'\s*\)/g
  for (const m of source.matchAll(aliasRe)) {
    const alias = m[1]
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const method of ['get', 'delete']) {
      if (new RegExp(`\\b${escaped}\\.${method}\\(\\s*(?=['"\`])`).test(source)) {
        hits.push(`${alias}.${method}(<literal>)`)
      }
    }
    if (new RegExp(`\\b${escaped}\\.put\\(\\s*[^,()]+,\\s*(?=['"\`])`).test(source)) {
      hits.push(`${alias}.put(…, <literal>)`)
    }
  }
  return hits
}

describe('meta-store keys are only ever minted via store/metaKeys.ts (issue #57)', () => {
  it('detector catches a direct-literal call', () => {
    expect(findRawMetaKeyLiterals(`await db.get('meta', 'some:raw:key')`)).not.toEqual([])
    expect(findRawMetaKeyLiterals(`await db.put('meta', value, 'some:raw:key')`)).not.toEqual([])
    expect(findRawMetaKeyLiterals(`await db.delete('meta', 'some:raw:key')`)).not.toEqual([])
    expect(
      findRawMetaKeyLiterals(`await tx.objectStore('meta').get(\`raw:\${x}\`)`),
    ).not.toEqual([])
  })

  it('detector catches an aliased-store literal call', () => {
    const src = `
      const meta = tx.objectStore('meta')
      await meta.get('some:raw:key')
    `
    expect(findRawMetaKeyLiterals(src)).not.toEqual([])
  })

  it('detector does not flag builder-backed calls', () => {
    const src = `
      const meta = tx.objectStore('meta')
      await meta.get(seqKey(stream))
      await db.put('meta', token, TOKEN_KEY)
      await db.delete('meta', skipKey(file))
    `
    expect(findRawMetaKeyLiterals(src)).toEqual([])
  })

  it('no source file outside metaKeys.ts mints a raw meta-store key literal', () => {
    const violations: string[] = []
    for (const [fileKey, source] of Object.entries(sources)) {
      const path = fileKey.replace(/^(\.\.\/)+/, '')
      if (path === 'store/metaKeys.ts' || path.endsWith('.test.ts') || path.endsWith('.test.tsx')) {
        continue
      }
      const hits = findRawMetaKeyLiterals(source)
      if (hits.length > 0) violations.push(`src/${path}: ${hits.join(', ')}`)
    }
    expect(
      violations,
      `every meta-store key must be built by src/store/metaKeys.ts, not a raw literal:\n` +
        violations.map((v) => `  ${v}`).join('\n'),
    ).toEqual([])
  })
})
