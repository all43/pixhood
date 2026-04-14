const _local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const _backendHost = _local ? 'http://localhost:3000' : 'https://pixhood.fly.dev';

const CONFIG = {
  API_URL: _backendHost,
  WS_URL: _local ? 'ws://localhost:3000' : 'wss://pixhood.fly.dev',

  TILE_SIZE: 0.0001,
  LNG_STEP: 0.0001 / Math.cos(52.5200 * Math.PI / 180),
  DEFAULT_LAT: 52.5200,
  DEFAULT_LNG:  13.4050,
  DEFAULT_ZOOM: 17,

  GRID_COLOR: 'rgba(255,255,255,0.08)',
  GRID_ZOOM_THRESHOLD: 16,

  SUB_GRID_SIZE: 16,
  SUB_GRID_ZOOM: 19,
  VIEWPORT_MARGIN: 1.0,
  HEARTBEAT_INTERVAL: 30000,

  PALETTE: [
    '#FFFFFF', '#000000', '#FF0000', '#00FF00',
    '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF',
    '#FF8800', '#8800FF', '#00FF88', '#FF0088',
    '#884400', '#448800', '#004488', '#888888'
  ]
};
