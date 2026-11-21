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
2. Bangladeshi Digital Birth Registration Certificates (ডিজিটাল জন্ম নিবন্ধন সনদপত্র / BRC, A4 printed, including older Bangla-only certificates / শুধু বাংলায় জন্ম নিবন্ধন সনদ).

${hintLine}

CRITICAL BILINGUAL RULE (BANGLA-ONLY BIRTH CERTIFICATES / শুধু বাংলায় সনদ):
- Many Bangladeshi Birth Registration Certificates and classic NIDs print names ONLY in Bengali (no English section).
- Even if English text is NOT printed on the document, you MUST STILL populate EVERY English field ("name_en", "father_name_en", "mother_name_en", "spouse_name_en") by accurately transliterating the Bengali names into standard Bangladeshi ALL-CAPS English spelling (e.g. "মোঃ" -> "MD.", "মোছাঃ" -> "MOSAMMAT", "রফিকুল ইসলাম" -> "RAFIQUL ISLAM").
- NEVER leave "name_en", "father_name_en", or "mother_name_en" blank when readable in Bengali, and NEVER copy Bengali Unicode into "*_en" fields.
- NEVER write "null", "None", or "N/A" as field values — use "" for absent fields.

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
3. "name_en": Full English name in ALL UPPERCASE letters (transliterate from Bengali if printed only in Bengali!).
4. "dob": Date of Birth in strict DD/MM/YYYY English digit format (e.g. "১২ই জানুয়ারি, ২০১২" -> "12/01/2012", "14/05/1988"). On Birth Certificates, use "জন্ম তারিখ / Date of Birth", NOT "নিবন্ধনের তারিখ / Date of Registration" or "সনদ প্রদানের তারিখ / Date of Issuance".
5. "gender": Strictly "পুরুষ" (Male), "নারী" (Female), or "হিজড়া" (Third Gender / Hijra). Infer accurately if not explicitly written on classic NID or Bangla-only BRC.
6. "father_name_bn" & "father_name_en": Extract ONLY from "পিতা:" / "পিতার নাম:" / "Father's Name". Transliterate to ALL UPPERCASE English if printed only in Bengali.
   CRITICAL FOR MARRIED WOMEN'S OLD LAMINATED NID: Many classic laminated NIDs for women print "স্বামী:" (Husband) instead of "পিতা:" (Father).
   NEVER put "স্বামী:" (Husband) into "father_name_bn" or "father_name_en"! Leave father fields "" if "পিতা:" is absent, and put husband's name in "spouse_name_bn" / "spouse_name_en".
7. "mother_name_bn" & "mother_name_en": Extract from "মাতা:" / "মাতার নাম:" / "Mother's Name". Transliterate to ALL UPPERCASE English if printed only in Bengali.
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

// Standardize Date of Birth (supports English & Bengali months/digits/ordinals) to DD/MM/YYYY
function standardizeDate(dobStr) {
  if (!dobStr) return '';
  let str = normalizeDigits(dobStr)
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/(\d{1,2})\s*(?:ইং|ই|শে|লা|রা|ঠা|st|nd|rd|th)(?=[\s,./\-\u0980-\u09FF])/gi, '$1 ')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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

  // Bengali month names: ১৪ মে ১৯৮৫ / ১২ই জানুয়ারি, ২০১২ / ০২-মার্চ-১৯৯০
  const bnMonthPrefixes = [
    ['জানু', '01'], ['ফেব', '02'], ['মার', '03'], ['এপ্রি', '04'],
    ['মে', '05'], ['জুন', '06'], ['জুল', '07'], ['আগ', '08'],
    ['সেপ', '09'], ['অক্ট', '10'], ['অক', '10'], ['নভ', '11'], ['ডিস', '12']
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
  const dmyMatch = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
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

const FIRESTORE_ERROR_LOGS_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/fc_error_logs';
const FIRESTORE_ROOMS_FALLBACK_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/room_channels';

function hasBengaliScript(str) {
  return /[\u0980-\u09FF]/.test(String(str || ''));
}

const BN_NAME_WORD_MAP = {
  'মোঃ': 'MD.', 'মো:': 'MD.', 'মো.': 'MD.', 'মোহাম্মদ': 'MOHAMMAD', 'মোহাম্মাদ': 'MOHAMMAD',
  'মোছাঃ': 'MOSAMMAT', 'মোছা:': 'MOSAMMAT', 'মোছা.': 'MOSAMMAT', 'মোসাম্মৎ': 'MOSAMMAT', 'মোসাম্মত': 'MOSAMMAT',
  'শ্রী': 'SRI', 'শ্রীমতী': 'SRIMOTI', 'শেখ': 'SHEIKH', 'সৈয়দ': 'SYED', 'সৈয়দ': 'SYED',
  'খন্দকার': 'KHANDAKER', 'চৌধুরী': 'CHOWDHURY', 'মজুমদার': 'MAJUMDER', 'তালুকদার': 'TALUKDER',
  'সরকার': 'SARKAR', 'মন্ডল': 'MONDAL', 'মণ্ডল': 'MONDAL', 'বিশ্বাস': 'BISWAS',
  'হোসেন': 'HOSSAIN', 'হোসাইন': 'HOSSAIN', 'ইসলাম': 'ISLAM', 'আহমেদ': 'AHMED',
  'আহম্মেদ': 'AHMED', 'আহমদ': 'AHMED', 'রহমান': 'RAHMAN', 'করিম': 'KARIM',
  'রহিম': 'RAHIM', 'আলী': 'ALI', 'আলি': 'ALI', 'খাতুন': 'KHATUN', 'বেগম': 'BEGUM',
  'আক্তার': 'AKTER', 'আখতার': 'AKTER', 'সুলতানা': 'SULTANA', 'জাহান': 'JAHAN',
  'ইয়াসমিন': 'YASMIN', 'ইয়াসমিন': 'YASMIN', 'পারভীন': 'PARVIN', 'পারভিন': 'PARVIN',
  'নাহার': 'NAHAR', 'রফিকুল': 'RAFIQUL', 'শফিকুল': 'SHAFIQUL', 'তরিকুল': 'TARIQUL',
  'আব্দুল': 'ABDUL', 'আবদুল': 'ABDUL', 'আব্দুর': 'ABDUR', 'আবদুর': 'ABDUR',
  'আব্দুল্লাহ': 'ABDULLAH', 'আবদুল্লাহ': 'ABDULLAH', 'আবু': 'ABU', 'হাসান': 'HASAN',
  'হাবিব': 'HABIB', 'কবির': 'KABIR', 'নজরুল': 'NAZRUL', 'কামাল': 'KAMAL',
  'জামাল': 'JAMAL', 'আলম': 'ALAM', 'মিয়া': 'MIA', 'মিয়া': 'MIA', 'মুন্সি': 'MUNSHI',
  'মুন্সী': 'MUNSHI', 'মোস্তফা': 'MOSTAFA', 'সালাম': 'SALAM', 'মজিদ': 'MAJID',
  'হাকিম': 'HAKIM', 'হালিম': 'HALIM', 'রশিদ': 'RASHID', 'লতিফ': 'LATIF',
  'জব্বার': 'JABBAR', 'সাত্তার': 'SATTAR', 'গফুর': 'GAFUR', 'মান্নান': 'MANNAN',
  'হান্নান': 'HANNAN', 'মনির': 'MONIR', 'মনিরুল': 'MONIRUL', 'নূর': 'NUR', 'নুর': 'NUR',
  'রুহুল': 'RUHUL', 'আমিন': 'AMIN', 'আমিনুল': 'AMINUL', 'শহীদ': 'SHAHID', 'শহিদ': 'SHAHID',
  'মাহমুদ': 'MAHMUD', 'রাসেল': 'RASEL', 'রিপন': 'RIPON', 'সজীব': 'SAJIB', 'সজিব': 'SAJIB',
  'তানভীর': 'TANVIR', 'তানভির': 'TANVIR', 'সাকিব': 'SAKIB', 'শাকিব': 'SAKIB',
  'আরিফ': 'ARIF', 'আশরাফ': 'ASHRAF', 'ফারুক': 'FARUK', 'ফজলুল': 'FAZLUL',
  'মশিউর': 'MOSHIUR', 'মাহবুব': 'MAHBUB', 'আনোয়ার': 'ANOWAR', 'আনোয়ার': 'ANOWAR',
  'দেলোয়ার': 'DELOWAR', 'দেলোয়ার': 'DELOWAR', 'মনোয়ার': 'MONOWAR', 'মনোয়ার': 'MONOWAR',
  'সরোয়ার': 'SAROWAR', 'সরোয়ার': 'SAROWAR', 'জাহাঙ্গীর': 'JAHANGIR', 'জাহাংগীর': 'JAHANGIR',
  'আলমগীর': 'ALAMGIR', 'শাহীন': 'SHAHIN', 'শাহিন': 'SHAHIN', 'শাহজাহান': 'SHAHJAHAN',
  'ইব্রাহিম': 'IBRAHIM', 'ইব্রাহীম': 'IBRAHIM', 'ইসমাইল': 'ISMAIL', 'ইউসুফ': 'YUSUF',
  'ইউনুস': 'YUNUS', 'ইয়াকুব': 'YAKUB', 'ইয়াকুব': 'YAKUB', 'সোলাইমান': 'SULAIMAN',
  'ফাতেমা': 'FATEMA', 'আয়েশা': 'AYESHA', 'আয়েশা': 'AYESHA', 'খাদিজা': 'KHADIJA',
  'মরিয়ম': 'MARIYAM', 'মরিয়ম': 'MARIYAM', 'সুমাইয়া': 'SUMAIYA', 'সুমাইয়া': 'SUMAIYA',
  'তাসনিম': 'TASNIM', 'নুসরাত': 'NUSRAT', 'শারমিন': 'SHARMIN', 'রোকসানা': 'ROKSANA',
  'সালমা': 'SALMA', 'হালিমা': 'HALIMA', 'সখিনা': 'SAKHINA', 'জামিলা': 'JAMILA',
  'আনোয়ারা': 'ANOWARA', 'আনোয়ারা': 'ANOWARA', 'মনোয়ারা': 'MONOWARA', 'মনোয়ারা': 'MONOWARA',
  'রেহানা': 'REHANA', 'শাহানা': 'SHAHANA', 'রুবিনা': 'RUBINA', 'শিরিন': 'SHIRIN',
  'লায়লা': 'LAYLA', 'লায়লা': 'LAYLA', 'রানী': 'RANI', 'রাণী': 'RANI', 'দেবী': 'DEVI',
  'দাস': 'DAS', 'পাল': 'PAL', 'রায়': 'ROY', 'রায়': 'ROY', 'সেন': 'SEN', 'ঘোষ': 'GHOSH',
  'দত্ত': 'DUTTA', 'হালদার': 'HALDER', 'মল্লিক': 'MALLICK', 'প্রামাণিক': 'PRAMANIK',
  'ফকির': 'FAKIR', 'মৃধা': 'MRIDHA', 'হাওলাদার': 'HOWLADER', 'সরদার': 'SARDAR',
  'খান': 'KHAN', 'উদ্দিন': 'UDDIN', 'উদ্দীন': 'UDDIN', 'আহসান': 'AHSAN', 'সাঈদ': 'SAID'
};

function transliterateBnWordToEn(word) {
  if (!word) return '';
  const nfc = String(word).normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!nfc) return '';
  if (BN_NAME_WORD_MAP[nfc]) return BN_NAME_WORD_MAP[nfc];
  const bare = nfc.replace(/[।,;:!?'"()\[\]]+/g, '');
  if (BN_NAME_WORD_MAP[bare]) return BN_NAME_WORD_MAP[bare];
  if (!hasBengaliScript(bare)) return normalizeDigits(bare).toUpperCase();

  const indVowels = { 'অ':'O', 'আ':'A', 'ই':'I', 'ঈ':'I', 'উ':'U', 'ঊ':'U', 'ঋ':'RI', 'এ':'E', 'ঐ':'OI', 'ও':'O', 'ঔ':'OU' };
  const kars = { 'া':'A', 'ি':'I', 'ী':'I', 'ু':'U', 'ূ':'U', 'ৃ':'RI', 'ে':'E', 'ৈ':'OI', 'ো':'O', 'ৌ':'OU' };
  const cons = {
    'ক':'K', 'খ':'KH', 'গ':'G', 'ঘ':'GH', 'ঙ':'NG', 'চ':'CH', 'ছ':'CHH', 'জ':'J', 'ঝ':'JH', 'ঞ':'N',
    'ট':'T', 'ঠ':'TH', 'ড':'D', 'ঢ':'DH', 'ণ':'N', 'ত':'T', 'থ':'TH', 'দ':'D', 'ধ':'DH', 'ন':'N',
    'প':'P', 'ফ':'F', 'ব':'B', 'ভ':'BH', 'ম':'M', 'য':'J', 'র':'R', 'ল':'L', 'শ':'SH', 'ষ':'SH', 'স':'S', 'হ':'H',
    'ড়':'R', 'ঢ়':'RH', 'য়':'Y', 'ৎ':'T'
  };
  let out = '';
  let i = 0;
  let lastHadExplicitVowel = true;
  while (i < bare.length) {
    const ch = bare[i];
    if (bare.slice(i, i + 3) === 'ক্ষ') {
      out += i === 0 ? 'KH' : 'KSH';
      i += 3;
      const nextCh = bare[i] || '';
      if (!kars[nextCh] && nextCh !== '্' && i < bare.length && cons[nextCh]) out += 'A';
      lastHadExplicitVowel = Boolean(kars[nextCh]);
      continue;
    }
    if (bare.slice(i, i + 3) === 'জ্ঞ') {
      out += 'GY';
      i += 3;
      const nextCh = bare[i] || '';
      if (!kars[nextCh] && nextCh !== '্' && i < bare.length && cons[nextCh]) out += 'A';
      lastHadExplicitVowel = Boolean(kars[nextCh]);
      continue;
    }
    if (indVowels[ch]) { out += indVowels[ch]; lastHadExplicitVowel = true; i++; continue; }
    if (kars[ch]) { out += kars[ch]; lastHadExplicitVowel = true; i++; continue; }
    if (ch === 'ং') { out += 'NG'; lastHadExplicitVowel = false; i++; continue; }
    if (ch === 'ঃ') { out += i === bare.length - 1 ? '' : 'H'; lastHadExplicitVowel = false; i++; continue; }
    if (ch === 'ঁ') { i++; continue; }
    if (ch === '্') {
      if (bare[i + 1] === 'য') { out += 'Y'; i += 2; continue; }
      if (bare[i + 1] === 'র') { out += 'R'; i += 2; continue; }
      lastHadExplicitVowel = true;
      i++;
      continue;
    }
    if (cons[ch]) {
      out += cons[ch];
      const nextCh = bare[i + 1] || '';
      if (!kars[nextCh] && nextCh !== '্' && nextCh !== 'ং' && nextCh !== 'ঃ' && ch !== 'ৎ') {
        if (i + 1 < bare.length && (cons[nextCh] || (!indVowels[nextCh] && i + 2 < bare.length)) && !(lastHadExplicitVowel === false && i > 0 && bare[i - 1] === 'া')) {
          out += 'A';
          lastHadExplicitVowel = false;
        }
      } else {
        lastHadExplicitVowel = Boolean(kars[nextCh]);
      }
      i++;
      continue;
    }
    out += /[A-Za-z0-9.]/.test(ch) ? ch.toUpperCase() : '';
    i++;
  }
  return out.replace(/AAA+/g, 'A').replace(/AA+/g, 'A').trim();
}

function transliterateBnToEn(bnText) {
  if (!bnText) return '';
  const cleaned = String(bnText).normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!cleaned) return '';
  if (!hasBengaliScript(cleaned)) return normalizeDigits(cleaned).toUpperCase().replace(/\s+/g, ' ').trim();
  return cleaned.split(/\s+/).map(transliterateBnWordToEn).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function cleanOcrFieldText(val) {
  if (val === null || val === undefined) return '';
  let s = String(val).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  if (!s || /^(null|none|n\/a|na|undefined|-|not\s+available|not\s+printed|নেই|প্রযোজ্য\s*নয়)$/i.test(s)) {
    return '';
  }
  s = s.replace(/^(?:নিবন্ধিত\s*ব্যক্তির\s*নাম|আবেদনকারীর\s*নাম|নাম\s*\(বাংলা\)|নাম\s*\(ইংরেজি\)|নাম|name(?:\s*\(in\s*english\))?|পিতার?\s*নাম|পিতা|father(?:'s)?\s*name|মাতার?\s*নাম|মাতা|mother(?:'s)?\s*name|স্বামী\s*\/\s*স্ত্রী(?:র\s*নাম)?|স্বামী(?:র\s*নাম)?|স্ত্রী(?:র\s*নাম)?|spouse(?:'s)?\s*name|husband(?:'s)?\s*name|wife(?:'s)?\s*name|জন্ম\s*তারিখ|date\s*of\s*birth|dob|id\s*no\.?|nid\s*no\.?|birth\s*registration\s*no\.?)\s*[:ঃ\-–]+\s*/i, '').trim();
  return s;
}

function normalizeOcrKeyAliases(rawObj) {
  let obj = rawObj;
  if (Array.isArray(obj)) obj = obj[0] || {};
  if (obj && typeof obj === 'object') {
    for (const wrapKey of ['data', 'result', 'extracted_data', 'ocr_data', 'output', 'response', 'document', 'fields']) {
      if (obj[wrapKey] && typeof obj[wrapKey] === 'object' && !Array.isArray(obj[wrapKey]) && !obj.name_bn && !obj.name_en && !obj.nid_number && !obj.birth_reg_no) {
        obj = obj[wrapKey];
        break;
      }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('AI থেকে প্রাপ্ত JSON ফরম্যাট পড়া যায়নি।');
  }
  const out = { ...obj };
  const pickAlias = (aliases) => {
    for (const k of aliases) {
      if (obj[k] !== undefined && obj[k] !== null) {
        const cleaned = cleanOcrFieldText(obj[k]);
        if (cleaned) return cleaned;
      }
    }
    return '';
  };

  if (!cleanOcrFieldText(out.doc_type)) {
    const dt = pickAlias(['document_type', 'docType', 'type']).toLowerCase();
    if (/birth|brc|নিবন্ধন/.test(dt)) out.doc_type = 'birth_certificate';
    else if (/nid|national|জাতীয়|জাতীয়/.test(dt)) out.doc_type = 'nid';
  }
  if (!cleanOcrFieldText(out.nid_number)) out.nid_number = pickAlias(['nid', 'nid_no', 'nidNo', 'nidNumber', 'national_id', 'national_id_no', 'id_no', 'id_number']);
  if (!cleanOcrFieldText(out.birth_reg_no)) out.birth_reg_no = pickAlias(['brc', 'brc_no', 'brcNo', 'brc_number', 'birth_reg', 'birth_reg_number', 'birth_registration_no', 'birth_registration_number', 'brn', 'registration_no', 'registration_number']);
  if (!cleanOcrFieldText(out.doc_number)) out.doc_number = pickAlias(['doc_no', 'docNumber', 'document_number', 'document_no', 'id']) || out.birth_reg_no || out.nid_number || '';

  if (!cleanOcrFieldText(out.name_bn)) out.name_bn = pickAlias(['nameBn', 'name_bangla', 'bangla_name', 'full_name_bn', 'applicant_name_bn']);
  if (!cleanOcrFieldText(out.name_en)) out.name_en = pickAlias(['nameEn', 'name_english', 'english_name', 'full_name_en', 'applicant_name_en']);
  const genericName = pickAlias(['name', 'full_name', 'applicant_name', 'registered_name']);
  if (genericName) {
    if (hasBengaliScript(genericName) && !cleanOcrFieldText(out.name_bn)) out.name_bn = genericName;
    else if (!hasBengaliScript(genericName) && !cleanOcrFieldText(out.name_en)) out.name_en = genericName;
  }

  for (const [prefix, genKeys] of [
    ['father', ['father_name', 'father', 'pita']],
    ['mother', ['mother_name', 'mother', 'mata']],
    ['spouse', ['spouse_name', 'spouse', 'husband_name', 'husband_name_bn', 'wife_name', 'wife_name_bn']]
  ]) {
    const camel = prefix[0].toUpperCase() + prefix.slice(1);
    if (!cleanOcrFieldText(out[`${prefix}_name_bn`])) out[`${prefix}_name_bn`] = pickAlias([`${prefix}NameBn`, `${prefix}_bn`, `${prefix}_name_bangla`, `${camel}NameBn`]);
    if (!cleanOcrFieldText(out[`${prefix}_name_en`])) out[`${prefix}_name_en`] = pickAlias([`${prefix}NameEn`, `${prefix}_en`, `${prefix}_name_english`, `${camel}NameEn`]);
    const genVal = pickAlias(genKeys);
    if (genVal) {
      if (hasBengaliScript(genVal) && !cleanOcrFieldText(out[`${prefix}_name_bn`])) out[`${prefix}_name_bn`] = genVal;
      else if (!hasBengaliScript(genVal) && !cleanOcrFieldText(out[`${prefix}_name_en`])) out[`${prefix}_name_en`] = genVal;
    }
  }

  if (!cleanOcrFieldText(out.dob)) out.dob = pickAlias(['date_of_birth', 'birth_date', 'dob_en', 'dob_bn', 'dateOfBirth']);
  if (!cleanOcrFieldText(out.gender)) out.gender = pickAlias(['sex', 'gender_bn', 'gender_en', 'lingo']);
  if (!cleanOcrFieldText(out.marital_status_suggestion)) out.marital_status_suggestion = pickAlias(['marital_status', 'maritalStatus', 'marital']);
  if (!cleanOcrFieldText(out.relation_suggestion)) out.relation_suggestion = pickAlias(['relation', 'relationship', 'relation_to_head']);

  for (const k of [
    'doc_type', 'doc_number', 'nid_number', 'birth_reg_no',
    'name_bn', 'name_en', 'dob', 'gender',
    'father_name_bn', 'father_name_en', 'mother_name_bn', 'mother_name_en',
    'spouse_name_bn', 'spouse_name_en', 'relation_suggestion',
    'marital_status_suggestion', 'confidence'
  ]) {
    out[k] = cleanOcrFieldText(out[k] ?? '');
  }
  if (!['high', 'medium', 'low'].includes(String(out.confidence || '').toLowerCase())) {
    out.confidence = out.name_bn && out.doc_number && out.dob ? 'medium' : 'low';
  } else {
    out.confidence = String(out.confidence).toLowerCase();
  }
  return out;
}

function needsIntelligentCompletion(data = {}) {
  if (!data || typeof data !== 'object') return false;
  const pairsMissing = [
    ['name_bn', 'name_en'],
    ['father_name_bn', 'father_name_en'],
    ['mother_name_bn', 'mother_name_en'],
    ['spouse_name_bn', 'spouse_name_en']
  ].some(([bnK, enK]) => {
    const bn = cleanOcrFieldText(data[bnK] || '');
    const en = cleanOcrFieldText(data[enK] || '');
    return (Boolean(bn) && (!en || hasBengaliScript(en))) || (Boolean(en) && !bn);
  });
  if (pairsMissing) return true;
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(standardizeDate(data.dob || ''))) return true;
  const normG = typeof normalizeGenderValue === 'function' ? normalizeGenderValue(data.gender || '') : String(data.gender || '').trim();
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(normG)) return true;
  if (!cleanOcrFieldText(data.marital_status_suggestion) && (cleanOcrFieldText(data.spouse_name_bn) || cleanOcrFieldText(data.dob))) return true;
  return false;
}

function needsEnglishCompletion(data = {}) {
  return needsIntelligentCompletion(data);
}

async function logBackendErrorToFirebase(entry = {}) {
  try {
    if (typeof fetch !== 'function') return;
    const nowMs = Date.now();
    const id = `extbg_${nowMs}_${Math.random().toString(36).slice(2, 7)}`;
    const fields = {
      id: { stringValue: id },
      source: { stringValue: String(entry.source || 'extension-background').slice(0, 60) },
      level: { stringValue: String(entry.level || 'error').slice(0, 20) },
      stage: { stringValue: String(entry.stage || 'ocr').slice(0, 80) },
      message: { stringValue: String(entry.message || '').slice(0, 800) },
      detail: { stringValue: String(entry.detail || '').slice(0, 1500) },
      model: { stringValue: String(entry.model || '').slice(0, 80) },
      ts: { integerValue: String(nowMs) },
      createdAt: { stringValue: new Date(nowMs).toISOString() }
    };
    const res = await fetch(`${FIRESTORE_ERROR_LOGS_BASE}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    }).catch(() => null);
    if (!res || res.status === 403 || !res.ok) {
      await fetch(`${FIRESTORE_ROOMS_FALLBACK_BASE}/FC_SYSTEM_LOGS/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            id: { stringValue: id },
            room: { stringValue: 'FC_SYSTEM_LOGS' },
            type: { stringValue: 'system' },
            text: { stringValue: `[${entry.level || 'error'}][${entry.source || 'extension-bg'}] ${entry.message || ''}`.slice(0, 800) },
            payloadJson: { stringValue: JSON.stringify({ ...entry, id, ts: nowMs }) },
            senderName: { stringValue: String(entry.source || 'extension-background') },
            senderClient: { stringValue: 'extension' },
            senderId: { stringValue: 'ext_bg' },
            replyToJson: { stringValue: '' },
            ts: { integerValue: String(nowMs) },
            createdAt: { stringValue: new Date(nowMs).toISOString() }
          }
        })
      }).catch(() => {});
    }
  } catch (_) {}
}

function parseOcrJsonText(textOutput) {
  if (textOutput && typeof textOutput === 'object') {
    return normalizeOcrKeyAliases(textOutput);
  }
  const raw = String(textOutput || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let cleanText = fenceMatch ? fenceMatch[1].trim() : raw;
  const objStart = cleanText.indexOf('{');
  const objEnd = cleanText.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    cleanText = cleanText.slice(objStart, objEnd + 1);
  } else if (objStart !== -1) {
    cleanText = cleanText.slice(objStart);
  }
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch (_) { return null; }
  };
  let parsed = tryParse(cleanText);
  if (!parsed) {
    let repaired = cleanText
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/:\s*'([^']*)'/g, ': "$1"')
      .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    if (openBraces > closeBraces) {
      repaired = repaired.replace(/,\s*$/, '') + '}'.repeat(openBraces - closeBraces);
    }
    parsed = tryParse(repaired);
  }
  if (!parsed || typeof parsed !== 'object') {
    const fallback = {};
    const keys = [
      'doc_type', 'doc_number', 'nid_number', 'birth_reg_no',
      'name_bn', 'name_en', 'dob', 'gender',
      'father_name_bn', 'father_name_en', 'mother_name_bn', 'mother_name_en',
      'spouse_name_bn', 'spouse_name_en', 'relation_suggestion',
      'marital_status_suggestion', 'confidence'
    ];
    for (const k of keys) {
      const m = cleanText.match(new RegExp(`["']?${k}["']?\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([0-9]+))`, 'i'));
      if (m) fallback[k] = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    }
    if (Object.keys(fallback).length > 0) {
      fallback._json_repaired = true;
      parsed = fallback;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI থেকে প্রাপ্ত JSON ফরম্যাট পড়া যায়নি।');
  }
  return normalizeOcrKeyAliases(parsed);
}

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const INTERACTIONS_API_MODELS = new Set(['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon']);
const GENDER_ALIAS_MAP = {
  'তৃতীয় লিঙ্গ': 'হিজড়া', 'তৃতীয় লিঙ্গ': 'হিজড়া', 'হিজড়া': 'হিজড়া', 'হিজড়া': 'হিজড়া',
  'third gender': 'হিজড়া', 'hijra': 'হিজড়া', 'other': 'হিজড়া',
  'male': 'পুরুষ', 'm': 'পুরুষ', 'man': 'পুরুষ', 'পুরুষ': 'পুরুষ', 'ছেলে': 'পুরুষ',
  'female': 'নারী', 'f': 'নারী', 'woman': 'নারী', 'নারী': 'নারী', 'মহিলা': 'নারী', 'মেয়ে': 'নারী', 'মেয়ে': 'নারী'
};

function normalizeGenderValue(gender) {
  const g = String(gender || '').trim();
  if (!g) return '';
  if (GENDER_ALIAS_MAP[g]) return GENDER_ALIAS_MAP[g];
  const low = g.toLowerCase();
  if (GENDER_ALIAS_MAP[low]) return GENDER_ALIAS_MAP[low];
  if (/নারী|মহিলা|female/i.test(g)) return 'নারী';
  if (/পুরুষ|male/i.test(g)) return 'পুরুষ';
  if (/হিজ|তৃতীয়|তৃতীয়|third|hijra/i.test(g)) return 'হিজড়া';
  return g;
}

function inferBangladeshiGender(data = {}) {
  const norm = normalizeGenderValue(data.gender || '');
  if (['পুরুষ', 'নারী', 'হিজড়া'].includes(norm)) return norm;
  const nameBn = String(data.name_bn || '').normalize('NFC').trim();
  const nameEn = String(data.name_en || '').toUpperCase().trim();
  const rel = String(data.relation_suggestion || '').trim();
  if (rel === 'স্ত্রী' || rel === 'মাতা' || rel === 'কন্যা' || rel === 'বোন') return 'নারী';
  if (rel === 'স্বামী' || rel === 'পিতা' || rel === 'পুত্র' || rel === 'ভাই') return 'পুরুষ';
  if (/(?:^|\s)(?:মোছাঃ|মোছা:|মোসাম্মৎ|মোসাম্মত|শ্রীমতী|বেগম|খাতুন|আক্তার|আখতার|সুলতানা|পারভীন|পারভিন|নাহার|ইয়াসমিন|ইয়াসমিন|রানী|রাণী|দেবী|ফাতেমা|আয়েশা|আয়েশা|খাদিজা|মরিয়ম|মরিয়ম|সুমাইয়া|সুমাইয়া|সালমা|হালিমা|সখিনা|রেহানা|রোকসানা|বিবি)(?:\s|$)/.test(nameBn)
    || /\b(?:MOSAMMAT|MST\.?|BEGUM|KHATUN|AKTER|AKHTAR|SULTANA|PARVIN|NAHAR|YASMIN|RANI|DEVI|FATEMA|AYESHA|KHADIJA|MARIYAM|SUMAIYA|BIBI)\b/.test(nameEn)) {
    return 'নারী';
  }
  if ((/(?:^|\s)(?:মোঃ|মো:|মোহাম্মদ|মোহাম্মাদ|শ্রী|আব্দুল|আবদুল|আব্দুর|আবদুর|আবু)(?:\s|$)/.test(nameBn)
      || /(?:^|\s)(?:উদ্দিন|উদ্দীন)(?:\s|$)/.test(nameBn)
      || /\b(?:MD\.?|MOHAMMAD|ABDUL|ABDUR|ABU|UDDIN)\b/.test(nameEn))
    && !data.spouse_name_bn) {
    return 'পুরুষ';
  }
  return '';
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

  for (const k of ['name_bn', 'name_en', 'father_name_bn', 'father_name_en', 'mother_name_bn', 'mother_name_en', 'spouse_name_bn', 'spouse_name_en', 'dob', 'gender', 'relation_suggestion', 'marital_status_suggestion']) {
    if (parsedData[k] !== undefined && parsedData[k] !== null) {
      parsedData[k] = cleanOcrFieldText(parsedData[k]);
    } else {
      parsedData[k] = '';
    }
  }

  for (const [bnKey, enKey] of [
    ['name_bn', 'name_en'],
    ['father_name_bn', 'father_name_en'],
    ['mother_name_bn', 'mother_name_en'],
    ['spouse_name_bn', 'spouse_name_en']
  ]) {
    const bnV = String(parsedData[bnKey] || '').trim();
    const enV = String(parsedData[enKey] || '').trim();
    if (!bnV && hasBengaliScript(enV)) {
      parsedData[bnKey] = enV;
      parsedData[enKey] = '';
    } else if (bnV && !hasBengaliScript(bnV) && !enV) {
      parsedData[enKey] = bnV.toUpperCase();
      parsedData[bnKey] = '';
    }
  }

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
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(parsedData.gender || '').trim())) {
    const infG = inferBangladeshiGender(parsedData);
    if (infG) {
      parsedData.gender = infG;
      parsedData.gender_inferred = true;
    }
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

  const enAutoFilled = [];
  for (const [bnKey, enKey] of [
    ['name_bn', 'name_en'],
    ['father_name_bn', 'father_name_en'],
    ['mother_name_bn', 'mother_name_en'],
    ['spouse_name_bn', 'spouse_name_en']
  ]) {
    const bnVal = String(parsedData[bnKey] || '').trim();
    const enVal = String(parsedData[enKey] || '').trim();
    if (bnVal && (!enVal || hasBengaliScript(enVal))) {
      const tr = transliterateBnToEn(bnVal);
      if (tr) {
        parsedData[enKey] = tr;
        enAutoFilled.push(enKey);
      }
    }
  }
  if (enAutoFilled.length > 0) {
    parsedData.auto_transliterated_en = true;
    warnings.push('বাংলা-অনলি সনদ থেকে ইংরেজি নাম স্বয়ংক্রিয়ভাবে রূপান্তর করা হয়েছে — বানান যাচাই করুন।');
  }

  if (!parsedData.marital_status_suggestion) {
    if (parsedData.spouse_name_bn || parsedData.spouse_name_en) {
      parsedData.marital_status_suggestion = 'বিবাহিত';
    } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(String(parsedData.dob || ''))) {
      const yr = parseInt(String(parsedData.dob).slice(-4), 10);
      if (yr && (new Date().getFullYear() - yr) <= 18) parsedData.marital_status_suggestion = 'অবিবাহিত';
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

  const missingFields = [];
  if (!String(parsedData.name_bn || '').trim()) missingFields.push('name_bn');
  if (!String(parsedData.name_en || '').trim() || hasBengaliScript(parsedData.name_en)) missingFields.push('name_en');
  const validDoc = parsedData.doc_type === 'birth_certificate'
    ? String(parsedData.birth_reg_no || '').length === 17
    : [10, 17].includes(String(parsedData.nid_number || '').length);
  if (!validDoc) missingFields.push('doc_number');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(parsedData.dob || ''))) missingFields.push('dob');
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(parsedData.gender || '').trim())) missingFields.push('gender');
  if (!String(parsedData.mother_name_bn || '').trim() && !String(parsedData.mother_name_en || '').trim()) missingFields.push('mother_name');
  if (!String(parsedData.father_name_bn || '').trim() && !String(parsedData.father_name_en || '').trim() && !String(parsedData.spouse_name_bn || '').trim() && !String(parsedData.spouse_name_en || '').trim()) {
    missingFields.push('father_or_spouse');
  }
  const totalCore = 7;
  const filledCore = Math.max(0, totalCore - missingFields.length);
  parsedData.ocr_completeness = {
    valid: missingFields.length === 0,
    scorePct: Math.round((filledCore / totalCore) * 100),
    filledCore,
    totalCore,
    missingFields,
    repaired: Boolean(parsedData.auto_transliterated_en || parsedData.deepseek_en_completed || parsedData._json_repaired || parsedData.gender_inferred)
  };

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

async function completeBanglaOnlyOcrWithDeepSeek(deepseekKey, partialData, preferredModel = 'deepseek-chat') {
  if (!deepseekKey || !partialData || !needsIntelligentCompletion(partialData)) return partialData;
  const models = preferredModel === 'deepseek-flash'
    ? ['deepseek-flash', 'deepseek-chat']
    : ['deepseek-chat', 'deepseek-flash'];
  const compPrompt = `Complete and verify ALL fields in this Bangladeshi NID / Birth Certificate OCR JSON using your intelligence.
Rules:
1. If any Bengali field (*_bn) is readable and its English counterpart (*_en) is blank or contains Bengali, accurately translate/transliterate it into standard Bangladeshi ALL-CAPS English spelling (e.g. "মোঃ" -> "MD.", "মোছাঃ" -> "MOSAMMAT", "রফিকুল ইসলাম" -> "RAFIQUL ISLAM").
2. If any English field (*_en) is present and its Bengali counterpart (*_bn) is blank, provide accurate Bangladeshi Bengali spelling (*_bn) (e.g. "MD." -> "মোঃ", "MOSAMMAT" -> "মোছাঃ").
3. Ensure "dob" is strict ASCII "DD/MM/YYYY", infer "gender" ("পুরুষ" or "নারী" or "হিজড়া") from names/context if missing, and provide sensible "marital_status_suggestion" ("বিবাহিত"/"অবিবাহিত") and "relation_suggestion".
4. Never return "null", "N/A", label prefixes like "নাম:", or Bengali characters inside *_en.
Return ONLY one valid JSON object with keys: name_bn, name_en, father_name_bn, father_name_en, mother_name_bn, mother_name_en, spouse_name_bn, spouse_name_en, dob, gender, marital_status_suggestion, relation_suggestion, doc_type.
Input JSON:
${JSON.stringify({
  doc_type: partialData.doc_type || '',
  doc_number: partialData.doc_number || partialData.nid_number || partialData.birth_reg_no || '',
  name_bn: partialData.name_bn || '',
  name_en: partialData.name_en || '',
  father_name_bn: partialData.father_name_bn || '',
  father_name_en: partialData.father_name_en || '',
  mother_name_bn: partialData.mother_name_bn || '',
  mother_name_en: partialData.mother_name_en || '',
  spouse_name_bn: partialData.spouse_name_bn || '',
  spouse_name_en: partialData.spouse_name_en || '',
  dob: partialData.dob || '',
  gender: partialData.gender || '',
  relation_suggestion: partialData.relation_suggestion || '',
  marital_status_suggestion: partialData.marital_status_suggestion || ''
})}`;

  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${deepseekKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are an expert Bangladeshi identity document specialist. Output ONLY one valid JSON object completing both Bengali (*_bn) and ALL-CAPS English (*_en) fields cleanly.' },
            { role: 'user', content: compPrompt }
          ],
          response_format: { type: 'json_object' },
          max_tokens: 1024
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) continue;
      const resData = await response.json().catch(() => ({}));
      const content = resData?.choices?.[0]?.message?.content;
      if (!content) continue;
      const completed = parseOcrJsonText(content);
      const out = { ...partialData };
      for (const k of ['name_en', 'father_name_en', 'mother_name_en', 'spouse_name_en']) {
        const cur = cleanOcrFieldText(out[k] || '');
        const cand = cleanOcrFieldText(completed[k] || '');
        if ((!cur || hasBengaliScript(cur)) && cand && !hasBengaliScript(cand)) {
          out[k] = cand.toUpperCase();
        }
      }
      for (const k of ['name_bn', 'father_name_bn', 'mother_name_bn', 'spouse_name_bn']) {
        const cur = cleanOcrFieldText(out[k] || '');
        const cand = cleanOcrFieldText(completed[k] || '');
        if (!cur && cand && hasBengaliScript(cand)) {
          out[k] = cand;
        }
      }
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(standardizeDate(out.dob || '')) && completed.dob) {
        const std = standardizeDate(completed.dob);
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(std)) out.dob = std;
      }
      if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(normalizeGenderValue(out.gender)) && completed.gender) {
        const ng = normalizeGenderValue(completed.gender);
        if (['পুরুষ', 'নারী', 'হিজড়া'].includes(ng)) out.gender = ng;
      }
      if (!cleanOcrFieldText(out.marital_status_suggestion) && cleanOcrFieldText(completed.marital_status_suggestion)) {
        out.marital_status_suggestion = cleanOcrFieldText(completed.marital_status_suggestion);
      }
      if (!cleanOcrFieldText(out.relation_suggestion) && cleanOcrFieldText(completed.relation_suggestion)) {
        out.relation_suggestion = cleanOcrFieldText(completed.relation_suggestion);
      }
      if (resData?.usage) {
        const addCost = computeScanUsageAndCost(model, resData);
        if (out.ocr_usage) {
          out.ocr_usage = {
            ...out.ocr_usage,
            inputTokens: (out.ocr_usage.inputTokens || 0) + (addCost.inputTokens || 0),
            outputTokens: (out.ocr_usage.outputTokens || 0) + (addCost.outputTokens || 0),
            totalTokens: (out.ocr_usage.totalTokens || 0) + (addCost.totalTokens || 0),
            costUsd: Number(((out.ocr_usage.costUsd || 0) + (addCost.costUsd || 0)).toFixed(7)),
            costBdt: Number(((out.ocr_usage.costBdt || 0) + (addCost.costBdt || 0)).toFixed(4))
          };
        } else {
          out.ocr_usage = addCost;
        }
      }
      out.deepseek_en_completed = model;
      return out;
    } catch (_) {
      clearTimeout(timer);
    }
  }
  return partialData;
}

async function callDeepSeekVisionOCR(deepseekKey, rawBase64, detectedMime, promptText, deepseekModel = 'deepseek-flash') {
  const prefModel = normalizeModelId(deepseekModel) === 'deepseek-flash' ? 'deepseek-flash' : 'deepseek-chat';
  const modelCandidates = Array.from(new Set([prefModel, 'deepseek-chat', 'deepseek-flash']));
  let lastErr = 'DeepSeek API থেকে কোনো ফলাফল পাওয়া যায়নি।';

  for (const targetModel of modelCandidates) {
    for (const useJsonMode of [true, false]) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const payload = {
          model: targetModel,
          messages: [
            {
              role: 'system',
              content: 'You are an expert Bangladeshi NID and Birth Certificate OCR engine. Even if a Birth Certificate is printed ONLY in Bengali, ALWAYS populate BOTH *_bn AND ALL-CAPS transliterated English *_en fields in one single valid JSON object.'
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
          max_tokens: 2048
        };
        if (useJsonMode) payload.response_format = { type: 'json_object' };

        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${deepseekKey}`
          },
          body: JSON.stringify(payload),
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
          lastErr = `${targetModel}: DeepSeek API (${response.status}): ${msg}`;
          if (useJsonMode && /response_format/i.test(msg)) continue;
          break;
        }

        const content = resData?.choices?.[0]?.message?.content;
        if (!content) {
          lastErr = `${targetModel}: DeepSeek API থেকে কোনো উত্তর পাওয়া যায়নি।`;
          break;
        }

        let parsed = parseOcrJsonText(content);
        parsed.ocr_model_used = `${targetModel} (api.deepseek.com)`;
        parsed.ocr_usage = computeScanUsageAndCost(targetModel, resData);
        if (needsEnglishCompletion(parsed)) {
          parsed = await completeBanglaOnlyOcrWithDeepSeek(deepseekKey, parsed, targetModel);
        }
        return parsed;
      } catch (err) {
        clearTimeout(timer);
        if (/Key সঠিক নয়|ব্যালেন্স শেষ/.test(err.message || '')) throw err;
        lastErr = err.name === 'AbortError' ? `${targetModel}: DeepSeek OCR সময় শেষ হয়েছে (Timeout)` : `${targetModel}: ${err.message}`;
        break;
      }
    }
  }

  const finalErr = new Error(lastErr);
  if (/image_url|multimodal|vision|deserialize|unknown variant/i.test(lastErr)) {
    finalErr.isVisionUnsupported = true;
  }
  throw finalErr;
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
  docType = 'auto',
  onProgress = null
}) {
  const emit = (pct, stage) => {
    try { if (typeof onProgress === 'function') onProgress(pct, stage); } catch (_) {}
  };
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

  const finalizeWithDeepSeekIfNeeded = async (resObj) => {
    if (dKey && needsEnglishCompletion(resObj)) {
      emit(82, 'বাংলা সনদের ইংরেজি নাম রূপান্তর হচ্ছে (DeepSeek)...');
      return await completeBanglaOnlyOcrWithDeepSeek(dKey, resObj, deepseekModel);
    }
    return resObj;
  };

  if (mode === 'deepseek') {
    if (!dKey) throw new Error('DeepSeek API Key সেট করা নেই। সেটিংসে গিয়ে sk-... Key দিন।');
    emit(35, 'DeepSeek Vision দিয়ে ডকুমেন্ট বিশ্লেষণ চলছে...');
    try {
      const dsRes = await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
      return await finalizeWithDeepSeekIfNeeded(dsRes);
    } catch (dsErr) {
      if (dsErr.isVisionUnsupported && gKey) {
        emit(55, 'DeepSeek ইমেজ সাপোর্ট সীমিত — Gemini Vision + DeepSeek JSON-এ রূপান্তর চলছে...');
        const gRes = await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'preferred', prefGemModel, { docType });
        const mergedRes = await completeBanglaOnlyOcrWithDeepSeek(dKey, gRes, deepseekModel);
        mergedRes.ocr_model_used = `${gRes.ocr_model_used || 'gemini'} + DeepSeek`;
        return mergedRes;
      }
      if (dsErr.isVisionUnsupported) {
        throw new Error(`DeepSeek API সরাসরি ইমেজ OCR (image_url) সাপোর্ট করে না — অনুগ্রহ করে Gemini API Key যুক্ত করুন, তাহলে Gemini ছবি পড়ে DeepSeek-এর বুদ্ধিমত্তায় সম্পূর্ণ বাংলা ও ইংরেজি JSON তৈরি করবে। (${dsErr.message})`);
      }
      throw dsErr;
    }
  }

  if (mode === 'gemini_lite') {
    if (!gKey) throw new Error('Gemini API Key সেট করা নেই।');
    emit(35, 'Gemini Lite মডেল দিয়ে ডকুমেন্ট বিশ্লেষণ চলছে...');
    return await finalizeWithDeepSeekIfNeeded(await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'lite_only', prefGemModel, { docType }));
  }

  if (mode === 'gemini') {
    if (!gKey) throw new Error('Gemini API Key সেট করা নেই।');
    emit(35, `${prefGemModel} দিয়ে ডকুমেন্ট বিশ্লেষণ চলছে...`);
    return await finalizeWithDeepSeekIfNeeded(await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'preferred', prefGemModel, { docType }));
  }

  const errors = [];
  const preferDeepSeekFirst = keySlot === 'deepseek' && Boolean(dKey);

  if (preferDeepSeekFirst) {
    emit(35, 'DeepSeek দিয়ে ডকুমেন্ট বিশ্লেষণ চলছে...');
    try {
      const dsRes = await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
      if (mode === 'auto' || !needsAccurateEscalation(dsRes, docType) || !gKey) return await finalizeWithDeepSeekIfNeeded(dsRes);
      try {
        emit(72, 'নিখুঁত ফলাফলের জন্য Gemini দিয়ে ক্রস-চেক হচ্ছে...');
        const escRes = await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'preferred', prefGemModel, { docType, isEscalation: true });
        return await finalizeWithDeepSeekIfNeeded(mergeOcrResults(dsRes, escRes, docType));
      } catch (_) {
        return await finalizeWithDeepSeekIfNeeded(dsRes);
      }
    } catch (err) {
      errors.push(`DeepSeek: ${err.message}`);
    }
    if (gKey) {
      try {
        emit(65, 'Gemini ব্যাকআপ মডেলে ডকুমেন্ট বিশ্লেষণ চলছে...');
        const gProfile = mode === 'economy' ? 'preferred' : 'accurate';
        return await finalizeWithDeepSeekIfNeeded(await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, gProfile, prefGemModel, { docType }));
      } catch (err) {
        errors.push(`Gemini: ${err.message}`);
      }
    }
    throw new Error(errors.length ? errors.join(' | ') : 'Gemini বা DeepSeek API Key সেট করা নেই।');
  }

  // Economy mode: selected default Gemini model (3.5 Flash-Lite) first, auto-escalates & merges when blurry/incomplete
  if (mode === 'economy') {
    if (gKey) {
      emit(35, 'প্রাথমিক OCR স্ক্যান চলছে...');
      try {
        const isFlagship = prefGemModel === 'gemini-3.8-flash' || prefGemModel === 'gemini-4-argon';
        const firstProfile = isFlagship ? 'preferred' : 'lite_only';
        const primaryRes = await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, firstProfile, prefGemModel, { docType });
        if (!needsAccurateEscalation(primaryRes, docType) || prefGemModel === 'gemini-3.8-flash') return await finalizeWithDeepSeekIfNeeded(primaryRes);
        try {
          emit(70, 'তথ্য আরও নিখুঁত করতে Gemini 3.8 Flash দিয়ে যাচাই চলছে...');
          const escRes = await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'flash38_only', prefGemModel, { docType, isEscalation: true });
          return await finalizeWithDeepSeekIfNeeded(mergeOcrResults(primaryRes, escRes, docType));
        } catch (escErr) {
          if (dKey) {
            try {
              emit(80, 'DeepSeek দিয়ে অতিরিক্ত তথ্য সংগ্রহ চলছে...');
              const dsEsc = await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
              return await finalizeWithDeepSeekIfNeeded(mergeOcrResults(primaryRes, dsEsc, docType));
            } catch (_) {}
          }
          return await finalizeWithDeepSeekIfNeeded(primaryRes);
        }
      } catch (err) {
        errors.push(`Gemini: ${err.message}`);
      }
    }
    if (dKey) {
      try {
        emit(72, 'DeepSeek ব্যাকআপ OCR চলছে...');
        return await finalizeWithDeepSeekIfNeeded(await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel));
      } catch (err) {
        errors.push(`DeepSeek: ${err.message}`);
      }
    }
    throw new Error(errors.length ? errors.join(' | ') : 'Gemini বা DeepSeek API Key সেট করা নেই।');
  }

  // Balanced auto mode: Gemini 3.8 Flash (or 4 Argon) primary -> selected model/Lite fallback -> DeepSeek failover
  if (gKey) {
    emit(40, 'সর্বোচ্চ মানের Gemini OCR চলছে...');
    try {
      return await finalizeWithDeepSeekIfNeeded(await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'accurate', prefGemModel, { docType, isEscalation: docType === 'birth_certificate' }));
    } catch (err) {
      errors.push(`Gemini: ${err.message}`);
    }
  }
  if (dKey) {
    try {
      emit(75, 'DeepSeek ব্যাকআপ OCR চলছে...');
      return await finalizeWithDeepSeekIfNeeded(await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel));
    } catch (err) {
      errors.push(`DeepSeek: ${err.message}`);
    }
  }

  throw new Error(errors.length ? errors.join(' | ') : 'Gemini বা DeepSeek API Key সেট করা নেই।');
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'ocr_nid_direct') {
      handleDirectOCR(req, sender)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ success: false, error: err.message || 'Unknown OCR Error' }));
      return true;
    }
    if (req.action === 'log_error_firebase') {
      logBackendErrorToFirebase(req.entry || {}).then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
      return true;
    }
  });
}

async function handleDirectOCR(req, sender = null) {
  const { imageBase64, mimeType = 'image/jpeg', maritalStatus = 'বিবাহিত', religion = 'ইসলাম', mobileNumber = '', docType = 'auto' } = req;
  const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
  const notifyProgress = (pct, stage) => {
    try {
      if (tabId !== null && typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.sendMessage) {
        chrome.tabs.sendMessage(tabId, { action: 'ocr_progress', pct, stage }).catch(() => {});
      }
    } catch (_) {}
  };

  try {
    notifyProgress(15, 'AI কনফিগারেশন ও ছবি প্রস্তুত হচ্ছে...');
    const stored = await chrome.storage.sync.get(['aiProvider', 'geminiModel', 'deepseekModel', 'defaultKeySlot', 'geminiApiKey', 'deepseekApiKey', 'serverUrl']);
    const aiProvider = req.aiProvider || stored.aiProvider || 'economy';
    const geminiModel = req.geminiModel || stored.geminiModel || DEFAULT_GEMINI_MODEL;
    const deepseekModel = req.deepseekModel || stored.deepseekModel || 'deepseek-flash';
    const defaultKeySlot = req.defaultKeySlot || stored.defaultKeySlot || 'auto';
    const apiKey = req.apiKey || stored.geminiApiKey || '';
    const deepseekApiKey = req.deepseekApiKey || stored.deepseekApiKey || '';

    if (!apiKey && !deepseekApiKey && stored.serverUrl) {
      notifyProgress(45, 'সার্ভারে ডকুমেন্ট পাঠানো হচ্ছে...');
      const srvRes = await forwardToServer(stored.serverUrl, imageBase64, mimeType, maritalStatus, religion, mobileNumber, docType, aiProvider, deepseekApiKey, geminiModel, deepseekModel, defaultKeySlot);
      notifyProgress(100, 'স্ক্যান সম্পন্ন!');
      return srvRes;
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
      docType,
      onProgress: notifyProgress
    });
    notifyProgress(92, 'তথ্য যাচাই ও ইংরেজি নাম সমন্বয় করা হচ্ছে...');
    validateAndNormalizeOcrData(parsedData, { docType, maritalStatus, religion, mobileNumber });
    notifyProgress(100, 'ডকুমেন্ট বিশ্লেষণ সম্পন্ন!');

    return {
      success: true,
      data: parsedData
    };
  } catch (err) {
    logBackendErrorToFirebase({
      source: 'extension-background',
      level: 'error',
      stage: 'handleDirectOCR',
      message: err.message || 'Unknown OCR error',
      detail: `docType=${docType}`
    });
    throw err;
  }
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
