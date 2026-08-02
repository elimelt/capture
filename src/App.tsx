import { Suspense, lazy, useEffect } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import CaptureScreen from './capture/CaptureScreen'
import DayScreen from './dayview/DayScreen'
import SettingsScreen from './settings/SettingsScreen'
import { applyAppBadge, badgeCount } from './notify/badge'
import { showAppNotification } from './notify/local'
import { useAppStore } from './store/appStore'
import { summarizeSyncStatuses } from './store/events'
import { drainTranscriptions } from './transcribe/runner'
import { drainCaptions } from './vision/runner'
import { ReconnectPill } from './drive/ReconnectPill'
import { Toast, cx, layer, tone, type_ } from './ui'

// Opt-in assistant: lazy so users who never enable it never download the
// chat bundle (AI SDK + markdown renderer).
const ChatScreen = lazy(() => import('./assistant/ChatScreen'))

/** "2 transcripts ready · 1 caption ready" — only the parts that happened. */
function enrichmentNoticeBody(transcribed: number, captioned: number): string {
  const parts: string[] = []
  if (transcribed > 0)
    parts.push(transcribed === 1 ? '1 transcript ready' : `${transcribed} transcripts ready`)
  if (captioned > 0)
    parts.push(captioned === 1 ? '1 caption ready' : `${captioned} captions ready`)
  return parts.join(' · ')
}

const TABS = [
  { to: '/', label: 'Capture' },
  { to: '/day', label: 'Day' },
  { to: '/chat', label: 'Chat', assistant: true },
  { to: '/settings', label: 'Settings' },
]

export default function App() {
  const init = useAppStore((s) => s.init)
  const refresh = useAppStore((s) => s.refresh)
  const entries = useAppStore((s) => s.entries)
  const ready = useAppStore((s) => s.ready)
  const lastError = useAppStore((s) => s.lastError)
  const clearError = useAppStore((s) => s.clearError)
  const assistantEnabled = useAppStore((s) => s.appSettings.assistantEnabled)
  const tabs = TABS.filter((t) => !t.assistant || assistantEnabled)

  // The HTML boot splash (index.html) covers the app until the store is
  // hydrated, so the first paint is real content, never a flash of empty
  // state. Fade it out, then drop it from the DOM.
  useEffect(() => {
    if (!ready) return
    const splash = document.getElementById('splash')
    if (!splash) return
    splash.classList.add('done')
    const t = setTimeout(() => splash.remove(), 400)
    return () => clearTimeout(t)
  }, [ready])

  useEffect(() => {
    void init()
    // Returning to the foreground re-reads local state only; Drive sync is
    // manual-only via "Sync now" in Settings.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [init, refresh])

  // Background media understanding: whenever entries change (capture,
  // foreground refresh), transcribe any audio still missing a transcript and
  // caption any photo still missing a caption. Appending the amend refreshes
  // entries, which re-runs this and finds nothing pending. If a drain
  // completes while the app is hidden (user switched away mid-run), announce
  // it — best-effort by design; see src/notify/local.ts.
  const currentStreamId = useAppStore((s) => s.currentStreamId)
  useEffect(() => {
    if (entries.length === 0) return
    Promise.all([drainTranscriptions(currentStreamId), drainCaptions(currentStreamId)])
      .then(([transcribed, captioned]) => {
        if (transcribed + captioned > 0) {
          void refresh()
          if (document.visibilityState === 'hidden') {
            void showAppNotification({
              title: 'Capture',
              body: enrichmentNoticeBody(transcribed, captioned),
              tag: 'enrichment-done', // coalesce successive drains into one banner
            })
          }
        }
      })
      .catch(() => {}) // per-file errors back off in the runners; a drain-level failure just waits for the next trigger
  }, [entries, currentStreamId, refresh])

  // Home Screen icon badge = entries waiting to sync (pending + failed sync
  // rows). setAppBadge persists after the app is backgrounded or closed, so
  // it is the one "come back and sync" signal that outlives the app on iOS —
  // rendered there only once notification permission is granted (Settings →
  // Notifications), and a silent no-op where the Badging API is missing.
  const syncStatuses = useAppStore((s) => s.syncStatuses)
  useEffect(() => {
    const { pending } = summarizeSyncStatuses(syncStatuses.values())
    void applyAppBadge(badgeCount({ pendingSync: pending }))
  }, [syncStatuses])

  useEffect(() => {
    if (!lastError) return
    const t = setTimeout(clearError, 6000)
    return () => clearTimeout(t)
  }, [lastError, clearError])

  return (
    <div className={cx('min-h-dvh', tone.bg, tone.textPrimary)}>
      <div className="mx-auto flex min-h-dvh max-w-md flex-col">
        {/* C12: black-translucent status bar means content extends under the
            iOS status bar; pad every screen below it. */}
        <main className="flex-1 pb-24 pt-[env(safe-area-inset-top)]">
          <ReconnectPill />
          <Routes>
            <Route path="/" element={<CaptureScreen />} />
            <Route path="/day" element={<DayScreen />} />
            <Route path="/day/:date" element={<DayScreen />} />
            <Route
              path="/chat"
              element={
                assistantEnabled ? (
                  <Suspense fallback={null}>
                    <ChatScreen />
                  </Suspense>
                ) : (
                  <Navigate to="/" replace />
                )
              }
            />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        {/* iOS-style tab bar: translucent surface + blur (not tone.surface).
            Explicitly on layer.nav so overlays (layer.overlay, portaled to
            document.body) always paint — and hit-test — above it. */}
        <nav
          className={cx(
            'fixed inset-x-0 bottom-0 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-xl',
            layer.nav,
            tone.border,
            'bg-card/80 dark:bg-card-dark/80',
          )}
        >
          <div className="mx-auto flex max-w-md">
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.to === '/'}
                className={({ isActive }) =>
                  cx(
                    'flex min-h-14 flex-1 items-center justify-center',
                    type_.sub,
                    isActive
                      ? cx('font-semibold', tone.accent)
                      : cx('font-medium', tone.textMuted),
                  )
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
      {lastError && (
        <Toast actionLabel="Dismiss" onAction={clearError}>
          {lastError}
        </Toast>
      )}
    </div>
  )
}
