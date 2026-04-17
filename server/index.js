const http = require('http');
const { WebSocketServer } = require('ws');
const redis = require('./redis');

const CONSTANTS = {
  WS_OPEN: 1,
  WS_TYPE_PING: 'ping',
  WS_TYPE_PONG: 'pong',
  WS_TYPE_VIEWPORT: 'viewport',
  WS_TYPE_PIXEL: 'pixel',
  WS_TYPE_CHILD: 'child',
  WS_TYPE_CLEAR_CHILDREN: 'clearChildren'
};

const PORT = process.env.PORT || 3000;

const CORS_ORIGIN = process.env.CORS_ORIGIN || `http://localhost:${PORT}`;

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

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
      broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_CLEAR_CHILDREN, data: { parentId: pixel.id } });
      broadcastToViewport(pixel.lat, pixel.lng, { type: CONSTANTS.WS_TYPE_PIXEL, data: { ...pixel, hasChildren: false } });
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

      broadcastToViewport(childPixel.lat, childPixel.lng, { type: CONSTANTS.WS_TYPE_CHILD, data: { parentId, childKey, childPixel, childrenCount: children.length } });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('POST /pixels/child error:', err);
      res.writeHead(400);
      res.end('Bad request');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

const server = http.createServer(handleRequest);
const wss = new WebSocketServer({ server });

function inBounds(lat, lng, b) {
  return lat >= b.s && lat <= b.n && lng >= b.w && lng <= b.e;
}

function broadcastToViewport(lat, lng, data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === CONSTANTS.WS_OPEN && client.viewport && inBounds(lat, lng, client.viewport)) {
      client.send(msg);
    }
  }
}

function getConnectedCount() {
  let count = 0;
  for (const client of wss.clients) {
    if (client.readyState === CONSTANTS.WS_OPEN) count++;
  }
  return count;
}

wss.on('connection', ws => {
  ws.viewport = null;
  console.log(`WS client connected (${getConnectedCount()} total)`);

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === CONSTANTS.WS_TYPE_PING) {
        ws.send(JSON.stringify({ type: CONSTANTS.WS_TYPE_PONG }));
      } else if (msg.type === CONSTANTS.WS_TYPE_VIEWPORT && msg.bounds) {
        ws.viewport = msg.bounds;
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
