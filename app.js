let selectedColor = '#FF0000';
let slowHintTimer = null;
let _refreshTimer = null;

function getSelectedColor() {
  return selectedColor;
}

function selectColor(color) {
  selectedColor = color;
  document.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === color);
  });
}

function initColorPicker() {
  const palette = document.getElementById('palette');
  CONFIG.PALETTE.forEach(color => {
    const swatch = document.createElement('div');
    swatch.className = 'swatch';
    swatch.style.backgroundColor = color;
    swatch.dataset.color = color;
    swatch.title = color;
    swatch.addEventListener('click', () => selectColor(color));
    palette.appendChild(swatch);
  });
  selectColor('#FF0000');
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 3000);
}

function showLocationBanner(msg) {
  const banner = document.getElementById('location-banner');
  const text = banner.querySelector('.banner-text');
  text.textContent = msg;
  banner.classList.add('visible');
}

function hideLocationBanner() {
  document.getElementById('location-banner').classList.remove('visible');
}

function showSpinnerScreen(text) {
  document.getElementById('welcome').classList.add('hidden');
  document.getElementById('loading-spinner-screen').classList.remove('hidden');
  document.getElementById('loading-text').textContent = text;
  document.getElementById('loading-slow-hint').textContent = '';
}

function scheduleSlowHint() {
  clearSlowHint();
  slowHintTimer = setTimeout(() => {
    const hint = document.getElementById('loading-slow-hint');
    if (hint) hint.textContent = 'This can take a few seconds after inactivity\u2026';
  }, 1500);
}

function clearSlowHint() {
  if (slowHintTimer) {
    clearTimeout(slowHintTimer);
    slowHintTimer = null;
  }
}

function hideOverlay() {
  clearSlowHint();
  document.getElementById('loading').classList.add('hidden');
}

async function getGeolocation(timeout) {
  if (!navigator.geolocation) {
    return { status: 'unavailable' };
  }

  try {
    const result = await navigator.permissions.query({ name: 'geolocation' });
    console.info('[geo] permission state:', result.state);
    if (result.state === 'denied') {
      return { status: 'denied' };
    }
    if (result.state === 'prompt') {
      return { status: 'prompt' };
    }
  } catch {
  }

  const t0 = Date.now();
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => {
        console.info('[geo] acquired in', Date.now() - t0, 'ms');
        resolve({ status: 'granted', lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      err => {
        const map = { 1: 'denied', 2: 'unavailable', 3: 'timeout' };
        console.warn('[geo] failed after', Date.now() - t0, 'ms —', err.code, err.message);
        resolve({ status: map[err.code] || 'error' });
      },
      { timeout: timeout || 60000, enableHighAccuracy: false, maximumAge: 300000 }
    );
  });
}

function handleLocationResult(result) {
  const lat = result.lat || CONFIG.DEFAULT_LAT;
  const lng = result.lng || CONFIG.DEFAULT_LNG;

  switch (result.status) {
    case 'granted':
      showUserPosition(lat, lng);
      localStorage.setItem('geo_pref', 'granted');
      break;
    case 'skipped':
      showLocationBanner('Painting in Berlin. Tap the locate button in the bottom-right corner to use your location.');
      break;
    case 'denied':
      showLocationBanner('Location blocked — check browser settings to paint where you are.');
      localStorage.setItem('geo_pref', 'denied');
      break;
    case 'unavailable':
      showToast('Location unavailable — showing Berlin');
      localStorage.setItem('geo_pref', 'skipped');
      break;
    case 'timeout':
      showLocationBanner('Location timed out — tap the locate button to retry.');
      localStorage.removeItem('geo_pref');
      break;
    default:
      showToast('Location error — showing Berlin');
  }

  return { lat, lng };
}

function onWSPixel(data) {
  if (data.hasChildren === false) {
    removeChildren(data.id);
  }

  renderPixel(data);
}

function onWSChild(data, msgType) {
  if (msgType === 'clearChildren') {
    if (data.parentId) removeChildren(data.parentId);
    return;
  }

  if (!data.childPixel) return;

  const parentId = data.parentId;
  const child = data.childPixel;
  const subBounds = subTileBounds(parentId, child.subX, child.subY);

  const childData = { subX: child.subX, subY: child.subY, color: child.color };
  if (!childrenCache[parentId]) childrenCache[parentId] = [];
  const idx = childrenCache[parentId].findIndex(c => c.subX === child.subX && c.subY === child.subY);
  if (idx >= 0) {
    childrenCache[parentId][idx] = childData;
  } else {
    childrenCache[parentId].push(childData);
  }

  renderChildPixel(parentId, child.id || subTileKey(parentId, child.subX, child.subY), subBounds, child.color);
  updateParentDisplay(parentId);
}

async function refreshViewport() {
  const vb = getViewportBounds();
  const zoom = getCurrentZoom();

  if (!needsRefetch(vb)) {
    updateBoundaryVisualization();
    return;
  }

  try {
    const pixels = await loadViewport(vb, zoom);
    renderPixels(pixels);
    sendViewport(vb);
    updateBoundaryVisualization();
  } catch (err) {
    console.error('Viewport refresh failed:', err);
  }
}

function scheduleViewportRefresh() {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(refreshViewport, 300);
}

async function proceedToMap(geoResult, pixelsPromise) {
  const lat = geoResult.lat || CONFIG.DEFAULT_LAT;
  const lng = geoResult.lng || CONFIG.DEFAULT_LNG;
  initMap(lat, lng);
  handleLocationResult(geoResult);

  showSpinnerScreen('Loading pixels\u2026');
  scheduleSlowHint();

  try {
    const pixels = await pixelsPromise;
    renderPixels(pixels);
    updateBoundaryVisualization();
  } catch (err) {
    console.error('Failed to load pixels:', err);
    showToast('Could not load pixels — check server');
  }

  connectWebSocket(onWSPixel, onWSChild);

  const vb = getViewportBounds();
  sendViewport(vb);

  map.on('moveend', () => {
    scheduleViewportRefresh();
  });
  map.on('zoomend', () => {
    scheduleViewportRefresh();
  });

  hideOverlay();
}

async function init() {
  initColorPicker();
  document.querySelector('.banner-close').addEventListener('click', hideLocationBanner);

  const geoPromise = (async () => {
    const vb = { n: CONFIG.DEFAULT_LAT + 0.01, s: CONFIG.DEFAULT_LAT - 0.01, e: CONFIG.DEFAULT_LNG + 0.01, w: CONFIG.DEFAULT_LNG - 0.01 };
    return loadViewport(vb, CONFIG.DEFAULT_ZOOM);
  })();

  const pref = localStorage.getItem('geo_pref');

  const makeInitialPromise = (lat, lng) => {
    const vb = {
      n: lat + 0.01,
      s: lat - 0.01,
      e: lng + 0.01,
      w: lng - 0.01
    };
    return loadViewport(vb, CONFIG.DEFAULT_ZOOM);
  };

  if (pref === 'granted') {
    let permState = 'granted';
    try {
      const result = await navigator.permissions.query({ name: 'geolocation' });
      permState = result.state;
    } catch {
    }

    if (permState === 'prompt') {
      localStorage.removeItem('geo_pref');
    } else {
      showSpinnerScreen('Waiting for location\u2026');
      const result = await getGeolocation(10000);
      if (result.status === 'granted') {
        const lat = result.lat || CONFIG.DEFAULT_LAT;
        const lng = result.lng || CONFIG.DEFAULT_LNG;
        await proceedToMap(result, makeInitialPromise(lat, lng));
      } else if (result.status === 'denied') {
        localStorage.setItem('geo_pref', 'denied');
        await proceedToMap({ status: 'denied' }, geoPromise);
      } else {
        localStorage.removeItem('geo_pref');
        await proceedToMap({ status: 'timeout' }, geoPromise);
      }
      return;
    }
  }

  if (pref === 'skipped') {
    await proceedToMap({ status: 'skipped' }, geoPromise);
    return;
  }

  if (pref === 'denied') {
    await proceedToMap({ status: 'denied' }, geoPromise);
    return;
  }

  document.getElementById('btn-enable-geo').addEventListener('click', async () => {
    showSpinnerScreen('Waiting for location\u2026');
    const result = await getGeolocation(60000);
    if (result.status === 'granted') {
      const lat = result.lat || CONFIG.DEFAULT_LAT;
      const lng = result.lng || CONFIG.DEFAULT_LNG;
      await proceedToMap(result, makeInitialPromise(lat, lng));
    } else if (result.status === 'denied') {
      localStorage.setItem('geo_pref', 'denied');
      await proceedToMap({ status: 'denied' }, geoPromise);
    } else if (result.status === 'prompt') {
      proceedToMap({ status: 'skipped' }, geoPromise);
    } else {
      localStorage.removeItem('geo_pref');
      await proceedToMap({ status: 'timeout' }, geoPromise);
    }
  });

  document.getElementById('btn-skip-geo').addEventListener('click', async () => {
    localStorage.setItem('geo_pref', 'skipped');
    await proceedToMap({ status: 'skipped' }, geoPromise);
  });
}

document.addEventListener('DOMContentLoaded', init);
