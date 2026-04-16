# Pixhood

**Geo-anchored collaborative pixel art — paint your neighborhood on a real map.**

> Think r/place meets Google Maps. No accounts, no install — open the app, pick a color, paint.

**Live at [pixhood.art](https://pixhood.art)**

---

## Screenshots

<!-- TODO: map view with painted pixels -->
<!-- TODO: sub-grid zoom (level 21+) -->
<!-- TODO: color picker + welcome screen -->

---

## What it does

- Open the app → welcome screen explains why location is useful, then asks permission
- Map centers on your location (Berlin fallback)
- Pick a color, click anywhere on the map → paint a pixel tied to real-world coordinates
- Everyone sees each other's paintings in real time via WebSocket
- Zoom in past zoom 21 → each pixel reveals a 16×16 sub-grid for detailed art
- All pixels expire after 24h — canvas resets daily, no moderation needed
- Works on desktop and mobile Safari/Chrome

---

## Technical highlights

### Mercator-corrected grid

Longitude converges toward the poles — at Berlin (52.52°N), `0.0001°` lat ≈ 11.1m but `0.0001°` lng ≈ 6.7m. Longitude step is cosine-corrected: `LNG_STEP = TILE_SIZE / cos(lat)` keeps tiles square without per-row stepping artifacts.

### Viewport-scoped real-time broadcasts

Clients subscribe with their current viewport bounds. The server only forwards pixel updates to clients whose viewport contains the painted tile — O(clients) per paint instead of broadcasting everything to everyone. Bounds are sent on connect, reconnect, and each viewport refresh with fetch margin for smooth panning.

### Redis geo-indexed queries

Pixels are stored as individual keys with 24h TTL for natural expiry. A sorted set with `GEOADD`/`GEOSEARCH` enables efficient bounding-box viewport queries. Stale geo entries (expired pixel keys) are cleaned lazily on each query. Sub-pixels are stored as a Hash per parent, accessed as a group via `HGETALL`.

### Cross-browser geolocation

Handles Safari one-time grants (permission state `"prompt"` after expiry), Chrome network-location timeouts (`maximumAge: 300000` for cached position fallback), and tab-background throttling. Uses `navigator.permissions.query()` to short-circuit denied state without triggering unnecessary system dialogs.

### Zero-build frontend

No framework, no bundler, no build step. Vanilla JS with Leaflet.js (CDN). Script load order is the only dependency chain. Deploys as static files to Cloudflare Pages.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS, Leaflet.js, native WebSocket |
| Backend | Node.js, [`ws`](https://github.com/websockets/ws) |
| Storage | Redis (individual keys with TTL, GEOADD/GEOSEARCH, Hash for sub-pixels) |
| Hosting | Cloudflare Pages (frontend), Fly.io (backend), managed Redis |
| Basemap | CartoDB Dark Matter (nolabels) |

---

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

---

## How it works

### Grid

The world is divided into a fixed grid of ~10×10m tiles. Each tile holds one color — last painter wins.

```
TILE_SIZE = 0.0001                          (~11.1m in latitude)
LNG_STEP  = 0.0001 / cos(52.52°)           (~11.1m in longitude at Berlin)
```

```js
tileKey = `${Math.floor(lat / TILE_SIZE)}_${Math.floor(lng / LNG_STEP)}`
```

### Sub-grid (zoom ≥ 21)

Each tile can contain a 16×16 sub-grid of child pixels. Painting a parent erases its children. Painting a child updates the parent's displayed color (RGB average with opacity = `sqrt(childrenCount / 256)`).

### Data flow

1. Page load → `GET /pixels?n=&s=&e=&w=` fetches pixels in bounding box
2. Client subscribes via WebSocket with viewport bounds
3. User clicks map → `POST /pixels` saves to Redis (24h TTL) and broadcasts to matching viewports
4. Connected clients render the new pixel immediately
5. Viewport changes → client refetches + resubscribes

Sessions are anonymous — a UUID in `localStorage`. No sign-up, no accounts.

### Redis keys

| Key pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `pixel:<tileKey>` | String | 24h | Parent pixel JSON |
| `subpixels:<tileKey>` | Hash | 24h | Child pixels: field=`subX_subY`, value=JSON |
| `pixels:geo` | Sorted Set | — | GEOADD/GEOSEARCH for viewport queries |

---

## Project structure

```
pixhood/
├── frontend/          # Static frontend (Cloudflare Pages)
│   ├── index.html     # Entry point, loads Leaflet CDN + app scripts
│   ├── style.css
│   ├── config.js      # Constants: API_URL, WS_URL, TILE_SIZE, SUB_GRID_SIZE, palette
│   ├── grid.js        # Tile + sub-tile key computation, snapToTile(), snapToSubTile()
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
│   │   ├── icon-512.png   # PWA icon
│   │   └── _headers      # Cache headers
│   ├── scripts/       # Build utilities
│   │   └── generate-icons.js
│   └── dist/          # Build output (gitignored)
├── server/            # Backend API (Fly.io)
│   ├── index.js       # HTTP + WebSocket server, viewport API, child pixel API
│   ├── redis.js       # Redis client, geo-indexed queries, TTL management
│   ├── fly.toml       # Fly.io configuration
│   ├── Dockerfile
│   └── package.json
├── CLAUDE.md          # Developer documentation
└── README.md          # User-facing docs
```

---

## Deploying

Frontend: **Cloudflare Pages** ([pixhood.art](https://pixhood.art))
Backend: **Fly.io** ([api.pixhood.art](https://api.pixhood.art)) + managed Redis

```bash
# Backend
cd server && fly deploy

# Frontend
cd frontend
npm install
npm run build
wrangler pages deploy dist/ --project-name=pixhood

# Or use wrangler.toml (auto-runs build):
wrangler pages deploy .
```

---

## Limitations & future work

- **Berlin-optimized grid** — `LNG_STEP` calibrated for Berlin's latitude; tiles slightly non-square elsewhere
- **Single machine** — WebSocket state is in-memory; scaling requires Redis pub/sub between machines
- **No rate limiting** — a single client can spam paints
- **No accounts** — anonymous sessions only, no pixel ownership

---

## License

MIT © 2025 Evgenii Malikov
