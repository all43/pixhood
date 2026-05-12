---
paths:
  - "frontend/app.js"
  - "frontend/index.html"
---

# Space UX: Modals, Menu, Navigation

## Create Space Modal (`showCreateSpaceConfirmModal()`)

Rich modal (`#create-space-modal`) triggered from side menu "Create Space" button. Contains:
- Safety explanation paragraphs (private canvas, admin controls, link sharing warning)
- Conditional geo checkbox (`#create-space-geo`, only shown when no `geo_pref` exists): "Enable location — Center the map on you"
- Home area checkbox (`#create-space-home-check`, shown when geo is available): "Use my location as home area — Others see ~1km area, not your exact position"
- Manual home picker fallback (`createHomePicker`): Nominatim search + "Pick on map"
- Geo status indicator when locating
- Error display area
- Cancel + "Create Space" buttons (loading state: "Creating..." with both disabled)

On creation:
1. `POST /spaces` → `{ slug, key }`
2. Stores `geo_pref` from checkbox (`'granted'` or `'skipped'`)
3. Sets home location from geo checkbox result or picker coordinates
4. If key returned: opens Space Key Modal
5. If no key: navigates to `/s/<slug>`

## Space Key Modal (`showSpaceKeyModal(slug, key)`)

Post-creation modal (`#space-key-modal`) showing:
- Space link (via `getHomeShareLink(slug)`, includes home coordinates)
- Admin key, each with Copy button
- Warning: "Save this key — it cannot be recovered if lost"
- "Download Key File" button → generates `pixhood-space-<slug>.txt` with slug, link, key
- Checkbox gate: "I have saved my admin key (or I don't need it)" — Continue button disabled until checked
- Continue stores key in localStorage (`space_key:<slug>`) and navigates to space

## Side Menu (`initMenu()`)

Hamburger button in topbar opens `<nav id="menu-panel">` with backdrop. Items:
- **Welcome Screen** — re-shows welcome overlay
- **Space section** (when `CONFIG.SPACE` is set):
  - Space slug display
  - Copy Link — copies `getHomeShareLink(slug)` to clipboard
  - Manage Space — opens admin panel (only shown when space admin key is stored)
  - Leave Space — navigates to `/`
- **Set Home** — enters Set Home mode with current home preselected
- **Create Space** — opens Create Space Modal
- **Join Space** — reveals inline form with input (accepts slug or full URL, parsed via `parseSpaceSlug()`) + Go/Cancel buttons
- **Install App** — triggers PWA install (hidden when standalone or no prompt available)
- **Privacy Policy** — links to `privacy.html`
- **About** — links to `about.html`

Closed by: backdrop click, Escape key, any action button.

## Join Space

Two entry points: welcome screen inline form and side menu inline form. Input accepts:
- Raw 12-char slug
- Full URL (`pixhood.art/s/<slug>`) — parsed via `new URL(val)` + regex
Parsed by `parseSpaceSlug()`, navigates to `/s/<slug>`.

## Leave Space

Side menu "Leave Space" button calls `navigateTo('/')`. Disconnects WS before navigation.

## Navigation helper

`navigateTo(url)` calls `disconnectWebSocket()` then `location.href = url`. Used for entering/leaving spaces.
