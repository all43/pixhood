#!/usr/bin/env node
// TEMP SCRIPT — paint pixel art near Brandenburg Gate for screenshots
// Usage: node scripts/paint-art.js [--dry-run] [--api-url URL] [--delay MS]
// All pixels expire in 24h (Redis TTL)

const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (arg === '--dry-run') acc.dryRun = true;
  if (arg === '--api-url' && arr[i + 1]) acc.apiUrl = arr[i + 1];
  if (arg === '--delay' && arr[i + 1]) acc.delay = parseInt(arr[i + 1]);
  return acc;
}, { dryRun: false, apiUrl: 'https://api.pixhood.art', delay: 50 });

const TILE_SIZE_M = 18.4;
const R = 20037508.34;
const SESSION_ID = 'art_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);

const lngToX = lng => lng * R / 180;
const latToY = lat => Math.log(Math.tan((90 + lat) * Math.PI / 360)) * R / Math.PI;
const xToLng = x => x * 180 / R;
const yToLat = y => Math.atan(Math.exp(y * Math.PI / R)) * 360 / Math.PI - 90;

function tileFromOffset(centerLat, centerLng, dtx, dty) {
  const tx = Math.floor(lngToX(centerLng) / TILE_SIZE_M) + dtx;
  const ty = Math.floor(latToY(centerLat) / TILE_SIZE_M) + dty;
  return { lat: yToLat(ty * TILE_SIZE_M), lng: xToLng(tx * TILE_SIZE_M), key: `${tx}_${ty}` };
}

const _ = null;
const RED = '#FF0000', ORA = '#FF8800', YEL = '#FFFF00', GRN = '#00FF00';
const DGR = '#448800', BLK = '#000000', WHT = '#FFFFFF', GRY = '#888888';
const BLU = '#0088FF', BRN = '#884400', PNK = '#FF0088';

const HEART = [
  [_,   RED, _,   RED, _  ],
  [RED, RED, RED, RED, RED],
  [RED, RED, RED, RED, RED],
  [_,   RED, RED, RED, _  ],
  [_,   _,   RED, _,   _  ],
];

const TREE = [
  [_,   _,   DGR, _,   _  ],
  [_,   DGR, DGR, DGR, _  ],
  [DGR, DGR, DGR, DGR, DGR],
  [_,   DGR, DGR, DGR, _  ],
  [_,   DGR, DGR, DGR, _  ],
  [_,   _,   BRN, _,   _  ],
  [_,   _,   BRN, _,   _  ],
];

const STAR = [
  [_,   _,   _,   _,   YEL, _,   _,   _,   _  ],
  [_,   _,   _,   YEL, YEL, YEL, _,   _,   _  ],
  [_,   _,   YEL, YEL, YEL, YEL, YEL, _,   _  ],
  [_,   YEL, YEL, YEL, YEL, YEL, YEL, YEL, _  ],
  [YEL, YEL, YEL, YEL, YEL, YEL, YEL, YEL, YEL],
  [_,   YEL, YEL, YEL, YEL, YEL, YEL, YEL, _  ],
  [_,   _,   YEL, YEL, YEL, YEL, YEL, _,   _  ],
  [_,   _,   _,   YEL, YEL, YEL, _,   _,   _  ],
  [_,   _,   _,   _,   YEL, _,   _,   _,   _  ],
];

const SMILEY = [
  [_,   _,   YEL, YEL, YEL, _,   _  ],
  [_,   YEL, YEL, YEL, YEL, YEL, _  ],
  [YEL, YEL, BLK, YEL, BLK, YEL, YEL],
  [YEL, YEL, YEL, YEL, YEL, YEL, YEL],
  [YEL, BLK, YEL, YEL, YEL, BLK, YEL],
  [_,   YEL, BLK, BLK, BLK, YEL, _  ],
  [_,   _,   YEL, YEL, YEL, _,   _  ],
];

const CAT = [
  [ORA, _,   _,   _,   _,   _,   ORA],
  [ORA, ORA, _,   _,   _,   ORA, ORA],
  [_,   ORA, ORA, ORA, ORA, ORA, _  ],
  [_,   ORA, BLK, ORA, BLK, ORA, _  ],
  [_,   ORA, ORA, ORA, ORA, ORA, _  ],
  [_,   _,   ORA, PNK, ORA, _,   _  ],
  [_,   ORA, _,   ORA, _,   ORA, _  ],
];

const HOUSE = [
  [_,   _,   _,   _,   RED, _,   _,   _,   _  ],
  [_,   _,   _,   RED, RED, RED, _,   _,   _  ],
  [_,   _,   RED, RED, RED, RED, RED, _,   _  ],
  [_,   RED, RED, RED, RED, RED, RED, RED, _  ],
  [BLU, BLU, BLU, BLU, BLU, BLU, BLU, BLU, BLU],
  [BLU, BLU, WHT, BLU, BLU, BLU, WHT, BLU, BLU],
  [BLU, BLU, WHT, BLU, BLU, BLU, WHT, BLU, BLU],
  [BLU, BLU, BLU, BLU, BRN, BLU, BLU, BLU, BLU],
  [BLU, BLU, BLU, BLU, BRN, BLU, BLU, BLU, BLU],
];

const ROCKET = [
  [_,   _,   _,   RED, _,   _,   _  ],
  [_,   _,   RED, RED, RED, _,   _  ],
  [_,   _,   RED, WHT, RED, _,   _  ],
  [_,   _,   WHT, WHT, WHT, _,   _  ],
  [_,   _,   WHT, WHT, WHT, _,   _  ],
  [_,   _,   WHT, WHT, WHT, _,   _  ],
  [_,   _,   WHT, WHT, WHT, _,   _  ],
  [RED, RED, WHT, WHT, WHT, RED, RED],
  [_,   _,   WHT, WHT, WHT, _,   _  ],
  [_,   _,   _,   ORA, _,   _,   _  ],
  [_,   _,   ORA, ORA, ORA, _,   _  ],
];

const DUCK = [
  [_,   _,   _,   YEL, _,   _,   _,   _,   _  ],
  [_,   _,   YEL, YEL, YEL, _,   _,   _,   _  ],
  [_,   _,   YEL, ORA, ORA, ORA, _,   _,   _  ],
  [_,   YEL, YEL, YEL, YEL, YEL, _,   _,   _  ],
  [YEL, YEL, YEL, YEL, YEL, YEL, YEL, _,   _  ],
  [_,   YEL, YEL, YEL, YEL, YEL, YEL, _,   _  ],
  [_,   _,   YEL, YEL, YEL, YEL, _,   _,   _  ],
  [_,   _,   _,   _,   YEL, _,   _,   _,   _  ],
];

const DBL = '#004488';
const AIRPLANE = [
  [_,   _,   _,   _,   GRY, GRY, GRY, _,   _,   _,   _,   _,   _  ],
  [_,   _,   _,   GRY, GRY, GRY, GRY, GRY, _,   _,   _,   _,   _  ],
  [_,   _,   _,   GRY, GRY, WHT, GRY, GRY, _,   _,   _,   _,   _  ],
  [_,   _,   _,   GRY, GRY, GRY, GRY, GRY, _,   _,   _,   _,   _  ],
  [_,   _,   _,   GRY, GRY, GRY, GRY, GRY, _,   _,   _,   _,   _  ],
  [_,   _,   _,   GRY, GRY, GRY, GRY, GRY, _,   _,   _,   _,   _  ],
  [WHT, WHT, WHT, WHT, WHT, WHT, WHT, WHT, WHT, WHT, WHT, WHT, WHT],
  [_,   WHT, WHT, WHT, WHT, WHT, WHT, WHT, WHT, WHT, WHT, WHT, _  ],
  [_,   _,   DBL, _,   GRY, GRY, GRY, _,   GRY, _,   _,   _,   _  ],
  [_,   _,   _,   _,   GRY, GRY, GRY, _,   _,   _,   _,   _,   _  ],
  [_,   _,   _,   _,   GRY, GRY, GRY, _,   _,   _,   _,   _,   _  ],
  [_,   _,   _,   _,   GRY, GRY, GRY, _,   _,   _,   _,   _,   _  ],
  [_,   _,   _,   _,   GRY, GRY, GRY, _,   _,   _,   _,   _,   _  ],
  [_,   _,   _,   WHT, WHT, WHT, WHT, WHT, WHT, _,   _,   _,   _  ],
  [_,   _,   _,   _,   GRY, GRY, GRY, _,   _,   _,   _,   _,   _  ],
  [_,   _,   _,   _,   GRY, GRY, GRY, _,   _,   _,   _,   _,   _  ],
];

const CENTER_LAT = 52.51830;
const CENTER_LNG = 13.37770;

const placements = [
  { name: 'Heart',    pattern: HEART,    dtx: -12, dty:  -5 },
  { name: 'Tree',     pattern: TREE,     dtx:  -3, dty: -16 },
  { name: 'Star',     pattern: STAR,     dtx:  10, dty: -12 },
  { name: 'Smiley',   pattern: SMILEY,   dtx:   2, dty:  -2 },
  { name: 'Cat',      pattern: CAT,      dtx:   8, dty:   5 },
  { name: 'Rocket',   pattern: ROCKET,   dtx: -14, dty:   8 },
  { name: 'House',    pattern: HOUSE,    dtx: -10, dty:  16 },
  { name: 'Duck',     pattern: DUCK,     dtx:  16, dty:  10 },
  { name: 'Airplane', pattern: AIRPLANE, dtx:  35, dty:   0 },
];

function patternToPixels(pattern, centerLat, centerLng, dtxCenter, dtyCenter) {
  const pixels = [];
  const halfW = Math.floor(pattern[0].length / 2);
  const halfH = Math.floor(pattern.length / 2);
  for (let row = 0; row < pattern.length; row++) {
    for (let col = 0; col < pattern[row].length; col++) {
      if (pattern[row][col]) {
        const dtx = dtxCenter + (col - halfW);
        const dty = dtyCenter - (row - halfH);
        const tile = tileFromOffset(centerLat, centerLng, dtx, dty);
        pixels.push({ ...tile, color: pattern[row][col] });
      }
    }
  }
  return pixels;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function paintPixel(pixel) {
  const body = {
    id: pixel.key,
    lat: pixel.lat,
    lng: pixel.lng,
    color: pixel.color,
    paintedAt: new Date().toISOString(),
    sessionId: SESSION_ID,
  };
  const res = await fetch(`${args.apiUrl}/pixels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const allPixels = [];
  for (const { name, pattern, dtx, dty } of placements) {
    const pixels = patternToPixels(pattern, CENTER_LAT, CENTER_LNG, dtx, dty);
    console.log(`  ${name.padEnd(9)} (${pattern[0].length}×${pattern.length}): ${pixels.length} pixels`);
    allPixels.push(...pixels.map(p => ({ ...p, object: name })));
  }
  console.log(`\nTotal: ${allPixels.length} pixels`);

  if (args.dryRun) {
    console.log('\n--- Dry run (no API calls) ---');
    for (const p of allPixels) {
      console.log(`  ${p.object.padEnd(9)} ${p.key}  lat=${p.lat.toFixed(6)} lng=${p.lng.toFixed(6)}  ${p.color}`);
    }
    return;
  }

  console.log(`\nPainting ${allPixels.length} pixels to ${args.apiUrl} ...`);
  let painted = 0, failed = 0;
  for (const pixel of allPixels) {
    try {
      await paintPixel(pixel);
      painted++;
      process.stdout.write(`\r  ✓ ${painted}/${allPixels.length} (failed: ${failed})`);
    } catch (e) {
      failed++;
      console.error(`\n  ✗ ${pixel.object} ${pixel.key}: ${e.message}`);
    }
    if (args.delay > 0) await sleep(args.delay);
  }
  console.log(`\n\nDone! Painted ${painted}, failed ${failed}. Session: ${SESSION_ID}`);
  console.log('View at: https://pixhood.art');
}

main().catch(e => { console.error(e); process.exit(1); });
