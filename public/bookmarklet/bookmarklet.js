// Family Card NID AI Auto-Filler Bookmarklet for Google Chrome on Android (v1.2 Enhanced)
// Includes:
// 1. Bengali-to-English digit normalizer (০-৯ -> 0-9)
// 2. Automatic DOM scraping of 'পরিবার আইডি'
// 3. Direct Firebase Firestore background replication (Zero Data Loss)
// 4. In-page WebRTC Camera view to prevent Android Low Memory Killer (LMK) tab reloads
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

  console.log('[FamilyCard Assistant v1.2] Loaded.');

  let lastExtractedData = null;
  let savedApiKey = localStorage.getItem('fc_gemini_api_key') || '';
  let activeStream = null;

  function normalizeDigits(str) {
    if (!str) return '';
    const bn = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
    return String(str).replace(/[০-৯]/g, d => {
      const idx = bn.indexOf(d);
      return idx !== -1 ? idx : d;
    });
  }

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
      background: rgba(0,0,0,0.65); z-index: 10000000;
      display: flex; align-items: center; justify-content: center; padding: 14px; box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
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
      padding: 16px; display: flex; flex-direction: column; gap: 10px; max-height: 85vh; overflow-y: auto;
    }
    .fc-bm-cam-box {
      width: 100%; aspect-ratio: 16/10; background: #000; border-radius: 10px; overflow: hidden;
      display: flex; align-items: center; justify-content: center; position: relative;
    }
    .fc-bm-cam-box video { width: 100%; height: 100%; object-fit: cover; }
    .fc-bm-cam-btn {
      background: linear-gradient(135deg, #1976d2, #0284c7); color: #fff; border: none; padding: 12px;
      border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; display: flex;
      align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 12px rgba(2,132,199,0.3);
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
        <h3>🪪 NID AI সহকারী (v1.2)</h3>
        <span id="fc-bm-close">&times;</span>
      </div>
      <div class="fc-bm-body">
        <input type="file" id="fc-bm-file-input" accept="image/*" capture="environment" style="display: none;">
        
        <div id="fc-bm-viewfinder" class="fc-bm-cam-box" style="display: none;">
          <video id="fc-bm-video" playsinline autoplay muted></video>
        </div>

        <div id="fc-bm-img-wrap" class="fc-bm-cam-box" style="display: none; background: #f8fafc;">
          <img id="fc-bm-img" style="max-width: 100%; max-height: 100%; object-fit: contain;">
        </div>

        <button id="fc-bm-btn-cam" class="fc-bm-cam-btn">
          <span>📷 এনআইডি কার্ডের ছবি তুলুন</span>
        </button>

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
  const fileInput = document.getElementById('fc-bm-file-input');
  const inputApiKey = document.getElementById('fc-bm-apikey');
  const loading = document.getElementById('fc-bm-loading');
  const imgWrap = document.getElementById('fc-bm-img-wrap');
  const imgPreview = document.getElementById('fc-bm-img');

  fab.addEventListener('click', () => { modal.style.display = 'flex'; });
  closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

  btnCam.addEventListener('click', () => {
    savedApiKey = inputApiKey.value.trim();
    if (!savedApiKey) {
      alert('অনুগ্রহ করে নিচে আপনার Gemini API Key দিন।');
      inputApiKey.focus();
      return;
    }
    localStorage.setItem('fc_gemini_api_key', savedApiKey);
    fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const base64Data = await compressImage(file, 1600, 0.85);
      imgPreview.src = base64Data;
      imgWrap.style.display = 'flex';
      btnCam.textContent = '🔄 পুনরায় ছবি তুলুন';

      runGeminiOCR(base64Data);
    } catch (err) {
      alert('ছবি প্রক্রিয়াকরণ ব্যর্থ: ' + err.message);
    }
  });

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

  async function runGeminiOCR(base64Image) {
    const apiKey = inputApiKey.value.trim() || localStorage.getItem('fc_gemini_api_key');
    if (!apiKey) {
      alert('Gemini API Key দেওয়া হয়নি!');
      return;
    }
    localStorage.setItem('fc_gemini_api_key', apiKey);

    loading.style.display = 'block';
    btnCam.style.display = 'none';

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

      // Normalize digits from Bengali to English (BUG-01 Fix)
      if (data.nid_number) data.nid_number = normalizeDigits(data.nid_number).replace(/[^0-9]/g, '');
      if (data.dob) data.dob = normalizeDigits(data.dob);

      // 10 or 17 digit rule: prepend birth year if 13 digits
      if (data.nid_number && data.nid_number.length === 13) {
        const ym = String(data.dob || '').match(/\b(19\d{2}|20\d{2})\b/);
        if (ym) data.nid_number = ym[1] + data.nid_number;
      }

      // Format English names in uppercase
      if (data.name_en) data.name_en = String(data.name_en).toUpperCase();
      if (data.father_name_en) data.father_name_en = String(data.father_name_en).toUpperCase();
      if (data.mother_name_en) data.mother_name_en = String(data.mother_name_en).toUpperCase();

      data.marital_status = document.getElementById('fc-bm-marital').value;
      data.religion = document.getElementById('fc-bm-religion').value;
      data.mobile_number = normalizeDigits(document.getElementById('fc-bm-mobile').value.trim());

      // Scrape current Family ID from portal
      data.family_id = scrapeFamilyId() || '';

      lastExtractedData = data;
      modal.style.display = 'none';

      fillPortalFields(data);
      showToast('✅ এনআইডি তথ্য সফলভাবে পূরণ হয়েছে!');

      // Asynchronously replicate to Firebase Firestore (BUG-03 Fix)
      syncToFirestore(data);
    } catch (err) {
      alert('স্ক্যান ব্যর্থ হয়েছে: ' + err.message);
    } finally {
      loading.style.display = 'none';
      btnCam.style.display = 'flex';
    }
  }

  // Sync to Firebase Firestore REST API
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
      console.log('[FamilyCard] Synced to Firestore:', docId);
    } catch (e) {
      console.warn('[FamilyCard] Background Firestore sync notice:', e.message);
    }
  }

  // Robust Vuetify Reactive Setter
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
      setTimeout(() => {
        const items = Array.from(document.querySelectorAll('.v-menu__content .v-list-item, .v-menu__content .v-list-item__title'));
        for (const it of items) {
          if (it.textContent.trim().includes(targetText)) {
            const clickable = it.closest('.v-list-item') || it;
            clickable.click();
            break;
          }
        }
      }, 150);
    }
  }

  function fillPortalFields(data) {
    if (!data) return;

    // Step 0
    if (data.name_bn) setReactiveValue(findInputByLabel(['সম্পূর্ণ নাম (বাংলা)']) || document.getElementById('input-211'), data.name_bn);
    if (data.name_en) setReactiveValue(findInputByLabel(['সম্পূর্ণ নাম (ইংরেজি)']) || document.getElementById('input-213'), data.name_en);
    if (data.nid_number) setReactiveValue(findInputByLabel(['জাতীয় পরিচিতি নম্বর (এনআইডি)', 'জাতীয় পরিচিতি নম্বর']) || document.getElementById('input-215'), data.nid_number);
    if (data.dob) setReactiveValue(findInputByLabel(['জন্ম তারিখ']) || document.getElementById('input-221'), data.dob);
    if (data.gender) selectDropdown(['লিঙ্গ'], data.gender);

    // Step 1
    if (data.father_name_bn) setReactiveValue(findInputByLabel(['পিতার নাম (বাংলা)']) || document.getElementById('input-1286'), data.father_name_bn);
    if (data.father_name_en) setReactiveValue(findInputByLabel(['পিতার নাম (ইংরেজি)']) || document.getElementById('input-1288'), data.father_name_en);
    if (data.mother_name_bn) setReactiveValue(findInputByLabel(['মাতার নাম (বাংলা)']) || document.getElementById('input-1290'), data.mother_name_bn);
    if (data.mother_name_en) setReactiveValue(findInputByLabel(['মাতার নাম (ইংরেজি)']) || document.getElementById('input-1292'), data.mother_name_en);
    if (data.marital_status) selectDropdown(['বৈবাহিক অবস্থা'], data.marital_status);
    if (data.religion) selectDropdown(['ধর্ম'], data.religion);

    // Mobile number
    if (data.mobile_number) {
      setReactiveValue(findInputByLabel(['মোবাইল নম্বর']) || document.getElementById('input-1294'), data.mobile_number);
    }
  }

  // MutationObserver to auto-fill Step 1 upon expansion
  const observer = new MutationObserver(() => {
    if (!lastExtractedData) return;
    const tab1 = document.querySelector('[data-family-card-tab="1"]') || document.querySelector('.v-expansion-panel--active');
    const fatherInp = findInputByLabel(['পিতার নাম (বাংলা)']) || document.getElementById('input-1286');
    if (fatherInp && !fatherInp.value) {
      fillPortalFields(lastExtractedData);
      showToast('✅ পিতা-মাতা, বৈবাহিক অবস্থা ও ধর্ম অটো-ফিল সম্পন্ন!');
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });

  function showToast(msg) {
    const existing = document.querySelector('.fc-bm-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.className = 'fc-bm-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.remove(); }, 4000);
  }

  showToast('🚀 Family Card সহকারী প্রস্তুত! "📸 NID স্ক্যান" বাটনে চাপুন।');
})();
