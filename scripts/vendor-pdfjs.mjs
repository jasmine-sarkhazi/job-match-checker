// Copies the pdf.js runtime from node_modules into extension/vendor so the
// options page can extract text from PDF resumes. MV3 forbids remote scripts,
// so the files have to ship inside the extension.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist", "build");
const dest = join(root, "extension", "vendor");

if (!existsSync(src)) {
  console.error("pdfjs-dist is not installed. Run `npm install` first.");
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  copyFileSync(join(src, file), join(dest, file));
  console.log(`copied ${file} -> extension/vendor/`);
}
