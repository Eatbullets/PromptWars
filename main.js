/* ================================================
   IntentBridge — Main Application Logic
   Multimodal input handling + Gemini API integration
   ================================================ */

// ── State ──
const state = {
  activeMode: 'text',
  textInput: '',
  voiceAudio: null,        // { base64, mimeType }
  uploadedImage: null,     // { base64, mimeType, name, size }
  cameraSnapshot: null,    // { base64, mimeType }
  isRecording: false,
  isAnalyzing: false,
  cameraStream: null,
};

// ── DOM References ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Initialize ──
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initTextInput();
  initVoiceInput();
  initUploadInput();
  initCameraInput();
  initAnalyzeButton();
  checkAPIHealth();
});

// ── Health Check ──
async function checkAPIHealth() {
  const dot = $('#api-status');
  const text = $('#api-status-text');
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      dot.className = 'status-dot online';
      text.textContent = 'API Connected';
    } else {
      throw new Error();
    }
  } catch {
    dot.className = 'status-dot offline';
    text.textContent = 'API Offline';
  }
}

// ── Tab Switching ──
function initTabs() {
  const tabs = $$('.input-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      state.activeMode = mode;

      // Update tab active state
      tabs.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');

      // Show/hide input areas
      $$('.input-area').forEach((area) => area.classList.remove('active'));
      $(`#area-${mode}`).classList.add('active');

      updateAnalyzeButton();
    });
  });
}

// ── Text Input ──
function initTextInput() {
  const textarea = $('#text-input');
  const charCount = $('#char-count');

  textarea.addEventListener('input', () => {
    state.textInput = textarea.value;
    charCount.textContent = `${textarea.value.length} characters`;
    updateAnalyzeButton();
  });
}

// ── Voice Input ──
function initVoiceInput() {
  const voiceBtn = $('#voice-btn');
  const voiceStatus = $('#voice-status');
  const voiceHint = $('#voice-hint');
  const voiceVisualizer = $('#voice-visualizer');
  const voiceTimer = $('#voice-timer');
  const voiceTimerTime = $('#voice-timer-time');
  const voicePlayback = $('#voice-playback');
  const voiceAudio = $('#voice-audio');
  const voiceDiscard = $('#voice-discard');

  let mediaRecorder = null;
  let audioChunks = [];
  let timerInterval = null;
  let startTime = 0;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    voiceBtn.disabled = true;
    voiceStatus.textContent = 'Audio recording not supported';
    voiceHint.textContent = 'Please check browser permissions';
    return;
  }

  function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const sec = (totalSec % 60).toString().padStart(2, '0');
    return `${min}:${sec}`;
  }

  voiceBtn.addEventListener('click', async () => {
    if (state.isRecording && mediaRecorder) {
      mediaRecorder.stop();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstart = () => {
        state.isRecording = true;
        voiceBtn.classList.add('recording');
        voiceVisualizer.classList.add('active');
        voiceStatus.style.display = 'none';
        voiceTimer.style.display = 'flex';
        startTime = Date.now();
        timerInterval = setInterval(() => {
          voiceTimerTime.textContent = formatTime(Date.now() - startTime);
        }, 1000);
      };

      mediaRecorder.onstop = () => {
        state.isRecording = false;
        clearInterval(timerInterval);
        voiceBtn.classList.remove('recording');
        voiceVisualizer.classList.remove('active');
        voiceTimer.style.display = 'none';
        
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        
        // Convert to base64
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = () => {
          const base64data = reader.result.split(',')[1];
          state.voiceAudio = {
            base64: base64data,
            mimeType: 'audio/webm',
          };
          updateAnalyzeButton();
        };

        const audioUrl = URL.createObjectURL(audioBlob);
        voiceAudio.src = audioUrl;
        voicePlayback.style.display = 'flex';
        
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
    } catch (err) {
      console.error('Microphone access error:', err);
      voiceStatus.textContent = 'Microphone access denied';
    }
  });

  voiceDiscard.addEventListener('click', () => {
    state.voiceAudio = null;
    voicePlayback.style.display = 'none';
    voiceStatus.style.display = 'block';
    voiceStatus.textContent = 'Click to start recording';
    voiceAudio.src = '';
    voiceTimerTime.textContent = '00:00';
    updateAnalyzeButton();
  });
}

// ── Upload Input ──
function initUploadInput() {
  const zone = $('#upload-zone');
  const fileInput = $('#file-input');
  const content = $('#upload-content');
  const preview = $('#upload-preview');
  const previewImg = $('#upload-preview-img');
  const removeBtn = $('#upload-remove');
  const info = $('#upload-info');

  // Click to browse
  zone.addEventListener('click', (e) => {
    if (e.target === removeBtn || removeBtn.contains(e.target)) return;
    if (state.uploadedImage) return;
    fileInput.click();
  });

  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  // Drag & Drop
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('dragover');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  // File selection
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) handleFile(file);
  });

  // Remove
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.uploadedImage = null;
    content.style.display = 'flex';
    preview.style.display = 'none';
    fileInput.value = '';
    updateAnalyzeButton();
  });

  function handleFile(file) {
    if (!file.type.startsWith('image/')) {
      alert('Please upload an image file (JPG, PNG, WebP, GIF)');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      alert('File too large. Maximum size is 20MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      const originalBase64 = reader.result;
      
      // Optimize: Client-side compression for efficiency score
      const compressedDataUrl = await compressImage(originalBase64, 1280, 0.8);
      const base64 = compressedDataUrl.split(',')[1];
      
      state.uploadedImage = {
        base64,
        mimeType: 'image/jpeg', // Standardized to JPEG after compression
        name: file.name.replace(/\.[^/.]+$/, "") + ".jpg",
        size: Math.round((base64.length * 3) / 4),
      };

      previewImg.src = compressedDataUrl;
      content.style.display = 'none';
      preview.style.display = 'block';
      info.textContent = `${state.uploadedImage.name} • Optimized • ${formatSize(state.uploadedImage.size)}`;
      updateAnalyzeButton();
    };
    reader.readAsDataURL(file);
  }
}

// ── Image Compression Helper ──
async function compressImage(dataUrl, maxWidth, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = dataUrl;
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Camera Input ──
function initCameraInput() {
  const video = $('#camera-video');
  const canvas = $('#camera-canvas');
  const overlay = $('#camera-overlay');
  const snapshot = $('#camera-snapshot');
  const startBtn = $('#camera-start-btn');
  const captureBtn = $('#camera-capture-btn');
  const retakeBtn = $('#camera-retake-btn');

  startBtn.addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      state.cameraStream = stream;
      video.srcObject = stream;
      video.style.display = 'block';
      overlay.style.display = 'none';
      snapshot.style.display = 'none';
      captureBtn.disabled = false;
      startBtn.textContent = 'Stop Camera';
      startBtn.onclick = stopCamera;
    } catch (err) {
      console.error('Camera access error:', err);
      overlay.querySelector('p').textContent = 'Camera access denied';
    }
  });

  function stopCamera() {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((t) => t.stop());
      state.cameraStream = null;
    }
    video.style.display = 'none';
    overlay.style.display = 'flex';
    captureBtn.disabled = true;
    startBtn.textContent = 'Start Camera';
    startBtn.onclick = null;
    startBtn.addEventListener('click', arguments.callee, { once: true });
    // Re-init by re-attaching
    initCameraInput();
  }

  captureBtn.addEventListener('click', async () => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    
    // Optimize: Further compression for camera snapshots
    const compressedDataUrl = await compressImage(dataUrl, 1024, 0.8);
    const base64 = compressedDataUrl.split(',')[1];

    state.cameraSnapshot = {
      base64,
      mimeType: 'image/jpeg',
    };

    snapshot.src = compressedDataUrl;
    snapshot.style.display = 'block';
    video.style.display = 'none';
    captureBtn.style.display = 'none';
    retakeBtn.style.display = 'inline-flex';

    // Stop camera
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((t) => t.stop());
      state.cameraStream = null;
    }

    updateAnalyzeButton();
  });

  retakeBtn.addEventListener('click', () => {
    state.cameraSnapshot = null;
    snapshot.style.display = 'none';
    captureBtn.style.display = 'inline-flex';
    retakeBtn.style.display = 'none';
    // Restart camera
    startBtn.click();
    updateAnalyzeButton();
  });
}

// ── Analyze Button ──
function initAnalyzeButton() {
  const btn = $('#analyze-btn');
  btn.addEventListener('click', performAnalysis);
}

function updateAnalyzeButton() {
  const btn = $('#analyze-btn');
  const hasInput = hasAnyInput();
  btn.disabled = !hasInput || state.isAnalyzing;
  updateAttachments();
}

function hasAnyInput() {
  return !!(
    state.textInput.trim() ||
    state.voiceAudio ||
    state.uploadedImage ||
    state.cameraSnapshot
  );
}

function updateAttachments() {
  const container = $('#attachments');
  const list = $('#attachments-list');
  const inputs = [];

  if (state.textInput.trim()) {
    inputs.push({ icon: '📝', label: `Text (${state.textInput.length} chars)` });
  }
  if (state.voiceAudio) {
    inputs.push({ icon: '🎤', label: `Generated Audio` });
  }
  if (state.uploadedImage) {
    inputs.push({ icon: '📷', label: state.uploadedImage.name });
  }
  if (state.cameraSnapshot) {
    inputs.push({ icon: '📸', label: 'Camera snapshot' });
  }

  if (inputs.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  list.innerHTML = inputs
    .map((i) => `<span class="attachment-chip">${i.icon} ${i.label}</span>`)
    .join('');
}

// ── Perform Analysis ──
async function performAnalysis() {
  if (state.isAnalyzing) return;

  state.isAnalyzing = true;
  const btn = $('#analyze-btn');
  const btnText = $('.analyze-btn__text');
  const btnLoading = $('.analyze-btn__loading');
  btn.disabled = true;
  btnText.style.display = 'none';
  btnLoading.style.display = 'flex';

  // Hide previous results
  $('#results-empty').style.display = 'none';
  $('#results-error').style.display = 'none';
  $('#results-content').style.display = 'none';

  try {
    // Compose text from all text sources
    const textParts = [];
    if (state.textInput.trim()) {
      textParts.push(state.textInput.trim());
    }
    const combinedText = textParts.join('\n\n');

    // Pick the image (upload takes priority over camera)
    let imageData = null;
    let mimeType = null;
    if (state.uploadedImage) {
      imageData = state.uploadedImage.base64;
      mimeType = state.uploadedImage.mimeType;
    } else if (state.cameraSnapshot) {
      imageData = state.cameraSnapshot.base64;
      mimeType = state.cameraSnapshot.mimeType;
    }

    const payload = {};
    if (combinedText) payload.text = combinedText;
    if (imageData) {
      payload.image = imageData;
      payload.imageMimeType = mimeType;
    }
    if (state.voiceAudio) {
      payload.audio = state.voiceAudio.base64;
      payload.audioMimeType = state.voiceAudio.mimeType;
    }

    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.message || data.error || 'Analysis failed');
    }

    renderResults(data);
  } catch (error) {
    showError(error.message);
  } finally {
    state.isAnalyzing = false;
    btn.disabled = !hasAnyInput();
    btnText.style.display = 'flex';
    btnLoading.style.display = 'none';
  }
}

// ── Render Results ──
function renderResults(data) {
  const analysis = data.analysis;
  const content = $('#results-content');

  // Intent
  $('#intent-value').textContent = analysis.intent || 'No intent extracted';

  // Urgency badge
  const badge = $('#urgency-badge');
  const urgency = (analysis.urgency || 'low').toLowerCase();
  badge.textContent = urgency;
  badge.className = `urgency-badge ${urgency}`;

  // Category
  $('#category-value').textContent = analysis.category || 'N/A';

  // Confidence
  const confidence = analysis.confidence != null ? analysis.confidence : 0;
  $('#confidence-value').textContent = `${(confidence * 100).toFixed(0)}%`;

  // Entities
  const entities = analysis.entities || [];
  $('#entities-count').textContent = entities.length;
  const entitiesGrid = $('#entities-grid');
  entitiesGrid.innerHTML = entities
    .map(
      (e) => `
    <div class="entity-chip">
      <span class="entity-chip__type">${escapeHtml(e.type || 'unknown')}</span>
      <span class="entity-chip__value">${escapeHtml(e.value || '')}</span>
      ${e.relevance ? `<span class="entity-chip__relevance">${escapeHtml(e.relevance)}</span>` : ''}
    </div>
  `
    )
    .join('');

  // Actions
  const actions = analysis.recommended_actions || [];
  $('#actions-count').textContent = actions.length;
  const actionsList = $('#actions-list');
  actionsList.innerHTML = actions
    .map(
      (a) => `
    <div class="action-item">
      <div class="action-item__priority">${a.priority || '—'}</div>
      <div class="action-item__content">
        <div class="action-item__text">${escapeHtml(a.action || '')}</div>
        <div class="action-item__meta">
          ${a.responsible_party ? `<span>👤 ${escapeHtml(a.responsible_party)}</span>` : ''}
          ${a.timeframe ? `<span>⏱ ${escapeHtml(a.timeframe)}</span>` : ''}
        </div>
      </div>
    </div>
  `
    )
    .join('');

  // Context flags
  const flags = analysis.context_flags || [];
  const flagsCard = $('#flags-card');
  if (flags.length > 0) {
    flagsCard.style.display = 'block';
    $('#flags-list').innerHTML = flags
      .map((f) => `<div class="flag-item">${escapeHtml(f)}</div>`)
      .join('');
  } else {
    flagsCard.style.display = 'none';
  }

  // Escalation
  const escalationAlert = $('#escalation-alert');
  if (analysis.escalation_needed) {
    escalationAlert.style.display = 'flex';
    $('#escalation-reason').textContent = analysis.escalation_reason || 'Immediate attention required';
  } else {
    escalationAlert.style.display = 'none';
  }

  // GCP Pipeline
  if (data.gcp_services) {
    const pipelineList = $('#pipeline-list');
    const pipelineCard = $('#pipeline-card');
    
    if (data.pipeline_latency) {
      $('#pipeline-latency').textContent = `${(data.pipeline_latency / 1000).toFixed(1)}s`;
    } else {
      $('#pipeline-latency').textContent = '';
    }

    pipelineList.innerHTML = data.gcp_services.map(s => `
      <div class="pipeline-item">
        <div class="pipeline-item__icon">${s.icon || ''}</div>
        <div class="pipeline-item__content">
          <div class="pipeline-item__name">
            ${escapeHtml(s.name)}
            ${s.provider ? `<span class="pipeline-item__provider">${escapeHtml(s.provider)}</span>` : ''}
          </div>
          ${s.reason ? `<div class="pipeline-item__detail">${escapeHtml(s.reason)}</div>` : ''}
          ${buildServiceDetails(s.details)}
        </div>
        <div class="pipeline-item__status">
          <span class="pipeline-status-badge ${s.status}">${s.status}</span>
          ${s.latency ? `<span class="pipeline-latency-tag">${s.latency}ms</span>` : ''}
        </div>
      </div>
    `).join('');
    
    pipelineCard.style.display = 'block';
  }

  // Raw JSON
  $('#raw-json').textContent = JSON.stringify(data, null, 2);

  // Timestamp
  $('#result-timestamp').textContent = `Analyzed at ${new Date(data.timestamp).toLocaleString()}`;

  // Show results
  content.style.display = 'flex';

  // Animate intent card border based on urgency
  const intentCard = $('#intent-card');
  const urgencyColors = {
    low: 'var(--urgency-low)',
    medium: 'var(--urgency-medium)',
    high: 'var(--urgency-high)',
    critical: 'var(--urgency-critical)',
  };
  intentCard.style.borderLeftColor = urgencyColors[urgency] || 'var(--accent-1)';
}

// ── Show Error ──
function showError(message) {
  $('#results-empty').style.display = 'none';
  $('#results-content').style.display = 'none';
  const errorEl = $('#results-error');
  errorEl.style.display = 'flex';
  $('#error-message').textContent = message;
}

// ── Utilities ──
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function buildServiceDetails(details) {
  if (!details) return '';
  const tags = [];
  if (details.model) tags.push(details.model);
  if (details.hasText && details.ocrText) tags.push('OCR Extracted');
  if (details.labelCount) tags.push(`${details.labelCount} labels`);
  if (details.objectCount) tags.push(`${details.objectCount} objects`);
  if (details.faceCount) tags.push(`${details.faceCount} faces`);
  if (details.inputModalities && details.inputModalities.length) tags.push(`Input: ${details.inputModalities.join(' + ')}`);
  if (details.note) tags.push(details.note);
  
  if (tags.length === 0) return '';
  return `<div class="pipeline-item__meta">${tags.map(t => `<span class="pipeline-meta-tag">${escapeHtml(t)}</span>`).join('')}</div>`;
}
