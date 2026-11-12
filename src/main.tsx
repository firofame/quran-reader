import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import { App } from './App.tsx'

registerSW({ immediate: true })

// The retired hand-written service worker named its caches after this prefix.
// The generated service worker replaces its registration; sweep the old
// caches so the retired entries stop taking up space.
if ('caches' in window) {
  caches
    .keys()
    .then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('quran-reader-static-'))
          .map(key => caches.delete(key)),
      ),
    )
    .catch(() => {
      // Cache cleanup is best-effort; the app does not depend on it.
    })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
