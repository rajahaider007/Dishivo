import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

/**
 * Recapture ALL RMS reports with date range + Search so data actually loads.
 */

const ORG_ID = process.env.ORG_ID || "fd25536";
const BASE = `https://portal.flipdish.com/${ORG_ID}`;
const PROFILE_DIR = path.join(process.cwd(), ".auth", "browser-profile");
const HEADLESS = String(process.env.HEADLESS ?? "false").toLowerCase() === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function softGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  } catch {
    await page.goto(url, { waitUntil: "commit", timeout: 90000 }).catch(() => {});
  }
  await sleep(2000);
}

async function waitNotLoading(page, ms = 180000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText().catch(() => "");
    if (!/Getting things ready|Hold On|Checking for updates/i.test(text)) return true;
    await sleep(2000);
  }
  return false;
}

async function applyDateAndSearch(page) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 7);
  const startStr = isoDate(start);
  const endStr = isoDate(end);

  // Click date range control if present
  const dateBox = page.locator('text=/Start Date\\s*-\\s*End Date/i').first();
  if ((await dateBox.count()) > 0) {
    await dateBox.click({ timeout: 5000 }).catch(() => {});
    await sleep(800);
  }

  // Try fill any visible date inputs
  const dateInputs = page.locator('input[type="date"], input[placeholder*="Date" i], input[placeholder*="dd" i]');
  const n = await dateInputs.count();
  if (n >= 2) {
    await dateInputs.nth(0).fill(startStr).catch(() => {});
    await dateInputs.nth(1).fill(endStr).catch(() => {});
  } else if (n === 1) {
    await dateInputs.first().fill(`${startStr} - ${endStr}`).catch(() => {});
  }

  // Some pickers use text inputs without type=date
  const textInputs = page.locator('input[type="text"]');
  const tc = await textInputs.count();
  for (let i = 0; i < Math.min(tc, 6); i++) {
    const ph = ((await textInputs.nth(i).getAttribute("placeholder")) || "").toLowerCase();
    const aria = ((await textInputs.nth(i).getAttribute("aria-label")) || "").toLowerCase();
    if (/start|from|date/.test(ph + aria)) {
      await textInputs.nth(i).fill(startStr).catch(() => {});
    }
    if (/end|to/.test(ph + aria)) {
      await textInputs.nth(i).fill(endStr).catch(() => {});
    }
  }

  // Click a day in calendar if opened (best-effort)
  const today = page.locator('[class*="day"]:not([class*="disabled"]), td[role="gridcell"], button[name*="day"]').first();
  if ((await today.count()) > 0 && (await today.isVisible().catch(() => false))) {
    await today.click().catch(() => {});
    await sleep(300);
    await today.click().catch(() => {});
  }

  // Search button
  const search = page.getByRole("button", { name: /^Search$/i }).or(page.locator('button:has-text("Search")'));
  if ((await search.count()) > 0) {
    await search.first().click({ timeout: 8000 }).catch(() => {});
    console.log("  clicked Search");
  } else {
    console.log("  ⚠ Search button not found");
  }
  await sleep(3000);
}

async function waitForReportData(page) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText().catch(() => "");
    if (/Hold On|Checking for updates|Getting things ready/i.test(text)) {
      await sleep(2500);
      continue;
    }
    if (/Data required|choose date range and hit Search/i.test(text)) {
      // try search again once
      await applyDateAndSearch(page);
      await sleep(4000);
      const again = await page.locator("body").innerText().catch(() => "");
      if (/Data required|choose date range/i.test(again)) {
        await sleep(3000);
        continue;
      }
    }
    const hasTable = (await page.locator("table td, table th").count()) > 3;
    const hasChart = (await page.locator("svg path, canvas").count()) > 5;
    const hasMoney = /£|\$|\d{1,3}(,\d{3})+/.test(text);
    const noData = /no data|no results|nothing to show/i.test(text);
    if ((hasTable || hasChart || hasMoney || noData) && !/Data required/i.test(text)) {
      console.log(`  ✓ data ready (table=${hasTable} chart=${hasChart} money=${hasMoney} empty=${noData})`);
      await sleep(2000);
      return { ok: true, hasTable, hasChart, hasMoney, noData };
    }
    await sleep(2500);
  }
  console.warn("  ⚠ data wait timeout");
  return { ok: false };
}

async function collectTargets() {
  const roots = [
    path.join(process.cwd(), "output", "rms-20261001-125237"),
    path.join(process.cwd(), "output", "rms-20261001-131310"),
  ];
  const map = new Map();
  for (const root of roots) {
    const details = path.join(root, "details");
    let files = [];
    try {
      files = await fs.readdir(details);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith("-list.json")) continue;
      const j = JSON.parse(await fs.readFile(path.join(details, f), "utf8"));
      const category = j.category;
      for (const row of j.discovery?.rows || []) {
        if (!row.href) continue;
        const key = row.href.split("?")[0];
        map.set(key, {
          category,
          title: row.title,
          href: row.href.includes("property=") ? row.href : `${row.href}?property=p1122`,
        });
      }
    }
  }
  return [...map.values()];
}

async function main() {
  const targets = await collectTargets();
  console.log(`Targets: ${targets.length}`);
  targets.forEach((t, i) => console.log(`  ${i + 1}. [${t.category}] ${t.title.slice(0, 60)}`));

  const runId = stamp();
  const outRoot = path.join(process.cwd(), "output", `rms-filled-${runId}`);
  const shotDir = path.join(outRoot, "screenshots");
  const detDir = path.join(outRoot, "details");
  await fs.mkdir(shotDir, { recursive: true });
  await fs.mkdir(detDir, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1600, height: 1000 },
    locale: "en-GB",
    slowMo: 40,
  });
  const page = context.pages()[0] || (await context.newPage());

  const catalog = [];
  try {
    await softGoto(page, `${BASE}/home`);
    let body = await page.locator("body").innerText().catch(() => "");
    if (/Log in to Flipdish|I am human/i.test(body)) {
      console.log("Login/captcha needed…");
      while (true) {
        body = await page.locator("body").innerText().catch(() => "");
        if (/Reports/i.test(body) && !/Log in to Flipdish|I am human/i.test(body)) break;
        await sleep(3000);
      }
    }
    console.log("Session OK");

    let i = 0;
    for (const t of targets) {
      i += 1;
      const id = `${String(i).padStart(2, "0")}-rms-${t.category.toLowerCase()}-${t.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50)}`;
      console.log(`\n→ [${id}] ${t.title}`);
      console.log(`  ${t.href}`);

      await softGoto(page, t.href);
      await waitNotLoading(page, 120000);
      await applyDateAndSearch(page);
      await waitNotLoading(page, 120000);
      const data = await waitForReportData(page);

      await page.evaluate(async () => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        const h = Math.max(document.body.scrollHeight, 2000);
        for (let y = 0; y < h; y += 500) {
          window.scrollTo(0, y);
          await pause(200);
        }
        window.scrollTo(0, 0);
      });
      await sleep(800);

      await page.screenshot({ path: path.join(shotDir, `${id}.png`), fullPage: true });
      await page.screenshot({ path: path.join(shotDir, `${id}-viewport.png`), fullPage: false });

      const entry = {
        tab: "RMS",
        category: t.category,
        title: t.title,
        id,
        url: page.url(),
        status: data.ok ? "ok" : "no-data",
        data,
        screenshot: `screenshots/${id}.png`,
        capturedAt: new Date().toISOString(),
      };
      catalog.push(entry);
      await fs.writeFile(path.join(detDir, `${id}.json`), JSON.stringify(entry, null, 2), "utf8");
    }

    await fs.writeFile(
      path.join(outRoot, "INDEX.json"),
      JSON.stringify({ meta: { runId, capturedAt: new Date().toISOString() }, catalog }, null, 2),
      "utf8"
    );

    const ok = catalog.filter((c) => c.status === "ok").length;
    const md = [
      `# RMS Filled Reports`,
      ``,
      `**OK with data:** ${ok}/${catalog.length}`,
      ``,
      `| # | Category | Title | Status | URL |`,
      `|---|----------|-------|--------|-----|`,
      ...catalog.map(
        (c, idx) => `| ${idx + 1} | ${c.category} | ${c.title.replace(/\|/g, "/")} | ${c.status} | ${c.url} |`
      ),
      ``,
    ].join("\n");
    await fs.writeFile(path.join(outRoot, "RMS-FILLED.md"), md, "utf8");
    console.log(`\n✓ Done ${ok}/${catalog.length} → ${outRoot}`);
  } finally {
    await context.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
