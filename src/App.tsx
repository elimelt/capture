import { Suspense, lazy, useEffect } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import CaptureScreen from './capture/CaptureScreen'
import DayScreen from './dayview/DayScreen'
import SettingsScreen from './settings/SettingsScreen'
import { useAppStore } from './store/appStore'
import { drainTranscriptions } from './transcribe/runner'
import { ReconnectPill } from './drive/ReconnectPill'
import { Toast, cx, tone, type_ } from './ui'

// Opt-in assistant: lazy so users who never enable it never download the
// chat bundle (AI SDK + markdown renderer).
const ChatScreen = lazy(() => import('./assistant/ChatScreen'))

const TABS = [
  { to: '/', label: 'Capture' },
  { to: '/day', label: 'Day' },
  { to: '/chat', label: 'Chat', assistant: true },
  { to: '/settings', label: 'Settings' },
]

export default function App() {
  const init = useAppStore((s) => s.init)
  const refresh = useAppStore((s) => s.refresh)
  const drainSync = useAppStore((s) => s.drainSync)
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
    // Drain the upload queue on the natural gestures a no-backend token model
    // relies on (SPEC §8.2/§8.4): return to foreground and regained network.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh()
        void drainSync()
      }
    }
    const onOnline = () => void drainSync()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [init, refresh, drainSync])

  // Background transcription: whenever entries change (capture, foreground
  // refresh), transcribe any audio still missing a transcript. Appending the
  // amend refreshes entries, which re-runs this and finds nothing pending.
  const currentStreamId = useAppStore((s) => s.currentStreamId)
  useEffect(() => {
    if (entries.length === 0) return
    drainTranscriptions(currentStreamId)
      .then((appended) => {
        if (appended > 0) void refresh()
      })
      .catch(() => {}) // per-file errors back off in the runner; a drain-level failure just waits for the next trigger
  }, [entries, currentStreamId, refresh])

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
        {/* iOS-style tab bar: translucent surface + blur (not tone.surface). */}
        <nav
          className={cx(
            'fixed inset-x-0 bottom-0 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur-xl',
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
