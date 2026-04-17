let selectedColor = CONFIG.DEFAULT_COLOR;
let slowHintTimer = null;
let _refreshTimer = null;
let _toastTimer = null;
const LAST_GEO_KEY = 'last_geo';
const GEO_MAX_AGE_MS = 5 * 60 * 1000;
const PWA_STATE_KEY = 'pwa_install_state';
const PWA_RETRY_MS = [3, 14, 60].map(days => days * 24 * 60 * 60 * 1000);

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
  selectColor(CONFIG.DEFAULT_COLOR);
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (_toastTimer) {
    clearTimeout(_toastTimer);
    _toastTimer = null;
  }
  toast.classList.remove('has-action');
  toast.textContent = msg;
  toast.classList.add('visible');
  _toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    _toastTimer = null;
  }, CONFIG.TOAST_DURATION);
}

function hideToast() {
  if (_toastTimer) {
    clearTimeout(_toastTimer);
    _toastTimer = null;
  }
  const toast = document.getElementById('toast');
  toast.classList.remove('visible', 'has-action');
}

function showActionToast(msg, actionLabel, onAction, dismissLabel, onDismiss) {
  const toast = document.getElementById('toast');
  if (_toastTimer) {
    clearTimeout(_toastTimer);
    _toastTimer = null;
  }

  toast.classList.add('has-action');
  toast.textContent = '';

  const message = document.createElement('span');
  message.className = 'toast-message';
  message.textContent = msg;

  const actionBtn = document.createElement('button');
  actionBtn.className = 'toast-action';
  actionBtn.type = 'button';
  actionBtn.textContent = actionLabel;
  actionBtn.addEventListener('click', async () => {
    try {
      await onAction();
    } catch (err) {
      console.warn('Toast action failed:', err);
    }
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'toast-dismiss';
  dismissBtn.type = 'button';
  dismissBtn.textContent = dismissLabel;
  dismissBtn.addEventListener('click', () => {
    hideToast();
    if (onDismiss) onDismiss();
  });

  toast.appendChild(message);
  toast.appendChild(actionBtn);
  toast.appendChild(dismissBtn);
  toast.classList.add('visible');
}

function readPWAState() {
  const defaults = {
    dismissCount: 0,
    nextEligibleAt: 0,
    nativePromptAttempts: 0,
    installed: false
  };
  try {
    const raw = localStorage.getItem(PWA_STATE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      dismissCount: Number(parsed.dismissCount) || 0,
      nextEligibleAt: Number(parsed.nextEligibleAt) || 0,
      nativePromptAttempts: Number(parsed.nativePromptAttempts) || 0,
      installed: parsed.installed === true
    };
  } catch {
    return defaults;
  }
}

function writePWAState(state) {
  localStorage.setItem(PWA_STATE_KEY, JSON.stringify(state));
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
  }, CONFIG.SLOW_HINT_DELAY);
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
    timeout: CONFIG.GEO_FAST_TIMEOUT,
    enableHighAccuracy: false,
    maximumAge: GEO_MAX_AGE_MS
  });
  if (fastCached.status === 'granted') {
    return fastCached;
  }

  const requestedTimeout = timeout ?? CONFIG.GEO_DEFAULT_TIMEOUT;
  const mainTimeout = permState === 'granted'
    ? Math.min(requestedTimeout, CONFIG.GEO_GRANTED_TIMEOUT)
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
    timeout: CONFIG.GEO_RETRY_TIMEOUT,
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
  if (msgType === CONFIG.WS_TYPE_CLEAR_CHILDREN) {
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
  _refreshTimer = setTimeout(refreshViewport, CONFIG.VIEWPORT_DEBOUNCE_MS);
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

  // PWA install CTA: delayed, then shown after brief inactivity
  initPWAInstallPrompt(map);

  hideOverlay();
}

async function init() {
  initColorPicker();
  document.querySelector('.banner-close').addEventListener('click', hideLocationBanner);

  const geoPromise = (async () => {
    const vb = { n: CONFIG.DEFAULT_LAT + CONFIG.INIT_VIEWPORT_SPAN, s: CONFIG.DEFAULT_LAT - CONFIG.INIT_VIEWPORT_SPAN, e: CONFIG.DEFAULT_LNG + CONFIG.INIT_VIEWPORT_SPAN, w: CONFIG.DEFAULT_LNG - CONFIG.INIT_VIEWPORT_SPAN };
    return loadViewport(vb, CONFIG.DEFAULT_ZOOM);
  })();

  const pref = localStorage.getItem('geo_pref');

  const makeInitialPromise = (lat, lng) => {
    const vb = {
      n: lat + CONFIG.INIT_VIEWPORT_SPAN,
      s: lat - CONFIG.INIT_VIEWPORT_SPAN,
      e: lng + CONFIG.INIT_VIEWPORT_SPAN,
      w: lng - CONFIG.INIT_VIEWPORT_SPAN
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
      const result = await getGeolocation(CONFIG.GEO_GRANTED_TIMEOUT);
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
    const result = await getGeolocation(CONFIG.GEO_DEFAULT_TIMEOUT);
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
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone || !('serviceWorker' in navigator)) return;

  localStorage.removeItem('pwaPrompted');

  let pwaState = readPWAState();
  if (pwaState.installed) return;

  const INITIAL_DELAY = 18000;
  const INACTIVITY_DELAY = 3000;
  let initialTimer = null;
  let inactivityTimer = null;
  let listenersActive = false;
  let promptWindowOpen = false;
  let promptShownThisSession = false;
  let deferredInstallEvent = null;

  // All iOS browsers share the same Share › Add to Home Screen flow (iOS 16.4+), so no need to filter to Safari-only.
  const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  // macOS Safari 17+ (Sonoma+) supports File › Add to Dock; Chromium on macOS uses beforeinstallprompt instead.
  const isMacSafari = /Macintosh/.test(navigator.userAgent) &&
    /Safari\//.test(navigator.userAgent) &&
    !/Chrome|Chromium|Edg\/|OPR\//.test(navigator.userAgent);

  const MSG_INSTALL_NATIVE = 'Install Pixhood for faster launch and fullscreen mode.';
  const MSG_INSTALL_IOS    = 'On iOS: tap Share, then "Add to Home Screen"';
  const MSG_INSTALL_MAC    = 'On Mac: in Safari, File › Add to Dock';
  const MSG_HOW_IOS        = 'Tap the Share ↑ button, then "Add to Home Screen"';
  const MSG_HOW_MAC        = 'In Safari: File › Add to Dock, or use the Share button';

  function cleanupSession() {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    detachInactivityListeners();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.removeEventListener('appinstalled', onAppInstalled);
  }

  function isEligibleNow() {
    return Date.now() >= (pwaState.nextEligibleAt || 0);
  }

  function registerDismiss() {
    pwaState.dismissCount += 1;
    const cooldown = PWA_RETRY_MS[Math.min(pwaState.dismissCount - 1, PWA_RETRY_MS.length - 1)];
    pwaState.nextEligibleAt = Date.now() + cooldown;
    writePWAState(pwaState);
  }

  function registerInstalled() {
    pwaState.installed = true;
    pwaState.nextEligibleAt = 0;
    writePWAState(pwaState);
    hideToast();
  }

  function detachInactivityListeners() {
    if (!listenersActive) return;
    map.off('moveend', onInactivity);
    map.off('zoomend', onInactivity);
    map.off('click', onInactivity);
    listenersActive = false;
  }

  function showInstallCta() {
    if (promptShownThisSession || !promptWindowOpen || pwaState.installed || !isEligibleNow()) {
      return;
    }

    if (!deferredInstallEvent && !isIOSDevice && !isMacSafari) {
      return;
    }

    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }

    detachInactivityListeners();
    promptShownThisSession = true;

    let message, actionLabel, onAction;

    if (deferredInstallEvent) {
      message = MSG_INSTALL_NATIVE;
      actionLabel = 'Install';
      onAction = async () => {
        const promptEvent = deferredInstallEvent;
        deferredInstallEvent = null;

        pwaState.nativePromptAttempts += 1;
        writePWAState(pwaState);

        promptEvent.prompt();
        let outcome = 'dismissed';
        try {
          const choice = await promptEvent.userChoice;
          outcome = choice && choice.outcome ? choice.outcome : 'dismissed';
        } catch {
        }

        if (outcome === 'accepted') {
          registerInstalled();
        } else {
          registerDismiss();
          hideToast();
        }

        cleanupSession();
      };
    } else if (isIOSDevice) {
      message = MSG_INSTALL_IOS;
      actionLabel = 'How';
      onAction = async () => { showToast(MSG_HOW_IOS); cleanupSession(); };
    } else {
      message = MSG_INSTALL_MAC;
      actionLabel = 'How';
      onAction = async () => { showToast(MSG_HOW_MAC); cleanupSession(); };
    }

    showActionToast(message, actionLabel, onAction, 'Later', () => {
      registerDismiss();
      cleanupSession();
    });
  }

  function onInactivity() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      promptWindowOpen = true;
      showInstallCta();
    }, INACTIVITY_DELAY);
  }

  function onBeforeInstallPrompt(event) {
    event.preventDefault();
    deferredInstallEvent = event;
    if (promptWindowOpen) {
      showInstallCta();
    }
  }

  function onAppInstalled() {
    registerInstalled();
    cleanupSession();
  }

  function startInitialTimer() {
    if (initialTimer) clearTimeout(initialTimer);
    promptWindowOpen = false;
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
      promptWindowOpen = false;
      detachInactivityListeners();
      return;
    }

    startInitialTimer();
  }

  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  window.addEventListener('appinstalled', onAppInstalled);

  startInitialTimer();

  document.addEventListener('visibilitychange', onVisibilityChange);
}

document.addEventListener('DOMContentLoaded', init);
