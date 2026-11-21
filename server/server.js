import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 25 * 1024 * 1024 // 25 MB for high-res images
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/bookmarklet', express.static(path.join(__dirname, '../public/bookmarklet')));
app.use('/bookmarklet', express.static(path.join(__dirname, '../bookmarklet')));

// Helper to get local Wi-Fi / LAN IP addresses
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// Helper to normalize Bengali numerals (০-৯) to English (0-9)
function normalizeDigits(str) {
  if (!str) return '';
  const bn = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  return String(str).replace(/[০-৯]/g, d => {
    const idx = bn.indexOf(d);
    return idx !== -1 ? idx : d;
  });
}

// Helper to standardize Date of Birth (supports English & Bengali months/digits) to DD/MM/YYYY
function standardizeDate(dobStr) {
  if (!dobStr) return '';
  let str = normalizeDigits(dobStr).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

  // ISO: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = str.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[3].padStart(2, '0')}/${isoMatch[2].padStart(2, '0')}/${isoMatch[1]}`;
  }

  // English month names: 15 Aug 1985 / 15-August-1985
  const enMonths = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  };
  const enMatch = str.match(/^(\d{1,2})[\s\-,.]+([a-zA-Z]{3,})[\s\-,.]+(\d{4})/i);
  if (enMatch) {
    const d = enMatch[1].padStart(2, '0');
    const m = enMonths[enMatch[2].toLowerCase().substring(0, 3)] || '';
    if (m) return `${d}/${m}/${enMatch[3]}`;
  }

  // Bengali month names: ১৪ মে ১৯৮৫ / ০৫ জানুয়ারি ২০১০ / ০২-মার্চ-১৯৯০
  const bnMonthPrefixes = [
    ['জানু', '01'], ['ফেব', '02'], ['মার', '03'], ['এপ্রি', '04'],
    ['মে', '05'], ['জুন', '06'], ['জুল', '07'], ['আগ', '08'],
    ['সেপ', '09'], ['অক', '10'], ['নভ', '11'], ['ডিস', '12']
  ];
  const bnMatch = str.match(/^(\d{1,2})[\s\-,/.]+([\u0980-\u09FF]+)[\s\-,/.]+(\d{4})/);
  if (bnMatch) {
    const d = bnMatch[1].padStart(2, '0');
    const tok = bnMatch[2];
    const hit = bnMonthPrefixes.find(([prefix]) => tok.startsWith(prefix));
    if (hit) return `${d}/${hit[1]}/${bnMatch[3]}`;
  }

  // Standard DD/MM/YYYY
  str = str.replace(/[-\.]/g, '/');
  const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmyMatch) {
    return `${dmyMatch[1].padStart(2, '0')}/${dmyMatch[2].padStart(2, '0')}/${dmyMatch[3]}`;
  }

  return str;
}

const OCR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    doc_type: { type: 'string', enum: ['nid', 'birth_certificate'] },
    doc_number: { type: 'string' },
    nid_number: { type: 'string' },
    birth_reg_no: { type: 'string' },
    name_bn: { type: 'string' },
    name_en: { type: 'string' },
    dob: { type: 'string' },
    gender: { type: 'string' },
    father_name_bn: { type: 'string' },
    father_name_en: { type: 'string' },
    mother_name_bn: { type: 'string' },
    mother_name_en: { type: 'string' },
    spouse_name_bn: { type: 'string' },
    spouse_name_en: { type: 'string' },
    relation_suggestion: { type: 'string' },
    marital_status_suggestion: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
  },
  required: ['doc_type', 'doc_number', 'name_bn', 'name_en', 'dob', 'gender']
};

function buildGeminiPrompt(docTypeHint = 'auto') {
  const hintLine = docTypeHint === 'nid'
    ? 'HINT: User indicated this document is a Bangladeshi NID Card.'
    : docTypeHint === 'birth_certificate'
      ? 'HINT: User indicated this document is a Bangladeshi Birth Registration Certificate (জন্ম নিবন্ধন সনদপত্র).'
      : 'Detect automatically whether this is a Bangladeshi NID Card or a Birth Registration Certificate.';

  return `
You are an expert OCR AI for Bangladeshi Identity Documents:
1. Bangladeshi National Identity (NID) Cards (both Smart NID and Old Laminated/Paper NID).
2. Bangladeshi Digital Birth Registration Certificates (ডিজিটাল জন্ম নিবন্ধন সনদপত্র / BRC).

${hintLine}

Examine the image carefully and extract accurate fields into JSON:

DOCUMENT CLASSIFICATION:
- "doc_type": Strictly "nid" or "birth_certificate".

EXTRACTION RULES:
1. "doc_number":
   - For NID: Extract the National ID number. Smart NID has 10 digits; classic NID has 13 or 17 digits.
     If classic 13-digit NID, extract the 13 digits or prepend 4-digit birth year from Date of Birth to make 17 digits. Copy digits to "nid_number".
   - For Birth Certificate: Extract the exact 17-digit Birth Registration Number (জন্ম নিবন্ধন নম্বর / PIN). Copy digits to "birth_reg_no".
   - Remove spaces, hyphens, and non-numeric symbols. Convert any Bengali digits (০-৯) to English (0-9).
2. "name_bn": Complete Bengali name as written on the document.
3. "name_en": Complete English name in ALL CAPITAL LETTERS (transliterate from Bengali if not printed on classic NID).
4. "dob": Date of Birth in DD/MM/YYYY format (English digits). Convert Bengali months/digits accurately.
5. "gender": Strictly "পুরুষ" (Male), "নারী" (Female), or "হিজড়া" (Transgender / Hijra).
6. "father_name_bn" & "father_name_en": Extract ONLY from "পিতা:" / "পিতার নাম:" / "Father's Name".
   CRITICAL FOR MARRIED WOMEN'S OLD LAMINATED NID: Many classic laminated NIDs for women print "স্বামী:" (Husband) instead of "পিতা:" (Father).
   NEVER put "স্বামী:" into "father_name_bn" or "father_name_en"! Leave father fields "" if "পিতা:" is absent, and put husband's name in "spouse_name_bn" / "spouse_name_en".
7. "mother_name_bn" & "mother_name_en": Mother's Bengali & ALL CAPITAL English names (transliterate if needed).
8. "spouse_name_bn" & "spouse_name_en": Extract from "স্বামী:" or "স্ত্রী:" if printed; otherwise "".
9. "relation_suggestion": One of ("স্বামী", "স্ত্রী", "পুত্র", "কন্যা", "পিতা", "মাতা", "ভাই", "বোন", "অন্যান্য"). If classic NID shows "স্বামী:", suggest "স্ত্রী".
10. "marital_status_suggestion": One of ("বিবাহিত", "অবিবাহিত", "বিধবা", "বিপত্নীক", "তালাকপ্রাপ্ত"). If classic NID shows "স্বামী:", suggest "বিবাহিত"; if minor, "অবিবাহিত".
11. "confidence": "low" if blurry/glare/cropped/unreadable digits, "medium" if slight uncertainty, "high" if clear.

Return ONLY a valid JSON object with those keys.`;
}

function extractTextFromGeminiResponse(res) {
  if (Array.isArray(res?.steps)) {
    for (let i = res.steps.length - 1; i >= 0; i--) {
      const step = res.steps[i];
      if (step?.type === 'model_output' && Array.isArray(step.content)) {
        const txt = step.content.map(c => (c && c.text) ? c.text : '').join('').trim();
        if (txt) return txt;
      }
    }
  }
  if (typeof res?.output_text === 'string' && res.output_text.trim()) {
    return res.output_text.trim();
  }
  const parts = res?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const txt = parts.map(p => p?.text || '').join('').trim();
    if (txt) return txt;
  }
  return '';
}

function parseOcrJsonText(textOutput) {
  const fenceMatch = String(textOutput || '').match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let cleaned = fenceMatch ? fenceMatch[1].trim() : String(textOutput || '').trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) cleaned = objMatch[0];
  return JSON.parse(cleaned);
}

function validateAndNormalizeOcrData(data, options = {}) {
  const { docType = 'auto', maritalStatus, religion = 'ইসলাম', mobileNumber = '', familyId = '' } = options;
  const warnings = [];

  if (docType && docType !== 'auto') {
    data.doc_type = docType;
  }

  if (data.dob) data.dob = standardizeDate(data.dob);

  const genderMap = {
    'তৃতীয় লিঙ্গ': 'হিজড়া', 'তৃতীয় লিঙ্গ': 'হিজড়া', 'হিজড়া': 'হিজড়া',
    'Male': 'পুরুষ', 'male': 'পুরুষ', 'Female': 'নারী', 'female': 'নারী'
  };
  if (data.gender) {
    const g = String(data.gender).trim();
    data.gender = genderMap[g] || g;
  }
  const relMap = { 'ছেলে': 'পুত্র', 'মেয়ে': 'কন্যা', 'মেয়ে': 'কন্যা', 'বাবা': 'পিতা', 'মা': 'মাতা' };
  if (data.relation_suggestion) {
    const r = String(data.relation_suggestion).trim();
    data.relation_suggestion = relMap[r] || r;
  }

  const spouseBn = String(data.spouse_name_bn || '').trim();
  const fatherBn = String(data.father_name_bn || '').trim();
  if (spouseBn && fatherBn && fatherBn === spouseBn) {
    data.father_name_bn = '';
    data.father_name_en = '';
  }
  if (spouseBn && !data.father_name_bn) {
    warnings.push("পুরাতন NID-তে 'স্বামী' নাম পাওয়া গেছে (পিতার নাম ছাপা নেই) — প্রয়োজনে পিতার নাম যাচাই/লিখুন।");
    if (!data.relation_suggestion) data.relation_suggestion = 'স্ত্রী';
  }

  const rawDocNum = data.doc_number || (data.doc_type === 'birth_certificate' ? data.birth_reg_no : data.nid_number) || data.nid_number || data.birth_reg_no || '';
  let rawDigits = normalizeDigits(rawDocNum).replace(/[^0-9]/g, '');

  if (data.doc_type === 'birth_certificate') {
    data.doc_number = rawDigits;
    data.birth_reg_no = rawDigits;
    if (rawDigits.length !== 17) {
      warnings.push(`জন্ম নিবন্ধন নম্বরটি ${rawDigits.length || 0} সংখ্যার (অবশ্যই ১৭ সংখ্যার হতে হবে) — নম্বরটি যাচাই করুন।`);
    }
  } else {
    if (rawDigits.length === 13) {
      const yearMatch = String(data.dob || '').match(/\b(19\d{2}|20\d{2})\b/);
      if (yearMatch) {
        rawDigits = yearMatch[1] + rawDigits;
        data.nid_converted_to_17 = true;
      } else {
        warnings.push('১৩ সংখ্যার NID-র জন্মসাল না পাওয়ায় ১৭ সংখ্যায় রূপান্তর করা যায়নি — জন্মতারিখ যাচাই করুন।');
      }
    }
    data.doc_type = data.doc_type || 'nid';
    data.doc_number = rawDigits;
    data.nid_number = rawDigits;
    if (rawDigits.length !== 10 && rawDigits.length !== 17) {
      warnings.push(`NID নম্বরটি ${rawDigits.length || 0} সংখ্যার (১০ বা ১৭ সংখ্যার হতে হবে) — নম্বরটি যাচাই করুন।`);
    }
  }

  if (!String(data.name_bn || '').trim()) warnings.push('বাংলা নাম পড়া যায়নি।');
  if (!String(data.name_en || '').trim()) warnings.push('ইংরেজি নাম পড়া যায়নি।');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(data.dob || ''))) {
    warnings.push('জন্ম তারিখ (DD/MM/YYYY) স্পষ্ট নয় — হাতে মিলিয়ে নিন।');
  }
  if (data.confidence === 'low') {
    warnings.push('ছবিটি কিছুটা ঝাপসা/অস্পষ্ট মনে হচ্ছে — সাবমিটের আগে সব তথ্য মিলিয়ে নিন।');
  }

  if (data.name_en) data.name_en = String(data.name_en).toUpperCase().trim();
  if (data.father_name_en) data.father_name_en = String(data.father_name_en).toUpperCase().trim();
  if (data.mother_name_en) data.mother_name_en = String(data.mother_name_en).toUpperCase().trim();
  if (data.spouse_name_en) data.spouse_name_en = String(data.spouse_name_en).toUpperCase().trim();

  const normMob = mobileNumber ? normalizeDigits(mobileNumber).replace(/[^0-9]/g, '').trim() : '';
  if (normMob && !/^01[3-9]\d{8}$/.test(normMob)) {
    warnings.push('মোবাইল নম্বরটি সঠিক ১১ সংখ্যার (01XXXXXXXXX) নয়।');
  }

  data.marital_status = maritalStatus || data.marital_status_suggestion || 'বিবাহিত';
  data.religion = religion || 'ইসলাম';
  data.mobile_number = normMob;
  data.family_id = normalizeDigits(familyId || data.family_id || '');
  data.ocr_warnings = warnings;
  return data;
}

// Direct Firebase Firestore sync (rajbari-city-app-16601)
async function syncToFirestore(data) {
  try {
    const rawId = normalizeDigits(data.family_id || data.nid_number || data.birth_reg_no || data.doc_number || '').replace(/[^0-9A-Za-z_-]/g, '');
    if (!rawId) {
      console.warn('[Firestore] Skipped sync: no family_id or document number');
      return;
    }

    const fields = {
      name_bn: { stringValue: data.name_bn || '' },
      name_en: { stringValue: data.name_en || '' },
      dob: { stringValue: data.dob || '' },
      gender: { stringValue: data.gender || '' },
      father_name_bn: { stringValue: data.father_name_bn || '' },
      father_name_en: { stringValue: data.father_name_en || '' },
      mother_name_bn: { stringValue: data.mother_name_bn || '' },
      mother_name_en: { stringValue: data.mother_name_en || '' },
      spouse_name_bn: { stringValue: data.spouse_name_bn || '' },
      spouse_name_en: { stringValue: data.spouse_name_en || '' },
      marital_status: { stringValue: data.marital_status || 'বিবাহিত' },
      religion: { stringValue: data.religion || 'ইসলাম' },
      mobile_number: { stringValue: data.mobile_number || '' },
      doc_type: { stringValue: data.doc_type || 'nid' },
      ocr_model_used: { stringValue: data.ocr_model_used || '' },
      synced_at: { timestampValue: new Date().toISOString() }
    };
    if (data.family_id) fields.family_id = { stringValue: normalizeDigits(data.family_id) };
    if (data.nid_number) fields.nid_number = { stringValue: data.nid_number };
    if (data.birth_reg_no) fields.birth_reg_no = { stringValue: data.birth_reg_no };

    const updateMask = Object.keys(fields)
      .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join('&');
    const url = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(rawId)}?${updateMask}`;

    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    console.log('[Firestore] Synced successfully:', rawId);
  } catch (err) {
    console.warn('[Firestore] Sync warning:', err.message);
  }
}

async function callDeepSeekVisionOCR(deepseekKey, cleanBase64, mimeType, promptText) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepseekKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [
          {
            role: 'system',
            content: 'You are an expert Bangladeshi NID and Birth Certificate OCR engine. Return ONLY a single valid JSON object matching the exact requested keys.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${cleanBase64}` } }
            ]
          }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 2048
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    const resData = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = resData?.error?.message || resData?.message || `HTTP ${response.status}`;
      if (response.status === 401) throw new Error('Invalid DeepSeek API Key.');
      if (response.status === 402) throw new Error('DeepSeek insufficient balance.');
      throw new Error(`DeepSeek API Error (${response.status}): ${msg}`);
    }

    const content = resData?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from DeepSeek OCR.');

    const parsed = parseOcrJsonText(content);
    parsed.ocr_model_used = 'deepseek-flash (api.deepseek.com)';
    return parsed;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('DeepSeek OCR timed out.');
    throw err;
  }
}

async function runGeminiCascade(apiKey, cleanBase64, mimeType, promptText) {
  const attempts = [
    {
      label: 'gemini-3.8-flash (interactions)',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'Api-Revision': '2026-05-20' },
      body: {
        model: 'gemini-3.8-flash',
        input: [{ type: 'text', text: promptText }, { type: 'image', data: cleanBase64, mime_type: mimeType }],
        generation_config: { thinking_level: 'low' },
        response_format: { type: 'text', mime_type: 'application/json', schema: OCR_RESPONSE_SCHEMA },
        store: false
      }
    },
    {
      label: 'gemini-3.8-flash (generateContent)',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: {
        contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mimeType, data: cleanBase64 } }] }],
        generationConfig: { response_mime_type: 'application/json' }
      }
    },
    {
      label: 'gemini-3.5-flash-lite (interactions)',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'Api-Revision': '2026-05-20' },
      body: {
        model: 'gemini-3.5-flash-lite',
        input: [{ type: 'text', text: promptText }, { type: 'image', data: cleanBase64, mime_type: mimeType }],
        response_format: { type: 'text', mime_type: 'application/json', schema: OCR_RESPONSE_SCHEMA },
        store: false
      }
    },
    {
      label: 'gemini-3.5-flash-lite (generateContent)',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: {
        contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mimeType, data: cleanBase64 } }] }],
        generationConfig: { response_mime_type: 'application/json' }
      }
    }
  ];

  let lastError = 'No text generated by Gemini OCR.';
  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 28000);
    try {
      const response = await fetch(attempt.url, {
        method: 'POST',
        headers: attempt.headers,
        body: JSON.stringify(attempt.body),
        signal: controller.signal
      });
      clearTimeout(timer);

      const resData = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = resData?.error?.message || resData?.message || `HTTP ${response.status}`;
        if (response.status === 400 && /API[_\s]?key/i.test(msg)) throw new Error('Invalid Gemini API Key.');
        lastError = `${attempt.label}: ${msg}`;
        continue;
      }

      const textOutput = extractTextFromGeminiResponse(resData);
      if (!textOutput) { lastError = `${attempt.label}: Empty model response`; continue; }

      const data = parseOcrJsonText(textOutput);
      data.ocr_model_used = attempt.label;
      return data;
    } catch (err) {
      clearTimeout(timer);
      if (/Invalid Gemini API Key/.test(err.message || '')) throw err;
      lastError = err.name === 'AbortError' ? `${attempt.label}: Request timed out` : `${attempt.label}: ${err.message}`;
    }
  }
  throw new Error(`Gemini OCR Error: ${lastError}`);
}

// Resilient Multi-Provider OCR caller: Gemini 3.8 Flash + DeepSeek Vision (deepseek-flash)
async function extractNidWithAI(base64Image, customApiKey, options = {}) {
  let gKey = String(customApiKey || process.env.GEMINI_API_KEY || '').trim();
  let dKey = String(options.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!dKey && /^sk-/i.test(gKey)) {
    dKey = gKey;
    gKey = '';
  }

  const mode = ['gemini', 'deepseek', 'auto'].includes(options.aiProvider) ? options.aiProvider : 'auto';
  if (mode === 'gemini' && !gKey) throw new Error('No Gemini API Key provided.');
  if (mode === 'deepseek' && !dKey) throw new Error('No DeepSeek API Key provided.');
  if (!gKey && !dKey) {
    throw new Error('No Gemini or DeepSeek API Key provided. Configure .env or provide an API key.');
  }

  let mimeType = options.mimeType || 'image/jpeg';
  let cleanBase64 = String(base64Image || '');
  const dataUriMatch = cleanBase64.match(/^data:([^;]+);base64,(.+)$/s);
  if (dataUriMatch) {
    mimeType = dataUriMatch[1] || mimeType;
    cleanBase64 = dataUriMatch[2];
  }

  const promptText = buildGeminiPrompt(options.docType || 'auto');
  let rawParsed = null;

  if (mode === 'deepseek') {
    rawParsed = await callDeepSeekVisionOCR(dKey, cleanBase64, mimeType, promptText);
  } else if (mode === 'gemini') {
    rawParsed = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText);
  } else {
    const errors = [];
    if (gKey) {
      try {
        rawParsed = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText);
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (!rawParsed && dKey) {
      try {
        rawParsed = await callDeepSeekVisionOCR(dKey, cleanBase64, mimeType, promptText);
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (!rawParsed) throw new Error(errors.join(' | '));
  }

  return validateAndNormalizeOcrData(rawParsed, options);
}

// REST API for direct OCR (supports both /api/ocr-nid and /api/extract-nid)
async function handleExtractNidRoute(req, res) {
  try {
    const image = req.body.image || req.body.imageBase64;
    const { apiKey, deepseekApiKey, aiProvider, room, mimeType, docType } = req.body;
    if (!image) {
      return res.status(400).json({ success: false, error: 'No image provided.' });
    }

    const extracted = await extractNidWithAI(image, apiKey, {
      mimeType,
      docType,
      aiProvider,
      deepseekApiKey,
      maritalStatus: req.body.maritalStatus,
      religion: req.body.religion,
      mobileNumber: req.body.mobileNumber,
      familyId: req.body.familyId
    });

    // Async sync to Firestore
    syncToFirestore(extracted);

    // If a room is specified, broadcast to that room
    if (room) {
      io.to(String(room).toUpperCase().trim()).emit('nid-data-extracted', {
        success: true,
        data: extracted,
        timestamp: new Date().toISOString()
      });
    }

    res.json({ success: true, data: extracted });
  } catch (error) {
    console.error('OCR Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

app.post('/api/ocr-nid', handleExtractNidRoute);
app.post('/api/extract-nid', handleExtractNidRoute);

// Get local server status and network info
app.get('/api/info', (req, res) => {
  res.json({
    status: 'online',
    port: PORT,
    localIps: getLocalIpAddresses(),
    hasEnvApiKey: Boolean(process.env.GEMINI_API_KEY),
    hasDeepSeekKey: Boolean(process.env.DEEPSEEK_API_KEY)
  });
});

// Socket.io Real-time connection for cross-device sync
io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // Device joining a specific sync room
  socket.on('join-room', (roomCode) => {
    const cleanRoom = (roomCode || 'DEFAULT').toUpperCase().trim();
    socket.join(cleanRoom);
    console.log(`[Socket ${socket.id}] joined room: ${cleanRoom}`);
    socket.emit('room-joined', { room: cleanRoom });
    // Notify others in room
    socket.to(cleanRoom).emit('peer-connected', { id: socket.id });
  });

  // Mobile device sending image for processing and forwarding
  socket.on('scan-nid', async (payload) => {
    const { image, room, apiKey, deepseekApiKey, aiProvider } = payload;
    const targetRoom = (room || 'DEFAULT').toUpperCase().trim();

    console.log(`[OCR Request] Received image for room: ${targetRoom}`);
    socket.emit('ocr-status', { status: 'processing', message: 'AI ডকুমেন্ট বিশ্লেষণ করছে...' });

    try {
      const extracted = await extractNidWithAI(image, apiKey, {
        docType: payload.docType,
        aiProvider,
        deepseekApiKey,
        maritalStatus: payload.maritalStatus,
        religion: payload.religion,
        mobileNumber: payload.mobileNumber,
        familyId: payload.familyId
      });
      console.log(`[OCR Success] Extracted:`, extracted.name_bn || extracted.name_en, extracted.nid_number || extracted.birth_reg_no);

      // Async sync to Firestore
      syncToFirestore(extracted);

      // Broadcast extracted data to all devices in the room (including extension on PC)
      io.to(targetRoom).emit('nid-data-extracted', {
        success: true,
        data: extracted,
        timestamp: new Date().toISOString()
      });

      socket.emit('ocr-status', { status: 'completed', data: extracted });
    } catch (err) {
      console.error('[OCR Failure]:', err.message);
      socket.emit('ocr-status', { status: 'error', error: err.message });
      io.to(targetRoom).emit('nid-data-extracted', {
        success: false,
        error: err.message
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected] ID: ${socket.id}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIpAddresses();
  console.log('====================================================');
  console.log('🚀 FamilyCard NID OCR & Auto-Fill Bridge is Running!');
  console.log(`📡 Local PC:     http://localhost:${PORT}`);
  ips.forEach((ip) => {
    console.log(`📱 Mobile Device: http://${ip}:${PORT}`);
  });
  console.log('====================================================');
});
