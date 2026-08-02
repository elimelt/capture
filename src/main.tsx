import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { swUpdate } from './swUpdate'
import { ErrorBoundary } from './ui'
import './index.css'

// Issue #61: `registerType: 'prompt'` (vite.config.ts) means a new SW
// installs and waits instead of force-reloading every open window the
// instant it activates. `onNeedRefresh` fires once a waiting SW exists;
// publish it to `swUpdate` so `App.tsx` can offer a "Reload" toast on the
// user's own schedule. An installed PWA can stay warm for days with no
// navigation to trigger a registration re-check, so also poll
// `registration.update()` hourly and on every return to the foreground.
const applyUpdate = registerSW({
  onNeedRefresh() {
    swUpdate.publish(() => applyUpdate(true))
  },
  onRegisteredSW(_url, registration) {
    if (!registration) return
    const checkForUpdate = () => void registration.update()
    setInterval(checkForUpdate, 60 * 60 * 1000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate()
    })
  },
})
// SPEC §2.3 item 4: Safari can evict script-writable storage after ~7 days of
// disuse, and Drive backup doesn't exist until M2 — ask for persistence.
void navigator.storage?.persist?.()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
