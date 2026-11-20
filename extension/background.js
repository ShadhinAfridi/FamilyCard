// Background Service Worker for Family Card NID Auto-Filler
// Handles direct Gemini 2.0 Flash AI OCR calls from Kiwi Browser with zero CSP issues.

const GEMINI_PROMPT = `
You are an expert OCR and document understanding system specializing in Bangladeshi identity documents:
1. Bangladeshi National Identity (NID) Cards (Smart Cards and laminated classic paper NID cards).
2. Bangladeshi Digital Birth Registration Certificates (ডিজিটাল জন্ম নিবন্ধন সনদপত্র / BRC).

Analyze the provided image and extract information into valid JSON format.

DOCUMENT CLASSIFICATION:
- "doc_type": Identify whether the document is "nid" or "birth_certificate".
  - If it is an NID Card (Smart Card or laminated paper), set "doc_type": "nid".
  - If it is a Birth Registration Certificate (জন্ম নিবন্ধন সনদপত্র / Office of the Registrar of Birth and Death), set "doc_type": "birth_certificate".

EXTRACTION RULES:
1. "doc_number":
   - For NID:
     Extract the National ID number. Only 10-digit (Smart NID) or 17-digit (classic NID) numbers are accepted.
     If the NID is an old 13-digit number, prepend the 4-digit birth year extracted from the Date of Birth to make it exactly 17 digits.
   - For Birth Certificate:
     Extract the 17-digit Birth Registration Number (জন্ম নিবন্ধন নম্বর / Personal Identification Number). It MUST be exactly 17 digits.
   - Remove all spaces, hyphens, or non-numeric characters. Also copy to "nid_number" if doc_type is "nid".
2. "name_bn": Extract the full Bengali name exactly as printed (under "নাম:" or "নাম").
3. "name_en": Extract the full English name (under "Name:"). Format in ALL UPPERCASE letters.
4. "dob": Extract Date of Birth in standard DD/MM/YYYY format.
5. "gender": Identify gender as "পুরুষ" (Male), "নারী" (Female), or "তৃতীয় লিঙ্গ" (Transgender / Hijra).
6. "father_name_bn": Extract the Father's name in Bengali as printed under "পিতা:" / "পিতার নাম:".
7. "father_name_en": Translate or transliterate Father's name into English letters in ALL UPPERCASE (e.g. "MD. ABDUL HOQUE").
8. "mother_name_bn": Extract the Mother's name in Bengali as printed under "মাতা:" / "মাতার নাম:".
9. "mother_name_en": Translate or transliterate Mother's name into English letters in ALL UPPERCASE (e.g. "ROKEYA BEGUM").
10. "relation_suggestion": If this document is for a family member, suggest the relationship relative to the household head ("স্বামী", "স্ত্রী", "ছেলে", "মেয়ে", "বাবা", "মা", "ভাই", "বোন", "অন্যান্য").
11. "marital_status_suggestion":
    - If age is under 18 or unmarried, suggest "অবিবাহিত".
    - If adult with spouse or children or typical married adult, suggest "বিবাহিত".
    - If widowed, suggest "বিধবা" / "বিপত্নীক".

Return ONLY a single valid JSON object with these exact keys:
{
  "doc_type": "nid" or "birth_certificate",
  "doc_number": "...",
  "nid_number": "...",
  "name_bn": "...",
  "name_en": "...",
  "dob": "DD/MM/YYYY",
  "gender": "...",
  "father_name_bn": "...",
  "father_name_en": "...",
  "mother_name_bn": "...",
  "mother_name_en": "...",
  "relation_suggestion": "...",
  "marital_status_suggestion": "..."
}
`;

// Normalize Bengali numerals (০-৯) to English (0-9)
function normalizeDigits(str) {
  if (!str) return '';
  const bn = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  return String(str).replace(/[০-৯]/g, d => {
    const idx = bn.indexOf(d);
    return idx !== -1 ? idx : d;
  });
}

// Standardize Date of Birth to DD/MM/YYYY
function standardizeDate(dobStr) {
  if (!dobStr) return '';
  let str = normalizeDigits(dobStr).trim();

  // ISO: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = str.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[3].padStart(2, '0')}/${isoMatch[2].padStart(2, '0')}/${isoMatch[1]}`;
  }

  // Month names: 15 Aug 1985
  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  };
  const monthMatch = str.match(/^(\d{1,2})\s+([a-zA-Z]{3,})\s+(\d{4})/i);
  if (monthMatch) {
    const d = monthMatch[1].padStart(2, '0');
    const m = months[monthMatch[2].toLowerCase().substring(0, 3)] || '01';
    const y = monthMatch[3];
    return `${d}/${m}/${y}`;
  }

  // Standard DD/MM/YYYY
  str = str.replace(/[-\.]/g, '/');
  const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmyMatch) {
    return `${dmyMatch[1].padStart(2, '0')}/${dmyMatch[2].padStart(2, '0')}/${dmyMatch[3]}`;
  }

  return str;
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'ocr_nid_direct') {
    handleDirectOCR(req)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message || 'Unknown OCR Error' }));
    return true; // Keep message channel open for async response
  }
});

async function handleDirectOCR(req) {
  const { imageBase64, mimeType = 'image/jpeg', maritalStatus = 'বিবাহিত', religion = 'ইসলাম', mobileNumber = '' } = req;

  // Retrieve stored API key or fallback to req.apiKey
  let apiKey = req.apiKey;
  if (!apiKey) {
    const stored = await chrome.storage.sync.get(['geminiApiKey', 'serverUrl']);
    apiKey = stored.geminiApiKey;
    if (!apiKey && stored.serverUrl) {
      // If no direct key, forward to relay server endpoint
      return await forwardToServer(stored.serverUrl, imageBase64, mimeType, maritalStatus, religion, mobileNumber);
    }
  }

  if (!apiKey) {
    throw new Error('Gemini API Key সেট করা নেই। এক্সটেনশন আইকনে ক্লিক করে API Key দিন।');
  }

  // Clean base64 data
  const rawBase64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

  const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`;

  const bodyPayload = {
    contents: [
      {
        parts: [
          { text: GEMINI_PROMPT },
          {
            inline_data: {
              mime_type: mimeType,
              data: rawBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: 'application/json'
    }
  };

  const response = await fetch(geminiEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyPayload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  const candidate = result.candidates?.[0];
  const textOutput = candidate?.content?.parts?.[0]?.text;

  if (!textOutput) {
    throw new Error('Gemini API থেকে কোনো ফলাফল পাওয়া যায়নি।');
  }

  // Clean markdown delimiters if present
  let cleanText = textOutput.trim();
  if (cleanText.startsWith('```json')) cleanText = cleanText.substring(7);
  if (cleanText.startsWith('```')) cleanText = cleanText.substring(3);
  if (cleanText.endsWith('```')) cleanText = cleanText.substring(0, cleanText.length - 3);

  const parsedData = JSON.parse(cleanText.trim());

  // 10 or 17 digit NID / 17 digit BRC rule validation & transformation
  const rawDocNum = parsedData.doc_number || parsedData.nid_number || '';
  let cleanDocNum = normalizeDigits(rawDocNum).replace(/[^0-9]/g, '');

  if (parsedData.doc_type === 'birth_certificate' || cleanDocNum.length === 17) {
    parsedData.doc_number = cleanDocNum;
  } else if (cleanDocNum.length === 13) {
    const yearMatch = String(parsedData.dob || '').match(/\b(19\d{2}|20\d{2})\b/);
    if (yearMatch) cleanDocNum = yearMatch[1] + cleanDocNum;
    parsedData.doc_number = cleanDocNum;
  } else {
    parsedData.doc_number = cleanDocNum;
  }

  if (parsedData.doc_type === 'nid' || !parsedData.doc_type) {
    parsedData.nid_number = parsedData.doc_number;
  }

  if (parsedData.dob) {
    parsedData.dob = standardizeDate(parsedData.dob);
  }

  // Ensure uppercase english names
  if (parsedData.name_en) parsedData.name_en = String(parsedData.name_en).toUpperCase().trim();
  if (parsedData.father_name_en) parsedData.father_name_en = String(parsedData.father_name_en).toUpperCase().trim();
  if (parsedData.mother_name_en) parsedData.mother_name_en = String(parsedData.mother_name_en).toUpperCase().trim();

  // Attach user options
  parsedData.marital_status = maritalStatus || parsedData.marital_status_suggestion || 'বিবাহিত';
  parsedData.religion = religion || 'ইসলাম';
  parsedData.mobile_number = mobileNumber ? normalizeDigits(mobileNumber).trim() : '';

  return {
    success: true,
    data: parsedData
  };
}

// Forward to backend server if user has a server configured
async function forwardToServer(serverUrl, imageBase64, mimeType, maritalStatus, religion, mobileNumber) {
  const url = `${serverUrl.replace(/\/+$/, '')}/api/extract-nid`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64,
      mimeType,
      maritalStatus,
      religion,
      mobileNumber
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`সার্ভার এরর (${response.status}): ${errorText}`);
  }

  return await response.json();
}
