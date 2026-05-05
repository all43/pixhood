import { describe, it, expect } from 'vitest'
import S from './suspicion.js'

function makeState (overrides = {}) {
  return {
    viewport: { n: 52.53, s: 52.51, e: 13.42, w: 13.40 },
    zoom: 17,
    lastPaintLat: 52.52,
    lastPaintLng: 13.41,
    lastPaintTime: 1000000,
    flags: [],
    excessiveDistanceFreePassUsedAt: null,
    ...overrides
  }
}

describe('isViewportPlausible', () => {
  it('accepts normal zoom 17 viewport', () => {
    const bounds = { n: 52.53, s: 52.51, e: 13.42, w: 13.40 }
    expect(S.isViewportPlausible(bounds, 17)).toBe(true)
  })

  it('accepts zoom 16 with moderate span', () => {
    const bounds = { n: 52.55, s: 52.45, e: 13.45, w: 13.35 }
    expect(S.isViewportPlausible(bounds, 16)).toBe(true)
  })

  it('rejects zoom 21 with city-wide span', () => {
    const bounds = { n: 52.60, s: 52.40, e: 13.60, w: 13.20 }
    expect(S.isViewportPlausible(bounds, 21)).toBe(false)
  })

  it('accepts zoom 21 with small span', () => {
    const bounds = { n: 52.5201, s: 52.5199, e: 13.4051, w: 13.4049 }
    expect(S.isViewportPlausible(bounds, 21)).toBe(true)
  })

  it('returns true for missing zoom', () => {
    expect(S.isViewportPlausible({ n: 90, s: -90, e: 180, w: -180 }, null)).toBe(true)
  })

  it('returns true for zoom 0', () => {
    expect(S.isViewportPlausible({ n: 90, s: -90, e: 180, w: -180 }, 0)).toBe(true)
  })

  it('returns true for zoom above 22', () => {
    expect(S.isViewportPlausible({ n: 52.53, s: 52.51, e: 13.42, w: 13.40 }, 23)).toBe(true)
  })
})

describe('isWithinViewport', () => {
  it('returns true for point inside viewport', () => {
    const vp = { n: 52.53, s: 52.51, e: 13.42, w: 13.40 }
    expect(S.isWithinViewport(52.52, 13.41, vp)).toBe(true)
  })

  it('returns true for point inside 2x margin', () => {
    const vp = { n: 52.53, s: 52.51, e: 13.42, w: 13.40 }
    expect(S.isWithinViewport(52.56, 13.41, vp)).toBe(true)
  })

  it('returns false for point outside 2x margin', () => {
    const vp = { n: 52.53, s: 52.51, e: 13.42, w: 13.40 }
    expect(S.isWithinViewport(48.0, 10.0, vp)).toBe(false)
  })

  it('returns false for null viewport', () => {
    expect(S.isWithinViewport(52.52, 13.41, null)).toBe(false)
  })
})

describe('haversineDistance', () => {
  it('returns 0 for same point', () => {
    expect(S.haversineDistance(52.52, 13.41, 52.52, 13.41)).toBeCloseTo(0, 1)
  })

  it('computes ~111m for 0.001 degree lat', () => {
    const d = S.haversineDistance(52.52, 13.41, 52.521, 13.41)
    expect(d).toBeGreaterThan(100)
    expect(d).toBeLessThan(120)
  })

  it('computes ~1km for ~0.01 degree lat', () => {
    const d = S.haversineDistance(52.52, 13.41, 52.53, 13.41)
    expect(d).toBeGreaterThan(1000)
    expect(d).toBeLessThan(1200)
  })

  it('computes ~2km for 2km distance', () => {
    const d = S.haversineDistance(52.50, 13.40, 52.52, 13.40)
    expect(d).toBeGreaterThan(2000)
    expect(d).toBeLessThan(2300)
  })
})

describe('checkPaintSuspicion', () => {
  it('returns not suspicious for null state', () => {
    const result = S.checkPaintSuspicion(null, 52.52, 13.41, 1001000)
    expect(result.suspicious).toBe(false)
    expect(result.reasons).toEqual([])
  })

  it('returns not suspicious for paint inside viewport', () => {
    const state = makeState()
    const result = S.checkPaintSuspicion(state, 52.52, 13.41, 1001000)
    expect(result.suspicious).toBe(false)
  })

  it('flags outside_viewport for paint far from viewport', () => {
    const state = makeState()
    const result = S.checkPaintSuspicion(state, 48.0, 10.0, 1001000)
    expect(result.suspicious).toBe(true)
    expect(result.reasons).toContain('outside_viewport')
  })

  it('flags excessive_distance for >1500m/s speed', () => {
    const state = makeState({ lastPaintLat: 52.52, lastPaintLng: 13.41, lastPaintTime: 1000000 })
    const result = S.checkPaintSuspicion(state, 52.55, 13.41, 1000001)
    expect(result.suspicious).toBe(true)
    expect(result.reasons).toContain('excessive_distance')
  })

  it('does not flag excessive_distance for ~1000m/s speed', () => {
    const state = makeState({ lastPaintLat: 52.52, lastPaintLng: 13.41, lastPaintTime: 1000000 })
    const result = S.checkPaintSuspicion(state, 52.53, 13.41, 1001000)
    expect(result.reasons).not.toContain('excessive_distance')
  })

  it('does not flag excessive_distance for slow movement', () => {
    const state = makeState({ lastPaintLat: 52.52, lastPaintLng: 13.41, lastPaintTime: 1000000 })
    const result = S.checkPaintSuspicion(state, 52.521, 13.411, 1001000)
    expect(result.reasons).not.toContain('excessive_distance')
  })

  it('does not flag excessive_distance if elapsed > 60s', () => {
    const state = makeState({ lastPaintLat: 52.52, lastPaintLng: 13.41, lastPaintTime: 1000000 })
    const result = S.checkPaintSuspicion(state, 52.52, 13.41, 1000061)
    expect(result.reasons).not.toContain('excessive_distance')
  })

  it('does not flag distance if elapsed is 0', () => {
    const state = makeState({ lastPaintLat: 52.52, lastPaintLng: 13.41, lastPaintTime: 1000000 })
    const result = S.checkPaintSuspicion(state, 52.60, 13.50, 1000000)
    expect(result.reasons).not.toContain('excessive_distance')
  })

  it('flags implausible_viewport for spoofed bounds', () => {
    const state = makeState({
      viewport: { n: 90, s: -90, e: 180, w: -180 },
      zoom: 21
    })
    const result = S.checkPaintSuspicion(state, 52.52, 13.41, 1001000)
    expect(result.reasons).toContain('implausible_viewport')
  })

  it('flags multiple reasons simultaneously', () => {
    const state = makeState({
      viewport: { n: 52.53, s: 52.51, e: 13.42, w: 13.40 },
      zoom: 21,
      lastPaintLat: 52.52,
      lastPaintLng: 13.41,
      lastPaintTime: 1000000
    })
    const result = S.checkPaintSuspicion(state, 48.0, 10.0, 1000001)
    expect(result.suspicious).toBe(true)
    expect(result.reasons.length).toBeGreaterThanOrEqual(2)
  })
})

describe('free pass', () => {
  it('hasFreePass returns true when never used', () => {
    const state = makeState()
    expect(S.hasFreePass(state, 1000000)).toBe(true)
  })

  it('hasFreePass returns false within 5 minutes of use', () => {
    const state = makeState()
    S.useFreePass(state, 1000000)
    expect(S.hasFreePass(state, 1000000 + 299999)).toBe(false)
  })

  it('hasFreePass returns true after 5 minutes', () => {
    const state = makeState()
    S.useFreePass(state, 1000000)
    expect(S.hasFreePass(state, 1000000 + 5 * 60 * 1000)).toBe(true)
  })
})

describe('shouldAutoRevert', () => {
  it('returns true when outside_viewport flags >= FLAG_COUNT within window', () => {
    const now = 1000000
    const flags = [
      { reason: 'outside_viewport', time: now - 100 },
      { reason: 'outside_viewport', time: now - 50 },
      { reason: 'outside_viewport', time: now }
    ]
    expect(S.shouldAutoRevert(flags, null, now)).toBe(true)
  })

  it('returns false when flags < FLAG_COUNT', () => {
    const now = 1000000
    const flags = [
      { reason: 'outside_viewport', time: now - 100 },
      { reason: 'outside_viewport', time: now }
    ]
    expect(S.shouldAutoRevert(flags, null, now)).toBe(false)
  })

  it('returns false when flags are outside window', () => {
    const now = 1000000
    const flags = [
      { reason: 'outside_viewport', time: now - 700000 },
      { reason: 'outside_viewport', time: now - 600001 },
      { reason: 'outside_viewport', time: now }
    ]
    expect(S.shouldAutoRevert(flags, null, now)).toBe(false)
  })

  it('returns false when only excessive_distance flags are present', () => {
    const now = 1000000
    const flags = [
      { reason: 'excessive_distance', time: now - 100 },
      { reason: 'excessive_distance', time: now - 50 },
      { reason: 'excessive_distance', time: now }
    ]
    expect(S.shouldAutoRevert(flags, null, now)).toBe(false)
  })

  it('returns false when excessive_distance flags dilute viewport flags below threshold', () => {
    const now = 1000000
    const flags = [
      { reason: 'outside_viewport', time: now - 100 },
      { reason: 'excessive_distance', time: now - 50 },
      { reason: 'outside_viewport', time: now }
    ]
    expect(S.shouldAutoRevert(flags, null, now)).toBe(false)
  })

  it('returns true with mixed flag types when enough non-excessive_distance flags', () => {
    const now = 1000000
    const flags = [
      { reason: 'outside_viewport', time: now - 100 },
      { reason: 'excessive_distance', time: now - 50 },
      { reason: 'implausible_viewport', time: now - 25 },
      { reason: 'outside_viewport', time: now }
    ]
    expect(S.shouldAutoRevert(flags, null, now)).toBe(true)
  })
})

describe('session state management', () => {
  it('createSessionState returns default state', () => {
    const state = S.createSessionState()
    expect(state.viewport).toBeNull()
    expect(state.zoom).toBeNull()
    expect(state.lastPaintLat).toBeNull()
    expect(state.lastPaintLng).toBeNull()
    expect(state.lastPaintTime).toBeNull()
    expect(state.flags).toEqual([])
    expect(state.excessiveDistanceFreePassUsedAt).toBeNull()
  })

  it('updateSessionPaint sets coordinates and time', () => {
    const state = S.createSessionState()
    S.updateSessionPaint(state, 52.52, 13.41, 1000)
    expect(state.lastPaintLat).toBe(52.52)
    expect(state.lastPaintLng).toBe(13.41)
    expect(state.lastPaintTime).toBe(1000)
  })

  it('updateSessionViewport sets viewport and zoom', () => {
    const state = S.createSessionState()
    const vp = { n: 52.53, s: 52.51, e: 13.42, w: 13.40 }
    S.updateSessionViewport(state, vp, 17)
    expect(state.viewport).toBe(vp)
    expect(state.zoom).toBe(17)
  })

  it('updateSessionViewport sets zoom to null when falsy', () => {
    const state = S.createSessionState()
    S.updateSessionViewport(state, { n: 1, s: 0, e: 1, w: 0 }, 0)
    expect(state.zoom).toBeNull()
  })

  it('addSessionFlag appends to flags array', () => {
    const state = S.createSessionState()
    S.addSessionFlag(state, 'test_reason', 1000)
    S.addSessionFlag(state, 'other_reason', 2000)
    expect(state.flags).toEqual([
      { reason: 'test_reason', time: 1000 },
      { reason: 'other_reason', time: 2000 }
    ])
  })
})

describe('countRecentFlags', () => {
  it('returns 0 for null state', () => {
    expect(S.countRecentFlags(null, 60000, 1000000)).toBe(0)
  })

  it('counts only flags within window excluding excessive_distance', () => {
    const state = S.createSessionState()
    S.addSessionFlag(state, 'outside_viewport', 800000)
    S.addSessionFlag(state, 'excessive_distance', 950000)
    S.addSessionFlag(state, 'outside_viewport', 1000000)
    const count = S.countRecentFlags(state, 100000, 1000000)
    expect(count).toBe(1)
  })

  it('prunes old flags in place', () => {
    const state = S.createSessionState()
    S.addSessionFlag(state, 'old', 800000)
    S.addSessionFlag(state, 'new', 990000)
    S.countRecentFlags(state, 100000, 1000000)
    expect(state.flags).toEqual([{ reason: 'new', time: 990000 }])
  })

  it('returns all flags if all are within window', () => {
    const state = S.createSessionState()
    S.addSessionFlag(state, 'outside_viewport', 990000)
    S.addSessionFlag(state, 'outside_viewport', 1000000)
    const count = S.countRecentFlags(state, 60000, 1000000)
    expect(count).toBe(2)
  })
})
