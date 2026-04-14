let map;
let gridLayer;
let subGridLayer;
let userMarker;
let boundaryRect;
const pixelLayers = {};
const childLayers = {};

function initMap(lat, lng) {
  map = L.map('map', {
    center: [lat, lng],
    zoom: CONFIG.DEFAULT_ZOOM,
    zoomControl: true,
    maxZoom: 22
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 22,
    subdomains: 'abcd'
  }).addTo(map);

  gridLayer = createGridLayer();
  gridLayer.addTo(map);
  updateGridVisibility();

  createLocateButton();

  map.on('zoomend', onZoomChange);
  map.on('click', handleMapClick);

  return map;
}

function onZoomChange() {
  updateGridVisibility();
  updateSubGridVisibility();
}

function getViewportBounds() {
  const b = map.getBounds();
  return { n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest() };
}

function getCurrentZoom() {
  return map.getZoom();
}

function createGridLayer() {
  const layer = L.GridLayer.extend({
    createTile: function(coords) {
      const tile = document.createElement('canvas');
      const tileSize = this.getTileSize();
      tile.width = tileSize.x;
      tile.height = tileSize.y;

      if (map.getZoom() < CONFIG.GRID_ZOOM_THRESHOLD) return tile;
      if (map.getZoom() >= CONFIG.SUB_GRID_ZOOM) return tile;

      const ctx = tile.getContext('2d');
      const nw = map.unproject([coords.x * tileSize.x, coords.y * tileSize.y], coords.z);
      const se = map.unproject([(coords.x + 1) * tileSize.x, (coords.y + 1) * tileSize.y], coords.z);

      const latMin = se.lat;
      const latMax = nw.lat;
      const lngMin = nw.lng;
      const lngMax = se.lng;

      ctx.strokeStyle = CONFIG.GRID_COLOR;
      ctx.lineWidth = 1;

      const latStart = Math.floor(latMin / CONFIG.TILE_SIZE) * CONFIG.TILE_SIZE;
      const lngStart = Math.floor(lngMin / CONFIG.LNG_STEP) * CONFIG.LNG_STEP;
      const latCenter = (latMin + latMax) / 2;
      const lngCenter = (lngMin + lngMax) / 2;

      for (let lat = latStart; lat <= latMax; lat += CONFIG.TILE_SIZE) {
        const y = map.project([lat, lngCenter], coords.z).y - coords.y * tileSize.y;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(tileSize.x, y);
        ctx.stroke();
      }

      for (let lng = lngStart; lng <= lngMax; lng += CONFIG.LNG_STEP) {
        const x = map.project([latCenter, lng], coords.z).x - coords.x * tileSize.x;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, tileSize.y);
        ctx.stroke();
      }

      return tile;
    }
  });

  return new layer();
}

function createSubGridLayer() {
  const layer = L.GridLayer.extend({
    createTile: function(coords) {
      const tile = document.createElement('canvas');
      const tileSize = this.getTileSize();
      tile.width = tileSize.x;
      tile.height = tileSize.y;

      if (map.getZoom() < CONFIG.SUB_GRID_ZOOM) return tile;

      const ctx = tile.getContext('2d');
      const nw = map.unproject([coords.x * tileSize.x, coords.y * tileSize.y], coords.z);
      const se = map.unproject([(coords.x + 1) * tileSize.x, (coords.y + 1) * tileSize.y], coords.z);

      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;

      const latMin = se.lat;
      const latMax = nw.lat;
      const lngMin = nw.lng;
      const lngMax = se.lng;
      const latCenter = (latMin + latMax) / 2;
      const lngCenter = (lngMin + lngMax) / 2;

      const tileSnap = snapToTile(latCenter, lngCenter);
      const bounds = tileBounds(tileSnap.key);
      const parentLatSpan = bounds.ne[0] - bounds.sw[0];
      const parentLngSpan = bounds.ne[1] - bounds.sw[1];
      const subLatStep = parentLatSpan / CONFIG.SUB_GRID_SIZE;
      const subLngStep = parentLngSpan / CONFIG.SUB_GRID_SIZE;

      for (let i = 0; i <= CONFIG.SUB_GRID_SIZE; i++) {
        const lat = bounds.sw[0] + i * subLatStep;
        if (lat < latMin || lat > latMax) continue;
        const y = map.project([lat, lngCenter], coords.z).y - coords.y * tileSize.y;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(tileSize.x, y);
        ctx.stroke();
      }

      for (let i = 0; i <= CONFIG.SUB_GRID_SIZE; i++) {
        const lng = bounds.sw[1] + i * subLngStep;
        if (lng < lngMin || lng > lngMax) continue;
        const x = map.project([latCenter, lng], coords.z).x - coords.x * tileSize.x;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, tileSize.y);
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 2;
      const corners = [
        map.project([bounds.sw[0], bounds.sw[1]], coords.z),
        map.project([bounds.ne[0], bounds.ne[1]], coords.z)
      ];
      const rx = corners[0].x - coords.x * tileSize.x;
      const ry = corners[0].y - coords.y * tileSize.y;
      const rw = corners[1].x - corners[0].x;
      const rh = corners[1].y - corners[0].y;
      ctx.strokeRect(rx, ry, rw, rh);

      return tile;
    }
  });

  return new layer();
}

function updateGridVisibility() {
  if (!gridLayer) return;
  const z = map.getZoom();
  if (z >= CONFIG.GRID_ZOOM_THRESHOLD && z < CONFIG.SUB_GRID_ZOOM) {
    if (!map.hasLayer(gridLayer)) gridLayer.addTo(map);
  } else {
    if (map.hasLayer(gridLayer)) map.removeLayer(gridLayer);
  }
}

function updateSubGridVisibility() {
  if (map.getZoom() >= CONFIG.SUB_GRID_ZOOM) {
    if (!subGridLayer) {
      subGridLayer = createSubGridLayer();
    }
    if (!map.hasLayer(subGridLayer)) subGridLayer.addTo(map);
  } else {
    if (subGridLayer && map.hasLayer(subGridLayer)) {
      map.removeLayer(subGridLayer);
    }
  }
}

function showUserPosition(lat, lng) {
  if (userMarker) {
    userMarker.setLatLng([lat, lng]);
  } else {
    const icon = L.divIcon({
      className: 'pixel-pin-wrapper',
      html: '<div class="pixel-pin"><div class="pixel-pin-dot"></div><div class="pixel-pin-ring"></div></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    userMarker = L.marker([lat, lng], { icon, interactive: false, zIndexOffset: 1000 });
    userMarker.addTo(map);
  }
}

function hideUserPosition() {
  if (userMarker) {
    map.removeLayer(userMarker);
    userMarker = null;
  }
}

function createLocateButton() {
  const btn = document.createElement('button');
  btn.id = 'locate-btn';
  btn.title = 'Locate me';
  btn.innerHTML = '<div class="locate-icon"><div class="locate-icon-dot"></div></div>';
  btn.addEventListener('click', handleLocate);
  document.getElementById('map').appendChild(btn);
}

async function handleLocate() {
  const btn = document.getElementById('locate-btn');
  btn.classList.add('locating');

  const result = await getGeolocation(60000);

  btn.classList.remove('locating');

  if (result.status === 'granted') {
    map.setView([result.lat, result.lng], CONFIG.DEFAULT_ZOOM, { animate: true });
    showUserPosition(result.lat, result.lng);
    hideLocationBanner();
    localStorage.setItem('geo_pref', 'granted');
  } else if (result.status === 'denied') {
    localStorage.setItem('geo_pref', 'denied');
    showLocationBanner('Location blocked — check browser settings to paint where you are.');
    showToast('Location blocked — check browser settings');
  } else if (result.status === 'timeout') {
    showToast('Location timed out — try again');
  } else if (result.status === 'unavailable') {
    localStorage.setItem('geo_pref', 'skipped');
    showToast('Location unavailable on this device');
  } else {
    showToast('Location error');
  }
}

function handleMapClick(e) {
  const { lat, lng } = e.latlng;
  const color = getSelectedColor();

  if (map.getZoom() >= CONFIG.SUB_GRID_ZOOM) {
    const tile = snapToTile(lat, lng);
    const sub = snapToSubTile(tile.key, lat, lng);
    const subBounds = subTileBounds(tile.key, sub.subX, sub.subY);
    renderChildPixel(tile.key, sub.key, subBounds, color);

    writeChildPixel(tile.key, lat, lng, color).catch(err => {
      console.error('Failed to write child pixel:', err);
    });
  } else {
    const tile = snapToTile(lat, lng);
    renderPixel({ id: tile.key, lat: tile.lat, lng: tile.lng, color, hasChildren: false });

    writePixel(lat, lng, color).catch(err => {
      console.error('Failed to write pixel:', err);
    });
  }
}

function clearAllPixels() {
  for (const id of Object.keys(pixelLayers)) {
    map.removeLayer(pixelLayers[id]);
    delete pixelLayers[id];
  }
  for (const id of Object.keys(childLayers)) {
    if (Array.isArray(childLayers[id])) {
      for (const rect of childLayers[id]) map.removeLayer(rect);
    }
    delete childLayers[id];
  }
}

function renderPixels(pixels) {
  const parentIds = new Set(pixels.map(p => p.id));

  for (const id of Object.keys(pixelLayers)) {
    if (!parentIds.has(id)) {
      map.removeLayer(pixelLayers[id]);
      delete pixelLayers[id];
    }
  }

  for (const id of Object.keys(childLayers)) {
    if (!parentIds.has(id)) {
      for (const rect of childLayers[id]) map.removeLayer(rect);
      delete childLayers[id];
    }
  }

  for (const pixel of pixels) {
    if (pixel.hasChildren && pixel.children) {
      renderParentWithChildren(pixel);
    } else {
      renderPixel(pixel);
      if (childLayers[pixel.id] && !pixel.hasChildren) {
        for (const rect of childLayers[pixel.id]) map.removeLayer(rect);
        delete childLayers[pixel.id];
      }
    }
  }
}

function renderPixel(pixel) {
  const { id, color } = pixel;
  const bounds = tileBounds(id);

  if (pixelLayers[id]) {
    pixelLayers[id].setStyle({ fillColor: color, color: color });
  } else {
    const rect = L.rectangle([bounds.sw, bounds.ne], {
      color,
      fillColor: color,
      fillOpacity: 0.75,
      weight: 0,
      interactive: false
    });
    rect.addTo(map);
    pixelLayers[id] = rect;
  }
}

function renderParentWithChildren(pixel) {
  const bounds = tileBounds(pixel.id);

  if (!pixelLayers[pixel.id]) {
    const rect = L.rectangle([bounds.sw, bounds.ne], {
      color: pixel.color,
      fillColor: pixel.color,
      fillOpacity: 0.75,
      weight: 0,
      interactive: false
    });
    rect.addTo(map);
    pixelLayers[pixel.id] = rect;
  } else {
    pixelLayers[pixel.id].setStyle({ fillColor: pixel.color, color: pixel.color });
  }

  if (pixel.children && map.getZoom() >= CONFIG.SUB_GRID_ZOOM) {
    renderChildren(pixel.id, pixel.children);
  }
}

function renderChildren(parentId, children) {
  if (childLayers[parentId]) {
    for (const rect of childLayers[parentId]) map.removeLayer(rect);
  }
  childLayers[parentId] = [];

  for (const child of children) {
    const subBounds = subTileBounds(parentId, child.subX, child.subY);
    const rect = L.rectangle([subBounds.sw, subBounds.ne], {
      color: child.color,
      fillColor: child.color,
      fillOpacity: 0.85,
      weight: 0,
      interactive: false
    });
    rect.addTo(map);
    childLayers[parentId].push(rect);
  }
}

function renderChildPixel(parentId, childKey, subBounds, color) {
  if (!childLayers[parentId]) childLayers[parentId] = [];

  const existing = childLayers[parentId].find(r => {
    const b = r.getBounds();
    return Math.abs(b.getSouth() - subBounds.sw[0]) < 1e-10 &&
           Math.abs(b.getWest() - subBounds.sw[1]) < 1e-10;
  });

  if (existing) {
    existing.setStyle({ fillColor: color, color: color });
  } else {
    const rect = L.rectangle([subBounds.sw, subBounds.ne], {
      color,
      fillColor: color,
      fillOpacity: 0.85,
      weight: 0,
      interactive: false
    });
    rect.addTo(map);
    childLayers[parentId].push(rect);
  }
}

function removePixel(id) {
  if (pixelLayers[id]) {
    map.removeLayer(pixelLayers[id]);
    delete pixelLayers[id];
  }
  if (childLayers[id]) {
    for (const rect of childLayers[id]) map.removeLayer(rect);
    delete childLayers[id];
  }
}

function removeChildren(parentId) {
  if (childLayers[parentId]) {
    for (const rect of childLayers[parentId]) map.removeLayer(rect);
    delete childLayers[parentId];
  }
}

function updateBoundaryVisualization() {
  const lb = getLoadedBounds();
  if (!lb) return;

  const vb = getViewportBounds();

  if (boundaryRect) {
    map.removeLayer(boundaryRect);
    boundaryRect = null;
  }

  const isNearEdge =
    vb.n > lb.n - (lb.n - lb.s) * 0.2 ||
    vb.s < lb.s + (lb.n - lb.s) * 0.2 ||
    vb.e > lb.e - (lb.e - lb.w) * 0.2 ||
    vb.w < lb.w + (lb.e - lb.w) * 0.2;

  if (isNearEdge) {
    boundaryRect = L.rectangle(
      [[lb.s, lb.w], [lb.n, lb.e]],
      {
        color: 'rgba(255, 165, 0, 0.4)',
        fillColor: 'transparent',
        weight: 2,
        dashArray: '8 4',
        interactive: false
      }
    );
    boundaryRect.addTo(map);
  }
}
