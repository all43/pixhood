let selectedColor = '#FF0000';
let slowHintTimer = null;

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
    if (result.state === 'denied') {
      return { status: 'denied' };
    }
  } catch {
  }

  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ status: 'granted', lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => {
        const map = { 1: 'denied', 2: 'unavailable', 3: 'timeout' };
        resolve({ status: map[err.code] || 'error' });
      },
      { timeout: timeout || 60000, enableHighAccuracy: false }
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
    default:
      showToast('Location error — showing Berlin');
  }

  return { lat, lng };
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
    pixels.forEach(renderPixel);
  } catch (err) {
    console.error('Failed to load pixels:', err);
    showToast('Could not load pixels — check server');
  }

  connectWebSocket(renderPixel);
  hideOverlay();
}

async function init() {
  initColorPicker();
  document.querySelector('.banner-close').addEventListener('click', hideLocationBanner);

  const pixelsPromise = loadAllPixels().catch(err => {
    console.error('Failed to load pixels:', err);
    return [];
  });

  const pref = localStorage.getItem('geo_pref');

  if (pref === 'granted') {
    showSpinnerScreen('Waiting for location\u2026');
    const result = await getGeolocation(10000);
    if (result.status === 'granted') {
      await proceedToMap(result, pixelsPromise);
    } else if (result.status === 'denied') {
      localStorage.setItem('geo_pref', 'denied');
      await proceedToMap({ status: 'denied' }, pixelsPromise);
    } else {
      await proceedToMap({ status: 'timeout' }, pixelsPromise);
    }
    return;
  }

  if (pref === 'skipped') {
    await proceedToMap({ status: 'skipped' }, pixelsPromise);
    return;
  }

  if (pref === 'denied') {
    await proceedToMap({ status: 'denied' }, pixelsPromise);
    return;
  }

  document.getElementById('btn-enable-geo').addEventListener('click', async () => {
    showSpinnerScreen('Waiting for location\u2026');
    const result = await getGeolocation(60000);
    if (result.status === 'granted') {
      await proceedToMap(result, pixelsPromise);
    } else if (result.status === 'denied') {
      localStorage.setItem('geo_pref', 'denied');
      await proceedToMap({ status: 'denied' }, pixelsPromise);
    } else {
      await proceedToMap({ status: 'timeout' }, pixelsPromise);
    }
  });

  document.getElementById('btn-skip-geo').addEventListener('click', async () => {
    localStorage.setItem('geo_pref', 'skipped');
    await proceedToMap({ status: 'skipped' }, pixelsPromise);
  });
}

document.addEventListener('DOMContentLoaded', init);
