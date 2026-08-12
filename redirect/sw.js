// Kill-switch service worker: unregisters the old cached PWA so stale home-screen
// icons stop serving the old app and follow the redirect to the new address.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    self.registration.unregister()
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((cs) => cs.forEach((c) => c.navigate(c.url)))
  );
});
