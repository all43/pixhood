# Pixhood

Paint colored pixels on a real map. Your neighborhood, in pixels.

> Think r/place meets Google Maps — geo-anchored, collaborative, no accounts needed.

![Pixhood UI](https://placeholder)

---

## What it does

- Open the app → map centers on your location (Berlin fallback)
- Pick a color, click anywhere on the map → paint a pixel there
- Pixels are tied to real-world coordinates (~10×10m grid)
- Everyone sees each other's pixels in real time
- Persists after refresh

---

## Stack

- **Frontend** — Vanilla JS, Leaflet.js, native WebSocket
- **Backend** — Node.js, [`ws`](https://github.com/websockets/ws)
- **Storage** — Redis (single Hash: `tileKey → pixel JSON`)
- No framework, no build step

---

## Running locally

**Prerequisites**: Node.js 18+, a running Redis instance ([Redis Cloud free tier](https://redis.io/cloud/) or local `redis-server`)

```bash
git clone <repo>
cd pixhood/server
npm install
REDIS_URL=redis://localhost:6379 node index.js
```

Open [http://localhost:3000](http://localhost:3000).

For auto-restart during development:
```bash
REDIS_URL=redis://localhost:6379 npm run dev
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `PORT` | `3000` | HTTP server port |

---

## How it works

The world is divided into a fixed grid of ~10×10m tiles. Each tile holds exactly one color — last painter wins.

A tile key is derived from lat/lng:
```
tileKey = `${Math.floor(lat / 0.0001)}_${Math.floor(lng / 0.0001)}`
```

Pixels are stored in Redis as a single Hash (`HSET pixels <tileKey> <json>`). On page load, all pixels are fetched via `GET /pixels`. New paints are written via `POST /pixels` and broadcast to all connected clients over WebSocket.

Sessions are anonymous — a UUID is generated and stored in `localStorage`. No sign-up, no accounts.

---

## Project structure

```
pixhood/
├── server/
│   ├── index.js      # HTTP server + WebSocket broadcast
│   ├── redis.js      # Redis read/write
│   └── package.json
├── index.html
├── style.css
├── config.js         # TILE_SIZE, palette, URLs
├── grid.js           # snapToTile(), tileKey()
├── pixels.js         # fetch + WebSocket client
├── map.js            # Leaflet map, pixel rendering
└── app.js            # Init, color picker, geolocation
```

---

## Prototype scope

This is a minimal working prototype. Out of scope:

- User accounts or pixel ownership
- Rate limiting or abuse prevention
- Undo / erase
- Social features
- Mobile app
