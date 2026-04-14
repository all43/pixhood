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
  const margin = 0.5;
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
  const pixel = {
    id: tile.key,
    lat: tile.lat,
    lng: tile.lng,
    color,
    paintedAt: new Date().toISOString(),
    sessionId: getSessionId()
  };
  const res = await fetch(`${CONFIG.API_URL}/pixels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pixel)
  });
  if (!res.ok) throw new Error(`Failed to write pixel: ${res.status}`);
  return pixel;
}

async function writeChildPixel(parentKey, lat, lng, color) {
  const sub = snapToSubTile(parentKey, lat, lng);
  const childPixel = {
    id: sub.key,
    parentId: parentKey,
    subX: sub.subX,
    subY: sub.subY,
    lat: sub.lat,
    lng: sub.lng,
    color,
    paintedAt: new Date().toISOString(),
    sessionId: getSessionId()
  };
  const res = await fetch(`${CONFIG.API_URL}/pixels/child`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parentId: parentKey,
      childKey: sub.key,
      childPixel
    })
  });
  if (!res.ok) throw new Error(`Failed to write child pixel: ${res.status}`);
  return childPixel;
}

let _ws = null;
let _onPixel = null;
let _onChild = null;
let _retryDelay = 1000;
let _heartbeatTimer = null;

function connectWebSocket(onPixel, onChild) {
  _onPixel = onPixel;
  _onChild = onChild || null;
  _openWS();
}

function _openWS() {
  _ws = new WebSocket(CONFIG.WS_URL);

  _ws.addEventListener('open', () => {
    console.log('WS connected');
    _retryDelay = 1000;
    _startHeartbeat();
  });

  _ws.addEventListener('message', e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'pixel' && _onPixel) _onPixel(msg.data);
      if (msg.type === 'child' && _onChild) _onChild(msg.data, msg.type);
      if (msg.type === 'clearChildren' && _onChild) _onChild(msg.data, msg.type);
      if (msg.type === 'pong') return;
    } catch (err) {
      console.error('WS message parse error:', err);
    }
  });

  _ws.addEventListener('close', () => {
    console.log(`WS closed — reconnecting in ${_retryDelay}ms`);
    _stopHeartbeat();
    setTimeout(_openWS, _retryDelay);
    _retryDelay = Math.min(_retryDelay * 2, 30000);
  });

  _ws.addEventListener('error', err => {
    console.error('WS error:', err);
  });
}

function _startHeartbeat() {
  _stopHeartbeat();
  _heartbeatTimer = setInterval(() => {
    if (_ws && _ws.readyState === 1) {
      _ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, CONFIG.HEARTBEAT_INTERVAL);
}

function _stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}
