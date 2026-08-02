/**
 * The merged Day timeline (SPEC §4.2, §3.6): one time-sorted interleave of
 * real entry cards and calendar pseudo-entries, replacing the old stacked
 * calendar-block + entry-list layout. Real entries keep the exact capture
 * cards — runs of consecutive entries render through the existing
 * `EntryList`, which owns the card→amend wiring — and calendar events render
 * as `PseudoEntryCard`s from `buildPseudoEntries` over the live fetch plus
 * the folded overlays.
 *
 * Two invariants live here:
 * - `buildPseudoEntries` runs ONLY on a 'ready' fetch — orphan detection
 *   against a loading/error/disconnected state would misclassify every
 *   overlay as orphaned (the core docstring's contract).
 * - Unedited calendar events carry ZERO stored state: an overlay is written
 *   only when an edit sheet Save has a non-undefined patch or the user hides
 *   (copy-on-write via `saveOverlayPatch`).
 */
import { useEffect, useMemo, useState } from 'react'
import type { Entry } from '../contract/types'
import type { CalEvent } from '../gcal/events'
import { buildPseudoEntries } from '../gcal/overlay/buildPseudoEntries'
import type { PseudoEntry } from '../gcal/overlay/pseudoEntry'
import { toggleHidden } from '../gcal/overlay/overlayPlan'
import { EntryList } from '../capture/EntryList'
import { EmptyState, Toast, cx, tone, type_ } from '../ui'
import { EditPseudoEntrySheet } from './EditPseudoEntrySheet'
import { PseudoEntryCard } from './PseudoEntryCard'
import { buildTimeline, groupTimeline } from './timeline'
import { useDayEvents, type DayEventsState } from './useDayEvents'
import { useOverlays, type SavedOverlay } from './useOverlays'

/** Quiet, non-blocking copy for non-ready calendar states (never an error the user must act on). */
const NON_READY_NOTE: Record<Exclude<DayEventsState['kind'], 'ready' | 'loading'>, string> = {
  'not-connected': 'Connect Google in Settings to see calendar events.',
  'no-calendar': 'Pick a calendar in Settings to see events here.',
  'auth-error': 'Reconnect Google in Settings to see calendar events.',
  error: 'Couldn’t load calendar events.',
}

interface DayTimelineProps {
  /** The day being rendered ("YYYY-MM-DD") — also the orphan-matching date. */
  date: string
  /** The day's real entries, already filtered (not revoked / pending delete). */
  entries: Entry[]
  /** Delete requests bubble up for the screen's undoable-delete flow. */
  onDeleteEntry: (entryId: string) => void
  /** Copy one real entry as labeled plain text. */
  onCopyEntry: (entry: Entry) => void
  /** EmptyState title when the merged timeline has nothing at all. */
  emptyTitle: string
}

export function DayTimeline({ date, entries, onDeleteEntry, onCopyEntry, emptyTitle }: DayTimelineProps) {
  const events = useDayEvents(date)

  const overlays = useOverlays((s) => s.overlays)
  const overlaysLoaded = useOverlays((s) => s.loaded)
  const refreshOverlays = useOverlays((s) => s.refresh)
  const saveOverlayPatch = useOverlays((s) => s.saveOverlayPatch)
  const amendOverlay = useOverlays((s) => s.amendOverlay)
  const revokeOverlay = useOverlays((s) => s.revokeOverlay)

  useEffect(() => {
    if (!overlaysLoaded) void refreshOverlays().catch(() => {})
  }, [overlaysLoaded, refreshOverlays])

  // Pseudo-entries only from real data; anything else renders entries alone.
  const pseudo = useMemo(
    () =>
      events.kind === 'ready'
        ? buildPseudoEntries(events.calendarId, events.events, overlays, date)
        : [],
    [events, overlays, date],
  )

  const liveById = useMemo(() => {
    const map = new Map<string, CalEvent>()
    if (events.kind === 'ready') for (const ev of events.events) map.set(ev.id, ev)
    return map
  }, [events])

  const groups = useMemo(() => groupTimeline(buildTimeline(entries, pseudo)), [entries, pseudo])

  // The sheet tracks the pseudo-entry by id and re-derives it each render, so
  // it always shows current merge output; a save closes it before the id can
  // change (COW materialization renames `cal:…` ids to the overlay id).
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = editingId !== null ? pseudo.find((p) => p.id === editingId) : undefined

  // Undoable hide: the overlay patch is committed immediately (unlike entry
  // delete, hide is losslessly reversible), and Undo appends the exact
  // inverse — revoke when the hide itself materialized the overlay (back to
  // zero effective state), else `hidden: false`.
  const [hideToast, setHideToast] = useState<SavedOverlay | null>(null)
  useEffect(() => {
    if (hideToast === null) return
    const t = setTimeout(() => setHideToast(null), 5000)
    return () => clearTimeout(t)
  }, [hideToast])

  const liveOf = (entry: PseudoEntry) => liveById.get(entry.target.eventId)

  function handleHide(entry: PseudoEntry) {
    void saveOverlayPatch(entry, liveOf(entry), toggleHidden(entry))
      .then(setHideToast)
      .catch(() => {}) // surfaced via the app-level error toast
  }

  function undoHide() {
    const toast = hideToast
    setHideToast(null)
    if (toast === null) return
    if (toast.created) void revokeOverlay(toast.overlayId).catch(() => {})
    else void amendOverlay(toast.overlayId, { hidden: false }).catch(() => {})
  }

  const note =
    events.kind !== 'ready' && events.kind !== 'loading'
      ? NON_READY_NOTE[events.kind]
      : events.kind === 'ready' && events.events.length === 0 && overlaysLoaded && pseudo.length === 0
        ? `No events on ${events.calendarName} this day.`
        : null

  return (
    <>
      {note !== null && <p className={cx('px-1', type_.sub, tone.textFaint)}>{note}</p>}

      {groups.length === 0 ? (
        <EmptyState title={emptyTitle} />
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((group) =>
            group.kind === 'pseudo' ? (
              <PseudoEntryCard
                key={group.pseudo.id}
                entry={group.pseudo}
                onEdit={() => setEditingId(group.pseudo.id)}
                onHide={() => handleHide(group.pseudo)}
                onRemove={() => {
                  if (group.pseudo.overlayId !== undefined) {
                    void revokeOverlay(group.pseudo.overlayId).catch(() => {})
                  }
                }}
              />
            ) : (
              <EntryList
                key={group.entries[0].id}
                entries={group.entries}
                onDelete={onDeleteEntry}
                onCopy={onCopyEntry}
              />
            ),
          )}
        </div>
      )}

      {editing !== undefined && (
        <EditPseudoEntrySheet
          entry={editing}
          onSave={(patch) => void saveOverlayPatch(editing, liveOf(editing), patch).catch(() => {})}
          onClose={() => setEditingId(null)}
        />
      )}

      {hideToast !== null && (
        <Toast actionLabel="Undo" onAction={undoHide}>
          Event hidden
        </Toast>
      )}
    </>
  )
}
