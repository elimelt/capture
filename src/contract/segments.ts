/**
 * Batched log segments (SPEC §5.7): the NDJSON body of a `*.ndjson` log
 * file — one §5.2 event record per line, compacted, every line (including
 * the last) newline-terminated, lines in log order. Segments batch event
 * *records* only; attachments stay individual files. Parsing is
 * all-or-nothing (SPEC §5.8 #6): one malformed line fails the whole
 * segment so an import can never silently keep half a batch.
 */
import type { LogEvent } from './types'
import { compareEvents } from './fold'
import { parseEvent, serializeEventLine } from './serialize'

/** The canonical bytes of a segment holding `events` (sorted into log order). */
export function serializeSegment(events: readonly LogEvent[]): string {
  if (events.length === 0) throw new Error('invalid segment: no events')
  return [...events]
    .sort(compareEvents)
    .map(serializeEventLine)
    .join('')
}

/**
 * Parse a segment body back into its events. Tolerates a missing final
 * newline; throws (with the 1-based line number) on any malformed line —
 * the caller must then import none of the segment.
 */
export function parseSegment(ndjson: string): LogEvent[] {
  const lines = ndjson.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new Error('invalid segment: empty')
  return lines.map((line, i) => {
    try {
      return parseEvent(line)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`invalid segment line ${i + 1}: ${detail}`)
    }
  })
}
