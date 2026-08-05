importScripts("https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-sw.js");

if (self.workbox) {
  workbox.routing.registerRoute(
    function (context) {
      return context.url.pathname.includes("/tiles/");
    },
    new workbox.strategies.CacheFirst({
      cacheName: "mapvx-tiles-cache",
      plugins: [
        new workbox.expiration.ExpirationPlugin({
          maxEntries: 500,
          maxAgeSeconds: 30 * 24 * 60 * 60
        })
      ]
    })
  );
}