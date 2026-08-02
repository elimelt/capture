/**
 * Transient in-memory "live text" stores for the streaming enrichment
 * pipelines (SPEC §3.3). While a transcript or caption streams in from its
 * service, the runner publishes the partial text here keyed by the *source*
 * attachment filename (the audio/photo file); the entry card subscribes and
 * renders it as it grows. Nothing here is persisted — the append-only log
 * only ever stores the final text, via the runner's single `appendAmend`
 * once the stream completes. On mid-stream failure the runner clears the
 * key, so partial text can never outlive its attempt.
 *
 * Snapshots are immutable maps (replaced on every change) so React's
 * `useSyncExternalStore` can consume them directly.
 */

export interface LiveTextStore {
  /** Subscribe to changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Current immutable snapshot; stable reference between changes. */
  snapshot(): ReadonlyMap<string, string>
  /** Publish the partial (or final) text for a source file. */
  set(file: string, text: string): void
  /** Drop a file's live text (failed, dropped, or empty attempt). */
  clear(file: string): void
  /**
   * Drop every entry whose file is not in `keep`. Runners call this with the
   * currently-pending source files at the start of each drain, sweeping text
   * left behind by completed attempts (kept until then so the card never
   * flashes empty between stream end and the store refresh that reveals the
   * persisted attachment).
   */
  sweep(keep: ReadonlySet<string>): void
}

export function createLiveTextStore(): LiveTextStore {
  let map: ReadonlyMap<string, string> = new Map()
  const listeners = new Set<() => void>()

  function notify() {
    for (const l of listeners) l()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => map,
    set(file, text) {
      if (map.get(file) === text) return
      const next = new Map(map)
      next.set(file, text)
      map = next
      notify()
    },
    clear(file) {
      if (!map.has(file)) return
      const next = new Map(map)
      next.delete(file)
      map = next
      notify()
    },
    sweep(keep) {
      if (![...map.keys()].some((k) => !keep.has(k))) return
      const next = new Map([...map].filter(([k]) => keep.has(k)))
      map = next
      notify()
    },
  }
}

/** Live partial transcripts, keyed by source audio filename. */
export const liveTranscripts = createLiveTextStore()

/** Live partial photo captions, keyed by source photo filename. */
export const liveCaptions = createLiveTextStore()
