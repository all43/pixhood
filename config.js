// In production the frontend (Cloudflare Pages) and backend (Fly.io) are on
// different origins. Detect by hostname and point to the Fly.io app.
// After `fly launch`, replace 'pixhood' below with your actual app name.
const _local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const _backendHost = _local ? '' : 'https://pixhood.fly.dev';

const CONFIG = {
  API_URL: _backendHost,
  WS_URL: _local ? `ws://${location.host}` : 'wss://pixhood.fly.dev',

  TILE_SIZE: 0.0001,    // ~10 meters in degrees latitude
  DEFAULT_LAT: 52.5200,
  DEFAULT_LNG:  13.4050,
  DEFAULT_ZOOM: 17,

  PALETTE: [
    '#FFFFFF', '#000000', '#FF0000', '#00FF00',
    '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF',
    '#FF8800', '#8800FF', '#00FF88', '#FF0088',
    '#884400', '#448800', '#004488', '#888888'
  ]
};
