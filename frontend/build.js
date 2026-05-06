const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHARED_WS_TYPES = require('../shared/ws-types');
const SHARED_SPACE = require('../shared/space');

function validateWsTypesSync() {
  const configSrc = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
  const mismatched = [];
  for (const [key, expected] of Object.entries(SHARED_WS_TYPES)) {
    const match = configSrc.match(new RegExp(key + "\\s*:\\s*'([^']+)'"));
    if (!match) {
      mismatched.push(`  ${key}: missing from frontend config.js`);
    } else if (match[1] !== expected) {
      mismatched.push(`  ${key}: frontend='${match[1]}' shared='${expected}'`);
    }
  }
  if (mismatched.length > 0) {
    console.error('WS type mismatch between shared/ws-types.js and frontend config.js:');
    mismatched.forEach(m => console.error(m));
    console.error('Update frontend/config.js to match shared/ws-types.js');
    process.exit(1);
  }
}

validateWsTypesSync();

function validateSpaceConstantsSync() {
  const configSrc = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
  const errors = [];
  const slugCharsMatch = configSrc.match(/SLUG_CHARS\s*=\s*'([^']+)'/);
  if (!slugCharsMatch) {
    errors.push('  SLUG_CHARS: missing from frontend config.js');
  } else if (slugCharsMatch[1] !== SHARED_SPACE.SLUG_CHARS) {
    errors.push(`  SLUG_CHARS: frontend='${slugCharsMatch[1]}' shared='${SHARED_SPACE.SLUG_CHARS}'`);
  }
  const slugLengthMatch = configSrc.match(/SLUG_LENGTH\s*=\s*(\d+)/);
  if (!slugLengthMatch) {
    errors.push('  SLUG_LENGTH: missing from frontend config.js');
  } else if (Number(slugLengthMatch[1]) !== SHARED_SPACE.SLUG_LENGTH) {
    errors.push(`  SLUG_LENGTH: frontend='${slugLengthMatch[1]}' shared='${SHARED_SPACE.SLUG_LENGTH}'`);
  }
  if (errors.length > 0) {
    console.error('Space constant mismatch between shared/space.js and frontend config.js:');
    errors.forEach(e => console.error(e));
    console.error('Update frontend/config.js to match shared/space.js');
    process.exit(1);
  }
}

validateSpaceConstantsSync();

const SRC_DIR = path.join(__dirname);
const DIST_DIR = path.join(__dirname, 'dist');
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATIC_FILES = ['config.js', 'grid.js', 'pixels.js', 'map.js', 'app.js'];

function hashFile(filepath) {
  const content = fs.readFileSync(filepath);
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
}

function copyWithHash(srcFile, destDir, suffix = '') {
  const ext = path.extname(srcFile);
  const base = path.basename(srcFile, ext);
  const hash = hashFile(srcFile);
  const newName = `${base}.${hash}${suffix || ext}`;
  
  fs.copyFileSync(srcFile, path.join(destDir, newName));
  return newName;
}

// Clean dist/
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR);

console.log('Building Pixhood frontend...');

// Hash and copy static JS files
const hashedJsFiles = {};
const jsFiles = ['config.js', 'grid.js', 'pixels.js', 'map.js', 'app.js', 'admin.js'];
jsFiles.forEach(file => {
  const hashedName = copyWithHash(path.join(SRC_DIR, file), DIST_DIR);
  hashedJsFiles[file] = hashedName;
  console.log(`  ${file} → ${hashedName}`);
});

// Hash and copy CSS
const cssFiles = ['style.css', 'admin.css'];
const hashedCssFiles = {};
cssFiles.forEach(file => {
  const hash = hashFile(path.join(SRC_DIR, file));
  const hashedName = `${path.basename(file, '.css')}.${hash}.css`;
  fs.copyFileSync(path.join(SRC_DIR, file), path.join(DIST_DIR, hashedName));
  hashedCssFiles[file] = hashedName;
  console.log(`  ${file} → ${hashedName}`);
});

// Rewrite index.html with hashed filenames
let html = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
Object.entries(hashedCssFiles).forEach(([orig, hashed]) => {
  html = html.replace(new RegExp(orig.replace('.', '\\.'), 'g'), hashed);
});
Object.entries(hashedJsFiles).forEach(([orig, hashed]) => {
  html = html.replace(new RegExp(orig.replace('.', '\\.'), 'g'), hashed);
});

fs.writeFileSync(path.join(DIST_DIR, 'index.html'), html);
console.log('  index.html (rewritten)');

// Copy favicon.svg and logo.svg
fs.copyFileSync(
  path.join(SRC_DIR, 'favicon.svg'),
  path.join(DIST_DIR, 'favicon.svg')
);
console.log('  favicon.svg');
fs.mkdirSync(path.join(DIST_DIR, 'icons'), { recursive: true });
fs.copyFileSync(
  path.join(SRC_DIR, 'icons', 'logo.svg'),
  path.join(DIST_DIR, 'icons', 'logo.svg')
);
console.log('  icons/logo.svg');

// Copy privacy.html
fs.copyFileSync(
  path.join(SRC_DIR, 'privacy.html'),
  path.join(DIST_DIR, 'privacy.html')
);
console.log('  privacy.html');

// Copy about.html with BUILD_DATE replacement
const buildDate = new Date().toISOString().slice(0, 10);
let aboutHtml = fs.readFileSync(path.join(SRC_DIR, 'about.html'), 'utf8');
aboutHtml = aboutHtml.replace('{{BUILD_DATE}}', buildDate);
fs.writeFileSync(path.join(DIST_DIR, 'about.html'), aboutHtml);
console.log('  about.html');

// Copy public/ contents (icons, manifest, headers)
if (fs.existsSync(PUBLIC_DIR)) {
  const publicFiles = fs.readdirSync(PUBLIC_DIR);
  publicFiles.forEach(file => {
    const src = path.join(PUBLIC_DIR, file);
    const dest = path.join(DIST_DIR, file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dest);
      console.log(`  ${file}`);
    }
  });
}

// Generate service worker with precache manifest
const iconHash = hashFile(path.join(PUBLIC_DIR, 'icon-512.png')).slice(0, 6);

const CDN_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

const precacheList = [
  '/',
  '/index.html',
  ...Object.values(hashedCssFiles).map(f => `/${f}`),
  ...Object.values(hashedJsFiles).filter(f => !f.startsWith('admin')).map(f => `/${f}`),
  '/favicon.svg',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-192-transparent.png',
  '/icon-512-transparent.png',
];

const swContent = `// Auto-generated by build.js
const CACHE_NAME = 'pixhood-v1-${iconHash}';
const PRECACHE_ASSETS = ${JSON.stringify(precacheList, null, 2)};
const CDN_ASSETS = ${JSON.stringify(CDN_ASSETS, null, 2)};
const API_HOSTS = ['api.pixhood.art', 'localhost'];

const DEV_MODE = self.location.hostname === 'localhost';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      const originAssets = cache.addAll(PRECACHE_ASSETS);
      const cdnAssets = Promise.all(
        CDN_ASSETS.map(url => cache.add(url))
      );
      return Promise.all([originAssets, cdnAssets]);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (DEV_MODE) {
    return;
  }

  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') {
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  // Cache-first for CDN assets (cross-origin, precached on install)
  if (CDN_ASSETS.some(cdn => url.href.startsWith(cdn))) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => new Response('offline', { status: 503 }));
      })
    );
    return;
  }

  // Network-first for API calls (cross-origin in production)
  if (API_HOSTS.includes(url.host) && (url.pathname.startsWith('/pixels') || url.pathname.startsWith('/spaces') || url.pathname.startsWith('/ws'))) {
    event.respondWith(
      fetch(event.request)
        .catch(() => new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' }
        }))
    );
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  // Skip service worker itself
  if (url.pathname === '/sw.js') {
    return;
  }

  // Network-first for navigation requests to avoid redirected-response errors
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const body = response.redirected ? response.body : null;
          if (response.redirected) {
            return new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            });
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || new Response('offline', { status: 503 })))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
// Return cached, update in background
      fetch(event.request).then(response => {
        if (response.ok) {
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, response);
          });
        }
      }).catch(() => {});
      return cached;
      }
      
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(() => {
        return new Response('offline', { status: 503 });
      });
    })
  );
});
`;

fs.writeFileSync(path.join(DIST_DIR, 'sw.js'), swContent);
console.log('  sw.js (generated)');

console.log('Build complete! Output in dist/');
