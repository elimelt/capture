/**
 * The fold (SPEC §3.3): visible entries = capture events with later amend
 * patches applied and revoked captures dropped. Computed identically by the
 * app and by skill consumers.
 */
import type { Entry, LogEvent } from './types'

export interface FoldOptions {
  /** Include revoked entries (flagged) instead of dropping them. */
  includeRevoked?: boolean
}

export function fold(events: readonly LogEvent[], opts: FoldOptions = {}): Entry[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
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
          if (e.attachments) entry.attachments.push(...e.attachments)
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
  // Effective-time order (capturedAt after amendments), seq as tiebreak.
  result.sort((a, b) =>
    a.capturedAt === b.capturedAt ? a.seq - b.seq : a.capturedAt < b.capturedAt ? -1 : 1,
  )
  return result
}
