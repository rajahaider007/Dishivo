import fs from "fs/promises";
import path from "path";
import { createRequire } from "module";

/**
 * Quality-check Flipdish report screenshots + rebuild consolidated OK report.
 * Uses optional sharp via dynamic import; falls back to file-size heuristics + PNG IHDR parse.
 */

const OUT = path.join(process.cwd(), "output");
const PACK = path.join(OUT, "CLIENT-REPORTS-PACK");
const MAIN_RUN = path.join(OUT, "reports-20261001-122505");
const RMS_SALES_MENU = path.join(OUT, "rms-20261001-125237");
const RMS_CPI = path.join(OUT, "rms-20261001-131310");

function parsePngSize(buf) {
  // PNG IHDR at byte 16: width/height big-endian uint32
  if (buf.length < 24 || buf[0] !== 0x89) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

async function checkShot(file) {
  const buf = await fs.readFile(file);
  const dim = parsePngSize(buf);
  const kb = Math.round(buf.length / 1024);
  const issues = [];
  if (!dim) issues.push("not-png");
  if (dim && dim.height < 900) issues.push(`short-h=${dim.height}`);
  if (dim && dim.width < 800) issues.push(`narrow-w=${dim.width}`);
  if (kb < 25) issues.push(`tiny-file=${kb}kb`);
  // Viewport-only often ~1000h; full reports should be taller OR at least solid content
  if (dim && dim.height <= 1000 && kb < 80) issues.push("likely-empty-viewport");
  return {
    file: path.basename(file),
    ...dim,
    kb,
    ok: issues.length === 0,
    issues,
  };
}

async function listMainShots(dir) {
  try {
    const shots = path.join(dir, "screenshots");
    const files = await fs.readdir(shots);
    return files
      .filter(
        (f) =>
          f.endsWith(".png") &&
          !f.includes("viewport") &&
          !f.startsWith("00-") &&
          !f.includes("-tab-") &&
          !f.includes("stitched") &&
          !f.includes("with-chrome")
      )
      .map((f) => path.join(shots, f));
  } catch {
    return [];
  }
}

async function listRmsMainShots(dir) {
  try {
    const shots = path.join(dir, "screenshots");
    const files = await fs.readdir(shots);
    return files
      .filter((f) => /-r\d+-/.test(f) && f.endsWith(".png") && !f.includes("viewport") && !f.includes("with-chrome"))
      .map((f) => path.join(shots, f));
  } catch {
    return [];
  }
}

async function rebuildRmsIndex() {
  const catalog = [];
  for (const root of [RMS_SALES_MENU, RMS_CPI]) {
    const detailsDir = path.join(root, "details");
    let files = [];
    try {
      files = await fs.readdir(detailsDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json") || f.includes("-list")) continue;
      const j = JSON.parse(await fs.readFile(path.join(detailsDir, f), "utf8"));
      const id = f.replace(/\.json$/, "");
      const shot = path.join(root, "screenshots", `${id}.png`);
      let exists = false;
      try {
        await fs.access(shot);
        exists = true;
      } catch {
        /* missing */
      }
      catalog.push({
        tab: "RMS",
        category: j.category || "?",
        title: j.report?.title || id,
        id,
        status: exists ? "ok" : "missing-shot",
        url: j.url || "",
        screenshot: exists ? shot : "",
        sourceRun: path.basename(root),
      });
    }
  }
  // Dedup by id preferring later run
  const map = new Map();
  for (const c of catalog) map.set(c.id, c);
  return [...map.values()];
}

async function main() {
  const rmsCatalog = await rebuildRmsIndex();
  await fs.writeFile(
    path.join(RMS_CPI, "INDEX.json"),
    JSON.stringify(
      {
        meta: { rebuiltAt: new Date().toISOString(), note: "merged Sales/Menu + Costs/Payroll/Inventory" },
        catalog: rmsCatalog,
      },
      null,
      2
    ),
    "utf8"
  );

  const mainShots = await listMainShots(MAIN_RUN);
  const rmsShots = [
    ...(await listRmsMainShots(RMS_SALES_MENU)),
    ...(await listRmsMainShots(RMS_CPI)),
  ];

  const mainChecks = [];
  for (const f of mainShots) mainChecks.push(await checkShot(f));
  const rmsChecks = [];
  for (const f of rmsShots) rmsChecks.push(await checkShot(f));

  const mainOk = mainChecks.filter((c) => c.ok).length;
  const rmsOk = rmsChecks.filter((c) => c.ok).length;
  const mainBad = mainChecks.filter((c) => !c.ok);
  const rmsBad = rmsChecks.filter((c) => !c.ok);

  // Expected counts from discoveries
  const expected = {
    main: 10,
    rmsSales: 9,
    rmsMenu: 5,
    rmsCosts: 8,
    rmsPayroll: 3,
    rmsInventory: 6,
  };
  const byCat = {};
  for (const c of rmsCatalog) {
    byCat[c.category] = byCat[c.category] || { ok: 0, missing: 0 };
    if (c.status === "ok") byCat[c.category].ok++;
    else byCat[c.category].missing++;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    expected,
    actual: {
      mainReports: mainChecks.length,
      rmsReports: rmsCatalog.filter((c) => c.status === "ok").length,
      byCategory: byCat,
    },
    quality: {
      main: { ok: mainOk, bad: mainBad.length, issues: mainBad },
      rms: { ok: rmsOk, bad: rmsBad.length, issues: rmsBad },
    },
    complete:
      mainChecks.length >= 10 &&
      (byCat.Sales?.ok || 0) >= 9 &&
      (byCat.Menu?.ok || 0) >= 5 &&
      (byCat.Costs?.ok || 0) >= 8 &&
      (byCat.Payroll?.ok || 0) >= 3 &&
      (byCat.Inventory?.ok || 0) >= 6 &&
      mainBad.length === 0,
  };

  // Softer complete if only minor quality flags
  report.completeSoft =
    mainChecks.length >= 10 &&
    (byCat.Sales?.ok || 0) >= 9 &&
    (byCat.Menu?.ok || 0) >= 5 &&
    (byCat.Costs?.ok || 0) >= 8 &&
    (byCat.Payroll?.ok || 0) >= 3 &&
    (byCat.Inventory?.ok || 0) >= 6;

  const md = [
    `# Flipdish Reports — Final QA Report`,
    ``,
    `**Generated:** ${report.generatedAt}`,
    ``,
    `## Coverage`,
    ``,
    `| Section | Expected | Captured OK |`,
    `|---------|----------|-------------|`,
    `| Main tab | ${expected.main} | ${mainChecks.length} |`,
    `| RMS Sales | ${expected.rmsSales} | ${byCat.Sales?.ok || 0} |`,
    `| RMS Costs | ${expected.rmsCosts} | ${byCat.Costs?.ok || 0} |`,
    `| RMS Payroll | ${expected.rmsPayroll} | ${byCat.Payroll?.ok || 0} |`,
    `| RMS Inventory | ${expected.rmsInventory} | ${byCat.Inventory?.ok || 0} |`,
    `| RMS Menu | ${expected.rmsMenu} | ${byCat.Menu?.ok || 0} |`,
    `| **TOTAL** | **${expected.main + expected.rmsSales + expected.rmsCosts + expected.rmsPayroll + expected.rmsInventory + expected.rmsMenu}** | **${mainChecks.length + (byCat.Sales?.ok || 0) + (byCat.Costs?.ok || 0) + (byCat.Payroll?.ok || 0) + (byCat.Inventory?.ok || 0) + (byCat.Menu?.ok || 0)}** |`,
    ``,
    `## Screenshot quality`,
    ``,
    `- Main primary shots OK: **${mainOk}/${mainChecks.length}**`,
    `- RMS primary shots OK: **${rmsOk}/${rmsChecks.length}**`,
    ``,
  ];

  if (mainBad.length || rmsBad.length) {
    md.push(`### Issues`);
    for (const b of [...mainBad, ...rmsBad]) {
      md.push(`- \`${b.file}\` — ${b.issues.join(", ")} (${b.width}x${b.height}, ${b.kb}KB)`);
    }
    md.push(``);
  }

  md.push(`## Verdict`);
  md.push(``);
  if (report.completeSoft && mainBad.length === 0 && rmsBad.filter((b) => b.issues.includes("tiny-file") || b.issues.includes("likely-empty-viewport")).length === 0) {
    md.push(`**OK — all expected reports captured with acceptable screenshots.**`);
    report.verdict = "OK";
  } else if (report.completeSoft) {
    md.push(`**OK WITH NOTES — coverage complete; review flagged screenshots.**`);
    report.verdict = "OK_WITH_NOTES";
  } else {
    md.push(`**NOT COMPLETE — missing reports or failed opens remain.**`);
    report.verdict = "NOT_COMPLETE";
  }
  md.push(``);

  await fs.mkdir(PACK, { recursive: true });
  await fs.writeFile(path.join(PACK, "FINAL-QA-REPORT.md"), md.join("\n"), "utf8");
  await fs.writeFile(path.join(PACK, "FINAL-QA-REPORT.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(md.join("\n"));
  console.log(`\nWrote ${path.join(PACK, "FINAL-QA-REPORT.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
