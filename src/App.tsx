import { useEffect } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import CaptureScreen from './capture/CaptureScreen'
import DayScreen from './dayview/DayScreen'
import SettingsScreen from './settings/SettingsScreen'
import { useAppStore } from './store/appStore'
import { drainTranscriptions } from './transcribe/runner'
import { Toast, cx, tone, type_ } from './ui'

const TABS = [
  { to: '/', label: 'Capture' },
  { to: '/day', label: 'Day' },
  { to: '/settings', label: 'Settings' },
]

export default function App() {
  const init = useAppStore((s) => s.init)
  const refresh = useAppStore((s) => s.refresh)
  const entries = useAppStore((s) => s.entries)
  const ready = useAppStore((s) => s.ready)
  const lastError = useAppStore((s) => s.lastError)
  const clearError = useAppStore((s) => s.clearError)

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
    // M2 seam: on return to foreground this also becomes where the upload
    // queue drains.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [init, refresh])

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
          <Routes>
            <Route path="/" element={<CaptureScreen />} />
            <Route path="/day" element={<DayScreen />} />
            <Route path="/day/:date" element={<DayScreen />} />
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
            {TABS.map((tab) => (
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
