# AI Assessment Assistant — Camera + Audio

This test application is intended only for assessments where AI assistance is explicitly permitted. It displays suggested answers in its own UI and does not click or submit answers on the assessment website.

## Modes

### MCQ
- Start the camera once and keep it pointed at the assessment.
- The first visible MCQ is analysed automatically.
- The answer and a short explanation are displayed.
- The camera remains live and uses question-focused frame comparison to detect subtle next-question changes even when the surrounding UI stays almost identical.
- If the model needs options below the fold, additional distinct views can be added to the same MCQ.

### Other
- Intended for Java/coding, debugging, runtime/compile errors, output prediction, problem analysis, MCQ, and mixed question types.
- The camera automatically collects distinct stable views while you scroll through a long question.
- After a quiet period, all captured views are analysed together.
- Coding answers include a short/basic logic explanation and the code required by the question.
- After an answer is generated, it stays locked while you scroll within the same question. A semantic check confirms a genuinely new question before resetting the result.

### Audio
Audio mode never opens the camera.

**Manual Listen**
1. Press **Start listening**.
2. Let the complete spoken question play.
3. Press **Stop & analyse**.
4. The audio is transcribed and the answer is displayed.

**Continuous Listen**
1. Press **Start continuous listening**.
2. The browser performs local voice-activity detection.
3. After speech followed by roughly 1.6 seconds of silence, that utterance is treated as one question.
4. The recording is transcribed and analysed automatically.
5. The previous answer stays visible until the next complete spoken question has been successfully analysed.
6. Press **Stop continuous listening** to end the session.

The transcription model defaults to `gpt-4o-mini-transcribe` and can be changed with `OPENAI_TRANSCRIBE_MODEL`.

## Camera improvements

### Camera source selector
After camera permission is granted, available video inputs are listed. On a laptop this can include:
- integrated webcam
- external USB webcam
- other OS-exposed video devices

Choose a camera from the selector. If the camera is already running, changing the selection restarts the camera with the selected device.

### Flip Scanner / mirror correction
**Flip Scanner** horizontally reverses:
- the live preview,
- the image sent to OpenAI,
- the local change-detection signature.

This makes mirrored/reflected text readable to the scanner. The UI displays **Mirror correction ON** while enabled.

## Setup

Requires Node.js 18 or later.

```bash
npm install
```

Copy `.env.example` to `.env` and configure:

```env
PORT=3000
OPENAI_API_KEY=sk-proj-your-real-key
OPENAI_MODEL=gpt-5.4-mini
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
```

Start:

```bash
npm start
```

Desktop:

```text
http://localhost:3000
```

Camera and microphone access require a secure browser context on remote/mobile devices. A Render deployment already provides HTTPS, so no tunnel is required.

## Render

Keep these values as Render environment variables rather than committing a `.env` file:

```text
OPENAI_API_KEY
OPENAI_MODEL
OPENAI_TRANSCRIBE_MODEL
```

`OPENAI_TRANSCRIBE_MODEL` is optional because the server defaults to `gpt-4o-mini-transcribe`.

Typical Render settings:

```text
Build Command: npm install
Start Command: npm start
```

The server listens on `process.env.PORT` and `0.0.0.0`, so it remains compatible with the existing Render Web Service.

## Notes

- Camera frames are compared locally; continuous video is not streamed to OpenAI.
- Audio is recorded in question-sized clips; continuous microphone audio is not permanently stored by this application.
- Up to 8 visual captures are retained for one visual question.
- The OpenAI API key stays server-side.
- If an audio request fails or is incomplete, the previously displayed answer is not erased.

## Desktop result panel

On screens 1180px wide or larger, the Result card is shown as a sticky panel on the right-hand side. The camera/audio controls remain in the main column, and the Result panel stays visible while the user scrolls. Mobile and smaller desktop layouts remain single-column and unchanged.
