# Pixhood

Geo-anchored pixel art web app. Users paint colored pixels tied to real-world coordinates. Think r/place meets Google Maps — local-first, collaborative, launched initially in Berlin.

## Architecture

**Frontend**: Vanilla JS, no framework, no build step. Leaflet.js (CDN) for the map. Native browser `WebSocket` + `fetch` for backend communication.

**Backend**: Node.js HTTP server (`server/index.js`) with native WebSocket via `ws` package. Serves static files and the REST API.

**Storage**: Redis — pixels stored as a single Hash (`HSET pixels <tileKey> <JSON>`).

**Real-time**: Server broadcasts every pixel write to all connected WebSocket clients.

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
│   ├── index.js      # HTTP + WebSocket server, static file serving
│   ├── redis.js      # Redis client, savePixel / getAllPixels
│   └── package.json
├── index.html        # Entry point, loads Leaflet CDN + app scripts
├── style.css
├── config.js         # Constants: API_URL, WS_URL, TILE_SIZE, palette
├── grid.js           # Tile key computation, snapToTile()
├── pixels.js         # fetch + WebSocket client logic
├── map.js            # Leaflet map init, renderPixel(), removePixel()
└── app.js            # Bootstrap: geolocation, color picker, wiring
```

Script load order in `index.html` matters: `config → grid → pixels → map → app`.

## Grid system

World is divided into ~10m × 10m tiles. Tile key is computed by snapping lat/lng to grid:

```js
tileKey = `${Math.floor(lat / TILE_SIZE)}_${Math.floor(lng / TILE_SIZE)}`
```

`TILE_SIZE = 0.0001` degrees (~10m). One pixel per tile, last painter wins.

## Data model

```json
{
  "id": "525200_130450",
  "lat": 52.5200,
  "lng": 13.4050,
  "color": "#FF0000",
  "paintedAt": "2026-04-10T12:00:00.000Z",
  "sessionId": "sess_abc123"
}
```

No user accounts — sessions are anonymous UUIDs in `localStorage`.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/pixels` | Return all pixels as JSON array |
| `POST` | `/pixels` | Save a pixel, broadcast to WS clients |
| `GET` | `/*` | Serve static files from project root |

WebSocket: `ws://localhost:3000` — server pushes `{ type: "pixel", data: {...} }` on every write.

## Key decisions

- **Redis over Firestore**: natural key-value fit for tile→pixel, native geospatial commands available for future viewport queries, no vendor lock-in.
- **Native WebSocket over Socket.io**: fewer dependencies, sufficient for broadcast-only real-time.
- **No build step**: prototype stays simple, `node index.js` and open browser.

## Out of scope (prototype)

User accounts, pixel ownership, undo/erase, rate limiting, abuse prevention, social features, mobile app.

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `PORT` | `3000` | HTTP server port |
