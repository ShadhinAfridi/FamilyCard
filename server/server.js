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

// Helper to standardize Date of Birth to DD/MM/YYYY
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
      marital_status: { stringValue: data.marital_status || 'বিবাহিত' },
      religion: { stringValue: data.religion || 'ইসলাম' },
      mobile_number: { stringValue: data.mobile_number || '' },
      doc_type: { stringValue: data.doc_type || 'nid' },
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

// Call Gemini API to extract Bangladeshi NID fields
async function extractNidWithGemini(base64Image, customApiKey, options = {}) {
  const apiKey = customApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('No Gemini API Key provided. Set GEMINI_API_KEY in .env or provide it in the request.');
  }

  // Strip data URL header if present (e.g. data:image/jpeg;base64,...)
  let mimeType = options.mimeType || 'image/jpeg';
  let cleanBase64 = base64Image;

  if (base64Image.includes(';base64,')) {
    const parts = base64Image.split(';base64,');
    mimeType = parts[0].replace('data:', '') || mimeType;
    cleanBase64 = parts[1];
  }

  const prompt = `
You are an expert OCR AI for Bangladeshi Identity Documents:
1. Bangladeshi National Identity (NID) Cards (both Smart NID and Old Laminated/Paper NID).
2. Bangladeshi Digital Birth Registration Certificates (ডিজিটাল জন্ম নিবন্ধন সনদপত্র / BRC).

Examine the image carefully and classify and extract the required information:

DOCUMENT CLASSIFICATION:
- "doc_type": Identify whether the document is "nid" or "birth_certificate".

EXTRACTION RULES:
1. "doc_number":
   - For NID: Extract the National ID number. Only 10-digit (Smart NID) or 17-digit (classic NID) numbers are accepted. If 13-digit legacy NID, prepend 4-digit birth year extracted from Date of Birth to make it 17 digits.
   - For Birth Certificate: Extract the 17-digit Birth Registration Number (জন্ম নিবন্ধন নম্বর / PIN).
   - Remove spaces, hyphens, and non-numeric symbols.
2. "name_bn": Complete Bengali name as written on the document.
3. "name_en": Complete English name in ALL CAPITAL LETTERS.
4. "dob": Date of Birth in DD/MM/YYYY format.
5. "gender": "পুরুষ" (Male), "নারী" (Female), or "হিজড়া" (Transgender / Hijra).
6. "father_name_bn": Father's Bengali name.
7. "father_name_en": Father's English name in ALL CAPITAL LETTERS (transliterate from Bengali if only in Bengali).
8. "mother_name_bn": Mother's Bengali name.
9. "mother_name_en": Mother's English name in ALL CAPITAL LETTERS (transliterate from Bengali if only in Bengali).
10. "relation_suggestion": If for family member, suggest relationship relative to household head strictly from ("স্বামী", "স্ত্রী", "পুত্র", "কন্যা", "পিতা", "মাতা", "ভাই", "বোন", "অন্যান্য").
11. "marital_status_suggestion": Suggested marital status ("বিবাহিত", "অবিবাহিত", "বিধবা", "বিপত্নীক").

Return ONLY a valid JSON object with these exact keys:
{
  "doc_type": "nid" or "birth_certificate",
  "doc_number": "",
  "nid_number": "",
  "name_bn": "",
  "name_en": "",
  "dob": "",
  "gender": "",
  "father_name_bn": "",
  "father_name_en": "",
  "mother_name_bn": "",
  "mother_name_en": "",
  "relation_suggestion": "",
  "marital_status_suggestion": ""
}
Do not wrap in Markdown code blocks. Return purely the raw JSON object. If any field is missing or unreadable, leave it as an empty string "".
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        parts: [
          {
            text: prompt
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: cleanBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: "application/json"
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  const textOutput = result?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textOutput) {
    throw new Error('No text generated by Gemini OCR.');
  }

  // Parse JSON safely
  const fenceMatch = textOutput.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let cleaned = fenceMatch ? fenceMatch[1].trim() : textOutput.trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) cleaned = objMatch[0];

  const data = JSON.parse(cleaned);

  if (options.docType && options.docType !== 'auto') {
    data.doc_type = options.docType;
  }

  // Standardize DOB first so Bengali digits in birth year work for 13->17 NID conversion
  if (data.dob) data.dob = standardizeDate(data.dob);

  // Canonicalize gender and relation labels
  const genderMap = { 'তৃতীয় লিঙ্গ': 'হিজড়া', 'তৃতীয় লিঙ্গ': 'হিজড়া', 'হিজড়া': 'হিজড়া' };
  if (data.gender && genderMap[data.gender.trim()]) {
    data.gender = genderMap[data.gender.trim()];
  }
  const relMap = { 'ছেলে': 'পুত্র', 'মেয়ে': 'কন্যা', 'মেয়ে': 'কন্যা', 'বাবা': 'পিতা', 'মা': 'মাতা' };
  if (data.relation_suggestion && relMap[data.relation_suggestion.trim()]) {
    data.relation_suggestion = relMap[data.relation_suggestion.trim()];
  }

  // Normalize Bengali numerals to English and enforce 10 or 17 digit NID / 17 digit BRC rule
  const rawDocNum = data.doc_number || (data.doc_type === 'birth_certificate' ? data.birth_reg_no : data.nid_number) || data.nid_number || data.birth_reg_no || '';
  let rawDigits = normalizeDigits(rawDocNum).replace(/[^0-9]/g, '');

  if (data.doc_type === 'birth_certificate' || rawDigits.length === 17) {
    data.doc_number = rawDigits;
  } else if (rawDigits.length === 13) {
    const yearMatch = String(data.dob || '').match(/\b(19\d{2}|20\d{2})\b/);
    if (yearMatch) {
      rawDigits = yearMatch[1] + rawDigits;
      data.nid_converted_to_17 = true;
    }
    data.doc_number = rawDigits;
  } else {
    data.doc_number = rawDigits;
  }

  if (data.doc_type === 'birth_certificate') {
    data.birth_reg_no = data.doc_number;
  } else {
    data.doc_type = data.doc_type || 'nid';
    data.nid_number = data.doc_number;
  }

  if (data.name_en) data.name_en = String(data.name_en).toUpperCase().trim();
  if (data.father_name_en) data.father_name_en = String(data.father_name_en).toUpperCase().trim();
  if (data.mother_name_en) data.mother_name_en = String(data.mother_name_en).toUpperCase().trim();

  return data;
}

// REST API for direct OCR (supports both /api/ocr-nid and /api/extract-nid)
async function handleExtractNidRoute(req, res) {
  try {
    const image = req.body.image || req.body.imageBase64;
    const { apiKey, room, mimeType, docType } = req.body;
    if (!image) {
      return res.status(400).json({ success: false, error: 'No image provided.' });
    }

    const extracted = await extractNidWithGemini(image, apiKey, { mimeType, docType });
    extracted.marital_status = req.body.maritalStatus || extracted.marital_status_suggestion || 'বিবাহিত';
    extracted.religion = req.body.religion || 'ইসলাম';
    extracted.mobile_number = normalizeDigits(req.body.mobileNumber || '');
    extracted.family_id = normalizeDigits(req.body.familyId || '');

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
    hasEnvApiKey: Boolean(process.env.GEMINI_API_KEY)
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
    const { image, room, apiKey } = payload;
    const targetRoom = (room || 'DEFAULT').toUpperCase().trim();

    console.log(`[OCR Request] Received image for room: ${targetRoom}`);
    socket.emit('ocr-status', { status: 'processing', message: 'Gemini AI is reading the NID card...' });

    try {
      const extracted = await extractNidWithGemini(image, apiKey, { docType: payload.docType });
      extracted.marital_status = payload.maritalStatus || extracted.marital_status_suggestion || 'বিবাহিত';
      extracted.religion = payload.religion || 'ইসলাম';
      extracted.mobile_number = normalizeDigits(payload.mobileNumber || '');
      extracted.family_id = normalizeDigits(payload.familyId || '');
      console.log(`[OCR Success] Extracted:`, extracted.name_bn || extracted.name_en, extracted.nid_number);

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
