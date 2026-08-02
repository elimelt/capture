/**
 * Streams (SPEC §3.1): named capture profiles. v1 ships one built-in stream,
 * `timelog`. Everything downstream (storage, queue, capture UI) is keyed by
 * stream id; adding a stream here must require no engine changes (§5.5).
 *
 * Besides capture streams, the app owns *system streams* — event logs with no
 * capture UI, no skill, and no `StreamDefinition` (they'd be a lie: no
 * `primaryAttachmentKind`, no capture defaults). They exist so app-level state
 * (settings, assistant chats) syncs through the same append-only log + Drive
 * engine as everything else. The sync engine iterates `allSyncStreams()`;
 * everything else keeps keying off `BUILTIN_STREAMS`/`getStream`.
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

/**
 * System streams (SPEC §3.1): stream ids the sync engine drains/pulls that are
 * never the active capture stream. Their event-sourcing lands separately
 * (settings, assistant chats); listing them here only makes the sync loop
 * cover them — an empty, never-bootstrapped stream costs one pull listing.
 */
export const SYSTEM_STREAMS: readonly string[] = ['settings', 'assistant-chats']

/** Every stream one sync cycle covers: system streams, then capture streams. */
export function allSyncStreams(): string[] {
  return [...SYSTEM_STREAMS, ...BUILTIN_STREAMS.map((s) => s.id)]
}

export function getStream(id: string): StreamDefinition {
  const s = BUILTIN_STREAMS.find((s) => s.id === id)
  if (!s) throw new Error(`Unknown stream: ${id}`)
  return s
}
