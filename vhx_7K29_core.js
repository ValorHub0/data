const fs = require("fs/promises");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const ELVEBREDD_URL = process.env.ELVEBREDD_URL || "https://elvebredd.com/adopt-me-calculator";
const OUT_FILE = process.env.OUT_FILE || "vhx_7K29_db.json";
const MIN_ITEMS = Number(process.env.MIN_ITEMS || 100);
const MIN_PREVIOUS_ITEM_RATIO = Number(process.env.MIN_PREVIOUS_ITEM_RATIO || 0.90);
const MIN_PREVIOUS_OVERLAP_RATIO = Number(process.env.MIN_PREVIOUS_OVERLAP_RATIO || 0.85);
const MIN_PREVIOUS_NONZERO_RATIO = Number(process.env.MIN_PREVIOUS_NONZERO_RATIO || 0.85);

const VARIANTS = ["NP", "F", "R", "FR", "N", "NF", "NR", "NFR", "M", "MF", "MR", "MFR"];

// ── helpers ────────────────────────────────────────────────────────
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

// ── API value conversion ──────────────────────────────────────────
const VALUE_KEYS = [
  "rvalue - nopotion","rvalue-nopotion","rvalue_nopotion","rvalue no potion","rvalue nopotion",
  "npvalue","no potion","nopotion","noPotionValue",
  "rvalue - fly","rvalue-fly","rvalue_fly","rvalue fly","flyvalue","fly value",
  "rvalue - ride","rvalue-ride","rvalue_ride","rvalue ride","ridevalue","ride value",
  "rvalue - fly ride","rvalue - fr","rvalue-fr","rvalue_fr","regular value","regularValue",
  "frvalue","fly ride","flyride","value","rvalue",
  "nvalue","neon value","neonValue",
  "nvalue - nopotion","nvalue-nopotion","nvalue_nopotion","nvalue no potion","nvalue nopotion",
  "nvalue - fly","nvalue-fly","nvalue_fly","nvalue - ride","nvalue-ride","nvalue_ride",
  "nvalue - fly ride","nvalue - fr","nvalue-fr","nvalue_fr","nfrvalue",
  "mvalue","mega value","megaValue",
  "mvalue - nopotion","mvalue-nopotion","mvalue_nopotion","mvalue no potion","mvalue nopotion",
  "mvalue - fly","mvalue-fly","mvalue_fly","mvalue - ride","mvalue-ride","mvalue_ride",
  "mvalue - fly ride","mvalue - fr","mvalue-fr","mvalue_fr","mfrvalue"
];

function getCaseInsensitive(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  }
  const normalizedWanted = keys.map(k => normalizeName(k));
  for (const [key, value] of Object.entries(obj)) {
    if (normalizedWanted.includes(normalizeName(key))) return value;
  }
  return undefined;
}
function firstPositive(obj, keys) {
  for (const key of keys) {
    const n = toNumber(getCaseInsensitive(obj, [key]));
    if (n > 0) return n;
  }
  return 0;
}
function itemNameFromRaw(raw) {
  return cleanName(raw.name || raw.displayName || raw.display_name || raw.petName || raw.itemName || raw.title || raw.label || "");
}
function looksLikePetRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const name = itemNameFromRaw(raw);
  if (!name || name.length < 2) return false;
  return firstPositive(raw, VALUE_KEYS) > 0;
}
function convertApiItem(raw) {
  if (!looksLikePetRecord(raw)) return null;
  const displayName = itemNameFromRaw(raw);
  const key = normalizeName(displayName);
  if (!key) return null;

  const item = makeBlankItem(displayName);
  const mapping = {
    NP: ["rvalue - nopotion","rvalue-nopotion","rvalue_nopotion","rvalue no potion","rvalue nopotion","npvalue","no potion","nopotion","noPotionValue"],
    F:  ["rvalue - fly","rvalue-fly","rvalue_fly","rvalue fly","flyvalue","fly value"],
    R:  ["rvalue - ride","rvalue-ride","rvalue_ride","rvalue ride","ridevalue","ride value"],
    FR: ["rvalue - fly ride","rvalue - fr","rvalue-fr","rvalue_fr","regular value","regularValue","frvalue","fly ride","flyride","value","rvalue"],
    N:  ["nvalue - nopotion","nvalue-nopotion","nvalue_nopotion","nvalue no potion","nvalue nopotion","neon no potion","neonNoPotionValue"],
    NF: ["nvalue - fly","nvalue-fly","nvalue_fly","neon fly","neonFlyValue"],
    NR: ["nvalue - ride","nvalue-ride","nvalue_ride","neon ride","neonRideValue"],
    NFR:["nvalue - fly ride","nvalue - fr","nvalue-fr","nvalue_fr","neon fly ride","neonFlyRideValue","nfrvalue","nvalue"],
    M:  ["mvalue - nopotion","mvalue-nopotion","mvalue_nopotion","mvalue no potion","mvalue nopotion","mega no potion","megaNoPotionValue"],
    MF: ["mvalue - fly","mvalue-fly","mvalue_fly","mega fly","megaFlyValue"],
    MR: ["mvalue - ride","mvalue-ride","mvalue_ride","mega ride","megaRideValue"],
    MFR:["mvalue","mvalue - fly ride","mvalue - fr","mvalue-fr","mvalue_fr","mega fly ride","megaFlyRideValue","mfrvalue"]
  };

  for (const [variant, keys] of Object.entries(mapping)) {
    const value = firstPositive(raw, keys);
    if (value > 0) {
      item[variant] = roundValue(value);
      item.valueMeta.source[variant] = `elvebredd:${keys[0]}`;
      item.valueMeta.confidence[variant] = "direct";
    }
  }

  if ((item.NP || 0) <= 0 && (item.FR || 0) > 0) {
    item.NP = item.FR;
    item.valueMeta.source.NP = "elvebredd:fr-mirror";
    item.valueMeta.confidence.NP = "mirrored";
  }

  return { key, item };
}

// ── click the pet picker ─────────────────────────────────────────
async function openPetPicker(page) {
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], div"));
    const re = /see more|add pet|search pets|add item|choose pet|select pet/i;
    for (const el of candidates) {
      const text = (el.innerText || "").trim();
      if (text && text.length < 40 && re.test(text)) {
        el.click();
        return text;
      }
    }
    return null;
  });
  return clicked;
}

// ── DOM scrape after picker opens ────────────────────────────────
function extractRowsFromDom() {
  const text = document.body.innerText || "";
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const sameLine = /^([A-Za-z][A-Za-z0-9 '&.\-]{1,80}?)\s+[—\-–:\s]*\s*(\d[\d,]*(?:\.\d+)?)$/;
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    let m = raw.match(sameLine);
    if (m) {
      const name = m[1].trim();
      const value = Number(m[2].replace(/,/g, ""));
      if (name.length >= 2 && value > 0) results.push({ name, value });
      continue;
    }

    const next = lines[i + 1] || "";
    if (
      /^[A-Za-z][A-Za-z0-9 '&.\-]{1,80}$/.test(raw) &&
      /^\d[\d,]*(?:\.\d+)?$/.test(next)
    ) {
      const name = raw;
      const value = Number(next.replace(/,/g, ""));
      if (name.length >= 2 && value > 0) {
        results.push({ name, value });
        i += 1;
      }
    }
  }

  const seen = new Set();
  return results.filter(r => {
    const k = normalizeName(r.name);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildItemsFromDomRows(rows) {
  const map = new Map();
  for (const { name, value } of rows) {
    const displayName = cleanName(name);
    const key = normalizeName(displayName);
    if (!key) continue;
    if (!map.has(key)) map.set(key, makeBlankItem(displayName));
    const item = map.get(key);
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

// ── main scrape ──────────────────────────────────────────────────
async function scrapeElvebredd(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1400, height: 2000 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  const captured = [];
  page.on("response", async (response) => {
    try {
      const text = await response.text();
      if (!text || text.length < 500) return;
      if (!/rvalue|nvalue|mvalue/i.test(text)) return;
      const parsed = JSON.parse(text);
      captured.push(parsed);
    } catch (_) {}
  });

  await page.goto(ELVEBREDD_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await new Promise(r => setTimeout(r, 4000));

  const clicked = await openPetPicker(page);
  if (clicked) console.log(`Clicked picker trigger: "${clicked}"`);
  else console.log("No picker trigger found — trying to scrape visible list anyway.");

  try {
    await page.waitForFunction(
      () => /Shadow Dragon/i.test(document.body.innerText),
      { timeout: 60_000, polling: 1000 }
    );
  } catch (_) {
    console.log("Pet text did not appear within 60s — dumping debug HTML.");
    const html = await page.content();
    await fs.writeFile("debug_page.html", html, "utf8");
  }

  await new Promise(r => setTimeout(r, 3000));

  const domRows = await page.evaluate(extractRowsFromDom);
  await page.close();

  // API path
  const apiMap = new Map();
  for (const parsed of captured) {
    const walk = (v) => {
      if (!v) return;
      if (Array.isArray(v)) {
        if (v.length > 0 && v.every(looksLikePetRecord)) {
          for (const raw of v) {
            const conv = convertApiItem(raw);
            if (!conv) continue;
            const existing = apiMap.get(conv.key);
            if (!existing) apiMap.set(conv.key, conv.item);
            else {
              for (const variant of VARIANTS) {
                if ((existing[variant] || 0) <= 0 && (conv.item[variant] || 0) > 0) {
                  existing[variant] = conv.item[variant];
                  existing.valueMeta.source[variant] = conv.item.valueMeta.source[variant];
                  existing.valueMeta.confidence[variant] = conv.item.valueMeta.confidence[variant];
                }
              }
            }
          }
          return;
        }
        for (const child of v) walk(child);
        return;
      }
      if (typeof v === "object") for (const child of Object.values(v)) walk(child);
    };
    walk(parsed);
  }

  console.log(`API map: ${apiMap.size} items. DOM rows: ${domRows.length}.`);
  if (apiMap.size > 0) return apiMap;

  const domMap = buildItemsFromDomRows(domRows);
  if (domMap.size > 0) return domMap;

  throw new Error(`Both API and DOM extraction returned 0. Captured ${captured.length} JSON payload(s), ${domRows.length} DOM rows. See debug_page.html.`);
}

// ── validation (unchanged) ───────────────────────────────────────
function countPositiveCells(items) {
  let count = 0;
  for (const item of Object.values(items || {})) {
    for (const v of VARIANTS) if (toNumber(item && item[v]) > 0) count++;
  }
  return count;
}
function validateRatio(name, value) {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1. Received: ${value}`);
  }
}
function validateCandidate(output, previous) {
  if (!Number.isFinite(MIN_ITEMS) || MIN_ITEMS < 1) throw new Error(`MIN_ITEMS must be positive. Received: ${MIN_ITEMS}`);
  validateRatio("MIN_PREVIOUS_ITEM_RATIO", MIN_PREVIOUS_ITEM_RATIO);
  validateRatio("MIN_PREVIOUS_OVERLAP_RATIO", MIN_PREVIOUS_OVERLAP_RATIO);
  validateRatio("MIN_PREVIOUS_NONZERO_RATIO", MIN_PREVIOUS_NONZERO_RATIO);

  const items = output.items || {};
  const keys = Object.keys(items);

  if (keys.length < MIN_ITEMS) {
    throw new Error(`Only extracted ${keys.length} item(s). Expected at least ${MIN_ITEMS}. See debug_page.html.`);
  }

  const shadow = items["shadow dragon"];
  if (!shadow) throw new Error("Shadow Dragon missing.");
  const hasRegular = ["NP", "F", "R", "FR"].some(v => toNumber(shadow[v]) > 0);
  if (!hasRegular) throw new Error("Shadow Dragon has no regular value.");

  if (!previous || !previous.items || typeof previous.items !== "object") return;

  const prevItems = previous.items;
  const prevKeys = Object.keys(prevItems);
  const prevCount = prevKeys.length;
  const newCount = keys.length;

  if (prevCount > 0) {
    const itemRatio = newCount / prevCount;
    if (itemRatio < MIN_PREVIOUS_ITEM_RATIO) {
      throw new Error(`Item count dropped from ${prevCount} to ${newCount} (${(itemRatio * 100).toFixed(2)}%).`);
    }
    let overlap = 0;
    for (const k of prevKeys) if (Object.prototype.hasOwnProperty.call(items, k)) overlap++;
    const overlapRatio = overlap / prevCount;
    if (overlapRatio < MIN_PREVIOUS_OVERLAP_RATIO) {
      throw new Error(`Only ${overlap}/${prevCount} previous keys remain (${(overlapRatio * 100).toFixed(2)}%).`);
    }
  }

  const prevCells = countPositiveCells(prevItems);
  const newCells = countPositiveCells(items);
  if (prevCells > 0) {
    const ratio = newCells / prevCells;
    if (ratio < MIN_PREVIOUS_NONZERO_RATIO) {
      throw new Error(`Positive cells dropped from ${prevCells} to ${newCells} (${(ratio * 100).toFixed(2)}%).`);
    }
  }
}

async function readPreviousOutput() {
  try {
    const text = await fs.readFile(OUT_FILE, "utf8");
    if (!text.trim()) throw new Error(`${OUT_FILE} is empty.`);
    const parsed = JSON.parse(text);
    if (!parsed || !parsed.items || typeof parsed.items !== "object") {
      throw new Error(`${OUT_FILE} has no valid items object.`);
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw new Error(`Refusing to replace existing database: ${error.message}`);
  }
}

async function writeAtomically(path, text) {
  const tempPath = `${path}.tmp`;
  await fs.writeFile(tempPath, text, "utf8");
  try { await fs.rename(tempPath, path); }
  catch (error) { try { await fs.unlink(tempPath); } catch (_) {} throw error; }
}

async function main() {
  console.log(`Scraping Elvebredd from ${ELVEBREDD_URL}`);
  const previousOutput = await readPreviousOutput();

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  let itemMap;
  try {
    itemMap = await scrapeElvebredd(browser);
  } finally {
    await browser.close();
  }

  const sortedEntries = Array.from(itemMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  const items = Object.fromEntries(sortedEntries);

  const categoryItemCounts = (() => {
    const counts = {};
    for (const item of Object.values(items)) {
      const k = item.category || "unknown";
      counts[k] = (counts[k] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  })();

  const output = {
    version: 6,
    updatedAt: new Date().toISOString(),
    source: "elvebredd-picker-scrape",
    sourceUrl: ELVEBREDD_URL,
    itemCount: sortedEntries.length,
    valueScale: "elvebredd-display-values",
    variantKeys: {
      NP: "No Potion / Normal / Default no-potion value",
      FR: "Regular/default Fly Ride value"
    },
    categoryItemCounts,
    items
  };

  validateCandidate(output, previousOutput);

  const serialized = JSON.stringify(output, null, 2) + "\n";
  await writeAtomically(OUT_FILE, serialized);

  console.log(`Wrote ${OUT_FILE} with ${sortedEntries.length} items.`);
  const shadow = items["shadow dragon"];
  if (shadow) console.log("Shadow Dragon:", JSON.stringify({ NP: shadow.NP, FR: shadow.FR }));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
