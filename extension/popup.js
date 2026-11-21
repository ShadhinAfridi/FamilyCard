document.addEventListener('DOMContentLoaded', () => {
  const elProvider = document.getElementById('aiProvider');
  const elApiKey = document.getElementById('geminiApiKey');
  const elDeepSeekKey = document.getElementById('deepseekApiKey');
  const elServerUrl = document.getElementById('serverUrl');
  const elRoomCode = document.getElementById('roomCode');
  const btnSave = document.getElementById('btnSave');

  chrome.storage.sync.get(['aiProvider', 'geminiApiKey', 'deepseekApiKey', 'serverUrl', 'roomCode'], (res) => {
    if (res.aiProvider && elProvider) elProvider.value = res.aiProvider;
    if (res.geminiApiKey) elApiKey.value = res.geminiApiKey;
    if (res.deepseekApiKey && elDeepSeekKey) elDeepSeekKey.value = res.deepseekApiKey;
    if (res.serverUrl) elServerUrl.value = res.serverUrl;
    if (res.roomCode) elRoomCode.value = res.roomCode;
  });

  btnSave.addEventListener('click', () => {
    const aiProvider = elProvider ? elProvider.value : 'auto';
    const geminiApiKey = elApiKey.value.trim();
    const deepseekApiKey = elDeepSeekKey ? elDeepSeekKey.value.trim() : '';
    const serverUrl = elServerUrl.value.trim() || 'http://localhost:3000';
    const roomCode = (elRoomCode.value.trim() || 'FC-101').toUpperCase();

    chrome.storage.sync.set({ aiProvider, geminiApiKey, deepseekApiKey, serverUrl, roomCode }, () => {
      // Notify active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'config_updated',
            aiProvider,
            geminiApiKey,
            deepseekApiKey,
            serverUrl,
            roomCode
          }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      });
      btnSave.textContent = 'সংরক্ষিত হয়েছে! ✓';
      setTimeout(() => {
        btnSave.textContent = 'সেটিংস সংরক্ষণ করুন';
      }, 1500);
    });
  });
});
