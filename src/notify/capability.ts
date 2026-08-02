/**
 * Notification capability detection: a pure core (`detectCapability`) over a
 * snapshot of the environment (`readEnvironment`), so the honest-UX rules are
 * unit-testable without a browser.
 *
 * What a home-screen iOS Safari web app can actually do (state of the world
 * as of iOS 26 / 2026):
 *
 * - **Web Push** (iOS 16.4+): available only to web apps added to the Home
 *   Screen, and permission must be requested from a user gesture. *Sending*
 *   a push requires a push server holding the subscription — Capture has no
 *   backend (Drive is the only remote), so push stays plumbing-only
 *   (`push.ts`) until a server exists. Declarative Web Push (iOS 18.4+) has
 *   the same server requirement.
 * - **Local notifications**: `registration.showNotification()` can be called
 *   outside a push event, but only while the app is actually running — iOS
 *   suspends a backgrounded web app's JS within seconds, and no scheduling
 *   mechanism exists (the Notification Triggers proposal died in origin
 *   trial and nothing replaced it). So `local.ts` is best-effort by design.
 * - **Badging** (iOS 16.4+): `navigator.setAppBadge()` puts a count on the
 *   Home Screen icon. It persists while the app is closed, making it the
 *   one reliable "something is pending" signal — but iOS renders it only
 *   after notification permission is granted.
 *
 * In a plain iOS Safari tab none of these APIs are exposed at all, which is
 * how `detectCapability` distinguishes "install to Home Screen first"
 * (`needs-install`) from genuinely unsupported browsers.
 */

/** Everything capability detection needs, read once from globals. */
export interface NotifyEnvironment {
  /** `Notification` constructor exists (iOS: only in installed web apps). */
  hasNotification: boolean
  /** Current permission; undefined when the API is missing. */
  permission?: NotificationPermission
  hasServiceWorker: boolean
  /** `PushManager` exists — push *subscription* is possible (sending isn't, without a server). */
  hasPushManager: boolean
  /** `navigator.setAppBadge` exists. */
  hasSetAppBadge: boolean
  /** iPhone/iPad (including iPadOS masquerading as macOS). */
  isIos: boolean
  /** Running as an installed app (display-mode: standalone / navigator.standalone). */
  isStandalone: boolean
}

export type NotifyState = 'unsupported' | 'needs-install' | 'prompt' | 'denied' | 'granted'

export interface NotifyCapability {
  state: NotifyState
  /** Badging API present; on iOS the badge renders only once permission is granted. */
  canBadge: boolean
  /** App-initiated `showNotification` can work right now (granted + SW available). */
  canNotify: boolean
  /** A push *subscription* could be minted right now — useless until a server exists. */
  canSubscribePush: boolean
}

/** Pure capability rules over an environment snapshot. */
export function detectCapability(env: NotifyEnvironment): NotifyCapability {
  let state: NotifyState
  if (!env.hasNotification) {
    // iOS exposes Notification only to Home Screen web apps, so a missing
    // API in an iOS browser tab means "install first", not "unsupported" —
    // unless we're *already* installed, which means the iOS version predates
    // 16.4 and no install hint can help.
    state = env.isIos && !env.isStandalone ? 'needs-install' : 'unsupported'
  } else if (env.permission === 'granted') {
    state = 'granted'
  } else if (env.permission === 'denied') {
    state = 'denied'
  } else {
    state = 'prompt'
  }
  const granted = state === 'granted'
  return {
    state,
    canBadge: env.hasSetAppBadge,
    canNotify: granted && env.hasServiceWorker,
    canSubscribePush: granted && env.hasServiceWorker && env.hasPushManager,
  }
}

/** Snapshot the real globals; every probe is defensive so this never throws. */
export function readEnvironment(): NotifyEnvironment {
  const nav = globalThis.navigator as
    | (Navigator & { standalone?: boolean })
    | undefined
  const hasNotification = typeof globalThis.Notification !== 'undefined'
  return {
    hasNotification,
    ...(hasNotification ? { permission: globalThis.Notification.permission } : {}),
    hasServiceWorker: nav !== undefined && 'serviceWorker' in nav,
    hasPushManager: typeof globalThis.PushManager !== 'undefined',
    hasSetAppBadge: typeof nav?.setAppBadge === 'function',
    isIos: detectIos(nav),
    isStandalone: detectStandalone(nav),
  }
}

/**
 * Ask for notification permission. Must be called from a user gesture (iOS
 * hard-requires it; a non-gesture call resolves 'denied' without a prompt).
 * Returns the resulting permission, or undefined when the API is missing.
 */
export async function requestNotificationPermission(): Promise<
  NotificationPermission | undefined
> {
  if (typeof globalThis.Notification === 'undefined') return undefined
  try {
    return await globalThis.Notification.requestPermission()
  } catch {
    return undefined
  }
}

function detectIos(nav: { userAgent?: string; maxTouchPoints?: number } | undefined): boolean {
  if (!nav) return false
  const ua = nav.userAgent ?? ''
  if (/iPhone|iPad|iPod/.test(ua)) return true
  // iPadOS 13+ reports itself as macOS; a "Mac" with multitouch is an iPad.
  return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1
}

function detectStandalone(nav: { standalone?: boolean } | undefined): boolean {
  if (nav?.standalone === true) return true // iOS Safari's nonstandard flag
  try {
    return globalThis.matchMedia?.('(display-mode: standalone)').matches ?? false
  } catch {
    return false
  }
}
