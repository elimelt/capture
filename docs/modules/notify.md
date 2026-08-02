# Notifications: `src/notify`

Generic, stream-agnostic notification support, built around what a home-screen
iOS Safari web app (the primary target) can actually do without a backend.
Capture has no server — the user's Drive is the only remote — so **remote Web
Push cannot be sent today**; this module implements the feasible maximum and
leaves a clearly-marked, server-shaped hole for the rest.

## Platform reality (the constraints this module encodes)

| Mechanism | iOS gate | Works without a server? |
| --- | --- | --- |
| App-icon badge (`navigator.setAppBadge`) | 16.4+, Home Screen web apps only; renders once notification permission is granted | **Yes** — set while the app runs, persists after it's backgrounded/killed |
| App-initiated `registration.showNotification()` | 16.4+, Home Screen only, permission granted | **Partly** — only while the app's JS is running; iOS suspends backgrounded web apps within seconds and no scheduling API exists (Notification Triggers died in origin trial, nothing replaced it) |
| Web Push / Declarative Web Push | 16.4+ / 18.4+, Home Screen only, permission must be requested from a user gesture | **No** — a push server must hold the subscription and send VAPID-signed messages |

In a plain iOS Safari tab none of these APIs are exposed; installing to the
Home Screen is what unlocks them. Capability detection turns that into an
honest "add to Home Screen" hint rather than a dead button.

## Files

- `capability.ts` — `readEnvironment()` snapshots the globals defensively
  (Notification presence/permission, service worker, `PushManager`,
  `setAppBadge`, iOS detection incl. the iPadOS-as-macOS masquerade,
  standalone display-mode); `detectCapability(env)` is the pure rule set
  mapping a snapshot to `unsupported | needs-install | prompt | denied |
  granted` plus `canBadge` / `canNotify` / `canSubscribePush` flags.
  `requestNotificationPermission()` wraps the prompt (must be called from a
  user gesture — iOS hard-requires it).
- `badge.ts` — `badgeCount(sources)` purely sums named counts (a future badge
  source is a one-liner at the call site); `applyAppBadge(count)` sets/clears
  the icon badge and never throws. The badge is the one signal that outlives
  the app process, so it carries "entries waiting to sync".
- `local.ts` — `showAppNotification({ title, body?, tag? })`: best-effort
  app-initiated notification via the service-worker registration (the only
  path iOS supports; `new Notification()` doesn't exist there). Returns
  `false` instead of throwing when permission, the SW registration, or the
  API is missing. Uses `getRegistration()` rather than `.ready` so it settles
  even when no SW is registered (dev server).
- `push.ts` — Web Push subscription plumbing, **intentionally not wired to
  any UI**: `vapidKeyToApplicationServerKey` (pure base64url decode),
  `getPushSubscription`, `subscribeToPush(vapidPublicKey)`. The module doc
  comment spells out the three-step integration once a push server exists;
  nothing else in the app needs to change.

## Consumers

- `src/App.tsx` keeps the icon badge equal to the pending-sync count
  (`summarizeSyncStatuses` → `badgeCount` → `applyAppBadge`) and posts an
  app-initiated notification when a transcription/caption drain completes
  while the app is hidden.
- `src/settings/NotificationsSection.tsx` renders the capability state and
  owns the user-gesture permission request.

`notify/` is a generic layer (registered in `src/layering.test.ts`): it
imports nothing from other `src/` modules and must not import the app-level
directories.

## Testing

Pure logic (`detectCapability`, `badgeCount`, `vapidKeyToApplicationServerKey`)
is tested directly; the effectful wrappers are tested with `vi.stubGlobal`
fakes for `navigator`, `Notification`, and `matchMedia` (matching the style of
`src/store/space.test.ts`). No browser APIs are assumed present — every test
also covers the bare-environment path.
