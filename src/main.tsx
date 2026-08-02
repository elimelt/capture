import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { ErrorBoundary } from './ui'
import './index.css'

registerSW()
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
