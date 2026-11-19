const fs = require("fs/promises");
const puppeteer = require("puppeteer");

const ELVEBREDD_URL = process.env.ELVEBREDD_URL || "https://elvebredd.com/adopt-me-calculator";
const OUT_FILE = process.env.OUT_FILE || "vhx_7K29_db.json";
const MIN_ITEMS = Number(process.env.MIN_ITEMS || 100);
const MIN_PREVIOUS_ITEM_RATIO = Number(process.env.MIN_PREVIOUS_ITEM_RATIO || 0.90);
const MIN_PREVIOUS_OVERLAP_RATIO = Number(process.env.MIN_PREVIOUS_OVERLAP_RATIO || 0.85);
const MIN_PREVIOUS_NONZERO_RATIO = Number(process.env.MIN_PREVIOUS_NONZERO_RATIO || 0.85);

const VARIANTS = ["NP", "F", "R", "FR", "N", "NF", "NR", "NFR", "M", "MF", "MR", "MFR"];

// ── helpers unchanged ──────────────────────────────────────────────
function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function cleanName(value) {
  return String(value || "").replace(/\\u0026/g, "&").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\\\//g, "/").replace(/\s+/g, " ").trim();
}
function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  const text = String(value).replace(/,/g, "").trim();
  if (!text || text === "false" || text === "true" || text.toLowerCase() === "nan") return 0;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function roundValue(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 1000000) / 1000000;
}
function makeBlankItem(displayName) {
  return {
    displayName,
    category: "pet",
    source: "elvebredd",
    NP: 0, F: 0, R: 0, FR: 0,
    N: 0, NF: 0, NR: 0, NFR: 0,
    M: 0, MF: 0, MR: 0, MFR: 0,
    demand: {}, aliases: [],
    valueMeta: { source: {}, confidence: {}, originalRaw: {}, notes: [] }
  };
}

// ── DOM extraction ────────────────────────────────────────────────
async function extractFromRenderedPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

  await page.goto(ELVEBREDD_URL, { waitUntil: "networkidle2", timeout: 60_000 });

  // Wait until at least one known pet appears in the body text.
  await page.waitForFunction(
    () => /Shadow Dragon|Bat Dragon/i.test(document.body.innerText),
    { timeout: 30_000 }
  );

  // Pull every row that looks like  "Name  123.45"
  // The page renders each pet as a text line inside a card/row.
  const rows = await page.evaluate(() => {
    const results = [];
    // Walk every element, take its trimmed innerText, and keep lines
    // that contain a name followed by a positive number.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const re = /^([A-Za-z0-9 '&.\-]+?)\s+(\d[\d,]*(?:\.\d+)?)$/;
    while (walker.nextNode()) {
      const txt = walker.currentNode.nodeValue.trim();
      const m = txt.match(re);
      if (m) {
        const name = m[1].trim();
        const value = Number(m[2].replace(/,/g, ""));
        if (name.length >= 2 && value > 0) results.push({ name, value });
      }
    }
    // De‑duplicate by normalized name, keeping the first (topmost) value.
    const seen = new Set();
    return results.filter(r => {
      const k = r.name.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });

  await page.close();
  return rows;
}

// ── build the item map ────────────────────────────────────────────
function buildItemsFromRows(rows) {
  const map = new Map();
  for (const { name, value } of rows) {
    const displayName = cleanName(name);
    const key = normalizeName(displayName);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, makeBlankItem(displayName));
    }
    const item = map.get(key);
    // The main list shows the default / FR value. Put it in FR and NP.
    if (item.FR <= 0) {
      item.FR = roundValue(value);
      item.NP = roundValue(value);
      item.valueMeta.source.FR = "elvebredd:dom";
      item.valueMeta.source.NP = "elvebredd:dom";
      item.valueMeta.confidence.FR = "direct";
      item.valueMeta.confidence.NP = "direct";
    }
  }
  return map;
}

// ── safety / validation (unchanged) ──────────────────────────────
function countPositiveVariantCells(items) {
  let count = 0;
  for (const item of Object.values(items || {})) {
    for (const variant of VARIANTS) {
      if (toNumber(item && item[variant]) > 0) count++;
    }
  }
  return count;
}
function validateRatio(name, value) {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be a number greater than 0 and at most 1. Received: ${value}`);
  }
}
function validateCandidate(output, previousOutput) {
  if (!Number.isFinite(MIN_ITEMS) || MIN_ITEMS < 1) throw new Error(`MIN_ITEMS must be a positive number. Received: ${MIN_ITEMS}`);
  validateRatio("MIN_PREVIOUS_ITEM_RATIO", MIN_PREVIOUS_ITEM_RATIO);
  validateRatio("MIN_PREVIOUS_OVERLAP_RATIO", MIN_PREVIOUS_OVERLAP_RATIO);
  validateRatio("MIN_PREVIOUS_NONZERO_RATIO", MIN_PREVIOUS_NONZERO_RATIO);

  const items = output.items || {};
  const keys = Object.keys(items);

  if (keys.length < MIN_ITEMS) {
    throw new Error(`Only extracted ${keys.length} item(s). Expected at least ${MIN_ITEMS}. The DOM layout may have changed — check the waitForFunction selector.`);
  }

  const shadow = items["shadow dragon"];
  if (!shadow) throw new Error("Safety check failed: Shadow Dragon is missing from the generated database.");
  const shadowHasRegularValue = ["NP", "F", "R", "FR"].some(v => toNumber(shadow[v]) > 0);
  if (!shadowHasRegularValue) throw new Error("Safety check failed: Shadow Dragon has no positive regular value.");

  if (!previousOutput || !previousOutput.items || typeof previousOutput.items !== "object") return;

  const previousItems = previousOutput.items;
  const previousKeys = Object.keys(previousItems);
  const previousCount = previousKeys.length;
  const newCount = keys.length;

  if (previousCount > 0) {
    const itemRatio = newCount / previousCount;
    if (itemRatio < MIN_PREVIOUS_ITEM_RATIO) {
      throw new Error(`Safety check failed: item count dropped from ${previousCount} to ${newCount} (${(itemRatio * 100).toFixed(2)}% of previous; minimum ${(MIN_PREVIOUS_ITEM_RATIO * 100).toFixed(2)}%).`);
    }
    let overlap = 0;
    for (const key of previousKeys) if (Object.prototype.hasOwnProperty.call(items, key)) overlap++;
    const overlapRatio = overlap / previousCount;
    if (overlapRatio < MIN_PREVIOUS_OVERLAP_RATIO) {
      throw new Error(`Safety check failed: only ${overlap}/${previousCount} previous item keys remain (${(overlapRatio * 100).toFixed(2)}%; minimum ${(MIN_PREVIOUS_OVERLAP_RATIO * 100).toFixed(2)}%).`);
    }
  }

  const previousPositiveCells = countPositiveVariantCells(previousItems);
  const newPositiveCells = countPositiveVariantCells(items);
  if (previousPositiveCells > 0) {
    const nonzeroRatio = newPositiveCells / previousPositiveCells;
    if (nonzeroRatio < MIN_PREVIOUS_NONZERO_RATIO) {
      throw new Error(`Safety check failed: positive value cells dropped from ${previousPositiveCells} to ${newPositiveCells} (${(nonzeroRatio * 100).toFixed(2)}% of previous; minimum ${(MIN_PREVIOUS_NONZERO_RATIO * 100).toFixed(2)}%).`);
    }
  }
}

async function readPreviousOutput() {
  try {
    const text = await fs.readFile(OUT_FILE, "utf8");
    if (!text.trim()) throw new Error(`${OUT_FILE} exists but is empty.`);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !parsed.items || typeof parsed.items !== "object") {
      throw new Error(`${OUT_FILE} exists but does not contain a valid items object.`);
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw new Error(`Refusing to replace the existing database because it could not be read safely: ${error.message}`);
  }
}

async function writeAtomically(path, text) {
  const tempPath = `${path}.tmp`;
  await fs.writeFile(tempPath, text, "utf8");
  try {
    await fs.rename(tempPath, path);
  } catch (error) {
    try { await fs.unlink(tempPath); } catch (_) {}
    throw error;
  }
}

// ── main ──────────────────────────────────────────────────────────
async function main() {
  console.log(`Rendering Elvebredd values from ${ELVEBREDD_URL}`);
  const previousOutput = await readPreviousOutput();

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  let rows;
  try {
    rows = await extractFromRenderedPage(browser);
  } finally {
    await browser.close();
  }

  console.log(`DOM scrape found ${rows.length} raw pet/value rows.`);

  const itemMap = buildItemsFromRows(rows);
  const sortedEntries = Array.from(itemMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  const items = Object.fromEntries(sortedEntries);

  const output = {
    version: 6,
    updatedAt: new Date().toISOString(),
    source: "elvebredd-dom-scrape",
    sourceUrl: ELVEBREDD_URL,
    itemCount: sortedEntries.length,
    valueScale: "elvebredd-display-values",
    variantKeys: {
      NP: "No Potion / Normal / Default no-potion value (DOM default value)",
      FR: "Regular/default Fly Ride value (DOM default value)",
      // other variants remain 0 until a detail pass is added
    },
    categoryItemCounts: (() => {
      const counts = {};
      for (const item of Object.values(items)) {
        const key = item.category || "unknown";
        counts[key] = (counts[key] || 0) + 1;
      }
      return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
    })(),
    items
  };

  validateCandidate(output, previousOutput);

  const serialized = JSON.stringify(output, null, 2) + "\n";
  await writeAtomically(OUT_FILE, serialized);

  console.log(`Wrote ${OUT_FILE} with ${sortedEntries.length} items.`);

  const shadow = items["shadow dragon"];
  console.log("Shadow Dragon check:", JSON.stringify({ NP: shadow.NP, FR: shadow.FR }));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
