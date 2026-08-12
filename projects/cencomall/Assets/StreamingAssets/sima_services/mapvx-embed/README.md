# MapVX Embed Scaffold

This folder holds MapVX experiments and docs. Production store maps now prefer
the official Web Components via `../shared/mapvx-wc-runtime.js`:

- `../store-map/index.html` — WC first, automatic fallback to
  `../shared/mapvx-bridge.js` if WC fails (`?mapEngine=auto|wc|legacy`)
- `../mobility/index.html` — store maps use the same WC runtime + fallback;
  **service** maps (bathrooms, elevators, …) stay on the legacy bridge

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
Shared camera/POI helpers live in `../shared/mapvx-wc-runtime.js` (also used
by production `store-map` / mobility).

The real component bundle is vendored under `../shared/mapvx-wc/` (see that
folder's README for provenance/version). Open `../store-map-web/index.html`
with a real `apiKey` (Config panel or injected `MAPVX_CONFIG`) to QA against
Costanera's real MapVX data.

Known gap: the Web Component API only covers "show a place" and "show a
route" — it has no equivalent for the POI-matching / patch-export tooling
in `map/index.html` (bathroom & elevator anchor discovery). Service maps
therefore keep using the legacy SDK.

Known quirk (confirmed in browser, harmless so far): loading both
`map-view-with-modal.js` and `route-view-totems.js` on the same page logs
a `NotSupportedError` for duplicate `custom-map` registration. Production
pages still **preload** `route-view-totems.js` (Unity WebViews often block
dynamically injected scripts, which broke "Ver ruta"). The duplicate
registration warning is noisy but safe — `customElements.get("custom-map")`
already exists from the first bundle.

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
