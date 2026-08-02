/**
 * v9 migration: legacy flat settings (meta `settings:app` /
 * `settings:stream:<id>`) become seed events in the `settings` system stream
 * (SPEC §3.7), hand-constructed inside the upgrade transaction the way the
 * v2/v3/v5 migrations write rows directly — append() can't run here.
 *
 * Guarded by *state*, not by `oldVersion`: parallel workstreams claim their
 * own IndexedDB version numbers and can land in any order, so a device may
 * already sit at a higher version (with someone else's migration applied) before this
 * code ships. A meta marker records that this migration ran; db.ts calls it
 * on every upgrade and it no-ops once applied — idempotent by construction.
 *
 * Only keys that differ from their defaults are migrated (sharply reducing
 * the chance two independently-migrating devices clobber each other's
 * customizations), and the migrated events are ordinary queued sync rows, so
 * the next "Sync now" pushes them like any other append. The legacy meta
 * keys are deliberately left in place as an inert rollback artifact; a later
 * PR deletes them once the new path is proven.
 */
import type { IDBPTransaction, StoreNames } from 'idb'
import type { CaptureEvent } from '../contract/types'
import { EVENT_SCHEMA } from '../contract/types'
import { attachmentFileName, eventBaseName } from '../contract/filenames'
import { newEventId } from '../contract/ids'
import { deviceTz, toLocalIso } from '../contract/time'
import { BUILTIN_STREAMS } from '../streams/registry'
import type { TimeboxDB } from './db'
import {
  appSettingsEntries,
  APP_SETTINGS_DEFAULTS,
  diffSettings,
  SETTINGS_STREAM,
  serializeSettingsPayload,
  STREAM_SETTINGS_DEFAULTS,
  streamSettingsEntries,
  type SettingsSetPayload,
  type SettingsValue,
} from './settings'

/** Meta key marking the migration as applied (the idempotency guard). */
export const SETTINGS_MIGRATION_MARKER = 'migrated:settings-stream-v1'

/**
 * Wide enough for both callers: the versionchange upgrade tx (db.ts) and a
 * plain readwrite tx over the same stores (tests exercising idempotency).
 */
type MigrationTx = IDBPTransaction<
  TimeboxDB,
  ArrayLike<StoreNames<TimeboxDB>>,
  'versionchange' | 'readwrite'
>

/**
 * Legacy stored object → payloads for the keys that differ from defaults.
 * `defaults` supplies both the key set and the per-key default; a legacy
 * field only counts when its runtime type matches the default's (junk in an
 * old row must not become a synced event).
 */
function payloadsFromLegacy(
  legacy: unknown,
  defaults: readonly (readonly [string, SettingsValue])[],
): SettingsSetPayload[] {
  if (typeof legacy !== 'object' || legacy === null) return []
  const rec = legacy as Record<string, unknown>
  const defaultOf = new Map(defaults)
  const next: [string, SettingsValue][] = []
  for (const [key, defaultValue] of defaults) {
    const field = key.slice(key.lastIndexOf('.') + 1)
    const v = rec[field]
    if (v !== undefined && typeof v === typeof defaultValue) next.push([key, v as SettingsValue])
  }
  return diffSettings(next, (key) => defaultOf.get(key)!)
}

export async function migrateSettingsV1(tx: MigrationTx): Promise<void> {
  const meta = tx.objectStore('meta')
  if ((await meta.get(SETTINGS_MIGRATION_MARKER)) !== undefined) return

  const payloads: SettingsSetPayload[] = [
    ...payloadsFromLegacy(
      await meta.get('settings:app'),
      appSettingsEntries(APP_SETTINGS_DEFAULTS),
    ),
  ]
  for (const { id } of BUILTIN_STREAMS) {
    payloads.push(
      ...payloadsFromLegacy(
        await meta.get(`settings:stream:${id}`),
        streamSettingsEntries(id, STREAM_SETTINGS_DEFAULTS),
      ),
    )
  }

  // Mirror events.ts#append() by hand: seq counter, event record, blob, and
  // queued sync row, all inside this upgrade transaction. capturedAt equals
  // loggedAt (no meaningful domain time), no location.
  const seqKey = `nextSeq:${SETTINGS_STREAM}`
  let seq = ((await meta.get(seqKey)) as number | undefined) ?? 1
  for (const payload of payloads) {
    const loggedAt = toLocalIso(new Date())
    const event: CaptureEvent = {
      schema: EVENT_SCHEMA,
      type: 'capture',
      id: newEventId(),
      seq: seq++,
      stream: SETTINGS_STREAM,
      loggedAt,
      deviceTz: deviceTz(),
      capturedAt: loggedAt,
      attachments: [],
    }
    const file = attachmentFileName(eventBaseName(event), 'text', 'application/json')
    event.attachments = [{ kind: 'text', file, mimeType: 'application/json' }]
    await tx.objectStore('events').put(event)
    await tx.objectStore('blobs').put({
      file,
      blob: new Blob([serializeSettingsPayload(payload)], { type: 'application/json' }),
    })
    await tx.objectStore('sync').put({
      id: event.id,
      stream: SETTINGS_STREAM,
      seq: event.seq,
      status: 'queued',
      attempts: 0,
      phase: 'attachments-pending',
    })
  }
  if (payloads.length > 0) await meta.put(seq, seqKey)
  await meta.put(true, SETTINGS_MIGRATION_MARKER)
}
