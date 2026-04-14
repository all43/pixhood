function tileKey(lat, lng) {
  const tLat = Math.floor(lat / CONFIG.TILE_SIZE);
  const tLng = Math.floor(lng / CONFIG.LNG_STEP);
  return `${tLat}_${tLng}`;
}

function snapToTile(lat, lng) {
  const tLat = Math.floor(lat / CONFIG.TILE_SIZE);
  const tLng = Math.floor(lng / CONFIG.LNG_STEP);
  return {
    lat: tLat * CONFIG.TILE_SIZE,
    lng: tLng * CONFIG.LNG_STEP,
    key: `${tLat}_${tLng}`
  };
}

function tileBounds(key) {
  const parts = key.split('_');
  const tLat = Number(parts[0]);
  const tLng = Number(parts[1]);
  return {
    sw: [tLat * CONFIG.TILE_SIZE, tLng * CONFIG.LNG_STEP],
    ne: [(tLat + 1) * CONFIG.TILE_SIZE, (tLng + 1) * CONFIG.LNG_STEP]
  };
}
