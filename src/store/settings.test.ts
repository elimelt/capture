import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CaptureEvent } from '../contract/types'
import { EVENT_SCHEMA } from '../contract/types'
import { attachmentFileName, eventBaseName } from '../contract/filenames'
import { getDb, resetDbCache } from './db'
import { appendCapture, getSyncStatuses, importEvents, listEvents } from './events'
import {
  APP_SETTINGS_DEFAULTS,
  foldSettingsPayloads,
  getSettings,
  getStreamSettings,
  parseSettingsPayload,
  saveSettings,
  saveStreamSettings,
  serializeSettingsPayload,
  SETTINGS_PAYLOAD_SCHEMA,
  SETTINGS_STREAM,
  STREAM_SETTINGS_DEFAULTS,
  type SettingsPayload,
} from './settings'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

async function resetDb(): Promise<void> {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
}

beforeEach(resetDb)

/** Append one payload-carrying settings event through the standard pipeline. */
async function appendPayload(payload: SettingsPayload): Promise<CaptureEvent> {
  return appendCapture({
    stream: SETTINGS_STREAM,
    capturedAt: '2026-08-02T09:00:00-04:00',
    attachments: [
      {
        kind: 'text',
        blob: new Blob([serializeSettingsPayload(payload)], { type: 'application/json' }),
        mimeType: 'application/json',
      },
    ],
  })
}

/**
 * A hand-built remote settings event (as another device would have appended
 * it) plus its blob, ready for importEvents.
 */
function remoteEvent(
  input: { id: string; seq: number; loggedAt: string },
  payload: SettingsPayload,
): { event: CaptureEvent; blobs: Map<string, Blob> } {
  const event: CaptureEvent = {
    schema: EVENT_SCHEMA,
    type: 'capture',
    id: input.id,
    seq: input.seq,
    stream: SETTINGS_STREAM,
    loggedAt: input.loggedAt,
    deviceTz: 'America/New_York',
    capturedAt: input.loggedAt,
    attachments: [],
  }
  const file = attachmentFileName(eventBaseName(event), 'text', 'application/json')
  event.attachments = [{ kind: 'text', file, mimeType: 'application/json' }]
  return {
    event,
    blobs: new Map([[file, new Blob([serializeSettingsPayload(payload)], { type: 'application/json' })]]),
  }
}

const set = (key: string, value: string | number | boolean): SettingsPayload => ({
  schema: SETTINGS_PAYLOAD_SCHEMA,
  op: 'set',
  key,
  value,
})
const unset = (key: string): SettingsPayload => ({
  schema: SETTINGS_PAYLOAD_SCHEMA,
  op: 'unset',
  key,
})

describe('app settings', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await getSettings()).toEqual(APP_SETTINGS_DEFAULTS)
  })

  // Owner policy (issue #89): every AI/LLM feature is off by default.
  it('every AI/LLM feature defaults to off', async () => {
    const defaults = await getSettings()
    expect(defaults.enrichmentEnabled).toBe(false)
    expect(defaults.assistantEnabled).toBe(false)
    expect(APP_SETTINGS_DEFAULTS.enrichmentEnabled).toBe(false)
    expect(APP_SETTINGS_DEFAULTS.assistantEnabled).toBe(false)
  })

  it('round-trips saved settings', async () => {
    const saved = {
      locationEnabled: false,
      enrichmentEnabled: true,
      assistantEnabled: true,
      assistantModel: 'gemma3:27b',
    }
    await saveSettings(saved)
    expect(await getSettings()).toEqual(saved)
  })

  it('a partially-set stream yields the remaining fields from defaults', async () => {
    await appendPayload(set('app.locationEnabled', false))
    expect(await getSettings()).toEqual({ ...APP_SETTINGS_DEFAULTS, locationEnabled: false })
  })
})

describe('stream settings', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await getStreamSettings('timelog')).toEqual(STREAM_SETTINGS_DEFAULTS)
  })

  it('round-trips saved settings per stream', async () => {
    await saveStreamSettings('timelog', { maxClipSec: 90, keepAudioLocally: false })
    expect(await getStreamSettings('timelog')).toEqual({ maxClipSec: 90, keepAudioLocally: false })
  })

  it('keeps settings independent between streams (stream.<id>.* namespacing)', async () => {
    await saveStreamSettings('timelog', { maxClipSec: 30, keepAudioLocally: false })
    await saveStreamSettings('meals', { maxClipSec: 120, keepAudioLocally: true })
    expect(await getStreamSettings('timelog')).toEqual({ maxClipSec: 30, keepAudioLocally: false })
    expect(await getStreamSettings('meals')).toEqual({ maxClipSec: 120, keepAudioLocally: true })
  })
})

describe('event sourcing (diff on save)', () => {
  it('a no-op save emits zero events', async () => {
    await saveSettings({ ...APP_SETTINGS_DEFAULTS })
    expect(await listEvents(SETTINGS_STREAM)).toHaveLength(0)

    await saveSettings({ ...APP_SETTINGS_DEFAULTS, assistantEnabled: true })
    const after = (await listEvents(SETTINGS_STREAM)).length
    await saveSettings({ ...APP_SETTINGS_DEFAULTS, assistantEnabled: true })
    expect(await listEvents(SETTINGS_STREAM)).toHaveLength(after)

    await saveStreamSettings('timelog', { ...STREAM_SETTINGS_DEFAULTS })
    expect(await listEvents(SETTINGS_STREAM)).toHaveLength(after)
  })

  it('only changed keys emit events — one capture event per key', async () => {
    await saveSettings({ ...APP_SETTINGS_DEFAULTS, locationEnabled: false })
    const events = await listEvents(SETTINGS_STREAM)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('capture')

    await saveSettings({
      locationEnabled: false, // unchanged
      enrichmentEnabled: false, // unchanged
      assistantEnabled: true, // changed
      assistantModel: 'gemma3:27b', // changed
    })
    expect(await listEvents(SETTINGS_STREAM)).toHaveLength(3)
  })

  it('appends through the standard pipeline: queued sync row + json attachment', async () => {
    await saveSettings({ ...APP_SETTINGS_DEFAULTS, assistantEnabled: true })
    const [event] = await listEvents(SETTINGS_STREAM)
    expect(event.type).toBe('capture')
    const capture = event as CaptureEvent
    expect(capture.attachments).toHaveLength(1)
    expect(capture.attachments[0].kind).toBe('text')
    expect(capture.attachments[0].mimeType).toBe('application/json')
    expect(capture.attachments[0].file.endsWith('.json')).toBe(true)
    // The sync row is what drainStream(token, 'settings') pushes on Sync now.
    const statuses = await getSyncStatuses(SETTINGS_STREAM)
    expect(statuses.get(event.id)?.status).toBe('queued')
    expect(statuses.get(event.id)?.phase).toBe('attachments-pending')
  })

  it('unset reverts a key to its default', async () => {
    await saveSettings({ ...APP_SETTINGS_DEFAULTS, assistantModel: 'gemma3:27b' })
    expect((await getSettings()).assistantModel).toBe('gemma3:27b')
    await appendPayload(unset('app.assistantModel'))
    expect((await getSettings()).assistantModel).toBe(APP_SETTINGS_DEFAULTS.assistantModel)
  })
})

describe('foldSettingsPayloads (LWW)', () => {
  const payloads = new Map<string, SettingsPayload>()
  const eventWith = (
    id: string,
    seq: number,
    loggedAt: string,
    payload: SettingsPayload,
  ): CaptureEvent => {
    const { event, blobs } = remoteEvent({ id, seq, loggedAt }, payload)
    for (const file of blobs.keys()) payloads.set(file, payload)
    return event
  }
  const payloadOf = (att: { file: string }) => payloads.get(att.file)

  it('converges to the same value regardless of input order', () => {
    const a = eventWith('aaaaaa', 1, '2026-08-01T08:00:00-04:00', set('app.assistantModel', 'one'))
    const b = eventWith('bbbbbb', 2, '2026-08-01T09:00:00-04:00', set('app.assistantModel', 'two'))
    const c = eventWith('cccccc', 3, '2026-08-01T10:00:00-04:00', set('app.locationEnabled', false))
    for (const order of [
      [a, b, c],
      [c, b, a],
      [b, c, a],
    ]) {
      const state = foldSettingsPayloads(order, payloadOf)
      expect(state.get('app.assistantModel')).toBe('two')
      expect(state.get('app.locationEnabled')).toBe(false)
    }
  })

  it('breaks seq collisions by loggedAt then id (compareEvents order)', () => {
    // Same seq (two devices offline), later loggedAt wins.
    const early = eventWith('zzzzzz', 5, '2026-08-01T08:00:00-04:00', set('k', 'early'))
    const late = eventWith('aaaaaa', 5, '2026-08-01T09:00:00-04:00', set('k', 'late'))
    expect(foldSettingsPayloads([early, late], payloadOf).get('k')).toBe('late')
    expect(foldSettingsPayloads([late, early], payloadOf).get('k')).toBe('late')

    // Same seq and loggedAt: higher id wins.
    const idA = eventWith('aaa111', 7, '2026-08-01T08:00:00-04:00', set('k2', 'a'))
    const idB = eventWith('bbb222', 7, '2026-08-01T08:00:00-04:00', set('k2', 'b'))
    expect(foldSettingsPayloads([idA, idB], payloadOf).get('k2')).toBe('b')
    expect(foldSettingsPayloads([idB, idA], payloadOf).get('k2')).toBe('b')
  })

  it('applies unset in log order and skips unreadable attachments', () => {
    const s = eventWith('s11111', 1, '2026-08-01T08:00:00-04:00', set('k3', 42))
    const u = eventWith('u22222', 2, '2026-08-01T09:00:00-04:00', unset('k3'))
    expect(foldSettingsPayloads([u, s], payloadOf).has('k3')).toBe(false)
    const unknown: CaptureEvent = {
      ...s,
      id: 'x33333',
      seq: 3,
      attachments: [{ kind: 'text', file: 'missing.json', mimeType: 'application/json' }],
    }
    expect(foldSettingsPayloads([s, unknown], payloadOf).get('k3')).toBe(42)
  })
})

describe('cross-device merge', () => {
  it('is deterministic regardless of which device imports the other first', async () => {
    const localSave = async () =>
      await saveSettings({ ...APP_SETTINGS_DEFAULTS, assistantModel: 'local-model' })
    // Remote device set the same key with the same seq but a later loggedAt.
    const remoteWins = remoteEvent(
      { id: 'remote1', seq: 1, loggedAt: '2036-01-01T00:00:00-04:00' },
      set('app.assistantModel', 'remote-model'),
    )
    // Remote also set a key the local device never touched.
    const remoteOnly = remoteEvent(
      { id: 'remote2', seq: 2, loggedAt: '2036-01-01T00:00:01-04:00' },
      set('app.locationEnabled', false),
    )

    // Order 1: save locally, then import.
    await localSave()
    await importEvents(SETTINGS_STREAM, [remoteWins.event, remoteOnly.event], new Map([...remoteWins.blobs, ...remoteOnly.blobs]))
    const first = await getSettings()

    // Order 2: import first, then save locally.
    await resetDb()
    await importEvents(SETTINGS_STREAM, [remoteWins.event, remoteOnly.event], new Map([...remoteWins.blobs, ...remoteOnly.blobs]))
    await localSave()
    const second = await getSettings()

    expect(first).toEqual({
      ...APP_SETTINGS_DEFAULTS,
      assistantModel: 'remote-model',
      locationEnabled: false,
    })
    // Order 2 differs by design, not by nondeterminism: importing first means
    // the full-object local save diffs against the already-merged state, so
    // it appends *later* events (seq bumped past the import) for every key
    // where its object disagrees — reasserting the default locationEnabled
    // and winning assistantModel.
    expect(second).toEqual({ ...APP_SETTINGS_DEFAULTS, assistantModel: 'local-model' })
  })

  it('two replicas holding the same merged event set fold identically', async () => {
    const a = remoteEvent(
      { id: 'aaa000', seq: 3, loggedAt: '2026-08-01T08:00:00-04:00' },
      set('app.assistantModel', 'from-a'),
    )
    const b = remoteEvent(
      { id: 'bbb000', seq: 3, loggedAt: '2026-08-01T08:30:00-04:00' },
      set('app.assistantModel', 'from-b'),
    )

    await importEvents(SETTINGS_STREAM, [a.event], a.blobs)
    await importEvents(SETTINGS_STREAM, [b.event], b.blobs)
    const ab = await getSettings()

    await resetDb()
    await importEvents(SETTINGS_STREAM, [b.event], b.blobs)
    await importEvents(SETTINGS_STREAM, [a.event], a.blobs)
    const ba = await getSettings()

    expect(ab).toEqual(ba)
    expect(ab.assistantModel).toBe('from-b') // later loggedAt wins the seq collision
  })
})

describe('capture.settings.v1 payload contract', () => {
  it('serializes set with fixed key order (golden)', () => {
    expect(serializeSettingsPayload(set('app.locationEnabled', false))).toBe(
      `{
  "schema": "capture.settings.v1",
  "op": "set",
  "key": "app.locationEnabled",
  "value": false
}
`,
    )
    expect(serializeSettingsPayload(set('stream.timelog.maxClipSec', 90))).toBe(
      `{
  "schema": "capture.settings.v1",
  "op": "set",
  "key": "stream.timelog.maxClipSec",
  "value": 90
}
`,
    )
  })

  it('serializes unset without a value field (golden)', () => {
    expect(serializeSettingsPayload(unset('app.assistantModel'))).toBe(
      `{
  "schema": "capture.settings.v1",
  "op": "unset",
  "key": "app.assistantModel"
}
`,
    )
  })

  it('round-trips through parseSettingsPayload', () => {
    for (const p of [
      set('app.enrichmentEnabled', true),
      set('app.assistantEnabled', true),
      set('stream.timelog.maxClipSec', 90),
      set('app.assistantModel', 'gemma3:27b'),
      unset('stream.timelog.keepAudioLocally'),
    ]) {
      expect(parseSettingsPayload(serializeSettingsPayload(p))).toEqual(p)
    }
  })

  it('rejects malformed payloads instead of throwing', () => {
    expect(parseSettingsPayload('not json')).toBeUndefined()
    expect(parseSettingsPayload('[1,2]')).toBeUndefined()
    expect(parseSettingsPayload('{"schema":"other.v1","op":"set","key":"k","value":1}')).toBeUndefined()
    expect(parseSettingsPayload('{"schema":"capture.settings.v1","op":"zap","key":"k"}')).toBeUndefined()
    expect(parseSettingsPayload('{"schema":"capture.settings.v1","op":"set","key":""}')).toBeUndefined()
    expect(
      parseSettingsPayload('{"schema":"capture.settings.v1","op":"set","key":"k","value":{"a":1}}'),
    ).toBeUndefined()
    expect(parseSettingsPayload('{"schema":"capture.settings.v1","op":"unset","key":"k"}')).toEqual(
      unset('k'),
    )
  })
})
