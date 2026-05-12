---
paths:
  - "frontend/app.js"
  - "frontend/map.js"
  - "frontend/config.js"
---

# Home Location

Client-side-only feature (no server/API involvement). Users save a preferred map center and navigate back to it.

## Storage

- **Global**: `localStorage` key `home` → JSON `{ lat, lng }`
- **Per-space**: `localStorage` key `home:<slug>` → JSON `{ lat, lng }`
- **Resolution chain** (`resolveHomeLocation()`): space home → global home → Berlin default (`CONFIG.DEFAULT_LAT/DEFAULT_LNG`)

## Home button (`createHomeButton()` in map.js)

Bottom-right floating button (`#home-btn`) with house SVG icon:
- **Short press**: calls `flyToHome()` → `map.setView([home.lat, home.lng], CONFIG.DEFAULT_ZOOM, { animate: true })`
- **Long press** (500ms): enters Set Home mode with current home preselected

## Set Home mode (`enterSetHomeMode()` in app.js)

Full-screen map interaction mode for choosing a home location. Triggered by:
- Long press on home button
- Side menu "Set Home" button
- Welcome screen skip mode "Pick on map"
- Create space modal "Pick on map"

Behavior:
- Hides welcome screen, menu, topbar, locate button via `body.set-home-mode` CSS class
- Creates floating UI (`.set-home-ui`) with Nominatim search bar + Cancel/Confirm buttons
- Places draggable pin marker (`.home-pin`, cyan 24px circle) and dashed circle (`CONFIG.HOME_RADIUS_M = 1100m` radius)
- Map click places pin at clicked position
- Escape key cancels
- `exitSetHomeMode(lat, lng)` saves to `setHomeLocation()`, shows "Home set" toast, calls optional callback
- Map click handler for painting checks `_setHomeMode` and returns early

## Home Picker (`createHomePicker()` in app.js)

Reusable compact widget: Nominatim search input + "Pick on map" button. Returns `{ getLatLon(), setNameText(), cleanup(), el }`. Used in:
- Welcome screen skip mode
- Create Space modal (manual location fallback)

## Share links with home coordinates

`getHomeShareLink(slug)` builds URL: `pixhood.art/s/<slug>?lat=52.5&lng=13.4`
- Embeds home coordinates at `CONFIG.HOME_LINK_PRECISION: 1` decimal place (~11km precision)
- Falls back: space home → global home → no coordinates

On space entry, URL `?lat=&lng=` params are read, saved as home location, and stripped from URL via `history.replaceState`.

## Config constants (config.js)

| Constant | Value | Purpose |
|----------|-------|---------|
| `HOME_KEY` | `'home'` | localStorage key for global home |
| `HOME_LINK_PRECISION` | `1` | Decimal places in share links |
| `HOME_RADIUS_M` | `1100` | Radius of dashed circle during set-home (~1km) |
| `NOMINATIM_URL` | `'https://nominatim.openstreetmap.org/search'` | OSM Nominatim search endpoint |

## Nominatim location search (`createLocationSearch()` in app.js)

Reusable search widget used by Set Home mode and Home Picker:
- Debounced (400ms) text input with AbortController for cancellation
- Fetches from `CONFIG.NOMINATIM_URL` with `limit=5`
- Dropdown with click-to-select
- Returns `{ wrapper, input, cleanup() }`
