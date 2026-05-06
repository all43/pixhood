const crypto = require('crypto')
const { createClient } = require('redis')
const { SPACE_SLUG_RE } = require('./shared/space')

const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' })

client.on('error', err => console.error('Redis error:', err))

function safeParse (str) {
  try { return JSON.parse(str) } catch { return null }
}

async function connect () {
  await client.connect()
  console.log('Redis connected')
}

const TTL = 86400
const TTL_EXTENDED = 30 * 24 * 3600
const GEO_KEY_GLOBAL = 'pixels:geo'
const PAINT_LOG_TTL = 86400
const FLAGGED_KEY = 'flagged_sessions'
const PROTECTED_TILES_KEY_GLOBAL = 'protected_tiles'
const PROTECTED_REGIONS_KEY_GLOBAL = 'protected_regions'


function paintLogKey (sessionId) { return `paintlog:${sessionId}` }

function rateLimitKey (prefix, id) { return `ratelimit:${prefix}:${id}` }

function rateLimitSpaceKey (prefix, id, space) {
  return space ? `space:ratelimit:${prefix}:${id}:${space}` : `ratelimit:${prefix}:${id}`
}

const LAT_METERS_PER_DEG = 111320

function lngMetersPerDeg (lat) {
  return 111320 * Math.cos(lat * Math.PI / 180)
}

function pixelKey (id, space) {
  return space ? `space:${space}:pixel:${id}` : `pixel:${id}`
}

function subpixelsKey (id, space) {
  return space ? `space:${space}:subpixels:${id}` : `subpixels:${id}`
}

function geoKey (space) {
  return space ? `space:${space}:pixels:geo` : GEO_KEY_GLOBAL
}

function protectedTilesKey (space) {
  return space ? `space:${space}:protected_tiles` : PROTECTED_TILES_KEY_GLOBAL
}

function protectedRegionsKey (space) {
  return space ? `space:${space}:protected_regions` : PROTECTED_REGIONS_KEY_GLOBAL
}

const TILE_SIZE = 18.4
const R = 20037508.34
const lngToX = lng => lng * R / 180
const latToY = lat => Math.log(Math.tan((90 + lat) * Math.PI / 360)) * R / Math.PI
const xToLng = x => x * 180 / R
const yToLat = y => Math.atan(Math.exp(y * Math.PI / R)) * 360 / Math.PI - 90

function parseTileKey (key) {
  const parts = key.split('_')
  return { tx: Number(parts[0]), ty: Number(parts[1]) }
}

function enumerateTileKeys (n, s, e, w) {
  const minTx = Math.floor(lngToX(w) / TILE_SIZE)
  const maxTx = Math.floor(lngToX(e) / TILE_SIZE)
  const minTy = Math.floor(latToY(s) / TILE_SIZE)
  const maxTy = Math.floor(latToY(n) / TILE_SIZE)

  const keys = []
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      keys.push(`${tx}_${ty}`)
    }
  }
  return keys
}

function tileOutline (tileKey) {
  const { tx, ty } = parseTileKey(tileKey)
  return [
    [yToLat(ty * TILE_SIZE), xToLng(tx * TILE_SIZE)],
    [yToLat((ty + 1) * TILE_SIZE), xToLng(tx * TILE_SIZE)],
    [yToLat((ty + 1) * TILE_SIZE), xToLng((tx + 1) * TILE_SIZE)],
    [yToLat(ty * TILE_SIZE), xToLng((tx + 1) * TILE_SIZE)]
  ]
}

function findConnectedComponents (tileKeySet) {
  const visited = new Set()
  const components = []

  for (const tk of tileKeySet) {
    if (visited.has(tk)) continue

    const component = new Set()
    const queue = [tk]
    while (queue.length > 0) {
      const current = queue.shift()
      if (visited.has(current)) continue
      visited.add(current)
      component.add(current)

      const { tx, ty } = parseTileKey(current)
      const neighbors = [`${tx - 1}_${ty}`, `${tx + 1}_${ty}`, `${tx}_${ty - 1}`, `${tx}_${ty + 1}`]
      for (const n of neighbors) {
        if (tileKeySet.has(n) && !visited.has(n)) queue.push(n)
      }
    }

    components.push(component)
  }

  return components
}

function traceOutline (component) {
  const next = new Map()

  for (const tk of component) {
    const { tx, ty } = parseTileKey(tk)

    if (!component.has(`${tx}_${ty + 1}`)) {
      const from = `${tx},${ty + 1}`
      const to = `${tx + 1},${ty + 1}`
      next.set(from, to)
    }
    if (!component.has(`${tx + 1}_${ty}`)) {
      const from = `${tx + 1},${ty + 1}`
      const to = `${tx + 1},${ty}`
      next.set(from, to)
    }
    if (!component.has(`${tx}_${ty - 1}`)) {
      const from = `${tx + 1},${ty}`
      const to = `${tx},${ty}`
      next.set(from, to)
    }
    if (!component.has(`${tx - 1}_${ty}`)) {
      const from = `${tx},${ty}`
      const to = `${tx},${ty + 1}`
      next.set(from, to)
    }
  }

  if (next.size === 0) return []

  const start = next.keys().next().value
  const outline = []
  let current = start
  let safety = next.size + 2

  while (safety-- > 0) {
    const [cx, cy] = current.split(',').map(Number)
    outline.push([yToLat(cy * TILE_SIZE), xToLng(cx * TILE_SIZE)])

    current = next.get(current)
    if (!current) break
    if (current === start) {
      outline.push(outline[0])
      return outline
    }
  }

  return outline
}

function computeRegionOutlines (tileKeySet) {
  const components = findConnectedComponents(tileKeySet)
  const regions = []
  for (const component of components) {
    const outline = traceOutline(component)
    if (outline.length >= 4) {
      regions.push({
        id: 'reg_' + crypto.randomBytes(4).toString('hex'),
        outline,
        tileKeys: [...component]
      })
    }
  }
  return regions
}

async function savePixel (pixel, space) {
  const key = pixelKey(pixel.id, space)
  const gKey = geoKey(space)
  const multi = client.multi()
  if (pixel.protected) {
    multi.set(key, JSON.stringify(pixel))
    multi.persist(key)
  } else if (pixel.ttlExtended) {
    multi.set(key, JSON.stringify(pixel), { EX: TTL_EXTENDED })
  } else {
    multi.set(key, JSON.stringify(pixel), { EX: TTL })
  }
  multi.geoAdd(gKey, { longitude: pixel.lng, latitude: pixel.lat, member: pixel.id })
  await multi.exec()
}

async function deleteSubpixels (parentId, space) {
  await client.del(subpixelsKey(parentId, space))
}

async function saveChildPixel (parentId, childKey, childPixel, space) {
  const subKey = subpixelsKey(parentId, space)
  const pKey = pixelKey(parentId, space)

  const rawParent = await client.get(pKey)
  const parentData = rawParent ? safeParse(rawParent) : null
  const isProtected = parentData && parentData.protected

  const multi = client.multi()
  multi.hSet(subKey, childKey, JSON.stringify(childPixel))
  if (isProtected) {
    multi.persist(subKey)
  } else if (parentData && parentData.ttlExtended) {
    multi.expire(subKey, TTL_EXTENDED)
  } else {
    multi.expire(subKey, TTL)
  }
  if (isProtected) {
    multi.persist(pKey)
  } else if (parentData && parentData.ttlExtended) {
    multi.expire(pKey, TTL_EXTENDED)
  } else {
    multi.expire(pKey, TTL)
  }
  await multi.exec()

  const rawChildren = await client.hGetAll(subKey)

  const children = Object.values(rawChildren).map(v => safeParse(v)).filter(Boolean)
  const parent = rawParent ? safeParse(rawParent) : null

  return { parent, children }
}

async function getPixelsInViewport (n, s, e, w, space) {
  const gKey = geoKey(space)
  const centerLng = (w + e) / 2
  const centerLat = (n + s) / 2
  const widthM = (e - w) * lngMetersPerDeg(centerLat)
  const heightM = (n - s) * LAT_METERS_PER_DEG

  const members = await client.geoSearch(
    gKey,
    { longitude: centerLng, latitude: centerLat },
    { width: widthM, height: heightM, unit: 'm' }
  )

  if (members.length === 0) return { pixels: [], staleKeys: [] }

  const keys = members.map(m => pixelKey(m, space))
  const values = await client.mGet(keys)

  const pixels = []
  const staleKeys = []

  for (let i = 0; i < members.length; i++) {
    if (values[i]) {
      pixels.push(safeParse(values[i]))
    } else {
      staleKeys.push(members[i])
    }
  }

  return { pixels, staleKeys }
}

async function getSubpixels (parentId, space) {
  const key = subpixelsKey(parentId, space)
  const exists = await client.exists(key)
  if (!exists) return []
  const raw = await client.hGetAll(key)
  const rawParent = await client.get(pixelKey(parentId, space))
  const parentData = rawParent ? safeParse(rawParent) : null
  const parentTtl = parentData && parentData.protected ? -1 : (parentData && parentData.ttlExtended ? TTL_EXTENDED : TTL)
  if (parentTtl === -1) {
    await client.persist(key)
  } else {
    await client.expire(key, parentTtl)
  }
  return Object.values(raw).map(v => safeParse(v)).filter(Boolean)
}

async function getSubpixelsMulti (parentIds, space) {
  if (parentIds.length === 0) return []

  const pipeline = client.multi()
  for (const id of parentIds) {
    pipeline.hGetAll(subpixelsKey(id, space))
    pipeline.ttl(pixelKey(id, space))
  }
  const results = await pipeline.exec()

  const expirePipeline = client.multi()
  const childrenArrays = []
  for (let i = 0; i < parentIds.length; i++) {
    const raw = results[i * 2]
    const parentTtl = results[i * 2 + 1]
    const hasChildren = raw && Object.keys(raw).length > 0
    const children = hasChildren ? Object.values(raw).map(v => safeParse(v)).filter(Boolean) : []
    childrenArrays.push(children)

    if (hasChildren) {
      if (parentTtl === -1) {
        expirePipeline.persist(subpixelsKey(parentIds[i], space))
      } else if (parentTtl > TTL) {
        expirePipeline.expire(subpixelsKey(parentIds[i], space), parentTtl)
      } else {
        expirePipeline.expire(subpixelsKey(parentIds[i], space), TTL)
      }
    }
  }
  await expirePipeline.exec()

  return childrenArrays
}

async function cleanupGeoIndex (staleKeys, space) {
  if (staleKeys.length === 0) return
  await client.zRem(geoKey(space), staleKeys)
}

async function getPixelRaw (id, space) {
  return client.get(pixelKey(id, space))
}

async function getSubpixelsAll (id, space) {
  const key = subpixelsKey(id, space)
  const exists = await client.exists(key)
  if (!exists) return {}
  return client.hGetAll(key)
}

async function getChildRaw (parentId, childKey, space) {
  return client.hGet(subpixelsKey(parentId, space), childKey)
}

async function logPaint (sessionId, entry) {
  const key = paintLogKey(sessionId)
  const now = Date.now()
  const multi = client.multi()
  multi.zAdd(key, { score: now, value: JSON.stringify(entry) })
  multi.zRemRangeByScore(key, '-inf', now - PAINT_LOG_TTL * 1000)
  multi.expire(key, PAINT_LOG_TTL)
  await multi.exec()
}

async function countPaintsInWindow (sessionId, windowMs) {
  const key = paintLogKey(sessionId)
  const now = Date.now()
  await client.zRemRangeByScore(key, '-inf', now - PAINT_LOG_TTL * 1000)
  return client.zCount(key, now - windowMs, '+inf')
}

async function getSessionPaints (sessionId) {
  const key = paintLogKey(sessionId)
  const entries = await client.zRangeWithScores(key, 0, -1)
  return entries.map(e => {
    const parsed = safeParse(e.value)
    return parsed ? { ...parsed, timestamp: e.score } : null
  }).filter(Boolean)
}

async function checkIPRateLimit (ip, prefix, limit, windowMs) {
  const key = rateLimitKey(prefix, ip)
  const current = await client.incr(key)
  if (current === 1) {
    await client.pExpire(key, windowMs)
  }
  if (current > limit) {
    const ttl = await client.pTtl(key)
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(ttl / 1000)) }
  }
  return { allowed: true }
}

async function checkWriteRateLimitsBatch (ip, sessionId, space, ipWriteMax, ipWriteWindowMs, burstWindowMs, burstMax, sustainedWindowMs, sustainedMax) {
  const ipKey = rateLimitSpaceKey('write', ip, space)
  const paintKey = paintLogKey(sessionId)
  const now = Date.now()

  const pipeline = client.multi()
  pipeline.incr(ipKey)
  pipeline.pExpire(ipKey, ipWriteWindowMs)
  pipeline.zRemRangeByScore(paintKey, '-inf', now - PAINT_LOG_TTL * 1000)
  pipeline.zCount(paintKey, now - burstWindowMs, '+inf')
  pipeline.zCount(paintKey, now - sustainedWindowMs, '+inf')

  const results = await pipeline.exec()
  const ipCount = results[0]
  const burstCount = results[3]
  const sustainedCount = results[4]

  if (ipCount > ipWriteMax) {
    const ttl = await client.pTtl(ipKey)
    return { blocked: true, retryAfter: Math.max(1, Math.ceil(ttl / 1000)) }
  }
  if (burstCount > burstMax) {
    return { blocked: true, retryAfter: Math.ceil(burstWindowMs / 1000) }
  }
  if (sustainedCount > sustainedMax) {
    return { blocked: true, retryAfter: Math.ceil(sustainedWindowMs / 1000) }
  }
  return { blocked: false }
}

async function flagSession (sessionId) {
  await client.sAdd(FLAGGED_KEY, sessionId)
}

async function isSessionFlagged (sessionId) {
  return client.sIsMember(FLAGGED_KEY, sessionId)
}

async function getFlaggedSessions () {
  return client.sMembers(FLAGGED_KEY)
}

async function unflagSession (sessionId) {
  await client.sRem(FLAGGED_KEY, sessionId)
}

async function revertSession (sessionId) {
  const paints = await getSessionPaints(sessionId)
  if (paints.length === 0) return { reverted: 0, tiles: [] }

  const tilesTouched = new Map()
  for (const paint of paints) {
    const key = paint.tileKey
    if (!tilesTouched.has(key)) tilesTouched.set(key, [])
    tilesTouched.get(key).push(paint)
  }

  let revertedCount = 0
  let failedCount = 0
  const tileResults = []

  for (const [tileKey, entries] of tilesTouched) {
    entries.sort((a, b) => a.timestamp - b.timestamp)
    const space = entries[0].space || null
    try {
      const currentRaw = await client.get(pixelKey(tileKey, space))
      const currentPixel = currentRaw ? safeParse(currentRaw) : null
      if (currentPixel && currentPixel.protected) continue
      const isProt = await client.sIsMember(protectedTilesKey(space), tileKey)
      if (isProt) continue

      const hasParentPaint = entries.some(e => e.type === 'parent' || e.type === 'erase')

      if (hasParentPaint) {
        const firstParent = entries.find(e => e.type === 'parent')
        if (firstParent.previousColor != null) {
          const pixelData = {
            id: tileKey,
            lat: firstParent.previousLat,
            lng: firstParent.previousLng,
            color: firstParent.previousColor,
            paintedAt: new Date().toISOString(),
            sessionId: firstParent.previousSessionId || 'revert'
          }
          const multi = client.multi()
          multi.set(pixelKey(tileKey, space), JSON.stringify(pixelData), { EX: TTL })
          multi.geoAdd(geoKey(space), { longitude: pixelData.lng, latitude: pixelData.lat, member: tileKey })
          await multi.exec()

          if (firstParent.previousChildren && firstParent.previousChildren.length > 0) {
            const subKey = subpixelsKey(tileKey, space)
            const subMulti = client.multi()
            for (const child of firstParent.previousChildren) {
              subMulti.hSet(subKey, `${child.subX}_${child.subY}`, JSON.stringify(child))
            }
            subMulti.expire(subKey, TTL)
            await subMulti.exec()
          } else {
            await client.del(subpixelsKey(tileKey, space))
          }
          tileResults.push({ tileKey, space, lat: pixelData.lat, lng: pixelData.lng, action: 'restored', pixel: pixelData })
        } else {
          const lat = firstParent.lat
          const lng = firstParent.lng
          await client.del(pixelKey(tileKey, space))
          await client.del(subpixelsKey(tileKey, space))
          await client.zRem(geoKey(space), tileKey)
          tileResults.push({ tileKey, space, lat, lng, action: 'deleted' })
        }
      } else {
        for (const entry of entries) {
          if (entry.previousChildColor != null) {
            await client.hSet(subpixelsKey(tileKey, space), entry.childKey, JSON.stringify({
              id: `${tileKey}_${entry.childKey}`,
              parentId: tileKey,
              subX: entry.previousSubX,
              subY: entry.previousSubY,
              color: entry.previousChildColor,
              paintedAt: new Date().toISOString(),
              sessionId: 'revert'
            }))
          } else {
            await client.hDel(subpixelsKey(tileKey, space), entry.childKey)
          }
        }
        await client.expire(subpixelsKey(tileKey, space), TTL)
        const rawParent = await client.get(pixelKey(tileKey, space))
        const parentData = rawParent ? safeParse(rawParent) : null
        tileResults.push({ tileKey, space, lat: entries[0].lat, lng: entries[0].lng, action: 'child_reverted', parentData })
      }

      revertedCount++
    } catch (err) {
      console.error(`revertSession: failed to restore tile ${tileKey}:`, err)
      failedCount++
    }
  }

  if (failedCount === 0) {
    await client.del(paintLogKey(sessionId))
  }
  return { reverted: revertedCount, tiles: tileResults }
}

async function undoLastPaints (sessionId, count) {
  const key = paintLogKey(sessionId)
  const entries = (await client.zRangeWithScores(key, 0, -1)).reverse().slice(0, count)
  if (entries.length === 0) return { reverted: 0, tiles: [], count: 0 }

  const paints = entries.map(e => {
    const parsed = safeParse(e.value)
    return parsed ? { ...parsed, timestamp: e.score } : null
  }).filter(Boolean)

  const tilesTouched = new Map()
  for (const paint of paints) {
    const tk = paint.tileKey
    if (!tilesTouched.has(tk)) tilesTouched.set(tk, [])
    tilesTouched.get(tk).push(paint)
  }

  let revertedCount = 0
  let failedCount = 0
  const tileResults = []

  for (const [tileKey, tileEntries] of tilesTouched) {
    tileEntries.sort((a, b) => a.timestamp - b.timestamp)
    const space = tileEntries[0].space || null
    try {
      const currentRaw = await client.get(pixelKey(tileKey, space))
      const currentPixel = currentRaw ? safeParse(currentRaw) : null
      if (currentPixel && currentPixel.protected) continue
      const isProt = await client.sIsMember(protectedTilesKey(space), tileKey)
      if (isProt) continue

      const hasParentPaint = tileEntries.some(e => e.type === 'parent' || e.type === 'erase')

      if (hasParentPaint) {
        const firstParent = tileEntries.find(e => e.type === 'parent' || e.type === 'erase')
        if (firstParent.previousColor != null) {
          const pixelData = {
            id: tileKey,
            lat: firstParent.previousLat,
            lng: firstParent.previousLng,
            color: firstParent.previousColor,
            paintedAt: new Date().toISOString(),
            sessionId: firstParent.previousSessionId || 'revert'
          }
          const multi = client.multi()
          multi.set(pixelKey(tileKey, space), JSON.stringify(pixelData), { EX: TTL })
          multi.geoAdd(geoKey(space), { longitude: pixelData.lng, latitude: pixelData.lat, member: tileKey })
          await multi.exec()

          if (firstParent.previousChildren && firstParent.previousChildren.length > 0) {
            const subKey = subpixelsKey(tileKey, space)
            const subMulti = client.multi()
            for (const child of firstParent.previousChildren) {
              subMulti.hSet(subKey, `${child.subX}_${child.subY}`, JSON.stringify(child))
            }
            subMulti.expire(subKey, TTL)
            await subMulti.exec()
          } else {
            await client.del(subpixelsKey(tileKey, space))
          }
          tileResults.push({ tileKey, space, lat: pixelData.lat, lng: pixelData.lng, action: 'restored', pixel: pixelData })
        } else {
          const lat = firstParent.lat
          const lng = firstParent.lng
          await client.del(pixelKey(tileKey, space))
          await client.del(subpixelsKey(tileKey, space))
          await client.zRem(geoKey(space), tileKey)
          tileResults.push({ tileKey, space, lat, lng, action: 'deleted' })
        }
      } else {
        for (const entry of tileEntries) {
          if (entry.previousChildColor != null) {
            await client.hSet(subpixelsKey(tileKey, space), entry.childKey, JSON.stringify({
              id: `${tileKey}_${entry.childKey}`,
              parentId: tileKey,
              subX: entry.previousSubX,
              subY: entry.previousSubY,
              color: entry.previousChildColor,
              paintedAt: new Date().toISOString(),
              sessionId: 'revert'
            }))
          } else {
            await client.hDel(subpixelsKey(tileKey, space), entry.childKey)
          }
        }
        await client.expire(subpixelsKey(tileKey, space), TTL)
        const rawParent = await client.get(pixelKey(tileKey, space))
        const parentData = rawParent ? safeParse(rawParent) : null
        tileResults.push({ tileKey, space, lat: tileEntries[0].lat, lng: tileEntries[0].lng, action: 'child_reverted', parentData })
      }

      revertedCount++
    } catch (err) {
      console.error(`undoLastPaints: failed to restore tile ${tileKey}:`, err)
      failedCount++
    }
  }

  for (const e of entries) {
    await client.zRem(key, e.value)
  }

  return { reverted: revertedCount, tiles: tileResults, count: entries.length }
}

async function erasePixel (tileKey, space) {
  await client.del(pixelKey(tileKey, space))
  await client.del(subpixelsKey(tileKey, space))
  await client.zRem(geoKey(space), tileKey)
}

async function blockSession (sessionId) {
  await client.set(`blocked:${sessionId}`, '1', { EX: 3600 })
}

async function isSessionBlocked (sessionId) {
  return client.exists(`blocked:${sessionId}`)
}

async function unblockSession (sessionId) {
  await client.del(`blocked:${sessionId}`)
}

const ADMIN_ATTEMPTS_MAX = 5
const ADMIN_LOCKOUT_MS = 900000
const ADMIN_REQUEST_MAX = 60
const ADMIN_REQUEST_WINDOW_MS = 60000
const ADMIN_VERIFY_MAX = 30
const ADMIN_VERIFY_WINDOW_MS = 60000

function adminAttemptKey (ip) { return `admin_attempts:${ip}` }

async function checkAdminRateLimit (ip) {
  const key = adminAttemptKey(ip)
  const val = await client.get(key)
  if (val && parseInt(val) >= ADMIN_ATTEMPTS_MAX) {
    const ttl = await client.pTtl(key)
    return { locked: true, retryAfter: Math.max(1, Math.ceil(ttl / 1000)) }
  }
  return { locked: false }
}

async function incrementAdminFailure (ip) {
  const key = adminAttemptKey(ip)
  const val = await client.incr(key)
  if (val === 1) await client.pExpire(key, ADMIN_LOCKOUT_MS)
}

async function resetAdminFailure (ip) {
  await client.del(adminAttemptKey(ip))
}

async function getActiveSessions () {
  const sessions = []
  let cursor = 0
  do {
    const reply = await client.scan(cursor, { MATCH: 'paintlog:*', COUNT: 100 })
    cursor = reply.cursor
    for (const key of reply.keys) {
      const sessionId = key.replace('paintlog:', '')
      const entries = await client.zRangeWithScores(key, -1, -1)
      const count = await client.zCard(key)
      if (entries.length > 0) {
        const latest = safeParse(entries[0].value)
        sessions.push({
          sessionId,
          paintCount: count,
          lastPaintAt: entries[0].score,
          lastLat: latest.lat || null,
          lastLng: latest.lng || null
        })
      }
    }
  } while (cursor !== 0)
  sessions.sort((a, b) => b.lastPaintAt - a.lastPaintAt)
  return sessions
}

async function deletePixelsInRegion (n, s, e, w, space) {
  const { pixels, staleKeys } = await getPixelsInViewport(n, s, e, w, space)
  if (staleKeys.length > 0) await cleanupGeoIndex(staleKeys, space)

  const pKey = protectedTilesKey(space)
  const deleted = []
  const skipped = []
  for (const pixel of pixels) {
    const isProtected = await client.sIsMember(pKey, pixel.id)
    if (isProtected) {
      skipped.push(pixel)
      continue
    }
    if (pixel.protected) {
      skipped.push(pixel)
      continue
    }
    await client.del(pixelKey(pixel.id, space))
    await client.del(subpixelsKey(pixel.id, space))
    await client.zRem(geoKey(space), pixel.id)
    deleted.push(pixel)
  }

  return { deleted, skipped }
}

async function protectRegion (n, s, e, w, space) {
  const rKey = protectedRegionsKey(space)
  const pKey = protectedTilesKey(space)

  const newTileKeys = enumerateTileKeys(n, s, e, w)
  const newTileSet = new Set(newTileKeys)

  const rawRegions = await client.lRange(rKey, 0, -1)
  const existingRegions = rawRegions.map(r => safeParse(r)).filter(Boolean)

  const existingTileSet = new Set(await client.sMembers(pKey))
  let hasOverlap = false
  for (const tk of newTileSet) {
    if (existingTileSet.has(tk)) { hasOverlap = true; break }
  }
  for (const tk of existingTileSet) {
    if (!hasOverlap) break
    const { tx, ty } = parseTileKey(tk)
    const neighbors = [`${tx - 1}_${ty}`, `${tx + 1}_${ty}`, `${tx}_${ty - 1}`, `${tx}_${ty + 1}`]
    for (const nk of neighbors) {
      if (newTileSet.has(nk)) { hasOverlap = true; break }
    }
  }

  let mergedRegionId

  if (hasOverlap && existingRegions.length > 0) {
    const mergedSet = new Set([...existingTileSet, ...newTileSet])
    const outlines = computeRegionOutlines(mergedSet)

    await client.del(rKey)
    for (const reg of outlines) {
      await client.lPush(rKey, JSON.stringify(reg))
    }

    await client.del(pKey)
    for (const tk of mergedSet) {
      await client.sAdd(pKey, tk)
    }

    mergedRegionId = outlines.length > 0 ? outlines[0].id : 'reg_' + crypto.randomBytes(4).toString('hex')
  } else {
    const outlines = computeRegionOutlines(newTileSet)
    let targetRegion = outlines.length > 0 ? outlines[0] : null

    if (!targetRegion) {
      targetRegion = { id: 'reg_' + crypto.randomBytes(4).toString('hex'), outline: [], tileKeys: [] }
    }

    await client.lPush(rKey, JSON.stringify(targetRegion))

    if (newTileKeys.length > 0) {
      const batchSize = 500
      for (let i = 0; i < newTileKeys.length; i += batchSize) {
        await client.sAdd(pKey, newTileKeys.slice(i, i + batchSize))
      }
    }

    mergedRegionId = targetRegion.id
  }

  let protectedCount = 0
  const { pixels } = await getPixelsInViewport(n, s, e, w, space)
  for (const pixel of pixels) {
    if (pixel.protected) continue
    const raw = await client.get(pixelKey(pixel.id, space))
    if (!raw) continue
    const p = safeParse(raw)
    if (!p || p.protected) continue

    p.protected = true
    delete p.ttlExtended
    delete p.ttlExpiresAt

    const multi = client.multi()
    multi.set(pixelKey(pixel.id, space), JSON.stringify(p))
    multi.persist(pixelKey(pixel.id, space))
    await multi.exec()

    const subKey = subpixelsKey(pixel.id, space)
    const subExists = await client.exists(subKey)
    if (subExists) await client.persist(subKey)

    protectedCount++
  }

  return { regionId: mergedRegionId, tilesCount: newTileKeys.length, protected: protectedCount }
}

async function unprotectRegion (regionId, space) {
  const rKey = protectedRegionsKey(space)
  const rawRegions = await client.lRange(rKey, 0, -1)
  const regions = rawRegions.map(r => safeParse(r)).filter(Boolean)
  const targetRegion = regions.find(r => r.id === regionId)

  await client.lRem(rKey, 0, JSON.stringify(targetRegion))

  const remainingRegions = regions.filter(r => r.id !== regionId)

  const pKey = protectedTilesKey(space)
  await client.del(pKey)
  for (const reg of remainingRegions) {
    const tks = reg.tileKeys || enumerateTileKeys(reg.n, reg.s, reg.e, reg.w)
    if (tks.length > 0) {
      const batchSize = 500
      for (let i = 0; i < tks.length; i += batchSize) {
        await client.sAdd(pKey, tks.slice(i, i + batchSize))
      }
    }
  }

  if (targetRegion) {
    const stillProtected = new Set()
    for (const reg of remainingRegions) {
      for (const tk of (reg.tileKeys || [])) {
        stillProtected.add(tk)
      }
    }

    const removedTileKeys = targetRegion.tileKeys || enumerateTileKeys(targetRegion.n, targetRegion.s, targetRegion.e, targetRegion.w)
    for (const tk of removedTileKeys) {
      if (stillProtected.has(tk)) continue
      const raw = await client.get(pixelKey(tk, space))
      if (!raw) continue
      const pixel = safeParse(raw)
      if (!pixel || !pixel.protected) continue

      delete pixel.protected
      const multi = client.multi()
      multi.set(pixelKey(tk, space), JSON.stringify(pixel), { EX: TTL })
      await multi.exec()

      const subKey = subpixelsKey(tk, space)
      const subExists = await client.exists(subKey)
      if (subExists) await client.expire(subKey, TTL)
    }
  }

  return { unprotected: true }
}

async function rebuildProtectedTilesSet (space) {
  const pKey = protectedTilesKey(space)
  const rKey = protectedRegionsKey(space)
  await client.del(pKey)

  const rawRegions = await client.lRange(rKey, 0, -1)
  const regions = rawRegions.map(r => safeParse(r)).filter(Boolean)

  for (const region of regions) {
    const tks = region.tileKeys || enumerateTileKeys(region.n, region.s, region.e, region.w)
    if (tks.length > 0) {
      const batchSize = 500
      for (let i = 0; i < tks.length; i += batchSize) {
        await client.sAdd(pKey, tks.slice(i, i + batchSize))
      }
    }
  }
}

async function getProtectedRegions (space) {
  const raw = await client.lRange(protectedRegionsKey(space), 0, -1)
  return raw.map(r => safeParse(r)).filter(Boolean)
}

async function isProtectedTile (tileKey, space) {
  return client.sIsMember(protectedTilesKey(space), tileKey)
}

async function extendTtlPixels (tileKeys, space) {
  let extended = 0
  const expiresAt = new Date(Date.now() + TTL_EXTENDED * 1000).toISOString()
  for (const tileKey of tileKeys) {
    const raw = await client.get(pixelKey(tileKey, space))
    if (!raw) continue
    const pixel = safeParse(raw)
    if (!pixel) continue
    if (pixel.protected) continue
    if (pixel.ttlExtended) continue

    pixel.ttlExtended = true
    pixel.ttlExpiresAt = expiresAt

    const multi = client.multi()
    multi.set(pixelKey(tileKey, space), JSON.stringify(pixel), { EX: TTL_EXTENDED })
    await multi.exec()

    const subKey = subpixelsKey(tileKey, space)
    const subExists = await client.exists(subKey)
    if (subExists) {
      await client.expire(subKey, TTL_EXTENDED)
    }

    extended++
  }
  return extended
}

async function getProtectedTiles (space) {
  const regions = await getProtectedRegions(space)
  const members = await client.sMembers(protectedTilesKey(space))
  const tiles = []
  for (const tileKey of members) {
    const raw = await client.get(pixelKey(tileKey, space))
    if (raw) {
      const pixel = safeParse(raw)
      if (pixel) tiles.push(pixel)
    }
  }
  return { regions, tiles }
}

module.exports = {
  safeParse,
  connect,
  savePixel,
  saveChildPixel,
  deleteSubpixels,
  getPixelsInViewport,
  getSubpixels,
  getSubpixelsMulti,
  cleanupGeoIndex,
  getPixelRaw,
  getSubpixelsAll,
  getChildRaw,
  logPaint,
  countPaintsInWindow,
  getSessionPaints,
  checkIPRateLimit,
  checkWriteRateLimitsBatch,
  flagSession,
  isSessionFlagged,
  getFlaggedSessions,
  unflagSession,
  revertSession,
  undoLastPaints,
  erasePixel,
  blockSession,
  isSessionBlocked,
  unblockSession,
  checkAdminRateLimit,
  incrementAdminFailure,
  resetAdminFailure,
  deletePixelsInRegion,
  getActiveSessions,
  SPACE_SLUG_RE,
  TTL_EXTENDED,
  protectRegion,
  unprotectRegion,
  getProtectedRegions,
  isProtectedTile,
  rebuildProtectedTilesSet,
  extendTtlPixels,
  getProtectedTiles,
  pixelKey,
  subpixelsKey,
  geoKey,
  protectedTilesKey,
  protectedRegionsKey,
  ADMIN_REQUEST_MAX,
  ADMIN_REQUEST_WINDOW_MS,
  ADMIN_VERIFY_MAX,
  ADMIN_VERIFY_WINDOW_MS
}
