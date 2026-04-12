// ── Session identity ──────────────────────────────────────────────────────────

function getSessionId() {
  let id = localStorage.getItem('pixhood_session');
  if (!id) {
    id = 'sess_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
    localStorage.setItem('pixhood_session', id);
  }
  return id;
}

// ── HTTP API ──────────────────────────────────────────────────────────────────

async function loadAllPixels() {
  const res = await fetch(`${CONFIG.API_URL}/pixels`);
  if (!res.ok) throw new Error(`Failed to load pixels: ${res.status}`);
  return res.json();
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

// ── WebSocket — real-time pixel updates ───────────────────────────────────────

let _ws = null;
let _onPixel = null;
let _retryDelay = 1000;

function connectWebSocket(onPixel) {
  _onPixel = onPixel;
  _openWS();
}

function _openWS() {
  _ws = new WebSocket(CONFIG.WS_URL);

  _ws.addEventListener('open', () => {
    console.log('WS connected');
    _retryDelay = 1000; // reset backoff on successful connect
  });

  _ws.addEventListener('message', e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'pixel' && _onPixel) _onPixel(msg.data);
    } catch (err) {
      console.error('WS message parse error:', err);
    }
  });

  _ws.addEventListener('close', () => {
    console.log(`WS closed — reconnecting in ${_retryDelay}ms`);
    setTimeout(_openWS, _retryDelay);
    _retryDelay = Math.min(_retryDelay * 2, 30000); // exponential backoff, cap 30s
  });

  _ws.addEventListener('error', err => {
    console.error('WS error:', err);
    // 'close' fires after 'error', so reconnect is handled there
  });
}
