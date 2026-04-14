let map;
let gridLayer;
let userMarker;
const pixelLayers = {};

function initMap(lat, lng) {
  map = L.map('map', {
    center: [lat, lng],
    zoom: CONFIG.DEFAULT_ZOOM,
    zoomControl: true
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
    subdomains: 'abcd'
  }).addTo(map);

  gridLayer = createGridLayer();
  gridLayer.addTo(map);
  updateGridVisibility();

  createLocateButton();

  map.on('zoomend', updateGridVisibility);
  map.on('click', handleMapClick);

  return map;
}

function createGridLayer() {
  const layer = L.GridLayer.extend({
    createTile: function(coords) {
      const tile = document.createElement('canvas');
      const tileSize = this.getTileSize();
      tile.width = tileSize.x;
      tile.height = tileSize.y;

      if (map.getZoom() < CONFIG.GRID_ZOOM_THRESHOLD) return tile;

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

function updateGridVisibility() {
  if (!gridLayer) return;
  if (map.getZoom() >= CONFIG.GRID_ZOOM_THRESHOLD) {
    if (!map.hasLayer(gridLayer)) gridLayer.addTo(map);
  } else {
    if (map.hasLayer(gridLayer)) map.removeLayer(gridLayer);
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
  const tile = snapToTile(lat, lng);

  renderPixel({ id: tile.key, lat: tile.lat, lng: tile.lng, color });

  writePixel(lat, lng, color).catch(err => {
    console.error('Failed to write pixel:', err);
  });
}

function renderPixel(pixel) {
  const { id, color } = pixel;
  const bounds = tileBounds(id);

  if (pixelLayers[id]) {
    pixelLayers[id].setStyle({ color, fillColor: color });
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

function removePixel(id) {
  if (pixelLayers[id]) {
    map.removeLayer(pixelLayers[id]);
    delete pixelLayers[id];
  }
}
