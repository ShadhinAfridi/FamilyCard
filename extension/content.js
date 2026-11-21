// Content Script injected into https://fc.bhata.gov.bd/*
// Supports both Single-Device (WebRTC Live Camera + Gallery Scanner) & Cross-Device (WebSocket Bridge)
(function () {
  console.log('[FamilyCard Assistant v1.5] Content Script Loaded.');

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

  let socket = null;
  let serverUrl = 'http://localhost:3000';
  let roomCode = (localStorage.getItem('fc_room_code') || 'FC-101').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '') || 'FC-101';
  let myDeviceName = localStorage.getItem('fc_device_name') || 'পিসি-এক্সটেনশন';
  let geminiApiKey = '';
  let deepseekApiKey = '';
  let aiProvider = localStorage.getItem('fc_ai_provider') || 'economy';
  let defaultKeySlot = localStorage.getItem('fc_default_key_slot') || 'auto';
  let geminiModel = localStorage.getItem('fc_gemini_model') || 'gemini-3.1-flash-lite';
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
    'gemini-3.1-flash-lite': { label: 'Gemini 3.1 Flash-Lite', inM: 0.25, outM: 1.50, est1k: 0.78, rpm: '4K' },
    'gemini-3.5-flash-lite': { label: 'Gemini 3.5 Flash-Lite', inM: 0.30, outM: 2.50, est1k: 1.11, rpm: '4K' },
    'gemini-3.8-flash': { label: 'Gemini 3.8 Flash', inM: 0.75, outM: 3.75, est1k: 2.53, rpm: '1K' },
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
    chrome.storage.sync.get(['serverUrl', 'roomCode', 'deviceName', 'geminiApiKey', 'deepseekApiKey', 'aiProvider', 'defaultKeySlot', 'geminiModel', 'deepseekModel'], (res) => {
      if (res.serverUrl) serverUrl = res.serverUrl;
      if (res.roomCode) roomCode = res.roomCode.toUpperCase().replace(/[^A-Z0-9_-]/g, '') || 'FC-101';
      if (res.deviceName) myDeviceName = res.deviceName;
      if (res.geminiApiKey) geminiApiKey = res.geminiApiKey;
      if (res.deepseekApiKey) deepseekApiKey = res.deepseekApiKey;
      if (res.aiProvider) aiProvider = res.aiProvider;
      if (res.defaultKeySlot) defaultKeySlot = res.defaultKeySlot;
      if (res.geminiModel) geminiModel = res.geminiModel;
      if (res.deepseekModel) deepseekModel = res.deepseekModel;
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
        <div id="fc-chat-btn" title="একই রুমের অন্য ডিভাইসের সাথে মেসেজ ও NID শেয়ার করুন">
          <span>💬 মেসেজ</span><span id="fc-chat-badge" style="display:none;">0</span>
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
      const isTab6Active = tab6 && (tab6.style.display !== 'none' || tab6.classList.contains('v-expansion-panel--active'));
      setScanTarget(isTab6Active ? 'member' : 'applicant', null, isTab6Active ? 'auto' : 1);
      openScannerModal();
    });
    directScanBtn.addEventListener('click', () => {
      setScanTarget('applicant', null, 1);
      openScannerModal();
    });

    document.getElementById('fc-btn-refill').addEventListener('click', async () => {
      if (lastExtractedData) {
        await fillFormFields(lastExtractedData);
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
        window.__fcStep1FilledKey = '';
        updateWidgetPreview(json);
        await fillFormFields(json);
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
          <h3>🪪 সরাসরি NID ও জন্ম নিবন্ধন স্ক্যান (Single Device)</h3>
          <span class="fc-modal-close" id="fc-modal-close-btn">&times;</span>
        </div>
        <div class="fc-modal-body">
          <!-- Target Selector: Applicant vs Family Member -->
          <div style="display: flex; gap: 6px; margin-bottom: 10px; background: #f1f5f9; padding: 4px; border-radius: 8px;">
            <button type="button" id="fc-modal-target-self-btn" style="flex: 1; padding: 6px 10px; border: none; border-radius: 6px; font-weight: 700; font-size: 11.5px; cursor: pointer; background: #0284c7; color: #fff;">
              👤 প্রধান আবেদনকারী
            </button>
            <button type="button" id="fc-modal-target-member-btn" style="flex: 1; padding: 6px 10px; border: none; border-radius: 6px; font-weight: 700; font-size: 11.5px; cursor: pointer; background: #e2e8f0; color: #334155;">
              👨‍👩‍👧‍👦 সদস্য (NID / জন্ম নিবন্ধন)
            </button>
          </div>

          <!-- Family Member Sub-panel (Shown when member target selected) -->
          <div id="fc-modal-member-settings" style="display: none; background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 10px; padding: 10px; margin-bottom: 10px; flex-direction: column; gap: 8px;">
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
                  <option value="nid">জাতীয় পরিচিতি নম্বর (NID)</option>
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

          <div id="fc-modal-viewfinder" class="fc-modal-cam-box" style="display: none;">
            <video id="fc-modal-video" playsinline autoplay muted></video>
            <div class="fc-modal-cam-bracket tl"></div>
            <div class="fc-modal-cam-bracket tr"></div>
            <div class="fc-modal-cam-bracket bl"></div>
            <div class="fc-modal-cam-bracket br"></div>
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
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <label style="font-size: 12px; font-weight: 700; color: #1c3b68;">📍 সেকশন ৪: তথ্য সংগ্রহের ঠিকানা</label>
                <span style="font-size: 10px; color: #64748b;">(স্থায়ী ঠিকানা অপরিবর্তিত)</span>
              </div>
              <div class="fc-modal-fields-row">
                <div class="fc-modal-field">
                  <label for="fc-modal-postcode">📮 পোস্ট কোড* (ডিফল্ট: 7721)</label>
                  <input type="text" id="fc-modal-postcode" value="${escapeHtml(savedPostcode)}" placeholder="7721">
                </div>
                <div class="fc-modal-field">
                  <label for="fc-modal-village">🏠 গ্রাম নির্বাচন*</label>
                  <select id="fc-modal-village">
                    ${savedVillageList.map(v => `<option value="${escapeHtml(v)}" ${v === savedDefaultVillage ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                  </select>
                </div>
              </div>
              <div style="display: flex; gap: 6px;">
                <input type="text" id="fc-modal-new-village" placeholder="নতুন গ্রামের নাম লিখুন..." style="flex: 1; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 12px;">
                <button id="fc-modal-btn-add-village" type="button" style="padding: 6px 12px; font-size: 12px; font-weight: 700; background: #0284c7; color: #fff; border: none; border-radius: 8px; cursor: pointer;">+ যোগ</button>
              </div>
            </div>
          </div>

          <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 10px; padding: 9px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px;">
            <div class="fc-modal-fields-row">
              <div class="fc-modal-field">
                <label for="fc-modal-ai-provider">🧠 AI কৌশল:</label>
                <select id="fc-modal-ai-provider">
                  <option value="economy" ${aiProvider === 'economy' ? 'selected' : ''}>💸 সাশ্রয়ী অটো (Lite → 3.8)</option>
                  <option value="deepseek" ${aiProvider === 'deepseek' ? 'selected' : ''}>🐋 DeepSeek Flash (~$0.38/1K)</option>
                  <option value="gemini_lite" ${aiProvider === 'gemini_lite' ? 'selected' : ''}>⚡ Gemini Lite (~$0.78/1K)</option>
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
                  <option value="gemini-3.1-flash-lite" ${geminiModel === 'gemini-3.1-flash-lite' ? 'selected' : ''}>3.1 Lite ($0.25/$1.50)</option>
                  <option value="gemini-3.5-flash-lite" ${geminiModel === 'gemini-3.5-flash-lite' ? 'selected' : ''}>3.5 Lite ($0.30/$2.50)</option>
                  <option value="gemini-3.8-flash" ${geminiModel === 'gemini-3.8-flash' ? 'selected' : ''}>3.8 Flash ($0.75/$3.75)</option>
                </select>
              </div>
              <div class="fc-modal-field">
                <label for="fc-modal-deepseek-model">🐋 DeepSeek মডেল:</label>
                <select id="fc-modal-deepseek-model">
                  <option value="deepseek-flash" ${deepseekModel === 'deepseek-flash' ? 'selected' : ''}>deepseek-flash ($0.15/$0.60)</option>
                </select>
              </div>
            </div>
            <div id="fc-modal-cost-card" style="background: #f0fdf4; border: 1px solid #86efac; color: #166534; border-radius: 7px; padding: 6px 8px; font-size: 11px; line-height: 1.4;">হিসাব লোড হচ্ছে...</div>
            <button id="fc-modal-btn-save-ai" type="button" style="background: #0f766e; color: #fff; border: none; border-radius: 7px; padding: 6px 10px; font-size: 11.5px; font-weight: 700; cursor: pointer;">💾 ডিফল্ট কী ও মডেল সেভ করুন</button>
          </div>

          <div id="fc-modal-ocr-warn" style="display: none; background: #fffbeb; border: 1.5px solid #f59e0b; color: #92400e; padding: 8px 10px; border-radius: 8px; font-size: 11.5px; line-height: 1.45;"></div>

          <div id="fc-modal-loading" class="fc-loading-spinner-wrap" style="display: none;">
            <div class="fc-spinner"></div>
            <span id="fc-modal-loading-text" style="font-weight: 600; color: #1976d2; font-size: 13px;">AI দ্বারা ডকুমেন্ট বিশ্লেষণ করা হচ্ছে...</span>
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
    const videoElem = document.getElementById('fc-modal-video');
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
      const gemSpec = MODAL_MODEL_PRICING[gm] || MODAL_MODEL_PRICING['gemini-3.1-flash-lite'];
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
        savedPostcode = inputPostcode.value.trim() || '7721';
        localStorage.setItem('fc_default_postcode', savedPostcode);
        const bar = document.getElementById('fc-inline-village-bar');
        if (bar) bar.remove();
        handleSection4Address();
      });
    }
    if (selectVillage) {
      selectVillage.addEventListener('change', () => {
        savedDefaultVillage = selectVillage.value;
        localStorage.setItem('fc_default_village', savedDefaultVillage);
        const bar = document.getElementById('fc-inline-village-bar');
        if (bar) bar.remove();
        handleSection4Address();
      });
    }
    if (btnAddVillage) {
      btnAddVillage.addEventListener('click', () => {
        const newName = inputNewVillage?.value.trim();
        if (!newName) return;
        if (!savedVillageList.includes(newName)) {
          savedVillageList.push(newName);
          localStorage.setItem('fc_village_list', JSON.stringify(savedVillageList));
        }
        savedDefaultVillage = newName;
        localStorage.setItem('fc_default_village', savedDefaultVillage);
        updateModalVillageSelect();
        const bar = document.getElementById('fc-inline-village-bar');
        if (bar) bar.remove();
        handleSection4Address();
        if (inputNewVillage) inputNewVillage.value = '';
        showToast(`✅ গ্রাম "${newName}" সফলভাবে যোগ করা হয়েছে এবং ডিফল্ট করা হলো!`);
      });
    }

    closeBtn.addEventListener('click', closeScannerModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeScannerModal();
    });

    btnCamera.addEventListener('click', async () => {
      try {
        if (activeMediaStream) stopLiveCamera();
        const constraints = {
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false
        };
        activeMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (videoElem) videoElem.srcObject = activeMediaStream;
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

    let currentCompressedBase64 = null;

    if (btnSnap) {
      btnSnap.addEventListener('click', () => {
        if (!videoElem || !videoElem.videoWidth) {
          alert('ক্যামেরা প্রস্তুত নয়, অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।');
          return;
        }
        const canvas = document.createElement('canvas');
        let w = videoElem.videoWidth;
        let h = videoElem.videoHeight;
        const maxDim = 1800;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
          else { w = Math.round((w * maxDim) / h); h = maxDim; }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if ('filter' in ctx) ctx.filter = 'contrast(1.08) brightness(1.03)';
        ctx.drawImage(videoElem, 0, 0, w, h);
        currentCompressedBase64 = canvas.toDataURL('image/jpeg', 0.90);
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
        currentCompressedBase64 = await compressImageFile(file, 1800, 0.90);
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

  function updateModalVillageSelect() {
    const sel = document.getElementById('fc-modal-village');
    const inpPost = document.getElementById('fc-modal-postcode');
    const list = safeJsonParse(localStorage.getItem('fc_village_list'), savedVillageList);
    savedVillageList = Array.isArray(list) && list.length ? list : ['বসাকুষ্টিয়া', 'চর কলিমহর'];
    savedDefaultVillage = localStorage.getItem('fc_default_village') || savedVillageList[0] || 'বসাকুষ্টিয়া';
    savedPostcode = localStorage.getItem('fc_default_postcode') || '7721';
    if (inpPost) inpPost.value = savedPostcode;
    if (sel) {
      sel.innerHTML = savedVillageList.map(v => `<option value="${escapeHtml(v)}" ${v === savedDefaultVillage ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
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

    // 1. Verification Type Radio (NID vs Birth Certificate) — scoped strictly to .v-radio
    const isBirthReg = data.doc_type === 'birth_certificate';
    const radios = Array.from(card.querySelectorAll('.v-radio'));
    for (const rl of radios) {
      const txt = normalizeBn(rl.textContent || '');
      if (isBirthReg && (txt.includes('জন্ম নিবন্ধন') || txt.includes('নিবন্ধন'))) {
        const r = rl.querySelector('input[type="radio"]');
        if (r) r.click(); else rl.click();
        break;
      } else if (!isBirthReg && (txt.includes('জাতীয় পরিচিতি') || txt.includes('এনআইডি') || txt.includes('NID'))) {
        const r = rl.querySelector('input[type="radio"]');
        if (r) r.click(); else rl.click();
        break;
      }
    }

    await new Promise(r => setTimeout(r, 220));

    function findCardInput(keywords) {
      return findInputByLabelText(keywords, card);
    }

    async function selectCardDropdown(keywords, candidates) {
      const normKeys = keywords.map(k => normalizeBn(k));
      const labels = Array.from(card.querySelectorAll('label'));
      let container = null;
      for (const label of labels) {
        if (label.closest('.v-radio')) continue;
        const text = normalizeBn(label.textContent || '');
        if (normKeys.some(k => text.includes(k))) {
          container = label.closest('.col, [class*="col-"], span, div');
          break;
        }
      }
      if (!container) return;
      await selectSingleVuetifyOption(container, candidates);
    }

    // 2. Identification number
    const num = data.doc_number || data.nid_number || '';
    if (num) {
      const idInp = findCardInput(['জাতীয় পরিচিতি নম্বর', 'এনআইডি', 'জন্ম নিবন্ধন নম্বর', 'নিবন্ধন']);
      if (idInp) setReactiveValue(idInp, num);
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
    if (data.gender) {
      await selectCardDropdown(['লিঙ্গ'], [data.gender]);
    }

    // 10. Marital Status
    const marital = data.marital_status || data.marital_status_suggestion || 'বিবাহিত';
    await selectCardDropdown(['বৈবাহিক অবস্থা'], [marital]);

    // 11. Religion (Default: ইসলাম)
    const religion = data.religion || 'ইসলাম';
    await selectCardDropdown(['ধর্ম'], [religion]);

    // 12. Disability (Default: না)
    await selectCardDropdown(['প্রতিবন্ধিতা', 'প্রতিবন্ধী'], ['না', 'প্রতিবন্ধী নন']);

    card.dataset.fcMemberAutoFilled = 'true';
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

  async function applySmartDefaultsToAllMembers() {
    const cards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
    let count = 0;
    for (const card of cards) {
      const isSelf = card.classList.contains('fm-member-card--self') || (card.textContent.includes('সদস্য - ১') && card.textContent.includes('নিজ'));
      if (isSelf) continue;

      const relLabels = Array.from(card.querySelectorAll('label')).filter(l => l.textContent.includes('ধর্ম'));
      for (const rl of relLabels) {
        const col = rl.closest('.col, [class*="col-"]');
        if (col && !col.querySelector('.v-select__selection')?.textContent.trim()) {
          if (await selectSingleVuetifyOption(col, ['ইসলাম'])) count++;
        }
      }

      const disLabels = Array.from(card.querySelectorAll('label')).filter(l => l.textContent.includes('প্রতিবন্ধিতা') || l.textContent.includes('প্রতিবন্ধী'));
      for (const dl of disLabels) {
        const col = dl.closest('.col, [class*="col-"]');
        if (col && !col.querySelector('.v-select__selection')?.textContent.trim()) {
          if (await selectSingleVuetifyOption(col, ['না', 'প্রতিবন্ধী নন'])) count++;
        }
      }
    }
    showToast(`⚡ ${toBnDigits(count)}টি সদস্য ফিল্ডে স্মার্ট ডিফল্ট প্রয়োগ করা হয়েছে!`);
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
    const docTypeChoice = activeScanTarget.type === 'member'
      ? (document.getElementById('fc-modal-doc-type')?.value || 'auto')
      : 'auto';

    showModalOcrWarnings([]);
    loading.style.display = 'flex';
    btnCamera.style.display = 'none';
    btnSubmit.style.display = 'none';

    let detectedMime = 'image/jpeg';
    const mimeMatch = String(base64Data || '').match(/^data:([^;]+);base64,/);
    if (mimeMatch) detectedMime = mimeMatch[1] || 'image/jpeg';

    const modalProvider = document.getElementById('fc-modal-ai-provider')?.value || aiProvider || 'economy';
    const modalKeySlot = document.getElementById('fc-modal-default-key')?.value || defaultKeySlot || 'auto';
    const modalGemModel = document.getElementById('fc-modal-gemini-model')?.value || geminiModel || 'gemini-3.1-flash-lite';
    const modalDsModel = document.getElementById('fc-modal-deepseek-model')?.value || deepseekModel || 'deepseek-flash';
    aiProvider = modalProvider;
    defaultKeySlot = modalKeySlot;
    geminiModel = modalGemModel;
    deepseekModel = modalDsModel;
    localStorage.setItem('fc_ai_provider', modalProvider);
    localStorage.setItem('fc_default_key_slot', modalKeySlot);
    localStorage.setItem('fc_gemini_model', modalGemModel);
    localStorage.setItem('fc_deepseek_model', modalDsModel);

    const loadingTextEl = document.getElementById('fc-modal-loading-text');
    if (loadingTextEl) {
      const useDsMsg = modalProvider === 'deepseek' || (modalKeySlot === 'deepseek' && Boolean(deepseekApiKey) && (modalProvider === 'economy' || modalProvider === 'auto'));
      loadingTextEl.textContent = useDsMsg
        ? `DeepSeek (${modalDsModel}) দিয়ে ডকুমেন্ট স্ক্যান হচ্ছে...`
        : `${modalGemModel} দিয়ে ডকুমেন্ট স্ক্যান হচ্ছে...`;
    }

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
      loading.style.display = 'none';
      btnCamera.style.display = 'flex';

      if (chrome.runtime.lastError) {
        alert('OCR রিকোয়েস্ট এরর: ' + chrome.runtime.lastError.message);
        return;
      }

      if (response && response.success && response.data) {
        const data = response.data;
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
          window.__fcStep1FilledKey = '';
          updateWidgetPreview(data);
          await fillFormFields(data);
          syncToFirestore(data);
          if (warnings.length > 0) {
            showToast(`⚠️ NID তথ্য পূরণ — সতর্কতা: ${warnings[0]}${costTag ? ` • ${costTag}` : ''}`);
          } else {
            showToast(`✅ এনআইডি তথ্য সফলভাবে পূরণ করা হয়েছে!${costTag ? ` ${costTag}` : ''}`);
          }
        }
        updateSummaryBadge();
      } else {
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
  const myClientId = localStorage.getItem('fc_client_id') || (() => {
    const id = 'ext_' + Math.random().toString(36).slice(2, 10);
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

    cm.querySelector('#fc-chat-room-join').onclick = () => {
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
      cm.querySelector('#fc-chat-status').textContent = `${socket && socket.connected ? '🟢 সার্ভার + ক্লাউড' : '☁️ ক্লাউড রুম'} সক্রিয় (${roomCode})`;
      fetchRoomMessages(true);
      showToast(`🔗 রুম "${roomCode}"-এ যুক্ত হয়েছেন!`);
    };

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
      lastRoomClearedMs = Date.now();
      roomMsgMap.clear();
      renderChatFeed();
      if (socket && socket.connected) socket.emit('clear-room-messages', { room: roomCode });
      await fetch(`${ROOM_EDGE_API}?room=${encodeURIComponent(roomCode)}`, { method: 'DELETE' }).catch(() => {});
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
        lastExtractedData = msg.payload;
        window.__fcStep1FilledKey = '';
        updateWidgetPreview(msg.payload);
        cm.style.display = 'none';
        await fillFormFields(msg.payload);
        showToast(`⚡ রুম থেকে "${msg.payload.name_bn || msg.payload.doc_number}" আবেদনকারী ফর্মে পূরণ হয়েছে!`);
      } else if (act === 'fill-member' && msg.payload) {
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
          await fillMemberCard(targetCard, msg.payload);
          handleSection5AndCrossMatch();
          showToast(`✅ সদস্য "${msg.payload.name_bn || msg.payload.doc_number}" কার্ডে পূরণ হয়েছে!`);
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
        lastExtractedData = msg.payload;
        window.__fcStep1FilledKey = '';
        updateWidgetPreview(msg.payload);
        fillFormFields(msg.payload);
      }
    }
    return isNew;
  }

  async function fetchRoomMessages(forceFull = false) {
    if (document.hidden) return;
    try {
      const metaRes = await fetch(`${ROOM_FIRESTORE_BASE}/${encodeURIComponent(roomCode)}?t=${Date.now()}`);
      if (metaRes.ok) {
        const mj = await metaRes.json().catch(() => ({}));
        const mf = mj?.fields || {};
        const clearedAt = Number(mf.cleared_at_ms?.integerValue || 0);
        const lastId = mf.last_msg_id?.stringValue || '';
        const sig = `${roomCode}|${lastId}|${clearedAt}`;
        if (clearedAt > lastRoomClearedMs) {
          lastRoomClearedMs = clearedAt;
          for (const [k, v] of roomMsgMap.entries()) {
            if (v.ts <= lastRoomClearedMs) roomMsgMap.delete(k);
          }
          renderChatFeed();
        }
        if (!forceFull && sig === lastRoomMetaSig && roomBootstrapped) return;
        lastRoomMetaSig = sig;
        const listRes = await fetch(`${ROOM_FIRESTORE_BASE}/${encodeURIComponent(roomCode)}/messages?pageSize=60`);
        if (listRes.ok) {
          const lj = await listRes.json().catch(() => ({}));
          const docs = Array.isArray(lj.documents) ? lj.documents : [];
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
              room: roomCode,
              type: f.type?.stringValue || 'text',
              text: f.text?.stringValue || '',
              payload,
              replyTo,
              senderName: f.senderName?.stringValue || 'ডিভাইস',
              senderClient: f.senderClient?.stringValue || '',
              senderId: f.senderId?.stringValue || '',
              ts: Number(f.ts?.integerValue || f.ts?.doubleValue || 0)
            }, !roomBootstrapped);
            if (added) anyNew = true;
          });
          roomBootstrapped = true;
          if (anyNew) renderChatFeed();
          return;
        }
      }
    } catch (_) {}
    try {
      const er = await fetch(`${ROOM_EDGE_API}?room=${encodeURIComponent(roomCode)}&t=${Date.now()}`);
      if (er.ok) {
        const ej = await er.json();
        if (ej && Array.isArray(ej.messages)) {
          let anyNew = false;
          ej.messages.forEach(m => { if (processIncomingRoomMsg(m, !roomBootstrapped)) anyNew = true; });
          roomBootstrapped = true;
          if (anyNew) renderChatFeed();
        }
      }
    } catch (_) {}
  }

  async function sendRoomMessage({ type = 'text', text = '', payload = null } = {}) {
    const ts = Date.now();
    const id = `m_${String(ts).padStart(14, '0')}_${Math.random().toString(36).slice(2, 7)}`;
    const msg = {
      id,
      room: roomCode,
      type,
      text: String(text || '').trim(),
      payload,
      senderName: myDeviceName,
      senderClient: 'extension',
      senderId: myClientId,
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
        body: JSON.stringify({ fields })
      });
      const preview = (msg.text || msg.payload?.name_bn || msg.payload?.doc_number || 'ডেটা').slice(0, 120);
      const metaFields = {
        room: { stringValue: msg.room },
        last_msg_id: { stringValue: msg.id },
        last_sender: { stringValue: msg.senderName },
        last_preview: { stringValue: preview },
        updated_at: { timestampValue: new Date().toISOString() }
      };
      const mask = Object.keys(metaFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
      await fetch(`${ROOM_FIRESTORE_BASE}/${encodeURIComponent(msg.room)}?${mask}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: metaFields })
      });
      if (wRes.ok) return true;
    } catch (_) {}

    await fetch(ROOM_EDGE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg)
    }).catch(() => {});
    return true;
  }

  function openChatModal() {
    const cm = ensureChatModal();
    roomUnreadCount = 0;
    updateChatBadge();
    cm.style.display = 'flex';
    fetchRoomMessages(true);
    renderChatFeed();
  }

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
          lastExtractedData = payload.data;
          window.__fcLastScannedAny = payload.data;
          window.__fcStep1FilledKey = '';
          updateWidgetPreview(payload.data);
          const filled = await fillFormFields(payload.data);
          syncToFirestore(payload.data);
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
    toast.textContent = String(message || '');
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

  function findInputByLabelText(keywords, rootEl = null) {
    const scope = rootEl || document;
    const normKeys = keywords.map(k => normalizeBn(k));
    const labels = Array.from(scope.querySelectorAll('label'));
    for (const label of labels) {
      const text = normalizeBn(label.textContent || '');
      if (normKeys.some(k => text.includes(k))) {
        if (label.htmlFor) {
          const inp = document.getElementById(label.htmlFor);
          if (inp && !inp.disabled && (!rootEl || rootEl.contains(inp))) return inp;
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

  // Helper to standardize Date of Birth (supports English & Bengali months/digits) to DD/MM/YYYY
  function standardizeDate(dobStr) {
    if (!dobStr) return '';
    let str = normalizeDigits(dobStr).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

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

    // Bengali month names: ১৪ মে ১৯৮৫ / ০৫ জানুয়ারি ২০১০
    const bnPrefixes = [
      ['জানু', '01'], ['ফেব', '02'], ['মার', '03'], ['এপ্রি', '04'],
      ['মে', '05'], ['জুন', '06'], ['জুল', '07'], ['আগ', '08'],
      ['সেপ', '09'], ['অক', '10'], ['নভ', '11'], ['ডিস', '12']
    ];
    const bnMatch = str.match(/^(\d{1,2})[\s\-,/.]+([\u0980-\u09FF]+)[\s\-,/.]+(\d{4})/);
    if (bnMatch) {
      const hit = bnPrefixes.find(([p]) => bnMatch[2].startsWith(p));
      if (hit) return `${bnMatch[1].padStart(2, '0')}/${hit[1]}/${bnMatch[3]}`;
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

  function selectVuetifyDropdown(labelKeywords, targetValueText, rootEl = null) {
    return new Promise((resolve) => {
      if (!targetValueText) return resolve(false);
      const scope = rootEl || document;
      const normKeys = labelKeywords.map(k => normalizeBn(k));
      const normTarget = normalizeBn(targetValueText);
      const labels = Array.from(scope.querySelectorAll('label'));
      let container = null;
      for (const l of labels) {
        if (normKeys.some(k => normalizeBn(l.textContent || '').includes(k))) {
          container = l.closest('.col, [class*="col-"], span, div');
          break;
        }
      }

      if (!container) return resolve(false);

      const currentSelection = container.querySelector('.v-select__selection');
      if (currentSelection && normalizeBn(currentSelection.textContent).includes(normTarget)) {
        return resolve(true);
      }

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
          setTimeout(() => resolve(true), 120);
          return;
        }
        if (attempts >= 8) {
          clearInterval(interval);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          resolve(false);
        }
      }, 120);
    });
  }

  let isFillingFormFields = false;
  // Main Autofill Routine
  async function fillFormFields(data) {
    if (!data || isFillingFormFields) return false;
    isFillingFormFields = true;
    let filledCount = 0;

    try {
      const tab0 = document.querySelector('[data-family-card-tab="0"]');
      const tab1 = document.querySelector('[data-family-card-tab="1"]');

      // Canonicalize DOB first so Bengali digits work for 13->17 NID conversion
      if (data.dob) {
        data.dob = standardizeDate(data.dob);
      }

      // 1. সম্পূর্ণ নাম (বাংলা)
      if (data.name_bn) {
        const inp = findInputByLabelText(['সম্পূর্ণ নাম (বাংলা)'], tab0) || findInputByLabelText(['সম্পূর্ণ নাম (বাংলা)']) || document.getElementById('input-211');
        if (setReactiveValue(inp, data.name_bn)) filledCount++;
      }

      // 2. সম্পূর্ণ নাম (ইংরেজি)
      if (data.name_en) {
        const inp = findInputByLabelText(['সম্পূর্ণ নাম (ইংরেজি)'], tab0) || findInputByLabelText(['সম্পূর্ণ নাম (ইংরেজি)']) || document.getElementById('input-213');
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
        const inp = findInputByLabelText(['জাতীয় পরিচিতি নম্বর (এনআইডি)', 'জাতীয় পরিচিতি নম্বর'], tab0) || findInputByLabelText(['জাতীয় পরিচিতি নম্বর']) || document.getElementById('input-215');
        if (setReactiveValue(inp, cleanNid)) filledCount++;
      }

      // 4. জন্ম তারিখ (DD/MM/YYYY)
      if (data.dob) {
        const inp = findInputByLabelText(['জন্ম তারিখ'], tab0) || findInputByLabelText(['জন্ম তারিখ']) || document.getElementById('input-221');
        if (setReactiveValue(inp, data.dob)) filledCount++;
      }

      // 5. লিঙ্গ
      if (data.gender) {
        await selectVuetifyDropdown(['লিঙ্গ'], data.gender, tab0 || document);
      }

      // 6. বৈবাহিক অবস্থা (Default: বিবাহিত)
      if (data.marital_status) {
        await selectVuetifyDropdown(['বৈবাহিক অবস্থা'], data.marital_status, tab1 || document);
      }

      // 7. ধর্ম (Default: ইসলাম)
      if (data.religion) {
        await selectVuetifyDropdown(['ধর্ম'], data.religion, tab1 || document);
      }

      // 8. Personal details (Father's/Mother's name in Step 1)
      if (data.father_name_bn) {
        const inp = findInputByLabelText(['পিতার নাম (বাংলা)'], tab1) || findInputByLabelText(['পিতার নাম (বাংলা)']) || document.getElementById('input-1286') || document.getElementById('input-242');
        if (setReactiveValue(inp, data.father_name_bn)) filledCount++;
      }
      if (data.father_name_en) {
        const fatEn = String(data.father_name_en).toUpperCase().trim();
        const inp = findInputByLabelText(['পিতার নাম (ইংরেজি)'], tab1) || findInputByLabelText(['পিতার নাম (ইংরেজি)']) || document.getElementById('input-1288') || document.getElementById('input-244');
        if (setReactiveValue(inp, fatEn)) filledCount++;
      }
      if (data.mother_name_bn) {
        const inp = findInputByLabelText(['মাতার নাম (বাংলা)'], tab1) || findInputByLabelText(['মাতার নাম (বাংলা)']) || document.getElementById('input-1290') || document.getElementById('input-246');
        if (setReactiveValue(inp, data.mother_name_bn)) filledCount++;
      }
      if (data.mother_name_en) {
        const motEn = String(data.mother_name_en).toUpperCase().trim();
        const inp = findInputByLabelText(['মাতার নাম (ইংরেজি)'], tab1) || findInputByLabelText(['মাতার নাম (ইংরেজি)']) || document.getElementById('input-1292') || document.getElementById('input-248');
        if (setReactiveValue(inp, motEn)) filledCount++;
      }

      // 9. মোবাইল নম্বর
      if (data.mobile_number) {
        const cleanMobile = normalizeDigits(data.mobile_number);
        const inp = findInputByLabelText(['মোবাইল নম্বর'], tab1) || findInputByLabelText(['মোবাইল নম্বর']) || document.getElementById('input-1294') || document.getElementById('input-250');
        if (setReactiveValue(inp, cleanMobile)) filledCount++;
      }

      // Step 4: Collection Address Auto-fill
      handleSection4Address();

      return filledCount > 0;
    } finally {
      setTimeout(() => { isFillingFormFields = false; }, 200);
    }
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
                if (quality > 0.36) {
                  quality -= 0.12;
                  tryEncode();
                  return;
                }
                if (width > 240 && height > 180) {
                  width = Math.round(width * 0.78);
                  height = Math.round(height * 0.78);
                  quality = 0.76;
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
                sizeKb: Math.round(blob.size / 1024)
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
      const maxBytes = 195 * 1024;

      if (file.size > maxBytes || isHouse) {
        e.stopImmediatePropagation();
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
          inputEl.__isOptimizing = false;
        }
      }

      setTimeout(traceSection3Media, 400);
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
  function getSection4CollectionInputs() {
    const tab2 = document.querySelector('[data-family-card-tab="2"]');
    if (tab2 && tab2.style.display === 'none' && !tab2.classList.contains('v-expansion-panel--active')) {
      return { postCodeInput: null, villageInput: null };
    }
    const scope = tab2 || document.querySelector('.v-expansion-panel--active') || document;
    const headerNodes = Array.from(scope.querySelectorAll('.v-chip, .v-chip__content, h3, h4, .text-subtitle-1, .text-subtitle-2'));
    const collectionChip = headerNodes.find(el => normalizeBn(el.textContent) === 'ফ্যামিলি কার্ড তথ্য সংগ্রহের ঠিকানা');
    if (!collectionChip) return { postCodeInput: null, villageInput: null };

    const permanentChip = headerNodes.find(el => {
      const t = normalizeBn(el.textContent);
      return t === 'স্থায়ী ঠিকানা' || t === 'স্থায়ী ঠিকানা';
    });

    const allInputs = Array.from(scope.querySelectorAll('input:not([type="hidden"]):not([disabled])'));

    const collectionInputs = allInputs.filter(inp => {
      const isAfterCollection = (inp.compareDocumentPosition(collectionChip) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
      const isBeforePermanent = !permanentChip || ((inp.compareDocumentPosition(permanentChip) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      return isAfterCollection && isBeforePermanent;
    });

    let postCodeInput = null;
    let villageInput = null;

    for (const inp of collectionInputs) {
      const parentCol = inp.closest('.col, [class*="col-"], .v-input, div');
      const labelText = normalizeBn(parentCol?.querySelector('label')?.textContent || '');
      if (labelText.includes('পোস্ট কোড')) {
        postCodeInput = inp;
      } else if (labelText.includes('গ্রাম') || labelText.includes('বাড়ি নং') || labelText.includes('সেকশন')) {
        villageInput = inp;
      }
    }

    return { postCodeInput, villageInput };
  }

  function attachSection4EditGuard(inp) {
    if (!inp || inp.__fcS4GuardAttached) return;
    inp.__fcS4GuardAttached = true;
    inp.addEventListener('input', (e) => {
      if (e.isTrusted) {
        inp.dataset.fcS4UserEdited = 'true';
        inp.dataset.fcS4AutoApplied = 'true';
      }
    });
  }

  function handleSection4Address() {
    const { postCodeInput, villageInput } = getSection4CollectionInputs();
    if (!postCodeInput && !villageInput) return;

    const currentPostcode = localStorage.getItem('fc_default_postcode') || '7721';
    const rawList = safeJsonParse(localStorage.getItem('fc_village_list'), ['বসাকুষ্টিয়া', 'চর কলিমহর']);
    const villageList = Array.isArray(rawList) && rawList.length ? rawList : ['বসাকুষ্টিয়া', 'চর কলিমহর'];
    const currentVillage = localStorage.getItem('fc_default_village') || villageList[0] || 'বসাকুষ্টিয়া';

    if (postCodeInput) {
      attachSection4EditGuard(postCodeInput);
      if (!postCodeInput.value && postCodeInput.dataset.fcS4UserEdited !== 'true' && postCodeInput.dataset.fcS4AutoApplied !== 'true') {
        setReactiveValue(postCodeInput, currentPostcode);
        postCodeInput.dataset.fcS4AutoApplied = 'true';
        console.log('[FamilyCard Extension] Section 4 Post Code filled with default:', currentPostcode);
      }
    }

    if (villageInput) {
      attachSection4EditGuard(villageInput);
      if (!villageInput.value && villageInput.dataset.fcS4UserEdited !== 'true' && villageInput.dataset.fcS4AutoApplied !== 'true') {
        setReactiveValue(villageInput, currentVillage);
        villageInput.dataset.fcS4AutoApplied = 'true';
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

    let optionsHtml = villageList.map(v => `<option value="${escapeHtml(v)}" ${v === currentVillage ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
    optionsHtml += '<option value="__ADD_NEW__">➕ নতুন গ্রাম যোগ করুন...</option>';

    bar.innerHTML = `
      <div style="display: flex; align-items: center; gap: 6px; font-weight: 700; color: #166534;">
        <span>🏠 গ্রাম:</span>
        <select id="fc-inline-village-select" style="padding: 3px 8px; border-radius: 6px; border: 1.5px solid #16a34a; font-size: 12px; font-weight: 700; background: #ffffff; color: #166534; cursor: pointer;">
          ${optionsHtml}
        </select>
      </div>
      <div style="font-size: 11px; color: #15803d; font-weight: 600;">
        📮 পোস্ট কোড: <b>${escapeHtml(currentPostcode)}</b> (তথ্য সংগ্রহের ঠিকানা)
      </div>
    `;

    parentContainer.insertBefore(bar, parentContainer.firstChild);

    const sel = bar.querySelector('#fc-inline-village-select');
    sel.addEventListener('change', () => {
      if (sel.value === '__ADD_NEW__') {
        const newName = prompt('নতুন গ্রামের নাম লিখুন:');
        if (newName && newName.trim()) {
          const trimmed = newName.trim();
          const curList = safeJsonParse(localStorage.getItem('fc_village_list'), ['বসাকুষ্টিয়া', 'চর কলিমহর']);
          const list = Array.isArray(curList) ? curList : ['বসাকুষ্টিয়া', 'চর কলিমহর'];
          if (!list.includes(trimmed)) {
            list.push(trimmed);
            localStorage.setItem('fc_village_list', JSON.stringify(list));
          }
          localStorage.setItem('fc_default_village', trimmed);
          delete villageInput.dataset.fcS4UserEdited;
          setReactiveValue(villageInput, trimmed);
          villageInput.dataset.fcS4AutoApplied = 'true';
          updateModalVillageSelect();
          showToast(`✅ নতুন গ্রাম "${trimmed}" যোগ করা হয়েছে এবং ডিফল্ট করা হলো!`);
          bar.remove();
          injectInlineVillageToolbar(villageInput, list, trimmed, currentPostcode);
        } else {
          sel.value = currentVillage;
        }
      } else {
        const chosen = sel.value;
        localStorage.setItem('fc_default_village', chosen);
        delete villageInput.dataset.fcS4UserEdited;
        setReactiveValue(villageInput, chosen);
        villageInput.dataset.fcS4AutoApplied = 'true';
        updateModalVillageSelect();
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

    const familyKey = scrapeFamilyId() || 'default';
    const rawCache = safeJsonParse(localStorage.getItem('fc_section5_data'), null);
    const cached = (rawCache && rawCache._familyKey === familyKey) ? rawCache : null;

    if (!panel) return cached;

    const data = {
      _familyKey: familyKey,
      maleCount: 0,
      femaleCount: 0,
      transCount: 0,
      totalCount: 0,
      training: '',
      mfsAccount: '',
      abroadMale: 0,
      abroadFemale: 0,
      abroadTrans: 0
    };

    let hasFoundFields = false;
    let sawCountFieldsInDom = false;
    const cols = Array.from(panel.querySelectorAll('.col, [class*="col-"]'));

    cols.forEach(col => {
      const labelEl = col.querySelector('label');
      if (!labelEl) return;
      const label = normalizeBn(labelEl.textContent).replace(/[\*\s]+/g, ' ').trim();

      if (/পরিবারে\s*(পুরুষ|নারী|হিজড়া)\s*সদস্য\s*সংখ্যা/i.test(label)) {
        sawCountFieldsInDom = true;
      }

      const selEl = col.querySelector('.v-select__selection');
      const inputEl = col.querySelector('input:not([type="hidden"])');
      const rawVal = normalizeBn(selEl ? selEl.textContent : (inputEl ? inputEl.value : ''));
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

    if (sawCountFieldsInDom) return data;
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
      match.statusText
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
        applySmartDefaultsToAllMembers();
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

    const stack = document.querySelector('.fm-members-stack') || s6Panel?.querySelector('.v-expansion-panel-content__wrap');
    if (stack) {
      injectTab6Banner(stack, sec5Data, membersData, match);
      injectMemberCardButtons();
    }

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
  let isFillingSection6 = false;

  function selectVuetifyAutocomplete(container, targetText, fallbackId) {
    return new Promise((resolve) => {
      if (!container || !targetText) return resolve(false);

      const normTarget = normalizeBn(targetText);
      const currentSel = container.querySelector('.v-select__selection');
      const inputEl = container.querySelector('input:not([type="hidden"])');
      const hiddenEl = container.querySelector('input[type="hidden"]');

      if (currentSel && normalizeBn(currentSel.textContent).includes(normTarget)) return resolve(true);
      if (inputEl && inputEl.value && normalizeBn(inputEl.value).includes(normTarget)) return resolve(true);
      if (hiddenEl && fallbackId && hiddenEl.value === String(fallbackId)) return resolve(true);

      if (isSelectingBranch) return resolve(false);
      isSelectingBranch = true;

      try {
        const clickSlot = container.querySelector('.v-input__slot') || inputEl;
        const listId = clickSlot?.getAttribute('aria-owns') || container.querySelector('[aria-owns]')?.getAttribute('aria-owns');
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
          let menuItems = [];
          if (listId) {
            const listEl = document.getElementById(listId);
            if (listEl) menuItems = Array.from(listEl.querySelectorAll('.v-list-item'));
          }
          if (menuItems.length === 0) {
            menuItems = Array.from(document.querySelectorAll('.v-menu__content.menuable__content__active .v-list-item, .v-autocomplete__content.menuable__content__active .v-list-item'));
          }
          if (menuItems.length === 0 && attempts >= 3) {
            menuItems = Array.from(document.querySelectorAll('.v-menu__content .v-list-item, .v-autocomplete__content .v-list-item')).filter(el => el.offsetParent !== null);
          }

          const exact = menuItems.find(item => normalizeBn(item.textContent) === normTarget);
          const match = exact || menuItems.find(item => normalizeBn(item.textContent).includes(normTarget));

          if (match) {
            const clickable = match.closest('.v-list-item') || match;
            clickable.click();
            clearInterval(pollInterval);
            console.log('[FamilyCard Extension] Selected branch:', normalizeBn(match.textContent));
            showToast(`✅ ব্যাংক শাখা "${normalizeBn(match.textContent)}" নির্বাচিত হয়েছে!`);
            setTimeout(() => { isSelectingBranch = false; resolve(true); }, 350);
            return;
          }

          if (attempts >= 8) {
            clearInterval(pollInterval);
            if (fallbackId && hiddenEl) {
              setReactiveValue(hiddenEl, String(fallbackId));
            }
            setTimeout(() => { isSelectingBranch = false; resolve(false); }, 350);
          }
        }, 140);
      } catch (e) {
        console.warn('[FamilyCard Extension] Error in selectVuetifyAutocomplete:', e);
        isSelectingBranch = false;
        resolve(false);
      }
    });
  }

  function selectVuetifyDropdown(container, targetText, fallbackId) {
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
          let items = [];
          if (listId) {
            const listEl = document.getElementById(listId);
            if (listEl) items = Array.from(listEl.querySelectorAll('.v-list-item'));
          }
          if (items.length === 0) {
            items = Array.from(document.querySelectorAll('.v-menu__content.menuable__content__active .v-list-item'));
          }
          if (items.length === 0 && attempts >= 3) {
            items = Array.from(document.querySelectorAll('.v-menu__content .v-list-item')).filter(el => el.offsetParent !== null);
          }

          const exact = items.find(it => normalizeBn(it.textContent) === normTarget);
          const match = exact || items.find(it => normalizeBn(it.textContent).includes(normTarget));
          if (match) {
            const clickable = match.closest('.v-list-item') || match;
            clickable.click();
            clearInterval(interval);
            console.log('[FamilyCard Extension] Selected ownership:', targetText);
            showToast(`✅ অ্যাকাউন্টের মালিকানা "${targetText}" নির্বাচিত হয়েছে!`);
            setTimeout(() => { isSelectingOwnership = false; resolve(true); }, 300);
            return;
          }
          if (attempts >= 8) {
            clearInterval(interval);
            const hiddenEl = container.querySelector('input[type="hidden"]');
            if (fallbackId && hiddenEl) {
              setReactiveValue(hiddenEl, String(fallbackId));
            }
            setTimeout(() => { isSelectingOwnership = false; resolve(false); }, 300);
          }
        }, 130);
      } catch (e) {
        console.warn('[FamilyCard Extension] Error in selectVuetifyDropdown:', e);
        isSelectingOwnership = false;
        resolve(false);
      }
    });
  }

  function injectSection6Toolbar(panel, currentOwnership, currentBranch) {
    if (!panel) return;
    const wrap = panel.querySelector('.v-expansion-panel-content__wrap');
    if (!wrap || wrap.querySelector('#fc-section6-toolbar')) return;

    const bar = document.createElement('div');
    bar.id = 'fc-section6-toolbar';
    bar.style.cssText = 'margin-bottom: 14px; padding: 10px 14px; background: #f0f9ff; border: 1.5px solid #0284c7; border-radius: 10px; font-family: -apple-system, sans-serif; box-shadow: 0 2px 6px rgba(0,0,0,0.05); font-size: 12px;';

    const ownershipOptions = ['নিজ', 'পিতা', 'মাতা', 'স্বামী', 'স্ত্রী', 'অভিভাবক'];
    let ownHtml = ownershipOptions.map(o => `<option value="${escapeHtml(o)}" ${o === currentOwnership ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');

    const rawBranchList = safeJsonParse(localStorage.getItem('fc_branch_list'), ['মাছপাড়া শাখা', 'পাংশা শাখা', 'রাজবাড়ী শাখা']);
    const branchList = Array.isArray(rawBranchList) && rawBranchList.length ? [...rawBranchList] : ['মাছপাড়া শাখা', 'পাংশা শাখা', 'রাজবাড়ী শাখা'];
    if (currentBranch && !branchList.some(b => normalizeBn(b) === normalizeBn(currentBranch))) branchList.unshift(currentBranch);
    let branchHtml = branchList.map(b => `<option value="${escapeHtml(b)}" ${normalizeBn(b) === normalizeBn(currentBranch) ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('');
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
          <select id="fc-s6-ownership-select" style="padding: 3px 6px; border-radius: 5px; border: 1px solid #0284c7; font-size: 11.5px; font-weight: 700; color: #0369a1; cursor: pointer; background: #fff;">
            ${ownHtml}
          </select>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <b style="color: #0369a1;">🏛️ ব্যাংক শাখা:</b>
          <select id="fc-s6-branch-select" style="padding: 3px 6px; border-radius: 5px; border: 1px solid #0284c7; font-size: 11.5px; font-weight: 700; color: #0369a1; cursor: pointer; background: #fff;">
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
    ownSelect.addEventListener('change', async () => {
      const val = ownSelect.value;
      localStorage.setItem('fc_default_account_ownership', val);
      const elems = getSection6BankElements();
      if (elems?.ownershipSelect) {
        delete elems.ownershipSelect.dataset.fcS6UserEdited;
        await selectVuetifyDropdown(elems.ownershipSelect, val, normalizeBn(val) === 'নিজ' ? '142' : null);
      }
    });

    const branchSelectEl = bar.querySelector('#fc-s6-branch-select');
    branchSelectEl.addEventListener('change', async () => {
      if (branchSelectEl.value === '__ADD_NEW_BRANCH__') {
        const newBranch = prompt('নতুন ব্যাংক শাখার নাম লিখুন (যেমন: মাছপাড়া শাখা):');
        if (newBranch && newBranch.trim()) {
          const trimmed = newBranch.trim();
          const curList = safeJsonParse(localStorage.getItem('fc_branch_list'), ['মাছপাড়া শাখা', 'পাংশা শাখা', 'রাজবাড়ী শাখা']);
          const list = Array.isArray(curList) ? curList : ['মাছপাড়া শাখা', 'পাংশা শাখা', 'রাজবাড়ী শাখা'];
          if (!list.includes(trimmed)) list.push(trimmed);
          localStorage.setItem('fc_branch_list', JSON.stringify(list));
          localStorage.setItem('fc_default_bank_branch', trimmed);
          bar.remove();
          injectSection6Toolbar(panel, ownSelect.value, trimmed);
          const elems = getSection6BankElements();
          if (elems?.branchSelect) {
            delete elems.branchSelect.dataset.fcS6UserEdited;
            await selectVuetifyAutocomplete(elems.branchSelect, trimmed, normalizeBn(trimmed).includes('মাছপাড়া') ? '7680' : null);
          }
        } else {
          branchSelectEl.value = currentBranch;
        }
      } else {
        const val = branchSelectEl.value;
        localStorage.setItem('fc_default_bank_branch', val);
        const elems = getSection6BankElements();
        if (elems?.branchSelect) {
          delete elems.branchSelect.dataset.fcS6UserEdited;
          await selectVuetifyAutocomplete(elems.branchSelect, val, normalizeBn(val).includes('মাছপাড়া') ? '7680' : null);
        }
      }
    });

    const btnAuto = bar.querySelector('#fc-s6-auto-fill-btn');
    btnAuto.addEventListener('click', async () => {
      const elems = getSection6BankElements();
      if (!elems) return;
      const own = localStorage.getItem('fc_default_account_ownership') || 'নিজ';
      const br = localStorage.getItem('fc_default_bank_branch') || 'মাছপাড়া শাখা';
      if (elems.ownershipSelect) {
        delete elems.ownershipSelect.dataset.fcS6UserEdited;
        await selectVuetifyDropdown(elems.ownershipSelect, own, normalizeBn(own) === 'নিজ' ? '142' : null);
      }
      if (elems.branchSelect) {
        delete elems.branchSelect.dataset.fcS6UserEdited;
        await selectVuetifyAutocomplete(elems.branchSelect, br, normalizeBn(br).includes('মাছপাড়া') ? '7680' : null);
      }
      showToast('⚡ ব্যাংক তথ্য অটো-সিলেক্ট সম্পন্ন হয়েছে!');
    });
  }

  async function handleSection6Bank() {
    const elems = getSection6BankElements();
    if (!elems || !elems.panel) return;

    const isPanelVisible = elems.panel.style.display !== 'none' ||
                           elems.panel.classList.contains('v-expansion-panel--active') ||
                           document.querySelector('.family-card-form-step--active')?.textContent.includes('ব্যাংক/এমএফএস');

    if (!isPanelVisible) return;

    const currentOwnership = localStorage.getItem('fc_default_account_ownership') || 'নিজ';
    const currentBranch = localStorage.getItem('fc_default_bank_branch') || 'মাছপাড়া শাখা';

    injectSection6Toolbar(elems.panel, currentOwnership, currentBranch);

    [elems.ownershipSelect, elems.branchSelect].forEach(el => {
      if (el && !el.__fcS6GuardAttached) {
        el.__fcS6GuardAttached = true;
        el.addEventListener('mousedown', (e) => {
          if (e.isTrusted) el.dataset.fcS6UserEdited = 'true';
        }, true);
      }
    });

    if (isFillingSection6) return;
    isFillingSection6 = true;
    try {
      if (elems.ownershipSelect && elems.ownershipSelect.dataset.fcS6UserEdited !== 'true') {
        const curOwn = elems.ownershipSelect.querySelector('.v-select__selection')?.textContent.trim();
        if (!curOwn) {
          await selectVuetifyDropdown(elems.ownershipSelect, currentOwnership, normalizeBn(currentOwnership) === 'নিজ' ? '142' : null);
        }
      }

      if (elems.branchSelect && elems.branchSelect.dataset.fcS6UserEdited !== 'true') {
        const curBranch = elems.branchSelect.querySelector('.v-select__selection')?.textContent.trim() ||
                          elems.branchSelect.querySelector('input:not([type="hidden"])')?.value.trim();
        const hiddenVal = elems.branchSelect.querySelector('input[type="hidden"]')?.value;

        if (!curBranch && !hiddenVal) {
          await selectVuetifyAutocomplete(elems.branchSelect, currentBranch, normalizeBn(currentBranch).includes('মাছপাড়া') ? '7680' : null);
        }
      }
    } finally {
      setTimeout(() => { isFillingSection6 = false; }, 350);
    }
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

  function normOptionText(s) {
    return normalizeBn(s).replace(/[\/\s\u0981]+/g, '').trim();
  }

  function selectSingleVuetifyOption(col, candidates) {
    return new Promise((resolve) => {
      if (!col || !candidates || candidates.length === 0) return resolve(false);

      const hasVSelect = !!col.querySelector('.v-select');
      const plainInput = !hasVSelect ? col.querySelector('input:not([type="hidden"]):not([disabled])') : null;
      if (plainInput) {
        if (plainInput.value && candidates.some(c => normOptionText(plainInput.value) === normOptionText(c))) {
          col.dataset.fcS7DefaultApplied = 'true';
          return resolve(true);
        }
        setReactiveValue(plainInput, candidates[0]);
        col.dataset.fcS7DefaultApplied = 'true';
        return resolve(true);
      }

      const currentSel = col.querySelector('.v-select__selection');
      const curText = currentSel ? currentSel.textContent.trim() : '';

      if (curText && candidates.some(c => normalizeBn(curText) === normalizeBn(c) || normOptionText(curText) === normOptionText(c))) {
        col.dataset.fcS7DefaultApplied = 'true';
        return resolve(true);
      }

      const slot = col.querySelector('.v-input__slot') || col.querySelector('[role="button"]') || col.querySelector('input');
      if (!slot) return resolve(false);

      const listId = slot.getAttribute('aria-owns') || col.querySelector('[aria-owns]')?.getAttribute('aria-owns');
      slot.click();

      const normCands = candidates.map(c => normalizeBn(c));
      let attempts = 0;
      const timer = setInterval(() => {
        attempts++;
        let items = [];
        if (listId) {
          const listEl = document.getElementById(listId);
          if (listEl) items = Array.from(listEl.querySelectorAll('.v-list-item'));
        }
        if (items.length === 0) {
          items = Array.from(document.querySelectorAll('.v-menu__content.menuable__content__active .v-list-item'));
        }
        if (items.length === 0 && attempts >= 3) {
          items = Array.from(document.querySelectorAll('.v-menu__content .v-list-item')).filter(el => el.offsetParent !== null);
        }

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
            col.dataset.fcS7DefaultApplied = 'true';
            clearInterval(timer);
            setTimeout(() => resolve(true), 110);
            return;
          }
        }

        if (attempts >= 8) {
          clearInterval(timer);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          col.dataset.fcS7DefaultApplied = 'true';
          setTimeout(() => resolve(false), 80);
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
        match: (lbl) => lbl.includes(' পৃথক রান্নাঘর আছে'),
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
        match: (lbl) => lbl.includes('প্রধান ঘরের দেয়াল কি দিয়ে তৈরী') || lbl.includes('প্রধান ঘরের দেয়াল') || lbl.includes('প্রধান ঘরের দেওয়াল'),
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

  function injectSection7Toolbar(panel, sec5Data) {
    if (!panel) return;
    const wrap = panel.querySelector('.v-expansion-panel-content__wrap');
    if (!wrap) return;

    const totalMembers = (sec5Data && sec5Data.totalCount > 0) ? sec5Data.totalCount : 0;
    const abroadTotal = sec5Data
      ? ((sec5Data.abroadMale || 0) + (sec5Data.abroadFemale || 0) + (sec5Data.abroadTrans || 0))
      : 0;
    const remittanceText = abroadTotal > 0 ? 'হ্যা (প্রবাসী > ০)' : 'না (প্রবাসী ০)';

    let bar = wrap.querySelector('#fc-section7-toolbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fc-section7-toolbar';
      bar.style.cssText = 'margin-bottom: 14px; padding: 10px 14px; background: #f0fdf4; border: 1.5px solid #16a34a; border-radius: 10px; font-family: -apple-system, sans-serif; box-shadow: 0 2px 6px rgba(0,0,0,0.05); font-size: 12px;';
      wrap.insertBefore(bar, wrap.firstChild);
    }

    const renderHash = `${totalMembers}|${abroadTotal}`;
    if (bar.dataset.renderHash === renderHash) return;
    bar.dataset.renderHash = renderHash;

    bar.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: #166534; font-size: 13px;">
          <span>🏡 সেকশন ৭: যোগ্যতার অন্যান্য তথ্য সহকারী (১৪টি স্মার্ট ডিফল্ট সক্রিয়)</span>
        </div>
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          <button id="fc-s7-apply-btn" type="button" style="padding: 4px 10px; background: #16a34a; color: #fff; font-weight: 700; border: none; border-radius: 6px; cursor: pointer; font-size: 11px;">
            ⚡ ডিফল্ট পুনরায় প্রয়োগ করুন
          </button>
          <button id="fc-s7-save-custom-btn" type="button" style="padding: 4px 10px; background: #0284c7; color: #fff; font-weight: 700; border: none; border-radius: 6px; cursor: pointer; font-size: 11px;">
            💾 পরিবর্তিত মান ডিফল্ট সেভ করুন
          </button>
          <button id="fc-s7-reset-custom-btn" type="button" style="padding: 4px 8px; background: #64748b; color: #fff; font-weight: 600; border: none; border-radius: 6px; cursor: pointer; font-size: 11px;">
            🔄 রিসেট
          </button>
        </div>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; background: #ffffff; padding: 7px 10px; border-radius: 6px; border: 1px solid #bbf7d0; font-size: 11.5px; color: #1e293b;">
        <span>👨‍👩‍👧‍👦 <b>খানার সদস্য সংখ্যা (সেকশন ৫ হতে):</b> <b style="color: #15803d;">${totalMembers > 0 ? toBnDigits(totalMembers) + ' জন' : 'সেকশন ৫ পূরণ করুন'}</b></span>
        <span>|</span>
        <span>✈️ <b>বিদেশ হতে অর্থ গ্রহণ (প্রবাসী ${toBnDigits(abroadTotal)} জন):</b> <b style="color: #0369a1;">${remittanceText}</b></span>
        <span>|</span>
        <span>🏠 <b>ছাদ ও দেয়াল:</b> <b>টিন/কাঠ</b></span>
      </div>
      <div style="margin-top: 6px; font-size: 11px; color: #15803d;">
        💡 নির্ধারিত ১৪টি ফিল্ড স্বয়ংক্রিয়ভাবে পূরণ হবে। আপনি যেকোনো ফিল্ড ম্যানুয়ালি পরিবর্তন করলে সিস্টেম তা আর ওভাররাইট করবে না। বাকি ফিল্ডগুলো ম্যানুয়ালি পূরণ করুন।
      </div>
    `;

    const applyBtn = bar.querySelector('#fc-s7-apply-btn');
    applyBtn.onclick = () => {
      const cols = Array.from(panel.querySelectorAll('.col, [class*="col-"]'));
      cols.forEach(c => {
        delete c.dataset.fcS7DefaultApplied;
        delete c.dataset.fcS7UserEdited;
      });
      isFillingSection7 = false;
      handleSection7Eligibility(true);
      showToast('⚡ সেকশন ৭-এর ১৪টি ডিফল্ট মান পুনরায় প্রয়োগ করা হচ্ছে...');
    };

    const saveBtn = bar.querySelector('#fc-s7-save-custom-btn');
    saveBtn.onclick = () => {
      const rules = getSection7Rules(sec5Data);
      const cols = Array.from(panel.querySelectorAll('.col, [class*="col-"]'));
      const custom = safeJsonParse(localStorage.getItem('fc_section7_custom_defaults'), {});
      cols.forEach(col => {
        const lbl = col.querySelector('label')?.textContent.replace(/[\*\s]+/g, ' ').trim() || '';
        if (!lbl) return;
        const rule = rules.find(r => !r.isDynamic && r.match(lbl));
        if (rule) {
          const curVal = col.querySelector('.v-select__selection')?.textContent.trim();
          if (curVal) custom[rule.key] = curVal;
        }
      });
      localStorage.setItem('fc_section7_custom_defaults', JSON.stringify(custom));
      showToast('✅ আপনার পরিবর্তিত মানগুলো পরবর্তী সকল ফর্মের জন্য ডিফল্ট হিসেবে সেভ হয়েছে!');
    };

    const resetBtn = bar.querySelector('#fc-s7-reset-custom-btn');
    resetBtn.onclick = () => {
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
  }

  async function handleSection7Eligibility(forceAll = false) {
    const panel = document.querySelector('[data-family-card-tab="5"]') ||
                  Array.from(document.querySelectorAll('.v-expansion-panel')).find(p => p.textContent.includes('যোগ্যতার অন্যান্য তথ্য'));
    if (!panel) return;

    const isPanelVisible = panel.style.display !== 'none' ||
                           panel.classList.contains('v-expansion-panel--active') ||
                           document.querySelector('.family-card-form-step--active')?.textContent.includes('যোগ্যতার অন্যান্য তথ্য');

    if (!isPanelVisible) return;

    const sec5Data = trackSection5Data();
    injectSection7Toolbar(panel, sec5Data);

    if (isFillingSection7) return;

    const rules = getSection7Rules(sec5Data);
    const cols = Array.from(panel.querySelectorAll('.col, [class*="col-"]'));
    const queue = [];

    for (const col of cols) {
      const labelEl = col.querySelector('label');
      if (!labelEl) continue;
      const lbl = labelEl.textContent.replace(/[\*\s]+/g, ' ').trim();

      const rule = rules.find(r => r.match(lbl));
      if (!rule || !rule.candidates || rule.candidates.length === 0) continue;

      if (!col.__fcS7ListenerAttached) {
        col.__fcS7ListenerAttached = true;
        col.addEventListener('mousedown', (e) => {
          if (e.isTrusted) {
            col.dataset.fcS7DefaultApplied = 'true';
            col.dataset.fcS7UserEdited = 'true';
          }
        }, true);
      }

      const curSelVal = col.querySelector('.v-select__selection')?.textContent.trim() || '';
      const curPlainVal = !col.querySelector('.v-select') ? (col.querySelector('input:not([type="hidden"])')?.value.trim() || '') : '';
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
    try {
      for (const item of queue) {
        await selectSingleVuetifyOption(item.col, item.candidates);
        if (item.rule.isDynamic) {
          item.col.dataset.fcS7LastDynamicVal = item.rule.dynamicVal;
        }
      }
      showToast(`✅ সেকশন ৭-এর ${toBnDigits(queue.length)}টি ফিল্ড ডিফল্ট অনুযায়ী অটো-সিলেক্ট সম্পন্ন!`);
    } catch (err) {
      console.warn('[FamilyCard] Section 7 auto-fill notice:', err);
    } finally {
      setTimeout(() => { isFillingSection7 = false; }, 500);
    }
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
    let childrenCount = 2;
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

    // Check Tab 6 member cards accurately via select values and DOBs
    const memberCards = Array.from(document.querySelectorAll('.fm-members-stack .fm-member-card, [data-family-card-tab="6"] .fm-member-card'));
    let dobChildrenCount = 0;
    const nowYear = new Date().getFullYear();

    for (const card of memberCards) {
      const selects = Array.from(card.querySelectorAll('.v-select'));
      for (const sel of selects) {
        const lbl = normalizeBn(sel.closest('.col, [class*="col-"]')?.querySelector('label')?.textContent || '');
        const selVal = normalizeBn(sel.querySelector('.v-select__selection')?.textContent || '');
        if (!selVal) continue;
        if (/প্রতিবন্ধিতা|প্রতিবন্ধী/.test(lbl)) {
          if (selVal !== 'না' && !selVal.includes('প্রতিবন্ধী নন') && !selVal.includes('নাই')) {
            hasDisabledOrElderly = true;
          }
        }
      }

      const dobLbl = Array.from(card.querySelectorAll('label')).find(l => normalizeBn(l.textContent).includes('জন্ম তারিখ'));
      const dobVal = dobLbl?.closest('.col, [class*="col-"]')?.querySelector('input:not([type="hidden"])')?.value || '';
      const ym = normalizeDigits(dobVal).match(/\b(19\d{2}|20\d{2})\b/);
      if (ym) {
        const age = nowYear - parseInt(ym[1], 10);
        if (age >= 60) hasDisabledOrElderly = true;
        if (age >= 0 && age < 18) dobChildrenCount++;
      }
    }
    if (!explicitChildrenCount && dobChildrenCount > 0) {
      childrenCount = dobChildrenCount;
    }

    return { totalMembers, childrenCount, hasDisabledOrElderly, isAgriLabor, hasRemittance };
  }

  function computeAIDemandDistribution(conditions = {}) {
    const totalMembers = conditions.totalMembers || 7;
    const childrenCount = conditions.childrenCount !== undefined ? conditions.childrenCount : 2;
    const hasDisabledOrElderly = !!conditions.hasDisabledOrElderly;

    // Baseline: খাদ্য 500, চিকিৎসা 500, শিক্ষা 300, বাসস্থান 0, পোশাক 200, আয়বর্ধক 1000, সঞ্চয় 0, ঋণ 0, অন্যান্য 0 = 2500
    let dist = {
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

    if (childrenCount === 0) {
      dist.education = 0;
      dist.food += 100;
      dist.income += 200;
    } else if (childrenCount >= 3) {
      dist.education = 400;
      dist.clothing = 250;
      dist.income = 850;
    }

    if (hasDisabledOrElderly) {
      dist.health += 200;
      dist.income = Math.max(500, dist.income - 200);
    }

    if (totalMembers >= 8 && dist.food < 700) {
      dist.food += 100;
      dist.income = Math.max(500, dist.income - 100);
    }

    // Exact 2500 constraint guarantee
    const curSum = Object.values(dist).reduce((a, b) => a + b, 0);
    const diff = 2500 - curSum;
    if (diff !== 0) {
      dist.income += diff;
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
      applyMoneyDistribution(fields, BENCHMARK_MONEY_DISTRIBUTION, true);
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
    const elData = getSection9MoneyElements();
    if (!elData) return;

    const { panel, fields } = elData;
    injectSection9Toolbar(panel, fields);

    const isPanelVisible = panel.classList.contains('v-expansion-panel--active') ||
                           panel.style.display !== 'none' ||
                           document.querySelector('.family-card-form-step--active')?.textContent.includes('অর্থ ব্যবহার');

    if (!isPanelVisible && !forceAll) return;

    updateSection9HUD(fields);

    if (isFillingSection9) return;

    // Check if any field is empty or all zero
    const current = readCurrentMoneyDistribution(fields);
    const hasAnyInput = Object.entries(current).some(([k, v]) => k !== 'total' && v > 0);
    const isUserEdited = Object.values(fields).some(inp => inp && inp.dataset.fcMoneyUserEdited === 'true');

    if (forceAll || (!hasAnyInput && !isUserEdited)) {
      isFillingSection9 = true;
      try {
        let targetDist = BENCHMARK_MONEY_DISTRIBUTION;
        const parsed = safeJsonParse(localStorage.getItem('fc_custom_money_dist'), null);
        if (parsed && typeof parsed === 'object') {
          targetDist = parsed;
        } else {
          // Dynamic AI analysis based on current family conditions
          const cond = scrapeFamilyConditionsForAI();
          targetDist = computeAIDemandDistribution(cond);
        }
        applyMoneyDistribution(fields, targetDist, forceAll);
      } catch (err) {
        console.warn('[FamilyCard] Section 9 auto-fill notice:', err);
      } finally {
        setTimeout(() => { isFillingSection9 = false; }, 400);
      }
    }
  }


  // --- FAMILY CARD FULL SUMMARY & PRE-SUBMIT VALIDATOR ---
  function readColVal(col) {
    if (!col) return '';
    const sel = col.querySelector('.v-select__selection');
    if (sel && sel.textContent.trim()) return sel.textContent.trim();
    const inp = col.querySelector('input:not([type="hidden"])');
    return inp ? String(inp.value || '').trim() : '';
  }

  function findLabelVal(scope, keys) {
    if (!scope) return '';
    const normKeys = keys.map(k => normalizeBn(k));
    const labels = Array.from(scope.querySelectorAll('label'));
    for (const l of labels) {
      const t = normalizeBn(l.textContent || '');
      if (normKeys.some(k => t.includes(k))) {
        const col = l.closest('.col, [class*="col-"]');
        const v = readColVal(col);
        if (v) return v;
      }
    }
    return '';
  }

  function jumpToPortalSection(tabAttr) {
    const sModal = document.getElementById('fc-summary-modal');
    if (sModal) sModal.style.display = 'none';
    const target = document.querySelector(`[data-family-card-tab="${tabAttr}"]`);
    if (!target) {
      showToast(`⚠️ সেকশন (ট্যাব ${tabAttr}) বর্তমান পেজে খুঁজে পাওয়া যায়নি।`);
      return;
    }
    if (target.classList.contains('v-expansion-panel') && !target.classList.contains('v-expansion-panel--active')) {
      target.querySelector('.v-expansion-panel-header, button')?.click();
    }
    if (target.style.display === 'none') {
      const stepIdx = parseInt(tabAttr, 10);
      const steps = Array.from(document.querySelectorAll('.family-card-form-step, .v-tabs .v-tab'));
      const matched = steps.find(el => el.dataset?.familyCardTab === String(tabAttr)) || steps[stepIdx];
      if (matched) matched.click();
    }
    setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 180);
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

    const applicant = {
      nameBn: findLabelVal(tab0, ['নাম (বাংলা)']) || findLabelVal(tab1, ['নাম (বাংলা)']) || lastExtractedData?.name_bn || '',
      nameEn: findLabelVal(tab0, ['নাম (ইংরেজি)']) || findLabelVal(tab1, ['নাম (ইংরেজি)']) || lastExtractedData?.name_en || '',
      nid: normalizeDigits(findLabelVal(tab0, ['জাতীয় পরিচিতি', 'NID']) || lastExtractedData?.nid_number || lastExtractedData?.doc_number || '').replace(/[^0-9]/g, ''),
      dob: standardizeDate(findLabelVal(tab0, ['জন্ম তারিখ']) || lastExtractedData?.dob || ''),
      fatherBn: findLabelVal(tab1, ['পিতার নাম (বাংলা)']) || lastExtractedData?.father_name_bn || '',
      motherBn: findLabelVal(tab1, ['মাতার নাম (বাংলা)']) || lastExtractedData?.mother_name_bn || '',
      mobile: normalizeDigits(findLabelVal(tab1, ['মোবাইল']) || findLabelVal(tab0, ['মোবাইল']) || lastExtractedData?.mobile_number || '').replace(/[^0-9]/g, '')
    };

    const imgUrl = document.querySelector('.fc-photo-preview .v-image__image')?.style?.backgroundImage || '';
    const hasPhoto = (imgUrl && !imgUrl.includes('data:image/svg')) || Boolean(document.getElementById('image')?.files?.length);
    const hasSig = Boolean(document.getElementById('signature')?.files?.length) || Boolean(Array.from(document.querySelectorAll('#signature ~ *, .v-image__image')).some(el => el.closest('[data-family-card-tab="9"]') && (el.style?.backgroundImage || '').includes('http')));

    const villageVal = findLabelVal(tab2, ['গ্রাম', 'বাড়ি নং']) || localStorage.getItem('fc_default_village') || 'বসাকুষ্টিয়া';
    const postcodeVal = findLabelVal(tab2, ['পোস্ট কোড']) || localStorage.getItem('fc_default_postcode') || '7721';

    const sec5 = trackSection5Data();
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

    const bankElems = getSection6BankElements();
    const bankBranch = bankElems?.branchSelect ? readColVal(bankElems.branchSelect) : (localStorage.getItem('fc_default_bank_branch') || '');
    const bankOwner = bankElems?.ownershipSelect ? readColVal(bankElems.ownershipSelect) : (localStorage.getItem('fc_default_account_ownership') || '');

    const s7Panel = document.querySelector('[data-family-card-tab="5"]');
    const s7Filled = s7Panel ? Array.from(s7Panel.querySelectorAll('.v-select__selection')).filter(s => s.textContent.trim()).length : 0;

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
      status: hasPhoto ? (hasSig ? 'ok' : 'warn') : 'missing',
      detail: `ছবি: ${hasPhoto ? 'আছে ✅' : 'নেই ⚠️'} | স্বাক্ষর: ${hasSig ? 'আছে ✅' : 'যাচাই করুন'}`
    });
    if (!hasPhoto) blockers.push({ tab: '9', text: 'সেকশন ৩: আবেদনকারীর ছবি ও স্বাক্ষর আপলোড করুন' });

    sections.push({
      tab: '2',
      title: '৪. তথ্য সংগ্রহের ঠিকানা',
      status: villageVal ? 'ok' : 'warn',
      detail: `গ্রাম: ${villageVal || '-'} • পোস্টকোড: ${toBnDigits(postcodeVal)}`
    });

    const sec5Ok = Boolean(sec5 && sec5.totalCount > 0);
    sections.push({
      tab: '3',
      title: '৫. খানার সদস্য ও অর্থনৈতিক তথ্য',
      status: sec5Ok ? 'ok' : 'missing',
      detail: sec5Ok ? `পুরুষ ${toBnDigits(sec5.maleCount)}, নারী ${toBnDigits(sec5.femaleCount)} (মোট ${toBnDigits(sec5.totalCount)} জন)` : 'সেকশন ৫ পূরণ করা হয়নি'
    });
    if (!sec5Ok) blockers.push({ tab: '3', text: 'সেকশন ৫: খানার মোট সদস্য সংখ্যা পূরণ করুন' });

    sections.push({
      tab: '4',
      title: '৬. ব্যাংক / মোবাইল ব্যাংকিং',
      status: bankBranch ? 'ok' : 'warn',
      detail: bankBranch ? `মালিকানা: ${bankOwner || '-'} • শাখা: ${bankBranch}` : 'ব্যাংক শাখা ও মালিকানা যাচাই করুন'
    });

    sections.push({
      tab: '5',
      title: '৭. খানার যোগ্যতা ও সুযোগ-সুবিধা',
      status: s7Filled >= 8 ? 'ok' : 'warn',
      detail: s7Panel ? `${toBnDigits(s7Filled)}টি ফিল্ড পূরণকৃত` : 'সেকশন ৭ খুললে অটো-ফিল হবে'
    });

    const memberIssues = members.filter(m => m.issues.length > 0);
    const sec8Ok = crossMatch.isExactMatch && memberIssues.length === 0 && duplicateIds.length === 0;
    sections.push({
      tab: '6',
      title: '৮. পরিবারের সদস্য ও ডকুমেন্ট স্ক্যান',
      status: sec8Ok ? 'ok' : (members.length ? 'warn' : 'missing'),
      detail: `${toBnDigits(members.length)} জন সদস্য • ${crossMatch.statusText}${duplicateIds.length ? ` • ডুপ্লিকেট আইডি (${toBnDigits(duplicateIds.length)})!` : ''}`
    });
    if (!crossMatch.isExactMatch && sec5Ok) blockers.push({ tab: '6', text: `সেকশন ৮ ক্রস-ম্যাচ: ${crossMatch.statusText}` });
    if (duplicateIds.length) blockers.push({ tab: '6', text: `সদস্যদের মধ্যে একই NID/BRC (${duplicateIds[0].id}) একাধিকবার রয়েছে!` });
    memberIssues.forEach(m => blockers.push({ tab: '6', text: `${m.title} (${m.nameBn || 'নামহীন'}): ${m.issues.join(', ')}` }));

    const sec9Ok = s9Total === 2500;
    sections.push({
      tab: '10',
      title: '৯. ভাতা ব্যবহার (২৫০০ টাকা)',
      status: sec9Ok ? 'ok' : 'warn',
      detail: s9Elems ? `মোট বরাদ্দ: ${toBnDigits(s9Total)} / ২৫০০ টাকা` : 'সেকশন ৯ খুললে এআই বণ্টন হবে'
    });
    if (s9Elems && !sec9Ok) blockers.push({ tab: '10', text: `সেকশন ৯: মোট বরাদ্দ ${toBnDigits(s9Total)} টাকা (ঠিক ২৫০০ টাকা হতে হবে)` });

    const okCount = sections.filter(s => s.status === 'ok').length;
    const readinessPct = Math.round((okCount / sections.length) * 100);

    return {
      familyId,
      applicant,
      villageVal,
      postcodeVal,
      sec5,
      crossMatch,
      members,
      duplicateIds,
      bankBranch,
      bankOwner,
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
      `ব্যাংক/শাখা: ${s.bankOwner || '-'} • ${s.bankBranch || '-'}`,
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

    body.querySelector('#fc-sum-scan-btn').onclick = () => {
      sm.style.display = 'none';
      openMemberScanner(null, 'auto');
    };

    sm.style.display = 'flex';
  }

  function updateSummaryBadge() {
    const summaryBtn = document.getElementById('fc-summary-btn');
    if (!summaryBtn) return;
    const s = collectFullFamilyCardSummary();
    const label = `📊 সারসংক্ষেপ (${toBnDigits(s.readinessPct)}%)`;
    const cls = (s.readinessPct >= 85 && s.blockers.length === 0) ? 'ready' : (s.blockers.length > 0 ? 'warn' : '');
    if (summaryBtn.dataset.lastLabel !== label) {
      summaryBtn.dataset.lastLabel = label;
      summaryBtn.innerHTML = `<span>${label}</span>`;
    }
    if (summaryBtn.className !== cls) summaryBtn.className = cls;
  }

  // Auto-fill Step 1 (ব্যক্তিগত তথ্য) and Sections 3-9 safely with debounced MutationObserver
  function setupStepObserver() {
    function runExtensionAutomations() {
      if (document.hidden || activeMediaStream) return;
      if (lastExtractedData) {
        const tab1 = document.querySelector('[data-family-card-tab="1"]');
        const isTab1Visible = !tab1 || tab1.style.display !== 'none';
        const stepSig = `${scrapeFamilyId() || ''}_${lastExtractedData.nid_number || lastExtractedData.doc_number || ''}`;
        if (isTab1Visible && window.__fcStep1FilledKey !== stepSig) {
          const fatherInput = findInputByLabelText(['পিতার নাম (বাংলা)'], tab1) || findInputByLabelText(['পিতার নাম (বাংলা)']) || document.getElementById('input-1286');
          if (fatherInput && !fatherInput.value) {
            window.__fcStep1FilledKey = stepSig;
            fillFormFields(lastExtractedData);
            showToast('✅ পিতা-মাতা, বৈবাহিক অবস্থা ও ধর্ম অটো-ফিল করা হয়েছে!');
          }
        }
      }
      traceSection3Media();
      handleSection4Address();
      handleSection5AndCrossMatch();
      handleSection6Bank();
      handleSection7Eligibility();
      handleSection9MoneyUsage();
      updateSummaryBadge();
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
      const stepItem = e.target.closest('.family-card-form-step, .v-expansion-panel-header, .v-list-item');
      if (stepItem && lastExtractedData) {
        setTimeout(() => {
          runExtensionAutomations();
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
