/**
 * The fold (SPEC §3.3): visible entries = capture events with later amend
 * patches applied and revoked captures dropped. Computed identically by the
 * app and by skill consumers.
 *
 * Identity is the event `id`; `seq` is a non-unique ordering *hint* (two
 * devices appending offline can mint the same per-stream seq). So both the
 * event-application order and the final entry order break ties by `loggedAt`
 * then `id`, making the fold deterministic across devices regardless of seq
 * collisions.
 */
import type { Entry, LogEvent } from './types'

export interface FoldOptions {
  /** Include revoked entries (flagged) instead of dropping them. */
  includeRevoked?: boolean
}

/** Total order over events: seq first (the hint), then loggedAt, then id. */
export function compareEvents(a: LogEvent, b: LogEvent): number {
  if (a.seq !== b.seq) return a.seq - b.seq
  if (a.loggedAt !== b.loggedAt) return a.loggedAt < b.loggedAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function fold(events: readonly LogEvent[], opts: FoldOptions = {}): Entry[] {
  const ordered = [...events].sort(compareEvents)
  const entries = new Map<string, Entry>()

  for (const e of ordered) {
    switch (e.type) {
      case 'capture': {
        entries.set(e.id, {
          id: e.id,
          seq: e.seq,
          stream: e.stream,
          loggedAt: e.loggedAt,
          capturedAt: e.capturedAt,
          deviceTz: e.deviceTz,
          location: e.location,
          attachments: [...e.attachments],
          attachmentLoggedAt: Object.fromEntries(e.attachments.map((a) => [a.file, e.loggedAt])),
          lastEventSeq: e.seq,
          revoked: false,
        })
        break
      }
      case 'amend': {
        for (const target of e.targets) {
          const entry = entries.get(target)
          if (!entry || entry.revoked) continue
          if (e.patch?.capturedAt !== undefined) entry.capturedAt = e.patch.capturedAt
          if (e.patch?.location !== undefined) entry.location = e.patch.location
          else if (e.patch?.clearLocation) entry.location = undefined
          // Removals before additions: an edit is one amend that removes the
          // old file and adds its replacement.
          if (e.patch?.removeAttachments !== undefined) {
            const gone = new Set(e.patch.removeAttachments)
            entry.attachments = entry.attachments.filter((a) => !gone.has(a.file))
          }
          if (e.attachments) {
            entry.attachments.push(...e.attachments)
            const attachmentLoggedAt = (entry.attachmentLoggedAt ??= {})
            for (const attachment of e.attachments) {
              attachmentLoggedAt[attachment.file] = e.loggedAt
            }
          }
          entry.lastEventSeq = e.seq
        }
        break
      }
      case 'revoke': {
        for (const target of e.targets) {
          const entry = entries.get(target)
          if (!entry) continue
          entry.revoked = true
          entry.lastEventSeq = e.seq
        }
        break
      }
    }
  }

  const result = [...entries.values()].filter((en) => opts.includeRevoked || !en.revoked)
  // Effective-time order (capturedAt after amendments); seq then id as
  // tiebreak so a seq collision across devices still orders deterministically.
  result.sort((a, b) => {
    if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? -1 : 1
    if (a.seq !== b.seq) return a.seq - b.seq
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return result
}
