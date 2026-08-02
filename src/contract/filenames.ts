/**
 * Log filename scheme (SPEC §5.1, §5.7):
 *   000041_2026-08-02T09-04-11-0400_a1b2c3.json          event record
 *   000041_2026-08-02T09-04-11-0400_a1b2c3.m4a           primary attachment
 *   000041_2026-08-02T09-04-11-0400_a1b2c3_note.txt      secondary attachments
 *   000044-000046_2026-08-02T18-02-33-0400_f1a2b3.ndjson batched log segment
 * Name-sorted listing == log order; seq is answerable from the listing alone.
 * A segment leads with its seq range and sorts at its min-seq position:
 * ASCII '-' (0x2D) precedes both digits and '_' (0x5F).
 */
import type { AttachmentKind, LogEvent } from './types'
import { localDateOf } from './time'

export function padSeq(seq: number): string {
  return String(seq).padStart(6, '0')
}

/** "2026-08-02T09:04:11-04:00" → "2026-08-02T09-04-11-0400" (filename-safe). */
export function tsForFilename(iso: string): string {
  return iso.replaceAll(':', '-').replace(/([+-])(\d{2})-(\d{2})$/, (_, s, h, m) => {
    return `${s === '+' ? '+' : '-'}${h}${m}`
  })
}

export function eventBaseName(e: Pick<LogEvent, 'seq' | 'loggedAt' | 'id'>): string {
  return `${padSeq(e.seq)}_${tsForFilename(e.loggedAt)}_${e.id}`
}

export function eventRecordName(e: Pick<LogEvent, 'seq' | 'loggedAt' | 'id'>): string {
  return `${eventBaseName(e)}.json`
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/mpeg': 'mp3',
  'text/plain': 'txt',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'application/json': 'json',
}

const SUFFIX_BY_KIND: Record<AttachmentKind, string> = {
  audio: '',
  text: '_note',
  photo: '_photo',
}

export function attachmentFileName(
  base: string,
  kind: AttachmentKind,
  mimeType: string,
  /** Disambiguates multiple attachments of the same kind on one event (0-based). */
  index = 0,
): string {
  const ext = EXT_BY_MIME[mimeType.split(';')[0]] ?? 'bin'
  const dedupe = index > 0 ? `${index + 1}` : ''
  return `${base}${SUFFIX_BY_KIND[kind]}${dedupe}.${ext}`
}

/** Date partition folder for an event: local date of loggedAt (SPEC §5.1). */
export function partitionOf(e: Pick<LogEvent, 'loggedAt'>): string {
  return localDateOf(e.loggedAt)
}

/** Parse the seq back out of any log filename ("000041_..." → 41). */
export function seqOfFilename(name: string): number {
  // Split rather than slice: seq grows past 6 digits without padding changes.
  return parseInt(name.split('_')[0], 10)
}

/**
 * Parse the event id out of a record filename
 * ("000041_2026-08-02T09-04-11-0400_a1b2c3.json" → "a1b2c3"), or null when
 * the name isn't a record of ours (foreign file, attachment, folder).
 */
export function idOfRecordName(name: string): string | null {
  const m = /^\d+_[^_]+_([0-9a-z]+)\.json$/.exec(name)
  return m ? m[1] : null
}

/**
 * Name a batched log segment (SPEC §5.7): the seq range of the contained
 * events, then the loggedAt timestamp and id of the segment's *first* event
 * (log order), whose crypto-random id gives the name cross-device entropy.
 * `events` must be non-empty and already in log order (seq → loggedAt → id).
 */
export function segmentFileName(
  events: readonly Pick<LogEvent, 'seq' | 'loggedAt' | 'id'>[],
): string {
  const first = events[0]
  let minSeq = first.seq
  let maxSeq = first.seq
  for (const e of events) {
    if (e.seq < minSeq) minSeq = e.seq
    if (e.seq > maxSeq) maxSeq = e.seq
  }
  return `${padSeq(minSeq)}-${padSeq(maxSeq)}_${tsForFilename(first.loggedAt)}_${first.id}.ndjson`
}

/** The parts a segment filename carries (all hints; the payload is authoritative). */
export interface SegmentName {
  minSeq: number
  maxSeq: number
  /** Id of the segment's first event — its discovery id (SPEC §5.8). */
  firstId: string
}

/**
 * Parse a segment filename back into its parts, or null when the name isn't
 * a segment of ours (record, attachment, foreign file, folder).
 */
export function parseSegmentName(name: string): SegmentName | null {
  const m = /^(\d+)-(\d+)_[^_]+_([0-9a-z]+)\.ndjson$/.exec(name)
  if (!m) return null
  return { minSeq: parseInt(m[1], 10), maxSeq: parseInt(m[2], 10), firstId: m[3] }
}
