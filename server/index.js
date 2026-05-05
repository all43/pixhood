const http = require('http');
const crypto = require('crypto');
const { timingSafeEqual } = crypto;
const { WebSocketServer } = require('ws');
const redis = require('./redis');
const safeParse = redis.safeParse;
const WS_TYPES = require('./shared/ws-types');
const S = require('./suspicion');

const CONSTANTS = {
  WS_OPEN: 1,
  ...WS_TYPES
};

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const TILE_KEY_RE = /^-?\d+(_-?\d+)+$/;
const SESSION_ID_RE = /^sess_[a-z0-9]{2,50}$/;
const SPACE_CREATE_MAX = 10;
const SPACE_CREATE_WINDOW_MS = 60000;

function validatePaintParent(msg) {
  const { tileKey, lat, lng, color, id } = msg;
  if (!tileKey || !TILE_KEY_RE.test(tileKey)) return false;
  if (typeof lat !== 'number' || typeof lng !== 'number' || lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (!color || !COLOR_RE.test(color)) return false;
  if (id != null && (typeof id !== 'number' || id <= 0)) return false;
  return true;
}

function validatePaintChild(msg) {
  const { parentId, tileKey, subX, subY, lat, lng, color, id } = msg;
  if (!parentId || !TILE_KEY_RE.test(parentId)) return false;
  if (!tileKey || !TILE_KEY_RE.test(tileKey)) return false;
  if (typeof subX !== 'number' || !Number.isInteger(subX) || subX < 0 || subX >= 16) return false;
  if (typeof subY !== 'number' || !Number.isInteger(subY) || subY < 0 || subY >= 16) return false;
  if (typeof lat !== 'number' || typeof lng !== 'number' || lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (!color || !COLOR_RE.test(color)) return false;
  if (id != null && (typeof id !== 'number' || id <= 0)) return false;
  return true;
}

function parseSpaceParam(url) {
  const space = url.searchParams.get('space');
  if (!space) return null;
  return redis.SPACE_SLUG_RE.test(space) ? space : null;
}

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || `http://localhost:${PORT}`;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || null;

const sessionStates = new Map();
const sessionRefCounts = new Map();
const revertingSessions = new Set();

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const MAX_BODY_LENGTH = 10 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_LENGTH) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendTooLarge(res) {
  res.writeHead(413, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Payload too large' }));
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function getClientIP(req) {
  return req.headers['cf-connecting-ip'] ||
         req.headers['fly-client-ip'] ||
         (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.socket?.remoteAddress ||
         'unknown';
}

function getWSIP(ws) {
  return ws._clientIP || 'unknown';
}

function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function checkAdminAuth(req) {
  if (!ADMIN_API_KEY) return { ok: false };
  const ip = getClientIP(req);
  const lockout = await redis.checkAdminRateLimit(ip);
  if (lockout.locked) return { ok: false, locked: true, retryAfter: lockout.retryAfter };
  const auth = req.headers['authorization'] || '';
  if (timingSafeEqualStr(auth, `Bearer ${ADMIN_API_KEY}`)) return { ok: true, ip };
  await redis.incrementAdminFailure(ip);
  return { ok: false };
}

function updateSessionPaint(sessionId, lat, lng) {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = S.createSessionState();
    sessionStates.set(sessionId, state);
  }
  S.updateSessionPaint(state, lat, lng, Date.now());
}

function updateSessionViewport(sessionId, viewport, zoom) {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = S.createSessionState();
    sessionStates.set(sessionId, state);
  }
  S.updateSessionViewport(state, viewport, zoom);
}

function addSessionFlag(sessionId, reason) {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = S.createSessionState();
    sessionStates.set(sessionId, state);
  }
  S.addSessionFlag(state, reason, Date.now());
}

function countRecentFlags(sessionId, windowMs) {
  const state = sessionStates.get(sessionId);
  return S.countRecentFlags(state, windowMs, Date.now());
}

function sendRateLimited(res, retryAfter) {
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'Retry-After': String(retryAfter)
  });
  res.end(JSON.stringify({ error: 'Too many requests', retryAfter }));
}

async function checkWriteRateLimits(ip, sessionId, space) {
  const result = await redis.checkWriteRateLimitsBatch(
    ip, sessionId, space,
    S.RATE_LIMITS.IP_WRITE.max, S.RATE_LIMITS.IP_WRITE.windowMs,
    S.RATE_LIMITS.SESSION_BURST.windowMs, S.RATE_LIMITS.SESSION_BURST.max,
    S.RATE_LIMITS.SESSION_SUSTAINED.windowMs, S.RATE_LIMITS.SESSION_SUSTAINED.max
  );
  if (result.blocked) return result.retryAfter;
  return null;
}

async function shouldAutoRevert(sessionId, lat, lng) {
  const burst = await redis.countPaintsInWindow(sessionId, S.AUTO_REVERT.BURST_WINDOW_MS);
  if (burst > S.AUTO_REVERT.BURST_MAX) return 'burst';

  const state = sessionStates.get(sessionId);
  if (state && state.lastPaintLat != null && state.lastPaintTime != null) {
    const distance = S.haversineDistance(state.lastPaintLat, state.lastPaintLng, lat, lng);
    const elapsed = (Date.now() - state.lastPaintTime) / 1000;
    const withinVp = S.isWithinViewport(lat, lng, state.viewport);
    if (!withinVp && elapsed > 0 && elapsed < S.AUTO_REVERT.DISTANCE_WINDOW_MS / 1000 &&
        distance > S.AUTO_REVERT.DISTANCE_MAX_M) {
      return 'distance';
    }
  }

  const recentFlags = countRecentFlags(sessionId, S.AUTO_REVERT.FLAG_WINDOW_MS);
  if (recentFlags >= S.AUTO_REVERT.FLAG_COUNT) return 'flags';

  return null;
}

function broadcastRevertResult(result) {
  for (const tile of result.tiles) {
    if (tile.action === 'restored' && tile.pixel) {
      broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...tile.pixel, hasChildren: false } }, tile.space);
    } else if (tile.action === 'deleted') {
      broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_DELETE_PIXEL, data: { id: tile.tileKey } }, tile.space);
    } else if (tile.action === 'child_reverted' && tile.parentData) {
      broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...tile.parentData, hasChildren: false } }, tile.space);
    }
  }
}

async function handlePaintParent(ws, msg) {
  const sessionId = ws.sessionId;
  if (!sessionId) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'no_session' }));
    return;
  }

  const sessionState = sessionStates.get(sessionId);
  if (!sessionState || !sessionState.viewport) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'no_viewport' }));
    return;
  }

  if (await redis.isSessionBlocked(sessionId)) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'blocked' }));
    return;
  }

  const ip = getWSIP(ws);
  const space = ws.space;
  const retryAfter = await checkWriteRateLimits(ip, sessionId, space);
  if (retryAfter) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'rate_limited', retryAfter }));
    return;
  }

  if (!validatePaintParent(msg)) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'invalid_input' }));
    return;
  }

  const { tileKey, lat, lng, color } = msg;
  const pixel = {
    id: tileKey,
    lat,
    lng,
    color,
    paintedAt: new Date().toISOString(),
    sessionId
  };

  const prevRaw = await redis.getPixelRaw(pixel.id, space);
  const prevPixel = prevRaw ? safeParse(prevRaw) : null;
  if (prevPixel && prevPixel.protected) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'protected' }));
    return;
  }
  const prevChildrenRaw = await redis.getSubpixelsAll(pixel.id, space);
  const prevChildren = Object.keys(prevChildrenRaw).length > 0
    ? Object.values(prevChildrenRaw).map(v => safeParse(v)).filter(Boolean)
    : null;

  await redis.logPaint(sessionId, {
    tileKey: pixel.id,
    type: 'parent',
    space,
    lat: pixel.lat,
    lng: pixel.lng,
    color: pixel.color,
    previousColor: prevPixel ? prevPixel.color : null,
    previousLat: prevPixel ? prevPixel.lat : null,
    previousLng: prevPixel ? prevPixel.lng : null,
    previousSessionId: prevPixel ? prevPixel.sessionId : null,
    previousChildren: prevChildren
  });

  const autoRevertReason = await shouldAutoRevert(sessionId, pixel.lat, pixel.lng);
  if (autoRevertReason) {
    if (revertingSessions.has(sessionId)) return;
    revertingSessions.add(sessionId);
    try {
      console.warn(`[auto-revert] session=${sessionId} reason=${autoRevertReason} space=${space || 'global'}`);
      const result = await redis.revertSession(sessionId);
      await redis.blockSession(sessionId);
      broadcastRevertResult(result);
      try { ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'blocked' })); } catch {}
      try { ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_BLOCKED })); } catch {}
    } catch (err) {
      console.error(`[auto-revert] failed for session=${sessionId}:`, err);
      try { await redis.blockSession(sessionId); } catch {}
    } finally {
      revertingSessions.delete(sessionId);
    }
    return;
  }

  const suspicion = S.checkPaintSuspicion(sessionStates.get(sessionId), pixel.lat, pixel.lng, Date.now());
  if (suspicion.suspicious) {
    console.warn(`[suspicion] session=${sessionId} reasons=${suspicion.reasons.join(',')} lat=${pixel.lat} lng=${pixel.lng}`);
    redis.flagSession(sessionId).catch(err => console.error('Flag session error:', err));
    const now = Date.now();
    const state = sessionStates.get(sessionId);
    for (const reason of suspicion.reasons) {
      if (reason === 'excessive_distance') {
        if (S.hasFreePass(state, now)) {
          S.useFreePass(state, now);
          continue;
        }
      }
      addSessionFlag(sessionId, reason);
    }
  }

  updateSessionPaint(sessionId, pixel.lat, pixel.lng);

  await redis.deleteSubpixels(pixel.id, space);
  await redis.savePixel(pixel, space);
  broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_CLEAR_CHILDREN, data: { parentId: pixel.id } }, space);
  broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...pixel, hasChildren: false } }, space);
  ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ACK, id: msg.id }));
}

async function handlePaintChild(ws, msg) {
  const sessionId = ws.sessionId;
  if (!sessionId) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'no_session' }));
    return;
  }

  const sessionState = sessionStates.get(sessionId);
  if (!sessionState || !sessionState.viewport) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'no_viewport' }));
    return;
  }

  if (await redis.isSessionBlocked(sessionId)) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'blocked' }));
    return;
  }

  const ip = getWSIP(ws);
  const space = ws.space;
  const retryAfter = await checkWriteRateLimits(ip, sessionId, space);
  if (retryAfter) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'rate_limited', retryAfter }));
    return;
  }

  if (!validatePaintChild(msg)) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'invalid_input' }));
    return;
  }

  const { parentId, tileKey, lat, lng, color } = msg;
  const childKey = tileKey;

  const parentRaw = await redis.getPixelRaw(parentId, space);
  const parentPixel = parentRaw ? safeParse(parentRaw) : null;
  if (parentPixel && parentPixel.protected) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'protected' }));
    return;
  }

  const childPixel = {
    id: tileKey,
    parentId,
    subX: msg.subX,
    subY: msg.subY,
    lat,
    lng,
    color,
    paintedAt: new Date().toISOString(),
    sessionId
  };

  const prevChildRaw = await redis.getChildRaw(parentId, childKey, space);
  const prevChild = prevChildRaw ? safeParse(prevChildRaw) : null;

  await redis.logPaint(sessionId, {
    tileKey: parentId,
    type: 'child',
    space,
    childKey,
    lat: childPixel.lat,
    lng: childPixel.lng,
    color: childPixel.color,
    previousChildColor: prevChild ? prevChild.color : null,
    previousSubX: prevChild ? prevChild.subX : null,
    previousSubY: prevChild ? prevChild.subY : null
  });

  const autoRevertReason = await shouldAutoRevert(sessionId, childPixel.lat, childPixel.lng);
  if (autoRevertReason) {
    if (revertingSessions.has(sessionId)) return;
    revertingSessions.add(sessionId);
    try {
      console.warn(`[auto-revert] session=${sessionId} reason=${autoRevertReason} space=${space || 'global'}`);
      const result = await redis.revertSession(sessionId);
      await redis.blockSession(sessionId);
      broadcastRevertResult(result);
      try { ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'blocked' })); } catch {}
      try { ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_BLOCKED })); } catch {}
    } catch (err) {
      console.error(`[auto-revert] failed for session=${sessionId}:`, err);
      try { await redis.blockSession(sessionId); } catch {}
    } finally {
      revertingSessions.delete(sessionId);
    }
    return;
  }

  const suspicion = S.checkPaintSuspicion(sessionStates.get(sessionId), childPixel.lat, childPixel.lng, Date.now());
  if (suspicion.suspicious) {
    console.warn(`[suspicion] session=${sessionId} reasons=${suspicion.reasons.join(',')} lat=${childPixel.lat} lng=${childPixel.lng}`);
    redis.flagSession(sessionId).catch(err => console.error('Flag session error:', err));
    const now = Date.now();
    const state = sessionStates.get(sessionId);
    for (const reason of suspicion.reasons) {
      if (reason === 'excessive_distance') {
        if (S.hasFreePass(state, now)) {
          S.useFreePass(state, now);
          continue;
        }
      }
      addSessionFlag(sessionId, reason);
    }
  }

  updateSessionPaint(sessionId, childPixel.lat, childPixel.lng);

  const { children } = await redis.saveChildPixel(parentId, childKey, childPixel, space);
  broadcastToViewport(childPixel.lat, childPixel.lng, { type: CONSTANTS.WS_TYPE_CHILD, data: { parentId, childKey, childPixel, childrenCount: children.length } }, space);
  ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ACK, id: msg.id }));
}

async function handlePaintErase(ws, msg) {
  const sessionId = ws.sessionId;
  if (!sessionId) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'no_session' }));
    return;
  }

  const sessionState = sessionStates.get(sessionId);
  if (!sessionState || !sessionState.viewport) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'no_viewport' }));
    return;
  }

  if (await redis.isSessionBlocked(sessionId)) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'blocked' }));
    return;
  }

  const ip = getWSIP(ws);
  const space = ws.space;
  const retryAfter = await checkWriteRateLimits(ip, sessionId, space);
  if (retryAfter) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'rate_limited', retryAfter }));
    return;
  }

  if (!msg.tileKey || !TILE_KEY_RE.test(msg.tileKey)) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'invalid_input' }));
    return;
  }
  if (typeof msg.lat !== 'number' || typeof msg.lng !== 'number' || msg.lat < -90 || msg.lat > 90 || msg.lng < -180 || msg.lng > 180) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'invalid_input' }));
    return;
  }

  const { tileKey, lat, lng } = msg;

  const prevRaw = await redis.getPixelRaw(tileKey, space);
  const prevPixel = prevRaw ? safeParse(prevRaw) : null;
  if (prevPixel && prevPixel.protected) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'protected' }));
    return;
  }
  const prevChildrenRaw = await redis.getSubpixelsAll(tileKey, space);
  const prevChildren = Object.keys(prevChildrenRaw).length > 0
    ? Object.values(prevChildrenRaw).map(v => safeParse(v)).filter(Boolean)
    : null;

  await redis.logPaint(sessionId, {
    tileKey,
    type: 'erase',
    space,
    lat,
    lng,
    previousColor: prevPixel ? prevPixel.color : null,
    previousLat: prevPixel ? prevPixel.lat : null,
    previousLng: prevPixel ? prevPixel.lng : null,
    previousSessionId: prevPixel ? prevPixel.sessionId : null,
    previousChildren
  });

  await redis.erasePixel(tileKey, space);

  const autoRevertReason = await shouldAutoRevert(sessionId, lat, lng);
  if (autoRevertReason) {
    if (revertingSessions.has(sessionId)) return;
    revertingSessions.add(sessionId);
    try {
      console.warn(`[auto-revert] session=${sessionId} reason=${autoRevertReason} space=${space || 'global'}`);
      const result = await redis.revertSession(sessionId);
      await redis.blockSession(sessionId);
      broadcastRevertResult(result);
      try { ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'blocked' })); } catch {}
      try { ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_BLOCKED })); } catch {}
    } catch (err) {
      console.error(`[auto-revert] failed for session=${sessionId}:`, err);
      try { await redis.blockSession(sessionId); } catch {}
    } finally {
      revertingSessions.delete(sessionId);
    }
    return;
  }

  const suspicion = S.checkPaintSuspicion(sessionStates.get(sessionId), lat, lng, Date.now());
  if (suspicion.suspicious) {
    console.warn(`[suspicion] session=${sessionId} reasons=${suspicion.reasons.join(',')} lat=${lat} lng=${lng}`);
    redis.flagSession(sessionId).catch(err => console.error('Flag session error:', err));
    const now = Date.now();
    const state = sessionStates.get(sessionId);
    for (const reason of suspicion.reasons) {
      if (reason === 'excessive_distance') {
        if (S.hasFreePass(state, now)) {
          S.useFreePass(state, now);
          continue;
        }
      }
      addSessionFlag(sessionId, reason);
    }
  }

  updateSessionPaint(sessionId, lat, lng);

  broadcastToViewport(lat, lng, { type: CONSTANTS.WS_TYPE_CLEAR_CHILDREN, data: { parentId: tileKey } }, space);
  broadcastToViewport(lat, lng, { type: CONSTANTS.WS_TYPE_DELETE_PIXEL, data: { id: tileKey } }, space);
  ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ACK, id: msg.id }));
}

async function handleUndoPaint(ws, msg) {
  const sessionId = ws.sessionId;
  if (!sessionId) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'no_session' }));
    return;
  }

  const count = Math.min(Math.max(typeof msg.count === 'number' ? Math.floor(msg.count) : 1, 1), 50);

  if (revertingSessions.has(sessionId)) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'server_error' }));
    return;
  }
  revertingSessions.add(sessionId);
  try {
    const result = await redis.undoLastPaints(sessionId, count);
    for (const tile of result.tiles) {
      if (tile.action === 'restored' && tile.pixel) {
        broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...tile.pixel, hasChildren: false } }, tile.space);
      } else if (tile.action === 'deleted') {
        broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_DELETE_PIXEL, data: { id: tile.tileKey } }, tile.space);
      } else if (tile.action === 'child_reverted' && tile.parentData) {
        broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: tile.parentData }, tile.space);
      }
    }
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_UNDO_RESULT, id: msg.id, count: result.count }));
  } finally {
    revertingSessions.delete(sessionId);
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'OPTIONS') {
    setCORS(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {

  if (req.method === 'POST' && url.pathname === '/spaces') {
    setCORS(res);
    try {
      const ip = getClientIP(req);
      const createLimit = await redis.checkIPRateLimit(ip, 'space_create', SPACE_CREATE_MAX, SPACE_CREATE_WINDOW_MS);
      if (!createLimit.allowed) {
        sendRateLimited(res, createLimit.retryAfter);
        return;
      }
      const slug = crypto.randomBytes(9).toString('base64url').slice(0, 12);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug }));
    } catch (err) {
      console.error('POST /spaces error:', err);
      sendError(res, 500, 'Internal server error');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/pixels') {
    setCORS(res);
    try {
      const ip = getClientIP(req);
      const readLimit = await redis.checkIPRateLimit(ip, 'read', S.RATE_LIMITS.IP_READ.max, S.RATE_LIMITS.IP_READ.windowMs);
      if (!readLimit.allowed) {
        sendRateLimited(res, readLimit.retryAfter);
        return;
      }

      const n = parseFloat(url.searchParams.get('n'));
      const s = parseFloat(url.searchParams.get('s'));
      const e = parseFloat(url.searchParams.get('e'));
      const w = parseFloat(url.searchParams.get('w'));

      if (isNaN(n) || isNaN(s) || isNaN(e) || isNaN(w)) {
        sendError(res, 400, 'Missing bounds params: n, s, e, w');
        return;
      }

      const space = parseSpaceParam(url);
      const { pixels, staleKeys } = await redis.getPixelsInViewport(n, s, e, w, space);

      if (staleKeys.length > 0) {
        redis.cleanupGeoIndex(staleKeys, space).catch(err => console.error('Geo cleanup error:', err));
      }

      const childrenArrays = await redis.getSubpixelsMulti(pixels.map(p => p.id), space);
      const result = pixels.map((pixel, i) => ({
        ...pixel,
        hasChildren: childrenArrays[i].length > 0,
        children: childrenArrays[i].length > 0 ? childrenArrays[i] : undefined
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('GET /pixels error:', err);
      sendError(res, 500, 'Internal server error');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/pixels') {
    setCORS(res);
    const auth = await checkAdminAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.locked ? 429 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.locked ? { error: 'Locked', retryAfter: auth.retryAfter } : { error: 'Unauthorized' }));
      return;
    }
    try {
      const body = await readBody(req);
      const pixel = JSON.parse(body);
      const space = pixel.space || null;
      await redis.deleteSubpixels(pixel.id, space);
      await redis.savePixel(pixel, space);
      broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_CLEAR_CHILDREN, data: { parentId: pixel.id } }, space);
      broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...pixel, hasChildren: false } }, space);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      if (err.message === 'Body too large') { sendTooLarge(res); return; }
      console.error('POST /pixels error:', err);
      sendError(res, 400, 'Bad request');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/pixels/child') {
    setCORS(res);
    const auth = await checkAdminAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.locked ? 429 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.locked ? { error: 'Locked', retryAfter: auth.retryAfter } : { error: 'Unauthorized' }));
      return;
    }
    try {
      const body = await readBody(req);
      const { parentId, childKey, childPixel } = JSON.parse(body);
      const space = childPixel.space || null;
      const { children } = await redis.saveChildPixel(parentId, childKey, childPixel, space);
      broadcastToViewport(childPixel.lat, childPixel.lng, { type: CONSTANTS.WS_TYPE_CHILD, data: { parentId, childKey, childPixel, childrenCount: children.length } }, space);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      if (err.message === 'Body too large') { sendTooLarge(res); return; }
      console.error('POST /pixels/child error:', err);
      sendError(res, 400, 'Bad request');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/admin/session/')) {
    setCORS(res);
    const auth = await checkAdminAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.locked ? 429 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.locked ? { error: 'Locked', retryAfter: auth.retryAfter } : { error: 'Unauthorized' }));
      return;
    }
    const sessionId = url.pathname.slice('/admin/session/'.length);
    try {
      const paints = await redis.getSessionPaints(sessionId);
      const flagged = await redis.isSessionFlagged(sessionId);
      const blocked = await redis.isSessionBlocked(sessionId);
      const state = sessionStates.get(sessionId) || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId, paints, flagged, blocked, state }));
    } catch (err) {
      console.error('GET /admin/session error:', err);
      sendError(res, 500, 'Internal server error');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/sessions') {
    setCORS(res);
    const auth = await checkAdminAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.locked ? 429 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.locked ? { error: 'Locked', retryAfter: auth.retryAfter } : { error: 'Unauthorized' }));
      return;
    }
    try {
      const sessions = await redis.getActiveSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
    } catch (err) {
      console.error('GET /admin/sessions error:', err);
      sendError(res, 500, 'Internal server error');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/flagged') {
    setCORS(res);
    const auth = await checkAdminAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.locked ? 429 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.locked ? { error: 'Locked', retryAfter: auth.retryAfter } : { error: 'Unauthorized' }));
      return;
    }
    try {
      const sessions = await redis.getFlaggedSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
    } catch (err) {
      console.error('GET /admin/flagged error:', err);
      sendError(res, 500, 'Internal server error');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/revert') {
    setCORS(res);
    const auth = await checkAdminAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.locked ? 429 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.locked ? { error: 'Locked', retryAfter: auth.retryAfter } : { error: 'Unauthorized' }));
      return;
    }
    try {
      const body = await readBody(req);
      const { sessionId } = JSON.parse(body);
      if (!sessionId) {
        sendError(res, 400, 'Missing sessionId');
        return;
      }

      const result = await redis.revertSession(sessionId);
      await redis.unflagSession(sessionId);
      await redis.unblockSession(sessionId);

      broadcastRevertResult(result);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reverted: result.reverted }));
    } catch (err) {
      if (err.message === 'Body too large') { sendTooLarge(res); return; }
      console.error('POST /admin/revert error:', err);
      sendError(res, 500, 'Internal server error');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/verify') {
    setCORS(res);
    if (!ADMIN_API_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: false, error: 'Admin not configured' }));
      return;
    }
    const ip = getClientIP(req);
    const lockout = await redis.checkAdminRateLimit(ip);
    if (lockout.locked) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Locked', retryAfter: lockout.retryAfter }));
      return;
    }
    const auth = req.headers['authorization'] || '';
    if (timingSafeEqualStr(auth, `Bearer ${ADMIN_API_KEY}`)) {
      await redis.resetAdminFailure(ip);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: true }));
    } else {
      await redis.incrementAdminFailure(ip);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: false }));
    }
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/admin/region') {
    setCORS(res);
    const auth = await checkAdminAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.locked ? 429 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.locked ? { error: 'Locked', retryAfter: auth.retryAfter } : { error: 'Unauthorized' }));
      return;
    }
    try {
      const n = parseFloat(url.searchParams.get('n'));
      const s = parseFloat(url.searchParams.get('s'));
      const e = parseFloat(url.searchParams.get('e'));
      const w = parseFloat(url.searchParams.get('w'));
      if (isNaN(n) || isNaN(s) || isNaN(e) || isNaN(w)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid bounds' }));
        return;
      }
      const space = parseSpaceParam(url);
      const result = await redis.deletePixelsInRegion(n, s, e, w, space);
      for (const pixel of result.deleted) {
        broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_DELETE_PIXEL, data: { id: pixel.id } }, space);
        broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_CLEAR_CHILDREN, data: { parentId: pixel.id } }, space);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: result.deleted.length, skipped: result.skipped.length }));
    } catch (err) {
      console.error('DELETE /admin/region error:', err);
      sendError(res, 500, 'Internal server error');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/protect') {
    setCORS(res);
    const auth = await checkAdminAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.locked ? 429 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.locked ? { error: 'Locked', retryAfter: auth.retryAfter } : { error: 'Unauthorized' }));
      return;
    }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const space = data.space || null;
      const n = parseFloat(data.n);
      const s = parseFloat(data.s);
      const e = parseFloat(data.e);
      const w = parseFloat(data.w);

      if (isNaN(n) || isNaN(s) || isNaN(e) || isNaN(w)) {
        sendError(res, 400, 'Missing bounds params: n, s, e, w');
        return;
      }

      const { pixels } = await redis.getPixelsInViewport(n, s, e, w, space);
      const tileKeys = pixels.map(p => p.id);
      const protectedCount = await redis.protectPixels(tileKeys, space);

      const updatedPixels = [];
      for (const pixel of pixels) {
        const raw = await redis.getPixelRaw(pixel.id, space);
        if (raw) {
          const updated = safeParse(raw);
          if (updated && updated.protected) {
            broadcastToViewport(updated.lat, updated.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...updated, hasChildren: false } }, space);
            updatedPixels.push(updated);
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, protected: protectedCount, pixels: updatedPixels }));
    } catch (err) {
      if (err.message === 'Body too large') { sendTooLarge(res); return; }
      console.error('POST /admin/protect error:', err);
      sendError(res, 500, 'Internal server error');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/unprotect') {
    setCORS(res);
    const auth = await checkAdminAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.locked ? 429 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.locked ? { error: 'Locked', retryAfter: auth.retryAfter } : { error: 'Unauthorized' }));
      return;
    }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const space = data.space || null;

      let tileKeys;
      if (data.tileKeys && Array.isArray(data.tileKeys)) {
        tileKeys = data.tileKeys;
      } else if (!isNaN(parseFloat(data.n)) && !isNaN(parseFloat(data.s)) && !isNaN(parseFloat(data.e)) && !isNaN(parseFloat(data.w))) {
        const { pixels } = await redis.getPixelsInViewport(parseFloat(data.n), parseFloat(data.s), parseFloat(data.e), parseFloat(data.w), space);
        tileKeys = pixels.map(p => p.id);
      } else {
        sendError(res, 400, 'Missing tileKeys or bounds');
        return;
      }

      const unprotected = await redis.unprotectPixels(tileKeys, space);

      for (const tileKey of tileKeys) {
        const raw = await redis.getPixelRaw(tileKey, space);
        if (raw) {
          const pixel = safeParse(raw);
          if (pixel) {
            broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...pixel, hasChildren: false } }, space);
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, unprotected }));
    } catch (err) {
      if (err.message === 'Body too large') { sendTooLarge(res); return; }
      console.error('POST /admin/unprotect error:', err);
      sendError(res, 500, 'Internal server error');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/extend-ttl') {
    setCORS(res);
    const auth = await checkAdminAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.locked ? 429 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.locked ? { error: 'Locked', retryAfter: auth.retryAfter } : { error: 'Unauthorized' }));
      return;
    }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const space = data.space || null;
      const n = parseFloat(data.n);
      const s = parseFloat(data.s);
      const e = parseFloat(data.e);
      const w = parseFloat(data.w);

      if (isNaN(n) || isNaN(s) || isNaN(e) || isNaN(w)) {
        sendError(res, 400, 'Missing bounds params: n, s, e, w');
        return;
      }

      const { pixels } = await redis.getPixelsInViewport(n, s, e, w, space);
      const tileKeys = pixels.map(p => p.id);
      const extended = await redis.extendTtlPixels(tileKeys, space);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, extended }));
    } catch (err) {
      if (err.message === 'Body too large') { sendTooLarge(res); return; }
      console.error('POST /admin/extend-ttl error:', err);
      sendError(res, 500, 'Internal server error');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/protected') {
    setCORS(res);
    const auth = await checkAdminAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.locked ? 429 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.locked ? { error: 'Locked', retryAfter: auth.retryAfter } : { error: 'Unauthorized' }));
      return;
    }
    try {
      const space = parseSpaceParam(url);
      const tiles = await redis.getProtectedTiles(space);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tiles }));
    } catch (err) {
      console.error('GET /admin/protected error:', err);
      sendError(res, 500, 'Internal server error');
    }
    return;
  }

  sendError(res, 404, 'Not found');
  } catch (err) {
    console.error('Unhandled request error:', err);
    if (!res.headersSent) {
      sendError(res, 500, 'Internal server error');
    }
  }
}

function isOriginAllowed(origin) {
  if (!origin) return false;
  try {
    const { hostname } = new URL(origin);
    if (hostname === 'pixhood.art' || hostname.endsWith('.pixhood.art')) return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    return false;
  } catch {
    return false;
  }
}

const server = http.createServer(handleRequest);

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
});

const wss = new WebSocketServer({
  server,
  maxPayload: 10 * 1024,
  verifyClient: (info, cb) => {
    if (!isOriginAllowed(info.origin || info.req.headers.origin)) {
      cb(false, 403, 'Origin not allowed');
      return;
    }
    cb(true);
  }
});

function inBounds(lat, lng, b) {
  return lat >= b.s && lat <= b.n && lng >= b.w && lng <= b.e;
}

function broadcastToViewport(lat, lng, data, space) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === CONSTANTS.WS_OPEN &&
        client.viewport &&
        inBounds(lat, lng, client.viewport) &&
        client.space === space) {
      client.send(msg);
    }
  }
}

function getConnectedCount() {
  let count = 0;
  for (const client of wss.clients) {
    if (client.readyState === CONSTANTS.WS_OPEN) count++;
  }
  return count;
}

function countIPConnections(ip) {
  let count = 0;
  for (const client of wss.clients) {
    if (client._clientIP === ip && client.readyState === CONSTANTS.WS_OPEN) count++;
  }
  return count;
}

wss.on('connection', (ws, req) => {
  const ip = getClientIP(req);
  ws._clientIP = ip;
  ws.viewport = null;
  ws.sessionId = null;

  const wsUrl = new URL(req.url, 'http://localhost');
  const spaceParam = wsUrl.searchParams.get('space');
  ws.space = (spaceParam && redis.SPACE_SLUG_RE.test(spaceParam)) ? spaceParam : null;

  const currentCount = countIPConnections(ip);
  if (currentCount >= S.MAX_WS_PER_IP) {
    console.warn(`[ip-limit] rejecting connection from ${ip} (${currentCount} active)`);
    ws.close(1008, 'Too many connections');
    return;
  }

  const newSessionId = 'sess_' + crypto.randomBytes(16).toString('hex');

  console.log(`WS client connected (${getConnectedCount()} total, ${ip} has ${currentCount + 1})${ws.space ? ` space=${ws.space}` : ''}`);

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === CONSTANTS.WS_TYPE_PING) {
        ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PONG }));
      } else if (msg.type === CONSTANTS.WS_TYPE_VIEWPORT && msg.bounds) {
        ws.viewport = msg.bounds;
        const useClientSession = msg.sessionId && SESSION_ID_RE.test(msg.sessionId);
        const sid = useClientSession ? msg.sessionId : newSessionId;
        const prevSid = ws.sessionId;
        ws.sessionId = sid;
        if (prevSid !== sid) {
          if (prevSid) {
            const prevCount = sessionRefCounts.get(prevSid) - 1;
            if (prevCount <= 0) {
              sessionRefCounts.delete(prevSid);
              sessionStates.delete(prevSid);
            } else {
              sessionRefCounts.set(prevSid, prevCount);
            }
          }
          sessionRefCounts.set(sid, (sessionRefCounts.get(sid) || 0) + 1);
        }
        if (!useClientSession) {
          ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_SESSION, sessionId: newSessionId }));
        }
        updateSessionViewport(sid, msg.bounds, msg.zoom);
      } else if (msg.type === CONSTANTS.WS_TYPE_PAINT_PARENT) {
        handlePaintParent(ws, msg).catch(err => {
          console.error('handlePaintParent error:', err);
          try {
            ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'server_error' }));
          } catch {}
        });
      } else if (msg.type === CONSTANTS.WS_TYPE_PAINT_CHILD) {
        handlePaintChild(ws, msg).catch(err => {
          console.error('handlePaintChild error:', err);
          try {
            ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'server_error' }));
          } catch {}
        });
      } else if (msg.type === CONSTANTS.WS_TYPE_PAINT_ERASE) {
        handlePaintErase(ws, msg).catch(err => {
          console.error('handlePaintErase error:', err);
          try {
            ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'server_error' }));
          } catch {}
        });
      } else if (msg.type === CONSTANTS.WS_TYPE_UNDO_PAINT) {
        handleUndoPaint(ws, msg).catch(err => {
          console.error('handleUndoPaint error:', err);
          try {
            ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'server_error' }));
          } catch {}
        });
      }
    } catch {}
  });

  ws.on('error', err => console.error('WS client error:', err));
  ws.on('close', () => {
    const sid = ws.sessionId;
    if (sid) {
      const count = sessionRefCounts.get(sid) - 1;
      if (count <= 0) {
        sessionRefCounts.delete(sid);
        sessionStates.delete(sid);
      } else {
        sessionRefCounts.set(sid, count);
      }
    }
    console.log(`WS client disconnected (${getConnectedCount()} total)`);
  });
});

redis.connect().then(() => {
  setInterval(() => {
    const cutoff = Date.now() - 3600000;
    let pruned = 0;
    for (const [sessionId, state] of sessionStates) {
      if (state.lastPaintTime && state.lastPaintTime < cutoff) {
        sessionStates.delete(sessionId);
        pruned++;
      }
    }
    if (pruned) console.log(`[gc] pruned ${pruned} stale session states`);
  }, 3600000);

  server.listen(PORT, () => {
    console.log(`Pixhood running at http://localhost:${PORT}`);
  });

  process.on('SIGTERM', () => {
    console.log('Shutting down...');
    for (const client of wss.clients) {
      client.close(1001, 'Server shutting down');
    }
    server.close(() => {
      redis.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  });
}).catch(err => {
  console.error('Failed to connect to Redis:', err);
  process.exit(1);
});
