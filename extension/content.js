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
      setTimeout(() => {
        const menuItems = Array.from(document.querySelectorAll('.v-menu__content .v-list-item, .v-menu__content .v-list-item__title'));
        for (const item of menuItems) {
          if (item.textContent.trim().includes(targetValueText)) {
            const clickable = item.closest('.v-list-item') || item;
            clickable.click();
            break;
          }
        }
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
      if (setReactiveValue(inp, data.name_en)) filledCount++;
    }

    // 3. জাতীয় পরিচিতি নম্বর (এনআইডি) - শুধুমাত্র ১০ অথবা ১৭ ডিজিট
    if (data.nid_number) {
      let cleanNid = String(data.nid_number).replace(/[^0-9]/g, '');
      if (cleanNid.length === 13) {
        const yearMatch = String(data.dob || '').match(/\b(19\d{2}|20\d{2})\b/);
        if (yearMatch) {
          cleanNid = yearMatch[1] + cleanNid;
        }
      }
      const inp = findInputByLabelText(['জাতীয় পরিচিতি নম্বর (এনআইডি)', 'জাতীয় পরিচিতি নম্বর']) || document.getElementById('input-215');
      if (setReactiveValue(inp, cleanNid)) filledCount++;
    }

    // 4. জন্ম তারিখ (DD/MM/YYYY)
    if (data.dob) {
      const inp = findInputByLabelText(['জন্ম তারিখ']) || document.getElementById('input-221');
      if (setReactiveValue(inp, data.dob)) filledCount++;
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
      const inp = findInputByLabelText(['পিতার নাম (ইংরেজি)']) || document.getElementById('input-1288') || document.getElementById('input-244');
      if (setReactiveValue(inp, String(data.father_name_en).toUpperCase())) filledCount++;
    }
    if (data.mother_name_bn) {
      const inp = findInputByLabelText(['মাতার নাম (বাংলা)']) || document.getElementById('input-1290') || document.getElementById('input-246');
      if (setReactiveValue(inp, data.mother_name_bn)) filledCount++;
    }
    if (data.mother_name_en) {
      const inp = findInputByLabelText(['মাতার নাম (ইংরেজি)']) || document.getElementById('input-1292') || document.getElementById('input-248');
      if (setReactiveValue(inp, String(data.mother_name_en).toUpperCase())) filledCount++;
    }

    // 9. মোবাইল নম্বর (ঐচ্ছিক: শুধুমাত্র যদি পাঠানো হয়, অন্যথায় ব্যবহারকারী ম্যানুয়ালি টাইপ করবেন)
    if (data.mobile_number) {
      const inp = findInputByLabelText(['মোবাইল নম্বর']) || document.getElementById('input-1294') || document.getElementById('input-250');
      if (setReactiveValue(inp, data.mobile_number)) filledCount++;
    }

    return filledCount > 0;
  }

  // Auto-fill Step 1 (ব্যক্তিগত তথ্য) when the user advances or switches to Tab 1
  function setupStepObserver() {
    let lastFilledTab = -1;

    const observer = new MutationObserver(() => {
      if (!lastExtractedData) return;

      const tab1 = document.querySelector('[data-family-card-tab="1"]');
      if (tab1 && tab1.style.display !== 'none') {
        const fatherInput = findInputByLabelText(['পিতার নাম (বাংলা)']) || document.getElementById('input-1286');
        if (fatherInput && !fatherInput.value && lastFilledTab !== 1) {
          lastFilledTab = 1;
          fillFormFields(lastExtractedData);
          showToast('✅ পিতা-মাতা, বৈবাহিক অবস্থা ও ধর্ম অটো-ফিল করা হয়েছে!');
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });

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
