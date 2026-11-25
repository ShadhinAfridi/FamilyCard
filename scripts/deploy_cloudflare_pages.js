import fs from 'fs';
import path from 'path';
import { createBLAKE3 } from 'hash-wasm';

const JWT = process.argv[2] || process.env.CF_PAGES_UPLOAD_JWT;
if (!JWT) {
  console.error('Usage: node scripts/deploy_cloudflare_pages.js <JWT>');
  process.exit(1);
}

const PUBLIC_DIR = path.resolve('public');

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html';
    case '.js': return 'application/javascript';
    case '.css': return 'text/css';
    case '.json': return 'application/json';
    case '.zip': return 'application/zip';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    case '.txt': return 'text/plain';
    default:
      if (path.basename(filePath) === 'CNAME') return 'text/plain';
      return 'application/octet-stream';
  }
}

function getAllFiles(dir, base = '') {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const item of list) {
    const full = path.join(dir, item);
    const rel = path.join(base, item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results = results.concat(getAllFiles(full, rel));
    } else if (item !== '_worker.js') {
      results.push({
        full,
        rel: '/' + rel.replace(/\\/g, '/'),
        size: stat.size,
        contentType: getMimeType(full)
      });
    }
  }
  return results;
}

async function main() {
  console.log('1. Scanning files in public/...');
  const files = getAllFiles(PUBLIC_DIR);
  console.log(`Found ${files.length} files.`);

  console.log('2. Computing BLAKE3 hashes...');
  const hasher = await createBLAKE3();
  const manifest = {};
  const fileEntries = [];

  for (const f of files) {
    const base64Contents = fs.readFileSync(f.full).toString('base64');
    const ext = path.extname(f.full).substring(1);
    const hash = hasher.init().update(base64Contents).update(ext).digest('hex').slice(0, 32);
    manifest[f.rel] = hash;
    fileEntries.push({
      ...f,
      hash,
      base64Contents
    });
    console.log(`  ${f.rel} -> ${hash} (${f.size} bytes)`);
  }

  const allHashes = fileEntries.map(f => f.hash);
  console.log('\n3. Checking missing hashes with Cloudflare Pages asset store...');
  const checkRes = await fetch('https://api.cloudflare.com/client/v4/pages/assets/check-missing', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${JWT}`
    },
    body: JSON.stringify({ hashes: allHashes })
  });

  if (!checkRes.ok) {
    const errText = await checkRes.text();
    throw new Error(`check-missing failed (${checkRes.status}): ${errText}`);
  }

  const checkData = await checkRes.json();
  const missingHashes = new Set(checkData.result || []);
  console.log(`Missing hashes count: ${missingHashes.size}`);

  if (missingHashes.size > 0) {
    console.log('4. Uploading missing assets...');
    const toUpload = fileEntries.filter(f => missingHashes.has(f.hash));
    
    // Batch upload in chunks if needed
    const batchSize = 5;
    for (let i = 0; i < toUpload.length; i += batchSize) {
      const batch = toUpload.slice(i, i + batchSize);
      const payload = batch.map(f => ({
        key: f.hash,
        value: f.base64Contents,
        metadata: { contentType: f.contentType },
        base64: true
      }));

      console.log(`  Uploading batch ${i + 1} to ${Math.min(i + batchSize, toUpload.length)} of ${toUpload.length}...`);
      const uploadRes = await fetch('https://api.cloudflare.com/client/v4/pages/assets/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${JWT}`
        },
        body: JSON.stringify(payload)
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`upload failed (${uploadRes.status}): ${errText}`);
      }
    }
    console.log('Upload completed successfully!');
  } else {
    console.log('All files already exist in Cloudflare cache!');
  }

  console.log('5. Upserting asset hashes...');
  const upsertRes = await fetch('https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${JWT}`
    },
    body: JSON.stringify({ hashes: allHashes })
  });

  if (!upsertRes.ok) {
    const errText = await upsertRes.text();
    throw new Error(`upsert-hashes failed (${upsertRes.status}): ${errText}`);
  }
  console.log('Upsert hashes completed successfully!');

  fs.writeFileSync('scripts/manifest.json', JSON.stringify(manifest, null, 2), 'utf8');
  console.log('\nManifest saved to scripts/manifest.json:');
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch(err => {
  console.error('Deployment error:', err);
  process.exit(1);
});
