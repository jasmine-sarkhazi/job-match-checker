// Everything that talks to Jev (TypeSafe AI's System One model) lives here:
// the questions we ask, the weights we combine them with, the request builder,
// and the scoring math. Keeping it in one file makes the judgement easy to review.
//
// API contract: https://docs.typesafe.ai/api.md
//   POST https://api.typesafe.ai/v1/systemone
//   Authorization: Bearer <API_KEY>
//   { state, model, questions } -> { model, answers, usage }

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MODELS_ENDPOINT = "https://api.typesafe.ai/v1/models";
export const JEV_MODEL = "jev-latest";

// Jev's context budget is 64k tokens for state + questions. Resumes and job
// postings are short, but some pages dump the whole site into the body text,
// so we cap both sides well below the limit (~5k tokens each).
export const MAX_RESUME_CHARS = 20000;
export const MAX_JOB_CHARS = 20000;

// Score questions return a probability-weighted position on an ordered rubric
// (0 .. levels-1). Noul questions return the probability that the answer is yes.
// Instructions reference the state with backticked paths, per the docs.
export const QUESTIONS = {
  required_skills: {
    type: "score",
    instructions:
      "Compare the skills, tools, and technologies that `job.description` asks for " +
      "with the ones `resume` gives evidence of. How much of what the job requires " +
      "does the candidate demonstrably have?",
    criteria: [
      "None or almost none of the required skills appear anywhere in the resume",
      "A minority of the required skills appear in the resume",
      "Most of the required skills appear, with one or two clear gaps",
      "Every required skill appears, and most preferred or nice-to-have skills appear too",
    ],
  },
  experience_level: {
    type: "score",
    instructions:
      "Compare the seniority and years of experience `job.description` asks for " +
      "with what `resume` demonstrates through roles, titles, and dates.",
    criteria: [
      "Far below: several years or more than one seniority level short of what the job asks for",
      "Somewhat below: close, but a year or two or one seniority level short",
      "Meets the seniority and years of experience the job asks for",
      "Exceeds the seniority and years of experience the job asks for",
    ],
  },
  responsibilities_fit: {
    type: "score",
    instructions:
      "How closely does the work the candidate has actually done, as described in " +
      "`resume`, match the day-to-day responsibilities described in `job.description`?",
    criteria: [
      "The candidate has not done work like this before",
      "The candidate has done some loosely related work",
      "The candidate has done most of these responsibilities in previous roles",
      "The candidate has done essentially this job before, at a comparable or larger scope",
    ],
  },
  domain_relevance: {
    type: "score",
    instructions:
      "How relevant is the candidate's industry and problem-domain background in " +
      "`resume` to the industry and domain of `job`?",
    criteria: [
      "Completely unrelated field",
      "Adjacent field with transferable context",
      "Some direct experience in the same domain",
      "Deep, direct experience in the same domain",
    ],
  },
  overall_fit: {
    type: "score",
    instructions:
      "Taking everything into account, how strong a candidate is `resume` for the " +
      "role described in `job`?",
    criteria: [
      "Not a fit: an experienced recruiter would reject this application on sight",
      "Weak fit: a few overlaps, but the candidate is clearly not who the job describes",
      "Reasonable fit: the candidate could plausibly do the job with some ramp-up",
      "Strong fit: the candidate matches most of what the job describes",
      "Exceptional fit: the candidate reads like the job description was written for them",
    ],
  },
  would_shortlist: {
    type: "noul",
    instructions:
      "Would a careful recruiter screening applications for `job` move `resume` " +
      "forward to a phone screen?",
    criteria: {
      true: "The recruiter would schedule a screen with this candidate",
      false: "The recruiter would pass on this candidate",
    },
  },
  hard_requirement_gap: {
    type: "noul",
    instructions:
      "Does `job.description` state a hard requirement (a specific degree, " +
      "certification, license, security clearance, work authorization, or a " +
      "must-have technology) that `resume` gives no evidence the candidate meets?",
    criteria: {
      true: "At least one stated hard requirement is not evidenced anywhere in the resume",
      false: "The job states no hard requirements, or the resume shows each one is met",
    },
  },
};

// How each dimension contributes to the 0-100 match score. Must sum to 1.
export const WEIGHTS = {
  required_skills: 0.3,
  experience_level: 0.2,
  responsibilities_fit: 0.2,
  domain_relevance: 0.1,
  overall_fit: 0.1,
  would_shortlist: 0.1,
};

// A likely unmet hard requirement scales the score down by up to this fraction,
// proportional to how sure Jev is that a gap exists.
export const BLOCKER_PENALTY = 0.25;
// Above this probability we show the gap as a warning in the UI.
export const BLOCKER_WARN_THRESHOLD = 0.6;

export const DIMENSION_LABELS = {
  required_skills: "Required skills",
  experience_level: "Experience level",
  responsibilities_fit: "Responsibilities",
  domain_relevance: "Domain relevance",
  overall_fit: "Overall fit",
  would_shortlist: "Would be shortlisted",
};

export const VERDICTS = [
  { min: 80, label: "Strong fit", tone: "great" },
  { min: 60, label: "Good fit", tone: "good" },
  { min: 40, label: "Partial fit", tone: "meh" },
  { min: 0, label: "Weak fit", tone: "bad" },
];

export function truncate(text, max) {
  const clean = String(text ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max) + "\n[truncated]";
}

/** Build the exact JSON body for POST /v1/systemone. */
export function buildRequest({ resume, job, model = JEV_MODEL }) {
  const resumeText = truncate(resume, MAX_RESUME_CHARS);
  if (!resumeText) throw new Error("Resume text is empty.");
  const description = truncate(job?.description, MAX_JOB_CHARS);
  if (!description) throw new Error("Job description is empty.");

  const state = {
    job: {
      title: job?.title || "Unknown",
      company: job?.company || "Unknown",
      location: job?.location || "Not stated",
      description,
    },
    resume: resumeText,
  };
  return { state, model, questions: QUESTIONS };
}

/** Turn Jev's answers into a 0-100 match score plus a per-dimension breakdown. */
export function scoreAnswers(answers) {
  if (!answers || typeof answers !== "object") throw new Error("Jev returned no answers.");

  const dimensions = [];
  let composite = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const answer = answers[key];
    if (!answer) throw new Error(`Jev response is missing the "${key}" answer.`);
    let value; // normalized 0..1
    let detail;
    if (answer.type === "score") {
      const levels = QUESTIONS[key].criteria.length;
      value = clamp01(answer.score / (levels - 1));
      const top = Math.round(answer.score);
      detail = {
        score: answer.score,
        levels,
        levelLabel: answer.legend?.[String(top)] ?? QUESTIONS[key].criteria[top],
        confidence: answer.confidence,
      };
    } else if (answer.type === "noul") {
      value = clamp01(answer.noul);
      detail = { probability: answer.noul };
    } else {
      throw new Error(`Unexpected answer type "${answer.type}" for "${key}".`);
    }
    composite += weight * value;
    dimensions.push({ key, label: DIMENSION_LABELS[key], weight, value, ...detail });
  }

  const gap = clamp01(answers.hard_requirement_gap?.noul ?? 0);
  const penalized = composite * (1 - BLOCKER_PENALTY * gap);
  const score = Math.round(penalized * 100);
  const verdict = VERDICTS.find((v) => score >= v.min) ?? VERDICTS[VERDICTS.length - 1];

  return {
    score,
    verdict: verdict.label,
    tone: verdict.tone,
    dimensions,
    blocker: { probability: gap, flagged: gap >= BLOCKER_WARN_THRESHOLD },
  };
}

/** Call Jev and return the scored result. `fetchImpl` is injectable for tests. */
export async function askJev({ apiKey, resume, job, model, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error("No TypeSafe API key saved. Add one in the extension options.");
  const body = buildRequest({ resume, job, model });

  const response = await fetchWithRetry(
    fetchImpl,
    JEV_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) throw new Error(await describeError(response));
  const data = await response.json();
  const scored = scoreAnswers(data.answers);
  return { ...scored, model: data.model, usage: data.usage, request: body, answers: data.answers };
}

/** GET /v1/models — a cheap way to check that an API key works. */
export async function listModels({ apiKey, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(MODELS_ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(await describeError(response));
  const data = await response.json();
  return data.models ?? [];
}

// The docs ask for exponential backoff on 429 and 529.
async function fetchWithRetry(fetchImpl, url, init, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await fetchImpl(url, init);
    if (last.status !== 429 && last.status !== 529) return last;
    if (i < attempts - 1) await sleep(500 * 2 ** i);
  }
  return last;
}

async function describeError(response) {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      detail = json.error?.message || json.detail || json.message || text;
      if (typeof detail !== "string") detail = JSON.stringify(detail);
    } catch {
      detail = text;
    }
  } catch {
    /* ignore */
  }
  const hints = {
    401: "Invalid or missing API key. Check it in the extension options.",
    422: "Jev rejected the request body.",
    429: "Rate limited by TypeSafe. Try again in a moment.",
    529: "TypeSafe is overloaded. Try again in a moment.",
  };
  const hint = hints[response.status] || `TypeSafe returned HTTP ${response.status}.`;
  return detail ? `${hint} (${detail.slice(0, 300)})` : hint;
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
