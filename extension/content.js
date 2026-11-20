// Content Script injected into https://fc.bhata.gov.bd/*
// Supports both Single-Device (In-Page Camera Scanner) & Cross-Device (WebSocket Bridge)
(function () {
  console.log('[FamilyCard Assistant] Content Script Loaded.');

  let socket = null;
  let serverUrl = 'http://localhost:3000';
  let roomCode = 'FC-101';
  let geminiApiKey = '';
  let lastExtractedData = null;

  // Retrieve saved settings
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(['serverUrl', 'roomCode', 'geminiApiKey'], (res) => {
      if (res.serverUrl) serverUrl = res.serverUrl;
      if (res.roomCode) roomCode = res.roomCode.toUpperCase();
      if (res.geminiApiKey) geminiApiKey = res.geminiApiKey;
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
      <!-- Single Device Instant Scan Button (Tablet-Friendly) -->
      <div id="fc-fab-scan-btn" title="ট্যাবলেটের ক্যামেরা দিয়ে সরাসরি স্ক্যান করুন">
        <span>📸 NID স্ক্যান</span>
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
            <span id="fc-ui-room" style="color: #1c3b68;">${roomCode}</span>
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
    const directScanBtn = document.getElementById('fc-btn-direct-scan');

    badge.addEventListener('click', () => card.classList.toggle('hidden'));
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.add('hidden');
    });

    fabBtn.addEventListener('click', openScannerModal);
    directScanBtn.addEventListener('click', openScannerModal);

    document.getElementById('fc-btn-refill').addEventListener('click', () => {
      if (lastExtractedData) {
        fillFormFields(lastExtractedData);
        showToast('এনআইডি তথ্য পুনরায় পূরণ করা হয়েছে!');
      } else {
        alert('কোনো স্ক্যান করা তথ্য এখনো আসেনি। "📸 NID স্ক্যান" বাটনে চাপুন।');
      }
    });

    document.getElementById('fc-btn-paste').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        const json = JSON.parse(text);
        lastExtractedData = json;
        updateWidgetPreview(json);
        fillFormFields(json);
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
          <h3>🪪 সরাসরি এনআইডি স্ক্যান (Single Device)</h3>
          <span class="fc-modal-close" id="fc-modal-close-btn">&times;</span>
        </div>
        <div class="fc-modal-body">
          <input type="file" id="fc-modal-file-input" accept="image/*" capture="environment" style="display: none;">
          
          <button id="fc-modal-btn-camera" class="fc-camera-trigger-btn">
            <span>📷 এনআইডি কার্ডের ছবি তুলুন</span>
          </button>

          <div id="fc-modal-preview-wrap" class="fc-preview-img-wrap" style="display: none;">
            <img id="fc-modal-img-preview" alt="NID Preview">
          </div>

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

          <div id="fc-modal-loading" class="fc-loading-spinner-wrap" style="display: none;">
            <div class="fc-spinner"></div>
            <span style="font-weight: 600; color: #1976d2; font-size: 13px;">Gemini AI দ্বারা NID বিশ্লেষণ করা হচ্ছে...</span>
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
    const btnSubmit = document.getElementById('fc-modal-btn-submit');

    closeBtn.addEventListener('click', closeScannerModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeScannerModal();
    });

    btnCamera.addEventListener('click', () => {
      fileInput.click();
    });

    let currentCompressedBase64 = null;

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const previewWrap = document.getElementById('fc-modal-preview-wrap');
      const imgPreview = document.getElementById('fc-modal-img-preview');

      // Compress client-side
      try {
        currentCompressedBase64 = await compressImageFile(file, 1600, 0.85);
        imgPreview.src = currentCompressedBase64;
        previewWrap.style.display = 'flex';
        btnCamera.textContent = '🔄 পুনরায় ছবি তুলুন';
        
        // Auto-trigger OCR immediately for convenience
        triggerModalOCR(currentCompressedBase64);
      } catch (err) {
        alert('ছবি প্রসেস করতে ব্যর্থ: ' + err.message);
      }
    });

    btnSubmit.addEventListener('click', () => {
      if (currentCompressedBase64) {
        triggerModalOCR(currentCompressedBase64);
      }
    });
  }

  function openScannerModal() {
    const modal = document.getElementById('fc-scanner-modal');
    if (modal) modal.style.display = 'flex';
  }

  function closeScannerModal() {
    const modal = document.getElementById('fc-scanner-modal');
    if (modal) modal.style.display = 'none';
  }

  // Compress image on an off-screen canvas
  function compressImageFile(file, maxDimension = 1600, quality = 0.85) {
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
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Trigger Gemini OCR via Background Service Worker
  function triggerModalOCR(base64Data) {
    const loading = document.getElementById('fc-modal-loading');
    const btnCamera = document.getElementById('fc-modal-btn-camera');
    const btnSubmit = document.getElementById('fc-modal-btn-submit');
    const maritalStatus = document.getElementById('fc-modal-marital').value;
    const religion = document.getElementById('fc-modal-religion').value;
    const mobileNumber = document.getElementById('fc-modal-mobile').value.trim();

    loading.style.display = 'flex';
    btnCamera.style.display = 'none';
    btnSubmit.style.display = 'none';

    chrome.runtime.sendMessage({
      action: 'ocr_nid_direct',
      imageBase64: base64Data,
      mimeType: 'image/jpeg',
      maritalStatus,
      religion,
      mobileNumber,
      apiKey: geminiApiKey
    }, (response) => {
      loading.style.display = 'none';
      btnCamera.style.display = 'flex';

      if (chrome.runtime.lastError) {
        alert('OCR রিকোয়েস্ট এরর: ' + chrome.runtime.lastError.message);
        return;
      }

      if (response && response.success && response.data) {
        closeScannerModal();
        lastExtractedData = response.data;
        updateWidgetPreview(response.data);
        fillFormFields(response.data);
        showToast('✅ এনআইডি তথ্য সফলভাবে পূরণ করা হয়েছে!');
      } else {
        alert('এনআইডি বিশ্লেষণ ব্যর্থ: ' + (response?.error || 'সঠিক এনআইডি ছবি পাওয়া যায়নি।'));
      }
    });
  }

  // --- WebSocket Connection for Cross-Device Mode ---
  function connectSocket() {
    if (typeof io === 'undefined') return;

    try {
      socket = io(serverUrl, {
        reconnectionAttempts: 5,
        reconnectionDelay: 3000
      });

      socket.on('connect', () => {
        updateBadgeStatus(true, `সংযুক্ত (${roomCode})`);
        socket.emit('join-room', roomCode);
      });

      socket.on('disconnect', () => {
        updateBadgeStatus(false, 'স্ট্যান্ডঅ্যালোন মোড');
      });

      socket.on('connect_error', () => {
        updateBadgeStatus(false, 'সরাসরি স্ক্যান মোড');
      });

      socket.on('nid-data-extracted', (payload) => {
        if (payload && payload.success && payload.data) {
          lastExtractedData = payload.data;
          updateWidgetPreview(payload.data);
          const filled = fillFormFields(payload.data);
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
    document.getElementById('fc-prev-nid').textContent = data.nid_number || '-';
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
  }

  function showToast(message) {
    const existing = document.querySelector('.fc-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'fc-toast';
    toast.innerHTML = `<span>${message}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.5s ease';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 500);
    }, 4000);
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
    setTimeout(() => {
      container.style.backgroundColor = oldBg;
    }, 3000);

    return true;
  }

  function findInputByLabelText(keywords) {
    const labels = Array.from(document.querySelectorAll('label'));
    for (const label of labels) {
      const text = label.textContent || '';
      const matches = keywords.some(k => text.includes(k));
      if (matches) {
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

  // Helper to normalize Bengali numerals (০-৯) to English (0-9)
  function normalizeDigits(str) {
    if (!str) return '';
    const bn = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
    return String(str).replace(/[০-৯]/g, d => {
      const idx = bn.indexOf(d);
      return idx !== -1 ? idx : d;
    });
  }

  // Helper to standardize Date of Birth to DD/MM/YYYY
  function standardizeDate(dobStr) {
    if (!dobStr) return '';
    let str = normalizeDigits(dobStr).trim();

    // ISO: YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = str.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (isoMatch) {
      return `${isoMatch[3].padStart(2, '0')}/${isoMatch[2].padStart(2, '0')}/${isoMatch[1]}`;
    }

    // Month names: 15 Aug 1985
    const months = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };
    const monthMatch = str.match(/^(\d{1,2})\s+([a-zA-Z]{3,})\s+(\d{4})/i);
    if (monthMatch) {
      const d = monthMatch[1].padStart(2, '0');
      const m = months[monthMatch[2].toLowerCase().substring(0, 3)] || '01';
      const y = monthMatch[3];
      return `${d}/${m}/${y}`;
    }

    // Standard DD/MM/YYYY
    str = str.replace(/[-\.]/g, '/');
    const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dmyMatch) {
      return `${dmyMatch[1].padStart(2, '0')}/${dmyMatch[2].padStart(2, '0')}/${dmyMatch[3]}`;
    }

    return str;
  }

  // Scrape family ID from current page DOM
  function scrapeFamilyId() {
    const text = document.body.innerText || '';
    const match = text.match(/পরিবার আইডি:\s*([০-৯0-9]+)/);
    if (match) return normalizeDigits(match[1]);
    return null;
  }

  // Direct Firestore REST API Sync (rajbari-city-app-16601)
  async function syncToFirestore(data) {
    try {
      const familyId = scrapeFamilyId() || data.family_id || '';
      const docId = familyId || data.nid_number || ('card_' + Date.now());
      const url = `https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(docId)}`;

      const firestoreDoc = {
        fields: {
          family_id: { stringValue: familyId },
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
      console.log('[FamilyCard Extension] Firestore synced:', docId);
    } catch (e) {
      console.warn('[FamilyCard Extension] Firestore sync notice:', e.message);
    }
  }

  function selectVuetifyDropdown(labelKeywords, targetValueText) {
    if (!targetValueText) return;
    const labels = Array.from(document.querySelectorAll('label'));
    let container = null;
    for (const l of labels) {
      const text = l.textContent || '';
      if (labelKeywords.some(k => text.includes(k))) {
        container = l.closest('.col, [class*="col-"], span, div');
        break;
      }
    }

    if (!container) return;

    const currentSelection = container.querySelector('.v-select__selection');
    if (currentSelection && currentSelection.textContent.trim().includes(targetValueText)) {
      return;
    }

    const clickTarget = container.querySelector('.v-input__slot') || container.querySelector('input');
    if (clickTarget) {
      clickTarget.click();
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        const menuItems = Array.from(document.querySelectorAll('.v-menu__content .v-list-item, .v-menu__content .v-list-item__title'));
        for (const item of menuItems) {
          if (item.textContent.trim().includes(targetValueText)) {
            const clickable = item.closest('.v-list-item') || item;
            clickable.click();
            clearInterval(interval);
            return;
          }
        }
        if (attempts >= 8) clearInterval(interval);
      }, 150);
    }
  }

  // Main Autofill Routine
  function fillFormFields(data) {
    if (!data) return false;
    let filledCount = 0;

    // 1. সম্পূর্ণ নাম (বাংলা)
    if (data.name_bn) {
      const inp = findInputByLabelText(['সম্পূর্ণ নাম (বাংলা)']) || document.getElementById('input-211');
      if (setReactiveValue(inp, data.name_bn)) filledCount++;
    }

    // 2. সম্পূর্ণ নাম (ইংরেজি)
    if (data.name_en) {
      const inp = findInputByLabelText(['সম্পূর্ণ নাম (ইংরেজি)']) || document.getElementById('input-213');
      if (setReactiveValue(inp, String(data.name_en).toUpperCase().trim())) filledCount++;
    }

    // 3. জাতীয় পরিচিতি নম্বর (এনআইডি) - শুধুমাত্র ১০ অথবা ১৭ ডিজিট
    if (data.nid_number) {
      let cleanNid = normalizeDigits(data.nid_number).replace(/[^0-9]/g, '');
      if (cleanNid.length === 13) {
        const yearMatch = String(data.dob || '').match(/\b(19\d{2}|20\d{2})\b/);
        if (yearMatch) {
          cleanNid = yearMatch[1] + cleanNid;
        }
      }
      data.nid_number = cleanNid;
      const inp = findInputByLabelText(['জাতীয় পরিচিতি নম্বর (এনআইডি)', 'জাতীয় পরিচিতি নম্বর']) || document.getElementById('input-215');
      if (setReactiveValue(inp, cleanNid)) filledCount++;
    }

    // 4. জন্ম তারিখ (DD/MM/YYYY)
    if (data.dob) {
      const cleanDob = standardizeDate(data.dob);
      data.dob = cleanDob;
      const inp = findInputByLabelText(['জন্ম তারিখ']) || document.getElementById('input-221');
      if (setReactiveValue(inp, cleanDob)) filledCount++;
    }

    // 5. লিঙ্গ
    if (data.gender) {
      selectVuetifyDropdown(['লিঙ্গ'], data.gender);
    }

    // 6. বৈবাহিক অবস্থা (Default: বিবাহিত)
    if (data.marital_status) {
      selectVuetifyDropdown(['বৈবাহিক অবস্থা'], data.marital_status);
    }

    // 7. ধর্ম (Default: ইসলাম)
    if (data.religion) {
      selectVuetifyDropdown(['ধর্ম'], data.religion);
    }

    // 8. Personal details (Father's/Mother's name in Step 1)
    if (data.father_name_bn) {
      const inp = findInputByLabelText(['পিতার নাম (বাংলা)']) || document.getElementById('input-1286') || document.getElementById('input-242');
      if (setReactiveValue(inp, data.father_name_bn)) filledCount++;
    }
    if (data.father_name_en) {
      const fatEn = String(data.father_name_en).toUpperCase().trim();
      const inp = findInputByLabelText(['পিতার নাম (ইংরেজি)']) || document.getElementById('input-1288') || document.getElementById('input-244');
      if (setReactiveValue(inp, fatEn)) filledCount++;
    }
    if (data.mother_name_bn) {
      const inp = findInputByLabelText(['মাতার নাম (বাংলা)']) || document.getElementById('input-1290') || document.getElementById('input-246');
      if (setReactiveValue(inp, data.mother_name_bn)) filledCount++;
    }
    if (data.mother_name_en) {
      const motEn = String(data.mother_name_en).toUpperCase().trim();
      const inp = findInputByLabelText(['মাতার নাম (ইংরেজি)']) || document.getElementById('input-1292') || document.getElementById('input-248');
      if (setReactiveValue(inp, motEn)) filledCount++;
    }

    // 9. মোবাইল নম্বর (ঐচ্ছিক: শুধুমাত্র যদি পাঠানো হয়, অন্যথায় ব্যবহারকারী ম্যানুয়ালি টাইপ করবেন)
    if (data.mobile_number) {
      const cleanMobile = normalizeDigits(data.mobile_number);
      const inp = findInputByLabelText(['মোবাইল নম্বর']) || document.getElementById('input-1294') || document.getElementById('input-250');
      if (setReactiveValue(inp, cleanMobile)) filledCount++;
    }

    // Step 4: Collection Address Auto-fill
    handleSection4Address();

    // Background Firestore Sync
    syncToFirestore(data);

    return filledCount > 0;
  }

  // --- SECTION 3: IMAGE GUARDIAN & COMPLIANCE SYSTEM ---
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

      if (file.size > maxBytes || isHouse) {
        try {
          inputEl.__isOptimizing = true;
          const label = isHouse ? 'বাড়ির ছবি' : (isSig ? 'স্বাক্ষর' : 'আবেদনকারীর ছবি');
          showToast(`🛡️ ইমেজ গার্ডিয়ান: ${label} অপ্টিমাইজ করা হচ্ছে...`);

          const result = await compressAndFitImage(file, maxW, maxH, maxBytes);

          const dt = new DataTransfer();
          dt.items.add(result.file);
          inputEl.files = dt.files;

          showToast(`✅ ${label} সরকারি মাপে ফিট (${result.sizeKb} KB, ${result.width}x${result.height}) হয়েছে!`);

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
      console.log('[FamilyCard Extension] Section 4 Post Code filled with default:', currentPostcode);
    }

    if (villageInput) {
      if (!villageInput.value) {
        setReactiveValue(villageInput, currentVillage);
        console.log('[FamilyCard Extension] Section 4 Village filled with default:', currentVillage);
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

  // Auto-fill Step 1 (ব্যক্তিগত তথ্য) when the user advances or switches to Tab 1
  function setupStepObserver() {
    let lastFilledTab = -1;

    const observer = new MutationObserver(() => {
      if (lastExtractedData) {
        const tab1 = document.querySelector('[data-family-card-tab="1"]');
        if (tab1 && tab1.style.display !== 'none') {
          const fatherInput = findInputByLabelText(['পিতার নাম (বাংলা)']) || document.getElementById('input-1286');
          if (fatherInput && !fatherInput.value && lastFilledTab !== 1) {
            lastFilledTab = 1;
            fillFormFields(lastExtractedData);
            showToast('✅ পিতা-মাতা, বৈবাহিক অবস্থা ও ধর্ম অটো-ফিল করা হয়েছে!');
          }
        }
      }
      traceSection3Media();
      handleSection4Address();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });

    setInterval(() => {
      traceSection3Media();
      handleSection4Address();
    }, 1500);

    document.addEventListener('click', (e) => {
      const stepItem = e.target.closest('.family-card-form-step, .v-expansion-panel-header, .v-list-item');
      if (stepItem && lastExtractedData) {
        setTimeout(() => {
          fillFormFields(lastExtractedData);
        }, 300);
      }
    });
  }

  setupStepObserver();

  // Listen for messages from extension popup
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      if (req.action === 'config_updated') {
        serverUrl = req.serverUrl || serverUrl;
        roomCode = (req.roomCode || roomCode).toUpperCase();
        geminiApiKey = req.geminiApiKey || geminiApiKey;
        const roomEl = document.getElementById('fc-ui-room');
        if (roomEl) roomEl.textContent = roomCode;
        if (socket) {
          socket.disconnect();
          connectSocket();
        }
        sendResponse({ success: true });
      }
    });
  }
})();
