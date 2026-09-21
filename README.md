# Job Match Checker

A Chrome extension that answers one question on any job posting: **Am I a fit for this job?**

Upload your resume once. Then, before you apply, click the extension on a job page and get a
0–100 match score with a per-dimension breakdown. Scoring is done by
[Jev](https://typesafe.ai), TypeSafe AI's System One model, which returns calibrated,
typed judgments instead of generated text.

## How to use

### 1. Install the extension

```bash
git clone https://github.com/jasmine-sarkhazi/job-match-checker.git
cd job-match-checker
npm install        # pulls pdf.js for PDF resume parsing
npm run build      # copies pdf.js into extension/vendor/
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder.
4. Pin **Job Match Checker** from the puzzle-piece menu so the button is always visible.

The settings page opens automatically on first install. Without `npm run build` everything still
works except PDF upload; paste your resume text or upload a `.txt`/`.md` file instead.

### 2. Add your Jev API key

1. Create a key at [console.typesafe.ai/keys](https://console.typesafe.ai/keys). Jev is currently
   in early access, so you may need to join the waitlist first.
2. On the extension's settings page, paste the key and click **Save key**.
3. Click **Test connection**. You should see `Key works. Models: jev-latest, …`.

The key is stored only in your browser's extension storage and is only ever sent to
`api.typesafe.ai`.

### 3. Upload your resume (once)

On the same settings page, either choose a file (**PDF**, `.txt`, or `.md`) or paste your resume
text into the box, then click **Save resume**. Only the extracted text is kept. You can come back
and replace it any time; saving a new resume clears old scores.

### 4. Check a job

1. Open any job posting (LinkedIn, Indeed, Greenhouse, Lever, Workday, a company careers page…).
2. Click the **Job Match Checker** icon in the toolbar.
3. Click **Am I a fit for this job?**

In a second or two you get:

| Part of the result | What it means |
| --- | --- |
| **Score (0–100)** and verdict | Overall match. 80+ Strong fit, 60–79 Good fit, 40–59 Partial fit, below 40 Weak fit. |
| **Heads-up banner** | Shown when Jev thinks the job lists a hard requirement (degree, certification, clearance, must-have tech) your resume doesn't show. |
| **Dimension bars** | Required skills, experience level, responsibilities, domain relevance, overall fit, and whether a recruiter would shortlist you. Hover a bar for Jev's confidence and the weight used. |

The last score for each job URL is remembered, so reopening the popup on the same page shows it
instantly. Click **Check again** to re-score.

If the popup says it couldn't find a job description (some pages hide it behind a login or render
it in an unusual way), expand **Job text looks wrong? Paste it instead**, paste the description,
and click the button again.

## How it works under the hood

1. **Options page** – you paste your TypeSafe API key and upload your resume (PDF, `.txt`, `.md`,
   or pasted text). Only the extracted text is kept, in `chrome.storage.local`.
2. **Popup** – on a job page, click *Am I a fit for this job?*. A content script pulls the
   posting (title, company, location, description) from the page's schema.org `JobPosting`
   JSON-LD when present, otherwise from the job-board's description container, otherwise from
   the page body. You can also paste the description by hand.
3. **Background worker** – sends one request to `POST https://api.typesafe.ai/v1/systemone`
   with the resume and job as `state` and seven typed questions:

   | Question | Type | What it judges |
   | --- | --- | --- |
   | `required_skills` | score (4 levels) | how many of the required skills the resume evidences |
   | `experience_level` | score (4 levels) | seniority and years vs. what the job asks |
   | `responsibilities_fit` | score (4 levels) | whether you have done this kind of work |
   | `domain_relevance` | score (4 levels) | industry and problem-domain overlap |
   | `overall_fit` | score (5 levels) | holistic fit |
   | `would_shortlist` | noul (yes/no) | would a recruiter move this resume to a screen |
   | `hard_requirement_gap` | noul (yes/no) | is a stated hard requirement (degree, cert, clearance, must-have tech) unmet |

4. **Scoring** – each answer is normalized to 0–1 and combined with weights you can read and
   change in one place (`extension/jev.js`), following TypeSafe's
   [composite scoring](https://docs.typesafe.ai/patterns/composite-scoring) pattern. A likely
   unmet hard requirement scales the score down and shows a warning.

Jev never generates text, so the result is a number and a breakdown, not an essay. The raw
answers (probabilities and confidence) are kept on the result so the weights can be tuned
without re-querying.

## Development

```bash
npm test            # unit tests for the Jev request builder and scoring (node:test)
npm run test:e2e    # loads the extension in Chromium and exercises options + popup with a mocked Jev
```

The end-to-end tests use `playwright-core` and expect a Chromium build to be available to
Playwright (set `CHROMIUM_PATH` to point at one if needed).

Project layout:

```
extension/
  manifest.json    MV3 manifest
  jev.js           questions, weights, request builder, scoring — the file to review
  background.js    service worker; the only code that calls the API
  content.js       job-posting extraction, injected on demand
  popup.*          "Am I a fit for this job?" UI
  options.*        API key + resume upload (pdf.js for PDFs)
  vendor/          pdf.js runtime (generated by npm run build, git-ignored)
scripts/           vendor-pdfjs.mjs, make-icons.mjs
test/              unit tests, e2e tests, HTML fixtures
```

## Permissions

- `storage` – save your key, resume text, and the last score per job URL
- `activeTab` + `scripting` – read the job page you clicked the extension on, and nothing else
- host permission for `https://api.typesafe.ai/*` – call Jev

## Reference

- [TypeSafe API reference](https://docs.typesafe.ai/api)
- [Primitives: Choice, Score, Noul](https://docs.typesafe.ai/primitives)
- [Composite scoring pattern](https://docs.typesafe.ai/patterns/composite-scoring)
