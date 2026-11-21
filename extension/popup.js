const MODEL_RATES = {
  'gemini-3.1-flash-lite': { label: 'Gemini 3.1 Flash-Lite', inM: 0.25, outM: 1.50, est1k: 0.78, rpm: '4K RPM / 150K RPD' },
  'gemini-3.5-flash-lite': { label: 'Gemini 3.5 Flash-Lite', inM: 0.30, outM: 2.50, est1k: 1.11, rpm: '4K RPM / 150K RPD' },
  'gemini-3.8-flash': { label: 'Gemini 3.8 Flash', inM: 0.75, outM: 3.75, est1k: 2.53, rpm: '1K RPM / 10K RPD' },
  'deepseek-flash': { label: 'DeepSeek Flash', offIn: 0.15, offOut: 0.60, peakIn: 0.30, peakOut: 1.20 }
};

function isDeepSeekPeakNow() {
  const d = new Date();
  const day = d.getUTCDay();
  if (day < 1 || day > 5) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

document.addEventListener('DOMContentLoaded', () => {
  const elProvider = document.getElementById('aiProvider');
  const elDefaultKeySlot = document.getElementById('defaultKeySlot');
  const elGeminiModel = document.getElementById('geminiModel');
  const elDeepSeekModel = document.getElementById('deepseekModel');
  const elCostCard = document.getElementById('popupCostCard');
  const elApiKey = document.getElementById('geminiApiKey');
  const elDeepSeekKey = document.getElementById('deepseekApiKey');
  const elServerUrl = document.getElementById('serverUrl');
  const elRoomCode = document.getElementById('roomCode');
  const btnSave = document.getElementById('btnSave');

  function updateCostPreview(stats = null) {
    if (!elCostCard) return;
    const strategy = elProvider ? elProvider.value : 'economy';
    const keySlot = elDefaultKeySlot ? elDefaultKeySlot.value : 'auto';
    const gemId = elGeminiModel ? elGeminiModel.value : 'gemini-3.1-flash-lite';
    const gem = MODEL_RATES[gemId] || MODEL_RATES['gemini-3.1-flash-lite'];
    const peak = isDeepSeekPeakNow();
    const dsIn = peak ? 0.30 : 0.15;
    const dsOut = peak ? 1.20 : 0.60;
    const ds1k = peak ? 0.76 : 0.38;

    const useDeepSeekPrimary = strategy === 'deepseek' || (keySlot === 'deepseek' && (strategy === 'economy' || strategy === 'auto'));
    const primaryLine = useDeepSeekPrimary
      ? `<b>সক্রিয়:</b> DeepSeek Flash (${peak ? '🟠 Peak' : '🟢 Off-Peak'}) — <b>~$${ds1k.toFixed(2)}</b> (~৳${Math.round(ds1k * 122)}) / ১,০০০ NID`
      : `<b>সক্রিয়:</b> ${gem.label} — <b>~$${gem.est1k.toFixed(2)}</b> (~৳${Math.round(gem.est1k * 122)}) / ১,০০০ NID (${gem.rpm})`;

    const spendLine = stats && stats.totalScans > 0
      ? `<br>💰 মোট খরচ: <b>$${Number(stats.totalUsd || 0).toFixed(5)}</b> (~৳${(Number(stats.totalUsd || 0) * 122).toFixed(2)}) • ${stats.totalScans} স্ক্যান`
      : `<br>📉 তুলনা: DeepSeek $${dsIn}/$${dsOut} প্রতি 1M | ${gem.label} $${gem.inM}/$${gem.outM} প্রতি 1M`;

    elCostCard.innerHTML = `${primaryLine}${spendLine}`;
  }

  chrome.storage.sync.get(['aiProvider', 'defaultKeySlot', 'geminiModel', 'deepseekModel', 'geminiApiKey', 'deepseekApiKey', 'serverUrl', 'roomCode'], (res) => {
    if (res.aiProvider && elProvider) elProvider.value = res.aiProvider;
    if (res.defaultKeySlot && elDefaultKeySlot) elDefaultKeySlot.value = res.defaultKeySlot;
    if (res.geminiModel && elGeminiModel) elGeminiModel.value = res.geminiModel;
    if (res.deepseekModel && elDeepSeekModel) elDeepSeekModel.value = res.deepseekModel;
    if (res.geminiApiKey) elApiKey.value = res.geminiApiKey;
    if (res.deepseekApiKey && elDeepSeekKey) elDeepSeekKey.value = res.deepseekApiKey;
    if (res.serverUrl) elServerUrl.value = res.serverUrl;
    if (res.roomCode) elRoomCode.value = res.roomCode;
    chrome.storage.local.get(['fcOcrCostStats'], (loc) => {
      updateCostPreview(loc?.fcOcrCostStats || null);
    });
  });

  [elProvider, elDefaultKeySlot, elGeminiModel, elDeepSeekModel].forEach((el) => {
    if (el) el.addEventListener('change', () => updateCostPreview());
  });

  btnSave.addEventListener('click', () => {
    const aiProvider = elProvider ? elProvider.value : 'economy';
    const defaultKeySlot = elDefaultKeySlot ? elDefaultKeySlot.value : 'auto';
    const geminiModel = elGeminiModel ? elGeminiModel.value : 'gemini-3.1-flash-lite';
    const deepseekModel = elDeepSeekModel ? elDeepSeekModel.value : 'deepseek-flash';
    const geminiApiKey = elApiKey.value.trim();
    const deepseekApiKey = elDeepSeekKey ? elDeepSeekKey.value.trim() : '';
    const serverUrl = elServerUrl.value.trim() || 'http://localhost:3000';
    const roomCode = (elRoomCode.value.trim() || 'FC-101').toUpperCase();

    chrome.storage.sync.set({ aiProvider, defaultKeySlot, geminiModel, deepseekModel, geminiApiKey, deepseekApiKey, serverUrl, roomCode }, () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'config_updated',
            aiProvider,
            defaultKeySlot,
            geminiModel,
            deepseekModel,
            geminiApiKey,
            deepseekApiKey,
            serverUrl,
            roomCode
          }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      });
      btnSave.textContent = 'ডিফল্ট সংরক্ষিত হয়েছে! ✓';
      setTimeout(() => {
        btnSave.textContent = 'সেটিংস সংরক্ষণ করুন';
      }, 1500);
    });
  });
});
