import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";
import { deepScrollLooker, waitForLookerData as waitLookerTiles } from "./looker-wait.js";

/**
 * Flipdish Reports capturer — accurate Main + RMS dashboard crawl.
 * Customer wants the SAME reports in Dishivo.
 */

const ORG_ID = process.env.ORG_ID || "fd25536";
const BASE = `https://portal.flipdish.com/${ORG_ID}`;
const REPORTS_MAIN = `${BASE}/reports/dashboards?tab=main`;
const REPORTS_RMS = `${BASE}/reports/dashboards?tab=rms`;
const HEADLESS = String(process.env.HEADLESS ?? "false").toLowerCase() === "true";
const PROFILE_DIR = path.join(process.cwd(), ".auth", "browser-profile");
/** Looker dashboards often need 60–180s before charts/tables render */
const REPORT_LOAD_MS = Number(process.env.REPORT_LOAD_MS || 180000);

const VALID_REPORT_TITLES = new Set(
  [
    "Sales Summary Report",
    "Property Operations Report",
    "Sales Tax Report",
    "Tips Report",
    "Orders",
    "Business Review",
    "Campaign Performance Report",
    "Customers Report",
    "Flipdish Phone Marketing (FPM) Report",
    "Menu Items Report",
  ].map((t) => t.toLowerCase())
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}
async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}
function slug(s) {
  return String(s || "report")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
}
function isAuthUrl(url = "") {
  return /auth\.portal\.flipdish\.com|\/u\/login/i.test(url);
}

async function softGoto(page, url, timeout = 60000) {
  const before = page.url();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  } catch {
    try {
      await page.goto(url, { waitUntil: "commit", timeout });
    } catch (e) {
      console.warn(`  warn goto: ${e.message.split("\n")[0]}`);
    }
  }
  await sleep(2500);
  return page.url() !== before;
}

async function dismissNoise(page) {
  for (const sel of [
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    'button:has-text("Not now")',
    'button:has-text("Maybe later")',
    'button[aria-label="Close"]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible())) await el.click({ timeout: 600 }).catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

async function isLoggedIn(page) {
  if (isAuthUrl(page.url())) return false;
  const text = await page.locator("body").innerText().catch(() => "");
  if (/Log in to Flipdish|Continue with Google|I am human/i.test(text)) return false;
  return /Reports|Sales|Menu Editor|Properties|Marketing/i.test(text);
}

async function waitLoggedIn(page) {
  await softGoto(page, `${BASE}/home`);
  await dismissNoise(page);
  if (await isLoggedIn(page)) {
    console.log("→ Session OK:", page.url());
    return;
  }
  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Login required — captcha/manual login karo      ║");
  console.log("║  Bot wait karega (no timeout)                    ║");
  console.log("╚══════════════════════════════════════════════════╝");
  while (!(await isLoggedIn(page))) await sleep(3000);
  console.log("→ Login OK");
}

/**
 * Discover every dashboard row: title, tags, description, href (if any).
 */
async function discoverReports(page) {
  const discovery = await page.evaluate(() => {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();

    // Collect candidate clickable rows near "All dashboards"
    const rows = [];
    const seen = new Set();

    const all = [...document.querySelectorAll("a, button, [role='link'], [role='button'], li, div")];
    for (const el of all) {
      const raw = clean(el.innerText);
      if (!raw || raw.length < 12 || raw.length > 450) continue;
      // Must look like a report row: title-ish + description OR has graph/chevron pattern
      if (!/report|orders|business review|tips|customers|menu items|phone marketing|fpm/i.test(raw)) continue;
      if (/^all dashboards|^main$|^rms$/i.test(raw)) continue;

      // Prefer leaf-ish containers that include a short title line
      const lines = raw
        .split(/\n/)
        .map(clean)
        .filter(Boolean);
      // Also handle single-line concatenated text
      let title = lines[0] || "";
      // If first line is too long, try regex titles
      const titleMatch = raw.match(
        /^((?:Sales Summary Report|Property Operations Report|Sales Tax Report|Tips Report|Orders|Business Review|Campaign Performance Report|Customers Report|Flipdish Phone Marketing \(FPM\) Report|Menu Items Report|[A-Z][A-Za-z0-9 /()%-]{2,60}))/
      );
      if (titleMatch) title = clean(titleMatch[1]);

      // Skip nav / chrome
      if (/^(Home|Sales|Properties|Menu Editor|Reports|Marketing|Sales Channels|Settings|Add-ons)$/i.test(title))
        continue;
      if (title.length < 3 || title.length > 80) continue;
      if (/home sales|menu editor reports|sales channels settings/i.test(title)) continue;
      if (seen.has(title.toLowerCase())) continue;

      // Only keep if description-like content exists OR known report words
      const isReport =
        /report/i.test(title) ||
        /^(Orders|Business Review)$/i.test(title) ||
        /Tabbed sales|general overview|detailed view|Key metrics|Ordering channel|powerful and flexible|examination of key/i.test(
          raw
        );
      if (!isReport) continue;

      const tags = [];
      if (/online ordering/i.test(raw)) tags.push("Online ordering");
      if (/point of sale/i.test(raw)) tags.push("Point of Sale");
      if (/\bRMS\b/i.test(raw)) tags.push("RMS");

      let description = raw.replace(title, "").trim();
      description = description
        .replace(/Online ordering/gi, "")
        .replace(/Point of Sale/gi, "")
        .replace(/\bRMS\b/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 260);

      // Find best href
      let href = "";
      const a = el.closest("a") || (el.tagName === "A" ? el : el.querySelector?.("a"));
      if (a && a.href && !/#$/.test(a.href) && !/logout/i.test(a.href)) href = a.href;

      // data attributes sometimes hold ids
      const dataHref =
        el.getAttribute("href") ||
        el.getAttribute("data-href") ||
        el.getAttribute("data-url") ||
        el.closest("[href]")?.getAttribute("href") ||
        "";

      if (!href && dataHref && dataHref.startsWith("http")) href = dataHref;
      if (!href && dataHref && dataHref.startsWith("/")) href = location.origin + dataHref;

      seen.add(title.toLowerCase());
      rows.push({
        title,
        tags,
        description,
        href,
        // bounding text fingerprint for click
        fingerprint: raw.slice(0, 120),
      });
    }

    // Sort: keep unique stable order as on page (Sales Summary first ideally)
    const priority = [
      "Sales Summary Report",
      "Property Operations Report",
      "Sales Tax Report",
      "Tips Report",
      "Orders",
      "Business Review",
      "Campaign Performance Report",
      "Customers Report",
      "Flipdish Phone Marketing (FPM) Report",
      "Menu Items Report",
    ];
    rows.sort((a, b) => {
      const ia = priority.findIndex((p) => p.toLowerCase() === a.title.toLowerCase());
      const ib = priority.findIndex((p) => p.toLowerCase() === b.title.toLowerCase());
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

    return {
      url: location.href,
      rows,
      bodySample: clean(document.body.innerText).slice(0, 3500),
    };
  });

  discovery.rows = (discovery.rows || []).filter((r) => VALID_REPORT_TITLES.has(r.title.toLowerCase()));
  return discovery;
}

async function openReport(page, report, indexUrl) {
  const before = page.url();

  // 1) Direct href navigation
  if (report.href && /flipdish\.com/i.test(report.href)) {
    await softGoto(page, report.href);
    await dismissNoise(page);
    await waitReady(page);
    if (page.url() !== indexUrl && !/tab=main|tab=rms|\/dashboards\/?(\?|$)/i.test(page.url().split("?")[0] + "?")) {
      // navigated somewhere useful
      if (page.url() !== before) return true;
    }
    // If still on index, fall through to click
    if (!/dashboards\?tab=/i.test(page.url()) || page.url() === report.href) {
      // if href itself was a dashboard detail, OK
      if (!/dashboards\?tab=/i.test(page.url())) return true;
    }
  }

  // Ensure on index
  if (!page.url().includes("dashboards")) {
    await softGoto(page, indexUrl);
    await dismissNoise(page);
  }

  // 2) Click by exact title text (force scroll into view)
  const titleLoc = page.getByText(report.title, { exact: true }).first();
  if ((await titleLoc.count()) > 0) {
    try {
      await titleLoc.scrollIntoViewIfNeeded();
      await titleLoc.click({ timeout: 5000 });
      await sleep(3000);
      await waitReady(page);
      if (page.url() !== indexUrl && page.url() !== before) return true;
      // URL may be same SPA path with different hash — check content change
      if (!(await stillOnIndex(page))) return true;
    } catch {
      /* continue */
    }
  }

  // 3) Click row via JS — find element with title and click clickable ancestor
  const clicked = await page.evaluate((title) => {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const nodes = [...document.querySelectorAll("a, button, div, li, span, p, h1, h2, h3, h4")];
    for (const n of nodes) {
      const t = clean(n.innerText);
      if (t === title || (t.startsWith(title) && t.length < title.length + 20)) {
        let cur = n;
        for (let i = 0; i < 8 && cur; i++) {
          const style = window.getComputedStyle(cur);
          const clickable =
            cur.tagName === "A" ||
            cur.tagName === "BUTTON" ||
            cur.getAttribute("role") === "button" ||
            cur.getAttribute("role") === "link" ||
            typeof cur.onclick === "function" ||
            style.cursor === "pointer";
          if (clickable) {
            cur.click();
            return { ok: true, via: cur.tagName, href: cur.href || "" };
          }
          cur = cur.parentElement;
        }
        n.click();
        return { ok: true, via: "self" };
      }
    }
    return { ok: false };
  }, report.title);

  if (clicked?.ok) {
    await sleep(3500);
    await waitReady(page);
    if (!(await stillOnIndex(page))) return true;
    if (clicked.href) {
      await softGoto(page, clicked.href);
      await waitReady(page);
      if (!(await stillOnIndex(page))) return true;
    }
  }

  // 4) Playwright locator: row containing title + chevron area
  try {
    const row = page.locator(`div:has-text("${report.title}")`).filter({ hasText: report.title }).first();
    await row.scrollIntoViewIfNeeded();
    await row.click({ timeout: 4000, position: { x: 40, y: 20 } });
    await sleep(3500);
    await waitReady(page);
    if (!(await stillOnIndex(page))) return true;
  } catch {
    /* ignore */
  }

  return !(await stillOnIndex(page));
}

async function stillOnIndex(page) {
  const url = page.url();
  if (/dashboards\?tab=/i.test(url) && (await page.getByText("All dashboards").count()) > 0) {
    // If multiple report titles still visible, we're on index
    const text = await page.locator("body").innerText().catch(() => "");
    const count =
      (text.match(/Sales Summary Report|Property Operations Report|Sales Tax Report|Tips Report/g) || []).length;
    return count >= 2;
  }
  return false;
}

async function waitReady(page) {
  await sleep(1500);
  for (let i = 0; i < 25; i++) {
    const loading = await page.locator("text=/loading|getting things ready/i").count();
    const spinner = await page.locator('[class*="spinner"], [class*="Loader"], [role="progressbar"]').count();
    if (loading === 0 && spinner === 0) break;
    await sleep(800);
  }
  await sleep(1000);
}

async function getLookerFrame(page, waitMs = 45000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => /looker\.portal\.flipdish\.com/i.test(f.url()));
    if (frame) return frame;
    await sleep(1000);
  }
  return null;
}

async function waitForOrdersReport(page) {
  const deadline = Date.now() + REPORT_LOAD_MS;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const body = (document.body?.innerText || "").replace(/\s+/g, " ");
      const tables = document.querySelectorAll("table td").length;
      const charts = document.querySelectorAll("svg, canvas").length;
      const loading = document.querySelectorAll('[class*="loading"], [class*="spinner"]').length;
      const hasData = /£|\d{1,3}(,\d{3})+|orders?/i.test(body);
      return {
        tables,
        charts,
        loading,
        hasData,
        score: (hasData ? 2 : 0) + (tables > 6 ? 2 : 0) + (charts > 2 ? 1 : 0) - loading,
      };
    });
    if (state.score >= 4 && state.loading === 0) {
      console.log("  ✓ Orders report data ready");
      await sleep(2500);
      return state;
    }
    await sleep(2500);
  }
  console.warn("  ⚠ Orders report wait timeout");
  return { timedOut: true };
}

async function waitForLookerData(frame, label = "dashboard") {
  return waitLookerTiles(frame, label, REPORT_LOAD_MS);
}

async function waitForReportFullyLoaded(page, reportTitle) {
  await waitReady(page);
  await sleep(2000);
  if (/^orders$/i.test(reportTitle)) {
    await waitForOrdersReport(page);
    return;
  }
  const frame = await getLookerFrame(page, 60000);
  if (!frame) {
    console.warn("  ⚠ No Looker iframe — waiting extra on main page");
    await sleep(15000);
    return;
  }
  console.log(`  Looker frame: ${frame.url().slice(0, 80)}…`);
  await waitForLookerData(frame, reportTitle);
  await deepScrollLooker(frame);
  await sleep(2500);
  try {
    await frame.evaluate(() => window.scrollTo(0, 0));
  } catch {
    /* ignore */
  }
}

async function captureLookerInnerTabs(page, id, outDirs, parentTitle) {
  const frame = await getLookerFrame(page, 15000);
  if (!frame) return [];

  let tabNames = [];
  try {
    tabNames = await frame.evaluate(() => {
      const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
      const fromTabs = [...document.querySelectorAll('[role="tab"], .dashboard-navigation-tab, .tab-item, a.tab')]
        .map((el) => clean(el.innerText))
        .filter(Boolean);
      const known = ["Summary", "Trends", "Properties", "Sales Data", "Overview", "Data", "Item Trends", "Menu Items Data", "Customers", "Delivery Map"];
      const merged = [...fromTabs];
      for (const k of known) {
        if (fromTabs.some((t) => t.toLowerCase() === k.toLowerCase()) && !merged.some((t) => t.toLowerCase() === k.toLowerCase())) {
          merged.push(k);
        }
      }
      return merged.filter((v, i, a) => a.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i).slice(0, 8);
    });
  } catch {
    tabNames = ["Summary", "Trends", "Properties", "Sales Data"];
  }

  const captured = [];
  let ti = 0;
  for (const tabName of tabNames) {
    if (/^(main|rms)$/i.test(tabName)) continue;
    ti += 1;
    try {
      const tabLoc = frame.locator('[role="tab"]').filter({ hasText: new RegExp(`^${tabName}$`, "i") });
      if ((await tabLoc.count()) > 0) {
        await tabLoc.first().click({ timeout: 8000 });
      } else {
        await frame.getByText(tabName, { exact: true }).first().click({ timeout: 5000 });
      }
      console.log(`    tab: ${tabName}`);
      // Secondary tabs: shorter wait (different tile titles — don't hang 6 min)
      await waitLookerTiles(frame, `${parentTitle} → ${tabName}`, Math.min(REPORT_LOAD_MS, 60000));
      const subId = `${id}-tab-${String(ti).padStart(2, "0")}-${slug(tabName)}`;
      await captureFullReportShot(page, path.join(outDirs.screenshots, `${subId}.png`));
      await page.screenshot({
        path: path.join(outDirs.screenshots, `${subId}-viewport.png`),
        fullPage: false,
      });
      const sub = await extractReportDetails(page);
      await writeJson(path.join(outDirs.details, `${subId}.json`), {
        parent: parentTitle,
        innerTab: tabName,
        details: sub,
      });
      captured.push(subId);
    } catch (e) {
      console.warn(`    tab skip ${tabName}: ${e.message.split("\n")[0]}`);
    }
  }
  return captured;
}

/**
 * Expand Looker iframe to its full content height so screenshots aren't clipped.
 * (Playwright fullPage only covers the outer page — iframe inner scroll is separate.)
 */
async function expandLookerIframe(page) {
  const iframe = page.locator('iframe[src*="looker.portal.flipdish.com"]').first();
  if ((await iframe.count()) === 0) return { expanded: false, height: 0 };

  const frame = await getLookerFrame(page, 10000);
  if (!frame) return { expanded: false, height: 0 };

  // Force-load lazy tiles by scrolling inside Looker, then measure true height
  let contentHeight = 2000;
  try {
    contentHeight = await frame.evaluate(async () => {
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      const measure = () => {
        let max = Math.max(
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0,
          document.documentElement?.offsetHeight || 0,
          document.body?.offsetHeight || 0
        );
        for (const el of document.querySelectorAll("div, section, main")) {
          const h = el.scrollHeight || 0;
          if (h > max && h < 50000) max = h;
        }
        return max;
      };

      let last = 0;
      for (let i = 0; i < 30; i++) {
        const h = measure();
        window.scrollTo(0, h);
        await pause(250);
        const next = measure();
        if (next <= last + 2 && i > 3) break;
        last = next;
      }
      window.scrollTo(0, 0);
      await pause(300);
      return Math.max(measure(), last, 2000);
    });
  } catch {
    contentHeight = 3500;
  }

  // Pad for chrome inside embed; force tall enough for multi-tile Looker dashboards
  const target = Math.min(Math.max(contentHeight + 120, 4500), 16000);
  console.log(`  measured Looker content ~${contentHeight}px → expand ${target}px`);

  await iframe.evaluate((el, h) => {
    el.style.height = `${h}px`;
    el.style.minHeight = `${h}px`;
    el.style.maxHeight = "none";
    el.setAttribute("height", String(h));

    let p = el.parentElement;
    let guard = 0;
    while (p && guard++ < 16) {
      p.style.overflow = "visible";
      p.style.overflowY = "visible";
      p.style.height = "auto";
      p.style.maxHeight = "none";
      p.style.minHeight = `${h}px`;
      p = p.parentElement;
    }
  }, target);

  // Also unlock overflow inside Looker document
  try {
    await frame.evaluate((h) => {
      document.documentElement.style.overflow = "visible";
      document.body.style.overflow = "visible";
      document.documentElement.style.height = "auto";
      document.body.style.height = "auto";
      document.documentElement.style.minHeight = `${h}px`;
      document.body.style.minHeight = `${h}px`;
    }, target);
  } catch {
    /* ignore */
  }

  await page
    .evaluate(() => {
      for (const sel of ['iframe[title="Intercom"]', "[class*='intercom']", "[id*='intercom']"]) {
        document.querySelectorAll(sel).forEach((n) => {
          n.style.display = "none";
        });
      }
    })
    .catch(() => {});

  await sleep(1200);

  // Re-measure after expand (layout may grow)
  try {
    const again = await frame.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
    );
    if (again > target + 50) {
      const taller = Math.min(again + 100, 16000);
      await iframe.evaluate((el, h) => {
        el.style.height = `${h}px`;
        el.style.minHeight = `${h}px`;
      }, taller);
      await sleep(600);
      return { expanded: true, height: taller };
    }
  } catch {
    /* ignore */
  }

  return { expanded: true, height: target };
}

async function stitchScrollShots(page, outPath) {
  // Fallback: scroll main window + looker frame and stitch vertically with pure PNG via CDP
  const tiles = [];
  const viewport = page.viewportSize() || { width: 1600, height: 1000 };
  const frame = await getLookerFrame(page, 5000);

  const scrollTarget = frame || page;
  let totalHeight = viewport.height;
  try {
    totalHeight = await scrollTarget.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
    );
  } catch {
    /* ignore */
  }

  const step = Math.floor(viewport.height * 0.85);
  for (let y = 0; y < totalHeight && tiles.length < 25; y += step) {
    try {
      await scrollTarget.evaluate((yy) => window.scrollTo(0, yy), y);
    } catch {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
    }
    await sleep(400);
    const buf = await page.screenshot({ type: "png", fullPage: false });
    tiles.push({ y, buf });
  }

  // Write first tile if stitch lib unavailable — prefer expanded single shot
  if (tiles.length === 1) {
    await fs.writeFile(outPath, tiles[0].buf);
    return;
  }

  // Simple vertical stitch using Playwright's built-in isn't available —
  // use expand path primarily. Here save a long composite via canvas in page.
  const dataUrls = tiles.map((t) => `data:image/png;base64,${t.buf.toString("base64")}`);
  const stitched = await page.evaluate(
    async ({ urls, width, step: st, total }) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
      const images = [];
      for (const u of urls) images.push(await load(u));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.min(total, images.length * st + (images[0]?.height || st));
      const ctx = canvas.getContext("2d");
      let dy = 0;
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const drawH = i === images.length - 1 ? img.height : Math.min(st, img.height);
        ctx.drawImage(img, 0, 0, width, drawH, 0, dy, width, drawH);
        dy += drawH;
      }
      canvas.height = dy;
      return canvas.toDataURL("image/png").split(",")[1];
    },
    { urls: dataUrls, width: viewport.width, step, total: totalHeight }
  );

  await fs.writeFile(outPath, Buffer.from(stitched, "base64"));
  try {
    if (frame) await frame.evaluate(() => window.scrollTo(0, 0));
  } catch {
    /* ignore */
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function captureFullReportShot(page, outPath) {
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

  const { expanded, height } = await expandLookerIframe(page);
  console.log(expanded ? `  full-page expand iframe → ${height}px` : "  no Looker iframe — page fullPage");

  if (expanded) {
    const iframe = page.locator('iframe[src*="looker.portal.flipdish.com"]').first();
    try {
      await iframe.screenshot({ path: outPath, timeout: 90000 });
      const combined = outPath.replace(/\.png$/i, "-with-chrome.png");
      await page.screenshot({ path: combined, fullPage: true, timeout: 90000 });
      const stitchPath = outPath.replace(/\.png$/i, "-stitched.png");
      await stitchScrollShots(page, stitchPath);
      console.log(`  saved: full iframe + chrome + stitched`);
      return;
    } catch (e) {
      console.warn(`  iframe shot failed: ${e.message.split("\n")[0]} — stitch fallback`);
      await stitchScrollShots(page, outPath);
      return;
    }
  }

  await page.screenshot({ path: outPath, fullPage: true, timeout: 90000 });
}

async function extractReportDetails(page) {
  return page.evaluate(() => {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    return {
      title: document.title,
      url: location.href,
      headings: [...document.querySelectorAll("h1,h2,h3,h4")]
        .map((el) => clean(el.innerText))
        .filter(Boolean)
        .slice(0, 50),
      tabs: [...document.querySelectorAll('[role="tab"]')]
        .map((el) => clean(el.innerText))
        .filter((t) => t && t.length < 50)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 40),
      filters: [...document.querySelectorAll("label, [class*='filter'], select, [role='combobox']")]
        .map((el) => clean(el.innerText || el.getAttribute("aria-label") || ""))
        .filter((t) => t && t.length < 80)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 50),
      buttons: [...document.querySelectorAll("button")]
        .map((el) => clean(el.innerText || el.getAttribute("aria-label")))
        .filter((t) => t && t.length < 60)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 50),
      kpis: [...document.querySelectorAll("[class*='metric'], [class*='kpi'], [class*='stat']")]
        .map((el) => clean(el.innerText))
        .filter((t) => t && t.length < 120 && /\d/.test(t))
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 30),
      tables: [...document.querySelectorAll("table")].slice(0, 8).map((table, idx) => ({
        index: idx,
        headers: [...table.querySelectorAll("th")].map((th) => clean(th.innerText)),
        sampleRows: [...table.querySelectorAll("tr")]
          .slice(0, 15)
          .map((tr) => [...tr.querySelectorAll("td")].map((td) => clean(td.innerText)))
          .filter((r) => r.length),
      })),
      iframes: [...document.querySelectorAll("iframe")].map((f) => ({ src: f.src || "", title: f.title || "" })),
      bodyText: clean(document.body?.innerText || "").slice(0, 16000),
    };
  });
}


async function captureTab(page, tabName, tabUrl, outDirs, catalog) {
  console.log(`\n══ Tab: ${tabName} ══`);
  await softGoto(page, tabUrl);
  await dismissNoise(page);
  await waitReady(page);

  // Click tab control too (SPA)
  const tab = page.getByRole("tab", { name: new RegExp(`^${tabName}$`, "i") });
  if ((await tab.count()) > 0) {
    await tab.first().click().catch(() => {});
    await sleep(1500);
  }

  const indexUrl = page.url();
  await page.screenshot({
    path: path.join(outDirs.screenshots, `00-${slug(tabName)}-index.png`),
    fullPage: true,
  });

  let discovery = await discoverReports(page);
  await writeJson(path.join(outDirs.details, `00-${slug(tabName)}-index.json`), {
    tab: tabName,
    indexUrl,
    discovery,
    capturedAt: new Date().toISOString(),
  });

  let reports = discovery.rows || [];

  // Parse extra titles from bodySample if discovery missed some (Customers, FPM, Menu Items…)
  if (discovery.bodySample) {
    const known = [
      "Sales Summary Report",
      "Property Operations Report",
      "Sales Tax Report",
      "Tips Report",
      "Orders",
      "Business Review",
      "Campaign Performance Report",
      "Customers Report",
      "Flipdish Phone Marketing (FPM) Report",
      "Menu Items Report",
    ];
    for (const title of known) {
      if (!discovery.bodySample.includes(title)) continue;
      if (reports.some((r) => r.title.toLowerCase() === title.toLowerCase())) continue;
      reports.push({ title, tags: [], description: "", href: "" });
    }
  }

  // Deduplicate
  const uniq = [];
  for (const r of reports) {
    if (!uniq.some((u) => u.title.toLowerCase() === r.title.toLowerCase())) uniq.push(r);
  }
  reports = uniq;

  console.log(`  Found ${reports.length} reports`);
  if (!reports.length) {
    console.log("  (empty tab)");
    return;
  }

  let i = 0;
  for (const report of reports) {
    i += 1;
    const id = `${String(i).padStart(2, "0")}-${slug(tabName)}-${slug(report.title)}`;
    console.log(`→ [${id}] ${report.title}`);

    await softGoto(page, indexUrl);
    await dismissNoise(page);
    await sleep(1000);

    const opened = await openReport(page, report, indexUrl);
    if (!opened) {
      console.log("  ✗ could not open — saving index context only");
      catalog.push({ ...report, tab: tabName, id, status: "open-failed", screenshot: `screenshots/00-${slug(tabName)}-index.png` });
      continue;
    }

    console.log(`  opened: ${page.url()}`);
    await dismissNoise(page);
    console.log(`  waiting for report data (up to ${Math.round(REPORT_LOAD_MS / 1000)}s)…`);
    await waitForReportFullyLoaded(page, report.title);

    const details = await extractReportDetails(page);
    await captureFullReportShot(page, path.join(outDirs.screenshots, `${id}.png`));
    await page.screenshot({ path: path.join(outDirs.screenshots, `${id}-viewport.png`), fullPage: false });

    const innerShots = await captureLookerInnerTabs(page, id, outDirs, report.title);
    if (innerShots.length) console.log(`  inner tabs captured: ${innerShots.length}`);

    await writeJson(path.join(outDirs.details, `${id}.json`), {
      tab: tabName,
      report,
      capturedAt: new Date().toISOString(),
      details,
    });

    await fs.writeFile(
      path.join(outDirs.details, `${id}.txt`),
      [
        `# ${report.title}`,
        `Tab: ${tabName}`,
        `Tags: ${(report.tags || []).join(", ")}`,
        `Description: ${report.description || ""}`,
        `URL: ${details.url}`,
        "",
        "## Headings",
        ...(details.headings || []).map((h) => `- ${h}`),
        "",
        "## Tabs",
        ...(details.tabs || []).map((t) => `- ${t}`),
        "",
        "## Filters",
        ...(details.filters || []).map((f) => `- ${f}`),
        "",
        "## Actions",
        ...(details.buttons || []).map((b) => `- ${b}`),
        "",
        "## KPIs",
        ...(details.kpis || []).map((k) => `- ${k}`),
        "",
        "## Body excerpt",
        details.bodyText || "",
      ].join("\n"),
      "utf8"
    );

    catalog.push({
      ...report,
      tab: tabName,
      id,
      status: "ok",
      url: details.url,
      headings: details.headings?.slice(0, 15) || [],
      filters: details.filters?.slice(0, 20) || [],
      screenshot: `screenshots/${id}.png`,
      detailFile: `details/${id}.json`,
    });
  }
}

function buildPack(meta, catalog) {
  const ok = catalog.filter((c) => c.status === "ok");
  return [
    `# Flipdish Reports — Client Parity Pack`,
    ``,
    `Customer wants **the same reports** as Flipdish.`,
    ``,
    `**Org:** \`${ORG_ID}\` · **Captured:** ${meta.capturedAt} · **OK:** ${ok.length}/${catalog.length}`,
    ``,
    `## Index`,
    ``,
    `| Tab | Report | Tags | Status | Screenshot |`,
    `|-----|--------|------|--------|------------|`,
    ...catalog.map(
      (c) =>
        `| ${c.tab} | ${c.title} | ${(c.tags || []).join(", ")} | ${c.status} | \`${c.screenshot || ""}\` |`
    ),
    ``,
    `## Report specs`,
    ``,
    ...ok.flatMap((c) => [
      `### ${c.title}`,
      `- Tab: **${c.tab}**`,
      `- Tags: ${(c.tags || []).join(", ") || "—"}`,
      `- Description: ${c.description || "—"}`,
      `- URL: ${c.url || "—"}`,
      c.headings?.length ? `- Headings: ${c.headings.join(" · ")}` : null,
      c.filters?.length ? `- Filters: ${c.filters.join(" · ")}` : null,
      `- Screenshot: \`${c.screenshot}\``,
      `- Extract: \`${c.detailFile}\``,
      ``,
      `Parity checklist:`,
      `- [ ] Same name under Reports → ${c.tab}`,
      `- [ ] Same filters / date / property controls`,
      `- [ ] Same metrics, tabs, exports`,
      `- [ ] Same table columns`,
      ``,
    ]).filter((x) => x !== null),
  ].join("\n");
}

async function main() {
  const runId = stamp();
  const outRoot = path.join(process.cwd(), "output", `reports-${runId}`);
  const outDirs = {
    screenshots: path.join(outRoot, "screenshots"),
    details: path.join(outRoot, "details"),
  };
  await ensureDir(outDirs.screenshots);
  await ensureDir(outDirs.details);
  await ensureDir(PROFILE_DIR);

  console.log(`Output → ${outRoot}`);
  console.log(`Mode: REPORTS ONLY — wait ALL tiles up to ${Math.round(REPORT_LOAD_MS / 1000)}s + full iframe shot`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1600, height: 1000 },
    locale: "en-GB",
    slowMo: 40,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(45000);
  const catalog = [];

  try {
    await waitLoggedIn(page);

    await softGoto(page, REPORTS_MAIN);
    await dismissNoise(page);
    console.log("→ Reports:", page.url());
    await page.screenshot({
      path: path.join(outDirs.screenshots, "00-reports-landing.png"),
      fullPage: true,
    });

    await captureTab(page, "Main", REPORTS_MAIN, outDirs, catalog);
    await captureTab(page, "RMS", REPORTS_RMS, outDirs, catalog);

    const meta = { orgId: ORG_ID, capturedAt: new Date().toISOString(), runId, focus: "reports-only" };
    await writeJson(path.join(outRoot, "INDEX.json"), { meta, catalog });
    await fs.writeFile(path.join(outRoot, "REPORTS.md"), buildPack(meta, catalog), "utf8");

    console.log(`\n✓ Done — ${catalog.filter((c) => c.status === "ok").length}/${catalog.length} reports`);
    console.log(`  ${path.join(outRoot, "REPORTS.md")}`);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("\n✗ Failed:", err.message);
  process.exit(1);
});
