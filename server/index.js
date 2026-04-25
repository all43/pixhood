const http = require('http');
const { WebSocketServer } = require('ws');
const redis = require('./redis');
const WS_TYPES = require('./shared/ws-types');
const S = require('./suspicion');

const CONSTANTS = {
  WS_OPEN: 1,
  ...WS_TYPES
};

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || `http://localhost:${PORT}`;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || null;

const sessionStates = new Map();

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
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

async function checkAdminAuth(req) {
  if (!ADMIN_API_KEY) return { ok: false };
  const ip = getClientIP(req);
  const lockout = await redis.checkAdminRateLimit(ip);
  if (lockout.locked) return { ok: false, locked: true, retryAfter: lockout.retryAfter };
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${ADMIN_API_KEY}`) return { ok: true, ip };
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

async function checkWriteRateLimits(ip, sessionId) {
  const ipLimit = await redis.checkIPRateLimit(ip, 'write', S.RATE_LIMITS.IP_WRITE.max, S.RATE_LIMITS.IP_WRITE.windowMs);
  if (!ipLimit.allowed) return ipLimit.retryAfter;

  const burst = await redis.countPaintsInWindow(sessionId, S.RATE_LIMITS.SESSION_BURST.windowMs);
  if (burst > S.RATE_LIMITS.SESSION_BURST.max) {
    return S.RATE_LIMITS.SESSION_BURST.windowMs / 1000;
  }

  const sustained = await redis.countPaintsInWindow(sessionId, S.RATE_LIMITS.SESSION_SUSTAINED.windowMs);
  if (sustained > S.RATE_LIMITS.SESSION_SUSTAINED.max) {
    return S.RATE_LIMITS.SESSION_SUSTAINED.windowMs / 1000;
  }

  return null;
}

async function shouldAutoRevert(sessionId, lat, lng) {
  const burst = await redis.countPaintsInWindow(sessionId, S.AUTO_REVERT.BURST_WINDOW_MS);
  if (burst > S.AUTO_REVERT.BURST_MAX) return 'burst';

  const state = sessionStates.get(sessionId);
  if (state && state.lastPaintLat != null && state.lastPaintTime != null) {
    const distance = S.haversineDistance(state.lastPaintLat, state.lastPaintLng, lat, lng);
    const elapsed = (Date.now() - state.lastPaintTime) / 1000;
    if (elapsed > 0 && elapsed < S.AUTO_REVERT.DISTANCE_WINDOW_MS / 1000 &&
        distance > S.AUTO_REVERT.DISTANCE_MAX_M) {
      return 'distance';
    }
  }

  const recentFlags = countRecentFlags(sessionId, S.AUTO_REVERT.FLAG_WINDOW_MS);
  if (recentFlags >= S.AUTO_REVERT.FLAG_COUNT) return 'flags';

  return null;
}

async function handlePaintParent(ws, msg) {
  const sessionId = ws.sessionId;
  if (!sessionId) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'no_session' }));
    return;
  }

  if (await redis.isSessionBlocked(sessionId)) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'blocked' }));
    return;
  }

  const ip = getWSIP(ws);
  const retryAfter = await checkWriteRateLimits(ip, sessionId);
  if (retryAfter) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'rate_limited', retryAfter }));
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

  const prevRaw = await redis.getPixelRaw(pixel.id);
  const prevPixel = prevRaw ? JSON.parse(prevRaw) : null;
  const prevChildrenRaw = await redis.getSubpixelsAll(pixel.id);
  const prevChildren = Object.keys(prevChildrenRaw).length > 0
    ? Object.values(prevChildrenRaw).map(v => JSON.parse(v))
    : null;

  await redis.logPaint(sessionId, {
    tileKey: pixel.id,
    type: 'parent',
    lat: pixel.lat,
    lng: pixel.lng,
    color: pixel.color,
    previousColor: prevPixel ? prevPixel.color : null,
    previousLat: prevPixel ? prevPixel.lat : null,
    previousLng: prevPixel ? prevPixel.lng : null,
    previousSessionId: prevPixel ? prevPixel.sessionId : null,
    previousChildren: prevChildren
  });

  updateSessionPaint(sessionId, pixel.lat, pixel.lng);

  const autoRevertReason = await shouldAutoRevert(sessionId, pixel.lat, pixel.lng);
  if (autoRevertReason) {
    console.warn(`[auto-revert] session=${sessionId} reason=${autoRevertReason}`);
    const result = await redis.revertSession(sessionId);
    await redis.blockSession(sessionId);
    for (const tile of result.tiles) {
      if (tile.action === 'restored' && tile.pixel) {
        broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...tile.pixel, hasChildren: false } });
      } else if (tile.action === 'deleted') {
        broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_DELETE_PIXEL, data: { id: tile.tileKey } });
      } else if (tile.action === 'child_reverted' && tile.parentData) {
        broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: tile.parentData });
      }
    }
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'blocked' }));
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_BLOCKED }));
    return;
  }

  const suspicion = S.checkPaintSuspicion(sessionStates.get(sessionId), pixel.lat, pixel.lng, Date.now());
  if (suspicion.suspicious) {
    console.warn(`[suspicion] session=${sessionId} reasons=${suspicion.reasons.join(',')} lat=${pixel.lat} lng=${pixel.lng}`);
    redis.flagSession(sessionId).catch(err => console.error('Flag session error:', err));
    for (const reason of suspicion.reasons) {
      addSessionFlag(sessionId, reason);
    }
  }

  await redis.deleteSubpixels(pixel.id);
  await redis.savePixel(pixel);
  broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_CLEAR_CHILDREN, data: { parentId: pixel.id } });
  broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...pixel, hasChildren: false } });
  ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ACK, id: msg.id }));
}

async function handlePaintChild(ws, msg) {
  const sessionId = ws.sessionId;
  if (!sessionId) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'no_session' }));
    return;
  }

  if (await redis.isSessionBlocked(sessionId)) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'blocked' }));
    return;
  }

  const ip = getWSIP(ws);
  const retryAfter = await checkWriteRateLimits(ip, sessionId);
  if (retryAfter) {
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'rate_limited', retryAfter }));
    return;
  }

  const { parentId, tileKey, lat, lng, color } = msg;
  const childKey = tileKey;
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

  const prevChildRaw = await redis.getChildRaw(parentId, childKey);
  const prevChild = prevChildRaw ? JSON.parse(prevChildRaw) : null;

  await redis.logPaint(sessionId, {
    tileKey: parentId,
    type: 'child',
    childKey,
    lat: childPixel.lat,
    lng: childPixel.lng,
    color: childPixel.color,
    previousChildColor: prevChild ? prevChild.color : null,
    previousSubX: prevChild ? prevChild.subX : null,
    previousSubY: prevChild ? prevChild.subY : null
  });

  updateSessionPaint(sessionId, childPixel.lat, childPixel.lng);

  const autoRevertReason = await shouldAutoRevert(sessionId, childPixel.lat, childPixel.lng);
  if (autoRevertReason) {
    console.warn(`[auto-revert] session=${sessionId} reason=${autoRevertReason}`);
    const result = await redis.revertSession(sessionId);
    await redis.blockSession(sessionId);
    for (const tile of result.tiles) {
      if (tile.action === 'restored' && tile.pixel) {
        broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...tile.pixel, hasChildren: false } });
      } else if (tile.action === 'deleted') {
        broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_DELETE_PIXEL, data: { id: tile.tileKey } });
      } else if (tile.action === 'child_reverted' && tile.parentData) {
        broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: tile.parentData });
      }
    }
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ERROR, id: msg.id, reason: 'blocked' }));
    ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_BLOCKED }));
    return;
  }

  const suspicion = S.checkPaintSuspicion(sessionStates.get(sessionId), childPixel.lat, childPixel.lng, Date.now());
  if (suspicion.suspicious) {
    console.warn(`[suspicion] session=${sessionId} reasons=${suspicion.reasons.join(',')} lat=${childPixel.lat} lng=${childPixel.lng}`);
    redis.flagSession(sessionId).catch(err => console.error('Flag session error:', err));
    for (const reason of suspicion.reasons) {
      addSessionFlag(sessionId, reason);
    }
  }

  const { children } = await redis.saveChildPixel(parentId, childKey, childPixel);
  broadcastToViewport(childPixel.lat, childPixel.lng, { type: CONSTANTS.WS_TYPE_CHILD, data: { parentId, childKey, childPixel, childrenCount: children.length } });
  ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PAINT_ACK, id: msg.id }));
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost`);

  if (req.method === 'OPTIONS') {
    setCORS(res);
    res.writeHead(204);
    res.end();
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
        res.writeHead(400);
        res.end('Missing bounds params: n, s, e, w');
        return;
      }

      const { pixels, staleKeys } = await redis.getPixelsInViewport(n, s, e, w);

      if (staleKeys.length > 0) {
        redis.cleanupGeoIndex(staleKeys).catch(err => console.error('Geo cleanup error:', err));
      }

      const subPromises = pixels.map(async pixel => {
        const children = await redis.getSubpixels(pixel.id);
        return { ...pixel, hasChildren: children.length > 0, children: children.length > 0 ? children : undefined };
      });

      const result = await Promise.all(subPromises);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('GET /pixels error:', err);
      res.writeHead(500);
      res.end('Internal server error');
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
      await redis.deleteSubpixels(pixel.id);
      await redis.savePixel(pixel);
      broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_CLEAR_CHILDREN, data: { parentId: pixel.id } });
      broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...pixel, hasChildren: false } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('POST /pixels error:', err);
      res.writeHead(400);
      res.end('Bad request');
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
      const { children } = await redis.saveChildPixel(parentId, childKey, childPixel);
      broadcastToViewport(childPixel.lat, childPixel.lng, { type: CONSTANTS.WS_TYPE_CHILD, data: { parentId, childKey, childPixel, childrenCount: children.length } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('POST /pixels/child error:', err);
      res.writeHead(400);
      res.end('Bad request');
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
      res.writeHead(500);
      res.end('Internal server error');
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
      res.writeHead(500);
      res.end('Internal server error');
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
        res.writeHead(400);
        res.end('Missing sessionId');
        return;
      }

      const result = await redis.revertSession(sessionId);
      await redis.unflagSession(sessionId);
      await redis.unblockSession(sessionId);

      for (const tile of result.tiles) {
        if (tile.action === 'restored' && tile.pixel) {
          broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...tile.pixel, hasChildren: false } });
        } else if (tile.action === 'deleted') {
          broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_DELETE_PIXEL, data: { id: tile.tileKey } });
        } else if (tile.action === 'child_reverted' && tile.parentData) {
          broadcastToViewport(tile.lat, tile.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: tile.parentData });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reverted: result.reverted }));
    } catch (err) {
      console.error('POST /admin/revert error:', err);
      res.writeHead(500);
      res.end('Internal server error');
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
    if (auth === `Bearer ${ADMIN_API_KEY}`) {
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
      const deleted = await redis.deletePixelsInRegion(n, s, e, w);
      for (const pixel of deleted) {
        broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_DELETE_PIXEL, data: { id: pixel.id } });
        broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_CLEAR_CHILDREN, data: { parentId: pixel.id } });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: deleted.length }));
    } catch (err) {
      console.error('DELETE /admin/region error:', err);
      res.writeHead(500);
      res.end('Internal server error');
    }
    return;
  }

  if (req.method === 'OPTIONS') {
    setCORS(res);
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

const server = http.createServer(handleRequest);
const wss = new WebSocketServer({ server });

function inBounds(lat, lng, b) {
  return lat >= b.s && lat <= b.n && lng >= b.w && lng <= b.e;
}

function broadcastToViewport(lat, lng, data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === CONSTANTS.WS_OPEN && client.viewport && inBounds(lat, lng, client.viewport)) {
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

  const currentCount = countIPConnections(ip);
  if (currentCount >= S.MAX_WS_PER_IP) {
    console.warn(`[ip-limit] rejecting connection from ${ip} (${currentCount} active)`);
    ws.close(1008, 'Too many connections');
    return;
  }

  console.log(`WS client connected (${getConnectedCount()} total, ${ip} has ${currentCount + 1})`);

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === CONSTANTS.WS_TYPE_PING) {
        ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PONG }));
      } else if (msg.type === CONSTANTS.WS_TYPE_VIEWPORT && msg.bounds) {
        ws.viewport = msg.bounds;
        if (msg.sessionId) {
          ws.sessionId = msg.sessionId;
          updateSessionViewport(msg.sessionId, msg.bounds, msg.zoom);
        }
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
      }
    } catch {}
  });

  ws.on('error', err => console.error('WS client error:', err));
  ws.on('close', () => {
    if (ws.sessionId) sessionStates.delete(ws.sessionId);
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
}).catch(err => {
  console.error('Failed to connect to Redis:', err);
  process.exit(1);
});
