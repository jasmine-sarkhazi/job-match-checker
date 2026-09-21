// End-to-end: loads the unpacked extension in Chromium, saves a key and
// resume on the options page, then scores a fixture job page through the
// popup with the Jev endpoint mocked inside the service worker.
// Run with: npm run test:e2e   (needs Chromium; see README)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(here, "..", "extension");
const contentScript = readFileSync(join(extensionPath, "content.js"), "utf8");

let server, baseUrl, context, extensionId, serviceWorker;

before(async () => {
  server = createServer((req, res) => {
    const file = req.url === "/plain" ? "job-plain.html" : "job-jsonld.html";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(readFileSync(join(here, "fixtures", file)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  serviceWorker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  extensionId = new URL(serviceWorker.url()).host;
  // Give the worker a beat to finish evaluating background.js before we poke it.
  await new Promise((r) => setTimeout(r, 500));
});

after(async () => {
  await context?.close();
  server?.close();
});

test("content script extracts a schema.org JobPosting", async () => {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/jsonld`);
  const job = await page.evaluate(contentScript);
  assert.equal(job.source, "json-ld");
  assert.equal(job.title, "Senior Backend Engineer");
  assert.equal(job.company, "Acme Corp");
  assert.equal(job.location, "Berlin, DE / Remote");
  assert.match(job.description, /5\+ years Python/);
  assert.match(job.description, /BSc in Computer Science required/);
  assert.doesNotMatch(job.description, /<p>|<li>/);
  await page.close();
});

test("content script falls back to a job-description container", async () => {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/plain`);
  const job = await page.evaluate(contentScript);
  assert.match(job.source, /selector/);
  assert.equal(job.title, "Data Analyst");
  assert.equal(job.company, "Globex Careers");
  assert.match(job.description, /strong SQL/);
  assert.doesNotMatch(job.description, /Home · Careers · Login/);
  await page.close();
});

test("options page saves the key and resume; test connection calls /v1/models", async () => {
  await mockJev(serviceWorker);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.fill("#apiKey", "sk-test-key");
  await page.click("#saveKey");
  await page.click("#testKey");
  await page.waitForFunction(() => document.querySelector("#keyStatus").textContent.includes("Key works"));
  assert.match(await page.textContent("#keyStatus"), /jev-latest/);

  await page.fill("#resumeText", "Jane Doe\nSenior backend engineer. 8 years Python, Django, Postgres, AWS. BSc CS.");
  await page.click("#saveResume");
  await page.waitForFunction(() => document.querySelector("#resumeStatus").textContent === "Resume saved.");
  assert.match(await page.textContent("#resumeInfo"), /pasted text/);

  const stored = await serviceWorker.evaluate(() => chrome.storage.local.get(["apiKey", "resumeText"]));
  assert.equal(stored.apiKey, "sk-test-key");
  assert.match(stored.resumeText, /Jane Doe/);
  await page.close();
});

test("popup scores the job page through the mocked Jev endpoint", async () => {
  await mockJev(serviceWorker);
  const jobPage = await context.newPage();
  await jobPage.goto(`${baseUrl}/jsonld`);
  // Without the "tabs" permission the extension can't filter by URL, so take
  // the newest tab, which is the job page opened just above.
  const tab = await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.reduce((a, b) => (b.id > a.id ? b : a));
  });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tab.id}`);
  // Without a toolbar click there's no activeTab grant, so supply the text manually
  // as a user would on a page the extension can't read.
  await popup.click("#manual summary");
  await popup.fill("#manualJob", "Senior Backend Engineer at Acme. We need 5+ years of Python, Django and Postgres experience. AWS is a plus. A BSc in Computer Science is required.");
  await popup.click("#check");
  try {
    await popup.waitForSelector("#result:not([hidden])", { timeout: 15000 });
  } catch (e) {
    throw new Error(`result never rendered; status was: ${await popup.textContent("#status")}`);
  }

  assert.equal(await popup.textContent("#scoreValue"), "74");
  assert.equal(await popup.textContent("#verdict"), "Good fit");
  assert.equal(await popup.$$eval("#dimensions li", (els) => els.length), 6);
  assert.equal(await popup.isHidden("#blocker"), false);
  assert.match(await popup.textContent("#resultFooter"), /jev-1\.13\.0/);

  const sent = await serviceWorker.evaluate(() => globalThis.__jevRequests);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(sent[0].headers.Authorization, "Bearer sk-test-key");
  assert.equal(sent[0].body.model, "jev-latest");
  assert.match(sent[0].body.state.resume, /Jane Doe/);
  assert.match(sent[0].body.state.job.description, /5\+ years of Python/);
  assert.equal(Object.keys(sent[0].body.questions).length, 7);

  // Reopening the popup shows the cached result for that URL.
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tab.id}`);
  await popup.waitForSelector("#result:not([hidden])");
  assert.match(await popup.textContent("#resultFooter"), /Last checked/);
  await popup.close();
  await jobPage.close();
});

// Replace fetch inside the extension's service worker with a Jev double that
// returns answers in the documented response shape.
async function mockJev(sw) {
  await sw.evaluate(() => {
    globalThis.__jevRequests = [];
    globalThis.fetch = async (url, init = {}) => {
      const json = (obj, status = 200) =>
        new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
      if (String(url).endsWith("/v1/models")) {
        if (init.headers?.Authorization !== "Bearer sk-test-key") return json({ error: { message: "bad key" } }, 401);
        return json({ models: [{ name: "jev-latest", description: "", release_date: "2026-09-01" }] });
      }
      const body = JSON.parse(init.body);
      globalThis.__jevRequests.push({ url: String(url), headers: init.headers, body });
      const score = (levels, s) => ({
        type: "score", score: s, confidence: 0.8,
        legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
        probabilities: Object.fromEntries(levels.map((_, i) => [String(i), i === Math.round(s) ? 1 : 0])),
      });
      const q = body.questions;
      return json({
        model: "jev-1.13.0",
        answers: {
          required_skills: score(q.required_skills.criteria, 2.7),
          experience_level: score(q.experience_level.criteria, 3),
          responsibilities_fit: score(q.responsibilities_fit.criteria, 2.4),
          domain_relevance: score(q.domain_relevance.criteria, 3),
          overall_fit: score(q.overall_fit.criteria, 3.2),
          would_shortlist: { type: "noul", noul: 0.9 },
          hard_requirement_gap: { type: "noul", noul: 0.7 },
        },
        usage: { input_tokens: 812, output_tokens: 61 },
      });
    };
  });
}
