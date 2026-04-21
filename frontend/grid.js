function tileKey(lat, lng) {
  const tx = Math.floor(CONFIG.lngToX(lng) / CONFIG.TILE_SIZE_M);
  const ty = Math.floor(CONFIG.latToY(lat) / CONFIG.TILE_SIZE_M);
  return `${tx}_${ty}`;
}

function snapToTile(lat, lng) {
  const tx = Math.floor(CONFIG.lngToX(lng) / CONFIG.TILE_SIZE_M);
  const ty = Math.floor(CONFIG.latToY(lat) / CONFIG.TILE_SIZE_M);
  return {
    lat: CONFIG.yToLat(ty * CONFIG.TILE_SIZE_M),
    lng: CONFIG.xToLng(tx * CONFIG.TILE_SIZE_M),
    key: `${tx}_${ty}`
  };
}

function tileBounds(key) {
  const parts = key.split('_');
  const tx = Number(parts[0]);
  const ty = Number(parts[1]);
  return {
    sw: [CONFIG.yToLat(ty * CONFIG.TILE_SIZE_M), CONFIG.xToLng(tx * CONFIG.TILE_SIZE_M)],
    ne: [CONFIG.yToLat((ty + 1) * CONFIG.TILE_SIZE_M), CONFIG.xToLng((tx + 1) * CONFIG.TILE_SIZE_M)]
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
