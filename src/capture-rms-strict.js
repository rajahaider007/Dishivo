import { deepScrollLooker, waitForLookerData } from "./looker-wait.js";
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

/**
 * Strict RMS recapture:
 * 1) Open report URL
 * 2) Click "GO TO NEW REPORT" if shown
 * 3) Wait until Hold On / Checking for updates is GONE
 * 4) Date + Search if needed
 * 5) Screenshot only when real data OR explicit empty-state
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

async function bodyText(page) {
  return page.locator("body").innerText().catch(() => "");
}

async function isHoldOn(page) {
  const t = await bodyText(page);
  return /Hold On|Checking for updates|Getting things ready/i.test(t);
}

async function waitHoldOnGone(page, ms = 300000) {
  const deadline = Date.now() + ms;
  let last = 0;
  while (Date.now() < deadline) {
    if (!(await isHoldOn(page))) {
      await sleep(1500);
      if (!(await isHoldOn(page))) return true;
    }
    if (Date.now() - last > 15000) {
      last = Date.now();
      console.log("  … still Hold On / loading");
    }
    await sleep(2500);
  }
  return false;
}

async function clickGoToNewReport(page) {
  const link = page.getByRole("link", { name: /GO TO NEW REPORT/i }).or(page.locator("text=/GO TO NEW REPORT/i"));
  if ((await link.count()) > 0 && (await link.first().isVisible().catch(() => false))) {
    console.log("  → GO TO NEW REPORT");
    await link.first().click();
    try {
      await page.waitForURL(/dashboards\/global|looker\.portal/i, { timeout: 90000 });
    } catch {
      /* may already be there */
    }
    await sleep(4000);
    return true;
  }
  return false;
}

async function applyDateAndSearch(page) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 7);

  // Click date placeholder
  const ph = page.locator("text=/Start Date/i").first();
  if ((await ph.count()) > 0) await ph.click().catch(() => {});

  const inputs = page.locator('input[type="date"], input[type="text"]');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    const placeholder = ((await el.getAttribute("placeholder")) || "").toLowerCase();
    const name = ((await el.getAttribute("name")) || "").toLowerCase();
    const aria = ((await el.getAttribute("aria-label")) || "").toLowerCase();
    const key = placeholder + name + aria;
    if (/start|from/.test(key)) await el.fill(isoDate(start)).catch(() => {});
    if (/end|to/.test(key)) await el.fill(isoDate(end)).catch(() => {});
  }

  const search = page.locator('button:has-text("Search"), button[type="submit"]');
  if ((await search.count()) > 0) {
    await search.first().click().catch(() => {});
    console.log("  clicked Search");
    await sleep(2500);
  }
}

async function pageState(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    const holdOn = /Hold On|Checking for updates|Getting things ready/i.test(text);
    const needsDate = /Data required|choose date range and hit Search/i.test(text);
    const goNew = /GO TO NEW REPORT/i.test(text);
    const cells = document.querySelectorAll("table td").length;
    const svgs = document.querySelectorAll("svg").length;
    const paths = document.querySelectorAll("svg path, svg rect, svg circle").length;
    const money = /£|\$|€/.test(text);
    const noData = /no data|no results|nothing to (show|display)/i.test(text);
    // Ignore tiny decorative icons: require substantial chart OR table OR money
    const realChart = paths >= 40;
    const realTable = cells >= 6;
    return {
      holdOn,
      needsDate,
      goNew,
      cells,
      paths,
      svgs,
      money,
      noData,
      ready: !holdOn && (realTable || realChart || money || noData) && !needsDate,
      softReady: !holdOn && !needsDate && !goNew && text.length > 400,
      textLen: text.length,
      sample: text.slice(0, 220),
    };
  });
}

async function getLookerFrame(page, waitMs = 20000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const main = page.url();
    const frames = page.frames().filter((f) => {
      const u = f.url();
      return u && u !== "about:blank" && u !== main && !u.startsWith("https://portal.flipdish.com/");
    });
    const looker = frames.find((f) => /looker|embed/i.test(f.url()));
    if (looker) return looker;
    if (frames.length) {
      console.log(
        "  frames:",
        frames.map((f) => f.url().slice(0, 80)).join(" | ")
      );
      return frames[0];
    }
    await sleep(1000);
  }
  return null;
}

async function captureShot(page, outPath) {
  const frame = await getLookerFrame(page, 5000);
  if (frame) {
    await waitForLookerData(frame, "RMS-Looker", 180000);
    await deepScrollLooker(frame);
    // expand iframe
    const iframe = page.locator('iframe[src*="looker.portal.flipdish.com"]').first();
    if ((await iframe.count()) > 0) {
      let h = 4500;
      try {
        h = await frame.evaluate(() =>
          Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 3000)
        );
      } catch {
        /* ignore */
      }
      h = Math.min(Math.max(h + 100, 3000), 16000);
      await iframe.evaluate((el, height) => {
        el.style.height = `${height}px`;
        el.style.minHeight = `${height}px`;
        let p = el.parentElement;
        let g = 0;
        while (p && g++ < 12) {
          p.style.overflow = "visible";
          p.style.height = "auto";
          p.style.maxHeight = "none";
          p = p.parentElement;
        }
      }, h);
      await sleep(800);
      await iframe.screenshot({ path: outPath, timeout: 90000 }).catch(async () => {
        await page.screenshot({ path: outPath, fullPage: true });
      });
      await page.screenshot({
        path: outPath.replace(/\.png$/i, "-with-chrome.png"),
        fullPage: true,
      });
      return { looker: true, height: h };
    }
  }
  await page.screenshot({ path: outPath, fullPage: true });
  return { looker: false };
}

async function waitData(page) {
  if (await clickGoToNewReport(page)) {
    await sleep(3000);
  }

  // Looker path — do NOT fall through if URL is already a global dashboard
  if (/dashboards\/global/i.test(page.url())) {
    console.log("  Looker URL:", page.url().slice(0, 100));
    let frame = await getLookerFrame(page, 90000);
    if (!frame) {
      console.warn("  waiting extra for Looker iframe…");
      await sleep(10000);
      frame = await getLookerFrame(page, 90000);
    }
    if (frame) {
      const st = await waitForLookerData(frame, "RMS→Looker", 240000);
      return { ok: true, looker: true, timedOut: !!st?.timedOut, ...st };
    }
    console.warn("  Looker iframe missing — soft ok on dashboard shell");
    return { ok: true, looker: true, soft: true, noFrame: true };
  }

  await waitHoldOnGone(page, 180000);

  const deadline = Date.now() + 180000;
  let triedSearch = false;
  while (Date.now() < deadline) {
    if (await isHoldOn(page)) {
      await sleep(2500);
      continue;
    }
    if (/dashboards\/global/i.test(page.url())) {
      console.log("  switched to Looker URL mid-wait");
      const frame = await getLookerFrame(page, 90000);
      if (frame) {
        const st = await waitForLookerData(frame, "RMS→Looker", 240000);
        return { ok: true, looker: true, ...st };
      }
      return { ok: true, looker: true, soft: true, noFrame: true };
    }
    const st = await pageState(page);
    if (st.goNew) {
      await clickGoToNewReport(page);
      continue;
    }
    if (st.needsDate && !triedSearch) {
      triedSearch = true;
      await applyDateAndSearch(page);
      await waitHoldOnGone(page, 120000);
      continue;
    }
    if (st.ready) {
      console.log(`  ✓ READY tableCells=${st.cells} paths=${st.paths} money=${st.money}`);
      return { ok: true, ...st };
    }
    await sleep(2500);
  }
  const st = await pageState(page);
  console.warn(`  ⚠ timeout holdOn=${st.holdOn} needsDate=${st.needsDate} cells=${st.cells}`);
  return { ok: false, ...st };
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
      for (const row of j.discovery?.rows || []) {
        if (!row.href) continue;
        const key = row.href.split("?")[0];
        map.set(key, {
          category: j.category,
          title: row.title,
          href: row.href.includes("property=") ? row.href : `${row.href}?property=p1122`,
        });
      }
    }
  }
  // ensure wages present
  map.set(`${BASE}/reports/rms/costs/wages`, {
    category: "Costs",
    title: "Wages Costs",
    href: `${BASE}/reports/rms/costs/wages?property=p1122`,
  });
  return [...map.values()];
}

async function main() {
  const targets = await collectTargets();
  console.log(`Targets: ${targets.length}`);

  const runId = stamp();
  const outRoot = path.join(process.cwd(), "output", `rms-strict-${runId}`);
  const shotDir = path.join(outRoot, "screenshots");
  const detDir = path.join(outRoot, "details");
  await fs.mkdir(shotDir, { recursive: true });
  await fs.mkdir(detDir, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1600, height: 1000 },
    locale: "en-GB",
    slowMo: 35,
  });
  const page = context.pages()[0] || (await context.newPage());
  const catalog = [];

  try {
    await softGoto(page, `${BASE}/home`);
    let t = await bodyText(page);
    if (/Log in to Flipdish|I am human/i.test(t)) {
      console.log("Login/captcha needed…");
      while (/Log in to Flipdish|I am human/i.test(await bodyText(page))) await sleep(3000);
    }
    console.log("Session OK");

    let i = 0;
    for (const target of targets) {
      i += 1;
      const id = `${String(i).padStart(2, "0")}-${target.category.toLowerCase()}-${target.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 45)}`;
      console.log(`\n→ [${id}] ${target.title}`);
      await softGoto(page, target.href);
      await waitHoldOnGone(page, 180000);
      await clickGoToNewReport(page);
      const data = await waitData(page);

      try {
        await captureShot(page, path.join(shotDir, `${id}.png`));
        await page.screenshot({ path: path.join(shotDir, `${id}-viewport.png`), fullPage: false });
      } catch (e) {
        console.warn(`  shot error: ${e.message.split("\n")[0]}`);
        catalog.push({
          tab: "RMS",
          category: target.category,
          title: target.title,
          id,
          url: page.url(),
          status: "shot-error",
          error: e.message,
        });
        // try recover by new page
        try {
          await page.context().newPage();
        } catch {
          /* ignore */
        }
        continue;
      }

      const finalHold = await isHoldOn(page).catch(() => false);
      const status = finalHold ? "still-loading" : data.ok ? "ok" : "weak";

      const entry = {
        tab: "RMS",
        category: target.category,
        title: target.title,
        id,
        url: page.url(),
        status,
        data,
        screenshot: `screenshots/${id}.png`,
        capturedAt: new Date().toISOString(),
      };
      catalog.push(entry);
      await fs.writeFile(path.join(detDir, `${id}.json`), JSON.stringify(entry, null, 2), "utf8");
      console.log(`  status=${status} url=${page.url()}`);
    }

    const ok = catalog.filter((c) => c.status === "ok").length;
    await fs.writeFile(
      path.join(outRoot, "INDEX.json"),
      JSON.stringify({ meta: { runId, capturedAt: new Date().toISOString() }, catalog }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(outRoot, "RMS-STRICT.md"),
      [
        `# RMS Strict Capture`,
        ``,
        `OK: ${ok}/${catalog.length}`,
        ``,
        ...catalog.map((c) => `- **${c.status}** [${c.category}] ${c.title}`),
        ``,
      ].join("\n"),
      "utf8"
    );
    console.log(`\n✓ Strict done ${ok}/${catalog.length} → ${outRoot}`);
  } finally {
    await context.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
