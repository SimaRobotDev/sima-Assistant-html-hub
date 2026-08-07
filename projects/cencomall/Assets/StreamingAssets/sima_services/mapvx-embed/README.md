# MapVX Embed Scaffold

This folder holds opt-in experiments for MapVX integration. Nothing here
replaces the current MapVX bridge (`../shared/mapvx-bridge.js` on top of
`../shared/mapvx/index.js`) — `map/index.html` and `store-map/index.html`
remain the production flow until we deliberately cut over.

## `index.html` — postMessage config harness

An iframe wrapping the legacy `../map/index.html`, used to confirm a parent
page can push `MAPVX_CONFIG` into a child frame via `postMessage` without
touching the current bridge. Enable it from `mobility/index.html` with
`?mapvxEmbed=1` or `window.MAPVX_EMBED_ENABLED = true`.

## `store-map.html` — official Web Component demo

A from-scratch rebuild of the store-map flow using MapVX's now-recommended
`@mapvx/web-components` (`<map-view-with-modal>` for showing a place,
`<route-view-totems>` for a totem-to-store route), per
https://web-components.docs.mapvx.com/es and their iframe migration guide.
It does **not** use `mapvx-bridge.js` or the legacy `MapVX` SDK bundle at
all — no MapLibre-internals poking, no manual POI/label querying.

The real component bundle is vendored under `../shared/mapvx-wc/` (see that
folder's README for provenance/version) — turns out the "private" npm
package is actually publicly downloadable from the npm registry, no
credentials needed. Open this page with a real `apiKey` (via the on-page
Config panel or `?local=CC_N3_3129` once config is saved) to test against
Costanera's real MapVX data.

Known gap: the Web Component API only covers "show a place" and "show a
route" — it has no equivalent for the POI-matching / patch-export tooling
in `map/index.html` (bathroom & elevator anchor discovery). That page is
expected to keep using the legacy SDK as an internal QA tool.

Known quirk (confirmed in browser, harmless so far): loading both
`map-view-with-modal.js` and `route-view-totems.js` on the same page logs
a `NotSupportedError: ... "custom-map" has already been used with this
registry` — both bundles vendor their own copy of shared internals
(`custom-map`, floor selector, etc.) and each self-registers on load, so
the second script's define call for anything already-registered throws.
Verified with `customElements.get(...)` that both `map-view-with-modal`
and `route-view-totems` still end up defined and working despite the
error — but it's noisy and worth asking MapVX about (or switching to
lazy-loading `route-view-totems.js` only when the user taps "Ver ruta",
instead of both scripts up front).

## `mvx-tiles-sw.js`

The exact Workbox tile-caching recipe from MapVX's docs
(https://web-components.docs.mapvx.com/es/examples#cache-de-tiles-con-service-worker-workbox).
The real Web Components self-register this at the domain root
(`/mvx-tiles-sw.js`, scope `/`) once loaded — `scripts/build-deploy.mjs`
copies this file to `deploy/mvx-tiles-sw.js` so it's reachable there in the
hosted build. `register-sw.js` also registers it manually (scoped to this
folder) purely so this local scaffold can exercise the same caching logic
before the real components exist.

Note: on the Unity totems, this HTML is normally opened via `file://` (see
`isUnityWebView()` in `../map/index.html`), where Service Workers cannot
register at all. Tile caching from this file only helps contexts that load
the page over real http(s).
