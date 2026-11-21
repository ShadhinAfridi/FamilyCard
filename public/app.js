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
const elChatPeersPill = document.getElementById('chatPeersPill');
const elRoomPeersStatus = document.getElementById('roomPeersStatus');
const elBtnJumpChat = document.getElementById('btnJumpChat');
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
const MY_CLIENT_ID = (() => {
  const saved = String(localStorage.getItem('fc_client_id') || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);
  if (saved && saved.startsWith('web_')) {
    if (saved !== localStorage.getItem('fc_client_id')) localStorage.setItem('fc_client_id', saved);
    return saved;
  }
  const id = 'web_' + Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 8).padEnd(6, '0');
  localStorage.setItem('fc_client_id', id);
  return id;
})();

let lastExtractedNid = null;
const roomMsgMap = new Map();
let lastRoomMetaSig = '';
let lastClearedAtMs = 0;
let roomBootstrapped = false;
let roomJoinDebounce = null;
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
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const MODEL_PRICING = {
  'gemini-3.5-flash-lite': { label: 'Gemini 3.5 Flash-Lite', inM: 0.30, outM: 2.50, est1k: 1.11, quota: '4K RPM / 150K RPD' },
  'gemini-3.8-flash': { label: 'Gemini 3.8 Flash', inM: 0.75, outM: 3.75, est1k: 2.53, quota: '1K RPM / 10K RPD' },
  'gemini-4-argon': { label: 'Gemini 4 Argon', inM: 2.00, outM: 10.00, est1k: 6.50, quota: '500 RPM / 5K RPD' },
  'gemini-3.1-flash-lite': { label: 'Gemini 3.1 Flash-Lite', inM: 0.25, outM: 1.50, est1k: 0.78, quota: '4K RPM / 150K RPD' },
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
  const gemModel = elGeminiModel ? elGeminiModel.value : DEFAULT_GEMINI_MODEL;
  const gemSpec = MODEL_PRICING[gemModel] || MODEL_PRICING[DEFAULT_GEMINI_MODEL];
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
if (!localStorage.getItem('fc_model_default_v2')) {
  const prevGem = localStorage.getItem('fc_gemini_model');
  if (!prevGem || prevGem === 'gemini-3.1-flash-lite') {
    localStorage.setItem('fc_gemini_model', DEFAULT_GEMINI_MODEL);
  }
  localStorage.setItem('fc_model_default_v2', '1');
}
const savedGemModel = localStorage.getItem('fc_gemini_model');
if (elGeminiModel) {
  elGeminiModel.value = (savedGemModel && MODEL_PRICING[savedGemModel]) ? savedGemModel : DEFAULT_GEMINI_MODEL;
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

function renderPeersStatus(peers = [], roomCode = normalizeRoomCode(elRoomCode.value)) {
  const list = Array.isArray(peers) ? peers : [];
  const hasSelf = list.some(p => p.id === MY_CLIENT_ID);
  const totalCount = hasSelf ? list.length : (list.length + 1);
  const others = list.filter(p => p.id !== MY_CLIENT_ID);

  if (others.length > 0) {
    const summaryNames = others.slice(0, 3).map((p) => {
      const tag = p.client === 'bookmarklet' ? 'বুকমার্কলেট' : (p.client === 'extension' ? 'এক্সটেনশন' : (p.client || 'ওয়েব'));
      return `${p.name || 'ডিভাইস'} (${tag})`;
    }).join(', ');
    const more = others.length > 3 ? ` +${others.length - 3}` : '';
    if (elRoomPeersStatus) {
      elRoomPeersStatus.style.background = '#ecfdf5';
      elRoomPeersStatus.style.borderColor = '#6ee7b7';
      elRoomPeersStatus.style.color = '#065f46';
      elRoomPeersStatus.textContent = `🟢 রুম ${roomCode}: ${totalCount}টি ডিভাইস যুক্ত — ${summaryNames}${more}`;
    }
    if (elChatPeersPill) {
      elChatPeersPill.style.background = '#dcfce7';
      elChatPeersPill.style.color = '#166534';
      elChatPeersPill.textContent = `🟢 ${totalCount} অনলাইন`;
    }
    updateStatus(true, socket && socket.connected ? `সার্ভার + রুম (${totalCount})` : `রুম সক্রিয় (${totalCount} ডিভাইস)`);
  } else {
    if (elRoomPeersStatus) {
      elRoomPeersStatus.style.background = '#fffbeb';
      elRoomPeersStatus.style.borderColor = '#fde68a';
      elRoomPeersStatus.style.color = '#92400e';
      elRoomPeersStatus.textContent = `🟡 রুম ${roomCode}-এ আপনি যুক্ত আছেন — বুকমার্কলেট/অন্য ব্রাউজারে একই রুম কোড লিখুন।`;
    }
    if (elChatPeersPill) {
      elChatPeersPill.style.background = '#fef3c7';
      elChatPeersPill.style.color = '#92400e';
      elChatPeersPill.textContent = '🟡 ১ অনলাইন';
    }
    updateStatus(true, socket && socket.connected ? 'সার্ভার + ক্লাউড' : `ক্লাউড রুম: ${roomCode}`);
  }
}

async function applyCloudMetaAndMaybeFetchMessages({ targetRoom, mf = null, metaObj = null, peers = null, forceFull = false, source = 'edge' }) {
  const clearedAt = Number(metaObj?.cleared_at_ms ?? mf?.cleared_at_ms?.integerValue ?? 0);
  const lastId = String(metaObj?.last_msg_id ?? mf?.last_msg_id?.stringValue ?? '');
  const sig = `${targetRoom}|${lastId}|${clearedAt}`;
  if (clearedAt > lastClearedAtMs) {
    lastClearedAtMs = clearedAt;
    for (const [k, v] of roomMsgMap.entries()) {
      if (v.ts <= lastClearedAtMs) roomMsgMap.delete(k);
    }
    renderRoomChat();
  }
  const activePeers = Array.isArray(peers) ? peers : (mf ? extractActivePeersFromFields(mf, Date.now()) : []);
  renderPeersStatus(activePeers, targetRoom);

  const needMessages = forceFull || !roomBootstrapped || sig !== lastRoomMetaSig;
  if (!needMessages) return true;

  if (source === 'edge' && roomBootstrapped && !forceFull) {
    const fullRes = await fetch(
      `${EDGE_ROOM_API}?room=${encodeURIComponent(targetRoom)}&metaOnly=0&t=${Date.now()}`,
      { cache: 'no-store' }
    );
    if (normalizeRoomCode(elRoomCode.value) !== targetRoom) return true;
    if (fullRes.ok) {
      const fullJson = await fullRes.json().catch(() => ({}));
      if (Array.isArray(fullJson.messages)) {
        fullJson.messages.forEach(handleIncomingRoomMessage);
      }
      if (Array.isArray(fullJson.peers)) {
        renderPeersStatus(fullJson.peers, targetRoom);
      }
      lastRoomMetaSig = sig;
      roomBootstrapped = true;
      return true;
    }
  }
  return false;
}

async function fetchCloudRoomMessages(forceFull = false) {
  if (document.hidden && !forceFull) return;
  const targetRoom = normalizeRoomCode(elRoomCode.value);
  const peerName = getDeviceName();
  const useMetaOnly = roomBootstrapped && !forceFull;

  // 1. Primary: Cloudflare Edge API (zero 404s on brand-new rooms + atomic peer heartbeat)
  try {
    const edgeUrl = `${EDGE_ROOM_API}?room=${encodeURIComponent(targetRoom)}&metaOnly=${useMetaOnly ? '1' : '0'}&peerId=${encodeURIComponent(MY_CLIENT_ID)}&peerName=${encodeURIComponent(peerName)}&peerClient=companion&t=${Date.now()}`;
    const er = await fetch(edgeUrl, { cache: 'no-store' });
    if (normalizeRoomCode(elRoomCode.value) !== targetRoom) return;
    if (er.ok) {
      const ej = await er.json().catch(() => ({}));
      if (ej && ej.success) {
        if (!useMetaOnly && Array.isArray(ej.messages)) {
          ej.messages.forEach(handleIncomingRoomMessage);
          roomBootstrapped = true;
          const mCleared = Number(ej.meta?.cleared_at_ms || 0);
          const mLast = String(ej.meta?.last_msg_id || '');
          lastRoomMetaSig = `${targetRoom}|${mLast}|${mCleared}`;
          if (mCleared > lastClearedAtMs) {
            lastClearedAtMs = mCleared;
            for (const [k, v] of roomMsgMap.entries()) {
              if (v.ts <= lastClearedAtMs) roomMsgMap.delete(k);
            }
            renderRoomChat();
          }
          renderPeersStatus(ej.peers || [], targetRoom);
          return;
        }
        const handled = await applyCloudMetaAndMaybeFetchMessages({
          targetRoom,
          metaObj: ej.meta || {},
          peers: ej.peers || [],
          forceFull,
          source: 'edge'
        });
        if (handled) return;
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
            [MY_CLIENT_ID]: {
              mapValue: {
                fields: {
                  name: { stringValue: peerName.slice(0, 50) },
                  client: { stringValue: 'companion' },
                  seenAt: { integerValue: String(nowMs) }
                }
              }
            }
          }
        }
      }
    };
    const metaRes = await fetch(
      `${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(targetRoom)}?updateMask.fieldPaths=room&updateMask.fieldPaths=peers.${encodeURIComponent(MY_CLIENT_ID)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: peerFields }),
        cache: 'no-store'
      }
    );
    if (normalizeRoomCode(elRoomCode.value) !== targetRoom) return;
    if (metaRes.ok) {
      const metaJson = await metaRes.json().catch(() => ({}));
      const mf = metaJson?.fields || {};
      const clearedAt = Number(mf.cleared_at_ms?.integerValue || 0);
      const lastId = mf.last_msg_id?.stringValue || '';
      const sig = `${targetRoom}|${lastId}|${clearedAt}`;
      if (clearedAt > lastClearedAtMs) {
        lastClearedAtMs = clearedAt;
        for (const [k, v] of roomMsgMap.entries()) {
          if (v.ts <= lastClearedAtMs) roomMsgMap.delete(k);
        }
        renderRoomChat();
      }
      renderPeersStatus(extractActivePeersFromFields(mf, nowMs), targetRoom);
      if (!forceFull && roomBootstrapped && sig === lastRoomMetaSig) return;
      lastRoomMetaSig = sig;
      const listRes = await fetch(
        `${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(targetRoom)}/messages?pageSize=100&t=${Date.now()}`,
        { cache: 'no-store' }
      );
      if (normalizeRoomCode(elRoomCode.value) !== targetRoom) return;
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
            room: targetRoom,
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
        roomBootstrapped = true;
        if (changed) renderRoomChat();
        return;
      }
    }
  } catch (_) {}

  if (elRoomPeersStatus) {
    elRoomPeersStatus.style.background = '#fef2f2';
    elRoomPeersStatus.style.borderColor = '#fecaca';
    elRoomPeersStatus.style.color = '#991b1b';
    elRoomPeersStatus.textContent = '⚠️ ক্লাউড রুমে সংযোগ করা যাচ্ছে না — ইন্টারনেট সংযোগ দেখুন।';
  }
  updateStatus(false, 'সংযোগ বিচ্ছিন্ন');
}

async function sendRoomMessage({ type = 'text', text = '', payload = null } = {}) {
  const room = normalizeRoomCode(elRoomCode.value);
  const ts = Date.now();
  const id = `m_${String(ts).padStart(14, '0')}_${Math.random().toString(36).slice(2, 7)}`;
  const deviceName = getDeviceName();
  const msg = {
    id,
    room,
    type,
    text: String(text || '').trim(),
    payload,
    senderName: deviceName,
    senderClient: 'companion',
    senderId: MY_CLIENT_ID,
    peerId: MY_CLIENT_ID,
    peerName: deviceName,
    peerClient: 'companion',
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

  let delivered = false;
  try {
    const er = await fetch(EDGE_ROOM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
      cache: 'no-store'
    });
    if (er.ok) {
      const ej = await er.json().catch(() => ({}));
      if (ej && ej.success) {
        delivered = true;
        lastRoomMetaSig = `${room}|${msg.id}|${lastClearedAtMs}`;
        roomBootstrapped = true;
        if (Array.isArray(ej.peers)) renderPeersStatus(ej.peers, room);
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
      const r1 = await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(msg.room)}/messages/${encodeURIComponent(msg.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
        cache: 'no-store'
      });
      if (r1.ok) {
        delivered = true;
        const preview = (msg.text || (msg.payload?.name_bn || msg.payload?.doc_number || 'ডেটা')).slice(0, 120);
        const metaFields = {
          room: { stringValue: msg.room },
          last_msg_id: { stringValue: msg.id },
          last_sender: { stringValue: msg.senderName },
          last_preview: { stringValue: preview },
          updated_at: { timestampValue: new Date().toISOString() },
          peers: {
            mapValue: {
              fields: {
                [MY_CLIENT_ID]: {
                  mapValue: {
                    fields: {
                      name: { stringValue: deviceName.slice(0, 50) },
                      client: { stringValue: 'companion' },
                      seenAt: { integerValue: String(ts) }
                    }
                  }
                }
              }
            }
          }
        };
        const mask = ['room', 'last_msg_id', 'last_sender', 'last_preview', 'updated_at', `peers.${MY_CLIENT_ID}`]
          .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
        await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(msg.room)}?${mask}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: metaFields }),
          cache: 'no-store'
        }).catch(() => {});
        lastRoomMetaSig = `${room}|${msg.id}|${lastClearedAtMs}`;
        roomBootstrapped = true;
      }
    } catch (_) {}
  }

  if (!delivered) {
    alert('❌ মেসেজটি ক্লাউড রুমে পাঠানো যায়নি! আপনার ইন্টারনেট বা রুম কোড পরীক্ষা করে আবার চেষ্টা করুন।');
  }
  return delivered;
}

// Initialize Socket.io connection ONLY when running under local Express relay (no 404 on static CDNs)
function initSocket() {
  const host = window.location.hostname;
  const isLocalRelay = host === 'localhost' || host === '127.0.0.1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (!isLocalRelay) {
    updateStatus(true, 'ক্লাউড রুম সক্রিয়');
    return;
  }
  if (typeof io === 'undefined') {
    const s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.onload = () => initSocket();
    s.onerror = () => updateStatus(true, 'ক্লাউড রুম সক্রিয়');
    document.head.appendChild(s);
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

function joinCurrentRoom(showToast = false) {
  const room = normalizeRoomCode(elRoomCode.value);
  elRoomCode.value = room;
  localStorage.setItem('fc_room_code', room);
  if (elChatRoomLabel) elChatRoomLabel.textContent = room;
  roomMsgMap.clear();
  lastRoomMetaSig = '';
  lastClearedAtMs = 0;
  roomBootstrapped = false;
  renderRoomChat();
  if (elRoomPeersStatus) {
    elRoomPeersStatus.style.background = '#eff6ff';
    elRoomPeersStatus.style.borderColor = '#bfdbfe';
    elRoomPeersStatus.style.color = '#1e40af';
    elRoomPeersStatus.textContent = `⏳ রুম ${room}-এ যুক্ত হচ্ছে...`;
  }
  if (socket && socket.connected) {
    socket.emit('join-room', { room, clientName: getDeviceName(), clientType: 'companion' });
  }
  fetchCloudRoomMessages(true);
  if (showToast && btnConnect) {
    btnConnect.textContent = `✅ সংযুক্ত (${room})`;
    setTimeout(() => { btnConnect.textContent = '🔗 রুম কানেক্ট করুন'; }, 1800);
  }
}

btnConnect.addEventListener('click', () => {
  joinCurrentRoom(true);
});

if (elRoomCode) {
  elRoomCode.addEventListener('input', () => {
    clearTimeout(roomJoinDebounce);
    roomJoinDebounce = setTimeout(() => {
      const next = normalizeRoomCode(elRoomCode.value);
      if (next !== localStorage.getItem('fc_room_code')) {
        joinCurrentRoom(false);
      }
    }, 550);
  });
  elRoomCode.addEventListener('change', () => {
    clearTimeout(roomJoinDebounce);
    joinCurrentRoom(false);
  });
}

if (elBtnJumpChat) {
  elBtnJumpChat.addEventListener('click', () => {
    const card = document.getElementById('roomChatCard');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

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
    const clearedAt = Date.now();
    lastClearedAtMs = clearedAt;
    roomMsgMap.clear();
    renderRoomChat();
    if (socket && socket.connected) socket.emit('clear-room-messages', { room });
    const delRes = await fetch(`${EDGE_ROOM_API}?room=${encodeURIComponent(room)}`, { method: 'DELETE', cache: 'no-store' }).catch(() => null);
    if (!delRes || !delRes.ok) {
      const metaFields = {
        room: { stringValue: room },
        last_msg_id: { stringValue: '' },
        cleared_at_ms: { integerValue: String(clearedAt) },
        updated_at: { timestampValue: new Date().toISOString() }
      };
      const mask = Object.keys(metaFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
      await fetch(`${FIRESTORE_ROOMS_BASE}/${encodeURIComponent(room)}?${mask}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: metaFields }),
        cache: 'no-store'
      }).catch(() => {});
    }
    lastRoomMetaSig = `${room}||${clearedAt}`;
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

const elDocType = document.getElementById('docType');
const elCameraCropFrame = document.getElementById('cameraCropFrame');
const elCameraOverlayHint = document.getElementById('cameraOverlayHint');
const docFramePills = Array.from(document.querySelectorAll('.doc-frame-bar .frame-pill'));
const btnCropUploadId = document.getElementById('btnCropUploadId');
const btnCropUploadA4 = document.getElementById('btnCropUploadA4');
const btnResetUpload = document.getElementById('btnResetUpload');
let currentFrameMode = 'id';
let originalUploadDataUrl = null;

function applyDocumentFrameMode(docChoice, explicitFrameMode = null) {
  const normalizedChoice = docChoice || 'nid';
  if (elDocType && elDocType.value !== normalizedChoice) {
    elDocType.value = normalizedChoice;
  }
  if (explicitFrameMode) {
    currentFrameMode = explicitFrameMode;
  } else if (normalizedChoice === 'birth_certificate') {
    currentFrameMode = 'a4';
  } else if (normalizedChoice === 'nid') {
    currentFrameMode = 'id';
  }
  if (cameraContainer) {
    cameraContainer.classList.toggle('mode-a4', currentFrameMode === 'a4');
    cameraContainer.classList.toggle('mode-id', currentFrameMode !== 'a4');
  }
  if (elCameraOverlayHint) {
    elCameraOverlayHint.textContent = currentFrameMode === 'a4'
      ? 'A4 জন্ম নিবন্ধন সনদ নীল ফ্রেমে রাখুন (বাইরের অংশ ক্রপ হবে)'
      : 'NID কার্ডটি নীল ফ্রেমের ভেতর রাখুন (বাইরের অংশ ক্রপ হবে)';
  }
  docFramePills.forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.docChoice === normalizedChoice);
  });
}

docFramePills.forEach((pill) => {
  pill.addEventListener('click', () => {
    const choice = pill.dataset.docChoice || 'nid';
    const nextFrame = pill.dataset.frameMode || (choice === 'birth_certificate' ? 'a4' : (choice === 'nid' ? 'id' : currentFrameMode));
    applyDocumentFrameMode(choice, nextFrame);
  });
});

if (elDocType) {
  elDocType.addEventListener('change', () => {
    applyDocumentFrameMode(elDocType.value);
  });
  applyDocumentFrameMode(elDocType.value || 'nid');
}

// Camera Stream Setup with progressive high-res constraints
async function startCamera() {
  try {
    if (currentStream) {
      currentStream.getTracks().forEach(t => t.stop());
    }
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
    currentStream = stream;
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

// Crop strictly to visible inner guide frame (compensating object-fit: cover scaling)
function captureCroppedCameraFrame(videoElem, frameEl, frameMode = 'id', quality = 0.92) {
  const natW = videoElem.videoWidth;
  const natH = videoElem.videoHeight;
  if (!natW || !natH) return null;

  const vRect = videoElem.getBoundingClientRect();
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

  photoCanvas.width = outW;
  photoCanvas.height = outH;
  const ctx = photoCanvas.getContext('2d');
  if ('filter' in ctx) ctx.filter = 'contrast(1.08) brightness(1.03)';
  ctx.drawImage(videoElem, sx, sy, sw, sh, 0, 0, outW, outH);
  return photoCanvas.toDataURL('image/jpeg', quality);
}

// Resize, enhance contrast & downscale image via Canvas for accurate Bengali OCR
function downscaleImage(imgOrVideo, maxDim = 1800, quality = 0.92, targetAspect = null) {
  const natW = imgOrVideo.videoWidth || imgOrVideo.naturalWidth || imgOrVideo.width;
  const natH = imgOrVideo.videoHeight || imgOrVideo.naturalHeight || imgOrVideo.height;

  let sx = 0, sy = 0, sw = natW, sh = natH;
  if (targetAspect && natW > 0 && natH > 0) {
    const curAspect = natW / natH;
    if (curAspect > targetAspect) {
      sw = Math.round(natH * targetAspect);
      sx = Math.round((natW - sw) / 2);
    } else {
      sh = Math.round(natW / targetAspect);
      sy = Math.round((natH - sh) / 2);
    }
  }

  const downScale = Math.min(1, maxDim / Math.max(sw, sh));
  const targetWidth = Math.max(1, Math.round(sw * downScale));
  const targetHeight = Math.max(1, Math.round(sh * downScale));

  photoCanvas.width = targetWidth;
  photoCanvas.height = targetHeight;
  const ctx = photoCanvas.getContext('2d');
  if ('filter' in ctx) {
    ctx.filter = 'contrast(1.08) brightness(1.03)';
  }
  ctx.drawImage(imgOrVideo, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

  return photoCanvas.toDataURL('image/jpeg', quality);
}

function applyUploadAspectCrop(targetAspect, maxDim, docChoice = null) {
  if (!originalUploadDataUrl) return;
  const img = new Image();
  img.onload = () => {
    selectedFileBase64 = downscaleImage(img, maxDim, 0.92, targetAspect);
    filePreview.src = selectedFileBase64;
    if (docChoice) applyDocumentFrameMode(docChoice);
  };
  img.src = originalUploadDataUrl;
}

if (btnCropUploadId) btnCropUploadId.addEventListener('click', () => applyUploadAspectCrop(85.6 / 53.98, 1800, 'nid'));
if (btnCropUploadA4) btnCropUploadA4.addEventListener('click', () => applyUploadAspectCrop(210 / 297, 2200, 'birth_certificate'));
if (btnResetUpload) btnResetUpload.addEventListener('click', () => applyUploadAspectCrop(null, currentFrameMode === 'a4' ? 2200 : 1800));

// File picker / Gallery handling
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    originalUploadDataUrl = event.target.result;
    const img = new Image();
    img.onload = () => {
      const maxDim = currentFrameMode === 'a4' ? 2200 : 1800;
      selectedFileBase64 = downscaleImage(img, maxDim, 0.92);
      filePreview.src = selectedFileBase64;
      filePreviewContainer.style.display = 'block';
      dropZone.style.display = 'none';
    };
    img.src = originalUploadDataUrl;
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
    base64Data = captureCroppedCameraFrame(videoElement, elCameraCropFrame, currentFrameMode, 0.92);
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
  const geminiModel = elGeminiModel ? elGeminiModel.value : DEFAULT_GEMINI_MODEL;
  const deepseekModel = elDeepSeekModel ? elDeepSeekModel.value : 'deepseek-flash';
  const docType = elDocType?.value || 'auto';
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
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) fetchCloudRoomMessages(false);
});
startCamera();
