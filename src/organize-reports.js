import fs from "fs/promises";
import path from "path";

/**
 * Copy latest reports capture into a clean client-facing folder:
 *   output/CLIENT-REPORTS-PACK/
 */

const OUT_ROOT = path.join(process.cwd(), "output");
const DEST = path.join(OUT_ROOT, "CLIENT-REPORTS-PACK");

const TITLE_ORDER = [
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

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function latestReportsDir() {
  const entries = await fs.readdir(OUT_ROOT, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("reports-"))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const name of dirs) {
    const p = path.join(OUT_ROOT, name);
    if (await exists(path.join(p, "INDEX.json"))) return p;
  }
  return dirs[0] ? path.join(OUT_ROOT, dirs[0]) : null;
}

function folderName(title, idx) {
  const n = String(idx).padStart(2, "0");
  const slug = title
    .replace(/\(FPM\)/g, "FPM")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${n}-${slug}`;
}

async function copyFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function main() {
  const srcRoot = process.argv[2] ? path.resolve(process.argv[2]) : await latestReportsDir();
  if (!srcRoot || !(await exists(srcRoot))) {
    throw new Error("No reports-* output folder found");
  }

  const indexPath = path.join(srcRoot, "INDEX.json");
  if (!(await exists(indexPath))) throw new Error(`Missing INDEX.json in ${srcRoot}`);

  const { meta, catalog } = JSON.parse(await fs.readFile(indexPath, "utf8"));
  const shotsDir = path.join(srcRoot, "screenshots");
  const detailsDir = path.join(srcRoot, "details");

  await fs.rm(DEST, { recursive: true, force: true });
  await fs.mkdir(DEST, { recursive: true });

  const mainReports = catalog.filter(
    (c) => c.tab === "Main" && TITLE_ORDER.some((t) => t.toLowerCase() === c.title.toLowerCase())
  );
  const rmsReports = catalog.filter((c) => c.tab === "RMS" && c.status === "ok");

  mainReports.sort((a, b) => {
    const ia = TITLE_ORDER.findIndex((t) => t.toLowerCase() === a.title.toLowerCase());
    const ib = TITLE_ORDER.findIndex((t) => t.toLowerCase() === b.title.toLowerCase());
    return ia - ib;
  });

  const allShotFiles = (await exists(shotsDir)) ? await fs.readdir(shotsDir) : [];
  const allDetailFiles = (await exists(detailsDir)) ? await fs.readdir(detailsDir) : [];

  const lines = [
    `# Flipdish Reports — Client Pack`,
    ``,
    `Organized screenshots + details for parity with Flipdish reporting.`,
    ``,
    `**Source run:** \`${path.basename(srcRoot)}\``,
    `**Captured:** ${meta?.capturedAt || "—"}`,
    `**Org:** \`${meta?.orgId || "fd25536"}\``,
    ``,
    `## Contents`,
    ``,
  ];

  // Index screenshots first
  const indexShots = allShotFiles.filter((f) => f.startsWith("00-"));
  if (indexShots.length) {
    const idxDir = path.join(DEST, "00-Reports-Index");
    await fs.mkdir(path.join(idxDir, "screenshots"), { recursive: true });
    for (const f of indexShots) {
      await copyFile(path.join(shotsDir, f), path.join(idxDir, "screenshots", f));
    }
    const idxDetails = allDetailFiles.filter((f) => f.startsWith("00-"));
    if (idxDetails.length) {
      await fs.mkdir(path.join(idxDir, "details"), { recursive: true });
      for (const f of idxDetails) {
        await copyFile(path.join(detailsDir, f), path.join(idxDir, "details", f));
      }
    }
    lines.push(`### 00. Reports Index`, `- Folder: \`00-Reports-Index/\``, ``);
  }

  let idx = 0;
  for (const report of [...mainReports, ...rmsReports]) {
    idx += 1;
    const prefix = report.id;
    const folder = folderName(report.title, idx);
    const reportDir = path.join(DEST, folder);
    const ssDir = path.join(reportDir, "screenshots");
    const detDir = path.join(reportDir, "details");
    await fs.mkdir(ssDir, { recursive: true });
    await fs.mkdir(detDir, { recursive: true });

    const shotMatches = allShotFiles
      .filter((f) => f === `${prefix}.png` || f.startsWith(`${prefix}-`))
      // Prefer full captures first in listing
      .sort((a, b) => {
        const rank = (f) => {
          if (f.endsWith("-stitched.png")) return 0;
          if (f.endsWith("-with-chrome.png")) return 1;
          if (f === `${prefix}.png`) return 2;
          if (f.includes("-tab-") && !f.includes("viewport")) return 3;
          if (f.includes("viewport")) return 9;
          return 5;
        };
        return rank(a) - rank(b);
      });
    for (const f of shotMatches) {
      await copyFile(path.join(shotsDir, f), path.join(ssDir, f));
    }

    const detailMatches = allDetailFiles.filter((f) => f.startsWith(prefix));
    for (const f of detailMatches) {
      await copyFile(path.join(detailsDir, f), path.join(detDir, f));
    }

    const summary = [
      `# ${report.title}`,
      ``,
      `- **Tab:** ${report.tab}`,
      `- **Status:** ${report.status}`,
      `- **Tags:** ${(report.tags || []).join(", ") || "—"}`,
      `- **Description:** ${report.description || "—"}`,
      `- **Live URL:** ${report.url || "—"}`,
      ``,
      `## Screenshots`,
      ...shotMatches.map((f) => `- \`screenshots/${f}\``),
      ``,
      `## Details`,
      ...detailMatches.map((f) => `- \`details/${f}\``),
      ``,
      `## Parity checklist`,
      `- [ ] Same report name under Reports → ${report.tab}`,
      `- [ ] Same filters / date range / property selectors`,
      `- [ ] Same metrics / charts / tabs`,
      `- [ ] Same table columns / exports`,
      ``,
    ].join("\n");
    await fs.writeFile(path.join(reportDir, "README.md"), summary, "utf8");

    lines.push(`### ${idx}. ${report.title}`);
    lines.push(`- Folder: \`${folder}/\``);
    lines.push(`- Status: **${report.status}**`);
    lines.push(`- Screenshots: ${shotMatches.length}`);
    lines.push(`- URL: ${report.url || "—"}`);
    lines.push("");
  }

  if (await exists(path.join(srcRoot, "REPORTS.md"))) {
    await copyFile(path.join(srcRoot, "REPORTS.md"), path.join(DEST, "FULL-REPORTS.md"));
  }
  await copyFile(indexPath, path.join(DEST, "INDEX.json"));
  await fs.writeFile(path.join(DEST, "INDEX.md"), lines.join("\n"), "utf8");

  console.log(`✓ Client pack → ${DEST}`);
  console.log(`  Reports organized: ${idx}`);
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
