# Pixhood

Geo-anchored pixel art web app. Users paint colored pixels tied to real-world coordinates. Think r/place meets Google Maps — local-first, collaborative, launched initially in Berlin.

## Architecture

**Frontend**: Vanilla JS, no framework, no build step. Leaflet.js (CDN) for the map. Native browser `WebSocket` + `fetch` for backend communication.

**Backend**: Node.js HTTP server (`server/index.js`) with native WebSocket via `ws` package. Serves static files and the REST API.

**Storage**: Redis — pixels as individual String keys with 24h TTL, sub-pixels as Hashes per parent tile, geo sorted set for viewport queries.

**Real-time**: Server broadcasts every pixel/child write to all connected WebSocket clients. Client sends heartbeat pings every 30s.

## Running locally

```bash
cd server
npm install
REDIS_URL=redis://localhost:6379 node index.js
# open http://localhost:3000
```

For dev with auto-restart:
```bash
REDIS_URL=redis://localhost:6379 npm run dev
```

## File structure

```
pixhood/
├── server/
│   ├── index.js      # HTTP + WebSocket server, viewport API, child pixel API
│   ├── redis.js      # Redis client, geo-indexed queries, TTL management
│   └── package.json
├── index.html        # Entry point, loads Leaflet CDN + app scripts
├── style.css
├── config.js         # Constants: API_URL, WS_URL, TILE_SIZE, SUB_GRID_SIZE, palette
├── grid.js           # Tile + sub-tile key computation, snapToTile(), snapToSubTile()
├── pixels.js         # Viewport fetch, child pixel write, WebSocket + heartbeat
├── map.js            # Leaflet map init, renderPixel(), sub-grid rendering
└── app.js            # Bootstrap: geolocation, color picker, viewport refresh wiring
```

Script load order in `index.html` matters: `config → grid → pixels → map → app`.

## Grid system

World is divided into ~10m × 10m tiles. Tile key is computed by snapping lat/lng to grid:

```js
tileKey = `${Math.floor(lat / TILE_SIZE)}_${Math.floor(lng / LNG_STEP)}`
```

`TILE_SIZE = 0.0001` degrees (~10m). `LNG_STEP` is cos-corrected for latitude. One pixel per tile, last painter wins.

### Sub-grid (zoom ≥ 19)

Each tile can contain a 16×16 sub-grid of child pixels. Sub-tile keys: `${parentKey}_${subX}_${subY}`.

- Painting a **parent** erases all its children.
- Painting a **child** updates parent color to the average of all children colors. Parent's own color is ignored when children exist.
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

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/pixels?n=&s=&e=&w=&zoom=` | Viewport query: pixels in bounding box. At zoom ≥ 19 includes children. |
| `POST` | `/pixels` | Save parent pixel, erase children, broadcast |
| `POST` | `/pixels/child` | Save child pixel, update parent color, broadcast |
| `GET` | `/*` | Serve static files from project root |

WebSocket: `ws://localhost:3000`
- Server pushes: `{ type: "pixel" }`, `{ type: "child" }`, `{ type: "clearChildren" }`
- Client sends: `{ type: "ping" }` every 30s → server responds `{ type: "pong" }`

## Key decisions

- **Individual keys with TTL** over single hash: natural Redis expiry, no manual cleanup.
- **Geo sorted set**: `GEOSEARCH` for efficient viewport bounding-box queries with lazy stale cleanup.
- **Hash per parent for sub-pixels**: always accessed as a group, `HGETALL` is efficient, whole-set expiry via TTL.
- **Native WebSocket over Socket.io**: fewer dependencies, sufficient for broadcast-only real-time.
- **No build step**: prototype stays simple, `node index.js` and open browser.

## Out of scope (prototype)

User accounts, pixel ownership, undo/erase, rate limiting, abuse prevention, social features, mobile app.

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `PORT` | `3000` | HTTP server port |
| `CORS_ORIGIN` | `http://localhost:{PORT}` | CORS allowed origin |
