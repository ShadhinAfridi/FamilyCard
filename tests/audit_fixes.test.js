import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as acorn from 'acorn';

const ROOT = path.resolve(import.meta.dirname, '..');

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function sha256File(relPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, relPath))).digest('hex');
}

function walkAst(node, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item.type === 'string') walkAst(item, visitor);
      }
    } else if (val && typeof val.type === 'string') {
      walkAst(val, visitor);
    }
  }
}

/**
 * Extracts first matching named FunctionDeclaration or VariableDeclaration from JS source.
 * Also rewrites `const`/`let` at declaration root to `var` when running in vm so all helpers become sandbox properties.
 */
function extractDeclCode(src, targetNames, sourceType = 'script', options = {}) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true });
  const wanted = new Set(targetNames);
  const found = new Map();
  const minPos = options.minPos || 0;

  walkAst(ast, (node) => {
    if (node.start < minPos) return;
    if (node.type === 'FunctionDeclaration' && node.id && wanted.has(node.id.name)) {
      if (!found.has(node.id.name)) {
        found.set(node.id.name, { start: node.start, code: src.slice(node.start, node.end) });
      }
    } else if (node.type === 'VariableDeclaration') {
      if (node.declarations.length === 1) {
        const d = node.declarations[0];
        if (d.id && d.id.type === 'Identifier' && wanted.has(d.id.name) && !found.has(d.id.name)) {
          let code = src.slice(node.start, node.end);
          code = code.replace(/^(const|let)\s+/, 'var ');
          found.set(d.id.name, { start: node.start, code });
        }
      } else {
        for (const d of node.declarations) {
          if (d.id && d.id.type === 'Identifier' && wanted.has(d.id.name) && !found.has(d.id.name)) {
            found.set(d.id.name, { start: d.start, code: 'var ' + src.slice(d.start, d.end) + ';' });
          }
        }
      }
    }
  });

  const missing = [...wanted].filter((n) => !found.has(n));
  if (missing.length > 0) {
    throw new Error(`Missing declarations: ${missing.join(', ')}`);
  }

  return [...found.values()]
    .sort((a, b) => a.start - b.start)
    .map((entry) => entry.code)
    .join('\n\n');
}

function createSandbox(extra = {}) {
  const ctx = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    URL,
    URLSearchParams,
    Set,
    Map,
    Date,
    Math,
    RegExp,
    Error,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Promise,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    process: { env: {} },
    ...extra,
  };
  vm.createContext(ctx);
  return ctx;
}

// ============================================================================
// 1. Syntax checks & build sync parity
// ============================================================================

test('All JavaScript source files pass node --check', () => {
  const files = [
    'app.js',
    'server/server.js',
    'cloudflare/worker.js',
    'public/_worker.js',
    'extension/background.js',
    'extension/content.js',
    'extension/popup.js',
    'bookmarklet/bookmarklet.js',
    'scripts/build_worker.js',
    'scripts/build_bookmarklet.js',
    'scripts/deploy_cloudflare_pages.js',
  ];
  for (const rel of files) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
  }
});

test('Build & deploy parity: root/public web assets, worker, bookmarklet, and all 4 extension.zip archives match', () => {
  const pairs = [
    ['index.html', 'public/index.html'],
    ['app.js', 'public/app.js'],
    ['style.css', 'public/style.css'],
    ['cloudflare/worker.js', 'public/_worker.js'],
    ['bookmarklet/index.html', 'public/bookmarklet/index.html'],
    ['bookmarklet/bookmarklet.js', 'public/bookmarklet/bookmarklet.js'],
    ['bookmarklet/bookmarklet.min.js', 'public/bookmarklet/bookmarklet.min.js'],
  ];
  for (const [src, dst] of pairs) {
    assert.equal(sha256File(src), sha256File(dst), `${src} and ${dst} must be byte-identical`);
  }

  for (const extra of [
    'public/bookmarklet/app.min.js',
    'public/bookmarklet/loader.min.js',
    'public/bookmarklet/familycard.user.js',
    'scripts/worker.min.js',
  ]) {
    assert.ok(fs.statSync(path.join(ROOT, extra)).size > 500, `${extra} must exist and be non-empty`);
  }

  const zipTargets = [
    'extension.zip',
    'bookmarklet/extension.zip',
    'public/extension.zip',
    'public/bookmarklet/extension.zip',
  ];
  const expectedHash = sha256File(zipTargets[0]);
  for (const z of zipTargets.slice(1)) {
    assert.equal(sha256File(z), expectedHash, `${z} must match extension.zip`);
  }

  // Verify extension.zip entries match extension/* files byte-for-byte via python zipfile
  const pyCheck = `
import os, zipfile, hashlib
zf = zipfile.ZipFile('extension.zip', 'r')
z_names = sorted(zf.namelist())
d_names = sorted(os.path.relpath(os.path.join(r, f), 'extension').replace(os.sep, '/') for r, _, fs in os.walk('extension') for f in fs)
assert z_names == d_names, (z_names, d_names)
for n in d_names:
    zh = hashlib.sha256(zf.read(n)).hexdigest()
    dh = hashlib.sha256(open(os.path.join('extension', n), 'rb').read()).hexdigest()
    assert zh == dh, n
print('ZIP_OK', len(d_names))
`;
  const out = execFileSync('python', ['-c', pyCheck], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /ZIP_OK \d+/);
});

test('Security & config checks: capture/PDF inputs, manifest host_permissions, firebase ignore, loader cleanups', () => {
  const indexHtml = readRepoFile('index.html');
  assert.ok(!/capture\s*=\s*["']environment["']/i.test(indexHtml), 'index.html must not force capture="environment" on file input');
  assert.match(indexHtml, /id="fileInput"[^>]*application\/pdf/i, 'index.html fileInput must accept application/pdf');

  const manifest = JSON.parse(readRepoFile('extension/manifest.json'));
  for (const wildcard of ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']) {
    assert.ok(!manifest.host_permissions.includes(wildcard), `manifest.host_permissions must not contain ${wildcard}`);
  }
  assert.ok(manifest.optional_host_permissions.includes('http://*/*') && manifest.optional_host_permissions.includes('https://*/*'));

  const firebaseJson = JSON.parse(readRepoFile('firebase.json'));
  assert.ok(
    Array.isArray(firebaseJson.hosting?.ignore) &&
      firebaseJson.hosting.ignore.some((p) => p === '_worker.js' || p === '**/_worker.js')
  );

  const bmHtml = readRepoFile('bookmarklet/index.html');
  assert.ok(bmHtml.includes("localStorage.removeItem('fc_app_v18')"), 'bookmarklet/index.html should clean up legacy fc_app_v18 cache');
  assert.ok(bmHtml.includes("localStorage.removeItem('fc_app_v15')"), 'bookmarklet/index.html should clean up legacy fc_app_v15 cache');
  assert.ok(bmHtml.includes("var k='fc_app_v19'"), 'bookmarklet/index.html shortLoaderCode should preserve fc_app_v19 cache key');
});

// ============================================================================
// 2. Shared OCR / Transliteration / Date / Validation suite across codebases
// ============================================================================

const CORE_TRANSLIT_DATE_SYMBOLS = [
  'normalizeDigits',
  'hasBengaliScript',
  'BN_NAME_WORD_MAP',
  'EN_NAME_WORD_MAP',
  'transliterateBnWordToEn',
  'normalizeEnglishHonorificPrefix',
  'transliterateBnToEn',
  'isValidCalendarDate',
  'standardizeDate',
];

const OCR_PIPELINE_SYMBOLS = [
  ...CORE_TRANSLIT_DATE_SYMBOLS,
  'BDT_PER_USD',
  'DEFAULT_GEMINI_MODEL',
  'INTERACTIONS_API_MODELS',
  'AI_MODEL_CATALOG',
  'isDeepSeekPeakUtc',
  'normalizeModelId',
  'computeScanUsageAndCost',
  'transliterateEnWordToBn',
  'transliterateEnToBn',
  'stripPersonPrefixes',
  'cleanOcrFieldText',
  'normalizeOcrKeyAliases',
  'needsIntelligentCompletion',
  'needsEnglishCompletion',
  'OCR_RESPONSE_SCHEMA',
  'buildGeminiPrompt',
  'parseOcrJsonText',
  'GENDER_ALIAS_MAP',
  'normalizeGenderValue',
  'inferBangladeshiGender',
  'extractDigitCandidate',
  'pickBestDocDigits',
  'getDobYear',
  'isDocDigitsValidForType',
  'validateAndNormalizeOcrData',
];

function loadServerOcrSandbox(mockFetch = async () => ({ ok: true, json: async () => ({}) })) {
  const src = readRepoFile('server/server.js');
  const code = extractDeclCode(src, [
    ...OCR_PIPELINE_SYMBOLS,
    'extractTextFromGeminiResponse',
    'applyBilingualCompletionResult',
    'buildBilingualCompletionPrompt',
    'completeBanglaOnlyOcrWithDeepSeek',
    'completeBilingualWithGemini',
    'callDeepSeekVisionOCR',
    'needsAccurateEscalation',
    'mergeOcrResults',
    'getOrderedGeminiModels',
    'buildGeminiAttemptsForModels',
    'runGeminiCascade',
    'extractNidWithAI',
  ], 'module');
  const ctx = createSandbox({ fetch: mockFetch });
  vm.runInContext(code, ctx, { filename: 'server/server.js' });
  return ctx;
}

function loadWorkerOcrSandbox() {
  const src = readRepoFile('cloudflare/worker.js');
  const code = extractDeclCode(src, [
    ...OCR_PIPELINE_SYMBOLS,
    'extractTextFromGemini',
  ], 'module');
  const ctx = createSandbox({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  vm.runInContext(code, ctx, { filename: 'cloudflare/worker.js' });
  return ctx;
}

function loadBackgroundOcrSandbox(mockFetch = async () => ({ ok: true, json: async () => ({}) })) {
  const src = readRepoFile('extension/background.js');
  const code = extractDeclCode(src, [
    ...OCR_PIPELINE_SYMBOLS,
    'extractTextFromGeminiResponse',
    'FIRESTORE_ERROR_LOGS_BASE',
    'logBackendErrorToFirebase',
    'applyBilingualCompletionResult',
    'buildBilingualCompletionPrompt',
    'completeBanglaOnlyOcrWithDeepSeek',
    'completeBilingualWithGemini',
    'callDeepSeekVisionOCR',
    'needsAccurateEscalation',
    'mergeOcrResults',
    'getOrderedGeminiModels',
    'buildGeminiAttemptsForModels',
    'callGeminiResilientOCR',
    'runMultiProviderOCR',
  ], 'script');
  const ctx = createSandbox({ fetch: mockFetch, chrome: { storage: { local: { set: () => {} } } } });
  vm.runInContext(code, ctx, { filename: 'extension/background.js' });
  return ctx;
}

function loadContentSandbox() {
  const src = readRepoFile('extension/content.js');
  // Need normalizeDigits & hasBengaliScript if present; inspect what helpers content.js uses
  const extraNeeded = [];
  for (const sym of ['normalizeDigits', 'hasBengaliScript', 'transliterateEnWordToBn', 'transliterateEnToBn', 'stripPersonPrefixes', 'toBnDigits', 'normalizeApplicantPayload']) {
    if (new RegExp(`(?:function|const|let|var)\\s+${sym}\\b`).test(src)) extraNeeded.push(sym);
  }
  const code = extractDeclCode(src, [...CORE_TRANSLIT_DATE_SYMBOLS.filter((s) => new RegExp(`(?:function|const|let|var)\\s+${s}\\b`).test(src)), ...extraNeeded], 'script');
  const ctx = createSandbox();
  vm.runInContext(code, ctx, { filename: 'extension/content.js' });
  return ctx;
}

function loadBookmarkletSandbox(mockFetch = async () => ({ ok: true, json: async () => ({}) })) {
  const src = readRepoFile('bookmarklet/bookmarklet.js');
  // Check exact helper names present in bookmarklet.js
  const code = extractDeclCode(src, [
    ...OCR_PIPELINE_SYMBOLS,
    'extractTextFromGeminiResponse',
    'FIRESTORE_ERROR_LOGS_BASE',
    'normalizeApplicantPayload',
    'buildGeminiAttemptsForModels',
    'callDeepSeekVisionOCR',
    'buildBilingualCompletionPrompt',
    'completeBanglaOnlyOcrWithDeepSeek',
    'toBnDigits',
  ], 'script');
  const ctx = createSandbox({
    fetch: mockFetch,
    window: { location: { origin: 'https://fc.bhata.gov.bd' } },
  });
  vm.runInContext(code, ctx, { filename: 'bookmarklet/bookmarklet.js' });
  return ctx;
}

test('Transliteration, honorific prefixes, word maps & date validation work consistently across all 5 codebases', () => {
  const targets = [
    ['server/server.js', loadServerOcrSandbox()],
    ['cloudflare/worker.js', loadWorkerOcrSandbox()],
    ['extension/background.js', loadBackgroundOcrSandbox()],
    ['extension/content.js', loadContentSandbox()],
    ['bookmarklet/bookmarklet.js', loadBookmarkletSandbox()],
  ];

  for (const [label, ctx] of targets) {
    assert.equal(ctx.BN_NAME_WORD_MAP['মোছাঃ'], 'MST.', `${label}: মোছাঃ -> MST.`);
    assert.equal(ctx.BN_NAME_WORD_MAP['মোসাম্মৎ'], 'MOSAMMAT', `${label}: মোসাম্মৎ -> MOSAMMAT`);
    assert.equal(ctx.BN_NAME_WORD_MAP['মোসাঃ'], 'MOSA.', `${label}: মোসাঃ -> MOSA.`);
    assert.equal(ctx.EN_NAME_WORD_MAP.MONDAL, 'মন্ডল', `${label}: MONDAL -> মন্ডল`);
    assert.equal(ctx.EN_NAME_WORD_MAP.MANDAL, 'মন্ডল', `${label}: MANDAL -> মন্ডল`);
    assert.equal(ctx.EN_NAME_WORD_MAP.SOHAG, 'সোহাগ', `${label}: SOHAG -> সোহাগ`);

    assert.equal(ctx.transliterateBnWordToEn('প্রধান'), 'PRADHAN', `${label}: প্রধান -> PRADHAN`);
    assert.equal(ctx.transliterateBnWordToEn('স্বপন'), 'SWAPAN', `${label}: স্বপন -> SWAPAN`);

    assert.equal(ctx.normalizeEnglishHonorificPrefix('MST.RAHIMA', 'মোছাঃ রহিমা'), 'MST. RAHIMA', `${label}: MST.RAHIMA`);
    assert.equal(ctx.normalizeEnglishHonorificPrefix('MD.RAHIM', 'মোঃ রহিম'), 'MD. RAHIM', `${label}: MD.RAHIM`);
    assert.equal(ctx.normalizeEnglishHonorificPrefix('MOST. SALMA', 'মোছাঃ সালমা'), 'MST. SALMA', `${label}: MOST. SALMA -> MST. SALMA`);
    assert.equal(ctx.normalizeEnglishHonorificPrefix('RAHIMA KHATUN', 'মোছাঃ রহিমা খাতুন'), 'MST. RAHIMA KHATUN', `${label}: prepends MST.`);
    assert.equal(ctx.normalizeEnglishHonorificPrefix('MST. RAHIMA', 'মোছাঃ রহিমা'), 'MST. RAHIMA', `${label}: no double prefix`);

    assert.equal(ctx.standardizeDate('29/02/2000'), '29/02/2000', `${label}: leap day valid`);
    assert.equal(ctx.standardizeDate('29/02/1999'), '', `${label}: non-leap 29/02 rejected`);
    assert.equal(ctx.standardizeDate('99/45/1990'), '', `${label}: impossible date 99/45/1990 -> ''`);
    assert.equal(ctx.standardizeDate('00/00/1990'), '', `${label}: 00/00/1990 -> ''`);
    assert.equal(ctx.standardizeDate('তারিখঃ ১২/০৫/১৯৮৮'), '12/05/1988', `${label}: Bengali label + digits`);
    assert.equal(ctx.standardizeDate('05/28/1992'), '28/05/1992', `${label}: MM/DD swap`);
    assert.equal(ctx.standardizeDate('DOB: 1995-07-04'), '04/07/1995', `${label}: YYYY-MM-DD`);
  }
});

test('pickBestDocDigits & validateAndNormalizeOcrData work across server, worker, background & bookmarklet', () => {
  const pipelines = [
    ['server', loadServerOcrSandbox()],
    ['worker', loadWorkerOcrSandbox()],
    ['background', loadBackgroundOcrSandbox()],
    ['bookmarklet', loadBookmarkletSandbox()],
  ];

  for (const [label, ctx] of pipelines) {
    // Priority order strictly respects preferredLengths order ([10, 17, 13] picks 10 over 17)
    const picked10 = ctx.pickBestDocDigits(['BRN 20011234567890123', 'NID: ৫৫৫১২৩৪৫৬৭'], [10, 17, 13]);
    assert.equal(picked10, '5551234567', `${label}: prefers 10 digits when [10,17,13]`);

    const picked17 = ctx.pickBestDocDigits(['BRN: ২০০১১২৩৪৫৬৭৮৯০১২৩.'], [17]);
    assert.equal(picked17, '20011234567890123', `${label}: extracts embedded 17 digits`);

    // validateAndNormalizeOcrData: father/mother NID sanitized writeback, BRC preserved with strong metadata, honorific normalized across all 4 pairs
    const res = ctx.validateAndNormalizeOcrData({
      doc_type: 'birth_certificate',
      name_bn: 'মোছাঃ রহিমা খাতুন',
      name_en: 'MST.RAHIMA KHATUN',
      father_name_bn: 'মোঃ করিম উদ্দিন',
      father_name_en: 'MD.KARIM UDDIN',
      mother_name_bn: 'মোছাঃ আমেনা বেগম',
      mother_name_en: 'MOST. AMENA BEGUM',
      spouse_name_bn: '',
      spouse_name_en: '',
      nid_number: '1234567890',
      birth_reg_no: '20101234567890123',
      father_nid: '১৯৮০১২৩৪৫৬৭৮৯০১২৩',
      mother_nid: '8881234567',
      registration_date: '15/06/2012',
      dob: '01/03/2010',
    }, {});

    assert.equal(res.doc_type, 'birth_certificate', `${label}: BRC preserved when strong metadata present`);
    assert.equal(res.father_nid, '19801234567890123', `${label}: father_nid sanitized & written back`);
    assert.equal(res.mother_nid, '8881234567', `${label}: mother_nid sanitized & written back`);
    assert.equal(res.name_en, 'MST. RAHIMA KHATUN', `${label}: applicant honorific fixed`);
    assert.equal(res.father_name_en, 'MD. KARIM UDDIN', `${label}: father honorific fixed`);
    assert.equal(res.mother_name_en, 'MST. AMENA BEGUM', `${label}: mother honorific fixed`);
  }
});

// ============================================================================
// 3. Model Escalation, PDF Guards, DeepSeek Flash Priority (server, bg, bm, worker)
// ============================================================================

test('server.js: skips Interactions on PDF, rejects PDF on DeepSeek, prioritizes deepseek-flash, keeps gemini-4-argon in economy mode', async () => {
  const requests = [];
  const mockFetch = async (url, init = {}) => {
    requests.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes(':generateContent')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ doc_type: 'nid', name_bn: 'মোছাঃ সালমা', name_en: 'MST. SALMA', nid_number: '5551234567', dob: '01/02/1990', confidence: 0.99 }) }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
        }),
      };
    }
    if (String(url).includes('api.deepseek.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ name_bn: 'মোছাঃ সালমা', name_en: 'MST. SALMA' }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const ctx = loadServerOcrSandbox(mockFetch);

  // 1) buildGeminiAttemptsForModels skips Interactions endpoints when mimeType is application/pdf
  const pdfAttempts = ctx.buildGeminiAttemptsForModels(['gemini-4-argon', 'gemini-3.8-flash'], 'AIza-test', 'JVBERi0xLjQ=', 'application/pdf', 'OCR');
  assert.ok(pdfAttempts.length > 0);
  assert.ok(pdfAttempts.every((a) => !a.url.includes('/interactions')), 'PDF must never target /interactions endpoint');
  assert.ok(pdfAttempts.every((a) => a.url.includes(':generateContent')), 'PDF must use :generateContent');

  // Image attempts SHOULD include /interactions for INTERACTIONS_API_MODELS
  const imgAttempts = ctx.buildGeminiAttemptsForModels(['gemini-3.8-flash'], 'AIza-test', '/9j/4AAQ', 'image/jpeg', 'OCR');
  assert.ok(imgAttempts.some((a) => a.url.includes('/interactions')), 'Image can use /interactions for supported models');

  // 2) callDeepSeekVisionOCR throws isVisionUnsupported on application/pdf
  await assert.rejects(
    () => ctx.callDeepSeekVisionOCR('sk-test', 'JVBERi0xLjQ=', 'application/pdf', 'OCR', 'deepseek-flash'),
    (err) => err && err.isVisionUnsupported === true
  );

  // 3) callDeepSeekVisionOCR prioritizes deepseek-flash even when deepseek-chat is passed
  requests.length = 0;
  await ctx.callDeepSeekVisionOCR('sk-test', '/9j/4AAQ', 'image/jpeg', 'OCR', 'deepseek-chat');
  assert.equal(requests[0].body.model, 'deepseek-flash');

  // 4) extractNidWithAI in economy mode with geminiModel: 'gemini-4-argon' does NOT downgrade to flash38_only
  requests.length = 0;
  await ctx.extractNidWithAI('data:image/jpeg;base64,/9j/4AAQ', 'AIza-test', {
    aiProvider: 'economy',
    geminiModel: 'gemini-4-argon',
    docType: 'nid',
  });
  assert.ok(
    requests[0].body?.model === 'gemini-4-argon' || requests[0].url.includes('gemini-4-argon'),
    `Expected gemini-4-argon first in economy mode, got model=${requests[0].body?.model} url=${requests[0].url}`
  );
});

test('extension/background.js & bookmarklet/bookmarklet.js: PDF/DeepSeek/economy flagship behavior', async () => {
  // Background.js checks
  const bgReqs = [];
  const bgFetch = async (url, init = {}) => {
    bgReqs.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes(':generateContent') || String(url).includes('/interactions')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ doc_type: 'nid', name_bn: 'মোছাঃ সালমা', name_en: 'MST. SALMA', nid_number: '5551234567', dob: '01/02/1990', confidence: 0.99 }) }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: '{}' } }], usage: {} }),
    };
  };
  const bg = loadBackgroundOcrSandbox(bgFetch);
  const bgPdfAttempts = bg.buildGeminiAttemptsForModels(['gemini-4-argon', 'gemini-3.8-flash'], 'AIza-test', 'JVBERi', 'application/pdf', 'OCR');
  assert.ok(bgPdfAttempts.every((a) => !a.url.includes('/interactions')));

  await assert.rejects(
    () => bg.callDeepSeekVisionOCR('sk-test', 'JVBERi', 'application/pdf', 'OCR', 'deepseek-flash'),
    (err) => err && err.isVisionUnsupported === true
  );
  bgReqs.length = 0;
  await bg.callDeepSeekVisionOCR('sk-test', '/9j/4AAQ', 'image/jpeg', 'OCR', 'deepseek-chat');
  assert.equal(bgReqs[0].body.model, 'deepseek-flash');

  bgReqs.length = 0;
  await bg.runMultiProviderOCR({
    aiProvider: 'economy',
    geminiModel: 'gemini-4-argon',
    geminiKey: 'AIza-test',
    rawBase64: '/9j/4AAQ',
    detectedMime: 'image/jpeg',
    promptText: 'OCR',
    docType: 'nid',
  });
  assert.ok(
    bgReqs[0].body?.model === 'gemini-4-argon' || bgReqs[0].url.includes('gemini-4-argon'),
    `background economy flagship got model=${bgReqs[0].body?.model} url=${bgReqs[0].url}`
  );

  // Bookmarklet.js checks
  const bmReqs = [];
  const bmFetch = async (url, init = {}) => {
    bmReqs.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: '{}' } }], usage: {} }),
    };
  };
  const bm = loadBookmarkletSandbox(bmFetch);
  const bmPdfAttempts = bm.buildGeminiAttemptsForModels(['gemini-4-argon', 'gemini-3.8-flash'], 'AIza-test', 'JVBERi', 'application/pdf', 'OCR');
  assert.ok(bmPdfAttempts.every((a) => !a.url.includes('/interactions')));

  await assert.rejects(
    () => bm.callDeepSeekVisionOCR('sk-test', 'JVBERi', 'application/pdf', 'OCR', 'deepseek-flash'),
    (err) => err && err.isVisionUnsupported === true
  );
  bmReqs.length = 0;
  await bm.callDeepSeekVisionOCR('sk-test', '/9j/4AAQ', 'image/jpeg', 'OCR', 'deepseek-chat');
  assert.equal(bmReqs[0].body.model, 'deepseek-flash');

  // Verify economy flagship check in bookmarklet source code directly
  const bmSrc = readRepoFile('bookmarklet/bookmarklet.js');
  assert.match(bmSrc, /isFlagship\s*=\s*prefGemModel\s*===\s*['"]gemini-3\.8-flash['"]\s*\|\|\s*prefGemModel\s*===\s*['"]gemini-4-argon['"]/);
  assert.match(bmSrc, /firstProfile\s*=\s*isFlagship\s*\?\s*['"]preferred['"]\s*:\s*['"]lite_only['"]/);
});

// ============================================================================
// 4. Cloudflare Worker fetch() end-to-end & server room sync tests
// ============================================================================

test('cloudflare/worker.js fetch(): PDF/DeepSeek/economy flagship, survey_house_saved room sync & Firestore waitUntil', async () => {
  const workerSrc = readRepoFile('cloudflare/worker.js').replace(/\bexport\s+default\s*\{/, 'globalThis.__worker = {');
  const outboundCalls = [];
  const waitUntilPromises = [];

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    outboundCalls.push({ url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (u.includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ doc_type: 'nid', name_bn: 'মোছাঃ রহিমা', name_en: 'MST.RAHIMA', nid_number: '5551234567', dob: '05/06/1991', confidence: 0.99 }) }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 12 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('api.deepseek.com')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ doc_type: 'nid', name_bn: 'মোছাঃ রহিমা', name_en: 'MST. RAHIMA', nid_number: '5551234567', dob: '05/06/1991' }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 12 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('firestore.googleapis.com')) {
      return new Response(JSON.stringify({ fields: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('OK', { status: 200 });
  };

  const ctxSandbox = createSandbox({ fetch: mockFetch, Request, Response, Headers });
  vm.runInContext(workerSrc, ctxSandbox, { filename: 'cloudflare/worker.js' });
  const worker = ctxSandbox.__worker;
  const mockCtx = { waitUntil: (p) => waitUntilPromises.push(p) };
  const mockEnv = { ASSETS: { fetch: async () => new Response('asset', { status: 200 }) } };

  // A) PDF + Gemini + economyMode + gemini-4-argon
  outboundCalls.length = 0;
  waitUntilPromises.length = 0;
  const pdfRes = await worker.fetch(new Request('https://familycard-10n.pages.dev/api/ocr-nid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64: 'data:application/pdf;base64,JVBERi0xLjQ=',
      provider: 'gemini',
      apiKey: 'AIza-worker',
      geminiModel: 'gemini-4-argon',
      economyMode: true,
    }),
  }), mockEnv, mockCtx);
  const pdfJson = await pdfRes.json();
  assert.equal(pdfJson.success, true);
  assert.equal(pdfJson.data.name_en, 'MST. RAHIMA');
  const gemCalls = outboundCalls.filter((c) => c.url.includes('generativelanguage.googleapis.com'));
  assert.ok(gemCalls[0].url.includes('gemini-4-argon'), `Worker economy flagship called ${gemCalls[0].url}`);
  assert.ok(gemCalls.every((c) => !c.url.includes('/interactions')), 'Worker PDF must not use /interactions');
  assert.ok(waitUntilPromises.length > 0, 'Worker must schedule Firestore sync via ctx.waitUntil');
  await Promise.all(waitUntilPromises);

  // B) PDF + DeepSeek rejects cleanly
  outboundCalls.length = 0;
  const dsPdfRes = await worker.fetch(new Request('https://familycard-10n.pages.dev/api/ocr-nid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64: 'data:application/pdf;base64,JVBERi0xLjQ=',
      provider: 'deepseek',
      deepseekApiKey: 'sk-worker',
    }),
  }), mockEnv, mockCtx);
  const dsPdfJson = await dsPdfRes.json();
  assert.equal(dsPdfJson.success, false);
  assert.ok(outboundCalls.filter((c) => c.url.includes('api.deepseek.com')).length === 0, 'DeepSeek must not be called for PDF');

  // C) Image + DeepSeek calls deepseek-flash
  outboundCalls.length = 0;
  await worker.fetch(new Request('https://familycard-10n.pages.dev/api/ocr-nid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64: 'data:image/jpeg;base64,/9j/4AAQ',
      provider: 'deepseek',
      deepseekApiKey: 'sk-worker',
      deepseekModel: 'deepseek-chat',
    }),
  }), mockEnv, mockCtx);
  const dsCall = outboundCalls.find((c) => c.url.includes('api.deepseek.com'));
  assert.ok(dsCall);
  assert.equal(dsCall.body.model, 'deepseek-flash');

  // D) survey_house_saved retained in normalizeWorkerRoomMsg
  const msg = ctxSandbox.normalizeWorkerRoomMsg({ type: 'survey_house_saved', text: 'saved', house_record: { docId: 'H1' } }, 'FC-101');
  assert.equal(msg.type, 'survey_house_saved');
});

test('server/server.js room sync: retains survey_house_saved and loadCloudRoomMessages enforces pageSize=200 & cleared_at_ms filtering', async () => {
  const src = readRepoFile('server/server.js');
  const code = extractDeclCode(src, [
    'normalizeDigits',
    'FIRESTORE_ROOMS_BASE',
    'MAX_ROOM_MESSAGES',
    'normalizeRoomCode',
    'makeRoomMsgId',
    'normalizeRoomMessage',
    'syncRoomClearedAtToFirestore',
    'loadCloudRoomMessages',
  ], 'module');

  const fetchedUrls = [];
  const mockFetch = async (url) => {
    const u = String(url);
    fetchedUrls.push(u);
    if (u.endsWith('/room_channels/FC-999')) {
      return {
        ok: true,
        json: async () => ({ fields: { cleared_at_ms: { integerValue: '2000' } } }),
      };
    }
    if (u.includes('/room_channels/FC-999/messages?')) {
      return {
        ok: true,
        json: async () => ({
          documents: [
            { fields: { id: { stringValue: 'm1' }, ts: { integerValue: '1000' }, type: { stringValue: 'text' }, text: { stringValue: 'old' } } },
            { fields: { id: { stringValue: 'm2' }, ts: { integerValue: '2000' }, type: { stringValue: 'text' }, text: { stringValue: 'boundary' } } },
            { fields: { id: { stringValue: 'm3' }, ts: { integerValue: '3000' }, type: { stringValue: 'survey_house_saved' }, text: { stringValue: 'house' } } },
          ],
        }),
      };
    }
    return { ok: false, json: async () => ({}) };
  };

  const ctx = createSandbox({ fetch: mockFetch });
  vm.runInContext(code, ctx, { filename: 'server/server.js' });

  const norm = ctx.normalizeRoomMessage({ type: 'survey_house_saved', text: 'house' }, 'FC-999');
  assert.equal(norm.type, 'survey_house_saved');

  const loaded = await ctx.loadCloudRoomMessages('FC-999');
  assert.ok(fetchedUrls.some((u) => u.includes('pageSize=200')), 'Must request pageSize=200 from Firestore messages');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'm3');
  assert.equal(loaded[0].type, 'survey_house_saved');
});

// ============================================================================
// 5. app.js client web companion tests (toBnDigits, prefix/date, XSS-safe map UI, fallback)
// ============================================================================

test('app.js: toBnDigits, normalizeDirectWebPrefix, standardizeWebDate, map badge update when !leafletMap, XSS-safe house HTML', () => {
  const src = readRepoFile('app.js');
  const code = extractDeclCode(src, [
    'normalizeDigits',
    'toBnDigits',
    'escapeHtml',
    'normalizeDirectWebPrefix',
    'standardizeWebDate',
    'TAG_CONFIG',
    'buildHousePopupHtml',
    'renderMapHouses',
    'renderHouseListFeed',
  ], 'script');

  const badgeEl = { textContent: '' };
  const makeMockEl = (tag = 'div') => ({
    tagName: tag.toUpperCase(),
    className: '',
    dataset: {},
    innerHTML: '',
    textContent: '',
    style: {},
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(k, v) {
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[camel] = String(v);
      }
      this[k] = String(v);
    },
  });
  const feedEl = makeMockEl('div');
  const mapObj = new Map([
    ['xss1', {
      docId: `h1"><script>alert(1)</script>`,
      ladyName: `<img src=x onerror=alert(2)>`,
      village: `"'onclick=alert(3)`,
      contactPhone: '01700000000',
      survey_status: 'COMPLETED',
      issues: [],
      lat: 23.75,
      lng: 89.65,
    }],
    ['badgeo', {
      docId: 'h2',
      ladyName: 'Normal',
      survey_status: 'INCOMPLETE_BLOCKED',
      issues: [],
      lat: 'invalid<script>',
      lng: NaN,
    }],
  ]);

  const ctx = createSandbox({
    mapHouseCountBadge: badgeEl,
    leafletMap: null,
    leafletMarkersLayer: null,
    surveyHousesMap: mapObj,
    houseListFeed: feedEl,
    activeMapFilter: 'all',
    mapSearchQuery: '',
    selectedHouseId: '',
    statTotalHouses: null,
    statCompletedHouses: null,
    statFixableHouses: null,
    statBlockedHouses: null,
    filteredHouseCount: null,
    document: {
      getElementById: () => null,
      createElement: (tag) => makeMockEl(tag),
    },
  });
  vm.runInContext(code, ctx, { filename: 'app.js' });

  assert.equal(ctx.toBnDigits(12340), '১২৩৪০');
  assert.equal(ctx.toBnDigits(null), '');

  assert.equal(ctx.normalizeDirectWebPrefix('MST.RAHIMA', 'মোছাঃ রহিমা'), 'MST. RAHIMA');
  assert.equal(ctx.normalizeDirectWebPrefix('MOST. SALMA', 'মোছাঃ সালমা'), 'MST. SALMA');
  assert.equal(ctx.normalizeDirectWebPrefix('MD.RAHIM', 'মোঃ রহিম'), 'MD. RAHIM');
  assert.equal(ctx.normalizeDirectWebPrefix('RAHIMA', 'মোছাঃ রহিমা'), 'MST. RAHIMA');

  assert.equal(ctx.standardizeWebDate('তারিখঃ ১২/০৩/১৯৮৫'), '12/03/1985');
  assert.equal(ctx.standardizeWebDate('02/25/1990'), '25/02/1990');
  assert.equal(ctx.standardizeWebDate('99/45/1990'), '');
  assert.equal(ctx.standardizeWebDate('00/00/1990'), '');

  // renderMapHouses updates mapHouseCountBadge BEFORE returning early when !leafletMap
  ctx.renderMapHouses();
  assert.equal(badgeEl.textContent, '২');

  // XSS immunity in buildHousePopupHtml and renderHouseListFeed
  const popupHtml = ctx.buildHousePopupHtml(mapObj.get('xss1'));
  assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(popupHtml), 'Popup HTML must never contain unescaped inline event handler attributes');
  assert.ok(!popupHtml.includes('<script>'), 'Popup HTML must escape <script>');
  assert.ok(!popupHtml.includes('<img src=x onerror='), 'Popup HTML must escape <img> injection');
  assert.match(popupHtml, /data-doc-id="/);

  ctx.renderHouseListFeed([mapObj.get('xss1'), mapObj.get('badgeo')]);
  const serializedCards = feedEl.children.map((c) => c.innerHTML).join('\n');
  assert.equal(feedEl.children.length, 2, 'House feed must render 2 card elements');
  assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(serializedCards), 'House feed must never contain unescaped inline event handler attributes');
  assert.ok(!serializedCards.includes('<script>'), 'House feed must escape <script>');
  assert.ok(!serializedCards.includes('<img src=x onerror='), 'House feed must escape <img> injection');
  assert.match(feedEl.children[0].innerHTML, /data-doc-id="h1&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.match(feedEl.children[0].innerHTML, /data-lat="23\.75"/);
  assert.match(feedEl.children[0].innerHTML, /data-lng="89\.65"/);
  assert.ok(!feedEl.children[1].innerHTML.includes('fc-house-center-btn'), 'Invalid lat/lng house must not emit map center button');
  assert.ok(!feedEl.children[1].innerHTML.includes('data-lat='), 'Invalid lat/lng house must not emit data-lat');
});

// ============================================================================
// 6. Single-Survey Timer Lifecycle, DB Sync & Stats Tests
// ============================================================================

test('firestore.rules & HTML/CSS expose survey timer controls cleanly', () => {
  const rules = readRepoFile('firestore.rules');
  assert.match(rules, /match\s+\/survey_timers\/\{timerId\}/);
  assert.match(rules, /function\s+isReasonableFamilyCardDoc\(\)/);
  assert.match(rules, /keys\(\)\.size\(\)\s*<=\s*85/);

  const indexHtml = readRepoFile('index.html');
  assert.match(indexHtml, /id="surveyTimerBar"/);
  assert.match(indexHtml, /id="surveyTimerClock"/);
  assert.match(indexHtml, /id="btnSurveyStart"/);
  assert.match(indexHtml, /id="btnSurveyEnd"/);
  assert.match(indexHtml, /id="modalSurveyTimerBadge"/);

  const extCss = readRepoFile('extension/content.css');
  assert.match(extCss, /#fc-timer-btn/);
});

test('server/server.js & cloudflare/worker.js: /api/survey-timer POST/GET & Firestore sync', async () => {
  const srvSrc = readRepoFile('server/server.js');
  const srvCode = extractDeclCode(srvSrc, [
    'normalizeDigits',
    'normalizeRoomCode',
    'makeRoomMsgId',
    'normalizeRoomMessage',
    'FIRESTORE_CARDS_BASE',
    'FIRESTORE_SURVEY_TIMERS_LOG_BASE',
    'FIRESTORE_SURVEY_TIMERS_COLLECTION_BASE',
    'FIRESTORE_HOUSES_BASE',
    'formatSurveyDurationShort',
    'normalizeSurveyTimerPayload',
    'buildSurveyTimerFirestoreFields',
    'syncSurveyTimerToFirestore',
    'fetchSurveyTimersFromFirestore',
  ], 'module');

  const srvCalls = [];
  const srvSandbox = createSandbox({
    fetch: async (url, init = {}) => {
      srvCalls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes('/SURVEY_TIMERS/logs?pageSize=')) {
        return {
          ok: true,
          json: async () => ({
            documents: [{
              fields: {
                session_id: { stringValue: 'srv_db_1' },
                family_id: { stringValue: '900111' },
                doc_id: { stringValue: '5551234567' },
                applicant_name: { stringValue: 'মোছাঃ সালমা' },
                ended_at_ms: { integerValue: '1700000120000' },
                duration_sec: { integerValue: '120' },
                duration_label: { stringValue: '২ মিঃ ০ সেঃ' }
              }
            }]
          })
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  vm.runInContext(srvCode, srvSandbox, { filename: 'server/server.js' });

  // normalizeRoomMessage allows survey_timer_ended
  assert.equal(srvSandbox.normalizeRoomMessage({ type: 'survey_timer_ended', text: 'done' }, 'FC-101').type, 'survey_timer_ended');

  const entry = srvSandbox.normalizeSurveyTimerPayload({
    sessionId: 'srv_test_1',
    familyId: '987654',
    docId: '5551234567',
    applicantName: 'মোছাঃ রহিমা',
    startedAtMs: 1700000000000,
    endedAtMs: 1700000135000,
    source: 'extension',
    endReason: 'portal_submit',
  });
  assert.equal(entry.durationSec, 135);
  assert.equal(entry.durationLabel, '02:15');
  assert.equal(entry.docId, '5551234567');

  srvCalls.length = 0;
  await srvSandbox.syncSurveyTimerToFirestore(entry);
  assert.ok(srvCalls.some((c) => c.url.includes('/family_cards/SURVEY_TIMERS/logs/srv_test_1') && c.body.fields.duration_sec.integerValue === '135'));
  assert.ok(srvCalls.some((c) => c.url.includes('/family_cards/5551234567?') && c.body.fields.survey_duration_sec.integerValue === '135'));
  assert.ok(srvCalls.some((c) => c.url.includes('/family_cards/5551234567/logs/timer_srv_test_1')));
  assert.ok(srvCalls.some((c) => c.url.includes('/survey_timers/srv_test_1')));

  const listed = await srvSandbox.fetchSurveyTimersFromFirestore(20);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].durationSec, 120);

  // Worker POST + GET /api/survey-timer end-to-end
  const workerSrc = readRepoFile('cloudflare/worker.js').replace(/\bexport\s+default\s*\{/, 'globalThis.__worker = {');
  const wCalls = [];
  const wWaits = [];
  const wSandbox = createSandbox({
    Request,
    Response,
    Headers,
    fetch: async (url, init = {}) => {
      const u = String(url);
      wCalls.push({ url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      if (u.includes('/SURVEY_TIMERS/logs?pageSize=')) {
        return new Response(JSON.stringify({
          documents: [
            { fields: { session_id: { stringValue: 'w1' }, timer_status: { stringValue: 'ended' }, ended_at_ms: { integerValue: '2000' }, duration_sec: { integerValue: '60' }, duration_label: { stringValue: '০১:০০' } } },
            { fields: { session_id: { stringValue: 'w2' }, timer_status: { stringValue: 'ended' }, ended_at_ms: { integerValue: '3000' }, duration_sec: { integerValue: '180' }, duration_label: { stringValue: '০৩:০০' } } },
          ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ fields: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  vm.runInContext(workerSrc, wSandbox, { filename: 'cloudflare/worker.js' });
  const worker = wSandbox.__worker;
  const wCtx = { waitUntil: (p) => wWaits.push(p) };
  const wEnv = { ASSETS: { fetch: async () => new Response('ok', { status: 200 }) } };

  assert.equal(wSandbox.normalizeWorkerRoomMsg({ type: 'survey_timer_ended', text: 'done' }, 'FC-101').type, 'survey_timer_ended');

  const postRes = await worker.fetch(new Request('https://familycard-10n.pages.dev/api/survey-timer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'w_srv_1',
      familyId: '888111',
      docId: '888111',
      applicantName: 'মোছাঃ আসমা',
      startedAtMs: 10000,
      endedAtMs: 135000,
      source: 'mobile_web',
    }),
  }), wEnv, wCtx);
  const postJson = await postRes.json();
  assert.equal(postJson.success, true);
  assert.equal(postJson.entry.durationSec, 125);
  assert.ok(wWaits.length > 0);
  await Promise.all(wWaits);
  assert.ok(wCalls.some((c) => c.url.includes('/SURVEY_TIMERS/logs/w_srv_1')));
  assert.ok(wCalls.some((c) => c.url.includes('/family_cards/888111?')));

  const getRes = await worker.fetch(new Request('https://familycard-10n.pages.dev/api/survey-timer?limit=10'), wEnv, wCtx);
  const getJson = await getRes.json();
  assert.equal(getJson.success, true);
  assert.equal(getJson.stats.count, 2);
  assert.equal(getJson.stats.avgDurationSec, 120);
  assert.equal(getJson.stats.minDurationSec, 60);
  assert.equal(getJson.stats.maxDurationSec, 180);
});

test('app.js: Mobile survey timer starts, stops on survey end, stores to Firestore, and renders safe duration badge on house map cards', async () => {
  const src = readRepoFile('app.js');
  const code = extractDeclCode(src, [
    'normalizeDigits',
    'toBnDigits',
    'escapeHtml',
    'normalizeRoomCode',
    'getDeviceName',
    'FIRESTORE_SURVEY_TIMERS_LOG_BASE',
    'FIRESTORE_SURVEY_TIMERS_COLLECTION_BASE',
    'EDGE_SURVEY_TIMER_API',
    'SURVEY_TIMER_STORAGE_KEY',
    'SURVEY_TIMER_PENDING_KEY',
    'SURVEY_TIMER_HISTORY_KEY',
    'activeWebSurveyTimer',
    'webSurveyTickInterval',
    'formatWebSurveyClock',
    'formatWebSurveyDurationLabel',
    'loadActiveWebSurveyTimer',
    'saveActiveWebSurveyTimer',
    'getWebSurveyElapsedSec',
    'recordLocalSurveyTimerHistory',
    'renderWebSurveyTimerUI',
    'startWebSurveyTicker',
    'startNewWebSurveyTimer',
    'ensureWebSurveyTimerStarted',
    'syncWebSurveyTimerToDb',
    'endWebSurveyTimer',
    'TAG_CONFIG',
    'buildHousePopupHtml',
    'renderHouseListFeed',
  ], 'script');

  const storage = new Map();
  const calls = [];
  const makeMockEl = () => ({ innerHTML: '', textContent: '', className: '', children: [], classList: { remove() {}, add() {} }, appendChild(c) { this.children.push(c); return c; } });
  const clockEl = makeMockEl();
  const feedEl = makeMockEl();

  const ctx = createSandbox({
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    window: { location: { hostname: 'binary-ict.web.app' } },
    elRoomCode: { value: 'FC-101' },
    elDeviceName: { value: 'Phone-1' },
    houseListFeed: feedEl,
    document: {
      getElementById: (id) => (id === 'surveyTimerClock' ? clockEl : null),
      createElement: () => makeMockEl(),
    },
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  vm.runInContext(code, ctx, { filename: 'app.js' });

  // 1) Start first survey timer
  const t1 = ctx.startNewWebSurveyTimer({ startReason: 'quick_house_new', startedAtMs: 1000000 });
  assert.equal(t1.status, 'running');
  // Calling ensureWebSurveyTimerStarted while running does NOT reset startedAtMs
  const t1Again = ctx.ensureWebSurveyTimerStarted({ docId: '555999', applicantName: 'রহিমা' });
  assert.equal(t1Again.sessionId, t1.sessionId);
  assert.equal(t1Again.startedAtMs, 1000000);

  // 2) End survey and store in DB
  const ended1 = await ctx.endWebSurveyTimer('house_saved', { endedAtMs: 1125000, docId: '555999', applicantName: 'রহিমা' });
  assert.equal(ended1.status, 'ended');
  assert.equal(ended1.durationSec, 125);
  assert.equal(ended1.syncedToDb, true);
  assert.ok(calls.some((c) => c.url.includes('/SURVEY_TIMERS/logs/' + t1.sessionId)));
  assert.ok(calls.some((c) => c.url.includes('/family_cards/555999?')));

  // 3) Starting next new survey after previous ended creates a fresh sessionId
  const t2 = ctx.ensureWebSurveyTimerStarted({ startReason: 'ocr_scan', docNumber: '777888' });
  assert.equal(t2.status, 'running');
  assert.notEqual(t2.sessionId, t1.sessionId);

  // 4) XSS-safe duration label on popup & card
  const popup = ctx.buildHousePopupHtml({
    docId: '555999',
    ladyName: 'রহিমা',
    survey_status: 'COMPLETED',
    survey_duration_sec: 125,
    survey_duration_label: `২ মিঃ ৫ সেঃ<img src=x onerror=alert(1)>`,
    issues: [],
  });
  assert.ok(!popup.includes('<img src=x onerror='));
  assert.match(popup, /⏱️ সময়:/);

  ctx.renderHouseListFeed([{
    docId: '555999',
    ladyName: 'রহিমা',
    survey_status: 'COMPLETED',
    survey_duration_sec: 125,
    survey_duration_label: '২ মিঃ ৫ সেঃ',
    issues: [],
  }]);
  assert.match(feedEl.children[0].innerHTML, /⏱️ সময়: <b>২ মিঃ ৫ সেঃ<\/b>/);
});

test('extension/content.js & bookmarklet/bookmarklet.js: portal survey timer auto-starts, survives Step 0->1 ID creation, stops on submit, handles confirm/cancel, & resets for next survey', async () => {
  const configs = [
    ['extension/content.js', [
      'normalizeBn', 'toBnDigits', 'normalizeDigits', 'PORTAL_TIMER_STORAGE_KEY', 'PORTAL_TIMER_PENDING_KEY',
      'PORTAL_TIMER_HISTORY_KEY', 'FIRESTORE_SURVEY_TIMERS_LOG_BASE', 'FIRESTORE_SURVEY_TIMERS_COLLECTION_BASE',
      'EDGE_SURVEY_TIMER_API', 'activePortalTimer', 'portalTimerTickInterval', 'portalTimerHooksAttached',
      'pendingPortalSubmitAt', 'formatPortalTimerClock', 'formatPortalTimerDurationLabel', 'getPortalTimerElapsedSec',
      'getPortalSurveyTimerState', 'savePortalSurveyTimerState', 'pushPortalTimerLocalHistory',
      'updateExtTimerBadgeUI', 'startPortalTimerTicker', 'startPortalSurveyTimer', 'adoptOrStartPortalTimerForScan',
      'persistPortalSurveyTimerToDb', 'flushPendingPortalTimers', 'endPortalSurveyTimer', 'isPortalSurveyFormVisible',
      'isStep0BlankForNewSurvey', 'syncPortalSurveyLifecycle', 'attachPortalSubmitTimerHooks',
    ]],
    ['bookmarklet/bookmarklet.js', [
      'normalizeBn', 'toBnDigits', 'normalizeDigits', 'PORTAL_TIMER_STORAGE_KEY', 'PORTAL_TIMER_PENDING_KEY',
      'PORTAL_TIMER_HISTORY_KEY', 'FIRESTORE_SURVEY_TIMERS_LOG_BASE', 'FIRESTORE_SURVEY_TIMERS_COLLECTION_BASE',
      'EDGE_SURVEY_TIMER_API', 'activePortalTimer', 'portalTimerTickInterval', 'portalTimerHooksAttached',
      'pendingPortalSubmitAt', 'formatPortalTimerClock', 'formatPortalTimerDurationLabel', 'getPortalTimerElapsedSec',
      'getPortalSurveyTimerState', 'savePortalSurveyTimerState', 'pushPortalTimerLocalHistory',
      'updateBmTimerBadgeUI', 'startPortalTimerTicker', 'startPortalSurveyTimer', 'adoptOrStartPortalTimerForScan',
      'persistPortalSurveyTimerToDb', 'flushPendingPortalTimers', 'endPortalSurveyTimer', 'isPortalSurveyFormVisible',
      'isStep0BlankForNewSurvey', 'syncPortalSurveyLifecycle', 'attachPortalSubmitTimerHooks',
    ]],
  ];

  for (const [relPath, symNames] of configs) {
    const src = readRepoFile(relPath);
    const code = extractDeclCode(src, symNames, 'script');
    const storage = new Map();
    const clickListeners = [];
    const fetchCalls = [];
    const roomMsgs = [];

    let domFormOpen = true;
    let domFid = '';
    let domStep0Blank = false;
    let urlPath = '/applications/create';

    const ctx = createSandbox({
      localStorage: {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: (k) => storage.delete(k),
      },
      window: {
        get location() { return { pathname: urlPath, search: '' }; },
        addEventListener: () => {},
      },
      history: { pushState: () => {}, replaceState: () => {} },
      document: {
        getElementById: () => null,
        querySelector: (sel) => {
          if (sel.includes('[data-family-card-tab],') && domFormOpen) return {};
          if (sel === '[data-family-card-tab="0"]' && domStep0Blank) return { querySelectorAll: () => [{ value: '', type: 'text' }] };
          return null;
        },
        addEventListener: (ev, fn) => { if (ev === 'click') clickListeners.push(fn); },
      },
      setInterval: () => 1,
      clearInterval: () => {},
      scrapeFamilyId: () => domFid,
      isPanelActiveVisible: () => true,
      lastExtractedData: null,
      roomCode: 'FC-101',
      myDeviceName: 'Tablet-1',
      collectFullFamilyCardSummary: () => ({ familyId: domFid, readinessPct: 95, blockers: [], applicant: { nameBn: 'মোছাঃ সালমা', nid: '5551234567' } }),
      sendRoomMessage: async (m) => { roomMsgs.push(m); },
      showToast: () => {},
      timerDockBtn: null,
      fetch: async (url, init = {}) => {
        fetchCalls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    vm.runInContext(code, ctx, { filename: relPath });

    ctx.attachPortalSubmitTimerHooks();

    // 1) Portal form opens -> auto-starts timer
    ctx.syncPortalSurveyLifecycle();
    const s1 = ctx.getPortalSurveyTimerState();
    assert.ok(s1 && s1.status === 'running', `${relPath}: timer must start on portal form open`);

    // 2) Step 0 mobile scan adopted -> adopts earlier mobile timestamp WITHOUT creating new session
    const remoteStart = Date.now() - 45000;
    ctx.adoptOrStartPortalTimerForScan({ doc_number: '5551234567', name_bn: 'মোছাঃ সালমা' }, { remoteStartedAtMs: remoteStart, remoteSessionId: 'mob_1' });
    assert.equal(ctx.getPortalSurveyTimerState().startedAtMs, remoteStart, `${relPath}: adopts mobile scan start time`);

    // 3) Portal creates familyId after Step 0 -> keeps same timer & binds familyId!
    domFid = '987654';
    ctx.syncPortalSurveyLifecycle();
    assert.equal(ctx.getPortalSurveyTimerState().familyId, '987654', `${relPath}: binds Step 1 familyId`);
    assert.equal(ctx.getPortalSurveyTimerState().startedAtMs, remoteStart, `${relPath}: Step 0->1 ID bind does NOT reset startedAtMs`);

    // 4) Clicking enabled submit button -> ends timer, stores to DB & broadcasts survey_timer_ended
    const fakeSubmitBtn = {
      disabled: false,
      textContent: 'সাবমিট করুন',
      classList: { contains: () => false },
      closest: (s) => (s.includes('[id^="fc-"]') || s.includes('dialog') ? null : null),
      matches: (s) => s.includes('btn--submit'),
    };
    clickListeners[0]({ target: { closest: () => fakeSubmitBtn } });
    await new Promise((r) => setTimeout(r, 25));

    const ended = ctx.getPortalSurveyTimerState();
    assert.equal(ended.status, 'ended', `${relPath}: timer must stop on portal submit click`);
    assert.ok(ended.durationSec >= 44, `${relPath}: durationSec preserves total elapsed time`);
    assert.ok(fetchCalls.some((c) => c.url.includes('/SURVEY_TIMERS/logs/mob_1')), `${relPath}: persists timer log to Firestore`);
    assert.ok(fetchCalls.some((c) => c.url.includes('/family_cards/987654?')), `${relPath}: persists survey_duration_sec on family_card 987654`);
    assert.ok(fetchCalls.some((c) => c.url.includes('/family_cards/5551234567?')), `${relPath}: persists survey_duration_sec on NID card 5551234567`);
    assert.ok(roomMsgs.some((m) => m.type === 'survey_timer_ended'), `${relPath}: broadcasts survey_timer_ended`);

    // 5) Confirmation modal Cancel ("না") resumes active timer; Confirm ("হ্যাঁ") re-ends cleanly
    const cancelBtn = {
      disabled: false,
      textContent: 'না / বাতিল',
      classList: { contains: () => false },
      closest: (s) => (s.includes('.v-dialog') ? {} : null),
      matches: () => false,
    };
    clickListeners[0]({ target: { closest: () => cancelBtn } });
    assert.equal(ctx.getPortalSurveyTimerState().status, 'running', `${relPath}: dialog cancel resumes running timer`);

    clickListeners[0]({ target: { closest: () => fakeSubmitBtn } });
    await new Promise((r) => setTimeout(r, 15));
    const confirmBtn = {
      disabled: false,
      textContent: 'হ্যাঁ, নিশ্চিত',
      classList: { contains: () => false },
      closest: (s) => (s.includes('.v-dialog') ? {} : null),
      matches: () => false,
    };
    clickListeners[0]({ target: { closest: () => confirmBtn } });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(ctx.getPortalSurveyTimerState().status, 'ended', `${relPath}: dialog confirm ends timer again`);

    // 6) Staying on ended survey does NOT restart, but opening next survey familyId starts fresh timer
    ctx.getPortalSurveyTimerState().endedAtMs = Date.now() - 5000;
    ctx.syncPortalSurveyLifecycle();
    assert.equal(ctx.getPortalSurveyTimerState().status, 'ended', `${relPath}: stays ended until new survey starts`);

    domFid = '987999';
    ctx.syncPortalSurveyLifecycle();
    const s2 = ctx.getPortalSurveyTimerState();
    assert.equal(s2.status, 'running', `${relPath}: new familyId starts fresh survey timer`);
    assert.notEqual(s2.sessionId, 'mob_1', `${relPath}: new survey gets fresh sessionId`);
    assert.equal(s2.familyId, '987999');
  }
});

// ============================================================================
// 8. OCR DeepSeek Failover, Browser CORS, Undefined Elements & Step-8 Backup
// ============================================================================

test('bookmarklet: DeepSeek OCR failure does not throw prefModel ReferenceError and falls back to Gemini cleanly', async () => {
  const telemetry = [];
  const calls = [];
  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (u.includes('fc_error_logs') || u.includes('FC_SYSTEM_LOGS')) {
      telemetry.push(init.body ? JSON.parse(init.body) : null);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (u.includes('api.deepseek.com/chat/completions')) {
      const body = JSON.parse(init.body);
      // Fail on vision request; succeed on text bilingual completion
      const hasImg = Array.isArray(body.messages?.[1]?.content);
      if (hasImg) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: 'Failed to deserialize: unknown variant `image_url`' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ name_bn: 'মোছাঃ সালমা', name_en: 'MST. SALMA', doc_type: 'nid' }) } }],
          usage: { prompt_tokens: 15, completion_tokens: 20 },
        }),
      };
    }
    if (u.includes('generativelanguage.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ doc_type: 'nid', name_bn: 'মোছাঃ সালমা', nid_number: '5551234567', dob: '01/02/1990', confidence: 0.98 }) }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30 },
        }),
      };
    }
    return { ok: false, status: 405, headers: { get: () => 'text/html' }, json: async () => ({}) };
  };

  const bmSrc = readRepoFile('bookmarklet/bookmarklet.js');
  const code = extractDeclCode(bmSrc, [
    'safeJsonParse', 'normalizeDigits', 'hasBengaliScript', 'BN_NAME_WORD_MAP', 'EN_NAME_WORD_MAP',
    'transliterateBnWordToEn', 'normalizeEnglishHonorificPrefix', 'transliterateBnToEn',
    'transliterateEnWordToBn', 'transliterateEnToBn', 'stripPersonPrefixes',
    'isValidCalendarDate', 'standardizeDate', 'GENDER_ALIAS_MAP', 'normalizeGenderValue',
    'inferBangladeshiGender', 'cleanOcrFieldText', 'normalizeOcrKeyAliases',
    'needsIntelligentCompletion', 'needsEnglishCompletion', 'OCR_RESPONSE_SCHEMA',
    'buildGeminiPrompt', 'parseOcrJsonText', 'extractDigitCandidate', 'pickBestDocDigits',
    'getDobYear', 'isDocDigitsValidForType', 'validateAndNormalizeOcrData',
    'BDT_PER_USD', 'DEFAULT_GEMINI_MODEL', 'INTERACTIONS_API_MODELS', 'AI_MODEL_CATALOG',
    'isDeepSeekPeakUtc', 'normalizeModelId', 'computeScanUsageAndCost',
    'FIRESTORE_ERROR_LOGS_BASE', 'FIRESTORE_LOG_CHANNEL_BASE', 'FC_ERROR_LOGS_KEY',
    '__fcRecentLogDedup', '__fcLogFallbackChannelOnly', 'getLocalErrorLogs', 'fcLogTelemetry',
    'extractTextFromGeminiResponse', 'applyBilingualCompletionResult', 'buildBilingualCompletionPrompt',
    'completeBanglaOnlyOcrWithDeepSeek', 'completeBilingualWithGemini', 'callDeepSeekVisionOCR',
    'needsAccurateEscalation', 'mergeOcrResults', 'getOrderedGeminiModels',
    'buildGeminiAttemptsForModels', 'callGeminiResilientOCR', 'runMultiProviderOCR',
  ], 'script');

  const ctx = createSandbox({
    fetch: mockFetch,
    window: { location: { origin: 'https://fc.bhata.gov.bd' } },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  vm.runInContext(code, ctx, { filename: 'bookmarklet/bookmarklet.js' });

  // 1) Browser attempts must never send Api-Revision header on /interactions (avoids HTTP 403 CORS preflight)
  const gemAttempts = ctx.buildGeminiAttemptsForModels(['gemini-3.8-flash', 'gemini-3.5-flash-lite'], 'AIza-t', '/9j/4AAQ', 'image/jpeg', 'OCR');
  assert.ok(gemAttempts.every((a) => !a.url.includes('/interactions') && !a.headers['Api-Revision']), 'bookmarklet must avoid CORS-blocked /interactions Api-Revision header');

  // 2) callDeepSeekVisionOCR rejects with isVisionUnsupported (not ReferenceError: prefModel is not defined)
  await assert.rejects(
    () => ctx.callDeepSeekVisionOCR('sk-t', '/9j/4AAQ', 'image/jpeg', 'OCR', 'deepseek-flash'),
    (err) => err && err.isVisionUnsupported === true && !/prefModel/.test(err.message)
  );
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(telemetry.length > 0 && telemetry[0].fields?.model?.stringValue === 'deepseek-flash', 'Logs exact DeepSeek model without prefModel ReferenceError');

  // 3) runMultiProviderOCR in deepseek mode seamlessly falls back to Gemini Vision + DeepSeek JSON when Gemini key exists
  const multiRes = await ctx.runMultiProviderOCR({
    aiProvider: 'deepseek',
    geminiKey: 'AIza-t',
    deepseekKey: 'sk-t',
    rawBase64: '/9j/4AAQ',
    detectedMime: 'image/jpeg',
    promptText: 'OCR',
    docType: 'nid',
  });
  assert.equal(multiRes.nid_number, '5551234567');
  assert.equal(multiRes.name_en, 'MST. SALMA');
  assert.match(multiRes.ocr_model_used, /gemini.*DeepSeek/i);
});

test('app.js runDirectWebBrowserOcrFallback handles DeepSeek fallback & JSON extraction cleanly', async () => {
  const appSrc = readRepoFile('app.js');
  const code = extractDeclCode(appSrc, [
    'normalizeDigits', 'DEFAULT_GEMINI_MODEL', 'normalizeDirectWebPrefix',
    'standardizeWebDate', 'runDirectWebBrowserOcrFallback',
  ], 'script');

  const calls = [];
  const ctx = createSandbox({
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).includes('api.deepseek.com')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: 'Model Not Exist' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Here is JSON:\n```json\n{"doc_type":"nid","name_bn":"মোছাঃ রহিমা","name_en":"MOST. RAHIMA","nid_number":"1234567890","dob":"01/02/1990"}\n```' }] } }],
        }),
      };
    },
  });
  vm.runInContext(code, ctx, { filename: 'app.js' });

  const out = await ctx.runDirectWebBrowserOcrFallback({
    imageBase64: 'data:image/jpeg;base64,/9j/4AAQ',
    apiKey: 'AIza-web',
    deepseekApiKey: 'sk-web',
    aiProvider: 'deepseek',
  });
  assert.equal(out.success, true);
  assert.equal(out.data.name_en, 'MST. RAHIMA');
  assert.equal(out.data.nid_number, '1234567890');
  assert.match(out.data.ocr_model_used, /Gemini Fallback/i);
});

test('Zero missing self-defined fc-* DOM IDs and Step-8 object s8Members backup regression fixed in bookmarklet & extension', () => {
  for (const rel of ['bookmarklet/bookmarklet.js', 'extension/content.js']) {
    const src = readRepoFile(rel);
    const defined = new Set([
      ...[...src.matchAll(/\bid\s*=\s*["']([A-Za-z0-9_-]+)["']/g)].map((m) => m[1]),
      ...[...src.matchAll(/\.id\s*=\s*["']([A-Za-z0-9_-]+)["']/g)].map((m) => m[1]),
    ]);
    const usedFc = new Set([...src.matchAll(/getElementById\(\s*["'](fc-[^"']+)["']\s*\)/g)].map((m) => m[1]));
    const missing = [...usedFc].filter((id) => !defined.has(id));
    assert.deepEqual(missing, [], `${rel} must define every self fc-* element ID it queries`);

    // Verify extractFullStepsBackupData safely handles scanFamilyMembers returning an object
    assert.ok(!/step8_members:\s*\(s8Members\s*\|\|\s*\[\]\)\.map/.test(src), `${rel}: must guard Array.isArray(s8Members) instead of (s8Members || []).map`);
    const backupCode = extractDeclCode(src, ['extractFullStepsBackupData'], 'script');
    const stubCtx = createSandbox({
      document: { querySelector: () => null },
      scrapeFamilyId: () => '12345',
      lastExtractedData: null,
      lastCapturedHouseGps: null,
      readStep2FieldState: () => ({}),
      inspectSection3Media: () => ({}),
      inspectSection4Address: () => ({}),
      inspectSection5Details: () => ({ data: {} }),
      inspectSection6Bank: () => ({}),
      inspectSection7Eligibility: () => ({}),
      scanFamilyMembers: () => ({ totalMembers: 1, membersDetail: [{ index: 1, relationship: 'স্বামী', gender: 'পুরুষ' }] }),
      getSection9MoneyElements: () => null,
      inspectSection10EntryUser: () => ({}),
      inspectSection11Consent: () => ({}),
      collectFullFamilyCardSummary: () => ({
        readinessPct: 50,
        blockers: [],
        applicant: {},
        members: [{ index: 1, title: 'সদস্য - ১', nameBn: 'মোঃ করিম', docType: 'nid', docNum: '1234567890', rel: 'নিজ', age: 35, gender: 'পুরুষ' }],
      }),
    });
    vm.runInContext(backupCode, stubCtx);
    const snap = stubCtx.extractFullStepsBackupData();
    assert.equal(snap.step8_members.length, 1);
    assert.equal(snap.step8_members[0].relation, 'নিজ');
    assert.equal(snap.step8_members[0].docNum, '1234567890');
  }
});

test('cloudflare/worker.js keeps Pages ASSETS directory paths canonical without 308 loop', async () => {
  const workerSrc = readRepoFile('cloudflare/worker.js');
  const modBody = workerSrc.replace(/export\s+default\s+\{/, 'var __workerExport = {');
  const seenUrls = [];
  const ctx = createSandbox({
    fetch: async () => new Response('upstream', { status: 200 }),
    Request,
    Response,
    Headers,
  });
  vm.runInContext(modBody, ctx);

  const assetsEnv = {
    ASSETS: {
      fetch: async (req) => {
        const u = new URL(req.url);
        seenUrls.push(u.pathname);
        if (u.pathname === '/index.html' || u.pathname === '/bookmarklet/index.html') {
          return new Response(null, { status: 308, headers: { Location: u.pathname === '/index.html' ? '/' : '/bookmarklet/' } });
        }
        return new Response('<html>ok</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      },
    },
  };

  for (const [reqPath, expectedAssetPath] of [
    ['/', '/'],
    ['/bookmarklet', '/bookmarklet/'],
    ['/bookmarklet/', '/bookmarklet/'],
    ['/bookmarklet.min.js', '/bookmarklet/bookmarklet.min.js'],
  ]) {
    const res = await ctx.__workerExport.fetch(new Request(`https://familycard-10n.pages.dev${reqPath}`), assetsEnv, { waitUntil() {} });
    assert.equal(res.status, 200, `${reqPath} should return 200 instead of 308 redirect loop`);
    assert.match(res.headers.get('Cache-Control') || '', /no-store/i);
    assert.equal(seenUrls.at(-1), expectedAssetPath);
  }
});
