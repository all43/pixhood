const AUTO_REVERT = {
  BURST_MAX: 150,
  BURST_WINDOW_MS: 5000,
  DISTANCE_MAX_M: 10000,
  DISTANCE_WINDOW_MS: 5000,
  FLAG_COUNT: 10,
  FLAG_WINDOW_MS: 120000
}

const RATE_LIMITS = {
  SESSION_BURST: { windowMs: 1000, max: 25 },
  SESSION_SUSTAINED: { windowMs: 60000, max: 240 },
  IP_WRITE: { windowMs: 60000, max: 480 },
  IP_READ: { windowMs: 60000, max: 300 }
}

const MAX_WS_PER_IP = 10

const EXCESSIVE_DISTANCE_THRESHOLD_MS = 1500

const FREE_PASS_RESET_MS = 5 * 60 * 1000

function haversineDistance (lat1, lng1, lat2, lng2) {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function isViewportPlausible (bounds, zoom) {
  if (!zoom || zoom < 1 || zoom > 22) return true
  const latSpan = Math.abs(bounds.n - bounds.s)
  const lngSpan = Math.abs(bounds.e - bounds.w)
  const maxSpan = 360 / Math.pow(2, zoom - 6)
  if (latSpan > maxSpan || lngSpan > maxSpan) return false
  return true
}

function isWithinViewport (lat, lng, viewport) {
  if (!viewport) return false
  const vp = viewport
  const latSpan = vp.n - vp.s
  const lngSpan = vp.e - vp.w
  const m = 2.0
  return lat >= vp.s - latSpan * m && lat <= vp.n + latSpan * m &&
         lng >= vp.w - lngSpan * m && lng <= vp.e + lngSpan * m
}

function checkPaintSuspicion (state, lat, lng, now) {
  if (!state) return { suspicious: false, reasons: [] }

  let suspicious = false
  const reasons = []

  if (state.viewport) {
    const vp = state.viewport
    const latSpan = vp.n - vp.s
    const lngSpan = vp.e - vp.w
    const m = 2.0
    if (lat < vp.s - latSpan * m || lat > vp.n + latSpan * m ||
        lng < vp.w - lngSpan * m || lng > vp.e + lngSpan * m) {
      suspicious = true
      reasons.push('outside_viewport')
    }

    if (state.zoom != null && !isViewportPlausible(vp, state.zoom)) {
      suspicious = true
      reasons.push('implausible_viewport')
    }
  }

  if (state.lastPaintLat != null && state.lastPaintTime != null) {
    const distance = haversineDistance(state.lastPaintLat, state.lastPaintLng, lat, lng)
    const elapsed = (now - state.lastPaintTime) / 1000
    if (elapsed > 0 && elapsed < 60 && distance / elapsed > EXCESSIVE_DISTANCE_THRESHOLD_MS) {
      suspicious = true
      reasons.push('excessive_distance')
    }
  }

  return { suspicious, reasons }
}

function hasFreePass (state, now) {
  if (!state.excessiveDistanceFreePassUsedAt) return true
  return (now - state.excessiveDistanceFreePassUsedAt) >= FREE_PASS_RESET_MS
}

function useFreePass (state, now) {
  state.excessiveDistanceFreePassUsedAt = now
}

function shouldAutoRevert (flags, sessionState, now) {
  if (flags.length >= AUTO_REVERT.FLAG_COUNT) {
    const recent = flags.filter(f =>
      f.time >= now - AUTO_REVERT.FLAG_WINDOW_MS &&
      f.reason !== 'excessive_distance'
    )
    if (recent.length >= AUTO_REVERT.FLAG_COUNT) return true
  }
  return false
}

function createSessionState () {
  return { viewport: null, zoom: null, lastPaintLat: null, lastPaintLng: null, lastPaintTime: null, flags: [], excessiveDistanceFreePassUsedAt: null }
}

function updateSessionPaint (state, lat, lng, now) {
  state.lastPaintLat = lat
  state.lastPaintLng = lng
  state.lastPaintTime = now
}

function updateSessionViewport (state, viewport, zoom) {
  state.viewport = viewport
  state.zoom = zoom || null
}

function addSessionFlag (state, reason, now) {
  state.flags.push({ reason, time: now })
}

function countRecentFlags (state, windowMs, now) {
  if (!state) return 0
  const cutoff = now - windowMs
  state.flags = state.flags.filter(f => f.time >= cutoff)
  return state.flags.filter(f => f.reason !== 'excessive_distance').length
}

function checkAutoRevertCondition ({ space, burstCount, state, lat, lng, now, recentFlagsCount }) {
  if (space) return null

  if (burstCount != null && burstCount > AUTO_REVERT.BURST_MAX) return 'burst'

  if (state && state.lastPaintLat != null && state.lastPaintTime != null) {
    const distance = haversineDistance(state.lastPaintLat, state.lastPaintLng, lat, lng)
    const elapsed = (now - state.lastPaintTime) / 1000
    const withinVp = isWithinViewport(lat, lng, state.viewport)
    if (!withinVp && elapsed > 0 && elapsed < AUTO_REVERT.DISTANCE_WINDOW_MS / 1000 &&
        distance > AUTO_REVERT.DISTANCE_MAX_M) {
      return 'distance'
    }
  }

  if (recentFlagsCount != null && recentFlagsCount >= AUTO_REVERT.FLAG_COUNT) return 'flags'

  return null
}

module.exports = {
  AUTO_REVERT,
  RATE_LIMITS,
  MAX_WS_PER_IP,
  EXCESSIVE_DISTANCE_THRESHOLD_MS,
  FREE_PASS_RESET_MS,
  haversineDistance,
  isViewportPlausible,
  isWithinViewport,
  checkPaintSuspicion,
  hasFreePass,
  useFreePass,
  shouldAutoRevert,
  checkAutoRevertCondition,
  createSessionState,
  updateSessionPaint,
  updateSessionViewport,
  addSessionFlag,
  countRecentFlags
}
