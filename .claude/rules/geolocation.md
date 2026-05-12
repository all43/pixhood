---
paths:
  - "frontend/app.js"
  - "frontend/map.js"
  - "frontend/config.js"
---

# Geolocation

## Important correction

`enableHighAccuracy` is `true`, not `false`. There is an ongoing Chromium bug that causes geolocation requests with `enableHighAccuracy: false` to never resolve.

## Two-phase location acquisition (`getGeolocation()`)

1. **Fast cached attempt**: `getCurrentPosition` with `maximumAge: GEO_MAX_AGE_MS` (5 min), `timeout: GEO_FAST_TIMEOUT` (2s). Returns immediately if cached position is fresh.
2. **Stored position fallback**: If fast attempt fails and `last_geo` localStorage entry exists and is < 5 min old, uses stored position.
3. **Fresh request**: Falls back to `getCurrentPosition` with `maximumAge: 0`, timeout = `min(requested, GEO_GRANTED_TIMEOUT)` if permission already granted, otherwise `GEO_DEFAULT_TIMEOUT` (60s).

If `forceFresh` option is set (double-tap on locate button within 30s), skips cached and stored attempts entirely.

## Config constants (config.js)

| Constant | Value | Purpose |
|----------|-------|---------|
| `GEO_FAST_TIMEOUT` | `2000` | Timeout for cached position attempt |
| `GEO_GRANTED_TIMEOUT` | `10000` | Timeout when permission is already granted |
| `GEO_DEFAULT_TIMEOUT` | `60000` | Default timeout for fresh geolocation request |

## localStorage keys

| Key | Purpose |
|-----|---------|
| `last_geo` (`LAST_GEO_KEY`) | Cached `{ lat, lng, savedAt }` from last successful geolocation |
| `geo_pref` (`GEO_PREF_KEY`) | Preference state: `'granted'`, `'skipped'`, or `'denied'` |

## Permission states (`geo_pref`)

- **`'granted'`**: User enabled location. On return visit: auto-requests geolocation with `GEO_GRANTED_TIMEOUT`. Also sets home location on first grant (if no home exists).
- **`'skipped'`**: User clicked "Continue without". On return visit: skips geolocation, centers on home location (or Berlin default).
- **`'denied'`**: Browser denied location permission. Proceeds to map at home/Berlin with location banner.
- **Cleared (`null`/missing)**: Shows welcome screen.

## Welcome screen flows

### Enable location flow
- `#btn-enable-geo` → `requestGeoAndProceed(CONFIG.GEO_DEFAULT_TIMEOUT)`
- Shows loading spinner "Waiting for location..."
- On success: stores `geo_pref = 'granted'`, saves `last_geo`, sets home if first time

### Skip mode flow
- `#btn-skip-geo` → `welcome.classList.add('skip-mode')`
- Hides location CTA, shows `createHomePicker` with Nominatim search + "Pick on map" + "Back" button
- Search selection: sets home, stores `geo_pref = 'skipped'`, proceeds to map at that location
- "Pick on map": proceeds to map at home/default, then immediately enters Set Home mode with callback
- On return visits with `geo_pref = 'skipped'`: auto-proceeds to map at home location

## Locate button (`createLocateButton()` in map.js)

Bottom-right crosshair button (`#locate-btn`):
- Double-tap within 30s (`LOCATE_FORCE_FRESH_MS`) forces fresh geolocation (`forceFresh: true`)
- Shows `.locating` spinner state during request
- On success: flies to location, shows user marker (`showUserPosition`), stores `last_geo`
- Handles denied/timeout/unavailable with banners/toasts

## `handleLocationResult()`

Processes geolocation results across all flows:
- `granted`: shows user marker, stores `last_geo`, sets `geo_pref = 'granted'`, sets home if first time
- `skipped`: shows contextual banner based on whether home is set
- `denied`: shows "Location blocked" banner, stores `geo_pref = 'denied'`
- `unavailable`: shows toast, stores `geo_pref = 'skipped'`
- `timeout`: shows "tap locate button to retry" banner, clears `geo_pref`
