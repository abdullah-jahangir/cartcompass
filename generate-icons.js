/**
 * generate-icons.js
 * Creates icon-192.png and icon-512.png from icon.svg.
 *
 * Prerequisites (one-time):
 *   npm install sharp
 *
 * Usage:
 *   node generate-icons.js
 */

const path = require('path');
const fs   = require('fs');

async function main() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (_) {
    console.error('Please run: npm install sharp');
    process.exit(1);
  }

  const svgPath = path.join(__dirname, 'icons', 'icon.svg');
  const svg     = fs.readFileSync(svgPath);

  for (const size of [192, 512]) {
    const outPath = path.join(__dirname, 'icons', `icon-${size}.png`);
    await sharp(svg).resize(size, size).png().toFile(outPath);
    console.log(`✓ icons/icon-${size}.png`);
  }

  console.log('\nIcons generated successfully!');
}

main().catch(e => { console.error(e); process.exit(1); });
