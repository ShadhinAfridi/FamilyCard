// Family Card NID AI Auto-Filler Bookmarklet (v1.3 Production - Zero Bugs)
// Fixes:
// 1. Strict Bengali-to-English numeral normalization (০-৯ -> 0-9)
// 2. Comprehensive Date Standardization (DD/MM/YYYY, ISO, Month Names)
// 3. Resilient Vuetify Dropdown Polling (Handles animations on slow tablets)
// 4. Live In-Page WebRTC Camera + Canvas Capture (Prevents Android LMK tab reloading)
// 5. Automatic DOM Scraping of 'পরিবার আইডি' (Family ID)
// 6. Direct Real-Time Firebase Firestore Replication (rajbari-city-app-16601)
(function () {
  'use strict';

  if (window.__familyCardAssistantLoaded) {
    const existingModal = document.getElementById('fc-bm-modal');
    if (existingModal) {
      existingModal.style.display = 'flex';
      return;
    }
  }
  window.__familyCardAssistantLoaded = true;

  console.log('[FamilyCard Assistant v1.3] Initializing on target portal...');

  let lastExtractedData = null;
  let savedApiKey = localStorage.getItem('fc_gemini_api_key') || '';
  let activeMediaStream = null;
  let savedPostcode = localStorage.getItem('fc_default_postcode') || '7721';
  let savedVillageList = JSON.parse(localStorage.getItem('fc_village_list') || '["বসাকুষ্টিয়া", "চর কলিমহর"]');
  let savedDefaultVillage = localStorage.getItem('fc_default_village') || savedVillageList[0] || 'বসাকুষ্টিয়া';

  // --- Utility: Bengali-to-English Digit Normalizer ---
  function normalizeDigits(str) {
    if (!str) return '';
    const bn = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
    return String(str).replace(/[০-৯]/g, d => {
      const idx = bn.indexOf(d);
      return idx !== -1 ? idx : d;
    });
  }

  // --- Utility: Date of Birth Standardizer to DD/MM/YYYY ---
  function standardizeDate(dobStr) {
    if (!dobStr) return '';
    let str = normalizeDigits(dobStr).trim();

    // ISO format: YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = str.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (isoMatch) {
      return `${isoMatch[3].padStart(2, '0')}/${isoMatch[2].padStart(2, '0')}/${isoMatch[1]}`;
    }

    // Month name format: 15 Apr 1988
    const months = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };
    const monthNameMatch = str.match(/^(\d{1,2})\s+([a-zA-Z]{3,})\s+(\d{4})/i);
    if (monthNameMatch) {
      const d = monthNameMatch[1].padStart(2, '0');
      const m = months[monthNameMatch[2].toLowerCase().substring(0, 3)] || '01';
      const y = monthNameMatch[3];
      return `${d}/${m}/${y}`;
    }

    // Standard DD/MM/YYYY or DD-MM-YYYY
    str = str.replace(/[-\.]/g, '/');
    const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dmyMatch) {
      return `${dmyMatch[1].padStart(2, '0')}/${dmyMatch[2].padStart(2, '0')}/${dmyMatch[3]}`;
    }

    return str;
  }

  // --- Utility: DOM Scraper for পরিবার আইডি ---
  function scrapeFamilyId() {
    const text = document.body.innerText || '';
    const match = text.match(/পরিবার আইডি:\s*([০-৯0-9]+)/);
    if (match) return normalizeDigits(match[1]);
    return null;
  }

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
4. "dob": Extract Date of Birth in DD/MM/YYYY format using standard English numerals (e.g. 15/04/1988).
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

  // Inject Styles
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #fc-bm-fab {
      position: fixed; bottom: 24px; right: 20px; z-index: 9999999;
      background: linear-gradient(135deg, #1976d2, #0d47a1); color: #fff;
      padding: 12px 20px; border-radius: 30px; box-shadow: 0 4px 18px rgba(13,71,161,0.45);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px; font-weight: 700; cursor: pointer; display: flex; align-items: center;
      gap: 8px; border: 2px solid #fff; user-select: none; animation: fc-bm-pop 0.3s ease;
    }
    @keyframes fc-bm-pop { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    .fc-bm-overlay {
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(0,0,0,0.68); z-index: 10000000;
      display: flex; align-items: center; justify-content: center; padding: 12px; box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      backdrop-filter: blur(2px);
    }
    .fc-bm-card {
      background: #fff; width: 100%; max-width: 440px; border-radius: 16px; overflow: hidden;
      box-shadow: 0 20px 40px rgba(0,0,0,0.35); display: flex; flex-direction: column;
    }
    .fc-bm-hdr {
      background: #1c3b68; color: #fff; padding: 14px 18px; display: flex;
      justify-content: space-between; align-items: center;
    }
    .fc-bm-hdr h3 { margin: 0; font-size: 15px; font-weight: 700; }
    .fc-bm-hdr span { cursor: pointer; font-size: 20px; font-weight: bold; }
    .fc-bm-body {
      padding: 14px; display: flex; flex-direction: column; gap: 10px; max-height: 85vh; overflow-y: auto;
    }
    .fc-bm-cam-box {
      width: 100%; aspect-ratio: 16/10; background: #000; border-radius: 10px; overflow: hidden;
      display: flex; align-items: center; justify-content: center; position: relative;
    }
    .fc-bm-cam-box video { width: 100%; height: 100%; object-fit: cover; }
    .fc-bm-cam-bracket {
      position: absolute; width: 24px; height: 24px; border-color: #38bdf8; border-style: solid; pointer-events: none;
    }
    .tl { top: 10px; left: 10px; border-width: 3px 0 0 3px; }
    .tr { top: 10px; right: 10px; border-width: 3px 3px 0 0; }
    .bl { bottom: 10px; left: 10px; border-width: 0 0 3px 3px; }
    .br { bottom: 10px; right: 10px; border-width: 0 3px 3px 0; }
    .fc-bm-btn-group { display: flex; gap: 8px; }
    .fc-bm-cam-btn {
      flex: 1; background: linear-gradient(135deg, #1976d2, #0284c7); color: #fff; border: none; padding: 12px;
      border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; display: flex;
      align-items: center; justify-content: center; gap: 6px; box-shadow: 0 4px 12px rgba(2,132,199,0.3);
    }
    .fc-bm-secondary-btn {
      background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; padding: 12px;
      border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .fc-bm-row { display: flex; gap: 10px; }
    .fc-bm-col { flex: 1; display: flex; flex-direction: column; gap: 4px; }
    .fc-bm-col label { font-size: 11.5px; font-weight: 600; color: #475569; }
    .fc-bm-col select, .fc-bm-col input {
      padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 13px; box-sizing: border-box; width: 100%;
    }
    .fc-bm-toast {
      position: fixed; top: 40px; right: 20px; z-index: 10000001; background: #166534; color: #fff;
      padding: 12px 18px; border-radius: 8px; box-shadow: 0 8px 20px rgba(0,0,0,0.25);
      font-size: 13.5px; font-weight: 600; animation: fc-bm-pop 0.3s ease;
    }
    .fc-bm-spinner {
      width: 32px; height: 32px; border: 4px solid #e2e8f0; border-top-color: #1976d2;
      border-radius: 50%; animation: fc-bm-spin 0.8s linear infinite; margin: 0 auto;
    }
    @keyframes fc-bm-spin { to { transform: rotate(360deg); } }

    /* --- Section 3 Media Tracer & Guardian HUD --- */
    #fc-section3-hud {
      position: fixed; bottom: 84px; right: 20px; z-index: 9999998;
      width: 320px; background: #ffffff; border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.18); border: 2px solid #1c3b68;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden; transition: all 0.25s ease;
    }
    #fc-section3-hud.minimized {
      width: auto; background: #1c3b68; border-color: #38bdf8;
    }
    #fc-section3-hud.minimized .fc-s3-body { display: none; }
    .fc-s3-header {
      background: #1c3b68; color: #fff; padding: 10px 14px;
      display: flex; align-items: center; justify-content: space-between;
      cursor: pointer; user-select: none;
    }
    .fc-s3-header h4 {
      margin: 0; font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 6px;
    }
    .fc-s3-toggle {
      font-size: 16px; font-weight: bold; cursor: pointer; color: #94a3b8;
    }
    .fc-s3-body {
      padding: 12px; display: flex; flex-direction: column; gap: 8px; font-size: 12px;
    }
    .fc-s3-item {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 8px; border-radius: 8px; background: #f8fafc; border: 1px solid #e2e8f0;
    }
    .fc-s3-item-lbl {
      font-weight: 600; color: #334155; display: flex; align-items: center; gap: 6px;
    }
    .fc-s3-badge {
      font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 6px;
    }
    .fc-s3-badge-pending { background: #fef3c7; color: #92400e; }
    .fc-s3-badge-ready { background: #e0f2fe; color: #0369a1; }
    .fc-s3-badge-done { background: #dcfce7; color: #166534; }
    .fc-s3-badge-opt { background: #f3e8ff; color: #6b21a8; }
    .fc-s3-progress-wrap {
      width: 100%; background: #e2e8f0; border-radius: 10px; height: 6px; overflow: hidden;
    }
    .fc-s3-progress-bar {
      height: 100%; width: 0%; background: linear-gradient(90deg, #10b981, #059669);
      transition: width 0.3s ease;
    }
    .fc-s3-note {
      font-size: 10.5px; color: #64748b; line-height: 1.4; background: #f1f5f9; padding: 6px 8px; border-radius: 6px;
    }

    /* --- Section 5 & Tab 6 Cross-Matching Engine HUD --- */
    #fc-crossmatch-hud {
      position: fixed; bottom: 84px; left: 20px; z-index: 9999998;
      width: 330px; background: #ffffff; border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.18); border: 2px solid #0f766e;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden; transition: all 0.25s ease;
    }
    #fc-crossmatch-hud.minimized {
      width: auto; background: #0f766e; border-color: #2dd4bf;
    }
    #fc-crossmatch-hud.minimized .fc-cm-body { display: none; }
    .fc-cm-header {
      background: #0f766e; color: #fff; padding: 10px 14px;
      display: flex; align-items: center; justify-content: space-between;
      cursor: pointer; user-select: none;
    }
    .fc-cm-header h4 {
      margin: 0; font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 6px;
    }
    .fc-cm-toggle {
      font-size: 16px; font-weight: bold; cursor: pointer; color: #99f6e4;
    }
    .fc-cm-body {
      padding: 12px; display: flex; flex-direction: column; gap: 8px; font-size: 12px;
    }
    .fc-cm-verdict {
      padding: 8px 10px; border-radius: 8px; font-weight: 700; font-size: 11.5px; text-align: center;
      transition: all 0.2s ease;
    }
    .fc-cm-verdict-matched { background: #dcfce7; color: #15803d; border: 1.5px solid #86efac; }
    .fc-cm-verdict-pending { background: #fef3c7; color: #b45309; border: 1.5px solid #fcd34d; }
    .fc-cm-verdict-mismatch { background: #fee2e2; color: #b91c1c; border: 1.5px solid #fca5a5; }
    .fc-cm-verdict-excess { background: #fee2e2; color: #991b1b; border: 1.5px solid #f87171; }
    .fc-cm-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
    }
    .fc-cm-stat-card {
      background: #f0fdfa; border: 1px solid #ccfbf1; border-radius: 8px; padding: 6px 8px;
    }
    .fc-cm-stat-title {
      font-size: 10px; color: #0d9488; font-weight: 700; text-transform: uppercase;
    }
    .fc-cm-stat-val {
      font-size: 12.5px; font-weight: 800; color: #115e59; margin-top: 2px;
    }
    .fc-cm-detail-list {
      display: flex; flex-direction: column; gap: 4px; font-size: 11px;
    }
    .fc-cm-row {
      display: flex; justify-content: space-between; align-items: center; padding: 5px 8px;
      border-radius: 6px; background: #f8fafc; border: 1px solid #e2e8f0;
    }
    .fc-cm-badge {
      padding: 2px 8px; border-radius: 6px; font-size: 10.5px; font-weight: 700;
    }
    .fc-cm-badge-matched { background: #dcfce7; color: #15803d; }
    .fc-cm-badge-pending { background: #fef3c7; color: #b45309; }
    .fc-cm-badge-excess { background: #fee2e2; color: #b91c1c; }
  `;
  document.head.appendChild(styleEl);

  // Inject Floating Action Button
  const fab = document.createElement('div');
  fab.id = 'fc-bm-fab';
  fab.innerHTML = '<span>📸 NID স্ক্যান</span>';
  document.body.appendChild(fab);

  // Inject Modal
  const modal = document.createElement('div');
  modal.id = 'fc-bm-modal';
  modal.className = 'fc-bm-overlay';
  modal.style.display = 'none';

  modal.innerHTML = `
    <div class="fc-bm-card">
      <div class="fc-bm-hdr">
        <h3>🪪 NID AI সহকারী (v1.3 Production)</h3>
        <span id="fc-bm-close">&times;</span>
      </div>
      <div class="fc-bm-body">
        <input type="file" id="fc-bm-file-input" accept="image/*" capture="environment" style="display: none;">
        
        <div id="fc-bm-viewfinder" class="fc-bm-cam-box" style="display: none;">
          <video id="fc-bm-video" playsinline autoplay muted></video>
          <div class="fc-bm-cam-bracket tl"></div>
          <div class="fc-bm-cam-bracket tr"></div>
          <div class="fc-bm-cam-bracket bl"></div>
          <div class="fc-bm-cam-bracket br"></div>
        </div>

        <div id="fc-bm-img-wrap" class="fc-bm-cam-box" style="display: none; background: #f8fafc;">
          <img id="fc-bm-img" style="max-width: 100%; max-height: 100%; object-fit: contain;">
        </div>

        <div class="fc-bm-btn-group">
          <button id="fc-bm-btn-cam" class="fc-bm-cam-btn">
            <span>📷 লাইভ ক্যামেরা</span>
          </button>
          <button id="fc-bm-btn-snap" class="fc-bm-cam-btn" style="display: none; background: linear-gradient(135deg, #16a34a, #15803d);">
            <span>⚡ ছবি তুলুন</span>
          </button>
          <button id="fc-bm-btn-gallery" class="fc-bm-secondary-btn">
            <span>📁 ফাইল/গ্যালারি</span>
          </button>
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
          <label for="fc-bm-mobile">📱 মোবাইল নম্বর (ঐচ্ছিক - ট্যাবলেটে ম্যানুয়ালি লিখতে পারেন):</label>
          <input type="tel" id="fc-bm-mobile" placeholder="যেমন: 019XXXXXXXX" maxlength="11">
        </div>

        <!-- Section 4 Address Settings (তথ্য সংগ্রহের ঠিকানা) -->
        <div style="background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <label style="font-size: 12px; font-weight: 700; color: #1c3b68;">📍 সেকশন ৪: তথ্য সংগ্রহের ঠিকানা</label>
            <span style="font-size: 10px; color: #64748b;">(স্থায়ী ঠিকানা অপরিবর্তিত)</span>
          </div>
          <div class="fc-bm-row">
            <div class="fc-bm-col">
              <label for="fc-bm-postcode">📮 পোস্ট কোড* (ডিফল্ট: 7721)</label>
              <input type="text" id="fc-bm-postcode" value="${savedPostcode}" placeholder="7721">
            </div>
            <div class="fc-bm-col">
              <label for="fc-bm-village">🏠 গ্রাম নির্বাচন*</label>
              <select id="fc-bm-village">
                ${savedVillageList.map(v => `<option value="${v}" ${v === savedDefaultVillage ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="display: flex; gap: 6px;">
            <input type="text" id="fc-bm-new-village" placeholder="নতুন গ্রামের নাম লিখুন..." style="flex: 1; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px;">
            <button id="fc-bm-btn-add-village" type="button" class="fc-bm-secondary-btn" style="padding: 6px 12px; font-size: 12px; font-weight: 700; background: #0284c7; color: #fff; border: none; border-radius: 8px; cursor: pointer;">+ যোগ</button>
          </div>
        </div>

        <div class="fc-bm-col">
          <label for="fc-bm-apikey">⚙️ Gemini API Key:</label>
          <input type="password" id="fc-bm-apikey" placeholder="AIzaSy..." value="${savedApiKey}">
        </div>

        <div id="fc-bm-loading" style="display: none; text-align: center; padding: 10px;">
          <div class="fc-bm-spinner"></div>
          <p style="margin: 8px 0 0 0; font-size: 13px; font-weight: 600; color: #1976d2;">Gemini AI দিয়ে NID স্ক্যান হচ্ছে...</p>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const closeBtn = document.getElementById('fc-bm-close');
  const btnCam = document.getElementById('fc-bm-btn-cam');
  const btnSnap = document.getElementById('fc-bm-btn-snap');
  const btnGallery = document.getElementById('fc-bm-btn-gallery');
  const fileInput = document.getElementById('fc-bm-file-input');
  const inputApiKey = document.getElementById('fc-bm-apikey');
  const loading = document.getElementById('fc-bm-loading');
  const imgWrap = document.getElementById('fc-bm-img-wrap');
  const imgPreview = document.getElementById('fc-bm-img');
  const viewFinder = document.getElementById('fc-bm-viewfinder');
  const videoElem = document.getElementById('fc-bm-video');
  const inputPostcode = document.getElementById('fc-bm-postcode');
  const selectVillage = document.getElementById('fc-bm-village');
  const inputNewVillage = document.getElementById('fc-bm-new-village');
  const btnAddVillage = document.getElementById('fc-bm-btn-add-village');

  inputPostcode.addEventListener('change', () => {
    savedPostcode = inputPostcode.value.trim() || '7721';
    localStorage.setItem('fc_default_postcode', savedPostcode);
  });

  selectVillage.addEventListener('change', () => {
    savedDefaultVillage = selectVillage.value;
    localStorage.setItem('fc_default_village', savedDefaultVillage);
  });

  btnAddVillage.addEventListener('click', () => {
    const newName = inputNewVillage.value.trim();
    if (!newName) return;
    if (!savedVillageList.includes(newName)) {
      savedVillageList.push(newName);
      localStorage.setItem('fc_village_list', JSON.stringify(savedVillageList));
    }
    savedDefaultVillage = newName;
    localStorage.setItem('fc_default_village', savedDefaultVillage);
    selectVillage.innerHTML = savedVillageList.map(v => `<option value="${v}" ${v === savedDefaultVillage ? 'selected' : ''}>${v}</option>`).join('');
    inputNewVillage.value = '';
    showToast(`✅ গ্রাম "${newName}" সফলভাবে যোগ করা হয়েছে এবং ডিফল্ট করা হলো!`);
  });

  fab.addEventListener('click', () => { modal.style.display = 'flex'; });
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

  // Start Live WebRTC Camera (Prevents Android LMK Chrome process kill)
  btnCam.addEventListener('click', async () => {
    savedApiKey = inputApiKey.value.trim();
    if (!savedApiKey) {
      alert('অনুগ্রহ করে নিচে আপনার Gemini API Key দিন।');
      inputApiKey.focus();
      return;
    }
    localStorage.setItem('fc_gemini_api_key', savedApiKey);

    try {
      if (activeMediaStream) stopLiveCamera();
      const constraints = {
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      };
      activeMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      videoElem.srcObject = activeMediaStream;
      viewFinder.style.display = 'flex';
      imgWrap.style.display = 'none';
      btnCam.style.display = 'none';
      btnSnap.style.display = 'flex';
    } catch (err) {
      console.warn('WebRTC Camera denied, falling back to file input:', err);
      fileInput.click();
    }
  });

  // Snap from live WebRTC video
  btnSnap.addEventListener('click', () => {
    if (!videoElem.videoWidth) {
      alert('ক্যামেরা প্রস্তুত নয়, অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।');
      return;
    }
    const canvas = document.createElement('canvas');
    let w = videoElem.videoWidth;
    let h = videoElem.videoHeight;
    const maxDim = 1600;
    if (w > maxDim || h > maxDim) {
      if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
      else { w = Math.round((w * maxDim) / h); h = maxDim; }
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElem, 0, 0, w, h);
    const base64Data = canvas.toDataURL('image/jpeg', 0.85);

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
    savedApiKey = inputApiKey.value.trim();
    if (!savedApiKey) {
      alert('অনুগ্রহ করে নিচে আপনার Gemini API Key দিন।');
      inputApiKey.focus();
      return;
    }
    localStorage.setItem('fc_gemini_api_key', savedApiKey);
    stopLiveCamera();
    fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const base64Data = await compressImage(file, 1600, 0.85);
      imgPreview.src = base64Data;
      imgWrap.style.display = 'flex';
      viewFinder.style.display = 'none';
      btnCam.textContent = '🔄 পুনরায় ছবি তুলুন';

      runGeminiOCR(base64Data);
    } catch (err) {
      alert('ছবি প্রক্রিয়াকরণ ব্যর্থ: ' + err.message);
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

  function compressImage(file, maxDim = 1600, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = (evt) => {
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
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Gemini Vision OCR execution
  async function runGeminiOCR(base64Image) {
    const apiKey = inputApiKey.value.trim() || localStorage.getItem('fc_gemini_api_key');
    if (!apiKey) {
      alert('Gemini API Key দেওয়া হয়নি!');
      return;
    }
    localStorage.setItem('fc_gemini_api_key', apiKey);

    loading.style.display = 'block';
    btnCam.style.display = 'none';
    btnGallery.style.display = 'none';

    try {
      const rawBase64 = base64Image.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`;

      const bodyPayload = {
        contents: [
          {
            parts: [
              { text: GEMINI_PROMPT },
              { inline_data: { mime_type: 'image/jpeg', data: rawBase64 } }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          response_mime_type: 'application/json'
        }
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload)
      });

      if (!res.ok) {
        const errTxt = await res.text();
        throw new Error(`Gemini API Error (${res.status}): ${errTxt}`);
      }

      const jsonRes = await res.json();
      const outputText = jsonRes.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!outputText) throw new Error('Gemini থেকে উত্তর পাওয়া যায়নি।');

      let cleanText = outputText.trim();
      if (cleanText.startsWith('```json')) cleanText = cleanText.substring(7);
      if (cleanText.startsWith('```')) cleanText = cleanText.substring(3);
      if (cleanText.endsWith('```')) cleanText = cleanText.substring(0, cleanText.length - 3);

      const data = JSON.parse(cleanText.trim());

      // 1. Bengali to English numeral normalization
      if (data.nid_number) data.nid_number = normalizeDigits(data.nid_number).replace(/[^0-9]/g, '');
      if (data.dob) data.dob = standardizeDate(data.dob);

      // 2. Strict 10 or 17 digit NID rule (prepend birth year if 13 digits)
      if (data.nid_number && data.nid_number.length === 13) {
        const ym = String(data.dob || '').match(/\b(19\d{2}|20\d{2})\b/);
        if (ym) data.nid_number = ym[1] + data.nid_number;
      }

      // 3. Uppercase English names
      if (data.name_en) data.name_en = String(data.name_en).toUpperCase();
      if (data.father_name_en) data.father_name_en = String(data.father_name_en).toUpperCase();
      if (data.mother_name_en) data.mother_name_en = String(data.mother_name_en).toUpperCase();

      data.marital_status = document.getElementById('fc-bm-marital').value;
      data.religion = document.getElementById('fc-bm-religion').value;
      data.mobile_number = normalizeDigits(document.getElementById('fc-bm-mobile').value.trim());

      // 4. Scrape current Family ID from portal DOM
      data.family_id = scrapeFamilyId() || '';

      lastExtractedData = data;
      modal.style.display = 'none';

      // 5. Fill portal fields
      fillPortalFields(data);
      showToast('✅ এনআইডি তথ্য সফলভাবে পূরণ হয়েছে!');

      // 6. Asynchronous real-time Firestore sync
      syncToFirestore(data);
    } catch (err) {
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
      const docId = data.family_id || data.nid_number || ('card_' + Date.now());
      const url = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(docId)}`;
      
      const firestoreDoc = {
        fields: {
          family_id: { stringValue: data.family_id || '' },
          nid_number: { stringValue: data.nid_number || '' },
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
          synced_at: { timestampValue: new Date().toISOString() }
        }
      };

      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(firestoreDoc)
      });
      console.log('[FamilyCard] Firestore synced successfully:', docId);
    } catch (e) {
      console.warn('[FamilyCard] Background Firestore sync notice:', e.message);
    }
  }

  // --- Vuetify Reactivity & Synthetic Event Dispatcher ---
  function setReactiveValue(input, value) {
    if (!input || value === undefined || value === null || value === '') return false;
    input.focus();

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));

    const container = input.closest('.v-input') || input;
    container.style.transition = 'background-color 0.4s ease';
    const oldBg = container.style.backgroundColor;
    container.style.backgroundColor = 'rgba(76, 175, 80, 0.2)';
    setTimeout(() => { container.style.backgroundColor = oldBg; }, 3000);
    return true;
  }

  function findInputByLabel(keywords) {
    const labels = Array.from(document.querySelectorAll('label'));
    for (const label of labels) {
      const text = label.textContent || '';
      if (keywords.some(k => text.includes(k))) {
        if (label.htmlFor) {
          const inp = document.getElementById(label.htmlFor);
          if (inp && !inp.disabled) return inp;
        }
        const parent = label.closest('.col, [class*="col-"], span, div');
        if (parent) {
          const inp = parent.querySelector('input:not([type="hidden"]):not([disabled])');
          if (inp) return inp;
        }
      }
    }
    return null;
  }

  // Polling Vuetify Dropdown Selector with retry for slow tablets
  function selectDropdown(labelKeywords, targetText) {
    if (!targetText) return;
    const labels = Array.from(document.querySelectorAll('label'));
    let container = null;
    for (const l of labels) {
      if (labelKeywords.some(k => (l.textContent || '').includes(k))) {
        container = l.closest('.col, [class*="col-"], span, div');
        break;
      }
    }
    if (!container) return;

    const currentSel = container.querySelector('.v-select__selection');
    if (currentSel && currentSel.textContent.trim().includes(targetText)) return;

    const clickTarget = container.querySelector('.v-input__slot') || container.querySelector('input');
    if (clickTarget) {
      clickTarget.click();
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        const items = Array.from(document.querySelectorAll('.v-menu__content .v-list-item, .v-menu__content .v-list-item__title'));
        for (const it of items) {
          if (it.textContent.trim().includes(targetText)) {
            const clickable = it.closest('.v-list-item') || it;
            clickable.click();
            clearInterval(interval);
            return;
          }
        }
        if (attempts >= 8) clearInterval(interval);
      }, 150);
    }
  }

  function fillPortalFields(data) {
    if (!data) return;

    // Step 0: NID Verification
    if (data.name_bn) setReactiveValue(findInputByLabel(['সম্পূর্ণ নাম (বাংলা)']) || document.getElementById('input-211'), data.name_bn);
    if (data.name_en) setReactiveValue(findInputByLabel(['সম্পূর্ণ নাম (ইংরেজি)']) || document.getElementById('input-213'), data.name_en);
    if (data.nid_number) setReactiveValue(findInputByLabel(['জাতীয় পরিচিতি নম্বর (এনআইডি)', 'জাতীয় পরিচিতি নম্বর']) || document.getElementById('input-215'), data.nid_number);
    if (data.dob) setReactiveValue(findInputByLabel(['জন্ম তারিখ']) || document.getElementById('input-221'), data.dob);
    if (data.gender) selectDropdown(['লিঙ্গ'], data.gender);

    // Step 1: Personal Details
    if (data.father_name_bn) setReactiveValue(findInputByLabel(['পিতার নাম (বাংলা)']) || document.getElementById('input-1286') || document.getElementById('input-242'), data.father_name_bn);
    if (data.father_name_en) setReactiveValue(findInputByLabel(['পিতার নাম (ইংরেজি)']) || document.getElementById('input-1288') || document.getElementById('input-244'), data.father_name_en);
    if (data.mother_name_bn) setReactiveValue(findInputByLabel(['মাতার নাম (বাংলা)']) || document.getElementById('input-1290') || document.getElementById('input-246'), data.mother_name_bn);
    if (data.mother_name_en) setReactiveValue(findInputByLabel(['মাতার নাম (ইংরেজি)']) || document.getElementById('input-1292') || document.getElementById('input-248'), data.mother_name_en);
    if (data.marital_status) selectDropdown(['বৈবাহিক অবস্থা'], data.marital_status);
    if (data.religion) selectDropdown(['ধর্ম'], data.religion);

    // Mobile number
    if (data.mobile_number) {
      setReactiveValue(findInputByLabel(['মোবাইল নম্বর']) || document.getElementById('input-1294') || document.getElementById('input-250'), data.mobile_number);
    }

    // Step 4: Collection Address Auto-fill
    handleSection4Address();
  }

  // --- SECTION 3: IMAGE GUARDIAN & COMPLIANCE SYSTEM ---
  // Compresses and resizes camera/gallery images to strictly satisfy portal requirements:
  // - Applicant Photo & Signature: < 195 KB, JPEG
  // - House Photo: < 195 KB, strictly <= 600x400 resolution
  function compressAndFitImage(file, maxW, maxH, maxBytes = 195 * 1024) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          let width = img.naturalWidth || img.width;
          let height = img.naturalHeight || img.height;

          // Downscale proportionally if larger than maximum bounds
          if (width > maxW || height > maxH) {
            const ratio = Math.min(maxW / width, maxH / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);

          let quality = 0.88;
          function tryEncode() {
            canvas.toBlob((blob) => {
              if (!blob) {
                reject(new Error('Canvas blob generation failed'));
                return;
              }
              if (blob.size > maxBytes && quality > 0.42) {
                quality -= 0.12;
                tryEncode();
              } else {
                const baseName = (file.name || 'image.jpg').replace(/\.[^/.]+$/, "");
                const optimizedFile = new File([blob], `${baseName}_optimized.jpg`, {
                  type: 'image/jpeg',
                  lastModified: Date.now()
                });
                resolve({
                  file: optimizedFile,
                  width,
                  height,
                  sizeKb: Math.round(blob.size / 1024)
                });
              }
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

    inputEl.addEventListener('change', async () => {
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
      const maxBytes = 195 * 1024;

      // Check if image exceeds portal 200KB limit or 600x400
      if (file.size > maxBytes || isHouse) {
        try {
          inputEl.__isOptimizing = true;
          const label = isHouse ? 'বাড়ির ছবি' : (isSig ? 'স্বাক্ষর' : 'আবেদনকারীর ছবি');
          showToast(`🛡️ ইমেজ গার্ডিয়ান: ${label} অপ্টিমাইজ করা হচ্ছে...`);

          const result = await compressAndFitImage(file, maxW, maxH, maxBytes);

          // Replace files via standard DataTransfer
          const dt = new DataTransfer();
          dt.items.add(result.file);
          inputEl.files = dt.files;

          showToast(`✅ ${label} সরকারি মাপে ফিট (${result.sizeKb} KB, ${result.width}x${result.height}) হয়েছে!`);

          // Notify Vuetify & Vue reactivity
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (err) {
          console.warn('[MediaGuardian] Failed to compress image:', err);
        } finally {
          setTimeout(() => { inputEl.__isOptimizing = false; }, 600);
        }
      }

      setTimeout(traceSection3Media, 400);
    });
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

  function traceSection3Media() {
    const imgInput = document.getElementById('image');
    const sigInput = document.getElementById('signature');
    const houseInput = document.getElementById('house_image');

    const s3Panel = document.querySelector('[data-family-card-tab="9"]') || 
                    document.querySelector('.fc-media-row') ||
                    document.querySelector('.fc-photo-preview') ||
                    imgInput;

    const hud = document.getElementById('fc-section3-hud');
    if (!s3Panel && !imgInput) {
      if (hud) hud.style.display = 'none';
      return;
    }

    injectSection3HUD();
    const hudEl = document.getElementById('fc-section3-hud');
    if (hudEl) hudEl.style.display = 'block';

    if (imgInput) attachMediaGuardian(imgInput, 'photo');
    if (sigInput) attachMediaGuardian(sigInput, 'signature');
    if (houseInput) attachMediaGuardian(houseInput, 'house');

    function getPreviewUrl(inputEl, customSelector) {
      if (!inputEl) return null;
      const parentCol = inputEl.closest('.col, [class*="col-"]') || inputEl.closest('.fc-media-col') || inputEl.parentElement;
      const previewContainer = (customSelector ? document.querySelector(customSelector) : null) ||
                               parentCol?.querySelector('.v-image') ||
                               inputEl.closest('.row')?.querySelector(customSelector || '.v-image');
      if (!previewContainer) return null;

      const imgDiv = previewContainer.querySelector('.v-image__image') || previewContainer;
      const bg = imgDiv?.style?.backgroundImage || '';
      const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (match && match[1] && !match[1].includes('data:image/svg')) {
        return match[1];
      }
      return null;
    }

    const photoUrl = getPreviewUrl(imgInput, '.fc-photo-preview');
    const photoHasFile = (imgInput?.files?.length || 0) > 0;
    const photoDone = !!(photoUrl && (photoUrl.includes('familycard-api.bhata.gov.bd') || photoUrl.startsWith('http') || photoUrl.startsWith('blob:') || photoUrl.startsWith('data:')));

    const sigUrl = getPreviewUrl(sigInput, '.fc-signature-preview');
    const sigHasFile = (sigInput?.files?.length || 0) > 0;
    const sigDone = !!(sigUrl && (sigUrl.includes('familycard-api.bhata.gov.bd') || sigUrl.startsWith('http') || sigUrl.startsWith('blob:') || sigUrl.startsWith('data:')));

    const houseUrl = getPreviewUrl(houseInput, '.fc-house-preview');
    const houseHasFile = (houseInput?.files?.length || 0) > 0;
    const houseDone = !!(houseUrl && (houseUrl.includes('familycard-api.bhata.gov.bd') || houseUrl.startsWith('http') || houseUrl.startsWith('blob:') || houseUrl.startsWith('data:')));

    function updateBadge(badgeId, isDone, hasFile, doneText) {
      const el = document.getElementById(badgeId);
      if (!el) return;
      if (isDone) {
        el.className = 'fc-s3-badge fc-s3-badge-done';
        el.textContent = doneText || '✅ আপলোড সম্পন্ন';
      } else if (hasFile) {
        el.className = 'fc-s3-badge fc-s3-badge-ready';
        el.textContent = '⏳ প্রস্তুত / আপলোড হচ্ছে';
      } else {
        el.className = 'fc-s3-badge fc-s3-badge-pending';
        el.textContent = '⏳ বাকি';
      }
    }

    updateBadge('fc-s3-status-photo', photoDone, photoHasFile, '✅ ছবি সম্পন্ন');
    updateBadge('fc-s3-status-sig', sigDone, sigHasFile, '✅ স্বাক্ষর সম্পন্ন');
    updateBadge('fc-s3-status-house', houseDone, houseHasFile, '✅ বাড়ি সম্পন্ন');

    const count = (photoDone ? 1 : 0) + (sigDone ? 1 : 0) + (houseDone ? 1 : 0);
    const ratioEl = document.getElementById('fc-s3-ratio');
    const progEl = document.getElementById('fc-s3-progress');
    const bnDigits = ['০', '১', '২', '৩'];

    if (ratioEl) ratioEl.textContent = `${bnDigits[count]}/৩`;
    if (progEl) progEl.style.width = `${Math.round((count / 3) * 100)}%`;

    const currentHash = `${photoUrl || ''}|${sigUrl || ''}|${houseUrl || ''}|${count}`;
    if (count > 0 && currentHash !== lastSyncedMediaHash) {
      lastSyncedMediaHash = currentHash;
      syncMediaToFirestore({
        applicant_photo_url: photoUrl || '',
        signature_url: sigUrl || '',
        house_photo_url: houseUrl || '',
        completed_count: count
      });
    }
  }

  async function syncMediaToFirestore(mediaData) {
    try {
      const rawId = scrapeFamilyId() || (lastExtractedData && lastExtractedData.family_id) || '8743033825';
      const cleanId = normalizeDigits(rawId).replace(/[^0-9]/g, '') || '8743033825';

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
  // Rules:
  // 1. Post code: defaults to "7721", customizable by user.
  // 2. Village: dropdown of village names ("বসাকুষ্টিয়া", "চর কলিমহর", etc.). Default persists across all forms.
  // 3. Strictly IGNORES "স্থায়ী ঠিকানা" (Permanent Address) - leaves 100% for manual activity.

  function getSection4CollectionInputs() {
    const allChips = Array.from(document.querySelectorAll('.v-chip, .v-chip__content, span, h3, h4, div'));
    const collectionChip = allChips.find(el => el.textContent.trim() === 'ফ্যামিলি কার্ড তথ্য সংগ্রহের ঠিকানা');
    if (!collectionChip) return { postCodeInput: null, villageInput: null };

    const permanentChip = allChips.find(el => el.textContent.trim() === 'স্থায়ী ঠিকানা' || el.textContent.trim() === 'স্থায়ী ঠিকানা');

    const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([disabled])'));

    const collectionInputs = allInputs.filter(inp => {
      const isAfterCollection = (inp.compareDocumentPosition(collectionChip) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
      const isBeforePermanent = !permanentChip || ((inp.compareDocumentPosition(permanentChip) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      return isAfterCollection && isBeforePermanent;
    });

    let postCodeInput = null;
    let villageInput = null;

    for (const inp of collectionInputs) {
      const parentCol = inp.closest('.col, [class*="col-"], .v-input, div');
      const labelText = parentCol?.querySelector('label')?.textContent || '';
      if (labelText.includes('পোস্ট কোড')) {
        postCodeInput = inp;
      } else if (labelText.includes('গ্রাম') || labelText.includes('বাড়ি নং') || labelText.includes('সেকশন')) {
        villageInput = inp;
      }
    }

    return { postCodeInput, villageInput };
  }

  function handleSection4Address() {
    const { postCodeInput, villageInput } = getSection4CollectionInputs();
    if (!postCodeInput && !villageInput) return;

    const currentPostcode = localStorage.getItem('fc_default_postcode') || '7721';
    const villageList = JSON.parse(localStorage.getItem('fc_village_list') || '["বসাকুষ্টিয়া", "চর কলিমহর"]');
    const currentVillage = localStorage.getItem('fc_default_village') || villageList[0] || 'বসাকুষ্টিয়া';

    if (postCodeInput && !postCodeInput.value) {
      setReactiveValue(postCodeInput, currentPostcode);
      console.log('[FamilyCard] Section 4 Post Code filled with default:', currentPostcode);
    }

    if (villageInput) {
      if (!villageInput.value) {
        setReactiveValue(villageInput, currentVillage);
        console.log('[FamilyCard] Section 4 Village filled with default:', currentVillage);
      }
      injectInlineVillageToolbar(villageInput, villageList, currentVillage, currentPostcode);
    }
  }

  function injectInlineVillageToolbar(villageInput, villageList, currentVillage, currentPostcode) {
    const parentContainer = villageInput.closest('.col, [class*="col-"]') || villageInput.parentElement;
    if (!parentContainer || parentContainer.querySelector('#fc-inline-village-bar')) return;

    const bar = document.createElement('div');
    bar.id = 'fc-inline-village-bar';
    bar.style.cssText = 'margin-bottom: 6px; padding: 6px 10px; background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; font-family: -apple-system, sans-serif; box-shadow: 0 2px 5px rgba(0,0,0,0.05);';

    let optionsHtml = villageList.map(v => `<option value="${v}" ${v === currentVillage ? 'selected' : ''}>${v}</option>`).join('');
    optionsHtml += '<option value="__ADD_NEW__">➕ নতুন গ্রাম যোগ করুন...</option>';

    bar.innerHTML = `
      <div style="display: flex; align-items: center; gap: 6px; font-weight: 700; color: #166534;">
        <span>🏠 গ্রাম:</span>
        <select id="fc-inline-village-select" style="padding: 3px 8px; border-radius: 6px; border: 1.5px solid #16a34a; font-size: 12px; font-weight: 700; background: #ffffff; color: #166534; cursor: pointer;">
          ${optionsHtml}
        </select>
      </div>
      <div style="font-size: 11px; color: #15803d; font-weight: 600;">
        📮 পোস্ট কোড: <b>${currentPostcode}</b> (তথ্য সংগ্রহের ঠিকানা)
      </div>
    `;

    parentContainer.insertBefore(bar, parentContainer.firstChild);

    const sel = bar.querySelector('#fc-inline-village-select');
    sel.addEventListener('change', () => {
      if (sel.value === '__ADD_NEW__') {
        const newName = prompt('নতুন গ্রামের নাম লিখুন:');
        if (newName && newName.trim()) {
          const trimmed = newName.trim();
          let list = JSON.parse(localStorage.getItem('fc_village_list') || '["বসাকুষ্টিয়া", "চর কলিমহর"]');
          if (!list.includes(trimmed)) {
            list.push(trimmed);
            localStorage.setItem('fc_village_list', JSON.stringify(list));
          }
          localStorage.setItem('fc_default_village', trimmed);
          setReactiveValue(villageInput, trimmed);
          showToast(`✅ নতুন গ্রাম "${trimmed}" যোগ করা হয়েছে এবং ডিফল্ট করা হলো!`);
          bar.remove();
          injectInlineVillageToolbar(villageInput, list, trimmed, currentPostcode);
        } else {
          sel.value = currentVillage;
        }
      } else {
        const chosen = sel.value;
        localStorage.setItem('fc_default_village', chosen);
        setReactiveValue(villageInput, chosen);
        showToast(`✅ গ্রাম "${chosen}" সেট করা হয়েছে (সব ফর্মে প্রযোজ্য)!`);
      }
    });
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

  function trackSection5Data() {
    const panel = document.querySelector('[data-family-card-tab="3"]') ||
                  Array.from(document.querySelectorAll('.v-expansion-panel')).find(p => p.textContent.includes('ফ্যামিলি কার্ড অনুযায়ী বিস্তারিত'));
    
    // Check if previously cached in localStorage
    const cached = JSON.parse(localStorage.getItem('fc_section5_data') || 'null');

    if (!panel) return cached;

    const data = {
      maleCount: cached ? cached.maleCount : 0,
      femaleCount: cached ? cached.femaleCount : 0,
      transCount: cached ? cached.transCount : 0,
      totalCount: cached ? cached.totalCount : 0,
      training: cached ? cached.training : '',
      mfsAccount: cached ? cached.mfsAccount : '',
      abroadMale: cached ? cached.abroadMale : 0,
      abroadFemale: cached ? cached.abroadFemale : 0,
      abroadTrans: cached ? cached.abroadTrans : 0
    };

    let hasFoundFields = false;
    const cols = Array.from(panel.querySelectorAll('.col, [class*="col-"]'));

    cols.forEach(col => {
      const labelEl = col.querySelector('label');
      if (!labelEl) return;
      const label = labelEl.textContent.replace(/[\*\s]+/g, ' ').trim();

      const selEl = col.querySelector('.v-select__selection');
      const inputEl = col.querySelector('input:not([type="hidden"])');
      const rawVal = (selEl ? selEl.textContent : (inputEl ? inputEl.value : '')).trim();
      if (!rawVal) return;

      if (/পরিবারে\s*পুরুষ\s*সদস্য\s*সংখ্যা/i.test(label)) {
        data.maleCount = parseInt(normalizeDigits(rawVal), 10) || 0;
        hasFoundFields = true;
      } else if (/পরিবারে\s*নারী\s*সদস্য\s*সংখ্যা/i.test(label)) {
        data.femaleCount = parseInt(normalizeDigits(rawVal), 10) || 0;
        hasFoundFields = true;
      } else if (/পরিবারে\s*হিজড়া\s*সদস্য\s*সংখ্যা/i.test(label)) {
        data.transCount = parseInt(normalizeDigits(rawVal), 10) || 0;
        hasFoundFields = true;
      } else if (/প্রশিক্ষণ বা আর্থিক সুবিধা/i.test(label)) {
        data.training = rawVal;
        hasFoundFields = true;
      } else if (/মোবাইল ব্যাংকিং/i.test(label)) {
        data.mfsAccount = rawVal;
        hasFoundFields = true;
      } else if (/বিদেশে\s*বসবাসরত.*পুরুষ/i.test(label)) {
        data.abroadMale = parseInt(normalizeDigits(rawVal), 10) || 0;
      } else if (/বিদেশে\s*বসবাসরত.*মহিলা/i.test(label)) {
        data.abroadFemale = parseInt(normalizeDigits(rawVal), 10) || 0;
      } else if (/বিদেশে\s*বসবাসরত.*হিজড়া/i.test(label)) {
        data.abroadTrans = parseInt(normalizeDigits(rawVal), 10) || 0;
      }
    });

    if (hasFoundFields) {
      data.totalCount = data.maleCount + data.femaleCount + data.transCount;
      localStorage.setItem('fc_section5_data', JSON.stringify(data));
      return data;
    }

    return cached;
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
    let applicantGender = (lastExtractedData && lastExtractedData.gender) || '';
    if (!applicantGender) {
      const gLabels = Array.from(document.querySelectorAll('label')).filter(l => l.textContent.trim().startsWith('লিঙ্গ'));
      for (const gl of gLabels) {
        const parent = gl.closest('.col, [class*="col-"]');
        const sel = parent?.querySelector('.v-select__selection');
        if (sel && sel.textContent.trim()) {
          applicantGender = sel.textContent.trim();
          break;
        }
      }
    }

    const maleKeywords = ['পুরুষ', 'স্বামী', 'পুত্র', 'ছেলে', 'পিতা', 'বাবা', 'ভাই', 'দাদা', 'নানা', 'নাতি', 'শ্বশুর', 'চাচা', 'মামা', 'ফুফা', 'খালু', 'দেবর', 'ভাসুর'];
    const femaleKeywords = ['নারী', 'মহিলা', 'স্ত্রী', 'কন্যা', 'মেয়ে', 'মাতা', 'মা', 'বোন', 'দাদী', 'নানী', 'নাতনি', 'শাশুড়ি', 'চাচী', 'মামী', 'ফুফু', 'খালা', 'ননদ', 'জা'];
    const transKeywords = ['হিজড়া', 'অন্যান্য'];

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
        } else {
          detectedGender = 'পুরুষ';
        }
      } else {
        // Scan selects in card
        const selects = Array.from(card.querySelectorAll('.v-select'));
        for (const sel of selects) {
          const parentCol = sel.closest('.col, [class*="col-"]') || sel.parentElement;
          const lbl = parentCol?.querySelector('label')?.textContent || '';
          const selVal = sel.querySelector('.v-select__selection')?.textContent.trim() || '';

          if (/লিঙ্গ/i.test(lbl)) {
            if (selVal.includes('পুরুষ')) detectedGender = 'পুরুষ';
            else if (selVal.includes('নারী') || selVal.includes('মহিলা')) detectedGender = 'নারী';
            else if (selVal.includes('হিজড়া')) detectedGender = 'হিজড়া';
          } else if (/সম্পর্ক/i.test(lbl)) {
            relationship = selVal;
          }
        }

        // Deduce from relationship if not explicitly chosen
        if (!detectedGender && relationship) {
          if (maleKeywords.some(k => relationship.includes(k))) detectedGender = 'পুরুষ';
          else if (femaleKeywords.some(k => relationship.includes(k))) detectedGender = 'নারী';
          else if (transKeywords.some(k => relationship.includes(k))) detectedGender = 'হিজড়া';
        }

        // Card body text fallback
        if (!detectedGender) {
          const cardText = card.innerText || '';
          for (const kw of femaleKeywords) {
            if (cardText.includes(kw)) { detectedGender = 'নারী'; break; }
          }
          if (!detectedGender) {
            for (const kw of maleKeywords) {
              if (cardText.includes(kw)) { detectedGender = 'পুরুষ'; break; }
            }
          }
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
      </div>
    `;
    document.body.appendChild(hud);

    const toggleBtn = document.getElementById('fc-cm-toggle-btn');
    const minIcon = document.getElementById('fc-cm-min-icon');
    toggleBtn.addEventListener('click', () => {
      hud.classList.toggle('minimized');
      minIcon.textContent = hud.classList.contains('minimized') ? '▴' : '▾';
    });
  }

  function injectTab6Banner(container, declared, actual, match) {
    if (!container) return;
    let banner = document.getElementById('fc-tab6-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'fc-tab6-banner';
      container.insertBefore(banner, container.firstChild);
    }

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
    `;
  }

  async function syncCrossMatchToFirestore(sec5Data, membersData, matchResult) {
    try {
      const rawId = scrapeFamilyId() || (lastExtractedData && lastExtractedData.family_id) || '8743033825';
      const cleanId = normalizeDigits(rawId).replace(/[^0-9]/g, '') || '8743033825';

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

  function handleSection5AndCrossMatch() {
    const sec5Data = trackSection5Data();
    const membersData = scanFamilyMembers();

    const s5Panel = document.querySelector('[data-family-card-tab="3"]');
    const s6Panel = document.querySelector('[data-family-card-tab="6"]');
    if (!sec5Data && !s5Panel && !s6Panel && membersData.totalMembers === 0) {
      const hud = document.getElementById('fc-crossmatch-hud');
      if (hud) hud.style.display = 'none';
      return;
    }

    injectCrossMatchHUD();
    const hudEl = document.getElementById('fc-crossmatch-hud');
    if (hudEl) hudEl.style.display = 'block';

    const match = computeCrossMatch(sec5Data, membersData);

    // Update Tab 6 inline banner if stack exists
    const stack = document.querySelector('.fm-members-stack') || s6Panel?.querySelector('.v-expansion-panel-content__wrap');
    if (stack) {
      injectTab6Banner(stack, sec5Data, membersData, match);
    }

    // Update Floating HUD elements
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

    // Sync to Firestore if changed
    const currentHash = `${sec5Data ? JSON.stringify(sec5Data) : ''}|${membersData.actualMale}|${membersData.actualFemale}|${membersData.actualTrans}|${membersData.totalMembers}|${match.isExactMatch}`;
    if (currentHash !== lastCrossMatchHash) {
      lastCrossMatchHash = currentHash;
      syncCrossMatchToFirestore(sec5Data, membersData, match);
    }
  }

  // --- SECTION 6: BANK / MFS DETAILS (ব্যাংক/এমএফএস তথ্য - Tab 4) ---
  // Rules:
  // 1. "অ্যাকাউন্টের মালিকানা": Default "নিজ" (user can change, system remembers default).
  // 2. "ব্যাংক শাখার নাম": Default "মাছপাড়া শাখা" (autocomplete dropdown, actively selects).
  // 3. Actively detects all fields and dropdowns in Tab 4.
  // 4. Injects an inline helper toolbar so user can customize/override and auto-fill with 1 click.

  function getSection6BankElements() {
    const panel = document.querySelector('[data-family-card-tab="4"]') ||
                  Array.from(document.querySelectorAll('.v-expansion-panel')).find(p => p.textContent.includes('ব্যাংক/এমএফএস তথ্য'));
    if (!panel) return null;

    let ownershipSelect = null;
    let branchSelect = null;
    let bankNameSelect = null;
    let emailInput = null;

    const allCols = Array.from(panel.querySelectorAll('.col, [class*="col-"]'));
    for (const col of allCols) {
      const labelText = col.querySelector('label')?.textContent || '';
      if (labelText.includes('অ্যাকাউন্টের মালিকানা')) {
        ownershipSelect = col.querySelector('.v-select') || col;
      } else if (labelText.includes('ব্যাংক শাখার নাম')) {
        branchSelect = col.querySelector('.v-select') || col;
      } else if (labelText.includes('ব্যাংকের নাম')) {
        bankNameSelect = col.querySelector('.v-select') || col;
      } else if (labelText.includes('ইমেইল')) {
        emailInput = col.querySelector('input');
      }
    }

    return {
      panel,
      ownershipSelect,
      branchSelect,
      bankNameSelect,
      emailInput
    };
  }

  let isSelectingBranch = false;
  let isSelectingOwnership = false;

  function selectVuetifyAutocomplete(container, targetText, fallbackId) {
    if (!container || !targetText) return;

    const currentSel = container.querySelector('.v-select__selection');
    const inputEl = container.querySelector('input:not([type="hidden"])');
    const hiddenEl = container.querySelector('input[type="hidden"]');

    if (currentSel && (currentSel.textContent.includes('মাছপাড়া') || currentSel.textContent.includes('মাছপাড়া'))) return;
    if (inputEl && inputEl.value && (inputEl.value.includes('মাছপাড়া') || inputEl.value.includes('মাছপাড়া'))) return;
    if (hiddenEl && fallbackId && hiddenEl.value === String(fallbackId)) return;

    if (isSelectingBranch) return;
    isSelectingBranch = true;

    try {
      const clickSlot = container.querySelector('.v-input__slot') || inputEl;
      if (clickSlot) clickSlot.click();

      if (inputEl) {
        inputEl.focus();
        setReactiveValue(inputEl, targetText);
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      }

      let attempts = 0;
      const pollInterval = setInterval(() => {
        attempts++;
        const menuItems = Array.from(document.querySelectorAll('.v-menu__content .v-list-item, .v-autocomplete__content .v-list-item'));
        let found = false;

        for (const item of menuItems) {
          const text = item.textContent || '';
          if (text.includes('মাছপাড়া') || text.includes('মাছপাড়া') || text.includes(targetText)) {
            const clickable = item.closest('.v-list-item') || item;
            clickable.click();
            found = true;
            clearInterval(pollInterval);
            console.log('[FamilyCard] Selected branch:', text.trim());
            showToast(`✅ ব্যাংক শাখা "${text.trim()}" নির্বাচিত হয়েছে!`);
            setTimeout(() => { isSelectingBranch = false; }, 500);
            break;
          }
        }

        if (found || attempts >= 8) {
          clearInterval(pollInterval);
          if (!found && fallbackId && hiddenEl) {
            setReactiveValue(hiddenEl, String(fallbackId));
          }
          setTimeout(() => { isSelectingBranch = false; }, 600);
        }
      }, 150);
    } catch (e) {
      console.warn('[FamilyCard] Error in selectVuetifyAutocomplete:', e);
      isSelectingBranch = false;
    }
  }

  function selectVuetifyDropdown(container, targetText, fallbackId) {
    if (!container || !targetText) return;

    const currentSel = container.querySelector('.v-select__selection');
    if (currentSel && currentSel.textContent.trim().includes(targetText)) return;

    if (isSelectingOwnership) return;
    isSelectingOwnership = true;

    try {
      const clickTarget = container.querySelector('.v-input__slot') || container.querySelector('input');
      if (clickTarget) {
        clickTarget.click();
        let attempts = 0;
        const interval = setInterval(() => {
          attempts++;
          const items = Array.from(document.querySelectorAll('.v-menu__content .v-list-item'));
          for (const it of items) {
            if (it.textContent.trim().includes(targetText)) {
              const clickable = it.closest('.v-list-item') || it;
              clickable.click();
              clearInterval(interval);
              console.log('[FamilyCard] Selected ownership:', targetText);
              showToast(`✅ অ্যাকাউন্টের মালিকানা "${targetText}" নির্বাচিত হয়েছে!`);
              setTimeout(() => { isSelectingOwnership = false; }, 400);
              return;
            }
          }
          if (attempts >= 8) {
            clearInterval(interval);
            const hiddenEl = container.querySelector('input[type="hidden"]');
            if (fallbackId && hiddenEl) {
              setReactiveValue(hiddenEl, String(fallbackId));
            }
            setTimeout(() => { isSelectingOwnership = false; }, 400);
          }
        }, 150);
      } else {
        isSelectingOwnership = false;
      }
    } catch (e) {
      console.warn('[FamilyCard] Error in selectVuetifyDropdown:', e);
      isSelectingOwnership = false;
    }
  }

  function injectSection6Toolbar(panel, currentOwnership, currentBranch) {
    if (!panel) return;
    const wrap = panel.querySelector('.v-expansion-panel-content__wrap');
    if (!wrap || wrap.querySelector('#fc-section6-toolbar')) return;

    const bar = document.createElement('div');
    bar.id = 'fc-section6-toolbar';
    bar.style.cssText = 'margin-bottom: 14px; padding: 10px 14px; background: #f0f9ff; border: 1.5px solid #0284c7; border-radius: 10px; font-family: -apple-system, sans-serif; box-shadow: 0 2px 6px rgba(0,0,0,0.05); font-size: 12px;';

    const ownershipOptions = ['নিজ', 'পিতা', 'মাতা', 'স্বামী', 'স্ত্রী', 'অভিভাবক'];
    let ownHtml = ownershipOptions.map(o => `<option value="${o}" ${o === currentOwnership ? 'selected' : ''}>${o}</option>`).join('');

    const branchList = JSON.parse(localStorage.getItem('fc_branch_list') || '["মাছপাড়া শাখা", "পাংশা শাখা", "রাজবাড়ী শাখা"]');
    if (!branchList.includes(currentBranch)) branchList.unshift(currentBranch);
    let branchHtml = branchList.map(b => `<option value="${b}" ${b === currentBranch ? 'selected' : ''}>${b}</option>`).join('');
    branchHtml += '<option value="__ADD_NEW_BRANCH__">➕ নতুন শাখা লিখুন...</option>';

    bar.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: #0369a1; font-size: 13px;">
          <span>🏦 ব্যাংক তথ্য সহকারী (অটো-সিলেকশন সক্রিয়)</span>
        </div>
        <button id="fc-s6-auto-fill-btn" type="button" style="padding: 4px 10px; background: #0284c7; color: #fff; font-weight: 700; border: none; border-radius: 6px; cursor: pointer; font-size: 11px;">
          ⚡ অটো-সিলেক্ট প্রয়োগ করুন
        </button>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; background: #ffffff; padding: 8px 10px; border-radius: 6px; border: 1px solid #bae6fd;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <b style="color: #0369a1;">👤 মালিকানা:</b>
          <select id="fc-s6-ownership-select" style="padding: 3px 6px; border-radius: 5px; border: 1.5px solid #0284c7; font-size: 11.5px; font-weight: 700; color: #0369a1; cursor: pointer; background: #fff;">
            ${ownHtml}
          </select>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <b style="color: #0369a1;">🏛️ ব্যাংক শাখা:</b>
          <select id="fc-s6-branch-select" style="padding: 3px 6px; border-radius: 5px; border: 1.5px solid #0284c7; font-size: 11.5px; font-weight: 700; color: #0369a1; cursor: pointer; background: #fff;">
            ${branchHtml}
          </select>
        </div>
      </div>
      <div style="margin-top: 6px; font-size: 11px; color: #0284c7;">
        💡 ডিফল্ট হিসেবে মালিকানা <b>"নিজ"</b> এবং ব্যাংক শাখা <b>"মাছপাড়া শাখা"</b> স্বয়ংক্রিয়ভাবে নির্বাচিত হবে।
      </div>
    `;

    wrap.insertBefore(bar, wrap.firstChild);

    const ownSelect = bar.querySelector('#fc-s6-ownership-select');
    ownSelect.addEventListener('change', () => {
      const val = ownSelect.value;
      localStorage.setItem('fc_default_account_ownership', val);
      const elems = getSection6BankElements();
      if (elems?.ownershipSelect) selectVuetifyDropdown(elems.ownershipSelect, val, '142');
    });

    const branchSelectEl = bar.querySelector('#fc-s6-branch-select');
    branchSelectEl.addEventListener('change', () => {
      if (branchSelectEl.value === '__ADD_NEW_BRANCH__') {
        const newBranch = prompt('নতুন ব্যাংক শাখার নাম লিখুন (যেমন: মাছপাড়া শাখা):');
        if (newBranch && newBranch.trim()) {
          const trimmed = newBranch.trim();
          let list = JSON.parse(localStorage.getItem('fc_branch_list') || '["মাছপাড়া শাখা", "পাংশা শাখা", "রাজবাড়ী শাখা"]');
          if (!list.includes(trimmed)) list.push(trimmed);
          localStorage.setItem('fc_branch_list', JSON.stringify(list));
          localStorage.setItem('fc_default_bank_branch', trimmed);
          bar.remove();
          injectSection6Toolbar(panel, ownSelect.value, trimmed);
          const elems = getSection6BankElements();
          if (elems?.branchSelect) selectVuetifyAutocomplete(elems.branchSelect, trimmed, '7680');
        } else {
          branchSelectEl.value = currentBranch;
        }
      } else {
        const val = branchSelectEl.value;
        localStorage.setItem('fc_default_bank_branch', val);
        const elems = getSection6BankElements();
        if (elems?.branchSelect) selectVuetifyAutocomplete(elems.branchSelect, val, '7680');
      }
    });

    const btnAuto = bar.querySelector('#fc-s6-auto-fill-btn');
    btnAuto.addEventListener('click', () => {
      const elems = getSection6BankElements();
      if (!elems) return;
      const own = localStorage.getItem('fc_default_account_ownership') || 'নিজ';
      const br = localStorage.getItem('fc_default_bank_branch') || 'মাছপাড়া শাখা';
      if (elems.ownershipSelect) selectVuetifyDropdown(elems.ownershipSelect, own, '142');
      setTimeout(() => {
        if (elems.branchSelect) selectVuetifyAutocomplete(elems.branchSelect, br, '7680');
      }, 300);
      showToast('⚡ ব্যাংক তথ্য অটো-সিলেক্ট চালু করা হয়েছে...');
    });
  }

  function handleSection6Bank() {
    const elems = getSection6BankElements();
    if (!elems || !elems.panel) return;

    const isPanelVisible = elems.panel.style.display !== 'none' ||
                           elems.panel.classList.contains('v-expansion-panel--active') ||
                           document.querySelector('.family-card-form-step--active')?.textContent.includes('ব্যাংক/এমএফএস');

    if (!isPanelVisible) return;

    const currentOwnership = localStorage.getItem('fc_default_account_ownership') || 'নিজ';
    const currentBranch = localStorage.getItem('fc_default_bank_branch') || 'মাছপাড়া শাখা';

    injectSection6Toolbar(elems.panel, currentOwnership, currentBranch);

    // Auto-select "অ্যাকাউন্টের মালিকানা" if not yet selected
    if (elems.ownershipSelect) {
      const curOwn = elems.ownershipSelect.querySelector('.v-select__selection')?.textContent.trim();
      if (!curOwn) {
        selectVuetifyDropdown(elems.ownershipSelect, currentOwnership, '142');
      }
    }

    // Auto-select "ব্যাংক শাখার নাম" if not yet selected
    if (elems.branchSelect) {
      const curBranch = elems.branchSelect.querySelector('.v-select__selection')?.textContent.trim() ||
                        elems.branchSelect.querySelector('input:not([type="hidden"])')?.value.trim();
      const hiddenVal = elems.branchSelect.querySelector('input[type="hidden"]')?.value;

      if (!curBranch && !hiddenVal) {
        selectVuetifyAutocomplete(elems.branchSelect, currentBranch, '7680');
      }
    }
  }

  // MutationObserver to watch Step 1, Section 3, Section 4, Section 5/Tab 6, and Section 6 activation
  const observer = new MutationObserver(() => {
    if (lastExtractedData) {
      const tab1 = document.querySelector('[data-family-card-tab="1"]') || document.querySelector('.v-expansion-panel--active');
      const fatherInp = findInputByLabel(['পিতার নাম (বাংলা)']) || document.getElementById('input-1286');
      if (fatherInp && !fatherInp.value) {
        fillPortalFields(lastExtractedData);
        showToast('✅ পিতা-মাতা, বৈবাহিক অবস্থা ও ধর্ম অটো-ফিল সম্পন্ন!');
      }
    }
    traceSection3Media();
    handleSection4Address();
    handleSection5AndCrossMatch();
    handleSection6Bank();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

  // Periodic polling for Section 3, Section 4, Section 5/Tab 6, and Section 6
  setInterval(() => {
    traceSection3Media();
    handleSection4Address();
    handleSection5AndCrossMatch();
    handleSection6Bank();
  }, 1500);

  function showToast(msg) {
    const existing = document.querySelector('.fc-bm-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.className = 'fc-bm-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.remove(); }, 4000);
  }

  showToast('🚀 Family Card সহকারী (v1.3) প্রস্তুত! "📸 NID স্ক্যান" বাটনে চাপুন।');
})();
