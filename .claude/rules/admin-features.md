---
paths:
  - "server/redis.js"
  - "frontend/admin.js"
  - "frontend/map.js"
  - "frontend/config.js"
---

# Admin Features: Region Outlines, Hover Detection, Boundary Viz

## Protected region polygon outlines (server-side)

Protected regions are NOT stored or returned as simple rectangles `{n, s, e, w}`. The server computes actual polygon outlines from the materialized tile keys.

### `computeRegionOutlines(tileKeySet)` in redis.js

Returns `[{ id: "reg_<8hex>", outline: [[lat,lng],...], tileKeys: [...] }]`

Steps:
1. **`findConnectedComponents(tileKeySet)`**: BFS to group adjacent tiles (4-connectivity: up/down/left/right neighbors) into connected components.
2. **`traceOutline(component)`**: For each component, traces the boundary using directed-edge walking:
   - For each tile, checks all 4 edges. If neighbor is missing in that direction, creates a directed edge from one corner to the next.
   - Follows edges from a starting corner, appending corner coordinates (converted from tile grid coords to lat/lng), until returning to start.
3. Each traced outline is closed (first point == last point).

### API response format

`GET /protected-regions?space=` returns region objects with `outline` and `tileKeys` arrays, not `{n, s, e, w}`.

`GET /admin/protected?space=` returns `{ regions: [...], tiles: [...] }` where regions have the same outline format.

### Frontend rendering

Protected regions render gold dashed polylines (`CONFIG.PROTECTED_BORDER_COLOR`, `CONFIG.PROTECTED_BORDER_WEIGHT`) using the `outline` coordinates directly. No client-side `mergeRectangles()` — merging happens server-side via connected-component tracing.

## Point-in-polygon hover detection (frontend)

`isInProtectedRegion(lat, lng)` in map.js checks if coordinates fall inside any protected region outline:
- Uses `pointInPolygon(lat, lng, outline)` — ray-casting algorithm
- Throttled to 100ms (`_protectedHoverTimer`)
- On match: adds `map-protected` CSS class to map element (shows no-paint cursor)
- Disabled during region-select-mode and inspect-mode
- Used by `handleMapClick()` to reject painting in protected areas with toast "This area is protected"

## Boundary visualization (frontend)

Orange dashed rectangle appears when user pans near the edge of loaded viewport data:
- `updateBoundaryVisualization()` in map.js
- Compares current viewport bounds against loaded bounds
- Triggers when viewport edge is within `CONFIG.BOUNDARY_EDGE_FRACTION: 0.2` (20%) of loaded bounds edge
- Style: `CONFIG.BOUNDARY_COLOR: 'rgba(255, 165, 0, 0.4)'`, `CONFIG.BOUNDARY_DASH: '8 4'`, weight 2px
- Removed and re-evaluated on each viewport update

## Inspect popup auto-close

Inspect popup auto-removes itself after 8 seconds via `setTimeout` (in admin.js).
