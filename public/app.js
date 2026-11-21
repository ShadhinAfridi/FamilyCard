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
const elDeviceName = document.getElementById('deviceName');
const elBtnCopyRoomLink = document.getElementById('btnCopyRoomLink');
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

const elChatRoomLabel = document.getElementById('chatRoomLabel');
const elChatUnreadBadge = document.getElementById('chatUnreadBadge');
const elRoomChatFeed = document.getElementById('roomChatFeed');
const elChatMsgInput = document.getElementById('chatMsgInput');
const elBtnChatSend = document.getElementById('btnChatSend');
const elBtnChatRefresh = document.getElementById('btnChatRefresh');
const elBtnChatClear = document.getElementById('btnChatClear');
const elBtnChatShareLastNid = document.getElementById('btnChatShareLastNid');
const elBtnShareResultRoom = document.getElementById('btnShareResultRoom');
const elChatReplyBar = document.getElementById('chatReplyBar');
const elChatReplyText = document.getElementById('chatReplyText');
const elBtnChatCancelReply = document.getElementById('btnChatCancelReply');

const FIRESTORE_ROOMS_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/room_channels';
const EDGE_ROOM_API = 'https://familycard-10n.pages.dev/api/room-messages';
const MY_CLIENT_ID = localStorage.getItem('fc_client_id') || (() => {
  const id = 'web_' + Math.random().toString(36).slice(2, 10);
  localStorage.setItem('fc_client_id', id);
  return id;
})();

let lastExtractedNid = null;
const roomMsgMap = new Map();
let lastRoomMetaSig = '';
let lastClearedAtMs = 0;
let pendingReplyMsg = null;
let roomPollTimer = null;

function normalizeRoomCode(room) {
  const clean = String(room || 'FC-101').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
  return clean || 'FC-101';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDeviceName() {
  return (elDeviceName && elDeviceName.value.trim()) || localStorage.getItem('fc_device_name') || 'মোবাইল-স্ক্যানার';
}

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

// Load saved room code (with ?room= URL override), device name, model defaults & API keys
try {
  const urlRoom = new URLSearchParams(window.location.search).get('room');
  if (urlRoom) {
    const cleanUrlRoom = normalizeRoomCode(urlRoom);
    elRoomCode.value = cleanUrlRoom;
    localStorage.setItem('fc_room_code', cleanUrlRoom);
  } else if (localStorage.getItem('fc_room_code')) {
    elRoomCode.value = normalizeRoomCode(localStorage.getItem('fc_room_code'));
  }
} catch (_) {
  if (localStorage.getItem('fc_room_code')) elRoomCode.value = localStorage.getItem('fc_room_code');
}
if (elDeviceName) {
  elDeviceName.value = localStorage.getItem('fc_device_name') || 'মোবাইল-স্ক্যানার';
  elDeviceName.addEventListener('change', () => {
    localStorage.setItem('fc_device_name', elDeviceName.value.trim() || 'মোবাইল-স্ক্যানার');
  });
}
if (elChatRoomLabel) elChatRoomLabel.textContent = normalizeRoomCode(elRoomCode.value);
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

function renderRoomChat() {
  if (!elRoomChatFeed) return;
  const msgs = Array.from(roomMsgMap.values()).filter(m => m.ts > lastClearedAtMs).sort((a, b) => a.ts - b.ts);
  if (msgs.length === 0) {
    elRoomChatFeed.innerHTML = '<div style="text-align:center; color:#64748b; font-size:0.8rem; padding:18px 8px;">এখনো কোনো মেসেজ নেই। নিচে লিখে বা NID স্ক্যান শেয়ার করুন!</div>';
    return;
  }
  elRoomChatFeed.innerHTML = msgs.map((m) => {
    const isMine = m.senderId === MY_CLIENT_ID;
    const cls = m.type === 'nid_data' ? 'nid' : (m.type === 'summary' ? 'summary' : (isMine ? 'mine' : ''));
    const timeStr = new Date(m.ts).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' });
    let bodyHtml = '';
    if (m.replyTo && m.replyTo.preview) {
      bodyHtml += `<div style="font-size:0.73rem; color:#4338ca; background:#eef2ff; padding:3px 6px; border-left:2px solid #4f46e5; border-radius:4px; margin-bottom:4px;">↩️ <b>${escapeHtml(m.replyTo.senderName || '')}:</b> ${escapeHtml(m.replyTo.preview)}</div>`;
    }
    if (m.type === 'nid_data' && m.payload) {
      const p = m.payload;
      bodyHtml += `
        <div style="font-weight:700; color:#0f766e;">🪪 ${escapeHtml(p.name_bn || p.name_en || 'NID/BRC কার্ড')}</div>
        <div style="font-size:0.78rem; color:#334155;">নম্বর: <b>${escapeHtml(p.doc_number || p.nid_number || p.birth_reg_no || '-')}</b> • জন্ম: ${escapeHtml(p.dob || '-')}${p.mobile_number ? ` • 📱 ${escapeHtml(p.mobile_number)}` : ''}</div>
      `;
    } else if (m.type === 'summary' && m.payload) {
      const s = m.payload;
      bodyHtml += `<div style="font-weight:700; color:#1e40af;">📊 সারসংক্ষেপ (${escapeHtml(s.familyId || '-')}) • প্রস্তুতি ${escapeHtml(String(s.readinessPct ?? '-'))}%</div><div style="font-size:0.78rem; white-space:pre-wrap; margin-top:2px;">${escapeHtml(m.text)}</div>`;
    } else {
      bodyHtml += `<div style="white-space:pre-wrap;">${escapeHtml(m.text)}</div>`;
    }
    const actionBtns = [];
    if (m.type === 'nid_data' && m.payload) {
      actionBtns.push(`<button type="button" class="chat-chip-btn primary" data-act="preview" data-mid="${escapeHtml(m.id)}">👁️ দেখুন</button>`);
    }
    actionBtns.push(`<button type="button" class="chat-chip-btn" data-act="copy" data-mid="${escapeHtml(m.id)}">📋 কপি</button>`);
    actionBtns.push(`<button type="button" class="chat-chip-btn" data-act="reply" data-mid="${escapeHtml(m.id)}">↩️</button>`);
    return `
      <div class="chat-bubble ${cls}">
        <div class="chat-meta">
          <b>${isMine ? 'আমি' : escapeHtml(m.senderName || 'ডিভাইস')} (${escapeHtml(m.senderClient || '')})</b>
          <span>${escapeHtml(timeStr)}</span>
        </div>
        ${bodyHtml}
        <div class="chat-actions">${actionBtns.join('')}</div>
      </div>
    `;
  }).join('');
  elRoomChatFeed.scrollTop = elRoomChatFeed.scrollHeight;
}

function handleIncomingRoomMessage(rawMsg) {
  if (!rawMsg || !rawMsg.id) return;
  const ts = Number(rawMsg.ts || 0);
  if (ts <= lastClearedAtMs) return;
  const existed = roomMsgMap.has(rawMsg.id);
  roomMsgMap.set(rawMsg.id, rawMsg);
  if (!existed) {
    renderRoomChat();
    if (rawMsg.senderId !== MY_CLIENT_ID && elChatUnreadBadge) {
      const cur = Number(elChatUnreadBadge.dataset.count || 0) + 1;
      elChatUnreadBadge.dataset.count = String(cur);
      elChatUnreadBadge.textContent = String(cur);
      elChatUnreadBadge.style.display = 'inline-block';
      setTimeout(() => {
        elChatUnreadBadge.dataset.count = '0';
        elChatUnreadBadge.style.display = 'none';
      }, 6000);
    }
  }
}

async function fetchCloudRoomMessages(forceFull = false) {
  if (document.hidden) return;
  const room = normalizeRoomCode(elRoomCode.value);
  try {
    const metaRes = await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}?t=${Date.now()}`);
    if (metaRes.ok) {
      const metaJson = await metaRes.json().catch(() => ({}));
      const mf = metaJson?.fields || {};
      const clearedAt = Number(mf.cleared_at_ms?.integerValue || 0);
      const lastId = mf.last_msg_id?.stringValue || '';
      const sig = `${room}|${lastId}|${clearedAt}`;
      if (clearedAt > lastClearedAtMs) {
        lastClearedAtMs = clearedAt;
        for (const [k, v] of roomMsgMap.entries()) {
          if (v.ts <= lastClearedAtMs) roomMsgMap.delete(k);
        }
        renderRoomChat();
      }
      if (!forceFull && sig === lastRoomMetaSig) return;
      lastRoomMetaSig = sig;
      const listRes = await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}/messages?pageSize=60`);
      if (listRes.ok) {
        const lj = await listRes.json().catch(() => ({}));
        const docs = Array.isArray(lj.documents) ? lj.documents : [];
        let changed = false;
        docs.forEach((d) => {
          const f = d.fields || {};
          const msgTs = Number(f.ts?.integerValue || f.ts?.doubleValue || 0);
          if (msgTs <= lastClearedAtMs) return;
          const id = f.id?.stringValue || d.name?.split('/').pop();
          if (!id || roomMsgMap.has(id)) return;
          let payload = null;
          try { if (f.payloadJson?.stringValue) payload = JSON.parse(f.payloadJson.stringValue); } catch (_) {}
          let replyTo = null;
          try { if (f.replyToJson?.stringValue) replyTo = JSON.parse(f.replyToJson.stringValue); } catch (_) {}
          roomMsgMap.set(id, {
            id,
            room,
            type: f.type?.stringValue || 'text',
            text: f.text?.stringValue || '',
            payload,
            replyTo,
            senderName: f.senderName?.stringValue || 'ডিভাইস',
            senderClient: f.senderClient?.stringValue || '',
            senderId: f.senderId?.stringValue || '',
            ts: msgTs
          });
          changed = true;
        });
        if (changed) renderRoomChat();
        updateStatus(true, socket && socket.connected ? 'সার্ভার + ক্লাউড' : 'ক্লাউড রুম সক্রিয়');
        return;
      }
    }
  } catch (_) {}
  try {
    const er = await fetch(`${EDGE_ROOM_API}?room=${encodeURIComponent(room)}&t=${Date.now()}`);
    if (er.ok) {
      const ej = await er.json();
      if (ej && Array.isArray(ej.messages)) {
        ej.messages.forEach(handleIncomingRoomMessage);
        updateStatus(true, 'এজ রুম সক্রিয়');
      }
    }
  } catch (_) {}
}

async function sendRoomMessage({ type = 'text', text = '', payload = null } = {}) {
  const room = normalizeRoomCode(elRoomCode.value);
  const ts = Date.now();
  const id = `m_${String(ts).padStart(14, '0')}_${Math.random().toString(36).slice(2, 7)}`;
  const msg = {
    id,
    room,
    type,
    text: String(text || '').trim(),
    payload,
    senderName: getDeviceName(),
    senderClient: 'companion',
    senderId: MY_CLIENT_ID,
    replyTo: pendingReplyMsg,
    ts,
    createdAt: new Date(ts).toISOString()
  };
  pendingReplyMsg = null;
  if (elChatReplyBar) elChatReplyBar.style.display = 'none';
  handleIncomingRoomMessage(msg);

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
    const r1 = await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(msg.room)}/messages/${encodeURIComponent(msg.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    const preview = (msg.text || (msg.payload?.name_bn || msg.payload?.doc_number || 'ডেটা')).slice(0, 120);
    const metaFields = {
      room: { stringValue: msg.room },
      last_msg_id: { stringValue: msg.id },
      last_sender: { stringValue: msg.senderName },
      last_preview: { stringValue: preview },
      updated_at: { timestampValue: new Date().toISOString() }
    };
    const mask = Object.keys(metaFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(msg.room)}?${mask}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: metaFields })
    });
    if (r1.ok) return true;
  } catch (_) {}

  await fetch(EDGE_ROOM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg)
  }).catch(() => {});
  return true;
}

// Initialize Socket.io connection when running under local Express relay (graceful no-op on HTTPS static CDNs)
function initSocket() {
  if (typeof io === 'undefined') {
    updateStatus(true, 'ক্লাউড রুম সক্রিয়');
    return;
  }
  try {
    socket = io();

    socket.on('connect', () => {
      updateStatus(true, 'সার্ভার + ক্লাউড');
      joinCurrentRoom();
    });

    socket.on('disconnect', () => {
      updateStatus(true, 'ক্লাউড রুম সক্রিয়');
    });

    socket.on('room-joined', (data) => {
      if (data && Array.isArray(data.history)) {
        data.history.forEach(handleIncomingRoomMessage);
      }
    });

    socket.on('room-message', (msg) => {
      handleIncomingRoomMessage(msg);
    });

    socket.on('room-cleared', (info) => {
      lastClearedAtMs = Number(info?.ts || Date.now());
      roomMsgMap.clear();
      renderRoomChat();
    });

    socket.on('ocr-status', (payload) => {
      if (payload.status === 'processing') {
        showLoading(true, payload.message || 'AI ডকুমেন্ট বিশ্লেষণ করা হচ্ছে...');
      } else if (payload.status === 'completed') {
        showLoading(false);
        displayResults(payload.data);
      } else if (payload.status === 'error') {
        showLoading(false);
        alert('OCR ত্রুটি: ' + (payload.error || 'অজানা সমস্যা'));
      }
    });
  } catch (_) {
    updateStatus(true, 'ক্লাউড রুম সক্রিয়');
  }
}

function updateStatus(connected, labelText) {
  if (connected) {
    elStatus.className = 'status-pill status-connected';
    elStatus.querySelector('.label').textContent = labelText || 'সংযুক্ত';
  } else {
    elStatus.className = 'status-pill status-disconnected';
    elStatus.querySelector('.label').textContent = labelText || 'বিচ্ছিন্ন';
  }
}

function joinCurrentRoom() {
  const room = normalizeRoomCode(elRoomCode.value);
  elRoomCode.value = room;
  localStorage.setItem('fc_room_code', room);
  if (elChatRoomLabel) elChatRoomLabel.textContent = room;
  roomMsgMap.clear();
  lastRoomMetaSig = '';
  lastClearedAtMs = 0;
  renderRoomChat();
  if (socket && socket.connected) {
    socket.emit('join-room', { room, clientName: getDeviceName(), clientType: 'companion' });
  }
  fetchCloudRoomMessages(true);
}

btnConnect.addEventListener('click', () => {
  joinCurrentRoom();
});

if (elBtnCopyRoomLink) {
  elBtnCopyRoomLink.addEventListener('click', async () => {
    const room = normalizeRoomCode(elRoomCode.value);
    const url = `${window.location.origin}/?room=${encodeURIComponent(room)}`;
    try {
      await navigator.clipboard.writeText(url);
      elBtnCopyRoomLink.textContent = '✅ লিংক কপি হয়েছে!';
    } catch (_) {
      prompt('এই রুম লিংকটি কপি করুন:', url);
    }
    setTimeout(() => { elBtnCopyRoomLink.textContent = '📋 রুম লিংক কপি'; }, 1800);
  });
}

if (elBtnChatSend && elChatMsgInput) {
  const submitMsg = () => {
    const val = elChatMsgInput.value.trim();
    if (!val) return;
    elChatMsgInput.value = '';
    sendRoomMessage({ type: 'text', text: val });
  };
  elBtnChatSend.addEventListener('click', submitMsg);
  elChatMsgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitMsg(); }
  });
}
if (elBtnChatRefresh) elBtnChatRefresh.addEventListener('click', () => fetchCloudRoomMessages(true));
if (elBtnChatClear) {
  elBtnChatClear.addEventListener('click', async () => {
    const room = normalizeRoomCode(elRoomCode.value);
    if (!confirm(`রুম "${room}"-এর সব মেসেজ মুছে ফেলবেন?`)) return;
    lastClearedAtMs = Date.now();
    roomMsgMap.clear();
    renderRoomChat();
    if (socket && socket.connected) socket.emit('clear-room-messages', { room });
    await fetch(`${EDGE_ROOM_API}?room=${encodeURIComponent(room)}`, { method: 'DELETE' }).catch(() => {});
  });
}
if (elBtnChatCancelReply) {
  elBtnChatCancelReply.addEventListener('click', () => {
    pendingReplyMsg = null;
    if (elChatReplyBar) elChatReplyBar.style.display = 'none';
  });
}
if (elBtnChatShareLastNid) {
  elBtnChatShareLastNid.addEventListener('click', () => {
    if (!lastExtractedNid) {
      alert('আগে একটি NID / জন্ম নিবন্ধন স্ক্যান করুন।');
      return;
    }
    sendRoomMessage({
      type: 'nid_data',
      text: `🪪 ${lastExtractedNid.name_bn || lastExtractedNid.name_en || ''} (${lastExtractedNid.doc_number || lastExtractedNid.nid_number || ''})`,
      payload: lastExtractedNid
    });
  });
}
if (elBtnShareResultRoom) {
  elBtnShareResultRoom.addEventListener('click', () => {
    if (!lastExtractedNid) return;
    sendRoomMessage({
      type: 'nid_data',
      text: `🪪 ${lastExtractedNid.name_bn || lastExtractedNid.name_en || ''} (${lastExtractedNid.doc_number || lastExtractedNid.nid_number || ''})`,
      payload: lastExtractedNid
    });
    elBtnShareResultRoom.textContent = '✅ শেয়ার হয়েছে!';
    setTimeout(() => { elBtnShareResultRoom.textContent = '💬 রুমে শেয়ার'; }, 1600);
  });
}
document.querySelectorAll('[data-quick-msg]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const txt = btn.getAttribute('data-quick-msg');
    if (txt) sendRoomMessage({ type: 'text', text: txt });
  });
});
if (elRoomChatFeed) {
  elRoomChatFeed.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const mid = btn.getAttribute('data-mid');
    const act = btn.getAttribute('data-act');
    const msg = roomMsgMap.get(mid);
    if (!msg) return;
    if (act === 'preview' && msg.payload) {
      displayResults(msg.payload);
    } else if (act === 'reply') {
      pendingReplyMsg = {
        id: msg.id,
        senderName: msg.senderName || 'ডিভাইস',
        preview: (msg.text || msg.payload?.name_bn || 'ডেটা').slice(0, 80)
      };
      if (elChatReplyText) elChatReplyText.textContent = `↩️ ${pendingReplyMsg.senderName}: ${pendingReplyMsg.preview}`;
      if (elChatReplyBar) elChatReplyBar.style.display = 'flex';
      if (elChatMsgInput) elChatMsgInput.focus();
    } else if (act === 'copy') {
      const txt = msg.type === 'nid_data' && msg.payload
        ? `${msg.payload.name_bn || ''}\n${msg.payload.name_en || ''}\nNID/BRC: ${msg.payload.doc_number || msg.payload.nid_number || ''}\nDOB: ${msg.payload.dob || ''}`
        : (msg.text || '');
      try {
        await navigator.clipboard.writeText(txt);
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = '📋 কপি'; }, 1200);
      } catch (_) {}
    }
  });
}

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
      senderName: getDeviceName(),
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
        sendRoomMessage({
          type: 'nid_data',
          text: `🪪 স্ক্যান: ${data.data.name_bn || data.data.name_en || ''} (${data.data.doc_number || data.data.nid_number || data.data.birth_reg_no || ''})`,
          payload: data.data
        });
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
  lastExtractedNid = data;
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
fetchCloudRoomMessages(true);
roomPollTimer = setInterval(() => fetchCloudRoomMessages(false), 3000);
startCamera();
