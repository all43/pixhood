import { describe, it, expect } from 'vitest'
import { shouldSkipPaint } from '../frontend/map.js'

describe('shouldSkipPaint - client-side deduplication', () => {
  const ERASE = '__erase__'

  describe('Eraser logic', () => {
    it('skips erasing when tile is already empty (no previous state)', () => {
      const skip = shouldSkipPaint({
        color: ERASE,
        eraseColor: ERASE,
        prev: null,
        isSubGrid: false,
        childKey: 'tile_1',
        lastTapKey: null,
        lastTapTime: 0,
        now: 1000,
        tapDebounceMs: 80
      })
      expect(skip).toBe(true)
    })

    it('allows erasing when tile was previously painted', () => {
      const skip = shouldSkipPaint({
        color: ERASE,
        eraseColor: ERASE,
        prev: { lat: 52, lng: 13, color: '#FF0000' },
        isSubGrid: false,
        childKey: 'tile_1',
        lastTapKey: null,
        lastTapTime: 0,
        now: 1000,
        tapDebounceMs: 80
      })
      expect(skip).toBe(false)
    })

    it('skips erasing on the same tile within debounce window (rapid double-tap)', () => {
      const skip = shouldSkipPaint({
        color: ERASE,
        eraseColor: ERASE,
        prev: { lat: 52, lng: 13, color: '#FF0000' },
        isSubGrid: false,
        childKey: 'tile_1',
        lastTapKey: 'tile_1',
        lastTapTime: 950,
        now: 1000, // 50ms < 80ms
        tapDebounceMs: 80
      })
      expect(skip).toBe(true)
    })
  })

  describe('Parent tile painting', () => {
    it('skips painting if parent already has the exact same color and no children', () => {
      const skip = shouldSkipPaint({
        color: '#FF0000',
        eraseColor: ERASE,
        prev: null,
        isSubGrid: false,
        childKey: 'tile_1',
        parentColor: '#FF0000',
        hasChildren: false,
        lastTapKey: null,
        lastTapTime: 0,
        now: 1000,
        tapDebounceMs: 80
      })
      expect(skip).toBe(true)
    })

    it('allows painting if parent has a different color', () => {
      const skip = shouldSkipPaint({
        color: '#00FF00',
        eraseColor: ERASE,
        prev: null,
        isSubGrid: false,
        childKey: 'tile_1',
        parentColor: '#FF0000',
        hasChildren: false,
        lastTapKey: null,
        lastTapTime: 0,
        now: 1000,
        tapDebounceMs: 80
      })
      expect(skip).toBe(false)
    })

    it('allows painting if parent is unpainted', () => {
      const skip = shouldSkipPaint({
        color: '#00FF00',
        eraseColor: ERASE,
        prev: null,
        isSubGrid: false,
        childKey: 'tile_1',
        parentColor: null,
        hasChildren: false,
        lastTapKey: null,
        lastTapTime: 0,
        now: 1000,
        tapDebounceMs: 80
      })
      expect(skip).toBe(false)
    })

    it('allows painting if parent has the same color but currently has children (overwriting)', () => {
      const skip = shouldSkipPaint({
        color: '#FF0000',
        eraseColor: ERASE,
        prev: null,
        isSubGrid: false,
        childKey: 'tile_1',
        parentColor: '#FF0000',
        hasChildren: true,
        lastTapKey: null,
        lastTapTime: 0,
        now: 1000,
        tapDebounceMs: 80
      })
      expect(skip).toBe(false)
    })
  })

  describe('Sub-pixel painting', () => {
    it('skips painting if sub-pixel already has the exact same color', () => {
      const skip = shouldSkipPaint({
        color: '#0000FF',
        eraseColor: ERASE,
        prev: null,
        isSubGrid: true,
        childKey: 'tile_1_2_3',
        existingChildColor: '#0000FF',
        lastTapKey: null,
        lastTapTime: 0,
        now: 1000,
        tapDebounceMs: 80
      })
      expect(skip).toBe(true)
    })

    it('allows painting if sub-pixel has a different color', () => {
      const skip = shouldSkipPaint({
        color: '#0000FF',
        eraseColor: ERASE,
        prev: null,
        isSubGrid: true,
        childKey: 'tile_1_2_3',
        existingChildColor: '#FFFF00',
        lastTapKey: null,
        lastTapTime: 0,
        now: 1000,
        tapDebounceMs: 80
      })
      expect(skip).toBe(false)
    })

    it('allows painting if sub-pixel is empty', () => {
      const skip = shouldSkipPaint({
        color: '#0000FF',
        eraseColor: ERASE,
        prev: null,
        isSubGrid: true,
        childKey: 'tile_1_2_3',
        existingChildColor: null,
        lastTapKey: null,
        lastTapTime: 0,
        now: 1000,
        tapDebounceMs: 80
      })
      expect(skip).toBe(false)
    })
  })

  describe('Rapid tap debounce', () => {
    it('skips tap if on same key within debounce window (e.g. touch bounce)', () => {
      const skip = shouldSkipPaint({
        color: '#FF0000',
        eraseColor: ERASE,
        prev: null,
        isSubGrid: false,
        childKey: 'tile_1',
        parentColor: '#00FF00', // Different color
        hasChildren: false,
        lastTapKey: 'tile_1',
        lastTapTime: 950,
        now: 1000, // 50ms < 80ms
        tapDebounceMs: 80
      })
      expect(skip).toBe(true)
    })

    it('allows tap if on same key after debounce window', () => {
      const skip = shouldSkipPaint({
        color: '#FF0000',
        eraseColor: ERASE,
        prev: null,
        isSubGrid: false,
        childKey: 'tile_1',
        parentColor: '#00FF00',
        hasChildren: false,
        lastTapKey: 'tile_1',
        lastTapTime: 900,
        now: 1000, // 100ms > 80ms
        tapDebounceMs: 80
      })
      expect(skip).toBe(false)
    })

    it('allows tap on different key even within debounce window (multi-finger painting)', () => {
      const skip = shouldSkipPaint({
        color: '#FF0000',
        eraseColor: ERASE,
        prev: null,
        isSubGrid: false,
        childKey: 'tile_2',
        parentColor: null,
        hasChildren: false,
        lastTapKey: 'tile_1',
        lastTapTime: 980,
        now: 1000, // 20ms apart, but DIFFERENT tile
        tapDebounceMs: 80
      })
      expect(skip).toBe(false)
    })
  })
})
