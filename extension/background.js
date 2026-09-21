// Service worker: the only place that holds the API key in memory and talks to
// Jev. The popup sends it a job posting and gets back a scored result.
import { askJev, listModels } from "./jev.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SCORE_JOB") {
    scoreJob(message.job)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true; // keep the channel open for the async response
  }
  if (message?.type === "TEST_KEY") {
    listModels({ apiKey: message.apiKey })
      .then((models) => sendResponse({ ok: true, models }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  return false;
});

async function scoreJob(job) {
  const { apiKey, resumeText } = await chrome.storage.local.get(["apiKey", "resumeText"]);
  if (!resumeText) throw new Error("No resume saved yet. Upload one in the extension options.");
  const result = await askJev({ apiKey, resume: resumeText, job });
  // Remember the last result per page so reopening the popup shows it instantly.
  const entry = { ...result, job, scoredAt: Date.now() };
  delete entry.request; // don't persist the full resume again
  await chrome.storage.local.set({ [`result:${job.url}`]: entry });
  return result;
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});
