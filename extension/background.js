// Background Service Worker for Family Card NID Auto-Filler
// Handles direct Gemini (3.1/3.5 Flash-Lite, 3.8 Flash) & DeepSeek Flash Vision OCR calls with cost tracking.

const BDT_PER_USD = 122;

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
  if (raw.includes('3.5-flash-lite') || raw.includes('3.5')) return 'gemini-3.5-flash-lite';
  if (raw.includes('3.8-flash') || raw.includes('3.8')) return 'gemini-3.8-flash';
  return 'gemini-3.1-flash-lite';
}

function computeScanUsageAndCost(modelId, rawApiRes = {}, nowMs = Date.now()) {
  const key = normalizeModelId(modelId);
  const spec = AI_MODEL_CATALOG[key] || AI_MODEL_CATALOG['gemini-3.1-flash-lite'];
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

  const isIntro38 = key === 'gemini-3.8-flash' && spec.introUntilUtcMs && nowMs < spec.introUntilUtcMs;
  const inRate = key === 'gemini-3.8-flash' ? (isIntro38 ? spec.inputPer1M : spec.stdInputPer1M) : spec.inputPer1M;
  const outRate = key === 'gemini-3.8-flash' ? (isIntro38 ? spec.outputPer1M : spec.stdOutputPer1M) : spec.outputPer1M;
  const cacheRate = key === 'gemini-3.8-flash' ? (isIntro38 ? spec.cacheReadPer1M : spec.stdCacheReadPer1M) : spec.cacheReadPer1M;
  const uncachedIn = Math.max(0, inputTokens - cachedTokens);
  const costUsd = (uncachedIn * inRate + cachedTokens * cacheRate + outputTokens * outRate) / 1e6;

  return {
    model: key,
    label: spec.label,
    provider: 'gemini',
    tierWindow: key === 'gemini-3.8-flash' ? (isIntro38 ? 'intro_2026' : 'standard') : 'tier1',
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
  required: ['doc_type', 'doc_number', 'name_bn', 'name_en', 'dob', 'gender']
};

function buildGeminiPrompt(docTypeHint = 'auto') {
  const hintLine = docTypeHint === 'nid'
    ? 'HINT: User indicated this document is a Bangladeshi NID Card.'
    : docTypeHint === 'birth_certificate'
      ? 'HINT: User indicated this document is a Bangladeshi Birth Registration Certificate (জন্ম নিবন্ধন সনদপত্র).'
      : 'Detect automatically whether this is a Bangladeshi NID Card or a Birth Registration Certificate.';

  return `
You are an expert OCR and document understanding system specializing in Bangladeshi identity documents:
1. Bangladeshi National Identity (NID) Cards (Smart Cards and laminated classic paper NID cards).
2. Bangladeshi Digital Birth Registration Certificates (ডিজিটাল জন্ম নিবন্ধন সনদপত্র / BRC).

${hintLine}

Analyze the provided image carefully and extract exact information into valid JSON format.

DOCUMENT CLASSIFICATION:
- "doc_type": Strictly "nid" or "birth_certificate".
  - If NID Card (Smart Card or classic laminated paper NID), set "doc_type": "nid".
  - If Birth Registration Certificate (জন্ম নিবন্ধন সনদপত্র / Office of the Registrar General, Birth & Death), set "doc_type": "birth_certificate".

EXTRACTION RULES:
1. "doc_number":
   - For NID: Extract the National ID number. Smart NID has 10 digits; classic NID has 13 or 17 digits.
     If classic 13-digit NID, extract the 13 digits or prepend the 4-digit birth year to make 17 digits. Copy digits to "nid_number".
   - For Birth Certificate: Extract the exact 17-digit Birth Registration Number (জন্ম নিবন্ধন নম্বর / Personal Identification Number). Copy digits to "birth_reg_no".
   - Remove all spaces, hyphens, and non-numeric characters. Convert any Bengali digits (০-৯) to English digits (0-9).
2. "name_bn": Full Bengali name exactly as printed (under "নাম:" or "নিবন্ধিত ব্যক্তির নাম").
3. "name_en": Full English name in ALL UPPERCASE letters (transliterate from Bengali if not printed on old NID).
4. "dob": Date of Birth in strict DD/MM/YYYY English digit format (e.g. "14/05/1988"). Convert Bengali digits/months accurately.
5. "gender": Strictly "পুরুষ" (Male), "নারী" (Female), or "হিজড়া" (Third Gender / Hijra). Infer accurately if not explicitly written on classic NID.
6. "father_name_bn" & "father_name_en": Extract ONLY from "পিতা:" / "পিতার নাম:" / "Father's Name".
   CRITICAL FOR MARRIED WOMEN'S OLD LAMINATED NID: Many classic laminated NIDs for women print "স্বামী:" (Husband) instead of "পিতা:" (Father).
   NEVER put "স্বামী:" (Husband) into "father_name_bn" or "father_name_en"! Leave father fields empty "" if "পিতা:" is absent, and put husband's name in "spouse_name_bn" / "spouse_name_en".
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

function validateAndNormalizeOcrData(parsedData, opts = {}) {
  const { docType = 'auto', maritalStatus = 'বিবাহিত', religion = 'ইসলাম', mobileNumber = '' } = opts;
  const warnings = [];

  if (docType && docType !== 'auto') {
    parsedData.doc_type = docType;
  }

  if (parsedData.dob) {
    parsedData.dob = standardizeDate(parsedData.dob);
  }

  const genderMap = {
    'তৃতীয় লিঙ্গ': 'হিজড়া', 'তৃতীয় লিঙ্গ': 'হিজড়া', 'হিজড়া': 'হিজড়া',
    'Male': 'পুরুষ', 'male': 'পুরুষ', 'Female': 'নারী', 'female': 'নারী'
  };
  if (parsedData.gender) {
    const g = String(parsedData.gender).trim();
    parsedData.gender = genderMap[g] || g;
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

  const rawDocNum = parsedData.doc_number || (parsedData.doc_type === 'birth_certificate' ? parsedData.birth_reg_no : parsedData.nid_number) || parsedData.nid_number || parsedData.birth_reg_no || '';
  let cleanDocNum = normalizeDigits(rawDocNum).replace(/[^0-9]/g, '');

  if (parsedData.doc_type === 'birth_certificate') {
    parsedData.doc_number = cleanDocNum;
    parsedData.birth_reg_no = cleanDocNum;
    if (cleanDocNum.length !== 17) {
      warnings.push(`জন্ম নিবন্ধন নম্বরটি ${cleanDocNum.length || 0} সংখ্যার (অবশ্যই ১৭ সংখ্যার হতে হবে) — নম্বরটি যাচাই করুন।`);
    }
  } else {
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
    if (cleanDocNum.length !== 10 && cleanDocNum.length !== 17) {
      warnings.push(`NID নম্বরটি ${cleanDocNum.length || 0} সংখ্যার (১০ বা ১৭ সংখ্যার হতে হবে) — নম্বরটি যাচাই করুন।`);
    }
  }

  if (!String(parsedData.name_bn || '').trim()) warnings.push('বাংলা নাম পড়া যায়নি।');
  if (!String(parsedData.name_en || '').trim()) warnings.push('ইংরেজি নাম পড়া যায়নি।');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(parsedData.dob || ''))) {
    warnings.push('জন্ম তারিখ (DD/MM/YYYY) স্পষ্ট নয় — হাতে মিলিয়ে নিন।');
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

function needsAccurateEscalation(parsed) {
  if (!parsed || typeof parsed !== 'object') return true;
  if (parsed.confidence === 'low') return true;
  if (!String(parsed.name_bn || '').trim() || !String(parsed.name_en || '').trim()) return true;
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(standardizeDate(parsed.dob || ''))) return true;
  const rawNum = parsed.doc_number || (parsed.doc_type === 'birth_certificate' ? parsed.birth_reg_no : parsed.nid_number) || parsed.nid_number || parsed.birth_reg_no || '';
  const digits = normalizeDigits(rawNum).replace(/[^0-9]/g, '');
  if (parsed.doc_type === 'birth_certificate') return digits.length !== 17;
  return digits.length !== 10 && digits.length !== 13 && digits.length !== 17;
}

function getOrderedGeminiModels(profile = 'accurate', preferredGeminiModel = 'gemini-3.1-flash-lite') {
  const pref = normalizeModelId(preferredGeminiModel);
  const validPref = pref.startsWith('gemini-') ? pref : 'gemini-3.1-flash-lite';
  let base;
  if (profile === 'flash38_only') {
    base = ['gemini-3.8-flash'];
  } else if (profile === 'lite_only') {
    base = validPref === 'gemini-3.5-flash-lite'
      ? ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']
      : ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
  } else if (profile === 'preferred') {
    base = [validPref, 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];
  } else {
    base = ['gemini-3.8-flash', validPref, 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
  }
  return Array.from(new Set(base));
}

function buildGeminiAttemptsForModels(models, apiKey, rawBase64, detectedMime, promptText) {
  const attempts = [];
  for (const model of models) {
    if (model === 'gemini-3.8-flash' || model === 'gemini-3.5-flash-lite') {
      const body = {
        model,
        input: [
          { type: 'text', text: promptText },
          { type: 'image', data: rawBase64, mime_type: detectedMime }
        ],
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: OCR_RESPONSE_SCHEMA
        },
        store: false
      };
      if (model === 'gemini-3.8-flash') body.generation_config = { thinking_level: 'low' };
      attempts.push({
        model,
        label: `${model} (interactions)`,
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
        generationConfig: { response_mime_type: 'application/json' }
      }
    });
  }
  return attempts;
}

async function callGeminiResilientOCR(apiKey, rawBase64, detectedMime, promptText, profile = 'accurate', preferredGeminiModel = 'gemini-3.1-flash-lite') {
  const modelsOrder = getOrderedGeminiModels(profile, preferredGeminiModel);
  const attempts = buildGeminiAttemptsForModels(modelsOrder, apiKey, rawBase64, detectedMime, promptText);

  let lastErrorMsg = 'Gemini API থেকে কোনো ফলাফল পাওয়া যায়নি।';

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
                image_url: { url: `data:${detectedMime};base64,${rawBase64}` }
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
  geminiModel = 'gemini-3.1-flash-lite',
  deepseekModel = 'deepseek-flash',
  geminiKey = '',
  deepseekKey = '',
  rawBase64,
  detectedMime,
  promptText
}) {
  let gKey = String(geminiKey || '').trim();
  let dKey = String(deepseekKey || '').trim();
  if (!dKey && /^sk-/i.test(gKey)) {
    dKey = gKey;
    gKey = '';
  }

  const mode = ['economy', 'auto', 'gemini', 'gemini_lite', 'deepseek'].includes(aiProvider) ? aiProvider : 'economy';
  const keySlot = ['auto', 'gemini', 'deepseek'].includes(defaultKeySlot) ? defaultKeySlot : 'auto';
  const prefGemModel = normalizeModelId(geminiModel).startsWith('gemini-') ? normalizeModelId(geminiModel) : 'gemini-3.1-flash-lite';

  if (mode === 'deepseek') {
    if (!dKey) throw new Error('DeepSeek API Key সেট করা নেই। সেটিংসে গিয়ে sk-... Key দিন।');
    return await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
  }

  if (mode === 'gemini_lite') {
    if (!gKey) throw new Error('Gemini API Key সেট করা নেই।');
    return await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'lite_only', prefGemModel);
  }

  if (mode === 'gemini') {
    if (!gKey) throw new Error('Gemini API Key সেট করা নেই।');
    return await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'preferred', prefGemModel);
  }

  const errors = [];
  const preferDeepSeekFirst = keySlot === 'deepseek' && Boolean(dKey);

  if (preferDeepSeekFirst) {
    try {
      const dsRes = await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
      if (mode === 'auto' || !needsAccurateEscalation(dsRes) || !gKey) return dsRes;
      try {
        return await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'preferred', prefGemModel);
      } catch (_) {
        return dsRes;
      }
    } catch (err) {
      errors.push(`DeepSeek: ${err.message}`);
    }
    if (gKey) {
      try {
        const gProfile = mode === 'economy' ? 'preferred' : 'accurate';
        return await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, gProfile, prefGemModel);
      } catch (err) {
        errors.push(`Gemini: ${err.message}`);
      }
    }
    throw new Error(errors.length ? errors.join(' | ') : 'Gemini বা DeepSeek API Key সেট করা নেই।');
  }

  // Economy mode: selected default Gemini model (or Flash-Lite) first, auto-escalates only if blurry/incomplete
  if (mode === 'economy') {
    if (gKey) {
      try {
        const firstProfile = prefGemModel === 'gemini-3.8-flash' ? 'accurate' : 'lite_only';
        const primaryRes = await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, firstProfile, prefGemModel);
        if (!needsAccurateEscalation(primaryRes) || prefGemModel === 'gemini-3.8-flash') return primaryRes;
        try {
          return await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'flash38_only', prefGemModel);
        } catch (escErr) {
          if (dKey) {
            try { return await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel); } catch (_) {}
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

  // Balanced auto mode: Gemini 3.8 Flash primary -> selected model/Lite fallback -> DeepSeek failover
  if (gKey) {
    try {
      return await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'accurate', prefGemModel);
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
  const geminiModel = req.geminiModel || stored.geminiModel || 'gemini-3.1-flash-lite';
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
    promptText
  });
  validateAndNormalizeOcrData(parsedData, { docType, maritalStatus, religion, mobileNumber });

  return {
    success: true,
    data: parsedData
  };
}

// Forward to backend server if user has a server configured
async function forwardToServer(serverUrl, imageBase64, mimeType, maritalStatus, religion, mobileNumber, docType = 'auto', aiProvider = 'economy', deepseekApiKey = '', geminiModel = 'gemini-3.1-flash-lite', deepseekModel = 'deepseek-flash', defaultKeySlot = 'auto') {
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
