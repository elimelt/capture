/**
 * UI-facing zustand store for calendar overlays (SPEC §3.6), mirroring
 * `useAppStore`'s shape in miniature: cache the folded `OverlayState`s, route
 * every write through the overlay repo (`gcal/overlay/store` — the log's only
 * writer), and re-fold after each append so the Day view re-renders from
 * fresh state. Lives in dayview/ (not store/): the overlay log is
 * calendar-domain state and the generic store/ layer must never import gcal/
 * (SPEC §10 layering).
 */
import { create } from 'zustand'
import type { CalEvent } from '../gcal/events'
import type { PseudoEntry } from '../gcal/overlay/pseudoEntry'
import {
  appendOverlayAmend,
  appendOverlayCreate,
  appendOverlayRevoke,
  listOverlayStates,
} from '../gcal/overlay/store'
import type { OverlayPatch, OverlayState } from '../gcal/overlay/types'
import { useAppStore } from '../store/appStore'
import { baseSnapshotOf } from './timeline'

/** What a save appended, so callers can offer an exact undo. */
export interface SavedOverlay {
  overlayId: string
  /** True when the save materialized a new overlay (COW) rather than amending. */
  created: boolean
}

interface OverlaysState {
  /** Folded overlay states; the Day view merges these with the live fetch. */
  overlays: OverlayState[]
  /** True once the first load settled, so views load once and never loop. */
  loaded: boolean

  /** Re-fold from the log (the read path after any append). */
  refresh: () => Promise<void>

  /**
   * Apply one patch to a pseudo-entry as exactly one overlay event
   * (SPEC §3.6 copy-on-write): an amend when the entry is already
   * materialized, else an `overlay` create that freezes `baseSnapshot` from
   * the live calendar event. Callers of unmaterialized entries must pass
   * `liveEvent` — an unmaterialized pseudo-entry only exists while its event
   * is live, so a missing one is a programming error, not a user state.
   */
  saveOverlayPatch: (
    entry: PseudoEntry,
    liveEvent: CalEvent | undefined,
    patch: OverlayPatch,
  ) => Promise<SavedOverlay>

  /** Amend an overlay by id (e.g. un-hide from the toast, when the entry is no longer rendered). */
  amendOverlay: (overlayId: string, patch: OverlayPatch) => Promise<void>

  /** Discard an overlay entirely (orphan "Remove", hide-undo of a fresh COW). */
  revokeOverlay: (overlayId: string) => Promise<void>
}

export const useOverlays = create<OverlaysState>()((set, get) => {
  // Same failure channel as useAppStore's guard: surface the message through
  // the app-level toast and re-throw for callers that await.
  const guard = async <R>(label: string, fn: () => Promise<R>): Promise<R> => {
    try {
      return await fn()
    } catch (err) {
      useAppStore.setState({
        lastError: `${label}: ${err instanceof Error ? err.message : String(err)}`,
      })
      throw err
    }
  }

  return {
    overlays: [],
    loaded: false,

    refresh: async () => {
      set({ overlays: await listOverlayStates(), loaded: true })
    },

    saveOverlayPatch: async (entry, liveEvent, patch) =>
      guard('Could not update event', async () => {
        if (entry.materialized && entry.overlayId !== undefined) {
          await appendOverlayAmend({ targets: [entry.overlayId], patch })
          await get().refresh()
          return { overlayId: entry.overlayId, created: false }
        }
        if (liveEvent === undefined) {
          throw new Error('cannot materialize an overlay without the live calendar event')
        }
        const created = await appendOverlayCreate({
          target: entry.target,
          baseSnapshot: baseSnapshotOf(liveEvent),
          patch,
        })
        await get().refresh()
        return { overlayId: created.id, created: true }
      }),

    amendOverlay: async (overlayId, patch) =>
      guard('Could not update event', async () => {
        await appendOverlayAmend({ targets: [overlayId], patch })
        await get().refresh()
      }),

    revokeOverlay: async (overlayId) =>
      guard('Could not remove event', async () => {
        await appendOverlayRevoke({ targets: [overlayId] })
        await get().refresh()
      }),
  }
})
