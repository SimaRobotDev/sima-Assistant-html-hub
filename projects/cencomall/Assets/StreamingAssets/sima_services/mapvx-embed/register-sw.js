// Local-only harness helper: the real @mapvx/web-components bundle
// self-registers mvx-tiles-sw.js at scope "/" once it loads, so this manual
// registration only exists to let this scaffold page exercise the same
// caching logic before the real components are wired in. Scope is limited
// to this folder (no Service-Worker-Allowed header available on static
// hosting), unlike the real "/" scope the components will request.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./mvx-tiles-sw.js", { scope: "./" }).catch(function (err) {
    console.error("Error registering MapVX service worker:", err);
  });
}