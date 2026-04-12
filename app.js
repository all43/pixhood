let selectedColor = '#FF0000';

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

async function getGeolocation() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      ()  => resolve(null),
      { timeout: 6000 }
    );
  });
}

async function init() {
  initColorPicker();

  const pos = await getGeolocation();
  const lat = pos ? pos.lat : CONFIG.DEFAULT_LAT;
  const lng = pos ? pos.lng : CONFIG.DEFAULT_LNG;

  if (!pos) showToast('Location unavailable — showing Berlin');

  initMap(lat, lng);

  // Load existing pixels
  try {
    const pixels = await loadAllPixels();
    pixels.forEach(renderPixel);
  } catch (err) {
    console.error('Failed to load pixels:', err);
    showToast('Could not load pixels — check server');
  }

  // Real-time updates from other clients
  // Own writes are rendered optimistically in map.js, WS echo is a no-op
  connectWebSocket(renderPixel);
}

document.addEventListener('DOMContentLoaded', init);
