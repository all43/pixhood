#!/usr/bin/env node
// TEMP SCRIPT — paint subpixel gradient near Brandenburg Gate for screenshots
// Creates a smooth rainbow gradient using 16×16 subpixels across 4 adjacent tiles
// Usage: node scripts/paint-gradient.js [--dry-run] [--api-url URL] [--delay MS]
// All pixels expire in 24h (Redis TTL)

const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (arg === '--dry-run') acc.dryRun = true;
  if (arg === '--api-url' && arr[i + 1]) acc.apiUrl = arr[i + 1];
  if (arg === '--delay' && arr[i + 1]) acc.delay = parseInt(arr[i + 1]);
  return acc;
}, { dryRun: false, apiUrl: 'https://api.pixhood.art', delay: 10 });

const TILE_SIZE_M = 18.4;
const SUB_GRID = 16;
const R = 20037508.34;
const SESSION_ID = 'grad_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);

const lngToX = lng => lng * R / 180;
const latToY = lat => Math.log(Math.tan((90 + lat) * Math.PI / 360)) * R / Math.PI;
const xToLng = x => x * 180 / R;
const yToLat = y => Math.atan(Math.exp(y * Math.PI / R)) * 360 / Math.PI - 90;

function tileAt(lat, lng) {
  const tx = Math.floor(lngToX(lng) / TILE_SIZE_M);
  const ty = Math.floor(latToY(lat) / TILE_SIZE_M);
  return {
    lat: yToLat(ty * TILE_SIZE_M),
    lng: xToLng(tx * TILE_SIZE_M),
    key: `${tx}_${ty}`,
    tx, ty,
  };
}

function tileBounds(key) {
  const [tx, ty] = key.split('_').map(Number);
  return {
    sw: [yToLat(ty * TILE_SIZE_M), xToLng(tx * TILE_SIZE_M)],
    ne: [yToLat((ty + 1) * TILE_SIZE_M), xToLng((tx + 1) * TILE_SIZE_M)],
  };
}

function hslToHex(h, s, l) {
  h /= 360;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  const toHex = v => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

// Place gradient south of the main art cluster (Brandenburg Gate area)
const GRADIENT_LAT = 52.5105;
const GRADIENT_LNG = 13.3770;
const TILE_COUNT = 4; // 4 tiles in a horizontal row

async function paintParent(pixel) {
  const res = await fetch(`${args.apiUrl}/pixels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: pixel.key,
      lat: pixel.lat,
      lng: pixel.lng,
      color: '#888888',
      paintedAt: new Date().toISOString(),
      sessionId: SESSION_ID,
    }),
  });
  if (!res.ok) throw new Error(`Parent failed: ${res.status}`);
}

async function paintChild(parentKey, subX, subY, lat, lng, color) {
  const res = await fetch(`${args.apiUrl}/pixels/child`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parentId: parentKey,
      childKey: `${parentKey}_${subX}_${subY}`,
      childPixel: {
        id: `${parentKey}_${subX}_${subY}`,
        parentId: parentKey,
        subX,
        subY,
        lat,
        lng,
        color,
        paintedAt: new Date().toISOString(),
        sessionId: SESSION_ID,
      },
    }),
  });
  if (!res.ok) throw new Error(`Child failed: ${res.status}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const startTile = tileAt(GRADIENT_LAT, GRADIENT_LNG);
  console.log(`Start tile: ${startTile.key} (${startTile.lat.toFixed(6)}, ${startTile.lng.toFixed(6)})`);

  const tiles = [];
  for (let i = 0; i < TILE_COUNT; i++) {
    const tx = startTile.tx + i;
    const ty = startTile.ty;
    tiles.push({
      key: `${tx}_${ty}`,
      lat: yToLat(ty * TILE_SIZE_M),
      lng: xToLng(tx * TILE_SIZE_M),
      tx, ty,
    });
  }

  const totalChildren = TILE_COUNT * SUB_GRID * SUB_GRID;
  console.log(`Gradient: ${TILE_COUNT} tiles × ${SUB_GRID}×${SUB_GRID} subpixels = ${totalChildren} children`);
  console.log(`Hue range: 0° (red) → 240° (blue)\n`);

  if (args.dryRun) {
    console.log('--- Dry run ---');
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      console.log(`Tile ${i}: ${t.key} lat=${t.lat.toFixed(6)} lng=${t.lng.toFixed(6)}`);
      for (let sx = 0; sx < SUB_GRID; sx++) {
        const globalX = i * SUB_GRID + sx;
        const hue = (globalX / (TILE_COUNT * SUB_GRID)) * 240;
        const hex = hslToHex(hue, 1.0, 0.5);
        if (sx < 3 || sx >= SUB_GRID - 2) {
          console.log(`  subX=${String(sx).padStart(2)} → hue=${hue.toFixed(1).padStart(5)}° ${hex}`);
        } else if (sx === 3) {
          console.log(`  ... (12 more columns) ...`);
        }
      }
    }
    return;
  }

  // Step 1: paint parent tiles
  console.log('Painting parent tiles...');
  for (const tile of tiles) {
    await paintParent(tile);
    console.log(`  ✓ ${tile.key}`);
    if (args.delay > 0) await sleep(args.delay);
  }

  // Step 2: paint all child subpixels
  console.log(`\nPainting ${totalChildren} subpixels...`);
  let painted = 0;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const bounds = tileBounds(tile.key);
    const latSpan = bounds.ne[0] - bounds.sw[0];
    const lngSpan = bounds.ne[1] - bounds.sw[1];

    for (let sy = 0; sy < SUB_GRID; sy++) {
      for (let sx = 0; sx < SUB_GRID; sx++) {
        const globalX = i * SUB_GRID + sx;
        const hue = (globalX / (TILE_COUNT * SUB_GRID)) * 240;
        const color = hslToHex(hue, 1.0, 0.5);
        const subLat = bounds.sw[0] + sy * (latSpan / SUB_GRID);
        const subLng = bounds.sw[1] + sx * (lngSpan / SUB_GRID);

        try {
          await paintChild(tile.key, sx, sy, subLat, subLng, color);
          painted++;
          process.stdout.write(`\r  ✓ ${painted}/${totalChildren}`);
        } catch (e) {
          console.error(`\n  ✗ ${tile.key} sub(${sx},${sy}): ${e.message}`);
        }
        if (args.delay > 0) await sleep(args.delay);
      }
    }
  }

  console.log(`\n\nDone! Painted ${painted} subpixels. Session: ${SESSION_ID}`);
  console.log('View at zoom ≥ 21: https://pixhood.art');
}

main().catch(e => { console.error(e); process.exit(1); });
