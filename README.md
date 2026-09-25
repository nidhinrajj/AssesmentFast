# Continuous Mobile Assessment Camera Assistant

This test application is designed for assessments where AI assistance is explicitly permitted.

## What changed

The camera remains live after you press **Start camera**.

### MCQ mode
- Watches the camera locally for a stable question.
- Automatically captures and analyses the first question.
- Displays the selected option and a short explanation.
- Keeps the camera running.
- When the desktop content changes to a new stable question, it automatically starts a new session and analyses it.

### Other mode
- Automatically collects distinct stable camera views while you scroll through a long question.
- Keeps those views in one question session.
- After the screen stops changing for roughly four seconds, all views are sent together for analysis.
- The AI determines whether the task is an MCQ, Java code completion, method implementation, full program, runtime/compile error, output prediction, conceptual question, problem analysis, or another format.
- If additional context is required, the same session stays open so you can continue scrolling.

The browser performs lightweight frame comparison locally. Video frames are not continuously sent to OpenAI; only selected JPEG captures are sent when the content is stable/distinct.

## Setup

1. Install Node.js 18 or later.
2. Extract the project.
3. Run:

```bash
npm install
```

4. Copy `.env.example` to `.env`.
5. Put your OpenAI API key in `.env`:

```env
PORT=3000
OPENAI_API_KEY=sk-proj-your-real-key
OPENAI_MODEL=gpt-5.4-mini
```

6. Start the server:

```bash
npm start
```

7. Desktop test:

```text
http://localhost:3000
```

For a mobile camera, use an HTTPS deployment or HTTPS tunnel. If you deploy the application, keep `OPENAI_API_KEY` as a server-side secret/environment variable and never place it in `public/app.js` or `index.html`.

## Notes

- Up to 8 distinct camera views are retained for one question.
- `Analyse now` and `Add view manually` are available as fallbacks.
- If automatic question-change detection is too sensitive for a particular phone/camera angle, the thresholds can be tuned in `public/app.js` under the `CONFIG` object.
- The application never clicks or submits an answer on the assessment page; it only displays the suggested answer in its own UI.


## MCQ fast-detection update

MCQ mode no longer waits for pixel-perfect camera stability. After a short camera warm-up it captures and analyses the current frame automatically. If the first frame is unreadable (for example during autofocus), it discards that capture and retries automatically. After an answer is returned, the app compares subsequent frames against the exact answered frame and triggers the next MCQ after a short persistent screen-change confirmation.

This is intentionally different from Other mode, which still waits longer so it can accumulate multiple scrolled views for long questions and code snippets.

## Improved MCQ next-question detection

This build improves detection when the assessment UI remains mostly unchanged between questions.

Changes include:

- Question-focused comparison instead of relying on the entire camera frame.
- Higher-resolution 96x72 detection signatures so text-only changes are preserved.
- Lower MCQ change threshold for subtle question replacements.
- Adaptive noise filtering for autofocus, exposure changes and small hand movements.
- Short 600ms confirmation window before a changed question is accepted.
- Existing answer frame remains the baseline until a genuinely different question is detected.

This is especially useful for assessment layouts where the header, timer, navigation, buttons and sidebars remain fixed while only the question text/options change.


## Other-mode answer lock

After an Other-mode coding/problem answer is generated, normal scrolling no longer clears the result. A visually changed stable view is checked against the previous question context. The existing answer remains visible for `same_question` or `uncertain`, and a new question session begins only when `new_question` is confirmed.
