/**
 * In-session service-worker update signal (issue #61). `vite.config.ts` sets
 * `registerType: 'prompt'`: a new SW installs and waits rather than silently
 * `skipWaiting`-ing and reloading every open window mid-capture. `main.tsx`
 * (outside the React tree, so it can't use the app's Zustand store or hooks)
 * wires this store's `publish` to `registerSW`'s `onNeedRefresh` callback;
 * `App.tsx` subscribes via `useSyncExternalStore` to show a "Reload" toast
 * the user acts on when it's convenient — a background tab claiming control
 * and forcing a reload mid-recording is exactly what `prompt` mode avoids.
 */

export interface SwUpdateStore {
  /** Subscribe to changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** True once a new SW is installed and waiting to activate. */
  snapshot(): boolean
  /** Record that an update is available and how to apply it. Idempotent. */
  publish(apply: () => void): void
  /** Apply the pending update, if any (no-op if none is pending). */
  apply(): void
}

export function createSwUpdateStore(): SwUpdateStore {
  let available = false
  let applyFn: (() => void) | null = null
  const listeners = new Set<() => void>()

  function notify() {
    for (const l of listeners) l()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => available,
    publish(apply) {
      applyFn = apply
      if (available) return
      available = true
      notify()
    },
    apply() {
      applyFn?.()
    },
  }
}

/** The app's single update-available signal; see the module doc above. */
export const swUpdate = createSwUpdateStore()
