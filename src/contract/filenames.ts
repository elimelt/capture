/**
 * Log filename scheme (SPEC §5.1):
 *   000041_2026-08-02T09-04-11-0400_a1b2c3.json      event record
 *   000041_2026-08-02T09-04-11-0400_a1b2c3.m4a       primary attachment
 *   000041_2026-08-02T09-04-11-0400_a1b2c3_note.txt  secondary attachments
 * Name-sorted listing == log order; seq is answerable from the listing alone.
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
