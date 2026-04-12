# Pixhood — Prototype Handover

## Concept
Pixhood is a geo-anchored pixel art web app. Users paint colored pixels tied to real-world coordinates and can explore what others have painted nearby or anywhere in the world. Think r/place meets Google Maps — local-first, creative, and collaborative.

The name reflects its core identity: your neighborhood (*hood*), expressed in pixels (*pix*). Launched initially in Berlin, where neighborhood (Kiez) culture is strong.

---

## Prototype Goal
A minimal working browser prototype that demonstrates the core loop:
1. User opens app → sees a map centered on their geolocation
2. User selects a color and clicks on a map tile to paint a pixel
3. Painted pixels are visible to all users on the map
4. User can pan/zoom the map to explore pixels painted by others

---

## Platform
- **Web app** (desktop + mobile browser)
- No native app, no app store

## Tech Stack
- **Vanilla JS** (no frameworks)
- **HTML + CSS**
- **Leaflet.js** for the map (lightweight, open source, no API key needed for base tiles)
- **Firebase Firestore** (or supabase) as the backend — real-time sync of pixel data, no backend server to manage
- OpenStreetMap tiles via Leaflet (free, no API key required)

---

## Core Data Model

### Pixel
```json
{
  "id": "lat_lng_zoom",
  "lat": 52.5200,
  "lng": 13.4050,
  "color": "#FF5733",
  "paintedAt": "2026-04-10T12:00:00Z",
  "sessionId": "anonymous-uuid"
}
```

- Pixels are identified by a tile key derived from lat/lng snapped to a grid
- No user accounts in this prototype — sessions are identified by an anonymous UUID stored in localStorage
- One pixel per grid cell (last painter wins)

---

## Grid System
- The world is divided into a fixed grid of tiles
- Tile size: approximately **10x10 meters** (adjustable constant)
- A pixel's key is computed by snapping lat/lng to the nearest grid intersection:
  ```
  tileKey = `${Math.floor(lat / TILE_SIZE)}_${Math.floor(lng / TILE_SIZE)}`
  ```
- Each tile can hold exactly one color at a time

---

## UI Layout

```
┌─────────────────────────────────┐
│  PIXHOOD          [color picker]│  ← minimal top bar
├─────────────────────────────────┤
│                                 │
│         MAP (full screen)       │  ← Leaflet map
│                                 │
│   painted pixels rendered as    │
│   colored squares overlaid      │
│   on the map tiles              │
│                                 │
└─────────────────────────────────┘
```

- Map is **full screen**
- Top bar is minimal: logo + color picker
- No sidebar, no modals in prototype
- On **click/tap**: paint the pixel at that location with the selected color
- Pixels render as small colored rectangles (Leaflet Rectangle or Canvas overlay)

---

## Color Palette
Keep it simple — offer a fixed palette of ~16 colors (no free color input in prototype):
```
#FFFFFF #000000 #FF0000 #00FF00 #0000FF #FFFF00
#FF00FF #00FFFF #FF8800 #8800FF #00FF88 #FF0088
#884400 #448800 #004488 #888888
```

---

## Key Behaviors

### On Load
1. Request geolocation from browser
2. If granted → center map on user's location
3. If denied → center on Berlin (default: `52.5200, 13.4050`)
4. Load and render all existing pixels from database within visible map bounds

### On Map Click
1. Determine which grid tile was clicked
2. Check if a pixel already exists there
3. Write/overwrite pixel with selected color + sessionId + timestamp
4. Immediately render the pixel on the map (optimistic update)

### Real-time Sync
- Listen to Firestore for new pixels in the visible area
- Render new pixels as they arrive without page reload

### On Map Move/Zoom
- Load pixels for newly visible area
- Remove pixels that are far outside the viewport (performance)

---

## What's Explicitly OUT of Scope (prototype)
- User accounts / authentication
- Pixel ownership or protection
- Undo / erase
- Comments, likes, social features
- Notifications
- Mobile app
- Rate limiting / abuse prevention
- Custom pixel sizes per zoom level (fixed size for now)

---

## File Structure
```
pixhood/
├── index.html
├── style.css
├── app.js
├── map.js          # Leaflet map setup and pixel rendering
├── pixels.js       # Firestore read/write logic
├── grid.js         # Tile key computation
├── config.js       # Constants (tile size, default location, palette, Firebase config)
└── README.md
```

---

## Setup Notes for Claude Code
- Use **Leaflet.js via CDN** (no npm needed)
- Use **Firebase SDK via CDN** (compat version for simplicity)
- Firebase project needs Firestore enabled in test mode initially
- Firestore collection: `pixels`, document ID = tileKey
- The Firebase config object will need to be filled in by the developer after creating a Firebase project at console.firebase.google.com

---

## Success Criteria for Prototype
- [ ] Map loads centered on user's geolocation (or Berlin fallback)
- [ ] Clicking the map paints a pixel in the selected color
- [ ] Painted pixels persist after page refresh
- [ ] Two browser tabs open simultaneously show each other's pixels in real time
- [ ] Works on mobile browser (touch events)
