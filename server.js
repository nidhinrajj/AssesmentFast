import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: '45mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
    transcription_model: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
  });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const incoming = req.body?.images ?? (req.body?.imageDataUrl ? [req.body.imageDataUrl] : []);
    const images = Array.isArray(incoming)
      ? incoming.filter((x) => typeof x === 'string' && x.startsWith('data:image/'))
      : [];
    const assessmentMode = req.body?.assessmentMode === 'mcq' ? 'mcq' : 'other';

    if (!images.length) return res.status(400).json({ error: 'At least one camera image is required.' });
    if (images.length > 8) return res.status(400).json({ error: 'A maximum of 8 captures can be analysed together.' });

    const apiKey = requireApiKey(res);
    if (!apiKey) return;

    const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
    const prompt = assessmentMode === 'mcq' ? buildMcqPrompt() : buildOtherPrompt();
    const content = [{ type: 'input_text', text: prompt }];

    for (let i = 0; i < images.length; i += 1) {
      content.push({
        type: 'input_text',
        text: `Capture ${i + 1} of ${images.length}. Treat all captures as belonging to the same assessment question unless the content clearly proves otherwise.`
      });
      content.push({ type: 'input_image', image_url: images[i], detail: 'high' });
    }

    const raw = await callResponsesApi(apiKey, model, [{ role: 'user', content }]);
    const parsed = parseJsonResponse(extractOutputText(raw));
    parsed.selected_mode = assessmentMode;
    return res.json(parsed);
  } catch (error) {
    console.error(error);
    return res.status(error.status || 500).json({ error: error?.message || 'Unexpected server error.' });
  }
});

app.post('/api/classify-change', async (req, res) => {
  try {
    const image = req.body?.image;
    const previousQuestion = String(req.body?.previousQuestion || '').slice(0, 12000);
    const previousSummary = String(req.body?.previousSummary || '').slice(0, 4000);
    const previousType = String(req.body?.previousType || 'other').slice(0, 80);

    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'A current camera image is required.' });
    }

    const apiKey = requireApiKey(res);
    if (!apiKey) return;
    const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';

    const prompt = `You are deciding whether a newly visible assessment screen belongs to the SAME question that was already answered, or is a genuinely NEW question.

This check is used after the user has already received an answer to a long coding/problem question. The user may scroll up or down within that same question. Scrolling, seeing a different part of the same starter code, constraints, examples, answer area, editor, or explanation MUST be classified as same_question.

Only classify new_question when there is strong evidence that the assessment has advanced to a different question/problem, such as a different prompt/task, different question number with different content, a new unrelated code problem, or clearly replaced answer choices.

If evidence is insufficient, return uncertain. Prefer same_question over new_question when the image could simply be another scrolled portion of the prior problem.

Previous question type: ${previousType}
Previous question summary: ${previousSummary || '(not available)'}
Previous reconstructed question: ${previousQuestion || '(not available)'}

Return ONLY JSON:
{
  "verdict": "same_question|new_question|uncertain",
  "reason": "one short sentence"
}`;

    const raw = await callResponsesApi(apiKey, model, [{
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: image, detail: 'low' }
      ]
    }]);

    const parsed = parseJsonResponse(extractOutputText(raw));
    const verdict = ['same_question', 'new_question', 'uncertain'].includes(parsed?.verdict)
      ? parsed.verdict
      : 'uncertain';
    return res.json({ verdict, reason: parsed?.reason || '' });
  } catch (error) {
    console.error(error);
    return res.status(error.status || 500).json({ error: error?.message || 'Unexpected server error.' });
  }
});

app.post('/api/followup', async (req, res) => {
  try {
    const apiKey = requireApiKey(res); if (!apiKey) return;
    const question = req.body?.question;
    if (!question || typeof question !== 'object') return res.status(400).json({ error:'Analyse a question first.' });
    let instruction = String(req.body?.instruction || '').slice(0, 4000);
    if (req.body?.audioDataUrl) {
      const { mimeType, bytes, extension } = decodeAudioDataUrl(req.body.audioDataUrl);
      if (bytes.length > 24 * 1024 * 1024) return res.status(400).json({error:'Recording too large.'});
      const form = new FormData();
      form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
      form.append('file', new Blob([bytes], {type:mimeType}), `followup.${extension}`);
      const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form});
      const td = await tr.json();
      if (!tr.ok) return res.status(tr.status).json({error:td.error?.message || 'Transcription failed.'});
      instruction = String(td.text || '').trim().slice(0,4000);
    }
    if (!instruction) return res.status(400).json({error:'No follow-up instruction detected.'});
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8).map(x => ({role:x.role === 'assistant'?'assistant':'user', text:String(x.text||'').slice(0,4000)})) : [];
    const prompt = `You are refining an answer to an AI-permitted assessment question. Use only the given question, original result, and conversation. Follow the user's requested format precisely. If information is insufficient, say so. Do not invent question details.
Original result:
${JSON.stringify(question).slice(0,20000)}
Conversation:
${JSON.stringify(history).slice(0,14000)}
User instruction: ${instruction}`;
    const raw = await callResponsesApi(apiKey, process.env.OPENAI_MODEL || 'gpt-5.4-mini', [{role:'user',content:[{type:'input_text',text:prompt}]}]);
    return res.json({ transcript:req.body?.audioDataUrl ? instruction : undefined, answer:extractOutputText(raw) });
  } catch(e) { console.error(e); return res.status(e.status || 500).json({error:e.message || 'Follow-up failed.'}); }
});

app.post('/api/audio/analyze', async (req, res) => {
  try {
    const audioDataUrl = req.body?.audioDataUrl;
    if (typeof audioDataUrl !== 'string' || !audioDataUrl.startsWith('data:audio/')) {
      return res.status(400).json({ error: 'A recorded audio clip is required.' });
    }

    const apiKey = requireApiKey(res);
    if (!apiKey) return;

    const { mimeType, bytes, extension } = decodeAudioDataUrl(audioDataUrl);
    if (!bytes.length) return res.status(400).json({ error: 'The recorded audio clip is empty.' });
    if (bytes.length > 24 * 1024 * 1024) return res.status(400).json({ error: 'Audio clip is too large. Keep each question recording shorter.' });

    const transcriptionModel = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
    const form = new FormData();
    form.append('model', transcriptionModel);
    form.append('file', new Blob([bytes], { type: mimeType }), `question.${extension}`);
    form.append('response_format', 'json');

    const transcriptionResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
    const transcriptionRaw = await transcriptionResponse.json();
    if (!transcriptionResponse.ok) {
      const err = new Error(transcriptionRaw?.error?.message || 'Audio transcription failed.');
      err.status = transcriptionResponse.status;
      throw err;
    }

    const transcript = String(transcriptionRaw?.text || '').trim();
    if (!transcript) {
      return res.json(emptyAudioResult('', 'No clear speech was transcribed.'));
    }

    const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
    const prompt = buildAudioPrompt(transcript);
    const raw = await callResponsesApi(apiKey, model, [{
      role: 'user',
      content: [{ type: 'input_text', text: prompt }]
    }]);
    const parsed = parseJsonResponse(extractOutputText(raw));
    parsed.transcript = transcript;
    parsed.selected_mode = 'audio';
    return res.json(parsed);
  } catch (error) {
    console.error(error);
    return res.status(error.status || 500).json({ error: error?.message || 'Unexpected server error.' });
  }
});

function requireApiKey(res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'OPENAI_API_KEY is not configured on the server.' });
    return null;
  }
  return apiKey;
}

async function callResponsesApi(apiKey, model, input) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, input })
  });
  const raw = await response.json();
  if (!response.ok) {
    const err = new Error(raw?.error?.message || 'OpenAI API request failed.');
    err.status = response.status;
    throw err;
  }
  return raw;
}

function decodeAudioDataUrl(dataUrl) {
  const match = /^data:(audio\/[\w.+-]+)(?:;[^,]*)?;base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new Error('Unsupported audio recording format.');
  const mimeType = match[1];
  const bytes = Buffer.from(match[2], 'base64');
  const extension = mimeType.includes('mp4') || mimeType.includes('m4a')
    ? 'm4a'
    : mimeType.includes('ogg')
      ? 'ogg'
      : mimeType.includes('wav')
        ? 'wav'
        : 'webm';
  return { mimeType, bytes, extension };
}

function buildMcqPrompt() {
  return `You are a visual assessment assistant used ONLY for assessments where AI assistance is explicitly permitted.

The user has explicitly selected MCQ mode. Therefore assume the assessment question is a multiple-choice or multiple-select question.

The user may provide more than one capture for the same question. Use all captures together. A later capture may contain answer options or a code snippet that belongs to the question.

Your job:
1. Read the complete question carefully.
2. Read every visible answer option.
3. If code is present, reason about the code only as needed to select the correct option.
4. Return the correct option letter/number and the option text when readable.
5. Give only a short explanation, normally 1-3 sentences.
6. If it is multiple-select, return every correct option.
7. If an essential part of the question or one or more answer options are missing/unreadable, do not guess. Set needs_more_pages=true and state exactly what is missing.
8. Never invent unreadable text.

${jsonResponseContract('mcq')}

If no readable MCQ is visible, set question_detected=false and leave answer/code empty.`;
}

function buildOtherPrompt() {
  return `You are a visual assessment assistant used ONLY for assessments where AI assistance is explicitly permitted.

The user selected OTHER mode. The question type is not predetermined. It may be an MCQ, Java/programming question, code-completion task, runtime-error problem, compile-error problem, output-prediction question, conceptual question, debugging task, algorithm/problem-analysis question, or another assessment format.

The user may provide several camera captures belonging to ONE assessment question. Treat all captures as one ordered question context. Later captures may contain continuation text, starter code, existing methods, examples, constraints, or answer choices.

First determine exactly what the assessment expects the candidate to do. Then classify and answer it using these rules:
- mcq: selected option directly + short explanation.
- fill_code: only the code to insert/replace unless small surrounding context is essential.
- implement_method: simple logic + required method implementation; preserve visible signatures/class structure.
- write_program: simple approach + complete readable Java solution when Java is requested. Use class Main only for a standalone program when no class name is specified.
- runtime_error: exact failing statement/operation + likely exception/error + brief reason.
- compile_error: offending construct + brief reason + minimum correction when useful.
- output_prediction: expected output first + short explanation.
- conceptual: concise direct answer.
- problem_analysis: directly answer what is requested with only useful steps.

Respect starter code and visible names. Never invent methods, APIs, class names, input formats, or unreadable requirements. If necessary context is missing, set needs_more_pages=true and say what must be captured next.

${jsonResponseContract('other')}`;
}

function buildAudioPrompt(transcript) {
  return `You are an assessment assistant used ONLY for assessments where AI assistance is explicitly permitted.

A spoken question has been transcribed below. Determine whether it contains a complete question and what response format it requires. It may be an MCQ, Java/programming question, debugging/runtime-error problem, output prediction, conceptual question, algorithm/problem-analysis question, or another assessment format.

Transcript:
---
${transcript}
---

Rules:
1. If the transcript is an MCQ and includes the choices, give the correct option directly with a short explanation.
2. If it asks to write a Java program, give a very short/simple logic summary followed by complete readable Java code.
3. If it asks to implement/fill a method or missing code, preserve the stated signature/structure and return only the needed implementation, with a short logic summary.
4. If it asks where a runtime/compile error occurs, identify the relevant statement/operation, name the likely error/exception when determinable, and briefly explain why.
5. If it asks for output, give the output first and a short explanation.
6. For conceptual/problem-analysis questions, answer directly and concisely.
7. If the transcript is clearly incomplete, only background speech, or lacks essential answer choices/details, do not guess. Set question_detected=false or needs_more_pages=true and state what is missing.
8. Do not invent code, options, facts, or requirements that were not present in the transcript.

${jsonResponseContract('other')}`;
}

function jsonResponseContract(forcedType) {
  const typeValue = forcedType === 'mcq'
    ? 'mcq'
    : 'mcq|fill_code|implement_method|write_program|runtime_error|compile_error|output_prediction|conceptual|problem_analysis|other';
  return `Return ONLY valid JSON in this exact shape:
{
  "question_detected": true,
  "question_type": "${typeValue}",
  "question_summary": "concise description",
  "question": "reconstructed question text",
  "options": ["A. ...", "B. ..."],
  "answer": "direct answer or concise answer heading",
  "logic": "simple approach for coding/program-analysis tasks; otherwise empty string",
  "code": "code only when code is required; otherwise empty string",
  "explanation": "short useful explanation",
  "confidence": "high|medium|low",
  "needs_more_pages": false,
  "missing_context": "what additional information is needed, otherwise empty string",
  "answer_variants": [{"label":"Option 1 - Recommended","answer":"primary answer","logic":"approach if applicable","code":"code if applicable","explanation":"brief rationale"}]
}
For OTHER and AUDIO questions, return 2 or 3 useful answer_variants where legitimate alternatives exist. Option 1 must be the recommended primary answer, and must exactly match the top-level answer/logic/code/explanation. Additional options must be valid alternative implementations, approaches, or levels of detail, NOT different guesses at a single factual answer. If there is only one correct answer (e.g. MCQ or exact output), offer distinct explanation styles only, keeping the answer correct. Never invent alternatives. For MCQ mode, answer_variants can be omitted.`;
}

function emptyAudioResult(transcript, missingContext) {
  return {
    transcript,
    question_detected: false,
    question_type: 'other',
    question_summary: '',
    question: '',
    options: [],
    answer: '',
    logic: '',
    code: '',
    explanation: '',
    confidence: 'low',
    needs_more_pages: true,
    missing_context: missingContext
  };
}

function extractOutputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  const parts = [];
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n');
}

function parseJsonResponse(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      question_detected: false,
      question_type: 'other',
      question_summary: '',
      question: '',
      options: [],
      answer: '',
      logic: '',
      code: '',
      explanation: 'The model response could not be parsed. Try again with clearer input.',
      confidence: 'low',
      needs_more_pages: true,
      missing_context: 'Please provide the complete question again.',
      debug_text: cleaned.slice(0, 1000)
    };
  }
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Assessment assistant running on http://localhost:${port}`);
  console.log(`Reasoning model: ${process.env.OPENAI_MODEL || 'gpt-5.4-mini'}`);
  console.log(`Transcription model: ${process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'}`);
});
