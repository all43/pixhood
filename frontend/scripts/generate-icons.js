const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const logoPath = path.join(__dirname, '..', 'icons', 'logo.svg');
const publicDir = path.join(__dirname, '..', 'public');

const outputs = [
  { file: 'icon-192.png', size: 192, transparent: false },
  { file: 'icon-512.png', size: 512, transparent: false },
  { file: 'icon-192-transparent.png', size: 192, transparent: true },
  { file: 'icon-512-transparent.png', size: 512, transparent: true },
];

const BG = { r: 26, g: 26, b: 46 };

async function generateIcons() {
  const srcMtime = fs.statSync(logoPath).mtimeMs;
  const needsRegen = outputs.some(({ file }) => {
    const dest = path.join(publicDir, file);
    return !fs.existsSync(dest) || fs.statSync(dest).mtimeMs < srcMtime;
  });

  if (!needsRegen) {
    console.log('Icons up to date, skipping.');
    return;
  }

  const svg = fs.readFileSync(logoPath);

  for (const { file, size, transparent } of outputs) {
    let pipeline = sharp(svg).resize(size, size);
    if (!transparent) pipeline = pipeline.flatten({ background: BG });
    await pipeline.png().toFile(path.join(publicDir, file));
    console.log(`Created ${file}`);
  }

  console.log('Icons generated successfully!');
}

generateIcons().catch(err => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
