/**
 * Streams (SPEC §3.1): named capture profiles. v1 ships one built-in stream,
 * `timelog`. Everything downstream (storage, queue, capture UI) is keyed by
 * stream id; adding a stream here must require no engine changes (§5.5).
 */
import type { AttachmentKind } from '../contract/types'

export interface StreamDefinition {
  id: string
  displayName: string
  primaryAttachmentKind: AttachmentKind
  captureDefaults: {
    maxClipSec: number
  }
}

export const TIMELOG_STREAM: StreamDefinition = {
  id: 'timelog',
  displayName: 'Timelog',
  primaryAttachmentKind: 'audio',
  captureDefaults: {
    maxClipSec: 60,
  },
}

export const BUILTIN_STREAMS: StreamDefinition[] = [TIMELOG_STREAM]

export function getStream(id: string): StreamDefinition {
  const s = BUILTIN_STREAMS.find((s) => s.id === id)
  if (!s) throw new Error(`Unknown stream: ${id}`)
  return s
}
