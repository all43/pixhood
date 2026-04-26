# Pixhood

Geo-anchored pixel art web app. Users paint colored pixels tied to real-world coordinates. Think r/place meets Google Maps — local-first, collaborative, launched initially in Berlin.

Live at [pixhood.art](https://pixhood.art). Backend at [api.pixhood.art](https://api.pixhood.art).

## Architecture

**Frontend**: Vanilla JS with minimal build step. Leaflet.js (CDN) for the map. Native browser `WebSocket` + `fetch` for backend communication. Hosted on Cloudflare Pages. PWA-ready with service worker for caching.

**Backend**: Node.js HTTP server (`server/index.js`) with native WebSocket via `ws` package. Hosted on Fly.io. Includes health check endpoint (`GET /health`), graceful shutdown on SIGTERM (closes WS clients, HTTP server, Redis, 5s force-exit timeout), and request body size limit (10KB).

**Storage**: Redis — pixels as individual String keys with 24h TTL, sub-pixels as Hashes per parent tile, geo sorted set for viewport queries. Sub-pixel queries use pipelined `getSubpixelsMulti` (single Redis round-trip per viewport). Rate limit checks use `checkWriteRateLimitsBatch` (pipelined INCR+PEXPIRE+ZREMRANGEBYSCORE+ZCOUNT×2).

**Real-time**: Viewport-scoped WebSocket broadcasts. Clients subscribe with their current viewport bounds; server only forwards pixel updates to clients whose viewport contains the painted tile. Client sends heartbeat pings every 30s. WS connections validated by Origin header (allowlist: `pixhood.art`, `*.pixhood.art`, `localhost`, `127.0.0.1`). Max WS message payload 10KB. Connections without a valid Origin header are rejected with 403 at handshake.

**Sessions**: Server-generated via `crypto.randomBytes(16)` → `sess_<32hex>`. Sent to client on first WS connection (or when client has no valid session ID). Stored in `localStorage`. Reference-counted across WS connections — session state survives reconnects, only deleted when ref count reaches 0.

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
│   ├── config.js      # Constants: API_URL, WS_URL, TILE_SIZE_M, Mercator projection, palette
│   ├── grid.js        # Tile + sub-tile key computation
│   ├── pixels.js      # Viewport fetch, child pixel write, WebSocket + heartbeat
│   ├── map.js         # Leaflet map init, renderPixel(), sub-grid rendering
│   ├── app.js         # Bootstrap: geolocation, color picker, viewport refresh wiring
│   ├── admin.js       # Admin panel (loaded dynamically on #admin): token auth, sessions, inspect, region erase
│   ├── admin.css      # Admin panel styles (loaded dynamically on #admin)
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
├── shared/             # Shared constants between frontend and server
│   └── ws-types.js     # Single source of truth for WS message type strings
├── server/            # Backend API (Fly.io)
│   ├── index.js       # HTTP + WebSocket server, viewport API, child pixel API
│   ├── redis.js       # Redis client, geo-indexed queries, TTL management
│   ├── Dockerfile     # Copies shared/ via predeploy script
│   ├── .gitignore     # Excludes copied shared/
│   └── package.json   # predeploy + deploy scripts
├── CLAUDE.md          # This file
└── README.md          # User-facing docs
```

Script load order in `index.html` matters: `config → grid → pixels → map → app`.

## Grid system

World is divided into tiles in Web Mercator space (`TILE_SIZE_M = 18.4m`). Tiles are always square on screen at every latitude. Ground distance varies: ~11.1m at Berlin, ~18.4m at equator. Tile key is computed by projecting lat/lng to Mercator meters:

```js
tileKey = `${Math.floor(lngToX(lng) / TILE_SIZE_M)}_${Math.floor(latToY(lat) / TILE_SIZE_M)}`
```

Grid rendering uses direct pixel math (spacing = `TILE_SIZE_M * 256 * 2^zoom / (2 * R)`) — no per-tile projection calls. One pixel per tile, last painter wins.

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
  "id": "81099_374711",
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
  "id": "81099_374711_8_12",
  "parentId": "81099_374711",
  "subX": 8,
  "subY": 12,
  "lat": 52.52008,
  "lng": 13.40508,
  "color": "#00FF00",
  "paintedAt": "2026-04-10T12:00:00.000Z",
  "sessionId": "sess_abc123"
}
```

No user accounts — sessions are server-generated (`sess_<32hex>` via `crypto.randomBytes`) and stored in `localStorage`. Session state is reference-counted across WS connections; survives reconnects, deleted only when ref count reaches 0.

## Redis keys

| Key pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `pixel:<tileKey>` | String | 24h | Parent pixel JSON |
| `subpixels:<tileKey>` | Hash | 24h | Child pixels: field=`subX_subY`, value=JSON |
| `pixels:geo` | Sorted Set | — | GEOADD/GEOSEARCH for viewport bounding-box queries |
| `paintlog:<sessionId>` | Sorted Set | 24h | Paint audit log: score=timestamp, value=JSON with previous state for revert |
| `ratelimit:<prefix>:<ip>` | String | 1 min | IP rate limit counter (INCR + EXPIRE) |
| `flagged_sessions` | Set | — | Session IDs flagged for suspicious activity |
| `blocked:<sessionId>` | String | 1h | Blocked session (auto-revert triggered) |
| `admin_attempts:<ip>` | String | 15min | Failed admin auth attempt counter |

Stale geo entries (pixel key expired) cleaned lazily on each viewport query.

Reading subpixels (`getSubpixels`) resets the subpixels hash TTL via `EXPIRE` — but does NOT reset the parent key TTL. Writing a parent or child pixel resets both parent and subpixels TTL to 24h.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check, returns `{status:'ok'}`. No auth required. |
| `GET` | `/pixels?n=&s=&e=&w=` | Viewport query: pixels in bounding box. Always includes children. |
| `POST` | `/pixels` | Save parent pixel (admin only). Erases children, broadcasts. |
| `POST` | `/pixels/child` | Save child pixel (admin only). Broadcasts. |
| `POST` | `/admin/verify` | Verify admin API key. Rate limited: 5 attempts per IP, 15min lockout. |
| `GET` | `/admin/sessions` | List active sessions with paint count and last location (requires auth). Uses `SCAN paintlog:*`. |
| `GET` | `/admin/session/:sessionId` | Get paint log for a session (requires auth) |
| `GET` | `/admin/flagged` | List flagged sessions (requires auth) |
| `POST` | `/admin/revert` | Revert all paints by a session (requires auth) |
| `DELETE` | `/admin/region?n=&s=&e=&w=` | Erase all pixels in bounding box (requires auth). Broadcasts deletions. |
| `WS` | WebSocket connection | Real-time updates, painting, ping/pong, viewport subscription |

### WebSocket protocol

Connection: `wss://api.pixhood.art` (max 10 concurrent connections per IP). Origin header validated against allowlist (`pixhood.art`, `*.pixhood.art`, `localhost`, `127.0.0.1`). Connections without valid Origin rejected with 403 at handshake. Max WS payload 10KB.

**Server → Client:**
- `{ type: "pixel", data }` — pixel painted (viewport-scoped broadcast)
- `{ type: "child", data }` — child pixel painted (viewport-scoped broadcast)
- `{ type: "clearChildren", data: { parentId } }` — children erased (viewport-scoped broadcast)
- `{ type: "deletePixel", data: { id } }` — pixel deleted by revert (viewport-scoped broadcast)
- `{ type: "pong" }` — heartbeat response
- `{ type: "session", sessionId }` — server-assigned session ID, sent when client has no valid session
- `{ type: "paintAck", id }` — paint acknowledged (sent to painting client only)
- `{ type: "paintError", id, reason, retryAfter? }` — paint rejected (`rate_limited`, `blocked`, `invalid_input`, `no_session`, `server_error`)
- `{ type: "blocked" }` — session auto-reverted (sent to painting client only)

**Client → Server:**
- `{ type: "ping" }` every 30s → server responds `{ type: "pong" }`
- `{ type: "viewport", bounds: { n, s, e, w }, sessionId: "sess_...", zoom: 17 }` on connect, reconnect, and each viewport refresh (with fetch margin). Server uses sessionId for paint logging and suspicion detection. Server validates viewport span against reported zoom.
- `{ type: "paintParent", id, tileKey, lat, lng, color }` — paint a parent pixel. `id` is a client-generated sequence number for ack correlation.
- `{ type: "paintChild", id, parentId, tileKey, subX, subY, lat, lng, color }` — paint a child pixel.

Painting is optimistic: client renders immediately, sends WS message. Server responds with `paintAck` on success or `paintError` on failure. Client tracks pending paints with a 5-second timeout; on timeout or WS disconnect, shows a toast and triggers viewport refresh to correct visual state.

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

- **Web Mercator grid**: Tiles defined in Mercator space (`TILE_SIZE_M = 18.4m`), always square on screen. Grid rendering uses direct pixel math, no per-tile projection calls.
- **Individual keys with TTL** over single hash: natural Redis expiry, no manual cleanup.
- **Geo sorted set**: `GEOSEARCH` for efficient viewport bounding-box queries with lazy stale cleanup.
- **Hash per parent for sub-pixels**: always accessed as a group, `HGETALL` is efficient, whole-set expiry via TTL.
- **Always load children**: server always returns children data regardless of zoom. Frontend computes parent display (average color + sqrt opacity). No zoom-gating on API, smooth zoom transitions.
- **Native WebSocket over Socket.io**: fewer dependencies, sufficient for broadcast-only real-time.
- **Viewport-scoped broadcasts**: clients subscribe with bounds, server only forwards relevant updates. Avoids O(clients×paints) wasted messages.
- **Single Fly.io machine**: in-memory WS state requires a single machine; cross-machine pub/sub not implemented.
- **`maximumAge: 300000`** on geolocation: allows Chrome to return cached position instantly instead of timing out when the network location provider is slow.
- **No build step**: prototype stays simple, `node index.js` and open browser.

## Implementation notes

**WebSocket protocol:** Message type strings (`WS_TYPE_PING`, `WS_TYPE_PONG`, `WS_TYPE_VIEWPORT`, `WS_TYPE_PIXEL`, `WS_TYPE_CHILD`, `WS_TYPE_CLEAR_CHILDREN`, `WS_TYPE_DELETE_PIXEL`, `WS_TYPE_PAINT_PARENT`, `WS_TYPE_PAINT_CHILD`, `WS_TYPE_PAINT_ACK`, `WS_TYPE_PAINT_ERROR`, `WS_TYPE_BLOCKED`, `WS_TYPE_SESSION`) are defined in `shared/ws-types.js` as the single source of truth. The server requires it via `./shared/ws-types` (copied by predeploy script). The frontend `config.js` wraps them in `CONFIG`. Frontend `build.js` validates sync at build time — fails if types drift.

**Pipeline optimizations:** `getSubpixelsMulti(parentIds)` fetches all sub-pixel hashes in a single Redis pipeline (replaces N+1 sequential `HGETALL` calls in viewport endpoint). `checkWriteRateLimitsBatch(ip, sessionId, ...)` pipelines IP rate limit INCR+PEXPIRE with session burst/sustained ZCOUNT checks in one round-trip.

## Rate limiting and abuse prevention

### Paint log (`paintlog:<sessionId>`)

Every paint is logged with the previous pixel state for potential revert. The sorted set score is `Date.now()`, entries older than 24h are pruned on each write. The log serves dual purpose: sliding-window rate limiting (count entries in a time window) and audit trail for revert.

### Rate limits

| Limiter | Threshold | Mechanism |
|---------|-----------|-----------|
| Per-session burst | 10 paints/sec | Paint log `ZCOUNT` in 1s window |
| Per-session sustained | 60 paints/min | Paint log `ZCOUNT` in 60s window |
| Per-IP writes | 120/min | `INCR` + `EXPIRE` on `ratelimit:write:<ip>` |
| Per-IP reads | 300/min | `INCR` + `EXPIRE` on `ratelimit:read:<ip>` |

Write rate limit checks use a single Redis pipeline (`checkWriteRateLimitsBatch`) combining INCR+PEXPIRE+ZREMRANGEBYSCORE+ZCOUNT×2 in one round-trip.

Rate-limited paints get a `paintError` WS message with `reason: "rate_limited"` and `retryAfter`. Frontend shows a toast. Invalid paint messages (bad tileKey, color, lat/lng, subX/subY) get `reason: "invalid_input"`.

### Suspicion detection

Three heuristic checks run on every paint (non-blocking — flags but doesn't reject):

1. **Viewport check**: paint coordinates must fall within the session's last reported WS viewport ± 2× viewport span margin
2. **Distance check**: consecutive paints from the same session must not exceed 500m/s speed (Haversine distance / time between paints)
3. **Viewport plausibility**: viewport span must be consistent with the reported zoom level (max span = `360 / 2^(zoom-6)`). An implausibly large viewport suggests spoofed bounds.

Flagged sessions are stored in `flagged_sessions` Redis set and logged server-side with `[suspicion]` prefix.

### Auto-revert

Triggered after logging a paint but before saving it. Three conditions, any one triggers immediate revert of all session paints + 1-hour block:

| Trigger | Threshold | Window |
|---------|-----------|--------|
| Extreme burst | >30 paints | 5 seconds |
| Impossible distance | >2km between consecutive paints | 5 seconds |
| Accumulated flags | ≥3 suspicion flags | 10 minutes |

Blocked sessions have their paints reverted and receive `{ type: "blocked" }` WS message. Subsequent paints are silently rejected. Block expires after 1 hour (`blocked:<sessionId>` key with TTL).

### Revert

`POST /admin/revert` restores all tiles painted by a session to their pre-session state. For each tile, the earliest log entry's `previousColor`/`previousChildren` (for parent paints) or `previousChildColor` (for child paints) determines the restoration target. Changes are broadcast via WS.

### IP connection limit

Max 10 concurrent WS connections per IP (tracked via `wss.clients` iteration per connection). Legitimate multi-user households/cafes are fine; bot connection flooding is blocked.

### Admin auth

All `/admin/*` endpoints and HTTP paint endpoints (`POST /pixels`, `POST /pixels/child`) require `Authorization: Bearer <ADMIN_API_KEY>` header. Failed auth increments `admin_attempts:<ip>` counter. After 5 failures, IP is locked out for 15 minutes.

`POST /admin/verify` validates the token without side effects. Returns 403 if `ADMIN_API_KEY` is not configured.

### Security

- **Input validation**: `validatePaintParent()` and `validatePaintChild()` reject WS paint messages with invalid `tileKey` (must match `/^-?\d+(_-?\d+)+$/`), `color` (case-insensitive `/^#[0-9a-f]{6}$/`), `lat`/`lng` ranges, `subX`/`subY` (0–15). Rejected with `{type: "paintError", reason: "invalid_input"}`.
- **Request body size limit**: 10KB max for HTTP requests. WS `maxPayload: 10KB`. Exceeds → 413 (HTTP) or connection close (WS).
- **Timing-safe auth**: `timingSafeEqualStr()` using `crypto.timingSafeEqual` for admin token comparison, prevents timing attacks.
- **XSS protection**: Admin panel uses `escapeHtml()` and `safeColor()` for all user-controlled innerHTML. No raw string interpolation.
- **WS Origin validation**: `verifyClient` rejects connections from unauthorized origins at handshake level. Blocks connections without Origin header.
- **Session ref-counting**: `sessionRefCounts` Map ensures session state isn't destroyed when a single WS connection drops if the same session has other active connections.

### Admin panel

Activated via URL hash `#admin`. `admin.js` and `admin.css` are loaded dynamically (not fetched by regular users). Token stored in `sessionStorage` (cleared on tab close).

**Tools:**
- **Inspect mode**: Click any pixel to see its session ID, color, and paint time. Session ID links to the inspector. Mutually exclusive with region erase mode.
- **Region erase**: Draw rectangle on map, confirm, deletes all pixels in bounds via `DELETE /admin/region`. Broadcasts `deletePixel` for each.
- **Sessions list**: "Load Active Sessions" button triggers `SCAN paintlog:*` in Redis. Shows paint count, relative time, locate button (pans map to last paint location at zoom 20).
- **Session inspector**: Enter or click a session ID to view paint log with click-to-pan. "Revert All Paints" button calls `POST /admin/revert`.
- **Flagged sessions**: Collapsible section, shows sessions flagged for suspicious activity with one-click revert.

No IP addresses shown anywhere in the admin UI.

## Out of scope (prototype)

User accounts, pixel ownership, undo/erase, social features, mobile app.

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `PORT` | `3000` | HTTP server port |
| `CORS_ORIGIN` | `http://localhost:{PORT}` | CORS allowed origin |
| `ADMIN_API_KEY` | — | Bearer token for `/admin/*` endpoints |
