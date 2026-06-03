const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');
const logoPath = path.join(__dirname, '..', 'icons', 'logo.svg');

const W = 1200;
const H = 630;
const BG = { r: 26, g: 26, b: 46 }; // #1a1a2e
const ACCENT = '#e94560';
const LOGO_PX = 200;
const LOGO_LEFT = 130;
const LOGO_TOP = Math.round((H - LOGO_PX) / 2); // vertically centered

async function generate() {
  const logoSvg = fs.readFileSync(logoPath);

  const logoResized = await sharp(logoSvg)
    .resize(LOGO_PX, LOGO_PX, { kernel: 'nearest' })
    .toBuffer();

  // Full-canvas text layer with absolute coordinates, composited at the origin.
  // Courier matches the app's monospace aesthetic; accent matches the welcome screen.
  const textSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <text x="390" y="300" font-family="Courier New, Courier, monospace" font-size="92"
            font-weight="bold" letter-spacing="10" fill="${ACCENT}">PIXHOOD</text>
      <text x="392" y="360" font-family="Courier New, Courier, monospace" font-size="34"
            fill="rgba(255,255,255,0.85)">Paint pixels on a map.</text>
      <text x="392" y="406" font-family="Courier New, Courier, monospace" font-size="34"
            fill="rgba(255,255,255,0.55)">Collaborative geo pixel art.</text>
    </svg>
  `);

  const dest = path.join(publicDir, 'og-image.png');

  await sharp({
    create: { width: W, height: H, channels: 3, background: BG }
  })
    .composite([
      { input: logoResized, left: LOGO_LEFT, top: LOGO_TOP },
      { input: textSvg, left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toFile(dest);

  const stat = fs.statSync(dest);
  console.log(`  og-image.png (${W}×${H}) — ${(stat.size / 1024).toFixed(1)} KB`);
}

generate().catch(err => {
  console.error('Error generating OG image:', err);
  process.exit(1);
});
