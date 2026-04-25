const { createClient } = require('redis');

const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });

client.on('error', err => console.error('Redis error:', err));

async function connect() {
  await client.connect();
  console.log('Redis connected');
}

const TTL = 86400; // 24 hours
const GEO_KEY = 'pixels:geo';
const PAINT_LOG_TTL = 86400;
const FLAGGED_KEY = 'flagged_sessions';

function paintLogKey(sessionId) { return `paintlog:${sessionId}`; }
function rateLimitKey(prefix, id) { return `ratelimit:${prefix}:${id}`; }

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

async function getPixelRaw(id) {
  return client.get(pixelKey(id));
}

async function getSubpixelsAll(id) {
  const exists = await client.exists(subpixelsKey(id));
  if (!exists) return {};
  return client.hGetAll(subpixelsKey(id));
}

async function getChildRaw(parentId, childKey) {
  return client.hGet(subpixelsKey(parentId), childKey);
}

async function logPaint(sessionId, entry) {
  const key = paintLogKey(sessionId);
  const now = Date.now();
  const multi = client.multi();
  multi.zAdd(key, { score: now, value: JSON.stringify(entry) });
  multi.zRemRangeByScore(key, '-inf', now - PAINT_LOG_TTL * 1000);
  multi.expire(key, PAINT_LOG_TTL);
  await multi.exec();
}

async function countPaintsInWindow(sessionId, windowMs) {
  const key = paintLogKey(sessionId);
  const now = Date.now();
  await client.zRemRangeByScore(key, '-inf', now - PAINT_LOG_TTL * 1000);
  return client.zCount(key, now - windowMs, '+inf');
}

async function getSessionPaints(sessionId) {
  const key = paintLogKey(sessionId);
  const entries = await client.zRangeWithScores(key, 0, -1);
  return entries.map(e => ({ ...JSON.parse(e.value), timestamp: e.score }));
}

async function checkIPRateLimit(ip, prefix, limit, windowMs) {
  const key = rateLimitKey(prefix, ip);
  const current = await client.incr(key);
  if (current === 1) {
    await client.pExpire(key, windowMs);
  }
  if (current > limit) {
    const ttl = await client.pTtl(key);
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(ttl / 1000)) };
  }
  return { allowed: true };
}

async function flagSession(sessionId) {
  await client.sAdd(FLAGGED_KEY, sessionId);
}

async function isSessionFlagged(sessionId) {
  return client.sIsMember(FLAGGED_KEY, sessionId);
}

async function getFlaggedSessions() {
  return client.sMembers(FLAGGED_KEY);
}

async function unflagSession(sessionId) {
  await client.sRem(FLAGGED_KEY, sessionId);
}

async function revertSession(sessionId) {
  const paints = await getSessionPaints(sessionId);
  if (paints.length === 0) return { reverted: 0, tiles: [] };

  const tilesTouched = new Map();
  for (const paint of paints) {
    const key = paint.tileKey;
    if (!tilesTouched.has(key)) tilesTouched.set(key, []);
    tilesTouched.get(key).push(paint);
  }

  let revertedCount = 0;
  const tileResults = [];

  for (const [tileKey, entries] of tilesTouched) {
    entries.sort((a, b) => a.timestamp - b.timestamp);
    const hasParentPaint = entries.some(e => e.type === 'parent');

    if (hasParentPaint) {
      const firstParent = entries.find(e => e.type === 'parent');
      if (firstParent.previousColor != null) {
        const pixelData = {
          id: tileKey,
          lat: firstParent.previousLat,
          lng: firstParent.previousLng,
          color: firstParent.previousColor,
          paintedAt: new Date().toISOString(),
          sessionId: firstParent.previousSessionId || 'revert'
        };
        const multi = client.multi();
        multi.set(pixelKey(tileKey), JSON.stringify(pixelData), { EX: TTL });
        multi.geoAdd(GEO_KEY, { longitude: pixelData.lng, latitude: pixelData.lat, member: tileKey });
        await multi.exec();

        if (firstParent.previousChildren && firstParent.previousChildren.length > 0) {
          const subKey = subpixelsKey(tileKey);
          const subMulti = client.multi();
          for (const child of firstParent.previousChildren) {
            subMulti.hSet(subKey, `${child.subX}_${child.subY}`, JSON.stringify(child));
          }
          subMulti.expire(subKey, TTL);
          await subMulti.exec();
        } else {
          await client.del(subpixelsKey(tileKey));
        }
        tileResults.push({ tileKey, lat: pixelData.lat, lng: pixelData.lng, action: 'restored', pixel: pixelData });
      } else {
        const lat = firstParent.lat;
        const lng = firstParent.lng;
        await client.del(pixelKey(tileKey));
        await client.del(subpixelsKey(tileKey));
        await client.zRem(GEO_KEY, tileKey);
        tileResults.push({ tileKey, lat, lng, action: 'deleted' });
      }
    } else {
      for (const entry of entries) {
        if (entry.previousChildColor != null) {
          await client.hSet(subpixelsKey(tileKey), entry.childKey, JSON.stringify({
            id: `${tileKey}_${entry.childKey}`,
            parentId: tileKey,
            subX: entry.previousSubX,
            subY: entry.previousSubY,
            color: entry.previousChildColor,
            paintedAt: new Date().toISOString(),
            sessionId: 'revert'
          }));
        } else {
          await client.hDel(subpixelsKey(tileKey), entry.childKey);
        }
      }
      await client.expire(subpixelsKey(tileKey), TTL);
      const rawParent = await client.get(pixelKey(tileKey));
      const parentData = rawParent ? JSON.parse(rawParent) : null;
      tileResults.push({ tileKey, lat: entries[0].lat, lng: entries[0].lng, action: 'child_reverted', parentData });
    }

    revertedCount++;
  }

  await client.del(paintLogKey(sessionId));
  return { reverted: revertedCount, tiles: tileResults };
}

async function blockSession(sessionId) {
  await client.set(`blocked:${sessionId}`, '1', { EX: 3600 });
}

async function isSessionBlocked(sessionId) {
  return client.exists(`blocked:${sessionId}`);
}

async function unblockSession(sessionId) {
  await client.del(`blocked:${sessionId}`);
}

const ADMIN_ATTEMPTS_MAX = 5;
const ADMIN_LOCKOUT_MS = 900000;

function adminAttemptKey(ip) { return `admin_attempts:${ip}`; }

async function checkAdminRateLimit(ip) {
  const key = adminAttemptKey(ip);
  const val = await client.get(key);
  if (val && parseInt(val) >= ADMIN_ATTEMPTS_MAX) {
    const ttl = await client.pTtl(key);
    return { locked: true, retryAfter: Math.max(1, Math.ceil(ttl / 1000)) };
  }
  return { locked: false };
}

async function incrementAdminFailure(ip) {
  const key = adminAttemptKey(ip);
  const val = await client.incr(key);
  if (val === 1) await client.pExpire(key, ADMIN_LOCKOUT_MS);
}

async function resetAdminFailure(ip) {
  await client.del(adminAttemptKey(ip));
}

async function deletePixelsInRegion(n, s, e, w) {
  const { pixels, staleKeys } = await getPixelsInViewport(n, s, e, w);
  if (staleKeys.length > 0) await cleanupGeoIndex(staleKeys);

  const deleted = [];
  for (const pixel of pixels) {
    await client.del(pixelKey(pixel.id));
    await client.del(subpixelsKey(pixel.id));
    await client.zRem(GEO_KEY, pixel.id);
    deleted.push(pixel);
  }

  return deleted;
}

module.exports = {
  connect,
  savePixel,
  saveChildPixel,
  deleteSubpixels,
  getPixelsInViewport,
  getSubpixels,
  cleanupGeoIndex,
  getPixelRaw,
  getSubpixelsAll,
  getChildRaw,
  logPaint,
  countPaintsInWindow,
  getSessionPaints,
  checkIPRateLimit,
  flagSession,
  isSessionFlagged,
  getFlaggedSessions,
  unflagSession,
  revertSession,
  blockSession,
  isSessionBlocked,
  unblockSession,
  checkAdminRateLimit,
  incrementAdminFailure,
  resetAdminFailure,
  deletePixelsInRegion
};
