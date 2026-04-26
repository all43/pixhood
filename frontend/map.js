let map;
let gridLayer;
let subGridLayer;
let userMarker;
let boundaryRect;
const pixelLayers = {};
const childLayers = {};
const childrenCache = {};

function computeParentDisplay(children) {
  if (!children || children.length === 0) return { color: null, opacity: 0 };

  let r = 0, g = 0, b = 0;
  for (const c of children) {
    const hex = c.color;
    r += parseInt(hex.slice(1, 3), 16);
    g += parseInt(hex.slice(3, 5), 16);
    b += parseInt(hex.slice(5, 7), 16);
  }
  const n = children.length;
  const toHex = v => Math.round(v / n).toString(16).padStart(2, '0');
  const color = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  const totalCells = CONFIG.SUB_GRID_SIZE * CONFIG.SUB_GRID_SIZE;
  const opacity = Math.sqrt(n / totalCells);

  return { color, opacity };
}

function initMap(lat, lng) {
  map = L.map('map', {
    center: [lat, lng],
    zoom: CONFIG.DEFAULT_ZOOM,
    zoomControl: true,
    maxZoom: CONFIG.MAX_ZOOM
  });

  L.tileLayer(CONFIG.TILE_URL, {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: CONFIG.MAX_ZOOM,
    subdomains: CONFIG.TILE_SUBDOMAINS
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
  updateChildrenVisibility();
  const mapEl = document.getElementById('map');
  if (mapEl) {
    mapEl.classList.toggle('no-paint', map.getZoom() < CONFIG.GRID_ZOOM_THRESHOLD);
  }
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
      ctx.strokeStyle = CONFIG.GRID_COLOR;
      ctx.lineWidth = 1;

      const worldSize = 256 * Math.pow(2, coords.z);
      const spacing = CONFIG.TILE_SIZE_M * worldSize / (2 * CONFIG.R);
      const halfWorld = worldSize / 2;

      const startX = ((halfWorld - coords.x * tileSize.x) % spacing + spacing) % spacing;
      const startY = ((halfWorld - coords.y * tileSize.y) % spacing + spacing) % spacing;

      for (let x = startX; x <= tileSize.x; x += spacing) {
        const px = Math.round(x) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, tileSize.y);
        ctx.stroke();
      }

      for (let y = startY; y <= tileSize.y; y += spacing) {
        const py = Math.round(y) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(tileSize.x, py);
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
      const worldSize = 256 * Math.pow(2, coords.z);
      const parentSpacing = CONFIG.TILE_SIZE_M * worldSize / (2 * CONFIG.R);
      const subSpacing = parentSpacing / CONFIG.SUB_GRID_SIZE;
      const halfWorld = worldSize / 2;

      const subStartX = ((halfWorld - coords.x * tileSize.x) % subSpacing + subSpacing) % subSpacing;
      const subStartY = ((halfWorld - coords.y * tileSize.y) % subSpacing + subSpacing) % subSpacing;

      ctx.strokeStyle = CONFIG.SUB_GRID_COLOR;
      ctx.lineWidth = 1;

      for (let x = subStartX; x <= tileSize.x; x += subSpacing) {
        const px = Math.round(x) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, tileSize.y);
        ctx.stroke();
      }

      for (let y = subStartY; y <= tileSize.y; y += subSpacing) {
        const py = Math.round(y) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(tileSize.x, py);
        ctx.stroke();
      }

      ctx.strokeStyle = CONFIG.SUB_GRID_BORDER_COLOR;
      ctx.lineWidth = CONFIG.SUB_GRID_BORDER_WIDTH;

      const parentStartX = ((halfWorld - coords.x * tileSize.x) % parentSpacing + parentSpacing) % parentSpacing;
      const parentStartY = ((halfWorld - coords.y * tileSize.y) % parentSpacing + parentSpacing) % parentSpacing;

      for (let x = parentStartX; x <= tileSize.x; x += parentSpacing) {
        const px = Math.round(x) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, tileSize.y);
        ctx.stroke();
      }

      for (let y = parentStartY; y <= tileSize.y; y += parentSpacing) {
        const py = Math.round(y) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(tileSize.x, py);
        ctx.stroke();
      }

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

function updateChildrenVisibility() {
  if (map.getZoom() >= CONFIG.SUB_GRID_ZOOM) {
    for (const parentId of Object.keys(childrenCache)) {
      if (pixelLayers[parentId] && !childLayers[parentId]) {
        renderChildren(parentId, childrenCache[parentId]);
      }
    }
  } else {
    for (const parentId of Object.keys(childLayers)) {
      if (childLayers[parentId]) {
        for (const rect of childLayers[parentId]) map.removeLayer(rect);
        delete childLayers[parentId];
      }
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
  btn.addEventListener('click', e => {
    e.stopPropagation();
    handleLocate();
  });
  document.getElementById('app').appendChild(btn);
}

async function handleLocate() {
  const btn = document.getElementById('locate-btn');
  btn.classList.add('locating');

  const result = await getGeolocation(CONFIG.GEO_DEFAULT_TIMEOUT);

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
    localStorage.removeItem('geo_pref');
    showToast('Location timed out — try again');
  } else if (result.status === 'unavailable') {
    localStorage.setItem('geo_pref', 'skipped');
    showToast('Location unavailable on this device');
  } else {
    showToast('Location error');
  }
}

function handleMapClick(e) {
  if (map.getZoom() < CONFIG.GRID_ZOOM_THRESHOLD) return;
  const mapEl = document.getElementById('map');
  if (mapEl.classList.contains('region-select-mode') || mapEl.classList.contains('inspect-mode')) return;

  const { lat, lng } = e.latlng;
  const color = getSelectedColor();

  if (map.getZoom() >= CONFIG.SUB_GRID_ZOOM) {
    const tile = snapToTile(lat, lng);
    const sub = snapToSubTile(tile.key, lat, lng);
    const subBounds = subTileBounds(tile.key, sub.subX, sub.subY);
    renderChildPixel(tile.key, sub.key, subBounds, color);

    const childData = { subX: sub.subX, subY: sub.subY, color };
    if (!childrenCache[tile.key]) childrenCache[tile.key] = [];
    const idx = childrenCache[tile.key].findIndex(c => c.subX === sub.subX && c.subY === sub.subY);
    if (idx >= 0) {
      childrenCache[tile.key][idx] = childData;
    } else {
      childrenCache[tile.key].push(childData);
    }
    updateParentDisplay(tile.key);

    writeChildPixel(tile.key, lat, lng, color);
  } else {
    const tile = snapToTile(lat, lng);
    renderPixel({ id: tile.key, lat: tile.lat, lng: tile.lng, color, hasChildren: false });

    writePixel(lat, lng, color);
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
      delete childrenCache[id];
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
      childrenCache[pixel.id] = pixel.children;
      renderParentWithChildren(pixel);
    } else {
      renderPixel(pixel);
      if (childLayers[pixel.id]) {
        for (const rect of childLayers[pixel.id]) map.removeLayer(rect);
        delete childLayers[pixel.id];
      }
      delete childrenCache[pixel.id];
    }
  }
}

function renderPixel(pixel) {
  const { id, color } = pixel;
  const bounds = tileBounds(id);

  if (pixelLayers[id]) {
    pixelLayers[id].setStyle({ fillColor: color, color: color, fillOpacity: CONFIG.PIXEL_OPACITY });
  } else {
    const rect = L.rectangle([bounds.sw, bounds.ne], {
      color,
      fillColor: color,
      fillOpacity: CONFIG.PIXEL_OPACITY,
      weight: 0,
      interactive: false
    });
    rect.addTo(map);
    pixelLayers[id] = rect;
  }
}

function renderParentWithChildren(pixel) {
  const bounds = tileBounds(pixel.id);
  const display = computeParentDisplay(pixel.children);

  if (pixelLayers[pixel.id]) {
    pixelLayers[pixel.id].setStyle({ fillColor: display.color, color: display.color, fillOpacity: display.opacity });
  } else {
    const rect = L.rectangle([bounds.sw, bounds.ne], {
      color: display.color,
      fillColor: display.color,
      fillOpacity: display.opacity,
      weight: 0,
      interactive: false
    });
    rect.addTo(map);
    pixelLayers[pixel.id] = rect;
  }

  if (pixel.children && map.getZoom() >= CONFIG.SUB_GRID_ZOOM) {
    renderChildren(pixel.id, pixel.children);
  }
}

function updateParentDisplay(parentId) {
  const children = childrenCache[parentId];
  if (!children || children.length === 0) return;

  const display = computeParentDisplay(children);
  if (pixelLayers[parentId]) {
    pixelLayers[parentId].setStyle({ fillColor: display.color, color: display.color, fillOpacity: display.opacity });
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
      fillOpacity: CONFIG.CHILD_PIXEL_OPACITY,
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
      fillOpacity: CONFIG.CHILD_PIXEL_OPACITY,
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
  delete childrenCache[id];
}

function removeChildren(parentId) {
  if (childLayers[parentId]) {
    for (const rect of childLayers[parentId]) map.removeLayer(rect);
    delete childLayers[parentId];
  }
  delete childrenCache[parentId];
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
    vb.n > lb.n - (lb.n - lb.s) * CONFIG.BOUNDARY_EDGE_FRACTION ||
    vb.s < lb.s + (lb.n - lb.s) * CONFIG.BOUNDARY_EDGE_FRACTION ||
    vb.e > lb.e - (lb.e - lb.w) * CONFIG.BOUNDARY_EDGE_FRACTION ||
    vb.w < lb.w + (lb.e - lb.w) * CONFIG.BOUNDARY_EDGE_FRACTION;

  if (isNearEdge) {
    boundaryRect = L.rectangle(
      [[lb.s, lb.w], [lb.n, lb.e]],
      {
        color: CONFIG.BOUNDARY_COLOR,
        fillColor: 'transparent',
        weight: 2,
        dashArray: CONFIG.BOUNDARY_DASH,
        interactive: false
      }
    );
    boundaryRect.addTo(map);
  }
}
