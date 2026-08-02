/**
 * Web Push subscription plumbing — present but intentionally NOT wired to
 * any UI or runtime path.
 *
 * Real push (a notification arriving while the app is closed) requires a
 * push server: something must hold each device's `PushSubscription` and POST
 * VAPID-signed messages to its endpoint. Capture has no backend — the user's
 * Drive is the only remote — so there is nothing to send with today, and
 * minting subscriptions without a sender would be dead weight (iOS even
 * expires subscriptions whose pushes don't show notifications).
 *
 * When a push server exists, the integration is:
 *   1. call `subscribeToPush(VAPID_PUBLIC_KEY)` from a user-gesture path
 *      after permission is granted (Settings → Notifications),
 *   2. deliver `subscription.toJSON()` to the server,
 *   3. the server sends Web Push (or iOS 18.4+ Declarative Web Push)
 *      messages; the service worker's `push` handler must always show a
 *      notification or iOS cancels the subscription.
 * Nothing else in the app needs to change.
 */

/**
 * Decode a base64url-encoded VAPID public key into the `applicationServerKey`
 * bytes `pushManager.subscribe` expects. Pure; throws on malformed input.
 */
export function vapidKeyToApplicationServerKey(base64Url: string): Uint8Array {
  const padded = base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  const raw = globalThis.atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** The device's current push subscription, if one was ever minted. */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  const registration = await globalThis.navigator?.serviceWorker?.getRegistration()
  if (!registration?.pushManager) return null
  try {
    return await registration.pushManager.getSubscription()
  } catch {
    return null
  }
}

/**
 * Mint a push subscription for this device. Requires notification permission
 * and an active service-worker registration; returns null when either is
 * missing. NOTE: useless without a server to receive it — see module doc.
 */
export async function subscribeToPush(
  vapidPublicKey: string,
): Promise<PushSubscription | null> {
  const registration = await globalThis.navigator?.serviceWorker?.getRegistration()
  if (!registration?.pushManager) return null
  return registration.pushManager.subscribe({
    // iOS (and Chrome) require user-visible pushes; silent push is not a thing.
    userVisibleOnly: true,
    applicationServerKey: vapidKeyToApplicationServerKey(vapidPublicKey)
      .buffer as ArrayBuffer,
  })
}
