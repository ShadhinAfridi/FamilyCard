// Helper to normalize Bengali numerals (০-৯) to English (0-9)
function normalizeDigits(str) {
  if (!str) return '';
  const bn = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  return String(str).replace(/[০-৯]/g, d => {
    const idx = bn.indexOf(d);
    return idx !== -1 ? idx : d;
  });
}

function toBnDigits(num) {
  const bn = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  return String(num ?? '').replace(/[0-9]/g, (d) => bn[Number(d)] ?? d);
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
const FIRESTORE_ERROR_LOGS_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/fc_error_logs';
const FIRESTORE_SURVEY_TIMERS_LOG_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/SURVEY_TIMERS/logs';
const FIRESTORE_SURVEY_TIMERS_COLLECTION_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/survey_timers';
const EDGE_ROOM_API = 'https://familycard-10n.pages.dev/api/room-messages';
const EDGE_ERROR_LOGS_API = 'https://familycard-10n.pages.dev/api/error-logs';
const EDGE_SURVEY_TIMER_API = 'https://familycard-10n.pages.dev/api/survey-timer';

const SURVEY_TIMER_STORAGE_KEY = 'fc_mobile_active_survey_timer_v1';
const SURVEY_TIMER_PENDING_KEY = 'fc_mobile_pending_survey_timers_v1';
const SURVEY_TIMER_HISTORY_KEY = 'fc_mobile_survey_timer_history_v1';

let activeWebSurveyTimer = null;
let webSurveyTickInterval = null;

function formatWebSurveyClock(totalSec = 0) {
  const sec = Math.max(0, Math.round(Number(totalSec) || 0));
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const rem = sec % 60;
  const pad = (n) => toBnDigits(String(n).padStart(2, '0'));
  if (hrs > 0) return `${pad(hrs)}:${pad(mins)}:${pad(rem)}`;
  return `${pad(mins)}:${pad(rem)}`;
}

function formatWebSurveyDurationLabel(totalSec = 0) {
  const sec = Math.max(0, Math.round(Number(totalSec) || 0));
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const rem = sec % 60;
  if (hrs > 0) return `${toBnDigits(hrs)} ঘঃ ${toBnDigits(mins)} মিঃ ${toBnDigits(rem)} সেঃ`;
  if (mins > 0) return `${toBnDigits(mins)} মিঃ ${toBnDigits(rem)} সেঃ`;
  return `${toBnDigits(sec)} সেঃ`;
}

function loadActiveWebSurveyTimer() {
  try {
    const raw = localStorage.getItem(SURVEY_TIMER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.sessionId ? parsed : null;
  } catch (_) {
    return null;
  }
}

function saveActiveWebSurveyTimer(state) {
  activeWebSurveyTimer = state;
  try {
    if (state) localStorage.setItem(SURVEY_TIMER_STORAGE_KEY, JSON.stringify(state));
    else localStorage.removeItem(SURVEY_TIMER_STORAGE_KEY);
  } catch (_) {}
}

function getWebSurveyElapsedSec(state = activeWebSurveyTimer, nowMs = Date.now()) {
  if (!state || !state.startedAtMs) return 0;
  if (state.status === 'ended') {
    if (typeof state.durationSec === 'number') return Math.max(0, state.durationSec);
    if (state.endedAtMs) return Math.max(0, Math.round((state.endedAtMs - state.startedAtMs) / 1000));
  }
  return Math.max(0, Math.round((nowMs - state.startedAtMs) / 1000));
}

function recordLocalSurveyTimerHistory(entry) {
  if (!entry || !entry.sessionId) return;
  try {
    const arr = JSON.parse(localStorage.getItem(SURVEY_TIMER_HISTORY_KEY) || '[]');
    const filtered = Array.isArray(arr) ? arr.filter((x) => x && x.sessionId !== entry.sessionId) : [];
    filtered.unshift(entry);
    localStorage.setItem(SURVEY_TIMER_HISTORY_KEY, JSON.stringify(filtered.slice(0, 60)));
  } catch (_) {}
}

function renderWebSurveyTimerUI() {
  const bar = document.getElementById('surveyTimerBar');
  const statusEl = document.getElementById('surveyTimerStatusText');
  const metaEl = document.getElementById('surveyTimerMeta');
  const clockEl = document.getElementById('surveyTimerClock');
  const btnEnd = document.getElementById('btnSurveyEnd');
  const btnStart = document.getElementById('btnSurveyStart');
  const modalBadge = document.getElementById('modalSurveyTimerBadge');

  const st = activeWebSurveyTimer;
  const elapsedSec = getWebSurveyElapsedSec(st);
  const clockText = formatWebSurveyClock(elapsedSec);
  const labelText = formatWebSurveyDurationLabel(elapsedSec);

  if (clockEl) clockEl.textContent = clockText;
  if (modalBadge) {
    modalBadge.textContent = st && st.status === 'running'
      ? `⏱️ চলমান জরিপ সময়কাল: ${clockText} (${labelText})`
      : (st && st.status === 'ended' ? `✅ পূর্ববর্তী জরিপ সময়: ${labelText}` : '⏱️ সার্ভে সময়কাল: ০০:০০');
  }

  if (!bar) return;
  bar.classList.remove('running', 'ended');
  if (st && st.status === 'running') {
    bar.classList.add('running');
    if (statusEl) statusEl.textContent = '⏱️ জরিপ চলছে (লাইভ)';
    const who = st.applicantName || st.docId || st.docNumber || '';
    if (metaEl) metaEl.textContent = who ? `${who} — সময় গণনা চলছে` : 'জরিপ শেষে "⏹️ শেষ" বা বাড়ি সেভ করুন';
    if (btnEnd) btnEnd.disabled = false;
    if (btnStart) btnStart.textContent = '🔄 রিস্টার্ট';
  } else if (st && st.status === 'ended') {
    bar.classList.add('ended');
    if (statusEl) statusEl.textContent = st.syncedToDb ? '✅ জরিপ সম্পন্ন (ডাটাবেসে সেভ)' : '✅ জরিপ সম্পন্ন';
    const who = st.applicantName || st.docId || st.docNumber || '';
    if (metaEl) metaEl.textContent = `${who ? `${who} • ` : ''}সময়: ${labelText}`;
    if (btnEnd) btnEnd.disabled = true;
    if (btnStart) btnStart.textContent = '▶️ নতুন সার্ভে';
  } else {
    if (statusEl) statusEl.textContent = '⏱️ নতুন জরিপের জন্য প্রস্তুত';
    if (metaEl) metaEl.textContent = 'নতুন বাড়ি যাচাই বা NID স্ক্যান শুরু করলেই সময় গণনা শুরু হবে';
    if (btnEnd) btnEnd.disabled = true;
    if (btnStart) btnStart.textContent = '▶️ শুরু';
  }
}

function startWebSurveyTicker() {
  if (webSurveyTickInterval) clearInterval(webSurveyTickInterval);
  webSurveyTickInterval = setInterval(() => {
    if (activeWebSurveyTimer && activeWebSurveyTimer.status === 'running') {
      renderWebSurveyTimerUI();
    }
  }, 1000);
}

function startNewWebSurveyTimer(meta = {}) {
  const now = Date.now();
  const state = {
    sessionId: meta.sessionId || `srv_${now}_${Math.random().toString(36).slice(2, 7)}`,
    status: 'running',
    startedAtMs: Number(meta.startedAtMs) > 0 ? Number(meta.startedAtMs) : now,
    endedAtMs: null,
    durationSec: 0,
    durationMs: 0,
    durationLabel: '০ সেঃ',
    familyId: String(meta.familyId || '').trim(),
    docId: String(meta.docId || '').trim(),
    docNumber: String(meta.docNumber || '').trim(),
    applicantName: String(meta.applicantName || '').trim(),
    docType: String(meta.docType || '').trim(),
    startReason: String(meta.startReason || 'new_survey'),
    endReason: '',
    syncedToDb: false
  };
  saveActiveWebSurveyTimer(state);
  startWebSurveyTicker();
  renderWebSurveyTimerUI();
  return state;
}

function ensureWebSurveyTimerStarted(meta = {}) {
  if (!activeWebSurveyTimer || activeWebSurveyTimer.status === 'ended') {
    return startNewWebSurveyTimer(meta);
  }
  let changed = false;
  for (const k of ['familyId', 'docId', 'docNumber', 'applicantName', 'docType']) {
    if (meta[k] && !activeWebSurveyTimer[k]) {
      activeWebSurveyTimer[k] = String(meta[k]).trim();
      changed = true;
    }
  }
  if (changed) {
    saveActiveWebSurveyTimer(activeWebSurveyTimer);
    renderWebSurveyTimerUI();
  }
  return activeWebSurveyTimer;
}

async function syncWebSurveyTimerToDb(entry, opts = {}) {
  if (!entry || !entry.sessionId) return false;
  const payload = {
    sessionId: entry.sessionId,
    familyId: entry.familyId || '',
    docId: entry.docId || entry.docNumber || entry.familyId || '',
    applicantName: entry.applicantName || '',
    docType: entry.docType || '',
    source: 'mobile_web',
    roomCode: normalizeRoomCode(elRoomCode?.value),
    deviceName: getDeviceName(),
    surveyStatus: entry.surveyStatus || 'COMPLETED',
    status: 'ended',
    readinessPct: entry.readinessPct || 0,
    startReason: entry.startReason || 'new_survey',
    endReason: entry.endReason || 'survey_ended',
    startedAtMs: entry.startedAtMs,
    endedAtMs: entry.endedAtMs,
    durationMs: entry.durationMs,
    durationSec: entry.durationSec,
    durationLabel: entry.durationLabel
  };

  try {
    const q = JSON.parse(localStorage.getItem(SURVEY_TIMER_PENDING_KEY) || '[]');
    const next = q.filter((x) => x && x.sessionId !== payload.sessionId);
    next.push(payload);
    localStorage.setItem(SURVEY_TIMER_PENDING_KEY, JSON.stringify(next.slice(-30)));
  } catch (_) {}

  let synced = false;
  const fields = {
    session_id: { stringValue: payload.sessionId },
    family_id: { stringValue: payload.familyId },
    doc_id: { stringValue: payload.docId },
    applicant_name: { stringValue: payload.applicantName },
    doc_type: { stringValue: payload.docType },
    source: { stringValue: payload.source },
    room_code: { stringValue: payload.roomCode },
    device_name: { stringValue: payload.deviceName },
    survey_status: { stringValue: payload.surveyStatus },
    timer_status: { stringValue: 'ended' },
    readiness_pct: { integerValue: String(payload.readinessPct) },
    start_reason: { stringValue: payload.startReason },
    end_reason: { stringValue: payload.endReason },
    started_at_ms: { integerValue: String(payload.startedAtMs) },
    ended_at_ms: { integerValue: String(payload.endedAtMs) },
    started_at: { timestampValue: new Date(payload.startedAtMs).toISOString() },
    ended_at: { timestampValue: new Date(payload.endedAtMs).toISOString() },
    duration_ms: { integerValue: String(payload.durationMs) },
    duration_sec: { integerValue: String(payload.durationSec) },
    duration_label: { stringValue: payload.durationLabel }
  };
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');

  try {
    const reqBody = JSON.stringify({ fields });
    const [fsLogRes] = await Promise.all([
      fetch(`${FIRESTORE_SURVEY_TIMERS_LOG_BASE}/${encodeURIComponent(payload.sessionId)}?${mask}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: reqBody,
        keepalive: true
      }).catch(() => null),
      fetch(`${FIRESTORE_SURVEY_TIMERS_COLLECTION_BASE}/${encodeURIComponent(payload.sessionId)}?${mask}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: reqBody,
        keepalive: true
      }).catch(() => null)
    ]);
    if (fsLogRes && fsLogRes.ok) synced = true;

    const targetDocIds = !opts.skipDocPatch
      ? Array.from(new Set([payload.familyId, payload.docId].filter((id) => id && id !== 'SURVEY_TIMERS')))
      : [];
    if (targetDocIds.length > 0) {
      const docFields = {
        survey_session_id: { stringValue: payload.sessionId },
        survey_started_at: { timestampValue: new Date(payload.startedAtMs).toISOString() },
        survey_ended_at: { timestampValue: new Date(payload.endedAtMs).toISOString() },
        survey_duration_sec: { integerValue: String(payload.durationSec) },
        survey_duration_label: { stringValue: payload.durationLabel },
        survey_timer_status: { stringValue: 'ended' }
      };
      const docMask = Object.keys(docFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
      for (const targetId of targetDocIds) {
        fetch(`https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(targetId)}?${docMask}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: docFields }),
          keepalive: true
        }).catch(() => {});
        fetch(`https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards/${encodeURIComponent(targetId)}/logs/${encodeURIComponent(`timer_${payload.sessionId}`)}?${mask}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: reqBody,
          keepalive: true
        }).catch(() => {});
      }
    }

    const host = window.location.hostname;
    const isLocalRelay = host === 'localhost' || host === '127.0.0.1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
    const apiEndpoint = isLocalRelay ? '/api/survey-timer' : EDGE_SURVEY_TIMER_API;
    const apiRes = await fetch(apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => null);
    if (apiRes && apiRes.ok) synced = true;
  } catch (_) {}

  if (synced) {
    try {
      const q = JSON.parse(localStorage.getItem(SURVEY_TIMER_PENDING_KEY) || '[]');
      localStorage.setItem(SURVEY_TIMER_PENDING_KEY, JSON.stringify(q.filter((x) => x && x.sessionId !== payload.sessionId)));
    } catch (_) {}
  }
  return synced;
}

async function flushPendingWebSurveyTimers() {
  try {
    const q = JSON.parse(localStorage.getItem(SURVEY_TIMER_PENDING_KEY) || '[]');
    if (!Array.isArray(q) || q.length === 0) return;
    for (const item of q.slice(0, 10)) {
      await syncWebSurveyTimerToDb(item, { skipDocPatch: true });
    }
  } catch (_) {}
}

async function endWebSurveyTimer(endReason = 'survey_ended', opts = {}) {
  if (!activeWebSurveyTimer) return null;
  if (activeWebSurveyTimer.status === 'ended' && !opts.forceUpdate) return activeWebSurveyTimer;

  const now = Number(opts.endedAtMs) > 0 ? Number(opts.endedAtMs) : Date.now();
  const endedAtMs = Math.max(activeWebSurveyTimer.startedAtMs, now);
  const durationMs = Math.max(0, endedAtMs - activeWebSurveyTimer.startedAtMs);
  const durationSec = Math.round(durationMs / 1000);
  const durationLabel = formatWebSurveyDurationLabel(durationSec);

  const finalState = {
    ...activeWebSurveyTimer,
    status: 'ended',
    endedAtMs,
    durationMs,
    durationSec,
    durationLabel,
    familyId: String(opts.familyId || activeWebSurveyTimer.familyId || '').trim(),
    docId: String(opts.docId || activeWebSurveyTimer.docId || activeWebSurveyTimer.docNumber || '').trim(),
    applicantName: String(opts.applicantName || activeWebSurveyTimer.applicantName || '').trim(),
    surveyStatus: String(opts.surveyStatus || activeWebSurveyTimer.surveyStatus || 'COMPLETED').trim(),
    endReason: String(endReason || 'survey_ended'),
    syncedToDb: false
  };
  saveActiveWebSurveyTimer(finalState);
  recordLocalSurveyTimerHistory(finalState);
  renderWebSurveyTimerUI();

  if (!opts.skipRemoteSync) {
    const synced = await syncWebSurveyTimerToDb(finalState, { skipDocPatch: Boolean(opts.skipDocPatch) });
    if (activeWebSurveyTimer && activeWebSurveyTimer.sessionId === finalState.sessionId) {
      activeWebSurveyTimer.syncedToDb = synced;
      saveActiveWebSurveyTimer(activeWebSurveyTimer);
      renderWebSurveyTimerUI();
    }
  }
  return finalState;
}

function renderWebSurveyTimerHistoryList(timers = []) {
  const statsEl = document.getElementById('surveyTimerStatsRow');
  const listEl = document.getElementById('surveyTimerHistoryList');
  if (!listEl || !statsEl) return;
  const list = Array.isArray(timers) ? timers : [];
  if (list.length === 0) {
    statsEl.textContent = '⏱️ এখনো কোনো সার্ভের সময় সংরক্ষিত হয়নি';
    listEl.innerHTML = '<div style="text-align:center; color:#64748b; font-size:0.75rem; padding:10px;">প্রথম সার্ভে সম্পন্ন হলে এখানে তালিকা দেখাবে</div>';
    return;
  }
  const totalSec = list.reduce((acc, t) => acc + (Number(t.durationSec) || 0), 0);
  const avgSec = Math.round(totalSec / list.length);
  statsEl.textContent = `📊 মোট ${toBnDigits(list.length)}টি জরিপ • গড় সময়: ${formatWebSurveyDurationLabel(avgSec)}`;
  listEl.innerHTML = list.slice(0, 20).map((t) => {
    const name = t.applicantName || t.docId || t.familyId || 'জরিপ';
    const timeStr = t.endedAtMs ? new Date(t.endedAtMs).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' }) : '';
    const dur = t.durationLabel || formatWebSurveyDurationLabel(t.durationSec || 0);
    return `
      <div class="timer-history-item">
        <div style="min-width:0;">
          <div style="font-weight:700; color:#0f172a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">👤 ${escapeHtml(name)}${t.docId ? ` <small style="color:#64748b;">(${escapeHtml(t.docId)})</small>` : ''}</div>
          <div style="font-size:0.68rem; color:#64748b;">${escapeHtml(t.source || '')} • ${escapeHtml(timeStr)}</div>
        </div>
        <span style="font-weight:800; color:#0369a1; white-space:nowrap;">⏱️ ${escapeHtml(dur)}</span>
      </div>
    `;
  }).join('');
}

async function fetchWebSurveyTimerHistory() {
  let localHist = [];
  try {
    const raw = JSON.parse(localStorage.getItem(SURVEY_TIMER_HISTORY_KEY) || '[]');
    if (Array.isArray(raw)) localHist = raw;
  } catch (_) {}
  try {
    const r = await fetch(`${FIRESTORE_SURVEY_TIMERS_LOG_BASE}?pageSize=30&t=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
    let remote = [];
    if (r && r.ok) {
      const data = await r.json().catch(() => ({}));
      const docs = Array.isArray(data.documents) ? data.documents : [];
      remote = docs.map((d) => {
        const f = d.fields || {};
        return {
          sessionId: f.session_id?.stringValue || d.name?.split('/').pop() || '',
          familyId: f.family_id?.stringValue || '',
          docId: f.doc_id?.stringValue || '',
          applicantName: f.applicant_name?.stringValue || '',
          source: f.source?.stringValue || '',
          endedAtMs: Number(f.ended_at_ms?.integerValue || f.ended_at_ms?.doubleValue || 0),
          durationSec: Number(f.duration_sec?.integerValue || 0),
          durationLabel: f.duration_label?.stringValue || ''
        };
      });
    }
    const merged = new Map();
    for (const item of [...localHist, ...remote]) {
      if (item && item.sessionId) merged.set(item.sessionId, item);
    }
    const sorted = Array.from(merged.values()).sort((a, b) => (b.endedAtMs || 0) - (a.endedAtMs || 0));
    renderWebSurveyTimerHistoryList(sorted);
  } catch (_) {
    renderWebSurveyTimerHistoryList(localHist);
  }
}

async function logTelemetryError(level = 'error', stage = 'general', message = '', detail = '') {
  try {
    const entry = {
      id: `web_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      source: 'web-scanner',
      level: String(level || 'error'),
      stage: String(stage || 'general'),
      message: String(message || 'Unknown error').slice(0, 800),
      detail: String(detail || '').slice(0, 1200),
      ts: Date.now(),
      createdAt: new Date().toISOString()
    };
    try {
      const list = JSON.parse(localStorage.getItem('fc_error_logs') || '[]');
      list.unshift(entry);
      if (list.length > 50) list.length = 50;
      localStorage.setItem('fc_error_logs', JSON.stringify(list));
    } catch (_) {}
    const r = await fetch(EDGE_ERROR_LOGS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    }).catch(() => null);
    if (!r || !r.ok) {
      await fetch(`${FIRESTORE_ROOMS_BASE}/FC_SYSTEM_LOGS/messages/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            id: { stringValue: entry.id },
            room: { stringValue: 'FC_SYSTEM_LOGS' },
            type: { stringValue: 'system' },
            text: { stringValue: `[${entry.level}][${entry.source}] ${entry.message}`.slice(0, 800) },
            payloadJson: { stringValue: JSON.stringify(entry) },
            senderName: { stringValue: getDeviceName() },
            senderClient: { stringValue: 'web' },
            senderId: { stringValue: MY_CLIENT_ID || 'web' },
            replyToJson: { stringValue: '' },
            ts: { integerValue: String(entry.ts) },
            createdAt: { stringValue: entry.createdAt }
          }
        })
      }).catch(() => {});
    }
  } catch (_) {}
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('error', (ev) => {
    const stack = (ev?.error && ev.error.stack) ? ` | ${String(ev.error.stack).slice(0, 700)}` : '';
    logTelemetryError('error', 'window.onerror', ev?.message || 'Script error', `${ev?.filename || ''}:${ev?.lineno || ''}:${ev?.colno || ''}${stack}`);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev?.reason;
    const stack = (reason && typeof reason === 'object' && reason.stack) ? String(reason.stack).slice(0, 700) : '';
    logTelemetryError('error', 'unhandledrejection', (reason && reason.message) || String(reason || 'Promise rejection'), stack);
  });
}
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
  if (rawMsg.type === 'survey_timer_ended' && rawMsg.payload && rawMsg.senderId !== MY_CLIENT_ID) {
    const p = rawMsg.payload;
    if (activeWebSurveyTimer && activeWebSurveyTimer.status === 'running') {
      const sameSession = p.sessionId && p.sessionId === activeWebSurveyTimer.sessionId;
      const sameDoc = p.docId && (p.docId === activeWebSurveyTimer.docId || p.docId === activeWebSurveyTimer.docNumber);
      if (sameSession || sameDoc || !activeWebSurveyTimer.docId) {
        endWebSurveyTimer(p.endReason || 'portal_submitted', {
          endedAtMs: p.endedAtMs || ts || Date.now(),
          familyId: p.familyId || '',
          docId: p.docId || '',
          applicantName: p.applicantName || '',
          skipRemoteSync: true
        });
      }
    }
  }
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

const btnToggleTorch = document.getElementById('btnToggleTorch');
const lblTorchText = document.getElementById('lblTorchText');
const btnToggleZoom = document.getElementById('btnToggleZoom');
const lblZoomText = document.getElementById('lblZoomText');
const btnFlipCamera = document.getElementById('btnFlipCamera');
const cameraStabilityBadge = document.getElementById('cameraStabilityBadge');
const cameraStabilityText = document.getElementById('cameraStabilityText');

let isTorchOn = false;
let currentZoom = 1.0;
let cameraFacingMode = 'environment';
let stabilityCheckTimer = null;
let isCapturingBurst = false;
let prevSharpness = 0;
let consecutiveSteadyFrames = 0;

// High-speed offscreen canvas for edge-sharpness & stability detection
const _stabilityCanvas = document.createElement('canvas');
_stabilityCanvas.width = 160;
_stabilityCanvas.height = 120;
const _stabilityCtx = _stabilityCanvas.getContext('2d', { willReadFrequently: true });

function calculateCameraSharpness(videoElem) {
  try {
    const natW = videoElem.videoWidth;
    const natH = videoElem.videoHeight;
    if (!natW || !natH) return 0;
    const sw = Math.round(natW * 0.6);
    const sh = Math.round(natH * 0.6);
    const sx = Math.round((natW - sw) / 2);
    const sy = Math.round((natH - sh) / 2);

    _stabilityCtx.drawImage(videoElem, sx, sy, sw, sh, 0, 0, 160, 120);
    const imgData = _stabilityCtx.getImageData(0, 0, 160, 120);
    const d = imgData.data;
    const gray = new Float32Array(160 * 120);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      gray[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    let sum = 0, sumSq = 0, count = 0;
    for (let y = 1; y < 119; y++) {
      const row = y * 160;
      for (let x = 1; x < 159; x++) {
        const idx = row + x;
        const lap = gray[idx - 160] + gray[idx + 160] + gray[idx - 1] + gray[idx + 1] - 4 * gray[idx];
        sum += lap;
        sumSq += lap * lap;
        count++;
      }
    }
    if (count === 0) return 0;
    const mean = sum / count;
    return (sumSq / count) - (mean * mean);
  } catch (_) {
    return 0;
  }
}

function calculateCanvasSharpness(srcCanvas) {
  try {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    if (!w || !h) return 0;
    const sw = Math.round(w * 0.6);
    const sh = Math.round(h * 0.6);
    const sx = Math.round((w - sw) / 2);
    const sy = Math.round((h - sh) / 2);

    _stabilityCtx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, 160, 120);
    const imgData = _stabilityCtx.getImageData(0, 0, 160, 120);
    const d = imgData.data;
    const gray = new Float32Array(160 * 120);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      gray[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    let sum = 0, sumSq = 0, count = 0;
    for (let y = 1; y < 119; y++) {
      const row = y * 160;
      for (let x = 1; x < 159; x++) {
        const idx = row + x;
        const lap = gray[idx - 160] + gray[idx + 160] + gray[idx - 1] + gray[idx + 1] - 4 * gray[idx];
        sum += lap;
        sumSq += lap * lap;
        count++;
      }
    }
    if (count === 0) return 0;
    const mean = sum / count;
    return (sumSq / count) - (mean * mean);
  } catch (_) {
    return 0;
  }
}

function startStabilityDetector() {
  stopStabilityDetector();
  stabilityCheckTimer = setInterval(() => {
    if (isCapturingBurst || currentMode !== 'camera' || !currentStream || !videoElement.videoWidth) {
      return;
    }
    const sharpness = calculateCameraSharpness(videoElement);
    const isSharp = sharpness >= 36;
    const delta = Math.abs(sharpness - prevSharpness);
    prevSharpness = sharpness;

    if (isSharp && delta < 28) {
      consecutiveSteadyFrames++;
    } else {
      consecutiveSteadyFrames = Math.max(0, consecutiveSteadyFrames - 1);
    }

    const isSteady = consecutiveSteadyFrames >= 2;
    if (cameraStabilityBadge) {
      if (isSteady) {
        cameraStabilityBadge.className = 'camera-stability-badge ready';
        if (cameraStabilityText) cameraStabilityText.textContent = '🟢 স্থির ও স্পষ্ট';
        if (elCameraCropFrame) elCameraCropFrame.classList.add('sharp-focus');
      } else {
        cameraStabilityBadge.className = 'camera-stability-badge shaky';
        if (cameraStabilityText) cameraStabilityText.textContent = '🟠 হাত স্থির রাখুন';
        if (elCameraCropFrame) elCameraCropFrame.classList.remove('sharp-focus');
      }
    }
  }, 280);
}

function stopStabilityDetector() {
  if (stabilityCheckTimer) {
    clearInterval(stabilityCheckTimer);
    stabilityCheckTimer = null;
  }
  if (elCameraCropFrame) elCameraCropFrame.classList.remove('sharp-focus');
}

async function toggleTorch() {
  if (!currentStream) return;
  const track = currentStream.getVideoTracks()[0];
  if (!track) return;
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.torch) {
      if (lblTorchText) lblTorchText.textContent = 'নেই';
      if (btnToggleTorch) btnToggleTorch.disabled = true;
      return;
    }
    isTorchOn = !isTorchOn;
    await track.applyConstraints({
      advanced: [{ torch: isTorchOn }]
    });
    if (btnToggleTorch) btnToggleTorch.classList.toggle('active', isTorchOn);
    if (lblTorchText) lblTorchText.textContent = isTorchOn ? 'চালু' : 'টর্চ';
  } catch (err) {
    console.warn('Torch toggle failed:', err);
  }
}

async function toggleZoom() {
  const nextZoom = currentZoom === 1.0 ? 2.0 : 1.0;
  let hardwareZoomApplied = false;

  if (currentStream) {
    const track = currentStream.getVideoTracks()[0];
    if (track && track.getCapabilities) {
      const caps = track.getCapabilities();
      if (caps.zoom && caps.zoom.max >= 2.0) {
        try {
          await track.applyConstraints({
            advanced: [{ zoom: nextZoom }]
          });
          hardwareZoomApplied = true;
        } catch (err) {
          console.warn('Hardware zoom failed:', err);
        }
      }
    }
  }

  currentZoom = nextZoom;
  if (btnToggleZoom) btnToggleZoom.classList.toggle('active', currentZoom > 1.0);
  if (lblZoomText) lblZoomText.textContent = `${currentZoom}x`;

  if (!hardwareZoomApplied && videoElement) {
    videoElement.style.transform = currentZoom > 1.0 ? `scale(${currentZoom})` : 'none';
    videoElement.style.transition = 'transform 0.2s ease-out';
  } else if (videoElement) {
    videoElement.style.transform = 'none';
  }
}

async function flipCamera() {
  cameraFacingMode = (cameraFacingMode === 'environment') ? 'user' : 'environment';
  isTorchOn = false;
  currentZoom = 1.0;
  if (btnToggleTorch) btnToggleTorch.classList.remove('active');
  if (lblTorchText) lblTorchText.textContent = 'টর্চ';
  if (btnToggleZoom) btnToggleZoom.classList.remove('active');
  if (lblZoomText) lblZoomText.textContent = '1x';
  if (videoElement) videoElement.style.transform = 'none';
  await startCamera();
}

if (btnToggleTorch) btnToggleTorch.addEventListener('click', toggleTorch);
if (btnToggleZoom) btnToggleZoom.addEventListener('click', toggleZoom);
if (btnFlipCamera) btnFlipCamera.addEventListener('click', flipCamera);

function applyDocumentFrameMode(docChoice, explicitFrameMode = null) {
  const normalizedChoice = docChoice || 'auto';
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
    const choice = pill.dataset.docChoice || 'auto';
    const nextFrame = pill.dataset.frameMode || (choice === 'birth_certificate' ? 'a4' : (choice === 'nid' ? 'id' : currentFrameMode));
    applyDocumentFrameMode(choice, nextFrame);
  });
});

if (elDocType) {
  elDocType.addEventListener('change', () => {
    applyDocumentFrameMode(elDocType.value);
  });
  applyDocumentFrameMode(elDocType.value || 'auto');
}

// Camera Stream Setup with progressive high-res constraints and facing mode
async function startCamera() {
  try {
    stopStabilityDetector();
    if (currentStream) {
      currentStream.getTracks().forEach(t => t.stop());
    }
    const candidates = [
      { video: { facingMode: { ideal: cameraFacingMode }, width: { ideal: 2560 }, height: { ideal: 1920 } }, audio: false },
      { video: { facingMode: { ideal: cameraFacingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: cameraFacingMode }, audio: false },
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

    // Check device capabilities for torch
    const track = stream.getVideoTracks()[0];
    if (track && track.getCapabilities) {
      const caps = track.getCapabilities();
      if (btnToggleTorch) {
        btnToggleTorch.disabled = !caps.torch;
        if (!caps.torch && lblTorchText) lblTorchText.textContent = 'টর্চ';
      }
    }
    startStabilityDetector();
  } catch (err) {
    console.warn('Camera error:', err);
    // Switch to gallery upload if camera is not accessible
    switchMode('gallery');
  }
}

function stopCamera() {
  stopStabilityDetector();
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  isTorchOn = false;
  if (btnToggleTorch) btnToggleTorch.classList.remove('active');
  if (lblTorchText) lblTorchText.textContent = 'টর্চ';
  currentZoom = 1.0;
  if (btnToggleZoom) btnToggleZoom.classList.remove('active');
  if (lblZoomText) lblZoomText.textContent = '1x';
  if (videoElement) videoElement.style.transform = 'none';
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

// Adaptive mid-tone contrast stretch and anti-glare specular suppression
function enhanceDocumentCanvas(canvas, ctx) {
  try {
    const w = canvas.width;
    const h = canvas.height;
    if (w <= 0 || h <= 0) return;
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const len = d.length;

    let minLum = 255;
    let maxLum = 0;
    for (let i = 0; i < len; i += 16) {
      const lum = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }

    const range = maxLum - minLum;
    const stretch = range > 45 && range < 225;

    for (let i = 0; i < len; i += 4) {
      let r = d[i];
      let g = d[i + 1];
      let b = d[i + 2];

      // Anti-glare: soften blown-out specular reflections on laminated cards
      if (r > 248 && g > 248 && b > 248) {
        r = 242;
        g = 242;
        b = 242;
      } else if (stretch) {
        r = Math.min(255, Math.max(0, ((r - minLum) * 255) / range));
        g = Math.min(255, Math.max(0, ((g - minLum) * 255) / range));
        b = Math.min(255, Math.max(0, ((b - minLum) * 255) / range));
      }

      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    }
    ctx.putImageData(imgData, 0, 0);
  } catch (err) {
    console.warn('enhanceDocumentCanvas error:', err);
  }
}

// Smart upscale for low-res inputs (< 1600px width) before sending to OCR
function smartUpscaleIfNeeded(imgOrCanvas, minWidth = 1600) {
  const natW = imgOrCanvas.videoWidth || imgOrCanvas.naturalWidth || imgOrCanvas.width;
  const natH = imgOrCanvas.videoHeight || imgOrCanvas.naturalHeight || imgOrCanvas.height;
  if (!natW || !natH || natW >= minWidth) return imgOrCanvas;

  const scale = minWidth / natW;
  const upW = Math.round(natW * scale);
  const upH = Math.round(natH * scale);
  const upCanvas = document.createElement('canvas');
  upCanvas.width = upW;
  upCanvas.height = upH;
  const upCtx = upCanvas.getContext('2d');
  upCtx.imageSmoothingEnabled = true;
  upCtx.imageSmoothingQuality = 'high';
  if ('filter' in upCtx) upCtx.filter = 'contrast(1.08) brightness(1.02)';
  upCtx.drawImage(imgOrCanvas, 0, 0, upW, upH);
  enhanceDocumentCanvas(upCanvas, upCtx);
  return upCanvas;
}

// Crop strictly to visible inner guide frame (compensating object-fit: cover scaling and digital zoom)
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

  // Note: videoElem.getBoundingClientRect() already includes active CSS transform scale(),
  // and hardware zoom modifies the video track directly, so no extra sw/sh division is needed.

  const maxDim = frameMode === 'a4' ? 2200 : 1800;
  const downScale = Math.min(1, maxDim / Math.max(sw, sh));
  const outW = Math.max(1, Math.round(sw * downScale));
  const outH = Math.max(1, Math.round(sh * downScale));

  photoCanvas.width = outW;
  photoCanvas.height = outH;
  const ctx = photoCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if ('filter' in ctx) ctx.filter = 'contrast(1.08) brightness(1.03)';
  ctx.drawImage(videoElem, sx, sy, sw, sh, 0, 0, outW, outH);
  enhanceDocumentCanvas(photoCanvas, ctx);
  return photoCanvas.toDataURL('image/jpeg', quality);
}

// Rapid Best-of-3 Burst Capture: takes 3 frames across ~160ms, evaluates sharpness, and picks best
async function captureBestOfThree(videoElem, frameEl, frameMode = 'id', quality = 0.92) {
  if (cameraContainer) {
    cameraContainer.classList.remove('flash-shutter');
    void cameraContainer.offsetWidth; // force reflow
    cameraContainer.classList.add('flash-shutter');
    setTimeout(() => cameraContainer.classList.remove('flash-shutter'), 320);
  }

  if (cameraStabilityBadge) {
    cameraStabilityBadge.className = 'camera-stability-badge capturing';
    if (cameraStabilityText) cameraStabilityText.textContent = '📸 শ্রেষ্ঠ ফ্রেম বাছাই হচ্ছে...';
  }

  const samples = [];
  for (let i = 0; i < 3; i++) {
    const dataUrl = captureCroppedCameraFrame(videoElem, frameEl, frameMode, quality);
    if (dataUrl) {
      const score = calculateCanvasSharpness(photoCanvas);
      samples.push({ dataUrl, score });
    }
    if (i < 2) {
      await new Promise(r => setTimeout(r, 65));
    }
  }

  setTimeout(() => {
    if (cameraStabilityBadge) {
      cameraStabilityBadge.className = 'camera-stability-badge ready';
      if (cameraStabilityText) cameraStabilityText.textContent = '🟢 স্থির ও স্পষ্ট';
    }
  }, 400);

  if (samples.length === 0) return null;
  samples.sort((a, b) => b.score - a.score);
  return samples[0].dataUrl;
}

// Resize, enhance contrast & downscale image via Canvas for accurate Bengali OCR
function downscaleImage(imgOrVideo, maxDim = 1800, quality = 0.92, targetAspect = null) {
  const processedSource = smartUpscaleIfNeeded(imgOrVideo, 1600);
  const natW = processedSource.videoWidth || processedSource.naturalWidth || processedSource.width;
  const natH = processedSource.videoHeight || processedSource.naturalHeight || processedSource.height;

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
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if ('filter' in ctx) {
    ctx.filter = 'contrast(1.08) brightness(1.03)';
  }
  ctx.drawImage(processedSource, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
  enhanceDocumentCanvas(photoCanvas, ctx);

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

// Shared robust handler for file selection & drag-and-drop (Images & PDF)
async function processIncomingFile(file) {
  if (!file) return;

  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (isPdf) {
    if (typeof window.pdfjsLib === 'undefined') {
      alert('PDF প্রসেসিং লাইব্রেরি লোড হয়নি। অনুগ্রহ করে পেজটি রিলোড করুন অথবা ছবির ফরম্যাট (JPG/PNG) ব্যবহার করুন।');
      return;
    }
    try {
      showLoading(true, 'PDF থেকে হাই-রেজ্যুলেশন পেজ লোড হচ্ছে...');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      // High-resolution rendering with max-dimension cap for mobile memory safety
      const baseViewport = page.getViewport({ scale: 1 });
      const targetScale = Math.min(2.5, 2400 / Math.max(baseViewport.width, baseViewport.height, 1));
      const viewport = page.getViewport({ scale: Math.max(1.2, targetScale) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      enhanceDocumentCanvas(canvas, ctx);
      selectedFileBase64 = canvas.toDataURL('image/jpeg', 0.94);
      originalUploadDataUrl = selectedFileBase64;
      filePreview.src = selectedFileBase64;
      filePreviewContainer.style.display = 'block';
      dropZone.style.display = 'none';
      showLoading(false);
      return;
    } catch (pdfErr) {
      console.warn('PDF.js render failed:', pdfErr);
      showLoading(false);
      alert('PDF ফাইলটি রেন্ডার করা যায়নি: ' + (pdfErr?.message || 'Unsupported PDF'));
      return;
    }
  }

  const reader = new FileReader();
  reader.onerror = () => alert('ফাইল পড়া যায়নি।');
  reader.onload = (event) => {
    originalUploadDataUrl = event.target.result;
    const img = new Image();
    img.onerror = () => alert('ছবিটি পড়া যাচ্ছে না — অনুগ্রহ করে সঠিক JPG বা PNG দিন।');
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
}

// File picker event
fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    processIncomingFile(e.target.files[0]);
  }
});

// Drag and drop events on dropZone
if (dropZone) {
  dropZone.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') {
      fileInput.click();
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      processIncomingFile(e.dataTransfer.files[0]);
    }
  });
}

// Change File Button handler
const btnChangeUpload = document.getElementById('btnChangeUpload');
if (btnChangeUpload) {
  btnChangeUpload.addEventListener('click', () => {
    fileInput.value = '';
    selectedFileBase64 = null;
    originalUploadDataUrl = null;
    filePreviewContainer.style.display = 'none';
    dropZone.style.display = 'flex';
    fileInput.click();
  });
}

// Capture or Send Action
btnCapture.addEventListener('click', async () => {
  let base64Data = null;

  if (currentMode === 'camera') {
    if (!videoElement.videoWidth) {
      alert('ক্যামেরা চালু নেই। অনুগ্রহ করে পারমিশন দিন বা ফাইল মোড বেছে নিন।');
      return;
    }
    try {
      isCapturingBurst = true;
      base64Data = await captureBestOfThree(videoElement, elCameraCropFrame, currentFrameMode, 0.92);
    } finally {
      isCapturingBurst = false;
    }
    if (!base64Data) {
      base64Data = captureCroppedCameraFrame(videoElement, elCameraCropFrame, currentFrameMode, 0.92);
    }
  } else {
    if (!selectedFileBase64) {
      alert('অনুগ্রহ করে এনআইডি বা জন্ম নিবন্ধনের একটি ছবি নির্বাচন করুন।');
      return;
    }
    base64Data = selectedFileBase64;
  }

  showLoading(true, 'AI ডকুমেন্ট বিশ্লেষণ করা হচ্ছে (Gemini / DeepSeek)...');
  const activeTimerForScan = ensureWebSurveyTimerStarted({ startReason: 'ocr_scan' });

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
      mobileNumber: mobileNumber,
      survey_started_at_ms: activeTimerForScan?.startedAtMs || undefined,
      survey_session_id: activeTimerForScan?.sessionId || undefined
    });
  } else {
    // Direct HTTP POST (local Express -> Cloudflare Edge -> Direct Client AI fallback)
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
      updateWebScanProgress(32, 'AI সার্ভারে ছবি পাঠানো হচ্ছে...', 'ধাপ: OCR রিকোয়েস্ট প্রসেস হচ্ছে');
      let resp = await fetch('/api/ocr-nid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      }).catch(() => null);
      if (!resp || resp.status === 404 || resp.status === 405 || !/application\/json/i.test(resp.headers.get('content-type') || '')) {
        updateWebScanProgress(48, 'Cloudflare Edge OCR-এ পাঠানো হচ্ছে...', 'ধাপ: Edge রুট প্রসেসিং');
        resp = await fetch('https://familycard-10n.pages.dev/api/ocr-nid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload
        }).catch(() => null);
      }
      let data = null;
      if (resp && /application\/json/i.test(resp.headers.get('content-type') || '')) {
        data = await resp.json().catch(() => null);
      } else if (apiKey || deepseekApiKey) {
        updateWebScanProgress(64, 'ডাইরেক্ট ব্রাউজার AI OCR চলছে...', 'ধাপ: Gemini / DeepSeek সরাসরি বিশ্লেষণ');
        data = await runDirectWebBrowserOcrFallback({
          imageBase64: base64Data,
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
      }
      if (!data) {
        throw new Error(`OCR API সাড়া দেয়নি (HTTP ${resp ? resp.status : 'Network Error'}) — অনুগ্রহ করে Gemini বা DeepSeek API Key সেটিংসে দিন।`);
      }
      updateWebScanProgress(86, 'ফলাফল যাচাই ও ইংরেজি সমন্বয় হচ্ছে...', 'ধাপ: JSON পার্সিং ও নাম যাচাই');
      if (data.success) {
        updateWebScanProgress(100, 'বিশ্লেষণ সম্পন্ন!', 'ধাপ: সম্পূর্ণ');
        showLoading(false);
        const enrichedData = {
          ...data.data,
          ...(activeTimerForScan?.startedAtMs ? { survey_started_at_ms: activeTimerForScan.startedAtMs } : {}),
          ...(activeTimerForScan?.sessionId ? { survey_session_id: activeTimerForScan.sessionId } : {})
        };
        displayResults(enrichedData);
        sendRoomMessage({
          type: 'nid_data',
          text: `🪪 স্ক্যান: ${enrichedData.name_bn || enrichedData.name_en || ''} (${enrichedData.doc_number || enrichedData.nid_number || enrichedData.birth_reg_no || ''})`,
          payload: enrichedData
        });
      } else {
        showLoading(false);
        logTelemetryError('error', 'web-ocr-response', data.error || 'Unknown OCR error', `provider=${aiProvider}`);
        alert('ত্রুটি: ' + data.error);
      }
    } catch (err) {
      showLoading(false);
      logTelemetryError('error', 'web-ocr-fetch', err.message || 'Fetch error', `provider=${aiProvider}`);
      alert('সার্ভার যোগাযোগে ত্রুটি: ' + err.message);
    }
  }
});

function normalizeDirectWebPrefix(enName, bnName) {
  if (!enName) return enName;
  let res = String(enName).trim();
  const bn = String(bnName || '').trim();
  const mstRe = /^(?:(?:MOSAMMAT|MOSAMMOT|MOST|MST|MOSA)\s+|(?:MOST|MST|MOSA)\.(?:\s*|(?=[A-Z])))/i;
  const mdRe = /^(?:(?:MD|MOHD|MOHAMMAD|MOHAMMED)\s+|(?:MD|MOHD)\.(?:\s*|(?=[A-Z])))/i;
  if (/^(?:মোছাঃ|মোছা:|মোছা\.|মোছা\s+)/.test(bn)) {
    res = mstRe.test(res) ? res.replace(mstRe, 'MST. ') : 'MST. ' + res;
  } else if (/^(?:মোঃ|মো:|মো\.|মো\s+)/.test(bn)) {
    res = mdRe.test(res) ? res.replace(mdRe, 'MD. ') : 'MD. ' + res;
  } else if (/^(?:মোসাঃ|মোসা:|মোসা\.|মোসা\s+)/.test(bn)) {
    if (/^(?:(?:MOSA|MOSAMMAT|MOSAMMOT)\s+|MOSA\.(?:\s*|(?=[A-Z])))/i.test(res)) {
      res = res.replace(/^(?:(?:MOSA|MOSAMMAT|MOSAMMOT)\s+|MOSA\.(?:\s*|(?=[A-Z])))/i, 'MOSA. ');
    }
  } else if (/^(?:(?:MOSAMMAT|MOSAMMOT|MOST)\s+|(?:MOST|MST)\.(?:\s*|(?=[A-Z])))/i.test(res)) {
    res = res.replace(/^(?:(?:MOSAMMAT|MOSAMMOT|MOST)\s+|(?:MOST|MST)\.(?:\s*|(?=[A-Z])))/i, 'MST. ');
  } else if (/^(?:MD\s+|MD\.(?:\s*|(?=[A-Z])))/i.test(res)) {
    res = res.replace(/^(?:MD\s+|MD\.(?:\s*|(?=[A-Z])))/i, 'MD. ');
  }
  return res.toUpperCase().replace(/\s+/g, ' ').trim();
}

function standardizeWebDate(raw) {
  if (!raw) return '';
  const str = normalizeDigits(raw).normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[-\.]/g, '/').trim();
  const isOk = (d, m, y) => {
    if (y < 1850 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
    const maxD = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    return d <= maxD;
  };
  const iso = str.match(/(?:^|\s)(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\b|$)/);
  if (iso) {
    const y = +iso[1], m = +iso[2], d = +iso[3];
    return isOk(d, m, y) ? `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}` : '';
  }
  const dmy = str.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[^\d]|$)/);
  if (dmy) {
    let d = +dmy[1], m = +dmy[2];
    const y = +dmy[3];
    if (d <= 12 && m > 12 && m <= 31) [d, m] = [m, d];
    return isOk(d, m, y) ? `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}` : '';
  }
  return '';
}

async function runDirectWebBrowserOcrFallback({
  imageBase64,
  apiKey = '',
  deepseekApiKey = '',
  aiProvider = 'economy',
  defaultKeySlot = 'auto',
  geminiModel = DEFAULT_GEMINI_MODEL,
  deepseekModel = 'deepseek-flash',
  docType = 'auto',
  maritalStatus = 'বিবাহিত',
  religion = 'ইসলাম',
  mobileNumber = ''
}) {
  let gKey = String(apiKey || '').trim();
  let dKey = String(deepseekApiKey || '').trim();
  if (!dKey && /^sk-/i.test(gKey)) { dKey = gKey; gKey = ''; }
  let mimeType = 'image/jpeg';
  let cleanBase64 = String(imageBase64 || '');
  const m = cleanBase64.match(/^data:([^;]+);base64,(.+)$/s);
  if (m) { mimeType = m[1] || mimeType; cleanBase64 = m[2]; }

  const prompt = `You are an ultra-precise OCR engine for Bangladeshi NID and Birth Registration Certificates.
STRICT VERBATIM ZERO-CORRECTION:
- NEVER alter printed Bengali spelling ("মন্ডল" stays "মন্ডল", "মোসাঃ" stays "মোসাঃ", "আঃ" stays "আঃ").
- NEVER invent, guess, or pad digits (10/13/17-digit NID or 17-digit BRC starting with YYYY). Put parent NIDs into father_nid/mother_nid only.
- If Bengali name starts with "মোছাঃ"/"মোছা:", English prefix MUST be "MST.". If "মোঃ", English prefix MUST be "MD.".
- Date of Birth "dob" MUST be strict DD/MM/YYYY (ignore registration_date).
Return strictly ONE JSON object with keys: doc_type, doc_number, nid_number, birth_reg_no, father_nid, mother_nid, registration_date, name_bn, name_en, dob, gender, father_name_bn, father_name_en, mother_name_bn, mother_name_en, spouse_name_bn, spouse_name_en, relation_suggestion, marital_status_suggestion, confidence.`;

  const extractJsonObj = (rawTxt) => {
    let clean = String(rawTxt || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fence = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence) clean = fence[1].trim();
    const s = clean.indexOf('{');
    const e = clean.lastIndexOf('}');
    if (s !== -1 && e > s) clean = clean.slice(s, e + 1);
    return JSON.parse(clean);
  };

  const callGem = async () => {
    const models = Array.from(new Set([geminiModel || DEFAULT_GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']));
    let lastErr = 'Gemini request failed';
    for (const mdl of models) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: cleanBase64 } }] }],
          generationConfig: { temperature: 0, response_mime_type: 'application/json' }
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = j?.error?.message || `HTTP ${res.status}`;
        if (res.status === 400 && /API[_\s]?key/i.test(msg)) throw new Error('Gemini API Key সঠিক নয়। অনুগ্রহ করে সঠিক API Key দিন।');
        lastErr = msg;
        continue;
      }
      const txt = (j?.candidates?.[0]?.content?.parts || []).map(p => p?.text || '').join('').trim();
      if (!txt) { lastErr = `${mdl}: খালি উত্তর`; continue; }
      const obj = extractJsonObj(txt);
      obj.ocr_model_used = `${mdl} (browser-direct)`;
      return obj;
    }
    throw new Error(lastErr);
  };

  const callDs = async () => {
    if (/pdf/i.test(String(mimeType || ''))) {
      const err = new Error('DeepSeek Vision সরাসরি PDF ফাইল সাপোর্ট করে না (JPEG/PNG প্রয়োজন)।');
      err.isVisionUnsupported = true;
      throw err;
    }
    const targetModel = 'deepseek-flash';
    let lastErr = 'DeepSeek থেকে কোনো উত্তর পাওয়া যায়নি।';
    for (const useJsonMode of [true, false]) {
      const payload = {
        model: targetModel,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are an ultra-precise OCR engine for Bangladeshi identity documents. Extract exact text without spelling changes. মোছাঃ->MST., মোঃ->MD.. Output strictly one valid JSON object.' },
          { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${mimeType};base64,${cleanBase64}` } }] }
        ],
        max_tokens: 2048
      };
      if (useJsonMode) payload.response_format = { type: 'json_object' };
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${dKey}` },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = j?.error?.message || j?.message || `DeepSeek HTTP ${res.status}`;
        if (res.status === 401) throw new Error('DeepSeek API Key সঠিক নয়।');
        if (res.status === 402) throw new Error('DeepSeek অ্যাকাউন্টে ব্যালেন্স শেষ।');
        lastErr = `${targetModel}: ${msg}`;
        if (useJsonMode && /response_format/i.test(msg)) continue;
        break;
      }
      const txt = j?.choices?.[0]?.message?.content || '';
      if (!txt) { lastErr = `${targetModel}: খালি উত্তর`; break; }
      const obj = extractJsonObj(txt);
      obj.ocr_model_used = `${targetModel} (${deepseekModel === 'deepseek-chat' ? 'vision' : deepseekModel}, browser-direct)`;
      return obj;
    }
    const finalErr = new Error(lastErr);
    if (/image_url|multimodal|vision|deserialize|unknown variant|model\s*(?:does\s*)?not\s*exist|invalid_request_error|unsupported\s*model/i.test(lastErr)) {
      finalErr.isVisionUnsupported = true;
    }
    throw finalErr;
  };

  let parsed = null;
  const preferDs = aiProvider === 'deepseek' || (defaultKeySlot === 'deepseek' && Boolean(dKey));
  if (preferDs && dKey) {
    try {
      parsed = await callDs();
    } catch (e) {
      if (e.isVisionUnsupported && gKey) {
        parsed = await callGem();
        parsed.ocr_model_used = `${parsed.ocr_model_used || 'gemini'} (DeepSeek Vision অসমর্থিত হওয়ায় Gemini Fallback)`;
      } else if (e.isVisionUnsupported) {
        throw new Error(`DeepSeek API সরাসরি ইমেজ OCR (image_url) সাপোর্ট করে না — অনুগ্রহ করে Gemini API Key যুক্ত করুন। (${e.message})`);
      } else if (!gKey || aiProvider === 'deepseek') {
        throw e;
      }
    }
  }
  let gemErr = null;
  if (!parsed && gKey) {
    try {
      parsed = await callGem();
    } catch (e) {
      gemErr = e;
      if (!dKey) throw e;
    }
  }
  if (!parsed && dKey) {
    try {
      parsed = await callDs();
    } catch (dsBackupErr) {
      if (gemErr && dsBackupErr?.isVisionUnsupported) throw gemErr;
      throw dsBackupErr;
    }
  }

  if (parsed) {
    if (parsed.dob) parsed.dob = standardizeWebDate(parsed.dob);
    const fNid = normalizeDigits(parsed.father_nid || '').replace(/[^0-9]/g, '');
    const mNid = normalizeDigits(parsed.mother_nid || '').replace(/[^0-9]/g, '');
    parsed.father_nid = fNid;
    parsed.mother_nid = mNid;
    const rawNid = normalizeDigits(parsed.nid_number || '').replace(/[^0-9]/g, '');
    const rawBrc = normalizeDigits(parsed.birth_reg_no || '').replace(/[^0-9]/g, '');
    const rawDoc = normalizeDigits(parsed.doc_number || '').replace(/[^0-9]/g, '');
    const cleanNid = (rawNid && rawNid !== fNid && rawNid !== mNid) ? rawNid : '';
    const hasBrcMeta = Boolean(fNid || mNid || parsed.registration_date);
    if (docType === 'birth_certificate' || (parsed.doc_type === 'birth_certificate' && rawBrc.length === 17 && (hasBrcMeta || !cleanNid))) {
      parsed.doc_type = 'birth_certificate';
      parsed.birth_reg_no = rawBrc || rawDoc;
      parsed.doc_number = parsed.birth_reg_no;
      parsed.nid_number = '';
    } else {
      parsed.doc_type = 'nid';
      parsed.nid_number = cleanNid || rawDoc || rawBrc;
      parsed.doc_number = parsed.nid_number;
      parsed.birth_reg_no = '';
    }
    for (const [bk, ek] of [['name_bn', 'name_en'], ['father_name_bn', 'father_name_en'], ['mother_name_bn', 'mother_name_en'], ['spouse_name_bn', 'spouse_name_en']]) {
      if (parsed[ek]) parsed[ek] = normalizeDirectWebPrefix(parsed[ek], parsed[bk]);
    }
    parsed.marital_status = maritalStatus || parsed.marital_status_suggestion || 'বিবাহিত';
    parsed.religion = religion || 'ইসলাম';
    parsed.mobile_number = normalizeDigits(mobileNumber || '').replace(/[^0-9]/g, '');
    return { success: true, data: parsed };
  }
  return null;
}

let _fcWebProgressTimer = null;
let _fcWebProgressStart = 0;

function updateWebScanProgress(pct, message, subText) {
  const fill = document.getElementById('loadingProgressBar');
  const pctEl = document.getElementById('loadingPct');
  const subEl = document.getElementById('loadingSubText');
  const elapsedEl = document.getElementById('loadingElapsed');
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  if (fill) fill.style.width = `${p}%`;
  if (pctEl) pctEl.textContent = `${p}%`;
  if (message && loadingMsg) loadingMsg.textContent = message;
  if (subText && subEl) subEl.textContent = subText;
  if (elapsedEl && _fcWebProgressStart) {
    elapsedEl.textContent = `${Math.max(0, Math.round((Date.now() - _fcWebProgressStart) / 1000))}s`;
  }
}

function showLoading(show, message) {
  if (_fcWebProgressTimer) {
    clearInterval(_fcWebProgressTimer);
    _fcWebProgressTimer = null;
  }
  if (show) {
    loadingIndicator.style.display = 'flex';
    btnCapture.disabled = true;
    _fcWebProgressStart = Date.now();
    let pct = 10;
    updateWebScanProgress(pct, message || 'প্রসেসিং হচ্ছে...', 'ধাপ: ছবি অপ্টিমাইজ ও পাঠানো হচ্ছে');
    _fcWebProgressTimer = setInterval(() => {
      if (pct < 84) {
        pct = Math.min(84, pct + (pct < 40 ? 9 : pct < 68 ? 5 : 2));
        const sub = pct < 35 ? 'ধাপ: ছবি কম্প্রেশন ও আপলোড'
          : pct < 65 ? 'ধাপ: AI OCR বাংলা ও ইংরেজি বিশ্লেষণ'
            : 'ধাপ: বাংলা সনদ ইংরেজি রূপান্তর ও যাচাই';
        updateWebScanProgress(pct, null, sub);
      } else {
        updateWebScanProgress(pct);
      }
    }, 600);
  } else {
    updateWebScanProgress(100);
    loadingIndicator.style.display = 'none';
    btnCapture.disabled = false;
  }
}

function displayResults(data) {
  if (!data) return;
  lastExtractedNid = data;
  if (typeof ensureWebSurveyTimerStarted === 'function') {
    ensureWebSurveyTimerStarted({
      startReason: 'ocr_result',
      docNumber: data.doc_number || data.nid_number || data.birth_reg_no || '',
      docId: data.family_id || data.doc_number || data.nid_number || data.birth_reg_no || '',
      applicantName: data.name_bn || data.name_en || '',
      docType: data.doc_type || 'nid'
    });
  }
  resultCard.style.display = 'block';

  const resDocType = document.getElementById('resDocType');
  if (resDocType) {
    const label = data.doc_type === 'birth_certificate' ? 'ডিজিটাল জন্ম নিবন্ধন (BRC)' : 'জাতীয় পরিচয়পত্র (NID)';
    resDocType.textContent = data.ocr_model_used ? `${label} • ${data.ocr_model_used}` : label;
  }

  document.getElementById('resNameBn').textContent = (data.name_bn || 'পাওয়া যায়নি') + (data.auto_transliterated_bn ? ' (স্বয়ংক্রিয় বাংলা)' : '');
  document.getElementById('resNameEn').textContent = (data.name_en || 'পাওয়া যায়নি') + (data.auto_transliterated_en ? ' (স্বয়ংক্রিয় ইংরেজি)' : '');
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
      const dsTag = data.deepseek_en_completed ? ` + ${data.deepseek_en_completed}` : '';
      const compTag = data.ocr_completeness && typeof data.ocr_completeness.scorePct === 'number'
        ? ` • ${data.ocr_completeness.scorePct}% সম্পূর্ণ`
        : '';
      resCost.textContent = `$${Number(u.costUsd || 0).toFixed(5)} (~৳${Number(u.costBdt || 0).toFixed(3)}) • ${u.totalTokens || 0} tok${u.estimated ? ' (est)' : ''}${dsTag}${compTag}${tot}`;
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

// ==========================================================================
// 🗺️ Survey Map & Pre-Survey Quick Check Module (v2.0.0)
// ==========================================================================

const FIRESTORE_HOUSES_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/surveyed_houses';
const FIRESTORE_CARDS_BASE = 'https://firestore.googleapis.com/v1/projects/rajbari-city-app-16601/databases/(default)/documents/family_cards';

const TAG_CONFIG = {
  no_female_nid: { label: '🪪 প্রধান নারীর NID নেই', cls: 'tag-danger', isBlocked: true },
  female_under_18: { label: '🔞 বয়স ১৮-এর কম', cls: 'tag-danger', isBlocked: true },
  sim_not_own_nid: { label: '📱 সিম নিজ NID-তে নেই', cls: 'tag-warn', isFixable: true },
  child_brc_missing: { label: '👶 জন্ম নিবন্ধন (BRC) নেই', cls: 'tag-warn', isFixable: true },
  member_doc_missing: { label: '👥 সদস্য ডকুমেন্ট নেই', cls: 'tag-info', isFixable: true }
};

let surveyHousesMap = new Map();
let currentLiveGps = null;
let leafletMap = null;
let leafletMarkersLayer = null;
let leafletTileLayer = null;
let myLocationMarker = null;
let isSatellite = false;
let activeMapFilter = 'all';
let mapSearchQuery = '';

// DOM Elements for Navigation & View
const navTabScanner = document.getElementById('navTabScanner');
const navTabMap = document.getElementById('navTabMap');
const btnOpenQuickCheck = document.getElementById('btnOpenQuickCheck');
const viewScanner = document.getElementById('viewScanner');
const viewMap = document.getElementById('viewMap');
const mapHouseCountBadge = document.getElementById('mapHouseCountBadge');

// DOM Elements for Map View
const statTotalHouses = document.getElementById('statTotalHouses');
const statCompletedHouses = document.getElementById('statCompletedHouses');
const statFixableHouses = document.getElementById('statFixableHouses');
const statBlockedHouses = document.getElementById('statBlockedHouses');
const houseSearchInput = document.getElementById('houseSearchInput');
const btnMapNewHouse = document.getElementById('btnMapNewHouse');
const btnCenterMyLocation = document.getElementById('btnCenterMyLocation');
const btnToggleSatellite = document.getElementById('btnToggleSatellite');
const btnRefreshHouses = document.getElementById('btnRefreshHouses');
const mapLocationToast = document.getElementById('mapLocationToast');
const houseListFeed = document.getElementById('houseListFeed');
const filteredHouseCount = document.getElementById('filteredHouseCount');

// DOM Elements for Modal
const quickHouseModal = document.getElementById('quickHouseModal');
const btnModalCloseHouse = document.getElementById('btnModalCloseHouse');
const modalHouseDocId = document.getElementById('modalHouseDocId');
const modalLadyName = document.getElementById('modalLadyName');
const modalLadyNid = document.getElementById('modalLadyNid');
const modalContactPhone = document.getElementById('modalContactPhone');
const modalVillage = document.getElementById('modalVillage');
const modalGpsStatusText = document.getElementById('modalGpsStatusText');
const modalGpsCoords = document.getElementById('modalGpsCoords');
const btnModalRefreshGps = document.getElementById('btnModalRefreshGps');
const modalGpsAccuracyBadge = document.getElementById('modalGpsAccuracyBadge');
const modalPlusCodeBadge = document.getElementById('modalPlusCodeBadge');
const chkLadyNid = document.getElementById('chkLadyNid');
const chkLadyAge = document.getElementById('chkLadyAge');
const chkLadySim = document.getElementById('chkLadySim');
const chkChildBrc = document.getElementById('chkChildBrc');
const chkMembersDoc = document.getElementById('chkMembersDoc');
const modalMissingTagsPreview = document.getElementById('modalMissingTagsPreview');
const modalMissingTagsList = document.getElementById('modalMissingTagsList');
const modalHouseNotes = document.getElementById('modalHouseNotes');
const btnSaveHouseRecord = document.getElementById('btnSaveHouseRecord');
const btnLaunchPortalEligible = document.getElementById('btnLaunchPortalEligible');

// Open Location Code (Plus Code) Standalone Encoder
function encodePlusCode(lat, lng) {
  try {
    const CODE_ALPHABET = '23456789CFGHJMPQRVWX';
    let latitude = Math.min(90, Math.max(-90, Number(lat))) + 90;
    let longitude = Math.min(180, Math.max(-180, Number(lng))) + 180;
    let code = '';
    let latVal = latitude;
    let lngVal = longitude;
    let latGrid = 20;
    let lngGrid = 20;
    for (let i = 0; i < 4; i++) {
      const latDigit = Math.floor(latVal / latGrid);
      const lngDigit = Math.floor(lngVal / lngGrid);
      code += CODE_ALPHABET.charAt(latDigit) + CODE_ALPHABET.charAt(lngDigit);
      latVal = (latVal % latGrid) * 20;
      lngVal = (lngVal % lngGrid) * 20;
      if (i === 3) code += '+';
    }
    const latDigit = Math.floor(latVal / latGrid);
    const lngDigit = Math.floor(lngVal / lngGrid);
    code += CODE_ALPHABET.charAt(latDigit) + CODE_ALPHABET.charAt(lngDigit);
    return code;
  } catch (_) {
    return '';
  }
}

// Multi-sampling High-Accuracy GPS Locator
function acquireHighAccuracyLocation(maxWaitMs = 6000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      return resolve(currentLiveGps || { lat: 23.757, lng: 89.644, accuracy: 50, isFallback: true });
    }

    let bestSample = null;
    let samplesCount = 0;
    let watchId = null;

    const finalize = () => {
      if (watchId !== null) {
        try { navigator.geolocation.clearWatch(watchId); } catch (_) {}
      }
      if (bestSample) {
        currentLiveGps = bestSample;
        return resolve(bestSample);
      }
      if (currentLiveGps) return resolve(currentLiveGps);
      resolve({ lat: 23.757, lng: 89.644, accuracy: 50, isFallback: true });
    };

    const timer = setTimeout(finalize, maxWaitMs);

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        samplesCount++;
        const sample = {
          lat: Number(pos.coords.latitude.toFixed(6)),
          lng: Number(pos.coords.longitude.toFixed(6)),
          accuracy: Math.round(pos.coords.accuracy || 15),
          plusCode: encodePlusCode(pos.coords.latitude, pos.coords.longitude),
          timestamp: pos.timestamp || Date.now()
        };

        if (!bestSample || sample.accuracy < bestSample.accuracy) {
          bestSample = sample;
        }

        // If high precision attained (<= 5 meters), resolve early
        if (sample.accuracy <= 6 || samplesCount >= 4) {
          clearTimeout(timer);
          finalize();
        }
      },
      (err) => {
        console.warn('[Geolocation] notice:', err.message);
        clearTimeout(timer);
        finalize();
      },
      {
        enableHighAccuracy: true,
        timeout: maxWaitMs,
        maximumAge: 1000
      }
    );
  });
}

function showMapToast(msg, durationMs = 2800) {
  if (!mapLocationToast) return;
  mapLocationToast.textContent = msg;
  mapLocationToast.style.display = 'block';
  setTimeout(() => {
    mapLocationToast.style.display = 'none';
  }, durationMs);
}

// Convert Firestore REST document structure to plain JS Object
function parseFirestoreDoc(doc) {
  if (!doc || !doc.fields) return null;
  const rawId = doc.name ? doc.name.split('/').pop() : '';
  const f = doc.fields;
  const out = { docId: rawId };

  function parseVal(v) {
    if (!v) return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return parseInt(v.integerValue, 10);
    if ('doubleValue' in v) return parseFloat(v.doubleValue);
    if ('booleanValue' in v) return v.booleanValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('mapValue' in v) {
      const sub = {};
      const subFields = v.mapValue.fields || {};
      for (const sk in subFields) sub[sk] = parseVal(subFields[sk]);
      return sub;
    }
    if ('arrayValue' in v) {
      return (v.arrayValue.values || []).map(parseVal);
    }
    return null;
  }

  for (const k in f) {
    out[k] = parseVal(f[k]);
  }

  // Normalize location
  if (out.location && typeof out.location.lat === 'number' && typeof out.location.lng === 'number') {
    out.lat = out.location.lat;
    out.lng = out.location.lng;
    out.accuracy = out.location.accuracy || 10;
  } else if (typeof out.lat === 'number' && typeof out.lng === 'number') {
    out.location = { lat: out.lat, lng: out.lng, accuracy: out.accuracy || 10 };
  }

  // Derive unified status
  if (out.survey_status) {
    // Already defined
  } else if (out.summary_readiness_pct >= 90 || out.is_completed) {
    out.survey_status = 'COMPLETED';
  } else if (Array.isArray(out.issues) && out.issues.length > 0) {
    const hasBlocked = out.issues.some(i => i === 'no_female_nid' || i === 'female_under_18');
    out.survey_status = hasBlocked ? 'INCOMPLETE_BLOCKED' : 'INCOMPLETE_ACTIONABLE';
  } else {
    out.survey_status = 'INCOMPLETE_ACTIONABLE';
  }

  // Normalized lady name
  out.ladyName = out.primary_lady_name_bn || out.name_bn || out.lady_name || out.docId;
  out.contactPhone = out.mobile_number || out.contact_phone || '';
  out.issues = Array.isArray(out.issues) ? out.issues : [];

  return out;
}

// Leaflet Map Initialization
function initLeafletMap() {
  if (leafletMap || typeof L === 'undefined') return;

  const mapEl = document.getElementById('surveyMap');
  if (!mapEl) return;

  // Default coordinate (Rajbari, Bangladesh)
  const defaultLat = currentLiveGps?.lat || 23.757;
  const defaultLng = currentLiveGps?.lng || 89.644;

  leafletMap = L.map(mapEl, {
    zoomControl: true,
    attributionControl: false
  }).setView([defaultLat, defaultLng], 15);

  const osmUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const googleSatUrl = 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}';

  leafletTileLayer = L.tileLayer(osmUrl, { maxZoom: 19 }).addTo(leafletMap);
  leafletMarkersLayer = L.layerGroup().addTo(leafletMap);

  leafletMap.on('popupopen', (ev) => {
    const popupEl = ev?.popup?.getElement?.();
    if (!popupEl) return;
    popupEl.querySelectorAll('.fc-popup-edit-btn[data-doc-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const docId = btn.getAttribute('data-doc-id');
        if (docId) window.__editHouseRecord(docId);
      });
    });
  });

  leafletMap.on('click', (e) => {
    // Update live GPS when map clicked
    currentLiveGps = {
      lat: Number(e.latlng.lat.toFixed(6)),
      lng: Number(e.latlng.lng.toFixed(6)),
      accuracy: 5,
      plusCode: encodePlusCode(e.latlng.lat, e.latlng.lng),
      timestamp: Date.now()
    };
    renderMyLocationMarker(currentLiveGps);
  });
}

function toggleMapSatelliteLayer() {
  if (!leafletMap || !leafletTileLayer) return;
  isSatellite = !isSatellite;
  leafletMap.removeLayer(leafletTileLayer);

  if (isSatellite) {
    leafletTileLayer = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
      maxZoom: 20
    }).addTo(leafletMap);
    if (btnToggleSatellite) btnToggleSatellite.textContent = '🗺️ সাধারণ ভিউ';
    showMapToast('🛰️ গুগল স্যাটেলাইট হাইব্রিড ম্যাপ সক্রিয়');
  } else {
    leafletTileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    }).addTo(leafletMap);
    if (btnToggleSatellite) btnToggleSatellite.textContent = '🛰️ স্যাটেলাইট';
    showMapToast('🗺️ সাধারণ রোডম্যাপ ভিউ সক্রিয়');
  }
}

function renderMyLocationMarker(pos) {
  if (!leafletMap || !pos || typeof pos.lat !== 'number') return;
  if (myLocationMarker) {
    myLocationMarker.setLatLng([pos.lat, pos.lng]);
  } else {
    const pulseHtml = `
      <div style="position:relative; width:22px; height:22px;">
        <div style="position:absolute; width:22px; height:22px; background:rgba(2,132,199,0.35); border-radius:50%; animation:ping 1.4s cubic-bezier(0,0,0.2,1) infinite;"></div>
        <div style="position:absolute; top:4px; left:4px; width:14px; height:14px; background:#0284c7; border:2.5px solid #fff; border-radius:50%; box-shadow:0 2px 5px rgba(0,0,0,0.3);"></div>
      </div>
    `;
    const pulseIcon = L.divIcon({
      html: pulseHtml,
      className: '',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
    myLocationMarker = L.marker([pos.lat, pos.lng], { icon: pulseIcon }).addTo(leafletMap);
  }
}

function getMarkerPinSvg(colorHex, symbol) {
  return `
    <svg width="32" height="42" viewBox="0 0 32 42" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M16 0C7.163 0 0 7.163 0 16C0 27.2 14.5 40.8 15.1 41.4C15.6 41.8 16.4 41.8 16.9 41.4C17.5 40.8 32 27.2 32 16C32 7.163 24.837 0 16 0Z" fill="${colorHex}" stroke="#ffffff" stroke-width="1.5"/>
      <circle cx="16" cy="15" r="8.5" fill="#ffffff"/>
      <text x="16" y="19" font-size="11" font-weight="bold" fill="${colorHex}" text-anchor="middle">${symbol}</text>
    </svg>
  `;
}

function createHouseMarkerIcon(house) {
  let color = '#f59e0b';
  let symbol = '⚠️';

  if (house.survey_status === 'COMPLETED') {
    color = '#16a34a';
    symbol = '✓';
  } else if (house.survey_status === 'INCOMPLETE_BLOCKED') {
    color = '#dc2626';
    symbol = '✕';
  } else if (house.issues?.includes('sim_not_own_nid')) {
    color = '#d97706';
    symbol = '📱';
  } else if (house.issues?.includes('child_brc_missing')) {
    color = '#0284c7';
    symbol = '👶';
  }

  const svg = getMarkerPinSvg(color, symbol);
  return L.divIcon({
    html: `<div style="filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));">${svg}</div>`,
    className: '',
    iconSize: [32, 42],
    iconAnchor: [16, 42],
    popupAnchor: [0, -40]
  });
}

function buildHousePopupHtml(h) {
  const isDone = h.survey_status === 'COMPLETED';
  const badgeCls = isDone ? 'badge-green' : (h.survey_status === 'INCOMPLETE_BLOCKED' ? 'badge-red' : 'badge-orange');
  const badgeText = isDone ? '🟢 সম্পন্ন' : (h.survey_status === 'INCOMPLETE_BLOCKED' ? '🔴 ব্লকড' : '🟠 বাকি সমস্যা');

  let tagsHtml = '';
  if (Array.isArray(h.issues) && h.issues.length > 0) {
    tagsHtml = h.issues.map(tKey => {
      const cfg = TAG_CONFIG[tKey] || { label: tKey, cls: 'tag-warn' };
      return `<span class="tag-badge ${cfg.cls}">${escapeHtml(cfg.label)}</span>`;
    }).join(' ');
  } else if (isDone) {
    tagsHtml = '<span class="tag-badge tag-info">✅ ফ্যামিলি কার্ড সম্পূর্ণ</span>';
  }

  const hasCoords = Number.isFinite(Number(h.lat)) && Number.isFinite(Number(h.lng));
  const latNum = hasCoords ? Number(h.lat) : null;
  const lngNum = hasCoords ? Number(h.lng) : null;
  const navUrl = hasCoords ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(latNum)},${encodeURIComponent(lngNum)}` : '';
  const hasDuration = Number(h.survey_duration_sec) > 0;
  const durationLabel = h.survey_duration_label || (hasDuration ? `${toBnDigits(h.survey_duration_sec)} সেঃ` : '');

  return `
    <div class="fc-popup-content">
      <div class="fc-popup-hdr">
        <b>👩 ${escapeHtml(h.ladyName || 'নামবিহীন')}</b>
        <span class="status-badge ${badgeCls}">${badgeText}</span>
      </div>
      <div style="font-size:0.75rem; color:#475569; margin-bottom:4px;">
        ${h.docId ? `আইডি: <code>${escapeHtml(h.docId)}</code> • ` : ''}
        ${h.contactPhone ? `মোবাইল: <a href="tel:${escapeHtml(h.contactPhone)}">${escapeHtml(h.contactPhone)}</a>` : 'মোবাইল: নেই'}
        ${hasDuration ? ` • ⏱️ সময়: <b>${escapeHtml(durationLabel)}</b>` : ''}
      </div>
      ${h.village ? `<div style="font-size:0.74rem; color:#64748b; margin-bottom:4px;">🏠 ${escapeHtml(h.village)}</div>` : ''}
      ${tagsHtml ? `<div class="fc-popup-tags">${tagsHtml}</div>` : ''}
      ${h.notes ? `<div class="fc-popup-notes">📝 ${escapeHtml(h.notes)}</div>` : ''}
      <div style="display:flex; gap:5px; margin-top:8px;">
        ${navUrl ? `<a href="${navUrl}" target="_blank" rel="noopener" class="fc-popup-btn" style="flex:1;">🧭 দিকনির্দেশনা</a>` : ''}
        <button type="button" class="fc-popup-btn fc-popup-edit-btn" data-doc-id="${escapeHtml(h.docId)}" style="background:#0f766e; flex:1; border:none; cursor:pointer;">✏️ এডিট</button>
      </div>
    </div>
  `;
}

// Render markers on Leaflet map & house list feed
function renderMapHouses() {
  const allHouses = Array.from(surveyHousesMap.values());
  if (mapHouseCountBadge) mapHouseCountBadge.textContent = toBnDigits(allHouses.length);
  if (!leafletMap || !leafletMarkersLayer) return;
  leafletMarkersLayer.clearLayers();
  let countDone = 0;
  let countFixable = 0;
  let countBlocked = 0;
  let countSim = 0;
  let countBrc = 0;

  allHouses.forEach(h => {
    if (h.survey_status === 'COMPLETED') countDone++;
    else if (h.survey_status === 'INCOMPLETE_BLOCKED') countBlocked++;
    else countFixable++;

    if (h.issues?.includes('sim_not_own_nid')) countSim++;
    if (h.issues?.includes('child_brc_missing')) countBrc++;
  });

  // Update Stats Box
  if (statTotalHouses) statTotalHouses.textContent = toBnDigits(allHouses.length);
  if (statCompletedHouses) statCompletedHouses.textContent = toBnDigits(countDone);
  if (statFixableHouses) statFixableHouses.textContent = toBnDigits(countFixable);
  if (statBlockedHouses) statBlockedHouses.textContent = toBnDigits(countBlocked);
  if (mapHouseCountBadge) mapHouseCountBadge.textContent = toBnDigits(allHouses.length);

  // Update Filter Badges
  const fAll = document.getElementById('countFilterAll');
  const fDone = document.getElementById('countFilterDone');
  const fSim = document.getElementById('countFilterSim');
  const fBrc = document.getElementById('countFilterBrc');
  const fBlocked = document.getElementById('countFilterBlocked');
  if (fAll) fAll.textContent = toBnDigits(allHouses.length);
  if (fDone) fDone.textContent = toBnDigits(countDone);
  if (fSim) fSim.textContent = toBnDigits(countSim);
  if (fBrc) fBrc.textContent = toBnDigits(countBrc);
  if (fBlocked) fBlocked.textContent = toBnDigits(countBlocked);

  // Filter & Search Logic
  const query = (mapSearchQuery || '').trim().toLowerCase();
  const filtered = allHouses.filter(h => {
    // 1. Filter match
    if (activeMapFilter === 'completed' && h.survey_status !== 'COMPLETED') return false;
    if (activeMapFilter === 'blocked' && h.survey_status !== 'INCOMPLETE_BLOCKED') return false;
    if (activeMapFilter === 'sim_missing' && !h.issues?.includes('sim_not_own_nid')) return false;
    if (activeMapFilter === 'brc_missing' && !h.issues?.includes('child_brc_missing')) return false;

    // 2. Search query match
    if (query) {
      const lady = (h.ladyName || '').toLowerCase();
      const phone = (h.contactPhone || '').toLowerCase();
      const doc = (h.docId || '').toLowerCase();
      const notes = (h.notes || '').toLowerCase();
      const village = (h.village || '').toLowerCase();
      if (!lady.includes(query) && !phone.includes(query) && !doc.includes(query) && !notes.includes(query) && !village.includes(query)) {
        return false;
      }
    }
    return true;
  });

  if (filteredHouseCount) {
    filteredHouseCount.textContent = `${toBnDigits(filtered.length)}টি বাড়ি দেখানো হচ্ছে`;
  }

  const validGeoHouses = [];

  // Add markers to map
  filtered.forEach(h => {
    if (typeof h.lat === 'number' && typeof h.lng === 'number' && !isNaN(h.lat) && !isNaN(h.lng)) {
      validGeoHouses.push(h);
      const icon = createHouseMarkerIcon(h);
      const marker = L.marker([h.lat, h.lng], { icon });
      marker.bindPopup(buildHousePopupHtml(h));
      leafletMarkersLayer.addLayer(marker);
    }
  });

  // Render list feed
  renderHouseListFeed(filtered);

  // Auto-center bounds if markers exist
  if (validGeoHouses.length > 0 && !currentLiveGps) {
    const group = L.featureGroup(validGeoHouses.map(h => L.marker([h.lat, h.lng])));
    try { leafletMap.fitBounds(group.getBounds().pad(0.12)); } catch (_) {}
  }
}

function renderHouseListFeed(houses) {
  if (!houseListFeed) return;
  if (!houses || houses.length === 0) {
    houseListFeed.innerHTML = '<div style="text-align:center; color:#64748b; font-size:0.82rem; padding:20px;">কোনো বাড়ি পাওয়া যায়নি। নতুন বাড়ি যোগ করতে "📍 নতুন বাড়ি ট্যাগ" চাপুন।</div>';
    return;
  }

  houseListFeed.innerHTML = '';
  houses.forEach(h => {
    const card = document.createElement('div');
    const isDone = h.survey_status === 'COMPLETED';
    const statusCls = isDone ? 'status-completed' : (h.survey_status === 'INCOMPLETE_BLOCKED' ? 'status-blocked' : 'status-fixable');
    const badgeCls = isDone ? 'badge-green' : (h.survey_status === 'INCOMPLETE_BLOCKED' ? 'badge-red' : 'badge-orange');
    const badgeText = isDone ? '🟢 সম্পন্ন' : (h.survey_status === 'INCOMPLETE_BLOCKED' ? '🔴 ব্লকড' : '🟠 বাকি সমস্যা');

    card.className = `house-item-card ${statusCls}`;

    let tagsHtml = '';
    if (Array.isArray(h.issues) && h.issues.length > 0) {
      tagsHtml = h.issues.map(tKey => {
        const cfg = TAG_CONFIG[tKey] || { label: tKey, cls: 'tag-warn' };
        return `<span class="tag-badge ${cfg.cls}">${escapeHtml(cfg.label)}</span>`;
      }).join(' ');
    }

    const hasCoords = Number.isFinite(Number(h.lat)) && Number.isFinite(Number(h.lng));
    const latNum = hasCoords ? Number(h.lat) : '';
    const lngNum = hasCoords ? Number(h.lng) : '';
    const navUrl = hasCoords ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(latNum)},${encodeURIComponent(lngNum)}` : '';
    const hasDuration = Number(h.survey_duration_sec) > 0;
    const durationLabel = h.survey_duration_label || (hasDuration ? `${toBnDigits(h.survey_duration_sec)} সেঃ` : '');

    card.innerHTML = `
      <div class="house-item-top">
        <span class="house-lady-name">👩 ${escapeHtml(h.ladyName || 'নামবিহীন বাড়ি')}</span>
        <span class="status-badge ${badgeCls}">${badgeText}</span>
      </div>
      <div class="house-meta-line">
        ${h.docId ? `<span>🆔 ${escapeHtml(h.docId)}</span>` : ''}
        ${h.contactPhone ? `<span>📱 ${escapeHtml(h.contactPhone)}</span>` : ''}
        ${h.village ? `<span>🏠 ${escapeHtml(h.village)}</span>` : ''}
        ${h.plusCode ? `<span>📍 Plus Code: <code>${escapeHtml(h.plusCode)}</code></span>` : ''}
        ${hasDuration ? `<span>⏱️ সময়: <b>${escapeHtml(durationLabel)}</b></span>` : ''}
      </div>
      ${tagsHtml ? `<div class="house-tags-line">${tagsHtml}</div>` : ''}
      ${h.notes ? `<div class="house-notes-text">📝 ${escapeHtml(h.notes)}</div>` : ''}
      <div class="house-actions-row">
        ${navUrl ? `<a href="${navUrl}" target="_blank" rel="noopener" class="btn-gnav">🧭 গুগল ম্যাপ দিকনির্দেশনা</a>` : ''}
        ${hasCoords ? `<button type="button" class="btn btn-outline btn-sm fc-house-center-btn" data-lat="${latNum}" data-lng="${lngNum}">🗺️ ম্যাপে দেখুন</button>` : ''}
        <button type="button" class="btn btn-secondary btn-sm fc-house-edit-btn" data-doc-id="${escapeHtml(h.docId)}">✏️ এডিট</button>
      </div>
    `;

    houseListFeed.appendChild(card);
  });
}

if (typeof houseListFeed !== 'undefined' && houseListFeed) {
  houseListFeed.addEventListener('click', (e) => {
    const centerBtn = e.target.closest('.fc-house-center-btn');
    if (centerBtn) {
      const lat = Number(centerBtn.getAttribute('data-lat'));
      const lng = Number(centerBtn.getAttribute('data-lng'));
      window.__centerMapOnHouse(lat, lng);
      return;
    }
    const editBtn = e.target.closest('.fc-house-edit-btn');
    if (editBtn) {
      const docId = editBtn.getAttribute('data-doc-id');
      if (docId) window.__editHouseRecord(docId);
    }
  });
}

// Global functions for inline HTML buttons
window.__centerMapOnHouse = function(lat, lng) {
  if (!leafletMap || typeof lat !== 'number' || typeof lng !== 'number') return;
  leafletMap.setView([lat, lng], 18);
  if (viewScanner && viewScanner.style.display !== 'none') {
    switchView('map');
  }
};

window.__editHouseRecord = function(docId) {
  const h = surveyHousesMap.get(docId);
  if (h) openQuickHouseModal(h);
};

// Fetch all surveyed houses & family cards from Firestore
async function fetchAllSurveyHouses() {
  try {
    // 1. Fetch from surveyed_houses
    const resHouses = await fetch(`${FIRESTORE_HOUSES_BASE}?pageSize=100`, { cache: 'no-store' });
    if (resHouses.ok) {
      const dataHouses = await resHouses.json().catch(() => ({}));
      if (Array.isArray(dataHouses.documents)) {
        dataHouses.documents.forEach(d => {
          const parsed = parseFirestoreDoc(d);
          if (parsed && parsed.docId) surveyHousesMap.set(parsed.docId, parsed);
        });
      }
    }

    // 2. Fetch from family_cards (completed cards synced from portal)
    const resCards = await fetch(`${FIRESTORE_CARDS_BASE}?pageSize=100`, { cache: 'no-store' });
    if (resCards.ok) {
      const dataCards = await resCards.json().catch(() => ({}));
      if (Array.isArray(dataCards.documents)) {
        dataCards.documents.forEach(d => {
          const parsed = parseFirestoreDoc(d);
          if (parsed && parsed.docId) {
            // If already exists in surveyed_houses, merge coordinates and tags
            const existing = surveyHousesMap.get(parsed.docId);
            if (existing) {
              parsed.lat = parsed.lat || existing.lat;
              parsed.lng = parsed.lng || existing.lng;
              parsed.plusCode = parsed.plusCode || existing.plusCode;
              parsed.issues = parsed.issues?.length ? parsed.issues : existing.issues;
            }
            // If completed in family_cards
            if (parsed.summary_readiness_pct >= 90 || parsed.section3_completed_count >= 3) {
              parsed.survey_status = 'COMPLETED';
            }
            surveyHousesMap.set(parsed.docId, parsed);
          }
        });
      }
    }

    renderMapHouses();
  } catch (err) {
    console.warn('[SurveyMap] Fetch notice:', err.message);
  }
}

// Modal Checklist & Tag Update
function updateModalChecklistPreview() {
  const issues = [];
  if (!chkLadyNid.checked) issues.push('no_female_nid');
  if (!chkLadyAge.checked) issues.push('female_under_18');
  if (!chkLadySim.checked) issues.push('sim_not_own_nid');
  if (!chkChildBrc.checked) issues.push('child_brc_missing');
  if (!chkMembersDoc.checked) issues.push('member_doc_missing');

  if (issues.length > 0) {
    modalMissingTagsPreview.style.display = 'block';
    modalMissingTagsList.innerHTML = issues.map(k => {
      const cfg = TAG_CONFIG[k] || { label: k, cls: 'tag-warn' };
      return `<span class="tag-badge ${cfg.cls}">${escapeHtml(cfg.label)}</span>`;
    }).join(' ');

    const hasBlocked = issues.includes('no_female_nid') || issues.includes('female_under_18');
    btnSaveHouseRecord.textContent = hasBlocked
      ? '🔴 ব্লকড বাড়ি হিসেবে সেভ করুন'
      : '🟠 সমাধানযোগ্য সমস্যা হিসেবে সেভ করুন';
    btnSaveHouseRecord.className = hasBlocked ? 'btn btn-danger flex-1' : 'btn btn-warning flex-1';
  } else {
    modalMissingTagsPreview.style.display = 'none';
    modalMissingTagsList.innerHTML = '';
    btnSaveHouseRecord.textContent = '💾 বাড়িটি সেভ করুন';
    btnSaveHouseRecord.className = 'btn btn-secondary flex-1';
  }
}

// Open Pre-Survey Quick Check Modal
async function openQuickHouseModal(existingHouse = null) {
  if (!quickHouseModal) return;

  if (!existingHouse) {
    ensureWebSurveyTimerStarted({ startReason: 'quick_house_new' });
  }
  renderWebSurveyTimerUI();

  // Reset fields
  modalHouseDocId.value = existingHouse?.docId || '';
  modalLadyName.value = existingHouse?.ladyName || existingHouse?.name_bn || '';
  modalLadyNid.value = existingHouse?.docId || existingHouse?.nid_number || '';
  modalContactPhone.value = existingHouse?.contactPhone || existingHouse?.mobile_number || '';
  modalVillage.value = existingHouse?.village || '';
  modalHouseNotes.value = existingHouse?.notes || '';

  // Set Checkboxes
  if (existingHouse) {
    chkLadyNid.checked = !existingHouse.issues?.includes('no_female_nid');
    chkLadyAge.checked = !existingHouse.issues?.includes('female_under_18');
    chkLadySim.checked = !existingHouse.issues?.includes('sim_not_own_nid');
    chkChildBrc.checked = !existingHouse.issues?.includes('child_brc_missing');
    chkMembersDoc.checked = !existingHouse.issues?.includes('member_doc_missing');
  } else {
    // Defaults: assuming lady has NID & 18+, but SIM or BRC might be unchecked
    chkLadyNid.checked = true;
    chkLadyAge.checked = true;
    chkLadySim.checked = false; // common pain point
    chkChildBrc.checked = false; // common pain point
    chkMembersDoc.checked = true;
  }

  updateModalChecklistPreview();
  quickHouseModal.style.display = 'flex';

  // Acquire or refresh GPS
  modalGpsStatusText.textContent = 'জিপিএস অবস্থান যাচাই হচ্ছে...';
  if (existingHouse && typeof existingHouse.lat === 'number') {
    currentLiveGps = {
      lat: existingHouse.lat,
      lng: existingHouse.lng,
      accuracy: existingHouse.accuracy || 8,
      plusCode: existingHouse.plusCode || encodePlusCode(existingHouse.lat, existingHouse.lng),
      timestamp: Date.now()
    };
    renderGpsInModal(currentLiveGps);
  } else {
    const loc = await acquireHighAccuracyLocation(4500);
    renderGpsInModal(loc);
  }
}

function renderGpsInModal(loc) {
  if (!loc) return;
  if (loc.isFallback) {
    modalGpsStatusText.textContent = '⚠️ জিপিএস আনলকড (ম্যাপে ক্লিক করে চিহ্নিত করুন)';
    modalGpsStatusText.style.color = '#d97706';
  } else {
    modalGpsStatusText.textContent = '✅ জিপিএস অবস্থান সফলভাবে লকড';
    modalGpsStatusText.style.color = '#15803d';
  }
  modalGpsCoords.textContent = `অক্ষাংশ: ${loc.lat}, দ্রাঘিমাংশ: ${loc.lng}`;
  modalGpsAccuracyBadge.textContent = `নির্ভুলতা: ±${loc.accuracy}m`;
  modalPlusCodeBadge.textContent = `প্লাস কোড: ${loc.plusCode || encodePlusCode(loc.lat, loc.lng)}`;
}

// Save House Record to Firestore & Sync with Tablet
async function saveHouseSurveyRecord(forceEligible = false) {
  const ladyName = (modalLadyName.value || '').trim();
  if (!ladyName) {
    alert('দয়া করে প্রধান নারীর নাম অথবা পরিবারের নাম লিখুন!');
    modalLadyName.focus();
    return;
  }

  if (!currentLiveGps || currentLiveGps.isFallback) {
    const okFallback = confirm(
      '⚠️ লাইভ জিপিএস সিগন্যাল পাওয়া যায়নি (ডিফল্ট কোঅর্ডিনেট সক্রিয়)!\n\nআপনি কি নিশ্চিত যে এই অবস্থানে বাড়িটি সেভ করবেন?\n\nটিপ: বাতিল করে ম্যাপে আপনার কাঙ্ক্ষিত বাড়ির ছাদে/উঠানে ট্যাপ করে সঠিক অবস্থান চিহ্নিত করতে পারেন।'
    );
    if (!okFallback) return;
  }

  const rawNid = normalizeDigits(modalLadyNid.value || '').replace(/[^0-9]/g, '');
  const rawPhone = normalizeDigits(modalContactPhone.value || '').replace(/[^0-9]/g, '');
  const village = (modalVillage.value || '').trim();
  const notes = (modalHouseNotes.value || '').trim();

  const issues = [];
  if (!chkLadyNid.checked) issues.push('no_female_nid');
  if (!chkLadyAge.checked) issues.push('female_under_18');
  if (!chkLadySim.checked) issues.push('sim_not_own_nid');
  if (!chkChildBrc.checked) issues.push('child_brc_missing');
  if (!chkMembersDoc.checked) issues.push('member_doc_missing');

  let surveyStatus = 'COMPLETED';
  if (forceEligible || issues.length === 0) {
    surveyStatus = 'COMPLETED';
  } else if (issues.includes('no_female_nid') || issues.includes('female_under_18')) {
    surveyStatus = 'INCOMPLETE_BLOCKED';
  } else {
    surveyStatus = 'INCOMPLETE_ACTIONABLE';
  }

  const existingId = modalHouseDocId.value;
  const docId = existingId || rawNid || `house_${Date.now()}`;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const timerSnapshot = ensureWebSurveyTimerStarted({
    startReason: 'house_save',
    docId,
    applicantName: ladyName
  });
  const timerStartMs = timerSnapshot?.startedAtMs || nowMs;
  const timerDurationSec = Math.max(0, Math.round((nowMs - timerStartMs) / 1000));
  const timerDurationLabel = formatWebSurveyDurationLabel(timerDurationSec);
  const timerStatusValue = forceEligible ? (timerSnapshot?.status || 'running') : 'ended';

  const lat = currentLiveGps?.lat || 23.757;
  const lng = currentLiveGps?.lng || 89.644;
  const accuracy = currentLiveGps?.accuracy || 15;
  const plusCode = currentLiveGps?.plusCode || encodePlusCode(lat, lng);

  const houseObj = {
    docId,
    ladyName,
    primary_lady_name_bn: ladyName,
    nid_number: rawNid,
    mobile_number: rawPhone,
    contactPhone: rawPhone,
    village,
    notes,
    issues,
    survey_status: surveyStatus,
    survey_session_id: timerSnapshot?.sessionId || '',
    survey_started_at: new Date(timerStartMs).toISOString(),
    survey_ended_at: forceEligible ? '' : nowIso,
    survey_duration_sec: timerDurationSec,
    survey_duration_label: timerDurationLabel,
    survey_timer_status: timerStatusValue,
    lat,
    lng,
    accuracy,
    plusCode,
    surveyor_id: MY_CLIENT_ID,
    surveyor_name: elDeviceName?.value || 'সার্ভেয়ার',
    updated_at: nowIso
  };

  // 1. Optimistic local update
  surveyHousesMap.set(docId, houseObj);
  renderMapHouses();
  quickHouseModal.style.display = 'none';

  // 2. Prepare Firestore fields
  const fields = {
    lady_name: { stringValue: ladyName },
    primary_lady_name_bn: { stringValue: ladyName },
    nid_number: { stringValue: rawNid },
    mobile_number: { stringValue: rawPhone },
    village: { stringValue: village },
    notes: { stringValue: notes },
    survey_status: { stringValue: surveyStatus },
    survey_session_id: { stringValue: timerSnapshot?.sessionId || '' },
    survey_started_at: { timestampValue: new Date(timerStartMs).toISOString() },
    survey_ended_at: { timestampValue: nowIso },
    survey_duration_sec: { integerValue: String(timerDurationSec) },
    survey_duration_label: { stringValue: timerDurationLabel },
    survey_timer_status: { stringValue: timerStatusValue },
    surveyor_id: { stringValue: MY_CLIENT_ID },
    surveyor_name: { stringValue: elDeviceName?.value || 'সার্ভেয়ার' },
    lat: { doubleValue: lat },
    lng: { doubleValue: lng },
    accuracy: { integerValue: String(accuracy) },
    plus_code: { stringValue: plusCode },
    updated_at: { timestampValue: nowIso },
    issues: {
      arrayValue: {
        values: issues.map(iss => ({ stringValue: iss }))
      }
    }
  };

  const updateMask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const firestoreUrl = `${FIRESTORE_CARDS_BASE}/${encodeURIComponent(docId)}?${updateMask}`;

  try {
    fetch(firestoreUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    }).catch(e => console.warn('[Firestore] House save notice:', e.message));

    // Also try surveyed_houses in background if deployed
    fetch(`${FIRESTORE_HOUSES_BASE}/${encodeURIComponent(docId)}?${updateMask}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    }).catch(() => {});

    // 3. Broadcast to room channel for tablets
    sendRoomMessage({
      type: 'survey_house_saved',
      text: `📍 বাড়ি সংরক্ষিত: ${ladyName} (${surveyStatus === 'COMPLETED' ? '🟢 সম্পন্ন' : '⚠️ সমস্যাযুক্ত'}) • ⏱️ ${timerDurationLabel}`,
      payload: houseObj
    });

    if (!forceEligible) {
      await endWebSurveyTimer('house_saved', {
        endedAtMs: nowMs,
        docId,
        applicantName: ladyName,
        surveyStatus,
        skipDocPatch: true
      });
    }

    showMapToast(`✅ ${ladyName}-এর বাড়ি ম্যাপে সংরক্ষিত হয়েছে! (⏱️ ${timerDurationLabel})`);
  } catch (err) {
    showMapToast('⚠️ অফলাইনে সেভ হয়েছে, পরবর্তীতে সিঙ্ক হবে');
  }
}

// View Switching Logic
function switchView(target) {
  if (target === 'map') {
    navTabScanner.classList.remove('active');
    navTabMap.classList.add('active');
    viewScanner.style.display = 'none';
    viewMap.style.display = 'flex';

    initLeafletMap();
    setTimeout(() => {
      if (leafletMap) leafletMap.invalidateSize();
      if (!currentLiveGps) {
        acquireHighAccuracyLocation().then(pos => {
          renderMyLocationMarker(pos);
          if (leafletMap) leafletMap.setView([pos.lat, pos.lng], 16);
        });
      }
    }, 150);
  } else {
    navTabMap.classList.remove('active');
    navTabScanner.classList.add('active');
    viewMap.style.display = 'none';
    viewScanner.style.display = 'flex';
  }
}

// Setup Event Listeners for Map & Modals
function setupSurveyMapEventListeners() {
  if (navTabScanner) navTabScanner.addEventListener('click', () => switchView('scanner'));
  if (navTabMap) navTabMap.addEventListener('click', () => switchView('map'));
  if (btnOpenQuickCheck) btnOpenQuickCheck.addEventListener('click', () => openQuickHouseModal());
  if (btnMapNewHouse) btnMapNewHouse.addEventListener('click', () => openQuickHouseModal());

  if (btnCenterMyLocation) {
    btnCenterMyLocation.addEventListener('click', async () => {
      showMapToast('🎯 জিপিএস অবস্থান যাচাই হচ্ছে...');
      const pos = await acquireHighAccuracyLocation(3500);
      renderMyLocationMarker(pos);
      if (leafletMap) leafletMap.setView([pos.lat, pos.lng], 17);
      showMapToast(`✅ অবস্থান পাওয়া গেছে (±${pos.accuracy}m)`);
    });
  }

  if (btnToggleSatellite) {
    btnToggleSatellite.addEventListener('click', toggleMapSatelliteLayer);
  }

  if (btnRefreshHouses) {
    btnRefreshHouses.addEventListener('click', () => {
      showMapToast('🔄 ক্লাউড থেকে তথ্য রিফ্রেশ হচ্ছে...');
      fetchAllSurveyHouses();
    });
  }

  // Filter chips clicks
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeMapFilter = chip.getAttribute('data-filter') || 'all';
      renderMapHouses();
    });
  });

  // Search input
  if (houseSearchInput) {
    let searchDebounce = null;
    houseSearchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        mapSearchQuery = houseSearchInput.value;
        renderMapHouses();
      }, 200);
    });
  }

  // Modal Checklist Reactivity
  [chkLadyNid, chkLadyAge, chkLadySim, chkChildBrc, chkMembersDoc].forEach(chk => {
    if (chk) chk.addEventListener('change', updateModalChecklistPreview);
  });

  if (btnModalRefreshGps) {
    btnModalRefreshGps.addEventListener('click', async () => {
      modalGpsStatusText.textContent = '🔄 পুনরায় জিপিএস লক হচ্ছে...';
      const loc = await acquireHighAccuracyLocation(4000);
      renderGpsInModal(loc);
    });
  }

  if (btnModalCloseHouse) {
    btnModalCloseHouse.addEventListener('click', () => {
      quickHouseModal.style.display = 'none';
    });
  }

  if (btnSaveHouseRecord) {
    btnSaveHouseRecord.addEventListener('click', () => saveHouseSurveyRecord(false));
  }

  if (btnLaunchPortalEligible) {
    btnLaunchPortalEligible.addEventListener('click', () => {
      chkLadyNid.checked = true;
      chkLadyAge.checked = true;
      chkLadySim.checked = true;
      chkChildBrc.checked = true;
      chkMembersDoc.checked = true;
      saveHouseSurveyRecord(true);
      switchView('scanner');
      showMapToast('⚡ যোগ্য পরিবার! এবার NID স্ক্যান বা পোর্টালে কাজ শুরু করুন');
    });
  }
}

// Survey Timer Controls & Initialization
function setupWebSurveyTimer() {
  activeWebSurveyTimer = loadActiveWebSurveyTimer();
  startWebSurveyTicker();
  renderWebSurveyTimerUI();
  flushPendingWebSurveyTimers();

  const btnStart = document.getElementById('btnSurveyStart');
  const btnEnd = document.getElementById('btnSurveyEnd');
  const btnHist = document.getElementById('btnSurveyHistory');
  const btnRefreshHist = document.getElementById('btnRefreshTimerHistory');
  const histPanel = document.getElementById('surveyTimerHistoryPanel');

  if (btnStart) {
    btnStart.addEventListener('click', () => {
      startNewWebSurveyTimer({ startReason: 'manual_start' });
      showMapToast('⏱️ নতুন সার্ভে টাইমার শুরু হয়েছে!');
    });
  }
  if (btnEnd) {
    btnEnd.addEventListener('click', async () => {
      const done = await endWebSurveyTimer('manual_end', {
        docId: lastExtractedNid?.family_id || lastExtractedNid?.doc_number || lastExtractedNid?.nid_number || lastExtractedNid?.birth_reg_no || '',
        applicantName: lastExtractedNid?.name_bn || lastExtractedNid?.name_en || ''
      });
      if (done) {
        showMapToast(`✅ জরিপ শেষ: ${done.durationLabel} (ডাটাবেসে সেভ হয়েছে)`);
        if (histPanel && histPanel.style.display !== 'none') fetchWebSurveyTimerHistory();
      }
    });
  }
  if (btnHist && histPanel) {
    btnHist.addEventListener('click', () => {
      const opening = histPanel.style.display === 'none';
      histPanel.style.display = opening ? 'block' : 'none';
      if (opening) fetchWebSurveyTimerHistory();
    });
  }
  if (btnRefreshHist) {
    btnRefreshHist.addEventListener('click', fetchWebSurveyTimerHistory);
  }
}

setupWebSurveyTimer();

// Initial Map Module Boot
setupSurveyMapEventListeners();
fetchAllSurveyHouses();

// Boot up
initSocket();
fetchCloudRoomMessages(true);
roomPollTimer = setInterval(() => fetchCloudRoomMessages(false), 3000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    fetchCloudRoomMessages(false);
    renderWebSurveyTimerUI();
  }
});
startCamera();

