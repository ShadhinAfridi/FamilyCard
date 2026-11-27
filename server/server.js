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

function hasBengaliScript(str) {
  return /[\u0980-\u09FF]/.test(String(str || ''));
}

const BN_NAME_WORD_MAP = {
  'মোঃ': 'MD.', 'মো:': 'MD.', 'মো.': 'MD.', 'মোহাম্মদ': 'MOHAMMAD', 'মোহাম্মাদ': 'MOHAMMAD', 'মুহাম্মদ': 'MUHAMMAD',
  'মোছাঃ': 'MST.', 'মোছা:': 'MST.', 'মোছা.': 'MST.', 'মোসাম্মাৎ': 'MOSAMMAT', 'মোসাম্মৎ': 'MOSAMMAT', 'মোসাম্মত': 'MOSAMMAT', 'মোসাঃ': 'MOSA.', 'মোসা:': 'MOSA.',
  'শ্রী': 'SRI', 'শ্রীমতী': 'SRIMOTI', 'শেখ': 'SHEIKH', 'সৈয়দ': 'SYED', 'সৈয়দ': 'SYED',
  'খন্দকার': 'KHANDAKER', 'চৌধুরী': 'CHOWDHURY', 'মজুমদার': 'MAJUMDER', 'তালুকদার': 'TALUKDER',
  'সরকার': 'SARKAR', 'মন্ডল': 'MONDAL', 'মণ্ডল': 'MONDAL', 'বিশ্বাস': 'BISWAS', 'ভূঁইয়া': 'BHUIYAN', 'ভুঁইয়া': 'BHUIYAN',
  'হোসেন': 'HOSSAIN', 'হোসাইন': 'HOSSAIN', 'ইসলাম': 'ISLAM', 'আহমেদ': 'AHMED',
  'আহম্মেদ': 'AHMED', 'আহমদ': 'AHMED', 'রহমান': 'RAHMAN', 'করিম': 'KARIM',
  'রহিম': 'RAHIM', 'আলী': 'ALI', 'আলি': 'ALI', 'খাতুন': 'KHATUN', 'বেগম': 'BEGUM',
  'আক্তার': 'AKTER', 'আখতার': 'AKHTAR', 'সুলতানা': 'SULTANA', 'জাহান': 'JAHAN',
  'ইয়াসমিন': 'YASMIN', 'ইয়াসমিন': 'YASMIN', 'পারভীন': 'PARVIN', 'পারভিন': 'PARVIN',
  'নাহার': 'NAHAR', 'রফিকুল': 'RAFIQUL', 'রফিক': 'RAFIQ', 'শফিকুল': 'SHAFIQUL', 'শফিক': 'SHAFIQ',
  'তরিকুল': 'TARIQUL', 'তৌহিদুল': 'TOUHIDUL', 'সাইফুল': 'SAIFUL', 'নজরুল': 'NAZRUL', 'সিরাজুল': 'SIRAJUL',
  'আব্দুল': 'ABDUL', 'আবদুল': 'ABDUL', 'আব্দুর': 'ABDUR', 'আবদুর': 'ABDUR', 'আব্দুস': 'ABDUS', 'আবুল': 'ABUL',
  'আব্দুল্লাহ': 'ABDULLAH', 'আবদুল্লাহ': 'ABDULLAH', 'আবু': 'ABU', 'হাসান': 'HASAN', 'হাছান': 'HASAN',
  'হাবিব': 'HABIB', 'হাবিবুর': 'HABIBUR', 'কবির': 'KABIR', 'হুমায়ুন': 'HUMAYUN', 'হুমায়ুন': 'HUMAYUN',
  'কামাল': 'KAMAL', 'জামাল': 'JAMAL', 'আলম': 'ALAM', 'মিয়া': 'MIA', 'মিয়া': 'MIA', 'মিঞা': 'MIA',
  'মুন্সি': 'MUNSHI', 'মুন্সী': 'MUNSHI', 'মোস্তফা': 'MOSTAFA', 'সালাম': 'SALAM', 'মজিদ': 'MAJID',
  'হাকিম': 'HAKIM', 'হালিম': 'HALIM', 'রশিদ': 'RASHID', 'লতিফ': 'LATIF', 'খালিদ': 'KHALID', 'খালেদ': 'KHALED',
  'জব্বার': 'JABBAR', 'সাত্তার': 'SATTAR', 'গফুর': 'GAFUR', 'মান্নান': 'MANNAN',
  'হান্নান': 'HANNAN', 'মনির': 'MONIR', 'মনিরুল': 'MONIRUL', 'নূর': 'NUR', 'নুর': 'NUR', 'নূরুল': 'NURUL', 'নুরুল': 'NURUL',
  'রুহুল': 'RUHUL', 'আমিন': 'AMIN', 'আমিনুল': 'AMINUL', 'শহীদ': 'SHAHID', 'শহিদ': 'SHAHID', 'শহীদুল': 'SHAHIDUL', 'শহিদুল': 'SHAHIDUL',
  'মাহমুদ': 'MAHMUD', 'মাহমুদুল': 'MAHMUDUL', 'রাসেল': 'RASEL', 'রিপন': 'RIPON', 'সজীব': 'SAJIB', 'সজিব': 'SAJIB', 'সুজন': 'SUJAN',
  'তানভীর': 'TANVIR', 'তানভির': 'TANVIR', 'সাকিব': 'SAKIB', 'শাকিব': 'SAKIB', 'শাকিল': 'SHAKIL',
  'আরিফ': 'ARIF', 'আরিফুল': 'ARIFUL', 'আশরাফ': 'ASHRAF', 'আশরাফুল': 'ASHRAFUL', 'ফারুক': 'FARUK', 'ফজলুল': 'FAZLUL',
  'মশিউর': 'MOSHIUR', 'মাহবুব': 'MAHBUB', 'মিজানুর': 'MIZANUR', 'মজিবুর': 'MUJIBUR', 'আনিছুর': 'ANISUR', 'আনিসুর': 'ANISUR',
  'আজিজ': 'AZIZ', 'আজিজুল': 'AZIZUL', 'রেজাউল': 'REZAUL', 'শামসুল': 'SHAMSUL', 'জহিরুল': 'ZAHIRUL', 'জাহিদ': 'ZAHID', 'জাহিদুল': 'ZAHIDUL',
  'আনোয়ার': 'ANOWAR', 'আনোয়ার': 'ANOWAR', 'দেলোয়ার': 'DELOWAR', 'দেলোয়ার': 'DELOWAR', 'মনোয়ার': 'MONOWAR', 'মনোয়ার': 'MONOWAR',
  'সরোয়ার': 'SAROWAR', 'সরোয়ার': 'SAROWAR', 'জাহাঙ্গীর': 'JAHANGIR', 'জাহাংগীর': 'JAHANGIR',
  'আলমগীর': 'ALAMGIR', 'শাহীন': 'SHAHIN', 'শাহিন': 'SHAHIN', 'শাহজাহান': 'SHAHJAHAN', 'সোহাগ': 'SOHAG', 'সোহেল': 'SOHEL',
  'ইব্রাহিম': 'IBRAHIM', 'ইব্রাহীম': 'IBRAHIM', 'ইসমাইল': 'ISMAIL', 'ইউসুফ': 'YUSUF', 'ইউনুস': 'YUNUS',
  'ইয়াকুব': 'YAKUB', 'ইয়াকুব': 'YAKUB', 'সোলাইমান': 'SULAIMAN', 'হক': 'HAQUE', 'বেলাল': 'BELAL', 'জালাল': 'JALAL', 'হেলাল': 'HELAL', 'দুলাল': 'DULAL',
  'ফাতেমা': 'FATEMA', 'আয়েশা': 'AYESHA', 'আয়েশা': 'AYESHA', 'খাদিজা': 'KHADIJA',
  'মরিয়ম': 'MARIYAM', 'মরিয়ম': 'MARIYAM', 'সুমাইয়া': 'SUMAIYA', 'সুমাইয়া': 'SUMAIYA',
  'তাসনিম': 'TASNIM', 'নুসরাত': 'NUSRAT', 'শারমিন': 'SHARMIN', 'রোকসানা': 'ROKSANA', 'ফারজানা': 'FARZANA', 'তানিয়া': 'TANIA', 'তানিয়া': 'TANIA',
  'সালমা': 'SALMA', 'হালিমা': 'HALIMA', 'সখিনা': 'SAKHINA', 'সকিনা': 'SAKINA', 'জামিলা': 'JAMILA', 'রোকেয়া': 'ROKEYA', 'রোকেয়া': 'ROKEYA',
  'আনোয়ারা': 'ANOWARA', 'আনোয়ারা': 'ANOWARA', 'মনোয়ারা': 'MONOWARA', 'মনোয়ারা': 'MONOWARA', 'জাহানারা': 'JAHANARA', 'সাহারা': 'SAHARA',
  'রেহানা': 'REHANA', 'শাহানা': 'SHAHANA', 'রুবিনা': 'RUBINA', 'শিরিন': 'SHIRIN', 'নাজমা': 'NAZMA', 'নাসরিন': 'NASRIN',
  'তাহমিনা': 'TAHMINA', 'তাসলিমা': 'TASLIMA', 'বিলকিস': 'BILKIS', 'রাবেয়া': 'RABEYA', 'রাবেয়া': 'RABEYA', 'সালেহা': 'SALEHA',
  'লায়লা': 'LAYLA', 'লায়লা': 'LAYLA', 'নূরজাহান': 'NURJAHAN', 'নুরজাহান': 'NURJAHAN', 'রানী': 'RANI', 'রাণী': 'RANI', 'দেবী': 'DEVI', 'বিবি': 'BIBI', 'নেছা': 'NESSA', 'বানু': 'BANU',
  'দাস': 'DAS', 'দাশ': 'DAS', 'পাল': 'PAL', 'রায়': 'ROY', 'রায়': 'ROY', 'সেন': 'SEN', 'ঘোষ': 'GHOSH', 'বসু': 'BASU', 'বর্মন': 'BARMAN',
  'দত্ত': 'DUTTA', 'হালদার': 'HALDER', 'মল্লিক': 'MALLICK', 'প্রামাণিক': 'PRAMANIK', 'শর্মা': 'SHARMA', 'চক্রবর্তী': 'CHAKRABORTY', 'চন্দ্র': 'CHANDRA',
  'ফকির': 'FAKIR', 'মৃধা': 'MRIDHA', 'হাওলাদার': 'HOWLADER', 'সরদার': 'SARDAR', 'সিকদার': 'SIKDER', 'পাটোয়ারী': 'PATWARY', 'পাটোয়ারী': 'PATWARY',
  'মোল্লা': 'MOLLA', 'কাজী': 'KAZI', 'গাজী': 'GAZI', 'ব্যাপারী': 'BEPARI', 'তরফদার': 'TARAFDAR',
  'খান': 'KHAN', 'উদ্দিন': 'UDDIN', 'উদ্দীন': 'UDDIN', 'আহসান': 'AHSAN', 'সাঈদ': 'SAID'
};

const EN_NAME_WORD_MAP = {
  'MD.': 'মোঃ', 'MD': 'মোঃ', 'MOHD': 'মোঃ', 'MOHAMMAD': 'মোহাম্মদ', 'MOHAMMED': 'মোহাম্মদ', 'MUHAMMAD': 'মুহাম্মদ',
  'MST.': 'মোছাঃ', 'MST': 'মোছাঃ', 'MOSAMMAT': 'মোছাঃ', 'MOSAMMOT': 'মোছাঃ', 'MRS': 'বেগম',
  'SRI': 'শ্রী', 'SHREE': 'শ্রী', 'SRIMOTI': 'শ্রীমতী', 'SHRIMATI': 'শ্রীমতী',
  'SHEIKH': 'শেখ', 'SK': 'শেখ', 'SYED': 'সৈয়দ', 'KHANDAKER': 'খন্দকার', 'CHOWDHURY': 'চৌধুরী',
  'MAJUMDER': 'মজুমদার', 'TALUKDER': 'তালুকদার', 'SARKAR': 'সরকার', 'SARKER': 'সরকার',
  'MONDAL': 'মন্ডল', 'MANDAL': 'মন্ডল', 'BISWAS': 'বিশ্বাস', 'BHUIYAN': 'ভূঁইয়া',
  'HOSSAIN': 'হোসেন', 'HOSEN': 'হোসেন', 'HUSSAIN': 'হোসেন', 'ISLAM': 'ইসলাম',
  'AHMED': 'আহমেদ', 'AHMAD': 'আহমেদ', 'RAHMAN': 'রহমান', 'ROHMAN': 'রহমান',
  'KARIM': 'করিম', 'KORIM': 'করিম', 'RAHIM': 'রহিম', 'ROHIM': 'রহিম',
  'ALI': 'আলী', 'KHATUN': 'খাতুন', 'BEGUM': 'বেগম', 'AKTER': 'আক্তার', 'AKHTAR': 'আখতার', 'AKHTER': 'আক্তার',
  'SULTANA': 'সুলতানা', 'JAHAN': 'জাহান', 'YASMIN': 'ইয়াসমিন', 'YESMIN': 'ইয়াসমিন', 'PARVIN': 'পারভীন', 'PARVEEN': 'পারভীন',
  'NAHAR': 'নাহার', 'RAFIQUL': 'রফিকুল', 'RAFIQ': 'রফিক', 'SHAFIQUL': 'শফিকুল', 'SHAFIQ': 'শফিক', 'TARIQUL': 'তরিকুল', 'TARIQ': 'তারিক',
  'ABDUL': 'আব্দুল', 'ABDUR': 'আব্দুর', 'ABDUS': 'আব্দুস', 'ABUL': 'আবুল', 'ABDULLAH': 'আব্দুল্লাহ', 'ABU': 'আবু',
  'HASAN': 'হাসান', 'HASSAN': 'হাসান', 'HABIB': 'হাবিব', 'HABIBUR': 'হাবিবুর', 'KABIR': 'কবির',
  'NAZRUL': 'নজরুল', 'SAIFUL': 'সাইফুল', 'SIRAJUL': 'সিরাজুল', 'TOUHIDUL': 'তৌহিদুল',
  'KAMAL': 'কামাল', 'JAMAL': 'জামাল', 'ALAM': 'আলম', 'MIA': 'মিয়া', 'MIAH': 'মিয়া', 'MIYA': 'মিয়া',
  'MUNSHI': 'মুন্সী', 'MOSTAFA': 'মোস্তফা', 'MUSTAFA': 'মোস্তফা', 'SALAM': 'সালাম', 'MAJID': 'মজিদ',
  'HAKIM': 'হাকিম', 'HALIM': 'হালিম', 'RASHID': 'রশিদ', 'LATIF': 'লতিফ', 'KHALID': 'খালিদ', 'KHALED': 'খালেদ',
  'JABBAR': 'জব্বার', 'SATTAR': 'সাত্তার', 'GAFUR': 'গফুর', 'MANNAN': 'মান্নান', 'HANNAN': 'হান্নান',
  'MONIR': 'মনির', 'MONIRUL': 'মনিরুল', 'NUR': 'নূর', 'NOOR': 'নূর', 'NURUL': 'নূরুল', 'RUHUL': 'রুহুল',
  'AMIN': 'আমিন', 'AMINUL': 'আমিনুল', 'SHAHID': 'শহীদ', 'SHAHIDUL': 'শহীদুল', 'MAHMUD': 'মাহমুদ', 'MAHMUDUL': 'মাহমুদুল',
  'RASEL': 'রাসেল', 'RIPON': 'রিপন', 'SAJIB': 'সজীব', 'SUJAN': 'সুজন', 'SUJON': 'সুজন',
  'TANVIR': 'তানভীর', 'SAKIB': 'সাকিব', 'SHAKIB': 'শাকিব', 'SHAKIL': 'শাকিল',
  'ARIF': 'আরিফ', 'ARIFUL': 'আরিফুল', 'ASHRAF': 'আশরাফ', 'ASHRAFUL': 'আশরাফুল', 'FARUK': 'ফারুক', 'FARUQ': 'ফারুক', 'FAZLUL': 'ফজলুল',
  'MOSHIUR': 'মশিউর', 'MAHBUB': 'মাহবুব', 'MIZANUR': 'মিজানুর', 'MUJIBUR': 'মজিবুর', 'ANISUR': 'আনিসুর',
  'AZIZ': 'আজিজ', 'AZIZUL': 'আজিজুল', 'REZAUL': 'রেজাউল', 'SHAMSUL': 'শামসুল', 'ZAHIRUL': 'জহিরুল', 'ZAHID': 'জাহিদ', 'ZAHIDUL': 'জাহিদুল',
  'ANOWAR': 'আনোয়ার', 'ANWAR': 'আনোয়ার', 'DELOWAR': 'দেলোয়ার', 'MONOWAR': 'মনোয়ার', 'SAROWAR': 'সরোয়ার',
  'JAHANGIR': 'জাহাঙ্গীর', 'ALAMGIR': 'আলমগীর', 'SHAHIN': 'শাহীন', 'SHAHJAHAN': 'শাহজাহান', 'SOHAG': 'সোহাগ', 'SOHEL': 'সোহেল',
  'IBRAHIM': 'ইব্রাহিম', 'ISMAIL': 'ইসমাইল', 'YUSUF': 'ইউসুফ', 'YUNUS': 'ইউনুস', 'YAKUB': 'ইয়াকুব', 'SULAIMAN': 'সোলাইমান',
  'HAQUE': 'হক', 'HOQUE': 'হক', 'BELAL': 'বেলাল', 'JALAL': 'জালাল', 'HELAL': 'হেলাল', 'DULAL': 'দুলাল', 'HUMAYUN': 'হুমায়ুন',
  'FATEMA': 'ফাতেমা', 'FATIMA': 'ফাতেমা', 'AYESHA': 'আয়েশা', 'KHADIJA': 'খাদিজা', 'MARIYAM': 'মরিয়ম', 'MORIUM': 'মরিয়ম',
  'SUMAIYA': 'সুমাইয়া', 'TASNIM': 'তাসনিম', 'NUSRAT': 'নুসরাত', 'SHARMIN': 'শারমিন', 'ROKSANA': 'রোকসানা', 'FARZANA': 'ফারজানা',
  'TANIA': 'তানিয়া', 'SONIA': 'সোনিয়া', 'SALMA': 'সালমা', 'HALIMA': 'হালিমা', 'SAKHINA': 'সখিনা', 'SAKINA': 'সকিনা',
  'JAMILA': 'জামিলা', 'ROKEYA': 'রোকেয়া', 'ANOWARA': 'আনোয়ারা', 'MONOWARA': 'মনোয়ারা', 'JAHANARA': 'জাহানারা',
  'REHANA': 'রেহানা', 'SHAHANA': 'শাহানা', 'RUBINA': 'রুবিনা', 'SHIRIN': 'শিরিন', 'NAZMA': 'নাজমা', 'NASRIN': 'নাসরিন',
  'TAHMINA': 'তাহমিনা', 'TASLIMA': 'তাসলিমা', 'BILKIS': 'বিলকিস', 'RABEYA': 'রাবেয়া', 'SALEHA': 'সালেহা', 'LAYLA': 'লায়লা',
  'NURJAHAN': 'নূরজাহান', 'RANI': 'রাণী', 'DEVI': 'দেবী', 'DEBI': 'দেবী', 'BIBI': 'বিবি', 'NESSA': 'নেছা', 'BANU': 'বানু',
  'DAS': 'দাস', 'PAL': 'পাল', 'PAUL': 'পাল', 'ROY': 'রায়', 'RAY': 'রায়', 'SEN': 'সেন', 'GHOSH': 'ঘোষ',
  'DUTTA': 'দত্ত', 'HALDER': 'হালদার', 'MALLICK': 'মল্লিক', 'PRAMANIK': 'প্রামাণিক', 'SHARMA': 'শর্মা',
  'CHAKRABORTY': 'চক্রবর্তী', 'CHANDRA': 'চন্দ্র', 'BARMAN': 'বর্মন', 'FAKIR': 'ফকির', 'MRIDHA': 'মৃধা',
  'HOWLADER': 'হাওলাদার', 'SARDAR': 'সরদার', 'SIKDER': 'সিকদার', 'PATWARY': 'পাটোয়ারী',
  'MOLLA': 'মোল্লা', 'MOLLAH': 'মোল্লা', 'KAZI': 'কাজী', 'GAZI': 'গাজী', 'BEPARI': 'ব্যাপারী', 'TARAFDAR': 'তরফদার',
  'KHAN': 'খান', 'UDDIN': 'উদ্দিন', 'AHSAN': 'আহসান', 'SAID': 'সাঈদ'
};

function transliterateBnWordToEn(word) {
  if (!word) return '';
  const nfc = String(word)
    .normalize('NFC')
    .replace(/ড\u09BC/g, 'ড়')
    .replace(/ঢ\u09BC/g, 'ঢ়')
    .replace(/য\u09BC/g, 'য়')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  if (!nfc) return '';
  if (BN_NAME_WORD_MAP[nfc]) return BN_NAME_WORD_MAP[nfc];
  const bare = nfc.replace(/[।,;:!?'"()\[\]]+/g, '');
  if (BN_NAME_WORD_MAP[bare]) return BN_NAME_WORD_MAP[bare];
  if (!hasBengaliScript(bare)) return normalizeDigits(bare).toUpperCase();

  const indVowels = { 'অ': 'O', 'আ': 'A', 'ই': 'I', 'ঈ': 'I', 'উ': 'U', 'ঊ': 'U', 'ঋ': 'RI', 'এ': 'E', 'ঐ': 'OI', 'ও': 'O', 'ঔ': 'OU' };
  const kars = { 'া': 'A', 'ি': 'I', 'ী': 'I', 'ু': 'U', 'ূ': 'U', 'ৃ': 'RI', 'ে': 'E', 'ৈ': 'OI', 'ো': 'O', 'ৌ': 'OU' };
  const cons = {
    'ক': 'K', 'খ': 'KH', 'গ': 'G', 'ঘ': 'GH', 'ঙ': 'NG', 'চ': 'CH', 'ছ': 'CHH', 'জ': 'J', 'ঝ': 'JH', 'ঞ': 'N',
    'ট': 'T', 'ঠ': 'TH', 'ড': 'D', 'ঢ': 'DH', 'ণ': 'N', 'ত': 'T', 'থ': 'TH', 'দ': 'D', 'ধ': 'DH', 'ন': 'N',
    'প': 'P', 'ফ': 'F', 'ব': 'B', 'ভ': 'BH', 'ম': 'M', 'য': 'J', 'র': 'R', 'ল': 'L', 'শ': 'SH', 'ষ': 'SH', 'স': 'S', 'হ': 'H',
    'ড়': 'R', 'ঢ়': 'RH', 'য়': 'Y', 'ৎ': 'T'
  };
  const jukto5 = {
    'ক্ষ্ম': 'KSHM', 'স্ত্র': 'STR', 'ন্ত্র': 'NTR', 'ন্দ্র': 'NDR', 'ন্দ্ব': 'NDW',
    'ম্প্র': 'MPR', 'ম্ব্র': 'MBR', 'ষ্ট্র': 'SHTR', 'স্ক্র': 'SKR', 'স্প্র': 'SPR',
    'ঙ্ক্ষ': 'NGKSH', 'ঞ্জ্য': 'NJY', 'চ্ছ্ব': 'CHHW', 'ত্ত্ব': 'TTW', 'দ্ধ্ব': 'DDHW',
    'জ্জ্ব': 'JJW', 'ঙ্গ্য': 'NGGY'
  };
  const jukto3 = {
    'হ্ম': 'HM', 'ঞ্চ': 'NCH', 'ঞ্জ': 'NJ', 'ঞ্ছ': 'NCHH', 'ঙ্গ': 'NG', 'ঙ্ক': 'NK',
    'ঙ্খ': 'NKH', 'ঙ্ঘ': 'NGH', 'ষ্ণ': 'SHN', 'ষ্ট': 'SHT', 'ষ্ঠ': 'SHTH', 'শ্চ': 'SHCH',
    'শ্র': 'SHR', 'ক্ত': 'KT', 'ত্ত': 'TT', 'ত্র': 'TR', 'দ্দ': 'DD', 'দ্ধ': 'DDH',
    'দ্র': 'DR', 'ব্দ': 'BD', 'ণ্ড': 'ND', 'ন্ড': 'ND', 'ন্ত': 'NT', 'ন্দ': 'ND',
    'ন্ধ': 'NDH', 'ন্ন': 'NN', 'ন্স': 'NS', 'ম্প': 'MP', 'ম্ব': 'MB', 'ম্ভ': 'MBH',
    'ম্ম': 'MM', 'স্ত': 'ST', 'স্থ': 'STH', 'স্প': 'SP', 'স্ম': 'SM', 'স্ব': 'SW', 'শ্ব': 'SHW',
    'ল্ল': 'LL', 'ল্প': 'LP', 'চ্ছ': 'CHH', 'জ্জ': 'JJ', 'ট্ট': 'TT', 'ত্ম': 'TM',
    'দ্ভ': 'DBH', 'হ্ণ': 'HN', 'হ্ন': 'HN', 'হ্য': 'HY'
  };
  const finalAJukto = new Set(['স্ত্র', 'ন্ত্র', 'ন্দ্র', 'ষ্ণ', 'ষ্ঠ', 'ক্ত', 'ত্ত', 'ত্র', 'দ্ধ', 'দ্র', 'ন্ত', 'ন্দ', 'ন্ধ', 'স্থ']);
  let out = '';
  let i = 0;
  let lastConsStartIdx = 0;
  let lastWasVowel = true;
  while (i < bare.length) {
    const ch = bare[i];
    if (ch >= '০' && ch <= '৯') {
      out += String(ch.charCodeAt(0) - 0x09E6);
      lastWasVowel = false;
      i++;
      continue;
    }
    const s5 = bare.slice(i, i + 5);
    if (jukto5[s5]) {
      out += jukto5[s5];
      i += 5;
      const nextCh = bare[i] || '';
      if ((!kars[nextCh] && nextCh !== '্' && nextCh !== 'ং' && nextCh !== 'ঃ' && i < bare.length && cons[nextCh])
          || (i === bare.length && finalAJukto.has(s5))) {
        out += 'A';
        lastWasVowel = true;
      } else {
        lastWasVowel = Boolean(kars[nextCh]);
      }
      continue;
    }
    const s3 = bare.slice(i, i + 3);
    if (s3 === 'ক্ষ') {
      out += i === 0 ? 'KH' : 'KSH';
      i += 3;
      const nextCh = bare[i] || '';
      if (!kars[nextCh] && nextCh !== '্' && nextCh !== 'ং' && nextCh !== 'ঃ' && i < bare.length && cons[nextCh]) { out += 'A'; lastWasVowel = true; } else { lastWasVowel = Boolean(kars[nextCh]); }
      continue;
    }
    if (s3 === 'জ্ঞ') {
      out += 'GY';
      i += 3;
      const nextCh = bare[i] || '';
      if (!kars[nextCh] && nextCh !== '্' && nextCh !== 'ং' && nextCh !== 'ঃ' && i < bare.length && cons[nextCh]) { out += 'A'; lastWasVowel = true; } else { lastWasVowel = Boolean(kars[nextCh]); }
      continue;
    }
    if (jukto3[s3]) {
      out += jukto3[s3];
      i += 3;
      const nextCh = bare[i] || '';
      if ((!kars[nextCh] && nextCh !== '্' && nextCh !== 'ং' && nextCh !== 'ঃ' && i < bare.length && cons[nextCh])
          || (i === bare.length && finalAJukto.has(s3))) {
        out += 'A';
        lastWasVowel = true;
      } else {
        lastWasVowel = Boolean(kars[nextCh]);
      }
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
        if (!kars[afterCluster] && afterCluster !== '্' && afterCluster !== 'ং' && afterCluster !== 'ঃ' && i < bare.length && cons[afterCluster]) { out += 'A'; lastWasVowel = true; } else { lastWasVowel = false; }
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

  if (fullFemaleWordRe.test(res) || fullMaleWordRe.test(res)) {
    return res.toUpperCase().replace(/\s+/g, ' ').trim();
  }

  // 1. If Bengali starts with মোছাঃ / মোছা: / মোছা. / মোছা -> English MUST start with MST.
  if (/^(?:মোছাঃ|মোছা:|মোছা\.|মোছা\s+)/.test(bn)) {
    if (mstPrefixRe.test(res)) {
      res = res.replace(mstPrefixRe, 'MST. ');
    } else {
      res = 'MST. ' + res;
    }
  }
  // 2. Else if Bengali starts with মোঃ / মো: / মো. / মো -> English MUST start with MD.
  else if (/^(?:মোঃ|মো:|মো\.|মো\s+)/.test(bn)) {
    if (mdPrefixRe.test(res)) {
      res = res.replace(mdPrefixRe, 'MD. ');
    } else {
      res = 'MD. ' + res;
    }
  }
  // 3. Else if Bengali starts with মোসাঃ / মোসা: / মোসা. / মোসা -> preserve MOSA.
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

  const converted = working.split(/\s+/).map(transliterateBnWordToEn).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return (prefix + converted).trim();
}

function transliterateEnWordToBn(word) {
  if (!word) return '';
  const raw = String(word).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!raw) return '';
  if (hasBengaliScript(raw)) return raw;
  const upper = raw.toUpperCase().replace(/[,;!?'"()\[\]]+/g, '');
  if (!upper) return '';
  if (EN_NAME_WORD_MAP[upper]) return EN_NAME_WORD_MAP[upper];
  const bare = upper.replace(/\.+$/g, '');
  if (EN_NAME_WORD_MAP[bare]) return EN_NAME_WORD_MAP[bare];
  if (/^\d+$/.test(bare)) return bare;
  const s = bare.replace(/[^A-Z]/g, '');
  if (!s) return raw;
  const consRules = [
    ['KSHM', 'ক্ষ্ম'], ['SHTH', 'ষ্ঠ'], ['SHCH', 'শ্চ'],
    ['CHH', 'ছ'], ['KSH', 'ক্ষ'], ['SHR', 'শ্র'], ['STR', 'স্ত্র'], ['NTR', 'ন্ত্র'], ['NDR', 'ন্দ্র'],
    ['SHT', 'ষ্ট'], ['SHN', 'ষ্ণ'], ['NCH', 'ঞ্চ'],
    ['BH', 'ভ'], ['PH', 'ফ'], ['TH', 'থ'], ['DH', 'ধ'], ['KH', 'খ'], ['GH', 'ঘ'],
    ['JH', 'ঝ'], ['CH', 'চ'], ['SH', 'শ'], ['NG', 'ং'], ['GY', 'জ্ঞ'], ['NJ', 'ঞ্জ'], ['HM', 'হ্ম'],
    ['K', 'ক'], ['G', 'গ'], ['C', 'স'], ['J', 'জ'], ['Z', 'জ'],
    ['T', 'ত'], ['D', 'দ'], ['N', 'ন'], ['P', 'প'], ['F', 'ফ'],
    ['B', 'ব'], ['V', 'ভ'], ['M', 'ম'], ['R', 'র'], ['L', 'ল'],
    ['S', 'স'], ['H', 'হ'], ['Q', 'ক'], ['W', 'ও'], ['Y', 'য়'], ['X', 'ক্স']
  ];
  const initVowels = [
    ['AA', 'আ'], ['EE', 'ঈ'], ['OO', 'উ'], ['AI', 'আই'], ['OI', 'ঐ'], ['AU', 'ঔ'], ['OU', 'ঔ'], ['EA', 'ই'],
    ['A', 'আ'], ['I', 'ই'], ['U', 'উ'], ['E', 'এ'], ['O', 'ও']
  ];
  const matras = [
    ['AA', 'া'], ['EE', 'ী'], ['OO', 'ু'], ['AI', 'াই'], ['OI', 'ৈ'], ['AU', 'ৌ'], ['OU', 'ৌ'], ['EA', 'ি'],
    ['A', 'া'], ['I', 'ি'], ['U', 'ু'], ['E', 'ে'], ['O', 'ো']
  ];
  let out = '', i = 0, afterConsonant = false;
  while (i < s.length) {
    let matched = false;
    if (afterConsonant) {
      for (const [pat, matra] of matras) {
        if (s.startsWith(pat, i)) { out += matra; i += pat.length; afterConsonant = false; matched = true; break; }
      }
      if (matched) continue;
    } else {
      for (const [pat, v] of initVowels) {
        if (s.startsWith(pat, i)) { out += v; i += pat.length; afterConsonant = false; matched = true; break; }
      }
      if (matched) continue;
    }
    for (const [pat, c] of consRules) {
      if (s.startsWith(pat, i)) {
        out += (c === 'ং' && !afterConsonant && i === 0) ? 'নগ' : c;
        i += pat.length;
        afterConsonant = c !== 'ং';
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }
  return out || raw;
}

function transliterateEnToBn(enText) {
  if (!enText) return '';
  const cleaned = String(enText).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (hasBengaliScript(cleaned)) return cleaned;
  return cleaned.split(/\s+/).map(transliterateEnWordToBn).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function stripPersonPrefixes(str) {
  return String(str || '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^(?:মৃত|মরহুম|আলহাজ্ব|মোঃ|মো:|মো\.|মোহাম্মদ|মোহাম্মাদ|মোছাঃ|মোছা:|মোছা\.|মোসাম্মৎ|মোসাম্মত|শ্রী|শ্রীমতী|late|md\.?|mohammad|mohammed|mst\.?|mosammat|sri|srimoti)\s+/gi, '')
    .replace(/[^A-Za-z\u0980-\u09FF0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function cleanOcrFieldText(val) {
  if (val === null || val === undefined) return '';
  let s = String(val).normalize('NFC').replace(/ড\u09BC/g, 'ড়').replace(/ঢ\u09BC/g, 'ঢ়').replace(/য\u09BC/g, 'য়').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  if (!s || /^(?:null|none|nil|n\/a|na|undefined|unknown|unreadable|illegible|blurry|unclear|blank|empty|missing|redacted|sample|example|placeholder|dummy|not\s+(?:available|printed|found|visible|clear|legible|applicable|provided|specified)|[-—–_.?*]+|x{3,}|নেই|নাই|অজানা|অস্পষ্ট|খালি|পা[ওো](?:য়া|য\u09BCা)\s*যা(?:য়|য\u09BC)নি|প(?:ড়|ড\u09BC|র)া\s*যা(?:য়|য\u09BC)নি|প্রযোজ্য\s*ন(?:য়|য\u09BC|য))$/i.test(s)) {
    return '';
  }
  s = s.replace(/^(?:নিবন্ধিত\s*ব্যক্তির\s*নাম(?:\s*\((?:বাংলা|ইংরেজি)\))?|আবেদনকারীর\s*নাম(?:\s*\((?:বাংলা|ইংরেজি)\))?|নাম\s*\((?:বাংলা|ইংরেজি)\)|নাম|name(?:\s*\(in\s*(?:english|bangla)\))?|পিতার?\s*নাম(?:\s*\((?:বাংলা|ইংরেজি)\))?|পিতা|father(?:'s)?\s*name(?:\s*\((?:english|bangla)\))?|মাতার?\s*নাম(?:\s*\((?:বাংলা|ইংরেজি)\))?|মাতা|mother(?:'s)?\s*name(?:\s*\((?:english|bangla)\))?|স্বামী\s*\/\s*স্ত্রী(?:র\s*নাম)?|স্বামী(?:র\s*নাম)?|স্ত্রী(?:র\s*নাম)?|spouse(?:'s)?\s*name|husband(?:'s)?\s*name|wife(?:'s)?\s*name|জন্ম\s*তারিখ|date\s*of\s*birth|dob|id\s*no\.?|nid\s*no\.?|birth\s*registration\s*no\.?)\s*[:ঃ\-–]+\s*/i, '').trim();
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
  if (!cleanOcrFieldText(out.doc_number)) out.doc_number = pickAlias(['doc_no', 'docNumber', 'document_number', 'document_no', 'id']) || out.birth_reg_no || out.nid_number || '';
  if (!cleanOcrFieldText(out.father_nid)) out.father_nid = pickAlias(['fatherNid', 'father_nid_no', 'father_national_id', 'father_brc', 'pitar_nid']);
  if (!cleanOcrFieldText(out.mother_nid)) out.mother_nid = pickAlias(['motherNid', 'mother_nid_no', 'mother_national_id', 'mother_brc', 'matar_nid']);
  if (!cleanOcrFieldText(out.registration_date)) out.registration_date = pickAlias(['reg_date', 'date_of_registration', 'issue_date', 'date_of_issuance']);

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
    'doc_type', 'detected_language', 'doc_number', 'nid_number', 'birth_reg_no',
    'father_nid', 'mother_nid', 'registration_date',
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
  return [
    ['name_bn', 'name_en'],
    ['father_name_bn', 'father_name_en'],
    ['mother_name_bn', 'mother_name_en'],
    ['spouse_name_bn', 'spouse_name_en']
  ].some(([bnK, enK]) => {
    const bn = cleanOcrFieldText(data[bnK] || '');
    const en = cleanOcrFieldText(data[enK] || '');
    const hasValidBn = Boolean(bn && hasBengaliScript(bn));
    const hasValidEn = Boolean(en && !hasBengaliScript(en));
    return (hasValidBn && !hasValidEn) || (hasValidEn && !hasValidBn);
  });
}

function needsEnglishCompletion(data = {}) {
  return needsIntelligentCompletion(data);
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

// Helper to standardize Date of Birth (supports English & Bengali months/digits/ordinals) to DD/MM/YYYY
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

  // ISO: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = str.match(/(?:^|\s)(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:\b|$)/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    if (isValidCalendarDate(d, m, y)) {
      return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
    }
    return '';
  }

  // English month names: 15 Aug 1985 / 15-August-1985 / Aug 15, 1985
  const enMonths = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  };
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

  // Bengali month names: ১৪ মে ১৯৮৫ / ০৫ জানুয়ারি ২০১০ / ০২-মার্চ-১৯৯০
  const bnMonthPrefixes = [
    ['জানু', '01'], ['ফেব', '02'], ['মার', '03'], ['এপ্রি', '04'],
    ['মে', '05'], ['জুন', '06'], ['জুল', '07'], ['আগ', '08'],
    ['সেপ', '09'], ['অক', '10'], ['নভ', '11'], ['ডিস', '12']
  ];
  const bnMatch = str.match(/(?:^|\s)(\d{1,2})[\s\-,/.]+([\u0980-\u09FF]+)[\s\-,/.]+(\d{4})(?:\b|$)/);
  if (bnMatch) {
    const d = parseInt(bnMatch[1], 10);
    const tok = bnMatch[2];
    const hit = bnMonthPrefixes.find(([prefix]) => tok.startsWith(prefix));
    const y = parseInt(bnMatch[3], 10);
    if (hit && isValidCalendarDate(d, parseInt(hit[1], 10), y)) {
      return `${String(d).padStart(2, '0')}/${hit[1]}/${y}`;
    }
    if (hit) return '';
  }

  // Standard DD/MM/YYYY with swapped MM/DD/YYYY auto-correction
  str = str.replace(/[-\.]/g, '/');
  const dmyMatch = str.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[^\d]|$)/);
  if (dmyMatch) {
    let d = parseInt(dmyMatch[1], 10);
    let m = parseInt(dmyMatch[2], 10);
    const y = parseInt(dmyMatch[3], 10);
    if (d <= 12 && m > 12 && m <= 31) {
      const tmp = d; d = m; m = tmp;
    }
    if (!isValidCalendarDate(d, m, y)) return '';
    return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
  }

  return '';
}

const OCR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    doc_type: { type: 'string', enum: ['nid', 'birth_certificate'] },
    detected_language: { type: 'string', enum: ['bilingual', 'bn_only', 'en_only', 'unknown'] },
    doc_number: { type: 'string' },
    nid_number: { type: 'string' },
    birth_reg_no: { type: 'string' },
    father_nid: { type: 'string' },
    mother_nid: { type: 'string' },
    registration_date: { type: 'string' },
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
You are a high-precision bilingual (Bangla and English) document OCR and data-extraction assistant specializing in Bangladeshi identity documents:
1. Bangladeshi National Identity (NID) Cards (Smart Cards and classic laminated paper NID cards).
2. Bangladeshi Birth Registration Certificates (জন্ম নিবন্ধন সনদপত্র / BRC — bilingual, Bangla-only, or English-only).

${hintLine}

STRICT EXTRACTION & PRESERVATION RULES (CRITICAL):
1. PRESERVE EXISTING VALUES (NEVER OVERWRITE):
   - Extract ONLY characters, spellings, names, and numbers physically visible in the document image.
   - If a field ALREADY contains BOTH English and Bangla values printed on the document (e.g., Applicant Name on an NID, or a bilingual BRC), keep BOTH exact OCR-extracted values verbatim as-is. NEVER translate, transliterate, rewrite, or alter either existing value!
   - Keep exact printed Bengali spellings unchanged ("মন্ডল" vs "মণ্ডল", "মোসাঃ" vs "মোছাঃ", "আঃ", "নুর" vs "নূর", "আলী" vs "আলি", "হোসেন" vs "হোসাইন") and exact printed English unchanged ("MOHAMMAD", "MOSAMMAT", etc.).
2. CONDITIONAL BILINGUAL EXTRACTION (MISSING LANGUAGE ONLY):
   - If a field has ONLY a Bangla value printed on the document (e.g., Father's Name, Mother's Name, or Husband's Name on an NID, or Bangla-only BRC) and NO English value is printed: keep the exact Bangla OCR text in *_bn and return "" for *_en (missing English will be transliterated separately without touching existing fields).
   - If a field has ONLY an English value printed on the document (e.g., English-only BRC) and NO Bangla value is printed: keep the exact English OCR text in *_en and return "" for *_bn.
   - NEVER invent, fabricate, guess, pad, or synthesize ANY field or digit! If a field is not printed, cut off, or unreadable, return "".
   - If the image is blank, dark, blurry, or NOT a Bangladeshi NID / Birth Registration Certificate, return "" for all person/number/date fields and set "confidence": "low".
   - NEVER output placeholder strings like "unknown", "unreadable", "N/A", "null", or sequential dummy digits.
   - Set "detected_language" to "bilingual", "bn_only", "en_only", or "unknown".
   - NEVER put Bengali characters in *_en fields or Latin letters in *_bn fields.
3. STRICT CHARACTER, DIGIT & JUKTOBORNO (যুক্তবর্ণ) ACCURACY:
   - Accurately recognize and preserve ALL Bangla vowels (স্বরবর্ণ: অ, আ, ই, ঈ, উ, ঊ, ঋ, এ, ঐ, ও, ঔ), consonants (ব্যঞ্জনবর্ণ: ক–হ, ড়, ঢ়, য়), diacritics/signs (কার: া ি ী ু ূ ৃ ে ৈ ো ৌ; ফলা: ্য ্র ্ব ্ল ্ম ্ন ্ণ; রেফ: র্; ং ঃ ঁ ৎ), Bangla digits (০–৯), English alphanumerics (A–Z, 0–9), and complex Bangla conjunct consonants (যুক্তবর্ণ: ক্ষ, ক্ষ্ম, জ্ঞ, ঞ্জ, ঞ্চ, ঞ্ছ, ঙ্গ, ঙ্ক, ঙ্ঘ, হ্ম, ত্ত, ত্র, দ্দ, দ্ধ, দ্র, ব্দ, শ্র, প্র, স্ত, স্থ, স্প, স্ম, স্ব, স্ত্র, ন্ত্র, ন্দ্র, ক্ত, ষ্ট, ষ্ঠ, ষ্ণ, ণ্ড, ন্ড, ন্ত, ন্দ, ন্ধ, ন্ন, ন্স, ম্প, ম্ব, ম্ভ, ম্ম, ল্ল, ল্প, শ্চ, চ্ছ, জ্জ, ট্ট, ত্ম, দ্ভ) without breaking or substituting characters.
   - Always use standard phonetic transliteration (NEVER literal meaning translation) for personal names, villages, and addresses.
4. DOCUMENT NUMBERS, DATES, GENDER & SPOUSE:
   - Birth Registration Certificates: strictly 17 digits starting with the 4-digit birth year (YYYY...). Put Father's/Mother's NID ONLY into "father_nid" and "mother_nid", NEVER into "birth_reg_no"/"doc_number".
   - NID Cards: 10 digits (Smart NID) or 13/17 digits (Classic NID). Extract ONLY clearly visible digits; NEVER pad or guess missing digits.
   - Extract "dob" in strict ASCII DD/MM/YYYY format. On Birth Certificates, put Date of Birth in "dob" and Date of Registration in "registration_date" (NEVER copy registration_date into dob).
   - Set "gender" to "পুরুষ", "নারী", or "হিজড়া" ONLY if printed or clearly evident; otherwise return "".
   - If classic laminated NID prints "স্বামী:" (Husband), put that name into "spouse_name_bn" (and "spouse_name_en" only if printed). NEVER copy husband's name into father fields!
   - Leave "relation_suggestion" and "marital_status_suggestion" as "" unless directly evidenced on the document (e.g. "স্বামী:" implies "বিবাহিত").

Return strictly ONE valid minified JSON object with ONLY these keys (use "" for any absent or unreadable field):
doc_type, detected_language, doc_number, nid_number, birth_reg_no, father_nid, mother_nid, registration_date, name_bn, name_en, dob, gender, father_name_bn, father_name_en, mother_name_bn, mother_name_en, spouse_name_bn, spouse_name_en, relation_suggestion, marital_status_suggestion, confidence.
`;
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
  if (Array.isArray(textOutput)) {
    textOutput = textOutput.map(p => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('\n');
  } else if (textOutput && typeof textOutput === 'object') {
    return normalizeOcrKeyAliases(textOutput);
  }
  const raw = String(textOutput || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^<think>[\s\S]*?(?=\{)/i, '')
    .trim();
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let cleaned = fenceMatch ? fenceMatch[1].trim() : raw;
  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    cleaned = cleaned.slice(objStart, objEnd + 1);
  } else if (objStart !== -1) {
    cleaned = cleaned.slice(objStart);
  }
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch (_) { return null; }
  };
  let parsed = tryParse(cleaned);
  if (!parsed) {
    let repaired = cleaned
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
      const m = cleaned.match(new RegExp(`["']?${k}["']?\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([0-9]+))`, 'i'));
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

  // Strictly respect preferredLengths order (e.g. [10, 17, 13] for NID vs [17] for BRC)
  for (const len of preferredLengths) {
    const matches = active.filter((c) => c.length === len);
    if (matches.length) {
      if (len === 17 && birthYear) {
        const yrHit = matches.find((c) => c.startsWith(birthYear));
        if (yrHit) return yrHit;
      }
      return matches[0];
    }

    // Embedded substring extraction fallback ONLY when exact match wasn't found for this length
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

function isDocDigitsValidForType(docType, parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  const birthYear = getDobYear(parsed.dob || '');
  const excludeSet = new Set([extractDigitCandidate(parsed.father_nid), extractDigitCandidate(parsed.mother_nid)].filter(Boolean));
  if (docType === 'birth_certificate') {
    return pickBestDocDigits([parsed.birth_reg_no, parsed.doc_number, parsed.nid_number], [17], { excludeSet, birthYear }).length === 17;
  }
  const d = pickBestDocDigits([parsed.nid_number, parsed.doc_number, parsed.birth_reg_no], [10, 17, 13], { excludeSet, birthYear });
  return d.length === 10 || d.length === 13 || d.length === 17;
}

function validateAndNormalizeOcrData(data, options = {}) {
  const { docType = 'auto', maritalStatus = '', religion = '', mobileNumber = '', familyId = '' } = options;
  const warnings = [];

  for (const k of ['name_bn', 'name_en', 'father_name_bn', 'father_name_en', 'mother_name_bn', 'mother_name_en', 'spouse_name_bn', 'spouse_name_en', 'dob', 'gender', 'relation_suggestion', 'marital_status_suggestion', 'father_nid', 'mother_nid', 'registration_date', 'detected_language']) {
    if (data[k] !== undefined && data[k] !== null) {
      data[k] = cleanOcrFieldText(data[k]);
    } else {
      data[k] = '';
    }
  }

  for (const [bnKey, enKey] of [
    ['name_bn', 'name_en'],
    ['father_name_bn', 'father_name_en'],
    ['mother_name_bn', 'mother_name_en'],
    ['spouse_name_bn', 'spouse_name_en']
  ]) {
    let bnV = String(data[bnKey] || '').trim();
    let enV = String(data[enKey] || '').trim();
    if (bnV && !hasBengaliScript(bnV) && /[A-Za-z]/.test(bnV) && enV && hasBengaliScript(enV)) {
      data[bnKey] = enV;
      data[enKey] = bnV.toUpperCase();
    } else {
      if (!bnV && hasBengaliScript(enV)) {
        data[bnKey] = enV;
        data[enKey] = '';
        bnV = enV;
        enV = '';
      }
      if (bnV && !hasBengaliScript(bnV) && /[A-Za-z]/.test(bnV)) {
        if (!enV || hasBengaliScript(enV)) data[enKey] = bnV.toUpperCase();
        data[bnKey] = '';
      }
      if (enV && hasBengaliScript(enV)) {
        if (!data[bnKey]) data[bnKey] = enV;
        data[enKey] = '';
      }
    }
  }

  if (data.dob) data.dob = standardizeDate(data.dob);

  const birthYear = getDobYear(data.dob);
  const dobDigits = extractDigitCandidate(data.dob);
  const regDigits = extractDigitCandidate(data.registration_date);
  if (data.father_nid) data.father_nid = extractDigitCandidate(data.father_nid);
  if (data.mother_nid) data.mother_nid = extractDigitCandidate(data.mother_nid);
  const fatherNid = data.father_nid || '';
  const motherNid = data.mother_nid || '';
  const parentExclude = new Set([fatherNid, motherNid, dobDigits, regDigits].filter(Boolean));

  const rawAiNid = extractDigitCandidate(data.nid_number);
  const rawAiBrc = extractDigitCandidate(data.birth_reg_no);
  const cleanNidNotParent = rawAiNid && !parentExclude.has(rawAiNid) ? rawAiNid : '';
  const hasStrongBrcMetadata = Boolean(fatherNid || motherNid || data.registration_date);
  const hasBrcEvidence =
    data.doc_type === 'birth_certificate' ||
    hasStrongBrcMetadata ||
    (!cleanNidNotParent && rawAiBrc.length === 17);

  if (docType === 'birth_certificate') {
    data.doc_type = 'birth_certificate';
  } else if (docType === 'nid') {
    if (data.doc_type === 'birth_certificate' && rawAiBrc.length === 17 && (!cleanNidNotParent || hasStrongBrcMetadata)) {
      data.doc_type = 'birth_certificate';
      warnings.push('ডকুমেন্ট ধরন NID থাকলেও ছবিটি জন্ম নিবন্ধন (১৭ ডিজিট BRC) হিসেবে শনাক্ত হয়েছে।');
    } else {
      data.doc_type = 'nid';
    }
  } else {
    if (data.doc_type === 'birth_certificate' || (hasBrcEvidence && (!cleanNidNotParent || (rawAiBrc.length === 17 && hasStrongBrcMetadata)))) {
      data.doc_type = 'birth_certificate';
    } else {
      data.doc_type = data.doc_type || 'nid';
    }
  }

  if (data.gender) {
    data.gender = normalizeGenderValue(data.gender);
  }
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(data.gender || '').trim())) {
    const infG = inferBangladeshiGender(data);
    if (infG) {
      data.gender = infG;
      data.gender_inferred = true;
    }
  }
  const relMap = { 'ছেলে': 'পুত্র', 'মেয়ে': 'কন্যা', 'মেয়ে': 'কন্যা', 'বাবা': 'পিতা', 'মা': 'মাতা' };
  if (data.relation_suggestion) {
    const r = String(data.relation_suggestion).trim();
    data.relation_suggestion = relMap[r] || r;
  }

  const spouseBnNorm = stripPersonPrefixes(data.spouse_name_bn || '');
  const fatherBnNorm = stripPersonPrefixes(data.father_name_bn || '');
  const spouseEnNorm = stripPersonPrefixes(data.spouse_name_en || '');
  const fatherEnNorm = stripPersonPrefixes(data.father_name_en || '');
  if ((spouseBnNorm && fatherBnNorm && spouseBnNorm === fatherBnNorm)
      || (spouseEnNorm && fatherEnNorm && spouseEnNorm === fatherEnNorm)) {
    data.father_name_bn = '';
    data.father_name_en = '';
  }
  if (String(data.spouse_name_bn || data.spouse_name_en || '').trim() && !data.father_name_bn && !data.father_name_en) {
    warnings.push("পুরাতন NID-তে 'স্বামী' নাম পাওয়া গেছে (পিতার নাম ছাপা নেই) — প্রয়োজনে পিতার নাম যাচাই/লিখুন।");
    if (!data.relation_suggestion) data.relation_suggestion = 'স্ত্রী';
  }

  if (data.doc_type === 'birth_certificate') {
    const brcExclude = new Set([...parentExclude]);
    if (cleanNidNotParent && (cleanNidNotParent.length === 10 || cleanNidNotParent.length === 13) && !data.birth_reg_no) {
      brcExclude.add(cleanNidNotParent);
    }
    const rawDigits = pickBestDocDigits([data.birth_reg_no, data.doc_number, data.nid_number], [17], { excludeSet: brcExclude, birthYear });
    data.doc_number = rawDigits;
    data.birth_reg_no = rawDigits;
    data.nid_number = '';
    if (rawDigits.length !== 17) {
      warnings.push(`জন্ম নিবন্ধন নম্বরটি ${rawDigits.length || 0} সংখ্যার (অবশ্যই ১৭ সংখ্যার হতে হবে) — নম্বরটি যাচাই করুন।`);
    } else if (birthYear && !rawDigits.startsWith(birthYear)) {
      warnings.push(`জন্ম নিবন্ধনের প্রথম ৪ সংখ্যা জন্মসালের (${birthYear}) সাথে মিলছে না — বাবা/মায়ের নম্বর বা জন্মতারিখ যাচাই করুন।`);
    }
  } else {
    let rawDigits = pickBestDocDigits([data.nid_number, data.doc_number, data.birth_reg_no], [10, 17, 13], { excludeSet: parentExclude, birthYear });
    if (rawDigits.length === 13) {
      if (birthYear) {
        rawDigits = birthYear + rawDigits;
        data.nid_converted_to_17 = true;
      } else {
        warnings.push('১৩ সংখ্যার NID-র জন্মসাল না পাওয়ায় ১৭ সংখ্যায় রূপান্তর করা যায়নি — জন্মতারিখ যাচাই করুন।');
      }
    }
    data.doc_type = 'nid';
    data.doc_number = rawDigits;
    data.nid_number = rawDigits;
    data.birth_reg_no = '';
    if (rawDigits.length !== 10 && rawDigits.length !== 17) {
      warnings.push(`NID নম্বরটি ${rawDigits.length || 0} সংখ্যার (১০ বা ১৭ সংখ্যার হতে হবে) — নম্বরটি যাচাই করুন।`);
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
    const bnVal = String(data[bnKey] || '').trim();
    const enVal = String(data[enKey] || '').trim();
    if (bnVal && (!enVal || hasBengaliScript(enVal))) {
      const tr = transliterateBnToEn(bnVal);
      if (tr && !hasBengaliScript(tr)) {
        data[enKey] = tr;
        enAutoFilled.push(enKey);
      }
    } else if (enVal && (!bnVal || !hasBengaliScript(bnVal))) {
      const trBn = transliterateEnToBn(enVal);
      if (trBn && hasBengaliScript(trBn)) {
        data[bnKey] = trBn;
        bnAutoFilled.push(bnKey);
      }
    }
  }
  if (enAutoFilled.length > 0) {
    data.auto_transliterated_en = true;
    warnings.push('বাংলা-অনলি সনদ থেকে ইংরেজি নাম স্বয়ংক্রিয়ভাবে রূপান্তর করা হয়েছে — বানান যাচাই করুন।');
  }
  if (bnAutoFilled.length > 0) {
    data.auto_transliterated_bn = true;
    warnings.push('ইংরেজি-অনলি সনদ থেকে বাংলা নাম স্বয়ংক্রিয়ভাবে রূপান্তর করা হয়েছে — বানান যাচাই করুন।');
  }

  if (!data.marital_status_suggestion) {
    if (data.spouse_name_bn || data.spouse_name_en) {
      data.marital_status_suggestion = 'বিবাহিত';
    }
  }

  if (!String(data.name_bn || '').trim()) warnings.push('বাংলা নাম পড়া যায়নি।');
  if (!String(data.name_en || '').trim()) warnings.push('ইংরেজি নাম পড়া যায়নি।');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(data.dob || ''))) {
    warnings.push('জন্ম তারিখ (DD/MM/YYYY) স্পষ্ট নয় — হাতে মিলিয়ে নিন।');
  }
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(data.gender || '').trim())) {
    warnings.push('লিঙ্গ স্পষ্ট নয় — নির্বাচন যাচাই করুন।');
  }
  if (!String(data.mother_name_bn || '').trim() && !String(data.mother_name_en || '').trim()) {
    warnings.push('মাতার নাম পড়া যায়নি — প্রয়োজনে হাতে লিখুন।');
  }
  if (data.confidence === 'low') {
    warnings.push('ছবিটি কিছুটা ঝাপসা/অস্পষ্ট মনে হচ্ছে — সাবমিটের আগে সব তথ্য মিলিয়ে নিন।');
  }

  for (const [bnKey, enKey] of [
    ['name_bn', 'name_en'],
    ['father_name_bn', 'father_name_en'],
    ['mother_name_bn', 'mother_name_en'],
    ['spouse_name_bn', 'spouse_name_en']
  ]) {
    if (data[enKey]) {
      data[enKey] = normalizeEnglishHonorificPrefix(data[enKey], data[bnKey]);
    }
  }

  const missingFields = [];
  if (!String(data.name_bn || '').trim() || !hasBengaliScript(data.name_bn)) missingFields.push('name_bn');
  if (!String(data.name_en || '').trim() || hasBengaliScript(data.name_en)) missingFields.push('name_en');
  const validDoc = data.doc_type === 'birth_certificate'
    ? String(data.birth_reg_no || '').length === 17
    : [10, 17].includes(String(data.nid_number || '').length);
  if (!validDoc) missingFields.push('doc_number');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(data.dob || ''))) missingFields.push('dob');
  if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(data.gender || '').trim())) missingFields.push('gender');
  if (!String(data.mother_name_bn || '').trim() && !String(data.mother_name_en || '').trim()) missingFields.push('mother_name');
  if (!String(data.father_name_bn || '').trim() && !String(data.father_name_en || '').trim() && !String(data.spouse_name_bn || '').trim() && !String(data.spouse_name_en || '').trim()) {
    missingFields.push('father_or_spouse');
  }
  const totalCore = 7;
  const filledCore = Math.max(0, totalCore - missingFields.length);
  data.ocr_completeness = {
    valid: missingFields.length === 0,
    scorePct: Math.round((filledCore / totalCore) * 100),
    filledCore,
    totalCore,
    missingFields,
    repaired: Boolean(data.auto_transliterated_en || data.auto_transliterated_bn || data.deepseek_en_completed || data.gemini_bilingual_completed || data._json_repaired || data.gender_inferred)
  };

  const normMob = mobileNumber ? normalizeDigits(mobileNumber).replace(/[^0-9]/g, '').trim() : '';
  if (normMob && !/^01[3-9]\d{8}$/.test(normMob)) {
    warnings.push('মোবাইল নম্বরটি সঠিক ১১ সংখ্যার (01XXXXXXXXX) নয়।');
  }

  data.marital_status = maritalStatus || data.marital_status_suggestion || '';
  data.religion = religion || '';
  data.mobile_number = normMob;
  data.family_id = normalizeDigits(familyId || data.family_id || '');
  data.ocr_warnings = warnings;
  return data;
}

// Direct Firebase Firestore sync (rajbari-city-app-16601)
async function syncToFirestore(data) {
  try {
    const rawId = normalizeDigits(data.family_id || data.nid_number || data.birth_reg_no || data.doc_number || '').replace(/[^0-9A-Za-z_-]/g, '');
    if (!rawId || (!data.name_bn && !data.name_en)) {
      console.warn('[Firestore] Skipped sync: no valid document ID or extracted name');
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
      spouse_name_bn: { stringValue: data.spouse_name_bn || '' },
      spouse_name_en: { stringValue: data.spouse_name_en || '' },
      marital_status: { stringValue: data.marital_status || '' },
      religion: { stringValue: data.religion || '' },
      mobile_number: { stringValue: data.mobile_number || '' },
      doc_type: { stringValue: data.doc_type || 'nid' },
      ocr_model_used: { stringValue: data.ocr_model_used || '' },
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

function applyBilingualCompletionResult(partialData, completed, addCost = null, completionTag = '') {
  const out = { ...partialData };
  // Strictly transliterate ONLY when the opposite-language source field already exists from Vision OCR
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
  if (completionTag === 'gemini') out.gemini_bilingual_completed = true;
  else if (completionTag) out.deepseek_en_completed = completionTag;
  return out;
}

function buildBilingualCompletionPrompt(partialData) {
  const sourceOnly = {};
  const missingTargets = [];
  for (const [bnK, enK] of [
    ['name_bn', 'name_en'],
    ['father_name_bn', 'father_name_en'],
    ['mother_name_bn', 'mother_name_en'],
    ['spouse_name_bn', 'spouse_name_en']
  ]) {
    const bn = cleanOcrFieldText(partialData[bnK] || '');
    const en = cleanOcrFieldText(partialData[enK] || '');
    const hasValidBn = Boolean(bn && hasBengaliScript(bn));
    const hasValidEn = Boolean(en && !hasBengaliScript(en));
    if (hasValidBn && hasValidEn) continue; // Already bilingual: never send or alter!
    if (hasValidBn && !hasValidEn) {
      sourceOnly[bnK] = bn;
      missingTargets.push(enK);
    } else if (hasValidEn && !hasValidBn) {
      sourceOnly[enK] = en;
      missingTargets.push(bnK);
    }
  }
  if (!missingTargets.length) return '';
  return `You are a high-precision bilingual (Bangla and English) phonetic transliteration assistant for Bangladeshi identity documents.
STRICT RULES:
1. GENERATE ONLY THE MISSING TARGET KEYS: ${missingTargets.join(', ')}. Already-complete bilingual fields are intentionally excluded — never invent or return unrequested keys.
2. BANGLA -> ENGLISH (*_bn to *_en): Keep source Bangla untouched and output ONLY standard ALL-CAPS Bangladeshi phonetic English transliteration ("মোছাঃ" -> "MST.", "মোঃ" -> "MD.", "মোসাঃ" -> "MOSA."). NEVER do literal meaning translation (e.g. "আকাশ" -> "AKASH", not "SKY"; "মুক্তা" -> "MUKTA", not "PEARL").
3. ENGLISH -> BANGLA (*_en to *_bn): Keep source English untouched and output ONLY accurate Bangladeshi Bengali Unicode phonetic transliteration preserving proper vowels (স্বরবর্ণ), consonants (ব্যঞ্জনবর্ণ, ড়, ঢ়, য়), diacritics (কার/ফলা/রেফ), digits (০–৯), and conjuncts (যুক্তবর্ণ: ক্ষ, ক্ষ্ম, জ্ঞ, ঞ্জ, ঞ্চ, হ্ম, ত্ত, ত্র, দ্দ, দ্ধ, ব্দ, শ্র, স্ত্র, ন্দ্র, ষ্ণ, ষ্ট, ষ্ঠ, ণ্ড, ন্ড, ন্ত, ন্দ, ম্প, ম্ব, স্ত, স্ব, ল্ল).
4. Return strictly ONE valid JSON object containing ONLY these keys: ${missingTargets.join(', ')}.
Source fields (READ-ONLY):
${JSON.stringify(sourceOnly)}`;
}

async function completeBanglaOnlyOcrWithDeepSeek(deepseekKey, partialData, preferredModel = 'deepseek-chat') {
  if (!deepseekKey || !partialData || partialData._dsCompletionDone || !needsIntelligentCompletion(partialData)) return partialData;
  Object.defineProperty(partialData, '_dsCompletionDone', { value: true, enumerable: false, configurable: true });
  const extractDsMsg = (resObj) => {
    const msg = resObj?.choices?.[0]?.message || {};
    let c = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.map(p => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('\n') : '');
    c = String(c || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (c) return c;
    const r = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : (typeof msg.reasoning === 'string' ? msg.reasoning : '');
    if (r) {
      const endIdx = r.lastIndexOf('}');
      for (let sFrom = endIdx, d = 0; endIdx !== -1 && d < 12 && sFrom >= 0; d++) {
        const st = r.lastIndexOf('{', sFrom);
        if (st === -1) break;
        try {
          const cand = JSON.parse(r.slice(st, endIdx + 1));
          if (cand && typeof cand === 'object' && !Array.isArray(cand) && (cand.name_en || cand.name_bn || cand.father_name_en || cand.mother_name_en || cand.doc_type)) return JSON.stringify(cand);
        } catch (_) {}
        sFrom = st - 1;
      }
    }
    return '';
  };
  const models = preferredModel === 'deepseek-flash'
    ? ['deepseek-flash', 'deepseek-chat']
    : ['deepseek-chat', 'deepseek-flash'];
  const compPrompt = buildBilingualCompletionPrompt(partialData);
  if (!compPrompt) return partialData;
  const dsBase = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
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
          messages: [
            { role: 'system', content: 'You are a high-precision bilingual (Bangla & English) phonetic transliteration assistant for Bangladeshi identity documents. Fill ONLY the requested missing target-language keys using accurate Bangla letters, digits, and juktoborno (যুক্তবর্ণ) phonetic transliteration (never literal meaning translation). Never alter existing values or invent empty pairs. Output strictly one valid JSON object.' },
            { role: 'user', content: compPrompt }
          ],
          temperature: 0,
          max_tokens: cfg.maxTokens
        };
        if (cfg.disableThinking) payload.thinking = { type: 'disabled' };
        if (cfg.useJsonMode) payload.response_format = { type: 'json_object' };
        const response = await fetch(`${dsBase}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${deepseekKey}`
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!response.ok) continue;
        const resData = await response.json().catch(() => ({}));
        const content = extractDsMsg(resData);
        if (!content) continue;
        const completed = parseOcrJsonText(content);
        const addCost = resData?.usage ? computeScanUsageAndCost(model, resData) : null;
        const out = applyBilingualCompletionResult(partialData, completed, addCost, model);
        Object.defineProperty(out, '_dsCompletionDone', { value: true, enumerable: false, configurable: true });
        return out;
      } catch (_) {
        clearTimeout(timer);
      }
    }
  }
  return partialData;
}

async function completeBilingualWithGemini(geminiKey, partialData, preferredModel = DEFAULT_GEMINI_MODEL) {
  if (!geminiKey || !partialData || !needsIntelligentCompletion(partialData)) return partialData;
  const models = [normalizeModelId(preferredModel || DEFAULT_GEMINI_MODEL), 'gemini-3.5-flash-lite', 'gemini-3.8-flash'].filter((v, i, a) => v && v.startsWith('gemini-') && a.indexOf(v) === i);
  const compPrompt = buildBilingualCompletionPrompt(partialData);
  if (!compPrompt) return partialData;

  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 16000);
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: compPrompt }] }],
          generationConfig: {
            response_mime_type: 'application/json'
          }
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) continue;
      const resData = await response.json().catch(() => ({}));
      const txt = extractTextFromGeminiResponse(resData);
      if (!txt) continue;
      const completed = parseOcrJsonText(txt);
      const addCost = resData?.usageMetadata ? computeScanUsageAndCost(model, resData) : null;
      return applyBilingualCompletionResult(partialData, completed, addCost, 'gemini');
    } catch (_) {
      clearTimeout(timer);
    }
  }
  return partialData;
}

async function callDeepSeekVisionOCR(deepseekKey, cleanBase64, mimeType, promptText, deepseekModel = 'deepseek-flash') {
  if (/pdf/i.test(String(mimeType || ''))) {
    const err = new Error('DeepSeek Vision সরাসরি PDF ফাইল সাপোর্ট করে না (JPEG/PNG প্রয়োজন)।');
    err.isVisionUnsupported = true;
    throw err;
  }
  const normalizedPref = normalizeModelId(deepseekModel);
  const rawReq = String(deepseekModel || '').trim();
  const modelCandidates = ['deepseek-flash'];
  if (rawReq && normalizedPref !== 'deepseek-flash' && !/^deepseek-chat$/i.test(rawReq) && !modelCandidates.includes(rawReq)) {
    modelCandidates.push(rawReq);
  }
  let lastError = 'Empty response from DeepSeek OCR.';
  const dsBase = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');

  const attemptConfigs = [
    { disableThinking: true, useJsonMode: true, maxTokens: 4096, timeoutMs: 35000 },
    { disableThinking: true, useJsonMode: false, maxTokens: 4096, timeoutMs: 35000 },
    { disableThinking: false, useJsonMode: false, maxTokens: 8192, timeoutMs: 45000 }
  ];

  for (const targetModel of modelCandidates) {
    for (const cfg of attemptConfigs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const payload = {
          model: targetModel,
          messages: [
            {
              role: 'system',
              content: 'You are an ultra-precise OCR engine for Bangladeshi identity documents (NID and Birth Certificates). Extract text EXACTLY as printed on the document without modifying, rewriting, or correcting spellings. If a Bengali name begins with "মোছাঃ" (or "মোছা:"), its English prefix is "MST.". If it begins with "মোঃ", its English prefix is "MD.". NEVER invent, guess, or synthesize digits or fields. Output strictly one valid JSON object.'
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: promptText },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${cleanBase64}` } }
              ]
            }
          ],
          temperature: 0,
          max_tokens: cfg.maxTokens
        };
        if (cfg.disableThinking) payload.thinking = { type: 'disabled' };
        if (cfg.useJsonMode) payload.response_format = { type: 'json_object' };

        const response = await fetch(`${dsBase}/chat/completions`, {
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
            const err = new Error('Invalid DeepSeek API Key.');
            err.statusCode = 400;
            throw err;
          }
          if (response.status === 402) throw new Error('DeepSeek insufficient balance.');
          lastError = `${targetModel}: DeepSeek API Error (${response.status}): ${msg}`;
          if (/image_url|multimodal|vision|deserialize|unknown variant|model\s*(?:does\s*)?not\s*exist|unsupported\s*model/i.test(msg) && !/thinking|reasoning|response_format/i.test(msg)) {
            break;
          }
          continue;
        }

        const extractDsVisionText = (resObj) => {
          const msg = resObj?.choices?.[0]?.message || {};
          let c = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.map(p => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('\n') : '');
          c = String(c || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
          if (c) return c;
          const r = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : (typeof msg.reasoning === 'string' ? msg.reasoning : '');
          if (r) {
            const hasKey = (o) => o && typeof o === 'object' && !Array.isArray(o) && ['doc_type', 'doc_number', 'nid_number', 'birth_reg_no', 'name_bn', 'name_en', 'dob', 'father_name_bn', 'mother_name_bn'].some(k => String(o[k] || '').trim() !== '');
            const fences = [...r.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
            for (let i = fences.length - 1; i >= 0; i--) {
              try { const cand = JSON.parse(fences[i][1].trim()); if (hasKey(cand)) return JSON.stringify(cand); } catch (_) {}
            }
            const endIdx = r.lastIndexOf('}');
            for (let sFrom = endIdx, d = 0; endIdx !== -1 && d < 12 && sFrom >= 0; d++) {
              const st = r.lastIndexOf('{', sFrom);
              if (st === -1) break;
              try { const cand = JSON.parse(r.slice(st, endIdx + 1)); if (hasKey(cand)) return JSON.stringify(cand); } catch (_) {}
              sFrom = st - 1;
            }
          }
          return '';
        };
        const content = extractDsVisionText(resData);
        if (!content) {
          lastError = `${targetModel}: Empty response from DeepSeek OCR.`;
          continue;
        }

        let parsed = parseOcrJsonText(content);
        const hasAnyField = parsed && [
          'name_bn', 'name_en', 'doc_number', 'nid_number', 'birth_reg_no', 'dob', 'father_name_bn', 'mother_name_bn'
        ].some(k => String(parsed[k] || '').trim() !== '');
        if (!parsed || (!hasAnyField && !/\{[\s\S]*\}/.test(content))) {
          lastError = `${targetModel}: DeepSeek returned no valid document fields.`;
          continue;
        }
        parsed.ocr_model_used = `${targetModel} (api.deepseek.com)`;
        parsed.ocr_usage = computeScanUsageAndCost(targetModel, resData);
        if (needsEnglishCompletion(parsed)) {
          parsed = await completeBanglaOnlyOcrWithDeepSeek(deepseekKey, parsed, targetModel);
        }
        return parsed;
      } catch (err) {
        clearTimeout(timer);
        if (/Invalid DeepSeek API Key|insufficient balance/.test(err.message || '')) throw err;
        lastError = err.name === 'AbortError' ? `${targetModel}: DeepSeek OCR timed out.` : `${targetModel}: ${err.message}`;
        continue;
      }
    }
  }

  const finalErr = new Error(lastError);
  if (/image_url|multimodal|vision|deserialize|unknown variant|model\s*(?:does\s*)?not\s*exist|invalid_request_error|unsupported\s*model/i.test(lastError)) {
    finalErr.isVisionUnsupported = true;
  }
  throw finalErr;
}

function needsAccurateEscalation(parsed, docTypeHint = 'auto') {
  if (!parsed || typeof parsed !== 'object') return true;
  if (parsed.confidence === 'low') return true;
  const nb = String(parsed.name_bn || '').trim();
  const ne = String(parsed.name_en || '').trim();
  const lang = String(parsed.detected_language || '').toLowerCase();
  if (!nb && !ne) return true;
  if (lang !== 'en_only' && (!nb || !hasBengaliScript(nb))) return true;
  if (lang !== 'bn_only' && (!ne || hasBengaliScript(ne))) return true;
  const stdDob = standardizeDate(parsed.dob || '');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(stdDob)) return true;
  const effectiveType = (docTypeHint && docTypeHint !== 'auto' && !(docTypeHint === 'nid' && parsed.doc_type === 'birth_certificate' && extractDigitCandidate(parsed.birth_reg_no).length === 17 && !extractDigitCandidate(parsed.nid_number)))
    ? docTypeHint
    : (parsed.doc_type || 'nid');
  if (!isDocDigitsValidForType(effectiveType, parsed)) return true;
  if (effectiveType === 'birth_certificate') {
    const brcDigits = extractDigitCandidate(parsed.birth_reg_no || parsed.doc_number);
    const dobYr = getDobYear(stdDob);
    if (brcDigits.length === 17 && dobYr && !brcDigits.startsWith(dobYr)) return true;
  }
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

  const escType = escalated.doc_type && escalated.doc_type !== 'auto' ? escalated.doc_type : (primary.doc_type || 'nid');
  const effectiveType = (docTypeHint && docTypeHint !== 'auto' && !(docTypeHint === 'nid' && escType === 'birth_certificate' && extractDigitCandidate(escalated.birth_reg_no).length === 17 && !extractDigitCandidate(escalated.nid_number)))
    ? docTypeHint
    : escType;

  const merged = { ...primary, ...escalated };
  merged.doc_type = effectiveType;

  const pickBn = (escV, priV) => {
    const e = cleanOcrFieldText(escV || '');
    const p = cleanOcrFieldText(priV || '');
    if (e && hasBengaliScript(e)) return e;
    if (p && hasBengaliScript(p)) return p;
    return e || p;
  };
  const pickEn = (escV, priV) => {
    const e = cleanOcrFieldText(escV || '');
    const p = cleanOcrFieldText(priV || '');
    if (e && !hasBengaliScript(e)) return e;
    if (p && !hasBengaliScript(p)) return p;
    return e || p;
  };
  for (const field of ['name_bn', 'father_name_bn', 'mother_name_bn', 'spouse_name_bn']) {
    merged[field] = pickBn(escalated[field], primary[field]);
  }
  for (const field of ['name_en', 'father_name_en', 'mother_name_en', 'spouse_name_en']) {
    merged[field] = pickEn(escalated[field], primary[field]);
  }
  for (const field of ['relation_suggestion', 'marital_status_suggestion', 'father_nid', 'mother_nid', 'registration_date']) {
    merged[field] = cleanOcrFieldText(escalated[field] || '') || cleanOcrFieldText(primary[field] || '');
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

function buildGeminiAttemptsForModels(models, apiKey, cleanBase64, mimeType, promptText, opts = {}) {
  const { docType = 'auto', isEscalation = false } = opts;
  const isPdf = /pdf/i.test(String(mimeType || ''));
  const attempts = [];
  for (const model of models) {
    if (INTERACTIONS_API_MODELS.has(model) && !isPdf) {
      const useUltraHigh = (model === 'gemini-3.8-flash' || model === 'gemini-4-argon') && (docType === 'birth_certificate' || docType === 'auto' || isEscalation);
      const imageResolution = useUltraHigh ? 'ultra_high' : 'high';
      const body = {
        model,
        input: [
          { type: 'text', text: promptText },
          { type: 'image', data: cleanBase64, mime_type: mimeType, resolution: imageResolution }
        ],
        response_format: { type: 'text', mime_type: 'application/json', schema: OCR_RESPONSE_SCHEMA },
        generation_config: { thinking_level: (isEscalation || docType === 'birth_certificate') ? 'medium' : 'low' },
        store: false
      };
      attempts.push({
        model,
        timeoutMs: useUltraHigh || isEscalation ? 35000 : 28000,
        label: `${model} (interactions/${imageResolution})`,
        url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'Api-Revision': '2026-05-20' },
        body
      });
    }
    attempts.push({
      model,
      timeoutMs: isEscalation ? 35000 : 28000,
      label: `${model} (generateContent)`,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: {
        contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mimeType, data: cleanBase64 } }] }],
        generationConfig: { response_mime_type: 'application/json', responseSchema: OCR_RESPONSE_SCHEMA }
      }
    });
  }
  return attempts;
}

async function runGeminiCascade(apiKey, cleanBase64, mimeType, promptText, profile = 'accurate', preferredGeminiModel = DEFAULT_GEMINI_MODEL, attemptOpts = {}) {
  const modelsOrder = getOrderedGeminiModels(profile, preferredGeminiModel);
  const attempts = buildGeminiAttemptsForModels(modelsOrder, apiKey, cleanBase64, mimeType, promptText, attemptOpts);

  let lastError = 'No text generated by Gemini OCR.';
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
          const err = new Error('Invalid Gemini API Key.');
          err.statusCode = 400;
          throw err;
        }
        lastError = `${attempt.label}: ${msg}`;
        continue;
      }

      const textOutput = extractTextFromGeminiResponse(resData);
      if (!textOutput) { lastError = `${attempt.label}: Empty model response`; continue; }

      const data = parseOcrJsonText(textOutput);
      data.ocr_model_used = attempt.label;
      data.ocr_usage = computeScanUsageAndCost(attempt.model, resData);
      return data;
    } catch (err) {
      clearTimeout(timer);
      if (/Invalid Gemini API Key/.test(err.message || '')) throw err;
      lastError = err.name === 'AbortError' ? `${attempt.label}: Request timed out` : `${attempt.label}: ${err.message}`;
    }
  }
  throw new Error(`Gemini OCR Error: ${lastError}`);
}

// Resilient Multi-Provider OCR caller: Gemini 3.5/3.1 Lite, 3.8 Flash, 4 Argon + DeepSeek Vision (deepseek-flash)
async function extractNidWithAI(base64Image, customApiKey, options = {}) {
  let gKey = String(customApiKey || process.env.GEMINI_API_KEY || '').trim();
  let dKey = String(options.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!dKey && /^sk-/i.test(gKey)) {
    dKey = gKey;
    gKey = '';
  }

  const mode = ['economy', 'auto', 'gemini', 'gemini_lite', 'deepseek'].includes(options.aiProvider) ? options.aiProvider : 'economy';
  const keySlot = ['auto', 'gemini', 'deepseek'].includes(options.defaultKeySlot) ? options.defaultKeySlot : 'auto';
  const prefGemModel = normalizeModelId(options.geminiModel || DEFAULT_GEMINI_MODEL);
  const validPrefGemModel = prefGemModel.startsWith('gemini-') ? prefGemModel : DEFAULT_GEMINI_MODEL;
  const prefDsModel = options.deepseekModel || 'deepseek-flash';
  const docType = options.docType || 'auto';

  function badReqError(msg) {
    const err = new Error(msg);
    err.statusCode = 400;
    return err;
  }

  if ((mode === 'gemini' || mode === 'gemini_lite') && !gKey) throw badReqError('No Gemini API Key provided.');
  if (mode === 'deepseek' && !dKey) throw badReqError('No DeepSeek API Key provided.');
  if (!gKey && !dKey) {
    throw badReqError('No Gemini or DeepSeek API Key provided. Configure .env or provide an API key.');
  }

  let mimeType = options.mimeType || 'image/jpeg';
  let cleanBase64 = String(base64Image || '').trim();
  const dataUriMatch = cleanBase64.match(/^data:([^;]+);base64,(.+)$/s);
  if (dataUriMatch) {
    mimeType = dataUriMatch[1] || mimeType;
    cleanBase64 = dataUriMatch[2];
  }
  cleanBase64 = cleanBase64.replace(/\s+/g, '');
  if (!cleanBase64 || cleanBase64.length < 8 || !/^[A-Za-z0-9+/=]+$/.test(cleanBase64)) {
    throw badReqError('অবৈধ বা খালি ডকুমেন্ট ইমেজ ডেটা।');
  }

  const promptText = buildGeminiPrompt(docType);
  let rawParsed = null;

  if (mode === 'deepseek') {
    try {
      rawParsed = await callDeepSeekVisionOCR(dKey, cleanBase64, mimeType, promptText, prefDsModel);
    } catch (dsErr) {
      const isAuthOrBal = /Invalid DeepSeek API Key|insufficient balance/i.test(dsErr.message || '');
      if (gKey && !isAuthOrBal) {
        const gRes = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'preferred', validPrefGemModel, { docType });
        rawParsed = await completeBanglaOnlyOcrWithDeepSeek(dKey, gRes, prefDsModel);
        rawParsed.ocr_model_used = `${gRes.ocr_model_used || 'gemini'} + DeepSeek`;
      } else if (dsErr.isVisionUnsupported) {
        const err = new Error(`DeepSeek API সরাসরি ইমেজ OCR (image_url) সাপোর্ট করে না — অনুগ্রহ করে Gemini API Key যুক্ত করুন, তাহলে Gemini ছবি পড়ে DeepSeek-এর বুদ্ধিমত্তায় সম্পূর্ণ বাংলা ও ইংরেজি JSON তৈরি করবে। (${dsErr.message})`);
        err.statusCode = 400;
        throw err;
      } else {
        throw dsErr;
      }
    }
  } else if (mode === 'gemini_lite') {
    rawParsed = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'lite_only', validPrefGemModel, { docType });
  } else if (mode === 'gemini') {
    rawParsed = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'preferred', validPrefGemModel, { docType });
  } else if (keySlot === 'deepseek' && dKey) {
    const errors = [];
    try {
      const dsRes = await callDeepSeekVisionOCR(dKey, cleanBase64, mimeType, promptText, prefDsModel);
      if (mode === 'auto' || !needsAccurateEscalation(dsRes, docType) || !gKey) {
        rawParsed = dsRes;
      } else {
        try {
          const escRes = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'preferred', validPrefGemModel, { docType, isEscalation: true });
          rawParsed = mergeOcrResults(dsRes, escRes, docType);
        } catch (_) {
          rawParsed = dsRes;
        }
      }
    } catch (err) {
      errors.push(err.message);
    }
    if (!rawParsed && gKey) {
      try {
        rawParsed = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'preferred', validPrefGemModel, { docType });
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (!rawParsed) throw new Error(errors.join(' | '));
  } else if (mode === 'economy') {
    const errors = [];
    if (gKey) {
      try {
        const isFlagship = validPrefGemModel === 'gemini-3.8-flash' || validPrefGemModel === 'gemini-4-argon';
        const firstProfile = isFlagship ? 'preferred' : 'lite_only';
        const primaryRes = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, firstProfile, validPrefGemModel, { docType });
        if (!needsAccurateEscalation(primaryRes, docType) || isFlagship) {
          rawParsed = primaryRes;
        } else {
          try {
            const escRes = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'flash38_only', validPrefGemModel, { docType, isEscalation: true });
            rawParsed = mergeOcrResults(primaryRes, escRes, docType);
          } catch (_) {
            if (dKey) {
              try {
                const dsEsc = await callDeepSeekVisionOCR(dKey, cleanBase64, mimeType, promptText, prefDsModel);
                rawParsed = mergeOcrResults(primaryRes, dsEsc, docType);
              } catch (__) {}
            }
            if (!rawParsed) rawParsed = primaryRes;
          }
        }
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (!rawParsed && dKey) {
      try {
        rawParsed = await callDeepSeekVisionOCR(dKey, cleanBase64, mimeType, promptText, prefDsModel);
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (!rawParsed) throw new Error(errors.join(' | '));
  } else {
    const errors = [];
    if (gKey) {
      try {
        rawParsed = await runGeminiCascade(gKey, cleanBase64, mimeType, promptText, 'accurate', validPrefGemModel, { docType, isEscalation: docType === 'birth_certificate' });
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (!rawParsed && dKey) {
      try {
        rawParsed = await callDeepSeekVisionOCR(dKey, cleanBase64, mimeType, promptText, prefDsModel);
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (!rawParsed) throw new Error(errors.join(' | '));
  }

  if (dKey && needsIntelligentCompletion(rawParsed)) {
    rawParsed = await completeBanglaOnlyOcrWithDeepSeek(dKey, rawParsed, prefDsModel);
  }
  if (gKey && needsIntelligentCompletion(rawParsed)) {
    rawParsed = await completeBilingualWithGemini(gKey, rawParsed, validPrefGemModel);
  }
  return validateAndNormalizeOcrData(rawParsed, options);
}

// REST API for direct OCR (supports both /api/ocr-nid and /api/extract-nid)
async function handleExtractNidRoute(req, res) {
  try {
    const image = req.body.image || req.body.imageBase64;
    const { apiKey, deepseekApiKey, aiProvider, defaultKeySlot, geminiModel, deepseekModel, room, mimeType, docType } = req.body;
    if (!image) {
      return res.status(400).json({ success: false, error: 'No image provided.' });
    }

    const extracted = await extractNidWithAI(image, apiKey, {
      mimeType,
      docType,
      aiProvider,
      defaultKeySlot,
      geminiModel,
      deepseekModel,
      deepseekApiKey,
      maritalStatus: req.body.maritalStatus,
      religion: req.body.religion,
      mobileNumber: req.body.mobileNumber,
      familyId: req.body.familyId
    });

    // Async sync to Firestore
    syncToFirestore(extracted);

    // If a room is specified, broadcast to that room
    if (room) {
      const cleanBroadcastRoom = normalizeRoomCode(room);
      io.to(cleanBroadcastRoom).emit('nid-data-extracted', {
        success: true,
        data: extracted,
        timestamp: new Date().toISOString()
      });
    }

    res.json({ success: true, data: extracted });
  } catch (error) {
    console.error('OCR Error:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
}

app.post('/api/ocr-nid', handleExtractNidRoute);
app.post('/api/extract-nid', handleExtractNidRoute);

const SERVER_ERROR_LOGS = [];
app.post('/api/error-logs', async (req, res) => {
  try {
    const entry = {
      id: `srv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      source: String(req.body?.source || 'client').slice(0, 60),
      level: String(req.body?.level || 'error').slice(0, 20),
      stage: String(req.body?.stage || 'general').slice(0, 60),
      message: String(req.body?.message || '').slice(0, 800),
      detail: String(req.body?.detail || '').slice(0, 1500),
      model: String(req.body?.model || '').slice(0, 80),
      ts: Date.now(),
      createdAt: new Date().toISOString()
    };
    SERVER_ERROR_LOGS.unshift(entry);
    if (SERVER_ERROR_LOGS.length > 60) SERVER_ERROR_LOGS.length = 60;
    try {
      const fields = {
        id: { stringValue: entry.id },
        source: { stringValue: entry.source },
        level: { stringValue: entry.level },
        stage: { stringValue: entry.stage },
        message: { stringValue: entry.message },
        detail: { stringValue: entry.detail },
        model: { stringValue: entry.model },
        ts: { integerValue: String(entry.ts) },
        createdAt: { stringValue: entry.createdAt }
      };
      const fbRes = await fetch(`https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/fc_error_logs/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      }).catch(() => null);
      if (!fbRes || fbRes.status === 403 || !fbRes.ok) {
        await fetch(`https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/room_channels/FC_SYSTEM_LOGS/messages/${encodeURIComponent(entry.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              id: { stringValue: entry.id },
              room: { stringValue: 'FC_SYSTEM_LOGS' },
              type: { stringValue: 'system' },
              text: { stringValue: `[${entry.level}][${entry.source}] ${entry.message}`.slice(0, 800) },
              payloadJson: { stringValue: JSON.stringify(entry) },
              senderName: { stringValue: entry.source },
              senderClient: { stringValue: 'server' },
              senderId: { stringValue: 'server' },
              replyToJson: { stringValue: '' },
              ts: { integerValue: String(entry.ts) },
              createdAt: { stringValue: entry.createdAt }
            }
          })
        }).catch(() => {});
      }
    } catch (_) {}
    res.json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/error-logs', (req, res) => {
  res.json({ success: true, logs: SERVER_ERROR_LOGS });
});

// --- Cross-Device Room Messaging & Data Sharing Store ---
const FIRESTORE_ROOMS_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/room_channels';
const roomMessagesStore = new Map();
const MAX_ROOM_MESSAGES = 100;

function normalizeRoomCode(room) {
  const clean = String(room || 'FC-101').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
  return clean || 'FC-101';
}

function makeRoomMsgId(ts = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 7);
  return `m_${String(ts).padStart(14, '0')}_${rand}`;
}

function normalizeRoomMessage(raw = {}, fallbackRoom = 'FC-101') {
  const ts = Number(raw.ts) > 0 ? Number(raw.ts) : Date.now();
  const room = normalizeRoomCode(raw.room || fallbackRoom);
  const type = ['text', 'nid_data', 'summary', 'system', 'survey_house_saved', 'survey_timer_ended'].includes(raw.type) ? raw.type : 'text';
  const id = String(raw.id || makeRoomMsgId(ts)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || makeRoomMsgId(ts);
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

function appendRoomMessageInMemory(rawMsg, fallbackRoom = 'FC-101') {
  const msg = normalizeRoomMessage(rawMsg, fallbackRoom);
  // Cap active rooms in memory to 200 (evict oldest room) to prevent unconstrained RAM exhaustion
  if (!roomMessagesStore.has(msg.room) && roomMessagesStore.size >= 200) {
    const oldestRoom = roomMessagesStore.keys().next().value;
    if (oldestRoom) roomMessagesStore.delete(oldestRoom);
  }
  const list = roomMessagesStore.get(msg.room) || [];
  if (!list.some((m) => m.id === msg.id)) {
    list.push(msg);
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > MAX_ROOM_MESSAGES) list.splice(0, list.length - MAX_ROOM_MESSAGES);
    roomMessagesStore.set(msg.room, list);
  }
  return msg;
}

async function syncRoomMessageToFirestore(msg) {
  try {
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
    const preview = (msg.text || (msg.type === 'nid_data' ? (msg.payload?.name_bn || msg.payload?.doc_number || 'NID ডেটা') : 'বার্তা')).slice(0, 120);
    await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(msg.room)}/messages/${encodeURIComponent(msg.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    const metaFields = {
      room: { stringValue: msg.room },
      last_msg_id: { stringValue: msg.id },
      last_sender: { stringValue: msg.senderName || '' },
      last_preview: { stringValue: preview },
      updated_at: { timestampValue: new Date().toISOString() }
    };
    const metaMask = Object.keys(metaFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(msg.room)}?${metaMask}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: metaFields })
    });
  } catch (e) {
    console.warn('[Firestore Room Sync notice]:', e.message);
  }
}

async function syncRoomClearedAtToFirestore(room, clearedAt = Date.now()) {
  const metaFields = {
    room: { stringValue: room },
    last_msg_id: { stringValue: '' },
    cleared_at_ms: { integerValue: String(clearedAt) },
    updated_at: { timestampValue: new Date(clearedAt).toISOString() }
  };
  const metaMask = Object.keys(metaFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  return fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}?${metaMask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: metaFields })
  }).catch(() => {});
}

async function loadCloudRoomMessages(room) {
  const [metaRes, listRes] = await Promise.all([
    fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}`).catch(() => null),
    fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}/messages?pageSize=200`).catch(() => null)
  ]);
  let clearedAtMs = 0;
  if (metaRes && metaRes.ok) {
    const metaJson = await metaRes.json().catch(() => ({}));
    clearedAtMs = Number(metaJson?.fields?.cleared_at_ms?.integerValue || metaJson?.fields?.cleared_at_ms?.doubleValue || 0);
  }
  if (!listRes || !listRes.ok) return [];
  const data = await listRes.json().catch(() => ({}));
  const docs = Array.isArray(data.documents) ? data.documents : [];
  return docs.map((d) => {
    const f = d.fields || {};
    return normalizeRoomMessage({
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
  }).filter((m) => !(clearedAtMs > 0 && m.ts <= clearedAtMs))
    .sort((a, b) => a.ts - b.ts);
}

app.get(['/api/room-messages', '/api/rooms/:room/messages'], async (req, res) => {
  try {
    const room = normalizeRoomCode(req.params.room || req.query.room);
    const since = Number(req.query.since || 0);
    let memList = roomMessagesStore.get(room) || [];
    if (memList.length === 0) {
      const cloudList = await loadCloudRoomMessages(room).catch(() => []);
      cloudList.forEach((m) => appendRoomMessageInMemory(m, room));
      memList = roomMessagesStore.get(room) || [];
    }
    const filtered = since > 0 ? memList.filter((m) => m.ts > since) : memList;
    res.json({ success: true, room, messages: filtered, serverTime: Date.now() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post(['/api/room-messages', '/api/rooms/:room/messages'], async (req, res) => {
  try {
    const room = normalizeRoomCode(req.params.room || req.body?.room);
    const msg = appendRoomMessageInMemory(req.body || {}, room);
    io.to(room).emit('room-message', msg);
    syncRoomMessageToFirestore(msg);
    res.json({ success: true, room, message: msg });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete(['/api/room-messages', '/api/rooms/:room/messages'], async (req, res) => {
  try {
    const room = normalizeRoomCode(req.params.room || req.query.room || req.body?.room);
    const clearedAt = Date.now();
    roomMessagesStore.set(room, []);
    io.to(room).emit('room-cleared', { room, ts: clearedAt });
    syncRoomClearedAtToFirestore(room, clearedAt);
    res.json({ success: true, room, clearedAt });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Survey Duration Timer Persistence (Firestore + In-Memory Cache)
const FIRESTORE_CARDS_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards';
const FIRESTORE_SURVEY_TIMERS_LOG_BASE = `${FIRESTORE_CARDS_BASE}/SURVEY_TIMERS/logs`;
const FIRESTORE_SURVEY_TIMERS_COLLECTION_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/survey_timers';
const FIRESTORE_HOUSES_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/surveyed_houses';
const surveyTimerStore = [];

function formatSurveyDurationShort(totalSec = 0) {
  const sec = Math.max(0, Math.round(Number(totalSec) || 0));
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const rem = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (hrs > 0) return `${pad(hrs)}:${pad(mins)}:${pad(rem)}`;
  return `${pad(mins)}:${pad(rem)}`;
}

function normalizeSurveyTimerPayload(raw = {}) {
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

  const cleanId = (val, maxLen = 100) => String(val || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, maxLen);
  const sessionId = cleanId(raw.sessionId || raw.session_id || `srv_${startedAtMs}_${Math.random().toString(36).slice(2, 7)}`, 96);
  const familyId = cleanId(normalizeDigits(raw.familyId || raw.family_id || ''), 64);
  const docId = cleanId(normalizeDigits(raw.docId || raw.doc_id || familyId || ''), 96);
  const statusRaw = String(raw.status || raw.timerStatus || raw.survey_timer_status || 'ended').toLowerCase();
  const status = ['running', 'ended', 'completed'].includes(statusRaw) ? statusRaw : 'ended';

  return {
    sessionId,
    familyId,
    docId,
    applicantName: String(raw.applicantName || raw.applicant_name || '').trim().slice(0, 120),
    docType: String(raw.docType || raw.doc_type || '').trim().slice(0, 40),
    source: String(raw.source || 'web').trim().slice(0, 40),
    roomCode: raw.roomCode || raw.room_code ? normalizeRoomCode(raw.roomCode || raw.room_code) : '',
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
    durationLabel: String(raw.durationLabel || raw.duration_label || formatSurveyDurationShort(durationSec)).trim().slice(0, 40)
  };
}

function buildSurveyTimerFirestoreFields(entry) {
  return {
    session_id: { stringValue: entry.sessionId },
    family_id: { stringValue: entry.familyId || '' },
    doc_id: { stringValue: entry.docId || '' },
    applicant_name: { stringValue: entry.applicantName || '' },
    doc_type: { stringValue: entry.docType || '' },
    source: { stringValue: entry.source || '' },
    room_code: { stringValue: entry.roomCode || '' },
    device_name: { stringValue: entry.deviceName || '' },
    survey_status: { stringValue: entry.surveyStatus || '' },
    timer_status: { stringValue: entry.status || 'ended' },
    readiness_pct: { integerValue: String(entry.readinessPct || 0) },
    start_reason: { stringValue: entry.startReason || '' },
    end_reason: { stringValue: entry.endReason || '' },
    started_at_ms: { integerValue: String(entry.startedAtMs) },
    ended_at_ms: { integerValue: String(entry.endedAtMs) },
    started_at: { timestampValue: entry.startedAt },
    ended_at: { timestampValue: entry.endedAt },
    duration_ms: { integerValue: String(entry.durationMs) },
    duration_sec: { integerValue: String(entry.durationSec) },
    duration_label: { stringValue: entry.durationLabel || formatSurveyDurationShort(entry.durationSec) }
  };
}

async function syncSurveyTimerToFirestore(entry) {
  try {
    const fields = buildSurveyTimerFirestoreFields(entry);
    const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const ops = [
      fetch(`${FIRESTORE_SURVEY_TIMERS_LOG_BASE}/${encodeURIComponent(entry.sessionId)}?${mask}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      }).catch(() => null),
      fetch(`${FIRESTORE_SURVEY_TIMERS_COLLECTION_BASE}/${encodeURIComponent(entry.sessionId)}?${mask}`, {
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
          fetch(`${FIRESTORE_HOUSES_BASE}/${encodeURIComponent(targetId)}?${docMask}&currentDocument.exists=true`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: docFields })
          }).catch(() => null)
        );
      }
    }

    await Promise.all(ops);
  } catch (e) {
    console.warn('[Firestore Survey Timer Sync notice]:', e.message);
  }
}

async function fetchSurveyTimersFromFirestore(limit = 50) {
  try {
    const allTimers = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const url = `${FIRESTORE_SURVEY_TIMERS_LOG_BASE}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await fetch(url);
      if (!res || !res.ok) break;
      const data = await res.json().catch(() => ({}));
      const docs = Array.isArray(data.documents) ? data.documents : [];
      for (const d of docs) {
        const f = d.fields || {};
        allTimers.push({
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
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return allTimers
      .sort((a, b) => (b.endedAtMs || 0) - (a.endedAtMs || 0))
      .slice(0, Math.min(200, Math.max(1, limit)));
  } catch (_) {
    return [];
  }
}

app.get('/api/survey-timer', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
    const roomFilter = req.query.room ? normalizeRoomCode(req.query.room) : '';
    const remote = await fetchSurveyTimersFromFirestore(limit);
    const mergedMap = new Map();
    for (const item of [...remote, ...surveyTimerStore]) {
      if (!item || !item.sessionId) continue;
      if (roomFilter && item.roomCode && item.roomCode !== roomFilter) continue;
      mergedMap.set(item.sessionId, item);
    }
    const timers = Array.from(mergedMap.values())
      .sort((a, b) => (b.endedAtMs || 0) - (a.endedAtMs || 0))
      .slice(0, limit);
    const completed = timers.filter((t) => t.status === 'ended' || t.status === 'completed');
    const totalSec = completed.reduce((acc, t) => acc + (Number(t.durationSec) || 0), 0);
    const stats = {
      count: completed.length,
      avgDurationSec: completed.length ? Math.round(totalSec / completed.length) : 0,
      minDurationSec: completed.length ? Math.min(...completed.map((t) => Number(t.durationSec) || 0)) : 0,
      maxDurationSec: completed.length ? Math.max(...completed.map((t) => Number(t.durationSec) || 0)) : 0
    };
    res.json({ success: true, timers, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, timers: [] });
  }
});

app.post('/api/survey-timer', async (req, res) => {
  try {
    const entry = normalizeSurveyTimerPayload(req.body || {});
    const idx = surveyTimerStore.findIndex((t) => t.sessionId === entry.sessionId);
    if (idx !== -1) surveyTimerStore[idx] = entry;
    else {
      surveyTimerStore.unshift(entry);
      if (surveyTimerStore.length > 200) surveyTimerStore.length = 200;
    }
    await syncSurveyTimerToFirestore(entry);
    if (entry.roomCode) {
      io.to(entry.roomCode).emit('survey-timer-saved', entry);
    }
    res.json({ success: true, entry });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get local server status and network info
app.get('/api/info', (req, res) => {
  res.json({
    status: 'online',
    port: PORT,
    localIps: getLocalIpAddresses(),
    hasEnvApiKey: Boolean(process.env.GEMINI_API_KEY),
    hasDeepSeekKey: Boolean(process.env.DEEPSEEK_API_KEY),
    bdtPerUsd: BDT_PER_USD,
    deepSeekPeakNow: isDeepSeekPeakUtc(),
    pricing: AI_MODEL_CATALOG,
    features: ['room_messaging', 'cloud_room_sync', 'nid_data_share', 'summary_share', 'survey_timer']
  });
});

// Socket.io Real-time connection for cross-device sync & room messaging
io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // Device joining a specific sync room
  socket.on('join-room', async (roomOrInfo) => {
    const rawRoom = typeof roomOrInfo === 'object' && roomOrInfo ? roomOrInfo.room : roomOrInfo;
    const cleanRoom = normalizeRoomCode(rawRoom);
    socket.join(cleanRoom);
    console.log(`[Socket ${socket.id}] joined room: ${cleanRoom}`);
    const peerCount = io.sockets.adapter.rooms.get(cleanRoom)?.size || 1;
    let history = roomMessagesStore.get(cleanRoom) || [];
    if (history.length === 0) {
      const cloudList = await loadCloudRoomMessages(cleanRoom).catch(() => []);
      cloudList.forEach((m) => appendRoomMessageInMemory(m, cleanRoom));
      history = roomMessagesStore.get(cleanRoom) || [];
    }
    socket.emit('room-joined', { room: cleanRoom, peerCount, history });
    io.to(cleanRoom).emit('room-presence', { room: cleanRoom, peerCount });
    socket.to(cleanRoom).emit('peer-connected', { id: socket.id, room: cleanRoom, peerCount });
  });

  // Cross-device room chat / NID data / summary message
  socket.on('room-message', (rawPayload, ack) => {
    try {
      const msg = appendRoomMessageInMemory(rawPayload || {}, rawPayload?.room);
      io.to(msg.room).emit('room-message', msg);
      syncRoomMessageToFirestore(msg);
      if (typeof ack === 'function') ack({ success: true, message: msg });
    } catch (err) {
      if (typeof ack === 'function') ack({ success: false, error: err.message });
    }
  });

  socket.on('clear-room-messages', (rawPayload) => {
    const room = normalizeRoomCode(typeof rawPayload === 'string' ? rawPayload : rawPayload?.room);
    const clearedAt = Date.now();
    roomMessagesStore.set(room, []);
    syncRoomClearedAtToFirestore(room, clearedAt);
    io.to(room).emit('room-cleared', { room, ts: clearedAt });
  });

  // Mobile device sending image for processing and forwarding
  socket.on('scan-nid', async (payload) => {
    const { image, room, apiKey, deepseekApiKey, aiProvider, defaultKeySlot, geminiModel, deepseekModel } = payload;
    const targetRoom = normalizeRoomCode(room);

    console.log(`[OCR Request] Received image for room: ${targetRoom}`);
    socket.emit('ocr-status', { status: 'processing', message: 'AI ডকুমেন্ট বিশ্লেষণ করছে...' });

    try {
      const extracted = await extractNidWithAI(image, apiKey, {
        docType: payload.docType,
        aiProvider,
        defaultKeySlot,
        geminiModel,
        deepseekModel,
        deepseekApiKey,
        maritalStatus: payload.maritalStatus,
        religion: payload.religion,
        mobileNumber: payload.mobileNumber,
        familyId: payload.familyId
      });
      console.log(`[OCR Success] Extracted:`, extracted.name_bn || extracted.name_en, extracted.nid_number || extracted.birth_reg_no);

      // Async sync to Firestore
      syncToFirestore(extracted);

      // Broadcast extracted data to all devices in the room (including extension on PC)
      const enrichedExtracted = {
        ...extracted,
        ...(payload.survey_started_at_ms ? { survey_started_at_ms: Number(payload.survey_started_at_ms) } : {}),
        ...(payload.survey_session_id ? { survey_session_id: String(payload.survey_session_id) } : {})
      };
      io.to(targetRoom).emit('nid-data-extracted', {
        success: true,
        data: enrichedExtracted,
        timestamp: new Date().toISOString()
      });

      // Share scanned card in room message stream as well
      const scanMsg = appendRoomMessageInMemory({
        room: targetRoom,
        type: 'nid_data',
        text: `🪪 স্ক্যান: ${enrichedExtracted.name_bn || enrichedExtracted.name_en || ''} (${enrichedExtracted.doc_number || enrichedExtracted.nid_number || enrichedExtracted.birth_reg_no || ''})`,
        payload: enrichedExtracted,
        senderName: payload.senderName || 'মোবাইল স্ক্যানার',
        senderClient: 'companion'
      }, targetRoom);
      io.to(targetRoom).emit('room-message', scanMsg);
      syncRoomMessageToFirestore(scanMsg);

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
