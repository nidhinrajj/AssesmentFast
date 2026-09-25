import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: '40mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: process.env.OPENAI_MODEL || 'gpt-5.4-mini' });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const incoming = req.body?.images ?? (req.body?.imageDataUrl ? [req.body.imageDataUrl] : []);
    const images = Array.isArray(incoming)
      ? incoming.filter(x => typeof x === 'string' && x.startsWith('data:image/'))
      : [];

    const assessmentMode = req.body?.assessmentMode === 'mcq' ? 'mcq' : 'other';

    if (!images.length) {
      return res.status(400).json({ error: 'At least one camera image is required.' });
    }

    if (images.length > 8) {
      return res.status(400).json({ error: 'A maximum of 8 captures can be analysed together.' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'OPENAI_API_KEY is not configured on the server.' });
    }

    const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
    const prompt = assessmentMode === 'mcq' ? buildMcqPrompt() : buildOtherPrompt();

    const content = [{ type: 'input_text', text: prompt }];

    for (let i = 0; i < images.length; i++) {
      content.push({
        type: 'input_text',
        text: `Capture ${i + 1} of ${images.length}. Treat all captures as belonging to the same assessment question unless the content clearly proves otherwise.`
      });
      content.push({ type: 'input_image', image_url: images[i], detail: 'high' });
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content }]
      })
    });

    const raw = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: raw?.error?.message || 'OpenAI API request failed.'
      });
    }

    const parsed = parseJsonResponse(extractOutputText(raw));
    parsed.selected_mode = assessmentMode;
    return res.json(parsed);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error?.message || 'Unexpected server error.' });
  }
});

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

Return ONLY valid JSON in this exact shape:
{
  "question_detected": true,
  "question_type": "mcq",
  "question_summary": "short summary",
  "question": "reconstructed question text",
  "options": ["A. ...", "B. ..."],
  "answer": "B. exact option text",
  "logic": "",
  "code": "",
  "explanation": "short explanation",
  "confidence": "high|medium|low",
  "needs_more_pages": false,
  "missing_context": ""
}

If no readable MCQ is visible, set question_detected=false and leave answer/code empty.`;
}

function buildOtherPrompt() {
  return `You are a visual assessment assistant used ONLY for assessments where AI assistance is explicitly permitted.

The user selected OTHER mode. This means the question type is NOT predetermined. It may be an MCQ, Java/programming question, code-completion task, runtime-error problem, compile-error problem, output-prediction question, conceptual question, debugging task, algorithm/problem-analysis question, or another assessment format.

The user may provide several camera captures belonging to ONE assessment question. Treat all captures as one ordered question context. Later captures may contain continuation text, starter code, existing methods, examples, constraints, or answer choices.

First determine exactly what the assessment expects the candidate to do. Then classify the task as one of:
- mcq
- fill_code
- implement_method
- write_program
- runtime_error
- compile_error
- output_prediction
- conceptual
- problem_analysis
- other

Answer rules:
1. MCQ: return the selected option directly, then a short explanation.
2. fill_code: return only the code that should be inserted or replaced, unless a small amount of surrounding code is essential for clarity. Preserve visible names and structure.
3. implement_method: keep the visible method signature/class structure. Give a simple logic summary, then the required method implementation. Do not rewrite the whole program unless required.
4. write_program: give a simple approach first, then a complete readable Java solution when Java is requested. Use class Main only when a standalone Java program is expected and no different class name is specified.
5. runtime_error: identify the exact statement/operation where the runtime failure occurs, name the likely exception/error when determinable, and briefly explain why. Do not rewrite the whole program unless the question asks for a fix.
6. compile_error: identify the offending statement/construct, explain the compile problem briefly, and provide the minimum correction when useful.
7. output_prediction: give the expected output first, followed by a short explanation.
8. conceptual: give a concise direct answer.
9. problem_analysis: directly answer what the problem asks, showing only the reasoning/steps needed for the candidate to use the result.
10. If starter code is supplied, respect it. Do not invent new methods, APIs, class names, input formats or requirements.
11. Use all supplied captures together. If a necessary part of the question is missing, set needs_more_pages=true and identify exactly what must be captured next rather than guessing.
12. Never invent unreadable text.

Return ONLY valid JSON in this exact shape:
{
  "question_detected": true,
  "question_type": "mcq|fill_code|implement_method|write_program|runtime_error|compile_error|output_prediction|conceptual|problem_analysis|other",
  "question_summary": "concise description of what the candidate is being asked to do",
  "question": "reconstructed question text from all supplied captures",
  "options": ["A. ...", "B. ..."],
  "answer": "direct answer or concise answer heading",
  "logic": "simple approach for coding/program-analysis tasks; otherwise empty string",
  "code": "code only when code is required; otherwise empty string",
  "explanation": "short useful explanation",
  "confidence": "high|medium|low",
  "needs_more_pages": false,
  "missing_context": "what additional page/section is needed, otherwise empty string"
}

If no readable assessment question is present, set question_detected=false and leave answer/code empty.`;
}

function extractOutputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;

  const parts = [];
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
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
      explanation: 'The model response could not be parsed. Try again with clearer captures.',
      confidence: 'low',
      needs_more_pages: true,
      missing_context: 'Please recapture the question clearly.',
      debug_text: cleaned.slice(0, 1000)
    };
  }
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Assessment assistant running on http://localhost:${port}`);
  console.log(`Model: ${process.env.OPENAI_MODEL || 'gpt-5.4-mini'}`);
  console.log('For mobile camera access, open it through an HTTPS URL/tunnel.');
});
