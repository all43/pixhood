let selectedColor = CONFIG.DEFAULT_COLOR;
let slowHintTimer = null;
let _refreshTimer = null;
let _hasConnectedOnce = false;
let _undoCount = 0;
let _undoTimer = null;
let _undoToastItem = null;
const _paintLog = [];
const MAX_PAINT_LOG = 20;
const LAST_GEO_KEY = 'last_geo';
const GEO_MAX_AGE_MS = 5 * 60 * 1000;

const PWA_STATE_KEY = 'pwa_install_state';
const PWA_RETRY_MS = [3, 14, 60].map(days => days * 24 * 60 * 60 * 1000);
const _isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const _isMacSafari = /Macintosh/.test(navigator.userAgent) &&
  /Safari\//.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg\/|OPR\//.test(navigator.userAgent);
let _pwaDeferredEvent = null;

const SELECTED_COLOR_KEY = 'selected_color';

function getStoredSpaceKey(slug) {
  return lsGet(CONFIG.SPACE_KEY_PREFIX + slug);
}

function storeSpaceKey(slug, key) {
  lsSet(CONFIG.SPACE_KEY_PREFIX + slug, key);
}

function showCreateSpaceConfirmModal() {
  const existing = document.getElementById('create-space-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'create-space-modal';
  overlay.innerHTML = `
    <div class="create-space-box">
      <h2>Create a Space</h2>
      <div class="create-space-text">
        <p>A Space is a private area on the map — only people with the link can paint there. It's a safe way for friends, family, and especially children to create art together without interference.</p>
        <p>As the creator, you get extra controls: protect artwork from being overwritten, extend how long it lasts, and erase unwanted pixels.</p>
        <p>The Space link is the only way in. Share it only with people you want to paint with — anyone with the link can join. If the link gets out, simply abandon this Space and create a new one.</p>
      </div>
      <div id="create-space-error" class="hidden"></div>
      <div class="create-space-buttons">
        <button class="create-space-cancel" id="create-space-cancel">Cancel</button>
        <button class="create-space-go" id="create-space-go">Create Space</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('create-space-cancel').addEventListener('click', () => {
    overlay.remove();
  });

  document.getElementById('create-space-go').addEventListener('click', async () => {
    const goBtn = document.getElementById('create-space-go');
    const cancelBtn = document.getElementById('create-space-cancel');
    const errEl = document.getElementById('create-space-error');
    goBtn.disabled = true;
    goBtn.textContent = 'Creating\u2026';
    cancelBtn.disabled = true;

    try {
      const res = await fetch(`${CONFIG.API_URL}/spaces`, { method: 'POST' });
      if (!res.ok) throw new Error(res.status);
      const { slug, key } = await res.json();
      overlay.remove();
      if (key) {
        showSpaceKeyModal(slug, key);
      } else {
        location.href = `/s/${slug}`;
      }
    } catch {
      errEl.textContent = 'Could not create space \u2014 check your internet connection.';
      errEl.classList.remove('hidden');
      goBtn.disabled = false;
      goBtn.textContent = 'Create Space';
      cancelBtn.disabled = false;
    }
  });
}

function showSpaceKeyModal(slug, key) {
  const existing = document.getElementById('space-key-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'space-key-modal';
  const spaceLink = `${location.origin}/s/${slug}`;
  overlay.innerHTML = `
    <div class="space-key-box">
      <h2>Space Created!</h2>
      <div class="space-key-field">
        <label>Link</label>
        <input type="text" readonly value="${spaceLink}" id="space-key-link" />
        <button class="space-key-copy-btn" data-copy="link">Copy</button>
      </div>
      <div class="space-key-field">
        <label>Key</label>
        <input type="text" readonly value="${key}" id="space-key-value" />
        <button class="space-key-copy-btn" data-copy="key">Copy</button>
      </div>
      <div class="space-key-warning">
        Save this key — it <strong>cannot be recovered</strong> if lost. You'll need it to manage your space (protect, erase, inspect).
      </div>
      <div class="space-key-actions">
        <button id="space-key-download">Download Key File</button>
      </div>
      <label class="space-key-checkbox">
        <input type="checkbox" id="space-key-confirm" />
        I have saved my admin key (or I don't need it)
      </label>
      <button class="space-key-continue" id="space-key-go" disabled>Continue to Space</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const confirmBox = document.getElementById('space-key-confirm');
  const goBtn = document.getElementById('space-key-go');

  confirmBox.addEventListener('change', () => {
    goBtn.disabled = !confirmBox.checked;
  });

  overlay.querySelectorAll('.space-key-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.copy === 'key'
        ? document.getElementById('space-key-value')
        : document.getElementById('space-key-link');
      navigator.clipboard.writeText(target.value).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
      }).catch(() => {
        target.select();
        document.execCommand('copy');
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
      });
    });
  });

  document.getElementById('space-key-download').addEventListener('click', () => {
    const content = [
      'Pixhood Space Admin Key',
      '=======================',
      `Space: ${slug}`,
      `Link:   ${spaceLink}`,
      `Key:    ${key}`,
      '',
      'Keep this file safe. This key cannot be recovered if lost.'
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pixhood-space-${slug}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  goBtn.addEventListener('click', () => {
    if (goBtn.disabled) return;
    storeSpaceKey(slug, key);
    location.href = `/s/${slug}`;
  });
}

function getSelectedColor() {
  return selectedColor;
}

function selectColor(color) {
  selectedColor = color;
  lsSet(SELECTED_COLOR_KEY, color);
  document.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === color);
  });
}

function initColorPicker() {
  const palette = document.getElementById('palette');
  palette.textContent = '';

  const undoTile = document.createElement('div');
  undoTile.className = 'swatch swatch-tool swatch-undo disabled';
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

  const stored = lsGet(SELECTED_COLOR_KEY);
  if (stored) selectedColor = stored;
  if (!CONFIG.PALETTE.includes(selectedColor) && selectedColor !== CONFIG.ERASE_COLOR) {
    selectedColor = CONFIG.DEFAULT_COLOR;
  }
  selectColor(selectedColor);
}

function recordPaint(lat, lng) {
  _paintLog.push({ lat, lng });
  if (_paintLog.length > MAX_PAINT_LOG) _paintLog.shift();
  updateUndoButtonState();
}

function getViewportUndoCount() {
  const vb = typeof getViewportBounds === 'function' ? getViewportBounds() : null;
  if (!vb || _paintLog.length === 0) return 0;
  let count = 0;
  for (let i = _paintLog.length - 1; i >= 0; i--) {
    const p = _paintLog[i];
    if (p.lat >= vb.s && p.lat <= vb.n && p.lng >= vb.w && p.lng <= vb.e) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function updateUndoButtonState() {
  const btn = document.querySelector('.swatch-undo');
  if (!btn) return;
  btn.classList.toggle('disabled', getViewportUndoCount() === 0);
}

function handleUndoTap() {
  const available = getViewportUndoCount();
  if (available === 0) return;

  _undoCount++;
  const undoBtn = document.querySelector('.swatch-undo');
  if (undoBtn) {
    undoBtn.classList.remove('undo-flash');
    void undoBtn.offsetWidth;
    undoBtn.classList.add('undo-flash');
    undoBtn.addEventListener('animationend', () => undoBtn.classList.remove('undo-flash'), { once: true });
  }
  if (!_undoToastItem) {
    _undoToastItem = _createToastItem();
    _undoToastItem.classList.add('toast-undo');
  }
  _undoToastItem.textContent = `Undo ${Math.min(_undoCount, available)}`;
  if (_undoTimer) clearTimeout(_undoTimer);
  _undoTimer = setTimeout(() => {
    const count = Math.min(_undoCount, getViewportUndoCount());
    if (count > 0) {
      flashMap();
      sendUndoPaint(count);
      _paintLog.splice(-count);
    }
    _dismissToastItem(_undoToastItem);
    _undoToastItem = null;
    _undoCount = 0;
    _undoTimer = null;
    updateUndoButtonState();
  }, CONFIG.UNDO_DEBOUNCE_MS);
}

function flashMap() {
  const el = document.getElementById('map-flash');
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  el.addEventListener('animationend', () => el.classList.remove('flash'), { once: true });
}

function _createToastItem() {
  const container = document.getElementById('toast-container');
  const item = document.createElement('div');
  item.className = 'toast-item';
  container.appendChild(item);
  requestAnimationFrame(() => requestAnimationFrame(() => item.classList.add('visible')));
  return item;
}

function showToast(msg) {
  const container = document.getElementById('toast-container');
  const existing = Array.from(container.querySelectorAll('.toast-item')).find(
    el => el.textContent === msg && !el.classList.contains('has-action')
  );
  if (existing) {
    clearTimeout(existing._dismissTimer);
    existing._dismissTimer = setTimeout(() => {
      existing.classList.remove('visible');
      setTimeout(() => existing.remove(), 300);
    }, CONFIG.TOAST_DURATION);
    return;
  }
  const item = _createToastItem();
  item.textContent = msg;
  item._dismissTimer = setTimeout(() => {
    item.classList.remove('visible');
    setTimeout(() => item.remove(), 300);
  }, CONFIG.TOAST_DURATION);
}

function hideToast() {
  const container = document.getElementById('toast-container');
  container.querySelectorAll('.toast-item').forEach(item => {
    if (item._dismissTimer) clearTimeout(item._dismissTimer);
    item.classList.remove('visible', 'has-action');
    setTimeout(() => item.remove(), 300);
  });
}

function _dismissToastItem(item) {
  if (!item) return;
  if (item._dismissTimer) clearTimeout(item._dismissTimer);
  item.classList.remove('visible');
  setTimeout(() => item.remove(), 300);
}

function showActionToast(msg, actionLabel, onAction, dismissLabel, onDismiss) {
  const toast = _createToastItem();
  toast.classList.add('has-action');

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
    _dismissToastItem(toast);
    if (onDismiss) onDismiss();
  });

  toast.appendChild(message);
  toast.appendChild(actionBtn);
  toast.appendChild(dismissBtn);
  return toast;
}

function readPWAState() {
  const defaults = {
    dismissCount: 0,
    nextEligibleAt: 0,
    nativePromptAttempts: 0,
    installed: false
  };
  try {
    const raw = lsGet(PWA_STATE_KEY);
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
  lsSet(PWA_STATE_KEY, JSON.stringify(state));
}

function showWelcomeError(msg) {
  const el = document.getElementById('welcome-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideWelcomeError() {
  const el = document.getElementById('welcome-error');
  if (!el) return;
  el.classList.add('hidden');
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
      const raw = lsGet(LAST_GEO_KEY);
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
      lsSet(LAST_GEO_KEY, JSON.stringify({ lat, lng, savedAt: Date.now() }));
      lsSet(GEO_PREF_KEY, 'granted');
      break;
    case 'skipped':
      showLocationBanner('Painting in Berlin. Tap the locate button in the bottom-right corner to use your location.');
      break;
    case 'denied':
      showLocationBanner('Location blocked — check browser settings to paint where you are.');
      lsSet(GEO_PREF_KEY, 'denied');
      break;
    case 'unavailable':
      showToast('Location unavailable — showing Berlin');
      lsSet(GEO_PREF_KEY, 'skipped');
      break;
    case 'timeout':
      showLocationBanner('Location timed out — tap the locate button to retry.');
      lsRemove(GEO_PREF_KEY);
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
  renderProtectedBorders();
  renderTtlExtendedBorders();
}

async function onRegionsChanged() {
  await fetchProtectedRegions();
  renderProtectedBorders();
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

function onPaintError(reason, count, retryAfter, entry) {
  if (entry) {
    revertOptimisticPaint(entry);
  }

  if (reason === 'rate_limited') {
    showToast(`Slow down! Try again in ${retryAfter || 30}s`);
  } else if (reason === 'blocked') {
    showToast('Painting suspended — your session was flagged');
    scheduleViewportRefresh();
  } else if (reason === 'protected') {
    showToast('This area is protected');
  } else if (reason === 'timeout') {
    showToast('Paint may not have saved — server slow to respond');
  } else if (reason === 'no_viewport') {
    showToast('Connecting \u2014 try again in a moment');
  } else if (reason === 'disconnect') {
    showToast(`${count} paint(s) didn\u2019t save \u2014 reconnecting`);
    scheduleViewportRefresh();
  } else if (reason === 'no_connection') {
    showToast('Not connected \u2014 try again');
  } else {
    showToast('Paint failed to save');
  }
}

function onWSBlocked() {
  showToast('Your paints were reverted due to suspicious activity');
  scheduleViewportRefresh();
}

async function refreshViewport(force) {
  const vb = getViewportBounds();
  const zoom = getCurrentZoom();

  if (!force && !needsRefetch(vb)) {
    updateBoundaryVisualization();
    return;
  }

  try {
    const pixels = await loadViewport(vb, zoom);
    await renderPixels(pixels);
    sendViewport(vb);
    updateBoundaryVisualization();
  } catch (err) {
    console.error('Viewport refresh failed:', err);
    showToast('Could not refresh \u2014 check connection');
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
    await renderPixels(pixels);
    updateBoundaryVisualization();
  } catch (err) {
    console.error('Failed to load pixels:', err);
    showToast('Could not load pixels — check server');
  }

  setViewportReadyCallback(() => getViewportBounds());

  connectWebSocket(onWSPixel, onWSChild, onWSDelete, onPaintError, onWSBlocked, (status) => {
    if (status === 'disconnected') {
      showToast('Connection lost — reconnecting\u2026');
    } else if (status === 'connected') {
      if (!_hasConnectedOnce) {
        _hasConnectedOnce = true;
      } else {
        refreshViewport(true);
      }
    }
  }, onRegionsChanged);

  const vb = getViewportBounds();
  sendViewport(vb);

  map.on('moveend', () => {
    scheduleViewportRefresh();
    updateUndoButtonState();
  });
  map.on('zoomend', () => {
    scheduleViewportRefresh();
    updateUndoButtonState();
  });

  // PWA install CTA: delayed, then shown after brief inactivity
  initPWAInstallPrompt(map);

  hideOverlay();
}

function initSpaceUI() {
  document.getElementById('btn-create-space').addEventListener('click', () => {
    showCreateSpaceConfirmModal();
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
  const section = document.getElementById('menu-space-section');
  const slug = document.getElementById('menu-space-slug');
  const btn = document.getElementById('menu-btn-copy-space');
  const manageBtn = document.getElementById('menu-btn-manage-space');
  slug.textContent = CONFIG.SPACE;
  section.classList.remove('hidden');
  btn.addEventListener('click', () => {
    const url = `${location.origin}/s/${CONFIG.SPACE}`;
    navigator.clipboard.writeText(url).then(() => showToast('Link copied')).catch(() => {
      showToast(url);
    });
  });
  if (getStoredSpaceKey(CONFIG.SPACE) && manageBtn) {
    manageBtn.classList.remove('hidden');
    manageBtn.addEventListener('click', () => {
      document.body.classList.remove('menu-open');
      if (typeof window.openSpaceAdminPanel === 'function') {
        window.openSpaceAdminPanel();
      } else {
        loadAdmin();
      }
    });
  }
  const leaveBtn = document.getElementById('menu-btn-leave-space');
  if (leaveBtn) {
    leaveBtn.addEventListener('click', () => {
      location.href = '/';
    });
  }
}

function initMenu() {
  const menuBtn = document.getElementById('menu-btn');
  const backdrop = document.getElementById('menu-backdrop');
  const joinBtn = document.getElementById('menu-btn-join-space');
  const createBtn = document.getElementById('menu-btn-create-space');
  const joinForm = document.getElementById('menu-join-form');
  const joinInput = document.getElementById('menu-join-input');
  const joinGo = document.getElementById('menu-join-go');
  const joinBack = document.getElementById('menu-join-back');
  const installBtn = document.getElementById('menu-btn-install');
  const welcomeBtn = document.getElementById('menu-btn-welcome');

  welcomeBtn.addEventListener('click', () => {
    closeMenu();
    const loading = document.getElementById('loading');
    const welcome = document.getElementById('welcome');
    const spinner = document.getElementById('loading-spinner-screen');
    loading.classList.remove('hidden');
    welcome.classList.remove('hidden');
    spinner.classList.add('hidden');
    hideWelcomeError();
    document.getElementById('welcome-space-buttons').classList.remove('hidden');
    document.getElementById('join-space-form').classList.add('hidden');
  });

  function openMenu() {
    document.body.classList.add('menu-open');
    joinForm.classList.add('hidden');
    joinBtn.classList.remove('hidden');
    createBtn.classList.remove('hidden');
    updateInstallVisibility();
  }

  function closeMenu() {
    document.body.classList.remove('menu-open');
    joinForm.classList.add('hidden');
    joinBtn.classList.remove('hidden');
    createBtn.classList.remove('hidden');
  }

  menuBtn.addEventListener('click', () => {
    if (document.body.classList.contains('menu-open')) closeMenu();
    else openMenu();
  });

  backdrop.addEventListener('click', closeMenu);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('menu-open')) closeMenu();
  });

  createBtn.addEventListener('click', () => {
    closeMenu();
    showCreateSpaceConfirmModal();
  });

  joinBtn.addEventListener('click', () => {
    joinBtn.classList.add('hidden');
    createBtn.classList.add('hidden');
    joinForm.classList.remove('hidden');
    joinInput.value = '';
    joinInput.focus();
  });

  joinGo.addEventListener('click', () => {
    const val = joinInput.value.trim();
    const slug = parseSpaceSlug(val);
    if (slug) {
      location.href = `/s/${slug}`;
    } else {
      showToast('Invalid space code or link');
    }
  });

  joinInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') joinGo.click();
  });

  joinBack.addEventListener('click', () => {
    joinForm.classList.add('hidden');
    joinBtn.classList.remove('hidden');
    createBtn.classList.remove('hidden');
  });

  installBtn.addEventListener('click', async () => {
    if (_pwaDeferredEvent) {
      const promptEvent = _pwaDeferredEvent;
      _pwaDeferredEvent = null;
      promptEvent.prompt();
      let outcome = 'dismissed';
      try {
        const choice = await promptEvent.userChoice;
        outcome = choice && choice.outcome ? choice.outcome : 'dismissed';
      } catch {}
      if (outcome === 'accepted') {
        const s = readPWAState(); s.installed = true; writePWAState(s);
        showToast('App installed!');
        closeMenu();
      } else {
        const s = readPWAState();
        s.dismissCount += 1;
        const cooldown = PWA_RETRY_MS[Math.min(s.dismissCount - 1, PWA_RETRY_MS.length - 1)];
        s.nextEligibleAt = Date.now() + cooldown;
        writePWAState(s);
      }
    } else if (_isIOSDevice) {
      showToast('Tap Share \u2191 then "Add to Home Screen"');
      closeMenu();
    } else if (_isMacSafari) {
      showToast('In Safari: File \u203a Add to Dock');
      closeMenu();
    }
  });

  function updateInstallVisibility() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isStandalone) { installBtn.classList.add('hidden'); return; }
    const pwaState = readPWAState();
    if (pwaState.installed) { installBtn.classList.add('hidden'); return; }
    if (_pwaDeferredEvent || _isIOSDevice || _isMacSafari) {
      installBtn.classList.remove('hidden');
    } else {
      installBtn.classList.add('hidden');
    }
  }
}

async function init() {
  initColorPicker();
  document.querySelector('.banner-close').addEventListener('click', hideLocationBanner);
  initSpaceUI();
  initMenu();

  const geoPromise = (async () => {
    const vb = { n: CONFIG.DEFAULT_LAT + CONFIG.INIT_VIEWPORT_SPAN, s: CONFIG.DEFAULT_LAT - CONFIG.INIT_VIEWPORT_SPAN, e: CONFIG.DEFAULT_LNG + CONFIG.INIT_VIEWPORT_SPAN, w: CONFIG.DEFAULT_LNG - CONFIG.INIT_VIEWPORT_SPAN };
    return loadViewport(vb, CONFIG.DEFAULT_ZOOM);
  })();

  if (CONFIG.SPACE) {
    initSpaceIndicator();
    const pref = lsGet(GEO_PREF_KEY);
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

  const pref = lsGet(GEO_PREF_KEY);

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
      lsSet(GEO_PREF_KEY, 'denied');
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
        lsSet(GEO_PREF_KEY, 'denied');
        await proceedToMap({ status: 'denied' }, geoPromise);
      } else {
        lsRemove(GEO_PREF_KEY);
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
      lsSet(GEO_PREF_KEY, 'denied');
      await proceedToMap({ status: 'denied' }, geoPromise);
    } else {
      lsRemove(GEO_PREF_KEY);
      await proceedToMap({ status: 'timeout' }, geoPromise);
    }
  });

  document.getElementById('btn-skip-geo').addEventListener('click', async () => {
    lsSet(GEO_PREF_KEY, 'skipped');
    await proceedToMap({ status: 'skipped' }, geoPromise);
  });
}

async function initPWAInstallPrompt(map) {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone || !('serviceWorker' in navigator)) return;

  lsRemove('pwaPrompted');

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
  let pwaToastItem = null;

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
    _dismissToastItem(pwaToastItem);
    pwaToastItem = null;
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

    if (!_pwaDeferredEvent && !_isIOSDevice && !_isMacSafari) {
      return;
    }

    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }

    detachInactivityListeners();
    promptShownThisSession = true;

    let message, actionLabel, onAction;

    if (_pwaDeferredEvent) {
      message = MSG_INSTALL_NATIVE;
      actionLabel = 'Install';
      onAction = async () => {
        const promptEvent = _pwaDeferredEvent;
        _pwaDeferredEvent = null;

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
          _dismissToastItem(pwaToastItem);
          pwaToastItem = null;
        }

        cleanupSession();
      };
    } else if (_isIOSDevice) {
      message = MSG_INSTALL_IOS;
      actionLabel = 'How';
      onAction = async () => { showToast(MSG_HOW_IOS); cleanupSession(); };
    } else {
      message = MSG_INSTALL_MAC;
      actionLabel = 'How';
      onAction = async () => { showToast(MSG_HOW_MAC); cleanupSession(); };
    }

    hideLocationBanner();
    pwaToastItem = showActionToast(message, actionLabel, onAction, 'Later', () => {
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
    _pwaDeferredEvent = event;
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
