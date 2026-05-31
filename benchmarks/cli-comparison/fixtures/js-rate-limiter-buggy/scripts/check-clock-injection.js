const fs = require('node:fs');
const path = require('node:path');

const filePath = path.join(__dirname, '..', 'src', 'middleware', 'rate-limiter.js');
const source = fs.readFileSync(filePath, 'utf8');

const hasNowInjection =
  /\boptions\.now\b/.test(source) || /\bconst\s+now\s*=.*options\.now\b/.test(source);
const usesDateNowDirectly =
  /\bDate\.now\b/.test(source) && !/\bconst\s+now\s*=.*Date\.now\b/.test(source);

if (!hasNowInjection) {
  console.error('Expected rate limiter to accept clock via options.now');
  process.exit(1);
}

if (usesDateNowDirectly) {
  console.error('Expected rate limiter to use injected clock, not Date.now directly');
  process.exit(1);
}

process.exit(0);
