const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');
const logoPath = path.join(__dirname, '..', 'icons', 'logo.svg');

const BG = { r: 26, g: 26, b: 46 }; // #1a1a2e
const LOGO_SCALE = 0.25; // logo is ~25% of shorter screen dimension

// iOS device splash screen images
// Format: { file, width, height }
const SPLASHES = [
  // iPhone 14/15/16 Pro Max (6.7" / 6.9")
  { file: 'splash-1290x2796.png', w: 1290, h: 2796 },
  // iPhone 14/15/16 Pro (6.1" / 6.3")
  { file: 'splash-1179x2556.png', w: 1179, h: 2556 },
  { file: 'splash-1206x2622.png', w: 1206, h: 2622 },
  // iPhone 12/13/14/15/16 (6.1")
  { file: 'splash-1170x2532.png', w: 1170, h: 2532 },
  // iPhone 14/15 Plus (6.7")
  { file: 'splash-1284x2778.png', w: 1284, h: 2778 },
  // iPhone X / XS / 11 Pro / 12 mini / 13 mini (5.4" / 5.8")
  { file: 'splash-1125x2436.png', w: 1125, h: 2436 },
  // iPhone SE / 6 / 7 / 8 (4.7")
  { file: 'splash-750x1334.png', w: 750, h: 1334 },
  // iPad Pro 12.9"
  { file: 'splash-2048x2732.png', w: 2048, h: 2732 },
  // iPad Pro 12.9" landscape
  { file: 'splash-2732x2048.png', w: 2732, h: 2048 },
  // iPad Pro 11"
  { file: 'splash-1668x2388.png', w: 1668, h: 2388 },
  // iPad Pro 11" landscape
  { file: 'splash-2388x1668.png', w: 2388, h: 1668 },
  // iPad 10.9" Air
  { file: 'splash-1640x2360.png', w: 1640, h: 2360 },
  { file: 'splash-2360x1640.png', w: 2360, h: 1640 },
  // iPad 10.2"
  { file: 'splash-1620x2160.png', w: 1620, h: 2160 },
  { file: 'splash-2160x1620.png', w: 2160, h: 1620 },
  // iPad mini 8.3"
  { file: 'splash-1488x2266.png', w: 1488, h: 2266 },
  { file: 'splash-2266x1488.png', w: 2266, h: 1488 },
];

async function generate() {
  const logoSvg = fs.readFileSync(logoPath);

  for (const { file, w, h } of SPLASHES) {
    const dest = path.join(publicDir, file);

    const logoPx = Math.round(Math.min(w, h) * LOGO_SCALE);

    const logoResized = await sharp(logoSvg)
      .resize(logoPx, logoPx, { kernel: 'nearest' })
      .toBuffer();

    await sharp({
      create: { width: w, height: h, channels: 3, background: BG }
    })
      .composite([{ input: logoResized, gravity: 'center' }])
      .png({ compressionLevel: 9 })
      .toFile(dest);

    const stat = fs.statSync(dest);
    console.log(`  ${file} (${w}\u00d7${h}, logo ${logoPx}px) \u2014 ${(stat.size / 1024).toFixed(1)} KB`);
  }
  console.log(`Generated ${SPLASHES.length} startup images.`);
}

generate().catch(err => {
  console.error('Error generating startup images:', err);
  process.exit(1);
});
