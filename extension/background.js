// Background Service Worker for Family Card NID Auto-Filler
// Handles direct Gemini 3.8 Flash / 3.5 Flash-Lite AI OCR calls with Interactions API & generateContent fallback.

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

async function callGeminiResilientOCR(apiKey, rawBase64, detectedMime, promptText) {
  const attempts = [
    {
      label: 'gemini-3.8-flash (interactions)',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Api-Revision': '2026-05-20'
      },
      body: {
        model: 'gemini-3.8-flash',
        input: [
          { type: 'text', text: promptText },
          { type: 'image', data: rawBase64, mime_type: detectedMime }
        ],
        generation_config: { thinking_level: 'low' },
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: OCR_RESPONSE_SCHEMA
        },
        store: false
      }
    },
    {
      label: 'gemini-3.8-flash (generateContent)',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
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
    },
    {
      label: 'gemini-3.5-flash-lite (interactions)',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Api-Revision': '2026-05-20'
      },
      body: {
        model: 'gemini-3.5-flash-lite',
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
      }
    },
    {
      label: 'gemini-3.5-flash-lite (generateContent)',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
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
    }
  ];

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

  let apiKey = req.apiKey;
  if (!apiKey) {
    const stored = await chrome.storage.sync.get(['geminiApiKey', 'serverUrl']);
    apiKey = stored.geminiApiKey;
    if (!apiKey && stored.serverUrl) {
      return await forwardToServer(stored.serverUrl, imageBase64, mimeType, maritalStatus, religion, mobileNumber, docType);
    }
  }

  if (!apiKey) {
    throw new Error('Gemini API Key সেট করা নেই। এক্সটেনশন আইকনে ক্লিক করে API Key দিন।');
  }

  let detectedMime = mimeType;
  let rawBase64 = String(imageBase64 || '');
  const dataUriMatch = rawBase64.match(/^data:([^;]+);base64,(.+)$/s);
  if (dataUriMatch) {
    detectedMime = dataUriMatch[1] || detectedMime;
    rawBase64 = dataUriMatch[2];
  }

  const promptText = buildGeminiPrompt(docType);
  const parsedData = await callGeminiResilientOCR(apiKey, rawBase64, detectedMime, promptText);
  validateAndNormalizeOcrData(parsedData, { docType, maritalStatus, religion, mobileNumber });

  return {
    success: true,
    data: parsedData
  };
}

// Forward to backend server if user has a server configured
async function forwardToServer(serverUrl, imageBase64, mimeType, maritalStatus, religion, mobileNumber, docType = 'auto') {
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
      docType
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`সার্ভার এরর (${response.status}): ${errorText}`);
  }

  return await response.json();
}
