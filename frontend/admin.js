const ADMIN_TOKEN_KEY = 'admin_token';
let _adminToken = sessionStorage.getItem(ADMIN_TOKEN_KEY);
let _inspectMode = false;
let _activeRegionDraw = null;

const REGION_MODES = {
  erase: {
    btnId: 'admin-region-btn',
    infoId: 'admin-region-info',
    defaultLabel: 'Erase Region',
    activeLabel: 'Cancel Selection',
    hint: 'Click and drag on the map to select a region',
    rectStyle: { color: '#e94560', fillColor: '#e94560', fillOpacity: 0.15, weight: 2, dashArray: '6 4', interactive: false },
    confirmText: 'Erase all pixels in this region?',
    loadingText: 'Erasing...',
    failText: 'Erase failed',
    async makeRequest(n, s, e, w) {
      const res = await adminFetch(`/admin/region?n=${n}&s=${s}&e=${e}&w=${w}`, { method: 'DELETE' });
      return res;
    },
    formatResult(data) { return `Erased ${data.deleted} pixels`; }
  },
  protect: {
    btnId: 'admin-protect-btn',
    infoId: 'admin-protect-info',
    defaultLabel: 'Protect Region',
    activeLabel: 'Cancel',
    hint: 'Click and drag on the map to select a region to protect',
    rectStyle: { color: '#FFD700', fillColor: '#FFD700', fillOpacity: 0.15, weight: 2, dashArray: '6 4', interactive: false },
    confirmText: 'Protect all pixels in this region?',
    loadingText: 'Protecting...',
    failText: 'Protect failed',
    async makeRequest(n, s, e, w) {
      const body = { n, s, e, w };
      if (CONFIG.SPACE) body.space = CONFIG.SPACE;
      return await adminFetch('/admin/protect', { method: 'POST', body: JSON.stringify(body) });
    },
    formatResult(data) { return `Protected ${data.protected} pixels`; }
  },
  extend: {
    btnId: 'admin-extend-ttl-btn',
    infoId: 'admin-extend-ttl-info',
    defaultLabel: 'Extend TTL',
    activeLabel: 'Cancel',
    hint: 'Click and drag on the map to select a region to extend TTL (30 days)',
    rectStyle: { color: 'rgba(100,150,255,0.8)', fillColor: 'rgba(100,150,255,0.15)', fillOpacity: 0.15, weight: 2, dashArray: '6 4', interactive: false },
    confirmText: 'Extend TTL to 30 days for all pixels in this region?',
    loadingText: 'Extending TTL...',
    failText: 'Extend TTL failed',
    async makeRequest(n, s, e, w) {
      const body = { n, s, e, w };
      if (CONFIG.SPACE) body.space = CONFIG.SPACE;
      return await adminFetch('/admin/extend-ttl', { method: 'POST', body: JSON.stringify(body) });
    },
    formatResult(data) { return `Extended ${data.extended} pixels`; }
  }
};

let _regionDrawStart = null;
let _regionDrawRect = null;

function activateRegionMode(modeKey) {
  if (_activeRegionDraw) deactivateRegionMode();
  if (_inspectMode) disableInspectMode();

  const mode = REGION_MODES[modeKey];
  _activeRegionDraw = modeKey;

  const btn = document.getElementById(mode.btnId);
  const info = document.getElementById(mode.infoId);
  btn.textContent = mode.activeLabel;
  btn.classList.add('active');
  info.textContent = mode.hint;

  const mapEl = document.getElementById('map');
  mapEl.classList.add('region-select-mode');

  if (typeof map !== 'undefined') {
    map.dragging.disable();
    map.getContainer().addEventListener('mousedown', onRegionDrawStart);
    map.getContainer().addEventListener('mousemove', onRegionDrawMove);
    map.getContainer().addEventListener('mouseup', onRegionDrawEnd);
  }
}

function deactivateRegionMode() {
  if (!_activeRegionDraw) return;
  const mode = REGION_MODES[_activeRegionDraw];
  _activeRegionDraw = null;

  const btn = document.getElementById(mode.btnId);
  const info = document.getElementById(mode.infoId);
  btn.textContent = mode.defaultLabel;
  btn.classList.remove('active');
  info.textContent = '';

  const mapEl = document.getElementById('map');
  mapEl.classList.remove('region-select-mode');

  if (typeof map !== 'undefined') {
    map.dragging.enable();
    map.getContainer().removeEventListener('mousedown', onRegionDrawStart);
    map.getContainer().removeEventListener('mousemove', onRegionDrawMove);
    map.getContainer().removeEventListener('mouseup', onRegionDrawEnd);
  }

  if (_regionDrawRect) {
    map.removeLayer(_regionDrawRect);
    _regionDrawRect = null;
  }
}

function onRegionDrawStart(e) {
  if (!_activeRegionDraw || typeof map === 'undefined') return;
  _regionDrawStart = map.mouseEventToLatLng(e);
  if (_regionDrawRect) {
    map.removeLayer(_regionDrawRect);
    _regionDrawRect = null;
  }
}

function onRegionDrawMove(e) {
  if (!_activeRegionDraw || !_regionDrawStart || typeof map === 'undefined') return;
  const end = map.mouseEventToLatLng(e);
  const bounds = L.latLngBounds(_regionDrawStart, end);
  const mode = REGION_MODES[_activeRegionDraw];
  if (_regionDrawRect) {
    _regionDrawRect.setBounds(bounds);
  } else {
    _regionDrawRect = L.rectangle(bounds, mode.rectStyle).addTo(map);
  }
}

async function onRegionDrawEnd(e) {
  if (!_activeRegionDraw || !_regionDrawStart || typeof map === 'undefined') return;
  const mode = REGION_MODES[_activeRegionDraw];
  const end = map.mouseEventToLatLng(e);
  const bounds = L.latLngBounds(_regionDrawStart, end);
  _regionDrawStart = null;

  const n = bounds.getNorth();
  const s = bounds.getSouth();
  const eLng = bounds.getEast();
  const w = bounds.getWest();

  const info = document.getElementById(mode.infoId);
  info.textContent = `Selected: ${((n - s) * 111).toFixed(0)}m × ${(((eLng - w) * 111 * Math.cos((n + s) / 2 * Math.PI / 180))).toFixed(0)}m`;

  if (!confirm(mode.confirmText)) {
    info.textContent = 'Cancelled';
    return;
  }

  info.textContent = mode.loadingText;

  try {
    const res = await mode.makeRequest(n, s, eLng, w);
    if (res && res.ok) {
      const data = await res.json();
      info.textContent = mode.formatResult(data);
      if (typeof refreshViewport === 'function') refreshViewport();
    } else {
      info.textContent = mode.failText;
    }
  } catch {
    info.textContent = mode.failText;
  }

  deactivateRegionMode();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeColor(c) {
  return /^#[0-9a-f]{6}$/i.test(c) ? c : '#666666';
}

function adminHeaders() {
  return { 'Authorization': `Bearer ${_adminToken}`, 'Content-Type': 'application/json' };
}

async function adminFetch(path, options = {}) {
  const res = await fetch(`${CONFIG.API_URL}${path}`, { ...options, headers: { ...adminHeaders(), ...(options.headers || {}) } });
  if (res.status === 401) {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    _adminToken = null;
    const panel = document.getElementById('admin-panel');
    if (panel) panel.remove();
    showTokenPrompt('Token expired or invalid — please re-enter');
    return null;
  }
  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    _adminToken = null;
    const panel = document.getElementById('admin-panel');
    if (panel) panel.remove();
    showTokenPrompt(`Too many failed attempts. Try again in ${data.retryAfter || 900}s`);
    return null;
  }
  return res;
}

async function verifyToken(token) {
  try {
    const res = await fetch(`${CONFIG.API_URL}/admin/verify`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (res.status === 429) {
      const data = await res.json();
      return { valid: false, locked: true, retryAfter: data.retryAfter };
    }
    if (res.status === 403) {
      const data = await res.json();
      return { valid: false, error: data.error };
    }
    const data = await res.json();
    return data;
  } catch {
    return { valid: false };
  }
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function createAdminPanel() {
  const panel = document.createElement('div');
  panel.id = 'admin-panel';
  panel.innerHTML = `
    <div class="admin-header">
      <span class="admin-title">Admin</span>
      <button class="admin-close" id="admin-close">&times;</button>
    </div>
    <div class="admin-section">
      <h3>Tools</h3>
      <div class="admin-tools">
        <button class="admin-btn" id="admin-inspect-btn">Inspect Pixels</button>
        <button class="admin-btn admin-btn-protect" id="admin-protect-btn">Protect Region</button>
        <button class="admin-btn admin-btn-extend" id="admin-extend-ttl-btn">Extend TTL</button>
        <button class="admin-btn admin-btn-danger" id="admin-region-btn">Erase Region</button>
      </div>
      <div id="admin-inspect-info" class="admin-mode-info"></div>
      <div id="admin-protect-info" class="admin-mode-info"></div>
      <div id="admin-extend-ttl-info" class="admin-mode-info"></div>
      <div id="admin-region-info" class="admin-mode-info"></div>
    </div>
    <div class="admin-section">
      <h3>Sessions</h3>
      <button class="admin-btn" id="admin-load-sessions">Load Active Sessions</button>
      <div id="admin-sessions-list" class="admin-list"></div>
    </div>
    <div class="admin-section admin-section-collapsible">
      <h3 class="admin-collapsible-toggle" id="admin-flagged-toggle">Flagged Sessions ▸</h3>
      <div id="admin-flagged-list" class="admin-list admin-collapsible-content"></div>
    </div>
    <div class="admin-section">
      <h3>Session Inspector</h3>
      <input type="text" id="admin-session-input" placeholder="Paste session ID" class="admin-input" />
      <button class="admin-btn" id="admin-lookup">Lookup</button>
      <div id="admin-session-detail" class="admin-list"></div>
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById('admin-close').addEventListener('click', () => {
    panel.remove();
    disableInspectMode();
    if (_activeRegionDraw) deactivateRegionMode();
  });

  document.getElementById('admin-load-sessions').addEventListener('click', loadSessions);
  document.getElementById('admin-lookup').addEventListener('click', lookupSession);
  document.getElementById('admin-inspect-btn').addEventListener('click', toggleInspectMode);
document.getElementById('admin-protect-btn').addEventListener('click', () => {
  if (_activeRegionDraw === 'protect') deactivateRegionMode();
  else activateRegionMode('protect');
});
document.getElementById('admin-extend-ttl-btn').addEventListener('click', () => {
  if (_activeRegionDraw === 'extend') deactivateRegionMode();
  else activateRegionMode('extend');
});
document.getElementById('admin-region-btn').addEventListener('click', () => {
  if (_activeRegionDraw === 'erase') deactivateRegionMode();
  else activateRegionMode('erase');
});
  document.getElementById('admin-flagged-toggle').addEventListener('click', toggleFlaggedSection);
}

function toggleFlaggedSection() {
  const content = document.getElementById('admin-flagged-list');
  const toggle = document.getElementById('admin-flagged-toggle');
  if (!content || !toggle) return;
  const open = content.classList.toggle('visible');
  toggle.textContent = `Flagged Sessions ${open ? '▾' : '▸'}`;
  if (open && content.children.length === 0) loadFlagged();
}

async function loadSessions() {
  const list = document.getElementById('admin-sessions-list');
  const btn = document.getElementById('admin-load-sessions');
  if (!list || !btn) return;
  btn.disabled = true;
  btn.textContent = 'Loading...';
  list.textContent = '';

  const res = await adminFetch('/admin/sessions');
  if (!res) { btn.disabled = false; btn.textContent = 'Load Active Sessions'; return; }

  if (!res.ok) {
    list.textContent = 'Failed to load';
    btn.disabled = false;
    btn.textContent = 'Load Active Sessions';
    return;
  }

  const { sessions } = await res.json();
  btn.disabled = false;
  btn.textContent = `Refresh (${sessions.length})`;

  if (sessions.length === 0) {
    list.innerHTML = '<div class="admin-empty">No active sessions</div>';
    return;
  }

  list.innerHTML = sessions.map(s =>
    `<div class="admin-session-row">
      <span class="admin-session-id" data-session="${escapeHtml(s.sessionId)}">${escapeHtml(s.sessionId)}</span>
      <span class="admin-session-meta">${s.paintCount} paints · ${relativeTime(s.lastPaintAt)}</span>
      <button class="admin-btn-sm admin-locate-btn" data-lat="${s.lastLat}" data-lng="${s.lastLng}" title="Locate">⦿</button>
    </div>`
  ).join('');

  list.querySelectorAll('[data-session]').forEach(el => {
    el.addEventListener('click', () => {
      const input = document.getElementById('admin-session-input');
      if (input) { input.value = el.dataset.session; lookupSession(); }
    });
  });

  list.querySelectorAll('.admin-locate-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lat = parseFloat(btn.dataset.lat);
      const lng = parseFloat(btn.dataset.lng);
      if (!isNaN(lat) && !isNaN(lng) && typeof map !== 'undefined') {
        map.setView([lat, lng], 20, { animate: true });
      }
    });
  });
}

async function loadFlagged() {
  const list = document.getElementById('admin-flagged-list');
  if (!list) return;
  list.textContent = 'Loading...';

  const res = await adminFetch('/admin/flagged');
  if (!res) return;

  if (!res.ok) {
    list.textContent = 'Failed to load';
    return;
  }

  const { sessions } = await res.json();
  if (sessions.length === 0) {
    list.innerHTML = '<div class="admin-empty">No flagged sessions</div>';
    return;
  }

  list.innerHTML = sessions.map(sid =>
    `<div class="admin-session-row">
      <span class="admin-session-id" data-session="${escapeHtml(sid)}">${escapeHtml(sid)}</span>
      <button class="admin-btn-sm" data-revert="${escapeHtml(sid)}">Revert</button>
    </div>`
  ).join('');

  list.querySelectorAll('[data-revert]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.revert;
      if (!confirm(`Revert all paints by ${sid}?`)) return;
      btn.disabled = true;
      btn.textContent = 'Reverting...';
      const res = await adminFetch('/admin/revert', {
        method: 'POST',
        body: JSON.stringify({ sessionId: sid })
      });
      if (res && res.ok) {
        btn.textContent = 'Done';
        loadFlagged();
      } else {
        btn.textContent = 'Failed';
      }
    });
  });

  list.querySelectorAll('[data-session]').forEach(el => {
    el.addEventListener('click', () => {
      const input = document.getElementById('admin-session-input');
      if (input) { input.value = el.dataset.session; lookupSession(); }
    });
  });
}

async function lookupSession() {
  const input = document.getElementById('admin-session-input');
  const detail = document.getElementById('admin-session-detail');
  if (!input || !detail) return;

  const sid = input.value.trim();
  if (!sid) return;

  detail.textContent = 'Loading...';

  const res = await adminFetch(`/admin/session/${encodeURIComponent(sid)}`);
  if (!res) return;

  if (!res.ok) {
    detail.textContent = 'Failed to load';
    return;
  }

  const data = await res.json();

  let html = `<div class="admin-session-info">
    <div>Session: <strong>${escapeHtml(data.sessionId)}</strong></div>
    <div>Flagged: ${data.flagged ? 'Yes' : 'No'} | Blocked: ${data.blocked ? 'Yes' : 'No'}</div>
    <div>Paints: ${data.paints.length}</div>
  </div>`;

  if (data.paints.length > 0) {
    html += '<div class="admin-paint-list">' +
      data.paints.map(p =>
        `<div class="admin-paint-row" data-lat="${p.lat}" data-lng="${p.lng}">
          <span class="admin-paint-color" style="background:${safeColor(p.color)}"></span>
          <span>${escapeHtml(p.tileKey || p.childKey || 'unknown')}</span>
          <span class="admin-paint-type">${escapeHtml(p.type)}</span>
        </div>`
      ).join('') +
      '</div>';
    html += `<button class="admin-btn admin-btn-danger" data-revert-session="${escapeHtml(sid)}">Revert All Paints</button>`;
  }

  detail.innerHTML = html;

  detail.querySelectorAll('[data-lat]').forEach(el => {
    el.addEventListener('click', () => {
      const lat = parseFloat(el.dataset.lat);
      const lng = parseFloat(el.dataset.lng);
      if (!isNaN(lat) && !isNaN(lng) && typeof map !== 'undefined') {
        map.setView([lat, lng], 20, { animate: true });
      }
    });
  });

  const revertBtn = detail.querySelector('[data-revert-session]');
  if (revertBtn) {
    revertBtn.addEventListener('click', async () => {
      if (!confirm(`Revert all paints by ${sid}?`)) return;
      revertBtn.disabled = true;
      revertBtn.textContent = 'Reverting...';
      const res = await adminFetch('/admin/revert', {
        method: 'POST',
        body: JSON.stringify({ sessionId: sid })
      });
      if (res && res.ok) {
        revertBtn.textContent = 'Done';
        lookupSession();
        const fl = document.getElementById('admin-flagged-list');
        if (fl && fl.classList.contains('visible')) loadFlagged();
      } else {
        revertBtn.textContent = 'Failed';
      }
    });
  }
}

function toggleInspectMode() {
  _inspectMode = !_inspectMode;
  const btn = document.getElementById('admin-inspect-btn');
  const info = document.getElementById('admin-inspect-info');
  const mapEl = document.getElementById('map');

  if (_inspectMode) {
    if (_activeRegionDraw) deactivateRegionMode();
    btn.textContent = 'Exit Inspect';
    btn.classList.add('active');
    info.textContent = 'Click a pixel to see who painted it';
    mapEl.classList.add('inspect-mode');
    if (typeof map !== 'undefined') {
      map.on('click', onInspectClick);
    }
  } else {
    disableInspectMode();
  }
}

function disableInspectMode() {
  _inspectMode = false;
  const btn = document.getElementById('admin-inspect-btn');
  const info = document.getElementById('admin-inspect-info');
  const mapEl = document.getElementById('map');
  if (btn) { btn.textContent = 'Inspect Pixels'; btn.classList.remove('active'); }
  if (info) info.textContent = '';
  if (mapEl) mapEl.classList.remove('inspect-mode');
  if (typeof map !== 'undefined') {
    map.off('click', onInspectClick);
  }
  const popup = document.getElementById('admin-pixel-popup');
  if (popup) popup.remove();
}

function onInspectClick(e) {
  if (!_inspectMode) return;
  const { lat, lng } = e.latlng;
  const tile = snapToTile(lat, lng);
  const id = tile.key;

  const popup = document.getElementById('admin-pixel-popup');
  if (popup) popup.remove();

  const pixelLayer = pixelLayers[id];
  if (!pixelLayer) return;

  const bounds = pixelLayer.getBounds();
  const point = map.latLngToContainerPoint(bounds.getCenter());

  const el = document.createElement('div');
  el.id = 'admin-pixel-popup';
  el.className = 'admin-pixel-popup';
  el.innerHTML = `<div class="admin-pixel-popup-loading">Loading...</div>`;
  el.style.left = `${point.x}px`;
  el.style.top = `${point.y - 10}px`;
  document.getElementById('app').appendChild(el);

  const vb = getViewportBounds();
  const fb = computeFetchBounds(vb);
  fetch(`${CONFIG.API_URL}/pixels?n=${fb.n}&s=${fb.s}&e=${fb.e}&w=${fb.w}`)
    .then(r => r.json())
    .then(pixels => {
      const pixel = pixels.find(p => p.id === id);
      if (!pixel) {
        el.innerHTML = '<div class="admin-pixel-popup-loading">No data</div>';
        return;
      }
      el.innerHTML = `
        <div class="admin-pixel-popup-row">
          <span class="admin-paint-color" style="background:${safeColor(pixel.color)}"></span>
          <strong>${escapeHtml(pixel.id)}</strong>
        </div>
        ${pixel.protected ? '<div class="admin-pixel-popup-row admin-protected-badge">Protected</div>' : ''}
        ${pixel.ttlExtended ? `<div class="admin-pixel-popup-row admin-ttl-badge">TTL extended until ${new Date(pixel.ttlExpiresAt).toLocaleDateString()}</div>` : ''}
        <div class="admin-pixel-popup-row">
          Session: <span class="admin-pixel-popup-session" data-session="${escapeHtml(pixel.sessionId || 'unknown')}">${escapeHtml(pixel.sessionId || 'unknown')}</span>
        </div>
        <div class="admin-pixel-popup-row">
          Painted: ${pixel.paintedAt ? relativeTime(new Date(pixel.paintedAt).getTime()) : 'unknown'}
        </div>
        <div class="admin-pixel-popup-row">
          Children: ${pixel.children ? pixel.children.length : 0}
        </div>
        ${pixel.protected ? `<button class="admin-btn-sm admin-btn-unprotect" data-tile="${escapeHtml(pixel.id)}">Unprotect</button>` : ''}
      `;
      el.querySelector('[data-session]').addEventListener('click', () => {
        const input = document.getElementById('admin-session-input');
        if (input && pixel.sessionId) {
          input.value = pixel.sessionId;
          lookupSession();
        }
        el.remove();
      });

      const unprotectBtn = el.querySelector('.admin-btn-unprotect');
      if (unprotectBtn) {
        unprotectBtn.addEventListener('click', async () => {
          unprotectBtn.disabled = true;
          unprotectBtn.textContent = 'Unprotecting...';
          const body = { tileKeys: [pixel.id] };
          if (CONFIG.SPACE) body.space = CONFIG.SPACE;
          const res = await adminFetch('/admin/unprotect', {
            method: 'POST',
            body: JSON.stringify(body)
          });
          if (res && res.ok) {
            unprotectBtn.textContent = 'Unprotected';
            el.remove();
            if (typeof refreshViewport === 'function') refreshViewport();
          } else {
            unprotectBtn.textContent = 'Failed';
          }
        });
      }
    })
    .catch(() => {
      el.innerHTML = '<div class="admin-pixel-popup-loading">Failed</div>';
    });

  setTimeout(() => {
    const p = document.getElementById('admin-pixel-popup');
    if (p) p.remove();
  }, 8000);
}

function showTokenPrompt(errorMsg) {
  const existing = document.getElementById('admin-login');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'admin-login';
  overlay.innerHTML = `
    <div class="admin-login-box">
      <h2>Admin Access</h2>
      ${errorMsg ? `<div class="admin-error">${errorMsg}</div>` : ''}
      <input type="password" id="admin-token-input" placeholder="Enter API key" class="admin-input" autofocus />
      <button class="admin-btn" id="admin-token-submit">Verify</button>
      <button class="admin-btn admin-btn-cancel" id="admin-token-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('admin-token-input');
  const btn = document.getElementById('admin-token-submit');

  document.getElementById('admin-token-cancel').addEventListener('click', () => {
    overlay.remove();
    location.hash = '';
  });

  const submit = async () => {
    const token = input.value.trim();
    if (!token) return;
    btn.disabled = true;
    btn.textContent = 'Verifying...';
    const result = await verifyToken(token);
    if (result.valid) {
      _adminToken = token;
      sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
      overlay.remove();
      createAdminPanel();
    } else if (result.locked) {
      btn.disabled = false;
      btn.textContent = 'Verify';
      showTokenPrompt(`Too many attempts. Try again in ${result.retryAfter}s`);
    } else if (result.error === 'Admin not configured') {
      btn.disabled = false;
      btn.textContent = 'Verify';
      showTokenPrompt('Admin is not configured on this server');
    } else {
      btn.disabled = false;
      btn.textContent = 'Verify';
      input.value = '';
      showTokenPrompt('Invalid API key');
    }
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

async function initAdmin() {
  if (_adminToken) {
    const result = await verifyToken(_adminToken);
    if (result.valid) {
      createAdminPanel();
    } else if (result.locked) {
      _adminToken = null;
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      showTokenPrompt(`Too many failed attempts. Try again in ${result.retryAfter}s`);
    } else {
      _adminToken = null;
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      showTokenPrompt('Saved token is invalid — please re-enter');
    }
  } else {
    showTokenPrompt();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(initAdmin, 500));
} else {
  setTimeout(initAdmin, 500);
}
