/**
 * Settings — Notifications section (self-contained; SPEC §4.3 spirit: honest
 * capability UX). Detects what this platform can actually do via
 * `src/notify/capability` and renders exactly one of:
 *
 * - unsupported — the browser (or a pre-16.4 iOS) has no Notification API;
 * - needs-install — iOS Safari tab: notifications and badges unlock only
 *   after "Add to Home Screen", so show that hint instead of a dead button;
 * - prompt — an "Enable notifications" button (permission requests must run
 *   in a user gesture, hard requirement on iOS);
 * - denied — points at the OS/browser setting, since the web can't re-ask;
 * - granted — states what notifications are used for, honestly: the icon
 *   badge (entries waiting to sync) and app-generated alerts. Capture has no
 *   backend, so there is no remote push — nothing arrives from a server, and
 *   the copy says so (see `src/notify/push.ts` for the server-shaped hole).
 */
import { useState } from 'react'
import { applyAppBadge, badgeCount } from '../notify/badge'
import {
  detectCapability,
  readEnvironment,
  requestNotificationPermission,
} from '../notify/capability'
import { useAppStore } from '../store/appStore'
import { summarizeSyncStatuses } from '../store/events'
import { Button, Section, cx, tone, type_ } from '../ui'

export function NotificationsSection() {
  // Snapshot on first render; re-read after the only in-app transition we
  // can cause (answering the permission prompt).
  const [env, setEnv] = useState(readEnvironment)
  const syncStatuses = useAppStore((s) => s.syncStatuses)
  const [requesting, setRequesting] = useState(false)
  const capability = detectCapability(env)

  async function enable() {
    setRequesting(true)
    try {
      await requestNotificationPermission()
      const next = readEnvironment()
      setEnv(next)
      // iOS renders the badge only after permission is granted, so push the
      // current pending-sync count to the icon the moment it can appear.
      if (detectCapability(next).state === 'granted') {
        const { pending } = summarizeSyncStatuses(syncStatuses.values())
        await applyAppBadge(badgeCount({ pendingSync: pending }))
      }
    } finally {
      setRequesting(false)
    }
  }

  return (
    <Section title="Notifications">
      <div className="flex flex-col gap-3">
        {capability.state === 'unsupported' && (
          <p className={cx(type_.sub, tone.textMuted)}>
            {env.isIos && env.isStandalone
              ? 'Notifications need iOS 16.4 or later — update iOS to enable them.'
              : 'Notifications aren’t available in this browser.'}
          </p>
        )}

        {capability.state === 'needs-install' && (
          <>
            <p className={cx(type_.sub, tone.textMuted)}>
              Notifications and the app-icon badge work once Capture is installed: in Safari, tap
              Share, then “Add to Home Screen”, and open Capture from the icon.
            </p>
            <p className={cx(type_.caption, tone.textFaint)}>
              iOS only offers these to web apps on the Home Screen.
            </p>
          </>
        )}

        {capability.state === 'prompt' && (
          <>
            <p className={cx(type_.sub, tone.textMuted)}>
              Get a badge on the app icon while entries are waiting to sync, and an alert when
              transcription finishes in the background.
            </p>
            <Button variant="primary" block disabled={requesting} onClick={() => void enable()}>
              {requesting ? 'Asking…' : 'Enable notifications'}
            </Button>
          </>
        )}

        {capability.state === 'denied' && (
          <p className={cx(type_.sub, tone.textMuted)}>
            Notifications are blocked for Capture. Allow them in the system settings
            (on iOS: Settings → Notifications → Capture), then come back.
          </p>
        )}

        {capability.state === 'granted' && (
          <>
            <p className={cx(type_.sub, tone.textMuted)}>Notifications are on.</p>
            <ul className={cx('flex list-disc flex-col gap-1 pl-5', type_.sub, tone.textMuted)}>
              {capability.canBadge && (
                <li>The app icon shows a badge while entries are waiting to sync.</li>
              )}
              <li>You’ll get an alert when transcripts or captions finish while Capture is hidden.</li>
            </ul>
            <p className={cx(type_.caption, tone.textFaint)}>
              Everything is generated on this device — Capture has no server, so nothing can send
              push notifications remotely.
            </p>
          </>
        )}
      </div>
    </Section>
  )
}
