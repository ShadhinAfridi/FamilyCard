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
  'খান': 'KHAN', 'উদ্দিন': 'UDDIN', 'উদ্দীন': 'UDDIN', 'আহসান': 'AHSAN', 'সাঈদ': 'SAID',
  'বাচ্চু': 'BACHCHU', 'বাবুল': 'BABUL', 'মিজানুর': 'MIZANUR', 'সাইফুল': 'SAIFUL',
  'নাজমুল': 'NAZMUL', 'কামরুল': 'KAMRUL', 'জহিরুল': 'ZAHIRUL', 'জহির': 'ZAHIR',
  'আজিজ': 'AZIZ', 'আজিজুল': 'AZIZUL', 'তৌহিদ': 'TOWHID', 'তৌহিদুল': 'TOWHIDUL',
  'হামিদ': 'HAMID', 'হামিদুল': 'HAMIDUL', 'খালেক': 'KHALEQ', 'মালেক': 'MALEK',
  'সিদ্দিক': 'SIDDIK', 'সিদ্দিকুর': 'SIDDIQUR', 'মোতালেব': 'MOTALEB', 'মোশাররফ': 'MOSHARRAF'
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
    if (indVowels[ch]) {
      out += indVowels[ch];
      lastHadExplicitVowel = true;
      i++;
      continue;
    }
    if (kars[ch]) {
      out += kars[ch];
      lastHadExplicitVowel = true;
      i++;
      continue;
    }
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
  return cleaned
    .split(/\s+/)
    .map(transliterateBnWordToEn)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function parseOcrJsonText(rawInput) {
  if (rawInput && typeof rawInput === 'object') {
    return normalizeOcrKeyAliases(rawInput);
  }
  let raw = String(rawInput || '')
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

function standardizeDate(dobStr) {
  if (!dobStr) return '';
  let str = normalizeDigits(dobStr)
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/(\d{1,2})\s*(?:ইং|ই|শে|লা|রা|ঠা|st|nd|rd|th)(?=[\s,./\-\u0980-\u09FF])/gi, '$1 ')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const isoMatch = str.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (isoMatch) return `${isoMatch[3].padStart(2, '0')}/${isoMatch[2].padStart(2, '0')}/${isoMatch[1]}`;
  const enMonths = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
  const enMatch = str.match(/^(\d{1,2})[\s\-,.]+([a-zA-Z]{3,})[\s\-,.]+(\d{4})/i);
  if (enMatch && enMonths[enMatch[2].toLowerCase().substring(0, 3)]) {
    return `${enMatch[1].padStart(2, '0')}/${enMonths[enMatch[2].toLowerCase().substring(0, 3)]}/${enMatch[3]}`;
  }
  const bnPrefixes = [
    ['জানু','01'],['ফেব','02'],['মার','03'],['এপ্রি','04'],['মে','05'],['জুন','06'],
    ['জুল','07'],['আগ','08'],['সেপ','09'],['অক্ট','10'],['অক','10'],['নভ','11'],['ডিস','12']
  ];
  const bnMatch = str.match(/^(\d{1,2})[\s\-,/.]+([\u0980-\u09FF]+)[\s\-,/.]+(\d{4})/);
  if (bnMatch) {
    const hit = bnPrefixes.find(([p]) => bnMatch[2].startsWith(p));
    if (hit) return `${bnMatch[1].padStart(2, '0')}/${hit[1]}/${bnMatch[3]}`;
  }
  str = str.replace(/[-\.]/g, '/');
  const dmyMatch = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmyMatch) return `${dmyMatch[1].padStart(2, '0')}/${dmyMatch[2].padStart(2, '0')}/${dmyMatch[3]}`;
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
  required: ['doc_type', 'doc_number', 'nid_number', 'birth_reg_no', 'name_bn', 'name_en', 'dob', 'gender']
};

function buildGeminiPrompt(docTypeHint = 'auto') {
  const bilingualRule = `
CRITICAL BILINGUAL RULE (ESPECIALLY FOR BANGLA-ONLY BIRTH CERTIFICATES / শুধু বাংলায় জন্ম নিবন্ধন সনদ):
- If the Birth Registration Certificate or NID is printed ONLY in Bengali (no English text printed on paper), you MUST STILL fill EVERY English field (\`name_en\`, \`father_name_en\`, \`mother_name_en\`, \`spouse_name_en\`) by accurately transliterating the Bengali names into standard Bangladeshi ALL-CAPS English spelling (e.g. "মোঃ" -> "MD.", "মোছাঃ" -> "MOSAMMAT", "রফিকুল ইসলাম" -> "RAFIQUL ISLAM").
- NEVER leave \`name_en\`, \`father_name_en\`, or \`mother_name_en\` blank if the Bengali field is readable, and NEVER put Bengali characters inside \`*_en\` fields.
- Convert ALL Bengali digits (০-৯) in dates and 17-digit \`birth_reg_no\` / \`nid_number\` / \`doc_number\` into English ASCII digits (0-9). Convert dates like "১২ই জানুয়ারি, ২০১২" into "12/01/2012" (DD/MM/YYYY).
- Return ONLY raw valid JSON (no markdown fences, never write "null" or "N/A", use "" for absent fields).`;
  const hint = docTypeHint === 'nid'
    ? `HINT: User selected Bangladeshi NID Card (ID Card Size). Focus carefully on extracting ALL fields including the 10, 13, or 17-digit NID number.${bilingualRule}`
    : docTypeHint === 'birth_certificate'
      ? `HINT: User selected Bangladeshi Digital Birth Registration Certificate (A4 Paper / জন্ম নিবন্ধন সনদপত্র). Focus carefully on the 17-digit Birth Registration Number, Date of Birth (NOT Registration Date), and parent names.${bilingualRule}`
      : `Detect automatically whether this is a Bangladeshi NID Card or Birth Registration Certificate.${bilingualRule}`;
  return `You are an expert OCR AI for Bangladeshi Identity Documents:
1. Bangladeshi National Identity (NID) Cards (Smart NID and Old Laminated/Paper NID).
2. Bangladeshi Digital Birth Registration Certificates (ডিজিটাল জন্ম নিবন্ধন সনদপত্র / BRC, A4 printed).
${hint}

Classify and extract ALL visible fields into a valid JSON object:
- "doc_type": Strictly "nid" or "birth_certificate"
1. "doc_number" & "nid_number" & "birth_reg_no":
   - For NID ("doc_type": "nid"): Smart NID prints 10 digits under "NID No."/"জাতীয় পরিচয় নং"; Old Laminated NID prints 13 or 17 digits at bottom under "ID NO:" (if 13 digits, extract those 13 digits or prepend 4-digit birth year from dob to make 17). Copy exact digits into BOTH "doc_number" and "nid_number", and set "birth_reg_no": "".
   - For Birth Certificate ("doc_type": "birth_certificate"): Extract exact 17-digit Birth Registration Number (জন্ম নিবন্ধন নম্বর / Personal Identification Number). CRITICAL: NEVER confuse Father's/Mother's NID or Serial No with the 17-digit Birth Registration Number! Copy 17 digits into BOTH "doc_number" and "birth_reg_no", and set "nid_number": "".
   - Strip spaces/hyphens and convert ALL Bengali digits (০-৯) to English (0-9).
2. "name_bn": Complete Bengali name.
3. "name_en": Complete English name in ALL CAPITAL LETTERS (transliterate if not printed).
4. "dob": Date of Birth in DD/MM/YYYY format (English digits). On Birth Certificates use "জন্ম তারিখ / Date of Birth", NOT Registration/Issuance date.
5. "gender": Strictly "পুরুষ", "নারী", or "হিজড়া" (infer accurately if omitted on old NID).
6. "father_name_bn" & "father_name_en": Extract ONLY from "পিতা:"/"পিতার নাম:"/"Father's Name". CRITICAL: For married women's classic laminated NIDs showing "স্বামী:" instead of "পিতা:", NEVER put husband's name into father fields! Leave father fields "" and use spouse fields.
7. "mother_name_bn" & "mother_name_en": Mother's Bengali & ALL CAPITAL English names.
8. "spouse_name_bn" & "spouse_name_en": Husband/Wife name from "স্বামী:" / "স্ত্রী:" if printed; otherwise "".
9. "relation_suggestion": One of ("স্বামী", "স্ত্রী", "পুত্র", "কন্যা", "পিতা", "মাতা", "ভাই", "বোন", "অন্যান্য"). If "স্বামী:" is printed on old NID, suggest "স্ত্রী".
10. "marital_status_suggestion": One of ("বিবাহিত", "অবিবাহিত", "বিধবা", "বিপত্নীক", "তালাকপ্রাপ্ত").
11. "confidence": "low" if blurry/glare/cropped/unreadable digits, "medium" if uncertain, "high" if clear.`;
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

function validateAndNormalizeOcrData(parsed, body = {}) {
  const warnings = [];
  for (const k of ['name_bn', 'name_en', 'father_name_bn', 'father_name_en', 'mother_name_bn', 'mother_name_en', 'spouse_name_bn', 'spouse_name_en', 'dob', 'gender', 'relation_suggestion', 'marital_status_suggestion']) {
    parsed[k] = cleanOcrFieldText(parsed[k] ?? '');
  }
  for (const [bnKey, enKey] of [
    ['name_bn', 'name_en'],
    ['father_name_bn', 'father_name_en'],
    ['mother_name_bn', 'mother_name_en'],
    ['spouse_name_bn', 'spouse_name_en']
  ]) {
    const bnV = String(parsed[bnKey] || '').trim();
    const enV = String(parsed[enKey] || '').trim();
    if (!bnV && hasBengaliScript(enV)) {
      parsed[bnKey] = enV;
      parsed[enKey] = '';
    } else if (bnV && !hasBengaliScript(bnV) && !enV) {
      parsed[enKey] = bnV.toUpperCase();
      parsed[bnKey] = '';
    }
  }

  if (body.docType && body.docType !== 'auto') {
    parsed.doc_type = body.docType;
  } else if (
    parsed.doc_type !== 'birth_certificate' &&
    !extractDigitCandidate(parsed.nid_number) &&
    extractDigitCandidate(parsed.birth_reg_no).length === 17
  ) {
    parsed.doc_type = 'birth_certificate';
  }
  if (parsed.dob) parsed.dob = standardizeDate(parsed.dob);

  if (parsed.gender) parsed.gender = normalizeGenderValue(parsed.gender);
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(parsed.gender || '').trim())) {
    const infG = inferBangladeshiGender(parsed);
    if (infG) { parsed.gender = infG; parsed.gender_inferred = true; }
  }
  const relMap = { 'ছেলে': 'পুত্র', 'মেয়ে': 'কন্যা', 'মেয়ে': 'কন্যা', 'বাবা': 'পিতা', 'মা': 'মাতা' };
  if (parsed.relation_suggestion) parsed.relation_suggestion = relMap[String(parsed.relation_suggestion).trim()] || String(parsed.relation_suggestion).trim();

  const spouseBn = String(parsed.spouse_name_bn || '').trim();
  const fatherBn = String(parsed.father_name_bn || '').trim();
  if (spouseBn && fatherBn && fatherBn === spouseBn) { parsed.father_name_bn = ''; parsed.father_name_en = ''; }
  if (spouseBn && !parsed.father_name_bn) {
    warnings.push("পুরাতন NID-তে 'স্বামী' নাম পাওয়া গেছে (পিতার নাম ছাপা নেই) — প্রয়োজনে পিতার নাম যাচাই/লিখুন।");
    if (!parsed.relation_suggestion) parsed.relation_suggestion = 'স্ত্রী';
  }

  if (parsed.doc_type === 'birth_certificate') {
    const cleanDoc = pickBestDocDigits([parsed.birth_reg_no, parsed.doc_number, parsed.nid_number], [17]);
    parsed.doc_number = cleanDoc;
    parsed.birth_reg_no = cleanDoc;
    parsed.nid_number = '';
    if (cleanDoc.length !== 17) warnings.push(`জন্ম নিবন্ধন নম্বরটি ${cleanDoc.length || 0} সংখ্যার (১৭ সংখ্যা প্রয়োজন) — যাচাই করুন।`);
  } else {
    let cleanDoc = pickBestDocDigits([parsed.nid_number, parsed.doc_number, parsed.birth_reg_no], [10, 17, 13]);
    if (cleanDoc.length === 13) {
      const ym = String(parsed.dob || '').match(/\b(19\d{2}|20\d{2})\b/);
      if (ym) { cleanDoc = ym[1] + cleanDoc; parsed.nid_converted_to_17 = true; }
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
    }
  }
  if (enAutoFilled.length > 0) {
    parsed.auto_transliterated_en = true;
    warnings.push('বাংলা-অনলি সনদ থেকে ইংরেজি নাম স্বয়ংক্রিয়ভাবে রূপান্তর করা হয়েছে — বানান যাচাই করুন।');
  }

  if (!parsed.marital_status_suggestion) {
    if (parsed.spouse_name_bn || parsed.spouse_name_en) parsed.marital_status_suggestion = 'বিবাহিত';
    else if (/^\d{2}\/\d{2}\/\d{4}$/.test(String(parsed.dob || ''))) {
      const yr = parseInt(String(parsed.dob).slice(-4), 10);
      if (yr && (new Date().getFullYear() - yr) <= 18) parsed.marital_status_suggestion = 'অবিবাহিত';
    }
  }

  if (!String(parsed.name_bn || '').trim()) warnings.push('বাংলা নাম পড়া যায়নি।');
  if (!String(parsed.name_en || '').trim()) warnings.push('ইংরেজি নাম পড়া যায়নি।');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(parsed.dob || ''))) warnings.push('জন্ম তারিখ (DD/MM/YYYY) স্পষ্ট নয় — মিলিয়ে নিন।');
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(parsed.gender || '').trim())) warnings.push('লিঙ্গ স্পষ্ট নয় — নির্বাচন যাচাই করুন।');
  if (!String(parsed.mother_name_bn || '').trim() && !String(parsed.mother_name_en || '').trim()) warnings.push('মাতার নাম পড়া যায়নি — প্রয়োজনে হাতে লিখুন।');
  if (parsed.confidence === 'low') warnings.push('ছবিটি কিছুটা ঝাপসা/অস্পষ্ট — সাবমিটের আগে তথ্য মিলিয়ে নিন।');

  if (parsed.name_en) parsed.name_en = String(parsed.name_en).toUpperCase().trim();
  if (parsed.father_name_en) parsed.father_name_en = String(parsed.father_name_en).toUpperCase().trim();
  if (parsed.mother_name_en) parsed.mother_name_en = String(parsed.mother_name_en).toUpperCase().trim();
  if (parsed.spouse_name_en) parsed.spouse_name_en = String(parsed.spouse_name_en).toUpperCase().trim();

  const missingFields = [];
  if (!String(parsed.name_bn || '').trim()) missingFields.push('name_bn');
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
    repaired: Boolean(parsed.auto_transliterated_en || parsed.deepseek_en_completed || parsed._json_repaired || parsed.gender_inferred)
  };

  const normMob = body.mobileNumber ? normalizeDigits(body.mobileNumber).replace(/[^0-9]/g, '').trim() : '';
  if (normMob && !/^01[3-9]\d{8}$/.test(normMob)) warnings.push('মোবাইল নম্বরটি সঠিক ১১ সংখ্যার নয়।');

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
        let rawBase64 = String(rawInput);
        const uriMatch = rawBase64.match(/^data:([^;]+);base64,(.+)$/s);
        if (uriMatch) {
          mimeType = uriMatch[1] || mimeType;
          rawBase64 = uriMatch[2];
        }

        const promptText = buildGeminiPrompt(docType);

        function needsWorkerEscalation(p) {
          if (!p || typeof p !== 'object') return true;
          if (p.confidence === 'low') return true;
          if (!String(p.name_bn || '').trim() || !String(p.name_en || '').trim()) return true;
          if (!/^\d{2}\/\d{2}\/\d{4}$/.test(standardizeDate(p.dob || ''))) return true;
          const effectiveType = (docType && docType !== 'auto') ? docType : (p.doc_type || 'nid');
          if (!isDocDigitsValidForType(effectiveType, p)) return true;
          const normGender = normalizeGenderValue(p.gender);
          if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(normGender)) return true;
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
          const effectiveType = (docType && docType !== 'auto')
            ? docType
            : (escalated.doc_type && escalated.doc_type !== 'auto' ? escalated.doc_type : (primary.doc_type || 'nid'));
          const merged = { ...primary, ...escalated, doc_type: effectiveType };
          const stringFields = [
            'name_bn', 'name_en', 'father_name_bn', 'father_name_en',
            'mother_name_bn', 'mother_name_en', 'spouse_name_bn', 'spouse_name_en',
            'relation_suggestion', 'marital_status_suggestion'
          ];
          for (const f of stringFields) {
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
          if (!isDocDigitsValidForType(effectiveType, escalated) && isDocDigitsValidForType(effectiveType, primary)) {
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
          const attempts = [];
          for (const model of modelsOrder) {
            if (INTERACTIONS_API_MODELS.has(model)) {
              const useUltraHigh = (model === 'gemini-3.8-flash' || model === 'gemini-4-argon') && (docType === 'birth_certificate' || isEscalation);
              const imageResolution = useUltraHigh ? 'ultra_high' : 'high';
              const ibody = {
                model,
                input: [
                  { type: 'text', text: promptText },
                  { type: 'image', data: rawBase64, mime_type: mimeType, resolution: imageResolution }
                ],
                response_format: { type: 'text', mime_type: 'application/json', schema: OCR_RESPONSE_SCHEMA },
                generation_config: { thinking_level: isEscalation ? 'medium' : 'low' },
                store: false
              };
              attempts.push({
                model,
                timeoutMs: useUltraHigh || isEscalation ? 35000 : 28000,
                label: `${model} (interactions/${imageResolution})`,
                url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gKey, 'Api-Revision': '2026-05-20' },
                body: ibody
              });
            }
            attempts.push({
              model,
              timeoutMs: isEscalation ? 35000 : 28000,
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

        async function completeWorkerBanglaWithDeepSeek(partialData, preferredModel = 'deepseek-chat') {
          if (!dKey || !partialData || !needsIntelligentCompletion(partialData)) return partialData;
          const models = preferredModel === 'deepseek-flash'
            ? ['deepseek-flash', 'deepseek-chat']
            : ['deepseek-chat', 'deepseek-flash'];
          const compPrompt = `Complete ALL missing or incomplete fields in this Bangladeshi Birth Certificate / NID JSON using your linguistic and domain intelligence:
1. If any Bengali field (*_bn) is readable and its English counterpart (*_en) is blank or contains Bengali, accurately transliterate/translate into Bangladeshi ALL-CAPS English (e.g. "মোঃ" -> "MD.", "মোছাঃ" -> "MOSAMMAT", "রফিকুল ইসলাম" -> "RAFIQUL ISLAM").
2. If any English field (*_en) is present and its Bengali counterpart (*_bn) is blank, provide accurate Bangladeshi Bengali spelling (*_bn) (e.g. "MD." -> "মোঃ", "MOSAMMAT" -> "মোছাঃ").
3. Ensure "dob" is strict ASCII "DD/MM/YYYY", infer "gender" ("পুরুষ" or "নারী" or "হিজড়া") from names/context if missing, and provide sensible "marital_status_suggestion" ("বিবাহিত"/"অবিবাহিত"), "relation_suggestion", and "doc_type" ("nid" or "birth_certificate").
4. Never return "null", "N/A", label prefixes like "নাম:", or Bengali characters inside *_en.
Return ONLY one valid JSON object with keys: doc_type, name_bn, name_en, father_name_bn, father_name_en, mother_name_bn, mother_name_en, spouse_name_bn, spouse_name_en, dob, gender, marital_status_suggestion, relation_suggestion.
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
              const res = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${dKey}` },
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
              if (!res.ok) continue;
              const j = await res.json().catch(() => ({}));
              const txt = j?.choices?.[0]?.message?.content;
              if (!txt) continue;
              const completed = parseOcrJsonText(txt);
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
              if (!['nid', 'birth_certificate'].includes(String(out.doc_type || '').trim()) && ['nid', 'birth_certificate'].includes(String(completed.doc_type || '').trim())) {
                out.doc_type = String(completed.doc_type).trim();
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
              if (j?.usage) {
                const addCost = computeScanUsageAndCost(model, j);
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
            } catch (_) { clearTimeout(timer); }
          }
          return partialData;
        }

        async function runWorkerDeepSeek() {
          const modelsToTry = Array.from(new Set([prefDsModel || 'deepseek-flash', 'deepseek-chat', 'deepseek-flash']));
          let lastErr = 'DeepSeek OCR থেকে উত্তর পাওয়া যায়নি।';
          for (const model of modelsToTry) {
            for (const useJsonMode of [true, false]) {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 28000);
              try {
                const payload = {
                  model,
                  messages: [
                    {
                      role: 'system',
                      content: 'You are an expert Bangladeshi NID and Birth Certificate OCR engine. Even when a Birth Certificate is printed ONLY in Bengali, ALWAYS provide BOTH *_bn AND transliterated ALL-CAPS English *_en fields in a single valid JSON object.'
                    },
                    {
                      role: 'user',
                      content: [
                        { type: 'text', text: promptText },
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${rawBase64}`, detail: 'high' } }
                      ]
                    }
                  ],
                  max_tokens: 2048
                };
                if (useJsonMode) payload.response_format = { type: 'json_object' };
                const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
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
                  if (useJsonMode && /response_format/i.test(msg)) continue;
                  break;
                }
                const outText = dsJson?.choices?.[0]?.message?.content || '';
                if (!outText) {
                  lastErr = `${model}: DeepSeek খালি উত্তর পাঠিয়েছে।`;
                  break;
                }
                let p = parseOcrJsonText(outText);
                p.ocr_model_used = `${model} (api.deepseek.com)`;
                p.ocr_usage = computeScanUsageAndCost(model, dsJson);
                if (needsEnglishCompletion(p)) {
                  p = await completeWorkerBanglaWithDeepSeek(p, model);
                }
                return p;
              } catch (e) {
                clearTimeout(timer);
                if (e.statusCode === 400 || e.statusCode === 402) throw e;
                lastErr = e.name === 'AbortError' ? `${model}: DeepSeek Timeout` : `${model}: ${e.message}`;
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

        let parsed = null;
        if (aiProvider === 'deepseek') {
          try {
            parsed = await runWorkerDeepSeek();
          } catch (dsErr) {
            if (dsErr.isVisionUnsupported && gKey) {
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
              if (!needsWorkerEscalation(primaryRes) || prefGemModel === 'gemini-3.8-flash') {
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

        if (dKey && needsIntelligentCompletion(parsed)) {
          parsed = await completeWorkerBanglaWithDeepSeek(parsed, prefDsModel);
        }
        validateAndNormalizeOcrData(parsed, body);
        return Response.json({ success: true, data: parsed }, { headers: CORS_HEADERS });
      } catch (err) {
        logWorkerErrorToFirebase({
          source: 'cloudflare-worker',
          level: 'error',
          stage: 'api-extract-nid',
          message: err.message || 'Worker OCR error'
        });
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

    // Health check endpoint
    if (path === '/api/info') {
      return Response.json({
        status: 'online',
        edge: 'cloudflare-worker',
        providers: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.1-flash-lite', 'deepseek-flash'],
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
