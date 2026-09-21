// Injected on demand into the active tab. Its completion value (the last
// expression) is returned to the popup by chrome.scripting.executeScript.
// Extracts the job posting: title, company, location, description.
(() => {
  const clean = (s) =>
    String(s ?? "")
      .replace(/ /g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const htmlToText = (html) => {
    const doc = new DOMParser().parseFromString(String(html ?? ""), "text/html");
    doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    doc.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, tr").forEach((el) => el.append("\n"));
    return clean(doc.body?.textContent);
  };

  const meta = (name) =>
    document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content") || "";

  // 1. Structured data: most job boards (LinkedIn, Indeed, Greenhouse, Lever,
  //    Workday, Ashby...) embed a schema.org JobPosting.
  const fromJsonLd = () => {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        continue;
      }
      const queue = Array.isArray(data) ? [...data] : [data];
      while (queue.length) {
        const node = queue.shift();
        if (!node || typeof node !== "object") continue;
        const type = node["@type"];
        const isJob = type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
        if (isJob && node.description) {
          const org = node.hiringOrganization;
          const loc = [].concat(node.jobLocation ?? []).map((l) => {
            const a = l?.address;
            if (!a) return typeof l === "string" ? l : "";
            if (typeof a === "string") return a;
            return [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(", ");
          }).filter(Boolean).join("; ");
          const remote = node.jobLocationType === "TELECOMMUTE" ? "Remote" : "";
          return {
            title: clean(node.title || node.name),
            company: clean(typeof org === "string" ? org : org?.name),
            location: clean([loc, remote].filter(Boolean).join(" / ")),
            description: htmlToText(node.description),
            source: "json-ld",
          };
        }
        if (node["@graph"]) queue.push(...[].concat(node["@graph"]));
        if (node.mainEntity) queue.push(node.mainEntity);
      }
    }
    return null;
  };

  // 2. Known job-board containers, then generic main-content containers.
  const SELECTORS = [
    "#job-details", ".jobs-description__content", ".show-more-less-html__markup", // LinkedIn
    "#jobDescriptionText", // Indeed
    '[data-automation-id="jobPostingDescription"]', // Workday
    ".job__description", "#content .content", // Greenhouse
    ".posting-page", ".section-wrapper.page-full-width", // Lever
    '[class*="JobDetails_jobDescription"]', // Glassdoor
    '[class*="ashby-job-posting"]', // Ashby
    ".job-description", "#job-description", "[class*='job-description']", "[class*='jobDescription']",
    "article", "main", "[role='main']",
  ];
  const fromSelectors = () => {
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      const text = clean(el?.innerText);
      if (text && text.length > 300) return { description: text, source: `selector ${sel}` };
    }
    return null;
  };

  const fallback = () => ({ description: clean(document.body?.innerText), source: "body" });

  const found = fromJsonLd() || fromSelectors() || fallback();
  const title =
    found.title ||
    clean(document.querySelector("h1")?.innerText) ||
    clean(meta("og:title")) ||
    clean(document.title);
  const company = found.company || clean(meta("og:site_name")) || "";

  return {
    url: location.href.split("#")[0],
    title,
    company,
    location: found.location || "",
    description: found.description || "",
    source: found.source,
  };
})();
