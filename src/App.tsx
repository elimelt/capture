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
import { Toast, cx, layer, shape, tone, type_ } from './ui'
import { TABS, visibleTabs } from './navTabs'

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

export default function App() {
  const init = useAppStore((s) => s.init)
  const refresh = useAppStore((s) => s.refresh)
  const entries = useAppStore((s) => s.entries)
  const ready = useAppStore((s) => s.ready)
  const lastError = useAppStore((s) => s.lastError)
  const clearError = useAppStore((s) => s.clearError)
  const assistantEnabled = useAppStore((s) => s.appSettings.assistantEnabled)
  const enrichmentEnabled = useAppStore((s) => s.appSettings.enrichmentEnabled)
  const tabs = visibleTabs(TABS, assistantEnabled)

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
  // caption any photo still missing a caption. Fully opt-in (owner policy,
  // issue #89) — nothing leaves the device to transcribe.elimelt.com or
  // llm.elimelt.com unless enrichmentEnabled is on; this call-site check is
  // defense in depth only, since both runners independently early-return when
  // it's off. Appending the amend refreshes entries, which re-runs this and
  // finds nothing pending. If a drain completes while the app is hidden (user
  // switched away mid-run), announce it — best-effort by design; see
  // src/notify/local.ts.
  const currentStreamId = useAppStore((s) => s.currentStreamId)
  useEffect(() => {
    if (entries.length === 0 || !enrichmentEnabled) return
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
  }, [entries, currentStreamId, refresh, enrichmentEnabled])

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
            iOS status bar; pad every screen below it. Bottom padding is
            computed from the nav's own height (min-h-14 + its safe-area
            inset), not guessed — see the nav's dimensions below — plus a
            1rem gutter, so the last card always clears the bar regardless
            of how large a device's home-indicator inset is. */}
        <main className="flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)] pt-[env(safe-area-inset-top)]">
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
                    'flex min-h-14 flex-1 flex-col items-center justify-center gap-1',
                    type_.sub,
                    isActive
                      ? cx('font-semibold', tone.accent)
                      : cx('font-medium', tone.textMuted),
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {tab.label}
                    {/* Active indicator: a shape, not just color/weight, per
                        the design review ("active-tab indication is almost
                        entirely typographic"). Always rendered (transparent
                        when inactive) so switching tabs never shifts
                        layout; aria-current comes free from NavLink. */}
                    <span
                      aria-hidden="true"
                      className={cx(
                        'h-[3px] w-5',
                        shape.pill,
                        isActive ? tone.accentBg : 'bg-transparent',
                      )}
                    />
                  </>
                )}
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
