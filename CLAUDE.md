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
│   ├── pixels.js      # Viewport fetch, paint/erase/undo WS messages, heartbeat
│   ├── map.js         # Leaflet map init, renderPixel(), sub-grid rendering, viewport bounds
│   ├── app.js         # Bootstrap: geolocation, color picker, undo logic, toast system, viewport refresh
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
│   │   ├── _headers     # Cache headers
│   │   └── _redirects   # SPA routing: /s/* → index.html
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

## Spaces

Isolated painting environments with separate pixel data. Used for kids' safety, friend groups, school classes — anyone with the link can paint, no one else can see or affect the pixels.

- **URL**: `pixhood.art/s/<slug>` (path-based, Cloudflare Pages `_redirects` routes to SPA)
- **Slug**: 12-char base62 string (`crypto.randomBytes(9).toString('base64url').slice(0, 12)`), ~3.2 × 10²¹ combinations
- **Creation**: `POST /spaces` → `{ slug }`. Rate-limited: 10/min per IP. No Redis state until first paint (lazy).
- **Privacy**: Invalid/unknown slug returns `[]` (identical to empty space). No enumeration endpoints. Global read rate limit (300/min per IP) makes brute-force impractical.
- **Isolation**: Redis keys prefixed with `space:<slug>:`. Each space has its own geo index, pixel keys, and subpixel hashes. Broadcasts are scoped to connections in the same space.

### Space-aware architecture

**Redis keys**: All pixel/subpixel/geo functions in `redis.js` accept an optional `space` parameter. When provided, keys are prefixed (`space:<slug>:pixel:<id>`). When null, global keys are used (no migration needed).

**WebSocket**: Client connects with `?space=<slug>` query param. Server stores `ws.space` on the connection (immutable). All broadcasts check `client.space === space`. Client never sends space in per-message payloads.

**Paint log**: `paintlog:<sessionId>` stays global (cross-space abuse detection). Each log entry includes a `space` field so `revertSession` can restore pixels in the correct space and broadcast correctly.

**Rate limits**: IP write rate limits are per-space (`space:ratelimit:write:<ip>:<space>`). Session burst/sustained checks stay global via paint log. Read rate limits stay global.

**Admin**: Admin endpoints operate on a single space (passed via `space` query param or from paint log entries during revert). `DELETE /admin/region` accepts optional `space` param.

**Frontend**: `CONFIG.SPACE` parsed from URL path in `config.js`. Passed as query param to HTTP API calls and as WS connection param. Welcome screen shows "Create Space" / "Join Space" buttons. Topbar shows space slug with copy-link button when inside a space.

**Service worker**: Navigation to `/s/<slug>` handled by existing network-first strategy. Cloudflare Pages `_redirects` serves `index.html` for all `/s/*` paths.

## Redis keys

| Key pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `pixel:<tileKey>` | String | 24h | Parent pixel JSON (global) |
| `subpixels:<tileKey>` | Hash | 24h | Child pixels: field=`subX_subY`, value=JSON (global) |
| `pixels:geo` | Sorted Set | — | GEOADD/GEOSEARCH for viewport queries (global) |
| `space:<slug>:pixel:<tileKey>` | String | 24h | Parent pixel JSON (space-scoped) |
| `space:<slug>:subpixels:<tileKey>` | Hash | 24h | Child pixels (space-scoped) |
| `space:<slug>:pixels:geo` | Sorted Set | — | Viewport geo index (space-scoped) |
| `protected_tiles` | Set | — | Protected tile keys (global). Per-space: `space:<slug>:protected_tiles` |
| `paintlog:<sessionId>` | Sorted Set | 24h | Paint audit log: score=timestamp, value=JSON with `type` (`parent`/`child`/`erase`), `space` field + previous state for revert |
| `ratelimit:<prefix>:<ip>` | String | 1 min | IP rate limit counter (global reads) |
| `space:ratelimit:write:<ip>:<space>` | String | 1 min | Per-space IP write rate limit |
| `ratelimit:space_create:<ip>` | String | 1 min | Space creation rate limit (10/min) |
| `flagged_sessions` | Set | — | Session IDs flagged for suspicious activity |
| `blocked:<sessionId>` | String | 1h | Blocked session (auto-revert triggered) |
| `admin_attempts:<ip>` | String | 15min | Failed admin auth attempt counter |

Stale geo entries (pixel key expired) cleaned lazily on each viewport query.

Reading subpixels (`getSubpixels`) resets the subpixels hash TTL — but does NOT reset the parent key TTL. Writing a parent or child pixel resets both parent and subpixels TTL to 24h. Protected pixels have no TTL (PERSIST). Extended-TTL pixels have 30-day TTL on both parent and subpixels. `getSubpixelsMulti` uses a two-pipeline approach: HGETALL + TTL check per parent, then conditional EXPIRE per subpixels hash based on parent TTL status (-1 = protected → PERSIST, >24h = extended → use parent's remaining TTL, ≤24h = default).

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check, returns `{status:'ok'}`. No auth required. |
| `GET` | `/pixels?n=&s=&e=&w=&space=` | Viewport query: pixels in bounding box. Always includes children. Optional `space` param. |
| `POST` | `/spaces` | Create space: returns `{ slug }`. Rate-limited 10/min per IP. No auth required. |
| `POST` | `/pixels` | Save parent pixel (admin only). Erases children, broadcasts. |
| `POST` | `/pixels/child` | Save child pixel (admin only). Broadcasts. |
| `POST` | `/admin/verify` | Verify admin API key. Rate limited: 5 attempts per IP, 15min lockout. |
| `GET` | `/admin/sessions` | List active sessions with paint count and last location (requires auth). Uses `SCAN paintlog:*`. |
| `GET` | `/admin/session/:sessionId` | Get paint log for a session (requires auth) |
| `GET` | `/admin/flagged` | List flagged sessions (requires auth) |
| `POST` | `/admin/revert` | Revert all paints by a session (requires auth) |
| `DELETE` | `/admin/region?n=&s=&e=&w=&space=` | Erase all pixels in bounding box (requires auth). Optional `space` param. Broadcasts deletions. |
| `POST` | `/admin/protect` | Protect pixels in a region — sets `protected: true`, PERSISTs key+subpixels, adds to `protected_tiles` set. Body: `{ n, s, e, w, space? }`. Returns `{ ok, protected, pixels }`. Broadcasts updated pixels to viewport. |
| `POST` | `/admin/unprotect` | Unprotect pixels by tile keys or region. Body: `{ tileKeys: [...], space? }` or `{ n, s, e, w, space? }`. Returns `{ ok, unprotected }`. Broadcasts updated pixels to viewport. |
| `POST` | `/admin/extend-ttl` | Extend pixel TTL to 30 days in a region. Body: `{ n, s, e, w, space? }`. Returns `{ ok, extended }`. |
| `GET` | `/admin/protected?space=` | List protected tile keys with pixel data. Optional `space` param. |
| `WS` | WebSocket connection | Real-time updates, painting, ping/pong, viewport subscription |

### WebSocket protocol

Connection: `wss://api.pixhood.art` (max 10 concurrent connections per IP). Origin header validated against allowlist (`pixhood.art`, `*.pixhood.art`, `localhost`, `127.0.0.1`). Connections without valid Origin rejected with 403 at handshake. Max WS payload 10KB.

**Space**: Client connects with `?space=<slug>` query param. Server stores `ws.space` on the connection (immutable for its lifetime). All broadcasts are scoped to clients in the same space. Client never sends space in per-message payloads.

**Server → Client:**
- `{ type: "pixel", data }` — pixel painted (viewport-scoped broadcast)
- `{ type: "child", data }` — child pixel painted (viewport-scoped broadcast)
- `{ type: "clearChildren", data: { parentId } }` — children erased (viewport-scoped broadcast)
- `{ type: "deletePixel", data: { id } }` — pixel deleted by revert or erase (viewport-scoped broadcast)
- `{ type: "pong" }` — heartbeat response
- `{ type: "session", sessionId }` — server-assigned session ID, sent when client has no valid session
- `{ type: "paintAck", id }` — paint/erase/undo acknowledged (sent to painting client only)
- `{ type: "paintError", id, reason, retryAfter? }` — paint/erase/undo rejected (`rate_limited`, `blocked`, `invalid_input`, `no_session`, `no_viewport`, `server_error`, `protected`)
- `{ type: "blocked" }` — session auto-reverted (sent to painting client only)
- `{ type: "undoResult", id, count }` — undo completed, confirms how many paint log entries were processed (sent to requesting client only)

**Client → Server:**
- `{ type: "ping" }` every 30s → server responds `{ type: "pong" }`
- `{ type: "viewport", bounds: { n, s, e, w }, sessionId: "sess_...", zoom: 17 }` on connect, reconnect, and each viewport refresh (with fetch margin). Server uses sessionId for paint logging and suspicion detection. Server validates viewport span against reported zoom.
- `{ type: "paintParent", id, tileKey, lat, lng, color }` — paint a parent pixel. `id` is a client-generated sequence number for ack correlation.
- `{ type: "paintChild", id, parentId, tileKey, subX, subY, lat, lng, color }` — paint a child pixel.
- `{ type: "paintErase", id, tileKey, lat, lng }` — erase (delete) a parent pixel and its children. No color field.
- `{ type: "undoPaint", id, count }` — undo last `count` paints by this session (1–50, clamped server-side; client caps at 20 and further to consecutive viewport paints). Debounced on the client with 500ms window.

Painting is optimistic: client renders immediately, sends WS message. Server responds with `paintAck` on success or `paintError` on failure. Client tracks pending paints with a 5-second timeout; on timeout or WS disconnect, shows a toast and triggers viewport refresh to correct visual state.

### Erase

Erasing is painting with the sentinel color `__erase__` (`CONFIG.ERASE_COLOR`). The client sends a `paintErase` WS message (no color field). The server deletes the pixel key, its sub-pixel hash, and removes it from the geo index. Previous state (color, children) is logged to the paint log for undoability. The server broadcasts `clearChildren` then `deletePixel` to clients in the viewport so they can remove rendered pixels.

### Undo

Client-side paint log (`_paintLog` array, max 20 entries, each with `lat`/`lng`) tracks recent paints on the client. On each paint, `recordPaint()` pushes to the log and updates the undo button state. On each viewport change (`moveend`/`zoomend`), `updateUndoButtonState()` recalculates how many paints are undoable.

**Viewport-aware undo counting**: `getViewportUndoCount()` scans the paint log from the tail (most recent), counting consecutive paints within the current viewport bounds. It stops at the first paint outside the viewport. This count determines the undo button's enabled/disabled state and the maximum undo count sent to the server. If no viewport paints are in the tail, the undo button is disabled (`opacity: 0.35`, `pointer-events: none`). This prevents undoing paints the user can't see.

**Button interactions**: The undo tile in the palette is debounced (500ms). On tap:
1. If viewport undo count is 0, tap is ignored (no flash, no toast, no WS message).
2. Button gets a background color pulse animation (`.undo-flash`, 250ms, auto-resets via `animationend`).
3. A count toast appears at the bottom of the screen showing "Undo 1", "Undo 2"... incrementing with rapid taps. Uses the stackable toast system with `.toast-undo` style (bold, semi-transparent background, border).
4. On debounce fire: capped count is recalculated against the latest viewport, screen flashes white (`.flash` on `#map-flash`, 200ms, 15% opacity), `undoPaint` WS message sent with `count: N`, paint log entries popped.

**Server-side**: The server pops the last `N` entries from the session's paint log (`paintlog:<sessionId>`) and restores each tile to its pre-paint state. Results broadcast via WS. Undo guarded by `revertingSessions` in-memory set to prevent concurrent undo.

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
- **Erase as sentinel color**: Erasing uses `__erase__` sentinel color (`CONFIG.ERASE_COLOR`). Client sends `paintErase` WS message without color field. Server deletes pixel key, sub-pixel hash, and geo entry. Previous state logged to paint log for undo.
- **Viewport-aware debounced undo**: Undo tile batches taps within 500ms window into a single `undoPaint` message with `count: N`. Client-side paint log (max 20 entries) tracks recent paints with lat/lng. Only consecutive paints from the tail within the current viewport count toward undo. Button disabled when 0 viewport paints. Button flashes on tap, count toast during debounce, screen flashes white on undo fire. Server pops N entries from paint log and restores tiles atomically. Guarded by `revertingSessions` in-memory set to prevent concurrent undo.
- **Erase broadcasts**: Server sends `clearChildren` before `deletePixel` so clients remove child renders first.
- **No build step**: prototype stays simple, `node index.js` and open browser.
- **Protection via pixel JSON**: `protected: true` field checked in paint handlers (already fetched via `getPixelRaw`, zero extra Redis calls). Redis Set `protected_tiles` used only for admin listing, not runtime checks.
- **TTL as enforcement**: Both protection and TTL extension use Redis TTL as the enforcement mechanism. Protected pixels have TTL -1 (PERSIST). Extended pixels have TTL > 24h (30 days). `getSubpixelsMulti` checks parent TTL to determine correct subpixels EXPIRE duration.
- **Neighbor-aware gold borders**: Protected pixels render gold polylines only on edges adjacent to non-protected pixels (4-direction neighbor check via `protectedSet`). This creates clean outlines around protected regions instead of per-pixel boxes.
- **Region mode reuse**: All three admin region operations (erase, protect, extend TTL) share a single generic `REGION_MODES` config and `activateRegionMode()`/`deactivateRegionMode()` functions, eliminating duplicated drawing/event code.

## Implementation notes

**WebSocket protocol:** Message type strings (`WS_TYPE_PING`, `WS_TYPE_PONG`, `WS_TYPE_VIEWPORT`, `WS_TYPE_PIXEL`, `WS_TYPE_CHILD`, `WS_TYPE_CLEAR_CHILDREN`, `WS_TYPE_DELETE_PIXEL`, `WS_TYPE_PAINT_PARENT`, `WS_TYPE_PAINT_CHILD`, `WS_TYPE_PAINT_ERASE`, `WS_TYPE_PAINT_ACK`, `WS_TYPE_PAINT_ERROR`, `WS_TYPE_BLOCKED`, `WS_TYPE_SESSION`, `WS_TYPE_UNDO_PAINT`, `WS_TYPE_UNDO_RESULT`) are defined in `shared/ws-types.js` as the single source of truth. The server requires it via `./shared/ws-types` (copied by predeploy script). The frontend `config.js` wraps them in `CONFIG`. Frontend `build.js` validates sync at build time — fails if types drift.

**Pipeline optimizations:** `getSubpixelsMulti(parentIds)` fetches all sub-pixel hashes in a single Redis pipeline (replaces N+1 sequential `HGETALL` calls in viewport endpoint). `checkWriteRateLimitsBatch(ip, sessionId, ...)` pipelines IP rate limit INCR+PEXPIRE with session burst/sustained ZCOUNT checks in one round-trip.

**Toast system:** `#toast-container` is a flex column-reverse container that stacks multiple `.toast-item` elements independently. Each toast has its own dismiss timer. `showToast(msg)` deduplicates by text content — if a toast with the same message already exists, its timer is reset instead of creating a duplicate. `showActionToast()` creates a separate item with action/dismiss buttons and returns a reference for targeted dismissal (e.g., PWA install flow dismisses only its own toast via `_dismissToastItem()`). Undo count toasts use `.toast-undo` style (bold, semi-transparent background, border).

**Client-side undo state:** The paint log (`_paintLog`, max 20 entries) tracks each paint with `lat`/`lng`. On each paint and on viewport changes (`moveend`/`zoomend`), `updateUndoButtonState()` toggles the `.disabled` class on the undo button based on `getViewportUndoCount()`. The paint log is in-memory only — page reloads clear it, so the undo button starts disabled after a refresh even if the server has paints to undo.

## Rate limiting and abuse prevention

### Paint log (`paintlog:<sessionId>`)

Every paint is logged with the previous pixel state for potential revert. The sorted set score is `Date.now()`, entries older than 24h are pruned on each write. The log serves dual purpose: sliding-window rate limiting (count entries in a time window) and audit trail for revert. Entries include `type` (`parent`, `child`, or `erase`), `space` field (for cross-space undo), and previous state (`previousColor`/`previousChildren` for parent/erase, `previousChildColor`/`previousSubX`/`previousSubY` for child).

### Rate limits

| Limiter | Threshold | Mechanism |
|---------|-----------|-----------|
| Per-session burst | 10 paints/sec | Paint log `ZCOUNT` in 1s window |
| Per-session sustained | 60 paints/min | Paint log `ZCOUNT` in 60s window |
| Per-IP per-space writes | 120/min | `INCR` + `EXPIRE` on `space:ratelimit:write:<ip>:<space>` |
| Per-IP reads | 300/min | `INCR` + `EXPIRE` on `ratelimit:read:<ip>` (global) |
| Per-IP space creation | 10/min | `INCR` + `EXPIRE` on `ratelimit:space_create:<ip>` |

Write rate limit checks use a single Redis pipeline (`checkWriteRateLimitsBatch`) combining INCR+PEXPIRE+ZREMRANGEBYSCORE+ZCOUNT×2 in one round-trip.

Rate-limited paints get a `paintError` WS message with `reason: "rate_limited"` and `retryAfter`. Frontend shows a toast. Invalid paint messages (bad tileKey, color, lat/lng, subX/subY) get `reason: "invalid_input"`.

### Suspicion detection

Three heuristic checks run on every paint (non-blocking — flags but doesn't reject):

1. **Viewport check** (`outside_viewport`): paint coordinates must fall within the session's last reported WS viewport ± 2× viewport span margin
2. **Distance check** (`excessive_distance`): consecutive paints from the same session must not exceed 1500 m/s speed (Haversine distance / time between paints). The first `excessive_distance` per session is forgiven via a free pass (resets after 5 minutes — matching the GPS cache duration). `excessive_distance` flags do not count toward the accumulated-flags auto-revert.
3. **Viewport plausibility** (`implausible_viewport`): viewport span must be consistent with the reported zoom level (max span = `360 / 2^(zoom-6)`). An implausibly large viewport suggests spoofed bounds.

Flagged sessions are stored in `flagged_sessions` Redis set and logged server-side with `[suspicion]` prefix.

### Paint rejection

Before any rate limit or suspicion check, paints (including erase and undo) are rejected early if:
- No session ID (`reason: "no_session"`)
- No viewport subscribed yet (`reason: "no_viewport"`) — forces bots to send viewport, making `outside_viewport` and `implausible_viewport` checks meaningful
- Session is blocked (`reason: "blocked"`)
- Pixel is protected (`reason: "protected"`) — protected pixels cannot be painted, erased, or have children added

Additionally, `revertSession` and `undoLastPaints` skip protected tiles (do not overwrite them). `deletePixelsInRegion` also skips protected pixels and returns a `skipped` count.

### Auto-revert

Triggered after logging a paint but before saving it. Three conditions, any one triggers immediate revert of all session paints + 1-hour block:

| Trigger | Threshold | Window |
|---------|-----------|--------|
| Extreme burst | >30 paints | 5 seconds |
| Impossible distance | >2km between consecutive paints outside viewport | 5 seconds |
| Accumulated flags | ≥3 non-excessive_distance suspicion flags | 10 minutes |

`excessive_distance` flags are excluded from the accumulated-flags count — only `outside_viewport` and `implausible_viewport` count toward the ≥3 threshold. The first `excessive_distance` per 5-minute window is forgiven entirely (free pass).

Blocked sessions have their paints reverted and receive `{ type: "blocked" }` WS message. Subsequent paints are silently rejected. Block expires after 1 hour (`blocked:<sessionId>` key with TTL). Double auto-reverts from concurrent paint handlers are prevented by an in-memory `revertingSessions` guard.

### Revert

`POST /admin/revert` restores all tiles painted by a session to their pre-session state. For each tile, the earliest log entry's `previousColor`/`previousChildren` (for parent/erase paints) or `previousChildColor` (for child paints) determines the restoration target. Changes are broadcast via WS.

### IP connection limit

Max 10 concurrent WS connections per IP (tracked via `wss.clients` iteration per connection). Legitimate multi-user households/cafes are fine; bot connection flooding is blocked.

### Admin auth

All `/admin/*` endpoints and HTTP paint endpoints (`POST /pixels`, `POST /pixels/child`) require `Authorization: Bearer <ADMIN_API_KEY>` header. Failed auth increments `admin_attempts:<ip>` counter. After 5 failures, IP is locked out for 15 minutes.

`POST /admin/verify` validates the token without side effects. Returns 403 if `ADMIN_API_KEY` is not configured.

### Security

- **Input validation**: `validatePaintParent()` and `validatePaintChild()` reject WS paint messages with invalid `tileKey` (must match `/^-?\d+(_-?\d+)+$/`), `color` (case-insensitive `/^#[0-9a-f]{6}$/`), `lat`/`lng` ranges, `subX`/`subY` (0–15). `handlePaintErase` validates `tileKey` and `lat`/`lng`. Rejected with `{type: "paintError", reason: "invalid_input"}`.
- **Request body size limit**: 10KB max for HTTP requests. WS `maxPayload: 10KB`. Exceeds → 413 (HTTP) or connection close (WS).
- **Timing-safe auth**: `timingSafeEqualStr()` using `crypto.timingSafeEqual` for admin token comparison, prevents timing attacks.
- **XSS protection**: Admin panel uses `escapeHtml()` and `safeColor()` for all user-controlled innerHTML. No raw string interpolation.
- **WS Origin validation**: `verifyClient` rejects connections from unauthorized origins at handshake level. Blocks connections without Origin header.
- **Session ref-counting**: `sessionRefCounts` Map ensures session state isn't destroyed when a single WS connection drops if the same session has other active connections.

### Admin panel

Activated via URL hash `#admin`. `admin.js` and `admin.css` are loaded dynamically (not fetched by regular users). Token stored in `sessionStorage` (cleared on tab close).

**Tools:**
- **Inspect mode**: Click any pixel to see its session ID, color, paint time, protection status (Protected/TTL extended), and children count. Session ID links to the inspector. Protected pixels show an "Unprotect" button. Mutually exclusive with region modes.
- **Protect Region**: Draw rectangle on map, confirm, marks all pixels in region as protected (permanent, no TTL, cannot be painted over). Gold dashed selection rectangle. Uses `POST /admin/protect`.
- **Extend TTL**: Draw rectangle on map, confirm, extends pixel TTL to 30 days in region. Blue dashed selection rectangle. Uses `POST /admin/extend-ttl`.
- **Region erase**: Draw rectangle on map, confirm, deletes all non-protected pixels in bounds via `DELETE /admin/region`. Red dashed selection rectangle. Broadcasts `deletePixel` for each. Skips protected pixels.
- **Sessions list**: "Load Active Sessions" button triggers `SCAN paintlog:*` in Redis. Shows paint count, relative time, locate button (pans map to last paint location at zoom 20).
- **Session inspector**: Enter or click a session ID to view paint log with click-to-pan. "Revert All Paints" button calls `POST /admin/revert`.
- **Flagged sessions**: Collapsible section, shows sessions flagged for suspicious activity with one-click revert.

No IP addresses shown anywhere in the admin UI.

## Protection and TTL extension

### Protected pixels

Admin-protected pixels that cannot be painted over, erased, or have children added. Used for preserving art or preventing vandalism in sensitive areas.

**Data model**: `protected: true` field in pixel JSON (authoritative for checks). `protected_tiles` Redis Set per-space (`space:<slug>:protected_tiles`) for admin listing. Pixel key is `PERSIST`ed (no TTL, permanent). Subpixels hash is also `PERSIST`ed.

**Paint rejection**: `handlePaintParent`, `handlePaintChild`, and `handlePaintErase` check `prevPixel.protected` after fetching `getPixelRaw`. Zero extra Redis calls for parent/erase (pixel already fetched); one extra `getPixelRaw` call for child paints. Rejected with `paintError { reason: 'protected' }`.

**Frontend rendering**: Protected pixels display a gold border (`#FFD700`, weight 2px) using `L.polyline` edge segments. Only outer edges are drawn — if a protected pixel's neighbor is also protected, the shared interior edge is skipped. `protectedSet` (JS `Set`) tracks which tile keys are protected. `renderProtectedBorders()` checks 4 neighbors for each protected pixel and draws edge polylines for non-protected sides. Borders are visible at zoom ≥ 16 only. Toast "This pixel is protected" shown on rejected paint attempts.

**Subpixels**: `getSubpixelsMulti` uses a two-pipeline approach — HGETALL + TTL per parent, then conditional EXPIRE: protected parents (TTL -1) → PERSIST subpixels; extended parents (TTL > 24h) → use parent's remaining TTL; default → 24h EXPIRE.

**Admin operations**:
- `POST /admin/protect` — region protect: finds all pixels in bounds, adds `protected: true`, PERSISTs keys + subpixels, adds to `protected_tiles` set. Broadcasts updated pixels to viewport.
- `POST /admin/unprotect` — removes `protected` field, sets 24h EXPIRE, removes from set. Broadcasts updated pixels. Available in inspect popup per-pixel and as region operation.
- `GET /admin/protected` — lists all protected tiles. Cleans stale entries (removes set members where pixel key missing or `protected` field absent).

**Skip protection**: `revertSession`, `undoLastPaints`, and `deletePixelsInRegion` skip protected pixels (check `currentPixel.protected` before restoring).

### TTL extension

Extends pixel TTL from 24h to 30 days (`TTL_EXTENDED = 2592000`). Not protected — painting over resets to default 24h TTL. Cannot be cancelled (expires naturally or painted over).

**Data model**: `ttlExtended: true` and `ttlExpiresAt` (ISO timestamp) fields in pixel JSON. Parent and subpixels keys get 30-day EXPIRE. Since `savePixel` and `saveChildPixel` always set 24h TTL, painting over naturally cancels the extension — no special handling needed in paint handlers.

**Frontend rendering**: Subtle blue border (`rgba(100,150,255,0.4)`, weight 1px) visible only when admin panel is open. Checked via `document.getElementById('admin-panel')`.

**Admin operations**:
- `POST /admin/extend-ttl` — region extend: finds all pixels in bounds, adds `ttlExtended` + `ttlExpiresAt`, EXPIREs to 30 days. No viewport broadcast needed.
- No un-extend operation — expires naturally or painted over.

### Admin UI region modes

All three region operations (erase, protect, extend TTL) share a single `REGION_MODES` config object and generic `activateRegionMode(key)` / `deactivateRegionMode()` functions. Each mode defines its own rectangle style, confirm text, API endpoint, and result formatter. The shared handlers (`onRegionDrawStart/Move/End`) handle rectangle drawing, dimension display, and confirmation.

## Out of scope (prototype)

User accounts, pixel ownership, social features, mobile app.

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `PORT` | `3000` | HTTP server port |
| `CORS_ORIGIN` | `http://localhost:{PORT}` | CORS allowed origin |
| `ADMIN_API_KEY` | — | Bearer token for `/admin/*` endpoints |
