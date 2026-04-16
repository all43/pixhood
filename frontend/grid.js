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

function subTileKey(parentKey, subX, subY) {
  return `${parentKey}_${subX}_${subY}`;
}

function subTileBounds(parentKey, subX, subY) {
  const bounds = tileBounds(parentKey);
  const parentLatSpan = bounds.ne[0] - bounds.sw[0];
  const parentLngSpan = bounds.ne[1] - bounds.sw[1];
  const subLatStep = parentLatSpan / CONFIG.SUB_GRID_SIZE;
  const subLngStep = parentLngSpan / CONFIG.SUB_GRID_SIZE;

  const swLat = bounds.sw[0] + subY * subLatStep;
  const swLng = bounds.sw[1] + subX * subLngStep;

  return {
    sw: [swLat, swLng],
    ne: [swLat + subLatStep, swLng + subLngStep]
  };
}

function snapToSubTile(parentKey, lat, lng) {
  const bounds = tileBounds(parentKey);
  const parentLatSpan = bounds.ne[0] - bounds.sw[0];
  const parentLngSpan = bounds.ne[1] - bounds.sw[1];
  const subLatStep = parentLatSpan / CONFIG.SUB_GRID_SIZE;
  const subLngStep = parentLngSpan / CONFIG.SUB_GRID_SIZE;

  const subX = Math.max(0, Math.min(CONFIG.SUB_GRID_SIZE - 1,
    Math.floor((lng - bounds.sw[1]) / subLngStep)));
  const subY = Math.max(0, Math.min(CONFIG.SUB_GRID_SIZE - 1,
    Math.floor((lat - bounds.sw[0]) / subLatStep)));

  const snappedLat = bounds.sw[0] + subY * subLatStep;
  const snappedLng = bounds.sw[1] + subX * subLngStep;

  return {
    subX,
    subY,
    lat: snappedLat,
    lng: snappedLng,
    key: subTileKey(parentKey, subX, subY)
  };
}
