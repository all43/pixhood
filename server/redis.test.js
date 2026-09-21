import { describe, it, expect, vi, beforeEach } from 'vitest'
const redis = require('./redis.js')

const mockSet = vi.fn().mockResolvedValue('OK')
const mockExists = vi.fn().mockResolvedValue(1)
const mockDel = vi.fn().mockResolvedValue(1)

const mockClient = {
  set: mockSet,
  exists: mockExists,
  del: mockDel
}

beforeEach(() => {
  vi.clearAllMocks()
  redis._setClientForTesting(mockClient)
})

describe('redis.js - session blocking and TTL', () => {
  it('blockSession sets blocked key with 300s (5 minutes) TTL', async () => {
    await redis.blockSession('sess_abc123')
    expect(mockSet).toHaveBeenCalledWith('blocked:sess_abc123', '1', { EX: 300 })
  })

  it('isSessionBlocked checks existence of blocked key', async () => {
    const isBlocked = await redis.isSessionBlocked('sess_abc123')
    expect(mockExists).toHaveBeenCalledWith('blocked:sess_abc123')
    expect(isBlocked).toBe(1)
  })

  it('unblockSession deletes blocked key', async () => {
    await redis.unblockSession('sess_abc123')
    expect(mockDel).toHaveBeenCalledWith('blocked:sess_abc123')
  })
})
