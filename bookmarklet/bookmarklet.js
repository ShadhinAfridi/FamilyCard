// Family Card NID AI Auto-Filler Bookmarklet for Google Chrome on Android
// Runs 100% natively in mobile Google Chrome without installing any apps or extensions!
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

  console.log('[FamilyCard Bookmarklet] Initializing on Chrome Android...');

  let lastExtractedData = null;
  let savedApiKey = localStorage.getItem('fc_gemini_api_key') || '';

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
4. "dob": Extract Date of Birth in DD/MM/YYYY format.
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

  // Inject CSS Styles
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #fc-bm-fab {
      position: fixed;
      bottom: 24px;
      right: 20px;
      z-index: 9999999;
      background: linear-gradient(135deg, #1976d2, #0d47a1);
      color: #ffffff;
      padding: 12px 20px;
      border-radius: 30px;
      box-shadow: 0 4px 18px rgba(13, 71, 161, 0.45);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      border: 2px solid #ffffff;
      user-select: none;
      animation: fc-bm-pop 0.3s ease;
    }
    @keyframes fc-bm-pop {
      from { transform: scale(0.5); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    .fc-bm-overlay {
      position: fixed;
      top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(0,0,0,0.65);
      z-index: 10000000;
      display: flex; align-items: center; justify-content: center;
      padding: 14px; box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .fc-bm-card {
      background: #ffffff;
      width: 100%; max-width: 420px;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(0,0,0,0.35);
      display: flex; flex-direction: column;
    }
    .fc-bm-hdr {
      background: #1c3b68;
      color: #ffffff;
      padding: 14px 18px;
      display: flex; justify-content: space-between; align-items: center;
    }
    .fc-bm-hdr h3 { margin: 0; font-size: 15px; font-weight: 700; }
    .fc-bm-hdr span { cursor: pointer; font-size: 20px; font-weight: bold; }
    .fc-bm-body {
      padding: 16px;
      display: flex; flex-direction: column; gap: 12px;
      max-height: 85vh; overflow-y: auto;
    }
    .fc-bm-cam-btn {
      background: linear-gradient(135deg, #1976d2, #0284c7);
      color: #fff; border: none; padding: 14px;
      border-radius: 12px; font-size: 15px; font-weight: 700;
      cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;
      box-shadow: 0 4px 12px rgba(2, 132, 199, 0.35);
    }
    .fc-bm-row { display: flex; gap: 10px; }
    .fc-bm-col { flex: 1; display: flex; flex-direction: column; gap: 4px; }
    .fc-bm-col label { font-size: 12px; font-weight: 600; color: #475569; }
    .fc-bm-col select, .fc-bm-col input {
      padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 13px; box-sizing: border-box; width: 100%;
    }
    .fc-bm-prev-wrap {
      width: 100%; max-height: 180px; border-radius: 8px; overflow: hidden;
      border: 2px dashed #94a3b8; background: #f8fafc;
      display: flex; align-items: center; justify-content: center;
    }
    .fc-bm-prev-wrap img { max-width: 100%; max-height: 180px; object-fit: contain; }
    .fc-bm-toast {
      position: fixed; top: 50px; right: 20px; z-index: 10000001;
      background: #166534; color: #fff; padding: 12px 18px; border-radius: 8px;
      box-shadow: 0 8px 20px rgba(0,0,0,0.25); font-size: 13.5px; font-weight: 600;
      animation: fc-bm-pop 0.3s ease;
    }
    .fc-bm-spinner {
      width: 32px; height: 32px; border: 4px solid #e2e8f0; border-top-color: #1976d2;
      border-radius: 50%; animation: fc-bm-spin 0.8s linear infinite; margin: 0 auto;
    }
    @keyframes fc-bm-spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(styleEl);

  // Inject Floating Button
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
        <h3>🪪 NID AI অটো-ফিলার (Chrome Android)</h3>
        <span id="fc-bm-close">&times;</span>
      </div>
      <div class="fc-bm-body">
        <input type="file" id="fc-bm-file-input" accept="image/*" capture="environment" style="display: none;">
        
        <button id="fc-bm-btn-cam" class="fc-bm-cam-btn">
          <span>📷 এনআইডি কার্ডের ছবি তুলুন</span>
        </button>

        <div id="fc-bm-prev-wrap" class="fc-bm-prev-wrap" style="display: none;">
          <img id="fc-bm-img-prev" alt="NID Preview">
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

        <div class="fc-bm-col">
          <label for="fc-bm-apikey">⚙️ Gemini API Key (ফ্রি কী):</label>
          <input type="password" id="fc-bm-apikey" placeholder="AIzaSy..." value="${savedApiKey}">
        </div>

        <div id="fc-bm-loading" style="display: none; text-align: center; padding: 10px;">
          <div class="fc-bm-spinner"></div>
          <p style="margin: 8px 0 0 0; font-size: 13px; font-weight: 600; color: #1976d2;">Gemini AI দিয়ে NID স্ক্যান করা হচ্ছে...</p>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Modal Listeners
  const closeBtn = document.getElementById('fc-bm-close');
  const btnCam = document.getElementById('fc-bm-btn-cam');
  const fileInput = document.getElementById('fc-bm-file-input');
  const imgPrev = document.getElementById('fc-bm-img-prev');
  const prevWrap = document.getElementById('fc-bm-prev-wrap');
  const loading = document.getElementById('fc-bm-loading');
  const inputApiKey = document.getElementById('fc-bm-apikey');

  fab.addEventListener('click', () => { modal.style.display = 'flex'; });
  closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

  btnCam.addEventListener('click', () => {
    savedApiKey = inputApiKey.value.trim();
    if (!savedApiKey) {
      alert('অনুগ্রহ করে নিচে আপনার Gemini API Key দিন। (Google AI Studio থেকে ফ্রি নেওয়া যায়)');
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
      imgPrev.src = base64Data;
      prevWrap.style.display = 'flex';
      btnCam.textContent = '🔄 পুনরায় ছবি তুলুন';

      // Perform OCR
      runGeminiOCR(base64Data);
    } catch (err) {
      alert('ছবি প্রক্রিয়াকরণ ব্যর্থ: ' + err.message);
    }
  });

  // Client-side canvas compression
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

  // Gemini API Call
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
        throw new Error(`Gemini API Error: ${errTxt}`);
      }

      const jsonRes = await res.json();
      const outputText = jsonRes.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!outputText) throw new Error('Gemini থেকে উত্তর পাওয়া যায়নি।');

      let cleanText = outputText.trim();
      if (cleanText.startsWith('```json')) cleanText = cleanText.substring(7);
      if (cleanText.startsWith('```')) cleanText = cleanText.substring(3);
      if (cleanText.endsWith('```')) cleanText = cleanText.substring(0, cleanText.length - 3);

      const data = JSON.parse(cleanText.trim());

      // 10 or 17 digit NID rule
      if (data.nid_number) {
        let cleanNid = String(data.nid_number).replace(/[^0-9]/g, '');
        if (cleanNid.length === 13) {
          const ym = String(data.dob || '').match(/\b(19\d{2}|20\d{2})\b/);
          if (ym) cleanNid = ym[1] + cleanNid;
        }
        data.nid_number = cleanNid;
      }

      // Upper-case english
      if (data.name_en) data.name_en = String(data.name_en).toUpperCase();
      if (data.father_name_en) data.father_name_en = String(data.father_name_en).toUpperCase();
      if (data.mother_name_en) data.mother_name_en = String(data.mother_name_en).toUpperCase();

      data.marital_status = document.getElementById('fc-bm-marital').value;
      data.religion = document.getElementById('fc-bm-religion').value;
      data.mobile_number = document.getElementById('fc-bm-mobile').value.trim();

      lastExtractedData = data;
      modal.style.display = 'none';

      fillPortalFields(data);
      showToast('✅ এনআইডি তথ্য সফলভাবে পূরণ হয়েছে!');
    } catch (err) {
      alert('স্ক্যান ব্যর্থ হয়েছে: ' + err.message);
    } finally {
      loading.style.display = 'none';
      btnCam.style.display = 'flex';
    }
  }

  // --- Vuetify Robust Form Filler ---
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

    // Mobile number (only if user entered in modal)
    if (data.mobile_number) {
      setReactiveValue(findInputByLabel(['মোবাইল নম্বর']) || document.getElementById('input-1294'), data.mobile_number);
    }
  }

  // Observer to fill Step 1 when opened
  const observer = new MutationObserver(() => {
    if (!lastExtractedData) return;
    const tab1 = document.querySelector('[data-family-card-tab="1"]');
    if (tab1 && tab1.style.display !== 'none') {
      const fatherInp = findInputByLabel(['পিতার নাম (বাংলা)']) || document.getElementById('input-1286');
      if (fatherInp && !fatherInp.value) {
        fillPortalFields(lastExtractedData);
        showToast('✅ পিতা-মাতা, বৈবাহিক অবস্থা ও ধর্ম অটো-ফিল সম্পন্ন!');
      }
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

  showToast('🚀 Family Card সহকারী লোড হয়েছে! "📸 NID স্ক্যান" বাটনে চাপুন।');
})();
