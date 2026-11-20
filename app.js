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
const elApiKey = document.getElementById('apiKey');
const btnConnect = document.getElementById('btnConnect');

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

// Load saved room code & API key from localStorage
if (localStorage.getItem('fc_room_code')) {
  elRoomCode.value = localStorage.getItem('fc_room_code');
}
if (localStorage.getItem('fc_gemini_api_key')) {
  elApiKey.value = localStorage.getItem('fc_gemini_api_key');
}

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

// Resize & downscale image via Canvas to ensure fast transmission & clear OCR
function downscaleImage(imgOrVideo, maxWidth = 1600, quality = 0.88) {
  const width = imgOrVideo.videoWidth || imgOrVideo.naturalWidth || imgOrVideo.width;
  const height = imgOrVideo.videoHeight || imgOrVideo.naturalHeight || imgOrVideo.height;

  let targetWidth = width;
  let targetHeight = height;

  if (targetWidth > maxWidth) {
    targetHeight = Math.round((targetHeight * maxWidth) / targetWidth);
    targetWidth = maxWidth;
  }

  photoCanvas.width = targetWidth;
  photoCanvas.height = targetHeight;
  const ctx = photoCanvas.getContext('2d');
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
      selectedFileBase64 = downscaleImage(img, 1600, 0.88);
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
    base64Data = downscaleImage(videoElement, 1600, 0.88);
  } else {
    if (!selectedFileBase64) {
      alert('অনুগ্রহ করে এনআইডি কার্ডের একটি ছবি নির্বাচন করুন।');
      return;
    }
    base64Data = selectedFileBase64;
  }

  showLoading(true, 'ছবি প্রসেস হচ্ছে এবং এআই ও স্বাভাবিক যাচাই হচ্ছে...');

  const room = (elRoomCode.value || 'FC-101').trim().toUpperCase();
  const apiKey = elApiKey.value.trim();
  const maritalStatus = document.getElementById('maritalStatus')?.value || 'বিবাহিত';
  const religion = document.getElementById('religion')?.value || 'ইসলাম';
  const mobileNumber = normalizeDigits(document.getElementById('mobileNumber')?.value?.trim() || '');

  // Send over Socket.io
  if (socket && socket.connected) {
    socket.emit('scan-nid', {
      image: base64Data,
      room: room,
      apiKey: apiKey,
      maritalStatus: maritalStatus,
      religion: religion,
      mobileNumber: mobileNumber
    });
  } else {
    // Fallback direct HTTP POST
    try {
      const resp = await fetch('/api/ocr-nid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64Data, room, apiKey, maritalStatus, religion, mobileNumber })
      });
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

  document.getElementById('resNameBn').textContent = data.name_bn || 'পাওয়া যায়নি';
  document.getElementById('resNameEn').textContent = data.name_en || 'পাওয়া যায়নি';
  let nidDisplay = data.nid_number || 'পাওয়া যায়নি';
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

  // Smooth scroll into view
  resultCard.scrollIntoView({ behavior: 'smooth' });
}

btnDismissResult.addEventListener('click', () => {
  resultCard.style.display = 'none';
});

// Boot up
initSocket();
startCamera();
