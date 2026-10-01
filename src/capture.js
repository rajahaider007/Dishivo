import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

const ORG_ID = process.env.ORG_ID || "fd25536";
const BASE = `https://portal.flipdish.com/${ORG_ID}`;
const EMAIL = process.env.FLIPDISH_EMAIL;
const PASSWORD = process.env.FLIPDISH_PASSWORD;
const HEADLESS = String(process.env.HEADLESS ?? "false").toLowerCase() === "true";
const AUTH_DIR = path.join(process.cwd(), ".auth");
const PROFILE_DIR = path.join(AUTH_DIR, "browser-profile");
const CAPTCHA_READY = path.join(AUTH_DIR, "captcha-ready.txt");
const SETUP_DONE = path.join(AUTH_DIR, "setup-done.txt");
// 0 or negative = wait forever (never auto-close for timeout)
const LOGIN_WAIT_MS = Number(process.env.LOGIN_WAIT_MS ?? "0");

const SECTIONS = [
  { id: "01-home", title: "Home / Dashboard", path: "/home", purpose: "Overview, KPIs, quick actions" },
  { id: "02-orders", title: "Orders", path: "/orders", purpose: "Live & historical order management" },
  { id: "03-menu", title: "Menu", path: "/menu", purpose: "Menu structure, items, categories, modifiers" },
  { id: "04-menus-list", title: "Menus list", path: "/menu/menus", purpose: "Multiple menus / channels" },
  { id: "05-analytics", title: "Analytics", path: "/analytics", purpose: "Sales & performance analytics" },
  { id: "06-customers", title: "Customers", path: "/customers", purpose: "Customer list & CRM data" },
  { id: "07-vouchers", title: "Vouchers / Promotions", path: "/vouchers", purpose: "Discounts, voucher codes" },
  { id: "08-loyalty", title: "Loyalty", path: "/loyalty", purpose: "Loyalty program settings" },
  { id: "09-campaigns", title: "Campaigns", path: "/campaigns", purpose: "Marketing campaigns" },
  { id: "10-apps", title: "Apps / Integrations", path: "/apps", purpose: "Connected apps & integrations" },
  { id: "11-banking", title: "Banking / Payouts", path: "/banking", purpose: "Payments & payouts" },
  { id: "12-reports", title: "Reports", path: "/reports", purpose: "Downloadable / scheduled reports" },
  { id: "13-settings", title: "Settings", path: "/settings", purpose: "Store, delivery, hours, branding" },
  { id: "14-settings-store", title: "Store settings", path: "/settings/store", purpose: "Store profile & contact" },
  { id: "15-settings-opening-hours", title: "Opening hours", path: "/settings/opening-hours", purpose: "Business hours" },
  { id: "16-settings-delivery", title: "Delivery settings", path: "/settings/delivery", purpose: "Delivery zones & fees" },
  { id: "17-settings-payments", title: "Payment settings", path: "/settings/payments", purpose: "Payment methods" },
  { id: "18-team", title: "Team / Users", path: "/settings/team", purpose: "Staff access & roles" },
];

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}
async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}
async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function isAuthUrl(url = "") {
  return /auth\.portal\.flipdish\.com|\/u\/login/i.test(url);
}

async function softGoto(page, url, timeout = 45000) {
  try {
    await page.goto(url, { waitUntil: "commit", timeout });
  } catch (e) {
    console.warn(`  warn goto: ${e.message.split("\n")[0]}`);
  }
  await sleep(2000);
}

async function pageText(page) {
  return page.locator("body").innerText().catch(() => "");
}

async function isOnLoginScreen(page) {
  if (isAuthUrl(page.url())) return true;
  const text = await pageText(page);
  return /Log in to Flipdish|Continue with Google|Email address/i.test(text);
}

async function isReallyLoggedIn(page) {
  const url = page.url();
  if (isAuthUrl(url)) return false;
  if (!/portal\.flipdish\.com\/fd\d+/i.test(url)) return false;
  if (await isOnLoginScreen(page)) return false;

  const text = await pageText(page);
  if (!text || text.length < 40) return false;
  if (/Log in to Flipdish|I am human|Continue with Google/i.test(text)) return false;

  return (
    /Orders|Menus?|Analytics|Customers|Settings|Loyalty|Vouchers|Banking|Campaigns|Apps/i.test(text) ||
    (await page.locator("nav, aside, [class*='sidebar'], [class*='SideNav']").count()) > 0
  );
}

async function fillEmail(page) {
  const el = page
    .locator('input[name="username"], input[type="email"], input#username, input[inputmode="email"]')
    .first();
  if ((await el.count()) === 0) return false;
  try {
    await el.waitFor({ state: "visible", timeout: 8000 });
    await el.click();
    await el.fill(EMAIL);
    console.log("→ Email filled");
    return true;
  } catch {
    return false;
  }
}

async function fillPasswordIfPresent(page) {
  const pass = page.locator('input[type="password"]').first();
  if ((await pass.count()) === 0) return false;
  if (!(await pass.isVisible().catch(() => false))) return false;
  await pass.fill(PASSWORD);
  console.log("→ Password filled");
  await page
    .locator('button[type="submit"], button:has-text("Continue"), button:has-text("Log in")')
    .first()
    .click()
    .catch(() => {});
  return true;
}

async function waitForeverUntil(predicate, label) {
  const started = Date.now();
  let lastPing = 0;
  while (true) {
    if (LOGIN_WAIT_MS > 0 && Date.now() - started > LOGIN_WAIT_MS) {
      throw new Error(`Timeout waiting for: ${label}`);
    }
    if (await predicate()) return;

    if (Date.now() - lastPing > 60000) {
      lastPing = Date.now();
      const mins = Math.round((Date.now() - started) / 60000);
      console.log(`… still waiting (${label}) — ${mins} min, browser OPEN rahega`);
    }
    await sleep(2000);
  }
}

/**
 * Keep Chrome open. No auto-close.
 * 1) Login (captcha manual)
 * 2) User does manual setups
 * 3) User signals setup-done → then capture
 */
async function waitForUserReady(page) {
  console.log("→ Opening portal (session profile keep hogi)…");
  await softGoto(page, `${BASE}/home`, 90000);

  for (let i = 0; i < 20; i++) {
    if (await isOnLoginScreen(page)) break;
    if (await isReallyLoggedIn(page)) break;
    await sleep(1000);
  }

  if (!(await isReallyLoggedIn(page))) {
    if (!(await isOnLoginScreen(page))) await softGoto(page, `${BASE}/orders`, 60000);
    await fillEmail(page);

    console.log("");
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║  LOGIN: captcha solve + Continue                         ║");
    console.log("║  Chat: captcha done  (optional signal)                   ║");
    console.log("╚══════════════════════════════════════════════════════════╝");

    let passwordDone = false;
    let captchaSignal = false;

    await waitForeverUntil(async () => {
      if (await isReallyLoggedIn(page)) return true;

      if (!captchaSignal && (await fileExists(CAPTCHA_READY))) {
        captchaSignal = true;
        console.log("→ captcha-ready signal");
        await fillEmail(page);
        await page.locator('button[type="submit"], button:has-text("Continue")').first().click().catch(() => {});
      }
      if (!passwordDone) passwordDone = await fillPasswordIfPresent(page);
      return false;
    }, "login");
  }

  console.log("→ Logged in:", page.url());
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  BROWSER OPEN RAHEGA — koi timeout nahi                  ║");
  console.log("║  Jo manual setups karne hain, ab karo                    ║");
  console.log("║  Jab ready ho: chat me likho → setup done                ║");
  console.log("║  Tab screenshots/details capture start hogi              ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`Waiting for: ${SETUP_DONE}`);

  if (await fileExists(SETUP_DONE)) await fs.unlink(SETUP_DONE).catch(() => {});

  await waitForeverUntil(async () => fileExists(SETUP_DONE), "manual setup done");
  console.log("→ setup-done signal — capture start");
}

async function dismissNoise(page) {
  for (const sel of [
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    'button[aria-label="Close"]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible())) await el.click({ timeout: 800 }).catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

async function extractPageDetails(page) {
  return page.evaluate(() => {
    const textClean = (t) => (t || "").replace(/\s+/g, " ").trim();
    return {
      title: document.title,
      url: location.href,
      headings: [...document.querySelectorAll("h1,h2,h3")]
        .map((el) => textClean(el.innerText))
        .filter(Boolean)
        .slice(0, 40),
      buttons: [...document.querySelectorAll("button, a[role='button']")]
        .map((el) => textClean(el.innerText || el.getAttribute("aria-label")))
        .filter((t) => t && t.length < 80)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 60),
      labels: [...document.querySelectorAll("label, th")]
        .map((el) => textClean(el.innerText))
        .filter((t) => t && t.length < 100)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 80),
      nav: [...document.querySelectorAll("nav a, [role='navigation'] a, aside a")]
        .map((a) => ({
          text: textClean(a.innerText || a.getAttribute("aria-label")),
          href: a.href || a.getAttribute("href") || "",
        }))
        .filter((x) => x.text)
        .filter((v, i, a) => a.findIndex((y) => y.text === v.text && y.href === v.href) === i)
        .slice(0, 80),
      tables: [...document.querySelectorAll("table")].slice(0, 5).map((table, idx) => ({
        index: idx,
        headers: [...table.querySelectorAll("th")].map((th) => textClean(th.innerText)),
        rows: [...table.querySelectorAll("tr")]
          .slice(0, 15)
          .map((tr) => [...tr.querySelectorAll("td")].map((td) => textClean(td.innerText)))
          .filter((r) => r.length),
      })),
      bodyText: textClean(document.body?.innerText || "").slice(0, 12000),
    };
  });
}

async function discoverExtraNav(page) {
  try {
    return await page.evaluate((orgId) => {
      return [...document.querySelectorAll("a[href]")]
        .map((a) => a.getAttribute("href"))
        .filter(Boolean)
        .map((href) => {
          try {
            return new URL(href, location.origin).pathname;
          } catch {
            return null;
          }
        })
        .filter((p) => p && p.includes(`/${orgId}/`))
        .map((p) => p.replace(new RegExp(`^/${orgId}`), "") || "/home")
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 40);
    }, ORG_ID);
  } catch {
    return [];
  }
}

async function captureSection(page, section, outDirs, results) {
  const url = `${BASE}${section.path}`;
  console.log(`→ [${section.id}] ${section.title}`);
  let status = "ok";
  let error = null;
  let details = null;

  try {
    await softGoto(page, url);
    await dismissNoise(page);
    await sleep(1200);

    if (await isOnLoginScreen(page) || isAuthUrl(page.url())) {
      status = "auth-redirect";
      error = "Not authenticated";
    }

    details = await extractPageDetails(page);
    await page.screenshot({
      path: path.join(outDirs.screenshots, `${section.id}.png`),
      fullPage: true,
    });
    await writeJson(path.join(outDirs.details, `${section.id}.json`), {
      section,
      capturedAt: new Date().toISOString(),
      status,
      details,
    });
    await fs.writeFile(
      path.join(outDirs.details, `${section.id}.txt`),
      [
        `# ${section.title}`,
        `URL: ${details?.url || url}`,
        `Purpose: ${section.purpose}`,
        `Status: ${status}`,
        "",
        "## Headings",
        ...(details?.headings || []).map((h) => `- ${h}`),
        "",
        "## Actions / Buttons",
        ...(details?.buttons || []).map((b) => `- ${b}`),
        "",
        "## Labels / Fields",
        ...(details?.labels || []).map((l) => `- ${l}`),
        "",
        "## Visible text (excerpt)",
        details?.bodyText || "",
      ].join("\n"),
      "utf8"
    );
  } catch (e) {
    status = "error";
    error = e.message;
    console.error(`  ✗ ${error}`);
  }

  results.push({
    ...section,
    status,
    error,
    url: details?.url || url,
    screenshot: `screenshots/${section.id}.png`,
    detailFile: `details/${section.id}.json`,
    headings: details?.headings?.slice(0, 10) || [],
  });
}

function buildReport(meta, results, discovered) {
  const ok = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status !== "ok");
  return [
    `# Flipdish Portal Capture — Client Requirements Pack`,
    ``,
    `**Org:** \`${ORG_ID}\` · **Captured:** ${meta.capturedAt} · **OK:** ${ok.length}/${results.length}`,
    ``,
    `| # | Section | Status | Screenshot |`,
    `|---|---------|--------|------------|`,
    ...results.map((r) => `| ${r.id} | ${r.title} | ${r.status} | \`${r.screenshot}\` |`),
    ``,
    `## Feature map`,
    ``,
    ...ok.flatMap((r) => [
      `### ${r.title}`,
      `- URL: ${r.url}`,
      `- Purpose: ${r.purpose}`,
      r.headings?.length ? `- Headings: ${r.headings.join(" · ")}` : null,
      `- Details: \`${r.detailFile}\``,
      ``,
    ]).filter((x) => x !== null),
    failed.length ? `## Failed` : null,
    ...failed.map((r) => `- ${r.title}: ${r.status}${r.error ? ` (${r.error})` : ""}`),
    ``,
    `## Discovered`,
    ...(discovered.length ? discovered.map((p) => `- \`${p}\``) : ["_None_"]),
    ``,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

async function main() {
  if (!EMAIL || !PASSWORD) throw new Error("Set FLIPDISH_EMAIL and FLIPDISH_PASSWORD in .env");

  const runId = stamp();
  const outRoot = path.join(process.cwd(), "output", runId);
  const outDirs = {
    screenshots: path.join(outRoot, "screenshots"),
    details: path.join(outRoot, "details"),
  };
  await ensureDir(outDirs.screenshots);
  await ensureDir(outDirs.details);
  await ensureDir(PROFILE_DIR);

  // clear stale signals
  for (const f of [CAPTCHA_READY, SETUP_DONE]) {
    if (await fileExists(f)) await fs.unlink(f).catch(() => {});
  }

  console.log(`Output → ${outRoot}`);
  console.log(`Login wait: ${LOGIN_WAIT_MS > 0 ? LOGIN_WAIT_MS + "ms" : "FOREVER (no auto-close)"}`);
  console.log(`Profile: ${PROFILE_DIR}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1440, height: 900 },
    locale: "en-GB",
    slowMo: 40,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  // Keep process alive on accidental unhandled — don't kill browser early
  let closing = false;
  const shutdown = async (why) => {
    if (closing) return;
    closing = true;
    console.log(`→ Closing browser (${why}) — profile disk pe save hai`);
    await context.close().catch(() => {});
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(30000);

  const results = [];
  let discovered = [];

  try {
    await waitForUserReady(page);
    await dismissNoise(page);
    await softGoto(page, `${BASE}/home`);
    discovered = await discoverExtraNav(page);

    const known = new Set(SECTIONS.map((s) => s.path));
    const extras = discovered
      .filter((p) => !known.has(p) && p !== "/" && !/logout/i.test(p))
      .slice(0, 12)
      .map((p, i) => ({
        id: `99-extra-${String(i + 1).padStart(2, "0")}`,
        title: `Discovered: ${p}`,
        path: p,
        purpose: "Auto-discovered navigation path",
      }));

    for (const section of [...SECTIONS, ...extras]) {
      await captureSection(page, section, outDirs, results);
      if (results.at(-1)?.status === "auth-redirect") {
        console.error("✗ Session lost — browser OPEN chor raha hoon, re-login karo phir 'setup done'");
        // re-wait instead of dying
        if (await fileExists(SETUP_DONE)) await fs.unlink(SETUP_DONE).catch(() => {});
        await waitForUserReady(page);
      }
    }

    const meta = { orgId: ORG_ID, base: BASE, capturedAt: new Date().toISOString(), runId, email: EMAIL };
    await writeJson(path.join(outRoot, "INDEX.json"), { meta, results, discovered });
    await fs.writeFile(path.join(outRoot, "REPORT.md"), buildReport(meta, results, discovered), "utf8");
    console.log(`\n✓ Done — ${results.filter((r) => r.status === "ok").length}/${results.length} ok`);
    console.log(`  Report: ${path.join(outRoot, "REPORT.md")}`);
  } finally {
    await shutdown("capture finished");
  }
}

main().catch(async (err) => {
  console.error("\n✗ Capture failed:", err.message);
  console.error("Browser profile .auth/browser-profile me save hai — dubara chalane pe login reh sakti hai.");
  process.exit(1);
});
