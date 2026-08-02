import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import CaptureScreen from './capture/CaptureScreen'
import DayScreen from './dayview/DayScreen'
import SettingsScreen from './settings/SettingsScreen'
import { cx, tone, type_ } from './ui'

const TABS = [
  { to: '/', label: 'Capture' },
  { to: '/day', label: 'Day' },
  { to: '/settings', label: 'Settings' },
]

export default function App() {
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
        <nav
          className={cx(
            'fixed inset-x-0 bottom-0 border-t pb-[env(safe-area-inset-bottom)]',
            tone.border,
            tone.surface,
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
                    'flex min-h-14 flex-1 items-center justify-center font-medium',
                    type_.sub,
                    isActive ? tone.accent : tone.textMuted,
                  )
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
    </div>
  )
}
