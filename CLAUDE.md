# Pixhood

Geo-anchored pixel art web app. Users paint colored pixels tied to real-world coordinates. Think r/place meets Google Maps — local-first, collaborative, launched initially in Berlin.

Live at [pixhood.art](https://pixhood.art). Backend at [api.pixhood.art](https://api.pixhood.art).

## Architecture

**Frontend**: Vanilla JS with minimal build step. Leaflet.js (CDN) for the map. Native browser `WebSocket` + `fetch` for backend communication. Hosted on Cloudflare Pages. PWA-ready with service worker for caching.

**Backend**: Node.js HTTP server (`server/index.js`) with native WebSocket via `ws` package. Hosted on Fly.io.

**Storage**: Redis — pixels as individual String keys with 24h TTL, sub-pixels as Hashes per parent tile, geo sorted set for viewport queries.

**Real-time**: Viewport-scoped WebSocket broadcasts. Clients subscribe with their current viewport bounds; server only forwards pixel updates to clients whose viewport contains the painted tile. Client sends heartbeat pings every 30s.

**Deployment**: Frontend deployed to Cloudflare Pages (`frontend/` directory). Backend deployed to Fly.io (`server/` directory). Single machine required for in-memory WebSocket state.

## Running locally

**Prerequisites**: Node.js 18+, Redis ([Redis Cloud free tier](https://redis.io/cloud/) or local `redis-server`)

Two terminals:

```bash
# Terminal 1: Backend
cd server
npm install
REDIS_URL=redis://localhost:6379 npm run dev
```

```bash
# Terminal 2: Frontend
cd frontend
npm install
npm run dev
# open http://localhost:3000
```

## File structure

```
pixhood/
├── frontend/          # Static frontend (Cloudflare Pages)
│   ├── index.html     # Entry point, loads Leaflet CDN + app scripts
│   ├── style.css
│   ├── config.js      # Constants: API_URL, WS_URL, TILE_SIZE, SUB_GRID_SIZE, palette
│   ├── grid.js        # Tile + sub-tile key computation
│   ├── pixels.js      # Viewport fetch, child pixel write, WebSocket + heartbeat
│   ├── map.js         # Leaflet map init, renderPixel(), sub-grid rendering
│   ├── app.js         # Bootstrap: geolocation, color picker, viewport refresh wiring
│   ├── favicon.svg
│   ├── build.js       # Build script: hashes files, generates SW
│   ├── wrangler.toml  # Cloudflare Pages configuration
│   ├── package.json   # Dev server (serve), build scripts
│   ├── public/        # Static assets (copied to dist/)
│   │   ├── manifest.json    # PWA manifest
│   │   ├── icon-192.png   # PWA icon
│   │   ├── icon-512.png  # PWA icon
│   │   └── _headers     # Cache headers
│   ├── scripts/       # Build utilities
│   │   └── generate-icons.js
│   └── dist/          # Build output (gitignored)
├── server/            # Backend API (Fly.io)
│   ├── index.js       # HTTP + WebSocket server, viewport API, child pixel API
│   ├── redis.js       # Redis client, geo-indexed queries, TTL management
│   └── package.json
├── CLAUDE.md          # This file
└── README.md          # User-facing docs
```

Script load order in `index.html` matters: `config → grid → pixels → map → app`.

## Grid system

World is divided into ~10m × 10m tiles. Tile key is computed by snapping lat/lng to grid:

```js
tileKey = `${Math.floor(lat / TILE_SIZE)}_${Math.floor(lng / LNG_STEP)}`
```

`TILE_SIZE = 0.0001` degrees (~10m). `LNG_STEP` is cos-corrected for latitude. One pixel per tile, last painter wins.

### Zoom levels

| Zoom | Behavior |
|------|----------|
| < 16 | Grid hidden, painting disabled |
| 16–20 | Parent pixel grid visible, click to paint parent pixels |
| ≥ 21 | Sub-grid visible (16×16 per parent), click to paint child pixels |

### Sub-grid (zoom ≥ 21)

Each tile can contain a 16×16 sub-grid of child pixels. Sub-tile keys: `${parentKey}_${subX}_${subY}`.

- Painting a **parent** erases all its children.
- Painting a **child** adds it to the parent's children hash. Parent's displayed color is the average of all children RGB values, with opacity = `sqrt(childrenCount / 256)`.
- Parent's own color is ignored when children exist.
- Children inherit the parent's 24h TTL; the whole set expires together.

## Data model

### Parent pixel
```json
{
  "id": "525200_130450",
  "lat": 52.5200,
  "lng": 13.4050,
  "color": "#FF0000",
  "hasChildren": false,
  "paintedAt": "2026-04-10T12:00:00.000Z",
  "sessionId": "sess_abc123"
}
```

### Child pixel
```json
{
  "id": "525200_130450_8_12",
  "parentId": "525200_130450",
  "subX": 8,
  "subY": 12,
  "lat": 52.52008,
  "lng": 13.40508,
  "color": "#00FF00",
  "paintedAt": "2026-04-10T12:00:00.000Z",
  "sessionId": "sess_abc123"
}
```

No user accounts — sessions are anonymous UUIDs in `localStorage`.

## Redis keys

| Key pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `pixel:<tileKey>` | String | 24h | Parent pixel JSON |
| `subpixels:<tileKey>` | Hash | 24h | Child pixels: field=`subX_subY`, value=JSON |
| `pixels:geo` | Sorted Set | — | GEOADD/GEOSEARCH for viewport bounding-box queries |

Stale geo entries (pixel key expired) cleaned lazily on each viewport query.

Reading subpixels (`getSubpixels`) resets the subpixels hash TTL via `EXPIRE` — but does NOT reset the parent key TTL. Writing a parent or child pixel resets both parent and subpixels TTL to 24h.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/pixels?n=&s=&e=&w=` | Viewport query: pixels in bounding box. Always includes children. |
| `POST` | `/pixels` | Save parent pixel, erase children, broadcast |
| `POST` | `/pixels/child` | Save child pixel, broadcast |
| `WS` | WebSocket connection | Real-time updates, ping/pong, viewport subscription |

WebSocket: `wss://api.pixhood.art`
- Server pushes: `{ type: "pixel" }`, `{ type: "child" }`, `{ type: "clearChildren" }` (only to clients whose viewport contains the paint)
- Client sends: `{ type: "ping" }` every 30s → server responds `{ type: "pong" }`
- Client sends: `{ type: "viewport", bounds: { n, s, e, w } }` on connect, reconnect, and each viewport refresh (with fetch margin)

## Geolocation

The app uses `navigator.geolocation.getCurrentPosition` with `enableHighAccuracy: false` and `maximumAge: 300000` (5 min cache to avoid Chrome timeout issues).

Permission flow:
- First-time visitors see a welcome screen with an "Enable location" button that triggers the native system dialog.
- Returning visitors with `geo_pref = 'granted'` in localStorage get geolocation automatically.
- On reload, the app queries `navigator.permissions.query()` first. If the state is `"prompt"` (e.g., Safari one-time grant expired), it clears `geo_pref` and shows the welcome screen again.
- On timeout, `geo_pref` is cleared so the welcome screen shows on next reload.
- `status: 'denied'` from `permissions.query` short-circuits without calling `getCurrentPosition` (avoids unnecessary system dialog).
- `status: 'prompt'` from `permissions.query` does NOT short-circuit — it falls through to `getCurrentPosition` which triggers the native dialog.

## Key decisions

- **Individual keys with TTL** over single hash: natural Redis expiry, no manual cleanup.
- **Geo sorted set**: `GEOSEARCH` for efficient viewport bounding-box queries with lazy stale cleanup.
- **Hash per parent for sub-pixels**: always accessed as a group, `HGETALL` is efficient, whole-set expiry via TTL.
- **Always load children**: server always returns children data regardless of zoom. Frontend computes parent display (average color + sqrt opacity). No zoom-gating on API, smooth zoom transitions.
- **Native WebSocket over Socket.io**: fewer dependencies, sufficient for broadcast-only real-time.
- **Viewport-scoped broadcasts**: clients subscribe with bounds, server only forwards relevant updates. Avoids O(clients×paints) wasted messages.
- **Single Fly.io machine**: in-memory WS state requires a single machine; cross-machine pub/sub not implemented.
- **`maximumAge: 300000`** on geolocation: allows Chrome to return cached position instantly instead of timing out when the network location provider is slow.
- **No build step**: prototype stays simple, `node index.js` and open browser.

## Out of scope (prototype)

User accounts, pixel ownership, undo/erase, rate limiting, abuse prevention, social features, mobile app.

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `PORT` | `3000` | HTTP server port |
| `CORS_ORIGIN` | `http://localhost:{PORT}` | CORS allowed origin |
