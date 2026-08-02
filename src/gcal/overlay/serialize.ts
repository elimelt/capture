/**
 * Canonical wire format for calendar-overlay event records (SPEC §5.6), same
 * conventions as contract/serialize.ts: fixed key order — envelope (schema,
 * type, id, seq, stream, loggedAt, deviceTz) then type-specific fields —
 * 2-space indent, trailing newline, optional fields omitted entirely (never
 * null). The log is local-only today (Drive sync is deferred to the
 * multi-stream engine), but the bytes are fixed now so nothing changes when
 * the log starts syncing.
 */
import type {
  CalendarEventRef,
  OverlayBaseSnapshot,
  OverlayLogEvent,
  OverlayPatch,
} from './types'
import { OVERLAY_SCHEMA } from './types'

type Json = Record<string, unknown>

function orderedTarget(t: CalendarEventRef): Json {
  const out: Json = { calendarId: t.calendarId, eventId: t.eventId }
  if (t.recurringEventId !== undefined) out.recurringEventId = t.recurringEventId
  return out
}

function orderedSnapshot(s: OverlayBaseSnapshot): Json {
  const out: Json = { summary: s.summary, startMs: s.startMs, endMs: s.endMs, allDay: s.allDay }
  if (s.updated !== undefined) out.updated = s.updated
  return out
}

function orderedPatch(p: OverlayPatch): Json {
  const out: Json = {}
  // Per field, a value wins over its clearX sibling (cf. clearLocation in
  // contract/serialize.ts): the clear is omitted from the wire when the value
  // is present, so the two never coexist in a record.
  if (p.title !== undefined) out.title = p.title
  else if (p.clearTitle) out.clearTitle = true
  if (p.note !== undefined) out.note = p.note
  else if (p.clearNote) out.clearNote = true
  if (p.startAt !== undefined) out.startAt = p.startAt
  if (p.endAt !== undefined) out.endAt = p.endAt
  if (p.startAt === undefined && p.endAt === undefined && p.clearTime) out.clearTime = true
  if (p.hidden !== undefined) out.hidden = p.hidden
  return out
}

function orderedEvent(e: OverlayLogEvent): Json {
  const out: Json = {
    schema: e.schema,
    type: e.type,
    id: e.id,
    seq: e.seq,
    stream: e.stream,
    loggedAt: e.loggedAt,
    deviceTz: e.deviceTz,
  }
  switch (e.type) {
    case 'overlay':
      out.target = orderedTarget(e.target)
      out.baseSnapshot = orderedSnapshot(e.baseSnapshot)
      out.patch = orderedPatch(e.patch)
      break
    case 'amend':
      out.targets = e.targets
      if (e.patch !== undefined) out.patch = orderedPatch(e.patch)
      break
    case 'revoke':
      out.targets = e.targets
      break
  }
  return out
}

export function serializeOverlayEvent(event: OverlayLogEvent): string {
  return `${JSON.stringify(orderedEvent(event), null, 2)}\n`
}

function fail(msg: string): never {
  throw new Error(`invalid overlay event record: ${msg}`)
}

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parses and structurally validates an overlay record; throws on bad input. */
export function parseOverlayEvent(json: string): OverlayLogEvent {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    fail('not valid JSON')
  }
  if (!isRecord(raw)) fail('not a JSON object')
  if (raw.schema !== OVERLAY_SCHEMA) fail(`schema must be "${OVERLAY_SCHEMA}"`)
  const type = raw.type
  if (type !== 'overlay' && type !== 'amend' && type !== 'revoke') {
    fail(`unknown type ${JSON.stringify(type)}`)
  }
  for (const key of ['id', 'stream', 'loggedAt', 'deviceTz'] as const) {
    if (typeof raw[key] !== 'string') fail(`missing or invalid ${key}`)
  }
  if (typeof raw.seq !== 'number') fail('missing or invalid seq')
  switch (type) {
    case 'overlay': {
      const target = raw.target
      if (!isRecord(target)) fail('missing or invalid target')
      if (typeof target.calendarId !== 'string') fail('missing or invalid target.calendarId')
      if (typeof target.eventId !== 'string') fail('missing or invalid target.eventId')
      const snap = raw.baseSnapshot
      if (!isRecord(snap)) fail('missing or invalid baseSnapshot')
      if (typeof snap.summary !== 'string') fail('missing or invalid baseSnapshot.summary')
      if (typeof snap.startMs !== 'number') fail('missing or invalid baseSnapshot.startMs')
      if (typeof snap.endMs !== 'number') fail('missing or invalid baseSnapshot.endMs')
      if (typeof snap.allDay !== 'boolean') fail('missing or invalid baseSnapshot.allDay')
      if (!isRecord(raw.patch)) fail('missing or invalid patch')
      break
    }
    case 'amend':
    case 'revoke':
      if (!Array.isArray(raw.targets)) fail('missing or invalid targets')
      break
  }
  return raw as unknown as OverlayLogEvent
}
