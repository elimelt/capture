import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import CaptureScreen from './capture/CaptureScreen'
import DayScreen from './dayview/DayScreen'
import SettingsScreen from './settings/SettingsScreen'

const TABS = [
  { to: '/', label: 'Capture' },
  { to: '/day', label: 'Day' },
  { to: '/settings', label: 'Settings' },
]

export default function App() {
  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex min-h-dvh max-w-md flex-col">
        <main className="flex-1 pb-20">
          <Routes>
            <Route path="/" element={<CaptureScreen />} />
            <Route path="/day" element={<DayScreen />} />
            <Route path="/day/:date" element={<DayScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <nav className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-slate-800 dark:bg-slate-900">
          <div className="mx-auto flex max-w-md">
            {TABS.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.to === '/'}
                className={({ isActive }) =>
                  `flex min-h-14 flex-1 items-center justify-center text-sm font-medium ${
                    isActive
                      ? 'text-sky-600 dark:text-sky-400'
                      : 'text-slate-500 dark:text-slate-400'
                  }`
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
