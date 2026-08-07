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
curl -sSL https://registry.npmjs.org/@mapvx/web-components/-/web-components-0.3.0.tgz -o web-components.tgz
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

- Version: **0.3.0**
- Pulled on: 2026-08-06
- Also vendored from the same tarball: `../mapvx-embed/mvx-tiles-sw.js`
