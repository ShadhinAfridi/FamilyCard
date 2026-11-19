import fs from 'fs';
import path from 'path';

const publicHtml = fs.readFileSync('public/index.html', 'utf8');
const publicCss = fs.readFileSync('public/style.css', 'utf8');
const publicJs = fs.readFileSync('public/app.js', 'utf8');
const bookmarkletHtml = fs.readFileSync('bookmarklet/index.html', 'utf8');
const bookmarkletMin = fs.readFileSync('bookmarklet/bookmarklet.min.js', 'utf8');

const workerCode = `// Cloudflare Worker for familycard.afridi.app
// Edge-deployed Family Card NID AI Scanner & Bookmarklet Suite

const PUBLIC_HTML = ${JSON.stringify(publicHtml)};
const PUBLIC_CSS = ${JSON.stringify(publicCss)};
const PUBLIC_JS = ${JSON.stringify(publicJs)};
const BOOKMARKLET_HTML = ${JSON.stringify(bookmarkletHtml)};
const BOOKMARKLET_MIN = ${JSON.stringify(bookmarkletMin)};

const GEMINI_PROMPT = \`
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

Return ONLY a single valid JSON object with these keys:
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
\`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    // Static Assets
    if (path === '/' || path === '/index.html') {
      return new Response(PUBLIC_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (path === '/style.css') {
      return new Response(PUBLIC_CSS, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
    }
    if (path === '/app.js') {
      return new Response(PUBLIC_JS, { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
    }
    if (path === '/bookmarklet' || path === '/bookmarklet/' || path === '/bookmarklet/index.html') {
      return new Response(BOOKMARKLET_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (path === '/bookmarklet.min.js' || path === '/bookmarklet/bookmarklet.min.js') {
      return new Response(BOOKMARKLET_MIN, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // API: OCR Endpoint
    if (path === '/api/extract-nid' && request.method === 'POST') {
      try {
        const body = await request.json();
        const apiKey = body.apiKey || env.GEMINI_API_KEY;
        if (!apiKey) {
          return Response.json({ success: false, error: 'Gemini API Key প্রয়োজন।' }, { status: 400 });
        }

        const rawBase64 = (body.imageBase64 || '').replace(/^data:image\\/[a-zA-Z]+;base64,/, '');
        const geminiUrl = \`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=\${encodeURIComponent(apiKey)}\`;

        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: GEMINI_PROMPT },
                { inline_data: { mime_type: body.mimeType || 'image/jpeg', data: rawBase64 } }
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
          return Response.json({ success: false, error: \`Gemini Error: \${errTxt}\` }, { status: 500 });
        }

        const geminiJson = await geminiRes.json();
        let outText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || '';
        outText = outText.trim().replace(/^\`\`\`json/, '').replace(/\`\`\`$/, '').trim();
        const parsed = JSON.parse(outText);

        if (parsed.nid_number) {
          let cleanNid = String(parsed.nid_number).replace(/[^0-9]/g, '');
          if (cleanNid.length === 13) {
            const ym = String(parsed.dob || '').match(/\\b(19\\d{2}|20\\d{2})\\b/);
            if (ym) cleanNid = ym[1] + cleanNid;
          }
          parsed.nid_number = cleanNid;
        }

        if (parsed.name_en) parsed.name_en = String(parsed.name_en).toUpperCase();
        if (parsed.father_name_en) parsed.father_name_en = String(parsed.father_name_en).toUpperCase();
        if (parsed.mother_name_en) parsed.mother_name_en = String(parsed.mother_name_en).toUpperCase();

        parsed.marital_status = body.maritalStatus || 'বিবাহিত';
        parsed.religion = body.religion || 'ইসলাম';
        parsed.mobile_number = body.mobileNumber ? String(body.mobileNumber).trim() : '';

        return Response.json({ success: true, data: parsed }, {
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return Response.json({ success: false, error: err.message }, {
          status: 500,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
`;

if (!fs.existsSync('cloudflare')) fs.mkdirSync('cloudflare');
fs.writeFileSync('cloudflare/worker.js', workerCode);
console.log('Worker bundle created successfully. Size:', workerCode.length);
