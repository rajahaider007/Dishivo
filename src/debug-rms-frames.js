import "dotenv/config";
import path from "path";
import { chromium } from "playwright";

const PROFILE_DIR = path.join(process.cwd(), ".auth", "browser-profile");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1600, height: 1000 },
});
const page = context.pages()[0] || (await context.newPage());
await page.goto("https://portal.flipdish.com/fd25536/reports/rms/sales/overview?property=p1122", {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
await sleep(5000);
const link = page.locator("text=/GO TO NEW REPORT/i").first();
if (await link.count()) {
  await link.click();
  await sleep(10000);
}
console.log("URL", page.url());
console.log(
  "FRAMES",
  page.frames().map((f) => f.url())
);
const iframes = await page.locator("iframe").evaluateAll((els) =>
  els.map((e) => ({ src: e.src, id: e.id, class: e.className }))
);
console.log("IFRAMES", iframes);
await page.screenshot({ path: "output/debug-rms-new-report.png", fullPage: true });
await context.close();
