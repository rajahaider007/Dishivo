import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

const ORG_ID = process.env.ORG_ID || "fd25536";
const BASE = `https://portal.flipdish.com/${ORG_ID}`;
const PROFILE_DIR = path.join(process.cwd(), ".auth", "browser-profile");
const OUT = path.join(process.cwd(), "output", "rms-20261001-131310");
const HEADLESS = String(process.env.HEADLESS ?? "false").toLowerCase() === "true";

const ITEMS = [
  {
    id: "03-rms-inventory-r05-daily-cogs-summary-daily-cogs-summary",
    title: "Daily COGS Summary",
    url: `${BASE}/reports/rms/costs/cogs-summary`,
    category: "Inventory",
  },
  {
    id: "03-rms-inventory-r06-sales-by-product-retail-and-cost-price-by-product-sales",
    title: "Sales By Product",
    url: `${BASE}/reports/rms/inventory/sales-by-product`,
    category: "Inventory",
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function softGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  } catch {
    await page.goto(url, { waitUntil: "commit", timeout: 90000 }).catch(() => {});
  }
  await sleep(2500);
}

async function waitContent(page) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText().catch(() => "");
    if (/Getting things ready|Hold On|Checking for updates/i.test(text)) {
      await sleep(2500);
      continue;
    }
    // still on category list?
    if (/Inventory BI Tools/i.test(text) && /Purchase Orders/i.test(text) && /Sales By Product/i.test(text)) {
      await sleep(2000);
      continue;
    }
    if (
      (/£|\$|\d+\.\d{2}|No results|No data|Filter|Date range|Total|COGS|Product|Quantity|Cost/i.test(text) ||
        (await page.locator("table, canvas, svg").count()) > 0) &&
      text.length > 180
    ) {
      await sleep(4000);
      // confirm Hold On stayed away
      const again = await page.locator("body").innerText().catch(() => "");
      if (!/Hold On|Checking for updates|Getting things ready/i.test(again)) return true;
    }
    await sleep(2500);
  }
  return false;
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1600, height: 1000 },
    locale: "en-GB",
    slowMo: 30,
  });
  const page = context.pages()[0] || (await context.newPage());

  try {
    await softGoto(page, `${BASE}/home`);
    const body = await page.locator("body").innerText().catch(() => "");
    if (/Log in to Flipdish|I am human/i.test(body)) {
      console.log("Login/captcha needed");
      while (true) {
        const t = await page.locator("body").innerText().catch(() => "");
        if (/Reports|Menu Editor/i.test(t) && !/Log in to Flipdish|I am human/i.test(t)) break;
        await sleep(3000);
      }
    }
    console.log("Session OK");

    for (const item of ITEMS) {
      console.log(`→ ${item.title}`);
      console.log(`  ${item.url}`);
      await softGoto(page, item.url);
      const ready = await waitContent(page);
      console.log(ready ? "  content ready" : "  ⚠ content soft-timeout");
      // scroll full page
      await page.evaluate(async () => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        for (let y = 0; y < h; y += 400) {
          window.scrollTo(0, y);
          await pause(200);
        }
        window.scrollTo(0, 0);
      });
      await sleep(1000);
      await page.screenshot({
        path: path.join(OUT, "screenshots", `${item.id}.png`),
        fullPage: true,
      });
      await page.screenshot({
        path: path.join(OUT, "screenshots", `${item.id}-viewport.png`),
        fullPage: false,
      });
      await fs.writeFile(
        path.join(OUT, "details", `${item.id}.json`),
        JSON.stringify(
          {
            tab: "RMS",
            category: item.category,
            report: { title: item.title, href: item.url },
            url: page.url(),
            capturedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf8"
      );
      console.log(`  saved ${page.url()}`);
    }
  } finally {
    await context.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
