// Cloudflare Worker for familycard.afridi.app & familycard.fourdevs-pro.workers.dev
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
  return `m_${String(ts).padStart(14, '0')}_${rand}`;
}

function normalizeWorkerRoomMsg(raw = {}, fallbackRoom = 'FC-101') {
  const ts = Number(raw.ts) > 0 ? Number(raw.ts) : Date.now();
  const room = normalizeWorkerRoomCode(raw.room || fallbackRoom);
  const type = ['text', 'nid_data', 'summary', 'system', 'survey_house_saved', 'survey_timer_ended'].includes(raw.type) ? raw.type : 'text';
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
  const res = await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}?updateMask.fieldPaths=room&updateMask.fieldPaths=peers.${encodeURIComponent(cleanId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  }).catch(() => null);
  return res && res.ok ? await res.json().catch(() => null) : null;
}

const BDT_PER_USD = 122;

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const INTERACTIONS_API_MODELS = new Set(['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon']);

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
  const spec = AI_MODEL_CATALOG[key] || AI_MODEL_CATALOG[DEFAULT_GEMINI_MODEL];
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

  const hasStdRates = Boolean(spec.introUntilUtcMs && spec.stdInputPer1M);
  const isIntro = hasStdRates && nowMs < spec.introUntilUtcMs;
  const inRate = hasStdRates ? (isIntro ? spec.inputPer1M : spec.stdInputPer1M) : spec.inputPer1M;
  const outRate = hasStdRates ? (isIntro ? spec.outputPer1M : spec.stdOutputPer1M) : spec.outputPer1M;
  const cacheRate = hasStdRates ? (isIntro ? spec.cacheReadPer1M : spec.stdCacheReadPer1M) : spec.cacheReadPer1M;
  const uncachedIn = Math.max(0, inputTokens - cachedTokens);
  const costUsd = (uncachedIn * inRate + cachedTokens * cacheRate + outputTokens * outRate) / 1e6;

  return {
    model: key,
    label: spec.label,
    provider: 'gemini',
    tierWindow: hasStdRates ? (isIntro ? 'intro_2026' : 'standard') : 'tier1',
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

const FIRESTORE_ERROR_LOGS_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/fc_error_logs';

function hasBengaliScript(str) {
  return /[\u0980-\u09FF]/.test(String(str || ''));
}

const BN_NAME_WORD_MAP = {
  'মোঃ': 'MD.', 'মো:': 'MD.', 'মো.': 'MD.', 'মোহাম্মদ': 'MOHAMMAD', 'মোহাম্মাদ': 'MOHAMMAD', 'মুহাম্মদ': 'MUHAMMAD', 'মুহাম্মাদ': 'MUHAMMAD',
  'মোছাঃ': 'MST.', 'মোছা:': 'MST.', 'মোছা.': 'MST.', 'মোসাম্মাৎ': 'MOSAMMAT', 'মোসাম্মৎ': 'MOSAMMAT', 'মোসাম্মত': 'MOSAMMAT', 'মোসাঃ': 'MOSA.', 'মোসা.': 'MOSA.', 'মোসা:': 'MOSA.',
  'শ্রী': 'SRI', 'শ্রীমতী': 'SRIMOTI', 'মৃত': 'LATE', 'হাজী': 'HAJI', 'হাজি': 'HAJI',
  'শেখ': 'SHEIKH', 'সৈয়দ': 'SYED', 'সৈয়দ': 'SYED', 'কাজী': 'KAZI', 'কাজি': 'KAZI', 'মির্জা': 'MIRZA', 'গাজী': 'GAZI', 'গাজি': 'GAZI',
  'খন্দকার': 'KHANDAKER', 'খোন্দকার': 'KHONDKER', 'চৌধুরী': 'CHOWDHURY', 'মজুমদার': 'MAJUMDER', 'তালুকদার': 'TALUKDER',
  'সরকার': 'SARKAR', 'মন্ডল': 'MONDAL', 'মণ্ডল': 'MONDAL', 'বিশ্বাস': 'BISWAS', 'শিকদার': 'SHIKDER', 'সিকদার': 'SIKDER',
  'ভূঁইয়া': 'BHUIYAN', 'ভুইয়া': 'BHUIYAN', 'ভূইয়া': 'BHUIYAN', 'ভূঁইয়া': 'BHUIYAN', 'ভুঁইয়া': 'BHUIYAN', 'পাটোয়ারী': 'PATWARY', 'পাটোয়ারী': 'PATWARY',
  'মোল্লা': 'MOLLA', 'বেপারী': 'BEPARI', 'ব্যাপারী': 'BEPARI', 'মাতুব্বর': 'MATUBBAR', 'সাহা': 'SAHA', 'বড়ুয়া': 'BARUA', 'বড়ুয়া': 'BARUA',
  'হোসেন': 'HOSSAIN', 'হোসাইন': 'HOSSAIN', 'হোসনে': 'HOSNE', 'ইসলাম': 'ISLAM', 'আহমেদ': 'AHMED',
  'আহম্মেদ': 'AHMED', 'আহমদ': 'AHMED', 'আহম্মদ': 'AHMED', 'রহমান': 'RAHMAN', 'করিম': 'KARIM',
  'রহিম': 'RAHIM', 'আলী': 'ALI', 'আলি': 'ALI', 'খাতুন': 'KHATUN', 'বেগম': 'BEGUM', 'বিবি': 'BIBI', 'বানু': 'BANU', 'নেছা': 'NESSA', 'নেসা': 'NESA',
  'আক্তার': 'AKTER', 'আখতার': 'AKHTAR', 'সুলতানা': 'SULTANA', 'জাহান': 'JAHAN',
  'ইয়াসমিন': 'YASMIN', 'ইয়াসমিন': 'YASMIN', 'পারভীন': 'PARVIN', 'পারভিন': 'PARVIN',
  'নাহার': 'NAHAR', 'রফিকুল': 'RAFIQUL', 'শফিকুল': 'SHAFIQUL', 'তরিকুল': 'TARIQUL', 'তৌহিদুল': 'TOUHIDUL', 'সিরাজুল': 'SIRAJUL', 'রফিক': 'RAFIQ', 'শফিক': 'SHAFIQ',
  'আব্দুল': 'ABDUL', 'আবদুল': 'ABDUL', 'আব্দুর': 'ABDUR', 'আবদুর': 'ABDUR', 'আব্দুস': 'ABDUS', 'আবুল': 'ABUL',
  'আব্দুল্লাহ': 'ABDULLAH', 'আবদুল্লাহ': 'ABDULLAH', 'আবু': 'ABU', 'হাসান': 'HASAN', 'হাছান': 'HASAN',
  'হাবিব': 'HABIB', 'হাবিবুর': 'HABIBUR', 'কবির': 'KABIR', 'হুমায়ুন': 'HUMAYUN', 'হুমায়ুন': 'HUMAYUN', 'নজরুল': 'NAZRUL', 'কামাল': 'KAMAL',
  'জামাল': 'JAMAL', 'আলম': 'ALAM', 'মিয়া': 'MIA', 'মিয়া': 'MIA', 'মিঞা': 'MIA', 'মুন্সি': 'MUNSHI',
  'মুন্সী': 'MUNSHI', 'মোস্তফা': 'MOSTAFA', 'সালাম': 'SALAM', 'মজিদ': 'MAJID',
  'হাকিম': 'HAKIM', 'হালিম': 'HALIM', 'রশিদ': 'RASHID', 'লতিফ': 'LATIF', 'খালিদ': 'KHALID', 'খালেদ': 'KHALED',
  'জব্বার': 'JABBAR', 'সাত্তার': 'SATTAR', 'গফুর': 'GAFUR', 'মান্নান': 'MANNAN',
  'হান্নান': 'HANNAN', 'মনির': 'MONIR', 'মনিরুল': 'MONIRUL', 'নূর': 'NUR', 'নুর': 'NUR', 'নূরুল': 'NURUL', 'নুরুল': 'NURUL',
  'রুহুল': 'RUHUL', 'আমিন': 'AMIN', 'আমিনুল': 'AMINUL', 'শহীদ': 'SHAHID', 'শহিদ': 'SHAHID', 'শহীদুল': 'SHAHIDUL', 'শহিদুল': 'SHAHIDUL',
  'মাহমুদ': 'MAHMUD', 'মাহমুদুল': 'MAHMUDUL', 'রাসেল': 'RASEL', 'রিপন': 'RIPON', 'সজীব': 'SAJIB', 'সজিব': 'SAJIB',
  'তানভীর': 'TANVIR', 'তানভির': 'TANVIR', 'সাকিব': 'SAKIB', 'শাকিব': 'SAKIB', 'শাকিল': 'SHAKIL',
  'আরিফ': 'ARIF', 'আরিফুল': 'ARIFUL', 'আশরাফ': 'ASHRAF', 'আশরাফুল': 'ASHRAFUL', 'ফারুক': 'FARUK', 'ফজলুল': 'FAZLUL',
  'মশিউর': 'MOSHIUR', 'মাহবুব': 'MAHBUB', 'মাহবুবুর': 'MAHBUBUR', 'আনোয়ার': 'ANOWAR', 'আনোয়ার': 'ANOWAR',
  'দেলোয়ার': 'DELOWAR', 'দেলোয়ার': 'DELOWAR', 'মনোয়ার': 'MONOWAR', 'মনোয়ার': 'MONOWAR',
  'সরোয়ার': 'SAROWAR', 'সরোয়ার': 'SAROWAR', 'জাহাঙ্গীর': 'JAHANGIR', 'জাহাংগীর': 'JAHANGIR',
  'আলমগীর': 'ALAMGIR', 'শাহীন': 'SHAHIN', 'শাহিন': 'SHAHIN', 'শাহজাহান': 'SHAHJAHAN', 'সোহাগ': 'SOHAG',
  'ইব্রাহিম': 'IBRAHIM', 'ইব্রাহীম': 'IBRAHIM', 'ইসমাইল': 'ISMAIL', 'ইউসুফ': 'YUSUF',
  'ইউনুস': 'YUNUS', 'ইয়াকুব': 'YAKUB', 'ইয়াকুব': 'YAKUB', 'সোলাইমান': 'SULAIMAN', 'হক': 'HAQUE',
  'বেলাল': 'BELAL', 'জালাল': 'JALAL', 'দুলাল': 'DULAL',
  'ফাতেমা': 'FATEMA', 'আয়েশা': 'AYESHA', 'আয়েশা': 'AYESHA', 'খাদিজা': 'KHADIJA',
  'মরিয়ম': 'MARIYAM', 'মরিয়ম': 'MARIYAM', 'সুমাইয়া': 'SUMAIYA', 'সুমাইয়া': 'SUMAIYA',
  'তাসনিম': 'TASNIM', 'নুসরাত': 'NUSRAT', 'শারমিন': 'SHARMIN', 'রোকসানা': 'ROKSANA', 'ফারজানা': 'FARZANA', 'তানিয়া': 'TANIA', 'তানিয়া': 'TANIA',
  'সালমা': 'SALMA', 'হালিমা': 'HALIMA', 'সখিনা': 'SAKHINA', 'সকিনা': 'SAKINA', 'জামিলা': 'JAMILA', 'জাহানারা': 'JAHANARA', 'সাহারা': 'SAHARA',
  'আনোয়ারা': 'ANOWARA', 'আনোয়ারা': 'ANOWARA', 'মনোয়ারা': 'MONOWARA', 'মনোয়ারা': 'MONOWARA',
  'রেহানা': 'REHANA', 'শাহানা': 'SHAHANA', 'রুবিনা': 'RUBINA', 'শিরিন': 'SHIRIN',
  'তাসলিমা': 'TASLIMA', 'বিলকিস': 'BILKIS', 'রাবেয়া': 'RABEYA', 'রাবেয়া': 'RABEYA', 'সালেহা': 'SALEHA', 'নূরজাহান': 'NURJAHAN', 'নুরজাহান': 'NURJAHAN',
  'লায়লা': 'LAYLA', 'লায়লা': 'LAYLA', 'রানী': 'RANI', 'রাণী': 'RANI', 'দেবী': 'DEVI',
  'দাস': 'DAS', 'দাশ': 'DAS', 'পাল': 'PAL', 'রায়': 'ROY', 'রায়': 'ROY', 'সেন': 'SEN', 'ঘোষ': 'GHOSH', 'বসু': 'BASU', 'বর্মন': 'BARMAN',
  'দত্ত': 'DUTTA', 'হালদার': 'HALDER', 'মল্লিক': 'MALLICK', 'প্রামাণিক': 'PRAMANIK', 'শর্মা': 'SHARMA', 'চক্রবর্তী': 'CHAKRABORTY', 'চন্দ্র': 'CHANDRA',
  'ফকির': 'FAKIR', 'মৃধা': 'MRIDHA', 'হাওলাদার': 'HOWLADER', 'সরদার': 'SARDAR', 'তরফদার': 'TARAFDAR',
  'খান': 'KHAN', 'খাঁ': 'KHAN', 'উদ্দিন': 'UDDIN', 'উদ্দীন': 'UDDIN', 'আহসান': 'AHSAN', 'সাঈদ': 'SAID',
  'বাচ্চু': 'BACHCHU', 'বাবুল': 'BABUL', 'মিজানুর': 'MIZANUR', 'মজিবুর': 'MUJIBUR', 'আনিছুর': 'ANISUR', 'আনিসুর': 'ANISUR', 'সাইফুল': 'SAIFUL',
  'নাজমুল': 'NAZMUL', 'কামরুল': 'KAMRUL', 'জহিরুল': 'ZAHIRUL', 'জহির': 'ZAHIR',
  'আজিজ': 'AZIZ', 'আজিজুল': 'AZIZUL', 'তৌহিদ': 'TOWHID',
  'হামিদ': 'HAMID', 'হামিদুল': 'HAMIDUL', 'খালেক': 'KHALEQ', 'মালেক': 'MALEK',
  'সিদ্দিক': 'SIDDIK', 'সিদ্দিকুর': 'SIDDIQUR', 'মোতালেব': 'MOTALEB', 'মোশাররফ': 'MOSHARRAF',
  'সেলিম': 'SELIM', 'সোহেল': 'SOHEL', 'সুমন': 'SUMON', 'মাসুদ': 'MASUD', 'জসিম': 'JASIM', 'হেলাল': 'HELAL',
  'সুজন': 'SUJAN', 'পলাশ': 'PALASH', 'জহুরুল': 'ZAHURUL', 'আকবর': 'AKBAR', 'আসাদ': 'ASAD', 'আসলাম': 'ASLAM',
  'বোরহান': 'BORHAN', 'বশির': 'BASHIR', 'কাদের': 'KADER', 'রেজা': 'REZA', 'রেজাউল': 'REZAUL',
  'রবিউল': 'RABIUL', 'শামীম': 'SHAMIM', 'শামিম': 'SHAMIM', 'শরীফ': 'SHARIF', 'শরিফ': 'SHARIF', 'শরিফুল': 'SHARIFUL',
  'জিয়া': 'ZIA', 'জিয়া': 'ZIA', 'জিয়াউর': 'ZIAUR', 'জিয়াউর': 'ZIAUR', 'খলিল': 'KHALIL', 'খলিলুর': 'KHALILUR',
  'ফয়সাল': 'FAISAL', 'ফয়সাল': 'FAISAL', 'ইমরান': 'IMRAN', 'মেহেদী': 'MEHEDI', 'মেহেদি': 'MEHEDI',
  'রাকিব': 'RAKIB', 'রাকিবুল': 'RAKIBUL', 'মামুন': 'MAMUN', 'সোহান': 'SOHAN', 'সোহানুর': 'SOHANUR',
  'ফারহানা': 'FARHANA', 'রুমানা': 'RUMANA', 'সাবিনা': 'SABINA', 'তাহমিনা': 'TAHMINA', 'রাজিয়া': 'RAZIA', 'রাজিয়া': 'RAZIA',
  'নাজমা': 'NAZMA', 'সাজিদা': 'SAJIDA', 'ফরিদা': 'FARIDA', 'মাহফুজা': 'MAHFUZA', 'নাসরিন': 'NASRIN', 'নাসরীন': 'NASRIN',
  'জোহরা': 'ZOHRA', 'মমতাজ': 'MOMTAZ', 'আমেনা': 'AMENA', 'হাজেরা': 'HAJERA', 'খোদেজা': 'KHODEJA', 'রাহেলা': 'RAHELA',
  'শামসুন্নাহার': 'SHAMSUNNAHAR', 'রোকেয়া': 'ROKEYA', 'রোকেয়া': 'ROKEYA', 'জান্নাত': 'JANNAT', 'জান্নাতুল': 'JANNATUL',
  'ফেরদৌস': 'FERDOUS', 'ফেরদৌসী': 'FERDOUSI', 'আসমা': 'ASMA', 'নাসিমা': 'NASIMA', 'হাসিনা': 'HASINA',
  'জাকির': 'ZAKIR', 'জাহিদ': 'ZAHID', 'জাহিদুল': 'ZAHIDUL', 'জোনায়েদ': 'ZUNAID', 'জুনায়েদ': 'ZUNAID',
  'খায়রুল': 'KHAYRUL', 'খায়রুল': 'KHAYRUL', 'বদরুল': 'BADRUL', 'মফিজ': 'MAFIZ', 'মফিজুল': 'MAFIZUL',
  'চাকমা': 'CHAKMA', 'মারমা': 'MARMA', 'ত্রিপুরা': 'TRIPURA', 'তঞ্চঙ্গ্যা': 'TANCHANGYA'
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
  let lastConsStartIdx = 0;
  let lastWasVowel = true;
  while (i < bare.length) {
    const ch = bare[i];
    if (bare.slice(i, i + 3) === 'ক্ষ') {
      out += i === 0 ? 'KH' : 'KSH';
      i += 3;
      const nextCh = bare[i] || '';
      if (!kars[nextCh] && nextCh !== '্' && i < bare.length && cons[nextCh]) { out += 'A'; lastWasVowel = true; } else { lastWasVowel = Boolean(kars[nextCh]); }
      continue;
    }
    if (bare.slice(i, i + 3) === 'জ্ঞ') {
      out += 'GY';
      i += 3;
      const nextCh = bare[i] || '';
      if (!kars[nextCh] && nextCh !== '্' && i < bare.length && cons[nextCh]) { out += 'A'; lastWasVowel = true; } else { lastWasVowel = Boolean(kars[nextCh]); }
      continue;
    }
    if (indVowels[ch]) { out += indVowels[ch]; lastWasVowel = true; i++; continue; }
    if (kars[ch]) { out += kars[ch]; lastWasVowel = true; i++; continue; }
    if (ch === 'ং') { out += 'NG'; lastWasVowel = false; i++; continue; }
    if (ch === 'ঃ') { out += i === bare.length - 1 ? '' : 'H'; lastWasVowel = false; i++; continue; }
    if (ch === 'ঁ') { i++; continue; }
    if (ch === '্') {
      const nextC = bare[i + 1] || '';
      if (nextC === 'য') { out += 'Y'; i += 2; lastWasVowel = false; continue; }
      if (nextC === 'র') {
        out += 'R';
        i += 2;
        const afterCluster = bare[i] || '';
        if (!kars[afterCluster] && afterCluster !== '্' && afterCluster !== 'ং' && afterCluster !== 'ঃ' && i < bare.length && cons[afterCluster]) {
          out += 'A';
          lastWasVowel = true;
        } else {
          lastWasVowel = false;
        }
        continue;
      }
      if (nextC === 'ব') {
        if (lastConsStartIdx === 0 || (lastConsStartIdx > 0 && cons[bare[i - 1]])) out += 'W';
        i += 2;
        const afterCluster = bare[i] || '';
        if (lastConsStartIdx === 0 && !kars[afterCluster] && afterCluster !== '্' && afterCluster !== 'ং' && afterCluster !== 'ঃ' && i < bare.length && cons[afterCluster]) {
          out += 'A';
          lastWasVowel = true;
        } else {
          lastWasVowel = false;
        }
        continue;
      }
      lastWasVowel = false;
      i++;
      continue;
    }
    if (cons[ch]) {
      if (ch === 'র' && bare[i + 1] === '্' && cons[bare[i + 2]]) {
        out += 'R' + cons[bare[i + 2]];
        i += 3;
        const afterCluster = bare[i] || '';
        if (!kars[afterCluster] && afterCluster !== '্' && i < bare.length && cons[afterCluster]) { out += 'A'; lastWasVowel = true; } else { lastWasVowel = false; }
        continue;
      }
      lastConsStartIdx = i;
      out += (ch === 'য' && i > 0) ? 'J' : cons[ch];
      const nextCh = bare[i + 1] || '';
      if (!kars[nextCh] && nextCh !== '্' && nextCh !== 'ং' && nextCh !== 'ঃ' && ch !== 'ৎ') {
        const afterNext = bare[i + 2] || '';
        const shouldInsertInherentA =
          i + 1 < bare.length &&
          (cons[nextCh] || (!indVowels[nextCh] && i + 2 < bare.length)) &&
          !(nextCh === 'ম' && !afterNext && bare[i] !== 'ত' && out.length > 2) &&
          !(lastWasVowel === false && i > 1 && !kars[bare[i - 1]]);
        if (shouldInsertInherentA) { out += 'A'; lastWasVowel = true; } else { lastWasVowel = false; }
      } else {
        lastWasVowel = false;
      }
      i++;
      continue;
    }
    out += /[A-Za-z0-9.\-]/.test(ch) ? ch.toUpperCase() : '';
    i++;
  }
  return out.replace(/AAA+/g, 'A').replace(/AA+/g, 'A').trim();
}

function normalizeEnglishHonorificPrefix(enName, bnName) {
  if (!enName) return enName;
  let res = String(enName).trim();
  const bn = String(bnName || '').trim();
  const fullFemaleWordRe = /^(?:MOSAMMAT|MOSAMMOT)\b/i;
  const fullMaleWordRe = /^(?:MOHAMMAD|MOHAMMED|MUHAMMAD|MUHAMMED)\b/i;
  const mstPrefixRe = /^(?:(?:MOST|MST|MOSA)\s+|(?:MOST|MST|MOSA)\.(?:\s*|(?=[A-Z])))/i;
  const mdPrefixRe = /^(?:(?:MD|MOHD)\s+|(?:MD|MOHD)\.(?:\s*|(?=[A-Z])))/i;
  const mosaPrefixRe = /^(?:MOSA\s+|MOSA\.(?:\s*|(?=[A-Z])))/i;

  // Preserve full printed legal honorific words (MOHAMMAD / MOSAMMAT) verbatim
  if (fullFemaleWordRe.test(res) || fullMaleWordRe.test(res)) {
    return res.toUpperCase().replace(/\s+/g, ' ').trim();
  }

  // 1. If Bengali starts with মোছাঃ / মোছা: / মোছা. / মোছা
  if (/^(?:মোছাঃ|মোছা:|মোছা\.|মোছা\s+)/.test(bn)) {
    if (mstPrefixRe.test(res)) {
      res = res.replace(mstPrefixRe, 'MST. ');
    } else {
      res = 'MST. ' + res;
    }
  }
  // 2. Else if Bengali starts with মোঃ / মো: / মো. / মো
  else if (/^(?:মোঃ|মো:|মো\.|মো\s+)/.test(bn)) {
    if (mdPrefixRe.test(res)) {
      res = res.replace(mdPrefixRe, 'MD. ');
    } else {
      res = 'MD. ' + res;
    }
  }
  // 3. Else if Bengali starts with মোসাঃ / মোসা: / মোসা. / মোসা
  else if (/^(?:মোসাঃ|মোসা:|মোসা\.|মোসা\s+)/.test(bn)) {
    if (mosaPrefixRe.test(res)) {
      res = res.replace(mosaPrefixRe, 'MOSA. ');
    } else if (!/^MST\.(?:\s*|(?=[A-Z]))/i.test(res)) {
      res = 'MOSA. ' + res;
    }
  }
  // 4. Standalone abbreviated English prefixes without Bengali match
  else if (/^(?:MOST\s+|(?:MOST|MST)\.(?:\s*|(?=[A-Z])))/i.test(res)) {
    res = res.replace(/^(?:MOST\s+|(?:MOST|MST)\.(?:\s*|(?=[A-Z])))/i, 'MST. ');
  } else if (/^(?:MD\s+|MD\.(?:\s*|(?=[A-Z])))/i.test(res)) {
    res = res.replace(/^(?:MD\s+|MD\.(?:\s*|(?=[A-Z])))/i, 'MD. ');
  }

  return res.toUpperCase().replace(/\s+/g, ' ').trim();
}

function transliterateBnToEn(bnText) {
  if (!bnText) return '';
  const cleaned = String(bnText).normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!cleaned) return '';
  if (!hasBengaliScript(cleaned)) return normalizeDigits(cleaned).toUpperCase().replace(/\s+/g, ' ').trim();

  let working = cleaned;
  let prefix = '';
  if (/^(?:মোছাঃ|মোছা:|মোছা\.|মোছা\s+)/.test(working)) {
    prefix = 'MST. ';
    working = working.replace(/^(?:মোছাঃ|মোছা:|মোছা\.|মোছা\s+)/, '');
  } else if (/^(?:মোঃ|মো:|মো\.|মো\s+)/.test(working)) {
    prefix = 'MD. ';
    working = working.replace(/^(?:মোঃ|মো:|মো\.|মো\s+)/, '');
  } else if (/^(?:মোসাঃ|মোসা:|মোসা\.|মোসা\s+)/.test(working)) {
    prefix = 'MOSA. ';
    working = working.replace(/^(?:মোসাঃ|মোসা:|মোসা\.|মোসা\s+)/, '');
  }

  const converted = working
    .split(/\s+/)
    .map(transliterateBnWordToEn)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (prefix + converted).trim();
}

const EN_NAME_WORD_MAP = (() => {
  const m = {};
  for (const [bnW, enW] of Object.entries(BN_NAME_WORD_MAP)) {
    const key = String(enW || '').toUpperCase().trim();
    const cleanKey = key.replace(/\.+$/, '');
    if (key && !m[key]) m[key] = bnW;
    if (cleanKey && !m[cleanKey]) m[cleanKey] = bnW;
  }
  return {
    ...m,
    'MD.': 'মোঃ', 'MD': 'মোঃ', 'MOHAMMAD': 'মোহাম্মদ', 'MOHAMMED': 'মোহাম্মদ', 'MUHAMMAD': 'মুহাম্মদ',
    'MOSAMMAT': 'মোছাঃ', 'MOST.': 'মোছাঃ', 'MOST': 'মোছাঃ', 'MST.': 'মোছাঃ', 'MST': 'মোছাঃ',
    'SRI': 'শ্রী', 'SRIMOTI': 'শ্রীমতী', 'SHREE': 'শ্রী', 'LATE': 'মৃত', 'HAJI': 'হাজী',
    'HOSSAIN': 'হোসেন', 'HOSSAINE': 'হোসেন', 'HOSEN': 'হোসেন', 'HASAN': 'হাসান', 'HASSAN': 'হাসান',
    'RAHMAN': 'রহমান', 'ROHMAN': 'রহমান', 'ISLAM': 'ইসলাম', 'AHMED': 'আহমেদ', 'AHMAD': 'আহমদ', 'AHAMMED': 'আহম্মেদ',
    'KARIM': 'করিম', 'RAHIM': 'রহিম', 'ALI': 'আলী', 'KHAN': 'খান', 'UDDIN': 'উদ্দিন',
    'ABDUL': 'আব্দুল', 'ABDUR': 'আব্দুর', 'ABDULLAH': 'আব্দুল্লাহ', 'ABU': 'আবু', 'ABUL': 'আবুল',
    'CHOWDHURY': 'চৌধুরী', 'SARKAR': 'সরকার', 'SARKER': 'সরকার', 'SERKER': 'সরকার',
    'TALUKDER': 'তালুকদার', 'TALUKDAR': 'তালুকদার', 'MAJUMDER': 'মজুমদার', 'MOZUMDER': 'মজুমদার', 'MAJUMDAR': 'মজুমদার',
    'MONDAL': 'মন্ডল', 'MANDAL': 'মন্ডল', 'BISWAS': 'বিশ্বাস', 'SHEIKH': 'শেখ', 'SYED': 'সৈয়দ',
    'KHANDAKER': 'খন্দকার', 'KHONDKER': 'খোন্দকার', 'KHONDAKAR': 'খন্দকার', 'KAZI': 'কাজী', 'MIRZA': 'মির্জা', 'GAZI': 'গাজী',
    'SHIKDER': 'শিকদার', 'SIKDER': 'সিকদার', 'SIKDAR': 'সিকদার', 'BHUIYAN': 'ভূঁইয়া', 'BHUIYA': 'ভুইয়া',
    'PATWARY': 'পাটোয়ারী', 'HOWLADER': 'হাওলাদার', 'HAWLADAR': 'হাওলাদার', 'SARDAR': 'সরদার', 'SARDER': 'সরদার',
    'FAKIR': 'ফকির', 'MRIDHA': 'মৃধা', 'PRAMANIK': 'প্রামাণিক', 'MALLICK': 'মল্লিক', 'MOLLA': 'মোল্লা', 'MOLLAH': 'মোল্লা',
    'BEPARI': 'বেপারী', 'MATUBBAR': 'মাতুব্বর', 'SAHA': 'সাহা', 'BARUA': 'বড়ুয়া', 'BORUA': 'বড়ুয়া',
    'KHATUN': 'খাতুন', 'BEGUM': 'বেগম', 'AKTER': 'আক্তার', 'AKHTER': 'আক্তার', 'AKTAR': 'আক্তার', 'AKHTAR': 'আক্তার',
    'SULTANA': 'সুলতানা', 'JAHAN': 'জাহান', 'YASMIN': 'ইয়াসমিন', 'YEASMIN': 'ইয়াসমিন', 'YESMIN': 'ইয়াসমিন',
    'PARVIN': 'পারভীন', 'PARVEEN': 'পারভীন', 'NAHAR': 'নাহার', 'FATEMA': 'ফাতেমা', 'FATIMA': 'ফাতিমা',
    'AYESHA': 'আয়েশা', 'AISHA': 'আয়েশা', 'KHADIJA': 'খাদিজা', 'MARIYAM': 'মরিয়ম', 'MORIOM': 'মরিয়ম', 'MARYAM': 'মরিয়ম',
    'SUMAIYA': 'সুমাইয়া', 'SUMIYA': 'সুমাইয়া', 'TASNIM': 'তাসনিম', 'NUSRAT': 'নুসরাত', 'SHARMIN': 'শারমিন',
    'ROKSANA': 'রোকসানা', 'ROKHSANA': 'রোখসানা', 'SALMA': 'সালমা', 'HALIMA': 'হালিমা', 'SAKHINA': 'সখিনা', 'SOKHINA': 'সখিনা',
    'JAMILA': 'জামিলা', 'ANOWARA': 'আনোয়ারা', 'ANWARA': 'আনোয়ারা', 'MONOWARA': 'মনোয়ারা', 'REHANA': 'রেহানা',
    'SHAHANA': 'শাহানা', 'RUBINA': 'রুবিনা', 'SHIRIN': 'শিরিন', 'LAYLA': 'লায়লা', 'LAILA': 'লায়লা',
    'RANI': 'রানী', 'DEVI': 'দেবী', 'DAS': 'দাস', 'PAL': 'পাল', 'PAUL': 'পাল', 'ROY': 'রায়', 'SEN': 'সেন',
    'GHOSH': 'ঘোষ', 'DUTTA': 'দত্ত', 'HALDER': 'হালদার', 'KARMAKAR': 'কর্মকার', 'KUMAR': 'কুমার', 'CHANDRA': 'চন্দ্র', 'NATH': 'নাথ',
    'MIA': 'মিয়া', 'MIYA': 'মিয়া', 'MIAH': 'মিয়া', 'MUNSHI': 'মুন্সি', 'MOSTAFA': 'মোস্তফা', 'MUSTAFA': 'মোস্তফা',
    'ALAM': 'আলম', 'ALAMGIR': 'আলমগীর', 'JAHANGIR': 'জাহাঙ্গীর', 'KAMAL': 'কামাল', 'JAMAL': 'জামাল',
    'NAZRUL': 'নজরুল', 'RAFIQUL': 'রফিকুল', 'SHAFIQUL': 'শফিকুল', 'TARIQUL': 'তরিকুল', 'RAFIQ': 'রফিক', 'SHAFIQ': 'শফিক',
    'AMIN': 'আমিন', 'AMINUL': 'আমিনুল', 'RUHUL': 'রুহুল', 'SHAHID': 'শহীদ', 'SHAHIDUL': 'শহীদুল',
    'MAHMUD': 'মাহমুদ', 'MAHMUDUL': 'মাহমুদুল', 'RASEL': 'রাসেল', 'RASHEL': 'রাসেল', 'RIPON': 'রিপন',
    'SAJIB': 'সজীব', 'SOJIB': 'সজীব', 'TANVIR': 'তানভীর', 'SAKIB': 'সাকিব', 'SHAKIB': 'শাকিব',
    'ARIF': 'আরিফ', 'ARIFUL': 'আরিফুল', 'ASHRAF': 'আশরাফ', 'ASHRAFUL': 'আশরাফুল', 'FARUK': 'ফারুক', 'FARUQ': 'ফারুক',
    'FAZLUL': 'ফজলুল', 'MOSHIUR': 'মশিউর', 'MASHIUR': 'মশিউর', 'MAHBUB': 'মাহবুব', 'MAHBUBUR': 'মাহবুবুর',
    'ANOWAR': 'আনোয়ার', 'ANWAR': 'আনোয়ার', 'DELOWAR': 'দেলোয়ার', 'DELWAR': 'দেলোয়ার',
    'MONOWAR': 'মনোয়ার', 'SAROWAR': 'সরোয়ার', 'SHAHIN': 'শাহীন', 'SHAHJAHAN': 'শাহজাহান',
    'IBRAHIM': 'ইব্রাহিম', 'ISMAIL': 'ইসমাইল', 'YUSUF': 'ইউসুফ', 'YUNUS': 'ইউনুস', 'YAKUB': 'ইয়াকুব', 'SULAIMAN': 'সোলাইমান', 'SOLAIMAN': 'সোলাইমান',
    'MIZANUR': 'মিজানুর', 'SAIFUL': 'সাইফুল', 'NAZMUL': 'নাজমুল', 'KAMRUL': 'কামরুল', 'ZAHIRUL': 'জহিরুল', 'ZAHIR': 'জহির',
    'AZIZ': 'আজিজ', 'AZIZUL': 'আজিজুল', 'TOWHID': 'তৌহিদ', 'TOWHIDUL': 'তৌহিদুল', 'HAMID': 'হামিদ', 'HAMIDUL': 'হামিদুল',
    'KHALEQ': 'খালেক', 'KHALEK': 'খালেক', 'MALEK': 'মালেক', 'SIDDIK': 'সিদ্দিক', 'SIDDIQ': 'সিদ্দিক', 'SIDDIQUR': 'সিদ্দিকুর',
    'MOTALEB': 'মোতালেব', 'MOSHARRAF': 'মোশাররফ', 'MONIR': 'মনির', 'MONIRUL': 'মনিরুল', 'NUR': 'নূর', 'NOOR': 'নূর', 'NURUL': 'নূরুল',
    'SALAM': 'সালাম', 'MAJID': 'মজিদ', 'HAKIM': 'হাকিম', 'HALIM': 'হালিম', 'RASHID': 'রশিদ', 'LATIF': 'লতিফ',
    'JABBAR': 'জব্বার', 'SATTAR': 'সাত্তার', 'GAFUR': 'গফুর', 'MANNAN': 'মান্নান', 'HANNAN': 'হান্নান',
    'KABIR': 'কবির', 'HABIB': 'হাবিব', 'AHSAN': 'আহসান', 'SAID': 'সাঈদ', 'BACHCHU': 'বাচ্চু', 'BABUL': 'বাবুল',
    'SOHEL': 'সোহেল', 'SELIM': 'সেলিম', 'SALIM': 'সলিম', 'SUMON': 'সুমন', 'MASUD': 'মাসুদ', 'JASIM': 'জসিম', 'JASHIM': 'জসিম',
    'HELAL': 'হেলাল', 'SUJON': 'সুজন', 'SUJAN': 'সুজন', 'PALASH': 'পলাশ', 'ZAHURUL': 'জহুরুল',
    'AKBAR': 'আকবর', 'ASAD': 'আসাদ', 'ASADUL': 'আসাদুল', 'ASLAM': 'আসলাম', 'BORHAN': 'বোরহান',
    'BASHIR': 'বশির', 'KADER': 'কাদের', 'QADER': 'কাদের', 'REZA': 'রেজা', 'REZAUL': 'রেজাউল', 'RABIUL': 'রবিউল', 'ROBIUL': 'রবিউল',
    'SHAMIM': 'শামীম', 'SHARIF': 'শরীফ', 'SHARIFUL': 'শরিফুল', 'ZIA': 'জিয়া', 'ZIAUR': 'জিয়াউর', 'KHALIL': 'খলিল', 'KHALILUR': 'খলিলুর',
    'FAISAL': 'ফয়সাল', 'FOYSAL': 'ফয়সাল', 'IMRAN': 'ইমরান', 'MEHEDI': 'মেহেদী', 'RAKIB': 'রাকিব', 'RAKIBUL': 'রাকিবুল',
    'MAMUN': 'মামুন', 'SOHAG': 'সোহাগ', 'SHOHAG': 'সোহাগ', 'NAHID': 'নাহিদ', 'FAHAD': 'ফাহাদ', 'EMON': 'ইমন', 'SHANTO': 'শান্ত', 'HRIDOY': 'হৃদয়',
    'FARHANA': 'ফারহানা', 'RUMANA': 'রুমানা', 'SABINA': 'সাবিনা', 'TAHMINA': 'তাহমিনা', 'RAZIA': 'রাজিয়া', 'RAZIYA': 'রাজিয়া',
    'NAZMA': 'নাজমা', 'SAJIDA': 'সাজিদা', 'FARIDA': 'ফরিদা', 'MAHFUZA': 'মাহফুজা', 'NASRIN': 'নাসরিন',
    'ZOHRA': 'জোহরা', 'MOMTAZ': 'মমতাজ', 'AMENA': 'আমেনা', 'HAJERA': 'হাজেরা', 'KHODEJA': 'খোদেজা', 'RAHELA': 'রাহেলা',
    'SHAMSUNNAHAR': 'শামসুন্নাহার', 'ROKEYA': 'রোকেয়া', 'JANNAT': 'জান্নাত', 'JANNATUL': 'জান্নাতুল',
    'FERDOUS': 'ফেরদৌস', 'FERDOUSI': 'ফেরদৌসী', 'ASMA': 'আসমা', 'NASIMA': 'নাসিমা', 'HASINA': 'হাসিনা',
    'SADIA': 'সাদিয়া', 'SADIYA': 'সাদিয়া', 'TANIA': 'তানিয়া', 'SONIA': 'সোনিয়া', 'LAMIA': 'লামিয়া', 'AFRIN': 'আফরিন',
    'SHILPI': 'শিল্পী', 'SWAPNA': 'স্বপ্না', 'REKHA': 'রেখা', 'SHIKHA': 'শিখা', 'MINA': 'মিনা', 'DIPA': 'দীপা', 'SIMA': 'সীমা',
    'BIBI': 'বিবি', 'BANU': 'বানু', 'NESSA': 'নেছা', 'NESA': 'নেসা', 'CHAKMA': 'চাকমা', 'MARMA': 'মারমা', 'TRIPURA': 'ত্রিপুরা', 'TANCHANGYA': 'তঞ্চঙ্গ্যা'
  };
})();

function transliterateEnWordToBn(word) {
  if (!word) return '';
  const raw = String(word).trim();
  if (!raw) return '';
  if (hasBengaliScript(raw)) return raw;
  const bare = raw.toUpperCase().replace(/[^A-Z.]/g, '');
  if (!bare) return raw;
  if (EN_NAME_WORD_MAP[bare]) return EN_NAME_WORD_MAP[bare];
  const noDot = bare.replace(/\.+$/, '');
  if (EN_NAME_WORD_MAP[noDot]) return EN_NAME_WORD_MAP[noDot];

  const vInit = [
    ['OUI', 'ঔই'], ['OU', 'ঔ'], ['OI', 'ঐ'], ['AA', 'আ'], ['AE', 'আ'], ['AI', 'আই'],
    ['EA', 'ইয়া'], ['EE', 'ঈ'], ['EI', 'এই'], ['EO', 'ইও'], ['IA', 'ইয়া'], ['IE', 'ই'],
    ['IO', 'ইও'], ['OO', 'উ'], ['OA', 'ও'], ['OY', 'অয়'], ['A', 'আ'], ['E', 'এ'],
    ['I', 'ই'], ['O', 'ও'], ['U', 'উ'], ['Y', 'ইয়']
  ];
  const vKar = [
    ['OU', 'ৌ'], ['OI', 'ৈ'], ['AA', 'া'], ['AE', 'ে'], ['AI', 'াই'], ['AY', 'ায়'],
    ['EE', 'ী'], ['EI', 'েই'], ['EY', 'ে'], ['OO', 'ূ'], ['OU', 'ৌ'], ['OW', 'ো'],
    ['OA', 'ো'], ['OY', 'য়'], ['A', 'া'], ['E', 'ে'], ['I', 'ি'], ['O', 'ো'], ['U', 'ু'], ['Y', 'ি']
  ];
  const cMap = [
    ['CHH', 'ছ'], ['CH', 'চ'], ['SH', 'শ'], ['KH', 'খ'], ['GH', 'ঘ'], ['TH', 'থ'],
    ['DH', 'ধ'], ['PH', 'ফ'], ['BH', 'ভ'], ['JH', 'ঝ'], ['RH', 'ঢ়'], ['NG', 'ং'],
    ['K', 'ক'], ['C', 'ক'], ['G', 'গ'], ['J', 'জ'], ['Z', 'জ'], ['T', 'ত'],
    ['D', 'দ'], ['N', 'ন'], ['P', 'প'], ['F', 'ফ'], ['B', 'ব'], ['V', 'ভ'],
    ['M', 'ম'], ['R', 'র'], ['L', 'ল'], ['S', 'স'], ['H', 'হ'], ['Q', 'ক'],
    ['W', 'ওয়'], ['X', 'ক্স'], ['Y', 'য়']
  ];

  let out = '';
  let i = 0;
  let afterCons = false;
  while (i < noDot.length) {
    let matched = false;
    if (afterCons) {
      for (const [k, v] of vKar) {
        if (noDot.startsWith(k, i)) {
          out += v;
          i += k.length;
          afterCons = false;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    } else {
      for (const [k, v] of vInit) {
        if (noDot.startsWith(k, i)) {
          out += v;
          i += k.length;
          afterCons = false;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    for (const [k, v] of cMap) {
      if (noDot.startsWith(k, i)) {
        out += v;
        i += k.length;
        afterCons = (k !== 'NG');
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += noDot[i];
      i++;
      afterCons = false;
    }
  }
  return out.trim();
}

function transliterateEnToBn(enText) {
  if (!enText) return '';
  const cleaned = String(enText).trim();
  if (!cleaned) return '';
  if (hasBengaliScript(cleaned)) return cleaned.normalize('NFC').replace(/\s+/g, ' ').trim();
  return cleaned
    .split(/\s+/)
    .map(transliterateEnWordToBn)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripPersonPrefixes(str) {
  return String(str || '')
    .normalize('NFC')
    .replace(/^(?:মোঃ|মো:|মো\.|মোহাম্মদ|মোহাম্মাদ|মুহাম্মদ|মোছাঃ|মোছা:|মোছা\.|মোসাঃ|মোসা\.|মোসাম্মৎ|মোসাম্মত|শ্রী|শ্রীমতী|মৃত|md\.?|mohammad|mohammed|muhammad|mosammat|most\.?|mst\.?|sri|late)\s+/i, '')
    .replace(/[\s\u200B-\u200D\uFEFF]+/g, '')
    .toLowerCase();
}

function cleanOcrFieldText(val) {
  if (val === null || val === undefined) return '';
  let s = String(val).normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  if (!s || /^(?:null|none|nil|n\/a|na|undefined|unknown|unreadable|illegible|blurry|unclear|blank|empty|missing|redacted|sample|example|placeholder|dummy|not\s+(?:available|printed|found|visible|clear|legible|applicable|provided|specified)|[-—–_.?*]+|x{3,}|নেই|নাই|অজানা|অস্পষ্ট|খালি|পা[ওো](?:য়া|য\u09BCা)\s*যা(?:য়|য\u09BC)নি|প(?:ড়|ড\u09BC|র)া\s*যা(?:য়|য\u09BC)নি|প্রযোজ্য\s*ন(?:য়|য\u09BC|য))$/i.test(s)) {
    return '';
  }
  s = s.replace(/^(?:নিবন্ধিত\s*ব্যক্তির\s*নাম|আবেদনকারীর\s*নাম|নাম\s*\(বাংলা\)|নাম\s*\(ইংরেজি\)|নাম|name\s*of\s*(?:the\s*)?(?:child|person)|name(?:\s*\(in\s*english\))?|পিতার?\s*নাম|পিতা|father(?:'s)?\s*name|মাতার?\s*নাম|মাতা|mother(?:'s)?\s*name|স্বামী\s*\/\s*স্ত্রী(?:র\s*নাম)?|স্বামী(?:র\s*নাম)?|স্ত্রী(?:র\s*নাম)?|spouse(?:'s)?\s*name|husband(?:'s)?\s*name|wife(?:'s)?\s*name|জন্ম\s*তারিখ|date\s*of\s*birth|dob|id\s*no\.?|nid\s*no\.?|জন্ম\s*নিবন্ধন\s*ন(?:ং|ম্বর)|জাতীয়?\s*পরিচ(?:য়|য়)\s*ন(?:ং|ম্বর)|birth\s*registration\s*no\.?)\s*[:ঃ\-–]+\s*/i, '').trim();
  if (!s || /^(?:null|none|nil|n\/a|na|undefined|unknown|unreadable|illegible|blurry|unclear|blank|empty|missing|redacted|not\s+(?:available|printed|found|visible|clear|legible|applicable|provided|specified)|[-—–_.?*]+|x{3,}|নেই|নাই|অজানা|অস্পষ্ট|খালি|পা[ওো](?:য়া|য\u09BCা)\s*যা(?:য়|য\u09BC)নি|প(?:ড়|ড\u09BC|র)া\s*যা(?:য়|য\u09BC)নি|প্রযোজ্য\s*ন(?:য়|য\u09BC|য))$/i.test(s)) {
    return '';
  }
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
  if (!cleanOcrFieldText(out.father_nid)) out.father_nid = pickAlias(['fatherNid', 'father_nid_no', 'father_national_id', 'pita_nid']);
  if (!cleanOcrFieldText(out.mother_nid)) out.mother_nid = pickAlias(['motherNid', 'mother_nid_no', 'mother_national_id', 'mata_nid']);
  if (!cleanOcrFieldText(out.registration_date)) out.registration_date = pickAlias(['reg_date', 'date_of_registration', 'issue_date', 'date_of_issuance']);
  if (!cleanOcrFieldText(out.detected_language)) out.detected_language = pickAlias(['language', 'doc_language', 'script']);
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
    'doc_type', 'doc_number', 'nid_number', 'birth_reg_no', 'father_nid', 'mother_nid',
    'registration_date', 'detected_language',
    'name_bn', 'name_en', 'dob', 'gender',
    'father_name_bn', 'father_name_en', 'mother_name_bn', 'mother_name_en',
    'spouse_name_bn', 'spouse_name_en', 'relation_suggestion',
    'marital_status_suggestion', 'confidence'
  ]) {
    out[k] = cleanOcrFieldText(out[k] ?? '');
  }
  if (!['high', 'medium', 'low'].includes(String(out.confidence || '').toLowerCase())) {
    out.confidence = (out.name_bn || out.name_en) && out.doc_number && out.dob ? 'medium' : 'low';
  } else {
    out.confidence = String(out.confidence).toLowerCase();
  }
  return out;
}

function needsIntelligentCompletion(data = {}) {
  if (!data || typeof data !== 'object') return false;
  // Strictly transliterate ONLY already-extracted non-empty names missing their paired language script.
  // Never call a text-only LLM to guess blank DOB, gender, marital status, or missing parent names!
  return [
    ['name_bn', 'name_en'],
    ['father_name_bn', 'father_name_en'],
    ['mother_name_bn', 'mother_name_en'],
    ['spouse_name_bn', 'spouse_name_en']
  ].some(([bnK, enK]) => {
    const bn = cleanOcrFieldText(data[bnK] || '');
    const en = cleanOcrFieldText(data[enK] || '');
    return (Boolean(bn) && (!en || hasBengaliScript(en))) || (Boolean(en) && (!bn || !hasBengaliScript(bn)));
  });
}

function needsEnglishCompletion(data = {}) {
  return needsIntelligentCompletion(data);
}

function parseOcrJsonText(rawInput) {
  if (Array.isArray(rawInput)) {
    rawInput = rawInput.map(p => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('\n');
  } else if (rawInput && typeof rawInput === 'object') {
    return normalizeOcrKeyAliases(rawInput);
  }
  let raw = String(rawInput || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^<think>[\s\S]*?(?=\{)/i, '')
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
      'doc_type', 'doc_number', 'nid_number', 'birth_reg_no', 'father_nid', 'mother_nid', 'registration_date',
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

async function logWorkerErrorToFirebase(entry = {}) {
  try {
    const nowMs = Date.now();
    const id = `err_${nowMs}_${Math.random().toString(36).slice(2, 7)}`;
    const fields = {
      id: { stringValue: id },
      source: { stringValue: String(entry.source || 'cloudflare-worker').slice(0, 60) },
      level: { stringValue: String(entry.level || 'error').slice(0, 20) },
      stage: { stringValue: String(entry.stage || 'ocr').slice(0, 80) },
      message: { stringValue: String(entry.message || 'Unknown error').slice(0, 800) },
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
      await fetch(`${FIRESTORE_ROOMS_BASE}/FC_SYSTEM_LOGS/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            id: { stringValue: id },
            room: { stringValue: 'FC_SYSTEM_LOGS' },
            type: { stringValue: 'system' },
            text: { stringValue: `[${entry.level || 'error'}][${entry.source || 'worker'}] ${entry.message || ''}`.slice(0, 800) },
            payloadJson: { stringValue: JSON.stringify({ ...entry, id, ts: nowMs }) },
            senderName: { stringValue: String(entry.source || 'cloudflare-worker') },
            senderClient: { stringValue: 'worker' },
            senderId: { stringValue: 'worker' },
            replyToJson: { stringValue: '' },
            ts: { integerValue: String(nowMs) },
            createdAt: { stringValue: new Date(nowMs).toISOString() }
          }
        })
      }).catch(() => {});
    }
  } catch (_) {}
}

function isValidCalendarDate(d, m, y, allowFuture = false) {
  const day = Number(d);
  const month = Number(m);
  const year = Number(y);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return false;
  const now = new Date();
  const maxYear = allowFuture ? 2100 : now.getFullYear();
  if (year < 1850 || year > maxYear || month < 1 || month > 12 || day < 1) return false;
  const maxDays = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > maxDays) return false;
  if (!allowFuture) {
    const dt = new Date(year, month - 1, day);
    if (dt.getTime() > now.getTime() + 86400000) return false;
  }
  return true;
}

function standardizeDate(dobStr) {
  if (!dobStr) return '';
  let str = normalizeDigits(dobStr)
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^(?:তারিখ|জন্ম\s*তারিখ|date\s*of\s*birth|date|dob)\s*[:\-–]?\s*/i, '')
    .replace(/(\d{1,2})\s*(?:ইং|ই|শে|লা|রা|ঠা|st|nd|rd|th)(?=[\s,./\-\u0980-\u09FF])/gi, '$1 ')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const isoMatch = str.match(/(?:^|\s)(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:\b|$)/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    return isValidCalendarDate(d, m, y)
      ? `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
      : '';
  }
  const enMonths = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
  const enMatch = str.match(/(?:^|\s)(\d{1,2})[\s\-,.]+([a-zA-Z]{3,})\.?[\s\-,.]+(\d{4})(?:\b|$)/i);
  if (enMatch) {
    const d = parseInt(enMatch[1], 10);
    const mStr = enMonths[enMatch[2].toLowerCase().substring(0, 3)] || '';
    const y = parseInt(enMatch[3], 10);
    if (mStr && isValidCalendarDate(d, parseInt(mStr, 10), y)) {
      return `${String(d).padStart(2, '0')}/${mStr}/${y}`;
    }
    if (mStr) return '';
  }
  const enMonthFirst = str.match(/(?:^|\s)([a-zA-Z]{3,})\.?[\s\-,.]+(\d{1,2})[\s\-,.]+(\d{4})(?:\b|$)/i);
  if (enMonthFirst) {
    const mStr = enMonths[enMonthFirst[1].toLowerCase().substring(0, 3)] || '';
    const d = parseInt(enMonthFirst[2], 10);
    const y = parseInt(enMonthFirst[3], 10);
    if (mStr && isValidCalendarDate(d, parseInt(mStr, 10), y)) {
      return `${String(d).padStart(2, '0')}/${mStr}/${y}`;
    }
    if (mStr) return '';
  }
  const bnPrefixes = [
    ['জানু','01'],['ফেব','02'],['মার','03'],['এপ্রি','04'],['মে','05'],['জুন','06'],
    ['জুল','07'],['আগ','08'],['সেপ','09'],['অক্ট','10'],['অক','10'],['নভ','11'],['ডিস','12']
  ];
  const bnMatch = str.match(/(?:^|\s)(\d{1,2})[\s\-,/.]+([\u0980-\u09FF]+)[\s\-,/.]+(\d{4})(?:\b|$)/);
  if (bnMatch) {
    const d = parseInt(bnMatch[1], 10);
    const hit = bnPrefixes.find(([p]) => bnMatch[2].startsWith(p));
    const y = parseInt(bnMatch[3], 10);
    if (hit && isValidCalendarDate(d, parseInt(hit[1], 10), y)) {
      return `${String(d).padStart(2, '0')}/${hit[1]}/${y}`;
    }
    if (hit) return '';
  }
  str = str.replace(/[-\.]/g, '/');
  const dmyMatch = str.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[^\d]|$)/);
  if (dmyMatch) {
    let d = parseInt(dmyMatch[1], 10);
    let m = parseInt(dmyMatch[2], 10);
    const y = parseInt(dmyMatch[3], 10);
    if (d <= 12 && m > 12 && m <= 31) {
      const tmp = d; d = m; m = tmp;
    }
    return isValidCalendarDate(d, m, y)
      ? `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
      : '';
  }
  return '';
}

const OCR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    doc_type: { type: 'string', enum: ['nid', 'birth_certificate'] },
    doc_number: { type: 'string' },
    nid_number: { type: 'string' },
    birth_reg_no: { type: 'string' },
    father_nid: { type: 'string' },
    mother_nid: { type: 'string' },
    registration_date: { type: 'string' },
    detected_language: { type: 'string', enum: ['bilingual', 'bn_only', 'en_only', 'unknown'] },
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
  required: ['doc_type']
};

function buildGeminiPrompt(docTypeHint = 'auto') {
  const hintLine = docTypeHint === 'nid'
    ? 'HINT: User selected Bangladeshi NID Card. Still verify visually first — if it is clearly a Birth Registration Certificate (জন্ম নিবন্ধন সনদপত্র / 17-digit Birth Registration No), set "doc_type": "birth_certificate" and put the 17 digits into "birth_reg_no" and "doc_number".'
    : docTypeHint === 'birth_certificate'
      ? 'HINT: User selected Bangladeshi Digital/Manual Birth Registration Certificate (জন্ম নিবন্ধন সনদপত্র). Focus on the 17-digit Birth Registration Number (starts with birth year YYYY), Date of Birth (NOT Registration Date), and parent names (put Father/Mother NID into father_nid/mother_nid, NEVER into doc_number/nid_number/birth_reg_no).'
      : 'Detect automatically whether this is a Bangladeshi NID Card or a Birth Registration Certificate.';

  return `
You are an ultra-precise OCR engine specializing in Bangladeshi identity documents:
1. Bangladeshi National Identity (NID) Cards (Smart Cards and classic laminated paper NID cards).
2. Bangladeshi Birth Registration Certificates (জন্ম নিবন্ধন সনদপত্র / BRC — bilingual, Bangla-only, or English-only).

${hintLine}

STRICT VERBATIM ZERO-CORRECTION & ZERO-HALLUCINATION DIRECTIVE (CRITICAL):
- Extract ONLY characters, spellings, names, and numbers physically visible in the document image.
- NEVER invent, fabricate, guess, pad, or synthesize ANY field or digit! If a field is not printed, cut off, or unreadable, return "".
- If the image is blank, dark, blurry, or NOT a Bangladeshi NID / Birth Registration Certificate, return "" for all person/number/date fields and set "confidence": "low".
- NEVER output placeholder strings like "unknown", "unreadable", "N/A", "null", or sequential dummy digits.
- NEVER alter printed Bengali spelling:
  - Keep "মন্ডল" vs "মণ্ডল", "মোসাঃ" vs "মোছাঃ", "আঃ", "নুর" vs "নূর", "আলী" vs "আলি", "হোসেন" vs "হোসাইন" EXACTLY as printed.
- ENGLISH NAME RULES:
  - If English text is physically printed on the document, extract the EXACT printed English text verbatim (e.g. keep printed "MOHAMMAD" or "MOSAMMAT" as printed; NEVER overwrite printed English!).
  - ONLY if a name is printed exclusively in Bengali and English is physically absent on the card, provide accurate ALL-CAPS English transliteration ("মোছাঃ" -> "MST.", "মোঃ" -> "MD.", "মোসাঃ" -> "MOSA.").
  - Set "detected_language" to "bilingual", "bn_only", "en_only", or "unknown".
  - NEVER put Bengali characters in *_en fields or Latin letters in *_bn fields.
- DOCUMENT NUMBERS:
  - Birth Registration Certificates: strictly 17 digits starting with the 4-digit birth year (YYYY...). Put Father's/Mother's NID ONLY into "father_nid" and "mother_nid", NEVER into "birth_reg_no"/"doc_number".
  - NID Cards: 10 digits (Smart NID) or 13/17 digits (Classic NID). Extract ONLY clearly visible digits; NEVER pad or guess missing digits.
- DATES:
  - Extract "dob" in strict ASCII DD/MM/YYYY format.
  - On Birth Certificates, put Date of Birth in "dob" and Date of Registration in "registration_date" (NEVER copy registration_date into dob).
- GENDER & SPOUSE:
  - Set "gender" to "পুরুষ", "নারী", or "হিজড়া" ONLY if printed or clearly evident; otherwise return "".
  - If classic laminated NID prints "স্বামী:" (Husband), put that name into "spouse_name_bn" and "spouse_name_en". NEVER copy husband's name into father fields!
  - Leave "relation_suggestion" and "marital_status_suggestion" as "" unless directly evidenced on the document (e.g. "স্বামী:" implies "বিবাহিত").

Return strictly ONE valid minified JSON object with ONLY these keys (use "" for any absent or unreadable field):
doc_type, detected_language, doc_number, nid_number, birth_reg_no, father_nid, mother_nid, registration_date, name_bn, name_en, dob, gender, father_name_bn, father_name_en, mother_name_bn, mother_name_en, spouse_name_bn, spouse_name_en, relation_suggestion, marital_status_suggestion, confidence.
`;
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

function extractDigitCandidate(raw) {
  return normalizeDigits(raw || '').replace(/[^0-9]/g, '');
}

function isDummyDocNumber(digits) {
  if (!digits) return true;
  if (/^(\d)\1{7,}$/.test(digits)) return true;
  if (/^(?:1234567890|0123456789|9876543210|1234567890123|12345678901234567)$/.test(digits)) return true;
  return false;
}

function pickBestDocDigits(candidates, preferredLengths, opts = {}) {
  const { excludeSet = null, birthYear = '' } = opts || {};
  const isExcludedOrDummy = (d) => !d || isDummyDocNumber(d) || (excludeSet && excludeSet.has(d));
  const rawList = candidates.map(extractDigitCandidate).filter((d) => !isExcludedOrDummy(d));
  const active = rawList.filter((d) => !/^(?:(?:19|20)\d{6}|(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d{2})$/.test(d));
  for (const len of preferredLengths) {
    const matches = active.filter((c) => c.length === len);
    if (matches.length) {
      if (len === 17 && birthYear) {
        const yrHit = matches.find((c) => c.startsWith(birthYear));
        if (yrHit) return yrHit;
      }
      return matches[0];
    }
    if (len === 17) {
      for (const cand of candidates) {
        if (!cand) continue;
        const norm = normalizeDigits(String(cand));
        if (birthYear) {
          const m = norm.match(new RegExp(`(?:^|[^0-9])(${birthYear}\\d{13})(?:[^0-9]|$)`));
          if (m && !isExcludedOrDummy(m[1])) return m[1];
        }
        const mGen = norm.match(/(?:^|[^0-9])((?:19|20)\d{15})(?:[^0-9]|$)/);
        if (mGen && !isExcludedOrDummy(mGen[1])) return mGen[1];
      }
    } else if (len === 10) {
      for (const cand of candidates) {
        if (!cand) continue;
        const norm = normalizeDigits(String(cand));
        const m10 = norm.match(/(?:^|[^0-9])(\d{10})(?:[^0-9]|$)/);
        if (m10 && !isExcludedOrDummy(m10[1])) return m10[1];
      }
    } else if (len === 13) {
      for (const cand of candidates) {
        if (!cand) continue;
        const norm = normalizeDigits(String(cand));
        const m13 = norm.match(/(?:^|[^0-9])(\d{13})(?:[^0-9]|$)/);
        if (m13 && !isExcludedOrDummy(m13[1])) return m13[1];
      }
    }
  }
  const longCand = active.find((d) => d.length >= 10 && d.length <= 17);
  return longCand || '';
}

function getDobYear(dobStr) {
  const m = String(standardizeDate(dobStr || '') || dobStr || '').match(/\b(19\d{2}|20\d{2})\b/);
  return m ? m[1] : '';
}

function isDocDigitsValidForType(docType, parsed, extraExclude = null) {
  if (!parsed || typeof parsed !== 'object') return false;
  const birthYear = getDobYear(parsed.dob || '');
  const regDigits = extractDigitCandidate(parsed.registration_date);
  const excludeSet = new Set([
    extractDigitCandidate(parsed.father_nid),
    extractDigitCandidate(parsed.mother_nid),
    regDigits,
    ...(extraExclude instanceof Set ? Array.from(extraExclude) : [])
  ].filter(Boolean));
  if (docType === 'birth_certificate') {
    return pickBestDocDigits([parsed.birth_reg_no, parsed.doc_number, parsed.nid_number], [17], { excludeSet, birthYear }).length === 17;
  }
  const d = pickBestDocDigits([parsed.nid_number, parsed.doc_number, parsed.birth_reg_no], [10, 17, 13], { excludeSet, birthYear });
  return d.length === 10 || d.length === 13 || d.length === 17;
}

function inferBangladeshiGender(data = {}) {
  const norm = normalizeGenderValue(data.gender || '');
  if (['পুরুষ', 'নারী', 'হিজড়া'].includes(norm)) return norm;
  const nameBn = String(data.name_bn || '').normalize('NFC').trim();
  const nameEn = String(data.name_en || '').toUpperCase().trim();
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

function validateAndNormalizeOcrData(parsed, body = {}) {
  const warnings = [];
  for (const k of ['name_bn', 'name_en', 'father_name_bn', 'father_name_en', 'mother_name_bn', 'mother_name_en', 'spouse_name_bn', 'spouse_name_en', 'dob', 'gender', 'relation_suggestion', 'marital_status_suggestion', 'father_nid', 'mother_nid', 'registration_date', 'detected_language']) {
    parsed[k] = cleanOcrFieldText(parsed[k] ?? '');
  }
  for (const [bnKey, enKey] of [
    ['name_bn', 'name_en'],
    ['father_name_bn', 'father_name_en'],
    ['mother_name_bn', 'mother_name_en'],
    ['spouse_name_bn', 'spouse_name_en']
  ]) {
    let bnV = String(parsed[bnKey] || '').trim();
    let enV = String(parsed[enKey] || '').trim();
    if (bnV && !hasBengaliScript(bnV) && /[A-Za-z]/.test(bnV) && enV && hasBengaliScript(enV)) {
      parsed[bnKey] = enV;
      parsed[enKey] = bnV.toUpperCase();
    } else {
      if (!bnV && hasBengaliScript(enV)) {
        parsed[bnKey] = enV;
        parsed[enKey] = '';
        bnV = enV;
        enV = '';
      }
      if (bnV && !hasBengaliScript(bnV) && /[A-Za-z]/.test(bnV)) {
        if (!enV || hasBengaliScript(enV)) parsed[enKey] = bnV.toUpperCase();
        parsed[bnKey] = '';
      }
      if (enV && hasBengaliScript(enV)) {
        if (!parsed[bnKey]) parsed[bnKey] = enV;
        parsed[enKey] = '';
      }
    }
  }

  if (parsed.dob) parsed.dob = standardizeDate(parsed.dob);
  const birthYear = getDobYear(parsed.dob);
  const regDigits = extractDigitCandidate(parsed.registration_date);
  const dobDigits = extractDigitCandidate(parsed.dob);
  const fatherNid = extractDigitCandidate(parsed.father_nid);
  const motherNid = extractDigitCandidate(parsed.mother_nid);
  parsed.father_nid = fatherNid;
  parsed.mother_nid = motherNid;
  const parentExclude = new Set([fatherNid, motherNid, dobDigits, regDigits].filter(Boolean));
  const rawAiNid = extractDigitCandidate(parsed.nid_number);
  const rawAiBrc = extractDigitCandidate(parsed.birth_reg_no);
  const rawAiDoc = extractDigitCandidate(parsed.doc_number);
  const cleanNidNotParent = rawAiNid && !parentExclude.has(rawAiNid) ? rawAiNid : '';
  const hasStrongBrcMetadata = Boolean(fatherNid || motherNid || parsed.registration_date);
  const hasBrcEvidence =
    parsed.doc_type === 'birth_certificate' ||
    hasStrongBrcMetadata ||
    (!cleanNidNotParent && rawAiBrc.length === 17);

  if (body.docType === 'birth_certificate') {
    parsed.doc_type = 'birth_certificate';
  } else if (body.docType === 'nid') {
    if (parsed.doc_type === 'birth_certificate' && rawAiBrc.length === 17 && (!cleanNidNotParent || hasStrongBrcMetadata)) {
      parsed.doc_type = 'birth_certificate';
      warnings.push('ডকুমেন্ট ধরন NID থাকলেও ছবিটি জন্ম নিবন্ধন (১৭ ডিজিট BRC) হিসেবে শনাক্ত হয়েছে।');
    } else {
      parsed.doc_type = 'nid';
    }
  } else {
    if (parsed.doc_type === 'birth_certificate' || (hasBrcEvidence && (!cleanNidNotParent || (rawAiBrc.length === 17 && hasStrongBrcMetadata)))) {
      parsed.doc_type = 'birth_certificate';
    } else {
      parsed.doc_type = parsed.doc_type || 'nid';
    }
  }

  if (parsed.gender) parsed.gender = normalizeGenderValue(parsed.gender);
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(parsed.gender || '').trim())) {
    const infG = inferBangladeshiGender(parsed);
    if (infG) { parsed.gender = infG; parsed.gender_inferred = true; }
  }
  const relMap = { 'ছেলে': 'পুত্র', 'মেয়ে': 'কন্যা', 'মেয়ে': 'কন্যা', 'বাবা': 'পিতা', 'মা': 'মাতা' };
  if (parsed.relation_suggestion) parsed.relation_suggestion = relMap[String(parsed.relation_suggestion).trim()] || String(parsed.relation_suggestion).trim();

  const spouseBn = String(parsed.spouse_name_bn || '').trim();
  const fatherBn = String(parsed.father_name_bn || '').trim();
  const spouseEn = String(parsed.spouse_name_en || '').trim();
  const fatherEn = String(parsed.father_name_en || '').trim();
  const normBnSame = spouseBn && fatherBn && stripPersonPrefixes(spouseBn) === stripPersonPrefixes(fatherBn);
  const normEnSame = spouseEn && fatherEn && stripPersonPrefixes(spouseEn) === stripPersonPrefixes(fatherEn);
  if (normBnSame || normEnSame) {
    parsed.father_name_bn = '';
    parsed.father_name_en = '';
  }
  if ((spouseBn || spouseEn) && !parsed.father_name_bn && !parsed.father_name_en) {
    warnings.push("পুরাতন NID-তে 'স্বামী' নাম পাওয়া গেছে (পিতার নাম ছাপা নেই) — পিতার নামের ঘরে স্বামী বসেনি, প্রয়োজনে পিতার নাম যাচাই/লিখুন।");
    if (!parsed.relation_suggestion) parsed.relation_suggestion = 'স্ত্রী';
  }

  if (parsed.doc_type === 'birth_certificate') {
    const cleanDoc = pickBestDocDigits([rawAiBrc, rawAiDoc, rawAiNid], [17], { excludeSet: parentExclude, birthYear });
    parsed.doc_number = cleanDoc;
    parsed.birth_reg_no = cleanDoc;
    parsed.nid_number = '';
    if (parentExclude.has(rawAiBrc) || parentExclude.has(rawAiDoc)) {
      warnings.push('জন্ম নিবন্ধন নম্বর থেকে পিতা/মাতার NID নম্বর বাদ দিয়ে সঠিক নম্বর বাছাই করা হয়েছে।');
    }
    if (cleanDoc.length === 17 && birthYear && !cleanDoc.startsWith(birthYear)) {
      warnings.push(`জন্ম নিবন্ধনের প্রথম ৪ অঙ্ক (${cleanDoc.slice(0, 4)}) জন্মসাল (${birthYear})-এর সাথে মিলছে না — ১৭ ডিজিট নম্বর যাচাই করুন।`);
    }
    if (cleanDoc.length !== 17) warnings.push(`জন্ম নিবন্ধন নম্বরটি ${cleanDoc.length || 0} সংখ্যার (১৭ সংখ্যা প্রয়োজন) — যাচাই করুন।`);
  } else {
    let cleanDoc = pickBestDocDigits([rawAiNid, rawAiDoc, rawAiBrc], [10, 17, 13], { excludeSet: parentExclude, birthYear });
    if (cleanDoc.length === 13) {
      if (birthYear) { cleanDoc = birthYear + cleanDoc; parsed.nid_converted_to_17 = true; }
      else warnings.push('১৩ সংখ্যার NID-র জন্মসাল না পাওয়ায় ১৭ সংখ্যায় রূপান্তর করা যায়নি।');
    }
    parsed.doc_type = parsed.doc_type || 'nid';
    parsed.doc_number = cleanDoc;
    parsed.nid_number = cleanDoc;
    parsed.birth_reg_no = '';
    if (cleanDoc.length !== 10 && cleanDoc.length !== 17) {
      warnings.push(`NID নম্বরটি ${cleanDoc.length || 0} সংখ্যার (১০ বা ১৭ সংখ্যা প্রয়োজন) — যাচাই করুন।`);
    }
  }

  const enAutoFilled = [];
  const bnAutoFilled = [];
  for (const [bnKey, enKey] of [
    ['name_bn', 'name_en'],
    ['father_name_bn', 'father_name_en'],
    ['mother_name_bn', 'mother_name_en'],
    ['spouse_name_bn', 'spouse_name_en']
  ]) {
    const bnVal = String(parsed[bnKey] || '').trim();
    const enVal = String(parsed[enKey] || '').trim();
    if (bnVal && (!enVal || hasBengaliScript(enVal))) {
      const tr = transliterateBnToEn(bnVal);
      if (tr) {
        parsed[enKey] = tr;
        enAutoFilled.push(enKey);
      }
    } else if (enVal && (!bnVal || !hasBengaliScript(bnVal))) {
      const trBn = transliterateEnToBn(enVal);
      if (trBn && hasBengaliScript(trBn)) {
        parsed[bnKey] = trBn;
        bnAutoFilled.push(bnKey);
      }
    }
  }
  if (enAutoFilled.length > 0) {
    parsed.auto_transliterated_en = true;
    warnings.push('বাংলা-অনলি সনদ থেকে ইংরেজি নাম স্বয়ংক্রিয়ভাবে রূপান্তর করা হয়েছে — বানান যাচাই করুন।');
  }
  if (bnAutoFilled.length > 0) {
    parsed.auto_transliterated_bn = true;
    warnings.push('ইংরেজি-অনলি সনদ থেকে বাংলা নাম স্বয়ংক্রিয়ভাবে রূপান্তর করা হয়েছে — বানান যাচাই করুন।');
  }

  if (!parsed.marital_status_suggestion) {
    if (parsed.spouse_name_bn || parsed.spouse_name_en) parsed.marital_status_suggestion = 'বিবাহিত';
  }

  if (!String(parsed.name_bn || '').trim()) warnings.push('বাংলা নাম পড়া যায়নি।');
  if (!String(parsed.name_en || '').trim()) warnings.push('ইংরেজি নাম পড়া যায়নি।');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(parsed.dob || ''))) warnings.push('জন্ম তারিখ (DD/MM/YYYY) স্পষ্ট নয় — মিলিয়ে নিন।');
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(parsed.gender || '').trim())) warnings.push('লিঙ্গ স্পষ্ট নয় — নির্বাচন যাচাই করুন।');
  if (!String(parsed.mother_name_bn || '').trim() && !String(parsed.mother_name_en || '').trim()) warnings.push('মাতার নাম পড়া যায়নি — প্রয়োজনে হাতে লিখুন।');
  if (parsed.confidence === 'low') warnings.push('ছবিটি কিছুটা ঝাপসা/অস্পষ্ট — সাবমিটের আগে তথ্য মিলিয়ে নিন।');

  for (const [bnKey, enKey] of [
    ['name_bn', 'name_en'],
    ['father_name_bn', 'father_name_en'],
    ['mother_name_bn', 'mother_name_en'],
    ['spouse_name_bn', 'spouse_name_en']
  ]) {
    if (parsed[enKey]) {
      parsed[enKey] = normalizeEnglishHonorificPrefix(parsed[enKey], parsed[bnKey]);
    }
  }

  const missingFields = [];
  if (!String(parsed.name_bn || '').trim() || !hasBengaliScript(parsed.name_bn)) missingFields.push('name_bn');
  if (!String(parsed.name_en || '').trim() || hasBengaliScript(parsed.name_en)) missingFields.push('name_en');
  const validDoc = parsed.doc_type === 'birth_certificate'
    ? String(parsed.birth_reg_no || '').length === 17
    : [10, 17].includes(String(parsed.nid_number || '').length);
  if (!validDoc) missingFields.push('doc_number');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(parsed.dob || ''))) missingFields.push('dob');
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(parsed.gender || '').trim())) missingFields.push('gender');
  if (!String(parsed.mother_name_bn || '').trim() && !String(parsed.mother_name_en || '').trim()) missingFields.push('mother_name');
  if (!String(parsed.father_name_bn || '').trim() && !String(parsed.father_name_en || '').trim() && !String(parsed.spouse_name_bn || '').trim() && !String(parsed.spouse_name_en || '').trim()) {
    missingFields.push('father_or_spouse');
  }
  const filledCore = Math.max(0, 7 - missingFields.length);
  parsed.ocr_completeness = {
    valid: missingFields.length === 0,
    scorePct: Math.round((filledCore / 7) * 100),
    filledCore,
    totalCore: 7,
    missingFields,
    repaired: Boolean(parsed.auto_transliterated_en || parsed.auto_transliterated_bn || parsed.deepseek_en_completed || parsed.gemini_bilingual_completed || parsed._json_repaired || parsed.gender_inferred)
  };

  const normMob = body.mobileNumber ? normalizeDigits(body.mobileNumber).replace(/[^0-9]/g, '').trim() : '';
  if (normMob && !/^01[3-9]\d{8}$/.test(normMob)) warnings.push('মোবাইল নম্বরটি সঠিক ১১ সংখ্যার নয়।');

  parsed.marital_status = body.maritalStatus || parsed.marital_status_suggestion || '';
  parsed.religion = body.religion || '';
  parsed.mobile_number = normMob;
  parsed.ocr_warnings = warnings;
  return parsed;
}

const FIRESTORE_CARDS_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards';

async function syncWorkerToFirestore(data = {}, body = {}) {
  try {
    const rawId = normalizeDigits(body.familyId || data.family_id || data.nid_number || data.birth_reg_no || data.doc_number || '').replace(/[^0-9A-Za-z_-]/g, '');
    if (!rawId || (!data.name_bn && !data.name_en)) return;
    const fields = {
      name_bn: { stringValue: data.name_bn || '' },
      name_en: { stringValue: data.name_en || '' },
      dob: { stringValue: data.dob || '' },
      gender: { stringValue: data.gender || '' },
      doc_type: { stringValue: data.doc_type || 'nid' },
      nid_number: { stringValue: data.nid_number || '' },
      birth_reg_no: { stringValue: data.birth_reg_no || '' },
      father_nid: { stringValue: data.father_nid || '' },
      mother_nid: { stringValue: data.mother_nid || '' },
      father_name_bn: { stringValue: data.father_name_bn || '' },
      father_name_en: { stringValue: data.father_name_en || '' },
      mother_name_bn: { stringValue: data.mother_name_bn || '' },
      mother_name_en: { stringValue: data.mother_name_en || '' },
      spouse_name_bn: { stringValue: data.spouse_name_bn || '' },
      spouse_name_en: { stringValue: data.spouse_name_en || '' },
      marital_status: { stringValue: data.marital_status || '' },
      religion: { stringValue: data.religion || '' },
      mobile_number: { stringValue: data.mobile_number || '' },
      ocr_model_used: { stringValue: data.ocr_model_used || '' },
      updated_at: { timestampValue: new Date().toISOString() }
    };
    const famId = normalizeDigits(body.familyId || data.family_id || '').replace(/[^0-9A-Za-z_-]/g, '');
    if (famId) fields.family_id = { stringValue: famId };
    const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    await fetch(`${FIRESTORE_CARDS_BASE}/${encodeURIComponent(rawId)}?${mask}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    }).catch(() => {});
  } catch (_) {}
}

export default {
  async fetch(request, env, ctx) {
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
        const docType = body.docType || 'auto';
        const prefGemRaw = normalizeModelId(body.geminiModel || DEFAULT_GEMINI_MODEL);
        const prefGemModel = prefGemRaw.startsWith('gemini-') ? prefGemRaw : DEFAULT_GEMINI_MODEL;
        const prefDsModel = /chat/i.test(String(body.deepseekModel || '')) ? 'deepseek-chat' : 'deepseek-flash';

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
        let rawBase64 = String(rawInput).trim();
        const uriMatch = rawBase64.match(/^data:([^;]+);base64,(.+)$/s);
        if (uriMatch) {
          mimeType = uriMatch[1] || mimeType;
          rawBase64 = uriMatch[2];
        }
        rawBase64 = rawBase64.replace(/\s+/g, '');
        if (!rawBase64 || rawBase64.length < 8 || !/^[A-Za-z0-9+/=]+$/.test(rawBase64)) {
          return Response.json({ success: false, error: 'অবৈধ বা খালি ডকুমেন্ট ইমেজ ডেটা।' }, { status: 400, headers: CORS_HEADERS });
        }

        const promptText = buildGeminiPrompt(docType);

        function needsWorkerEscalation(p) {
          if (!p || typeof p !== 'object') return true;
          if (p.confidence === 'low') return true;
          const nb = String(p.name_bn || '').trim();
          const ne = String(p.name_en || '').trim();
          const lang = String(p.detected_language || '').toLowerCase();
          if (!nb && !ne) return true;
          if (lang !== 'en_only' && (!nb || !hasBengaliScript(nb))) return true;
          if (lang !== 'bn_only' && (!ne || hasBengaliScript(ne))) return true;
          if (!/^\d{2}\/\d{2}\/\d{4}$/.test(standardizeDate(p.dob || ''))) return true;
          const rawFn = extractDigitCandidate(p.father_nid);
          const rawMn = extractDigitCandidate(p.mother_nid);
          const exc = new Set([rawFn, rawMn, extractDigitCandidate(p.registration_date)].filter(Boolean));
          const inferredBrc = p.doc_type === 'birth_certificate' || Boolean(rawFn || rawMn || p.registration_date);
          const effectiveType = (docType === 'birth_certificate' || (docType === 'nid' && inferredBrc && extractDigitCandidate(p.birth_reg_no).length === 17 && !extractDigitCandidate(p.nid_number)))
            ? 'birth_certificate'
            : ((docType && docType !== 'auto') ? docType : (inferredBrc ? 'birth_certificate' : (p.doc_type || 'nid')));
          if (!isDocDigitsValidForType(effectiveType, p, exc)) return true;
          if (effectiveType === 'birth_certificate') {
            const by = getDobYear(p.dob);
            const brc = pickBestDocDigits([p.birth_reg_no, p.doc_number, p.nid_number], [17], { excludeSet: exc, birthYear: by });
            if (by && brc.length === 17 && !brc.startsWith(by)) return true;
          }
          if (!String(p.mother_name_bn || '').trim() && !String(p.mother_name_en || '').trim()) return true;
          const hasFatherOrSpouse =
            String(p.father_name_bn || '').trim() ||
            String(p.father_name_en || '').trim() ||
            String(p.spouse_name_bn || '').trim() ||
            String(p.spouse_name_en || '').trim();
          if (!hasFatherOrSpouse) return true;
          return false;
        }

        function mergeWorkerOcrResults(primary, escalated) {
          if (!primary) return escalated;
          if (!escalated) return primary;
          const escHasBrc = escalated.doc_type === 'birth_certificate' || Boolean(escalated.father_nid || escalated.mother_nid || escalated.registration_date);
          const priHasBrc = primary.doc_type === 'birth_certificate' || Boolean(primary.father_nid || primary.mother_nid || primary.registration_date);
          const effectiveType = docType === 'birth_certificate'
            ? 'birth_certificate'
            : ((escHasBrc || (priHasBrc && !extractDigitCandidate(escalated.nid_number))) ? 'birth_certificate' : (docType !== 'auto' ? docType : (escalated.doc_type || primary.doc_type || 'nid')));
          const merged = { ...primary, ...escalated, doc_type: effectiveType };
          for (const f of ['name_bn', 'father_name_bn', 'mother_name_bn', 'spouse_name_bn']) {
            const ev = String(escalated[f] || '').trim();
            const pv = String(primary[f] || '').trim();
            merged[f] = (ev && hasBengaliScript(ev)) ? ev : ((pv && hasBengaliScript(pv)) ? pv : (ev || pv));
          }
          for (const f of ['name_en', 'father_name_en', 'mother_name_en', 'spouse_name_en']) {
            const ev = String(escalated[f] || '').trim();
            const pv = String(primary[f] || '').trim();
            merged[f] = (ev && !hasBengaliScript(ev)) ? ev.toUpperCase() : ((pv && !hasBengaliScript(pv)) ? pv.toUpperCase() : (ev || pv));
          }
          for (const f of ['relation_suggestion', 'marital_status_suggestion', 'father_nid', 'mother_nid', 'registration_date', 'detected_language']) {
            merged[f] = String(escalated[f] || '').trim() || String(primary[f] || '').trim();
          }
          const escDob = standardizeDate(escalated.dob || '');
          const priDob = standardizeDate(primary.dob || '');
          merged.dob = /^\d{2}\/\d{2}\/\d{4}$/.test(escDob)
            ? escDob
            : (/^\d{2}\/\d{2}\/\d{4}$/.test(priDob) ? priDob : (escDob || priDob));
          const escG = normalizeGenderValue(escalated.gender);
          const priG = normalizeGenderValue(primary.gender);
          merged.gender = ['পুরুষ', 'নারী', 'হিজড়া'].includes(escG)
            ? escG
            : (['পুরুষ', 'নারী', 'হিজড়া'].includes(priG) ? priG : (escG || priG));
          const exc = new Set([extractDigitCandidate(merged.father_nid), extractDigitCandidate(merged.mother_nid)].filter(Boolean));
          if (!isDocDigitsValidForType(effectiveType, escalated, exc) && isDocDigitsValidForType(effectiveType, primary, exc)) {
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

        function getWorkerGeminiOrder(profile = 'accurate') {
          let base;
          if (profile === 'flash38_only') {
            base = ['gemini-3.8-flash'];
          } else if (profile === 'lite_only') {
            base = prefGemModel === 'gemini-3.1-flash-lite'
              ? ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']
              : ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
          } else if (profile === 'preferred') {
            base = [prefGemModel, 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'];
          } else {
            base = prefGemModel === 'gemini-4-argon'
              ? ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']
              : ['gemini-3.8-flash', prefGemModel, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
          }
          return Array.from(new Set(base));
        }

        async function runWorkerGemini(profile = 'accurate', isEscalation = false) {
          const modelsOrder = getWorkerGeminiOrder(profile);
          const isPdf = /pdf/i.test(String(mimeType || ''));
          const attempts = [];
          for (const model of modelsOrder) {
            if (INTERACTIONS_API_MODELS.has(model) && !isPdf) {
              const useUltraHigh = (model === 'gemini-3.8-flash' || model === 'gemini-4-argon') && (docType === 'birth_certificate' || docType === 'auto' || isEscalation);
              const imageResolution = useUltraHigh ? 'ultra_high' : 'high';
              const ibody = {
                model,
                input: [
                  { type: 'text', text: promptText },
                  { type: 'image', data: rawBase64, mime_type: mimeType, resolution: imageResolution }
                ],
                response_format: { type: 'text', mime_type: 'application/json', schema: OCR_RESPONSE_SCHEMA },
                generation_config: { thinking_level: (isEscalation || docType === 'birth_certificate') ? 'medium' : 'low' },
                store: false
              };
              attempts.push({
                model,
                timeoutMs: useUltraHigh || isEscalation ? 38000 : 28000,
                label: `${model} (interactions/${imageResolution})`,
                url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gKey, 'Api-Revision': '2026-05-20' },
                body: ibody
              });
            }
            attempts.push({
              model,
              timeoutMs: isEscalation ? 38000 : 28000,
              label: `${model} (generateContent)`,
              url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gKey },
              body: {
                contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mimeType, data: rawBase64 } }] }],
                generationConfig: { response_mime_type: 'application/json', responseSchema: OCR_RESPONSE_SCHEMA }
              }
            });
          }

          let lastErr = 'Gemini OCR থেকে উত্তর পাওয়া যায়নি।';
          for (const attempt of attempts) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), attempt.timeoutMs || 28000);
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
                const msg = gJson?.error?.message || gJson?.message || `HTTP ${geminiRes.status}`;
                if (geminiRes.status === 400 && /API[_\s]?key/i.test(msg)) {
                  const err = new Error('Gemini API Key সঠিক নয়।');
                  err.statusCode = 400;
                  throw err;
                }
                lastErr = `${attempt.label}: ${msg}`;
                continue;
              }
              const outText = extractTextFromGemini(gJson);
              if (!outText) { lastErr = `${attempt.label}: খালি উত্তর`; continue; }
              const p = parseOcrJsonText(outText);
              p.ocr_model_used = attempt.label;
              p.ocr_usage = computeScanUsageAndCost(attempt.model, gJson);
              return p;
            } catch (e) {
              clearTimeout(timer);
              if (e.statusCode === 400) throw e;
              lastErr = e.name === 'AbortError' ? `${attempt.label}: Timeout` : `${attempt.label}: ${e.message}`;
            }
          }
          throw new Error(`Gemini Error: ${lastErr}`);
        }

        function buildWorkerBilingualPrompt(partialData) {
          return `You are a STRICT bilingual transliteration helper for Bangladeshi NID / Birth Certificate JSON.
RULES (ZERO HALLUCINATION):
1. BANGLA -> ENGLISH (*_bn to *_en): ONLY if *_bn is non-empty Bengali AND *_en is blank/Bengali, provide accurate ALL-CAPS English transliteration ("মোছাঃ" -> "MST.", "মোঃ" -> "MD.", "মোসাঃ" -> "MOSA.").
2. ENGLISH -> BANGLA (*_en to *_bn): ONLY if *_en is non-empty English AND *_bn is blank/Latin, provide accurate Bangladeshi Bengali Unicode transliteration.
3. NEVER invent, fabricate, or fill ANY field whose opposite-language source is empty! If both *_bn and *_en are "", BOTH MUST stay "".
4. PRESERVE ORIGINAL BENGALI & PRINTED ENGLISH: NEVER alter existing non-empty spellings (keep "মন্ডল", "মোসাঃ", "আঃ", "নুর", "MOHAMMAD", "MOSAMMAT" unchanged).
5. NEVER invent or change "dob", "gender", "doc_type", "marital_status_suggestion", or "relation_suggestion". Return ONLY one valid JSON object with keys: name_bn, name_en, father_name_bn, father_name_en, mother_name_bn, mother_name_en, spouse_name_bn, spouse_name_en.
Input JSON:
${JSON.stringify({
            name_bn: partialData.name_bn || '',
            name_en: partialData.name_en || '',
            father_name_bn: partialData.father_name_bn || '',
            father_name_en: partialData.father_name_en || '',
            mother_name_bn: partialData.mother_name_bn || '',
            mother_name_en: partialData.mother_name_en || '',
            spouse_name_bn: partialData.spouse_name_bn || '',
            spouse_name_en: partialData.spouse_name_en || ''
          })}`;
        }

        function applyWorkerBilingualCompletion(partialData, completed, addCost, tagKey) {
          const out = { ...partialData };
          // Strictly allow transliteration ONLY when the paired source-language field already exists from Vision OCR
          for (const [bnK, enK] of [
            ['name_bn', 'name_en'],
            ['father_name_bn', 'father_name_en'],
            ['mother_name_bn', 'mother_name_en'],
            ['spouse_name_bn', 'spouse_name_en']
          ]) {
            const curBn = cleanOcrFieldText(out[bnK] || '');
            const curEn = cleanOcrFieldText(out[enK] || '');
            const candEn = cleanOcrFieldText(completed[enK] || '');
            const candBn = cleanOcrFieldText(completed[bnK] || '');
            if (curBn && hasBengaliScript(curBn) && (!curEn || hasBengaliScript(curEn)) && candEn && !hasBengaliScript(candEn)) {
              out[enK] = candEn.toUpperCase();
            }
            if (curEn && !hasBengaliScript(curEn) && (!curBn || !hasBengaliScript(curBn)) && candBn && hasBengaliScript(candBn)) {
              out[bnK] = candBn;
            }
          }
          if (addCost) {
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
          out[tagKey] = true;
          return out;
        }

        async function completeWorkerBilingualWithGemini(partialData) {
          if (!gKey || !partialData || !needsIntelligentCompletion(partialData)) return partialData;
          const compPrompt = buildWorkerBilingualPrompt(partialData);
          const compModels = Array.from(new Set(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', prefGemModel || DEFAULT_GEMINI_MODEL])).filter(Boolean);
          for (const model of compModels) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 16000);
            try {
              const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gKey },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: compPrompt }] }],
                  generationConfig: { response_mime_type: 'application/json' }
                }),
                signal: controller.signal
              });
              clearTimeout(timer);
              if (!res.ok) continue;
              const j = await res.json().catch(() => ({}));
              const txt = extractTextFromGemini(j);
              if (!txt) continue;
              const completed = parseOcrJsonText(txt);
              const addCost = j?.usageMetadata ? computeScanUsageAndCost(model, j) : null;
              const out = applyWorkerBilingualCompletion(partialData, completed, addCost, 'gemini_bilingual_completed');
              out.gemini_bilingual_completed = model;
              return out;
            } catch (_) { clearTimeout(timer); }
          }
          return partialData;
        }

        function extractWorkerDeepSeekText(dsJson) {
          const msg = dsJson?.choices?.[0]?.message || {};
          let content = '';
          if (typeof msg.content === 'string') {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            content = msg.content.map(p => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('\n');
          }
          content = String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
          if (content) return content;

          const reasoning = typeof msg.reasoning_content === 'string'
            ? msg.reasoning_content
            : (typeof msg.reasoning === 'string' ? msg.reasoning : '');
          if (reasoning) {
            const hasOcrKey = (obj) => obj && typeof obj === 'object' && !Array.isArray(obj) && [
              'doc_type', 'doc_number', 'nid_number', 'birth_reg_no',
              'name_bn', 'name_en', 'dob', 'father_name_bn', 'mother_name_bn'
            ].some(k => obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '');

            const fences = [...reasoning.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
            for (let i = fences.length - 1; i >= 0; i--) {
              try {
                const cand = JSON.parse(fences[i][1].trim());
                if (hasOcrKey(cand)) return JSON.stringify(cand);
              } catch (_) {}
            }
            const endIdx = reasoning.lastIndexOf('}');
            if (endIdx !== -1) {
              let searchFrom = endIdx;
              for (let depth = 0; depth < 12 && searchFrom >= 0; depth++) {
                const startIdx = reasoning.lastIndexOf('{', searchFrom);
                if (startIdx === -1) break;
                try {
                  const cand = JSON.parse(reasoning.slice(startIdx, endIdx + 1));
                  if (hasOcrKey(cand)) return JSON.stringify(cand);
                } catch (_) {}
                searchFrom = startIdx - 1;
              }
            }
          }
          return '';
        }

        async function completeWorkerBanglaWithDeepSeek(partialData, preferredModel = 'deepseek-chat') {
          if (!dKey || !partialData || partialData._dsCompletionDone || !needsIntelligentCompletion(partialData)) return partialData;
          Object.defineProperty(partialData, '_dsCompletionDone', { value: true, enumerable: false, configurable: true });
          const models = preferredModel === 'deepseek-flash'
            ? ['deepseek-flash', 'deepseek-chat']
            : ['deepseek-chat', 'deepseek-flash'];
          const compPrompt = buildWorkerBilingualPrompt(partialData);
          const dsBase = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
          const attemptModes = [
            { disableThinking: true, useJsonMode: true, maxTokens: 2048 },
            { disableThinking: false, useJsonMode: false, maxTokens: 4096 }
          ];
          for (const model of models) {
            for (const cfg of attemptModes) {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 22000);
              try {
                const payload = {
                  model,
                  temperature: 0,
                  messages: [
                    { role: 'system', content: 'You are an expert Bangladeshi identity document specialist. Fill only missing English fields faithfully without changing or altering any existing Bengali spelling. Output strictly one valid JSON object.' },
                    { role: 'user', content: compPrompt }
                  ],
                  max_tokens: cfg.maxTokens
                };
                if (cfg.disableThinking) payload.thinking = { type: 'disabled' };
                if (cfg.useJsonMode) payload.response_format = { type: 'json_object' };
                const res = await fetch(`${dsBase}/chat/completions`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${dKey}` },
                  body: JSON.stringify(payload),
                  signal: controller.signal
                });
                clearTimeout(timer);
                if (!res.ok) continue;
                const j = await res.json().catch(() => ({}));
                const txt = extractWorkerDeepSeekText(j);
                if (!txt) continue;
                const completed = parseOcrJsonText(txt);
                const addCost = j?.usage ? computeScanUsageAndCost(model, j) : null;
                const out = applyWorkerBilingualCompletion(partialData, completed, addCost, 'deepseek_en_completed');
                out.deepseek_en_completed = model;
                Object.defineProperty(out, '_dsCompletionDone', { value: true, enumerable: false, configurable: true });
                return out;
              } catch (_) { clearTimeout(timer); }
            }
          }
          return partialData;
        }

        async function runWorkerDeepSeek() {
          if (/pdf/i.test(String(mimeType || ''))) {
            const err = new Error('DeepSeek Vision সরাসরি PDF ফাইল সাপোর্ট করে না (JPEG/PNG প্রয়োজন)।');
            err.isVisionUnsupported = true;
            throw err;
          }
          const modelsToTry = ['deepseek-flash'];
          let lastErr = 'DeepSeek থেকে কোনো উত্তর পাওয়া যায়নি।';
          const dsBase = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
          const attemptConfigs = [
            { disableThinking: true, useJsonMode: true, maxTokens: 4096, timeoutMs: 35000 },
            { disableThinking: true, useJsonMode: false, maxTokens: 4096, timeoutMs: 35000 },
            { disableThinking: false, useJsonMode: false, maxTokens: 8192, timeoutMs: 45000 }
          ];
          for (const model of modelsToTry) {
            for (const cfg of attemptConfigs) {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
              try {
                const payload = {
                  model,
                  temperature: 0,
                  messages: [
                    {
                      role: 'system',
                      content: 'You are an ultra-precise OCR engine for Bangladeshi identity documents (NID and Birth Certificates). Extract text EXACTLY as printed on the document without modifying, rewriting, or correcting spellings. If a Bengali name begins with "মোছাঃ" (or "মোছা:"), its English prefix is "MST.". If it begins with "মোঃ", its English prefix is "MD.". NEVER invent, guess, or synthesize digits or fields. Output strictly one valid JSON object.'
                    },
                    {
                      role: 'user',
                      content: [
                        { type: 'text', text: promptText },
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${rawBase64}` } }
                      ]
                    }
                  ],
                  max_tokens: cfg.maxTokens
                };
                if (cfg.disableThinking) payload.thinking = { type: 'disabled' };
                if (cfg.useJsonMode) payload.response_format = { type: 'json_object' };
                const dsRes = await fetch(`${dsBase}/chat/completions`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${dKey}`
                  },
                  body: JSON.stringify(payload),
                  signal: controller.signal
                });
                clearTimeout(timer);
                const dsJson = await dsRes.json().catch(() => ({}));
                if (!dsRes.ok) {
                  const msg = dsJson?.error?.message || dsJson?.message || `HTTP ${dsRes.status}`;
                  if (dsRes.status === 401) {
                    const err = new Error('DeepSeek API Key সঠিক নয়।');
                    err.statusCode = 400;
                    throw err;
                  }
                  if (dsRes.status === 402) {
                    const err = new Error('DeepSeek অ্যাকাউন্টে ব্যালেন্স শেষ।');
                    err.statusCode = 402;
                    throw err;
                  }
                  lastErr = `${model}: DeepSeek Error (${dsRes.status}): ${msg}`;
                  if (/image_url|multimodal|vision|deserialize|unknown variant|model\s*(?:does\s*)?not\s*exist|unsupported\s*model/i.test(msg) && !/thinking|reasoning|response_format/i.test(msg)) {
                    break;
                  }
                  continue;
                }
                const outText = extractWorkerDeepSeekText(dsJson);
                if (!outText) {
                  lastErr = `${model}: DeepSeek থেকে কোনো উত্তর পাওয়া যায়নি।`;
                  continue;
                }
                let p = parseOcrJsonText(outText);
                const hasAnyField = p && [
                  'name_bn', 'name_en', 'doc_number', 'nid_number', 'birth_reg_no', 'dob', 'father_name_bn', 'mother_name_bn'
                ].some(k => String(p[k] || '').trim() !== '');
                if (!p || (!hasAnyField && !/\{[\s\S]*\}/.test(outText))) {
                  lastErr = `${model}: DeepSeek থেকে বৈধ ডকুমেন্ট তথ্য পাওয়া যায়নি।`;
                  continue;
                }
                p.ocr_model_used = `${model} (api.deepseek.com)`;
                p.ocr_usage = computeScanUsageAndCost(model, dsJson);
                if (needsIntelligentCompletion(p)) {
                  if (gKey) p = await completeWorkerBilingualWithGemini(p);
                  if (dKey && needsIntelligentCompletion(p)) p = await completeWorkerBanglaWithDeepSeek(p, model);
                }
                return p;
              } catch (e) {
                clearTimeout(timer);
                if (e.statusCode === 400 || e.statusCode === 402) throw e;
                lastErr = e.name === 'AbortError' ? `${model}: DeepSeek Timeout` : `${model}: ${e.message}`;
                continue;
              }
            }
          }
          const finalErr = new Error(lastErr);
          if (/image_url|multimodal|vision|deserialize|unknown variant|model\s*(?:does\s*)?not\s*exist|unsupported\s*model/i.test(lastErr)) {
            finalErr.isVisionUnsupported = true;
          }
          throw finalErr;
        }

        let parsed = null;
        if (aiProvider === 'deepseek') {
          try {
            parsed = await runWorkerDeepSeek();
          } catch (dsErr) {
            const isAuthOrBal = dsErr.statusCode === 400 || dsErr.statusCode === 402 || /Key সঠিক নয়|ব্যালেন্স শেষ/i.test(dsErr.message || '');
            if (gKey && !isAuthOrBal) {
              const gRes = await runWorkerGemini('preferred', docType === 'birth_certificate');
              parsed = await completeWorkerBanglaWithDeepSeek(gRes, prefDsModel);
              parsed.ocr_model_used = `${gRes.ocr_model_used || 'gemini'} -> ${prefDsModel || 'deepseek-chat'}`;
            } else if (dsErr.isVisionUnsupported) {
              const err = new Error(`DeepSeek API সরাসরি ইমেজ OCR (image_url) সাপোর্ট করে না — অনুগ্রহ করে Gemini API Key যুক্ত করুন, তাহলে Gemini ছবি পড়ে DeepSeek-এর বুদ্ধিমত্তায় সম্পূর্ণ বাংলা ও ইংরেজি JSON তৈরি করবে। (${dsErr.message})`);
              err.statusCode = 400;
              throw err;
            } else {
              throw dsErr;
            }
          }
        } else if (aiProvider === 'gemini_lite') {
          parsed = await runWorkerGemini('lite_only', false);
        } else if (aiProvider === 'gemini') {
          parsed = await runWorkerGemini('preferred', docType === 'birth_certificate');
        } else if (keySlot === 'deepseek' && dKey) {
          const errs = [];
          try {
            const dsRes = await runWorkerDeepSeek();
            if (aiProvider === 'auto' || !needsWorkerEscalation(dsRes) || !gKey) {
              parsed = dsRes;
            } else {
              try {
                const escRes = await runWorkerGemini('preferred', true);
                parsed = mergeWorkerOcrResults(dsRes, escRes);
              } catch (_) { parsed = dsRes; }
            }
          } catch (e) {
            if (e.statusCode === 400 && !gKey) throw e;
            errs.push(e.message);
          }
          if (!parsed && gKey) {
            try { parsed = await runWorkerGemini('preferred', false); }
            catch (e) { errs.push(e.message); }
          }
          if (!parsed) throw new Error(errs.join(' | '));
        } else if (aiProvider === 'economy') {
          const errs = [];
          if (gKey) {
            try {
              const isFlagship = prefGemModel === 'gemini-3.8-flash' || prefGemModel === 'gemini-4-argon';
              const firstProfile = isFlagship ? 'preferred' : 'lite_only';
              const primaryRes = await runWorkerGemini(firstProfile, false);
              if (!needsWorkerEscalation(primaryRes) || isFlagship) {
                parsed = primaryRes;
              } else {
                try {
                  const escRes = await runWorkerGemini('flash38_only', true);
                  parsed = mergeWorkerOcrResults(primaryRes, escRes);
                } catch (_) {
                  if (dKey) {
                    try {
                      const dsEsc = await runWorkerDeepSeek();
                      parsed = mergeWorkerOcrResults(primaryRes, dsEsc);
                    } catch (__) {}
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
              parsed = await runWorkerGemini('accurate', docType === 'birth_certificate');
            }
            catch (e) { if (e.statusCode === 400 && !dKey) throw e; errs.push(e.message); }
          }
          if (!parsed && dKey) {
            try { parsed = await runWorkerDeepSeek(); }
            catch (e) { errs.push(e.message); }
          }
          if (!parsed) throw new Error(errs.join(' | '));
        }

        if (gKey && needsIntelligentCompletion(parsed)) {
          parsed = await completeWorkerBilingualWithGemini(parsed);
        }
        if (dKey && needsIntelligentCompletion(parsed)) {
          parsed = await completeWorkerBanglaWithDeepSeek(parsed, prefDsModel);
        }
        validateAndNormalizeOcrData(parsed, body);
        const syncPromise = syncWorkerToFirestore(parsed, body);
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(syncPromise);
        return Response.json({ success: true, data: parsed }, { headers: CORS_HEADERS });
      } catch (err) {
        const logPromise = logWorkerErrorToFirebase({
          source: 'cloudflare-worker',
          level: 'error',
          stage: 'api-extract-nid',
          message: err.message || 'Worker OCR error'
        });
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(logPromise);
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
            const metaRes = await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}?t=${nowMs}`, {
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
          const listRes = await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}/messages?pageSize=100&t=${nowMs}`, {
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
              const metaRes = await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}?t=${nowMs}`, {
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
          const writeRes = await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(msg.room)}/messages/${encodeURIComponent(msg.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields })
          });
          if (!writeRes.ok) {
            const errTxt = await writeRes.text().catch(() => '');
            return Response.json({ success: false, error: `Room store error (${writeRes.status}): ${errTxt}` }, { status: 502, headers: ROOM_RESP_HEADERS });
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
          const metaMask = maskPaths.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
          const metaPatchRes = await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(msg.room)}?${metaMask}`, {
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
          const metaMask = Object.keys(metaFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
          await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}?${metaMask}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: metaFields })
          });
          const listRes = await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}/messages?pageSize=100&t=${clearedAt}`, {
            headers: { 'Cache-Control': 'no-cache' }
          });
          const listJson = listRes.ok ? await listRes.json().catch(() => ({})) : {};
          const docs = Array.isArray(listJson.documents) ? listJson.documents : [];
          await Promise.all(docs.slice(0, 40).map((d) => fetch(`https://firestore.googleapis.com/v1/${d.name}`, { method: 'DELETE' }).catch(() => null)));
          return Response.json({ success: true, room, cleared: docs.length, clearedAt }, { headers: ROOM_RESP_HEADERS });
        }
      } catch (err) {
        return Response.json({ success: false, error: err.message }, { status: 500, headers: ROOM_RESP_HEADERS });
      }
    }

    if (path === '/api/error-logs') {
      const LOG_HEADERS = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: LOG_HEADERS });
      if (request.method === 'POST') {
        try {
          const entry = await request.json().catch(() => ({}));
          await logWorkerErrorToFirebase({ ...entry, source: entry.source || 'client-telemetry' });
          return Response.json({ success: true }, { headers: LOG_HEADERS });
        } catch (err) {
          return Response.json({ success: false, error: err.message }, { status: 500, headers: LOG_HEADERS });
        }
      }
      if (request.method === 'GET') {
        try {
          let logs = [];
          const res = await fetch(`${FIRESTORE_ERROR_LOGS_BASE}?pageSize=50&t=${Date.now()}`).catch(() => null);
          if (res && res.ok) {
            const j = await res.json().catch(() => ({}));
            const docs = Array.isArray(j.documents) ? j.documents : [];
            logs = docs.map((d) => {
              const f = d.fields || {};
              return {
                id: f.id?.stringValue || d.name?.split('/').pop(),
                source: f.source?.stringValue || '',
                level: f.level?.stringValue || 'error',
                stage: f.stage?.stringValue || '',
                message: f.message?.stringValue || '',
                detail: f.detail?.stringValue || '',
                model: f.model?.stringValue || '',
                ts: Number(f.ts?.integerValue || f.ts?.doubleValue || 0),
                createdAt: f.createdAt?.stringValue || ''
              };
            });
          } else {
            const fbRes = await fetch(`${FIRESTORE_ROOMS_BASE}/FC_SYSTEM_LOGS/messages?pageSize=50&t=${Date.now()}`).catch(() => null);
            if (fbRes && fbRes.ok) {
              const j = await fbRes.json().catch(() => ({}));
              const docs = Array.isArray(j.documents) ? j.documents : [];
              logs = docs.map((d) => {
                const f = d.fields || {};
                let payload = {};
                try { payload = JSON.parse(f.payloadJson?.stringValue || '{}'); } catch (_) {}
                return {
                  id: f.id?.stringValue || d.name?.split('/').pop(),
                  source: payload.source || f.senderName?.stringValue || 'system',
                  level: payload.level || 'error',
                  stage: payload.stage || '',
                  message: payload.message || f.text?.stringValue || '',
                  detail: payload.detail || '',
                  model: payload.model || '',
                  ts: Number(f.ts?.integerValue || f.ts?.doubleValue || 0),
                  createdAt: f.createdAt?.stringValue || ''
                };
              });
            }
          }
          logs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
          return Response.json({ success: true, logs: logs.slice(0, 50) }, { headers: LOG_HEADERS });
        } catch (err) {
          return Response.json({ success: false, error: err.message, logs: [] }, { status: 500, headers: LOG_HEADERS });
        }
      }
    }

    // Survey Timer API (detect, store, and fetch per-survey durations in Firestore)
    if (path === '/api/survey-timer') {
      const TIMER_HEADERS = {
        ...CORS_HEADERS,
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      };
      const TIMERS_LOG_BASE = `${FIRESTORE_CARDS_BASE}/SURVEY_TIMERS/logs`;
      const TIMERS_TOP_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/survey_timers';
      const HOUSES_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/surveyed_houses';
      const fmtShort = (totalSec = 0) => {
        const sec = Math.max(0, Math.round(Number(totalSec) || 0));
        const hrs = Math.floor(sec / 3600);
        const mins = Math.floor((sec % 3600) / 60);
        const rem = sec % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return hrs > 0 ? `${pad(hrs)}:${pad(mins)}:${pad(rem)}` : `${pad(mins)}:${pad(rem)}`;
      };

      if (request.method === 'POST') {
        try {
          const raw = await request.json();
          const now = Date.now();
          const rawStart = Number(raw.startedAtMs ?? raw.started_at_ms ?? 0);
          const rawEnd = Number(raw.endedAtMs ?? raw.ended_at_ms ?? now);
          const startedAtMs = rawStart > 0 && rawStart <= now + 60000 ? rawStart : now;
          const endedAtMs = rawEnd >= startedAtMs ? rawEnd : startedAtMs;
          const durationMs = Math.max(0, endedAtMs - startedAtMs);
          const computedSec = Math.round(durationMs / 1000);
          const rawDurationSec = Number(raw.durationSec ?? raw.duration_sec);
          const durationSec = Number.isFinite(rawDurationSec) && rawDurationSec >= 0 && Math.abs(rawDurationSec - computedSec) <= 2
            ? Math.round(rawDurationSec)
            : computedSec;

          const cleanId = (v, m = 96) => String(v || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, m);
          const sessionId = cleanId(raw.sessionId || raw.session_id || `srv_${startedAtMs}_${Math.random().toString(36).slice(2, 7)}`, 96);
          const familyId = cleanId(normalizeDigits(raw.familyId || raw.family_id || ''), 64);
          const docId = cleanId(normalizeDigits(raw.docId || raw.doc_id || familyId || ''), 96);
          const statusRaw = String(raw.status || raw.timerStatus || raw.survey_timer_status || 'ended').toLowerCase();
          const status = ['running', 'ended', 'completed'].includes(statusRaw) ? statusRaw : 'ended';

          const entry = {
            sessionId,
            familyId,
            docId,
            applicantName: String(raw.applicantName || raw.applicant_name || '').trim().slice(0, 120),
            docType: String(raw.docType || raw.doc_type || '').trim().slice(0, 40),
            source: String(raw.source || 'web').trim().slice(0, 40),
            roomCode: raw.roomCode || raw.room_code ? normalizeWorkerRoomCode(raw.roomCode || raw.room_code) : '',
            deviceName: String(raw.deviceName || raw.device_name || '').trim().slice(0, 60),
            surveyStatus: String(raw.surveyStatus || raw.survey_status || 'COMPLETED').trim().slice(0, 40),
            status,
            readinessPct: Math.max(0, Math.min(100, Math.round(Number(raw.readinessPct ?? raw.readiness_pct ?? 0) || 0))),
            startReason: String(raw.startReason || raw.start_reason || 'new_survey').trim().slice(0, 60),
            endReason: String(raw.endReason || raw.end_reason || 'survey_ended').trim().slice(0, 60),
            startedAtMs,
            endedAtMs,
            startedAt: new Date(startedAtMs).toISOString(),
            endedAt: new Date(endedAtMs).toISOString(),
            durationMs,
            durationSec,
            durationLabel: String(raw.durationLabel || raw.duration_label || fmtShort(durationSec)).trim().slice(0, 40)
          };

          const fields = {
            session_id: { stringValue: entry.sessionId },
            family_id: { stringValue: entry.familyId || '' },
            doc_id: { stringValue: entry.docId || '' },
            applicant_name: { stringValue: entry.applicantName || '' },
            doc_type: { stringValue: entry.docType || '' },
            source: { stringValue: entry.source || '' },
            room_code: { stringValue: entry.roomCode || '' },
            device_name: { stringValue: entry.deviceName || '' },
            survey_status: { stringValue: entry.surveyStatus || '' },
            timer_status: { stringValue: entry.status },
            readiness_pct: { integerValue: String(entry.readinessPct) },
            start_reason: { stringValue: entry.startReason },
            end_reason: { stringValue: entry.endReason },
            started_at_ms: { integerValue: String(entry.startedAtMs) },
            ended_at_ms: { integerValue: String(entry.endedAtMs) },
            started_at: { timestampValue: entry.startedAt },
            ended_at: { timestampValue: entry.endedAt },
            duration_ms: { integerValue: String(entry.durationMs) },
            duration_sec: { integerValue: String(entry.durationSec) },
            duration_label: { stringValue: entry.durationLabel }
          };
          const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
          const syncPromise = (async () => {
            const ops = [
              fetch(`${TIMERS_LOG_BASE}/${encodeURIComponent(entry.sessionId)}?${mask}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields })
              }).catch(() => null),
              fetch(`${TIMERS_TOP_BASE}/${encodeURIComponent(entry.sessionId)}?${mask}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields })
              }).catch(() => null)
            ];
            const targetDocIds = Array.from(new Set([entry.familyId, entry.docId].filter((id) => id && id !== 'SURVEY_TIMERS')));
            if (targetDocIds.length > 0) {
              const docFields = {
                survey_session_id: { stringValue: entry.sessionId },
                survey_started_at: { timestampValue: entry.startedAt },
                survey_ended_at: { timestampValue: entry.endedAt },
                survey_duration_sec: { integerValue: String(entry.durationSec) },
                survey_duration_label: { stringValue: entry.durationLabel },
                survey_timer_status: { stringValue: entry.status }
              };
              const docMask = Object.keys(docFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
              for (const targetId of targetDocIds) {
                ops.push(
                  fetch(`${FIRESTORE_CARDS_BASE}/${encodeURIComponent(targetId)}?${docMask}&currentDocument.exists=true`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: docFields })
                  }).catch(() => null),
                  fetch(`${FIRESTORE_CARDS_BASE}/${encodeURIComponent(targetId)}/logs/${encodeURIComponent(`timer_${entry.sessionId}`)}?${mask}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields })
                  }).catch(() => null),
                  fetch(`${HOUSES_BASE}/${encodeURIComponent(targetId)}?${docMask}&currentDocument.exists=true`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: docFields })
                  }).catch(() => null)
                );
              }
            }
            await Promise.all(ops);
          })();
          if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(syncPromise);
          } else {
            await syncPromise;
          }

          return Response.json({ success: true, entry }, { headers: TIMER_HEADERS });
        } catch (err) {
          return Response.json({ success: false, error: err.message }, { status: 400, headers: TIMER_HEADERS });
        }
      }

      if (request.method === 'GET') {
        try {
          const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '40', 10)));
          const roomFilter = url.searchParams.get('room') ? normalizeWorkerRoomCode(url.searchParams.get('room')) : '';
          let timers = [];
          let pageToken = '';
          for (let page = 0; page < 10; page++) {
            const pageUrl = `${TIMERS_LOG_BASE}?pageSize=300&t=${Date.now()}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
            const fsRes = await fetch(pageUrl).catch(() => null);
            if (!fsRes || !fsRes.ok) break;
            const j = await fsRes.json().catch(() => ({}));
            const docs = Array.isArray(j.documents) ? j.documents : [];
            for (const d of docs) {
              const f = d.fields || {};
              timers.push({
                sessionId: f.session_id?.stringValue || d.name?.split('/').pop() || '',
                familyId: f.family_id?.stringValue || '',
                docId: f.doc_id?.stringValue || '',
                applicantName: f.applicant_name?.stringValue || '',
                docType: f.doc_type?.stringValue || '',
                source: f.source?.stringValue || '',
                roomCode: f.room_code?.stringValue || '',
                deviceName: f.device_name?.stringValue || '',
                surveyStatus: f.survey_status?.stringValue || '',
                status: f.timer_status?.stringValue || 'ended',
                readinessPct: Number(f.readiness_pct?.integerValue || 0),
                startReason: f.start_reason?.stringValue || '',
                endReason: f.end_reason?.stringValue || '',
                startedAtMs: Number(f.started_at_ms?.integerValue || f.started_at_ms?.doubleValue || 0),
                endedAtMs: Number(f.ended_at_ms?.integerValue || f.ended_at_ms?.doubleValue || 0),
                startedAt: f.started_at?.timestampValue || '',
                endedAt: f.ended_at?.timestampValue || '',
                durationMs: Number(f.duration_ms?.integerValue || 0),
                durationSec: Number(f.duration_sec?.integerValue || 0),
                durationLabel: f.duration_label?.stringValue || ''
              });
            }
            if (!j.nextPageToken) break;
            pageToken = j.nextPageToken;
          }
          if (roomFilter) {
            timers = timers.filter((t) => !t.roomCode || t.roomCode === roomFilter);
          }
          timers.sort((a, b) => (b.endedAtMs || 0) - (a.endedAtMs || 0));
          const sliced = timers.slice(0, limit);
          const completed = sliced.filter((t) => t.status === 'ended' || t.status === 'completed');
          const totalSec = completed.reduce((acc, t) => acc + (Number(t.durationSec) || 0), 0);
          const stats = {
            count: completed.length,
            avgDurationSec: completed.length ? Math.round(totalSec / completed.length) : 0,
            minDurationSec: completed.length ? Math.min(...completed.map((t) => Number(t.durationSec) || 0)) : 0,
            maxDurationSec: completed.length ? Math.max(...completed.map((t) => Number(t.durationSec) || 0)) : 0
          };
          return Response.json({ success: true, timers: sliced, stats }, { headers: TIMER_HEADERS });
        } catch (err) {
          return Response.json({ success: false, error: err.message, timers: [] }, { status: 500, headers: TIMER_HEADERS });
        }
      }
    }

    // Health check endpoint
    if (path === '/api/info') {
      return Response.json({
        status: 'online',
        edge: 'cloudflare-worker',
        providers: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.1-flash-lite', 'deepseek-flash'],
        bdtPerUsd: BDT_PER_USD,
        deepSeekPeakNow: isDeepSeekPeakUtc(),
        pricing: AI_MODEL_CATALOG,
        features: ['room_messaging', 'cloud_room_sync', 'nid_data_share', 'summary_share', 'survey_timer'],
        upstream: ORIGIN_BASE
      }, { headers: CORS_HEADERS });
    }

    let targetPath = path;
    if (path === '/' || path === '') targetPath = '/index.html';
    else if (path === '/bookmarklet' || path === '/bookmarklet/') targetPath = '/bookmarklet/index.html';
    else if (path === '/bookmarklet.min.js') targetPath = '/bookmarklet/bookmarklet.min.js';

    const shouldNoCache = (
      path === '/' ||
      path === '' ||
      path === '/bookmarklet' ||
      targetPath.startsWith('/bookmarklet/') ||
      targetPath === '/index.html' ||
      targetPath === '/app.js' ||
      targetPath === '/style.css'
    );

    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      // Cloudflare Pages ASSETS.fetch redirects /index.html -> 308 /, so keep directory paths canonical
      const assetsPath = path === '/bookmarklet.min.js'
        ? '/bookmarklet/bookmarklet.min.js'
        : (path === '/bookmarklet' ? '/bookmarklet/' : (path || '/'));
      const assetReq = new Request(new URL(assetsPath + url.search, request.url), request);
      const assetRes = await env.ASSETS.fetch(assetReq);
      if (assetRes && assetRes.status !== 404) {
        const outHeaders = new Headers(assetRes.headers);
        outHeaders.set('Access-Control-Allow-Origin', '*');
        if (shouldNoCache) {
          outHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
        return new Response(assetRes.body, {
          status: assetRes.status,
          headers: outHeaders
        });
      }
    }

    // Static & Bookmarklet Assets via global Firebase CDN upstream with full CORS (Worker mode)
    if (path === '/bookmarklet/extension.zip' || path === '/extension.zip') {
      return Response.redirect(ORIGIN_BASE + '/extension.zip', 302);
    }

    const upstreamRes = await fetch(ORIGIN_BASE + targetPath + url.search);
    const outHeaders = new Headers(upstreamRes.headers);
    outHeaders.set('Access-Control-Allow-Origin', '*');
    if (shouldNoCache) {
      outHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: outHeaders
    });
  }
};
