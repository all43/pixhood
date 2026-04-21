function getSessionId() {
  let id = localStorage.getItem('pixhood_session');
  if (!id) {
    id = 'sess_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
    localStorage.setItem('pixhood_session', id);
  }
  return id;
}

let _loadedBounds = null;

function getLoadedBounds() {
  return _loadedBounds;
}

function needsRefetch(viewportBounds) {
  if (!_loadedBounds) return true;
  const vb = viewportBounds;
  const lb = _loadedBounds;
  const margin = CONFIG.REFETCH_THRESHOLD;
  return (
    vb.n > lb.n - (lb.n - lb.s) * margin ||
    vb.s < lb.s + (lb.n - lb.s) * margin ||
    vb.e > lb.e - (lb.e - lb.w) * margin ||
    vb.w < lb.w + (lb.e - lb.w) * margin
  );
}

function computeFetchBounds(viewportBounds) {
  const vb = viewportBounds;
  const latSpan = vb.n - vb.s;
  const lngSpan = vb.e - vb.w;
  const m = CONFIG.VIEWPORT_MARGIN;
  return {
    n: vb.n + latSpan * m,
    s: vb.s - latSpan * m,
    e: vb.e + lngSpan * m,
    w: vb.w - lngSpan * m
  };
}

async function loadViewport(viewportBounds, zoom) {
  const fb = computeFetchBounds(viewportBounds);
  const params = new URLSearchParams({
    n: fb.n, s: fb.s, e: fb.e, w: fb.w, zoom: zoom || 0
  });
  const res = await fetch(`${CONFIG.API_URL}/pixels?${params}`);
  if (!res.ok) throw new Error(`Failed to load pixels: ${res.status}`);
  const pixels = await res.json();
  _loadedBounds = fb;
  return pixels;
}

async function writePixel(lat, lng, color) {
  const tile = snapToTile(lat, lng);
  const msg = {
    type: CONFIG.WS_TYPE_PAINT_PARENT,
    id: nextPaintId(),
    tileKey: tile.key,
    lat: tile.lat,
    lng: tile.lng,
    color
  };
  _sendPaint(msg);
  return { id: tile.key, lat: tile.lat, lng: tile.lng, color, hasChildren: false };
}

async function writeChildPixel(parentKey, lat, lng, color) {
  const sub = snapToSubTile(parentKey, lat, lng);
  const msg = {
    type: CONFIG.WS_TYPE_PAINT_CHILD,
    id: nextPaintId(),
    parentId: parentKey,
    tileKey: sub.key,
    subX: sub.subX,
    subY: sub.subY,
    lat: sub.lat,
    lng: sub.lng,
    color
  };
  _sendPaint(msg);
  return { id: sub.key, parentId: parentKey, subX: sub.subX, subY: sub.subY, lat: sub.lat, lng: sub.lng, color };
}

let _ws = null;
let _onPixel = null;
let _onChild = null;
let _onDelete = null;
let _onPaintError = null;
let _onBlocked = null;
let _retryDelay = 1000;
let _heartbeatTimer = null;
let _paintSeq = 0;
const _pendingPaints = new Map();
let _reconnectTimer = null;

function nextPaintId() { return ++_paintSeq; }

function _sendPaint(msg) {
  if (!_ws || _ws.readyState !== 1) return;
  _ws.send(JSON.stringify(msg));
  const timer = setTimeout(() => {
    _pendingPaints.delete(msg.id);
    if (_onPaintError) _onPaintError('timeout');
  }, CONFIG.PAINT_ACK_TIMEOUT);
  _pendingPaints.set(msg.id, timer);
}

function _flushPending() {
  const count = _pendingPaints.size;
  for (const [, timer] of _pendingPaints) clearTimeout(timer);
  _pendingPaints.clear();
  if (count > 0 && _onPaintError) _onPaintError('disconnect', count);
}

function connectWebSocket(onPixel, onChild, onDelete, onPaintError, onBlocked) {
  _onPixel = onPixel;
  _onChild = onChild || null;
  _onDelete = onDelete || null;
  _onPaintError = onPaintError || null;
  _onBlocked = onBlocked || null;
  _openWS();
}

function sendViewport(viewportBounds) {
  if (!_ws || _ws.readyState !== 1) return;
  const fb = computeFetchBounds(viewportBounds);
  const zoom = typeof getCurrentZoom === 'function' ? getCurrentZoom() : 0;
  _ws.send(JSON.stringify({ type: CONFIG.WS_TYPE_VIEWPORT, bounds: fb, sessionId: getSessionId(), zoom }));
}

let _onViewportReady = null;

function setViewportReadyCallback(cb) {
  _onViewportReady = cb;
}

function _openWS() {
  _ws = new WebSocket(CONFIG.WS_URL);

  _ws.addEventListener('open', () => {
    console.log('WS connected');
    _retryDelay = CONFIG.WS_RETRY_INITIAL_MS;
    _startHeartbeat();
    const sid = getSessionId();
    const zoom = typeof getCurrentZoom === 'function' ? getCurrentZoom() : 0;
    if (_loadedBounds) {
      _ws.send(JSON.stringify({ type: CONFIG.WS_TYPE_VIEWPORT, bounds: _loadedBounds, sessionId: sid, zoom }));
    } else if (_onViewportReady) {
      const bounds = _onViewportReady();
      if (bounds) {
        const fb = computeFetchBounds(bounds);
        _ws.send(JSON.stringify({ type: CONFIG.WS_TYPE_VIEWPORT, bounds: fb, sessionId: sid, zoom }));
      }
    }
  });

  _ws.addEventListener('message', e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === CONFIG.WS_TYPE_PIXEL && _onPixel) _onPixel(msg.data);
      if (msg.type === CONFIG.WS_TYPE_CHILD && _onChild) _onChild(msg.data, msg.type);
      if (msg.type === CONFIG.WS_TYPE_CLEAR_CHILDREN && _onChild) _onChild(msg.data, msg.type);
      if (msg.type === CONFIG.WS_TYPE_DELETE_PIXEL && _onDelete) _onDelete(msg.data);
      if (msg.type === CONFIG.WS_TYPE_PONG) return;
      if (msg.type === CONFIG.WS_TYPE_PAINT_ACK) {
        const timer = _pendingPaints.get(msg.id);
        if (timer) { clearTimeout(timer); _pendingPaints.delete(msg.id); }
      }
      if (msg.type === CONFIG.WS_TYPE_PAINT_ERROR) {
        const timer = _pendingPaints.get(msg.id);
        if (timer) { clearTimeout(timer); _pendingPaints.delete(msg.id); }
        if (_onPaintError) _onPaintError(msg.reason, 1, msg.retryAfter);
      }
      if (msg.type === CONFIG.WS_TYPE_BLOCKED && _onBlocked) _onBlocked();
    } catch (err) {
      console.error('WS message parse error:', err);
    }
  });

  _ws.addEventListener('close', () => {
    console.log(`WS closed — reconnecting in ${_retryDelay}ms`);
    _stopHeartbeat();
    _flushPending();
    _reconnectTimer = setTimeout(_openWS, _retryDelay);
    _retryDelay = Math.min(_retryDelay * 2, CONFIG.WS_RETRY_MAX_MS);
  });

  _ws.addEventListener('error', err => {
    console.error('WS error:', err);
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    _stopHeartbeat();
  } else {
    if (!_ws || _ws.readyState !== 1) _openWS();
    else _startHeartbeat();
  }
});

function _startHeartbeat() {
  _stopHeartbeat();
  _heartbeatTimer = setInterval(() => {
    if (_ws && _ws.readyState === 1) {
      _ws.send(JSON.stringify({ type: CONFIG.WS_TYPE_PING }));
    }
  }, CONFIG.HEARTBEAT_INTERVAL);
}

function _stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}
