#!/usr/bin/env node
// Scrapes current pet values from https://elvebredd.com/calculator and writes
// them to a single JSON file, replacing whatever was there. No history is kept.
//
// The page sits behind Cloudflare, so it is fetched through FlareSolverr.
// The values live in the Next.js RSC payload (self.__next_f.push(...) calls),
// which this script decodes and searches for the pet array.
//
// Env:
//   FLARESOLVERR_URL  default http://localhost:8191/v1
//   OUTPUT_FILE       default data/elve-values.json
//   MIN_PETS          default 10 (fewer than this = treat as a failed scrape)
//
// Needs Node 18+ (built-in fetch). No npm dependencies.

'use strict';

const fs = require('fs');
const path = require('path');

const TARGET_URL = 'https://elvebredd.com/calculator';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1';
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'data/elve-values.json';
const MIN_PETS = Number(process.env.MIN_PETS || 10);
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;

// ---------------------------------------------------------------- fetching

async function fetchViaFlareSolverr() {
  const res = await fetch(FLARESOLVERR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'request.get', url: TARGET_URL, maxTimeout: 90000 }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json().catch(() => null);
  if (!data || data.status !== 'ok') {
    throw new Error(`FlareSolverr failed: ${data?.message || `HTTP ${res.status}`}`);
  }
  const html = data.solution?.response || data.solution?.text || data.solution?.body;
  if (!html) throw new Error('FlareSolverr response did not include HTML');
  return html;
}

async function withRetry(fn) {
  let lastErr;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`Attempt ${i}/${ATTEMPTS} failed: ${err.message}`);
      if (i < ATTEMPTS) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- parsing

// Blank rows arrive named "nan" / "None" etc.
const JUNK_NAME = /^\s*(nan|none|null|undefined|n\/a|-)?\s*$/i;
const isJunkName = name => name == null || JUNK_NAME.test(String(name));

// Flags come through as a boolean, as 'true', or as a quoted '"true"' string.
const isTruthyFlag = v =>
  v === true || (typeof v === 'string' && v.replace(/"/g, '').trim().toLowerCase() === 'true');

function normalizePet(raw) {
  return {
    id:             raw.id,
    name:           raw.name,
    image:          raw.image,
    rarity:         raw.rarity,
    category:       raw.categoryd,
    flyRide:        isTruthyFlag(raw['fly&ride?']),
    rvalue:         raw.rvalue ?? raw.value ?? null,
    nvalue:         raw.nvalue ?? null,
    mvalue:         raw.mvalue ?? null,
    rvalueNopotion: raw['rvalue - nopotion'] ?? null,
    rvalueRide:     raw['rvalue - ride'] ?? null,
    rvalueFly:      raw['rvalue - fly'] ?? null,
    rvalueFlyRide:  raw['rvalue - fly&ride'] ?? null,
    nvalueNopotion: raw['nvalue - nopotion'] ?? null,
    nvalueRide:     raw['nvalue - ride'] ?? null,
    nvalueFly:      raw['nvalue - fly'] ?? null,
    nvalueFlyRide:  raw['nvalue - fly&ride'] ?? null,
    mvalueNopotion: raw['mvalue - nopotion'] ?? null,
    mvalueRide:     raw['mvalue - ride'] ?? null,
    mvalueFly:      raw['mvalue - fly'] ?? null,
    mvalueFlyRide:  raw['mvalue - fly&ride'] ?? null,
  };
}

const isPetRow = row =>
  row != null && typeof row === 'object' && typeof row.name === 'string' &&
  (row.rvalue !== undefined || row.value !== undefined);

// Check the first few rows, not just row 0, in case one odd row leads the list.
const isPetArray = arr => Array.isArray(arr) && arr.length > 0 && arr.slice(0, 5).some(isPetRow);

// Depth-limited search for pet arrays anywhere in a parsed value. Elvebredd
// renames the prop that carries the pets now and then (initialPets ->
// catalog.pets), so search rather than hard-code the key.
function findPetArrays(value, depth = 0, out = []) {
  if (value == null || typeof value !== 'object' || depth > 8) return out;
  if (isPetArray(value)) {
    out.push(value);
    return out;
  }
  for (const v of Array.isArray(value) ? value : Object.values(value)) findPetArrays(v, depth + 1, out);
  return out;
}

function parsePets(html) {
  // Collect every self.__next_f.push([type, payload]) call in the page.
  const segments = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[(\d+),([\s\S]*?)\]\)/g)) {
    if (m[1] === '1') {
      try { segments.push(JSON.parse(m[2])); } catch (_) {}
    } else if (m[1] === '0') {
      segments.push(m[2]);
    }
  }

  const lines = segments.join('').split('\n').filter(Boolean);
  const byId = new Map();

  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const payload = line.slice(colon + 1);
    if (!payload.startsWith('[') && !payload.startsWith('{')) continue;

    let parsed;
    try { parsed = JSON.parse(payload); } catch (_) { continue; }

    for (const arr of findPetArrays(parsed)) {
      for (const raw of arr) {
        if (isJunkName(raw?.name)) continue;
        const pet = normalizePet(raw);
        if (pet.id != null && !byId.has(pet.id)) byId.set(pet.id, pet);
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`Fetching ${TARGET_URL} via ${FLARESOLVERR_URL}`);
  const html = await withRetry(fetchViaFlareSolverr);

  const pets = parsePets(html);
  console.log(`Parsed ${pets.length} pets`);

  if (pets.length < MIN_PETS) {
    // Leave the existing file alone rather than overwrite good data with junk.
    throw new Error(`Only ${pets.length} pets parsed (expected ${MIN_PETS}+). The page layout may have changed.`);
  }

  const out = {
    source: TARGET_URL,
    scrapedAt: new Date().toISOString(),
    count: pets.length,
    pets,
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  const tmp = `${OUTPUT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  fs.renameSync(tmp, OUTPUT_FILE);
  console.log(`Wrote ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parsePets };
