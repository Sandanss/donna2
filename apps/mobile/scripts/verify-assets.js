#!/usr/bin/env node

/**
 * Asset Verification Script
 *
 * Checks that all required app assets exist and meet minimum specifications.
 * Run with: node scripts/verify-assets.js
 */

const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'images');
const REQUIRED_ASSETS = {
  'icon.png': { minSize: 1024, desc: 'App icon' },
  'splash.png': { minSize: 200, desc: 'Splash screen' },
  'adaptive-icon.png': { minSize: 1024, desc: 'Android adaptive icon' },
  'favicon.png': { minSize: 32, desc: 'Web favicon' }
};

// PNG file signature (first 8 bytes)
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Check if a file is a valid PNG by reading its header
 */
function isPngFile(filePath) {
  try {
    const buffer = Buffer.alloc(8);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 8);
    fs.closeSync(fd);
    return buffer.equals(PNG_SIGNATURE);
  } catch (err) {
    return false;
  }
}

/**
 * Extract PNG dimensions from file header
 */
function getPngDimensions(filePath) {
  try {
    const buffer = Buffer.alloc(24);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 24);
    fs.closeSync(fd);

    // PNG signature: bytes 0-7
    // Width (big-endian): bytes 16-19
    // Height (big-endian): bytes 20-23
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height };
  } catch (err) {
    return null;
  }
}

function checkAssets() {
  console.log('🔍 Verifying Donna app assets...\n');

  if (!fs.existsSync(ASSETS_DIR)) {
    console.log(`❌ Assets directory not found: ${ASSETS_DIR}`);
    console.log('\nCreate it with:');
    console.log(`   mkdir -p ${ASSETS_DIR}\n`);
    process.exit(1);
  }

  let allValid = true;

  Object.entries(REQUIRED_ASSETS).forEach(([filename, { minSize, desc }]) => {
    const filePath = path.join(ASSETS_DIR, filename);

    if (!fs.existsSync(filePath)) {
      console.log(`❌ ${filename} (${desc})`);
      console.log(`   Missing: ${filePath}`);
      allValid = false;
      return;
    }

    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      console.log(`❌ ${filename} (${desc})`);
      console.log(`   File is empty (0 bytes)`);
      allValid = false;
      return;
    }

    const isPng = isPngFile(filePath);
    if (!isPng) {
      console.log(`❌ ${filename} (${desc})`);
      console.log(`   Not a valid PNG file`);
      allValid = false;
      return;
    }

    const dimensions = getPngDimensions(filePath);
    if (!dimensions) {
      console.log(`⚠️  ${filename} (${desc})`);
      console.log(`   Valid PNG but could not read dimensions`);
      console.log(`   File size: ${stats.size} bytes`);
      return;
    }

    const { width, height } = dimensions;
    console.log(`✅ ${filename} (${desc})`);
    console.log(`   Size: ${width}×${height} pixels`);
    console.log(`   File: ${stats.size} bytes`);

    // Warn if dimensions are smaller than expected
    if (width < minSize || height < minSize) {
      console.log(`   ⚠️  Warning: Minimum recommended size is ${minSize}×${minSize}`);
      allValid = false;
    }

    console.log();
  });

  if (!allValid) {
    console.log('\n❌ Some assets are missing or invalid.');
    console.log('\nFor asset creation guidance, see: ASSETS.md\n');
    process.exit(1);
  }

  console.log('✅ All required assets are present and valid!\n');
  process.exit(0);
}

checkAssets();
