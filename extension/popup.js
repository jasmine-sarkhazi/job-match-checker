const $ = (id) => document.getElementById(id);

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("setupButton").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("check").addEventListener("click", () => runCheck());
$("recheck").addEventListener("click", () => runCheck());

let activeTab = null;

init().catch((e) => showStatus(e.message, "error"));

async function init() {
  const { apiKey, resumeText } = await chrome.storage.local.get(["apiKey", "resumeText"]);
  if (!apiKey || !resumeText) {
    $("setup").hidden = false;
    $("ready").hidden = true;
    $("setupMessage").textContent = !resumeText
      ? "Upload your resume once and add your TypeSafe API key to get started."
      : "Add your TypeSafe API key to get started.";
    return;
  }

  // `?tabId=` lets the popup page be driven against a specific tab (used by the
  // end-to-end tests, where the popup is opened as a normal page).
  const forcedTabId = new URLSearchParams(location.search).get("tabId");
  activeTab = forcedTabId
    ? await chrome.tabs.get(Number(forcedTabId))
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const rawUrl = activeTab?.url || activeTab?.pendingUrl || "";
  if (!activeTab || (rawUrl && !/^https?:/.test(rawUrl))) {
    $("check").disabled = true;
    showStatus("Open a job posting in a normal web page first.", "muted");
    return;
  }

  const key = `result:${tabUrl()}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached) renderResult(cached, cached.job, true);
}

async function runCheck() {
  $("check").disabled = true;
  $("result").hidden = true;
  showStatus("Reading the job posting…");
  try {
    const job = await extractJob();
    if (!job.description || job.description.length < 80) {
      throw new Error("Couldn't find a job description on this page. Paste it below and try again.");
    }
    $("jobMeta").hidden = false;
    $("jobTitle").textContent = job.title || "Untitled role";
    $("jobCompany").textContent = job.company || "";

    showStatus("Asking Jev how well you match…");
    const reply = await chrome.runtime.sendMessage({ type: "SCORE_JOB", job });
    if (!reply?.ok) throw new Error(reply?.error || "Unknown error");
    renderResult(reply.result, job, false);
    hideStatus();
  } catch (e) {
    showStatus(e.message || String(e), "error");
  } finally {
    $("check").disabled = false;
  }
}

async function extractJob() {
  const manual = $("manualJob").value.trim();
  const fallback = { url: tabUrl(), title: activeTab.title || "", company: "", location: "", description: "" };
  let job = fallback;
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ["content.js"],
    });
    if (result) job = result;
  } catch (e) {
    // Chrome blocks injection on some pages (PDF viewer, web store, chrome://).
    if (!manual) throw new Error(`Can't read this page (${e.message}). Paste the job description below instead.`);
  }
  if (manual) {
    job.description = manual;
    job.source = "manual";
  }
  return job;
}

function renderResult(result, job, fromCache) {
  $("result").hidden = false;
  $("scoreValue").textContent = result.score;
  $("scoreRing").dataset.tone = result.tone;
  $("scoreRing").style.setProperty("--pct", result.score);
  $("verdict").textContent = result.verdict;
  $("resultJob").textContent = [job?.title, job?.company].filter(Boolean).join(" · ");

  const blocker = $("blocker");
  blocker.hidden = !result.blocker?.flagged;
  if (result.blocker?.flagged) {
    blocker.textContent = `Heads up: Jev thinks there's a ${pct(result.blocker.probability)} chance the job lists a hard requirement your resume doesn't show (degree, certification, clearance, must-have tech).`;
  }

  const list = $("dimensions");
  list.replaceChildren();
  for (const d of result.dimensions) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "dim-head";
    const name = document.createElement("span");
    name.textContent = d.label;
    const val = document.createElement("span");
    val.className = "muted";
    val.textContent = d.probability !== undefined ? pct(d.probability) : d.levelLabel || pct(d.value);
    head.append(name, val);
    const bar = document.createElement("div");
    bar.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.round(d.value * 100)}%`;
    bar.append(fill);
    li.append(head, bar);
    if (d.confidence !== undefined) li.title = `Confidence ${pct(d.confidence)} · weight ${Math.round(d.weight * 100)}%`;
    list.append(li);
  }

  const when = result.scoredAt ? new Date(result.scoredAt).toLocaleString() : "just now";
  $("resultFooter").textContent = `${fromCache ? "Last checked " + when : "Scored"} by ${result.model || "Jev"}${result.usage ? ` · ${result.usage.input_tokens} tokens` : ""}`;
}

// The tab's URL is only exposed once activeTab is granted (a toolbar click);
// fall back to a stable per-tab key so caching still works without it.
function tabUrl() {
  const url = activeTab?.url || activeTab?.pendingUrl || "";
  return url ? url.split("#")[0] : `tab:${activeTab?.id}`;
}

function pct(n) {
  return `${Math.round(Number(n) * 100)}%`;
}

function showStatus(text, kind = "") {
  const el = $("status");
  el.hidden = false;
  el.textContent = text;
  el.className = `status ${kind}`;
}
function hideStatus() {
  $("status").hidden = true;
}
