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

const EXPLICIT_PET_TAGS = new Set(["pet", "pets"]);

const EXPLICIT_NON_PET_TAGS = new Set([
  "egg", "eggs", "food", "foods", "toy", "toys", "stroller", "strollers",
  "vehicle", "vehicles", "gift", "gifts", "pet wear", "petwear", "pet wears",
  "wing", "wings", "potion", "potions", "accessory", "accessories"
]);

const PET_SPECIFIC_VALUE_KEYS = [
  "rvalue - nopotion", "rvalue-nopotion", "rvalue_nopotion", "rvalue no potion",
  "rvalue nopotion", "npvalue", "no potion", "nopotion", "noPotionValue",
  "rvalue - fly", "rvalue-fly", "rvalue_fly", "rvalue fly", "flyvalue", "fly value",
  "rvalue - ride", "rvalue-ride", "rvalue_ride", "rvalue ride", "ridevalue", "ride value",
  "nvalue", "neon value", "neonValue",
  "nvalue - nopotion", "nvalue-nopotion", "nvalue_nopotion", "nvalue no potion",
  "nvalue nopotion", "neon no potion", "neonNoPotionValue",
  "nvalue - fly", "nvalue-fly", "nvalue_fly", "neon fly", "neonFlyValue",
  "nvalue - ride", "nvalue-ride", "nvalue_ride", "neon ride", "neonRideValue",
  "nvalue - fly ride", "nvalue - fr", "nvalue-fr", "nvalue_fr",
  "neon fly ride", "neonFlyRideValue", "nfrvalue",
  "mvalue", "mega value", "megaValue",
  "mvalue - nopotion", "mvalue-nopotion", "mvalue_nopotion", "mvalue no potion",
  "mvalue nopotion", "mega no potion", "megaNoPotionValue",
  "mvalue - fly", "mvalue-fly", "mvalue_fly", "mega fly", "megaFlyValue",
  "mvalue - ride", "mvalue-ride", "mvalue_ride", "mega ride", "megaRideValue",
  "mvalue - fly ride", "mvalue - fr", "mvalue-fr", "mvalue_fr",
  "mega fly ride", "megaFlyRideValue", "mfrvalue"
];

const KNOWN_NON_PET_SENTINELS = [
  "royal egg", "retired egg", "ride a pet potion forever", "choosy potion"
];

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanName(value) {
  return String(value || "")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\\//g, "/")
    .replace(/\s+/g, " ")
    .trim();
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
    const n = toNumber(getCaseInsensitive(obj, [key]));
    if (n > 0) return n;
  }
  return 0;
}

function itemNameFromElvebredd(raw) {
  return cleanName(
    raw.name || raw.displayName || raw.display_name || raw.petName ||
    raw.itemName || raw.title || raw.label || raw.d || ""
  );
}

function buildAliases(displayName, key) {
  const aliases = new Set();
  const normalized = normalizeName(displayName);
  if (normalized && normalized !== key) aliases.add(normalized);
  const shorthandPairs = [
    [" dragon", " drag"], [" unicorn", " uni"], [" kangaroo", " kanga"],
    [" turtle", " turt"], [" tyrannosaurus rex", " t rex"], [" t rex", " trex"],
    [" strawberry shortcake bat dragon", " ssbd"], [" chocolate chip bat dragon", " ccbd"]
  ];
  for (const [from, to] of shorthandPairs) {
    if (normalized.includes(from)) aliases.add(normalized.replace(from, to));
  }
  return Array.from(aliases).filter(Boolean);
}

function makeBlankItem(displayName, raw) {
  const category = cleanName(raw.type || raw.category || raw.rarity || raw.kind || "unknown").toLowerCase() || "unknown";
  return {
    displayName, category, source: "elvebredd",
    NP: 0, F: 0, R: 0, FR: 0, N: 0, NF: 0, NR: 0, NFR: 0, M: 0, MF: 0, MR: 0, MFR: 0,
    demand: {}, aliases: [],
    valueMeta: { source: {}, confidence: {}, originalRaw: {}, notes: [] }
  };
}

function setVariant(item, variant, value, sourceKey, confidence) {
  const n = roundValue(value);
  if (!VARIANTS.includes(variant) || n <= 0) return false;
  item[variant] = n;
  item.valueMeta.source[variant] = sourceKey;
  item.valueMeta.confidence[variant] = confidence;
  item.valueMeta.originalRaw[variant] = value;
  return true;
}

function classificationTags(raw) {
  const fields = [
    raw.type, raw.category, raw.kind, raw.itemType, raw.item_type,
    raw.categoryName, raw.category_name, raw.group, raw.section
  ];
  return Array.from(new Set(fields.map(normalizeName).filter(Boolean)));
}

function hasPetSpecificValueEvidence(raw) {
  return firstPositiveNumber(raw, PET_SPECIFIC_VALUE_KEYS) > 0;
}

function strongNonPetNameReason(displayName) {
  const name = normalizeName(displayName);
  if (name === "egg" || name.endsWith(" egg")) return "name is an egg item";
  if (/(^| )potion( |$)/.test(name)) return "name contains standalone 'potion'";
  return null;
}

function classifyElvebreddItem(raw, displayName) {
  const tags = classificationTags(raw);
  const explicitPetTag = tags.find(tag => EXPLICIT_PET_TAGS.has(tag)) || null;
  const explicitNonPetTag = tags.find(tag => EXPLICIT_NON_PET_TAGS.has(tag)) || null;
  const petSpecificValueEvidence = hasPetSpecificValueEvidence(raw);
  const nameNonPetReason = strongNonPetNameReason(displayName);

  if (nameNonPetReason) {
    if (petSpecificValueEvidence) return { kind: "unknown", reason: `${nameNonPetReason}, but pet-specific value fields were also present` };
    return { kind: "nonpet", reason: nameNonPetReason };
  }
  if (explicitNonPetTag) {
    if (petSpecificValueEvidence) return { kind: "unknown", reason: `non-pet tag '${explicitNonPetTag}' conflicted with pet-specific value fields` };
    return { kind: "nonpet", reason: `explicit Elvebredd category/type '${explicitNonPetTag}'` };
  }
  if (explicitPetTag || petSpecificValueEvidence) {
    return {
      kind: "pet",
      reason: explicitPetTag ? `explicit Elvebredd category/type '${explicitPetTag}'` : "pet-specific potion/neon/mega value fields were present"
    };
  }
  return {
    kind: "unknown",
    reason: tags.length > 0 ? `unrecognized category/type tag(s): ${tags.join(", ")}` : "no reliable pet/non-pet classification evidence"
  };
}

function copyVariantPreservingMetadata(item, targetVariant, donorVariant, note) {
  if ((item[targetVariant] || 0) > 0) return false;
  if ((item[donorVariant] || 0) <= 0) return false;
  const donorSource = item.valueMeta.source[donorVariant] || `elvebredd:${donorVariant.toLowerCase()}`;
  const donorConfidence = item.valueMeta.confidence[donorVariant] || "direct";
  const donorOriginalRaw = Object.prototype.hasOwnProperty.call(item.valueMeta.originalRaw, donorVariant)
    ? item.valueMeta.originalRaw[donorVariant] : item[donorVariant];
  item[targetVariant] = item[donorVariant];
  item.valueMeta.source[targetVariant] = donorSource;
  item.valueMeta.confidence[targetVariant] = donorConfidence;
  item.valueMeta.originalRaw[targetVariant] = donorOriginalRaw;
  if (note) item.valueMeta.notes.push(note);
  return true;
}

function convertElvebreddItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const displayName = itemNameFromElvebredd(raw);
  if (!displayName || displayName.length < 2) return null;
  const key = normalizeName(displayName);
  if (!key) return null;

  const item = makeBlankItem(displayName, raw);
  item.aliases = buildAliases(displayName, key);
  item.valueMeta.elvebreddId = raw.id ?? raw.petId ?? raw.itemId ?? null;
  item.valueMeta.status = raw.status || null;
  item.valueMeta.rarity = raw.rarity || null;
  item.valueMeta.image = raw.image || null;

  const mapping = {
    NP: ["rvalue - nopotion", "rvalue-nopotion", "rvalue_nopotion", "rvalue no potion", "rvalue nopotion", "npvalue", "no potion", "nopotion", "noPotionValue"],
    F: ["rvalue - fly", "rvalue-fly", "rvalue_fly", "rvalue fly", "flyvalue", "fly value"],
    R: ["rvalue - ride", "rvalue-ride", "rvalue_ride", "rvalue ride", "ridevalue", "ride value"],
    FR: ["rvalue - fly ride", "rvalue - fr", "rvalue-fr", "rvalue_fr", "regular value", "regularValue", "frvalue", "fly ride", "flyride", "value", "rvalue"],
    N: ["nvalue - nopotion", "nvalue-nopotion", "nvalue_nopotion", "nvalue no potion", "nvalue nopotion", "neon no potion", "neonNoPotionValue"],
    NF: ["nvalue - fly", "nvalue-fly", "nvalue_fly", "neon fly", "neonFlyValue"],
    NR: ["nvalue - ride", "nvalue-ride", "nvalue_ride", "neon ride", "neonRideValue"],
    NFR: ["nvalue - fly ride", "nvalue - fr", "nvalue-fr", "nvalue_fr", "neon fly ride", "neonFlyRideValue", "nfrvalue", "nvalue"],
    M: ["mvalue - nopotion", "mvalue-nopotion", "mvalue_nopotion", "mvalue no potion", "mvalue nopotion", "mega no potion", "megaNoPotionValue"],
    MF: ["mvalue - fly", "mvalue-fly", "mvalue_fly", "mega fly", "megaFlyValue"],
    MR: ["mvalue - ride", "mvalue-ride", "mvalue_ride", "mega ride", "megaRideValue"],
    MFR: ["mvalue", "mvalue - fly ride", "mvalue - fr", "mvalue-fr", "mvalue_fr", "mega fly ride", "megaFlyRideValue", "mfrvalue"]
  };

  let foundAny = false;
  for (const [variant, keys] of Object.entries(mapping)) {
    const value = firstPositiveNumber(raw, keys);
    if (value > 0) {
      setVariant(item, variant, value, `elvebredd:${keys[0]}`, "direct");
      foundAny = true;
    }
  }
  if (!foundAny) return null;

  const classification = classifyElvebreddItem(raw, displayName);

  if ((item.NP || 0) <= 0 && (item.FR || 0) > 0 && classification.kind === "nonpet") {
    copyVariantPreservingMetadata(item, "NP", "FR",
      `NP copied from Elvebredd's regular rvalue for confirmed non-pet (${classification.reason}). FR was preserved for backwards compatibility.`);
  }
  if ((item.NP || 0) <= 0 && (item.FR || 0) > 0) {
    item.valueMeta.notes.push(`NP was not exposed by Elvebredd and was not inferred because this item was not confidently classified as a non-pet (${classification.reason}).`);
  }
  if ((item.NFR || 0) <= 0 && (item.N || 0) > 0) {
    item.valueMeta.notes.push("NFR was not exposed separately by Elvebredd for this item, so it is left as 0/unknown.");
  }
  if ((item.MFR || 0) <= 0 && (item.M || 0) > 0) {
    item.valueMeta.notes.push("MFR was not exposed separately by Elvebredd for this item, so it is left as 0/unknown.");
  }

  return { key, item };
}

function findMatchingBracket(text, openIndex, openChar, closeChar) {
  let depth = 0, inString = false, quote = "", escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) depth--;
    if (depth === 0) return i;
  }
  return -1;
}

function tryJsonParse(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

function htmlDecodeMinimal(text) {
  return String(text || "")
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"')
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function unescapeTextLayer(text) {
  let out = htmlDecodeMinimal(String(text || ""));
  for (let i = 0; i < 4; i++) {
    const parsed = tryJsonParse(`"${out.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    if (typeof parsed === "string" && parsed !== out) out = parsed;
    const manually = out
      .replace(/\\"/g, '"').replace(/\\\//g, "/")
      .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
      .replace(/\\u0026/g, "&");
    if (manually === out) break;
    out = manually;
  }
  return out;
}

function walk(value, onString, seen = new WeakSet()) {
  if (typeof value === "string") { onString(value); return; }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) { for (const child of value) walk(child, onString, seen); return; }
  for (const child of Object.values(value)) walk(child, onString, seen);
}

function collectStringsFromNextFlight(html) {
  const strings = [];
  const needle = "self.__next_f.push";
  let index = 0;
  while (true) {
    const pushIndex = html.indexOf(needle, index);
    if (pushIndex === -1) break;
    const openIndex = html.indexOf("(", pushIndex);
    if (openIndex === -1) break;
    const closeIndex = findMatchingBracket(html, openIndex, "(", ")");
    if (closeIndex === -1) { index = pushIndex + needle.length; continue; }
    const rawArg = html.slice(openIndex + 1, closeIndex);
    const parsed = tryJsonParse(rawArg);
    if (parsed) walk(parsed, s => strings.push(s));
    else strings.push(rawArg);
    index = closeIndex + 1;
  }
  return strings;
}

function extractInitialPetsArraysFromText(text) {
  const arrays = [];
  const versions = new Set();
  const candidates = [String(text || ""), unescapeTextLayer(text)];
  for (const candidate of candidates) {
    if (!candidate || versions.has(candidate)) continue;
    versions.add(candidate);
    let index = 0;
    while (true) {
      const markerIndex = candidate.indexOf("initialPets", index);
      if (markerIndex === -1) break;
      const colonIndex = candidate.indexOf(":", markerIndex);
      const openIndex = candidate.indexOf("[", colonIndex === -1 ? markerIndex : colonIndex);
      if (openIndex !== -1) {
        const closeIndex = findMatchingBracket(candidate, openIndex, "[", "]");
        if (closeIndex !== -1) {
          const rawArray = candidate.slice(openIndex, closeIndex + 1);
          const parsed = tryJsonParse(rawArray) || tryJsonParse(unescapeTextLayer(rawArray));
          if (Array.isArray(parsed)) arrays.push(parsed);
          index = closeIndex + 1;
          continue;
        }
      }
      index = markerIndex + "initialPets".length;
    }
  }
  return arrays;
}

function cleanMergedNotes(item) {
  if (!item || !item.valueMeta || !Array.isArray(item.valueMeta.notes)) return;
  const notes = Array.from(new Set(item.valueMeta.notes));
  item.valueMeta.notes = notes.filter(note => {
    if ((item.NP || 0) > 0 && String(note).startsWith("NP was not exposed by Elvebredd")) return false;
    return true;
  });
}

function looksLikePetObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const name = obj.name || obj.displayName || obj.display_name || obj.petName;
  if (!name || typeof name !== "string") return false;
  return ["rvalue", "nvalue", "mvalue", "npvalue", "frvalue"].some(k =>
    Object.prototype.hasOwnProperty.call(obj, k) ||
    Object.prototype.hasOwnProperty.call(obj, k.replace("value", "Value"))
  );
}

function collectPetArrays(obj, out, seen = new WeakSet()) {
  if (!obj || typeof obj !== "object") return;
  if (seen.has(obj)) return;
  seen.add(obj);
  if (Array.isArray(obj)) {
    if (obj.length > 0 && looksLikePetObject(obj[0])) out.push(obj);
    for (const child of obj) collectPetArrays(child, out, seen);
    return;
  }
  for (const child of Object.values(obj)) collectPetArrays(child, out, seen);
}

function findPetLikeArraysInText(text) {
  const out = [];
  const re = /\[\s*\{\s*"(?:name|displayName|display_name|petName)"/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = findMatchingBracket(text, start, "[", "]");
    if (end === -1) continue;
    const raw = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && looksLikePetObject(parsed[0])) out.push(parsed);
    } catch (_) {}
  }
  return out;
}

function extractElvebreddItems(html, preArrays = []) {
  const arrays = [...preArrays];
  const source = { preCaptured: preArrays.length, nextData: 0, initialPets: 0, flight: 0, generic: 0 };

  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const before = arrays.length;
      collectPetArrays(JSON.parse(nextMatch[1]), arrays);
      source.nextData = arrays.length - before;
    } catch (e) {
      console.log("__NEXT_DATA__ parse failed:", e.message);
    }
  }

  const initial = extractInitialPetsArraysFromText(html);
  source.initialPets = initial.length;
  arrays.push(...initial);

  const strings = collectStringsFromNextFlight(html);
  let flightCount = 0;
  for (const str of strings) {
    const found = extractInitialPetsArraysFromText(str);
    flightCount += found.length;
    arrays.push(...found);
  }
  source.flight = flightCount;

  if (arrays.length === 0) {
    const generic = findPetLikeArraysInText(html);
    source.generic = generic.length;
    arrays.push(...generic);
  }

  console.log(
    "JSON extraction source counts:",
    JSON.stringify(source),
    "| total arrays:", arrays.length
  );

  const map = new Map();
  for (const arr of arrays) {
    for (const raw of arr) {
      const converted = convertElvebreddItem(raw);
      if (!converted) continue;
      const existing = map.get(converted.key);
      if (!existing) {
        map.set(converted.key, converted.item);
      } else {
        for (const variant of VARIANTS) {
          if ((existing[variant] || 0) <= 0 && (converted.item[variant] || 0) > 0) {
            existing[variant] = converted.item[variant];
            existing.valueMeta.source[variant] = converted.item.valueMeta.source[variant];
            existing.valueMeta.confidence[variant] = converted.item.valueMeta.confidence[variant];
            existing.valueMeta.originalRaw[variant] = converted.item.valueMeta.originalRaw[variant];
          }
        }
        existing.aliases = Array.from(new Set([...(existing.aliases || []), ...(converted.item.aliases || [])]));
        existing.valueMeta.notes = Array.from(new Set([...(existing.valueMeta.notes || []), ...(converted.item.valueMeta.notes || [])]));
        cleanMergedNotes(existing);
      }
    }
  }
  for (const item of map.values()) cleanMergedNotes(item);
  return map;
}

// DOM fallback: uses previous DB names as a dictionary, finds each one in
// the rendered page text, and reads up to 12 numbers following it.
async function extractItemsFromDOM(page, knownNames) {
  return await page.evaluate((names) => {
    const text = document.body.innerText;
    const lowerText = text.toLowerCase();
    const results = [];
    const seen = new Set();

    for (const name of names) {
      const lower = name.toLowerCase();
      if (seen.has(lower)) continue;

      let best = null;
      let searchStart = 0;

      while (true) {
        const idx = lowerText.indexOf(lower, searchStart);
        if (idx === -1) break;

        const before = idx === 0 ? " " : text[idx - 1];
        const afterIdx = idx + name.length;
        const after = afterIdx >= text.length ? " " : text[afterIdx];

        if (!/[a-zA-Z]/.test(before) && !/[a-zA-Z]/.test(after)) {
          const window = text.slice(afterIdx, afterIdx + 400);
          const nums = window.match(/\d+(?:\.\d+)?/g);
          if (nums && nums.length >= 2) {
            if (!best || nums.length > best.nums.length) {
              best = { name, nums: nums.slice(0, 12).map(Number) };
            }
          }
        }
        searchStart = idx + name.length;
      }

      if (best) {
        seen.add(lower);
        results.push(best);
      }
    }

    return results;
  }, knownNames);
}

async function fetchRenderedPage(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1920, height: 1080 });

    const capturedPetArrays = [];
    const pending = [];

    page.on("response", (response) => {
      const ct = (response.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("json")) return;
      const p = (async () => {
        try {
          const json = await response.json();
          const before = capturedPetArrays.length;
          collectPetArrays(json, capturedPetArrays);
          if (capturedPetArrays.length > before) {
            console.log(`Captured ${capturedPetArrays.length - before} pet array(s) from ${response.url()}`);
          }
        } catch (_) {}
      })();
      pending.push(p);
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(r => setTimeout(r, 12000));
    await Promise.allSettled(pending);

    const html = await page.content();
    console.log("Rendered HTML length:", html.length);
    console.log("Captured pet arrays from network:", capturedPetArrays.length);
    console.log("HTML contains 'Shadow Dragon':", html.includes("Shadow Dragon"));
    console.log("HTML contains '__NEXT_DATA__':", html.includes("__NEXT_DATA__"));
    console.log("HTML contains 'initialPets':", html.includes("initialPets"));

    // Diagnostic: dump the text around Shadow Dragon so we can see the format.
    try {
      const shadowContext = await page.evaluate(() => {
        const text = document.body.innerText;
        const idx = text.toLowerCase().indexOf("shadow dragon");
        if (idx === -1) return "NOT FOUND in innerText";
        return text.slice(Math.max(0, idx - 100), idx + 500);
      });
      console.log("=== Shadow Dragon text context ===\n" + shadowContext + "\n=== End context ===");
    } catch (e) {
      console.log("Diagnostic failed:", e.message);
    }

    return { browser, page, html, capturedPetArrays };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

function categoryCounts(items) {
  const counts = {};
  for (const item of items) {
    const key = item.category || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function countPositiveVariantCells(items) {
  let count = 0;
  for (const item of Object.values(items || {})) {
    for (const variant of VARIANTS) {
      if (toNumber(item && item[variant]) > 0) count++;
    }
  }
  return count;
}

function countNormalizedNonPetItems(items) {
  let count = 0;
  for (const item of Object.values(items || {})) {
    const notes = item && item.valueMeta && Array.isArray(item.valueMeta.notes) ? item.valueMeta.notes : [];
    if (notes.some(note => String(note).startsWith("NP copied from Elvebredd's regular rvalue for confirmed non-pet"))) count++;
  }
  return count;
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

function validateRatio(name, value) {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be a number greater than 0 and at most 1. Received: ${value}`);
  }
}

function validateCandidate(output, previousOutput) {
  if (!Number.isFinite(MIN_ITEMS) || MIN_ITEMS < 1) {
    throw new Error(`MIN_ITEMS must be a positive number. Received: ${MIN_ITEMS}`);
  }
  validateRatio("MIN_PREVIOUS_ITEM_RATIO", MIN_PREVIOUS_ITEM_RATIO);
  validateRatio("MIN_PREVIOUS_OVERLAP_RATIO", MIN_PREVIOUS_OVERLAP_RATIO);
  validateRatio("MIN_PREVIOUS_NONZERO_RATIO", MIN_PREVIOUS_NONZERO_RATIO);

  const items = output.items || {};
  const keys = Object.keys(items);

  if (keys.length < MIN_ITEMS) {
    throw new Error(`Only extracted ${keys.length} item(s). Expected at least ${MIN_ITEMS}. Elvebredd page format may have changed.`);
  }

  const shadow = items["shadow dragon"];
  if (!shadow) throw new Error("Safety check failed: Shadow Dragon is missing from the generated database.");

  const shadowHasRegularValue = ["NP", "F", "R", "FR"].some(variant => toNumber(shadow[variant]) > 0);
  if (!shadowHasRegularValue) throw new Error("Safety check failed: Shadow Dragon has no positive regular value.");

  for (const key of KNOWN_NON_PET_SENTINELS) {
    const item = items[key];
    if (!item) continue;
    if (toNumber(item.FR) > 0 && toNumber(item.NP) <= 0) {
      throw new Error(`Safety check failed: known non-pet '${item.displayName || key}' still has FR but no NP value.`);
    }
  }

  if (!previousOutput || !previousOutput.items || typeof previousOutput.items !== "object") return;

  const previousItems = previousOutput.items;
  const previousKeys = Object.keys(previousItems);
  const previousCount = previousKeys.length;
  const newCount = keys.length;

  if (previousCount > 0) {
    const itemRatio = newCount / previousCount;
    if (itemRatio < MIN_PREVIOUS_ITEM_RATIO) {
      throw new Error(
        `Safety check failed: item count dropped from ${previousCount} to ${newCount} ` +
        `(${(itemRatio * 100).toFixed(2)}% of previous; minimum ${(MIN_PREVIOUS_ITEM_RATIO * 100).toFixed(2)}%).`
      );
    }
    let overlap = 0;
    for (const key of previousKeys) if (Object.prototype.hasOwnProperty.call(items, key)) overlap++;
    const overlapRatio = overlap / previousCount;
    if (overlapRatio < MIN_PREVIOUS_OVERLAP_RATIO) {
      throw new Error(
        `Safety check failed: only ${overlap}/${previousCount} previous item keys remain ` +
        `(${(overlapRatio * 100).toFixed(2)}%; minimum ${(MIN_PREVIOUS_OVERLAP_RATIO * 100).toFixed(2)}%).`
      );
    }
  }

  const previousPositiveCells = countPositiveVariantCells(previousItems);
  const newPositiveCells = countPositiveVariantCells(items);
  if (previousPositiveCells > 0) {
    const nonzeroRatio = newPositiveCells / previousPositiveCells;
    if (nonzeroRatio < MIN_PREVIOUS_NONZERO_RATIO) {
      throw new Error(
        `Safety check failed: positive value cells dropped from ${previousPositiveCells} to ${newPositiveCells} ` +
        `(${(nonzeroRatio * 100).toFixed(2)}% of previous; minimum ${(MIN_PREVIOUS_NONZERO_RATIO * 100).toFixed(2)}%).`
      );
    }
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

async function main() {
  console.log(`Fetching Elvebredd values from ${ELVEBREDD_URL}`);

  const previousOutput = await readPreviousOutput();

  const { browser, page, html, capturedPetArrays } = await fetchRenderedPage(ELVEBREDD_URL);

  let itemMap;
  try {
    // Step 1: try JSON-based extraction (works if Elvebredd ever exposes data as JSON again).
    itemMap = extractElvebreddItems(html, capturedPetArrays);
    console.log(`JSON extraction: ${itemMap.size} item(s)`);

    // Step 2: if JSON extraction yielded too few items, use the previous DB as a
    // dictionary of known pet names and read numbers from the rendered DOM text.
    if (itemMap.size < MIN_ITEMS) {
      const knownNames = previousOutput && previousOutput.items
        ? Object.values(previousOutput.items).map(it => it && it.displayName).filter(n => typeof n === "string" && n.length >= 2)
        : [];

      if (knownNames.length > 0) {
        console.log(`DOM fallback: scanning rendered text for ${knownNames.length} known pet names...`);
        const domItems = await extractItemsFromDOM(page, knownNames);
        console.log(`DOM fallback: found ${domItems.length} pet name(s) with numeric data`);

        for (const { name, nums } of domItems) {
          const key = normalizeName(name);
          if (!key || itemMap.has(key)) continue;

          const item = makeBlankItem(name, {});
          item.aliases = buildAliases(name, key);

          // Best-effort column mapping: NP, F, R, FR, N, NF, NR, NFR, M, MF, MR, MFR
          for (let i = 0; i < Math.min(nums.length, VARIANTS.length); i++) {
            if (nums[i] > 0) {
              const variant = VARIANTS[i];
              item[variant] = roundValue(nums[i]);
              item.valueMeta.source[variant] = "elvebredd:dom-text";
              item.valueMeta.confidence[variant] = "low";
              item.valueMeta.originalRaw[variant] = nums[i];
            }
          }

          item.valueMeta.notes.push(
            `Values extracted from rendered DOM text using previous DB pet name list; column order assumed NP,F,R,FR,N,NF,NR,NFR,M,MF,MR,MFR.`
          );

          itemMap.set(key, item);
        }
      } else {
        console.log("No known pet names available from previous DB, cannot use DOM fallback.");
      }
    }
  } finally {
    await browser.close();
  }

  const sortedEntries = Array.from(itemMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  const items = Object.fromEntries(sortedEntries);
  console.log(`Final item count: ${sortedEntries.length}`);

  const output = {
    version: 5,
    updatedAt: new Date().toISOString(),
    source: "elvebredd-rendered-dom-extraction",
    sourceUrl: ELVEBREDD_URL,
    itemCount: sortedEntries.length,
    valueScale: "elvebredd-display-values",
    variantKeys: {
      NP: "No Potion / Normal / Default no-potion value when exposed",
      F: "Regular Fly-only value when exposed",
      R: "Regular Ride-only value when exposed",
      FR: "Regular/default Fly Ride value from rvalue",
      N: "Neon value (plain, no fly/ride)",
      NF: "Neon Fly-only value when exposed",
      NR: "Neon Ride-only value when exposed",
      NFR: "Neon Fly Ride value from bare nvalue",
      M: "Mega value (plain, no fly/ride)",
      MF: "Mega Fly-only value when exposed",
      MR: "Mega Ride-only value when exposed",
      MFR: "Mega Fly Ride value from bare mvalue"
    },
    fieldMapping: {
      NP: "rvalue - nopotion", F: "rvalue - fly", R: "rvalue - ride", FR: "rvalue",
      N: "nvalue - nopotion", NF: "nvalue - fly", NR: "nvalue - ride",
      NFR: "nvalue (bare) / nvalue - fly ride / nvalue - fr",
      M: "mvalue - nopotion", MF: "mvalue - fly", MR: "mvalue - ride",
      MFR: "mvalue (bare) / mvalue - fly ride / mvalue - fr"
    },
    categoryItemCounts: categoryCounts(Object.values(items)),
    items
  };

  validateCandidate(output, previousOutput);

  const serialized = JSON.stringify(output, null, 2) + "\n";
  await writeAtomically(OUT_FILE, serialized);

  const normalizedNonPets = countNormalizedNonPetItems(items);
  console.log(`Wrote ${OUT_FILE} with ${sortedEntries.length} items.`);
  console.log(`Safely copied regular rvalue into NP for ${normalizedNonPets} confirmed non-pet item(s).`);

  const shadow = items["shadow dragon"];
  if (shadow) {
    console.log("Shadow Dragon check:", JSON.stringify({
      NP: shadow.NP, F: shadow.F, R: shadow.R, FR: shadow.FR,
      N: shadow.N, NFR: shadow.NFR, M: shadow.M, MFR: shadow.MFR
    }));
  }

  for (const key of KNOWN_NON_PET_SENTINELS) {
    const item = items[key];
    if (!item) continue;
    console.log(`Known non-pet check (${item.displayName || key}):`, JSON.stringify({ NP: item.NP, FR: item.FR }));
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
