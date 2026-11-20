import fs from 'fs';

const workerCode = `// Cloudflare Worker for familycard.afridi.app & familycard.fourdevs-pro.workers.dev
// Edge API (Gemini NID & Birth Certificate OCR) + Zero-Lag Edge CDN Proxy backed by binary-ict.web.app

const ORIGIN_BASE = 'https://binary-ict.web.app';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function normalizeDigits(str) {
  if (!str) return '';
  const bn = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
  return String(str).replace(/[০-৯]/g, d => {
    const idx = bn.indexOf(d);
    return idx !== -1 ? idx : d;
  });
}

function standardizeDate(dobStr) {
  if (!dobStr) return '';
  let str = normalizeDigits(dobStr).trim();
  const isoMatch = str.match(/^(\\d{4})[-\\/.](\\d{1,2})[-\\/.](\\d{1,2})/);
  if (isoMatch) return \`\${isoMatch[3].padStart(2, '0')}/\${isoMatch[2].padStart(2, '0')}/\${isoMatch[1]}\`;
  const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
  const monthMatch = str.match(/^(\\d{1,2})\\s+([a-zA-Z]{3,})\\s+(\\d{4})/i);
  if (monthMatch) return \`\${monthMatch[1].padStart(2, '0')}/\${months[monthMatch[2].toLowerCase().substring(0, 3)] || '01'}/\${monthMatch[3]}\`;
  str = str.replace(/[-\\.]/g, '/');
  const dmyMatch = str.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/);
  if (dmyMatch) return \`\${dmyMatch[1].padStart(2, '0')}/\${dmyMatch[2].padStart(2, '0')}/\${dmyMatch[3]}\`;
  return str;
}

const GEMINI_PROMPT = \`
You are an expert OCR AI for Bangladeshi Identity Documents:
1. Bangladeshi National Identity (NID) Cards (Smart NID and Old Laminated/Paper NID).
2. Bangladeshi Digital Birth Registration Certificates (ডিজিটাল জন্ম নিবন্ধন সনদপত্র / BRC).

Classify and extract all fields into a valid JSON object:
- "doc_type": "nid" or "birth_certificate"
1. "doc_number": 10 or 17 digits for NID (if 13-digit legacy NID, prepend 4-digit birth year from dob to make 17 digits), or 17-digit Birth Registration Number. Strip spaces/hyphens.
2. "name_bn": Complete Bengali name.
3. "name_en": Complete English name in ALL CAPITAL LETTERS.
4. "dob": Date of Birth in DD/MM/YYYY format (English digits).
5. "gender": Strictly "পুরুষ", "নারী", or "হিজড়া".
6. "father_name_bn": Father's Bengali name.
7. "father_name_en": Father's English name transliterated in ALL CAPITAL LETTERS.
8. "mother_name_bn": Mother's Bengali name.
9. "mother_name_en": Mother's English name transliterated in ALL CAPITAL LETTERS.
10. "relation_suggestion": One of ("স্বামী", "স্ত্রী", "পুত্র", "কন্যা", "পিতা", "মাতা", "ভাই", "বোন", "অন্যান্য").
11. "marital_status_suggestion": One of ("বিবাহিত", "অবিবাহিত", "বিধবা", "বিপত্নীক", "তালাকপ্রাপ্ত", "পরিত্যক্ত").

Return ONLY a single raw JSON object with keys: doc_type, doc_number, name_bn, name_en, dob, gender, father_name_bn, father_name_en, mother_name_bn, mother_name_en, relation_suggestion, marital_status_suggestion.
\`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // API: OCR Endpoint (supports both /api/extract-nid and /api/ocr-nid)
    if ((path === '/api/extract-nid' || path === '/api/ocr-nid') && request.method === 'POST') {
      try {
        const body = await request.json();
        const apiKey = body.apiKey || env.GEMINI_API_KEY;
        if (!apiKey) {
          return Response.json({ success: false, error: 'Gemini API Key প্রয়োজন।' }, { status: 400, headers: CORS_HEADERS });
        }

        const rawInput = body.imageBase64 || body.image || '';
        if (!rawInput) {
          return Response.json({ success: false, error: 'Image is required' }, { status: 400, headers: CORS_HEADERS });
        }

        let mimeType = body.mimeType || 'image/jpeg';
        let rawBase64 = rawInput;
        if (rawInput.includes(';base64,')) {
          const parts = rawInput.split(';base64,');
          mimeType = parts[0].replace('data:', '') || mimeType;
          rawBase64 = parts[1];
        }

        const geminiUrl = \`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=\${encodeURIComponent(apiKey)}\`;

        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: GEMINI_PROMPT },
                { inline_data: { mime_type: mimeType, data: rawBase64 } }
              ]
            }],
            generationConfig: {
              temperature: 0.1,
              response_mime_type: 'application/json'
            }
          })
        });

        if (!geminiRes.ok) {
          const errTxt = await geminiRes.text();
          return Response.json({ success: false, error: \`Gemini Error: \${errTxt}\` }, { status: 500, headers: CORS_HEADERS });
        }

        const geminiJson = await geminiRes.json();
        const outText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const fenceMatch = outText.match(/\`\`\`(?:json)?\\s*([\\s\\S]*?)\\s*\`\`\`/i);
        let cleaned = fenceMatch ? fenceMatch[1].trim() : outText.trim();
        const objMatch = cleaned.match(/\\{[\\s\\S]*\\}/);
        if (objMatch) cleaned = objMatch[0];

        const parsed = JSON.parse(cleaned);
        if (body.docType && body.docType !== 'auto') parsed.doc_type = body.docType;
        if (parsed.dob) parsed.dob = standardizeDate(parsed.dob);

        const genderMap = { 'তৃতীয় লিঙ্গ': 'হিজড়া', 'তৃতীয় লিঙ্গ': 'হিজড়া', 'হিজড়া': 'হিজড়া' };
        if (parsed.gender && genderMap[parsed.gender.trim()]) parsed.gender = genderMap[parsed.gender.trim()];
        const relMap = { 'ছেলে': 'পুত্র', 'মেয়ে': 'কন্যা', 'মেয়ে': 'কন্যা', 'বাবা': 'পিতা', 'মা': 'মাতা' };
        if (parsed.relation_suggestion && relMap[parsed.relation_suggestion.trim()]) parsed.relation_suggestion = relMap[parsed.relation_suggestion.trim()];

        const rawDocNum = parsed.doc_number || (parsed.doc_type === 'birth_certificate' ? parsed.birth_reg_no : parsed.nid_number) || parsed.nid_number || parsed.birth_reg_no || '';
        let cleanDoc = normalizeDigits(rawDocNum).replace(/[^0-9]/g, '');
        if (parsed.doc_type !== 'birth_certificate' && cleanDoc.length === 13) {
          const ym = String(parsed.dob || '').match(/\\b(19\\d{2}|20\\d{2})\\b/);
          if (ym) {
            cleanDoc = ym[1] + cleanDoc;
            parsed.nid_converted_to_17 = true;
          }
        }
        parsed.doc_number = cleanDoc;
        if (parsed.doc_type === 'birth_certificate') parsed.birth_reg_no = cleanDoc;
        else { parsed.doc_type = parsed.doc_type || 'nid'; parsed.nid_number = cleanDoc; }

        if (parsed.name_en) parsed.name_en = String(parsed.name_en).toUpperCase().trim();
        if (parsed.father_name_en) parsed.father_name_en = String(parsed.father_name_en).toUpperCase().trim();
        if (parsed.mother_name_en) parsed.mother_name_en = String(parsed.mother_name_en).toUpperCase().trim();

        parsed.marital_status = body.maritalStatus || parsed.marital_status_suggestion || 'বিবাহিত';
        parsed.religion = body.religion || 'ইসলাম';
        parsed.mobile_number = body.mobileNumber ? normalizeDigits(body.mobileNumber).trim() : '';

        return Response.json({ success: true, data: parsed }, { headers: CORS_HEADERS });
      } catch (err) {
        return Response.json({ success: false, error: err.message }, { status: 500, headers: CORS_HEADERS });
      }
    }

    // Health check endpoint
    if (path === '/api/info') {
      return Response.json({ status: 'online', edge: 'cloudflare-worker', upstream: ORIGIN_BASE }, { headers: CORS_HEADERS });
    }

    // Static & Bookmarklet Assets via global Firebase CDN upstream with full CORS
    if (path === '/bookmarklet/extension.zip' || path === '/extension.zip') {
      return Response.redirect(ORIGIN_BASE + '/extension.zip', 302);
    }

    let targetPath = path;
    if (path === '/' || path === '') targetPath = '/index.html';
    else if (path === '/bookmarklet' || path === '/bookmarklet/') targetPath = '/bookmarklet/index.html';
    else if (path === '/bookmarklet.min.js') targetPath = '/bookmarklet/bookmarklet.min.js';

    const upstreamRes = await fetch(ORIGIN_BASE + targetPath + url.search);
    const outHeaders = new Headers(upstreamRes.headers);
    outHeaders.set('Access-Control-Allow-Origin', '*');
    if (targetPath.startsWith('/bookmarklet/')) {
      outHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: outHeaders
    });
  }
};
`;

if (!fs.existsSync('cloudflare')) fs.mkdirSync('cloudflare');
fs.writeFileSync('cloudflare/worker.js', workerCode);
console.log('Worker bundle created successfully. Size:', workerCode.length);
