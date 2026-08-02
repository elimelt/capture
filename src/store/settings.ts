/**
 * Settings as an event-sourced system stream (SPEC §3.6). Every settings
 * change is one `capture` event in the `settings` stream (never amend/revoke)
 * carrying a single text/application-json attachment whose blob is a
 * versioned `capture.settings.v1` payload: `{ op: 'set' | 'unset', key,
 * value? }`. Effective state is a last-write-wins fold per key in the
 * standard event order (`compareEvents`: seq → loggedAt → id), so settings
 * converge across devices exactly like entries do — sync is the ordinary
 * drive queue/pull with zero special cases.
 *
 * There is no materialized cache: getters always re-list + re-fold (a
 * lifetime of settings changes is dozens of events); the zustand store stays
 * the in-memory cache via `loadSettings()`. The public API — `getSettings` /
 * `saveSettings` / `getStreamSettings` / `saveStreamSettings` — is unchanged
 * from the legacy meta-backed version; saves diff against the current
 * effective state and emit one event per *changed* key only, so a no-op save
 * appends nothing.
 */
import type { Attachment, LogEvent } from '../contract/types'
import { compareEvents } from '../contract/fold'
import { toLocalIso } from '../contract/time'
import { appendCapture, getBlob, listEvents } from './events'

export interface AppSettings {
  locationEnabled: boolean
  /** AI assistant is fully opt-in; the chat tab and code stay absent until enabled. */
  assistantEnabled: boolean
  /** Model id on the LLM endpoint (curated list in assistant/config.ts). */
  assistantModel: string
}

export interface StreamSettings {
  maxClipSec: number
  keepAudioLocally: boolean
}

/** The system stream (SPEC §3.1) settings events append to. */
export const SETTINGS_STREAM = 'settings'
/** Versioned schema tag of the JSON payload inside each event's attachment. */
export const SETTINGS_PAYLOAD_SCHEMA = 'capture.settings.v1'

export type SettingsValue = string | number | boolean

export interface SettingsSetPayload {
  schema: typeof SETTINGS_PAYLOAD_SCHEMA
  op: 'set'
  /** e.g. "app.locationEnabled", "stream.timelog.maxClipSec" */
  key: string
  value: SettingsValue
}

export interface SettingsUnsetPayload {
  schema: typeof SETTINGS_PAYLOAD_SCHEMA
  op: 'unset'
  key: string
}

export type SettingsPayload = SettingsSetPayload | SettingsUnsetPayload

/**
 * Keys that must never leave the device (consulted by the save diff, which
 * simply never emits an event for them). Empty today — every current setting
 * is a plain preference — but the extension point exists so a genuinely
 * device-bound setting later is one line, not a redesign.
 */
export const LOCAL_ONLY_SETTINGS_KEYS: ReadonlySet<string> = new Set()

export const APP_SETTINGS_DEFAULTS: AppSettings = {
  locationEnabled: true,
  assistantEnabled: false,
  assistantModel: 'gpt-oss:20b',
}

export const STREAM_SETTINGS_DEFAULTS: StreamSettings = {
  maxClipSec: 60,
  keepAudioLocally: true,
}

/** Fully-qualified settings key of an app-level field. */
export function appSettingsKey(field: keyof AppSettings): string {
  return `app.${field}`
}

/** Fully-qualified settings key of a per-stream field. */
export function streamSettingsKey(stream: string, field: keyof StreamSettings): string {
  return `stream.${stream}.${field}`
}

/** [key, value] pairs of an AppSettings object, keys fully qualified. */
export function appSettingsEntries(s: AppSettings): [string, SettingsValue][] {
  return [
    [appSettingsKey('locationEnabled'), s.locationEnabled],
    [appSettingsKey('assistantEnabled'), s.assistantEnabled],
    [appSettingsKey('assistantModel'), s.assistantModel],
  ]
}

/** [key, value] pairs of a StreamSettings object, keys fully qualified. */
export function streamSettingsEntries(stream: string, s: StreamSettings): [string, SettingsValue][] {
  return [
    [streamSettingsKey(stream, 'maxClipSec'), s.maxClipSec],
    [streamSettingsKey(stream, 'keepAudioLocally'), s.keepAudioLocally],
  ]
}

/**
 * Canonical payload bytes (the attachment blob's content): fixed key order
 * (schema, op, key, value), 2-space indent, trailing newline, `value` omitted
 * for `unset` — same conventions as the event record wire format
 * (contract/serialize.ts), and equally a contract: external readers fold
 * these exact shapes.
 */
export function serializeSettingsPayload(p: SettingsPayload): string {
  const ordered: Record<string, unknown> = { schema: p.schema, op: p.op, key: p.key }
  if (p.op === 'set') ordered.value = p.value
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/**
 * Parse and structurally validate a payload; `undefined` (never a throw) on
 * anything malformed or foreign, so one bad attachment can't poison the fold.
 */
export function parseSettingsPayload(json: string): SettingsPayload | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const p = raw as Record<string, unknown>
  if (p.schema !== SETTINGS_PAYLOAD_SCHEMA) return undefined
  if (typeof p.key !== 'string' || p.key === '') return undefined
  if (p.op === 'unset') return { schema: SETTINGS_PAYLOAD_SCHEMA, op: 'unset', key: p.key }
  if (p.op !== 'set') return undefined
  const value = p.value
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return undefined
  }
  return { schema: SETTINGS_PAYLOAD_SCHEMA, op: 'set', key: p.key, value }
}

/**
 * LWW fold: apply every capture event's payloads in `compareEvents` order —
 * the same total order the entry fold uses, so the result is deterministic
 * and convergent across devices regardless of input order. `payloadOf`
 * resolves an attachment to its (already-read) payload; attachments it can't
 * resolve are skipped.
 */
export function foldSettingsPayloads(
  events: readonly LogEvent[],
  payloadOf: (att: Attachment) => SettingsPayload | undefined,
): Map<string, SettingsValue> {
  const state = new Map<string, SettingsValue>()
  for (const e of [...events].sort(compareEvents)) {
    if (e.type !== 'capture') continue
    for (const att of e.attachments) {
      const p = payloadOf(att)
      if (!p) continue
      if (p.op === 'set') state.set(p.key, p.value)
      else state.delete(p.key)
    }
  }
  return state
}

/**
 * Pure diff primitive shared by saves and the v6 migration: payloads for the
 * entries whose value differs from the current effective value, skipping
 * local-only keys.
 */
export function diffSettings(
  next: readonly (readonly [string, SettingsValue])[],
  effective: (key: string) => SettingsValue,
): SettingsSetPayload[] {
  const out: SettingsSetPayload[] = []
  for (const [key, value] of next) {
    if (LOCAL_ONLY_SETTINGS_KEYS.has(key)) continue
    if (value === effective(key)) continue
    out.push({ schema: SETTINGS_PAYLOAD_SCHEMA, op: 'set', key, value })
  }
  return out
}

/** Fresh listEvents + blob reads + LWW fold — the current effective state. */
async function loadSettingsState(): Promise<Map<string, SettingsValue>> {
  const events = await listEvents(SETTINGS_STREAM)
  const byFile = new Map<string, SettingsPayload>()
  for (const e of events) {
    if (e.type !== 'capture') continue
    for (const att of e.attachments) {
      const blob = await getBlob(att.file)
      if (!blob) continue
      const p = parseSettingsPayload(await blob.text())
      if (p) byFile.set(att.file, p)
    }
  }
  return foldSettingsPayloads(events, (att) => byFile.get(att.file))
}

/** Folded value if present and of the default's runtime type, else default. */
function pick<T extends SettingsValue>(
  state: Map<string, SettingsValue>,
  key: string,
  fallback: T,
): T {
  const v = state.get(key)
  return v !== undefined && typeof v === typeof fallback ? (v as T) : fallback
}

/** One settings change = one capture event through the standard append path
 * (events.ts), so the sync row + blob the drive queue pushes are created
 * exactly as for any other stream. */
async function appendSettingsPayload(payload: SettingsPayload): Promise<void> {
  await appendCapture({
    stream: SETTINGS_STREAM,
    // No domain time distinct from append time; append() stamps loggedAt
    // from the same wall clock.
    capturedAt: toLocalIso(new Date()),
    attachments: [
      {
        kind: 'text',
        blob: new Blob([serializeSettingsPayload(payload)], { type: 'application/json' }),
        mimeType: 'application/json',
      },
    ],
  })
}

async function saveEntries(
  next: readonly (readonly [string, SettingsValue])[],
  defaults: readonly (readonly [string, SettingsValue])[],
): Promise<void> {
  const state = await loadSettingsState()
  const defaultOf = new Map(defaults)
  const payloads = diffSettings(next, (key) => pick(state, key, defaultOf.get(key)!))
  for (const p of payloads) await appendSettingsPayload(p)
}

export async function getSettings(): Promise<AppSettings> {
  const state = await loadSettingsState()
  return {
    locationEnabled: pick(
      state,
      appSettingsKey('locationEnabled'),
      APP_SETTINGS_DEFAULTS.locationEnabled,
    ),
    assistantEnabled: pick(
      state,
      appSettingsKey('assistantEnabled'),
      APP_SETTINGS_DEFAULTS.assistantEnabled,
    ),
    assistantModel: pick(
      state,
      appSettingsKey('assistantModel'),
      APP_SETTINGS_DEFAULTS.assistantModel,
    ),
  }
}

export async function saveSettings(next: AppSettings): Promise<void> {
  await saveEntries(appSettingsEntries(next), appSettingsEntries(APP_SETTINGS_DEFAULTS))
}

export async function getStreamSettings(stream: string): Promise<StreamSettings> {
  const state = await loadSettingsState()
  return {
    maxClipSec: pick(
      state,
      streamSettingsKey(stream, 'maxClipSec'),
      STREAM_SETTINGS_DEFAULTS.maxClipSec,
    ),
    keepAudioLocally: pick(
      state,
      streamSettingsKey(stream, 'keepAudioLocally'),
      STREAM_SETTINGS_DEFAULTS.keepAudioLocally,
    ),
  }
}

export async function saveStreamSettings(stream: string, next: StreamSettings): Promise<void> {
  await saveEntries(
    streamSettingsEntries(stream, next),
    streamSettingsEntries(stream, STREAM_SETTINGS_DEFAULTS),
  )
}
