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

// ── sniff candidate pet arrays out of any JSON payload ────────────
function itemNameFromElvebredd(raw) {
  return cleanName(
    raw.name || raw.displayName || raw.display_name ||
    raw.petName || raw.itemName || raw.title || raw.label || raw.d || ""
  );
}

const PET_SPECIFIC_VALUE_KEYS = [
  "rvalue - nopotion", "rvalue-nopotion", "rvalue_nopotion", "rvalue no potion", "rvalue nopotion",
  "npvalue", "no potion", "nopotion", "noPotionValue",
  "rvalue - fly", "rvalue-fly", "rvalue_fly", "rvalue fly", "flyvalue", "fly value",
  "rvalue - ride", "rvalue-ride", "rvalue_ride", "rvalue ride", "ridevalue", "ride value",
  "rvalue - fly ride", "rvalue - fr", "rvalue-fr", "rvalue_fr", "regular value",
  "regularValue", "frvalue", "fly ride", "flyride", "value", "rvalue",
  "nvalue", "neon value", "neonValue",
  "nvalue - nopotion", "nvalue-nopotion", "nvalue_nopotion", "nvalue no potion", "nvalue nopotion",
  "nvalue - fly", "nvalue-fly", "nvalue_fly", "nvalue - ride", "nvalue-ride", "nvalue_ride",
  "nvalue - fly ride", "nvalue - fr", "nvalue-fr", "nvalue_fr", "nfrvalue",
  "mvalue", "mega value", "megaValue",
  "mvalue - nopotion", "mvalue-nopotion", "mvalue_nopotion", "mvalue no potion", "mvalue nopotion",
  "mvalue - fly", "mvalue-fly", "mvalue_fly", "mvalue - ride", "mvalue-ride", "mvalue_ride",
  "mvalue - fly ride", "mvalue - fr", "mvalue-fr", "mvalue_fr", "mfrvalue"
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

function firstPositiveNumber(obj, keys) {
  for (const key of keys) {
    const value = getCaseInsensitive(obj, [key]);
    const n = toNumber(value);
    if (n > 0) return n;
  }
  return 0;
}

function hasValueFields(raw) {
  return firstPositiveNumber(raw, PET_SPECIFIC_VALUE_KEYS) > 0;
}

function looksLikePetRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const name = itemNameFromElvebredd(raw);
  if (!name || name.length < 2) return false;
  return hasValueFields(raw);
}

function findPetArraysInJson(value, depth, found) {
  if (depth > 8 || !value) return;
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(looksLikePetRecord)) {
      found.push(value);
      return;
    }
    for (const child of value) findPetArraysInJson(child, depth + 1, found);
    return;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value)) findPetArraysInJson(child, depth + 1, found);
  }
}

function tryJsonParse(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

function convertElvebreddItem(raw) {
  if (!looksLikePetRecord(raw)) return null;
  const displayName = itemNameFromElvebredd(raw);
  const key = normalizeName(displayName);
  if (!key) return null;

  const item = makeBlankItem(displayName);
  item.valueMeta.elvebreddId = raw.id ?? raw.petId ?? raw.itemId ?? null;

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
    const value = firstPositiveNumber(raw, keys);
    if (value > 0) {
      item[variant] = roundValue(value);
      item.valueMeta.source[variant] = `elvebredd:${keys[0]}`;
      item.valueMeta.confidence[variant] = "direct";
    }
  }

  // If the item has an FR but no NP (which Elvebredd often omits), mirror it.
  // (You can restore the strict "only non-pets" logic later if you want.)
  if ((item.NP || 0) <= 0 && (item.FR || 0) > 0) {
    item.NP = item.FR;
    item.valueMeta.source.NP = "elvebredd:fr-mirror";
    item.valueMeta.confidence.NP = "mirrored";
  }

  return { key, item };
}

// ── steal pet data from all captured responses ────────────────────
async function extractFromRenderedPage(browser) {
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
      const url = response.url();
      const ct = (response.headers()["content-type"] || "").toLowerCase();
      if (!/json|javascript|text/.test(ct) && !/\.json(\?|$)|api|\/_next\/data/i.test(url)) return;

      const text = await response.text();
      if (!text || text.length < 200) return;
      if (!/shadow dragon|bat dragon|frost dragon/i.test(text)) return;

      const parsed = tryJsonParse(text);
      if (parsed) captured.push({ url, parsed });
    } catch (_) {}
  });

  await page.goto(ELVEBREDD_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });

  // Give the page time to fire its data fetches.
  await new Promise(r => setTimeout(r, 8000));

  // Also dig into in-page hydration state.
  const pageState = await page.evaluate(() => {
    const state = {};
    try {
      const nd = document.querySelector("#__NEXT_DATA__");
      if (nd && nd.textContent) state.nextData = nd.textContent;
    } catch (_) {}
    try {
      if (window.__NEXT_DATA__) state.nextData = JSON.stringify(window.__NEXT_DATA__);
    } catch (_) {}
    try {
      if (window.__INITIAL_STATE__) state.initialState = JSON.stringify(window.__INITIAL_STATE__);
    } catch (_) {}
    return state;
  });

  await page.close();

  const arrays = [];
  for (const { parsed } of captured) {
    const found = [];
    findPetArraysInJson(parsed, 0, found);
    arrays.push(...found);
  }

  for (const [k, raw] of Object.entries(pageState)) {
    if (!raw) continue;
    const parsed = tryJsonParse(raw);
    if (!parsed) continue;
    const found = [];
    findPetArraysInJson(parsed, 0, found);
    arrays.push(...found);
  }

  console.log(`Captured ${captured.length} JSON response(s); ${arrays.length} pet-array candidate(s).`);
  if (captured.length > 0) {
    console.log("Response URLs:", captured.map(c => c.url).slice(0, 20));
  }

  // Merge every pet array into one map.
  const map = new Map();
  for (const arr of arrays) {
    for (const raw of arr) {
      const converted = convertElvebreddItem(raw);
      if (!converted) continue;
      const existing = map.get(converted.key);
      if (!existing) {
        map.set(converted.key, converted.item);
      } else {
        for (const v of VARIANTS) {
          if ((existing[v] || 0) <= 0 && (converted.item[v] || 0) > 0) {
            existing[v] = converted.item[v];
            existing.valueMeta.source[v] = converted.item.valueMeta.source[v];
            existing.valueMeta.confidence[v] = converted.item.valueMeta.confidence[v];
          }
        }
      }
    }
  }

  if (map.size === 0) {
    // Debug dump so the next failure is diagnosable.
    await fs.writeFile("debug_page.html", await (await browser.newPage()).content?.() || "", "utf8").catch(() => {});
    const sampleUrls = captured.map(c => c.url).slice(0, 30);
    await fs.writeFile("debug_urls.txt", sampleUrls.join("\n"), "utf8").catch(() => {});
    throw new Error(`No pet arrays found. Captured ${captured.length} JSON responses. See debug_urls.txt / debug_page.html.`);
  }

  return map;
}

// ── build output ─────────────────────────────────────────────────
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
    throw new Error(`Only extracted ${keys.length} item(s). Expected at least ${MIN_ITEMS}. See debug_urls.txt for which endpoints responded.`);
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
  try { await fs.rename(tempPath, path); }
  catch (error) { try { await fs.unlink(tempPath); } catch (_) {} throw error; }
}

async function main() {
  console.log(`Rendering Elvebredd values from ${ELVEBREDD_URL}`);
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
    itemMap = await extractFromRenderedPage(browser);
  } finally {
    await browser.close();
  }

  const sortedEntries = Array.from(itemMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  const items = Object.fromEntries(sortedEntries);

  const categoryItemCounts = (() => {
    const counts = {};
    for (const item of Object.values(items)) {
      const key = item.category || "unknown";
      counts[key] = (counts[key] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  })();

  const output = {
    version: 6,
    updatedAt: new Date().toISOString(),
    source: "elvebredd-api-scrape",
    sourceUrl: ELVEBREDD_URL,
    itemCount: sortedEntries.length,
    valueScale: "elvebredd-display-values",
    variantKeys: {
      NP: "No Potion / Normal / Default no-potion value",
      FR: "Regular/default Fly Ride value",
      // others filled when Elvebredd exposes them
    },
    categoryItemCounts,
    items
  };

  validateCandidate(output, previousOutput);

  const serialized = JSON.stringify(output, null, 2) + "\n";
  await writeAtomically(OUT_FILE, serialized);

  console.log(`Wrote ${OUT_FILE} with ${sortedEntries.length} items.`);
  const shadow = items["shadow dragon"];
  if (shadow) console.log("Shadow Dragon check:", JSON.stringify({ NP: shadow.NP, FR: shadow.FR }));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
