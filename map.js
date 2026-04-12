let map;
const pixelLayers = {}; // tileKey -> L.Rectangle

function initMap(lat, lng) {
  map = L.map('map', {
    center: [lat, lng],
    zoom: CONFIG.DEFAULT_ZOOM,
    zoomControl: true
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);

  map.on('click', handleMapClick);

  return map;
}

function handleMapClick(e) {
  const { lat, lng } = e.latlng;
  const color = getSelectedColor();
  const tile = snapToTile(lat, lng);

  // Optimistic render before Firestore confirms
  renderPixel({ id: tile.key, lat: tile.lat, lng: tile.lng, color });

  writePixel(lat, lng, color).catch(err => {
    console.error('Failed to write pixel:', err);
    // Could revert optimistic update here if needed
  });
}

function renderPixel(pixel) {
  const { id, lat, lng, color } = pixel;
  const bounds = [
    [lat, lng],
    [lat + CONFIG.TILE_SIZE, lng + CONFIG.TILE_SIZE]
  ];

  if (pixelLayers[id]) {
    pixelLayers[id].setStyle({ color, fillColor: color });
  } else {
    const rect = L.rectangle(bounds, {
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
