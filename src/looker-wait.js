/** Looker dashboard tile load helpers for Flipdish reports capture */

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function deepScrollLooker(frame) {
  try {
    await frame.evaluate(async () => {
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      const total = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 3000);
      for (let y = 0; y <= total; y += 280) {
        window.scrollTo(0, y);
        await pause(900);
      }
      window.scrollTo(0, total);
      await pause(4000);
      window.scrollTo(0, 0);
      await pause(500);
    });
  } catch {
    /* ignore */
  }
}

export async function waitForTileByTitle(frame, title, maxMs = 90000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const status = await frame.evaluate((t) => {
      const clean = (x) => (x || "").replace(/\s+/g, " ").trim();
      const nodes = [...document.querySelectorAll("h1,h2,h3,h4,div,span,p")].filter(
        (n) => clean(n.innerText) === t || clean(n.textContent) === t
      );
      nodes.sort((a, b) => clean(a.innerText).length - clean(b.innerText).length);
      const titleEl = nodes[0];
      if (!titleEl) return { found: false, ready: false };

      titleEl.scrollIntoView({ block: "center", inline: "nearest" });

      let box = titleEl;
      for (let i = 0; i < 10 && box; i++) {
        const r = box.getBoundingClientRect();
        if (r.height > 100 && r.width > 150) break;
        box = box.parentElement;
      }

      const paths = box.querySelectorAll("svg path, svg rect, svg circle, svg line").length;
      const cells = box.querySelectorAll("table td").length;
      const canvas = box.querySelectorAll("canvas").length;
      const text = clean(box.innerText);
      const money = /£|\$|€|\d+\.\d{2}/.test(text);
      const loading = box.querySelectorAll('[class*="loading"], [class*="spinner"], [aria-busy="true"]').length;
      const noResults = /no results|nothing to show|no data/i.test(text);
      const ready = loading === 0 && (paths >= 6 || cells >= 3 || canvas >= 1 || money || noResults);
      return { found: true, ready, paths, cells, loading, noResults };
    }, title);

    if (status.found && status.ready) {
      console.log(`    ✓ tile ready: ${title} (paths=${status.paths} cells=${status.cells})`);
      return true;
    }
    await sleep(2000);
  }
  console.warn(`    ⚠ tile still empty after wait: ${title}`);
  return false;
}

export async function inspectLookerTiles(frame) {
  return frame.evaluate(() => {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const knownTitles = [
      "Sales overview",
      "Net sales per day",
      "Net sales per day of week",
      "Net sales by hour of day",
      "Revenue summary",
      "Charges summary",
      "Net sales by sales channel",
      "Net sales by payment method",
      "Net sales by dispatch type",
      "Net sales by property",
    ];

    const empty = [];
    const loaded = [];
    const seen = new Set();

    function tileHasData(root) {
      if (!root) return false;
      const paths = root.querySelectorAll("svg path, svg rect, svg circle, svg line").length;
      const canvas = root.querySelectorAll("canvas").length;
      const cells = root.querySelectorAll("table td").length;
      const text = clean(root.innerText);
      const money = /£|\$|€|\d{1,3}(,\d{3})+|\d+\.\d{2}/.test(text);
      const loading = root.querySelectorAll('[class*="loading"], [class*="spinner"], [aria-busy="true"]').length;
      const noResults = /no results|nothing to show|no data/i.test(text);
      return loading === 0 && (paths >= 6 || canvas >= 1 || cells >= 3 || money || noResults);
    }

    function findContainer(titleEl) {
      let el = titleEl;
      for (let i = 0; i < 10 && el; i++) {
        const r = el.getBoundingClientRect();
        if (r.height > 100 && r.width > 150) return el;
        el = el.parentElement;
      }
      return titleEl?.parentElement;
    }

    for (const title of knownTitles) {
      if (seen.has(title.toLowerCase())) continue;
      const nodes = [...document.querySelectorAll("h1,h2,h3,h4,div,span,p")].filter(
        (n) => clean(n.innerText) === title || clean(n.textContent) === title
      );
      nodes.sort((a, b) => clean(a.innerText).length - clean(b.innerText).length);
      const titleEl = nodes[0];
      if (!titleEl) continue;
      seen.add(title.toLowerCase());
      const box = findContainer(titleEl);
      if (tileHasData(box)) loaded.push(title);
      else empty.push(title);
    }

    let loading = 0;
    for (const sel of ['[class*="loading"]', '[class*="spinner"]', '[aria-busy="true"]', '[class*="skeleton"]']) {
      loading += document.querySelectorAll(sel).length;
    }

    const body = clean(document.body?.innerText || "");
    return {
      emptyTiles: empty,
      loadedTiles: loaded,
      emptyCount: empty.length,
      loadedCount: loaded.length,
      loading,
      svgs: document.querySelectorAll("svg").length,
      tableCells: document.querySelectorAll("table td").length,
      hasMoney: /£|\$|€/.test(body),
    };
  });
}

export async function waitForLookerData(frame, label, reportLoadMs) {
  const deadline = Date.now() + reportLoadMs;
  let lastLog = 0;
  let best = { emptyCount: 99, loadedCount: 0, svgs: 0 };

  console.log(`  deep-scroll to mount lazy tiles…`);
  await deepScrollLooker(frame);
  await sleep(2000);

  let state = await inspectLookerTiles(frame).catch(() => null);
  if (state?.emptyTiles?.length) {
    console.log(`  parking on empty tiles: ${state.emptyTiles.join(", ")}`);
    for (const title of state.emptyTiles) {
      const left = deadline - Date.now();
      if (left < 5000) break;
      await waitForTileByTitle(frame, title, Math.min(100000, left));
    }
  }

  while (Date.now() < deadline) {
    try {
      state = await inspectLookerTiles(frame);
    } catch {
      await sleep(2000);
      continue;
    }

    if (state.loadedCount > best.loadedCount || state.emptyCount < best.emptyCount) best = state;

    const bottomEmpty = (state.emptyTiles || []).filter((t) =>
      /sales channel|payment method|dispatch type|by property/i.test(t)
    );

    const elapsed = Date.now() - (deadline - reportLoadMs);
    const summaryReady =
      state.loading === 0 && state.hasMoney && state.emptyCount === 0 && state.loadedCount >= 6;
    // Other Looker tabs (Trends / Properties / Sales Data) use different tile titles
    const otherTabReady =
      state.loading === 0 &&
      state.emptyCount === 0 &&
      state.loadedCount < 6 &&
      ((state.hasMoney && state.svgs >= 12) || state.svgs >= 20 || state.tableCells >= 8) &&
      elapsed > 15000;

    if (summaryReady || otherTabReady) {
      console.log(
        `  ✓ tiles ready (${label}) loaded=${state.loadedCount} empty=${state.emptyCount} svgs=${state.svgs} cells=${state.tableCells}`
      );
      if (state.loadedTiles?.length) console.log(`    ${state.loadedTiles.join(" | ")}`);
      await sleep(2000);
      return state;
    }

    if (bottomEmpty.length) {
      for (const title of bottomEmpty) {
        const left = deadline - Date.now();
        if (left < 5000) break;
        await waitForTileByTitle(frame, title, Math.min(60000, left));
      }
    } else if (state.emptyCount > 0) {
      await deepScrollLooker(frame);
    }

    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      console.log(
        `  … waiting ALL tiles (${label}) ${Math.round(elapsed / 1000)}s — loaded=${state.loadedCount} empty=${state.emptyCount} [${(state.emptyTiles || []).join(", ")}] svgs=${state.svgs}`
      );
    }
    await sleep(2000);
  }

  state = await inspectLookerTiles(frame).catch(() => best);
  console.warn(
    `  ⚠ tile wait timeout (${label}) loaded=${state.loadedCount ?? best.loadedCount} empty=${state.emptyCount ?? best.emptyCount} remaining=[${(state.emptyTiles || []).join(", ")}]`
  );
  await deepScrollLooker(frame);
  await sleep(3000);
  return { timedOut: true, ...state };
}
