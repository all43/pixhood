const _local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const _backendHost = _local ? 'http://localhost:3000' : 'https://api.pixhood.art';

const CONFIG = {
  API_URL: _backendHost,
  WS_URL: _local ? 'ws://localhost:3000' : 'wss://api.pixhood.art',

  TILE_SIZE: 0.0001,
  LNG_STEP: 0.0001 / Math.cos(52.5200 * Math.PI / 180),
  DEFAULT_LAT: 52.5200,
  DEFAULT_LNG:  13.4050,
  DEFAULT_ZOOM: 17,

  GRID_COLOR: 'rgba(255,255,255,0.08)',
  GRID_ZOOM_THRESHOLD: 16,

  SUB_GRID_SIZE: 16,
  SUB_GRID_ZOOM: 21,
  VIEWPORT_MARGIN: 1.0,
  HEARTBEAT_INTERVAL: 30000,

  PALETTE: [
    '#000000', '#888888', '#FFFFFF', '#FF0000',
    '#FF8800', '#FFFF00', '#448800', '#00FF00',
    '#00FF88', '#00FFFF', '#004488', '#0000FF',
    '#8800FF', '#FF00FF', '#FF0088', '#884400'
  ],

  // Geolocation timeouts (ms)
  GEO_FAST_TIMEOUT: 2000,
  GEO_GRANTED_TIMEOUT: 10000,
  GEO_RETRY_TIMEOUT: 3000,
  GEO_DEFAULT_TIMEOUT: 60000,

  // UI timings (ms)
  TOAST_DURATION: 3000,
  SLOW_HINT_DELAY: 1500,
  VIEWPORT_DEBOUNCE_MS: 300,
  INIT_VIEWPORT_SPAN: 0.01,

  // Map rendering
  MAX_ZOOM: 22,
  TILE_URL: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
  TILE_SUBDOMAINS: 'abcd',
  SUB_GRID_COLOR: 'rgba(255,255,255,0.04)',
  SUB_GRID_BORDER_COLOR: 'rgba(255,255,255,0.2)',
  SUB_GRID_BORDER_WIDTH: 2,
  PIXEL_OPACITY: 0.75,
  CHILD_PIXEL_OPACITY: 0.85,
  BOUNDARY_EDGE_FRACTION: 0.2,
  BOUNDARY_COLOR: 'rgba(255, 165, 0, 0.4)',
  BOUNDARY_DASH: '8 4',

  // WebSocket protocol (must match server/index.js CONSTANTS)
  WS_TYPE_PING: 'ping',
  WS_TYPE_PONG: 'pong',
  WS_TYPE_VIEWPORT: 'viewport',
  WS_TYPE_PIXEL: 'pixel',
  WS_TYPE_CHILD: 'child',
  WS_TYPE_CLEAR_CHILDREN: 'clearChildren',

  // WebSocket reconnect (ms)
  WS_RETRY_INITIAL_MS: 1000,
  WS_RETRY_MAX_MS: 30000,

  // Refetch trigger
  REFETCH_THRESHOLD: 0.5,

  // Default color
  DEFAULT_COLOR: '#FF0000'
};
