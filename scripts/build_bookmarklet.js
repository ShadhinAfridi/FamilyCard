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
  const publicAppMinPath = path.join(rootDir, 'public', 'bookmarklet', 'app.min.js');
  const publicLoaderPath = path.join(rootDir, 'public', 'bookmarklet', 'loader.min.js');
  const publicUserScriptPath = path.join(rootDir, 'public', 'bookmarklet', 'familycard.user.js');
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

  // 1. Pure minified JS (for remote <script src> and fetch() loader on mobile Chrome)
  const rawMinCode = minResult.code;

  // 2. Full inline bookmarklet (for desktop drag & drop)
  const bookmarkletCode = 'javascript:' + encodeURI(rawMinCode).replace(/#/g, '%23');

  // 3. Tiny 1-line Mobile Chrome Loader Bookmarklet (~500 chars: 0ms re-open + localStorage instant boot + Cloudflare/Firebase dual-CDN fallback)
  const mobileLoaderCode = "javascript:!function(){if(window.__fcOpenModal)return void window.__fcOpenModal();var k='fc_app_v15',c=localStorage.getItem(k),u='https://binary-ict.web.app/bookmarklet/app.min.js',b='https://familycard.afridi.app/bookmarklet/app.min.js';if(c)try{(0,eval)(c)}catch(e){c=0}fetch(u+'?t='+Date.now()).then(function(r){if(!r.ok)throw 0;return r.text()}).catch(function(){return fetch(b+'?t='+Date.now()).then(function(r){return r.text()})}).then(function(t){if(t&&t.length>999){localStorage.setItem(k,t);if(!c)(0,eval)(t)}}).catch(function(){if(!c){var s=document.createElement('script');s.src=u;(document.head||document.documentElement).appendChild(s)}})}();";

  // 4. Tampermonkey / Violentmonkey Userscript for automatic execution on mobile & desktop
  const userScriptHeader = `// ==UserScript==
// @name         Family Card AI Assistant (NID & BRC Scanner + Auto-Fill)
// @namespace    https://binary-ict.web.app/
// @version      1.5.0
// @description  Automated NID/Birth Certificate OCR, Section 3-9 Smart Defaults & 2500 Tk AI Distribution for fc.bhata.gov.bd
// @author       Binary ICT
// @match        https://fc.bhata.gov.bd/*
// @match        http://fc.bhata.gov.bd/*
// @updateURL    https://binary-ict.web.app/bookmarklet/familycard.user.js
// @downloadURL  https://binary-ict.web.app/bookmarklet/familycard.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

`;
  const userScriptCode = userScriptHeader + rawMinCode;

  fs.writeFileSync(distMinPath, bookmarkletCode, 'utf8');
  console.log(`[Build] Written ${distMinPath} (${bookmarkletCode.length} chars)`);

  fs.mkdirSync(path.dirname(publicMinPath), { recursive: true });
  fs.writeFileSync(publicMinPath, bookmarkletCode, 'utf8');
  console.log(`[Build] Written ${publicMinPath} (${bookmarkletCode.length} chars)`);

  fs.writeFileSync(publicAppMinPath, rawMinCode, 'utf8');
  console.log(`[Build] Written ${publicAppMinPath} (${rawMinCode.length} chars - pure minified JS)`);

  fs.writeFileSync(publicLoaderPath, mobileLoaderCode, 'utf8');
  console.log(`[Build] Written ${publicLoaderPath} (${mobileLoaderCode.length} chars - 1-line mobile loader)`);

  fs.writeFileSync(publicUserScriptPath, userScriptCode, 'utf8');
  console.log(`[Build] Written ${publicUserScriptPath} (${userScriptCode.length} chars - Userscript)`);

  fs.writeFileSync(publicSrcPath, srcCode, 'utf8');
  console.log(`[Build] Written ${publicSrcPath} (${srcCode.length} chars)`);

  console.log('✅ Bookmarklet build completed successfully!');
}

build().catch((err) => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
