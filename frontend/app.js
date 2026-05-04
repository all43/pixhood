let selectedColor = CONFIG.DEFAULT_COLOR;
let slowHintTimer = null;
let _refreshTimer = null;
let _toastTimer = null;
let _undoCount = 0;
let _undoTimer = null;
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
  palette.textContent = '';

  const undoTile = document.createElement('div');
  undoTile.className = 'swatch swatch-tool swatch-undo';
  undoTile.dataset.color = '__undo__';
  undoTile.title = 'Undo';
  undoTile.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h6a4 4 0 0 1 4 4"/><path d="M6 5L3 8l3 3"/></svg>';
  undoTile.addEventListener('click', () => handleUndoTap());
  palette.appendChild(undoTile);

  const eraseTile = document.createElement('div');
  eraseTile.className = 'swatch swatch-tool swatch-erase';
  eraseTile.dataset.color = CONFIG.ERASE_COLOR;
  eraseTile.title = 'Erase';
  eraseTile.addEventListener('click', () => selectColor(CONFIG.ERASE_COLOR));
  palette.appendChild(eraseTile);

  CONFIG.PALETTE.forEach(color => {
    const swatch = document.createElement('div');
    swatch.className = 'swatch';
    swatch.style.backgroundColor = color;
    swatch.dataset.color = color;
    swatch.title = color;
    swatch.addEventListener('click', () => selectColor(color));
    palette.appendChild(swatch);
  });

  if (!CONFIG.PALETTE.includes(selectedColor) && selectedColor !== CONFIG.ERASE_COLOR) {
    selectedColor = CONFIG.DEFAULT_COLOR;
  }
  selectColor(selectedColor);
}

function handleUndoTap() {
  _undoCount++;
  if (_undoTimer) clearTimeout(_undoTimer);
  _undoTimer = setTimeout(() => {
    sendUndoPaint(_undoCount);
    _undoCount = 0;
    _undoTimer = null;
  }, CONFIG.UNDO_DEBOUNCE_MS);
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

async function getGeolocation(timeout, opts) {
  if (!navigator.geolocation) {
    return { status: 'unavailable' };
  }

  const forceFresh = opts && opts.forceFresh;

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

  if (!forceFresh) {
    const fastCached = await requestPosition({
      timeout: CONFIG.GEO_FAST_TIMEOUT,
      enableHighAccuracy: false,
      maximumAge: GEO_MAX_AGE_MS
    });
    if (fastCached.status === 'granted') {
      return fastCached;
    }

    const storedFreshEnough = storedGeo && (Date.now() - storedGeo.savedAt) < GEO_MAX_AGE_MS;
    if (storedFreshEnough) {
      console.info('[geo] using last known stored position (fallback)');
      return { status: 'granted', lat: storedGeo.lat, lng: storedGeo.lng };
    }
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

function onWSDelete(data) {
  removePixel(data.id);
}

function onPaintError(reason, count, retryAfter) {
  if (reason === 'rate_limited') {
    showToast(`Slow down! Try again in ${retryAfter || 30}s`);
  } else if (reason === 'blocked') {
    showToast('Painting suspended — your session was flagged');
  } else if (reason === 'no_viewport') {
    showToast('Connecting \u2014 try again in a moment');
    scheduleViewportRefresh();
  } else if (reason === 'timeout') {
    showToast('Paint may not have saved — server slow to respond');
    scheduleViewportRefresh();
  } else if (reason === 'disconnect') {
    showToast(`${count} paint(s) didn\u2019t save \u2014 reconnecting`);
    scheduleViewportRefresh();
  } else {
    showToast('Paint failed to save');
    scheduleViewportRefresh();
  }
}

function onWSBlocked() {
  showToast('Your paints were reverted due to suspicious activity');
  scheduleViewportRefresh();
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

  connectWebSocket(onWSPixel, onWSChild, onWSDelete, onPaintError, onWSBlocked);

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

function initSpaceUI() {
  document.getElementById('btn-create-space').addEventListener('click', async () => {
    try {
      const res = await fetch(`${CONFIG.API_URL}/spaces`, { method: 'POST' });
      if (!res.ok) throw new Error(res.status);
      const { slug } = await res.json();
      location.href = `/s/${slug}`;
    } catch {
      showToast('Failed to create space');
    }
  });

  document.getElementById('btn-join-space').addEventListener('click', () => {
    document.getElementById('welcome-space-buttons').classList.add('hidden');
    document.getElementById('join-space-form').classList.remove('hidden');
    document.getElementById('join-space-input').focus();
  });

  document.getElementById('btn-join-go').addEventListener('click', () => {
    const val = document.getElementById('join-space-input').value.trim();
    const slug = parseSpaceSlug(val);
    if (slug) {
      location.href = `/s/${slug}`;
    } else {
      showToast('Invalid space code or link');
    }
  });

  document.getElementById('btn-join-back').addEventListener('click', () => {
    document.getElementById('join-space-form').classList.add('hidden');
    document.getElementById('welcome-space-buttons').classList.remove('hidden');
  });

  document.getElementById('join-space-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join-go').click();
  });
}

function parseSpaceSlug(val) {
  try {
    const url = new URL(val);
    const m = url.pathname.match(/^\/s\/([a-zA-Z0-9]{12})$/);
    return m ? m[1] : null;
  } catch {}
  if (/^[a-zA-Z0-9]{12}$/.test(val)) return val;
  return null;
}

function initSpaceIndicator() {
  const indicator = document.getElementById('space-indicator');
  const label = document.getElementById('space-label');
  const btn = document.getElementById('btn-copy-space');
  label.textContent = CONFIG.SPACE;
  indicator.classList.remove('hidden');
  btn.addEventListener('click', () => {
    const url = `${location.origin}/s/${CONFIG.SPACE}`;
    navigator.clipboard.writeText(url).then(() => showToast('Link copied')).catch(() => {
      showToast(url);
    });
  });
}

async function init() {
  initColorPicker();
  document.querySelector('.banner-close').addEventListener('click', hideLocationBanner);
  initSpaceUI();

  const geoPromise = (async () => {
    const vb = { n: CONFIG.DEFAULT_LAT + CONFIG.INIT_VIEWPORT_SPAN, s: CONFIG.DEFAULT_LAT - CONFIG.INIT_VIEWPORT_SPAN, e: CONFIG.DEFAULT_LNG + CONFIG.INIT_VIEWPORT_SPAN, w: CONFIG.DEFAULT_LNG - CONFIG.INIT_VIEWPORT_SPAN };
    return loadViewport(vb, CONFIG.DEFAULT_ZOOM);
  })();

  if (CONFIG.SPACE) {
    initSpaceIndicator();
    const pref = localStorage.getItem('geo_pref');
    if (pref === 'denied') {
      await proceedToMap({ status: 'denied' }, geoPromise);
    } else if (pref === 'granted' || pref === 'skipped') {
      await proceedToMap({ status: pref }, geoPromise);
    } else {
      showSpinnerScreen('Waiting for location\u2026');
      const result = await getGeolocation(CONFIG.GEO_GRANTED_TIMEOUT);
      handleLocationResult(result);
      await proceedToMap(result, geoPromise);
    }
    return;
  }

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

    // geo_pref='granted' means the user said yes at least once. We only short-circuit
    // on explicit 'denied' — where calling getCurrentPosition would definitely fail.
    // 'prompt' doesn't mean the user changed their mind: it could be an expired
    // Safari day-grant or an iOS WebKit bug where the API always returns 'prompt'
    // regardless of the actual system permission. In either case getCurrentPosition
    // handles it correctly: returns silently if still granted, or shows the native
    // dialog again. No reason to clear geo_pref or show our welcome screen.
    if (permState === 'denied') {
      localStorage.setItem('geo_pref', 'denied');
      await proceedToMap({ status: 'denied' }, geoPromise);
      return;
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

async function initPWAInstallPrompt(map) {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone || !('serviceWorker' in navigator)) return;

  localStorage.removeItem('pwaPrompted');

  if (navigator.getInstalledRelatedApps) {
    const apps = await navigator.getInstalledRelatedApps();
    if (apps.some(a => a.platform === 'webapp')) {
      const s = readPWAState(); s.installed = true; writePWAState(s);
      return;
    }
  }

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

    hideLocationBanner();
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
