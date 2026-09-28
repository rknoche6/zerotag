import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { transformSync } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const src = readFileSync('src/zerotag.js', 'utf8').replaceAll('__VERSION__', pkg.version);
const { code } = transformSync(src, { minify: true, target: 'es2017', legalComments: 'inline' });

mkdirSync('dist', { recursive: true });
writeFileSync('dist/zerotag.js', src);
writeFileSync('dist/zerotag.min.js', code);
// Served by the Vercel deployment at /zt.js
writeFileSync('public/zt.js', code);
console.log(`zerotag ${pkg.version}: ${code.length} bytes min, ${gzipSync(code).length} bytes gzip`);
