/**
 * Pure view-model for the merged Day timeline (SPEC §4.2, §3.6): interleave
 * the day's real entries with calendar pseudo-entries into one time-sorted
 * list, and group consecutive real entries into runs so the view can hand
 * each run to the existing `EntryList` (which owns the card→amend wiring).
 * No I/O and no React here — tested directly (timeline.test.ts).
 */
import type { Entry } from '../contract/types'
import type { CalEvent } from '../gcal/events'
import type { PseudoEntry } from '../gcal/overlay/pseudoEntry'
import type { OverlayBaseSnapshot } from '../gcal/overlay/types'

export type TimelineItem =
  | { kind: 'entry'; startMs: number; entry: Entry }
  | { kind: 'pseudo'; startMs: number; pseudo: PseudoEntry }

function idOf(item: TimelineItem): string {
  return item.kind === 'entry' ? item.entry.id : item.pseudo.id
}

/**
 * Interleave real entries (effective start = `capturedAt`) with pseudo-entries
 * (effective start = merged `startMs` — a patched time re-files the block) into
 * one ascending timeline. Ties break pseudo-first (a calendar block frames the
 * entries captured at its start), then by id for determinism. Inputs are the
 * day's already-filtered lists; this only orders them.
 */
export function buildTimeline(
  entries: readonly Entry[],
  pseudoEntries: readonly PseudoEntry[],
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...entries.map((entry) => ({
      kind: 'entry' as const,
      startMs: new Date(entry.capturedAt).getTime(),
      entry,
    })),
    ...pseudoEntries.map((pseudo) => ({ kind: 'pseudo' as const, startMs: pseudo.startMs, pseudo })),
  ]
  items.sort(
    (a, b) =>
      a.startMs - b.startMs ||
      (a.kind === b.kind ? 0 : a.kind === 'pseudo' ? -1 : 1) ||
      (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0),
  )
  return items
}

export type TimelineGroup =
  | { kind: 'entries'; entries: Entry[] }
  | { kind: 'pseudo'; pseudo: PseudoEntry }

/**
 * Collapse a timeline into render groups: runs of consecutive real entries
 * (one `EntryList` per run, so its per-card amend wiring is reused unchanged)
 * separated by individual pseudo-entries.
 */
export function groupTimeline(items: readonly TimelineItem[]): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  for (const item of items) {
    if (item.kind === 'pseudo') {
      groups.push({ kind: 'pseudo', pseudo: item.pseudo })
      continue
    }
    const last = groups[groups.length - 1]
    if (last !== undefined && last.kind === 'entries') last.entries.push(item.entry)
    else groups.push({ kind: 'entries', entries: [item.entry] })
  }
  return groups
}

/**
 * The frozen copy-on-write base for materializing an overlay from the live
 * calendar event (SPEC §3.6): the exact fields dirty-detection later diffs.
 * `updated` is omitted (not `undefined`-valued) when the fetch lacks it, so
 * the snapshot serializes without noise.
 */
export function baseSnapshotOf(ev: CalEvent): OverlayBaseSnapshot {
  return {
    summary: ev.summary,
    startMs: ev.startMs,
    endMs: ev.endMs,
    allDay: ev.allDay,
    ...(ev.updated !== undefined ? { updated: ev.updated } : {}),
  }
}
