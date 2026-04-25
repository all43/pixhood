const ADMIN_TOKEN_KEY = 'admin_token';
let _adminToken = sessionStorage.getItem(ADMIN_TOKEN_KEY);
let _regionMode = false;
let _regionRect = null;
let _regionStart = null;

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
    const data = await res.json();
    return data;
  } catch {
    return { valid: false };
  }
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
      <h3>Flagged Sessions</h3>
      <div id="admin-flagged-list" class="admin-list">Loading...</div>
      <button class="admin-btn" id="admin-refresh-flagged">Refresh</button>
    </div>
    <div class="admin-section">
      <h3>Session Inspector</h3>
      <input type="text" id="admin-session-input" placeholder="Enter session ID" class="admin-input" />
      <button class="admin-btn" id="admin-lookup">Lookup</button>
      <div id="admin-session-detail" class="admin-list"></div>
    </div>
    <div class="admin-section">
      <h3>Region Erase</h3>
      <button class="admin-btn admin-btn-danger" id="admin-region-btn">Select Region</button>
      <div id="admin-region-info"></div>
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById('admin-close').addEventListener('click', () => {
    panel.remove();
  });

  document.getElementById('admin-refresh-flagged').addEventListener('click', loadFlagged);
  document.getElementById('admin-lookup').addEventListener('click', lookupSession);
  document.getElementById('admin-region-btn').addEventListener('click', toggleRegionMode);

  loadFlagged();
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
      <span class="admin-session-id" data-session="${sid}">${sid}</span>
      <button class="admin-btn-sm" data-revert="${sid}">Revert</button>
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
      if (input) {
        input.value = el.dataset.session;
        lookupSession();
      }
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
    <div>Session: <strong>${data.sessionId}</strong></div>
    <div>Flagged: ${data.flagged ? 'Yes' : 'No'} | Blocked: ${data.blocked ? 'Yes' : 'No'}</div>
    <div>Paints: ${data.paints.length}</div>
  </div>`;

  if (data.paints.length > 0) {
    html += '<div class="admin-paint-list">' +
      data.paints.map(p =>
        `<div class="admin-paint-row" data-lat="${p.lat}" data-lng="${p.lng}">
          <span class="admin-paint-color" style="background:${p.color || '#666'}"></span>
          <span>${p.tileKey || p.childKey || 'unknown'}</span>
          <span class="admin-paint-type">${p.type}</span>
        </div>`
      ).join('') +
      '</div>';
    html += `<button class="admin-btn admin-btn-danger" data-revert-session="${sid}">Revert All Paints</button>`;
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
        loadFlagged();
      } else {
        revertBtn.textContent = 'Failed';
      }
    });
  }
}

function toggleRegionMode() {
  _regionMode = !_regionMode;
  const btn = document.getElementById('admin-region-btn');
  const info = document.getElementById('admin-region-info');
  const mapEl = document.getElementById('map');

  if (_regionMode) {
    btn.textContent = 'Cancel Selection';
    btn.classList.add('active');
    info.textContent = 'Click and drag on the map to select a region';
    mapEl.classList.add('region-select-mode');
    if (typeof map !== 'undefined') {
      map.dragging.disable();
      map.getContainer().addEventListener('mousedown', onRegionStart);
      map.getContainer().addEventListener('mousemove', onRegionMove);
      map.getContainer().addEventListener('mouseup', onRegionEnd);
    }
  } else {
    btn.textContent = 'Select Region';
    btn.classList.remove('active');
    info.textContent = '';
    mapEl.classList.remove('region-select-mode');
    if (typeof map !== 'undefined') {
      map.dragging.enable();
      map.getContainer().removeEventListener('mousedown', onRegionStart);
      map.getContainer().removeEventListener('mousemove', onRegionMove);
      map.getContainer().removeEventListener('mouseup', onRegionEnd);
    }
    if (_regionRect) {
      map.removeLayer(_regionRect);
      _regionRect = null;
    }
  }
}

function onRegionStart(e) {
  if (!_regionMode || typeof map === 'undefined') return;
  _regionStart = map.mouseEventToLatLng(e);
  if (_regionRect) {
    map.removeLayer(_regionRect);
    _regionRect = null;
  }
}

function onRegionMove(e) {
  if (!_regionMode || !_regionStart || typeof map === 'undefined') return;
  const end = map.mouseEventToLatLng(e);
  const bounds = L.latLngBounds(_regionStart, end);
  if (_regionRect) {
    _regionRect.setBounds(bounds);
  } else {
    _regionRect = L.rectangle(bounds, {
      color: '#e94560',
      fillColor: '#e94560',
      fillOpacity: 0.15,
      weight: 2,
      dashArray: '6 4',
      interactive: false
    }).addTo(map);
  }
}

async function onRegionEnd(e) {
  if (!_regionMode || !_regionStart || typeof map === 'undefined') return;
  const end = map.mouseEventToLatLng(e);
  const bounds = L.latLngBounds(_regionStart, end);
  _regionStart = null;

  const n = bounds.getNorth();
  const s = bounds.getSouth();
  const eLng = bounds.getEast();
  const w = bounds.getWest();

  const info = document.getElementById('admin-region-info');
  info.textContent = `Selected: ${((n - s) * 111).toFixed(0)}m × ${(((eLng - w) * 111 * Math.cos((n + s) / 2 * Math.PI / 180))).toFixed(0)}m`;

  if (!confirm(`Erase all pixels in this region?`)) {
    info.textContent = 'Cancelled';
    return;
  }

  info.textContent = 'Erasing...';
  const res = await adminFetch(`/admin/region?n=${n}&s=${s}&e=${eLng}&w=${w}`, { method: 'DELETE' });
  if (res && res.ok) {
    const data = await res.json();
    info.textContent = `Erased ${data.deleted} pixels`;
    if (typeof refreshViewport === 'function') refreshViewport();
  } else {
    info.textContent = 'Erase failed';
  }

  toggleRegionMode();
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
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('admin-token-input');
  const btn = document.getElementById('admin-token-submit');

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
