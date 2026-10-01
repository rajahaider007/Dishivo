import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";
import { deepScrollLooker, waitForLookerData } from "./looker-wait.js";

/**
 * Capture Flipdish Reports → RMS tab categories + nested dashboards.
 */

const ORG_ID = process.env.ORG_ID || "fd25536";
const BASE = `https://portal.flipdish.com/${ORG_ID}`;
const RMS_URL = `${BASE}/reports/dashboards?tab=rms`;
const HEADLESS = String(process.env.HEADLESS ?? "false").toLowerCase() === "true";
const PROFILE_DIR = path.join(process.cwd(), ".auth", "browser-profile");
const REPORT_LOAD_MS = Number(process.env.REPORT_LOAD_MS || 180000);

const RMS_CATEGORIES = [
  { name: "Sales", path: "/reports/rms/sales" },
  { name: "Costs", path: "/reports/rms/costs" },
  { name: "Payroll", path: "/reports/rms/payroll" },
  { name: "Inventory", path: "/reports/rms/inventory" },
  { name: "Menu", path: "/reports/rms/menu" },
];

/** Set ONLY_CATEGORIES=Costs,Payroll,Inventory to skip already-captured ones */
const ONLY_CATEGORIES = String(process.env.ONLY_CATEGORIES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slug(s) {
  return String(s || "x")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}
async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function isAuthUrl(url = "") {
  return /auth\.portal\.flipdish\.com|\/u\/login/i.test(url);
}

async function softGoto(page, url, timeout = 60000) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  } catch {
    try {
      await page.goto(url, { waitUntil: "commit", timeout });
    } catch (e) {
      console.warn(`  warn goto: ${e.message.split("\n")[0]}`);
    }
  }
  await sleep(2000);
}

async function dismissNoise(page) {
  for (const sel of [
    'button:has-text("Accept all")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    'button:has-text("Not now")',
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
  return /Reports|Sales|Menu Editor|Properties/i.test(text);
}

async function waitLoggedIn(page) {
  await softGoto(page, `${BASE}/home`);
  await dismissNoise(page);
  if (await isLoggedIn(page)) {
    console.log("→ Session OK");
    return;
  }
  console.log("╔══════════════════════════════════════╗");
  console.log("║  Login required — captcha solve karo ║");
  console.log("╚══════════════════════════════════════╝");
  while (!(await isLoggedIn(page))) await sleep(3000);
  console.log("→ Login OK");
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

async function expandLookerIframe(page) {
  const iframe = page.locator('iframe[src*="looker.portal.flipdish.com"]').first();
  if ((await iframe.count()) === 0) return { expanded: false, height: 0 };
  const frame = await getLookerFrame(page, 10000);
  if (!frame) return { expanded: false, height: 0 };

  let contentHeight = 2000;
  try {
    contentHeight = await frame.evaluate(async () => {
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      const measure = () =>
        Math.max(
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0
        );
      let last = 0;
      for (let i = 0; i < 20; i++) {
        const h = measure();
        window.scrollTo(0, h);
        await pause(300);
        const next = measure();
        if (next <= last + 2 && i > 2) break;
        last = next;
      }
      window.scrollTo(0, 0);
      return Math.max(measure(), last, 2000);
    });
  } catch {
    contentHeight = 3500;
  }

  const target = Math.min(Math.max(contentHeight + 120, 3000), 16000);
  await iframe.evaluate((el, h) => {
    el.style.height = `${h}px`;
    el.style.minHeight = `${h}px`;
    el.style.maxHeight = "none";
    let p = el.parentElement;
    let g = 0;
    while (p && g++ < 14) {
      p.style.overflow = "visible";
      p.style.height = "auto";
      p.style.maxHeight = "none";
      p.style.minHeight = `${h}px`;
      p = p.parentElement;
    }
  }, target);
  await sleep(800);
  return { expanded: true, height: target };
}

async function captureFullShot(page, outPath) {
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  const { expanded, height } = await expandLookerIframe(page);
  console.log(expanded ? `  expand iframe ${height}px` : "  no looker — fullPage");
  if (expanded) {
    const iframe = page.locator('iframe[src*="looker.portal.flipdish.com"]').first();
    await iframe.screenshot({ path: outPath, timeout: 90000 });
    await page.screenshot({
      path: outPath.replace(/\.png$/i, "-with-chrome.png"),
      fullPage: true,
      timeout: 90000,
    });
  } else {
    await page.screenshot({ path: outPath, fullPage: true, timeout: 90000 });
  }
}

async function waitPageReady(page, label = "page") {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText().catch(() => "");
    const loading = /Getting things ready|It might take a couple of seconds/i.test(text);
    const spinner = await page.locator('[class*="spinner"], [class*="Loader"], [role="progressbar"]').count();
    if (!loading && spinner === 0 && text.length > 80) {
      if (
        /report|dashboard|BI Tools|Sales|Costs|All dashboards|Looker|Net sales|£/i.test(text) ||
        (await getLookerFrame(page, 2000))
      ) {
        console.log(`  ✓ ${label} ready`);
        await sleep(1500);
        return true;
      }
    }
    await sleep(1500);
  }
  console.warn(`  ⚠ ${label} still loading after wait`);
  return false;
}

async function stillOnRmsIndex(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  return (
    /All dashboards/i.test(text) &&
    /Sales BI Tools/i.test(text) &&
    /Costs BI Tools/i.test(text)
  );
}

async function openCategory(page, category) {
  const name = typeof category === "string" ? category : category.name;
  const catPath = typeof category === "string" ? null : category.path;

  // Prefer direct URL — more reliable than clicking BI Tools rows
  if (catPath) {
    await softGoto(page, `${BASE}${catPath}`);
    await dismissNoise(page);
    await waitPageReady(page, `RMS ${name}`);
    if (/\/reports\/rms\//i.test(page.url()) && !(await stillOnRmsIndex(page))) {
      return true;
    }
  }

  // Fallback: click row with "BI Tools"
  const clicked = await page.evaluate((n) => {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const nodes = [...document.querySelectorAll("a, button, div, li")];
    for (const el of nodes) {
      const t = clean(el.innerText);
      if (!t) continue;
      if ((t === n || t.startsWith(n + " ")) && /BI Tools/i.test(t) && t.length < 80) {
        const target = el.closest("a, button, [role='button'], [role='link']") || el;
        target.click();
        return true;
      }
    }
    for (const el of nodes) {
      const t = clean(el.innerText);
      if (t === n) {
        if (el.closest("nav, aside, [class*='Sidebar'], [class*='side-nav']")) continue;
        const target = el.closest("a, button, [role='button'], [role='link']") || el;
        target.scrollIntoView({ block: "center" });
        target.click();
        return true;
      }
    }
    return false;
  }, name);

  if (!clicked) return false;
  await sleep(3000);
  await waitPageReady(page, `RMS ${name}`);
  return !(await stillOnRmsIndex(page));
}

async function discoverReportsOnPage(page) {
  return page.evaluate(() => {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const skipExact = new Set(
      [
        "Home",
        "Sales",
        "Properties",
        "Menu Editor",
        "Reports",
        "Marketing",
        "Sales Channels",
        "Settings",
        "Add-ons",
        "Main",
        "RMS",
        "All dashboards",
        "Costs",
        "Payroll",
        "Inventory",
        "Menu",
        "Back",
        "Download the app!",
      ].map((x) => x.toLowerCase())
    );

    const rows = [];
    const seen = new Set();

    // Prefer real links into dashboards / reports
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href || "";
      const title = clean(a.innerText || a.getAttribute("aria-label") || "");
      if (!title || title.length > 120) continue;
      if (skipExact.has(title.toLowerCase())) continue;
      if (!/reports|dashboard|looker|rms/i.test(href) && !/report/i.test(title)) continue;
      if (/tab=rms$|tab=main$|\/reports\/dashboards\/?$/i.test(href)) continue;
      if (seen.has(title.toLowerCase())) continue;
      const inNav = a.closest("nav, aside");
      if (inNav) continue;
      seen.add(title.toLowerCase());
      rows.push({ title, description: "", href });
    }

    // Card / row pattern like Main tab
    if (!rows.length) {
      const nodes = [...document.querySelectorAll("a, button, [role='link'], [role='button'], li, div")];
      for (const el of nodes) {
        const raw = clean(el.innerText);
        if (!raw || raw.length < 4 || raw.length > 260) continue;
        if (/Getting things ready/i.test(raw)) continue;
        const lines = raw.split("\n").map(clean).filter(Boolean);
        let title = lines[0] || raw;
        if (skipExact.has(title.toLowerCase())) continue;
        if (!/report|summary|overview|analysis|dashboard|mix|labour|labor|waste|stock|recipe|variance|forecast|performance|channel|product|modifier/i.test(title + " " + raw)) {
          continue;
        }
        if (seen.has(title.toLowerCase())) continue;
        if (el.closest("nav, aside")) continue;
        let href = "";
        const a = el.closest("a") || (el.tagName === "A" ? el : null);
        if (a?.href) href = a.href;
        seen.add(title.toLowerCase());
        rows.push({ title, description: lines.slice(1).join(" ").slice(0, 200), href });
      }
    }

    return {
      url: location.href,
      rows: rows.slice(0, 50),
      bodySample: clean(document.body.innerText).slice(0, 5000),
    };
  });
}

async function openReport(page, report) {
  const before = page.url();
  if (report.href && /flipdish\.com/i.test(report.href)) {
    await softGoto(page, report.href);
    await sleep(2000);
    if (page.url() !== before) return true;
  }

  const opened = await page.evaluate((title) => {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const nodes = [...document.querySelectorAll("a, button, div, li, span, h1, h2, h3, h4")];
    for (const n of nodes) {
      const t = clean(n.innerText);
      if (t === title || (t.startsWith(title) && t.length < title.length + 30)) {
        const target = n.closest("a, button, [role='button'], [role='link']") || n;
        target.click();
        return true;
      }
    }
    return false;
  }, report.title);

  await sleep(3000);
  return opened;
}

async function waitReport(page) {
  const frame = await getLookerFrame(page, 45000);
  if (!frame) {
    await sleep(8000);
    return;
  }
  console.log(`  Looker: ${frame.url().slice(0, 70)}…`);
  await waitForLookerData(frame, "RMS report", REPORT_LOAD_MS);
  await deepScrollLooker(frame);
  await sleep(1500);
  try {
    await frame.evaluate(() => window.scrollTo(0, 0));
  } catch {
    /* ignore */
  }
}

async function goRmsIndex(page) {
  await softGoto(page, RMS_URL);
  await dismissNoise(page);
  const tab = page.getByRole("tab", { name: /^RMS$/i });
  if ((await tab.count()) > 0) await tab.first().click().catch(() => {});
  await sleep(1500);
}

async function main() {
  const runId = stamp();
  const outRoot = path.join(process.cwd(), "output", `rms-${runId}`);
  const outDirs = {
    screenshots: path.join(outRoot, "screenshots"),
    details: path.join(outRoot, "details"),
  };
  await ensureDir(outDirs.screenshots);
  await ensureDir(outDirs.details);
  await ensureDir(PROFILE_DIR);

  console.log(`Output → ${outRoot}`);
  console.log("Mode: RMS tab categories + nested reports");

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
    await goRmsIndex(page);
    await page.screenshot({
      path: path.join(outDirs.screenshots, "00-rms-index.png"),
      fullPage: true,
    });

    let categories = RMS_CATEGORIES;
    if (ONLY_CATEGORIES.length) {
      categories = RMS_CATEGORIES.filter((c) =>
        ONLY_CATEGORIES.some((x) => x.toLowerCase() === c.name.toLowerCase())
      );
      console.log(`Only categories: ${categories.map((c) => c.name).join(", ")}`);
    }

    let catIdx = 0;
    for (const category of categories) {
      catIdx += 1;
      const catName = category.name;
      console.log(`\n══ RMS Category: ${catName} ══`);
      await goRmsIndex(page);

      const openedCat = await openCategory(page, category);
      if (!openedCat) {
        console.log(`  ✗ could not open category ${catName}`);
        catalog.push({ tab: "RMS", category: catName, title: catName, status: "category-open-failed" });
        continue;
      }
      console.log(`  opened category → ${page.url()}`);
      await waitPageReady(page, `RMS ${catName}`);

      const catId = `${String(catIdx).padStart(2, "0")}-rms-${slug(catName)}`;
      await page.screenshot({
        path: path.join(outDirs.screenshots, `${catId}-list.png`),
        fullPage: true,
      });

      let discovery = await discoverReportsOnPage(page);
      if (!(discovery.rows || []).length) {
        await sleep(4000);
        await waitPageReady(page, `RMS ${catName} retry`);
        discovery = await discoverReportsOnPage(page);
      }
      await writeJson(path.join(outDirs.details, `${catId}-list.json`), {
        category: catName,
        url: page.url(),
        discovery,
        capturedAt: new Date().toISOString(),
      });

      let reports = discovery.rows || [];
      const hasLooker = !!(await getLookerFrame(page, 8000));
      if (!reports.length && hasLooker) {
        reports = [{ title: `${catName} (RMS dashboard)`, href: page.url(), description: "Direct category dashboard" }];
      }
      if (!reports.length) {
        console.log("  (no nested reports found — saved list shot)");
        catalog.push({
          tab: "RMS",
          category: catName,
          title: `${catName} list`,
          status: "list-only",
          url: page.url(),
          screenshot: `screenshots/${catId}-list.png`,
        });
        continue;
      }

      console.log(`  Found ${reports.length} inner reports`);
      const listUrl = page.url();
      let rIdx = 0;
      for (const report of reports) {
        rIdx += 1;
        const id = `${catId}-r${String(rIdx).padStart(2, "0")}-${slug(report.title)}`;
        console.log(`→ [${id}] ${report.title}`);

        await softGoto(page, listUrl);
        await waitPageReady(page, `${catName} list`);
        await sleep(800);
        const opened = await openReport(page, report);
        if (!opened && !(await getLookerFrame(page, 5000))) {
          // Try absolute path guess from title
          console.log("  ✗ open failed — retry list click");
          catalog.push({ ...report, tab: "RMS", category: catName, id, status: "open-failed" });
          continue;
        }

        console.log(`  url: ${page.url()}`);
        await waitPageReady(page, report.title);
        await waitReport(page);
        await captureFullShot(page, path.join(outDirs.screenshots, `${id}.png`));
        await page.screenshot({
          path: path.join(outDirs.screenshots, `${id}-viewport.png`),
          fullPage: false,
        });

        await writeJson(path.join(outDirs.details, `${id}.json`), {
          tab: "RMS",
          category: catName,
          report,
          url: page.url(),
          capturedAt: new Date().toISOString(),
        });

        catalog.push({
          ...report,
          tab: "RMS",
          category: catName,
          id,
          status: "ok",
          url: page.url(),
          screenshot: `screenshots/${id}.png`,
          detailFile: `details/${id}.json`,
        });
      }
    }

    const meta = { orgId: ORG_ID, capturedAt: new Date().toISOString(), runId, focus: "rms-only" };
    await writeJson(path.join(outRoot, "INDEX.json"), { meta, catalog });

    const ok = catalog.filter((c) => c.status === "ok").length;
    const md = [
      `# Flipdish RMS Reports Pack`,
      ``,
      `**Captured:** ${meta.capturedAt} · **OK:** ${ok}/${catalog.length}`,
      ``,
      `| Category | Report | Status | Screenshot |`,
      `|----------|--------|--------|------------|`,
      ...catalog.map(
        (c) =>
          `| ${c.category || "—"} | ${c.title} | ${c.status} | \`${c.screenshot || ""}\` |`
      ),
      ``,
    ].join("\n");
    await fs.writeFile(path.join(outRoot, "RMS-REPORTS.md"), md, "utf8");

    console.log(`\n✓ RMS done — ${ok}/${catalog.length}`);
    console.log(`  ${path.join(outRoot, "RMS-REPORTS.md")}`);
  } finally {
    await context.close();
  }
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
