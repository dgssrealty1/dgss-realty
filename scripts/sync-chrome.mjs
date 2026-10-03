// The global header, footer and back-to-top button are written ONCE, in
// index.html (between the <!--chrome:…--> markers). This script copies
// them into every other public page file, with the same link rewriting
// and "current page" marking the Worker uses, so each page file is
// complete on its own:
//
//     Global header  →  page content  →  Global footer
//
// The Worker re-applies the same header/footer (with live Admin settings)
// when it serves these pages, so a stale copy can never reach visitors.
// Run after editing the header or footer in index.html:
//     npm run sync:chrome
// tests/cms.test.mjs fails if any page file is out of date.
import fs from "node:fs";
import { extractChrome, injectChrome, SITE_PAGES } from "../src/app.js";

const root = new URL("../", import.meta.url);

/* Page file → navigation item marked as the current page. */
export const CHROME_PAGES = {
  ...Object.fromEntries(Object.entries(SITE_PAGES).map(([slug, p]) => [`${slug}.html`, p.nav])),
  "404.html": ""
};

export function syncedHtml(pageHtml, indexHtml, activeKey = "") {
  return injectChrome(pageHtml, extractChrome(indexHtml), activeKey);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const index = fs.readFileSync(new URL("index.html", root), "utf8");
  for (const [file, activeKey] of Object.entries(CHROME_PAGES)) {
    const url = new URL(file, root);
    const before = fs.readFileSync(url, "utf8");
    const after = syncedHtml(before, index, activeKey);
    if (after !== before) { fs.writeFileSync(url, after); console.log(`updated ${file}`); }
    else console.log(`${file} already up to date`);
  }
}
