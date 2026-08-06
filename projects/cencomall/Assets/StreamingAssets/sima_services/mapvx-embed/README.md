# MapVX Embed Scaffold

This folder is an opt-in scaffold for testing MapVX inside an iframe.

It does not replace the current MapVX bridge. The existing `MapVxBridge` flow remains the default.

To enable the iframe scaffold locally, open `mobility/index.html` with `?mapvxEmbed=1` or set `window.MAPVX_EMBED_ENABLED = true` before DOMContentLoaded.