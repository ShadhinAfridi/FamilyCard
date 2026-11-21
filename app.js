// Helper to normalize Bengali numerals (০-৯) to English (0-9)
function normalizeDigits(str) {
  if (!str) return '';
  const bn = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  return String(str).replace(/[০-৯]/g, d => {
    const idx = bn.indexOf(d);
    return idx !== -1 ? idx : d;
  });
}

// Client Application for Mobile NID Scanner
let socket = null;
let currentStream = null;
let currentMode = 'camera'; // 'camera' or 'gallery'
let selectedFileBase64 = null;

const elStatus = document.getElementById('connectionStatus');
const elRoomCode = document.getElementById('roomCode');
const elProvider = document.getElementById('aiProvider');
const elDefaultKeySlot = document.getElementById('defaultKeySlot');
const elGeminiModel = document.getElementById('geminiModel');
const elDeepSeekModel = document.getElementById('deepseekModel');
const elCostPreview = document.getElementById('aiCostPreview');
const elApiKey = document.getElementById('apiKey');
const elDeepSeekKey = document.getElementById('deepseekApiKey');
const elBtnSaveDefaults = document.getElementById('btnSaveDefaults');
const elSaveDefaultsMsg = document.getElementById('saveDefaultsMsg');
const btnConnect = document.getElementById('btnConnect');

const BDT_PER_USD = 122;
const MODEL_PRICING = {
  'gemini-3.1-flash-lite': { label: 'Gemini 3.1 Flash-Lite', inM: 0.25, outM: 1.50, est1k: 0.78, quota: '4K RPM / 150K RPD' },
  'gemini-3.5-flash-lite': { label: 'Gemini 3.5 Flash-Lite', inM: 0.30, outM: 2.50, est1k: 1.11, quota: '4K RPM / 150K RPD' },
  'gemini-3.8-flash': { label: 'Gemini 3.8 Flash', inM: 0.75, outM: 3.75, est1k: 2.53, quota: '1K RPM / 10K RPD' },
  'deepseek-flash': { label: 'DeepSeek Flash', offInM: 0.15, offOutM: 0.60, peakInM: 0.30, peakOutM: 1.20 }
};

function isDeepSeekPeakNow() {
  const d = new Date();
  const day = d.getUTCDay();
  if (day < 1 || day > 5) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

function getSavedCostStats() {
  try {
    return JSON.parse(localStorage.getItem('fc_ocr_cost_stats') || '{}');
  } catch (_) {
    return {};
  }
}

function recordScanCostUsage(usage) {
  if (!usage || typeof usage.costUsd !== 'number') return null;
  const stats = getSavedCostStats();
  stats.totalScans = Number(stats.totalScans || 0) + 1;
  stats.totalUsd = Number((Number(stats.totalUsd || 0) + usage.costUsd).toFixed(7));
  stats.totalTokens = Number(stats.totalTokens || 0) + Number(usage.totalTokens || 0);
  stats.lastUsage = usage;
  try { localStorage.setItem('fc_ocr_cost_stats', JSON.stringify(stats)); } catch (_) {}
  renderCostPreview();
  return stats;
}

function renderCostPreview() {
  if (!elCostPreview) return;
  const strategy = elProvider ? elProvider.value : 'economy';
  const keySlot = elDefaultKeySlot ? elDefaultKeySlot.value : 'auto';
  const gemModel = elGeminiModel ? elGeminiModel.value : 'gemini-3.1-flash-lite';
  const gemSpec = MODEL_PRICING[gemModel] || MODEL_PRICING['gemini-3.1-flash-lite'];
  const peak = isDeepSeekPeakNow();
  const ds1k = peak ? 0.76 : 0.38;
  const dsIn = peak ? 0.30 : 0.15;
  const dsOut = peak ? 1.20 : 0.60;
  const stats = getSavedCostStats();

  const useDsPrimary = strategy === 'deepseek' || (keySlot === 'deepseek' && (strategy === 'economy' || strategy === 'auto'));
  const activeTxt = useDsPrimary
    ? `<b>প্রাথমিক:</b> DeepSeek Flash (${peak ? '🟠 Peak' : '🟢 Off-Peak'}) • ~$${ds1k.toFixed(2)} (~৳${Math.round(ds1k * BDT_PER_USD)}) / ১,০০০ NID`
    : `<b>প্রাথমিক:</b> ${gemSpec.label} • ~$${gemSpec.est1k.toFixed(2)} (~৳${Math.round(gemSpec.est1k * BDT_PER_USD)}) / ১,০০০ NID (${gemSpec.quota})`;

  const rateTxt = `💵 রেট/1M: ${gemSpec.label} <b>$${gemSpec.inM}/$${gemSpec.outM}</b> • DeepSeek <b>$${dsIn}/$${dsOut}</b>`;
  const spentTxt = stats.totalScans > 0
    ? `<br>📊 সেশন মোট: <b>$${Number(stats.totalUsd || 0).toFixed(5)}</b> (~৳${(Number(stats.totalUsd || 0) * BDT_PER_USD).toFixed(2)}) | ${stats.totalScans} স্ক্যান`
    : '';
  elCostPreview.innerHTML = `${activeTxt}<br>${rateTxt}${spentTxt}`;
}

function saveAiPreferences(showNotice = false) {
  if (elProvider) localStorage.setItem('fc_ai_provider', elProvider.value);
  if (elDefaultKeySlot) localStorage.setItem('fc_default_key_slot', elDefaultKeySlot.value);
  if (elGeminiModel) localStorage.setItem('fc_gemini_model', elGeminiModel.value);
  if (elDeepSeekModel) localStorage.setItem('fc_deepseek_model', elDeepSeekModel.value);
  localStorage.setItem('fc_gemini_api_key', elApiKey.value.trim());
  if (elDeepSeekKey) localStorage.setItem('fc_deepseek_api_key', elDeepSeekKey.value.trim());
  renderCostPreview();
  if (showNotice && elSaveDefaultsMsg) {
    elSaveDefaultsMsg.textContent = '✅ ডিফল্ট API কী ও মডেল সেভ হয়েছে!';
    elSaveDefaultsMsg.style.display = 'block';
    setTimeout(() => { elSaveDefaultsMsg.style.display = 'none'; }, 2200);
  }
}

const tabCamera = document.getElementById('tabCamera');
const tabGallery = document.getElementById('tabGallery');
const cameraContainer = document.getElementById('cameraContainer');
const uploadContainer = document.getElementById('uploadContainer');

const videoElement = document.getElementById('videoElement');
const photoCanvas = document.getElementById('photoCanvas');
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const filePreview = document.getElementById('filePreview');
const filePreviewContainer = document.getElementById('filePreviewContainer');

const btnCapture = document.getElementById('btnCapture');
const loadingIndicator = document.getElementById('loadingIndicator');
const loadingMsg = document.getElementById('loadingMsg');

const resultCard = document.getElementById('resultCard');
const btnDismissResult = document.getElementById('btnDismissResult');

// Load saved room code, model defaults & API keys from localStorage
if (localStorage.getItem('fc_room_code')) {
  elRoomCode.value = localStorage.getItem('fc_room_code');
}
if (localStorage.getItem('fc_ai_provider') && elProvider) {
  elProvider.value = localStorage.getItem('fc_ai_provider');
}
if (localStorage.getItem('fc_default_key_slot') && elDefaultKeySlot) {
  elDefaultKeySlot.value = localStorage.getItem('fc_default_key_slot');
}
if (localStorage.getItem('fc_gemini_model') && elGeminiModel) {
  elGeminiModel.value = localStorage.getItem('fc_gemini_model');
}
if (localStorage.getItem('fc_deepseek_model') && elDeepSeekModel) {
  elDeepSeekModel.value = localStorage.getItem('fc_deepseek_model');
}
if (localStorage.getItem('fc_gemini_api_key')) {
  elApiKey.value = localStorage.getItem('fc_gemini_api_key');
}
if (localStorage.getItem('fc_deepseek_api_key') && elDeepSeekKey) {
  elDeepSeekKey.value = localStorage.getItem('fc_deepseek_api_key');
}
[elProvider, elDefaultKeySlot, elGeminiModel, elDeepSeekModel].forEach((el) => {
  if (el) el.addEventListener('change', () => saveAiPreferences(false));
});
if (elBtnSaveDefaults) {
  elBtnSaveDefaults.addEventListener('click', () => saveAiPreferences(true));
}
renderCostPreview();

// Initialize Socket.io connection
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    updateStatus(true);
    joinCurrentRoom();
  });

  socket.on('disconnect', () => {
    updateStatus(false);
  });

  socket.on('room-joined', (data) => {
    console.log('Joined room:', data.room);
  });

  socket.on('ocr-status', (payload) => {
    if (payload.status === 'processing') {
      showLoading(true, payload.message || 'Gemini AI দ্বারা NID বিশ্লেষণ করা হচ্ছে...');
    } else if (payload.status === 'completed') {
      showLoading(false);
      displayResults(payload.data);
    } else if (payload.status === 'error') {
      showLoading(false);
      alert('OCR ত্রুটি: ' + (payload.error || 'অজানা সমস্যা'));
    }
  });
}

function updateStatus(connected) {
  if (connected) {
    elStatus.className = 'status-pill status-connected';
    elStatus.querySelector('.label').textContent = 'সংযুক্ত';
  } else {
    elStatus.className = 'status-pill status-disconnected';
    elStatus.querySelector('.label').textContent = 'বিচ্ছিন্ন';
  }
}

function joinCurrentRoom() {
  const room = (elRoomCode.value || 'FC-101').trim().toUpperCase();
  localStorage.setItem('fc_room_code', room);
  if (socket && socket.connected) {
    socket.emit('join-room', room);
  }
}

btnConnect.addEventListener('click', () => {
  joinCurrentRoom();
  alert(`পিসির সাথে রুম [${elRoomCode.value.trim().toUpperCase()}] পেয়ার করা হয়েছে!`);
});

elApiKey.addEventListener('change', () => {
  localStorage.setItem('fc_gemini_api_key', elApiKey.value.trim());
});
if (elDeepSeekKey) {
  elDeepSeekKey.addEventListener('change', () => {
    localStorage.setItem('fc_deepseek_api_key', elDeepSeekKey.value.trim());
  });
}
if (elProvider) {
  elProvider.addEventListener('change', () => {
    localStorage.setItem('fc_ai_provider', elProvider.value);
  });
}

// Camera Stream Setup
async function startCamera() {
  try {
    if (currentStream) {
      currentStream.getTracks().forEach(t => t.stop());
    }

    const constraints = {
      video: {
        facingMode: { ideal: 'environment' }, // back camera on mobile
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    };

    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement.srcObject = currentStream;
  } catch (err) {
    console.warn('Camera error:', err);
    // Switch to gallery upload if camera is not accessible
    switchMode('gallery');
  }
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
}

function switchMode(mode) {
  currentMode = mode;
  if (mode === 'camera') {
    tabCamera.classList.add('active');
    tabGallery.classList.remove('active');
    cameraContainer.style.display = 'flex';
    uploadContainer.style.display = 'none';
    startCamera();
  } else {
    tabGallery.classList.add('active');
    tabCamera.classList.remove('active');
    cameraContainer.style.display = 'none';
    uploadContainer.style.display = 'block';
    stopCamera();
  }
}

tabCamera.addEventListener('click', () => switchMode('camera'));
tabGallery.addEventListener('click', () => switchMode('gallery'));

// Resize, enhance contrast & downscale image via Canvas for accurate Bengali OCR
function downscaleImage(imgOrVideo, maxDim = 1800, quality = 0.90) {
  const width = imgOrVideo.videoWidth || imgOrVideo.naturalWidth || imgOrVideo.width;
  const height = imgOrVideo.videoHeight || imgOrVideo.naturalHeight || imgOrVideo.height;

  let targetWidth = width;
  let targetHeight = height;

  if (targetWidth > maxDim || targetHeight > maxDim) {
    const ratio = Math.min(maxDim / targetWidth, maxDim / targetHeight);
    targetWidth = Math.round(targetWidth * ratio);
    targetHeight = Math.round(targetHeight * ratio);
  }

  photoCanvas.width = targetWidth;
  photoCanvas.height = targetHeight;
  const ctx = photoCanvas.getContext('2d');
  if ('filter' in ctx) {
    ctx.filter = 'contrast(1.08) brightness(1.03)';
  }
  ctx.drawImage(imgOrVideo, 0, 0, targetWidth, targetHeight);

  return photoCanvas.toDataURL('image/jpeg', quality);
}

// File picker / Gallery handling
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      selectedFileBase64 = downscaleImage(img, 1800, 0.90);
      filePreview.src = selectedFileBase64;
      filePreviewContainer.style.display = 'block';
      dropZone.style.display = 'none';
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
});

// Capture or Send Action
btnCapture.addEventListener('click', async () => {
  let base64Data = null;

  if (currentMode === 'camera') {
    if (!videoElement.videoWidth) {
      alert('ক্যামেরা চালু নেই। অনুগ্রহ করে পারমিশন দিন বা ফাইল মোড বেছে নিন।');
      return;
    }
    base64Data = downscaleImage(videoElement, 1800, 0.90);
  } else {
    if (!selectedFileBase64) {
      alert('অনুগ্রহ করে এনআইডি বা জন্ম নিবন্ধনের একটি ছবি নির্বাচন করুন।');
      return;
    }
    base64Data = selectedFileBase64;
  }

  showLoading(true, 'AI ডকুমেন্ট বিশ্লেষণ করা হচ্ছে (Gemini / DeepSeek)...');

  const room = (elRoomCode.value || 'FC-101').trim().toUpperCase();
  const apiKey = elApiKey.value.trim();
  const deepseekApiKey = elDeepSeekKey ? elDeepSeekKey.value.trim() : '';
  const aiProvider = elProvider ? elProvider.value : 'economy';
  const defaultKeySlot = elDefaultKeySlot ? elDefaultKeySlot.value : 'auto';
  const geminiModel = elGeminiModel ? elGeminiModel.value : 'gemini-3.1-flash-lite';
  const deepseekModel = elDeepSeekModel ? elDeepSeekModel.value : 'deepseek-flash';
  const docType = document.getElementById('docType')?.value || 'auto';
  const maritalStatus = document.getElementById('maritalStatus')?.value || 'বিবাহিত';
  const religion = document.getElementById('religion')?.value || 'ইসলাম';
  const mobileNumber = normalizeDigits(document.getElementById('mobileNumber')?.value?.trim() || '');

  saveAiPreferences(false);

  // Send over Socket.io
  if (socket && socket.connected) {
    socket.emit('scan-nid', {
      image: base64Data,
      room: room,
      apiKey: apiKey,
      deepseekApiKey: deepseekApiKey,
      aiProvider: aiProvider,
      defaultKeySlot: defaultKeySlot,
      geminiModel: geminiModel,
      deepseekModel: deepseekModel,
      docType: docType,
      maritalStatus: maritalStatus,
      religion: religion,
      mobileNumber: mobileNumber
    });
  } else {
    // Direct HTTP POST (local Express / Cloudflare Pages Edge OCR fallback)
    try {
      const payload = JSON.stringify({
        image: base64Data,
        room,
        apiKey,
        deepseekApiKey,
        aiProvider,
        defaultKeySlot,
        geminiModel,
        deepseekModel,
        docType,
        maritalStatus,
        religion,
        mobileNumber
      });
      let resp = await fetch('/api/ocr-nid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (resp.status === 404 || resp.status === 405 || !/application\/json/i.test(resp.headers.get('content-type') || '')) {
        resp = await fetch('https://familycard-10n.pages.dev/api/ocr-nid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload
        });
      }
      const data = await resp.json();
      showLoading(false);
      if (data.success) {
        displayResults(data.data);
      } else {
        alert('ত্রুটি: ' + data.error);
      }
    } catch (err) {
      showLoading(false);
      alert('সার্ভার যোগাযোগে ত্রুটি: ' + err.message);
    }
  }
});

function showLoading(show, message) {
  if (show) {
    loadingIndicator.style.display = 'flex';
    loadingMsg.textContent = message || 'প্রসেসিং হচ্ছে...';
    btnCapture.disabled = true;
  } else {
    loadingIndicator.style.display = 'none';
    btnCapture.disabled = false;
  }
}

function displayResults(data) {
  if (!data) return;
  resultCard.style.display = 'block';

  const resDocType = document.getElementById('resDocType');
  if (resDocType) {
    const label = data.doc_type === 'birth_certificate' ? 'ডিজিটাল জন্ম নিবন্ধন (BRC)' : 'জাতীয় পরিচয়পত্র (NID)';
    resDocType.textContent = data.ocr_model_used ? `${label} • ${data.ocr_model_used}` : label;
  }

  document.getElementById('resNameBn').textContent = data.name_bn || 'পাওয়া যায়নি';
  document.getElementById('resNameEn').textContent = data.name_en || 'পাওয়া যায়নি';
  let nidDisplay = data.doc_number || data.nid_number || data.birth_reg_no || 'পাওয়া যায়নি';
  if (data.nid_converted_to_17) {
    nidDisplay += ' (১৭ ডিজিট করা হয়েছে)';
  }
  document.getElementById('resNid').textContent = nidDisplay;
  document.getElementById('resDob').textContent = data.dob || 'পাওয়া যায়নি';
  document.getElementById('resGender').textContent = data.gender || 'পাওয়া যায়নি';
  document.getElementById('resFatherBn').textContent = data.father_name_bn || 'পাওয়া যায়নি';
  document.getElementById('resFatherEn').textContent = data.father_name_en || 'পাওয়া যায়নি';
  document.getElementById('resMotherBn').textContent = data.mother_name_bn || 'পাওয়া যায়নি';
  document.getElementById('resMotherEn').textContent = data.mother_name_en || 'পাওয়া যায়নি';

  const spouseRow = document.getElementById('resSpouseRow');
  const spouseBn = document.getElementById('resSpouseBn');
  if (spouseRow && spouseBn) {
    if (data.spouse_name_bn) {
      spouseBn.textContent = data.spouse_name_en ? `${data.spouse_name_bn} (${data.spouse_name_en})` : data.spouse_name_bn;
      spouseRow.style.display = 'flex';
    } else {
      spouseRow.style.display = 'none';
    }
  }

  const resCost = document.getElementById('resCost');
  if (data.ocr_usage) {
    const stats = recordScanCostUsage(data.ocr_usage);
    if (resCost) {
      const u = data.ocr_usage;
      const tot = stats ? ` | সেশন: $${Number(stats.totalUsd || 0).toFixed(5)}` : '';
      resCost.textContent = `$${Number(u.costUsd || 0).toFixed(5)} (~৳${Number(u.costBdt || 0).toFixed(3)}) • ${u.totalTokens || 0} tok${u.estimated ? ' (est)' : ''}${tot}`;
    }
  } else if (resCost) {
    resCost.textContent = data.ocr_model_used || 'Standard';
  }

  const resWarnings = document.getElementById('resWarnings');
  if (resWarnings) {
    if (Array.isArray(data.ocr_warnings) && data.ocr_warnings.length > 0) {
      resWarnings.textContent = '';
      data.ocr_warnings.forEach((w, idx) => {
        if (idx > 0) resWarnings.appendChild(document.createElement('br'));
        resWarnings.appendChild(document.createTextNode('⚠️ ' + w));
      });
      resWarnings.style.display = 'block';
    } else {
      resWarnings.style.display = 'none';
    }
  }

  // Smooth scroll into view
  resultCard.scrollIntoView({ behavior: 'smooth' });
}

btnDismissResult.addEventListener('click', () => {
  resultCard.style.display = 'none';
});

// Boot up
initSocket();
startCamera();
