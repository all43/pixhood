let selectedColor = '#FF0000';
let slowHintTimer = null;
let _refreshTimer = null;
const LAST_GEO_KEY = 'last_geo';
const GEO_MAX_AGE_MS = 5 * 60 * 1000;

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

  const storedGeo = (() => {
    try {
      const raw = localStorage.getItem(LAST_GEO_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed.lat !== 'number' || typeof parsed.lng !== 'number') return null;
      const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : 0;
      return { lat: parsed.lat, lng: parsed.lng, savedAt };
    } catch {
      return null;
    }
  })();

  let permState = 'unknown';
  try {
    const result = await navigator.permissions.query({ name: 'geolocation' });
    permState = result.state;
    console.info('[geo] permission state:', permState);
    if (permState === 'denied') {
      return { status: 'denied' };
    }

  } catch {
  }

  const requestPosition = opts => {
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
        opts
      );
    });
  };

  // Chrome can intermittently fail immediately after reload.
  // First, try quickly with normal cache settings.
  const fastCached = await requestPosition({
    timeout: 2000,
    enableHighAccuracy: false,
    maximumAge: GEO_MAX_AGE_MS
  });
  if (fastCached.status === 'granted') {
    return fastCached;
  }

  const requestedTimeout = timeout ?? 60000;
  const mainTimeout = permState === 'granted'
    ? Math.min(requestedTimeout, 10000)
    : requestedTimeout;
  const fresh = await requestPosition({
    timeout: mainTimeout,
    enableHighAccuracy: false,
    maximumAge: 0
  });
  if (fresh.status === 'granted' || fresh.status === 'denied') {
    return fresh;
  }

  const storedFreshEnough = storedGeo && (Date.now() - storedGeo.savedAt) < GEO_MAX_AGE_MS;
  if (storedFreshEnough && fresh.status !== 'denied') {
    console.info('[geo] using last known stored position (fallback)');
    return { status: 'granted', lat: storedGeo.lat, lng: storedGeo.lng };
  }

  // Final short cached retry for transient Chrome provider failures.
  const retryCached = await requestPosition({
    timeout: 3000,
    enableHighAccuracy: false,
    maximumAge: GEO_MAX_AGE_MS
  });
  if (retryCached.status === 'granted') {
    return retryCached;
  }

  return fresh;

}

function handleLocationResult(result) {
  const lat = result.lat || CONFIG.DEFAULT_LAT;
  const lng = result.lng || CONFIG.DEFAULT_LNG;

  switch (result.status) {
    case 'granted':
      showUserPosition(lat, lng);
      localStorage.setItem(LAST_GEO_KEY, JSON.stringify({ lat, lng, savedAt: Date.now() }));
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

  setViewportReadyCallback(() => getViewportBounds());

  connectWebSocket(onWSPixel, onWSChild);

  const vb = getViewportBounds();
  sendViewport(vb);

  map.on('moveend', () => {
    scheduleViewportRefresh();
  });
  map.on('zoomend', () => {
    scheduleViewportRefresh();
  });

  // PWA install prompt: 42s timer starts on first interaction, resets on visibility change
  initPWAInstallPrompt(map);

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

function initPWAInstallPrompt(map) {
  const prompted = localStorage.getItem('pwaPrompted');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (prompted || isStandalone || !('serviceWorker' in navigator)) return;

  const INITIAL_DELAY = 42000;
  const INACTIVITY_DELAY = 5000;
  let initialTimer = null;
  let inactivityTimer = null;
  let listenersActive = false;

  function detachInactivityListeners() {
    if (!listenersActive) return;
    map.off('moveend', onInactivity);
    map.off('zoomend', onInactivity);
    map.off('click', onInactivity);
    listenersActive = false;
  }

  function showPrompt() {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    detachInactivityListeners();
    showToast('Install app for better experience');
    localStorage.setItem('pwaPrompted', 'true');
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  function onInactivity() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(showPrompt, INACTIVITY_DELAY);
  }

  function startInitialTimer() {
    if (initialTimer) clearTimeout(initialTimer);
    initialTimer = setTimeout(() => {
      if (!listenersActive) {
        map.on('moveend', onInactivity);
        map.on('zoomend', onInactivity);
        map.on('click', onInactivity);
        listenersActive = true;
      }
      onInactivity();
    }, INITIAL_DELAY);
  }

  function onVisibilityChange() {
    if (document.hidden) {
      if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = null;
      }
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
      detachInactivityListeners();
      return;
    }

    startInitialTimer();
  }

  startInitialTimer();

  document.addEventListener('visibilitychange', onVisibilityChange);
}

document.addEventListener('DOMContentLoaded', init);
