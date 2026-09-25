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
  modeHint: $('#modeHint')
};

const CONFIG = {
  // Camera sampling stays local in the browser. MCQ mode deliberately does NOT
  // require a perfectly motionless frame because autofocus/exposure changes on
  // phones can otherwise keep resetting a strict stability timer forever.
  sampleIntervalMs: 500,
  stableDiffThreshold: 2.8,
  newContentDiffThreshold: 6.0,
  mcqInitialDelayMs: 700,
  mcqRetryMs: 1800,
  // MCQ next-question detection is intentionally sensitive because many
  // assessment pages keep the header/sidebar/buttons unchanged and replace
  // only the question text. This threshold is applied to a cropped
  // question-focused signature, not the whole camera frame.
  mcqNewQuestionDiffThreshold: 1.9,
  mcqNoiseMultiplier: 2.2,
  mcqMinimumNoiseFloor: 0.75,
  mcqNewQuestionConfirmMs: 600,
  otherQuietMs: 5200,
  nextQuestionStableMs: 1200,
  // Once an Other-mode answer is ready, visual scrolling alone must never
  // clear it. A changed stable view is semantically checked first.
  otherAnsweredChangeThreshold: 4.2,
  otherAnsweredStableMs: 1500,
  otherChangeCheckCooldownMs: 2200,
  maxCaptures: 8,
  captureMaxWidth: 1600,
  jpegQuality: 0.86
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
let lastOtherChangeCheckAt = 0;
let otherChangeCandidateSince = 0;

els.startBtn.addEventListener('click', startCamera);
els.stopBtn.addEventListener('click', stopCamera);
els.addPageBtn.addEventListener('click', () => addCapture({ manual: true }));
els.analyzeBtn.addEventListener('click', () => analyzeCaptures({ manual: true }));
els.clearBtn.addEventListener('click', () => resetQuestionSession('Question session cleared.'));

document.querySelectorAll('input[name="assessmentMode"]').forEach((input) => {
  input.addEventListener('change', () => {
    resetQuestionSession(`Mode changed to ${getAssessmentMode() === 'mcq' ? 'MCQ' : 'Other'}. Continuous scanning remains active.`);
    updateModeHint();
  });
});

function getAssessmentMode() {
  return document.querySelector('input[name="assessmentMode"]:checked')?.value === 'mcq'
    ? 'mcq'
    : 'other';
}

function updateModeHint() {
  if (getAssessmentMode() === 'mcq') {
    els.modeHint.textContent = 'MCQ mode: keep the camera pointed at the question. It is analysed automatically without waiting for perfect camera stability; moving to the next question triggers the next analysis automatically.';
  } else {
    els.modeHint.textContent = 'Other mode: the camera continuously collects distinct stable views while you scroll. After the screen stops changing, the accumulated context is analysed together.';
  }
}

async function startCamera() {
  clearMessage();

  if (!navigator.mediaDevices?.getUserMedia) {
    return setError('Camera API unavailable. On mobile, open this page over HTTPS.');
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });

    els.video.srcObject = stream;
    await els.video.play();

    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.addPageBtn.disabled = false;

    lastFrameSignature = null;
    stableSince = performance.now();
    lastMeaningfulChangeAt = performance.now();
    cameraStartedAt = performance.now();
    lastMcqAttemptAt = 0;
    nextQuestionCandidateSince = 0;
    recentFrameNoise = 0;
    lastOtherChangeCheckAt = 0;
    otherChangeCandidateSince = 0;

    setStatus('running', 'Scanning');
    setScanState(getAssessmentMode() === 'mcq'
      ? 'Camera is live. Point it at the MCQ — analysis will start automatically.'
      : 'Camera is live. Hold the first part of the question in the frame.');
    startMonitoring();
  } catch (e) {
    setError(`Camera could not start: ${e.message}`);
  }
}

function stopCamera() {
  stopMonitoring();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  els.video.srcObject = null;
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.addPageBtn.disabled = true;
  setStatus('idle', 'Idle');
  setScanState('Camera stopped.');
}

function startMonitoring() {
  stopMonitoring();
  monitorTimer = window.setInterval(monitorFrame, CONFIG.sampleIntervalMs);
}

function stopMonitoring() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

async function monitorFrame() {
  if (!stream || requestInFlight || !els.video.videoWidth) return;

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

  // Maintain a slowly changing estimate of normal camera noise caused by
  // autofocus, exposure and tiny hand movements. New-question detection can
  // then be more sensitive without firing on every small camera fluctuation.
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

  if (answered) {
    await watchForNextQuestion(signature, now);
    return;
  }

  if (getAssessmentMode() === 'mcq') {
    await monitorMcq(signature, now);
  } else {
    await monitorOther(signature, now);
  }
}

async function watchForNextQuestion(signature, now) {
  if (!answeredSignature) return;

  const diffFromAnswered = signatureDiff(answeredSignature, signature);

  // MCQ mode favours responsiveness: a changed screen only needs to remain
  // meaningfully different for a short confirmation window. We do not wait for
  // pixel-perfect stability, which is unreliable with a handheld phone camera.
  if (getAssessmentMode() === 'mcq') {
    // Use whichever is stricter: the absolute text-change threshold or an
    // adaptive threshold based on current camera noise. A genuine question
    // replacement generally stays different from the answered frame across
    // several samples, while autofocus/exposure noise oscillates around it.
    const adaptiveThreshold = Math.max(
      CONFIG.mcqNewQuestionDiffThreshold,
      Math.max(recentFrameNoise, CONFIG.mcqMinimumNoiseFloor) * CONFIG.mcqNoiseMultiplier
    );

    if (diffFromAnswered >= adaptiveThreshold) {
      if (!nextQuestionCandidateSince) nextQuestionCandidateSince = now;

      setScanState(`Possible new MCQ detected (${diffFromAnswered.toFixed(1)} change). Confirming…`);

      if (now - nextQuestionCandidateSince >= CONFIG.mcqNewQuestionConfirmMs) {
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

  // OTHER mode uses an answer lock. Scrolling through the same long coding
  // question may radically change pixels, so visual difference alone is not
  // enough to discard the answer. We first wait for a stable changed view and
  // ask the backend whether it is still the same question.
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

  const verdict = await classifyOtherQuestionChange(signature);

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

  // SAME or UNCERTAIN: preserve the visible answer. For SAME, adopt the current
  // scrolled view as the new baseline so continued reading does not repeatedly
  // trigger checks against the original top-of-question frame.
  if (verdict === 'same_question') {
    answeredSignature = new Uint8Array(signature);
    setScanState('Same question confirmed. Answer remains locked while you continue scrolling.');
  } else {
    setScanState('Question change is uncertain. Keeping the current answer until a clearly new question is confirmed.');
  }
}

async function classifyOtherQuestionChange(signature) {
  if (requestInFlight || !lastResultContext) return 'uncertain';

  requestInFlight = true;
  renderCaptures();

  try {
    const image = captureJpeg();
    const response = await fetch('/api/classify-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image,
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
  // Initial MCQ: after a short camera warm-up, capture immediately. Do not make
  // the user wait for a strict whole-frame stability condition.
  if (!captures.length) {
    const readyForInitialCapture = now - cameraStartedAt >= CONFIG.mcqInitialDelayMs;
    const retryReady = !lastMcqAttemptAt || now - lastMcqAttemptAt >= CONFIG.mcqRetryMs;

    if (readyForInitialCapture && retryReady) {
      setScanState('MCQ detected in camera view. Analysing…');
      const added = await addCapture({ automatic: true, signature });
      if (added) {
        lastMcqAttemptAt = now;
        await analyzeCaptures({ automatic: true });
      }
    } else {
      setScanState('MCQ mode: reading the question…');
    }
    return;
  }

  // If the model says options/context are missing, a sufficiently different
  // scrolled view is appended and the same MCQ is re-analysed straight away.
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

  if (lastAnalyzedCaptureCount < captures.length) {
    await analyzeCaptures({ automatic: true });
  }
}

async function monitorOther(signature, now) {
  const stableFor = now - stableSince;

  if (stableFor >= CONFIG.nextQuestionStableMs) {
    const lastCaptureSignature = captureSignatures[captureSignatures.length - 1];
    const distinct = !lastCaptureSignature || signatureDiff(lastCaptureSignature, signature) >= CONFIG.newContentDiffThreshold;
    const captureCooldownElapsed = now - lastAutoCaptureAt > 900;

    if (distinct && captureCooldownElapsed && captures.length < CONFIG.maxCaptures) {
      await addCapture({ automatic: true, signature });
      lastAutoCaptureAt = now;
      lastMeaningfulChangeAt = now;
      setScanState(`Other mode: captured view ${captures.length}. Continue scrolling if more of the question is below.`);
      return;
    }
  }

  const quietFor = now - lastMeaningfulChangeAt;
  if (captures.length && quietFor >= CONFIG.otherQuietMs && lastAnalyzedCaptureCount < captures.length) {
    setScanState(`Other mode: ${captures.length} distinct view${captures.length === 1 ? '' : 's'} collected. Analysing full context…`);
    await analyzeCaptures({ automatic: true });
    return;
  }

  if (!captures.length) {
    setScanState('Other mode: hold the first part of the question steady.');
  } else {
    const seconds = Math.max(0, Math.ceil((CONFIG.otherQuietMs - quietFor) / 1000));
    setScanState(`Other mode: ${captures.length} view${captures.length === 1 ? '' : 's'} collected. Scroll for more context, or hold steady${seconds ? ` for ~${seconds}s` : ''}.`);
  }
}

function createFrameSignature() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) return null;

  const canvas = els.sampleCanvas;

  // Focus change detection on the central assessment-content area. This
  // deliberately de-emphasises static navigation, headers, timers, borders
  // and the physical background around the monitor. It makes a change in the
  // question/options contribute much more strongly to the signature.
  const cropX = vw * 0.06;
  const cropY = vh * 0.10;
  const cropW = vw * 0.88;
  const cropH = vh * 0.76;

  // Higher resolution than the previous 48x36 signature so text-only changes
  // are not averaged away. This is still tiny enough to run comfortably on a
  // phone every 500ms.
  const w = 96;
  const h = 72;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.drawImage(
    els.video,
    cropX, cropY, cropW, cropH,
    0, 0, w, h
  );

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
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs(a[i] - b[i]);
  }
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
  ctx.drawImage(els.video, 0, 0, w, h);
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
      lastMeaningfulChangeAt = performance.now();
      els.message.textContent = `Manual capture ${captures.length} added.`;
    } else if (automatic) {
      els.message.textContent = `Automatically captured view ${captures.length}.`;
    }
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
    remove.addEventListener('click', () => {
      captures.splice(i, 1);
      captureSignatures.splice(i, 1);
      lastAnalyzedCaptureCount = Math.min(lastAnalyzedCaptureCount, captures.length);
      renderCaptures();
    });

    wrap.append(img, label, remove);
    els.thumbnails.appendChild(wrap);
  });

  els.analyzeBtn.disabled = captures.length === 0 || requestInFlight;
  els.clearBtn.disabled = captures.length === 0 || requestInFlight;
  els.addPageBtn.disabled = !stream || captures.length >= CONFIG.maxCaptures || requestInFlight;
}

function resetQuestionSession(message = '') {
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

async function analyzeCaptures({ manual = false, automatic = false } = {}) {
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
      body: JSON.stringify({
        images: imagesForRequest,
        assessmentMode: mode,
        continuousMode: true
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Analysis failed.');

    if (!data.question_detected) {
      answered = false;
      els.message.textContent = data.missing_context || 'No readable assessment question detected yet.';

      if (mode === 'mcq') {
        // Retry with a fresh current frame instead of getting stuck with the
        // first unusable capture (blur, autofocus transition, partial frame).
        captures = [];
        captureSignatures = [];
        lastAnalyzedCaptureCount = 0;
        needsMoreContext = false;
        renderCaptures();
        setScanState('MCQ not readable yet. Keeping camera live and retrying automatically…');
      } else {
        setScanState('Keep the camera on the question or continue scrolling for more context.');
      }
      return;
    }

    renderResult(data);
    lastResultContext = {
      question: data.question || '',
      summary: data.question_summary || '',
      type: data.question_type || 'other'
    };

    if (data.needs_more_pages) {
      answered = false;
      needsMoreContext = true;
      els.message.textContent = `More context needed: ${data.missing_context || 'continue scrolling through the remaining question/code/options.'}`;
      setScanState('Keep scrolling. New distinct views will be added to the same question automatically.');
      return;
    }

    needsMoreContext = false;
    answered = true;
    // Compare future frames against the exact frame that produced the answer,
    // not against whatever happens to be visible when the API call finishes.
    answeredSignature = analyzedSignature || (lastFrameSignature ? new Uint8Array(lastFrameSignature) : createFrameSignature());
    nextQuestionCandidateSince = 0;
    otherChangeCandidateSince = 0;
    lastOtherChangeCheckAt = performance.now();
    els.message.textContent = `Answer ready. Move to the next question; the camera will detect the change automatically.`;
    setScanState('Answer ready. Watching for the next question…');
  } catch (e) {
    lastAnalyzedCaptureCount = Math.max(0, lastAnalyzedCaptureCount - 1);
    setError(e.message);
  } finally {
    requestInFlight = false;
    renderCaptures();
    if (stream && !els.statusBadge.classList.contains('error')) setStatus('running', 'Scanning');
    else if (!stream) setStatus('idle', 'Idle');

    if (manual && stream) {
      lastMeaningfulChangeAt = performance.now();
    }
  }
}

function renderResult(data) {
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

  els.answer.textContent = data.answer || '—';
  els.logic.textContent = data.logic || '';
  els.logicWrap.hidden = !data.logic;
  els.code.textContent = data.code || '';
  els.codeWrap.hidden = !data.code;
  els.explanation.textContent = data.explanation || '';
  els.confidence.textContent = data.confidence || '—';
}

function clearResult() {
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
    mcq: 'MCQ',
    fill_code: 'Fill code',
    implement_method: 'Implement method',
    write_program: 'Write program',
    runtime_error: 'Runtime error',
    compile_error: 'Compile error',
    output_prediction: 'Output prediction',
    conceptual: 'Conceptual',
    problem_analysis: 'Problem analysis',
    other: 'Other'
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

updateModeHint();
renderCaptures();
clearResult();
