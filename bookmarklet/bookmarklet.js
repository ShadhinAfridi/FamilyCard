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

  // MutationObserver to watch Step 1, Section 3, and Section 4 activation
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
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

  // Periodic polling for Section 3 & Section 4 (guarantees zero latency on slow tablets)
  setInterval(() => {
    traceSection3Media();
    handleSection4Address();
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
