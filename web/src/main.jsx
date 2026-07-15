import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Auto-apply new deploys WITHOUT the user needing to reopen the app (iOS home-screen PWAs cache
// hard and otherwise stay stuck on the old version). Polls for a new service worker every 60s;
// when one genuinely activates over an existing controller (a real update — NOT first install),
// reload once so the fresh code shows immediately. Guarded so it never loops.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then((reg) => {
    setInterval(() => { reg.update().catch(() => {}); }, 60 * 1000);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'activated' && navigator.serviceWorker.controller) {
          window.location.reload();
        }
      });
    });
  }).catch(() => {});
}
