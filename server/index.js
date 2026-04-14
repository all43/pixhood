const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const redis = require('./redis');

const PORT = process.env.PORT || 3000;
const STATIC_DIR = path.join(__dirname, '..');

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost`);

  if (req.method === 'OPTIONS') {
    setCORS(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/pixels') {
    setCORS(res);
    try {
      const n = parseFloat(url.searchParams.get('n'));
      const s = parseFloat(url.searchParams.get('s'));
      const e = parseFloat(url.searchParams.get('e'));
      const w = parseFloat(url.searchParams.get('w'));

      if (isNaN(n) || isNaN(s) || isNaN(e) || isNaN(w)) {
        res.writeHead(400);
        res.end('Missing bounds params: n, s, e, w');
        return;
      }

      const { pixels, staleKeys } = await redis.getPixelsInViewport(n, s, e, w);

      if (staleKeys.length > 0) {
        redis.cleanupGeoIndex(staleKeys).catch(err => console.error('Geo cleanup error:', err));
      }

      const subPromises = pixels.map(async pixel => {
        const children = await redis.getSubpixels(pixel.id);
        return { ...pixel, hasChildren: children.length > 0, children: children.length > 0 ? children : undefined };
      });

      const result = await Promise.all(subPromises);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('GET /pixels error:', err);
      res.writeHead(500);
      res.end('Internal server error');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/pixels') {
    setCORS(res);
    try {
      const body = await readBody(req);
      const pixel = JSON.parse(body);
      await redis.deleteSubpixels(pixel.id);
      await redis.savePixel(pixel);
      broadcast({ type: 'clearChildren', data: { parentId: pixel.id } });
      broadcast({ type: 'pixel', data: { ...pixel, hasChildren: false } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('POST /pixels error:', err);
      res.writeHead(400);
      res.end('Bad request');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/pixels/child') {
    setCORS(res);
    try {
      const body = await readBody(req);
      const { parentId, childKey, childPixel } = JSON.parse(body);

      const { children } = await redis.saveChildPixel(parentId, childKey, childPixel);

      broadcast({ type: 'child', data: { parentId, childKey, childPixel, childrenCount: children.length } });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('POST /pixels/child error:', err);
      res.writeHead(400);
      res.end('Bad request');
    }
    return;
  }

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(STATIC_DIR, filePath);

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

const server = http.createServer(handleRequest);
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

function getConnectedCount() {
  let count = 0;
  for (const client of wss.clients) {
    if (client.readyState === 1) count++;
  }
  return count;
}

wss.on('connection', ws => {
  console.log(`WS client connected (${getConnectedCount()} total)`);

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch {}
  });

  ws.on('error', err => console.error('WS client error:', err));
  ws.on('close', () => {
    console.log(`WS client disconnected (${getConnectedCount()} total)`);
  });
});

redis.connect().then(() => {
  server.listen(PORT, () => {
    console.log(`Pixhood running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to connect to Redis:', err);
  process.exit(1);
});
