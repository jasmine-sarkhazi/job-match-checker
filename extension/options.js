const $ = (id) => document.getElementById(id);

init();

async function init() {
  const { apiKey, resumeText, resumeName, resumeUpdatedAt } = await chrome.storage.local.get([
    "apiKey", "resumeText", "resumeName", "resumeUpdatedAt",
  ]);
  if (apiKey) $("apiKey").value = apiKey;
  if (resumeText) $("resumeText").value = resumeText;
  showResumeInfo(resumeName, resumeUpdatedAt, resumeText);

  $("toggleKey").addEventListener("click", () => {
    const input = $("apiKey");
    input.type = input.type === "password" ? "text" : "password";
    $("toggleKey").textContent = input.type === "password" ? "Show" : "Hide";
  });

  $("saveKey").addEventListener("click", async () => {
    const key = $("apiKey").value.trim();
    await chrome.storage.local.set({ apiKey: key });
    setStatus("keyStatus", key ? "Saved." : "Key cleared.", "ok");
  });

  $("testKey").addEventListener("click", async () => {
    const key = $("apiKey").value.trim();
    if (!key) return setStatus("keyStatus", "Enter a key first.", "error");
    setStatus("keyStatus", "Testing…");
    const reply = await chrome.runtime.sendMessage({ type: "TEST_KEY", apiKey: key });
    if (reply?.ok) {
      const names = reply.models.map((m) => m.name).join(", ");
      setStatus("keyStatus", `Key works. Models: ${names || "none listed"}`, "ok");
    } else {
      setStatus("keyStatus", reply?.error || "Test failed.", "error");
    }
  });

  $("resumeFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatus("resumeStatus", `Reading ${file.name}…`);
    try {
      const text = await readResumeFile(file);
      if (!text.trim()) throw new Error("No text could be extracted from that file.");
      $("resumeText").value = text;
      await saveResume(file.name);
    } catch (e) {
      setStatus("resumeStatus", e.message || String(e), "error");
    }
  });

  $("saveResume").addEventListener("click", () => saveResume());
  $("clearResume").addEventListener("click", async () => {
    $("resumeText").value = "";
    $("resumeFile").value = "";
    await chrome.storage.local.remove(["resumeText", "resumeName", "resumeUpdatedAt"]);
    showResumeInfo();
    setStatus("resumeStatus", "Resume cleared.", "ok");
  });
}

async function saveResume(name) {
  const text = $("resumeText").value.trim();
  if (!text) return setStatus("resumeStatus", "Resume text is empty.", "error");
  const stored = await chrome.storage.local.get("resumeName");
  const resumeName = name || stored.resumeName || "pasted text";
  const resumeUpdatedAt = Date.now();
  await chrome.storage.local.set({ resumeText: text, resumeName, resumeUpdatedAt });
  // Old scores were computed against the previous resume; drop them.
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith("result:"));
  if (stale.length) await chrome.storage.local.remove(stale);
  showResumeInfo(resumeName, resumeUpdatedAt, text);
  setStatus("resumeStatus", "Resume saved.", "ok");
}

async function readResumeFile(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) return await file.text();
  return await extractPdfText(file);
}

async function extractPdfText(file) {
  let pdfjs;
  try {
    pdfjs = await import("./vendor/pdf.min.mjs");
  } catch {
    throw new Error(
      "PDF support isn't bundled in this build. Run `npm run build` in the project to add it, or paste your resume text instead.",
    );
  }
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    let lastY = null;
    const lines = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const y = item.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line.trimEnd());
        line = "";
      }
      line += item.str + (item.hasEOL ? "\n" : " ");
      lastY = y;
    }
    if (line) lines.push(line.trimEnd());
    pages.push(lines.join("\n"));
  }
  return pages.join("\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function showResumeInfo(name, updatedAt, text) {
  const el = $("resumeInfo");
  if (!text) {
    el.textContent = "No resume saved yet.";
    return;
  }
  const when = updatedAt ? new Date(updatedAt).toLocaleString() : "";
  el.textContent = `Saved: ${name || "resume"}${when ? ` · ${when}` : ""} · ${text.length.toLocaleString()} characters`;
}

function setStatus(id, text, kind = "") {
  const el = $(id);
  el.textContent = text;
  el.className = `status inline ${kind}`;
}
