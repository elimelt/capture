/**
 * Canonical wire format for event records (SPEC §5.2): the exact bytes
 * uploaded to Drive. Fixed key order — envelope (schema, type, id, seq,
 * stream, loggedAt, deviceTz) then type-specific fields — 2-space indent,
 * trailing newline, optional fields omitted entirely (never null).
 */
import type { AmendPatch, Attachment, GeoLocation, LogEvent } from './types'
import { EVENT_SCHEMA } from './types'

type Json = Record<string, unknown>

function orderedLocation(l: GeoLocation): Json {
  const out: Json = { lat: l.lat, lng: l.lng, accuracyM: l.accuracyM }
  if (l.placeLabel !== undefined) out.placeLabel = l.placeLabel
  return out
}

function orderedAttachment(a: Attachment): Json {
  const out: Json = { kind: a.kind, file: a.file, mimeType: a.mimeType }
  if (a.durationSec !== undefined) out.durationSec = a.durationSec
  return out
}

function orderedPatch(p: AmendPatch): Json {
  const out: Json = {}
  if (p.capturedAt !== undefined) out.capturedAt = p.capturedAt
  if (p.location !== undefined) out.location = orderedLocation(p.location)
  return out
}

function orderedEvent(e: LogEvent): Json {
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
    case 'capture':
      out.capturedAt = e.capturedAt
      if (e.location !== undefined) out.location = orderedLocation(e.location)
      out.attachments = e.attachments.map(orderedAttachment)
      break
    case 'amend':
      out.targets = e.targets
      if (e.patch !== undefined) out.patch = orderedPatch(e.patch)
      if (e.attachments !== undefined) out.attachments = e.attachments.map(orderedAttachment)
      break
    case 'revoke':
      out.targets = e.targets
      break
  }
  return out
}

export function serializeEvent(event: LogEvent): string {
  return `${JSON.stringify(orderedEvent(event), null, 2)}\n`
}

function fail(msg: string): never {
  throw new Error(`invalid event record: ${msg}`)
}

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parses and structurally validates an event record; throws on bad input. */
export function parseEvent(json: string): LogEvent {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    fail('not valid JSON')
  }
  if (!isRecord(raw)) fail('not a JSON object')
  if (raw.schema !== EVENT_SCHEMA) fail(`schema must be "${EVENT_SCHEMA}"`)
  const type = raw.type
  if (type !== 'capture' && type !== 'amend' && type !== 'revoke') {
    fail(`unknown type ${JSON.stringify(type)}`)
  }
  for (const key of ['id', 'stream', 'loggedAt', 'deviceTz'] as const) {
    if (typeof raw[key] !== 'string') fail(`missing or invalid ${key}`)
  }
  if (typeof raw.seq !== 'number') fail('missing or invalid seq')
  switch (type) {
    case 'capture':
      if (typeof raw.capturedAt !== 'string') fail('missing or invalid capturedAt')
      if (!Array.isArray(raw.attachments)) fail('missing or invalid attachments')
      break
    case 'amend':
    case 'revoke':
      if (!Array.isArray(raw.targets)) fail('missing or invalid targets')
      break
  }
  return raw as unknown as LogEvent
}
