import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequest, scoreAnswers, askJev, listModels, truncate,
  QUESTIONS, WEIGHTS, JEV_ENDPOINT, JEV_MODEL, MAX_JOB_CHARS, BLOCKER_PENALTY,
} from "../extension/jev.js";

const resume = "Jane Doe. Senior backend engineer, 8 years Python, Django, Postgres, AWS. Led a team of 4.";
const job = {
  url: "https://example.com/jobs/1",
  title: "Senior Backend Engineer",
  company: "Acme",
  location: "Remote",
  description: "We need 5+ years Python, Django, Postgres. Bonus: AWS. BSc required.",
};

// A response shaped exactly like the documented /v1/systemone answer types.
function mockAnswers(overrides = {}) {
  const score = (levels, s, conf = 0.9) => ({
    type: "score",
    score: s,
    legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
    probabilities: Object.fromEntries(levels.map((_, i) => [String(i), i === Math.round(s) ? 1 : 0])),
    confidence: conf,
  });
  return {
    required_skills: score(QUESTIONS.required_skills.criteria, 3),
    experience_level: score(QUESTIONS.experience_level.criteria, 3),
    responsibilities_fit: score(QUESTIONS.responsibilities_fit.criteria, 3),
    domain_relevance: score(QUESTIONS.domain_relevance.criteria, 3),
    overall_fit: score(QUESTIONS.overall_fit.criteria, 4),
    would_shortlist: { type: "noul", noul: 1 },
    hard_requirement_gap: { type: "noul", noul: 0 },
    ...overrides,
  };
}

test("weights sum to 1 and cover every scored question", () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
  for (const key of Object.keys(WEIGHTS)) assert.ok(QUESTIONS[key], `question ${key} exists`);
});

test("questions follow the documented API contract", () => {
  for (const [key, q] of Object.entries(QUESTIONS)) {
    assert.ok(["noul", "choice", "score"].includes(q.type), `${key} type`);
    assert.ok(q.instructions && q.instructions.length > 10, `${key} instructions`);
    if (q.type === "score") {
      assert.ok(Array.isArray(q.criteria), `${key} score criteria is an array`);
      assert.ok(q.criteria.length >= 2 && q.criteria.length <= 10, `${key} has 2-10 levels`);
    }
    if (q.type === "noul" && q.criteria) {
      assert.deepEqual(Object.keys(q.criteria).sort(), ["false", "true"]);
    }
  }
});

test("buildRequest produces the documented body shape", () => {
  const body = buildRequest({ resume, job });
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.equal(body.model, JEV_MODEL);
  assert.equal(body.state.resume, resume);
  assert.equal(body.state.job.title, job.title);
  assert.equal(body.state.job.description, job.description);
  assert.equal(body.questions, QUESTIONS);
  // Must survive JSON serialisation unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(body)), body);
});

test("buildRequest truncates oversized job text and rejects empty input", () => {
  const huge = { ...job, description: "x".repeat(MAX_JOB_CHARS * 2) };
  const body = buildRequest({ resume, job: huge });
  assert.ok(body.state.job.description.length <= MAX_JOB_CHARS + 20);
  assert.ok(body.state.job.description.endsWith("[truncated]"));
  assert.throws(() => buildRequest({ resume: "  ", job }), /Resume text is empty/);
  assert.throws(() => buildRequest({ resume, job: { description: "" } }), /Job description is empty/);
  assert.equal(truncate("a  \r\n b", 100), "a\n b");
});

test("scoreAnswers gives 100 for a perfect candidate and 0 for a hopeless one", () => {
  const perfect = scoreAnswers(mockAnswers());
  assert.equal(perfect.score, 100);
  assert.equal(perfect.verdict, "Strong fit");
  assert.equal(perfect.blocker.flagged, false);
  assert.equal(perfect.dimensions.length, Object.keys(WEIGHTS).length);
  assert.equal(perfect.dimensions[0].levelLabel, QUESTIONS.required_skills.criteria[3]);

  const hopeless = scoreAnswers(mockAnswers({
    required_skills: { type: "score", score: 0, legend: {}, probabilities: {}, confidence: 1 },
    experience_level: { type: "score", score: 0, legend: {}, probabilities: {}, confidence: 1 },
    responsibilities_fit: { type: "score", score: 0, legend: {}, probabilities: {}, confidence: 1 },
    domain_relevance: { type: "score", score: 0, legend: {}, probabilities: {}, confidence: 1 },
    overall_fit: { type: "score", score: 0, legend: {}, probabilities: {}, confidence: 1 },
    would_shortlist: { type: "noul", noul: 0 },
  }));
  assert.equal(hopeless.score, 0);
  assert.equal(hopeless.verdict, "Weak fit");
});

test("scoreAnswers weights fractional scores and applies the blocker penalty", () => {
  const partial = scoreAnswers(mockAnswers({
    required_skills: { type: "score", score: 1.5, legend: {}, probabilities: {}, confidence: 0.5 },
    would_shortlist: { type: "noul", noul: 0.5 },
  }));
  // required_skills 1.5/3 = 0.5 * 0.3 = 0.15; shortlist 0.5 * 0.1 = 0.05; rest full = 0.6
  assert.equal(partial.score, 80);

  const blocked = scoreAnswers(mockAnswers({ hard_requirement_gap: { type: "noul", noul: 1 } }));
  assert.equal(blocked.score, Math.round(100 * (1 - BLOCKER_PENALTY)));
  assert.equal(blocked.blocker.flagged, true);
  assert.equal(blocked.blocker.probability, 1);
});

test("scoreAnswers rejects malformed responses", () => {
  assert.throws(() => scoreAnswers(null), /no answers/);
  const missing = mockAnswers();
  delete missing.overall_fit;
  assert.throws(() => scoreAnswers(missing), /missing the "overall_fit"/);
});

test("askJev sends the right HTTP request and parses the response", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ model: "jev-1.13.0", answers: mockAnswers(), usage: { input_tokens: 500, output_tokens: 40 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const result = await askJev({ apiKey: "sk-test", resume, job, fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, "jev-latest");
  assert.equal(sent.questions.would_shortlist.type, "noul");
  assert.equal(result.score, 100);
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.usage.input_tokens, 500);
});

test("askJev surfaces API errors with useful hints", async () => {
  const fetch401 = async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
  await assert.rejects(askJev({ apiKey: "sk-bad", resume, job, fetchImpl: fetch401 }), /Invalid or missing API key.*bad key/);

  const fetch422 = async () => new Response(JSON.stringify({ detail: [{ loc: ["questions"], msg: "invalid" }] }), { status: 422 });
  await assert.rejects(askJev({ apiKey: "sk", resume, job, fetchImpl: fetch422 }), /rejected the request body/);

  await assert.rejects(askJev({ apiKey: "", resume, job, fetchImpl: fetch401 }), /No TypeSafe API key/);
});

test("askJev retries on 429 and 529 with backoff", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n < 3) return new Response("slow down", { status: n === 1 ? 429 : 529 });
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: mockAnswers(), usage: {} }), { status: 200 });
  };
  const result = await askJev({ apiKey: "sk", resume, job, fetchImpl });
  assert.equal(n, 3);
  assert.equal(result.score, 100);
});

test("listModels hits GET /v1/models with the bearer key", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ models: [{ name: "jev-latest" }] }), { status: 200 });
  };
  const models = await listModels({ apiKey: "sk", fetchImpl });
  assert.equal(seen.url, "https://api.typesafe.ai/v1/models");
  assert.equal(seen.init.headers.Authorization, "Bearer sk");
  assert.deepEqual(models, [{ name: "jev-latest" }]);
});
