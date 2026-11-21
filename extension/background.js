// Background Service Worker for Family Card NID Auto-Filler
// Handles direct Gemini (3.5 Flash-Lite, 3.8 Flash, 4 Argon, 3.1 Flash-Lite) & DeepSeek Flash Vision OCR calls with cost tracking.

const BDT_PER_USD = 122;

const AI_MODEL_CATALOG = {
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
  const spec = AI_MODEL_CATALOG[key] || AI_MODEL_CATALOG['gemini-3.5-flash-lite'];
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

  const hasIntro = Boolean(spec.introUntilUtcMs && spec.stdInputPer1M != null);
  const inIntro = hasIntro && nowMs < spec.introUntilUtcMs;
  const inRate = hasIntro ? (inIntro ? spec.inputPer1M : spec.stdInputPer1M) : spec.inputPer1M;
  const outRate = hasIntro ? (inIntro ? spec.outputPer1M : spec.stdOutputPer1M) : spec.outputPer1M;
  const cacheRate = hasIntro ? (inIntro ? spec.cacheReadPer1M : spec.stdCacheReadPer1M) : spec.cacheReadPer1M;
  const uncachedIn = Math.max(0, inputTokens - cachedTokens);
  const costUsd = (uncachedIn * inRate + cachedTokens * cacheRate + outputTokens * outRate) / 1e6;

  return {
    model: key,
    label: spec.label,
    provider: 'gemini',
    tierWindow: hasIntro ? (inIntro ? 'intro_2026' : 'standard') : 'tier1',
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

// Normalize Bengali numerals (০-৯) to English (0-9)
function normalizeDigits(str) {
  if (!str) return '';
  const bn = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  return String(str).replace(/[০-৯]/g, d => {
    const idx = bn.indexOf(d);
    return idx !== -1 ? idx : d;
  });
}

// Standardize Date of Birth (supports English & Bengali months/digits) to DD/MM/YYYY
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
  let cleanText = fenceMatch ? fenceMatch[1].trim() : String(textOutput || '').trim();
  const objMatch = cleanText.match(/\{[\s\S]*\}/);
  if (objMatch) cleanText = objMatch[0];
  return JSON.parse(cleanText);
}

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const INTERACTIONS_API_MODELS = new Set(['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon']);
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

function validateAndNormalizeOcrData(parsedData, opts = {}) {
  const { docType = 'auto', maritalStatus = 'বিবাহিত', religion = 'ইসলাম', mobileNumber = '' } = opts;
  const warnings = [];

  if (docType && docType !== 'auto') {
    parsedData.doc_type = docType;
  } else if (
    parsedData.doc_type !== 'birth_certificate' &&
    !extractDigitCandidate(parsedData.nid_number) &&
    extractDigitCandidate(parsedData.birth_reg_no).length === 17
  ) {
    parsedData.doc_type = 'birth_certificate';
  }

  if (parsedData.dob) {
    parsedData.dob = standardizeDate(parsedData.dob);
  }

  if (parsedData.gender) {
    parsedData.gender = normalizeGenderValue(parsedData.gender);
  }
  const relMap = { 'ছেলে': 'পুত্র', 'মেয়ে': 'কন্যা', 'মেয়ে': 'কন্যা', 'বাবা': 'পিতা', 'মা': 'মাতা' };
  if (parsedData.relation_suggestion) {
    const r = String(parsedData.relation_suggestion).trim();
    parsedData.relation_suggestion = relMap[r] || r;
  }

  // Prevent old laminated women's NID "স্বামী:" from polluting Father's name
  const spouseBn = String(parsedData.spouse_name_bn || '').trim();
  const fatherBn = String(parsedData.father_name_bn || '').trim();
  if (spouseBn && fatherBn && fatherBn === spouseBn) {
    parsedData.father_name_bn = '';
    parsedData.father_name_en = '';
  }
  if (spouseBn && !parsedData.father_name_bn) {
    warnings.push("পুরাতন NID-তে 'স্বামী' নাম পাওয়া গেছে (পিতার নাম ছাপা নেই) — প্রয়োজনে পিতার নাম যাচাই/লিখুন।");
    if (!parsedData.relation_suggestion) parsedData.relation_suggestion = 'স্ত্রী';
  }

  if (parsedData.doc_type === 'birth_certificate') {
    const cleanDocNum = pickBestDocDigits([parsedData.birth_reg_no, parsedData.doc_number, parsedData.nid_number], [17]);
    parsedData.doc_number = cleanDocNum;
    parsedData.birth_reg_no = cleanDocNum;
    parsedData.nid_number = '';
    if (cleanDocNum.length !== 17) {
      warnings.push(`জন্ম নিবন্ধন নম্বরটি ${cleanDocNum.length || 0} সংখ্যার (অবশ্যই ১৭ সংখ্যার হতে হবে) — নম্বরটি যাচাই করুন।`);
    }
  } else {
    let cleanDocNum = pickBestDocDigits([parsedData.nid_number, parsedData.doc_number, parsedData.birth_reg_no], [10, 17, 13]);
    if (cleanDocNum.length === 13) {
      const yearMatch = String(parsedData.dob || '').match(/\b(19\d{2}|20\d{2})\b/);
      if (yearMatch) {
        cleanDocNum = yearMatch[1] + cleanDocNum;
        parsedData.nid_converted_to_17 = true;
      } else {
        warnings.push('১৩ সংখ্যার NID-র জন্মসাল না পাওয়ায় ১৭ সংখ্যায় রূপান্তর করা যায়নি — জন্মতারিখ যাচাই করুন।');
      }
    }
    parsedData.doc_type = parsedData.doc_type || 'nid';
    parsedData.doc_number = cleanDocNum;
    parsedData.nid_number = cleanDocNum;
    parsedData.birth_reg_no = '';
    if (cleanDocNum.length !== 10 && cleanDocNum.length !== 17) {
      warnings.push(`NID নম্বরটি ${cleanDocNum.length || 0} সংখ্যার (১০ বা ১৭ সংখ্যার হতে হবে) — নম্বরটি যাচাই করুন।`);
    }
  }

  if (!String(parsedData.name_bn || '').trim()) warnings.push('বাংলা নাম পড়া যায়নি।');
  if (!String(parsedData.name_en || '').trim()) warnings.push('ইংরেজি নাম পড়া যায়নি।');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(parsedData.dob || ''))) {
    warnings.push('জন্ম তারিখ (DD/MM/YYYY) স্পষ্ট নয় — হাতে মিলিয়ে নিন।');
  }
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(parsedData.gender || '').trim())) {
    warnings.push('লিঙ্গ স্পষ্ট নয় — নির্বাচন যাচাই করুন।');
  }
  if (!String(parsedData.mother_name_bn || '').trim() && !String(parsedData.mother_name_en || '').trim()) {
    warnings.push('মাতার নাম পড়া যায়নি — প্রয়োজনে হাতে লিখুন।');
  }
  if (parsedData.confidence === 'low') {
    warnings.push('ছবিটি কিছুটা ঝাপসা/অস্পষ্ট মনে হচ্ছে — সাবমিটের আগে সব তথ্য মিলিয়ে নিন।');
  }

  if (parsedData.name_en) parsedData.name_en = String(parsedData.name_en).toUpperCase().trim();
  if (parsedData.father_name_en) parsedData.father_name_en = String(parsedData.father_name_en).toUpperCase().trim();
  if (parsedData.mother_name_en) parsedData.mother_name_en = String(parsedData.mother_name_en).toUpperCase().trim();
  if (parsedData.spouse_name_en) parsedData.spouse_name_en = String(parsedData.spouse_name_en).toUpperCase().trim();

  const normMob = mobileNumber ? normalizeDigits(mobileNumber).replace(/[^0-9]/g, '').trim() : '';
  if (normMob && !/^01[3-9]\d{8}$/.test(normMob)) {
    warnings.push('মোবাইল নম্বরটি সঠিক ১১ সংখ্যার (01XXXXXXXXX) নয়।');
  }

  parsedData.marital_status = maritalStatus || parsedData.marital_status_suggestion || 'বিবাহিত';
  parsedData.religion = religion || 'ইসলাম';
  parsedData.mobile_number = normMob;
  parsedData.ocr_warnings = warnings;
  return parsedData;
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

function buildGeminiAttemptsForModels(models, apiKey, rawBase64, detectedMime, promptText, opts = {}) {
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
          { type: 'image', data: rawBase64, mime_type: detectedMime, resolution: imageResolution }
        ],
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: OCR_RESPONSE_SCHEMA
        },
        generation_config: {
          thinking_level: isEscalation ? 'medium' : 'low'
        },
        store: false
      };
      attempts.push({
        model,
        timeoutMs: useUltraHigh || isEscalation ? 35000 : 28000,
        label: `${model} (interactions/${imageResolution})`,
        url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
          'Api-Revision': '2026-05-20'
        },
        body
      });
    }
    attempts.push({
      model,
      timeoutMs: isEscalation ? 35000 : 28000,
      label: `${model} (generateContent)`,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: {
        contents: [
          {
            parts: [
              { text: promptText },
              { inline_data: { mime_type: detectedMime, data: rawBase64 } }
            ]
          }
        ],
        generationConfig: {
          response_mime_type: 'application/json',
          responseSchema: OCR_RESPONSE_SCHEMA
        }
      }
    });
  }
  return attempts;
}

async function callGeminiResilientOCR(apiKey, rawBase64, detectedMime, promptText, profile = 'accurate', preferredGeminiModel = DEFAULT_GEMINI_MODEL, attemptOpts = {}) {
  const modelsOrder = getOrderedGeminiModels(profile, preferredGeminiModel);
  const attempts = buildGeminiAttemptsForModels(modelsOrder, apiKey, rawBase64, detectedMime, promptText, attemptOpts);

  let lastErrorMsg = 'Gemini API থেকে কোনো ফলাফল পাওয়া যায়নি।';

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
          throw new Error('Gemini API Key সঠিক নয়। অনুগ্রহ করে সঠিক API Key দিন।');
        }
        if (response.status === 403 && /permission|key|disabled/i.test(msg)) {
          throw new Error(`Gemini API অনুমতি ত্রুটি: ${msg}`);
        }
        lastErrorMsg = `${attempt.label}: ${msg}`;
        continue;
      }

      const textOutput = extractTextFromGeminiResponse(resData);
      if (!textOutput) {
        lastErrorMsg = `${attempt.label}: খালি উত্তর পাওয়া গেছে`;
        continue;
      }

      const parsed = parseOcrJsonText(textOutput);
      parsed.ocr_model_used = attempt.label;
      parsed.ocr_usage = computeScanUsageAndCost(attempt.model, resData);
      return parsed;
    } catch (err) {
      clearTimeout(timer);
      if (/API Key সঠিক নয়|অনুমতি ত্রুটি/.test(err.message || '')) throw err;
      lastErrorMsg = err.name === 'AbortError'
        ? `${attempt.label}: সময় শেষ হয়েছে (Timeout)`
        : `${attempt.label}: ${err.message}`;
    }
  }

  throw new Error(`OCR ব্যর্থ: ${lastErrorMsg}`);
}

async function callDeepSeekVisionOCR(deepseekKey, rawBase64, detectedMime, promptText, deepseekModel = 'deepseek-flash') {
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
              {
                type: 'image_url',
                image_url: { url: `data:${detectedMime};base64,${rawBase64}`, detail: 'high' }
              }
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
        throw new Error('DeepSeek API Key সঠিক নয়। অনুগ্রহ করে সঠিক Key দিন।');
      }
      if (response.status === 402) {
        throw new Error('DeepSeek অ্যাকাউন্টে ব্যালেন্স শেষ (Insufficient Balance)।');
      }
      throw new Error(`DeepSeek API (${response.status}): ${msg}`);
    }

    const content = resData?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('DeepSeek API থেকে কোনো উত্তর পাওয়া যায়নি।');
    }

    const parsed = parseOcrJsonText(content);
    parsed.ocr_model_used = `${targetModel} (api.deepseek.com)`;
    parsed.ocr_usage = computeScanUsageAndCost(targetModel, resData);
    return parsed;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('DeepSeek OCR সময় শেষ হয়েছে (Timeout)');
    }
    throw err;
  }
}

async function runMultiProviderOCR({
  aiProvider = 'economy',
  defaultKeySlot = 'auto',
  geminiModel = DEFAULT_GEMINI_MODEL,
  deepseekModel = 'deepseek-flash',
  geminiKey = '',
  deepseekKey = '',
  rawBase64,
  detectedMime,
  promptText,
  docType = 'auto'
}) {
  let gKey = String(geminiKey || '').trim();
  let dKey = String(deepseekKey || '').trim();
  if (!dKey && /^sk-/i.test(gKey)) {
    dKey = gKey;
    gKey = '';
  }

  const mode = ['economy', 'auto', 'gemini', 'gemini_lite', 'deepseek'].includes(aiProvider) ? aiProvider : 'economy';
  const keySlot = ['auto', 'gemini', 'deepseek'].includes(defaultKeySlot) ? defaultKeySlot : 'auto';
  const normModel = normalizeModelId(geminiModel);
  const prefGemModel = normModel.startsWith('gemini-') ? normModel : DEFAULT_GEMINI_MODEL;

  if (mode === 'deepseek') {
    if (!dKey) throw new Error('DeepSeek API Key সেট করা নেই। সেটিংসে গিয়ে sk-... Key দিন।');
    return await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
  }

  if (mode === 'gemini_lite') {
    if (!gKey) throw new Error('Gemini API Key সেট করা নেই।');
    return await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'lite_only', prefGemModel, { docType });
  }

  if (mode === 'gemini') {
    if (!gKey) throw new Error('Gemini API Key সেট করা নেই।');
    return await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'preferred', prefGemModel, { docType });
  }

  const errors = [];
  const preferDeepSeekFirst = keySlot === 'deepseek' && Boolean(dKey);

  if (preferDeepSeekFirst) {
    try {
      const dsRes = await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
      if (mode === 'auto' || !needsAccurateEscalation(dsRes, docType) || !gKey) return dsRes;
      try {
        const escRes = await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'preferred', prefGemModel, { docType, isEscalation: true });
        return mergeOcrResults(dsRes, escRes, docType);
      } catch (_) {
        return dsRes;
      }
    } catch (err) {
      errors.push(`DeepSeek: ${err.message}`);
    }
    if (gKey) {
      try {
        const gProfile = mode === 'economy' ? 'preferred' : 'accurate';
        return await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, gProfile, prefGemModel, { docType });
      } catch (err) {
        errors.push(`Gemini: ${err.message}`);
      }
    }
    throw new Error(errors.length ? errors.join(' | ') : 'Gemini বা DeepSeek API Key সেট করা নেই।');
  }

  // Economy mode: selected default Gemini model (3.5 Flash-Lite) first, auto-escalates & merges when blurry/incomplete
  if (mode === 'economy') {
    if (gKey) {
      try {
        const isFlagship = prefGemModel === 'gemini-3.8-flash' || prefGemModel === 'gemini-4-argon';
        const firstProfile = isFlagship ? 'preferred' : 'lite_only';
        const primaryRes = await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, firstProfile, prefGemModel, { docType });
        if (!needsAccurateEscalation(primaryRes, docType) || prefGemModel === 'gemini-3.8-flash') return primaryRes;
        try {
          const escRes = await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'flash38_only', prefGemModel, { docType, isEscalation: true });
          return mergeOcrResults(primaryRes, escRes, docType);
        } catch (escErr) {
          if (dKey) {
            try {
              const dsEsc = await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
              return mergeOcrResults(primaryRes, dsEsc, docType);
            } catch (_) {}
          }
          return primaryRes;
        }
      } catch (err) {
        errors.push(`Gemini: ${err.message}`);
      }
    }
    if (dKey) {
      try {
        return await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
      } catch (err) {
        errors.push(`DeepSeek: ${err.message}`);
      }
    }
    throw new Error(errors.length ? errors.join(' | ') : 'Gemini বা DeepSeek API Key সেট করা নেই।');
  }

  // Balanced auto mode: Gemini 3.8 Flash (or 4 Argon) primary -> selected model/Lite fallback -> DeepSeek failover
  if (gKey) {
    try {
      return await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'accurate', prefGemModel, { docType, isEscalation: docType === 'birth_certificate' });
    } catch (err) {
      errors.push(`Gemini: ${err.message}`);
    }
  }
  if (dKey) {
    try {
      return await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
    } catch (err) {
      errors.push(`DeepSeek: ${err.message}`);
    }
  }

  throw new Error(errors.length ? errors.join(' | ') : 'Gemini বা DeepSeek API Key সেট করা নেই।');
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'ocr_nid_direct') {
    handleDirectOCR(req)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message || 'Unknown OCR Error' }));
    return true;
  }
});

async function handleDirectOCR(req) {
  const { imageBase64, mimeType = 'image/jpeg', maritalStatus = 'বিবাহিত', religion = 'ইসলাম', mobileNumber = '', docType = 'auto' } = req;

  const stored = await chrome.storage.sync.get(['aiProvider', 'geminiModel', 'deepseekModel', 'defaultKeySlot', 'geminiApiKey', 'deepseekApiKey', 'serverUrl']);
  const aiProvider = req.aiProvider || stored.aiProvider || 'economy';
  const geminiModel = req.geminiModel || stored.geminiModel || DEFAULT_GEMINI_MODEL;
  const deepseekModel = req.deepseekModel || stored.deepseekModel || 'deepseek-flash';
  const defaultKeySlot = req.defaultKeySlot || stored.defaultKeySlot || 'auto';
  const apiKey = req.apiKey || stored.geminiApiKey || '';
  const deepseekApiKey = req.deepseekApiKey || stored.deepseekApiKey || '';

  if (!apiKey && !deepseekApiKey && stored.serverUrl) {
    return await forwardToServer(stored.serverUrl, imageBase64, mimeType, maritalStatus, religion, mobileNumber, docType, aiProvider, deepseekApiKey, geminiModel, deepseekModel, defaultKeySlot);
  }

  if (!apiKey && !deepseekApiKey) {
    throw new Error('Gemini বা DeepSeek API Key সেট করা নেই। এক্সটেনশন আইকনে ক্লিক করে Key দিন।');
  }

  let detectedMime = mimeType;
  let rawBase64 = String(imageBase64 || '');
  const dataUriMatch = rawBase64.match(/^data:([^;]+);base64,(.+)$/s);
  if (dataUriMatch) {
    detectedMime = dataUriMatch[1] || detectedMime;
    rawBase64 = dataUriMatch[2];
  }

  const promptText = buildGeminiPrompt(docType);
  const parsedData = await runMultiProviderOCR({
    aiProvider,
    defaultKeySlot,
    geminiModel,
    deepseekModel,
    geminiKey: apiKey,
    deepseekKey: deepseekApiKey,
    rawBase64,
    detectedMime,
    promptText,
    docType
  });
  validateAndNormalizeOcrData(parsedData, { docType, maritalStatus, religion, mobileNumber });

  return {
    success: true,
    data: parsedData
  };
}

// Forward to backend server if user has a server configured
async function forwardToServer(serverUrl, imageBase64, mimeType, maritalStatus, religion, mobileNumber, docType = 'auto', aiProvider = 'economy', deepseekApiKey = '', geminiModel = DEFAULT_GEMINI_MODEL, deepseekModel = 'deepseek-flash', defaultKeySlot = 'auto') {
  const url = `${serverUrl.replace(/\/+$/, '')}/api/extract-nid`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64,
      mimeType,
      maritalStatus,
      religion,
      mobileNumber,
      docType,
      aiProvider,
      defaultKeySlot,
      geminiModel,
      deepseekModel,
      deepseekApiKey
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`সার্ভার এরর (${response.status}): ${errorText}`);
  }

  return await response.json();
}
