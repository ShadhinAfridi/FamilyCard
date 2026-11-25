import fs from 'fs';
import path from 'path';
import * as Terser from 'terser';

const sourcePath = path.resolve('cloudflare/worker.js');
const pagesWorkerPath = path.resolve('public/_worker.js');
const minifiedPath = path.resolve('scripts/worker.min.js');

const workerCode = fs.readFileSync(sourcePath, 'utf8');
if (!workerCode.trim()) {
    throw new Error('cloudflare/worker.js is empty; aborting build.');
}

fs.mkdirSync(path.dirname(pagesWorkerPath), { recursive: true });
fs.writeFileSync(pagesWorkerPath, workerCode, 'utf8');

const minified = await Terser.minify(workerCode, {
    compress: {
        dead_code: true,
        drop_debugger: true,
        passes: 1,
    },
    mangle: true,
    format: {
        comments: false,
    },
});

if (minified.error) {
    throw minified.error;
}
if (!minified.code) {
    throw new Error('Terser returned empty output for cloudflare/worker.js');
}

fs.mkdirSync(path.dirname(minifiedPath), { recursive: true });
fs.writeFileSync(minifiedPath, minified.code, 'utf8');

console.log('Worker build synced from cloudflare/worker.js');
console.log('  public/_worker.js bytes:', Buffer.byteLength(workerCode, 'utf8'));
console.log('  scripts/worker.min.js bytes:', Buffer.byteLength(minified.code, 'utf8'));
