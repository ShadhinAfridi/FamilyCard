import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as Terser from 'terser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function build() {
  const rootDir = path.resolve(__dirname, '..');
  const srcPath = path.join(rootDir, 'bookmarklet', 'bookmarklet.js');
  const distMinPath = path.join(rootDir, 'bookmarklet', 'bookmarklet.min.js');
  const publicMinPath = path.join(rootDir, 'public', 'bookmarklet', 'bookmarklet.min.js');
  const publicSrcPath = path.join(rootDir, 'public', 'bookmarklet', 'bookmarklet.js');

  console.log('[Build] Reading bookmarklet source from:', srcPath);
  const srcCode = fs.readFileSync(srcPath, 'utf8');

  console.log('[Build] Minifying with Terser...');
  const minResult = await Terser.minify(srcCode, {
    compress: {
      drop_console: false,
    },
    mangle: true
  });

  if (minResult.error) {
    throw minResult.error;
  }

  // Prepend javascript: and URL-encode for safe browser address bar & bookmark execution
  const bookmarkletCode = 'javascript:' + encodeURI(minResult.code).replace(/#/g, '%23');

  fs.writeFileSync(distMinPath, bookmarkletCode, 'utf8');
  console.log(`[Build] Written ${distMinPath} (${bookmarkletCode.length} chars)`);

  fs.mkdirSync(path.dirname(publicMinPath), { recursive: true });
  fs.writeFileSync(publicMinPath, bookmarkletCode, 'utf8');
  console.log(`[Build] Written ${publicMinPath} (${bookmarkletCode.length} chars)`);

  fs.writeFileSync(publicSrcPath, srcCode, 'utf8');
  console.log(`[Build] Written ${publicSrcPath} (${srcCode.length} chars)`);

  console.log('✅ Bookmarklet build completed successfully!');
}

build().catch((err) => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
