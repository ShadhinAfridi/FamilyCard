// Family Card NID AI Auto-Filler Bookmarklet (v2.0.0)
// Features:
// 1. Strict Bengali-to-English numeral & Unicode normalization (০-৯ -> 0-9, ড়/য়/ঢ় canonicalization)
// 2. Zero-reflow DOM tracing + visibility-gated automations + throttled summary telemetry
// 3. Step 1-2 (যাচাইকরণ ও ব্যক্তিগত তথ্য) intelligent caching, edit guards, & Firestore cloud sync
// 4. Tabbed mobile/tablet Booklet UI with collapsible dock, CR80/A4 crop camera, & room messenger
(function () {
  'use strict';

  if (window.__familyCardAssistantLoaded) {
    if (typeof window.__fcOpenModal === 'function') {
      window.__fcOpenModal();
      return;
    }
    const existingModal = document.getElementById('fc-bm-modal');
    if (existingModal) {
      existingModal.style.display = 'flex';
      return;
    }
  }
  window.__familyCardAssistantLoaded = true;

  console.log('[FamilyCard Assistant v2.0.0] Initializing on target portal...');

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
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\u09A1\u09BC/g, '\u09DC')
      .replace(/\u09A2\u09BC/g, '\u09DD')
      .replace(/\u09AF\u09BC/g, '\u09DF')
      .replace(/\s+/g, ' ')
      .trim();
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
    const ng = normalizeBn(g);
    if (GENDER_ALIAS_MAP[ng]) return GENDER_ALIAS_MAP[ng];
    if (GENDER_ALIAS_MAP[g]) return GENDER_ALIAS_MAP[g];
    const low = g.toLowerCase();
    if (GENDER_ALIAS_MAP[low]) return GENDER_ALIAS_MAP[low];
    if (/নারী|মহিলা|female/i.test(g)) return 'নারী';
    if (/পুরুষ|male/i.test(g)) return 'পুরুষ';
    if (/হিজ|তৃতীয়|তৃতীয়|third|hijra/i.test(g)) return 'হিজড়া';
    return ng;
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
          const afterC = bare[i] || '';
          if (!kars[afterC] && afterC !== '্' && afterC !== 'ং' && afterC !== 'ঃ' && i < bare.length && cons[afterC]) { out += 'A'; lastWasVowel = true; } else { lastWasVowel = false; }
          continue;
        }
        lastConsStartIdx = i;
        out += (ch === 'য' && i > 0) ? 'J' : cons[ch];
        const nextCh = bare[i + 1] || '';
        if (!kars[nextCh] && nextCh !== '্' && nextCh !== 'ং' && nextCh !== 'ঃ' && ch !== 'ৎ') {
          const afterN = bare[i + 2] || '';
          const addA =
            i + 1 < bare.length &&
            (cons[nextCh] || (!indVowels[nextCh] && i + 2 < bare.length)) &&
            !(nextCh === 'ম' && !afterN && bare[i] !== 'ত' && out.length > 2) &&
            !(lastWasVowel === false && i > 1 && !kars[bare[i - 1]]);
          if (addA) { out += 'A'; lastWasVowel = true; } else { lastWasVowel = false; }
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
    if (!hasBengaliScript(cleaned)) return (typeof normalizeDigits === 'function' ? normalizeDigits(cleaned) : cleaned).toUpperCase().replace(/\s+/g, ' ').trim();

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

  const FC_FIELD_SPECS = {
    docNid: {
      keys: ['আবেদনকারীর জাতীয় পরিচয়পত্র নম্বর', 'জাতীয় পরিচিতি নম্বর (এনআইডি)', 'জাতীয় পরিচিতি নম্বর (এনআইডি)', 'জাতীয় পরিচিতি নম্বর', 'জাতীয় পরিচিতি নম্বর', 'জাতীয় পরিচয়পত্র নম্বর', 'জাতীয় পরিচয়পত্র নম্বর', 'পরিচিতি নম্বর (এনআইডি)', 'এনআইডি নম্বর', 'পরিচিতি নম্বর', 'nid number', 'national id'],
      exclude: ['পিতা', 'মাতা', 'স্বামী', 'স্ত্রী', 'নমিনী', 'নমিনি', 'জন্ম নিবন্ধন', 'রেফারেন্স', 'ক্রমিক', 'father', 'mother', 'spouse', 'nominee', 'reference', 'serial']
    },
    docBrc: {
      keys: ['আবেদনকারীর জন্ম নিবন্ধন নম্বর', 'জন্ম নিবন্ধন নম্বর', 'জন্ম নিবন্ধন নং', 'নিবন্ধন নম্বর', 'জন্ম নিবন্ধন', 'birth registration number', 'birth reg'],
      exclude: ['পিতা', 'মাতা', 'স্বামী', 'স্ত্রী', 'নমিনী', 'নমিনি', 'তারিখ', 'এনআইডি', 'রেফারেন্স', 'ক্রমিক', 'father', 'mother', 'spouse', 'nominee', 'date', 'reference', 'serial']
    },
    nameBn: {
      keys: ['আবেদনকারীর নাম (বাংলা)', 'আবেদনকারীর নাম বাংলায়', 'আবেদনকারীর নাম বাংলায়', 'সম্পূর্ণ নাম (বাংলা)', 'পূর্ণ নাম (বাংলা)', 'নাম বাংলায়', 'নাম বাংলায়', 'নাম (বাংলা)'],
      exclude: ['পিতা', 'মাতা', 'স্বামী', 'স্ত্রী', 'নমিনী', 'নমিনি', 'ইংরেজি', 'english', 'father', 'mother', 'spouse', 'nominee']
    },
    nameEn: {
      keys: ['আবেদনকারীর নাম (ইংরেজি)', 'আবেদনকারীর নাম ইংরেজিতে', 'সম্পূর্ণ নাম (ইংরেজি)', 'পূর্ণ নাম (ইংরেজি)', 'নাম ইংরেজিতে', 'নাম (ইংরেজি)'],
      exclude: ['পিতা', 'মাতা', 'স্বামী', 'স্ত্রী', 'নমিনী', 'নমিনি', 'বাংলা', 'bangla', 'father', 'mother', 'spouse', 'nominee']
    },
    fatherBn: {
      keys: ['পিতার নাম (বাংলা)', 'পিতার নাম বাংলায়', 'পিতার নাম বাংলায়', 'পিতার নাম(বাংলা)', 'পিতা (বাংলা)', 'পিতার বাংলা নাম', 'পিতার নাম', 'father name bangla', "father's name (bangla)"],
      exclude: ['ইংরেজি', 'english', 'এনআইডি', 'nid', 'পরিচিতি', 'নিবন্ধন', 'বয়স', 'বয়স', 'পেশা', 'আয়', 'আয়', 'মোবাইল', 'মাতা', 'mother', 'স্বামী', 'স্ত্রী', 'spouse']
    },
    fatherEn: {
      keys: ['পিতার নাম (ইংরেজি)', 'পিতার নাম ইংরেজিতে', 'পিতার নাম(ইংরেজি)', 'পিতা (ইংরেজি)', 'পিতার ইংরেজি নাম', "father's name (english)", 'father name english', 'father name'],
      exclude: ['বাংলা', 'bangla', 'এনআইডি', 'nid', 'পরিচিতি', 'নিবন্ধন', 'বয়স', 'বয়স', 'মাতা', 'mother']
    },
    motherBn: {
      keys: ['মাতার নাম (বাংলা)', 'মাতার নাম বাংলায়', 'মাতার নাম বাংলায়', 'মাতার নাম(বাংলা)', 'মাতা (বাংলা)', 'মাতার বাংলা নাম', 'মাতার নাম', 'mother name bangla', "mother's name (bangla)"],
      exclude: ['ইংরেজি', 'english', 'এনআইডি', 'nid', 'পরিচিতি', 'নিবন্ধন', 'বয়স', 'বয়স', 'পেশা', 'আয়', 'আয়', 'মোবাইল', 'পিতা', 'father', 'স্বামী', 'স্ত্রী', 'spouse']
    },
    motherEn: {
      keys: ['মাতার নাম (ইংরেজি)', 'মাতার নাম ইংরেজিতে', 'মাতার নাম(ইংরেজি)', 'মাতা (ইংরেজি)', 'মাতার ইংরেজি নাম', "mother's name (english)", 'mother name english', 'mother name'],
      exclude: ['বাংলা', 'bangla', 'এনআইডি', 'nid', 'পরিচিতি', 'নিবন্ধন', 'বয়স', 'বয়স', 'পিতা', 'father']
    },
    spouseBn: {
      keys: ['স্বামীর নাম (বাংলা)', 'স্ত্রীর নাম (বাংলা)', 'স্বামী/স্ত্রীর নাম (বাংলা)', 'স্বামী বা স্ত্রীর নাম (বাংলা)', 'স্বামীর নাম', 'স্ত্রীর নাম', 'স্বামী/স্ত্রীর নাম'],
      exclude: ['ইংরেজি', 'english', 'এনআইডি', 'nid', 'পরিচিতি']
    },
    spouseEn: {
      keys: ['স্বামীর নাম (ইংরেজি)', 'স্ত্রীর নাম (ইংরেজি)', 'স্বামী/স্ত্রীর নাম (ইংরেজি)', 'স্বামী বা স্ত্রীর নাম (ইংরেজি)'],
      exclude: ['বাংলা', 'bangla', 'এনআইডি', 'nid', 'পরিচিতি']
    },
    dob: {
      keys: ['জন্ম তারিখ', 'জন্মতারিখ', 'date of birth'],
      exclude: ['নিবন্ধন', 'প্রদান', 'registration', 'issue']
    },
    mobile: {
      keys: ['মোবাইল নম্বর', 'মোবাইল নং', 'মোবাইল', 'mobile number', 'mobile'],
      exclude: ['জরুরি', 'বিকল্প', 'নমিনী', 'নমিনি', 'পিতা', 'মাতা']
    }
  };

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

  function parseOcrJsonText(rawInput) {
    if (Array.isArray(rawInput)) {
      rawInput = rawInput.map(p => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('\n');
    } else if (rawInput && typeof rawInput === 'object') {
      return normalizeOcrKeyAliases(rawInput);
    }
    const raw = String(rawInput || '')
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

  const FC_ERROR_LOGS_KEY = 'fc_error_logs';
  const FIRESTORE_ERROR_LOGS_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/fc_error_logs';
  const FIRESTORE_LOG_CHANNEL_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/room_channels/FC_SYSTEM_LOGS/messages';
  let __fcLogFallbackChannelOnly = false;
  const __fcRecentLogDedup = new Map();

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
    if (typeof renderBmLogList === 'function') {
      try { renderBmLogList(); } catch (_) {}
    }
  }

  async function fcLogTelemetry(level = 'error', stage = 'general', message = '', detail = '', extra = {}) {
    try {
      const msgStr = String(message || 'Unknown error').slice(0, 800);
      const stageStr = String(stage || 'general').slice(0, 80);
      const sig = `${level}|${stageStr}|${msgStr.slice(0, 140)}`;
      const nowMs = Date.now();
      const prevTs = __fcRecentLogDedup.get(sig) || 0;
      if (nowMs - prevTs < 2500) return null;
      __fcRecentLogDedup.set(sig, nowMs);
      if (__fcRecentLogDedup.size > 40) {
        const oldestKey = __fcRecentLogDedup.keys().next().value;
        __fcRecentLogDedup.delete(oldestKey);
      }
      const fid = (typeof scrapeFamilyId === 'function' ? scrapeFamilyId() : '') || extra.familyId || '';
      const entry = {
        id: `bmlog_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
        source: 'bookmarklet',
        level: String(level || 'error').slice(0, 20),
        stage: stageStr,
        message: msgStr,
        detail: String(detail || '').slice(0, 1200),
        model: String(extra.model || '').slice(0, 80),
        familyId: String(fid || '').slice(0, 40),
        url: String((typeof location !== 'undefined' && location.href) || '').slice(0, 200),
        ts: nowMs,
        createdAt: new Date(nowMs).toISOString(),
        synced: false
      };
      const cur = getLocalErrorLogs();
      cur.unshift(entry);
      if (cur.length > 50) cur.length = 50;
      try { localStorage.setItem(FC_ERROR_LOGS_KEY, JSON.stringify(cur)); } catch (_) {}
      if (typeof renderBmLogList === 'function') {
        try { renderBmLogList(); } catch (_) {}
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
        if (!__fcLogFallbackChannelOnly) {
          const res = await fetch(`${FIRESTORE_ERROR_LOGS_BASE}/${encodeURIComponent(entry.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields })
          }).catch(() => null);
          if (res && res.ok) synced = true;
          else if (res && res.status === 403) __fcLogFallbackChannelOnly = true;
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
                senderName: { stringValue: 'Bookmarklet-Telemetry' },
                senderClient: { stringValue: 'bookmarklet' },
                senderId: { stringValue: entry.familyId || 'bm' },
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
          if (typeof renderBmLogList === 'function') {
            try { renderBmLogList(); } catch (_) {}
          }
        }
      }
      return entry;
    } catch (_) {
      return null;
    }
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !window.__fcTelemetryListenersBound) {
    window.__fcTelemetryListenersBound = true;
    window.addEventListener('error', (ev) => {
      const stack = (ev?.error && ev.error.stack) ? ` | ${String(ev.error.stack).slice(0, 700)}` : '';
      fcLogTelemetry('error', 'window.onerror', ev?.message || 'Unhandled script error', `${ev?.filename || ''}:${ev?.lineno || ''}:${ev?.colno || ''}${stack}`);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev?.reason;
      const stack = (reason && typeof reason === 'object' && reason.stack) ? String(reason.stack).slice(0, 700) : '';
      fcLogTelemetry('error', 'unhandledrejection', (reason && reason.message) || String(reason || 'Promise rejection'), stack);
    });
  }

  const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
  const INTERACTIONS_API_MODELS = new Set(['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon']);
  if (!localStorage.getItem('fc_model_default_v2')) {
    const prevGem = localStorage.getItem('fc_gemini_model');
    if (!prevGem || prevGem === 'gemini-3.1-flash-lite') {
      localStorage.setItem('fc_gemini_model', DEFAULT_GEMINI_MODEL);
    }
    localStorage.setItem('fc_model_default_v2', '1');
  }

  let lastExtractedData = null;
  let savedApiKey = localStorage.getItem('fc_gemini_api_key') || '';
  let savedDeepSeekKey = localStorage.getItem('fc_deepseek_api_key') || '';
  let savedAiProvider = localStorage.getItem('fc_ai_provider') || 'economy';
  let savedDefaultKeySlot = localStorage.getItem('fc_default_key_slot') || 'auto';
  let savedGeminiModel = localStorage.getItem('fc_gemini_model') || DEFAULT_GEMINI_MODEL;
  let savedDeepSeekModel = localStorage.getItem('fc_deepseek_model') || 'deepseek-flash';
  let activeMediaStream = null;
  let savedPostcode = localStorage.getItem('fc_default_postcode') || '7721';
  let savedVillageList = safeJsonParse(localStorage.getItem('fc_village_list'), ['বসাকুষ্টিয়া', 'চর কলিমহর']);
  if (!Array.isArray(savedVillageList) || savedVillageList.length === 0) {
    savedVillageList = ['বসাকুষ্টিয়া', 'চর কলিমহর'];
  }
  let savedDefaultVillage = localStorage.getItem('fc_default_village') || savedVillageList[0] || 'বসাকুষ্টিয়া';

  const BDT_PER_USD = 122;
  const AI_MODEL_CATALOG = {
    'gemini-3.1-flash-lite': { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', provider: 'gemini', inputPer1M: 0.25, outputPer1M: 1.50, cacheReadPer1M: 0.025, rpm: '4K', rpd: '150K', estPer1kUsd: 0.78 },
    'gemini-3.5-flash-lite': { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', provider: 'gemini', inputPer1M: 0.30, outputPer1M: 2.50, cacheReadPer1M: 0.03, rpm: '4K', rpd: '150K', estPer1kUsd: 1.11 },
    'gemini-3.8-flash': { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'gemini', inputPer1M: 0.75, outputPer1M: 3.75, cacheReadPer1M: 0.075, stdInputPer1M: 1.50, stdOutputPer1M: 7.50, stdCacheReadPer1M: 0.15, introUntilUtcMs: Date.UTC(2027, 0, 1), rpm: '1K', rpd: '10K', estPer1kUsd: 2.53 },
    'gemini-4-argon': { id: 'gemini-4-argon', label: 'Gemini 4 Argon', provider: 'gemini', inputPer1M: 2.00, outputPer1M: 10.00, cacheReadPer1M: 0.10, stdInputPer1M: 4.00, stdOutputPer1M: 20.00, stdCacheReadPer1M: 0.20, introUntilUtcMs: Date.UTC(2026, 11, 1), rpm: '500', rpd: '5K', estPer1kUsd: 6.50 },
    'deepseek-flash': { id: 'deepseek-flash', label: 'DeepSeek Flash', provider: 'deepseek', offPeakInPer1M: 0.15, offPeakOutPer1M: 0.60, offPeakCachePer1M: 0.003, peakInPer1M: 0.30, peakOutPer1M: 1.20, peakCachePer1M: 0.006, rpm: 'Uncapped', rpd: 'Balance', estPer1kUsd: 0.38 }
  };

  function isDeepSeekPeakUtc(nowMs = Date.now()) {
    const d = new Date(nowMs);
    const day = d.getUTCDay();
    if (day < 1 || day > 5) return false;
    const h = d.getUTCHours();
    return (h >= 1 && h < 4) || (h >= 6 && h < 10);
  }

  function normalizeModelId(modelId) {
    const raw = String(modelId || '').toLowerCase();
    if (raw.includes('deepseek')) return 'deepseek-flash';
    if (raw.includes('4-argon') || raw.includes('argon')) return 'gemini-4-argon';
    if (raw.includes('3.8-flash') || raw.includes('3.8')) return 'gemini-3.8-flash';
    if (raw.includes('3.1-flash-lite') || raw.includes('3.1')) return 'gemini-3.1-flash-lite';
    return DEFAULT_GEMINI_MODEL;
  }

  function computeScanUsageAndCost(modelId, rawApiRes = {}, nowMs = Date.now()) {
    const key = normalizeModelId(modelId);
    const spec = AI_MODEL_CATALOG[key] || AI_MODEL_CATALOG[DEFAULT_GEMINI_MODEL];
    let inputTokens = 0, cachedTokens = 0, outputTokens = 0, estimated = false;

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
        model: key, label: spec.label, provider: 'deepseek', tierWindow: peak ? 'peak' : 'off_peak',
        inputTokens, cachedTokens, uncachedInputTokens: uncachedIn, outputTokens,
        totalTokens: inputTokens + outputTokens, estimated,
        inputRatePer1M: inRate, outputRatePer1M: outRate, cacheRatePer1M: cacheRate,
        estPer1kUsd: peak ? 0.76 : spec.estPer1kUsd,
        costUsd: Number(costUsd.toFixed(7)), costBdt: Number((costUsd * BDT_PER_USD).toFixed(4))
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
      model: key, label: spec.label, provider: 'gemini',
      tierWindow: hasStdRates ? (isIntro ? 'intro_2026' : 'standard') : 'tier1',
      inputTokens, cachedTokens, uncachedInputTokens: uncachedIn, outputTokens,
      totalTokens: inputTokens + outputTokens, estimated,
      inputRatePer1M: inRate, outputRatePer1M: outRate, cacheRatePer1M: cacheRate,
      estPer1kUsd: spec.estPer1kUsd,
      costUsd: Number(costUsd.toFixed(7)), costBdt: Number((costUsd * BDT_PER_USD).toFixed(4))
    };
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
    return stats;
  }

  // --- Utility: Bengali-to-English Digit Normalizer ---
  function normalizeDigits(str) {
    if (!str) return '';
    const bn = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
    return String(str).replace(/[০-৯]/g, d => {
      const idx = bn.indexOf(d);
      return idx !== -1 ? idx : d;
    });
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

  // --- Utility: Date of Birth Standardizer (English & Bengali months/digits/ordinals) to DD/MM/YYYY ---
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

    // ISO format: YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = str.match(/(?:^|\s)(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:\b|$)/);
    if (isoMatch) {
      const y = parseInt(isoMatch[1], 10);
      const m = parseInt(isoMatch[2], 10);
      const d = parseInt(isoMatch[3], 10);
      return isValidCalendarDate(d, m, y)
        ? `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
        : '';
    }

    // English month format: 15 Apr 1988 / Apr 15, 1988
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

    // Bengali month format: ১৪ মে ১৯৮৫ / ১২ই জানুয়ারি, ২০১২
    const bnPrefixes = [
      ['জানু', '01'], ['ফেব', '02'], ['মার', '03'], ['এপ্রি', '04'],
      ['মে', '05'], ['জুন', '06'], ['জুল', '07'], ['আগ', '08'],
      ['সেপ', '09'], ['অক্ট', '10'], ['অক', '10'], ['নভ', '11'], ['ডিস', '12']
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

    // Standard DD/MM/YYYY or DD-MM-YYYY with swapped MM/DD/YYYY fix
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

  // --- Utility: Zero-Reflow DOM Scraper for পরিবার আইডি ---
  let _cachedFidNode = null;
  let _cachedFidText = '';
  let _cachedFidVal = null;
  let _cachedFidTs = 0;

  function scrapeFamilyId(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && _cachedFidNode && _cachedFidNode.isConnected !== false && now - _cachedFidTs < 350) {
      return _cachedFidVal;
    }
    const idNode = (_cachedFidNode && _cachedFidNode.isConnected !== false)
      ? _cachedFidNode
      : document.querySelector('.family-card-draft-application-id, .fc-family-id-label');
    if (idNode) {
      const txt = idNode.textContent || '';
      if (!forceRefresh && txt === _cachedFidText && _cachedFidNode === idNode) {
        _cachedFidTs = now;
        return _cachedFidVal;
      }
      const m = txt.match(/পরিবার\s*আইডি:\s*([০-৯0-9]+)/) || txt.match(/([০-৯0-9]{4,})/);
      _cachedFidNode = idNode;
      _cachedFidText = txt;
      _cachedFidVal = m ? normalizeDigits(m[1]) : null;
      _cachedFidTs = now;
      return _cachedFidVal;
    }
    const scope = document.querySelector('.family-card-form-card, .family-card-page-root, form') || document.body;
    const text = scope?.textContent || '';
    const match = text.match(/পরিবার\s*আইডি:\s*([০-৯0-9]+)/);
    _cachedFidVal = match ? normalizeDigits(match[1]) : null;
    _cachedFidTs = now;
    return _cachedFidVal;
  }

  function getSafeFamilyDocId(data) {
    const rawId = scrapeFamilyId() || (data && data.family_id) || (lastExtractedData && lastExtractedData.family_id) || '';
    const cleanFamily = normalizeDigits(rawId).replace(/[^0-9A-Za-z_-]/g, '');
    if (cleanFamily) return cleanFamily;
    const fallbackDoc = data ? (data.nid_number || data.birth_reg_no || data.doc_number || '') : '';
    const cleanDoc = normalizeDigits(fallbackDoc).replace(/[^0-9A-Za-z_-]/g, '');
    return cleanDoc || null;
  }

  function normalizeMobileNumber(raw) {
    let digits = normalizeDigits(raw || '').replace(/[^0-9]/g, '');
    if (digits.length === 13 && digits.startsWith('8801')) digits = digits.slice(2);
    else if (digits.length === 12 && digits.startsWith('881')) digits = '0' + digits.slice(2);
    else if (digits.length === 10 && /^1[3-9]\d{8}$/.test(digits)) digits = '0' + digits;
    return digits;
  }

  function normalizeApplicantPayload(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const data = { ...raw };
    const cleanText = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const cleanUpper = (v) => cleanText(v).toUpperCase();

    if (data.name_bn) data.name_bn = normalizeBn(cleanText(data.name_bn));
    if (data.name_en) data.name_en = cleanUpper(data.name_en);
    if (data.father_name_bn) data.father_name_bn = normalizeBn(cleanText(data.father_name_bn));
    if (data.father_name_en) data.father_name_en = cleanUpper(data.father_name_en);
    if (data.mother_name_bn) data.mother_name_bn = normalizeBn(cleanText(data.mother_name_bn));
    if (data.mother_name_en) data.mother_name_en = cleanUpper(data.mother_name_en);
    if (data.spouse_name_bn) data.spouse_name_bn = normalizeBn(cleanText(data.spouse_name_bn));
    if (data.spouse_name_en) data.spouse_name_en = cleanUpper(data.spouse_name_en);

    for (const [bnK, enK] of [
      ['name_bn', 'name_en'],
      ['father_name_bn', 'father_name_en'],
      ['mother_name_bn', 'mother_name_en'],
      ['spouse_name_bn', 'spouse_name_en']
    ]) {
      let bnV = cleanText(data[bnK] || '');
      let enV = cleanText(data[enK] || '');
      if (bnV && !hasBengaliScript(bnV) && /[A-Za-z]/.test(bnV) && enV && hasBengaliScript(enV)) {
        data[bnK] = enV;
        data[enK] = bnV.toUpperCase();
        bnV = data[bnK];
        enV = data[enK];
      } else {
        if (!bnV && hasBengaliScript(enV)) {
          data[bnK] = enV;
          data[enK] = '';
          bnV = enV;
          enV = '';
        }
        if (bnV && !hasBengaliScript(bnV) && /[A-Za-z]/.test(bnV)) {
          if (!enV || hasBengaliScript(enV)) data[enK] = bnV.toUpperCase();
          data[bnK] = '';
          bnV = '';
        }
        if (enV && hasBengaliScript(enV)) {
          if (!bnV) data[bnK] = enV;
          data[enK] = '';
        }
      }
    }

    const spBnN = stripPersonPrefixes(data.spouse_name_bn || '');
    const ftBnN = stripPersonPrefixes(data.father_name_bn || '');
    const spEnN = stripPersonPrefixes(data.spouse_name_en || '');
    const ftEnN = stripPersonPrefixes(data.father_name_en || '');
    if ((spBnN && ftBnN && spBnN === ftBnN) || (spEnN && ftEnN && spEnN === ftEnN)) {
      data.father_name_bn = '';
      data.father_name_en = '';
    }

    for (const [bnK, enK] of [
      ['name_bn', 'name_en'],
      ['father_name_bn', 'father_name_en'],
      ['mother_name_bn', 'mother_name_en'],
      ['spouse_name_bn', 'spouse_name_en']
    ]) {
      const bnV = cleanText(data[bnK] || '');
      const enV = cleanText(data[enK] || '');
      if (bnV && (!enV || hasBengaliScript(enV))) {
        const tr = transliterateBnToEn(bnV);
        if (tr && !hasBengaliScript(tr)) {
          data[enK] = tr;
          data.auto_transliterated_en = true;
        }
      } else if (enV && (!bnV || !hasBengaliScript(bnV))) {
        const trBn = transliterateEnToBn(enV);
        if (trBn && hasBengaliScript(trBn)) {
          data[bnK] = trBn;
          data.auto_transliterated_bn = true;
        }
      }
    }
    for (const [bnK, enK] of [
      ['name_bn', 'name_en'],
      ['father_name_bn', 'father_name_en'],
      ['mother_name_bn', 'mother_name_en'],
      ['spouse_name_bn', 'spouse_name_en']
    ]) {
      if (data[enK]) data[enK] = normalizeEnglishHonorificPrefix(data[enK], data[bnK]);
    }
    if (data.dob) data.dob = standardizeDate(data.dob);
    if (data.gender) data.gender = normalizeGenderValue(data.gender);
    if (data.mobile_number) data.mobile_number = normalizeMobileNumber(data.mobile_number);
    if (!data.marital_status && data.marital_status_suggestion) {
      data.marital_status = cleanText(data.marital_status_suggestion);
    }

    const { docType, docNumber } = resolveDocNumberAndType(data);
    data.doc_type = docType;
    if (docNumber) {
      data.doc_number = docNumber;
      if (docType === 'birth_certificate') {
        data.birth_reg_no = docNumber;
        data.nid_number = '';
      } else {
        data.nid_number = docNumber;
        data.birth_reg_no = '';
      }
    }
    const fam = normalizeDigits(data.family_id || scrapeFamilyId() || '').replace(/[^0-9]/g, '');
    if (fam) data.family_id = fam;
    return data;
  }

  const SCAN_CACHE_KEY = 'fc_scan_cache_v1';

  function cacheFamilyScan(data) {
    const clean = normalizeApplicantPayload(data);
    if (!clean) return;
    try {
      const store = safeJsonParse(localStorage.getItem(SCAN_CACHE_KEY), {});
      const cache = (store && typeof store === 'object') ? store : {};
      const entry = {
        doc_type: clean.doc_type || 'nid',
        doc_number: clean.doc_number || '',
        nid_number: clean.nid_number || '',
        birth_reg_no: clean.birth_reg_no || '',
        name_bn: clean.name_bn || '',
        name_en: clean.name_en || '',
        dob: clean.dob || '',
        gender: clean.gender || '',
        father_name_bn: clean.father_name_bn || '',
        father_name_en: clean.father_name_en || '',
        mother_name_bn: clean.mother_name_bn || '',
        mother_name_en: clean.mother_name_en || '',
        spouse_name_bn: clean.spouse_name_bn || '',
        spouse_name_en: clean.spouse_name_en || '',
        marital_status: clean.marital_status || clean.marital_status_suggestion || '',
        religion: clean.religion || '',
        mobile_number: clean.mobile_number || '',
        family_id: clean.family_id || '',
        ocr_model_used: clean.ocr_model_used || '',
        cached_at: Date.now()
      };
      if (entry.family_id) cache[entry.family_id] = entry;
      cache.__latest = entry;
      const entries = Object.entries(cache).filter(([k]) => k !== '__latest');
      if (entries.length > 20) {
        entries.sort((a, b) => (b[1]?.cached_at || 0) - (a[1]?.cached_at || 0));
        const trimmed = { __latest: entry };
        entries.slice(0, 20).forEach(([k, v]) => { trimmed[k] = v; });
        localStorage.setItem(SCAN_CACHE_KEY, JSON.stringify(trimmed));
      } else {
        localStorage.setItem(SCAN_CACHE_KEY, JSON.stringify(cache));
      }
    } catch (_) {}
  }

  function getCachedFamilyScan(familyId = null, allowLatestFallback = false) {
    try {
      const cache = safeJsonParse(localStorage.getItem(SCAN_CACHE_KEY), {});
      if (!cache || typeof cache !== 'object') return null;
      const fid = normalizeDigits(familyId || scrapeFamilyId() || '').replace(/[^0-9]/g, '');
      if (fid && cache[fid]) return cache[fid];
      if (!fid || allowLatestFallback) {
        const latest = cache.__latest;
        if (latest && (!fid || !latest.family_id || latest.family_id === fid || allowLatestFallback)) {
          return latest;
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  async function fetchFirestoreApplicant(familyId) {
    const fid = normalizeDigits(familyId || scrapeFamilyId() || '').replace(/[^0-9]/g, '');
    if (!fid) return null;
    try {
      const res = await fetch(
        `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(fid)}`,
        { cache: 'no-store' }
      );
      if (!res.ok) return null;
      const doc = await res.json().catch(() => null);
      const f = doc?.fields;
      if (!f) return null;
      const str = (k) => f[k]?.stringValue || '';
      const loaded = normalizeApplicantPayload({
        family_id: fid,
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
        marital_status: str('marital_status'),
        religion: str('religion'),
        mobile_number: str('mobile_number'),
        ocr_model_used: str('ocr_model_used') || 'cloud'
      });
      if (loaded) cacheFamilyScan(loaded);
      return loaded;
    } catch (_) {
      return null;
    }
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
   - Set "detected_language" strictly to "bilingual", "bn_only", "en_only", or "unknown".
   - NEVER put Bengali characters inside *_en fields, NEVER put English letters inside *_bn fields.
3. STRICT CHARACTER, DIGIT & JUKTOBORNO (যুক্তবর্ণ) ACCURACY:
   - Accurately recognize and preserve ALL Bangla vowels (স্বরবর্ণ: অ, আ, ই, ঈ, উ, ঊ, ঋ, এ, ঐ, ও, ঔ), consonants (ব্যঞ্জনবর্ণ: ক–হ, ড়, ঢ়, য়), diacritics/signs (কার: া ি ী ু ূ ৃ ে ৈ ো ৌ; ফলা: ্য ্র ্ব ্ল ্ম ্ন ্ণ; রেফ: র্; ং ঃ ঁ ৎ), Bangla digits (০–৯), English alphanumerics (A–Z, 0–9), and complex Bangla conjunct consonants (যুক্তবর্ণ: ক্ষ, ক্ষ্ম, জ্ঞ, ঞ্জ, ঞ্চ, ঞ্ছ, ঙ্গ, ঙ্ক, ঙ্ঘ, হ্ম, ত্ত, ত্র, দ্দ, দ্ধ, দ্র, ব্দ, শ্র, প্র, স্ত, স্থ, স্প, স্ম, স্ব, স্ত্র, ন্ত্র, ন্দ্র, ক্ত, ষ্ট, ষ্ঠ, ষ্ণ, ণ্ড, ন্ড, ন্ত, ন্দ, ন্ধ, ন্ন, ন্স, ম্প, ম্ব, ম্ভ, ম্ম, ল্ল, ল্প, শ্চ, চ্ছ, জ্জ, ট্ট, ত্ম, দ্ভ) without breaking or substituting characters.
   - Always use standard phonetic transliteration (NEVER literal meaning translation) for personal names, villages, and addresses.
4. DOCUMENT NUMBERS, DATES, GENDER & SPOUSE:
   - Birth Registration Certificates: strictly 17 digits starting with the 4-digit birth year (YYYY...). Put Father's/Mother's NID ONLY into "father_nid" and "mother_nid", NEVER into "birth_reg_no"/"doc_number".
   - NID Cards: 10 digits (Smart NID) or 13/17 digits (Classic NID). Extract ONLY clearly visible digits; NEVER pad or guess missing digits.
   - Extract "dob" strictly in DD/MM/YYYY ASCII digits. On Birth Certificates, extract "জন্ম তারিখ / Date of Birth" into "dob", and extract "নিবন্ধনের তারিখ / Date of Registration" into "registration_date" (NEVER put registration date into "dob").
   - Set "gender" to "পুরুষ", "নারী", or "হিজড়া" ONLY if printed or clearly evident; otherwise return "".
   - If classic laminated NID prints "স্বামী:" (Husband), put that name into "spouse_name_bn" (and "spouse_name_en" only if printed). NEVER copy husband's name into father fields!
   - Leave "relation_suggestion" and "marital_status_suggestion" as "" unless directly evidenced on the document (e.g. "স্বামী:" implies "বিবাহিত").
   - "confidence": "low" if blurry/glare/cropped/uncertain digits; "medium" if minor uncertainty; "high" if crystal clear.

Return ONLY a single valid JSON object with keys: doc_type, detected_language, doc_number, nid_number, birth_reg_no, father_nid, mother_nid, registration_date, name_bn, name_en, dob, gender, father_name_bn, father_name_en, mother_name_bn, mother_name_en, spouse_name_bn, spouse_name_en, relation_suggestion, marital_status_suggestion, confidence.
`;
  }

  // Inject Styles once
  if (!document.getElementById('fc-bm-styles')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'fc-bm-styles';
  styleEl.textContent = `
    #fc-bm-dock {
      position: fixed; bottom: 14px; right: 12px; z-index: 9999999;
      display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px;
      max-width: calc(100vw - 24px); padding: 5px 6px;
      background: rgba(15, 23, 42, 0.84); backdrop-filter: blur(8px);
      border: 1px solid rgba(148, 163, 184, 0.35); border-radius: 999px;
      box-shadow: 0 10px 28px rgba(2, 6, 23, 0.35);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      transition: all 0.2s ease;
    }
    #fc-bm-dock.collapsed {
      padding: 4px; gap: 0; background: rgba(28, 59, 104, 0.94);
    }
    #fc-bm-dock.collapsed #fc-bm-summary-btn,
    #fc-bm-dock.collapsed #fc-bm-house-dock-btn,
    #fc-bm-dock.collapsed #fc-bm-backup-dock-btn,
    #fc-bm-dock.collapsed #fc-bm-chat-btn,
    #fc-bm-dock.collapsed #fc-bm-fab { display: none; }
    #fc-bm-dock-toggle {
      width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.28);
      background: rgba(255,255,255,0.12); color: #f8fafc; font-size: 14px; font-weight: 800;
      cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      padding: 0; flex-shrink: 0; transition: background 0.15s ease;
    }
    #fc-bm-dock-toggle:hover { background: rgba(255,255,255,0.24); }
    #fc-bm-fab, #fc-bm-chat-btn, #fc-bm-summary-btn, #fc-bm-house-dock-btn, #fc-bm-backup-dock-btn, #fc-bm-timer-btn {
      color: #fff; padding: 8px 13px; border-radius: 999px;
      font-size: 12.5px; font-weight: 700; cursor: pointer; display: flex; align-items: center;
      gap: 5px; border: 1px solid rgba(255,255,255,0.25); user-select: none;
      animation: fc-bm-pop 0.25s ease; transition: transform 0.12s ease, filter 0.12s ease;
      white-space: nowrap;
    }
    #fc-bm-fab:active, #fc-bm-chat-btn:active, #fc-bm-summary-btn:active, #fc-bm-house-dock-btn:active, #fc-bm-backup-dock-btn:active, #fc-bm-timer-btn:active { transform: scale(0.97); }
    #fc-bm-timer-btn { background: linear-gradient(135deg, #334155, #1e293b); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; box-shadow: 0 3px 10px rgba(15,23,42,0.38); }
    #fc-bm-timer-btn.running { background: linear-gradient(135deg, #16a34a, #15803d); box-shadow: 0 3px 12px rgba(22,163,74,0.42); }
    #fc-bm-timer-btn.ended { background: linear-gradient(135deg, #0284c7, #0369a1); box-shadow: 0 3px 12px rgba(2,132,199,0.38); }
    #fc-bm-fab { background: linear-gradient(135deg, #2563eb, #1d4ed8); box-shadow: 0 3px 12px rgba(37,99,235,0.4); }
    #fc-bm-chat-btn { background: linear-gradient(135deg, #4f46e5, #3730a3); box-shadow: 0 3px 12px rgba(79,70,229,0.38); position: relative; }
    #fc-bm-chat-badge {
      background: #ef4444; color: #fff; font-size: 10px; font-weight: 800;
      padding: 1px 6px; border-radius: 12px; border: 1.5px solid #fff;
    }
    #fc-bm-summary-btn { background: linear-gradient(135deg, #0f766e, #115e59); box-shadow: 0 3px 12px rgba(15,118,110,0.38); }
    #fc-bm-summary-btn.warn { background: linear-gradient(135deg, #d97706, #b45309); }
    #fc-bm-summary-btn.ready { background: linear-gradient(135deg, #16a34a, #15803d); }
    @media (max-width: 520px) {
      #fc-bm-dock { bottom: 10px; right: 8px; gap: 4px; padding: 4px; border-radius: 22px; }
      #fc-bm-fab, #fc-bm-chat-btn, #fc-bm-summary-btn, #fc-bm-timer-btn { padding: 7px 10px; font-size: 11.5px; }
      #fc-bm-dock-toggle { width: 30px; height: 30px; font-size: 13px; }
    }
    .fc-chat-feed {
      background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 10px;
      padding: 10px; min-height: 170px; max-height: 44vh; overflow-y: auto;
      display: flex; flex-direction: column; gap: 8px;
    }
    .fc-chat-bubble {
      max-width: 90%; border-radius: 10px; padding: 8px 10px; font-size: 12px; line-height: 1.45;
      border: 1px solid #e2e8f0; background: #fff; align-self: flex-start; word-break: break-word;
    }
    .fc-chat-bubble.mine { align-self: flex-end; background: #eff6ff; border-color: #bfdbfe; }
    .fc-chat-bubble.nid { width: 100%; max-width: 100%; box-sizing: border-box; background: #f0fdfa; border-color: #5eead4; }
    .fc-chat-bubble.summary { width: 100%; max-width: 100%; box-sizing: border-box; background: #eef2ff; border-color: #a5b4fc; }
    .fc-chat-chip {
      padding: 5px 9px; border-radius: 7px; border: 1px solid #cbd5e1; background: #f8fafc;
      color: #1e293b; font-size: 11px; font-weight: 700; cursor: pointer;
    }
    .fc-chat-chip.primary { background: #0f766e; border-color: #0f766e; color: #fff; }
    .fc-chat-chip.accent { background: #1976d2; border-color: #1976d2; color: #fff; }
    .fc-sum-card {
      background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 10px;
      padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
    }
    .fc-sum-card.ok { border-color: #86efac; background: #f0fdf4; }
    .fc-sum-card.warn { border-color: #fcd34d; background: #fffbeb; }
    .fc-sum-card.missing { border-color: #fca5a5; background: #fef2f2; }
    .fc-sum-row {
      display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px;
    }
    .fc-sum-jump {
      background: #1c3b68; color: #fff; border: none; border-radius: 6px;
      padding: 5px 10px; font-size: 11px; font-weight: 700; cursor: pointer; white-space: nowrap;
    }
    @keyframes fc-bm-pop { from { transform: scale(0.82); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    .fc-bm-overlay {
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(2, 6, 23, 0.68); z-index: 10000000;
      display: flex; align-items: center; justify-content: center; padding: 10px; box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      backdrop-filter: blur(4px);
    }
    .fc-bm-card {
      background: #ffffff; width: 100%; max-width: 468px; max-height: 92vh; border-radius: 18px; overflow: hidden;
      box-shadow: 0 24px 48px rgba(2,6,23,0.4); display: flex; flex-direction: column; border: 1px solid #e2e8f0;
    }
    .fc-bm-hdr {
      background: linear-gradient(135deg, #0f294d, #1c3b68); color: #fff; padding: 12px 14px; display: flex;
      justify-content: space-between; align-items: center; gap: 8px; flex-shrink: 0;
    }
    .fc-bm-hdr h3 { margin: 0; font-size: 14px; font-weight: 800; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .fc-bm-ver-tag { background: rgba(56,189,248,0.22); color: #bae6fd; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 999px; border: 1px solid rgba(56,189,248,0.4); }
    .fc-bm-fid-chip { background: rgba(34,197,94,0.2); color: #bbf7d0; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px; border: 1px solid rgba(74,222,128,0.35); }
    .fc-bm-hdr-btn {
      background: rgba(255,255,255,0.16); border: 1px solid rgba(255,255,255,0.3); color: #fff;
      border-radius: 7px; padding: 4px 8px; font-size: 11px; font-weight: 700; cursor: pointer;
    }
    .fc-bm-close-btn {
      width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,0.14);
      color: #fff; display: inline-flex; align-items: center; justify-content: center;
      cursor: pointer; font-size: 18px; font-weight: 700; line-height: 1; border: none; flex-shrink: 0;
    }
    .fc-bm-tabs {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 8px 12px;
      background: #f1f5f9; border-bottom: 1px solid #e2e8f0; flex-shrink: 0;
    }
    .fc-bm-tab-btn {
      padding: 7px 6px; border: 1px solid transparent; border-radius: 9px; background: transparent;
      color: #475569; font-size: 11.5px; font-weight: 700; cursor: pointer; transition: all 0.15s ease;
    }
    .fc-bm-tab-btn.active {
      background: #ffffff; color: #1d4ed8; border-color: #cbd5e1; box-shadow: 0 2px 6px rgba(15,23,42,0.07);
    }
    .fc-bm-body {
      padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; flex: 1;
    }
    .fc-bm-pane { display: none; flex-direction: column; gap: 10px; }
    .fc-bm-pane.active { display: flex; }
    .fc-bm-section-card {
      background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 11px; padding: 10px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .fc-bm-doc-pills {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
    }
    .fc-bm-frame-pill {
      padding: 7px 6px; border: 1.5px solid #cbd5e1; border-radius: 9px; background: #f8fafc;
      color: #334155; font-size: 11.5px; font-weight: 700; cursor: pointer; text-align: center;
      transition: all 0.15s ease;
    }
    .fc-bm-frame-pill.active {
      background: #eff6ff; border-color: #2563eb; color: #1d4ed8; box-shadow: 0 1px 4px rgba(37,99,235,0.2);
    }
    .fc-bm-cam-box {
      width: 100%; aspect-ratio: 10/7; max-height: min(44vh, 320px); background: #000; border-radius: 10px;
      overflow: hidden; display: flex; align-items: center; justify-content: center; position: relative; margin: 0 auto;
    }
    .fc-bm-cam-box.mode-a4 {
      max-width: 340px; aspect-ratio: 3/4; max-height: min(54vh, 390px);
    }
    .fc-bm-cam-box video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 1; }
    .fc-bm-crop-frame {
      position: relative; width: 88%; height: auto; aspect-ratio: 85.6 / 53.98;
      border: 2px dashed rgba(56,189,248,0.88); border-radius: 8px; pointer-events: none;
      display: flex; align-items: flex-end; justify-content: center; padding-bottom: 6px;
      box-shadow: 0 0 0 9999px rgba(2,6,23,0.64); z-index: 2;
    }
    .fc-bm-cam-box.mode-a4 .fc-bm-crop-frame {
      height: 88%; width: auto; max-width: 90%; aspect-ratio: 210 / 297;
    }
    .fc-bm-crop-hint {
      background: rgba(2,6,23,0.78); color: #f8fafc; padding: 3px 8px; border-radius: 10px;
      font-size: 10.5px; font-weight: 600; text-align: center;
    }
    .fc-bm-cam-bracket {
      position: absolute; width: 20px; height: 20px; border-color: #38bdf8; border-style: solid; pointer-events: none;
    }
    .tl { top: -2px; left: -2px; border-width: 3px 0 0 3px; }
    .tr { top: -2px; right: -2px; border-width: 3px 3px 0 0; }
    .bl { bottom: -2px; left: -2px; border-width: 0 0 3px 3px; }
    .br { bottom: -2px; right: -2px; border-width: 0 3px 3px 0; }
    .fc-bm-btn-group { display: flex; gap: 8px; }
    .fc-bm-cam-btn {
      flex: 1.2; background: linear-gradient(135deg, #2563eb, #0284c7); color: #fff; border: none; padding: 11px 12px;
      border-radius: 10px; font-size: 13.5px; font-weight: 700; cursor: pointer; display: flex;
      align-items: center; justify-content: center; gap: 6px; box-shadow: 0 4px 12px rgba(2,132,199,0.3);
    }
    .fc-bm-secondary-btn {
      flex: 1; background: #f1f5f9; color: #334155; border: 1.5px solid #cbd5e1; padding: 11px 10px;
      border-radius: 10px; font-size: 13px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px;
    }
    .fc-bm-quick-chips {
      display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    }
    .fc-bm-info-chip {
      background: #f1f5f9; border: 1px solid #cbd5e1; color: #334155; border-radius: 8px;
      padding: 4px 8px; font-size: 11px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
    }
    .fc-bm-last-preview {
      background: linear-gradient(135deg, #f0fdf4, #ecfeff); border: 1.5px solid #86efac;
      border-radius: 10px; padding: 9px 10px; font-size: 11.5px; color: #0f172a;
      display: none; flex-direction: column; gap: 4px;
    }
    .fc-bm-row { display: flex; gap: 8px; }
    .fc-bm-col { flex: 1; display: flex; flex-direction: column; gap: 4px; }
    .fc-bm-col label { font-size: 11px; font-weight: 700; color: #475569; }
    .fc-bm-col select, .fc-bm-col input {
      padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12.5px; box-sizing: border-box; width: 100%; background: #fff;
    }
    .fc-bm-key-wrap { display: flex; gap: 4px; align-items: center; }
    .fc-bm-key-wrap input { flex: 1; min-width: 0; }
    .fc-bm-eye-btn {
      border: 1px solid #cbd5e1; background: #fff; border-radius: 7px; padding: 7px 8px; font-size: 12px; cursor: pointer;
    }
    .fc-bm-toast {
      position: fixed; top: 36px; right: 16px; z-index: 10000001; background: #166534; color: #fff;
      padding: 10px 16px; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.28);
      font-size: 13px; font-weight: 700; animation: fc-bm-pop 0.25s ease; max-width: calc(100vw - 32px);
    }
    .fc-bm-spinner {
      width: 32px; height: 32px; border: 4px solid #e2e8f0; border-top-color: #1976d2;
      border-radius: 50%; animation: fc-bm-spin 0.8s linear infinite; margin: 0 auto;
    }
    @keyframes fc-bm-spin { to { transform: rotate(360deg); } }

    /* --- Polished Booklet UI v2.1 (4-Tab Glass Drawer, Progress %, Field Trace, Logs) --- */
    #fc-bm-dock {
      backdrop-filter: blur(10px);
      border: 1.5px solid rgba(56, 189, 248, 0.35);
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.28);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    #fc-bm-dock button:hover { filter: brightness(1.07); }
    .fc-bm-card {
      border: 1px solid rgba(148, 163, 184, 0.35);
      box-shadow: 0 24px 56px rgba(2, 6, 23, 0.42);
      max-height: 92vh;
      display: flex;
      flex-direction: column;
    }
    .fc-bm-body {
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: #94a3b8 transparent;
    }
    .fc-bm-tabs {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
      gap: 4px !important;
    }
    .fc-bm-tab-btn {
      font-size: 11px !important;
      padding: 7px 4px !important;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-radius: 8px !important;
      transition: all 0.16s ease;
    }
    .fc-bm-progress-wrap {
      width: 100%; max-width: 340px; margin: 10px auto 4px;
      background: #e2e8f0; border-radius: 999px; height: 9px; overflow: hidden;
      border: 1px solid #cbd5e1;
    }
    .fc-bm-progress-fill {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, #0ea5e9, #2563eb, #10b981);
      border-radius: 999px; transition: width 0.35s ease;
    }
    .fc-bm-progress-meta {
      display: flex; justify-content: space-between; align-items: center;
      max-width: 340px; margin: 4px auto 0; font-size: 11px; font-weight: 700; color: #1e3a8a;
    }
    .fc-trace-steps-bar {
      display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px;
    }
    .fc-trace-step-pill {
      border: 1px solid #cbd5e1; background: #fff; color: #334155;
      border-radius: 7px; padding: 4px 7px; font-size: 10.5px; font-weight: 700; cursor: pointer;
      display: inline-flex; align-items: center; gap: 4px; transition: all 0.15s ease;
    }
    .fc-trace-step-pill.active { background: #1e3a8a; color: #fff; border-color: #1e3a8a; }
    .fc-trace-step-pill.ok { border-color: #86efac; background: #f0fdf4; color: #166534; }
    .fc-trace-step-pill.warn { border-color: #fcd34d; background: #fffbeb; color: #92400e; }
    .fc-trace-filter-bar { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    .fc-trace-filter-btn {
      border: 1px solid #cbd5e1; background: #f8fafc; color: #334155;
      border-radius: 6px; padding: 3px 8px; font-size: 10.5px; font-weight: 700; cursor: pointer;
    }
    .fc-trace-filter-btn.active { background: #0f766e; color: #fff; border-color: #0f766e; }
    .fc-trace-row {
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
      padding: 6px 8px; border-radius: 8px; background: #fff; border: 1px solid #e2e8f0;
      font-size: 11px; margin-bottom: 4px;
    }
    .fc-trace-row.missing { background: #fffbeb; border-color: #fcd34d; }
    .fc-trace-row.filled { background: #f8fafc; border-color: #cbd5e1; }
    .fc-trace-jump-btn {
      background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe;
      border-radius: 6px; padding: 3px 7px; font-size: 10px; font-weight: 800; cursor: pointer; flex-shrink: 0;
    }
    .fc-trace-jump-btn:hover { background: #1d4ed8; color: #fff; }
    .fc-link-chip {
      display: flex; justify-content: space-between; align-items: center; gap: 6px;
      padding: 5px 8px; border-radius: 7px; background: #f0f9ff; border: 1px solid #bae6fd;
      font-size: 10.5px; color: #0c4a6e; margin-bottom: 4px;
    }
    .fc-log-row {
      padding: 5px 8px; border-radius: 7px; border: 1px solid #fecaca; background: #fef2f2;
      font-size: 10.5px; color: #7f1d1d; line-height: 1.4;
    }
    .fc-log-row.warn { border-color: #fde68a; background: #fffbeb; color: #78350f; }
    .fc-log-row.info { border-color: #bae6fd; background: #f0f9ff; color: #0c4a6e; }
    @keyframes fc-pulse-ring {
      0% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0.75); }
      70% { box-shadow: 0 0 0 10px rgba(14, 165, 233, 0); }
      100% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0); }
    }
    .fc-field-trace-pulse {
      outline: 3px solid #0284c7 !important;
      outline-offset: 3px !important;
      border-radius: 8px !important;
      background-color: rgba(224, 242, 254, 0.45) !important;
      animation: fc-pulse-ring 1.1s ease-out 2 !important;
    }
    #fc-section11-toolbar {
      margin-bottom: 12px; padding: 10px 12px; border-radius: 11px;
      background: linear-gradient(135deg, #f5f3ff, #eef2ff);
      border: 1.5px solid #c4b5fd; font-size: 12px;
      box-shadow: 0 2px 8px rgba(109, 40, 217, 0.08);
    }
    @media (max-width: 520px) {
      .fc-bm-card { width: 98vw !important; max-width: 98vw !important; border-radius: 14px !important; }
      .fc-bm-tab-btn { font-size: 10px !important; padding: 6px 2px !important; }
    }

    /* --- Step 2 Personal Info Helper Toolbar --- */
    #fc-section2-toolbar {
      margin-bottom: 12px; padding: 10px 12px; border-radius: 12px;
      background: linear-gradient(135deg, #f0f9ff, #eef2ff);
      border: 1.5px solid #7dd3fc; box-shadow: 0 2px 8px rgba(14,165,233,0.08);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 12px;
    }
    .fc-s2-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
    .fc-s2-title { font-weight: 800; color: #0c4a6e; font-size: 13px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .fc-s2-badge { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 800; background: #dcfce7; color: #166534; border: 1px solid #86efac; }
    .fc-s2-badge.warn { background: #fef3c7; color: #92400e; border-color: #fcd34d; }
    .fc-s2-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .fc-s2-btn {
      padding: 5px 10px; border: none; border-radius: 7px; font-size: 11.5px; font-weight: 700;
      cursor: pointer; color: #fff; display: inline-flex; align-items: center; gap: 4px;
    }
    .fc-s2-meta {
      margin-top: 7px; padding: 6px 9px; background: rgba(255,255,255,0.8); border: 1px solid #bae6fd;
      border-radius: 8px; font-size: 11px; color: #1e293b; line-height: 1.45;
    }

    /* --- Section 3 Media Tracer & Guardian HUD --- */
    #fc-section3-hud {
      position: fixed; bottom: 72px; right: 14px; z-index: 9999998;
      width: 310px; background: #ffffff; border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.18); border: 2px solid #1c3b68;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden; transition: all 0.25s ease;
    }
    #fc-section3-hud.minimized { width: auto; background: #1c3b68; border-color: #38bdf8; }
    #fc-section3-hud.minimized .fc-s3-body { display: none; }
    .fc-s3-header {
      background: #1c3b68; color: #fff; padding: 9px 12px;
      display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none;
    }
    .fc-s3-header h4 { margin: 0; font-size: 12.5px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
    .fc-s3-toggle { font-size: 15px; font-weight: bold; cursor: pointer; color: #94a3b8; }
    .fc-s3-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; font-size: 12px; }
    .fc-s3-item {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 8px; border-radius: 8px; background: #f8fafc; border: 1px solid #e2e8f0;
    }
    .fc-s3-item-lbl { font-weight: 600; color: #334155; display: flex; align-items: center; gap: 6px; }
    .fc-s3-badge { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 6px; }
    .fc-s3-badge-pending { background: #fef3c7; color: #92400e; }
    .fc-s3-badge-ready { background: #e0f2fe; color: #0369a1; }
    .fc-s3-badge-done { background: #dcfce7; color: #166534; }
    .fc-s3-badge-opt { background: #f3e8ff; color: #6b21a8; }
    .fc-s3-badge-err { background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; }
    .fc-s3-progress-wrap { width: 100%; background: #e2e8f0; border-radius: 10px; height: 6px; overflow: hidden; }
    .fc-s3-progress-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #10b981, #059669); transition: width 0.3s ease; }
    .fc-s3-note { font-size: 10.5px; color: #64748b; line-height: 1.4; background: #f1f5f9; padding: 6px 8px; border-radius: 6px; }
    #fc-section3-validator {
      margin-bottom: 12px; padding: 10px 12px; border-radius: 10px;
      background: linear-gradient(135deg, #f0fdf4 0%, #eff6ff 100%);
      border: 1.5px solid #86efac; box-shadow: 0 2px 8px rgba(15, 118, 110, 0.08);
      display: flex; flex-direction: column; gap: 7px; font-size: 12px;
    }
    .fc-s3v-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; color: #065f46; }
    .fc-s3v-grid { display: flex; flex-wrap: wrap; gap: 6px; }
    .fc-s3v-chip {
      flex: 1; min-width: 145px; padding: 5px 8px; border-radius: 8px;
      font-size: 11px; font-weight: 700; display: flex; justify-content: space-between; align-items: center; gap: 6px;
      background: #ffffff; border: 1px solid #cbd5e1; color: #334155;
    }
    .fc-s3v-chip.ok { background: #dcfce7; border-color: #86efac; color: #166534; }
    .fc-s3v-chip.uploading { background: #e0f2fe; border-color: #7dd3fc; color: #0369a1; }
    .fc-s3v-chip.error { background: #fee2e2; border-color: #fca5a5; color: #b91c1c; }
    .fc-s3v-chip.missing { background: #fffbeb; border-color: #fcd34d; color: #92400e; }
    #fc-section4-toolbar {
      margin-bottom: 12px; padding: 10px 12px; border-radius: 10px;
      background: linear-gradient(135deg, #f0fdf4 0%, #ecfeff 100%);
      border: 1.5px solid #86efac; box-shadow: 0 2px 8px rgba(22, 163, 74, 0.08);
      display: flex; flex-direction: column; gap: 8px; font-size: 12px;
    }
    .fc-s4-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; color: #166534; }
    .fc-s4-grid { display: grid; grid-template-columns: minmax(120px, 175px) 1fr; gap: 8px; align-items: end; }
    @media (max-width: 600px) { .fc-s4-grid { grid-template-columns: 1fr; } }
    .fc-s4-field { display: flex; flex-direction: column; gap: 3px; }
    .fc-s4-field label { font-size: 11px; font-weight: 700; color: #1e293b; }
    .fc-s4-inline-row { display: flex; gap: 5px; align-items: center; }
    .fc-s4-inp {
      flex: 1; min-width: 0; padding: 6px 8px; border: 1.5px solid #cbd5e1; border-radius: 7px;
      font-size: 12px; font-weight: 700; color: #0f172a; background: #ffffff;
    }
    .fc-s4-vchips { display: flex; flex-wrap: wrap; gap: 5px; }
    .fc-s4-vchip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 9px; border-radius: 999px; font-size: 11px; font-weight: 700;
      background: #ffffff; border: 1.5px solid #cbd5e1; color: #334155; cursor: pointer;
    }
    .fc-s4-vchip.active { background: #16a34a; border-color: #15803d; color: #ffffff; }
    .fc-s4-vdel {
      display: inline-flex; align-items: center; justify-content: center;
      width: 15px; height: 15px; border-radius: 50%; border: none;
      background: rgba(15, 23, 42, 0.14); color: inherit; font-size: 10px; line-height: 1; cursor: pointer; padding: 0;
    }
    .fc-s4-vchip.active .fc-s4-vdel { background: rgba(255, 255, 255, 0.25); color: #ffffff; }

    /* --- Section 5 & Tab 6 Cross-Matching Engine HUD --- */
    #fc-crossmatch-hud {
      position: fixed; bottom: 72px; left: 14px; z-index: 9999998;
      width: 315px; background: #ffffff; border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.18); border: 2px solid #0f766e;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden; transition: all 0.25s ease;
    }
    #fc-crossmatch-hud.minimized { width: auto; background: #0f766e; border-color: #2dd4bf; }
    #fc-crossmatch-hud.minimized .fc-cm-body { display: none; }
    .fc-cm-header {
      background: #0f766e; color: #fff; padding: 9px 12px;
      display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none;
    }
    .fc-cm-header h4 { margin: 0; font-size: 12.5px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
    .fc-cm-toggle { font-size: 15px; font-weight: bold; cursor: pointer; color: #99f6e4; }
    .fc-cm-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; font-size: 12px; }
    .fc-cm-verdict { padding: 7px 10px; border-radius: 8px; font-weight: 700; font-size: 11.5px; text-align: center; transition: all 0.2s ease; }
    .fc-cm-verdict-matched { background: #dcfce7; color: #15803d; border: 1.5px solid #86efac; }
    .fc-cm-verdict-pending { background: #fef3c7; color: #b45309; border: 1.5px solid #fcd34d; }
    .fc-cm-verdict-mismatch { background: #fee2e2; color: #b91c1c; border: 1.5px solid #fca5a5; }
    .fc-cm-verdict-excess { background: #fee2e2; color: #991b1b; border: 1.5px solid #f87171; }
    .fc-cm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .fc-cm-stat-card { background: #f0fdfa; border: 1px solid #ccfbf1; border-radius: 8px; padding: 6px 8px; }
    .fc-cm-stat-title { font-size: 10px; color: #0d9488; font-weight: 700; text-transform: uppercase; }
    .fc-cm-stat-val { font-size: 12px; font-weight: 800; color: #115e59; margin-top: 2px; }
    .fc-cm-detail-list { display: flex; flex-direction: column; gap: 4px; font-size: 11px; }
    .fc-cm-row {
      display: flex; justify-content: space-between; align-items: center; padding: 5px 8px;
      border-radius: 6px; background: #f8fafc; border: 1px solid #e2e8f0;
    }
    .fc-cm-badge { padding: 2px 8px; border-radius: 6px; font-size: 10.5px; font-weight: 700; }
    .fc-cm-badge-matched { background: #dcfce7; color: #15803d; }
    .fc-cm-badge-pending { background: #fef3c7; color: #b45309; }
    .fc-cm-badge-excess { background: #fee2e2; color: #b91c1c; }
    .fc-cm-s5-row {
      display: flex; justify-content: space-between; align-items: center; gap: 6px;
      font-size: 11px; padding: 5px 8px; border-radius: 7px;
      background: #f0fdfa; border: 1px solid #99f6e4; color: #0f766e; font-weight: 700;
    }
    .fc-cm-jump-btn {
      border: 1px solid #0f766e; background: #ffffff; color: #0f766e;
      border-radius: 6px; padding: 2px 7px; font-size: 10.5px; font-weight: 700; cursor: pointer;
    }
    .fc-cm-jump-btn:hover { background: #ccfbf1; }
    #fc-section5-toolbar {
      margin-bottom: 12px; padding: 10px 12px; border-radius: 10px;
      background: linear-gradient(135deg, #f0fdfa 0%, #eff6ff 100%);
      border: 1.5px solid #5eead4; box-shadow: 0 2px 8px rgba(13, 148, 136, 0.09);
      display: flex; flex-direction: column; gap: 8px; font-size: 12px;
    }
    .fc-s5-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; color: #0f766e; }
    .fc-s5-stats-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
    @media (max-width: 600px) { .fc-s5-stats-grid { grid-template-columns: 1fr; } }
    .fc-s5-card { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 7px 9px; display: flex; flex-direction: column; gap: 3px; }
    .fc-s5-card-title { font-size: 10.5px; font-weight: 700; color: #475569; }
    .fc-s5-card-val { font-size: 12px; font-weight: 800; color: #0f172a; }
    .fc-s5-presets { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
    .fc-s5-presets-lbl { font-size: 11px; font-weight: 700; color: #334155; }
    .fc-s5-chip { padding: 3px 9px; border-radius: 999px; border: 1.5px solid #cbd5e1; background: #ffffff; color: #334155; font-size: 11px; font-weight: 700; cursor: pointer; }
    .fc-s5-chip.active { background: #0f766e; border-color: #0f766e; color: #ffffff; }
    .fc-s5-steppers { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .fc-s5-stepper { display: inline-flex; align-items: center; gap: 4px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 3px 6px; font-size: 11px; font-weight: 700; color: #0f172a; }
    .fc-s5-step-btn { border: none; background: #e2e8f0; color: #0f172a; width: 20px; height: 20px; border-radius: 5px; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; line-height: 1; }
    .fc-s5-step-btn:hover { background: #0f766e; color: #ffffff; }
    .fc-s5-checklist { display: flex; flex-wrap: wrap; gap: 4px; }
    .fc-s5-chk { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px; border: 1px solid #cbd5e1; background: #ffffff; color: #64748b; }
    .fc-s5-chk.ok { background: #dcfce7; border-color: #86efac; color: #166534; }
    .fc-s5-chk.miss { background: #fef3c7; border-color: #fcd34d; color: #92400e; }
    .fc-s5-issues { background: #fffbeb; border: 1px solid #fcd34d; color: #92400e; border-radius: 7px; padding: 6px 9px; font-size: 11px; font-weight: 600; }
    .fc-s5-issues.err { background: #fef2f2; border-color: #fca5a5; color: #991b1b; }
    #fc-section6-toolbar {
      margin-bottom: 12px; padding: 10px 12px; border-radius: 10px;
      background: linear-gradient(135deg, #f0f9ff 0%, #eff6ff 100%);
      border: 1.5px solid #38bdf8; box-shadow: 0 2px 8px rgba(2, 132, 199, 0.08);
      display: flex; flex-direction: column; gap: 8px; font-size: 12px;
    }
    .fc-s6-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; color: #0369a1; }
    .fc-s6-status { padding: 6px 9px; border-radius: 7px; border: 1px solid #cbd5e1; background: #f8fafc; font-size: 11.5px; font-weight: 700; }
    .fc-s6-status.ok { background: #f0fdf4; border-color: #86efac; color: #15803d; }
    .fc-s6-status.warn { background: #fffbeb; border-color: #fcd34d; color: #b45309; }
    .fc-s6-status.err { background: #fef2f2; border-color: #fca5a5; color: #b91c1c; }
    .fc-s6-chip.active { background: #0284c7; border-color: #0369a1; color: #ffffff; }
    #fc-section7-toolbar {
      margin-bottom: 12px; padding: 10px 12px; border-radius: 10px;
      background: linear-gradient(135deg, #f0fdf4 0%, #f0fdfa 100%);
      border: 1.5px solid #4ade80; box-shadow: 0 2px 8px rgba(22, 163, 74, 0.09);
      display: flex; flex-direction: column; gap: 8px; font-size: 12px;
    }
    .fc-s7-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; color: #166534; }
    .fc-s7-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
    @media (max-width: 640px) { .fc-s7-grid { grid-template-columns: 1fr; } }
  `;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  // Active scan target: 'applicant' or 'member'
  let activeScanTarget = { type: 'applicant', card: null, index: 1 };

  // Inject Collapsible Floating Action Dock (Summary + Messenger + Scanner)
  const dock = document.createElement('div');
  dock.id = 'fc-bm-dock';
  if (localStorage.getItem('fc_dock_collapsed') === '1') dock.classList.add('collapsed');

  const dockToggleBtn = document.createElement('button');
  dockToggleBtn.id = 'fc-bm-dock-toggle';
  dockToggleBtn.type = 'button';
  dockToggleBtn.title = 'ডক ছোট/বড় করুন';
  dockToggleBtn.textContent = dock.classList.contains('collapsed') ? '🪪' : '✕';

  const timerDockBtn = document.createElement('div');
  timerDockBtn.id = 'fc-bm-timer-btn';
  timerDockBtn.title = 'সার্ভে সময় ও ডাটাবেস হিসাব';
  timerDockBtn.innerHTML = '<span>⏱️ ০০:০০</span>';
  timerDockBtn.addEventListener('click', () => openBmTimerModal());

  const summaryBtn = document.createElement('div');
  summaryBtn.id = 'fc-bm-summary-btn';
  summaryBtn.innerHTML = '<span>📊 সারসংক্ষেপ (0%)</span>';
  const chatBtn = document.createElement('div');
  chatBtn.id = 'fc-bm-chat-btn';
  chatBtn.innerHTML = '<span>💬 মেসেজ</span><span id="fc-bm-chat-peers-dot" style="display:none; background:#22c55e; color:#052e16; border-radius:9px; padding:1px 5px; font-size:9.5px; font-weight:800;"></span><span id="fc-bm-chat-badge" style="display:none;">0</span>';
  
  const houseNoteDockBtn = document.createElement('div');
  houseNoteDockBtn.id = 'fc-bm-house-dock-btn';
  houseNoteDockBtn.innerHTML = '<span>📍 বাড়ি নোট</span>';
  houseNoteDockBtn.style.cssText = 'background:linear-gradient(135deg, #d97706, #b45309); box-shadow:0 3px 12px rgba(217,119,6,0.38);';
  houseNoteDockBtn.addEventListener('click', () => {
    openBmHouseNoteModal();
  });

  const backupDockBtn = document.createElement('div');
  backupDockBtn.id = 'fc-bm-backup-dock-btn';
  backupDockBtn.innerHTML = '<span>☁️ ব্যাকআপ</span><span id="fc-bm-dock-backup-pill" style="display:none; font-size:9.5px; font-weight:800; background:rgba(255,255,255,0.22); padding:1px 5px; border-radius:999px; margin-left:4px;"></span>';
  backupDockBtn.style.cssText = 'background:linear-gradient(135deg, #2563eb, #1d4ed8); box-shadow:0 3px 12px rgba(37,99,235,0.38);';
  backupDockBtn.addEventListener('click', async () => {
    showToast('⏳ ধাপ ১-১১ ক্লাউড ব্যাকআপ নেওয়া হচ্ছে...');
    await triggerSmartCloudBackup('dock_button', true);
    showToast('☁️ ধাপ ১-১১ ফায়ারবেস ব্যাকআপ সম্পন্ন!');
  });

  const fab = document.createElement('div');
  fab.id = 'fc-bm-fab';
  fab.innerHTML = '<span>📸 NID / সদস্য স্ক্যান</span>';

  dock.appendChild(dockToggleBtn);
  dock.appendChild(timerDockBtn);
  dock.appendChild(summaryBtn);
  dock.appendChild(houseNoteDockBtn);
  dock.appendChild(backupDockBtn);
  dock.appendChild(chatBtn);
  dock.appendChild(fab);
  document.body.appendChild(dock);

  dockToggleBtn.addEventListener('click', () => {
    const collapsed = dock.classList.toggle('collapsed');
    localStorage.setItem('fc_dock_collapsed', collapsed ? '1' : '0');
    dockToggleBtn.textContent = collapsed ? '🪪' : '✕';
  });

  // Inject Tabbed Booklet Modal
  const modal = document.createElement('div');
  modal.id = 'fc-bm-modal';
  modal.className = 'fc-bm-overlay';
  modal.style.display = 'none';

  modal.innerHTML = `
    <div class="fc-bm-card">
      <div class="fc-bm-hdr">
        <h3>
          <span>🪪 Family Card সহকারী</span>
          <span class="fc-bm-ver-tag">v2.0</span>
          <span id="fc-bm-hdr-fid" class="fc-bm-fid-chip" style="display:none;"></span>
        </h3>
        <div style="display:flex; align-items:center; gap:5px;">
          <button type="button" id="fc-bm-hdr-chat" class="fc-bm-hdr-btn">💬 রুম</button>
          <button type="button" id="fc-bm-hdr-sum" class="fc-bm-hdr-btn">📊</button>
          <button type="button" id="fc-bm-close" class="fc-bm-close-btn" aria-label="Close">&times;</button>
        </div>
      </div>

      <div class="fc-bm-tabs" id="fc-bm-tabs">
        <button type="button" class="fc-bm-tab-btn active" data-bm-tab="scan">📸 স্ক্যান</button>
        <button type="button" class="fc-bm-tab-btn" data-bm-tab="step2">📝 ঠিকানা ও ৫</button>
        <button type="button" class="fc-bm-tab-btn" data-bm-tab="trace">🗺️ ট্রেস</button>
        <button type="button" class="fc-bm-tab-btn" data-bm-tab="ai">⚙️ AI ও লগ</button>
      </div>

      <div class="fc-bm-body">
        <!-- PANE 1: SCANNER -->
        <div class="fc-bm-pane active" data-bm-pane="scan">
          <div style="display: flex; gap: 6px; background: #f1f5f9; padding: 4px; border-radius: 9px;">
            <button type="button" id="fc-bm-target-self-btn" style="flex: 1; padding: 7px 10px; border: none; border-radius: 7px; font-weight: 700; font-size: 11.5px; cursor: pointer; background: #0284c7; color: #fff;">
              👤 প্রধান আবেদনকারী
            </button>
            <button type="button" id="fc-bm-target-member-btn" style="flex: 1; padding: 7px 10px; border: none; border-radius: 7px; font-weight: 700; font-size: 11.5px; cursor: pointer; background: #e2e8f0; color: #334155;">
              👨‍👩‍👧‍👦 সদস্য (NID / জন্ম নিবন্ধন)
            </button>
          </div>

          <div id="fc-bm-doc-frame-bar" class="fc-bm-doc-pills">
            <button type="button" class="fc-bm-frame-pill active" data-doc-choice="auto">🤖 অটো শনাক্ত</button>
            <button type="button" class="fc-bm-frame-pill" data-doc-choice="nid" data-frame-mode="id">🪪 NID (ID কার্ড)</button>
            <button type="button" class="fc-bm-frame-pill" data-doc-choice="birth_certificate" data-frame-mode="a4">📄 জন্ম নিবন্ধন (A4)</button>
          </div>

          <div id="fc-bm-member-settings" style="display: none; background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 10px; padding: 10px; flex-direction: column; gap: 8px;">
            <div style="font-weight: 700; color: #166534; font-size: 12px; display: flex; justify-content: space-between; align-items: center;">
              <span>👨‍👩‍👧‍👦 সদস্য স্ক্যান কনফিগারেশন</span>
              <span id="fc-bm-member-badge" style="font-size: 10.5px; color: #0f766e; font-weight: bold; background: #ccfbf1; padding: 2px 6px; border-radius: 4px;">সদস্য নির্বাচন করুন</span>
            </div>
            <div class="fc-bm-row">
              <div class="fc-bm-col">
                <label for="fc-bm-member-select">🎯 টার্গেট সদস্য কার্ড*</label>
                <select id="fc-bm-member-select" style="padding: 5px 6px; border-radius: 6px; border: 1px solid #86efac; font-weight: 600;">
                  <option value="auto">পরবর্তী খালি সদস্য কার্ড</option>
                </select>
              </div>
              <div class="fc-bm-col">
                <label for="fc-bm-doc-type">📄 সনদের ধরন*</label>
                <select id="fc-bm-doc-type" style="padding: 5px 6px; border-radius: 6px; border: 1px solid #86efac; font-weight: 600;">
                  <option value="auto" selected>অটো-ডিটেক্ট (NID বা জন্ম সনদ)</option>
                  <option value="nid">জাতীয় পরিচিতি নম্বর (NID)</option>
                  <option value="birth_certificate">জন্ম নিবন্ধন সনদ (BRC)</option>
                </select>
              </div>
            </div>
            <div class="fc-bm-col">
              <label for="fc-bm-relation-select">🤝 খানাপ্রধানের সাথে সম্পর্ক* (অটো-ডিটেক্ট হবে)</label>
              <select id="fc-bm-relation-select" style="padding: 5px 6px; border-radius: 6px; border: 1px solid #86efac; font-weight: 600;">
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

          <input type="file" id="fc-bm-file-input" accept="image/*,application/pdf" style="display: none;">

          <div id="fc-bm-viewfinder" class="fc-bm-cam-box mode-id" style="display: none;">
            <video id="fc-bm-video" playsinline autoplay muted></video>
            <div id="fc-bm-crop-frame" class="fc-bm-crop-frame">
              <div class="fc-bm-cam-bracket tl"></div>
              <div class="fc-bm-cam-bracket tr"></div>
              <div class="fc-bm-cam-bracket bl"></div>
              <div class="fc-bm-cam-bracket br"></div>
              <div id="fc-bm-cam-hint" class="fc-bm-crop-hint">NID কার্ডটি নীল ফ্রেমের ভেতর রাখুন (বাইরের অংশ ক্রপ হবে)</div>
            </div>
          </div>

          <div id="fc-bm-img-wrap" style="display: none; width: 100%; max-height: 220px; border-radius: 10px; overflow: hidden; background: #f8fafc; border: 1px solid #cbd5e1; align-items: center; justify-content: center; flex-direction: column; gap: 6px; padding: 6px; box-sizing: border-box;">
            <img id="fc-bm-img" style="max-width: 100%; max-height: 185px; object-fit: contain; border-radius: 6px;">
          </div>

          <div id="fc-bm-loading" style="display: none; text-align: center; padding: 12px; background: linear-gradient(135deg, #f8fafc, #eff6ff); border-radius: 12px; border: 1.5px solid #bfdbfe;">
            <div class="fc-bm-spinner"></div>
            <p id="fc-bm-loading-text" style="margin: 8px 0 0 0; font-size: 12.5px; font-weight: 800; color: #1d4ed8;">AI দিয়ে ডকুমেন্ট স্ক্যান হচ্ছে... (০%)</p>
            <div class="fc-bm-progress-wrap">
              <div id="fc-bm-progress-fill" class="fc-bm-progress-fill"></div>
            </div>
            <div class="fc-bm-progress-meta">
              <span id="fc-bm-progress-stage">ধাপ: ছবি প্রসেস হচ্ছে</span>
              <span id="fc-bm-progress-pct">0% • 0s</span>
            </div>
          </div>

          <div class="fc-bm-btn-group">
            <button id="fc-bm-btn-cam" type="button" class="fc-bm-cam-btn">
              <span>📷 লাইভ ক্যামেরা</span>
            </button>
            <button id="fc-bm-btn-snap" type="button" class="fc-bm-cam-btn" style="display: none; background: linear-gradient(135deg, #16a34a, #15803d);">
              <span>⚡ ছবি তুলুন</span>
            </button>
            <button id="fc-bm-btn-gallery" type="button" class="fc-bm-secondary-btn">
              <span>📁 ফাইল/গ্যালারি</span>
            </button>
          </div>

          <div id="fc-bm-ocr-warn" style="display: none; background: #fffbeb; border: 1.5px solid #f59e0b; color: #92400e; padding: 8px 10px; border-radius: 8px; font-size: 11.5px; line-height: 1.45;"></div>

          <div id="fc-bm-last-preview" class="fc-bm-last-preview"></div>

          <div class="fc-bm-quick-chips">
            <button type="button" id="fc-bm-chip-model" class="fc-bm-info-chip">✨ 3.5 Lite</button>
            <button type="button" id="fc-bm-chip-addr" class="fc-bm-info-chip">📍 গ্রাম ও পোস্টকোড</button>
            <button type="button" id="fc-bm-chip-s5" class="fc-bm-info-chip">📊 স্টেপ ৫ ডিফল্ট</button>
          </div>
        </div>

        <!-- PANE 2: STEP 2 & SECTION 4 ADDRESS -->
        <div class="fc-bm-pane" data-bm-pane="step2">
          <div id="fc-bm-applicant-settings" style="display: flex; flex-direction: column; gap: 10px;">
            <div class="fc-bm-section-card">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="font-size:12px; font-weight:800; color:#0c4a6e;">📝 স্টেপ ২: ব্যক্তিগত তথ্য ডিফল্ট</span>
                <span id="fc-bm-mobile-valid" style="font-size:10.5px; font-weight:700; color:#64748b;">ঐচ্ছিক</span>
              </div>
              <div class="fc-bm-row">
                <div class="fc-bm-col">
                  <label for="fc-bm-marital">💍 বৈবাহিক অবস্থা*</label>
                  <select id="fc-bm-marital">
                    <option value="বিবাহিত" selected>বিবাহিত (Default)</option>
                    <option value="অবিবাহিত">অবিবাহিত</option>
                    <option value="বিধবা">বিধবা</option>
                    <option value="বিপত্নীক">বিপত্নীক</option>
                    <option value="তালাকপ্রাপ্ত">তালাকপ্রাপ্ত</option>
                    <option value="পরিত্যক্ত">পরিত্যক্ত</option>
                  </select>
                </div>
                <div class="fc-bm-col">
                  <label for="fc-bm-religion">🕌 ধর্ম*</label>
                  <select id="fc-bm-religion">
                    <option value="ইসলাম" selected>ইসলাম (Default)</option>
                    <option value="হিন্দু">হিন্দু</option>
                    <option value="বৌদ্ধ">বৌদ্ধ</option>
                    <option value="খ্রিস্টান">খ্রিস্টান</option>
                    <option value="অন্যান্য">অন্যান্য</option>
                  </select>
                </div>
              </div>
              <div class="fc-bm-col">
                <label for="fc-bm-mobile">📱 মোবাইল নম্বর (০-৯ বা 01XXXXXXXXX):</label>
                <input type="tel" id="fc-bm-mobile" placeholder="যেমন: 019XXXXXXXX" maxlength="14">
              </div>
            </div>

            <div class="fc-bm-section-card">
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap;">
                <label style="font-size: 12px; font-weight: 800; color: #1c3b68;">📍 সেকশন ৪: তথ্য সংগ্রহের ঠিকানা</label>
                <span id="fc-bm-addr-valid-pill" style="font-size: 10.5px; font-weight: 700; color: #15803d;">📮 ৭৭২১ ✅ • স্থায়ী ঠিকানা নিরাপদ</span>
              </div>
              <div class="fc-bm-row">
                <div class="fc-bm-col">
                  <label for="fc-bm-postcode">📮 পোস্ট কোড* (৪ সংখ্যা)</label>
                  <input type="text" id="fc-bm-postcode" value="${escapeHtml(savedPostcode)}" placeholder="7721" maxlength="6">
                </div>
                <div class="fc-bm-col">
                  <label for="fc-bm-village">🏠 গ্রাম নির্বাচন*</label>
                  <select id="fc-bm-village">
                    ${savedVillageList.map(v => `<option value="${escapeHtml(v)}" ${v === savedDefaultVillage ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                  </select>
                </div>
              </div>
              <div id="fc-bm-village-chips" class="fc-s4-vchips"></div>
              <div style="display: flex; gap: 6px;">
                <input type="text" id="fc-bm-new-village" placeholder="নতুন গ্রামের নাম লিখুন (যেমন: চর ঝিকরী)..." style="flex: 1; padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px;">
                <button id="fc-bm-btn-add-village" type="button" style="padding: 7px 12px; font-size: 12px; font-weight: 700; background: #0284c7; color: #fff; border: none; border-radius: 8px; cursor: pointer;">➕ যোগ</button>
              </div>
            </div>

            <div class="fc-bm-section-card">
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap;">
                <label style="font-size: 12px; font-weight: 800; color: #0f766e;">📊 সেকশন ৫: প্রোগ্রাম, সদস্য ও এমএফএস</label>
                <span id="fc-bm-s5-pill" style="font-size: 10.5px; font-weight: 700; color: #0f766e;">নগদ • প্রশিক্ষণ: না</span>
              </div>
              <div id="fc-bm-s5-live" style="font-size: 11px; font-weight: 700; color: #334155; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 7px; padding: 5px 8px;">ট্যাব ৫ লোড হলে সদস্য ও প্রোগ্রাম স্ট্যাটাস দেখা যাবে</div>
              <div class="fc-bm-row">
                <div class="fc-bm-col">
                  <label for="fc-bm-s5-mfs">📱 ডিফল্ট মোবাইল ব্যাংকিং</label>
                  <select id="fc-bm-s5-mfs">
                    <option value="নগদ">নগদ</option>
                    <option value="বিকাশ">বিকাশ</option>
                    <option value="রকেট">রকেট</option>
                    <option value="উপায়">উপায়</option>
                    <option value="প্রযোজ্য নয়">প্রযোজ্য নয় / নেই</option>
                  </select>
                </div>
                <div class="fc-bm-col">
                  <label for="fc-bm-s5-training">🎓 প্রশিক্ষণ/সুবিধা</label>
                  <select id="fc-bm-s5-training">
                    <option value="না">না</option>
                    <option value="হ্যাঁ">হ্যাঁ</option>
                  </select>
                </div>
              </div>
              <div class="fc-bm-row">
                <div class="fc-bm-col">
                  <label for="fc-bm-s5-trans">⚧️ ডিফল্ট হিজড়া সদস্য</label>
                  <select id="fc-bm-s5-trans">
                    <option value="০">০ (ডিফল্ট)</option>
                    <option value="১">১</option>
                    <option value="২">২</option>
                  </select>
                </div>
                <div class="fc-bm-col">
                  <label for="fc-bm-s5-abroad">✈️ ডিফল্ট প্রবাসী (সকল)</label>
                  <select id="fc-bm-s5-abroad">
                    <option value="০">০ (না — বিদেশী অর্থ: না)</option>
                    <option value="১">১</option>
                    <option value="২">২</option>
                  </select>
                </div>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; flex-wrap:wrap;">
                <label style="display:flex; align-items:center; gap:6px; font-size:11.5px; font-weight:600; color:#334155; margin:0; cursor:pointer;">
                  <input type="checkbox" id="fc-bm-s5-autofill" checked style="width:auto; margin:0;">
                  <span>খালি ডিফল্ট অটো-ফিল</span>
                </label>
                <div style="display:flex; gap:5px; align-items:center;">
                  <button id="fc-bm-btn-jump-s5" type="button" style="padding:5px 9px; font-size:11px; font-weight:700; background:#e2e8f0; color:#0f172a; border:none; border-radius:7px; cursor:pointer;">🔍 স্টেপ ৫-এ যান</button>
                  <button id="fc-bm-btn-apply-s5" type="button" style="padding:5px 10px; font-size:11px; font-weight:700; background:#0f766e; color:#fff; border:none; border-radius:7px; cursor:pointer;">⚡ স্টেপ ৫ বসান</button>
                </div>
              </div>
            </div>

            <button id="fc-bm-btn-apply-now" type="button" style="background: linear-gradient(135deg, #0f766e, #059669); color: #fff; border: none; border-radius: 10px; padding: 10px 12px; font-size: 12.5px; font-weight: 700; cursor: pointer;">
              ⚡ স্ক্যান ডাটা ও ডিফল্ট ফর্মে বসান
            </button>
          </div>
        </div>

        <!-- PANE 3: STEPS 1-11 WIZARD ANALYSIS, LINKS & FIELD TRACE -->
        <div class="fc-bm-pane" data-bm-pane="trace">
          <div class="fc-bm-section-card" style="gap:8px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; flex-wrap:wrap;">
              <div>
                <b style="font-size:12.5px; color:#0f172a;">🗺️ স্টেপ ১–১১ পূর্ণাঙ্গ ফিল্ড ট্রেস ও লিঙ্ক</b>
                <div id="fc-bm-trace-summary" style="font-size:10.5px; color:#475569;">লোড হচ্ছে...</div>
              </div>
              <button id="fc-bm-trace-refresh" type="button" style="background:#0f766e; color:#fff; border:none; border-radius:7px; padding:5px 10px; font-size:11px; font-weight:700; cursor:pointer;">🔄 রিট্রেস</button>
            </div>
            <div id="fc-bm-trace-steps" class="fc-trace-steps-bar"></div>
            <div class="fc-trace-filter-bar">
              <div style="display:flex; gap:4px;">
                <button type="button" class="fc-trace-filter-btn active" data-trace-filter="all">সব ফিল্ড</button>
                <button type="button" class="fc-trace-filter-btn" data-trace-filter="missing">⚠️ বাকি/জরুরি</button>
                <button type="button" class="fc-trace-filter-btn" data-trace-filter="links">🔗 ক্রস-স্টেপ লিঙ্ক</button>
              </div>
              <span id="fc-bm-trace-step-label" style="font-size:10.5px; font-weight:700; color:#1d4ed8;">সব স্টেপ</span>
            </div>
            <div id="fc-bm-trace-list" style="max-height:290px; overflow-y:auto; padding-right:2px;"></div>
          </div>
        </div>

        <!-- PANE 4: AI MODELS, KEYS, COST, SCAN HISTORY & FIREBASE LOGS -->
        <div class="fc-bm-pane" data-bm-pane="ai">
          <div class="fc-bm-section-card">
            <div class="fc-bm-row">
              <div class="fc-bm-col">
                <label for="fc-bm-ai-provider">🧠 AI কৌশল:</label>
                <select id="fc-bm-ai-provider">
                  <option value="economy" ${savedAiProvider === 'economy' ? 'selected' : ''}>💸 সাশ্রয়ী অটো (3.5 Lite → প্রয়োজনে 3.8)</option>
                  <option value="deepseek" ${savedAiProvider === 'deepseek' ? 'selected' : ''}>🐋 DeepSeek Flash (~$0.38/1K Off-Peak)</option>
                  <option value="gemini_lite" ${savedAiProvider === 'gemini_lite' ? 'selected' : ''}>⚡ Gemini Flash-Lite (~$0.78–$1.11/1K)</option>
                  <option value="auto" ${savedAiProvider === 'auto' ? 'selected' : ''}>⚖️ ডুয়াল-AI (ডিফল্ট কী → ব্যাকআপ)</option>
                  <option value="gemini" ${savedAiProvider === 'gemini' ? 'selected' : ''}>💎 Gemini শুধুমাত্র (ডিফল্ট মডেল)</option>
                </select>
              </div>
              <div class="fc-bm-col">
                <label for="fc-bm-default-key">🔑 ডিফল্ট প্রাথমিক কী:</label>
                <select id="fc-bm-default-key">
                  <option value="auto" ${savedDefaultKeySlot === 'auto' ? 'selected' : ''}>🤖 স্বয়ংক্রিয়</option>
                  <option value="gemini" ${savedDefaultKeySlot === 'gemini' ? 'selected' : ''}>✨ Gemini আগে</option>
                  <option value="deepseek" ${savedDefaultKeySlot === 'deepseek' ? 'selected' : ''}>🐋 DeepSeek আগে</option>
                </select>
              </div>
            </div>
            <div class="fc-bm-row">
              <div class="fc-bm-col">
                <label for="fc-bm-gemini-model">✨ Gemini মডেল:</label>
                <select id="fc-bm-gemini-model">
                  <option value="gemini-3.5-flash-lite" ${savedGeminiModel === 'gemini-3.5-flash-lite' ? 'selected' : ''}>3.5 Lite ($0.30/$2.50)</option>
                  <option value="gemini-3.8-flash" ${savedGeminiModel === 'gemini-3.8-flash' ? 'selected' : ''}>3.8 Flash ($0.75/$3.75)</option>
                  <option value="gemini-4-argon" ${savedGeminiModel === 'gemini-4-argon' ? 'selected' : ''}>4 Argon ($2.00/$10.00)</option>
                  <option value="gemini-3.1-flash-lite" ${savedGeminiModel === 'gemini-3.1-flash-lite' ? 'selected' : ''}>3.1 Lite ($0.25/$1.50)</option>
                </select>
              </div>
              <div class="fc-bm-col">
                <label for="fc-bm-deepseek-model">🐋 DeepSeek মডেল:</label>
                <select id="fc-bm-deepseek-model">
                  <option value="deepseek-flash" ${savedDeepSeekModel === 'deepseek-flash' ? 'selected' : ''}>deepseek-flash ($0.15/$0.60)</option>
                  <option value="deepseek-chat" ${savedDeepSeekModel === 'deepseek-chat' ? 'selected' : ''}>deepseek-chat (V3/EN Completion)</option>
                </select>
              </div>
            </div>
            <div id="fc-bm-cost-card" style="background: #f0fdf4; border: 1px solid #86efac; color: #166534; border-radius: 8px; padding: 7px 9px; font-size: 11px; line-height: 1.45;">হিসাব লোড হচ্ছে...</div>
            <div class="fc-bm-row">
              <div class="fc-bm-col">
                <label for="fc-bm-apikey">⚙️ Gemini API Key:</label>
                <div class="fc-bm-key-wrap">
                  <input type="password" id="fc-bm-apikey" placeholder="AIzaSy..." value="${escapeHtml(savedApiKey)}">
                  <button type="button" class="fc-bm-eye-btn" data-toggle-key="fc-bm-apikey" title="দেখুন/লুকান">👁️</button>
                </div>
              </div>
              <div class="fc-bm-col">
                <label for="fc-bm-deepseek-key">🐋 DeepSeek Key:</label>
                <div class="fc-bm-key-wrap">
                  <input type="password" id="fc-bm-deepseek-key" placeholder="sk-..." value="${escapeHtml(savedDeepSeekKey)}">
                  <button type="button" class="fc-bm-eye-btn" data-toggle-key="fc-bm-deepseek-key" title="দেখুন/লুকান">👁️</button>
                </div>
              </div>
            </div>
            <button id="fc-bm-btn-save-ai" type="button" style="background: #0f766e; color: #fff; border: none; border-radius: 8px; padding: 8px 12px; font-size: 12px; font-weight: 700; cursor: pointer;">💾 ডিফল্ট কী ও মডেল সেভ করুন</button>
          </div>
          <div id="fc-bm-history-list" class="fc-bm-section-card" style="display:none;"></div>
          <div id="fc-bm-log-card" class="fc-bm-section-card" style="gap:6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; flex-wrap:wrap;">
              <b style="font-size:11.5px; color:#0f172a;">🐞 Firebase এরর ও ট্রেস লগ</b>
              <div style="display:flex; gap:4px;">
                <button id="fc-bm-log-test" type="button" style="background:#0284c7; color:#fff; border:none; border-radius:5px; padding:3px 7px; font-size:10px; font-weight:700; cursor:pointer;">🧪 টেস্ট</button>
                <button id="fc-bm-log-clear" type="button" style="background:#fee2e2; color:#991b1b; border:none; border-radius:5px; padding:3px 7px; font-size:10px; font-weight:700; cursor:pointer;">🗑️ মুছুন</button>
              </div>
            </div>
            <div id="fc-bm-log-list" style="display:flex; flex-direction:column; gap:5px; max-height:150px; overflow-y:auto;"></div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const tabBtns = Array.from(modal.querySelectorAll('.fc-bm-tab-btn'));
  const tabPanes = Array.from(modal.querySelectorAll('.fc-bm-pane'));
  function switchBmTab(tabName) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.bmTab === tabName));
    tabPanes.forEach(p => p.classList.toggle('active', p.dataset.bmPane === tabName));
    if (tabName === 'ai') {
      if (typeof renderBmHistoryList === 'function') renderBmHistoryList();
      if (typeof renderBmLogList === 'function') renderBmLogList();
    }
    if (tabName === 'trace' && typeof renderBmTracePane === 'function') {
      renderBmTracePane();
    }
  }
  tabBtns.forEach(b => b.addEventListener('click', () => switchBmTab(b.dataset.bmTab || 'scan')));
  modal.querySelectorAll('[data-toggle-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById(btn.dataset.toggleKey);
      if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  });

  const closeBtn = document.getElementById('fc-bm-close');
  const btnCam = document.getElementById('fc-bm-btn-cam');
  const btnSnap = document.getElementById('fc-bm-btn-snap');
  const btnGallery = document.getElementById('fc-bm-btn-gallery');
  const fileInput = document.getElementById('fc-bm-file-input');
  const inputApiKey = document.getElementById('fc-bm-apikey');
  const inputDeepSeekKey = document.getElementById('fc-bm-deepseek-key');
  const selectAiProvider = document.getElementById('fc-bm-ai-provider');
  const selectDefaultKey = document.getElementById('fc-bm-default-key');
  const selectGeminiModel = document.getElementById('fc-bm-gemini-model');
  const selectDeepSeekModel = document.getElementById('fc-bm-deepseek-model');
  const elBmCostCard = document.getElementById('fc-bm-cost-card');
  const btnSaveAi = document.getElementById('fc-bm-btn-save-ai');
  const elChipModel = document.getElementById('fc-bm-chip-model');
  const elChipAddr = document.getElementById('fc-bm-chip-addr');
  const elChipS5 = document.getElementById('fc-bm-chip-s5');
  const elLastPreview = document.getElementById('fc-bm-last-preview');
  const elHistoryList = document.getElementById('fc-bm-history-list');
  const elHdrFid = document.getElementById('fc-bm-hdr-fid');
  const elMobileInput = document.getElementById('fc-bm-mobile');
  const elMobileValid = document.getElementById('fc-bm-mobile-valid');

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
    const cur = getSavedSection5Config();
    if (partial.transCount !== undefined) localStorage.setItem('fc_s5_default_trans', String(partial.transCount).trim() || '০');
    if (partial.training !== undefined) localStorage.setItem('fc_s5_default_training', String(partial.training).trim() || 'না');
    if (partial.mfsAccount !== undefined) localStorage.setItem('fc_s5_default_mfs', String(partial.mfsAccount).trim() || 'নগদ');
    if (partial.abroadDefault !== undefined) localStorage.setItem('fc_s5_default_abroad', String(partial.abroadDefault).trim() || '০');
    if (partial.autoFill !== undefined) localStorage.setItem('fc_s5_auto_fill', partial.autoFill ? '1' : '0');
    const next = getSavedSection5Config();
    if (typeof updateBmSection5Controls === 'function') updateBmSection5Controls();
    return next;
  }

  var sec5EngineReady = false;

  function updateBmSection5Controls() {
    const cfg = getSavedSection5Config();
    const mfsSel = document.getElementById('fc-bm-s5-mfs');
    const trSel = document.getElementById('fc-bm-s5-training');
    const transSel = document.getElementById('fc-bm-s5-trans');
    const abroadSel = document.getElementById('fc-bm-s5-abroad');
    const autoCb = document.getElementById('fc-bm-s5-autofill');
    const pill = document.getElementById('fc-bm-s5-pill');
    const liveEl = document.getElementById('fc-bm-s5-live');
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
    if (elChipS5) elChipS5.textContent = `📊 ${cfg.mfsAccount} (${cfg.training})`;
  }

  function updateBmQuickChips() {
    const gemId = selectGeminiModel ? selectGeminiModel.value : savedGeminiModel;
    const gemSpec = AI_MODEL_CATALOG[gemId] || AI_MODEL_CATALOG[DEFAULT_GEMINI_MODEL];
    const strategy = selectAiProvider ? selectAiProvider.value : savedAiProvider;
    const keySlot = selectDefaultKey ? selectDefaultKey.value : savedDefaultKeySlot;
    const useDs = strategy === 'deepseek' || (keySlot === 'deepseek' && (strategy === 'economy' || strategy === 'auto'));
    if (elChipModel) {
      elChipModel.textContent = useDs ? '🐋 DeepSeek Flash' : `✨ ${gemSpec.label.replace('Gemini ', '')}`;
    }
    if (elChipAddr) {
      const v = (selectVillage && selectVillage.value) || savedDefaultVillage || 'গ্রাম';
      const p = (inputPostcode && inputPostcode.value.trim()) || savedPostcode || '7721';
      elChipAddr.textContent = `📍 ${v} (${toBnDigits(p)})`;
    }
    if (elChipS5) {
      const c5 = getSavedSection5Config();
      elChipS5.textContent = `📊 ${c5.mfsAccount} (${c5.training})`;
    }
    if (elHdrFid) {
      const fid = scrapeFamilyId();
      if (fid) {
        elHdrFid.textContent = `আইডি: ${toBnDigits(fid)}`;
        elHdrFid.style.display = 'inline-block';
      } else {
        elHdrFid.style.display = 'none';
      }
    }
  }

  function renderLastScanPreview(data) {
    if (!elLastPreview) return;
    if (!data || (!data.name_bn && !data.doc_number && !data.nid_number)) {
      elLastPreview.style.display = 'none';
      return;
    }
    const { docType, docNumber } = resolveDocNumberAndType(data);
    const fatherLine = data.father_name_bn || (data.spouse_name_bn ? `স্বামী/স্ত্রী: ${data.spouse_name_bn}` : 'পিতার নাম নেই');
    const comp = data.ocr_completeness && typeof data.ocr_completeness === 'object' ? data.ocr_completeness : null;
    const compPct = comp ? Number(comp.scorePct || 0) : null;
    const compBadge = compPct !== null
      ? `<span style="font-size:10px; font-weight:800; padding:2px 6px; border-radius:999px; background:${compPct >= 85 ? '#dcfce7' : '#fef3c7'}; color:${compPct >= 85 ? '#166534' : '#92400e'};">${toBnDigits(compPct)}% সম্পূর্ণ${data.deepseek_en_completed ? ' • DS' : ''}</span>`
      : '';
    elLastPreview.style.display = 'flex';
    elLastPreview.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
        <b style="color:#065f46; font-size:12px;">🪪 ${escapeHtml(data.name_bn || data.name_en || 'স্ক্যানকৃত তথ্য')}</b>
        <div style="display:flex; align-items:center; gap:5px;">
          ${compBadge}
          <button type="button" id="fc-bm-preview-apply" style="background:#0f766e; color:#fff; border:none; border-radius:6px; padding:3px 8px; font-size:10.5px; font-weight:700; cursor:pointer;">⚡ ফর্মে বসাও</button>
        </div>
      </div>
      <div style="font-size:11px; color:#334155;">
        ${docType === 'birth_certificate' ? 'BRC' : 'NID'}: <b>${escapeHtml(docNumber || '-')}</b> • জন্ম: ${escapeHtml(data.dob || '-')} • লিঙ্গ: ${escapeHtml(data.gender || '-')}
      </div>
      <div style="font-size:10.5px; color:#475569;">
        পিতা/স্বামী: ${escapeHtml(fatherLine)} • মাতা: ${escapeHtml(data.mother_name_bn || '-')}
      </div>
    `;
    const applyBtn = elLastPreview.querySelector('#fc-bm-preview-apply');
    if (applyBtn) {
      applyBtn.onclick = async () => {
        const enriched = normalizeApplicantPayload({
          ...data,
          marital_status: document.getElementById('fc-bm-marital')?.value || data.marital_status || 'বিবাহিত',
          religion: document.getElementById('fc-bm-religion')?.value || data.religion || 'ইসলাম',
          mobile_number: document.getElementById('fc-bm-mobile')?.value || data.mobile_number || ''
        });
        lastExtractedData = enriched;
        window.__fcStep1FilledKey = '';
        modal.style.display = 'none';
        await fillPortalFields(enriched, { overwriteExisting: true });
        showToast('✅ স্ক্যানকৃত তথ্য ফর্মে বসানো হয়েছে!');
      };
    }
  }

  function renderBmHistoryList() {
    if (!elHistoryList) return;
    const hist = window.__fcScanHistory || [];
    if (!hist.length) {
      elHistoryList.style.display = 'none';
      return;
    }
    elHistoryList.style.display = 'flex';
    elHistoryList.innerHTML = `<div style="font-weight:800; color:#1e293b; font-size:11.5px;">🕒 সাম্প্রতিক স্ক্যান (${toBnDigits(hist.length)})</div>` +
      hist.slice(0, 5).map((h, i) => `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; background:#fff; border:1px solid #e2e8f0; border-radius:7px; padding:5px 8px; font-size:11px;">
          <div style="min-width:0;">
            <b>${escapeHtml(h.name_bn || 'অজানা')}</b> (${escapeHtml(h.doc_number || '-')})
            <div style="font-size:10px; color:#64748b;">${escapeHtml(h.at || '')} • ${escapeHtml((h.model || '').split(' ')[0])}</div>
          </div>
          ${h.data ? `<button type="button" data-hist-apply="${i}" style="background:#1976d2; color:#fff; border:none; border-radius:5px; padding:3px 7px; font-size:10px; font-weight:700; cursor:pointer; flex-shrink:0;">⚡ বসাও</button>` : ''}
        </div>
      `).join('');
    elHistoryList.querySelectorAll('[data-hist-apply]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const item = hist[parseInt(btn.getAttribute('data-hist-apply'), 10)];
        if (item?.data) {
          lastExtractedData = item.data;
          window.__fcStep1FilledKey = '';
          modal.style.display = 'none';
          await fillPortalFields(item.data, { overwriteExisting: true });
          showToast(`⚡ "${item.name_bn || item.doc_number}" ফর্মে বসানো হয়েছে!`);
        }
      });
    });
  }

  function renderBmLogList() {
    const elLogList = document.getElementById('fc-bm-log-list');
    if (!elLogList) return;
    const logs = getLocalErrorLogs();
    if (!logs.length) {
      elLogList.innerHTML = `<div style="font-size:11px; color:#64748b; text-align:center; padding:8px; background:#f8fafc; border-radius:7px; border:1px dashed #cbd5e1;">✅ কোনো এরর বা ওয়ার্নিং লগ নেই (সব ঠিক আছে)</div>`;
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

  const btnLogTest = document.getElementById('fc-bm-log-test');
  const btnLogClear = document.getElementById('fc-bm-log-clear');
  if (btnLogTest) {
    btnLogTest.addEventListener('click', async () => {
      btnLogTest.disabled = true;
      await fcLogTelemetry('info', 'manual-test', 'Firebase telemetry & error trace connection verified ✅');
      renderBmLogList();
      btnLogTest.disabled = false;
      showToast('☁️ টেস্ট লগ Firebase-এ পাঠানো হয়েছে!');
    });
  }
  if (btnLogClear) {
    btnLogClear.addEventListener('click', () => {
      clearLocalErrorLogs();
      showToast('🗑️ লোকাল এরর লগ পরিষ্কার করা হয়েছে');
    });
  }
  renderBmLogList();

  let _fcBmProgTimer = null;
  let _fcBmProgStart = 0;

  function updateBmLoadingProgress(pct, stageText = '', headlineText = '') {
    const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    const textEl = document.getElementById('fc-bm-loading-text');
    const fillEl = document.getElementById('fc-bm-progress-fill');
    const stageEl = document.getElementById('fc-bm-progress-stage');
    const pctEl = document.getElementById('fc-bm-progress-pct');
    const sec = _fcBmProgStart ? Math.max(0, Math.round((Date.now() - _fcBmProgStart) / 1000)) : 0;
    if (textEl) textEl.textContent = headlineText || `AI দিয়ে ডকুমেন্ট বিশ্লেষণ চলছে... (${toBnDigits(p)}%)`;
    if (fillEl) fillEl.style.width = `${p}%`;
    if (stageEl && stageText) stageEl.textContent = `ধাপ: ${stageText}`;
    if (pctEl) pctEl.textContent = `${p}% • ${sec}s`;
  }

  function startBmLoadingProgress(headline = 'AI দিয়ে ডকুমেন্ট বিশ্লেষণ চলছে...') {
    if (_fcBmProgTimer) { clearInterval(_fcBmProgTimer); _fcBmProgTimer = null; }
    _fcBmProgStart = Date.now();
    let pct = 10;
    updateBmLoadingProgress(pct, 'ছবি অপ্টিমাইজ ও প্রস্তুত হচ্ছে', `${headline} (১০%)`);
    _fcBmProgTimer = setInterval(() => {
      if (pct < 86) {
        pct = Math.min(86, pct + (pct < 40 ? 9 : pct < 70 ? 5 : 2));
        const stage = pct < 35 ? 'AI সার্ভারে ছবি পাঠানো হচ্ছে'
          : pct < 65 ? 'OCR বাংলা ও ইংরেজি তথ্য পড়া হচ্ছে'
            : 'জন্ম সনদ ইংরেজি রূপান্তর ও যাচাই';
        updateBmLoadingProgress(pct, stage, `${headline} (${toBnDigits(pct)}%)`);
      } else {
        updateBmLoadingProgress(pct);
      }
    }, 550);
  }

  function stopBmLoadingProgress(finalPct = 100, finalStage = 'সম্পন্ন!') {
    if (_fcBmProgTimer) { clearInterval(_fcBmProgTimer); _fcBmProgTimer = null; }
    updateBmLoadingProgress(finalPct, finalStage);
  }

  let _fcTraceFilter = 'all';
  let _fcTraceSelectedTab = 'all';

  function renderBmTracePane() {
    const sumEl = document.getElementById('fc-bm-trace-summary');
    const stepsEl = document.getElementById('fc-bm-trace-steps');
    const listEl = document.getElementById('fc-bm-trace-list');
    const lblEl = document.getElementById('fc-bm-trace-step-label');
    if (!stepsEl || !listEl || typeof collectFullFieldTrace !== 'function') return;

    const trace = collectFullFieldTrace();
    if (sumEl) {
      sumEl.innerHTML = `মোট <b>${toBnDigits(trace.totalFields)}</b> ফিল্ড • পূরণকৃত <b>${toBnDigits(trace.filledFields)}</b> ✅ • বাকি <b>${toBnDigits(trace.missingRequired)}</b> ⚠️ (${toBnDigits(trace.pct)}%)`;
    }

    stepsEl.innerHTML = `<button type="button" class="fc-trace-step-pill ${_fcTraceSelectedTab === 'all' ? 'active' : ''}" data-trace-step="all">সব (${toBnDigits(trace.steps.length)})</button>` +
      trace.steps.map(st => {
        const cls = st.missingRequired === 0 && st.filled > 0 ? 'ok' : (st.missingRequired > 0 ? 'warn' : '');
        const act = _fcTraceSelectedTab === st.tabAttr ? 'active' : '';
        return `<button type="button" class="fc-trace-step-pill ${cls} ${act}" data-trace-step="${escapeHtml(st.tabAttr)}" title="${escapeHtml(st.title)}">${escapeHtml(st.shortNum)}. ${escapeHtml(st.shortTitle)} (${toBnDigits(st.filled)}/${toBnDigits(st.fields.length)})</button>`;
      }).join('');

    stepsEl.querySelectorAll('[data-trace-step]').forEach(b => {
      b.addEventListener('click', () => {
        _fcTraceSelectedTab = b.getAttribute('data-trace-step') || 'all';
        renderBmTracePane();
      });
    });

    if (lblEl) {
      const selStep = trace.steps.find(st => st.tabAttr === _fcTraceSelectedTab);
      lblEl.textContent = selStep ? `${selStep.shortNum}. ${selStep.shortTitle}` : 'সব স্টেপ (১–১১)';
    }

    if (_fcTraceFilter === 'links') {
      listEl.innerHTML = `
        <div style="font-size:11px; font-weight:800; color:#0c4a6e; margin-bottom:6px;">🔗 অটো-সিঙ্ক ও ক্রস-স্টেপ ডাটা লিঙ্ক</div>
        ${trace.crossLinks.map(lk => `
          <div class="fc-link-chip">
            <div>
              <b>${escapeHtml(lk.fromLabel)} ➜ ${escapeHtml(lk.toLabel)}</b>
              <div style="font-size:10px; color:#334155;">${escapeHtml(lk.detail)}</div>
            </div>
            <button type="button" class="fc-trace-jump-btn" data-jump-tab="${escapeHtml(lk.toTab)}" data-jump-key="${escapeHtml(lk.jumpKey || '')}">${lk.ok ? '✅' : '⚠️'} যান</button>
          </div>
        `).join('')}
      `;
    } else {
      const targetSteps = _fcTraceSelectedTab === 'all' ? trace.steps : trace.steps.filter(st => st.tabAttr === _fcTraceSelectedTab);
      let html = '';
      for (const st of targetSteps) {
        const rows = st.fields.filter(f => _fcTraceFilter === 'all' || f.status === 'missing');
        if (!rows.length && _fcTraceFilter === 'missing') continue;
        html += `<div style="font-size:11px; font-weight:800; color:#1e3a8a; margin:6px 0 4px; display:flex; justify-content:space-between; align-items:center;">
          <span>${escapeHtml(st.title)} ${st.inDom ? '' : '<small style="color:#64748b;">(DOM লোড হয়নি)</small>'}</span>
          <button type="button" class="fc-trace-jump-btn" data-jump-tab="${escapeHtml(st.tabAttr)}">🔍 খুলুন</button>
        </div>`;
        if (!rows.length) {
          html += `<div style="font-size:10.5px; color:#64748b; padding:4px 8px;">কোনো ফিল্ড ট্রেস নেই</div>`;
        } else {
          html += rows.map(f => `
            <div class="fc-trace-row ${f.status === 'missing' ? 'missing' : (f.status === 'filled' ? 'filled' : '')}">
              <div style="min-width:0;">
                <div style="font-weight:700; color:#0f172a;">${f.status === 'filled' ? '✅' : (f.status === 'missing' ? '⚠️' : '➖')} ${escapeHtml(f.label)}${f.required ? '<span style="color:#dc2626;">*</span>' : ''}</div>
                <div style="font-size:10.5px; color:${f.value ? '#065f46' : '#92400e'}; word-break:break-word;">${escapeHtml(f.value || (f.required ? 'ফাঁকা — পূরণ করুন' : 'ঐচ্ছিক/ফাঁকা'))}</div>
                ${f.linkHint ? `<div style="font-size:9.5px; color:#0369a1;">🔗 ${escapeHtml(f.linkHint)}</div>` : ''}
              </div>
              <button type="button" class="fc-trace-jump-btn" data-jump-tab="${escapeHtml(st.tabAttr)}" data-jump-key="${escapeHtml(f.label)}">🎯 যান</button>
            </div>
          `).join('');
        }
      }
      listEl.innerHTML = html || `<div style="font-size:11px; color:#166534; text-align:center; padding:14px;">🎉 কোনো বাকি জরুরি ফিল্ড পাওয়া যায়নি!</div>`;
    }

    listEl.querySelectorAll('[data-jump-tab]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const t = btn.getAttribute('data-jump-tab');
        const k = btn.getAttribute('data-jump-key') || '';
        modal.style.display = 'none';
        if (k && typeof focusPortalField === 'function') {
          await focusPortalField(t, [k]);
        } else {
          await jumpToPortalSection(t);
        }
      });
    });
  }

  const btnTraceRefresh = document.getElementById('fc-bm-trace-refresh');
  if (btnTraceRefresh) btnTraceRefresh.addEventListener('click', renderBmTracePane);
  modal.querySelectorAll('.fc-trace-filter-btn').forEach(b => {
    b.addEventListener('click', () => {
      _fcTraceFilter = b.getAttribute('data-trace-filter') || 'all';
      modal.querySelectorAll('.fc-trace-filter-btn').forEach(x => x.classList.toggle('active', x === b));
      renderBmTracePane();
    });
  });

  if (elChipModel) elChipModel.addEventListener('click', () => switchBmTab('ai'));
  if (elChipAddr) elChipAddr.addEventListener('click', () => switchBmTab('step2'));
  if (elMobileInput && elMobileValid) {
    const refreshMobBadge = () => {
      const m = normalizeMobileNumber(elMobileInput.value);
      if (!elMobileInput.value.trim()) {
        elMobileValid.textContent = 'ঐচ্ছিক';
        elMobileValid.style.color = '#64748b';
      } else if (/^01[3-9]\d{8}$/.test(m)) {
        elMobileValid.textContent = `✅ ${m}`;
        elMobileValid.style.color = '#15803d';
      } else {
        elMobileValid.textContent = `⚠️ ১১ সংখ্যা প্রয়োজন (${m.length})`;
        elMobileValid.style.color = '#b45309';
      }
    };
    elMobileInput.addEventListener('input', refreshMobBadge);
  }
  const btnApplyNow = document.getElementById('fc-bm-btn-apply-now');
  if (btnApplyNow) {
    btnApplyNow.addEventListener('click', async () => {
      persistAiSettingsOnly();
      const base = lastExtractedData || getCachedFamilyScan(null, true) || {};
      const payload = normalizeApplicantPayload({
        ...base,
        marital_status: document.getElementById('fc-bm-marital')?.value || base.marital_status || 'বিবাহিত',
        religion: document.getElementById('fc-bm-religion')?.value || base.religion || 'ইসলাম',
        mobile_number: normalizeMobileNumber(document.getElementById('fc-bm-mobile')?.value || base.mobile_number || '')
      });
      if (payload) {
        lastExtractedData = payload;
        window.__fcStep1FilledKey = '';
        await fillPortalFields(payload, { overwriteExisting: true });
      }
      if (inputPostcode || selectVillage) {
        saveAddressConfig({
          postcode: inputPostcode?.value || savedPostcode,
          village: selectVillage?.value || savedDefaultVillage
        });
      }
      handleSection4Address({ force: true });
      updateSummaryBadge(true);
      modal.style.display = 'none';
      showToast('✅ স্টেপ ২ ও ঠিকানা তথ্য প্রয়োগ হয়েছে!');
    });
  }

  function renderBmCostCard() {
    updateBmQuickChips();
    if (!elBmCostCard) return;
    const strategy = selectAiProvider ? selectAiProvider.value : savedAiProvider;
    const keySlot = selectDefaultKey ? selectDefaultKey.value : savedDefaultKeySlot;
    const gemId = selectGeminiModel ? selectGeminiModel.value : savedGeminiModel;
    const gemSpec = AI_MODEL_CATALOG[gemId] || AI_MODEL_CATALOG[DEFAULT_GEMINI_MODEL];
    const peak = isDeepSeekPeakUtc();
    const ds1k = peak ? 0.76 : 0.38;
    const dsIn = peak ? 0.30 : 0.15;
    const dsOut = peak ? 1.20 : 0.60;
    const stats = getSavedCostStats();
    const useDs = strategy === 'deepseek' || (keySlot === 'deepseek' && (strategy === 'economy' || strategy === 'auto'));
    const activeLine = useDs
      ? `<b>সক্রিয়:</b> DeepSeek Flash (${peak ? '🟠 Peak' : '🟢 Off-Peak'}) • ~$${ds1k.toFixed(2)} (~৳${Math.round(ds1k * BDT_PER_USD)}) / ১,০০০ NID`
      : `<b>সক্রিয়:</b> ${gemSpec.label} • ~$${gemSpec.estPer1kUsd.toFixed(2)} (~৳${Math.round(gemSpec.estPer1kUsd * BDT_PER_USD)}) / ১,০০০ NID (${gemSpec.rpm} RPM)`;
    const rateLine = `রেট/1M: ${gemSpec.label} <b>$${gemSpec.inputPer1M}/$${gemSpec.outputPer1M}</b> | DeepSeek <b>$${dsIn}/$${dsOut}</b>`;
    const lastLine = stats.lastUsage
      ? `<br>🧾 শেষ স্ক্যান: <b>$${Number(stats.lastUsage.costUsd || 0).toFixed(5)}</b> (~৳${Number(stats.lastUsage.costBdt || 0).toFixed(3)}) • মোট: <b>$${Number(stats.totalUsd || 0).toFixed(5)}</b> (${stats.totalScans || 0} স্ক্যান)`
      : '';
    elBmCostCard.innerHTML = `${activeLine}<br>${rateLine}${lastLine}`;
  }
  const loading = document.getElementById('fc-bm-loading');
  const imgWrap = document.getElementById('fc-bm-img-wrap');
  const imgPreview = document.getElementById('fc-bm-img');
  const viewFinder = document.getElementById('fc-bm-viewfinder');
  const cropFrameElem = document.getElementById('fc-bm-crop-frame');
  const camHintElem = document.getElementById('fc-bm-cam-hint');
  const videoElem = document.getElementById('fc-bm-video');
  const selectMemberDocType = document.getElementById('fc-bm-doc-type');
  const docFramePills = Array.from(document.querySelectorAll('#fc-bm-doc-frame-bar .fc-bm-frame-pill'));
  let selectedDocChoice = 'auto';
  let currentBmFrameMode = 'id';

  function applyBmDocumentFrameMode(docChoice, explicitFrameMode = null) {
    selectedDocChoice = docChoice || 'auto';
    if (selectMemberDocType && selectMemberDocType.value !== selectedDocChoice) {
      selectMemberDocType.value = selectedDocChoice;
    }
    if (explicitFrameMode) {
      currentBmFrameMode = explicitFrameMode;
    } else if (selectedDocChoice === 'birth_certificate') {
      currentBmFrameMode = 'a4';
    } else if (selectedDocChoice === 'nid') {
      currentBmFrameMode = 'id';
    }
    if (viewFinder) {
      viewFinder.classList.toggle('mode-a4', currentBmFrameMode === 'a4');
      viewFinder.classList.toggle('mode-id', currentBmFrameMode !== 'a4');
    }
    if (camHintElem) {
      camHintElem.textContent = currentBmFrameMode === 'a4'
        ? 'A4 জন্ম নিবন্ধন সনদ নীল ফ্রেমে রাখুন (বাইরের অংশ ক্রপ হবে)'
        : 'NID কার্ডটি নীল ফ্রেমের ভেতর রাখুন (বাইরের অংশ ক্রপ হবে)';
    }
    docFramePills.forEach((p) => {
      p.classList.toggle('active', p.dataset.docChoice === selectedDocChoice);
    });
  }

  docFramePills.forEach((pill) => {
    pill.addEventListener('click', () => {
      const choice = pill.dataset.docChoice || 'auto';
      const nextFrame = pill.dataset.frameMode || (choice === 'birth_certificate' ? 'a4' : (choice === 'nid' ? 'id' : currentBmFrameMode));
      applyBmDocumentFrameMode(choice, nextFrame);
    });
  });
  if (selectMemberDocType) {
    selectMemberDocType.addEventListener('change', () => applyBmDocumentFrameMode(selectMemberDocType.value));
  }
  applyBmDocumentFrameMode('auto', 'id');
  const inputPostcode = document.getElementById('fc-bm-postcode');
  const selectVillage = document.getElementById('fc-bm-village');
  const inputNewVillage = document.getElementById('fc-bm-new-village');
  const btnAddVillage = document.getElementById('fc-bm-btn-add-village');

  // Target toggle elements
  const btnTargetSelf = document.getElementById('fc-bm-target-self-btn');
  const btnTargetMember = document.getElementById('fc-bm-target-member-btn');
  const panelMemberSettings = document.getElementById('fc-bm-member-settings');
  const selectTargetMember = document.getElementById('fc-bm-member-select');
  const badgeTargetMember = document.getElementById('fc-bm-member-badge');

  function updateMemberSelectDropdown(selectedIndex) {
    if (!selectTargetMember) return;
    const cards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
    let html = '<option value="auto">পরবর্তী খালি সদস্য কার্ড</option>';
    cards.forEach((c, i) => {
      const isSelf = c.classList.contains('fm-member-card--self') || (c.textContent.includes('সদস্য - ১') && c.textContent.includes('নিজ'));
      if (isSelf) return;
      const title = c.querySelector('.fm-member-title')?.textContent.trim() || `সদস্য - ${toBnDigits(i + 1)}`;
      const isSel = (selectedIndex === (i + 1)) ? 'selected' : '';
      html += `<option value="${i + 1}" ${isSel}>${escapeHtml(title)}</option>`;
    });
    html += '<option value="new">➕ নতুন সদস্য কার্ড যোগ করে ফিল করুন</option>';
    selectTargetMember.innerHTML = html;
    if (selectedIndex === 'new') selectTargetMember.value = 'new';
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
    updateVillageSelectDropdown();
    return { postcode: defP, village: defV, villages: list };
  }

  function updateVillageSelectDropdown() {
    const { postcode, village, villages } = getSavedAddressConfig();
    if (inputPostcode && inputPostcode.value !== postcode) inputPostcode.value = postcode;
    if (selectVillage) {
      selectVillage.innerHTML = villages.map(v => `<option value="${escapeHtml(v)}" ${v === village ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
    }
    const validPill = document.getElementById('fc-bm-addr-valid-pill');
    if (validPill) {
      const okPost = /^\d{4}$/.test(postcode);
      validPill.textContent = okPost
        ? `📮 ${toBnDigits(postcode)} ✅ • ${village}`
        : `⚠️ ৪ সংখ্যার পোস্ট কোড দিন`;
      validPill.style.color = okPost ? '#15803d' : '#b45309';
    }
    const chipsWrap = document.getElementById('fc-bm-village-chips');
    if (chipsWrap) {
      chipsWrap.innerHTML = villages.map((v) => {
        const isAct = v === village;
        const delBtn = villages.length > 1
          ? `<button type="button" class="fc-s4-vdel" data-bm-del-v="${escapeHtml(v)}" title="মুছুন">✕</button>`
          : '';
        return `<span class="fc-s4-vchip ${isAct ? 'active' : ''}" data-bm-pick-v="${escapeHtml(v)}">🏠 ${escapeHtml(v)}${delBtn}</span>`;
      }).join('');
    }
    updateBmQuickChips();
  }

  const chipsBox = document.getElementById('fc-bm-village-chips');
  if (chipsBox) {
    chipsBox.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-bm-del-v]');
      if (delBtn) {
        e.stopPropagation();
        const targetV = delBtn.getAttribute('data-bm-del-v');
        const cfg = saveAddressConfig({ removeVillage: targetV });
        handleSection4Address({ force: true });
        updateSummaryBadge(true);
        showToast(`🗑️ গ্রাম "${targetV}" তালিকা থেকে সরানো হয়েছে।`);
        return;
      }
      const pick = e.target.closest('[data-bm-pick-v]');
      if (pick) {
        const chosen = pick.getAttribute('data-bm-pick-v');
        saveAddressConfig({ village: chosen });
        handleSection4Address({ force: true });
        updateSummaryBadge(true);
        showToast(`✅ গ্রাম "${chosen}" সেট ও ফর্মে বসানো হয়েছে!`);
      }
    });
  }

  const bmS5MfsSel = document.getElementById('fc-bm-s5-mfs');
  const bmS5TrSel = document.getElementById('fc-bm-s5-training');
  const bmS5TransSel = document.getElementById('fc-bm-s5-trans');
  const bmS5AbroadSel = document.getElementById('fc-bm-s5-abroad');
  const bmS5AutoCb = document.getElementById('fc-bm-s5-autofill');
  const bmS5ApplyBtn = document.getElementById('fc-bm-btn-apply-s5');
  const bmS5JumpBtn = document.getElementById('fc-bm-btn-jump-s5');
  updateBmSection5Controls();
  if (elChipS5) elChipS5.addEventListener('click', () => { updateBmSection5Controls(); switchBmTab('step2'); });
  if (bmS5MfsSel) {
    bmS5MfsSel.addEventListener('change', () => {
      const next = saveSection5Config({ mfsAccount: bmS5MfsSel.value });
      if (typeof autoFillSection5Defaults === 'function') autoFillSection5Defaults({ force: true, overrides: { mfs: next.mfsAccount } });
      showToast(`✅ স্টেপ ৫ ডিফল্ট এমএফএস "${next.mfsAccount}" সেভ হয়েছে!`);
    });
  }
  if (bmS5TrSel) {
    bmS5TrSel.addEventListener('change', () => {
      const next = saveSection5Config({ training: bmS5TrSel.value });
      if (typeof autoFillSection5Defaults === 'function') autoFillSection5Defaults({ force: true, overrides: { training: next.training } });
      showToast(`✅ স্টেপ ৫ প্রশিক্ষণ ডিফল্ট "${next.training}" সেভ হয়েছে!`);
    });
  }
  if (bmS5TransSel) {
    bmS5TransSel.addEventListener('change', () => {
      const next = saveSection5Config({ transCount: bmS5TransSel.value });
      if (typeof autoFillSection5Defaults === 'function') autoFillSection5Defaults({ force: true, overrides: { trans: next.transCount } });
      showToast(`✅ স্টেপ ৫ হিজড়া সংখ্যা ডিফল্ট "${next.transCount}" সেভ হয়েছে!`);
    });
  }
  if (bmS5AbroadSel) {
    bmS5AbroadSel.addEventListener('change', () => {
      const next = saveSection5Config({ abroadDefault: bmS5AbroadSel.value });
      if (typeof autoFillSection5Defaults === 'function') {
        autoFillSection5Defaults({ force: true, overrides: { abroadMale: next.abroadDefault, abroadFemale: next.abroadDefault, abroadTrans: next.abroadDefault } });
      }
      showToast(`✅ স্টেপ ৫ প্রবাসী ডিফল্ট "${next.abroadDefault}" সেভ হয়েছে!`);
    });
  }
  if (bmS5AutoCb) {
    bmS5AutoCb.addEventListener('change', () => {
      saveSection5Config({ autoFill: bmS5AutoCb.checked });
      if (bmS5AutoCb.checked && typeof autoFillSection5Defaults === 'function') autoFillSection5Defaults();
    });
  }
  if (bmS5JumpBtn) {
    bmS5JumpBtn.addEventListener('click', () => {
      if (typeof jumpToPortalSection === 'function') jumpToPortalSection('3');
      updateBmSection5Controls();
    });
  }
  if (bmS5ApplyBtn) {
    bmS5ApplyBtn.addEventListener('click', async () => {
      const s5Panel = document.querySelector('[data-family-card-tab="3"]');
      if (s5Panel && !isPanelActiveVisible(s5Panel) && typeof jumpToPortalSection === 'function') {
        jumpToPortalSection('3');
        await new Promise(r => setTimeout(r, 150));
      }
      if (typeof autoFillSection5Defaults === 'function') {
        const res = await autoFillSection5Defaults({ force: true });
        updateBmSection5Controls();
        showToast(res && res.panel ? '✅ স্টেপ ৫-এ ডিফল্ট মান বসানো হয়েছে!' : 'ℹ️ স্টেপ ৫ প্যানেল খুললে অটো-ফিল হবে।');
      }
    });
  }

  function setScanTarget(type, card = null, index = 1) {
    activeScanTarget = { type, card, index };
    if (type === 'applicant') {
      btnTargetSelf.style.background = '#0284c7';
      btnTargetSelf.style.color = '#fff';
      btnTargetMember.style.background = '#e2e8f0';
      btnTargetMember.style.color = '#334155';
      panelMemberSettings.style.display = 'none';
    } else {
      btnTargetSelf.style.background = '#e2e8f0';
      btnTargetSelf.style.color = '#334155';
      btnTargetMember.style.background = '#0d9488';
      btnTargetMember.style.color = '#fff';
      panelMemberSettings.style.display = 'flex';
      updateMemberSelectDropdown(typeof index === 'number' ? index : undefined);
      if (badgeTargetMember) {
        badgeTargetMember.textContent = typeof index === 'number' ? `টার্গেট: সদস্য - ${toBnDigits(index)}` : 'টার্গেট: নতুন সদস্য';
      }
    }
  }

  btnTargetSelf.addEventListener('click', () => setScanTarget('applicant', null, 1));
  btnTargetMember.addEventListener('click', () => setScanTarget('member', null, 2));

  selectTargetMember.addEventListener('change', () => {
    const val = selectTargetMember.value;
    if (val === 'new') {
      activeScanTarget = { type: 'member', card: null, index: 'new' };
      if (badgeTargetMember) badgeTargetMember.textContent = 'টার্গেট: নতুন সদস্য';
    } else if (val === 'auto') {
      activeScanTarget = { type: 'member', card: null, index: 'auto' };
      if (badgeTargetMember) badgeTargetMember.textContent = 'টার্গেট: পরবর্তী খালি সদস্য';
    } else {
      const idx = parseInt(val, 10);
      const cards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
      const target = cards[idx - 1] || null;
      activeScanTarget = { type: 'member', card: target, index: idx };
      if (badgeTargetMember) badgeTargetMember.textContent = `টার্গেট: সদস্য - ${toBnDigits(idx)}`;
    }
  });

  inputPostcode.addEventListener('change', () => {
    const cfg = saveAddressConfig({ postcode: inputPostcode.value });
    handleSection4Address({ force: true });
    showToast(`✅ পোস্ট কোড ${toBnDigits(cfg.postcode)} সেভ ও প্রয়োগ হয়েছে!`);
  });

  selectVillage.addEventListener('change', () => {
    const cfg = saveAddressConfig({ village: selectVillage.value });
    handleSection4Address({ force: true });
    showToast(`✅ গ্রাম "${cfg.village}" সেট ও ফর্মে বসানো হয়েছে!`);
  });

  function addNewModalVillage() {
    const newName = inputNewVillage ? inputNewVillage.value.trim() : '';
    if (!newName) return;
    const cfg = saveAddressConfig({ addVillage: newName });
    handleSection4Address({ force: true });
    inputNewVillage.value = '';
    showToast(`✅ গ্রাম "${cfg.village}" যোগ করা হয়েছে এবং ফর্মে বসানো হলো!`);
  }
  btnAddVillage.addEventListener('click', addNewModalVillage);
  if (inputNewVillage) {
    inputNewVillage.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addNewModalVillage(); }
    });
  }

  function openAssistantModalForTab() {
    updateVillageSelectDropdown();
    updateBmQuickChips();
    const tab6 = document.querySelector('[data-family-card-tab="6"]');
    const isTab6Active = Boolean(tab6 && isPanelActiveVisible(tab6));
    if (isTab6Active) {
      setScanTarget('member', null, 'auto');
    } else {
      setScanTarget('applicant', null, 1);
    }
    const curFid = scrapeFamilyId() || '';
    const cached = (lastExtractedData && (!curFid || !lastExtractedData.family_id || lastExtractedData.family_id === curFid))
      ? lastExtractedData
      : getCachedFamilyScan(curFid, false);
    renderLastScanPreview(cached);
    switchBmTab('scan');
    modal.style.display = 'flex';
  }
  const hdrSumBtn = document.getElementById('fc-bm-hdr-sum');
  if (hdrSumBtn) {
    hdrSumBtn.addEventListener('click', () => {
      modal.style.display = 'none';
      openSummaryModal();
    });
  }
  window.__fcOpenModal = openAssistantModalForTab;

  fab.addEventListener('click', openAssistantModalForTab);
  closeBtn.addEventListener('click', () => {
    stopLiveCamera();
    modal.style.display = 'none';
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      stopLiveCamera();
      modal.style.display = 'none';
    }
  });

  function persistAiSettingsOnly() {
    savedApiKey = inputApiKey ? inputApiKey.value.trim() : savedApiKey;
    savedDeepSeekKey = inputDeepSeekKey ? inputDeepSeekKey.value.trim() : savedDeepSeekKey;
    savedAiProvider = (selectAiProvider && selectAiProvider.value) || savedAiProvider || 'economy';
    savedDefaultKeySlot = (selectDefaultKey && selectDefaultKey.value) || savedDefaultKeySlot || 'auto';
    savedGeminiModel = (selectGeminiModel && selectGeminiModel.value) || savedGeminiModel || DEFAULT_GEMINI_MODEL;
    savedDeepSeekModel = (selectDeepSeekModel && selectDeepSeekModel.value) || savedDeepSeekModel || 'deepseek-flash';
    localStorage.setItem('fc_gemini_api_key', savedApiKey);
    localStorage.setItem('fc_deepseek_api_key', savedDeepSeekKey);
    localStorage.setItem('fc_ai_provider', savedAiProvider);
    localStorage.setItem('fc_default_key_slot', savedDefaultKeySlot);
    localStorage.setItem('fc_gemini_model', savedGeminiModel);
    localStorage.setItem('fc_deepseek_model', savedDeepSeekModel);
    renderBmCostCard();
  }

  [selectAiProvider, selectDefaultKey, selectGeminiModel, selectDeepSeekModel].forEach(el => {
    if (el) el.addEventListener('change', persistAiSettingsOnly);
  });
  if (btnSaveAi) {
    btnSaveAi.addEventListener('click', () => {
      persistAiSettingsOnly();
      showToast('✅ ডিফল্ট API কী ও মডেল সেভ হয়েছে!');
    });
  }
  renderBmCostCard();

  function saveAndValidateApiKeys() {
    persistAiSettingsOnly();

    if (savedAiProvider === 'deepseek' && !savedDeepSeekKey && !/^sk-/i.test(savedApiKey)) {
      alert('অনুগ্রহ করে নিচে DeepSeek API Key (sk-...) দিন।');
      if (inputDeepSeekKey) inputDeepSeekKey.focus();
      return false;
    }
    if ((savedAiProvider === 'gemini' || savedAiProvider === 'gemini_lite') && !savedApiKey) {
      alert('অনুগ্রহ করে নিচে Gemini API Key দিন।');
      inputApiKey.focus();
      return false;
    }
    if (!savedApiKey && !savedDeepSeekKey) {
      alert('অনুগ্রহ করে নিচে আপনার Gemini বা DeepSeek API Key দিন।');
      inputApiKey.focus();
      return false;
    }
    return true;
  }

  // Start Live WebRTC Camera (Prevents Android LMK Chrome process kill)
  btnCam.addEventListener('click', async () => {
    if (!saveAndValidateApiKeys()) return;

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
      videoElem.srcObject = activeMediaStream;
      applyBmDocumentFrameMode(selectedDocChoice, currentBmFrameMode);
      viewFinder.style.display = 'flex';
      imgWrap.style.display = 'none';
      btnCam.style.display = 'none';
      btnSnap.style.display = 'flex';
    } catch (err) {
      console.warn('WebRTC Camera denied, falling back to file input:', err);
      fileInput.click();
    }
  });

  function captureCroppedBmCameraFrame(videoEl, frameEl, frameMode = 'id', quality = 0.92) {
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

  // Snap from live WebRTC video (strictly cropped to inner NID / A4 guide frame)
  btnSnap.addEventListener('click', () => {
    if (!videoElem.videoWidth) {
      alert('ক্যামেরা প্রস্তুত নয়, অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।');
      return;
    }
    const base64Data = captureCroppedBmCameraFrame(videoElem, cropFrameElem, currentBmFrameMode, 0.92);
    if (!base64Data) return;

    stopLiveCamera();
    imgPreview.src = base64Data;
    imgWrap.style.display = 'flex';
    viewFinder.style.display = 'none';
    btnSnap.style.display = 'none';
    btnCam.style.display = 'flex';
    btnCam.textContent = '🔄 পুনরায় ছবি তুলুন';

    runGeminiOCR(base64Data);
  });

  // Gallery file picker
  btnGallery.addEventListener('click', () => {
    if (!saveAndValidateApiKeys()) return;
    stopLiveCamera();
    fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const maxDim = currentBmFrameMode === 'a4' ? 2200 : 1800;
      const base64Data = await compressImage(file, maxDim, 0.92);
      if (String(base64Data).startsWith('data:application/pdf')) {
        imgPreview.removeAttribute('src');
        imgPreview.alt = `📄 PDF: ${file.name || 'document.pdf'}`;
      } else {
        imgPreview.src = base64Data;
      }
      imgWrap.style.display = 'flex';
      viewFinder.style.display = 'none';
      btnCam.textContent = '🔄 পুনরায় ছবি তুলুন';

      runGeminiOCR(base64Data);
    } catch (err) {
      alert('ছবি প্রক্রিয়াকরণ ব্যর্থ: ' + err.message);
    } finally {
      fileInput.value = '';
    }
  });

  function stopLiveCamera() {
    if (activeMediaStream) {
      activeMediaStream.getTracks().forEach(t => t.stop());
      activeMediaStream = null;
    }
    viewFinder.style.display = 'none';
    btnSnap.style.display = 'none';
    btnCam.style.display = 'flex';
  }

  function compressImage(file, maxDim = 2048, quality = 0.92) {
    return new Promise((resolve, reject) => {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = (evt) => {
        if (isPdf) {
          resolve(evt.target.result);
          return;
        }
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, width, height);
          if ('filter' in ctx) ctx.filter = 'contrast(1.06) brightness(1.02)';
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  window.__fcScanHistory = window.__fcScanHistory || [];

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
    if (typeof res?.output_text === 'string' && res.output_text.trim()) return res.output_text.trim();
    const parts = res?.candidates?.[0]?.content?.parts;
    return Array.isArray(parts) ? parts.map(p => p?.text || '').join('').trim() : '';
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

  function isDocDigitsValidForType(docType, parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    const birthYear = getDobYear(parsed.dob || '');
    const excludeSet = new Set([extractDigitCandidate(parsed.father_nid), extractDigitCandidate(parsed.mother_nid), extractDigitCandidate(parsed.registration_date)].filter(Boolean));
    if (docType === 'birth_certificate') {
      return pickBestDocDigits([parsed.birth_reg_no, parsed.doc_number, parsed.nid_number], [17], { excludeSet, birthYear }).length === 17;
    }
    const d = pickBestDocDigits([parsed.nid_number, parsed.doc_number, parsed.birth_reg_no], [10, 17, 13], { excludeSet, birthYear });
    return d.length === 10 || d.length === 13 || d.length === 17;
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

    const merged = { ...primary, ...escalated, doc_type: effectiveType };
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
    for (const f of ['name_bn', 'father_name_bn', 'mother_name_bn', 'spouse_name_bn']) {
      merged[f] = pickBn(escalated[f], primary[f]);
    }
    for (const f of ['name_en', 'father_name_en', 'mother_name_en', 'spouse_name_en']) {
      merged[f] = pickEn(escalated[f], primary[f]);
    }
    for (const f of ['relation_suggestion', 'marital_status_suggestion', 'father_nid', 'mother_nid', 'registration_date']) {
      merged[f] = cleanOcrFieldText(escalated[f] || '') || cleanOcrFieldText(primary[f] || '');
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

  function buildGeminiAttemptsForModels(models, apiKey, rawBase64, detectedMime, promptText, opts = {}) {
    const { isEscalation = false } = opts;
    const attempts = [];
    for (const model of models) {
      // Browser-origin requests use :generateContent directly because /v1beta/interactions rejects custom Api-Revision header on CORS preflight
      attempts.push({
        model,
        timeoutMs: isEscalation ? 38000 : 28000,
        label: `${model} (generateContent)`,
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: {
          contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: detectedMime, data: rawBase64 } }] }],
          generationConfig: { response_mime_type: 'application/json', responseSchema: OCR_RESPONSE_SCHEMA }
        }
      });
    }
    return attempts;
  }

  async function callGeminiResilientOCR(apiKey, rawBase64, detectedMime, promptText, profile = 'accurate', preferredGeminiModel = DEFAULT_GEMINI_MODEL, attemptOpts = {}) {
    const modelsOrder = getOrderedGeminiModels(profile, preferredGeminiModel);
    const attempts = buildGeminiAttemptsForModels(modelsOrder, apiKey, rawBase64, detectedMime, promptText, attemptOpts);

    let lastErr = 'Gemini থেকে উত্তর পাওয়া যায়নি।';
    for (const attempt of attempts) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attempt.timeoutMs || 28000);
      try {
        const res = await fetch(attempt.url, {
          method: 'POST',
          headers: attempt.headers,
          body: JSON.stringify(attempt.body),
          signal: controller.signal
        });
        clearTimeout(timer);
        const jsonRes = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = jsonRes?.error?.message || jsonRes?.message || `HTTP ${res.status}`;
          if (res.status === 400 && /API[_\s]?key/i.test(msg)) {
            throw new Error('Gemini API Key সঠিক নয়। অনুগ্রহ করে সঠিক API Key দিন।');
          }
          lastErr = `${attempt.label}: ${msg}`;
          continue;
        }
        const outputText = extractTextFromGeminiResponse(jsonRes);
        if (!outputText) {
          lastErr = `${attempt.label}: খালি উত্তর`;
          continue;
        }
        const fenceMatch = outputText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        let cleanText = fenceMatch ? fenceMatch[1].trim() : outputText.trim();
        const objMatch = cleanText.match(/\{[\s\S]*\}/);
        if (objMatch) cleanText = objMatch[0];
        const parsed = parseOcrJsonText(cleanText);
        parsed.ocr_model_used = attempt.label;
        parsed.ocr_usage = computeScanUsageAndCost(attempt.model, jsonRes);
        return parsed;
      } catch (e) {
        clearTimeout(timer);
        if (/API Key সঠিক নয়/.test(e.message || '')) throw e;
        lastErr = e.name === 'AbortError' ? `${attempt.label}: Timeout` : `${attempt.label}: ${e.message}`;
      }
    }
    throw new Error(`OCR ব্যর্থ: ${lastErr}`);
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
    const extractDsMsg = (jsonRes) => {
      const msg = jsonRes?.choices?.[0]?.message || {};
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
          const res = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deepseekKey}` },
            body: JSON.stringify(payload),
            signal: controller.signal
          });
          clearTimeout(timer);
          if (!res.ok) continue;
          const jsonRes = await res.json().catch(() => ({}));
          const content = extractDsMsg(jsonRes);
          if (!content) continue;
          const completed = parseOcrJsonText(content);
          const addCost = jsonRes?.usage ? computeScanUsageAndCost(model, jsonRes) : null;
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
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: compPrompt }] }],
            generationConfig: { response_mime_type: 'application/json' }
          }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) continue;
        const jsonRes = await res.json().catch(() => ({}));
        const txt = extractTextFromGeminiResponse(jsonRes);
        if (!txt) continue;
        const completed = parseOcrJsonText(txt);
        const addCost = jsonRes?.usageMetadata ? computeScanUsageAndCost(model, jsonRes) : null;
        return applyBilingualCompletionResult(partialData, completed, addCost, 'gemini');
      } catch (_) {
        clearTimeout(timer);
      }
    }
    return partialData;
  }

  async function callDeepSeekVisionOCR(deepseekKey, rawBase64, detectedMime, promptText, deepseekModel = 'deepseek-flash') {
    if (/pdf/i.test(String(detectedMime || ''))) {
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
    let lastErr = 'DeepSeek থেকে কোনো উত্তর পাওয়া যায়নি।';

    const attemptConfigs = [
      { disableThinking: true, useJsonMode: true, maxTokens: 4096, timeoutMs: 32000 },
      { disableThinking: true, useJsonMode: false, maxTokens: 4096, timeoutMs: 32000 },
      { disableThinking: false, useJsonMode: false, maxTokens: 8192, timeoutMs: 45000 }
    ];

    for (const targetModel of modelCandidates) {
      for (const cfg of attemptConfigs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
        try {
          const payload = {
            model: targetModel,
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
                  { type: 'image_url', image_url: { url: `data:${detectedMime};base64,${rawBase64}` } }
                ]
              }
            ],
            max_tokens: cfg.maxTokens
          };
          if (cfg.disableThinking) payload.thinking = { type: 'disabled' };
          if (cfg.useJsonMode) payload.response_format = { type: 'json_object' };
          const res = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${deepseekKey}`
            },
            body: JSON.stringify(payload),
            signal: controller.signal
          });
          clearTimeout(timer);

          const jsonRes = await res.json().catch(() => ({}));
          if (!res.ok) {
            const msg = jsonRes?.error?.message || jsonRes?.message || `HTTP ${res.status}`;
            if (res.status === 401) throw new Error('DeepSeek API Key সঠিক নয়।');
            if (res.status === 402) throw new Error('DeepSeek অ্যাকাউন্টে ব্যালেন্স শেষ (Insufficient Balance)।');
            lastErr = `${targetModel}: DeepSeek API (${res.status}): ${msg}`;
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
          const content = extractDsVisionText(jsonRes);
          if (!content) {
            const finishReason = jsonRes?.choices?.[0]?.finish_reason || '';
            lastErr = finishReason === 'length'
              ? `${targetModel}: DeepSeek টোকেন সীমা পূর্ণ হওয়ায় উত্তর অসম্পূর্ণ (পুনঃচেষ্টা ব্যর্থ)।`
              : `${targetModel}: DeepSeek থেকে কোনো উত্তর পাওয়া যায়নি।`;
            continue;
          }
          let parsed = parseOcrJsonText(content);
          const hasAnyField = parsed && [
            'name_bn', 'name_en', 'doc_number', 'nid_number', 'birth_reg_no', 'dob', 'father_name_bn', 'mother_name_bn'
          ].some(k => String(parsed[k] || '').trim() !== '');
          if (!parsed || (!hasAnyField && !/\{[\s\S]*\}/.test(content))) {
            lastErr = `${targetModel}: DeepSeek থেকে বৈধ ডকুমেন্ট তথ্য পাওয়া যায়নি।`;
            continue;
          }
          parsed.ocr_model_used = `${targetModel} (api.deepseek.com)`;
          parsed.ocr_usage = computeScanUsageAndCost(targetModel, jsonRes);
          if (needsEnglishCompletion(parsed)) {
            parsed = await completeBanglaOnlyOcrWithDeepSeek(deepseekKey, parsed, targetModel);
          }
          return parsed;
        } catch (e) {
          clearTimeout(timer);
          if (e.name === 'TypeError') {
            try {
              const edgeRes = await fetch('https://familycard-10n.pages.dev/api/ocr-nid', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  imageBase64: `data:${detectedMime};base64,${rawBase64}`,
                  mimeType: detectedMime,
                  docType: typeof selectedDocChoice !== 'undefined' ? selectedDocChoice : 'auto',
                  aiProvider: 'deepseek',
                  deepseekModel: targetModel,
                  deepseekApiKey: deepseekKey
                })
              });
              const ej = (edgeRes && edgeRes.ok && /application\/json/i.test(edgeRes.headers.get('content-type') || ''))
                ? await edgeRes.json().catch(() => ({}))
                : {};
              if (ej && ej.success && ej.data) {
                if (!ej.data.ocr_usage) ej.data.ocr_usage = computeScanUsageAndCost(targetModel, {});
                return ej.data;
              }
              if (ej && ej.error) throw new Error(ej.error);
            } catch (edgeErr) {
              lastErr = edgeErr.message || e.message;
              break;
            }
          }
          if (/Key সঠিক নয়|ব্যালেন্স শেষ/.test(e.message || '')) throw e;
          lastErr = e.name === 'AbortError' ? `${targetModel}: DeepSeek OCR সময় শেষ হয়েছে (Timeout)` : `${targetModel}: ${e.message}`;
          continue;
        }
      }
    }
    const finalErr = new Error(lastErr);
    if (/image_url|multimodal|vision|deserialize|unknown variant|model\s*(?:does\s*)?not\s*exist|invalid_request_error|unsupported\s*model/i.test(lastErr)) {
      finalErr.isVisionUnsupported = true;
    }
    const loggedDsModel = rawReq || (normalizedPref.startsWith('deepseek') ? normalizedPref : 'deepseek-flash');
    fcLogTelemetry('error', 'deepseek-ocr', lastErr, '', { model: loggedDsModel });
    throw finalErr;
  }

  async function runMultiProviderOCR({
    aiProvider = 'economy',
    defaultKeySlot = 'auto',
    geminiModel = DEFAULT_GEMINI_MODEL,
    deepseekModel = 'deepseek-flash',
    geminiKey = '',
    deepseekKey = '',
    rawBase64,
    detectedMime,
    promptText,
    docType = 'auto',
    onProgress = null
  }) {
    const emit = (pct, stage) => {
      try { if (typeof onProgress === 'function') onProgress(pct, stage); } catch (_) {}
    };
    let gKey = String(geminiKey || '').trim();
    let dKey = String(deepseekKey || '').trim();
    if (!dKey && /^sk-/i.test(gKey)) {
      dKey = gKey;
      gKey = '';
    }
    const mode = ['economy', 'auto', 'gemini', 'gemini_lite', 'deepseek'].includes(aiProvider) ? aiProvider : 'economy';
    const keySlot = ['auto', 'gemini', 'deepseek'].includes(defaultKeySlot) ? defaultKeySlot : 'auto';
    const prefGemRaw = normalizeModelId(geminiModel);
    const prefGemModel = prefGemRaw.startsWith('gemini-') ? prefGemRaw : DEFAULT_GEMINI_MODEL;

    const finalizeWithDeepSeekIfNeeded = async (resObj) => {
      let cur = resObj;
      if (dKey && needsEnglishCompletion(cur)) {
        emit(82, 'বাংলা/ইংরেজি নাম সম্পূর্ণ রূপান্তর হচ্ছে (DeepSeek)...');
        cur = await completeBanglaOnlyOcrWithDeepSeek(dKey, cur, deepseekModel);
      }
      if (gKey && needsIntelligentCompletion(cur)) {
        emit(86, 'বাংলা ↔ ইংরেজি নাম যাচাই ও রূপান্তর হচ্ছে (Gemini)...');
        cur = await completeBilingualWithGemini(gKey, cur, prefGemModel);
      }
      return cur;
    };

    if (mode === 'deepseek') {
      if (!dKey) throw new Error('DeepSeek API Key দেওয়া হয়নি!');
      emit(35, 'DeepSeek Vision দিয়ে ডকুমেন্ট বিশ্লেষণ চলছে...');
      try {
        const dsRes = await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
        return await finalizeWithDeepSeekIfNeeded(dsRes);
      } catch (dsErr) {
        const isAuthOrBalanceErr = /Key সঠিক নয়|ব্যালেন্স শেষ/i.test(dsErr.message || '');
        if (gKey && !isAuthOrBalanceErr) {
          emit(55, dsErr.isVisionUnsupported
            ? 'DeepSeek ইমেজ সীমিত — Gemini Vision + DeepSeek JSON-এ রূপান্তর চলছে...'
            : 'DeepSeek সাড়া দেয়নি — Gemini ব্যাকআপ দিয়ে বিশ্লেষণ চলছে...');
          const gRes = await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'preferred', prefGemModel, { docType });
          const merged = await completeBanglaOnlyOcrWithDeepSeek(dKey, gRes, deepseekModel);
          merged.ocr_model_used = `${gRes.ocr_model_used || 'gemini'} + DeepSeek`;
          return merged;
        }
        if (dsErr.isVisionUnsupported) {
          throw new Error(`DeepSeek API সরাসরি ইমেজ OCR (image_url) সাপোর্ট করে না — অনুগ্রহ করে Gemini API Key যুক্ত করুন, তাহলে Gemini ছবি পড়ে DeepSeek-এর বুদ্ধিমত্তায় সম্পূর্ণ বাংলা ও ইংরেজি JSON তৈরি করবে। (${dsErr.message})`);
        }
        throw dsErr;
      }
    }
    if (mode === 'gemini_lite') {
      if (!gKey) throw new Error('Gemini API Key দেওয়া হয়নি!');
      emit(35, 'Gemini Lite দিয়ে ডকুমেন্ট বিশ্লেষণ চলছে...');
      return await finalizeWithDeepSeekIfNeeded(await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'lite_only', prefGemModel, { docType }));
    }
    if (mode === 'gemini') {
      if (!gKey) throw new Error('Gemini API Key দেওয়া হয়নি!');
      emit(35, `${prefGemModel} দিয়ে ডকুমেন্ট বিশ্লেষণ চলছে...`);
      return await finalizeWithDeepSeekIfNeeded(await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'preferred', prefGemModel, { docType }));
    }

    const errors = [];
    if (keySlot === 'deepseek' && dKey) {
      emit(35, 'DeepSeek দিয়ে ডকুমেন্ট বিশ্লেষণ চলছে...');
      try {
        const dsRes = await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
        if (mode === 'auto' || !needsAccurateEscalation(dsRes, docType) || !gKey) return await finalizeWithDeepSeekIfNeeded(dsRes);
        try {
          emit(72, 'নিখুঁত ফলাফলের জন্য Gemini দিয়ে ক্রস-চেক হচ্ছে...');
          const escRes = await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'preferred', prefGemModel, { docType, isEscalation: true });
          return await finalizeWithDeepSeekIfNeeded(mergeOcrResults(dsRes, escRes, docType));
        } catch (_) {
          return await finalizeWithDeepSeekIfNeeded(dsRes);
        }
      } catch (err) {
        errors.push(`DeepSeek: ${err.message}`);
      }
      if (gKey) {
        try {
          emit(65, 'Gemini ব্যাকআপ মডেলে ডকুমেন্ট বিশ্লেষণ চলছে...');
          return await finalizeWithDeepSeekIfNeeded(await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'preferred', prefGemModel, { docType }));
        } catch (err) {
          errors.push(`Gemini: ${err.message}`);
        }
      }
      throw new Error(errors.length ? errors.join(' | ') : 'Gemini বা DeepSeek API Key দেওয়া হয়নি!');
    }

    if (mode === 'economy') {
      if (gKey) {
        emit(35, 'প্রাথমিক OCR স্ক্যান চলছে...');
        try {
          const isFlagship = prefGemModel === 'gemini-3.8-flash' || prefGemModel === 'gemini-4-argon';
          const firstProfile = isFlagship ? 'preferred' : 'lite_only';
          const primaryRes = await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, firstProfile, prefGemModel, { docType });
          if (!needsAccurateEscalation(primaryRes, docType) || isFlagship) return await finalizeWithDeepSeekIfNeeded(primaryRes);
          try {
            emit(70, 'তথ্য আরও নিখুঁত করতে Gemini 3.8 Flash দিয়ে যাচাই চলছে...');
            const escRes = await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'flash38_only', prefGemModel, { docType, isEscalation: true });
            return await finalizeWithDeepSeekIfNeeded(mergeOcrResults(primaryRes, escRes, docType));
          } catch (_) {
            if (dKey) {
              try {
                emit(80, 'DeepSeek দিয়ে অতিরিক্ত তথ্য সংগ্রহ চলছে...');
                const dsEsc = await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel);
                return await finalizeWithDeepSeekIfNeeded(mergeOcrResults(primaryRes, dsEsc, docType));
              } catch (__) {}
            }
            return await finalizeWithDeepSeekIfNeeded(primaryRes);
          }
        } catch (err) {
          errors.push(`Gemini: ${err.message}`);
        }
      }
      if (dKey) {
        try {
          emit(72, 'DeepSeek ব্যাকআপ OCR চলছে...');
          return await finalizeWithDeepSeekIfNeeded(await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel));
        } catch (err) {
          errors.push(`DeepSeek: ${err.message}`);
        }
      }
      throw new Error(errors.length ? errors.join(' | ') : 'Gemini বা DeepSeek API Key দেওয়া হয়নি!');
    }

    if (gKey) {
      emit(40, 'সর্বোচ্চ মানের Gemini OCR চলছে...');
      try {
        return await finalizeWithDeepSeekIfNeeded(await callGeminiResilientOCR(gKey, rawBase64, detectedMime, promptText, 'accurate', prefGemModel, { docType, isEscalation: docType === 'birth_certificate' }));
      } catch (err) {
        errors.push(`Gemini: ${err.message}`);
      }
    }
    if (dKey) {
      try {
        emit(75, 'DeepSeek ব্যাকআপ OCR চলছে...');
        return await finalizeWithDeepSeekIfNeeded(await callDeepSeekVisionOCR(dKey, rawBase64, detectedMime, promptText, deepseekModel));
      } catch (err) {
        errors.push(`DeepSeek: ${err.message}`);
      }
    }
    throw new Error(errors.length ? errors.join(' | ') : 'Gemini বা DeepSeek API Key দেওয়া হয়নি!');
  }

  function validateAndNormalizeOcrData(data, docTypeChoice = 'auto') {
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
    const fatherNid = extractDigitCandidate(data.father_nid);
    const motherNid = extractDigitCandidate(data.mother_nid);
    data.father_nid = fatherNid;
    data.mother_nid = motherNid;
    const parentExclude = new Set([fatherNid, motherNid, dobDigits, regDigits].filter(Boolean));

    const rawAiNid = extractDigitCandidate(data.nid_number);
    const rawAiBrc = extractDigitCandidate(data.birth_reg_no);
    const cleanNidNotParent = rawAiNid && !parentExclude.has(rawAiNid) ? rawAiNid : '';
    const hasStrongBrcMetadata = Boolean(fatherNid || motherNid || data.registration_date);
    const hasBrcEvidence =
      data.doc_type === 'birth_certificate' ||
      hasStrongBrcMetadata ||
      (!cleanNidNotParent && rawAiBrc.length === 17);

    if (docTypeChoice === 'birth_certificate') {
      data.doc_type = 'birth_certificate';
    } else if (docTypeChoice === 'nid') {
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
      const nr = normalizeBn(data.relation_suggestion);
      data.relation_suggestion = relMap[nr] || nr;
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
      const num = pickBestDocDigits([data.birth_reg_no, data.doc_number, data.nid_number], [17], { excludeSet: brcExclude, birthYear });
      data.doc_number = num;
      data.birth_reg_no = num;
      data.nid_number = '';
      if (num.length !== 17) {
        warnings.push(`জন্ম নিবন্ধন নম্বরটি ${num.length || 0} সংখ্যার (অবশ্যই ১৭ সংখ্যা প্রয়োজন) — যাচাই করুন।`);
      } else if (birthYear && !num.startsWith(birthYear)) {
        warnings.push(`জন্ম নিবন্ধনের প্রথম ৪ সংখ্যা জন্মসালের (${birthYear}) সাথে মিলছে না — বাবা/মায়ের নম্বর বা জন্মতারিখ যাচাই করুন।`);
      }
    } else {
      let num = pickBestDocDigits([data.nid_number, data.doc_number, data.birth_reg_no], [10, 17, 13], { excludeSet: parentExclude, birthYear });
      if (num.length === 13) {
        if (birthYear) {
          num = birthYear + num;
          data.nid_converted_to_17 = true;
        } else {
          warnings.push('১৩ সংখ্যার NID-র জন্মসাল না পাওয়ায় ১৭ সংখ্যায় রূপান্তর করা যায়নি।');
        }
      }
      data.doc_type = 'nid';
      data.doc_number = num;
      data.nid_number = num;
      data.birth_reg_no = '';
      if (num.length !== 10 && num.length !== 17) {
        warnings.push(`NID নম্বরটি ${num.length || 0} সংখ্যার (১০ বা ১৭ সংখ্যা প্রয়োজন) — যাচাই করুন।`);
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
      warnings.push('জন্ম তারিখ (DD/MM/YYYY) স্পষ্ট নয় — মিলিয়ে নিন।');
    }
    if (!['পুরুষ', 'নারী', 'হিজড়া'].includes(String(data.gender || '').trim())) {
      warnings.push('লিঙ্গ স্পষ্ট নয় — নির্বাচন যাচাই করুন।');
    }
    if (!String(data.mother_name_bn || '').trim() && !String(data.mother_name_en || '').trim()) {
      warnings.push('মাতার নাম পড়া যায়নি — প্রয়োজনে হাতে লিখুন।');
    }
    if (data.confidence === 'low') {
      warnings.push('ছবিটি কিছুটা ঝাপসা/অস্পষ্ট মনে হচ্ছে — সাবমিটের আগে সব তথ্য যাচাই করুন।');
    }

    for (const [bnK, enK] of [
      ['name_bn', 'name_en'],
      ['father_name_bn', 'father_name_en'],
      ['mother_name_bn', 'mother_name_en'],
      ['spouse_name_bn', 'spouse_name_en']
    ]) {
      if (data[enK]) data[enK] = normalizeEnglishHonorificPrefix(data[enK], data[bnK]);
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

    data.ocr_warnings = warnings;
    return data;
  }

  function showModalOcrWarnings(warnings) {
    const warnBox = document.getElementById('fc-bm-ocr-warn');
    if (!warnBox) return;
    if (Array.isArray(warnings) && warnings.length > 0) {
      warnBox.innerHTML = warnings.map(w => `⚠️ ${escapeHtml(w)}`).join('<br>');
      warnBox.style.display = 'block';
    } else {
      warnBox.style.display = 'none';
    }
  }

  // Multi-Engine Vision OCR execution (Gemini 3.8 Flash + DeepSeek Vision)
  async function runGeminiOCR(base64Image) {
    if (!saveAndValidateApiKeys()) return;
    showModalOcrWarnings([]);

    const useDsMsg = savedAiProvider === 'deepseek' || (savedDefaultKeySlot === 'deepseek' && Boolean(savedDeepSeekKey) && (savedAiProvider === 'economy' || savedAiProvider === 'auto'));
    const headline = useDsMsg
      ? `DeepSeek (${savedDeepSeekModel}) দিয়ে ডকুমেন্ট স্ক্যান হচ্ছে...`
      : `${savedGeminiModel} দিয়ে ডকুমেন্ট স্ক্যান হচ্ছে...`;
    startBmLoadingProgress(headline);

    loading.style.display = 'block';
    btnCam.style.display = 'none';
    btnGallery.style.display = 'none';

    try {
      let detectedMime = 'image/jpeg';
      let rawBase64 = String(base64Image || '').trim();
      const uriMatch = rawBase64.match(/^data:([^;]+);base64,(.+)$/s);
      if (uriMatch) {
        detectedMime = uriMatch[1] || detectedMime;
        rawBase64 = uriMatch[2];
      }
      rawBase64 = rawBase64.replace(/\s+/g, '');
      if (!rawBase64 || rawBase64.length < 8 || !/^[A-Za-z0-9+/=]+$/.test(rawBase64)) {
        throw new Error('ছবি বা ডকুমেন্ট ডেটা সঠিক নয়। অনুগ্রহ করে আবার স্পষ্ট ছবি তুলুন।');
      }

      const docTypeChoice = selectedDocChoice || (selectMemberDocType ? selectMemberDocType.value : 'auto') || 'auto';

      const rawData = await runMultiProviderOCR({
        aiProvider: savedAiProvider,
        defaultKeySlot: savedDefaultKeySlot,
        geminiModel: savedGeminiModel,
        deepseekModel: savedDeepSeekModel,
        geminiKey: savedApiKey,
        deepseekKey: savedDeepSeekKey,
        rawBase64,
        detectedMime,
        promptText: buildGeminiPrompt(docTypeChoice),
        docType: docTypeChoice,
        onProgress: (pct, stage) => updateBmLoadingProgress(pct, stage, `${headline} (${toBnDigits(pct)}%)`)
      });
      updateBmLoadingProgress(93, 'তথ্য যাচাই ও ইংরেজি সমন্বয় হচ্ছে...', `${headline} (৯৩%)`);
      validateAndNormalizeOcrData(rawData, docTypeChoice);
      const data = normalizeApplicantPayload(rawData);
      stopBmLoadingProgress(100, 'ডকুমেন্ট বিশ্লেষণ সম্পন্ন!');

      data.family_id = scrapeFamilyId() || '';
      window.__fcLastScannedAny = data;
      if (data.ocr_usage) {
        recordScanCostUsage(data.ocr_usage);
        renderBmCostCard();
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
        model: data.ocr_model_used || '',
        usage: data.ocr_usage || null,
        warnings: data.ocr_warnings || [],
        data: { ...data },
        at: new Date().toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })
      });
      if (window.__fcScanHistory.length > 20) window.__fcScanHistory.length = 20;

      showModalOcrWarnings(data.ocr_warnings);

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

        const relChoice = document.getElementById('fc-bm-relation-select')?.value;
        if (relChoice && relChoice !== 'auto') {
          data.relationship = relChoice;
        } else if (data.relation_suggestion) {
          data.relationship = data.relation_suggestion;
        }

        modal.style.display = 'none';
        if (targetCard) {
          await fillMemberCard(targetCard, data);
          handleSection5AndCrossMatch();
          const allCards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
          const realIdx = allCards.indexOf(targetCard);
          const cardIdx = realIdx >= 0 ? (realIdx + 1) : ((typeof activeScanTarget.index === 'number') ? activeScanTarget.index : allCards.length || 2);
          syncMemberToFirestore(data, cardIdx);
          if (data.ocr_warnings.length > 0) {
            showToast(`⚠️ ${data.name_bn || data.doc_number} পূরণ — সতর্কতা: ${data.ocr_warnings[0]}${costTag ? ` • ${costTag}` : ''}`);
          } else {
            showToast(`✅ সদস্য (${data.name_bn || data.doc_number}) পূরণ হয়েছে!${costTag ? ` ${costTag}` : ''}`);
          }
        } else {
          showToast(`⚠️ সদস্য কার্ড পাওয়া যায়নি। অনুগ্রহ করে প্রথমে '+ নতুন সদস্য' যোগ করুন।`);
        }
      } else {
        // Applicant flow (normalizes Step 1 + Step 2 fields, caches by family_id)
        data.marital_status = document.getElementById('fc-bm-marital').value || data.marital_status_suggestion || 'বিবাহিত';
        data.religion = document.getElementById('fc-bm-religion').value || 'ইসলাম';
        const normMob = normalizeMobileNumber(document.getElementById('fc-bm-mobile').value.trim());
        data.mobile_number = normMob;
        if (normMob && !/^01[3-9]\d{8}$/.test(normMob)) {
          data.ocr_warnings.push('মোবাইল নম্বরটি সঠিক ১১ সংখ্যার (01XXXXXXXXX) নয়।');
        }

        lastExtractedData = data;
        cacheFamilyScan(data);
        adoptOrStartPortalTimerForScan(data, { startReason: 'bm_ocr_scan' });
        renderLastScanPreview(data);
        window.__fcStep1FilledKey = '';
        modal.style.display = 'none';

        await fillPortalFields(data, { overwriteExisting: true });
        if (data.ocr_warnings.length > 0) {
          showToast(`⚠️ NID তথ্য পূরণ — সতর্কতা: ${data.ocr_warnings[0]}${costTag ? ` • ${costTag}` : ''}`);
        } else {
          showToast(`✅ এনআইডি তথ্য সফলভাবে পূরণ হয়েছে!${costTag ? ` ${costTag}` : ''}`);
        }
        syncToFirestore(data);
      }
      updateSummaryBadge(true);
    } catch (err) {
      stopBmLoadingProgress(0, 'ত্রুটি হয়েছে');
      fcLogTelemetry('error', 'runGeminiOCR', err.message || 'Unknown OCR error', `provider=${savedAiProvider}`);
      alert('স্ক্যান ব্যর্থ হয়েছে: ' + err.message);
    } finally {
      loading.style.display = 'none';
      btnCam.style.display = 'flex';
      btnGallery.style.display = 'flex';
    }
  }

  // Direct Firestore REST API Sync (rajbari-city-app-16601)
  async function syncToFirestore(data) {
    try {
      const docId = getSafeFamilyDocId(data);
      if (!docId || (!data.name_bn && !data.name_en)) {
        console.warn('[FamilyCard] Skipped Firestore applicant sync: no valid document id or extracted name');
        return;
      }

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
        marital_status: { stringValue: data.marital_status || '' },
        religion: { stringValue: data.religion || '' },
        mobile_number: { stringValue: data.mobile_number || '' },
        ocr_model_used: { stringValue: data.ocr_model_used || '' },
        synced_at: { timestampValue: new Date().toISOString() }
      };
      if (data.family_id) fields.family_id = { stringValue: normalizeDigits(data.family_id) };

      const updateMask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
      const url = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(docId)}?${updateMask}`;

      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
      console.log('[FamilyCard] Firestore synced successfully:', docId);
    } catch (e) {
      console.warn('[FamilyCard] Background Firestore sync notice:', e.message);
    }
  }

  // ==========================================================================
  // ☁️ SMART CLOUD BACKUP & RECOVERY ENGINE (Step 1 to Step 11 Auto-Trace)
  // ==========================================================================
  let lastSavedStepBackupHash = '';
  let smartBackupThrottleTimer = null;
  let isBackingUpSteps = false;

  function safeSetLocalStorage(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch (e) {
      try {
        const backupKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('fc_step_backup_')) backupKeys.push(k);
        }
        if (backupKeys.length > 4) {
          backupKeys.slice(0, Math.ceil(backupKeys.length / 2)).forEach(k => localStorage.removeItem(k));
          localStorage.removeItem('fc_app_v18');
          localStorage.removeItem('fc_app_v15');
          localStorage.setItem(key, val);
        }
      } catch (_) {}
    }
  }

  function selectDropdownByLabel(labelKeywords, targetValueText, rootEl = null, opts = {}) {
    if (typeof selectDropdown === 'function') {
      return selectDropdown(labelKeywords, targetValueText, rootEl, opts);
    }
    return Promise.resolve(false);
  }

  function extractFullStepsBackupData() {
    const fid = scrapeFamilyId() || lastExtractedData?.family_id || lastExtractedData?.nid_number || '';
    const summary = typeof collectFullFamilyCardSummary === 'function' ? collectFullFamilyCardSummary() : null;
    const tab0 = document.querySelector('[data-family-card-tab="0"]');
    const tab1 = document.querySelector('[data-family-card-tab="1"]');
    const tab2 = document.querySelector('[data-family-card-tab="2"]');
    const tab3 = document.querySelector('[data-family-card-tab="3"]');
    const tab4 = document.querySelector('[data-family-card-tab="4"]');
    const tab5 = document.querySelector('[data-family-card-tab="5"]');
    const tab6 = document.querySelector('[data-family-card-tab="6"]');
    const tab7 = document.querySelector('[data-family-card-tab="7"]');
    const tab9 = document.querySelector('[data-family-card-tab="9"]');
    const tab10 = document.querySelector('[data-family-card-tab="10"]');
    const tab11 = document.querySelector('[data-family-card-tab="11"]');

    const s2State = tab1 ? readStep2FieldState(tab1) : {};
    const s3Media = tab9 ? inspectSection3Media(tab9) : (summary?.s3Media || {});
    const s4Addr = tab2 ? inspectSection4Address(tab2) : (summary?.s4Addr || {});
    const s5Data = inspectSection5Details()?.data || (typeof trackSection5Data === 'function' ? trackSection5Data() : null) || summary?.sec5 || {};
    const s6Bank = typeof inspectSection6Bank === 'function' ? inspectSection6Bank() : {};
    const s7Elig = typeof inspectSection7Eligibility === 'function' ? inspectSection7Eligibility() : {};
    const s8Scan = typeof scanFamilyMembers === 'function' ? scanFamilyMembers() : null;
    const s8Members = Array.isArray(summary?.members)
      ? summary.members
      : (Array.isArray(s8Scan) ? s8Scan : (Array.isArray(s8Scan?.membersDetail) ? s8Scan.membersDetail : []));
    const s9Elems = typeof getSection9MoneyElements === 'function' ? getSection9MoneyElements() : null;
    const s9Money = s9Elems && typeof readCurrentMoneyDistribution === 'function' ? readCurrentMoneyDistribution(s9Elems.fields) : (summary?.s9Dist || {});
    const s10User = typeof inspectSection10EntryUser === 'function' ? inspectSection10EntryUser() : {};
    const c11Consent = typeof inspectSection11Consent === 'function' ? inspectSection11Consent() : {};

    const applicant = summary?.applicant || {};
    const nid = applicant.nid || lastExtractedData?.nid_number || lastExtractedData?.doc_number || fid;

    return {
      familyId: fid || nid || `fc_${Date.now()}`,
      nid: nid || '',
      backupTimestamp: new Date().toISOString(),
      clientTimestampMs: Date.now(),
      backupSource: 'bookmarklet_smart_engine',
      gps: lastCapturedHouseGps || null,
      readinessPct: summary?.readinessPct || 0,
      blockers: (summary?.blockers || []).map(b => (typeof b === 'object' ? b.text : b)),

      // Step 1: Verification
      step1: {
        docType: lastExtractedData?.doc_type || 'nid',
        docNumber: nid,
        dob: applicant.dob || lastExtractedData?.dob || '',
        gender: lastExtractedData?.gender || ''
      },

      // Step 2: Personal information
      step2: {
        nameBn: lastExtractedData?.name_bn || applicant.nameBn || '',
        nameEn: lastExtractedData?.name_en || applicant.nameEn || '',
        fatherBn: s2State.fatherBn || applicant.fatherBn || lastExtractedData?.father_name_bn || '',
        fatherEn: s2State.fatherEn || lastExtractedData?.father_name_en || '',
        motherBn: s2State.motherBn || applicant.motherBn || lastExtractedData?.mother_name_bn || '',
        motherEn: s2State.motherEn || lastExtractedData?.mother_name_en || '',
        spouseBn: lastExtractedData?.spouse_name_bn || '',
        spouseEn: lastExtractedData?.spouse_name_en || '',
        mobile: s2State.mobile || applicant.mobile || lastExtractedData?.mobile_number || '',
        maritalStatus: s2State.marital || lastExtractedData?.marital_status || 'বিবাহিত',
        religion: s2State.religion || lastExtractedData?.religion || 'ইসলাম'
      },

      // Step 3: Media
      step3: {
        photoUrl: s3Media.photoUrl || lastExtractedData?.applicant_photo_url || '',
        signatureUrl: s3Media.signatureUrl || lastExtractedData?.signature_url || '',
        houseUrl: s3Media.houseUrl || lastExtractedData?.house_photo_url || ''
      },

      // Step 4: Address
      step4: {
        village: s4Addr.village || (typeof getSavedAddressConfig === 'function' ? getSavedAddressConfig().village : '') || '',
        postcode: s4Addr.postcode || (typeof getSavedAddressConfig === 'function' ? getSavedAddressConfig().postcode : '') || ''
      },

      // Step 5: Household & Economics
      step5: {
        totalMembers: s5Data.totalCount || 0,
        maleCount: s5Data.maleCount || 0,
        femaleCount: s5Data.femaleCount || 0,
        transCount: s5Data.transCount || 0,
        abroadMale: s5Data.abroadMale || 0,
        abroadFemale: s5Data.abroadFemale || 0,
        abroadTrans: s5Data.abroadTrans || 0,
        socialTraining: s5Data.training || 'না',
        mfsAccount: s5Data.mfs || 'নগদ'
      },

      // Step 6: Bank / MFS
      step6: {
        isBankAccount: Boolean(s6Bank.isBankAccount),
        branchText: s6Bank.branchText || '',
        ownership: s6Bank.ownership || '',
        accountTypeText: s6Bank.elems?.accountTypeText || ''
      },

      // Step 7: Eligibility Questions
      step7: {
        totalQuestions: s7Elig.totalQuestions || 24,
        filledCount: s7Elig.filledCount || 0,
        roomsVal: s7Elig.roomsVal || ''
      },

      // Step 8: Family Members
      step8_members: (Array.isArray(s8Members) ? s8Members : []).map((m, idx) => ({
        index: idx + 1,
        title: m.title || `সদস্য ${idx + 1}`,
        nameBn: m.nameBn || '',
        docType: m.docType || 'nid',
        docNum: m.docNum || '',
        relation: m.relation || m.rel || '',
        age: m.age ?? '',
        gender: m.gender || ''
      })),

      // Step 9: Money distribution (2500 BDT)
      step9_money: {
        total: s9Money.total || 2500,
        food: s9Money.food || 0,
        health: s9Money.health || 0,
        education: s9Money.education || 0,
        income: s9Money.income || 0,
        housing: s9Money.housing || 0,
        clothing: s9Money.clothing || 0,
        debt: s9Money.debt || 0,
        savings: s9Money.savings || 0,
        other: s9Money.other || 0
      },

      // Step 10: Entry User info
      step10_user: {
        filledCount: s10User.filledCount || 0,
        totalFields: s10User.totalFields || 0,
        fields: (s10User.fields || []).map(f => ({ label: f.label, value: f.value }))
      },

      // Step 11: Final declaration
      step11_consent: {
        agreed: Boolean(c11Consent.agreed)
      }
    };
  }

  function updateBackupUIBadge(msg = '', isSuccess = true) {
    const badge1 = document.getElementById('fc-s2-backup-badge');
    const badge2 = document.getElementById('fc-bm-dock-backup-pill');
    const txt = msg || `☁️ ব্যাকআপ: ধাপ ১–১১ ক্লাউডে সংরক্ষিত (${new Date().toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })})`;

    if (badge1) {
      badge1.textContent = txt;
      badge1.style.background = isSuccess ? '#dcfce7' : '#fffbeb';
      badge1.style.color = isSuccess ? '#15803d' : '#92400e';
    }
    if (badge2) {
      badge2.textContent = isSuccess ? '✓' : '⏳';
      badge2.title = txt;
      badge2.style.display = 'inline-block';
    }
  }

  async function triggerSmartCloudBackup(reason = 'auto', force = false) {
    if (isBackingUpSteps && !force) return;
    const backupData = extractFullStepsBackupData();
    const fid = backupData.familyId || backupData.nid;
    if (!fid || fid === 'fc_' || fid.length < 4) return;

    const sig = `${fid}|${backupData.step2.nameBn}|${backupData.step2.mobile}|${backupData.step5.totalMembers}|${backupData.step8_members.length}|${backupData.step9_money.total}|${backupData.readinessPct}|${backupData.step11_consent.agreed}`;
    if (!force && sig === lastSavedStepBackupHash) return;
    lastSavedStepBackupHash = sig;

    isBackingUpSteps = true;
    try {
      // 1. Always save locally first (Zero data loss even on crash/refresh)
      safeSetLocalStorage(`fc_step_backup_${fid}`, JSON.stringify(backupData));
      safeSetLocalStorage('fc_last_backup_meta', JSON.stringify({
        fid,
        ladyName: backupData.step2.nameBn || '',
        timestamp: backupData.backupTimestamp,
        readiness: backupData.readinessPct
      }));

      // 2. Prepare structured Firestore root fields
      const cleanFid = normalizeDigits(fid).replace(/[^0-9A-Za-z_-]/g, '');
      const s2 = backupData.step2;
      const s5 = backupData.step5;
      const s9 = backupData.step9_money;

      const fields = {
        name_bn: { stringValue: s2.nameBn || '' },
        name_en: { stringValue: s2.nameEn || '' },
        dob: { stringValue: backupData.step1.dob || '' },
        gender: { stringValue: backupData.step1.gender || '' },
        father_name_bn: { stringValue: s2.fatherBn || '' },
        father_name_en: { stringValue: s2.fatherEn || '' },
        mother_name_bn: { stringValue: s2.motherBn || '' },
        mother_name_en: { stringValue: s2.motherEn || '' },
        spouse_name_bn: { stringValue: s2.spouseBn || '' },
        spouse_name_en: { stringValue: s2.spouseEn || '' },
        mobile_number: { stringValue: s2.mobile || '' },
        marital_status: { stringValue: s2.maritalStatus || 'বিবাহিত' },
        religion: { stringValue: s2.religion || 'ইসলাম' },
        village: { stringValue: backupData.step4.village || '' },
        postcode: { stringValue: backupData.step4.postcode || '' },
        section5_total_declared: { integerValue: String(s5.totalMembers || 0) },
        section5_male_declared: { integerValue: String(s5.maleCount || 0) },
        section5_female_declared: { integerValue: String(s5.femaleCount || 0) },
        section5_trans_declared: { integerValue: String(s5.transCount || 0) },
        section5_mfs_account: { stringValue: s5.mfsAccount || 'নগদ' },
        money_total: { integerValue: String(s9.total || 2500) },
        money_food: { integerValue: String(s9.food || 0) },
        money_health: { integerValue: String(s9.health || 0) },
        money_education: { integerValue: String(s9.education || 0) },
        money_income: { integerValue: String(s9.income || 0) },
        money_housing: { integerValue: String(s9.housing || 0) },
        money_clothing: { integerValue: String(s9.clothing || 0) },
        money_debt: { integerValue: String(s9.debt || 0) },
        money_savings: { integerValue: String(s9.savings || 0) },
        summary_readiness_pct: { integerValue: String(backupData.readinessPct || 0) },
        summary_member_count: { integerValue: String(backupData.step8_members.length || 0) },
        backup_reason: { stringValue: String(reason || 'auto') },
        backup_timestamp: { timestampValue: backupData.backupTimestamp },
        latest_backup_json: { stringValue: JSON.stringify(backupData) }
      };

      if (backupData.gps && typeof backupData.gps.lat === 'number') {
        fields.lat = { doubleValue: backupData.gps.lat };
        fields.lng = { doubleValue: backupData.gps.lng };
        fields.accuracy = { integerValue: String(backupData.gps.accuracy || 10) };
        fields.plus_code = { stringValue: backupData.gps.plusCode || '' };
        fields.geo_recorded_at = { timestampValue: backupData.backupTimestamp };
      }

      if (backupData.readinessPct >= 85 && backupData.blockers.length === 0) {
        fields.survey_status = { stringValue: 'COMPLETED' };
      }

      const updateMask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
      const rootUrl = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(cleanFid)}?${updateMask}`;

      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), 7500);

      const resp = await fetch(rootUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
        signal: ac.signal
      });
      clearTimeout(tm);

      if (resp.ok) {
        // Also push a subcollection snapshot record asynchronously
        const subUrl = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(cleanFid)}/backups/bk_${Date.now()}?updateMask.fieldPaths=backup_json&updateMask.fieldPaths=timestamp&updateMask.fieldPaths=readiness_pct`;
        fetch(subUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              backup_json: { stringValue: JSON.stringify(backupData) },
              timestamp: { timestampValue: backupData.backupTimestamp },
              readiness_pct: { integerValue: String(backupData.readinessPct || 0) }
            }
          })
        }).catch(() => {});

        updateBackupUIBadge();
      } else {
        // Queue for offline sync
        queueOfflineBackup(cleanFid, fields);
        updateBackupUIBadge('☁️ ব্যাকআপ: অফলাইনে সংরক্ষিত (সংযোগ পেলে ক্লাউডে যাবে)', false);
      }
    } catch (err) {
      console.warn('[SmartCloudBackup] Network fallback notice:', err.message);
      updateBackupUIBadge('☁️ ব্যাকআপ: অফলাইনে সংরক্ষিত', false);
    } finally {
      isBackingUpSteps = false;
    }
  }

  function queueOfflineBackup(fid, fields) {
    try {
      const q = JSON.parse(localStorage.getItem('fc_offline_backup_queue') || '[]');
      const filtered = q.filter(item => item.fid !== fid);
      filtered.push({ fid, fields, queuedAt: Date.now() });
      localStorage.setItem('fc_offline_backup_queue', JSON.stringify(filtered.slice(-15)));
    } catch (_) {}
  }

  async function flushOfflineBackupQueue() {
    if (!navigator.onLine) return;
    try {
      const raw = localStorage.getItem('fc_offline_backup_queue');
      if (!raw) return;
      const queue = JSON.parse(raw);
      if (!Array.isArray(queue) || !queue.length) return;

      const remaining = [];
      for (const item of queue) {
        try {
          const updateMask = Object.keys(item.fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
          const url = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(item.fid)}?${updateMask}`;
          const r = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: item.fields })
          });
          if (!r.ok) remaining.push(item);
        } catch (_) {
          remaining.push(item);
        }
      }
      localStorage.setItem('fc_offline_backup_queue', JSON.stringify(remaining));
      if (remaining.length === 0) {
        updateBackupUIBadge('☁️ অফলাইন ব্যাকআপ স্বয়ংক্রিয়ভাবে ক্লাউডে সিঙ্ক সম্পন্ন! ✅');
      }
    } catch (_) {}
  }

  window.addEventListener('online', flushOfflineBackupQueue);
  setInterval(flushOfflineBackupQueue, 15000);

  // Restore All Steps from Smart Cloud Backup
  async function restorePortalFromSmartBackup(customFid = '') {
    const fid = customFid || scrapeFamilyId() || '';
    if (!fid) {
      showToast('⚠️ পরিবারের আইডি বা NID পাওয়া যায়নি!');
      return false;
    }

    showToast(`⏳ আইডি ${toBnDigits(fid)}-এর ক্লাউড ব্যাকআপ খোঁজা হচ্ছে...`);
    let backupObj = null;

    // 1. Try cloud Firestore first
    try {
      const cleanFid = normalizeDigits(fid).replace(/[^0-9A-Za-z_-]/g, '');
      const url = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(cleanFid)}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const doc = await res.json().catch(() => null);
        const jsonStr = doc?.fields?.latest_backup_json?.stringValue;
        if (jsonStr) backupObj = JSON.parse(jsonStr);
      }
    } catch (_) {}

    // 2. Try localStorage fallback
    if (!backupObj) {
      try {
        const local = localStorage.getItem(`fc_step_backup_${fid}`);
        if (local) backupObj = JSON.parse(local);
      } catch (_) {}
    }

    if (!backupObj) {
      showToast(`❌ আইডি ${toBnDigits(fid)}-এর কোনো সংরক্ষিত ব্যাকআপ পাওয়া যায়নি!`);
      return false;
    }

    // 3. Begin restoring across all portal steps:
    let restoredSteps = 0;

    // Step 1: Verification
    if (backupObj.step1 && backupObj.step1.docNumber) {
      await fillPortalFields({
        doc_type: backupObj.step1.docType || 'nid',
        doc_number: backupObj.step1.docNumber,
        dob: backupObj.step1.dob || '',
        gender: backupObj.step1.gender || '',
        name_bn: backupObj.step2?.nameBn || '',
        name_en: backupObj.step2?.nameEn || ''
      }, { overwriteExisting: true });
      restoredSteps++;
    }

    // Step 2: Personal details
    if (backupObj.step2) {
      const s2 = backupObj.step2;
      const tab1 = document.querySelector('[data-family-card-tab="1"]') || document;
      if (s2.maritalStatus) await selectDropdownByLabel(['বৈবাহিক অবস্থা'], s2.maritalStatus, tab1, { ignoreUserGuard: true });
      if (s2.religion) await selectDropdownByLabel(['ধর্ম'], s2.religion, tab1, { ignoreUserGuard: true });
      await fillPortalFields({
        name_bn: s2.nameBn,
        name_en: s2.nameEn,
        father_name_bn: s2.fatherBn,
        father_name_en: s2.fatherEn,
        mother_name_bn: s2.motherBn,
        mother_name_en: s2.motherEn,
        spouse_name_bn: s2.spouseBn,
        spouse_name_en: s2.spouseEn,
        mobile_number: s2.mobile
      }, { overwriteExisting: true });
      restoredSteps++;
    }

    // Step 4: Address
    if (backupObj.step4?.village || backupObj.step4?.postcode) {
      if (typeof saveAddressConfig === 'function') {
        saveAddressConfig({ village: backupObj.step4.village, postcode: backupObj.step4.postcode });
      }
      if (typeof handleSection4Address === 'function') handleSection4Address();
      restoredSteps++;
    }

    // Step 5: Household
    if (backupObj.step5 && backupObj.step5.totalMembers > 0) {
      if (typeof saveSection5Config === 'function') {
        saveSection5Config({
          transCount: backupObj.step5.transCount,
          training: backupObj.step5.socialTraining,
          mfsAccount: backupObj.step5.mfsAccount
        });
      }
      if (typeof handleSection5AndCrossMatch === 'function') handleSection5AndCrossMatch();
      restoredSteps++;
    }

    // Step 6: Bank
    if (typeof handleSection6Bank === 'function') {
      handleSection6Bank();
      restoredSteps++;
    }

    // Step 8: Family Members (সদস্য তালিকা পুনরুদ্ধার)
    if (Array.isArray(backupObj.step8_members) && backupObj.step8_members.length > 0) {
      try {
        let memberCards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
        let memRestored = 0;
        for (let i = 0; i < backupObj.step8_members.length; i++) {
          const m = backupObj.step8_members[i];
          let card = memberCards[i];
          if (!card && typeof triggerPortalAddMember === 'function') {
            triggerPortalAddMember();
            await new Promise(r => setTimeout(r, 380));
            memberCards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
            card = memberCards[memberCards.length - 1];
          }
          if (card && typeof fillMemberCard === 'function') {
            await fillMemberCard(card, {
              doc_type: m.docType || 'nid',
              doc_number: m.docNum || '',
              name_bn: m.nameBn || '',
              relation: m.relation || '',
              age: m.age || '',
              gender: m.gender || ''
            });
            memRestored++;
          }
        }
        if (memRestored > 0) restoredSteps++;
      } catch (_) {}
    }

    // Step 9: Money allocation
    if (backupObj.step9_money && typeof applyMoneyDistribution === 'function') {
      const s9Elems = typeof getSection9MoneyElements === 'function' ? getSection9MoneyElements() : null;
      if (s9Elems) {
        applyMoneyDistribution(s9Elems.fields, backupObj.step9_money, true);
        restoredSteps++;
      }
    }

    // Step 11: Final consent
    if (backupObj.step11_consent?.agreed && typeof handleSection11Consent === 'function') {
      const c11 = inspectSection11Consent();
      if (c11.checkbox && !c11.agreed) {
        c11.checkbox.click();
      }
      restoredSteps++;
    }

    if (typeof updateSummaryBadge === 'function') updateSummaryBadge(true);
    showToast(`✅ ক্লাউড ব্যাকআপ থেকে ধাপ ১–১১ সফলভাবে পুনরুদ্ধার করা হয়েছে (${toBnDigits(restoredSteps)}টি সেকশন)!`);
    return true;
  }

  // --- SECTION 8: FAMILY MEMBER AUTOMATION HELPERS ---
  function openMemberScanner(card = null, index = 'auto') {
    setScanTarget('member', card, index);
    modal.style.display = 'flex';
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

  function isElementVisible(el) {
    if (!el) return false;
    if (el.style && el.style.display === 'none') return false;
    try {
      const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    } catch (_) {}
    return true;
  }

  // Portal keeps v-expansion-panel--active on all tabs and switches via style="display: none;"
  function isPanelActiveVisible(panel) {
    return Boolean(panel && isElementVisible(panel));
  }

  function resolveDocNumberAndType(data) {
    if (!data || typeof data !== 'object') return { docType: 'nid', docNumber: '' };
    const birthYear = getDobYear(data.dob || '');
    const excludeSet = new Set([extractDigitCandidate(data.father_nid), extractDigitCandidate(data.mother_nid), extractDigitCandidate(data.dob)].filter(Boolean));
    const rawBrc = extractDigitCandidate(data.birth_reg_no || data.brc_number);
    const rawNidAll = extractDigitCandidate(data.nid_number);
    const rawNid = rawNidAll && !excludeSet.has(rawNidAll) ? rawNidAll : '';
    const rawDoc = extractDigitCandidate(data.doc_number);
    const isBrc = data.doc_type === 'birth_certificate' || (!rawNid && rawBrc.length === 17);
    const docType = isBrc ? 'birth_certificate' : 'nid';
    let docNumber = isBrc
      ? pickBestDocDigits([rawBrc, rawDoc, rawNid], [17], { excludeSet, birthYear })
      : pickBestDocDigits([rawNid, rawDoc, rawBrc], [10, 17, 13], { excludeSet, birthYear });
    if (!isBrc && docNumber.length === 13 && birthYear) {
      docNumber = birthYear + docNumber;
    }
    return { docType, docNumber };
  }

  function isRadioSelected(radioWrap) {
    if (!radioWrap) return false;
    const inp = radioWrap.querySelector('input[type="radio"]');
    return Boolean((inp && (inp.checked || inp.getAttribute('aria-checked') === 'true')) || radioWrap.classList.contains('v-item--active'));
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

  async function ensureVerificationRadio(scope, isBirthReg) {
    if (!scope) return false;
    const isSel = (el) => {
      if (!el) return false;
      const inp = el.matches && el.matches('input[type="radio"]') ? el : el.querySelector('input[type="radio"]');
      return Boolean((inp && (inp.checked || inp.getAttribute('aria-checked') === 'true')) || (el.classList && el.classList.contains('v-item--active')));
    };
    let candidates = Array.from(scope.querySelectorAll('.v-radio, .v-selection-control')).map((wrap) => ({
      wrap,
      inp: wrap.querySelector('input[type="radio"]'),
      label: wrap.querySelector('label'),
      text: normalizeBn(wrap.textContent || '').toLowerCase()
    }));
    if (!candidates.length) {
      candidates = Array.from(scope.querySelectorAll('input[type="radio"]')).map((inp) => {
        const label = (inp.labels && inp.labels[0]) || inp.closest('label') || (inp.id ? scope.querySelector(`label[for="${inp.id}"]`) : null);
        const wrap = inp.closest('.v-radio, .v-selection-control, label, div') || inp;
        return {
          wrap,
          inp,
          label,
          text: normalizeBn((label ? label.textContent : '') || (wrap ? wrap.textContent : '') || inp.value || '').toLowerCase()
        };
      });
    }
    if (!candidates.length) return false;
    const nidRadioKeys = ['জাতীয় পরিচিতি', 'জাতীয় পরিচয়', 'পরিচয়পত্র', 'পরিচিতি নম্বর', 'এনআইডি', 'nid'].map(k => normalizeBn(k));
    const brcRadioKeys = ['জন্ম নিবন্ধন', 'নিবন্ধন', 'birth'].map(k => normalizeBn(k));
    const target = candidates.find((rl) => {
      const txt = rl.text;
      return isBirthReg
        ? brcRadioKeys.some(k => txt.includes(k))
        : nidRadioKeys.some(k => txt.includes(k));
    });
    if (!target) return false;
    if (!(isSel(target.wrap) || isSel(target.inp))) {
      if (target.label) target.label.click();
      if (!(isSel(target.wrap) || isSel(target.inp)) && target.inp) target.inp.click();
      if (!(isSel(target.wrap) || isSel(target.inp)) && target.wrap && target.wrap !== target.label && target.wrap !== target.inp) target.wrap.click();
      await new Promise((r) => setTimeout(r, 320));
      return true;
    }
    return false;
  }

  async function fillMemberCard(card, data) {
    if (!card || !data) return;

    const { docType, docNumber } = resolveDocNumberAndType(data);
    const isBirthReg = docType === 'birth_certificate';

    // 1. Verification Type Radio (NID vs Birth Certificate) — scoped strictly to .v-radio
    await ensureVerificationRadio(card, isBirthReg);

    function findCardInput(specOrKeywords, extraOpts = {}) {
      return findInputByLabel(specOrKeywords, card, extraOpts);
    }

    async function selectCardDropdown(keywords, candidates) {
      const normKeys = keywords.map(k => normalizeBn(k));
      const labels = Array.from(card.querySelectorAll('label'));
      let container = null;
      for (const label of labels) {
        if (label.closest('.v-radio, .v-checkbox, .v-input--selection-controls, [role="radiogroup"]')) continue;
        const text = normalizeBn(label.textContent || '');
        if (normKeys.some(k => text.includes(k))) {
          container = label.closest('.v-input') || label.closest('.col, [class*="col-"]') || label.parentElement;
          break;
        }
      }
      if (!container) return;
      await selectSingleVuetifyOption(container, candidates);
    }

    // 2. Identification number (poll up to 800ms if Vuetify swaps field after radio switch)
    if (docNumber) {
      const numSpec = isBirthReg ? FC_FIELD_SPECS.docBrc : FC_FIELD_SPECS.docNid;
      let idInp = findCardInput(numSpec);
      for (let t = 0; !idInp && t < 8; t++) {
        await new Promise(r => setTimeout(r, 100));
        idInp = findCardInput(numSpec);
      }
      if (idInp) setReactiveValue(idInp, docNumber);
    }

    // 3. Date of birth
    if (data.dob) {
      const dobInp = findCardInput(FC_FIELD_SPECS.dob);
      if (dobInp) setReactiveValue(dobInp, data.dob);
    }

    // 4. Name Bangla
    if (data.name_bn) {
      const bnInp = findCardInput(FC_FIELD_SPECS.nameBn);
      if (bnInp) setReactiveValue(bnInp, data.name_bn);
    }

    // 5. Name English
    if (data.name_en) {
      const enInp = findCardInput(FC_FIELD_SPECS.nameEn);
      if (enInp) setReactiveValue(enInp, data.name_en.toUpperCase());
    }

    // 6. Relationship with Household Head
    const rel = data.relationship || data.relation_suggestion || '';
    if (rel) {
      await selectCardDropdown(['সম্পর্ক'], [rel]);
    }

    // 7. Father's Name Bangla & English
    if (data.father_name_bn) {
      const fbn = findCardInput(FC_FIELD_SPECS.fatherBn);
      if (fbn) setReactiveValue(fbn, data.father_name_bn);
    }
    if (data.father_name_en) {
      const fen = findCardInput(FC_FIELD_SPECS.fatherEn);
      if (fen) setReactiveValue(fen, data.father_name_en.toUpperCase());
    }

    // 8. Mother's Name Bangla & English
    if (data.mother_name_bn) {
      const mbn = findCardInput(FC_FIELD_SPECS.motherBn);
      if (mbn) setReactiveValue(mbn, data.mother_name_bn);
    }
    if (data.mother_name_en) {
      const men = findCardInput(FC_FIELD_SPECS.motherEn);
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

    // 12. Apply full Section 8 smart defaults & conditional rules (disability, health, occupation, radios, literacy, gov card)
    await applyMemberSmartDefaults(card, { force: true, extraGender: data.gender || '', extraDob: data.dob || '' });

    card.dataset.fcMemberAutoFilled = 'true';
    trackSection8Data();
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
        console.warn('[FamilyCard] Skipped Firestore member sync: no family_id available');
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
      console.log('[FamilyCard] Member synced to Firestore:', memberDocId);
    } catch (err) {
      console.warn('[FamilyCard] Firestore member sync notice:', err.message);
    }
  }

  // --- Vuetify Reactivity & Synthetic Event Dispatcher ---
  function attachInputEditGuard(input, flagKey = 'fcUserEdited') {
    if (!input || input.__fcEditGuardAttached) return;
    input.__fcEditGuardAttached = true;
    input.addEventListener('input', (e) => {
      if (e.isTrusted) input.dataset[flagKey] = 'true';
    });
  }

  function setReactiveValue(input, value, opts = {}) {
    if (!input || value === undefined || value === null || value === '') return false;
    if (input.disabled) return false;
    const isDateInput = /DD\/MM/i.test(input.placeholder || '') || input.getAttribute('aria-haspopup') === 'true';
    if (input.readOnly && !isDateInput && input.closest && input.closest('.v-input--is-readonly')) return false;
    const nextVal = String(value).trim();
    if (!nextVal) return false;
    const curVal = String(input.value || '').trim();
    if (!opts.ignoreUserGuard && input.dataset?.fcUserEdited === 'true' && curVal) return false;
    if (!opts.ignoreUserGuard && opts.respectNonEmpty && curVal !== '') return false;
    if (!opts.allowSameValue && curVal === nextVal) return false;

    input.focus();

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(input, nextVal);
    } else {
      input.value = nextVal;
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));

    // Dismiss Vuetify date-picker menu if focusing a DOB field opened it
    if (isDateInput) {
      setTimeout(() => {
        if (document.querySelector('.v-menu__content.menuable__content__active .v-picker--date')) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
      }, 60);
    }

    const container = (input.closest && input.closest('.v-input')) || input;
    if (container && container.style) {
      container.style.transition = 'background-color 0.4s ease';
      const oldBg = container.style.backgroundColor;
      container.style.backgroundColor = 'rgba(76, 175, 80, 0.2)';
      setTimeout(() => { container.style.backgroundColor = oldBg; }, 2200);
    }
    return true;
  }

  function isFillableTextInput(inp) {
    if (!inp || inp.disabled) return false;
    const t = String(inp.type || 'text').toLowerCase();
    if (['hidden', 'radio', 'checkbox', 'file', 'button', 'submit', 'reset', 'image'].includes(t)) return false;
    if (inp.closest('.v-radio, .v-checkbox, .v-input--selection-controls, [role="radiogroup"]')) return false;
    if (inp.readOnly && !/DD\/MM/i.test(inp.placeholder || '') && (inp.closest('.v-input--is-readonly') || (inp.closest('.v-select') && !inp.closest('.v-autocomplete')))) return false;
    return true;
  }

  function normalizeLabelForMatch(str) {
    return normalizeBn(str || '')
      .toLowerCase()
      .replace(/[*ঃ:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resolveFieldSpec(specOrKeywords, opts = {}) {
    if (specOrKeywords && !Array.isArray(specOrKeywords) && Array.isArray(specOrKeywords.keys)) {
      return {
        keys: specOrKeywords.keys,
        exclude: [...(specOrKeywords.exclude || []), ...(opts.exclude || [])]
      };
    }
    return {
      keys: Array.isArray(specOrKeywords) ? specOrKeywords : [specOrKeywords].filter(Boolean),
      exclude: opts.exclude || []
    };
  }

  function matchesLabelSpec(labelRaw, keywordNorm, excludeNorms) {
    const cleanLbl = normalizeLabelForMatch(labelRaw);
    if (!cleanLbl) return 0;
    if (excludeNorms.some(ex => ex && cleanLbl.includes(ex))) return 0;
    const compactLbl = cleanLbl.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    const compactKey = keywordNorm.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanLbl === keywordNorm || compactLbl === compactKey) return 3;
    if (cleanLbl.startsWith(keywordNorm) || compactLbl.startsWith(compactKey)) return 2;
    if (cleanLbl.includes(keywordNorm) || compactLbl.includes(compactKey)) return 1;
    return 0;
  }

  function findInputByLabel(specOrKeywords, rootEl = null, opts = {}) {
    const scope = rootEl || document;
    const { keys, exclude } = resolveFieldSpec(specOrKeywords, opts);
    const entries = collectTabFieldEntries(scope);
    const hit = findEntryByKeywords(entries, { keys, exclude });
    if (hit && hit.input && isFillableTextInput(hit.input)) return hit.input;

    const normKeys = keys.map(normalizeLabelForMatch).filter(Boolean);
    const normExcludes = exclude.map(normalizeLabelForMatch).filter(Boolean);
    const labels = Array.from(scope.querySelectorAll('label'));
    for (const k of normKeys) {
      let bestMatch = null;
      let bestScore = 0;
      for (const label of labels) {
        if (label.closest('.v-radio, .v-checkbox, .v-input--selection-controls, [role="radiogroup"]')) continue;
        const score = matchesLabelSpec(label.textContent || '', k, normExcludes);
        if (score <= bestScore) continue;
        let inp = null;
        if (label.htmlFor) {
          const byFor = document.getElementById(label.htmlFor);
          if (isFillableTextInput(byFor) && (!rootEl || rootEl.contains(byFor))) inp = byFor;
        }
        if (!inp) {
          const vInput = label.closest('.v-input');
          if (vInput) inp = Array.from(vInput.querySelectorAll('input, textarea')).find(isFillableTextInput) || null;
        }
        if (inp) {
          bestScore = score;
          bestMatch = inp;
          if (score === 3) return inp;
        }
      }
      if (bestMatch) return bestMatch;
    }
    return null;
  }

  // Bind each Vuetify .v-input (1-to-1) first, then any un-paired leaf .col fields — prevents nested .col label/input cross-pairing
  function collectTabFieldEntries(scope) {
    if (!scope) return [];
    const entries = [];
    const seenInputs = new Set();

    const vInputs = Array.from(scope.querySelectorAll('.v-input')).filter(vi =>
      !vi.closest('.v-radio, .v-checkbox, .v-input--radio-group, .v-input--checkbox, [role="radiogroup"]') &&
      !vi.classList.contains('v-input--radio-group') &&
      !vi.classList.contains('v-input--checkbox')
    );

    for (const vi of vInputs) {
      const col = vi.closest('.col, [class*="col-"]');
      const label = Array.from(vi.querySelectorAll('label')).find(l => !l.closest('.v-radio, .v-checkbox, [role="radiogroup"]'))
        || (col && col.querySelectorAll('.v-input').length === 1
          ? Array.from(col.querySelectorAll('label')).find(l => !l.closest('.v-radio, .v-checkbox, [role="radiogroup"]'))
          : null);
      let rawInput = null;
      if (label?.htmlFor) {
        const byFor = document.getElementById(label.htmlFor);
        if (byFor && scope.contains(byFor) && !/^(hidden|radio|checkbox|button|submit|file)$/i.test(byFor.type || '')) rawInput = byFor;
      }
      if (!rawInput) {
        rawInput = Array.from(vi.querySelectorAll('input, textarea')).find(el => !/^(hidden|radio|checkbox|button|submit|file)$/i.test(el.type || '')) || null;
      }
      const input = (rawInput && isFillableTextInput(rawInput)) ? rawInput : (Array.from(vi.querySelectorAll('input, textarea')).find(isFillableTextInput) || null);
      const labelStr = label?.textContent || input?.getAttribute('aria-label') || input?.placeholder || '';
      const labelText = normalizeBn(labelStr);
      if (!labelText) continue;
      if (input) seenInputs.add(input);
      else if (rawInput) seenInputs.add(rawInput);

      const selEl = vi.classList.contains('v-select') ? vi : vi.querySelector('.v-select');
      const selValEl = selEl ? selEl.querySelector('.v-select__selection') : null;
      const selText = selValEl ? String(selValEl.textContent || '').trim() : '';
      const value = selText || (rawInput ? String(rawInput.value || '').trim() : '') || '';
      entries.push({ col: col || vi, vInput: vi, label, labelText, input, rawInput, vSelect: selEl, value });
    }

    const leafCols = Array.from(scope.querySelectorAll('.col, [class*="col-"]')).filter(col => !col.querySelector('.col, [class*="col-"]'));
    for (const col of leafCols) {
      const nonSelInputs = Array.from(col.querySelectorAll('input, textarea')).filter(el => !/^(hidden|radio|checkbox|button|submit|file)$/i.test(el.type || ''));
      if (nonSelInputs.length > 1) continue;
      const rawInput = nonSelInputs[0] || null;
      if (rawInput && seenInputs.has(rawInput)) continue;
      const label = Array.from(col.querySelectorAll('label')).find(l => !l.closest('.v-radio, .v-checkbox, .v-input--selection-controls, [role="radiogroup"]'));
      if (!label) continue;
      const labelText = normalizeBn(label.textContent || '');
      if (!labelText) continue;
      let boundInput = rawInput;
      if (label.htmlFor) {
        const byFor = document.getElementById(label.htmlFor);
        if (byFor && scope.contains(byFor) && !/^(hidden|radio|checkbox|button|submit|file)$/i.test(byFor.type || '')) boundInput = byFor;
      }
      if (boundInput && seenInputs.has(boundInput)) continue;
      const selEl = col.querySelector('.v-select');
      const selValEl = selEl ? selEl.querySelector('.v-select__selection') : null;
      const selText = selValEl ? String(selValEl.textContent || '').trim() : '';
      const input = (boundInput && isFillableTextInput(boundInput)) ? boundInput : (nonSelInputs.find(isFillableTextInput) || null);
      const value = selText || (boundInput ? String(boundInput.value || '').trim() : '') || '';
      entries.push({ col, vInput: boundInput?.closest?.('.v-input') || null, label, labelText, input, rawInput: boundInput, vSelect: selEl, value });
    }
    return entries;
  }

  function findEntryByKeywords(entries, specOrKeywords, opts = {}) {
    if (!entries || !entries.length) return null;
    const { keys, exclude } = resolveFieldSpec(specOrKeywords, opts);
    const normKeys = keys.map(normalizeLabelForMatch).filter(Boolean);
    const normExcludes = exclude.map(normalizeLabelForMatch).filter(Boolean);
    let bestEntry = null;
    let bestRank = 0;
    for (let kIdx = 0; kIdx < normKeys.length; kIdx++) {
      const k = normKeys[kIdx];
      for (const e of entries) {
        const score = matchesLabelSpec(e.labelText, k, normExcludes);
        if (score <= 0) continue;
        const rank = score * 1000 - kIdx;
        if (rank > bestRank) {
          bestRank = rank;
          bestEntry = e;
        }
      }
      if (bestRank >= 3000) break;
    }
    return bestEntry;
  }

  function findStep0DocNumberInput(tab0, isBirthReg) {
    const scope = tab0 || (!document.querySelector('[data-family-card-tab]') ? document : null);
    if (!scope) return null;
    const spec = isBirthReg ? FC_FIELD_SPECS.docBrc : FC_FIELD_SPECS.docNid;
    const excludeNorms = spec.exclude.map(normalizeLabelForMatch);

    const byLabel = findInputByLabel(spec, scope);
    if (byLabel && !/DD\/MM|YYYY/i.test(byLabel.placeholder || '')) return byLabel;

    const candidates = Array.from(scope.querySelectorAll('input')).filter(isFillableTextInput)
      .filter(inp => !/DD\/MM|YYYY/i.test(inp.placeholder || ''));
    const nidAttrKeys = ['জাতীয় পরিচিতি', 'পরিচয়পত্র', 'এনআইডি'].map(normalizeLabelForMatch);
    const brcAttrKeys = ['জন্ম নিবন্ধন', 'নিবন্ধন নম্বর', 'birth reg'].map(normalizeLabelForMatch);
    const attrMatched = candidates.find((inp) => {
      const vi = inp.closest('.v-input');
      const viLabel = vi?.querySelector('label')?.textContent || '';
      const attrTxt = normalizeLabelForMatch(`${viLabel} ${inp.getAttribute('aria-label') || ''} ${inp.placeholder || ''}`);
      if (!attrTxt || excludeNorms.some(ex => attrTxt.includes(ex))) return false;
      return isBirthReg
        ? brcAttrKeys.some(k => attrTxt.includes(k))
        : (nidAttrKeys.some(k => attrTxt.includes(k)) || /\bnid\b/.test(attrTxt));
    });
    return attrMatched || null;
  }

  // Sequential Awaitable Vuetify Dropdown Selector scoped by aria-owns / active menu
  function selectDropdown(labelKeywords, targetText, rootEl = null, opts = {}) {
    return new Promise((resolve) => {
      if (!targetText) return resolve(false);
      const scope = rootEl || document;
      const normKeys = labelKeywords.map(k => normalizeBn(k));
      const normTarget = normalizeBn(targetText);
      const compactTarget = normOptionText(targetText);
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

      const vInput = container.classList.contains('v-input') ? container : container.querySelector('.v-input');
      const rawInp = container.querySelector('input:not([type="hidden"])');
      if (vInput?.classList.contains('v-input--is-disabled') || rawInp?.disabled) return resolve(false);

      if (!container.__fcSelectGuardAttached) {
        container.__fcSelectGuardAttached = true;
        container.addEventListener('mousedown', (e) => {
          if (e.isTrusted) container.dataset.fcUserEdited = 'true';
        }, true);
      }

      const currentSel = container.querySelector('.v-select__selection');
      const curText = currentSel ? normalizeBn(currentSel.textContent) : '';
      if (curText && (curText === normTarget || curText.includes(normTarget) || normOptionText(curText) === compactTarget)) {
        return resolve(true);
      }
      if (curText && (opts.respectNonEmpty || (!opts.ignoreUserGuard && container.dataset?.fcUserEdited === 'true'))) {
        return resolve(false);
      }

      const clickTarget = container.querySelector('.v-input__slot') || container.querySelector('input');
      if (!clickTarget) return resolve(false);

      const listId = clickTarget.getAttribute('aria-owns') || container.querySelector('[aria-owns]')?.getAttribute('aria-owns');
      clickTarget.click();
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        let items = [];
        if (listId) {
          const listEl = document.getElementById(listId);
          if (listEl) items = Array.from(listEl.querySelectorAll('.v-list-item'));
        }
        if (items.length === 0) {
          items = Array.from(document.querySelectorAll('.v-menu__content.menuable__content__active .v-list-item, .v-menu__content.menuable__content__active .v-list-item__title'));
        }
        if (items.length === 0 && attempts >= 4) {
          items = Array.from(document.querySelectorAll('.v-menu__content .v-list-item, .v-menu__content .v-list-item__title')).filter(el => el.offsetParent !== null);
        }

        const exact = items.find(it => normalizeBn(it.textContent) === normTarget || normOptionText(it.textContent) === compactTarget);
        const partial = exact || items.find(it => normalizeBn(it.textContent).includes(normTarget));
        if (partial) {
          const clickable = partial.closest('.v-list-item') || partial;
          clickable.click();
          clearInterval(interval);
          setTimeout(() => resolve(true), 80);
          return;
        }
        if (attempts >= 16) {
          clearInterval(interval);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          resolve(false);
        }
      }, 50);
    });
  }

  let isFillingPortalFields = false;
  async function fillPortalFields(rawData, opts = {}) {
    if (!rawData || isFillingPortalFields) return false;
    const data = normalizeApplicantPayload(rawData);
    if (!data) return false;
    const overwriteExisting = Boolean(opts.overwriteExisting);
    isFillingPortalFields = true;
    let filledCount = 0;

    try {
      const tab0 = document.querySelector('[data-family-card-tab="0"]');
      const tab1 = document.querySelector('[data-family-card-tab="1"]');
      const hasPortalTabs = Boolean(document.querySelector('[data-family-card-tab], #tab0, #tab1, #tab6, #tab8'));
      const { docType, docNumber } = resolveDocNumberAndType(data);
      const isBirthReg = docType === 'birth_certificate';
      const valOpts = overwriteExisting
        ? { ignoreUserGuard: true }
        : { respectNonEmpty: true };

      // Step 1 (tab0): Verification & Basic Identity (fill ONLY when tab0 is visible or un-tabbed)
      if ((tab0 && isElementVisible(tab0)) || (!tab0 && !hasPortalTabs)) {
        const scope0 = tab0 || document;
        await ensureVerificationRadio(scope0, isBirthReg);

        const entries0 = collectTabFieldEntries(scope0);
        const pick0 = (spec) => {
          const inp = findEntryByKeywords(entries0, spec)?.input || findInputByLabel(spec, scope0);
          if (inp) attachInputEditGuard(inp);
          return inp;
        };

        const nameBnInp = pick0(FC_FIELD_SPECS.nameBn);
        if (data.name_bn && setReactiveValue(nameBnInp, data.name_bn, valOpts)) filledCount++;

        const nameEnInp = pick0(FC_FIELD_SPECS.nameEn);
        if (data.name_en && setReactiveValue(nameEnInp, String(data.name_en).toUpperCase().trim(), valOpts)) filledCount++;

        if (docNumber) {
          let idInp = findStep0DocNumberInput(scope0, isBirthReg);
          for (let t = 0; !idInp && t < 10; t++) {
            await new Promise(r => setTimeout(r, 90));
            idInp = findStep0DocNumberInput(scope0, isBirthReg);
          }
          if (idInp) {
            attachInputEditGuard(idInp);
            if (setReactiveValue(idInp, docNumber, valOpts)) filledCount++;
          }
        }

        const dobInp = pick0(FC_FIELD_SPECS.dob) || scope0.querySelector('input[placeholder*="DD/MM"]');
        if (dobInp) attachInputEditGuard(dobInp);
        if (data.dob && setReactiveValue(dobInp, standardizeDate(data.dob), valOpts)) filledCount++;

        if (data.gender) {
          if (await selectDropdown(['লিঙ্গ'], normalizeGenderValue(data.gender), scope0, { respectNonEmpty: !overwriteExisting, ignoreUserGuard: overwriteExisting })) filledCount++;
        }
      }

      // Step 2 (tab1 - ব্যক্তিগত তথ্য): Personal Details (select marital & religion cleanly first to expose any conditional spouse row)
      if ((tab1 && isElementVisible(tab1)) || (!tab1 && !hasPortalTabs)) {
        const scope1 = tab1 || document;
        const targetMarital = data.marital_status || data.marital_status_suggestion || 'বিবাহিত';
        const targetReligion = data.religion || 'ইসলাম';

        if (targetMarital) {
          if (await selectDropdown(['বৈবাহিক অবস্থা'], targetMarital, scope1, { respectNonEmpty: !overwriteExisting, ignoreUserGuard: overwriteExisting })) filledCount++;
        }
        if (targetReligion) {
          if (await selectDropdown(['ধর্ম'], targetReligion, scope1, { respectNonEmpty: !overwriteExisting, ignoreUserGuard: overwriteExisting })) filledCount++;
        }

        // Wait briefly for conditional spouse row / Vue re-render before scanning Step 2 inputs
        await new Promise(r => setTimeout(r, 150));

        const entries1 = collectTabFieldEntries(scope1);
        const pick1 = (spec) => {
          const inp = findEntryByKeywords(entries1, spec)?.input || findInputByLabel(spec, scope1);
          if (inp) attachInputEditGuard(inp);
          return inp;
        };

        const step2NameBn = pick1(FC_FIELD_SPECS.nameBn);
        if (step2NameBn && data.name_bn) {
          if (setReactiveValue(step2NameBn, data.name_bn, valOpts)) filledCount++;
        }
        const step2NameEn = pick1(FC_FIELD_SPECS.nameEn);
        if (step2NameEn && data.name_en) {
          if (setReactiveValue(step2NameEn, String(data.name_en).toUpperCase().trim(), valOpts)) filledCount++;
        }
        if (docNumber) {
          const step2DocInp = pick1(isBirthReg ? FC_FIELD_SPECS.docBrc : FC_FIELD_SPECS.docNid);
          if (step2DocInp && setReactiveValue(step2DocInp, docNumber, valOpts)) filledCount++;
        }

        const fBnInp = pick1(FC_FIELD_SPECS.fatherBn);
        if (data.father_name_bn && setReactiveValue(fBnInp, data.father_name_bn, valOpts)) filledCount++;

        const fEnInp = pick1(FC_FIELD_SPECS.fatherEn);
        if (data.father_name_en && setReactiveValue(fEnInp, String(data.father_name_en).toUpperCase().trim(), valOpts)) filledCount++;

        const mBnInp = pick1(FC_FIELD_SPECS.motherBn);
        if (data.mother_name_bn && setReactiveValue(mBnInp, data.mother_name_bn, valOpts)) filledCount++;

        const mEnInp = pick1(FC_FIELD_SPECS.motherEn);
        if (data.mother_name_en && setReactiveValue(mEnInp, String(data.mother_name_en).toUpperCase().trim(), valOpts)) filledCount++;

        const mobInp = pick1(FC_FIELD_SPECS.mobile);
        if (data.mobile_number && setReactiveValue(mobInp, normalizeMobileNumber(data.mobile_number), valOpts)) filledCount++;

        // Fill conditional Spouse fields if rendered inside tab1 after Marital Status selection
        if (data.spouse_name_bn || data.spouse_name_en) {
          const spBnInp = pick1(FC_FIELD_SPECS.spouseBn);
          if (spBnInp && data.spouse_name_bn && setReactiveValue(spBnInp, data.spouse_name_bn, valOpts)) filledCount++;
          const spEnInp = pick1(FC_FIELD_SPECS.spouseEn);
          if (spEnInp && data.spouse_name_en && setReactiveValue(spEnInp, String(data.spouse_name_en).toUpperCase().trim(), valOpts)) filledCount++;
        }

        if (tab1) {
          window.__fcStep1FilledKey = `${scrapeFamilyId() || ''}_${docNumber || ''}`;
          injectSection2Toolbar(tab1);
        }
      }

      // Step 4: Collection Address Auto-fill
      handleSection4Address();
      return filledCount > 0;
    } finally {
      isFillingPortalFields = false;
    }
  }

  // --- STEP 2 PERSONAL INFO HELPER TOOLBAR & LIVE EDIT SYNC ---
  let step2SyncTimer = null;

  function readStep2FieldState(tab1) {
    const entries = collectTabFieldEntries(tab1);
    const val = (spec) => findEntryByKeywords(entries, spec)?.value || '';
    const fatherBn = val(FC_FIELD_SPECS.fatherBn);
    const fatherEn = val(FC_FIELD_SPECS.fatherEn);
    const motherBn = val(FC_FIELD_SPECS.motherBn);
    const motherEn = val(FC_FIELD_SPECS.motherEn);
    const mobile = normalizeMobileNumber(val(FC_FIELD_SPECS.mobile));
    const marital = val(['বৈবাহিক অবস্থা']);
    const religion = val(['ধর্ম']);
    const age = val(['বয়স', 'বয়স']);
    const doneCount = [fatherBn, fatherEn, motherBn, motherEn, mobile, marital, religion].filter(Boolean).length;
    return { fatherBn, fatherEn, motherBn, motherEn, mobile, marital, religion, age, doneCount, entries };
  }

  // --- GPS GEOLOCATION & PRE-SURVEY HOUSE NOTE ENGINE ---
  let lastCapturedHouseGps = null;
  let hasGeoCapturedForFid = '';
  let geoCaptureInFlightFid = '';

  function encodePlusCode(lat, lng) {
    try {
      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return '';
      const CODE_ALPHABET = '23456789CFGHJMPQRVWX';
      const latitude = Math.min(89.999999, Math.max(-90, Number(lat))) + 90;
      const longitude = Math.min(179.999999, Math.max(-180, Number(lng))) + 180;
      let code = '';
      let latVal = latitude;
      let lngVal = longitude;
      const latGrid = 20;
      const lngGrid = 20;
      for (let i = 0; i < 4; i++) {
        const latDigit = Math.min(19, Math.floor(latVal / latGrid));
        const lngDigit = Math.min(19, Math.floor(lngVal / lngGrid));
        code += CODE_ALPHABET.charAt(latDigit) + CODE_ALPHABET.charAt(lngDigit);
        latVal = (latVal % latGrid) * 20;
        lngVal = (lngVal % lngGrid) * 20;
        if (i === 3) code += '+';
      }
      const latDigit = Math.min(19, Math.floor(latVal / latGrid));
      const lngDigit = Math.min(19, Math.floor(lngVal / lngGrid));
      code += CODE_ALPHABET.charAt(latDigit) + CODE_ALPHABET.charAt(lngDigit);
      return code;
    } catch (_) {
      return '';
    }
  }

  function isFreshPortalGps(loc, maxAgeMs = 180000) {
    return Boolean(
      loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))
      && !(Number(loc.lat) === 0 && Number(loc.lng) === 0)
      && (Date.now() - Number(loc.timestamp || 0)) <= maxAgeMs
    );
  }

  function acquirePortalGpsLocation(timeoutMs = 10000, opts = {}) {
    const forceFresh = Boolean(opts.forceFresh);
    const maxAgeMs = Number(opts.maxAgeMs || 180000);
    return new Promise((resolve) => {
      const freshCached = !forceFresh && isFreshPortalGps(lastCapturedHouseGps, maxAgeMs) ? lastCapturedHouseGps : null;
      if (!navigator.geolocation) return resolve(freshCached);

      let bestSample = null;
      let samples = 0;
      let watchId = null;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (watchId !== null) {
          try { navigator.geolocation.clearWatch(watchId); } catch (_) {}
          watchId = null;
        }
        if (bestSample) {
          lastCapturedHouseGps = bestSample;
          return resolve(bestSample);
        }
        resolve(freshCached);
      };

      const timer = setTimeout(finish, timeoutMs);
      const onSuccess = (pos) => {
        samples++;
        const loc = {
          lat: Number(pos.coords.latitude.toFixed(6)),
          lng: Number(pos.coords.longitude.toFixed(6)),
          accuracy: Math.max(1, Math.round(pos.coords.accuracy || 10)),
          plusCode: encodePlusCode(pos.coords.latitude, pos.coords.longitude),
          timestamp: Date.now()
        };
        if (!bestSample || loc.accuracy < bestSample.accuracy) bestSample = loc;
        if (loc.accuracy <= 12 || samples >= 3) {
          clearTimeout(timer);
          finish();
        }
      };
      const onError = (err) => {
        console.warn('[Geolocation] notice:', err.message);
        clearTimeout(timer);
        finish();
      };

      if (typeof navigator.geolocation.watchPosition === 'function') {
        watchId = navigator.geolocation.watchPosition(onSuccess, onError, {
          enableHighAccuracy: true,
          timeout: timeoutMs,
          maximumAge: forceFresh ? 0 : 3000
        });
      } else {
        navigator.geolocation.getCurrentPosition(onSuccess, onError, {
          enableHighAccuracy: true,
          timeout: timeoutMs,
          maximumAge: forceFresh ? 0 : 3000
        });
      }
    });
  }

  async function autoCaptureHouseLocationOnStep2(fid, ladyName = '') {
    if (!fid || hasGeoCapturedForFid === fid || geoCaptureInFlightFid === fid) return;
    geoCaptureInFlightFid = fid;
    let loc = null;
    try {
      loc = await acquirePortalGpsLocation(10000, { forceFresh: true });
    } finally {
      if (geoCaptureInFlightFid === fid) geoCaptureInFlightFid = '';
    }
    if (!loc) {
      const elGeoText = document.getElementById('fc-s2-geo-text');
      if (elGeoText) elGeoText.textContent = '⚠️ জিপিএস পাওয়া যায়নি (লোকেশন চালু করুন)';
      return;
    }

    // Lock only AFTER a real GPS fix succeeds (allows automatic retry on transient timeout)
    hasGeoCapturedForFid = fid;
    const elGeoText = document.getElementById('fc-s2-geo-text');
    if (elGeoText) {
      elGeoText.textContent = `${loc.lat}, ${loc.lng} (±${loc.accuracy}m • ${loc.plusCode}) ✅`;
    }

    try {
      const cardMask = 'updateMask.fieldPaths=lat&updateMask.fieldPaths=lng&updateMask.fieldPaths=accuracy&updateMask.fieldPaths=plus_code&updateMask.fieldPaths=geo_recorded_at';
      const cleanFid = normalizeDigits(fid).replace(/[^0-9A-Za-z_-]/g, '');
      const bodyStr = JSON.stringify({
        fields: {
          lat: { doubleValue: loc.lat },
          lng: { doubleValue: loc.lng },
          accuracy: { integerValue: String(loc.accuracy) },
          plus_code: { stringValue: loc.plusCode },
          geo_recorded_at: { timestampValue: new Date().toISOString() }
        }
      });
      fetch(`https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(cleanFid)}?${cardMask}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr
      }).catch(() => {});
      fetch(`https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/surveyed_houses/${encodeURIComponent(cleanFid)}?${cardMask}&currentDocument.exists=true`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr
      }).catch(() => {});
    } catch (_) {}
  }

  function openBmHouseNoteModal(defaultFid = '', defaultName = '') {
    let modal = document.getElementById('fc-bm-house-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'fc-bm-house-modal';
      modal.className = 'fc-bm-overlay';
      modal.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(2,6,23,0.72); z-index:10000002; display:flex; align-items:center; justify-content:center; padding:12px; backdrop-filter:blur(4px); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
      document.body.appendChild(modal);
    }

    const curFid = defaultFid || scrapeFamilyId() || '';
    const curName = defaultName || lastExtractedData?.name_bn || '';

    modal.innerHTML = `
      <div style="background:#fff; width:100%; max-width:440px; border-radius:14px; overflow:hidden; box-shadow:0 20px 45px rgba(0,0,0,0.3); display:flex; flex-direction:column; border:1px solid #e2e8f0;">
        <div style="background:linear-gradient(135deg, #0f294d, #1c3b68); color:#fff; padding:12px 14px; display:flex; justify-content:space-between; align-items:center;">
          <b style="font-size:13px;">📍 বাড়ির লোকেশন ও সমস্যা নোট</b>
          <button type="button" id="fc-hn-close" style="background:none; border:none; color:#fff; font-size:18px; cursor:pointer; font-weight:bold;">✕</button>
        </div>
        <div style="padding:14px; display:flex; flex-direction:column; gap:9px; max-height:80vh; overflow-y:auto; font-size:12px; color:#1e293b;">
          <div>
            <label style="font-weight:700; display:block; margin-bottom:3px;">👩 প্রধান নারী / পরিবারের নাম *</label>
            <input type="text" id="fc-hn-name" value="${escapeHtml(curName)}" placeholder="যেমন: নুরজাহান নেছা" style="width:100%; box-sizing:border-box; padding:7px 9px; border:1.5px solid #cbd5e1; border-radius:7px; font-size:12px;">
          </div>
          <div style="display:flex; gap:6px;">
            <div style="flex:1;">
              <label style="font-weight:700; display:block; margin-bottom:3px;">🆔 পরিবার / NID আইডি</label>
              <input type="text" id="fc-hn-fid" value="${escapeHtml(curFid)}" placeholder="১০ বা ১৭ ডিজিট" style="width:100%; box-sizing:border-box; padding:7px 9px; border:1.5px solid #cbd5e1; border-radius:7px; font-size:12px;">
            </div>
            <div style="flex:1;">
              <label style="font-weight:700; display:block; margin-bottom:3px;">📱 মোবাইল নম্বর</label>
              <input type="tel" id="fc-hn-phone" value="${escapeHtml(lastExtractedData?.mobile_number || '')}" placeholder="01XXXXXXXXX" maxlength="11" style="width:100%; box-sizing:border-box; padding:7px 9px; border:1.5px solid #cbd5e1; border-radius:7px; font-size:12px;">
            </div>
          </div>
          <div style="background:#f0fdf4; border:1px solid #86efac; border-radius:8px; padding:7px 10px; display:flex; justify-content:space-between; align-items:center;">
            <div>
              <b style="color:#166534; font-size:11.5px;">📍 জিপিএস অবস্থান:</b>
              <div id="fc-hn-gps-coords" style="font-size:11px; color:#14532d; font-family:monospace;">লক হচ্ছে...</div>
            </div>
            <button type="button" id="fc-hn-relock-gps" style="background:#fff; border:1px solid #86efac; color:#166534; border-radius:6px; padding:4px 8px; font-size:10.5px; font-weight:700; cursor:pointer;">🔄 রিলক</button>
          </div>
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:9px 10px; display:flex; flex-direction:column; gap:6px;">
            <b style="color:#0f172a; font-size:11.5px;">⚠️ মিসিং ডকুমেন্টস ও সমস্যার কারণ:</b>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" id="fc-hn-chk-sim" checked> 📱 সিম কার্ড প্রধান নারীর নিজ NID-তে নেই</label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" id="fc-hn-chk-brc"> 👶 শিশুদের ডিজিটাল জন্ম নিবন্ধন (BRC) নেই</label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" id="fc-hn-chk-nid"> 🪪 প্রধান নারীর নিজস্ব NID কার্ড নেই</label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" id="fc-hn-chk-age"> 🔞 প্রধান নারীর বয়স ১৮-এর কম</label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" id="fc-hn-chk-mem"> 👥 সদস্যের ডকুমেন্টস অপূর্ণ</label>
          </div>
          <div>
            <label style="font-weight:700; display:block; margin-bottom:3px;">📝 সার্ভেয়ার নোট ও ফলো-আপ</label>
            <textarea id="fc-hn-notes" rows="2" placeholder="যেমন: আগামী রবিবার সিম বায়োমেট্রিক করবে..." style="width:100%; box-sizing:border-box; padding:6px 8px; border:1.5px solid #cbd5e1; border-radius:7px; font-size:11.5px;"></textarea>
          </div>
        </div>
        <div style="padding:10px 14px; background:#f8fafc; border-top:1px solid #e2e8f0; display:flex; gap:6px;">
          <button type="button" id="fc-hn-save-btn" style="flex:1; background:linear-gradient(135deg, #d97706, #b45309); color:#fff; border:none; border-radius:8px; padding:9px; font-weight:700; font-size:12px; cursor:pointer;">💾 সমস্যাযুক্ত বাড়ি সেভ করুন</button>
          <button type="button" id="fc-hn-cancel-btn" style="background:#e2e8f0; color:#334155; border:none; border-radius:8px; padding:9px 14px; font-weight:700; font-size:12px; cursor:pointer;">বাতিল</button>
        </div>
      </div>
    `;

    modal.style.display = 'flex';

    const coordsEl = modal.querySelector('#fc-hn-gps-coords');
    let modalGps = isFreshPortalGps(lastCapturedHouseGps, 180000) ? lastCapturedHouseGps : null;
    const updateCoordsText = (loc) => {
      modalGps = loc || null;
      if (!loc) coordsEl.textContent = '⚠️ লোকেশন পাওয়া যায়নি (🔄 রিলক চাপুন বা Allow দিন)';
      else coordsEl.textContent = `${loc.lat}, ${loc.lng} (±${loc.accuracy}m • ${loc.plusCode || ''})`;
    };

    if (modalGps) updateCoordsText(modalGps);
    else acquirePortalGpsLocation(9000, { forceFresh: true }).then(updateCoordsText);

    modal.querySelector('#fc-hn-relock-gps').onclick = async () => {
      coordsEl.textContent = '🔄 পুনরায় লক হচ্ছে...';
      const loc = await acquirePortalGpsLocation(9000, { forceFresh: true });
      updateCoordsText(loc);
    };

    const closeModal = () => { modal.style.display = 'none'; };
    modal.querySelector('#fc-hn-close').onclick = closeModal;
    modal.querySelector('#fc-hn-cancel-btn').onclick = closeModal;

    modal.querySelector('#fc-hn-save-btn').onclick = async () => {
      const lady = modal.querySelector('#fc-hn-name').value.trim();
      if (!lady) {
        alert('দয়া করে প্রধান নারীর নাম লিখুন!');
        return;
      }
      const hasFreshGps = isFreshPortalGps(modalGps, 300000);
      if (!hasFreshGps) {
        const proceedNoGps = confirm('⚠️ লাইভ জিপিএস সিগন্যাল পাওয়া যায়নি!\n\nGPS পিন ছাড়াই কি বাড়ির নোট সেভ করবেন? (ভুল জায়গায় পিন না বসাতে চাইলে OK দিন, অথবা বাতিল করে 🔄 রিলক চেষ্টা করুন)');
        if (!proceedNoGps) return;
      }
      const rawId = normalizeDigits(modal.querySelector('#fc-hn-fid').value.trim()).replace(/[^0-9A-Za-z_-]/g, '') || `house_${Date.now()}`;
      const nidOnly = /^\d{10,17}$/.test(rawId) ? rawId : '';
      const phone = normalizeDigits(modal.querySelector('#fc-hn-phone').value.trim()).replace(/[^0-9]/g, '');
      const notes = modal.querySelector('#fc-hn-notes').value.trim();

      const issues = [];
      if (modal.querySelector('#fc-hn-chk-sim').checked) issues.push('sim_not_own_nid');
      if (modal.querySelector('#fc-hn-chk-brc').checked) issues.push('child_brc_missing');
      if (modal.querySelector('#fc-hn-chk-nid').checked) issues.push('no_female_nid');
      if (modal.querySelector('#fc-hn-chk-age').checked) issues.push('female_under_18');
      if (modal.querySelector('#fc-hn-chk-mem').checked) issues.push('member_doc_missing');

      const isBlocked = issues.includes('no_female_nid') || issues.includes('female_under_18');
      const surveyStatus = isBlocked ? 'INCOMPLETE_BLOCKED' : (issues.length === 0 ? 'COMPLETED' : 'INCOMPLETE_ACTIONABLE');
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const curTimer = getPortalSurveyTimerState() || startPortalSurveyTimer({ docId: rawId, applicantName: lady, startReason: 'house_note_save' });
      const timerStartMs = curTimer?.startedAtMs || nowMs;
      const timerDurationSec = Math.max(0, Math.round((nowMs - timerStartMs) / 1000));
      const timerDurationLabel = formatPortalTimerDurationLabel(timerDurationSec);

      const houseObj = {
        docId: rawId,
        ladyName: lady,
        primary_lady_name_bn: lady,
        nid_number: nidOnly,
        mobile_number: phone,
        contactPhone: phone,
        notes,
        issues,
        survey_status: surveyStatus,
        survey_session_id: curTimer?.sessionId || '',
        survey_started_at: new Date(timerStartMs).toISOString(),
        survey_ended_at: nowIso,
        survey_duration_sec: timerDurationSec,
        survey_duration_label: timerDurationLabel,
        survey_timer_status: 'ended',
        surveyor_id: 'tablet_client',
        updated_at: nowIso
      };
      if (hasFreshGps) {
        houseObj.lat = modalGps.lat;
        houseObj.lng = modalGps.lng;
        houseObj.accuracy = modalGps.accuracy || 15;
        houseObj.plusCode = modalGps.plusCode || encodePlusCode(modalGps.lat, modalGps.lng);
      }

      let syncedCloud = false;
      try {
        const fields = {
          lady_name: { stringValue: lady },
          primary_lady_name_bn: { stringValue: lady },
          nid_number: { stringValue: nidOnly },
          mobile_number: { stringValue: phone },
          notes: { stringValue: notes },
          survey_status: { stringValue: surveyStatus },
          survey_session_id: { stringValue: curTimer?.sessionId || '' },
          survey_started_at: { timestampValue: new Date(timerStartMs).toISOString() },
          survey_ended_at: { timestampValue: nowIso },
          survey_duration_sec: { integerValue: String(timerDurationSec) },
          survey_duration_label: { stringValue: timerDurationLabel },
          survey_timer_status: { stringValue: 'ended' },
          updated_at: { timestampValue: nowIso },
          issues: { arrayValue: { values: issues.map(iss => ({ stringValue: iss })) } }
        };
        if (hasFreshGps) {
          fields.lat = { doubleValue: houseObj.lat };
          fields.lng = { doubleValue: houseObj.lng };
          fields.accuracy = { integerValue: String(houseObj.accuracy) };
          fields.plus_code = { stringValue: houseObj.plusCode };
        }
        const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
        const bodyStr = JSON.stringify({ fields });
        const [r1, r2] = await Promise.all([
          fetch(`https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(rawId)}?${mask}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: bodyStr
          }).catch(() => null),
          fetch(`https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/surveyed_houses/${encodeURIComponent(rawId)}?${mask}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: bodyStr
          }).catch(() => null)
        ]);
        syncedCloud = Boolean((r1 && r1.ok) || (r2 && r2.ok));

        sendRoomMessage({
          type: 'survey_house_saved',
          text: `📍 বাড়ি সেভ করা হয়েছে: ${lady} (${isBlocked ? '🔴 ব্লকড' : (issues.length === 0 ? '🟢 সম্পন্ন' : '🟠 সমস্যাযুক্ত')}) • ⏱️ ${timerDurationLabel}`,
          payload: houseObj
        });
        endPortalSurveyTimer('house_note_saved', {
          endedAtMs: nowMs,
          docId: rawId,
          applicantName: lady,
          surveyStatus,
          skipDocPatch: true
        });
      } catch (_) {}

      closeModal();
      showToast(syncedCloud
        ? `📍 ${lady}-এর বাড়ি ম্যাপে সংরক্ষিত হয়েছে! (⏱️ ${timerDurationLabel})`
        : `⚠️ ${lady}-এর বাড়ি ক্লাউডে সিঙ্ক হয়নি — ইন্টারনেট পরীক্ষা করুন`);
    };
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

    // Auto-capture house GPS location on Step 1 -> Step 2 transition
    autoCaptureHouseLocationOnStep2(fid, cached?.name_bn || '');

    // Attach lightweight delegating sync listener once so manual Step 2 edits stay cached & synced
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
            syncToFirestore(lastExtractedData);
          }
          injectSection2Toolbar(tab1);
        }, 700);
      });
    }

    let bar = wrap.querySelector('#fc-section2-toolbar');
    const spouseHint = cached?.spouse_name_bn && !state.fatherBn
      ? `পুরাতন NID-তে স্বামী "${cached.spouse_name_bn}" ছিল — পিতার নাম হাতে লিখুন`
      : '';
    const mobileWarn = state.mobile && !/^01[3-9]\d{8}$/.test(state.mobile)
      ? `মোবাইল "${state.mobile}" সঠিক ১১ সংখ্যার (01XXXXXXXXX) নয়`
      : '';
    const renderHash = `${state.doneCount}|${Boolean(cached)}|${fid}|${spouseHint}|${mobileWarn}|${cached?.name_bn || ''}`;
    if (bar && bar.dataset.renderHash === renderHash) return;

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fc-section2-toolbar';
      wrap.insertBefore(bar, wrap.firstChild);
    }
    bar.dataset.renderHash = renderHash;

    const allDone = state.doneCount >= 7 && !mobileWarn;
    bar.innerHTML = `
      <div class="fc-s2-top">
        <div class="fc-s2-title">
          <span>📝 স্টেপ ২: ব্যক্তিগত তথ্য সহকারী</span>
          <span class="fc-s2-badge ${allDone ? '' : 'warn'}">${toBnDigits(state.doneCount)}/৭ ফিল্ড</span>
        </div>
        <div class="fc-s2-actions">
          <button type="button" id="fc-s2-fill-btn" class="fc-s2-btn" style="background:#0284c7;">⚡ স্ক্যান ডাটা বসাও</button>
          <button type="button" id="fc-s2-clean-btn" class="fc-s2-btn" style="background:#0f766e;">📱 নম্বর / CAPS ঠিক</button>
          <button type="button" id="fc-s2-house-note-btn" class="fc-s2-btn" style="background:#d97706; font-weight:800;">📍 বাড়ি নোট</button>
          <button type="button" id="fc-s2-backup-btn" class="fc-s2-btn" style="background:#2563eb; font-weight:700;">☁️ ক্লাউড ব্যাকআপ</button>
          <button type="button" id="fc-s2-restore-btn" class="fc-s2-btn" style="background:#059669; font-weight:700;">♻️ রিস্টোর</button>
          ${fid ? '<button type="button" id="fc-s2-cloud-btn" class="fc-s2-btn" style="background:#4f46e5;">☁️ ক্লাউড লোড</button>' : ''}
          <button type="button" id="fc-s2-scan-btn" class="fc-s2-btn" style="background:#1c3b68;">📸 স্ক্যান</button>
        </div>
      </div>
      <div class="fc-s2-meta">
        ${cached ? `🪪 <b>ক্যাশড তথ্য:</b> ${escapeHtml(cached.name_bn || cached.name_en || '-')} • পিতা: ${escapeHtml(cached.father_name_bn || 'নেই')} • মাতা: ${escapeHtml(cached.mother_name_bn || '-')}` : '💡 NID/জন্ম নিবন্ধন স্ক্যান করলে বা ক্লাউড লোড করলে পিতা-মাতা ও ডিফল্ট অটো-ফিল হবে।'}
        <br><span style="color:#0369a1; font-weight:700;">📍 বাড়ির অবস্থান: <span id="fc-s2-geo-text">${lastCapturedHouseGps ? `${lastCapturedHouseGps.lat}, ${lastCapturedHouseGps.lng} (±${lastCapturedHouseGps.accuracy}m) ✅` : 'লক হচ্ছে...'}</span></span>
        <div id="fc-s2-backup-badge" style="font-size:11px; margin-top:3px; font-weight:700; color:#15803d;"></div>
        ${spouseHint ? `<br><span style="color:#b45309;font-weight:700;">⚠️ ${escapeHtml(spouseHint)}</span>` : ''}
        ${mobileWarn ? `<br><span style="color:#b91c1c;font-weight:700;">⚠️ ${escapeHtml(mobileWarn)}</span>` : ''}
      </div>
    `;

    const btnHouseNote = bar.querySelector('#fc-s2-house-note-btn');
    if (btnHouseNote) {
      btnHouseNote.onclick = () => {
        openBmHouseNoteModal(fid, cached?.name_bn || '');
      };
    }

    const btnFill = bar.querySelector('#fc-s2-fill-btn');
    if (btnFill) {
      btnFill.onclick = async () => {
        const src = cached || getCachedFamilyScan(fid, true);
        if (!src) {
          openAssistantModalForTab();
          showToast('⚠️ স্ক্যান ডাটা পাওয়া যায়নি — ডকুমেন্ট স্ক্যান করুন বা ☁️ ক্লাউড লোড চাপুন।');
          return;
        }
        lastExtractedData = src;
        await fillPortalFields(src, { overwriteExisting: true });
        injectSection2Toolbar(tab1);
        updateSummaryBadge(true);
        showToast('✅ স্টেপ ২-এ স্ক্যানকৃত ডাটা বসানো হয়েছে!');
      };
    }

    const btnClean = bar.querySelector('#fc-s2-clean-btn');
    if (btnClean) {
      btnClean.onclick = () => {
        const cur = readStep2FieldState(tab1);
        let fixed = 0;
        const mobEntry = findEntryByKeywords(cur.entries, FC_FIELD_SPECS.mobile);
        if (mobEntry?.input && mobEntry.input.value) {
          const cleanMob = normalizeMobileNumber(mobEntry.input.value);
          if (cleanMob && cleanMob !== mobEntry.input.value && setReactiveValue(mobEntry.input, cleanMob, { ignoreUserGuard: true })) fixed++;
        }
        [FC_FIELD_SPECS.fatherEn, FC_FIELD_SPECS.motherEn].forEach(spec => {
          const e = findEntryByKeywords(cur.entries, spec);
          if (e?.input && e.input.value) {
            const up = e.input.value.replace(/\s+/g, ' ').trim().toUpperCase();
            if (up !== e.input.value && setReactiveValue(e.input, up, { ignoreUserGuard: true })) fixed++;
          }
        });
        injectSection2Toolbar(tab1);
        showToast(fixed > 0 ? `✅ ${toBnDigits(fixed)}টি ফিল্ড ফরম্যাট ঠিক করা হয়েছে!` : '✅ মোবাইল ও ইংরেজি নাম ইতোমধ্যেই সঠিক ফরম্যাটে আছে!');
      };
    }

    const btnBackup = bar.querySelector('#fc-s2-backup-btn');
    if (btnBackup) {
      btnBackup.onclick = async () => {
        btnBackup.disabled = true;
        btnBackup.textContent = '⏳ ব্যাকআপ হচ্ছে...';
        await triggerSmartCloudBackup('manual_button', true);
        btnBackup.disabled = false;
        btnBackup.textContent = '☁️ ক্লাউড ব্যাকআপ';
        showToast('✅ ধাপ ১-১১ এর সম্পূর্ণ তথ্য ফায়ারবেস ক্লাউডে ব্যাকআপ সম্পন্ন!');
      };
    }

    const btnRestore = bar.querySelector('#fc-s2-restore-btn');
    if (btnRestore) {
      btnRestore.onclick = async () => {
        btnRestore.disabled = true;
        btnRestore.textContent = '⏳ রিস্টোর হচ্ছে...';
        await restorePortalFromSmartBackup(fid);
        btnRestore.disabled = false;
        btnRestore.textContent = '♻️ রিস্টোর';
      };
    }

    const btnCloud = bar.querySelector('#fc-s2-cloud-btn');
    if (btnCloud) {
      btnCloud.onclick = async () => {
        btnCloud.disabled = true;
        btnCloud.textContent = '⏳ লোড হচ্ছে...';
        const loaded = await fetchFirestoreApplicant(fid);
        btnCloud.disabled = false;
        btnCloud.textContent = '☁️ ক্লাউড লোড';
        if (!loaded) {
          showToast(`⚠️ পরিবার আইডি ${fid}-এর জন্য ক্লাউডে সংরক্ষিত ডাটা পাওয়া যায়নি।`);
          return;
        }
        lastExtractedData = loaded;
        await fillPortalFields(loaded, { overwriteExisting: false });
        injectSection2Toolbar(tab1);
        updateSummaryBadge(true);
        showToast(`☁️ ক্লাউড থেকে "${loaded.name_bn || fid}" তথ্য লোড হয়েছে!`);
      };
    }

    const btnScan = bar.querySelector('#fc-s2-scan-btn');
    if (btnScan) btnScan.onclick = openAssistantModalForTab;
  }

  // --- SECTION 3: IMAGE GUARDIAN & COMPLIANCE SYSTEM ---
  // Compresses and resizes camera/gallery images to strictly satisfy portal requirements:
  // - Applicant Photo & Signature: < 195 KB, JPEG
  // - House Photo: < 195 KB, strictly <= 600x400 resolution
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

          // Downscale proportionally if larger than maximum bounds
          if (width > maxW || height > maxH) {
            const ratio = Math.min(maxW / width, maxH / height);
            width = Math.max(1, Math.round(width * ratio));
            height = Math.max(1, Math.round(height * ratio));
          }

          const canvas = document.createElement('canvas');
          let quality = 0.88;
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

      // Intercept oversized, non-JPG/PNG, or house photos in capture phase BEFORE Vue/Vuetify rejects them
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
      console.log('[FamilyCard] Section 3 media synced to Firestore for family ID:', cleanId);

      const cloudStatEl = document.getElementById('fc-s3-cloud-stat');
      if (cloudStatEl) {
        cloudStatEl.textContent = `☁️ ক্লাউডে সংরক্ষিত (আইডি: ${cleanId})`;
        cloudStatEl.style.color = '#166534';
      }
    } catch (e) {
      console.warn('[FamilyCard] Firestore media sync notice:', e.message);
    }
  }

  // --- SECTION 4: ADDRESS (যোগাযোগের তথ্য - ফ্যামিলি কার্ড তথ্য সংগ্রহের ঠিকানা) ---
  function isNodeBetweenInOrder(node, startNode, endNode, rootScope) {
    if (typeof node.compareDocumentPosition === 'function' && typeof Node !== 'undefined') {
      const afterStart = (node.compareDocumentPosition(startNode) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
      const beforeEnd = !endNode || ((node.compareDocumentPosition(endNode) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      return afterStart && beforeEnd;
    }
    // Fallback deterministic tree walk (works even on lightweight DOM mocks)
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

    // Remove legacy inline bar if present from an older build
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
  if (typeof updateBmSection5Controls === 'function') updateBmSection5Controls();

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
    if (typeof updateBmSection5Controls === 'function') updateBmSection5Controls();
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
            if (typeof updateBmSection5Controls === 'function') updateBmSection5Controls();
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

    // Determine applicant's gender (for Member 1 / Self)
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
      // Multi-word relationship/title tokens (split on whitespace/punctuation to avoid 'মাতা'/'জা' matching inside unrelated words)
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
        // Scan selects in card (never scan <label> text like "মাতার নাম" or "জাতীয়")
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

        // Safe fallback using ONLY card header title (not form field labels!)
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
      console.log('[FamilyCard] Section 5 & Cross-Match data synced to Firestore for family ID:', cleanId);

      const cloudEl = document.getElementById('fc-cm-cloud-stat');
      if (cloudEl) {
        cloudEl.textContent = `☁️ ক্লাউডে সংরক্ষিত (আইডি: ${cleanId})`;
      }
    } catch (e) {
      console.warn('[FamilyCard] Firestore cross-match sync notice:', e.message);
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

    // Update Tab 6 inline banner if stack exists
    const stack = (isS6Visible && (document.querySelector('.fm-members-stack') || s6Panel?.querySelector('.v-expansion-panel-content__wrap'))) || null;
    if (stack) {
      injectTab6Banner(stack, sec5Data, membersData, match);
      injectMemberCardButtons();
    }

    // Hash-skip HUD DOM updates when counts haven't changed
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

    // Sync to Firestore if changed
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
        console.log('[FamilyCard] Selected branch from dropdown 0:', picked);
        showToast(`✅ ব্যাংক শাখা "${picked}" ড্রপডাউন ০ থেকে নির্বাচিত হয়েছে!`);
        await waitMs(140);
        return true;
      }

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      console.warn('[FamilyCard] Branch option not found in dropdown:', targetText);
      return false;
    } catch (e) {
      console.warn('[FamilyCard] Error in selectVuetifyAutocomplete:', e);
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
            console.log('[FamilyCard] Selected ownership:', targetText);
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
        console.warn('[FamilyCard] Error in selectVuetifyDropdown:', e);
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
        let items = collectVuetifyMenuItems(listId, attempts);

        if (items.length > 0) {
          let matchedItem = items.find(it => normCands.some(c => normalizeBn(it.textContent) === c));
          if (!matchedItem) {
            matchedItem = items.find(it => candidates.some(c => normOptionText(it.textContent) === normOptionText(c)));
          }
          if (!matchedItem) {
            matchedItem = items.find(it => normCands.some(c => c.length > 2 && normalizeBn(it.textContent).includes(c)));
          }

          if (matchedItem) {
            const clickable = (matchedItem.closest && matchedItem.closest('.v-list-item')) || matchedItem;
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

  const PORTAL_STEP_META = [
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

  function jumpToPortalSection(tabAttr) {
    const sModal = document.getElementById('fc-bm-summary-modal');
    if (sModal) sModal.style.display = 'none';
    const tabKey = String(tabAttr);
    const target = document.querySelector(`[data-family-card-tab="${tabKey}"]`);
    if (!target) {
      showToast(`⚠️ সেকশন (ট্যাব ${tabKey}) বর্তমান পেজে খুঁজে পাওয়া যায়নি।`);
      return false;
    }
    if (target.classList.contains('v-expansion-panel') && !target.classList.contains('v-expansion-panel--active')) {
      target.querySelector('.v-expansion-panel-header, button')?.click();
    }
    if (target.style.display === 'none' || !isPanelActiveVisible(target)) {
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
    return true;
  }

  async function focusPortalField(tabAttr, labelHints = []) {
    const ok = jumpToPortalSection(tabAttr);
    if (!ok) return false;
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
    if (!panel) {
      return { hasDom: false, agreed: false, submitDisabled, hasSubmitBtn: Boolean(submitBtn) };
    }
    const cb = panel.querySelector('input[type="checkbox"]');
    const agreed = cb ? Boolean(cb.checked || cb.getAttribute('aria-checked') === 'true') : false;
    return {
      hasDom: true,
      panel,
      checkbox: cb,
      agreed,
      submitDisabled,
      hasSubmitBtn: Boolean(submitBtn)
    };
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
    const trace = typeof collectFullFieldTrace === 'function' ? collectFullFieldTrace() : null;
    const sig = `${c11.agreed}|${c11.submitDisabled}|${s10.filledCount}|${trace ? trace.missingRequired : 0}`;
    if (bar.dataset.lastSig === sig) return;
    bar.dataset.lastSig = sig;
    bar.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
        <b style="color:#4c1d95;">✅ ধাপ ১১–১২: এন্ট্রি ও চূড়ান্ত সম্মতি যাচাই</b>
        <span class="fc-s2-badge ${c11.agreed && (!trace || trace.missingRequired === 0) ? '' : 'warn'}">
          ${c11.agreed ? '☑️ সম্মতি নির্বাচিত' : '⚠️ সম্মতি বাকি'} • ${trace ? `${toBnDigits(trace.pct)}% প্রস্তুত` : ''}
        </span>
      </div>
      <div style="font-size:11px; color:#334155; margin-bottom:7px;">
        এন্ট্রি ব্যবহারকারী: <b>${s10.hasDom ? `${toBnDigits(s10.filledCount)}/${toBnDigits(s10.totalFields)} ফিল্ড` : 'দেখুন'}</b> •
        সাবমিট বাটন: <b>${c11.submitDisabled ? '🔒 নিষ্ক্রিয়' : '🟢 সক্রিয়'}</b>
        ${trace && trace.missingRequired > 0 ? ` • <span style="color:#b91c1c;">বাকি জরুরি ফিল্ড: ${toBnDigits(trace.missingRequired)}টি</span>` : ''}
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" id="fc-s11-open-trace" class="fc-s2-btn" style="background:#1e3a8a;">🗺️ পূর্ণাঙ্গ ট্রেস দেখুন</button>
        <button type="button" id="fc-s11-open-sum" class="fc-s2-btn" style="background:#0f766e;">📊 সারসংক্ষেপ ও ব্লকার</button>
        ${!c11.agreed && c11.checkbox ? `<button type="button" id="fc-s11-agree-btn" class="fc-s2-btn" style="background:#7c3aed;">☑️ সম্মতি টিক দিন</button>` : ''}
      </div>
    `;
    const btnTrace = bar.querySelector('#fc-s11-open-trace');
    if (btnTrace) {
      btnTrace.onclick = () => {
        if (typeof window.__fcOpenModal === 'function') window.__fcOpenModal();
        switchBmTab('trace');
      };
    }
    const btnSum = bar.querySelector('#fc-s11-open-sum');
    if (btnSum) btnSum.onclick = () => { if (typeof openSummaryModal === 'function') openSummaryModal(); };
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

  function findCrossStepLinkHint(tabAttr, labelNorm) {
    if (tabAttr === '0' && (labelNorm.includes('পরিচিতি') || labelNorm.includes('নিবন্ধন') || labelNorm.includes('জন্ম তারিখ'))) {
      return 'স্টেপ ২ (ব্যক্তিগত তথ্য) এবং স্টেপ ৯ (সদস্য-১ নিজে)-এর সাথে যুক্ত';
    }
    if (tabAttr === '1' && (labelNorm.includes('নাম') || labelNorm.includes('পিতা') || labelNorm.includes('মাতা') || labelNorm.includes('স্বামী'))) {
      return 'স্টেপ ১ OCR ডাটা থেকে অটো-ফিল • বৈবাহিক/লিঙ্গ অনুযায়ী স্টেপ ৭ ও ৯ নিয়ন্ত্রণ করে';
    }
    if (tabAttr === '2' && (labelNorm.includes('গ্রাম') || labelNorm.includes('পোস্ট') || labelNorm.includes('ঠিকানা'))) {
      return 'তথ্য সংগ্রহের ঠিকানা ➔ স্থায়ী ঠিকানাতে স্বয়ংক্রিয়ভাবে কপি হয়';
    }
    if (tabAttr === '3' && (labelNorm.includes('পুরুষ') || labelNorm.includes('নারী') || labelNorm.includes('মোবাইল ব্যাংকিং'))) {
      return 'সদস্য সংখ্যা স্টেপ ৯ (সদস্য তালিকা) এবং MFS স্টেপ ৬-এর সাথে ক্রস-ম্যাচড';
    }
    if (tabAttr === '4') {
      return 'ডিফল্ট শাখা: মাছপাড়া শাখা • স্টেপ ৫-এর MFS/পেমেন্ট পছন্দের সাথে যুক্ত';
    }
    if (tabAttr === '8') {
      return 'স্টেপ ২ ও স্টেপ ৯-এ থাকা পরিবারের সদস্য/স্বামী-স্ত্রীর সাথে সম্পর্কিত';
    }
    if (tabAttr === '6') {
      return 'সদস্যের শিক্ষার্থী/প্রতিবন্ধী স্ট্যাটাস ➔ স্টেপ ১০ (অর্থ ব্যবহার ২,৫০০৳) নির্ধারণ করে';
    }
    if (tabAttr === '10') {
      return 'স্টেপ ৯-এ শিক্ষার্থী থাকলে "সন্তানের শিক্ষা" বরাদ্দ হয়, না থাকলে ০৳';
    }
    if (tabAttr === '7' || tabAttr === '11') {
      return 'সব ধাপ সম্পন্ন হলে সাবমিট বাটন সক্রিয় করে';
    }
    return '';
  }

  function collectFullFieldTrace() {
    const summaryData = typeof collectFullFamilyCardSummary === 'function' ? collectFullFamilyCardSummary() : null;
    const steps = [];
    let totalFields = 0;
    let filledFields = 0;
    let missingRequired = 0;

    for (const meta of PORTAL_STEP_META) {
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
            fields.push({
              label: item.label,
              value: item.val,
              required: item.req,
              status: item.ok ? 'filled' : (item.req ? 'missing' : 'optional'),
              linkHint: 'ধাপ ৩ মিডিয়া ট্রেসারের সাথে যুক্ত'
            });
          });
        } else {
          // Radio groups inside this step
          panel.querySelectorAll('[role="radiogroup"]').forEach((rg) => {
            const container = rg.closest('.v-input--radio-group, .col, [class*="col-"], div') || rg.parentElement;
            const lblNode = Array.from(container ? container.querySelectorAll('legend, .v-label--active, label') : []).find(n => !n.closest('.v-radio')) || container?.previousElementSibling;
            const label = normalizeBn(String((lblNode && !lblNode.closest('.v-radio') ? lblNode.textContent : '') || rg.getAttribute('aria-label') || '').replace(/\*/g, '').trim());
            if (!label || seenLabels.has(label)) return;
            seenLabels.add(label);
            const checkedRadio = Array.from(rg.querySelectorAll('input[type="radio"]')).find(r => r.checked || r.getAttribute('aria-checked') === 'true');
            const checkedLbl = checkedRadio ? (checkedRadio.closest('.v-radio')?.querySelector('label')?.textContent?.trim() || checkedRadio.value || 'নির্বাচিত') : '';
            const req = Boolean((lblNode?.textContent || '').includes('*') || rg.getAttribute('aria-required') === 'true');
            fields.push({
              label,
              value: checkedLbl,
              required: req,
              status: checkedLbl ? 'filled' : (req ? 'missing' : 'optional'),
              linkHint: findCrossStepLinkHint(meta.tabAttr, label)
            });
          });

          // Checkboxes inside this step
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
            fields.push({
              label: cleanLbl,
              value: isChecked ? '☑️ টিক দেওয়া হয়েছে' : '',
              required: req,
              status: isChecked ? 'filled' : (req ? 'missing' : 'optional'),
              linkHint: findCrossStepLinkHint(meta.tabAttr, cleanLbl)
            });
          });

          // Standard text/select/autocomplete/textarea inputs inside this step
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
              fields.push({
                label,
                value: val,
                required: req,
                status: val ? 'filled' : (req ? 'missing' : 'optional'),
                linkHint: findCrossStepLinkHint(meta.tabAttr, label)
              });
            });
        }
      }

      const stepFilled = fields.filter(f => f.status === 'filled').length;
      const stepMissingReq = fields.filter(f => f.status === 'missing').length;
      totalFields += fields.length;
      filledFields += stepFilled;
      missingRequired += stepMissingReq;
      steps.push({
        ...meta,
        inDom: Boolean(panel),
        fields,
        filled: stepFilled,
        missingRequired: stepMissingReq
      });
    }

    const s5 = summaryData?.sec5 || {};
    const sec8Tracked = typeof trackSection8Data === 'function' ? trackSection8Data() : null;
    const s9 = summaryData?.s9Dist || {};
    const c11 = inspectSection11Consent();

    const crossLinks = [
      {
        fromLabel: 'স্টেপ ১ (OCR NID / BRC)',
        toLabel: 'স্টেপ ২ (ব্যক্তিগত তথ্য)',
        toTab: '1',
        jumpKey: 'নাম (বাংলা)',
        ok: Boolean(summaryData?.applicant?.nameBn && summaryData?.applicant?.fatherBn && summaryData?.applicant?.motherBn),
        detail: summaryData?.applicant?.nameBn ? `${summaryData.applicant.nameBn} (${summaryData.applicant.nid || '-'})` : 'এখনো স্ক্যান বা পূরণ হয়নি'
      },
      {
        fromLabel: 'স্টেপ ৪ (তথ্য সংগ্রহের ঠিকানা)',
        toLabel: 'স্থায়ী ঠিকানা (একই)',
        toTab: '2',
        jumpKey: 'পোস্ট কোড',
        ok: Boolean(summaryData?.villageVal && /^\d{4}$/.test(summaryData?.postcodeVal || '')),
        detail: `গ্রাম: ${summaryData?.villageVal || '-'} • পোস্টকোড: ${toBnDigits(summaryData?.postcodeVal || '-')}`
      },
      {
        fromLabel: 'স্টেপ ৫ (মোট সদস্য)',
        toLabel: 'স্টেপ ৯ (সদস্য কার্ডসমূহ)',
        toTab: '6',
        jumpKey: '',
        ok: Boolean(summaryData?.crossMatch?.isExactMatch),
        detail: summaryData?.crossMatch?.statusText || 'মিলিয়ে দেখুন'
      },
      {
        fromLabel: 'স্টেপ ৫ (MFS)',
        toLabel: 'স্টেপ ৬ (ব্যাংক / মাছপাড়া শাখা)',
        toTab: '4',
        jumpKey: 'ব্যাংক শাখার নাম',
        ok: Boolean(summaryData?.s6Inspect?.hasDom ? summaryData.s6Inspect.allValid : summaryData?.bankBranch),
        detail: `শাখা: ${summaryData?.bankBranch || 'নির্বাচিত নয়'} • মালিকানা: ${summaryData?.bankOwner || '-'}`
      },
      {
        fromLabel: `স্টেপ ৯ (শিক্ষার্থী: ${toBnDigits(sec8Tracked?.studentCount || 0)} জন)`,
        toLabel: 'স্টেপ ১০ (অর্থ ব্যবহার ২,৫০০৳)',
        toTab: '10',
        jumpKey: 'সন্তানের শিক্ষা',
        ok: Number(summaryData?.s9Total || 0) === 2500 && !(sec8Tracked?.hasSec8Data && !sec8Tracked?.hasStudent && Number(s9.education || 0) > 0),
        detail: `মোট ${toBnDigits(summaryData?.s9Total || 0)}/২৫০০৳ (শিক্ষা বরাদ্দ: ${toBnDigits(s9.education || 0)}৳)`
      },
      {
        fromLabel: 'স্টেপ ১১–১২ (এন্ট্রি ও সম্মতি)',
        toLabel: 'চূড়ান্ত সাবমিট',
        toTab: '11',
        jumpKey: 'সম্মতি',
        ok: Boolean(c11.agreed && !c11.submitDisabled),
        detail: c11.agreed ? 'সম্মতি টিক দেওয়া হয়েছে' : 'সম্মতি চেকবক্স বাকি'
      }
    ];

    const pct = totalFields > 0 ? Math.round((filledFields / totalFields) * 100) : (summaryData?.readinessPct || 0);
    return { steps, totalFields, filledFields, missingRequired, pct, crossLinks, summaryData };
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
      nameBn: findEntryByKeywords(entries0, FC_FIELD_SPECS.nameBn)?.value || findEntryByKeywords(entries1, FC_FIELD_SPECS.nameBn)?.value || matchedLast?.name_bn || '',
      nameEn: findEntryByKeywords(entries0, FC_FIELD_SPECS.nameEn)?.value || findEntryByKeywords(entries1, FC_FIELD_SPECS.nameEn)?.value || matchedLast?.name_en || '',
      nid: normalizeDigits(
        findEntryByKeywords(entries0, FC_FIELD_SPECS.docBrc)?.value ||
        findEntryByKeywords(entries0, FC_FIELD_SPECS.docNid)?.value ||
        findEntryByKeywords(entries1, FC_FIELD_SPECS.docBrc)?.value ||
        findEntryByKeywords(entries1, FC_FIELD_SPECS.docNid)?.value ||
        matchedLast?.nid_number || matchedLast?.birth_reg_no || matchedLast?.brc_number || matchedLast?.doc_number || ''
      ).replace(/[^0-9]/g, ''),
      dob: standardizeDate(findEntryByKeywords(entries0, FC_FIELD_SPECS.dob)?.value || findEntryByKeywords(entries1, FC_FIELD_SPECS.dob)?.value || matchedLast?.dob || ''),
      fatherBn: findEntryByKeywords(entries1, FC_FIELD_SPECS.fatherBn)?.value || matchedLast?.father_name_bn || '',
      motherBn: findEntryByKeywords(entries1, FC_FIELD_SPECS.motherBn)?.value || matchedLast?.mother_name_bn || '',
      mobile: normalizeMobileNumber(findEntryByKeywords(entries1, FC_FIELD_SPECS.mobile)?.value || findEntryByKeywords(entries0, FC_FIELD_SPECS.mobile)?.value || matchedLast?.mobile_number || '')
    };

    // Sec 3 Media check (validates all 3 required uploads: photo, signature, house photo)
    const s3Media = inspectSection3Media(tab9);

    // Sec 4 Address check (inspects Collection Postcode/Village & Permanent Sync)
    const s4Addr = inspectSection4Address(tab2);
    const addrCfg = getSavedAddressConfig();
    const villageVal = s4Addr.village || addrCfg.village;
    const postcodeVal = s4Addr.postcode || addrCfg.postcode;

    // Sec 5 & Sec 8 Cross-match + Duplicate ID detector
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

    // Sec 6 Bank
    const s6Inspect = inspectSection6Bank();
    const bankBranch = s6Inspect.hasDom ? s6Inspect.branchText : getDefaultBankBranch();
    const bankOwner = s6Inspect.hasDom ? s6Inspect.ownership : (localStorage.getItem('fc_default_account_ownership') || '');

    // Sec 7 Eligibility
    const s7Inspect = inspectSection7Eligibility();
    const s7Panel = s7Inspect.panel;
    const s7Filled = s7Inspect.filledCount;

    // Sec 9 Money Usage (2500 Tk)
    const s9Elems = getSection9MoneyElements();
    const s9Dist = s9Elems ? readCurrentMoneyDistribution(s9Elems.fields) : null;
    const s9Total = s9Dist ? s9Dist.total : 0;

    // Build structured checkpoints & actionable blockers
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
      s9Total,
      s9Dist,
      sections,
      blockers,
      readinessPct,
      scanHistory: window.__fcScanHistory || []
    };
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
    let sm = document.getElementById('fc-bm-summary-modal');
    if (sm) return sm;
    sm = document.createElement('div');
    sm.id = 'fc-bm-summary-modal';
    sm.className = 'fc-bm-overlay';
    sm.style.display = 'none';
    sm.innerHTML = `
      <div class="fc-bm-card" style="max-width: 520px;">
        <div class="fc-bm-hdr" style="background: linear-gradient(135deg, #0f766e, #115e59);">
          <h3>📊 ফ্যামিলি কার্ড সারসংক্ষেপ ও যাচাই</h3>
          <span id="fc-bm-sum-close">&times;</span>
        </div>
        <div class="fc-bm-body" id="fc-bm-sum-body" style="gap: 8px;"></div>
      </div>
    `;
    document.body.appendChild(sm);
    sm.querySelector('#fc-bm-sum-close').onclick = () => { sm.style.display = 'none'; };
    sm.onclick = (e) => { if (e.target === sm) sm.style.display = 'none'; };
    return sm;
  }

  function openSummaryModal() {
    const sm = ensureSummaryModal();
    const body = sm.querySelector('#fc-bm-sum-body');
    const s = collectFullFamilyCardSummary();

    const headerColor = s.readinessPct >= 85 && s.blockers.length === 0 ? '#15803d' : (s.readinessPct >= 50 ? '#b45309' : '#b91c1c');
    const curTimerSnap = getPortalSurveyTimerState();
    const curTimerSec = getPortalTimerElapsedSec(curTimerSnap);
    const curTimerLabel = curTimerSnap ? `${curTimerSnap.status === 'ended' ? '✅ শেষ সময়' : '⏱️ চলমান সময়'}: ${formatPortalTimerDurationLabel(curTimerSec)}` : '⏱️ সময়: ০০:০০';
    let html = `
      <div class="fc-sum-card" style="border-color: ${headerColor}; background: #f8fafc;">
        <div class="fc-sum-row">
          <div>
            <div style="font-weight: 800; font-size: 13.5px; color: #0f172a;">🆔 পরিবার আইডি: ${escapeHtml(s.familyId || 'নেই')}</div>
            <div style="font-size: 11.5px; color: #475569; margin-top: 2px;">👤 ${escapeHtml(s.applicant.nameBn || 'আবেদনকারী অজানা')} • 📱 ${escapeHtml(s.applicant.mobile || 'নেই')} • <b>${escapeHtml(curTimerLabel)}</b></div>
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
    const sumGem = AI_MODEL_CATALOG[savedGeminiModel] || AI_MODEL_CATALOG['gemini-3.1-flash-lite'];
    const sumPeak = isDeepSeekPeakUtc();
    html += `
      <div class="fc-sum-card" style="background: #f0f9ff; border-color: #7dd3fc;">
        <div class="fc-sum-row">
          <div>
            <div style="font-weight: 800; color: #0369a1; font-size: 12px;">💰 AI স্ক্যান খরচ ও ডিফল্ট মডেল</div>
            <div style="font-size: 11px; color: #0c4a6e; margin-top: 2px;">
              ডিফল্ট কী: <b>${escapeHtml(savedDefaultKeySlot)}</b> • Gemini: <b>${escapeHtml(sumGem.label)}</b> • DeepSeek: <b>${sumPeak ? 'Peak $0.30/$1.20' : 'Off-Peak $0.15/$0.60'}</b>
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
        survey_status: { stringValue: (s.readinessPct >= 85 && s.blockers.length === 0) ? 'COMPLETED' : 'INCOMPLETE_ACTIONABLE' },
        summary_synced_at: { timestampValue: new Date().toISOString() }
      };
      if (lastCapturedHouseGps && typeof lastCapturedHouseGps.lat === 'number') {
        fields.lat = { doubleValue: lastCapturedHouseGps.lat };
        fields.lng = { doubleValue: lastCapturedHouseGps.lng };
        fields.accuracy = { integerValue: String(lastCapturedHouseGps.accuracy || 10) };
        fields.plus_code = { stringValue: lastCapturedHouseGps.plusCode || '' };
      }
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
        <button type="button" id="fc-sum-open-trace-btn" class="fc-trace-jump-btn" style="background:#0284c7; color:#fff; border-color:#0284c7;">🗺️ পূর্ণাঙ্গ ট্রেস খুলুন</button>
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
    const openTraceBtn = traceCard.querySelector('#fc-sum-open-trace-btn');
    if (openTraceBtn) {
      openTraceBtn.onclick = () => {
        sm.style.display = 'none';
        if (typeof window.__fcOpenModal === 'function') window.__fcOpenModal();
        switchBmTab('trace');
      };
    }
    traceCard.querySelectorAll('[data-sum-focus-tab]').forEach(btn => {
      btn.addEventListener('click', async () => {
        sm.style.display = 'none';
        const t = btn.getAttribute('data-sum-focus-tab');
        const k = btn.getAttribute('data-sum-focus-key') || '';
        if (k) await focusPortalField(t, [k]);
        else jumpToPortalSection(t);
      });
    });

    body.querySelector('#fc-sum-scan-btn').onclick = () => {
      sm.style.display = 'none';
      openMemberScanner(null, 'auto');
    };

    sm.style.display = 'flex';
  }

  summaryBtn.addEventListener('click', openSummaryModal);

  // --- SECTION 11: CROSS-DEVICE ROOM MESSENGER & DATA SHARING HUB ---
  const ROOM_FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/room_channels';
  const ROOM_EDGE_API = 'https://familycard-10n.pages.dev/api/room-messages';
  function normalizeRoomCode(r) {
    const clean = String(r || 'FC-101').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
    return clean || 'FC-101';
  }
  const myClientId = (() => {
    const saved = String(localStorage.getItem('fc_client_id') || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);
    if (saved && saved.startsWith('bm_')) {
      if (saved !== localStorage.getItem('fc_client_id')) localStorage.setItem('fc_client_id', saved);
      return saved;
    }
    const id = 'bm_' + Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 8).padEnd(6, '0');
    localStorage.setItem('fc_client_id', id);
    return id;
  })();
  let roomCode = normalizeRoomCode(localStorage.getItem('fc_room_code') || 'FC-101');
  let myDeviceName = localStorage.getItem('fc_device_name') || 'ট্যাব-বুকমার্কলেট';
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
    const dotEl = document.getElementById('fc-bm-chat-peers-dot');
    const stEl = document.getElementById('fc-bm-chat-status');

    if (others.length > 0) {
      const summary = others.slice(0, 3).map((p) => {
        const tag = p.client === 'companion' ? 'মোবাইল' : (p.client === 'extension' ? 'এক্সটেনশন' : (p.client || 'ওয়েব'));
        return `${p.name || 'ডিভাইস'} (${tag})`;
      }).join(', ');
      if (dotEl) {
        dotEl.textContent = `● ${toBnDigits(totalCount)}`;
        dotEl.style.display = 'inline-block';
      }
      if (stEl) {
        stEl.style.color = '#065f46';
        stEl.textContent = `🟢 রুম "${targetRoom}": ${toBnDigits(totalCount)}টি ডিভাইস যুক্ত — ${summary}${others.length > 3 ? ` +${others.length - 3}` : ''}`;
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
    const badge = document.getElementById('fc-bm-chat-badge');
    if (!badge) return;
    if (roomUnreadCount > 0) {
      badge.textContent = toBnDigits(roomUnreadCount);
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  function ensureChatModal() {
    let cm = document.getElementById('fc-bm-chat-modal');
    if (cm) return cm;
    cm = document.createElement('div');
    cm.id = 'fc-bm-chat-modal';
    cm.className = 'fc-bm-overlay';
    cm.style.display = 'none';
    cm.innerHTML = `
      <div class="fc-bm-card" style="max-width: 500px;">
        <div class="fc-bm-hdr" style="background: linear-gradient(135deg, #4f46e5, #3730a3);">
          <h3>💬 রুম মেসেঞ্জার ও ডাটা শেয়ার</h3>
          <span id="fc-bm-chat-close">&times;</span>
        </div>
        <div class="fc-bm-body" style="gap: 8px;">
          <div style="background:#f8fafc; border:1px solid #cbd5e1; border-radius:10px; padding:8px; display:flex; flex-direction:column; gap:6px;">
            <div class="fc-bm-row">
              <div class="fc-bm-col">
                <label for="fc-bm-room-input">🔗 রুম কোড:</label>
                <input type="text" id="fc-bm-room-input" value="${escapeHtml(roomCode)}" maxlength="20" style="text-transform:uppercase; font-weight:700;">
              </div>
              <div class="fc-bm-col">
                <label for="fc-bm-device-name">📱 আমার নাম:</label>
                <input type="text" id="fc-bm-device-name" value="${escapeHtml(myDeviceName)}" maxlength="32">
              </div>
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
              <button type="button" id="fc-bm-room-join-btn" class="fc-chat-chip primary">✅ রুম সেভ/যোগ</button>
              <button type="button" id="fc-bm-room-link-btn" class="fc-chat-chip accent">🔗 ফোনের লিংক কপি</button>
              <label style="font-size:11px; font-weight:700; color:#334155; display:inline-flex; align-items:center; gap:4px; margin:0; cursor:pointer;">
                <input type="checkbox" id="fc-bm-room-autofill" style="width:auto;" ${roomAutoFillEnabled ? 'checked' : ''}> ⚡ NID এলে অটো-ফিল
              </label>
              <button type="button" id="fc-bm-chat-refresh" class="fc-chat-chip" title="রিফ্রেশ">🔄</button>
              <button type="button" id="fc-bm-chat-clear" class="fc-chat-chip" title="মুছুন">🗑️</button>
            </div>
            <div id="fc-bm-chat-status" style="font-size:10.5px; color:#0f766e; font-weight:700;">☁️ ক্লাউড রুম সক্রিয় (${escapeHtml(roomCode)})</div>
          </div>

          <div id="fc-bm-chat-feed" class="fc-chat-feed">
            <div style="text-align:center; color:#64748b; padding:24px 8px;">লোড হচ্ছে...</div>
          </div>

          <div id="fc-bm-chat-reply-bar" style="display:none; align-items:center; justify-content:space-between; background:#eef2ff; border-left:3px solid #4f46e5; padding:4px 8px; border-radius:6px; font-size:11px;">
            <span id="fc-bm-chat-reply-txt"></span>
            <button type="button" id="fc-bm-chat-reply-cancel" style="border:none; background:none; font-weight:bold; cursor:pointer;">✕</button>
          </div>

          <div style="display:flex; flex-wrap:wrap; gap:5px;">
            <button type="button" id="fc-bm-chat-share-nid" class="fc-chat-chip primary">🪪 শেষ স্ক্যান পাঠান</button>
            <button type="button" id="fc-bm-chat-share-sum" class="fc-chat-chip accent">📊 সারসংক্ষেপ</button>
            <button type="button" class="fc-chat-chip" data-bm-qmsg="✅ কাজ সম্পন্ন">✅ সম্পন্ন</button>
            <button type="button" class="fc-chat-chip" data-bm-qmsg="মোবাইল নম্বর পাঠান 📱">📱 নম্বর দিন</button>
          </div>

          <div style="display:flex; gap:6px;">
            <input type="text" id="fc-bm-chat-input" placeholder="মেসেজ, মোবাইল নম্বর বা তথ্য লিখুন..." style="flex:1; padding:8px 10px; border:1.5px solid #cbd5e1; border-radius:8px; font-size:12.5px;">
            <button type="button" id="fc-bm-chat-send" style="background:#4f46e5; color:#fff; border:none; border-radius:8px; padding:8px 14px; font-weight:700; font-size:12.5px; cursor:pointer;">📤</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(cm);

    cm.querySelector('#fc-bm-chat-close').onclick = () => { cm.style.display = 'none'; };
    cm.onclick = (e) => { if (e.target === cm) cm.style.display = 'none'; };

    const inpRoom = cm.querySelector('#fc-bm-room-input');
    const inpName = cm.querySelector('#fc-bm-device-name');
    const chkAuto = cm.querySelector('#fc-bm-room-autofill');

    const applyRoomJoin = (notify = false) => {
      const nextRoom = normalizeRoomCode(inpRoom.value);
      inpRoom.value = nextRoom;
      myDeviceName = inpName.value.trim() || 'ট্যাব-বুকমার্কলেট';
      localStorage.setItem('fc_device_name', myDeviceName);
      if (nextRoom !== roomCode) {
        roomCode = nextRoom;
        localStorage.setItem('fc_room_code', roomCode);
        roomMsgMap.clear();
        lastRoomMetaSig = '';
        lastRoomClearedMs = 0;
        roomBootstrapped = false;
        renderChatFeed();
      }
      const stEl = cm.querySelector('#fc-bm-chat-status');
      if (stEl) {
        stEl.style.color = '#1e40af';
        stEl.textContent = `⏳ রুম "${roomCode}"-এ যুক্ত হচ্ছে...`;
      }
      fetchRoomMessages(true);
      if (notify) showToast(`🔗 রুম "${roomCode}"-এ যুক্ত হয়েছেন!`);
    };

    cm.querySelector('#fc-bm-room-join-btn').onclick = () => {
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
      myDeviceName = inpName.value.trim() || 'ট্যাব-বুকমার্কলেট';
      localStorage.setItem('fc_device_name', myDeviceName);
      fetchRoomMessages(false);
    });

    cm.querySelector('#fc-bm-room-link-btn').onclick = async () => {
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

    cm.querySelector('#fc-bm-chat-refresh').onclick = () => fetchRoomMessages(true);
    cm.querySelector('#fc-bm-chat-clear').onclick = async () => {
      if (!confirm(`রুম "${roomCode}"-এর সব মেসেজ মুছবেন?`)) return;
      const clearedAt = Date.now();
      lastRoomClearedMs = clearedAt;
      roomMsgMap.clear();
      renderChatFeed();
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

    cm.querySelector('#fc-bm-chat-reply-cancel').onclick = () => {
      pendingReplyMsg = null;
      cm.querySelector('#fc-bm-chat-reply-bar').style.display = 'none';
    };

    cm.querySelector('#fc-bm-chat-share-nid').onclick = () => {
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

    cm.querySelector('#fc-bm-chat-share-sum').onclick = () => {
      const s = collectFullFamilyCardSummary();
      const txt = buildBanglaSummaryReportText(s);
      sendRoomMessage({
        type: 'summary',
        text: txt,
        payload: { familyId: s.familyId, readinessPct: s.readinessPct, memberCount: s.members.length }
      });
    };

    cm.querySelectorAll('[data-bm-qmsg]').forEach((b) => {
      b.onclick = () => sendRoomMessage({ type: 'text', text: b.getAttribute('data-bm-qmsg') });
    });

    const msgInp = cm.querySelector('#fc-bm-chat-input');
    const submitChat = () => {
      const txt = msgInp.value.trim();
      if (!txt) return;
      msgInp.value = '';
      sendRoomMessage({ type: 'text', text: txt });
    };
    cm.querySelector('#fc-bm-chat-send').onclick = submitChat;
    msgInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitChat(); }
    });

    cm.querySelector('#fc-bm-chat-feed').addEventListener('click', async (e) => {
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
        adoptOrStartPortalTimerForScan(norm, {
          startReason: 'bm_room_fill_applicant',
          remoteStartedAtMs: Number(msg.payload?.survey_started_at_ms || 0),
          remoteSessionId: String(msg.payload?.survey_session_id || '')
        });
        renderLastScanPreview(norm);
        window.__fcStep1FilledKey = '';
        cm.style.display = 'none';
        await fillPortalFields(norm, { overwriteExisting: true });
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
        const bmMob = document.getElementById('fc-bm-mobile');
        if (bmMob) bmMob.value = mob;
        const tab1 = document.querySelector('[data-family-card-tab="1"]');
        const mobScope = tab1 || (!document.querySelector('[data-family-card-tab]') ? document : null);
        const mobInp = mobScope ? findInputByLabel(FC_FIELD_SPECS.mobile, mobScope) : null;
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
        const rBar = cm.querySelector('#fc-bm-chat-reply-bar');
        const rTxt = cm.querySelector('#fc-bm-chat-reply-txt');
        if (rTxt) rTxt.textContent = `↩️ ${pendingReplyMsg.senderName}: ${pendingReplyMsg.preview}`;
        if (rBar) rBar.style.display = 'flex';
        msgInp.focus();
      }
    });

    return cm;
  }

  function renderChatFeed() {
    const feed = document.getElementById('fc-bm-chat-feed');
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
      const chatModal = document.getElementById('fc-bm-chat-modal');
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
        adoptOrStartPortalTimerForScan(norm, {
          startReason: 'bm_room_fill_applicant',
          remoteStartedAtMs: Number(msg.payload?.survey_started_at_ms || 0),
          remoteSessionId: String(msg.payload?.survey_session_id || '')
        });
        renderLastScanPreview(norm);
        window.__fcStep1FilledKey = '';
        fillPortalFields(norm, { overwriteExisting: false });
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
      const edgeUrl = `${ROOM_EDGE_API}?room=${encodeURIComponent(targetRoom)}&metaOnly=${useMetaOnly ? '1' : '0'}&peerId=${encodeURIComponent(myClientId)}&peerName=${encodeURIComponent(myDeviceName)}&peerClient=bookmarklet&t=${Date.now()}`;
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
                    name: { stringValue: String(myDeviceName || 'ট্যাব-বুকমার্কলেট').slice(0, 50) },
                    client: { stringValue: 'bookmarklet' },
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

    const stEl = document.getElementById('fc-bm-chat-status');
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
      senderClient: 'bookmarklet',
      senderId: myClientId,
      peerId: myClientId,
      peerName: myDeviceName,
      peerClient: 'bookmarklet',
      replyTo: pendingReplyMsg,
      ts,
      createdAt: new Date(ts).toISOString()
    };
    pendingReplyMsg = null;
    const rBar = document.getElementById('fc-bm-chat-reply-bar');
    if (rBar) rBar.style.display = 'none';
    roomMsgMap.set(msg.id, msg);
    renderChatFeed();

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
                        name: { stringValue: String(myDeviceName || 'ট্যাব-বুকমার্কলেট').slice(0, 50) },
                        client: { stringValue: 'bookmarklet' },
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
    const inpRoom = cm.querySelector('#fc-bm-room-input');
    if (inpRoom && inpRoom.value !== roomCode) inpRoom.value = roomCode;
    cm.style.display = 'flex';
    fetchRoomMessages(true);
    renderChatFeed();
  }

  chatBtn.addEventListener('click', openChatModal);
  const hdrChatBtn = document.getElementById('fc-bm-hdr-chat');
  if (hdrChatBtn) {
    hdrChatBtn.addEventListener('click', () => {
      modal.style.display = 'none';
      openChatModal();
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchRoomMessages(false);
  });
  window.__fcOpenChatModal = openChatModal;
  window.__fcSendRoomMessage = sendRoomMessage;
  setTimeout(() => fetchRoomMessages(true), 900);
  setInterval(() => {
    const cm = document.getElementById('fc-bm-chat-modal');
    if (cm && cm.style.display === 'flex') fetchRoomMessages(false);
  }, 2500);
  setInterval(() => {
    const cm = document.getElementById('fc-bm-chat-modal');
    if (!cm || cm.style.display !== 'flex') fetchRoomMessages(false);
  }, 6000);

  let lastSummaryUpdateAt = 0;

  function updateSummaryBadge(force = false, precomputed = null) {
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

  // ==========================================================================
  // ⏱️ SINGLE-SURVEY AUTOMATIC TIMER & FIRESTORE DB PERSISTENCE ENGINE
  // ==========================================================================
  const PORTAL_TIMER_STORAGE_KEY = 'fc_portal_active_survey_timer_v1';
  const PORTAL_TIMER_PENDING_KEY = 'fc_portal_pending_survey_timers_v1';
  const PORTAL_TIMER_HISTORY_KEY = 'fc_portal_survey_timer_history_v1';
  const FIRESTORE_SURVEY_TIMERS_LOG_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/SURVEY_TIMERS/logs';
  const FIRESTORE_SURVEY_TIMERS_COLLECTION_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/survey_timers';
  const EDGE_SURVEY_TIMER_API = 'https://familycard-10n.pages.dev/api/survey-timer';

  let activePortalTimer = null;
  let portalTimerTickInterval = null;
  let portalTimerHooksAttached = false;
  let pendingPortalSubmitAt = 0;

  function formatPortalTimerClock(totalSec = 0) {
    const sec = Math.max(0, Math.round(Number(totalSec) || 0));
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const rem = sec % 60;
    const pad = (n) => toBnDigits(String(n).padStart(2, '0'));
    return hrs > 0 ? `${pad(hrs)}:${pad(mins)}:${pad(rem)}` : `${pad(mins)}:${pad(rem)}`;
  }

  function formatPortalTimerDurationLabel(totalSec = 0) {
    const sec = Math.max(0, Math.round(Number(totalSec) || 0));
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const rem = sec % 60;
    if (hrs > 0) return `${toBnDigits(hrs)} ঘঃ ${toBnDigits(mins)} মিঃ ${toBnDigits(rem)} সেঃ`;
    if (mins > 0) return `${toBnDigits(mins)} মিঃ ${toBnDigits(rem)} সেঃ`;
    return `${toBnDigits(sec)} সেঃ`;
  }

  function getPortalTimerElapsedSec(state = activePortalTimer, nowMs = Date.now()) {
    if (!state || !state.startedAtMs) return 0;
    if (state.status === 'ended') {
      if (typeof state.durationSec === 'number') return Math.max(0, state.durationSec);
      if (state.endedAtMs) return Math.max(0, Math.round((state.endedAtMs - state.startedAtMs) / 1000));
    }
    return Math.max(0, Math.round((nowMs - state.startedAtMs) / 1000));
  }

  function getPortalSurveyTimerState() {
    if (activePortalTimer) return activePortalTimer;
    try {
      const raw = localStorage.getItem(PORTAL_TIMER_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.sessionId) activePortalTimer = parsed;
    } catch (_) {}
    return activePortalTimer;
  }

  function savePortalSurveyTimerState(state) {
    activePortalTimer = state;
    try {
      if (state) localStorage.setItem(PORTAL_TIMER_STORAGE_KEY, JSON.stringify(state));
      else localStorage.removeItem(PORTAL_TIMER_STORAGE_KEY);
    } catch (_) {}
  }

  function pushPortalTimerLocalHistory(entry) {
    if (!entry || !entry.sessionId) return;
    try {
      const arr = JSON.parse(localStorage.getItem(PORTAL_TIMER_HISTORY_KEY) || '[]');
      const next = Array.isArray(arr) ? arr.filter((x) => x && x.sessionId !== entry.sessionId) : [];
      next.unshift(entry);
      localStorage.setItem(PORTAL_TIMER_HISTORY_KEY, JSON.stringify(next.slice(0, 60)));
    } catch (_) {}
  }

  function updateBmTimerBadgeUI() {
    const btn = document.getElementById('fc-bm-timer-btn') || timerDockBtn;
    const st = getPortalSurveyTimerState();
    const sec = getPortalTimerElapsedSec(st);
    const clock = formatPortalTimerClock(sec);
    if (btn) {
      btn.classList.remove('running', 'ended');
      let label = `⏱️ ${clock}`;
      if (st && st.status === 'running') {
        btn.classList.add('running');
        label = `⏱️ ${clock}`;
      } else if (st && st.status === 'ended') {
        btn.classList.add('ended');
        label = `✅ ${clock}`;
      }
      if (btn.dataset.lastLabel !== label) {
        btn.dataset.lastLabel = label;
        btn.innerHTML = `<span>${label}</span>`;
      }
    }
    const mClock = document.getElementById('fc-bm-tm-clock');
    const mStatus = document.getElementById('fc-bm-tm-status');
    if (mClock) mClock.textContent = clock;
    if (mStatus) {
      mStatus.textContent = st && st.status === 'running'
        ? `চলমান (${formatPortalTimerDurationLabel(sec)})`
        : (st && st.status === 'ended' ? `সম্পন্ন: ${formatPortalTimerDurationLabel(sec)}` : 'প্রস্তুত');
    }
  }

  function startPortalTimerTicker() {
    if (portalTimerTickInterval) clearInterval(portalTimerTickInterval);
    portalTimerTickInterval = setInterval(() => {
      const st = getPortalSurveyTimerState();
      if (st && st.status === 'running') updateBmTimerBadgeUI();
    }, 1000);
  }

  function startPortalSurveyTimer(meta = {}) {
    const prev = getPortalSurveyTimerState();
    if (meta.archivePreviousIfMeaningful && prev && prev.status === 'running') {
      const prevSec = getPortalTimerElapsedSec(prev);
      if (prevSec >= 3 && (prev.familyId || prev.docId || prev.docNumber || prev.applicantName)) {
        endPortalSurveyTimer('new_survey_rollover', { skipBroadcast: true });
      }
    }
    const now = Date.now();
    const curUrlKey = (window.location?.pathname || '') + (window.location?.search || '');
    const state = {
      sessionId: meta.sessionId || `srv_${now}_${Math.random().toString(36).slice(2, 7)}`,
      status: 'running',
      startedAtMs: Number(meta.startedAtMs) > 0 ? Number(meta.startedAtMs) : now,
      endedAtMs: null,
      durationSec: 0,
      durationMs: 0,
      durationLabel: '০ সেঃ',
      familyId: String(meta.familyId || '').trim(),
      docId: String(meta.docId || meta.familyId || '').trim(),
      docNumber: String(meta.docNumber || '').trim(),
      applicantName: String(meta.applicantName || '').trim(),
      docType: String(meta.docType || '').trim(),
      portalUrlKey: String(meta.portalUrlKey || curUrlKey),
      startReason: String(meta.startReason || 'portal_new_survey'),
      endReason: '',
      readinessPct: 0,
      pendingSubmitAt: 0,
      syncedToDb: false
    };
    pendingPortalSubmitAt = 0;
    savePortalSurveyTimerState(state);
    startPortalTimerTicker();
    updateBmTimerBadgeUI();
    return state;
  }

  function adoptOrStartPortalTimerForScan(data, meta = {}) {
    if (!data) return getPortalSurveyTimerState();
    const curFid = scrapeFamilyId() || data.family_id || '';
    const docNumber = String(data.doc_number || data.nid_number || data.birth_reg_no || '').trim();
    const applicantName = String(data.name_bn || data.name_en || '').trim();
    const docType = String(data.doc_type || 'nid').trim();
    const st = getPortalSurveyTimerState();
    const now = Date.now();
    const validRemoteStart = Number(meta.remoteStartedAtMs) > 0 && (now - Number(meta.remoteStartedAtMs)) < 6 * 3600 * 1000
      ? Number(meta.remoteStartedAtMs)
      : 0;

    if (!st || st.status === 'ended') {
      return startPortalSurveyTimer({
        sessionId: validRemoteStart && meta.remoteSessionId ? meta.remoteSessionId : undefined,
        startedAtMs: validRemoteStart || now,
        familyId: curFid,
        docId: curFid || docNumber,
        docNumber,
        applicantName,
        docType,
        startReason: meta.startReason || 'ocr_scan'
      });
    }

    if (curFid && st.familyId && curFid !== st.familyId) {
      return startPortalSurveyTimer({
        archivePreviousIfMeaningful: true,
        sessionId: validRemoteStart && meta.remoteSessionId ? meta.remoteSessionId : undefined,
        startedAtMs: validRemoteStart || now,
        familyId: curFid,
        docId: curFid || docNumber,
        docNumber,
        applicantName,
        docType,
        startReason: meta.startReason || 'new_family_scan'
      });
    }

    if (validRemoteStart && validRemoteStart < st.startedAtMs && (st.startedAtMs - validRemoteStart) < 3600000) {
      st.startedAtMs = validRemoteStart;
      if (meta.remoteSessionId) st.sessionId = meta.remoteSessionId;
    }
    if (curFid && !st.familyId) st.familyId = curFid;
    if (docNumber) st.docNumber = docNumber;
    if (!st.docId && (curFid || docNumber)) st.docId = curFid || docNumber;
    if (applicantName) st.applicantName = applicantName;
    if (docType) st.docType = docType;
    savePortalSurveyTimerState(st);
    updateBmTimerBadgeUI();
    return st;
  }

  async function persistPortalSurveyTimerToDb(entry, opts = {}) {
    if (!entry || !entry.sessionId) return false;
    const payload = {
      sessionId: entry.sessionId,
      familyId: entry.familyId || '',
      docId: entry.docId || entry.familyId || entry.docNumber || '',
      applicantName: entry.applicantName || '',
      docType: entry.docType || '',
      source: 'bookmarklet',
      roomCode: typeof roomCode === 'string' ? roomCode : '',
      deviceName: typeof myDeviceName === 'string' ? myDeviceName : '',
      surveyStatus: entry.surveyStatus || 'COMPLETED',
      status: 'ended',
      readinessPct: Number(entry.readinessPct || 0),
      startReason: entry.startReason || 'portal_survey',
      endReason: entry.endReason || 'portal_submit',
      startedAtMs: entry.startedAtMs,
      endedAtMs: entry.endedAtMs,
      durationMs: entry.durationMs,
      durationSec: entry.durationSec,
      durationLabel: entry.durationLabel
    };

    try {
      const q = JSON.parse(localStorage.getItem(PORTAL_TIMER_PENDING_KEY) || '[]');
      const next = q.filter((x) => x && x.sessionId !== payload.sessionId);
      next.push(payload);
      localStorage.setItem(PORTAL_TIMER_PENDING_KEY, JSON.stringify(next.slice(-30)));
    } catch (_) {}

    const fields = {
      session_id: { stringValue: payload.sessionId },
      family_id: { stringValue: payload.familyId },
      doc_id: { stringValue: payload.docId },
      applicant_name: { stringValue: payload.applicantName },
      doc_type: { stringValue: payload.docType },
      source: { stringValue: payload.source },
      room_code: { stringValue: payload.roomCode },
      device_name: { stringValue: payload.deviceName },
      survey_status: { stringValue: payload.surveyStatus },
      timer_status: { stringValue: 'ended' },
      readiness_pct: { integerValue: String(payload.readinessPct) },
      start_reason: { stringValue: payload.startReason },
      end_reason: { stringValue: payload.endReason },
      started_at_ms: { integerValue: String(payload.startedAtMs) },
      ended_at_ms: { integerValue: String(payload.endedAtMs) },
      started_at: { timestampValue: new Date(payload.startedAtMs).toISOString() },
      ended_at: { timestampValue: new Date(payload.endedAtMs).toISOString() },
      duration_ms: { integerValue: String(payload.durationMs) },
      duration_sec: { integerValue: String(payload.durationSec) },
      duration_label: { stringValue: payload.durationLabel }
    };
    const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    let synced = false;
    try {
      const bodyStr = JSON.stringify({ fields });
      const [fsRes] = await Promise.all([
        fetch(`${FIRESTORE_SURVEY_TIMERS_LOG_BASE}/${encodeURIComponent(payload.sessionId)}?${mask}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: bodyStr,
          keepalive: true
        }).catch(() => null),
        fetch(`${FIRESTORE_SURVEY_TIMERS_COLLECTION_BASE}/${encodeURIComponent(payload.sessionId)}?${mask}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: bodyStr,
          keepalive: true
        }).catch(() => null)
      ]);
      if (fsRes && fsRes.ok) synced = true;

      const targetDocIds = !opts.skipDocPatch
        ? Array.from(new Set([payload.familyId, payload.docId].filter((id) => id && id !== 'SURVEY_TIMERS')))
        : [];
      if (targetDocIds.length > 0) {
        const docFields = {
          survey_session_id: { stringValue: payload.sessionId },
          survey_started_at: { timestampValue: new Date(payload.startedAtMs).toISOString() },
          survey_ended_at: { timestampValue: new Date(payload.endedAtMs).toISOString() },
          survey_duration_sec: { integerValue: String(payload.durationSec) },
          survey_duration_label: { stringValue: payload.durationLabel },
          survey_timer_status: { stringValue: 'ended' }
        };
        const docMask = Object.keys(docFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
        for (const targetId of targetDocIds) {
          fetch(`https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(targetId)}?${docMask}&currentDocument.exists=true`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: docFields }),
            keepalive: true
          }).catch(() => {});
          fetch(`https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(targetId)}/logs/${encodeURIComponent(`timer_${payload.sessionId}`)}?${mask}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: bodyStr,
            keepalive: true
          }).catch(() => {});
        }
      }

      const edgeRes = await fetch(EDGE_SURVEY_TIMER_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => null);
      if (edgeRes && edgeRes.ok) synced = true;
    } catch (_) {}

    if (synced) {
      try {
        const q = JSON.parse(localStorage.getItem(PORTAL_TIMER_PENDING_KEY) || '[]');
        localStorage.setItem(PORTAL_TIMER_PENDING_KEY, JSON.stringify(q.filter((x) => x && x.sessionId !== payload.sessionId)));
      } catch (_) {}
    }
    return synced;
  }

  async function flushPendingPortalTimers() {
    try {
      const q = JSON.parse(localStorage.getItem(PORTAL_TIMER_PENDING_KEY) || '[]');
      if (!Array.isArray(q) || q.length === 0) return;
      for (const item of q.slice(0, 10)) {
        await persistPortalSurveyTimerToDb(item, { skipDocPatch: true });
      }
    } catch (_) {}
  }

  async function endPortalSurveyTimer(endReason = 'portal_submit', opts = {}) {
    const st = getPortalSurveyTimerState();
    if (!st) return null;
    if (st.status === 'ended' && !opts.forceUpdate) return st;

    const now = Number(opts.endedAtMs) > 0 ? Number(opts.endedAtMs) : Date.now();
    const endedAtMs = Math.max(st.startedAtMs, now);
    const durationMs = Math.max(0, endedAtMs - st.startedAtMs);
    const durationSec = Math.round(durationMs / 1000);
    const durationLabel = formatPortalTimerDurationLabel(durationSec);
    const summarySnap = typeof collectFullFamilyCardSummary === 'function' ? collectFullFamilyCardSummary() : null;

    const finalState = {
      ...st,
      status: 'ended',
      endedAtMs,
      durationMs,
      durationSec,
      durationLabel,
      familyId: String(opts.familyId || st.familyId || summarySnap?.familyId || '').trim(),
      docId: String(opts.docId || st.docId || opts.familyId || st.familyId || summarySnap?.familyId || summarySnap?.applicant?.nid || st.docNumber || '').trim(),
      applicantName: String(opts.applicantName || st.applicantName || summarySnap?.applicant?.nameBn || '').trim(),
      readinessPct: Number(opts.readinessPct ?? summarySnap?.readinessPct ?? st.readinessPct ?? 0),
      surveyStatus: String(opts.surveyStatus || ((summarySnap?.readinessPct || 0) >= 85 && (summarySnap?.blockers?.length || 0) === 0 ? 'COMPLETED' : 'ENDED')),
      endReason: String(endReason || 'portal_submit'),
      syncedToDb: false
    };
    savePortalSurveyTimerState(finalState);
    pushPortalTimerLocalHistory(finalState);
    updateBmTimerBadgeUI();

    if (!opts.skipBroadcast && typeof sendRoomMessage === 'function') {
      Promise.resolve(sendRoomMessage({
        type: 'survey_timer_ended',
        text: `⏱️ জরিপ সম্পন্ন (${finalState.applicantName || finalState.familyId || finalState.docId || 'সার্ভে'}): ${durationLabel}`,
        payload: {
          sessionId: finalState.sessionId,
          familyId: finalState.familyId,
          docId: finalState.docId,
          applicantName: finalState.applicantName,
          endedAtMs: finalState.endedAtMs,
          durationSec: finalState.durationSec,
          durationLabel: finalState.durationLabel,
          endReason: finalState.endReason
        }
      })).catch(() => {});
    }

    const synced = await persistPortalSurveyTimerToDb(finalState, { skipDocPatch: Boolean(opts.skipDocPatch) });
    if (activePortalTimer && activePortalTimer.sessionId === finalState.sessionId) {
      activePortalTimer.syncedToDb = synced;
      savePortalSurveyTimerState(activePortalTimer);
      updateBmTimerBadgeUI();
    }
    return finalState;
  }

  function isPortalSurveyFormVisible() {
    return Boolean(document.querySelector('[data-family-card-tab], .family-card-form-step, .family-card-form-footer__btn--submit, #tab0, #tab1'));
  }

  function isStep0BlankForNewSurvey() {
    const tab0 = document.querySelector('[data-family-card-tab="0"]');
    if (!tab0 || !isPanelActiveVisible(tab0)) return false;
    const inputs = Array.from(tab0.querySelectorAll('input')).filter(i => !/hidden|checkbox|radio|button|submit|file/i.test(i.type || ''));
    if (inputs.length === 0) return false;
    return inputs.every(i => !String(i.value || '').trim());
  }

  function syncPortalSurveyLifecycle() {
    const formOpen = isPortalSurveyFormVisible();
    const curFid = scrapeFamilyId() || '';
    const curUrlKey = (window.location?.pathname || '') + (window.location?.search || '');
    const st = getPortalSurveyTimerState();
    const now = Date.now();

    if (formOpen) {
      if (!st) {
        startPortalSurveyTimer({ familyId: curFid, portalUrlKey: curUrlKey, startReason: 'portal_form_open' });
        return;
      }
      if (st.status === 'running') {
        if (st.familyId && curFid && curFid !== st.familyId) {
          startPortalSurveyTimer({
            archivePreviousIfMeaningful: true,
            familyId: curFid,
            portalUrlKey: curUrlKey,
            startReason: 'new_family_id'
          });
          return;
        }
        let updated = false;
        if (!st.familyId && curFid) {
          st.familyId = curFid;
          if (!st.docId) st.docId = curFid;
          updated = true;
        }
        if (curFid && typeof autoCaptureHouseLocationOnStep2 === 'function') {
          autoCaptureHouseLocationOnStep2(curFid, st.applicantName || lastExtractedData?.name_bn || '');
        }
        if (lastExtractedData?.name_bn && !st.applicantName) {
          st.applicantName = lastExtractedData.name_bn;
          updated = true;
        }
        if (updated) savePortalSurveyTimerState(st);

        const activeDialogText = document.querySelector('.v-snack--active, .swal2-popup')?.textContent || '';
        if (/সফলভাবে\s*(?:জমা|দাখিল|সংরক্ষণ)|আবেদন\s*সফল|submitted\s*successfully/i.test(activeDialogText)) {
          endPortalSurveyTimer('portal_success_toast');
        }
        return;
      }
      const msSinceEnd = now - Number(st.endedAtMs || 0);
      if (msSinceEnd > 2200) {
        if (curFid && curFid !== st.familyId) {
          startPortalSurveyTimer({ familyId: curFid, portalUrlKey: curUrlKey, startReason: 'new_family_id_after_end' });
          return;
        }
        if (curUrlKey !== st.portalUrlKey) {
          startPortalSurveyTimer({ familyId: curFid, portalUrlKey: curUrlKey, startReason: 'new_route_after_end' });
          return;
        }
        if (!curFid && (st.familyId || st.docNumber) && msSinceEnd > 3200 && isStep0BlankForNewSurvey()) {
          startPortalSurveyTimer({ familyId: '', portalUrlKey: curUrlKey, startReason: 'step0_reset_after_end' });
        }
      }
    } else if (st && st.status === 'running' && pendingPortalSubmitAt > 0 && now - pendingPortalSubmitAt < 120000) {
      endPortalSurveyTimer('portal_submit_navigated');
    }
  }

  function attachPortalSubmitTimerHooks() {
    if (portalTimerHooksAttached) return;
    portalTimerHooksAttached = true;

    document.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('button, [role="button"], .v-btn');
      if (!btn) return;
      if (btn.closest('[id^="fc-"], #fc-bm-dock')) return;

      const isDisabled = Boolean(btn.disabled || btn.classList.contains('v-btn--disabled'));
      const txt = normalizeBn(btn.textContent || '');
      const isSubmitBtn = btn.matches('.family-card-form-footer__btn--submit')
        || (btn.closest('.family-card-form-footer') && /দাখিল|সাবমিট|জমা|Submit/i.test(txt));

      if (isSubmitBtn && !isDisabled) {
        pendingPortalSubmitAt = Date.now();
        const st = getPortalSurveyTimerState();
        if (st && st.status === 'running') {
          st.pendingSubmitAt = pendingPortalSubmitAt;
          savePortalSurveyTimerState(st);
          endPortalSurveyTimer('portal_submit', { endedAtMs: pendingPortalSubmitAt }).then((done) => {
            if (done) showToast(`⏱️ জরিপ সম্পন্ন: ${done.durationLabel} (ডাটাবেসে সংরক্ষিত)`);
          });
        }
        return;
      }

      const inDialog = btn.closest('.v-dialog--active, .swal2-popup');
      if (inDialog && pendingPortalSubmitAt > 0 && Date.now() - pendingPortalSubmitAt < 60000) {
        if (/না|বাতিল|বন্ধ|cancel|close/i.test(txt)) {
          const st = getPortalSurveyTimerState();
          if (st && st.status === 'ended' && st.endReason === 'portal_submit') {
            st.status = 'running';
            st.endedAtMs = null;
            st.endReason = '';
            pendingPortalSubmitAt = 0;
            savePortalSurveyTimerState(st);
            startPortalTimerTicker();
            updateBmTimerBadgeUI();
          }
        } else if (/হ্যাঁ|নিশ্চিত|দাখিল|জমা|সাবমিট|ok|confirm|yes/i.test(txt)) {
          endPortalSurveyTimer('portal_submit_confirmed', { forceUpdate: true });
        }
      }
    }, true);

    const wrapHistory = (fnName) => {
      const orig = history[fnName];
      if (typeof orig === 'function' && !orig.__fcTimerWrapped) {
        history[fnName] = function (...args) {
          const ret = orig.apply(this, args);
          setTimeout(syncPortalSurveyLifecycle, 120);
          return ret;
        };
        history[fnName].__fcTimerWrapped = true;
      }
    };
    wrapHistory('pushState');
    wrapHistory('replaceState');
    window.addEventListener('popstate', () => setTimeout(syncPortalSurveyLifecycle, 120));
    window.addEventListener('hashchange', () => setTimeout(syncPortalSurveyLifecycle, 120));
    window.addEventListener('pagehide', () => { flushPendingPortalTimers(); });
  }

  async function openBmTimerModal() {
    let tm = document.getElementById('fc-bm-timer-modal');
    if (!tm) {
      tm = document.createElement('div');
      tm.id = 'fc-bm-timer-modal';
      tm.className = 'fc-bm-overlay';
      tm.style.display = 'none';
      tm.innerHTML = `
        <div class="fc-bm-card" style="max-width:460px;">
          <div class="fc-bm-hdr" style="background:linear-gradient(135deg,#0f172a,#1e3a8a);">
            <h3>⏱️ সার্ভে সময় ও ডাটাবেস হিসাব</h3>
            <button type="button" id="fc-bm-tm-close" class="fc-bm-hdr-btn">✕</button>
          </div>
          <div class="fc-bm-body" style="display:flex; flex-direction:column; gap:10px; max-height:78vh; overflow-y:auto;">
            <div style="background:#f8fafc; border:1.5px solid #cbd5e1; border-radius:10px; padding:10px 12px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
              <div>
                <div style="font-size:11.5px; color:#475569; font-weight:700;">বর্তমান সার্ভে অবস্থা</div>
                <div id="fc-bm-tm-status" style="font-size:13px; font-weight:800; color:#0f172a;">প্রস্তুত</div>
              </div>
              <div id="fc-bm-tm-clock" style="font-family:monospace; font-size:20px; font-weight:800; color:#0f766e; background:#f0fdf4; border:1px solid #86efac; padding:4px 10px; border-radius:8px;">০০:০০</div>
            </div>
            <div style="display:flex; gap:6px;">
              <button type="button" id="fc-bm-tm-start" style="flex:1; background:#16a34a; color:#fff; border:none; border-radius:8px; padding:9px; font-weight:700; font-size:12px; cursor:pointer;">▶️ নতুন সার্ভে শুরু</button>
              <button type="button" id="fc-bm-tm-end" style="flex:1; background:#dc2626; color:#fff; border:none; border-radius:8px; padding:9px; font-weight:700; font-size:12px; cursor:pointer;">⏹️ শেষ ও সেভ</button>
            </div>
            <div id="fc-bm-tm-stats" style="font-size:11.5px; font-weight:700; color:#1e3a8a;">⏳ ডাটাবেস হিসাব লোড হচ্ছে...</div>
            <div id="fc-bm-tm-list" style="display:flex; flex-direction:column; gap:5px;"></div>
          </div>
        </div>
      `;
      document.body.appendChild(tm);
      tm.querySelector('#fc-bm-tm-close').onclick = () => { tm.style.display = 'none'; };
      tm.onclick = (e) => { if (e.target === tm) tm.style.display = 'none'; };
      tm.querySelector('#fc-bm-tm-start').onclick = () => {
        startPortalSurveyTimer({ familyId: scrapeFamilyId() || '', startReason: 'manual_start' });
        showToast('⏱️ নতুন সার্ভে টাইমার শুরু হয়েছে!');
        updateBmTimerBadgeUI();
      };
      tm.querySelector('#fc-bm-tm-end').onclick = async () => {
        const done = await endPortalSurveyTimer('manual_end');
        if (done) {
          showToast(`✅ জরিপ শেষ: ${done.durationLabel} (ডাটাবেসে সেভ)`);
          loadBmTimerModalList();
        }
      };
    }
    tm.style.display = 'flex';
    updateBmTimerBadgeUI();
    loadBmTimerModalList();
  }

  async function loadBmTimerModalList() {
    const statsEl = document.getElementById('fc-bm-tm-stats');
    const listEl = document.getElementById('fc-bm-tm-list');
    if (!statsEl || !listEl) return;
    let localArr = [];
    try {
      const r = JSON.parse(localStorage.getItem(PORTAL_TIMER_HISTORY_KEY) || '[]');
      if (Array.isArray(r)) localArr = r;
    } catch (_) {}
    let remoteArr = [];
    try {
      let pageToken = '';
      for (let page = 0; page < 10; page++) {
        const resp = await fetch(`${FIRESTORE_SURVEY_TIMERS_LOG_BASE}?pageSize=300&t=${Date.now()}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { cache: 'no-store' }).catch(() => null);
        if (!resp || !resp.ok) break;
        const j = await resp.json().catch(() => ({}));
        const docs = Array.isArray(j.documents) ? j.documents : [];
        for (const d of docs) {
          const f = d.fields || {};
          remoteArr.push({
            sessionId: f.session_id?.stringValue || d.name?.split('/').pop() || '',
            familyId: f.family_id?.stringValue || '',
            docId: f.doc_id?.stringValue || '',
            applicantName: f.applicant_name?.stringValue || '',
            source: f.source?.stringValue || '',
            endedAtMs: Number(f.ended_at_ms?.integerValue || f.ended_at_ms?.doubleValue || 0),
            durationSec: Number(f.duration_sec?.integerValue || 0),
            durationLabel: f.duration_label?.stringValue || ''
          });
        }
        if (!j.nextPageToken) break;
        pageToken = j.nextPageToken;
      }
    } catch (_) {}
    const merged = new Map();
    for (const x of [...localArr, ...remoteArr]) {
      if (x && x.sessionId) merged.set(x.sessionId, x);
    }
    const items = Array.from(merged.values()).sort((a, b) => (b.endedAtMs || 0) - (a.endedAtMs || 0));
    if (items.length === 0) {
      statsEl.textContent = '📊 এখনো কোনো সার্ভের সময় ডাটাবেসে নেই';
      listEl.innerHTML = '';
      return;
    }
    const avg = Math.round(items.reduce((a, b) => a + (Number(b.durationSec) || 0), 0) / items.length);
    statsEl.textContent = `📊 মোট ${toBnDigits(items.length)}টি সার্ভে • গড় সময়: ${formatPortalTimerDurationLabel(avg)}`;
    listEl.innerHTML = items.slice(0, 15).map((t) => {
      const who = t.applicantName || t.familyId || t.docId || 'সার্ভে';
      const dur = t.durationLabel || formatPortalTimerDurationLabel(t.durationSec || 0);
      return `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px; border-radius:7px; background:#f8fafc; border:1px solid #e2e8f0; font-size:11.5px;"><span>👤 <b>${escapeHtml(who)}</b> <small style="color:#64748b;">(${escapeHtml(t.source || '')})</small></span><b style="color:#0369a1;">⏱️ ${escapeHtml(dur)}</b></div>`;
    }).join('');
  }

  attachPortalSubmitTimerHooks();
  flushPendingPortalTimers();
  startPortalTimerTicker();
  updateBmTimerBadgeUI();

  function runPortalAutomations() {
    syncPortalSurveyLifecycle();
    if (document.hidden || activeMediaStream) return;

    const curFid = scrapeFamilyId() || '';
    if (curFid) {
      if (!lastExtractedData || (lastExtractedData.family_id && lastExtractedData.family_id !== curFid)) {
        const cachedForFamily = getCachedFamilyScan(curFid, false);
        if (cachedForFamily) lastExtractedData = cachedForFamily;
      }
    }

    const tab1 = document.querySelector('[data-family-card-tab="1"]');
    const isTab1Visible = Boolean(tab1 && isPanelActiveVisible(tab1));
    if (isTab1Visible) {
      injectSection2Toolbar(tab1);
      if (lastExtractedData && !isFillingPortalFields && (!lastExtractedData.family_id || !curFid || lastExtractedData.family_id === curFid)) {
        const { docNumber } = resolveDocNumberAndType(lastExtractedData);
        const stepSig = `${curFid}_${docNumber || ''}`;
        if (window.__fcStep1FilledKey !== stepSig) {
          fillPortalFields(lastExtractedData, { overwriteExisting: false }).then((didFill) => {
            if (window.__fcStep1FilledKey === stepSig && didFill) {
              injectSection2Toolbar(tab1);
              showToast('✅ স্টেপ ২: পিতা-মাতা, বৈবাহিক অবস্থা ও ধর্ম অটো-ফিল সম্পন্ন!');
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

    // Auto Smart Cloud Backup (debounced, non-blocking)
    if (scrapeFamilyId()) {
      clearTimeout(smartBackupThrottleTimer);
      smartBackupThrottleTimer = setTimeout(() => {
        triggerSmartCloudBackup('portal_step_change', false);
      }, 5000);
    }
  }

  // Debounced MutationObserver (ignores assistant UI & ripple animations for lag-free scrolling/tapping)
  let observerTimer = null;
  const observer = new MutationObserver((mutations) => {
    const hasPortalMutation = mutations.some(m => {
      const t = m.target;
      return t && t.nodeType === 1 && !t.closest('[id^="fc-"], [class*="fc-bm-"], .fc-card-scan-btn, .v-ripple__container, .v-ripple__animation');
    });
    if (!hasPortalMutation) return;
    clearTimeout(observerTimer);
    observerTimer = setTimeout(runPortalAutomations, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

  // Non-blocking initial pass + lightweight 2500ms fallback polling
  setTimeout(runPortalAutomations, 60);
  setInterval(runPortalAutomations, 2500);

  function showToast(msg) {
    const existing = document.querySelector('.fc-bm-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.className = 'fc-bm-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.remove(); }, 4000);
  }

  showToast('🚀 Family Card সহকারী (v2.0.0) প্রস্তুত! স্টেপ ১-৯ অটো-ফিল, রুম মেসেজ বা সারসংক্ষেপ চাপুন।');
})();
