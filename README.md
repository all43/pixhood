# Pixhood

Paint colored pixels on a real map. Your neighborhood, in pixels.

> Think r/place meets Google Maps — geo-anchored, collaborative, no accounts needed.

---

## What it does

- Open the app → welcome screen explains why location access is useful, then asks permission
- Map centers on your location (Berlin fallback)
- Pick a color, click anywhere on the map → paint a pixel there
- Pixels are tied to real-world coordinates on a Mercator-corrected square grid (~10×10m)
- Everyone sees each other's pixels in real time via WebSocket
- Dark basemap (CartoDB Dark Matter) with subtle grid overlay visible at zoom 16+

---

## Stack

- **Frontend** — Vanilla JS, Leaflet.js, native WebSocket
- **Backend** — Node.js, [`ws`](https://github.com/websockets/ws)
- **Storage** — Redis (Hash: `tileKey → pixel JSON`)
- **Basemap** — CartoDB Dark Matter (nolabels)
- No framework, no build step

---

## Running locally

**Prerequisites**: Node.js 18+, a running Redis instance ([Redis Cloud free tier](https://redis.io/cloud/) or local `redis-server`)

```bash
git clone git@github.com:all43/pixhood.git
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

### Grid

The world is divided into a fixed grid of ~10×10m tiles. Because longitude converges toward the poles, a naive `0.0001°` step produces rectangles, not squares. At Berlin's latitude (52.52°N), `0.0001°` lat ≈ 11.1m but `0.0001°` lng ≈ 6.7m.

Fix: longitude step is corrected with `LNG_STEP = TILE_SIZE / cos(lat)`, using Berlin's latitude as a fixed constant. This keeps tiles square and the grid aligned without per-row stepping artifacts.

```
TILE_SIZE = 0.0001                          (~11.1m in latitude)
LNG_STEP  = 0.0001 / cos(52.52°)           (~11.1m in longitude at Berlin)
```

### Tile keys

```js
tileKey = `${Math.floor(lat / TILE_SIZE)}_${Math.floor(lng / LNG_STEP)}`
```

Each tile holds exactly one color — last painter wins.

### Data flow

1. Page load → `loadAllPixels()` fetches all pixels from `GET /pixels`
2. User picks color, clicks map → `writePixel()` sends `POST /pixels`
3. Server saves to Redis and broadcasts to all WebSocket clients
4. Connected clients render the new pixel immediately

Sessions are anonymous — a UUID is generated and stored in `localStorage`. No sign-up, no accounts.

---

## Project structure

```
pixhood/
├── server/
│   ├── index.js      # HTTP server, WebSocket broadcast, static files, CORS
│   ├── redis.js      # Redis client: savePixel (HSET), getAllPixels (HGETALL)
│   ├── fly.toml      # Fly.io: 256MB VM, auto-stop, fra region
│   ├── Dockerfile
│   └── package.json  # redis, ws dependencies
├── index.html        # Welcome screen, loading spinner, location banner, toast
├── style.css         # All styles: topbar, palette, map, pin, welcome, mobile
├── config.js         # TILE_SIZE, LNG_STEP, palette, API/WS URLs
├── grid.js           # tileKey(), snapToTile(), tileBounds()
├── pixels.js         # fetch + WebSocket client, session identity
├── map.js            # Leaflet map, grid overlay, pixel rendering, locate button
└── app.js            # Init flow, geolocation (3-state preference), color picker
```

Script load order in `index.html` matters: `config → grid → pixels → map → app`.

---

## Deploying

Frontend on **Cloudflare Pages**, backend on **Fly.io** with managed Upstash Redis.

### Prerequisites

- [`flyctl`](https://fly.io/docs/hands-on/install-flyctl/) — `brew install flyctl && fly auth login`
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/) — `npm i -g wrangler && wrangler login`

### 1. Backend (Fly.io)

```bash
cd server
fly launch --name pixhood --region fra --no-deploy --yes
# ↳ auto-provisions Upstash Redis and sets REDIS_URL

fly secrets set CORS_ORIGIN=https://pixhood.pages.dev
fly deploy
```

Backend is now live at `https://pixhood.fly.dev`.

> If Fly picked a different app name, update the two `pixhood.fly.dev` references in `config.js`.

### 2. Frontend (Cloudflare Pages)

```bash
cd ..   # repo root
wrangler pages project create pixhood --production-branch main
wrangler pages deploy . --project-name pixhood --branch main
```

Frontend is now live at `https://pixhood.pages.dev`.

### Re-deploying

```bash
# Backend (from server/)
fly deploy --remote-only

# Frontend (from repo root)
npx wrangler pages deploy . --project-name=pixhood --branch=main
```

### Environment variables

| Where | Variable | Description |
|-------|----------|-------------|
| Fly.io | `REDIS_URL` | Set automatically by `fly launch` |
| Fly.io | `CORS_ORIGIN` | Cloudflare Pages URL (e.g. `https://pixhood.pages.dev`) |
| Fly.io | `PORT` | Defaults to `3000` |

---

## Known limitations

- **All pixels are fetched globally** — `GET /pixels` returns every pixel in Redis regardless of viewport. Needs viewport-based filtering (`bbox`) to scale.
- **No pixel expiry** — pixels persist indefinitely. Planned: switch to `SET` with TTL for daily-reset canvas.
- **No rate limiting** — a single client can spam paints.
- **Berlin-optimized grid** — `LNG_STEP` is calibrated for Berlin's latitude. Tiles will be slightly non-square at other latitudes.

---

## Prototype scope

This is a minimal working prototype. Out of scope:

- User accounts or pixel ownership
- Rate limiting or abuse prevention
- Undo / erase
- Social features
- Mobile app
