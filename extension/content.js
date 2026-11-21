// Content Script injected into https://fc.bhata.gov.bd/*
// Supports both Single-Device (WebRTC Live Camera + Gallery Scanner) & Cross-Device (WebSocket + Cloud Room Bridge)
(function () {
  console.log('[FamilyCard Assistant v2.0.0] Content Script Loaded.');

  function safeJsonParse(raw, fallback) {
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return parsed !== null && parsed !== undefined ? parsed : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeBn(str) {
    if (!str) return '';
    return String(str)
      .normalize('NFC')
      .replace(/\u09A1\u09BC/g, '\u09DC')
      .replace(/\u09A2\u09BC/g, '\u09DD')
      .replace(/\u09AF\u09BC/g, '\u09DF')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const GENDER_ALIAS_MAP = {
    'তৃতীয় লিঙ্গ': 'হিজড়া', 'তৃতীয় লিঙ্গ': 'হিজড়া', 'হিজড়া': 'হিজড়া', 'হিজড়া': 'হিজড়া',
    'third gender': 'হিজড়া', 'hijra': 'হিজড়া', 'other': 'হিজড়া',
    'পুরুষ': 'পুরুষ', 'male': 'পুরুষ', 'm': 'পুরুষ', 'man': 'পুরুষ', 'ছেলে': 'পুরুষ',
    'নারী': 'নারী', 'মহিলা': 'নারী', 'female': 'নারী', 'f': 'নারী', 'woman': 'নারী', 'মেয়ে': 'নারী', 'মেয়ে': 'নারী'
  };

  function normalizeGenderValue(g) {
    if (!g) return '';
    const s = String(g).trim();
    const ng = normalizeBn(s);
    if (GENDER_ALIAS_MAP[ng]) return GENDER_ALIAS_MAP[ng];
    if (GENDER_ALIAS_MAP[s]) return GENDER_ALIAS_MAP[s];
    const low = s.toLowerCase();
    if (GENDER_ALIAS_MAP[low]) return GENDER_ALIAS_MAP[low];
    if (/নারী|মহিলা|female/i.test(s)) return 'নারী';
    if (/পুরুষ|male/i.test(s)) return 'পুরুষ';
    if (/হিজ|তৃতীয়|তৃতীয়|third|hijra/i.test(s)) return 'হিজড়া';
    return ng;
  }

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
    'খান': 'KHAN', 'উদ্দিন': 'UDDIN', 'উদ্দীন': 'UDDIN', 'আহসান': 'AHSAN', 'সাঈদ': 'SAID'
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
    let out = '', i = 0, lastHadExplicitVowel = true;
    while (i < bare.length) {
      const ch = bare[i];
      if (bare.slice(i, i + 3) === 'ক্ষ') {
        out += i === 0 ? 'KH' : 'KSH';
        i += 3;
        const nc = bare[i] || '';
        if (!kars[nc] && nc !== '্' && i < bare.length && cons[nc]) out += 'A';
        lastHadExplicitVowel = Boolean(kars[nc]);
        continue;
      }
      if (bare.slice(i, i + 3) === 'জ্ঞ') {
        out += 'GY';
        i += 3;
        const nc = bare[i] || '';
        if (!kars[nc] && nc !== '্' && i < bare.length && cons[nc]) out += 'A';
        lastHadExplicitVowel = Boolean(kars[nc]);
        continue;
      }
      if (indVowels[ch]) { out += indVowels[ch]; lastHadExplicitVowel = true; i++; continue; }
      if (kars[ch]) { out += kars[ch]; lastHadExplicitVowel = true; i++; continue; }
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
        const nc = bare[i + 1] || '';
        if (!kars[nc] && nc !== '্' && nc !== 'ং' && nc !== 'ঃ' && ch !== 'ৎ') {
          if (i + 1 < bare.length && (cons[nc] || (!indVowels[nc] && i + 2 < bare.length)) && !(lastHadExplicitVowel === false && i > 0 && bare[i - 1] === 'া')) {
            out += 'A';
            lastHadExplicitVowel = false;
          }
        } else {
          lastHadExplicitVowel = Boolean(kars[nc]);
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
    if (!hasBengaliScript(cleaned)) return (typeof normalizeDigits === 'function' ? normalizeDigits(cleaned) : cleaned).toUpperCase().replace(/\s+/g, ' ').trim();
    return cleaned.split(/\s+/).map(transliterateBnWordToEn).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  const FC_ERROR_LOGS_KEY = 'fc_error_logs';
  const FIRESTORE_ERROR_LOGS_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/fc_error_logs';
  const FIRESTORE_LOG_CHANNEL_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/room_channels/FC_SYSTEM_LOGS/messages';
  let __fcExtLogChannelOnly = false;
  const __fcExtRecentDedup = new Map();

  function getLocalErrorLogs() {
    const list = safeJsonParse(localStorage.getItem(FC_ERROR_LOGS_KEY), []);
    return Array.isArray(list) ? list : [];
  }

  function clearLocalErrorLogs() {
    try {
      if (typeof localStorage !== 'undefined') {
        if (typeof localStorage.removeItem === 'function') localStorage.removeItem(FC_ERROR_LOGS_KEY);
        else if (typeof localStorage.setItem === 'function') localStorage.setItem(FC_ERROR_LOGS_KEY, '[]');
      }
    } catch (_) {}
    if (typeof renderExtLogList === 'function') {
      try { renderExtLogList(); } catch (_) {}
    }
  }

  async function fcLogTelemetry(level = 'error', stage = 'general', message = '', detail = '', extra = {}) {
    try {
      const msgStr = String(message || 'Unknown error').slice(0, 800);
      const stageStr = String(stage || 'general').slice(0, 80);
      const sig = `${level}|${stageStr}|${msgStr.slice(0, 140)}`;
      const nowMs = Date.now();
      const prevTs = __fcExtRecentDedup.get(sig) || 0;
      if (nowMs - prevTs < 2500) return null;
      __fcExtRecentDedup.set(sig, nowMs);
      if (__fcExtRecentDedup.size > 40) {
        __fcExtRecentDedup.delete(__fcExtRecentDedup.keys().next().value);
      }
      const fid = (typeof scrapeFamilyId === 'function' ? scrapeFamilyId() : '') || extra.familyId || '';
      const entry = {
        id: `extlog_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
        source: 'extension-content',
        level: String(level || 'error').slice(0, 20),
        stage: stageStr,
        message: msgStr,
        detail: String(detail || '').slice(0, 1200),
        model: String(extra.model || '').slice(0, 80),
        familyId: String(fid || '').slice(0, 40),
        ts: nowMs,
        createdAt: new Date(nowMs).toISOString(),
        synced: false
      };
      const cur = getLocalErrorLogs();
      cur.unshift(entry);
      if (cur.length > 50) cur.length = 50;
      try { localStorage.setItem(FC_ERROR_LOGS_KEY, JSON.stringify(cur)); } catch (_) {}
      if (typeof renderExtLogList === 'function') {
        try { renderExtLogList(); } catch (_) {}
      }
      if (typeof fetch === 'function') {
        const fields = {
          id: { stringValue: entry.id },
          source: { stringValue: entry.source },
          level: { stringValue: entry.level },
          stage: { stringValue: entry.stage },
          message: { stringValue: entry.message },
          detail: { stringValue: entry.detail },
          model: { stringValue: entry.model },
          familyId: { stringValue: entry.familyId },
          ts: { integerValue: String(nowMs) },
          createdAt: { stringValue: entry.createdAt }
        };
        let synced = false;
        if (!__fcExtLogChannelOnly) {
          const res = await fetch(`${FIRESTORE_ERROR_LOGS_BASE}/${encodeURIComponent(entry.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields })
          }).catch(() => null);
          if (res && res.ok) synced = true;
          else if (res && res.status === 403) __fcExtLogChannelOnly = true;
        }
        if (!synced) {
          const fbRes = await fetch(`${FIRESTORE_LOG_CHANNEL_BASE}/${encodeURIComponent(entry.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: {
                id: { stringValue: entry.id },
                room: { stringValue: 'FC_SYSTEM_LOGS' },
                type: { stringValue: 'system' },
                text: { stringValue: `[${entry.level}][${entry.source}][${entry.stage}] ${entry.message}`.slice(0, 800) },
                payloadJson: { stringValue: JSON.stringify(entry) },
                senderName: { stringValue: 'Extension-Telemetry' },
                senderClient: { stringValue: 'extension' },
                senderId: { stringValue: entry.familyId || 'ext' },
                replyToJson: { stringValue: '' },
                ts: { integerValue: String(nowMs) },
                createdAt: { stringValue: entry.createdAt }
              }
            })
          }).catch(() => null);
          if (fbRes && fbRes.ok) synced = true;
        }
        if (synced) {
          entry.synced = true;
          const listNow = getLocalErrorLogs();
          const found = listNow.find(x => x.id === entry.id);
          if (found) found.synced = true;
          try { localStorage.setItem(FC_ERROR_LOGS_KEY, JSON.stringify(listNow)); } catch (_) {}
          if (typeof renderExtLogList === 'function') {
            try { renderExtLogList(); } catch (_) {}
          }
        }
      }
      return entry;
    } catch (_) {
      return null;
    }
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !window.__fcExtTelemetryListenersBound) {
    window.__fcExtTelemetryListenersBound = true;
    window.addEventListener('error', (ev) => {
      fcLogTelemetry('error', 'window.onerror', ev?.message || 'Script error', `${ev?.filename || ''}:${ev?.lineno || ''}`);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev?.reason;
      fcLogTelemetry('error', 'unhandledrejection', (reason && reason.message) || String(reason || 'Promise rejection'));
    });
  }

  function normalizeMobileNumber(mob) {
    if (!mob) return '';
    let clean = normalizeDigits(mob).replace(/[^0-9]/g, '');
    if (clean.startsWith('8801') && clean.length === 13) clean = clean.slice(2);
    if (clean.startsWith('008801') && clean.length === 15) clean = clean.slice(4);
    if (clean.length === 10 && clean.startsWith('1')) clean = '0' + clean;
    return clean;
  }

  function normalizeApplicantPayload(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = { ...raw };
    const cleanDigits = (v) => normalizeDigits(v || '').replace(/[^0-9]/g, '');
    const rawNid = cleanDigits(out.nid_number);
    const rawBrc = cleanDigits(out.birth_reg_no);
    const rawDoc = cleanDigits(out.doc_number);

    if (out.dob) out.dob = standardizeDate(out.dob);
    if (out.gender) out.gender = normalizeGenderValue(out.gender);
    if (out.mobile_number) out.mobile_number = normalizeMobileNumber(out.mobile_number);

    ['name_en', 'father_name_en', 'mother_name_en', 'spouse_name_en'].forEach((k) => {
      if (out[k] && typeof out[k] === 'string') out[k] = out[k].replace(/\s+/g, ' ').trim().toUpperCase();
    });
    ['name_bn', 'father_name_bn', 'mother_name_bn', 'spouse_name_bn'].forEach((k) => {
      if (out[k] && typeof out[k] === 'string') out[k] = normalizeBn(out[k]);
    });
    for (const [bnK, enK] of [
      ['name_bn', 'name_en'],
      ['father_name_bn', 'father_name_en'],
      ['mother_name_bn', 'mother_name_en'],
      ['spouse_name_bn', 'spouse_name_en']
    ]) {
      const bnV = String(out[bnK] || '').trim();
      const enV = String(out[enK] || '').trim();
      if (bnV && (!enV || hasBengaliScript(enV))) {
        const tr = transliterateBnToEn(bnV);
        if (tr) {
          out[enK] = tr;
          out.auto_transliterated_en = true;
        }
      }
    }

    const isBrc = out.doc_type === 'birth_certificate' || (!rawNid && (rawBrc.length === 17 || rawDoc.length === 17 && !out.nid_number && out.birth_reg_no));
    out.doc_type = isBrc ? 'birth_certificate' : 'nid';
    if (isBrc) {
      out.birth_reg_no = rawBrc || rawDoc || rawNid || '';
      out.doc_number = out.birth_reg_no || rawDoc || '';
    } else {
      let nidVal = rawNid || rawDoc || '';
      if (nidVal.length === 13 && out.dob) {
        const ym = String(out.dob).match(/\b(19\d{2}|20\d{2})\b/);
        if (ym) nidVal = ym[1] + nidVal;
      }
      out.nid_number = nidVal;
      out.doc_number = nidVal || rawDoc || '';
    }

    if (!out.marital_status) out.marital_status = out.marital_status_suggestion || 'বিবাহিত';
    if (!out.religion) out.religion = 'ইসলাম';
    if (out.family_id) out.family_id = normalizeDigits(out.family_id).replace(/[^0-9]/g, '');
    return out;
  }

  function cacheFamilyScan(data) {
    const clean = normalizeApplicantPayload(data);
    if (!clean) return;
    const fid = clean.family_id || (typeof scrapeFamilyId === 'function' ? scrapeFamilyId() : '') || '';
    const cacheKey = fid || clean.doc_number || clean.nid_number || clean.birth_reg_no || '';
    if (!cacheKey) return;
    try {
      const store = safeJsonParse(localStorage.getItem('fc_scan_cache_v1'), { byFamily: {}, latestKey: '' });
      if (!store.byFamily || typeof store.byFamily !== 'object') store.byFamily = {};
      store.byFamily[cacheKey] = {
        ...clean,
        family_id: fid || clean.family_id || '',
        _cachedAt: Date.now()
      };
      store.latestKey = cacheKey;
      const entries = Object.entries(store.byFamily);
      if (entries.length > 25) {
        entries.sort((a, b) => (b[1]?._cachedAt || 0) - (a[1]?._cachedAt || 0));
        store.byFamily = Object.fromEntries(entries.slice(0, 25));
      }
      localStorage.setItem('fc_scan_cache_v1', JSON.stringify(store));
    } catch (_) {}
  }

  function getCachedFamilyScan(familyId = null, allowLatestFallback = false) {
    try {
      const store = safeJsonParse(localStorage.getItem('fc_scan_cache_v1'), null);
      if (!store || !store.byFamily) return null;
      const fid = normalizeDigits(familyId || (typeof scrapeFamilyId === 'function' ? scrapeFamilyId() : '') || '').replace(/[^0-9]/g, '');
      if (fid && store.byFamily[fid]) return store.byFamily[fid];
      if (!allowLatestFallback) return null;
      return (store.latestKey && store.byFamily[store.latestKey]) || null;
    } catch (_) {
      return null;
    }
  }

  async function fetchFirestoreApplicant(familyId) {
    const fid = normalizeDigits(familyId || '').replace(/[^0-9]/g, '');
    if (!fid) return null;
    try {
      const url = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(fid)}?t=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      const doc = await res.json().catch(() => null);
      const f = doc?.fields;
      if (!f) return null;
      const str = (k) => f[k]?.stringValue || '';
      const loaded = normalizeApplicantPayload({
        family_id: str('family_id') || fid,
        doc_type: str('doc_type') || 'nid',
        nid_number: str('nid_number'),
        birth_reg_no: str('birth_reg_no'),
        doc_number: str('nid_number') || str('birth_reg_no'),
        name_bn: str('name_bn'),
        name_en: str('name_en'),
        dob: str('dob'),
        gender: str('gender'),
        father_name_bn: str('father_name_bn'),
        father_name_en: str('father_name_en'),
        mother_name_bn: str('mother_name_bn'),
        mother_name_en: str('mother_name_en'),
        spouse_name_bn: str('spouse_name_bn'),
        spouse_name_en: str('spouse_name_en'),
        marital_status: str('marital_status') || 'বিবাহিত',
        religion: str('religion') || 'ইসলাম',
        mobile_number: str('mobile_number'),
        ocr_model_used: str('ocr_model_used')
      });
      if (loaded) cacheFamilyScan(loaded);
      return loaded;
    } catch (_) {
      return null;
    }
  }

  let socket = null;
  let serverUrl = 'http://localhost:3000';
  let roomCode = (localStorage.getItem('fc_room_code') || 'FC-101').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '') || 'FC-101';
  let myDeviceName = localStorage.getItem('fc_device_name') || 'পিসি-এক্সটেনশন';
  const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
  if (!localStorage.getItem('fc_model_default_v2')) {
    const prevGem = localStorage.getItem('fc_gemini_model');
    if (!prevGem || prevGem === 'gemini-3.1-flash-lite') {
      localStorage.setItem('fc_gemini_model', DEFAULT_GEMINI_MODEL);
    }
    localStorage.setItem('fc_model_default_v2', '1');
  }

  let geminiApiKey = '';
  let deepseekApiKey = '';
  let aiProvider = localStorage.getItem('fc_ai_provider') || 'economy';
  let defaultKeySlot = localStorage.getItem('fc_default_key_slot') || 'auto';
  let geminiModel = localStorage.getItem('fc_gemini_model') || DEFAULT_GEMINI_MODEL;
  let deepseekModel = localStorage.getItem('fc_deepseek_model') || 'deepseek-flash';
  let lastExtractedData = null;
  window.__fcLastScannedAny = null;
  let activeScanTarget = { type: 'applicant', card: null, index: 'self' };
  let activeMediaStream = null;
  let savedPostcode = localStorage.getItem('fc_default_postcode') || '7721';
  let savedVillageList = safeJsonParse(localStorage.getItem('fc_village_list'), ['বসাকুষ্টিয়া', 'চর কলিমহর']);
  if (!Array.isArray(savedVillageList) || savedVillageList.length === 0) {
    savedVillageList = ['বসাকুষ্টিয়া', 'চর কলিমহর'];
  }
  let savedDefaultVillage = localStorage.getItem('fc_default_village') || savedVillageList[0] || 'বসাকুষ্টিয়া';

  const BDT_PER_USD = 122;
  const MODAL_MODEL_PRICING = {
    'gemini-3.5-flash-lite': { label: 'Gemini 3.5 Flash-Lite', inM: 0.30, outM: 2.50, est1k: 1.11, rpm: '4K' },
    'gemini-3.8-flash': { label: 'Gemini 3.8 Flash', inM: 0.75, outM: 3.75, est1k: 2.53, rpm: '1K' },
    'gemini-4-argon': { label: 'Gemini 4 Argon', inM: 2.00, outM: 10.00, est1k: 6.50, rpm: '500' },
    'gemini-3.1-flash-lite': { label: 'Gemini 3.1 Flash-Lite', inM: 0.25, outM: 1.50, est1k: 0.78, rpm: '4K' },
    'deepseek-flash': { label: 'DeepSeek Flash', offInM: 0.15, offOutM: 0.60, peakInM: 0.30, peakOutM: 1.20 }
  };

  function isDeepSeekPeakUtc(nowMs = Date.now()) {
    const d = new Date(nowMs);
    const day = d.getUTCDay();
    if (day < 1 || day > 5) return false;
    const h = d.getUTCHours();
    return (h >= 1 && h < 4) || (h >= 6 && h < 10);
  }

  function getSavedCostStats() {
    const s = safeJsonParse(localStorage.getItem('fc_ocr_cost_stats'), {});
    return (s && typeof s === 'object') ? s : {};
  }

  function recordScanCostUsage(usage) {
    if (!usage || typeof usage.costUsd !== 'number') return null;
    const stats = getSavedCostStats();
    stats.totalScans = Number(stats.totalScans || 0) + 1;
    stats.totalUsd = Number((Number(stats.totalUsd || 0) + usage.costUsd).toFixed(7));
    stats.totalTokens = Number(stats.totalTokens || 0) + Number(usage.totalTokens || 0);
    stats.lastUsage = usage;
    stats.byModel = stats.byModel && typeof stats.byModel === 'object' ? stats.byModel : {};
    const m = stats.byModel[usage.model] || { scans: 0, usd: 0 };
    m.scans += 1;
    m.usd = Number((m.usd + usage.costUsd).toFixed(7));
    stats.byModel[usage.model] = m;
    localStorage.setItem('fc_ocr_cost_stats', JSON.stringify(stats));
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ fcOcrCostStats: stats });
    }
    return stats;
  }

  function getSafeFamilyDocId(data) {
    const rawId = scrapeFamilyId() || (data && data.family_id) || (lastExtractedData && lastExtractedData.family_id) || '';
    const cleanFamily = normalizeDigits(rawId).replace(/[^0-9]/g, '');
    if (cleanFamily) return cleanFamily;
    const fallbackDoc = data ? (data.nid_number || data.birth_reg_no || data.doc_number || '') : '';
    const cleanDoc = normalizeDigits(fallbackDoc).replace(/[^0-9]/g, '');
    return cleanDoc || null;
  }

  // Retrieve saved settings
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get([
      'serverUrl', 'roomCode', 'deviceName', 'geminiApiKey', 'deepseekApiKey',
      'aiProvider', 'defaultKeySlot', 'geminiModel', 'deepseekModel', 'fc_model_default_v2',
      's5MfsAccount', 's5Training', 's5TransCount', 's5AbroadDefault', 's5AutoFill'
    ], (res) => {
      if (res.serverUrl) serverUrl = res.serverUrl;
      if (res.roomCode) roomCode = res.roomCode.toUpperCase().replace(/[^A-Z0-9_-]/g, '') || 'FC-101';
      if (res.deviceName) myDeviceName = res.deviceName;
      if (res.geminiApiKey) geminiApiKey = res.geminiApiKey;
      if (res.deepseekApiKey) deepseekApiKey = res.deepseekApiKey;
      if (res.aiProvider) aiProvider = res.aiProvider;
      if (res.defaultKeySlot) defaultKeySlot = res.defaultKeySlot;
      let resolvedModel = res.geminiModel || geminiModel || DEFAULT_GEMINI_MODEL;
      if (!res.fc_model_default_v2) {
        if (!res.geminiModel || res.geminiModel === 'gemini-3.1-flash-lite') {
          resolvedModel = DEFAULT_GEMINI_MODEL;
        }
        chrome.storage.sync.set({ geminiModel: resolvedModel, fc_model_default_v2: '1' });
      }
      geminiModel = MODAL_MODEL_PRICING[resolvedModel] ? resolvedModel : DEFAULT_GEMINI_MODEL;
      localStorage.setItem('fc_gemini_model', geminiModel);
      if (res.deepseekModel) deepseekModel = res.deepseekModel;
      if (res.s5MfsAccount && !localStorage.getItem('fc_s5_default_mfs')) localStorage.setItem('fc_s5_default_mfs', res.s5MfsAccount);
      if (res.s5Training && !localStorage.getItem('fc_s5_default_training')) localStorage.setItem('fc_s5_default_training', res.s5Training);
      if (res.s5TransCount && !localStorage.getItem('fc_s5_default_trans')) localStorage.setItem('fc_s5_default_trans', res.s5TransCount);
      if (res.s5AbroadDefault && !localStorage.getItem('fc_s5_default_abroad')) localStorage.setItem('fc_s5_default_abroad', res.s5AbroadDefault);
      if (res.s5AutoFill !== undefined && localStorage.getItem('fc_s5_auto_fill') === null) localStorage.setItem('fc_s5_auto_fill', res.s5AutoFill ? '1' : '0');
      initUI();
      connectSocket();
    });
  } else {
    initUI();
    connectSocket();
  }

  // --- UI Injections ---
  function initUI() {
    if (document.getElementById('fc-assistant-widget')) return;

    const widget = document.createElement('div');
    widget.id = 'fc-assistant-widget';
    widget.innerHTML = `
      <!-- Single Device Instant Actions (Tablet-Friendly) -->
      <div class="fc-fab-row">
        <div id="fc-summary-btn" title="পূর্ণাঙ্গ ফ্যামিলি কার্ড সারসংক্ষেপ দেখুন">
          <span>📊 সারসংক্ষেপ (0%)</span>
        </div>
        <div id="fc-trace-btn" title="স্টেপ ১–১২ ফিল্ড ট্রেস ও Firebase লগ">
          <span>🗺️ ট্রেস</span>
        </div>
        <div id="fc-chat-btn" title="একই রুমের অন্য ডিভাইসের সাথে মেসেজ ও NID শেয়ার করুন">
          <span>💬 মেসেজ</span><span id="fc-chat-peers-dot" style="display:none; background:#22c55e; color:#052e16; border-radius:9px; padding:1px 5px; font-size:9.5px; font-weight:800;"></span><span id="fc-chat-badge" style="display:none;">0</span>
        </div>
        <div id="fc-fab-scan-btn" title="ট্যাবলেটের ক্যামেরা দিয়ে সরাসরি স্ক্যান করুন">
          <span>📸 NID স্ক্যান</span>
        </div>
      </div>

      <div id="fc-assistant-card" class="hidden">
        <div class="fc-card-header">
          <h4>🪪 NID সহকারী (Auto-Fill)</h4>
          <span id="fc-close-card" style="cursor: pointer; font-size: 16px;">✖</span>
        </div>
        <div class="fc-card-body">
          <button id="fc-btn-direct-scan" class="fc-btn fc-btn-primary" style="background: #1976d2; color: #fff; margin-bottom: 4px;">
            📸 এই ট্যাব থেকেই স্ক্যান করুন
          </button>
          <div class="fc-pair-box">
            <span>অন্য ফোন পেয়ার রুম:</span>
            <span id="fc-ui-room" style="color: #1c3b68;">${escapeHtml(roomCode)}</span>
          </div>
          <div class="fc-preview-box">
            <div class="fc-preview-row">
              <span class="lbl">বাংলা নাম:</span>
              <span id="fc-prev-name-bn" class="val">-</span>
            </div>
            <div class="fc-preview-row">
              <span class="lbl">English Name:</span>
              <span id="fc-prev-name-en" class="val">-</span>
            </div>
            <div class="fc-preview-row">
              <span class="lbl">NID নম্বর:</span>
              <span id="fc-prev-nid" class="val" style="color: #1976d2;">-</span>
            </div>
            <div class="fc-preview-row">
              <span class="lbl">জন্ম তারিখ:</span>
              <span id="fc-prev-dob" class="val">-</span>
            </div>
            <div class="fc-preview-row">
              <span class="lbl">লিঙ্গ:</span>
              <span id="fc-prev-gender" class="val">-</span>
            </div>
            <div class="fc-preview-row" style="border-top: 1px dashed #cbd5e1; margin-top: 4px; padding-top: 4px;">
              <span class="lbl">পিতা (বাং):</span>
              <span id="fc-prev-fat-bn" class="val">-</span>
            </div>
            <div class="fc-preview-row">
              <span class="lbl">Father (EN):</span>
              <span id="fc-prev-fat-en" class="val" style="color: #0284c7;">-</span>
            </div>
            <div class="fc-preview-row">
              <span class="lbl">মাতা (বাং):</span>
              <span id="fc-prev-mot-bn" class="val">-</span>
            </div>
            <div class="fc-preview-row">
              <span class="lbl">Mother (EN):</span>
              <span id="fc-prev-mot-en" class="val" style="color: #0284c7;">-</span>
            </div>
            <div class="fc-preview-row">
              <span class="lbl">তথ্য মান:</span>
              <span id="fc-prev-completeness" class="val" style="color: #047857;">-</span>
            </div>
          </div>
          <div class="fc-btn-row">
            <button id="fc-btn-refill" class="fc-btn fc-btn-fill">পুনরায় পূরণ করুন</button>
            <button id="fc-btn-paste" class="fc-btn fc-btn-outline">ক্লিপবোর্ড থেকে</button>
          </div>
        </div>
      </div>

      <div id="fc-assistant-badge">
        <span class="dot"></span>
        <span class="txt">NID Assistant: প্রস্তুত</span>
      </div>
    `;

    document.body.appendChild(widget);

    // Create Modal for In-Page Camera Scanning
    createScannerModal();

    const badge = document.getElementById('fc-assistant-badge');
    const card = document.getElementById('fc-assistant-card');
    const closeBtn = document.getElementById('fc-close-card');
    const fabBtn = document.getElementById('fc-fab-scan-btn');
    const summaryBtn = document.getElementById('fc-summary-btn');
    const chatBtn = document.getElementById('fc-chat-btn');
    const directScanBtn = document.getElementById('fc-btn-direct-scan');

    badge.addEventListener('click', () => card.classList.toggle('hidden'));
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.add('hidden');
    });

    if (summaryBtn) summaryBtn.addEventListener('click', openSummaryModal);
    if (chatBtn) chatBtn.addEventListener('click', openChatModal);

    fabBtn.addEventListener('click', () => {
      const tab6 = document.querySelector('[data-family-card-tab="6"]');
      const isTab6Active = Boolean(tab6 && isPanelActiveVisible(tab6));
      setScanTarget(isTab6Active ? 'member' : 'applicant', null, isTab6Active ? 'auto' : 1);
      openScannerModal();
    });
    directScanBtn.addEventListener('click', () => {
      setScanTarget('applicant', null, 1);
      openScannerModal();
    });

    document.getElementById('fc-btn-refill').addEventListener('click', async () => {
      const curFid = scrapeFamilyId() || '';
      const src = (lastExtractedData && (!curFid || !lastExtractedData.family_id || lastExtractedData.family_id === curFid))
        ? lastExtractedData
        : getCachedFamilyScan(curFid, true);
      if (src) {
        const norm = normalizeApplicantPayload(src);
        lastExtractedData = norm;
        await fillFormFields(norm, { overwriteExisting: true });
        showToast('এনআইডি ও স্টেপ ২ তথ্য পুনরায় পূরণ করা হয়েছে!');
      } else {
        alert('কোনো স্ক্যান করা তথ্য এখনো আসেনি। "📸 NID স্ক্যান" বাটনে চাপুন।');
      }
    });

    document.getElementById('fc-btn-paste').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        const raw = JSON.parse(text);
        const json = normalizeApplicantPayload({ ...raw, family_id: raw.family_id || scrapeFamilyId() || '' });
        lastExtractedData = json;
        cacheFamilyScan(json);
        window.__fcStep1FilledKey = '';
        updateWidgetPreview(json);
        await fillFormFields(json, { overwriteExisting: true });
        syncToFirestore(json);
        showToast('ক্লিপবোর্ড থেকে ফর্ম পূরণ সম্পন্ন!');
      } catch (e) {
        alert('ক্লিপবোর্ডে বৈধ NID JSON পাওয়া যায়নি: ' + e.message);
      }
    });
  }

  // --- In-Page Single Device Scanner Modal ---
  function createScannerModal() {
    if (document.getElementById('fc-scanner-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'fc-scanner-modal';
    modal.className = 'fc-modal-overlay';
    modal.style.display = 'none';

    modal.innerHTML = `
      <div class="fc-modal-container">
        <div class="fc-modal-header">
          <h3>🪪 সরাসরি NID ও জন্ম নিবন্ধন স্ক্যান (v2.0.0)</h3>
          <button type="button" id="fc-modal-hdr-chat" style="background:rgba(255,255,255,0.22); border:1px solid rgba(255,255,255,0.45); color:#fff; border-radius:6px; padding:3px 8px; font-size:11px; font-weight:700; cursor:pointer; margin-left:auto; margin-right:8px;">💬 রুম মেসেজ</button>
          <span class="fc-modal-close" id="fc-modal-close-btn">&times;</span>
        </div>
        <div class="fc-modal-body">
          <!-- Target Selector: Applicant vs Family Member -->
          <div style="display: flex; gap: 6px; background: #f1f5f9; padding: 4px; border-radius: 8px;">
            <button type="button" id="fc-modal-target-self-btn" style="flex: 1; padding: 6px 10px; border: none; border-radius: 6px; font-weight: 700; font-size: 11.5px; cursor: pointer; background: #0284c7; color: #fff;">
              👤 প্রধান আবেদনকারী
            </button>
            <button type="button" id="fc-modal-target-member-btn" style="flex: 1; padding: 6px 10px; border: none; border-radius: 6px; font-weight: 700; font-size: 11.5px; cursor: pointer; background: #e2e8f0; color: #334155;">
              👨‍👩‍👧‍👦 সদস্য (NID / জন্ম নিবন্ধন)
            </button>
          </div>

          <!-- Document & Camera Frame Size Bar (Works for Applicant + Member) -->
          <div id="fc-modal-doc-frame-bar" class="fc-modal-doc-pills">
            <button type="button" class="fc-modal-frame-pill active" data-doc-choice="nid" data-frame-mode="id">🪪 NID (ID কার্ড)</button>
            <button type="button" class="fc-modal-frame-pill" data-doc-choice="birth_certificate" data-frame-mode="a4">📄 জন্ম নিবন্ধন (A4)</button>
            <button type="button" class="fc-modal-frame-pill" data-doc-choice="auto">🤖 অটো</button>
          </div>

          <!-- Family Member Sub-panel (Shown when member target selected) -->
          <div id="fc-modal-member-settings" style="display: none; background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 10px; padding: 10px; flex-direction: column; gap: 8px;">
            <div style="font-weight: 700; color: #166534; font-size: 12px; display: flex; justify-content: space-between; align-items: center;">
              <span>👨‍👩‍👧‍👦 সদস্য স্ক্যান কনফিগারেশন</span>
              <span id="fc-modal-member-badge" style="font-size: 10.5px; color: #0f766e; font-weight: bold; background: #ccfbf1; padding: 2px 6px; border-radius: 4px;">সদস্য নির্বাচন করুন</span>
            </div>
            <div class="fc-modal-fields-row">
              <div class="fc-modal-field">
                <label for="fc-modal-member-select">🎯 টার্গেট সদস্য কার্ড*</label>
                <select id="fc-modal-member-select" style="padding: 4px 6px; border-radius: 6px; border: 1px solid #86efac; font-weight: 600;">
                  <option value="auto">পরবর্তী খালি সদস্য কার্ড</option>
                </select>
              </div>
              <div class="fc-modal-field">
                <label for="fc-modal-doc-type">📄 সনদের ধরন*</label>
                <select id="fc-modal-doc-type" style="padding: 4px 6px; border-radius: 6px; border: 1px solid #86efac; font-weight: 600;">
                  <option value="auto">অটো-ডিটেক্ট (NID বা জন্ম সনদ)</option>
                  <option value="nid" selected>জাতীয় পরিচিতি নম্বর (NID)</option>
                  <option value="birth_certificate">জন্ম নিবন্ধন সনদ (BRC)</option>
                </select>
              </div>
            </div>
            <div class="fc-modal-field">
              <label for="fc-modal-relation-select">🤝 খানাপ্রধানের সাথে সম্পর্ক* (অটো-ডিটেক্ট হবে)</label>
              <select id="fc-modal-relation-select" style="padding: 4px 6px; border-radius: 6px; border: 1px solid #86efac; font-weight: 600;">
                <option value="auto">স্মার্ট অটো-সাজেশন</option>
                <option value="স্বামী">স্বামী</option>
                <option value="স্ত্রী">স্ত্রী</option>
                <option value="পুত্র">পুত্র</option>
                <option value="কন্যা">কন্যা</option>
                <option value="পিতা">পিতা</option>
                <option value="মাতা">মাতা</option>
                <option value="ভাই">ভাই</option>
                <option value="বোন">বোন</option>
                <option value="দাদা">দাদা</option>
                <option value="দাদী">দাদী</option>
                <option value="নানা">নানা</option>
                <option value="নানী">নানী</option>
                <option value="নাতি">নাতি</option>
                <option value="নাতনি">নাতনি</option>
                <option value="শ্বশুর">শ্বশুর</option>
                <option value="শাশুড়ি">শাশুড়ি</option>
                <option value="অন্যান্য">অন্যান্য</option>
              </select>
            </div>
          </div>

          <input type="file" id="fc-modal-file-input" accept="image/*" capture="environment" style="display: none;">

          <div id="fc-modal-viewfinder" class="fc-modal-cam-box mode-id" style="display: none;">
            <video id="fc-modal-video" playsinline autoplay muted></video>
            <div id="fc-modal-crop-frame" class="fc-modal-crop-frame">
              <div class="fc-modal-cam-bracket tl"></div>
              <div class="fc-modal-cam-bracket tr"></div>
              <div class="fc-modal-cam-bracket bl"></div>
              <div class="fc-modal-cam-bracket br"></div>
              <div id="fc-modal-cam-hint" class="fc-modal-crop-hint">NID কার্ডটি নীল ফ্রেমের ভেতর রাখুন (বাইরের অংশ ক্রপ হবে)</div>
            </div>
          </div>

          <div id="fc-modal-preview-wrap" class="fc-preview-img-wrap" style="display: none;">
            <img id="fc-modal-img-preview" alt="Document Preview">
          </div>

          <div class="fc-modal-btn-row">
            <button id="fc-modal-btn-camera" class="fc-camera-trigger-btn">
              <span>📷 লাইভ ক্যামেরা</span>
            </button>
            <button id="fc-modal-btn-snap" class="fc-camera-trigger-btn" style="display: none; background: linear-gradient(135deg, #16a34a, #15803d);">
              <span>⚡ ছবি তুলুন</span>
            </button>
            <button id="fc-modal-btn-gallery" class="fc-modal-sec-btn" type="button">
              <span>📁 ফাইল / গ্যালারি</span>
            </button>
          </div>

          <!-- Applicant Specific Settings -->
          <div id="fc-modal-applicant-settings" style="display: flex; flex-direction: column; gap: 8px;">
            <div class="fc-modal-fields-row">
              <div class="fc-modal-field">
                <label for="fc-modal-marital">💍 বৈবাহিক অবস্থা*</label>
                <select id="fc-modal-marital">
                  <option value="বিবাহিত" selected>বিবাহিত (Default)</option>
                  <option value="অবিবাহিত">অবিবাহিত</option>
                  <option value="বিধবা">বিধবা</option>
                  <option value="বিপত্নীক">বিপত্নীক</option>
                  <option value="তালাকপ্রাপ্ত">তালাকপ্রাপ্ত</option>
                  <option value="পরিত্যক্ত">পরিত্যক্ত</option>
                </select>
              </div>
              <div class="fc-modal-field">
                <label for="fc-modal-religion">🕌 ধর্ম*</label>
                <select id="fc-modal-religion">
                  <option value="ইসলাম" selected>ইসলাম (Default)</option>
                  <option value="হিন্দু">হিন্দু</option>
                  <option value="বৌদ্ধ">বৌদ্ধ</option>
                  <option value="খ্রিস্টান">খ্রিস্টান</option>
                  <option value="অন্যান্য">অন্যান্য</option>
                </select>
              </div>
            </div>

            <div class="fc-modal-field">
              <label for="fc-modal-mobile">📱 মোবাইল নম্বর (ঐচ্ছিক - ট্যাবলেটে ম্যানুয়ালি লিখতে পারেন):</label>
              <input type="tel" id="fc-modal-mobile" placeholder="যেমন: 019XXXXXXXX" maxlength="11">
            </div>

            <!-- Section 4 Address Settings -->
            <div style="background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px;">
              <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                <label style="font-size: 12px; font-weight: 700; color: #1c3b68;">📍 সেকশন ৪: তথ্য সংগ্রহের ঠিকানা</label>
                <span id="fc-modal-addr-valid-pill" style="font-size: 10.5px; font-weight: 700; color: #15803d;">📮 ৭৭২১ ✅ • স্থায়ী ঠিকানা নিরাপদ</span>
              </div>
              <div class="fc-modal-fields-row">
                <div class="fc-modal-field">
                  <label for="fc-modal-postcode">📮 পোস্ট কোড* (৪ সংখ্যা)</label>
                  <input type="text" id="fc-modal-postcode" value="${escapeHtml(savedPostcode)}" placeholder="7721" maxlength="6">
                </div>
                <div class="fc-modal-field">
                  <label for="fc-modal-village">🏠 গ্রাম নির্বাচন*</label>
                  <select id="fc-modal-village">
                    ${savedVillageList.map(v => `<option value="${escapeHtml(v)}" ${v === savedDefaultVillage ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                  </select>
                </div>
              </div>
              <div id="fc-modal-village-chips" class="fc-s4-vchips"></div>
              <div style="display: flex; gap: 6px;">
                <input type="text" id="fc-modal-new-village" placeholder="নতুন গ্রামের নাম লিখুন (যেমন: চর ঝিকরী)..." style="flex: 1; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px;">
                <button id="fc-modal-btn-add-village" type="button" style="padding: 6px 12px; font-size: 12px; font-weight: 700; background: #0284c7; color: #fff; border: none; border-radius: 8px; cursor: pointer;">➕ যোগ</button>
              </div>
            </div>

            <!-- Section 5 Defaults Settings -->
            <div style="background: #f0fdfa; border: 1.5px solid #99f6e4; border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px;">
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap;">
                <label style="font-size: 12px; font-weight: 800; color: #0f766e;">📊 সেকশন ৫: প্রোগ্রাম, সদস্য ও এমএফএস</label>
                <span id="fc-modal-s5-pill" style="font-size: 10.5px; font-weight: 700; color: #0f766e;">নগদ • প্রশিক্ষণ: না</span>
              </div>
              <div id="fc-modal-s5-live" style="font-size: 11px; font-weight: 700; color: #334155; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 7px; padding: 5px 8px;">ট্যাব ৫ লোড হলে সদস্য ও প্রোগ্রাম স্ট্যাটাস দেখা যাবে</div>
              <div class="fc-modal-fields-row">
                <div class="fc-modal-field">
                  <label for="fc-modal-s5-mfs">📱 ডিফল্ট মোবাইল ব্যাংকিং</label>
                  <select id="fc-modal-s5-mfs">
                    <option value="নগদ">নগদ</option>
                    <option value="বিকাশ">বিকাশ</option>
                    <option value="রকেট">রকেট</option>
                    <option value="উপায়">উপায়</option>
                    <option value="প্রযোজ্য নয়">প্রযোজ্য নয় / নেই</option>
                  </select>
                </div>
                <div class="fc-modal-field">
                  <label for="fc-modal-s5-training">🎓 প্রশিক্ষণ/সুবিধা</label>
                  <select id="fc-modal-s5-training">
                    <option value="না">না</option>
                    <option value="হ্যাঁ">হ্যাঁ</option>
                  </select>
                </div>
              </div>
              <div class="fc-modal-fields-row">
                <div class="fc-modal-field">
                  <label for="fc-modal-s5-trans">⚧️ ডিফল্ট হিজড়া সদস্য</label>
                  <select id="fc-modal-s5-trans">
                    <option value="০">০ (ডিফল্ট)</option>
                    <option value="১">১</option>
                    <option value="২">২</option>
                  </select>
                </div>
                <div class="fc-modal-field">
                  <label for="fc-modal-s5-abroad">✈️ ডিফল্ট প্রবাসী (সকল)</label>
                  <select id="fc-modal-s5-abroad">
                    <option value="০">০ (না — বিদেশী অর্থ: না)</option>
                    <option value="১">১</option>
                    <option value="২">২</option>
                  </select>
                </div>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; flex-wrap:wrap;">
                <label style="display:flex; align-items:center; gap:6px; font-size:11.5px; font-weight:600; color:#334155; margin:0; cursor:pointer;">
                  <input type="checkbox" id="fc-modal-s5-autofill" checked style="width:auto; margin:0;">
                  <span>খালি ডিফল্ট অটো-ফিল</span>
                </label>
                <div style="display:flex; gap:5px; align-items:center;">
                  <button id="fc-modal-btn-jump-s5" type="button" style="padding:5px 9px; font-size:11px; font-weight:700; background:#e2e8f0; color:#0f172a; border:none; border-radius:7px; cursor:pointer;">🔍 স্টেপ ৫-এ যান</button>
                  <button id="fc-modal-btn-apply-s5" type="button" style="padding:5px 10px; font-size:11px; font-weight:700; background:#0f766e; color:#fff; border:none; border-radius:7px; cursor:pointer;">⚡ স্টেপ ৫ বসান</button>
                </div>
              </div>
            </div>
          </div>

          <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 10px; padding: 9px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px;">
            <div class="fc-modal-fields-row">
              <div class="fc-modal-field">
                <label for="fc-modal-ai-provider">🧠 AI কৌশল:</label>
                <select id="fc-modal-ai-provider">
                  <option value="economy" ${aiProvider === 'economy' ? 'selected' : ''}>💸 সাশ্রয়ী অটো (3.5 Lite → 3.8)</option>
                  <option value="deepseek" ${aiProvider === 'deepseek' ? 'selected' : ''}>🐋 DeepSeek Flash (~$0.38/1K)</option>
                  <option value="gemini_lite" ${aiProvider === 'gemini_lite' ? 'selected' : ''}>⚡ Gemini Lite (~$0.78–$1.11/1K)</option>
                  <option value="auto" ${aiProvider === 'auto' ? 'selected' : ''}>⚖️ ডুয়াল-AI (ডিফল্ট কী → ব্যাকআপ)</option>
                  <option value="gemini" ${aiProvider === 'gemini' ? 'selected' : ''}>💎 Gemini শুধুমাত্র (নির্বাচিত মডেল)</option>
                </select>
              </div>
              <div class="fc-modal-field">
                <label for="fc-modal-default-key">🔑 ডিফল্ট প্রাথমিক কী:</label>
                <select id="fc-modal-default-key">
                  <option value="auto" ${defaultKeySlot === 'auto' ? 'selected' : ''}>🤖 স্বয়ংক্রিয়</option>
                  <option value="gemini" ${defaultKeySlot === 'gemini' ? 'selected' : ''}>✨ Gemini আগে</option>
                  <option value="deepseek" ${defaultKeySlot === 'deepseek' ? 'selected' : ''}>🐋 DeepSeek আগে</option>
                </select>
              </div>
            </div>
            <div class="fc-modal-fields-row">
              <div class="fc-modal-field">
                <label for="fc-modal-gemini-model">✨ Gemini মডেল:</label>
                <select id="fc-modal-gemini-model">
                  <option value="gemini-3.5-flash-lite" ${geminiModel === 'gemini-3.5-flash-lite' ? 'selected' : ''}>3.5 Lite ($0.30/$2.50)</option>
                  <option value="gemini-3.8-flash" ${geminiModel === 'gemini-3.8-flash' ? 'selected' : ''}>3.8 Flash ($0.75/$3.75)</option>
                  <option value="gemini-4-argon" ${geminiModel === 'gemini-4-argon' ? 'selected' : ''}>4 Argon ($2.00/$10.00)</option>
                  <option value="gemini-3.1-flash-lite" ${geminiModel === 'gemini-3.1-flash-lite' ? 'selected' : ''}>3.1 Lite ($0.25/$1.50)</option>
                </select>
              </div>
              <div class="fc-modal-field">
                <label for="fc-modal-deepseek-model">🐋 DeepSeek মডেল:</label>
                <select id="fc-modal-deepseek-model">
                  <option value="deepseek-flash" ${deepseekModel === 'deepseek-flash' ? 'selected' : ''}>deepseek-flash ($0.15/$0.60)</option>
                  <option value="deepseek-chat" ${deepseekModel === 'deepseek-chat' ? 'selected' : ''}>deepseek-chat (V3/EN Completion)</option>
                </select>
              </div>
            </div>
            <div id="fc-modal-cost-card" style="background: #f0fdf4; border: 1px solid #86efac; color: #166534; border-radius: 7px; padding: 6px 8px; font-size: 11px; line-height: 1.4;">হিসাব লোড হচ্ছে...</div>
            <button id="fc-modal-btn-save-ai" type="button" style="background: #0f766e; color: #fff; border: none; border-radius: 7px; padding: 6px 10px; font-size: 11.5px; font-weight: 700; cursor: pointer;">💾 ডিফল্ট কী ও মডেল সেভ করুন</button>
          </div>

          <div id="fc-modal-ocr-warn" style="display: none; background: #fffbeb; border: 1.5px solid #f59e0b; color: #92400e; padding: 8px 10px; border-radius: 8px; font-size: 11.5px; line-height: 1.45;"></div>

          <div id="fc-modal-loading" class="fc-loading-spinner-wrap" style="display: none; flex-direction: column; text-align: center; padding: 12px; background: linear-gradient(135deg, #f8fafc, #eff6ff); border: 1.5px solid #bfdbfe; border-radius: 10px;">
            <div class="fc-spinner"></div>
            <span id="fc-modal-loading-text" style="font-weight: 800; color: #1d4ed8; font-size: 13px; margin-top: 6px;">AI দ্বারা ডকুমেন্ট বিশ্লেষণ করা হচ্ছে... (০%)</span>
            <div class="fc-modal-progress-wrap">
              <div id="fc-modal-progress-fill" class="fc-modal-progress-fill"></div>
            </div>
            <div class="fc-modal-progress-meta">
              <span id="fc-modal-progress-stage">ধাপ: ছবি প্রস্তুত হচ্ছে</span>
              <span id="fc-modal-progress-pct">0% • 0s</span>
            </div>
          </div>

          <button id="fc-modal-btn-submit" class="fc-modal-submit-btn" style="display: none;">
            <span>⚡ যাচাই ও ফর্ম পূরণ করুন</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const closeBtn = document.getElementById('fc-modal-close-btn');
    const fileInput = document.getElementById('fc-modal-file-input');
    const btnCamera = document.getElementById('fc-modal-btn-camera');
    const btnSnap = document.getElementById('fc-modal-btn-snap');
    const btnGallery = document.getElementById('fc-modal-btn-gallery');
    const viewFinder = document.getElementById('fc-modal-viewfinder');
    const cropFrameElem = document.getElementById('fc-modal-crop-frame');
    const camHintElem = document.getElementById('fc-modal-cam-hint');
    const videoElem = document.getElementById('fc-modal-video');
    const selectMemberDocType = document.getElementById('fc-modal-doc-type');
    const docFramePills = Array.from(document.querySelectorAll('#fc-modal-doc-frame-bar .fc-modal-frame-pill'));
    window.__fcModalDocChoice = window.__fcModalDocChoice || 'nid';
    window.__fcModalFrameMode = window.__fcModalFrameMode || 'id';

    function applyModalDocumentFrameMode(docChoice, explicitFrameMode = null) {
      window.__fcModalDocChoice = docChoice || 'nid';
      if (selectMemberDocType && selectMemberDocType.value !== window.__fcModalDocChoice) {
        selectMemberDocType.value = window.__fcModalDocChoice;
      }
      if (explicitFrameMode) {
        window.__fcModalFrameMode = explicitFrameMode;
      } else if (window.__fcModalDocChoice === 'birth_certificate') {
        window.__fcModalFrameMode = 'a4';
      } else if (window.__fcModalDocChoice === 'nid') {
        window.__fcModalFrameMode = 'id';
      }
      if (viewFinder) {
        viewFinder.classList.toggle('mode-a4', window.__fcModalFrameMode === 'a4');
        viewFinder.classList.toggle('mode-id', window.__fcModalFrameMode !== 'a4');
      }
      if (camHintElem) {
        camHintElem.textContent = window.__fcModalFrameMode === 'a4'
          ? 'A4 জন্ম নিবন্ধন সনদ নীল ফ্রেমে রাখুন (বাইরের অংশ ক্রপ হবে)'
          : 'NID কার্ডটি নীল ফ্রেমের ভেতর রাখুন (বাইরের অংশ ক্রপ হবে)';
      }
      docFramePills.forEach((p) => {
        p.classList.toggle('active', p.dataset.docChoice === window.__fcModalDocChoice);
      });
    }

    docFramePills.forEach((pill) => {
      pill.addEventListener('click', () => {
        const choice = pill.dataset.docChoice || 'nid';
        const nextFrame = pill.dataset.frameMode || (choice === 'birth_certificate' ? 'a4' : (choice === 'nid' ? 'id' : window.__fcModalFrameMode));
        applyModalDocumentFrameMode(choice, nextFrame);
      });
    });
    if (selectMemberDocType) {
      selectMemberDocType.addEventListener('change', () => applyModalDocumentFrameMode(selectMemberDocType.value));
    }
    applyModalDocumentFrameMode('nid', 'id');
    const btnSubmit = document.getElementById('fc-modal-btn-submit');
    const btnTargetSelf = document.getElementById('fc-modal-target-self-btn');
    const btnTargetMember = document.getElementById('fc-modal-target-member-btn');
    const memberSelect = document.getElementById('fc-modal-member-select');
    const inputPostcode = document.getElementById('fc-modal-postcode');
    const selectVillage = document.getElementById('fc-modal-village');
    const inputNewVillage = document.getElementById('fc-modal-new-village');
    const btnAddVillage = document.getElementById('fc-modal-btn-add-village');

    btnTargetSelf.addEventListener('click', () => setScanTarget('applicant'));
    btnTargetMember.addEventListener('click', () => setScanTarget('member'));

    const modalSelProv = document.getElementById('fc-modal-ai-provider');
    const modalSelKeySlot = document.getElementById('fc-modal-default-key');
    const modalSelGem = document.getElementById('fc-modal-gemini-model');
    const modalSelDs = document.getElementById('fc-modal-deepseek-model');
    const modalCostCard = document.getElementById('fc-modal-cost-card');
    const btnSaveModalAi = document.getElementById('fc-modal-btn-save-ai');

    window.__fcRenderModalCostCard = () => {
      if (!modalCostCard) return;
      const st = modalSelProv ? modalSelProv.value : aiProvider;
      const ks = modalSelKeySlot ? modalSelKeySlot.value : defaultKeySlot;
      const gm = modalSelGem ? modalSelGem.value : geminiModel;
      const gemSpec = MODAL_MODEL_PRICING[gm] || MODAL_MODEL_PRICING[DEFAULT_GEMINI_MODEL];
      const peak = isDeepSeekPeakUtc();
      const ds1k = peak ? 0.76 : 0.38;
      const dsIn = peak ? 0.30 : 0.15;
      const dsOut = peak ? 1.20 : 0.60;
      const stats = getSavedCostStats();
      const useDs = st === 'deepseek' || (ks === 'deepseek' && (st === 'economy' || st === 'auto'));
      const activeTxt = useDs
        ? `<b>সক্রিয়:</b> DeepSeek Flash (${peak ? '🟠 Peak' : '🟢 Off-Peak'}) • ~$${ds1k.toFixed(2)} (~৳${Math.round(ds1k * BDT_PER_USD)}) / ১,০০০ NID`
        : `<b>সক্রিয়:</b> ${gemSpec.label} • ~$${gemSpec.est1k.toFixed(2)} (~৳${Math.round(gemSpec.est1k * BDT_PER_USD)}) / ১,০০০ NID (${gemSpec.rpm} RPM)`;
      const rateTxt = `রেট/1M: ${gemSpec.label} <b>$${gemSpec.inM}/$${gemSpec.outM}</b> | DeepSeek <b>$${dsIn}/$${dsOut}</b>`;
      const lastTxt = stats.lastUsage
        ? `<br>🧾 শেষ স্ক্যান: <b>$${Number(stats.lastUsage.costUsd || 0).toFixed(5)}</b> (~৳${Number(stats.lastUsage.costBdt || 0).toFixed(3)}) • মোট: <b>$${Number(stats.totalUsd || 0).toFixed(5)}</b> (${stats.totalScans || 0} স্ক্যান)`
        : '';
      modalCostCard.innerHTML = `${activeTxt}<br>${rateTxt}${lastTxt}`;
    };

    function persistModalAiDefaults(showMsg = false) {
      if (modalSelProv) aiProvider = modalSelProv.value;
      if (modalSelKeySlot) defaultKeySlot = modalSelKeySlot.value;
      if (modalSelGem) geminiModel = modalSelGem.value;
      if (modalSelDs) deepseekModel = modalSelDs.value;
      localStorage.setItem('fc_ai_provider', aiProvider);
      localStorage.setItem('fc_default_key_slot', defaultKeySlot);
      localStorage.setItem('fc_gemini_model', geminiModel);
      localStorage.setItem('fc_deepseek_model', deepseekModel);
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ aiProvider, defaultKeySlot, geminiModel, deepseekModel });
      }
      window.__fcRenderModalCostCard();
      if (showMsg) showToast('✅ ডিফল্ট কী ও মডেল সেভ হয়েছে!');
    }

    [modalSelProv, modalSelKeySlot, modalSelGem, modalSelDs].forEach(el => {
      if (el) el.addEventListener('change', () => persistModalAiDefaults(false));
    });
    if (btnSaveModalAi) {
      btnSaveModalAi.addEventListener('click', () => persistModalAiDefaults(true));
    }
    window.__fcRenderModalCostCard();

    if (memberSelect) {
      memberSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        const badge = document.getElementById('fc-modal-member-badge');
        if (val === 'new') {
          activeScanTarget.card = null;
          activeScanTarget.index = 'new';
          if (badge) badge.textContent = 'টার্গেট: নতুন সদস্য';
        } else if (val === 'auto') {
          activeScanTarget.card = null;
          activeScanTarget.index = 'auto';
          if (badge) badge.textContent = 'পরবর্তী খালি সদস্য কার্ড';
        } else {
          const cards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
          const idx = parseInt(val, 10);
          activeScanTarget.card = cards[idx - 1] || null;
          activeScanTarget.index = idx;
          if (badge) badge.textContent = `সদস্য - ${toBnDigits(idx)} নির্দিষ্ট`;
        }
      });
    }

    if (inputPostcode) {
      inputPostcode.addEventListener('change', () => {
        const cfg = saveAddressConfig({ postcode: inputPostcode.value });
        handleSection4Address({ force: true });
        updateSummaryBadge(true);
        showToast(`✅ পোস্ট কোড ${toBnDigits(cfg.postcode)} সেভ ও ফর্মে বসানো হয়েছে!`);
      });
    }
    if (selectVillage) {
      selectVillage.addEventListener('change', () => {
        const cfg = saveAddressConfig({ village: selectVillage.value });
        handleSection4Address({ force: true });
        updateSummaryBadge(true);
        showToast(`✅ গ্রাম "${cfg.village}" সেট ও ফর্মে বসানো হয়েছে!`);
      });
    }
    const modalVillageChips = document.getElementById('fc-modal-village-chips');
    if (modalVillageChips) {
      modalVillageChips.addEventListener('click', (e) => {
        const delBtn = e.target.closest('[data-modal-del-v]');
        if (delBtn) {
          e.stopPropagation();
          const targetV = delBtn.getAttribute('data-modal-del-v');
          saveAddressConfig({ removeVillage: targetV });
          handleSection4Address({ force: true });
          updateSummaryBadge(true);
          showToast(`🗑️ গ্রাম "${targetV}" তালিকা থেকে সরানো হয়েছে।`);
          return;
        }
        const pick = e.target.closest('[data-modal-pick-v]');
        if (pick) {
          const chosen = pick.getAttribute('data-modal-pick-v');
          saveAddressConfig({ village: chosen });
          handleSection4Address({ force: true });
          updateSummaryBadge(true);
          showToast(`✅ গ্রাম "${chosen}" সেট ও ফর্মে বসানো হয়েছে!`);
        }
      });
    }
    function addNewModalVillageExt() {
      const newName = inputNewVillage?.value.trim();
      if (!newName) return;
      const cfg = saveAddressConfig({ addVillage: newName });
      handleSection4Address({ force: true });
      updateSummaryBadge(true);
      if (inputNewVillage) inputNewVillage.value = '';
      showToast(`✅ গ্রাম "${cfg.village}" যোগ করা হয়েছে এবং ফর্মে বসানো হলো!`);
    }
    if (btnAddVillage) btnAddVillage.addEventListener('click', addNewModalVillageExt);
    if (inputNewVillage) {
      inputNewVillage.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addNewModalVillageExt(); }
      });
    }

    const modalS5MfsSel = document.getElementById('fc-modal-s5-mfs');
    const modalS5TrSel = document.getElementById('fc-modal-s5-training');
    const modalS5TransSel = document.getElementById('fc-modal-s5-trans');
    const modalS5AbroadSel = document.getElementById('fc-modal-s5-abroad');
    const modalS5AutoCb = document.getElementById('fc-modal-s5-autofill');
    const modalS5ApplyBtn = document.getElementById('fc-modal-btn-apply-s5');
    const modalS5JumpBtn = document.getElementById('fc-modal-btn-jump-s5');
    updateModalSection5Controls();
    if (modalS5MfsSel) {
      modalS5MfsSel.addEventListener('change', () => {
        const next = saveSection5Config({ mfsAccount: modalS5MfsSel.value });
        if (typeof autoFillSection5Defaults === 'function') autoFillSection5Defaults({ force: true, overrides: { mfs: next.mfsAccount } });
        showToast(`✅ স্টেপ ৫ ডিফল্ট এমএফএস "${next.mfsAccount}" সেভ হয়েছে!`);
      });
    }
    if (modalS5TrSel) {
      modalS5TrSel.addEventListener('change', () => {
        const next = saveSection5Config({ training: modalS5TrSel.value });
        if (typeof autoFillSection5Defaults === 'function') autoFillSection5Defaults({ force: true, overrides: { training: next.training } });
        showToast(`✅ স্টেপ ৫ প্রশিক্ষণ ডিফল্ট "${next.training}" সেভ হয়েছে!`);
      });
    }
    if (modalS5TransSel) {
      modalS5TransSel.addEventListener('change', () => {
        const next = saveSection5Config({ transCount: modalS5TransSel.value });
        if (typeof autoFillSection5Defaults === 'function') autoFillSection5Defaults({ force: true, overrides: { trans: next.transCount } });
        showToast(`✅ স্টেপ ৫ হিজড়া সংখ্যা ডিফল্ট "${next.transCount}" সেভ হয়েছে!`);
      });
    }
    if (modalS5AbroadSel) {
      modalS5AbroadSel.addEventListener('change', () => {
        const next = saveSection5Config({ abroadDefault: modalS5AbroadSel.value });
        if (typeof autoFillSection5Defaults === 'function') {
          autoFillSection5Defaults({ force: true, overrides: { abroadMale: next.abroadDefault, abroadFemale: next.abroadDefault, abroadTrans: next.abroadDefault } });
        }
        showToast(`✅ স্টেপ ৫ প্রবাসী ডিফল্ট "${next.abroadDefault}" সেভ হয়েছে!`);
      });
    }
    if (modalS5AutoCb) {
      modalS5AutoCb.addEventListener('change', () => {
        saveSection5Config({ autoFill: modalS5AutoCb.checked });
        if (modalS5AutoCb.checked && typeof autoFillSection5Defaults === 'function') autoFillSection5Defaults();
      });
    }
    if (modalS5JumpBtn) {
      modalS5JumpBtn.addEventListener('click', () => {
        closeScannerModal();
        if (typeof jumpToPortalSection === 'function') jumpToPortalSection('3');
      });
    }
    if (modalS5ApplyBtn) {
      modalS5ApplyBtn.addEventListener('click', async () => {
        const s5Panel = document.querySelector('[data-family-card-tab="3"]');
        if (s5Panel && !isPanelActiveVisible(s5Panel) && typeof jumpToPortalSection === 'function') {
          closeScannerModal();
          jumpToPortalSection('3');
          await new Promise(r => setTimeout(r, 150));
        }
        if (typeof autoFillSection5Defaults === 'function') {
          const res = await autoFillSection5Defaults({ force: true });
          updateModalSection5Controls();
          showToast(res && res.panel ? '✅ স্টেপ ৫-এ ডিফল্ট মান বসানো হয়েছে!' : 'ℹ️ স্টেপ ৫ প্যানেল খুললে অটো-ফিল হবে।');
        }
      });
    }

    closeBtn.addEventListener('click', closeScannerModal);
    const hdrChatBtn = document.getElementById('fc-modal-hdr-chat');
    if (hdrChatBtn) {
      hdrChatBtn.addEventListener('click', () => {
        closeScannerModal();
        openChatModal();
      });
    }
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeScannerModal();
    });

    btnCamera.addEventListener('click', async () => {
      try {
        if (activeMediaStream) stopLiveCamera();
        const candidates = [
          { video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } }, audio: false },
          { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
          { video: { facingMode: 'environment' }, audio: false },
          { video: true, audio: false }
        ];
        let stream = null;
        for (const c of candidates) {
          try {
            stream = await navigator.mediaDevices.getUserMedia(c);
            if (stream) break;
          } catch (_) {}
        }
        if (!stream) throw new Error('No camera stream available');
        activeMediaStream = stream;
        if (videoElem) videoElem.srcObject = activeMediaStream;
        applyModalDocumentFrameMode(window.__fcModalDocChoice, window.__fcModalFrameMode);
        if (viewFinder) viewFinder.style.display = 'flex';
        const previewWrap = document.getElementById('fc-modal-preview-wrap');
        if (previewWrap) previewWrap.style.display = 'none';
        btnCamera.style.display = 'none';
        if (btnSnap) btnSnap.style.display = 'flex';
      } catch (err) {
        console.warn('[FamilyCard Extension] WebRTC camera denied/unavailable, falling back to file input:', err);
        fileInput.click();
      }
    });

    function captureCroppedModalCameraFrame(videoEl, frameEl, frameMode = 'id', quality = 0.92) {
      const natW = videoEl.videoWidth;
      const natH = videoEl.videoHeight;
      if (!natW || !natH) return null;

      const vRect = videoEl.getBoundingClientRect();
      const fRect = frameEl ? frameEl.getBoundingClientRect() : null;
      let sx = 0, sy = 0, sw = natW, sh = natH;

      if (fRect && vRect.width > 0 && vRect.height > 0 && fRect.width > 0 && fRect.height > 0) {
        const scale = Math.max(vRect.width / natW, vRect.height / natH);
        const offsetX = (natW * scale - vRect.width) / 2;
        const offsetY = (natH * scale - vRect.height) / 2;
        sx = Math.round((fRect.left - vRect.left + offsetX) / scale);
        sy = Math.round((fRect.top - vRect.top + offsetY) / scale);
        sw = Math.round(fRect.width / scale);
        sh = Math.round(fRect.height / scale);
        sx = Math.max(0, Math.min(natW - 1, sx));
        sy = Math.max(0, Math.min(natH - 1, sy));
        sw = Math.max(1, Math.min(natW - sx, sw));
        sh = Math.max(1, Math.min(natH - sy, sh));
      }

      const maxDim = frameMode === 'a4' ? 2200 : 1800;
      const downScale = Math.min(1, maxDim / Math.max(sw, sh));
      const outW = Math.max(1, Math.round(sw * downScale));
      const outH = Math.max(1, Math.round(sh * downScale));

      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if ('filter' in ctx) ctx.filter = 'contrast(1.08) brightness(1.03)';
      ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, outW, outH);
      return canvas.toDataURL('image/jpeg', quality);
    }

    let currentCompressedBase64 = null;

    if (btnSnap) {
      btnSnap.addEventListener('click', () => {
        if (!videoElem || !videoElem.videoWidth) {
          alert('ক্যামেরা প্রস্তুত নয়, অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।');
          return;
        }
        currentCompressedBase64 = captureCroppedModalCameraFrame(videoElem, cropFrameElem, window.__fcModalFrameMode, 0.92);
        if (!currentCompressedBase64) return;
        stopLiveCamera();

        const previewWrap = document.getElementById('fc-modal-preview-wrap');
        const imgPreview = document.getElementById('fc-modal-img-preview');
        if (imgPreview) imgPreview.src = currentCompressedBase64;
        if (previewWrap) previewWrap.style.display = 'flex';
        btnCamera.textContent = '🔄 পুনরায় ছবি তুলুন';
        triggerModalOCR(currentCompressedBase64);
      });
    }

    if (btnGallery) {
      btnGallery.addEventListener('click', () => {
        stopLiveCamera();
        fileInput.click();
      });
    }

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const previewWrap = document.getElementById('fc-modal-preview-wrap');
      const imgPreview = document.getElementById('fc-modal-img-preview');

      try {
        const maxDim = window.__fcModalFrameMode === 'a4' ? 2200 : 1800;
        currentCompressedBase64 = await compressImageFile(file, maxDim, 0.92);
        imgPreview.src = currentCompressedBase64;
        previewWrap.style.display = 'flex';
        btnCamera.textContent = '🔄 পুনরায় ছবি তুলুন';
        triggerModalOCR(currentCompressedBase64);
      } catch (err) {
        alert('ছবি প্রসেস করতে ব্যর্থ: ' + err.message);
      } finally {
        fileInput.value = '';
      }
    });

    btnSubmit.addEventListener('click', () => {
      if (currentCompressedBase64) {
        triggerModalOCR(currentCompressedBase64);
      }
    });
  }

  function stopLiveCamera() {
    if (activeMediaStream) {
      activeMediaStream.getTracks().forEach(t => t.stop());
      activeMediaStream = null;
    }
    const vf = document.getElementById('fc-modal-viewfinder');
    const snap = document.getElementById('fc-modal-btn-snap');
    const cam = document.getElementById('fc-modal-btn-camera');
    if (vf) vf.style.display = 'none';
    if (snap) snap.style.display = 'none';
    if (cam) cam.style.display = 'flex';
  }

  function getSavedAddressConfig() {
    const rawList = safeJsonParse(localStorage.getItem('fc_village_list'), ['বসাকুষ্টিয়া', 'চর কলিমহর']);
    const seen = new Set();
    const villages = [];
    (Array.isArray(rawList) && rawList.length ? rawList : ['বসাকুষ্টিয়া', 'চর কলিমহর']).forEach((v) => {
      const clean = String(v || '').replace(/\s+/g, ' ').trim();
      if (clean && !seen.has(clean)) { seen.add(clean); villages.push(clean); }
    });
    if (villages.length === 0) villages.push('বসাকুষ্টিয়া');
    savedVillageList = villages;
    const rawDef = String(localStorage.getItem('fc_default_village') || '').trim();
    savedDefaultVillage = (rawDef && villages.includes(rawDef)) ? rawDef : villages[0];
    const rawPost = normalizeDigits(localStorage.getItem('fc_default_postcode') || '7721').replace(/[^0-9]/g, '');
    savedPostcode = rawPost || '7721';
    return { postcode: savedPostcode, village: savedDefaultVillage, villages: savedVillageList };
  }

  function saveAddressConfig({ postcode = null, village = null, addVillage = null, removeVillage = null } = {}) {
    const cfg = getSavedAddressConfig();
    let list = [...cfg.villages];
    let defV = cfg.village;
    let defP = cfg.postcode;

    if (postcode !== null && postcode !== undefined) {
      const cleanP = normalizeDigits(String(postcode)).replace(/[^0-9]/g, '').slice(0, 6);
      if (cleanP) defP = cleanP;
      localStorage.setItem('fc_default_postcode', defP);
    }
    if (addVillage) {
      const cleanV = String(addVillage).replace(/\s+/g, ' ').trim();
      if (cleanV) {
        if (!list.includes(cleanV)) list.push(cleanV);
        defV = cleanV;
        localStorage.setItem('fc_village_list', JSON.stringify(list));
        localStorage.setItem('fc_default_village', defV);
      }
    }
    if (removeVillage) {
      const cleanR = String(removeVillage).replace(/\s+/g, ' ').trim();
      if (list.length > 1) {
        list = list.filter(v => v !== cleanR);
        localStorage.setItem('fc_village_list', JSON.stringify(list));
        if (defV === cleanR) {
          defV = list[0];
          localStorage.setItem('fc_default_village', defV);
        }
      }
    }
    if (village !== null && village !== undefined) {
      const cleanSel = String(village).replace(/\s+/g, ' ').trim();
      if (cleanSel) {
        if (!list.includes(cleanSel)) {
          list.push(cleanSel);
          localStorage.setItem('fc_village_list', JSON.stringify(list));
        }
        defV = cleanSel;
        localStorage.setItem('fc_default_village', defV);
      }
    }
    savedVillageList = list;
    savedDefaultVillage = defV;
    savedPostcode = defP;
    updateModalVillageSelect();
    return { postcode: defP, village: defV, villages: list };
  }

  function updateModalVillageSelect() {
    const sel = document.getElementById('fc-modal-village');
    const inpPost = document.getElementById('fc-modal-postcode');
    const { postcode, village, villages } = getSavedAddressConfig();
    if (inpPost && inpPost.value !== postcode) inpPost.value = postcode;
    if (sel) {
      sel.innerHTML = villages.map(v => `<option value="${escapeHtml(v)}" ${v === village ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
    }
    const validPill = document.getElementById('fc-modal-addr-valid-pill');
    if (validPill) {
      const okPost = /^\d{4}$/.test(postcode);
      validPill.textContent = okPost
        ? `📮 ${toBnDigits(postcode)} ✅ • ${village}`
        : `⚠️ ৪ সংখ্যার পোস্ট কোড দিন`;
      validPill.style.color = okPost ? '#15803d' : '#b45309';
    }
    const chipsWrap = document.getElementById('fc-modal-village-chips');
    if (chipsWrap) {
      chipsWrap.innerHTML = villages.map((v) => {
        const isAct = v === village;
        const delBtn = villages.length > 1
          ? `<button type="button" class="fc-s4-vdel" data-modal-del-v="${escapeHtml(v)}" title="মুছুন">✕</button>`
          : '';
        return `<span class="fc-s4-vchip ${isAct ? 'active' : ''}" data-modal-pick-v="${escapeHtml(v)}">🏠 ${escapeHtml(v)}${delBtn}</span>`;
      }).join('');
    }
  }

  function getSavedSection5Config() {
    return {
      transCount: localStorage.getItem('fc_s5_default_trans') || '০',
      training: localStorage.getItem('fc_s5_default_training') || 'না',
      mfsAccount: localStorage.getItem('fc_s5_default_mfs') || 'নগদ',
      abroadDefault: localStorage.getItem('fc_s5_default_abroad') || '০',
      autoFill: localStorage.getItem('fc_s5_auto_fill') !== '0'
    };
  }

  function saveSection5Config(partial = {}) {
    if (partial.transCount !== undefined) localStorage.setItem('fc_s5_default_trans', String(partial.transCount).trim() || '০');
    if (partial.training !== undefined) localStorage.setItem('fc_s5_default_training', String(partial.training).trim() || 'না');
    if (partial.mfsAccount !== undefined) localStorage.setItem('fc_s5_default_mfs', String(partial.mfsAccount).trim() || 'নগদ');
    if (partial.abroadDefault !== undefined) localStorage.setItem('fc_s5_default_abroad', String(partial.abroadDefault).trim() || '০');
    if (partial.autoFill !== undefined) localStorage.setItem('fc_s5_auto_fill', partial.autoFill ? '1' : '0');
    const next = getSavedSection5Config();
    if (!partial._fromPopup && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({
        s5MfsAccount: next.mfsAccount,
        s5Training: next.training,
        s5TransCount: next.transCount,
        s5AbroadDefault: next.abroadDefault,
        s5AutoFill: next.autoFill
      });
    }
    if (typeof updateModalSection5Controls === 'function') updateModalSection5Controls();
    return next;
  }

  var sec5EngineReady = false;

  function updateModalSection5Controls() {
    const cfg = getSavedSection5Config();
    const mfsSel = document.getElementById('fc-modal-s5-mfs');
    const trSel = document.getElementById('fc-modal-s5-training');
    const transSel = document.getElementById('fc-modal-s5-trans');
    const abroadSel = document.getElementById('fc-modal-s5-abroad');
    const autoCb = document.getElementById('fc-modal-s5-autofill');
    const pill = document.getElementById('fc-modal-s5-pill');
    const liveEl = document.getElementById('fc-modal-s5-live');
    if (mfsSel && mfsSel.value !== cfg.mfsAccount) mfsSel.value = cfg.mfsAccount;
    if (trSel && trSel.value !== cfg.training) trSel.value = cfg.training;
    if (transSel && transSel.value !== cfg.transCount) transSel.value = cfg.transCount;
    if (abroadSel && abroadSel.value !== cfg.abroadDefault) abroadSel.value = cfg.abroadDefault;
    if (autoCb) autoCb.checked = cfg.autoFill;
    if (pill) pill.textContent = `${cfg.mfsAccount} • প্রশিক্ষণ: ${cfg.training}`;
    if (liveEl && sec5EngineReady && typeof inspectSection5Details === 'function') {
      const s5 = inspectSection5Details();
      const d = s5.data;
      if (s5.hasDom || d) {
        const tot = d ? d.totalCount : 0;
        const abr = s5.abroadTotal || 0;
        liveEl.textContent = `লাইভ স্টেপ ৫ (${toBnDigits(s5.filledCount)}/${toBnDigits(s5.totalRequired)}): পু ${toBnDigits(d?.maleCount || 0)}, না ${toBnDigits(d?.femaleCount || 0)}, হি ${toBnDigits(d?.transCount || 0)} (মোট ${toBnDigits(tot)}) • ${d?.mfsAccount || cfg.mfsAccount} • প্রবাসী ${toBnDigits(abr)}`;
        liveEl.style.color = s5.allValid ? '#166534' : '#92400e';
      }
    }
  }

  function updateMemberSelectDropdown() {
    const sel = document.getElementById('fc-modal-member-select');
    if (!sel) return;

    const cards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
    let html = '<option value="auto">পরবর্তী খালি সদস্য কার্ড</option>';

    cards.forEach((card, idx) => {
      const isSelf = card.classList.contains('fm-member-card--self') || (card.textContent.includes('সদস্য - ১') && card.textContent.includes('নিজ'));
      if (isSelf) return;

      const nameVal = card.querySelector('input:not([disabled])')?.value || '';
      const label = `সদস্য - ${toBnDigits(idx + 1)}${nameVal ? ' (' + nameVal + ')' : ' (খালি)'}`;
      html += `<option value="${idx + 1}">${escapeHtml(label)}</option>`;
    });

    html += '<option value="new">➕ নতুন সদস্য কার্ড যোগ করে ফিল করুন</option>';
    sel.innerHTML = html;
  }

  function setScanTarget(target, memberCard = null, memberIdx = null) {
    activeScanTarget.type = target;
    activeScanTarget.card = memberCard;
    activeScanTarget.index = memberIdx || 'auto';

    const btnSelf = document.getElementById('fc-modal-target-self-btn');
    const btnMember = document.getElementById('fc-modal-target-member-btn');
    const memberSettings = document.getElementById('fc-modal-member-settings');
    const applicantSettings = document.getElementById('fc-modal-applicant-settings');
    const memberBadge = document.getElementById('fc-modal-member-badge');

    if (!btnSelf || !btnMember) return;

    if (target === 'member') {
      btnSelf.style.background = '#e2e8f0';
      btnSelf.style.color = '#334155';
      btnMember.style.background = '#0d9488';
      btnMember.style.color = '#fff';

      if (memberSettings) memberSettings.style.display = 'flex';
      if (applicantSettings) applicantSettings.style.display = 'none';

      updateMemberSelectDropdown();
      if (memberIdx && memberIdx !== 'auto') {
        const sel = document.getElementById('fc-modal-member-select');
        if (sel) sel.value = String(memberIdx);
        if (memberBadge) {
          memberBadge.textContent = memberIdx === 'new' ? 'টার্গেট: নতুন সদস্য' : `সদস্য - ${toBnDigits(memberIdx)} নির্দিষ্ট`;
        }
      } else if (memberBadge) {
        memberBadge.textContent = 'পরবর্তী খালি সদস্য কার্ড';
      }
    } else {
      btnSelf.style.background = '#0284c7';
      btnSelf.style.color = '#fff';
      btnMember.style.background = '#e2e8f0';
      btnMember.style.color = '#334155';

      if (memberSettings) memberSettings.style.display = 'none';
      if (applicantSettings) applicantSettings.style.display = 'flex';
    }
  }

  function openScannerModal() {
    const modal = document.getElementById('fc-scanner-modal');
    if (modal) {
      updateModalVillageSelect();
      if (activeScanTarget.type === 'member') {
        updateMemberSelectDropdown();
      }
      modal.style.display = 'flex';
    }
  }

  function closeScannerModal() {
    stopLiveCamera();
    const modal = document.getElementById('fc-scanner-modal');
    if (modal) modal.style.display = 'none';
  }

  function getRadioOptionLabelText(radioWrap) {
    if (!radioWrap) return '';
    const lbl = radioWrap.querySelector('label');
    return normalizeBn((lbl ? lbl.textContent : radioWrap.textContent) || '');
  }

  function getSelectedRadioText(container) {
    if (!container) return '';
    const radios = Array.from(container.querySelectorAll('.v-radio'));
    const active = radios.find(isRadioSelected);
    return active ? getRadioOptionLabelText(active) : '';
  }

  function matchesBnCandidate(actualText, candidates) {
    const actual = normalizeBn(actualText);
    if (!actual || !Array.isArray(candidates)) return false;
    return candidates.some((cand) => {
      const c = normalizeBn(cand);
      if (!c) return false;
      if (actual === c) return true;
      if (c === 'হ্যা' || c === 'হ্যাঁ') return actual === 'হ্যা' || actual === 'হ্যাঁ' || /^হ্যাঁ?(?:\s|\(|,|$)/.test(actual);
      if (c === 'না') return actual === 'না' || /^না(?:\s|\(|,|$)/.test(actual);
      return actual.includes(c);
    });
  }

  async function selectVuetifyRadio(container, candidates, opts = {}) {
    if (!container || !Array.isArray(candidates) || candidates.length === 0) return false;
    const radios = Array.from(container.querySelectorAll('.v-radio'));
    if (radios.length === 0) return false;

    const curText = getSelectedRadioText(container);
    if (curText && matchesBnCandidate(curText, candidates)) {
      container.dataset.fcS8DefaultApplied = 'true';
      return false;
    }
    if (curText && !opts.force) {
      return false;
    }

    const target = radios.find(r => matchesBnCandidate(getRadioOptionLabelText(r), candidates));
    if (!target) return false;

    const inp = target.querySelector('input[type="radio"]');
    const lbl = target.querySelector('label');
    if (inp) inp.click();
    else if (lbl) lbl.click();
    else target.click();

    container.dataset.fcS8DefaultApplied = 'true';
    await new Promise(r => setTimeout(r, 35));
    return true;
  }

  function getFieldQuestionText(scopeEl) {
    if (!scopeEl) return '';
    const labels = Array.from(scopeEl.querySelectorAll('label')).filter(l => !l.closest('.v-radio, .v-checkbox'));
    const joined = labels.map(l => normalizeBn(l.textContent || '')).filter(Boolean).join(' ');
    if (joined) return joined;

    const rg = scopeEl.matches('[role="radiogroup"]') ? scopeEl : scopeEl.querySelector('[role="radiogroup"], .v-input--radio-group__input');
    if (rg) {
      let raw = '';
      for (const ch of Array.from(rg.children || [])) {
        if (!ch.classList?.contains('v-radio') && !ch.querySelector?.('.v-radio')) {
          raw += ' ' + (ch.textContent || '');
        }
      }
      const fallback = normalizeBn(raw || (rg.textContent || '').split(/\b(?:হ্যাঁ?|না)\b/)[0] || '');
      if (fallback) return fallback;
    }
    return '';
  }

  function findMemberFieldControl(card, matcher) {
    if (!card) return null;
    const cols = Array.from(card.querySelectorAll('.col, [class*="col-"], .v-input--radio-group'));
    const seenCols = new Set();
    for (const rawCol of cols) {
      const col = rawCol.classList?.contains('v-input--radio-group')
        ? (rawCol.closest('.col, [class*="col-"]') || rawCol)
        : rawCol;
      if (seenCols.has(col)) continue;
      seenCols.add(col);
      if (col.closest('.fc-pmt-multi-grid')) continue;
      const qText = getFieldQuestionText(col);
      if (!qText || !matcher(qText)) continue;
      const hasRadio = Boolean(col.querySelector('.v-radio') || col.querySelector('[role="radiogroup"]'));
      const hasSelect = Boolean(col.querySelector('.v-select'));
      const plainInp = Array.from(col.querySelectorAll('input, textarea')).find(isFillableTextInput) || null;
      return {
        kind: hasRadio ? 'radio' : (hasSelect ? 'select' : (plainInp ? 'input' : 'unknown')),
        col,
        questionText: qText,
        input: plainInp
      };
    }
    return null;
  }

  function readMemberControlValue(ctrl) {
    if (!ctrl || !ctrl.col) return '';
    if (ctrl.kind === 'radio') return getSelectedRadioText(ctrl.col);
    if (ctrl.kind === 'select') {
      return normalizeBn(ctrl.col.querySelector('.v-select__selection')?.textContent || ctrl.input?.value || '');
    }
    return normalizeBn(ctrl.input?.value || '');
  }

  function attachMemberFieldUserGuard(col) {
    if (!col || col.__fcS8GuardAttached) return;
    col.__fcS8GuardAttached = true;
    const mark = (e) => {
      if (e && e.isTrusted) col.dataset.fcS8UserEdited = 'true';
    };
    col.addEventListener('mousedown', mark, true);
    col.addEventListener('change', mark, true);
  }

  async function applyMemberControlDefault(ctrl, candidates, opts = {}) {
    if (!ctrl || !ctrl.col || !candidates || candidates.length === 0) return false;
    attachMemberFieldUserGuard(ctrl.col);
    if (!opts.ignoreUserGuard && ctrl.col.dataset.fcS8UserEdited === 'true') return false;

    const curVal = readMemberControlValue(ctrl);
    const alreadyOk = curVal && candidates.some(c => normalizeBn(curVal) === normalizeBn(c) || normOptionText(curVal) === normOptionText(c) || matchesBnCandidate(curVal, [c]));
    if (alreadyOk) {
      ctrl.col.dataset.fcS8DefaultApplied = 'true';
      return false;
    }
    if (curVal && !opts.force) {
      return false;
    }

    if (ctrl.kind === 'radio') {
      return selectVuetifyRadio(ctrl.col, candidates, opts);
    }
    if (ctrl.kind === 'select') {
      if (curVal && opts.force) {
        const clearBtn = ctrl.col.querySelector('.v-input__icon--clear button, .v-input__icon--clear .v-icon');
        if (clearBtn) clearBtn.click();
        else {
          const selEl = ctrl.col.querySelector('.v-select__selection');
          if (selEl) selEl.textContent = '';
        }
      }
      return selectSingleVuetifyOption(ctrl.col, candidates, { tagAttr: 'fcS8DefaultApplied' });
    }
    if (ctrl.kind === 'input' && ctrl.input) {
      const changed = setReactiveValue(ctrl.input, candidates[0], { ignoreUserGuard: opts.force });
      if (changed) ctrl.col.dataset.fcS8DefaultApplied = 'true';
      return changed;
    }
    return false;
  }

  function computeExactAgeFromDob(dobStr, fallbackAgeText = '') {
    const cleanDob = normalizeDigits(dobStr || '').trim();
    let day = null, month = null, year = null;
    let m = cleanDob.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
    if (m) {
      day = parseInt(m[1], 10);
      month = parseInt(m[2], 10);
      year = parseInt(m[3], 10);
    } else {
      m = cleanDob.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
      if (m) {
        year = parseInt(m[1], 10);
        month = parseInt(m[2], 10);
        day = parseInt(m[3], 10);
      } else {
        m = cleanDob.match(/\b(19\d{2}|20\d{2})\b/);
        if (m) year = parseInt(m[1], 10);
      }
    }
    if (year && year >= 1900 && year <= new Date().getFullYear()) {
      const now = new Date();
      let age = now.getFullYear() - year;
      if (month && day) {
        const nowM = now.getMonth() + 1;
        const nowD = now.getDate();
        if (nowM < month || (nowM === month && nowD < day)) age--;
      }
      return Math.max(0, age);
    }
    const cleanAge = normalizeDigits(fallbackAgeText || '').replace(/[^0-9]/g, '');
    if (cleanAge) {
      const parsed = parseInt(cleanAge, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 130) return parsed;
    }
    return null;
  }

  function getApplicantProfileSignals() {
    const tab0 = document.querySelector('[data-family-card-tab="0"]');
    const tab1 = document.querySelector('[data-family-card-tab="1"]');
    let gender = normalizeBn(lastExtractedData?.gender || '');
    if (!gender) {
      const gSel = [tab0, tab1].map(sc => findLabelVal(sc, ['লিঙ্গ'])).find(Boolean);
      if (gSel) gender = normalizeBn(gSel);
    }
    let dob = standardizeDate(lastExtractedData?.dob || '');
    if (!dob) {
      const dVal = [tab0, tab1].map(sc => findLabelVal(sc, ['জন্ম তারিখ'])).find(Boolean);
      if (dVal) dob = standardizeDate(dVal);
    }
    const ageText = [tab1, tab0].map(sc => findLabelVal(sc, ['বয়স', 'বয়স'])).find(Boolean) || '';
    return { gender, dob, ageText };
  }

  function getMemberCardSignals(card, applicantSignals = null) {
    const isSelf = card.classList.contains('fm-member-card--self') || (card.textContent.includes('সদস্য - ১') && card.textContent.includes('নিজ'));
    const app = applicantSignals || getApplicantProfileSignals();

    const genderCtrl = findMemberFieldControl(card, lbl => lbl.includes('লিঙ্গ'));
    const relCtrl = findMemberFieldControl(card, lbl => lbl.includes('সম্পর্ক'));
    const dobCtrl = findMemberFieldControl(card, lbl => lbl.includes('জন্ম তারিখ'));
    const ageCtrl = findMemberFieldControl(card, lbl => lbl.includes('বয়স') || lbl.includes('বয়স'));
    const occCtrl = findMemberFieldControl(card, lbl => lbl.includes('জীবিকা') || lbl.includes('পেশা'));
    const curStuCtrl = findMemberFieldControl(card, lbl => lbl.includes('বর্তমানে শিক্ষার্থী'));
    const disCtrl = findMemberFieldControl(card, lbl => lbl.includes('প্রতিবন্ধী') || lbl.includes('প্রতিবন্ধিতা'));
    const govCardCtrl = findMemberFieldControl(card, lbl => lbl.includes('সরকারি কার্ডের ধরণ') || lbl.includes('সরকারি কার্ডের ধরন') || lbl.includes('কার্ডের ধরণ') || lbl.includes('কার্ডের ধরন'));
    const safetyCtrl = findMemberFieldControl(card, lbl => lbl.includes('সামাজিক নিরাপত্তা কর্মসূচি') || lbl.includes('নিরাপত্তা কর্মসূচির আওতাভুক্ত'));

    let gender = readMemberControlValue(genderCtrl);
    if (!gender && isSelf) gender = app.gender || '';
    const rel = isSelf ? 'নিজ' : readMemberControlValue(relCtrl);
    if (!gender && rel) {
      if (['স্ত্রী', 'কন্যা', 'মেয়ে', 'মাতা', 'মা', 'বোন', 'দাদী', 'নানী', 'নাতনি', 'শাশুড়ি'].some(k => rel.includes(normalizeBn(k)))) {
        gender = 'নারী';
      }
    }
    const isFemale = Boolean(gender && (gender.includes('নারী') || gender.includes('মহিলা')));

    const dobRaw = readMemberControlValue(dobCtrl) || (isSelf ? app.dob : '');
    const ageRaw = readMemberControlValue(ageCtrl) || (isSelf ? app.ageText : '');
    const age = computeExactAgeFromDob(dobRaw, ageRaw);

    const occVal = readMemberControlValue(occCtrl);
    const curStuVal = readMemberControlValue(curStuCtrl);
    const disVal = readMemberControlValue(disCtrl);
    const govCardVal = readMemberControlValue(govCardCtrl);
    const safetyVal = readMemberControlValue(safetyCtrl);

    const isStudent = Boolean(
      (curStuVal && curStuVal.startsWith('হ্যা')) ||
      (occVal && (occVal.includes('ছাত্র') || occVal.includes('শিক্ষার্থী'))) ||
      (govCardVal && govCardVal.includes('উপবৃত্তি'))
    );
    const isDisabled = Boolean(disVal && disVal !== 'না' && !disVal.includes('প্রতিবন্ধী নন') && !disVal.includes('নাই'));
    const isElderly = age !== null && age >= 60;

    return {
      isSelf,
      gender,
      isFemale,
      rel,
      dob: dobRaw,
      age,
      occVal,
      curStuVal,
      disVal,
      govCardVal,
      safetyVal,
      isStudent,
      isDisabled,
      isElderly
    };
  }

  let lastSec8Serialized = '';
  let isFillingSection8 = false;
  let lastSec8FillTs = 0;
  let activeSec8Promise = null;

  function trackSection8Data() {
    const familyKey = scrapeFamilyId() || 'default';
    const rawCache = safeJsonParse(localStorage.getItem('fc_section8_data'), null);
    const cached = (rawCache && rawCache._familyKey === familyKey) ? rawCache : null;

    const cards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
    if (cards.length === 0) return cached;

    const app = getApplicantProfileSignals();
    let studentCount = 0;
    let disabledCount = 0;
    let elderlyCount = 0;
    let childCount = 0;
    let womenOver18Count = 0;
    const memberSignals = cards.map((card, idx) => {
      const sig = getMemberCardSignals(card, app);
      if (sig.isStudent) studentCount++;
      if (sig.isDisabled) disabledCount++;
      if (sig.isElderly) elderlyCount++;
      if (sig.age !== null && sig.age < 18) childCount++;
      if (sig.isFemale && sig.age !== null && sig.age > 18) womenOver18Count++;
      return { index: idx + 1, isSelf: sig.isSelf, age: sig.age, gender: sig.gender, isStudent: sig.isStudent, isDisabled: sig.isDisabled, occVal: sig.occVal };
    });

    const data = {
      _familyKey: familyKey,
      hasSec8Data: true,
      memberCount: cards.length,
      studentCount,
      hasStudent: studentCount > 0,
      disabledCount,
      elderlyCount,
      childCount,
      womenOver18Count,
      members: memberSignals
    };

    const serialized = JSON.stringify(data);
    if (serialized !== lastSec8Serialized) {
      lastSec8Serialized = serialized;
      localStorage.setItem('fc_section8_data', serialized);
    }
    return data;
  }

  // --- SECTION 8: FAMILY MEMBER AUTOMATION HELPERS ---
  function openMemberScanner(card = null, index = 'auto') {
    setScanTarget('member', card, index);
    openScannerModal();
  }

  function triggerPortalAddMember() {
    const tab6 = document.querySelector('[data-family-card-tab="6"]') || document.querySelector('.fm-members-stack')?.parentElement;
    if (!tab6) return false;
    const buttons = Array.from(tab6.querySelectorAll('button'));
    const addBtn = buttons.find(b => {
      const t = b.textContent || '';
      return t.includes('নতুন সদস্য') || t.includes('সদস্য যোগ') || t.includes('যোগ করুন') || b.querySelector('.mdi-plus');
    });
    if (addBtn) {
      addBtn.click();
      showToast('➕ নতুন সদস্য কার্ড যোগ করা হয়েছে!');
      setTimeout(() => {
        injectMemberCardButtons();
        updateMemberSelectDropdown();
      }, 350);
      return true;
    }
    showToast('⚠️ পোর্টালের "নতুন সদস্য" বাটন পাওয়া যায়নি, অনুগ্রহ করে ম্যানুয়ালি চাপুন।');
    return false;
  }

  async function fillMemberCard(card, data) {
    if (!card || !data) return;

    const { docType, docNumber } = resolveDocNumberAndType(data);
    const isBirthReg = docType === 'birth_certificate';

    // 1. Verification Type Radio (NID vs Birth Certificate) — scoped strictly to .v-radio
    await ensureVerificationRadio(card, isBirthReg);

    function findCardInput(keywords) {
      return findInputByLabelText(keywords, card);
    }

    async function selectCardDropdown(keywords, candidates) {
      const normKeys = keywords.map(k => normalizeBn(k));
      const labels = Array.from(card.querySelectorAll('label'));
      let container = null;
      for (const label of labels) {
        if (label.closest('.v-radio, .v-checkbox, .v-input--selection-controls, [role="radiogroup"]')) continue;
        const text = normalizeBn(label.textContent || '');
        if (normKeys.some(k => text.includes(k))) {
          container = label.closest('.col, [class*="col-"], .v-input') || label.parentElement;
          break;
        }
      }
      if (!container) return;
      await selectSingleVuetifyOption(container, candidates);
    }

    // 2. Identification number (poll briefly if Vuetify swaps field after radio switch)
    if (docNumber) {
      const numKeys = isBirthReg
        ? ['জন্ম নিবন্ধন নম্বর', 'নিবন্ধন নম্বর', 'জন্ম নিবন্ধন']
        : ['জাতীয় পরিচিতি নম্বর', 'জাতীয় পরিচিতি নম্বর', 'এনআইডি', 'পরিচিতি নম্বর'];
      let idInp = findCardInput(numKeys);
      for (let t = 0; !idInp && t < 5; t++) {
        await new Promise(r => setTimeout(r, 100));
        idInp = findCardInput(numKeys);
      }
      if (idInp) setReactiveValue(idInp, docNumber);
    }

    // 3. Date of birth
    if (data.dob) {
      const dobInp = findCardInput(['জন্ম তারিখ']);
      if (dobInp) setReactiveValue(dobInp, data.dob);
    }

    // 4. Name Bangla
    if (data.name_bn) {
      const bnInp = findCardInput(['নাম বাংলায়', 'নাম বাংলায়', 'নাম (বাংলা)']);
      if (bnInp) setReactiveValue(bnInp, data.name_bn);
    }

    // 5. Name English
    if (data.name_en) {
      const enInp = findCardInput(['নাম ইংরেজিতে', 'নাম (ইংরেজি)']);
      if (enInp) setReactiveValue(enInp, data.name_en.toUpperCase());
    }

    // 6. Relationship with Household Head
    const rel = data.relationship || data.relation_suggestion || '';
    if (rel) {
      await selectCardDropdown(['সম্পর্ক'], [rel]);
    }

    // 7. Father's Name Bangla & English
    if (data.father_name_bn) {
      const fbn = findCardInput(['পিতার নাম (বাংলা)', 'পিতার নাম বাংলায়']);
      if (fbn) setReactiveValue(fbn, data.father_name_bn);
    }
    if (data.father_name_en) {
      const fen = findCardInput(['পিতার নাম (ইংরেজি)', 'পিতার নাম ইংরেজিতে']);
      if (fen) setReactiveValue(fen, data.father_name_en.toUpperCase());
    }

    // 8. Mother's Name Bangla & English
    if (data.mother_name_bn) {
      const mbn = findCardInput(['মাতার নাম (বাংলা)', 'মাতার নাম বাংলায়']);
      if (mbn) setReactiveValue(mbn, data.mother_name_bn);
    }
    if (data.mother_name_en) {
      const men = findCardInput(['মাতার নাম (ইংরেজি)', 'মাতার নাম ইংরেজিতে']);
      if (men) setReactiveValue(men, data.mother_name_en.toUpperCase());
    }

    // 9. Gender
    const cardAge = computeExactAgeFromDob(data.dob || '');
    if (data.gender) {
      await selectCardDropdown(['লিঙ্গ'], [data.gender]);
    }

    // 10. Marital Status (unmarried if age <= 18 unless explicitly set)
    const defaultMarital = (cardAge !== null && cardAge <= 18) ? 'অবিবাহিত' : 'বিবাহিত';
    const marital = data.marital_status || data.marital_status_suggestion || defaultMarital;
    await selectCardDropdown(['বৈবাহিক অবস্থা'], [marital]);

    // 11. Religion (Default: ইসলাম)
    const religion = data.religion || 'ইসলাম';
    await selectCardDropdown(['ধর্ম'], [religion]);

    // 12. Apply full Section 8 smart defaults & conditional rules
    await applyMemberSmartDefaults(card, { force: true, extraGender: data.gender || '', extraDob: data.dob || '' });

    card.dataset.fcMemberAutoFilled = 'true';
    trackSection8Data();
    return true;
  }

  function injectMemberCardButtons() {
    const cards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
    cards.forEach((card, idx) => {
      const isSelf = card.classList.contains('fm-member-card--self') || (card.textContent.includes('সদস্য - ১') && card.textContent.includes('নিজ'));
      if (isSelf) return;

      const header = card.querySelector('.fm-member-header') || card.firstElementChild;
      if (!header || header.querySelector('.fc-card-scan-btn')) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fc-card-scan-btn';
      btn.style.cssText = 'margin-left: auto; padding: 4px 10px; background: linear-gradient(135deg, #0d9488, #0f766e); color: #fff; font-weight: 700; border: none; border-radius: 6px; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);';
      btn.innerHTML = '<span>📸 NID / জন্ম নিবন্ধন স্ক্যান</span>';
      btn.onclick = (e) => {
        e.stopPropagation();
        openMemberScanner(card, idx + 1);
      };
      header.appendChild(btn);
    });
  }

  async function applyMemberSmartDefaults(card, opts = {}) {
    if (!card) return 0;
    const force = Boolean(opts && opts.force);
    let filled = 0;

    const app = getApplicantProfileSignals();
    if (opts.extraGender) app.gender = normalizeBn(opts.extraGender);
    if (opts.extraDob) app.dob = standardizeDate(opts.extraDob);
    const sig = getMemberCardSignals(card, app);
    const isUnderEq18 = sig.age !== null && sig.age <= 18;
    const isWomanOver18 = sig.isFemale && sig.age !== null && sig.age > 18;

    // 1. Religion (only non-self if empty; self inherits Step 2)
    if (!sig.isSelf) {
      const relCtrl = findMemberFieldControl(card, lbl => lbl.includes('ধর্ম'));
      if (relCtrl && !readMemberControlValue(relCtrl)) {
        if (await applyMemberControlDefault(relCtrl, ['ইসলাম'], { force })) filled++;
      }
    }

    // 2. "সদস্য প্রতিবন্ধী কিনা" -> Default "না"
    const disCtrl = findMemberFieldControl(card, lbl => lbl.includes('সদস্য প্রতিবন্ধী') || lbl.includes('প্রতিবন্ধী') || lbl.includes('প্রতিবন্ধিতা'));
    if (disCtrl) {
      const cur = readMemberControlValue(disCtrl);
      if (!cur || (force && disCtrl.col.dataset.fcS8UserEdited !== 'true')) {
        if (await applyMemberControlDefault(disCtrl, ['না', 'প্রতিবন্ধী নন'], { force: !cur || force })) filled++;
      }
    }

    // 3. "স্বাস্থ্য অবস্থা/কর্মক্ষমতা*" -> Default "কর্মক্ষম"
    const healthCtrl = findMemberFieldControl(card, lbl => lbl.includes('স্বাস্থ্য অবস্থা') || lbl.includes('কর্মক্ষমতা'));
    if (healthCtrl) {
      if (await applyMemberControlDefault(healthCtrl, ['কর্মক্ষম'], { force })) filled++;
    }

    // 4. "সরকারি চাকুরিজীবী/MPO ভুক্ত শিক্ষক কি-না*" -> Radio Default "না"
    const govEmpCtrl = findMemberFieldControl(card, lbl =>
      lbl.includes('সরকারি চাকুরিজীবী') || lbl.includes('mpo') || lbl.includes('এমপিও') || lbl.includes('শিক্ষক কি')
    );
    if (govEmpCtrl) {
      if (await applyMemberControlDefault(govEmpCtrl, ['না'], { force })) filled++;
    }

    // 5. "সামাজিক নিরাপত্তা কর্মসূচির আওতাভুক্ত?*" -> Radio Default "হ্যা"
    const safetyCtrl = findMemberFieldControl(card, lbl =>
      lbl.includes('সামাজিক নিরাপত্তা কর্মসূচি') || lbl.includes('নিরাপত্তা কর্মসূচির আওতাভুক্ত')
    );
    if (safetyCtrl) {
      if (await applyMemberControlDefault(safetyCtrl, ['হ্যা', 'হ্যাঁ'], { force })) filled++;
    }

    // 6. "সমাজসেবা অধিদপ্তর থেকে কোনো প্রশিক্ষণ বা আর্থিক সুবিধা গ্রহণ করেছেন কি?*" -> Radio Default "না"
    const dssTrainCtrl = findMemberFieldControl(card, lbl =>
      (lbl.includes('সমাজসেবা অধিদপ্তর') && (lbl.includes('প্রশিক্ষণ') || lbl.includes('আর্থিক সুবিধা'))) ||
      lbl.includes('প্রশিক্ষণ বা আর্থিক সুবিধা গ্রহণ')
    );
    if (dssTrainCtrl) {
      if (await applyMemberControlDefault(dssTrainCtrl, ['না'], { force })) filled++;
    }

    // 7. Age <= 18 -> "বৈবাহিক অবস্থা*" = "অবিবাহিত" & "জীবিকা/পেশা*" = "ছাত্র/ছাত্রী"
    const maritalCtrl = findMemberFieldControl(card, lbl => lbl.includes('বৈবাহিক অবস্থা'));
    const occCtrl = findMemberFieldControl(card, lbl => lbl.includes('জীবিকা') || lbl.includes('পেশা'));

    if (isUnderEq18) {
      if (maritalCtrl) {
        const curMar = readMemberControlValue(maritalCtrl);
        const allowAgeMaritalOverride = !curMar || (curMar === 'বিবাহিত' && maritalCtrl.col.dataset.fcS8UserEdited !== 'true' && maritalCtrl.col.dataset.fcS8Under18Applied !== 'true');
        if (allowAgeMaritalOverride || force) {
          if (await applyMemberControlDefault(maritalCtrl, ['অবিবাহিত'], { force: true })) {
            maritalCtrl.col.dataset.fcS8Under18Applied = 'true';
            filled++;
          }
        }
      }
      if (occCtrl) {
        const curOcc = readMemberControlValue(occCtrl);
        const allowUnder18Occ = !curOcc || (occCtrl.col.dataset.fcS8UserEdited !== 'true' && occCtrl.col.dataset.fcS8Under18Occ !== 'true');
        if ((allowUnder18Occ || force) && (!curOcc || !curOcc.includes('ছাত্র'))) {
          if (await applyMemberControlDefault(occCtrl, ['ছাত্র/ছাত্রী', 'শিক্ষার্থী', 'ছাত্র', 'ছাত্রী'], { force: true })) {
            occCtrl.col.dataset.fcS8Under18Occ = 'true';
            filled++;
          }
        }
      }
    } else if (isWomanOver18) {
      // Women > 18 -> "জীবিকা/পেশা*" = "গৃহিণী"
      if (occCtrl) {
        const curOcc = readMemberControlValue(occCtrl);
        if (!curOcc) {
          if (await applyMemberControlDefault(occCtrl, ['গৃহিণী', 'গৃহিনী', 'গৃহস্থালি'], { force })) filled++;
        }
      }
    }

    // 8. If "বর্তমানে শিক্ষার্থী? (৩–৩৪ বছর)*" is "হ্যা" -> "পড়তে লিখতে পারেন*" = "পড়তে ও লিখতে পারেন"
    const curStuCtrl = findMemberFieldControl(card, lbl => lbl.includes('বর্তমানে শিক্ষার্থী'));
    const curStuVal = readMemberControlValue(curStuCtrl);
    if (curStuCtrl) attachMemberFieldUserGuard(curStuCtrl.col);
    if (curStuVal && curStuVal.startsWith('হ্যা')) {
      const literacyCtrl = findMemberFieldControl(card, lbl =>
        lbl.includes(normalizeBn('পড়তে লিখতে পারেন')) || lbl.includes(normalizeBn('পড়তে ও লিখতে')) || lbl.includes('সাক্ষরতা')
      );
      if (literacyCtrl) {
        if (await applyMemberControlDefault(literacyCtrl, ['পড়তে ও লিখতে পারেন', 'পড়তে ও লিখতে পারেন'], { force })) filled++;
      }
    }

    // 9. If "জীবিকা/পেশা*" is "ছাত্র/ছাত্রী" -> "সরকারি কার্ডের ধরণ*" = "উপবৃত্তি কার্ড (শিক্ষা)"
    const latestOcc = occCtrl ? readMemberControlValue(occCtrl) : '';
    if (latestOcc && (latestOcc.includes('ছাত্র/ছাত্রী') || latestOcc === 'ছাত্র' || latestOcc === 'ছাত্রী' || latestOcc.includes('শিক্ষার্থী'))) {
      const govCardCtrl = findMemberFieldControl(card, lbl =>
        lbl.includes('সরকারি কার্ডের ধরণ') || lbl.includes('সরকারি কার্ডের ধরন') || lbl.includes('কার্ডের ধরণ') || lbl.includes('কার্ডের ধরন')
      );
      if (govCardCtrl) {
        if (await applyMemberControlDefault(govCardCtrl, ['উপবৃত্তি কার্ড (শিক্ষা)', 'উপবৃত্তি কার্ড'], { force })) filled++;
      }
    }

    return filled;
  }

  async function applySmartDefaultsToAllMembers(opts = {}) {
    const force = opts && opts.force !== undefined ? Boolean(opts.force) : false;
    const cards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
    let count = 0;
    for (const card of cards) {
      count += await applyMemberSmartDefaults(card, { force });
    }
    const sec8 = trackSection8Data();
    if (typeof handleSection9MoneyUsage === 'function') handleSection9MoneyUsage(false);
    if (!opts || opts.silent !== true) {
      showToast(`⚡ ${toBnDigits(count)}টি সদস্য ফিল্ডে স্মার্ট ডিফল্ট প্রয়োগ করা হয়েছে!${sec8 ? ` (শিক্ষার্থী: ${toBnDigits(sec8.studentCount)} জন)` : ''}`);
    }
    return count;
  }

  async function handleSection8Members(opts = {}) {
    const force = Boolean(opts && opts.force);
    const tab6 = document.querySelector('[data-family-card-tab="6"]') ||
                 Array.from(document.querySelectorAll('.v-expansion-panel')).find(p => normalizeBn(p.textContent).includes('পারিবারিক তথ্য'));
    const sec8Data = trackSection8Data();
    if (!tab6 || !isPanelActiveVisible(tab6)) return sec8Data;

    if (isFillingSection8) {
      if (force && activeSec8Promise) {
        try { await activeSec8Promise; } catch (_) {}
        return handleSection8Members(opts);
      }
      return sec8Data;
    }
    if (!force && (Date.now() - lastSec8FillTs < 180)) return sec8Data;

    const cards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
    if (cards.length === 0) return sec8Data;

    isFillingSection8 = true;
    const runSec8 = (async () => {
      let filled = 0;
      try {
        for (const card of cards) {
          filled += await applyMemberSmartDefaults(card, { force });
        }
      } finally {
        lastSec8FillTs = Date.now();
        isFillingSection8 = false;
        if (activeSec8Promise === runSec8) activeSec8Promise = null;
      }
      const updated = trackSection8Data();
      if (filled > 0) {
        if (typeof handleSection5AndCrossMatch === 'function') handleSection5AndCrossMatch();
        if (typeof handleSection9MoneyUsage === 'function') handleSection9MoneyUsage(false);
        updateSummaryBadge(true);
      }
      return updated;
    })();
    activeSec8Promise = runSec8;
    return runSec8;
  }

  async function syncMemberToFirestore(memberData, memberIndex) {
    try {
      const cleanId = getSafeFamilyDocId(lastExtractedData || memberData);
      if (!cleanId) {
        console.warn('[FamilyCard Extension] Skipped Firestore member sync: no family_id available');
        return;
      }
      const memberDocId = `member_${memberIndex}_${memberData.doc_number || Date.now()}`;
      const url = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(cleanId)}/members/${encodeURIComponent(memberDocId)}`;

      const doc = {
        fields: {
          member_index: { integerValue: String(memberIndex) },
          doc_type: { stringValue: memberData.doc_type || 'nid' },
          doc_number: { stringValue: memberData.doc_number || memberData.nid_number || '' },
          name_bn: { stringValue: memberData.name_bn || '' },
          name_en: { stringValue: memberData.name_en || '' },
          dob: { stringValue: memberData.dob || '' },
          gender: { stringValue: memberData.gender || '' },
          relationship: { stringValue: memberData.relationship || memberData.relation_suggestion || '' },
          father_name_bn: { stringValue: memberData.father_name_bn || '' },
          father_name_en: { stringValue: memberData.father_name_en || '' },
          mother_name_bn: { stringValue: memberData.mother_name_bn || '' },
          mother_name_en: { stringValue: memberData.mother_name_en || '' },
          spouse_name_bn: { stringValue: memberData.spouse_name_bn || '' },
          spouse_name_en: { stringValue: memberData.spouse_name_en || '' },
          marital_status: { stringValue: memberData.marital_status || memberData.marital_status_suggestion || 'বিবাহিত' },
          religion: { stringValue: memberData.religion || 'ইসলাম' },
          ocr_model_used: { stringValue: memberData.ocr_model_used || '' },
          synced_at: { timestampValue: new Date().toISOString() }
        }
      };

      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc)
      });
      console.log('[FamilyCard Extension] Member synced to Firestore:', memberDocId);
    } catch (err) {
      console.warn('[FamilyCard Extension] Firestore member sync notice:', err.message);
    }
  }

  // Compress & enhance document image on an off-screen canvas
  function compressImageFile(file, maxDimension = 1800, quality = 0.90) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = (evt) => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if ('filter' in ctx) ctx.filter = 'contrast(1.08) brightness(1.03)';
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  window.__fcScanHistory = window.__fcScanHistory || [];

  function showModalOcrWarnings(warnings) {
    const box = document.getElementById('fc-modal-ocr-warn');
    if (!box) return;
    if (Array.isArray(warnings) && warnings.length > 0) {
      box.innerHTML = warnings.map(w => `⚠️ ${escapeHtml(w)}`).join('<br>');
      box.style.display = 'block';
    } else {
      box.style.display = 'none';
    }
  }

  // Trigger Gemini OCR via Background Service Worker
  function triggerModalOCR(base64Data) {
    const loading = document.getElementById('fc-modal-loading');
    const btnCamera = document.getElementById('fc-modal-btn-camera');
    const btnSubmit = document.getElementById('fc-modal-btn-submit');
    const maritalStatus = document.getElementById('fc-modal-marital')?.value || 'বিবাহিত';
    const religion = document.getElementById('fc-modal-religion')?.value || 'ইসলাম';
    const mobileNumber = document.getElementById('fc-modal-mobile')?.value?.trim() || '';
    const docTypeChoice = window.__fcModalDocChoice || document.getElementById('fc-modal-doc-type')?.value || 'auto';

    showModalOcrWarnings([]);
    loading.style.display = 'flex';
    btnCamera.style.display = 'none';
    btnSubmit.style.display = 'none';

    let detectedMime = 'image/jpeg';
    const mimeMatch = String(base64Data || '').match(/^data:([^;]+);base64,/);
    if (mimeMatch) detectedMime = mimeMatch[1] || 'image/jpeg';

    const modalProvider = document.getElementById('fc-modal-ai-provider')?.value || aiProvider || 'economy';
    const modalKeySlot = document.getElementById('fc-modal-default-key')?.value || defaultKeySlot || 'auto';
    const modalGemModel = document.getElementById('fc-modal-gemini-model')?.value || geminiModel || DEFAULT_GEMINI_MODEL;
    const modalDsModel = document.getElementById('fc-modal-deepseek-model')?.value || deepseekModel || 'deepseek-flash';
    aiProvider = modalProvider;
    defaultKeySlot = modalKeySlot;
    geminiModel = modalGemModel;
    deepseekModel = modalDsModel;
    localStorage.setItem('fc_ai_provider', modalProvider);
    localStorage.setItem('fc_default_key_slot', modalKeySlot);
    localStorage.setItem('fc_gemini_model', modalGemModel);
    localStorage.setItem('fc_deepseek_model', modalDsModel);

    const useDsMsg = modalProvider === 'deepseek' || (modalKeySlot === 'deepseek' && Boolean(deepseekApiKey) && (modalProvider === 'economy' || modalProvider === 'auto'));
    const headline = useDsMsg
      ? `DeepSeek (${modalDsModel}) দিয়ে ডকুমেন্ট স্ক্যান হচ্ছে...`
      : `${modalGemModel} দিয়ে ডকুমেন্ট স্ক্যান হচ্ছে...`;
    startExtModalProgress(headline);

    chrome.runtime.sendMessage({
      action: 'ocr_nid_direct',
      imageBase64: base64Data,
      mimeType: detectedMime,
      maritalStatus,
      religion,
      mobileNumber,
      docType: docTypeChoice,
      aiProvider: modalProvider,
      defaultKeySlot: modalKeySlot,
      geminiModel: modalGemModel,
      deepseekModel: modalDsModel,
      apiKey: geminiApiKey,
      deepseekApiKey: deepseekApiKey
    }, async (response) => {
      stopExtModalProgress(response && response.success ? 100 : 0, response && response.success ? 'সম্পন্ন!' : 'ত্রুটি');
      loading.style.display = 'none';
      btnCamera.style.display = 'flex';

      if (chrome.runtime.lastError) {
        fcLogTelemetry('error', 'triggerModalOCR-runtime', chrome.runtime.lastError.message, `provider=${modalProvider}`);
        alert('OCR রিকোয়েস্ট এরর: ' + chrome.runtime.lastError.message);
        return;
      }

      if (response && response.success && response.data) {
        const curFid = scrapeFamilyId() || '';
        const data = normalizeApplicantPayload({
          ...response.data,
          family_id: response.data.family_id || curFid
        });
        window.__fcLastScannedAny = data;
        const warnings = Array.isArray(data.ocr_warnings) ? data.ocr_warnings : [];
        if (data.ocr_usage) {
          recordScanCostUsage(data.ocr_usage);
          if (typeof window.__fcRenderModalCostCard === 'function') window.__fcRenderModalCostCard();
        }
        const costTag = data.ocr_usage
          ? `💰 $${Number(data.ocr_usage.costUsd || 0).toFixed(5)} (~৳${Number(data.ocr_usage.costBdt || 0).toFixed(3)})`
          : '';

        window.__fcScanHistory.unshift({
          target: activeScanTarget.type,
          doc_type: data.doc_type,
          doc_number: data.doc_number,
          name_bn: data.name_bn || '',
          dob: data.dob || '',
          data,
          model: data.ocr_model_used || '',
          usage: data.ocr_usage || null,
          warnings,
          at: new Date().toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })
        });
        if (window.__fcScanHistory.length > 20) window.__fcScanHistory.length = 20;

        showModalOcrWarnings(warnings);
        closeScannerModal();

        if (activeScanTarget.type === 'member') {
          let targetCard = activeScanTarget.card;
          if (!targetCard) {
            const cards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
            if (activeScanTarget.index === 'new') {
              triggerPortalAddMember();
              await new Promise(r => setTimeout(r, 450));
              const updatedCards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
              targetCard = updatedCards[updatedCards.length - 1];
            } else if (typeof activeScanTarget.index === 'number' && cards[activeScanTarget.index - 1]) {
              targetCard = cards[activeScanTarget.index - 1];
            } else {
              targetCard = cards.find(c => {
                const isSelf = c.classList.contains('fm-member-card--self') || (c.textContent.includes('সদস্য - ১') && c.textContent.includes('নিজ'));
                if (isSelf) return false;
                const hasName = c.querySelector('input:not([disabled])')?.value;
                return !hasName && c.dataset.fcMemberAutoFilled !== 'true';
              });

              if (!targetCard) {
                triggerPortalAddMember();
                await new Promise(r => setTimeout(r, 450));
                const updatedCards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
                targetCard = updatedCards[updatedCards.length - 1];
              }
            }
          }

          const relChoice = document.getElementById('fc-modal-relation-select')?.value;
          if (relChoice && relChoice !== 'auto') {
            data.relationship = relChoice;
          } else if (data.relation_suggestion) {
            data.relationship = data.relation_suggestion;
          }

          if (targetCard) {
            await fillMemberCard(targetCard, data);
            handleSection5AndCrossMatch();
            const allCards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
            const realIdx = allCards.indexOf(targetCard);
            const cardIdx = realIdx >= 0 ? (realIdx + 1) : ((typeof activeScanTarget.index === 'number') ? activeScanTarget.index : allCards.length || 2);
            syncMemberToFirestore(data, cardIdx);
            if (warnings.length > 0) {
              showToast(`⚠️ সদস্য (${data.name_bn || data.doc_number}) পূরণ — সতর্কতা: ${warnings[0]}${costTag ? ` • ${costTag}` : ''}`);
            } else {
              showToast(`✅ সদস্য (${data.name_bn || data.doc_number}) পূরণ হয়েছে!${costTag ? ` ${costTag}` : ''}`);
            }
          } else {
            showToast(`⚠️ সদস্য কার্ড পাওয়া যায়নি। অনুগ্রহ করে প্রথমে '+ নতুন সদস্য' যোগ করুন।`);
          }
        } else {
          lastExtractedData = data;
          cacheFamilyScan(data);
          window.__fcStep1FilledKey = '';
          updateWidgetPreview(data);
          await fillFormFields(data, { overwriteExisting: true });
          syncToFirestore(data);
          if (warnings.length > 0) {
            showToast(`⚠️ NID তথ্য পূরণ — সতর্কতা: ${warnings[0]}${costTag ? ` • ${costTag}` : ''}`);
          } else {
            showToast(`✅ এনআইডি তথ্য সফলভাবে পূরণ করা হয়েছে!${costTag ? ` ${costTag}` : ''}`);
          }
        }
        updateSummaryBadge(true);
      } else {
        fcLogTelemetry('error', 'triggerModalOCR-failed', response?.error || 'OCR failed', `provider=${modalProvider}`);
        alert('ডকুমেন্ট বিশ্লেষণ ব্যর্থ: ' + (response?.error || 'সঠিক NID বা জন্ম নিবন্ধন ছবি পাওয়া যায়নি।'));
      }
    });
  }

  // --- Cross-Device Room Messaging & Cloud/Socket Bridge ---
  const ROOM_FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/room_channels';
  const ROOM_EDGE_API = 'https://familycard-10n.pages.dev/api/room-messages';
  function normalizeRoomCode(r) {
    const clean = String(r || 'FC-101').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
    return clean || 'FC-101';
  }
  const myClientId = (() => {
    const saved = String(localStorage.getItem('fc_client_id') || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);
    if (saved && saved.startsWith('ext_')) {
      if (saved !== localStorage.getItem('fc_client_id')) localStorage.setItem('fc_client_id', saved);
      return saved;
    }
    const id = 'ext_' + Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 8).padEnd(6, '0');
    localStorage.setItem('fc_client_id', id);
    return id;
  })();
  let roomAutoFillEnabled = localStorage.getItem('fc_room_autofill') === '1';
  const roomMsgMap = new Map();
  let lastRoomMetaSig = '';
  let lastRoomClearedMs = 0;
  let roomUnreadCount = 0;
  let pendingReplyMsg = null;
  let roomBootstrapped = false;
  let roomSwitchTimer = null;
  let roomFetchInFlight = false;

  function extractActivePeersFromFields(mf = {}, nowMs = Date.now()) {
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

  function renderPeersStatus(peers = [], targetRoom = roomCode) {
    const list = Array.isArray(peers) ? peers : [];
    const hasSelf = list.some(p => p.id === myClientId);
    const totalCount = hasSelf ? list.length : (list.length + 1);
    const others = list.filter(p => p.id !== myClientId);
    const dotEl = document.getElementById('fc-chat-peers-dot');
    const stEl = document.getElementById('fc-chat-status');

    if (others.length > 0) {
      const summary = others.slice(0, 3).map((p) => {
        const tag = p.client === 'companion' ? 'মোবাইল' : (p.client === 'bookmarklet' ? 'বুকমার্কলেট' : (p.client || 'ওয়েব'));
        return `${p.name || 'ডিভাইস'} (${tag})`;
      }).join(', ');
      if (dotEl) {
        dotEl.textContent = `● ${toBnDigits(totalCount)}`;
        dotEl.style.display = 'inline-block';
      }
      if (stEl) {
        stEl.style.color = '#065f46';
        stEl.textContent = `${socket && socket.connected ? '🟢 সার্ভার + রুম' : '🟢 রুম'} "${targetRoom}": ${toBnDigits(totalCount)}টি ডিভাইস যুক্ত — ${summary}${others.length > 3 ? ` +${others.length - 3}` : ''}`;
      }
    } else {
      if (dotEl) dotEl.style.display = 'none';
      if (stEl) {
        stEl.style.color = '#92400e';
        stEl.textContent = `🟡 রুম "${targetRoom}": আপনি যুক্ত — অন্য ফোনে familycard.afridi.app খুলুন`;
      }
    }
  }

  function updateChatBadge() {
    const badge = document.getElementById('fc-chat-badge');
    if (!badge) return;
    if (roomUnreadCount > 0) {
      badge.textContent = toBnDigits(roomUnreadCount);
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  function ensureChatModal() {
    let cm = document.getElementById('fc-chat-modal');
    if (cm) return cm;
    cm = document.createElement('div');
    cm.id = 'fc-chat-modal';
    cm.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(15,23,42,0.68); backdrop-filter:blur(2px); z-index:2147483645; display:none; align-items:center; justify-content:center; padding:12px; box-sizing:border-box; font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;';
    cm.innerHTML = `
      <div style="background:#fff; width:100%; max-width:500px; border-radius:16px; overflow:hidden; box-shadow:0 20px 40px rgba(0,0,0,0.35); display:flex; flex-direction:column; max-height:90vh;">
        <div style="background:linear-gradient(135deg, #4f46e5, #3730a3); color:#fff; padding:12px 16px; display:flex; justify-content:space-between; align-items:center;">
          <h3 style="margin:0; font-size:15px; font-weight:700;">💬 রুম মেসেঞ্জার ও ডাটা শেয়ার</h3>
          <span id="fc-chat-close-btn" style="cursor:pointer; font-size:20px; font-weight:bold;">&times;</span>
        </div>
        <div style="padding:12px; display:flex; flex-direction:column; gap:8px; overflow-y:auto;">
          <div style="background:#f8fafc; border:1px solid #cbd5e1; border-radius:10px; padding:8px; display:flex; flex-direction:column; gap:6px;">
            <div style="display:flex; gap:8px;">
              <div style="flex:1; display:flex; flex-direction:column; gap:3px;">
                <label for="fc-chat-room-input" style="font-size:11px; font-weight:700; color:#334155;">🔗 রুম কোড:</label>
                <input type="text" id="fc-chat-room-input" value="${escapeHtml(roomCode)}" maxlength="20" style="padding:6px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:12px; font-weight:700; text-transform:uppercase;">
              </div>
              <div style="flex:1; display:flex; flex-direction:column; gap:3px;">
                <label for="fc-chat-device-name" style="font-size:11px; font-weight:700; color:#334155;">📱 আমার নাম:</label>
                <input type="text" id="fc-chat-device-name" value="${escapeHtml(myDeviceName)}" maxlength="32" style="padding:6px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:12px;">
              </div>
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
              <button type="button" id="fc-chat-room-join" class="fc-chat-chip primary">✅ রুম সেভ/যোগ</button>
              <button type="button" id="fc-chat-room-link" class="fc-chat-chip accent">🔗 ফোনের লিংক কপি</button>
              <label style="font-size:11px; font-weight:700; color:#334155; display:inline-flex; align-items:center; gap:4px; margin:0; cursor:pointer;">
                <input type="checkbox" id="fc-chat-room-autofill" style="width:auto;" ${roomAutoFillEnabled ? 'checked' : ''}> ⚡ NID এলে অটো-ফিল
              </label>
              <button type="button" id="fc-chat-refresh" class="fc-chat-chip" title="রিফ্রেশ">🔄</button>
              <button type="button" id="fc-chat-clear" class="fc-chat-chip" title="মুছুন">🗑️</button>
            </div>
            <div id="fc-chat-status" style="font-size:10.5px; color:#0f766e; font-weight:700;">☁️ ক্লাউড রুম সক্রিয় (${escapeHtml(roomCode)})</div>
          </div>

          <div id="fc-chat-feed" class="fc-chat-feed">
            <div style="text-align:center; color:#64748b; padding:22px 8px;">লোড হচ্ছে...</div>
          </div>

          <div id="fc-chat-reply-bar" style="display:none; align-items:center; justify-content:space-between; background:#eef2ff; border-left:3px solid #4f46e5; padding:4px 8px; border-radius:6px; font-size:11px;">
            <span id="fc-chat-reply-txt"></span>
            <button type="button" id="fc-chat-reply-cancel" style="border:none; background:none; font-weight:bold; cursor:pointer;">✕</button>
          </div>

          <div style="display:flex; flex-wrap:wrap; gap:5px;">
            <button type="button" id="fc-chat-share-nid" class="fc-chat-chip primary">🪪 শেষ স্ক্যান পাঠান</button>
            <button type="button" id="fc-chat-share-sum" class="fc-chat-chip accent">📊 সারসংক্ষেপ</button>
            <button type="button" class="fc-chat-chip" data-ext-qmsg="✅ কাজ সম্পন্ন">✅ সম্পন্ন</button>
            <button type="button" class="fc-chat-chip" data-ext-qmsg="মোবাইল নম্বর পাঠান 📱">📱 নম্বর দিন</button>
          </div>

          <div style="display:flex; gap:6px;">
            <input type="text" id="fc-chat-input" placeholder="মেসেজ, মোবাইল নম্বর বা তথ্য লিখুন..." style="flex:1; padding:8px 10px; border:1.5px solid #cbd5e1; border-radius:8px; font-size:12.5px;">
            <button type="button" id="fc-chat-send" style="background:#4f46e5; color:#fff; border:none; border-radius:8px; padding:8px 14px; font-weight:700; font-size:12.5px; cursor:pointer;">📤</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(cm);

    cm.querySelector('#fc-chat-close-btn').onclick = () => { cm.style.display = 'none'; };
    cm.onclick = (e) => { if (e.target === cm) cm.style.display = 'none'; };

    const inpRoom = cm.querySelector('#fc-chat-room-input');
    const inpName = cm.querySelector('#fc-chat-device-name');
    const chkAuto = cm.querySelector('#fc-chat-room-autofill');

    const applyRoomJoin = (notify = false) => {
      const nextRoom = normalizeRoomCode(inpRoom.value);
      inpRoom.value = nextRoom;
      myDeviceName = inpName.value.trim() || 'পিসি-এক্সটেনশন';
      localStorage.setItem('fc_device_name', myDeviceName);
      if (nextRoom !== roomCode) {
        roomCode = nextRoom;
        localStorage.setItem('fc_room_code', roomCode);
        const roomEl = document.getElementById('fc-ui-room');
        if (roomEl) roomEl.textContent = roomCode;
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
          chrome.storage.sync.set({ roomCode, deviceName: myDeviceName });
        }
        roomMsgMap.clear();
        lastRoomMetaSig = '';
        lastRoomClearedMs = 0;
        roomBootstrapped = false;
        renderChatFeed();
        if (socket && socket.connected) {
          socket.emit('join-room', { room: roomCode, clientName: myDeviceName, clientType: 'extension' });
        }
      }
      const stEl = cm.querySelector('#fc-chat-status');
      if (stEl) {
        stEl.style.color = '#1e40af';
        stEl.textContent = `⏳ রুম "${roomCode}"-এ যুক্ত হচ্ছে...`;
      }
      fetchRoomMessages(true);
      if (notify) showToast(`🔗 রুম "${roomCode}"-এ যুক্ত হয়েছেন!`);
    };

    cm.querySelector('#fc-chat-room-join').onclick = () => {
      clearTimeout(roomSwitchTimer);
      applyRoomJoin(true);
    };
    inpRoom.addEventListener('input', () => {
      clearTimeout(roomSwitchTimer);
      roomSwitchTimer = setTimeout(() => {
        const nextRoom = normalizeRoomCode(inpRoom.value);
        if (nextRoom !== roomCode) applyRoomJoin(false);
      }, 550);
    });
    inpRoom.addEventListener('change', () => {
      clearTimeout(roomSwitchTimer);
      applyRoomJoin(true);
    });
    inpName.addEventListener('change', () => {
      myDeviceName = inpName.value.trim() || 'পিসি-এক্সটেনশন';
      localStorage.setItem('fc_device_name', myDeviceName);
      fetchRoomMessages(false);
    });

    cm.querySelector('#fc-chat-room-link').onclick = async () => {
      const r = normalizeRoomCode(inpRoom.value);
      const url = `https://familycard.afridi.app/?room=${encodeURIComponent(r)}`;
      try {
        await navigator.clipboard.writeText(url);
        showToast('🔗 ফোনের রুম লিংক কপি হয়েছে — অন্য ফোনে খুলুন!');
      } catch (_) {
        prompt('এই রুম লিংকটি অন্য ডিভাইসে খুলুন:', url);
      }
    };

    if (chkAuto) {
      chkAuto.onchange = () => {
        roomAutoFillEnabled = chkAuto.checked;
        localStorage.setItem('fc_room_autofill', roomAutoFillEnabled ? '1' : '0');
      };
    }

    cm.querySelector('#fc-chat-refresh').onclick = () => fetchRoomMessages(true);
    cm.querySelector('#fc-chat-clear').onclick = async () => {
      if (!confirm(`রুম "${roomCode}"-এর সব মেসেজ মুছবেন?`)) return;
      const clearedAt = Date.now();
      lastRoomClearedMs = clearedAt;
      roomMsgMap.clear();
      renderChatFeed();
      if (socket && socket.connected) socket.emit('clear-room-messages', { room: roomCode });
      const delRes = await fetch(`${ROOM_EDGE_API}?room=${encodeURIComponent(roomCode)}`, { method: 'DELETE', cache: 'no-store' }).catch(() => null);
      if (!delRes || !delRes.ok) {
        const metaFields = {
          room: { stringValue: roomCode },
          last_msg_id: { stringValue: '' },
          cleared_at_ms: { integerValue: String(clearedAt) },
          updated_at: { timestampValue: new Date().toISOString() }
        };
        const mask = Object.keys(metaFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
        await fetch(`${ROOM_FIRESTORE_BASE}/${encodeURIComponent(roomCode)}?${mask}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: metaFields }),
          cache: 'no-store'
        }).catch(() => {});
      }
      lastRoomMetaSig = `${roomCode}||${clearedAt}`;
      showToast(`🗑️ রুম "${roomCode}" চ্যাট ক্লিয়ার হয়েছে`);
    };

    cm.querySelector('#fc-chat-reply-cancel').onclick = () => {
      pendingReplyMsg = null;
      cm.querySelector('#fc-chat-reply-bar').style.display = 'none';
    };

    cm.querySelector('#fc-chat-share-nid').onclick = () => {
      let d = window.__fcLastScannedAny || lastExtractedData;
      if (!d) {
        const s = collectFullFamilyCardSummary();
        if (s.applicant && (s.applicant.nameBn || s.applicant.nid)) {
          d = {
            doc_type: 'nid',
            doc_number: s.applicant.nid || '',
            nid_number: s.applicant.nid || '',
            name_bn: s.applicant.nameBn || '',
            mobile_number: s.applicant.mobile || '',
            family_id: s.familyId || ''
          };
        }
      }
      if (!d) {
        showToast('⚠️ শেয়ার করার মতো স্ক্যান করা NID পাওয়া যায়নি।');
        return;
      }
      sendRoomMessage({
        type: 'nid_data',
        text: `🪪 ${d.name_bn || d.name_en || ''} (${d.doc_number || d.nid_number || d.birth_reg_no || ''})`,
        payload: d
      });
    };

    cm.querySelector('#fc-chat-share-sum').onclick = () => {
      const s = collectFullFamilyCardSummary();
      const txt = buildBanglaSummaryReportText(s);
      sendRoomMessage({
        type: 'summary',
        text: txt,
        payload: { familyId: s.familyId, readinessPct: s.readinessPct, memberCount: s.members.length }
      });
    };

    cm.querySelectorAll('[data-ext-qmsg]').forEach((b) => {
      b.onclick = () => sendRoomMessage({ type: 'text', text: b.getAttribute('data-ext-qmsg') });
    });

    const msgInp = cm.querySelector('#fc-chat-input');
    const submitChat = () => {
      const txt = msgInp.value.trim();
      if (!txt) return;
      msgInp.value = '';
      sendRoomMessage({ type: 'text', text: txt });
    };
    cm.querySelector('#fc-chat-send').onclick = submitChat;
    msgInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitChat(); }
    });

    cm.querySelector('#fc-chat-feed').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-chat-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-chat-act');
      const mid = btn.getAttribute('data-mid');
      const msg = roomMsgMap.get(mid);
      if (!msg) return;

      if (act === 'fill-applicant' && msg.payload) {
        const curFid = scrapeFamilyId() || '';
        const norm = normalizeApplicantPayload({
          ...msg.payload,
          family_id: msg.payload.family_id || curFid
        });
        lastExtractedData = norm;
        cacheFamilyScan(norm);
        window.__fcStep1FilledKey = '';
        updateWidgetPreview(norm);
        cm.style.display = 'none';
        await fillFormFields(norm, { overwriteExisting: true });
        updateSummaryBadge(true);
        showToast(`⚡ রুম থেকে "${norm.name_bn || norm.doc_number}" আবেদনকারী ফর্মে পূরণ হয়েছে!`);
      } else if (act === 'fill-member' && msg.payload) {
        const normMember = normalizeApplicantPayload(msg.payload);
        cm.style.display = 'none';
        const cards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
        let targetCard = cards.find(c => {
          const isSelf = c.classList.contains('fm-member-card--self') || (c.textContent.includes('সদস্য - ১') && c.textContent.includes('নিজ'));
          if (isSelf) return false;
          const hasName = c.querySelector('input:not([disabled])')?.value;
          return !hasName && c.dataset.fcMemberAutoFilled !== 'true';
        });
        if (!targetCard) {
          triggerPortalAddMember();
          await new Promise(r => setTimeout(r, 450));
          const updated = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
          targetCard = updated[updated.length - 1];
        }
        if (targetCard) {
          await fillMemberCard(targetCard, normMember);
          handleSection5AndCrossMatch();
          updateSummaryBadge(true);
          showToast(`✅ সদস্য "${normMember.name_bn || normMember.doc_number}" কার্ডে পূরণ হয়েছে!`);
        } else {
          showToast('⚠️ সেকশন ৮ (সদস্য ট্যাব) খুলুন এবং আবার চেষ্টা করুন।');
        }
      } else if (act === 'fill-mobile') {
        const mob = btn.getAttribute('data-val') || '';
        const modalMob = document.getElementById('fc-modal-mobile');
        if (modalMob) modalMob.value = mob;
        const tab1 = document.querySelector('[data-family-card-tab="1"]');
        const mobInp = findInputByLabelText(['মোবাইল নম্বর'], tab1) || findInputByLabelText(['মোবাইল নম্বর']) || document.getElementById('input-1294') || document.getElementById('input-250');
        if (mobInp) setReactiveValue(mobInp, mob);
        showToast(`📱 মোবাইল ${mob} ফর্মে বসানো হয়েছে!`);
      } else if (act === 'copy') {
        const copyVal = btn.getAttribute('data-val') || (msg.type === 'nid_data' && msg.payload
          ? `${msg.payload.name_bn || ''}\n${msg.payload.name_en || ''}\nNID/BRC: ${msg.payload.doc_number || msg.payload.nid_number || ''}\nDOB: ${msg.payload.dob || ''}`
          : (msg.text || ''));
        try {
          await navigator.clipboard.writeText(copyVal);
          showToast('📋 ক্লিপবোর্ডে কপি হয়েছে!');
        } catch (_) {}
      } else if (act === 'reply') {
        pendingReplyMsg = {
          id: msg.id,
          senderName: msg.senderName || 'ডিভাইস',
          preview: (msg.text || msg.payload?.name_bn || 'ডেটা').slice(0, 80)
        };
        const rBar = cm.querySelector('#fc-chat-reply-bar');
        const rTxt = cm.querySelector('#fc-chat-reply-txt');
        if (rTxt) rTxt.textContent = `↩️ ${pendingReplyMsg.senderName}: ${pendingReplyMsg.preview}`;
        if (rBar) rBar.style.display = 'flex';
        msgInp.focus();
      }
    });

    return cm;
  }

  function renderChatFeed() {
    const feed = document.getElementById('fc-chat-feed');
    if (!feed) return;
    const msgs = Array.from(roomMsgMap.values()).filter(m => m.ts > lastRoomClearedMs).sort((a, b) => a.ts - b.ts);
    if (msgs.length === 0) {
      feed.innerHTML = `<div style="text-align:center; color:#64748b; padding:22px 8px;">রুম <b>${escapeHtml(roomCode)}</b>-এ এখনো কোনো মেসেজ নেই।</div>`;
      return;
    }
    feed.innerHTML = msgs.map((m) => {
      const isMine = m.senderId === myClientId;
      const cls = m.type === 'nid_data' ? 'nid' : (m.type === 'summary' ? 'summary' : (isMine ? 'mine' : ''));
      const timeStr = new Date(m.ts).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' });
      let inner = '';
      if (m.replyTo && m.replyTo.preview) {
        inner += `<div style="font-size:10.5px; color:#4338ca; background:#eef2ff; padding:3px 6px; border-left:2px solid #4f46e5; border-radius:4px; margin-bottom:4px;">↩️ <b>${escapeHtml(m.replyTo.senderName || '')}:</b> ${escapeHtml(m.replyTo.preview)}</div>`;
      }
      const acts = [];
      if (m.type === 'nid_data' && m.payload) {
        const p = m.payload;
        inner += `
          <div style="font-weight:800; color:#0f766e;">🪪 ${escapeHtml(p.name_bn || p.name_en || 'NID/BRC কার্ড')}</div>
          <div style="font-size:11px; color:#334155;">নম্বর: <b>${escapeHtml(p.doc_number || p.nid_number || p.birth_reg_no || '-')}</b> • জন্ম: ${escapeHtml(p.dob || '-')}${p.mobile_number ? ` • 📱 ${escapeHtml(p.mobile_number)}` : ''}</div>
          ${p.father_name_bn || p.spouse_name_bn ? `<div style="font-size:10.5px; color:#475569;">${p.spouse_name_bn ? `স্বামী/স্ত্রী: ${escapeHtml(p.spouse_name_bn)}` : `পিতা: ${escapeHtml(p.father_name_bn)}`} • মাতা: ${escapeHtml(p.mother_name_bn || '-')}</div>` : ''}
        `;
        acts.push(`<button type="button" class="fc-chat-chip primary" data-chat-act="fill-applicant" data-mid="${escapeHtml(m.id)}">⚡ আবেদনকারী</button>`);
        acts.push(`<button type="button" class="fc-chat-chip accent" data-chat-act="fill-member" data-mid="${escapeHtml(m.id)}">👨‍👩‍👧 সদস্য কার্ড</button>`);
      } else if (m.type === 'summary') {
        inner += `<div style="font-weight:800; color:#1e40af;">📊 ফ্যামিলি কার্ড সারসংক্ষেপ</div><div style="font-size:11px; white-space:pre-wrap; margin-top:2px;">${escapeHtml(m.text)}</div>`;
      } else {
        inner += `<div style="white-space:pre-wrap;">${escapeHtml(m.text)}</div>`;
        const mobMatch = normalizeDigits(m.text).match(/(?:\+?88)?(01[3-9]\d{8})/);
        if (mobMatch) {
          acts.push(`<button type="button" class="fc-chat-chip primary" data-chat-act="fill-mobile" data-val="${escapeHtml(mobMatch[1])}" data-mid="${escapeHtml(m.id)}">📱 মোবাইল বসাও (${escapeHtml(mobMatch[1])})</button>`);
        }
        const idMatch = normalizeDigits(m.text).match(/\b(\d{10}|\d{13}|\d{17})\b/);
        if (idMatch) {
          acts.push(`<button type="button" class="fc-chat-chip accent" data-chat-act="copy" data-val="${escapeHtml(idMatch[1])}" data-mid="${escapeHtml(m.id)}">📋 আইডি (${escapeHtml(idMatch[1])})</button>`);
        }
      }
      acts.push(`<button type="button" class="fc-chat-chip" data-chat-act="copy" data-mid="${escapeHtml(m.id)}">📋 কপি</button>`);
      acts.push(`<button type="button" class="fc-chat-chip" data-chat-act="reply" data-mid="${escapeHtml(m.id)}">↩️</button>`);
      return `
        <div class="fc-chat-bubble ${cls}">
          <div style="display:flex; justify-content:space-between; font-size:10px; color:#64748b; margin-bottom:3px; gap:8px;">
            <b>${isMine ? 'আমি' : escapeHtml(m.senderName || 'ডিভাইস')} (${escapeHtml(m.senderClient || '')})</b>
            <span>${escapeHtml(timeStr)}</span>
          </div>
          ${inner}
          <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:5px;">${acts.join('')}</div>
        </div>
      `;
    }).join('');
    feed.scrollTop = feed.scrollHeight;
  }

  function processIncomingRoomMsg(msg, isBootstrap) {
    if (!msg || !msg.id) return false;
    const ts = Number(msg.ts || 0);
    if (ts <= lastRoomClearedMs) return false;
    const isNew = !roomMsgMap.has(msg.id);
    roomMsgMap.set(msg.id, msg);
    if (isNew && !isBootstrap && msg.senderId !== myClientId) {
      const chatModal = document.getElementById('fc-chat-modal');
      const isOpen = chatModal && chatModal.style.display === 'flex';
      if (!isOpen) {
        roomUnreadCount += 1;
        updateChatBadge();
        showToast(`💬 ${msg.senderName || 'ডিভাইস'}: ${(msg.text || msg.payload?.name_bn || 'নতুন বার্তা').slice(0, 60)}`);
      }
      if (roomAutoFillEnabled && msg.type === 'nid_data' && msg.payload) {
        const curFid = scrapeFamilyId() || '';
        const norm = normalizeApplicantPayload({
          ...msg.payload,
          family_id: msg.payload.family_id || curFid
        });
        lastExtractedData = norm;
        cacheFamilyScan(norm);
        window.__fcStep1FilledKey = '';
        updateWidgetPreview(norm);
        fillFormFields(norm, { overwriteExisting: false });
      }
    }
    return isNew;
  }

  async function fetchRoomMessages(forceFull = false) {
    if (document.hidden && !forceFull) return;
    if (roomFetchInFlight) return;
    roomFetchInFlight = true;
    const targetRoom = roomCode;
    const useMetaOnly = roomBootstrapped && !forceFull;

    try {

    // 1. Primary: Cloudflare Edge API (zero 404s + atomic peer presence + no-store cache busting)
    try {
      const edgeUrl = `${ROOM_EDGE_API}?room=${encodeURIComponent(targetRoom)}&metaOnly=${useMetaOnly ? '1' : '0'}&peerId=${encodeURIComponent(myClientId)}&peerName=${encodeURIComponent(myDeviceName)}&peerClient=extension&t=${Date.now()}`;
      const er = await fetch(edgeUrl, { cache: 'no-store' });
      if (targetRoom !== roomCode) return;
      if (er.ok) {
        const ej = await er.json().catch(() => ({}));
        if (ej && ej.success) {
          const clearedAt = Number(ej.meta?.cleared_at_ms || 0);
          const lastId = String(ej.meta?.last_msg_id || '');
          const sig = `${targetRoom}|${lastId}|${clearedAt}`;
          if (clearedAt > lastRoomClearedMs) {
            lastRoomClearedMs = clearedAt;
            for (const [k, v] of roomMsgMap.entries()) {
              if (v.ts <= lastRoomClearedMs) roomMsgMap.delete(k);
            }
            renderChatFeed();
          }
          renderPeersStatus(ej.peers || [], targetRoom);

          if (useMetaOnly && sig === lastRoomMetaSig) return;

          let listPayload = ej;
          if (useMetaOnly) {
            const fullRes = await fetch(`${ROOM_EDGE_API}?room=${encodeURIComponent(targetRoom)}&metaOnly=0&t=${Date.now()}`, { cache: 'no-store' });
            if (targetRoom !== roomCode) return;
            listPayload = fullRes.ok ? await fullRes.json().catch(() => ({})) : {};
            if (Array.isArray(listPayload.peers)) renderPeersStatus(listPayload.peers, targetRoom);
          }

          if (Array.isArray(listPayload.messages)) {
            const wasBootstrapped = roomBootstrapped;
            let anyNew = false;
            listPayload.messages.forEach(m => {
              if (processIncomingRoomMsg(m, !wasBootstrapped)) anyNew = true;
            });
            roomBootstrapped = true;
            lastRoomMetaSig = sig;
            if (anyNew || !wasBootstrapped) renderChatFeed();
            return;
          }
        }
      }
    } catch (_) {}

    // 2. Fallback: Direct Firestore REST (atomic peer PATCH + cache-busted messages GET)
    try {
      const nowMs = Date.now();
      const peerFields = {
        room: { stringValue: targetRoom },
        peers: {
          mapValue: {
            fields: {
              [myClientId]: {
                mapValue: {
                  fields: {
                    name: { stringValue: String(myDeviceName || 'পিসি-এক্সটেনশন').slice(0, 50) },
                    client: { stringValue: 'extension' },
                    seenAt: { integerValue: String(nowMs) }
                  }
                }
              }
            }
          }
        }
      };
      const metaRes = await fetch(
        `${ROOM_FIRESTORE_BASE}/${encodeURIComponent(targetRoom)}?updateMask.fieldPaths=room&updateMask.fieldPaths=peers.${encodeURIComponent(myClientId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: peerFields }),
          cache: 'no-store'
        }
      );
      if (targetRoom !== roomCode) return;
      if (metaRes.ok) {
        const mj = await metaRes.json().catch(() => ({}));
        const mf = mj?.fields || {};
        const clearedAt = Number(mf.cleared_at_ms?.integerValue || 0);
        const lastId = mf.last_msg_id?.stringValue || '';
        const sig = `${targetRoom}|${lastId}|${clearedAt}`;
        if (clearedAt > lastRoomClearedMs) {
          lastRoomClearedMs = clearedAt;
          for (const [k, v] of roomMsgMap.entries()) {
            if (v.ts <= lastRoomClearedMs) roomMsgMap.delete(k);
          }
          renderChatFeed();
        }
        renderPeersStatus(extractActivePeersFromFields(mf, nowMs), targetRoom);
        if (!forceFull && sig === lastRoomMetaSig && roomBootstrapped) return;
        lastRoomMetaSig = sig;
        const listRes = await fetch(`${ROOM_FIRESTORE_BASE}/${encodeURIComponent(targetRoom)}/messages?pageSize=100&t=${Date.now()}`, { cache: 'no-store' });
        if (targetRoom !== roomCode) return;
        if (listRes.ok) {
          const lj = await listRes.json().catch(() => ({}));
          const docs = Array.isArray(lj.documents) ? lj.documents : [];
          const wasBootstrapped = roomBootstrapped;
          let anyNew = false;
          docs.forEach((d) => {
            const f = d.fields || {};
            const id = f.id?.stringValue || d.name?.split('/').pop();
            let payload = null;
            try { if (f.payloadJson?.stringValue) payload = JSON.parse(f.payloadJson.stringValue); } catch (_) {}
            let replyTo = null;
            try { if (f.replyToJson?.stringValue) replyTo = JSON.parse(f.replyToJson.stringValue); } catch (_) {}
            const added = processIncomingRoomMsg({
              id,
              room: targetRoom,
              type: f.type?.stringValue || 'text',
              text: f.text?.stringValue || '',
              payload,
              replyTo,
              senderName: f.senderName?.stringValue || 'ডিভাইস',
              senderClient: f.senderClient?.stringValue || '',
              senderId: f.senderId?.stringValue || '',
              ts: Number(f.ts?.integerValue || f.ts?.doubleValue || 0)
            }, !wasBootstrapped);
            if (added) anyNew = true;
          });
          roomBootstrapped = true;
          if (anyNew || !wasBootstrapped) renderChatFeed();
          return;
        }
      }
    } catch (_) {}

    const stEl = document.getElementById('fc-chat-status');
    if (stEl) {
      stEl.style.color = '#991b1b';
      stEl.textContent = '⚠️ ক্লাউড রুমে সংযোগ করা যাচ্ছে না — ইন্টারনেট দেখুন।';
    }
    } finally {
      roomFetchInFlight = false;
    }
  }

  async function sendRoomMessage({ type = 'text', text = '', payload = null } = {}) {
    const targetRoom = roomCode;
    const ts = Date.now();
    const id = `m_${String(ts).padStart(14, '0')}_${Math.random().toString(36).slice(2, 7)}`;
    const msg = {
      id,
      room: targetRoom,
      type,
      text: String(text || '').trim(),
      payload,
      senderName: myDeviceName,
      senderClient: 'extension',
      senderId: myClientId,
      peerId: myClientId,
      peerName: myDeviceName,
      peerClient: 'extension',
      replyTo: pendingReplyMsg,
      ts,
      createdAt: new Date(ts).toISOString()
    };
    pendingReplyMsg = null;
    const rBar = document.getElementById('fc-chat-reply-bar');
    if (rBar) rBar.style.display = 'none';
    roomMsgMap.set(msg.id, msg);
    renderChatFeed();

    if (socket && socket.connected) {
      socket.emit('room-message', msg);
    }

    let delivered = false;
    try {
      const er = await fetch(ROOM_EDGE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
        cache: 'no-store'
      });
      if (er.ok) {
        const ej = await er.json().catch(() => ({}));
        if (ej && ej.success) {
          delivered = true;
          lastRoomMetaSig = `${targetRoom}|${msg.id}|${lastRoomClearedMs}`;
          roomBootstrapped = true;
          if (Array.isArray(ej.peers)) renderPeersStatus(ej.peers, targetRoom);
        }
      }
    } catch (_) {}

    if (!delivered) {
      try {
        const fields = {
          id: { stringValue: msg.id },
          room: { stringValue: msg.room },
          type: { stringValue: msg.type },
          text: { stringValue: msg.text || '' },
          payloadJson: { stringValue: msg.payload ? JSON.stringify(msg.payload) : '' },
          senderName: { stringValue: msg.senderName },
          senderClient: { stringValue: msg.senderClient },
          senderId: { stringValue: msg.senderId },
          replyToJson: { stringValue: msg.replyTo ? JSON.stringify(msg.replyTo) : '' },
          ts: { integerValue: String(msg.ts) },
          createdAt: { stringValue: msg.createdAt }
        };
        const wRes = await fetch(`${ROOM_FIRESTORE_BASE}/${encodeURIComponent(msg.room)}/messages/${encodeURIComponent(msg.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields }),
          cache: 'no-store'
        });
        if (wRes.ok) {
          delivered = true;
          const preview = (msg.text || msg.payload?.name_bn || msg.payload?.doc_number || 'ডেটা').slice(0, 120);
          const metaFields = {
            room: { stringValue: msg.room },
            last_msg_id: { stringValue: msg.id },
            last_sender: { stringValue: msg.senderName },
            last_preview: { stringValue: preview },
            updated_at: { timestampValue: new Date().toISOString() },
            peers: {
              mapValue: {
                fields: {
                  [myClientId]: {
                    mapValue: {
                      fields: {
                        name: { stringValue: String(myDeviceName || 'পিসি-এক্সটেনশন').slice(0, 50) },
                        client: { stringValue: 'extension' },
                        seenAt: { integerValue: String(ts) }
                      }
                    }
                  }
                }
              }
            }
          };
          const mask = ['room', 'last_msg_id', 'last_sender', 'last_preview', 'updated_at', `peers.${myClientId}`]
            .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
          await fetch(`${ROOM_FIRESTORE_BASE}/${encodeURIComponent(msg.room)}?${mask}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: metaFields }),
            cache: 'no-store'
          }).catch(() => {});
          lastRoomMetaSig = `${targetRoom}|${msg.id}|${lastRoomClearedMs}`;
          roomBootstrapped = true;
        }
      } catch (_) {}
    }

    if (!delivered) {
      showToast('❌ মেসেজ পাঠানো যায়নি! ইন্টারনেট বা রুম কোড পরীক্ষা করুন।');
    }
    return delivered;
  }

  function openChatModal() {
    const cm = ensureChatModal();
    roomUnreadCount = 0;
    updateChatBadge();
    const inpRoom = cm.querySelector('#fc-chat-room-input');
    if (inpRoom && inpRoom.value !== roomCode) inpRoom.value = roomCode;
    cm.style.display = 'flex';
    fetchRoomMessages(true);
    renderChatFeed();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchRoomMessages(false);
  });

  window.__fcOpenChatModal = openChatModal;
  window.__fcSendRoomMessage = sendRoomMessage;
  setTimeout(() => fetchRoomMessages(true), 900);
  setInterval(() => {
    const cm = document.getElementById('fc-chat-modal');
    if (cm && cm.style.display === 'flex') fetchRoomMessages(false);
  }, 2500);
  setInterval(() => {
    const cm = document.getElementById('fc-chat-modal');
    if (!cm || cm.style.display !== 'flex') fetchRoomMessages(false);
  }, 6000);

  // --- WebSocket Connection for Cross-Device Mode ---
  function connectSocket() {
    if (typeof io === 'undefined') return;
    if (window.location.protocol === 'https:' && /^http:\/\/(?!localhost\b|127\.0\.0\.1\b)/i.test(serverUrl)) {
      updateBadgeStatus(true, `ক্লাউড রুম (${roomCode})`);
      return;
    }

    try {
      socket = io(serverUrl, {
        reconnectionAttempts: 2,
        reconnectionDelay: 3000,
        timeout: 2500
      });

      socket.on('connect', () => {
        updateBadgeStatus(true, `সংযুক্ত (${roomCode})`);
        socket.emit('join-room', { room: roomCode, clientName: myDeviceName, clientType: 'extension' });
        const st = document.getElementById('fc-chat-status');
        if (st) st.textContent = `🟢 সার্ভার + ক্লাউড রুম সক্রিয় (${roomCode})`;
      });

      socket.on('disconnect', () => {
        updateBadgeStatus(false, `ক্লাউড রুম (${roomCode})`);
      });

      socket.on('connect_error', () => {
        updateBadgeStatus(false, `ক্লাউড রুম (${roomCode})`);
      });

      socket.on('room-joined', (data) => {
        if (data && Array.isArray(data.history)) {
          let changed = false;
          data.history.forEach(m => { if (processIncomingRoomMsg(m, !roomBootstrapped)) changed = true; });
          roomBootstrapped = true;
          if (changed) renderChatFeed();
        }
      });

      socket.on('room-message', (msg) => {
        if (processIncomingRoomMsg(msg, false)) renderChatFeed();
      });

      socket.on('room-cleared', (info) => {
        lastRoomClearedMs = Number(info?.ts || Date.now());
        roomMsgMap.clear();
        renderChatFeed();
      });

      socket.on('nid-data-extracted', async (payload) => {
        if (payload && payload.success && payload.data) {
          const curFid = scrapeFamilyId() || '';
          const norm = normalizeApplicantPayload({
            ...payload.data,
            family_id: payload.data.family_id || curFid
          });
          lastExtractedData = norm;
          window.__fcLastScannedAny = norm;
          cacheFamilyScan(norm);
          window.__fcStep1FilledKey = '';
          updateWidgetPreview(norm);
          const filled = await fillFormFields(norm, { overwriteExisting: false });
          syncToFirestore(norm);
          updateSummaryBadge(true);
          if (filled) {
            showToast('✅ মোবাইল থেকে এনআইডি তথ্য পূরণ হয়েছে!');
          }
        }
      });
    } catch (err) {
      console.warn('[FamilyCard Assistant] Socket init error:', err);
    }
  }

  function updateBadgeStatus(connected, text) {
    const badge = document.getElementById('fc-assistant-badge');
    if (!badge) return;
    if (connected) {
      badge.classList.add('connected');
      badge.querySelector('.txt').textContent = `NID Auto-Fill: ${text}`;
    } else {
      badge.classList.remove('connected');
      badge.querySelector('.txt').textContent = `NID Auto-Fill: ${text}`;
    }
  }

  function updateWidgetPreview(data) {
    document.getElementById('fc-prev-name-bn').textContent = data.name_bn || '-';
    document.getElementById('fc-prev-name-en').textContent = data.name_en || '-';
    document.getElementById('fc-prev-nid').textContent = data.doc_number || data.nid_number || data.birth_reg_no || '-';
    document.getElementById('fc-prev-dob').textContent = data.dob || '-';
    document.getElementById('fc-prev-gender').textContent = data.gender || '-';
    const fatBn = document.getElementById('fc-prev-fat-bn');
    if (fatBn) fatBn.textContent = data.father_name_bn || '-';
    const fatEn = document.getElementById('fc-prev-fat-en');
    if (fatEn) fatEn.textContent = data.father_name_en || '-';
    const motBn = document.getElementById('fc-prev-mot-bn');
    if (motBn) motBn.textContent = data.mother_name_bn || '-';
    const motEn = document.getElementById('fc-prev-mot-en');
    if (motEn) motEn.textContent = data.mother_name_en || '-';
    const compEl = document.getElementById('fc-prev-completeness');
    if (compEl) {
      const comp = data.ocr_completeness && typeof data.ocr_completeness === 'object' ? data.ocr_completeness : null;
      if (comp) {
        compEl.textContent = `${toBnDigits(comp.scorePct || 0)}% (${toBnDigits(comp.filledCore || 0)}/${toBnDigits(comp.totalCore || 7)})${data.deepseek_en_completed ? ' • DS AI' : ''}`;
        compEl.style.color = comp.scorePct >= 85 ? '#047857' : '#b45309';
      } else {
        compEl.textContent = data.deepseek_en_completed ? 'DS AI সম্পন্ন' : '-';
      }
    }
  }

  function showToast(message) {
    const existing = document.querySelector('.fc-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'fc-toast';
    toast.textContent = String(message || '');
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.5s ease';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 500);
    }, 4000);
  }

  // --- Vuetify Robust Form Filler ---

  function attachInputEditGuard(input) {
    if (!input || input.__fcEditGuardAttached) return;
    input.__fcEditGuardAttached = true;
    input.addEventListener('input', (e) => {
      if (e.isTrusted && input.dataset) input.dataset.fcUserEdited = 'true';
    });
  }

  function setReactiveValue(input, value, opts = {}) {
    if (!input || value === undefined || value === null || value === '') return false;
    if (input.disabled) return false;
    const isDateInput = /DD\/MM/i.test(input.placeholder || '') || input.getAttribute('aria-haspopup') === 'true';
    if (input.readOnly && !isDateInput && input.closest('.v-input--is-readonly')) return false;

    const strVal = String(value).trim();
    if (!strVal) return false;

    const curVal = String(input.value || '').trim();
    if (!opts.ignoreUserGuard && input.dataset?.fcUserEdited === 'true' && curVal) return false;
    if (opts.respectNonEmpty && curVal) {
      return curVal === strVal;
    }

    if (curVal === strVal) {
      const container = input.closest('.v-input') || input;
      if (!container.dataset.fcHighlighted) {
        container.dataset.fcHighlighted = '1';
        container.style.transition = 'background-color 0.4s ease';
        const oldBg = container.style.backgroundColor;
        container.style.backgroundColor = 'rgba(76, 175, 80, 0.14)';
        setTimeout(() => { container.style.backgroundColor = oldBg; delete container.dataset.fcHighlighted; }, 1600);
      }
      return true;
    }

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(input, strVal);
    } else {
      input.value = strVal;
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));

    if (isDateInput) {
      setTimeout(() => {
        if (document.querySelector('.v-menu__content.menuable__content__active .v-picker--date')) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
      }, 60);
    }

    const container = input.closest('.v-input') || input;
    container.style.transition = 'background-color 0.4s ease';
    const oldBg = container.style.backgroundColor;
    container.style.backgroundColor = 'rgba(76, 175, 80, 0.2)';
    setTimeout(() => {
      container.style.backgroundColor = oldBg;
    }, 2400);

    return true;
  }

  function isElementVisible(el) {
    if (!el) return false;
    if (el.style && el.style.display === 'none') return false;
    try {
      const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    } catch (_) {}
    return true;
  }

  // Note: Live portal keeps v-expansion-panel--active on hidden panels (display: none).
  function isPanelActiveVisible(panel) {
    return Boolean(panel && isElementVisible(panel));
  }

  function resolveDocNumberAndType(data) {
    if (!data || typeof data !== 'object') return { docType: 'nid', docNumber: '' };
    const clean = (raw) => normalizeDigits(raw || '').replace(/[^0-9]/g, '');
    const pick = (cands, lens) => {
      const list = cands.map(clean).filter(Boolean);
      for (const l of lens) {
        const hit = list.find(x => x.length === l);
        if (hit) return hit;
      }
      return list[0] || '';
    };
    const rawBrc = clean(data.birth_reg_no);
    const rawNid = clean(data.nid_number);
    const rawDoc = clean(data.doc_number);
    const isBrc = data.doc_type === 'birth_certificate' || (!rawNid && rawBrc.length === 17);
    const docType = isBrc ? 'birth_certificate' : 'nid';
    let docNumber = isBrc
      ? pick([rawBrc, rawDoc, rawNid], [17])
      : pick([rawNid, rawDoc, rawBrc], [10, 17, 13]);
    if (!isBrc && docNumber.length === 13 && data.dob) {
      const ym = String(standardizeDate(data.dob)).match(/\b(19\d{2}|20\d{2})\b/);
      if (ym) docNumber = ym[1] + docNumber;
    }
    return { docType, docNumber };
  }

  function isRadioSelected(radioWrap) {
    if (!radioWrap) return false;
    const inp = radioWrap.querySelector('input[type="radio"]');
    return Boolean((inp && (inp.checked || inp.getAttribute('aria-checked') === 'true')) || radioWrap.classList.contains('v-item--active'));
  }

  async function ensureVerificationRadio(scope, isBirthReg) {
    if (!scope) return false;
    const radios = Array.from(scope.querySelectorAll('.v-radio'));
    if (!radios.length) return false;
    const target = radios.find((rl) => {
      const txt = normalizeBn(rl.textContent || '');
      return isBirthReg
        ? (txt.includes('জন্ম নিবন্ধন') || txt.includes('নিবন্ধন'))
        : (txt.includes('জাতীয় পরিচিতি') || txt.includes('জাতীয় পরিচিতি') || txt.includes('এনআইডি') || txt.includes('NID'));
    });
    if (!target) return false;
    if (!isRadioSelected(target)) {
      const inp = target.querySelector('input[type="radio"]');
      const label = target.querySelector('label');
      if (label) label.click();
      else if (inp) inp.click();
      else target.click();
      await new Promise((r) => setTimeout(r, 260));
      return true;
    }
    return false;
  }

  function isFillableTextInput(inp) {
    if (!inp || inp.disabled) return false;
    const t = String(inp.type || 'text').toLowerCase();
    if (['hidden', 'radio', 'checkbox', 'file', 'button', 'submit', 'reset', 'image'].includes(t)) return false;
    if (inp.closest('.v-radio, .v-checkbox, .v-input--selection-controls, [role="radiogroup"]')) return false;
    if (inp.readOnly && !/DD\/MM/i.test(inp.placeholder || '') && (inp.closest('.v-input--is-readonly') || (inp.closest('.v-select') && !inp.closest('.v-autocomplete')))) return false;
    return true;
  }

  function collectTabFieldEntries(scope) {
    if (!scope) return [];
    const entries = [];
    const cols = Array.from(scope.querySelectorAll('.col, [class*="col-"]'));
    for (const col of cols) {
      const label = Array.from(col.querySelectorAll('label')).find(l => !l.closest('.v-radio, .v-checkbox, .v-input--selection-controls, [role="radiogroup"]'));
      if (!label) continue;
      const labelText = normalizeBn(label.textContent || '');
      if (!labelText) continue;
      const selEl = col.querySelector('.v-select');
      const selValEl = selEl ? selEl.querySelector('.v-select__selection') : null;
      const selText = selValEl ? String(selValEl.textContent || '').trim() : '';
      let rawInput = null;
      if (label.htmlFor) {
        const byFor = document.getElementById(label.htmlFor);
        if (byFor && scope.contains(byFor) && !/^(hidden|radio|checkbox|button|submit|file)$/i.test(byFor.type || '')) rawInput = byFor;
      }
      if (!rawInput) {
        rawInput = Array.from(col.querySelectorAll('input, textarea')).find(el => !/^(hidden|radio|checkbox|button|submit|file)$/i.test(el.type || '')) || null;
      }
      const input = (rawInput && isFillableTextInput(rawInput)) ? rawInput : (Array.from(col.querySelectorAll('input, textarea')).find(isFillableTextInput) || null);
      const value = selText || (rawInput ? String(rawInput.value || '').trim() : '') || '';
      entries.push({ col, label, labelText, input, rawInput, vSelect: selEl, value });
    }
    return entries;
  }

  function findEntryByKeywords(entries, keywords) {
    const normKeys = keywords.map(k => normalizeBn(k));
    return entries.find(e => normKeys.some(k => e.labelText.includes(k))) || null;
  }

  function findInputByLabelText(keywords, rootEl = null) {
    const scope = rootEl || document;
    const normKeys = keywords.map(k => normalizeBn(k));
    const labels = Array.from(scope.querySelectorAll('label'));
    for (const label of labels) {
      if (label.closest('.v-radio, .v-checkbox, .v-input--selection-controls, [role="radiogroup"]')) continue;
      const text = normalizeBn(label.textContent || '');
      if (!normKeys.some(k => text.includes(k))) continue;
      if (label.htmlFor) {
        const inp = document.getElementById(label.htmlFor);
        if (isFillableTextInput(inp) && (!rootEl || rootEl.contains(inp))) return inp;
      }
      const vInput = label.closest('.v-input');
      if (vInput) {
        const cand = Array.from(vInput.querySelectorAll('input, textarea')).find(isFillableTextInput);
        if (cand) return cand;
      }
      let cur = label.parentElement;
      for (let depth = 0; cur && cur !== scope && depth < 5; depth++, cur = cur.parentElement) {
        if (cur.matches('.v-radio, .v-checkbox, [role="radiogroup"]')) continue;
        const cand = Array.from(cur.querySelectorAll('input, textarea')).find(isFillableTextInput);
        if (cand) return cand;
        if (cur.matches('.col, [class*="col-"]')) break;
      }
    }
    return null;
  }

  function findStep0DocNumberInput(tab0, isBirthReg) {
    const numKeys = isBirthReg
      ? ['জন্ম নিবন্ধন নম্বর', 'নিবন্ধন নম্বর', 'জন্ম নিবন্ধন']
      : ['জাতীয় পরিচিতি নম্বর (এনআইডি)', 'জাতীয় পরিচিতি নম্বর', 'জাতীয় পরিচিতি নম্বর', 'জাতীয় পরিচয়পত্র নম্বর', 'এনআইডি নম্বর', 'পরিচিতি নম্বর'];
    const byLabel = findInputByLabelText(numKeys, tab0);
    if (byLabel) return byLabel;

    const scope = tab0 || document;
    const candidates = Array.from(scope.querySelectorAll('input')).filter(isFillableTextInput);
    const nonDob = candidates.filter((inp) => !/DD\/MM|YYYY/i.test(inp.placeholder || ''));
    const byContext = nonDob.find((inp) => {
      const box = inp.closest('.col, [class*="col-"], .v-input, .row');
      const txt = normalizeBn(box?.textContent || '');
      return isBirthReg
        ? (txt.includes('নিবন্ধন') || txt.includes('birth'))
        : (txt.includes('পরিচিতি') || txt.includes('এনআইডি') || txt.includes('nid'));
    });
    if (byContext) return byContext;

    if (tab0 && nonDob.length >= 3) {
      return nonDob[2];
    }
    return document.getElementById('input-594') || document.getElementById('input-215');
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

  // Helper to standardize Date of Birth (supports English & Bengali months/digits/ordinals) to DD/MM/YYYY
  function standardizeDate(dobStr) {
    if (!dobStr) return '';
    let str = normalizeDigits(dobStr)
      .normalize('NFC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/(\d{1,2})\s*(?:ইং|ই|শে|লা|রা|ঠা|st|nd|rd|th)(?=[\s,./\-\u0980-\u09FF])/gi, '$1 ')
      .replace(/[,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // ISO: YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = str.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (isoMatch) {
      return `${isoMatch[3].padStart(2, '0')}/${isoMatch[2].padStart(2, '0')}/${isoMatch[1]}`;
    }

    // English month names: 15 Aug 1985
    const months = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };
    const monthMatch = str.match(/^(\d{1,2})[\s\-,.]+([a-zA-Z]{3,})[\s\-,.]+(\d{4})/i);
    if (monthMatch) {
      const m = months[monthMatch[2].toLowerCase().substring(0, 3)] || '';
      if (m) return `${monthMatch[1].padStart(2, '0')}/${m}/${monthMatch[3]}`;
    }

    // Bengali month names: ১৪ মে ১৯৮৫ / ১২ই জানুয়ারি, ২০১২
    const bnPrefixes = [
      ['জানু', '01'], ['ফেব', '02'], ['মার', '03'], ['এপ্রি', '04'],
      ['মে', '05'], ['জুন', '06'], ['জুল', '07'], ['আগ', '08'],
      ['সেপ', '09'], ['অক্ট', '10'], ['অক', '10'], ['নভ', '11'], ['ডিস', '12']
    ];
    const bnMatch = str.match(/^(\d{1,2})[\s\-,/.]+([\u0980-\u09FF]+)[\s\-,/.]+(\d{4})/);
    if (bnMatch) {
      const hit = bnPrefixes.find(([p]) => bnMatch[2].startsWith(p));
      if (hit) return `${bnMatch[1].padStart(2, '0')}/${hit[1]}/${bnMatch[3]}`;
    }

    // Standard DD/MM/YYYY
    str = str.replace(/[-\.]/g, '/');
    const dmyMatch = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dmyMatch) {
      return `${dmyMatch[1].padStart(2, '0')}/${dmyMatch[2].padStart(2, '0')}/${dmyMatch[3]}`;
    }

    return str;
  }

  // Fast, layout-thrashing-free family ID lookup with short-lived cache
  let cachedFamilyIdVal = null;
  let cachedFamilyIdAt = 0;

  function scrapeFamilyId(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && now - cachedFamilyIdAt < 350 && cachedFamilyIdVal !== null) {
      return cachedFamilyIdVal;
    }
    let found = null;
    const badge = document.querySelector('.family-card-draft-application-id, [class*="draft-application-id"]');
    if (badge) {
      const m = (badge.textContent || '').match(/([০-৯0-9]{4,})/);
      if (m) found = normalizeDigits(m[1]);
    }
    if (!found) {
      const header = document.querySelector('.v-card__title, .family-card-header, header, h1, h2') || document.body;
      const m = (header.textContent || '').match(/পরিবার আইডি:\s*([০-৯0-9]+)/);
      if (m) found = normalizeDigits(m[1]);
    }
    cachedFamilyIdVal = found || '';
    cachedFamilyIdAt = now;
    return found || null;
  }

  // Direct Firestore REST API Sync (rajbari-city-app-16601)
  async function syncToFirestore(data) {
    try {
      const docId = getSafeFamilyDocId(data);
      if (!docId) {
        console.warn('[FamilyCard Extension] Skipped Firestore sync: no family_id or document number');
        return;
      }
      const familyId = scrapeFamilyId() || data.family_id || '';
      const fields = {
        doc_type: { stringValue: data.doc_type || 'nid' },
        nid_number: { stringValue: data.nid_number || '' },
        birth_reg_no: { stringValue: data.birth_reg_no || '' },
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
        marital_status: { stringValue: data.marital_status || 'বিবাহিত' },
        religion: { stringValue: data.religion || 'ইসলাম' },
        mobile_number: { stringValue: data.mobile_number || '' },
        ocr_model_used: { stringValue: data.ocr_model_used || '' },
        synced_at: { timestampValue: new Date().toISOString() }
      };
      if (familyId) fields.family_id = { stringValue: normalizeDigits(familyId) };

      const updateMask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
      const url = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(docId)}?${updateMask}`;

      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
      console.log('[FamilyCard Extension] Firestore synced:', docId);
    } catch (e) {
      console.warn('[FamilyCard Extension] Firestore sync notice:', e.message);
    }
  }

  function selectDropdownByLabel(labelKeywords, targetValueText, rootEl = null, opts = {}) {
    return new Promise((resolve) => {
      if (!targetValueText) return resolve(false);
      const scope = rootEl || document;
      const normKeys = labelKeywords.map(k => normalizeBn(k));
      const normTarget = normalizeBn(targetValueText);
      const labels = Array.from(scope.querySelectorAll('label'));
      let container = null;
      for (const l of labels) {
        if (l.closest('.v-radio, .v-checkbox, .v-input--selection-controls, [role="radiogroup"]')) continue;
        if (normKeys.some(k => normalizeBn(l.textContent || '').includes(k))) {
          let cur = l.parentElement;
          for (let d = 0; cur && cur !== scope && d < 5; d++, cur = cur.parentElement) {
            if (cur.querySelector('.v-input__slot')) { container = cur; break; }
            if (cur.matches('.col, [class*="col-"]')) break;
          }
          if (!container) container = l.closest('.col, [class*="col-"], .v-input') || l.parentElement;
          if (container) break;
        }
      }

      if (!container) return resolve(false);

      if (!container.__fcDdGuardAttached) {
        container.__fcDdGuardAttached = true;
        container.addEventListener('mousedown', (e) => {
          if (e.isTrusted) container.dataset.fcUserEdited = 'true';
        }, true);
      }

      const currentSelection = container.querySelector('.v-select__selection');
      const curText = normalizeBn(currentSelection ? currentSelection.textContent : '');
      if (curText && curText.includes(normTarget)) return resolve(true);
      if (!opts.ignoreUserGuard && container.dataset.fcUserEdited === 'true' && curText) return resolve(false);
      if (opts.respectNonEmpty && curText) return resolve(false);

      const clickTarget = container.querySelector('.v-input__slot') || container.querySelector('input');
      if (!clickTarget) return resolve(false);

      const listId = clickTarget.getAttribute('aria-owns') || container.querySelector('[aria-owns]')?.getAttribute('aria-owns');
      clickTarget.click();
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        let menuItems = [];
        if (listId) {
          const listEl = document.getElementById(listId);
          if (listEl) menuItems = Array.from(listEl.querySelectorAll('.v-list-item'));
        }
        if (menuItems.length === 0) {
          menuItems = Array.from(document.querySelectorAll('.v-menu__content.menuable__content__active .v-list-item, .v-menu__content.menuable__content__active .v-list-item__title'));
        }
        if (menuItems.length === 0 && attempts >= 3) {
          menuItems = Array.from(document.querySelectorAll('.v-menu__content .v-list-item, .v-menu__content .v-list-item__title')).filter(el => el.offsetParent !== null);
        }

        const exact = menuItems.find(item => normalizeBn(item.textContent) === normTarget);
        const match = exact || menuItems.find(item => normalizeBn(item.textContent).includes(normTarget));
        if (match) {
          const clickable = match.closest('.v-list-item') || match;
          clickable.click();
          clearInterval(interval);
          setTimeout(() => resolve(true), 60);
          return;
        }
        if (attempts >= 12) {
          clearInterval(interval);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          resolve(false);
        }
      }, 55);
    });
  }

  let isFillingFormFields = false;
  // Main Autofill Routine
  async function fillFormFields(rawData, opts = {}) {
    if (!rawData || isFillingFormFields) return false;
    const data = normalizeApplicantPayload(rawData);
    if (!data) return false;
    const overwriteExisting = Boolean(opts.overwriteExisting);
    isFillingFormFields = true;
    let filledCount = 0;

    try {
      const tab0 = document.querySelector('[data-family-card-tab="0"]');
      const tab1 = document.querySelector('[data-family-card-tab="1"]');
      const { docType, docNumber } = resolveDocNumberAndType(data);
      const isBirthReg = docType === 'birth_certificate';
      const valOpts = overwriteExisting
        ? { ignoreUserGuard: true }
        : { respectNonEmpty: true };

      // Step 0: Verification & Basic Identity (fill ONLY when tab0 is visible or absent)
      if (!tab0 || isElementVisible(tab0)) {
        const scope0 = tab0 || document;
        await ensureVerificationRadio(scope0, isBirthReg);

        const entries0 = tab0 ? collectTabFieldEntries(tab0) : [];
        const nameBnInp = findEntryByKeywords(entries0, ['সম্পূর্ণ নাম (বাংলা)', 'পূর্ণ নাম (বাংলা)', 'নাম (বাংলা)'])?.input || findInputByLabelText(['সম্পূর্ণ নাম (বাংলা)', 'পূর্ণ নাম (বাংলা)', 'নাম (বাংলা)'], tab0) || findInputByLabelText(['সম্পূর্ণ নাম (বাংলা)']) || document.getElementById('input-211');
        if (nameBnInp) attachInputEditGuard(nameBnInp);
        if (data.name_bn && setReactiveValue(nameBnInp, data.name_bn, valOpts)) filledCount++;

        const nameEnInp = findEntryByKeywords(entries0, ['সম্পূর্ণ নাম (ইংরেজি)', 'পূর্ণ নাম (ইংরেজি)', 'নাম (ইংরেজি)'])?.input || findInputByLabelText(['সম্পূর্ণ নাম (ইংরেজি)', 'পূর্ণ নাম (ইংরেজি)', 'নাম (ইংরেজি)'], tab0) || findInputByLabelText(['সম্পূর্ণ নাম (ইংরেজি)']) || document.getElementById('input-213');
        if (nameEnInp) attachInputEditGuard(nameEnInp);
        if (data.name_en && setReactiveValue(nameEnInp, String(data.name_en).toUpperCase().trim(), valOpts)) filledCount++;

        if (docNumber) {
          let inp = findStep0DocNumberInput(tab0, isBirthReg);
          for (let t = 0; !inp && t < 5; t++) {
            await new Promise(r => setTimeout(r, 80));
            inp = findStep0DocNumberInput(tab0, isBirthReg);
          }
          if (inp) {
            attachInputEditGuard(inp);
            if (setReactiveValue(inp, docNumber, valOpts)) filledCount++;
          }
        }

        const dobInp = findEntryByKeywords(entries0, ['জন্ম তারিখ'])?.input || findInputByLabelText(['জন্ম তারিখ'], tab0) || findInputByLabelText(['জন্ম তারিখ']) || scope0.querySelector('input[placeholder*="DD/MM"]') || document.getElementById('input-221');
        if (dobInp) attachInputEditGuard(dobInp);
        if (data.dob && setReactiveValue(dobInp, standardizeDate(data.dob), valOpts)) filledCount++;

        if (data.gender) {
          if (await selectDropdownByLabel(['লিঙ্গ'], normalizeGenderValue(data.gender), scope0, { respectNonEmpty: !overwriteExisting, ignoreUserGuard: overwriteExisting })) filledCount++;
        }
      }

      // Step 2 (tab1 - ব্যক্তিগত তথ্য): Select marital & religion first so conditional spouse inputs render before scanning
      if (!tab1 || isElementVisible(tab1)) {
        const scope1 = tab1 || document;
        const targetMarital = data.marital_status || data.marital_status_suggestion || 'বিবাহিত';
        const targetReligion = data.religion || 'ইসলাম';

        if (targetMarital) {
          if (await selectDropdownByLabel(['বৈবাহিক অবস্থা'], targetMarital, scope1, { respectNonEmpty: !overwriteExisting, ignoreUserGuard: overwriteExisting })) filledCount++;
        }
        if (targetReligion) {
          if (await selectDropdownByLabel(['ধর্ম'], targetReligion, scope1, { respectNonEmpty: !overwriteExisting, ignoreUserGuard: overwriteExisting })) filledCount++;
        }

        const entries1 = tab1 ? collectTabFieldEntries(tab1) : [];
        const pick1 = (keys, fallbackIds = []) => {
          let inp = findEntryByKeywords(entries1, keys)?.input || findInputByLabelText(keys, tab1);
          if (!inp) {
            for (const fid of fallbackIds) {
              const cand = document.getElementById(fid);
              if (cand && (!tab1 || tab1.contains(cand)) && isFillableTextInput(cand)) { inp = cand; break; }
            }
          }
          if (inp) attachInputEditGuard(inp);
          return inp;
        };

        const fBnInp = pick1(['পিতার নাম (বাংলা)'], ['input-1687', 'input-1286', 'input-242']);
        if (data.father_name_bn && setReactiveValue(fBnInp, data.father_name_bn, valOpts)) filledCount++;

        const fEnInp = pick1(['পিতার নাম (ইংরেজি)'], ['input-1689', 'input-1288', 'input-244']);
        if (data.father_name_en && setReactiveValue(fEnInp, String(data.father_name_en).toUpperCase().trim(), valOpts)) filledCount++;

        const mBnInp = pick1(['মাতার নাম (বাংলা)'], ['input-1691', 'input-1290', 'input-246']);
        if (data.mother_name_bn && setReactiveValue(mBnInp, data.mother_name_bn, valOpts)) filledCount++;

        const mEnInp = pick1(['মাতার নাম (ইংরেজি)'], ['input-1693', 'input-1292', 'input-248']);
        if (data.mother_name_en && setReactiveValue(mEnInp, String(data.mother_name_en).toUpperCase().trim(), valOpts)) filledCount++;

        const mobInp = pick1(['মোবাইল নম্বর'], ['input-1695', 'input-1294', 'input-250']);
        if (data.mobile_number && setReactiveValue(mobInp, normalizeMobileNumber(data.mobile_number), valOpts)) filledCount++;

        if (data.spouse_name_bn || data.spouse_name_en) {
          const spBnInp = pick1(['স্বামীর নাম (বাংলা)', 'স্ত্রীর নাম (বাংলা)', 'স্বামী/স্ত্রীর নাম (বাংলা)']);
          if (spBnInp && data.spouse_name_bn && setReactiveValue(spBnInp, data.spouse_name_bn, valOpts)) filledCount++;
          const spEnInp = pick1(['স্বামীর নাম (ইংরেজি)', 'স্ত্রীর নাম (ইংরেজি)', 'স্বামী/স্ত্রীর নাম (ইংরেজি)']);
          if (spEnInp && data.spouse_name_en && setReactiveValue(spEnInp, String(data.spouse_name_en).toUpperCase().trim(), valOpts)) filledCount++;
        }

        if (tab1) {
          window.__fcStep1FilledKey = `${scrapeFamilyId() || ''}_${docNumber || ''}`;
          injectSection2Toolbar(tab1);
        }
      }

      handleSection4Address();
      return filledCount > 0;
    } finally {
      isFillingFormFields = false;
    }
  }

  // --- STEP 2 PERSONAL INFO HELPER TOOLBAR & LIVE EDIT SYNC ---
  let step2SyncTimer = null;

  function readStep2FieldState(tab1) {
    const entries = collectTabFieldEntries(tab1);
    const val = (keys) => findEntryByKeywords(entries, keys)?.value || '';
    const fatherBn = val(['পিতার নাম (বাংলা)']);
    const fatherEn = val(['পিতার নাম (ইংরেজি)']);
    const motherBn = val(['মাতার নাম (বাংলা)']);
    const motherEn = val(['মাতার নাম (ইংরেজি)']);
    const mobile = normalizeMobileNumber(val(['মোবাইল নম্বর']));
    const marital = val(['বৈবাহিক অবস্থা']);
    const religion = val(['ধর্ম']);
    const age = val(['বয়স', 'বয়স']);
    const doneCount = [fatherBn, fatherEn, motherBn, motherEn, mobile, marital, religion].filter(Boolean).length;
    return { fatherBn, fatherEn, motherBn, motherEn, mobile, marital, religion, age, doneCount, entries };
  }

  function injectSection2Toolbar(tab1) {
    if (!tab1 || !isPanelActiveVisible(tab1)) return;
    const wrap = tab1.querySelector('.v-expansion-panel-content__wrap') || tab1;
    if (!wrap) return;

    const state = readStep2FieldState(tab1);
    const fid = scrapeFamilyId() || '';
    const cached = (lastExtractedData && (!fid || !lastExtractedData.family_id || lastExtractedData.family_id === fid))
      ? lastExtractedData
      : getCachedFamilyScan(fid, false);

    if (!tab1.__fcS2EditSyncAttached) {
      tab1.__fcS2EditSyncAttached = true;
      tab1.addEventListener('input', (e) => {
        if (!e.isTrusted) return;
        const inp = e.target;
        if (inp && inp.dataset) inp.dataset.fcUserEdited = 'true';
        clearTimeout(step2SyncTimer);
        step2SyncTimer = setTimeout(() => {
          const s2 = readStep2FieldState(tab1);
          if (lastExtractedData) {
            if (s2.fatherBn) lastExtractedData.father_name_bn = s2.fatherBn;
            if (s2.fatherEn) lastExtractedData.father_name_en = s2.fatherEn.toUpperCase();
            if (s2.motherBn) lastExtractedData.mother_name_bn = s2.motherBn;
            if (s2.motherEn) lastExtractedData.mother_name_en = s2.motherEn.toUpperCase();
            if (s2.mobile) lastExtractedData.mobile_number = s2.mobile;
            if (s2.marital) lastExtractedData.marital_status = s2.marital;
            if (s2.religion) lastExtractedData.religion = s2.religion;
            cacheFamilyScan(lastExtractedData);
            updateWidgetPreview(lastExtractedData);
          }
          injectSection2Toolbar(tab1);
        }, 450);
      });
    }

    const mobileOk = /^01[3-9]\d{8}$/.test(state.mobile);
    const cacheTag = cached
      ? `✅ স্ক্যান ডাটা প্রস্তুত (${escapeHtml(cached.name_bn || cached.doc_number || 'সংরক্ষিত')})`
      : (fid ? `⚠️ আইডি ${toBnDigits(fid)} এর স্ক্যান নেই` : '⚠️ এখনো NID স্ক্যান হয়নি');

    const statusHtml = `
      <div class="fc-s2-head">
        <span>👤 <b>স্টেপ ২: ব্যক্তিগত তথ্য প্রসেসর</b> ${state.age ? `<small style="opacity:0.8;">(বয়স: ${escapeHtml(state.age)})</small>` : ''}</span>
        <span class="fc-s2-pill ${state.doneCount >= 6 ? 'ok' : ''}">${toBnDigits(state.doneCount)}/৭ ফিল্ড সম্পন্ন</span>
      </div>
      <div class="fc-s2-meta">
        <span>${cacheTag}</span>
        <span>${state.mobile ? (mobileOk ? `📱 ${escapeHtml(state.mobile)} ✅` : `📱 ${escapeHtml(state.mobile)} ⚠️ (১১ ডিজিট দিন)`) : '📱 মোবাইল ফাঁকা'}</span>
      </div>
      <div class="fc-s2-actions">
        <button type="button" class="fc-s2-btn primary" data-s2-act="refill">⚡ স্ক্যান থেকে পূরণ</button>
        <button type="button" class="fc-s2-btn" data-s2-act="defaults">🕌 বিবাহিত + ইসলাম</button>
        ${fid ? '<button type="button" class="fc-s2-btn accent" data-s2-act="cloud">☁️ ক্লাউড লোড</button>' : ''}
      </div>
    `;

    let bar = wrap.querySelector('#fc-section2-toolbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fc-section2-toolbar';
      wrap.insertBefore(bar, wrap.firstChild);
    }
    if (bar.dataset.lastHtml !== statusHtml) {
      bar.dataset.lastHtml = statusHtml;
      bar.innerHTML = statusHtml;
    }

    if (!bar.__fcBound) {
      bar.__fcBound = true;
      bar.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-s2-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-s2-act');
        if (act === 'refill') {
          const curFid = scrapeFamilyId() || '';
          const src = (lastExtractedData && (!curFid || !lastExtractedData.family_id || lastExtractedData.family_id === curFid))
            ? lastExtractedData
            : getCachedFamilyScan(curFid, true);
          if (!src) {
            showToast('⚠️ এই পরিবারের জন্য কোনো স্ক্যান ডাটা নেই! "📸 NID স্ক্যান" করুন।');
            openScannerModal();
            return;
          }
          lastExtractedData = src;
          await fillFormFields(src, { overwriteExisting: true });
          injectSection2Toolbar(tab1);
          updateSummaryBadge(true);
          showToast('✅ স্টেপ ২ তথ্য পুনরায় পূরণ করা হয়েছে!');
        } else if (act === 'defaults') {
          await selectDropdownByLabel(['বৈবাহিক অবস্থা'], 'বিবাহিত', tab1, { ignoreUserGuard: true });
          await selectDropdownByLabel(['ধর্ম'], 'ইসলাম', tab1, { ignoreUserGuard: true });
          const modalMob = normalizeMobileNumber(document.getElementById('fc-modal-mobile')?.value || localStorage.getItem('fc_default_mobile') || '');
          const cur = readStep2FieldState(tab1);
          if (modalMob && !cur.mobile) {
            const mobInp = findInputByLabelText(['মোবাইল নম্বর'], tab1) || document.getElementById('input-1695') || document.getElementById('input-1294');
            if (mobInp) setReactiveValue(mobInp, modalMob, { ignoreUserGuard: true });
          }
          injectSection2Toolbar(tab1);
          showToast('✅ বৈবাহিক অবস্থা ও ধর্ম সেট করা হয়েছে!');
        } else if (act === 'cloud') {
          const curFid = scrapeFamilyId() || '';
          if (!curFid) return;
          btn.disabled = true;
          btn.textContent = '⏳ লোড হচ্ছে...';
          const loaded = await fetchFirestoreApplicant(curFid);
          btn.disabled = false;
          btn.textContent = '☁️ ক্লাউড লোড';
          if (loaded) {
            lastExtractedData = loaded;
            updateWidgetPreview(loaded);
            await fillFormFields(loaded, { overwriteExisting: true });
            injectSection2Toolbar(tab1);
            updateSummaryBadge(true);
            showToast(`☁️ ক্লাউড থেকে আইডি ${curFid}-এর ডাটা লোড সম্পন্ন!`);
          } else {
            showToast(`⚠️ ক্লাউডে আইডি ${curFid}-এর সংরক্ষিত ডাটা পাওয়া যায়নি।`);
          }
        }
      });
    }
  }

  // --- SECTION 3: IMAGE GUARDIAN & COMPLIANCE SYSTEM ---
  function compressAndFitImage(file, maxW, maxH, maxBytes = 190 * 1024, preserveIfCompliant = false) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          let width = img.naturalWidth || img.width;
          let height = img.naturalHeight || img.height;
          if (!width || !height) {
            reject(new Error('Invalid image dimensions'));
            return;
          }

          const isCleanType = /^image\/(jpeg|png)$/i.test(file.type || '') && /\.(jpe?g|png)$/i.test(file.name || '');
          if (preserveIfCompliant && isCleanType && file.size <= maxBytes && width <= maxW && height <= maxH) {
            resolve({
              file,
              width,
              height,
              sizeKb: Math.max(1, Math.round(file.size / 1024)),
              passthrough: true
            });
            return;
          }

          if (width > maxW || height > maxH) {
            const ratio = Math.min(maxW / width, maxH / height);
            width = Math.max(1, Math.round(width * ratio));
            height = Math.max(1, Math.round(height * ratio));
          }

          let quality = 0.88;
          const canvas = document.createElement('canvas');
          function drawScaled(w, h) {
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
          }
          drawScaled(width, height);

          function tryEncode() {
            canvas.toBlob((blob) => {
              if (!blob) {
                reject(new Error('Canvas blob generation failed'));
                return;
              }
              if (blob.size > maxBytes) {
                if (quality > 0.28) {
                  quality -= 0.12;
                  tryEncode();
                  return;
                }
                if (width > 140 && height > 100) {
                  width = Math.round(width * 0.78);
                  height = Math.round(height * 0.78);
                  quality = 0.72;
                  drawScaled(width, height);
                  tryEncode();
                  return;
                }
              }
              const baseName = (file.name || 'image.jpg').replace(/\.[^/.]+$/, "");
              const optimizedFile = new File([blob], `${baseName}_optimized.jpg`, {
                type: 'image/jpeg',
                lastModified: Date.now()
              });
              resolve({
                file: optimizedFile,
                width,
                height,
                sizeKb: Math.max(1, Math.round(blob.size / 1024)),
                passthrough: false
              });
            }, 'image/jpeg', quality);
          }
          tryEncode();
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function attachMediaGuardian(inputEl, slotType) {
    if (!inputEl || inputEl.__fcGuardianAttached) return;
    inputEl.__fcGuardianAttached = true;

    inputEl.addEventListener('change', async (e) => {
      if (inputEl.__isOptimizing) return;
      const file = inputEl.files?.[0];
      if (!file) {
        traceSection3Media();
        return;
      }

      const isHouse = (slotType === 'house');
      const isSig = (slotType === 'signature');
      const maxW = isHouse ? 600 : 800;
      const maxH = isHouse ? 400 : (isSig ? 400 : 800);
      const maxBytes = 190 * 1024;
      const needsFormatConvert = !/^image\/(jpeg|png)$/i.test(file.type || '') || !/\.(jpe?g|png)$/i.test(file.name || '');

      if (file.size > maxBytes || isHouse || needsFormatConvert) {
        e.stopImmediatePropagation();
        try {
          inputEl.__isOptimizing = true;
          const label = isHouse ? 'বাড়ির ছবি' : (isSig ? 'স্বাক্ষর' : 'আবেদনকারীর ছবি');
          const result = await compressAndFitImage(file, maxW, maxH, maxBytes, !needsFormatConvert && file.size <= maxBytes);

          if (!result.passthrough) {
            const dt = new DataTransfer();
            dt.items.add(result.file);
            inputEl.files = dt.files;
            showToast(`✅ ${label} সরকারি মাপে ফিট (${result.sizeKb} KB, ${result.width}×${result.height}) হয়েছে!`);
          } else {
            showToast(`✅ ${label} যাচাইকৃত (${result.sizeKb} KB, ${result.width}×${result.height})`);
          }

          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (err) {
          console.warn('[MediaGuardian] Failed to optimize image:', err);
          showToast('⚠️ ছবিটি JPG/PNG ফরম্যাটে ২০০ KB-এর নিচে দিয়ে আবার চেষ্টা করুন।');
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        } finally {
          inputEl.__isOptimizing = false;
        }
      }

      setTimeout(traceSection3Media, 350);
    }, true);
  }

  // --- SECTION 3: REAL-TIME HUD & SCRAPING TRACER ---
  function injectSection3HUD() {
    if (document.getElementById('fc-section3-hud')) return;

    const hud = document.createElement('div');
    hud.id = 'fc-section3-hud';
    hud.innerHTML = `
      <div class="fc-s3-header" id="fc-s3-toggle-btn">
        <h4>📋 সেকশন ৩: ছবি ও সনাক্তকরণ (<span id="fc-s3-ratio">০/৩</span>)</h4>
        <span class="fc-s3-toggle" id="fc-s3-min-icon">▾</span>
      </div>
      <div class="fc-s3-body">
        <div class="fc-s3-progress-wrap">
          <div id="fc-s3-progress" class="fc-s3-progress-bar"></div>
        </div>
        
        <div class="fc-s3-item">
          <span class="fc-s3-item-lbl">👤 আবেদনকারীর ছবি</span>
          <span id="fc-s3-status-photo" class="fc-s3-badge fc-s3-badge-pending">⏳ বাকি</span>
        </div>

        <div class="fc-s3-item">
          <span class="fc-s3-item-lbl">✍️ স্বাক্ষর</span>
          <span id="fc-s3-status-sig" class="fc-s3-badge fc-s3-badge-pending">⏳ বাকি</span>
        </div>

        <div class="fc-s3-item">
          <span class="fc-s3-item-lbl">🏠 বাড়ির ছবি (≤৬০০x৪০০)</span>
          <span id="fc-s3-status-house" class="fc-s3-badge fc-s3-badge-pending">⏳ বাকি</span>
        </div>

        <div class="fc-s3-note">
          🛡️ <b>ইমেজ গার্ডিয়ান সক্রিয়:</b> ম্যানুয়ালি ছবি তুললে স্বয়ংক্রিয়ভাবে ২০০ KB ও ৬০০x৪০০ সাইজে অপ্টিমাইজ হয়ে যাবে।<br>
          <span id="fc-s3-cloud-stat" style="color: #166534; font-weight: 600;">☁️ ক্লাউড অটো-সিঙ্ক প্রস্তুত</span>
        </div>
      </div>
    `;
    document.body.appendChild(hud);

    const toggleBtn = document.getElementById('fc-s3-toggle-btn');
    const minIcon = document.getElementById('fc-s3-min-icon');
    toggleBtn.addEventListener('click', () => {
      hud.classList.toggle('minimized');
      minIcon.textContent = hud.classList.contains('minimized') ? '▴' : '▾';
    });
  }

  let lastSyncedMediaHash = '';
  let lastHudMediaHash = '';

  function inspectMediaSlot(tab9Root, slotKey, inputId, previewSelector, labelBn) {
    const inputEl = document.getElementById(inputId);
    const previewEl = (tab9Root && tab9Root.querySelector(previewSelector)) || document.querySelector(previewSelector);
    const col = inputEl?.closest('.fc-media-col, .col, [class*="col-"]') || previewEl?.closest('.fc-media-col, .col, [class*="col-"]') || null;
    const imgDiv = previewEl?.querySelector('.v-image__image') || col?.querySelector('.v-image__image') || previewEl;
    const bg = imgDiv?.style?.backgroundImage || '';
    const urlMatch = bg.match(/url\(["']?([^"')]+)["']?\)/);
    let url = urlMatch ? urlMatch[1].replace(/&quot;/g, '').trim() : '';
    if (!url || url === 'none' || url.includes('data:image/svg') || /\.svg(?:$|\?)/i.test(url)) {
      url = '';
    }

    const progBar = col?.querySelector('[role="progressbar"][aria-valuenow]');
    const pctRaw = progBar ? parseInt(progBar.getAttribute('aria-valuenow') || '0', 10) : (url ? 100 : 0);
    const progressPct = Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, pctRaw)) : 0;

    const errNode = col?.querySelector('.v-input.error--text .v-messages__message, .v-messages.error--text .v-messages__message, .v-messages__message.error--text, .fc-media-upload-status .error--text');
    const errText = errNode ? String(errNode.textContent || '').trim() : '';
    const hasError = Boolean(errText);

    const file = inputEl?.files?.[0] || null;
    const hasFile = Boolean(file);
    const fileSizeKb = file ? Math.round(file.size / 1024) : 0;
    const isRemoteUrl = Boolean(url && (url.includes('familycard-api.bhata.gov.bd') || /^https?:\/\//i.test(url)));
    const isPreviewReady = Boolean(url && (isRemoteUrl || url.startsWith('blob:') || url.startsWith('data:')));

    let status = 'missing';
    if (hasError) status = 'error';
    else if (isPreviewReady && (isRemoteUrl || progressPct === 100 || !progBar)) status = 'ok';
    else if (hasFile || (progressPct > 0 && progressPct < 100) || isPreviewReady) status = 'uploading';

    return {
      key: slotKey,
      label: labelBn,
      inputEl,
      col,
      url,
      hasFile,
      fileSizeKb,
      progressPct,
      hasError,
      errText,
      ok: status === 'ok',
      status
    };
  }

  function inspectSection3Media(tab9Root = null) {
    const scope = tab9Root || document.querySelector('[data-family-card-tab="9"]');
    const photo = inspectMediaSlot(scope, 'photo', 'image', '.fc-photo-preview', 'আবেদনকারীর ছবি');
    const signature = inspectMediaSlot(scope, 'signature', 'signature', '.fc-signature-preview', 'স্বাক্ষর');
    const house = inspectMediaSlot(scope, 'house', 'house_image', '.fc-house-preview', 'বাড়ির ছবি');
    const slots = [photo, signature, house];
    const completedCount = slots.filter(s => s.ok).length;
    const issues = slots.filter(s => !s.ok).map(s => {
      if (s.status === 'error') return `${s.label}: ${s.errText}`;
      if (s.status === 'uploading') return `${s.label} আপলোড হচ্ছে (${toBnDigits(s.progressPct)}%)`;
      return `${s.label} আপলোড বাকি`;
    });
    return {
      photo,
      signature,
      house,
      slots,
      completedCount,
      allValid: completedCount === 3 && slots.every(s => !s.hasError),
      issues
    };
  }

  function injectSection3ValidatorBar(tab9, mediaState) {
    if (!tab9 || !isPanelActiveVisible(tab9)) return;
    const wrap = tab9.querySelector('.v-expansion-panel-content__wrap') || tab9;
    if (!wrap) return;

    const pillCls = mediaState.allValid ? 'ok' : '';
    const chipHtml = mediaState.slots.map(s => {
      const icon = s.ok ? '✅' : (s.status === 'uploading' ? '⏳' : (s.status === 'error' ? '❌' : '⚠️'));
      const rightTxt = s.ok
        ? (s.progressPct ? `${toBnDigits(s.progressPct)}%` : 'সম্পন্ন')
        : (s.status === 'uploading' ? `${toBnDigits(s.progressPct)}%` : (s.status === 'error' ? 'ত্রুটি' : 'বাকি'));
      return `<div class="fc-s3v-chip ${s.status}" title="${escapeHtml(s.errText || s.url || s.label)}"><span>${icon} ${escapeHtml(s.label)}</span><span>${rightTxt}</span></div>`;
    }).join('');

    const html = `
      <div class="fc-s3v-head">
        <span>🛡️ <b>স্টেপ ৩ ভ্যালিডেশন: ছবি, স্বাক্ষর ও বাড়ির ছবি</b> <small style="opacity:0.8;">(JPG/PNG · ≤২০০ KB · বাড়ি ≤৬০০×৪০০)</small></span>
        <span class="fc-s2-pill ${pillCls}">${toBnDigits(mediaState.completedCount)}/৩ ভ্যালিডেটেড</span>
      </div>
      <div class="fc-s3v-grid">${chipHtml}</div>
      ${mediaState.issues.length ? `<div style="font-size:11px; color:#b45309; font-weight:700;">⏳ করণীয়: ${escapeHtml(mediaState.issues.join(' • '))}</div>` : '<div style="font-size:11px; color:#15803d; font-weight:700;">✅ ৩টি প্রয়োজনীয় ছবিই সরকারি শর্ত অনুযায়ী ১০০% আপলোড সম্পন্ন!</div>'}
      <div class="fc-s2-actions">
        <button type="button" class="fc-s2-btn primary" data-s3-act="validate">🔍 স্টেপ ৩ যাচাই করুন</button>
      </div>
    `;

    let bar = wrap.querySelector('#fc-section3-validator');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fc-section3-validator';
      if (typeof wrap.insertBefore === 'function') wrap.insertBefore(bar, wrap.firstChild || null);
      else wrap.appendChild(bar);
    }
    if (bar.dataset.lastHtml !== html) {
      bar.dataset.lastHtml = html;
      bar.innerHTML = html;
    }

    if (!bar.__fcS3Bound) {
      bar.__fcS3Bound = true;
      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-s3-act="validate"]');
        if (!btn) return;
        const latest = inspectSection3Media(tab9);
        injectSection3ValidatorBar(tab9, latest);
        updateSummaryBadge(true);
        if (latest.allValid) {
          showToast('✅ স্টেপ ৩ ভ্যালিডেশন সফল: ছবি, স্বাক্ষর ও বাড়ির ছবি ১০০% প্রস্তুত!');
        } else {
          showToast(`⚠️ স্টেপ ৩ অসম্পূর্ণ (${toBnDigits(latest.completedCount)}/৩): ${latest.issues[0] || 'মিডিয়া যাচাই করুন'}`);
        }
      });
    }
  }

  function traceSection3Media() {
    const imgInput = document.getElementById('image');
    const sigInput = document.getElementById('signature');
    const houseInput = document.getElementById('house_image');

    if (imgInput) attachMediaGuardian(imgInput, 'photo');
    if (sigInput) attachMediaGuardian(sigInput, 'signature');
    if (houseInput) attachMediaGuardian(houseInput, 'house');

    const tab9 = document.querySelector('[data-family-card-tab="9"]');
    const s3Panel = tab9 ||
                    document.querySelector('.fc-media-row') ||
                    document.querySelector('.fc-photo-preview') ||
                    imgInput;

    const hud = document.getElementById('fc-section3-hud');
    const isS3Visible = tab9 ? isPanelActiveVisible(tab9) : isPanelActiveVisible(s3Panel);
    if (!s3Panel || !isS3Visible) {
      if (hud && hud.style.display !== 'none') hud.style.display = 'none';
      return;
    }

    const mediaState = inspectSection3Media(tab9);
    if (tab9) injectSection3ValidatorBar(tab9, mediaState);

    injectSection3HUD();
    const hudEl = document.getElementById('fc-section3-hud');
    if (hudEl && hudEl.style.display !== 'block') hudEl.style.display = 'block';

    const { photo, signature, house, completedCount } = mediaState;
    const hudHash = `${photo.status}|${photo.progressPct}|${signature.status}|${signature.progressPct}|${house.status}|${house.progressPct}|${completedCount}`;
    if (hudHash !== lastHudMediaHash) {
      lastHudMediaHash = hudHash;
      function updateBadge(badgeId, slot, doneText) {
        const el = document.getElementById(badgeId);
        if (!el) return;
        if (slot.status === 'error') {
          el.className = 'fc-s3-badge fc-s3-badge-err';
          el.textContent = '❌ ত্রুটি';
        } else if (slot.ok) {
          el.className = 'fc-s3-badge fc-s3-badge-done';
          el.textContent = doneText || '✅ আপলোড সম্পন্ন';
        } else if (slot.status === 'uploading') {
          el.className = 'fc-s3-badge fc-s3-badge-ready';
          el.textContent = slot.progressPct > 0 ? `⏳ ${toBnDigits(slot.progressPct)}%` : '⏳ প্রস্তুত/আপলোড';
        } else {
          el.className = 'fc-s3-badge fc-s3-badge-pending';
          el.textContent = '⏳ বাকি';
        }
      }

      updateBadge('fc-s3-status-photo', photo, '✅ ছবি সম্পন্ন');
      updateBadge('fc-s3-status-sig', signature, '✅ স্বাক্ষর সম্পন্ন');
      updateBadge('fc-s3-status-house', house, '✅ বাড়ি সম্পন্ন');

      const ratioEl = document.getElementById('fc-s3-ratio');
      const progEl = document.getElementById('fc-s3-progress');
      const bnDigits = ['০', '১', '২', '৩'];

      if (ratioEl) ratioEl.textContent = `${bnDigits[completedCount]}/৩`;
      if (progEl) progEl.style.width = `${Math.round((completedCount / 3) * 100)}%`;
    }

    const currentHash = `${photo.url}|${signature.url}|${house.url}|${completedCount}`;
    if (completedCount > 0 && currentHash !== lastSyncedMediaHash) {
      lastSyncedMediaHash = currentHash;
      syncMediaToFirestore({
        applicant_photo_url: photo.url || '',
        signature_url: signature.url || '',
        house_photo_url: house.url || '',
        completed_count: completedCount
      });
    }
  }

  async function syncMediaToFirestore(mediaData) {
    try {
      const cleanId = getSafeFamilyDocId(lastExtractedData);
      if (!cleanId) return;

      const fields = {
        section3_verified: { booleanValue: mediaData.completed_count === 3 },
        section3_completed_count: { integerValue: String(mediaData.completed_count) },
        section3_updated_at: { timestampValue: new Date().toISOString() }
      };
      const updateMask = [
        'updateMask.fieldPaths=section3_verified',
        'updateMask.fieldPaths=section3_completed_count',
        'updateMask.fieldPaths=section3_updated_at'
      ];

      if (mediaData.applicant_photo_url) {
        fields.applicant_photo_url = { stringValue: mediaData.applicant_photo_url };
        updateMask.push('updateMask.fieldPaths=applicant_photo_url');
      }
      if (mediaData.signature_url) {
        fields.signature_url = { stringValue: mediaData.signature_url };
        updateMask.push('updateMask.fieldPaths=signature_url');
      }
      if (mediaData.house_photo_url) {
        fields.house_photo_url = { stringValue: mediaData.house_photo_url };
        updateMask.push('updateMask.fieldPaths=house_photo_url');
      }

      const url = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(cleanId)}?${updateMask.join('&')}`;

      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
      console.log('[FamilyCard Extension] Section 3 media synced to Firestore for family ID:', cleanId);

      const cloudStatEl = document.getElementById('fc-s3-cloud-stat');
      if (cloudStatEl) {
        cloudStatEl.textContent = `☁️ ক্লাউডে সংরক্ষিত (আইডি: ${cleanId})`;
        cloudStatEl.style.color = '#166534';
      }
    } catch (e) {
      console.warn('[FamilyCard Extension] Firestore media sync notice:', e.message);
    }
  }

  // --- SECTION 4: ADDRESS (যোগাযোগের তথ্য - ফ্যামিলি কার্ড তথ্য সংগ্রহের ঠিকানা) ---
  function isNodeBetweenInOrder(node, startNode, endNode, rootScope) {
    if (typeof node.compareDocumentPosition === 'function' && typeof Node !== 'undefined') {
      const afterStart = (node.compareDocumentPosition(startNode) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
      const beforeEnd = !endNode || ((node.compareDocumentPosition(endNode) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      return afterStart && beforeEnd;
    }
    const nodes = [];
    const walk = (cur) => {
      nodes.push(cur);
      if (cur.children) Array.from(cur.children).forEach(walk);
    };
    walk(rootScope || document.body);
    const iNode = nodes.indexOf(node);
    const iStart = nodes.indexOf(startNode);
    const iEnd = endNode ? nodes.indexOf(endNode) : -1;
    if (iNode === -1 || iStart === -1) return false;
    return iNode > iStart && (iEnd === -1 || iNode < iEnd);
  }

  function getSection4AddressElements(includeHidden = false) {
    const tab2 = document.querySelector('[data-family-card-tab="2"]');
    if (!includeHidden && tab2 && !isPanelActiveVisible(tab2)) {
      return { tab2, isVisible: false, postCodeInput: null, villageInput: null, permSameCheckbox: null, permPostInput: null, permVillageInput: null };
    }
    const scope = tab2 || Array.from(document.querySelectorAll('[data-family-card-tab], .v-expansion-panel')).find(isPanelActiveVisible) || null;
    if (!scope) {
      return { tab2: null, isVisible: false, postCodeInput: null, villageInput: null, permSameCheckbox: null, permPostInput: null, permVillageInput: null };
    }
    const headerNodes = Array.from(scope.querySelectorAll('.v-chip, .v-chip__content, h3, h4, .text-subtitle-1, .text-subtitle-2'));
    const collectionChip = headerNodes.find(el => normalizeBn(el.textContent) === 'ফ্যামিলি কার্ড তথ্য সংগ্রহের ঠিকানা');
    if (!collectionChip) {
      return { tab2, isVisible: isPanelActiveVisible(scope), postCodeInput: null, villageInput: null, permSameCheckbox: null, permPostInput: null, permVillageInput: null };
    }

    const permanentChip = headerNodes.find(el => {
      const t = normalizeBn(el.textContent);
      return t === 'স্থায়ী ঠিকানা' || t === 'স্থায়ী ঠিকানা';
    });

    const allInputs = Array.from(scope.querySelectorAll('input:not([type="hidden"]):not([disabled])')).filter(inp => !inp.readOnly);

    let postCodeInput = null;
    let villageInput = null;
    let permPostInput = null;
    let permVillageInput = null;

    for (const inp of allInputs) {
      if (inp.type === 'checkbox' || inp.type === 'radio') continue;
      const parentCol = inp.closest('.col, [class*="col-"]') || inp.closest('.v-input')?.parentElement || inp.parentElement;
      const labelText = normalizeBn(parentCol?.querySelector('label')?.textContent || inp.closest('.v-input')?.querySelector('label')?.textContent || '');
      const inCollection = isNodeBetweenInOrder(inp, collectionChip, permanentChip, scope);
      const inPermanent = Boolean(permanentChip) && isNodeBetweenInOrder(inp, permanentChip, null, scope);

      if (inCollection) {
        if (labelText.includes('পোস্ট কোড')) postCodeInput = inp;
        else if (labelText.includes('গ্রাম') || labelText.includes('বাড়ি নং') || labelText.includes('বাড়ি নং') || labelText.includes('সেকশন')) villageInput = inp;
      } else if (inPermanent) {
        if (labelText.includes('পোস্ট কোড')) permPostInput = inp;
        else if (labelText.includes('গ্রাম') || labelText.includes('বাড়ি নং') || labelText.includes('বাড়ি নং') || labelText.includes('সেকশন')) permVillageInput = inp;
      }
    }

    const permSameCheckbox = scope.querySelector('input[type="checkbox"]') || null;

    return {
      tab2: scope,
      isVisible: isPanelActiveVisible(scope),
      postCodeInput,
      villageInput,
      permSameCheckbox,
      permPostInput,
      permVillageInput
    };
  }

  function getSection4CollectionInputs() {
    const { postCodeInput, villageInput } = getSection4AddressElements(false);
    return { postCodeInput, villageInput };
  }

  function inspectSection4Address(tab2Root = null) {
    const els = getSection4AddressElements(true);
    const hasDom = Boolean(els.postCodeInput || els.villageInput);
    const postcodeRaw = els.postCodeInput ? String(els.postCodeInput.value || '') : '';
    const postcode = normalizeDigits(postcodeRaw).replace(/[^0-9]/g, '');
    const village = els.villageInput ? String(els.villageInput.value || '').trim() : '';

    const permCb = els.permSameCheckbox;
    const permSameChecked = Boolean(
      permCb && (permCb.checked || permCb.getAttribute('aria-checked') === 'true' || permCb.closest('.v-input--is-dirty'))
    );
    const permPost = els.permPostInput ? normalizeDigits(els.permPostInput.value || '').replace(/[^0-9]/g, '') : '';
    const permVillage = els.permVillageInput ? String(els.permVillageInput.value || '').trim() : '';

    const postcodeOk = /^\d{4}$/.test(postcode);
    const villageOk = village.length >= 2;
    const collectionOk = postcodeOk && villageOk;
    const permOk = !els.permSameCheckbox && !els.permPostInput ? true : (permSameChecked || (/^\d{4}$/.test(permPost) && permVillage.length >= 2));
    const allValid = hasDom ? (collectionOk && permOk) : false;

    const issues = [];
    if (hasDom) {
      if (!postcodeOk) issues.push('৪ সংখ্যার পোস্ট কোড দিন (যেমন 7721)');
      if (!villageOk) issues.push('তথ্য সংগ্রহের গ্রাম/ঠিকানা দিন');
      if (!permOk) issues.push('স্থায়ী ঠিকানা বা "একই হলে ক্লিক করুন" চেক করুন');
    }

    return {
      hasDom,
      els,
      postcode,
      village,
      permSameChecked,
      permPost,
      permVillage,
      postcodeOk,
      villageOk,
      collectionOk,
      permOk,
      allValid,
      issues
    };
  }

  function attachSection4EditGuard(inp) {
    if (!inp || inp.__fcS4GuardAttached) return;
    inp.__fcS4GuardAttached = true;
    inp.addEventListener('input', (e) => {
      if (e.isTrusted) {
        inp.dataset.fcS4UserEdited = 'true';
        inp.dataset.fcS4AutoApplied = 'true';
        if (lastAddressToolbarTab) injectSection4AddressToolbar(lastAddressToolbarTab);
      }
    });
  }

  let lastAddressToolbarTab = null;

  function handleSection4Address(opts = {}) {
    const force = Boolean(opts && opts.force);
    const els = getSection4AddressElements(false);
    const { tab2, postCodeInput, villageInput } = els;
    if (!postCodeInput && !villageInput) return;

    const { postcode, village, villages } = getSavedAddressConfig();

    if (postCodeInput) {
      attachSection4EditGuard(postCodeInput);
      const curPost = normalizeDigits(postCodeInput.value || '').trim();
      const shouldFillPost = force
        ? curPost !== postcode
        : (!curPost && postCodeInput.dataset.fcS4UserEdited !== 'true' && postCodeInput.dataset.fcS4AutoApplied !== 'true');
      if (shouldFillPost) {
        delete postCodeInput.dataset.fcS4UserEdited;
        setReactiveValue(postCodeInput, postcode, { ignoreUserGuard: force });
        postCodeInput.dataset.fcS4AutoApplied = 'true';
        console.log('[FamilyCard Extension] Section 4 Post Code filled with default:', postcode);
      }
    }

    if (villageInput) {
      attachSection4EditGuard(villageInput);
      const curVil = String(villageInput.value || '').trim();
      const shouldFillVil = force
        ? curVil !== village
        : (!curVil && villageInput.dataset.fcS4UserEdited !== 'true' && villageInput.dataset.fcS4AutoApplied !== 'true');
      if (shouldFillVil) {
        delete villageInput.dataset.fcS4UserEdited;
        setReactiveValue(villageInput, village, { ignoreUserGuard: force });
        villageInput.dataset.fcS4AutoApplied = 'true';
        console.log('[FamilyCard Extension] Section 4 Village filled with default:', village);
      }
    }

    if (els.permSameCheckbox && !els.permSameCheckbox.__fcS4PermBound) {
      els.permSameCheckbox.__fcS4PermBound = true;
      els.permSameCheckbox.addEventListener('change', () => {
        injectSection4AddressToolbar(tab2);
        updateSummaryBadge(true);
      });
    }
    [els.permPostInput, els.permVillageInput].forEach((pInp) => {
      if (!pInp || pInp.__fcS4PermBound) return;
      pInp.__fcS4PermBound = true;
      pInp.addEventListener('input', () => {
        injectSection4AddressToolbar(tab2);
        updateSummaryBadge(true);
      });
    });

    injectSection4AddressToolbar(tab2, els, villages, village, postcode);
  }

  function injectSection4AddressToolbar(tab2, elsOverride = null, listOverride = null, vilOverride = null, postOverride = null) {
    const scope = tab2 || document.querySelector('[data-family-card-tab="2"]');
    if (!scope || !isPanelActiveVisible(scope)) return;
    lastAddressToolbarTab = scope;

    const wrap = scope.querySelector('.v-expansion-panel-content__wrap') || scope;
    const cfg = getSavedAddressConfig();
    const villages = listOverride || cfg.villages;
    const curVillage = vilOverride || cfg.village;
    const curPostcode = postOverride || cfg.postcode;
    const els = elsOverride || getSection4AddressElements(false);
    const s4 = inspectSection4Address(scope);

    const statusBadge = s4.allValid
      ? '<span class="fc-s2-pill ok">✅ ঠিকানা ভ্যালিডেটেড</span>'
      : `<span class="fc-s2-pill">${s4.collectionOk ? '⏳ স্থায়ী ঠিকানা দেখুন' : '⚠️ ২/২ ফিল্ড পূরণ করুন'}</span>`;
    const permPill = s4.permSameChecked
      ? '<span style="font-size:10.5px; color:#15803d; font-weight:700;">✓ স্থায়ী ঠিকানা = সংগ্রহের ঠিকানা</span>'
      : '<span style="font-size:10.5px; color:#64748b; font-weight:700;">স্থায়ী ঠিকানা ম্যানুয়াল/আলাদা</span>';

    const chipsHtml = villages.map((v) => {
      const isAct = v === curVillage;
      const delBtn = villages.length > 1
        ? `<button type="button" class="fc-s4-vdel" data-s4-del-v="${escapeHtml(v)}" title="মুছুন">✕</button>`
        : '';
      return `<span class="fc-s4-vchip ${isAct ? 'active' : ''}" data-s4-pick-v="${escapeHtml(v)}">🏠 ${escapeHtml(v)}${delBtn}</span>`;
    }).join('');

    const html = `
      <div class="fc-s4-head">
        <span>📍 <b>স্টেপ ৪: পোস্ট ও গ্রাম অটো-ম্যানেজার</b> ${permPill}</span>
        ${statusBadge}
      </div>
      <div class="fc-s4-grid">
        <div class="fc-s4-field">
          <label for="fc-s4-postcode-inp">📮 পোস্ট কোড (ডিফল্ট)</label>
          <div class="fc-s4-inline-row">
            <input type="text" id="fc-s4-postcode-inp" class="fc-s4-inp" value="${escapeHtml(curPostcode)}" maxlength="6" placeholder="7721">
            <button type="button" class="fc-s2-btn primary" data-s4-act="save-post">💾</button>
          </div>
        </div>
        <div class="fc-s4-field">
          <label>🏠 দ্রুত গ্রাম পরিবর্তন (ট্যাপ করে সিলেক্ট / ✕ মুছুন)</label>
          <div class="fc-s4-vchips">${chipsHtml}</div>
        </div>
      </div>
      <div class="fc-s4-inline-row">
        <input type="text" id="fc-s4-new-village" class="fc-s4-inp" placeholder="নতুন গ্রামের নাম লিখুন (যেমন: চর ঝিকরী)...">
        <button type="button" class="fc-s2-btn accent" data-s4-act="add-village">➕ যোগ ও সেট</button>
      </div>
      <div class="fc-s2-actions">
        <button type="button" class="fc-s2-btn primary" data-s4-act="apply">⚡ ফর্মে বসান</button>
        <button type="button" class="fc-s2-btn" data-s4-act="copy-perm">📋 স্থায়ী ঠিকানায় একই দিন</button>
        <button type="button" class="fc-s2-btn" data-s4-act="validate">🔍 স্টেপ ৪ যাচাই</button>
      </div>
    `;

    const oldBar = scope.querySelector('#fc-inline-village-bar');
    if (oldBar) oldBar.remove();

    let bar = wrap.querySelector('#fc-section4-toolbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fc-section4-toolbar';
      if (typeof wrap.insertBefore === 'function') wrap.insertBefore(bar, wrap.firstChild || null);
      else wrap.appendChild(bar);
    }
    const activeEl = document.activeElement;
    const isTypingInBar = activeEl && bar.contains(activeEl) && (activeEl.id === 'fc-s4-postcode-inp' || activeEl.id === 'fc-s4-new-village');
    if (!isTypingInBar && bar.dataset.lastHtml !== html) {
      bar.dataset.lastHtml = html;
      bar.innerHTML = html;
    }

    if (!bar.__fcS4Bound) {
      bar.__fcS4Bound = true;
      bar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target?.id === 'fc-s4-new-village') {
          e.preventDefault();
          bar.querySelector('[data-s4-act="add-village"]')?.click();
        } else if (e.key === 'Enter' && e.target?.id === 'fc-s4-postcode-inp') {
          e.preventDefault();
          bar.querySelector('[data-s4-act="save-post"]')?.click();
        }
      });
      bar.addEventListener('click', (e) => {
        const delBtn = e.target.closest('[data-s4-del-v]');
        if (delBtn) {
          e.stopPropagation();
          const v = delBtn.getAttribute('data-s4-del-v');
          saveAddressConfig({ removeVillage: v });
          handleSection4Address({ force: true });
          updateSummaryBadge(true);
          showToast(`🗑️ গ্রাম "${v}" তালিকা থেকে মুছে ফেলা হয়েছে।`);
          return;
        }
        const pickChip = e.target.closest('[data-s4-pick-v]');
        if (pickChip) {
          const chosen = pickChip.getAttribute('data-s4-pick-v');
          saveAddressConfig({ village: chosen });
          handleSection4Address({ force: true });
          updateSummaryBadge(true);
          showToast(`✅ গ্রাম "${chosen}" সেট করা হয়েছে (তথ্য সংগ্রহের ঠিকানা)!`);
          return;
        }
        const actBtn = e.target.closest('[data-s4-act]');
        if (!actBtn) return;
        const act = actBtn.getAttribute('data-s4-act');
        if (act === 'save-post') {
          const val = bar.querySelector('#fc-s4-postcode-inp')?.value || '';
          const updated = saveAddressConfig({ postcode: val });
          handleSection4Address({ force: true });
          updateSummaryBadge(true);
          showToast(`✅ পোস্ট কোড ${toBnDigits(updated.postcode)} সেভ ও ফর্মে বসানো হয়েছে!`);
        } else if (act === 'add-village') {
          const inp = bar.querySelector('#fc-s4-new-village');
          const name = inp ? inp.value.trim() : '';
          if (!name) { showToast('⚠️ নতুন গ্রামের নাম লিখুন!'); return; }
          const updated = saveAddressConfig({ addVillage: name });
          if (inp) inp.value = '';
          handleSection4Address({ force: true });
          updateSummaryBadge(true);
          showToast(`✅ নতুন গ্রাম "${updated.village}" যোগ ও ফর্মে বসানো হলো!`);
        } else if (act === 'apply') {
          const pInpVal = bar.querySelector('#fc-s4-postcode-inp')?.value;
          if (pInpVal) saveAddressConfig({ postcode: pInpVal });
          handleSection4Address({ force: true });
          updateSummaryBadge(true);
          showToast(`⚡ পোস্ট কোড ${toBnDigits(savedPostcode)} ও গ্রাম "${savedDefaultVillage}" ফর্মে বসানো হয়েছে!`);
        } else if (act === 'copy-perm') {
          const curEls = getSection4AddressElements(false);
          const curState = inspectSection4Address(scope);
          if (curEls.permSameCheckbox && !curState.permSameChecked) {
            curEls.permSameCheckbox.click();
          } else {
            if (curEls.permPostInput) setReactiveValue(curEls.permPostInput, curState.postcode || savedPostcode, { ignoreUserGuard: true });
            if (curEls.permVillageInput) setReactiveValue(curEls.permVillageInput, curState.village || savedDefaultVillage, { ignoreUserGuard: true });
          }
          setTimeout(() => { injectSection4AddressToolbar(scope); updateSummaryBadge(true); }, 120);
          showToast('✅ স্থায়ী ঠিকানায় সংগ্রহের ঠিকানা কপি করা হয়েছে!');
        } else if (act === 'validate') {
          const latest = inspectSection4Address(scope);
          injectSection4AddressToolbar(scope);
          updateSummaryBadge(true);
          if (latest.allValid) {
            showToast(`✅ স্টেপ ৪ যাচাই সফল: পোস্ট কোড ${toBnDigits(latest.postcode)}, গ্রাম "${latest.village}"!`);
          } else {
            showToast(`⚠️ স্টেপ ৪: ${latest.issues[0] || 'ঠিকানা যাচাই করুন'}`);
          }
        }
      });
    }
  }

  // --- SECTION 5 & TAB 6: DYNAMIC CROSS-MATCHING ENGINE ---
  // Tracks declared counts in Section 5 (পুরুষ, নারী, হিজড়া, এমএফএস, প্রশিক্ষণ, প্রবাসী)
  // Real-time cross-matches with family members entered in Tab 6 (সদস্য - ১ নিজ, সদস্য - ২, ইত্যাদি)
  // Displays live HUD and prevents mismatch rejections

  function toBnDigits(num) {
    if (num === null || num === undefined) return '০';
    const bn = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
    return String(num).replace(/[0-9]/g, d => bn[parseInt(d, 10)]);
  }

  let lastCrossMatchHash = '';
  let lastSec5Serialized = '';
  let isFillingSection5 = false;
  let lastSec5FillTs = 0;
  let activeSec5Promise = null;

  const SECTION5_FIELD_SPECS = [
    { key: 'male', type: 'count', reqLabel: 'পুরুষ সদস্য সংখ্যা', match: (lbl) => /পরিবারে\s*পুরুষ\s*সদস্য\s*সংখ্যা/i.test(lbl) },
    { key: 'female', type: 'count', reqLabel: 'নারী সদস্য সংখ্যা', match: (lbl) => /পরিবারে\s*(?:নারী|মহিলা)\s*সদস্য\s*সংখ্যা/i.test(lbl) },
    { key: 'trans', type: 'count', reqLabel: 'হিজড়া সদস্য সংখ্যা', match: (lbl) => /পরিবারে\s*হিজ[ড়ড়]া\s*সদস্য\s*সংখ্যা/i.test(lbl) },
    { key: 'training', type: 'text', reqLabel: 'প্রশিক্ষণ বা আর্থিক সুবিধা', match: (lbl) => /প্রশিক্ষণ বা আর্থিক সুবিধা/i.test(lbl) },
    { key: 'mfs', type: 'text', reqLabel: 'মোবাইল ব্যাংকিং (MFS)', match: (lbl) => /মোবাইল ব্যাংকিং/i.test(lbl) },
    { key: 'abroadMale', type: 'count', reqLabel: 'প্রবাসী পুরুষ সংখ্যা', match: (lbl) => /বিদেশে\s*বসবাসরত.*পুরুষ/i.test(lbl) },
    { key: 'abroadFemale', type: 'count', reqLabel: 'প্রবাসী মহিলা সংখ্যা', match: (lbl) => /বিদেশে\s*বসবাসরত.*(?:মহিলা|নারী)/i.test(lbl) },
    { key: 'abroadTrans', type: 'count', reqLabel: 'প্রবাসী হিজড়া সংখ্যা', match: (lbl) => /বিদেশে\s*বসবাসরত.*হিজ[ড়ড়]া/i.test(lbl) }
  ];

  function getSection5Elements(includeHidden = false) {
    const panel = document.querySelector('[data-family-card-tab="3"]') ||
                  Array.from(document.querySelectorAll('.v-expansion-panel')).find(p => normalizeBn(p.textContent).includes('ফ্যামিলি কার্ড অনুযায়ী বিস্তারিত')) ||
                  null;
    if (!panel) return { panel: null, isVisible: false, cols: {}, values: {} };
    const isVisible = isPanelActiveVisible(panel);
    if (!includeHidden && !isVisible) return { panel, isVisible: false, cols: {}, values: {} };

    const cols = {};
    const values = {};
    const allCols = Array.from(panel.querySelectorAll('.col, [class*="col-"]')).filter(c => !c.closest('.fc-pmt-multi-grid'));

    for (const col of allCols) {
      const labelEl = col.querySelector('label');
      if (!labelEl) continue;
      const label = normalizeBn(labelEl.textContent).replace(/[\*\s]+/g, ' ').trim();
      const spec = SECTION5_FIELD_SPECS.find(sp => !cols[sp.key] && sp.match(label));
      if (!spec) continue;
      cols[spec.key] = col;
      const selEl = col.querySelector('.v-select__selection');
      const inputEl = col.querySelector('input:not([type="hidden"])');
      const selTxt = normalizeBn(selEl ? selEl.textContent : '');
      const inpTxt = normalizeBn(inputEl ? inputEl.value : '');
      values[spec.key] = selTxt || inpTxt || '';
    }

    return { panel, isVisible, cols, values };
  }

  function trackSection5Data() {
    const { panel, cols, values } = getSection5Elements(true);
    const familyKey = scrapeFamilyId() || 'default';
    const rawCache = safeJsonParse(localStorage.getItem('fc_section5_data'), null);
    const cached = (rawCache && rawCache._familyKey === familyKey) ? rawCache : null;

    if (!panel) return cached;

    const seen = {};
    let filledCount = 0;
    SECTION5_FIELD_SPECS.forEach((sp) => {
      const hasVal = Boolean(values[sp.key]);
      seen[sp.key] = hasVal;
      if (hasVal) filledCount++;
    });

    const data = {
      _familyKey: familyKey,
      maleCount: seen.male ? (parseInt(normalizeDigits(values.male), 10) || 0) : 0,
      femaleCount: seen.female ? (parseInt(normalizeDigits(values.female), 10) || 0) : 0,
      transCount: seen.trans ? (parseInt(normalizeDigits(values.trans), 10) || 0) : 0,
      totalCount: 0,
      training: values.training || '',
      mfsAccount: values.mfs || '',
      abroadMale: seen.abroadMale ? (parseInt(normalizeDigits(values.abroadMale), 10) || 0) : 0,
      abroadFemale: seen.abroadFemale ? (parseInt(normalizeDigits(values.abroadFemale), 10) || 0) : 0,
      abroadTrans: seen.abroadTrans ? (parseInt(normalizeDigits(values.abroadTrans), 10) || 0) : 0,
      abroadTotal: 0,
      filledCount,
      seen
    };
    data.totalCount = data.maleCount + data.femaleCount + data.transCount;
    data.abroadTotal = data.abroadMale + data.abroadFemale + data.abroadTrans;

    const sawCountFieldsInDom = Boolean(cols.male || cols.female || cols.trans);
    if (filledCount > 0) {
      const serialized = JSON.stringify(data);
      if (serialized !== lastSec5Serialized) {
        lastSec5Serialized = serialized;
        localStorage.setItem('fc_section5_data', serialized);
      }
      return data;
    }

    if (sawCountFieldsInDom) return data;
    return cached;
  }

  function inspectSection5Details() {
    const { panel, isVisible, cols, values } = getSection5Elements(true);
    const hasDom = Boolean(panel && Object.keys(cols).length > 0);
    const data = trackSection5Data();
    if (!hasDom) {
      return {
        hasDom: false,
        isVisible,
        panel,
        cols,
        data,
        seen: data?.seen || {},
        filledCount: data?.filledCount || 0,
        totalRequired: SECTION5_FIELD_SPECS.length,
        missingFields: [],
        issues: [],
        countOk: Boolean(data && data.totalCount > 0),
        abroadConsistent: true,
        abroadTotal: data?.abroadTotal || 0,
        allFieldsFilled: false,
        allValid: false
      };
    }

    const seen = {};
    const missingFields = [];
    let filledCount = 0;
    for (const sp of SECTION5_FIELD_SPECS) {
      const ok = Boolean(values[sp.key]);
      seen[sp.key] = ok;
      if (ok) filledCount++;
      else missingFields.push(sp.reqLabel);
    }

    const countOk = Boolean(data && data.totalCount > 0);
    const issues = [];
    if (!countOk) issues.push('খানার মোট সদস্য সংখ্যা কমপক্ষে ১ জন হতে হবে');
    if (missingFields.length > 0) issues.push(`বাকি (${toBnDigits(missingFields.length)}টি): ${missingFields.slice(0, 4).join(', ')}${missingFields.length > 4 ? '…' : ''}`);

    let abroadConsistent = true;
    if (data && seen.male && data.abroadMale > data.maleCount) {
      abroadConsistent = false;
      issues.push(`প্রবাসী পুরুষ (${toBnDigits(data.abroadMale)}) > মোট পুরুষ (${toBnDigits(data.maleCount)})!`);
    }
    if (data && seen.female && data.abroadFemale > data.femaleCount) {
      abroadConsistent = false;
      issues.push(`প্রবাসী মহিলা (${toBnDigits(data.abroadFemale)}) > মোট নারী (${toBnDigits(data.femaleCount)})!`);
    }
    if (data && seen.trans && data.abroadTrans > data.transCount) {
      abroadConsistent = false;
      issues.push(`প্রবাসী হিজড়া (${toBnDigits(data.abroadTrans)}) > মোট হিজড়া (${toBnDigits(data.transCount)})!`);
    }

    const allFieldsFilled = missingFields.length === 0;
    const allValid = allFieldsFilled && countOk && abroadConsistent;

    return {
      hasDom: true,
      isVisible,
      panel,
      cols,
      values,
      data,
      seen,
      filledCount,
      totalRequired: SECTION5_FIELD_SPECS.length,
      missingFields,
      issues,
      countOk,
      abroadConsistent,
      abroadTotal: data ? data.abroadTotal : 0,
      allFieldsFilled,
      allValid
    };
  }

  const NEGATIVE_MFS_OPTIONS = ['প্রযোজ্য নয়', 'প্রযোজ্য নয়', 'নেই', 'নাই', 'কোনটিই নয়', 'কোনোটিই নয়', 'কোনটিই নয়', 'কোনোটিই নয়', 'হিসাব নেই'];
  sec5EngineReady = true;
  if (typeof updateModalSection5Controls === 'function') updateModalSection5Controls();

  function mfsOptionMatches(actual, target) {
    const na = normalizeBn(actual);
    const nt = normalizeBn(target);
    if (!na || !nt) return false;
    if (na === nt) return true;
    const normNeg = NEGATIVE_MFS_OPTIONS.map(x => normalizeBn(x));
    return normNeg.includes(nt) && normNeg.includes(na);
  }

  function resolveMfsCandidates(target) {
    const nt = normalizeBn(target);
    if (NEGATIVE_MFS_OPTIONS.some(x => normalizeBn(x) === nt)) return NEGATIVE_MFS_OPTIONS;
    if (nt === normalizeBn('উপায়')) return ['উপায়', 'উপায়'];
    return [target];
  }

  async function autoFillSection5Defaults(opts = {}) {
    const force = Boolean(opts && opts.force);
    const fillMissingOnly = Boolean(opts && opts.fillMissingOnly);
    const overrides = (opts && opts.overrides) || {};
    const { panel, isVisible, cols, values } = getSection5Elements(false);
    if (!panel || !isVisible) return { panel: null, filled: 0 };

    const cfg = getSavedSection5Config();
    const hasExplicitOverrides = Boolean(opts.syncFromMembers || Object.keys(overrides).length > 0);
    if (!force && !cfg.autoFill && !hasExplicitOverrides) {
      return { panel, filled: 0 };
    }
    if (isFillingSection5) {
      if ((force || hasExplicitOverrides) && activeSec5Promise) {
        try { await activeSec5Promise; } catch (_) {}
        return autoFillSection5Defaults(opts);
      }
      return { panel, filled: 0 };
    }
    if (!force && !hasExplicitOverrides && (Date.now() - lastSec5FillTs < 350)) {
      return { panel, filled: 0 };
    }

    const candidatesMap = {
      trans: overrides.trans !== undefined ? [toBnDigits(overrides.trans), String(overrides.trans)] : [cfg.transCount, '০', '0'],
      training: overrides.training !== undefined ? (overrides.training === 'হ্যাঁ' || overrides.training === 'হ্যা' ? ['হ্যা', 'হ্যাঁ'] : [overrides.training]) : (cfg.training === 'হ্যাঁ' ? ['হ্যা', 'হ্যাঁ'] : ['না']),
      mfs: resolveMfsCandidates(overrides.mfs !== undefined ? overrides.mfs : cfg.mfsAccount),
      abroadMale: overrides.abroadMale !== undefined ? [toBnDigits(overrides.abroadMale), String(overrides.abroadMale)] : [cfg.abroadDefault, '০', '0'],
      abroadFemale: overrides.abroadFemale !== undefined ? [toBnDigits(overrides.abroadFemale), String(overrides.abroadFemale)] : [cfg.abroadDefault, '০', '0'],
      abroadTrans: overrides.abroadTrans !== undefined ? [toBnDigits(overrides.abroadTrans), String(overrides.abroadTrans)] : [cfg.abroadDefault, '০', '0']
    };

    if (opts.syncFromMembers) {
      const mData = scanFamilyMembers();
      if (mData && mData.totalMembers > 0) {
        candidatesMap.male = [toBnDigits(mData.actualMale), String(mData.actualMale)];
        candidatesMap.female = [toBnDigits(mData.actualFemale), String(mData.actualFemale)];
        candidatesMap.trans = [toBnDigits(mData.actualTrans), String(mData.actualTrans)];
      }
    }
    if (overrides.male !== undefined) candidatesMap.male = [toBnDigits(overrides.male), String(overrides.male)];
    if (overrides.female !== undefined) candidatesMap.female = [toBnDigits(overrides.female), String(overrides.female)];

    const queue = [];
    for (const [key, cands] of Object.entries(candidatesMap)) {
      const col = cols[key];
      if (!col || !cands || cands.length === 0) continue;
      const curVal = values[key] || '';
      const hasOverride = Object.prototype.hasOwnProperty.call(overrides, key) || (opts.syncFromMembers && ['male', 'female', 'trans'].includes(key));
      const alreadyMatches = curVal && cands.some(c => normalizeBn(curVal) === normalizeBn(c) || normOptionText(curVal) === normOptionText(c));
      if (hasOverride || (force && !fillMissingOnly)) {
        if (!alreadyMatches) queue.push({ key, col, candidates: cands });
      } else if (!curVal && (fillMissingOnly || (col.dataset.fcS5DefaultApplied !== 'true' && col.dataset.fcS5UserEdited !== 'true'))) {
        queue.push({ key, col, candidates: cands });
      }
    }

    if (queue.length === 0) return { panel, filled: 0 };

    isFillingSection5 = true;
    let filled = 0;
    const runPromise = (async () => {
      try {
        for (const item of queue) {
          const ok = await selectSingleVuetifyOption(item.col, item.candidates, { tagAttr: 'fcS5DefaultApplied' });
          if (ok) filled++;
        }
      } finally {
        lastSec5FillTs = Date.now();
        isFillingSection5 = false;
        if (activeSec5Promise === runPromise) activeSec5Promise = null;
      }
    })();
    activeSec5Promise = runPromise;
    await runPromise;

    const updatedInfo = inspectSection5Details();
    const membersData = scanFamilyMembers();
    injectSection5Toolbar(panel, updatedInfo, membersData);
    if (typeof updateModalSection5Controls === 'function') updateModalSection5Controls();
    updateSummaryBadge(true);
    return { panel, filled };
  }

  function injectSection5Toolbar(panel, s5InfoOverride = null, membersDataOverride = null) {
    if (!panel || !isPanelActiveVisible(panel)) return;
    const wrap = panel.querySelector('.v-expansion-panel-content__wrap') || panel;
    const s5 = s5InfoOverride || inspectSection5Details();
    const data = s5.data || { maleCount: 0, femaleCount: 0, transCount: 0, totalCount: 0, training: '', mfsAccount: '', abroadMale: 0, abroadFemale: 0, abroadTrans: 0, abroadTotal: 0 };
    const members = membersDataOverride || scanFamilyMembers();
    const match = computeCrossMatch(data, members);
    const cfg = getSavedSection5Config();

    Object.values(s5.cols || {}).forEach((col) => {
      if (col && !col.__fcS5Bound) {
        col.__fcS5Bound = true;
        col.addEventListener('mousedown', (e) => {
          if (e.isTrusted) {
            col.dataset.fcS5UserEdited = 'true';
            col.dataset.fcS5DefaultApplied = 'true';
          }
        }, true);
        col.addEventListener('click', () => {
          setTimeout(() => {
            injectSection5Toolbar(panel);
            if (typeof updateModalSection5Controls === 'function') updateModalSection5Controls();
            updateSummaryBadge(true);
          }, 120);
        });
      }
    });

    const pillCls = s5.allValid ? 'ok' : '';
    const pillTxt = s5.allValid
      ? `✅ ${toBnDigits(s5.filledCount)}/${toBnDigits(s5.totalRequired)} সম্পূর্ণ`
      : `⚠️ ${toBnDigits(s5.filledCount)}/${toBnDigits(s5.totalRequired)} পূরণ`;
    const mfsList = ['নগদ', 'বিকাশ', 'রকেট', 'উপায়', 'প্রযোজ্য নয়'];
    const curMfs = data.mfsAccount || cfg.mfsAccount;
    const mfsChips = mfsList.map(m => `<button type="button" class="fc-s5-chip ${mfsOptionMatches(curMfs, m) ? 'active' : ''}" data-s5-mfs="${escapeHtml(m)}">${escapeHtml(m)}</button>`).join('');
    const curTr = data.training || cfg.training;
    const trChips = ['না', 'হ্যাঁ'].map(t => `<button type="button" class="fc-s5-chip ${(normalizeBn(curTr) === 'হ্যা' ? 'হ্যাঁ' : normalizeBn(curTr)) === t ? 'active' : ''}" data-s5-tr="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');
    const abroadRemitTxt = s5.abroadTotal > 0 ? 'হ্যাঁ (প্রবাসী > ০)' : 'না (প্রবাসী ০)';
    const mkStep = (lbl, key, val) => `
      <span class="fc-s5-stepper">
        <span>${lbl}</span>
        <button type="button" class="fc-s5-step-btn" data-s5-step="${key}:-1">−</button>
        <span>${toBnDigits(val)}</span>
        <button type="button" class="fc-s5-step-btn" data-s5-step="${key}:1">+</button>
      </span>
    `;
    const checklistHtml = SECTION5_FIELD_SPECS.map((sp) => {
      const ok = Boolean(s5.seen && s5.seen[sp.key]);
      return `<span class="fc-s5-chk ${ok ? 'ok' : 'miss'}" data-s5-chk="${sp.key}">${ok ? '✓' : '•'} ${escapeHtml(sp.reqLabel)}</span>`;
    }).join('');
    const crossMismatchBanner = (members.totalMembers > 0 && !match.isExactMatch)
      ? `<div class="fc-s5-issues">👥 ট্যাব ৬-এ ${toBnDigits(members.totalMembers)} জন (পু ${toBnDigits(members.actualMale)}, না ${toBnDigits(members.actualFemale)}, হি ${toBnDigits(members.actualTrans)}) আছে — সিঙ্ক করতে "ট্যাব ৬ থেকে সংখ্যা আনুন" চাপুন।</div>`
      : '';

    const html = `
      <div class="fc-s5-head">
        <span>📊 <b>স্টেপ ৫: ফ্যামিলি কার্ড প্রোগ্রাম ভ্যালিডেটর</b></span>
        <span class="fc-s2-pill ${pillCls}">${pillTxt}</span>
      </div>
      <div class="fc-s5-stats-grid">
        <div class="fc-s5-card">
          <div class="fc-s5-card-title">👨‍👩‍👧‍👦 খানার সদস্য (সেকশন ৭-এ যাবে)</div>
          <div class="fc-s5-card-val">পু: ${toBnDigits(data.maleCount)} | না: ${toBnDigits(data.femaleCount)} | হি: ${toBnDigits(data.transCount)} → মোট ${toBnDigits(data.totalCount)} জন</div>
          <div style="font-size:10.5px; color:${match.isExactMatch ? '#15803d' : '#b45309'}; font-weight:700;">ট্যাব ৬: ${toBnDigits(members.totalMembers)} জন • ${escapeHtml(match.statusText)}</div>
        </div>
        <div class="fc-s5-card">
          <div class="fc-s5-card-title">💼 এমএফএস, প্রশিক্ষণ ও প্রবাসী</div>
          <div class="fc-s5-card-val">📱 ${escapeHtml(data.mfsAccount || 'খালি')} • 🎓 ${escapeHtml(data.training || 'খালি')}</div>
          <div style="font-size:10.5px; color:#0369a1; font-weight:700;">✈️ প্রবাসী: ${toBnDigits(s5.abroadTotal)} জন • বিদেশী অর্থ: ${abroadRemitTxt}</div>
        </div>
      </div>
      <div class="fc-s5-checklist">${checklistHtml}</div>
      ${s5.issues.length ? `<div class="fc-s5-issues ${!s5.abroadConsistent ? 'err' : ''}">⚠️ ${escapeHtml(s5.issues.join(' • '))}</div>` : ''}
      ${crossMismatchBanner}
      <div class="fc-s5-steppers">
        <span class="fc-s5-presets-lbl">👥 সদস্য সংখ্যা:</span>
        ${mkStep('👨 পু', 'male', data.maleCount)}
        ${mkStep('👩 না', 'female', data.femaleCount)}
        ${mkStep('⚧️ হি', 'trans', data.transCount)}
      </div>
      <div class="fc-s5-steppers">
        <span class="fc-s5-presets-lbl">✈️ প্রবাসী:</span>
        ${mkStep('পু', 'abroadMale', data.abroadMale)}
        ${mkStep('ম', 'abroadFemale', data.abroadFemale)}
        ${mkStep('হি', 'abroadTrans', data.abroadTrans)}
        <button type="button" class="fc-s5-chip ${s5.abroadTotal === 0 ? 'active' : ''}" data-s5-abroad="zero">সব ০ (না)</button>
      </div>
      <div class="fc-s5-presets">
        <span class="fc-s5-presets-lbl">📱 মোবাইল ব্যাংকিং:</span>${mfsChips}
        <span class="fc-s5-presets-lbl" style="margin-left:6px;">🎓 প্রশিক্ষণ:</span>${trChips}
      </div>
      <div class="fc-s2-actions">
        <button type="button" class="fc-s2-btn primary" data-s5-act="fill-defaults">⚡ বাকি ডিফল্ট বসান</button>
        ${members.totalMembers > 0 ? '<button type="button" class="fc-s2-btn accent" data-s5-act="sync-tab6">👥 ট্যাব ৬ থেকে সংখ্যা আনুন</button>' : ''}
        <button type="button" class="fc-s2-btn" data-s5-act="validate">🔍 স্টেপ ৫ যাচাই</button>
        <button type="button" class="fc-s2-btn" data-s5-act="jump-tab6">ট্যাব ৬-এ যান →</button>
      </div>
    `;

    let bar = wrap.querySelector('#fc-section5-toolbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fc-section5-toolbar';
      if (typeof wrap.insertBefore === 'function') wrap.insertBefore(bar, wrap.firstChild || null);
      else wrap.appendChild(bar);
    }
    if (bar.dataset.lastHtml !== html) {
      bar.dataset.lastHtml = html;
      bar.innerHTML = html;
    }

    if (!bar.__fcS5Bound) {
      bar.__fcS5Bound = true;
      bar.addEventListener('click', async (e) => {
        const stepBtn = e.target.closest('[data-s5-step]');
        if (stepBtn) {
          const [key, deltaStr] = stepBtn.getAttribute('data-s5-step').split(':');
          const delta = parseInt(deltaStr, 10) || 0;
          const stNow = inspectSection5Details();
          const dNow = stNow.data || {};
          const mapCur = {
            male: dNow.maleCount || 0,
            female: dNow.femaleCount || 0,
            trans: dNow.transCount || 0,
            abroadMale: dNow.abroadMale || 0,
            abroadFemale: dNow.abroadFemale || 0,
            abroadTrans: dNow.abroadTrans || 0
          };
          const nextVal = Math.max(0, Math.min(25, (mapCur[key] || 0) + delta));
          await autoFillSection5Defaults({ force: true, overrides: { [key]: nextVal } });
          return;
        }
        const abrZeroBtn = e.target.closest('[data-s5-abroad="zero"]');
        if (abrZeroBtn) {
          saveSection5Config({ abroadDefault: '০' });
          await autoFillSection5Defaults({ force: true, overrides: { abroadMale: '০', abroadFemale: '০', abroadTrans: '০' } });
          showToast('✅ সকল প্রবাসী সংখ্যা ০ (বিদেশী অর্থ: না) সেট হয়েছে!');
          return;
        }
        const mfsBtn = e.target.closest('[data-s5-mfs]');
        if (mfsBtn) {
          const m = mfsBtn.getAttribute('data-s5-mfs');
          saveSection5Config({ mfsAccount: m });
          await autoFillSection5Defaults({ force: true, overrides: { mfs: m } });
          showToast(`✅ মোবাইল ব্যাংকিং "${m}" নির্বাচন ও ডিফল্ট সেভ হয়েছে!`);
          return;
        }
        const trBtn = e.target.closest('[data-s5-tr]');
        if (trBtn) {
          const t = trBtn.getAttribute('data-s5-tr');
          saveSection5Config({ training: t });
          await autoFillSection5Defaults({ force: true, overrides: { training: t } });
          showToast(`✅ প্রশিক্ষণ তথ্য "${t}" নির্বাচন ও সেভ হয়েছে!`);
          return;
        }
        const actBtn = e.target.closest('[data-s5-act]');
        if (!actBtn) return;
        const act = actBtn.getAttribute('data-s5-act');
        if (act === 'fill-defaults') {
          const res = await autoFillSection5Defaults({ force: true, fillMissingOnly: true });
          showToast(`⚡ স্টেপ ৫-এর ${toBnDigits(res.filled)}টি খালি ডিফল্ট ফিল্ড পূরণ করা হয়েছে!`);
        } else if (act === 'sync-tab6') {
          const res = await autoFillSection5Defaults({ force: true, syncFromMembers: true });
          showToast(`👥 ট্যাব ৬ সদস্য অনুযায়ী সংখ্যা বসানো হয়েছে (${toBnDigits(res.filled)}টি আপডেট)!`);
        } else if (act === 'validate') {
          const st = inspectSection5Details();
          injectSection5Toolbar(panel, st);
          updateSummaryBadge(true);
          showToast(st.allValid ? `✅ স্টেপ ৫ যাচাই সফল (${toBnDigits(st.filledCount)}/${toBnDigits(st.totalRequired)})!` : `⚠️ ${st.issues[0] || 'স্টেপ ৫ অসম্পূর্ণ'}`);
        } else if (act === 'jump-tab6') {
          jumpToPortalSection('6');
        }
      });
    }
  }

  function scanFamilyMembers() {
    const tab6Panel = document.querySelector('[data-family-card-tab="6"]') ||
                      Array.from(document.querySelectorAll('.v-expansion-panel')).find(p => p.textContent.includes('ফ্যামিলি সদস্য'));

    const memberCards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
    if (memberCards.length === 0) {
      const allCards = Array.from(document.querySelectorAll('.fm-member-card'));
      if (allCards.length > 0) memberCards.push(...allCards);
    }

    let actualMale = 0;
    let actualFemale = 0;
    let actualTrans = 0;
    const membersDetail = [];

    let applicantGender = normalizeBn((lastExtractedData && lastExtractedData.gender) || '');
    if (!applicantGender) {
      const gLabels = Array.from(document.querySelectorAll('label')).filter(l => normalizeBn(l.textContent).startsWith('লিঙ্গ'));
      for (const gl of gLabels) {
        if (gl.closest('.fm-member-card')) continue;
        const parent = gl.closest('.col, [class*="col-"]');
        const sel = parent?.querySelector('.v-select__selection');
        if (sel && sel.textContent.trim()) {
          applicantGender = normalizeBn(sel.textContent);
          break;
        }
      }
    }

    const maleExactTerms = ['পুরুষ', 'স্বামী', 'পুত্র', 'ছেলে', 'পিতা', 'বাবা', 'ভাই', 'দাদা', 'নানা', 'নাতি', 'শ্বশুর', 'চাচা', 'মামা', 'ফুফা', 'খালু', 'দেবর', 'ভাসুর'];
    const femaleExactTerms = ['নারী', 'মহিলা', 'স্ত্রী', 'কন্যা', 'মেয়ে', 'মেয়ে', 'মাতা', 'মা', 'বোন', 'দাদী', 'নানী', 'নাতনি', 'শাশুড়ি', 'শাশুড়ি', 'চাচী', 'মামী', 'ফুফু', 'খালা', 'ননদ', 'জা'];
    const transExactTerms = ['হিজড়া', 'তৃতীয় লিঙ্গ'];

    function matchGenderFromTerm(raw) {
      const norm = normalizeBn(raw);
      if (!norm) return '';
      if (transExactTerms.some(t => norm === t || norm.includes(t))) return 'হিজড়া';
      if (maleExactTerms.some(t => norm === t)) return 'পুরুষ';
      if (femaleExactTerms.some(t => norm === t)) return 'নারী';
      const tokens = norm.split(/[\s\/,\-\(\)]+/).filter(Boolean);
      if (tokens.some(tk => maleExactTerms.includes(tk))) return 'পুরুষ';
      if (tokens.some(tk => femaleExactTerms.includes(tk))) return 'নারী';
      return '';
    }

    memberCards.forEach((card, idx) => {
      const isSelf = card.classList.contains('fm-member-card--self') || (card.textContent.includes('সদস্য - ১') && card.textContent.includes('নিজ'));
      let detectedGender = '';
      let relationship = '';

      if (isSelf) {
        relationship = 'নিজ / আবেদনকারী';
        if (applicantGender.includes('নারী') || applicantGender.includes('মহিলা')) {
          detectedGender = 'নারী';
        } else if (applicantGender.includes('হিজড়া')) {
          detectedGender = 'হিজড়া';
        } else if (applicantGender.includes('পুরুষ')) {
          detectedGender = 'পুরুষ';
        }
      } else {
        const selects = Array.from(card.querySelectorAll('.v-select'));
        for (const sel of selects) {
          const parentCol = sel.closest('.col, [class*="col-"]') || sel.parentElement;
          const lbl = normalizeBn(parentCol?.querySelector('label')?.textContent || '');
          const selVal = normalizeBn(sel.querySelector('.v-select__selection')?.textContent || '');
          if (!selVal) continue;

          if (/লিঙ্গ/i.test(lbl)) {
            if (selVal.includes('পুরুষ')) detectedGender = 'পুরুষ';
            else if (selVal.includes('নারী') || selVal.includes('মহিলা')) detectedGender = 'নারী';
            else if (selVal.includes('হিজড়া')) detectedGender = 'হিজড়া';
          } else if (/সম্পর্ক/i.test(lbl)) {
            relationship = selVal;
          }
        }

        if (!detectedGender && relationship) {
          detectedGender = matchGenderFromTerm(relationship);
        }

        if (!detectedGender) {
          const titleText = card.querySelector('.fm-member-title')?.textContent || '';
          detectedGender = matchGenderFromTerm(titleText);
        }
      }

      if (detectedGender === 'পুরুষ') actualMale++;
      else if (detectedGender === 'নারী') actualFemale++;
      else if (detectedGender === 'হিজড়া') actualTrans++;

      membersDetail.push({
        index: idx + 1,
        isSelf,
        relationship: relationship || (isSelf ? 'নিজ' : 'অজ্ঞাত'),
        gender: detectedGender || 'অজ্ঞাত'
      });
    });

    return {
      tab6Panel,
      totalMembers: memberCards.length,
      actualMale,
      actualFemale,
      actualTrans,
      membersDetail
    };
  }

  function computeCrossMatch(declared, actual) {
    if (!declared || declared.totalCount === 0) {
      return {
        diffMale: 0,
        diffFemale: 0,
        diffTrans: 0,
        diffTotal: 0,
        isExactMatch: false,
        statusType: 'empty',
        statusText: '⏳ সেকশন ৫ এর সদস্য সংখ্যা আগে পূরণ করুন'
      };
    }

    const diffMale = declared.maleCount - actual.actualMale;
    const diffFemale = declared.femaleCount - actual.actualFemale;
    const diffTrans = declared.transCount - actual.actualTrans;
    const diffTotal = declared.totalCount - actual.totalMembers;

    const isExactMatch = (diffTotal === 0 && diffMale === 0 && diffFemale === 0 && diffTrans === 0);

    const pendingParts = [];
    const excessParts = [];
    if (diffMale > 0) pendingParts.push(`পুরুষ ${toBnDigits(diffMale)} জন`);
    if (diffFemale > 0) pendingParts.push(`নারী ${toBnDigits(diffFemale)} জন`);
    if (diffTrans > 0) pendingParts.push(`হিজড়া ${toBnDigits(diffTrans)} জন`);

    if (diffMale < 0) excessParts.push(`পুরুষ ${toBnDigits(Math.abs(diffMale))} জন`);
    if (diffFemale < 0) excessParts.push(`নারী ${toBnDigits(Math.abs(diffFemale))} জন`);
    if (diffTrans < 0) excessParts.push(`হিজড়া ${toBnDigits(Math.abs(diffTrans))} জন`);

    let statusText = '';
    let statusType = 'pending';

    if (isExactMatch) {
      statusType = 'matched';
      statusText = `✅ শতভাগ সঠিক: সকল সদস্য (${toBnDigits(declared.totalCount)} জন) মিলেছে!`;
    } else if (excessParts.length > 0 && pendingParts.length > 0) {
      statusType = 'mismatch';
      statusText = `⚠️ অমিল: ${excessParts.join(', ')} অতিরিক্ত ও ${pendingParts.join(', ')} বাকি!`;
    } else if (excessParts.length > 0) {
      statusType = 'excess';
      statusText = `❌ অতিরিক্ত: ${excessParts.join(', ')} অতিরিক্ত সদস্য দেওয়া হয়েছে!`;
    } else {
      statusType = 'pending';
      statusText = `⏳ বাকি: ${pendingParts.join(', ')} (মোট বাকি ${toBnDigits(diffTotal)} জন)`;
    }

    return {
      diffMale,
      diffFemale,
      diffTrans,
      diffTotal,
      isExactMatch,
      statusType,
      statusText
    };
  }

  function injectCrossMatchHUD() {
    if (document.getElementById('fc-crossmatch-hud')) return;

    const hud = document.createElement('div');
    hud.id = 'fc-crossmatch-hud';
    hud.innerHTML = `
      <div class="fc-cm-header" id="fc-cm-toggle-btn">
        <h4>👥 সদস্য ক্রস-ম্যাচ (<span id="fc-cm-ratio">০/০</span>)</h4>
        <span class="fc-cm-toggle" id="fc-cm-min-icon">▾</span>
      </div>
      <div class="fc-cm-body">
        <div id="fc-cm-verdict-box" class="fc-cm-verdict fc-cm-verdict-pending">
          ⏳ পর্যবেক্ষণ চলছে...
        </div>
        
        <div class="fc-cm-grid">
          <div class="fc-cm-stat-card">
            <div class="fc-cm-stat-title">📋 সেকশন ৫ ঘোষণা</div>
            <div class="fc-cm-stat-val" id="fc-cm-declared-counts">পু: ০ | না: ০ | হি: ০</div>
            <div style="font-size: 10px; color: #0d9488; font-weight: 600;">মোট: <span id="fc-cm-declared-total">০</span> জন</div>
          </div>
          <div class="fc-cm-stat-card">
            <div class="fc-cm-stat-title">📝 বর্তমান এন্ট্রি</div>
            <div class="fc-cm-stat-val" id="fc-cm-actual-counts">পু: ০ | না: ০ | হি: ০</div>
            <div style="font-size: 10px; color: #0d9488; font-weight: 600;">মোট: <span id="fc-cm-actual-total">০</span> জন</div>
          </div>
        </div>

        <div class="fc-cm-detail-list">
          <div class="fc-cm-row">
            <span>👨 পুরুষ সদস্য</span>
            <span id="fc-cm-male-status" class="fc-cm-badge fc-cm-badge-pending">০/০</span>
          </div>
          <div class="fc-cm-row">
            <span>👩 নারী সদস্য</span>
            <span id="fc-cm-female-status" class="fc-cm-badge fc-cm-badge-pending">০/০</span>
          </div>
          <div class="fc-cm-row">
            <span>⚧️ হিজড়া সদস্য</span>
            <span id="fc-cm-trans-status" class="fc-cm-badge fc-cm-badge-pending">০/০</span>
          </div>
        </div>

        <div id="fc-cm-extra-info" style="font-size: 10.5px; color: #475569; background: #f8fafc; padding: 6px 8px; border-radius: 6px; line-height: 1.35;">
          📱 এমএফএস: <b id="fc-cm-mfs">প্রযোজ্য নয়</b> | 🎓 প্রশিক্ষণ: <b id="fc-cm-training">-</b><br>
          ✈️ প্রবাসী সদস্য: <span id="fc-cm-abroad">০ জন</span> | <span id="fc-cm-cloud-stat" style="color: #0f766e; font-weight: 600;">☁️ ক্লাউড অটো-সিঙ্ক প্রস্তুত</span>
        </div>
        <div class="fc-cm-s5-row">
          <span id="fc-cm-s5-pill">স্টেপ ৫: ০/৮</span>
          <button type="button" id="fc-cm-jump-btn" class="fc-cm-jump-btn">ট্যাব ৬ →</button>
        </div>
      </div>
    `;
    document.body.appendChild(hud);

    const toggleBtn = document.getElementById('fc-cm-toggle-btn');
    const minIcon = document.getElementById('fc-cm-min-icon');
    toggleBtn.addEventListener('click', () => {
      hud.classList.toggle('minimized');
      minIcon.textContent = hud.classList.contains('minimized') ? '▴' : '▾';
    });
    const jumpBtn = document.getElementById('fc-cm-jump-btn');
    if (jumpBtn) {
      jumpBtn.addEventListener('click', () => {
        const s6El = document.querySelector('[data-family-card-tab="6"]');
        const isS6Now = Boolean(s6El && isPanelActiveVisible(s6El));
        jumpToPortalSection(isS6Now ? '3' : '6');
      });
    }
  }

  function injectTab6Banner(container, declared, actual, match) {
    if (!container) return;
    let banner = document.getElementById('fc-tab6-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'fc-tab6-banner';
      container.insertBefore(banner, container.firstChild);
    }

    const sec8 = trackSection8Data();
    const stuCount = sec8 ? sec8.studentCount : 0;
    const women18Count = sec8 ? sec8.womenOver18Count : 0;

    const renderHash = [
      declared ? declared.maleCount : 0,
      declared ? declared.femaleCount : 0,
      declared ? declared.transCount : 0,
      declared ? declared.totalCount : 0,
      actual.actualMale,
      actual.actualFemale,
      actual.actualTrans,
      actual.totalMembers,
      match.statusType,
      match.statusText,
      stuCount,
      women18Count
    ].join('|');
    if (banner.dataset.renderHash === renderHash) return;
    banner.dataset.renderHash = renderHash;

    let bg = '#f0fdf4';
    let border = '#86efac';
    let textColor = '#166534';
    let badgeBg = '#dcfce7';

    if (match.statusType === 'pending') {
      bg = '#fffbeb';
      border = '#fde68a';
      textColor = '#92400e';
      badgeBg = '#fef3c7';
    } else if (match.statusType === 'mismatch' || match.statusType === 'excess') {
      bg = '#fef2f2';
      border = '#fecaca';
      textColor = '#991b1b';
      badgeBg = '#fee2e2';
    }

    banner.style.cssText = `margin-bottom: 14px; padding: 10px 14px; background: ${bg}; border: 1.5px solid ${border}; border-radius: 10px; font-family: -apple-system, sans-serif; box-shadow: 0 2px 6px rgba(0,0,0,0.04);`;

    banner.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: ${textColor}; font-size: 13px;">
          <span>👥 ফ্যামিলি সদস্য ক্রস-ম্যাচ ভ্যালিডেটর</span>
        </div>
        <span style="background: ${badgeBg}; color: ${textColor}; font-weight: 800; font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid ${border};">
          ${match.statusText}
        </span>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11.5px; background: rgba(255,255,255,0.7); padding: 6px 10px; border-radius: 6px;">
        <div>
          <b style="color: #1e3a8a;">📋 সেকশন ৫ ঘোষণা:</b> 
          পু: <b>${toBnDigits(declared ? declared.maleCount : 0)}</b> | না: <b>${toBnDigits(declared ? declared.femaleCount : 0)}</b> | হি: <b>${toBnDigits(declared ? declared.transCount : 0)}</b> | মোট: <b>${toBnDigits(declared ? declared.totalCount : 0)}</b>
        </div>
        <div>
          <b style="color: #047857;">📝 বর্তমান এন্ট্রি:</b> 
          পু: <b>${toBnDigits(actual.actualMale)}</b> | না: <b>${toBnDigits(actual.actualFemale)}</b> | হি: <b>${toBnDigits(actual.actualTrans)}</b> | মোট: <b>${toBnDigits(actual.totalMembers)}</b>
        </div>
      </div>
      <div style="margin-top: 6px; font-size: 11px; color: #334155; background: rgba(255,255,255,0.65); padding: 4px 8px; border-radius: 6px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
        <span>🎓 শিক্ষার্থী: <b>${toBnDigits(stuCount)} জন</b> → সেকশন ৯ শিক্ষা ভাতা: <b style="color: ${stuCount > 0 ? '#15803d' : '#b45309'};">${stuCount > 0 ? '✅ বরাদ্দ হবে' : '০ টাকা (শিক্ষার্থী নেই)'}</b></span>
        <span>•</span>
        <span>👩 নারী (>১৮): <b>${toBnDigits(women18Count)} জন</b> (গৃহিণী ডিফল্ট)</span>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
        <button id="fc-s8-scan-member-btn" type="button" style="background: #0284c7; color: #fff; border: none; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 11.5px; cursor: pointer; display: flex; align-items: center; gap: 5px; box-shadow: 0 1px 3px rgba(0,0,0,0.12);">
          📸 সদস্যের NID / জন্ম নিবন্ধন স্ক্যান
        </button>
        <button id="fc-s8-add-member-btn" type="button" style="background: #059669; color: #fff; border: none; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 11.5px; cursor: pointer; display: flex; align-items: center; gap: 5px; box-shadow: 0 1px 3px rgba(0,0,0,0.12);">
          ➕ নতুন সদস্য যোগ করুন
        </button>
        <button id="fc-s8-fill-defaults-btn" type="button" style="background: #7c3aed; color: #fff; border: none; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 11.5px; cursor: pointer; display: flex; align-items: center; gap: 5px; box-shadow: 0 1px 3px rgba(0,0,0,0.12);">
          ⚡ স্মার্ট ডিফল্ট দিন
        </button>
      </div>
    `;

    const scanBtn = banner.querySelector('#fc-s8-scan-member-btn');
    if (scanBtn) {
      scanBtn.onclick = () => {
        openMemberScanner(null, 'auto');
      };
    }
    const addBtn = banner.querySelector('#fc-s8-add-member-btn');
    if (addBtn) {
      addBtn.onclick = () => {
        triggerPortalAddMember();
      };
    }
    const defBtn = banner.querySelector('#fc-s8-fill-defaults-btn');
    if (defBtn) {
      defBtn.onclick = () => {
        applySmartDefaultsToAllMembers({ force: true });
      };
    }
  }

  async function syncCrossMatchToFirestore(sec5Data, membersData, matchResult) {
    try {
      const cleanId = getSafeFamilyDocId(lastExtractedData);
      if (!cleanId) return;

      const fields = {
        section5_male_declared: { integerValue: String(sec5Data ? sec5Data.maleCount : 0) },
        section5_female_declared: { integerValue: String(sec5Data ? sec5Data.femaleCount : 0) },
        section5_trans_declared: { integerValue: String(sec5Data ? sec5Data.transCount : 0) },
        section5_total_declared: { integerValue: String(sec5Data ? sec5Data.totalCount : 0) },
        section6_actual_male: { integerValue: String(membersData.actualMale || 0) },
        section6_actual_female: { integerValue: String(membersData.actualFemale || 0) },
        section6_actual_trans: { integerValue: String(membersData.actualTrans || 0) },
        section6_actual_total: { integerValue: String(membersData.totalMembers || 0) },
        family_members_cross_matched: { booleanValue: !!matchResult.isExactMatch },
        crossmatch_status_text: { stringValue: matchResult.statusText || '' },
        section5_crossmatch_updated_at: { timestampValue: new Date().toISOString() }
      };

      const updateMask = [
        'updateMask.fieldPaths=section5_male_declared',
        'updateMask.fieldPaths=section5_female_declared',
        'updateMask.fieldPaths=section5_trans_declared',
        'updateMask.fieldPaths=section5_total_declared',
        'updateMask.fieldPaths=section6_actual_male',
        'updateMask.fieldPaths=section6_actual_female',
        'updateMask.fieldPaths=section6_actual_trans',
        'updateMask.fieldPaths=section6_actual_total',
        'updateMask.fieldPaths=family_members_cross_matched',
        'updateMask.fieldPaths=crossmatch_status_text',
        'updateMask.fieldPaths=section5_crossmatch_updated_at'
      ];

      if (sec5Data && sec5Data.mfsAccount) {
        fields.section5_mfs_account = { stringValue: sec5Data.mfsAccount };
        updateMask.push('updateMask.fieldPaths=section5_mfs_account');
      }
      if (sec5Data && sec5Data.training) {
        fields.section5_social_training = { stringValue: sec5Data.training };
        updateMask.push('updateMask.fieldPaths=section5_social_training');
      }
      if (sec5Data && sec5Data.abroadMale !== undefined) {
        fields.section5_abroad_male = { integerValue: String(sec5Data.abroadMale) };
        updateMask.push('updateMask.fieldPaths=section5_abroad_male');
      }
      if (sec5Data && sec5Data.abroadFemale !== undefined) {
        fields.section5_abroad_female = { integerValue: String(sec5Data.abroadFemale) };
        updateMask.push('updateMask.fieldPaths=section5_abroad_female');
      }
      if (sec5Data && sec5Data.abroadTrans !== undefined) {
        fields.section5_abroad_trans = { integerValue: String(sec5Data.abroadTrans) };
        updateMask.push('updateMask.fieldPaths=section5_abroad_trans');
      }

      const url = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(cleanId)}?${updateMask.join('&')}`;

      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
      console.log('[FamilyCard Extension] Section 5 & Cross-Match data synced to Firestore for family ID:', cleanId);

      const cloudEl = document.getElementById('fc-cm-cloud-stat');
      if (cloudEl) {
        cloudEl.textContent = `☁️ ক্লাউডে সংরক্ষিত (আইডি: ${cleanId})`;
      }
    } catch (e) {
      console.warn('[FamilyCard Extension] Firestore cross-match sync notice:', e.message);
    }
  }

  let lastCmHudHash = '';

  function handleSection5AndCrossMatch() {
    const s5Panel = document.querySelector('[data-family-card-tab="3"]');
    const s6Panel = document.querySelector('[data-family-card-tab="6"]');
    const isS5Visible = Boolean(s5Panel && isPanelActiveVisible(s5Panel));
    const isS6Visible = Boolean(s6Panel && isPanelActiveVisible(s6Panel));

    if (!isS5Visible && !isS6Visible) {
      const hud = document.getElementById('fc-crossmatch-hud');
      if (hud && hud.style.display !== 'none') hud.style.display = 'none';
      const fid = scrapeFamilyId() || 'default';
      if (s5Panel && window.__fcSec5SeededFid !== fid) {
        window.__fcSec5SeededFid = fid;
        trackSection5Data();
      }
      return null;
    }

    const sec5Info = inspectSection5Details();
    const sec5Data = sec5Info.data || trackSection5Data();
    const membersData = scanFamilyMembers();

    if (isS5Visible && s5Panel) {
      injectSection5Toolbar(s5Panel, sec5Info, membersData);
      autoFillSection5Defaults();
    }

    injectCrossMatchHUD();
    const hudEl = document.getElementById('fc-crossmatch-hud');
    if (hudEl && hudEl.style.display !== 'block') hudEl.style.display = 'block';

    const match = computeCrossMatch(sec5Data, membersData);

    const stack = isS6Visible ? (document.querySelector('.fm-members-stack') || s6Panel?.querySelector('.v-expansion-panel-content__wrap')) : null;
    if (stack) {
      injectTab6Banner(stack, sec5Data, membersData, match);
      injectMemberCardButtons();
    }

    const cmHudHash = `${sec5Data ? JSON.stringify(sec5Data) : ''}|${sec5Info.allValid}|${membersData.actualMale}|${membersData.actualFemale}|${membersData.actualTrans}|${membersData.totalMembers}|${match.statusType}|${match.statusText}|${isS6Visible}`;
    if (cmHudHash !== lastCmHudHash) {
      lastCmHudHash = cmHudHash;
      const s5PillEl = document.getElementById('fc-cm-s5-pill');
      if (s5PillEl) {
        s5PillEl.textContent = `স্টেপ ৫: ${toBnDigits(sec5Info.filledCount)}/${toBnDigits(sec5Info.totalRequired)} ${sec5Info.allValid ? '✅' : '⚠️'}`;
        s5PillEl.style.color = sec5Info.allValid ? '#15803d' : '#b45309';
      }
      const cmJumpEl = document.getElementById('fc-cm-jump-btn');
      if (cmJumpEl) cmJumpEl.textContent = isS6Visible ? '← স্টেপ ৫' : 'ট্যাব ৬ →';

      const ratioEl = document.getElementById('fc-cm-ratio');
      if (ratioEl) {
        const decTotal = sec5Data ? sec5Data.totalCount : 0;
        ratioEl.textContent = `${toBnDigits(membersData.totalMembers)}/${toBnDigits(decTotal)} ${match.isExactMatch ? '✅' : ''}`;
      }

      const verdictBox = document.getElementById('fc-cm-verdict-box');
      if (verdictBox) {
        verdictBox.textContent = match.statusText;
        verdictBox.className = `fc-cm-verdict fc-cm-verdict-${match.statusType}`;
      }

      const decCountsEl = document.getElementById('fc-cm-declared-counts');
      const decTotEl = document.getElementById('fc-cm-declared-total');
      if (decCountsEl && sec5Data) {
        decCountsEl.textContent = `পু: ${toBnDigits(sec5Data.maleCount)} | না: ${toBnDigits(sec5Data.femaleCount)} | হি: ${toBnDigits(sec5Data.transCount)}`;
        if (decTotEl) decTotEl.textContent = toBnDigits(sec5Data.totalCount);
      }

      const actCountsEl = document.getElementById('fc-cm-actual-counts');
      const actTotEl = document.getElementById('fc-cm-actual-total');
      if (actCountsEl) {
        actCountsEl.textContent = `পু: ${toBnDigits(membersData.actualMale)} | না: ${toBnDigits(membersData.actualFemale)} | হি: ${toBnDigits(membersData.actualTrans)}`;
        if (actTotEl) actTotEl.textContent = toBnDigits(membersData.totalMembers);
      }

      function updateRowBadge(badgeId, actualCount, declaredCount) {
        const el = document.getElementById(badgeId);
        if (!el) return;
        el.textContent = `${toBnDigits(actualCount)} / ${toBnDigits(declaredCount)}`;
        if (actualCount === declaredCount && declaredCount > 0) {
          el.className = 'fc-cm-badge fc-cm-badge-matched';
        } else if (actualCount < declaredCount) {
          el.className = 'fc-cm-badge fc-cm-badge-pending';
        } else if (actualCount > declaredCount) {
          el.className = 'fc-cm-badge fc-cm-badge-excess';
        } else {
          el.className = 'fc-cm-badge fc-cm-badge-pending';
        }
      }

      updateRowBadge('fc-cm-male-status', membersData.actualMale, sec5Data ? sec5Data.maleCount : 0);
      updateRowBadge('fc-cm-female-status', membersData.actualFemale, sec5Data ? sec5Data.femaleCount : 0);
      updateRowBadge('fc-cm-trans-status', membersData.actualTrans, sec5Data ? sec5Data.transCount : 0);

      if (sec5Data) {
        const mfsEl = document.getElementById('fc-cm-mfs');
        if (mfsEl) mfsEl.textContent = sec5Data.mfsAccount || 'প্রযোজ্য নয়';
        const trainEl = document.getElementById('fc-cm-training');
        if (trainEl) trainEl.textContent = sec5Data.training || '-';
        const abroadEl = document.getElementById('fc-cm-abroad');
        if (abroadEl) {
          const abroadTot = (sec5Data.abroadMale || 0) + (sec5Data.abroadFemale || 0) + (sec5Data.abroadTrans || 0);
          abroadEl.textContent = `${toBnDigits(abroadTot)} জন`;
        }
      }
    }

    const currentHash = `${sec5Data ? JSON.stringify(sec5Data) : ''}|${membersData.actualMale}|${membersData.actualFemale}|${membersData.actualTrans}|${membersData.totalMembers}|${match.isExactMatch}`;
    if (currentHash !== lastCrossMatchHash) {
      lastCrossMatchHash = currentHash;
      syncCrossMatchToFirestore(sec5Data, membersData, match);
    }
    return { sec5Data, membersData, match };
  }

  // --- SECTION 6: BANK / MFS DETAILS (ব্যাংক/এমএফএস তথ্য - Tab 4) ---
  function getSection6BankElements() {
    const panel = document.querySelector('[data-family-card-tab="4"]') ||
                  Array.from(document.querySelectorAll('.v-expansion-panel')).find(p => normalizeBn(p.textContent).includes('ব্যাংক/এমএফএস তথ্য'));
    if (!panel) return null;

    let ownershipSelect = null;
    let branchSelect = null;
    let bankNameSelect = null;
    let emailInput = null;

    const allCols = Array.from(panel.querySelectorAll('.col, [class*="col-"]'));
    for (const col of allCols) {
      const labelText = normalizeBn(col.querySelector('label')?.textContent || '');
      if (!labelText) continue;
      if (!ownershipSelect && labelText.includes('অ্যাকাউন্টের মালিকানা')) {
        ownershipSelect = col.querySelector('.v-select') || col;
      } else if (!branchSelect && labelText.includes('ব্যাংক শাখার নাম')) {
        branchSelect = col.querySelector('.v-select, .v-autocomplete') || col;
      } else if (!bankNameSelect && labelText.includes('ব্যাংকের নাম')) {
        bankNameSelect = col.querySelector('.v-select') || col;
      } else if (!emailInput && labelText.includes('ইমেইল')) {
        emailInput = col.querySelector('input');
      }
    }

    const activeRadio = panel.querySelector('#account_type .v-radio.v-item--active label, .v-radio.v-item--active label');
    const accountTypeText = normalizeBn(activeRadio?.textContent || 'ব্যাংক অ্যাকাউন্ট');

    return { panel, ownershipSelect, branchSelect, bankNameSelect, emailInput, accountTypeText };
  }

  const DEFAULT_BANK_BRANCH = 'মাছপাড়া শাখা';
  let isSelectingBranch = false;
  let isSelectingOwnership = false;
  let isFillingSection6 = false;
  let lastSec6FillTs = 0;
  let activeSec6Promise = null;

  function getDefaultBankBranch() {
    const saved = normalizeBn(localStorage.getItem('fc_default_bank_branch') || '');
    if (!saved) return DEFAULT_BANK_BRANCH;
    return saved === normalizeBn(DEFAULT_BANK_BRANCH) ? DEFAULT_BANK_BRANCH : saved;
  }

  function looseBranchKey(s) {
    return normalizeBn(s).replace(/[\s\u200c\u200d.,:;'"\-–—\/()\[\]]+/g, '').replace(/শাখা$/, '');
  }

  function branchMatches(actual, target) {
    const a = looseBranchKey(actual);
    const t = looseBranchKey(target);
    if (!a || !t) return false;
    return a === t || a.includes(t);
  }

  function readSection6BranchState(col) {
    if (!col) {
      return { text: '', rawText: '', hidden: '', input: null, hiddenEl: null, isAutocomplete: false, hasSelectionEl: false, isDirty: false, searching: false };
    }
    const sel = col.querySelector('.v-select__selection');
    const inp = col.querySelector('input:not([type="hidden"])');
    const hid = col.querySelector('input[type="hidden"]');
    const selRaw = String(sel ? sel.textContent : '').trim();
    const inpRaw = String(inp ? inp.value : '').trim();
    const selText = normalizeBn(selRaw);
    const inpText = normalizeBn(inpRaw);
    return {
      text: selText || inpText,
      rawText: selRaw || inpRaw,
      hidden: hid ? String(hid.value || '') : '',
      input: inp,
      hiddenEl: hid,
      isAutocomplete: Boolean(col.classList && col.classList.contains('v-autocomplete')),
      hasSelectionEl: Boolean(sel),
      isDirty: Boolean(col.classList && col.classList.contains('v-input--is-dirty')),
      searching: col.dataset?.fcS6Searching === 'true'
    };
  }

  function isSelectedBranchMatch(st, target) {
    if (!st || st.searching || !branchMatches(st.text, target)) return false;
    // Reject unconfirmed raw search text in v-autocomplete when no item/hidden ID has been selected yet
    if (st.hiddenEl && !st.hidden && st.isAutocomplete && !st.hasSelectionEl) {
      const normTarget = normalizeBn(target);
      const normText = normalizeBn(st.text);
      if (normTarget.includes('শাখা') && !normText.includes('শাখা')) return false;
    }
    return true;
  }

  function inspectSection6Bank() {
    const elems = getSection6BankElements();
    const target = getDefaultBankBranch();
    if (!elems) {
      return { hasDom: false, elems: null, target, branchText: '', ownership: '', bankName: '', isBankAccount: true, branchOk: false, ownershipOk: false, allValid: false, issues: [] };
    }
    const isBankAccount = !elems.accountTypeText || elems.accountTypeText.includes('ব্যাংক') || Boolean(elems.branchSelect);
    const st = readSection6BranchState(elems.branchSelect);
    const ownership = normalizeBn(elems.ownershipSelect?.querySelector('.v-select__selection')?.textContent || '');
    const bankName = normalizeBn(elems.bankNameSelect?.querySelector('.v-select__selection')?.textContent || '');
    const branchOk = !isBankAccount ? true : isSelectedBranchMatch(st, target);
    const ownershipOk = !elems.ownershipSelect || Boolean(ownership);
    const issues = [];
    if (isBankAccount && elems.branchSelect) {
      if (!st.text) issues.push(`ব্যাংক শাখা খালি — ড্রপডাউন ০ থেকে "${target}" দিন`);
      else if (!branchOk) issues.push(`ব্যাংক শাখা "${st.text}" সঠিক নয় — "${target}" হতে হবে`);
    }
    if (!ownershipOk) issues.push('অ্যাকাউন্টের মালিকানা নির্বাচন করুন');
    return {
      hasDom: true,
      elems,
      target,
      branchText: st.text,
      branchHidden: st.hidden,
      ownership,
      bankName,
      isBankAccount,
      branchOk,
      ownershipOk,
      allValid: branchOk && ownershipOk,
      issues
    };
  }

  function isMenuHostClosed(el) {
    if (!el) return false;
    const host = (el.classList && el.classList.contains('v-menu__content'))
      ? el
      : (el.closest ? el.closest('.v-menu__content, .v-autocomplete__content') : null);
    if (!host) return false;
    return Boolean(host.style && host.style.display === 'none' && !(host.classList && host.classList.contains('menuable__content__active')));
  }

  function collectVuetifyMenuItems(listId, attempts) {
    let items = [];
    if (listId) {
      const listEl = document.getElementById(listId);
      if (listEl && !isMenuHostClosed(listEl)) items = Array.from(listEl.querySelectorAll('.v-list-item'));
    }
    if (items.length === 0) {
      items = Array.from(document.querySelectorAll('.v-menu__content.menuable__content__active .v-list-item, .v-autocomplete__content.menuable__content__active .v-list-item'));
    }
    if (items.length === 0 && attempts >= 3) {
      items = Array.from(document.querySelectorAll('.v-menu__content .v-list-item, .v-autocomplete__content .v-list-item'))
        .filter(el => !isMenuHostClosed(el) && el.offsetParent !== null);
    }
    return items.filter(it => {
      if (it.classList && it.classList.contains('v-list-item--disabled')) return false;
      const txt = normalizeBn(it.textContent);
      return txt && !/no data available|কোনো তথ্য নেই|পাওয়া যায়নি|তথ্য পাওয়া যায়নি/i.test(txt);
    });
  }

  // Update v-autocomplete search text without dispatching blur (Vuetify closes the menu on blur)
  function setAutocompleteSearchInput(inputEl, value) {
    if (!inputEl || inputEl.disabled) return false;
    const nextVal = String(value ?? '');
    if (typeof inputEl.focus === 'function') inputEl.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(inputEl, nextVal);
    else inputEl.value = nextVal;
    try {
      inputEl.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: nextVal ? 'insertText' : 'deleteContentBackward',
        data: nextVal
      }));
    } catch (_) {
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }

  function buildBranchSearchQueries(targetText) {
    const rawFull = String(targetText || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const rawStem = rawFull.replace(/\s*শাখা\s*$/, '').trim() || rawFull;
    const normStem = normalizeBn(rawStem);
    const decomposedStem = normStem
      .replace(/\u09DC/g, '\u09A1\u09BC')
      .replace(/\u09DD/g, '\u09A2\u09BC')
      .replace(/\u09DF/g, '\u09AF\u09BC');
    // Pre-nukta slice (e.g. "মাছপা" for "মাছপাড়া") matches both nukta encodings in strict Vuetify filters
    const preNukta = rawStem.split(/[\u09DC\u09DD\u09DF\u09BC]/)[0].trim().replace(/[\u09A1\u09A2\u09AF]$/, '').trim();
    const shortStem = preNukta.length >= 3 ? preNukta : rawStem.slice(0, Math.min(5, rawStem.length));
    const tinyStem = rawStem.length > 3 ? rawStem.slice(0, 3) : '';
    const out = [];
    for (const q of [rawStem, decomposedStem, normStem, shortStem, tinyStem]) {
      if (q && !out.includes(q)) out.push(q);
    }
    return out;
  }

  async function selectVuetifyAutocomplete(container, targetText) {
    if (!container || !targetText) return false;
    const st0 = readSection6BranchState(container);
    if (isSelectedBranchMatch(st0, targetText)) return true;
    if (isSelectingBranch) return false;
    isSelectingBranch = true;
    container.dataset.fcS6Searching = 'true';
    const waitMs = (ms) => new Promise(r => setTimeout(r, ms));

    try {
      const inputEl = st0.input;
      const clickSlot = container.querySelector('.v-input__slot') || inputEl;
      const appendBtn = container.querySelector('.v-input__icon--append .v-icon, .v-input__icon--append');
      const listId = clickSlot?.getAttribute('aria-owns') || container.querySelector('[aria-owns]')?.getAttribute('aria-owns');

      const isMenuOpen = () => {
        const listEl = listId ? document.getElementById(listId) : null;
        const activeList = Boolean(listEl && ((listEl.classList && listEl.classList.contains('menuable__content__active')) || (listEl.style && listEl.style.display === 'block')));
        return clickSlot?.getAttribute('aria-expanded') === 'true' || activeList;
      };
      const openMenu = () => {
        if (isMenuOpen()) return;
        if (clickSlot) clickSlot.click();
        else if (appendBtn) appendBtn.click();
      };

      // Clear any stale/wrong selection first and wait one Vue tick so clearableCallback doesn't wipe the new search text
      if (st0.text || st0.hidden || st0.isDirty) {
        const clearBtn = container.querySelector('.v-input__icon--clear button, .v-input__icon--clear .v-icon');
        if (clearBtn) clearBtn.click();
        if (inputEl) setAutocompleteSearchInput(inputEl, '');
        await waitMs(80);
      }

      openMenu();
      if (inputEl && typeof inputEl.focus === 'function') inputEl.focus();
      await waitMs(45);

      const queries = buildBranchSearchQueries(targetText);
      let qIdx = 0;
      let activeQuery = queries[0] || normalizeBn(targetText);
      if (inputEl) setAutocompleteSearchInput(inputEl, activeQuery);

      const targetKey = looseBranchKey(targetText);
      let matchedItem = null;
      for (let attempts = 1; attempts <= 14; attempts++) {
        await waitMs(110);
        let items = collectVuetifyMenuItems(listId, attempts);
        if (items.length === 0 && !isMenuOpen()) {
          openMenu();
          if (inputEl) {
            inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            setAutocompleteSearchInput(inputEl, activeQuery);
          }
          await waitMs(50);
          items = collectVuetifyMenuItems(listId, attempts);
        }

        let match = items.find(it => looseBranchKey(it.textContent) === targetKey) ||
                    items.find(it => branchMatches(it.textContent, targetText));
        if (!match && items.length > 0 && activeQuery && branchMatches(items[0].textContent, activeQuery)) {
          match = items[0];
        }
        if (match) {
          matchedItem = match;
          break;
        }

        if (inputEl && (attempts === 2 || attempts === 4 || attempts === 6 || attempts === 9)) {
          if (qIdx + 1 < queries.length) {
            qIdx++;
            activeQuery = queries[qIdx];
            setAutocompleteSearchInput(inputEl, activeQuery);
          } else if (attempts === 9 && activeQuery !== '') {
            activeQuery = '';
            setAutocompleteSearchInput(inputEl, '');
          }
        }
      }

      if (matchedItem) {
        const clickable = (matchedItem.closest && matchedItem.closest('.v-list-item')) || matchedItem;
        const picked = normalizeBn(clickable.textContent);
        clickable.click();
        await waitMs(90);
        const stAfter = readSection6BranchState(container);
        if (!branchMatches(stAfter.text, picked || targetText)) {
          const inner = clickable.querySelector('.v-list-item__title, .v-list-item__content');
          if (inner) inner.click();
          await waitMs(70);
        }
        delete container.dataset.fcS6Searching;
        console.log('[FamilyCard Extension] Selected branch from dropdown 0:', picked);
        showToast(`✅ ব্যাংক শাখা "${picked}" ড্রপডাউন ০ থেকে নির্বাচিত হয়েছে!`);
        await waitMs(140);
        return true;
      }

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      console.warn('[FamilyCard Extension] Branch option not found in dropdown:', targetText);
      return false;
    } catch (e) {
      console.warn('[FamilyCard Extension] Error in selectVuetifyAutocomplete:', e);
      return false;
    } finally {
      delete container.dataset.fcS6Searching;
      isSelectingBranch = false;
    }
  }

  function selectVuetifyDropdown(container, targetText) {
    return new Promise((resolve) => {
      if (!container || !targetText) return resolve(false);

      const normTarget = normalizeBn(targetText);
      const currentSel = container.querySelector('.v-select__selection');
      if (currentSel && normalizeBn(currentSel.textContent).includes(normTarget)) return resolve(true);

      if (isSelectingOwnership) return resolve(false);
      isSelectingOwnership = true;

      try {
        const clickTarget = container.querySelector('.v-input__slot') || container.querySelector('input');
        if (!clickTarget) {
          isSelectingOwnership = false;
          return resolve(false);
        }

        const listId = clickTarget.getAttribute('aria-owns') || container.querySelector('[aria-owns]')?.getAttribute('aria-owns');
        clickTarget.click();
        let attempts = 0;
        const interval = setInterval(() => {
          attempts++;
          const items = collectVuetifyMenuItems(listId, attempts);
          const exact = items.find(it => normalizeBn(it.textContent) === normTarget);
          const match = exact || items.find(it => normalizeBn(it.textContent).includes(normTarget));
          if (match) {
            const clickable = (match.closest && match.closest('.v-list-item')) || match;
            clickable.click();
            clearInterval(interval);
            console.log('[FamilyCard Extension] Selected ownership:', targetText);
            showToast(`✅ অ্যাকাউন্টের মালিকানা "${targetText}" নির্বাচিত হয়েছে!`);
            setTimeout(() => { isSelectingOwnership = false; resolve(true); }, 250);
            return;
          }
          if (attempts >= 8) {
            clearInterval(interval);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            setTimeout(() => { isSelectingOwnership = false; resolve(false); }, 250);
          }
        }, 120);
      } catch (e) {
        console.warn('[FamilyCard Extension] Error in selectVuetifyDropdown:', e);
        isSelectingOwnership = false;
        resolve(false);
      }
    });
  }

  function updateSection6Status() {
    const statusEl = document.getElementById('fc-s6-status');
    const pillEl = document.getElementById('fc-s6-valid-pill');
    const s6 = inspectSection6Bank();
    if (pillEl) {
      pillEl.textContent = s6.allValid ? '✅ শাখা ভ্যালিডেটেড' : '⚠️ শাখা যাচাই বাকি';
      pillEl.className = `fc-s2-pill ${s6.allValid ? 'ok' : ''}`;
    }
    if (!statusEl) return s6;
    const html = s6.allValid
      ? `✅ ব্যাংক শাখা যাচাই সফল: "${escapeHtml(s6.branchText)}" (মালিকানা: ${escapeHtml(s6.ownership || 'নিজ')})`
      : `⚠️ ${escapeHtml(s6.issues[0] || 'ব্যাংক তথ্য যাচাই করুন')}`;
    if (statusEl.dataset.lastHtml !== html) {
      statusEl.dataset.lastHtml = html;
      statusEl.innerHTML = html;
      statusEl.className = `fc-s6-status ${s6.allValid ? 'ok' : (s6.branchText ? 'err' : 'warn')}`;
    }
    return s6;
  }

  function injectSection6Toolbar(panel, currentOwnership, currentBranch) {
    if (!panel || !isPanelActiveVisible(panel)) return;
    const wrap = panel.querySelector('.v-expansion-panel-content__wrap') || panel;

    const ownershipOptions = ['নিজ', 'স্বামী', 'স্ত্রী', 'পিতা', 'মাতা', 'অভিভাবক'];
    const defaultList = [DEFAULT_BANK_BRANCH, 'পাংশা শাখা', 'রাজবাড়ী শাখা'];
    const rawBranchList = safeJsonParse(localStorage.getItem('fc_branch_list'), defaultList);
    const branchList = [];
    const seenBr = new Set();
    [...(Array.isArray(rawBranchList) && rawBranchList.length ? rawBranchList : defaultList), currentBranch].forEach((b) => {
      const nb = normalizeBn(b);
      if (nb && !seenBr.has(looseBranchKey(nb))) {
        seenBr.add(looseBranchKey(nb));
        branchList.push(nb);
      }
    });

    const s6 = inspectSection6Bank();
    const ownChips = ownershipOptions.map(o => `<button type="button" class="fc-s5-chip fc-s6-chip ${normalizeBn(o) === normalizeBn(currentOwnership) ? 'active' : ''}" data-s6-own="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('');
    const branchChips = branchList.map(b => `<button type="button" class="fc-s5-chip fc-s6-chip ${branchMatches(b, currentBranch) ? 'active' : ''}" data-s6-br="${escapeHtml(b)}">🏛️ ${escapeHtml(b)}</button>`).join('');

    const html = `
      <div class="fc-s6-head">
        <span>🏦 <b>স্টেপ ৬: ব্যাংক ও শাখা ভ্যালিডেটর</b></span>
        <span id="fc-s6-valid-pill" class="fc-s2-pill ${s6.allValid ? 'ok' : ''}">${s6.allValid ? '✅ শাখা ভ্যালিডেটেড' : '⚠️ শাখা যাচাই বাকি'}</span>
      </div>
      <div id="fc-s6-status" class="fc-s6-status ${s6.allValid ? 'ok' : (s6.branchText ? 'err' : 'warn')}">${s6.allValid ? `✅ ব্যাংক শাখা যাচাই সফল: "${escapeHtml(s6.branchText)}" (মালিকানা: ${escapeHtml(s6.ownership || 'নিজ')})` : `⚠️ ${escapeHtml(s6.issues[0] || 'ব্যাংক তথ্য যাচাই করুন')}`}</div>
      <div class="fc-s5-presets">
        <span class="fc-s5-presets-lbl">👤 মালিকানা:</span>${ownChips}
      </div>
      <div class="fc-s5-presets">
        <span class="fc-s5-presets-lbl">🏛️ শাখা (Dropdown ০):</span>${branchChips}
      </div>
      <div class="fc-s4-inline-row">
        <input type="text" id="fc-s6-new-branch" class="fc-s4-inp" placeholder="নতুন ব্যাংক শাখা যোগ করুন (যেমন: ${DEFAULT_BANK_BRANCH})...">
        <button type="button" class="fc-s2-btn accent" data-s6-act="add-branch">➕ যোগ ও সেট</button>
      </div>
      <div class="fc-s2-actions">
        <button id="fc-s6-fix-branch-btn" type="button" class="fc-s2-btn primary" data-s6-act="fix-branch">🔁 শাখা ঠিক করুন (Dropdown ০)</button>
        <button id="fc-s6-auto-fill-btn" type="button" class="fc-s2-btn" data-s6-act="auto-fill">⚡ অটো-সিলেক্ট প্রয়োগ</button>
        <button type="button" class="fc-s2-btn" data-s6-act="validate">🔍 স্টেপ ৬ যাচাই</button>
      </div>
    `;

    let bar = wrap.querySelector('#fc-section6-toolbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fc-section6-toolbar';
      if (typeof wrap.insertBefore === 'function') wrap.insertBefore(bar, wrap.firstChild || null);
      else wrap.appendChild(bar);
    }
    const activeEl = document.activeElement;
    const isTypingInBar = activeEl && bar.contains(activeEl) && activeEl.id === 'fc-s6-new-branch';
    if (!isTypingInBar && bar.dataset.lastHtml !== html) {
      bar.dataset.lastHtml = html;
      bar.innerHTML = html;
    }

    if (!bar.__fcS6Bound) {
      bar.__fcS6Bound = true;
      bar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target?.id === 'fc-s6-new-branch') {
          e.preventDefault();
          bar.querySelector('[data-s6-act="add-branch"]')?.click();
        }
      });
      bar.addEventListener('click', async (e) => {
        const ownBtn = e.target.closest('[data-s6-own]');
        if (ownBtn) {
          const val = ownBtn.getAttribute('data-s6-own');
          localStorage.setItem('fc_default_account_ownership', val);
          const elems = getSection6BankElements();
          if (elems?.ownershipSelect) {
            delete elems.ownershipSelect.dataset.fcS6UserEdited;
            await selectVuetifyDropdown(elems.ownershipSelect, val);
          }
          await handleSection6Bank({ force: true });
          return;
        }
        const brBtn = e.target.closest('[data-s6-br]');
        if (brBtn) {
          const val = brBtn.getAttribute('data-s6-br');
          localStorage.setItem('fc_default_bank_branch', val);
          const elems = getSection6BankElements();
          if (elems?.branchSelect) delete elems.branchSelect.dataset.fcS6UserEdited;
          await handleSection6Bank({ force: true });
          return;
        }
        const actBtn = e.target.closest('[data-s6-act]');
        if (!actBtn) return;
        const act = actBtn.getAttribute('data-s6-act');
        if (act === 'add-branch') {
          const inp = bar.querySelector('#fc-s6-new-branch');
          const val = inp ? normalizeBn(inp.value) : '';
          if (!val) { showToast('⚠️ নতুন ব্যাংক শাখার নাম লিখুন!'); return; }
          const curList = safeJsonParse(localStorage.getItem('fc_branch_list'), defaultList);
          const list = Array.isArray(curList) ? [...curList] : [...defaultList];
          if (!list.some(b => branchMatches(b, val))) list.push(val);
          localStorage.setItem('fc_branch_list', JSON.stringify(list));
          localStorage.setItem('fc_default_bank_branch', val);
          if (inp) inp.value = '';
          await handleSection6Bank({ force: true });
        } else if (act === 'fix-branch' || act === 'auto-fill') {
          const elems = getSection6BankElements();
          if (elems?.branchSelect) delete elems.branchSelect.dataset.fcS6UserEdited;
          if (elems?.ownershipSelect) delete elems.ownershipSelect.dataset.fcS6UserEdited;
          await handleSection6Bank({ force: true });
          const st = updateSection6Status();
          showToast(st && st.branchOk ? `✅ ব্যাংক শাখা "${st.branchText}" ড্রপডাউন ০ থেকে নির্বাচিত!` : `⚠️ ${st?.issues[0] || 'ব্যাংক শাখা ড্রপডাউনে পাওয়া যায়নি'}`);
        } else if (act === 'validate') {
          const st = updateSection6Status();
          updateSummaryBadge(true);
          showToast(st && st.allValid ? `✅ স্টেপ ৬ যাচাই সফল: ${st.branchText}` : `⚠️ ${st?.issues[0] || 'ব্যাংক তথ্য যাচাই করুন'}`);
        }
      });
    }
  }

  async function handleSection6Bank(opts = {}) {
    const force = Boolean(opts && opts.force);
    const tab4 = document.querySelector('[data-family-card-tab="4"]');
    if (tab4 && !isPanelActiveVisible(tab4)) return null;

    const elems = getSection6BankElements();
    if (!elems || !elems.panel || !isPanelActiveVisible(elems.panel)) return null;

    const currentOwnership = localStorage.getItem('fc_default_account_ownership') || 'নিজ';
    const currentBranch = getDefaultBankBranch();

    injectSection6Toolbar(elems.panel, currentOwnership, currentBranch);

    if (elems.ownershipSelect && !elems.ownershipSelect.__fcS6GuardAttached) {
      elems.ownershipSelect.__fcS6GuardAttached = true;
      elems.ownershipSelect.addEventListener('mousedown', (e) => {
        if (e.isTrusted) elems.ownershipSelect.dataset.fcS6UserEdited = 'true';
      }, true);
    }
    if (elems.branchSelect && !elems.branchSelect.__fcS6GuardAttached) {
      elems.branchSelect.__fcS6GuardAttached = true;
      elems.branchSelect.addEventListener('input', (e) => {
        if (e.isTrusted && elems.branchSelect.dataset.fcS6Searching !== 'true') {
          elems.branchSelect.dataset.fcS6UserEdited = 'true';
        }
      }, true);
    }

    if (isFillingSection6) {
      if (force && activeSec6Promise) {
        try { await activeSec6Promise; } catch (_) {}
        return handleSection6Bank(opts);
      }
      return updateSection6Status();
    }
    if (!force && Date.now() - lastSec6FillTs < 320) { return updateSection6Status(); }
    isFillingSection6 = true;
    const runSec6 = (async () => {
      try {
        if (elems.ownershipSelect && (force || elems.ownershipSelect.dataset.fcS6UserEdited !== 'true')) {
          if (force) delete elems.ownershipSelect.dataset.fcS6UserEdited;
          const curOwn = elems.ownershipSelect.querySelector('.v-select__selection')?.textContent.trim();
          if (!curOwn) await selectVuetifyDropdown(elems.ownershipSelect, currentOwnership);
        }

        const branchCol = elems.branchSelect;
        if (branchCol && (force || branchCol.dataset.fcS6UserEdited !== 'true')) {
          if (force) delete branchCol.dataset.fcS6UserEdited;
          const st = readSection6BranchState(branchCol);
          const activeEl = document.activeElement;
          const isTyping = Boolean(activeEl && st.input && activeEl === st.input);
          if (!isSelectedBranchMatch(st, currentBranch) && (force || !isTyping)) {
            const famKey = scrapeFamilyId() || 'default';
            if (branchCol.dataset.fcS6TryKey !== famKey) {
              branchCol.dataset.fcS6TryKey = famKey;
              branchCol.dataset.fcS6Tries = '0';
              delete branchCol.dataset.fcS6LastTryTs;
            }
            const tries = Number(branchCol.dataset.fcS6Tries || 0);
            const lastTryAt = Number(branchCol.dataset.fcS6LastTryTs || 0);
            if (force || tries < 3 || (Date.now() - lastTryAt > 12000 && tries < 6)) {
              branchCol.dataset.fcS6Tries = String(tries + 1);
              branchCol.dataset.fcS6LastTryTs = String(Date.now());
              const ok = await selectVuetifyAutocomplete(branchCol, currentBranch);
              if (ok) branchCol.dataset.fcS6Tries = '0';
            }
          }
        }
      } finally {
        lastSec6FillTs = Date.now();
        isFillingSection6 = false;
        if (activeSec6Promise === runSec6) activeSec6Promise = null;
      }
    })();
    activeSec6Promise = runSec6;
    await runSec6;
    const finalStatus = updateSection6Status();
    injectSection6Toolbar(elems.panel, currentOwnership, currentBranch);
    if (force) updateSummaryBadge(true);
    return finalStatus;
  }

  // --- SECTION 7: OTHER ELIGIBILITY INFO (যোগ্যতার অন্যান্য তথ্য - Tab 5) ---
  // Rules:
  // 1. "খানাটি ক্ষুদ্র নৃগোষ্ঠী কি না *" -> "না"
  // 2. "খানাটি বা বাসস্থানটি কোথায় অবস্থিত *" -> "ইউনিয়ন/পল্লী এলাকায়"
  // 3. "ভূমির বা বসতঘরের মালিকানা ধরণ *" -> "নিজস্ব"
  // 4. "খানার সদস্য সংখ্যা *" -> Dynamic total from Section 5 (male + female + trans, in Bengali digits)
  // 5. "খানায় কি পৃথক রান্নাঘর আছে? *" -> "হ্যা"
  // 6. "খানায় কি পৃথক খাবার ঘর/কক্ষ আছে? *" -> "না"
  // 7. "খানার প্রধান ঘরের ছাদ কি দিয়ে তৈরী *" -> "টিন/কাঠ"
  // 8. "খানার প্রধান ঘরের দেয়াল কি দিয়ে তৈরী? *" -> "টিন/কাঠের"
  // 9. "খানায় খাবার পানির উৎস কি? *" -> "টিউবওয়েল"
  // 10. "রান্নার জ্বালানির প্রধান উপকরণ কি *" -> "খড়/পাতা/তুষ/ভূষি"
  // 11. "খানায় বিদ্যুৎ লাইনের উৎস *" -> "জাতীয় গ্রিড"
  // 12. "গত ২ বছরে আপনার খানা বিদেশে অবস্থানরত কারো নিকট হতে কোন অর্থ গ্রহণ করেছে কি? *" -> "হ্যা" if Section 5 abroad total > 0, else "না"
  // 13. "খানার কোন সদস্য কি কৃষি অথবা অকৃষি শ্রমিক হিসেবে নিয়োজিত আছেন? *" -> "কৃষি খাতে শ্রম"
  // 14. "কৃষি কাজে ডিজেল ব্যবহার হলে তার মাসিক আনুমানিক পরিমাণ *" -> "০ কেজি"
  // 15. Other fields remain untouched for manual input; user can manually alter any default value without being overwritten.

  let isFillingSection7 = false;
  let lastSec7FillTs = 0;
  let activeSec7Promise = null;

  function normOptionText(s) {
    return normalizeBn(s).replace(/[\/\s\u0981]+/g, '').trim();
  }

  function selectSingleVuetifyOption(col, candidates, opts = {}) {
    return new Promise((resolve) => {
      if (!col || !candidates || candidates.length === 0) return resolve(false);
      const tagAttr = opts.tagAttr || 'fcS7DefaultApplied';

      const hasVSelect = !!col.querySelector('.v-select');
      const plainInput = !hasVSelect ? col.querySelector('input:not([type="hidden"]):not([disabled])') : null;
      if (plainInput) {
        if (plainInput.value && candidates.some(c => normOptionText(plainInput.value) === normOptionText(c))) {
          col.dataset[tagAttr] = 'true';
          return resolve(true);
        }
        setReactiveValue(plainInput, candidates[0]);
        col.dataset[tagAttr] = 'true';
        return resolve(true);
      }

      const currentSel = col.querySelector('.v-select__selection');
      const curText = currentSel ? currentSel.textContent.trim() : '';

      if (curText && candidates.some(c => normalizeBn(curText) === normalizeBn(c) || normOptionText(curText) === normOptionText(c))) {
        col.dataset[tagAttr] = 'true';
        return resolve(true);
      }

      const slot = col.querySelector('.v-input__slot') || col.querySelector('[role="button"]') || col.querySelector('input');
      if (!slot) return resolve(false);

      const listId = slot.getAttribute('aria-owns') || col.querySelector('[aria-owns]')?.getAttribute('aria-owns');
      if (slot.getAttribute('aria-expanded') !== 'true') slot.click();

      const normCands = candidates.map(c => normalizeBn(c));
      let attempts = 0;
      const timer = setInterval(() => {
        attempts++;
        const items = collectVuetifyMenuItems(listId, attempts);

        if (items.length > 0) {
          let matchedItem = items.find(it => normCands.some(c => normalizeBn(it.textContent) === c));
          if (!matchedItem) {
            matchedItem = items.find(it => candidates.some(c => normOptionText(it.textContent) === normOptionText(c)));
          }
          if (!matchedItem) {
            matchedItem = items.find(it => normCands.some(c => c.length > 2 && normalizeBn(it.textContent).includes(c)));
          }

          if (matchedItem) {
            const clickable = matchedItem.closest('.v-list-item') || matchedItem;
            clickable.click();
            col.dataset[tagAttr] = 'true';
            clearInterval(timer);
            setTimeout(() => resolve(true), 140);
            return;
          }
        }

        if (attempts >= 8) {
          clearInterval(timer);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          col.dataset[tagAttr] = 'true';
          setTimeout(() => resolve(false), 70);
        }
      }, 90);
    });
  }

  function getSection7Rules(sec5Data) {
    const customDefaults = safeJsonParse(localStorage.getItem('fc_section7_custom_defaults'), {});
    const totalMembers = (sec5Data && sec5Data.totalCount > 0) ? sec5Data.totalCount : 0;
    const abroadTotal = sec5Data
      ? ((sec5Data.abroadMale || 0) + (sec5Data.abroadFemale || 0) + (sec5Data.abroadTrans || 0))
      : 0;
    const remittanceAnswer = abroadTotal > 0 ? 'হ্যা' : 'না';

    return [
      {
        key: 'ethnic_minority',
        match: (lbl) => lbl.includes('ক্ষুদ্র নৃগোষ্ঠী'),
        candidates: customDefaults.ethnic_minority ? [customDefaults.ethnic_minority] : ['না'],
        isDynamic: false
      },
      {
        key: 'residence_location',
        match: (lbl) => lbl.includes('বাসস্থানটি কোথায় অবস্থিত') || lbl.includes('বাসস্থানটি কোথায় অবস্থিত'),
        candidates: customDefaults.residence_location ? [customDefaults.residence_location] : ['ইউনিয়ন/পল্লী এলাকায়', 'ইউনিয়ন/পল্লী এলাকায়'],
        isDynamic: false
      },
      {
        key: 'land_ownership',
        match: (lbl) => lbl.includes('ভূমির বা বসতঘরের মালিকানা'),
        candidates: customDefaults.land_ownership ? [customDefaults.land_ownership] : ['নিজস্ব'],
        isDynamic: false
      },
      {
        key: 'household_members',
        match: (lbl) => lbl.includes('খানার সদস্য সংখ্যা'),
        candidates: totalMembers > 0 ? [toBnDigits(totalMembers), String(totalMembers)] : [],
        isDynamic: true,
        dynamicVal: String(totalMembers)
      },
      {
        key: 'separate_kitchen',
        match: (lbl) => lbl.includes('পৃথক রান্নাঘর আছে'),
        candidates: customDefaults.separate_kitchen ? [customDefaults.separate_kitchen] : ['হ্যা', 'হ্যাঁ'],
        isDynamic: false
      },
      {
        key: 'separate_dining',
        match: (lbl) => lbl.includes('পৃথক খাবার ঘর'),
        candidates: customDefaults.separate_dining ? [customDefaults.separate_dining] : ['না'],
        isDynamic: false
      },
      {
        key: 'roof_material',
        match: (lbl) => lbl.includes('প্রধান ঘরের ছাদ কি দিয়ে তৈরী') || lbl.includes('প্রধান ঘরের ছাদ'),
        candidates: customDefaults.roof_material ? [customDefaults.roof_material] : ['টিন/কাঠ', 'টিন কাঠ'],
        isDynamic: false
      },
      {
        key: 'wall_material',
        match: (lbl) => lbl.includes(normalizeBn('প্রধান ঘরের দেয়াল')) || lbl.includes(normalizeBn('প্রধান ঘরের দেওয়াল')),
        candidates: customDefaults.wall_material ? [customDefaults.wall_material] : ['টিন/কাঠের', 'টিন/কাঠ', 'টিন কাঠ'],
        isDynamic: false
      },
      {
        key: 'water_source',
        match: (lbl) => lbl.includes('খাবার পানির উৎস কি'),
        candidates: customDefaults.water_source ? [customDefaults.water_source] : ['টিউবওয়েল', 'টিউবওয়েল'],
        isDynamic: false
      },
      {
        key: 'cooking_fuel',
        match: (lbl) => lbl.includes('রান্নার জ্বালানির প্রধান উপকরণ কি') && !lbl.includes('এলপিজি'),
        candidates: customDefaults.cooking_fuel ? [customDefaults.cooking_fuel] : ['খড়/পাতা/তুষ/ভূষি', 'খড়/পাতা/তুষ/ভূষি'],
        isDynamic: false
      },
      {
        key: 'lpg_usage',
        match: (lbl) => lbl.includes('এলপিজি গ্যাস ব্যবহারের পরিমান') || lbl.includes('এলপিজি গ্যাস ব্যবহারের পরিমাণ'),
        candidates: customDefaults.lpg_usage ? [customDefaults.lpg_usage] : ['০ কেজি', '0 কেজি'],
        isDynamic: false
      },
      {
        key: 'electricity_source',
        match: (lbl) => lbl.includes('বিদ্যুৎ লাইনের উৎস'),
        candidates: customDefaults.electricity_source ? [customDefaults.electricity_source] : ['জাতীয় গ্রিড', 'জাতীয় গ্রিড'],
        isDynamic: false
      },
      {
        key: 'foreign_remittance',
        match: (lbl) => lbl.includes('বিদেশে অবস্থানরত কারো নিকট হতে কোন অর্থ গ্রহণ করেছে কি'),
        candidates: remittanceAnswer === 'হ্যা' ? ['হ্যা', 'হ্যাঁ'] : ['না'],
        isDynamic: true,
        dynamicVal: remittanceAnswer
      },
      {
        key: 'labor_sector',
        match: (lbl) => lbl.includes('কৃষি অথবা অকৃষি শ্রমিক হিসেবে নিয়োজিত আছেন') || lbl.includes('কৃষি অথবা অকৃষি শ্রমিক'),
        candidates: customDefaults.labor_sector ? [customDefaults.labor_sector] : ['কৃষি খাতে শ্রম'],
        isDynamic: false
      },
      {
        key: 'diesel_usage',
        match: (lbl) => lbl.includes('কৃষি কাজে ডিজেল ব্যবহার হলে তার মাসিক আনুমানিক পরিমাণ'),
        candidates: customDefaults.diesel_usage ? [customDefaults.diesel_usage] : ['০ কেজি', '0 কেজি'],
        isDynamic: false
      }
    ];
  }

  function inspectSection7Eligibility(panelOverride = null) {
    const panel = panelOverride || document.querySelector('[data-family-card-tab="5"]') ||
                  Array.from(document.querySelectorAll('.v-expansion-panel')).find(p => normalizeBn(p.textContent).includes('যোগ্যতার অন্যান্য তথ্য')) ||
                  null;
    const sec5 = trackSection5Data();
    if (!panel) {
      return {
        hasDom: false,
        panel: null,
        totalQuestions: 0,
        filledCount: 0,
        missingFields: [],
        issues: [],
        floorChecked: [],
        assetChecked: [],
        memberVal: null,
        childrenVal: null,
        roomsVal: '',
        remittanceVal: '',
        allValid: false
      };
    }

    const topCols = Array.from(panel.querySelectorAll('.col, [class*="col-"]')).filter(col => !col.closest('.fc-pmt-multi-grid'));
    let totalQuestions = 0;
    let filledCount = 0;
    const missingFields = [];
    const issues = [];
    let memberVal = null;
    let childrenVal = null;
    let roomsVal = '';
    let remittanceVal = '';
    let cookingFuelVal = '';
    let lpgVal = '';
    let floorChecked = [];
    let assetChecked = [];

    for (const col of topCols) {
      const labelEl = col.querySelector('label');
      if (!labelEl) continue;
      const lbl = normalizeBn(labelEl.textContent).replace(/[\*\s]+/g, ' ').trim();
      const shortLbl = lbl.split(/[(?]/)[0].trim().slice(0, 42);
      const multiGrid = col.querySelector('.fc-pmt-multi-grid');

      if (multiGrid) {
        totalQuestions++;
        const cbs = Array.from(multiGrid.querySelectorAll('input[type="checkbox"]'));
        const checkedLabels = cbs.filter(cb => {
          return Boolean(cb.checked || cb.getAttribute('aria-checked') === 'true' || cb.closest('.v-input--is-dirty'));
        }).map(cb => {
          const cid = cb.id;
          const cbLbl = (cid && multiGrid.querySelector(`label[for="${cid}"]`)) || cb.closest('.v-input')?.querySelector('label');
          return normalizeBn(cbLbl?.textContent || cb.value || '');
        }).filter(Boolean);

        if (checkedLabels.length > 0) filledCount++;
        else missingFields.push(shortLbl);

        if (lbl.includes('মেঝে') || lbl.includes('ফ্লোর')) floorChecked = checkedLabels;
        else if (lbl.includes('পরিসম্পদ')) assetChecked = checkedLabels;
        continue;
      }

      if (!col.querySelector('.v-select') && !col.querySelector('input:not([type="hidden"])')) continue;
      totalQuestions++;
      const curSelVal = normalizeBn(col.querySelector('.v-select__selection')?.textContent || '');
      const curPlainVal = !col.querySelector('.v-select') ? normalizeBn(col.querySelector('input:not([type="hidden"])')?.value || '') : '';
      const val = curSelVal || curPlainVal;
      if (val) filledCount++;
      else missingFields.push(shortLbl);

      if (lbl.includes('খানার সদস্য সংখ্যা')) {
        const n = parseInt(normalizeDigits(val).replace(/[^0-9]/g, ''), 10);
        if (!isNaN(n)) memberVal = n;
      } else if (lbl.includes('শিশু সংখ্যা')) {
        const n = parseInt(normalizeDigits(val).replace(/[^0-9]/g, ''), 10);
        if (!isNaN(n)) childrenVal = n;
      } else if (lbl.includes('রুম') || lbl.includes('কক্ষ সংখ্যা')) {
        roomsVal = val;
      } else if (lbl.includes('বিদেশে অবস্থানরত কারো নিকট হতে কোন অর্থ')) {
        remittanceVal = val;
      } else if (lbl.includes('রান্নার জ্বালানির প্রধান উপকরণ কি') && !lbl.includes('এলপিজি')) {
        cookingFuelVal = val;
      } else if (lbl.includes('এলপিজি গ্যাস ব্যবহারের পরিমান') || lbl.includes('এলপিজি গ্যাস ব্যবহারের পরিমাণ')) {
        lpgVal = val;
      }
    }

    if (sec5 && sec5.totalCount > 0 && memberVal !== null && memberVal !== sec5.totalCount) {
      issues.push(`সেকশন ৫ (${toBnDigits(sec5.totalCount)} জন) ও সেকশন ৭ সদস্য সংখ্যা (${toBnDigits(memberVal)} জন) মিলছে না`);
    }
    if (sec5 && remittanceVal) {
      const abroadTot = (sec5.abroadMale || 0) + (sec5.abroadFemale || 0) + (sec5.abroadTrans || 0);
      const isYes = remittanceVal.startsWith('হ্যা');
      if (abroadTot > 0 && !isYes) issues.push('সেকশন ৫-এ প্রবাসী আছে — বিদেশী অর্থ "হ্যা" হতে হবে');
      if (abroadTot === 0 && (sec5.totalCount > 0 || sec5.filledCount > 0) && isYes) issues.push('সেকশন ৫-এ প্রবাসী ০ — বিদেশী অর্থ "না" হতে হবে');
    }
    if (memberVal !== null && childrenVal !== null && childrenVal > memberVal) {
      issues.push(`শিশু সংখ্যা (${toBnDigits(childrenVal)}) মোট সদস্যের (${toBnDigits(memberVal)}) চেয়ে বেশি হতে পারবে না`);
    }
    if (cookingFuelVal && cookingFuelVal.includes('এলপিজি') && lpgVal && /^০\s*কেজি|^0\s*কেজি/i.test(lpgVal)) {
      issues.push('জ্বালানি এলপিজি হলে এলপিজির পরিমাণ ০ কেজি থেকে পরিবর্তন করুন');
    }

    const allValid = totalQuestions > 0 && missingFields.length === 0 && issues.length === 0;
    return {
      hasDom: totalQuestions > 0,
      panel,
      totalQuestions,
      filledCount,
      missingFields,
      issues,
      floorChecked,
      assetChecked,
      memberVal,
      childrenVal,
      roomsVal,
      remittanceVal,
      allValid
    };
  }

  function clickSection7CheckboxLabels(panel, targetLabels) {
    if (!panel || !Array.isArray(targetLabels) || !targetLabels.length) return 0;
    let toggled = 0;
    const normTargets = targetLabels.map(t => normalizeBn(t));
    const grids = Array.from(panel.querySelectorAll('.fc-pmt-multi-grid'));
    for (const g of grids) {
      const cbs = Array.from(g.querySelectorAll('input[type="checkbox"]'));
      for (const cb of cbs) {
        const cbLbl = normalizeBn(((cb.id && g.querySelector(`label[for="${cb.id}"]`)) || cb.closest('.v-input')?.querySelector('label'))?.textContent || '');
        if (!cbLbl || !normTargets.some(t => cbLbl.includes(t))) continue;
        const isChecked = Boolean(cb.checked || cb.getAttribute('aria-checked') === 'true' || cb.closest('.v-input--is-dirty'));
        if (!isChecked) {
          cb.click();
          toggled++;
        }
      }
    }
    return toggled;
  }

  function injectSection7Toolbar(panel, sec5Data) {
    if (!panel || !isPanelActiveVisible(panel)) return;
    const wrap = panel.querySelector('.v-expansion-panel-content__wrap') || panel;

    const totalMembers = (sec5Data && sec5Data.totalCount > 0) ? sec5Data.totalCount : 0;
    const abroadTotal = sec5Data
      ? ((sec5Data.abroadMale || 0) + (sec5Data.abroadFemale || 0) + (sec5Data.abroadTrans || 0))
      : 0;
    const remittanceText = abroadTotal > 0 ? 'হ্যা (প্রবাসী > ০)' : 'না (প্রবাসী ০)';
    const s7 = inspectSection7Eligibility(panel);

    let bar = wrap.querySelector('#fc-section7-toolbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fc-section7-toolbar';
      wrap.insertBefore(bar, wrap.firstChild || null);
    }

    const renderHash = `${totalMembers}|${abroadTotal}|${s7.filledCount}/${s7.totalQuestions}|${s7.issues.join(',')}|${s7.floorChecked.join(',')}|${s7.assetChecked.length}|${s7.roomsVal}`;
    if (bar.dataset.renderHash === renderHash) return;
    bar.dataset.renderHash = renderHash;

    const statusPill = s7.allValid
      ? `<span class="fc-s2-pill ok">✅ ${toBnDigits(s7.filledCount)}/${toBnDigits(s7.totalQuestions)} সম্পূর্ণ</span>`
      : `<span class="fc-s2-pill">${s7.issues.length ? '❌ অমিল আছে' : `⏳ ${toBnDigits(s7.filledCount)}/${toBnDigits(s7.totalQuestions)} পূরণ`}</span>`;

    const issueBanner = (s7.issues.length || s7.missingFields.length)
      ? `<div class="fc-s5-issues ${s7.issues.length ? 'err' : ''}">${s7.issues.length ? `❌ ${escapeHtml(s7.issues.join(' • '))}` : ''}${s7.issues.length && s7.missingFields.length ? ' | ' : ''}${s7.missingFields.length ? `⚠️ বাকি (${toBnDigits(s7.missingFields.length)}টি): ${escapeHtml(s7.missingFields.slice(0, 4).join(', '))}${s7.missingFields.length > 4 ? '…' : ''}` : ''}</div>`
      : '';

    bar.innerHTML = `
      <div class="fc-s7-head">
        <span>🏡 <b>স্টেপ ৭: যোগ্যতার অন্যান্য তথ্য ভ্যালিডেটর</b></span>
        ${statusPill}
      </div>
      <div class="fc-s7-grid">
        <div class="fc-s5-card">
          <div class="fc-s5-card-title">👨‍👩‍👧‍👦 সদস্য সিঙ্ক (সেকশন ৫)</div>
          <div class="fc-s5-card-val">${s7.memberVal !== null ? `${toBnDigits(s7.memberVal)} জন` : 'ফাঁকা'} ${totalMembers > 0 ? `(সেকশন ৫: ${toBnDigits(totalMembers)})` : ''}</div>
        </div>
        <div class="fc-s5-card">
          <div class="fc-s5-card-title">👶 শিশু ও কক্ষ সংখ্যা</div>
          <div class="fc-s5-card-val">শিশু: ${s7.childrenVal !== null ? toBnDigits(s7.childrenVal) : '-'} • কক্ষ: ${escapeHtml(s7.roomsVal || '-')}</div>
        </div>
        <div class="fc-s5-card">
          <div class="fc-s5-card-title">🏠 মেঝে ও পরিসম্পদ</div>
          <div class="fc-s5-card-val">মেঝে: ${s7.floorChecked.length ? escapeHtml(s7.floorChecked[0]) : 'নেই'} • সম্পদ: ${toBnDigits(s7.assetChecked.length)}টি</div>
        </div>
      </div>
      ${issueBanner}
      <div style="font-size:11px; color:#15803d; font-weight:600;">
        ✈️ বিদেশ হতে অর্থ: <b>${remittanceText}</b> • 💡 বাকি ফিল্ডগুলো দ্রুত পূরণ বা মেঝে/পরিসম্পদ টিক দিন:
      </div>
      <div class="fc-s2-actions">
        <button id="fc-s7-apply-btn" type="button" class="fc-s2-btn primary">⚡ স্মার্ট ডিফল্ট বসান</button>
        <button type="button" class="fc-s2-btn" data-s7-preset="floor-mud">🪵 মেঝে: মাটি</button>
        <button type="button" class="fc-s2-btn" data-s7-preset="assets-basic">📱 সাধারণ পরিসম্পদ</button>
        <button id="fc-s7-save-custom-btn" type="button" class="fc-s2-btn accent">💾 কাস্টম সেভ</button>
        <button id="fc-s7-reset-custom-btn" type="button" class="fc-s2-btn">🔄 রিসেট</button>
        <button id="fc-s7-validate-btn" type="button" class="fc-s2-btn">🔍 যাচাই</button>
      </div>
    `;

    bar.querySelector('#fc-s7-apply-btn').onclick = () => {
      const cols = Array.from(panel.querySelectorAll('.col, [class*="col-"]'));
      cols.forEach(c => {
        delete c.dataset.fcS7DefaultApplied;
        delete c.dataset.fcS7UserEdited;
      });
      isFillingSection7 = false;
      handleSection7Eligibility(true);
      showToast('⚡ সেকশন ৭-এর স্মার্ট ডিফল্ট মান পুনরায় প্রয়োগ করা হচ্ছে...');
    };

    bar.querySelector('[data-s7-preset="floor-mud"]')?.addEventListener('click', () => {
      const n = clickSection7CheckboxLabels(panel, ['মাটি']);
      bar.dataset.renderHash = '';
      injectSection7Toolbar(panel, sec5Data);
      updateSummaryBadge(true);
      showToast(n ? '✅ মেঝে হিসেবে "মাটি" টিক দেওয়া হয়েছে!' : 'ℹ️ মেঝে "মাটি" আগেই টিক দেওয়া আছে।');
    });

    bar.querySelector('[data-s7-preset="assets-basic"]')?.addEventListener('click', () => {
      const n = clickSection7CheckboxLabels(panel, ['মোবাইল ফোন', 'খাট', 'টিউবওয়েল', 'সোলার প্যানেল']);
      bar.dataset.renderHash = '';
      injectSection7Toolbar(panel, sec5Data);
      updateSummaryBadge(true);
      showToast(n ? `✅ ${toBnDigits(n)}টি সাধারণ পরিসম্পদ টিক দেওয়া হয়েছে!` : 'ℹ️ সাধারণ পরিসম্পদ আগেই টিক দেওয়া আছে।');
    });

    bar.querySelector('#fc-s7-save-custom-btn').onclick = () => {
      const rules = getSection7Rules(sec5Data);
      const cols = Array.from(panel.querySelectorAll('.col, [class*="col-"]')).filter(c => !c.closest('.fc-pmt-multi-grid'));
      const custom = safeJsonParse(localStorage.getItem('fc_section7_custom_defaults'), {});
      let savedCnt = 0;
      cols.forEach(col => {
        const lbl = normalizeBn(col.querySelector('label')?.textContent || '').replace(/[\*\s]+/g, ' ').trim();
        if (!lbl) return;
        const rule = rules.find(r => !r.isDynamic && r.match(lbl));
        if (rule) {
          const curVal = normalizeBn(col.querySelector('.v-select__selection')?.textContent || '');
          if (curVal) { custom[rule.key] = curVal; savedCnt++; }
        }
      });
      localStorage.setItem('fc_section7_custom_defaults', JSON.stringify(custom));
      showToast(`✅ ${toBnDigits(savedCnt)}টি কাস্টম ডিফল্ট মান সেভ হয়েছে!`);
    };

    bar.querySelector('#fc-s7-reset-custom-btn').onclick = () => {
      localStorage.removeItem('fc_section7_custom_defaults');
      const cols = Array.from(panel.querySelectorAll('.col, [class*="col-"]'));
      cols.forEach(c => {
        delete c.dataset.fcS7DefaultApplied;
        delete c.dataset.fcS7UserEdited;
      });
      isFillingSection7 = false;
      handleSection7Eligibility(true);
      showToast('🔄 ফ্যাক্টরি ডিফল্ট রিসেট ও পুনরায় প্রয়োগ করা হচ্ছে...');
    };

    bar.querySelector('#fc-s7-validate-btn').onclick = () => {
      bar.dataset.renderHash = '';
      const latest = inspectSection7Eligibility(panel);
      injectSection7Toolbar(panel, sec5Data);
      updateSummaryBadge(true);
      showToast(latest.allValid ? `✅ স্টেপ ৭ যাচাই সফল (${toBnDigits(latest.filledCount)}/${toBnDigits(latest.totalQuestions)})!` : `⚠️ ${(latest.issues[0] || `বাকি: ${latest.missingFields[0] || 'ফিল্ড যাচাই করুন'}`)}`);
    };
  }

  async function handleSection7Eligibility(forceAll = false) {
    const panel = document.querySelector('[data-family-card-tab="5"]') ||
                  Array.from(document.querySelectorAll('.v-expansion-panel')).find(p => normalizeBn(p.textContent).includes('যোগ্যতার অন্যান্য তথ্য'));
    if (!panel || !isPanelActiveVisible(panel)) return;

    const sec5Data = trackSection5Data();
    injectSection7Toolbar(panel, sec5Data);

    if (isFillingSection7) {
      if (forceAll && activeSec7Promise) {
        try { await activeSec7Promise; } catch (_) {}
        return handleSection7Eligibility(forceAll);
      }
      return;
    }
    if (!forceAll && Date.now() - lastSec7FillTs < 400) return;

    const rules = getSection7Rules(sec5Data);
    const cols = Array.from(panel.querySelectorAll('.col, [class*="col-"]')).filter(col => !col.closest('.fc-pmt-multi-grid'));
    const queue = [];

    let curCookingFuel = '';
    for (const c of cols) {
      const l = normalizeBn(c.querySelector('label')?.textContent || '').replace(/[\*\s]+/g, ' ').trim();
      if (l.includes('রান্নার জ্বালানির প্রধান উপকরণ কি') && !l.includes('এলপিজি')) {
        curCookingFuel = normalizeBn(c.querySelector('.v-select__selection')?.textContent || '');
        break;
      }
    }

    for (const col of cols) {
      const labelEl = col.querySelector('label');
      if (!labelEl) continue;
      const lbl = normalizeBn(labelEl.textContent).replace(/[\*\s]+/g, ' ').trim();

      const rule = rules.find(r => r.match(lbl));
      if (!rule || !rule.candidates || rule.candidates.length === 0) continue;
      if (rule.key === 'lpg_usage' && curCookingFuel && curCookingFuel.includes('এলপিজি')) continue;

      if (!col.__fcS7ListenerAttached) {
        col.__fcS7ListenerAttached = true;
        col.addEventListener('mousedown', (e) => {
          if (e.isTrusted) {
            col.dataset.fcS7DefaultApplied = 'true';
            col.dataset.fcS7UserEdited = 'true';
          }
        }, true);
        col.addEventListener('click', () => {
          setTimeout(() => {
            const bar = panel.querySelector('#fc-section7-toolbar');
            if (bar) bar.dataset.renderHash = '';
            injectSection7Toolbar(panel, trackSection5Data());
            updateSummaryBadge(true);
          }, 120);
        });
      }

      const curSelVal = normalizeBn(col.querySelector('.v-select__selection')?.textContent || '');
      const curPlainVal = !col.querySelector('.v-select') ? normalizeBn(col.querySelector('input:not([type="hidden"])')?.value || '') : '';
      const curVal = curSelVal || curPlainVal;
      const alreadyMatches = curVal && rule.candidates.some(c => normalizeBn(curVal) === normalizeBn(c) || normOptionText(curVal) === normOptionText(c));

      if (forceAll) {
        if (!alreadyMatches) {
          queue.push({ col, candidates: rule.candidates, rule });
        } else {
          col.dataset.fcS7DefaultApplied = 'true';
          if (rule.isDynamic) col.dataset.fcS7LastDynamicVal = rule.dynamicVal;
        }
        continue;
      }

      if (col.dataset.fcS7UserEdited === 'true') continue;

      if (rule.isDynamic) {
        const dynamicChanged = col.dataset.fcS7LastDynamicVal !== rule.dynamicVal;
        if ((!curVal || dynamicChanged) && !alreadyMatches) {
          queue.push({ col, candidates: rule.candidates, rule });
        } else if (alreadyMatches) {
          col.dataset.fcS7DefaultApplied = 'true';
          col.dataset.fcS7LastDynamicVal = rule.dynamicVal;
        }
      } else {
        if (!curVal && col.dataset.fcS7DefaultApplied !== 'true') {
          queue.push({ col, candidates: rule.candidates, rule });
        } else if (curVal) {
          col.dataset.fcS7DefaultApplied = 'true';
        }
      }
    }

    if (queue.length === 0) return;

    isFillingSection7 = true;
    const runSec7 = (async () => {
      try {
        for (const item of queue) {
          await selectSingleVuetifyOption(item.col, item.candidates);
          if (item.rule.isDynamic) {
            item.col.dataset.fcS7LastDynamicVal = item.rule.dynamicVal;
          }
        }
        injectSection7Toolbar(panel, sec5Data);
        updateSummaryBadge(true);
        showToast(`✅ সেকশন ৭-এর ${toBnDigits(queue.length)}টি ফিল্ড ডিফল্ট অনুযায়ী অটো-সিলেক্ট সম্পন্ন!`);
      } catch (err) {
        console.warn('[FamilyCard] Section 7 auto-fill notice:', err);
      } finally {
        lastSec7FillTs = Date.now();
        isFillingSection7 = false;
        if (activeSec7Promise === runSec7) activeSec7Promise = null;
      }
    })();
    activeSec7Promise = runSec7;
    await runSec7;
  }

  // --- SECTION 9: MONEY USAGE & 2500 TK DEMAND DISTRIBUTION (অর্থ ব্যবহার - Tab 10) ---
  // Rules:
  // 1. Total allowance ceiling: 2500 Tk strictly.
  // 2. Default benchmark model (User-specified):
  //    - খাদ্য ও পরিবারের ভরণপোষণ: 500
  //    - চিকিৎসা (নিজের বা পরিবারের সদস্যদের): 500
  //    - সন্তানের শিক্ষা: 300
  //    - বাসস্থান নির্মান/মেরামত: 0
  //    - পোশাক/বস্ত্র/কাপড় ক্রয়: 200
  //    - আয়বর্ধক কর্মসূচি (ক্ষুদ্র ব্যবসা+ হাঁস-মুরগি/গবাদি পশু পালন + সবজি বাগান + কৃষি উপকরণ ক্রয় ইত্যাদি): 1000
  //    - সঞ্চয়: 0
  //    - ঋণ পরিশোধ: 0
  //    - অন্যান্য (উল্লেখ করুন): 0
  // 3. AI Dynamic Demand Analysis: Automatically reads previous family signals (members count, children count, agriculture labor, elderly/disabled) and adjusts distribution smartly while maintaining sum = 2500.
  // 4. Live interactive toolbar with presets, real-time balance counter, and localStorage custom memory.
  // 5. User manual entries protected; syncs to Firebase Firestore.

  let isFillingSection9 = false;
  let lastSec9FillTs = 0;
  let lastMoneySyncHash = '';

  const BENCHMARK_MONEY_DISTRIBUTION = {
    food: 500,
    health: 500,
    education: 300,
    housing: 0,
    clothing: 200,
    income: 1000,
    savings: 0,
    debt: 0,
    other: 0
  };

  function getSection9MoneyElements() {
    const panel = document.querySelector('[data-family-card-tab="10"]') ||
                  Array.from(document.querySelectorAll('.v-expansion-panel')).find(p => {
                    const h3 = p.querySelector('h3, .v-expansion-panel-header');
                    return h3 && (h3.textContent.includes('অর্থ ব্যবহার') || h3.textContent.includes('মোট পরিমাণ ২৫০০'));
                  }) ||
                  (document.querySelector('.family-card-form-step--active')?.textContent.includes('অর্থ ব্যবহার') ? document.querySelector('.v-expansion-panel--active, form') : null);
    if (!panel) return null;

    const fields = {
      food: null,
      health: null,
      education: null,
      housing: null,
      clothing: null,
      income: null,
      savings: null,
      debt: null,
      other: null
    };

    const labelNodes = Array.from(panel.querySelectorAll('.text-body-2.font-weight-medium, .font-weight-medium, label'));
    for (const textDiv of labelNodes) {
      const r = textDiv.closest('.row');
      if (!r) continue;
      const txt = normalizeBn(textDiv.textContent || '');
      const inp = r.querySelector('input[type="number"], input:not([type="hidden"])');
      if (!inp) continue;

      if (!fields.food && (txt.includes('খাদ্য') || txt.includes('ভরণপোষণ'))) fields.food = inp;
      else if (!fields.health && txt.includes('চিকিৎসা')) fields.health = inp;
      else if (!fields.education && txt.includes('শিক্ষা')) fields.education = inp;
      else if (!fields.housing && (txt.includes('বাসস্থান') || txt.includes('মেরামত'))) fields.housing = inp;
      else if (!fields.clothing && (txt.includes('পোশাক') || txt.includes('বস্ত্র') || txt.includes('কাপড়'))) fields.clothing = inp;
      else if (!fields.income && txt.includes('আয়বর্ধক')) fields.income = inp;
      else if (!fields.savings && txt.includes('সঞ্চয়')) fields.savings = inp;
      else if (!fields.debt && txt.includes('ঋণ')) fields.debt = inp;
      else if (!fields.other && txt.includes('অন্যান্য')) fields.other = inp;
    }

    const count = Object.values(fields).filter(Boolean).length;
    if (count < 5) return null;
    return { panel, fields };
  }

  function scrapeFamilyConditionsForAI() {
    let totalMembers = 7;
    let childrenCount = 0;
    let explicitChildrenCount = false;
    let hasDisabledOrElderly = false;
    let isAgriLabor = true;
    let hasRemittance = false;

    // Check Section 5 tracked data
    const sec5 = trackSection5Data();
    if (sec5 && sec5.totalCount > 0) {
      totalMembers = sec5.totalCount;
      if ((sec5.abroadMale || 0) + (sec5.abroadFemale || 0) + (sec5.abroadTrans || 0) > 0) {
        hasRemittance = true;
      }
    }

    // Check Section 7 fields
    const s7Panel = document.querySelector('[data-family-card-tab="5"]');
    if (s7Panel) {
      const s7Labels = Array.from(s7Panel.querySelectorAll('label'));
      const childLbl = s7Labels.find(l => l.textContent.includes('শিশু সংখ্যা'));
      if (childLbl) {
        const selVal = childLbl.closest('.col, [class*="col-"]')?.querySelector('.v-select__selection')?.textContent.trim();
        if (selVal) {
          const num = parseInt(normalizeDigits(selVal).replace(/[^0-9]/g, ''), 10);
          if (!isNaN(num)) {
            childrenCount = num;
            explicitChildrenCount = true;
          }
        }
      }

      const memLbl = s7Labels.find(l => l.textContent.includes('সদস্য সংখ্যা') && !l.textContent.includes('শিশু'));
      if (memLbl) {
        const col = memLbl.closest('.col, [class*="col-"]');
        const selVal = col?.querySelector('.v-select__selection')?.textContent.trim() || col?.querySelector('input:not([type="hidden"])')?.value.trim();
        if (selVal) {
          const num = parseInt(normalizeDigits(selVal).replace(/[^0-9]/g, ''), 10);
          if (!isNaN(num) && num > 0) totalMembers = num;
        }
      }

      const laborLbl = s7Labels.find(l => normalizeBn(l.textContent).includes('শ্রমিক হিসেবে নিয়োজিত'));
      if (laborLbl) {
        const selVal = normalizeBn(laborLbl.closest('.col, [class*="col-"]')?.querySelector('.v-select__selection')?.textContent || '');
        if (selVal && !selVal.includes('কৃষি')) isAgriLabor = false;
      }
    }

    // Track Section 8 (পারিবারিক তথ্য - live DOM or cached per family ID) for students, disability & elderly
    const sec8 = trackSection8Data();
    const hasSec8Data = Boolean(sec8 && (sec8.hasSec8Data || sec8.memberCount > 0));
    const studentCount = hasSec8Data ? (sec8.studentCount || 0) : 0;
    const hasStudents = hasSec8Data ? studentCount > 0 : false;
    if (hasSec8Data) {
      if ((sec8.disabledCount || 0) > 0 || (sec8.elderlyCount || 0) > 0) {
        hasDisabledOrElderly = true;
      }
      if (!explicitChildrenCount && sec8.childCount > 0) {
        childrenCount = sec8.childCount;
      }
      if ((!sec5 || !sec5.totalCount) && sec8.memberCount > 0) {
        totalMembers = sec8.memberCount;
      }
    }

    return {
      totalMembers,
      childrenCount,
      studentCount,
      hasStudents,
      hasSec8Data,
      hasDisabledOrElderly,
      isAgriLabor,
      hasRemittance
    };
  }

  function computeAIDemandDistribution(conditions = {}) {
    const totalMembers = conditions.totalMembers || 7;
    const hasStudents = conditions.hasStudents !== undefined
      ? Boolean(conditions.hasStudents)
      : ((conditions.studentCount || 0) > 0);
    const studentCount = conditions.studentCount !== undefined
      ? conditions.studentCount
      : (hasStudents ? 1 : 0);
    const hasDisabledOrElderly = !!conditions.hasDisabledOrElderly;

    // Baseline with students: খাদ্য 500, চিকিৎসা 500, শিক্ষা 300, বাসস্থান 0, পোশাক 200, আয়বর্ধক 1000 = 2500
    // Baseline without students: "সন্তানের শিক্ষা" = 0, redistributed -> খাদ্য 600 (+100), আয়বর্ধক 1200 (+200) = 2500
    let dist = {
      food: hasStudents ? 500 : 600,
      health: 500,
      education: hasStudents ? 300 : 0,
      housing: 0,
      clothing: 200,
      income: hasStudents ? 1000 : 1200,
      savings: 0,
      debt: 0,
      other: 0
    };

    if (hasStudents && studentCount >= 3) {
      dist.education = 400;
      dist.clothing = 250;
      dist.income = 850;
    }

    if (hasDisabledOrElderly) {
      dist.health += 200;
      dist.income = Math.max(400, dist.income - 200);
    }

    if (totalMembers >= 8 && dist.food < 700) {
      dist.food += 100;
      dist.income = Math.max(400, dist.income - 100);
    }

    // Exact 2500 constraint guarantee
    const curSum = Object.values(dist).reduce((a, b) => a + b, 0);
    const diff = 2500 - curSum;
    if (diff !== 0) {
      dist.income = Math.max(0, dist.income + diff);
    }

    return dist;
  }

  function readCurrentMoneyDistribution(fields) {
    const values = {};
    for (const [key, inp] of Object.entries(fields)) {
      if (!inp) { values[key] = 0; continue; }
      const val = parseInt(normalizeDigits(inp.value || '').replace(/[^0-9]/g, ''), 10);
      values[key] = isNaN(val) ? 0 : val;
    }
    values.total = Object.values(values).reduce((a, b) => a + b, 0);
    return values;
  }

  function updateSection9HUD(fields) {
    const toolbar = document.getElementById('fc-s9-money-toolbar');
    if (!toolbar || !fields) return;

    const current = readCurrentMoneyDistribution(fields);
    const totalEl = toolbar.querySelector('#fc-money-total-val');
    const badgeEl = toolbar.querySelector('#fc-money-live-badge');
    const progressEl = toolbar.querySelector('#fc-money-progress-bar');

    if (totalEl) totalEl.textContent = toBnDigits(current.total);

    const pct = Math.min(100, Math.round((current.total / 2500) * 100));
    if (progressEl) {
      progressEl.style.width = `${pct}%`;
      progressEl.style.background = current.total === 2500 ? '#10b981' : (current.total > 2500 ? '#ef4444' : '#f59e0b');
    }

    const sec8InfoEl = toolbar.querySelector('#fc-s9-sec8-info');
    if (sec8InfoEl) {
      const cond = scrapeFamilyConditionsForAI();
      if (cond.hasStudents) {
        sec8InfoEl.textContent = `🎓 সেকশন ৮ ট্র্যাক: ${toBnDigits(cond.studentCount)} জন শিক্ষার্থী → "সন্তানের শিক্ষা": ${toBnDigits(current.education)} টাকা`;
        sec8InfoEl.style.color = '#15803d';
      } else {
        sec8InfoEl.textContent = cond.hasSec8Data
          ? `🎓 সেকশন ৮ ট্র্যাক: কোনো শিক্ষার্থী নেই → "সন্তানের শিক্ষা": ০ টাকা (খাদ্য ও আয়বর্ধকে পুনর্বণ্টিত)`
          : `🎓 সেকশন ৮ ট্র্যাক: শিক্ষার্থী শনাক্ত হয়নি → "সন্তানের শিক্ষা": ০ টাকা`;
        sec8InfoEl.style.color = '#b45309';
      }
    }

    if (badgeEl) {
      if (current.total === 2500) {
        badgeEl.textContent = '✅ ১০০% নির্ভুল বরাদ্দ (২৫০০ টাকা)';
        badgeEl.style.background = '#dcfce7';
        badgeEl.style.color = '#166534';
        badgeEl.style.border = '1px solid #86efac';
      } else if (current.total < 2500) {
        const rem = 2500 - current.total;
        badgeEl.textContent = `⏳ বাকি আছে: ${toBnDigits(rem)} টাকা`;
        badgeEl.style.background = '#fffbeb';
        badgeEl.style.color = '#92400e';
        badgeEl.style.border = '1px solid #fde68a';
      } else {
        const excess = current.total - 2500;
        badgeEl.textContent = `❌ অতিরিক্ত: ${toBnDigits(excess)} টাকা (সীমা অতিক্রম)`;
        badgeEl.style.background = '#fef2f2';
        badgeEl.style.color = '#991b1b';
        badgeEl.style.border = '1px solid #fecaca';
      }
    }
  }

  function applyMoneyDistribution(fields, dist, isUserAction = false) {
    if (!fields || !dist) return;
    for (const [key, val] of Object.entries(dist)) {
      if (key === 'total') continue;
      const inp = fields[key];
      if (inp) {
        if (!isUserAction && inp.dataset.fcMoneyUserEdited === 'true') continue;
        setReactiveValue(inp, String(val));
        inp.dataset.fcMoneyAutoFilled = 'true';
      }
    }
    updateSection9HUD(fields);
    const syncedDist = readCurrentMoneyDistribution(fields);
    syncMoneyDistributionToFirestore(syncedDist);
    if (isUserAction) {
      showToast('✅ অর্থ বরাদ্দ ২৫০০ টাকা সফলভাবে পূরণ করা হয়েছে!');
    }
  }

  async function syncMoneyDistributionToFirestore(dist) {
    try {
      const cleanId = getSafeFamilyDocId(lastExtractedData);
      if (!cleanId) return;

      const fields = {
        money_food: { integerValue: String(dist.food || 0) },
        money_health: { integerValue: String(dist.health || 0) },
        money_education: { integerValue: String(dist.education || 0) },
        money_housing: { integerValue: String(dist.housing || 0) },
        money_clothing: { integerValue: String(dist.clothing || 0) },
        money_income: { integerValue: String(dist.income || 0) },
        money_savings: { integerValue: String(dist.savings || 0) },
        money_debt: { integerValue: String(dist.debt || 0) },
        money_other: { integerValue: String(dist.other || 0) },
        money_total: { integerValue: String(dist.total || 2500) },
        money_distribution_synced_at: { timestampValue: new Date().toISOString() }
      };

      const updateMask = [
        'updateMask.fieldPaths=money_food',
        'updateMask.fieldPaths=money_health',
        'updateMask.fieldPaths=money_education',
        'updateMask.fieldPaths=money_housing',
        'updateMask.fieldPaths=money_clothing',
        'updateMask.fieldPaths=money_income',
        'updateMask.fieldPaths=money_savings',
        'updateMask.fieldPaths=money_debt',
        'updateMask.fieldPaths=money_other',
        'updateMask.fieldPaths=money_total',
        'updateMask.fieldPaths=money_distribution_synced_at'
      ];

      const hash = JSON.stringify(dist);
      if (hash === lastMoneySyncHash) return;
      lastMoneySyncHash = hash;

      const url = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(cleanId)}?${updateMask.join('&')}`;

      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
      console.log('[FamilyCard] Money distribution synced to Firestore:', cleanId);
    } catch (err) {
      console.warn('[FamilyCard] Firestore money sync notice:', err.message);
    }
  }

  function injectSection9Toolbar(panel, fields) {
    if (!panel || document.getElementById('fc-s9-money-toolbar')) return;

    const wrap = panel.querySelector('.v-expansion-panel-content__wrap') || panel;
    const toolbar = document.createElement('div');
    toolbar.id = 'fc-s9-money-toolbar';
    toolbar.style.cssText = `
      background: linear-gradient(135deg, #f0fdfa, #f8fafc);
      border: 1.5px solid #0d9488;
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 14px;
      font-family: -apple-system, sans-serif;
      box-shadow: 0 2px 8px rgba(13, 148, 136, 0.08);
    `;

    toolbar.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 16px;">💰</span>
          <span style="font-weight: 800; color: #0f766e; font-size: 13.5px;">অর্থ ব্যবহার ও ২৫০০ টাকা এআই চাহিদাভিত্তিক বণ্টন</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span id="fc-money-live-badge" style="font-size: 11.5px; font-weight: 800; padding: 3px 10px; border-radius: 6px; background: #dcfce7; color: #166534; border: 1px solid #86efac;">
            ✅ ১০০% নির্ভুল বরাদ্দ (২৫০০ টাকা)
          </span>
        </div>
      </div>

      <div style="background: rgba(255,255,255,0.7); border: 1px solid #ccfbf1; border-radius: 8px; padding: 6px 10px; margin-bottom: 10px; font-size: 11.5px; color: #334155;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <span>মোট বরাদ্দ: <b id="fc-money-total-val" style="color: #0f766e; font-size: 13px;">২৫০০</b> / ২৫০০ টাকা</span>
          <span style="color: #64748b; font-size: 10.5px;">(সর্বোচ্চ সীমা: ২৫০০ টাকা)</span>
        </div>
        <div id="fc-s9-sec8-info" style="font-size: 11px; font-weight: 700; color: #0f766e; margin-bottom: 4px;">🎓 সেকশন ৮ শিক্ষার্থী যাচাই হচ্ছে...</div>
        <div style="width: 100%; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden;">
          <div id="fc-money-progress-bar" style="width: 100%; height: 100%; background: #10b981; transition: width 0.3s ease, background 0.3s ease;"></div>
        </div>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 6px;">
        <button type="button" id="fc-s9-btn-ai" style="background: linear-gradient(135deg, #0d9488, #0f766e); color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          🤖 এআই চাহিদা বিশ্লেষণ (২৫০০ টাকা)
        </button>
        <button type="button" id="fc-s9-btn-benchmark" style="background: #0284c7; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
          🌾 আদর্শ কৃষি মডেল (ডিফল্ট)
        </button>
        <button type="button" id="fc-s9-btn-edu" style="background: #4f46e5; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
          🎓 শিক্ষা ও শিশু অগ্রাধিকার
        </button>
        <button type="button" id="fc-s9-btn-health" style="background: #e11d48; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
          🏥 স্বাস্থ্য ও চিকিৎসা
        </button>
        <button type="button" id="fc-s9-btn-income" style="background: #ca8a04; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
          💼 সর্বোচ্চ আয়বর্ধক (১৩০০ টাকা)
        </button>
        <button type="button" id="fc-s9-btn-balance" style="background: #475569; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
          ⚖️ ২৫০০ টাকায় ব্যালেন্স করুন
        </button>
        <button type="button" id="fc-s9-btn-save-def" style="background: #166534; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-weight: 700; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
          💾 বর্তমান বণ্টন ডিফল্ট সেভ করুন
        </button>
      </div>
    `;

    wrap.insertBefore(toolbar, wrap.firstChild);

    // Event handlers
    toolbar.querySelector('#fc-s9-btn-ai')?.addEventListener('click', () => {
      const cond = scrapeFamilyConditionsForAI();
      const dist = computeAIDemandDistribution(cond);
      applyMoneyDistribution(fields, dist, true);
    });

    toolbar.querySelector('#fc-s9-btn-benchmark')?.addEventListener('click', () => {
      const cond = scrapeFamilyConditionsForAI();
      const base = cond.hasStudents
        ? { ...BENCHMARK_MONEY_DISTRIBUTION }
        : { ...BENCHMARK_MONEY_DISTRIBUTION, food: 600, education: 0, income: 1200 };
      applyMoneyDistribution(fields, base, true);
    });

    toolbar.querySelector('#fc-s9-btn-edu')?.addEventListener('click', () => {
      applyMoneyDistribution(fields, {
        food: 600, health: 400, education: 500, housing: 0, clothing: 300, income: 700, savings: 0, debt: 0, other: 0
      }, true);
    });

    toolbar.querySelector('#fc-s9-btn-health')?.addEventListener('click', () => {
      applyMoneyDistribution(fields, {
        food: 500, health: 800, education: 300, housing: 0, clothing: 200, income: 700, savings: 0, debt: 0, other: 0
      }, true);
    });

    toolbar.querySelector('#fc-s9-btn-income')?.addEventListener('click', () => {
      applyMoneyDistribution(fields, {
        food: 500, health: 300, education: 200, housing: 0, clothing: 200, income: 1300, savings: 0, debt: 0, other: 0
      }, true);
    });

    toolbar.querySelector('#fc-s9-btn-balance')?.addEventListener('click', () => {
      const current = readCurrentMoneyDistribution(fields);
      const diff = 2500 - current.total;
      if (diff === 0) {
        showToast('✅ মোট বরাদ্দ ইতোমধ্যেই সঠিক ২৫০০ টাকা রয়েছে!');
        return;
      }
      current.income = Math.max(0, current.income + diff);
      delete current.total;
      applyMoneyDistribution(fields, current, true);
      showToast(`⚖️ আয়বর্ধক কর্মসূচিতে সমন্বয় করে মোট ২৫০০ টাকা নিশ্চিত করা হয়েছে!`);
    });

    toolbar.querySelector('#fc-s9-btn-save-def')?.addEventListener('click', () => {
      const current = readCurrentMoneyDistribution(fields);
      if (current.total !== 2500) {
        alert(`মোট বরাদ্দ অবশ্যই ঠিক ২৫০০ টাকা হতে হবে (বর্তমান: ${current.total} টাকা)। "⚖️ ২৫০০ টাকায় ব্যালেন্স করুন" বাটনে চাপুন।`);
        return;
      }
      localStorage.setItem('fc_custom_money_dist', JSON.stringify(current));
      showToast('💾 এই ২৫০০ টাকা বণ্টনটি ভবিষ্যৎ সকল ফ্যামিলি কার্ডের জন্য ডিফল্ট সেভ করা হয়েছে!');
    });

    // Attach listeners to fields for live typing HUD update (debounced Firestore sync)
    let moneySyncTimer = null;
    for (const inp of Object.values(fields)) {
      if (!inp || inp.__fcMoneyListenerAttached) continue;
      inp.__fcMoneyListenerAttached = true;
      inp.addEventListener('input', (e) => {
        if (e.isTrusted) inp.dataset.fcMoneyUserEdited = 'true';
        updateSection9HUD(fields);
        clearTimeout(moneySyncTimer);
        moneySyncTimer = setTimeout(() => {
          const cur = readCurrentMoneyDistribution(fields);
          if (cur.total === 2500) {
            syncMoneyDistributionToFirestore(cur);
          }
        }, 700);
      });
      inp.addEventListener('change', () => {
        updateSection9HUD(fields);
      });
    }
  }

  function handleSection9MoneyUsage(forceAll = false) {
    const tab10 = document.querySelector('[data-family-card-tab="10"]');
    if (!forceAll && tab10 && !isPanelActiveVisible(tab10)) return;
    const elData = getSection9MoneyElements();
    if (!elData) return;

    const { panel, fields } = elData;
    if (!forceAll && !isPanelActiveVisible(panel)) return;
    injectSection9Toolbar(panel, fields);

    updateSection9HUD(fields);

    if (isFillingSection9) return;

    // Check if any field is empty or all zero
    const current = readCurrentMoneyDistribution(fields);
    const hasAnyInput = Object.entries(current).some(([k, v]) => k !== 'total' && v > 0);
    const isUserEdited = Object.values(fields).some(inp => inp && inp.dataset.fcMoneyUserEdited === 'true');
    const cond = scrapeFamilyConditionsForAI();
    const customDist = safeJsonParse(localStorage.getItem('fc_custom_money_dist'), null);
    const aiSig = `${cond.hasStudents}|${cond.studentCount}|${cond.hasDisabledOrElderly}|${cond.totalMembers}|${cond.hasSec8Data}`;
    const shouldRecomputeFromSec8 = Boolean(!customDist && !isUserEdited && panel.dataset.fcS9AutoSig !== aiSig);
    if (!forceAll && !shouldRecomputeFromSec8 && (Date.now() - lastSec9FillTs < 300)) return;

    if (forceAll || (!hasAnyInput && !isUserEdited) || shouldRecomputeFromSec8) {
      isFillingSection9 = true;
      try {
        const targetDist = (customDist && typeof customDist === 'object')
          ? customDist
          : computeAIDemandDistribution(cond);
        applyMoneyDistribution(fields, targetDist, forceAll);
        if (!customDist) panel.dataset.fcS9AutoSig = aiSig;
      } catch (err) {
        console.warn('[FamilyCard] Section 9 auto-fill notice:', err);
      } finally {
        lastSec9FillTs = Date.now();
        isFillingSection9 = false;
      }
    }
  }


  // --- FAMILY CARD FULL SUMMARY & PRE-SUBMIT VALIDATOR ---
  function readColVal(col) {
    if (!col) return '';
    const sel = col.querySelector('.v-select__selection');
    if (sel && sel.textContent.trim()) return sel.textContent.trim();
    const inp = Array.from(col.querySelectorAll('input, textarea')).find(isFillableTextInput);
    return inp ? String(inp.value || '').trim() : '';
  }

  function findLabelVal(scope, keys) {
    if (!scope) return '';
    const normKeys = keys.map(k => normalizeBn(k));
    const labels = Array.from(scope.querySelectorAll('label'));
    for (const l of labels) {
      if (l.closest('.v-radio, .v-checkbox, .v-input--selection-controls, [role="radiogroup"]')) continue;
      const t = normalizeBn(l.textContent || '');
      if (normKeys.some(k => t.includes(k))) {
        if (l.htmlFor) {
          const inp = document.getElementById(l.htmlFor);
          if (isFillableTextInput(inp) && String(inp.value || '').trim()) return String(inp.value || '').trim();
        }
        let cur = l.parentElement;
        for (let d = 0; cur && cur !== scope && d < 5; d++, cur = cur.parentElement) {
          const v = readColVal(cur);
          if (v) return v;
          if (cur.matches('.col, [class*="col-"]')) break;
        }
      }
    }
    return '';
  }

  const TAB_STEP_TITLE_MAP = {
    '0': ['যাচাইকরণ'],
    '1': ['ব্যক্তিগত তথ্য'],
    '9': ['ছবি ও সনাক্তকরণ', 'ছবি ও ডকুমেন্ট', 'ছবি'],
    '2': ['যোগাযোগের তথ্য', 'যোগাযোগ'],
    '3': ['প্রোগ্রাম অনুযায়ী তথ্য', 'ফ্যামিলি কার্ড অনুযায়ী', 'প্রোগ্রাম'],
    '4': ['ব্যাংক/এমএফএস', 'ব্যাংক'],
    '8': ['নমিনী তথ্য', 'নমিনী'],
    '5': ['যোগ্যতার অন্যান্য তথ্য', 'যোগ্যতা'],
    '6': ['পারিবারিক তথ্য', 'ফ্যামিলি সদস্য', 'পরিবার'],
    '10': ['অর্থ ব্যবহার', 'ভাতা'],
    '7': ['এন্ট্রি ব্যবহারকারীর তথ্য', 'ব্যবহারকারী'],
    '11': ['সম্মতি ও ঘোষণা', 'ঘোষণা', 'সম্মতি']
  };
  const TAB_STEP_FALLBACK_IDX = { '0': 0, '1': 1, '9': 2, '2': 3, '3': 4, '4': 5, '8': 6, '5': 7, '6': 8, '10': 9, '7': 10, '11': 11 };

  function jumpToPortalSection(tabAttr) {
    const sModal = document.getElementById('fc-summary-modal');
    if (sModal) sModal.style.display = 'none';
    const tabKey = String(tabAttr);
    const target = document.querySelector(`[data-family-card-tab="${tabKey}"]`);
    if (!target) {
      showToast(`⚠️ সেকশন (ট্যাব ${tabKey}) বর্তমান পেজে খুঁজে পাওয়া যায়নি।`);
      return;
    }
    if (target.classList.contains('v-expansion-panel') && !target.classList.contains('v-expansion-panel--active')) {
      target.querySelector('.v-expansion-panel-header, button')?.click();
    }
    if (target.style.display === 'none') {
      const steps = Array.from(document.querySelectorAll('.family-card-form-step, .v-tabs .v-tab'));
      const keywords = (TAB_STEP_TITLE_MAP[tabKey] || []).map(normalizeBn);
      const matched = steps.find(el => el.dataset?.familyCardTab === tabKey)
        || steps.find(el => {
          const txt = normalizeBn(el.textContent || '');
          return keywords.some(k => txt.includes(k));
        })
        || steps[TAB_STEP_FALLBACK_IDX[tabKey] ?? parseInt(tabKey, 10)];
      if (matched) matched.click();
    }
    setTimeout(() => {
      const updated = document.querySelector(`[data-family-card-tab="${tabKey}"]`) || target;
      updated.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 220);
  }

  function scrapeMemberCardSummary(card, idx) {
    const isSelf = card.classList.contains('fm-member-card--self') || (card.textContent.includes('সদস্য - ১') && card.textContent.includes('নিজ'));
    const title = card.querySelector('.fm-member-title')?.textContent.trim() || `সদস্য - ${toBnDigits(idx + 1)}`;
    const nameBn = findLabelVal(card, ['নাম (বাংলা)', 'নাম']) || (isSelf ? (lastExtractedData?.name_bn || '') : '');
    const nidRaw = findLabelVal(card, ['জাতীয় পরিচিতি', 'NID নম্বর', 'NID']);
    const brcRaw = findLabelVal(card, ['জন্ম নিবন্ধন']);
    const dob = standardizeDate(findLabelVal(card, ['জন্ম তারিখ']) || (isSelf ? (lastExtractedData?.dob || '') : ''));
    const rel = isSelf ? 'নিজ' : (findLabelVal(card, ['সম্পর্ক']) || '');
    const gender = findLabelVal(card, ['লিঙ্গ']) || (isSelf ? (lastExtractedData?.gender || '') : '');

    const cleanNid = normalizeDigits(nidRaw).replace(/[^0-9]/g, '');
    const cleanBrc = normalizeDigits(brcRaw).replace(/[^0-9]/g, '');
    const docNum = cleanNid || cleanBrc || '';
    const docType = cleanBrc && !cleanNid ? 'birth_certificate' : (cleanNid ? 'nid' : (docNum.length === 17 ? 'birth_certificate' : 'unknown'));

    let age = null;
    const ym = normalizeDigits(dob).match(/\b(19\d{2}|20\d{2})\b/);
    if (ym) age = new Date().getFullYear() - parseInt(ym[1], 10);

    const issues = [];
    if (!nameBn && !isSelf) issues.push('নাম ফাঁকা');
    if (docNum) {
      if (docType === 'birth_certificate' && docNum.length !== 17) {
        issues.push(`BRC ${toBnDigits(docNum.length)} সংখ্যা (১৭ প্রয়োজন)`);
      } else if (docType === 'nid' && docNum.length !== 10 && docNum.length !== 17) {
        issues.push(`NID ${toBnDigits(docNum.length)} সংখ্যা (১০/১৭ প্রয়োজন)`);
      }
    } else if (!isSelf) {
      issues.push('NID/BRC নম্বর নেই');
    }

    return { index: idx + 1, isSelf, title, nameBn, docNum, docType, dob, age, rel, gender, issues };
  }

  function collectFullFamilyCardSummary() {
    const familyId = scrapeFamilyId() || lastExtractedData?.family_id || '';
    const tab0 = document.querySelector('[data-family-card-tab="0"]');
    const tab1 = document.querySelector('[data-family-card-tab="1"]');
    const tab2 = document.querySelector('[data-family-card-tab="2"]');
    const tab9 = document.querySelector('[data-family-card-tab="9"]');

    const entries0 = tab0 ? collectTabFieldEntries(tab0) : [];
    const entries1 = tab1 ? collectTabFieldEntries(tab1) : [];
    const entries2 = tab2 ? collectTabFieldEntries(tab2) : [];
    const matchedLast = (lastExtractedData && (!familyId || !lastExtractedData.family_id || lastExtractedData.family_id === familyId))
      ? lastExtractedData
      : getCachedFamilyScan(familyId, false);

    const applicant = {
      nameBn: findEntryByKeywords(entries0, ['নাম (বাংলা)'])?.value || findEntryByKeywords(entries1, ['নাম (বাংলা)'])?.value || matchedLast?.name_bn || '',
      nameEn: findEntryByKeywords(entries0, ['নাম (ইংরেজি)'])?.value || findEntryByKeywords(entries1, ['নাম (ইংরেজি)'])?.value || matchedLast?.name_en || '',
      nid: normalizeDigits(
        findEntryByKeywords(entries0, ['জাতীয় পরিচিতি', 'জন্ম নিবন্ধন', 'NID', 'BRC'])?.value ||
        findEntryByKeywords(entries1, ['জাতীয় পরিচিতি', 'জন্ম নিবন্ধন', 'NID', 'BRC'])?.value ||
        matchedLast?.nid_number || matchedLast?.brc_number || matchedLast?.doc_number || ''
      ).replace(/[^0-9]/g, ''),
      dob: standardizeDate(findEntryByKeywords(entries0, ['জন্ম তারিখ'])?.value || findEntryByKeywords(entries1, ['জন্ম তারিখ'])?.value || matchedLast?.dob || ''),
      fatherBn: findEntryByKeywords(entries1, ['পিতার নাম (বাংলা)'])?.value || matchedLast?.father_name_bn || '',
      motherBn: findEntryByKeywords(entries1, ['মাতার নাম (বাংলা)'])?.value || matchedLast?.mother_name_bn || '',
      mobile: normalizeMobileNumber(findEntryByKeywords(entries1, ['মোবাইল'])?.value || findEntryByKeywords(entries0, ['মোবাইল'])?.value || matchedLast?.mobile_number || '')
    };

    const s3Media = inspectSection3Media(tab9);

    const s4Addr = inspectSection4Address(tab2);
    const addrCfg = getSavedAddressConfig();
    const villageVal = s4Addr.village || addrCfg.village;
    const postcodeVal = s4Addr.postcode || addrCfg.postcode;

    const s5Inspect = inspectSection5Details();
    const sec5 = s5Inspect.data || trackSection5Data();
    const sec6Members = scanFamilyMembers();
    const crossMatch = computeCrossMatch(sec5, sec6Members);

    const rawCards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
    const members = rawCards.map((c, i) => scrapeMemberCardSummary(c, i));

    const seenIds = new Map();
    const duplicateIds = [];
    members.forEach(m => {
      if (!m.docNum) return;
      if (seenIds.has(m.docNum)) {
        duplicateIds.push({ id: m.docNum, first: seenIds.get(m.docNum), second: m.title });
        m.issues.push('ডুপ্লিকেট আইডি!');
      } else {
        seenIds.set(m.docNum, m.title);
      }
    });

    const s6Inspect = inspectSection6Bank();
    const bankBranch = s6Inspect.hasDom ? s6Inspect.branchText : getDefaultBankBranch();
    const bankOwner = s6Inspect.hasDom ? s6Inspect.ownership : (localStorage.getItem('fc_default_account_ownership') || '');

    const s7Inspect = inspectSection7Eligibility();
    const s7Panel = s7Inspect.panel;
    const s7Filled = s7Inspect.filledCount;

    const s9Elems = getSection9MoneyElements();
    const s9Dist = s9Elems ? readCurrentMoneyDistribution(s9Elems.fields) : null;
    const s9Total = s9Dist ? s9Dist.total : 0;

    const blockers = [];
    const sections = [];

    const appOk = Boolean(applicant.nameBn && (applicant.nid.length === 10 || applicant.nid.length === 17) && applicant.fatherBn && applicant.motherBn);
    if (!applicant.nid || (applicant.nid.length !== 10 && applicant.nid.length !== 17)) blockers.push({ tab: '0', text: 'আবেদনকারীর সঠিক ১০/১৭ সংখ্যার NID দিন' });
    if (!applicant.fatherBn || !applicant.motherBn) blockers.push({ tab: '1', text: 'সেকশন ১-২: পিতা ও মাতার বাংলা নাম পূরণ করুন' });
    sections.push({
      tab: '1',
      title: '১-২. আবেদনকারীর পরিচিতি',
      status: appOk ? 'ok' : 'warn',
      detail: applicant.nameBn ? `${applicant.nameBn} • NID: ${applicant.nid || 'নেই'}` : 'এখনো NID স্ক্যান করা হয়নি'
    });

    sections.push({
      tab: '9',
      title: '৩. ছবি, স্বাক্ষর ও বাড়ির ছবি',
      status: s3Media.allValid ? 'ok' : (s3Media.completedCount > 0 ? 'warn' : 'missing'),
      detail: `ছবি: ${s3Media.photo.ok ? '✅' : '⚠️'} | স্বাক্ষর: ${s3Media.signature.ok ? '✅' : '⚠️'} | বাড়ি: ${s3Media.house.ok ? '✅' : '⚠️'}`
    });
    if (!s3Media.allValid) {
      blockers.push({ tab: '9', text: `সেকশন ৩: ${s3Media.issues.join(', ')}` });
    }

    const s4Ok = s4Addr.hasDom ? s4Addr.allValid : Boolean(villageVal && /^\d{4}$/.test(postcodeVal));
    sections.push({
      tab: '2',
      title: '৪. তথ্য সংগ্রহের ঠিকানা',
      status: s4Ok ? 'ok' : (s4Addr.collectionOk ? 'warn' : 'missing'),
      detail: `গ্রাম: ${villageVal || '-'} • পোস্টকোড: ${toBnDigits(postcodeVal)}${s4Addr.hasDom && !s4Addr.permOk ? ' • স্থায়ী বাকি' : ''}`
    });
    if (s4Addr.hasDom && !s4Addr.allValid) {
      blockers.push({ tab: '2', text: `সেকশন ৪: ${s4Addr.issues.join(', ')}` });
    }

    const sec5CountOk = Boolean(sec5 && sec5.totalCount > 0);
    const sec5Ok = s5Inspect.hasDom
      ? s5Inspect.allValid
      : Boolean(sec5CountOk && (sec5.abroadMale || 0) <= (sec5.maleCount || 0) && (sec5.abroadFemale || 0) <= (sec5.femaleCount || 0) && (sec5.abroadTrans || 0) <= (sec5.transCount || 0));
    sections.push({
      tab: '3',
      title: '৫. খানার সদস্য ও অর্থনৈতিক তথ্য',
      status: sec5Ok ? 'ok' : (sec5CountOk || s5Inspect.filledCount > 0 ? 'warn' : 'missing'),
      detail: sec5CountOk
        ? `পুরুষ ${toBnDigits(sec5.maleCount)}, নারী ${toBnDigits(sec5.femaleCount)} (মোট ${toBnDigits(sec5.totalCount)} জন)${s5Inspect.hasDom ? ` • ${toBnDigits(s5Inspect.filledCount)}/${toBnDigits(s5Inspect.totalRequired)} ফিল্ড` : ''}${sec5.mfs ? ` • ${sec5.mfs}` : ''}`
        : (s5Inspect.hasDom ? `${toBnDigits(s5Inspect.filledCount)}/${toBnDigits(s5Inspect.totalRequired)} ফিল্ড পূরণকৃত` : 'সেকশন ৫ পূরণ করা হয়নি')
    });
    if (s5Inspect.hasDom && !s5Inspect.allValid) {
      blockers.push({ tab: '3', text: `সেকশন ৫: ${s5Inspect.issues.join(' • ') || 'সবগুলো তথ্য সঠিকভাবে পূরণ করুন'}` });
    } else if (!sec5CountOk) {
      blockers.push({ tab: '3', text: 'সেকশন ৫: খানার মোট সদস্য সংখ্যা পূরণ করুন' });
    }

    const sec6Ok = s6Inspect.hasDom ? s6Inspect.allValid : Boolean(bankBranch);
    sections.push({
      tab: '4',
      title: '৬. ব্যাংক / মোবাইল ব্যাংকিং',
      status: sec6Ok ? 'ok' : (s6Inspect.hasDom && !s6Inspect.branchText ? 'missing' : 'warn'),
      detail: s6Inspect.hasDom
        ? (s6Inspect.isBankAccount
            ? `মালিকানা: ${bankOwner || '-'} • শাখা: ${bankBranch || 'নির্বাচিত নয়'}${!s6Inspect.branchOk ? ` (লক্ষ্য: ${s6Inspect.target})` : ''}`
            : `${s6Inspect.elems?.accountTypeText || 'এমএফএস'} • মালিকানা: ${bankOwner || '-'}`)
        : (bankBranch ? `মালিকানা: ${bankOwner || '-'} • ডিফল্ট শাখা: ${bankBranch}` : 'ব্যাংক শাখা ও মালিকানা যাচাই করুন')
    });
    if (s6Inspect.hasDom && !s6Inspect.allValid) {
      blockers.push({ tab: '4', text: `সেকশন ৬: ${s6Inspect.issues.join(' • ')}` });
    } else if (!s6Inspect.hasDom && !bankBranch) {
      blockers.push({ tab: '4', text: 'সেকশন ৬: ব্যাংক শাখা ও মালিকানা যাচাই করুন' });
    }

    sections.push({
      tab: '5',
      title: '৭. খানার যোগ্যতা ও সুযোগ-সুবিধা',
      status: s7Inspect.hasDom ? (s7Inspect.allValid ? 'ok' : (s7Filled > 0 ? 'warn' : 'missing')) : 'warn',
      detail: s7Inspect.hasDom
        ? `${toBnDigits(s7Filled)}/${toBnDigits(s7Inspect.totalQuestions)}টি প্রশ্ন পূরণ${s7Inspect.roomsVal ? ` • রুম ${s7Inspect.roomsVal}` : ''}${s7Inspect.issues.length ? ` • ${s7Inspect.issues[0]}` : (s7Inspect.missingFields.length ? ` • বাকি ${toBnDigits(s7Inspect.missingFields.length)}টি` : ' ✅')}`
        : 'সেকশন ৭ খুললে ২৪টি প্রশ্ন অটো-ফিল হবে'
    });
    if (s7Inspect.hasDom && !s7Inspect.allValid) {
      const s7Msgs = [...s7Inspect.issues];
      if (s7Inspect.missingFields.length > 0) {
        s7Msgs.push(`বাকি (${toBnDigits(s7Inspect.missingFields.length)}টি): ${s7Inspect.missingFields.slice(0, 3).join(', ')}${s7Inspect.missingFields.length > 3 ? '…' : ''}`);
      }
      blockers.push({ tab: '5', text: `সেকশন ৭: ${s7Msgs.join(' • ')}` });
    }

    const sec8Tracked = trackSection8Data();
    const memberIssues = members.filter(m => m.issues.length > 0);
    const sec8Ok = crossMatch.isExactMatch && memberIssues.length === 0 && duplicateIds.length === 0;
    sections.push({
      tab: '6',
      title: '৮. পরিবারের সদস্য ও ডকুমেন্ট স্ক্যান',
      status: sec8Ok ? 'ok' : (members.length ? 'warn' : 'missing'),
      detail: `${toBnDigits(members.length)} জন সদস্য${sec8Tracked ? ` • শিক্ষার্থী ${toBnDigits(sec8Tracked.studentCount)} জন` : ''} • ${crossMatch.statusText}${duplicateIds.length ? ` • ডুপ্লিকেট আইডি (${toBnDigits(duplicateIds.length)})!` : ''}`
    });
    if (!crossMatch.isExactMatch && sec5CountOk) blockers.push({ tab: '6', text: `সেকশন ৮ ক্রস-ম্যাচ: ${crossMatch.statusText}` });
    if (duplicateIds.length) blockers.push({ tab: '6', text: `সদস্যদের মধ্যে একই NID/BRC (${duplicateIds[0].id}) একাধিকবার রয়েছে!` });
    memberIssues.forEach(m => blockers.push({ tab: '6', text: `${m.title} (${m.nameBn || 'নামহীন'}): ${m.issues.join(', ')}` }));

    const eduMismatchNoStudent = Boolean(s9Dist && sec8Tracked && sec8Tracked.hasSec8Data && !sec8Tracked.hasStudent && s9Dist.education > 0);
    const sec9Ok = s9Total === 2500 && !eduMismatchNoStudent;
    sections.push({
      tab: '10',
      title: '৯. ভাতা ব্যবহার (২৫০০ টাকা)',
      status: sec9Ok ? 'ok' : 'warn',
      detail: s9Elems
        ? `মোট বরাদ্দ: ${toBnDigits(s9Total)} / ২৫০০ টাকা • শিক্ষা: ${toBnDigits(s9Dist?.education || 0)} টাকা${eduMismatchNoStudent ? ' (শিক্ষার্থী নেই!)' : ''}`
        : 'সেকশন ৯ খুললে এআই বণ্টন হবে'
    });
    if (s9Elems && s9Total !== 2500) blockers.push({ tab: '10', text: `সেকশন ৯: মোট বরাদ্দ ${toBnDigits(s9Total)} টাকা (ঠিক ২৫০০ টাকা হতে হবে)` });
    if (s9Elems && eduMismatchNoStudent) blockers.push({ tab: '10', text: `সেকশন ৯: সেকশন ৮-এ কোনো শিক্ষার্থী নেই — "সন্তানের শিক্ষা" ০ টাকা হতে হবে` });

    const s10User = inspectSection10EntryUser();
    sections.push({
      tab: '7',
      title: '১০. এন্ট্রি ব্যবহারকারীর তথ্য',
      status: s10User.hasDom ? (s10User.allValid ? 'ok' : 'warn') : 'warn',
      detail: s10User.hasDom
        ? `${toBnDigits(s10User.filledCount)}/${toBnDigits(s10User.totalFields)}টি ফিল্ড পূরণকৃত`
        : 'ধাপ ১১ (এন্ট্রি ব্যবহারকারী) খুললে যাচাই হবে'
    });
    if (s10User.hasDom && !s10User.allValid) {
      blockers.push({ tab: '7', text: 'এন্ট্রি ব্যবহারকারীর আবশ্যিক তথ্য পূরণ করুন' });
    }

    const c11 = inspectSection11Consent();
    sections.push({
      tab: '11',
      title: '১১. সম্মতি ও চূড়ান্ত ঘোষণা',
      status: c11.agreed && !c11.submitDisabled ? 'ok' : (c11.agreed ? 'warn' : 'missing'),
      detail: c11.agreed ? (c11.submitDisabled ? '☑️ সম্মতি টিক দেওয়া আছে (অন্যান্য ধাপ যাচাই করুন)' : '✅ সম্মতি সম্পূর্ণ — সাবমিটের জন্য প্রস্তুত') : '⚠️ সম্মতি চেকবক্সে টিক দেওয়া বাকি'
    });
    if (!c11.agreed) {
      blockers.push({ tab: '11', text: 'চূড়ান্ত ধাপে সম্মতি ও ঘোষণায় (☑️) টিক দিন' });
    }

    const okCount = sections.filter(s => s.status === 'ok').length;
    const readinessPct = Math.round((okCount / sections.length) * 100);

    return {
      familyId,
      applicant,
      villageVal,
      postcodeVal,
      sec5,
      s5Inspect,
      crossMatch,
      members,
      duplicateIds,
      s6Inspect,
      bankBranch,
      bankOwner,
      s7Inspect,
      s10User,
      c11,
      s9Total,
      s9Dist,
      sections,
      blockers,
      readinessPct,
      scanHistory: window.__fcScanHistory || []
    };
  }

  const EXT_STEP_META = [
    { tabAttr: '0', shortNum: '১', shortTitle: 'যাচাইকরণ', title: '১. যাচাইকরণ (NID / BRC ও জন্ম তারিখ)' },
    { tabAttr: '1', shortNum: '২', shortTitle: 'ব্যক্তিগত', title: '২. আবেদনকারীর ব্যক্তিগত তথ্য' },
    { tabAttr: '9', shortNum: '৩', shortTitle: 'ছবি/ডকুমেন্ট', title: '৩. ছবি, স্বাক্ষর ও বাড়ির ছবি' },
    { tabAttr: '2', shortNum: '৪', shortTitle: 'যোগাযোগ', title: '৪. যোগাযোগ ও স্থায়ী ঠিকানা' },
    { tabAttr: '3', shortNum: '৫', shortTitle: 'বিস্তারিত', title: '৫. ফ্যামিলি কার্ড বিস্তারিত ও MFS' },
    { tabAttr: '4', shortNum: '৬', shortTitle: 'ব্যাংক/MFS', title: '৬. ব্যাংক ও শাখা তথ্য' },
    { tabAttr: '8', shortNum: '৭', shortTitle: 'নমিনী', title: '৭. নমিনী তথ্য' },
    { tabAttr: '5', shortNum: '৮', shortTitle: 'যোগ্যতা', title: '৮. যোগ্যতার অন্যান্য তথ্য' },
    { tabAttr: '6', shortNum: '৯', shortTitle: 'সদস্য', title: '৯. পরিবারের সদস্য তালিকা' },
    { tabAttr: '10', shortNum: '১০', shortTitle: 'অর্থ ব্যবহার', title: '১০. অর্থ ব্যবহার (২,৫০০ টাকা)' },
    { tabAttr: '7', shortNum: '১১', shortTitle: 'এন্ট্রি ইউজার', title: '১১. এন্ট্রি ব্যবহারকারীর তথ্য' },
    { tabAttr: '11', shortNum: '১২', shortTitle: 'সম্মতি', title: '১২. সম্মতি ও চূড়ান্ত ঘোষণা' }
  ];

  async function focusPortalField(tabAttr, labelHints = []) {
    if (typeof jumpToPortalSection === 'function') jumpToPortalSection(tabAttr);
    await new Promise(r => setTimeout(r, 320));
    const panel = document.querySelector(`[data-family-card-tab="${String(tabAttr)}"]`);
    if (!panel) return false;
    const hints = (Array.isArray(labelHints) ? labelHints : [labelHints])
      .map(h => normalizeBn(String(h || '').replace(/\*/g, '').trim()))
      .filter(Boolean);
    if (!hints.length) return true;
    let targetEl = null;
    const labels = Array.from(panel.querySelectorAll('label, .v-label, legend, th, .fm-field-label'));
    for (const lbl of labels) {
      const txt = normalizeBn((lbl.textContent || '').replace(/\*/g, '').trim());
      if (hints.some(h => txt === h || txt.includes(h) || h.includes(txt))) {
        targetEl = lbl.closest('.v-input, .col, [class*="col-"], .v-input--selection-controls, tr') || lbl.parentElement;
        if (targetEl) break;
      }
    }
    if (targetEl) {
      if (typeof targetEl.scrollIntoView === 'function') {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      targetEl.classList.add('fc-field-trace-pulse');
      const inp = Array.from(targetEl.querySelectorAll('input, textarea, select')).find(el => !el.disabled);
      if (inp && typeof inp.focus === 'function') {
        try { inp.focus({ preventScroll: true }); } catch (_) {}
      }
      setTimeout(() => targetEl.classList.remove('fc-field-trace-pulse'), 2800);
      return true;
    }
    return false;
  }

  function inspectSection10EntryUser() {
    const panel = document.querySelector('[data-family-card-tab="7"]');
    if (!panel) return { hasDom: false, fields: [], filledCount: 0, totalFields: 0, allValid: false };
    const fields = [];
    const seen = new Set();
    panel.querySelectorAll('.v-input, .col, [class*="col-"]').forEach((box) => {
      const lblEl = box.querySelector('label, .v-label');
      const inp = box.querySelector('input, textarea, select');
      if (!lblEl || !inp) return;
      const label = normalizeBn((lblEl.textContent || '').replace(/\*/g, '').trim());
      if (!label || seen.has(label)) return;
      seen.add(label);
      const sel = box.querySelector('.v-select__selection');
      const val = (sel && sel.textContent.trim()) || String(inp.value || '').trim();
      const req = Boolean(lblEl.textContent.includes('*') || inp.required || inp.getAttribute('aria-required') === 'true');
      fields.push({ label, value: val, required: req, ok: Boolean(val) });
    });
    const filledCount = fields.filter(f => f.ok).length;
    const reqMissing = fields.filter(f => f.required && !f.ok).length;
    return {
      hasDom: true,
      panel,
      fields,
      filledCount,
      totalFields: fields.length,
      allValid: fields.length > 0 ? reqMissing === 0 && filledCount > 0 : true
    };
  }

  function inspectSection11Consent() {
    const panel = document.querySelector('[data-family-card-tab="11"]');
    const submitBtn = document.querySelector('.family-card-form-footer__btn--submit');
    const submitDisabled = submitBtn ? Boolean(submitBtn.disabled || submitBtn.classList.contains('v-btn--disabled')) : true;
    if (!panel) return { hasDom: false, agreed: false, submitDisabled, hasSubmitBtn: Boolean(submitBtn) };
    const cb = panel.querySelector('input[type="checkbox"]');
    const agreed = cb ? Boolean(cb.checked || cb.getAttribute('aria-checked') === 'true') : false;
    return { hasDom: true, panel, checkbox: cb, agreed, submitDisabled, hasSubmitBtn: Boolean(submitBtn) };
  }

  function findExtCrossStepLinkHint(tabAttr, labelNorm) {
    if (tabAttr === '0' && (labelNorm.includes('পরিচিতি') || labelNorm.includes('নিবন্ধন') || labelNorm.includes('জন্ম তারিখ'))) return 'স্টেপ ২ ও স্টেপ ৯ (সদস্য-১ নিজ)-এর সাথে যুক্ত';
    if (tabAttr === '1' && (labelNorm.includes('নাম') || labelNorm.includes('পিতা') || labelNorm.includes('মাতা') || labelNorm.includes('স্বামী'))) return 'স্টেপ ১ OCR থেকে অটো-ফিল • স্টেপ ৭ ও ৯ নিয়ন্ত্রণ করে';
    if (tabAttr === '2' && (labelNorm.includes('গ্রাম') || labelNorm.includes('পোস্ট') || labelNorm.includes('ঠিকানা'))) return 'তথ্য সংগ্রহের ঠিকানা ➔ স্থায়ী ঠিকানায় কপি হয়';
    if (tabAttr === '3' && (labelNorm.includes('পুরুষ') || labelNorm.includes('নারী') || labelNorm.includes('মোবাইল ব্যাংকিং'))) return 'স্টেপ ৯ সদস্য ও স্টেপ ৬ MFS ক্রস-ম্যাচড';
    if (tabAttr === '4') return 'ডিফল্ট শাখা: মাছপাড়া শাখা';
    if (tabAttr === '8') return 'স্টেপ ২ ও ৯-এ থাকা পরিবারের সদস্যের সাথে সম্পর্কিত';
    if (tabAttr === '6') return 'শিক্ষার্থী/প্রতিবন্ধী স্ট্যাটাস ➔ স্টেপ ১০ (২,৫০০৳) নির্ধারণ করে';
    if (tabAttr === '10') return 'স্টেপ ৯-এ শিক্ষার্থী থাকলে "সন্তানের শিক্ষা" বরাদ্দ হয়';
    if (tabAttr === '7' || tabAttr === '11') return 'সব ধাপ সম্পন্ন হলে সাবমিট বাটন সক্রিয় হয়';
    return '';
  }

  function collectFullFieldTrace() {
    const steps = [];
    let totalFields = 0;
    let filledFields = 0;
    let missingRequired = 0;

    for (const meta of EXT_STEP_META) {
      const panel = document.querySelector(`[data-family-card-tab="${meta.tabAttr}"]`);
      const fields = [];
      const seenLabels = new Set();

      if (panel) {
        if (meta.tabAttr === '9') {
          const s3 = inspectSection3Media(panel);
          [
            { label: 'আবেদনকারীর ছবি', ok: s3.photo.ok, val: s3.photo.ok ? 'আপলোড সম্পন্ন' : 'বাকি', req: true },
            { label: 'আবেদনকারীর স্বাক্ষর', ok: s3.signature.ok, val: s3.signature.ok ? 'আপলোড সম্পন্ন' : 'বাকি', req: true },
            { label: 'বাড়ির ছবি', ok: s3.house.ok, val: s3.house.ok ? 'আপলোড সম্পন্ন' : 'ঐচ্ছিক/বাকি', req: false }
          ].forEach(item => {
            fields.push({ label: item.label, value: item.val, required: item.req, status: item.ok ? 'filled' : (item.req ? 'missing' : 'optional'), linkHint: 'ধাপ ৩ মিডিয়া ট্রেসার' });
          });
        } else {
          panel.querySelectorAll('[role="radiogroup"]').forEach((rg) => {
            const container = rg.closest('.v-input--radio-group, .col, [class*="col-"], div') || rg.parentElement;
            const lblNode = Array.from(container ? container.querySelectorAll('legend, .v-label--active, label') : []).find(n => !n.closest('.v-radio')) || container?.previousElementSibling;
            const label = normalizeBn(String((lblNode && !lblNode.closest('.v-radio') ? lblNode.textContent : '') || rg.getAttribute('aria-label') || '').replace(/\*/g, '').trim());
            if (!label || seenLabels.has(label)) return;
            seenLabels.add(label);
            const checkedRadio = Array.from(rg.querySelectorAll('input[type="radio"]')).find(r => r.checked || r.getAttribute('aria-checked') === 'true');
            const checkedLbl = checkedRadio ? (checkedRadio.closest('.v-radio')?.querySelector('label')?.textContent?.trim() || checkedRadio.value || 'নির্বাচিত') : '';
            const req = Boolean((lblNode?.textContent || '').includes('*') || rg.getAttribute('aria-required') === 'true');
            fields.push({ label, value: checkedLbl, required: req, status: checkedLbl ? 'filled' : (req ? 'missing' : 'optional'), linkHint: findExtCrossStepLinkHint(meta.tabAttr, label) });
          });

          panel.querySelectorAll('.v-input--checkbox, input[type="checkbox"]').forEach((node) => {
            const box = node.matches('input') ? (node.closest('.v-input--checkbox, label') || node.parentElement) : node;
            const cb = node.matches('input') ? node : box?.querySelector('input[type="checkbox"]');
            if (!cb) return;
            const lbl = box?.querySelector('label')?.textContent?.replace(/\*/g, '').trim() || 'সম্মতি চেকবক্স';
            const cleanLbl = normalizeBn(lbl);
            if (!cleanLbl || seenLabels.has(cleanLbl)) return;
            seenLabels.add(cleanLbl);
            const isChecked = Boolean(cb.checked || cb.getAttribute('aria-checked') === 'true');
            const req = meta.tabAttr === '11' || Boolean(lbl.includes('*'));
            fields.push({ label: cleanLbl, value: isChecked ? '☑️ টিক দেওয়া হয়েছে' : '', required: req, status: isChecked ? 'filled' : (req ? 'missing' : 'optional'), linkHint: findExtCrossStepLinkHint(meta.tabAttr, cleanLbl) });
          });

          Array.from(panel.querySelectorAll('.v-input, .fm-q-card'))
            .filter(wrap => !wrap.classList?.contains('v-input--radio-group') && !wrap.classList?.contains('v-input--checkbox'))
            .forEach((wrap) => {
              const lblEl = wrap.querySelector('label, .fm-q-title');
              const inp = Array.from(wrap.querySelectorAll('input, textarea')).find(el => el.type !== 'radio' && el.type !== 'checkbox');
              if (!lblEl || !inp) return;
              const rawLbl = String(lblEl.textContent || '');
              const label = normalizeBn(rawLbl.replace(/\*/g, '').trim());
              if (!label || seenLabels.has(label)) return;
              seenLabels.add(label);
              const selText = wrap.querySelector('.v-select__selection')?.textContent?.trim() || '';
              const val = selText || String(inp.value || '').trim();
              const req = Boolean(rawLbl.includes('*') || inp.required || inp.getAttribute('aria-required') === 'true');
              fields.push({ label, value: val, required: req, status: val ? 'filled' : (req ? 'missing' : 'optional'), linkHint: findExtCrossStepLinkHint(meta.tabAttr, label) });
            });
        }
      }

      const stepFilled = fields.filter(f => f.status === 'filled').length;
      const stepMissingReq = fields.filter(f => f.status === 'missing').length;
      totalFields += fields.length;
      filledFields += stepFilled;
      missingRequired += stepMissingReq;
      steps.push({ ...meta, inDom: Boolean(panel), fields, filled: stepFilled, missingRequired: stepMissingReq });
    }

    const s5 = trackSection5Data();
    const s6 = inspectSection6Bank();
    const sec8Tracked = typeof trackSection8Data === 'function' ? trackSection8Data() : null;
    const s9Elems = getSection9MoneyElements();
    const s9Dist = s9Elems ? readCurrentMoneyDistribution(s9Elems.fields) : {};
    const c11 = inspectSection11Consent();
    const s4Addr = inspectSection4Address(document.querySelector('[data-family-card-tab="2"]'));
    const addrCfg = getSavedAddressConfig();
    const crossLinks = [
      { fromLabel: 'স্টেপ ১ (OCR NID / BRC)', toLabel: 'স্টেপ ২ (ব্যক্তিগত)', toTab: '1', jumpKey: 'নাম (বাংলা)', ok: Boolean(lastExtractedData?.name_bn), detail: lastExtractedData?.name_bn || 'ফর্ম দেখে যাচাই করুন' },
      { fromLabel: 'স্টেপ ৪ (ঠিকানা)', toLabel: 'স্থায়ী ঠিকানা', toTab: '2', jumpKey: 'পোস্ট কোড', ok: s4Addr.hasDom ? s4Addr.allValid : Boolean(addrCfg.village), detail: `গ্রাম: ${s4Addr.village || addrCfg.village} • ${toBnDigits(s4Addr.postcode || addrCfg.postcode)}` },
      { fromLabel: 'স্টেপ ৫ (সদস্য)', toLabel: 'স্টেপ ৯ (কার্ড)', toTab: '6', jumpKey: '', ok: Boolean(s5 && s5.totalCount > 0), detail: `মোট ${toBnDigits(s5?.totalCount || 0)} জন` },
      { fromLabel: 'স্টেপ ৫ (MFS)', toLabel: 'স্টেপ ৬ (ব্যাংক)', toTab: '4', jumpKey: 'ব্যাংক শাখার নাম', ok: Boolean(s6.hasDom ? s6.allValid : getDefaultBankBranch()), detail: `শাখা: ${s6.branchText || getDefaultBankBranch()}` },
      { fromLabel: `স্টেপ ৯ (শিক্ষার্থী: ${toBnDigits(sec8Tracked?.studentCount || 0)})`, toLabel: 'স্টেপ ১০ (২৫০০৳)', toTab: '10', jumpKey: 'সন্তানের শিক্ষা', ok: Number(s9Dist.total || 0) === 2500, detail: `মোট ${toBnDigits(s9Dist.total || 0)}/২৫০০৳ (শিক্ষা ${toBnDigits(s9Dist.education || 0)}৳)` },
      { fromLabel: 'স্টেপ ১১–১২ (সম্মতি)', toLabel: 'সাবমিট', toTab: '11', jumpKey: 'সম্মতি', ok: Boolean(c11.agreed && !c11.submitDisabled), detail: c11.agreed ? 'সম্মতি নির্বাচিত' : 'সম্মতি বাকি' }
    ];
    const pct = totalFields > 0 ? Math.round((filledFields / totalFields) * 100) : 0;
    return { steps, totalFields, filledFields, missingRequired, pct, crossLinks };
  }

  function handleSection11Consent() {
    const tab11 = document.querySelector('[data-family-card-tab="11"]');
    if (!tab11 || !isPanelActiveVisible(tab11)) return;
    const c11 = inspectSection11Consent();
    const s10 = inspectSection10EntryUser();
    let bar = document.getElementById('fc-section11-toolbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fc-section11-toolbar';
      tab11.insertBefore(bar, tab11.firstChild);
    }
    const trace = collectFullFieldTrace();
    const sig = `${c11.agreed}|${c11.submitDisabled}|${s10.filledCount}|${trace.missingRequired}`;
    if (bar.dataset.lastSig === sig) return;
    bar.dataset.lastSig = sig;
    bar.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
        <b style="color:#4c1d95;">✅ ধাপ ১১–১২: এন্ট্রি ও চূড়ান্ত সম্মতি যাচাই</b>
        <span class="fc-s2-pill ${c11.agreed && trace.missingRequired === 0 ? 'ok' : ''}">
          ${c11.agreed ? '☑️ সম্মতি নির্বাচিত' : '⚠️ সম্মতি বাকি'} • ${toBnDigits(trace.pct)}% প্রস্তুত
        </span>
      </div>
      <div style="font-size:11px; color:#334155; margin-bottom:7px;">
        এন্ট্রি ব্যবহারকারী: <b>${s10.hasDom ? `${toBnDigits(s10.filledCount)}/${toBnDigits(s10.totalFields)} ফিল্ড` : 'দেখুন'}</b> •
        সাবমিট বাটন: <b>${c11.submitDisabled ? '🔒 নিষ্ক্রিয়' : '🟢 সক্রিয়'}</b>
        ${trace.missingRequired > 0 ? ` • <span style="color:#b91c1c;">বাকি জরুরি ফিল্ড: ${toBnDigits(trace.missingRequired)}টি</span>` : ''}
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" id="fc-s11-open-trace" class="fc-s2-btn primary">🗺️ পূর্ণাঙ্গ ট্রেস</button>
        <button type="button" id="fc-s11-open-sum" class="fc-s2-btn accent">📊 সারসংক্ষেপ</button>
        ${!c11.agreed && c11.checkbox ? `<button type="button" id="fc-s11-agree-btn" class="fc-s2-btn" style="background:#7c3aed; color:#fff; border-color:#7c3aed;">☑️ সম্মতি টিক দিন</button>` : ''}
      </div>
    `;
    const btnTrace = bar.querySelector('#fc-s11-open-trace');
    if (btnTrace) btnTrace.onclick = () => openTraceExplorerModal();
    const btnSum = bar.querySelector('#fc-s11-open-sum');
    if (btnSum) btnSum.onclick = () => openSummaryModal();
    const btnAgree = bar.querySelector('#fc-s11-agree-btn');
    if (btnAgree && c11.checkbox) {
      btnAgree.onclick = () => {
        c11.checkbox.click();
        c11.checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        handleSection11Consent();
        updateSummaryBadge(true);
      };
    }
  }

  function renderExtLogList() {
    const elLogList = document.getElementById('fc-ext-log-list');
    if (!elLogList) return;
    const logs = getLocalErrorLogs();
    if (!logs.length) {
      elLogList.innerHTML = `<div style="font-size:11px; color:#64748b; text-align:center; padding:8px; background:#f8fafc; border-radius:7px; border:1px dashed #cbd5e1;">✅ কোনো এরর বা ওয়ার্নিং লগ নেই</div>`;
      return;
    }
    elLogList.innerHTML = logs.slice(0, 15).map((l) => {
      const cls = l.level === 'warn' ? 'warn' : (l.level === 'info' ? 'info' : '');
      const tStr = l.createdAt ? new Date(l.createdAt).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      const syncTag = l.synced ? '☁️ Firebase' : '💾 Local';
      return `
        <div class="fc-log-row ${cls}">
          <div style="display:flex; justify-content:space-between; gap:6px; font-weight:800; margin-bottom:2px;">
            <span>[${escapeHtml(l.stage || 'log')}] ${escapeHtml(l.model || '')}</span>
            <span style="font-weight:600; opacity:0.85;">${escapeHtml(syncTag)} • ${escapeHtml(tStr)}</span>
          </div>
          <div>${escapeHtml(l.message || '')}</div>
        </div>
      `;
    }).join('');
  }

  let _extTraceTabFilter = 'all';
  let _extTraceModeFilter = 'all';

  function renderExtTraceExplorerBody() {
    const body = document.getElementById('fc-trace-body');
    if (!body) return;
    const trace = collectFullFieldTrace();
    const targetSteps = _extTraceTabFilter === 'all' ? trace.steps : trace.steps.filter(st => st.tabAttr === _extTraceTabFilter);

    let html = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:4px;">
        <span style="font-size:11.5px; color:#0f172a;">মোট <b>${toBnDigits(trace.totalFields)}</b> ফিল্ড • পূরণকৃত <b>${toBnDigits(trace.filledFields)}</b> ✅ • বাকি <b>${toBnDigits(trace.missingRequired)}</b> ⚠️ (${toBnDigits(trace.pct)}%)</span>
        <button type="button" id="fc-ext-trace-refresh" class="fc-trace-jump-btn">🔄 রিট্রেস</button>
      </div>
      <div class="fc-trace-steps-bar">
        <button type="button" class="fc-trace-step-pill ${_extTraceTabFilter === 'all' ? 'active' : ''}" data-ext-step="all">সব (${toBnDigits(trace.steps.length)})</button>
        ${trace.steps.map(st => {
          const cls = st.missingRequired === 0 && st.filled > 0 ? 'ok' : (st.missingRequired > 0 ? 'warn' : '');
          const act = _extTraceTabFilter === st.tabAttr ? 'active' : '';
          return `<button type="button" class="fc-trace-step-pill ${cls} ${act}" data-ext-step="${escapeHtml(st.tabAttr)}">${escapeHtml(st.shortNum)}. ${escapeHtml(st.shortTitle)} (${toBnDigits(st.filled)}/${toBnDigits(st.fields.length)})</button>`;
        }).join('')}
      </div>
      <div style="display:flex; gap:5px; flex-wrap:wrap; margin-bottom:6px;">
        <button type="button" class="fc-trace-filter-btn ${_extTraceModeFilter === 'all' ? 'active' : ''}" data-ext-mode="all">সব ফিল্ড</button>
        <button type="button" class="fc-trace-filter-btn ${_extTraceModeFilter === 'missing' ? 'active' : ''}" data-ext-mode="missing">⚠️ বাকি/জরুরি</button>
        <button type="button" class="fc-trace-filter-btn ${_extTraceModeFilter === 'links' ? 'active' : ''}" data-ext-mode="links">🔗 ক্রস-স্টেপ লিঙ্ক</button>
        <button type="button" class="fc-trace-filter-btn ${_extTraceModeFilter === 'logs' ? 'active' : ''}" data-ext-mode="logs">🐞 Firebase লগ</button>
      </div>
    `;

    if (_extTraceModeFilter === 'logs') {
      html += `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <b style="font-size:11.5px;">🐞 সিস্টেম ও AI এরর লগ (Firebase সিঙ্কড)</b>
          <div style="display:flex; gap:4px;">
            <button type="button" id="fc-ext-log-test" class="fc-trace-jump-btn">🧪 টেস্ট</button>
            <button type="button" id="fc-ext-log-clear" class="fc-trace-jump-btn" style="color:#991b1b; border-color:#fecaca; background:#fef2f2;">🗑️ মুছুন</button>
          </div>
        </div>
        <div id="fc-ext-log-list" style="display:flex; flex-direction:column; gap:5px; max-height:310px; overflow-y:auto;"></div>
      `;
    } else if (_extTraceModeFilter === 'links') {
      html += `<div style="max-height:330px; overflow-y:auto;">` + trace.crossLinks.map(lk => `
        <div class="fc-link-chip">
          <div>
            <b>${escapeHtml(lk.fromLabel)} ➜ ${escapeHtml(lk.toLabel)}</b>
            <div style="font-size:10px; color:#334155;">${escapeHtml(lk.detail)}</div>
          </div>
          <button type="button" class="fc-trace-jump-btn" data-ext-focus-tab="${escapeHtml(lk.toTab)}" data-ext-focus-key="${escapeHtml(lk.jumpKey || '')}">${lk.ok ? '✅' : '⚠️'} যান</button>
        </div>
      `).join('') + `</div>`;
    } else {
      html += `<div style="max-height:330px; overflow-y:auto;">`;
      for (const st of targetSteps) {
        const rows = st.fields.filter(f => _extTraceModeFilter === 'all' || f.status === 'missing');
        if (!rows.length && _extTraceModeFilter === 'missing') continue;
        html += `<div style="font-size:11px; font-weight:800; color:#1e3a8a; margin:6px 0 4px; display:flex; justify-content:space-between; align-items:center;">
          <span>${escapeHtml(st.title)} ${st.inDom ? '' : '<small style="color:#64748b;">(DOM লোড হয়নি)</small>'}</span>
          <button type="button" class="fc-trace-jump-btn" data-ext-focus-tab="${escapeHtml(st.tabAttr)}">🔍 খুলুন</button>
        </div>`;
        html += rows.map(f => `
          <div class="fc-trace-row ${f.status === 'missing' ? 'missing' : ''}">
            <div style="min-width:0;">
              <div style="font-weight:700; color:#0f172a;">${f.status === 'filled' ? '✅' : (f.status === 'missing' ? '⚠️' : '➖')} ${escapeHtml(f.label)}${f.required ? '<span style="color:#dc2626;">*</span>' : ''}</div>
              <div style="font-size:10.5px; color:${f.value ? '#065f46' : '#92400e'}; word-break:break-word;">${escapeHtml(f.value || (f.required ? 'ফাঁকা — পূরণ করুন' : 'ঐচ্ছিক/ফাঁকা'))}</div>
              ${f.linkHint ? `<div style="font-size:9.5px; color:#0369a1;">🔗 ${escapeHtml(f.linkHint)}</div>` : ''}
            </div>
            <button type="button" class="fc-trace-jump-btn" data-ext-focus-tab="${escapeHtml(st.tabAttr)}" data-ext-focus-key="${escapeHtml(f.label)}">🎯 যান</button>
          </div>
        `).join('');
      }
      html += `</div>`;
    }

    body.innerHTML = html;
    if (_extTraceModeFilter === 'logs') {
      renderExtLogList();
      const lt = body.querySelector('#fc-ext-log-test');
      const lc = body.querySelector('#fc-ext-log-clear');
      if (lt) lt.onclick = async () => { await fcLogTelemetry('info', 'manual-test', 'Extension Firebase telemetry verified ✅'); renderExtLogList(); };
      if (lc) lc.onclick = () => { clearLocalErrorLogs(); showToast('🗑️ লগ পরিষ্কার হয়েছে'); };
    }
    const rf = body.querySelector('#fc-ext-trace-refresh');
    if (rf) rf.onclick = renderExtTraceExplorerBody;
    body.querySelectorAll('[data-ext-step]').forEach(b => {
      b.onclick = () => { _extTraceTabFilter = b.getAttribute('data-ext-step') || 'all'; renderExtTraceExplorerBody(); };
    });
    body.querySelectorAll('[data-ext-mode]').forEach(b => {
      b.onclick = () => { _extTraceModeFilter = b.getAttribute('data-ext-mode') || 'all'; renderExtTraceExplorerBody(); };
    });
    body.querySelectorAll('[data-ext-focus-tab]').forEach(b => {
      b.onclick = async () => {
        const tm = document.getElementById('fc-trace-modal');
        if (tm) tm.style.display = 'none';
        const t = b.getAttribute('data-ext-focus-tab');
        const k = b.getAttribute('data-ext-focus-key') || '';
        if (k) await focusPortalField(t, [k]);
        else if (typeof jumpToPortalSection === 'function') jumpToPortalSection(t);
      };
    });
  }

  function openTraceExplorerModal(defaultMode = 'all') {
    _extTraceModeFilter = defaultMode || 'all';
    let tm = document.getElementById('fc-trace-modal');
    if (!tm) {
      tm = document.createElement('div');
      tm.id = 'fc-trace-modal';
      tm.className = 'fc-modal-overlay';
      tm.style.display = 'none';
      tm.innerHTML = `
        <div class="fc-modal-container" style="max-width: 560px;">
          <div class="fc-modal-header" style="background: linear-gradient(135deg, #1e3a8a, #0f766e);">
            <h3>🗺️ স্টেপ ১–১২ ফিল্ড ট্রেস ও Firebase লগ</h3>
            <span class="fc-modal-close" id="fc-trace-close">&times;</span>
          </div>
          <div class="fc-modal-body" id="fc-trace-body" style="max-height:82vh; overflow-y:auto;"></div>
        </div>
      `;
      document.body.appendChild(tm);
      tm.querySelector('#fc-trace-close').onclick = () => { tm.style.display = 'none'; };
      tm.onclick = (e) => { if (e.target === tm) tm.style.display = 'none'; };
    }
    renderExtTraceExplorerBody();
    tm.style.display = 'flex';
  }

  function buildBanglaSummaryReportText(s) {
    const lines = [
      `=== ফ্যামিলি কার্ড সারসংক্ষেপ ===`,
      `পরিবার আইডি: ${s.familyId || 'পাওয়া যায়নি'}`,
      `আবেদনকারী: ${s.applicant.nameBn || '-'} (${s.applicant.nid || '-'})`,
      `ঠিকানা: গ্রাম ${s.villageVal}, পোস্টকোড ${s.postcodeVal}`,
      `সদস্য (সেকশন ৫ বনাম ৮): মোট ${s.sec5?.totalCount || 0} vs কার্ড ${s.members.length} টি (${s.crossMatch.statusText})`,
      `ব্যাংক/শাখা: ${s.bankOwner || '-'} • ${s.bankBranch || 'নির্বাচিত নয়'}${s.s6Inspect?.hasDom && !s.s6Inspect.allValid ? ` [⚠️ ${s.s6Inspect.issues.join(', ')}]` : ''}`,
      `যোগ্যতা (সেকশন ৭): ${s.s7Inspect?.hasDom ? `${s.s7Inspect.filledCount}/${s.s7Inspect.totalQuestions}টি (${s.s7Inspect.allValid ? 'সম্পূর্ণ' : 'অসম্পূর্ণ'})` : 'সেকশন ৭ খোলা হয়নি'}`,
      `ভাতা বণ্টন (সেকশন ৯): ${s.s9Total}/2500 টাকা`,
      `প্রস্তুতি স্কোর: ${s.readinessPct}%`,
      ``,
      `সদস্য তালিকা:`
    ];
    s.members.forEach(m => {
      lines.push(`- ${m.title}: ${m.nameBn || '-'} | ${m.rel || '-'} | ${m.age !== null ? `${m.age} বছর` : '-'} | ${m.docNum || 'নম্বর নেই'}${m.issues.length ? ` [⚠️ ${m.issues.join(', ')}]` : ''}`);
    });
    if (s.blockers.length) {
      lines.push('', 'সাবমিটের আগে করণীয়:');
      s.blockers.forEach((b, i) => lines.push(`${i + 1}. ${b.text}`));
    }
    return lines.join('\n');
  }

  function ensureSummaryModal() {
    let sm = document.getElementById('fc-summary-modal');
    if (sm) return sm;
    sm = document.createElement('div');
    sm.id = 'fc-summary-modal';
    sm.className = 'fc-modal-overlay';
    sm.style.display = 'none';
    sm.innerHTML = `
      <div class="fc-modal-container" style="max-width: 520px;">
        <div class="fc-modal-header" style="background: linear-gradient(135deg, #0f766e, #115e59);">
          <h3>📊 ফ্যামিলি কার্ড সারসংক্ষেপ ও যাচাই</h3>
          <span class="fc-modal-close" id="fc-sum-close">&times;</span>
        </div>
        <div class="fc-modal-body" id="fc-sum-body" style="display:flex; flex-direction:column; gap:8px; max-height:80vh; overflow-y:auto;"></div>
      </div>
    `;
    document.body.appendChild(sm);
    sm.querySelector('#fc-sum-close').onclick = () => { sm.style.display = 'none'; };
    sm.onclick = (e) => { if (e.target === sm) sm.style.display = 'none'; };
    return sm;
  }

  function openSummaryModal() {
    const sm = ensureSummaryModal();
    const body = sm.querySelector('#fc-sum-body');
    const s = collectFullFamilyCardSummary();

    const headerColor = s.readinessPct >= 85 && s.blockers.length === 0 ? '#15803d' : (s.readinessPct >= 50 ? '#b45309' : '#b91c1c');
    let html = `
      <div class="fc-sum-card" style="border-color: ${headerColor}; background: #f8fafc;">
        <div class="fc-sum-row">
          <div>
            <div style="font-weight: 800; font-size: 13.5px; color: #0f172a;">🆔 পরিবার আইডি: ${escapeHtml(s.familyId || 'নেই')}</div>
            <div style="font-size: 11.5px; color: #475569; margin-top: 2px;">👤 ${escapeHtml(s.applicant.nameBn || 'আবেদনকারী অজানা')} • 📱 ${escapeHtml(s.applicant.mobile || 'নেই')}</div>
          </div>
          <div style="text-align: right;">
            <span style="background: ${headerColor}; color: #fff; padding: 4px 10px; border-radius: 20px; font-weight: 800; font-size: 12px;">প্রস্তুতি ${toBnDigits(s.readinessPct)}%</span>
          </div>
        </div>
      </div>
    `;

    if (s.blockers.length > 0) {
      html += `
        <div class="fc-sum-card missing">
          <div style="font-weight: 800; color: #991b1b; font-size: 12px;">⚠️ সাবমিটের আগে যা ঠিক করুন (${toBnDigits(s.blockers.length)}টি)</div>
          ${s.blockers.map(b => `
            <div class="fc-sum-row">
              <span style="color: #7f1d1d;">• ${escapeHtml(b.text)}</span>
              <button type="button" class="fc-sum-jump" data-jump-tab="${escapeHtml(b.tab)}">ঠিক করুন →</button>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      html += `<div class="fc-sum-card ok"><div style="font-weight: 700; color: #166534; font-size: 12.5px;">✅ সকল প্রধান তথ্য যাচাই সম্পন্ন — ফর্ম সাবমিটের জন্য প্রস্তুত!</div></div>`;
    }

    html += `<div style="font-weight: 800; color: #1e293b; font-size: 12px; margin-top: 2px;">📋 সেকশন ভিত্তিক অবস্থা:</div>`;
    html += s.sections.map(sec => `
      <div class="fc-sum-card ${sec.status}">
        <div class="fc-sum-row">
          <div>
            <div style="font-weight: 700; color: #0f172a;">${escapeHtml(sec.title)}</div>
            <div style="font-size: 11px; color: #475569; margin-top: 2px;">${escapeHtml(sec.detail)}</div>
          </div>
          <button type="button" class="fc-sum-jump" data-jump-tab="${escapeHtml(sec.tab)}">দেখুন</button>
        </div>
      </div>
    `).join('');

    if (s.members.length > 0) {
      html += `<div style="font-weight: 800; color: #1e293b; font-size: 12px; margin-top: 2px;">👨‍👩‍👧‍👦 স্ক্যানকৃত/যুক্ত সদস্য (${toBnDigits(s.members.length)} জন):</div>`;
      html += s.members.map(m => `
        <div class="fc-sum-card ${m.issues.length ? 'warn' : 'ok'}" style="padding: 7px 10px;">
          <div class="fc-sum-row">
            <span><b>${escapeHtml(m.title)}</b>: ${escapeHtml(m.nameBn || 'নাম ফাঁকা')} (${escapeHtml(m.rel || '-')}, ${m.age !== null ? `${toBnDigits(m.age)}ব` : '-'})</span>
            <span style="font-family: monospace; font-size: 11px;">${escapeHtml(m.docNum || 'নম্বর নেই')}</span>
          </div>
          ${m.issues.length ? `<div style="font-size: 11px; color: #b45309; font-weight: 700;">⚠️ ${escapeHtml(m.issues.join(' • '))}</div>` : ''}
        </div>
      `).join('');
    }

    if (s.scanHistory.length > 0) {
      const flagged = s.scanHistory.filter(h => h.warnings && h.warnings.length > 0);
      if (flagged.length > 0) {
        html += `<div class="fc-sum-card warn"><div style="font-weight: 700; color: #92400e; font-size: 11.5px;">🪪 সাম্প্রতিক OCR সতর্কতা (${toBnDigits(flagged.length)}টি ডকুমেন্ট)</div>`;
        flagged.slice(0, 5).forEach(h => {
          html += `<div style="font-size: 11px; color: #78350f;">• <b>${escapeHtml(h.name_bn || h.doc_number || 'অজানা')}</b> (${escapeHtml(h.at)}): ${escapeHtml(h.warnings.join('; '))}</div>`;
        });
        html += `</div>`;
      }
    }

    const costStats = getSavedCostStats();
    const sumGem = MODAL_MODEL_PRICING[geminiModel] || MODAL_MODEL_PRICING['gemini-3.1-flash-lite'];
    const sumPeak = isDeepSeekPeakUtc();
    html += `
      <div class="fc-sum-card" style="background: #f0f9ff; border-color: #7dd3fc;">
        <div class="fc-sum-row">
          <div>
            <div style="font-weight: 800; color: #0369a1; font-size: 12px;">💰 AI স্ক্যান খরচ ও ডিফল্ট মডেল</div>
            <div style="font-size: 11px; color: #0c4a6e; margin-top: 2px;">
              ডিফল্ট কী: <b>${escapeHtml(defaultKeySlot)}</b> • Gemini: <b>${escapeHtml(sumGem.label)}</b> • DeepSeek: <b>${sumPeak ? 'Peak $0.30/$1.20' : 'Off-Peak $0.15/$0.60'}</b>
            </div>
          </div>
          <div style="text-align: right; font-size: 11px; font-weight: 700; color: #0f766e;">
            মোট: $${Number(costStats.totalUsd || 0).toFixed(5)}<br>
            (~৳${(Number(costStats.totalUsd || 0) * BDT_PER_USD).toFixed(2)} • ${toBnDigits(costStats.totalScans || 0)} স্ক্যান)
          </div>
        </div>
      </div>
    `;

    html += `
      <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;">
        <button type="button" id="fc-sum-copy-btn" style="flex: 1; background: #1976d2; color: #fff; border: none; border-radius: 8px; padding: 9px; font-weight: 700; font-size: 12px; cursor: pointer;">📋 কপি</button>
        <button type="button" id="fc-sum-cloud-btn" style="flex: 1; background: #0f766e; color: #fff; border: none; border-radius: 8px; padding: 9px; font-weight: 700; font-size: 12px; cursor: pointer;">☁️ ক্লাউড</button>
        <button type="button" id="fc-sum-share-btn" style="flex: 1; background: #4f46e5; color: #fff; border: none; border-radius: 8px; padding: 9px; font-weight: 700; font-size: 12px; cursor: pointer;">💬 রুমে শেয়ার</button>
        <button type="button" id="fc-sum-scan-btn" style="flex: 1; background: #7c3aed; color: #fff; border: none; border-radius: 8px; padding: 9px; font-weight: 700; font-size: 12px; cursor: pointer;">📸 স্ক্যান</button>
      </div>
    `;

    body.innerHTML = html;
    body.querySelectorAll('[data-jump-tab]').forEach(btn => {
      btn.onclick = () => jumpToPortalSection(btn.getAttribute('data-jump-tab'));
    });

    body.querySelector('#fc-sum-copy-btn').onclick = async () => {
      const txt = buildBanglaSummaryReportText(s);
      try {
        await navigator.clipboard.writeText(txt);
        showToast('📋 পূর্ণাঙ্গ বাংলা সারসংক্ষেপ ক্লিপবোর্ডে কপি হয়েছে!');
      } catch (_) {
        prompt('রিপোর্ট কপি করুন:', txt);
      }
    };

    body.querySelector('#fc-sum-cloud-btn').onclick = async () => {
      const docId = s.familyId || s.applicant.nid;
      if (!docId) {
        alert('পরিবার আইডি বা NID পাওয়া যায়নি!');
        return;
      }
      const reportText = buildBanglaSummaryReportText(s);
      const fields = {
        summary_readiness_pct: { integerValue: String(s.readinessPct) },
        summary_member_count: { integerValue: String(s.members.length) },
        summary_money_total: { integerValue: String(s.s9Total) },
        summary_report_text: { stringValue: reportText },
        summary_synced_at: { timestampValue: new Date().toISOString() }
      };
      const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
      try {
        const resp = await fetch(`https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(docId)}?${mask}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        showToast(`☁️ সারসংক্ষেপ ক্লাউডে সংরক্ষিত (আইডি: ${docId})`);
      } catch (err) {
        alert('ক্লাউড সিঙ্ক ব্যর্থ: ' + err.message);
      }
    };

    body.querySelector('#fc-sum-share-btn').onclick = async () => {
      const reportText = buildBanglaSummaryReportText(s);
      await sendRoomMessage({
        type: 'summary',
        text: reportText,
        payload: { familyId: s.familyId, readinessPct: s.readinessPct, memberCount: s.members.length, blockersCount: s.blockers.length }
      });
      sm.style.display = 'none';
      openChatModal();
      showToast(`💬 রুম ${roomCode}-এ সারসংক্ষেপ পাঠানো হয়েছে!`);
    };

    const fieldTrace = collectFullFieldTrace();
    const traceCard = document.createElement('div');
    traceCard.className = 'fc-sum-card';
    traceCard.style.cssText = 'background:#f0f9ff; border-color:#7dd3fc;';
    traceCard.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:5px;">
        <b style="font-size:11.5px; color:#0c4a6e;">🔗 ক্রস-স্টেপ ফিল্ড ট্রেস (${toBnDigits(fieldTrace.filledFields)}/${toBnDigits(fieldTrace.totalFields)} ফিল্ড • বাকি ${toBnDigits(fieldTrace.missingRequired)}টি)</b>
        <div style="display:flex; gap:4px;">
          <button type="button" id="fc-sum-ext-trace-btn" class="fc-trace-jump-btn" style="background:#0284c7; color:#fff; border-color:#0284c7;">🗺️ পূর্ণাঙ্গ ট্রেস</button>
          <button type="button" id="fc-sum-ext-logs-btn" class="fc-trace-jump-btn" style="background:#7c3aed; color:#fff; border-color:#7c3aed;">🐞 লগ</button>
        </div>
      </div>
      ${fieldTrace.crossLinks.map(lk => `
        <div class="fc-link-chip" style="margin-bottom:3px;">
          <span>${lk.ok ? '✅' : '⚠️'} <b>${escapeHtml(lk.fromLabel)} ➜ ${escapeHtml(lk.toLabel)}</b>: ${escapeHtml(lk.detail)}</span>
          <button type="button" class="fc-trace-jump-btn" data-sum-focus-tab="${escapeHtml(lk.toTab)}" data-sum-focus-key="${escapeHtml(lk.jumpKey || '')}">যান</button>
        </div>
      `).join('')}
    `;
    const btnScanSum = body.querySelector('#fc-sum-scan-btn');
    if (btnScanSum && btnScanSum.parentElement) {
      btnScanSum.parentElement.parentElement.insertBefore(traceCard, btnScanSum.parentElement);
    } else {
      body.appendChild(traceCard);
    }
    const openTraceBtn = traceCard.querySelector('#fc-sum-ext-trace-btn');
    if (openTraceBtn) openTraceBtn.onclick = () => { sm.style.display = 'none'; openTraceExplorerModal('all'); };
    const openLogsBtn = traceCard.querySelector('#fc-sum-ext-logs-btn');
    if (openLogsBtn) openLogsBtn.onclick = () => { sm.style.display = 'none'; openTraceExplorerModal('logs'); };
    traceCard.querySelectorAll('[data-sum-focus-tab]').forEach(btn => {
      btn.addEventListener('click', async () => {
        sm.style.display = 'none';
        const t = btn.getAttribute('data-sum-focus-tab');
        const k = btn.getAttribute('data-sum-focus-key') || '';
        if (k) await focusPortalField(t, [k]);
        else if (typeof jumpToPortalSection === 'function') jumpToPortalSection(t);
      });
    });

    body.querySelector('#fc-sum-scan-btn').onclick = () => {
      sm.style.display = 'none';
      openMemberScanner(null, 'auto');
    };

    sm.style.display = 'flex';
  }

  let lastSummaryUpdateAt = 0;

  function updateSummaryBadge(force = false, precomputed = null) {
    const summaryBtn = document.getElementById('fc-summary-btn');
    if (!summaryBtn) return;
    const now = Date.now();
    if (!force && !precomputed && now - lastSummaryUpdateAt < 1800) return;
    lastSummaryUpdateAt = now;
    const s = precomputed || collectFullFamilyCardSummary();
    const label = `📊 সারসংক্ষেপ (${toBnDigits(s.readinessPct)}%)`;
    const cls = (s.readinessPct >= 85 && s.blockers.length === 0) ? 'ready' : (s.blockers.length > 0 ? 'warn' : '');
    if (summaryBtn.dataset.lastLabel !== label) {
      summaryBtn.dataset.lastLabel = label;
      summaryBtn.innerHTML = `<span>${label}</span>`;
    }
    if (summaryBtn.className !== cls) summaryBtn.className = cls;
  }

  // Auto-fill Step 2 (ব্যক্তিগত তথ্য) and Sections 3-9 safely with debounced MutationObserver
  function setupStepObserver() {
    function runExtensionAutomations() {
      if (document.hidden || activeMediaStream) return;

      const curFid = scrapeFamilyId() || '';
      if (curFid) {
        if (!lastExtractedData || (lastExtractedData.family_id && lastExtractedData.family_id !== curFid)) {
          const cachedForFamily = getCachedFamilyScan(curFid, false);
          if (cachedForFamily) {
            lastExtractedData = cachedForFamily;
            updateWidgetPreview(cachedForFamily);
          }
        }
      }

      const tab1 = document.querySelector('[data-family-card-tab="1"]');
      const isTab1Visible = Boolean(tab1 && isPanelActiveVisible(tab1));
      if (isTab1Visible) {
        injectSection2Toolbar(tab1);
        if (lastExtractedData && !isFillingFormFields && (!lastExtractedData.family_id || !curFid || lastExtractedData.family_id === curFid)) {
          const { docNumber } = resolveDocNumberAndType(lastExtractedData);
          const stepSig = `${curFid}_${docNumber || ''}`;
          if (window.__fcStep1FilledKey !== stepSig) {
            fillFormFields(lastExtractedData, { overwriteExisting: false }).then((ok) => {
              if (ok && window.__fcStep1FilledKey === stepSig) {
                injectSection2Toolbar(tab1);
                showToast('✅ স্টেপ ২: পিতা-মাতা, বৈবাহিক অবস্থা ও ধর্ম অটো-ফিল করা হয়েছে!');
              }
            });
          }
        }
      }
      traceSection3Media();
      handleSection4Address();
      handleSection5AndCrossMatch();
      handleSection6Bank();
      handleSection7Eligibility();
      handleSection8Members();
      handleSection9MoneyUsage();
      handleSection11Consent();
      updateSummaryBadge(false);
    }

    let observerTimer = null;
    const observer = new MutationObserver((mutations) => {
      const hasPortalMutation = mutations.some(m => {
        const t = m.target;
        return t && t.nodeType === 1 && !t.closest('[id^="fc-"], [class*="fc-"], .fc-card-scan-btn, .v-ripple__container, .v-ripple__animation');
      });
      if (!hasPortalMutation) return;
      clearTimeout(observerTimer);
      observerTimer = setTimeout(runExtensionAutomations, 250);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });

    setTimeout(runExtensionAutomations, 60);
    setInterval(runExtensionAutomations, 2500);

    document.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('#fc-trace-btn')) {
        openTraceExplorerModal('all');
        return;
      }
      const stepItem = e.target.closest('.family-card-form-step, .v-expansion-panel-header, .v-list-item');
      if (stepItem && lastExtractedData) {
        setTimeout(() => {
          runExtensionAutomations();
        }, 300);
      }
    });
  }

  setupStepObserver();

  let _fcExtProgTimer = null;
  let _fcExtProgStart = 0;

  function updateExtModalProgress(pct, stageText = '', headlineText = '') {
    const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    const loadBox = document.getElementById('fc-modal-loading');
    const txtEl = document.getElementById('fc-modal-loading-text') || (loadBox && loadBox.querySelector('p'));
    const fillEl = document.getElementById('fc-modal-progress-fill');
    const stageEl = document.getElementById('fc-modal-progress-stage');
    const pctEl = document.getElementById('fc-modal-progress-pct');
    const sec = _fcExtProgStart ? Math.max(0, Math.round((Date.now() - _fcExtProgStart) / 1000)) : 0;
    if (txtEl) txtEl.textContent = headlineText || `AI দিয়ে ডকুমেন্ট বিশ্লেষণ চলছে... (${toBnDigits(p)}%)`;
    if (fillEl) fillEl.style.width = `${p}%`;
    if (stageEl && stageText) stageEl.textContent = `ধাপ: ${stageText}`;
    if (pctEl) pctEl.textContent = `${p}% • ${sec}s`;
  }

  function startExtModalProgress(headline = 'AI দিয়ে ডকুমেন্ট বিশ্লেষণ চলছে...') {
    if (_fcExtProgTimer) { clearInterval(_fcExtProgTimer); _fcExtProgTimer = null; }
    _fcExtProgStart = Date.now();
    let pct = 10;
    updateExtModalProgress(pct, 'ছবি প্রস্তুত হচ্ছে', `${headline} (১০%)`);
    _fcExtProgTimer = setInterval(() => {
      if (pct < 86) {
        pct = Math.min(86, pct + (pct < 40 ? 8 : pct < 70 ? 5 : 2));
        const st = pct < 35 ? 'ব্যাকগ্রাউন্ড OCR-এ ছবি পাঠানো হচ্ছে'
          : pct < 65 ? 'AI বাংলা ও ইংরেজি তথ্য পড়ছে'
            : 'জন্ম সনদ ইংরেজি সমন্বয় ও যাচাই';
        updateExtModalProgress(pct, st, `${headline} (${toBnDigits(pct)}%)`);
      } else {
        updateExtModalProgress(pct);
      }
    }, 600);
  }

  function stopExtModalProgress(finalPct = 100, stage = 'সম্পন্ন!') {
    if (_fcExtProgTimer) { clearInterval(_fcExtProgTimer); _fcExtProgTimer = null; }
    updateExtModalProgress(finalPct, stage);
  }

  // Listen for messages from extension popup & background progress events
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      if (req.action === 'ocr_progress') {
        updateExtModalProgress(req.pct, req.stage || '');
        return false;
      }
      if (req.action === 'config_updated') {
        serverUrl = req.serverUrl || serverUrl;
        const prevRoom = roomCode;
        roomCode = normalizeRoomCode(req.roomCode || roomCode);
        if (req.deviceName) myDeviceName = req.deviceName;
        localStorage.setItem('fc_room_code', roomCode);
        localStorage.setItem('fc_device_name', myDeviceName);
        geminiApiKey = req.geminiApiKey !== undefined ? req.geminiApiKey : geminiApiKey;
        deepseekApiKey = req.deepseekApiKey !== undefined ? req.deepseekApiKey : deepseekApiKey;
        aiProvider = req.aiProvider || aiProvider;
        defaultKeySlot = req.defaultKeySlot || defaultKeySlot;
        geminiModel = req.geminiModel || geminiModel;
        deepseekModel = req.deepseekModel || deepseekModel;
        const modalProv = document.getElementById('fc-modal-ai-provider');
        if (modalProv) modalProv.value = aiProvider;
        const modalKey = document.getElementById('fc-modal-default-key');
        if (modalKey) modalKey.value = defaultKeySlot;
        const modalGem = document.getElementById('fc-modal-gemini-model');
        if (modalGem) modalGem.value = geminiModel;
        const modalDs = document.getElementById('fc-modal-deepseek-model');
        if (modalDs) modalDs.value = deepseekModel;
        if (req.s5MfsAccount !== undefined || req.s5Training !== undefined || req.s5TransCount !== undefined || req.s5AbroadDefault !== undefined || req.s5AutoFill !== undefined) {
          saveSection5Config({
            _fromPopup: true,
            ...(req.s5MfsAccount !== undefined ? { mfsAccount: req.s5MfsAccount } : {}),
            ...(req.s5Training !== undefined ? { training: req.s5Training } : {}),
            ...(req.s5TransCount !== undefined ? { transCount: req.s5TransCount } : {}),
            ...(req.s5AbroadDefault !== undefined ? { abroadDefault: req.s5AbroadDefault } : {}),
            ...(req.s5AutoFill !== undefined ? { autoFill: req.s5AutoFill } : {})
          });
          if (typeof autoFillSection5Defaults === 'function') autoFillSection5Defaults({ force: true });
        }
        if (typeof window.__fcRenderModalCostCard === 'function') window.__fcRenderModalCostCard();
        const roomEl = document.getElementById('fc-ui-room');
        if (roomEl) roomEl.textContent = roomCode;
        const chatRoomInp = document.getElementById('fc-chat-room-input');
        if (chatRoomInp) chatRoomInp.value = roomCode;
        const chatNameInp = document.getElementById('fc-chat-device-name');
        if (chatNameInp) chatNameInp.value = myDeviceName;
        if (prevRoom !== roomCode) {
          roomMsgMap.clear();
          lastRoomMetaSig = '';
          lastRoomClearedMs = 0;
          roomBootstrapped = false;
          renderChatFeed();
          fetchRoomMessages(true);
        }
        if (socket) {
          socket.disconnect();
          connectSocket();
        }
        sendResponse({ success: true });
      }
    });
  }
})();
