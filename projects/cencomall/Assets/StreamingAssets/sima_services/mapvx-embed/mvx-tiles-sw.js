/*
  MapVX Tiles Service Worker (Workbox)
  - Progressive bounded tile prefetch (INITIAL_TILE_LOAD / REFRESH_TILES)
  - Cache-first for PBF tiles; stale-while-revalidate / network-first for MapVX APIs
  - Restricted to lazarillo.app and mapvx.com (any subdomain)

  How to use:
  1) Copy this file to your site root as "/mvx-tiles-sw.js"
  2) Ensure the site is served over HTTPS with Cache-Control: no-cache on this file
  3) Web Components register it and postMessage INITIAL_TILE_LOAD when ready
*/

/* global workbox, importScripts */
importScripts('https://storage.googleapis.com/workbox-cdn/releases/7.4.0/workbox-sw.js');

const CACHE_TILES = 'tiles-pbf';
const CACHE_API_PLACES = 'api-places-cache';
const CACHE_API_CONFIG = 'api-config-cache';
const CACHE_API_ROUTES = 'api-routes-cache';
const CACHE_API_FALLBACK = 'api-cache';
const CACHE_MAP_ASSETS = 'map-assets';

const KNOWN_RUNTIME_CACHES = new Set([
  CACHE_TILES,
  CACHE_API_PLACES,
  CACHE_API_CONFIG,
  CACHE_API_ROUTES,
  CACHE_API_FALLBACK,
  CACHE_MAP_ASSETS,
]);

const DEFAULT_VECTOR_TILES_BASE_URL = 'https://tiles.mapvx.com/tiles';

/** Abort any in-flight prefetch when a new INITIAL_TILE_LOAD / REFRESH_TILES runs. */
let activeTilePrefetch = null;

const TILE_PREFETCH = {
  maxConcurrent: 4,
  batchGapMs: 100,
  zoomLevelGapMs: 5000,
  initialRadiusTiles: 2,
  progressiveRadiusTiles: 1,
  maxTilesPerRun: 220,
};

function delay(ms) {
  return new Promise(resolve => {
    self.setTimeout(resolve, ms);
  });
}

function normalizeVectorTilesBaseUrl(url) {
  if (url == null || typeof url !== 'string' || url.trim() === '') {
    return DEFAULT_VECTOR_TILES_BASE_URL;
  }
  const trimmed = url.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
    return trimmed;
  } catch {
    console.warn('[MVX-SW] Invalid vectorTilesBaseUrl, using default:', url, DEFAULT_VECTOR_TILES_BASE_URL);
    return DEFAULT_VECTOR_TILES_BASE_URL;
  }
}

function buildVectorTileUrl(vectorTilesBase, z, x, y, apiKey) {
  const base = vectorTilesBase.replace(/\/+$/, '');
  const params = new URLSearchParams({ key: apiKey });
  return `${base}/${z}/${x}/${y}.pbf?${params.toString()}`;
}

function webMercatorXfromLng(lng) {
  return (180 + lng) / 360;
}

function webMercatorYfromLat(lat) {
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
}

function xTileFromMercator(x, zoom) {
  const n = Math.pow(2, zoom);
  return Math.floor(x * n);
}

function yTileFromMercator(y, zoom) {
  const n = Math.pow(2, zoom);
  return Math.floor(y * n);
}

async function getConfiguration(apiKey, placeId) {
  const url = `https://public-api.mapvx.com/api/configuration?token=${apiKey}&place_id=${placeId}`;
  try {
    const response = await fetch(url);
    if (response.ok) {
      return response.json();
    }
    console.error('[MVX-SW] Failed to get configuration', url, response.statusText);
  } catch (err) {
    console.error('[MVX-SW] getConfiguration network error', url, err);
  }
  return null;
}

function centroidFromPositions(configuration, positions) {
  if (configuration.initialCenter) {
    return configuration.initialCenter;
  }
  let lng = 0;
  let lat = 0;
  for (const p of positions) {
    lng += p.lng;
    lat += p.lat;
  }
  return { lng: lng / positions.length, lat: lat / positions.length };
}

function tilesAroundCenter(center, zoom, radius) {
  const mx = webMercatorXfromLng(center.lng);
  const my = webMercatorYfromLat(center.lat);
  const cx = xTileFromMercator(mx, zoom);
  const cy = yTileFromMercator(my, zoom);
  const out = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      out.push({ z: zoom, x: cx + dx, y: cy + dy });
    }
  }
  return out;
}

async function fetchAndCacheTile(cache, url, signal) {
  if (signal.aborted) {
    return;
  }
  try {
    const response = await fetch(url, { signal });
    if (response.status === 304) {
      return;
    }
    if (response.ok) {
      await cache.put(url, response.clone());
    } else {
      console.warn('[MVX-SW] Tile prefetch non-OK', response.status, url.slice(0, 140));
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return;
    }
    console.warn('[MVX-SW] Tile prefetch fetch error', url.slice(0, 100), err);
  }
}

async function prefetchUrlsInBatches(cache, urls, signal) {
  const { maxConcurrent, batchGapMs } = TILE_PREFETCH;
  for (let i = 0; i < urls.length; i += maxConcurrent) {
    if (signal.aborted) {
      return;
    }
    const slice = urls.slice(i, i + maxConcurrent);
    await Promise.all(slice.map(url => fetchAndCacheTile(cache, url, signal)));
    if (i + maxConcurrent < urls.length && batchGapMs > 0) {
      await delay(batchGapMs);
    }
  }
}

async function progressivePrefetchTiles(apiKey, placeId, tilesBaseUrl) {
  const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (trimmedKey === '') {
    console.warn('[MVX-SW] Tile prefetch skipped: empty apiKey');
    return;
  }

  if (activeTilePrefetch) {
    activeTilePrefetch.abort();
  }
  activeTilePrefetch = new AbortController();
  const signal = activeTilePrefetch.signal;

  const vectorTilesBase = normalizeVectorTilesBaseUrl(tilesBaseUrl);

  console.log('[MVX-SW] Progressive tile prefetch starting', {
    placeId,
    tilesBase: vectorTilesBase,
  });

  try {
    const configuration = await getConfiguration(trimmedKey, placeId);
    if (!configuration || signal.aborted) {
      return;
    }

    const positions = [];
    if (configuration.pointsOfInterest) {
      positions.push(...configuration.pointsOfInterest);
    }
    if (configuration.initialCenter) {
      positions.push(configuration.initialCenter);
    }
    if (positions.length === 0) {
      console.error('[MVX-SW] Tile prefetch: no positions in configuration');
      return;
    }

    const center = centroidFromPositions(configuration, positions);
    const initialZoom = Math.round(configuration.initialZoom ?? 18);
    const minZoom = Math.floor(configuration.limitZoomOut ?? initialZoom - 2);
    const maxZoom = Math.ceil(configuration.limitZoomIn ?? initialZoom + 2);

    const cache = await caches.open(CACHE_TILES);
    let budget = TILE_PREFETCH.maxTilesPerRun;

    const phaseOne = tilesAroundCenter(center, initialZoom, TILE_PREFETCH.initialRadiusTiles);
    const urlsPhaseOne = phaseOne
      .slice(0, budget)
      .map(({ z, x, y }) => buildVectorTileUrl(vectorTilesBase, z, x, y, trimmedKey));
    budget -= urlsPhaseOne.length;

    console.log('[MVX-SW] Tile prefetch phase 1 (initial zoom only)', {
      initialZoom,
      tiles: urlsPhaseOne.length,
    });
    await prefetchUrlsInBatches(cache, urlsPhaseOne, signal);

    if (signal.aborted || budget <= 0) {
      console.log('[MVX-SW] Tile prefetch stopped after phase 1');
      return;
    }

    const otherZoomLevels = [];
    for (let z = minZoom; z <= maxZoom; z++) {
      if (z !== initialZoom) {
        otherZoomLevels.push(z);
      }
    }
    otherZoomLevels.sort((a, b) => Math.abs(a - initialZoom) - Math.abs(b - initialZoom));

    for (const zoom of otherZoomLevels) {
      if (signal.aborted || budget <= 0) {
        break;
      }
      await delay(TILE_PREFETCH.zoomLevelGapMs);
      if (signal.aborted) {
        break;
      }

      const ring = tilesAroundCenter(center, zoom, TILE_PREFETCH.progressiveRadiusTiles);
      const urls = ring
        .slice(0, budget)
        .map(({ z: zz, x, y }) => buildVectorTileUrl(vectorTilesBase, zz, x, y, trimmedKey));
      budget -= urls.length;

      console.log('[MVX-SW] Tile prefetch background zoom', {
        zoom,
        tiles: urls.length,
      });
      await prefetchUrlsInBatches(cache, urls, signal);
    }

    console.log('[MVX-SW] Progressive tile prefetch finished');
  } catch (err) {
    if (err.name === 'AbortError') {
      return;
    }
    console.error('[MVX-SW] Progressive tile prefetch failed', err);
  }
}

function isValidMessage(data) {
  return data !== null && typeof data === 'object' && typeof data.type === 'string' && data.type.length > 0;
}

async function clearAllCaches() {
  const cacheNames = await caches.keys();
  await Promise.all(cacheNames.map(name => caches.delete(name)));
}

async function resetAndUnregister() {
  try {
    await clearAllCaches();
  } catch (err) {
    console.warn('[MVX-SW] resetAndUnregister: clear caches failed', err);
  }
  try {
    await self.registration.unregister();
  } catch (err) {
    console.warn('[MVX-SW] resetAndUnregister: unregister failed', err);
  }
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      try {
        client.postMessage({ type: 'SW_RESET_DONE' });
      } catch (postErr) {
        console.warn('[MVX-SW] resetAndUnregister: postMessage failed', postErr);
      }
    }
  } catch (err) {
    console.warn('[MVX-SW] resetAndUnregister: matchAll failed', err);
  }
}

function notifyClients(message) {
  self.clients
    .matchAll({ includeUncontrolled: true })
    .then(clients => {
      clients.forEach(client => {
        try {
          client.postMessage(message);
        } catch (err) {
          console.warn('[MVX-SW] notifyClients postMessage failed', err);
        }
      });
    })
    .catch(err => console.warn('[MVX-SW] notifyClients matchAll failed', err));
}

const ALLOWED_HOSTS = ['mapvx.com', 'lazarillo.app'];
const isAllowedHost = hostname => ALLOWED_HOSTS.some(host => hostname.endsWith(host));

self.skipWaiting();
workbox.core.clientsClaim();
workbox.core.setCacheNameDetails({ prefix: 'mvx' });
workbox.precaching.cleanupOutdatedCaches();

workbox.loadModule('workbox-routing');
workbox.loadModule('workbox-strategies');
workbox.loadModule('workbox-cacheable-response');
workbox.loadModule('workbox-expiration');

const { registerRoute } = workbox.routing;
const { CacheFirst, StaleWhileRevalidate, NetworkFirst } = workbox.strategies;
const { CacheableResponsePlugin } = workbox.cacheableResponse;
const { ExpirationPlugin } = workbox.expiration;

registerRoute(
  ({ url }) => url.hostname === 'public-api.mapvx.com' && url.pathname.includes('/place'),
  new StaleWhileRevalidate({
    cacheName: CACHE_API_PLACES,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200, 204] }),
      new ExpirationPlugin({
        maxEntries: 500,
        maxAgeSeconds: 60 * 60 * 24 * 7,
        purgeOnQuotaError: true,
      }),
    ],
  })
);

registerRoute(
  ({ url }) => url.hostname === 'public-api.mapvx.com' && url.pathname.includes('/configuration'),
  new StaleWhileRevalidate({
    cacheName: CACHE_API_CONFIG,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200, 204] }),
      new ExpirationPlugin({
        maxEntries: 100,
        maxAgeSeconds: 60 * 60 * 24,
        purgeOnQuotaError: true,
      }),
    ],
  })
);

registerRoute(
  ({ url }) => url.hostname === 'api.mapvx.com' && url.pathname.includes('/route'),
  new NetworkFirst({
    cacheName: CACHE_API_ROUTES,
    networkTimeoutSeconds: 10,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200, 204] }),
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: 60 * 60 * 24,
        purgeOnQuotaError: true,
      }),
    ],
  })
);

registerRoute(
  ({ url }) => url.hostname === 'api.mapvx.com' || url.hostname === 'public-api.mapvx.com',
  new NetworkFirst({
    cacheName: CACHE_API_FALLBACK,
    networkTimeoutSeconds: 10,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200, 204] }),
      new ExpirationPlugin({
        maxEntries: 500,
        maxAgeSeconds: 60 * 60,
        purgeOnQuotaError: true,
      }),
    ],
  })
);

registerRoute(
  ({ url }) => (isAllowedHost(url.hostname) && /\.pbf($|\?)/.test(url.pathname)) || url.pathname.includes('/tiles/'),
  new CacheFirst({
    cacheName: CACHE_TILES,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200, 204] }),
      new ExpirationPlugin({
        maxEntries: 10000,
        maxAgeSeconds: 60 * 60 * 24,
        purgeOnQuotaError: true,
      }),
    ],
  })
);

registerRoute(
  ({ url }) => isAllowedHost(url.hostname) && !/\.pbf($|\?)/.test(url.pathname),
  new StaleWhileRevalidate({
    cacheName: CACHE_MAP_ASSETS,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200, 204] }),
      new ExpirationPlugin({
        maxEntries: 1000,
        maxAgeSeconds: 60 * 60 * 24 * 7,
        purgeOnQuotaError: true,
      }),
    ],
  })
);

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      try {
        const cacheNames = await caches.keys();
        await Promise.all(
          cacheNames.map(name => {
            if (
              !KNOWN_RUNTIME_CACHES.has(name) &&
              !name.startsWith('workbox-precache') &&
              !name.startsWith('mvx-precache') &&
              !name.startsWith('mvx-')
            ) {
              console.log('[MVX-SW] Dropping legacy cache', name);
              return caches.delete(name);
            }
            return Promise.resolve(false);
          })
        );
      } catch (err) {
        console.warn('[MVX-SW] Activate cleanup failed', err);
      }
    })()
  );
});

self.addEventListener('message', event => {
  if (!isValidMessage(event.data)) return;

  switch (event.data.type) {
    case 'INITIAL_TILE_LOAD':
    case 'REFRESH_TILES': {
      const { apiKey, placeId, tilesBaseUrl } = event.data;
      if (typeof apiKey !== 'string' || typeof placeId !== 'string') {
        console.warn('[MVX-SW]', event.data.type, 'missing apiKey or placeId');
        return;
      }
      event.waitUntil(
        progressivePrefetchTiles(apiKey, placeId, tilesBaseUrl).catch(err =>
          console.error('[MVX-SW]', event.data.type, 'failed', err)
        )
      );
      break;
    }

    case 'CLEAR_TILE_CACHE':
      event.waitUntil(
        caches
          .delete(CACHE_TILES)
          .then(() => {
            console.log('[MVX-SW] Tile cache cleared');
            notifyClients({ type: 'TILE_CACHE_CLEARED' });
          })
          .catch(err => console.error('[MVX-SW] CLEAR_TILE_CACHE failed', err))
      );
      break;

    case 'CLEAR_ALL_CACHES':
      event.waitUntil(
        clearAllCaches()
          .then(() => {
            console.log('[MVX-SW] All caches cleared');
            notifyClients({ type: 'ALL_CACHES_CLEARED' });
          })
          .catch(err => console.error('[MVX-SW] CLEAR_ALL_CACHES failed', err))
      );
      break;

    case 'RESET_AND_UNREGISTER':
      event.waitUntil(resetAndUnregister());
      break;

    default:
      break;
  }
});
