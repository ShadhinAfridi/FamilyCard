import fs from 'fs';

const workerCode = `// Cloudflare Worker for familycard.afridi.app & familycard.fourdevs-pro.workers.dev
// Edge API (Gemini NID & Birth Certificate OCR) + Zero-Lag Edge CDN Proxy backed by binary-ict.web.app

const ORIGIN_BASE = 'https://binary-ict.web.app';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const FIRESTORE_ROOMS_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/room_channels';

function normalizeWorkerRoomCode(room) {
  const clean = String(room || 'FC-101').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
  return clean || 'FC-101';
}

function makeWorkerRoomMsgId(ts = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 7);
  return \`m_\${String(ts).padStart(14, '0')}_\${rand}\`;
}

function normalizeWorkerRoomMsg(raw = {}, fallbackRoom = 'FC-101') {
  const ts = Number(raw.ts) > 0 ? Number(raw.ts) : Date.now();
  const room = normalizeWorkerRoomCode(raw.room || fallbackRoom);
  const type = ['text', 'nid_data', 'summary', 'system'].includes(raw.type) ? raw.type : 'text';
  const id = String(raw.id || makeWorkerRoomMsgId(ts)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || makeWorkerRoomMsgId(ts);
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

function extractWorkerActivePeers(mf = {}, nowMs = Date.now()) {
  const peerFields = mf?.peers?.mapValue?.fields;
  if (!peerFields || typeof peerFields !== 'object') return [];
  const out = [];
  for (const [id, val] of Object.entries(peerFields)) {
    const pf = val?.mapValue?.fields;
    if (!pf) continue;
    const seenAt = Number(pf.seenAt?.integerValue || pf.seenAt?.doubleValue || 0);
    if (nowMs - seenAt <= 45000) {
      out.push({
        id,
        name: pf.name?.stringValue || 'ডিভাইস',
        client: pf.client?.stringValue || '',
        seenAt
      });
    }
  }
  return out.sort((a, b) => b.seenAt - a.seenAt);
}

async function touchWorkerRoomPeer(room, peerId, peerName, peerClient, nowMs = Date.now()) {
  const cleanId = String(peerId || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
  if (!cleanId) return null;
  const fields = {
    room: { stringValue: room },
    peers: {
      mapValue: {
        fields: {
          [cleanId]: {
            mapValue: {
              fields: {
                name: { stringValue: String(peerName || 'ডিভাইস').slice(0, 50) },
                client: { stringValue: String(peerClient || 'web').slice(0, 24) },
                seenAt: { integerValue: String(nowMs) }
              }
            }
          }
        }
      }
    }
  };
  const res = await fetch(\`\${FIRESTORE_ROOMS_BASE}/\${encodeURIComponent(room)}?updateMask.fieldPaths=room&updateMask.fieldPaths=peers.\${encodeURIComponent(cleanId)}\`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  }).catch(() => null);
  return res && res.ok ? await res.json().catch(() => null) : null;
}

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
  let str = normalizeDigits(dobStr).replace(/[\\u200B-\\u200D\\uFEFF]/g, '').trim();
  const isoMatch = str.match(/^(\\d{4})[-\\/.](\\d{1,2})[-\\/.](\\d{1,2})/);
  if (isoMatch) return \`\${isoMatch[3].padStart(2, '0')}/\${isoMatch[2].padStart(2, '0')}/\${isoMatch[1]}\`;
  const enMonths = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
  const enMatch = str.match(/^(\\d{1,2})[\\s\\-,.]+([a-zA-Z]{3,})[\\s\\-,.]+(\\d{4})/i);
  if (enMatch && enMonths[enMatch[2].toLowerCase().substring(0, 3)]) {
    return \`\${enMatch[1].padStart(2, '0')}/\${enMonths[enMatch[2].toLowerCase().substring(0, 3)]}/\${enMatch[3]}\`;
  }
  const bnPrefixes = [
    ['জানু','01'],['ফেব','02'],['মার','03'],['এপ্রি','04'],['মে','05'],['জুন','06'],
    ['জুল','07'],['আগ','08'],['সেপ','09'],['অক','10'],['নভ','11'],['ডিস','12']
  ];
  const bnMatch = str.match(/^(\\d{1,2})[\\s\\-,/.]+([\\u0980-\\u09FF]+)[\\s\\-,/.]+(\\d{4})/);
  if (bnMatch) {
    const hit = bnPrefixes.find(([p]) => bnMatch[2].startsWith(p));
    if (hit) return \`\${bnMatch[1].padStart(2, '0')}/\${hit[1]}/\${bnMatch[3]}\`;
  }
  str = str.replace(/[-\\.]/g, '/');
  const dmyMatch = str.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/);
  if (dmyMatch) return \`\${dmyMatch[1].padStart(2, '0')}/\${dmyMatch[2].padStart(2, '0')}/\${dmyMatch[3]}\`;
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
  required: ['doc_type', 'doc_number', 'name_bn', 'name_en', 'dob', 'gender']
};

function buildGeminiPrompt(docTypeHint = 'auto') {
  const hint = docTypeHint === 'nid'
    ? 'HINT: User indicated this document is a Bangladeshi NID Card.'
    : docTypeHint === 'birth_certificate'
      ? 'HINT: User indicated this document is a Bangladeshi Birth Registration Certificate.'
      : 'Detect automatically whether this is a Bangladeshi NID Card or Birth Registration Certificate.';
  return \`You are an expert OCR AI for Bangladeshi Identity Documents:
1. Bangladeshi National Identity (NID) Cards (Smart NID and Old Laminated/Paper NID).
2. Bangladeshi Digital Birth Registration Certificates (ডিজিটাল জন্ম নিবন্ধন সনদপত্র / BRC).
\${hint}

Classify and extract all fields into a valid JSON object:
- "doc_type": Strictly "nid" or "birth_certificate"
1. "doc_number": 10 or 17 digits for NID (if 13-digit legacy NID, prepend 4-digit birth year from dob to make 17 digits; copy to "nid_number"), or exact 17-digit Birth Registration Number (copy to "birth_reg_no"). Strip spaces/hyphens and convert Bengali digits (০-৯) to English (0-9).
2. "name_bn": Complete Bengali name.
3. "name_en": Complete English name in ALL CAPITAL LETTERS (transliterate if not printed).
4. "dob": Date of Birth in DD/MM/YYYY format (English digits). Convert Bengali months/digits accurately.
5. "gender": Strictly "পুরুষ", "নারী", or "হিজড়া".
6. "father_name_bn" & "father_name_en": Father's Bengali & ALL CAPITAL English names. CRITICAL: For married women's classic laminated NIDs showing "স্বামী:" instead of "পিতা:", NEVER put husband's name into father fields! Leave father fields "" and use spouse fields.
7. "mother_name_bn" & "mother_name_en": Mother's Bengali & ALL CAPITAL English names.
8. "spouse_name_bn" & "spouse_name_en": Husband/Wife name from "স্বামী:" / "স্ত্রী:" if printed; otherwise "".
9. "relation_suggestion": One of ("স্বামী", "স্ত্রী", "পুত্র", "কন্যা", "পিতা", "মাতা", "ভাই", "বোন", "অন্যান্য"). If "স্বামী:" is printed on old NID, suggest "স্ত্রী".
10. "marital_status_suggestion": One of ("বিবাহিত", "অবিবাহিত", "বিধবা", "বিপত্নীক", "তালাকপ্রাপ্ত").
11. "confidence": "low" if blurry/glare/cropped, "medium" if uncertain, "high" if clear.\`;
}

function extractTextFromGemini(res) {
  if (Array.isArray(res?.steps)) {
    for (let i = res.steps.length - 1; i >= 0; i--) {
      const s = res.steps[i];
      if (s?.type === 'model_output' && Array.isArray(s.content)) {
        const txt = s.content.map(c => (c && c.text) ? c.text : '').join('').trim();
        if (txt) return txt;
      }
    }
  }
  if (typeof res?.output_text === 'string' && res.output_text.trim()) return res.output_text.trim();
  const parts = res?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map(p => p?.text || '').join('').trim() : '';
}

function validateAndNormalizeOcrData(parsed, body = {}) {
  const warnings = [];
  if (body.docType && body.docType !== 'auto') parsed.doc_type = body.docType;
  if (parsed.dob) parsed.dob = standardizeDate(parsed.dob);

  const genderMap = { 'তৃতীয় লিঙ্গ': 'হিজড়া', 'তৃতীয় লিঙ্গ': 'হিজড়া', 'হিজড়া': 'হিজড়া', 'Male': 'পুরুষ', 'male': 'পুরুষ', 'Female': 'নারী', 'female': 'নারী' };
  if (parsed.gender) parsed.gender = genderMap[String(parsed.gender).trim()] || String(parsed.gender).trim();
  const relMap = { 'ছেলে': 'পুত্র', 'মেয়ে': 'কন্যা', 'মেয়ে': 'কন্যা', 'বাবা': 'পিতা', 'মা': 'মাতা' };
  if (parsed.relation_suggestion) parsed.relation_suggestion = relMap[String(parsed.relation_suggestion).trim()] || String(parsed.relation_suggestion).trim();

  const spouseBn = String(parsed.spouse_name_bn || '').trim();
  const fatherBn = String(parsed.father_name_bn || '').trim();
  if (spouseBn && fatherBn && fatherBn === spouseBn) { parsed.father_name_bn = ''; parsed.father_name_en = ''; }
  if (spouseBn && !parsed.father_name_bn) {
    warnings.push("পুরাতন NID-তে 'স্বামী' নাম পাওয়া গেছে (পিতার নাম ছাপা নেই) — প্রয়োজনে পিতার নাম যাচাই/লিখুন।");
    if (!parsed.relation_suggestion) parsed.relation_suggestion = 'স্ত্রী';
  }

  const rawDocNum = parsed.doc_number || (parsed.doc_type === 'birth_certificate' ? parsed.birth_reg_no : parsed.nid_number) || parsed.nid_number || parsed.birth_reg_no || '';
  let cleanDoc = normalizeDigits(rawDocNum).replace(/[^0-9]/g, '');
  if (parsed.doc_type === 'birth_certificate') {
    parsed.doc_number = cleanDoc;
    parsed.birth_reg_no = cleanDoc;
    if (cleanDoc.length !== 17) warnings.push(\`জন্ম নিবন্ধন নম্বরটি \${cleanDoc.length || 0} সংখ্যার (১৭ সংখ্যা প্রয়োজন) — যাচাই করুন।\`);
  } else {
    if (cleanDoc.length === 13) {
      const ym = String(parsed.dob || '').match(/\\b(19\\d{2}|20\\d{2})\\b/);
      if (ym) { cleanDoc = ym[1] + cleanDoc; parsed.nid_converted_to_17 = true; }
      else warnings.push('১৩ সংখ্যার NID-র জন্মসাল না পাওয়ায় ১৭ সংখ্যায় রূপান্তর করা যায়নি।');
    }
    parsed.doc_type = parsed.doc_type || 'nid';
    parsed.doc_number = cleanDoc;
    parsed.nid_number = cleanDoc;
    if (cleanDoc.length !== 10 && cleanDoc.length !== 17) {
      warnings.push(\`NID নম্বরটি \${cleanDoc.length || 0} সংখ্যার (১০ বা ১৭ সংখ্যা প্রয়োজন) — যাচাই করুন।\`);
    }
  }

  if (!String(parsed.name_bn || '').trim()) warnings.push('বাংলা নাম পড়া যায়নি।');
  if (!String(parsed.name_en || '').trim()) warnings.push('ইংরেজি নাম পড়া যায়নি।');
  if (!/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(String(parsed.dob || ''))) warnings.push('জন্ম তারিখ (DD/MM/YYYY) স্পষ্ট নয় — মিলিয়ে নিন।');
  if (parsed.confidence === 'low') warnings.push('ছবিটি কিছুটা ঝাপসা/অস্পষ্ট — সাবমিটের আগে তথ্য মিলিয়ে নিন।');

  if (parsed.name_en) parsed.name_en = String(parsed.name_en).toUpperCase().trim();
  if (parsed.father_name_en) parsed.father_name_en = String(parsed.father_name_en).toUpperCase().trim();
  if (parsed.mother_name_en) parsed.mother_name_en = String(parsed.mother_name_en).toUpperCase().trim();
  if (parsed.spouse_name_en) parsed.spouse_name_en = String(parsed.spouse_name_en).toUpperCase().trim();

  const normMob = body.mobileNumber ? normalizeDigits(body.mobileNumber).replace(/[^0-9]/g, '').trim() : '';
  if (normMob && !/^01[3-9]\\d{8}$/.test(normMob)) warnings.push('মোবাইল নম্বরটি সঠিক ১১ সংখ্যার নয়।');

  parsed.marital_status = body.maritalStatus || parsed.marital_status_suggestion || 'বিবাহিত';
  parsed.religion = body.religion || 'ইসলাম';
  parsed.mobile_number = normMob;
  parsed.ocr_warnings = warnings;
  return parsed;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // API: OCR Endpoint (supports both /api/extract-nid and /api/ocr-nid; Gemini + DeepSeek)
    if ((path === '/api/extract-nid' || path === '/api/ocr-nid') && request.method === 'POST') {
      try {
        const body = await request.json();
        let gKey = String(body.apiKey || env.GEMINI_API_KEY || '').trim();
        let dKey = String(body.deepseekApiKey || env.DEEPSEEK_API_KEY || '').trim();
        if (!dKey && /^sk-/i.test(gKey)) {
          dKey = gKey;
          gKey = '';
        }
        const aiProvider = ['economy', 'gemini', 'gemini_lite', 'deepseek', 'auto'].includes(body.aiProvider) ? body.aiProvider : 'economy';
        const keySlot = ['auto', 'gemini', 'deepseek'].includes(body.defaultKeySlot) ? body.defaultKeySlot : 'auto';
        const prefGemRaw = normalizeModelId(body.geminiModel || 'gemini-3.1-flash-lite');
        const prefGemModel = prefGemRaw.startsWith('gemini-') ? prefGemRaw : 'gemini-3.1-flash-lite';
        const prefDsModel = normalizeModelId(body.deepseekModel || 'deepseek-flash') === 'deepseek-flash' ? 'deepseek-flash' : 'deepseek-flash';

        if (aiProvider === 'deepseek' && !dKey) {
          return Response.json({ success: false, error: 'DeepSeek API Key প্রয়োজন।' }, { status: 400, headers: CORS_HEADERS });
        }
        if ((aiProvider === 'gemini' || aiProvider === 'gemini_lite') && !gKey) {
          return Response.json({ success: false, error: 'Gemini API Key প্রয়োজন।' }, { status: 400, headers: CORS_HEADERS });
        }
        if (!gKey && !dKey) {
          return Response.json({ success: false, error: 'Gemini বা DeepSeek API Key প্রয়োজন।' }, { status: 400, headers: CORS_HEADERS });
        }

        const rawInput = body.imageBase64 || body.image || '';
        if (!rawInput) {
          return Response.json({ success: false, error: 'Image is required' }, { status: 400, headers: CORS_HEADERS });
        }

        let mimeType = body.mimeType || 'image/jpeg';
        let rawBase64 = String(rawInput);
        const uriMatch = rawBase64.match(/^data:([^;]+);base64,(.+)$/s);
        if (uriMatch) {
          mimeType = uriMatch[1] || mimeType;
          rawBase64 = uriMatch[2];
        }

        const promptText = buildGeminiPrompt(body.docType || 'auto');

        function needsWorkerEscalation(p) {
          if (!p || typeof p !== 'object') return true;
          if (p.confidence === 'low') return true;
          if (!String(p.name_bn || '').trim() || !String(p.name_en || '').trim()) return true;
          if (!/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(standardizeDate(p.dob || ''))) return true;
          const rawNum = p.doc_number || (p.doc_type === 'birth_certificate' ? p.birth_reg_no : p.nid_number) || p.nid_number || p.birth_reg_no || '';
          const d = normalizeDigits(rawNum).replace(/[^0-9]/g, '');
          if (p.doc_type === 'birth_certificate') return d.length !== 17;
          return d.length !== 10 && d.length !== 13 && d.length !== 17;
        }

        function getWorkerGeminiOrder(profile = 'accurate') {
          let base;
          if (profile === 'flash38_only') {
            base = ['gemini-3.8-flash'];
          } else if (profile === 'lite_only') {
            base = prefGemModel === 'gemini-3.5-flash-lite'
              ? ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']
              : ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
          } else if (profile === 'preferred') {
            base = [prefGemModel, 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];
          } else {
            base = ['gemini-3.8-flash', prefGemModel, 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
          }
          return Array.from(new Set(base));
        }

        async function runWorkerGemini(profile = 'accurate') {
          const modelsOrder = getWorkerGeminiOrder(profile);
          const attempts = [];
          for (const model of modelsOrder) {
            if (model === 'gemini-3.8-flash' || model === 'gemini-3.5-flash-lite') {
              const ibody = {
                model,
                input: [{ type: 'text', text: promptText }, { type: 'image', data: rawBase64, mime_type: mimeType }],
                response_format: { type: 'text', mime_type: 'application/json', schema: OCR_RESPONSE_SCHEMA },
                store: false
              };
              if (model === 'gemini-3.8-flash') ibody.generation_config = { thinking_level: 'low' };
              attempts.push({
                model,
                label: \`\${model} (interactions)\`,
                url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gKey, 'Api-Revision': '2026-05-20' },
                body: ibody
              });
            }
            attempts.push({
              model,
              label: \`\${model} (generateContent)\`,
              url: \`https://generativelanguage.googleapis.com/v1beta/models/\${model}:generateContent\`,
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gKey },
              body: {
                contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mimeType, data: rawBase64 } }] }],
                generationConfig: { response_mime_type: 'application/json' }
              }
            });
          }

          let lastErr = 'Gemini OCR থেকে উত্তর পাওয়া যায়নি।';
          for (const attempt of attempts) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 28000);
            try {
              const geminiRes = await fetch(attempt.url, {
                method: 'POST',
                headers: attempt.headers,
                body: JSON.stringify(attempt.body),
                signal: controller.signal
              });
              clearTimeout(timer);
              const gJson = await geminiRes.json().catch(() => ({}));
              if (!geminiRes.ok) {
                const msg = gJson?.error?.message || gJson?.message || \`HTTP \${geminiRes.status}\`;
                if (geminiRes.status === 400 && /API[_\\s]?key/i.test(msg)) {
                  const err = new Error('Gemini API Key সঠিক নয়।');
                  err.statusCode = 400;
                  throw err;
                }
                lastErr = \`\${attempt.label}: \${msg}\`;
                continue;
              }
              const outText = extractTextFromGemini(gJson);
              if (!outText) { lastErr = \`\${attempt.label}: খালি উত্তর\`; continue; }
              const fenceMatch = outText.match(/\\\`\\\`\\\`(?:json)?\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`/i);
              let cleaned = fenceMatch ? fenceMatch[1].trim() : outText.trim();
              const objMatch = cleaned.match(/\\{[\\s\\S]*\\}/);
              if (objMatch) cleaned = objMatch[0];
              const p = JSON.parse(cleaned);
              p.ocr_model_used = attempt.label;
              p.ocr_usage = computeScanUsageAndCost(attempt.model, gJson);
              return p;
            } catch (e) {
              clearTimeout(timer);
              if (e.statusCode === 400) throw e;
              lastErr = e.name === 'AbortError' ? \`\${attempt.label}: Timeout\` : \`\${attempt.label}: \${e.message}\`;
            }
          }
          throw new Error(\`Gemini Error: \${lastErr}\`);
        }

        async function runWorkerDeepSeek() {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 28000);
          try {
            const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': \`Bearer \${dKey}\`
              },
              body: JSON.stringify({
                model: prefDsModel,
                messages: [
                  {
                    role: 'system',
                    content: 'You are an expert Bangladeshi NID and Birth Certificate OCR engine. Return ONLY a single valid JSON object matching the requested schema.'
                  },
                  {
                    role: 'user',
                    content: [
                      { type: 'text', text: promptText },
                      { type: 'image_url', image_url: { url: \`data:\${mimeType};base64,\${rawBase64}\` } }
                    ]
                  }
                ],
                response_format: { type: 'json_object' },
                max_tokens: 2048
              }),
              signal: controller.signal
            });
            clearTimeout(timer);
            const dsJson = await dsRes.json().catch(() => ({}));
            if (!dsRes.ok) {
              const msg = dsJson?.error?.message || dsJson?.message || \`HTTP \${dsRes.status}\`;
              const err = new Error(dsRes.status === 401 ? 'DeepSeek API Key সঠিক নয়।' : \`DeepSeek Error (\${dsRes.status}): \${msg}\`);
              if (dsRes.status === 401) err.statusCode = 400;
              throw err;
            }
            const outText = dsJson?.choices?.[0]?.message?.content || '';
            if (!outText) throw new Error('DeepSeek খালি উত্তর পাঠিয়েছে।');
            const fenceMatch = outText.match(/\\\`\\\`\\\`(?:json)?\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`/i);
            let cleaned = fenceMatch ? fenceMatch[1].trim() : outText.trim();
            const objMatch = cleaned.match(/\\{[\\s\\S]*\\}/);
            if (objMatch) cleaned = objMatch[0];
            const p = JSON.parse(cleaned);
            p.ocr_model_used = \`\${prefDsModel} (api.deepseek.com)\`;
            p.ocr_usage = computeScanUsageAndCost(prefDsModel, dsJson);
            return p;
          } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') throw new Error('DeepSeek Timeout');
            throw e;
          }
        }

        let parsed = null;
        if (aiProvider === 'deepseek') {
          parsed = await runWorkerDeepSeek();
        } else if (aiProvider === 'gemini_lite') {
          parsed = await runWorkerGemini('lite_only');
        } else if (aiProvider === 'gemini') {
          parsed = await runWorkerGemini('preferred');
        } else if (keySlot === 'deepseek' && dKey) {
          const errs = [];
          try {
            const dsRes = await runWorkerDeepSeek();
            if (aiProvider === 'auto' || !needsWorkerEscalation(dsRes) || !gKey) {
              parsed = dsRes;
            } else {
              try { parsed = await runWorkerGemini('preferred'); }
              catch (_) { parsed = dsRes; }
            }
          } catch (e) {
            if (e.statusCode === 400 && !gKey) throw e;
            errs.push(e.message);
          }
          if (!parsed && gKey) {
            try { parsed = await runWorkerGemini('preferred'); }
            catch (e) { errs.push(e.message); }
          }
          if (!parsed) throw new Error(errs.join(' | '));
        } else if (aiProvider === 'economy') {
          const errs = [];
          if (gKey) {
            try {
              const firstProfile = prefGemModel === 'gemini-3.8-flash' ? 'accurate' : 'lite_only';
              const primaryRes = await runWorkerGemini(firstProfile);
              if (!needsWorkerEscalation(primaryRes) || prefGemModel === 'gemini-3.8-flash') {
                parsed = primaryRes;
              } else {
                try {
                  parsed = await runWorkerGemini('flash38_only');
                } catch (_) {
                  if (dKey) {
                    try { parsed = await runWorkerDeepSeek(); } catch (__) {}
                  }
                  if (!parsed) parsed = primaryRes;
                }
              }
            } catch (e) {
              if (e.statusCode === 400 && !dKey) throw e;
              errs.push(e.message);
            }
          }
          if (!parsed && dKey) {
            try { parsed = await runWorkerDeepSeek(); }
            catch (e) { errs.push(e.message); }
          }
          if (!parsed) throw new Error(errs.join(' | '));
        } else {
          const errs = [];
          if (gKey) {
            try {
              parsed = await runWorkerGemini('accurate');
            }
            catch (e) { if (e.statusCode === 400 && !dKey) throw e; errs.push(e.message); }
          }
          if (!parsed && dKey) {
            try { parsed = await runWorkerDeepSeek(); }
            catch (e) { errs.push(e.message); }
          }
          if (!parsed) throw new Error(errs.join(' | '));
        }

        validateAndNormalizeOcrData(parsed, body);
        return Response.json({ success: true, data: parsed }, { headers: CORS_HEADERS });
      } catch (err) {
        return Response.json({ success: false, error: err.message }, { status: err.statusCode || 500, headers: CORS_HEADERS });
      }
    }

    // Edge API: Cross-Device Room Messaging & Data Sharing (/api/room-messages)
    if (path === '/api/room-messages') {
      const ROOM_RESP_HEADERS = {
        ...CORS_HEADERS,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache'
      };
      try {
        if (request.method === 'GET') {
          const room = normalizeWorkerRoomCode(url.searchParams.get('room'));
          const since = Number(url.searchParams.get('since') || 0);
          const metaOnly = url.searchParams.get('metaOnly') === '1';
          const peerId = String(url.searchParams.get('peerId') || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
          const peerName = String(url.searchParams.get('peerName') || 'ডিভাইস').slice(0, 50);
          const peerClient = String(url.searchParams.get('peerClient') || 'web').slice(0, 24);
          const nowMs = Date.now();

          let metaJson = null;
          if (peerId) {
            metaJson = await touchWorkerRoomPeer(room, peerId, peerName, peerClient, nowMs);
          }
          if (!metaJson) {
            const metaRes = await fetch(\`\${FIRESTORE_ROOMS_BASE}/\${encodeURIComponent(room)}?t=\${nowMs}\`, {
              headers: { 'Cache-Control': 'no-cache' }
            });
            metaJson = metaRes.ok ? await metaRes.json().catch(() => ({})) : {};
          }
          const mf = metaJson?.fields || {};
          const clearedAtMs = Number(mf.cleared_at_ms?.integerValue || 0);
          const meta = {
            room,
            last_msg_id: mf.last_msg_id?.stringValue || '',
            last_sender: mf.last_sender?.stringValue || '',
            last_preview: mf.last_preview?.stringValue || '',
            cleared_at_ms: clearedAtMs
          };
          const peers = extractWorkerActivePeers(mf, nowMs);
          if (metaOnly) {
            return Response.json({ success: true, room, meta, peers }, { headers: ROOM_RESP_HEADERS });
          }
          const listRes = await fetch(\`\${FIRESTORE_ROOMS_BASE}/\${encodeURIComponent(room)}/messages?pageSize=100&t=\${nowMs}\`, {
            headers: { 'Cache-Control': 'no-cache' }
          });
          const listJson = listRes.ok ? await listRes.json().catch(() => ({})) : {};
          const docs = Array.isArray(listJson.documents) ? listJson.documents : [];
          let messages = docs.map((d) => {
            const f = d.fields || {};
            return normalizeWorkerRoomMsg({
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
          }).filter((m) => m.ts > clearedAtMs && (since <= 0 || m.ts > since)).sort((a, b) => a.ts - b.ts);
          return Response.json({ success: true, room, meta, peers, messages }, { headers: ROOM_RESP_HEADERS });
        }

        if (request.method === 'POST') {
          const body = await request.json();
          const room = normalizeWorkerRoomCode(body.room || url.searchParams.get('room'));
          const nowMs = Date.now();
          const peerId = String(body.peerId || body.senderId || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
          const peerName = String(body.peerName || body.senderName || 'ডিভাইস').slice(0, 50);
          const peerClient = String(body.peerClient || body.senderClient || 'web').slice(0, 24);

          if (body.type === 'presence' || body.presenceOnly) {
            let metaJson = peerId ? await touchWorkerRoomPeer(room, peerId, peerName, peerClient, nowMs) : null;
            if (!metaJson) {
              const metaRes = await fetch(\`\${FIRESTORE_ROOMS_BASE}/\${encodeURIComponent(room)}?t=\${nowMs}\`, {
                headers: { 'Cache-Control': 'no-cache' }
              });
              metaJson = metaRes.ok ? await metaRes.json().catch(() => ({})) : {};
            }
            const mf = metaJson?.fields || {};
            const meta = {
              room,
              last_msg_id: mf.last_msg_id?.stringValue || '',
              last_sender: mf.last_sender?.stringValue || '',
              last_preview: mf.last_preview?.stringValue || '',
              cleared_at_ms: Number(mf.cleared_at_ms?.integerValue || 0)
            };
            const peers = extractWorkerActivePeers(mf, nowMs);
            return Response.json({ success: true, room, presence: true, meta, peers }, { headers: ROOM_RESP_HEADERS });
          }

          const msg = normalizeWorkerRoomMsg(body, room);
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
          const writeRes = await fetch(\`\${FIRESTORE_ROOMS_BASE}/\${encodeURIComponent(msg.room)}/messages/\${encodeURIComponent(msg.id)}\`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields })
          });
          if (!writeRes.ok) {
            const errTxt = await writeRes.text().catch(() => '');
            return Response.json({ success: false, error: \`Room store error (\${writeRes.status}): \${errTxt}\` }, { status: 502, headers: ROOM_RESP_HEADERS });
          }
          const preview = (msg.text || (msg.type === 'nid_data' ? (msg.payload?.name_bn || msg.payload?.doc_number || 'NID ডেটা') : 'বার্তা')).slice(0, 120);
          const metaFields = {
            room: { stringValue: msg.room },
            last_msg_id: { stringValue: msg.id },
            last_sender: { stringValue: msg.senderName || '' },
            last_preview: { stringValue: preview },
            updated_at: { timestampValue: new Date().toISOString() }
          };
          const maskPaths = ['room', 'last_msg_id', 'last_sender', 'last_preview', 'updated_at'];
          if (peerId) {
            metaFields.peers = {
              mapValue: {
                fields: {
                  [peerId]: {
                    mapValue: {
                      fields: {
                        name: { stringValue: peerName },
                        client: { stringValue: peerClient },
                        seenAt: { integerValue: String(nowMs) }
                      }
                    }
                  }
                }
              }
            };
            maskPaths.push('peers.' + peerId);
          }
          const metaMask = maskPaths.map(k => \`updateMask.fieldPaths=\${encodeURIComponent(k)}\`).join('&');
          const metaPatchRes = await fetch(\`\${FIRESTORE_ROOMS_BASE}/\${encodeURIComponent(msg.room)}?\${metaMask}\`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: metaFields })
          }).catch(() => null);
          const metaPatchJson = metaPatchRes && metaPatchRes.ok ? await metaPatchRes.json().catch(() => ({})) : {};
          const peers = extractWorkerActivePeers(metaPatchJson?.fields || {}, nowMs);
          return Response.json({ success: true, room: msg.room, message: msg, peers }, { headers: ROOM_RESP_HEADERS });
        }

        if (request.method === 'DELETE') {
          const room = normalizeWorkerRoomCode(url.searchParams.get('room'));
          const clearedAt = Date.now();
          const metaFields = {
            room: { stringValue: room },
            last_msg_id: { stringValue: '' },
            cleared_at_ms: { integerValue: String(clearedAt) },
            updated_at: { timestampValue: new Date().toISOString() }
          };
          const metaMask = Object.keys(metaFields).map(k => \`updateMask.fieldPaths=\${encodeURIComponent(k)}\`).join('&');
          await fetch(\`\${FIRESTORE_ROOMS_BASE}/\${encodeURIComponent(room)}?\${metaMask}\`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: metaFields })
          });
          const listRes = await fetch(\`\${FIRESTORE_ROOMS_BASE}/\${encodeURIComponent(room)}/messages?pageSize=100&t=\${clearedAt}\`, {
            headers: { 'Cache-Control': 'no-cache' }
          });
          const listJson = listRes.ok ? await listRes.json().catch(() => ({})) : {};
          const docs = Array.isArray(listJson.documents) ? listJson.documents : [];
          await Promise.all(docs.slice(0, 40).map((d) => fetch(\`https://firestore.googleapis.com/v1/\${d.name}\`, { method: 'DELETE' }).catch(() => null)));
          return Response.json({ success: true, room, cleared: docs.length, clearedAt }, { headers: ROOM_RESP_HEADERS });
        }
      } catch (err) {
        return Response.json({ success: false, error: err.message }, { status: 500, headers: ROOM_RESP_HEADERS });
      }
    }

    // Health check endpoint
    if (path === '/api/info') {
      return Response.json({
        status: 'online',
        edge: 'cloudflare-worker',
        providers: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'deepseek-flash'],
        bdtPerUsd: BDT_PER_USD,
        deepSeekPeakNow: isDeepSeekPeakUtc(),
        pricing: AI_MODEL_CATALOG,
        features: ['room_messaging', 'cloud_room_sync', 'nid_data_share', 'summary_share'],
        upstream: ORIGIN_BASE
      }, { headers: CORS_HEADERS });
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
    if (targetPath.startsWith('/bookmarklet/') || targetPath === '/index.html' || targetPath === '/app.js' || targetPath === '/style.css') {
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
