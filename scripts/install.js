'use strict';

const { execSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');

try {
  execSync('pkg-prebuilds-verify ./binding-options.js', { cwd: root, stdio: 'ignore' });
  process.exit(0);
} catch {}

// No prebuild for this platform — try cmake-js if available
try {
  execSync('cmake-js compile --target ata', { cwd: root, stdio: 'inherit' });
  process.exit(0);
} catch {}

console.log(
  '\n[ata-validator] No native prebuild found for ' + process.platform + '-' + process.arch + '.\n' +
  'Falling back to JS engine (still works, ~2-3x slower for buffer APIs).\n' +
  'To build from source: install cmake, RE2, abseil, then run `npx cmake-js compile --target ata`\n'
);
