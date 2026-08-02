/**
 * Central registry of `meta` object-store key builders (issue #57). The
 * `meta` store (`src/store/db.ts`) is a typeless key-value bag — before this
 * module every owner minted its own key(s) as a bare string template,
 * independently, in nine different files. Two concrete problems that caused:
 *
 *   1. **Duplicated conventions drift silently.** `nextSeq:<stream>` was
 *      re-derived by hand in `gcal/overlay/store.ts`, `migrateChatsV1.ts`, and
 *      `migrateSettingsV1.ts` — a rename in one place would have silently
 *      forked seq counters rather than failing to compile.
 *   2. **No single place says who owns a key, what it holds, or whether
 *      wiping it is correct.** `wipeAll()` (`events.ts`) does `meta.clear()`,
 *      which is *every* key in this file at once — a future key inherits
 *      "destroyed on wipe" whether or not that is the right behavior for it.
 *
 * This module fixes both without touching the wire format: every builder
 * below produces the exact same string an existing device already has on
 * disk (pinned by `metaKeys.test.ts`'s golden literals), so there is nothing
 * to migrate — old rows keep reading under the same keys, just built in one
 * place now. Callers still own the *value* type and read/write logic; this
 * module only owns the *key* string.
 *
 * Every key here is wiped by `wipeAll()`'s `meta.clear()` — that is the
 * documented "wipe local data" contract (`wipeCaches`'s doc comment: a
 * privacy wipe must clear everything reconstructible, not just the parts
 * that are obviously safe). The per-key notes below record *why* that is
 * the right behavior for that key (self-healing cache vs. user-visible
 * reset), so a reviewer can tell "wiped on purpose" from "wiped because
 * nobody thought about it."
 *
 * | Key | Owner | Value | Wiped by wipeAll() |
 * |---|---|---|---|
 * | `nextSeq:<stream>` | `store/events.ts` (shared by `gcal/overlay/store.ts`, `migrateChatsV1.ts`, `migrateSettingsV1.ts`) | `number` | Yes — restarts at 1; correct because the streams it counts (`events`, `overlayEvents`) are cleared in the same transaction. |
 * | `lastSyncAt:<stream>` | `store/events.ts` | ISO string | Yes — a wiped device has no local history left to be "in sync" about. |
 * | `lastSyncResult` | `store/events.ts` | `PersistedSyncResult` | Yes — stale diagnostics about data that no longer exists. |
 * | `drive:token` | `drive/token.ts` | `DriveToken` | Yes — disconnects Google; intentional for a full local-data wipe. |
 * | `drive:tree` | `drive/tree.ts` | `DriveTree` | Yes — advisory cache, self-heals via re-bootstrap. |
 * | `drive:changes:<stream>` | `drive/changes.ts` | `StoredCursor` | Yes — advisory cache, self-heals via one full listing walk. |
 * | `drive:account` | `drive/account.ts` | `string` (permissionId) | Yes — rebinds on the next `about.get` after reconnect. |
 * | `gcal:targetCalendar` | `gcal/config.ts` | `TargetCalendar` | Yes — the Drive-side `config.json` copy survives; local pick re-derives on reconnect. |
 * | `<pipeline>:skip:<file>` | `enrich/runner.ts`, bound per pipeline (`transcribe`, `caption`) | `SkipRecord \| true` (legacy) | Yes. Grows one row per permanently-failed attachment with no sweep (issue #57 evidence #2) — accepted as cheap-per-item; not addressed by this refactor, tracked as a known limitation. |
 * | `migrated:settings-stream-v1` | `store/migrateSettingsV1.ts` | `true` | Yes — harmless: migration markers are only consulted from `db.ts`'s `upgrade()`, which never re-runs just because `getDb()` is called again after a wipe (only a version bump triggers it). |
 * | `migrated:chats:v1` | `store/migrateChatsV1.ts` | `true` | Yes — same reasoning as the settings marker. |
 * | `settings:app`, `settings:stream:<id>` | legacy, pre-v9; read-only rollback artifact consulted by `migrateSettingsV1.ts` | `Record<string, unknown>` | Yes. |
 * | `assistant:chat` | legacy, pre-v3; consulted only inside `db.ts`'s own `oldVersion < 3` branch | `unknown[]` | N/A — deleted by the v3 migration itself, not read again after. |
 *
 * A grep-based guard (`metaKeys.test.ts`, in the spirit of `layering.test.ts`)
 * fails the suite if a file outside this module calls `meta.get`/`meta.put`/
 * `meta.delete`/`db.get('meta', …)`/etc. with a raw string literal instead of
 * one of these builders, so the registry cannot silently rot back into
 * per-module ad-hoc keys.
 */

/** Per-stream seq-counter key, shared by every log that allocates seqs from
 * the `meta` store (the main event log, the calendar-overlay log, and the
 * settings/chats migrations writing seeded events by hand). */
export function seqKey(stream: string): string {
  return `nextSeq:${stream}`
}

/** Per-stream "last clean full sync cycle" stamp (Settings status line). */
export function lastSyncAtKey(stream: string): string {
  return `lastSyncAt:${stream}`
}

/** The whole last sync-cycle attempt across every registered stream (issue #67). */
export const LAST_SYNC_RESULT_KEY = 'lastSyncResult'

/** Mirrored Google access token (SPEC §8.2). */
export const DRIVE_TOKEN_KEY = 'drive:token'

/** Cached Drive file-id tree (SPEC §8, §11). */
export const DRIVE_TREE_KEY = 'drive:tree'

/** Prefix for per-stream `changes.list` cursors (SPEC §8.5). */
export const DRIVE_CHANGES_PREFIX = 'drive:changes:'

/** Per-stream `changes.list` cursor key. */
export function driveChangesKey(stream: string): string {
  return `${DRIVE_CHANGES_PREFIX}${stream}`
}

/** The Google account (`permissionId`) local account-bound caches are bound to. */
export const DRIVE_ACCOUNT_KEY = 'drive:account'

/** The Day view's chosen target calendar (SPEC §4.3, §5.3). */
export const GCAL_TARGET_CALENDAR_KEY = 'gcal:targetCalendar'

/**
 * Prefix for one enrichment pipeline's permanent skip markers, e.g.
 * `skipKeyPrefix('transcribe')` → `'transcribe:skip:'`. Pipelines pass this
 * into `createEnrichmentRunner` (`src/enrich/runner.ts`), which appends the
 * source file to form the full key — same convention, single source of the
 * `<pipeline>:skip:` half so the two pipelines can't drift apart.
 */
export function skipKeyPrefix(pipeline: string): string {
  return `${pipeline}:skip:`
}

/** Meta marker: the v9 legacy-settings-to-event-stream migration has run. */
export const SETTINGS_MIGRATION_MARKER = 'migrated:settings-stream-v1'

/** Meta marker: the v10 legacy-chats-to-event-stream migration has run. */
export const CHATS_MIGRATION_MARKER = 'migrated:chats:v1'

/** Legacy (pre-v9) flat app settings row — read-only rollback source. */
export const LEGACY_SETTINGS_APP_KEY = 'settings:app'

/** Legacy (pre-v9) flat per-stream settings row — read-only rollback source. */
export function legacySettingsStreamKey(streamId: string): string {
  return `settings:stream:${streamId}`
}

/** Legacy (pre-v3) single assistant conversation, deleted by that migration
 * as it runs; kept here only so the historical key lives in the registry. */
export const LEGACY_ASSISTANT_CHAT_KEY = 'assistant:chat'
