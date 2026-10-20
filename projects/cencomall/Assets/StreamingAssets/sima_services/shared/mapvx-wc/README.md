# @mapvx/web-components — self-hosted bundle

`mapvx-embed/store-map.html` loads the official MapVX Web Components as
two self-hosted IIFE builds:

```
shared/mapvx-wc/map-view-with-modal.js
shared/mapvx-wc/route-view-totems.js
```

Despite their docs saying the package is private (CDN/unpkg links there
404 without auth), `@mapvx/web-components` is actually published with
`publishConfig.access: "public"` on the public npm registry — no token
needed. These two files were pulled straight from the published tarball:

```bash
curl -sSL https://registry.npmjs.org/@mapvx/web-components/-/web-components-0.13.0.tgz -o web-components.tgz
tar -xzf web-components.tgz
cp package/dist/iife/map-view-with-modal.js shared/mapvx-wc/
cp package/dist/iife/route-view-totems.js shared/mapvx-wc/
cp package/dist/sw/mvx-tiles-sw.js mapvx-embed/mvx-tiles-sw.js
```

We used the IIFE build (not ESM) because it's what MapVX's own "self-hosted
script" instructions recommend, and because each file is a single
self-contained bundle (no relative-path chunk imports to keep in sync,
unlike `dist/es/index.js` which pulls in a dozen `./assets/*.js` chunks).
Source maps (`*.js.map`, ~14MB each) were intentionally left out — not
needed to run, only for debugging the vendor bundle itself.

## Updating the version

To bump to a newer release, repeat the `curl`/`tar`/`cp` steps above with
the new version number (check `npm view @mapvx/web-components dist-tags`),
then update the pin below. Also re-diff `mvx-tiles-sw.js` against the
version already in the repo — MapVX has shipped meaningfully different SW
logic between releases (ours went from a static Workbox recipe to one with
progressive tile prefetching), so don't assume it's a no-op.

- Version: **0.13.0** (was 0.3.0 until 2026-10-20; `git log` on this folder has the old bundles)
- Pulled on: 2026-10-20
- Also vendored from the same tarball: `../mapvx-embed/mvx-tiles-sw.js`

## What 0.13.0 changed for us

New in `<route-view-totems>` (docs: https://docs.mapvx.app/web-components/es/components):
`origin-floor-id` / `origin-level`, `destination-floor-id` / `destination-level`
(a place on several floors, e.g. an elevator), `accessible-route`,
`auto-generate-route`, `hide-*` flags, `panel-variant`. `updateComponent()` takes
`originFloorId`, `destinationFloorId`, `accessibleRoute`. A floor the place is not
on is ignored **silently** (the route starts on the place's first floor).

Defaults that changed and that we pin explicitly (every creation site —
`mapvx-wc-runtime.js`, `store-map-web/index.html`, `mapvx-embed/store-map.html`):

- `enable-3d` is **ON by default for `<route-view-totems>`** and our parent place
  (`-N19VjzEVIj2RDKu7i4r`) is first in the bundle's 3D allow-list. We set
  `enable-3d="false"`: 3D adds deck.gl + GLB escalator models + runtime fetches to
  `unpkg.com` and an S3 bucket, which a totem without internet would not get.
  (`<map-view-with-modal>` stays off by default.)
- `marker-variant` now defaults to `compact` (icon-only bubble). We set `full`, the
  0.3.0 popup, because `POPUP_CSS` / `applyGenericLabel` target its DOM.

`generateRoute`'s `detail.accessible` is analytics only; the route type comes from
the `accessible-route` property.

## Accessible route = our own button

The component's walking/accessible switch lives in `<route-options>`, which does
**not** register in our pages: they load `map-view-with-modal.js` first, then
`route-view-totems.js`, whose `define("custom-map")` throws (already defined) and
aborts before `route-options`, `qr-modal` and `floor-selector` (same on 0.3.0 and
0.13.0; loading route-first would register them and drop the whole vendor panel
over our UI). So `shared/mapvx-accessible-route.js` draws a "Ruta accesible"
button (top-right, es/en/pt) in `store-map-web` and, through
`mapvx-wc-runtime.js`, in `mobility`. Accessible routes are on request only: every
route starts walking; a tap calls `updateComponent({ accessibleRoute })`; it
listens for `startRouteAnimation` / `mvxLoadingChange` (done) and `mvxError`
(`ROUTE_NOT_FOUND` → notice, back to walking). `MAPVX_CONFIG.accessibleRouteButton
= false` hides it without an OTA. Guarded by `tools/verify-services-integrity.mjs`.

`mvx-tiles-sw.js` is additive (glyph + vendor caches, 3D bucket allow-listed); the
files are stored with CRLF in the working tree, git normalises to LF.
