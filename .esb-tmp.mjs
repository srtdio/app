import { build } from '/home/user/app/node_modules/.pnpm/esbuild@0.17.19/node_modules/esbuild/lib/main.js';
import path from 'node:path';
const entries = process.argv.slice(2);
try {
  await build({ entryPoints: entries, bundle: true, write: false, outdir: '/tmp/x', format: 'esm', platform: 'browser', logLevel: 'error',
    packages: 'external', alias: { '@': path.resolve('src') }, loader: { '.css': 'empty', '.svg': 'text', '.png':'empty' }, jsx: 'automatic' });
  console.log('OK');
} catch (e) { console.log('FAIL'); }
