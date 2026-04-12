const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const redis = require('./redis');

const PORT = process.env.PORT || 3000;
const STATIC_DIR = path.join(__dirname, '..');

// Set via CORS_ORIGIN env var on Fly (e.g. https://pixhood.pages.dev).
// Defaults to localhost for local dev.
const CORS_ORIGIN = process.env.CORS_ORIGIN || `http://localhost:${PORT}`;

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
};

// ── HTTP request handler ──────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCORS(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // API: GET /pixels — return all stored pixels
  if (req.method === 'GET' && url.pathname === '/pixels') {
    setCORS(res);
    try {
      const pixels = await redis.getAllPixels();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pixels));
    } catch (err) {
      console.error('GET /pixels error:', err);
      res.writeHead(500);
      res.end('Internal server error');
    }
    return;
  }

  // API: POST /pixels — save a pixel and broadcast to all WS clients
  if (req.method === 'POST' && url.pathname === '/pixels') {
    setCORS(res);
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      try {
        const pixel = JSON.parse(body);
        await redis.savePixel(pixel);
        broadcast({ type: 'pixel', data: pixel });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('POST /pixels error:', err);
        res.writeHead(400);
        res.end('Bad request');
      }
    });
    return;
  }

  // Static file serving
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(STATIC_DIR, filePath);

  // Prevent path traversal outside STATIC_DIR
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(msg);
    }
  }
}

wss.on('connection', ws => {
  // Prototype: clients only receive, they don't send over WS
  ws.on('error', err => console.error('WS client error:', err));
});

// ── Start ─────────────────────────────────────────────────────────────────────

redis.connect().then(() => {
  server.listen(PORT, () => {
    console.log(`Pixhood running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to connect to Redis:', err);
  process.exit(1);
});
