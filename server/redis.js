const { createClient } = require('redis');

const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });

client.on('error', err => console.error('Redis error:', err));

async function connect() {
  await client.connect();
  console.log('Redis connected');
}

const TTL = 86400; // 24 hours
const GEO_KEY = 'pixels:geo';

const LAT_METERS_PER_DEG = 111320;

function lngMetersPerDeg(lat) {
  return 111320 * Math.cos(lat * Math.PI / 180);
}

function pixelKey(id) {
  return `pixel:${id}`;
}

function subpixelsKey(id) {
  return `subpixels:${id}`;
}

async function savePixel(pixel) {
  const key = pixelKey(pixel.id);
  const multi = client.multi();
  multi.set(key, JSON.stringify(pixel), { EX: TTL });
  multi.geoAdd(GEO_KEY, { longitude: pixel.lng, latitude: pixel.lat, member: pixel.id });
  await multi.exec();
}

async function deleteSubpixels(parentId) {
  await client.del(subpixelsKey(parentId));
}

async function saveChildPixel(parentId, childKey, childPixel) {
  const subKey = subpixelsKey(parentId);
  const pKey = pixelKey(parentId);

  const multi = client.multi();
  multi.hSet(subKey, childKey, JSON.stringify(childPixel));
  multi.expire(subKey, TTL);
  multi.expire(pKey, TTL);
  await multi.exec();

  const rawParent = await client.get(pKey);
  const rawChildren = await client.hGetAll(subKey);

  const children = Object.values(rawChildren).map(v => JSON.parse(v));
  const parent = rawParent ? JSON.parse(rawParent) : null;

  return { parent, children };
}

async function getPixelsInViewport(n, s, e, w) {
  const centerLng = (w + e) / 2;
  const centerLat = (n + s) / 2;
  const widthM = (e - w) * lngMetersPerDeg(centerLat);
  const heightM = (n - s) * LAT_METERS_PER_DEG;

  const members = await client.geoSearch(
    GEO_KEY,
    { longitude: centerLng, latitude: centerLat },
    { width: widthM, height: heightM, unit: 'm' }
  );

  if (members.length === 0) return { pixels: [], staleKeys: [] };

  const keys = members.map(m => pixelKey(m));
  const values = await client.mGet(keys);

  const pixels = [];
  const staleKeys = [];

  for (let i = 0; i < members.length; i++) {
    if (values[i]) {
      pixels.push(JSON.parse(values[i]));
    } else {
      staleKeys.push(members[i]);
    }
  }

  return { pixels, staleKeys };
}

async function getSubpixels(parentId) {
  const exists = await client.exists(subpixelsKey(parentId));
  if (!exists) return [];
  const raw = await client.hGetAll(subpixelsKey(parentId));
  await client.expire(subpixelsKey(parentId), TTL);
  return Object.values(raw).map(v => JSON.parse(v));
}

async function cleanupGeoIndex(staleKeys) {
  if (staleKeys.length === 0) return;
  await client.zRem(GEO_KEY, staleKeys);
}

module.exports = {
  connect,
  savePixel,
  saveChildPixel,
  deleteSubpixels,
  getPixelsInViewport,
  getSubpixels,
  cleanupGeoIndex
};
