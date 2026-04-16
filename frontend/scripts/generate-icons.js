const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '..', 'favicon.svg');
const publicDir = path.join(__dirname, '..', 'public');

async function generateIcons() {
  const svg = fs.readFileSync(svgPath);

  // Generate 192x192
  await sharp(svg)
    .resize(192, 192)
    .png()
    .toFile(path.join(publicDir, 'icon-192.png'));

  console.log('Created icon-192.png');

  // Generate 512x512
  await sharp(svg)
    .resize(512, 512)
    .png()
    .toFile(path.join(publicDir, 'icon-512.png'));

  console.log('Created icon-512.png');
  console.log('Icons generated successfully!');
}

generateIcons().catch(err => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
