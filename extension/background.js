// Background Service Worker for Family Card NID Auto-Filler
// Handles direct Gemini 2.0 Flash AI OCR calls from Kiwi Browser with zero CSP issues.

const GEMINI_PROMPT = `
You are an expert OCR and document understanding system specializing in Bangladeshi National Identity (NID) Cards.
Analyze the provided image of a Bangladeshi NID card and extract the required information into valid JSON format.

RULES:
1. "name_bn": Extract the full name in Bengali exactly as printed under "নাম:".
2. "name_en": Extract the full name in English exactly as printed under "Name:". Format in UPPERCASE.
3. "nid_number": Extract the National ID number. 
   - CRITICAL NID DIGIT RULE: 
     Only 10-digit (Smart NID) or 17-digit (legacy NID) numbers are accepted by the portal.
     If the NID is an old 13-digit number, you MUST prepend the 4-digit birth year extracted from the Date of Birth to make it exactly 17 digits.
     (For example: if Birth year is 1988 and NID is 1234567890123, return "19881234567890123").
     Remove all spaces or hyphens.
4. "dob": Extract Date of Birth in DD/MM/YYYY format.
5. "gender": Identify whether the person is male ("পুরুষ") or female ("নারী").
6. "father_name_bn": Extract the Father's name in Bengali as printed under "পিতা:".
7. "father_name_en": The NID card does NOT print the father's name in English. You MUST translate/transliterate the Bengali father's name into English letters following standard Bangladeshi spelling conventions, formatted in ALL UPPERCASE (e.g., "সিরাজ ব্যাপারী" -> "SHIRAJ BEPARI", "মো: আক্তার হোসেন" -> "MD. AKTER HOSSAIN").
8. "mother_name_bn": Extract the Mother's name in Bengali as printed under "মাতা:".
9. "mother_name_en": Translate/transliterate the Bengali mother's name into English letters following standard Bangladeshi spelling conventions, formatted in ALL UPPERCASE (e.g., "নুরজাহান নেছা" -> "NURJAHAN NESA", "মোসা: খাদিজা বেগম" -> "MOSA. KHADIJA BEGUM").

Return ONLY a single valid JSON object with these exact keys:
{
  "name_bn": "...",
  "name_en": "...",
  "nid_number": "...",
  "dob": "DD/MM/YYYY",
  "gender": "...",
  "father_name_bn": "...",
  "father_name_en": "...",
  "mother_name_bn": "...",
  "mother_name_en": "..."
}
`;

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

  // 10 or 17 digit NID rule validation & transformation
  if (parsedData.nid_number) {
    let cleanNid = String(parsedData.nid_number).replace(/[^0-9]/g, '');
    if (cleanNid.length === 13) {
      const yearMatch = String(parsedData.dob || '').match(/\b(19\d{2}|20\d{2})\b/);
      if (yearMatch) cleanNid = yearMatch[1] + cleanNid;
    }
    parsedData.nid_number = cleanNid;
  }

  // Ensure uppercase english names
  if (parsedData.name_en) parsedData.name_en = String(parsedData.name_en).toUpperCase();
  if (parsedData.father_name_en) parsedData.father_name_en = String(parsedData.father_name_en).toUpperCase();
  if (parsedData.mother_name_en) parsedData.mother_name_en = String(parsedData.mother_name_en).toUpperCase();

  // Attach user options
  parsedData.marital_status = maritalStatus;
  parsedData.religion = religion;
  parsedData.mobile_number = mobileNumber ? String(mobileNumber).trim() : '';

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
