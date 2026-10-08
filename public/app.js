const $ = (s) => document.querySelector(s);

const els = {
  video: $('#video'),
  captureCanvas: $('#captureCanvas'),
  sampleCanvas: $('#sampleCanvas'),
  startBtn: $('#startBtn'),
  stopBtn: $('#stopBtn'),
  addPageBtn: $('#addPageBtn'),
  analyzeBtn: $('#analyzeBtn'),
  clearBtn: $('#clearBtn'),
  flipBtn: $('#flipBtn'),
  cameraSelect: $('#cameraSelect'),
  mirrorBadge: $('#mirrorBadge'),
  cameraCard: $('#cameraCard'),
  audioCard: $('#audioCard'),
  statusBadge: $('#statusBadge'),
  scanState: $('#scanState'),
  pageCount: $('#pageCount'),
  thumbnails: $('#thumbnails'),
  detectedType: $('#detectedQuestionType'),
  summary: $('#questionSummary'),
  question: $('#question'),
  options: $('#options'),
  answer: $('#answer'),
  logicWrap: $('#logicWrap'),
  logic: $('#logic'),
  codeWrap: $('#codeWrap'),
  code: $('#code'),
  explanation: $('#explanation'),
  confidence: $('#confidence'),
  message: $('#message'),
  modeHint: $('#modeHint'),
  audioStateBadge: $('#audioStateBadge'),
  manualAudioControls: $('#manualAudioControls'),
  continuousAudioControls: $('#continuousAudioControls'),
  audioStartBtn: $('#audioStartBtn'),
  audioStopBtn: $('#audioStopBtn'),
  continuousStartBtn: $('#continuousStartBtn'),
  continuousStopBtn: $('#continuousStopBtn'),
  audioState: $('#audioState'),
  audioLevel: $('#audioLevel'),
  audioTranscript: $('#audioTranscript'),
  audioClearBtn: $('#audioClearBtn')
};

const CONFIG = {
  sampleIntervalMs: 500,
  stableDiffThreshold: 2.8,
  newContentDiffThreshold: 6.0,
  mcqInitialDelayMs: 700,
  mcqRetryMs: 1800,
  mcqNewQuestionDiffThreshold: 1.9,
  mcqNoiseMultiplier: 2.2,
  mcqMinimumNoiseFloor: 0.75,
  mcqNewQuestionConfirmMs: 600,
  otherQuietMs: 3600,
  otherFirstCaptureMs: 1100,
  otherFallbackCaptureMs: 2300,
  nextQuestionStableMs: 1200,
  otherAnsweredChangeThreshold: 4.2,
  otherAnsweredStableMs: 1500,
  otherChangeCheckCooldownMs: 2200,
  maxCaptures: 8,
  captureMaxWidth: 1600,
  jpegQuality: 0.86,
  audioVadIntervalMs: 100,
  audioSpeechThreshold: 0.035,
  audioMinSpeechMs: 400,
  audioEndSilenceMs: 950,
  audioMaxUtteranceMs: 90000
};

let stream = null;
let monitorTimer = null;
let captures = [];
let captureSignatures = [];
let requestInFlight = false;
let lastFrameSignature = null;
let stableSince = 0;
let lastMeaningfulChangeAt = 0;
let lastAutoCaptureAt = 0;
let otherLastDistinctAt = 0;
let answered = false;
let answeredSignature = null;
let lastAnalyzedCaptureCount = 0;
let needsMoreContext = false;
let sessionNumber = 1;
let cameraStartedAt = 0;
let lastMcqAttemptAt = 0;
let nextQuestionCandidateSince = 0;
let recentFrameNoise = 0;
let lastResultContext = null;
let latestAnswerData = null;
let manualCaptureMode = false; // Persists until Reset question; shared by MCQ and Other.
let followupMessages = [];
let followupRecorder = null;
let followupStream = null;
let lastOtherChangeCheckAt = 0;
let otherChangeCandidateSince = 0;
let scannerMirrored = false;

// Audio state
let audioStream = null;
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let audioAnalyser = null;
let audioSourceNode = null;
let audioVadTimer = null;
let continuousAudioActive = false;
let continuousRecorderActive = false;
let speechStartedAt = 0;
let lastSpeechAt = 0;
let continuousRecordingStartedAt = 0;
let audioRequestInFlight = false;
let discardNextAudioRecording = false;

els.startBtn.addEventListener('click', startCamera);
els.stopBtn.addEventListener('click', stopCamera);
els.addPageBtn.addEventListener('click', () => addCapture({ manual: true }));
els.analyzeBtn.addEventListener('click', () => analyzeCaptures({ manual: true }));
els.clearBtn.addEventListener('click', () => resetQuestionSession('Question session cleared.'));
els.flipBtn.addEventListener('click', toggleMirrorScanner);
els.cameraSelect.addEventListener('change', async () => {
  if (stream) await startCamera({ restart: true });
});

els.audioStartBtn.addEventListener('click', startManualAudio);
els.audioStopBtn.addEventListener('click', stopManualAudio);
els.continuousStartBtn.addEventListener('click', startContinuousAudio);
els.continuousStopBtn.addEventListener('click', () => stopContinuousAudio('Continuous listening stopped.'));
$('#followupForm').addEventListener('submit', (event) => { event.preventDefault(); submitFollowup($('#followupInput').value); });
$('#followupMic').addEventListener('click', startFollowupMic);
$('#followupMicStop').addEventListener('click', () => { if (followupRecorder?.state === 'recording') followupRecorder.stop(); });
els.audioClearBtn.addEventListener('click', () => {
  clearResult();
  els.audioTranscript.textContent = 'No audio question transcribed yet.';
  els.audioTranscript.classList.add('muted');
  els.message.textContent = '';
});

document.querySelectorAll('input[name="assessmentMode"]').forEach((input) => {
  input.addEventListener('change', async () => {
    const mode = getAssessmentMode();
    if (mode === 'audio') {
      stopCamera();
      resetQuestionSession('Audio mode selected. Camera is off.');
    } else {
      await stopAllAudio();
      resetQuestionSession(`Mode changed to ${mode === 'mcq' ? 'MCQ' : 'Other'}.`);
    }
    updateModeUI();
  });
});

document.querySelectorAll('input[name="audioMode"]').forEach((input) => {
  input.addEventListener('change', async () => {
    await stopAllAudio();
    updateAudioModeUI();
  });
});

function getAssessmentMode() {
  const value = document.querySelector('input[name="assessmentMode"]:checked')?.value;
  return ['mcq', 'other', 'audio'].includes(value) ? value : 'mcq';
}

function getAudioMode() {
  return document.querySelector('input[name="audioMode"]:checked')?.value === 'continuous'
    ? 'continuous'
    : 'manual';
}

function updateModeUI() {
  const mode = getAssessmentMode();
  const isAudio = mode === 'audio';
  els.cameraCard.hidden = isAudio;
  els.audioCard.hidden = !isAudio;

  if (mode === 'mcq') {
    els.modeHint.textContent = 'MCQ mode: keep the camera on the question. It is analysed automatically, and subtle question-only changes trigger the next analysis.';
  } else if (mode === 'other') {
    els.modeHint.textContent = 'Other mode: distinct views are collected while you scroll. The answer stays locked while you remain within the same long coding/problem question.';
  } else {
    els.modeHint.textContent = 'Audio mode: camera stays off. Choose Manual Listen or Continuous Listen to transcribe spoken questions and generate answers.';
  }
}

function updateAudioModeUI() {
  const manual = getAudioMode() === 'manual';
  els.manualAudioControls.hidden = !manual;
  els.continuousAudioControls.hidden = manual;
  setAudioState(manual ? 'Manual mode ready.' : 'Continuous mode ready. Press Start continuous listening.');
}

async function enumerateCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === 'videoinput');
    const current = els.cameraSelect.value;
    els.cameraSelect.innerHTML = '<option value="">Automatic camera</option>';
    cameras.forEach((camera, index) => {
      const option = document.createElement('option');
      option.value = camera.deviceId;
      option.textContent = camera.label || `Camera ${index + 1}`;
      els.cameraSelect.appendChild(option);
    });
    if ([...els.cameraSelect.options].some((o) => o.value === current)) {
      els.cameraSelect.value = current;
    }
  } catch (e) {
    console.warn('Camera enumeration failed:', e);
  }
}

async function startCamera({ restart = false } = {}) {
  clearMessage();
  if (getAssessmentMode() === 'audio') return;

  if (!navigator.mediaDevices?.getUserMedia) {
    return setError('Camera API unavailable. Open the deployed HTTPS page in a supported browser.');
  }

  try {
    if (restart) stopCamera({ preserveStatus: true });

    const deviceId = els.cameraSelect.value;
    stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });

    els.video.srcObject = stream;
    await els.video.play();
    await enumerateCameras();

    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.addPageBtn.disabled = false;

    lastFrameSignature = null;
    stableSince = performance.now();
    lastMeaningfulChangeAt = performance.now();
    cameraStartedAt = performance.now();
    lastAutoCaptureAt = 0;
    otherLastDistinctAt = cameraStartedAt;
    lastMcqAttemptAt = 0;
    nextQuestionCandidateSince = 0;
    recentFrameNoise = 0;
    lastOtherChangeCheckAt = 0;
    otherChangeCandidateSince = 0;

    setStatus('running', 'Scanning');
    setScanState(getAssessmentMode() === 'mcq'
      ? 'Camera is live. Point it at the MCQ — analysis will start automatically.'
      : 'Camera is live. Hold the first part of the question in the frame, then scroll through the remaining content.');
    startMonitoring();
  } catch (e) {
    setError(`Camera could not start: ${e.message}`);
  }
}

function stopCamera({ preserveStatus = false } = {}) {
  stopMonitoring();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  els.video.srcObject = null;
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.addPageBtn.disabled = true;
  if (!preserveStatus) {
    setStatus('idle', 'Idle');
    setScanState('Camera stopped.');
  }
}

function toggleMirrorScanner() {
  scannerMirrored = !scannerMirrored;
  els.video.classList.toggle('mirrored', scannerMirrored);
  els.mirrorBadge.hidden = !scannerMirrored;
  els.flipBtn.textContent = scannerMirrored ? 'Use normal scanner' : 'Flip scanner';
  lastFrameSignature = null;
  answeredSignature = answered && stream ? createFrameSignature() : null;
  nextQuestionCandidateSince = 0;
  setScanState(scannerMirrored
    ? 'Mirror correction enabled. Captured frames will be horizontally reversed before analysis.'
    : 'Normal scanner orientation restored.');
}

function startMonitoring() {
  stopMonitoring();
  monitorTimer = window.setInterval(monitorFrame, CONFIG.sampleIntervalMs);
}

function stopMonitoring() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}

async function monitorFrame() {
  if (!stream || requestInFlight || !els.video.videoWidth || getAssessmentMode() === 'audio') return;

  const now = performance.now();
  const signature = createFrameSignature();
  if (!signature) return;

  if (!lastFrameSignature) {
    lastFrameSignature = signature;
    stableSince = now;
    lastMeaningfulChangeAt = now;
    return;
  }

  const frameDiff = signatureDiff(lastFrameSignature, signature);
  recentFrameNoise = recentFrameNoise === 0
    ? frameDiff
    : (recentFrameNoise * 0.82) + (frameDiff * 0.18);

  const stable = frameDiff <= CONFIG.stableDiffThreshold;
  if (stable) {
    if (!stableSince) stableSince = now;
  } else {
    stableSince = now;
    lastMeaningfulChangeAt = now;
  }

  lastFrameSignature = signature;

  if (manualCaptureMode) {
    setScanState(answered ? 'Manual answer locked. Captures remain until Reset question.' : 'Manual collection active. Add views, then press Analyse now. Only Reset question clears captures.');
    return;
  }
  if (answered) {
    await watchForNextQuestion(signature, now);
    return;
  }

  if (getAssessmentMode() === 'mcq') await monitorMcq(signature, now);
  else await monitorOther(signature, now);
}

async function watchForNextQuestion(signature, now) {
  if (!answeredSignature) return;
  const diffFromAnswered = signatureDiff(answeredSignature, signature);

  if (getAssessmentMode() === 'mcq') {
    const adaptiveThreshold = Math.max(
      CONFIG.mcqNewQuestionDiffThreshold,
      Math.max(recentFrameNoise, CONFIG.mcqMinimumNoiseFloor) * CONFIG.mcqNoiseMultiplier
    );

    if (diffFromAnswered >= adaptiveThreshold) {
      if (!nextQuestionCandidateSince) nextQuestionCandidateSince = now;
      setScanState(`Possible new MCQ detected (${diffFromAnswered.toFixed(1)} change). Confirming…`);

      if (now - nextQuestionCandidateSince >= CONFIG.mcqNewQuestionConfirmMs) {
        nextQuestionCandidateSince = 0;
        setScanState('Checking whether the MCQ has actually changed; keeping answer visible…');
        const verdict = await classifyOtherQuestionChange();
        if (verdict !== 'new_question') {
          if (verdict === 'same_question') answeredSignature = new Uint8Array(signature);
          setScanState('Answer locked. No confirmed new question.');
          return;
        }
        sessionNumber += 1;
        captures = [];
        captureSignatures = [];
        lastAnalyzedCaptureCount = 0;
        needsMoreContext = false;
        answered = false;
        answeredSignature = null;
        nextQuestionCandidateSince = 0;
        clearResult();
        renderCaptures();
        setScanState(`New MCQ detected. Analysing question ${sessionNumber}…`);
        const added = await addCapture({ automatic: true, signature });
        if (added) {
          lastMcqAttemptAt = now;
          await analyzeCaptures({ automatic: true });
        }
      }
    } else {
      nextQuestionCandidateSince = 0;
    }
    return;
  }

  const stableFor = now - stableSince;
  const changedEnough = diffFromAnswered >= CONFIG.otherAnsweredChangeThreshold;
  const cooldownReady = now - lastOtherChangeCheckAt >= CONFIG.otherChangeCheckCooldownMs;

  if (!changedEnough) {
    otherChangeCandidateSince = 0;
    return;
  }
  if (!otherChangeCandidateSince) otherChangeCandidateSince = now;

  if (stableFor < CONFIG.otherAnsweredStableMs || now - otherChangeCandidateSince < CONFIG.otherAnsweredStableMs || !cooldownReady) {
    setScanState('Answer locked. Changed view detected; waiting briefly before checking whether this is a new question…');
    return;
  }

  lastOtherChangeCheckAt = now;
  otherChangeCandidateSince = 0;
  setScanState('Answer locked. Checking whether this is the same question or a new one…');
  const verdict = await classifyOtherQuestionChange();

  if (verdict === 'new_question') {
    sessionNumber += 1;
    captures = [];
    captureSignatures = [];
    lastAnalyzedCaptureCount = 0;
    needsMoreContext = false;
    answered = false;
    answeredSignature = null;
    lastResultContext = null;
    clearResult();
    renderCaptures();
    setScanState(`New question confirmed. Starting question session ${sessionNumber}.`);
    await addCapture({ automatic: true, signature });
    lastMeaningfulChangeAt = now;
    return;
  }

  if (verdict === 'same_question') {
    answeredSignature = new Uint8Array(signature);
    setScanState('Same question confirmed. Answer remains locked while you continue scrolling.');
  } else {
    setScanState('Question change is uncertain. Keeping the current answer until a clearly new question is confirmed.');
  }
}

async function classifyOtherQuestionChange() {
  if (requestInFlight || !lastResultContext) return 'uncertain';
  requestInFlight = true;
  renderCaptures();
  try {
    const response = await fetch('/api/classify-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: captureJpeg(),
        previousQuestion: lastResultContext.question || '',
        previousSummary: lastResultContext.summary || '',
        previousType: lastResultContext.type || 'other'
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Question-change check failed.');
    return data.verdict || 'uncertain';
  } catch (e) {
    console.warn('Question-change check failed:', e);
    return 'uncertain';
  } finally {
    requestInFlight = false;
    renderCaptures();
    if (stream && !els.statusBadge.classList.contains('error')) setStatus('running', 'Scanning');
  }
}

async function monitorMcq(signature, now) {
  if (!captures.length) {
    const ready = now - cameraStartedAt >= CONFIG.mcqInitialDelayMs;
    const retryReady = !lastMcqAttemptAt || now - lastMcqAttemptAt >= CONFIG.mcqRetryMs;
    if (ready && retryReady) {
      setScanState('MCQ detected in camera view. Analysing…');
      const added = await addCapture({ automatic: true, signature });
      if (added) {
        lastMcqAttemptAt = now;
        await analyzeCaptures({ automatic: true });
      }
    } else setScanState('MCQ mode: reading the question…');
    return;
  }

  if (needsMoreContext) {
    const lastCaptureSignature = captureSignatures[captureSignatures.length - 1];
    const distinct = !lastCaptureSignature || signatureDiff(lastCaptureSignature, signature) >= CONFIG.newContentDiffThreshold;
    const retryReady = now - lastMcqAttemptAt >= CONFIG.mcqRetryMs;
    if (distinct && retryReady && captures.length < CONFIG.maxCaptures) {
      const added = await addCapture({ automatic: true, signature });
      if (added) {
        lastMcqAttemptAt = now;
        setScanState('Additional MCQ context detected. Re-analysing…');
        await analyzeCaptures({ automatic: true });
      }
    }
    return;
  }

  if (lastAnalyzedCaptureCount < captures.length) await analyzeCaptures({ automatic: true });
}

async function monitorOther(signature, now) {
  // Automatic mode must always capture the first usable frame, even when
  // autofocus/monitor flicker prevents a long "stable" interval.
  if (!captures.length) {
    if (now - cameraStartedAt < CONFIG.otherFirstCaptureMs) {
      setScanState('Other mode: preparing the first automatic capture…');
      return;
    }
    if (await addCapture({ automatic: true, signature })) {
      lastAutoCaptureAt = now;
      otherLastDistinctAt = now;
      lastMeaningfulChangeAt = now;
      setScanState('Other mode: first view captured automatically. Scroll to show more, or hold still to analyse.');
    }
    return;
  }

  const lastCaptureSignature = captureSignatures[captureSignatures.length - 1];
  const diff = lastCaptureSignature ? signatureDiff(lastCaptureSignature, signature) : Infinity;
  const distinct = diff >= CONFIG.newContentDiffThreshold;
  const captureCooldownElapsed = now - lastAutoCaptureAt >= 900;
  const stableEnough = now - stableSince >= 550;
  // Fall back to a timed capture when the camera never reaches pixel stability.
  const fallbackReady = now - lastAutoCaptureAt >= CONFIG.otherFallbackCaptureMs;
  if (distinct && captureCooldownElapsed && (stableEnough || fallbackReady) && captures.length < CONFIG.maxCaptures) {
    if (await addCapture({ automatic: true, signature })) {
      lastAutoCaptureAt = now;
      otherLastDistinctAt = now;
      lastMeaningfulChangeAt = now;
      setScanState(`Other mode: automatically captured view ${captures.length}. Continue scrolling, or hold steady for analysis.`);
    }
    return;
  }

  // A static camera can have ongoing tiny frame changes. Use the last
  // distinct capture time, not a constantly refreshed motion timestamp.
  const quietFor = now - Math.max(lastAutoCaptureAt, otherLastDistinctAt);
  if (captures.length && quietFor >= CONFIG.otherQuietMs && lastAnalyzedCaptureCount < captures.length) {
    setScanState(`Other mode: ${captures.length} view${captures.length === 1 ? '' : 's'} collected automatically. Analysing…`);
    await analyzeCaptures({ automatic: true });
    return;
  }

  const seconds = Math.max(0, Math.ceil((CONFIG.otherQuietMs - quietFor) / 1000));
  setScanState(`Other mode: ${captures.length} automatic view${captures.length === 1 ? '' : 's'} saved. Scroll for more, or wait ~${seconds}s for analysis.`);
}

function drawVideoFrame(ctx, sx, sy, sw, sh, dx, dy, dw, dh) {
  if (scannerMirrored) {
    ctx.save();
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(els.video, sx, sy, sw, sh, 0, 0, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(els.video, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}

function createFrameSignature() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) return null;
  const canvas = els.sampleCanvas;
  const cropX = vw * 0.06;
  const cropY = vh * 0.10;
  const cropW = vw * 0.88;
  const cropH = vh * 0.76;
  const w = 96;
  const h = 72;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  drawVideoFrame(ctx, cropX, cropY, cropW, cropH, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const signature = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    signature[p] = Math.round((data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114));
  }
  return signature;
}

function signatureDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function captureJpeg() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) throw new Error('Camera frame is not ready.');
  const scale = Math.min(1, CONFIG.captureMaxWidth / vw);
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  const canvas = els.captureCanvas;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  drawVideoFrame(ctx, 0, 0, vw, vh, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', CONFIG.jpegQuality);
}

async function addCapture({ manual = false, automatic = false, signature = null } = {}) {
  if (!stream || captures.length >= CONFIG.maxCaptures || requestInFlight) return false;
  try {
    const image = captureJpeg();
    captures.push(image);
    captureSignatures.push(signature || createFrameSignature());
    renderCaptures();
    if (manual) {
      manualCaptureMode = true;
      lastMeaningfulChangeAt = performance.now();
      els.message.textContent = `Manual capture ${captures.length} added.`;
    } else if (automatic) els.message.textContent = `Automatically captured view ${captures.length}.`;
    return true;
  } catch (e) {
    setError(e.message);
    return false;
  }
}

function renderCaptures() {
  els.pageCount.textContent = `${captures.length} captured view${captures.length === 1 ? '' : 's'}`;
  els.thumbnails.innerHTML = '';
  captures.forEach((src, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    const img = document.createElement('img');
    img.src = src;
    img.alt = `Captured view ${i + 1}`;
    const label = document.createElement('span');
    label.textContent = `View ${i + 1}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', `Remove capture ${i + 1}`);
    remove.disabled = true;
    remove.title = 'Captured views are retained until Reset question';
    remove.setAttribute('aria-label', 'Use Reset question to clear captured views');
    wrap.append(img, label, remove);
    els.thumbnails.appendChild(wrap);
  });
  els.analyzeBtn.disabled = captures.length === 0 || requestInFlight;
  els.clearBtn.disabled = requestInFlight;
  els.addPageBtn.disabled = !stream || captures.length >= CONFIG.maxCaptures || requestInFlight;
}

function resetQuestionSession(message = '') {
  manualCaptureMode = false;
  captures = [];
  captureSignatures = [];
  answered = false;
  answeredSignature = null;
  lastAnalyzedCaptureCount = 0;
  needsMoreContext = false;
  lastMeaningfulChangeAt = performance.now();
  stableSince = performance.now();
  lastMcqAttemptAt = 0;
  nextQuestionCandidateSince = 0;
  recentFrameNoise = 0;
  lastResultContext = null;
  lastOtherChangeCheckAt = 0;
  otherChangeCandidateSince = 0;
  cameraStartedAt = performance.now();
  renderCaptures();
  clearResult();
  if (message) els.message.textContent = message;
}

async function analyzeCaptures({ manual = false } = {}) {
  if (requestInFlight || !captures.length) return;
  requestInFlight = true;
  renderCaptures();
  setStatus('busy', 'Analysing');
  const mode = getAssessmentMode();
  const imagesForRequest = [...captures];
  const analyzedSignature = captureSignatures[captureSignatures.length - 1]
    ? new Uint8Array(captureSignatures[captureSignatures.length - 1])
    : (lastFrameSignature ? new Uint8Array(lastFrameSignature) : null);
  lastAnalyzedCaptureCount = imagesForRequest.length;
  els.message.textContent = `Analysing ${imagesForRequest.length} captured view${imagesForRequest.length === 1 ? '' : 's'} in ${mode === 'mcq' ? 'MCQ' : 'Other'} mode…`;

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: imagesForRequest, assessmentMode: mode })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Analysis failed.');

    if (!data.question_detected) {
      answered = false;
      els.message.textContent = data.missing_context || 'No readable assessment question detected yet.';
      if (mode === 'mcq' && !manualCaptureMode) {
        captures = [];
        captureSignatures = [];
        lastAnalyzedCaptureCount = 0;
        needsMoreContext = false;
        renderCaptures();
        setScanState('MCQ not readable yet. Keeping camera live and retrying automatically…');
      } else setScanState('Keep the camera on the question or continue scrolling for more context.');
      return;
    }

    renderResult(data);
    lastResultContext = { question: data.question || '', summary: data.question_summary || '', type: data.question_type || 'other' };

    if (data.needs_more_pages) {
      answered = false;
      needsMoreContext = true;
      els.message.textContent = `More context needed: ${data.missing_context || 'continue scrolling through the remaining question/code/options.'}`;
      setScanState(manualCaptureMode ? 'More context needed. Add another view manually, then press Analyse now.' : 'Keep scrolling. New distinct views will be added to the same question automatically.');
      return;
    }

    needsMoreContext = false;
    answered = true;
    answeredSignature = analyzedSignature || (lastFrameSignature ? new Uint8Array(lastFrameSignature) : createFrameSignature());
    nextQuestionCandidateSince = 0;
    otherChangeCandidateSince = 0;
    lastOtherChangeCheckAt = performance.now();
    els.message.textContent = manualCaptureMode ? 'Manual answer locked. Captures remain until Reset question.' : mode === 'other'
      ? 'Answer ready and locked. Scroll within the same question freely; it will remain visible.'
      : 'Answer ready. Move to the next question; the camera will detect the change automatically.';
    setScanState(manualCaptureMode ? 'Manual answer locked until Reset question.' : mode === 'other'
      ? 'Answer locked. Watching for a genuinely new question…'
      : 'Answer ready. Watching for the next question…');
  } catch (e) {
    lastAnalyzedCaptureCount = Math.max(0, lastAnalyzedCaptureCount - 1);
    setError(e.message);
  } finally {
    requestInFlight = false;
    renderCaptures();
    if (stream && !els.statusBadge.classList.contains('error')) setStatus('running', 'Scanning');
    else if (!stream && getAssessmentMode() !== 'audio') setStatus('idle', 'Idle');
    if (manual && stream) lastMeaningfulChangeAt = performance.now();
  }
}

// ---------------- Audio ----------------

function supportedAudioMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

async function getAudioStream() {
  if (audioStream?.active) return audioStream;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error('Microphone recording is unavailable in this browser. Use the HTTPS deployment in a modern browser.');
  }
  audioStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  return audioStream;
}

function createRecorder(targetStream, onStop) {
  const mimeType = supportedAudioMimeType();
  const recorder = mimeType ? new MediaRecorder(targetStream, { mimeType }) : new MediaRecorder(targetStream);
  const chunks = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data?.size) chunks.push(event.data);
  });
  recorder.addEventListener('stop', async () => {
    const type = recorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(chunks, { type });
    if (discardNextAudioRecording) {
      discardNextAudioRecording = false;
      return;
    }
    await onStop(blob);
  }, { once: true });
  return recorder;
}

async function startManualAudio() {
  if (audioRequestInFlight || mediaRecorder?.state === 'recording') return;
  try {
    const mic = await getAudioStream();
    mediaRecorder = createRecorder(mic, async (blob) => {
      mediaRecorder = null;
      els.audioStartBtn.disabled = false;
      els.audioStopBtn.disabled = true;
      if (blob.size > 1000) await submitAudioQuestion(blob, { continuous: false });
      else setAudioState('Recording was too short. Try again.');
    });
    mediaRecorder.start(250);
    els.audioStartBtn.disabled = true;
    els.audioStopBtn.disabled = false;
    setAudioBadge('running', 'Listening');
    setAudioState('Listening… Press Stop & analyse after the complete question has been spoken.');
    setStatus('running', 'Listening');
  } catch (e) {
    setError(e.message);
    setAudioState(e.message);
  }
}

function stopManualAudio() {
  if (mediaRecorder?.state === 'recording') {
    setAudioState('Finishing recording…');
    mediaRecorder.stop();
  }
}

async function startContinuousAudio() {
  if (continuousAudioActive) return;
  try {
    const mic = await getAudioStream();
    continuousAudioActive = true;
    els.continuousStartBtn.disabled = true;
    els.continuousStopBtn.disabled = false;
    setAudioBadge('running', 'Listening');
    setStatus('running', 'Listening');
    setAudioState('Continuous listening active. Waiting for a spoken question…');

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 1024;
    audioAnalyser.smoothingTimeConstant = 0.55;
    audioSourceNode = audioContext.createMediaStreamSource(mic);
    audioSourceNode.connect(audioAnalyser);
    const samples = new Uint8Array(audioAnalyser.fftSize);

    audioVadTimer = window.setInterval(async () => {
      if (!continuousAudioActive || !audioAnalyser) return;
      audioAnalyser.getByteTimeDomainData(samples);
      let sumSquares = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const n = (samples[i] - 128) / 128;
        sumSquares += n * n;
      }
      const rms = Math.sqrt(sumSquares / samples.length);
      els.audioLevel.style.width = `${Math.min(100, Math.max(2, rms * 700))}%`;
      const now = performance.now();
      const speaking = rms >= CONFIG.audioSpeechThreshold;

      if (speaking) {
        lastSpeechAt = now;
        if (!continuousRecorderActive && !audioRequestInFlight) {
          speechStartedAt = now;
          continuousRecordingStartedAt = now;
          startContinuousSegment();
        }
        if (continuousRecorderActive) setAudioState('Speech detected. Listening for the complete question…');
      }

      if (continuousRecorderActive) {
        const speechDuration = Math.max(0, lastSpeechAt - speechStartedAt);
        const silenceDuration = now - lastSpeechAt;
        const maxReached = now - continuousRecordingStartedAt >= CONFIG.audioMaxUtteranceMs;
        if ((speechDuration >= CONFIG.audioMinSpeechMs && silenceDuration >= CONFIG.audioEndSilenceMs) || maxReached) {
          finishContinuousSegment();
        }
      }
    }, CONFIG.audioVadIntervalMs);
  } catch (e) {
    await stopContinuousAudio();
    setError(e.message);
    setAudioState(e.message);
  }
}

function startContinuousSegment() {
  if (!audioStream?.active || continuousRecorderActive) return;
  continuousRecorderActive = true;
  mediaRecorder = createRecorder(audioStream, async (blob) => {
    continuousRecorderActive = false;
    mediaRecorder = null;
    if (!continuousAudioActive) return;
    if (blob.size < 1200) {
      setAudioState('Very short sound ignored. Listening for a question…');
      return;
    }
    await submitAudioQuestion(blob, { continuous: true });
    if (continuousAudioActive) setAudioState('Answer ready. Listening for the next spoken question…');
  });
  mediaRecorder.start(250);
}

function finishContinuousSegment() {
  if (mediaRecorder?.state === 'recording') {
    setAudioState('End of question detected. Transcribing…');
    mediaRecorder.stop();
  }
}

async function stopContinuousAudio(message = '') {
  continuousAudioActive = false;
  if (audioVadTimer) clearInterval(audioVadTimer);
  audioVadTimer = null;
  if (mediaRecorder?.state === 'recording') {
    discardNextAudioRecording = true;
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  continuousRecorderActive = false;
  if (audioSourceNode) {
    try { audioSourceNode.disconnect(); } catch {}
  }
  audioSourceNode = null;
  audioAnalyser = null;
  if (audioContext) {
    try { await audioContext.close(); } catch {}
  }
  audioContext = null;
  els.audioLevel.style.width = '0%';
  els.continuousStartBtn.disabled = false;
  els.continuousStopBtn.disabled = true;
  if (message) setAudioState(message);
  setAudioBadge('idle', 'Stopped');
  if (getAssessmentMode() === 'audio') setStatus('idle', 'Idle');
}

async function stopAllAudio() {
  if (mediaRecorder?.state === 'recording') {
    discardNextAudioRecording = true;
    try { mediaRecorder.stop(); } catch {}
  }
  mediaRecorder = null;
  await stopContinuousAudio();
  audioStream?.getTracks().forEach((t) => t.stop());
  audioStream = null;
  els.audioStartBtn.disabled = false;
  els.audioStopBtn.disabled = true;
  els.audioLevel.style.width = '0%';
}

async function submitAudioQuestion(blob, { continuous = false } = {}) {
  if (audioRequestInFlight) return;
  audioRequestInFlight = true;
  setAudioBadge('busy', 'Analysing');
  setStatus('busy', 'Analysing');
  setAudioState('Transcribing and analysing the spoken question…');

  try {
    const dataUrl = await blobToDataUrl(blob);
    const response = await fetch('/api/audio/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioDataUrl: dataUrl, audioMode: continuous ? 'continuous' : 'manual' })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Audio analysis failed.');

    const transcript = data.transcript || '';
    els.audioTranscript.textContent = transcript || 'No clear speech was transcribed.';
    els.audioTranscript.classList.toggle('muted', !transcript);

    if (!data.question_detected) {
      els.message.textContent = data.missing_context || 'No complete question was detected in the recording.';
      setAudioState(continuous ? 'No complete question detected. Listening continues…' : 'No complete question detected. Record again.');
      return;
    }

    // The existing answer remains visible until a complete replacement result is available.
    renderResult(data);
    els.message.textContent = continuous
      ? 'Answer ready and locked until the next complete spoken question is successfully analysed.'
      : 'Answer ready. Start another manual recording when you want to replace it.';
    setAudioState(continuous ? 'Answer ready. Listening for the next spoken question…' : 'Answer ready.');
  } catch (e) {
    // Never clear the previous answer on a failed/partial audio request.
    els.message.textContent = e.message;
    setAudioState(continuous ? 'Audio analysis failed; previous answer kept. Listening continues…' : 'Audio analysis failed; previous answer kept.');
  } finally {
    audioRequestInFlight = false;
    if (continuousAudioActive) {
      setAudioBadge('running', 'Listening');
      setStatus('running', 'Listening');
    } else {
      setAudioBadge('idle', 'Ready');
      setStatus('idle', 'Idle');
    }
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read audio recording.'));
    reader.readAsDataURL(blob);
  });
}

function setAudioBadge(kind, text) {
  els.audioStateBadge.className = `badge ${kind}`;
  els.audioStateBadge.textContent = text;
}

function setAudioState(text) {
  els.audioState.textContent = text;
}

// ---------------- Shared result helpers ----------------

function applyAnswerVariant(v) {
  els.answer.textContent = v.answer || '—';
  els.logic.textContent = v.logic || '';
  els.logicWrap.hidden = !v.logic;
  els.code.textContent = v.code || '';
  els.codeWrap.hidden = !v.code;
  els.explanation.textContent = v.explanation || '';
}

$('#answerVariantSelect').addEventListener('change', (event) => {
  const variants = latestAnswerData?.answer_variants;
  const index = Number(event.target.value);
  if (Array.isArray(variants) && variants[index]) applyAnswerVariant(variants[index]);
});

function renderResult(data) {
  latestAnswerData = data;
  followupMessages = [];
  $('#followupHistory').innerHTML = '';
  $('#followupStatus').textContent = '';
  els.detectedType.textContent = humanType(data.question_type || 'other');
  els.summary.textContent = data.question_summary || '';
  els.question.textContent = data.question || 'Question detected.';
  els.question.classList.remove('muted');
  els.options.innerHTML = '';
  for (const option of Array.isArray(data.options) ? data.options : []) {
    const d = document.createElement('div');
    d.className = 'option';
    d.textContent = option;
    els.options.appendChild(d);
  }
  const variantWrap = $('#answerVariantWrap');
  const variantSelect = $('#answerVariantSelect');
  const variants = Array.isArray(data.answer_variants) ? data.answer_variants.filter(v => v && typeof v.answer === 'string') : [];
  variantWrap.hidden = variants.length < 2;
  variantSelect.replaceChildren();
  for (const [index, variant] of variants.entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = variant.label || `Option ${index + 1}`;
    variantSelect.appendChild(option);
  }
  variantSelect.value = '0';
  applyAnswerVariant(variants[0] || data);
  els.confidence.textContent = data.confidence || '—';
}

function clearResult() {
  $('#answerVariantWrap').hidden = true;
  $('#answerVariantSelect').replaceChildren();
  latestAnswerData = null;
  followupMessages = [];
  $('#followupHistory').innerHTML = '';
  $('#followupStatus').textContent = '';
  els.detectedType.textContent = '—';
  els.summary.textContent = '';
  els.question.textContent = 'No question analysed yet.';
  els.question.classList.add('muted');
  els.options.innerHTML = '';
  els.answer.textContent = '—';
  els.logic.textContent = '';
  els.logicWrap.hidden = true;
  els.code.textContent = '';
  els.codeWrap.hidden = true;
  els.explanation.textContent = '';
  els.confidence.textContent = '—';
}

function humanType(t) {
  return ({
    mcq: 'MCQ', fill_code: 'Fill code', implement_method: 'Implement method', write_program: 'Write program',
    runtime_error: 'Runtime error', compile_error: 'Compile error', output_prediction: 'Output prediction',
    conceptual: 'Conceptual', problem_analysis: 'Problem analysis', other: 'Other'
  })[t] || t;
}

function setStatus(kind, text) {
  els.statusBadge.className = `badge ${kind}`;
  els.statusBadge.textContent = text;
}

function setScanState(text) {
  if (els.scanState) els.scanState.textContent = text;
}

function setError(message) {
  setStatus('error', 'Error');
  els.message.textContent = message;
}

function clearMessage() {
  els.message.textContent = '';
}

updateModeUI();
updateAudioModeUI();
renderCaptures();
clearResult();
enumerateCameras();

// Follow-ups use the saved result, never trigger a fresh camera scan or clear the answer.
async function submitFollowup(text, audioBlob = null) {
  const status = $('#followupStatus');
  if (!latestAnswerData) { status.textContent = 'Analyse a question first.'; return; }
  if (!text.trim() && !audioBlob) return;
  const button = $('#followupSend');
  button.disabled = true;
  status.textContent = audioBlob ? 'Transcribing your follow-up…' : 'Refining answer…';
  try {
    const payload = { question: latestAnswerData, history: followupMessages.slice(-8), instruction: text.trim() };
    if (audioBlob) payload.audioDataUrl = await blobToDataUrl(audioBlob);
    const response = await fetch('/api/followup', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Follow-up failed.');
    const userText = data.transcript || text.trim();
    followupMessages.push({ role:'user', text:userText }, { role:'assistant', text:data.answer });
    for (const [who, value] of [['You',userText],['Assistant',data.answer]]) {
      const div = document.createElement('div'); div.className = 'followup-entry';
      const label = document.createElement('strong'); label.textContent = who + ': ';
      const body = document.createElement('span'); body.textContent = value;
      div.append(label,body); $('#followupHistory').appendChild(div);
    }
    $('#followupInput').value = '';
    status.textContent = 'Follow-up ready. Original answer remains above.';
  } catch(e) { status.textContent = e.message; }
  finally { button.disabled = false; }
}
async function startFollowupMic() {
  try {
    if (!latestAnswerData) throw new Error('Analyse a question first.');
    followupStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
    const mimeType = supportedAudioMimeType();
    const recorder = new MediaRecorder(followupStream, mimeType ? { mimeType } : {});
    followupRecorder = recorder;
    const parts = [];
    recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    recorder.onstop = async () => {
      $('#followupMic').hidden = false; $('#followupMicStop').hidden = true;
      followupStream?.getTracks().forEach(t => t.stop()); followupStream = null;
      if (parts.length) await submitFollowup('', new Blob(parts, { type:recorder.mimeType || 'audio/webm' }));
    };
    recorder.start(); $('#followupMic').hidden = true; $('#followupMicStop').hidden = false;
    $('#followupStatus').textContent = 'Listening to your follow-up…';
  } catch(e) { $('#followupStatus').textContent = e.message; }
}
