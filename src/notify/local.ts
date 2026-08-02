/**
 * App-initiated ("local") notifications via the service-worker registration.
 *
 * `registration.showNotification()` is the only way to show a notification
 * on iOS (the `new Notification()` constructor is not supported there), and
 * it can be called outside a push event — but only while the app's JS is
 * actually running. iOS suspends backgrounded web apps within seconds and no
 * scheduling API exists, so this is inherently best-effort: it covers events
 * that complete while the app is open or in its brief background grace
 * window (e.g. a transcription drain finishing right after the user switches
 * apps). Anything that must fire while the app is closed needs Web Push and
 * therefore a server (see `push.ts`).
 *
 * Fails soft by design: returns false instead of throwing, so callers can
 * fire-and-forget from any completion path.
 */

export interface AppNotice {
  title: string
  body?: string
  /** Coalescing key: a new notice with the same tag replaces the old one. */
  tag?: string
}

/**
 * Show a notification now, if the environment allows it (permission granted
 * and an active service-worker registration). Returns whether it was shown.
 */
export async function showAppNotification(notice: AppNotice): Promise<boolean> {
  if (
    typeof globalThis.Notification === 'undefined' ||
    globalThis.Notification.permission !== 'granted'
  ) {
    return false
  }
  const container = globalThis.navigator?.serviceWorker
  if (!container) return false
  try {
    // getRegistration (not .ready): .ready never settles when no SW is
    // registered (e.g. dev server), which would leak a pending promise.
    const registration = await container.getRegistration()
    if (!registration) return false
    await registration.showNotification(notice.title, {
      ...(notice.body !== undefined ? { body: notice.body } : {}),
      ...(notice.tag !== undefined ? { tag: notice.tag } : {}),
    })
    return true
  } catch {
    return false
  }
}
