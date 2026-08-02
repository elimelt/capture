/**
 * App-icon badging — the one notification surface that reliably works on an
 * installed iOS Safari web app without a push server: `setAppBadge(n)` set
 * while the app runs persists on the Home Screen icon after the app is
 * backgrounded or killed, so "n entries waiting to sync" stays visible until
 * the user comes back. iOS renders the badge only once notification
 * permission has been granted (Settings → Notifications section); calling it
 * before that is legal and simply invisible.
 *
 * `badgeCount` is the pure aggregation over named sources so a future signal
 * is a one-liner at the call site (`badgeCount({ pendingSync, newThing })`);
 * `applyAppBadge` is the fire-and-forget effect and never throws — badging
 * is cosmetic and must not break anything.
 */

/** Sum named non-negative counts; NaN/negative/fractional inputs are sanitized. */
export function badgeCount(sources: Record<string, number>): number {
  let total = 0
  for (const n of Object.values(sources)) {
    if (Number.isFinite(n) && n > 0) total += Math.floor(n)
  }
  return total
}

/** Set (count > 0) or clear (count <= 0) the app badge. Never throws. */
export async function applyAppBadge(count: number): Promise<void> {
  const nav = globalThis.navigator as
    | (Navigator & {
        setAppBadge?: (count: number) => Promise<void>
        clearAppBadge?: () => Promise<void>
      })
    | undefined
  try {
    if (count > 0) await nav?.setAppBadge?.(count)
    else await nav?.clearAppBadge?.()
  } catch {
    // Badging is a courtesy signal; a refusal (or quota oddity) is not an error.
  }
}
