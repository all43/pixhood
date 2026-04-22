const AUTO_REVERT = {
  BURST_MAX: 30,
  BURST_WINDOW_MS: 5000,
  DISTANCE_MAX_M: 2000,
  DISTANCE_WINDOW_MS: 5000,
  FLAG_COUNT: 3,
  FLAG_WINDOW_MS: 600000
};

const RATE_LIMITS = {
  SESSION_BURST: { windowMs: 1000, max: 10 },
  SESSION_SUSTAINED: { windowMs: 60000, max: 60 },
  IP_WRITE: { windowMs: 60000, max: 120 },
  IP_READ: { windowMs: 60000, max: 300 }
};

const MAX_WS_PER_IP = 10;

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isViewportPlausible(bounds, zoom) {
  if (!zoom || zoom < 1 || zoom > 22) return true;
  const latSpan = Math.abs(bounds.n - bounds.s);
  const lngSpan = Math.abs(bounds.e - bounds.w);
  const maxSpan = 360 / Math.pow(2, zoom - 6);
  if (latSpan > maxSpan || lngSpan > maxSpan) return false;
  return true;
}

function checkPaintSuspicion(state, lat, lng, now) {
  if (!state) return { suspicious: false, reasons: [] };

  let suspicious = false;
  const reasons = [];

  if (state.viewport) {
    const vp = state.viewport;
    const latSpan = vp.n - vp.s;
    const lngSpan = vp.e - vp.w;
    const m = 2.0;
    if (lat < vp.s - latSpan * m || lat > vp.n + latSpan * m ||
        lng < vp.w - lngSpan * m || lng > vp.e + lngSpan * m) {
      suspicious = true;
      reasons.push('outside_viewport');
    }

    if (state.zoom != null && !isViewportPlausible(vp, state.zoom)) {
      suspicious = true;
      reasons.push('implausible_viewport');
    }
  }

  if (state.lastPaintLat != null && state.lastPaintTime != null) {
    const distance = haversineDistance(state.lastPaintLat, state.lastPaintLng, lat, lng);
    const elapsed = (now - state.lastPaintTime) / 1000;
    if (elapsed > 0 && elapsed < 60 && distance / elapsed > 500) {
      suspicious = true;
      reasons.push('excessive_distance');
    }
  }

  return { suspicious, reasons };
}

function shouldAutoRevert(flags, sessionState, now) {
  if (flags.length >= AUTO_REVERT.FLAG_COUNT) {
    const recent = flags.filter(f => f.time >= now - AUTO_REVERT.FLAG_WINDOW_MS);
    if (recent.length >= AUTO_REVERT.FLAG_COUNT) return true;
  }
  return false;
}

function createSessionState() {
  return { viewport: null, zoom: null, lastPaintLat: null, lastPaintLng: null, lastPaintTime: null, flags: [] };
}

function updateSessionPaint(state, lat, lng, now) {
  state.lastPaintLat = lat;
  state.lastPaintLng = lng;
  state.lastPaintTime = now;
}

function updateSessionViewport(state, viewport, zoom) {
  state.viewport = viewport;
  state.zoom = zoom || null;
}

function addSessionFlag(state, reason, now) {
  state.flags.push({ reason, time: now });
}

function countRecentFlags(state, windowMs, now) {
  if (!state) return 0;
  const cutoff = now - windowMs;
  state.flags = state.flags.filter(f => f.time >= cutoff);
  return state.flags.length;
}

module.exports = {
  AUTO_REVERT,
  RATE_LIMITS,
  MAX_WS_PER_IP,
  haversineDistance,
  isViewportPlausible,
  checkPaintSuspicion,
  shouldAutoRevert,
  createSessionState,
  updateSessionPaint,
  updateSessionViewport,
  addSessionFlag,
  countRecentFlags
};
