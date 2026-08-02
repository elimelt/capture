/**
 * The overlay fold (SPEC §3.6): effective overlay state = overlay (create)
 * events with later amend patches merged and revoked overlays dropped.
 * Pure and deterministic regardless of arrival order, exactly like
 * contract/fold.ts — but local to gcal/overlay: the tiny comparator is
 * duplicated here rather than importing/widening the contract-critical
 * contract/fold.ts.
 */
import type { CalendarEventRef, OverlayLogEvent, OverlayPatch, OverlayState } from './types'

export interface OverlayFoldOptions {
  /** Include revoked overlays (flagged) instead of dropping them. */
  includeRevoked?: boolean
}

/** Total order over overlay events: seq (the hint), then loggedAt, then id. */
export function compareOverlayEvents(a: OverlayLogEvent, b: OverlayLogEvent): number {
  if (a.seq !== b.seq) return a.seq - b.seq
  if (a.loggedAt !== b.loggedAt) return a.loggedAt < b.loggedAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Merge one wire patch into the accumulated effective patch, field by field —
 * a later "add note" never clobbers an earlier "override title". Per field:
 * a value always wins over its `clearX` sibling within the same amend; a
 * `clearX` alone removes the accumulated override (so the live base shows
 * through again). The accumulated patch therefore never carries clearX flags.
 */
function mergePatch(into: OverlayPatch, p: OverlayPatch): void {
  if (p.title !== undefined) into.title = p.title
  else if (p.clearTitle) delete into.title
  if (p.note !== undefined) into.note = p.note
  else if (p.clearNote) delete into.note
  if (p.startAt !== undefined || p.endAt !== undefined) {
    if (p.startAt !== undefined) into.startAt = p.startAt
    if (p.endAt !== undefined) into.endAt = p.endAt
  } else if (p.clearTime) {
    delete into.startAt
    delete into.endAt
  }
  if (p.hidden !== undefined) into.hidden = p.hidden
}

/**
 * Fold overlay events into effective per-overlay state. Amends and revokes on
 * a revoked overlay are no-ops; unknown targets are ignored (they may fold in
 * later — arrival order is not guaranteed across devices).
 */
export function foldOverlay(
  events: readonly OverlayLogEvent[],
  opts: OverlayFoldOptions = {},
): OverlayState[] {
  const ordered = [...events].sort(compareOverlayEvents)
  const states = new Map<string, OverlayState>()

  for (const e of ordered) {
    switch (e.type) {
      case 'overlay': {
        const patch: OverlayPatch = {}
        mergePatch(patch, e.patch) // normalize: clearX never enters folded state
        states.set(e.id, {
          id: e.id,
          target: { ...e.target },
          baseSnapshot: { ...e.baseSnapshot },
          patch,
          lastEventSeq: e.seq,
          revoked: false,
        })
        break
      }
      case 'amend': {
        for (const target of e.targets) {
          const state = states.get(target)
          if (!state || state.revoked) continue
          if (e.patch !== undefined) mergePatch(state.patch, e.patch)
          state.lastEventSeq = e.seq
        }
        break
      }
      case 'revoke': {
        for (const target of e.targets) {
          const state = states.get(target)
          if (!state || state.revoked) continue
          state.revoked = true
          state.lastEventSeq = e.seq
        }
        break
      }
    }
  }

  return [...states.values()].filter((s) => opts.includeRevoked || !s.revoked)
}

/** Map key for "which calendar event does this overlay annotate". */
export function overlayKey(ref: CalendarEventRef): string {
  return `${ref.calendarId}::${ref.eventId}`
}

/**
 * Index folded overlays by their target calendar event. When two overlays
 * (e.g. minted concurrently on two devices) annotate the same event, the
 * later one in fold order wins — deterministic, same tiebreak as the fold.
 */
export function indexOverlaysByTarget(states: readonly OverlayState[]): Map<string, OverlayState> {
  const index = new Map<string, OverlayState>()
  for (const s of states) index.set(overlayKey(s.target), s)
  return index
}
