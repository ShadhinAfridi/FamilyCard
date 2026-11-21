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
const BDT_PER_USD = 122;

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const INTERACTIONS_API_MODELS = new Set(['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon']);

const AI_MODEL_CATALOG = {
  'gemini-3.1-flash-lite': {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite',
    provider: 'gemini',
    inputPer1M: 0.25,
    outputPer1M: 1.50,
    cacheReadPer1M: 0.025,
    rpm: '4K',
    tpm: '4M',
    rpd: '150K',
    estPer1kUsd: 0.78
  },
  'gemini-3.5-flash-lite': {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite',
    provider: 'gemini',
    inputPer1M: 0.30,
    outputPer1M: 2.50,
    cacheReadPer1M: 0.03,
    rpm: '4K',
    tpm: '4M',
    rpd: '150K',
    estPer1kUsd: 1.11
  },
  'gemini-3.8-flash': {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    provider: 'gemini',
    inputPer1M: 0.75,
    outputPer1M: 3.75,
    cacheReadPer1M: 0.075,
    stdInputPer1M: 1.50,
    stdOutputPer1M: 7.50,
    stdCacheReadPer1M: 0.15,
    introUntilUtcMs: Date.UTC(2027, 0, 1),
    rpm: '1K',
    tpm: '2M',
    rpd: '10K',
    estPer1kUsd: 2.53
  },
  'gemini-4-argon': {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    provider: 'gemini',
    inputPer1M: 2.00,
    outputPer1M: 10.00,
    cacheReadPer1M: 0.10,
    stdInputPer1M: 4.00,
    stdOutputPer1M: 20.00,
    stdCacheReadPer1M: 0.20,
    introUntilUtcMs: Date.UTC(2026, 11, 1),
    rpm: '500',
    tpm: '2M',
    rpd: '5K',
    estPer1kUsd: 6.50
  },
  'deepseek-flash': {
    id: 'deepseek-flash',
    label: 'DeepSeek Flash',
    provider: 'deepseek',
    offPeakInPer1M: 0.15,
    offPeakOutPer1M: 0.60,
    offPeakCachePer1M: 0.003,
    peakInPer1M: 0.30,
    peakOutPer1M: 1.20,
    peakCachePer1M: 0.006,
    rpm: 'Pay-as-you-go',
    tpm: 'Uncapped Tier',
    rpd: 'Balance-based',
    estPer1kUsd: 0.38
  }
};

function isDeepSeekPeakUtc(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const day = d.getUTCDay();
  if (day < 1 || day > 5) return false;
  const hour = d.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

function normalizeModelId(modelId) {
  const raw = String(modelId || '').toLowerCase();
  if (raw.includes('deepseek')) return 'deepseek-flash';
  if (raw.includes('4-argon') || raw.includes('argon')) return 'gemini-4-argon';
  if (raw.includes('3.8-flash') || raw.includes('3.8')) return 'gemini-3.8-flash';
  if (raw.includes('3.1-flash-lite') || raw.includes('3.1')) return 'gemini-3.1-flash-lite';
  return 'gemini-3.5-flash-lite';
}

function computeScanUsageAndCost(modelId, rawApiRes = {}, nowMs = Date.now()) {
  const key = normalizeModelId(modelId);
  const spec = AI_MODEL_CATALOG[key] || AI_MODEL_CATALOG[DEFAULT_GEMINI_MODEL];
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let estimated = false;

  if (spec.provider === 'deepseek') {
    const u = rawApiRes && rawApiRes.usage;
    if (u && (u.prompt_tokens != null || u.completion_tokens != null)) {
      cachedTokens = Number(u.prompt_cache_hit_tokens || 0);
      inputTokens = Number(u.prompt_tokens || ((u.prompt_cache_miss_tokens || 0) + cachedTokens));
      outputTokens = Number(u.completion_tokens || 0);
    } else {
      estimated = true;
      inputTokens = 1524;
      outputTokens = 250;
    }
    const peak = isDeepSeekPeakUtc(nowMs);
    const inRate = peak ? spec.peakInPer1M : spec.offPeakInPer1M;
    const cacheRate = peak ? spec.peakCachePer1M : spec.offPeakCachePer1M;
    const outRate = peak ? spec.peakOutPer1M : spec.offPeakOutPer1M;
    const uncachedIn = Math.max(0, inputTokens - cachedTokens);
    const costUsd = (uncachedIn * inRate + cachedTokens * cacheRate + outputTokens * outRate) / 1e6;
    return {
      model: key,
      label: spec.label,
      provider: 'deepseek',
      tierWindow: peak ? 'peak' : 'off_peak',
      inputTokens,
      cachedTokens,
      uncachedInputTokens: uncachedIn,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimated,
      inputRatePer1M: inRate,
      outputRatePer1M: outRate,
      cacheRatePer1M: cacheRate,
      estPer1kUsd: peak ? 0.76 : spec.estPer1kUsd,
      costUsd: Number(costUsd.toFixed(7)),
      costBdt: Number((costUsd * BDT_PER_USD).toFixed(4))
    };
  }

  const um = rawApiRes && rawApiRes.usageMetadata;
  const iu = rawApiRes && rawApiRes.usage;
  if (um && (um.promptTokenCount != null || um.candidatesTokenCount != null)) {
    inputTokens = Number(um.promptTokenCount || 0);
    cachedTokens = Number(um.cachedContentTokenCount || 0);
    outputTokens = Number(um.candidatesTokenCount || 0) + Number(um.thoughtsTokenCount || 0);
  } else if (iu && (iu.total_input_tokens != null || iu.total_output_tokens != null)) {
    inputTokens = Number(iu.total_input_tokens || 0);
    cachedTokens = Number(iu.total_cached_tokens || 0);
    outputTokens = Number(iu.total_output_tokens || 0);
  } else {
    estimated = true;
    inputTokens = 1620;
    outputTokens = 250;
  }

  const hasStdRates = Boolean(spec.introUntilUtcMs && spec.stdInputPer1M);
  const isIntro = hasStdRates && nowMs < spec.introUntilUtcMs;
  const inRate = hasStdRates ? (isIntro ? spec.inputPer1M : spec.stdInputPer1M) : spec.inputPer1M;
  const outRate = hasStdRates ? (isIntro ? spec.outputPer1M : spec.stdOutputPer1M) : spec.outputPer1M;
  const cacheRate = hasStdRates ? (isIntro ? spec.cacheReadPer1M : spec.stdCacheReadPer1M) : spec.cacheReadPer1M;
  const uncachedIn = Math.max(0, inputTokens - cachedTokens);
  const costUsd = (uncachedIn * inRate + cachedTokens * cacheRate + outputTokens * outRate) / 1e6;

  return {
    model: key,
    label: spec.label,
    provider: 'gemini',
    tierWindow: hasStdRates ? (isIntro ? 'intro_2026' : 'standard') : 'tier1',
    inputTokens,
    cachedTokens,
    uncachedInputTokens: uncachedIn,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated,
    inputRatePer1M: inRate,
    outputRatePer1M: outRate,
    cacheRatePer1M: cacheRate,
    estPer1kUsd: spec.estPer1kUsd,
    costUsd: Number(costUsd.toFixed(7)),
    costBdt: Number((costUsd * BDT_PER_USD).toFixed(4))
  };
}

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
  required: ['doc_type', 'doc_number', 'nid_number', 'birth_reg_no', 'name_bn', 'name_en', 'dob', 'gender']
};

function buildGeminiPrompt(docTypeHint = 'auto') {
  const hintLine = docTypeHint === 'nid'
    ? 'HINT: User selected Bangladeshi NID Card (ID Card Size). Focus carefully on extracting ALL fields including the 10, 13, or 17-digit NID number.'
    : docTypeHint === 'birth_certificate'
      ? 'HINT: User selected Bangladeshi Digital Birth Registration Certificate (A4 Paper / জন্ম নিবন্ধন সনদপত্র). Focus carefully on the 17-digit Birth Registration Number, Date of Birth (NOT Registration Date), and parent names.'
      : 'Detect automatically whether this is a Bangladeshi NID Card or a Birth Registration Certificate.';

  return `
You are an expert OCR and document understanding system specializing in Bangladeshi identity documents:
1. Bangladeshi National Identity (NID) Cards (Smart Cards and classic laminated paper NID cards).
2. Bangladeshi Digital Birth Registration Certificates (ডিজিটাল জন্ম নিবন্ধন সনদপত্র / BRC, A4 printed).

${hintLine}

Analyze the provided image carefully and extract ALL visible fields into a single valid JSON object.

DOCUMENT CLASSIFICATION:
- "doc_type": Strictly "nid" or "birth_certificate".
  - If NID Card (Smart Card or classic laminated paper NID), set "doc_type": "nid".
  - If Birth Registration Certificate (জন্ম নিবন্ধন সনদপত্র / Office of the Registrar General, Birth & Death), set "doc_type": "birth_certificate".

EXTRACTION RULES (VERIFY EVERY DIGIT):
1. "doc_number" & "nid_number" & "birth_reg_no":
   - For NID ("doc_type": "nid"):
     - Smart NID prints 10 digits under "NID No." / "জাতীয় পরিচয় নং" (e.g. "123 456 7890" -> "1234567890").
     - Classic Laminated NID prints 13 or 17 digits at the bottom under "ID NO:" (very small font — read every digit carefully!). If 13 digits, extract those 13 digits or prepend the 4-digit birth year from Date of Birth to make 17 digits.
     - Copy the exact digits into BOTH "doc_number" and "nid_number", and set "birth_reg_no": "".
   - For Birth Certificate ("doc_type": "birth_certificate"):
     - Extract the exact 17-digit Birth Registration Number (জন্ম নিবন্ধন নম্বর / Birth Registration Number / Personal Identification Number), usually near the top-left/center and starting with birth year (e.g. 1998..., 2012...).
     - CRITICAL: NEVER confuse Father's NID, Mother's NID, or Certificate/Book Serial Number with the 17-digit Birth Registration Number!
     - Copy the exact 17 digits into BOTH "doc_number" and "birth_reg_no", and set "nid_number": "".
   - Strip all spaces, hyphens, and punctuation. Convert ALL Bengali digits (০-৯) to English digits (0-9). NEVER leave "doc_number" empty when digits are visible.
2. "name_bn": Full Bengali name exactly as printed (under "নাম:" or "নিবন্ধিত ব্যক্তির নাম").
3. "name_en": Full English name in ALL UPPERCASE letters (transliterate from Bengali if not printed on classic NID).
4. "dob": Date of Birth in strict DD/MM/YYYY English digit format (e.g. "14/05/1988"). On Birth Certificates, use "জন্ম তারিখ / Date of Birth", NOT "নিবন্ধনের তারিখ / Date of Registration" or "সনদ প্রদানের তারিখ / Date of Issuance".
5. "gender": Strictly "পুরুষ" (Male), "নারী" (Female), or "হিজড়া" (Third Gender / Hijra). Infer accurately if not explicitly written on classic NID.
6. "father_name_bn" & "father_name_en": Extract ONLY from "পিতা:" / "পিতার নাম:" / "Father's Name".
   CRITICAL FOR MARRIED WOMEN'S OLD LAMINATED NID: Many classic laminated NIDs for women print "স্বামী:" (Husband) instead of "পিতা:" (Father).
   NEVER put "স্বামী:" (Husband) into "father_name_bn" or "father_name_en"! Leave father fields "" if "পিতা:" is absent, and put husband's name in "spouse_name_bn" / "spouse_name_en".
7. "mother_name_bn" & "mother_name_en": Extract from "মাতা:" / "মাতার নাম:" / "Mother's Name". Transliterate to ALL UPPERCASE English if needed.
8. "spouse_name_bn" & "spouse_name_en": Extract from "স্বামী:" or "স্ত্রী:" if printed; otherwise "". Transliterate to ALL UPPERCASE English if present.
9. "relation_suggestion": If scanning a family member, suggest relation to household head strictly from ("স্বামী", "স্ত্রী", "পুত্র", "কন্যা", "পিতা", "মাতা", "ভাই", "বোন", "অন্যান্য"). If classic NID shows "স্বামী:", suggest "স্ত্রী".
10. "marital_status_suggestion": Strictly from ("বিবাহিত", "অবিবাহিত", "বিধবা", "বিপত্নীক", "তালাকপ্রাপ্ত"). If classic NID shows "স্বামী:", suggest "বিবাহিত"; if child/under 18, suggest "অবিবাহিত".
11. "confidence": Set "low" if glare, blur, partial cropping, or unreadable digits exist; "medium" if minor uncertainty; "high" if crystal clear.

Return ONLY a single valid JSON object with these keys:
{
  "doc_type": "nid",
  "doc_number": "...",
  "nid_number": "...",
  "birth_reg_no": "...",
  "name_bn": "...",
  "name_en": "...",
  "dob": "DD/MM/YYYY",
  "gender": "...",
  "father_name_bn": "...",
  "father_name_en": "...",
  "mother_name_bn": "...",
  "mother_name_en": "...",
  "spouse_name_bn": "...",
  "spouse_name_en": "...",
  "relation_suggestion": "...",
  "marital_status_suggestion": "...",
  "confidence": "high"
}
`;
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

const GENDER_ALIAS_MAP = {
  'তৃতীয় লিঙ্গ': 'হিজড়া',
  'তৃতীয় লিঙ্গ': 'হিজড়া',
  'হিজড়া': 'হিজড়া',
  'Male': 'পুরুষ',
  'male': 'পুরুষ',
  'Female': 'নারী',
  'female': 'নারী'
};

function normalizeGenderValue(gender) {
  const g = String(gender || '').trim();
  return GENDER_ALIAS_MAP[g] || g;
}

function extractDigitCandidate(raw) {
  return normalizeDigits(raw || '').replace(/[^0-9]/g, '');
}

function pickBestDocDigits(candidates, preferredLengths) {
  const cleaned = candidates.map(extractDigitCandidate).filter(Boolean);
  for (const len of preferredLengths) {
    const match = cleaned.find((c) => c.length === len);
    if (match) return match;
  }
  return cleaned[0] || '';
}

function isDocDigitsValidForType(docType, parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (docType === 'birth_certificate') {
    return pickBestDocDigits([parsed.birth_reg_no, parsed.doc_number, parsed.nid_number], [17]).length === 17;
  }
  const d = pickBestDocDigits([parsed.nid_number, parsed.doc_number, parsed.birth_reg_no], [10, 17, 13]);
  return d.length === 10 || d.length === 13 || d.length === 17;
}

function validateAndNormalizeOcrData(data, options = {}) {
  const { docType = 'auto', maritalStatus, religion = 'ইসলাম', mobileNumber = '', familyId = '' } = options;
  const warnings = [];

  if (docType && docType !== 'auto') {
    data.doc_type = docType;
  } else if (
    data.doc_type !== 'birth_certificate' &&
    !extractDigitCandidate(data.nid_number) &&
    extractDigitCandidate(data.birth_reg_no).length === 17
  ) {
    data.doc_type = 'birth_certificate';
  }

  if (data.dob) data.dob = standardizeDate(data.dob);

  if (data.gender) {
    data.gender = normalizeGenderValue(data.gender);
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

  if (data.doc_type === 'birth_certificate') {
    const rawDigits = pickBestDocDigits([data.birth_reg_no, data.doc_number, data.nid_number], [17]);
    data.doc_number = rawDigits;
    data.birth_reg_no = rawDigits;
    data.nid_number = '';
    if (rawDigits.length !== 17) {
      warnings.push(`জন্ম নিবন্ধন নম্বরটি ${rawDigits.length || 0} সংখ্যার (অবশ্যই ১৭ সংখ্যার হতে হবে) — নম্বরটি যাচাই করুন।`);
    }
  } else {
    let rawDigits = pickBestDocDigits([data.nid_number, data.doc_number, data.birth_reg_no], [10, 17, 13]);
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
    data.birth_reg_no = '';
    if (rawDigits.length !== 10 && rawDigits.length !== 17) {
      warnings.push(`NID নম্বরটি ${rawDigits.length || 0} সংখ্যার (১০ বা ১৭ সংখ্যার হতে হবে) — নম্বরটি যাচাই করুন।`);
    }
  }

  if (!String(data.name_bn || '').trim()) warnings.push('বাংলা নাম পড়া যায়নি।');
  if (!String(data.name_en || '').trim()) warnings.push('ইংরেজি নাম পড়া যায়নি।');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(data.dob || ''))) {
    warnings.push('জন্ম তারিখ (DD/MM/YYYY) স্পষ্ট নয় — হাতে মিলিয়ে নিন।');
  }
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(data.gender || '').trim())) {
    warnings.push('লিঙ্গ স্পষ্ট নয় — নির্বাচন যাচাই করুন।');
  }
  if (!String(data.mother_name_bn || '').trim() && !String(data.mother_name_en || '').trim()) {
    warnings.push('মাতার নাম পড়া যায়নি — প্রয়োজনে হাতে লিখুন।');
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

async function callDeepSeekVisionOCR(deepseekKey, cleanBase64, mimeType, promptText, deepseekModel = 'deepseek-flash') {
  const targetModel = normalizeModelId(deepseekModel) === 'deepseek-flash' ? 'deepseek-flash' : 'deepseek-flash';
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
        model: targetModel,
        messages: [
          {
            role: 'system',
            content: 'You are an expert Bangladeshi NID and Birth Certificate OCR engine. Return ONLY a single valid JSON object matching the exact requested keys.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${cleanBase64}`, detail: 'high' } }
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
      if (response.status === 401) {
        const err = new Error('Invalid DeepSeek API Key.');
        err.statusCode = 400;
        throw err;
      }
      if (response.status === 402) throw new Error('DeepSeek insufficient balance.');
      throw new Error(`DeepSeek API Error (${response.status}): ${msg}`);
    }

    const content = resData?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from DeepSeek OCR.');

    const parsed = parseOcrJsonText(content);
    parsed.ocr_model_used = `${targetModel} (api.deepseek.com)`;
    parsed.ocr_usage = computeScanUsageAndCost(targetModel, resData);
    return parsed;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('DeepSeek OCR timed out.');
    throw err;
  }
}

function needsAccurateEscalation(parsed, docTypeHint = 'auto') {
  if (!parsed || typeof parsed !== 'object') return true;
  if (parsed.confidence === 'low') return true;
  if (!String(parsed.name_bn || '').trim() || !String(parsed.name_en || '').trim()) return true;
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(standardizeDate(parsed.dob || ''))) return true;
  const effectiveType = (docTypeHint && docTypeHint !== 'auto') ? docTypeHint : (parsed.doc_type || 'nid');
  if (!isDocDigitsValidForType(effectiveType, parsed)) return true;
  const normGender = normalizeGenderValue(parsed.gender);
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(normGender)) return true;
  if (!String(parsed.mother_name_bn || '').trim() && !String(parsed.mother_name_en || '').trim()) return true;
  const hasFatherOrSpouse =
    String(parsed.father_name_bn || '').trim() ||
    String(parsed.father_name_en || '').trim() ||
    String(parsed.spouse_name_bn || '').trim() ||
    String(parsed.spouse_name_en || '').trim();
  if (!hasFatherOrSpouse) return true;
  return false;
}

function mergeOcrResults(primary, escalated, docTypeHint = 'auto') {
  if (!primary) return escalated;
  if (!escalated) return primary;

  const effectiveType = (docTypeHint && docTypeHint !== 'auto')
    ? docTypeHint
    : (escalated.doc_type && escalated.doc_type !== 'auto' ? escalated.doc_type : (primary.doc_type || 'nid'));

  const merged = { ...primary, ...escalated };
  merged.doc_type = effectiveType;

  const stringFields = [
    'name_bn', 'name_en',
    'father_name_bn', 'father_name_en',
    'mother_name_bn', 'mother_name_en',
    'spouse_name_bn', 'spouse_name_en',
    'relation_suggestion', 'marital_status_suggestion'
  ];
  for (const field of stringFields) {
    const escVal = String(escalated[field] || '').trim();
    const priVal = String(primary[field] || '').trim();
    merged[field] = escVal || priVal;
  }

  const escDob = standardizeDate(escalated.dob || '');
  const priDob = standardizeDate(primary.dob || '');
  merged.dob = /^\d{2}\/\d{2}\/\d{4}$/.test(escDob)
    ? escDob
    : (/^\d{2}\/\d{2}\/\d{4}$/.test(priDob) ? priDob : (escDob || priDob));

  const escGender = normalizeGenderValue(escalated.gender);
  const priGender = normalizeGenderValue(primary.gender);
  merged.gender = ['পুরুষ', 'নারী', 'হিজড়া'].includes(escGender)
    ? escGender
    : (['পুরুষ', 'নারী', 'হিজড়া'].includes(priGender) ? priGender : (escGender || priGender));

  const escValidNum = isDocDigitsValidForType(effectiveType, escalated);
  const priValidNum = isDocDigitsValidForType(effectiveType, primary);
  if (!escValidNum && priValidNum) {
    merged.doc_number = primary.doc_number || '';
    merged.nid_number = primary.nid_number || '';
    merged.birth_reg_no = primary.birth_reg_no || '';
  } else {
    merged.doc_number = escalated.doc_number || primary.doc_number || '';
    merged.nid_number = escalated.nid_number || primary.nid_number || '';
    merged.birth_reg_no = escalated.birth_reg_no || primary.birth_reg_no || '';
  }

  if (primary.ocr_model_used && escalated.ocr_model_used && escalated.ocr_model_used !== primary.ocr_model_used) {
    merged.ocr_model_used = `${escalated.ocr_model_used} + ${primary.ocr_model_used}`;
  }
  if (primary.ocr_usage && escalated.ocr_usage) {
    merged.ocr_usage = {
      ...escalated.ocr_usage,
      inputTokens: (primary.ocr_usage.inputTokens || 0) + (escalated.ocr_usage.inputTokens || 0),
      outputTokens: (primary.ocr_usage.outputTokens || 0) + (escalated.ocr_usage.outputTokens || 0),
      totalTokens: (primary.ocr_usage.totalTokens || 0) + (escalated.ocr_usage.totalTokens || 0),
      costUsd: Number(((primary.ocr_usage.costUsd || 0) + (escalated.ocr_usage.costUsd || 0)).toFixed(6)),
      costBdt: Number(((primary.ocr_usage.costBdt || 0) + (escalated.ocr_usage.costBdt || 0)).toFixed(4))
    };
  }
  return merged;
}

function getOrderedGeminiModels(profile = 'accurate', preferredGeminiModel = DEFAULT_GEMINI_MODEL) {
  const pref = normalizeModelId(preferredGeminiModel);
  const validPref = pref.startsWith('gemini-') ? pref : DEFAULT_GEMINI_MODEL;
  let base;
  if (profile === 'flash38_only') {
    base = ['gemini-3.8-flash'];
  } else if (profile === 'lite_only') {
    base = validPref === 'gemini-3.1-flash-lite'
      ? ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']
      : ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  } else if (profile === 'preferred') {
    base = [validPref, 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'];
  } else {
    base = validPref === 'gemini-4-argon'
      ? ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']
      : ['gemini-3.8-flash', validPref, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  }
  return Array.from(new Set(base));
}

function buildGeminiAttemptsForModels(models, apiKey, cleanBase64, mimeType, promptText, opts = {}) {
  const { docType = 'auto', isEscalation = false } = opts;
  const attempts = [];
  for (const model of models) {
    if (INTERACTIONS_API_MODELS.has(model)) {
      const useUltraHigh = (model === 'gemini-3.8-flash' || model === 'gemini-4-argon') && (docType === 'birth_certificate' || isEscalation);
      const imageResolution = useUltraHigh ? 'ultra_high' : 'high';
      const body = {
        model,
        input: [
          { type: 'text', text: promptText },
          { type: 'image', data: cleanBase64, mime_type: mimeType, resolution: imageResolution }
        ],
        response_format: { type: 'text', mime_type: 'application/json', schema: OCR_RESPONSE_SCHEMA },
        generation_config: { thinking_level: isEscalation ? 'medium' : 'low' },
        store: false
      };
      attempts.push({
        model,
        timeoutMs: useUltraHigh || isEscalation ? 35000 : 28000,
        label: `${model} (interactions/${imageResolution})`,
        url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'Api-Revision': '2026-05-20' },
        body
      });
    }
    attempts.push({
      model,
      timeoutMs: isEscalation ? 35000 : 28000,
      label: `${model} (generateContent)`,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: {
        contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mimeType, data: cleanBase64 } }] }],
        generationConfig: { response_mime_type: 'application/json', responseSchema: OCR_RESPONSE_SCHEMA }
      }
    });
  }
  return attempts;
}

async function runGeminiCascade(apiKey, cleanBase64, mimeType, promptText, profile = 'accurate', preferredGeminiModel = DEFAULT_GEMINI_MODEL, attemptOpts = {}) {
  const modelsOrder = getOrderedGeminiModels(profile, preferredGeminiModel);
  const attempts = buildGeminiAttemptsForModels(modelsOrder, apiKey, cleanBase64, mimeType, promptText, attemptOpts);

  let lastError = 'No text generated by Gemini OCR.';
  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attempt.timeoutMs || 28000);
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
        if (response.status === 400 && /API[_\s]?key/i.test(msg)) {
          const err = new Error('Invalid Gemini API Key.');
          err.statusCode = 400;
          throw err;
        }
        lastError = `${attempt.label}: ${msg}`;
        continue;
      }

      const textOutput = extractTextFromGeminiResponse(resData);
      if (!textOutput) { lastError = `${attempt.label}: Empty model response`; continue; }

      const data = parseOcrJsonText(textOutput);
      data.ocr_model_used = attempt.label;
      data.ocr_usage = computeScanUsageAndCost(attempt.model, resData);
      return data;
    } catch (err) {
      clearTimeout(timer);
      if (/Invalid Gemini API Key/.test(err.message || '')) throw err;
      lastError = err.name === 'AbortError' ? `${attempt.label}: Request timed out` : `${attempt.label}: ${err.message}`;
    }
  }
  throw new Error(`Gemini OCR Error: ${lastError}`);
}

// Resilient Multi-Provider OCR caller: Gemini 3.5/3.1 Lite, 3.8 Flash, 4 Argon + DeepSeek Vision (deepseek-flash)
async function extractNidWithAI(base64Image, customApiKey, options = {}) {
  let gKey = String(customApiKey || process.env.GEMINI_API_KEY || '').trim();
  let dKey = String(options.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!dKey && /^sk-/i.test(gKey)) {
    dKey = gKey;
    gKey = '';
  }

  const mode = ['economy', 'auto', 'gemini', 'gemini_lite', 'deepseek'].includes(options.aiProvider) ? options.aiProvider : 'economy';
  const keySlot = ['auto', 'gemini', 'deepseek'].includes(options.defaultKeySlot) ? options.defaultKeySlot : 'auto';
  const prefGemModel = normalizeModelId(options.geminiModel || DEFAULT_GEMINI_MODEL);
  const validPrefGemModel = prefGemModel.startsWith('gemini-') ? prefGemModel : DEFAULT_GEMINI_MODEL;
  const prefDsModel = options.deepseekModel || 'deepseek-flash';
  const docType = options.docType || 'auto';

  function badReqError(msg) {
    const err = new Error(msg);
    err.statusCode = 400;
    return err;
  }

  if ((mode === 'gemini' || mode === 'gemini_lite') && !gKey) throw badReqError('No Gemini API Key provided.');
  if (mode === 'deepseek' && !dKey) throw badReqError('No DeepSeek API Key provided.');
  if (!gKey && !dKey) {
    throw badReqError('No Gemini or DeepSeek API Key provided. Configure .env or provide an API key.');
  }

  let mimeType = options.mimeType || 'image/jpeg';
  let cleanBase64 = String(base64Image || '');
  const dataUriMatch = cleanBase64.match(/^data:([^;]+);base64,(.+)$/s);
  if (dataUriMatch) {
    mimeType = dataUriMatch[1] || mimeType;
    cleanBase64 = dataUriMatch[2];
  }

  const promptText = buildGeminiPrompt(docType);
  let rawParsed = null;

  if (mode === 'deepseek') {
    rawParsed = await callDeepSeekVisionOCR(dKey, cleanBase64, mimeType, promptText, prefDsModel);
  } else if (mode === 'gemini_lite') {
    rawParsed = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'lite_only', validPrefGemModel, { docType });
  } else if (mode === 'gemini') {
    rawParsed = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'preferred', validPrefGemModel, { docType });
  } else if (keySlot === 'deepseek' && dKey) {
    const errors = [];
    try {
      const dsRes = await callDeepSeekVisionOCR(dKey, cleanBase64, mimeType, promptText, prefDsModel);
      if (mode === 'auto' || !needsAccurateEscalation(dsRes, docType) || !gKey) {
        rawParsed = dsRes;
      } else {
        try {
          const escRes = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'preferred', validPrefGemModel, { docType, isEscalation: true });
          rawParsed = mergeOcrResults(dsRes, escRes, docType);
        } catch (_) {
          rawParsed = dsRes;
        }
      }
    } catch (err) {
      errors.push(err.message);
    }
    if (!rawParsed && gKey) {
      try {
        rawParsed = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'preferred', validPrefGemModel, { docType });
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (!rawParsed) throw new Error(errors.join(' | '));
  } else if (mode === 'economy') {
    const errors = [];
    if (gKey) {
      try {
        const isFlagship = validPrefGemModel === 'gemini-3.8-flash' || validPrefGemModel === 'gemini-4-argon';
        const firstProfile = isFlagship ? 'preferred' : 'lite_only';
        const primaryRes = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, firstProfile, validPrefGemModel, { docType });
        if (!needsAccurateEscalation(primaryRes, docType) || validPrefGemModel === 'gemini-3.8-flash') {
          rawParsed = primaryRes;
        } else {
          try {
            const escRes = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'flash38_only', validPrefGemModel, { docType, isEscalation: true });
            rawParsed = mergeOcrResults(primaryRes, escRes, docType);
          } catch (_) {
            if (dKey) {
              try {
                const dsEsc = await callDeepSeekVisionOCR(dKey, cleanBase64, mimeType, promptText, prefDsModel);
                rawParsed = mergeOcrResults(primaryRes, dsEsc, docType);
              } catch (__) {}
            }
            if (!rawParsed) rawParsed = primaryRes;
          }
        }
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (!rawParsed && dKey) {
      try {
        rawParsed = await callDeepSeekVisionOCR(dKey, cleanBase64, mimeType, promptText, prefDsModel);
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (!rawParsed) throw new Error(errors.join(' | '));
  } else {
    const errors = [];
    if (gKey) {
      try {
        rawParsed = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'accurate', validPrefGemModel, { docType, isEscalation: docType === 'birth_certificate' });
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (!rawParsed && dKey) {
      try {
        rawParsed = await callDeepSeekVisionOCR(dKey, cleanBase64, mimeType, promptText, prefDsModel);
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
    const { apiKey, deepseekApiKey, aiProvider, defaultKeySlot, geminiModel, deepseekModel, room, mimeType, docType } = req.body;
    if (!image) {
      return res.status(400).json({ success: false, error: 'No image provided.' });
    }

    const extracted = await extractNidWithAI(image, apiKey, {
      mimeType,
      docType,
      aiProvider,
      defaultKeySlot,
      geminiModel,
      deepseekModel,
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
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
}

app.post('/api/ocr-nid', handleExtractNidRoute);
app.post('/api/extract-nid', handleExtractNidRoute);

// --- Cross-Device Room Messaging & Data Sharing Store ---
const FIRESTORE_ROOMS_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/room_channels';
const roomMessagesStore = new Map();
const MAX_ROOM_MESSAGES = 100;

function normalizeRoomCode(room) {
  const clean = String(room || 'FC-101').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
  return clean || 'FC-101';
}

function makeRoomMsgId(ts = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 7);
  return `m_${String(ts).padStart(14, '0')}_${rand}`;
}

function normalizeRoomMessage(raw = {}, fallbackRoom = 'FC-101') {
  const ts = Number(raw.ts) > 0 ? Number(raw.ts) : Date.now();
  const room = normalizeRoomCode(raw.room || fallbackRoom);
  const type = ['text', 'nid_data', 'summary', 'system'].includes(raw.type) ? raw.type : 'text';
  const id = String(raw.id || makeRoomMsgId(ts)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || makeRoomMsgId(ts);
  let payload = raw.payload || null;
  if (!payload && raw.payloadJson && typeof raw.payloadJson === 'string') {
    try { payload = JSON.parse(raw.payloadJson); } catch (_) { payload = null; }
  }
  let replyTo = raw.replyTo || null;
  if (!replyTo && raw.replyToJson && typeof raw.replyToJson === 'string') {
    try { replyTo = JSON.parse(raw.replyToJson); } catch (_) { replyTo = null; }
  }
  return {
    id,
    room,
    type,
    text: String(raw.text || '').slice(0, 4000),
    payload: payload && typeof payload === 'object' ? payload : null,
    senderName: String(raw.senderName || 'অজানা ডিভাইস').slice(0, 60),
    senderClient: String(raw.senderClient || 'web').slice(0, 30),
    senderId: String(raw.senderId || '').slice(0, 64),
    replyTo: replyTo && typeof replyTo === 'object' ? {
      id: String(replyTo.id || ''),
      senderName: String(replyTo.senderName || ''),
      preview: String(replyTo.preview || '').slice(0, 120)
    } : null,
    ts,
    createdAt: raw.createdAt || new Date(ts).toISOString()
  };
}

function appendRoomMessageInMemory(rawMsg, fallbackRoom = 'FC-101') {
  const msg = normalizeRoomMessage(rawMsg, fallbackRoom);
  const list = roomMessagesStore.get(msg.room) || [];
  if (!list.some((m) => m.id === msg.id)) {
    list.push(msg);
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > MAX_ROOM_MESSAGES) list.splice(0, list.length - MAX_ROOM_MESSAGES);
    roomMessagesStore.set(msg.room, list);
  }
  return msg;
}

async function syncRoomMessageToFirestore(msg) {
  try {
    const fields = {
      id: { stringValue: msg.id },
      room: { stringValue: msg.room },
      type: { stringValue: msg.type },
      text: { stringValue: msg.text || '' },
      payloadJson: { stringValue: msg.payload ? JSON.stringify(msg.payload) : '' },
      senderName: { stringValue: msg.senderName || '' },
      senderClient: { stringValue: msg.senderClient || '' },
      senderId: { stringValue: msg.senderId || '' },
      replyToJson: { stringValue: msg.replyTo ? JSON.stringify(msg.replyTo) : '' },
      ts: { integerValue: String(msg.ts) },
      createdAt: { stringValue: msg.createdAt }
    };
    const preview = (msg.text || (msg.type === 'nid_data' ? (msg.payload?.name_bn || msg.payload?.doc_number || 'NID ডেটা') : 'বার্তা')).slice(0, 120);
    await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(msg.room)}/messages/${encodeURIComponent(msg.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    const metaFields = {
      room: { stringValue: msg.room },
      last_msg_id: { stringValue: msg.id },
      last_sender: { stringValue: msg.senderName || '' },
      last_preview: { stringValue: preview },
      updated_at: { timestampValue: new Date().toISOString() }
    };
    const metaMask = Object.keys(metaFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(msg.room)}?${metaMask}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: metaFields })
    });
  } catch (e) {
    console.warn('[Firestore Room Sync notice]:', e.message);
  }
}

async function loadCloudRoomMessages(room) {
  const listRes = await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}/messages?pageSize=60`);
  if (!listRes.ok) return [];
  const data = await listRes.json().catch(() => ({}));
  const docs = Array.isArray(data.documents) ? data.documents : [];
  return docs.map((d) => {
    const f = d.fields || {};
    return normalizeRoomMessage({
      id: f.id?.stringValue || d.name?.split('/').pop(),
      room: f.room?.stringValue || room,
      type: f.type?.stringValue || 'text',
      text: f.text?.stringValue || '',
      payloadJson: f.payloadJson?.stringValue || '',
      senderName: f.senderName?.stringValue || '',
      senderClient: f.senderClient?.stringValue || '',
      senderId: f.senderId?.stringValue || '',
      replyToJson: f.replyToJson?.stringValue || '',
      ts: Number(f.ts?.integerValue || f.ts?.doubleValue || 0),
      createdAt: f.createdAt?.stringValue || ''
    }, room);
  }).sort((a, b) => a.ts - b.ts);
}

app.get(['/api/room-messages', '/api/rooms/:room/messages'], async (req, res) => {
  try {
    const room = normalizeRoomCode(req.params.room || req.query.room);
    const since = Number(req.query.since || 0);
    let memList = roomMessagesStore.get(room) || [];
    if (memList.length === 0) {
      const cloudList = await loadCloudRoomMessages(room).catch(() => []);
      cloudList.forEach((m) => appendRoomMessageInMemory(m, room));
      memList = roomMessagesStore.get(room) || [];
    }
    const filtered = since > 0 ? memList.filter((m) => m.ts > since) : memList;
    res.json({ success: true, room, messages: filtered, serverTime: Date.now() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post(['/api/room-messages', '/api/rooms/:room/messages'], async (req, res) => {
  try {
    const room = normalizeRoomCode(req.params.room || req.body?.room);
    const msg = appendRoomMessageInMemory(req.body || {}, room);
    io.to(room).emit('room-message', msg);
    syncRoomMessageToFirestore(msg);
    res.json({ success: true, room, message: msg });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete(['/api/room-messages', '/api/rooms/:room/messages'], async (req, res) => {
  try {
    const room = normalizeRoomCode(req.params.room || req.query.room || req.body?.room);
    roomMessagesStore.set(room, []);
    io.to(room).emit('room-cleared', { room, ts: Date.now() });
    const clearedAt = Date.now();
    const metaFields = {
      room: { stringValue: room },
      last_msg_id: { stringValue: '' },
      cleared_at_ms: { integerValue: String(clearedAt) },
      updated_at: { timestampValue: new Date().toISOString() }
    };
    const metaMask = Object.keys(metaFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}?${metaMask}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: metaFields })
    }).catch(() => {});
    res.json({ success: true, room, clearedAt });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get local server status and network info
app.get('/api/info', (req, res) => {
  res.json({
    status: 'online',
    port: PORT,
    localIps: getLocalIpAddresses(),
    hasEnvApiKey: Boolean(process.env.GEMINI_API_KEY),
    hasDeepSeekKey: Boolean(process.env.DEEPSEEK_API_KEY),
    bdtPerUsd: BDT_PER_USD,
    deepSeekPeakNow: isDeepSeekPeakUtc(),
    pricing: AI_MODEL_CATALOG,
    features: ['room_messaging', 'cloud_room_sync', 'nid_data_share', 'summary_share']
  });
});

// Socket.io Real-time connection for cross-device sync & room messaging
io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // Device joining a specific sync room
  socket.on('join-room', async (roomOrInfo) => {
    const rawRoom = typeof roomOrInfo === 'object' && roomOrInfo ? roomOrInfo.room : roomOrInfo;
    const cleanRoom = normalizeRoomCode(rawRoom);
    socket.join(cleanRoom);
    console.log(`[Socket ${socket.id}] joined room: ${cleanRoom}`);
    const peerCount = io.sockets.adapter.rooms.get(cleanRoom)?.size || 1;
    let history = roomMessagesStore.get(cleanRoom) || [];
    if (history.length === 0) {
      const cloudList = await loadCloudRoomMessages(cleanRoom).catch(() => []);
      cloudList.forEach((m) => appendRoomMessageInMemory(m, cleanRoom));
      history = roomMessagesStore.get(cleanRoom) || [];
    }
    socket.emit('room-joined', { room: cleanRoom, peerCount, history });
    io.to(cleanRoom).emit('room-presence', { room: cleanRoom, peerCount });
    socket.to(cleanRoom).emit('peer-connected', { id: socket.id, room: cleanRoom, peerCount });
  });

  // Cross-device room chat / NID data / summary message
  socket.on('room-message', (rawPayload, ack) => {
    try {
      const msg = appendRoomMessageInMemory(rawPayload || {}, rawPayload?.room);
      io.to(msg.room).emit('room-message', msg);
      syncRoomMessageToFirestore(msg);
      if (typeof ack === 'function') ack({ success: true, message: msg });
    } catch (err) {
      if (typeof ack === 'function') ack({ success: false, error: err.message });
    }
  });

  socket.on('clear-room-messages', (rawPayload) => {
    const room = normalizeRoomCode(typeof rawPayload === 'string' ? rawPayload : rawPayload?.room);
    roomMessagesStore.set(room, []);
    io.to(room).emit('room-cleared', { room, ts: Date.now() });
  });

  // Mobile device sending image for processing and forwarding
  socket.on('scan-nid', async (payload) => {
    const { image, room, apiKey, deepseekApiKey, aiProvider, defaultKeySlot, geminiModel, deepseekModel } = payload;
    const targetRoom = normalizeRoomCode(room);

    console.log(`[OCR Request] Received image for room: ${targetRoom}`);
    socket.emit('ocr-status', { status: 'processing', message: 'AI ডকুমেন্ট বিশ্লেষণ করছে...' });

    try {
      const extracted = await extractNidWithAI(image, apiKey, {
        docType: payload.docType,
        aiProvider,
        defaultKeySlot,
        geminiModel,
        deepseekModel,
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

      // Share scanned card in room message stream as well
      const scanMsg = appendRoomMessageInMemory({
        room: targetRoom,
        type: 'nid_data',
        text: `🪪 স্ক্যান: ${extracted.name_bn || extracted.name_en || ''} (${extracted.doc_number || extracted.nid_number || extracted.birth_reg_no || ''})`,
        payload: extracted,
        senderName: payload.senderName || 'মোবাইল স্ক্যানার',
        senderClient: 'companion'
      }, targetRoom);
      io.to(targetRoom).emit('room-message', scanMsg);
      syncRoomMessageToFirestore(scanMsg);

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
