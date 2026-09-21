import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('Viewport WS Sync Debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces multiple rapid moveend/zoomend calls into a single sendViewport within 50ms', () => {
    const sendViewport = vi.fn()
    const getViewportBounds = vi.fn(() => ({ n: 52.53, s: 52.51, e: 13.42, w: 13.40 }))
    const debounceMs = 50

    let timer = null
    function syncViewportWS () {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const b = getViewportBounds()
        if (b) sendViewport(b)
      }, debounceMs)
    }

    // Simulate 5 rapid move events within 30ms (e.g. user panning map)
    syncViewportWS()
    vi.advanceTimersByTime(10)
    syncViewportWS()
    vi.advanceTimersByTime(10)
    syncViewportWS()
    vi.advanceTimersByTime(10)
    syncViewportWS()
    vi.advanceTimersByTime(10)
    syncViewportWS()

    expect(sendViewport).not.toHaveBeenCalled()

    // Advance beyond the 50ms debounce window from the last event
    vi.advanceTimersByTime(50)

    expect(sendViewport).toHaveBeenCalledTimes(1)
    expect(sendViewport).toHaveBeenCalledWith({ n: 52.53, s: 52.51, e: 13.42, w: 13.40 })
  })

  it('triggers another sync when user pans again after the debounce window', () => {
    const sendViewport = vi.fn()
    const getViewportBounds = vi.fn()
      .mockReturnValueOnce({ n: 52.53, s: 52.51, e: 13.42, w: 13.40 })
      .mockReturnValueOnce({ n: 52.56, s: 52.54, e: 13.45, w: 13.43 })

    let timer = null
    function syncViewportWS () {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const b = getViewportBounds()
        if (b) sendViewport(b)
      }, 50)
    }

    syncViewportWS()
    vi.advanceTimersByTime(50)
    expect(sendViewport).toHaveBeenCalledTimes(1)

    // User pans to another area after 2 seconds
    vi.advanceTimersByTime(2000)
    syncViewportWS()
    vi.advanceTimersByTime(50)
    expect(sendViewport).toHaveBeenCalledTimes(2)
  })

  it('does not call sendViewport if bounds are unavailable', () => {
    const sendViewport = vi.fn()
    const getViewportBounds = vi.fn(() => null)

    let timer = null
    function syncViewportWS () {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const b = getViewportBounds()
        if (b) sendViewport(b)
      }, 50)
    }

    syncViewportWS()
    vi.advanceTimersByTime(50)
    expect(sendViewport).not.toHaveBeenCalled()
  })
})
