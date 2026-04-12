function tileKey(lat, lng) {
  const tLat = Math.floor(lat / CONFIG.TILE_SIZE);
  const tLng = Math.floor(lng / CONFIG.TILE_SIZE);
  return `${tLat}_${tLng}`;
}

function snapToTile(lat, lng) {
  const tLat = Math.floor(lat / CONFIG.TILE_SIZE);
  const tLng = Math.floor(lng / CONFIG.TILE_SIZE);
  return {
    lat: tLat * CONFIG.TILE_SIZE,
    lng: tLng * CONFIG.TILE_SIZE,
    key: `${tLat}_${tLng}`
  };
}

function tileBounds(key) {
  const parts = key.split('_');
  const tLat = Number(parts[0]);
  const tLng = Number(parts[1]);
  const lat = tLat * CONFIG.TILE_SIZE;
  const lng = tLng * CONFIG.TILE_SIZE;
  return {
    sw: [lat, lng],
    ne: [lat + CONFIG.TILE_SIZE, lng + CONFIG.TILE_SIZE]
  };
}
